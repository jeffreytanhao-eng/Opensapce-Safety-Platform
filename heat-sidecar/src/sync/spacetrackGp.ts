/**
 * Space-Track GP 同步：在轨目标最新 TLE → sat_tle（指定列），旧历元归档 sat_tle_history。
 *
 * 硬性约束（计划 §2 第 2 条）：
 *  - 只写轨道相关列，绝不覆盖 owner_code / purpose_type / launch_site / catalog_id / match_source；
 *  - sat_sync_log 的 source 记为 'space-track-sidecar'。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { bulkInsert, execute, query, withTransaction } from '../db.js'
import { logger } from '../logger.js'
import { SpaceTrackClient } from '../util/spaceTrack.js'
import { parseUtc } from '../util/time.js'
import { apsisKm, num, regimeOf, semiMajorAxisKm } from '../util/orbit.js'
import type { SyncResult } from './types.js'

const log = logger('sync.gp')

/** Space-Track GP JSON 行（只声明用到的字段，其余忽略） */
interface GpRow {
  NORAD_CAT_ID?: unknown
  OBJECT_NAME?: unknown
  OBJECT_TYPE?: unknown
  INTLDES?: unknown
  /** 新版 gp 接口按 CCSDS OMM 命名下发国际编号（旧版为 INTLDES），两者都要兼容 */
  OBJECT_ID?: unknown
  LAUNCH_DATE?: unknown
  EPOCH?: unknown
  MEAN_MOTION?: unknown
  MEAN_MOTION_DOT?: unknown
  ECCENTRICITY?: unknown
  INCLINATION?: unknown
  RA_OF_ASC_NODE?: unknown
  ARG_OF_PERICENTER?: unknown
  MEAN_ANOMALY?: unknown
  BSTAR?: unknown
  REV_AT_EPOCH?: unknown
  DECAY_DATE?: unknown
  TLE_LINE1?: unknown
  TLE_LINE2?: unknown
  PERIOD?: unknown
  SEMIMAJOR_AXIS?: unknown
  APOGEE?: unknown
  PERIGEE?: unknown
}

interface SatTleRow extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string
  launch_date: Date | null
  regime: string
  epoch: Date | null
  mean_motion: number | null
  mean_motion_dot: number | null
  ecc: number | null
  incl: number | null
  raan: number | null
  arg_perigee: number | null
  mean_anomaly: number | null
  bstar: number | null
  rev_num: number | null
  period: number | null
  semimajor_axis: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string
  tle_line2: string
  decay_date: Date | null
  owner_code: string
}

/** 允许写入的列（顺序即 INSERT 列顺序） */
const COLS = [
  'norad_id',
  'object_name',
  'object_type',
  'intl_desig',
  'launch_date',
  'regime',
  'epoch',
  'mean_motion',
  'mean_motion_dot',
  'ecc',
  'incl',
  'raan',
  'arg_perigee',
  'mean_anomaly',
  'bstar',
  'rev_num',
  'period',
  'semimajor_axis',
  'apogee',
  'perigee',
  'tle_line1',
  'tle_line2',
  'decay_date',
  'is_active',
  'source',
  'updated_at'
] as const

const UPSERT_SQL =
  `INSERT INTO sat_tle (${COLS.join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ` +
  COLS.filter((c) => c !== 'norad_id')
    .map((c) => `${c}=VALUES(${c})`)
    .join(',')

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

function dateOrNull(v: unknown): Date | null {
  const s = str(v)
  if (!s || /^null$/i.test(s)) return null
  return parseUtc(s)
}

interface ConsKwRow extends RowDataPacket {
  id: number
  code: string
  keywords: string
}

/**
 * 星座成员补链（只增不删）：按 sat_constellation.keywords 前缀匹配新入库载荷。
 * jsc 侧的自动归类任务停滞后，新发射卫星只有 sat_tle 没有 sat_constellation_sat 关联，
 * 导致星座卡片的「首发/最近发射」一直停在旧批次；这里用 INSERT IGNORE 补齐，不动已有关系。
 * 用前缀匹配（而不是包含匹配）避开「JILIN-01 GAOFEN 3D」被算进高分星座这类误判。
 */
