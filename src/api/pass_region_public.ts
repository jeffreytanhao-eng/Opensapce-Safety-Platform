/**
 * 前台区域过境分析接口（/cgi 免登录）
 * 供 /situation「区域过境」面板（RegionPanel → RegionSection）消费：
 *   1) /cgi/pass/region/scan      提交框选多边形 → 后端先把顶点写入区域库（同顶点集合去重复用），再按客户端排队（异步，立即返回）
 *   2) /cgi/pass/region/progress  2s 轮询进度与最近日志（按客户端 key 隔离，只返回本客户端任务的进度）
 *   3) /cgi/pass/region/cancel    取消本客户端排队中 / 运行中的任务
 *   4) /cgi/pass/region/result    按批次取过境明细
 *   5) /cgi/pass/region/stats     概览（过境次数 / 满覆盖次数 / 最佳覆盖率 / 运行态）
 *   6) /cgi/pass/region/regions   区域库（已存区域，可直接选来算；含前台框选自动入库的条目）
 *   7) /cgi/pass/region/sensors   卫星载荷参数（幅宽 / 最大侧摆 / 来源），说明本次按什么参数判定
 *
 * 多客户端隔离（进程级只有一个扫描在跑，靠队列按「客户端 key」分配各自的槽位与进度）：
 *   - key 由前端 utils/clientKey.ts 生成（存 sessionStorage），每次请求带上；缺失时后端按 IP 兜底；
 *   - 提交时若已有任务在跑，本次会进入排队（stage='queued'），progress 里带 queue.position / ahead；
 *   - progress 只反映「本客户端」的任务：running / queued / done / error 都按自己的 key 判定，
 *     owned=false 表示本客户端当前无任务（服务器可能在跑别人的任务）。
 *
 * 判定口径与后端 lib/passRegionScan.js 一致：
 *   ① 过境判定：以星下点为中心、半径 halfW = 幅宽/2 + 最大侧摆可达地面偏移 的地面判定圆与多边形相交即算一次过境（部分覆盖即算）；
 *   ② 覆盖率：单帧最大同时覆盖 —— 边长 = 幅宽 W 的方形成像足迹（中心按所需侧摆横向偏移星下点）
 *      在窗口内「单帧最多能同时盖住多少采样点」的占比，不再是窗口累积并集，仅作展示过滤，不进算法门限。
 *   结果附 required_roll_deg（所需最小侧摆）与 coverage_pct（单帧最大同时覆盖率）。
 */
import { httpCgi } from '@/utils/request'
import { getClientKey } from '@/utils/clientKey'

/** 多边形顶点 [经度, 纬度] */
export type RegionPolygon = number[][]

/** 队列位置信息（提交进度 / 查询进度时返回） */
export interface ScanQueuePos {
  /** 队列位置：1 = 队首（正在跑或下一个跑）；>1 = 前面还有 position-1 个任务 */
  position: number
  /** 前面还有几个任务 */
  ahead: number
}

/** 提交扫描的响应：
 *  - started=true：本次已受理（running=true 表示正在跑、queued=true 表示已进入排队）；
 *  - started=false + already=true：本客户端已有一个相同/在途任务（返回其现状，不重复提交）；
 *  - cached=true：命中 10 分钟结果缓存（直接取 run_id 的结果） */
export interface RegionScanSubmit {
  started: boolean
  running: boolean
  cached: boolean
  /** true = 已进入排队（前面还有任务），等轮到自己会自动开跑 */
  queued?: boolean
  /** started=false 时：本客户端已提交过、本次属于重复提交 */
  already?: boolean
  run_id: number | null
  /** 本次扫描所用区域在区域库（pass_region）里的 id：框选提交时后端已自动入库，可直接用于刷新区域库下拉 */
  region_id?: number | null
  /** true = 本次新写入区域库；false = 复用了已有条目（同一顶点集合去重） */
  region_saved?: boolean
  /** 队列位置（1 = 队首） */
  position?: number
  /** 前面还有几个任务 */
  ahead?: number
}

