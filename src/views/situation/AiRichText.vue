<script setup lang="ts">
/**
 * 智能体正文渲染：把模型回答（轻量 Markdown + [[chart:...]] / [[kg:...]] 标记）渲染成富文本
 *
 * 解析交给 aiMarkdown.ts（转义后自拼标签，故可安全 v-html）；
 * 图表块交给 AiChartCard.vue，图谱块交给 AiKgCard.vue，事件块交给 AiEventCard.vue；
 * 「猜你想问」候选项渲染成可点击链接，点击仅回填输入框（向上 emit('pick')），不直接发送。
 * 正文里的行内事件标记（表格单元格 / 段落中的 [[evt:...]]）渲染成「定位」按钮，
 * 由根节点事件委托统一向上 emit('go')，交给对话组件定位到三维场景的对应事件。
 * 本组件不持有状态，纯「文本进 → 视图出」，方便在打字机逐字刷新时反复重算。
 */
import { computed } from 'vue'
import { parseAiMarkdown } from './aiMarkdown'
import type { MdBlock } from './aiMarkdown'
import AiChartCard from './AiChartCard.vue'
import AiKgCard from './AiKgCard.vue'
import AiEventCard from './AiEventCard.vue'

const props = defineProps<{ text: string; typing?: boolean }>()

const emit = defineEmits<{
  pick: [text: string]
  /** 事件定位：{ source: conj|cri|pass, key: 事件 id / pass 的 <norad>:<targetId> } */
  go: [payload: { source: string; key: string }]
}>()

/** 行内「定位」按钮（v-html 注入，不带 scoped）事件委托：解析 data-evt="source:key" 后向上 emit */
function onMdClick(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.('.md-evt') as HTMLElement | null
  if (!el) return
  const raw = el.getAttribute('data-evt') || ''
  const idx = raw.indexOf(':')
  if (idx <= 0) return
  emit('go', { source: raw.slice(0, idx), key: raw.slice(idx + 1) })
}

/** 打字光标（注入到最后一个文本块的行内 HTML 末尾，跟着文字走，而不是另起一行） */
const CURSOR = '<span class="tk-cursor"></span>'

/**
 * 打字进行中：末尾若有**未闭合**的 [[ 标记（如「…[[evt:conj:12」），先截掉再解析 ——
 * 否则标记原文会一闪而过，等 ]] 到齐才整体渲染成卡片。已闭合的标记不受影响。
 */
function typingSafeText(s: string): string {
  const open = s.lastIndexOf('[[')
  if (open === -1) return s
  return s.indexOf(']]', open) === -1 ? s.slice(0, open) : s
}

const blocks = computed<MdBlock[]>(() => {
  const raw = props.text || ''
  const list = parseAiMarkdown(props.typing ? typingSafeText(raw) : raw)
  if (!props.typing || !list.length) return list
  const b = list[list.length - 1]
  if (b.type === 'p' || b.type === 'h') b.html = (b.html || '') + CURSOR
  else if ((b.type === 'ul' || b.type === 'ol') && b.items?.length) {
    b.items[b.items.length - 1] += CURSOR
  }
  return list
})
</script>

<template>
  <div class="md" @click="onMdClick">
    <template v-for="(b, i) in blocks" :key="i">
      <p v-if="b.type === 'p'" class="md-p" v-html="b.html"></p>
      <p v-else-if="b.type === 'h'" class="md-h" v-html="b.html"></p>
      <ul v-else-if="b.type === 'ul'" class="md-list">
        <li v-for="(it, j) in b.items" :key="j" v-html="it"></li>
      </ul>
      <ol v-else-if="b.type === 'ol'" class="md-list">
        <li v-for="(it, j) in b.items" :key="j" v-html="it"></li>
      </ol>
      <div v-else-if="b.type === 'table'" class="md-table-wrap">
        <table class="md-table">
          <thead>
            <tr><th v-for="(c, j) in b.head" :key="j" v-html="c"></th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, ri) in b.rows" :key="ri">
              <td v-for="(c, ci) in r" :key="ci" v-html="c"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre v-else-if="b.type === 'code'" class="md-pre"><code>{{ b.text }}</code></pre>
      <hr v-else-if="b.type === 'hr'" class="md-hr" />
      <div v-else-if="b.type === 'guess'" class="md-guess">
        <button
          v-for="(it, j) in b.items"
          :key="j"
          type="button"
          class="md-guess-item"
          @click="emit('pick', it)"
        >{{ it }}</button>
      </div>
      <AiKgCard v-else-if="b.type === 'kg'" :kg-type="b.kgType || ''" :arg="b.arg" :raw="b.raw" />
      <AiChartCard v-else-if="b.type === 'chart'" :chart-type="b.chartType || ''" :arg="b.arg" :raw="b.raw" />
      <AiEventCard
        v-else-if="b.type === 'evt'"
        :source="b.evtSource || ''"
        :evt-key="b.evtKey || ''"
        @go="(p) => emit('go', p)"
      />
    </template>
  </div>
