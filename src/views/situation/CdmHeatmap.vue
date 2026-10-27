<script setup lang="ts">
/**
 * 星座总览 /situation 安全热力面板（03 §11 布局）
 *
 * 面板只保留：两个标签、数据时效、时间窗（24h/3d/7d）、按天柱、等级芯片、事件列表 + 搜索。
 * 已删除：高度层、指标、阈值滑杆、聚合格边、数据批次、日期区间、底部红字。
 *
 * 两个标签共用同一套 Pc 分级（heat/riskLevels.ts，档位可由 /cgi2/meta 覆盖）：
 *  - 卫星轨道威胁事件：TLE×TLE 初筛，heat-sidecar 的 /cgi2/heat/*（核心未就绪时显示灰色空状态卡）；
 *  - 卫星轨道威胁事件（星历增强）：精密星历×TLE，同一算法，协方差更紧。
 * 计数、柱状图、芯片计数全部取自当前来源；未就绪时统一显示 "—"，避免串用上一个标签的旧数字。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  HEAT_SOURCES, heatSource,
  heatList, heatHiddenColors, heatLoading,
  heatStatus, heatUnavailableReason, heatPrimaryFilter,
  dockMode, heatFocusNorad, fmtNum,
  heatDays, heatDay, heatDayGroups,
  drawerHeightVh, isDrawerDragging, useDrawerDrag,
  type HeatSource
} from './scene'
import { levelOfPc, type HeatLevel } from './heat/riskLevels'
import { colorForLevel, labelForLevel, loadHeatLevels } from './heat/levels'
import HeatLevelChips from './heat/HeatLevelChips.vue'
import { useDevice } from '@/composables/useDevice'
import {
  getHeat2SyncStatus, listHeat2,
  type Heat2ListItem, type Heat2SyncStatus
} from '@/api/heat2'
import { ephemLabel } from './ephem/useUserEphemeris'
import { focusThreat, threatFocus } from './threatLink'
import { useDelayed } from '@/composables/useDelayed'
import HeatEmptyState from './HeatEmptyState.vue'

const emit = defineEmits<{
  (e: 'close'): void
  /** 点击列表某一对：上报其 norad 对 + TCA，由父组件让 BaseScene 绘制 2 条轨道 + 目标模型 */
  (e: 'select', pair: { norad_a: number; norad_b: number; tca: string }): void
  /** 请求父组件打开星历分析窗并聚焦该主星（03 §15.5） */
  (e: 'open-ephem', payload: { norad: number; name: string }): void
  /** 服务不可用时点「重试」：父组件清掉 sidecar 健康缓存并重新拉取（03 §11.5） */
  (e: 'retry'): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 智能体联动：open_panel(heat, selectFirst=true) 打开面板后，外部通过 autoSelectTick 递增触发「自动选中第一条」 */
const props = withDefaults(defineProps<{ autoSelectTick?: number }>(), { autoSelectTick: 0 })

/** 移动端判定（虚拟滚动仅桌面端启用） */
const { isMobile } = useDevice()

/* ============================================================
 * 等级档位：与星历分析窗共用 heat/levels.ts（/cgi2/meta 覆盖文案与颜色）
 * ============================================================ */

/** 等级 → 颜色（按 meta 覆盖后的档位） */
function colorFor(lv: HeatLevel | null): string {
  return colorForLevel(lv)
}

/** 时间窗只保留 24h / 3d / 7d，默认 7d */
const DAY_OPTIONS = [
  { v: 1, label: '24h' }, { v: 3, label: '3d' }, { v: 7, label: '7d' }
]
const dayOptions = DAY_OPTIONS

/* ============================================================
 * 来源状态与计数（03 §11.5）
 * ============================================================ */
const status = computed(() => heatStatus[heatSource.value])
const isUnavailable = computed(() => status.value === 'unavailable')
const isReady = computed(() => status.value === 'ready' || status.value === 'empty')
const countText = computed(() => (isReady.value ? `${heatList.value.length} 个事件` : '—'))
const headSub = computed(() => {
  const label = heatSource.value === 'tle-threat' ? 'TLE 初筛' : '星历增强'
  return `${label} · 未来 ${heatDays.value} 天 · ${countText.value}`
})

