/**
 * 同步执行器：进程内并发互斥（MySQL GET_LOCK）+ hs_sync_log 生命周期。
 * 调度器与 /cgi2/admin/sync/* 都走这里，保证同一源不会并发执行。
 */
import { acquireLock, execute } from '../db.js'
import { hasSpaceTrackCreds } from '../config.js'
import { logger } from '../logger.js'
import { runGpSync } from './spacetrackGp.js'
import { runCdmSync } from './spacetrackCdm.js'
import { runEphSync } from './starlinkEph.js'
import { runAoeSync } from './aoe.js'
import { runSupgpSync } from './supgp.js'
import { SkipError, type SyncContext, type SyncOutcome, type SyncResult, type SyncSource } from './types.js'

const log = logger('sync')

const TASKS: Record<SyncSource, (ctx: SyncContext) => Promise<SyncResult>> = {
  gp: runGpSync,
  cdm: runCdmSync,
  eph: runEphSync,
  aoe: runAoeSync,
  supgp: runSupgpSync
}

export const ALL_SOURCES: SyncSource[] = ['gp', 'cdm', 'eph', 'aoe', 'supgp']

export function isSyncSource(v: string): v is SyncSource {
  return (ALL_SOURCES as string[]).includes(v)
}

/** 缺凭据时直接落一条 status=3 的日志，让 /cgi2/sync/status 能标红 */
async function recordSkip(source: SyncSource, message: string): Promise<SyncOutcome> {
  const now = new Date()
  await execute(
    'INSERT INTO hs_sync_log (source, started_at, finished_at, status, total, inserted, updated, message) VALUES (?,?,?,3,0,0,0,?)',
    [source, now, now, message]
  )
  log.warn(`${source} 跳过：${message}`)
  return { source, state: 'skipped', total: 0, inserted: 0, updated: 0, message, durationMs: 0 }
}

export async function runSync(source: SyncSource, trigger: 'schedule' | 'manual' = 'schedule'): Promise<SyncOutcome> {
  if ((source === 'gp' || source === 'cdm') && !hasSpaceTrackCreds()) {
    return await recordSkip(source, 'SAT_USERNAME / SAT_PASSWORD 未配置，无法登录 Space-Track')
  }

  const lock = await acquireLock(`hs:${source}`)
  if (!lock.ok) {
    log.warn(`${source} 已有实例在运行，跳过本轮`)
    return { source, state: 'skipped', total: 0, inserted: 0, updated: 0, message: '已有实例在运行', durationMs: 0 }
  }

  const started = new Date()
  const ins = await execute(
    'INSERT INTO hs_sync_log (source, started_at, status, message, params_json) VALUES (?,?,0,?,?)',
    [source, started, '', JSON.stringify({ trigger })]
  )
  const runId = ins.insertId

  try {
    log.info(`${source} 同步开始（run_id=${runId}，触发=${trigger}）`)
    const r = await TASKS[source]({ runId })
    const durationMs = Date.now() - started.getTime()
    await execute(
      'UPDATE hs_sync_log SET finished_at=?, status=1, total=?, inserted=?, updated=?, message=? WHERE id=?',
      [new Date(), r.total, r.inserted, r.updated, r.message.slice(0, 1000), runId]
    )
    log.info(`${source} 同步完成：total=${r.total} inserted=${r.inserted} updated=${r.updated}（${Math.round(durationMs / 1000)}s）`)
    return { source, state: 'ok', ...r, durationMs }
  } catch (e) {
    const durationMs = Date.now() - started.getTime()
    const message = e instanceof Error ? e.message : String(e)
    if (e instanceof SkipError) {
      await execute('UPDATE hs_sync_log SET finished_at=?, status=3, message=? WHERE id=?', [
        new Date(),
        message.slice(0, 1000),
        runId
      ])
      log.warn(`${source} 跳过：${message}`)
      return { source, state: 'skipped', total: 0, inserted: 0, updated: 0, message, durationMs }
    }
    await execute('UPDATE hs_sync_log SET finished_at=?, status=2, message=? WHERE id=?', [
      new Date(),
      message.slice(0, 1000),
      runId
    ])
    log.error(`${source} 同步失败：${message}`)
    return { source, state: 'error', total: 0, inserted: 0, updated: 0, message, durationMs }
  } finally {
    await lock.release()
  }
}
