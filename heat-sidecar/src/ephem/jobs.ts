/**
 * 按需筛查任务队列（03 §15.7 / §15.11）
 *
 *  - 全局同时只跑 1 个任务，排队上限 HEAT_SCREEN_QUEUE_MAX；
 *  - 同一「星历 + kind + 时间窗」重复提交直接返回已有 jobId（防连点）；
 *  - 支持取消（AbortSignal）与超时（SCREEN_TIMEOUT_MIN）；
 *  - 结果写 hs_screen_run(scope='uploaded', ephem_id) 与 hs_event，进度写 hs_screen_job。
 */
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { execute, query } from '../db.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { coreReady } from '../core/loader.js'
import { runScreen, type ScreenKind } from '../screen/run.js'
import { getUploaded, loadUploadedTrack } from './store.js'

const log = logger('ephem.jobs')

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface JobView {
  jobId: string
  ephemId: string
  kind: ScreenKind
  windowH: number
  status: JobStatus
  progress: number
  runId: number | null
  nEvents: number | null
  errorCode: string | null
  message: string
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  /** 排队位置（1 = 下一个），仅 queued 有意义 */
  queuePosition?: number
}

interface JobRow extends RowDataPacket {
  id: string
  ephem_id: string
  kind: string
  window_h: number
  status: string
  progress: number | null
  run_id: number | null
  n_events: number | null
  error_code: string | null
  message: string | null
  created_at: Date | null
  started_at: Date | null
  finished_at: Date | null
}

const queue: string[] = []
let running: { id: string; ctl: AbortController } | null = null

function fmt(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 19).replace('T', ' ') : null
}

function toView(r: JobRow): JobView {
  const idx = queue.indexOf(r.id)
  return {
    jobId: r.id,
    ephemId: r.ephem_id,
    kind: r.kind as ScreenKind,
    windowH: Number(r.window_h),
    status: r.status as JobStatus,
    progress: Number(r.progress ?? 0),
    runId: r.run_id ?? null,
    nEvents: r.n_events ?? null,
    errorCode: r.error_code ?? null,
    message: r.message ?? '',
    createdAt: fmt(r.created_at),
    startedAt: fmt(r.started_at),
    finishedAt: fmt(r.finished_at),
    queuePosition: idx >= 0 ? idx + 1 : undefined
  }
}

export class JobError extends Error {
  constructor(public code: number, msg: string) {
    super(msg)
  }
}

export async function getJob(id: string): Promise<JobView | null> {
  const rows = await query<JobRow>('SELECT * FROM hs_screen_job WHERE id=? LIMIT 1', [id])
  return rows[0] ? toView(rows[0]) : null
}

export async function listJobs(ephemId?: string): Promise<JobView[]> {
  const rows = ephemId
    ? await query<JobRow>('SELECT * FROM hs_screen_job WHERE ephem_id=? ORDER BY created_at DESC LIMIT 20', [ephemId])
    : await query<JobRow>('SELECT * FROM hs_screen_job ORDER BY created_at DESC LIMIT 20')
  return rows.map(toView)
}

/** 提交任务：返回已有或新建的 job */
export async function submitJob(ephemId: string, kind: ScreenKind, windowH: number): Promise<{ job: JobView; reused: boolean }> {
  if (!coreReady()) throw new JobError(503, 'CORE_NOT_LOADED')
  if (![24, 72, 168].includes(windowH)) throw new JobError(400, 'windowH 只接受 24 / 72 / 168')
  const ephem = await getUploaded(ephemId)
  if (!ephem) throw new JobError(404, '星历不存在或已过期')
  if (!ephem.expires_at || ephem.expires_at.getTime() <= Date.now()) throw new JobError(400, '该星历已过期')

  const coverH = ephem.stop_utc ? (ephem.stop_utc.getTime() - Math.max(Date.now(), ephem.start_utc?.getTime() ?? 0)) / 3_600_000 : 0
  if (windowH > Math.ceil(coverH)) {
    throw new JobError(400, `时间窗 ${windowH}h 超出星历剩余覆盖（约 ${Math.max(0, Math.floor(coverH))}h）`)
  }

  const exist = await query<JobRow>(
    "SELECT * FROM hs_screen_job WHERE ephem_id=? AND kind=? AND window_h=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
    [ephemId, kind, windowH]
  )
  if (exist[0]) return { job: toView(exist[0]), reused: true }

  if (queue.length >= config.HEAT_SCREEN_QUEUE_MAX) {
    throw new JobError(429, `服务器忙（排队已满 ${config.HEAT_SCREEN_QUEUE_MAX}），请稍后再试`)
  }

  const id = randomUUID()
  await execute(
    "INSERT INTO hs_screen_job (id, ephem_id, kind, window_h, status, progress) VALUES (?,?,?,?,'queued',0)",
    [id, ephemId, kind, windowH]
  )
  queue.push(id)
  log.info(`按需任务入队：${id}（${ephem.name || ephemId} ${kind} ${windowH}h）`)
  void pump()
  const rows = await query<JobRow>('SELECT * FROM hs_screen_job WHERE id=?', [id])
  return { job: toView(rows[0]), reused: false }
}

