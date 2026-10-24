/**
 * 星历热力内核：AOE 编目点云粗筛（二体）→ 候选目标 TLE + SGP4 精算。
 *
 * 与「我的星历」现有威胁筛选的区别只在对方目标的外推方式：
 * - 粗筛阶段完全复用 screening.screenEphemeris（目录快照 + 二体外推），只把目录换成 AOE 库点云，
 *   目的是把 3.5 万个目标压到几百个候选，避免逐目标 SGP4；
 * - 精算阶段对候选目标用 TLE + SGP4 逐秒外推，消除二体外推 24~72 h 的沿迹漂移；
 *   本星始终用 Hermite 插值取精密星历状态。
 *
 * 坐标系口径：satellite.js 输出 TEME，项目星历按其自身 ECI 直接使用，两者存在岁差级差异
 * （百米级，见 tleCompare.ts 头注释）。为与现有筛选结果可比，这里沿用「直接相减」口径。
 *
 * 本文件不依赖 Vue / three，可直接在 Worker 内运行。
 */
import { twoline2satrec, propagate } from 'satellite.js'
import { interpolateAt } from './interp'
import { elementsFromRV, screenEphemeris } from './screening'
import type { CatalogSnapshotEntry } from './screening'
import { collisionProbability } from './probability'
import type { SigmaRegime } from './probability'
import type { EphemSet, ThreatEvent, Vec3 } from './types'

export interface AoeHeatOptions {
  /** 筛选时间窗（小时）：调用方按星历有效期裁剪，最长 72 */
  windowH: number
  /** 粗筛步长（秒） */
  coarseStepSec: number
  /** 粗筛保留距离（km）：比报告距离宽，只用于挑候选 */
  coarseKm: number
  /** 报告距离（km）：精算后的事件过滤阈值 */
  reportKm: number
  /** 联合硬体半径（km） */
  hardBodyKm: number
  /** 碰撞概率阈值 */
  pcThreshold: number
  /** 最大事件数 */
  maxEvents: number
  /** 最大精算候选数（按粗筛距离升序截断） */
  maxCandidates: number
  /** 目录点云快照的历元（Unix ms）：粗筛二体外推的对齐时刻 */
  catalogT?: number
}

export const DEFAULT_AOE_HEAT: AoeHeatOptions = {
  windowH: 24,
  coarseStepSec: 120,
  coarseKm: 200,
  reportKm: 50,
  hardBodyKm: 0.01,
  pcThreshold: 1e-6,
  maxEvents: 300,
  maxCandidates: 800
}

/** 粗筛候选：只保留 NORAD 与粗筛最近时刻，精算阶段再拉 TLE */
export interface AoeCandidate {
  norad: number
  name: string
  coarseMissKm: number
  coarseTca: number
}

/** 精算用 TLE（仅候选目标） */
export type AoeTle = [number, string, string]

/** 轨道区制：决定无协方差时的经验 σ */
function regimeOf(aKm: number): SigmaRegime {
  if (!Number.isFinite(aKm)) return 'leo'
  if (aKm > 40000) return 'geo'
  if (aKm > 10000) return 'meo'
  return 'leo'
}

