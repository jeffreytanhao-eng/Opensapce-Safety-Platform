/**
 * 写入口径探针（P1-2）：只读检查，结论写日志并缓存，供 /cgi2/health 展示。
 *
 * 实测结论（2026-10-25，本机 docker MySQL）：
 *  1) sat_cdm.tca 与 raw_json.TCA 完全一致 → tca 列存 UTC；
 *  2) SQRT(a_x²+a_y²+a_z²) 在 6,600–26,000 km → a_*、b_*、mid_* 单位是 km，坐标系 TEME；
 *  3) sat_cov_model.bins 为 [{n,snM,srM,stM,dtMaxH}, …]，σ 单位为米。
 */
import { query } from '../db.js'
import { logger } from '../logger.js'
import { fmtUtc } from '../util/time.js'
import type { RowDataPacket } from 'mysql2/promise'

const log = logger('probe')

export interface ProbeResult {
  checkedAt: string
  /** sat_cdm.tca 的存储口径 */
  tcaConvention: 'utc' | 'local+8' | 'unknown'
  /** sat_cdm 坐标单位 */
  xyzUnit: 'km' | 'unknown'
  /** 会话时区信息（DB 默认会话，未强改） */
  nowLocal: string | null
  nowUtc: string | null
  covModel: {
    rows: number
    usable: boolean
    sample: unknown
  }
  notes: string[]
}

let cached: ProbeResult | null = null

export function getProbe(): ProbeResult | null {
  return cached
}

interface TcaRow extends RowDataPacket {
  id: number
  tca: Date | null
  raw_tca: string | null
}

interface UnitRow extends RowDataPacket {
  n: number | null
}

interface CovRow extends RowDataPacket {
  regime: string
  object_type: string
  bins: unknown
  sample_n: number
}

export async function runProbe(): Promise<ProbeResult> {
  const notes: string[] = []

  let nowLocal: string | null = null
  let nowUtc: string | null = null
  try {
    const rows = await query<RowDataPacket & { now_local: Date; now_utc: Date }>(
      'SELECT NOW() AS now_local, UTC_TIMESTAMP() AS now_utc'
    )
    nowLocal = fmtUtc(rows[0]?.now_local ?? null)
    nowUtc = fmtUtc(rows[0]?.now_utc ?? null)
  } catch (e) {
    notes.push(`读取数据库时间失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // 1) tca 口径：列值 vs raw_json 里的 TCA（后者是上游 UTC 原文）
  let tcaConvention: ProbeResult['tcaConvention'] = 'unknown'
  try {
    const rows = await query<TcaRow>(
      "SELECT id, tca, JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.TCA')) AS raw_tca FROM sat_cdm ORDER BY id DESC LIMIT 5"
    )
    let same = 0
    let plus8 = 0
    for (const r of rows) {
      if (!r.tca || !r.raw_tca) continue
      const col = r.tca.getTime() // timezone:'Z' → Date 即 UTC
      const pressing = Date.parse(r.raw_tca.replace(' ', 'T') + (r.raw_tca.includes('Z') ? '' : 'Z'))
      if (!Number.isFinite(pressing)) continue
      if (Math.abs(col - pressing) <= 2000) same++
      else if (Math.abs(col - (pressing + 8 * 3600_000)) <= 2000) plus8++
    }
    if (same > 0 && plus8 === 0) tcaConvention = 'utc'
    else if (plus8 > 0 && same === 0) tcaConvention = 'local+8'
    notes.push(`sat_cdm.tca：列值与 raw_json.TCA 一致 ${same}/${rows.length}，+8 偏移 ${plus8} 条`)
  } catch (e) {
    notes.push(`sat_cdm 时区探针失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // 2) 坐标单位
  let xyzUnit: ProbeResult['xyzUnit'] = 'unknown'
  try {
    const rows = await query<UnitRow>(
      'SELECT SQRT(a_x*a_x + a_y*a_y + a_z*a_z) AS n FROM sat_cdm WHERE a_x IS NOT NULL LIMIT 5'
    )
    const vals = rows.map((r) => Number(r.n)).filter((v) => Number.isFinite(v) && v > 0)
    if (vals.length > 0 && vals.every((v) => v > 6000 && v < 60000)) {
      xyzUnit = 'km'
    }
    notes.push(`a_* 模长样本：${vals.map((v) => v.toFixed(0)).join(', ') || '无'} → ${xyzUnit}`)
  } catch (e) {
    notes.push(`sat_cdm 单位探针失败：${e instanceof Error ? e.message : String(e)}`)
  }

  // 3) 经验协方差模型
  let covRows = 0
  let covUsable = false
  let covSample: unknown = null
  try {
    const rows = await query<CovRow>(
      "SELECT regime, object_type, bins, sample_n FROM sat_cov_model WHERE bins IS NOT NULL AND regime = 'LEO' LIMIT 2"
    )
    covRows = rows.length
    for (const r of rows) {
      const bins = Array.isArray(r.bins) ? r.bins : []
      const ok = bins.some(
        (b) =>
          b &&
          typeof b === 'object' &&
          Number.isFinite(Number((b as Record<string, unknown>).srM)) &&
          Number.isFinite(Number((b as Record<string, unknown>).stM))
      )
      if (ok) covUsable = true
    }
    covSample = rows[0] ?? null
    notes.push(`sat_cov_model（LEO）样本 ${rows.length} 行，可用=${covUsable}（σ 单位按米解释）`)
  } catch (e) {
    notes.push(`sat_cov_model 探针失败：${e instanceof Error ? e.message : String(e)}`)
  }

  const result: ProbeResult = {
    checkedAt: fmtUtc(new Date()) ?? '',
    tcaConvention,
    xyzUnit,
    nowLocal,
    nowUtc,
    covModel: { rows: covRows, usable: covUsable, sample: covSample },
    notes
  }
  cached = result

  log.info(`tca 口径=${tcaConvention}，坐标单位=${xyzUnit}，协方差模型可用=${covUsable}`)
  for (const n of notes) log.info(`- ${n}`)
  if (tcaConvention !== 'utc' && tcaConvention !== 'unknown') {
    log.warn('TCA 口径与既有实现不一致：写入前需人工确认（TODO(待确认)）')
  }

  return result
}
