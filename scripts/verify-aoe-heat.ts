/**
 * 开发期对比验证脚本（一次性，不参与构建）：
 * 同一份精密星历 × 同一份 AOE 编目，比较两条链路的结果——
 *  A) 现有「我的星历」威胁筛选：目录点云 + 二体开普勒外推（screening.ts）
 *  B) 新增「星历热力」：同点云粗筛 → 候选目标 TLE + SGP4 精算（aoeHeat.ts）
 * 并用「TLE + SGP4 在 A 报出的 TCA ±10 min 内独立复算最小距离」作为判据，
 * 判断 A 的接近事件是真接近还是二体外推漂移造成的虚警。
 *
 * 运行：node scripts/verify-aoe-heat.mjs（先由 esbuild 打包）
 */
import fs from 'node:fs'
import path from 'node:path'
import { interpolateAt } from '../src/views/situation/ephem/interp'
import { screenEphemeris, elementsFromRV } from '../src/views/situation/ephem/screening'
import type { CatalogSnapshotEntry } from '../src/views/situation/ephem/screening'
import { coarseAoe, refineAoe, DEFAULT_AOE_HEAT } from '../src/views/situation/ephem/aoeHeat'
import type { AoeHeatOptions, AoeTle } from '../src/views/situation/ephem/aoeHeat'
import type { EphemSet, ThreatEvent, Vec3 } from '../src/views/situation/ephem/types'
import { decodeConstellation } from '../src/api/satTypes'
import { twoline2satrec, propagate } from 'satellite.js'

const BASE = process.env.API_BASE || 'http://localhost:1234/cgi'
const SAMPLE_DIR = path.resolve('public/ephemeris-samples')
const WINDOW_H = Number(process.env.WINDOW_H || 24)
const REPORT_KM = Number(process.env.REPORT_KM || 50)

function normName(s: string) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

async function getJson(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  const j = await r.json() as { data?: unknown }
  return (j && typeof j === 'object' && 'data' in j) ? j.data : j
}

function loadSample(file: string): EphemSet {
  const raw = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, file), 'utf8')) as {
    norad: number; name: string; start: number; stop: number; stepSec: number
    states: [number, number, number, number, number, number, number][]
  }
  return {
    id: `builtin-${raw.norad}`,
    norad: raw.norad,
    name: raw.name,
    format: 'itc',
    frame: 'UVW',
    source: 'builtin',
    createdAt: Date.now(),
    start: raw.start,
    stop: raw.stop,
    stepSec: raw.stepSec,
    states: raw.states.map((r) => ({
      t: r[0],
      r: [r[1], r[2], r[3]] as Vec3,
      v: [r[4], r[5], r[6]] as Vec3
    })),
    warnings: []
  }
}

/** 用 TLE + SGP4 在 [tca-span, tca+span] 内逐秒复算最小距离（独立于两条链路） */
function sgp4MinDist(set: EphemSet, tle: AoeTle, tca: number, spanMin = 10) {
  const sat = twoline2satrec(tle[1], tle[2])
  let best = Infinity
  let bestT = NaN
  for (let dt = -spanMin * 60e3; dt <= spanMin * 60e3; dt += 1000) {
    const t = tca + dt
    const s = interpolateAt(set.states, t)
    const pv = propagate(sat, new Date(t))
    const p = pv?.position
    if (!s || !p) continue
    const d = Math.hypot(p.x - s.r[0], p.y - s.r[1], p.z - s.r[2])
    if (d < best) { best = d; bestT = t }
  }
  return { min: best, t: bestT }
}

/** TLE 历元（unix ms） */
function tleEpochMs(l1: string): number {
  const yy = Number(l1.slice(18, 20))
  const doy = Number(l1.slice(20, 32))
  const year = yy < 57 ? 2000 + yy : 1900 + yy
  return Date.UTC(year, 0, 1) + (doy - 1) * 86400e3
}

interface Row { norad: number; name: string; missA?: number; missB?: number; dTcaMin?: number }

