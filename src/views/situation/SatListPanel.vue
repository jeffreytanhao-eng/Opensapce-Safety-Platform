<script setup lang="ts">
/**
 * 星座总览 /situation 卫星列表面板（左侧滑出）
 * 从原 index.vue 拆分而来：搜索名称/NORAD + 类型/轨道区域勾选过滤 + 滚动加载。
 * 共享响应式状态集中在 scene.ts（satPanel / sel / g.cloudList / 元数据）。
 * 纯动作（点击选中、关闭面板）通过 emit 交给父组件 index.vue 编排（父组件调用 BaseScene.expose）。
 */
import {
  TYPE_KEYS, TYPE_HEX, TYPE_LABEL, REGIME_KEYS, REGIME_LABEL,
  satPanel, sel, g, dockMode,
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
        <div class="sp-head-main sat-head-main">
          <b class="sp-title">太空安全目标列表</b>
          <span class="sp-count">{{ satPanel.idx.length.toLocaleString() }}个太空目标</span>
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

/* 目标列表头部定制：标题居中、标题与统计行距拉开（仅作用于本面板，scoped 隔离）。
   基础规则是 .side-panel .sp-head .sp-head-main（特异性更高），此处须同级前缀 + 追加类才能覆盖 gap */
.side-panel .sp-head .sp-head-main.sat-head-main {
  flex: 1;
  align-items: center;
  gap: 12px;
  .sp-title { text-align: center; font-size: 14px; }
  .sp-count { text-align: center; }
}
/* 收起按钮脱离文档流钉在头部右侧，让标题/统计在面板宽度内真正水平居中（桌面 + 移动抽屉通用） */
.side-panel .sp-head .sp-close.sp-close-tri { position: absolute; right: 10px; top: 8px; }
/* 「选择数据源」标签行：白字、与标题同字号、居中（下移 5px 与分段控件拉开） */
.side-panel .sp-src-label { margin: 5px 0 0; font-size: 14px; color: #fff; text-align: center; }
</style>
