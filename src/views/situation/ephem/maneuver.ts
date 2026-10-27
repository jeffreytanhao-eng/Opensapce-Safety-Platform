import type { EphemState, Vec3 } from './types'
import { interpolateAt } from './interp'

/* ------------------------------------------------------------------
 * 二体推进（原 screening.ts 剥离而来，03 §15.2：浏览器不再做威胁筛选）
 * 机动只改速度：用「原状态 / 加速后状态」两套二体推进之差叠加到星历上，
 * 保留星历自身精度，同时让机动后的轨迹真实偏离。
 * ---------------------------------------------------------------- */
const MU = 398600.4418

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function norm3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

interface Orbit {
  a: number
  e: number
  b: number
  n: number
  P: Vec3
  Q: Vec3
  M0: number
  ok: boolean
}

function buildOrbit(r: Vec3, v: Vec3): Orbit {
  const bad: Orbit = { a: NaN, e: NaN, b: NaN, n: NaN, P: [1, 0, 0], Q: [0, 1, 0], M0: 0, ok: false }
  const rn = norm3(r)
  const v2 = dot(v, v)
  if (!(rn > 0) || !(v2 > 0)) return bad
  const a = 1 / (2 / rn - v2 / MU)
  if (!(a > 0) || !Number.isFinite(a)) return bad
  const h = cross(r, v)
  const hn = norm3(h)
  if (!(hn > 0)) return bad
  const rv = dot(r, v)
  const eVec: Vec3 = [
    ((v2 - MU / rn) * r[0] - rv * v[0]) / MU,
    ((v2 - MU / rn) * r[1] - rv * v[1]) / MU,
    ((v2 - MU / rn) * r[2] - rv * v[2]) / MU
  ]
  const e = norm3(eVec)
  if (!(e < 1)) return bad
  const P: Vec3 = e > 1e-8
    ? [eVec[0] / e, eVec[1] / e, eVec[2] / e]
    : [r[0] / rn, r[1] / rn, r[2] / rn]
  const W: Vec3 = [h[0] / hn, h[1] / hn, h[2] / hn]
  const Q: Vec3 = [W[1] * P[2] - W[2] * P[1], W[2] * P[0] - W[0] * P[2], W[0] * P[1] - W[1] * P[0]]
  const b = a * Math.sqrt(1 - e * e)
  const x0 = dot(r, P)
  const y0 = dot(r, Q)
  const E0 = Math.atan2(y0 / b, x0 / a + e)
  return { a, e, b, n: Math.sqrt(MU / (a * a * a)), P, Q, M0: E0 - e * Math.sin(E0), ok: true }
}

function orbitStateAt(o: Orbit, dtSec: number, outR: Vec3, outV: Vec3): void {
  const twoPi = Math.PI * 2
  let M = (o.M0 + o.n * dtSec) % twoPi
  if (M < 0) M += twoPi
  let E = M + o.e * Math.sin(M)
  for (let i = 0; i < 6; i++) {
    const d = (E - o.e * Math.sin(E) - M) / (1 - o.e * Math.cos(E))
    E -= d
    if (Math.abs(d) < 1e-10) break
  }
  const sinE = Math.sin(E)
  const cosE = Math.cos(E)
  const x = o.a * (cosE - o.e)
  const y = o.b * sinE
  const Edot = o.n / (1 - o.e * cosE)
  const vx = -o.a * sinE * Edot
  const vy = o.b * cosE * Edot
  outR[0] = o.P[0] * x + o.Q[0] * y
  outR[1] = o.P[1] * x + o.Q[1] * y
  outR[2] = o.P[2] * x + o.Q[2] * y
  outV[0] = o.P[0] * vx + o.Q[0] * vy
  outV[1] = o.P[1] * vx + o.Q[1] * vy
  outV[2] = o.P[2] * vx + o.Q[2] * vy
}

function twoBodyPropagate(r: Vec3, v: Vec3, dtSec: number): { r: Vec3; v: Vec3 } | null {
  const orb = buildOrbit(r, v)
  if (!orb.ok) return null
  const rr: Vec3 = [0, 0, 0]
  const vv: Vec3 = [0, 0, 0]
  orbitStateAt(orb, dtSec, rr, vv)
  return { r: rr, v: vv }
}

