/**
 * 统一星历存取（官方 + 上传，03 §15.6 / §15.7）
 *
 *  - 所有星历点数据统一存 MySQL `hs_ephem.data`（HSEPH1 + Float64 的 gzip BLOB），
 *    与官方同步、上传解析共用同一套二进制契约（见 sync/starlinkEph.ts 头注释）；
 *  - 官方星历按卫星唯一（sat_key='MEME:<meme_id>'），新星历覆盖旧星历；
 *  - 上传星历 id 为 uuid、sat_key=NULL，同 sha256 复用，默认保留 HEAT_UPLOAD_TTL_D 天。
 */
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { RowDataPacket } from 'mysql2/promise'
import { execute, query } from '../db.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { fmtUtc } from '../util/time.js'
import { decodeTrack } from '../screen/ephemStore.js'
import type { EphTrack } from '../screen/types.js'
import type { ParsedEphem } from './parse.js'

const log = logger('ephem.store')

/** 元信息列（不含 data，避免列表接口把 BLOB 全量拉回） */
const META_COLS =
  'id, scope, meme_id, norad_id, name, file_format, points, step_s, has_cov, start_utc, stop_utc, created_utc, created_at, expires_at, size_bytes'

export interface EphemMeta {
  id: string
  scope: 'uploaded' | 'official'
  name: string
  norad: number | null
  meme: number | null
  format: string
  points: number
  stepS: number
  hasCov: boolean
  startUtc: string | null
  stopUtc: string | null
  createdUtc: string | null
  expiresAt: string | null
  sizeBytes?: number
  warnings?: string[]
}

/** 统一表行（data 仅在需要解码时显式查询） */
interface Row extends RowDataPacket {
  id: string
  scope: 'official' | 'uploaded'
  meme_id: number | null
  norad_id: number | null
  name: string | null
  file_format: string | null
  points: number
  step_s: number | null
  has_cov: number
  start_utc: Date | null
  stop_utc: Date | null
  created_utc: Date | null
  created_at: Date | null
  expires_at: Date | null
  size_bytes: number | null
  sha256?: string | null
  data?: Buffer
}

export function encodeBin(p: ParsedEphem): Buffer {
  const n = p.t.length
  const hasCov = p.cov21 ? 1 : 0
  const f = new Float64Array(n * 7 + (p.cov21 ? n * 21 : 0))
  let k = 0
  for (let i = 0; i < n; i++) f[k++] = p.t[i]
  for (let i = 0; i < n * 3; i++) f[k++] = p.r[i]
  for (let i = 0; i < n * 3; i++) f[k++] = p.v[i]
  if (p.cov21) for (let i = 0; i < n * 21; i++) f[k++] = p.cov21[i]
  const header = Buffer.alloc(24)
  header.write('HSEPH1\0\0', 0, 'latin1')
  header.writeUInt32LE(1, 8)
  header.writeUInt32LE(n, 12)
  header.writeUInt32LE(hasCov, 16)
  header.writeUInt32LE(Math.max(1, Math.round(p.stepSec)), 20)
  return gzipSync(Buffer.concat([header, Buffer.from(f.buffer, f.byteOffset, f.byteLength)]))
}

function toMeta(r: Row): EphemMeta {
  return {
    id: r.id,
    scope: r.scope,
    name: r.name ?? '',
    norad: r.norad_id,
    meme: r.meme_id,
    format: r.file_format ?? '',
    points: Number(r.points),
    stepS: Number(r.step_s ?? 0),
    hasCov: Boolean(r.has_cov),
    startUtc: fmtUtc(r.start_utc),
    stopUtc: fmtUtc(r.stop_utc),
    createdUtc: fmtUtc(r.created_utc ?? r.created_at),
    expiresAt: fmtUtc(r.expires_at),
    sizeBytes: r.size_bytes == null ? undefined : Number(r.size_bytes)
  }
}

/* ------------------------------ 上传星历 ------------------------------ */

/** 每小时上传计数（按 created_at，UTC） */
export async function uploadsLastHour(): Promise<number> {
  const rows = await query<RowDataPacket & { n: number }>(
    "SELECT COUNT(*) AS n FROM hs_ephem WHERE scope='uploaded' AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)"
  )
  return Number(rows[0]?.n ?? 0)
}

