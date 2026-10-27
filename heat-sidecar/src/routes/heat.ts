/**
 * /cgi2 热力与事件接口（P3）
 *
 * 响应体与 `/cgi/sat_cdm/heatmap` 同构，前端直接复用 CdmHeatEvent 渲染：
 *  - 分级只按 Pc 门限（与 heat/riskLevels.ts 一致）；
 *  - risk = log10(Pc) 在 [-7,-3] 上线性映射到 0~1；
 *  - dens_boost = 1 + log2(1 + 同 5°×5° 网格事件数)；
 *  - a_* / b_* / mid_* 为 TEME km（渲染口径）。
 */
import { Router, type Request, type Response } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { query } from '../db.js'
import { logger } from '../logger.js'
import { fmtUtc } from '../util/time.js'
import { latestValidation } from '../validate/cdmCompare.js'
import { getCoreState } from '../core/loader.js'

const log = logger('cgi2.heat')
export const heat = Router()

const COLORS = {
  danger: '#e8453c',
  warning: '#f08a3c',
  info: '#f2c14e',
  insufficient: '#93a4bd'
} as const
type Level = keyof typeof COLORS

function ok(res: Response, data: unknown): void {
  res.json({ code: 0, msg: 'ok', data })
}

function fail(res: Response, code: number, msg: string): void {
  res.status(code).json({ code, msg, data: null })
}

function levelOf(pc: number, pcMax: number): Level | null {
  if (pc >= 1e-4) return 'danger'
  if (pc >= 1e-5) return 'warning'
  if (pc >= 1e-7) return 'info'
  if (pcMax >= 1e-4) return 'insufficient'
  return null
}

function riskOfPc(pc: number): number {
  const p = Number.isFinite(pc) ? Math.max(pc, 1e-30) : 1e-30
  return Math.min(1, Math.max(0, (Math.log10(p) + 7) / 4))
}

/** GMST（rad），用于 mid_* → 经纬（仅用于密度分箱） */
function gmstRad(ms: number): number {
  const jd = ms / 86400000 + 2440587.5
  const t = (jd - 2451545.0) / 36525
  const deg =
    280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - (t * t * t) / 38710000
  return (((deg % 360) + 360) % 360) * (Math.PI / 180)
}

/** TEME → 经纬（度），只用于 5°×5° 密度网格 */
function temeToLatLon(x: number, y: number, z: number, ms: number): { lat: number; lon: number } {
  const th = gmstRad(ms)
  const c = Math.cos(th)
  const s = Math.sin(th)
  const ex = c * x + s * y
  const ey = -s * x + c * y
  const r = Math.hypot(ex, ey, z) || 1
  return { lat: (Math.asin(z / r) * 180) / Math.PI, lon: (Math.atan2(ey, ex) * 180) / Math.PI }
}

interface EventRow extends RowDataPacket {
  id: number
  run_id: number
  kind: string
  primary_norad: number | null
  primary_meme: number | null
  primary_name: string | null
  secondary_norad: number | null
  secondary_name: string | null
  secondary_src: string | null
  tca: Date
  miss_km: number | null
  miss_r_km: number | null
  miss_t_km: number | null
  miss_n_km: number | null
  rel_speed_kms: number | null
  pc: number | null
  pc_max: number | null
  hbr_m: number | null
  level: string | null
  diluted: number | null
  a_x: number | null; a_y: number | null; a_z: number | null
  b_x: number | null; b_y: number | null; b_z: number | null
  mid_x: number | null; mid_y: number | null; mid_z: number | null
  sec_epoch: Date | null
  sec_age_h: number | null
  eph_created: Date | null
  eph_age_h: number | null
  sigma_p_src: string | null
  sigma_p_t_km: number | null
  sigma_s_src: string | null
  sigma_s_t_km: number | null
  cdm_id: string | null
  cdm_pc: number | null
  cdm_miss_km: number | null
  cdm_dtca_s: number | null
}

interface RunRow extends RowDataPacket {
  id: number
  kind: string
  started_at: Date | null
  finished_at: Date | null
  status: number
  n_primary: number | null
  n_secondary: number | null
  n_candidates: number | null
  n_events: number | null
  message: string | null
}

async function latestRun(kind: string, scope: 'official' | 'uploaded' = 'official', ephemId: string | null = null): Promise<RunRow | null> {
  if (scope === 'uploaded') {
    const rows = await query<RunRow>(
      'SELECT id, kind, started_at, finished_at, status, n_primary, n_secondary, n_candidates, n_events, message ' +
        "FROM hs_screen_run WHERE kind=? AND scope='uploaded' AND ephem_id=? AND status=1 ORDER BY id DESC LIMIT 1",
      [kind, ephemId]
    )
    return rows[0] ?? null
  }
  const rows = await query<RunRow>(
    'SELECT id, kind, started_at, finished_at, status, n_primary, n_secondary, n_candidates, n_events, message ' +
      "FROM hs_screen_run WHERE kind=? AND scope='official' AND status=1 ORDER BY id DESC LIMIT 1",
    [kind]
  )
  return rows[0] ?? null
}

