<script setup lang="ts">
/**
 * 星座总览 /situation —— 编排容器（组件化重组）
 *
 * 原单文件组件过重，现拆为多层（目录内组件化）：
 *  - BaseScene.vue          基础场景：3D 渲染 / 卫星运动 / 拾取选中 / 过滤轨道线 / 动画循环 / 准星 / 加载遮罩
 *  - SatListPanel.vue       左侧卫星列表面板（搜索 / 类型 / 轨道区域过滤 / 滚动加载）
 *  - ConstellationPanel.vue 左侧星座列表面板（按名称检索 / 点击星座过滤并绘制轨道线）
 *     二者同属 dock「综合态势」入口，点击该入口向上弹出子项菜单（卫星列表 / 星座列表）二选一，默认卫星列表
 *  - CdmHeatmap.vue         碰撞热力面板（三种来源：交会热力 / CDM 热力 / 交会分析热力）
 *  - PassPanel.vue          城市过境面板（行政区划检索列表；点击目标算未来 24h 载荷过境明细，读预计算表）
 *  - RegionPanel.vue        区域过境面板（三维框选多边形 → 提交后端现算；内容见 RegionSection.vue）
 *  - MultiRegionPanel.vue   多区域过境面板（连续框选多个区域 → 一次扫描并给同时覆盖分析）
 *     三者同属 dock「过境分析」入口，点击该入口向上弹出子项菜单（城市过境 / 区域过境 / 多区域过境）三选一
 *
 * 本容器负责：加载编排、底部 dock 导航、右下角图例、右侧卫星详情面板、移动端浮标；
 * 跨组件共享响应式状态集中在 ./scene.ts，子组件纯动作通过 props + emit 上报，本容器再调用 BaseScene.expose。
 */
import { ref, computed, watch, nextTick, onActivated, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDevice } from '@/composables/useDevice'
import BaseScene from './BaseScene.vue'
import SatListPanel from './SatListPanel.vue'
import ConstellationPanel from './ConstellationPanel.vue'
import CdmHeatmap from './CdmHeatmap.vue'
import PassPanel from './PassPanel.vue'
import RegionPanel from './RegionPanel.vue'
import MultiRegionPanel from './MultiRegionPanel.vue'
import SiteListPanel from './SiteListPanel.vue'
import EphemPanel from './EphemPanel.vue'
import AiChatDrawer from './AiChatDrawer.vue'
import { buildAiTarget } from './aiTarget'
import { activeEphem, activateEphem, threatEvents, threatSelected, selectThreat, maneuverStates, maneuverBurnMs } from './ephem/useUserEphemeris'
import { interpolateAt } from './ephem/interp'
import { eciToGeodetic, gstime } from 'satellite.js'
import type { ThreatEvent } from './ephem/types'
import logoUrl from '@/assets/logo/openspace-logo.png'
import type { AiAction } from '@/utils/aiStream'
import {
  LEGEND, TYPE_LABEL, TYPE_KEYS, TYPE_HEX, fmtNum, TWILIGHT_LABEL, SHADOW_LABEL,
  colorMode, COLOR_MODES, colorLegend,
  compareConsts, compareActive, COMPARE_PALETTE,
  dockMode, dockActive, constPanel, consFiltered, constellations, filterConst, filterKw, g,
  simSpeed, simPlaying, simTimeMs,
  consShowMap, consOverrideActive, consShowOf, consCardBound,
  consSatPanel, consHighlightNorad,
  loading, hasSel, filterActive, filterNorads, sel, selDetail, selConstellations, detailOpen, visible, orbitVisible,
  dataSource,
  heatMode, heatSel, heatSelList, heatOpen,
  heatSource, HEAT_SOURCES, heatFocusNorad,
  heatCell, HEAT_CELL_OPTIONS, heatDays, heatDay, heatDayGroups,
  passMode, passSelTarget, passDetail, passLoading, passError, passDetailOpen, passTargets, passProvinceTargets,
  regionPassSel, multiPassSel,
  passDistrictVisible, passBorderVisible, passCityVisible,
  skyLayers, SKY_LAYER_ITEMS, spaceWeather, spaceWeatherLoading, spaceWeatherError,
  sceneQualityTier,
  conjEllipsoid, conjEllipsoidLoading, conjEllipsoidError, covDisplayScale,
  type SkyLayerKey, type SkyViewMode,
  PASS_SOURCES, SAT_SOURCES,
  launchSites, siteLoading, siteError, siteMarkersVisible,
  siteSel, siteOpen, siteUpcoming, siteUpcomingLoading, siteUpcomingError,
  siteHistory, siteHistoryTotal, siteHistoryPage, siteHistoryLoading, siteHistoryError, SITE_HISTORY_PAGE_SIZE,
  cloudRevealed, ephOpen
} from './scene'
import type { CdmHeatEvent, ColorMode, HeatSource, PassSource, SatView } from './scene'
import {
  listLaunchSitesPublic, listUpcomingBySitePublic, listLaunchRecordBySitePublic
} from '@/api/launch_public'
import {
  getSatCatalogOfSatellite,
  type ConjEllipsoidSide, type SatSource, type SatCatalogPublic
} from '@/api/sat_public'
import type { RegionAccessItem } from '@/api/pass_region_public'
import type { MultiRegionAccessItem, CoverageGroup } from '@/api/pass_multi_region_public'
import { getPassElevationProfile, type PassElevationResult } from '@/api/pass_public'
import { useDelayed } from '@/composables/useDelayed'
import { uploadUrl, httpCgi } from '@/utils/request'
import { purposeLabel } from '@/api/satTypes'
import type { ECharts } from 'echarts/core'

defineOptions({ name: 'situation' })

const sceneRef = ref<InstanceType<typeof BaseScene>>()
const { isMobile } = useDevice()
const route = useRoute()
const router = useRouter()
/** 智能体浮层开关：与 dock 的场景视图无关（问答不改变三维现场），单独一份状态。
 *  默认收起：右缘留「太空安全专家」外拉 tag，点击 / 底部 dock 按钮展开（打开应用时不占屏） */
const aiOpen = ref(false)
/** 桌面端「太空安全目标列表」面板收起开关：默认收起，左缘留外拉 tag（点击 / 底部 dock 展开）。
 *  仅桌面端生效 —— 移动端面板是底部抽屉，保持原「进模块即弹出」行为 */
const satPanelClosed = ref(true)
/** 智能体抽屉实例：区域 / 多区域过境面板点「计算」时，把组织好的提示词交给它发起一轮提问 */
const aiDrawerRef = ref<InstanceType<typeof AiChatDrawer>>()
/** 拾取详情面板内 2 个数据块的折叠开关（位置信息/卫星资料）：点击标题可折叠展开，默认展开 */
const posOpen = ref(true)
const metaOpen = ref(true)
/** 星座视图右侧「成员列表」弹框开关：选中星座后展示（可 ✕ 收起，浮标可再展开） */
const consListOpen = ref(true)
/** 过境明细读的是后端预计算表，正常毫秒级返回：默认不显示「正在读取」，超过 1.5s 才出现兜底提示 */
const passLoadingHint = useDelayed(passLoading)

/** 拾取详情的编目国（旗帜 + 中文名）：
 *  碎片（DEBRIS）/ 未知物体（UNKNOWN）不显示编目国，其余目标有字典信息才显示 */
const selOwner = computed(() => {
  const d = selDetail.value
  if (!d?.owner_name || !d.owner_flag) return null
  if (d.object_type === 'DEBRIS' || d.object_type === 'UNKNOWN') return null
  return { name: d.owner_name, flag: uploadUrl(d.owner_flag) }
})

/* ============================================================
 * 卫星详情面板：位置信息 / 卫星资料
 * 主体字段全部来自 /cgi 单星详情的 SELECT t.* （随每次拾取一起下发），前端零额外请求；
 * 「卫星资料」卡片中的归属国家 / 发射时间来自 /cgi/sat_catalog/of/:noradId（随拾取自动拉取），
 * 「所属星座」由 BaseScene 拾取时一并拉取（selConstellations），作为卫星资料的一条信息展示。
 * ============================================================ */

/** 轨道区域码 → 中文（REGIME_LABEL 只做同名英文码映射，详情面板这里给出口语化中文） */
const REGIME_CN: Record<string, string> = {
  LEO: '低地球轨道 LEO',
  MEO: '中地球轨道 MEO',
  GEO: '地球同步轨道 GEO',
  HEO: '大椭圆轨道 HEO',
  OTHER: '其他'
}
/** 在轨状态：sat_tle.is_active（1 在轨 / 0 已离轨） */
function activeLabel(v?: number | null) {
  if (v === 1) return '在轨'
  if (v === 0) return '已离轨'
  return '—'
}

/** 右下角图例标题条双时区时钟：UTC 标准时间 + 北京时间（每秒刷新，左对齐，字号同 dock 按钮）。
 *  北京时间按 UTC+8 显式换算，不依赖浏览器本地时区设置。 */
const clockNow = ref(Date.now())
const clockTimer = window.setInterval(() => { clockNow.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(clockTimer))
const pad2 = (v: number) => String(v).padStart(2, '0')
const clockUtc = computed(() => {
  const d = new Date(clockNow.value)
  return `UTC ${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
})
const clockBjt = computed(() => {
  const d = new Date(clockNow.value + 8 * 3600e3)
  return `北京 ${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
})

/* ---- 星历仿真时间条 ----
 * 常驻底部：播放/暂停、回到当前时刻、拖动播放头（直接改写虚拟时刻）、0.1×/1×/10×/60× 倍率。
 * 时间轴以「当前时刻」为中心（无星历时 ±12h，有星历时扩到能覆盖整段星历），
 * 因此重置后当前时刻恒在进度条正中。倍率由 BaseScene 动画循环乘到 simStepSec 上，与真实帧间隔解耦。 */
const SIM_RATE_OPTIONS = [0.1, 1, 10, 60]
/** 时间轴中心（启动 / 重置 / 切换星历时对齐当前时刻，保证「现在」落在进度条正中） */
const simAnchorMs = ref(Date.now())
/** 无星历时的最小半跨度：前后各 12h */
const SIM_HALF_MIN_MS = 12 * 3600e3
const simHalfSpan = computed(() => {
  const set = activeEphem.value
  if (!set || !set.states.length) return SIM_HALF_MIN_MS
  const a = simAnchorMs.value
  const t0 = set.states[0].t
  const t1 = set.states[set.states.length - 1].t
  return Math.max(SIM_HALF_MIN_MS, Math.abs(a - t0), Math.abs(t1 - a))
})
const simStart = computed(() => simAnchorMs.value - simHalfSpan.value)
const simStop = computed(() => simAnchorMs.value + simHalfSpan.value)
const simRatio = computed(() => {
  const span = simStop.value - simStart.value
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (simTimeMs.value - simStart.value) / span))
})
function fmtSimTime(ms: number, withSec = true) {
  const d = new Date(ms)
  const base = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  return withSec ? `${base}:${pad2(d.getUTCSeconds())}` : base
}
const simClockUtc = computed(() => `${fmtSimTime(simTimeMs.value)} UTC`)
const simRangeText = computed(() => {
  if (!activeEphem.value) return ''
  const hours = Math.round((simStop.value - simStart.value) / 3600e3)
  return `${fmtSimTime(simStart.value, false)} ~ ${fmtSimTime(simStop.value, false)} UTC · ${hours} h`
})
/** 拖动播放头：直接写虚拟时刻（三维在下一帧同步地球自转 / 星历位置），暂停状态下也能定位 */
function simSeek(e: Event) {
  const span = simStop.value - simStart.value
  if (span <= 0) return
  const t = simStart.value + (Number((e.target as HTMLInputElement).value) / 1000) * span
  g.simTimeMs = t
  simTimeMs.value = t
}
/** 播放 / 暂停。停在星历数据末端时按播放先回到数据起点再播：
 *  动画循环里「虚拟时刻 ≥ 数据末端即暂停」是为了避免插值越界，但过期星历（数据整体早于当前时刻）
 *  激活时会被夹到末端，此时直接置 simPlaying=true 会在下一帧被立刻复位，表现为播放键点了没反应 */
function simTogglePlay() {
  if (!simPlaying.value) {
    const set = activeEphem.value
    if (set) {
      const end = set.states.length ? set.states[set.states.length - 1].t : set.stop
      if (g.simTimeMs >= end) {
        const start = set.states.length ? set.states[0].t : set.start
        g.simTimeMs = start
        simTimeMs.value = start
      }
    }
  }
  simPlaying.value = !simPlaying.value
}

/** 重置到当前时刻：时间轴重新以现在为中心（播放头回到正中），显示时刻与右上角 UTC 时钟一致 */
function simResetNow() {
  const now = Date.now()
  simAnchorMs.value = now
  g.simTimeMs = now
  simTimeMs.value = now
}

/** 切换星历：时间轴重新以当前时刻为中心，保证「现在」在正中且整段星历都在可拖动范围内 */
watch(activeEphem, () => { simAnchorMs.value = Date.now() })

/** 卫星资料·归属国家/地区：优先资料库条目（国旗+国名），无条目回退编目国（碎片/未知不显示，与顶部一致） */
const catCountry = computed(() => {
  const cat = catData.value
  if (cat?.country_flag || cat?.country_name || cat?.country_code) {
    return { flag: cat.country_flag ? uploadUrl(cat.country_flag) : '', name: cat.country_name || cat.country_code || '—' }
  }
  return selOwner.value ? { flag: selOwner.value.flag, name: selOwner.value.name } : null
})

/** 详情头部国旗图标：与「卫星资料 · 国家/地区」同一数据源（catCountry），保证两处国家完全一致；
 *  有国家代码时统一用 flagcdn 彩色国旗图标，无代码时回退资料库/编目旗帜图 */
const headerFlag = computed(() => {
  const c = catCountry.value
  if (!c || !c.name || c.name === '—') return null
  const code = (catData.value?.country_code || '').toLowerCase()
  const flag = code ? `https://flagcdn.com/w20/${code}.png` : c.flag
  return flag ? { name: c.name, flag } : null
})

/* ============================================================
 * 面板内联下钻：知识图谱关联 / 卫星资料库
 * 本页是免登录前台（/situation），不能走 /api，故两项都走 /cgi 只读接口，
 * 且「就在当前详情面板里展示」而非跳到 /mui/**；两块默认展开、随拾取一起懒加载。
 *   - 知识图谱关联 → /cgi/kg/neighbors（查询口径的单一实现是 server/lib/knowledgeGraph.js）
 *   - 卫星资料库   → /cgi/sat_catalog/of/:noradId（口径同图谱：sat_tle.catalog_id = sat_catalog.id）
 * ============================================================ */
/** 「卫星资料」卡片的资料库条目（归属国家/发射时间取自此）：随拾取自动拉取，无单独折叠开关 */
const catData = ref<SatCatalogPublic | null>(null)

async function loadCatalog() {
  const n = selDetail.value?.norad_id
  if (n == null) return
  try {
    const data = await getSatCatalogOfSatellite(n)
    if (selDetail.value?.norad_id === n) catData.value = data
  } catch {
    if (selDetail.value?.norad_id === n) catData.value = null
  }
}

/* ---- echarts 内核（仅「过境仰角剖面」折线图用；按需动态引入，不拖累 /situation 首屏） ---- */
let echartsPromise: Promise<typeof import('echarts/core')> | null = null

/** 动态加载 echarts 内核（LineChart + Tooltip + Grid + MarkLine + Canvas），仅首次展开仰角剖面时触发 */
function loadEcharts() {
  if (!echartsPromise) {
    echartsPromise = (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers')
      ])
      core.use([
        charts.LineChart,
        components.TooltipComponent, components.GridComponent,
        components.MarkLineComponent,
        renderers.CanvasRenderer
      ])
      return core
    })()
  }
  return echartsPromise
}

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** 切换选中卫星：清空资料库已加载数据并按新卫星重新拉取（卫星资料卡片随拾取自动刷新） */
watch(() => selDetail.value?.norad_id, () => {
  catData.value = null
  loadCatalog()
})

/** 区域过境面板当前结果批次 id：点选某条明细时由 RegionSection 上报，
 *  仅用于智能体上下文（让它知道用户选中的是哪条明细，可直接出报告）。 */
const regionPassRunId = ref<number | null>(null)

/** dock「初始化窗口」：整页刷新（重新拉取全部数据与三维现场，等价于浏览器刷新） */
function reloadSystem() {
  window.location.reload()
}

/* ============================================================
 * dock / 面板编排（纯动作，调用 BaseScene.expose）
 * ============================================================ */
/** dock 七个视图态（与 scene.ts 的 DockMode 去掉空态一致），同时也是 /situation/:type 的合法取值。
 *  dock 上只呈现三个按钮：交会热力 / 专家 / 重启系统（综合态势、过境分析、星历分析入口已按需求移除，
 *  对应视图仍可通过 /situation/:type 深链直达；卫星/星座/发射站列表由左缘外拉 tag 打开，
 *  星历分析由右缘外拉 tag 打开）。 */
const DOCK_TYPES = ['sat', 'cons', 'site', 'heat', 'pass', 'region', 'multi', 'eph'] as const
type DockType = (typeof DOCK_TYPES)[number]

/** 「综合态势」下的三个子项（卫星列表 / 星座列表 / 发射站列表）：dock 上合并为一个入口，默认子项「卫星列表」。
 *  三者都算「综合态势」已激活 —— 主按钮高亮、子项当前态、面板再点收起、模块间切换判断共用这一份口径。 */
const SAT_VIEWS: readonly string[] = ['sat', 'cons', 'site']

