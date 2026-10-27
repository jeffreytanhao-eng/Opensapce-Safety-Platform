/**
 * P5：星历热力与官方 CDM 的对比验证
 *
 * 用同一轮筛查（hs_screen_run → hs_event）对比同期官方 CDM：
 *  - 匹配：NORAD 无序对相同且 |ΔTCA| ≤ TOL_S（默认 120 s，可配置）；
 *  - 只统计「一方为本轮筛查主星（即有精密星历的 Starlink）」的 CDM；
 *  - 官方 CDM 优先读 hs_cdm_history（sidecar 自己同步的 CDM），为空时回落 jsc 的 sat_cdm
 *    （其上同样有官方报文口径的 Pc / MIN_RNG，用来在没有 Space-Track 凭据时也能做首轮核对）。
 *
 * 指标：召回率（官方 Pc ≥ 1e-5 中被找到的比例）、|Δmiss| 中位数/P90、
 * Pc 量级一致率（|log10(Pc/Pc_cdm)| ≤ 1）、我方红/橙但无对应 CDM 的事件数（参考值）。
 *
 * 结果写 hs_validate，并返回同一份对象供 /cgi2/validate/latest 展示。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { execute, query } from '../db.js'
import { logger } from '../logger.js'
import { fmtUtc } from '../util/time.js'

const log = logger('validate')
const TOL_S = 120
const OFFICIAL_HIGH_PC = 1e-5

export type ValidateKind = 'tle' | 'aoe'

interface OurEventRow extends RowDataPacket {
  id: number
  primary_norad: number | null
  secondary_norad: number | null
  primary_name: string | null
  secondary_name: string | null
  tca: Date
  miss_km: number | null
  pc: number | null
  pc_max: number | null
  level: string | null
}

interface CdmRow extends RowDataPacket {
  cdm_id: string | null
  norad_a: number | null
  norad_b: number | null
  tca: Date
  miss_km: number | null
  pc: number | null
}

export interface ValidateResult {
  ok: boolean
  kind: ValidateKind
  run_id: number | null
  cdm_source: string | null
  n_cdm: number
  n_official_high: number
  n_matched: number
  n_recall_hit: number
  recall: number | null
  dm_miss_median_km: number | null
  dm_miss_p90_km: number | null
  pc_order_rate: number | null
  false_alarm: number
  note: string
  compared_at: string | null
  /** 明细（最多 50 条），便于人工抽查 */
  matched: {
    cdm_id: string | null
    norad_a: number | null
    norad_b: number | null
    tca: string
    dtca_s: number
    our_miss_km: number | null
    cdm_miss_km: number | null
    dm_miss_km: number | null
    our_pc: number | null
    cdm_pc: number | null
    pc_ratio_log10: number | null
  }[]
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function p90(xs: number[]): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const i = Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)
  return a[Math.max(0, i)]
}

async function latestOkRun(kind: ValidateKind): Promise<{ id: number; eph_run_id: number | null } | null> {
  const rows = await query<RowDataPacket & { id: number; eph_run_id: number | null }>(
    'SELECT id, eph_run_id FROM hs_screen_run WHERE kind=? AND status=1 ORDER BY id DESC LIMIT 1',
    [kind]
  )
  return rows[0] ? { id: Number(rows[0].id), eph_run_id: rows[0].eph_run_id ?? null } : null
}

/** 官方 CDM：优先 sidecar 自己同步的 hs_cdm_history，为空回落 jsc 的 sat_cdm */
async function loadOfficialCdm(): Promise<{ source: string; rows: CdmRow[] }> {
  const hist = await query<CdmRow>(
    'SELECT cdm_id, norad_a, norad_b, tca, min_rng_km AS miss_km, pc FROM hs_cdm_history'
  )
  if (hist.length) return { source: 'hs_cdm_history', rows: hist }
  // sat_cdm 的 miss_distance_km / collision_probability 已是 km、无量纲概率，与 hs_cdm_history 同口径
  const fallback = await query<CdmRow>(
    'SELECT cdm_id, norad_a, norad_b, tca, miss_distance_km AS miss_km, collision_probability AS pc ' +
      'FROM sat_cdm WHERE tca IS NOT NULL'
  )
  return { source: 'sat_cdm', rows: fallback }
}

