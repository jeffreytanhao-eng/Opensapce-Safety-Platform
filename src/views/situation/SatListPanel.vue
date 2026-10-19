<script setup lang="ts">
/**
 * 星座总览 /situation 卫星列表面板（左侧滑出）
 * 从原 index.vue 拆分而来：搜索名称/NORAD + 类型/轨道区域勾选过滤 + 滚动加载。
 * 共享响应式状态集中在 scene.ts（satPanel / sel / g.cloudList / 元数据）。
 * 纯动作（点击选中、关闭面板）通过 emit 交给父组件 index.vue 编排（父组件调用 BaseScene.expose）。
 */
import {
  TYPE_KEYS, TYPE_HEX, TYPE_LABEL, REGIME_KEYS, REGIME_LABEL,
  satPanel, sel, g, orbitTotal, orbitSkipped, visibleCount, dockMode,
  dataSource, SAT_SOURCE_OPTIONS,
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'
import type { SatSource } from '@/api/sat_public'

const emit = defineEmits<{
  (e: 'pick', gi: number): void
  (e: 'close'): void
  /** 切换数据源（国际库 / AOE 库）：交父组件转给三维场景重拉点云 */
  (e: 'source', src: SatSource): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 滚动到底部附近加载下一批 */
function onSatScroll(ev: Event) {
  const el = ev.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) loadMoreSat()
}
function loadMoreSat() {
  satPanel.count = Math.min(satPanel.count + satPanel.BATCH, satPanel.idx.length)
}
function pick(gi: number) {
  emit('pick', gi)
}
function close() {
  emit('close')
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
        <div class="sp-head-main">
          <b class="sp-title">卫星列表</b>
          <span class="sp-count">{{ satPanel.idx.length.toLocaleString() }} 颗匹配</span>
          <span v-if="orbitSkipped" class="sp-meta">在轨 {{ orbitTotal.toLocaleString() }} · 可渲染 {{ visibleCount.toLocaleString() }} · 跳过 {{ orbitSkipped.toLocaleString() }}</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="close">»</button>
      </div>
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
      <div class="sp-search">
        <input v-model="satPanel.q" class="sp-input" type="text" placeholder="搜名称 / NORAD 编号" />
        <span v-if="satPanel.q" class="sp-clear" @click="satPanel.q = ''">×</span>
      </div>
      <div class="sp-types">
        <label v-for="k in TYPE_KEYS" :key="k" class="sp-type" :class="{ on: satPanel.typeF[k] }">
          <input type="checkbox" v-model="satPanel.typeF[k]" />
          <span class="sp-type-dot" :style="{ background: TYPE_HEX[k] }"></span>
          <span class="sp-type-txt">{{ TYPE_LABEL[k] }}</span>
        </label>
      </div>
      <div class="sp-regimes">
        <label v-for="k in REGIME_KEYS" :key="k" class="sp-regime" :class="{ on: satPanel.regimeF[k] }">
          <input type="checkbox" v-model="satPanel.regimeF[k]" />
          <span class="sp-regime-txt">{{ REGIME_LABEL[k] }}</span>
        </label>
      </div>
      <div class="sp-list" @scroll="onSatScroll">
        <div
          v-for="gi in satPanel.idx.slice(0, satPanel.count)"
          :key="gi"
          class="sp-item"
          :class="{ active: sel.id === g.cloudList[gi].norad_id }"
          @click="pick(gi)"
        >
          <span class="sp-item-dot" :style="{ background: TYPE_HEX[g.cloudList[gi].object_type] || '#8fd0ff' }"></span>
          <div class="sp-item-main">
            <span class="sp-item-name">{{ g.cloudList[gi].object_name || ('NORAD ' + g.cloudList[gi].norad_id) }}</span>
            <span class="sp-item-nor">NORAD {{ g.cloudList[gi].norad_id }}</span>
          </div>
          <span class="sp-item-type">{{ TYPE_LABEL[g.cloudList[gi].object_type] || g.cloudList[gi].object_type }}</span>
        </div>
        <div v-if="!satPanel.idx.length" class="sp-empty">无匹配卫星</div>
        <div v-else-if="satPanel.count < satPanel.idx.length" class="sp-more">继续滚动加载更多…</div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
