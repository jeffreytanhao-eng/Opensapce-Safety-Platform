/**
 * Space-Track 公开 CDM 同步：cdm_public → sat_cdm（整表覆盖）+ hs_cdm_history（留档）。
 *
 * 字段口径（探针实测）：
 *  - MIN_RNG 单位是米 → miss_distance_km = MIN_RNG / 1000；
 *  - TCA / CREATED 都是 UTC，直接入库；
 *  - 公开 CDM 不含协方差、状态向量、相对速度、硬体半径：
 *      rel_speed_km_per_s 与 a_*、b_*、mid_* 用 sat_tle 现行 TLE 在 TCA 时刻跑 SGP4 得到（TEME、km），
 *      并在 raw_json._derived 标注；hard_body_radius_m / radial_distance_km 置 NULL；
 *  - originator 按旧行实测取值（全为空串），保持与 jsc 现有数据一致。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { twoline2satrec, propagate, type SatRec } from 'satellite.js'
import { bulkInsert, execute, query, withTransaction } from '../db.js'
import { logger } from '../logger.js'
import { SpaceTrackClient } from '../util/spaceTrack.js'
import { parseUtc } from '../util/time.js'
import { num } from '../util/orbit.js'
import type { SyncResult } from './types.js'

const log = logger('sync.cdm')

interface CdmRaw {
  [k: string]: unknown
}

interface TleRow extends RowDataPacket {
  norad_id: number
  tle_line1: string
  tle_line2: string
}

interface Vec {
  x: number
  y: number
  z: number
}

const INSERT_SQL =
  'INSERT INTO sat_cdm (cdm_id, creation_date, originator, tca, type, focus_a, norad_a, name_a, norad_b, name_b, ' +
  'miss_distance_km, radial_distance_km, rel_speed_km_per_s, collision_probability, hard_body_radius_m, raw_json, ' +
  'a_x, a_y, a_z, b_x, b_y, b_z, mid_x, mid_y, mid_z) VALUES ?'

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

function buildSatrecCache(rows: TleRow[]) {
  const recs = new Map<number, SatRec | null>()
  for (const r of rows) {
    try {
      recs.set(Number(r.norad_id), twoline2satrec(r.tle_line1, r.tle_line2))
    } catch {
      recs.set(Number(r.norad_id), null)
    }
  }
  return recs
}

function posVelAt(recs: Map<number, SatRec | null>, norad: number, at: Date): { r: Vec; v: Vec } | null {
  const rec = recs.get(norad)
  if (!rec) return null
  try {
    const pv = propagate(rec, at)
    if (!pv || !pv.position || !pv.velocity) return null
    return { r: pv.position as Vec, v: pv.velocity as Vec }
  } catch {
    return null
  }
}

export async function runCdmSync(): Promise<SyncResult> {
  const started = Date.now()
  const client = new SpaceTrackClient()
  await client.login()

  const path = '/basicspacedata/query/class/cdm_public/TCA/%3Enow-1/orderby/TCA%20asc/format/json'
  const raw = (await client.getJson<unknown>(path)) as CdmRaw[]
  if (!Array.isArray(raw)) {
    throw new Error(`CDM 查询返回非数组：${JSON.stringify(raw).slice(0, 200)}`)
  }
  log.info(`拉取公开 CDM ${raw.length} 条`)

  const tles = await query<TleRow>('SELECT norad_id, tle_line1, tle_line2 FROM sat_tle')
  const recs = buildSatrecCache(tles)

  const cdmRows: unknown[][] = []
  const historyRows: unknown[][] = []
  const fetchedAt = new Date()
  let derived = 0
  let skipped = 0

  for (const item of raw) {
    const noradA = num(item.SAT_1_ID)
    const noradB = num(item.SAT_2_ID)
    const tca = parseUtc(str(item.TCA))
    if (!noradA || !noradB || !tca) {
      skipped++
      continue
    }
    const pc = num(item.PC)
    const minRngM = num(item.MIN_RNG)
    const missKm = minRngM === null ? null : minRngM / 1000
    const created = parseUtc(str(item.CREATED))
    const emergency = /^y$/i.test(str(item.EMERGENCY_REPORTABLE))

    let relSpeed: number | null = null
    let a: Vec | null = null
    let b: Vec | null = null
    const pa = posVelAt(recs, noradA, tca)
    const pb = posVelAt(recs, noradB, tca)
    if (pa && pb) {
      a = pa.r
      b = pb.r
      relSpeed = Math.hypot(pa.v.x - pb.v.x, pa.v.y - pb.v.y, pa.v.z - pb.v.z)
      derived++
    }

    const mid = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } : null
    const rawJson = JSON.stringify({
      ...item,
      _derived: derived > 0 ? ['rel_speed', 'xyz'] : []
    })

    cdmRows.push([
      str(item.CDM_ID),
      created,
      '', // originator：旧行实测为空串（计划 TODO 已按实测结论落定）
      tca,
      'SCREENING',
      0,
      Math.trunc(noradA),
      str(item.SAT_1_NAME),
      Math.trunc(noradB),
      str(item.SAT_2_NAME),
      missKm,
      null,
      relSpeed,
      pc,
      null,
      rawJson,
      a?.x ?? null,
      a?.y ?? null,
      a?.z ?? null,
      b?.x ?? null,
      b?.y ?? null,
      b?.z ?? null,
      mid?.x ?? null,
      mid?.y ?? null,
      mid?.z ?? null
    ])

    historyRows.push([
      fetchedAt,
      str(item.CDM_ID),
      created,
      tca,
      Math.trunc(noradA),
      Math.trunc(noradB),
      missKm,
      pc,
      emergency ? 1 : 0,
      rawJson
    ])
  }

  // 整表覆盖：事务内 DELETE + 批量 INSERT（与 jsc「每次拉取整体覆盖更新」的设计一致）
  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM sat_cdm')
    await bulkInsert(conn, INSERT_SQL, cdmRows)
  })

  // 历史留档不参与事务（失败不影响主表），保留 90 天
  if (historyRows.length) {
    await withTransaction(async (conn) => {
      await bulkInsert(
        conn,
        'INSERT INTO hs_cdm_history (fetched_at, cdm_id, created, tca, norad_a, norad_b, min_rng_km, pc, emergency, raw_json) VALUES ?',
        historyRows
      )
    })
    await execute('DELETE FROM hs_cdm_history WHERE fetched_at < (UTC_TIMESTAMP() - INTERVAL 90 DAY)')
  }

  const duration = Math.round((Date.now() - started) / 1000)
  const message = `CDM ${raw.length} 条，入库 ${cdmRows.length}，SGP4 补算 ${derived}，跳过 ${skipped}`
  await execute(
    'INSERT INTO sat_cdm_sync_log (total, duration, status, message) VALUES (?,?,1,?)',
    [cdmRows.length, duration, message.slice(0, 500)]
  )
  log.info(`${message}（${duration}s）`)
  return { total: raw.length, inserted: cdmRows.length, updated: 0, message }
}