/** 统一成 km 数值（两张表都已是 km，这里只做类型收敛与空值过滤） */
function toKm(v: number | null): number | null {
  if (v == null || !Number.isFinite(Number(v))) return null
  return Number(v)
}

export async function runValidation(kind: ValidateKind, trigger = 'manual'): Promise<ValidateResult> {
  const run = await latestOkRun(kind)
  if (!run) {
    return {
      ok: false,
      kind,
      run_id: null,
      cdm_source: null,
      n_cdm: 0,
      n_official_high: 0,
      n_matched: 0,
      n_recall_hit: 0,
      recall: null,
      dm_miss_median_km: null,
      dm_miss_p90_km: null,
      pc_order_rate: null,
      false_alarm: 0,
      note: `没有成功的 ${kind} 筛查轮次，无法验证`,
      compared_at: null,
      matched: []
    }
  }

  const ours = await query<OurEventRow>(
    'SELECT id, primary_norad, secondary_norad, primary_name, secondary_name, tca, miss_km, pc, pc_max, level ' +
      'FROM hs_event WHERE run_id=?',
    [run.id]
  )
  const { source, rows: cdms } = await loadOfficialCdm()

  // 本轮主星集合（一方有精密星历）；自过滤已在筛查阶段完成
  const primaries = new Set<number>()
  for (const e of ours) if (e.primary_norad != null) primaries.add(Number(e.primary_norad))

  // 只保留「一方为本轮主星」的 CDM
  const targetCdms = cdms.filter(
    (c) =>
      c.norad_a != null &&
      c.norad_b != null &&
      (primaries.has(Number(c.norad_a)) || primaries.has(Number(c.norad_b)))
  )

  // NORAD 无序对 + TCA 分钟级分桶，避免 O(n·m)
  const bucket = new Map<string, OurEventRow[]>()
  for (const e of ours) {
    if (e.primary_norad == null || e.secondary_norad == null) continue
    const a = Math.min(Number(e.primary_norad), Number(e.secondary_norad))
    const b = Math.max(Number(e.primary_norad), Number(e.secondary_norad))
    const key = `${a}:${b}`
    const arr = bucket.get(key) ?? []
    arr.push(e)
    bucket.set(key, arr)
  }

  const matched: ValidateResult['matched'] = []
  let nOfficialHigh = 0
  let nMatched = 0
  let nRecallHit = 0
  const dmMiss: number[] = []
  let pcOrderGood = 0
  let pcOrderTotal = 0
  const matchedEventIds = new Set<number>()

  for (const c of targetCdms) {
    const pcCdm = c.pc == null ? null : Number(c.pc)
    const officialHigh = pcCdm != null && pcCdm >= OFFICIAL_HIGH_PC
    if (officialHigh) nOfficialHigh++

    const a = Math.min(Number(c.norad_a), Number(c.norad_b))
    const b = Math.max(Number(c.norad_a), Number(c.norad_b))
    const cands = bucket.get(`${a}:${b}`)
    if (!cands?.length) continue

    const tcaMs = c.tca.getTime()
    let best: OurEventRow | null = null
    let bestDt = Number.POSITIVE_INFINITY
    for (const e of cands) {
      const dt = Math.abs(e.tca.getTime() - tcaMs) / 1000
      if (dt <= TOL_S && dt < bestDt) {
        best = e
        bestDt = dt
      }
    }
    if (!best) continue

    nMatched++
    matchedEventIds.add(Number(best.id))
    if (officialHigh) nRecallHit++

    const ourMiss = best.miss_km == null ? null : Number(best.miss_km)
    const cdmMiss = toKm(c.miss_km)
    if (ourMiss != null && cdmMiss != null) dmMiss.push(Math.abs(ourMiss - cdmMiss))

    const ourPc = best.pc == null ? null : Number(best.pc)
    let ratioLog10: number | null = null
    if (ourPc != null && ourPc > 0 && pcCdm != null && pcCdm > 0) {
      ratioLog10 = Math.log10(ourPc / pcCdm)
      pcOrderTotal++
      if (Math.abs(ratioLog10) <= 1) pcOrderGood++
    }

    if (matched.length < 50) {
      matched.push({
        cdm_id: c.cdm_id ?? null,
        norad_a: c.norad_a == null ? null : Number(c.norad_a),
        norad_b: c.norad_b == null ? null : Number(c.norad_b),
        tca: fmtUtc(c.tca) ?? '',
        dtca_s: Math.round((best.tca.getTime() - tcaMs) / 1000),
        our_miss_km: ourMiss,
        cdm_miss_km: cdmMiss,
        dm_miss_km: ourMiss != null && cdmMiss != null ? Math.abs(ourMiss - cdmMiss) : null,
        our_pc: ourPc,
        cdm_pc: pcCdm,
        pc_ratio_log10: ratioLog10
      })
    }
  }

  // 我方红/橙但没有任何对应 CDM（公开 CDM 未必全覆盖，仅作参考）
  let falseAlarm = 0
  for (const e of ours) {
    if (e.level !== 'danger' && e.level !== 'warning') continue
    if (!matchedEventIds.has(Number(e.id))) falseAlarm++
  }

  const recall = nOfficialHigh > 0 ? nRecallHit / nOfficialHigh : null
  const dmMedian = median(dmMiss)
  const dmP90 = p90(dmMiss)
  const pcOrderRate = pcOrderTotal > 0 ? pcOrderGood / pcOrderTotal : null

  const note =
    `trigger=${trigger} 我方事件 ${ours.length}，${source} ${targetCdms.length} 条（一方为本轮主星），` +
    `官方 Pc≥${OFFICIAL_HIGH_PC} ${nOfficialHigh} 条，匹配 ${nMatched} 条`

  await execute(
    'INSERT INTO hs_validate (kind, run_id, compared_at, cdm_source, n_cdm, n_official_high, n_matched, n_recall_hit, ' +
      'recall, dm_miss_median_km, dm_miss_p90_km, pc_order_rate, false_alarm, detail_json, note) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      kind,
      run.id,
      new Date(),
      source,
      targetCdms.length,
      nOfficialHigh,
      nMatched,
      nRecallHit,
      recall,
      dmMedian,
      dmP90,
      pcOrderRate,
      falseAlarm,
      JSON.stringify(matched),
      note.slice(0, 1000)
    ]
  )

  log.info(`验证完成 kind=${kind} run=${run.id} ${note}`)

  return {
    ok: true,
    kind,
    run_id: run.id,
    cdm_source: source,
    n_cdm: targetCdms.length,
    n_official_high: nOfficialHigh,
    n_matched: nMatched,
    n_recall_hit: nRecallHit,
    recall,
    dm_miss_median_km: dmMedian,
    dm_miss_p90_km: dmP90,
    pc_order_rate: pcOrderRate,
    false_alarm: falseAlarm,
    note,
    compared_at: fmtUtc(new Date()),
    matched
  }
}

