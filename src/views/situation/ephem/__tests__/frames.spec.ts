import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { j2000ToTeme, temeToJ2000 } from '../frames'
import type { Vec3 } from '../types'

/**
 * TEME ↔ J2000 转换校验（样本取 public/ephemeris-samples/38124.json 的首个历元，
 * 该文件为 ITC/EME2000，可视为 J2000）。
 */
const sample = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public/ephemeris-samples/38124.json'), 'utf8')
) as { states: number[][] }

const row = sample.states[0]
const t = row[0]
const r: Vec3 = [row[1], row[2], row[3]]
const v: Vec3 = [row[4], row[5], row[6]]

describe('frames: TEME ↔ J2000', () => {
  it('J2000 → TEME → J2000 往返误差 < 1e-6 km', () => {
    const teme = j2000ToTeme(r, v, t)
    const back = temeToJ2000(teme.r, teme.v, t)
    const err = Math.hypot(back.r[0] - r[0], back.r[1] - r[1], back.r[2] - r[2])
    expect(err).toBeLessThan(1e-6)
  })

  it('J2000 与 TEME 的位置差在 8~45 km（岁差 + 章动量级）', () => {
    const teme = j2000ToTeme(r, v, t)
    const delta = Math.hypot(teme.r[0] - r[0], teme.r[1] - r[1], teme.r[2] - r[2])
    expect(delta).toBeGreaterThan(8)
    expect(delta).toBeLessThan(45)
  })
})