/** 每个来源一个就绪圆点（绿 = 就绪，灰 = 加载中 / 不可用） */
function srcDot(k: HeatSource): string {
  const s = heatStatus[k]
  if (s === 'ready' || s === 'empty') return '#4fd18b'
  if (s === 'loading') return '#f2c14e'
  return '#5d6b80'
}
function srcTitle(k: HeatSource): string {
  const s = heatStatus[k]
  if (s === 'ready' || s === 'empty') return '该来源已就绪'
  if (s === 'loading') return '正在加载'
  if (s === 'unavailable') return '服务未就绪'
  return '尚未加载'
}

/* ============================================================
 * 按天柱状图：固定 7 天（后端按窗口补齐 0 事件天），点击筛选当天，再点取消
 * ============================================================ */
const dayBars = computed(() => heatDayGroups.value)
const maxDayCount = computed(() => Math.max(1, ...dayBars.value.map((d) => d.count)))
function barHeight(count: number) {
  if (!count) return '3px'
  return `${Math.max(8, Math.round((count / maxDayCount.value) * 100))}%`
}
function toggleDay(day: number) {
  heatDay.value = heatDay.value === day ? -1 : day
}

/* ============================================================
 * 等级芯片：图例 + 显隐 + 计数（两个标签共用，含「数据不足」）
 * ============================================================ */
const levelCounts = computed<Record<HeatLevel, number>>(() => {
  const out: Record<HeatLevel, number> = { red: 0, orange: 0, yellow: 0, insufficient: 0 }
  if (!isReady.value) return out
  for (const e of heatList.value) {
    const lv = levelOfPc(e.collision_probability, e.pc_max)
    if (lv) out[lv] += 1
  }
  return out
})
/** 已隐藏档位的配色（传给 HeatLevelChips 做置灰） */
const offColors = computed(() => [...heatHiddenColors])
function toggleChip(lv: HeatLevel) {
  const c = colorFor(lv)
  if (heatHiddenColors.has(c)) heatHiddenColors.delete(c)
  else heatHiddenColors.add(c)
}

/* ============================================================
 * 数据时效条：一行摘要 + 展开明细（/cgi2/sync/status）
 * ============================================================ */
const freshOpen = ref(false)
const freshList = ref<Heat2SyncStatus[]>([])
const freshDown = ref(false)
const freshLoading = ref(false)

