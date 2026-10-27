/**
 * 星历分析窗 × 安全热力 双向联动（03 §15.5）
 *
 * 模块级 ref，与 scene.ts 风格一致：谁都不持有组件实例，只共享一个「焦点事件」。
 *  - 热力 → 星历窗：focusThreat({from:'heat'})，由 index.vue 打开星历窗并滚动到该事件；
 *  - 星历窗 → 热力：focusThreat({from:'ephem'})，由 index.vue 切标签 + 设置主星筛选；
 *  - URL 深链：focusThreat({from:'url'})。
 * 防环：处理方判断 from，与自己相同时只做 3D 定位，不回发。
 */
import { ref, shallowRef } from 'vue'
import { heatPrimaryFilter } from './scene'
import type { HeatLevel } from './heat/riskLevels'

/** 筛查 kind：tle-threat = TLE×TLE 初筛；tle = 精密星历 × TLE（星历增强） */
export type ThreatKind = 'tle-threat' | 'tle'

export interface ThreatFocus {
  from: 'heat' | 'ephem' | 'url'
  kind: ThreatKind
  /** hs_event.id（两个标签的事件编号） */
  eventId: number | string
  primaryNorad: number
  secondaryNorad: number
  /** 交会时刻（unix ms） */
  tcaMs: number
  primaryScope: 'official' | 'uploaded'
  /** scope=uploaded 时必填 */
  ephemId?: string
  /** 主星名称（标题与 3D 标签用） */
  primaryName?: string
  secondaryName?: string
  /** 事件等级（与契约一致，3D 标记配色用；缺省按「关注」处理） */
  level?: HeatLevel
  /** 内部自增序号，仅用于保证重复点击同一事件也能触发 watcher */
  __seq?: number
}

/** 唯一入口：写入即触发联动（置 null 表示清除） */
export const threatFocus = shallowRef<ThreatFocus | null>(null)

/** 当前主星筛选的显示名（芯片文案用） */
export const heatPrimaryName = ref('')

export { heatPrimaryFilter }

let seq = 0

/** 唯一入口；每次写入都换新对象，保证相同事件重复点击也能触发 watcher */
export function focusThreat(f: Omit<ThreatFocus, never> | null): void {
  if (!f) {
    threatFocus.value = null
    return
  }
  seq += 1
  threatFocus.value = { ...f, __seq: seq }
}

/** 主星筛选 → primary 查询参数（official 或 ephem:<id>） */
export function primaryParam(): string {
  const f = heatPrimaryFilter.value
  return f.kind === 'uploaded' ? `ephem:${f.ephemId}` : 'official'
}

/** kind → 热力标签 */
export function heatSourceOf(kind: ThreatKind): 'tle-threat' | 'tle-eph' {
  return kind === 'tle-threat' ? 'tle-threat' : 'tle-eph'
}
