/**
 * /cgi2 星历分析接口（03 §15.7）
 *
 *  - POST /ephem/upload         multipart，字段 file（≤12 MB）+ 可选 name
 *  - GET  /ephem/list           scope=uploaded|official
 *  - GET  /ephem/:id            元信息
 *  - GET  /ephem/:id/states     位置/速度序列（JSON，不含协方差）
 *  - DELETE /ephem/:id          只能删已上传星历
 *  - POST /screen               提交按需筛查任务
 *  - GET  /screen/:jobId        任务状态
 *  - POST /screen/:jobId/cancel 取消任务
 *
 * 现阶段不区分使用者：上传与结果全局共享（§15.11 第 3 条）。
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { logger } from '../logger.js'
import { parseUpload, UploadError, LIMITS } from '../ephem/parse.js'
import {
  cleanupExpired,
  deleteUploaded,
  getUploadedMeta,
  listOfficial,
  listUploaded,
  loadOfficial,
  latestOfficialRun,
  readStates,
  saveUpload,
  uploadsLastHour
} from '../ephem/store.js'
import { cancelJob, getJob, JobError, submitJob } from '../ephem/jobs.js'
import { config } from '../config.js'
import { fmtUtc } from '../util/time.js'

const log = logger('cgi2.ephem')
export const ephem = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.maxBytes, files: 1, fields: 4 }
})

function ok(res: Response, data: unknown): void {
  res.json({ code: 0, msg: 'ok', data })
}

function fail(res: Response, code: number, msg: string, reason?: string): void {
  res.status(code).json({ code, msg, data: reason ? { reason } : null })
}

ephem.post('/ephem/upload', (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (e: unknown) => {
    if (e) {
      const msg = e instanceof Error ? e.message : String(e)
      fail(res, msg.includes('File too large') ? 400 : 400, msg.includes('File too large') ? '文件超过 12 MB' : msg)
      return
    }
    next()
  })
}, async (req: Request, res: Response) => {
  try {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file
    if (!file) {
      fail(res, 400, '缺少 file 字段')
      return
    }
    if (await uploadsLastHour() >= config.HEAT_UPLOAD_PER_HOUR) {
      fail(res, 429, `每小时最多上传 ${config.HEAT_UPLOAD_PER_HOUR} 次，请稍后再试`)
      return
    }
    const parsed = parseUpload(file.buffer, file.originalname)
    const custom = String(req.body?.name ?? '').trim()
    if (custom) parsed.name = custom.slice(0, 100)
    const meta = await saveUpload(parsed, file.buffer)
    ok(res, {
      ephemId: meta.id,
      name: meta.name,
      norad: meta.norad,
      meme: meta.meme,
      format: meta.format,
      points: meta.points,
      stepS: meta.stepS,
      hasCov: meta.hasCov,
      startMs: parsed.t[0],
      stopMs: parsed.t[parsed.t.length - 1],
      expiresAt: meta.expiresAt,
      warnings: parsed.warnings
    })
  } catch (e) {
    if (e instanceof UploadError) {
      fail(res, 400, e.message, e.code)
      return
    }
    log.error(`上传失败：${e instanceof Error ? e.message : String(e)}`)
    fail(res, 500, '上传处理失败')
  }
})

ephem.get('/ephem/list', async (req: Request, res: Response) => {
  const scope = String(req.query.scope ?? 'uploaded')
  const keyword = String(req.query.keyword ?? '').trim()
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  try {
    const out = scope === 'official' ? await listOfficial(keyword, page, pageSize) : await listUploaded(keyword, page, pageSize)
    ok(res, { ...out, scope, page, pageSize })
  } catch (e) {
    fail(res, 503, `数据库不可用：${e instanceof Error ? e.message : String(e)}`)
  }
})

ephem.get('/ephem/:id/states', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const stepS = Math.max(1, Number(req.query.stepS ?? 60) || 60)
  try {
    if (id.startsWith('off:')) {
      const off = await loadOfficial(id)
      if (!off) {
        fail(res, 404, '官方星历不存在')
        return
      }
      const stride = Math.max(1, Math.round((stepS * 1000) / off.track.stepMs))
      const t: number[] = []
      const r: number[] = []
      const v: number[] = []
      for (let i = 0; i < off.track.n; i += stride) {
        t.push(off.track.startMs + i * off.track.stepMs)
        r.push(off.track.r[i * 3], off.track.r[i * 3 + 1], off.track.r[i * 3 + 2])
        v.push(off.track.v[i * 3], off.track.v[i * 3 + 1], off.track.v[i * 3 + 2])
      }
      ok(res, { id, meta: off.meta, stepS: off.track.stepMs / 1000, t, r, v })
      return
    }
    const states = await readStates(id, stepS)
    if (!states) {
      fail(res, 404, '星历不存在、已过期或无法解码')
      return
    }
    const meta = await getUploadedMeta(id)
    ok(res, { id, meta, ...states })
  } catch (e) {
    fail(res, 500, e instanceof Error ? e.message : String(e))
  }
})

ephem.get('/ephem/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  if (id.startsWith('off:')) {
    const off = await loadOfficial(id)
    if (!off) {
      fail(res, 404, '官方星历不存在')
      return
    }
    ok(res, off.meta)
    return
  }
  const meta = await getUploadedMeta(id)
  if (!meta) {
    fail(res, 404, '星历不存在或已过期')
    return
  }
  ok(res, meta)
})

ephem.delete('/ephem/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  if (id.startsWith('off:')) {
    fail(res, 400, '官方星历不能删除')
    return
  }
  const done = await deleteUploaded(id)
  if (!done) {
    fail(res, 404, '星历不存在或已过期')
    return
  }
  ok(res, { deleted: true, id })
})

/* ---------------- 按需筛查任务 ---------------- */

ephem.post('/screen', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { ephemId?: string; kind?: string; windowH?: number }
  const ephemId = String(body.ephemId ?? '')
  const kind = String(body.kind ?? '')
  const windowH = Number(body.windowH ?? 72)
  if (!ephemId) {
    fail(res, 400, '缺少 ephemId')
    return
  }
  if (kind !== 'tle' && kind !== 'aoe') {
    fail(res, 400, 'kind 必须是 tle 或 aoe')
    return
  }
  try {
    const out = await submitJob(ephemId, kind, windowH)
    ok(res, { ...out.job, reused: out.reused })
  } catch (e) {
    if (e instanceof JobError) {
      fail(res, e.code, e.message, e.code === 503 ? 'CORE_NOT_LOADED' : undefined)
      return
    }
    fail(res, 500, e instanceof Error ? e.message : String(e))
  }
})

ephem.get('/screen/:jobId', async (req: Request, res: Response) => {
  const job = await getJob(String(req.params.jobId))
  if (!job) {
    fail(res, 404, '任务不存在')
    return
  }
  ok(res, job)
})

ephem.post('/screen/:jobId/cancel', async (req: Request, res: Response) => {
  const done = await cancelJob(String(req.params.jobId))
  if (!done) {
    fail(res, 400, '任务不存在或已结束')
    return
  }
  ok(res, { canceled: true })
})

/* ---------------- 运维 ---------------- */

/** 过期清理（调度器每小时调用一次，也可手动触发） */
export async function cleanupUploads(): Promise<number> {
  return cleanupExpired()
}

/** 最新一轮官方星历（元信息用） */
export async function officialRunInfo(): Promise<{ runId: number | null; time: string | null }> {
  const id = await latestOfficialRun()
  return { runId: id, time: id ? fmtUtc(new Date()) : null }
}
