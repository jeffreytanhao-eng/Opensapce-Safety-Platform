/**
 * /cgi2 路由（P1 部分）：健康检查、同步状态、手动触发同步。
 * 统一响应体 { code, msg, data }。
 */
import { Router, type Request, type Response } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { pingDb, query } from '../db.js'
import { config, syncHours } from '../config.js'
import { logger } from '../logger.js'
import { fmtUtc } from '../util/time.js'
import { getProbe } from '../sync/probe.js'
import { ALL_SOURCES, isSyncSource, runSync } from '../sync/runner.js'
import { runScreen } from '../screen/run.js'
import { runValidation } from '../validate/cdmCompare.js'
import { heat } from './heat.js'
import { ephem } from './ephem.js'
import { getCoreState } from '../core/loader.js'
import type { SyncSource } from '../sync/types.js'

const log = logger('cgi2')
export const cgi2 = Router()

// P3：热力 / 事件 / 运行记录 / CDM 对比
cgi2.use('/', heat)

function ok(res: Response, data: unknown): void {
  res.json({ code: 0, msg: 'ok', data })
}

function fail(res: Response, code: number, msg: string): void {
  res.status(code === 403 ? 403 : code === 400 ? 400 : 500).json({ code, msg, data: null })
}

/** 最近一条同步日志 */
interface LogRow extends RowDataPacket {
  id: number
  source: string
  started_at: Date | null
  finished_at: Date | null
  status: number
  total: number
  inserted: number
  updated: number
  message: string
}

interface CountRow extends RowDataPacket {
  n: number
}

interface EpochRow extends RowDataPacket {
  n: number
  max_epoch: Date | null
}

interface TcaRow extends RowDataPacket {
  n: number
  min_tca: Date | null
  max_tca: Date | null
}

interface EphRow extends RowDataPacket {
  run_id: number
  n: number
  max_start: Date | null
  max_created: Date | null
}

interface AgeRow extends RowDataPacket {
  age_h: number | null
}

/**
 * TLE / AOE 历元龄期中位数（小时）。
 * 前端「数据时效」条用它说明副星根数的新鲜度：AOE 明显滞后时提示「AOE 历元滞后」。
 * 用「排序取中间一行」而非全量拉回内存：两表都上万个量级，只回 1 行。
 */
