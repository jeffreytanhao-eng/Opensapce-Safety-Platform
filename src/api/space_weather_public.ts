/**
 * 空间环境指数（前台公开接口）
 *
 * 数据源：server/lib/spaceWeather.js → GET /cgi/space_weather（免登录只读）
 *   · 日粒度 F10.7 / Kp / Ap / 太阳黑子（Celestrak，含 5 年历史与 45 天预报）
 *   · 分钟级太阳风（NOAA SWPC，后端仅内存缓存）
 *   · 极光椭圆环渲染参数与地磁暴分档（后端算好下发，前端只消费不换算）
 *
 * ⚠ 时效：实测值滞后 1~2 天（响应带 lag 与 aurora.kpDate），界面须标注「非实时」。
 */
import { httpCgi } from '@/utils/request'

/** 单日空间环境记录 */
export interface SpaceWeatherItem {
  /** UTC 日期 YYYY-MM-DD */
  date: string
  /** F10.7 观测值（sfu） */
  f107Obs: number | null
  /** F10.7 调整值（归一化到 1 AU） */
  f107Adj: number | null
  /** F10.7 81 天中心平滑 */
  f107Center81: number | null
  /** 当日 8 个 3 小时时段（00-03…21-24 UTC）的 Kp，可能为 null（远期预测无分时值） */
  kp: (number | null)[]
  /** 当日 Kp 最大值（0~9） */
  kpMax: number | null
  /** 日平均 Ap */
  apAvg: number | null
  /** 国际太阳黑子数 */
  sunspot: number | null
  /** OBS=实测 / INT=插值 / PRD=逐日预报 / PRM=远期预测 */
  dataType: string
}

/** 极光椭圆环渲染参数（Kp 驱动；经验式，见后端注释） */
export interface SpaceWeatherAurora {
  kp: number
  /** 赤道侧边界磁纬（°）：环的下沿 */
  equatorwardLatDeg: number
  /** 环宽（°，沿磁纬） */
  widthDeg: number
  /** 0~1 相对强度（驱动亮度/不透明度） */
  intensity: number
  /** 环颜色（弱活动青绿、强活动暖红） */
  color: string
  /** 这组参数依据的 Kp 来源：realtime = NOAA 1 分钟实时估算；daily = 最近实测日的日最大 Kp；none = 无数据 */
  kpSource: 'realtime' | 'daily' | 'none'
  /** kpSource=realtime 时的估算时刻（ms） */
  kpAt: number | null
  /** kpSource=daily 时的日期（YYYY-MM-DD） */
  kpDate: string | null
}

/** 地磁暴分档（NOAA G 级） */
export interface SpaceWeatherStorm {
  kp: number | null
  level: string
  label: string
  color: string
  /** estimate = 实时估算 Kp 分档；daily = 日粒度实测分档 */
  source: 'estimate' | 'daily'
}

/** 太阳风与行星际磁场（NOAA 当前值，后端内存缓存） */
export interface SpaceWeatherWind {
  /** 质子速度 km/s */
  speed: number | null
  /** 行星际磁场总强度 nT */
  bt: number | null
  /** 行星际磁场 Bz（GSM）nT：南向（负）与磁层耦合最强 */
  bz: number | null
  /** 太阳风数据时刻（ms） */
  at: number | null
  /** 缓存刷新时刻（ms） */
  refreshedAt: number | null
  /** 缓存是否已过期 */
  stale: boolean
  error: string
}

export interface SpaceWeatherResult {
  latest: SpaceWeatherItem | null
  series: SpaceWeatherItem[]
  forecast: SpaceWeatherItem[]
  aurora: SpaceWeatherAurora
  /** 偶极磁极（极光椭圆环圆心） */
  geomagPole: { northLat: number; northLon: number; southLat: number; southLon: number }
  storm: SpaceWeatherStorm
  solarWind: SpaceWeatherWind
  /** 最新实测距今天数（0 = 今天；正常 1~2） */
  lag: number | null
}

/** 拉取空间环境（series_days / forecast_days 缺省不返回序列，只回最新值与渲染参数） */
export function getSpaceWeather(params?: {
  series_days?: number
  forecast_days?: number
  with_wind?: number
}) {
  return httpCgi<SpaceWeatherResult>({ url: '/space_weather', method: 'get', params })
}
