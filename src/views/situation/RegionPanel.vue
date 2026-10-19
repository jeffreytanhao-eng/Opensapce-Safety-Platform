<script setup lang="ts">
/**
 * 区域过境面板（左侧滑出，dock 入口 'region'）
 *
 * 与「城市过境」面板（PassPanel）平级、互不影响：
 *   城市过境 —— 点地球城市读预计算的 pass_detail（定时任务维护，pass_info / pass_detail）；
 *   区域过境 —— 在三维地球上框选多边形，提交后端子进程现算（/cgi/pass/region/*，结果落 pass_region_access）。
 * 业务内容在 RegionSection.vue（框选工具 + 进度轮询 + 结果列表）；本组件只负责面板外壳、dock 状态与事件透传。
 */
import { dockMode, drawerHeightVh, isDrawerDragging, useDrawerDrag } from './scene'
import RegionSection from './RegionSection.vue'
import type { RegionAccessItem } from '@/api/pass_region_public'

const emit = defineEmits<{
  /** 框选动作（start/stop/undo/clear）：由父组件 index.vue 转发到 BaseScene.expose */
  (e: 'action', a: 'start' | 'stop' | 'undo' | 'clear'): void
  /** 点选/取消过境记录（null = 取消）：由父组件转发到 BaseScene 绘制卫星模型 / 轨道 / 扫描区域 */
  (e: 'pick', rec: RegionAccessItem | null): void
  /** 播放 / 暂停沿 AOS→LOS 的卫星飞行 */
  (e: 'play'): void
  /** 播放进度定位（ratio 0~1） */
  (e: 'seek', ratio: number): void
  (e: 'close'): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'region'" class="side-panel region-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">区域过境</b>
          <span class="sp-count">框选多边形现算</span>
          <span class="sp-meta">在地球上框选区域 → 选 24 / 48 / 72h 窗口，现算该区域的过境卫星列表</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="emit('close')">»</button>
      </div>

      <RegionSection
        @action="(a) => emit('action', a)"
        @pick="(r) => emit('pick', r)"
        @play="emit('play')"
        @seek="(k) => emit('seek', k)"
      />
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 内容比一屏长（框选工具 + 进度 + 结果列表）：头部固定，内容区自己滚动 */
.region-panel {
  display: flex;
  flex-direction: column;

  :deep(.rg-wrap) {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
}
</style>