/** 解析 primary 参数：official（默认）或 ephem:<uuid>（03 §15.7） */
function parsePrimary(raw: unknown): { scope: 'official' | 'uploaded'; ephemId: string | null } | { error: string } {
  const s = String(raw ?? '').trim()
  if (!s || s === 'official') return { scope: 'official', ephemId: null }
  const m = /^ephem:([0-9a-fA-F-]{36})$/.exec(s)
  if (!m) return { error: `primary 必须是 official 或 ephem:<id>（收到 ${s}）` }
  return { scope: 'uploaded', ephemId: m[1] }
}

/** 当天（UTC+8）零点对应的 UTC 毫秒 */
function dayStartUtcMs(ms: number): number {
  const shifted = ms + 8 * 3600_000
  return Math.floor(shifted / 86400_000) * 86400_000 - 8 * 3600_000
}

heat.get('/heat/heatmap', async (req: Request, res: Response) => {
  const kind = String(req.query.kind ?? '')
  if (kind !== 'tle' && kind !== 'tle-threat' && kind !== 'aoe') {
    fail(res, 400, `kind 必须是 tle / tle-threat / aoe（收到 ${kind || '空'}）`)
    return
  }
  const days = Number(req.query.days ?? 7)
  if (![1, 3, 7].includes(days)) {
    fail(res, 400, `days 只接受 1 / 3 / 7（收到 ${req.query.days}）`)
    return
  }
  const primary = parsePrimary(req.query.primary)
  if ('error' in primary) {
    fail(res, 400, primary.error)
    return
  }
  const core = getCoreState()
  if (core.status !== 'ready') {
    ok(res, {
      list: [], total: 0, days, run_id: null, day_groups: [], generated_at: null,
      ready: false, reason: core.reason ?? 'CORE_NOT_LOADED',
      primary_scope: primary.scope, ephem_id: primary.ephemId
    })
    return
  }
  const norad = Number(req.query.norad ?? 0)
  const run = await latestRun(kind, primary.scope, primary.ephemId)
  if (!run) {
    ok(res, {
      list: [], total: 0, days, run_id: null, day_groups: [], generated_at: null,
      ready: true, has_run: false, primary_scope: primary.scope, ephem_id: primary.ephemId
    })
    return
  }
  const params: unknown[] = [run.id]
  let sql =
    'SELECT * FROM hs_event WHERE run_id = ? AND tca >= NOW()'
  if (Number.isFinite(days) && days > 0) {
    sql += ' AND tca <= DATE_ADD(NOW(), INTERVAL ? DAY)'
    params.push(days)
  }
  if (Number.isFinite(norad) && norad > 0) {
    sql += ' AND (primary_norad = ? OR secondary_norad = ?)'
    params.push(norad, norad)
  }
  sql += ' ORDER BY tca ASC'
  const rows = await query<EventRow>(sql, params)

  const todayMs = dayStartUtcMs(Date.now())
  const cells = new Map<string, number>()
  const prepared = rows.map((r) => {
    const tcaMs = r.tca.getTime()
    const mid = [Number(r.mid_x), Number(r.mid_y), Number(r.mid_z)]
    const { lat, lon } = temeToLatLon(mid[0], mid[1], mid[2], tcaMs)
    const cellKey = `${Math.floor(lat / 5)}:${Math.floor(lon / 5)}`
    cells.set(cellKey, (cells.get(cellKey) ?? 0) + 1)
    const pc = Number(r.pc ?? 0)
    const pcMax = Number(r.pc_max ?? 0)
    const level = (r.level as Level | null) ?? levelOf(pc, pcMax)
    const day = Math.max(1, Math.floor((dayStartUtcMs(tcaMs) - todayMs) / 86400_000) + 1)
    return { r, pc, pcMax, level, day, cellKey }
  })

  const list = prepared.map(({ r, pc, pcMax, level, day, cellKey }) => ({
    id: r.id,
    cdm_id: r.cdm_id ?? `HS-${r.run_id}-${r.id}`,
    tca: fmtUtc(r.tca),
    norad_a: r.primary_norad ?? 0,
    name_a: r.primary_name ?? '',
    norad_b: r.secondary_norad ?? 0,
    name_b: r.secondary_name ?? '',
    miss_distance_km: Number(r.miss_km ?? 0),
    rel_speed_km_per_s: Number(r.rel_speed_kms ?? 0),
    collision_probability: pc,
    hard_body_radius_m: Number(r.hbr_m ?? 10),
    a_x: Number(r.a_x ?? 0), a_y: Number(r.a_y ?? 0), a_z: Number(r.a_z ?? 0),
    b_x: Number(r.b_x ?? 0), b_y: Number(r.b_y ?? 0), b_z: Number(r.b_z ?? 0),
    mid_x: Number(r.mid_x ?? 0), mid_y: Number(r.mid_y ?? 0), mid_z: Number(r.mid_z ?? 0),
    color: COLORS[level ?? 'info'],
    risk: riskOfPc(pc),
    dens_boost: 1 + Math.log2(1 + (cells.get(cellKey) ?? 1)),
    metric_text: `Pc ${pc.toExponential(2)}`,
    day,
    pc_max: pcMax,
    level: level ?? undefined
  }))

  const dayGroups =
    days > 0
      ? Array.from({ length: Math.ceil(days) }, (_, i) => ({
          day: i + 1,
          date: new Date(todayMs + i * 86400_000).toISOString().slice(0, 10),
          count: list.filter((e) => e.day === i + 1).length
        }))
      : []

  ok(res, {
    list,
    total: list.length,
    days,
    run_id: run.id,
    day_groups: dayGroups,
    metric_label: '碰撞概率 Pc',
    metric: 'pc',
    generated_at: fmtUtc(run.finished_at),
    ready: true,
    has_run: true,
    primary_scope: primary.scope,
    ephem_id: primary.ephemId
  })
})

