/**
 * 前台过境分析接口（/cgi 免登录）
 * 供 /situation「过境分析」三维地球页面消费：
 *   1) /cgi/pass/map          行政区划面 + 国界 + 城市标注一次性下发（贴图绘制，静态地理数据）
 *   2) /cgi/pass/batches      最近 N 个「有汇总数据」的成功批次（面板「数据批次」下拉回看）
 *   3) /cgi/pass/city_ids     指定批次有明细的目标 id 集合（前端过滤目标列表 / 地球面层着色）
 *   4) /cgi/pass/city/:id     点击目标（中国某市 / 某国）→ 该目标指定批次未来 24h 过境明细（只读 pass_detail）
 *   5) /cgi/pass/summary/list 各目标过境汇总（读 pass_info 指定批次）
 * 算法口径与后端 lib/passScan.js 一致：目标 = 行政区划面 / 国界面（面，不是「点画圆」），
 * 判定 = 卫星可见圈（仰角 ≥ 10°）与目标多边形相交；仅 PAYLOAD、窗口 24h。
 */
import { httpCgi } from '@/utils/request'

/** 国界要素（多环经纬度坐标，等距圆柱投影后可贴到地球纹理同坐标系） */
export interface PassBorderItem {
  id: number
  name: string
  name_en: string
  /** 中文名（内置词典生成，未收录为空字符串） */
  name_cn: string
  country: string
  iso_a2: string
  /** 几何外接框中心经度（°）：国界面作为过境目标时的落点中心 */
  longitude: number | null
  /** 几何外接框中心纬度（°） */
  latitude: number | null
  /** 多环坐标：[[[lon,lat], ...], ...] */
  rings: number[][][]
}

/** 中国行政区划面要素（过境分析在中国境内的目标：地级市 / 直辖市港澳台整体） */
export interface PassDistrictItem {
  id: number
  name: string
  /** 中文名（源数据即中文，始终有值） */
  name_cn: string
  /** 国标 6 位行政区划代码 */
  adcode: string
  /** city=地级市 / province=省级整体（直辖市、港澳台无市级下级数据时退化为整省）
   *  / province_agg=省级聚合面（不参与扫描，过境数据由下辖地级市聚合，仅用于整省高亮与省级汇总） */
  level: string
  /** 所属省级政区名 */
  province: string
  province_adcode: string
  /** 几何外接框中心经度（°） */
  longitude: number | null
  /** 几何外接框中心纬度（°） */
  latitude: number | null
  /** 多环坐标：[[[lon,lat], ...], ...] */
  rings: number[][][]
}

/** 城市标注点（仅三维标注，不参与过境判定） */
export interface PassCityItem {
  id: number
  name: string
  name_en: string
  /** 中文名（内置词典生成；1249 座城市中约 506 座有值，「首都或人口>=100万」的 395 座主要城市全覆盖，未收录为空字符串） */
  name_cn: string
  country: string
  iso_a2: string
  longitude: number
  latitude: number
  population: number | null
  /** Natural Earth featureclass（首都 / 省会等） */
  featureclass: string
}

/**
 * 过境目标面（前端合成）：中国用行政区划面（district），其他国家用国界面（border）；
 * 中国的国界不参与过境（只用于地表描边），故不进入本列表。
 * 与后端 lib/passScan.js 的 loadTargets 完全同口径。
 */
export interface PassTargetItem {
  /** pass_geo.id（调 /cgi/pass/city/:id 用它） */
  id: number
  geo_type: 'district' | 'border' | 'province_agg'
  name: string
  name_cn: string
  name_en: string
  country: string
  /** 仅 district：国标 6 位行政区划码 */
  adcode: string
  /** 仅 district：city=地级市 / province=省级整体 / province_agg=省级聚合面 */
  level: string
  /** 仅 district：所属省级名称 */
  province: string
  /** 仅 district：所属省级 6 位行政区划码（按省聚合 / 定位整省面用） */
  province_adcode: string
  /** 落点中心经纬度（°）：用于列表展示与镜头定位 */
  longitude: number
  latitude: number
  /** 多环经纬度坐标：用于绘制边界、面高亮与点选拾取 */
  rings: number[][][]
}

