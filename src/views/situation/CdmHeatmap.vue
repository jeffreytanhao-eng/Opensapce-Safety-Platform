<script setup lang="ts">
/**
 * 星座总览 /situation 碰撞热力面板（左侧滑出）
 * 负责热力模式的 UI：当前来源 + 数据批次 + 配色图例。
 * 热力标记本体由 BaseScene.vue 在 heatMode 下渲染（交会热力 / 交会分析热力做网格宏观聚合、CDM 热力逐事件柔光云；
 * 点选事件展示两星轨道），
 * 本组件只读写共享 store（heatSource / heatLegend / heatHiddenColors / heatList / heatBatchRunId / heatBatches）
 * 驱动标记重建与右侧事件详情：图例、指标名均由后端下发，前端只渲染不换算；图例可勾选显隐对应档位的事件。
 * 纯动作（关闭面板）通过 emit 交给父组件 index.vue 编排。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  HEAT_SOURCES, heatSource,
  heatList, heatLegend, heatHiddenColors, heatMetricLabel,
  heatLoading, heatError, dockMode,
  heatBatchRunId, heatBatches, heatFocusNorad, fmtNum,
  heatDays, heatDay, heatDayGroups, heatFiltered,
  heatAltBand, heatMetric, heatRiskFloor, heatPcFloor, heatMissCeil,
  heatCell, HEAT_CELL_OPTIONS, HEAT_RISK_BANDS,
  heatEphStatus, heatBandColor,
  drawerHeightVh, isDrawerDragging, useDrawerDrag,
  type HeatSource
} from './scene'
import { listThreatEventRows } from './ephem/store'
import type { ThreatEvent } from './ephem/types'
import { useDevice } from '@/composables/useDevice'
import { listConjPublic, listCdmPublic, listCriPublic } from '@/api/sat_public'
import type { ConjEvent, CdmListItem, CriListItem, CdmHeatEvent, HeatLegendItem } from '@/api/sat_public'
import { useDelayed } from '@/composables/useDelayed'

const emit = defineEmits<{
  (e: 'close'): void
  /** 点击「本批次交会数据」某一对：上报其 norad 对 + TCA，由父组件让 BaseScene 绘制 2 条轨道 + 目标模型 */
  (e: 'select', pair: { norad_a: number; norad_b: number; tca: string }): void
  /** 点击「我的星历」页签里的事件：父组件激活对应星历并选中该威胁事件 */
  (e: 'pick-ephem', payload: { setId: string; event: ThreatEvent }): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 智能体联动：open_panel(heat, selectFirst=true) 打开面板后，外部通过 autoSelectTick 递增触发「自动选中第一条」 */
const props = withDefaults(defineProps<{ autoSelectTick?: number }>(), { autoSelectTick: 0 })

/** 移动端判定（虚拟滚动仅桌面端启用，移动端沿用抽屉整体滚动） */
const { isMobile } = useDevice()

/* ============================================================
 * P3 热力筛选：时间窗（heatDays）/ 高度层 / 指标阈值 / 按天柱状图
 *  - 时间窗直接改 heatDays，BaseScene 已有 watch(heatDays) → loadHeat 重新拉取；
 *  - 高度层与指标阈值只过滤 heatFiltered（前端运算，不请求后端）；
 *  - 柱状图数据来自后端 day_groups（仅时间窗 > 0 时下发），点击可切到该天。
 * ============================================================ */
/** 时间窗快捷档（天）：0 = 全部（后端既有口径） */
const DAY_OPTIONS = [
  { v: 0, label: '全部' }, { v: 1, label: '24h' }, { v: 3, label: '3d' },
  { v: 7, label: '7d' }, { v: 30, label: '30d' }
]
/** 星历热力是本机前向联算（无历史事件可回看），时间窗只保留 24h / 3d 两档 */
const dayOptions = computed(() => heatSource.value === 'eph-aoe'
  ? [{ v: 1, label: '24h' }, { v: 3, label: '3d' }]
  : DAY_OPTIONS)
const ALT_OPTIONS = [
  { v: 'all', label: '全部' }, { v: 'leo', label: 'LEO' },
  { v: 'meo', label: 'MEO' }, { v: 'geo', label: 'GEO+' }
] as const
const METRIC_OPTIONS = [
  { v: 'risk', label: '综合风险' }, { v: 'pc', label: '碰撞概率' }, { v: 'miss', label: '最近距离' }
] as const

/** 官方 CDM 无 altitude 字段：选了高度层会把这些事件全部过滤掉，用于提示 */
const altUnavailable = computed(() => heatSource.value === 'spacetrack' && heatAltBand.value !== 'all')

/** 阈值滑杆（单位随指标切换）：risk 0~100%、pc 对数刻度 1e-8~1e-2、miss 0~100km */
const sliderVal = computed({
  get: () => {
    if (heatMetric.value === 'pc') {
      return heatPcFloor.value > 0 ? Math.round((Math.log10(heatPcFloor.value) + 8) / 6 * 100) : 0
    }
    if (heatMetric.value === 'miss') return Math.round(heatMissCeil.value)
    return Math.round(heatRiskFloor.value * 100)
  },
  set: (v: number) => {
    if (heatMetric.value === 'pc') heatPcFloor.value = v <= 0 ? 0 : 10 ** (-8 + (v / 100) * 6)
    else if (heatMetric.value === 'miss') heatMissCeil.value = v
    else heatRiskFloor.value = v / 100
  }
})

const thresholdText = computed(() => {
  if (heatMetric.value === 'pc') return heatPcFloor.value > 0 ? `≥ ${heatPcFloor.value.toExponential(1)}` : '不限'
  if (heatMetric.value === 'miss') return `≤ ${Math.round(heatMissCeil.value)} km`
  return `≥ ${Math.round(heatRiskFloor.value * 100)}%`
})

/** 柱状图只画有事件的天（后端按窗口补齐的 0 事件天不画，避免整排空柱） */
const dayBars = computed(() => heatDayGroups.value.filter((d) => d.count > 0))
/** 柱状图最高柱（用于按比例算高度，最小 1 避免除零） */
const maxDayCount = computed(() => Math.max(1, ...dayBars.value.map((d) => d.count)))
function barHeight(count: number) {
  return `${Math.max(8, Math.round((count / maxDayCount.value) * 100))}%`
}

/** 等级文案（与后台 /mui/sat_conj 一致） */
const LEVEL_LABEL: Record<string, string> = { danger: '高危', warning: '警告', info: '关注' }

/** 图例行：官方 CDM 用后端下发的 Pc 配色；交会热力 / 交会分析热力改用前端 5 档风险色带
 *  （与 BaseScene 的 heatColorOf 同一口径，勾选隐藏的档位与三维配色一一对应）。 */
