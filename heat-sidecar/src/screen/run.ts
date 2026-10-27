/**
 * 筛查轮次编排（P2-6）
 *
 *  1) 取统一星历表（hs_ephem scope=official）与副星目录（sat_tle / sat_aoe）；
 *  2) 时间窗 [now, min(星历结束, now+SCREEN_WINDOW_H)]，按星历步长切分片交给 worker 粗筛；
 *  3) 主线程对候选做 Brent 细化、协方差合成、Foster 2D 求 Pc；
 *  4) 写 hs_screen_run / hs_event，每 kind 保留最近 10 轮。
 *
 * 结果口径：距离/Pc 在 J2000 计算，a_*、b_*、mid_* 转回 TEME 供三维渲染。
 */
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { bulkInsert, execute, query, withTransaction } from '../db.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { RowDataPacket } from 'mysql2/promise'
import { coarseScan, buildSatrec, propagateJ2000, type CoarseInput } from './coarse.js'
import type { Candidate, CatalogObject, EphTrack, ScreenParams, Vec3 } from './types.js'
import { ephCovariance, tleCovariance } from './covariance.js'
import { j2000ToTeme } from './frames.js'
import { collisionProbability } from './pc.js'
import { hermitePrimary, missRTN, refineCandidate } from './refine.js'
import { latestEphRunId, loadTracks } from './ephemStore.js'

const log = logger('screen.run')

/** Serialize screens: admin + on-demand jobs must not run coarse scans in parallel (OOM). */
let screenMutex: Promise<void> = Promise.resolve()
function withScreenLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const prev = screenMutex
  screenMutex = prev.then(() => gate)
  return prev.then(fn).finally(() => release())
}


export type ScreenKind = 'tle' | 'tle-threat' | 'aoe'

/** 按需筛查（上传星历）的附加参数；不传时是官方轮次的既有行为 */
export interface ScreenOptions {
  /** 指定主星轨迹（上传星历），不传则用最新一轮官方星历 */
  tracks?: EphTrack[]
  scope?: 'official' | 'uploaded'
  ephemId?: string | null
  /** 时间窗（小时），默认 SCREEN_WINDOW_H */
  windowH?: number
  signal?: AbortSignal
  onProgress?: (ratio: number) => void
  workers?: number
}

export interface ScreenOutcome {
  runId: number
  kind: ScreenKind
  nPrimary: number
  nSecondary: number
  nCandidates: number
  nEvents: number
  durationMs: number
  message: string
}

interface CatalogRow extends RowDataPacket {
  norad_id: number
  object_name: string | null
  epoch: Date | null
  mean_motion: number | null
  ecc: number | null
  apogee: number | null
  perigee: number | null
  tle_line1: string | null
  tle_line2: string | null
}

/** 按等级门限（Pc）分级；Pc<1e-7 不建事件（除非 diluted） */
export function levelOfPc(pc: number, pcMax: number): 'danger' | 'warning' | 'info' | 'insufficient' | null {
  if (pc >= 1e-4) return 'danger'
  if (pc >= 1e-5) return 'warning'
  if (pc >= 1e-7) return 'info'
  if (pcMax >= 1e-4) return 'insufficient'
  return null
}

/* ============================================================
 * 官方 CDM 优先（P0-2）
 *  同一 NORAD 无序对且 |ΔTCA| ≤ CDM_TOL_S 视为同一交会事件；
 *  命中后以 CDM 的 Pc 作为事件概率（pc_source='cdm'），避免精密星历 Pc 系统性偏低时
 *  把 SpaceTrack 已判高危的事件压成低档。CDM 缺失时仍用核心/内置 Pc（pc_source='core'）。
 * ============================================================ */
const CDM_TOL_S = 120

interface CdmRow extends RowDataPacket {
  cdm_id: string | null
  norad_a: number | null
  norad_b: number | null
  tca: Date | string
  miss_km: number | null
  pc: number | null
}

interface CdmMatch {
  cdmId: string | null
  tcaMs: number
  pc: number
  missKm: number | null
}

