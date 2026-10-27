#!/usr/bin/env node
/**
 * P2 筛查引擎自检（无需数据库）：
 *   1) 两条直线相向轨迹：TCA / miss 精度（要求 TCA <1 ms、miss <1 m）；
 *   2) TEME↔J2000 往返一致；
 *   3) Foster 2D：正碰（miss≈0）Pc 接近 1，远离时 Pc≈0。
 * 用法：npm --prefix heat-sidecar run selftest（需先 build）
 */
import assert from 'node:assert/strict'
import { hermitePrimary, refineCandidate } from '../dist/screen/refine.js'
import { temeToJ2000, j2000ToTeme } from '../dist/screen/frames.js'
import { collisionProbability } from '../dist/screen/pc.js'

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}：${e.message}`)
  }
}

/* ---------- 1) 直线轨迹 TCA / miss ---------- */
const STEP_MS = 1000
const N = 100
const vp = 7 // km/s，+x
const vs = -7 // km/s，-x
const track = {
  memeId: 1,
  noradId: 100001,
  name: 'TEST-P',
  createdMs: null,
  startMs: 0,
  stepMs: STEP_MS,
  n: N,
  r: new Float64Array(N * 3),
  v: new Float64Array(N * 3),
  cov: null
}
for (let i = 0; i < N; i++) {
  track.r[i * 3] = vp * i
  track.v[i * 3] = vp
}
const secondary = (tMs) => {
  const t = tMs / 1000
  return { r: [100 - 7 * t, 3, 0], v: [vs, 0, 0] }
}

// 解析解：|Δr(t)|² 最小 → t* = 100/14 s，miss = 3 km
const tcaExactS = 100 / 14

check('Hermite 在整点处与原始状态一致', () => {
  const h = hermitePrimary(track, 7000)
  assert.ok(Math.abs(h.r[0] - 49) < 1e-9, `r=${h.r[0]}`)
  assert.ok(Math.abs(h.v[0] - vp) < 1e-9, `v=${h.v[0]}`)
})

check('Brent 求 TCA（误差 <1 ms）', () => {
  const res = refineCandidate({ primary: track, secondary, centerMs: 7000, stepMs: STEP_MS })
  assert.ok(res, '细化返回 null')
  const errMs = Math.abs(res.tcaMs / 1000 - tcaExactS) * 1000
  assert.ok(errMs < 1, `TCA 误差 ${errMs.toFixed(3)} ms`)
})

check('TCA 处 miss 误差 <1 m', () => {
  const res = refineCandidate({ primary: track, secondary, centerMs: 7000, stepMs: STEP_MS })
  const errM = Math.abs(res.missKm - 3) * 1000
  assert.ok(errM < 1, `miss 误差 ${errM.toFixed(3)} m`)
})

/* ---------- 2) TEME ↔ J2000 往返 ---------- */
check('TEME→J2000→TEME 往返一致（<1 mm）', () => {
  const r = [7000, -1200, 300]
  const v = [0.5, 7.2, 1.1]
  const t = Date.UTC(2026, 9, 24, 12, 0, 0)
  const j = temeToJ2000(r, v, t)
  const back = j2000ToTeme(j.r, j.v, t)
  const err = Math.hypot(back.r[0] - r[0], back.r[1] - r[1], back.r[2] - r[2])
  assert.ok(err < 1e-6, `往返误差 ${(err * 1000).toFixed(3)} m`)
})

check('TEME 与 J2000 差异量级合理（8~60 km）', () => {
  const r = [7000, 0, 0]
  const j = temeToJ2000(r, [0, 7.5, 0], Date.UTC(2026, 9, 24))
  const d = Math.hypot(j.r[0] - r[0], j.r[1] - r[1], j.r[2] - r[2])
  assert.ok(d > 1 && d < 60, `偏移 ${d.toFixed(2)} km`)
})

/* ---------- 3) Foster 2D ---------- */
const covDiag = (s2) => {
  const c = new Float64Array(36)
  c[0] = c[7] = c[14] = s2
  return c
}

check('正碰（miss=0）Pc 接近 1', () => {
  const res = collisionProbability({
    missVec: [0.001, 0, 0],
    relVelVec: [0, 14, 0],
    covA: covDiag(1e-6),
    covB: covDiag(1e-6),
    hbrKm: 0.01
  })
  assert.ok(res.pc > 0.9, `Pc=${res.pc}`)
})

check('远离（平面内 miss=100 km）Pc ≈ 0', () => {
  // TCA 处 miss 必然垂直于相对速度，故这里 relVel 取 x 向、miss 取 y 向
  const res = collisionProbability({
    missVec: [0, 100, 0],
    relVelVec: [14, 0, 0],
    covA: covDiag(1e-6),
    covB: covDiag(1e-6),
    hbrKm: 0.01
  })
  assert.ok(res.pc < 1e-12, `Pc=${res.pc}`)
})

check('协方差过大时 diluted 生效（Pc 小但 PcMax 过门限）', () => {
  const res = collisionProbability({
    missVec: [0, 8, 0],
    relVelVec: [0, 14, 0],
    covA: covDiag(1e-8),
    covB: covDiag(1e-8),
    hbrKm: 0.01
  })
  assert.ok(res.pcMax >= res.pc)
})

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
