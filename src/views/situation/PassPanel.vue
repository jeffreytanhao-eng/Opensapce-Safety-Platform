<script setup lang="ts">
/**
 * 星座总览 /situation 城市过境面板（左侧滑出，dock 入口 'pass'）
 * 三个视图（顶部「国 / 省 / 市」切换）：
 *   国 —— 其他国家国界面（iso_a2 ≠ CN/TW）。
 *   省 —— 省级聚合面（level='province_agg'，含 27 内地省 + 中国台湾省）。
 *         点整省 → 地球高亮整省轮廓 + 右侧给省级汇总（由下辖市明细聚合、按卫星去重）；
 *         点「市」按钮下钻到该省下辖地市。
 *   市 —— 地市行政区划面（level='city'），含中国台湾省下辖 22 个县级政区。
 * 三个视图均显示全部目标（不再按数据批次过滤）。
 * 检索名称 / 省份 / 国家 / 编号；「数据批次」下拉回看历史批次，切换后地球面层 / 明细按该批次展示。
 * 点击某一项即按目标 id 打开该目标指定批次未来 24h 过境明细（与直接在三维地球上点行政区划面同一路径）。
 * 行政区划面 / 国界 / 城市标注的绘制与拾取由 BaseScene.vue 负责；本组件只读共享 store 并上报点击。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  dockMode, passTargets, passProvinceTargets, passDistricts,
  passGeoLoading, passGeoError, passSelTarget,
  passBatchRunId, passBatches,
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'
import { useDelayed } from '@/composables/useDelayed'

/** 过境底图正常毫秒级返回（首屏后已静默预取），只有真变慢时才显示兜底提示 */
const passGeoLoadingHint = useDelayed(passGeoLoading)