heat.get('/heat/list', async (req: Request, res: Response) => {
  const kind = String(req.query.kind ?? '')
  if (kind !== 'tle' && kind !== 'tle-threat' && kind !== 'aoe') {
    fail(res, 400, `kind 必须是 tle / tle-threat / aoe（收到 ${kind || '空'}）`)
    return
  }
  const primary = parsePrimary(req.query.primary)
  if ('error' in primary) {
    fail(res, 400, primary.error)
    return
  }
  const run = await latestRun(kind, primary.scope, primary.ephemId)
  if (!run) {
    ok(res, {
      list: [], total: 0, run_id: null, generated_at: null,
      ready: true, has_run: false, primary_scope: primary.scope, ephem_id: primary.ephemId
    })
    return
  }
  const params: unknown[] = [run.id]
  let sql = 'SELECT * FROM hs_event WHERE run_id = ?'
  const keyword = String(req.query.keyword ?? '').trim()
  if (keyword) {
    sql += ' AND (primary_name LIKE ? OR secondary_name LIKE ? OR primary_norad = ? OR secondary_norad = ?)'
    const like = `%${keyword}%`
    const n = Number(keyword)
    params.push(like, like, Number.isFinite(n) ? n : -1, Number.isFinite(n) ? n : -1)
  }
  const dateFrom = String(req.query.dateFrom ?? '').trim()
  if (dateFrom) {
    sql += ' AND tca >= ?'
    params.push(dateFrom)
  }
  const dateTo = String(req.query.dateTo ?? '').trim()
  if (dateTo) {
    sql += ' AND tca <= ?'
    params.push(dateTo)
  }
  const level = String(req.query.level ?? '').trim()
  if (level) {
    sql += ' AND level = ?'
    params.push(level)
  }
  sql += ' ORDER BY pc DESC'
  const rows = await query<EventRow>(sql, params)
  ok(res, {
    list: rows.map((r) => ({
      id: r.id,
      tca: fmtUtc(r.tca),
      norad_a: r.primary_norad ?? 0,
      name_a: r.primary_name ?? '',
      norad_b: r.secondary_norad ?? 0,
      name_b: r.secondary_name ?? '',
      miss_distance_km: Number(r.miss_km ?? 0),
      rel_speed_km_per_s: Number(r.rel_speed_kms ?? 0),
      collision_probability: Number(r.pc ?? 0),
      pc_max: Number(r.pc_max ?? 0),
      level: r.level
    })),
    total: rows.length,
    run_id: run.id,
    generated_at: fmtUtc(run.finished_at),
    ready: true,
    has_run: true,
    primary_scope: primary.scope,
    ephem_id: primary.ephemId
  })
})

