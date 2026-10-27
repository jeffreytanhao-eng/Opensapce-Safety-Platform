/**
 * ITC（Starlink 公开星历）解析 —— 从 src/views/situation/ephem/parseItc.ts 拷贝并按 sidecar 需求简化：
 *  - 不做坐标系旋转，原样保留 21 项协方差（UVW 下三角），由 P2 在 TCA 处插值后再旋转；
 *  - 输出扁平数组，便于直接写二进制。
 *
 * 文件结构：
 * ```
 * created:2026-10-24 09:06:40 UTC
 * ephemeris_start:2026-10-24 08:56:42 UTC ephemeris_stop:2026-10-27 08:56:42 UTC step_size:60
 * ephemeris_source:blend
 * UVW
 * 2026297085642.000  x y z vx vy vz
 * (21 个协方差值，可跨多行；实测为行主序下三角 C11,C21,C22,…)
 * ```
 */
import { parseItcEpoch, parseUtc } from '../util/time.js'

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const EPOCH_RE = /^\d{13}(?:\.\d+)?$/

export interface ItcParseResult {
  /** Unix ms（UTC） */
  t: number[]
  /** 位置 km（MEME J2000） */
  r: number[]
  /** 速度 km/s */
  v: number[]
  /** 每点 21 个协方差值（UVW 下三角），无协方差时为 null */
  cov21: number[] | null
  createdUtc: Date | null
  startUtc: Date | null
  stopUtc: Date | null
  stepSec: number
  /** 状态向量坐标系（ITC 为 MEME J2000，记为 EME2000） */
  frame: string
  /** 协方差坐标系（UVW / ECI / EME2000 / ICRF） */
  covFrame: string
  warnings: string[]
}

const KNOWN_FRAMES = new Set(['UVW', 'ECI', 'EME2000', 'ICRF', 'ITRF', 'TEME'])

export function parseItc(text: string): ItcParseResult {
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  const t: number[] = []
  const r: number[] = []
  const v: number[] = []
  const cov21: number[] = []

  let createdUtc: Date | null = null
  let startUtc: Date | null = null
  let stopUtc: Date | null = null
  let stepSec = 0
  let covFrame = 'UVW'
  let sawUtcMarker = false
  let covSeen = 0
  let covBroken = false

  let accNums: number[] = []
  let accLine = 0

  const flush = (): void => {
    if (accNums.length === 0) return
    if (accNums.length >= 21) {
      for (let k = 0; k < 21; k++) cov21.push(accNums[k])
      covSeen++
    } else {
      warnings.push(`第 ${accLine} 行的协方差仅 ${accNums.length} 个值（应为 21 个），已忽略`)
      covBroken = true
    }
    accNums = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const ln = i + 1
    const lower = line.toLowerCase()

    if (lower.startsWith('created')) {
      if (/\butc\b/i.test(line)) sawUtcMarker = true
      const m = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?/)
      if (m) createdUtc = parseUtc(m[0])
      continue
    }
    if (lower.startsWith('ephemeris_start')) {
      if (/\butc\b/i.test(line)) sawUtcMarker = true
      const times = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?/g)
      if (times?.[0]) startUtc = parseUtc(times[0])
      if (times?.[1]) stopUtc = parseUtc(times[1])
      const ms = /step_size\s*:\s*([\d.]+)/i.exec(line)
      if (ms) stepSec = Number(ms[1])
      continue
    }
    if (lower.startsWith('ephemeris_source')) continue

    if (KNOWN_FRAMES.has(line.toUpperCase())) {
      covFrame = line.toUpperCase() === 'ECI' ? 'EME2000' : line.toUpperCase()
      continue
    }

    const tokens = line.split(/\s+/)
    if (EPOCH_RE.test(tokens[0])) {
      flush()
      if (tokens.length < 7) throw new Error(`第 ${ln} 行状态分量不足 7 列（历元 + 位置 + 速度）`)
      const epoch = parseItcEpoch(tokens[0])
      if (!epoch) throw new Error(`第 ${ln} 行历元无法解析：${tokens[0]}`)
      const comps = tokens.slice(1, 7)
      if (!comps.every((c) => NUM_RE.test(c))) throw new Error(`第 ${ln} 行存在非法数字分量`)
      const nums = comps.map(Number)
      if (!nums.every((n) => Number.isFinite(n))) throw new Error(`第 ${ln} 行存在非有限数值`)
      const prev = t.length ? t[t.length - 1] : null
      if (prev !== null && epoch.getTime() <= prev) {
        throw new Error(`第 ${ln} 行时间戳非递增（${tokens[0]}）`)
      }
      t.push(epoch.getTime())
      r.push(nums[0], nums[1], nums[2])
      v.push(nums[3], nums[4], nums[5])
      accLine = ln
      continue
    }

    if (tokens.every((c) => NUM_RE.test(c))) {
      if (t.length === 0) {
        warnings.push(`第 ${ln} 行的数字没有归属的状态，已忽略`)
        continue
      }
      for (const c of tokens) accNums.push(Number(c))
      continue
    }
    // 其它未知行忽略
  }
  flush()

  if (t.length < 2) throw new Error('有效状态点少于 2 个，无法用于插值')
  if (!sawUtcMarker) throw new Error('头信息未声明 UTC 时间系统，按异常文件跳过')

  let step = stepSec
  if (!(step > 0) && t.length >= 2) {
    const diffs: number[] = []
    for (let i = 1; i < t.length; i++) diffs.push((t[i] - t[i - 1]) / 1000)
    diffs.sort((a, b) => a - b)
    step = diffs[Math.floor(diffs.length / 2)] ?? 0
  }

  const hasCov = covSeen === t.length && !covBroken && cov21.length === t.length * 21
  if (!hasCov && covSeen > 0) {
    warnings.push(`协方差点数（${covSeen}）与状态点数（${t.length}）不一致，已整体丢弃协方差`)
  }

  return {
    t,
    r,
    v,
    cov21: hasCov ? cov21 : null,
    createdUtc,
    startUtc: startUtc ?? new Date(t[0]),
    stopUtc: stopUtc ?? new Date(t[t.length - 1]),
    stepSec: Math.round(step),
    // ITC 状态向量是 MEME J2000（头信息未声明，按官方格式约定）
    frame: 'EME2000',
    covFrame,
    warnings
  }
}