/** 官方 CDM 索引：hs_cdm_history 优先，为空时回落 jsc 的 sat_cdm（口径同 validate/cdmCompare） */
async function loadCdmIndex(): Promise<Map<string, CdmMatch[]>> {
  const map = new Map<string, CdmMatch[]>()
  try {
    let rows = await query<CdmRow>(
      'SELECT cdm_id, norad_a, norad_b, tca, min_rng_km AS miss_km, pc FROM hs_cdm_history'
    )
    if (!rows.length) {
      rows = await query<CdmRow>(
        'SELECT cdm_id, norad_a, norad_b, tca, miss_distance_km AS miss_km, collision_probability AS pc ' +
          'FROM sat_cdm WHERE tca IS NOT NULL'
      )
    }
    for (const r of rows) {
      if (r.norad_a == null || r.norad_b == null) continue
      const tcaMs = new Date(r.tca).getTime()
      const pc = Number(r.pc)
      // Pc 非正/缺失的 CDM 没有分级意义，跳过（避免把核心算出的有效 Pc 覆盖成 0）
      if (!Number.isFinite(tcaMs) || !Number.isFinite(pc) || pc <= 0) continue
      const a = Math.min(Number(r.norad_a), Number(r.norad_b))
      const b = Math.max(Number(r.norad_a), Number(r.norad_b))
      const key = `${a}:${b}`
      const arr = map.get(key) ?? []
      const miss = r.miss_km == null ? null : Number(r.miss_km)
      arr.push({ cdmId: r.cdm_id ?? null, tcaMs, pc, missKm: Number.isFinite(miss as number) ? miss : null })
      map.set(key, arr)
    }
  } catch (e) {
    // 无 CDM 表 / 未授权时静默退化为纯核心 Pc，不影响筛查主流程
    log.warn(`官方 CDM 索引加载失败，本轮全部使用核心 Pc：${e instanceof Error ? e.message : String(e)}`)
  }
  return map
}

/** 按 NORAD 无序对 + |ΔTCA| 取最接近的一条 CDM */
function matchCdm(
  index: Map<string, CdmMatch[]>,
  noradA: number | null | undefined,
  noradB: number,
  tcaMs: number
): CdmMatch | null {
  if (noradA == null) return null
  const a = Math.min(Number(noradA), Number(noradB))
  const b = Math.max(Number(noradA), Number(noradB))
  const list = index.get(`${a}:${b}`)
  if (!list?.length) return null
  let best: CdmMatch | null = null
  let bestDt = Number.POSITIVE_INFINITY
  for (const c of list) {
    const dt = Math.abs(c.tcaMs - tcaMs) / 1000
    if (dt <= CDM_TOL_S && dt < bestDt) {
      best = c
      bestDt = dt
    }
  }
  return best
}

/** 位置协方差沿迹方向标准差（km）：σ_T = sqrt(tᵀ C_pp t)，t 取速度单位向量 */
function sigmaAlongTrack(v: Vec3, cov: Float64Array): number {
  const vn = Math.hypot(v[0], v[1], v[2]) || 1
  const t: Vec3 = [v[0] / vn, v[1] / vn, v[2] / vn]
  let s2 = 0
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s2 += t[i] * cov[i * 6 + j] * t[j]
  return Math.sqrt(Math.max(0, s2))
}

async function loadCatalog(kind: ScreenKind): Promise<CatalogObject[]> {
  const table = kind === 'aoe' ? 'sat_aoe' : 'sat_tle'
  const rows = await query<CatalogRow>(
    `SELECT norad_id, object_name, epoch, mean_motion, ecc, apogee, perigee, tle_line1, tle_line2
       FROM ${table}
      WHERE is_active = 1 AND tle_line1 IS NOT NULL AND tle_line1 <> '' AND tle_line2 IS NOT NULL AND tle_line2 <> ''`
  )
  const out: CatalogObject[] = []
  for (const r of rows) {
    if (!r.epoch) continue
    const perigee = Number(r.perigee)
    const apogee = Number(r.apogee)
    out.push({
      norad: r.norad_id,
      name: r.object_name ?? String(r.norad_id),
      line1: r.tle_line1 as string,
      line2: r.tle_line2 as string,
      epochMs: r.epoch.getTime(),
      src: kind === 'aoe' ? 'aoe' : 'tle',
      perigeeKm: Number.isFinite(perigee) ? perigee : 0,
      apogeeKm: Number.isFinite(apogee) ? apogee : 0
    })
  }
  return out
}