async function runOne(file: string, catalog: CatalogSnapshotEntry[], catalogT: number, tleMap: Map<number, AoeTle>) {
  const set = loadSample(file)
  const t0 = Math.max(set.start, catalogT)
  const t1 = Math.min(set.stop, t0 + WINDOW_H * 3600e3)
  if (!(t1 > t0)) return null

  const selfEl = elementsFromRV(set.states[0].r, set.states[0].v)
  const selfName = normName(set.name)
  const sameBand = catalog.filter((c) => {
    if (c.norad === set.norad || (selfName !== '' && normName(c.name) === selfName)) return false
    const a = Number.isFinite(c.a) ? c.a : selfEl.a
    const i = Number.isFinite(c.i) ? c.i : selfEl.i
    return Math.abs(a - selfEl.a) < 150 && Math.abs(i - selfEl.i) < 10
  })

  const evA = screenEphemeris(set, sameBand, {
    t0, t1, catalogT, coarseStepSec: 120, maxDistKm: REPORT_KM,
    hardBodyKm: 0.01, pcThreshold: 1e-6, maxEvents: 400
  })
  const opt: AoeHeatOptions = { ...DEFAULT_AOE_HEAT, windowH: WINDOW_H, reportKm: REPORT_KM, catalogT }
  const cands = coarseAoe(set, sameBand, t0, t1, opt)
  const candTles: AoeTle[] = []
  for (const c of cands) {
    const t = tleMap.get(c.norad)
    if (t) candTles.push(t)
  }
  const evB = refineAoe(set, candTles, cands, opt)

  const mapA = new Map(evA.map((e) => [e.otherNorad, e]))
  const mapB = new Map(evB.map((e) => [e.otherNorad, e]))
  const all = new Set([...mapA.keys(), ...mapB.keys()])
  const rows: Row[] = []
  for (const n of all) {
    const a = mapA.get(n)
    const b = mapB.get(n)
    rows.push({
      norad: n,
      name: b?.otherName || a?.otherName || '',
      missA: a?.missKm,
      missB: b?.missKm,
      dTcaMin: a && b ? (b.tca - a.tca) / 60000 : undefined
    })
  }
  rows.sort((x, y) => (x.missB ?? x.missA ?? 1e9) - (y.missB ?? y.missA ?? 1e9))

  // A 独有 → SGP4 独立复算，判定虚警 / 疑似漏报
  const onlyA = rows.filter((r) => r.missA != null && r.missB == null)
  const falseAlarm: { norad: number; name: string; a: number; truth: number }[] = []
  const missedByB: { norad: number; name: string; a: number; truth: number }[] = []
  for (const r of onlyA) {
    const tle = tleMap.get(r.norad)
    if (!tle) continue
    const res = sgp4MinDist(set, tle, mapA.get(r.norad)!.tca, 10)
    const rec = { norad: r.norad, name: r.name, a: r.missA as number, truth: res.min }
    if (res.min > REPORT_KM) falseAlarm.push(rec)
    else missedByB.push(rec)
  }
  // B 事件用 SGP4 宽窗（±10 min）复算，确认不是粗筛窗口选错
  const bCheck = evB.map((e: ThreatEvent) => {
    const tle = tleMap.get(e.otherNorad)
    const res = tle ? sgp4MinDist(set, tle, e.tca, 10) : { min: NaN, t: NaN }
    return { norad: e.otherNorad, miss: e.missKm, alt: res.min }
  })

  return { set, rows, onlyA, onlyB: rows.filter((r) => r.missA == null && r.missB != null), falseAlarm, missedByB, bCheck, sameBand: sameBand.length, cands: cands.length, evA, evB }
}

