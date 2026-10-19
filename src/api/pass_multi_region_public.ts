/**
 * 多区域过境（前台公开接口 /cgi/pass/multi_region/*）
 *
 * 与「区域过境」(/cgi/pass/region/*) 是**两套独立接口**（各自的进度、批次、明细表），
 * 前端也分属两个面板；后端算法口径相同（同一份 lib/passRegionScan.js 几何与判定），
 * 但编排与落库隔离，互不阻塞、互不串数据。
 */
import { httpCgi } from '@/utils/request'
import { getClientKey } from '@/utils/clientKey'

/** 提交给后端的区域（polygon 为 [[lon,lat],...]；region_id > 0 表示选自区域库） */
export interface MultiRegionAreaInput {
  name: string
  polygon: [number, number][]
  region_id?: number
}

/** 区域库行（供「选已存区域」；polygon 为该区域的 [[lon,lat],...] 顶点，用于选中后在地球上回显） */
export interface RegionLibItem {
  id: number
  name: string
  /** 顶点：JSON 列可能返回字符串，也可能被驱动解析成数组，前端需兼容两种 */
  polygon: string | [number, number][]
  center_lon: number
  center_lat: number
  radius_km: number
  area_km2: number
  point_count: number
}

/** 已保存的多区域组合 */
export interface MultiRegionLibItem {
  id: number
  name: string
  area_count: number
  vertex_total: number
  area_km2_total: number
  remark: string
  created_text: string
}

/** 扫描进度（与区域过境的进度结构同形，便于复用同一套终端面板；按客户端 key 隔离） */
export interface MultiRegionProgress {
  running: boolean
  /** true = 后端刚重启、内存态为空，回退展示的历史快照（非本客户端实时进度） */
  restored: boolean
  stage: string
  stageLabel: string
  percent: number
  detail: string
  matched: number
  areaCount: number
  processed: number
  found: number
  skippedNoSensor: number
  elapsed: number
  eta: number
  startedAt: number
  runId: number | null
  message: string
  /** true = 本客户端当前有任务；false = 本客户端无任务（服务器可能在跑别人的） */
  owned?: boolean
  /** 本客户端任务正在排队 */
  queued?: boolean
  /** 排队位置信息（queued 时有意义） */
  queue?: { position: number; ahead: number }
  logs?: { time: string; level: string; text: string }[]
  logUrl?: string
}

/** 每条同时覆盖记录 */
export interface CoverageGroup {
  norad_id: number
  object_name: string
  start_ms: number
  end_ms: number
  span_sec: number
  area_count: number
  max_coverage_pct: number | null
  min_coverage_pct: number | null
  /** 各区域「最佳覆盖时刻」跨度（ms）：越小越可能一次成像同时覆盖 */
  cover_span_ms: number | null
  areas: {
    area_index: number
    area_name: string
    aos_ms: number | null
    los_ms: number | null
    max_cover_at_ms: number | null
    coverage_pct: number | null
    min_dist_km: number | null
    /** 以下为三维回显各区域扫描条带所需的判定口径（与明细行同名同义；
     *  老批次未落这些字段时为 null，此时只能画出该区域的星下点轨迹） */
    swath_km: number | null
    max_roll_deg: number | null
    half_width_km: number | null
    required_roll_deg: number | null
    sensor_missing: number
  }[]
}

/** 同时覆盖分析结果 */
export interface CoverageAnalysis {
  scan_id: number
  minAreas: number
  satCount: number
  groupCount: number
  maxAreas: number
  byArea: { area_index: number; area_name: string; groups: number }[]
  groups: CoverageGroup[]
  truncated: boolean
}

/** 一条过境明细（字段与 /cgi/pass/multi_region/result 的 SELECT 一致，与「区域过境」同名同义） */
export interface MultiRegionAccessItem {
  area_index: number
  area_name: string
  norad_id: number
  object_name: string
  /** 载荷型号：未匹配到时为空串，靠 sensor_missing 区分「按默认值估算」 */
  sensor_name: string
  sensor_type: string
  swath_km: number
  max_roll_deg: number
  /** 判定半带宽 = 幅宽/2 + 侧摆可达地面偏移 */
  half_width_km: number
  /** 1 = 该星未匹配到载荷参数，本行按本次扫描的默认幅宽/侧摆估算 */
  sensor_missing: number
  aos_ms: number | null
  los_ms: number | null
  duration_sec: number
  min_dist_km: number | null
  required_roll_deg: number | null
  coverage_pct: number | null
  max_cover_at_ms: number | null
  sample_total: number
  sample_covered: number
  frame_offset_km: number | null
  /** 区域中心太阳高度角（地面是否被照亮，光学成像判据） */
  sun_elev_deg: number | null
  twilight: string | null
  ground_lit: number | null
  optical_ok: number | null
  /** 卫星自身是否在地球阴影（只影响供电/热控，不影响成像判定） */
  sat_shadow_state: string | null
  tle_epoch_ms: number | null
}