export interface PassMapResult {
  borders: PassBorderItem[]
  districts: PassDistrictItem[]
  /** 省级聚合面（level='province_agg'）：不参与拾取，仅用于「整省高亮」与面板省级汇总 */
  provinces: PassDistrictItem[]
  cities: PassCityItem[]
  stats: { borders: number; districts: number; provinces: number; cities: number; targets: number }
}

/** 过境数据批次条目（/cgi/pass/batches 下发，供前台「数据批次」下拉回看历史批次） */
export interface PassBatchItem {
  id: number
  /** 汇总完成时间（DB created_at，YYYY-MM-DD HH:mm:ss） */
  created_at: string
  /** 参与汇总的城市数 */
  total_cities: number
  /** 有过境（至少一次可见）的城市数 */
  with_pass: number
  /** 过境总次数 */
  total_passes: number
  /** 落库明细条数 */
  detail_saved: number
  /** 窗口（小时） */
  window_hours: number
  /** 仰角门限（°） */
  min_elev: number
}

/** 单次过境明细（时间均为 unix ms，前端自行格式化） */
export interface PassDetailItem {
  norad_id: number
  object_name: string
  /** 入境时刻 AOS */
  aosMs: number
  /** 出境时刻 LOS */
  losMs: number
  /** 可见时长（秒） */
  durationSec: number
  /** 最大仰角（°） */
  maxElev: number
  /** 最大仰角出现时刻 */
  maxAtMs: number
  /** 最大仰角处方位角（°） */
  maxAz: number
  /** 最近距离（km，最大仰角处斜距） */
  minRange: number
  /** 光照条件（最大仰角时刻代表值，算法见 server/lib/illumination.js）。
   *  光照条件上线前落库的老批次为 null，前端显示「—」。 */
  /** 目标光照：sunlit 被太阳照亮 / penumbra 地球半影 / umbra 地球本影 */
  shadowState: 'sunlit' | 'penumbra' | 'umbra' | null
  /** 被太阳照亮比例（0 全黑 ~ 1 全照） */
  sunlitFraction: number | null
  /** 相位角（°）：目标-太阳-观测者夹角，越大越接近只见背光面 */
  phaseAngle: number | null
  /** 观测点太阳高度角（°） */
  sunElev: number | null
  /** 暮光档：day / civil / nautical / astronomical / night */
  twilight: 'day' | 'civil' | 'nautical' | 'astronomical' | 'night' | null
  /** 月相被照亮比例（0 新月 ~ 1 满月） */
  moonIllum: number | null
  /** 目标与月亮的角距（°），越小月光干扰越大 */
  moonSep: number | null
  /** 月光背景指数（0~1 工程启发式，非定量信噪比） */
  moonBg: number | null
  /** 可成像判定：1 = 目标被照亮 且 观测站为天文夜 且 月光背景低 */
  opticalOk: number | null
  /** 仅省级聚合明细：该次过境所属的过境城市名（省级聚合按卫星去重后保留最大仰角的那座市） */
  cityName?: string
}

/** 该目标预计算的汇总行（pass_info；点击时可能尚未跑过汇总任务，故为 null） */
export interface PassSummaryRow {
  total_passes: number
  visible_sats: number
  best_sat_name: string
  best_norad: number | null
  best_start_at: string | null
  best_max_elev: number | null
  hour_dist: string
  window_hours: number
  computed_at: string | null
}

export interface PassCityDetail {
  /** 目标信息（district 行政区划面 / border 国界面） */
  city: {
    id: number
    name: string
    name_cn: string
    country: string
    geo_type: string
    adcode: string
    level: string
    province: string
    longitude: number
    latitude: number
  }
  /** 本明细所属数据批次（pass_scan_run.id）；读表时为 null 表示库中暂无批次 */
  run_id?: number | null
  windowHours: number
  stepSec: number
  refineSec: number
  minElev: number
  /** 预报窗口起点（unix ms）；读表时为 null（明细已落库，无需起算时刻） */
  startMs: number | null
  /** 参与计算的载荷卫星数；读表时为 null（未参与本次请求） */
  sats: number | null
  /** TLE 异常跳过的卫星数 */
  failed: number
  /** 过境条数（list.length；读取端不截断时即该批次该目标入库的全部过境数） */
  totalPasses: number
  /** 现算耗时（秒）；读表时为 0 */
  duration: number
  /** 明细落库时间（读表时用于展示结果时间） */
  computedAt?: string | null
  /** 明细是否为实时现算（只读表后恒为 false，保留字段兼容前端） */
  live?: boolean
  /** 仅省级聚合面：下辖地级市总数（cityTotal 为本批次下辖市数）
   *  cityWithPass 为本批次有过境的市数；省级汇总行恒为 null */
  cityTotal?: number
  cityWithPass?: number
  list: PassDetailItem[]
  summary: PassSummaryRow | null
}