/** 扫描进度（/progress 返回，含最近日志；按客户端 key 隔离，只反映本客户端的任务） */
export interface RegionProgress {
  running: boolean
  restored: boolean
  stage: string
  /** 阶段：idle / queued / plan / scan / done / error / cancelled 等 */
  stageLabel: string
  percent: number
  detail: string
  /** 参与扫描的卫星数（命中 sat_sensor 载荷参数者） */
  matched: number
  processed: number
  found: number
  /** 因未匹配到载荷参数而跳过的卫星数 */
  skippedNoSensor: number
  elapsed: number
  eta: number
  startedAt: number
  runId: number | null
  message: string
  /** true = 本客户端当前有任务（排队中 / 运行中 / 刚结束）；false = 本客户端无任务（服务器可能在跑别人的） */
  owned?: boolean
  /** 本客户端任务正在排队 */
  queued?: boolean
  /** 排队位置信息（queued 时有意义） */
  queue?: ScanQueuePos
  logs: { time: string; level: string; text: string }[]
  logUrl: string
}

/** 过境明细行（pass_region_access） */
export interface RegionAccessItem {
  norad_id: number
  object_name: string
  sensor_code: string
  sensor_name: string
  sensor_type: string
  /** 成像幅宽（km） */
  swath_km: number
  /** 最大侧摆（°） */
  max_roll_deg: number
  /** 判定半带宽（km）= 幅宽/2 + 侧摆可达地面偏移 */
  half_width_km: number
  /** 1 = 该星未匹配到载荷参数，本行按本次扫描的「默认幅宽/侧摆」估算；0 = 取到真实参数 */
  sensor_missing: number
  aos_ms: number
  los_ms: number
  duration_sec: number
  /** 窗口内星下点到区域边界的最短地面距离（km） */
  min_dist_km: number
  /** 该次过境所需最小侧摆（°）；0 = 星下点直接扫到 */
  required_roll_deg: number
  /** 单帧最大同时覆盖率（%）：边长=幅宽 W 的方形成像足迹在窗口内单帧同时命中的采样点数最大值 / 采样点总数；
   *  可能为 null（区域过小无采样点）。仅作展示/过滤，不进算法门限。 */
  coverage_pct: number | null
  /** 单帧同时命中采样点数最多那一帧的时刻（ms） */
  max_cover_at_ms: number | null
  sample_total: number
  /** 覆盖率对应的那一帧同时命中的采样点数 */
  sample_covered: number
  /** 该帧足迹中心相对星下点的横向偏移（km），按 required_roll_deg 侧摆得到 */
  frame_offset_km: number | null
  /** ---- 光照条件（区域中心，取最佳覆盖时刻；算法见 server/lib/illumination.js）----
   *  口径与城市过境相反：区域过境是「卫星拍地面」，判据是地面是否被太阳照亮；
   *  光照条件上线前落库的老批次这些字段为空。 */
  /** 区域中心在最佳覆盖时刻的太阳高度角（°，可能为负） */
  sun_elev_deg: number | null
  /** 光照档：day / civil / nautical / astronomical / night */
  twilight: 'day' | 'civil' | 'nautical' | 'astronomical' | 'night' | null
  /** 1 = 区域中心太阳在地平线以上（白天侧） */
  ground_lit: number | null
  /** 1 = 区域中心太阳高度 ≥ 10°，可光学成像；0 = 需 SAR/夜光或另选窗口 */
  optical_ok: number | null
  /** 卫星自身地影：sunlit / penumbra / umbra（供电/热控参考，不参与成像判定） */
  sat_shadow_state: 'sunlit' | 'penumbra' | 'umbra' | null
  /** 扫描当时所用根数快照（报告只读快照排版，绝不用当前 TLE 重算） */
  tle_line1: string
  tle_line2: string
  tle_epoch_ms: number | null
}

/** 过境结果（/result 返回） */
export interface RegionResult {
  run_id: number | null
  region: {
    id: number
    name: string
    centerLon: number
    centerLat: number
    areaKm2: number
    /** 本次扫描所用区域顶点（[[经度,纬度],...]）；老批次无记录时为空数组 */
    polygon: RegionPolygon
  } | null
  windowHours: number
  stepSec: number
  refineSec: number
  totalSats: number
  skippedNoSensor: number
  /** 本次批次给「缺参数卫星」用的兜底幅宽/侧摆（0 = 未启用兜底） */
  defaultSwathKm: number
  defaultRollDeg: number
  computedAt: string | null
  list: RegionAccessItem[]
  total: number
  page: number
  pageSize: number
}