export async function saveUpload(parsed: ParsedEphem, raw: Buffer): Promise<EphemMeta> {
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const exist = await query<Row>(
    `SELECT ${META_COLS} FROM hs_ephem WHERE scope='uploaded' AND sha256=? LIMIT 1`,
    [sha256]
  )
  if (exist[0]) {
    const expires = new Date(Date.now() + config.HEAT_UPLOAD_TTL_D * 86_400_000)
    await execute('UPDATE hs_ephem SET expires_at=?, created_at=UTC_TIMESTAMP() WHERE id=?', [expires, exist[0].id])
    exist[0].expires_at = expires
    return toMeta(exist[0])
  }

  const id = randomUUID()
  const bin = encodeBin(parsed)
  const expires = new Date(Date.now() + config.HEAT_UPLOAD_TTL_D * 86_400_000)
  await execute(
    'INSERT INTO hs_ephem (id, scope, sat_key, name, norad_id, meme_id, file_format, sha256, size_bytes, points, step_s, has_cov, start_utc, stop_utc, data, expires_at) ' +
      'VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      'uploaded',
      parsed.name.slice(0, 100),
      parsed.norad,
      parsed.meme,
      parsed.format,
      sha256,
      raw.length,
      parsed.t.length,
      Math.max(1, Math.round(parsed.stepSec)),
      parsed.hasCov ? 1 : 0,
      new Date(parsed.t[0]),
      new Date(parsed.t[parsed.t.length - 1]),
      bin,
      expires
    ]
  )
  log.info(`已上传星历入库：${id}（${parsed.format}，${parsed.t.length} 点，${(raw.length / 1024).toFixed(0)} KB）`)
  const rows = await query<Row>(`SELECT ${META_COLS} FROM hs_ephem WHERE id=?`, [id])
  return toMeta(rows[0])
}