/** 后端 UTC 'YYYY-MM-DD HH:mm:ss' → UTC+8 'MM-DD HH:mm' */
function fmtBj(utc?: string | null): string {
  if (!utc) return '—'
  const ms = Date.parse(`${String(utc).replace(' ', 'T')}Z`)
  if (!Number.isFinite(ms)) return String(utc)
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

const STATE_COLOR: Record<string, string> = { ok: '#4fd18b', stale: '#f2c14e', error: '#e8453c', skipped: '#93a4bd' }
const STATE_LABEL: Record<string, string> = { ok: '正常', stale: '待更新', error: '失败', skipped: '未配置' }

function srcOf(source: string): Heat2SyncStatus | undefined {
  return freshList.value.find((s) => s.source === source)
}

/** 当前标签对应的主数据源：左签看 TLE 同步时效，右签看星历生成时效 */
const primaryFreshKey = computed(() => (heatSource.value === 'tle-threat' ? 'gp' : 'eph'))
const primaryFresh = computed(() => srcOf(primaryFreshKey.value))

/** 一行摘要：TLE 同步 … · 每 N 小时；星历生成 … · 每 48 小时 */
const freshLine = computed(() => {
  if (freshDown.value) return '服务未连接'
  const key = primaryFreshKey.value
  const s = srcOf(key)
  if (!s) return '读取中…'
  const bits = key === 'gp'
    ? [`TLE 同步 ${fmtBj(s.last_success_at)}（UTC+8）`]
    : [`星历生成 ${fmtBj(s.generated_at ?? s.last_success_at)}（UTC+8）`]
  if (s.rows) bits.push(`${s.rows} 份`)
  bits.push(s.interval_hours ? `每 ${s.interval_hours} 小时` : '每 2 天')
  return bits.join(' · ')
})

const freshRows = computed(() => {
  const out: { label: string; text: string; color: string }[] = []
  const eph = srcOf('eph')
  if (eph) {
    out.push({
      label: '精密星历',
      color: STATE_COLOR[eph.state] ?? '#93a4bd',
      text: eph.rows ? `${eph.rows} 份 · 生成 ${fmtBj(eph.generated_at)}（UTC+8）` : '无星历文件'
    })
  }
  const gp = srcOf('gp')
  if (gp) {
    const bits: string[] = []
    if (gp.median_age_hours != null) bits.push(`龄期中位 ${gp.median_age_hours.toFixed(1)} h`)
    if (gp.last_success_at) bits.push(`同步 ${fmtBj(gp.last_success_at)}`)
    bits.push(STATE_LABEL[gp.state] ?? gp.state)
    out.push({ label: 'TLE 根数', color: STATE_COLOR[gp.state] ?? '#93a4bd', text: bits.join(' · ') })
  }
  return out
})

async function loadFresh() {
  freshLoading.value = true
  try {
    const res = await getHeat2SyncStatus()
    freshList.value = res.list || []
    freshDown.value = false
  } catch {
    freshDown.value = true
    freshList.value = []
  } finally {
    freshLoading.value = false
  }
}

/* ============================================================
 * 事件列表（三个标签共用）
 * ============================================================ */
interface ListRow {
  key: string
  id?: number | string
  norad_a: number
  norad_b: number
  tca: string
  name_a: string
  name_b: string
  miss: number
  pc: number
  level: HeatLevel | null
  color: string
}

function toRow(r: {
  id?: number | string
  norad_a: number; norad_b: number; tca: string
  name_a: string; name_b: string; miss: number; pc: number; pcMax?: number
}): ListRow {
  const lv = levelOfPc(r.pc, r.pcMax)
  return {
    key: `${r.norad_a}-${r.norad_b}-${r.tca}`,
    id: r.id,
    norad_a: r.norad_a,
    norad_b: r.norad_b,
    tca: r.tca,
    name_a: r.name_a || `NORAD ${r.norad_a}`,
    name_b: r.name_b || `NORAD ${r.norad_b}`,
    miss: r.miss,
    pc: r.pc,
    level: lv,
    color: colorFor(lv)
  }
}

function toHeat2Row(r: Heat2ListItem): ListRow {
  return toRow({
    id: r.id,
    norad_a: r.norad_a, norad_b: r.norad_b, tca: r.tca,
    name_a: r.name_a, name_b: r.name_b,
    miss: r.miss_distance_km, pc: r.collision_probability, pcMax: r.pc_max
  })
}

const rows = ref<ListRow[]>([])
const total = ref(0)
const listLoading = ref(false)
const listLoadingHint = useDelayed(listLoading)
const listError = ref('')
const query = reactive({ page: 1, pageSize: 20, keyword: '', level: '' })
const maxPage = computed(() => Math.max(1, Math.ceil(total.value / query.pageSize)))

/* ---- 列表虚拟滚动（大页全量渲染会拖慢面板滚动） ---- */
const ROW_H = 62
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
function resetListScroll() {
  listScrollTop.value = 0
  if (listEl.value) listEl.value.scrollTop = 0
}

/** Unix ms → 'YYYY-MM-DD HH:mm:ss'(UTC)，用作列表接口的时间窗参数 */
function utcParam(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** TCA 统一解析：兼容 'YYYY-MM-DD HH:mm:ss'(UTC) 与 ISO 'YYYY-MM-DDTHH:mm:ss.sssZ' */
function parseTcaMs(tca?: string): number {
  if (!tca) return NaN
  const s = String(tca).trim()
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}T/.test(s) ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : NaN
}

/** TCA 'YYYY-MM-DD HH:mm:ss'(UTC) → Unix ms（联动机型匹配用） */
function tcaMsOf(tca?: string): number {
  return parseTcaMs(tca)
}

/** TCA → 'MM-DD HH:mm'（北京时间） */
function fmtTca(tca?: string) {
  if (!tca) return '—'
  const ms = parseTcaMs(tca)
  if (!Number.isFinite(ms)) return String(tca)
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

async function loadList() {
  if (isUnavailable.value) {
    rows.value = []
    total.value = 0
    return
  }
  listLoading.value = true
  listError.value = ''
  try {
    const keyword = query.keyword.trim() || undefined
    // 与热力云同一时间窗（未来 N 天），否则标题计数 / 芯片计数会和列表条数对不上
    const nowMs = Date.now()
    const dateFrom = utcParam(nowMs)
    const dateTo = utcParam(nowMs + heatDays.value * 86400_000)
    {
      // 两个标签共用同一份 sidecar 事件明细；TLE×TLE 初筛没有「主星星历」概念，固定 official
      const p = heatPrimaryFilter.value
      const res = await listHeat2({
        kind: heatSource.value === 'tle-threat' ? 'tle-threat' : 'tle',
        keyword,
        level: query.level || undefined,
        dateFrom,
        dateTo,
        primary: heatSource.value === 'tle-threat'
          ? 'official'
          : p.kind === 'uploaded' ? `ephem:${p.ephemId}` : 'official'
      })
      rows.value = res.list.map(toHeat2Row)
      total.value = res.total
    }
    // 星历窗联动：命中同一对 + 同一 TCA 时高亮该行
    const fp = focusPair.value
    if (fp) {
      const hit = rows.value.find((r) => r.norad_a === fp.a && r.norad_b === fp.b
        && Math.abs(tcaMsOf(r.tca) - fp.tcaMs) < 1000)
      if (hit) pickedKey.value = hit.key
    }
  } catch {
    rows.value = []
    total.value = 0
  } finally {
    listLoading.value = false
    loadedOnce.value = true
    tryAutoSelectFirst()
  }
}

/** 切换标签：交给 heatSource 的 watch 重载热力与列表 */
function pickSource(k: HeatSource) {
  heatSource.value = k
}

function search() { query.page = 1; resetListScroll(); void loadList() }

function goPage(p: number) {
  if (p < 1 || p > maxPage.value) return
  query.page = p
  resetListScroll()
  void loadList()
}

/** 搜索改为输入即筛选（300 ms 防抖），不再需要查询 / 重置按钮 */
let kwTimer: number | undefined
watch(() => query.keyword, () => {
  if (kwTimer) window.clearTimeout(kwTimer)
  kwTimer = window.setTimeout(() => { query.page = 1; resetListScroll(); void loadList() }, 300)
})
watch(() => query.level, () => { query.page = 1; resetListScroll(); void loadList() })

/** 面板展开 / 切换标签 / 状态变化 / 主星筛选 / 时间窗变化时重载 */
watch([dockMode, heatSource, heatPrimaryFilter, status, heatDays], () => {
  if (dockMode.value !== 'heat') return
  applyFocusNorad()
  query.page = 1
  void loadList()
  void loadFresh()
}, { deep: true })

/** 星历窗 → 热力：定位同一事件（列表加载后高亮该行） */
const focusPair = ref<{ a: number; b: number; tcaMs: number } | null>(null)
watch(threatFocus, (f) => {
  if (!f || f.from !== 'ephem' || f.kind !== 'tle') return
  focusPair.value = { a: f.primaryNorad, b: f.secondaryNorad, tcaMs: f.tcaMs }
  if (dockMode.value !== 'heat') return
  query.page = 1
  void loadList()
})

/** 消费「本次打开要聚焦的目标卫星」NORAD */
function applyFocusNorad(): boolean {
  const n = Number(heatFocusNorad.value)
  if (!Number.isFinite(n) || n <= 0) return false
  heatFocusNorad.value = null
  query.keyword = String(n)
  return true
}

/** 已点选的那一对：用 norad 对 + TCA 做键，翻页 / 重载后仍能高亮 */
const pickedKey = ref('')

function pickRow(r: ListRow) {
  pickedKey.value = r.key
  emit('select', { norad_a: r.norad_a, norad_b: r.norad_b, tca: r.tca })
  // 热力 → 星历窗（03 §15.5）：仅星历增强标签的事件在星历窗里有对应轮次；TLE×TLE 初筛无星历事件
  if (heatSource.value === 'tle-threat') return
  const filter = heatPrimaryFilter.value
  focusThreat({
    from: 'heat',
    kind: 'tle',
    eventId: r.id ?? r.key,
    primaryNorad: r.norad_a,
    secondaryNorad: r.norad_b,
    tcaMs: tcaMsOf(r.tca),
    primaryScope: filter.kind === 'uploaded' ? 'uploaded' : 'official',
    ephemId: filter.kind === 'uploaded' ? filter.ephemId : undefined,
    primaryName: r.name_a,
    secondaryName: r.name_b,
    level: r.level ?? undefined
  })
}

/* ---- 智能体联动：打开面板后自动选中第一条 ---- */
const awaitingFirst = ref(false)
let autoSelectHandledTick = 0
const loadedOnce = ref(false)

function tryAutoSelectFirst() {
  if (!awaitingFirst.value || listLoading.value || !loadedOnce.value) return
  awaitingFirst.value = false
  const first = rows.value[0]
  if (first) pickRow(first)
}

function armAutoSelect() {
  if (props.autoSelectTick > autoSelectHandledTick) {
    autoSelectHandledTick = props.autoSelectTick
    awaitingFirst.value = true
    if (applyFocusNorad()) {
      query.page = 1
      void loadList()
      return
    }
    tryAutoSelectFirst()
  }
}
watch(() => props.autoSelectTick, armAutoSelect)
onMounted(() => {
  armAutoSelect()
  void loadHeatLevels()
  if (dockMode.value === 'heat') void loadFresh()
})

/** 重试：清掉 sidecar 健康缓存并重新拉取（由父组件 baseScene expose 的 retryHeat 完成） */
function retry() {
  emit('retry')
}

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
          <b class="sp-title">威胁热力图</b>
          <span class="sp-count">{{ headSub }}</span>
        </div>
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起热力图" @click="close">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 3.1 L8.4 3.1 L5 7.1 Z" /></svg>
        </button>
      </div>

      <!-- 两个标签 + 各来源就绪圆点 -->
      <div class="heat-src">
        <button v-for="s in HEAT_SOURCES" :key="s.key" class="hs-btn"
          :class="{ on: heatSource === s.key }" :title="srcTitle(s.key)" @click="pickSource(s.key)">
          <i class="hs-dot" :style="{ background: srcDot(s.key) }"></i>{{ s.label }}
        </button>
      </div>

      <!-- 数据时效：一行摘要，点开看各源明细 -->
      <div class="heat-fresh">
        <button class="hf-head" :title="freshOpen ? '收起数据时效' : '展开数据时效'" @click="freshOpen = !freshOpen">
          <span class="hf-title">数据时效</span>
          <span class="hf-dot" :style="{ background: freshDown ? '#f2c14e' : '#4fd18b' }"></span>
          <span class="hf-sum" :class="{ 'is-down': freshDown }">{{ freshLine }}</span>
          <span class="hf-info" :class="{ on: freshOpen }">ⓘ</span>
        </button>
        <div v-if="freshOpen" class="hf-body">
          <div v-if="freshDown" class="hf-down">heat-sidecar 未连接，威胁事件数据不可用。</div>
          <div v-for="r in freshRows" :key="r.label" class="hf-line">
            <span class="hf-line-dot" :style="{ background: r.color }"></span>
            <span class="hf-name">{{ r.label }}</span>
            <span class="hf-text">{{ r.text }}</span>
          </div>
          <div class="hf-tip">Pc 统一按等级档位着色；miss 仅作服务端次级过滤（≤10 km），不参与分级。</div>
        </div>
      </div>

      <!-- 主星筛选（仅星历增强标签） -->
      <div v-if="heatSource === 'tle-eph'" class="heat-primary">
        <span class="hf-label">主星</span>
        <button class="hp-chip" :class="{ on: heatPrimaryFilter.kind === 'official' }"
          @click="heatPrimaryFilter = { kind: 'official' }">官方星历（全部 Starlink）</button>
        <button v-if="heatPrimaryFilter.kind === 'uploaded'" class="hp-chip on"
          title="点击取消该筛选"
          @click="heatPrimaryFilter = { kind: 'official' }">
          已上传星历 · {{ ephemLabel(heatPrimaryFilter.ephemId) }} ×
        </button>
      </div>

      <!-- 时间窗 + 按天柱 + 等级芯片 -->
      <div class="heat-filter" :class="{ 'is-dim': isUnavailable }">
        <div class="hf-row">
          <span class="hf-label">时间窗</span>
          <div class="hf-seg">
            <button v-for="o in dayOptions" :key="o.v" class="hf-btn"
              :class="{ on: heatDays === o.v }" :disabled="isUnavailable" @click="heatDays = o.v">{{ o.label }}</button>
          </div>
        </div>

        <div class="hf-row is-days">
          <span class="hf-label">按天</span>
          <div class="hf-bars">
            <button v-for="d in dayBars" :key="d.day" class="hf-bar"
              :class="{ on: heatDay === d.day }" :title="`${d.date} · ${d.count} 个事件`"
              :disabled="isUnavailable" @click="toggleDay(d.day)">
              <b class="hf-bar-n">{{ isReady ? d.count : '—' }}</b>
              <i :style="{ height: barHeight(d.count) }"></i>
              <span class="hf-bar-d">{{ d.date.slice(5) }}</span>
            </button>
          </div>
        </div>

        <div class="hf-row is-chips">
          <span class="hf-label">等级</span>
          <HeatLevelChips :counts="isReady ? levelCounts : null" :off="offColors"
            :disabled="isUnavailable"
            @toggle="toggleChip" />
        </div>
      </div>

      <!-- 未就绪：灰色空状态卡（不显示任何旧计数） -->
      <HeatEmptyState v-if="isUnavailable" :reason="heatUnavailableReason" :loading="heatLoading" @retry="retry" />
      <div v-else-if="status === 'loading' && !rows.length" class="heat-none">加载中…</div>
      <div v-else-if="isReady && !heatList.length" class="heat-none">未来 {{ heatDays }} 天无事件</div>

      <!-- 事件列表 -->
      <div v-if="!isUnavailable" class="heat-conj">
        <div class="hc-head">
          <b class="hc-title">事件列表</b>
          <span class="hc-total">{{ isReady ? `${total.toLocaleString()} 条` : '—' }} · 按 TCA 升序</span>
        </div>

        <div class="hc-search">
          <input
            v-model="query.keyword"
            class="hc-input"
            type="text"
            placeholder="NORAD 编号或名称（输入即筛选）"
          />
          <select v-model="query.level" class="hc-sel">
            <option value="">全部等级</option>
            <option value="red">高危</option>
            <option value="orange">警告</option>
            <option value="yellow">关注</option>
            <option value="insufficient">数据不足</option>
          </select>
        </div>

        <div ref="listEl" class="hc-list" @scroll.passive="onListScroll">
          <div v-if="listLoadingHint" class="hc-empty">加载中…</div>
          <div v-else-if="listError" class="hc-empty">{{ listError }}</div>
          <div v-else-if="!listLoading && !rows.length" class="hc-empty">
            {{ isReady ? '该时间窗内无事件' : '暂无交会数据' }}
          </div>
          <template v-else>
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
                <span class="hc-pc" :style="{ color: r.color }">{{ r.pc > 0 ? `Pc ${r.pc.toExponential(1)}` : 'Pc —' }}</span>
              </div>
              <div class="hc-item-sub">
                <span class="hc-dot" :style="{ background: r.color }"></span>
                <span class="hc-level" :style="{ color: r.color }">{{ r.level ? labelForLevel(r.level) : '—' }}</span>
                <span class="hc-tca">TCA {{ fmtTca(r.tca) }}（UTC+8）</span>
                <span class="hc-miss">miss {{ fmtNum(r.miss, 3) }} km</span>
              </div>
            </div>
            <div v-if="virtOn && padBottom" :style="{ height: padBottom + 'px' }"></div>
          </template>
        </div>

        <button
          v-if="heatSource === 'tle-eph' && rows.length"
          class="hc-ephem-link"
          @click="emit('open-ephem', { norad: rows[0].norad_a, name: rows[0].name_a })"
        >在星历窗中打开该主星 ›</button>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

.heat-panel { height: auto; }

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
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 16px;
    border-color: rgba(127, 216, 255, 0.18);
    background: linear-gradient(180deg, rgba(22, 30, 44, 0.88), rgba(13, 19, 30, 0.92));
    backdrop-filter: blur(22px) saturate(1.3);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 24px 60px rgba(0, 0, 0, 0.55);
  }
  .heat-panel.panel-enter-active,
  .heat-panel.panel-leave-active { transition: transform 0.24s ease, opacity 0.24s ease; }
  .heat-panel.panel-enter-from,
  .heat-panel.panel-leave-to {
    transform: translateX(-50%) translateY(14px);
    opacity: 0;
  }
}

