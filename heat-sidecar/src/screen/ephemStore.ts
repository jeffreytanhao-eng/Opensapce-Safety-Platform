/**
 * 星历读取（P2）：从统一表 hs_ephem 解码 gzip 二进制为 EphTrack。
 * 二进制格式见 sync/starlinkEph.ts 头注释（HSEPH1 + Float64 数组）。
 */
import { gunzipSync } from 'node:zlib'
import { query } from '../db.js'
import { logger } from '../logger.js'
import type { RowDataPacket } from 'mysql2/promise'
import type { EphTrack } from './types.js'

const log = logger('screen.eph')

interface EphRow extends RowDataPacket {
  id: string
  meme_id: number | null
  norad_id: number | null
  name: string | null
  start_utc: Date | null
  step_s: number | null
  points: number | null
  has_cov: number | null
  created_utc: Date | null
  data?: Buffer
}

export interface EphRunInfo {
  runId: number | null
  total: number
  tracks: EphTrack[]
}

export function decodeTrack(row: EphRow, buf: Buffer): EphTrack | null {
  if (buf.length < 24) return null
  if (buf.subarray(0, 6).toString('latin1') !== 'HSEPH1') return null
  const n = buf.readUInt32LE(12)
  const hasCov = buf.readUInt32LE(16)
  const stepSec = buf.readUInt32LE(20)
  if (!(n > 1)) return null
  const need = 24 + n * 8 * (7 + (hasCov ? 21 : 0))
  if (buf.length < need) return null
  // Float64Array 视图要求 8 字节对齐：数据库返回的 Buffer 可能带任意 byteOffset，需先拷贝到对齐内存
  const body = (buf.byteOffset + 24) % 8 === 0 ? buf : Buffer.from(buf)
  const f = new Float64Array(body.buffer, body.byteOffset + 24, n * (7 + (hasCov ? 21 : 0)))
  const t = f.subarray(0, n)
  const r = f.subarray(n, n * 4)
  const v = f.subarray(n * 4, n * 7)
  const cov = hasCov ? f.subarray(n * 7, n * 28) : null
  return {
    memeId: Number(row.meme_id ?? 0),
    noradId: row.norad_id ?? null,
    name: row.name ?? '',
    createdMs: row.created_utc ? row.created_utc.getTime() : null,
    startMs: t[0],
    stepMs: stepSec * 1000,
    n,
    r: r as unknown as Float64Array,
    v: v as unknown as Float64Array,
    cov: (cov as unknown as Float64Array) ?? null
  }
}

/** 最近一轮成功的星历同步（仅用于轮次统计） */
export async function latestEphRunId(): Promise<number | null> {
  const rows = await query<RowDataPacket & { id: number }>(
    "SELECT id FROM hs_sync_log WHERE source='eph' AND status=1 ORDER BY id DESC LIMIT 1"
  )
  return rows[0]?.id ?? null
}

/**
 * 加载官方星历轨迹。maxPrimary>0 时按（优先级：有 NORAD → id）截断，
 * 避免全量 1 万+ 份把内存打满（每份 4321 点约 240 KB，1 万份约 2.4 GB）。
 */
export async function loadTracks(maxPrimary = 0): Promise<EphRunInfo> {
  const rows = await query<EphRow>(
    "SELECT id, meme_id, norad_id, name, start_utc, step_s, points, has_cov, created_utc, data " +
      "FROM hs_ephem WHERE scope='official' AND (stop_utc IS NULL OR stop_utc > UTC_TIMESTAMP()) " +
      "ORDER BY stop_utc DESC, (norad_id IS NULL), meme_id, id",
    []
  )
  const picked = maxPrimary > 0 ? rows.slice(0, maxPrimary) : rows
  const tracks: EphTrack[] = []
  for (const row of picked) {
    try {
      const buf = row.data
      if (!buf) continue
      const tr = decodeTrack(row, gunzipSync(buf))
      if (tr) tracks.push(tr)
    } catch (e) {
      log.warn(`星历解码失败（id=${row.id}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  log.info(`加载官方星历：${tracks.length}/${rows.length} 份（上限 ${maxPrimary || '不限'}）`)
  return { runId: null, total: rows.length, tracks }
}