export async function listUploaded(keyword = '', page = 1, pageSize = 20): Promise<{ list: EphemMeta[]; total: number }> {
  const where: string[] = ["scope='uploaded'", 'expires_at > UTC_TIMESTAMP()']
  const params: unknown[] = []
  if (keyword) {
    where.push('(name LIKE ? OR norad_id = ?)')
    const n = Number(keyword)
    params.push(`%${keyword}%`, Number.isFinite(n) ? n : -1)
  }
  const w = where.join(' AND ')
  const cnt = await query<RowDataPacket & { n: number }>(`SELECT COUNT(*) AS n FROM hs_ephem WHERE ${w}`, params)
  const rows = await query<Row>(
    `SELECT ${META_COLS} FROM hs_ephem WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, Math.max(0, (page - 1) * pageSize)]
  )
  return { list: rows.map(toMeta), total: Number(cnt[0]?.n ?? 0) }
}

export async function getUploaded(id: string): Promise<Row | null> {
  const rows = await query<Row>(`SELECT ${META_COLS} FROM hs_ephem WHERE scope='uploaded' AND id=? LIMIT 1`, [id])
  return rows[0] ?? null
}

export async function getUploadedMeta(id: string): Promise<EphemMeta | null> {
  const r = await getUploaded(id)
  return r ? toMeta(r) : null
}

/** 解码为筛查引擎的 EphTrack（上传星历的 NORAD 以文件解析结果为准） */
export async function loadUploadedTrack(id: string): Promise<EphTrack | null> {
  const rows = await query<Row>(
    "SELECT id, scope, meme_id, norad_id, name, start_utc, step_s, points, has_cov, created_utc, created_at, data FROM hs_ephem WHERE scope='uploaded' AND id=? LIMIT 1",
    [id]
  )
  const row = rows[0]
  if (!row || !row.data) return null
  try {
    const track = decodeTrack(
      {
        meme_id: Number(row.meme_id ?? 0),
        norad_id: row.norad_id,
        name: row.name,
        step_s: row.step_s,
        points: row.points,
        has_cov: row.has_cov,
        created_utc: row.created_utc ?? row.created_at
      } as never,
      gunzipSync(row.data)
    )
    return track
  } catch (e) {
    log.warn(`上传星历解码失败（${id}）：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** 位置/速度序列（供三维绘制），按 stepS 抽稀；不含协方差 */
export async function readStates(id: string, stepS = 60): Promise<{ t: number[]; r: number[]; v: number[]; stepS: number } | null> {
  const track = await loadUploadedTrack(id)
  if (!track) return null
  const stride = Math.max(1, Math.round((stepS * 1000) / track.stepMs))
  const t: number[] = []
  const r: number[] = []
  const v: number[] = []
  for (let i = 0; i < track.n; i += stride) {
    t.push(track.startMs + i * track.stepMs)
    r.push(track.r[i * 3], track.r[i * 3 + 1], track.r[i * 3 + 2])
    v.push(track.v[i * 3], track.v[i * 3 + 1], track.v[i * 3 + 2])
  }
  return { t, r, v, stepS: track.stepMs / 1000 }
}

/** 删除已上传星历：事件 → 轮次 → 任务 → 记录 */
export async function deleteUploaded(id: string): Promise<boolean> {
  const row = await getUploaded(id)
  if (!row) return false
  const runs = await query<RowDataPacket & { id: number }>(
    "SELECT id FROM hs_screen_run WHERE scope='uploaded' AND ephem_id=?",
    [id]
  )
  const ids = runs.map((r) => Number(r.id))
  if (ids.length) {
    await execute(`DELETE FROM hs_event WHERE run_id IN (${ids.map(() => '?').join(',')})`, ids)
    await execute(`DELETE FROM hs_screen_run WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
  }
  await execute('DELETE FROM hs_screen_job WHERE ephem_id=?', [id])
  await execute("DELETE FROM hs_ephem WHERE scope='uploaded' AND id=?", [id])
  log.info(`已删除上传星历：${id}`)
  return true
}

/** 过期清理（调度器每小时调用一次） */
export async function cleanupExpired(): Promise<number> {
  const rows = await query<Row>(
    "SELECT id FROM hs_ephem WHERE scope='uploaded' AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()"
  )
  let n = 0
  for (const r of rows) {
    try {
      await deleteUploaded(r.id)
      n++
    } catch (e) {
      log.warn(`过期清理失败（${r.id}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (n) log.info(`过期清理：删除 ${n} 份上传星历`)
  return n
}

/* ------------------------------ 官方星历 ------------------------------ */

/** 最新一轮成功同步（仅用于展示同步时间，不参与数据筛选） */
export async function latestOfficialRun(): Promise<number | null> {
  const rows = await query<RowDataPacket & { id: number }>(
    "SELECT id FROM hs_sync_log WHERE source='eph' AND status=1 ORDER BY id DESC LIMIT 1"
  )
  return rows[0]?.id ?? null
}

/** 官方星历列表：按卫星唯一，不再按轮次过滤（新星历已覆盖旧星历） */
export async function listOfficial(keyword = '', page = 1, pageSize = 20): Promise<{ list: EphemMeta[]; total: number }> {
  const where = ["scope='official'"]
  const params: unknown[] = []
  if (keyword) {
    where.push('(name LIKE ? OR norad_id = ?)')
    const n = Number(keyword)
    params.push(`%${keyword}%`, Number.isFinite(n) ? n : -1)
  }
  const w = where.join(' AND ')
  const cnt = await query<RowDataPacket & { n: number }>(`SELECT COUNT(*) AS n FROM hs_ephem WHERE ${w}`, params)
  const rows = await query<Row>(
    `SELECT ${META_COLS} FROM hs_ephem WHERE ${w} ORDER BY (norad_id IS NULL), meme_id, id LIMIT ? OFFSET ?`,
    [...params, pageSize, Math.max(0, (page - 1) * pageSize)]
  )
  return { list: rows.map(toMeta), total: Number(cnt[0]?.n ?? 0) }
}

/** 按 id（off:<meme>）读取官方星历 */
export async function loadOfficial(id: string): Promise<{ meta: EphemMeta; track: EphTrack } | null> {
  const rows = await query<Row>(
    `SELECT ${META_COLS}, data FROM hs_ephem WHERE scope='official' AND id=? LIMIT 1`,
    [id]
  )
  const r = rows[0]
  if (!r || !r.data) return null
  try {
    const track = decodeTrack(
      {
        meme_id: Number(r.meme_id ?? 0),
        norad_id: r.norad_id,
        name: r.name,
        step_s: r.step_s,
        points: r.points,
        has_cov: r.has_cov,
        created_utc: r.created_utc ?? r.created_at
      } as never,
      gunzipSync(r.data)
    )
    if (!track) return null
    return { meta: toMeta(r), track }
  } catch {
    return null
  }
}
