/**
 * 「星历分析」模块状态与动作（03 §15.10）
 *
 * 职责划分：
 * - 本机：上传前预检（扩展名 / 大小 / 解析 / 点数）、星历查看、质量评估、机动模拟；
 * - 服务器（heat-sidecar）：解析入库、按需交会筛选、事件分级与 Pc；
 * - 浏览器**不再做威胁计算**：事件列表来自 `GET /cgi2/heat/list?primary=…`，
 *   与「TLE + 精密星历 / AOE + 精密星历」热力标签同一接口、同一分级、同一图例。
 */
import { computed, ref, shallowRef } from 'vue'
import { parseEphemeris } from './parse'
import { applyImpulse } from './maneuver'
import { scoreQuality } from './quality'
import { compareWithTle, type TleDeviationResult } from './tleCompare'
import { interpolateAt } from './interp'
import type { EphemFormat, EphemFrame, EphemSet, EphemState, QualityReport, Vec3 } from './types'
import {
  cancelScreen, createScreen, deleteEphem as apiDeleteEphem, getEphemStates, getHeat2Health,
  getScreen, listEphem, listHeat2, uploadEphem,
  type EphemMeta, type Heat2Kind, type Heat2ListItem, type ScreenJob
} from '@/api/heat2'
import { levelOfPc, type HeatLevel } from '../heat/riskLevels'
import { getSatDetailPublic } from '@/api/sat_public'

/** 单文件上限（MB）：与服务端 multer 限制一致 */
export const MAX_FILE_MB = 12
/** 上传前允许的扩展名（03 §15.11 第 1 条） */
const ALLOWED_EXT = ['txt', 'itc', 'oem', 'ocm', 'xml', 'json']
/** 首次上传确认（文件会离开本机，系统内所有使用者可见） */
const CONSENT_KEY = 'eph-upload-consent-v2'

/* ============================================================
 * 列表
 * ============================================================ */

/** 已上传星历（全局共享，按上传时间倒序） */
export const ephemMetas = ref<EphemMeta[]>([])
export const ephemTotal = ref(0)
/** 官方星历（最新一轮） */
export const officialMetas = ref<EphemMeta[]>([])
export const officialTotal = ref(0)
export const officialKeyword = ref('')
export const officialPage = ref(1)
export const OFFICIAL_PAGE_SIZE = 30

export const ephemBusy = ref(false)
export const ephemError = ref('')

/** 上传进度（0~100）与当前文件名 */
export const uploadProgress = ref(0)
export const uploadName = ref('')
/** 首次上传需要用户确认；待上传文件暂存于此 */
export const needConsent = ref(false)
let pendingFiles: File[] = []

/* ============================================================
 * 当前激活星历（三维图层 / 质量 / 机动共用）
 * ============================================================ */

export const activeEphem = shallowRef<EphemSet | null>(null)
/** 当前星历在服务端的元信息（官方星历 id 形如 off:<meme_id>） */
export const activeMeta = shallowRef<EphemMeta | null>(null)
export const activeQuality = shallowRef<QualityReport | null>(null)
export const qualityTle = shallowRef<TleDeviationResult | null>(null)
export const qualityTleBusy = ref(false)
export const qualityTleError = ref('')
export const qualityTleNorad = ref(0)
export const qualityTleNote = ref('')

/* ============================================================
 * 服务状态（/cgi2/health，30 s 缓存）
 * ============================================================ */

export type SidecarState = 'unknown' | 'up' | 'down'
export const sidecar = ref<SidecarState>('unknown')
export type SidecarReason = '' | 'SIDECAR_DOWN' | 'CORE_NOT_LOADED' | 'DB_DOWN'
export const sidecarReason = ref<SidecarReason>('')
/** 核心类型：bundled = 内置引擎（未加载私有核心）；external = 私有核心（HEAT_CORE_PATH） */
export const coreKind = ref<'bundled' | 'external' | 'stub' | ''>('')
let healthAt = 0

export async function refreshHealth(force = false): Promise<boolean> {
  if (!force && Date.now() - healthAt < 30_000) return sidecar.value === 'up'
  healthAt = Date.now()
  try {
    const h = await getHeat2Health()
    const coreOk = h.core === 'ready'
    const dbOk = h.db === 'up'
    coreKind.value = h.core_kind ?? 'stub'
    sidecar.value = coreOk && dbOk && h.status === 'up' ? 'up' : 'down'
    sidecarReason.value = coreOk && dbOk ? '' : !coreOk ? 'CORE_NOT_LOADED' : 'DB_DOWN'
  } catch {
    sidecar.value = 'down'
    sidecarReason.value = 'SIDECAR_DOWN'
    coreKind.value = ''
  }
  return sidecar.value === 'up'
}

