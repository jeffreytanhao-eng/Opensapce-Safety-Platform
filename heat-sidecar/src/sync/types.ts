/** 同步任务的公共类型 */

export type SyncSource = 'gp' | 'cdm' | 'eph' | 'aoe' | 'supgp'

export interface SyncContext {
  /** 本次 hs_sync_log.id，星历同步用它作为 run_id */
  runId: number
}

export interface SyncResult {
  total: number
  inserted: number
  updated: number
  message: string
}

export type SyncState = 'ok' | 'stale' | 'error' | 'skipped' | 'running'

export interface SyncOutcome {
  source: SyncSource
  state: SyncState
  total: number
  inserted: number
  updated: number
  message: string
  durationMs: number
}

/** 缺凭据 / 缺 token 等「可预期不执行」的情况：记 status=3，不当作失败 */
export class SkipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkipError'
  }
}
