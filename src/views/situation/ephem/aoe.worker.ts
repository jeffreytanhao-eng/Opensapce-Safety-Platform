/**
 * 星历热力 Worker：AOE 点云粗筛 + 候选 TLE/SGP4 精算，全部在主线程外完成。
 *
 * 与 screen.worker.ts 的差别只在对方目标的外推方式：粗筛沿用二体点云，
 * 精算改用候选目标的 TLE + SGP4（见 aoeHeat.ts）。
 *
 * 分两阶段消息（同一 Worker 实例内连续处理）：
 * - coarse：AOE 点云 × 本星星历 → 候选列表（主线程据此只拉候选目标的 TLE）；
 * - refine：候选列表 + 候选 TLE → 威胁事件。
 */
import { coarseAoe, refineAoe } from './aoeHeat'
import type { AoeCandidate, AoeHeatOptions, AoeTle } from './aoeHeat'
import type { CatalogSnapshotEntry } from './screening'
import type { EphemSet, EphemState, ThreatEvent } from './types'

interface AoeBase {
  id: string
  norad: number
  name: string
  start: number
  stop: number
  states: EphemState[]
  opt: AoeHeatOptions
}

/** 第一阶段：点云粗筛 */
export interface AoeCoarseRequest extends AoeBase {
  type: 'aoe'
  mode: 'coarse'
  catalog: CatalogSnapshotEntry[]
}

/** 第二阶段：候选 TLE 精算 */
export interface AoeRefineRequest extends AoeBase {
  type: 'aoe'
  mode: 'refine'
  cands: AoeCandidate[]
  tles: AoeTle[]
}

export type AoeRequest = AoeCoarseRequest | AoeRefineRequest

export type AoeResponse =
  | { type: 'progress'; p: number; stage: 'coarse' | 'refine' }
  | { type: 'coarseDone'; candidates: AoeCandidate[] }
  | { type: 'done'; events: ThreatEvent[] }
  | { type: 'error'; message: string }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AoeRequest>) => void) | null
  postMessage: (data: AoeResponse) => void
}

ctx.onmessage = (e) => {
  try {
    const d = e.data
    if (d?.type !== 'aoe') return
    // coarseAoe / refineAoe 只用到 id / norad / name / start / stop / states
    const set = {
      id: d.id,
      norad: d.norad,
      name: d.name,
      start: d.start,
      stop: d.stop,
      states: d.states
    } as unknown as EphemSet
    const t0 = Math.max(d.start, d.states.length ? d.states[0].t : d.start)
    const t1 = Math.min(d.stop, d.states.length ? d.states[d.states.length - 1].t : d.stop)

    if (d.mode === 'coarse') {
      let lastTick = -1
      const candidates = coarseAoe(set, d.catalog, t0, t1, d.opt, (p) => {
        if (p - lastTick >= 0.05 || p >= 1) {
          lastTick = p
          ctx.postMessage({ type: 'progress', p, stage: 'coarse' })
        }
      })
      ctx.postMessage({ type: 'coarseDone', candidates })
      return
    }

    if (!d.cands.length || !d.tles.length) {
      ctx.postMessage({ type: 'done', events: [] })
      return
    }
    let lastTick = -1
    const events = refineAoe(set, d.tles, d.cands, d.opt, (p) => {
      if (p - lastTick >= 0.05 || p >= 1) {
        lastTick = p
        ctx.postMessage({ type: 'progress', p, stage: 'refine' })
      }
    })
    ctx.postMessage({ type: 'done', events })
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error)?.message || '星历热力计算失败' })
  }
}
