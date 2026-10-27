/**
 * 旧星历数据一次性迁移：hs_eph_file / hs_uploaded_ephem（磁盘 bin）→ 统一表 hs_ephem（BLOB）。
 *
 *  - 幂等：目标 id 已存在则跳过，不会重复读盘；
 *  - 官方按卫星取最新一轮（run_id DESC）覆盖旧轮次；
 *  - 上传星历沿用原 uuid 作为 id，保留原 expires_at；
 *  - 旧表与磁盘文件保留不动，作为回滚备份。
 */
import { readFile } from 'node:fs/promises'
import type { RowDataPacket } from 'mysql2/promise'
import { pool, query } from '../db.js'
import { logger } from '../logger.js'

const log = logger('ephem.migrate')

interface LegacyEphRow extends RowDataPacket {
  run_id: number
  meme_id: number
  norad_id: number | null
  name: string | null
  file_name: string | null
  created_utc: Date | null
  start_utc: Date | null
  stop_utc: Date | null
  step_s: number | null
  frame: string | null
  cov_frame: string | null
  has_cov: number | null
  points: number | null
  bin_path: string
  sha1: string | null
}

interface LegacyUploadRow extends RowDataPacket {
  id: string
  name: string | null
  norad_id: number | null
  meme_id: number | null
  file_format: string
  sha256: string
  size_bytes: number
  points: number
  step_s: number | null
  has_cov: number
  start_utc: Date | null
  stop_utc: Date | null
  bin_path: string
  created_at: Date | null
  expires_at: Date | null
}

const INSERT_SQL =
  'INSERT INTO hs_ephem (id, scope, sat_key, meme_id, norad_id, name, file_name, file_format, frame, cov_frame, ' +
  'has_cov, points, step_s, start_utc, stop_utc, created_utc, sha1, sha256, size_bytes, data, run_id, created_at, expires_at) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),?)'

async function exists(id: string): Promise<boolean> {
  const rows = await query<RowDataPacket>('SELECT 1 AS ok FROM hs_ephem WHERE id=? LIMIT 1', [id])
  return rows.length > 0
}

export async function migrateLegacyEphem(): Promise<void> {
  let migrated = 0

  try {
    const rows = await query<LegacyEphRow>(
      'SELECT * FROM hs_eph_file WHERE bin_path IS NOT NULL ORDER BY run_id DESC, id DESC'
    )
    for (const r of rows) {
      const id = `off:${r.meme_id}`
      if (await exists(id)) continue
      try {
        const bin = await readFile(r.bin_path)
        await pool.execute(INSERT_SQL, [
          id,
          'official',
          `MEME:${r.meme_id}`,
          r.meme_id,
          r.norad_id,
          r.name,
          r.file_name,
          'itc',
          r.frame,
          r.cov_frame,
          r.has_cov ?? 0,
          r.points ?? 0,
          r.step_s,
          r.start_utc,
          r.stop_utc,
          r.created_utc,
          r.sha1,
          null,
          bin.length,
          bin,
          r.run_id,
          null,
          null
        ])
        migrated++
      } catch (e) {
        log.warn(`迁移官方星历失败（${r.bin_path}）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    log.warn(`读取 hs_eph_file 失败（可能尚未建表）：${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const rows = await query<LegacyUploadRow>('SELECT * FROM hs_uploaded_ephem ORDER BY created_at DESC')
    for (const r of rows) {
      if (await exists(r.id)) continue
      try {
        const bin = await readFile(r.bin_path)
        await pool.execute(INSERT_SQL, [
          r.id,
          'uploaded',
          null,
          r.meme_id,
          r.norad_id,
          r.name,
          null,
          r.file_format,
          null,
          null,
          r.has_cov ? 1 : 0,
          r.points,
          r.step_s,
          r.start_utc,
          r.stop_utc,
          r.created_at,
          null,
          r.sha256,
          bin.length,
          bin,
          null,
          r.created_at,
          r.expires_at
        ])
        migrated++
      } catch (e) {
        log.warn(`迁移上传星历失败（${r.bin_path}）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    log.warn(`读取 hs_uploaded_ephem 失败（可能尚未建表）：${e instanceof Error ? e.message : String(e)}`)
  }

  if (migrated) log.info(`旧星历迁移完成：${migrated} 份写入 hs_ephem`)
}
