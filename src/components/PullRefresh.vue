<script setup lang="ts">
/**
 * 移动端下拉刷新组件
 * 用法：<PullRefresh @refresh="loadData">
 *   <div>列表内容</div>
 * </PullRefresh>
 */
import { ref } from 'vue'

const emit = defineEmits<{ refresh: [] }>()

const pulling = ref(false)
const refreshing = ref(false)
const pullDistance = ref(0)
const startY = ref(0)
const PULL_THRESHOLD = 60

function onTouchStart(e: TouchEvent) {
  if (refreshing.value) return
  // 只在内容区滚动到顶部时才触发
  const main = e.currentTarget as HTMLElement
  if (main.scrollTop > 0) return
  startY.value = e.touches[0].clientY
  pulling.value = true
}

function onTouchMove(e: TouchEvent) {
  if (!pulling.value || refreshing.value) return
  const main = e.currentTarget as HTMLElement
  if (main.scrollTop > 0) {
    pulling.value = false
    pullDistance.value = 0
    return
  }
  const dy = e.touches[0].clientY - startY.value
  if (dy > 0) {
    // 阻止默认滚动行为（避免页面被拉）
    e.preventDefault()
    // 衰减效果
    pullDistance.value = Math.min(dy * 0.4, 80)
  }
}

function onTouchEnd() {
  if (!pulling.value) return
  pulling.value = false
  if (pullDistance.value >= PULL_THRESHOLD) {
    refreshing.value = true
    pullDistance.value = 40
    emit('refresh')
  } else {
    pullDistance.value = 0
  }
}

function done() {
  refreshing.value = false
  pullDistance.value = 0
}

defineExpose({ done })
</script>

<template>
  <div
    class="m-pull-refresh"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend.passive="onTouchEnd"
    :style="{ '--pull-y': pullDistance + 'px' }"
  >
    <!-- 下拉指示器 -->
    <div
      class="m-pull-indicator"
      :class="{ spinning: refreshing, ready: pullDistance >= PULL_THRESHOLD && !refreshing }"
      :style="{ transform: `translateY(${pullDistance}px)` }"
    >
      <el-icon v-if="!refreshing"><ArrowDown /></el-icon>
      <el-icon v-else><Loading /></el-icon>
      <span v-if="refreshing">刷新中...</span>
      <span v-else-if="pullDistance >= PULL_THRESHOLD">释放刷新</span>
      <span v-else>下拉刷新</span>
    </div>
    <!-- 内容 -->
    <div :style="{ transform: `translateY(${pullDistance}px)` }" class="m-pull-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.m-pull-refresh {
  position: relative;
  overflow: hidden;
  height: 100%;
  -webkit-overflow-scrolling: touch;
  overflow-y: auto;
}
.m-pull-content {
  transition: transform 0.15s ease;
  will-change: transform;
}
.m-pull-indicator {
  position: absolute;
  top: 0;
  left: 0; right: 0;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 13px;
  gap: 6px;
  z-index: 1;
  .el-icon {
    font-size: 16px;
    transition: transform 0.15s;
  }
  &.ready .el-icon {
    transform: rotate(180deg);
  }
  &.spinning .el-icon {
    animation: m-rot 0.8s linear infinite;
  }
}
@keyframes m-rot {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