/** 「过境分析」下的三个子项（城市 / 区域 / 多区域）：dock 上合并为一个入口。
 *  三者都算「过境分析」已激活 —— 主按钮高亮、子项当前态、面板再点收起、模块间切换判断共用这一份口径，
 *  历史上漏掉 multi 时表现为：进入 /situation/multi 后 dock 上「过境分析」不高亮。 */
const PASS_VIEWS: readonly string[] = ['pass', 'region', 'multi']

/** 进入星座管理时默认选中第一个星座并绘出轨道线（仅「进入模块」时默认；之后搜索/手动点选以用户为准）。
 *  同理于卫星管理：进入即是干净的初始态，再叠加本模块的默认呈现。 */
function selectDefaultConstellation() {
  // 对比态下不被「默认选第一个单星座」覆盖（对比由智能体动作驱动，filterConst 保持空）
  if (compareActive.value) return
  if (filterConst.value) return
  // 进入星座模块默认选中：同样清掉 NORAD 集合（与 pickConstellation 同口径）
  filterNorads.value = null
  const first = consFiltered.value[0]
  if (first) filterConst.value = first.name
}

/** 把选中模块写回地址栏（replace，不产生历史记录）：刷新 / 从后台切回时按 type 恢复选中模块，不再落回第一个 */
function syncUrl(type: DockType) {
  if (route.params.type === type) return
  router.replace({ name: 'situation', params: { type } })
}

/* 热力聚合格边：URL ?cell=0.05|0.15|0.3 持久化（P3）。
 * 首次进入按地址栏恢复；用户切换后写回地址栏，刷新 / 分享链接保持同一观察尺度。 */
if (HEAT_CELL_OPTIONS.some((o) => o.v === Number(route.query.cell))) {
  heatCell.value = Number(route.query.cell)
}
watch(heatCell, (v) => {
  const s = String(v)
  if (String(route.query.cell ?? '') === s) return
  router.replace({ query: { ...route.query, cell: s } })
})

/* 热力时间窗 / 按天切片：URL ?days=&day= 持久化（P3）。
 * days 由面板时间窗按钮写入；day 仅在选中某一天时写，切回「全」即删除。
 * 首次进入按地址栏恢复：day 要等后端按日分组返回后才知道该天是否存在，故延迟到 heatDayGroups 就绪。 */
if (route.query.days != null) {
  const d = Number(route.query.days)
  if (Number.isFinite(d) && d >= 0) heatDays.value = d
}
const urlDay = Number(route.query.day)
let urlDayPending = Number.isFinite(urlDay) && urlDay >= 1
watch(heatDayGroups, (gs) => {
  if (!urlDayPending || !gs.length) return
  urlDayPending = false
  if (gs.some((g) => g.day === urlDay)) heatDay.value = urlDay
})
watch([heatDays, heatDay], () => {
  const q = { ...route.query }
  let dirty = false
  const days = String(heatDays.value)
  if (String(q.days ?? '') !== days) { q.days = days; dirty = true }
  const day = heatDay.value >= 1 ? String(heatDay.value) : ''
  if (day) {
    if (String(q.day ?? '') !== day) { q.day = day; dirty = true }
  } else if (q.day != null) {
    delete q.day
    dirty = true
  }
  if (dirty) router.replace({ query: q })
})

/** 进入模块：dock 高亮 + 展开对应面板 + 切视图（sat 重建卫星索引 / cons 默认选第一个星座 / heat 开热力 / pass 开过境）。
 *  writeUrl=false 供「按地址栏恢复」调用，避免与地址栏恢复互相触发。
 *
 *  两个视图开关（heatMode / passMode）在此**一律显式设置**：若只在部分分支设置，
 *  「clearScene 置 false → 本函数再置 true」会在同一 tick 内被合并成净变化 0，
 *  watch(heatMode/passMode) 不触发 → 卫星云可见性停在错误状态
 *  （过境分析内切换「城市过境 ↔ 区域过境」时曾出现卫星齐现，即此因）。 */
function applyDock(type: DockType, writeUrl = true) {
  heatMenuOpen.value = false
  passMenuOpen.value = false
  satMenuOpen.value = false
  dockMode.value = type
  // 星历面板用独立开关 ephOpen：进入星历视图（含 URL 深链恢复）即展开面板
  if (type === 'eph') ephOpen.value = true
  // 热力 / 过境三类面板是「专项分析视图」：进入时排除其它叠加展示（NORAD 集合轨道线、多星座对比轨道线、
  //  星座着色），只显示该面板要展示的内容 —— 否则「卫星轨道 + 碰撞轨道」会混在一起。
  //  清掉 filterNorads 后 satSetActive=false → 卫星云整片隐藏（hideCloud 门控天然满足）。
  if (type === 'heat' || type === 'pass' || type === 'region' || type === 'multi' || type === 'eph') {
    filterNorads.value = null
    compareConsts.value = []
    if (colorMode.value === 'compare') colorMode.value = 'type'
  }
  // 离开碰撞热力时清掉「本次打开要聚焦的目标卫星」标记，避免残留影响下次手动打开该面板
  if (type !== 'heat') heatFocusNorad.value = null
  // 进入热力（从其它模块切过来）：默认时间窗 7 天；地址栏已显式带 days 时以地址栏为准（P3）。
  //  7 天窗口若因本地批次偏旧为空，BaseScene 会自动回落到「全部」，避免首屏空图。
  if (type === 'heat' && dockActive.value !== 'heat' && route.query.days == null) heatDays.value = 7
  dockActive.value = type
  heatMode.value = type === 'heat'
  passMode.value = type === 'pass' || type === 'region' || type === 'multi'
  // 发射站视图开关：与 heatMode / passMode 一样**一律显式设置**（原因见上），进入时按需拉站列表
  siteMarkersVisible.value = type === 'site'
  // 发射站视图：把图例上「载荷卫星 / 空间碎片 / 火箭箭体 / 未知物体」与「轨道线」5 行取消勾选
  //   （发射站视图看的是发射站，不该叠着卫星与轨道线）；图例行本身仍保留，可手动再勾选。
  //   切回卫星 / 星座视图时**不会**自动替用户重新勾选（类型开关只跟随用户显式操作）。
  if (type === 'site') {
    for (const k of TYPE_KEYS) visible[k] = false
    orbitVisible.value = false
  }
  if (type === 'sat') {
    if (g.cloudList.length) sceneRef.value?.rebuildSatIndex()
  } else if (type === 'cons') {
    selectDefaultConstellation()
  } else if (type === 'site') {
    void loadLaunchSites()
  }
  if (writeUrl) syncUrl(type)
}

/** 只清空三维现场与临时态（过滤 / 选中卫星 / 热力选中 / 区域框选），不改 dock 选中态与地址栏；
 *  供模块间切换与「还原」「长按返回」复用。
 *
 *  注意：heatMode / passMode 不在此处置位 —— 它们由 applyDock 按目标模块显式设置。
 *  在这里置 false 再在 applyDock 置回 true，同一 tick 内会被合并成「净变化 0」，
 *  watch 不触发 → 卫星云会停在 restoreSatVisible 设的「全可见」。 */
function clearScene() {
  heatMenuOpen.value = false
  passMenuOpen.value = false
  satMenuOpen.value = false
  heatSel.value = null
  heatSelList.value = []
  heatOpen.value = false
  // 发射站选中一并清掉（站列表本身保留在 launchSites，重进模块无需重拉）；图层显隐由 applyDock 显式设置
  siteSel.value = null
  // 退出区域过境：关掉框选并清空顶点草稿（与其它临时态一样，模块间切换时彻底还原）
  sceneRef.value?.setRegionDrawMode(false)
  sceneRef.value?.clearRegionDraft()
  sceneRef.value?.resetToInitial()
}

/** 收起卫星列表面板：仅收起面板，保留选中卫星与 dock 激活态（准星/轨道线/右侧详情） */
function closeSatPanel() { dockMode.value = '' }

/** 左缘外拉 tag 可见性（桌面端）：只看「左列表面板自身」是否收起 ——
 *  面板展开时（dockMode='sat' 且未手动收起）隐藏，其余情况（含星历面板展开）都保留，
 *  这样左右两侧 tag / 面板状态互相独立 */
const showSatTag = computed(() => !isMobile.value && (dockMode.value !== 'sat' || satPanelClosed.value))

/** 右缘外拉 tag 可见性（桌面端）：只看星历面板自身是否展开，与左侧面板/模块无关；
 *  右侧详情（卫星/热力/过境等）打开时隐藏，避免压在详情卡片右缘 */
const showEphemTag = computed(() => !isMobile.value && !ephOpen.value && !rightMode.value)

/** 点左缘外拉 tag：只拉出「太空安全目标列表」面板，不揭示三维点云（用户口径：打开列表 ≠ 加载目标；
 *  目标点云在列表中点选具体目标（satSetActive）或 URL 深链时才显示）。
 *  chooseSatView 传 reveal=false 避免其内部揭示逻辑被间接触发 */
function openSatPanel() {
  satPanelClosed.value = false
  if (dockMode.value !== 'sat') chooseSatView('sat', false)
}

/** 收起星座列表面板：仅收起面板，保留当前三维与 dock 激活态（过滤轨道线/选中/拾取/镜头） */
function closeConsPanel() { dockMode.value = ''; constPanel.q = '' }

/** 收起发射站列表面板：仅收起面板，保留地球上的发射站标记与选中站（右侧详情继续可看） */
function closeSitePanel() { dockMode.value = '' }

/** 收起碰撞热力面板：仅收起面板，保留热力云与 dock 激活态（隐藏面板后仍可继续观察/拾取热力事件） */
function closeHeatPanel() { dockMode.value = ''; heatMenuOpen.value = false }

/* ---- 星历分析（高精度星历上传 + 交会威胁筛选） ----
 * 与其它模块不同：三维图层（星历轨迹 + 威胁事件）由本模块的 activeEphem 驱动，
 * 面板关闭后图层仍保留（与热力云同口径），切到其它模块时由图层内部按 dockActive 自动隐藏。
 * 展开态用独立的 ephOpen（不影响 dockMode）→ 左右两侧 tag / 面板互不干扰。 */
function closeEphemPanel() { ephOpen.value = false }

/** 星历质量卡「AI 解读」：把面板组织好的指标交给智能体抽屉（推算模式，不查历史批次） */
function onEphemAiExplain(text: string) {
  void aiDrawerRef.value?.ask(text)
}

/* ---- 「我的星历」：左侧列表入口 / 分组点选 → 右侧详情 card ----
 * 右侧详情与星历分析面板占用同一侧，因此二者互斥：点选星历只展示详情 card，
 * card 内按钮再打开完整面板（上传 / 筛选都在面板里）。 */
const ephDetailId = ref('')
const ephDetailOpen = ref(false)
/** 用户星历威胁事件详情（与星历详情共用右侧位置；选中事件时展示，取消高亮时收起） */
const ephEvOpen = ref(false)

/** 点选「我的星历」：带 id 时先激活该份星历并展示详情 */
async function onOpenEph(id?: string) {
  if (id) {
    await activateEphem(id)
    if (activeEphem.value?.id === id) {
      focusActiveEphem()
      ephDetailId.value = id
      ephDetailOpen.value = true
      if (ephOpen.value) ephOpen.value = false
    }
    return
  }
  ephDetailOpen.value = false
  if (!ephOpen.value) toggleEphemDock()
}

/** 右侧「我的星历」详情：按仿真时刻插值出当前位置（经纬高 / 速度） */
const ephDetail = computed(() => {
  const set = activeEphem.value
  if (!set || set.id !== ephDetailId.value || !set.states.length) return null
  const st = set.states
  const t = Math.min(Math.max(simTimeMs.value, st[0].t), st[st.length - 1].t)
  const s = interpolateAt(st, t)
  if (!s) return null
  const geo = eciToGeodetic({ x: s.r[0], y: s.r[1], z: s.r[2] }, gstime(new Date(t)))
  return {
    name: set.name,
    norad: set.norad,
    format: set.format,
    frame: set.frame,
    start: st[0].t,
    stop: st[st.length - 1].t,
    points: st.length,
    stepSec: set.stepSec,
    hasCov: st.some((x) => !!x.cov),
    lat: (geo.latitude * 180) / Math.PI,
    lon: (geo.longitude * 180) / Math.PI,
    alt: geo.height,
    vel: Math.hypot(s.v[0], s.v[1], s.v[2])
  }
})

/** 点击 dock「星历分析」/ 右缘 tag：展开/收起星历面板。
 *  打开时若左侧「太空安全目标列表」正展开，则 applyDock 后把 dockMode 还原，两侧面板可同时存在 */
function toggleEphemDock() {
  heatMenuOpen.value = false
  passMenuOpen.value = false
  satMenuOpen.value = false
  if (ephOpen.value) { ephOpen.value = false; return }
  ephDetailOpen.value = false
  ephEvOpen.value = false
  const keepLeft = dockMode.value === 'sat'
  if (dockActive.value && dockActive.value !== 'eph') clearScene()
  applyDock('eph')
  if (keepLeft) dockMode.value = 'sat'
}

/** 移动端底部 tab：星历走独立开关，其它面板仍按 dockMode 展开 */
function openActivePanel() {
  if (dockActive.value === 'eph') { toggleEphemDock(); return }
  dockMode.value = dockActive.value
}

/** 面板里点选/载入星历后：三维绘出轨迹，并按「双击卫星」同一套效果拉近跟踪目标当前位置 */
function focusActiveEphem() {
  const set = activeEphem.value
  sceneRef.value?.setUserEphem(set)
  sceneRef.value?.setUserEphemThreats(threatEvents.value)
  sceneRef.value?.setUserEphemManeuver(maneuverStates.value, maneuverBurnMs.value)
  if (set) sceneRef.value?.trackUserEphem()
}

/** 面板里点选威胁事件：三维定位并高亮（null = 取消高亮） */
function focusEphemEvent(ev: ThreatEvent | null) {
  sceneRef.value?.focusUserEphemEvent(ev)
}

/** 选中威胁事件 → 右侧展示事件详情（与星历详情互斥，避免两张卡叠在同一位置） */
watch(threatSelected, (ev) => {
  ephEvOpen.value = !!ev
  if (ev) {
    ephDetailOpen.value = false
    // 用户星历事件优先于后端热力详情：收起热力卡，避免旧选中遮挡
    heatOpen.value = false
  }
})

/** 事件详情里「打开星历面板 / 机动仿真」：收起详情卡，展开面板（保留事件选中供 TCA 预设使用） */
function openEphForEvent() {
  ephEvOpen.value = false
  if (!ephOpen.value) toggleEphemDock()
}

/** 热力面板「我的星历」页签点选事件：先激活对应星历（恢复其持久化事件），再选中并三维定位 */
async function onPickEphEvent(payload: { setId: string; event: ThreatEvent }) {
  if (activeEphem.value?.id !== payload.setId) await activateEphem(payload.setId)
  const ev = threatEvents.value.find((e) => e.id === payload.event.id) || payload.event
  selectThreat(ev)
  focusEphemEvent(ev)
}

/** 事件详情文案：等级 → 中文 + 配色 */
const EPH_EV_LEVEL: Record<ThreatEvent['level'], { label: string; color: string }> = {
  high: { label: '高危', color: '#ff6b6b' },
  medium: { label: '警告', color: '#ffb454' },
  low: { label: '关注', color: '#7fb0ff' }
}

/** 激活的星历变化（上传成功 / 切换 / 删除）：同步三维图层，并清掉上一份星历的机动双轨迹 */
watch(activeEphem, (set) => {
  sceneRef.value?.setUserEphem(set)
  sceneRef.value?.setUserEphemThreats(threatEvents.value)
  sceneRef.value?.setUserEphemManeuver(null, null)
})

/** 机动仿真结果变化：三维叠加「原方案虚线 + 机动后实线」双轨迹 */
watch([maneuverStates, maneuverBurnMs], ([states, burn]) => {
  sceneRef.value?.setUserEphemManeuver(states, burn)
})

/** 威胁筛选结果变化：同步三维威胁点云（按风险等级配色） */
watch(threatEvents, (list) => {
  sceneRef.value?.setUserEphemThreats(list)
})

/** 收起城市过境面板：仅收起面板，保留过境视图（国界/城市叠加仍可继续观察与拾取） */
function closePassPanel() { dockMode.value = '' }

/** 收起区域过境面板：仅收起面板，保留过境视图与已框选的多边形（描边继续显示，可再次展开继续） */
function closeRegionPanel() { dockMode.value = '' }

/** 详情头副标题：行政区划显示「省份 · 层级 · 区划码」，国界面显示所属国家 */
const passTargetSub = computed(() => {
  const t = passSelTarget.value
  if (!t) return ''
  if (t.geo_type === 'district') {
    const lv = t.level === 'province' ? '省级' : '地级市'
    return [t.province || '中国', lv, t.adcode].filter(Boolean).join(' · ')
  }
  return t.country || '国界'
})

/** 点击左侧过境目标列表某一项：按目标 id 让三维地球计算并展示该目标过境明细（与直接点地球行政区划面同一路径）。
 *  opts.listOnly：AI 过境回答路径用 —— 明细全部卫星的轨道环照常构建，但只有 show_satellites 列出的那几颗可见。 */
function pickFromPassList(targetId: number, opts?: { listOnly?: boolean }) { sceneRef.value?.pickPassTargetById(targetId, opts) }

/** 过境事件卡「尽力而为」定位：目标选中后其过境明细是异步加载的，短轮询等到该星的明细记录后聚焦这一次过境
 *  （画空间轨道标记 + 复染轨道线 + 镜头转过去）。取不到（目标无明细 / 该星不在其中）则只停在目标级高亮，不阻塞。 */
