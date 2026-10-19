/**
 * 前台公开发射站接口（/cgi 免登录）
 * 供免登录页面（/situation 综合态势「发射站列表」）消费，与后台 /api 发射站逻辑同口径。
 * 三个接口一一对应：发射站打点列表（含经纬度）、单站即将发射、单站发射历史。
 */
import { httpCgi } from '@/utils/request'

/** 发射站（含经纬度）：供 /situation 地球按经纬度打点 */
export interface LaunchSiteItem {
  id: number
  name_cn: string
  name_en?: string
  country_code?: string
  /** 纬度（十进制度，北正南负） */
  lat: number
  /** 经度（十进制度，东正西负） */
  lon: number
  /** 场地类型：land 陆基 / sea 海基 */
  site_type?: string
  /** 状态：1 现役 / 0 退役 */
  status?: number
  /** 该站即将发射条数（>0 时标记高亮） */
  upcoming_count?: number
  /** 该站最近一次即将发射任务的 NET（后端据此升序排序；无任务时为空） */
  next_net?: string
}

/** 即将发射计划（launch_upcoming 精简字段，按 NET 升序；*_cn 为中文译文，为空时前端回退英文原文） */
export interface LaunchUpcomingItem {
  id: number
  name: string
  name_cn?: string
  net?: string
  net_precision?: string
  window_start?: string
  window_end?: string
  status_name?: string
  status_name_cn?: string
  status_abbrev?: string
  probability?: number | null
  provider?: string
  provider_cn?: string
  provider_abbrev?: string
  provider_country?: string
  rocket?: string
  rocket_cn?: string
  mission_name?: string
  mission_name_cn?: string
  mission_type?: string
  mission_type_cn?: string
  orbit?: string
  orbit_cn?: string
  pad?: string
  pad_cn?: string
  /** 发射场中文译文（已关联发射站时为该站中文名） */
  pad_location_cn?: string
  /** 匹配到的发射站中文名 */
  site_name_cn?: string
  image?: string
  description?: string
  description_cn?: string
  info_url?: string
}

/** 发射历史记录（launch_record 精简字段，按发射时间倒序） */
export interface LaunchRecordItem {
  id: number
  launch_tag?: string
  launch_at?: string
  time_known?: number | string
  vehicle?: string
  flight_id?: string
  site_name?: string
  site_cn?: string
  pad?: string
  country_code?: string
  agency?: string
  outcome?: string
  payload_count?: number
  payload_text?: string
}

/** 全部发射站（含经纬度）：/situation 地球打点用，附带即将发射条数 */
export function listLaunchSitesPublic() {
  return httpCgi<{ total: number; list: LaunchSiteItem[] }>({ url: '/launch_site/all', method: 'get' })
}

/** 某发射站的即将发射计划（按 NET 升序，最多 50 条） */
export function listUpcomingBySitePublic(siteId: number) {
  return httpCgi<{ total: number; list: LaunchUpcomingItem[] }>({
    url: `/launch_upcoming/by_site/${siteId}`,
    method: 'get'
  })
}

/** 某发射站的发射历史（按发射时间倒序，分页） */
export function listLaunchRecordBySitePublic(siteId: number, page = 1, pageSize = 20) {
  return httpCgi<{ list: LaunchRecordItem[]; total: number; page: number; page_size: number }>({
    url: `/launch_record/by_site/${siteId}`,
    method: 'get',
    params: { page, page_size: pageSize }
  })
}