/** TLE 主星轨迹的时间步长（与粗筛 Δt 同口径） */
const TLE_PRIMARY_STEP_MS = 60_000

/**
 * TLE×TLE 主星轨迹：从 sat_tle 取星链卫星，用 SGP4 采样成与星历同构的 EphTrack。
 * 协方差留空（cov=null），细化后按根数龄期模型给 σ（见 tleCovariance）。
 */
async function loadTlePrimaryTracks(
  windowH: number,
  maxPrimary: number
): Promise<{ tracks: EphTrack[]; total: number }> {
  const rows = await query<CatalogRow>(
    "SELECT norad_id, object_name, epoch, mean_motion, ecc, apogee, perigee, tle_line1, tle_line2 " +
      'FROM sat_tle WHERE is_active = 1 ' +
      "AND tle_line1 IS NOT NULL AND tle_line1 <> '' AND tle_line2 IS NOT NULL AND tle_line2 <> '' " +
      "AND UPPER(object_name) LIKE 'STARLINK%' ORDER BY epoch DESC"
  )
  const picked = maxPrimary > 0 ? rows.slice(0, maxPrimary) : rows
  const n = Math.max(2, Math.floor((windowH * 3600_000) / TLE_PRIMARY_STEP_MS) + 1)
  const startMs = Math.floor(Date.now() / TLE_PRIMARY_STEP_MS) * TLE_PRIMARY_STEP_MS
  const tracks: EphTrack[] = []
  for (const r of picked) {
    if (!r.epoch) continue
    const obj: CatalogObject = {
      norad: r.norad_id,
      name: r.object_name ?? String(r.norad_id),
      line1: r.tle_line1 as string,
      line2: r.tle_line2 as string,
      epochMs: r.epoch.getTime(),
      src: 'tle',
      perigeeKm: 0,
      apogeeKm: 0
    }
    const rec = buildSatrec(obj)
    if (!rec) continue
    const rv = new Float64Array(n * 3)
    const vv = new Float64Array(n * 3)
    let ok = true
    for (let i = 0; i < n; i++) {
      const pv = propagateJ2000(rec, startMs + i * TLE_PRIMARY_STEP_MS)
      if (!pv) { ok = false; break }
      rv[i * 3] = pv.r[0]; rv[i * 3 + 1] = pv.r[1]; rv[i * 3 + 2] = pv.r[2]
      vv[i * 3] = pv.v[0]; vv[i * 3 + 1] = pv.v[1]; vv[i * 3 + 2] = pv.v[2]
    }
    if (!ok) continue
    tracks.push({
      memeId: r.norad_id,
      noradId: r.norad_id,
      name: obj.name,
      createdMs: r.epoch.getTime(),
      startMs,
      stepMs: TLE_PRIMARY_STEP_MS,
      n,
      r: rv,
      v: vv,
      cov: null,
      epochMs: r.epoch.getTime()
    })
  }
  log.info(`加载 TLE 主星：${tracks.length}/${rows.length} 颗（上限 ${maxPrimary || '不限'}）`)
  return { tracks, total: rows.length }
}

function workerCount(): number {
  return config.SCREEN_WORKERS > 0 ? config.SCREEN_WORKERS : Math.min(4, Math.max(1, cpus().length))
}

async function runCoarseParallel(
  primaries: EphTrack[],
  catalog: CatalogObject[],
  params: ScreenParams,
  totalSteps: number,
  workers = workerCount()
): Promise<Candidate[]> {
  const n = Math.max(1, Math.min(workers, totalSteps))
  if (n === 1) {
    return coarseScan({ primaries, catalog, params, stepFrom: 0, stepTo: totalSteps })
  }
  const chunk = Math.ceil(totalSteps / n)
  const jobs: Promise<Candidate[]>[] = []
  for (let i = 0; i < n; i++) {
    const from = i * chunk
    const to = Math.min(totalSteps, from + chunk)
    if (to <= from) continue
    const data: CoarseInput = { primaries, catalog, params, stepFrom: from, stepTo: to }
    jobs.push(
      new Promise<Candidate[]>((resolve, reject) => {
        const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: data })
        let done = false
        w.on('message', (msg: Candidate[]) => {
          done = true
          resolve(msg)
        })
        w.on('error', reject)
        w.on('exit', (code) => {
          if (!done) reject(new Error(`worker 退出（code=${code}）`))
        })
      })
    )
  }
  const lists = await Promise.all(jobs)
  return lists.flat()
}