const legendRows = computed<HeatLegendItem[]>(() => {
  if (heatSource.value === 'spacetrack') return heatLegend.value
  return HEAT_RISK_BANDS.map((b) => ({ color: b.color, label: b.label, thresh: b.thresh }))
})

/** 接近时刻 `YYYY-MM-DD HH:mm:ss` → `MM-DD HH:mm`（面板列窄，省略年份与秒） */
function fmtTca(tca?: string) {
  if (!tca) return '—'
  const m = String(tca).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(tca)
}

/* ============================================================
 * 交会数据列表（三种来源共用同一套渲染与交互）
 *  - 交会热力（local）：走前台免登录 /cgi/sat_conj/list，取「总交会库」当前批次的接近事件明细
 *    （含「关注 info」，不限于热力图的 danger/warning），检索条件与后台 /mui/sat_conj 一致；
 *  - 交会分析热力（cri）：走前台免登录 /cgi/sat_cri/list，取交会分析库（CRI/CRP 模型）当前批次的
 *    交会事件明细，同为批次口径（支持批次回看），color / 风险文案由后端按 CRP 五级下发；
 *  - CDM 热力（spacetrack）：走前台免登录 /cgi/sat_cdm/list，取 sat_cdm 库表明细（Pc>0，已在后端按
 *    「NORAD 对 + TCA」去重，同一交会的多条官方报文只留概率最高的一条），按碰撞概率降序；
 *    检索条件为关键词 + TCA 日期范围（CDM 无等级档，故等级下拉仅 local / cri 展示）。
 * 三种来源先归一化为 ListRow 再渲染：点击某一行上报其 NORAD 对 + TCA，
 * 由父组件让 BaseScene 绘制 2 条轨道 + TCA 目标模型（与点选热力云同一动作）。
 * ============================================================ */
/** 列表行（抹平三种来源的字段差异；color / label 均由后端按各自口径算好） */
interface ListRow {
  key: string
  norad_a: number
  norad_b: number
  tca: string
  name_a: string
  name_b: string
  /** 最近距离（km） */
  dist: number
  /** 风险点配色（local = 等级档；CDM = 碰撞概率分档；cri = CRP 五级，均由后端算好，与热力云同一套阈值） */
  color: string
  /** 风险文案（local = 高危/警告/关注；CDM = 碰撞概率；cri = CRP 五级文案） */
  label: string
}

/** 等级档 → 颜色（danger/warning 与热力图图例一致；info 为列表专有的「关注」档） */
const LEVEL_COLOR: Record<string, string> = { danger: '#ff6b6b', warning: '#ffb454', info: '#93a4bd' }

function toLocalRow(r: ConjEvent): ListRow {
  return {
    key: `${r.norad_a}-${r.norad_b}-${r.tca}`,
    norad_a: r.norad_a, norad_b: r.norad_b, tca: r.tca,
    name_a: r.name_a || `NORAD ${r.norad_a}`,
    name_b: r.name_b || `NORAD ${r.norad_b}`,
    dist: r.min_distance,
    color: LEVEL_COLOR[r.level] || '#93a4bd',
    label: LEVEL_LABEL[r.level] || r.level || '—'
  }
}

function toCdmRow(r: CdmListItem): ListRow {
  return {
    key: `${r.norad_a}-${r.norad_b}-${r.tca}`,
    norad_a: r.norad_a, norad_b: r.norad_b, tca: r.tca,
    name_a: r.name_a || `NORAD ${r.norad_a}`,
    name_b: r.name_b || `NORAD ${r.norad_b}`,
    dist: r.miss_distance_km,
    color: r.color || '#93a4bd',
    label: r.metric_text || '—'
  }
}

function toCriRow(r: CriListItem): ListRow {
  return {
    key: `${r.norad_a}-${r.norad_b}-${r.tca}`,
    norad_a: r.norad_a, norad_b: r.norad_b, tca: r.tca,
    name_a: r.name_a || `NORAD ${r.norad_a}`,
    name_b: r.name_b || `NORAD ${r.norad_b}`,
    dist: r.min_distance,
    color: r.color || '#93a4bd',
    label: r.metric_text || '—'
  }
}

/** 星历热力（本机联算）：列表直接取自 heatList（BaseScene 已把联算结果转成热力事件），
 *  与三维热力云同一份数据，避免再向后端请求一次。 */
function toAoeRow(r: CdmHeatEvent): ListRow {
  return {
    key: `${r.norad_a}-${r.norad_b}-${r.tca}`,
    norad_a: r.norad_a, norad_b: r.norad_b,
    tca: r.tca,
    name_a: r.name_a || `NORAD ${r.norad_a}`,
    name_b: r.name_b || `NORAD ${r.norad_b}`,
    dist: r.miss_distance_km,
    color: heatBandColor(r.risk),
    label: `${r.level === 'high' ? '高危' : r.level === 'medium' ? '警告' : '关注'} · Pc ${r.collision_probability > 0 ? r.collision_probability.toExponential(1) : '0'}`
  }
}

const rows = ref<ListRow[]>([])
const total = ref(0)
const listLoading = ref(false)
/** 列表是分页查询，正常毫秒级返回：默认不显示「加载中」，超过 1.5s 才出现兜底提示 */
const listLoadingHint = useDelayed(listLoading)
const listError = ref('')
const query = reactive({ page: 1, pageSize: 20, keyword: '', level: '', dateFrom: '', dateTo: '' })
const maxPage = computed(() => Math.max(1, Math.ceil(total.value / query.pageSize)))

/* ---- 列表虚拟滚动（P3） ----
 * 后端单页上限 200 行（pageSize=500 也只返回 200），大页全量渲染会拖慢面板滚动；
 * 超过 120 行时只渲染视口附近的行，上下用占位块撑起滚动高度，DOM 节点数恒定在 ~20。 */
const ROW_H = 62               // .hc-item 高度 58px + margin-bottom 4px
const VIRT_TRIGGER = 120
const listEl = ref<HTMLElement | null>(null)
const listScrollTop = ref(0)
const listViewH = ref(360)
const virtOn = computed(() => !isMobile.value && rows.value.length > VIRT_TRIGGER)
const virtStart = computed(() => (virtOn.value ? Math.max(0, Math.floor(listScrollTop.value / ROW_H) - 6) : 0))
const virtEnd = computed(() => (virtOn.value
  ? Math.min(rows.value.length, Math.ceil((listScrollTop.value + listViewH.value) / ROW_H) + 6)
  : rows.value.length))
