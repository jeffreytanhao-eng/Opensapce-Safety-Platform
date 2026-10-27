import type { EphemFrame, Vec3 } from './types'
import { EARTH_OMEGA, gmstRad, julianDate } from './time'

function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2])
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}

/**
 * 计算 UVW（= RSW/RTN）基，返回 3x3 行主序矩阵：
 * 第 0 行 U = r̂，第 1 行 V = Ŵ × Û，第 2 行 W = (r×v)/|r×v|。
 */
export function uvwBasis(r: Vec3, v: Vec3): number[][] {
  const rn = norm3(r) || 1
  const u: Vec3 = [r[0] / rn, r[1] / rn, r[2] / rn]
  const h = cross(r, v)
  const hn = norm3(h)
  let w: Vec3
  if (hn < 1e-12) {
    // 退化情形：速度与位置共线，随便取一个正交方向
    w = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const d = u[0] * w[0] + u[1] * w[1] + u[2] * w[2]
    w = [w[0] - d * u[0], w[1] - d * u[1], w[2] - d * u[2]]
    const wn2 = norm3(w) || 1
    w = [w[0] / wn2, w[1] / wn2, w[2] / wn2]
  } else {
    w = [h[0] / hn, h[1] / hn, h[2] / hn]
  }
  const vv = cross(w, u)
  return [
    [u[0], u[1], u[2]],
    [vv[0], vv[1], vv[2]],
    [w[0], w[1], w[2]]
  ]
}

/**
 * 用 3x3 旋转矩阵 m 左右夹乘 6x6 协方差（位置块与速度块分别旋转）：
 * out = M · C · Mᵀ，其中 M = blockdiag(m, m)。
 */
export function rotateCov6(cov: Float64Array, m: number[][]): Float64Array {
  const out = new Float64Array(36)
  for (let bi = 0; bi < 2; bi++) {
    for (let bj = 0; bj < 2; bj++) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let s = 0
          for (let k = 0; k < 3; k++) {
            for (let l = 0; l < 3; l++) {
              s += m[i][k] * cov[(bi * 3 + k) * 6 + (bj * 3 + l)] * m[j][l]
            }
          }
          out[(bi * 3 + i) * 6 + (bj * 3 + j)] = s
        }
      }
    }
  }
  return out
}

/**
 * UVW（RTN）协方差 → ECI 协方差。
 * 基矩阵 B 的行为 U/V/W，则坐标变换矩阵为 Bᵀ，故 cov_eci = Bᵀ · cov_uvw · B。
 */
export function uvwCovToEci(cov: Float64Array, r: Vec3, v: Vec3): Float64Array {
  const b = uvwBasis(r, v)
  const t = [
    [b[0][0], b[1][0], b[2][0]],
    [b[0][1], b[1][1], b[2][1]],
    [b[0][2], b[1][2], b[2][2]]
  ]
  return rotateCov6(cov, t)
}

/**
 * ITRF/ECEF → ECI：绕 Z 轴旋转 GMST，速度再补上 ω×r 的牵连项。
 */
export function itrfToEci(r: Vec3, v: Vec3, epochMs: number): { r: Vec3; v: Vec3 } {
  const th = gmstRad(epochMs)
  const c = Math.cos(th)
  const s = Math.sin(th)
  const re: Vec3 = [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]]
  const ve: Vec3 = [
    c * v[0] - s * v[1] - EARTH_OMEGA * re[1],
    s * v[0] + c * v[1] + EARTH_OMEGA * re[0],
    v[2]
  ]
  return { r: re, v: ve }
}

/**
 * 把任意参考系下的状态统一到 J2000（EME2000）惯性系。
 * - TEME：SGP4 原生输出，与 J2000 存在岁差 + 章动造成的绕轴旋转（2020s 约 8~45 km 量级），
 *   必须走 temeToJ2000，不能直接当同一系使用；
 * - ITRF：先按 GMST 转到 TEME，再转 J2000；
 * - UVW / EME2000 / ICRF：已是（近）J2000 惯性系，直接返回。
 */
export function frameToEci(
  frame: EphemFrame,
  r: Vec3,
  v: Vec3,
  epochMs: number
): { r: Vec3; v: Vec3 } {
  if (frame === 'ITRF') {
    const t = itrfToEci(r, v, epochMs)
    return temeToJ2000(t.r, t.v, epochMs)
  }
  if (frame === 'TEME') return temeToJ2000(r, v, epochMs)
  return { r: [r[0], r[1], r[2]], v: [v[0], v[1], v[2]] }
}