function normName(s?: string): string {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * 二体粗筛：复用 screenEphemeris，把「报告距离」放大到 coarseKm。
 * 精算阶段才按 reportKm 收口，粗筛宁宽勿漏。
 */
export function coarseAoe(
  self: EphemSet,
  catalog: CatalogSnapshotEntry[],
  t0: number,
  t1: number,
  opt: AoeHeatOptions,
  onProgress?: (p: number) => void
): AoeCandidate[] {
  if (!self.states.length || !catalog.length || !(t1 > t0)) return []
  const events = screenEphemeris(
    self,
    catalog,
    {
      t0,
      t1,
      catalogT: opt.catalogT,
      coarseStepSec: opt.coarseStepSec,
      maxDistKm: opt.coarseKm,
      hardBodyKm: opt.hardBodyKm,
      // 粗筛阶段不按 Pc 收口：pcThreshold=1 时只有 miss≤coarseKm 才保留
      pcThreshold: 1,
      maxEvents: Math.max(1, opt.maxCandidates * 8)
    },
    onProgress
  )
  const out: AoeCandidate[] = events.map((e) => ({
    norad: e.otherNorad,
    name: e.otherName,
    coarseMissKm: e.missKm,
    coarseTca: e.tca
  }))
  out.sort((a, b) => a.coarseMissKm - b.coarseMissKm)
  return out.slice(0, Math.max(1, opt.maxCandidates))
}

interface TleRec {
  l1: string
  l2: string
}

/**
 * SGP4 精算：对每个候选在粗筛 TCA ± coarseStepSec 内逐秒搜索，再做抛物线细化。
 * 距离口径与现有筛选一致（本星插值位置 − 对方 SGP4 位置）。
 */
export function refineAoe(
  self: EphemSet,
  tles: AoeTle[],
  cands: AoeCandidate[],
  opt: AoeHeatOptions,
  onProgress?: (p: number) => void
): ThreatEvent[] {
  if (!cands.length || !tles.length || !self.states.length) return []
  const tleMap = new Map<number, TleRec>()
  for (const [norad, l1, l2] of tles) {
    if (Number.isFinite(norad) && l1 && l2) tleMap.set(norad, { l1, l2 })
  }
  const selfName = normName(self.name)
  const el = elementsFromRV(self.states[0].r, self.states[0].v)
  const regime = regimeOf(el.a)
  const reportKm = opt.reportKm > 0 ? opt.reportKm : 50
  const winMs = Math.max(10, opt.coarseStepSec) * 1000
  const stepMs = 1000

  /** 某时刻的距离与对方状态；本星超出星历范围时返回 null */
  const stateAt = (satrec: ReturnType<typeof twoline2satrec>, t: number) => {
    if (t < self.start || t > self.stop) return null
    const s = interpolateAt(self.states, t)
    if (!s) return null
    const pv = propagate(satrec, new Date(t))
    const p = pv?.position
    if (!p) return null
    const d = Math.hypot(p.x - s.r[0], p.y - s.r[1], p.z - s.r[2])
    return { d, s, p, v: pv?.velocity }
  }

  const bestByNorad = new Map<number, ThreatEvent>()
  let done = 0
  for (const cand of cands) {
    done++
    const tle = tleMap.get(cand.norad)
    // 名称与 NORAD 双重排除本星自身（与现有筛选同口径）
    const sameName = selfName !== '' && normName(cand.name) === selfName
    if (!tle || cand.norad === self.norad || sameName) {
      if (onProgress && done % 20 === 0) onProgress(0.15 + 0.85 * (done / cands.length))
      continue
    }
    let satrec: ReturnType<typeof twoline2satrec>
    try {
      satrec = twoline2satrec(tle.l1, tle.l2)
    } catch {
      continue
    }
    const ta = Math.max(self.start, cand.coarseTca - winMs)
    const tb = Math.min(self.stop, cand.coarseTca + winMs)
    if (!(tb > ta)) continue

    // 逐秒扫描：找到粗筛窗口内的最小距离时刻
    let bestD = Infinity
    let bestT = NaN
    for (let t = ta; t <= tb; t += stepMs) {
      const st = stateAt(satrec, t)
      if (st && st.d < bestD) {
        bestD = st.d
        bestT = t
      }
    }
    if (!Number.isFinite(bestD) || !Number.isFinite(bestT)) continue

    // 抛物线细化：三点 (t-1s, t, t+1s) 的顶点，把 TCA 收敛到亚秒级
    const prev = stateAt(satrec, bestT - stepMs)
    const next = stateAt(satrec, bestT + stepMs)
    let tca = bestT
    if (prev && next) {
      const d0 = prev.d
      const d1 = bestD
      const d2 = next.d
      const denom = d0 - 2 * d1 + d2
      if (denom > 1e-12) {
        const shift = Math.max(-0.5, Math.min(0.5, (0.5 * (d0 - d2)) / denom))
        tca = bestT + shift * stepMs
      }
    }
    const at = stateAt(satrec, tca) || stateAt(satrec, bestT)
    if (!at) continue
    const miss = at.d
    if (!(miss <= reportKm)) {
      if (onProgress && done % 20 === 0) onProgress(0.15 + 0.85 * (done / cands.length))
      continue
    }

    const vv = at.v
    const ov = vv || null
    // 相对速度：优先用 SGP4 速度；缺失时用 ±0.5 s 位置差分
    let relSpeed = 0
    if (ov) {
      relSpeed = Math.hypot(ov.x - at.s.v[0], ov.y - at.s.v[1], ov.z - at.s.v[2])
    } else {
      const a = stateAt(satrec, tca - 500)
      const b = stateAt(satrec, tca + 500)
      if (a && b) {
        // 1 s 间隔内两星的位移差 = 相对速度矢量（km/s）
        relSpeed = Math.hypot(
          b.p.x - a.p.x - at.s.v[0],
          b.p.y - a.p.y - at.s.v[1],
          b.p.z - a.p.z - at.s.v[2]
        )
      }
    }

    const pc = collisionProbability({
      missKm: miss,
      relSpeedKmS: relSpeed,
      hardBodyKm: opt.hardBodyKm,
      regime
    })
    if (!(miss <= reportKm || pc >= opt.pcThreshold)) {
      if (onProgress && done % 20 === 0) onProgress(0.15 + 0.85 * (done / cands.length))
      continue
    }

    const missScore = Math.min(1, Math.max(0, 1 - miss / reportKm))
    const pcScore = pc > 0 ? Math.min(1, Math.max(0, 1 + Math.log10(pc) / 12)) : 0
    const risk = Math.max(missScore, pcScore)
    const level: ThreatEvent['level'] =
      pc > 1e-4 || miss < reportKm * 0.1
        ? 'high'
        : pc > 1e-6 || miss < reportKm * 0.3
          ? 'medium'
          : 'low'

    const ev: ThreatEvent = {
      id: `${self.id}-aoe-${cand.norad}-${Math.round(tca)}`,
      selfNorad: self.norad,
      otherNorad: cand.norad,
      otherName: cand.name,
      tca,
      missKm: miss,
      relSpeedKmS: relSpeed,
      pc,
      risk,
      level,
      midEci: [at.s.r[0], at.s.r[1], at.s.r[2]] as Vec3,
      otherEci: [at.p.x, at.p.y, at.p.z] as Vec3,
      otherVel: ov ? ([ov.x, ov.y, ov.z] as Vec3) : undefined
    }
    // 同一目标多次入网时只保留最近的一次
    const old = bestByNorad.get(cand.norad)
    if (!old || ev.missKm < old.missKm) bestByNorad.set(cand.norad, ev)
    if (onProgress && done % 20 === 0) onProgress(0.15 + 0.85 * (done / cands.length))
  }

  const events = [...bestByNorad.values()]
  events.sort((a, b) => a.missKm - b.missKm)
  if (onProgress) onProgress(1)
  return events.slice(0, Math.max(1, opt.maxEvents))
}