</template>

<style scoped>
.md {
  font-size: inherit;
  line-height: inherit;
  word-break: break-word;
}
.md-p {
  margin: 0 0 6px;
}
.md-p:last-child {
  margin-bottom: 0;
}
.md-h {
  margin: 8px 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: #eaf2fc;
}
.md-list {
  margin: 4px 0 6px;
  padding-left: 20px;
}
.md-list li {
  margin: 2px 0;
}
.md-table-wrap {
  margin: 6px 0;
  overflow-x: auto;
  border-radius: 6px;
  border: 1px solid rgba(127, 216, 255, 0.18);
}
.md-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 11.5px;
}
.md-table th,
.md-table td {
  padding: 5px 8px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid rgba(127, 216, 255, 0.12);
  border-right: 1px solid rgba(127, 216, 255, 0.1);
}
.md-table th:last-child,
.md-table td:last-child {
  border-right: none;
}
.md-table tbody tr:last-child td {
  border-bottom: none;
}
.md-table th {
  color: #a9d8f7;
  font-weight: 600;
  background: rgba(127, 216, 255, 0.1);
}
.md-table td {
  color: #dbe6f2;
}
.md-table tbody tr:nth-child(even) {
  background: rgba(255, 255, 255, 0.03);
}
.md-pre {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow-x: auto;
}
.md-pre code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #c8e6ff;
}
.md-hr {
  margin: 8px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}
/* 「猜你想问」候选项：链接样式，点击仅回填输入框（不发送） */
.md-guess {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 4px 0 2px;
}
.md-guess-item {
  display: inline-block;
  max-width: 100%;
  padding: 1px 0;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  color: #7fd8ff;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  transition: color 0.15s;
}
.md-guess-item::before {
  content: '· ';
  text-decoration: none;
}
.md-guess-item:hover {
  color: #b8ecff;
}
/* v-html 注入的行内标签不带 scoped 属性，需用 :deep 命中 */
.md :deep(.md-code) {
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #9fe4ff;
  background: rgba(127, 216, 255, 0.14);
}
.md :deep(.md-a) {
  color: #7fd8ff;
  text-decoration: underline;
}
.md :deep(strong) {
  color: #eaf2fc;
  font-weight: 700;
}
/* 行内事件「定位」按钮（v-html 注入，需 :deep 命中）：表格单元格 / 段落里点击后定位到三维事件 */
.md :deep(.md-evt) {
  display: inline-block;
  padding: 0 5px;
  margin: 0 1px;
  border: 1px solid rgba(127, 216, 255, 0.4);
  border-radius: 4px;
  background: rgba(127, 216, 255, 0.12);
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  color: #7fd8ff;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.md :deep(.md-evt:hover) {
  color: #eafcff;
  background: rgba(127, 216, 255, 0.26);
  border-color: rgba(127, 216, 255, 0.7);
}
/* 打字光标：由 :typing 注入到最后一个文本块的行内 HTML 末尾，需 :deep 命中（v-html 不带 scoped） */
.md :deep(.tk-cursor) {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 1px;
  vertical-align: -2px;
  background: #7fd8ff;
  animation: tk-blink 0.9s steps(1, end) infinite;
}
@keyframes tk-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}
</style>