async function medianEpochAgeHours(table: 'sat_tle' | 'sat_aoe'): Promise<number | null> {
  try {
    const c = await query<CountRow>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE is_active = 1 AND epoch IS NOT NULL`
    )
    const n = Number(c[0]?.n ?? 0)
    if (!n) return null
    const r = await query<AgeRow>(
      `SELECT TIMESTAMPDIFF(SECOND, epoch, UTC_TIMESTAMP()) / 3600 AS age_h FROM ${table}
        WHERE is_active = 1 AND epoch IS NOT NULL
        ORDER BY epoch ASC LIMIT 1 OFFSET ${Math.floor(n / 2)}`
    )
    const v = Number(r[0]?.age_h)
    return Number.isFinite(v) ? Math.round(v * 10) / 10 : null
  } catch {
    return null
  }
}

async function dataFreshness(
  source: SyncSource
): Promise<{ rows: number; detail: string; medianAgeHours?: number | null; generatedAt?: string | null }> {
  try {
    switch (source) {
      case 'gp': {
        const r = await query<EpochRow>('SELECT COUNT(*) AS n, MAX(epoch) AS max_epoch FROM sat_tle')
        return {
          rows: Number(r[0]?.n ?? 0),
          detail: `最新历元 ${fmtUtc(r[0]?.max_epoch ?? null) ?? '—'}`,
          medianAgeHours: await medianEpochAgeHours('sat_tle')
        }
      }
      case 'cdm': {
        const r = await query<TcaRow>('SELECT COUNT(*) AS n, MIN(tca) AS min_tca, MAX(tca) AS max_tca FROM sat_cdm')
        return {
          rows: Number(r[0]?.n ?? 0),
          detail: `TCA ${fmtUtc(r[0]?.min_tca ?? null) ?? '—'} ~ ${fmtUtc(r[0]?.max_tca ?? null) ?? '—'}`
        }
      }
      case 'eph': {
        const r = await query<EphRow>(
          "SELECT run_id, COUNT(*) AS n, MAX(start_utc) AS max_start, MAX(created_utc) AS max_created FROM hs_ephem WHERE scope='official' GROUP BY run_id ORDER BY run_id DESC LIMIT 1"
        )
        const row = r[0]
        return {
          rows: Number(row?.n ?? 0),
          detail: row
            ? `run ${row.run_id}，星历起始 ${fmtUtc(row.max_start)}，生成于 ${fmtUtc(row.max_created)}`
            : '无星历文件',
          generatedAt: fmtUtc(row?.max_created ?? null)
        }
      }
      case 'aoe': {
        const r = await query<EpochRow>('SELECT COUNT(*) AS n, MAX(epoch) AS max_epoch FROM sat_aoe')
        return {
          rows: Number(r[0]?.n ?? 0),
          detail: `最新历元 ${fmtUtc(r[0]?.max_epoch ?? null) ?? '—'}`,
          medianAgeHours: await medianEpochAgeHours('sat_aoe')
        }
      }
      case 'supgp': {
        const r = await query<EpochRow>('SELECT COUNT(*) AS n, MAX(epoch) AS max_epoch FROM hs_supgp')
        return { rows: Number(r[0]?.n ?? 0), detail: `最新历元 ${fmtUtc(r[0]?.max_epoch ?? null) ?? '—'}` }
      }
    }
  } catch (e) {
    return { rows: 0, detail: `统计失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

cgi2.get('/health', async (_req: Request, res: Response) => {
  const dbUp = await pingDb()
  const core = getCoreState()
  const data = {
    status: 'up',
    db: dbUp ? 'up' : 'down',
    core: core.status,
    core_name: core.name,
    core_version: core.version,
    core_reason: core.reason ?? null,
    time: fmtUtc(new Date()),
    uptime_s: Math.round(process.uptime()),
    probe: getProbe()
  }
  if (!dbUp) {
    res.status(503).json({ code: 503, msg: '数据库不可用', data })
    return
  }
  ok(res, data)
})

/** 分级档位与标签就绪状态（03 §5）：前端图例与空状态都用它 */
cgi2.get('/meta', (_req: Request, res: Response) => {
  const st = getCoreState()
  let levels
  try {
    levels = st.core.levels()
  } catch {
    levels = null
  }
  const ready = st.status === 'ready'
  const reason = ready ? null : (st.reason ?? 'CORE_NOT_LOADED')
  ok(res, {
    levels: levels?.bands ?? [],
    miss_max_km: levels?.missMaxKm ?? config.MISS_MAX_KM,
    hbr_m: config.HBR_M,
    core: { status: st.status, name: st.name, version: st.version, reason },
    tabs: {
      'tle-threat': { ready, reason },
      tle: { ready, reason },
      aoe: { ready, reason }
    }
  })
})

cgi2.get('/sync/status', async (_req: Request, res: Response) => {
  const list: unknown[] = []
  const now = Date.now()
  for (const source of ALL_SOURCES) {
    const rows = await query<LogRow>('SELECT * FROM hs_sync_log WHERE source = ? ORDER BY id DESC LIMIT 1', [source])
    const last = rows[0] ?? null
    const fresh = await dataFreshness(source)
    const interval = syncHours[source]
    let state: 'ok' | 'stale' | 'error' | 'skipped' = 'stale'
    if (last) {
      if (last.status === 2) state = 'error'
      else if (last.status === 3) state = 'skipped'
      else if (last.status === 0) state = 'stale'
      else {
        const age = last.finished_at ? now - last.finished_at.getTime() : Number.POSITIVE_INFINITY
        state = age <= interval * 1.5 * 3_600_000 ? 'ok' : 'stale'
      }
    }
    let message = last?.message ?? '尚未同步'
    if (last && last.status === 0) message = '同步进行中'
    list.push({
      source,
      state,
      last_success_at: state === 'ok' ? fmtUtc(last?.finished_at ?? null) : null,
      last_attempt_at: fmtUtc(last?.started_at ?? null),
      last_finished_at: fmtUtc(last?.finished_at ?? null),
      last_status: last?.status ?? null,
      message,
      rows: fresh.rows,
      detail: fresh.detail,
      median_age_hours: fresh.medianAgeHours ?? null,
      generated_at: fresh.generatedAt ?? null,
      interval_hours: interval
    })
  }
  ok(res, { list, generated_at: fmtUtc(new Date()), probe: getProbe() })
})

/** 星座「首发 / 最近发射」：取 sat_tle.launch_date（Space-Track gp.LAUNCH_DATE 原值）。
 *  供 /situation 星座卡片动态展示，替代写死在代码里的日期；无关联载荷或无发射日期的星座不返回。
 *  注意不能用国际编号里的序号换算日期：那是「年内第几次发射」，不是年内第几天。 */
interface ConsLaunchRow extends RowDataPacket {
  code: string
  name: string
  name_en: string
  first_launch: string
  last_launch: string
  n: number
}

cgi2.get('/cons/launch', async (_req: Request, res: Response) => {
  const list = await query<ConsLaunchRow>(
    `SELECT c.code, c.name, c.name_en,
            DATE_FORMAT(MIN(t.launch_date),'%Y-%m-%d') AS first_launch,
            DATE_FORMAT(MAX(t.launch_date),'%Y-%m-%d') AS last_launch,
            COUNT(*) AS n
       FROM sat_constellation c
       JOIN sat_constellation_sat s ON s.constellation_id = c.id
       JOIN sat_tle t ON t.norad_id = s.norad_id
      WHERE t.object_type = 'PAYLOAD' AND t.launch_date IS NOT NULL
      GROUP BY c.id, c.code, c.name, c.name_en
      ORDER BY MAX(t.launch_date) DESC`
  )
  ok(res, { list, generated_at: fmtUtc(new Date()) })
})

function checkAdmin(req: Request, res: Response): boolean {
  if (!config.SIDECAR_ADMIN_TOKEN) {
    fail(res, 403, '未配置 SIDECAR_ADMIN_TOKEN，管理接口已禁用')
    return false
  }
  const token = String(req.header('X-Admin-Token') ?? '')
  if (token !== config.SIDECAR_ADMIN_TOKEN) {
    fail(res, 403, 'X-Admin-Token 无效')
    return false
  }
  return true
}

cgi2.post('/admin/sync/:source', async (req: Request, res: Response) => {
  if (!checkAdmin(req, res)) return
  const source = String(req.params.source ?? '')
  if (!isSyncSource(source)) {
    fail(res, 400, `未知同步源：${source}`)
    return
  }
  log.info(`手动触发同步：${source}`)
  const outcome = await runSync(source, 'manual')
  ok(res, outcome)
})

cgi2.post('/admin/screen/:kind', async (req: Request, res: Response) => {
  if (!checkAdmin(req, res)) return
  const kind = String(req.params.kind ?? '')
  if (kind !== 'tle' && kind !== 'tle-threat' && kind !== 'aoe') {
    fail(res, 400, `未知筛查类型：${kind}`)
    return
  }
  // 筛查可能跑几分钟：立刻返回 run_id，结果用 /screen/status 查询
  void runScreen(kind as 'tle' | 'tle-threat' | 'aoe', 'manual').catch((e) =>
    log.error(`手动筛查失败：${e instanceof Error ? e.message : String(e)}`)
  )
  ok(res, { kind, state: 'running', message: '筛查已开始，进度见 /cgi2/screen/status' })
})

cgi2.post('/admin/validate/:kind', async (req: Request, res: Response) => {
  if (!checkAdmin(req, res)) return
  const kind = String(req.params.kind ?? '')
  if (kind !== 'tle' && kind !== 'aoe') {
    fail(res, 400, `未知验证类型：${kind}`)
    return
  }
  try {
    const result = await runValidation(kind, 'manual')
    ok(res, result)
  } catch (e) {
    fail(res, 500, e instanceof Error ? e.message : String(e))
  }
})

cgi2.get('/screen/status', async (_req: Request, res: Response) => {
  const rows = await query<RowDataPacket & Record<string, unknown>>(
    'SELECT id, kind, eph_run_id, started_at, finished_at, status, n_primary, n_secondary, n_candidates, n_events, message ' +
      'FROM hs_screen_run ORDER BY id DESC LIMIT 10'
  )
  ok(
    res,
    rows.map((r) => ({
      run_id: r.id,
      kind: r.kind,
      eph_run_id: r.eph_run_id,
      state: r.status === 0 ? 'running' : r.status === 1 ? 'ok' : 'error',
      started_at: fmtUtc((r.started_at as Date) ?? null),
      finished_at: fmtUtc((r.finished_at as Date) ?? null),
      n_primary: r.n_primary,
      n_secondary: r.n_secondary,
      n_candidates: r.n_candidates,
      n_events: r.n_events,
      message: r.message
    }))
  )
})

// P6 / §15：星历上传与按需筛查（放在 /screen/status 之后注册，避免 /screen/:jobId 抢占）
cgi2.use('/', ephem)