/* ============================================================
 * 列表拉取
 * ============================================================ */

/** 刷新已上传星历（面板每 30 s 也调用一次，便于看到其他使用者的上传） */
export async function refreshEphemList() {
  try {
    const res = await listEphem({ scope: 'uploaded', page: 1, pageSize: 100 })
    ephemMetas.value = res.list || []
    ephemTotal.value = res.total || 0
    ephemError.value = ''
  } catch (e) {
    // sidecar 未连接时不清空旧列表（解析 / 查看仍可用），只在威胁分析区提示
    if (sidecar.value !== 'down') ephemError.value = (e as Error)?.message || '读取已上传星历失败'
  }
}

/** 官方星历（最新一轮）：分页 + 关键词 */
export async function refreshOfficial(keyword = officialKeyword.value, page = officialPage.value) {
  officialKeyword.value = keyword
  officialPage.value = page
  try {
    const res = await listEphem({
      scope: 'official', keyword: keyword.trim() || undefined, page, pageSize: OFFICIAL_PAGE_SIZE
    })
    officialMetas.value = res.list || []
    officialTotal.value = res.total || 0
    ephemError.value = ''
  } catch (e) {
    ephemError.value = (e as Error)?.message || '读取官方星历失败'
  }
}

/* ============================================================
 * 激活 / 关闭
 * ============================================================ */

function statesToSet(id: string, meta: EphemMeta | null, t: number[], r: number[], v: number[]): EphemSet | null {
  if (!t.length) return null
  const states: EphemState[] = []
  for (let i = 0; i < t.length; i++) {
    states.push({
      t: t[i],
      r: [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]] as Vec3,
      v: [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]] as Vec3
    })
  }
  const first = states[0]
  const last = states[states.length - 1]
  return {
    id,
    norad: meta?.norad ?? 0,
    name: meta?.name || `NORAD ${meta?.norad ?? '—'}`,
    format: (meta?.format as EphemFormat) || 'itc',
    frame: 'EME2000' as EphemFrame,
    source: meta?.scope === 'official' ? 'official' : 'upload',
    createdAt: Date.now(),
    start: first.t,
    stop: last.t,
    stepSec: meta?.stepS || Math.max(1, Math.round((last.t - first.t) / 1000 / Math.max(1, states.length - 1))),
    states,
    warnings: []
  }
}

/** 5 点（i-2..i+2）拉格朗日多项式在 i+0.5 处的权重（等距节点） */
const L5 = [0.0234375, -0.15625, 0.703125, 0.46875, -0.0390625]

/** 自洽性：5 点多项式预测 i+0.5 与 Hermite 插值的残差（星历抖动会放大） */
function selfConsistency(set: EphemSet): { rms: number; max: number } {
  const st = set.states
  if (st.length < 5) return { rms: NaN, max: NaN }
  const stride = Math.max(1, Math.floor(st.length / 400))
  let sum2 = 0
  let max = 0
  let n = 0
  for (let i = 2; i < st.length - 2; i += stride) {
    const a = st[i]
    const b = st[i + 1]
    const h = interpolateAt(st, (a.t + b.t) / 2)
    if (!h) continue
    let d2 = 0
    for (let k = 0; k < 3; k++) {
      const poly =
        L5[0] * st[i - 2].r[k] + L5[1] * st[i - 1].r[k] + L5[2] * st[i].r[k] +
        L5[3] * st[i + 1].r[k] + L5[4] * st[i + 2].r[k]
      const d = poly - h.r[k]
      d2 += d * d
    }
    const dist = Math.sqrt(d2)
    sum2 += dist * dist
    if (dist > max) max = dist
    n++
  }
  return n ? { rms: Math.sqrt(sum2 / n), max } : { rms: NaN, max: NaN }
}

function evaluateQuality(set: EphemSet, meta: EphemMeta | null): QualityReport {
  const sc = selfConsistency(set)
  return scoreQuality({
    selfConsistencyRmsKm: sc.rms,
    hasCovariance: meta?.hasCov ?? false,
    spanDays: (set.stop - set.start) / 86400000
  })
}