/** 各目标过境汇总列表行 */
export interface PassSummaryItem {
  id: number
  city_id: number
  city_name: string
  country: string
  geo_type: string
  province: string
  longitude: number | null
  latitude: number | null
  total_passes: number
  visible_sats: number
  best_sat_name: string
  best_norad: number | null
  best_start_at: string | null
  best_max_elev: number | null
  window_hours: number
  computed_at: string | null
}

/** 仰角剖面采样点（tMs 为 unix ms；elev/az 单位 °，range 单位 km） */
export interface PassElevationPoint {
  tMs: number
  /** 该时刻的面口径仰角（°）：星下点到目标面的最近点反解，与明细 maxElev 同源 */
  elev: number
  /** 斜距（km，面到卫星最近点） */
  range: number
  /** 方位角（°，取目标中心 ENU 基） */
  az: number
}

/** 单次过境的仰角剖面（口径同 pass_detail.max_elev，故峰值与列表一致） */
export interface PassElevationResult {
  city_id: number
  norad_id: number
  object_name: string
  /** 仰角门限（°，= 10） */
  minElev: number
  stepSec: number
  aosMs: number
  losMs: number
  total: number
  /** 剖面峰值仰角（°），应与该次过境明细的 maxElev 一致 */
  maxElev: number
  maxAtMs: number
  points: PassElevationPoint[]
}

/** 行政区划面 + 国界 + 城市标注（供三维地球绘制；静态地理数据，图例开关只控制本端显示隐藏，无需重复请求） */
export function getPassMap() {
  return httpCgi<PassMapResult>({ url: '/pass/map', method: 'get' })
}

/** 过境数据批次列表（最近 N 个有汇总数据的成功批次，供面板「数据批次」下拉回看历史） */
export function getPassBatches(limit?: number) {
  return httpCgi<{ list: PassBatchItem[]; total: number }>({
    url: '/pass/batches',
    method: 'get',
    params: limit ? { limit } : undefined
  })
}

/** 指定批次「有过境数据」的目标 id 集合（不传 run_id = 当前批次，由后端解析最近有数据的批次） */
export function getPassCityIds(runId?: number) {
  return httpCgi<{ run_id: number | null; ids: number[]; total: number }>({
    url: '/pass/city_ids',
    method: 'get',
    params: runId ? { run_id: runId } : undefined
  })
}

/** 单目标过境明细（只读 pass_detail 预计算结果，毫秒级返回）；runId 指定数据批次回看，不传 = 当前批次 */
export function getPassCityDetail(cityId: number, runId?: number) {
  return httpCgi<PassCityDetail>({
    url: `/pass/city/${cityId}`,
    method: 'get',
    params: runId ? { run_id: runId } : undefined,
    timeout: 60000
  })
}

/** 单次过境的仰角剖面（现算、毫秒级）；口径与明细 maxElev 一致，故峰值与列表自洽 */
export function getPassElevationProfile(p: {
  cityId: number
  noradId: number
  aosMs: number
  losMs: number
  stepSec?: number
}) {
  return httpCgi<PassElevationResult>({
    url: '/pass/elevation',
    method: 'get',
    params: {
      city_id: p.cityId,
      norad_id: p.noradId,
      aos_ms: p.aosMs,
      los_ms: p.losMs,
      step_sec: p.stepSec
    }
  })
}

/** 各目标过境汇总列表（读 pass_info 预计算结果） */
export function listPassSummary(params?: { page?: number; page_size?: number; keyword?: string }) {
  return httpCgi<{ list: PassSummaryItem[]; total: number; page: number; page_size: number }>({
    url: '/pass/summary/list',
    method: 'get',
    params
  })
}