const visibleRows = computed(() => rows.value.slice(virtStart.value, virtEnd.value))
const padTop = computed(() => virtStart.value * ROW_H)
const padBottom = computed(() => (rows.value.length - virtEnd.value) * ROW_H)
function onListScroll() {
  const el = listEl.value
  if (!el) return
  listScrollTop.value = el.scrollTop
  listViewH.value = el.clientHeight
}
/** 翻页 / 改每页条数时回到列表顶部（避免沿用上一页的滚动位置导致空白） */
function resetListScroll() {
  listScrollTop.value = 0
  if (listEl.value) listEl.value.scrollTop = 0
}

/** 列表标题：按来源区分口径（local / cri = 各自库当前批次明细；CDM = 官方 CDM 库表明细） */
const listTitle = computed(() => ephTab.value
  ? '我的星历事件（本机）'
  : heatSource.value === 'local' ? '本批次交会数据'
    : heatSource.value === 'cri' ? '交会分析数据'
      : heatSource.value === 'eph-aoe' ? '星历热力事件（本机联算）'
        : 'CDM 交会数据')

/** 拉取当前来源的交会明细：local = 当前批次（heatBatchRunId 指定 / 后端默认最近全量批次），
 *  cri = 交会分析库当前批次（同样支持批次回看），CDM = sat_cdm 库表全量明细；关键词与日期范围口径一致。 */
async function loadList() {
  if (ephTab.value) {
    await loadEphList()
    return
  }
  // 星历热力：列表就是当前 heatList（联算结果），在前端按关键词 / 等级 / 日期筛选
  if (heatSource.value === 'eph-aoe') {
    const kw = query.keyword.trim().toLowerCase()
    const from = query.dateFrom ? new Date(`${query.dateFrom}T00:00:00`).getTime() : -Infinity
    const to = query.dateTo ? new Date(`${query.dateTo}T23:59:59`).getTime() : Infinity
    const lvl = query.level === 'danger' ? 'high' : query.level === 'warning' ? 'medium' : query.level === 'info' ? 'low' : ''
    const out: ListRow[] = []
    for (const ev of heatList.value) {
      if (lvl && ev.level !== lvl) continue
      const tcaMs = new Date(ev.tca).getTime()
      if (tcaMs < from || tcaMs > to) continue
      if (kw && !`${ev.name_a} ${ev.name_b} ${ev.norad_a} ${ev.norad_b}`.toLowerCase().includes(kw)) continue
      out.push(toAoeRow(ev))
    }
    rows.value = out
    total.value = out.length
    loadedOnce.value = true
    tryAutoSelectFirst()
    return
  }
  listLoading.value = true
  listError.value = ''
  try {
    // 日期选择器为「日」粒度：起止各补足一天边界，避免当天事件被漏掉
    const base = {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      dateFrom: query.dateFrom ? `${query.dateFrom} 00:00:00` : undefined,
      dateTo: query.dateTo ? `${query.dateTo} 23:59:59` : undefined
    }
    if (heatSource.value === 'local') {
      const res = await listConjPublic({
        ...base,
        level: query.level || undefined,
        run_id: heatBatchRunId.value ?? undefined
      })
      rows.value = res.list.map(toLocalRow)
      total.value = res.total
    } else if (heatSource.value === 'cri') {
      const res = await listCriPublic({
        ...base,
        level: query.level || undefined,
        run_id: heatBatchRunId.value ?? undefined
      })
      rows.value = res.list.map(toCriRow)
      total.value = res.total
    } else {
      const res = await listCdmPublic(base)
      rows.value = res.list.map(toCdmRow)
      total.value = res.total
    }
  } catch (e) {
    listError.value = (e as Error)?.message || '交会数据加载失败'
    rows.value = []
    total.value = 0
  } finally {
    listLoading.value = false
    loadedOnce.value = true
    tryAutoSelectFirst()
  }
}

/* ============================================================
 * 「我的星历」页签：读取本机 IndexedDB 里保存的筛选结果
 *  - 不改变 heatSource（三维热力仍按后端来源绘制），只替换下方列表数据；
 *  - 行点击上报 setId + 事件，由父组件激活星历并选中该威胁事件。
 * ============================================================ */
const ephTab = ref(false)
/** 本机保存的事件总数（不随关键词/日期筛选变化，用于头部计数） */
const ephCount = ref(0)
/** 行 key → 事件来源（列表行抹平了字段，点击时需要原始事件） */
const ephPicks = new Map<string, { setId: string; event: ThreatEvent }>()
const EPH_LEVEL: Record<ThreatEvent['level'], { label: string; color: string }> = {
  high: { label: '高危', color: '#ff6b6b' },
  medium: { label: '警告', color: '#ffb454' },
  low: { label: '关注', color: '#7fb0ff' }
}

/** unix ms → `YYYY-MM-DD HH:mm:ss`（与后端 TCA 字符串同格式，复用 fmtTca 渲染） */
function utcText(ms: number) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** 读取并归一化本机星历事件（关键词 / 日期 / 等级筛选与后端列表同口径） */
async function loadEphList() {
  listLoading.value = true
  listError.value = ''
  ephPicks.clear()
  try {
    const sets = await listThreatEventRows()
    const kw = query.keyword.trim().toLowerCase()
    const from = query.dateFrom ? new Date(`${query.dateFrom}T00:00:00`).getTime() : -Infinity
    const to = query.dateTo ? new Date(`${query.dateTo}T23:59:59`).getTime() : Infinity
    const lvl = query.level === 'danger' ? 'high' : query.level === 'warning' ? 'medium' : query.level === 'info' ? 'low' : ''
    const out: ListRow[] = []
    let count = 0
    for (const s of sets) {
      const nameA = s.selfName || `NORAD ${s.selfNorad}`
      for (const ev of s.events) {
        count++
        if (lvl && ev.level !== lvl) continue
        if (ev.tca < from || ev.tca > to) continue
        const nameB = ev.otherName || `NORAD ${ev.otherNorad}`
        if (kw && !`${nameA} ${nameB} ${ev.otherNorad}`.toLowerCase().includes(kw)) continue
        const lv = EPH_LEVEL[ev.level] || EPH_LEVEL.low
        const key = `eph-${s.setId}-${ev.otherNorad}-${ev.tca}`
        ephPicks.set(key, { setId: s.setId, event: ev })
        out.push({
          key,
          norad_a: ev.selfNorad,
          norad_b: ev.otherNorad,
          tca: utcText(ev.tca),
          name_a: nameA,
          name_b: nameB,
          dist: ev.missKm,
          color: lv.color,
          label: `${lv.label} · Pc ${ev.pc > 0 ? ev.pc.toExponential(1) : '0'}`
        })
      }
    }
    out.sort((a, b) => a.tca.localeCompare(b.tca))
    rows.value = out
    total.value = out.length
    ephCount.value = count
    loadedOnce.value = true
  } catch (e) {
    listError.value = (e as Error)?.message || '读取本机星历事件失败'
    rows.value = []
    total.value = 0
    ephCount.value = 0
  } finally {
    listLoading.value = false
  }
}