/** 由状态构造 RTN 基：R = r̂，N = (r×v)/|r×v|，T = N×R */
function rtnBasis(r: Vec3, v: Vec3): { R: Vec3; T: Vec3; N: Vec3 } {
  const rn = Math.hypot(r[0], r[1], r[2]) || 1
  const R: Vec3 = [r[0] / rn, r[1] / rn, r[2] / rn]
  const hx = r[1] * v[2] - r[2] * v[1]
  const hy = r[2] * v[0] - r[0] * v[2]
  const hz = r[0] * v[1] - r[1] * v[0]
  const hn = Math.hypot(hx, hy, hz) || 1
  const N: Vec3 = [hx / hn, hy / hn, hz / hn]
  const T: Vec3 = [
    N[1] * R[2] - N[2] * R[1],
    N[2] * R[0] - N[0] * R[2],
    N[0] * R[1] - N[1] * R[0]
  ]
  return { R, T, N }
}

function cloneState(st: EphemState): EphemState {
  const out: EphemState = { t: st.t, r: [st.r[0], st.r[1], st.r[2]], v: [st.v[0], st.v[1], st.v[2]] }
  if (st.cov) out.cov = new Float64Array(st.cov)
  return out
}

/**
 * 脉冲机动：在 atMs 处按 RTN 基施加 Δv（单位 m/s，分量顺序 [R, T, N]）。
 *
 * 位置增量用「二体差传播」估计：分别从机动时刻的原始状态与加速后状态做二体推进，
 * 把两者之差叠加到原星历上。这样既保留星历本身的绝对精度（J2、大气等摄动都在星历里），
 * 又能让机动后的轨迹真实偏离（只改速度不推位置的话，24 小时内位置几乎不动）。
 */
export function applyImpulse(states: EphemState[], atMs: number, dvRtn: Vec3): EphemState[] {
  const out = states.map(cloneState)
  const s = interpolateAt(states, atMs)
  if (!s) return out
  const { R, T, N } = rtnBasis(s.r, s.v)
  const dR = dvRtn[0] / 1000
  const dT = dvRtn[1] / 1000
  const dN = dvRtn[2] / 1000
  const dv: Vec3 = [
    R[0] * dR + T[0] * dT + N[0] * dN,
    R[1] * dR + T[1] * dT + N[1] * dN,
    R[2] * dR + T[2] * dT + N[2] * dN
  ]
  const vNew: Vec3 = [s.v[0] + dv[0], s.v[1] + dv[1], s.v[2] + dv[2]]
  for (const st of out) {
    if (st.t < atMs) continue
    const dtSec = (st.t - atMs) / 1000
    const ref = dtSec > 0 ? twoBodyPropagate(s.r, s.v, dtSec) : null
    const man = dtSec > 0 ? twoBodyPropagate(s.r, vNew, dtSec) : null
    if (ref && man) {
      // 机动后的位置 / 速度 = 原星历 + 二体差传播增量
      st.r = [st.r[0] + man.r[0] - ref.r[0], st.r[1] + man.r[1] - ref.r[1], st.r[2] + man.r[2] - ref.r[2]]
      st.v = [st.v[0] + man.v[0] - ref.v[0], st.v[1] + man.v[1] - ref.v[1], st.v[2] + man.v[2] - ref.v[2]]
    } else {
      st.v = [st.v[0] + dv[0], st.v[1] + dv[1], st.v[2] + dv[2]]
    }
  }
  return out
}

/** 沿单一方向（T/R/N）按步长枚举 Δv，生成候选机动星历 */
export function maneuverGrid(
  states: EphemState[],
  atMs: number,
  dir: 'T' | 'R' | 'N',
  fromMps: number,
  toMps: number,
  stepMps: number
): { dvMps: number; states: EphemState[] }[] {
  const out: { dvMps: number; states: EphemState[] }[] = []
  if (!(stepMps > 0) || !Number.isFinite(fromMps) || !Number.isFinite(toMps)) return out
  const lo = Math.min(fromMps, toMps)
  const hi = Math.max(fromMps, toMps)
  const maxCount = 1000
  let count = 0
  for (let dv = lo; dv <= hi + 1e-9 && count < maxCount; dv += stepMps, count++) {
    const vec: Vec3 = dir === 'R' ? [dv, 0, 0] : dir === 'T' ? [0, dv, 0] : [0, 0, dv]
    out.push({ dvMps: dv, states: applyImpulse(states, atMs, vec) })
  }
  return out
}