async function runScreenUnlocked(
  kind: ScreenKind,
  trigger = 'manual',
  opts: ScreenOptions = {}
): Promise<ScreenOutcome> {
  const startedAt = new Date()
  const t0 = Date.now()
  const tlePrimary = kind === 'tle-threat'
  const workers = opts.workers && opts.workers > 0 ? opts.workers : workerCount()
  const windowH = opts.windowH ?? config.SCREEN_WINDOW_H
  const scope = opts.scope ?? 'official'
  const paramsJson = JSON.stringify({
    hbr_m: config.HBR_M,
    miss_max_km: config.MISS_MAX_KM,
    window_h: windowH,
    workers,
    trigger,
    scope,
    ephem_id: opts.ephemId ?? null,
    max_primary: scope === 'official' ? config.SCREEN_MAX_PRIMARY : 1
  })
  const ins = await execute(
    'INSERT INTO hs_screen_run (kind, started_at, status, params_json, scope, ephem_id) VALUES (?, ?, 0, ?, ?, ?)',
    [kind, startedAt, paramsJson, scope, opts.ephemId ?? null]
  )
  const runId = ins.insertId

  const finish = async (
    status: number,
    fields: Partial<{
      nPrimary: number
      nSecondary: number
      nCandidates: number
      nEvents: number
      message: string
    }>
  ): Promise<void> => {
    await execute(
      'UPDATE hs_screen_run SET finished_at=?, status=?, n_primary=?, n_secondary=?, n_candidates=?, n_events=?, message=? WHERE id=?',
      [
        new Date(),
        status,
        fields.nPrimary ?? 0,
        fields.nSecondary ?? 0,
        fields.nCandidates ?? 0,
        fields.nEvents ?? 0,
        (fields.message ?? '').slice(0, 1000),
        runId
      ]
    )
  }

  try {
    let tracks: EphTrack[]
    let total: number
    if (opts.tracks?.length) {
      tracks = opts.tracks
      total = tracks.length
    } else if (tlePrimary) {
      const loaded = await loadTlePrimaryTracks(windowH, config.SCREEN_MAX_PRIMARY)
      tracks = loaded.tracks
      total = loaded.total
      if (!tracks.length) throw new Error('TLE 主星为空（sat_tle 无可用星链根数）')
    } else {
      const ephRunId = await latestEphRunId()
      const loaded = await loadTracks(config.SCREEN_MAX_PRIMARY)
      tracks = loaded.tracks
      total = loaded.total
      if (!tracks.length) throw new Error('星历库为空（hs_ephem scope=official 无可用轨迹）')
      if (ephRunId) await execute('UPDATE hs_screen_run SET eph_run_id=? WHERE id=?', [ephRunId, runId])
    }

    const catalog = await loadCatalog(kind)
    if (!catalog.length) throw new Error(`${kind} 副星目录为空（is_active=1 且有两行根数）`)
    // 官方 CDM 索引：命中则以 CDM Pc 作为事件概率（P0-2）。TLE×TLE 初筛为纯自算，不做 CDM 覆盖。
    const cdmIndex = tlePrimary ? new Map<string, CdmMatch[]>() : await loadCdmIndex()

    // 窗口：现在 → min(星历结束, now+windowH)；TLE 主星用采样轨迹自身覆盖的窗口
    const nowMs = Date.now()
    let windowStartMs: number
    let windowEndMs: number
    if (tlePrimary) {
      windowStartMs = tracks[0].startMs
      windowEndMs = windowStartMs + (tracks[0].n - 1) * tracks[0].stepMs
    } else {
      // BUGFIX: do NOT Math.min() across all ephemeris end times. One expired/short
      // file used to truncate the whole screening window to a few hours; events then
      // all fall before NOW() and the heatmap shows 0 while TLE mode still has thousands.
      // Coarse scan already skips out-of-range epochs (k < 0 || k >= n), so the global
      // window should extend to the farthest still-valid track (capped by windowH).
      const before = tracks.length
      tracks = tracks.filter((t) => t.startMs + (t.n - 1) * t.stepMs > nowMs)
      if (!tracks.length) throw new Error('筛查窗口为空（星历已过期或尚未覆盖当前时刻）')
      if (tracks.length < before) {
        log.warn(`星历主星过滤：丢弃 ${before - tracks.length}/${before} 份已过期轨迹，保留 ${tracks.length}`)
      }
      const ephStop = Math.max(...tracks.map((t) => t.startMs + (t.n - 1) * t.stepMs))
      windowEndMs = Math.min(ephStop, nowMs + windowH * 3600_000)
      windowStartMs = Math.min(nowMs, windowEndMs)
    }
    const stepMs = tracks[0].stepMs
    const totalSteps = Math.max(0, Math.floor((windowEndMs - windowStartMs) / stepMs))
    if (totalSteps < 2) throw new Error('筛查窗口为空（星历已过期或尚未覆盖当前时刻）')
    if (opts.signal?.aborted) throw new Error('ABORTED')

    const params: ScreenParams = {
      missMaxKm: config.MISS_MAX_KM,
      hbrKm: config.HBR_M / 1000,
      vRelMaxKms: 15.5,
      stepMs,
      windowStartMs,
      windowEndMs
    }

    log.info(
      `筛查开始 kind=${kind} run=${runId} scope=${scope}（${tracks.length}/${total} 份）` +
        ` 副星 ${catalog.length} 步长 ${stepMs / 1000}s 窗口 ${totalSteps} 步`
    )
    opts.onProgress?.(0.05)
    const candidates = await runCoarseParallel(tracks, catalog, params, totalSteps, workers)
    log.info(`粗筛完成：候选 ${candidates.length} 个（${Math.round((Date.now() - t0) / 1000)}s）`)
    opts.onProgress?.(0.4)

    // 副星索引
    const catByNorad = new Map<number, CatalogObject>()
    for (const c of catalog) catByNorad.set(c.norad, c)
    const trackByNorad = new Map<number, EphTrack>()
    // 仅星历主星才可能把同一颗卫星当副星（星历插值）；TLE 主星一律走 SGP4
    if (!tlePrimary) for (const t of tracks) if (t.noradId) trackByNorad.set(t.noradId, t)
    const trackByMeme = new Map<number, EphTrack>()
    for (const t of tracks) trackByMeme.set(t.memeId, t)
    const satrecCache = new Map<number, ReturnType<typeof buildSatrec>>()

    const rows: unknown[][] = []
    const seen = new Set<string>()

    for (let ci = 0; ci < candidates.length; ci++) {
      const cand = candidates[ci]
      if (opts.signal?.aborted) throw new Error('ABORTED')
      if (ci % 200 === 0 && candidates.length) {
        opts.onProgress?.(0.4 + 0.55 * (ci / candidates.length))
      }
      const primary = trackByMeme.get(cand.primaryMeme)
      const sec = catByNorad.get(cand.secondaryNorad)
      if (!primary || !sec) continue
      // 自过滤：名称 + NORAD 双重判断（同一目标不与自己交会）
      if (
        (primary.noradId != null && primary.noradId === sec.norad) ||
        (primary.name && primary.name.trim().toUpperCase() === sec.name.trim().toUpperCase() && (primary.noradId == null || primary.noradId === sec.norad))
      ) {
        continue
      }

      const secTrack = tlePrimary ? null : (trackByNorad.get(sec.norad) ?? null)
      const secondaryAt = (tMs: number): { r: Vec3; v: Vec3 } | null => {
        if (secTrack) return hermitePrimary(secTrack, tMs)
        let rec = satrecCache.get(sec.norad)
        if (rec === undefined) {
          rec = buildSatrec(sec)
          satrecCache.set(sec.norad, rec)
        }
        return rec ? propagateJ2000(rec, tMs) : null
      }

      const refined = refineCandidate({ primary, secondary: secondaryAt, centerMs: cand.centerMs, stepMs })
      if (!refined || !(refined.missKm <= config.MISS_MAX_KM)) continue

      const key = `${primary.memeId}:${sec.norad}:${Math.round(refined.tcaMs / 60000)}`
      if (seen.has(key)) continue
      seen.add(key)

      // 协方差（J2000）：星历主星用星历协方差；TLE 主星按根数龄期模型给
      const idx = Math.max(0, Math.min(primary.n - 2, Math.floor((refined.tcaMs - primary.startMs) / primary.stepMs)))
      const frac = Math.max(0, Math.min(1, (refined.tcaMs - primary.startMs) / primary.stepMs - idx))
      let covP: Float64Array
      let sigmaPSrc: 'eph' | 'tle'
      let sigmaPT: number
      if (tlePrimary) {
        const tleP = tleCovariance(refined.rP, refined.vP, primary.epochMs ?? primary.startMs, refined.tcaMs)
        covP = tleP.cov
        sigmaPSrc = 'tle'
        sigmaPT = tleP.sigmaT
      } else {
        const covE = ephCovariance(primary, idx, frac, refined.rP, refined.vP)
        if (!covE) continue
        covP = covE
        sigmaPSrc = 'eph'
        sigmaPT = sigmaAlongTrack(refined.vP, covP)
      }

      let covS: Float64Array
      let sigmaSrc: 'eph' | 'tle' | 'aoe'
      let sigmaT: number | null = null
      let secAgeH: number | null = null
      if (secTrack) {
        const idxS = Math.max(0, Math.min(secTrack.n - 2, Math.floor((refined.tcaMs - secTrack.startMs) / secTrack.stepMs)))
        const fracS = Math.max(0, Math.min(1, (refined.tcaMs - secTrack.startMs) / secTrack.stepMs - idxS))
        const covE = ephCovariance(secTrack, idxS, fracS, refined.rS, refined.vS)
        if (!covE) continue
        covS = covE
        sigmaSrc = 'eph'
        secAgeH = secTrack.createdMs ? (refined.tcaMs - secTrack.createdMs) / 3600_000 : null
      } else {
        const tleCov = tleCovariance(refined.rS, refined.vS, sec.epochMs, refined.tcaMs)
        covS = tleCov.cov
        sigmaSrc = kind === 'aoe' ? 'aoe' : 'tle'
        sigmaT = tleCov.sigmaT
        secAgeH = tleCov.ageHours
      }

      const relVel: Vec3 = [
        refined.vS[0] - refined.vP[0],
        refined.vS[1] - refined.vP[1],
        refined.vS[2] - refined.vP[2]
      ]
      const pcRes = collisionProbability({
        missVec: refined.miss,
        relVelVec: relVel,
        covA: covP,
        covB: covS,
        hbrKm: config.HBR_M / 1000
      })
      // 官方 CDM 优先：同一交会事件若已有官方 CDM，以其 Pc 与等级为准（P0-2）
      const cdm = matchCdm(cdmIndex, primary.noradId, sec.norad, refined.tcaMs)
      const pcFinal = cdm ? cdm.pc : pcRes.pc
      const level = levelOfPc(pcFinal, pcRes.pcMax)
      if (!level) continue

      const rtn = missRTN(refined.rP, refined.vP, refined.miss)
      const aTeme = j2000ToTeme(refined.rP, refined.vP, refined.tcaMs).r
      const bTeme = j2000ToTeme(refined.rS, refined.vS, refined.tcaMs).r
      const mid: Vec3 = [(aTeme[0] + bTeme[0]) / 2, (aTeme[1] + bTeme[1]) / 2, (aTeme[2] + bTeme[2]) / 2]

      rows.push([
        runId,
        kind,
        primary.noradId,
        primary.memeId,
        primary.name.slice(0, 100),
        sec.norad,
        sec.name.slice(0, 100),
        secTrack ? 'eph' : sigmaSrc,
        new Date(refined.tcaMs),
        refined.missKm,
        rtn.r,
        rtn.t,
        rtn.n,
        Math.hypot(relVel[0], relVel[1], relVel[2]),
        pcFinal,
        pcRes.pcMax,
        'foster2d',
        config.HBR_M,
        sigmaPSrc,
        sigmaPT,
        sigmaSrc,
        sigmaT,
        new Date(sec.epochMs),
        secAgeH,
        primary.createdMs ? new Date(primary.createdMs) : null,
        primary.createdMs ? (refined.tcaMs - primary.createdMs) / 3600_000 : null,
        level,
        pcRes.diluted ? 1 : 0,
        aTeme[0],
        aTeme[1],
        aTeme[2],
        bTeme[0],
        bTeme[1],
        bTeme[2],
        mid[0],
        mid[1],
        mid[2],
        cdm?.cdmId ?? null,
        cdm?.pc ?? null,
        cdm?.missKm ?? null,
        cdm ? (refined.tcaMs - cdm.tcaMs) / 1000 : null,
        cdm ? 'cdm' : 'core',
        tlePrimary ? 'tle_only' : 'eph'
      ])
    }

    if (rows.length) {
      await withTransaction(async (conn) => {
        await bulkInsert(
          conn,
          'INSERT INTO hs_event (run_id, kind, primary_norad, primary_meme, primary_name, secondary_norad, secondary_name, ' +
            'secondary_src, tca, miss_km, miss_r_km, miss_t_km, miss_n_km, rel_speed_kms, pc, pc_max, pc_method, hbr_m, ' +
            'sigma_p_src, sigma_p_t_km, sigma_s_src, sigma_s_t_km, sec_epoch, sec_age_h, eph_created, eph_age_h, level, diluted, ' +
            'a_x, a_y, a_z, b_x, b_y, b_z, mid_x, mid_y, mid_z, cdm_id, cdm_pc, cdm_miss_km, cdm_dtca_s, pc_source, quality) VALUES ?',
          rows
        )
      })
    }

    const durationMs = Date.now() - t0
    const message =
      `kind=${kind} 主星 ${tracks.length} 副星 ${catalog.length} 候选 ${candidates.length} ` +
      `事件 ${rows.length} 用时 ${Math.round(durationMs / 1000)}s`
    opts.onProgress?.(0.99)
    await finish(1, {
      nPrimary: tracks.length,
      nSecondary: catalog.length,
      nCandidates: candidates.length,
      nEvents: rows.length,
      message
    })
    await pruneOldRuns(kind, scope)
    log.info(message)
    return {
      runId,
      kind,
      nPrimary: tracks.length,
      nSecondary: catalog.length,
      nCandidates: candidates.length,
      nEvents: rows.length,
      durationMs,
      message
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await finish(2, { message: msg })
    log.error(`筛查失败 kind=${kind}：${msg}`)
    throw e
  }
}

export async function runScreen(
  kind: ScreenKind,
  trigger = 'manual',
  opts: ScreenOptions = {}
): Promise<ScreenOutcome> {
  return withScreenLock(() => runScreenUnlocked(kind, trigger, opts))
}

/** 官方轮次每 kind 只保留最近 10 轮（先删事件，再删轮次）；上传星历的轮次随星历一起删除 */
async function pruneOldRuns(kind: ScreenKind, scope: 'official' | 'uploaded' = 'official'): Promise<void> {
  if (scope !== 'official') return
  const ids = await query<RowDataPacket & { id: number }>(
    "SELECT id FROM hs_screen_run WHERE kind=? AND scope='official' ORDER BY id DESC LIMIT 10",
    [kind]
  )
  if (!ids.length) return
  const keepFrom = ids[ids.length - 1].id
  await execute(
    "DELETE FROM hs_event WHERE run_id IN (SELECT id FROM hs_screen_run WHERE kind=? AND scope='official' AND id < ?)",
    [kind, keepFrom]
  )
  await execute("DELETE FROM hs_screen_run WHERE kind=? AND scope='official' AND id < ?", [kind, keepFrom])
}