/** 星历热力的有效时间窗：heatDays 落在 0/7/30 等档位时按 24h 处理（前向联算只认 24h / 3d） */
const activeDay = computed(() => heatSource.value === 'eph-aoe'
  ? (heatDays.value >= 3 ? 3 : 1)
  : heatDays.value)

/** 切到后端来源：关掉「我的星历」页签，交给 heatSource 的 watch 重载列表 */
function pickSource(k: HeatSource) {
  ephTab.value = false
  heatSource.value = k
}

/** 切到「我的星历」页签：只读本机数据，不触发后端请求 */
function openEphTab() {
  if (ephTab.value) return
  ephTab.value = true
  query.page = 1
  query.level = ''
  resetListScroll()
  void loadEphList()
}

function search() { query.page = 1; resetListScroll(); loadList() }

function resetSearch() {
  query.keyword = ''
  query.level = ''
  query.dateFrom = ''
  query.dateTo = ''
  search()
}

function goPage(p: number) {
  if (p < 1 || p > maxPage.value) return
  query.page = p
  resetListScroll()
  loadList()
}

/** 切换某一图例档位的显隐：按配色（后端下发的档位色，事件 color 必与其一致）在 heatHiddenColors 中增删，
 *  三维热力视图经 heatFiltered 过滤后重建，档位一勾即隐藏 / 取消即恢复。 */
function toggleLegend(color: string) {
  if (heatHiddenColors.has(color)) heatHiddenColors.delete(color)
  else heatHiddenColors.add(color)
}

/** 面板展开 / 切换数据批次 / 切换来源时重载：检索条件保留，回到第 1 页。
 *  智能体联动：若本次打开携带目标卫星（heatFocusNorad），先把关键词设为该 NORAD（后端按 norad_a/norad_b 精确匹配），
 *  再重载 —— 保证列表/自动选中都落在目标卫星的交会上。 */
watch([dockMode, heatBatchRunId, heatSource], () => {
  if (dockMode.value !== 'heat') return
  applyFocusNorad()
  query.page = 1
  loadList()
})

/** 星历热力：联算完成后 heatList 整体替换，列表数据源就是 heatList，需再刷一次列表 */
watch(heatList, () => {
  if (dockMode.value !== 'heat' || ephTab.value || heatSource.value !== 'eph-aoe') return
  applyFocusNorad()
  query.page = 1
  loadList()
})

/** 消费「本次打开要聚焦的目标卫星」：读取 heatFocusNorad → 写入关键词检索框 → 置回 null（只对本次打开生效，
 *  之后用户可自由检索，也不会残留影响下次打开）。返回是否确实设置了过滤。 */
function applyFocusNorad(): boolean {
  const n = Number(heatFocusNorad.value)
  if (!Number.isFinite(n) || n <= 0) return false
  heatFocusNorad.value = null
  query.keyword = String(n)
  return true
}

/** 批次下拉文案：`#id · MM-DD HH:mm`（扫描时间；不带事件数，避免文案过长被截断） */
function batchLabel(id: number, createdAt?: string) {
  if (!createdAt) return `#${id}`
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return `#${id}`
  const p = (n: number) => String(n).padStart(2, '0')
  return `#${id} · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 「数据批次」下拉项：最近 N 个「全体 × 全体」全量批次（总交会库历史）。
 *  若当前批次不在列表中（如库中暂无 mode='all' 批次、回退到别的批次），补一条占位项保证回显不空。 */
const batchOptions = computed(() => {
  const list = heatBatches.value.map((b) => ({ id: b.id, label: batchLabel(b.id, b.created_at) }))
  const cur = heatBatchRunId.value
  if (cur && !list.some((o) => o.id === cur)) {
    list.unshift({ id: cur, label: `当前批次 #${cur}` })
  }
  return list
})

/** 切换数据批次：null 表示回到「总交会库」当前批次（由后端解析最近全量批次） */
function onBatchChange(e: Event) {
  const v = Number((e.target as HTMLSelectElement).value)
  heatBatchRunId.value = Number.isFinite(v) && v > 0 ? v : null
}

/** 已点选（正在三维中绘制轨道与目标模型）的那一对：用 norad 对 + TCA 做键，翻页 / 重载后仍能高亮 */
const pickedKey = ref('')

/** 点击某一对交会事件：高亮该项，并上报给 index.vue 让 BaseScene 绘制这 2 颗卫星的轨道线与 TCA 目标模型 */
function pickRow(r: ListRow) {
  pickedKey.value = r.key
  if (ephTab.value) {
    const hit = ephPicks.get(r.key)
    if (hit) emit('pick-ephem', { setId: hit.setId, event: hit.event })
    return
  }
  emit('select', { norad_a: r.norad_a, norad_b: r.norad_b, tca: r.tca })
}

/* ---- 智能体联动：打开面板后自动选中第一条（交会 / 碰撞问题 → 直接展示第一条交会信息） ---- */
/** 待选中标记：外部触发后置 true，列表就绪并选中第一条（或确认无数据）后清掉 */
const awaitingFirst = ref(false)
/** 已处理过的触发计数（本组件常驻挂载，避免重挂载时重复触发同一个 tick） */
let autoSelectHandledTick = 0
/** 是否已成功加载过一次列表（未加载过则先等 loadList 完成，避免用旧数据误选） */
const loadedOnce = ref(false)

/** 列表就绪后选中第一条并上报；无数据则什么都不做 —— 只停在页面（符合「没有交会事件也定位到该页」） */
function tryAutoSelectFirst() {
  if (!awaitingFirst.value || listLoading.value || !loadedOnce.value) return
  awaitingFirst.value = false
  const first = rows.value[0]
  if (first) pickRow(first)
}

/** 外部触发入口：autoSelectTick 比上次处理的大即标记待选（并尝试立即选中，如列表已就绪）。
 *  交会 / 碰撞类问题：目标卫星已由 index.vue 写入 heatFocusNorad（动作显式 norad 或当前选中星）。
 *  · 若 dockMode 刚切到 heat，上面的 watch 已消费它并触发重载，这里只需等加载完成再选中第一条；
 *  · 若面板本就开着（dockMode 未变化，watch 不触发），这里补一次「过滤 + 重载」，
 *    否则会选中旧列表的第一条（即用户反馈的「定位到了别的卫星上」）。 */