/** 区域过境概览（/stats） */
export interface RegionStats {
  regions: number
  sensors: number
  runId: number | null
  running: boolean
  total: number
  fullCover: number
  bestCoverage: number | null
  firstAos: number | null
  lastAos: number | null
  computedAt: string | null
  regionName: string
  regionId: number
  windowHours: number
  stepSec: number
  refineSec: number
  /** 已匹配到型号参数、可直接参与扫描的卫星数 */
  matchedSats: number
  /** 未匹配到型号参数、需按「默认幅宽/侧摆」兜底才参与的卫星数 */
  noSensorSats: number
  /** 上次批次用的兜底参数（0 = 未启用） */
  defaultSwathKm: number
  defaultRollDeg: number
  /** 兜底参数的算法缺省值（面板输入框初值） */
  fallbackSwathKm: number
  fallbackRollDeg: number
  /** TLE 时效提示：候选集中 epoch 距今超过 days 天的卫星数（仅提示，不影响扫描范围） */
  staleTle: { days: number; count: number; oldestDays: number | null }
}

/** 区域库条目（/regions） */
export interface RegionItem {
  id: number
  name: string
  /** 已解析为数组的顶点 */
  polygon: RegionPolygon
  point_count: number
  center_lon: number
  center_lat: number
  radius_km: number
  area_km2: number
  remark: string
}

/** 载荷参数条目（/sensors） */
export interface RegionSensorItem {
  id: number
  code: string
  name: string
  name_en: string
  swath_km: number
  max_roll_deg: number
  sensor_type: string
  source_url: string
}

/** 提交区域过境扫描（异步：立即返回，进度用 getRegionProgress 轮询）
 *  - 若服务器已有任务在跑，本次**进入排队**（返回 queued=true / position / ahead），轮到自己时自动开跑；
 *  - key：客户端隔离标识（前端自动带上，后端据此分配独立槽位与进度），无需调用方关心。
 *  缺参数兜底：use_default_sensor 不传 = 启用，未匹配到载荷参数的卫星按 default_swath_km /
 *  default_roll_deg 参与（结果行标 sensor_missing=1）；显式传 false 则回到「无参数即不参与」。
 *  top_n 不传 = 不限制条数（按真实命中量全部落库）。 */
export function submitRegionScan(data: {
  region_id?: number
  name?: string
  polygon?: RegionPolygon
  window_hours?: number
  top_n?: number
  use_default_sensor?: boolean
  default_swath_km?: number
  default_roll_deg?: number
}) {
  return httpCgi<RegionScanSubmit>({ url: '/pass/region/scan', method: 'post', data: { ...data, key: getClientKey() } })
}

/** 扫描进度 + 最近日志（前端 2s 轮询；按客户端 key 隔离，只返回本客户端任务的进度） */
export function getRegionProgress() {
  return httpCgi<RegionProgress>({ url: '/pass/region/progress', method: 'get', params: { key: getClientKey() } })
}

/** 取消本客户端排队中 / 运行中的区域过境扫描 */
export function cancelRegionScan() {
  return httpCgi<{ cancelled: boolean }>({ url: '/pass/region/cancel', method: 'post', data: { key: getClientKey() } })
}

/** 过境结果（不传 run_id 取最近有数据的批次）
 *  pageSize 传 0 = 不限（一次取回本批次全部明细，仅受后端行数保护上限约束） */
export function getRegionResult(params?: {
  run_id?: number
  page?: number
  pageSize?: number
  /** 名称 / NORAD 号关键字：纯数字按 NORAD 号匹配，否则按名称模糊匹配 */
  object_name?: string
  sensor_type?: string
  min_coverage?: number
  /** 传 1 = 只看光学可成像的过境（区域中心太阳高度 ≥ 10°） */
  optical?: number
  order?: 'time' | 'coverage'
}) {
  return httpCgi<RegionResult>({ url: '/pass/region/result', method: 'get', params })
}

/** 区域过境概览 */
export function getRegionStats(params?: { run_id?: number }) {
  return httpCgi<RegionStats>({ url: '/pass/region/stats', method: 'get', params })
}

/** 区域库列表（可选已存区域直接计算） */
export function getRegionList(params?: { name?: string }) {
  return httpCgi<RegionItem[]>({ url: '/pass/region/regions', method: 'get', params })
}

/** 卫星载荷参数列表（展示判定依据） */
export function getRegionSensors() {
  return httpCgi<RegionSensorItem[]>({ url: '/pass/region/sensors', method: 'get' })
}