async function backfillConstellationMembers(): Promise<number> {
  const cons = await query<ConsKwRow>(
    "SELECT id, code, keywords FROM sat_constellation WHERE keywords IS NOT NULL AND keywords <> ''"
  )
  let added = 0
  for (const c of cons) {
    let kws: string[] = []
    try {
      const parsed = JSON.parse(c.keywords) as unknown
      if (Array.isArray(parsed)) kws = parsed.map((k) => String(k).trim())
    } catch {
      kws = String(c.keywords).split(/[,，\s]+/).map((k) => k.trim())
    }
    // 太短的关键词前缀匹配噪声大（如 GEE 会命中 GEESAT 之外的对象），跳过
    kws = kws.filter((k) => k.length >= 4)
    if (!kws.length) continue
    const cond = kws.map(() => "object_name LIKE CONCAT(?, '%')").join(' OR ')
    try {
      const r = await execute(
        `INSERT IGNORE INTO sat_constellation_sat (constellation_id, norad_id, source)
         SELECT ?, norad_id, 'auto-sidecar' FROM sat_tle WHERE object_type = 'PAYLOAD' AND (${cond})`,
        [c.id, ...kws]
      )
      added += Number(r.affectedRows ?? 0)
    } catch (e) {
      log.warn(`星座成员补链失败（${c.code}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return added
}

export async function runGpSync(): Promise<SyncResult> {
  const started = Date.now()
  const client = new SpaceTrackClient()
  await client.login()

  const path = '/basicspacedata/query/class/gp/decay_date/null-val/format/json'
  const raw = (await client.getJson<unknown>(path)) as GpRow[]
  if (!Array.isArray(raw)) {
    throw new Error(`GP 查询返回非数组：${JSON.stringify(raw).slice(0, 200)}`)
  }
  log.info(`拉取 GP ${raw.length} 条`)

  const existingRows = await query<SatTleRow>(
    `SELECT ${COLS.filter((c) => c !== 'is_active' && c !== 'source' && c !== 'updated_at').join(',')}, owner_code FROM sat_tle`
  )
  const existing = new Map<number, SatTleRow>()
  for (const r of existingRows) existing.set(Number(r.norad_id), r)

  const rows: unknown[][] = []
  const history: unknown[][] = []
  let inserted = 0
  let updated = 0
  let unchanged = 0
  let invalid = 0

  const now = new Date()
  for (const g of raw) {
    const norad = num(g.NORAD_CAT_ID)
    const line1 = str(g.TLE_LINE1)
    const line2 = str(g.TLE_LINE2)
    if (!norad || norad <= 0 || !line1 || !line2) {
      invalid++
      continue
    }
    const epoch = dateOrNull(g.EPOCH)
    const meanMotion = num(g.MEAN_MOTION)
    const ecc = num(g.ECCENTRICITY) ?? 0
    const sma = num(g.SEMIMAJOR_AXIS) ?? (meanMotion ? semiMajorAxisKm(meanMotion) : 0)
    const apsis = sma > 0 ? apsisKm(sma, ecc) : { apogee: null, perigee: null }
    const decay = dateOrNull(g.DECAY_DATE)

    const prev = existing.get(norad)
    if (!prev) inserted++
    else if (prev.tle_line1 !== line1) updated++
    else unchanged++

    if (prev && prev.epoch && epoch && prev.epoch.getTime() !== epoch.getTime()) {
      history.push([
        prev.norad_id,
        prev.object_name,
        prev.object_type,
        prev.intl_desig,
        prev.regime,
        prev.epoch,
        prev.mean_motion,
        prev.mean_motion_dot,
        prev.ecc,
        prev.incl,
        prev.raan,
        prev.arg_perigee,
        prev.mean_anomaly,
        prev.bstar,
        prev.rev_num,
        prev.period,
        prev.semimajor_axis,
        prev.apogee,
        prev.perigee,
        prev.tle_line1,
        prev.tle_line2,
        prev.decay_date,
        prev.owner_code
      ])
    }

    rows.push([
      Math.trunc(norad),
      str(g.OBJECT_NAME),
      str(g.OBJECT_TYPE) || 'UNKNOWN',
      str(g.OBJECT_ID) || str(g.INTLDES),
      // 国际编号里的序号是「年内第几次发射」，不是年内第几天，日期只能取 gp.LAUNCH_DATE
      dateOrNull(g.LAUNCH_DATE),
      regimeOf(sma, ecc),
      epoch,
      meanMotion,
      num(g.MEAN_MOTION_DOT),
      ecc,
      num(g.INCLINATION),
      num(g.RA_OF_ASC_NODE),
      num(g.ARG_OF_PERICENTER),
      num(g.MEAN_ANOMALY),
      num(g.BSTAR),
      num(g.REV_AT_EPOCH) === null ? 0 : Math.trunc(num(g.REV_AT_EPOCH) as number),
      num(g.PERIOD) ?? (meanMotion ? 1440 / meanMotion : null),
      sma || null,
      num(g.APOGEE) ?? apsis.apogee,
      num(g.PERIGEE) ?? apsis.perigee,
      line1,
      line2,
      decay,
      decay ? 0 : 1,
      'space-track',
      now
    ])
  }

  await withTransaction(async (conn) => {
    await bulkInsert(conn, UPSERT_SQL, rows)
    if (history.length) {
      await bulkInsert(
        conn,
        'INSERT IGNORE INTO sat_tle_history (norad_id, object_name, object_type, intl_desig, regime, epoch, mean_motion, mean_motion_dot, ecc, incl, raan, arg_perigee, mean_anomaly, bstar, rev_num, period, semimajor_axis, apogee, perigee, tle_line1, tle_line2, decay_date, owner_code) VALUES ?',
        history
      )
    }
  })

  const linked = await backfillConstellationMembers()

  const duration = Math.round((Date.now() - started) / 1000)
  const message = `GP ${raw.length} 条（无效 ${invalid}），归档历史 ${history.length}，星座补链 ${linked}`
  await execute(
    'INSERT INTO sat_sync_log (source, total, inserted, updated, unchanged, decayed, duration, status, message) VALUES (?,?,?,?,?,?,?,1,?)',
    ['space-track-sidecar', raw.length, inserted, updated, unchanged, 0, duration, message.slice(0, 500)]
  )
  log.info(`${message}（inserted=${inserted} updated=${updated} unchanged=${unchanged}）`)
  return { total: raw.length, inserted, updated, message }
}