function armAutoSelect() {
  if (props.autoSelectTick > autoSelectHandledTick) {
    autoSelectHandledTick = props.autoSelectTick
    awaitingFirst.value = true
    if (applyFocusNorad()) {
      query.page = 1
      loadList()
      return
    }
    tryAutoSelectFirst()
  }
}
watch(() => props.autoSelectTick, armAutoSelect)
onMounted(armAutoSelect)

function close() {
  emit('close')
}
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'heat'" class="side-panel heat-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">安全热力图</b>
          <span class="sp-count">{{ (ephTab ? ephCount : heatList.length).toLocaleString() }} 个事件</span>
        </div>
        <!-- 收起按钮：向下三角（与太空安全目标列表的三角收起键同款矢量图标） -->
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起热力图" @click="close">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 3.1 L8.4 3.1 L5 7.1 Z" /></svg>
        </button>
      </div>

      <!-- 来源页签：后端三种热力来源 + 本机星历事件（我的星历只切换下方列表，不改三维热力） -->
      <div class="heat-src">
        <button v-for="s in HEAT_SOURCES" :key="s.key" class="hs-btn"
          :class="{ on: !ephTab && heatSource === s.key }" @click="pickSource(s.key)">{{ s.label }}</button>
        <button class="hs-btn is-eph" :class="{ on: ephTab }" @click="openEphTab">我的星历</button>
      </div>

      <!-- P3 筛选条：时间窗（heatDays）/ 高度层 / 指标阈值 + 按天柱状图。
           时间窗改动会触发 BaseScene.loadHeat 重新拉取；高度层与阈值只作用于 heatFiltered（前端过滤） -->
      <div v-if="!ephTab" class="heat-filter">
        <div class="hf-row">
          <span class="hf-label">时间窗</span>
          <div class="hf-seg">
            <button v-for="o in dayOptions" :key="o.v" class="hf-btn"
              :class="{ on: activeDay === o.v }" @click="heatDays = o.v">{{ o.label }}</button>
          </div>
        </div>
        <div class="hf-row">
          <span class="hf-label">高度层</span>
          <div class="hf-seg">
            <button v-for="o in ALT_OPTIONS" :key="o.v" class="hf-btn"
              :class="{ on: heatAltBand === o.v }" @click="heatAltBand = o.v">{{ o.label }}</button>
          </div>
        </div>
        <div class="hf-row">
          <span class="hf-label">指标</span>
          <div class="hf-seg">
            <button v-for="o in METRIC_OPTIONS" :key="o.v" class="hf-btn"
              :class="{ on: heatMetric === o.v }" @click="heatMetric = o.v">{{ o.label }}</button>
          </div>
          <span class="hf-val">{{ thresholdText }}</span>
        </div>
        <div class="hf-row">
          <span class="hf-label">阈值</span>
          <input v-model.number="sliderVal" class="hf-range" type="range" min="0" max="100" step="1" />
        </div>
        <div v-if="heatSource !== 'eph-aoe'" class="hf-row">
          <span class="hf-label">聚合格边</span>
          <div class="hf-seg">
            <button v-for="o in HEAT_CELL_OPTIONS" :key="o.v" class="hf-btn"
              :class="{ on: heatCell === o.v }" @click="heatCell = o.v">{{ o.label }}</button>
          </div>
          <span class="hf-val">{{ heatCell.toFixed(2) }}</span>
        </div>
        <div class="hf-count">
          三维显示 <b>{{ heatFiltered.length.toLocaleString() }}</b> /
          {{ heatList.length.toLocaleString() }} 个事件
          <span v-if="altUnavailable" class="hf-warn">· 官方 CDM 无高度数据</span>
        </div>
        <!-- 星历热力：本机联算进度 / 无星历提示（不落后端，进度来自 Worker 两阶段回传） -->
        <div v-if="heatSource === 'eph-aoe' && heatEphStatus.state !== 'idle'" class="hf-count">
          <template v-if="heatEphStatus.state === 'running'">
            AOE 点云 × 精密星历联算中 {{ Math.round(heatEphStatus.p * 100) }}%
            <span class="hf-warn">· {{ heatEphStatus.text }}</span>
          </template>
          <span v-else class="hf-warn">{{ heatEphStatus.text }}</span>
        </div>
        <!-- 按天柱状图：后端 day_groups（仅时间窗 > 0 下发），点柱切到该天，点「全」回到总览 -->
        <div v-if="dayBars.length" class="hf-days">
          <button class="hf-day" :class="{ on: heatDay === -1 }" @click="heatDay = -1">全</button>
          <div class="hf-bars">
            <button v-for="d in dayBars" :key="d.day" class="hf-bar"
              :class="{ on: heatDay === d.day }" :title="`${d.date} · ${d.count} 个事件`"
              @click="heatDay = d.day">
              <i :style="{ height: barHeight(d.count) }"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- 数据批次（总库）：交会热力 / 交会分析热力来源展示（各自独立批次表）；回看历史「全体 × 全体」全量扫描批次。
           主从计算 / 配对标注批次属后台分析工具，不进前台，故此处只列全量批次；CDM 热力无批次概念，不展示 -->
      <div v-if="!ephTab && heatSource !== 'spacetrack' && heatSource !== 'eph-aoe'" class="heat-batch">
        <span class="heat-batch-label">数据批次</span>
        <select class="heat-batch-sel" :value="heatBatchRunId ?? ''" @change="onBatchChange">
          <option v-if="!batchOptions.length" value="" disabled>暂无全量批次</option>
          <option v-for="b in batchOptions" :key="b.id" :value="b.id">{{ b.label }}</option>
        </select>
      </div>

      <!-- 配色图例：档位 / 配色 / 阈值文案全部由后端按当前来源口径下发，前端直接渲染。
           每一行可勾选：取消勾选即隐藏该档位在三维热力视图中的事件（按配色匹配），只影响渲染不影响列表数据 -->
      <div v-if="!ephTab" class="heat-scale">
        <div class="heat-scale-title">{{ heatMetricLabel || '指标' }}</div>
        <label
          v-for="s in legendRows"
          :key="s.label"
          class="heat-scale-row"
          :class="{ off: heatHiddenColors.has(s.color) }"
          :title="heatHiddenColors.has(s.color) ? '勾选以显示该档位事件' : '取消勾选以隐藏该档位事件'"
        >
          <input
            class="hs-check"
            type="checkbox"
            :checked="!heatHiddenColors.has(s.color)"
            @change="toggleLegend(s.color)"
          />
          <span class="hs-dot" :style="{ background: s.color }"></span>
          <span class="hs-label">{{ s.label }}</span>
          <span class="hs-thresh">{{ s.thresh }}</span>
        </label>
      </div>

      <div v-if="!ephTab && heatError" class="heat-err">{{ heatError }}</div>
      <div v-else-if="!ephTab && !heatLoading && !heatList.length" class="heat-none">暂无碰撞事件</div>

      <!-- 交会数据列表：三种来源共用（local 取「总交会库」当前批次明细，cri 取交会分析库当前批次明细，
           CDM 取 sat_cdm 库表明细）。检索：关键词（NORAD / 名称）+ 接近日期范围；等级下拉仅批次来源
           （local / cri）有（CDM 按碰撞概率分级，风险文案与配色由后端下发直接渲染）。
           与上方「数据批次」下拉（local / cri 联动，CDM 无批次）联动。 -->
      <div class="heat-conj">
        <div class="hc-head">
          <b class="hc-title">{{ listTitle }}</b>
          <span class="hc-total">{{ total.toLocaleString() }} 条</span>
        </div>

        <div class="hc-search">
          <input
            v-model="query.keyword"
            class="hc-input"
            type="text"
            placeholder="NORAD 编号或名称"
            @keyup.enter="search"
          />
          <select v-if="!ephTab && heatSource !== 'spacetrack'" v-model="query.level" class="hc-sel">
            <option value="">全部等级</option>
            <option value="danger">高危</option>
            <option value="warning">警告</option>
            <option value="info">关注</option>
          </select>
          <div class="hc-dates">
            <input v-model="query.dateFrom" class="hc-date" type="date" title="接近日期从" />
            <span class="hc-date-sep">~</span>
            <input v-model="query.dateTo" class="hc-date" type="date" title="接近日期至" />
          </div>
          <div class="hc-btns">
            <button class="hc-btn is-primary" :disabled="listLoading" @click="search">查询</button>
            <button class="hc-btn" :disabled="listLoading" @click="resetSearch">重置</button>
          </div>
        </div>

        <div ref="listEl" class="hc-list" @scroll.passive="onListScroll">
          <div v-if="listLoadingHint" class="hc-empty">加载中…</div>
          <div v-else-if="listError" class="hc-empty is-err">{{ listError }}</div>
          <!-- 未超时的加载中：保留上一次结果、不闪「暂无」（正常毫秒级返回，这个分支几乎不可见） -->
          <div v-else-if="!listLoading && !rows.length" class="hc-empty">{{ ephTab
            ? '本机暂无星历筛选结果'
            : heatSource === 'eph-aoe' ? (heatEphStatus.state === 'running' ? '联算中…' : '暂无接近事件') : '暂无交会数据' }}</div>
          <template v-else>
            <!-- 虚拟滚动：上方占位 -->
            <div v-if="virtOn && padTop" :style="{ height: padTop + 'px' }"></div>
            <div
              v-for="r in visibleRows"
              :key="r.key"
              class="hc-item"
              :class="{ on: pickedKey === r.key }"
              title="点击绘制这一对卫星的轨道与目标模型"
              @click="pickRow(r)"
            >
              <div class="hc-item-top">
                <span class="hc-names" :title="`${r.name_a} × ${r.name_b}`">
                  {{ r.name_a }} × {{ r.name_b }}
                </span>
                <span class="hc-dist" :style="{ color: r.color }">{{ fmtNum(r.dist, 3) }} km</span>
              </div>
              <div class="hc-item-sub">
                <span class="hc-tca">{{ fmtTca(r.tca) }}</span>
                <span class="hc-dot" :style="{ background: r.color }"></span>
                <span class="hc-level">{{ r.label }}</span>
              </div>
            </div>
            <!-- 虚拟滚动：下方占位 -->
            <div v-if="virtOn && padBottom" :style="{ height: padBottom + 'px' }"></div>
          </template>
        </div>

        <div v-if="!ephTab && heatSource !== 'eph-aoe'" class="hc-pager">
          <select v-model.number="query.pageSize" class="hc-sel" title="每页条数" @change="search">
            <option :value="20">20 条/页</option>
            <option :value="100">100 条/页</option>
            <option :value="200">200 条/页</option>
          </select>
          <button class="hc-btn" :disabled="query.page <= 1 || listLoading" @click="goPage(query.page - 1)">上一页</button>
          <span class="hc-page">{{ query.page }} / {{ maxPage }}</span>
          <button class="hc-btn" :disabled="query.page >= maxPage || listLoading" @click="goPage(query.page + 1)">下一页</button>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 碰撞热力面板内容较短，高度自适应内容即可，不必像列表面板那样撑满整屏（覆盖 .side-panel 的 height:100%） */