/* ============================================================
 * TEME ↔ J2000（IAU-76 岁差 + IAU-80 章动 4 主要项）
 * ------------------------------------------------------------
 * TEME 是 SGP4 的天然输出系（真赤道 / 平春分点 of date），J2000 是星历文件
 * （EME2000/ICRF）的惯性系。二者相差岁差与章动：速率约 50.3″/年，2020s
 * 对应位置偏移 8~45 km —— 在 200 km 报告门限下不可忽略，故所有
 * 「距离 / Pc / 协方差」统一在 J2000 计算。
 * ============================================================ */

/** 3x3 矩阵（行主序，行向量语义） */
type Mat3 = [Vec3, Vec3, Vec3]

const ARCSEC_RAD = Math.PI / (180 * 3600)

/** 矩阵乘向量：out = M·v */
function mulMat(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
  ]
}

/** 转置乘向量：out = Mᵀ·v */
function mulMatT(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]
  ]
}

/** 矩阵乘矩阵：out = A·B */
function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]
    }
  }
  return out
}

/** 绕 X 轴旋转 */
function rotX(th: number): Mat3 {
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c]
  ]
}

/** 绕 Y 轴旋转 */
function rotY(th: number): Mat3 {
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [c, 0, -s],
    [0, 1, 0],
    [s, 0, c]
  ]
}

/** 绕 Z 轴旋转 */
function rotZ(th: number): Mat3 {
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1]
  ]
}

/** 儒略世纪数（自 J2000.0） */
function centuriesSinceJ2000(utcMs: number): number {
  return (julianDate(utcMs) - 2451545.0) / 36525
}

/**
 * J2000 → 瞬时真赤道真春分点（TOD）的旋转矩阵：
 *   M = N · P，P 为 IAU-76 岁差，N 为 IAU-80 章动（取 4 个主项）。
 * TEME 与 TOD 只差春分点方程（约 1″ 内），本项目按 TOD 处理（位置误差 < 1 km）。
 */
function j2000ToTod(utcMs: number): Mat3 {
  const t = centuriesSinceJ2000(utcMs)
  const t2 = t * t
  const t3 = t2 * t

  // ---- IAU-76 岁差（角秒）----
  const zeta = (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) * ARCSEC_RAD
  const zed = (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) * ARCSEC_RAD
  const theta = (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) * ARCSEC_RAD
  // 平赤道平春分点 of date → 真赤道真春分点 of date：P = Rz(-z)·Ry(θ)·Rz(-ζ)
  const precession = mulMat3(mulMat3(rotZ(-zed), rotY(theta)), rotZ(-zeta))

  // ---- IAU-80 章动（4 个主项，单位 1e-4 角秒）----
  const deg = Math.PI / 180
  const l = (134.96298 + 477198.867398 * t + 0.0086972 * t2) * deg // 月球平近点角
  const lp = (357.52772 + 35999.050340 * t - 0.0001603 * t2) * deg // 太阳平近点角
  const f = (93.27191 + 483202.017538 * t - 0.0036825 * t2) * deg // 月球纬度参数
  const d = (297.85036 + 445267.111480 * t - 0.0019142 * t2) * deg // 日月平距角
  const om = (125.04452 - 1934.136261 * t + 0.0020708 * t2) * deg // 月球升交点黄经

  // 每项：[l, l', F, D, Ω, Δψ(0.0001″), Δψ 速率, Δε(0.0001″), Δε 速率]
  const NUT_TERMS: [number, number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5]
  ]
  let dPsi = 0
  let dEps = 0
  for (const [cl, clp, cf, cd, com, psi0, psi1, eps0, eps1] of NUT_TERMS) {
    const arg = cl * l + clp * lp + cf * f + cd * d + com * om
    dPsi += (psi0 + psi1 * t) * Math.sin(arg)
    dEps += (eps0 + eps1 * t) * Math.cos(arg)
  }
  // 平黄赤交角（角秒）
  const epsMean = (84381.448 - 46.8150 * t - 0.00059 * t2 + 0.001813 * t3) * ARCSEC_RAD
  const dpsi = dPsi * 1e-4 * ARCSEC_RAD
  const deps = dEps * 1e-4 * ARCSEC_RAD
  // 平赤道 → 真赤道：N = Rx(-ε-Δε)·Rz(-Δψ)·Rx(ε)
  const nutation = mulMat3(mulMat3(rotX(-(epsMean + deps)), rotZ(-dpsi)), rotX(epsMean))

  return mulMat3(nutation, precession)
}

/** TEME（按 TOD 处理）→ J2000 */
export function temeToJ2000(r: Vec3, v: Vec3, utcMs: number): { r: Vec3; v: Vec3 } {
  const m = j2000ToTod(utcMs)
  return { r: mulMatT(m, r), v: mulMatT(m, v) }
}

/** J2000 → TEME（按 TOD 处理） */
export function j2000ToTeme(r: Vec3, v: Vec3, utcMs: number): { r: Vec3; v: Vec3 } {
  const m = j2000ToTod(utcMs)
  return { r: mulMat(m, r), v: mulMat(m, v) }
}