/** 激活一份星历（服务端序列拉回本机只作展示，不含协方差） */
async function activateById(id: string, meta: EphemMeta | null) {
  ephemBusy.value = true
  ephemError.value = ''
  try {
    const res = await getEphemStates(id, 60)
    const set = statesToSet(id, meta || res.meta, res.t, res.r, res.v)
    if (!set) {
      ephemError.value = '星历状态为空，无法载入'
      return
    }
    activeEphem.value = set
    activeMeta.value = meta || res.meta
    activeQuality.value = evaluateQuality(set, activeMeta.value)
    resetTleDeviation()
    threatList.value = []
    threatSelected.value = null
    screenError.value = ''
    resetManeuver(false)
    maneuverConfig.value.atMs = set.start + 3600e3
    void evaluateTleDeviation(set, activeMeta.value)
    void loadThreatList()
  } catch (e) {
    ephemError.value = (e as Error)?.message || '星历载入失败'
  } finally {
    ephemBusy.value = false
  }
}

/** 按 id 激活（左侧「已上传星历」列表点选 / 热力联动） */
export async function activateEphem(id: string): Promise<boolean> {
  if (!id) return false
  const meta = ephemMetas.value.find((m) => m.id === id)
    || officialMetas.value.find((m) => m.id === id)
    || null
  if (!meta) {
    await refreshEphemList()
  }
  const found = meta || ephemMetas.value.find((m) => m.id === id) || null
  try {
    await activateById(id, found)
  } catch {
    return false
  }
  return activeEphem.value?.id === id
}

/** 载入一份官方星历（最新一轮） */
export async function activateOfficial(meta: EphemMeta) {
  await activateById(meta.id, meta)
}

/** 按 NORAD 定位并载入官方星历（热力 → 星历窗联动用）；找不到返回 false */
export async function openOfficialByNorad(norad: number): Promise<boolean> {
  if (!(norad > 0)) return false
  let hit = officialMetas.value.find((m) => m.norad === norad)
  if (!hit) {
    await refreshOfficial(String(norad), 1)
    hit = officialMetas.value.find((m) => m.norad === norad)
  }
  if (!hit) return false
  await activateOfficial(hit)
  return activeEphem.value?.id === hit.id
}

/** 取消激活：图层 / 质量 / 事件一并清空，文件本身保留 */
export function deactivateEphem() {
  if (!activeEphem.value) return
  activeEphem.value = null
  activeMeta.value = null
  activeQuality.value = null
  resetTleDeviation()
  threatList.value = []
  threatSelected.value = null
  screenError.value = ''
  resetManeuver(false)
}

/* ============================================================
 * 上传
 * ============================================================ */

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 首次上传确认（协议 03 §15.11 第 4 条） */
export function consentUpload(ok: boolean) {
  needConsent.value = false
  if (!ok) {
    pendingFiles = []
    return
  }
  try {
    localStorage.setItem(CONSENT_KEY, '1')
  } catch { /* 隐私模式：仅本次会话生效 */ }
  const files = pendingFiles
  pendingFiles = []
  if (files.length) void doUpload(files)
}

/** 入口：拖拽 / 选择文件（不通过确认时先弹确认卡） */
export function uploadEphemerides(files: File[]) {
  if (!files.length) return
  ephemError.value = ''
  const bad: string[] = []
  const ok: File[] = []
  for (const f of files) {
    if (!ALLOWED_EXT.includes(extOf(f.name))) bad.push(`${f.name}：扩展名需为 ${ALLOWED_EXT.map((e) => `.${e}`).join(' / ')}`)
    else if (f.size > MAX_FILE_MB * 1024 * 1024) bad.push(`${f.name}：文件超过 ${MAX_FILE_MB} MB 上限`)
    else ok.push(f)
  }
  if (bad.length) ephemError.value = bad.join('；')
  if (!ok.length) return
  let consented = false
  try {
    consented = localStorage.getItem(CONSENT_KEY) === '1'
  } catch { /* ignore */ }
  if (!consented) {
    pendingFiles = ok
    needConsent.value = true
    return
  }
  void doUpload(ok)
}