.heat-panel {
  height: auto;
}

/* 桌面端：热力面板改为底部居中卡片，位置与尺寸对齐「专家」弹窗（.ai-glass.docked .ag-card）：
   width min(560px, 94vw)、max-height min(62vh, 520px)、底边浮在底部「按钮栏 + 时间条」之上。 */
@media (min-width: 769px) {
  .side-panel.heat-panel {
    top: auto;
    left: 50%;
    right: auto;
    bottom: calc(122px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    width: min(560px, 94vw);
    height: auto;
    max-height: min(62vh, 520px);
    z-index: 8;
    /* 卡片高度受限后内容整体滚动（筛选条 / 图例 / 列表都能滚到），避免溢出卡片外 */
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 16px;
    border-color: rgba(127, 216, 255, 0.18);
    background: linear-gradient(180deg, rgba(22, 30, 44, 0.88), rgba(13, 19, 30, 0.92));
    backdrop-filter: blur(22px) saturate(1.3);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 24px 60px rgba(0, 0, 0, 0.55);
  }
  /* 过渡：底部卡片改为「自下浮起 + 淡入」，覆盖默认的从左滑入（translateX(-100%)） */
  .heat-panel.panel-enter-active,
  .heat-panel.panel-leave-active { transition: transform 0.24s ease, opacity 0.24s ease; }
  .heat-panel.panel-enter-from,
  .heat-panel.panel-leave-to {
    transform: translateX(-50%) translateY(14px);
    opacity: 0;
  }
}

/* ---------------- 来源页签：三种后端热力来源 + 我的星历 ---------------- */
.heat-src {
  display: flex;
  gap: 4px;
  padding: 2px 0 8px;
  pointer-events: auto;

  .hs-btn {
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 0 4px;
    border: 1px solid rgba(120, 165, 225, 0.28);
    border-radius: 4px;
    background: rgba(18, 34, 58, 0.55);
    color: #a7b6cc;
    font-size: 11.5px;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;

    &:hover { color: #d7e6fb; border-color: rgba(120, 165, 225, 0.5); }
    &.on {
      color: #eaf4ff;
      border-color: #4c9aff;
      background: rgba(38, 92, 156, 0.75);
    }
    /* 我的星历：与后端来源用描边区分（本机数据，不请求后端） */
    &.is-eph { border-style: dashed; }
    &.is-eph.on { border-style: solid; }
  }
}

/* ---------------- P3 筛选条：时间窗 / 高度层 / 指标 / 阈值 / 按天柱状图 ---------------- */
.heat-filter {
  padding: 2px 0 10px;
  /* 面板整体 pointer-events:none（空白区域穿透拾取卫星），筛选控件必须恢复事件 */
  pointer-events: auto;

  .hf-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .hf-label {
    flex: 0 0 42px;
    font-size: 12px;
    color: #a7b6cc;
    white-space: nowrap;
  }

  /* 分段按钮组：等分剩余宽度，选中项高亮为主题蓝 */
  .hf-seg {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 2px;
  }

  .hf-btn {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 2px;
    font-size: 11px;
    line-height: 22px;
    text-align: center;
    white-space: nowrap;
    border-radius: 5px;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(120, 160, 220, 0.22);
    color: #a7b6cc;
    transition: all 0.15s ease;
    &:hover { background: rgba(255, 255, 255, 0.12); color: #e6edf7; }
    &.on {
      background: rgba(79, 195, 247, 0.2);
      border-color: rgba(79, 195, 247, 0.6);
      color: #8fe2ff;
    }
  }

  .hf-val {
    flex: 0 0 auto;
    font-size: 11px;
    color: #7fd8ff;
    white-space: nowrap;
  }

  /* 阈值滑杆：原生 range，用 accent-color 贴合深色主题 */
  .hf-range {
    flex: 1;
    min-width: 0;
    height: 16px;
    margin: 0;
    accent-color: #4fc3f7;
    cursor: pointer;
  }

  .hf-count {
    font-size: 11px;
    color: #8b9bb5;
    b { color: #8fe2ff; font-weight: 700; }
    .hf-warn { color: #ffb454; }
  }

  /* 按天柱状图（纯 SVG 不必要，这里用 flex 柱高百分比实现，点击切天） */
  .hf-days {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-top: 8px;
    height: 46px;
  }

  .hf-day {
    flex: none;
    height: 20px;
    padding: 0 7px;
    font-size: 11px;
    line-height: 18px;
    border-radius: 5px;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(120, 160, 220, 0.22);
    color: #a7b6cc;
    &.on { background: rgba(79, 195, 247, 0.2); border-color: rgba(79, 195, 247, 0.6); color: #8fe2ff; }
  }

  .hf-bars {
    display: flex;
    flex: 1;
    align-items: flex-end;
    gap: 2px;
    height: 100%;
    min-width: 0;
  }

  .hf-bar {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 1px;
    display: flex;
    align-items: flex-end;
    background: none;
    border: none;
    cursor: pointer;
    i {
      display: block;
      width: 100%;
      border-radius: 2px 2px 0 0;
      background: rgba(127, 176, 255, 0.45);
      transition: height 0.2s ease, background 0.15s ease;
    }
    &:hover i { background: rgba(143, 226, 255, 0.8); }
    &.on i { background: #4fc3f7; }
  }
}

.heat-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0 10px;
  /* 面板整体 pointer-events:none（空白区域穿透拾取卫星），交互控件必须恢复事件，否则下拉点不动 */
  pointer-events: auto;
  .heat-batch-label {
    font-size: 12px;
    /* 面板为深色底：这里不能依赖未定义的 CSS 变量，直接给可读的次级文字色 */
    color: #a7b6cc;
    white-space: nowrap;
  }
  .heat-batch-sel {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    font-size: 12px;
    border-radius: 6px;
    /* 不透明深底 + 深色配色方案：避免半透明背景透出亮色地图导致选中项文字看不清 */
    background: rgba(20, 28, 44, 0.96);
    border: 1px solid rgba(120, 160, 220, 0.28);
    color: #e6edf7;
    color-scheme: dark;
    cursor: pointer;
    &:focus {
      outline: none;
      border-color: var(--heat, #ff4d4f);
    }
    option {
      background: #1b2130;
      color: #e6edf7;
    }
  }
}

.heat-scale {
  padding: 10px 0 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  /* 面板整体 pointer-events:none（空白区域穿透拾取卫星），图例要能点勾选框，必须恢复事件 */
  pointer-events: auto;
  .heat-scale-title {
    font-size: 12px;
    /* 同上：深色底下用固定次级文字色，避免 undefined 变量导致文字发虚 */
    color: #a7b6cc;
    margin-bottom: 8px;
  }
  .heat-scale-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    /* 勾选框：浏览器原生控件，用 accent-color 贴合深色主题 */
    .hs-check {
      flex: none;
      width: 13px;
      height: 13px;
      margin: 0;
      cursor: pointer;
      accent-color: #4fc3f7;
    }
    .hs-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .hs-label {
      font-size: 12px;
      color: #d8e2f0;
      flex: 1;
    }
    .hs-thresh {
      font-size: 11px;
      /* 阈值文案此前用未定义变量导致发虚：给深色底上可读的次级色 */
      color: #a7b6cc;
    }
    &:hover .hs-label { color: #fff; }
    /* 已取消勾选（该档位事件不参与三维渲染）：整体弱化提示 */
    &.off {
      .hs-dot { opacity: 0.3; }
      .hs-label, .hs-thresh { opacity: 0.45; }
    }
  }
}

.heat-err {
  margin-top: 10px;
  font-size: 12px;
  color: #ff8a80;
}

.heat-none {
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: #7d8ba3;
}

/* ---------------- 本批次交会数据（检索 + 列表） ---------------- */

.heat-conj {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 面板整体 pointer-events:none（空白穿透拾取），数据区必须恢复事件才能输入 / 滚动 / 点按钮 */
  pointer-events: auto;

  .hc-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;

    .hc-title {
      font-size: 12px;
      font-weight: 700;
      color: #cfdcea;
    }
    .hc-total {
      font-size: 11px;
      color: #7fb0ff;
      white-space: nowrap;
    }
  }

  /* 检索区：关键词 / 等级 / 日期范围 / 查询重置，两行紧凑排布 */
  .hc-search {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }

  .hc-input,
  .hc-sel,
  .hc-date {
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    border-radius: 6px;
    /* 不透明深底 + 深色配色方案：避免半透明背景透出亮色地图导致文字看不清 */
    background: rgba(20, 28, 44, 0.96);
    border: 1px solid rgba(120, 160, 220, 0.28);
    color: #e6edf7;
    color-scheme: dark;
    outline: none;
    box-sizing: border-box;
    &:focus { border-color: #4fc3f7; }
  }

  .hc-input {
    flex: 1 1 120px;
    min-width: 0;
    &::placeholder { color: #7d8ba3; }
  }

  .hc-sel {
    flex: 0 0 88px;
    cursor: pointer;
    option { background: #1b2130; color: #e6edf7; }
  }

  .hc-dates {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 190px;
    min-width: 0;

    .hc-date { flex: 1 1 0; min-width: 0; cursor: pointer; }
    .hc-date-sep { color: #7d8ba3; font-size: 11px; flex: none; }
  }

  .hc-btns {
    display: flex;
    gap: 6px;
    flex: none;
  }

  .hc-btn {
    height: 28px;
    padding: 0 12px;
    font-size: 12px;
    border-radius: 6px;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(120, 160, 220, 0.28);
    color: #cfdcea;
    transition: all 0.15s ease;
    &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); color: #e6edf7; }
    &.is-primary {
      background: rgba(79, 195, 247, 0.18);
      border-color: rgba(79, 195, 247, 0.5);
      color: #7fd8ff;
      &:hover:not(:disabled) { background: rgba(79, 195, 247, 0.28); }
    }
    &:disabled { opacity: 0.4; cursor: not-allowed; }
  }

  /* 列表：面板高度自适应内容，故用 max-height 限高并内部滚动，避免撑出屏幕 */
  .hc-list {
    flex: 1 1 auto;
    min-height: 0;
    max-height: min(46vh, 420px);
    overflow-y: auto;
    overscroll-behavior: contain;
    &::-webkit-scrollbar { width: 6px; }
    &::-webkit-scrollbar-thumb { background: rgba(120, 160, 220, 0.3); border-radius: 3px; }
  }

  .hc-empty {
    padding: 20px 0;
    text-align: center;
    font-size: 12px;
    color: #7d8ba3;
    &.is-err { color: #ff8a80; }
  }

  .hc-item {
    padding: 7px 8px;
    margin-bottom: 4px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;

    &:hover {
      background: rgba(55, 194, 255, 0.1);
      border-color: rgba(55, 194, 255, 0.35);
    }

    &.on {
      background: rgba(55, 194, 255, 0.16);
      border-color: rgba(55, 194, 255, 0.6);
    }

    .hc-item-top {
      display: flex;
      align-items: center;
      gap: 8px;

      .hc-names {
        flex: 1;
        min-width: 0;
        font-size: 12px;
        color: #e6edf6;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hc-dist {
        flex: none;
        font-size: 12px;
        font-weight: 700;
        font-family: 'Consolas', 'Menlo', monospace;
        /* 具体颜色由行数据下发（等级档 / 碰撞概率分档）内联覆盖 */
        color: #93a4bd;
      }
    }

    .hc-item-sub {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      font-size: 11px;
      color: #7d8ba3;

      .hc-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex: none;
        /* 具体颜色由行数据下发内联覆盖 */
        background: #93a4bd;
      }
      .hc-level { color: #93a4bd; }
    }
  }

  .hc-pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding-top: 8px;

    .hc-page {
      font-size: 12px;
      color: #93a4bd;
      font-family: 'Consolas', 'Menlo', monospace;
    }
  }
}

html.is-mobile {
  /* 移动端面板改为底部抽屉（见 index.scss），抽屉本身就是滚动容器：
     热力面板内容较长（批次 + 图例 + 检索 + 列表 + 分页），此处取消列表内部限高，
     整体交由抽屉滚动，避免「抽屉 + 列表」双层滚动互相打架 */
  .heat-conj .hc-list { max-height: none; overflow: visible; }
  .heat-conj .hc-input { flex: 1 1 100%; }
  /* 批次下拉：空间压到极致 */
  .heat-batch {
    padding: 3px 0 6px;
    .heat-batch-label { font-size: 11px; }
    .heat-batch-sel { padding: 5px 6px; font-size: 11.5px; }
  }
  /* 配色图例：行距与勾选框一起收窄到「能看清即可」 */
  .heat-scale {
    padding: 4px 0 6px;
    .heat-scale-title { font-size: 10.5px; margin-bottom: 4px; }
    .heat-scale-row {
      padding: 2px 0; margin-bottom: 1px;
      .hs-check { width: 13px; height: 13px; }
      .hs-dot { width: 11px; height: 11px; }
      .hs-label { font-size: 11px; }
      .hs-thresh { font-size: 10px; }
    }
  }
  /* 检索控件：与抽屉内控件（列表条目 / sp-input）同一尺度，压到 26px / 11.5px，避免偏大 */
  .heat-conj .hc-input,
  .heat-conj .hc-sel,
  .heat-conj .hc-date { height: 26px; font-size: 11.5px; }
  .heat-conj .hc-btn { height: 26px; padding: 0 10px; font-size: 11.5px; }
  .heat-conj .hc-pager { padding-top: 6px; }
  /* 交会列表项：行高与间距压到极致（≈32-34px） */
  .heat-conj .hc-item {
    padding: 5px 7px; margin-bottom: 3px; border-radius: 7px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(120,160,220,0.12);
    .hc-item-top .hc-names { font-size: 11.5px; }
    .hc-item-top .hc-dist { font-size: 11px; }
    .hc-item-sub { margin-top: 2px; font-size: 9.5px; }
    &.on { background: rgba(55,194,255,0.18); border-color: rgba(55,194,255,0.6); }
  }

  /* 宽屏移动端（平板 / 大屏 Pad / 手机横屏，宽度 ≥600px）：
     抽屉此刻横跨整屏，若仍让关键词输入框独占一整行（flex 1 1 100%）、交会列表单列铺排，
     输入框会被拉成长条，交会条目被拉长且右侧大片留白。此处只用 CSS 重排、不新增任何高度：
     ① 关键词输入框回到与「等级 / 日期范围 / 查询」同一行的常规宽度；
     ② 交会列表改自适应多列网格（一排多个），同样高度内可见条目数成倍增加。 */
  @media (min-width: 600px) {
    .heat-conj {
      .hc-input { flex: 1 1 220px; }
      .hc-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 4px;
        align-content: start;
        .hc-empty { grid-column: 1 / -1; }
        .hc-item { margin-bottom: 0; }
      }
    }
  }
}

/* 桌面端：固定行高，供虚拟滚动按固定步长计算占位高度（移动端保持压缩行高，不启用虚拟滚动） */
@media (min-width: 769px) {
  .heat-panel .hc-item { height: 58px; box-sizing: border-box; }
  /* 底部居中面板本身是 flex 列且 max-height 受限：.hc-list 若沿用 flex:1 1 auto + min-height:0
     会被压缩到 0 高（列表塌陷、分页条盖住首行），故改为固定高度、不参与收缩。 */
  .heat-panel .hc-list {
    flex: 0 0 auto;
    height: min(40vh, 330px);
    max-height: none;
  }
}
</style>
