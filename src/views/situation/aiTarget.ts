/**
 * 态势页「当前选中目标」→ 智能体面板 的桥
 *
 * 把散落在 scene.ts / index.vue 各处的选中态归一成 AiTarget，供聊天面板：
 *   ① 顶部显示「当前目标」；
 *   ② 生成推荐问题（**纯本地模板，秒出、零延迟、不占 CPU**，不让大模型生成——它太慢）；
 *   ③ 作为**界面上下文**随提问下发，让模型知道「这颗星 / 这次事件 / 这个城市」指谁。
 *
 * ⚠ 上下文只是「界面标识符」，不是数据来源：所有数值仍必须由模型调用工具实时查库
 *   （见 server/lib/ai/tools.js 顶部铁律）。推荐问题也只覆盖现有工具能答准的问法，
 *   答不了的（如「某星座共几颗星」「会不会真撞上」「某城市云量」）一律不列。
 */
import type { CdmHeatEvent } from '@/api/sat_public'
import type { PassTargetItem } from '@/api/pass_public'

export type AiTargetKind = 'satellite' | 'constellation' | 'conjunction' | 'pass_target' | 'pass_record'

export interface AiTarget {
  kind: AiTargetKind
  /** 稳定标识：供 watch 判重（同批次刷新时避免推荐问题闪烁） */
  key: string
  /** 面板上显示的「当前目标」文案 */
  label: string
  norad?: number
  name?: string
  noradB?: number
  nameB?: string
  cdmId?: string
  tca?: string
  constellation?: string
  /** 星座检索关键词（英文名 / 别名，用于 search_object 的 LIKE 匹配） */
  keyword?: string
  geoId?: number
  geoType?: string
  country?: string
  province?: string
  adcode?: string
  lon?: number
  lat?: number
  aosMs?: number
  areaIndex?: number
  /** 过境记录的来源面板：三种面板都用 kind='pass_record'，靠它区分，避免后端拿错数据源 */
  passSource?: 'city' | 'region' | 'multi'
  /** 区域过境明细所属批次 id（出「单条区域过境报告」用，非必填但能精确定位） */
  runId?: number
}

/** 过境记录的最小字段（PassDetailItem 的子集） */
interface PassRecordLike {
  norad_id: number
  object_name?: string
  aosMs?: number
}

/** index.vue 从各选中态里抽出的原始依赖 */
export interface AiTargetDeps {
  /** 当前展开的面板 */
  dockMode: string
  /** 当前激活的面板（面板收起后仍保留） */
  dockActive: string
  /** 卫星拾取（sel.id 即 NORAD） */
  sel: { id: number; name: string }
  hasSel: boolean
  /** 当前星座过滤名 */
  filterConst: string
  /** 选中星座的元数据（取英文名 / 关键词做检索） */
  constellation?: { name_en?: string; keywords?: string[] } | null
  heatSel?: CdmHeatEvent | null
  passSelTarget?: PassTargetItem | null
  /** 用户**主动点击**过的某次过境（默认第 0 条「最佳过境」不算选中） */
  passPicked?: PassRecordLike | null
  regionPassSel?: { norad_id: number; aos_ms: number } | null
  /** 区域过境面板当前结果所属批次 id（由 index.vue 在点击时接住，见 pickRegionRecord） */
  regionPassRunId?: number | null
  multiPassSel?: { norad_id: number; aos_ms: number; area_index?: number } | null
}

/** 过境目标的展示名（中文优先） */
function geoName(t: PassTargetItem): string {
  return t.name_cn || t.name || (t.country ? t.country : `目标 ${t.id}`)
}

/** 卫星展示名（无名时退回 NORAD） */
function satName(norad: number, name?: string | null): string {
  const n = String(name || '').trim()
  const id = Number(norad) || 0
  return n ? `${n}（NORAD ${id}）` : `NORAD ${id}`
}