export async function cancelJob(id: string): Promise<boolean> {
  const rows = await query<JobRow>('SELECT * FROM hs_screen_job WHERE id=? LIMIT 1', [id])
  const row = rows[0]
  if (!row) return false
  if (row.status === 'queued') {
    const i = queue.indexOf(id)
    if (i >= 0) queue.splice(i, 1)
    await execute("UPDATE hs_screen_job SET status='canceled', finished_at=UTC_TIMESTAMP() WHERE id=?", [id])
    return true
  }
  if (row.status === 'running' && running?.id === id) {
    running.ctl.abort()
    return true
  }
  return false
}

/** 单飞：串行执行队列 */
async function pump(): Promise<void> {
  if (running) return
  const id = queue.shift()
  if (!id) return
  const rows = await query<JobRow>('SELECT * FROM hs_screen_job WHERE id=? LIMIT 1', [id])
  const row = rows[0]
  if (!row || row.status !== 'queued') {
    void pump()
    return
  }

  const ctl = new AbortController()
  running = { id, ctl }
  const timer = setTimeout(() => ctl.abort(), config.SCREEN_TIMEOUT_MIN * 60_000)
  timer.unref?.()
  await execute("UPDATE hs_screen_job SET status='running', started_at=UTC_TIMESTAMP(), progress=0.02 WHERE id=?", [id])

  let lastWrite = 0
  const onProgress = (ratio: number): void => {
    const now = Date.now()
    if (now - lastWrite < 1200 && ratio < 0.99) return
    lastWrite = now
    void execute('UPDATE hs_screen_job SET progress=? WHERE id=?', [Math.min(0.99, Math.max(0.02, ratio)), id]).catch(
      () => undefined
    )
  }

  try {
    const track = await loadUploadedTrack(row.ephem_id)
    if (!track) throw new Error('INPUT_INVALID: 星历文件无法解码')
    const outcome = await runScreen(row.kind as ScreenKind, 'manual', {
      tracks: [track],
      scope: 'uploaded',
      ephemId: row.ephem_id,
      windowH: Number(row.window_h),
      workers: config.HEAT_UPLOAD_WORKERS,
      signal: ctl.signal,
      onProgress
    })
    await execute(
      "UPDATE hs_screen_job SET status='done', progress=1, run_id=?, n_events=?, finished_at=UTC_TIMESTAMP(), message=? WHERE id=?",
      [outcome.runId, outcome.nEvents, outcome.message.slice(0, 500), id]
    )
    log.info(`按需任务完成：${id} run=${outcome.runId} 事件 ${outcome.nEvents}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const aborted = ctl.signal.aborted
    const code = aborted ? (msg === 'ABORTED' ? 'CANCELED' : 'TIMEOUT') : msg.includes(':') ? msg.split(':')[0] : 'SCREEN_FAILED'
    const status: JobStatus = aborted ? 'canceled' : 'failed'
    await execute(
      "UPDATE hs_screen_job SET status=?, error_code=?, message=?, finished_at=UTC_TIMESTAMP() WHERE id=?",
      [status, code.slice(0, 40), msg.slice(0, 500), id]
    )
    log.warn(`按需任务${status}：${id} ${msg}`)
  } finally {
    clearTimeout(timer)
    running = null
    void pump()
  }
}

/** 进程重启后把残留的 queued / running 标记为失败（内存队列已丢失） */
export async function resetStaleJobs(): Promise<void> {
  try {
    await execute(
      "UPDATE hs_screen_job SET status='failed', error_code='RESTARTED', finished_at=UTC_TIMESTAMP() WHERE status IN ('queued','running')"
    )
  } catch { /* 表可能尚未建好 */ }
}

export function isBusy(): boolean {
  return Boolean(running)
}