const emit = defineEmits<{
  /** 点击目标：上报 pass_geo.id，由父组件调用 BaseScene.pickPassTargetById 读取过境明细 */
  (e: 'pick', targetId: number): void
  (e: 'close'): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 检索关键词：匹配中文名 / 英文名 / 省份 / 国家 / 编号 */
const q = ref('')
/** 滚动加载：目标数达数百个，一次全渲染在移动端会卡顿，按批渲染 */
const BATCH = 60
const count = ref(BATCH)

/** 当前视图：国（其他国家国界）/ 省（省级聚合）/ 市（地市 + 台湾县级政区） */
const tab = ref<'country' | 'province' | 'city'>('province')
/** 从省级下钻到市：记录该省 province_adcode（仅「市」视图下生效，空串=不按省过滤） */
const drillPad = ref('')

/** 国视图：其他国家国界面 */
const countryListed = computed(() => passTargets.value.filter((t) => t.geo_type === 'border'))

/** 省视图：省级聚合面（全部：27 内地省 + 中国台湾省） */
const provinceListed = computed(() => passProvinceTargets.value)

/** 市视图：全部地市行政区划面（含中国台湾省下辖县级政区） */
const cityAll = computed(() => passTargets.value.filter((t) => t.geo_type === 'district'))

/** 市视图范围：下钻后只列该省下辖市 */
const cityScoped = computed(() => {
  const base = cityAll.value
  if (!drillPad.value) return base
  return base.filter((c) => String(c.province_adcode || '') === drillPad.value)
})

/** 当前视图的数据源 */
const source = computed(() =>
  tab.value === 'country' ? countryListed.value : tab.value === 'province' ? provinceListed.value : cityScoped.value
)

const filtered = computed(() => {
  const kw = q.value.trim().toLowerCase()
  if (!kw) return source.value
  return source.value.filter((c) =>
    (c.name || '').toLowerCase().includes(kw) ||
    (c.name_en || '').toLowerCase().includes(kw) ||
    (c.name_cn || '').toLowerCase().includes(kw) ||
    (c.province || '').toLowerCase().includes(kw) ||
    (c.country || '').toLowerCase().includes(kw) ||
    String(c.id) === kw
  )
})

/** 检索条件变化：回到第一批（否则命中数变少时列表可能整屏空白） */
watch(q, () => { count.value = BATCH })
/** 切换数据批次：目标整体换一组，回到第一批 */
watch(passBatchRunId, () => { count.value = BATCH })

/** 列表滚动容器（用于把命中项滚动到可视区） */
const listEl = ref<HTMLElement | null>(null)

/** 切换视图：回到第一批并清掉下钻 */
function switchTab(t: 'country' | 'province' | 'city') {
  tab.value = t
  drillPad.value = ''
  count.value = BATCH
}

/** 省级下钻：切到「市」视图并只列该省下辖市 */
function drillTo(p: { adcode?: string; province_adcode?: string }) {
  drillPad.value = String(p.adcode || p.province_adcode || '')
  tab.value = 'city'
  q.value = ''
  count.value = BATCH
}

/** 下钻返回：回到省视图 */
function backToProvince() {
  drillPad.value = ''
  tab.value = 'province'
  count.value = BATCH
}

/** 省级项展示用：下辖地级市总数 */
function childCityCount(p: { adcode?: string; province_adcode?: string }) {
  const pad = String(p.adcode || p.province_adcode || '')
  return passDistricts.value.filter((d) => String(d.province_adcode || '') === pad).length
}

/** 命中联动：在三维地球上点行政区划面 / 点本面板列表项后，passSelTarget 被写入共享 store，
 *  这里负责把视图切到对应层级、把对应列表项「滚动到可视区」（高亮由 :class 的 active 完成）。
 *  断点在于列表是「滚动加载」的：count 只渲染前 N 条，命中项排在 N 条之外时根本不在 DOM 里，
 *  既不会高亮也无法滚动 —— 故先把 count 扩到覆盖命中项，待 DOM 更新后再滚动定位。 */
watch(() => passSelTarget.value?.id, async (id) => {
  if (!id) return
  // 选中项可能在另一视图（如智能体「问整省」落在省视图）→ 自动切到对应视图
  if (provinceListed.value.some((p) => p.id === id)) {
    if (tab.value !== 'province') switchTab('province')
  } else if (cityAll.value.some((c) => c.id === id)) {
    if (tab.value !== 'city') switchTab('city')
    // 下钻过滤把该市挡在外面时清掉下钻，保证能定位到
    else if (drillPad.value && !filtered.value.some((c) => c.id === id)) { drillPad.value = '' }
  } else if (countryListed.value.some((c) => c.id === id)) {
    if (tab.value !== 'country') switchTab('country')
  } else {
    return
  }
  await nextTick()
  const idx = filtered.value.findIndex((c) => c.id === id)
  if (idx < 0) return
  if (idx >= count.value) {
    count.value = Math.min(Math.ceil((idx + 1) / BATCH) * BATCH, filtered.value.length)
  }
  await nextTick()
  listEl.value?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
}, { immediate: true })

/** 批次下拉文案：`#id · MM-DD HH:mm`（汇总完成时间，与碰撞热力面板同一格式） */
function batchLabel(id: number, createdAt?: string) {
  if (!createdAt) return `#${id}`
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return `#${id}`
  const p = (n: number) => String(n).padStart(2, '0')
  return `#${id} · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 「数据批次」下拉项：最近 N 个有汇总数据的成功批次；
 *  若当前批次不在列表中（库中暂无批次等），补一条占位项保证回显不空。 */
const batchOptions = computed(() => {
  const list = passBatches.value.map((b) => ({ id: b.id, label: batchLabel(b.id, b.created_at) }))
  const cur = passBatchRunId.value
  if (cur && !list.some((o) => o.id === cur)) {
    list.unshift({ id: cur, label: `当前批次 #${cur}` })
  }
  return list
})

