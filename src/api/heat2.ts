/**
 * 安全热力 v2 接口（heat-sidecar，`/cgi2/heat/*`）
 *
 * 两个标签（卫星轨道威胁事件 / 星历增强）的事件由独立计算服务 heat-sidecar 产出：
 *  - 热力云数据：与 /cgi/sat_cdm/heatmap 同构（CdmHeatEvent），前端渲染逻辑完全复用；
 *  - 事件明细：列表渲染用，字段见 Heat2ListItem。
 *
 * 服务未就绪时请求会失败（404 / 连接拒绝），调用方需降级为「服务未就绪」空状态（03 §11.5），
 * 不得显示假数据或旧数据。
 */
import { httpCgi2 } from '@/utils/request'
import type { CdmHeatEvent, HeatDayGroup } from './sat_public'

/** 计算口径：tle-threat = TLE×TLE 自算（quality=tle_only）；tle = 精密星历 × 最新 TLE（quality=eph） */
export type Heat2Kind = 'tle-threat' | 'tle'

/** 热力图返回体（与 /cgi/sat_cdm/heatmap 同构，便于前端复用渲染） */
export interface Heat2HeatmapResult {
  list: CdmHeatEvent[]
  total: number
  days: number
  /** 本次结果对应的计算批次 id */
  run_id?: number | null
  /** 按日分组计数（只接受 1/3/7 天窗口，恒有值） */
  day_groups: HeatDayGroup[]
  /** 结果生成时间（UTC 'YYYY-MM-DD HH:mm:ss'） */
  generated_at?: string | null
  /** 核心是否就绪：false 时前端显示空状态，不展示任何事件 */
  ready?: boolean
  reason?: string | null
  primary_scope?: 'official' | 'uploaded'
  ephem_id?: string | null
}

/** 事件明细行（列表用；不参与三维渲染） */
export interface Heat2ListItem {
  id: number
  tca: string
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  miss_distance_km: number
  rel_speed_km_per_s: number
  collision_probability: number
  pc_max?: number
}

export interface Heat2ListResult {
  list: Heat2ListItem[]
  total: number
  run_id?: number | null
  generated_at?: string | null
}

/** 热力图（三标签中的两个新来源） */
export function getHeat2Map(params: {
  kind: Heat2Kind
  days?: number
  norad?: number
  /** 主星口径：official = 官方星历；ephem:<id> = 某份已上传星历 */
  primary?: string
}) {
  return httpCgi2<Heat2HeatmapResult>({
    url: '/heat/heatmap',
    method: 'get',
    params,
    timeout: 90000
  })
}

/** 健康检查（03 §5）：core 为 stub / error 时 TLE/AOE 标签显示「核心算法模块未加载」 */
export interface Heat2Health {
  status: 'up'
  db: 'up' | 'down'
  core: 'ready' | 'stub' | 'error'
  /** bundled = 内置引擎（未配置 HEAT_CORE_PATH）；external = 私有核心；stub = 空实现 */
  core_kind?: 'bundled' | 'external' | 'stub'
  core_name?: string
  core_version?: string
  time?: string
}
export function getHeat2Health() {
  return httpCgi2<Heat2Health>({ url: '/health', method: 'get', timeout: 10000 })
}

/** 等级档位（来自核心模块 levels()，前端不硬编码门限） */
export interface Heat2LevelBand {
  key: string
  label: string
  color: string
  min: number | null
  max: number | null
}
export interface Heat2Meta {
  /** 兼容两种形态：{bands, missMaxKm} 或直接数组 */
  levels: Heat2LevelBand[] | { bands: Heat2LevelBand[]; missMaxKm: number }
  miss_max_km: number
  hbr_m: number
  tabs: Record<'tle-threat' | 'tle' | 'aoe', { ready: boolean; reason: string | null }>
}
export function getHeat2Meta() {
  return httpCgi2<Heat2Meta>({ url: '/meta', method: 'get', timeout: 10000 })
}

/** 事件明细分页（不分页语义：sidecar 一次返回全量，前端本地虚拟滚动） */
export function listHeat2(params?: {
  kind: Heat2Kind
  keyword?: string
  dateFrom?: string
  dateTo?: string
  level?: string
  /** 主星数据源（03 §15）：official = 官方最新一轮星历，ephem:<id> = 指定已上传星历 */
  primary?: string
}) {
  return httpCgi2<Heat2ListResult>({
    url: '/heat/list',
    method: 'get',
    params,
    timeout: 90000
  })
}

/** 同步状态（数据时效条用） */
export interface Heat2SyncStatus {
  source: string
  last_success_at: string | null
  last_attempt_at: string | null
  state: 'ok' | 'stale' | 'error' | 'skipped'
  message?: string
  rows?: number
  /** 数据现状摘要（最新历元 / 星历轮次与生成时间），UTC */
  detail?: string
  /** TLE / AOE 历元龄期中位数（小时）；仅 gp、aoe 有 */
  median_age_hours?: number | null
  /** 星历生成时间（UTC）；仅 eph 有 */
  generated_at?: string | null
  interval_hours?: number
  last_finished_at?: string | null
  last_status?: number | null
}