function focusPassRecordByNorad(norad: number) {
  const t0 = Date.now()
  const timer = window.setInterval(() => {
    const hit = (passDetail.value?.list || []).find((r) => Number(r.norad_id) === norad)
    if (hit || Date.now() - t0 > 12000) {
      window.clearInterval(timer)
      if (hit) void sceneRef.value?.focusPassRecord(hit)
    }
  }, 200)
}

/** 等过境目标列表（passTargets / passProvinceTargets）就绪并解析出目标 id：行政区划面 / 国界 / 省级面底图是
 *  异步加载的，智能体动作到达时目标可能还没进内存（首次进城市过境尤其如此）。
 *  地市 / 国界面优先，省级聚合面兜底（「问整省」时目标在省级面集合里）。
 *  这里按 id（或名称）短轮询等待，超时放弃（只停在城市过境页，不阻塞其它动作）。
 *  id 优先、名称兜底：中文名 / 名称先精确匹配、再退化为包含匹配。 */
function awaitPassTargetId(a: Extract<AiAction, { kind: 'select_pass_city' }>): Promise<number | null> {
  const want = Number(a.targetId)
  const nm = String(a.name || '').trim()
  const match = (): number | null => {
    const list = [...passTargets.value, ...passProvinceTargets.value]
    if (Number.isFinite(want) && want > 0) {
      const hit = list.find((t) => t.id === want)
      if (hit) return hit.id
    }
    if (nm) {
      const hit = list.find((t) => [t.name_cn, t.name, t.name_en].some((x) => String(x || '').trim() === nm))
        || list.find((t) => [t.name_cn, t.name].some((x) => String(x || '').includes(nm)))
      if (hit) return hit.id
    }
    return null
  }
  const hit = match()
  if (hit != null) return Promise.resolve(hit)
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = window.setInterval(() => {
      const id = match()
      if (id != null || Date.now() - t0 > 12000) {
        window.clearInterval(timer)
        resolve(id)
      }
    }, 200)
  })
}

/** 区域过境面板的框选动作 → BaseScene.expose（与城市过境的 pickFromPassList 同一转发路径） */
function onRegionAction(a: 'start' | 'stop' | 'undo' | 'clear') {
  const s = sceneRef.value
  if (!s) return
  if (a === 'start') s.setRegionDrawMode(true)
  else if (a === 'stop') s.setRegionDrawMode(false)
  else if (a === 'undo') s.removeLastRegionVertex()
  else s.clearRegionDraft()
}

/** 点击区域过境结果列表某一项：三维地球绘制该次过境的卫星模型 + 轨道 + 扫描区域（rec 为 null 表示取消选中）。
 *  runId 由 RegionSection 一并上报（当前结果批次 id），存下来供智能体上下文定位该条明细 → 直接出报告。 */
function pickRegionRecord(rec: RegionAccessItem | null, runId?: number) {
  regionPassRunId.value = rec ? (Number(runId) || null) : null
  sceneRef.value?.focusRegionPass(rec)
}

/** 多区域过境面板的框选动作 → BaseScene.expose（走**独立于区域过境**的多区域状态：
 *  start=开始/继续框选本区域，finish=完成本区域（≥3 点则收入列表），stop=退出框选，undo=撤销顶点，clear=清空全部） */
function onMultiRegionAction(a: 'start' | 'finish' | 'stop' | 'undo' | 'clear') {
  const s = sceneRef.value
  if (!s) return
  if (a === 'start') s.setMultiDrawMode(true)
  else if (a === 'finish') s.finishMultiArea()
  else if (a === 'stop') s.setMultiDrawMode(false)
  else if (a === 'undo') s.removeLastMultiVertex()
  else s.clearMultiAreas()
}

/** 收起多区域过境面板：仅收起面板，保留已框选的多个区域（描边继续显示，可再次展开继续） */
function closeMultiRegionPanel() { dockMode.value = '' }

/** 点击多区域过境明细某一项：三维地球绘制该次过境的卫星模型 + 轨道 + **该记录所属区域**的扫描条带
 *  （rec 为 null 表示取消选中）。areaPolygon 取后端结果里带回的真实多边形，缺省退回本地已框区域。 */
function pickMultiRegionRecord(rec: MultiRegionAccessItem | null, areaPolygon?: [number, number][] | null) {
  sceneRef.value?.focusMultiRegionPass(rec, areaPolygon || null)
}

/** 点击多区域过境「同时覆盖」卡片：这是真实的多区域过境（同一颗星同一时段命中多个区域），
 *  三维地球按组内每个区域分别绘制扫描条带，轨道与卫星模型只画一份（group 为 null 表示取消选中）。 */
function pickMultiRegionCoverage(
  group: CoverageGroup | null,
  areaPolygons: { area_index: number; polygon: [number, number][] }[]
) {
  sceneRef.value?.focusMultiRegionCoverage(group, areaPolygons)
}

/** 播放 / 暂停多区域过境该次记录的卫星飞行（沿 AOS→LOS 推进虚拟时间） */
function toggleMultiRegionPlay() { sceneRef.value?.toggleMultiRegionPassPlay() }

/** 多区域过境播放进度定位（ratio 0~1） */
function seekMultiRegionRecord(ratio: number) { sceneRef.value?.seekMultiRegionPass(ratio) }

/** 播放 / 暂停该次过境的卫星飞行（沿 AOS→LOS 推进虚拟时间） */
function toggleRegionPlay() { sceneRef.value?.toggleRegionPassPlay() }

/** 播放进度定位（ratio 0~1） */
function seekRegionRecord(ratio: number) { sceneRef.value?.seekRegionPass(ratio) }

/* ============================================================
 * 发射站列表（综合态势第三项，/cgi 免登录只读）
 * 编排：进入模块拉全量发射站（地球按经纬度打点）→ 点站（地球标记 / 左侧列表）写 siteSel
 *      → 本容器 watch siteSel 拉该站的「即将发射 + 发射历史」供右侧面板展示。
 * 数据变动由定时任务驱动，前端不感知，故站列表只拉一次（离开模块保留，重进不重拉）。
 * ============================================================ */
/** 站列表是否已拉过（成功才置位；失败允许重进模块时重试） */
let launchSitesLoaded = false
/** 站列表加载中的在途 promise：并发调用共享同一次请求。
 *  背景：AI 的 select_site 动作「先 applyDock('site')（内部异步首次拉取）→ 紧接着选中该站」，
 *  若后者不等前者，就会在 launchSites 还空时选中失败（selectLaunchSiteById 会返回 false）。 */
let launchSitesPromise: Promise<void> | null = null

/** 拉取全量发射站（含经纬度 + 即将发射条数），供地球打点；已加载则直接返回（并发调用共享同一请求） */
async function loadLaunchSites(force = false) {
  if (launchSitesLoaded && !force) return
  if (launchSitesPromise) return launchSitesPromise
  launchSitesPromise = (async () => {
    siteLoading.value = true
    siteError.value = ''
    try {
      const r = await listLaunchSitesPublic()
      // mysql2 未开 decimalNumbers，launch_site.lat/lon（decimal(10,6)）会读成字符串；
      // 打点侧用 Number.isFinite(lat/lon) 过滤，不在这里转数值会导致标记被全部滤掉、地球上看不到点。
      launchSites.value = (r?.list || []).map((s) => ({ ...s, lat: Number(s.lat), lon: Number(s.lon) }))
      launchSitesLoaded = true
    } catch (e) {
      siteError.value = e instanceof Error ? e.message : '发射站加载失败'
    } finally {
      siteLoading.value = false
    }
  })()
  try {
    await launchSitesPromise
  } finally {
    launchSitesPromise = null
  }
}

/** 点击左侧站列表 / 地球标记 → 交给 BaseScene 选中（写 siteSel + 高亮 + 镜头飞过去），加载由 watch siteSel 触发 */
function pickFromSiteList(siteId: number) { sceneRef.value?.pickLaunchSiteById(siteId) }

/** 拉某站的即将发射计划（按 NET 升序，最多 50 条）；站点已切换则丢弃旧响应 */
async function loadSiteUpcoming(siteId: number) {
  siteUpcomingLoading.value = true
  siteUpcomingError.value = ''
  siteUpcoming.value = []
  try {
    const r = await listUpcomingBySitePublic(siteId)
    if (siteSel.value?.id !== siteId) return
    siteUpcoming.value = r?.list || []
  } catch (e) {
    if (siteSel.value?.id !== siteId) return
    siteUpcomingError.value = e instanceof Error ? e.message : '即将发射加载失败'
  } finally {
    if (siteSel.value?.id === siteId) siteUpcomingLoading.value = false
  }
}

/** 拉某站的发射历史（与后台同口径，按发射时间倒序，分页） */
async function loadSiteHistory(siteId: number, page: number) {
  siteHistoryLoading.value = true
  siteHistoryError.value = ''
  try {
    const r = await listLaunchRecordBySitePublic(siteId, page, SITE_HISTORY_PAGE_SIZE)
    if (siteSel.value?.id !== siteId) return
    siteHistory.value = r?.list || []
    siteHistoryTotal.value = r?.total || 0
    siteHistoryPage.value = page
  } catch (e) {
    if (siteSel.value?.id !== siteId) return
    siteHistoryError.value = e instanceof Error ? e.message : '发射历史加载失败'
  } finally {
    if (siteSel.value?.id === siteId) siteHistoryLoading.value = false
  }
}

/** 选中站变化 → 拉该站即将发射与发射历史首页（清空上一站残留） */
watch(siteSel, (s) => {
  if (!s) {
    siteUpcoming.value = []
    siteHistory.value = []
    siteHistoryTotal.value = 0
    siteHistoryPage.value = 1
    return
  }
  void loadSiteUpcoming(s.id)
  void loadSiteHistory(s.id, 1)
})

/** 发射历史翻页 */
function changeSiteHistoryPage(p: number) {
  const id = siteSel.value?.id
  if (!id || p < 1) return
  const maxPage = Math.max(1, Math.ceil(siteHistoryTotal.value / SITE_HISTORY_PAGE_SIZE))
  if (p > maxPage) return
  void loadSiteHistory(id, p)
}

/** 发射历史总页数（至少 1 页） */
const siteHistoryPages = computed(() => Math.max(1, Math.ceil(siteHistoryTotal.value / SITE_HISTORY_PAGE_SIZE)))

/** 站列表表头副标题：国别 + 经纬度 */
function siteSub(s: { country_code?: string | null; lat: number; lon: number }) {
  return [s.country_code || '—', `${fmtNum(s.lat, 2)}°, ${fmtNum(s.lon, 2)}°`].join(' · ')
}

/** 后端 datetime 串（UTC，"YYYY-MM-DD HH:mm:ss"）→ `MM-DD HH:mm`：只重排不做时区换算 */
function fmtUtc(s?: string | null, withYear = false) {
  if (!s) return '—'
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return String(s)
  return withYear ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/** unix ms → UTC `YYYY-MM-DD HH:mm`（星历时段用；统一走 fmtUtc 的字符串口径） */
function fmtUtcMs(ms?: number | null, withYear = true) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return fmtUtc(new Date(ms).toISOString(), withYear)
}

/** 站类型标签（land 陆基 / sea 海基） */
const SITE_TYPE_LABEL: Record<string, string> = { land: '陆基', sea: '海基' }
/** 发射结果标签（GCAT：success / failure / unknown） */
const OUTCOME_LABEL: Record<string, string> = { success: '成功', failure: '失败', unknown: '未知' }

/* ============================================================
 * 「综合态势」子项菜单（dock 按钮点击后向上弹出）
 * 与「热力来源」「过境分析」同款：卫星列表（检索并拾取单星）/ 星座列表（按星座过滤成员）二选一，
 * 两者同属「总览态势」入口，故 dock 上合并为一个「综合态势」入口 + 子项菜单。
 * ============================================================ */
/** 子项菜单开关 */
const satMenuOpen = ref(false)

/** 默认子项：卫星列表（进入本模块 / 从其它模块切过来时落在这里） */
const SAT_DEFAULT: SatView = 'sat'

/** 选定子项：切入对应面板（模块间切换先彻底还原，等价于手动切菜单）；
 *  reveal=false 时跳过点云揭示（左缘 tag 打开列表面板用：只弹窗、不加载目标） */
function chooseSatView(key: SatView, reveal = true) {
  heatMenuOpen.value = false
  passMenuOpen.value = false
  satMenuOpen.value = false
  if (dockActive.value !== key) clearScene()
  applyDock(key)
  // 用户从 dock 主动进入卫星列表 → 拉出面板（缺省收起只针对「应用刚打开」的静默恢复，见 restoreDock）；
  // 同时揭示三维点云（首页「无目标」门控：只有用户主动进入目标列表才显示卫星/碎片等）
  if (key === 'sat') {
    satPanelClosed.value = false
    if (reveal) cloudRevealed.value = true
  }
}

/** 点击 dock「综合态势」：展开/收起卫星 / 星座列表面板。
 *  - 已在综合态势（卫星列表 / 星座列表）：再点一次只收起面板，保留三维现场（选中/轨道线/镜头）；
 *  - 从其它模块切过来 / 面板已收起：先彻底还原（切模块时），再展开当前子项面板并弹出子项菜单便于切换；
 *    当前不在卫星/星座（如从碰撞热力切过来）时，按默认子项「卫星列表」进入。 */
function toggleSatDock() {
  heatMenuOpen.value = false
  passMenuOpen.value = false
  const cur: SatView = SAT_VIEWS.includes(dockActive.value) ? (dockActive.value as SatView) : SAT_DEFAULT
  // 再点一次：只收起面板，保留三维现场
  if (SAT_VIEWS.includes(dockMode.value)) {
    dockMode.value = ''
    satMenuOpen.value = false
    return
  }
  if (dockActive.value && !SAT_VIEWS.includes(dockActive.value)) clearScene()
  applyDock(cur)
  // 从 dock 主动进入卫星列表 → 拉出面板（与 chooseSatView 同口径），并揭示三维点云
  if (cur === 'sat') { satPanelClosed.value = false; cloudRevealed.value = true }
  satMenuOpen.value = true
}

/* ============================================================
 * 「交会热力」入口（dock 按钮点击后直接弹出底部热力面板）
 * 固定以「交会分析热力」（cri 来源）打开，与旧版「碰撞热力 → 来源菜单 → 交会分析热力」等价一步到位。
 * ============================================================ */
/** 来源菜单开关（旧版来源菜单已移除，保留该状态位供其它编排函数统一关闭菜单） */
const heatMenuOpen = ref(false)

/** 点击 dock「交会热力」：直接展开「交会分析热力」底部面板。
 *  - 面板已开且来源已是 cri：再点一次只收起面板，保留热力云与 dock 选中态；
 *  - 从其它模块切过来：先彻底还原初始状态，再切到 cri 来源并开启热力视图。 */
function openCriHeatDock() {
  passMenuOpen.value = false
  satMenuOpen.value = false
  heatMenuOpen.value = false
  if (dockMode.value === 'heat' && heatSource.value === 'cri') { dockMode.value = ''; return }
  if (dockActive.value && dockActive.value !== 'heat') clearScene()
  heatSource.value = 'cri'
  applyDock('heat')
}

/* ============================================================
 * 「过境分析」子项菜单（dock 按钮点击后向上弹出）
 * 与「热力来源」菜单同款：城市过境（读预计算明细）/ 区域过境（框选现算）二选一。
 * 两者共用同一个过境视图（passMode）与地表叠加图层，只是交互与面板不同，
 * 故 dock 上合并为一个「过境分析」入口 + 子项菜单。
 * ============================================================ */
/** 子项菜单开关 */
const passMenuOpen = ref(false)

/** 选定子项：切入对应面板与视图（模块间切换先彻底还原，等价于手动切菜单） */
function choosePassSource(key: PassSource) {
  heatMenuOpen.value = false
  passMenuOpen.value = false
  satMenuOpen.value = false
  if (dockActive.value !== key) clearScene()
  applyDock(key)
}

/** 点击 dock「过境分析」：展开/收起过境面板。
 *  - 已在过境模块（城市 / 区域 / 多区域）：再点一次只收起面板，保留过境视图与已框选的多边形；
 *  - 从其它模块切过来 / 面板已收起：先彻底还原（切模块时），再展开当前子项面板并弹出子项菜单便于切换。 */
function togglePassDock() {
  heatMenuOpen.value = false
  satMenuOpen.value = false
  const cur: PassSource = PASS_VIEWS.includes(dockActive.value) ? (dockActive.value as PassSource) : 'pass'
  // 再点一次：只收起面板，保留过境视图（国界/城市/框选描边继续显示）
  if (PASS_VIEWS.includes(dockMode.value)) {
    dockMode.value = ''
    passMenuOpen.value = false
    return
  }
  if (dockActive.value && !PASS_VIEWS.includes(dockActive.value)) clearScene()
  applyDock(cur)
  passMenuOpen.value = true
}

/* dock 子菜单「收起态」标题：父标签·当前子项完整标签（如「综合态势·星座列表」）。
 * 收起态只露一行，带上当前选中子项，一眼看清选的是哪一项；展开后仍由下方子项列表逐项选择。
 * 当前不在该模块时按各自默认子项（卫星列表 / 交会热力 / 城市过境）兜底。 */
const satMenuTitle = computed(() => {
  const cur: SatView = SAT_VIEWS.includes(dockActive.value) ? (dockActive.value as SatView) : SAT_DEFAULT
  return `综合态势·${SAT_SOURCES.find((s) => s.key === cur)?.label || '太空安全目标列表'}`
})
const heatMenuTitle = computed(
  () => `碰撞热力·${HEAT_SOURCES.find((s) => s.key === heatSource.value)?.label || '交会热力'}`
)
const passMenuTitle = computed(() => {
  const cur: PassSource = PASS_VIEWS.includes(dockActive.value) ? (dockActive.value as PassSource) : 'pass'
  return `过境分析·${PASS_SOURCES.find((s) => s.key === cur)?.label || '城市过境'}`
})

