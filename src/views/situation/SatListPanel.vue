<script setup lang="ts">
/**
 * 星座总览 /situation 卫星列表面板（左侧滑出）
 * 从原 index.vue 拆分而来：数据源切换 + 类型开关 + 星座卡片列表（星座展示 / 轨道展示 / 展开成员列表）。
 * 共享响应式状态集中在 scene.ts（satPanel / g.cloudList / constellations / filterConst / consOrbitOn）。
 * 纯动作（点选卫星、星座展示开关、关闭面板）通过 emit 交给父组件 index.vue 编排（父组件调用 BaseScene.expose）。
 */
import { computed, onMounted, ref } from 'vue'
import {
  TYPE_KEYS,
  satPanel, g, cloudRev, dockMode,
  dataSource, SAT_SOURCE_OPTIONS,
  constellations, filterConst, consOrbitOn, consShowOf, consCardBound, stationFocus,
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'
import { listConstellationLaunches, type ConstellationLaunch, type SatSource } from '@/api/sat_public'
import type { ConstellationItem } from '@/api/satTypes'
import { ephemMetas } from './ephem/useUserEphemeris'

/** 面板专用类型文案/配色（短文案单行排列；配色与三维场景 TYPE_COLOR 解耦，仅作用于本面板开关） */
const TYPE_UI: Record<string, { label: string; color: string }> = {
  PAYLOAD: { label: '卫星', color: '#4caf50' },
  DEBRIS: { label: '碎片', color: '#ff4d4f' },
  'ROCKET BODY': { label: '残骸', color: '#ff9800' },
  UNKNOWN: { label: '未知', color: '#ffffff' }
}

/** 编目国代码 → 国旗 emoji（卡片国旗小标兜底；精选星座走 CONST_META） */
/** 编目国/组织代码 → 中文名 + ISO 代码（flagcdn 彩色国旗小图）；未列出的代码不显示国旗。
 *  数据源点云 owner_code 覆盖 90+ 个值，此前只映射 14 个导致大量星座「无国籍」，此处按实测分布补全。 */
const OWNER_INFO: Record<string, { name: string; iso?: string }> = {
  US: { name: '美国', iso: 'us' }, CN: { name: '中国', iso: 'cn' }, RU: { name: '俄罗斯', iso: 'ru' },
  CIS: { name: '俄罗斯', iso: 'ru' }, GB: { name: '英国', iso: 'gb' }, UK: { name: '英国', iso: 'gb' },
  FR: { name: '法国', iso: 'fr' }, DE: { name: '德国', iso: 'de' }, JP: { name: '日本', iso: 'jp' },
  IN: { name: '印度', iso: 'in' }, KR: { name: '韩国', iso: 'kr' }, CA: { name: '加拿大', iso: 'ca' },
  BR: { name: '巴西', iso: 'br' }, IL: { name: '以色列', iso: 'il' }, AU: { name: '澳大利亚', iso: 'au' },
  IT: { name: '意大利', iso: 'it' }, ES: { name: '西班牙', iso: 'es' }, NL: { name: '荷兰', iso: 'nl' },
  LU: { name: '卢森堡', iso: 'lu' }, SE: { name: '瑞典', iso: 'se' }, NO: { name: '挪威', iso: 'no' },
  DK: { name: '丹麦', iso: 'dk' }, FI: { name: '芬兰', iso: 'fi' }, PL: { name: '波兰', iso: 'pl' },
  GR: { name: '希腊', iso: 'gr' }, PT: { name: '葡萄牙', iso: 'pt' }, CZ: { name: '捷克', iso: 'cz' },
  HU: { name: '匈牙利', iso: 'hu' }, RO: { name: '罗马尼亚', iso: 'ro' }, BG: { name: '保加利亚', iso: 'bg' },
  SI: { name: '斯洛文尼亚', iso: 'si' }, HR: { name: '克罗地亚', iso: 'hr' }, SK: { name: '斯洛伐克', iso: 'sk' },
  AT: { name: '奥地利', iso: 'at' }, BE: { name: '比利时', iso: 'be' }, CH: { name: '瑞士', iso: 'ch' },
  EE: { name: '爱沙尼亚', iso: 'ee' }, LT: { name: '立陶宛', iso: 'lt' }, UA: { name: '乌克兰', iso: 'ua' },
  BY: { name: '白俄罗斯', iso: 'by' }, KZ: { name: '哈萨克斯坦', iso: 'kz' }, TR: { name: '土耳其', iso: 'tr' },
  SA: { name: '沙特阿拉伯', iso: 'sa' }, AE: { name: '阿联酋', iso: 'ae' }, QA: { name: '卡塔尔', iso: 'qa' },
  KW: { name: '科威特', iso: 'kw' }, BH: { name: '巴林', iso: 'bh' },
  EG: { name: '埃及', iso: 'eg' }, NG: { name: '尼日利亚', iso: 'ng' }, DZ: { name: '阿尔及利亚', iso: 'dz' },
  MA: { name: '摩洛哥', iso: 'ma' }, AO: { name: '安哥拉', iso: 'ao' }, ZA: { name: '南非', iso: 'za' },
  RW: { name: '卢旺达', iso: 'rw' }, PK: { name: '巴基斯坦', iso: 'pk' }, BD: { name: '孟加拉国', iso: 'bd' },
  IR: { name: '伊朗', iso: 'ir' }, IQ: { name: '伊拉克', iso: 'iq' }, JO: { name: '约旦', iso: 'jo' },
  KP: { name: '朝鲜', iso: 'kp' }, VN: { name: '越南', iso: 'vn' }, TH: { name: '泰国', iso: 'th' },
  MY: { name: '马来西亚', iso: 'my' }, SG: { name: '新加坡', iso: 'sg' }, ID: { name: '印度尼西亚', iso: 'id' },
  PH: { name: '菲律宾', iso: 'ph' }, LA: { name: '老挝', iso: 'la' },
  MX: { name: '墨西哥', iso: 'mx' }, AR: { name: '阿根廷', iso: 'ar' }, CL: { name: '智利', iso: 'cl' },
  CO: { name: '哥伦比亚', iso: 'co' }, PE: { name: '秘鲁', iso: 'pe' }, BO: { name: '玻利维亚', iso: 'bo' },
  EC: { name: '厄瓜多尔', iso: 'ec' }, UY: { name: '乌拉圭', iso: 'uy' }, VE: { name: '委内瑞拉', iso: 've' },
  NZ: { name: '新西兰', iso: 'nz' }, IM: { name: '马恩岛', iso: 'im' }, AZ: { name: '阿塞拜疆', iso: 'az' },
  CN_TW: { name: '中国台湾', iso: 'tw' },
  // 国际组织 / 跨国运营主体（编目码非国家，按运营主体归属地给旗）
  ESA: { name: '欧洲航天局', iso: 'eu' }, EUME: { name: '欧盟', iso: 'eu' }, EU: { name: '欧盟', iso: 'eu' },
  EUTE: { name: '欧洲通信卫星组织', iso: 'eu' }, ITSO: { name: '国际通信卫星组织', iso: 'eu' },
  SES: { name: '卢森堡', iso: 'lu' }, O3B: { name: '卢森堡', iso: 'lu' }, GLOB: { name: '美国', iso: 'us' },
  ORB: { name: '美国', iso: 'us' }, NATO: { name: '北约' }
}

/** 精选星座展示元数据：星座主表未提供的卡片信息（国旗/国家/运营方/分类/首发/最近发射）。
 *  命中键 = code / name_en / name 含关键词；未命中的星座用成员编目国与用途标签兜底。 */
const CONST_META: Record<string, { iso: string; country: string; operator: string; tag: string; first: string; last: string }> = {
  STARLINK: { iso: 'us', country: '美国', operator: 'SpaceX', tag: '宽带互联网', first: '2019-05-24', last: '2026-07-11' },
  ONEWEB: { iso: 'gb', country: '英国', operator: 'Eutelsat OneWeb', tag: '宽带互联网', first: '2019-02-27', last: '2024-10-20' },
  KUIPER: { iso: 'us', country: '美国', operator: 'Amazon', tag: '宽带互联网', first: '2025-04-28', last: '2026-07-02' },
  QIANFAN: { iso: 'cn', country: '中国', operator: '垣信卫星', tag: '宽带互联网', first: '2024-08-06', last: '2026-07-05' },
  GUOWANG: { iso: 'cn', country: '中国', operator: '中国卫星网络集团', tag: '宽带互联网', first: '2024-12-16', last: '2026-07-31' },
  IRIDIUM: { iso: 'us', country: '美国', operator: 'Iridium Communications', tag: '语音与数据通信', first: '1997-05-05', last: '2023-05-20' },
  GLOBALSTAR: { iso: 'us', country: '美国', operator: 'Globalstar', tag: '语音与数据通信', first: '1998-02-14', last: '2022-06-19' },
  GPS: { iso: 'us', country: '美国', operator: '美国太空军', tag: '导航定位', first: '1983-07-14', last: '2026-04-21' },
  BEIDOU: { iso: 'cn', country: '中国', operator: '中国卫星导航系统管理办公室', tag: '导航定位', first: '2000-10-31', last: '2025-09-03' },
  GLONASS: { iso: 'ru', country: '俄罗斯', operator: '俄罗斯航天国家集团', tag: '导航定位', first: '1982-10-12', last: '2023-11-25' },
  GALILEO: { iso: 'eu', country: '欧盟', operator: 'EUSPA', tag: '导航定位', first: '2011-10-21', last: '2024-09-25' }
}
/** 星座名 → 精选元数据（code 精确 → name_en/name 关键词包含） */
function metaOf(c: ConstellationItem) {
  const code = (c.code || '').toUpperCase()
  if (CONST_META[code]) return CONST_META[code]
  const en = (c.name_en || '').toUpperCase()
  for (const [k, v] of Object.entries(CONST_META)) {
    if (en.includes(k) || (c.name || '').toUpperCase().includes(k)) return v
  }
  return null
}

/** 库内实时发射日期（sidecar /cgi2/cons/launch，随每日 GP 同步刷新）：key = code / name_en 小写 */
const consLaunch = ref<Record<string, ConstellationLaunch>>({})
onMounted(async () => {
  try {
    const r = await listConstellationLaunches()
    const m: Record<string, ConstellationLaunch> = {}
    for (const it of r.list || []) {
      if (it.code) m[it.code.toLowerCase()] = it
      if (it.name_en) m[it.name_en.toLowerCase()] = it
    }
    consLaunch.value = m
  } catch {
    // sidecar 未启动时静默回落 CONST_META 静态值，不影响卡片其余信息
  }
})

/** 卡片「首发 / 最近发射」：最近发射取库内实时值与精选元数据中较晚者（成员表未及时补链时不回退），
 *  首发优先用精选元数据（库里只能看到仍在轨的成员，早期首发星多已再入）。 */
function datesOf(c: ConstellationItem): { first: string; last: string } | null {
  const meta = metaOf(c)
  if (!meta) return null
  const dyn = consLaunch.value[(c.code || '').toLowerCase()] || consLaunch.value[(c.name_en || '').toLowerCase()]
  const last = dyn?.last_launch && dyn.last_launch > meta.last ? dyn.last_launch : meta.last
  return { first: meta.first, last }
}

/** 用途标签：精选星座外的全部在轨星座（网络检索用途后归一为短标签，轨道信息不算用途） */
const CONS_TAG: Record<string, string> = {
  // 宽带互联网
  GALAXY: '宽带互联网', O3B: '宽带互联网', HONGHU3: '宽带互联网', ZHIHUI: '宽带互联网', HONGYAN: '宽带互联网',
  // 物联网通信
  GEESAT: '物联网通信', ORBCOMM: '物联网通信', TIANQI: '物联网通信', XINGYUN: '物联网通信', GBA: '物联网通信',
  // 语音与数据通信
  INTELSAT: '语音与数据通信', SES: '语音与数据通信', EUTELSAT: '语音与数据通信', INMARSAIGX: '语音与数据通信',
  RADUGA: '语音与数据通信', MOLNIYA: '语音与数据通信', HUGHES: '语音与数据通信', TIANTONG: '语音与数据通信', SIRIUS: '语音与数据通信',
  // 导航定位
  PARUS: '导航定位', WEILI: '导航定位', IRNSS: '导航定位', QZSS: '导航定位',
  // 遥感服务
  FLOCK: '遥感服务', PLANETLABS: '遥感服务', PLANETSCOPE: '遥感服务', RAPIDEYE: '遥感服务', ICEYE: '遥感服务',
  YAOGAN: '遥感服务', JILIN1: '遥感服务', GAOFEN: '遥感服务', RADARSAT: '遥感服务', CAPELLA: '遥感服务',
  SUPERVIEW: '遥感服务', ZHUHAI1: '遥感服务', ZHONGZI: '遥感服务', HAIYANG: '遥感服务', LANDSAT: '遥感服务',
  KOMPSAT: '遥感服务', ZIYUAN: '遥感服务', PLEIADES: '遥感服务', NUWA: '遥感服务', WEIJING1: '遥感服务',
  BJ3: '遥感服务', LANDSURVEY1: '遥感服务', ICESAT: '遥感服务', ZHUZHOU: '遥感服务', GYSAT: '遥感服务',
  ZHANGYESAR: '遥感服务', ALBEDO: '遥感服务', HJDISASTER: '遥感服务', ANXI: '遥感服务', HAONIANJING: '遥感服务',
  // 气象服务
  METEOR: '气象服务', FENGYUN: '气象服务', TIANMU1: '气象服务', GOES: '气象服务', METEOSAT: '气象服务',
  HIMAWARI: '气象服务', YUNYAO: '气象服务', METOP: '气象服务', JMA: '气象服务',
  // 数据中继
  TIANLIAN: '数据中继',
  // 技术试验
  SHIJIAN: '技术试验', TIANSUAN: '技术试验', THREEBODY: '技术试验', DIYUE: '技术试验', NEO: '技术试验',
  XINGCHI: '技术试验', TEESAT: '技术试验', AIRSAT: '技术试验', SMARTSAT: '技术试验', QILIAN: '技术试验', TIANZHI: '技术试验',
  // 载人航天
  ISS: '载人航天', CSS: '载人航天'
}
/** 卡片用途标签：精选元数据 → 编目标签 → 星座名关键词推断（轨道高度等非用途信息不参与） */
function tagOf(c: ConstellationItem): string {
  const meta = metaOf(c)
  if (meta) return meta.tag
  const direct = CONS_TAG[(c.code || '').toUpperCase()]
  if (direct) return direct
  const text = `${c.name || ''} ${c.name_en || ''}`
  if (/遥感|观测|探测|测绘|影像|成像|SAR|慧眼|景|视|图|农|林|水利|海洋|减灾|资源/i.test(text)) return '遥感服务'
  if (/气象|风云|气候|温|大气/i.test(text)) return '气象服务'
  if (/导航|定位|基准/i.test(text)) return '导航定位'
  if (/通信|宽带|互联网|物联|网联|互联/i.test(text)) return '语音与数据通信'
  return '技术试验'
}

/** 卡片国家：精选元数据 → 成员编目国多数码（OWNER_INFO） */
function countryOf(c: ConstellationItem): string {
  const meta = metaOf(c)
  if (meta) return meta.country
  return OWNER_INFO[ownerOf(c.name)]?.name || '—'
}
/** 卡片国旗 ISO 代码（flagcdn 彩色小旗；无映射返回 '' 不显示旗） */
function flagIsoOf(c: ConstellationItem): string {
  const meta = metaOf(c)
  if (meta) return meta.iso
  return OWNER_INFO[ownerOf(c.name)]?.iso || ''
}

const emit = defineEmits<{
  (e: 'pick', gi: number): void
  (e: 'close'): void
  /** 切换数据源（国际库 / AOE 库）：交父组件转给三维场景重拉点云 */
  (e: 'source', src: SatSource): void
  /** 点选星座成员列表中的某颗卫星：父组件负责「单星揭示 or 仅拉近」 */
  (e: 'pickSat', gi: number): void
  /** 星座卡片「星座展示」开关：父组件切换 filterConst 通道 */
  (e: 'consShow', name: string): void
  /** 空间站卡片「位置展示」：按 NORAD 单星揭示并拉近（同一颗再点即收起） */
  (e: 'stationShow', norad: number): void
  /** 打开星历分析面板；带 id 时同时激活该份「我的星历」 */
  (e: 'openEph', id?: string): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

function close() {
  emit('close')
}

/* ============================================================
 * 星座卡片
 * ============================================================ */
/** 点云内各星座的在轨成员数（载荷口径，与星座过滤/成员列表同源）：
 *  一次遍历建 Map，供卡片「在轨 Y」统计与排序使用 */
const consStat = computed(() => {
  void cloudRev.value // 建立响应式依赖：g 非响应式，数据源切换后靠代次触发重算
  const m = new Map<string, number>()
  for (const p of g.cloudList) {
    if (p.object_type !== 'PAYLOAD') continue
    for (const n of p.cons || []) m.set(n, (m.get(n) || 0) + 1)
  }
  return m
})
/** 卡片列表：仅保留点云中有在轨成员的星座，按在轨数降序（大星座在前，同参考图）。
 *  国际空间站 / 中国空间站改由上方两张「空间站」卡片呈现，这里排除避免重复。 */
const consCards = computed(() => {
  return constellations.value
    .map((c) => ({ c, on: consStat.value.get(c.name) || 0 }))
    .filter((x) => x.on > 0 && x.c.code !== 'iss' && x.c.code !== 'css')
    .sort((a, b) => b.on - a.on)
})

/** 空间站卡片（不是星座：只展示单颗核心舱，无在轨数、无成员列表）
 *  NORAD 固定：25544 = ISS (ZARYA)，48274 = CSS (TIANHE-1)，与三维模型的专用 glb 一一对应。 */
const stationCards = [
  { key: 'css', name: '天宫空间站', operator: '中国载人航天工程', country: '中国', iso: 'cn',
    first: '2021-04-29', last: '2022-10-31', norad: 48274 },
  { key: 'iss', name: '国际空间站', operator: '多国合作', country: '国际', iso: '',
    first: '1998-11-20', last: '2021-07-21', norad: 25544 }
] as const

/** 位置展示态：独立通道（stationFocus）恰好指向该空间站时点亮；
 *  其它入口（星座展示 / 成员点选）不写这个状态，卡片与三维显隐互不干扰。 */
const stationOn = computed(() => {
  const f = stationFocus.value
  return f == null ? '' : stationCards.find((s) => s.norad === f)?.key ?? ''
})
/** 编目国兜底：取该星座在轨成员中出现最多的编目国 */
const consOwner = computed(() => {
  void cloudRev.value // 同上：编目国统计也依赖 g.cloudList
  const m = new Map<string, Map<string, number>>()
  for (const p of g.cloudList) {
    if (p.object_type !== 'PAYLOAD') continue
    const oc = p.owner_code || '--'
    for (const n of p.cons || []) {
      const sub = m.get(n) || new Map<string, number>()
      sub.set(oc, (sub.get(oc) || 0) + 1)
      m.set(n, sub)
    }
  }
  return m
})
function ownerOf(name: string): string {
  const sub = consOwner.value.get(name)
  if (!sub || !sub.size) return '--'
  let best = '--', cnt = 0
  for (const [k, v] of sub) if (v > cnt) { best = k; cnt = v }
  return best
}

/** 展开卫星列表的星座名（'' = 全部收起） */
const expandName = ref('')
/** 展开列表滚动加载窗口 */
const expandCount = ref(100)
function toggleExpand(name: string) {
  if (expandName.value === name) {
    expandName.value = ''
  } else {
    expandName.value = name
    expandCount.value = 100
  }
}
/** 展开星座的成员全局下标（载荷口径，与星座过滤一致） */
const expandIdx = computed(() => {
  void cloudRev.value // 展开成员下标随点云代次失效
  const name = expandName.value
  if (!name) return [] as number[]
  const out: number[] = []
  for (let i = 0; i < g.cloudList.length; i++) {
    const p = g.cloudList[i]
    if (p.object_type === 'PAYLOAD' && (p.cons || []).includes(name)) out.push(i)
  }
  return out
})
/** 展开列表滚动：到底部附近加载下一批 */
function onExpandScroll(ev: Event) {
  const el = ev.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    expandCount.value = Math.min(expandCount.value + 100, expandIdx.value.length)
  }
}
function pickSat(gi: number) {
  emit('pickSat', gi)
}
/** 「轨道展示」仅在该星座展示中时可点击；点击时把轨道绑定（filterConst）切到本卡片再翻转开关 */
function orbitOn(name: string) {
  return filterConst.value === name && consOrbitOn.value
}
function toggleOrbit(name: string) {
  if (!consShowOf(name)) return
  if (filterConst.value !== name) {
    filterConst.value = name
    consCardBound.value = true
  }
  consOrbitOn.value = !consOrbitOn.value
}
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'sat'" class="side-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main sat-head-main">
          <b class="sp-title">太空目标列表</b>
        </div>
        <!-- 收起按钮：向左三角（CSS 矢量，替代原 » 文本符号） -->
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起列表" @click="close">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M7 1.5 L3 5 L7 8.5 Z" /></svg>
        </button>
      </div>
      <!-- 数据源标签：白字居中（用户要求），位于分段控件上方 -->
      <div class="sp-src-label">选择数据源</div>
      <div class="sp-src">
        <button
          v-for="o in SAT_SOURCE_OPTIONS"
          :key="o.value"
          class="sp-src-btn"
          :class="{ on: dataSource === o.value }"
          :title="'切换到' + o.label"
          @click="emit('source', o.value)"
        >{{ o.label }}</button>
      </div>
      <div class="sp-show-label">太空目标展示</div>
      <div class="sp-types">
        <label v-for="k in TYPE_KEYS" :key="k" class="sp-type" :class="{ on: satPanel.typeF[k] }">
          <input type="checkbox" v-model="satPanel.typeF[k]" />
          <span class="sp-type-dot" :style="{ background: TYPE_UI[k].color }"></span>
          <span class="sp-type-txt">{{ TYPE_UI[k].label }}</span>
        </label>
      </div>
      <!-- 空间站卡片：固定两颗核心舱，不参与星座排序；「位置展示」= 单星揭示 + 拉近镜头 -->
      <div class="sp-station-cards">
        <div v-for="s in stationCards" :key="s.key" class="sp-cons-card" :class="{ on: stationOn === s.key }">
          <div class="sp-cons-head">
            <span class="sp-cons-name" :title="s.name">{{ s.name }}</span>
            <span class="sp-cons-op" :title="s.operator">运营方：{{ s.operator }}</span>
            <span class="sp-cons-tag">空间站</span>
          </div>
          <div class="sp-cons-meta">
            <span class="sp-cons-country">{{ s.country }}</span>
            <img v-if="s.iso" class="sp-cons-flag" :src="'https://flagcdn.com/w20/' + s.iso + '.png'" alt="" />
          </div>
          <div class="sp-cons-dates">
            <span>首发：{{ s.first }}</span><span>·</span><span>最近发射：{{ s.last }}</span>
          </div>
          <div class="sp-cons-actions">
            <button class="sp-cons-btn" :class="{ on: stationOn === s.key }"
              :title="stationOn === s.key ? '点暗：取消该站的单独展示（之后跟随「卫星」开关）' : '点亮：单独展示该空间站并拉近镜头（不影响其它目标）'"
              @click="emit('stationShow', s.norad)">位置展示</button>
          </div>
        </div>
      </div>

      <!-- 类型开关下方分割线 + 「卫星星座」标签 + 星座卡片列表 -->
      <div class="sp-const-label">卫星星座</div>
      <div class="sp-cons-scroll">
        <div v-for="x in consCards" :key="x.c.id" class="sp-cons-card" :class="{ on: consShowOf(x.c.name) }">
          <!-- 第一排：星座名（定宽对齐）+ 运营方（超长省略号）+ 用途标签（右对齐；轨道信息不算用途） -->
          <div class="sp-cons-head">
            <span class="sp-cons-name" :title="x.c.name">{{ x.c.name }}</span>
            <span v-if="metaOf(x.c)" class="sp-cons-op" :title="metaOf(x.c)!.operator">运营方：{{ metaOf(x.c)!.operator }}</span>
            <span class="sp-cons-tag">{{ tagOf(x.c) }}</span>
          </div>
          <!-- 第二排：国家 + 彩色国旗小图（左对齐）· 卫星数量（右对齐） -->
          <div class="sp-cons-meta">
            <span class="sp-cons-country">{{ countryOf(x.c) }}</span>
            <img v-if="flagIsoOf(x.c)" class="sp-cons-flag" :src="'https://flagcdn.com/w20/' + flagIsoOf(x.c) + '.png'" alt="" />
            <!-- 「共 X 颗」取自 sat_constellation 注册表（固定 TLE 口径），与 AOE 数据源不一致，AOE 下只显示在轨数 -->
            <span class="sp-cons-stat">
              <template v-if="dataSource !== 'aoe'">共 {{ x.c.satellite_count }} 颗 · </template>在轨 {{ x.on }}
            </span>
          </div>
          <!-- 第三排：首发 / 最近发射（仅精选星座有数据，左对齐；最近发射取库内实时值） -->
          <div v-if="datesOf(x.c)" class="sp-cons-dates">
            <span>首发：{{ datesOf(x.c)!.first }}</span>
            <span>·</span>
            <span>最近发射：{{ datesOf(x.c)!.last }}</span>
          </div>
          <div class="sp-cons-actions">
            <button class="sp-cons-btn" :class="{ on: consShowOf(x.c.name) }"
              :title="consShowOf(x.c.name) ? '点暗：不再展示该星座卫星（不影响其它星座与类型开关）' : '点亮：展示该星座全部卫星（不影响类型开关）'"
              @click="emit('consShow', x.c.name)">星座展示</button>
            <button class="sp-cons-btn" :class="{ on: orbitOn(x.c.name) }" :disabled="!consShowOf(x.c.name)"
              :title="!consShowOf(x.c.name) ? '先点亮「星座展示」' : (orbitOn(x.c.name) ? '点暗：隐藏该星座轨道' : '点亮：显示该星座展示中卫星的轨道（蓝色细线）')"
              @click="toggleOrbit(x.c.name)">轨道展示</button>
          </div>
          <!-- 展开箭头 + 文字：卡片下部，点亮展示态高亮 -->
          <button class="sp-cons-arrow" :class="{ open: expandName === x.c.name }"
            :title="expandName === x.c.name ? '收起卫星列表' : '展开卫星列表'"
            @click="toggleExpand(x.c.name)">
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5 Z" /></svg>
            <span>{{ expandName === x.c.name ? '收起卫星列表' : '展开卫星列表' }}</span>
          </button>
          <!-- 展开的成员列表：NORAD / 名称，滚动分批，点选即拉近+详情 -->
          <div v-if="expandName === x.c.name" class="sp-cons-sats" @scroll="onExpandScroll">
            <div class="sp-sat-row sp-sat-title">
              <span>NORAD</span><span>名称</span>
            </div>
            <div v-for="gi in expandIdx.slice(0, expandCount)" :key="gi" class="sp-sat-row" @click="pickSat(gi)">
              <span>{{ g.cloudList[gi].norad_id }}</span>
              <span class="sp-sat-name" :title="g.cloudList[gi].object_name">{{ g.cloudList[gi].object_name }}</span>
            </div>
            <div v-if="!expandIdx.length" class="sp-cons-empty">该星座暂无在轨成员</div>
          </div>
        </div>
        <div v-if="!consCards.length" class="sp-cons-empty">星座数据加载中…</div>

        <!-- 我的星历：与星座卡片同区滚动；点选即激活该份星历并打开星历分析面板 -->
        <div class="sp-eph">
          <div class="sp-eph-title">我的星历<span>{{ ephemMetas.length }} 份</span></div>
          <div v-for="m in ephemMetas" :key="m.id" class="sp-eph-row"
            :title="`${m.name} · NORAD ${m.norad || '—'} · ${m.points.toLocaleString()} 点`"
            @click="emit('openEph', m.id)">
            <span class="sp-eph-name">{{ m.name }}</span>
            <span class="sp-eph-meta">{{ m.format.toUpperCase() }} · {{ m.points.toLocaleString() }} 点</span>
          </div>
          <div v-if="!ephemMetas.length" class="sp-eph-empty">尚未上传星历，可在右侧「星历分析」中上传</div>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 目标列表头部定制：标题居中、标题与统计行距拉开（仅作用于本面板，scoped 隔离）。
   基础规则是 .side-panel .sp-head .sp-head-main（特异性更高），此处须同级前缀 + 追加类才能覆盖 gap */
.side-panel .sp-head .sp-head-main.sat-head-main {
  flex: 1;
  align-items: center;
  gap: 12px;
  .sp-title { text-align: center; font-size: 15px; margin-top: 5px; }
}
/* 收起按钮脱离文档流钉在头部右侧，让标题/统计在面板宽度内真正水平居中（桌面 + 移动抽屉通用） */
.side-panel .sp-head .sp-close.sp-close-tri { position: absolute; right: 10px; top: 8px; }
/* 「选择数据源」标签行：白字、与标题同字号、居中（下移 3px，相对位置随组整体保持） */
.side-panel .sp-src-label { margin: 10px 0 0; font-size: 14px; color: #fff; text-align: center; }
/* 数据源分段控件：margin 收回 3px 与标签同步下移（组内相对位置不变）；分割线不随之移动 */
.side-panel .sp-src { margin-top: 11px; }
/* 「太空目标展示」标签行：顶部横线做分割线（margin 再收回 3px 抵消上方组下移保持原位），文字位置不变 */
.side-panel .sp-show-label {
  margin: 19px 0 0; padding-top: 15px; font-size: 14px; color: #fff; text-align: center;
  border-top: 1px solid rgba(120,160,220,0.16);
}
/* 物体类型过滤区段：紧随「太空目标展示」下方；四个开关等宽放大并横向均匀分布对齐 */
.side-panel .sp-types {
  margin-top: 14px; padding-top: 0;
  flex-wrap: nowrap; gap: 4px;
  .sp-type { flex: 1 1 0; justify-content: center; padding: 3px 0; gap: 4px; font-size: 11px; }
}
/* 空间站卡片区：固定在「卫星星座」标签之上，不随星座列表滚动；左右边距与滚动区一致 */
.side-panel .sp-station-cards {
  margin: 10px -12px 0; padding: 0 12px; pointer-events: auto;
}
/* 「卫星星座」标签行：类型开关下方新分割线（顶部边框），字号同「太空目标展示」、居中。
   分割线位于「卫星」按钮与标签文字间隔的正中：.sp-types 自带 margin-bottom 10px，
   本行 margin-top 取 2px → 按钮下 12px / 文字上 12px（border 1px + padding 11px），上下对称 */
.side-panel .sp-const-label {
  margin: 2px 0 0; padding-top: 11px; font-size: 14px; color: #fff; text-align: center;
  border-top: 1px solid rgba(120,160,220,0.16);
}
/* 星座卡片滚动区：占满面板剩余高度，卡片过多时内部滚动
  （面板容器 pointer-events:none，本区须恢复 auto 否则卡片按钮全部点不了） */
.side-panel .sp-cons-scroll {
  flex: 1; min-height: 0; overflow-y: auto; margin: 10px -12px 0; padding: 0 12px 8px;
  pointer-events: auto;
}
/* 星座卡片：深底圆角 + 细边框，与面板卡片质感一致；展示态描边提亮 */
.side-panel .sp-cons-card {
  margin: 0 0 10px; padding: 10px 10px 8px; border-radius: 10px;
  background: rgba(13,19,33,0.85); border: 1px solid rgba(120,160,220,0.18);
  &.on { border-color: rgba(63,157,255,0.55); box-shadow: 0 0 0 1px rgba(63,157,255,0.25) inset; }
}
/* 第一排：名称定宽使各卡运营方信息左对齐；运营方超长省略号；标签右侧固定不缩 */
.side-panel .sp-cons-head { display: flex; align-items: center; gap: 6px; }
.side-panel .sp-cons-name { flex: none; width: 80px; font-weight: 600; font-size: 13px; color: #fff;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-panel .sp-cons-op { flex: 1; min-width: 0; font-size: 10px; color: rgba(190,208,235,0.75);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-panel .sp-cons-tag { margin-left: auto; flex: none; font-size: 10px; color: #8fd0ff; padding: 1px 6px; border-radius: 3px;
  background: rgba(63,157,255,0.12); border: 1px solid rgba(63,157,255,0.3); white-space: nowrap; }
/* 第二排：国家+彩色国旗小图（左）· 卫星数量（右对齐） */
.side-panel .sp-cons-meta { margin-top: 5px; display: flex; align-items: center; gap: 5px; font-size: 10px; color: rgba(190,208,235,0.75); }
.side-panel .sp-cons-meta .sp-cons-flag { width: 16px; height: 11px; object-fit: cover; border-radius: 1px; flex: none; }
.side-panel .sp-cons-meta .sp-cons-stat { margin-left: auto; color: rgba(190,208,235,0.8); white-space: nowrap; }
/* 第三排：首发 / 最近发射（左对齐） */
.side-panel .sp-cons-dates { margin-top: 4px; display: flex; gap: 4px; font-size: 10px; color: rgba(190,208,235,0.7); }
/* 星座展示 / 轨道展示 按钮：等宽两列；轨道展示在星座未展示时禁用置灰 */
.side-panel .sp-cons-actions { margin-top: 8px; display: flex; gap: 6px; }
.side-panel .sp-cons-btn {
  flex: 1; padding: 4px 0; font-size: 11px; color: rgba(200,216,240,0.85); cursor: pointer;
  background: rgba(63,157,255,0.08); border: 1px solid rgba(120,160,220,0.25); border-radius: 6px;
  &.on { color: #fff; background: rgba(63,157,255,0.35); border-color: rgba(63,157,255,0.7); }
  &:disabled { opacity: 0.35; cursor: not-allowed; }
}
/* 展开按钮：卡底左下（箭头小标 + 文字），展开时三角转 90° 朝下 */
.side-panel .sp-cons-arrow {
  margin-top: 6px; display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 6px;
  background: transparent; border: 1px solid rgba(120,160,220,0.25); border-radius: 4px; cursor: pointer;
  font-size: 10px; color: rgba(190,208,235,0.8);
  svg { width: 8px; height: 8px; fill: rgba(190,208,235,0.8); transition: transform 0.15s; }
  &.open svg { transform: rotate(90deg); }
  &:hover { border-color: rgba(63,157,255,0.6); color: #fff; }
}
/* 成员列表：两列紧凑行（NORAD / 名称），行悬停提亮，点选拉近 */
.side-panel .sp-cons-sats {
  margin-top: 6px; max-height: 240px; overflow-y: auto;
  border-top: 1px solid rgba(120,160,220,0.14);
}
.side-panel .sp-sat-row {
  display: grid; grid-template-columns: 64px 1fr; gap: 4px; align-items: center;
  padding: 3px 2px; font-size: 10px; color: rgba(200,216,240,0.85); cursor: pointer;
  &.sp-sat-title { color: rgba(160,180,210,0.6); cursor: default; }
  &:not(.sp-sat-title):hover { background: rgba(63,157,255,0.12); color: #fff; }
  .sp-sat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.side-panel .sp-cons-empty { padding: 14px 0; text-align: center; font-size: 11px; color: rgba(160,180,210,0.6); }

/* 我的星历分组：与星座卡片同区滚动的尾部区块 */
.side-panel .sp-eph { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(120,160,220,0.16); }
.side-panel .sp-eph-title {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 6px; font-size: 12px; color: #cfe2fa;
  span { font-size: 10px; color: #7d92b0; }
}
.side-panel .sp-eph-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-bottom: 4px; padding: 5px 7px; border-radius: 6px; cursor: pointer;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2);
  &:hover { background: rgba(40,80,140,0.44); border-color: rgba(120,175,255,0.4); }
}
.side-panel .sp-eph-name {
  flex: 1 1 auto; min-width: 0; font-size: 11px; color: #eaf2fc;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.side-panel .sp-eph-meta { flex: none; font-size: 9.5px; color: #7d92b0; }
.side-panel .sp-eph-empty { padding: 2px 2px 4px; font-size: 10px; color: #7d92b0; }
</style>