/** 切换数据批次：null 表示回到「当前批次」（由后端解析最近有数据的成功批次） */
function onBatchChange(e: Event) {
  const v = Number((e.target as HTMLSelectElement).value)
  passBatchRunId.value = Number.isFinite(v) && v > 0 ? v : null
}

function onScroll(ev: Event) {
  const el = ev.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    count.value = Math.min(count.value + BATCH, filtered.value.length)
  }
}

function pick(cityId: number) {
  emit('pick', cityId)
}

function close() {
  emit('close')
}
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'pass'" class="side-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">城市过境</b>
          <span class="sp-count">{{ filtered.length.toLocaleString() }} 个目标</span>
          <span class="sp-meta">点地球行政区划面或下方列表项 → 未来 24h 载荷过境明细</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="close">»</button>
      </div>

      <div v-if="passGeoLoadingHint" class="sp-state">地理底图加载中…</div>
      <div v-else-if="passGeoError" class="sp-state is-err">{{ passGeoError }}</div>
      <template v-else>
        <!-- 数据批次：回看历史汇总批次（最近 N 个有数据的成功批次）；切换后城市列表 / 地球标注点 / 明细均按该批次展示 -->
        <div class="sp-batch">
          <span class="sp-batch-label">数据批次</span>
          <select class="sp-batch-sel" :value="passBatchRunId ?? ''" @change="onBatchChange">
            <option v-if="!batchOptions.length" value="" disabled>暂无批次</option>
            <option v-for="b in batchOptions" :key="b.id" :value="b.id">{{ b.label }}</option>
          </select>
        </div>
        <!-- 国 / 省 / 市 视图切换：国=其他国家国界，省=省级聚合（整省高亮 + 省级汇总），市=地市（含台湾县级政区） -->
        <div class="sp-tabs">
          <button class="sp-tab" :class="{ active: tab === 'country' }" @click="switchTab('country')">
            国<span class="sp-tab-n">{{ countryListed.length }}</span>
          </button>
          <button class="sp-tab" :class="{ active: tab === 'province' }" @click="switchTab('province')">
            省<span class="sp-tab-n">{{ provinceListed.length }}</span>
          </button>
          <button class="sp-tab" :class="{ active: tab === 'city' }" @click="switchTab('city')">
            市<span class="sp-tab-n">{{ cityAll.length }}</span>
          </button>
        </div>
        <!-- 下钻面包屑：从省级进入市列表时可返回 -->
        <div v-if="tab === 'city' && drillPad" class="sp-crumb">
          <button class="sp-crumb-back" @click="backToProvince">‹ 省级</button>
          <span class="sp-crumb-cur">{{ cityScoped.length }} 个下辖目标</span>
        </div>
        <div class="sp-search">
          <input v-model="q" class="sp-input" type="text" placeholder="搜行政区划 / 省份 / 国家 / 编号" />
          <span v-if="q" class="sp-clear" @click="q = ''">×</span>
        </div>
        <div ref="listEl" class="sp-list" @scroll="onScroll">
          <div
            v-for="c in filtered.slice(0, count)"
            :key="c.id"
            class="sp-item"
            :data-id="c.id"
            :class="{ active: passSelTarget?.id === c.id }"
            @click="pick(c.id)"
          >
            <span class="sp-item-dot pass-dot"></span>
            <div class="sp-item-main">
              <span class="sp-item-name">{{ c.name_cn || c.name || c.name_en || ('#' + c.id) }}</span>
              <span v-if="tab === 'province'" class="sp-item-nor">
                整省 · 下辖 {{ childCityCount(c) }} 市 · {{ c.longitude.toFixed(2) }}°, {{ c.latitude.toFixed(2) }}°
              </span>
              <span v-else-if="tab === 'country'" class="sp-item-nor">
                {{ c.country || c.name_en || '国界' }} · {{ c.longitude.toFixed(2) }}°, {{ c.latitude.toFixed(2) }}°
              </span>
              <span v-else class="sp-item-nor">
                {{ c.province || '中国' }} · {{ c.longitude.toFixed(2) }}°, {{ c.latitude.toFixed(2) }}°
              </span>
            </div>
            <span v-if="tab === 'province'" class="sp-item-drill" title="下钻到该省下辖市" @click.stop="drillTo(c)">市 ›</span>
            <span v-else class="sp-item-type">{{ tab === 'country' ? '国' : '市' }}</span>
          </div>
          <div v-if="!filtered.length" class="sp-empty">
            {{ q ? '无匹配目标' : (tab === 'country' ? '暂无国家' : tab === 'province' ? '暂无省份' : (drillPad ? '该省下暂无城市' : '暂无城市')) }}
          </div>
          <div v-else-if="count < filtered.length" class="sp-more">继续滚动加载更多…</div>
        </div>
      </template>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 数据批次下拉：与碰撞热力面板同款（同一视觉与交互），放在搜索框上方 */
