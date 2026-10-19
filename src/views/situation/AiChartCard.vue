<script setup lang="ts">
/**
 * 智能体对话内嵌图表卡片 —— 渲染 [[chart:...]] 标记指向的统计图
 *
 * 数据来自 /cgi/stats/chart（公开只读），口径在 server/lib/statsCharts.js（单一真实来源）；
 * 本组件只负责「取数 + 用 echarts 画折线/柱状 + 暗色玻璃样式适配对话气泡」。
 *
 * 样式与对话卡一致：暗底、亮青强调色、细边圆角；高度固定 200px，随容器宽度自适应重绘。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ECharts } from 'echarts/core'
import { httpCgi } from '@/utils/request'

/** 与 server/lib/statsCharts.js 的统一返回结构对齐 */
interface ChartSeries {
  name: string
  unit?: string
  values: (number | null)[]
}
interface ChartPayload {
  type: string
  kind: 'line' | 'bar'
  title: string
  subtitle?: string
  x_label?: string
  y_label?: string
  categories: string[]
  series: ChartSeries[]
  note?: string
  source?: string
}

const props = defineProps<{ chartType: string; arg?: string; raw?: string }>()

const boxRef = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref('')
const data = ref<ChartPayload | null>(null)

let chart: ECharts | null = null
let ro: ResizeObserver | null = null
let echartsPromise: Promise<typeof import('echarts/core')> | null = null

/** 动态加载 echarts 内核（折线 + 柱状 + 提示 + 图例 + 网格 + Canvas），仅首个图表出现时触发 */
function loadEcharts() {
  if (!echartsPromise) {
    echartsPromise = (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers')
      ])
      core.use([
        charts.LineChart,
        charts.BarChart,
        components.TooltipComponent,
        components.GridComponent,
        components.LegendComponent,
        renderers.CanvasRenderer
      ])
      return core
    })()
  }
  return echartsPromise
}

/** 暗色玻璃下的图表配色：轴线/文字亮色，图例与提示器统一暗底 */
function optionOf(p: ChartPayload) {
  const axis = 'rgba(150,196,240,0.55)'
  const label = '#c8d8ee'
  const split = 'rgba(120,170,230,0.14)'
  const multi = p.series.length > 1
  return {
    backgroundColor: 'transparent',
    color: ['#7fd8ff', '#ff9f43', '#4ade80', '#c084fc', '#f87171', '#facc15'],
    grid: { left: 8, right: 12, top: multi ? 34 : 14, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(12,22,38,0.94)',
      borderColor: 'rgba(120,170,230,0.42)',
      borderWidth: 1,
      textStyle: { color: '#eaf2fc', fontSize: 11 },
      axisPointer: { lineStyle: { color: 'rgba(200,216,238,0.45)' } }
    },
    legend: multi
      ? { show: true, top: 0, textStyle: { color: label, fontSize: 11 }, itemWidth: 12, itemHeight: 8 }
      : { show: false },
    xAxis: {
      type: 'category',
      data: p.categories,
      boundaryGap: p.kind === 'bar',
      axisLine: { lineStyle: { color: axis } },
      axisTick: { show: false },
      axisLabel: { color: label, fontSize: 10, hideOverlap: true },
      name: p.x_label || '',
      nameTextStyle: { color: label, fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      splitLine: { lineStyle: { color: split } },
      axisLabel: { color: label, fontSize: 10 },
      name: p.y_label || '',
      nameTextStyle: { color: label, fontSize: 10 }
    },
    series: p.series.map((s) =>
      p.kind === 'bar'
        ? { name: s.name, type: 'bar', data: s.values, barMaxWidth: 26, itemStyle: { borderRadius: [3, 3, 0, 0] } }
        : {
            name: s.name,
            type: 'line',
            data: s.values,
            smooth: true,
            symbol: 'circle',
            symbolSize: 4,
            connectNulls: true,
            lineStyle: { width: 1.8 }
          }
    )
  }
}

/** 是否已在「容器有非零尺寸」时初始化过（0 尺寸建过画布的 echarts 不会自动补画） */
let sized = false

/** 等容器量到非零宽高：打字机逐帧重排 / 由隐藏切显示时，挂载当帧可能还没量到尺寸 */
async function waitSized(el: HTMLElement, frames = 30) {
  for (let i = 0; i < frames; i++) {
    if (el.clientWidth > 0 && el.clientHeight > 0) return
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    if (boxRef.value !== el) return // 组件已卸载 / 换元素，放弃
  }
}

/** 用当前数据重画一次（尺寸从 0 恢复后 echarts 不会自动补画，必须显式再 setOption） */
function paint() {
  const p = data.value
  if (!chart || !p) return
  chart.setOption(optionOf(p) as never, true)
  chart.resize()
}

async function render() {
  const el = boxRef.value
  const p = data.value
  if (!el || !p) return
  const core = await loadEcharts()
  if (boxRef.value !== el) return
  if (!chart) {
    await waitSized(el)
    if (boxRef.value !== el) return
    chart = core.init(el, undefined, { renderer: 'canvas' })
    sized = el.clientWidth > 0 && el.clientHeight > 0
    if (ro) ro.disconnect()
    ro = new ResizeObserver(() => {
      const cur = boxRef.value
      if (!cur || !chart || cur.clientWidth <= 0 || cur.clientHeight <= 0) return
      if (!sized) {
        sized = true
        paint() // 首次由 0 尺寸恢复：补画一次
      } else {
        chart.resize()
      }
    })
    ro.observe(el)
  }
  paint()
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const p = await httpCgi<ChartPayload>({
      url: '/stats/chart',
      method: 'get',
      params: { type: props.chartType, arg: props.arg || undefined }
    })
    data.value = p
    loading.value = false
    await render()
  } catch (e: any) {
    loading.value = false
    error.value = e?.message || '图表数据加载失败'
  }
}

// 打字机逐帧重排时 blocks 会重建，但同一位置的本组件实例不重建；参数变化才重新取数
watch(() => [props.chartType, props.arg], load)

onMounted(load)
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div class="ai-chart">
    <div class="ac-head">
      <span class="ac-title">{{ data?.title || '统计图表' }}</span>
      <span v-if="loading" class="ac-badge">加载中…</span>
      <span v-else-if="data?.source" class="ac-badge">{{ data.source }}</span>
    </div>
    <div v-if="data?.subtitle" class="ac-sub">{{ data.subtitle }}</div>
    <div v-show="!error" ref="boxRef" class="ac-canvas"></div>
    <div v-if="error" class="ac-err">{{ error }}</div>
    <div v-if="data?.note" class="ac-note">{{ data.note }}</div>
  </div>
</template>

<style scoped>
.ai-chart {
  margin: 6px 0;
  padding: 8px 10px 6px;
  border: 1px solid rgba(127, 216, 255, 0.22);
  border-radius: 8px;
  background: rgba(10, 18, 30, 0.55);
}
.ac-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ac-title {
  font-size: 12px;
  font-weight: 600;
  color: #dceaf8;
}
.ac-badge {
  margin-left: auto;
  flex: none;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  color: #7fd8ff;
  background: rgba(127, 216, 255, 0.12);
  border: 1px solid rgba(127, 216, 255, 0.3);
}
.ac-sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #93a0b4;
}
.ac-canvas {
  width: 100%;
  height: 200px;
  margin-top: 4px;
}
.ac-err {
  padding: 16px 4px;
  font-size: 11.5px;
  color: #ff8a8a;
}
.ac-note {
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.5;
  color: #8394a8;
}
</style>
