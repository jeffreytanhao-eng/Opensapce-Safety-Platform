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
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'
import { listConjPublic, listCdmPublic, listCriPublic } from '@/api/sat_public'
import type { ConjEvent, CdmListItem, CriListItem } from '@/api/sat_public'
import { useDelayed } from '@/composables/useDelayed'

const emit = defineEmits<{
  (e: 'close'): void
  /** 点击「本批次交会数据」某一对：上报其 norad 对 + TCA，由父组件让 BaseScene 绘制 2 条轨道 + 目标模型 */
  (e: 'select', pair: { norad_a: number; norad_b: number; tca: string }): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 智能体联动：open_panel(heat, selectFirst=true) 打开面板后，外部通过 autoSelectTick 递增触发「自动选中第一条」 */
const props = withDefaults(defineProps<{ autoSelectTick?: number }>(), { autoSelectTick: 0 })

/** 当前来源标签（面板标题下方展示，提示当前热力口径） */
const srcLabel = computed(() => HEAT_SOURCES.find((s) => s.key === heatSource.value)?.label || '')

/** 等级文案（与后台 /mui/sat_conj 一致） */
const LEVEL_LABEL: Record<string, string> = { danger: '高危', warning: '警告', info: '关注' }

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

const rows = ref<ListRow[]>([])
const total = ref(0)
const listLoading = ref(false)
/** 列表是分页查询，正常毫秒级返回：默认不显示「加载中」，超过 1.5s 才出现兜底提示 */
const listLoadingHint = useDelayed(listLoading)
const listError = ref('')
const query = reactive({ page: 1, pageSize: 20, keyword: '', level: '', dateFrom: '', dateTo: '' })
const maxPage = computed(() => Math.max(1, Math.ceil(total.value / query.pageSize)))

/** 列表标题：按来源区分口径（local / cri = 各自库当前批次明细；CDM = 官方 CDM 库表明细） */
const listTitle = computed(() =>
  heatSource.value === 'local' ? '本批次交会数据' : heatSource.value === 'cri' ? '交会分析数据' : 'CDM 交会数据'
)

/** 拉取当前来源的交会明细：local = 当前批次（heatBatchRunId 指定 / 后端默认最近全量批次），
 *  cri = 交会分析库当前批次（同样支持批次回看），CDM = sat_cdm 库表全量明细；关键词与日期范围口径一致。 */
async function loadList() {
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

function search() { query.page = 1; loadList() }

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
          <b class="sp-title">碰撞热力</b>
          <span class="sp-count">{{ heatList.length.toLocaleString() }} 个事件</span>
          <span class="sp-meta">{{ srcLabel }}</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="close">»</button>
      </div>

      <!-- 数据批次（总库）：交会热力 / 交会分析热力来源展示（各自独立批次表）；回看历史「全体 × 全体」全量扫描批次。
           主从计算 / 配对标注批次属后台分析工具，不进前台，故此处只列全量批次；CDM 热力无批次概念，不展示 -->
      <div v-if="heatSource !== 'spacetrack'" class="heat-batch">
        <span class="heat-batch-label">数据批次</span>
        <select class="heat-batch-sel" :value="heatBatchRunId ?? ''" @change="onBatchChange">
          <option v-if="!batchOptions.length" value="" disabled>暂无全量批次</option>
          <option v-for="b in batchOptions" :key="b.id" :value="b.id">{{ b.label }}</option>
        </select>
      </div>

      <!-- 配色图例：档位 / 配色 / 阈值文案全部由后端按当前来源口径下发，前端直接渲染。
           每一行可勾选：取消勾选即隐藏该档位在三维热力视图中的事件（按配色匹配），只影响渲染不影响列表数据 -->
      <div class="heat-scale">
        <div class="heat-scale-title">{{ heatMetricLabel || '指标' }}</div>
        <label
          v-for="s in heatLegend"
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

      <div v-if="heatError" class="heat-err">{{ heatError }}</div>
      <div v-else-if="!heatLoading && !heatList.length" class="heat-none">暂无碰撞事件</div>

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
          <select v-if="heatSource !== 'spacetrack'" v-model="query.level" class="hc-sel">
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

        <div class="hc-list">
          <div v-if="listLoadingHint" class="hc-empty">加载中…</div>
          <div v-else-if="listError" class="hc-empty is-err">{{ listError }}</div>
          <!-- 未超时的加载中：保留上一次结果、不闪「暂无」（正常毫秒级返回，这个分支几乎不可见） -->
          <div v-else-if="!listLoading && !rows.length" class="hc-empty">暂无交会数据</div>
          <template v-else>
            <div
              v-for="r in rows"
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
          </template>
        </div>

        <div class="hc-pager">
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
</style>