/** 还原到初始状态：清空三维现场后回到第一个模块「卫星」（dock 高亮 + 展开面板，地址栏同步为 /situation/sat）；
 *  热力 / 过境模式下同时退出对应视图（BaseScene 还原卫星云/轨道线，卸载地表叠加图层）。 */
function resetToInitial() {
  clearScene()
  applyDock('sat')
}

/** 复位镜头（不清选中与过滤）：回到缺省打开系统时的初始位置（武汉，南北极与屏幕垂直中线重合）与初始地球大小 */
function resetCameraHome() {
  sceneRef.value?.resetCameraToHome()
}

/* ============================================================
 * dock 选中模块 ↔ 地址栏 /situation/:type 同步
 * 刷新（组件重新挂载）或从后台切回（keep-alive 复用缓存）时按 type 恢复选中模块，
 * 避免每次都落回第一个「sat」。
 * ============================================================ */
/** 本页是否为当前路由：keep-alive 缓存期间 route 会指向别的页面，需拦截误同步 */
function onSituationPage() {
  return route.name === 'situation'
}

/** 按地址栏恢复 dock 选中模块：
 *  - 带合法 type：切到该模块（与当前模块不同则先彻底还原，等价于手动切菜单）；
 *  - 无 type / 非法值（如从后台「态势感知」入口 /situation 进入）：沿用本次会话已选中的模块（keep-alive 现场），
 *    尚未选中时取第一个「sat」（首次进入的默认态）；
 *  两种情况都把 type 规范化写回地址栏（/situation/sat 等），保证刷新后不回退。 */
function restoreDock() {
  const raw = String(route.params.type ?? '')
  const type: DockType = (DOCK_TYPES as readonly string[]).includes(raw)
    ? (raw as DockType)
    : (dockActive.value || 'sat')
  if (raw !== type) syncUrl(type)
  if (dockActive.value === type) return
  if (dockActive.value) clearScene()
  applyDock(type, false)
}

// 路由参数变化（外部链接 / 前进后退）：切到对应模块
watch(() => route.params.type, () => { if (onSituationPage() && !loading.value) restoreDock() })
// 三维资源加载完成（首次进入 / 刷新）：按地址栏恢复选中模块（缺省则默认第一个）
watch(loading, () => { if (!loading.value && onSituationPage()) restoreDock() })
// 从后台切回（keep-alive 恢复缓存）：按地址栏校准选中模块
onActivated(() => { if (onSituationPage() && !loading.value) restoreDock() })

/* ============================================================
 * 空间环境图例（Kp 分档徽标 + 图层可用性提示）
 *  · 极光环 / 太阳风需要数据才有内容：数据未到时图层不绘制，但开关保持勾选（不误导为「开关坏了」）
 *  · 实测值滞后 1~2 天，摘要里明确标出「滞后 Nd」，不假装实时
 * ============================================================ */
const swAuroraReady = computed(() => !!spaceWeather.value?.latest)
const swWindReady = computed(() => Number.isFinite(spaceWeather.value?.solarWind?.speed as number))
const swStorm = computed(() => spaceWeather.value?.storm || { kp: null, level: '—', label: '无数据', color: '#8ea4c4' })
const swText = computed(() => {
  const sw = spaceWeather.value
  if (!sw?.latest) {
    if (spaceWeatherError.value) return '空间环境不可用'
    return spaceWeatherLoading.value ? '空间环境加载中…' : '空间环境无数据'
  }
  const a = sw.aurora
  // 实时估算 Kp（NOAA 1 分钟）优先；回退到日粒度实测时明确标出龄期
  if (a.kpSource === 'realtime') return `估算 Kp ${fmtNum(a.kp, 1)}（实时）`
  return `Kp ${fmtNum(a.kp, 1)} · 滞后 ${sw.lag ?? '—'}d`
})
const swTitle = computed(() => {
  const sw = spaceWeather.value
  if (!sw?.latest) return spaceWeatherError.value || '空间环境数据未获取（定时任务 sync_weather 或后端首次请求会拉取）'
  const l = sw.latest
  const w = sw.solarWind
  const a = sw.aurora
  const kpLine = a.kpSource === 'realtime'
    ? `极光椭圆环：按 NOAA 实时估算 Kp ${fmtNum(a.kp, 1)}（${a.kpAt ? new Date(a.kpAt).toLocaleString() : '时刻未知'}）`
    : `极光椭圆环：按 ${a.kpDate || '—'} 的日最大 Kp ${fmtNum(a.kp, 1)}（实测滞后 ${sw.lag ?? '—'} 天，非实时）`
  return [
    `日粒度实测 ${l.date}（${l.dataType === 'OBS' ? '实测' : '预报'}，滞后 ${sw.lag ?? '—'} 天）`,
    `F10.7 ${fmtNum(l.f107Obs, 1)} sfu（81 天平滑 ${fmtNum(l.f107Center81, 1)}）`,
    `Kp 最大 ${fmtNum(l.kpMax, 1)}（${sw.storm.label}）· Ap ${l.apAvg ?? '—'} · 太阳黑子 ${l.sunspot ?? '—'}`,
    kpLine,
    `太阳风 ${w.speed == null ? '无数据' : `${fmtNum(w.speed, 0)} km/s · Bt ${fmtNum(w.bt, 1)} nT · Bz ${fmtNum(w.bz, 1)} nT`}`,
    '空间环境仅作展示，不参与误差模型'
  ].join('\n')
})
/** 图层当前是否有内容：无内容的行整行压暗（开关仍可勾选）。
 *  判定口径与三维侧的可见性一致（极光环/太阳风看数据，星下点轨迹看是否选中卫星，椭球看是否选中交会事件） */
function skyLayerReady(key: SkyLayerKey): boolean {
  if (key === 'aurora') return swAuroraReady.value
  if (key === 'dipole') return swAuroraReady.value
  if (key === 'solarWind') return swWindReady.value
  if (key === 'groundTrack') return !!selDetail.value
  if (key === 'ellipsoid') return !!(conjEllipsoid.value?.a || conjEllipsoid.value?.b)
  return true
}
/* ============================================================
 * 物体类型总开关（右下角图例最上一组「载荷卫星 / 空间碎片 / 火箭箭体 / 未知物体」）
 *  · 一次性全显 / 全隐：整体开合 visible（4 个粗类型）；任一类被单独取消后本开关呈半选态
 * ============================================================ */
const allObjVisible = computed({
  get: () => TYPE_KEYS.every((k) => visible[k] !== false),
  set: (v: boolean) => { TYPE_KEYS.forEach((k) => { visible[k] = v }) }
})
const allObjIndeterminate = computed(() => TYPE_KEYS.some((k) => visible[k] !== false) && !allObjVisible.value)

/* ============================================================
 * 着色维度切换（右下角图例顶部按钮）
 *  · 常规维度来自 COLOR_MODES；处于「多星座对比」态时临时追加一项「星座对比」
 *    （compare 不在 COLOR_MODES 里，避免非对比态也能切到空维度）
 * ============================================================ */
const colorModeItems = computed<{ key: ColorMode; label: string }[]>(() =>
  compareActive.value ? [...COLOR_MODES, { key: 'compare', label: '星座对比' }] : COLOR_MODES
)
/** 切着色维度：手动切到非 compare 维度即退出「多星座对比」着色（对比态的轨道线分组随之回落） */
function chooseColorMode(key: ColorMode) {
  if (key !== 'compare') compareConsts.value = []
  colorMode.value = key
}
/** 当前视图模式（三类互斥）：碰撞热力 / 过境分析 / 普通（卫星云·星座轨道） */
const skyViewMode = computed<SkyViewMode>(() => heatMode.value ? 'heat' : passMode.value ? 'pass' : 'normal')
/** 当前模式下有意义的图例图层行：不适用的整行不展示（如普通视图没有交会事件，就不列「误差椭球」） */
const skyLayerItems = computed(() => SKY_LAYER_ITEMS.filter((ly) => ly.modes.includes(skyViewMode.value)))
/** 图层行悬停说明（把「暂无内容」讲清楚，避免以为开关坏了） */
function layerTitle(ly: { key: SkyLayerKey; label: string; desc: string }) {
  if (ly.key === 'aurora' && !swAuroraReady.value) return '极光椭圆环：等待空间环境数据（定时拉取中）'
  if (ly.key === 'dipole' && !swAuroraReady.value) return '地磁偶极磁力线：等待空间环境数据（定时拉取中）'
  if (ly.key === 'solarWind' && !swWindReady.value) return '太阳风粒子流：等待 NOAA 太阳风数据（定时拉取中）'
  if (ly.key === 'groundTrack' && !skyLayerReady('groundTrack')) return '星下点轨迹：先在左侧列表或地球上选中一颗卫星'
  if (ly.key === 'ellipsoid' && !skyLayerReady('ellipsoid')) return '误差椭球：先在「碰撞热力」里点选一个交会事件'
  return `${ly.label}（${ly.desc}）`
}

/** 三维里椭球的显示放大倍数（与三维绘制共用 scene.ts 的 covDisplayScale，口径唯一） */
const covMag = computed(() => {
  const sides = [conjEllipsoid.value?.a, conjEllipsoid.value?.b].filter((s): s is ConjEllipsoidSide => !!s)
  if (!sides.length) return 1
  return covDisplayScale(sides.flatMap((s) => [s.sigma.sr, s.sigma.st, s.sigma.sn]))
})

/**
 * 右侧面板四态（同一位置切换）：
 *  'pass' = 城市过境明细；'heat' = 事件详情（热力点事件 / 碰撞列表项点击）；'sat' = 卫星详情；
 *  'site' = 发射站详情（即将发射 + 发射历史）；'' = 收起。
 *  事件详情独立用 heatOpen，卫星详情用 detailOpen，发射站用 siteOpen（均可单独收起，浮标重新展开）；
 *  过境明细用 passDetailOpen（收起只隐藏弹窗，保留选中城市与三维高亮圈/过境标记，避免「关闭即地球还原」）。
 */
const rightMode = computed<'' | 'pass' | 'heat' | 'ephEv' | 'sat' | 'site' | 'cons' | 'eph'>(() => {
  if (passSelTarget.value && passDetailOpen.value) return 'pass'
  if (heatSel.value && heatOpen.value) return 'heat'
  if (ephEvOpen.value && threatSelected.value) return 'ephEv'
  if (siteSel.value && siteOpen.value) return 'site'
  if (ephDetailOpen.value && ephDetail.value) return 'eph'
  if (hasSel.value && selDetail.value && detailOpen.value) return 'sat'
  // 星座视图：选中某星座后右侧展示其成员列表（与选中单星的卫星详情互不冲突，后者的优先级更高）
  if (dockActive.value === 'cons' && filterConst.value && consListOpen.value && !compareActive.value) return 'cons'
  return ''
})

/** 收起过境明细：只隐藏弹窗并保留选中城市与三维高亮（不清高亮圈/过境标记，可再次点选或浮标展开） */
function closePassDetail() { passDetailOpen.value = false }

/* ---- 威胁事件详情卡：跟随三维交会点，定位在该点右下方 ---- */
const detailAsideEl = ref<HTMLElement | null>(null)
/** 卡片左上角（视口像素）；null 时由 CSS 默认位置兜底 */
const ephEvPos = ref<{ left: number; top: number } | null>(null)
const ephEvStyle = computed(() =>
  ephEvPos.value ? { left: `${ephEvPos.value.left}px`, top: `${ephEvPos.value.top}px` } : undefined
)
let ephEvRaf = 0

/** 按交会点在屏幕上的位置重算卡片左上角：优先右下方，越界时翻到左侧 / 上方 */
function updateEphEvPos() {
  const ev = threatSelected.value
  const pt = ev ? sceneRef.value?.projectEciToViewport(ev.midEci) : null
  if (!pt) return
  const w = detailAsideEl.value?.offsetWidth || 244
  const h = detailAsideEl.value?.offsetHeight || 240
  // 镜头拉近后两颗卫星在屏幕上有一定尺寸，偏移量要够大才不会挡住目标本身
  const gapX = 96
  const gapY = 56
  let left = pt.x + gapX
  let top = pt.y + gapY
  if (left + w > window.innerWidth - 8) left = Math.max(8, pt.x - w - gapX)
  if (top + h > window.innerHeight - 8) top = Math.max(8, pt.y - h - gapY)
  const next = { left: Math.round(left), top: Math.round(top) }
  if (!ephEvPos.value || ephEvPos.value.left !== next.left || ephEvPos.value.top !== next.top) ephEvPos.value = next
}

/** 逐帧跟随（镜头拖动 / 缩放时卡片贴着交会点走） */
function startEphEvFollow() {
  if (ephEvRaf) return
  const loop = () => {
    if (rightMode.value !== 'ephEv') { ephEvRaf = 0; return }
    updateEphEvPos()
    ephEvRaf = requestAnimationFrame(loop)
  }
  ephEvRaf = requestAnimationFrame(loop)
}

function stopEphEvFollow() {
  if (ephEvRaf) cancelAnimationFrame(ephEvRaf)
  ephEvRaf = 0
  ephEvPos.value = null
}

watch(rightMode, (m) => {
  if (m === 'ephEv') void nextTick(() => { updateEphEvPos(); startEphEvFollow() })
  else stopEphEvFollow()
})
onBeforeUnmount(stopEphEvFollow)

/** 过境列表过滤：只看「可成像」窗口（目标被太阳照亮 且 观测站处于天文夜 且 月光背景低）。
 *  仅对光照条件已落库的批次有效；光照上线前的老批次这些字段为空，勾选后列表会变空。 */
const passOnlyOptical = ref(false)
/** 过境列表检索词（按卫星名 / NORAD 编号过滤） */
const passQuery = ref('')
/** 过境列表分页渲染步长与已渲染条数（明细可达上千条，滚动到底再追加一批，避免一次性上千 DOM 节点） */
const PASS_LIST_BATCH = 60
const passListCount = ref(PASS_LIST_BATCH)
/** 过境列表实际展示的条目（未过滤时即全量，按最大仰角降序） */
const passListShown = computed(() => {
  let list = passDetail.value?.list || []
  if (passOnlyOptical.value) list = list.filter((p) => p.opticalOk === 1)
  const q = passQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter((p) =>
      (p.object_name || '').toLowerCase().includes(q) || String(p.norad_id).includes(q))
  }
  return list
})
/** 当前实际渲染的条目（滚动加载：只渲染前 passListCount 条） */
const passListPaged = computed(() => passListShown.value.slice(0, passListCount.value))
/** 列表滚动到底部（40px 容差）时追加一批 */
function onPassListScroll(ev: Event) {
  const el = ev.target as HTMLElement
  if (!el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    passListCount.value = Math.min(passListCount.value + PASS_LIST_BATCH, passListShown.value.length)
  }
}
/** 列表内可成像条数（用于标题展示与判断老批次数据） */
const passOpticalCount = computed(() => (passDetail.value?.list || []).filter((p) => p.opticalOk === 1).length)
/** 是否含光照条件数据（老批次全为空 → 相关列显示「—」，过滤开关也提示不可用） */
const passHasIllum = computed(() => (passDetail.value?.list || []).some((p) => p.shadowState != null))
watch(passOnlyOptical, () => { passPickIdx.value = 0; passListCount.value = PASS_LIST_BATCH })
watch(passQuery, () => { passPickIdx.value = 0; passListCount.value = PASS_LIST_BATCH })

