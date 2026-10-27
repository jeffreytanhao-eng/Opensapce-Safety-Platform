import { describe, expect, it } from 'vitest'
import { collisionProbability } from '../probability'
import type { Vec3 } from '../types'

/**
 * Foster 2D 碰撞概率校验：
 * 组合协方差 σ = 1 km（本星 1 km²，对方取 0），HBR = 10 m。
 * 小硬体近似下 Pc ≈ R²/(2σ²)·exp(-m²/(2σ²))：
 *   miss = 0   → 5.0e-5
 *   miss = 1km → 3.03e-5
 */
function covDiag(sigmaKm: number): Float64Array {
  const c = new Float64Array(36)
  c[0] = sigmaKm * sigmaKm
  c[7] = sigmaKm * sigmaKm
  c[14] = sigmaKm * sigmaKm
  return c
}

const relVel: Vec3 = [0, 7.5, 0]
const hbrKm = 0.01
const covA = covDiag(1)
const covB = new Float64Array(36)

describe('probability: Foster 2D', () => {
  it('miss = 0 → Pc ≈ 5.0e-5（±1%）', () => {
    const { pc } = collisionProbability({
      missVec: [0, 0, 0],
      relVelVec: relVel,
      covA,
      covB,
      hbrKm
    })
    expect(pc).toBeGreaterThan(5.0e-5 * 0.99)
    expect(pc).toBeLessThan(5.0e-5 * 1.01)
  })

  it('miss = 1 km → Pc ≈ 3.03e-5（±2%）', () => {
    const { pc } = collisionProbability({
      missVec: [1, 0, 0],
      relVelVec: relVel,
      covA,
      covB,
      hbrKm
    })
    expect(pc).toBeGreaterThan(3.0327e-5 * 0.98)
    expect(pc).toBeLessThan(3.0327e-5 * 1.02)
  })

  it('PcMax ≥ Pc，且低 Pc 时按协方差缩放给出数据不足判断', () => {
    const res = collisionProbability({
      missVec: [1, 0, 0],
      relVelVec: relVel,
      covA,
      covB,
      hbrKm
    })
    expect(res.pcMax).toBeGreaterThanOrEqual(res.pc)
    expect(res.diluted).toBe(false)
  })

  it('相对速度为 0 时返回 0', () => {
    const res = collisionProbability({
      missVec: [0, 0, 0],
      relVelVec: [0, 0, 0],
      covA,
      covB,
      hbrKm
    })
    expect(res.pc).toBe(0)
    expect(res.pcMax).toBe(0)
  })
})