async function doUpload(files: File[]) {
  ephemBusy.value = true
  uploadProgress.value = 0
  const errors: string[] = []
  let lastId = ''
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    uploadName.value = f.name
    try {
      // 本机预检：解析失败直接拦下，避免白传（服务端仍会再校验一次）
      const text = await f.text()
      const res = parseEphemeris(text, { fileName: f.name })
      if (!res.ok || !res.set) {
        const at = res.line ? `（第 ${res.line} 行）` : ''
        throw new Error(`${res.error || '解析失败'}${at}`)
      }
      const up = await uploadEphem(f, res.set.name, (r) => { uploadProgress.value = Math.round(r * 100) })
      lastId = up.ephemId
      if (up.warnings?.length) errors.push(`${f.name}：${up.warnings.join('；')}`)
      // 服务端 NORAD 为准（03 §15.11 第 6 条）
      if (up.norad && res.set.norad && up.norad !== res.set.norad) {
        errors.push(`${f.name}：文件内 NORAD ${res.set.norad} 与服务端 ${up.norad} 不一致，以服务端为准`)
      }
    } catch (e) {
      const msg = (e as { response?: { data?: { msg?: string } } })?.response?.data?.msg
        || (e as Error)?.message || '上传失败'
      errors.push(`${f.name}：${msg}`)
    }
  }
  uploadName.value = ''
  uploadProgress.value = 100
  await refreshEphemList()
  await refreshHealth(true)
  if (errors.length) ephemError.value = errors.join('；')
  if (lastId) await activateEphem(lastId)
  ephemBusy.value = false
}

/** 删除一份已上传星历（界面需二次确认：删除后所有人都看不到） */
export async function removeUploaded(id: string) {
  try {
    await apiDeleteEphem(id)
    if (activeEphem.value?.id === id) deactivateEphem()
    await refreshEphemList()
  } catch (e) {
    ephemError.value = (e as Error)?.message || '删除失败'
  }
}

/* ============================================================
 * 与 TLE 外推的偏差（只作量级参考，不并入总分）
 * ============================================================ */

let tleToken = 0

export function resetTleDeviation() {
  tleToken++
  qualityTle.value = null
  qualityTleBusy.value = false
  qualityTleError.value = ''
  qualityTleNorad.value = 0
  qualityTleNote.value = ''
}

export async function evaluateTleDeviation(set: EphemSet, meta: EphemMeta | null) {
  resetTleDeviation()
  const token = tleToken
  const norad = meta?.norad || set.norad
  qualityTleBusy.value = true
  try {
    if (!norad) {
      qualityTleError.value = '星历未标注 NORAD，无法与 TLE 外推比对'
      return
    }
    qualityTleNorad.value = norad
    const detail = await getSatDetailPublic(norad)
    if (token !== tleToken) return
    if (!detail?.tle_line1 || !detail?.tle_line2) {
      qualityTleError.value = `NORAD ${norad} 在编目中缺少 TLE 两行`
      return
    }
    const res = compareWithTle(set, detail.tle_line1, detail.tle_line2)
    if (token !== tleToken) return
    if (!res) {
      qualityTleError.value = 'SGP4 外推失败或有效样本不足，无法比对'
      return
    }
    qualityTle.value = res
    if (activeQuality.value) {
      activeQuality.value = { ...activeQuality.value, tleRmsKm: res.rmsKm, tleMaxKm: res.maxKm }
    }
  } catch (e) {
    if (token === tleToken) qualityTleError.value = (e as Error)?.message || 'TLE 偏差评估失败'
  } finally {
    if (token === tleToken) qualityTleBusy.value = false
  }
}

/* ============================================================
 * 威胁分析（服务器按需筛查）
 * ============================================================ */

export interface EphemThreat {
  id: number
  kind: Heat2Kind
  selfNorad: number
  otherNorad: number
  otherName: string
  primaryName: string
  /** 最近接近时刻（Unix ms） */
  tca: number
  missKm: number
  relSpeedKmS: number
  pc: number
  pcMax?: number
  level: HeatLevel | null
  /** 主星 TCA 位置（本星历插值；不可用为 null） */
  midEci: Vec3 | null
}

/** 当前查看的计算口径（TLE / AOE）与时间窗 */
export const screenKind = ref<Heat2Kind>('tle')
export const screenWindow = ref<24 | 72 | 168>(24)
export const threatList = ref<EphemThreat[]>([])
export const threatSelected = shallowRef<EphemThreat | null>(null)
export const screenJob = ref<ScreenJob | null>(null)
export const screenError = ref('')
/** 任务状态（queued / running / done / failed / canceled）；null = 未提交 */
export const screenStatus = computed(() => screenJob.value?.status || null)
export const screening = computed(() => screenStatus.value === 'queued' || screenStatus.value === 'running')
/** 已上传星历才能提交按需分析（官方星历已在官方轮次里） */
export const canScreen = computed(() => activeMeta.value?.scope === 'uploaded')

