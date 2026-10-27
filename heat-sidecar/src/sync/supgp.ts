/**
 * Celestrak SupGP（SpaceX-E）同步 → hs_supgp。
 * 用途：① Starlink 名称 ↔ NORAD 对照表；② 无星历目标在 P2 的兜底副星源。
 * 每目标只保留最新 2 条。
 */
import { bulkInsert, execute, query, withTransaction } from '../db.js'
import { logger } from '../logger.js'
import { fetchJson } from '../util/http.js'
import { parseUtc } from '../util/time.js'
import { buildTle, num } from '../util/orbit.js'
import type { SyncResult } from './types.js'

const log = logger('sync.supgp')

const SUPGP_URL = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=SpaceX-E&FORMAT=JSON'

interface SupGpItem {
  [k: string]: unknown
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

export async function runSupgpSync(): Promise<SyncResult> {
  const started = Date.now()
  const list = await fetchJson<unknown>(SUPGP_URL, {
    headers: { 'User-Agent': 'openspace-heat-sidecar/1.0' },
    timeoutMs: 120_000,
    retries: 3
  })
  if (!Array.isArray(list)) {
    throw new Error(`SupGP 返回非数组：${JSON.stringify(list).slice(0, 200)}`)
  }
  const items = list as SupGpItem[]
  log.info(`SupGP 返回 ${items.length} 条`)

  const fetchedAt = new Date()
  const rows: unknown[][] = []
  let skipped = 0
  let synthesized = 0
  for (const it of items) {
    const norad = num(it.NORAD_CAT_ID)
    const epoch = parseUtc(str(it.EPOCH))
    if (!norad || norad <= 0 || !epoch) {
      skipped++
      continue
    }
    // Celestrak FORMAT=JSON 下发的是 GP 字段（OMM），不带 TLE_LINE1/2；
    // 两行根数在这里由根数合成（下游筛查统一只认 TLE 两行）
    let line1 = str(it.TLE_LINE1)
    let line2 = str(it.TLE_LINE2)
    if (!line1 || !line2) {
      const meanMotion = num(it.MEAN_MOTION)
      const ecc = num(it.ECCENTRICITY)
      const incl = num(it.INCLINATION)
      const raan = num(it.RA_OF_ASC_NODE)
      const argp = num(it.ARG_OF_PERICENTER)
      const ma = num(it.MEAN_ANOMALY)
      if (meanMotion === null || ecc === null || incl === null || raan === null || argp === null || ma === null) {
        skipped++
        continue
      }
      const tle = buildTle({
        noradId: norad,
        intlDesig: str(it.OBJECT_ID),
        epoch,
        meanMotion,
        eccentricity: ecc,
        inclination: incl,
        raan,
        argPerigee: argp,
        meanAnomaly: ma,
        bstar: num(it.BSTAR) ?? 0,
        meanMotionDot: num(it.MEAN_MOTION_DOT) ?? 0,
        revNum: num(it.REV_AT_EPOCH) ?? 0,
        classification: str(it.CLASSIFICATION_TYPE) || 'U'
      })
      line1 = tle.line1
      line2 = tle.line2
      synthesized++
    }
    rows.push([Math.trunc(norad), epoch, str(it.OBJECT_NAME), line1, line2, 'SpaceX-E', fetchedAt])
  }

  await withTransaction(async (conn) => {
    await bulkInsert(
      conn,
      'INSERT INTO hs_supgp (norad_id, epoch, object_name, line1, line2, source, fetched_at) VALUES ? ' +
        'ON DUPLICATE KEY UPDATE object_name=VALUES(object_name), line1=VALUES(line1), line2=VALUES(line2), ' +
        'source=VALUES(source), fetched_at=VALUES(fetched_at)',
      rows
    )
    // 每目标只留最新 2 条
    await conn.query(
      `DELETE t FROM hs_supgp t JOIN (
         SELECT norad_id, epoch FROM (
           SELECT norad_id, epoch, ROW_NUMBER() OVER (PARTITION BY norad_id ORDER BY epoch DESC) AS rn FROM hs_supgp
         ) x WHERE rn > 2
       ) d ON t.norad_id = d.norad_id AND t.epoch = d.epoch`
    )
  })

  const kept = await query<{ n: number } & import('mysql2/promise').RowDataPacket>('SELECT COUNT(*) AS n FROM hs_supgp')
  const duration = Math.round((Date.now() - started) / 1000)
  const message = `SupGP ${items.length} 条，入库 ${rows.length}（合成 TLE ${synthesized}），跳过 ${skipped}，表内 ${kept[0]?.n ?? 0}`
  log.info(`${message}（${duration}s）`)
  return { total: items.length, inserted: rows.length, updated: 0, message }
}