/** 目标光照 → 短标签（对应后端口径 sunlit / penumbra / umbra） */
function lightLabel(s?: string | null) {
  return (s && SHADOW_LABEL[s]) || '—'
}
/** 暮光档 → 短标签（按观测点太阳高度角分档） */
function twilightLabel(t?: string | null) {
  return (t && TWILIGHT_LABEL[t]) || '—'
}
/** 0~1 比例 → 百分比文本 */
function fmtPct(v?: number | null, digits = 0) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`
}

/** 右侧「过境参数」下栏当前选中的过境序号（在「已过滤列表」内的下标，0 即最佳过境） */
const passPickIdx = ref(0)
/** 用户是否**主动点过**过境列表项：默认第 0 条（最佳过境）不算「选中目标」，
 *  否则智能体面板会把默认展示的过境当成用户选的目标，让该城市目标永远轮不到。 */
const passRecPicked = ref(false)
/** 切换城市、明细刷新后回到「最佳过境」，并清除上一条过境标记 */
watch(passDetail, () => {
  passPickIdx.value = 0
  passRecPicked.value = false
  passListCount.value = PASS_LIST_BATCH
  sceneRef.value?.focusPassRecord(null)
})
/** 当前选中的那次过境 */
const passPicked = computed(() => passListShown.value[passPickIdx.value] || null)

/** 点击过境列表项：选中该次过境（下栏参数）+ 三维地球把该星空间轨道线复染成红色、在轨道上标出本次过境并转到屏幕中间 */
function pickPassRecord(i: number) {
  passPickIdx.value = i
  passRecPicked.value = true
  const rec = passListShown.value[i]
  if (rec) sceneRef.value?.focusPassRecord(rec)
}

/* ---- 过境仰角剖面（单次过境的逐时刻仰角曲线，echarts 与图谱块共用内核注册） ----
 * 数据源 /cgi/pass/elevation（现算、毫秒级）：口径与明细 maxElev 完全一致（面口径），
 * 故曲线峰值与「过境参数」里的最大仰角自洽；默认收起、首次展开才请求；
 * 切换目标 / 所选过境时清空重拉；收起保留数据（画布用 v-show，按元素引用判断是否重挂）。 */
const elevOpen = ref(false)
const elevLoading = ref(false)
const elevError = ref(false)
const elevData = ref<PassElevationResult | null>(null)
const elevCanvasRef = ref<HTMLElement>()
let elevChart: ECharts | null = null
let elevRo: ResizeObserver | null = null

/** 当前剖面请求键（目标 id + 卫星 + 入境时刻）：变即另一条剖面，用于丢弃过期响应 */
const elevKey = computed(() => {
  const cid = passDetail.value?.city?.id
  const p = passPicked.value
  if (cid == null || !p) return null
  return `${cid}-${p.norad_id}-${p.aosMs}`
})

async function loadElevation() {
  const cid = passDetail.value?.city?.id
  const p = passPicked.value
  if (cid == null || !p) return
  const key = `${cid}-${p.norad_id}-${p.aosMs}`
  elevLoading.value = true
  elevError.value = false
  try {
    const data = await getPassElevationProfile({
      cityId: cid, noradId: p.norad_id, aosMs: p.aosMs, losMs: p.losMs
    })
    if (elevKey.value === key) elevData.value = data
  } catch {
    if (elevKey.value === key) { elevData.value = null; elevError.value = true }
  } finally {
    if (elevKey.value === key) elevLoading.value = false
  }
}

function toggleElevation() {
  elevOpen.value = !elevOpen.value
  if (elevOpen.value && !elevData.value && !elevLoading.value) loadElevation()
}

/** 秒级时刻标签 HH:mm:ss（一次过境仅数分钟，不需要日期） */
function elevTimeLabel(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** tooltip 回调参数（只取用到的字段，避免 any） */
interface ElevTipParam {
  dataIndex: number
}

/** 仰角剖面 option：仰角随时间曲线 + 门限参考线（峰值已在块内文案标注） */
function buildElevOption(data: PassElevationResult) {
  const pts = data.points
  const textColor = cssVar('--text-2', '#9fb0c9')
  const axisColor = cssVar('--panel-edge', 'rgba(120,170,230,0.35)')
  return {
    grid: { left: 40, right: 14, top: 20, bottom: 22 },
    tooltip: {
      confine: true,
      trigger: 'axis',
      formatter: (ps: ElevTipParam[]) => {
        if (!ps?.length) return ''
        const q = pts[ps[0].dataIndex]
        if (!q) return ''
        return [
          elevTimeLabel(q.tMs),
          `仰角 ${q.elev.toFixed(1)}°`,
          `斜距 ${Math.round(q.range)} km`,
          `方位 ${q.az.toFixed(0)}°`
        ].join('<br/>')
      }
    },
    xAxis: {
      type: 'category',
      data: pts.map((q) => elevTimeLabel(q.tMs)),
      axisLabel: { color: textColor, fontSize: 9, hideOverlap: true },
      axisLine: { lineStyle: { color: axisColor } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      name: '仰角 °',
      nameTextStyle: { color: textColor, fontSize: 9 },
      axisLabel: { color: textColor, fontSize: 9 },
      splitLine: { lineStyle: { color: axisColor, opacity: 0.4 } }
    },
    series: [
      {
        name: '仰角', type: 'line', showSymbol: false, smooth: true,
        data: pts.map((q) => q.elev),
        lineStyle: { width: 1.6, color: '#3f9dff' }, itemStyle: { color: '#3f9dff' },
        areaStyle: { color: 'rgba(63,157,255,0.14)' },
        markLine: {
          silent: true, symbol: 'none',
          label: { formatter: `${data.minElev}° 门限`, color: textColor, fontSize: 9, position: 'insideEndTop' },
          lineStyle: { color: '#ff9f43', type: 'dashed', width: 1 },
          data: [{ yAxis: data.minElev }]
        }
      }
    ]
  }
}

function drawElevation() {
  const d = elevData.value
  if (!elevChart || !d || !d.points.length) return
  elevChart.setOption(buildElevOption(d), false)
}

async function mountElevChart() {
  const el = elevCanvasRef.value
  if (!el) return
  const core = await loadEcharts()
  if (elevCanvasRef.value !== el) return
  if (elevChart && elevChart.getDom() !== el) { elevChart.dispose(); elevChart = null; elevRo?.disconnect(); elevRo = null }
  if (!elevChart) {
    elevChart = core.init(el)
    elevRo = new ResizeObserver(() => {
      if (elevChart && el.clientHeight > 0) elevChart.resize()
    })
    elevRo.observe(el)
  }
  drawElevation()
  elevChart.resize()
}

function disposeElevChart() {
  elevRo?.disconnect(); elevRo = null
  elevChart?.dispose(); elevChart = null
}

watch([elevCanvasRef, elevOpen], ([el, open]) => {
  if (el && open) mountElevChart()
  else if (!el) disposeElevChart()
})

watch(elevData, () => {
  if (elevOpen.value) nextTick(() => { if (elevCanvasRef.value) mountElevChart() })
})

/** 切换目标 / 所选过境：清空剖面，仍展开则按新剖面重拉 */
watch(elevKey, () => {
  elevData.value = null
  elevError.value = false
  if (elevOpen.value) loadElevation()
})

onBeforeUnmount(disposeElevChart)


/** unix ms → `MM-DD HH:mm:ss`（过境时刻统一按浏览器本地时区展示） */
function fmtMs(ms?: number | null) {
  if (ms == null) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 纬度：正=北纬、负=南纬（保留两位小数） */
function fmtLat(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '北纬' : '南纬'} ${Math.abs(v).toFixed(2)}°`
}

