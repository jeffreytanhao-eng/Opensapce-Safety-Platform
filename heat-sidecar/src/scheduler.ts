/**
 * 调度器：每个同步源独立间隔；启动时若「距上次成功 ≥ 间隔」立即执行。
 * 用 5 分钟轮询代替长定时器（避免 setTimeout 漂移与跨天问题），实际执行由 runner 的 DB 锁互斥。
 */
import type { RowDataPacket } from 'mysql2/promise'
import { query } from './db.js'
import { config, syncHours } from './config.js'
import { logger } from './logger.js'
import { ALL_SOURCES, runSync } from './sync/runner.js'
import type { SyncSource } from './sync/types.js'
import { runScreen, type ScreenKind } from './screen/run.js'
import { cleanupUploads } from './routes/ephem.js'

const log = logger('scheduler')

const TICK_MS = 5 * 60_000

let timer: NodeJS.Timeout | null = null
let cleanupTimer: NodeJS.Timeout | null = null
let ticking = false
const inFlight = new Set<SyncSource>()

interface LastOkRow extends RowDataPacket {
  finished_at: Date | null
}

async function lastSuccessAt(source: SyncSource): Promise<Date | null> {
  const rows = await query<LastOkRow>(
    'SELECT finished_at FROM hs_sync_log WHERE source = ? AND status = 1 ORDER BY id DESC LIMIT 1',
    [source]
  )
  return rows[0]?.finished_at ?? null
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()
    for (const source of ALL_SOURCES) {
      if (inFlight.has(source)) continue
      const hours = syncHours[source]
      const last = await lastSuccessAt(source)
      const due = !last || now - last.getTime() >= hours * 3_600_000
      if (!due) continue
      inFlight.add(source)
      void runSync(source, 'schedule')
        .then((out) => {
          // 筛查与同步分离（SCREEN_ON_SYNC=false 可关）：TLE 同步后跑左签 TLE×TLE，星历同步后跑右签
          if (!out || out.state !== 'ok' || !config.SCREEN_ON_SYNC) return
          if (source === 'gp') requestScreens(['tle-threat'])
          else if (source === 'eph') requestScreens(['tle'])
        })
        .catch((e) => log.error(`${source} 调度执行异常：${e instanceof Error ? e.message : String(e)}`))
        .finally(() => inFlight.delete(source))
    }
  } catch (e) {
    log.error(`调度轮询失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    ticking = false
  }
}

/** 待跑筛查队列：两个 kind 串行互斥（避免两轮同时抢内存）；AOE 批跑已停 */
const pendingScreens = new Set<ScreenKind>()
let screening = false

function requestScreens(kinds: ScreenKind[]): void {
  for (const k of kinds) pendingScreens.add(k)
  void drainScreens()
}

async function drainScreens(): Promise<void> {
  if (screening) return
  screening = true
  try {
    while (pendingScreens.size) {
      const kind = pendingScreens.values().next().value as ScreenKind
      pendingScreens.delete(kind)
      try {
        await runScreen(kind, 'schedule')
      } catch (e) {
        log.error(`${kind} 筛查失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    screening = false
  }
}

export function startScheduler(): void {
  if (timer) return
  log.info(
    `调度启动：gp=${syncHours.gp}h cdm=${syncHours.cdm}h eph=${syncHours.eph}h aoe=${syncHours.aoe}h supgp=${syncHours.supgp}h`
  )
  void tick()
  timer = setInterval(() => void tick(), TICK_MS)
  // 过期上传星历清理：每小时一次（03 §15.8）
  void cleanupUploads().catch((e) => log.warn(`过期清理失败：${e instanceof Error ? e.message : String(e)}`))
  cleanupTimer = setInterval(() => {
    void cleanupUploads().catch((e) => log.warn(`过期清理失败：${e instanceof Error ? e.message : String(e)}`))
  }, 3_600_000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = null
}