/** 'YYYY-MM-DD HH:mm:ss'(UTC) → Unix ms */
function parseUtcMs(s?: string | null): number {
  if (!s) return NaN
  const ms = Date.parse(`${String(s).replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : NaN
}

const LEVEL_ORDER: Record<string, number> = { red: 0, orange: 1, yellow: 2, insufficient: 3 }

function toThreat(r: Heat2ListItem, kind: Heat2Kind, primaryName: string, set: EphemSet | null): EphemThreat {
  const tca = parseUtcMs(r.tca)
  let mid: Vec3 | null = null
  if (set && Number.isFinite(tca)) {
    const s = interpolateAt(set.states, tca)
    if (s) mid = [s.r[0], s.r[1], s.r[2]]
  }
  return {
    id: r.id,
    kind,
    selfNorad: r.norad_a,
    otherNorad: r.norad_b,
    otherName: r.name_b || `NORAD ${r.norad_b}`,
    primaryName: r.name_a || primaryName,
    tca,
    missKm: r.miss_distance_km,
    relSpeedKmS: r.rel_speed_km_per_s,
    pc: r.collision_probability,
    pcMax: r.pc_max,
    level: levelOfPc(r.collision_probability, r.pc_max),
    midEci: mid
  }
}

/** 主星查询参数：已上传 → ephem:<id>；官方 → official（再按 NORAD 关键词收窄到本星） */
function primaryParamOf(meta: EphemMeta | null): string {
  return meta?.scope === 'uploaded' && meta.id ? `ephem:${meta.id}` : 'official'
}

/** 拉取当前星历的威胁事件列表（与热力标签同一接口） */
export async function loadThreatList() {
  const set = activeEphem.value
  const meta = activeMeta.value
  if (!set || !meta) {
    threatList.value = []
    return
  }
  try {
    const res = await listHeat2({
      kind: screenKind.value,
      primary: primaryParamOf(meta),
      keyword: meta.scope === 'official' && meta.norad ? String(meta.norad) : undefined
    })
    const list = (res.list || [])
      .map((r) => toThreat(r, screenKind.value, set.name, set))
      // TCA 解析失败的事件无法定位与播放，直接丢弃（否则点击后虚拟时钟会被 NaN 污染）
      .filter((e) => Number.isFinite(e.tca))
    list.sort((a, b) => {
      const la = a.level ? (LEVEL_ORDER[a.level] ?? 9) : 9
      const lb = b.level ? (LEVEL_ORDER[b.level] ?? 9) : 9
      return la !== lb ? la - lb : a.tca - b.tca
    })
    threatList.value = list
    const cur = threatSelected.value
    threatSelected.value = cur ? list.find((e) => e.id === cur.id) || null : null
    screenError.value = ''
  } catch {
    // sidecar 未就绪：保留空列表，由面板渲染灰色空状态（不显示旧数据）
    threatList.value = []
  }
}

/** 切换计算口径 / 时间窗后重载列表 */
export async function setScreenKind(kind: Heat2Kind) {
  screenKind.value = kind
  await loadThreatList()
}

/** 提交服务器分析；windowH 超出星历覆盖时面板已置灰，这里只做一次兜底校验 */
export async function submitScreen(kind = screenKind.value, windowH = screenWindow.value): Promise<boolean> {
  const meta = activeMeta.value
  const set = activeEphem.value
  screenError.value = ''
  if (!meta || !set) {
    screenError.value = '请先载入一份星历'
    return false
  }
  if (meta.scope !== 'uploaded') {
    screenError.value = '官方星历已在每日轮次中计算，无需单独提交'
    return false
  }
  if (!(await refreshHealth())) {
    screenError.value = sidecarReason.value === 'CORE_NOT_LOADED'
      ? '核心算法模块未加载，暂不能计算'
      : '热力计算服务未连接'
    return false
  }
  const haveH = (set.stop - set.start) / 3600e3
  const win = Math.min(windowH, Math.floor(haveH))
  if (win < 1) {
    screenError.value = '星历覆盖时长不足 1 小时，无法筛选'
    return false
  }
  try {
    const job = await createScreen({ ephemId: meta.id, kind, windowH: win })
    screenJob.value = job
    screenKind.value = kind
    screenWindow.value = windowH
    void pollScreen(job.jobId)
    return true
  } catch (e) {
    const err = e as { response?: { status?: number; data?: { msg?: string } } }
    const status = err?.response?.status
    if (status === 429) screenError.value = '服务器忙，排队已满，请稍后再试'
    else if (status === 503) screenError.value = '核心算法模块未加载'
    else screenError.value = err?.response?.data?.msg || (e as Error)?.message || '提交失败'
    return false
  }
}

let pollTimer = 0
let pollToken = 0

async function pollScreen(jobId: string) {
  const token = ++pollToken
  window.clearInterval(pollTimer)
  const tick = async () => {
    if (token !== pollToken) return
    try {
      const job = await getScreen(jobId)
      if (token !== pollToken) return
      screenJob.value = job
      if (job.status === 'done') {
        window.clearInterval(pollTimer)
        screenKind.value = job.kind
        await loadThreatList()
      } else if (job.status === 'failed' || job.status === 'canceled') {
        window.clearInterval(pollTimer)
        if (job.status === 'failed') screenError.value = `计算失败${job.errorCode ? `（${job.errorCode}）` : ''}`
      }
    } catch {
      if (token !== pollToken) return
      window.clearInterval(pollTimer)
      screenError.value = '任务状态查询失败'
    }
  }
  pollTimer = window.setInterval(tick, 2000)
  void tick()
}

/** 取消当前任务 */
export async function cancelScreenJob() {
  const job = screenJob.value
  if (!job) return
  try {
    await cancelScreen(job.jobId)
  } catch { /* 已结束的任务取消失败可忽略 */ }
  pollToken++
  window.clearInterval(pollTimer)
  screenJob.value = { ...job, status: 'canceled' }
}

export function selectThreat(ev: EphemThreat | null) {
  threatSelected.value = ev
}

/* ============================================================
 * 机动模拟（本地脉冲机动，仅用于三维双轨迹演示，不参与分级）
 * ============================================================ */

export type ManeuverDir = 'T' | 'R' | 'N'

export const maneuverConfig = ref<{ atMs: number | null; dir: ManeuverDir; dvMps: number }>({
  atMs: null,
  dir: 'T',
  dvMps: 0.2
})
export const maneuverStates = shallowRef<EphemState[] | null>(null)
export const maneuverBurnMs = ref<number | null>(null)
export const maneuverDvMps = ref(0)
export const maneuverError = ref('')

export function applyManeuver(): boolean {
  const set = activeEphem.value
  maneuverError.value = ''
  if (!set) {
    maneuverError.value = '请先载入一份星历'
    return false
  }
  const at = maneuverConfig.value.atMs
  if (at == null || !Number.isFinite(at)) {
    maneuverError.value = '请选择机动时刻'
    return false
  }
  const t0 = set.states.length ? set.states[0].t : set.start
  const t1 = set.states.length ? set.states[set.states.length - 1].t : set.stop
  if (at < t0 || at > t1) {
    maneuverError.value = '机动时刻不在星历数据范围内'
    return false
  }
  const dv = maneuverConfig.value.dvMps
  if (!Number.isFinite(dv) || dv <= 0) {
    maneuverError.value = 'Δv 幅值需大于 0'
    return false
  }
  const vec: Vec3 = maneuverConfig.value.dir === 'R'
    ? [dv, 0, 0]
    : maneuverConfig.value.dir === 'T' ? [0, dv, 0] : [0, 0, dv]
  maneuverStates.value = applyImpulse(set.states, at, vec)
  maneuverBurnMs.value = at
  maneuverDvMps.value = dv
  return true
}

export function resetManeuver(keepConfig = true) {
  maneuverStates.value = null
  maneuverBurnMs.value = null
  maneuverDvMps.value = 0
  maneuverError.value = ''
  if (!keepConfig) maneuverConfig.value = { atMs: null, dir: 'T', dvMps: 0.2 }
}

/* ============================================================
 * 展示辅助
 * ============================================================ */

/** 星历覆盖时长（小时） */
export const activeSpanH = computed(() => {
  const s = activeEphem.value
  return s ? (s.stop - s.start) / 3600e3 : 0
})

/** 官方星历页数 */
export const officialPages = computed(() => Math.max(1, Math.ceil(officialTotal.value / OFFICIAL_PAGE_SIZE)))

/** 已上传星历的显示名（热力主星芯片用） */
export function ephemLabel(id: string): string {
  const m = ephemMetas.value.find((x) => x.id === id)
  return m ? `${m.name}${m.norad ? ` · NORAD ${m.norad}` : ''}` : id.slice(0, 8)
}
