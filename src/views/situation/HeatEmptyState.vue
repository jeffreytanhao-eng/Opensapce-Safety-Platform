<script setup lang="ts">
/**
 * 热力空状态卡（03 §11.5）
 *  - reason = SIDECAR_DOWN：热力计算服务未连接（/cgi2 无响应）
 *  - reason = CORE_NOT_LOADED：核心算法模块未加载（sidecar 处于 stub）
 *  - reason = DB_DOWN：sidecar 数据库不可用
 * 灰色虚线卡片，不显示红字、不显示任何旧计数；两个标签都可能出现该状态。
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  reason: '' | 'SIDECAR_DOWN' | 'CORE_NOT_LOADED' | 'DB_DOWN'
  loading?: boolean
}>()
const emit = defineEmits<{ (e: 'retry'): void }>()

const open = ref(false)

const title = computed(() => {
  if (props.reason === 'CORE_NOT_LOADED') return '核心算法模块未加载'
  if (props.reason === 'DB_DOWN') return '热力计算服务数据库不可用'
  return '热力计算服务未连接'
})

const detail = computed(() => {
  if (props.reason === 'CORE_NOT_LOADED') return 'heat-sidecar 已启动，但未加载核心算法模块（HEAT_CORE_PATH 未配置）。'
  if (props.reason === 'DB_DOWN') return 'heat-sidecar 已启动，但数据库连接异常，暂时无法读取事件。'
  return '本标签由 heat-sidecar 计算；当前 /cgi2/health 无响应。'
})
</script>

<template>
  <div class="heat-empty-card">
    <div class="hec-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
        <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </svg>
    </div>
    <b class="hec-title">{{ title }}</b>
    <p class="hec-desc">
      {{ detail }}<br />
      两个标签都由 heat-sidecar 计算。
    </p>
    <div class="hec-actions">
      <button class="hec-btn" :disabled="loading" @click="emit('retry')">{{ loading ? '重试中…' : '重试' }}</button>
      <button class="hec-link" @click="open = !open">运维排查说明 {{ open ? '▾' : '›' }}</button>
    </div>
    <ol v-if="open" class="hec-steps">
      <li><code>Test-NetConnection 127.0.0.1 -Port 1236</code>，确认 heat-sidecar 正在监听。</li>
      <li><code>curl http://127.0.0.1:1236/cgi2/health</code>，预期返回 <code>code:0</code> 且 <code>core:"ready"</code>。</li>
      <li>经 vite/nginx 访问 <code>/cgi2/health</code>，返回 HTML 或 404 说明代理未生效。</li>
    </ol>
  </div>
</template>

<style scoped lang="scss">
.heat-empty-card {
  margin: 10px 0 4px;
  padding: 20px 16px 16px;
  border: 1px dashed rgba(140, 165, 195, 0.38);
  border-radius: 10px;
  background: rgba(18, 26, 40, 0.55);
  text-align: center;
  pointer-events: auto;
}
.hec-icon {
  width: 34px;
  height: 34px;
  margin: 0 auto 8px;
  color: #6f819c;
  svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.4; }
}
.hec-title { font-size: 12.5px; color: #c3cfdf; font-weight: 700; }
.hec-desc { margin: 6px 0 10px; font-size: 11px; line-height: 1.6; color: #7d8ba3; }
.hec-actions { display: flex; align-items: center; justify-content: center; gap: 10px; }
.hec-btn {
  height: 26px;
  padding: 0 12px;
  font-size: 11.5px;
  border-radius: 6px;
  cursor: pointer;
  color: #d7e6fb;
  background: rgba(120, 160, 220, 0.16);
  border: 1px solid rgba(120, 160, 220, 0.4);
  &:hover:not(:disabled) { background: rgba(120, 160, 220, 0.28); }
  &:disabled { opacity: 0.6; cursor: default; }
}
.hec-link { font-size: 11px; color: #7fb0ff; background: none; border: 0; cursor: pointer; }
.hec-steps {
  margin: 10px auto 0;
  padding-left: 18px;
  max-width: 420px;
  text-align: left;
  li { font-size: 10.5px; line-height: 1.7; color: #8b9bb5; }
  code { color: #a9c6ea; font-size: 10px; }
}
</style>
