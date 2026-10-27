<script setup lang="ts">
/**
 * 统一等级芯片（03 §15.4）：安全热力图面板与星历分析窗共用。
 *
 * 档位来自 heat/levels.ts（/cgi2/meta 覆盖文案与颜色），等级取事件字段 level，
 * 前端不计算等级。counts 为 null 时显示 "—"（服务未就绪，不显示旧数字）。
 */
import { computed } from 'vue'
import { levelDefs, colorForLevel } from './levels'
import type { HeatLevel } from './riskLevels'

const props = withDefaults(defineProps<{
  /** 各等级事件数；null = 未知（显示 —） */
  counts?: Partial<Record<HeatLevel, number>> | null
  /** 已隐藏的档位颜色（与 heatHiddenColors 同一口径） */
  off?: readonly string[]
  disabled?: boolean
  /** 需要隐藏「数据不足」档位时置 true */
  hideInsufficient?: boolean
}>(), { counts: null, off: () => [], disabled: false, hideInsufficient: false })

const emit = defineEmits<{ (e: 'toggle', level: HeatLevel): void }>()

const chips = computed(() => levelDefs.value.filter((d) => !props.hideInsufficient || d.level !== 'insufficient'))

function isOff(lv: HeatLevel): boolean {
  return props.off.includes(colorForLevel(lv))
}

function countOf(lv: HeatLevel): number | string {
  if (!props.counts) return '—'
  return props.counts[lv] ?? 0
}
</script>

<template>
  <div class="hc-chips">
    <button v-for="c in chips" :key="c.level" class="hc-chip"
      :class="{ off: isOff(c.level) }" :disabled="disabled"
      :title="isOff(c.level) ? '点击显示该等级' : '点击隐藏该等级'"
      @click="emit('toggle', c.level)">
      <i class="hc-chip-dot" :style="{ background: c.color }"></i>
      <span>{{ c.label }}</span>
      <b>{{ countOf(c.level) }}</b>
    </button>
  </div>
</template>

<style scoped lang="scss">
.hc-chips { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
.hc-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding: 0 9px;
  font-size: 11px;
  border-radius: 12px;
  cursor: pointer;
  color: #d8e2f0;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(120, 160, 220, 0.26);
  transition: opacity 0.15s, border-color 0.15s;
  b { font-size: 10.5px; color: #9fb3cf; font-weight: 600; }
  &:hover { border-color: rgba(120, 180, 255, 0.55); }
  &.off {
    opacity: 0.42;
    .hc-chip-dot { filter: grayscale(1); }
  }
  &:disabled { cursor: default; }
}
.hc-chip-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
</style>