/** 经度：正=东经、负=西经（保留两位小数） */
function fmtLon(v?: number | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '东经' : '西经'} ${Math.abs(v).toFixed(2)}°`
}

/** 秒 → `Xm Ys` */
function fmtDur(sec?: number | null) {
  if (sec == null) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m ? `${m}m ${s}s` : `${s}s`
}

/** 后端 datetime（ISO 串）→ `MM-DD HH:mm`（明细结果时间，精确到分即可） */
function fmtAt(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 详情面板收起后的浮标（右侧）：点击重新展开对应内容（过境明细优先，其次事件详情、发射站、卫星详情） */
function reopenRight() {
  if (passSelTarget.value) passDetailOpen.value = true
  else if (heatSel.value) heatOpen.value = true
  else if (siteSel.value) siteOpen.value = true
  else if (hasSel.value && selDetail.value) detailOpen.value = true
  else consListOpen.value = true
}

/** 点击右侧「本区域碰撞列表」某一项：与点云团 / 左侧热力列表一致 ——
 *  选中该事件（两端误差椭球 + 两星轨道 + TCA 模型）并让镜头飞到它的交会位置。
 *  切换时若地图上已有拾取（选中卫星的准星/轨道线/详情），先清掉它，避免旧拾取与新绘制叠加。 */
function openCdm(c: CdmHeatEvent) {
  if (hasSel.value) sceneRef.value?.resetSelected(false)
  void sceneRef.value?.selectHeatPair(c)
}

/** 点击左侧热力列表面板（三个来源）某一对：与点击热力云团完全同一套效果 ——
 *  选中该事件（两端误差椭球 + 两星轨道线 + TCA 目标模型）、右侧展开事件详情与所属云团列表、
 *  镜头平滑飞到该事件的交会位置。列表项只有 norad 对 + TCA，交会点由后端 mid 坐标（同源事件）
 *  或前端按两端 TLE 在 TCA 传播取中点得到（见 BaseScene.selectHeatPair）。
 *  切换列表项时若地图上已有拾取（选中卫星的准星/轨道线/详情），先清掉它，避免旧拾取与新绘制的两星轨道叠加。 */
function pickHeatPair(pair: { norad_a: number; norad_b: number; tca: string }) {
  if (hasSel.value) sceneRef.value?.resetSelected(false)
  void sceneRef.value?.selectHeatPair(pair)
}

/** /cgi/event/one（对话事件卡「现场取数」）返回体：仅定位所需的最小字段 */
interface ConjEventOne {
  norad_a?: number
  norad_b?: number
  tca?: string
}

/** 取交会事件的定位三要素（norad_a / norad_b / tca）：优先用事件卡已取到的数据，
 *  否则按事件 id 现场查 /cgi/event/one。查询失败 / 字段缺失一律返回 null（动作静默丢弃，不影响文字回答）。
 *  注意：卡片标记的 source 是 conj|cri（口径），而 heatSource 是 local|cri（视图来源），二者需在此映射。 */
async function locateConjEvent(
  src: 'local' | 'cri',
  a: { key?: string; data?: unknown }
): Promise<{ norad_a: number; norad_b: number; tca: string } | null> {
  const d = (a.data || {}) as ConjEventOne
  let norad_a = Number(d.norad_a)
  let norad_b = Number(d.norad_b)
  let tca = String(d.tca || '')
  if (!(norad_a > 0 && norad_b > 0 && tca)) {
    const id = Number(a.key)
    if (!(id > 0)) return null
    try {
      // heatSource: 'local'（本项目 SGP4 初筛）= /cgi 的 conj 库；'cri'（交会分析）= cri 库
      const r = await httpCgi<ConjEventOne>({
        url: '/event/one',
        method: 'get',
        params: { source: src === 'cri' ? 'cri' : 'conj', id }
      })
      norad_a = Number(r?.norad_a); norad_b = Number(r?.norad_b); tca = String(r?.tca || '')
    } catch { return null }
  }
  return norad_a > 0 && norad_b > 0 && tca ? { norad_a, norad_b, tca } : null
}

/** 当前热力来源的指标是否为「等级文案」：交会热力（SGP4 初筛，风险等级）/ 交会分析（CRI/CRP，极高~极低）
 *  均无官方 Pc 协方差口径，不能当碰撞概率展示，故详情面板指标标题用「风险等级」；仅官方 CDM 展示碰撞概率 */
const isLevelHeat = computed(() => heatSource.value !== 'spacetrack')

/** 事件主指标短文案：由后端按来源口径算好下发（官方 CDM = 碰撞概率 Pc；本项目初筛 = 风险等级），前端零换算 */
function heatMetricShort(e: CdmHeatEvent): string {
  return e.metric_text || '—'
}

/** 点击卫星列表项：在三维地球上拾取该卫星（准星 + 轨道线 + 右侧详情 + 镜头飞向）。
 *  左侧列表与右侧详情两两相对但互斥：拾取后收起左侧列表，让位给右侧详情（PC / 移动端统一） */
function pickFromList(gi: number) {
  sceneRef.value?.selectSatelliteByIndex(gi)
  dockMode.value = ''
}

/** 切换卫星列表数据源（国际库 / AOE 库）：转给三维场景重拉点云并重建实例。
 *  面板保持展开，切换完成后场景内会重建过滤索引刷新列表。 */
function switchSource(src: SatSource) {
  sceneRef.value?.switchDataSource(src)
}

/** 点击星座：设置星座过滤并绘制该星座全部卫星的轨道线（刷新由 [filterKw, filterConst, altMin, altMax] watch 统一驱动）。
 *  PC 端保留列表，便于连续切换不同星座的轨道线；移动端列表占据大半个屏幕，绘制后收起让位给地球观察。 */
function pickConstellation(name: string) {
  // 星座与「NORAD 集合」「多星座对比」是三种定位来源：互清，避免过滤 AND 得出空集
  filterNorads.value = null
  compareConsts.value = []
  filterConst.value = name
  // 星座展示是独立于类型开关的展示通道：揭示点云（否则首页「无目标」门控会整体压住）
  cloudRevealed.value = true
  // 选中星座即展开右侧成员列表（旧的成员高亮由 BaseScene 的 filterConst watch 清除）
  consListOpen.value = true
  if (isMobile.value) dockMode.value = ''
}

/** 星座卡片「星座展示」开关（逐星库覆盖口径，与主开关「卫星」解耦）：
 *  - 点亮：写覆盖 true（主开关关时仅显示该星座；主开关开时该星座恢复跟随展示），
 *    并把 filterConst 绑定到该卡片（「轨道展示」画哪个星座），同时揭示点云；
 *  - 点暗：写覆盖 false（主开关开时仅隐藏该星座，其余星座与主开关不受影响），
 *    若轨道绑定在该卡片则一并解除。碎片/残骸/未知不受本开关影响。 */
function toggleConsShow(name: string) {
  filterNorads.value = null
  compareConsts.value = []
  filterKw.value = ''
  const on = consShowOf(name)
  consShowMap[name] = !on
  if (!on) {
    filterConst.value = name
    consCardBound.value = true
    cloudRevealed.value = true
  } else if (consCardBound.value && filterConst.value === name) {
    filterConst.value = ''
    consCardBound.value = false
  }
}

/** 星座卡片卫星列表点选某颗卫星：
 *  - 屏幕上已有目标展示（类型开关 / 星座展示 / 单星态）→ 仅拉近选中并弹详情，其余展示不受影响；
 *  - 屏幕上没有任何目标 → 走「单星白名单」（filterNorads）只渲染并展示被点击的这一颗。 */
function pickConsSat(gi: number) {
  const p = g.cloudList[gi]
  if (!p) return
  const anyShown = cloudRevealed.value
    && (TYPE_KEYS.some((k) => visible[k]) || !!filterConst.value || consOverrideActive.value)
  if (!anyShown) {
    filterConst.value = ''
    filterNorads.value = [Number(p.norad_id)]
    cloudRevealed.value = true
  }
  // 拉近 + 居中跟踪 + 右侧详情（与该星被双击一致；面板保持展开，便于连续点选）
  sceneRef.value?.trackSatelliteByIndex(gi)
}

/** 右侧星座成员列表：滚动到底部附近继续加载下一批 */
function onConsSatScroll(ev: Event) {
  const el = ev.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    consSatPanel.count = Math.min(consSatPanel.count + consSatPanel.BATCH, consSatPanel.idx.length)
  }
}

/** 点击右侧成员列表某一项：在星座里用亮青色高亮该星轨道线；再点同一颗则取消高亮 */
function toggleConsHighlight(norad: number) {
  const next = consHighlightNorad.value === norad ? 0 : norad
  void sceneRef.value?.highlightConstSat(next)
}

/** 「本轮提问是否已清空展示效果」：后端在每轮首个展示型动作前自动补发 clear_display，
 *  这里记录本轮的清空是否已发生 —— 后续动作不再重复清场（否则同轮多动作会互相擦除，
 *  例如「集合轨道线 + 城市过境面板」里后一个动作会把前一个的效果清掉）。
 *  由 AiChatDrawer 的 round-start 事件在每轮提问开始时复位。 */
let aiRoundCleared = false
/** 「本轮提问是否已有动作钉住某个左侧面板」：show_satellites 默认切到卫星视图，
 *  但若同轮已打开过境 / 热力等面板，则不抢走它（集合轨道线在叠加层下于那些视图同样可见）。 */
let aiDockPinned = false
/** 「上一轮由 AI 打开的图层」：新一轮提问开始时先关掉这一批（跨轮替换 —— 每次提问只保留本轮要求的图层）。
 *  只记 AI 打开过的，用户手动在右下角图例开的图层不受影响。 */
const aiOpenedLayers = new Set<SkyLayerKey>()

/** 新一轮提问开始：复位本轮的「已清空 / 已钉面板」标志（保证下次效果前清空），
 *  并关掉上一轮 AI 打开的图层（跨轮替换：新一次提问只展示本轮要求的图层）。 */
function onAiRoundStart() {
  aiRoundCleared = false
  aiDockPinned = false
  if (aiOpenedLayers.size) {
    for (const k of aiOpenedLayers) skyLayers[k] = false
    aiOpenedLayers.clear()
  }
}

/** 切到「综合态势·卫星列表」并在其中定位选中某颗星（智能体拾取单星 / 图谱定位卫星共用）。
 *  用户可能在任意模块下发起（如 /situation/pass 里问某颗星）：必须把模块与地址栏一并落到 sat，
 *  口径与手动切菜单 chooseSatView 一致（先 clearScene 再 applyDock）—— 否则会停在旧模块、
 *  右侧卫星详情还会被旧模块详情（rightMode 优先级 pass > heat > site > sat）遮挡。
 *  最后收起左侧列表让位给右侧详情（与手动点列表项后的状态一致）。 */
function focusSatelliteInSatView(norad: number) {
  if (!aiRoundCleared && dockActive.value !== 'sat') clearScene()
  aiDockPinned = true
  applyDock('sat')
  sceneRef.value?.selectByNorad(Number(norad))
  dockMode.value = ''
}

/** 切到「星座列表」并（可选）选中指定星座（智能体 select_constellation / 图谱 kg_focus 共用）。
 *  与手动从 dock 进入星座模块（chooseSatView('cons')）口径完全一致：模块不同时先 clearScene ——
 *  clearScene → resetToInitial → resetSelected 会 applyHomeCamera() 把镜头复位到「正对中国」的初始机位。
 *  漏掉这一步就会停在旧模块的镜头角度上（用户感知为「通过大模型看星座时镜头位置不对」）。
 *  同模块内切换星座（如在星座列表里再问一个）不复位镜头，与手动点列表项一致；
 *  不传 name 时只进模块、用默认星座（供 open_panel('cons') 复用）。 */
function focusConstellationInConsView(name?: string) {
  if (!aiRoundCleared && dockActive.value !== 'cons') clearScene()
  aiDockPinned = true
  applyDock('cons')
  if (name) pickConstellation(name)
}

/** 多星座对比：进星座列表页 + 按公用调色板给每个星座分色（点云与过滤轨道线同时着色）。
 *  与单星座进入同一口径（模块不同时先 clearScene 复位镜头，同模块内不复位）；
 *  只用对比着色，**不设 filterConst**（单星座过滤会额外收窄，与对比语义冲突）。
 *  配色顺序即图例顺序；超出调色板长度循环取色（见 COMPARE_PALETTE）。 */
function focusCompareInConsView(names: string[]) {
  const list = (names || []).map((n) => String(n || '').trim()).filter(Boolean)
  if (!list.length) return
  if (!aiRoundCleared && dockActive.value !== 'cons') clearScene()
  aiDockPinned = true
  filterNorads.value = null
  // 先写对比态：applyDock('cons') 内部会调 selectDefaultConstellation()，其早退条件依赖 compareActive，
  //  若在 applyDock 之后再写会把 filterConst 覆盖成「默认第一个星座」，导致只剩单星座轨道线。
  compareConsts.value = list.map((name, i) => ({ name, color: COMPARE_PALETTE[i % COMPARE_PALETTE.length] }))
  filterConst.value = ''
  applyDock('cons')
  colorMode.value = 'compare'
}

/** 智能体要求「打开碰撞热力面板并展示第一条交会」的触发计数：递增即让 CdmHeatmap 自动选中列表第一条
 *  （面板无数据时它什么都不做，只停在 heat 页面，符合「没有交会事件也定位到该页」）。 */
const heatAutoSelectTick = ref(0)

/** 智能体界面动作消费（AiChatDrawer 上抛）：模型只下发声明式指令，这里落到三维态势上。
 *  未知动作直接丢弃 —— 动作失败绝不能影响文字回答的呈现（两件事互不阻塞）。 */
function onAiAction(a: AiAction) {
  switch (a.kind) {
    case 'select_satellite':
      // 定位并选中单星（准星 + 轨道线 + 右侧详情 + 镜头飞向），并把模块/地址栏切到 sat 视图
      focusSatelliteInSatView(Number(a.norad))
      break
    case 'select_constellation':
      // 打开星座列表并选中该星座（绘出全部成员的轨道线）；镜头按「手动进入星座模块」口径复位
      focusConstellationInConsView(a.name)
      break
    case 'compare_constellations':
      // 多星座对比：进星座列表页并按公用调色板给各星座分色（点云 + 轨道线同时着色）
      focusCompareInConsView(a.names)
      break
    case 'select_site': {
      // 打开站点面板并选中该发射场（与点击左侧站列表同一路径：写选中态 + 高亮 + 镜头飞过去）。
      // applyDock('site') 内部会异步首次拉取站列表，这里 await 同一次请求后再选中，避免列表还空时选中失败。
      aiDockPinned = true
      applyDock('site')
      const sid = Number(a.siteId)
      if (Number.isFinite(sid) && sid > 0) void loadLaunchSites().then(() => pickFromSiteList(sid))
      break
    }
    case 'select_pass_city': {
      // 打开城市过境面板并选中问题所指城市 / 区域（与点击左侧列表同一路径：高亮区域面 + 镜头飞过去 + 读过境明细）。
      // 目标列表是异步加载的，先等它就绪再按 id（或名称）拾取；超时则只停在城市过境页。
      // 若动作带 norad（对话内「过境」事件卡），目标选中后进一步聚焦该星的那一次过境（尽力而为）。
      // 轨道线口径：默认只让「回答列出的那几颗」轨道环可见（其余明细卫星的轨道环照常构建但隐藏，
      // 可见集合由随后的 show_satellites 定）；只有用户明确说「看全部过境」时后端才带 allOrbits=true，此时明细全部可见。
      aiDockPinned = true
      applyDock('pass')
      void awaitPassTargetId(a).then((id) => {
        if (id == null) return
        pickFromPassList(id, a.allOrbits === true ? undefined : { listOnly: true })
        const norad = Number(a.norad)
        if (Number.isFinite(norad) && norad > 0) focusPassRecordByNorad(norad)
      })
      break
    }
    case 'open_panel':
      if ((DOCK_TYPES as readonly string[]).includes(a.panel)) {
        aiDockPinned = true
        // 碰撞热力 + 自动选中：本次要「定位到目标卫星的交会」，不是列表里第一条别的卫星。
        // 目标 NORAD 优先取动作显式带的 norad；否则回落到当前三维场景里已选中的那颗星
        //（「先问某星位置、再问它的交会风险」时，会话上下文里的选中星即目标）。
        if (a.panel === 'heat' && a.selectFirst) {
          const explicit = Number(a.norad)
          const cur = Number(selDetail.value?.norad_id)
          heatFocusNorad.value = Number.isFinite(explicit) && explicit > 0
            ? explicit
            : (hasSel.value && Number.isFinite(cur) && cur > 0 ? cur : null)
        }
        // 星座面板按「手动进入星座模块」口径切（先 clearScene 复位镜头与残留态），其余面板行为不变
        if (a.panel === 'cons') focusConstellationInConsView()
        else applyDock(a.panel as DockType)
        // selectFirst：打开面板后自动选中列表第一条（目前仅碰撞热力面板实现 ——
        // 「交会 / 碰撞」类问题打开 heat 后直接展示目标卫星的第一条交会信息；无数据则只停在页面）
        if (a.selectFirst && a.panel === 'heat') heatAutoSelectTick.value++
      }
      break
    case 'draw_region':
      // 打开区域过境并直接以经纬度顶点绘制（写 regionDraft 即自动重绘）
      aiDockPinned = true
      applyDock('region')
      sceneRef.value?.setRegionPolygon(a.vertices || [])
      break
    case 'show_satellites': {
      // 「一组卫星」集合展示：绘制这批星的全部轨道线（并可与其他视图叠加）。
      // 归一化在 BaseScene.showSatelliteSet 里统一做（正整数 / 去重 / MAX_SAT_SET 截断）。
      const arr = (a.norads || []).map((v) => Math.trunc(Number(v))).filter((v) => Number.isFinite(v) && v > 0)
      if (!arr.length) break
      // 本轮首个展示型动作若未清空（极端情况：后端未补 clear_display），这里补一次
      if (!aiRoundCleared) { clearScene(); aiRoundCleared = true }
      // 切到卫星视图展示集合；但同轮已打开过境 / 热力等面板时不抢走它（叠加层下集合同样可见）
      if (!aiDockPinned) {
        applyDock('sat')
        dockMode.value = ''
      }
      // 集合与「多星座对比」是两种定位来源：互清（并让着色维度从 compare 回落，避免空图例）
      compareConsts.value = []
      if (colorMode.value === 'compare') colorMode.value = 'type'
      sceneRef.value?.showSatelliteSet(arr)
      break
    }
    case 'select_conj_event': {
      // 对话内事件卡 / 行内「定位」按钮 → 进碰撞热力面板、切到对应来源、直接定位该事件
      //（两端误差椭球 + 两星轨道线 + 镜头飞到交会点），随后收起面板让位给地球（与手动点列表项一致）。
      // 数据来源两条路都覆盖：卡片已取到 data 就直接用；行内按钮只带 source + key，由 locateConjEvent 现场查 /cgi/event/one。
      const src = a.source === 'cri' ? 'cri' : 'local'
      void locateConjEvent(src, a).then((pair) => {
        if (!pair) return
        aiDockPinned = true
        applyDock('heat')
        heatSource.value = src
        pickHeatPair(pair)
        dockMode.value = ''
      })
      break
    }
    case 'clear_display':
      // 清空上一轮展示效果（过滤条件 / 集合轨道线 / 选中目标）；由后端在每轮首个展示型动作前自动下发
      if (!aiRoundCleared) { clearScene(); aiRoundCleared = true }
      break
    case 'kg_focus':
      // 前台详情面板已无「知识图谱关联」块：该动作退化为仅按 NORAD 定位选中该星（并切到 sat 视图）；
      // 其他类型前台没有通用图谱页，退化为按名称选中对应星座。
      if (a.kgType === 'satellite') {
        focusSatelliteInSatView(Number(a.key))
      } else if (a.kgType === 'constellation') {
        // 与智能体 select_constellation 同一条链路（含镜头复位，口径同手动进入星座模块）
        focusConstellationInConsView(a.key)
      }
      break
    case 'open_url':
      if (a.url) window.open(a.url, '_blank', 'noopener')
      break
    case 'toggle_layers': {
      // 空间环境 / 天体图层（右下角图例）：模型 / 关键词兜底提到即「一律打开」（不再翻转为关闭，
      // 避免同一图层被重复问到时反而被关掉）；并把它们记进 aiOpenedLayers，
      // 由下一轮提问开始时的 onAiRoundStart 统一关闭（跨轮替换）。
      // 未知 key 直接忽略（scene.ts 的 skyLayers 为唯一白名单）。
      const keys = (a.layers || []).filter((k): k is SkyLayerKey => k in skyLayers)
      if (!keys.length) break
      for (const k of keys) {
        skyLayers[k] = true
        aiOpenedLayers.add(k)
      }
      break
    }
  }
}

/** 智能体浮层的「当前选中目标」：先按当前激活模块分流，再在模块内取最具体者。
 *  各模块的选中态互不清除（选星不会清掉热力事件，切 dock 也只还原三维现场、不清选中），
 *  所以不能只按优先级聚合，否则会把「上一步点过的事件」误当当前目标。 */
const aiTarget = computed(() =>
  buildAiTarget({
    dockMode: dockMode.value,
    dockActive: dockActive.value,
    sel: { id: sel.id, name: sel.name },
    hasSel: hasSel.value,
    filterConst: filterConst.value,
    constellation: constellations.value.find((c) => c.name === filterConst.value) || null,
    heatSel: heatSel.value,
    passSelTarget: passSelTarget.value,
    passPicked: passRecPicked.value ? passPicked.value : null,
    regionPassSel: regionPassSel.value,
    regionPassRunId: regionPassRunId.value,
    multiPassSel: multiPassSel.value
  })
)
</script>

<template>
  <div class="constel-page">
    <!-- 大屏标题栏：固定顶部正中（冻结装饰层，pointer-events:none 不拦截画布交互）；
         左上角 logo 为独立定位元素（原图透明底，不叠加任何背景） -->
    <img class="app-logo" :src="logoUrl" alt="Openspace logo" />
    <!-- 右上角水印：纯装饰层，不拦截画布交互 -->
    <div class="app-watermark">谭谈.佳男</div>
    <header class="constel-titlebar">
      <div class="tb-frame">
        <span class="tb-wing"></span>
        <div class="tb-texts">
          <h1 class="tb-title">开源太空安全平台</h1>
          <div class="tb-sub">Openspace Space Safety Platform</div>
        </div>
        <span class="tb-wing tb-wing-r"></span>
      </div>
    </header>

    <!-- 基础场景：canvas + 准星 + 加载/错误遮罩 + 顶部通知（内部自管） -->
    <BaseScene ref="sceneRef" />

    <!-- 左侧太空安全目标列表面板（dockMode==='sat' 时显示，自管过渡动画）；
         桌面端缺省收起（satPanelClosed），由左缘外拉 tag / 底部 dock 拉出 -->
    <SatListPanel v-if="isMobile || !satPanelClosed" @pick="pickFromList" @close="closeSatPanel" @source="switchSource" @pick-sat="pickConsSat" @cons-show="toggleConsShow" @open-eph="onOpenEph" />

    <!-- 左侧发射站列表面板（dockMode==='site' 时显示，自管过渡动画） -->
    <SiteListPanel @pick="pickFromSiteList" @close="closeSitePanel" />

    <!-- 左侧星座列表面板（dockMode==='cons' 时显示，自管过渡动画） -->
    <ConstellationPanel @pick="pickConstellation" @close="closeConsPanel" />

    <!-- 左侧碰撞热力面板（dockMode==='heat' 时显示，自管过渡动画） -->
    <CdmHeatmap :auto-select-tick="heatAutoSelectTick" @close="closeHeatPanel" @select="pickHeatPair" @pick-ephem="onPickEphEvent" />

    <!-- 左侧城市过境面板（dockMode==='pass' 时显示，自管过渡动画） -->
    <PassPanel @pick="pickFromPassList" @close="closePassPanel" />

    <!-- 左侧区域过境面板（dockMode==='region' 时显示，自管过渡动画） -->
    <RegionPanel
      @action="onRegionAction"
      @pick="pickRegionRecord"
      @play="toggleRegionPlay"
      @seek="seekRegionRecord"
      @close="closeRegionPanel"
    />

    <!-- 左侧多区域过境面板（dockMode==='multi' 时显示）：与区域过境面板互相独立，各自的状态与结果 -->
    <MultiRegionPanel
      @action="onMultiRegionAction"
      @pick="pickMultiRegionRecord"
      @pick-coverage="pickMultiRegionCoverage"
      @play="toggleMultiRegionPlay"
      @seek="seekMultiRegionRecord"
      @close="closeMultiRegionPanel"
    />

    <!-- 右侧星历分析面板（ephOpen 独立开关，与左侧面板可同时展开）：上传 / 内置样本 + 质量评估 + 威胁筛选事件列表 -->
    <EphemPanel
      @close="closeEphemPanel"
      @focus-set="focusActiveEphem"
      @focus-event="focusEphemEvent"
      @ai-explain="onEphemAiExplain"
    />

    <!-- 仿真时间条：常驻底部（在按钮栏下方），拖动播放头直接改写虚拟时刻；
         播放/暂停、回到当前时刻与倍率复用 BaseScene 动画循环的 simStepSec -->
    <div class="sim-bar">
      <button class="sim-play sim-reset" title="重置到当前时间" @click="simResetNow">↺</button>
      <button class="sim-play" :title="simPlaying ? '暂停仿真' : '继续仿真'" @click="simTogglePlay">
        {{ simPlaying ? '❚❚' : '▶' }}
      </button>
      <div class="sim-main">
        <div class="sim-line">
          <b>{{ simClockUtc }}</b>
          <span class="sim-range">{{ simRangeText }}</span>
        </div>
        <input class="sim-slider" type="range" min="0" max="1000" step="1"
          :value="Math.round(simRatio * 1000)" @input="simSeek" />
      </div>
      <div class="sim-rates">
        <button v-for="r in SIM_RATE_OPTIONS" :key="r" :class="{ on: simSpeed === r }"
          :title="`仿真倍率 ${r}×`" @click="simSpeed = r">{{ r }}×</button>
      </div>
    </div>

    <!-- 底部 dock 导航栏（极窄、精致，预留后续功能） -->
    <div class="constel-dock">
      <!-- 安全热力图：直接弹出「交会分析热力」面板（与专家弹窗同为底部居中卡片），不再弹来源菜单 -->
      <button class="dock-btn" :class="{ on: dockActive === 'heat' }" @click="openCriHeatDock"
        title="安全热力图：展示交会分析（CRI/CRP）热力事件，点击弹出底部热力面板">
        <span class="dock-ico">✱</span><span class="dock-txt">安全热力图</span>
      </button>
      <!-- 太空安全专家入口（原「空间态势智能体」，前台免登录，/cgi/ai 只读工具 + 限流）：
           与 dock 的其它项不同，它不切换三维视图，只开一个右侧浮层，故不高亮 dockActive -->
      <button class="dock-btn" :class="{ on: aiOpen }" title="太空安全专家：用自然语言查询目标、碰撞风险与空间环境" @click="aiOpen = !aiOpen">
        <span class="dock-ico">◈</span><span class="dock-txt">AI专家</span>
      </button>
      <!-- 初始化窗口：整页刷新（重新拉取全部数据与三维现场，等价于浏览器刷新） -->
      <button class="dock-btn" title="初始化窗口：刷新整个页面" @click="reloadSystem">
        <span class="dock-ico">↺</span><span class="dock-txt">初始化窗口</span>
      </button>
    </div>

    <!-- 左下角复位按钮：与「还原」不同，只把屏幕回到初始位置（武汉）与初始地球大小，不清选中与过滤 -->
    <button class="constel-reset" title="复位镜头：回到初始位置（武汉）与初始地球大小" @click="resetCameraHome">
      <svg class="reset-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      </svg>
      <span class="reset-txt">复位</span>
    </button>

    <!-- 右下角图例（三种模式共用一个容器）：
         上半部分随模式变化 —— 普通模式＝物体类型颜色对照 +「轨道线」总开关；
         过境分析＝「行政区域 / 国界 / 城市」三图层；碰撞热力＝上方无内容（配色图例在热力面板内）。
         横线以下的「空间环境 / 天体图层」三种模式都显示（碰撞热力、过境分析页也保留） -->
    <div class="constel-legend">
      <div class="lg-title" v-collapse="true">
        <!-- 双时区时钟：UTC 标准时间 + 北京时间（每秒刷新，左对齐，字号同 dock 按钮） -->
        <div class="lg-clock">
          <span class="lg-clock-line">{{ clockUtc }}</span>
          <span class="lg-clock-line">{{ clockBjt }}</span>
        </div>
      </div>
      <!-- 过境分析：地表叠加图层显隐（纯前端控制，不重复请求；区域过境下城市只留中文标注） -->
      <template v-if="passMode">
        <label class="lg-row" title="中国行政区划面（地级市边界 + 省级名标注）：过境分析的目标面，点击面即可查看该市过境明细">
          <span class="lg-check"><input type="checkbox" v-model="passDistrictVisible" /></span>
          <span class="lg-dot lg-line"></span>
          <span class="lg-name">行政区域</span>
          <span class="lg-desc">市界 / 省名</span>
        </label>
        <label class="lg-row" title="政区边界线（Natural Earth 110m；其他国家按国界面参与过境）">
          <span class="lg-check"><input type="checkbox" v-model="passBorderVisible" /></span>
          <span class="lg-dot lg-line"></span>
          <span class="lg-name">国界</span>
          <span class="lg-desc">政区边界</span>
        </label>
        <label class="lg-row" title="城市中文标注（仅当前批次有过境明细的城市，随缩放分级显隐）">
          <span class="lg-check"><input type="checkbox" v-model="passCityVisible" /></span>
          <span class="lg-dot lg-city"></span>
          <span class="lg-name">城市</span>
          <span class="lg-desc">中文标注</span>
        </label>
      </template>
      <!-- 普通模式：着色维度切换 + 图例（可折叠）+ 轨道线总开关 -->
      <template v-else-if="!heatMode">
        <!-- 着色维度切换：切换后三维卫星逐实例配色与下方图例同步变化（默认「目标类型」） -->
        <div class="lg-modes">
          <div class="lg-modes-label">着色维度</div>
          <div class="lg-mode-btns">
            <button
              v-for="m in colorModeItems"
              :key="m.key"
              class="lg-mode-btn"
              :class="{ on: colorMode === m.key }"
              :title="`按${m.label}分类着色`"
              @click="chooseColorMode(m.key)"
            >{{ m.label }}</button>
          </div>
        </div>
        <!-- 目标类型维度：沿用原类型图例（可勾选显示 / 隐藏某类物体） -->
        <template v-if="colorMode === 'type'">
          <div v-for="lg in LEGEND" :key="lg.type" class="lg-row">
            <label class="lg-check" :title="lg.label">
              <input type="checkbox" v-model="visible[lg.type]" />
              <span class="lg-dot" :style="{ background: lg.color }"></span>
            </label>
            <span class="lg-name">{{ lg.label }}</span>
            <span class="lg-desc">{{ lg.desc }}</span>
          </div>
        </template>
        <!-- 其它维度：按分档显示颜色 + 名称 + 占比（物体数放 title 悬浮提示；数据由 BaseScene 着色时回填 colorLegend） -->
        <template v-else>
          <div
            v-for="row in colorLegend"
            :key="row.key"
            class="lg-row lg-row-static"
            :title="`${row.label}：${row.count.toLocaleString()} 个（${row.pct}%）`"
          >
            <span class="lg-dot" :style="{ background: row.color }"></span>
            <span class="lg-name">{{ row.label }}</span>
            <span class="lg-pct">{{ row.pct }}%</span>
          </div>
        </template>
        <!-- 物体会总开关：一次性显示/隐藏上面 4 类物体（载荷 / 碎片 / 箭体 / 未知）；半选＝部分类型被单独隐藏 -->
        <label class="lg-row" title="全部物体类型（载荷卫星 / 空间碎片 / 火箭箭体 / 未知物体）一键显示或隐藏">
          <span class="lg-check">
            <input type="checkbox" v-model="allObjVisible" :indeterminate="allObjIndeterminate" />
          </span>
          <span class="lg-dot lg-all"></span>
          <span class="lg-name">全部物体</span>
          <span class="lg-desc">总显示 / 隐藏</span>
        </label>
        <!-- 轨道线总开关：一次性显示/隐藏普通视图下全部卫星轨道线（过滤轨道线 / hover 预览 / 选中单星） -->
        <label class="lg-row" title="全部卫星轨道线（过滤 / 预览 / 选中）">
          <span class="lg-check"><input type="checkbox" v-model="orbitVisible" /></span>
          <span class="lg-dot lg-line"></span>
          <span class="lg-name">轨道线</span>
          <span class="lg-desc">全部卫星</span>
        </label>
      </template>
      <!-- 空间环境 / 天体图层（横线以下）：按当前视图模式过滤 —— 只列本模式下有意义的图层
           （普通视图不列「误差椭球」，热力/过境视图不列「星下点轨迹」），见 scene.ts 的 SKY_LAYER_ITEMS.modes -->
      <div v-if="skyLayerItems.length" class="lg-sep"></div>
      <label
        v-for="ly in skyLayerItems"
        :key="ly.key"
        class="lg-row"
        :class="{ off: !skyLayerReady(ly.key) }"
        :title="layerTitle(ly)"
      >
        <span class="lg-check"><input type="checkbox" v-model="skyLayers[ly.key]" /></span>
        <span class="lg-dot" :class="ly.dotClass"></span>
        <span class="lg-name">{{ ly.label }}</span>
        <span class="lg-desc">{{ ly.desc }}</span>
      </label>
      <!-- 空间环境摘要（Kp 分档徽标 + 实测龄期）：实测滞后 1~2 天，这里明确标注「非实时」 -->
      <div class="lg-sws" :title="swTitle">
        <span class="lg-sws-badge" :style="{ color: swStorm.color, borderColor: swStorm.color }">{{ swStorm.level }}</span>
        <span class="lg-sws-text">{{ swText }}</span>
      </div>
    </div>

    <!-- 右侧面板：过境明细 / 事件详情 / 发射站详情 / 卫星详情（四态，同一位置切换，可收起） -->
    <aside
      v-if="rightMode"
      ref="detailAsideEl"
      class="constel-detail"
      :class="{ 'detail-pass': rightMode === 'pass', 'detail-site': rightMode === 'site', 'detail-sat': rightMode === 'sat', 'detail-eph-ev': rightMode === 'ephEv' }"
      :style="rightMode === 'ephEv' ? ephEvStyle : undefined"
    >
      <!-- ① 城市过境明细（点击地球行政区划面 / 左侧目标列表项）：
           上栏＝该目标未来 24h 过境列表（按最大仰角降序），下栏＝选中那次过境的时刻与参数 -->
      <template v-if="rightMode === 'pass' && passSelTarget">
        <div class="cd-head">
          <div class="cd-head-main">
            <b class="cd-name">{{ passSelTarget.name_cn || passSelTarget.name || passSelTarget.name_en }}</b>
            <span class="cd-sub">{{ passTargetSub }} · {{ fmtNum(passSelTarget.longitude, 2) }}°, {{ fmtNum(passSelTarget.latitude, 2) }}°</span>
          </div>
          <button class="cd-close" title="收起明细" @click="closePassDetail">✕</button>
        </div>

        <div v-if="passLoadingHint" class="cd-block">
          <div class="cd-title">读取过境数据</div>
          <div class="pass-hint">正在读取该目标未来 24h 载荷卫星过境（汇总任务已预计算入库，点击即时返回）…</div>
        </div>
        <div v-else-if="passError" class="cd-block">
          <div class="cd-title">读取失败</div>
          <div class="pass-err">{{ passError }}</div>
        </div>
        <template v-else-if="passDetail">
          <div class="cd-block">
            <div class="cd-title">过境概览</div>
            <div class="cd-grid">
              <div class="cd-item"><span>预报窗口</span><b>未来 {{ passDetail.windowHours }} h</b></div>
              <div class="cd-item"><span>仰角门限</span><b>{{ passDetail.minElev }}°</b></div>
              <div class="cd-item"><span>过境条数</span><b>{{ passDetail.totalPasses.toLocaleString() }}</b></div>
              <div class="cd-item"><span>可成像</span><b>{{ passHasIllum ? `${passOpticalCount} 条` : '—' }}</b></div>
              <div class="cd-item"><span>数据来源</span><b>{{ passDetail.live ? '实时计算' : '预计算' }}</b></div>
              <div class="cd-item"><span>结果时间</span><b>{{ fmtAt(passDetail.computedAt) }}</b></div>
              <div class="cd-item"><span>载荷卫星</span><b>{{ passDetail.sats != null ? passDetail.sats.toLocaleString() + ' 颗' : '—' }}</b></div>
            </div>
          </div>

          <!-- 上栏：卫星过境列表 -->
          <div class="cd-block">
            <div class="cd-title cd-title-row">
              <span>过境列表（{{ passListShown.length }} 条）
                <em v-if="passQuery.trim()" class="pass-count-tip">/ 共 {{ passDetail.list.length }}</em>
              </span>
              <label
                class="pass-filter"
                :class="{ off: !passHasIllum }"
                :title="passHasIllum
                  ? '只看可成像窗口：目标被太阳照亮 且 观测站处于天文夜 且 月光背景低'
                  : '该批次为光照条件上线前的数据，无光照字段可过滤；重算过境汇总后可用'"
              >
                <input v-model="passOnlyOptical" type="checkbox" :disabled="!passHasIllum">
                <span>只看可成像</span>
              </label>
            </div>
            <div class="pass-search">
              <input
                v-model="passQuery"
                type="text"
                placeholder="检索卫星名 / NORAD 编号"
                spellcheck="false"
              >
              <button v-if="passQuery" type="button" class="pass-search-clear" title="清除" @click="passQuery = ''">×</button>
            </div>
            <ul class="pass-list" @scroll="onPassListScroll">
              <li
                v-for="(p, i) in passListPaged"
                :key="`${p.norad_id}-${p.aosMs}`"
                class="pass-item"
                :class="{ on: i === passPickIdx }"
                title="点击：下栏显示该次过境参数，三维地球把该卫星的整圈空间轨道线复染成红色、在轨道上标出本次过境（AOS / 最高仰角 / LOS）并绘制该卫星三维模型（机头垂直地球），镜头转到屏幕中间"
                @click="pickPassRecord(i)"
              >
                <div class="pass-item-top">
                  <span class="pass-sat" :title="p.object_name">{{ p.object_name || ('NORAD ' + p.norad_id) }}</span>
                  <span class="pass-elev">{{ fmtNum(p.maxElev, 1) }}°</span>
                </div>
                <div class="pass-item-sub">
                  <span class="pass-span">{{ fmtMs(p.aosMs) }} → {{ fmtMs(p.losMs) }}</span>
                  <span class="pass-dur">{{ fmtDur(p.durationSec) }}</span>
                </div>
                <div class="pass-item-light">
                  <span class="light-tag" :class="`light-${p.shadowState || 'none'}`">{{ lightLabel(p.shadowState) }}</span>
                  <span class="light-tag tw">{{ twilightLabel(p.twilight) }}</span>
                  <span v-if="p.opticalOk === 1" class="light-tag ok">可成像</span>
                </div>
              </li>
              <li v-if="passListCount < passListShown.length" class="pass-more">继续滚动加载更多…</li>
            </ul>
            <div v-if="!passDetail.list.length" class="pass-none">未来 {{ passDetail.windowHours }}h 内无满足仰角门限的过境</div>
            <div v-else-if="!passListShown.length" class="pass-none">
              {{ passQuery.trim() ? '无匹配的过境记录（换个关键词试试）' : '该城市本次过境均不满足「可成像」条件' }}
            </div>
          </div>

          <!-- 下栏：选中过境的时刻与参数 -->
          <div v-if="passPicked" class="cd-block">
            <div class="cd-title">过境参数 · {{ passPicked.object_name || ('NORAD ' + passPicked.norad_id) }}</div>
            <div class="cd-grid">
              <div class="cd-item"><span>入境 AOS</span><b>{{ fmtMs(passPicked.aosMs) }}</b></div>
              <div class="cd-item"><span>出境 LOS</span><b>{{ fmtMs(passPicked.losMs) }}</b></div>
              <div class="cd-item"><span>可见时长</span><b>{{ fmtDur(passPicked.durationSec) }}</b></div>
              <div class="cd-item"><span>最大仰角</span><b class="heat-strong">{{ fmtNum(passPicked.maxElev, 1) }}°</b></div>
              <div class="cd-item"><span>最高点时刻</span><b>{{ fmtMs(passPicked.maxAtMs) }}</b></div>
              <div class="cd-item"><span>方位角</span><b>{{ fmtNum(passPicked.maxAz, 1) }}°</b></div>
              <div class="cd-item"><span>最近斜距</span><b>{{ fmtNum(passPicked.minRange, 0) }} km</b></div>
              <div class="cd-item"><span>NORAD</span><b>{{ passPicked.norad_id }}</b></div>
            </div>
            <div class="cd-title cd-title-gap">光照条件（最高点时刻）</div>
            <div class="cd-grid">
              <div class="cd-item">
                <span>目标光照</span>
                <b><span class="light-tag" :class="`light-${passPicked.shadowState || 'none'}`">{{ lightLabel(passPicked.shadowState) }}</span></b>
              </div>
              <div class="cd-item"><span>被太阳照亮</span><b>{{ fmtPct(passPicked.sunlitFraction) }}</b></div>
              <div class="cd-item"><span>观测站太阳高度</span><b>{{ passPicked.sunElev == null ? '—' : fmtNum(passPicked.sunElev, 1) + '°' }}</b></div>
              <div class="cd-item"><span>暮光档</span><b>{{ twilightLabel(passPicked.twilight) }}</b></div>
              <div class="cd-item"><span>相位角</span><b>{{ passPicked.phaseAngle == null ? '—' : fmtNum(passPicked.phaseAngle, 1) + '°' }}</b></div>
              <div class="cd-item"><span>月相</span><b>{{ fmtPct(passPicked.moonIllum) }}</b></div>
              <div class="cd-item"><span>目标-月亮角距</span><b>{{ passPicked.moonSep == null ? '—' : fmtNum(passPicked.moonSep, 1) + '°' }}</b></div>
              <div class="cd-item"><span>月光背景</span><b>{{ fmtPct(passPicked.moonBg) }}</b></div>
            </div>
            <div class="cd-title cd-title-gap cd-title-toggle" @click="toggleElevation">
              <span>仰角剖面 · 选中过境</span>
              <span class="cd-caret">{{ elevOpen ? '▾' : '▸' }}</span>
            </div>
            <div v-show="elevOpen" class="cd-elev">
              <div v-if="elevLoading" class="cd-none">正在计算…</div>
              <div v-else-if="elevError" class="cd-none err">仰角剖面计算失败</div>
              <template v-else-if="elevData && elevData.points.length">
                <div class="cd-elev-cap">峰值 {{ fmtNum(elevData.maxElev, 1) }}° @ {{ fmtMs(elevData.maxAtMs) }} · 与明细同口径</div>
                <div ref="elevCanvasRef" class="cd-elev-canvas"></div>
              </template>
              <div v-else class="cd-none">暂无剖面数据</div>
            </div>
          </div>
        </template>
      </template>

      <!-- ② 事件详情（热力点事件 / 碰撞列表项点击） -->
      <template v-else-if="rightMode === 'heat' && heatSel">
        <div class="cd-head">
          <div class="cd-head-main">
            <b class="cd-name">{{ heatSel.name_a }} × {{ heatSel.name_b }}</b>
            <span class="cd-sub">碰撞事件 · TCA {{ heatSel.tca }} UTC</span>
          </div>
          <button class="cd-close" title="收起详情" @click="heatOpen = false">✕</button>
        </div>
        <div class="cd-block">
          <div class="cd-title">碰撞参数</div>
          <div class="cd-grid">
            <div class="cd-item"><span>目标 A</span><b>{{ heatSel.name_a }}<i class="cd-norad">NORAD {{ heatSel.norad_a }}</i></b></div>
            <div class="cd-item"><span>目标 B</span><b>{{ heatSel.name_b }}<i class="cd-norad">NORAD {{ heatSel.norad_b }}</i></b></div>
            <div class="cd-item"><span>{{ isLevelHeat ? '风险等级' : '碰撞概率' }}</span><b class="heat-strong" :style="{ color: heatSel.color }">{{ heatMetricShort(heatSel) }}</b></div>
            <div class="cd-item"><span>最近距离</span><b>{{ fmtNum(heatSel.miss_distance_km, 3) }} km</b></div>
            <div class="cd-item"><span>相对速度</span><b>{{ fmtNum(heatSel.rel_speed_km_per_s, 2) }} km/s</b></div>
            <div class="cd-item"><span>硬体半径</span><b>{{ fmtNum(heatSel.hard_body_radius_m, 1) }} m</b></div>
            <div class="cd-item"><span>事件编号</span><b>{{ heatSel.cdm_id }}</b></div>
          </div>
        </div>
        <!-- 误差椭球（经验 σ）：三维场景里按真实比例画 RTN 三轴椭球；此处给出数值并显著标注口径 -->
        <div class="cd-block">
          <div class="cd-title">误差椭球 · 经验 σ</div>
          <div v-if="conjEllipsoidLoading" class="cd-hint">读取中…</div>
          <div v-else-if="conjEllipsoidError" class="cd-hint err">{{ conjEllipsoidError }}</div>
          <template v-else-if="conjEllipsoid && (conjEllipsoid.a || conjEllipsoid.b)">
            <div class="cd-grid">
              <div v-for="side in [conjEllipsoid.a, conjEllipsoid.b]" :key="side?.norad || Math.random()" class="cd-item">
                <span>{{ side ? `${side.name} · 径向/沿迹/法向 σ` : '目标数据缺失' }}</span>
                <b v-if="side">
                  {{ fmtNum(side.sigma.sr, 1) }} / {{ fmtNum(side.sigma.st, 1) }} / {{ fmtNum(side.sigma.sn, 1) }} km
                  <i class="cd-norad">预报 {{ fmtNum(side.dtHours, 1) }} h · {{ side.sigmaSource === 'model' ? '经验分桶' : '保守兜底' }}</i>
                </b>
                <b v-else>—</b>
              </div>
            </div>
            <div class="cd-hint warn">
              经验 σ：由「同一目标连续两条 TLE 的预报差」按 轨道区域 × 目标类型 × 预报时长 分桶统计，
              反映 TLE 自洽性，<b>不是定轨协方差</b>。真实协方差须来自外部精密轨道（OPR/OPM）。
              <template v-if="covMag > 1.05">
                <br>三维中已放大 <b>×{{ Math.round(covMag) }}</b> 显示（真实 σ 只有几十公里，
                按实际比例画在默认机位下看不见）；上表数值为真实 σ。
              </template>
            </div>
          </template>
          <div v-else class="cd-hint">未取到该事件的椭球数据（该目标缺 TLE 或传播失败）</div>
        </div>
        <!-- 该「碰撞云」覆盖区域内的全部碰撞列表：点击事件点聚合出的同一片云（同一对卫星多次交会 / 邻近卫星对交会），
             点击某一项切换聚焦事件（重画两星轨道 + 卫星端点标记） -->
        <div v-if="heatSelList.length" class="cd-block">
          <div class="cd-title">本区域碰撞列表（{{ heatSelList.length }}）</div>
          <ul class="cdm-list">
            <li
              v-for="c in heatSelList"
              :key="c.id"
              class="cdm-item"
              :class="{ on: heatSel && heatSel.id === c.id }"
              @click="openCdm(c)"
            >
              <div class="cdm-main">
                <b>{{ c.name_a }} × {{ c.name_b }}</b>
                <span class="cdm-tag">TCA {{ c.tca }}</span>
              </div>
              <div class="cdm-grid">
                <span>{{ isLevelHeat ? '等级' : '概率' }} <b :style="{ color: c.color }">{{ heatMetricShort(c) }}</b></span>
                <span>距离 <b>{{ fmtNum(c.miss_distance_km, 3) }} km</b></span>
              </div>
            </li>
          </ul>
        </div>
      </template>

      <!-- ③ 发射站详情（点地球标记 / 左侧站列表）：即将发射计划 + 发射历史（与后台「发射记录下钻」同口径） -->
      <template v-else-if="rightMode === 'site' && siteSel">
        <div class="cd-head">
          <div class="cd-head-main">
            <b class="cd-name">{{ siteSel.name_cn }}</b>
            <span class="cd-sub">
              {{ siteSub(siteSel) }}
              <span class="cd-site-tag" :class="{ off: siteSel.status !== 1 }">{{ siteSel.status === 1 ? '现役' : '退役' }}</span>
              <span v-if="siteSel.site_type" class="cd-site-tag">{{ SITE_TYPE_LABEL[siteSel.site_type] || siteSel.site_type }}</span>
            </span>
          </div>
          <button class="cd-close" title="收起详情" @click="siteOpen = false">✕</button>
        </div>

        <!-- 即将发射：launch_upcoming 按 site_id 关联（后台「关联发射站」同一份数据） -->
        <div class="cd-block">
          <div class="cd-title">即将发射（{{ siteUpcoming.length }}）</div>
          <div v-if="siteUpcomingLoading" class="cd-none">正在加载…</div>
          <div v-else-if="siteUpcomingError" class="cd-none err">{{ siteUpcomingError }}</div>
          <ul v-else-if="siteUpcoming.length" class="site-up-list">
            <li v-for="u in siteUpcoming" :key="u.id" class="site-up-item">
              <div class="site-up-main">
                <b>{{ u.name_cn || u.name || u.mission_name_cn || u.mission_name || '—' }}</b>
                <span class="site-up-net">
                  {{ fmtUtc(u.net) }}
                  <i v-if="u.net_precision && u.net_precision !== '精确'" class="site-up-prec">{{ u.net_precision }}</i>
                </span>
              </div>
              <div class="site-up-grid">
                <span v-if="u.rocket_cn || u.rocket">{{ u.rocket_cn || u.rocket }}</span>
                <span v-if="u.provider_cn || u.provider">{{ u.provider_cn || u.provider }}</span>
                <span v-if="u.pad_cn || u.pad">工位 {{ u.pad_cn || u.pad }}</span>
                <span v-if="u.orbit_cn || u.orbit">{{ u.orbit_cn || u.orbit }}</span>
                <span v-if="u.status_name_cn || u.status_name" class="site-up-status">{{ u.status_name_cn || u.status_name }}</span>
              </div>
            </li>
          </ul>
          <div v-else class="cd-none">暂无即将发射计划</div>
        </div>

        <!-- 发射历史：launch_record 按 site_code ↔ launch_site.codes 关联 -->
        <div class="cd-block">
          <div class="cd-title">发射历史（{{ siteHistoryTotal }}）</div>
          <div v-if="siteHistoryLoading" class="cd-none">正在加载…</div>
          <div v-else-if="siteHistoryError" class="cd-none err">{{ siteHistoryError }}</div>
          <ul v-else-if="siteHistory.length" class="site-his-list">
            <li v-for="r in siteHistory" :key="r.id" class="site-his-item">
              <div class="site-his-main">
                <b>{{ fmtUtc(r.launch_at, true) }}</b>
                <span class="site-his-out" :class="r.outcome || 'unknown'">{{ OUTCOME_LABEL[r.outcome || 'unknown'] || '—' }}</span>
              </div>
              <div class="site-his-grid">
                <span v-if="r.vehicle">{{ r.vehicle }}</span>
                <span v-if="r.payload_count != null">载荷 {{ r.payload_count }}</span>
                <span v-if="r.flight_id">{{ r.flight_id }}</span>
                <span v-if="r.pad">工位 {{ r.pad }}</span>
                <span v-if="r.agency">{{ r.agency }}</span>
              </div>
            </li>
          </ul>
          <div v-else class="cd-none">暂无发射记录</div>
          <div v-if="siteHistoryPages > 1" class="site-his-page">
            <button :disabled="siteHistoryPage <= 1 || siteHistoryLoading" @click="changeSiteHistoryPage(siteHistoryPage - 1)">上一页</button>
            <span>{{ siteHistoryPage }} / {{ siteHistoryPages }}</span>
            <button :disabled="siteHistoryPage >= siteHistoryPages || siteHistoryLoading" @click="changeSiteHistoryPage(siteHistoryPage + 1)">下一页</button>
          </div>
        </div>
      </template>

      <!-- ④ 用户星历威胁事件详情（星历面板事件列表 / 热力「我的星历」页签点选后展示） -->
      <template v-else-if="rightMode === 'ephEv' && threatSelected">
        <div class="cd-head">
          <div class="cd-head-main">
            <b class="cd-name">威胁事件 · {{ activeEphem?.name || `NORAD ${threatSelected.selfNorad}` }} × {{ threatSelected.otherName }}</b>
          </div>
          <div class="cd-head-actions">
            <button class="cd-close" title="收起详情（保留三维高亮）" @click="ephEvOpen = false">✕</button>
          </div>
        </div>
        <div class="cd-block">
          <div class="cd-title">接近参数（TCA）</div>
          <div class="cd-grid is-inline">
            <div class="cd-item is-wide">
              <span>最近接近时刻(UTC)</span><b>{{ fmtUtcMs(threatSelected.tca) }}</b>
            </div>
            <div class="cd-item"><span>最小距离</span><b>{{ fmtNum(threatSelected.missKm, 3) }} km</b></div>
            <div class="cd-item"><span>相对速度</span><b>{{ fmtNum(threatSelected.relSpeedKmS, 3) }} km/s</b></div>
            <div class="cd-item"><span>碰撞概率</span><b>{{ threatSelected.pc > 0 ? threatSelected.pc.toExponential(2) : '0' }}</b></div>
            <div class="cd-item">
              <span>风险等级</span>
              <b :style="{ color: EPH_EV_LEVEL[threatSelected.level].color }">{{ EPH_EV_LEVEL[threatSelected.level].label }}</b>
            </div>
          </div>
        </div>
        <div class="cd-block">
          <div class="cd-title">双方目标</div>
          <div class="cd-grid is-inline">
            <div class="cd-item"><span>本星</span><b>{{ activeEphem?.name || '—' }}<i class="cd-norad">NORAD {{ threatSelected.selfNorad }}</i></b></div>
            <div class="cd-item"><span>对方</span><b>{{ threatSelected.otherName }}<i class="cd-norad">NORAD {{ threatSelected.otherNorad }}</i></b></div>
          </div>
        </div>
        <button class="cd-eph-btn" @click="openEphForEvent">打开星历分析窗口</button>
      </template>

      <!-- ⑤ 我的星历详情（左侧「我的星历」分组点选后展示；与星历分析面板互斥，卡片内按钮再打开面板） -->
      <template v-else-if="rightMode === 'eph' && ephDetail">
        <div class="cd-head">
          <div class="cd-head-main">
            <b class="cd-name">{{ ephDetail.name }}</b>
            <span class="cd-sub">NORAD {{ ephDetail.norad || '—' }} · {{ ephDetail.format.toUpperCase() }} / {{ ephDetail.frame }}</span>
          </div>
          <div class="cd-head-actions">
            <button class="cd-close" title="收起详情" @click="ephDetailOpen = false">✕</button>
          </div>
        </div>
        <div class="cd-block">
          <div class="cd-title">星历概览</div>
          <div class="cd-grid is-inline">
            <div class="cd-item is-wide"><span>有效期(UTC)</span><b>{{ fmtUtcMs(ephDetail.start) }} ~ {{ fmtUtcMs(ephDetail.stop) }}</b></div>
            <div class="cd-item"><span>点数</span><b>{{ ephDetail.points.toLocaleString() }}</b></div>
            <div class="cd-item"><span>步长</span><b>{{ ephDetail.stepSec }} s</b></div>
            <div class="cd-item is-wide"><span>协方差</span><b>{{ ephDetail.hasCov ? '含 6×6（Pc 更可信）' : '不含，Pc 按经验误差估计' }}</b></div>
          </div>
        </div>
        <div class="cd-block">
          <div class="cd-title">当前位置（仿真时刻）</div>
          <div class="cd-grid is-inline">
            <div class="cd-item"><span>纬度</span><b>{{ fmtLat(ephDetail.lat) }}</b></div>
            <div class="cd-item"><span>经度</span><b>{{ fmtLon(ephDetail.lon) }}</b></div>
            <div class="cd-item"><span>高度</span><b>{{ fmtNum(ephDetail.alt, 1) }} km</b></div>
            <div class="cd-item"><span>速度</span><b>{{ fmtNum(ephDetail.vel, 3) }} km/s</b></div>
          </div>
        </div>
        <div class="cd-block">
          <button class="cd-eph-btn" @click="onOpenEph()">威胁分析 / 打开星历面板</button>
        </div>
      </template>

      <!-- ⑤ 卫星详情（无碰撞事件时的原样详情）；selDetail 仅在 hasSel && selDetail 时右栏为 'sat'，此处收窄非空供模板安全访问 -->
      <template v-else-if="rightMode === 'sat' && selDetail">
      <div class="cd-head">
        <div class="cd-head-main">
          <b class="cd-name">{{ sel.name }}</b>
          <span class="cd-sub">
            NORAD {{ sel.id }} · {{ TYPE_LABEL[sel.type] || sel.type }}
            <span v-if="headerFlag" class="cd-owner" :title="headerFlag.name">
              <img class="cd-owner-flag" :src="headerFlag.flag" :alt="headerFlag.name" loading="lazy" />
            </span>
          </span>
        </div>
        <div class="cd-head-actions">
          <button class="cd-close" title="收起详情" @click="detailOpen = false">✕</button>
        </div>
      </div>
      <div class="cd-block">
        <div class="cd-title cd-title-toggle" @click="posOpen = !posOpen">
          <span>位置信息</span>
          <span class="cd-caret">{{ posOpen ? '▾' : '▸' }}</span>
        </div>
        <div class="cd-grid is-inline" v-show="posOpen">
          <div class="cd-item"><span>纬度</span><b>{{ fmtLat(sel.lat) }}</b></div>
          <div class="cd-item"><span>经度</span><b>{{ fmtLon(sel.lon) }}</b></div>
          <div class="cd-item"><span>高度</span><b>{{ fmtNum(sel.alt, 1) }} km</b></div>
          <div class="cd-item"><span>速度</span><b>{{ fmtNum(sel.vel, 3) }} km/s</b></div>
        </div>
      </div>
      <div class="cd-block">
        <div class="cd-title cd-title-toggle" @click="metaOpen = !metaOpen">
          <span>卫星资料</span>
          <span class="cd-caret">{{ metaOpen ? '▾' : '▸' }}</span>
        </div>
        <div class="cd-grid is-inline" v-show="metaOpen">
          <div class="cd-item"><span>国际编号</span><b>{{ selDetail.intl_desig || '—' }}</b></div>
          <div class="cd-item"><span>轨道区域</span><b>{{ REGIME_CN[selDetail.regime] || selDetail.regime || '—' }}</b></div>
          <div class="cd-item"><span>用途类型</span><b>{{ purposeLabel(selDetail.purpose_type) || '—' }}</b></div>
          <div class="cd-item"><span>在轨状态</span><b>{{ activeLabel(selDetail.is_active) }}</b></div>
          <div class="cd-item is-wide"><span>发射地</span><b>{{ selDetail.launch_site || '—' }}</b></div>
          <div class="cd-item is-wide"><span>国家/地区</span><b>{{ catCountry?.name || '—' }}</b></div>
          <div class="cd-item is-wide"><span>发射时间(UTC)</span><b>{{ catData?.sat_launch_at ? fmtUtc(catData.sat_launch_at, true) : '—' }}</b></div>
          <div class="cd-item is-wide"><span>所属星座</span><b>{{ selConstellations.map((c) => c.name).join('、') || '—' }}</b></div>
        </div>
      </div>
      </template>

      <!-- ⑥ 星座成员列表（点击左侧星座后右侧展示）：点击某颗成员即用亮青色高亮其轨道线，
           在星座里单独突出显示（再点同一颗取消）；不改变「选中单星」状态与镜头。 -->
      <template v-else-if="rightMode === 'cons'">
        <div class="cd-head">
          <div class="cd-head-main">
            <b class="cd-name">{{ filterConst }}</b>
            <span class="cd-sub">{{ consSatPanel.idx.length.toLocaleString() }} 颗成员卫星 · 点击成员飞抵该星并高亮其轨道线</span>
          </div>
          <button class="cd-close" title="收起列表" @click="consListOpen = false">✕</button>
        </div>
        <div class="cd-block">
          <div class="cd-title">星座成员</div>
          <ul class="cons-sat-list" @scroll="onConsSatScroll">
            <li
              v-for="gi in consSatPanel.idx.slice(0, consSatPanel.count)"
              :key="gi"
              class="cons-sat-item"
              :class="{ on: consHighlightNorad === g.cloudList[gi].norad_id }"
              :title="consHighlightNorad === g.cloudList[gi].norad_id ? '再次点击取消高亮' : '点击：镜头飞抵该卫星，并将其轨道线颜色替换为亮青色'"
              @click="toggleConsHighlight(g.cloudList[gi].norad_id)"
            >
              <span class="cons-sat-dot" :style="{ background: TYPE_HEX[g.cloudList[gi].object_type] || '#8fd0ff' }"></span>
              <span class="cons-sat-name">{{ g.cloudList[gi].object_name || ('NORAD ' + g.cloudList[gi].norad_id) }}</span>
              <span class="cons-sat-nor">NORAD {{ g.cloudList[gi].norad_id }}</span>
            </li>
            <div v-if="!consSatPanel.idx.length" class="cd-none">该星座下暂无载荷卫星</div>
            <li v-else-if="consSatPanel.count < consSatPanel.idx.length" class="cons-sat-more">继续滚动加载更多…</li>
          </ul>
        </div>
      </template>
    </aside>

    <!-- 详情收起后的浮动小按钮：点击重新展开过境明细/卫星详情/碰撞列表/事件详情/发射站详情/星座成员列表 -->
    <button v-if="!rightMode && (hasSel || heatSel || passSelTarget || siteSel || (dockActive === 'cons' && filterConst && !compareActive))" class="constel-detail-tab" title="展开详情" @click="reopenRight">
      ◎
    </button>

    <!-- 桌面端：太空安全目标列表缺省收起后的左缘外拉 tag（竖排文字），点击拉出面板 -->
    <button
      v-if="showSatTag"
      class="edge-tag edge-tag-left"
      title="展开太空安全目标列表"
      @click="openSatPanel"
    >太空安全目标列表</button>

    <!-- 右缘外拉 tag：与左缘「太空安全目标列表」对称（竖排同字号），点击拉出星历面板 -->
    <button
      v-if="showEphemTag"
      class="edge-tag edge-tag-right"
      title="展开星历与安全分析"
      @click="toggleEphemDock"
    >星历与安全分析</button>

    <!-- 移动端：列表收起后的左上角浮标（面板被收起但 dock 仍激活），点击重新展开对应列表 -->
    <button
      v-if="isMobile && dockActive !== '' && dockMode === '' && !(dockActive === 'eph' && ephOpen)"
      class="side-panel-tab"
      :title="dockActive === 'sat' ? '展开太空安全目标列表' : dockActive === 'cons' ? '展开星座列表' : dockActive === 'site' ? '展开发射站列表' : dockActive === 'heat' ? '展开碰撞热力' : dockActive === 'pass' ? '展开城市过境' : dockActive === 'multi' ? '展开多区域过境' : dockActive === 'eph' ? '展开星历分析' : '展开区域过境'"
      @click="openActivePanel"
    >{{ dockActive === 'sat' ? '▤' : dockActive === 'cons' ? '✦' : dockActive === 'site' ? '⌖' : dockActive === 'heat' ? '✱' : dockActive === 'pass' ? '➤' : dockActive === 'eph' ? '◍' : '◆' }}</button>

    <!-- 空间态势分析智能体浮层（前台免登录 /cgi/ai；独立于 dock 视图状态）。
         模型下发的界面动作由本容器消费，落到三维态势（定位选中 / 打开面板 / 绘制区域 / 图谱下钻） -->
    <AiChatDrawer ref="aiDrawerRef" v-model:open="aiOpen" :target="aiTarget" @action="onAiAction" @round-start="onAiRoundStart" />
  </div>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
