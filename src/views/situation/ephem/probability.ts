/**
 * 碰撞概率 Pc（Foster 2D 交会平面法 + Alfano 协方差缩放得 PcMax）。
 *
 * 模型：
 * 1) 交会平面法向 n = v_rel/|v_rel|（相对速度方向）；
 * 2) 平面内 x̂ 取相对位置（miss）在该平面内的方向，ŷ = n×x̂；
 * 3) 双方位置协方差相加并按 [x̂,ŷ] 投影为 2×2 矩阵 C2；
 * 4) Pc = 二维高斯 N(miss₂, C2) 在半径 R（联合硬体半径）圆盘上的积分，
 *    极坐标 Gauss–Legendre 64×64 数值积分。
 *
 * PcMax（数据不足判据）：Foster 的 Pc 对协方差尺度极敏感。按 Alfano 做法把
 * C2 按对数网格 [1e-3, 1e2] 缩放并取 Pc 最大值——Pc 很小但 PcMax 已过危险门限，
 * 说明当前协方差给不出可信结论（`diluted`）。
 *
 * 注意：**不再有「缺协方差用经验 σ 兜底」**，协方差由调用方必传（TLE 侧的龄期
 * σ 模型在 screening.ts 里构造），否则 Pc 没有物理意义。
 */
import type { Vec3 } from './types'

/** 二维矩阵（行主序） */
interface Mat2 {
  c11: number
  c12: number
  c22: number
}

export interface CollisionProbabilityInput {
  /** TCA 处相对位置矢量（J2000，km）：对方 − 本星 */
  missVec: Vec3
  /** TCA 处相对速度矢量（J2000，km/s）：对方 − 本星 */
  relVelVec: Vec3
  /** 本星 6x6 协方差（J2000，km² / km²·s⁻¹…），取位置块 */
  covA: Float64Array
  /** 对方 6x6 协方差（J2000），取位置块 */
  covB: Float64Array
  /** 联合硬体半径（km） */
  hbrKm: number
}

export interface CollisionProbabilityResult {
  /** 当前协方差下的碰撞概率 */
  pc: number
  /** Alfano 缩放网格下的最大 Pc */
  pcMax: number
  /** 当前 Pc 低于危险门限、但 PcMax 已达危险门限（协方差尺度不确定 → 数据不足） */
  diluted: boolean
}

/** 危险门限（与 heat/riskLevels.ts 的高危档一致） */
const DANGER_PC = 1e-4

/* ---------------- Gauss–Legendre 节点（64 点，惰性缓存） ---------------- */

let glCache: { x: number[]; w: number[] } | null = null

function gaussLegendre64(): { x: number[]; w: number[] } {
  if (glCache) return glCache
  const n = 64
  const x = new Array<number>(n)
  const w = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    // 初值用三角近似，再用牛顿法解 P_n(z)=0
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5))
    let pp = 0
    for (let it = 0; it < 100; it++) {
      let p1 = 1
      let p2 = 0
      for (let j = 0; j < n; j++) {
        const p3 = p2
        p2 = p1
        p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1)
      }
      pp = (n * (z * p1 - p2)) / (z * z - 1)
      const z1 = z
      z = z1 - p1 / pp
      if (Math.abs(z - z1) < 1e-15) break
    }
    x[i] = z
    w[i] = 2 / ((1 - z * z) * pp * pp)
  }
  glCache = { x, w }
  return glCache
}

/* ---------------- 基础线性代数 ---------------- */

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

/** 取 6x6 协方差的 3x3 位置块（行主序，长度 9） */
function positionBlock(cov: Float64Array): number[] | null {
  if (!cov || cov.length < 36) return null
  const out = [cov[0], cov[1], cov[2], cov[6], cov[7], cov[8], cov[12], cov[13], cov[14]]
  return out.every((x) => Number.isFinite(x)) ? out : null
}

/* ---------------- 核心：圆盘上的二维高斯积分 ---------------- */

/**
 * 二维高斯 N(m, C) 在半径 R 圆盘上的积分（极坐标 GL 64×64）。
 * 极坐标原点取圆盘中心，故 m 需转到以圆盘中心为原点的平面坐标。
 */