async function main() {
  const idx = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'index.json'), 'utf8')) as { norad: number; name: string; file: string }[]
  const snap = await getJson(`${BASE}/sat_aoe/constellation`) as Parameters<typeof decodeConstellation>[0]
  const catalogT = Number((snap as { t?: number }).t) || Date.now()
  const catalog: CatalogSnapshotEntry[] = decodeConstellation(snap).map((p) => {
    const periodMin = Number(p.period)
    const a = periodMin > 0 ? Math.cbrt(398600.4418 * Math.pow((periodMin * 60) / (2 * Math.PI), 2)) : NaN
    return {
      norad: p.norad_id,
      name: p.object_name || `NORAD ${p.norad_id}`,
      r: [p.x, p.y, p.z] as Vec3,
      v: [p.vx ?? 0, p.vy ?? 0, p.vz ?? 0] as Vec3,
      a, e: NaN, i: Number(p.incl ?? NaN)
    }
  })
  const tleRes = await getJson(`${BASE}/sat_aoe/tle_lines`) as { list?: [number, string, string][] }
  const tleMap = new Map<number, AoeTle>()
  for (const row of tleRes.list || []) tleMap.set(row[0], row)

  console.log(`AOE 编目：${catalog.length} 个目标（快照 ${new Date(catalogT).toISOString()}） · TLE ${tleMap.size} 条`)
  console.log(`口径：窗口 ${WINDOW_H} h · 报告距离 ${REPORT_KM} km · 样本 ${idx.length} 份\n`)

  let totalA = 0, totalB = 0, totalFA = 0, totalMiss = 0, totalBoth = 0
  const detail: string[] = []

  for (const s of idx) {
    const r = await runOne(s.file, catalog, catalogT, tleMap)
    if (!r) { console.log(`${s.name}：星历已过期，跳过`); continue }
    totalA += r.evA.length
    totalB += r.evB.length
    totalFA += r.falseAlarm.length
    totalMiss += r.missedByB.length
    totalBoth += r.rows.filter((x) => x.missA != null && x.missB != null).length

    console.log(`—— ${r.set.name}（同带目标 ${r.sameBand}，粗筛候选 ${r.cands}）`)
    console.log(`   A 二体外推 ${r.evA.length} 条 · B SGP4 精算 ${r.evB.length} 条`)
    if (r.falseAlarm.length) {
      for (const f of r.falseAlarm) {
        console.log(`   A 虚警：${f.name}(${f.norad}) A=${f.a.toFixed(2)} km → SGP4 实测 ${f.truth.toFixed(2)} km`)
      }
    }
    if (r.missedByB.length) {
      for (const f of r.missedByB) {
        console.log(`   B 疑似漏报：${f.name}(${f.norad}) A=${f.a.toFixed(2)} km → SGP4 实测 ${f.truth.toFixed(2)} km`)
      }
    }
    for (const b of r.evB) {
      const tle = tleMap.get(b.otherNorad)
      const spanH = tle ? Math.abs(b.tca - tleEpochMs(tle[1])) / 3600e3 : NaN
      const chk = r.bCheck.find((c) => c.norad === b.otherNorad)
      console.log(`   B 事件：${b.otherName}(${b.otherNorad}) ${b.missKm.toFixed(2)} km · ${b.relSpeedKmS.toFixed(2)} km/s · ` +
        `Pc ${b.pc.toExponential(1)} · TCA ${new Date(b.tca).toISOString()} · ` +
        `SGP4 宽窗复算 ${Number.isFinite(chk?.alt ?? NaN) ? (chk?.alt as number).toFixed(2) : '—'} km · ` +
        `TLE 外推 ${spanH.toFixed(1)} h`)
    }
    if (!r.evA.length && !r.evB.length) console.log('   两边均无事件')
    detail.push(`${r.set.name}: A=${r.evA.length} B=${r.evB.length} 虚警=${r.falseAlarm.length} 漏报=${r.missedByB.length}`)
  }

  console.log('\n===== 汇总 =====')
  console.log(`事件总数：A(二体外推)=${totalA} · B(SGP4 精算)=${totalB} · 两边共有=${totalBoth}`)
  console.log(`A 独有事件经 SGP4 复核：虚警 ${totalFA} 条 · B 疑似漏报 ${totalMiss} 条`)
  if (totalFA + totalMiss > 0) {
    console.log(`即 A 的 ${totalFA + totalMiss} 条独有事件中，${totalFA} 条（${((totalFA / (totalFA + totalMiss)) * 100).toFixed(0)}%）为二体外推漂移造成的假接近`)
  }

  // 现有后端热力表的时效性（交会分析热力 / 交会热力均为批次快照，不含未来窗口）
  try {
    const cri = await getJson(`${BASE}/sat_cri/heatmap?days=1`) as { total: number; run_id: number; day_groups: { date: string; count: number }[] }
    const cri7 = await getJson(`${BASE}/sat_cri/heatmap?days=7`) as { total: number }
    const criAll = await getJson(`${BASE}/sat_cri/heatmap?days=-1`) as { total: number }
    const conj1 = await getJson(`${BASE}/sat_conj/heatmap?days=1`) as { total: number; run_id: number }
    console.log(`\n现有后端热力批次：交会分析 run=${cri.run_id}，未来 24h ${cri.total} 条 / 7d ${cri7.total} 条 / 全部 ${criAll.total} 条；` +
      `交会热力 run=${conj1.run_id} 未来 24h ${conj1.total} 条`)
  } catch (e) {
    console.log(`\n（读取后端热力批次失败：${(e as Error).message}）`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