.sp-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
  /* 面板整体 pointer-events:none（空白区域穿透拾取城市），交互控件必须恢复事件 */
  pointer-events: auto;
  .sp-batch-label {
    font-size: 12px;
    color: #a7b6cc;
    white-space: nowrap;
  }
  .sp-batch-sel {
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
      border-color: #4da3ff;
    }
    option {
      background: #1b2130;
      color: #e6edf7;
    }
  }
}

html.is-mobile {
  /* 批次下拉：与抽屉内其他控件同一尺度，空间压到极致 */
  .sp-batch {
    margin-top: 5px;
    .sp-batch-label { font-size: 11px; }
    .sp-batch-sel { padding: 5px 6px; font-size: 11.5px; }
  }
}

/* 省 / 市·国 视图切换（分段控件） */
.sp-tabs {
  display: flex;
  gap: 6px;
  margin: 8px 0 0;
  /* 面板整体 pointer-events:none（空白区域穿透拾取城市），交互控件必须恢复事件 */
  pointer-events: auto;
  .sp-tab {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: 12px;
    color: #a7b6cc;
    background: rgba(20, 28, 44, 0.72);
    border: 1px solid rgba(120, 160, 220, 0.22);
    border-radius: 6px;
    cursor: pointer;
    transition: background .15s, color .15s, border-color .15s;
    &.active {
      color: #eaf2ff;
      background: rgba(48, 110, 200, 0.55);
      border-color: #4da3ff;
    }
    .sp-tab-n {
      font-size: 11px;
      opacity: .8;
      font-variant-numeric: tabular-nums;
    }
  }
}

/* 下钻面包屑 */
.sp-crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  pointer-events: auto;
  .sp-crumb-back {
    padding: 3px 8px;
    font-size: 12px;
    color: #cfe2ff;
    background: rgba(48, 110, 200, 0.35);
    border: 1px solid rgba(77, 163, 255, 0.5);
    border-radius: 6px;
    cursor: pointer;
    &:hover { background: rgba(48, 110, 200, 0.55); }
  }
  .sp-crumb-cur {
    font-size: 11.5px;
    color: #a7b6cc;
  }
}

/* 省级项右side「下钻」按钮 */
.sp-item-drill {
  flex: none;
  padding: 2px 7px;
  font-size: 11px;
  color: #cfe2ff;
  background: rgba(48, 110, 200, 0.4);
  border: 1px solid rgba(77, 163, 255, 0.45);
  border-radius: 5px;
  cursor: pointer;
  pointer-events: auto;
  &:hover { background: rgba(48, 110, 200, 0.62); }
}

html.is-mobile {
  .sp-tabs { margin-top: 5px; }
  .sp-tabs .sp-tab { padding: 5px 6px; font-size: 11.5px; }
  .sp-crumb { margin-top: 5px; }
  .sp-item-drill { font-size: 10.5px; padding: 2px 6px; }
}
</style>