function diskGaussIntegral(mx: number, my: number, c: Mat2, radiusKm: number): number {
  if (!(radiusKm > 0)) return 0
  const det = c.c11 * c.c22 - c.c12 * c.c12
  if (!(det > 0) || !Number.isFinite(det)) return 0
  const inv11 = c.c22 / det
  const inv12 = -c.c12 / det
  const inv22 = c.c11 / det
  if (![inv11, inv12, inv22].every((x) => Number.isFinite(x))) return 0

  const { x: gx, w: gw } = gaussLegendre64()
  // 径向 [0, R]：r = R/2·(ξ+1)，dr = R/2·dξ；角向 [0, 2π]：θ = π·(ξ+1)，dθ = π·dξ
  const halfR = radiusKm / 2
  let sum = 0
  for (let i = 0; i < gx.length; i++) {
    const r = halfR * (gx[i] + 1)
    const wr = halfR * gw[i]
    for (let j = 0; j < gx.length; j++) {
      const th = Math.PI * (gx[j] + 1)
      const wth = Math.PI * gw[j]
      const dx = r * Math.cos(th) - mx
      const dy = r * Math.sin(th) - my
      const expo = -0.5 * (inv11 * dx * dx + 2 * inv12 * dx * dy + inv22 * dy * dy)
      if (expo < -700) continue // 下溢剪枝
      sum += wr * wth * r * Math.exp(expo)
    }
  }
  const pdf = sum / (2 * Math.PI * Math.sqrt(det))
  return Number.isFinite(pdf) ? Math.min(1, Math.max(0, pdf)) : 0
}

/** 给定协方差缩放系数 k，返回 Pc（C2 乘 k） */
function pcWithScale(k: number, mx: number, my: number, c: Mat2, radiusKm: number): number {
  return diskGaussIntegral(mx, my, { c11: c.c11 * k, c12: c.c12 * k, c22: c.c22 * k }, radiusKm)
}

/** Alfano 缩放网格：对数 48 点，[1e-3, 1e2] */
const SCALE_MIN = 1e-3
const SCALE_MAX = 1e2
const SCALE_N = 48

/* ---------------- 对外接口 ---------------- */

/**
 * Foster 2D 碰撞概率。
 * 无效输入（相对速度为 0、协方差缺失或不正定、硬体半径 ≤ 0）一律返回全 0。
 */
export function collisionProbability(input: CollisionProbabilityInput): CollisionProbabilityResult {
  const zero: CollisionProbabilityResult = { pc: 0, pcMax: 0, diluted: false }
  const { missVec, relVelVec, covA, covB, hbrKm } = input
  if (!(hbrKm > 0)) return zero
  if (![missVec[0], missVec[1], missVec[2], relVelVec[0], relVelVec[1], relVelVec[2]].every((x) => Number.isFinite(x))) {
    return zero
  }
  const vn = norm3(relVelVec)
  if (!(vn > 1e-9)) return zero

  const pa = positionBlock(covA)
  const pb = positionBlock(covB)
  if (!pa || !pb) return zero

  // 交会平面：n = 相对速度方向，x̂ = miss 在平面内投影方向，ŷ = n×x̂
  const n: Vec3 = [relVelVec[0] / vn, relVelVec[1] / vn, relVelVec[2] / vn]
  const md = dot(missVec, n)
  let xh: Vec3 = [missVec[0] - md * n[0], missVec[1] - md * n[1], missVec[2] - md * n[2]]
  let xn = norm3(xh)
  if (!(xn > 1e-9)) {
    // miss 与相对速度平行（正碰）：任取一个与 n 垂直的方向
    const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const d0 = dot(ref, n)
    xh = [ref[0] - d0 * n[0], ref[1] - d0 * n[1], ref[2] - d0 * n[2]]
    xn = norm3(xh)
    if (!(xn > 1e-12)) return zero
  }
  xh = [xh[0] / xn, xh[1] / xn, xh[2] / xn]
  const yh = cross(n, xh)

  // C2 = Bᵀ(Ca+Cb)B，B = [x̂, ŷ]
  const c = new Array<number>(9)
  for (let i = 0; i < 9; i++) c[i] = pa[i] + pb[i]
  // 位置块对称化（外部协方差可能有微小非对称）
  c[1] = c[3] = (c[1] + c[3]) / 2
  c[2] = c[6] = (c[2] + c[6]) / 2
  c[5] = c[7] = (c[5] + c[7]) / 2
  const proj = (u: Vec3, v: Vec3): number =>
    u[0] * (c[0] * v[0] + c[1] * v[1] + c[2] * v[2]) +
    u[1] * (c[3] * v[0] + c[4] * v[1] + c[5] * v[2]) +
    u[2] * (c[6] * v[0] + c[7] * v[1] + c[8] * v[2])
  const c2: Mat2 = { c11: proj(xh, xh), c12: proj(xh, yh), c22: proj(yh, yh) }

  const mx = dot(missVec, xh)
  const my = dot(missVec, yh)

  const pc = pcWithScale(1, mx, my, c2, hbrKm)
  let pcMax = pc
  const logMin = Math.log10(SCALE_MIN)
  const logStep = (Math.log10(SCALE_MAX) - logMin) / (SCALE_N - 1)
  for (let i = 0; i < SCALE_N; i++) {
    const k = 10 ** (logMin + i * logStep)
    const v = pcWithScale(k, mx, my, c2, hbrKm)
    if (v > pcMax) pcMax = v
  }

  return { pc, pcMax, diluted: pcMax >= DANGER_PC && pc < DANGER_PC }
}
