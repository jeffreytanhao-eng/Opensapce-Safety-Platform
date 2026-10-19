<script setup lang="ts">
/**
 * 智能体对话内嵌「事件卡」 —— 渲染 [[evt:<source>:<key>]] 标记指向的具体事件，并一键在三维中定位
 *
 * source 三类（与后端 /cgi/event/one 及 select_pass_city 链路一致）：
 *   · conj —— 碰撞预警（sat_conjunction，本项目 SGP4 初筛）
 *   · cri  —— 交会分析（sat_cri_conjunction，CRI/CRP 风险指数模型）
 *   · pass —— 过境记录（key = "<norad>:<targetId>"，targetId 即过境目标 pass_geo.id）
 *
 * conj/cri 的展示数据由前端按事件 id 查 /cgi/event/one（公开只读，非模型改写）；
 * pass 不取数（过境明细在过境面板内异步加载），仅渲染目标信息、点击后走 select_pass_city 链路定位。
 * 点击「在三维中定位」向上 emit('go', { source, key })，由对话组件转成对应动作。
 * 视觉与对话内其它卡片（AiChartCard / AiKgCard）一致：暗底、亮青强调色、细边圆角。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { httpCgi } from '@/utils/request'

/** /cgi/event/one 返回体（conj / cri 同构，CRI 额外带 cri/crp/risk_level/miss_level） */
interface EventOne {
  id: number
  tca: string
  norad_a: number
  name_a: string
  norad_b: number
  name_b: string
  min_distance?: number | null
  rel_speed?: number | null
  altitude?: number | null
  level?: number | null
  cri?: number | null
  crp?: number | null
  /** 后端算好的等级文案（前端零换算） */
  metric_text?: string
}

const props = defineProps<{ source: string; evtKey: string }>()

const emit = defineEmits<{ go: [payload: { source: string; key: string }] }>()

const loading = ref(false)
const error = ref('')
const data = ref<EventOne | null>(null)

const isPass = computed(() => props.source === 'pass')

/** pass 的 key = "<norad>:<targetId>" */
const passParts = computed(() => {
  const raw = String(props.evtKey || '')
  const idx = raw.indexOf(':')
  if (idx <= 0) return { norad: '', targetId: raw }
  return { norad: raw.slice(0, idx), targetId: raw.slice(idx + 1) }
})

const title = computed(() => {
  if (props.source === 'cri') return '交会分析事件'
  if (props.source === 'pass') return '过境记录'
  return '碰撞预警事件'
})

/** 类型徽标文案（取自各自链路口径） */
const badge = computed(() => {
  if (props.source === 'cri') return 'CRI/CRP'
  if (props.source === 'pass') return '过境'
  return '碰撞初筛'
})

async function load() {
  if (isPass.value) {
    data.value = null
    error.value = ''
    return
  }
  loading.value = true
  error.value = ''
  data.value = null
  const id = Number(props.evtKey)
  if (!(id > 0)) {
    loading.value = false
    error.value = '事件编号无效'
    return
  }
  try {
    const r = await httpCgi<EventOne | null>({
      url: '/event/one',
      method: 'get',
      params: { source: props.source === 'cri' ? 'cri' : 'conj', id }
    })
    loading.value = false
    if (!r) {
      error.value = '未找到该事件'
      return
    }
    data.value = r
  } catch (e: any) {
    loading.value = false
    error.value = e?.message || '事件数据加载失败'
  }
}

function go() {
  emit('go', { source: props.source, key: props.evtKey })
}

watch(() => [props.source, props.evtKey], load)

onMounted(load)
</script>

<template>
  <div class="ai-evt">
    <div class="ae-head">
      <span class="ae-title">{{ title }}</span>
      <span class="ae-badge">{{ badge }}</span>
      <button type="button" class="ae-go" @click="go">在三维中定位</button>
    </div>

    <!-- 过境记录：不取数，仅渲染目标信息 -->
    <template v-if="isPass">
      <div class="ae-sub">
        过境目标 #{{ passParts.targetId }}
        <span v-if="passParts.norad"> · NORAD {{ passParts.norad }}</span>
      </div>
    </template>

    <template v-else>
      <div v-if="loading" class="ae-sub">加载中…</div>
      <div v-else-if="error" class="ae-err">{{ error }}</div>
      <template v-else-if="data">
        <div class="ae-sub">
          <span class="ae-norad">{{ data.norad_a }}</span> {{ data.name_a }}
          <span class="ae-x">×</span>
          <span class="ae-norad">{{ data.norad_b }}</span> {{ data.name_b }}
        </div>
        <div class="ae-meta">
          <span>TCA {{ data.tca }} UTC</span>
          <span v-if="data.metric_text" class="ae-metric">{{ data.metric_text }}</span>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.ai-evt {
  margin: 6px 0;
  padding: 8px 10px;
  border: 1px solid rgba(127, 216, 255, 0.22);
  border-radius: 8px;
  background: rgba(10, 18, 30, 0.55);
}
.ae-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ae-title {
  font-size: 12px;
  font-weight: 600;
  color: #dceaf8;
}
.ae-badge {
  flex: none;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  color: #7fd8ff;
  background: rgba(127, 216, 255, 0.12);
  border: 1px solid rgba(127, 216, 255, 0.3);
}
.ae-go {
  margin-left: auto;
  flex: none;
  padding: 2px 9px;
  border: 1px solid rgba(127, 216, 255, 0.45);
  border-radius: 5px;
  background: rgba(127, 216, 255, 0.14);
  font: inherit;
  font-size: 11px;
  color: #7fd8ff;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.ae-go:hover {
  color: #eafcff;
  background: rgba(127, 216, 255, 0.3);
  border-color: rgba(127, 216, 255, 0.75);
}
.ae-sub {
  margin-top: 5px;
  font-size: 11.5px;
  color: #cdddf0;
  line-height: 1.6;
}
.ae-norad {
  color: #9fe4ff;
}
.ae-x {
  margin: 0 4px;
  color: #93a0b4;
}
.ae-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 3px;
  font-size: 10.5px;
  color: #93a0b4;
}
.ae-metric {
  color: #ffd54f;
}
.ae-err {
  margin-top: 5px;
  font-size: 11px;
  color: #ff8a8a;
}
</style>