/** 归一「当前选中目标」：按当前激活模块分流，模块内取最具体者（见方案 §2 的取舍理由） */
export function buildAiTarget(d: AiTargetDeps): AiTarget | null {
  const mode = d.dockMode || d.dockActive || ''

  if (mode === 'pass') {
    // 用户主动点过某次过境 → 更具体，优先；否则退回该城市/国界目标
    const rec = d.passPicked
    if (rec && Number(rec.norad_id) > 0) {
      const sat = rec.object_name || `NORAD ${rec.norad_id}`
      const city = d.passSelTarget ? geoName(d.passSelTarget) : ''
      return {
        kind: 'pass_record',
        key: `pr:${rec.norad_id}:${rec.aosMs || 0}`,
        label: city ? `${city} · ${sat} 的过境` : `${sat} 的过境`,
        norad: Number(rec.norad_id),
        name: rec.object_name || '',
        aosMs: Number(rec.aosMs) || undefined,
        passSource: 'city'
      }
    }
    const t = d.passSelTarget
    if (t) {
      return {
        kind: 'pass_target',
        key: `pt:${t.id}`,
        label: geoName(t),
        geoId: Number(t.id),
        geoType: t.geo_type || '',
        name: t.name || t.name_cn || '',
        country: t.country || '',
        province: t.province || '',
        adcode: t.adcode || '',
        lon: Number(t.longitude) || undefined,
        lat: Number(t.latitude) || undefined
      }
    }
    return null
  }

  if (mode === 'heat') {
    const e = d.heatSel
    if (!e) return null
    return {
      kind: 'conjunction',
      key: `cj:${e.cdm_id || ''}:${e.norad_a}:${e.norad_b}:${e.tca || ''}`,
      label: `${e.name_a || `NORAD ${e.norad_a}`} × ${e.name_b || `NORAD ${e.norad_b}`}`,
      norad: Number(e.norad_a),
      name: e.name_a || '',
      noradB: Number(e.norad_b),
      nameB: e.name_b || '',
      cdmId: e.cdm_id || '',
      tca: e.tca || ''
    }
  }

  // 星座展示态（原「星座列表」dock 通道已并入卫星列表模块）：有星座过滤且未进入专项视图时，
  // 当前目标即该星座（智能体星座展示 / URL ?const= 深链 / 星座卡片点亮都走这里）
  if (d.filterConst && (mode === 'sat' || mode === '')) {
    const name = String(d.filterConst || '').trim()
    if (!name) return null
    const meta = d.constellation
    const kw = String(meta?.name_en || meta?.keywords?.[0] || name).trim()
    return {
      kind: 'constellation',
      key: `cs:${name}`,
      label: `${name} 星座`,
      constellation: name,
      keyword: kw
    }
  }

  if (mode === 'region' || mode === 'multi') {
    const isMulti = mode === 'multi'
    const sel = isMulti ? d.multiPassSel : d.regionPassSel
    if (!sel || !Number(sel.norad_id)) return null
    const where = isMulti ? '多区域过境' : '区域过境'
    return {
      kind: 'pass_record',
      key: `${mode}:${sel.norad_id}:${sel.aos_ms || 0}:${(sel as { area_index?: number }).area_index ?? ''}`,
      label: `${where} · NORAD ${sel.norad_id}`,
      norad: Number(sel.norad_id),
      aosMs: Number(sel.aos_ms) || undefined,
      areaIndex: (sel as { area_index?: number }).area_index,
      passSource: isMulti ? 'multi' : 'region',
      // 带上批次 id：智能体据此直接生成「单条区域过境报告」，不必再向用户索要 id
      runId: isMulti ? undefined : (Number(d.regionPassRunId) || undefined)
    }
  }

  // 卫星列表 / 面板全收起：回退到卫星拾取
  if (d.hasSel && Number(d.sel.id) > 0) {
    return {
      kind: 'satellite',
      key: `sat:${d.sel.id}`,
      label: satName(d.sel.id, d.sel.name),
      norad: Number(d.sel.id),
      name: d.sel.name || ''
    }
  }
  return null
}

/** 基于当前目标生成推荐问题（纯本地模板；问法均限定在五能力与现有工具能答准的范围） */
export function buildSuggestions(t: AiTarget | null): string[] {
  if (!t) return []
  if (t.kind === 'satellite') {
    const id = `NORAD ${t.norad}`
    return [
      `介绍 ${id} 的类型、轨道区域与 TLE 历元新鲜度`,
      `${id} 有没有接近事件或碰撞风险？`,
      `本批次碰撞预警的整体态势如何（事件数、等级分布）？`
    ]
  }
  if (t.kind === 'constellation') {
    const kw = t.keyword || t.constellation || ''
    return [
      `用关键词「${kw}」能查到哪些目标？列出前几个及它们的 TLE 历元龄期`,
      `关键词「${kw}」的目标有没有出现在最近的接近事件里？`,
      `当前整体碰撞预警态势如何（事件数与等级分布）？`
    ]
  }
  if (t.kind === 'conjunction') {
    return [
      `NORAD ${t.norad} 与 NORAD ${t.noradB} 分别是什么目标？TLE 历元新鲜度如何？`,
      `除了这次接近，这两颗星在最近扫描里还有别的接近事件吗？`,
      `本批次碰撞预警的整体态势（事件数、等级分布）如何？`
    ]
  }
  // 过境类目标不在五能力范围内（产品面不再引导过境预报）：不生成推荐问题
  return []
}

/**
 * 目标 → 下发给后端的结构化上下文（**白名单**，其余键一律不传）。
 * 后端会再校验一遍（前台免登录不可信任前端），非法/超长时静默丢弃。
 */
export function toContext(t: AiTarget | null): Record<string, unknown> | null {
  if (!t) return null
  const out: Record<string, unknown> = { kind: t.kind, label: String(t.label || '').slice(0, 60) }
  const num = (k: string, v?: number) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  const str = (k: string, v?: string, max = 60) => {
    const s = String(v || '').trim()
    if (s) out[k] = s.slice(0, max)
  }
  if (t.kind === 'satellite') {
    num('norad', t.norad)
    str('name', t.name)
  } else if (t.kind === 'constellation') {
    str('constellation', t.constellation)
    str('keyword', t.keyword, 40)
  } else if (t.kind === 'conjunction') {
    num('norad', t.norad)
    str('name', t.name)
    num('noradB', t.noradB)
    str('nameB', t.nameB)
    str('cdmId', t.cdmId, 40)
    str('tca', t.tca, 32)
  } else if (t.kind === 'pass_target') {
    num('geoId', t.geoId)
    str('geoType', t.geoType, 16)
    str('name', t.name)
    str('country', t.country, 40)
    str('province', t.province, 40)
    str('adcode', t.adcode, 16)
    num('lon', t.lon)
    num('lat', t.lat)
  } else {
    num('norad', t.norad)
    str('name', t.name)
    num('aosMs', t.aosMs)
    num('areaIndex', t.areaIndex)
    str('passSource', t.passSource, 16)
    num('runId', t.runId)
  }
  return out
}