heat.get('/heat/event/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) {
    fail(res, 400, 'id 非法')
    return
  }
  const rows = await query<EventRow>('SELECT * FROM hs_event WHERE id=? LIMIT 1', [id])
  const r = rows[0]
  if (!r) {
    fail(res, 404, '事件不存在')
    return
  }
  ok(res, {
    id: r.id,
    run_id: r.run_id,
    kind: r.kind,
    tca: fmtUtc(r.tca),
    primary: {
      norad: r.primary_norad,
      meme_id: r.primary_meme,
      name: r.primary_name,
      eph_created: fmtUtc(r.eph_created),
      eph_age_h: r.eph_age_h,
      sigma_t_km: r.sigma_p_t_km
    },
    secondary: {
      norad: r.secondary_norad,
      name: r.secondary_name,
      src: r.secondary_src,
      epoch: fmtUtc(r.sec_epoch),
      age_h: r.sec_age_h,
      sigma_t_km: r.sigma_s_t_km
    },
    miss: {
      total_km: r.miss_km,
      r_km: r.miss_r_km,
      t_km: r.miss_t_km,
      n_km: r.miss_n_km,
      rel_speed_kms: r.rel_speed_kms
    },
    pc: {
      value: r.pc,
      max: r.pc_max,
      method: 'foster2d',
      hbr_m: r.hbr_m,
      level: r.level,
      diluted: Boolean(r.diluted),
      sigma_p_src: r.sigma_p_src,
      sigma_s_src: r.sigma_s_src
    },
    cdm: r.cdm_id
      ? { cdm_id: r.cdm_id, pc: r.cdm_pc, miss_km: r.cdm_miss_km, dtca_s: r.cdm_dtca_s }
      : null,
    frames: { compute: 'J2000', render: 'TEME' }
  })
})

heat.get('/heat/runs', async (req: Request, res: Response) => {
  const kind = String(req.query.kind ?? '')
  const params: unknown[] = []
  let sql =
    'SELECT id, kind, started_at, finished_at, status, n_primary, n_secondary, n_candidates, n_events, message FROM hs_screen_run'
  if (kind === 'tle' || kind === 'tle-threat' || kind === 'aoe') {
    sql += ' WHERE kind=?'
    params.push(kind)
  }
  sql += ' ORDER BY id DESC LIMIT 20'
  const rows = await query<RunRow>(sql, params)
  ok(
    res,
    rows.map((r) => ({
      run_id: r.id,
      kind: r.kind,
      state: r.status === 0 ? 'running' : r.status === 1 ? 'ok' : 'error',
      started_at: fmtUtc(r.started_at),
      finished_at: fmtUtc(r.finished_at),
      n_primary: r.n_primary,
      n_secondary: r.n_secondary,
      n_candidates: r.n_candidates,
      n_events: r.n_events,
      message: r.message
    }))
  )
})

/** 事件匹配到的官方 CDM（NORAD 无序对 + |ΔTCA| ≤ tol_s） */
heat.get('/cdm/detail', async (req: Request, res: Response) => {
  const a = Number(req.query.norad_a)
  const b = Number(req.query.norad_b)
  const tca = String(req.query.tca ?? '').trim()
  const tol = Number(req.query.tol_s ?? 120)
  if (!Number.isFinite(a) || !Number.isFinite(b) || !tca) {
    fail(res, 400, '需要 norad_a、norad_b、tca')
    return
  }
  const t = new Date(tca.replace(' ', 'T') + (tca.includes('Z') || tca.includes('+') ? '' : 'Z'))
  if (!Number.isFinite(t.getTime())) {
    fail(res, 400, 'tca 无法解析')
    return
  }
  const rows = await query<RowDataPacket & Record<string, unknown>>(
    'SELECT cdm_id, tca, norad_a, norad_b, min_rng_km, pc, created FROM hs_cdm_history ' +
      'WHERE ((norad_a=? AND norad_b=?) OR (norad_a=? AND norad_b=?)) ' +
      'AND ABS(TIMESTAMPDIFF(SECOND, tca, ?)) <= ? ORDER BY ABS(TIMESTAMPDIFF(SECOND, tca, ?)) ASC LIMIT 5',
    [a, b, b, a, t, tol, t]
  )
  ok(
    res,
    rows.map((r) => ({
      cdm_id: r.cdm_id,
      tca: fmtUtc(r.tca as Date),
      norad_a: r.norad_a,
      norad_b: r.norad_b,
      miss_km: r.min_rng_km,
      pc: r.pc,
      created: fmtUtc(r.created as Date),
      dtca_s: Math.round(((r.tca as Date).getTime() - t.getTime()) / 1000)
    }))
  )
})

/** P5 验证结果：最近 10 轮（可按 kind 过滤），无数据时返回空数组 */
heat.get('/validate/latest', async (req: Request, res: Response) => {
  const kindRaw = String(req.query.kind ?? '').trim()
  const kind = kindRaw === 'tle' || kindRaw === 'aoe' ? kindRaw : undefined
  ok(res, await latestValidation(kind))
})

log.debug('热力路由已注册')