interface ValidateRow extends RowDataPacket {
  id: number
  kind: string
  run_id: number | null
  compared_at: Date | null
  cdm_source: string | null
  n_cdm: number | null
  n_official_high: number | null
  n_matched: number | null
  n_recall_hit: number | null
  recall: number | null
  dm_miss_median_km: number | null
  dm_miss_p90_km: number | null
  pc_order_rate: number | null
  false_alarm: number | null
  detail_json: unknown
  note: string | null
}

/** 最近一次验证结果（前端 /validate/latest 用） */
export async function latestValidation(kind?: ValidateKind): Promise<Record<string, unknown>[]> {
  const params: unknown[] = []
  let sql =
    'SELECT * FROM hs_validate' + (kind ? ' WHERE kind=?' : '') + ' ORDER BY id DESC LIMIT 10'
  if (kind) params.push(kind)
  const rows = await query<ValidateRow>(sql, params)
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    run_id: r.run_id,
    compared_at: fmtUtc(r.compared_at),
    cdm_source: r.cdm_source,
    n_cdm: r.n_cdm,
    n_official_high: r.n_official_high,
    n_matched: r.n_matched,
    n_recall_hit: r.n_recall_hit,
    recall: r.recall,
    dm_miss_median_km: r.dm_miss_median_km,
    dm_miss_p90_km: r.dm_miss_p90_km,
    pc_order_rate: r.pc_order_rate,
    false_alarm: r.false_alarm,
    note: r.note,
    matched: (() => {
      try {
        return typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : r.detail_json
      } catch {
        return []
      }
    })()
  }))
}
