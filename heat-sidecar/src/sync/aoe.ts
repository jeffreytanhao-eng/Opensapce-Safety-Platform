/**
 * AOE（spacemapper）同步：/cgi/orbital/aoe/list?channel=KY&format=json → sat_aoe（指定列）。
 *
 * 说明：
 *  - 未配置 AOE_API_TOKEN 时直接 SkipError（runner 记 status=3，前端标红）；
 *  - EPOCH 可能带 +0800，统一转 UTC 后入库（探针确认 sat_aoe.epoch 存 UTC）；
 *  - 接口字段名未在文档中完全固定，这里做多候选键兼容；日志会打印首条原始字段，便于核对。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { bulkInsert, execute, query, withTransaction } from '../db.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { fetchJson } from '../util/http.js'
import { parseUtc } from '../util/time.js'
import { apsisKm, buildTle, num, periodMinutes, regimeOf, semiMajorAxisKm } from '../util/orbit.js'
import { SkipError, type SyncResult } from './types.js'

const log = logger('sync.aoe')

interface AoeRow extends RowDataPacket {
  norad_id: number
  object_name: string
  object_type: string
  intl_desig: string
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
  channel: string
  constellation_id: string | null
  is_active: number | null
}

const COLS = [
  'norad_id',
  'object_name',
  'object_type',
  'intl_desig',
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
  'channel',
  'constellation_id',
  'raw_json',
  'is_active',
  'source',
  'updated_at'
] as const

const UPSERT_SQL =
  `INSERT INTO sat_aoe (${COLS.join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ` +
  COLS.filter((c) => c !== 'norad_id')
    .map((c) => `${c}=VALUES(${c})`)
    .join(',')

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]
  }
  return null
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

/** 兼容多种包装：根数组 / data 数组 / data.list / result.records … */
function extractList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const direct = ['data', 'list', 'records', 'rows', 'items', 'result']
  for (const k of direct) {
    const v = obj[k]
    if (Array.isArray(v)) return v as Record<string, unknown>[]
    if (v && typeof v === 'object') {
      const inner = v as Record<string, unknown>
      for (const k2 of direct) {
        const v2 = inner[k2]
        if (Array.isArray(v2)) return v2 as Record<string, unknown>[]
      }
    }
  }
  return []
}

