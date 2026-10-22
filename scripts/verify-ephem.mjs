#!/usr/bin/env node
/**
 * 星历内核自检脚本（不依赖网络）。
 *
 * 做法：用项目自带的 typescript 把 src/views/situation/ephem/*.ts 转译到临时目录，
 * 再以 ESM 方式动态 import，从而直接验证纯 TS 内核。
 *
 * 运行：node scripts/verify-ephem.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(ROOT, 'src', 'views', 'situation', 'ephem')

const pass = []
const fail = []

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

function near(actual, expected, tol, msg) {
  if (!Number.isFinite(actual) || !(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg}：实际 ${actual}，期望 ${expected}（容差 ${tol}）`)
  }
}

function check(name, fn) {
  try {
    fn()
    pass.push(name)
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail.push({ name, msg: e.message })
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}

// ---------------------------------------------------------------- 转译 TS
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ephem-verify-'))
for (const f of fs.readdirSync(SRC_DIR)) {
  if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue
  const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8')
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
    },
    fileName: f
  })
  const fixed = outputText.replace(
    /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    (m, a, spec, c) => a + (/\.[a-z]+$/i.test(spec) ? spec : spec + '.js') + c
  )
  fs.writeFileSync(path.join(outDir, f.replace(/\.ts$/, '.js')), fixed)
}

const load = (name) => import(pathToFileURL(path.join(outDir, `${name}.js`)).href)
const { parseEphemeris } = await load('parse')
const { parseItc } = await load('parseItc')
const { parseOem } = await load('parseOem')
const { parseOcm } = await load('parseOcm')
const { interpolateAt } = await load('interp')
const { collisionProbability } = await load('probability')
const { applyImpulse, maneuverGrid } = await load('maneuver')
const { screenEphemeris } = await load('screening')
const { parseItcEpoch, parseIso, gmstRad } = await load('time')

// ------------------------------------------------- 真实 ITC 样本（前 3 个状态）
const ITC_TEXT = `created:2026-10-21 10:13:21 UTC
ephemeris_start:2026-10-21 10:04:42 UTC ephemeris_stop:2026-10-24 10:04:42 UTC step_size:60
ephemeris_source:blend
UVW
2026294100442.000 1514.5318433023 -6186.9665090039 2527.9216627207 3.3317485767 -1.8883487292 -6.5976090875
4.2260737905e-07 -3.4102761292e-07 7.1206607968e-07 1.7666902268e-10 2.2161121616e-10 1.1128199906e-06 7.3547486750e-10
-8.2125301957e-10 1.6988622012e-13 1.7787502320e-12 -4.3174722979e-10 3.6844553477e-10 -6.0668052209e-13 -7.6002407355e-13
4.7430352521e-13 6.0149642266e-13 2.7610697900e-13 1.5037387606e-09 2.4626653925e-16 -1.1530580313e-15 5.5656173346e-12
2026294100542.000 1710.9116969827 -6286.3889855084 2126.7079633750 3.2118112678 -1.4244940562 -6.7711954217
4.6672628328e-07 -4.0032739680e-07 8.0940850498e-07 2.3218396674e-10 1.7320032873e-10 1.3078158673e-06 8.2491177352e-10
-9.5033115615e-10 2.7594005570e-13 1.9771255144e-12 -4.7784927925e-10 4.3120989228e-10 -6.5586657678e-13 -8.5389084551e-13
5.2268078069e-13 6.1678523673e-13 1.4084184063e-13 1.7416352898e-09 3.8421415581e-16 -1.1617281616e-15 5.3529498374e-12
2026294100642.000 1899.6625820093 -6357.7780451847 1715.9835818200 3.0775443354 -0.9542524212 -6.9145154032
5.1359618689e-07 -4.6673078187e-07 9.2311583070e-07 2.9160354428e-10 1.1080861508e-10 1.5296397796e-06 9.2111991078e-10
-1.0963697951e-09 3.9257977340e-13 2.1901518811e-12 -5.2684329801e-10 5.0143586476e-10 -6.8993839564e-13 -9.5493503276e-13
5.7411368830e-13 6.1772352779e-13 2.2802903857e-14 1.9502219715e-09 4.8986541297e-16 -1.1159286320e-15 5.1070091299e-12
`
const T0 = Date.UTC(2026, 9, 21, 10, 4, 42)
const T1 = T0 + 60000

// ---------------------------------------------------------------- 测试
let parsed = null

check('ITC 解析成功（3 个状态点 + 协方差）', () => {
  const res = parseEphemeris(ITC_TEXT, {
    fileName: 'MEME_100001_STARLINK-38128_2941004_Operational_1476871500_UNCLASSIFIED.txt'
  })
  assert(res.ok, `解析失败：${res.error}`)
  const set = res.set
  assert(set.states.length === 3, `状态数应为 3，实际 ${set.states.length}`)
  assert(set.format === 'itc', `格式应为 itc，实际 ${set.format}`)
  assert(set.stepSec === 60, `步长应为 60s，实际 ${set.stepSec}`)
  assert(set.name === 'STARLINK-38128', `名称应为 STARLINK-38128，实际 ${set.name}`)
  assert(set.norad > 0, `NORAD 应从文件名兜底，实际 ${set.norad}`)
  assert(set.states[0].cov && set.states[0].cov.length === 36, '首个状态应带 6x6 协方差')
  // 协方差已旋转到 ECI：位置块对角线应为正
  assert(set.states[0].cov[0] > 0 && set.states[0].cov[7] > 0, '协方差位置块应位于 ECI')
  parsed = set
})

check('ITC 时间戳解析正确', () => {
  assert(parseItcEpoch('2026294100442.000') === T0, 'parseItcEpoch 结果不符')
  assert(parseIso('2026-10-21T10:04:42.000000Z') === T0, 'parseIso 带 Z 结果不符')
  assert(parseIso('2026-10-21 10:04:42') === T0, 'parseIso 无 Z 结果不符')
  assert(parsed.states[0].t === T0 && parsed.states[1].t === T1, '状态历元不符')
  // 起止时间以实际状态点为准（样本只内嵌了 3 个点）
  assert(parsed.start === T0 && parsed.stop === T0 + 120000, '起止时间不符')
  const g = gmstRad(T0)
  assert(g >= 0 && g < Math.PI * 2, `GMST 越界：${g}`)
})

check('Hermite 插值在已知点上误差 < 1e-9 km，越界返回 null', () => {
  for (const st of parsed.states) {
    const s = interpolateAt(parsed.states, st.t)
    assert(s, '已知点插值不应为 null')
    const err = Math.hypot(s.r[0] - st.r[0], s.r[1] - st.r[1], s.r[2] - st.r[2])
    near(err, 0, 1e-9, '已知点位置误差')
  }
  const mid = interpolateAt(parsed.states, T0 + 30000)
  assert(mid, '区间内插值不应为 null')
  // 中点应落在两端点连线的附近（60s 弧段内偏差很小）
  const a = parsed.states[0].r
  const b = parsed.states[1].r
  const chord = Math.hypot(mid.r[0] - (a[0] + b[0]) / 2, mid.r[1] - (a[1] + b[1]) / 2, mid.r[2] - (a[2] + b[2]) / 2)
  // 60s 弧段约 450km，弦中点到弧中点的矢高约 3.6km，这里放宽到 6km
  assert(chord < 6, `中点偏离弦中点过大：${chord} km`)
  assert(interpolateAt(parsed.states, T0 - 1000) === null, '下界外插应返回 null')
  assert(interpolateAt(parsed.states, parsed.stop + 1000) === null, '上界外插应返回 null')
})

check('碰撞概率算例落在 1e-3 ~ 1e-6 区间', () => {
  const sigma = 0.5
  const cov = new Float64Array(36)
  for (const i of [0, 1, 2, 3, 4, 5]) cov[i * 6 + i] = sigma * sigma
  const pc = collisionProbability({
    missKm: 0.1,
    relSpeedKmS: 10,
    covSelf: cov,
    covOther: cov,
    hardBodyKm: 0.005,
    regime: 'leo'
  })
  assert(Number.isFinite(pc), `Pc 非有限值：${pc}`)
  assert(pc >= 1e-6 && pc <= 1e-3, `Pc=${pc} 不在 [1e-6, 1e-3] 区间`)
  // 缺协方差时使用经验 σ，结果仍应同量级
  const pc2 = collisionProbability({ missKm: 0.1, relSpeedKmS: 10, hardBodyKm: 0.005, regime: 'leo' })
  assert(pc2 >= 1e-6 && pc2 <= 1e-3, `缺协方差时 Pc=${pc2} 不在合理区间`)
  // 极端输入的保护
  assert(collisionProbability({ missKm: 0.1, relSpeedKmS: 10, covSelf: new Float64Array(36), covOther: new Float64Array(36), hardBodyKm: 0.005 }) === 0, '零协方差应返回 0')
})

check('applyImpulse 速度增量正确（RTN 方向）', () => {
  const before = parsed.states.map((s) => [...s.v])
  const after = applyImpulse(parsed.states, T1, [0, 10, 0]) // 10 m/s 沿 T
  // 首个状态（早于机动时刻）不受影响
  near(Math.hypot(after[0].v[0] - before[0][0], after[0].v[1] - before[0][1], after[0].v[2] - before[0][2]), 0, 1e-12, '机动前速度变化')
  // 机动时刻及之后速度增量模长 = 0.01 km/s
  for (let i = 1; i < after.length; i++) {
    const dv = Math.hypot(after[i].v[0] - before[i][0], after[i].v[1] - before[i][1], after[i].v[2] - before[i][2])
    near(dv, 0.01, 1e-12, `第 ${i} 个状态速度增量`)
  }
  // 位置不变
  near(after[1].r[0], parsed.states[1].r[0], 1e-12, '机动后位置应不变')
  const grid = maneuverGrid(parsed.states, T1, 'T', 0, 20, 10)
  assert(grid.length === 3 && Math.abs(grid[2].dvMps - 20) < 1e-9, `maneuverGrid 生成数量异常：${grid.length}`)
})

check('OEM 解析（KVN + 下三角协方差）', () => {
  const f = (n) => n.toFixed(6)
  const rows = parsed.states.map((s) => `${new Date(s.t).toISOString()} ${f(s.r[0])} ${f(s.r[1])} ${f(s.r[2])} ${f(s.v[0])} ${f(s.v[1])} ${f(s.v[2])}`)
  const covNums = []
  for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) covNums.push(i === j ? 0.25 : 0)
  const text = [
    'CCSDS_OEM_VERS = 2.0',
    'COMMENT test',
    'META_START',
    'OBJECT_NAME = TEST-OEM',
    'OBJECT_ID = 2023-001A',
    'REF_FRAME = EME2000',
    'TIME_SYSTEM = UTC',
    'META_STOP',
    ...rows,
    'COVARIANCE_START',
    `EPOCH = ${rows[0].split(' ')[0]}`,
    covNums.join(' '),
    'COVARIANCE_STOP'
  ].join('\n')
  const res = parseOem(text)
  assert(res.ok, `解析失败：${res.error}`)
  assert(res.set.states.length === 3, `状态数不符：${res.set.states.length}`)
  assert(res.set.name === 'TEST-OEM', `对象名不符：${res.set.name}`)
  const cov = res.set.states[0].cov
  assert(cov && cov.length === 36, 'OEM 协方差缺失')
  // RTN → ECI 旋转后迹不变
  near(cov[0] + cov[7] + cov[14], 0.75, 1e-9, '协方差迹')
})

check('OCM 解析（键值组写法）', () => {
  const f = (n) => n.toFixed(6)
  const blocks = parsed.states.map((s) => [
    `EPOCH = ${new Date(s.t).toISOString()}`,
    `X = ${f(s.r[0])}`,
    `Y = ${f(s.r[1])}`,
    `Z = ${f(s.r[2])}`,
    `X_DOT = ${f(s.v[0])}`,
    `Y_DOT = ${f(s.v[1])}`,
    `Z_DOT = ${f(s.v[2])}`
  ].join('\n'))
  const text = [
    'CCSDS_OCM_VERS = 3.0',
    'META_START',
    'OBJECT_NAME = TEST-OCM',
    'OBJECT_ID = 2023-001A',
    'REF_FRAME = EME2000',
    'TIME_SYSTEM = UTC',
    'META_STOP',
    'TRAJ_START',
    ...blocks,
    'TRAJ_STOP'
  ].join('\n')
  const res = parseOcm(text)
  assert(res.ok, `解析失败：${res.error}`)
  assert(res.set.states.length === 3, `状态数不符：${res.set.states.length}`)
  near(res.set.states[0].r[0], parsed.states[0].r[0], 1e-5, 'OCM 位置')
})

check('非星历文本被拒绝并给出原因', () => {
  const res = parseItc('hello world')
  assert(!res.ok && !!res.error, '非法文本应解析失败')
})

check('screening 对重合目标给出 high 级事件', () => {
  const r0 = parsed.states[0].r
  const v0 = parsed.states[0].v
  const rn = Math.hypot(r0[0], r0[1], r0[2])
  const a = 1 / (2 / rn - (v0[0] ** 2 + v0[1] ** 2 + v0[2] ** 2) / 398600.4418)
  const h = [
    r0[1] * v0[2] - r0[2] * v0[1],
    r0[2] * v0[0] - r0[0] * v0[2],
    r0[0] * v0[1] - r0[1] * v0[0]
  ]
  const inc = (Math.acos(h[2] / Math.hypot(h[0], h[1], h[2])) * 180) / Math.PI
  const catalog = [{ norad: 99999, name: 'SYNTHETIC', r: [...r0], v: [...v0], a, e: 0, i: inc }]
  const events = screenEphemeris(parsed, catalog, {
    t0: parsed.start,
    t1: parsed.stop,
    coarseStepSec: 60,
    maxDistKm: 20,
    hardBodyKm: 0.02,
    pcThreshold: 1e-8
  })
  assert(events.length === 1, `应有 1 条事件，实际 ${events.length}`)
  assert(events[0].missKm < 0.001, `最小距离应接近 0，实际 ${events[0].missKm}`)
  assert(events[0].level === 'high', `等级应为 high，实际 ${events[0].level}`)
})

// ---------------------------------------------------------------- 汇总
console.log(`\n通过 ${pass.length} 项，失败 ${fail.length} 项`)
if (fail.length) {
  for (const f of fail) console.log(`  ✗ ${f.name}: ${f.msg}`)
  process.exit(1)
}
console.log('ALL PASS')
try {
  fs.rmSync(outDir, { recursive: true, force: true })
} catch {
  /* 忽略清理失败 */
}