/** 扫描结果 */
export interface MultiRegionResult {
  scan: {
    id: number
    name: string
    multi_region_id: number
    area_count: number
    total_sats: number
    total_passes: number
    window_hours: number
    start_ms: number | null
    step_sec: number
    refine_sec: number
    /** 本批次落库的兜底幅宽 / 侧摆快照（0 = 未启用兜底，或启用但按 0km 点模型） */
    default_swath_km: number
    default_roll_deg: number
    /** 本批次「无载荷参数」被整颗跳过的判定次数（勾选默认值时为 0） */
    skipped_no_sensor: number
    duration: number
    status: number
    message: string
    created_text: string
  } | null
  areas: { name: string; area_index: number; polygon: [number, number][] }[]
  summary: {
    area_index: number
    area_name: string
    passes: number
    max_coverage: number | null
    first_aos_ms: number | null
    last_aos_ms: number | null
    sats: number
  }[]
  list: MultiRegionAccessItem[]
  total: number
  page: number
  pageSize: number
}

/** 概览：区域库规模 / 已存组合数 / 最近批次 / 限额 */
export function getMultiRegionStats() {
  return httpCgi<{
    regionCount: number
    multiRegionCount: number
    lastScan: Record<string, unknown> | null
    limits: { maxAreasPerSave: number; maxAreasPerScan: number; windowHours: number; stepSec: number; refineSec: number }
    running: boolean
  }>({ url: '/pass/multi_region/stats', method: 'get' })
}

/** 区域库列表（选已存区域组成多区域） */
export function listRegionLib(params?: { keyword?: string }) {
  return httpCgi<RegionLibItem[]>({ url: '/pass/multi_region/regions', method: 'get', params })
}

/** 已存多区域组合列表 */
export function listMultiRegionLib() {
  return httpCgi<MultiRegionLibItem[]>({ url: '/pass/multi_region/multi_regions', method: 'get' })
}

/** 保存多区域组合（框选区域会同步补进区域库，同顶点复用） */
export function saveMultiRegion(data: { name: string; remark?: string; areas: MultiRegionAreaInput[] }) {
  return httpCgi<{ id: number; area_count: number; vertex_total: number; region_saved: number }>({
    url: '/pass/multi_region/save', method: 'post', data
  })
}

/** 提交多区域扫描（multi_region_id 与 areas 二选一）
 *
 * ⚠ 字段命名必须与后端 normalizeRegionScanOpts 一致：**下划线命名**。
 *   后端只读 use_default_sensor / default_swath_km / default_roll_deg；
 *   若传成驼峰，这三个值会被静默忽略（永远用默认：启用兜底 + 100km + 0°）—— 曾踩过此坑。
 *
 * 缺参数兜底口径（与「区域过境」同一份实现）：
 *   · use_default_sensor = true（默认）：未匹配到载荷参数的卫星按 default_swath_km / default_roll_deg 参与判定，
 *     结果行标 sensor_missing=1；
 *   · use_default_sensor = false：**只统计有载荷参数的卫星**，无参数的整颗跳过（计入「无参数跳过」）。
 *
 * 排队：若服务器已有任务在跑，本次进入排队（queued=true / position / ahead），轮到自己时自动开跑；
 * key 为客户端隔离标识（前端自动带上，后端据此分配独立槽位与进度）。
 */
export function submitMultiRegionScan(data: {
  multi_region_id?: number
  areas?: MultiRegionAreaInput[]
  window_hours?: number
  step_sec?: number
  refine_sec?: number
  top_n?: number
  use_default_sensor?: boolean
  default_swath_km?: number
  default_roll_deg?: number
}) {
  return httpCgi<{
    started: boolean
    running: boolean
    cached: boolean
    /** true = 已进入排队（前面还有任务） */
    queued?: boolean
    /** started=false 时：本客户端已提交过、本次属于重复提交 */
    already?: boolean
    scan_id: number | null
    area_count?: number
    /** 队列位置（1 = 队首） */
    position?: number
    /** 前面还有几个任务 */
    ahead?: number
  }>({
    url: '/pass/multi_region/scan', method: 'post', data: { ...data, key: getClientKey() }
  })
}

/** 已存组合详情（含各区域快照顶点，用于载入后在地球上回显并可继续编辑） */
export function getMultiRegionLibDetail(id: number) {
  return httpCgi<{
    id: number
    name: string
    remark: string
    area_count: number
    vertex_total: number
    area_km2_total: number
    areas: MultiRegionAreaInput[]
  }>({ url: '/pass/multi_region/multi_region_detail', method: 'get', params: { id } })
}

/** 扫描进度 + 最近日志（按客户端 key 隔离，只返回本客户端任务的进度） */
export function getMultiRegionProgress() {
  return httpCgi<MultiRegionProgress>({ url: '/pass/multi_region/progress', method: 'get', params: { key: getClientKey() } })
}

/** 取消本客户端排队中 / 运行中的多区域扫描 */
export function cancelMultiRegionScan() {
  return httpCgi<{ cancelled: boolean }>({ url: '/pass/multi_region/cancel', method: 'post', data: { key: getClientKey() } })
}

/** 扫描结果（按区域汇总 + 明细分页；object_name = 名称或 NORAD 号模糊搜索，服务端过滤） */
export function getMultiRegionResult(params?: {
  scan_id?: number
  area_index?: number
  page?: number
  pageSize?: number
  object_name?: string
}) {
  return httpCgi<MultiRegionResult>({ url: '/pass/multi_region/result', method: 'get', params })
}

/** 多区域「同时覆盖」分析（同一颗星在重叠时间窗内命中 ≥ min_areas 个区域） */
export function getMultiRegionCoverage(params?: { scan_id?: number; min_areas?: number }) {
  return httpCgi<CoverageAnalysis>({ url: '/pass/multi_region/coverage_analysis', method: 'get', params })
}
