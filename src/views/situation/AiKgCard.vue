<script setup lang="ts">
/**
 * 智能体对话内嵌知识图谱卡片 —— 渲染 [[kg:<type>:<key>]] 标记指向的关联关系图
 *
 * 数据来自 /cgi/kg/neighbors（公开只读），口径的单一真实来源是 server/lib/knowledgeGraph.js；
 * 本组件只负责「取数 + 用 KgMiniGraph.vue 画一张冻结布局的关系图 + 类型图例」，
 * 视觉与对话内图表卡片（AiChartCard.vue）保持一致：暗底、亮青强调色、细边圆角。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { getKgNeighborsPublic } from '@/api/sat_public'
import { TYPE_LABELS, TYPE_COLORS } from './kg'
import type { KgNeighbors, KgType } from './kg'
import KgMiniGraph from './KgMiniGraph.vue'

const props = defineProps<{ kgType: string; arg?: string; raw?: string }>()

const loading = ref(true)
const error = ref('')
const data = ref<KgNeighbors | null>(null)

/** 邻居类型图例（不含中心节点类型），按数量倒序 */
const legend = computed(() => {
  const d = data.value
  if (!d) return [] as { type: KgType; count: number }[]
  const counts = new Map<KgType, number>()
  for (const t of Object.keys(d.totals || {}) as KgType[]) {
    if (t !== d.center.type && d.totals[t] > 0) counts.set(t, d.totals[t])
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
})

async function load() {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    data.value = await getKgNeighborsPublic({
      type: props.kgType,
      key: props.arg || '',
      perEdge: 30
    })
    loading.value = false
  } catch (e: any) {
    loading.value = false
    error.value = e?.message || '图谱数据加载失败'
  }
}

// 打字机逐帧重排时 blocks 会重建，但同一位置的本组件实例不重建；参数变化才重新取数
watch(() => [props.kgType, props.arg], load)

onMounted(load)
</script>

<template>
  <div class="ai-kg">
    <div class="ak-head">
      <span class="ak-title">{{ data ? `${TYPE_LABELS[data.center.type]}：${data.center.name}` : '知识图谱' }}</span>
      <span v-if="loading" class="ak-badge">加载中…</span>
    </div>
    <div v-if="data?.center.sub" class="ak-sub">{{ data.center.sub }}</div>
    <div v-show="!error" class="ak-canvas">
      <KgMiniGraph
        v-if="data"
        :nodes="data.nodes"
        :edges="data.edges"
        :center-id="data.center.id"
      />
    </div>
    <div v-if="error" class="ak-err">{{ error }}</div>
    <div v-if="data && !error" class="ak-legend">
      <span v-for="l in legend" :key="l.type" class="ak-leg">
        <i class="ak-dot" :style="{ background: TYPE_COLORS[l.type] }"></i>
        {{ TYPE_LABELS[l.type] }} · {{ l.count }}
      </span>
      <span v-if="!legend.length" class="ak-empty">暂无关联</span>
    </div>
  </div>
</template>

<style scoped>
.ai-kg {
  margin: 6px 0;
  padding: 8px 10px 6px;
  border: 1px solid rgba(127, 216, 255, 0.22);
  border-radius: 8px;
  background: rgba(10, 18, 30, 0.55);
}
.ak-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ak-title {
  font-size: 12px;
  font-weight: 600;
  color: #dceaf8;
}
.ak-badge {
  margin-left: auto;
  flex: none;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  color: #7fd8ff;
  background: rgba(127, 216, 255, 0.12);
  border: 1px solid rgba(127, 216, 255, 0.3);
}
.ak-sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #93a0b4;
}
.ak-canvas {
  width: 100%;
  height: 200px;
  margin-top: 4px;
}
.ak-err {
  padding: 16px 4px;
  font-size: 11.5px;
  color: #ff8a8a;
}
.ak-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 4px;
  font-size: 10.5px;
  color: #93a0b4;
}
.ak-leg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ak-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.ak-empty {
  color: #8394a8;
}
</style>