/* ---------------- 来源页签 ---------------- */
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    transition: background 0.15s, color 0.15s, border-color 0.15s;

    &:hover { color: #d7e6fb; border-color: rgba(120, 165, 225, 0.5); }
    &.on {
      color: #eaf4ff;
      border-color: #4c9aff;
      background: rgba(38, 92, 156, 0.75);
    }
  }
  .hs-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
}

/* ---------------- 数据时效 ---------------- */
.heat-fresh {
  margin: 0 0 8px;
  padding: 0 0 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  pointer-events: auto;

  .hf-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 2px 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;

    .hf-title { flex: none; font-size: 11.5px; color: #8b9bb5; letter-spacing: 0.02em; }
    .hf-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
    .hf-sum {
      flex: 1;
      min-width: 0;
      font-size: 11.5px;
      color: #7fd8ff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      &.is-down { color: #f2c14e; }
    }
    .hf-info { flex: none; font-size: 11px; color: #7d8ba3; &.on { color: #7fd8ff; } }
    &:hover .hf-title { color: #cfdcea; }
  }

  .hf-body { padding-top: 4px; }
  .hf-line { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 11px; }
  .hf-line-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
  .hf-name { flex: 0 0 78px; color: #a7b6cc; white-space: nowrap; }
  .hf-text {
    flex: 1; min-width: 0; color: #d8e2f0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .hf-down { padding: 2px 0 4px; font-size: 11px; color: #f2c14e; }
  .hf-tip { padding-top: 4px; font-size: 10.5px; color: #7d8ba3; line-height: 1.5; }
}

/* ---------------- 主星筛选 ---------------- */
.heat-primary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 8px;
  pointer-events: auto;
}
.hp-chip {
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  border-radius: 12px;
  cursor: pointer;
  color: #a7b6cc;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(120, 160, 220, 0.28);
  white-space: nowrap;
  &.on {
    color: #ffd98a;
    border-color: rgba(242, 193, 78, 0.65);
    background: rgba(242, 193, 78, 0.16);
  }
}

/* ---------------- 筛选条 ---------------- */
.heat-filter {
  padding: 2px 0 10px;
  pointer-events: auto;
  &.is-dim { opacity: 0.45; }

  .hf-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    &.is-days { align-items: flex-end; }
    &.is-chips { align-items: flex-start; }
  }
  .hf-label { flex: 0 0 42px; font-size: 12px; color: #a7b6cc; white-space: nowrap; }

  .hf-seg { display: flex; flex: 1; min-width: 0; gap: 2px; }
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
    &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); color: #e6edf7; }
    &.on { background: rgba(79, 195, 247, 0.2); border-color: rgba(79, 195, 247, 0.6); color: #8fe2ff; }
    &:disabled { cursor: default; }
  }

  /* 按天柱：固定一列 7 天 */
  .hf-bars {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: flex-end;
    gap: 3px;
    height: 58px;
  }
  .hf-bar {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    background: none;
    border: none;
    cursor: pointer;

    .hf-bar-n { font-size: 10px; line-height: 1; color: #8b9bb5; font-weight: 700; }
    i {
      display: block;
      width: 100%;
      border-radius: 2px 2px 0 0;
      background: rgba(127, 176, 255, 0.45);
      transition: height 0.2s ease, background 0.15s ease;
    }
    .hf-bar-d { font-size: 9px; line-height: 1; color: #6f819c; white-space: nowrap; }
    &:hover i { background: rgba(143, 226, 255, 0.8); }
    &.on i { background: #4fc3f7; }
    &:disabled { cursor: default; }
  }

  /* 等级芯片由 HeatLevelChips 组件渲染（与星历分析窗共用） */
}

.heat-none {
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: #7d8ba3;
}

/* ---------------- 事件列表 ---------------- */
.heat-conj {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  min-height: 0;
  pointer-events: auto;

  .hc-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    .hc-title { font-size: 12px; font-weight: 700; color: #cfdcea; }
    .hc-total { font-size: 11px; color: #7fb0ff; white-space: nowrap; }
  }

  .hc-search { display: flex; gap: 6px; margin-bottom: 8px; }

  .hc-input,
  .hc-sel {
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    border-radius: 6px;
    background: rgba(20, 28, 44, 0.96);
    border: 1px solid rgba(120, 160, 220, 0.28);
    color: #e6edf7;
    color-scheme: dark;
    outline: none;
    box-sizing: border-box;
    &:focus { border-color: #4fc3f7; }
  }
  .hc-input {
    flex: 1;
    min-width: 0;
    &::placeholder { color: #7d8ba3; }
  }
  .hc-sel {
    flex: 0 0 92px;
    cursor: pointer;
    option { background: #1b2130; color: #e6edf7; }
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
    &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); color: #e6edf7; }
    &:disabled { opacity: 0.4; cursor: not-allowed; }
  }

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
  }

  .hc-item {
    padding: 7px 8px;
    margin-bottom: 4px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;

    &:hover { background: rgba(55, 194, 255, 0.1); border-color: rgba(55, 194, 255, 0.35); }
    &.on { background: rgba(55, 194, 255, 0.16); border-color: rgba(55, 194, 255, 0.6); }

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
      .hc-pc {
        flex: none;
        font-size: 12px;
        font-weight: 700;
        font-family: 'Consolas', 'Menlo', monospace;
      }
    }

    .hc-item-sub {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      font-size: 11px;
      color: #7d8ba3;
      .hc-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      .hc-level { font-weight: 600; }
      .hc-miss { color: #93a4bd; }
    }
  }

  .hc-ephem-link {
    align-self: flex-end;
    margin-top: 6px;
    padding: 2px 0;
    font-size: 11px;
    color: #7fb0ff;
    background: none;
    border: 0;
    cursor: pointer;
    &:hover { color: #a9c6ea; }
  }

  .hc-pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding-top: 8px;
    .hc-page { font-size: 12px; color: #93a4bd; font-family: 'Consolas', 'Menlo', monospace; }
  }
}

html.is-mobile {
  .heat-conj .hc-list { max-height: none; overflow: visible; }
  .heat-conj .hc-input { flex: 1 1 100%; }
  .heat-conj .hc-input,
  .heat-conj .hc-sel { height: 26px; font-size: 11.5px; }
  .heat-conj .hc-btn { height: 26px; padding: 0 10px; font-size: 11.5px; }
  .heat-conj .hc-item {
    padding: 5px 7px; margin-bottom: 3px; border-radius: 7px;
    background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(120, 160, 220, 0.12);
    .hc-item-top .hc-names { font-size: 11.5px; }
    .hc-item-top .hc-pc { font-size: 11px; }
    .hc-item-sub { margin-top: 2px; font-size: 9.5px; }
  }
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

@media (min-width: 769px) {
  .heat-panel .hc-item { height: 58px; box-sizing: border-box; }
  .heat-panel .hc-list { flex: 0 0 auto; height: min(40vh, 330px); max-height: none; }
}
</style>
