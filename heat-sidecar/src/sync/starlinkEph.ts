/**
 * Starlink 公开星历同步：MANIFEST → 逐个 ITC 文件解析 → 统一表 hs_ephem（BLOB）入库。
 *
 * 存储格式（P2 解码必须与此一致）：
 *   gzip( header 24B + Float64 数组 )
 *   header: magic 'HSEPH1\0\0'(8) | version u32=1 | n u32 | hasCov u32 | stepSec u32
 *   payload: t[n] (Unix ms, UTC) | r[3n] km | v[3n] km/s | cov21[21n]（hasCov=1 时）
 *   协方差为文件原始 UVW 下三角顺序（C11,C21,C22,…），未做旋转。
 *
 * 覆盖规则（用户要求）：
 *   - 每轮最多处理 STARLINK_EPH_MAX_FILES 个文件（默认 50，0 = 不限）；
 *   - 同一颗星（sat_key='MEME:<meme_id>'）用新星历覆盖旧星历；
 *   - 新出现的星直接插入 hs_ephem。
 *
 * NORAD 规则（计划 P0-9）：
 *   MEME id < 100000 → 直接当 NORAD；≥100000 → 按名称在 sat_tle / hs_supgp 里匹配，匹配不到置 NULL。
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { RowDataPacket } from 'mysql2/promise'
import { pool, execute, query } from '../db.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { fetchText } from '../util/http.js'
import { parseItc, type ItcParseResult } from './parseItc.js'
import type { SyncContext, SyncResult } from './types.js'

const log = logger('sync.eph')

interface ExistingRow extends RowDataPacket {
  id: string
  file_name: string | null
  points: number | null
}

interface NameRow extends RowDataPacket {
  norad_id: number
  object_name: string
}

const UPSERT_SQL =
  'INSERT INTO hs_ephem (id, scope, sat_key, meme_id, norad_id, name, file_name, file_format, frame, cov_frame, has_cov, points, step_s, start_utc, stop_utc, created_utc, sha1, size_bytes, data, run_id) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
  'ON DUPLICATE KEY UPDATE norad_id=VALUES(norad_id), name=VALUES(name), file_name=VALUES(file_name), ' +
  'frame=VALUES(frame), cov_frame=VALUES(cov_frame), has_cov=VALUES(has_cov), points=VALUES(points), ' +
  'step_s=VALUES(step_s), start_utc=VALUES(start_utc), stop_utc=VALUES(stop_utc), created_utc=VALUES(created_utc), ' +
  'sha1=VALUES(sha1), size_bytes=VALUES(size_bytes), data=VALUES(data), run_id=VALUES(run_id), expires_at=NULL'

function metaFromFileName(fileName: string): { memeId: number; name: string } | null {
  const base = fileName.replace(/\.txt$/i, '')
  const m = /^MEME_(\d+)_([^_]+)_/.exec(base)
  if (!m) return null
  const memeId = Number(m[1])
  if (!Number.isFinite(memeId) || memeId <= 0) return null
  return { memeId, name: m[2] }
}

function encodeBin(p: ItcParseResult): Buffer {
  const n = p.t.length
  const hasCov = p.cov21 ? 1 : 0
  const total = n * 7 + (p.cov21 ? n * 21 : 0)
  const f = new Float64Array(total)
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
  header.writeUInt32LE(Math.round(p.stepSec), 20)
  // 小端平台（x64/arm64）直接复用 Float64Array 内存，避免逐值写 Buffer
  const body = Buffer.from(f.buffer, f.byteOffset, f.byteLength)
  return gzipSync(Buffer.concat([header, body]))
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= items.length) return
      await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
}

export async function runEphSync(ctx: SyncContext): Promise<SyncResult> {
  const runId = ctx.runId

  const base = config.STARLINK_EPH_BASE.endsWith('/') ? config.STARLINK_EPH_BASE : `${config.STARLINK_EPH_BASE}/`
  const manifest = await fetchText(`${base}MANIFEST.txt`, { timeoutMs: 120_000, retries: 3 })
  const allFiles = manifest
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase().endsWith('.txt'))
  const limit = config.STARLINK_EPH_MAX_FILES > 0 ? config.STARLINK_EPH_MAX_FILES : allFiles.length
  const picked = allFiles.slice(0, limit)
  log.info(`MANIFEST ${allFiles.length} 个文件，本轮处理 ${picked.length} 个（上限 ${config.STARLINK_EPH_MAX_FILES || '不限'}）`)

  // 去重（同一 meme 在清单里出现多次时只取第一个）
  const seenMeme = new Set<number>()
  const files: { fileName: string; memeId: number; name: string }[] = []
  for (const f of picked) {
    const meta = metaFromFileName(f)
    if (!meta) continue
    if (seenMeme.has(meta.memeId)) continue
    seenMeme.add(meta.memeId)
    files.push({ fileName: f, ...meta })
  }

  // 名称 → NORAD 对照表（sat_tle 为主，hs_supgp 兜底）
  const nameMap = new Map<string, number>()
  for (const r of await query<NameRow>("SELECT norad_id, object_name FROM sat_tle WHERE object_name <> ''")) {
    nameMap.set(String(r.object_name).trim().toUpperCase(), Number(r.norad_id))
  }
  for (const r of await query<NameRow>("SELECT norad_id, object_name FROM hs_supgp WHERE object_name IS NOT NULL AND object_name <> ''")) {
    const key = String(r.object_name).trim().toUpperCase()
    if (!nameMap.has(key)) nameMap.set(key, Number(r.norad_id))
  }

  // 已有官方星历：同一份清单文件（含生成时间戳）直接复用，避免重复下载
  const prevById = new Map<string, ExistingRow>()
  for (const r of await query<ExistingRow>("SELECT id, file_name, points FROM hs_ephem WHERE scope='official'")) {
    prevById.set(r.id, r)
  }

  let downloaded = 0
  let reused = 0
  let failed = 0
  let noCov = 0

  await runPool(files, config.STARLINK_EPH_CONCURRENCY, async (f) => {
    const id = `off:${f.memeId}`
    try {
      const prev = prevById.get(id)
      if (prev && prev.file_name === f.fileName && Number(prev.points ?? 0) > 1) {
        await execute('UPDATE hs_ephem SET run_id=?, updated_at=UTC_TIMESTAMP() WHERE id=?', [runId, id])
        reused++
        return
      }

      const text = await fetchText(`${base}${f.fileName}`, { timeoutMs: 120_000, retries: 3 })
      const sha1 = createHash('sha1').update(text).digest('hex')
      const parsed = parseItc(text)
      const norad =
        f.memeId < 100000 ? f.memeId : (nameMap.get(f.name.trim().toUpperCase()) ?? null)
      const bin = encodeBin(parsed)
      if (!parsed.cov21) noCov++

      await pool.execute(UPSERT_SQL, [
        id,
        'official',
        `MEME:${f.memeId}`,
        f.memeId,
        norad,
        f.name,
        f.fileName,
        'itc',
        parsed.frame,
        parsed.covFrame,
        parsed.cov21 ? 1 : 0,
        parsed.t.length,
        Math.max(1, Math.round(parsed.stepSec)),
        parsed.startUtc,
        parsed.stopUtc,
        parsed.createdUtc,
        sha1,
        bin.length,
        bin,
        runId
      ])
      downloaded++
      if (downloaded % 100 === 0) log.info(`已下载入库 ${downloaded}/${files.length}（失败 ${failed}）`)
    } catch (e) {
      failed++
      log.warn(`处理 ${f.fileName} 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const message = `星历 ${files.length} 个，下载入库 ${downloaded}，复用 ${reused}，失败 ${failed}，无协方差 ${noCov}`
  log.info(message)
  return { total: files.length, inserted: downloaded, updated: reused, message }
}