/** 事件详情（星历标签用：miss 的 R/T/N 分量、PcMax、双方 σ 来源、龄期、官方 CDM 对比） */
export interface Heat2EventDetail {
  id: number
  run_id: number
  kind: 'tle-threat' | 'tle' | 'aoe'
  tca: string
  primary: {
    norad: number | null
    meme_id: number | null
    name: string | null
    /** 本星精密星历生成时间（UTC） */
    eph_created: string | null
    /** 本星精密星历生成至 TCA 的龄期（小时） */
    eph_age_h: number | null
    /** 本星沿迹方向 σ（km，由精密星历协方差投影；历史事件可能为空） */
    sigma_t_km: number | null
  }
  secondary: {
    norad: number | null
    name: string | null
    /** 对方根数来源：tle = Space-Track 最新 TLE；aoe = AOE 编目根数 */
    src: string | null
    /** 对方根数历元（UTC） */
    epoch: string | null
    /** 对方根数历元至 TCA 的龄期（小时） */
    age_h: number | null
    /** 对方沿迹方向 σ（km） */
    sigma_t_km: number | null
  }
  miss: {
    total_km: number | null
    /** 径向分量 */
    r_km: number | null
    /** 沿迹分量 */
    t_km: number | null
    /** 法向分量 */
    n_km: number | null
    rel_speed_kms: number | null
  }
  pc: {
    value: number | null
    /** Alfano 缩放上界 */
    max: number | null
    method: string
    hbr_m: number | null
    level: string | null
    /** Pc 极低但 PcMax 达高危门限：协方差不足以支撑「安全」结论 */
    diluted: boolean
    sigma_p_src: string | null
    sigma_s_src: string | null
  }
  /** 匹配到的官方 CDM（NORAD 无序对 + |ΔTCA| ≤ 120 s）；无则 null */
  cdm: { cdm_id: string; pc: number | null; miss_km: number | null; dtca_s: number | null } | null
  frames: { compute: string; render: string }
}

export function getHeat2SyncStatus() {
  return httpCgi2<{ list: Heat2SyncStatus[]; generated_at?: string }>({ url: '/sync/status', method: 'get' })
}

/** 事件详情（点击热力云 / 列表项后按 id 拉取） */
export function getHeat2Event(id: number) {
  return httpCgi2<Heat2EventDetail>({ url: `/heat/event/${id}`, method: 'get', timeout: 20000 })
}

/* ============================================================
 * 星历分析（03 §15.7）：上传 / 官方星历 / 按需筛查任务
 * ============================================================ */

export interface EphemMeta {
  id: string
  scope: 'uploaded' | 'official'
  name: string
  norad: number | null
  meme: number | null
  format: string
  points: number
  stepS: number
  hasCov: boolean
  startUtc: string | null
  stopUtc: string | null
  createdUtc: string | null
  expiresAt: string | null
  sizeBytes?: number
}

export interface EphemListResult {
  list: EphemMeta[]
  total: number
  scope: string
  page: number
  pageSize: number
}

export function listEphem(params: {
  scope: 'uploaded' | 'official'
  keyword?: string
  page?: number
  pageSize?: number
}) {
  return httpCgi2<EphemListResult>({ url: '/ephem/list', method: 'get', params, timeout: 20000 })
}

export function getEphem(id: string) {
  return httpCgi2<EphemMeta>({ url: `/ephem/${encodeURIComponent(id)}`, method: 'get', timeout: 15000 })
}

/** 上传星历（multipart，字段 file + 可选 name） */
export interface EphemUploadResult {
  ephemId: string
  name: string
  norad: number | null
  meme: number | null
  format: 'itc' | 'oem' | 'ocm'
  points: number
  stepS: number
  hasCov: boolean
  startMs: number
  stopMs: number
  expiresAt: string | null
  warnings: string[]
}

export function uploadEphem(file: File, name?: string, onProgress?: (ratio: number) => void) {
  const fd = new FormData()
  fd.append('file', file)
  if (name) fd.append('name', name)
  return httpCgi2<EphemUploadResult>({
    url: '/ephem/upload',
    method: 'post',
    data: fd,
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total)
    }
  })
}

/** 位置/速度序列（t: unix ms；r/v: km、km/s） */
export interface EphemStates {
  id: string
  meta: EphemMeta | null
  t: number[]
  r: number[]
  v: number[]
  stepS: number
}

export function getEphemStates(id: string, stepS = 60) {
  return httpCgi2<EphemStates>({
    url: `/ephem/${encodeURIComponent(id)}/states`,
    method: 'get',
    params: { stepS },
    timeout: 30000
  })
}

export function deleteEphem(id: string) {
  return httpCgi2<{ deleted: boolean; id: string }>({
    url: `/ephem/${encodeURIComponent(id)}`,
    method: 'delete',
    timeout: 20000
  })
}

export type ScreenJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface ScreenJob {
  jobId: string
  ephemId: string
  kind: Heat2Kind
  windowH: number
  status: ScreenJobStatus
  progress: number
  runId: number | null
  nEvents: number | null
  errorCode: string | null
  message: string
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  queuePosition?: number
  reused?: boolean
}

export function createScreen(payload: { ephemId: string; kind: Heat2Kind; windowH: number }) {
  return httpCgi2<ScreenJob>({ url: '/screen', method: 'post', data: payload, timeout: 20000 })
}

export function getScreen(jobId: string) {
  return httpCgi2<ScreenJob>({ url: `/screen/${encodeURIComponent(jobId)}`, method: 'get', timeout: 15000 })
}

export function cancelScreen(jobId: string) {
  return httpCgi2<{ canceled: boolean }>({
    url: `/screen/${encodeURIComponent(jobId)}/cancel`,
    method: 'post',
    timeout: 15000
  })
}

