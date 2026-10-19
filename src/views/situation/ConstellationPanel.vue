<script setup lang="ts">
/**
 * 星座总览 /situation 星座列表面板（左侧滑出）
 * 从原 index.vue 拆分而来：按名称检索 + 展示各星座目标数量；点击星座即按星座过滤并绘制轨道线。
 * 共享响应式状态集中在 scene.ts（constPanel / consFiltered / filterConst）。
 * 绘制轨道线进度（orbitBuilding/orbitProgress）由 BaseScene 在地球中央统一展示。
 * 纯动作（点击筛选、关闭面板）通过 emit 交给父组件 index.vue 编排。
 */
import {
  consFiltered, constPanel, filterConst, dockMode,
  drawerHeightVh, isDrawerDragging, useDrawerDrag
} from './scene'

const emit = defineEmits<{
  (e: 'pick', name: string): void
  (e: 'close'): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

function pick(name: string) {
  emit('pick', name)
}
function close() {
  emit('close')
}
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'cons'" class="side-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">星座列表</b>
          <span class="sp-count">{{ consFiltered.length.toLocaleString() }} 个星座</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="close">»</button>
      </div>
      <div class="sp-search">
        <input v-model="constPanel.q" class="sp-input" type="text" placeholder="按星座名称检索" />
        <span v-if="constPanel.q" class="sp-clear" @click="constPanel.q = ''">×</span>
      </div>
      <div class="sp-list cons-list">
        <div
          v-for="c in consFiltered"
          :key="c.id"
          class="sp-item"
          :class="{ active: filterConst === c.name }"
          @click="pick(c.name)"
        >
          <span class="sp-item-dot cons-dot"></span>
          <div class="sp-item-main">
            <span class="sp-item-name">{{ c.name }}</span>
            <span class="sp-item-nor">{{ c.satellite_count }} 颗卫星</span>
          </div>
        </div>
        <div v-if="!consFiltered.length" class="sp-empty">无匹配星座</div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