export async function runAoeSync(): Promise<SyncResult> {
  if (!config.AOE_API_TOKEN) {
    throw new SkipError('AOE_API_TOKEN 未配置，跳过 AOE 同步')
  }
  const started = Date.now()
  const base = config.AOE_BASE_URL.replace(/\/$/, '')
  const url = `${base}/cgi/orbital/aoe/list?channel=KY&format=json`
  const payload = await fetchJson<unknown>(url, {
    headers: {
      Authorization: `Bearer ${config.AOE_API_TOKEN}`,
      'User-Agent': 'openspace-heat-sidecar/1.0'
    },
    timeoutMs: 180_000,
    retries: 3
  })

  const list = extractList(payload)
  if (!list.length) {
    throw new Error(`AOE 返回 0 条，响应片段：${JSON.stringify(payload).slice(0, 300)}`)
  }
  log.info(`AOE 返回 ${list.length} 条；首条字段：${Object.keys(list[0]).join(',')}`)

  const existingRows = await query<AoeRow>(
    `SELECT ${COLS.filter((c) => c !== 'raw_json' && c !== 'source' && c !== 'updated_at').join(',')} FROM sat_aoe`
  )
  const existing = new Map<number, AoeRow>()
  for (const r of existingRows) existing.set(Number(r.norad_id), r)

  const rows: unknown[][] = []
  const history: unknown[][] = []
  let inserted = 0
  let updated = 0
  let unchanged = 0
  let invalid = 0
  const now = new Date()

  for (const raw of list) {
    const norad = num(pick(raw, ['NORAD_CAT_ID', 'NORAD_ID', 'noradId', 'norad_id', 'NORAD', 'SSC']))
    const epoch = parseUtc(str(pick(raw, ['EPOCH', 'epoch', 'EPOCH_UTC'])))
    if (!norad || norad <= 0 || !epoch) {
      invalid++
      continue
    }
    const name = str(pick(raw, ['OBJECT_NAME', 'objectName', 'NAME', 'name']))
    const meanMotion = num(pick(raw, ['MEAN_MOTION', 'meanMotion']))
    const ecc = num(pick(raw, ['ECCENTRICITY', 'eccentricity'])) ?? 0
    const incl = num(pick(raw, ['INCLINATION', 'inclination'])) ?? 0
    const raan = num(pick(raw, ['RA_OF_ASC_NODE', 'RAAN', 'raan'])) ?? 0
    const argp = num(pick(raw, ['ARG_OF_PERICENTER', 'ARG_PERIGEE', 'argPerigee'])) ?? 0
    const ma = num(pick(raw, ['MEAN_ANOMALY', 'meanAnomaly'])) ?? 0
    const bstar = num(pick(raw, ['BSTAR', 'bstar'])) ?? 0
    const ndot = num(pick(raw, ['MEAN_MOTION_DOT', 'meanMotionDot'])) ?? 0
    const rev = num(pick(raw, ['REV_AT_EPOCH', 'revAtEpoch'])) ?? 0
    const intl = str(pick(raw, ['INTLDES', 'OBJECT_ID', 'intlDesig']))
    const objType = str(pick(raw, ['OBJECT_TYPE', 'objectType'])) || 'UNKNOWN'
    const channel = str(pick(raw, ['CHANNEL', 'channel'])) || 'KY'
    const constellation = str(pick(raw, ['CONSTELLATION_ID', 'constellationId'])) || null

    let line1 = str(pick(raw, ['TLE_LINE1', 'tle_line1', 'line1', 'tle1']))
    let line2 = str(pick(raw, ['TLE_LINE2', 'tle_line2', 'line2', 'tle2']))
    if ((!line1 || !line2) && meanMotion) {
      const built = buildTle({
        noradId: norad,
        intlDesig: intl,
        epoch,
        meanMotion,
        eccentricity: ecc,
        inclination: incl,
        raan,
        argPerigee: argp,
        meanAnomaly: ma,
        bstar,
        meanMotionDot: ndot,
        revNum: rev
      })
      line1 = built.line1
      line2 = built.line2
    }

    const sma = meanMotion ? semiMajorAxisKm(meanMotion) : 0
    const apsis = sma > 0 ? apsisKm(sma, ecc) : { apogee: null, perigee: null }
    const rawJson = JSON.stringify(raw)

    const prev = existing.get(norad)
    if (!prev) inserted++
    else if (prev.tle_line1 !== line1 || prev.epoch?.getTime() !== epoch.getTime()) updated++
    else unchanged++

    if (prev && prev.epoch && prev.epoch.getTime() !== epoch.getTime()) {
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
        prev.channel,
        prev.constellation_id
      ])
    }

    rows.push([
      Math.trunc(norad),
      name,
      objType,
      intl,
      regimeOf(sma, ecc),
      epoch,
      meanMotion,
      ndot,
      ecc,
      incl,
      raan,
      argp,
      ma,
      bstar,
      Math.trunc(rev),
      meanMotion ? periodMinutes(meanMotion) : null,
      sma || null,
      apsis.apogee,
      apsis.perigee,
      line1,
      line2,
      channel,
      constellation,
      rawJson,
      1,
      'aoe',
      now
    ])
  }

  await withTransaction(async (conn) => {
    await bulkInsert(conn, UPSERT_SQL, rows)
    if (history.length) {
      await bulkInsert(
        conn,
        'INSERT IGNORE INTO sat_aoe_history (norad_id, object_name, object_type, intl_desig, regime, epoch, mean_motion, mean_motion_dot, ecc, incl, raan, arg_perigee, mean_anomaly, bstar, rev_num, period, semimajor_axis, apogee, perigee, tle_line1, tle_line2, channel, constellation_id) VALUES ?',
        history
      )
    }
  })

  const duration = Math.round((Date.now() - started) / 1000)
  const message = `AOE ${list.length} 条（无效 ${invalid}），入库 ${rows.length}，归档 ${history.length}`
  await execute(
    'INSERT INTO sat_aoe_sync_log (channel, total, inserted, updated, unchanged, decayed, duration, status, message) VALUES (?,?,?,?,?,?,?,1,?)',
    ['KY', list.length, inserted, updated, unchanged, 0, duration, message.slice(0, 500)]
  )
  log.info(`${message}（${duration}s）`)
  return { total: list.length, inserted, updated, message }
}
