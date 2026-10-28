<script setup lang="ts">
/**
 * 星历分析面板（03 §15.3，右侧滑出 / 移动端底部抽屉，由独立开关 ephOpen 控制）
 *
 * 本版口径：
 * - 上传只做本机预检 + 提交服务端解析入库（首次需确认，文件全员可见，保留 7 天）；
 * - 星历列表分「已上传星历 / 官方星历（最新一轮）」两段，均来自 heat-sidecar；
 * - 面板侧重星历信息与质量评估；威胁分析 / 热力入口 / 机动模拟已从本窗移除（热力仍走底栏独立入口）。
 * 失败 / 未连接一律用灰色卡片提示，不出现红字。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ephOpen, fmtNum, drawerHeightVh, isDrawerDragging, useDrawerDrag } from './scene'
import {
  MAX_FILE_MB,
  activeEphem, activeMeta, activeQuality,
  ephemBusy, ephemError, ephemMetas, ephemTotal,
  uploadProgress, uploadName, needConsent,
  refreshEphemList, refreshOfficial, refreshHealth,
  officialMetas, officialTotal, officialKeyword, officialPage, officialPages, OFFICIAL_PAGE_SIZE,
  activateEphem, activateOfficial, deactivateEphem,
  uploadEphemerides, consentUpload, removeUploaded,
  activeSpanH,
  qualityTle, qualityTleBusy, qualityTleError, qualityTleNorad,
} from './ephem/useUserEphemeris'
import type { EphemMeta } from '@/api/heat2'

const emit = defineEmits<{
  (e: 'close'): void
  /** 激活星历后：三维绘出该星历轨道并飞到目标 */
  (e: 'focus-set'): void
  /** 质量卡「AI 解读」：把组织好的评估指标交给智能体抽屉提问 */
  (e: 'ai-explain', text: string): void
}>()

const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const tab = ref<'uploaded' | 'official'>('uploaded')
const confirmDelId = ref('')

/* ------------------------------------------------------------------
 * 时间格式：面板统一显示 UTC+8（与安全热力图一致）
 * ---------------------------------------------------------------- */
function fmtBj(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 服务端 UTC 字符串 'YYYY-MM-DD HH:mm:ss' → UTC+8 */
function fmtBjUtc(s?: string | null): string {
  if (!s) return '—'
  const ms = Date.parse(`${String(s).replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? fmtBj(ms) : String(s)
}

/* ------------------------------------------------------------------
 * 头部 / 当前星历
 * ---------------------------------------------------------------- */
const headMeta = computed(() => {
  const m = activeMeta.value
  if (!m) return '上传高精度星历，查看轨道与质量评估'
  return `${m.name}${m.norad ? ` · NORAD ${m.norad}` : ''}`
})

const activeStart = computed(() => activeEphem.value?.states[0]?.t ?? null)
const activeStop = computed(() => {
  const st = activeEphem.value?.states
  return st?.length ? st[st.length - 1].t : null
})

const scopeText = computed(() => (activeMeta.value?.scope === 'official'
  ? '官方星历（最新一轮）· 每日轮次计算'
  : '已上传（全员可见）· 保留 7 天'))

/* ------------------------------------------------------------------
 * 列表：上传 / 官方
 * ---------------------------------------------------------------- */
const officialKw = ref('')
let kwTimer: number | undefined

function onOfficialKw() {
  if (kwTimer) window.clearTimeout(kwTimer)
  kwTimer = window.setTimeout(() => { void refreshOfficial(officialKw.value, 1) }, 300)
}

function goOfficialPage(p: number) {
  if (p < 1 || p > officialPages.value) return
  void refreshOfficial(officialKeyword.value, p)
}

function switchTab(t: 'uploaded' | 'official') {
  tab.value = t
  if (t === 'uploaded') void refreshEphemList()
  else void refreshOfficial(officialKeyword.value, officialPage.value)
}

async function choose(id: string) {
  if (activeEphem.value?.id === id) {
    deactivateEphem()
    return
  }
  if (await activateEphem(id)) emit('focus-set')
}

async function chooseOfficial(m: EphemMeta) {
  if (activeEphem.value?.id === m.id) {
    deactivateEphem()
    return
  }
  await activateOfficial(m)
  emit('focus-set')
}

function askDelete(id: string) {
  if (confirmDelId.value === id) {
    confirmDelId.value = ''
    void removeUploaded(id)
    return
  }
  confirmDelId.value = id
  window.setTimeout(() => { if (confirmDelId.value === id) confirmDelId.value = '' }, 3000)
}

function pickFiles() { fileInput.value?.click() }

function onFileChange(e: Event) {
  const el = e.target as HTMLInputElement
  const files = Array.from(el.files || [])
  el.value = ''
  if (files.length) void uploadEphemerides(files)
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length) void uploadEphemerides(files)
}

/* ------------------------------------------------------------------
 * 切换星历后清掉删除确认
 * ---------------------------------------------------------------- */
watch(activeEphem, () => {
  confirmDelId.value = ''
})

/* ------------------------------------------------------------------
 * 质量评估
 * ---------------------------------------------------------------- */
function askAi() {
  const q = activeQuality.value
  const m = activeMeta.value
  if (!q) return
  const lines = [
    '请解读这份高精度星历的质量评估：',
    `- 卫星：${m?.name || activeEphem.value?.name || '—'}（NORAD ${m?.norad ?? '—'}）`,
    `- 格式：${(m?.format || '').toUpperCase()}；覆盖 ${activeSpanH.value.toFixed(1)} 小时；${m?.hasCov ? '含' : '不含'}协方差`,
    `- 自洽性 RMS：${q.selfConsistencyRmsKm != null && Number.isFinite(q.selfConsistencyRmsKm) ? `${q.selfConsistencyRmsKm.toFixed(3)} km` : '—'}`,
    `- 与 TLE 外推偏差：${q.tleRmsKm != null && Number.isFinite(q.tleRmsKm) ? `RMS ${q.tleRmsKm.toFixed(2)} km / 最大 ${fmtNum(q.tleMaxKm || 0, 2)} km` : '未评估'}`,
    `- 综合评分：${q.score}/100（${q.grade}）`,
    `- 提示：${q.notes.length ? q.notes.join('；') : '无'}`,
    '请说明这份星历是否适合用于交会筛查，主要不确定度来源与改进建议。'
  ]
  emit('ai-explain', lines.join('\n'))
}

/* ------------------------------------------------------------------
 * 生命周期
 * ---------------------------------------------------------------- */
let refreshTimer = 0

function loadAll() {
  void refreshEphemList()
  void refreshOfficial(officialKeyword.value, officialPage.value)
  void refreshHealth()
}

onMounted(() => {
  loadAll()
  refreshTimer = window.setInterval(() => {
    if (ephOpen.value && tab.value === 'uploaded') void refreshEphemList()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
})

watch(ephOpen, (v) => { if (v) loadAll() })
</script>

<template>
  <transition name="panel">
    <aside v-if="ephOpen" class="side-panel ephem-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">星历分析</b>
          <span class="sp-meta">{{ headMeta }}</span>
        </div>
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起星历分析" @click="emit('close')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5 Z" /></svg>
        </button>
      </div>

      <div class="ep-scroll">
        <!-- 分段：已上传 / 官方（最新一轮） -->
        <div class="ep-seg">
          <button class="ep-seg-btn" :class="{ on: tab === 'uploaded' }" @click="switchTab('uploaded')">已上传星历</button>
          <button class="ep-seg-btn" :class="{ on: tab === 'official' }" @click="switchTab('official')">官方星历（最新一轮）</button>
        </div>

        <!-- 已上传星历：拖拽上传 + 列表 -->
        <div v-if="tab === 'uploaded'" class="ep-sec">
          <div class="ep-drop" :class="{ on: dragOver, busy: ephemBusy }"
            @click="pickFiles"
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop">
            <input ref="fileInput" class="ep-file" type="file" multiple
              accept=".itc,.txt,.oem,.ocm,.e,.json" @change="onFileChange" />
            <b>拖拽或点击上传星历</b>
            <span>支持 ITC（Starlink MEME）/ CCSDS OEM / OCM · 单文件 ≤ {{ MAX_FILE_MB }} MB · 先在本机解析</span>
          </div>

          <!-- 首次上传确认（文件会离开本机） -->
          <div v-if="needConsent" class="ep-consent">
            <b>上传后全员可见</b>
            <p>星历文件会提交到服务器解析并保存 7 天，系统内所有使用者都能看到。确认上传？</p>
            <div class="ep-consent-acts">
              <button class="ep-mini is-primary" @click="consentUpload(true)">确认上传</button>
              <button class="ep-mini" @click="consentUpload(false)">取消</button>
            </div>
          </div>

          <div v-if="ephemBusy && uploadName" class="ep-progress">
            <div class="ep-bar"><i :style="{ width: uploadProgress + '%' }"></i></div>
            <span>{{ uploadName }} · {{ uploadProgress }}%</span>
          </div>

          <div v-if="ephemError" class="ep-warn">{{ ephemError }}</div>

          <div v-if="ephemMetas.length" class="ep-list">
            <div v-for="m in ephemMetas" :key="m.id" class="ep-item"
              :class="{ on: m.id === activeMeta?.id }" @click="choose(m.id)">
              <div class="ep-item-main">
                <b class="ep-item-name" :title="m.name">{{ m.name }}</b>
                <span class="ep-tag">{{ (m.format || '').toUpperCase() }}</span>
                <span class="ep-tag" :class="{ cov: m.hasCov }">{{ m.hasCov ? '含协方差' : '无协方差' }}</span>
              </div>
              <div class="ep-item-sub">
                <span>NORAD {{ m.norad || '—' }}</span>
                <span>{{ m.points.toLocaleString() }} 点 / {{ m.stepS }} s</span>
                <span>{{ fmtBjUtc(m.startUtc) }} ~ {{ fmtBjUtc(m.stopUtc) }}（UTC+8）</span>
              </div>
              <button class="ep-del" :title="confirmDelId === m.id ? '再次点击确认删除' : '删除这份星历'"
                :class="{ on: confirmDelId === m.id }" @click.stop="askDelete(m.id)">
                {{ confirmDelId === m.id ? '确认' : '×' }}
              </button>
            </div>
          </div>
          <div v-else-if="!ephemBusy" class="ep-empty">
            {{ ephemTotal ? '列表读取中…' : '尚未上传星历，拖入 ITC / OEM / OCM 文件即可分析' }}
          </div>
        </div>

        <!-- 官方星历（最新一轮） -->
        <div v-else class="ep-sec">
          <div class="ep-search">
            <input v-model="officialKw" class="ep-input" type="text"
              placeholder="按 NORAD 或名称筛选" @input="onOfficialKw" />
            <button class="ep-mini" @click="refreshOfficial(officialKw, 1)">刷新</button>
          </div>
          <div v-if="ephemError" class="ep-warn">{{ ephemError }}</div>
          <div v-if="officialMetas.length" class="ep-list">
            <div v-for="m in officialMetas" :key="m.id" class="ep-item"
              :class="{ on: m.id === activeMeta?.id }" @click="chooseOfficial(m)">
              <div class="ep-item-main">
                <b class="ep-item-name" :title="m.name">{{ m.name }}</b>
                <span class="ep-tag" :class="{ cov: m.hasCov }">{{ m.hasCov ? '含协方差' : '无协方差' }}</span>
              </div>
              <div class="ep-item-sub">
                <span>NORAD {{ m.norad || '—' }}</span>
                <span>{{ m.points.toLocaleString() }} 点 / {{ m.stepS }} s</span>
                <span>{{ fmtBjUtc(m.startUtc) }} ~ {{ fmtBjUtc(m.stopUtc) }}（UTC+8）</span>
              </div>
            </div>
          </div>
          <div v-else class="ep-empty">{{ officialTotal ? '列表读取中…' : '暂无官方星历（等待 heat-sidecar 生成）' }}</div>
          <div v-if="officialTotal > OFFICIAL_PAGE_SIZE" class="ep-pager">
            <button class="ep-mini" :disabled="officialPage <= 1" @click="goOfficialPage(officialPage - 1)">上一页</button>
            <span>{{ officialPage }} / {{ officialPages }}</span>
            <button class="ep-mini" :disabled="officialPage >= officialPages" @click="goOfficialPage(officialPage + 1)">下一页</button>
          </div>
        </div>

        <!-- 当前星历卡片 -->
        <div v-if="activeMeta" class="ep-card">
          <div class="ep-card-top">
            <b>{{ activeMeta.name }}</b>
            <span class="ep-tag">{{ (activeMeta.format || '').toUpperCase() }}</span>
            <span class="ep-tag" :class="{ cov: activeMeta.hasCov, muted: !activeMeta.hasCov }">
              {{ activeMeta.hasCov ? '含协方差' : '协方差无' }}
            </span>
          </div>
          <div class="ep-card-sub">
            NORAD {{ activeMeta.norad || '—' }}（取自 MEME id）· {{ activeMeta.points.toLocaleString() }} 点 / {{ activeMeta.stepS }} s
          </div>
          <div class="ep-card-sub">
            {{ fmtBjUtc(activeMeta.startUtc) }} → {{ fmtBjUtc(activeMeta.stopUtc) }}（UTC+8）· {{ scopeText }}
          </div>
          <div class="ep-card-acts">
            <button class="ep-mini" @click="deactivateEphem">取消载入</button>
            <button v-if="activeMeta.scope === 'uploaded'" class="ep-mini"
              :class="{ 'is-armed': confirmDelId === activeMeta.id }"
              @click="askDelete(activeMeta.id)">
              {{ confirmDelId === activeMeta.id ? '确认删除' : '删除' }}
            </button>
          </div>
        </div>

        <!-- 折叠卡：星历信息 / 质量评估 -->
        <details v-if="activeEphem" class="ep-fold">
          <summary>星历信息</summary>
          <div class="ep-kv">
            <div class="ep-kv-row"><span>名称</span><b>{{ activeEphem.name }}</b></div>
            <div class="ep-kv-row"><span>NORAD</span><b>{{ activeEphem.norad || '—' }}</b></div>
            <div class="ep-kv-row"><span>格式 / 坐标系</span><b>{{ activeEphem.format.toUpperCase() }} · {{ activeEphem.frame }}</b></div>
            <div class="ep-kv-row"><span>有效期(UTC+8)</span><b>{{ fmtBj(activeStart) }} ~ {{ fmtBj(activeStop) }}</b></div>
            <div class="ep-kv-row"><span>步长 / 点数</span><b>{{ activeEphem.stepSec }} s · {{ activeEphem.states.length.toLocaleString() }}</b></div>
            <div class="ep-kv-row"><span>协方差</span><b>{{ activeMeta?.hasCov ? '有' : '无' }}</b></div>
          </div>
        </details>

        <details v-if="activeEphem && activeQuality" class="ep-fold">
          <summary>质量评估</summary>
          <div class="ep-quality">
            <div class="ep-q-head">
              <span class="ep-q-label">综合评分</span>
              <span class="ep-q-score" :style="{ color: activeQuality.score >= 80 ? '#4fd18b' : activeQuality.score >= 60 ? '#f2c14e' : '#93a4bd' }">
                {{ activeQuality.score }}<i>/100</i>
              </span>
              <span class="ep-q-grade">{{ activeQuality.grade }}</span>
              <button class="ep-q-ai" @click="askAi">AI 解读</button>
            </div>
            <div class="ep-kv">
              <div class="ep-kv-row"><span>自洽性 RMS</span>
                <b>{{ activeQuality.selfConsistencyRmsKm != null && Number.isFinite(activeQuality.selfConsistencyRmsKm) ? `${fmtNum(activeQuality.selfConsistencyRmsKm, 3)} km` : '—' }}</b>
              </div>
              <div class="ep-kv-row"><span>覆盖时长</span><b>{{ activeSpanH.toFixed(1) }} 小时</b></div>
              <div class="ep-kv-row"><span>协方差</span><b>{{ activeMeta?.hasCov ? '有' : '无' }}</b></div>
            </div>
            <ul v-if="activeQuality.notes.length" class="ep-notes">
              <li v-for="(n, i) in activeQuality.notes" :key="i">{{ n }}</li>
            </ul>
          </div>

          <div class="ep-tle">
            <div class="ep-tle-head">
              <b>TLE 外推偏差</b>
              <span class="ep-tle-norad">{{ qualityTleNorad ? `NORAD ${qualityTleNorad}` : '' }}</span>
            </div>
            <div v-if="qualityTleBusy" class="ep-tle-note">比对中…</div>
            <div v-else-if="qualityTle" class="ep-tle-note">
              RMS {{ fmtNum(qualityTle.rmsKm, 2) }} km · 最大 {{ fmtNum(qualityTle.maxKm, 2) }} km
            </div>
            <div v-else-if="qualityTleError" class="ep-tle-note">{{ qualityTleError }}</div>
          </div>
        </details>

        <div class="ep-foot">
          <span>星历信息与质量评估</span>
          <span>热力入口见底栏</span>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;

/* 本面板是实体内容面板（上传 / 参数 / 列表都要可点），整体恢复事件；
   其它列表面板为「空白处点击穿透到画布」才默认 pointer-events:none */
.side-panel.ephem-panel { pointer-events: auto; user-select: text; }

/* 收起按钮与左侧「太空安全目标列表」同规格：脱离文档流钉在头部右侧，两者顶端对齐（同为面板顶 +8px） */
.side-panel .sp-head .sp-close.sp-close-tri { position: absolute; right: 10px; top: 8px; }

/* 桌面端：停靠右侧（与右侧详情同侧），滑入方向也改为自右向左；
   移动端仍是底部抽屉（html.is-mobile .side-panel 的 left/right/top/bottom 规则优先级更高，这里不覆盖） */
@media (min-width: 769px) {
  .side-panel.ephem-panel {
    left: auto;
    right: 0;
    z-index: 8;
  }
  .ephem-panel.panel-enter-from,
  .ephem-panel.panel-leave-to { transform: translateX(100%); }
}

/* 面板内容滚动区：头部固定，其余整体滚动 */
.ep-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-top: 8px;
  scrollbar-width: thin; scrollbar-color: rgba(120,160,220,0.35) transparent; }

.ep-sec { padding: 8px 0 10px; border-bottom: 1px solid rgba(120,160,220,0.12);
  &:last-child { border-bottom: 0; } }
.ep-sec-title { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; font-weight: 700;
  color: #cfe0f5; letter-spacing: 0.3px; margin-bottom: 7px;
  .ep-sec-sub { font-size: 10px; font-weight: 400; color: #7d92b0; } }

/* 分段控件 */
.ep-seg { display: flex; gap: 6px; padding: 2px 0 8px; }
.ep-seg-btn { flex: 1 1 0; min-width: 0; height: 28px; font-size: 11.5px; border-radius: 6px; cursor: pointer;
  color: #a7b6cc; background: rgba(255,255,255,0.05);
  border: 1px solid rgba(120,160,220,0.28);
  &:hover { color: #d7e6fb; border-color: rgba(120,165,225,0.5); }
  &.on { color: #eaf4ff; border-color: #4c9aff; background: rgba(38,92,156,0.75); } }

/* 上传区 */
.ep-drop { position: relative; border: 1px dashed rgba(110,160,230,0.42); border-radius: 8px;
  background: rgba(30,60,110,0.18); padding: 14px 10px; text-align: center; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  display: flex; flex-direction: column; gap: 4px;
  b { font-size: 11.5px; color: #dbe9fb; }
  span { font-size: 10px; color: #8ea4c4; }
  &:hover, &.on { background: rgba(50,100,180,0.26); border-color: #4f8de0; }
  &.busy { pointer-events: none; opacity: 0.7; } }
.ep-file { display: none; }

/* 上传确认卡 */
.ep-consent { margin-top: 7px; padding: 8px 9px; border-radius: 7px;
  background: rgba(60,80,120,0.22); border: 1px solid rgba(120,160,220,0.28);
  b { font-size: 11px; color: #ffd98a; }
  p { margin: 4px 0 6px; font-size: 10px; line-height: 1.5; color: #a7b6cc; }
  .ep-consent-acts { display: flex; gap: 6px; } }

.ep-progress { display: flex; align-items: center; gap: 8px; margin-top: 6px;
  span { font-size: 10px; color: #8ea4c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
.ep-bar { flex: 1 1 auto; height: 4px; border-radius: 2px; background: rgba(120,160,220,0.2); overflow: hidden;
  i { display: block; height: 100%; background: linear-gradient(90deg, #3f9dff, #6fe0ff); transition: width 0.2s; } }

/* 失败 / 未连接：灰色卡片（不显示红字） */
.ep-warn { margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  font-size: 10px; line-height: 1.5; color: #a7b6cc;
  background: rgba(140,160,190,0.12); border: 1px solid rgba(140,160,190,0.26);
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ep-empty { font-size: 10.5px; color: #7d92b0; padding: 10px 2px; text-align: center;
  &.is-sm { padding: 8px 0; } }
.ep-tip { margin-top: 6px; font-size: 9.5px; line-height: 1.5; color: #8b9bb5; }

/* 输入 / 小按钮 */
.ep-input { flex: 1 1 auto; min-width: 0; height: 26px; padding: 0 8px; font-size: 11px; border-radius: 5px;
  color: #e6edf7; background: rgba(20,28,44,0.96); border: 1px solid rgba(120,160,220,0.28);
  outline: none; color-scheme: dark; box-sizing: border-box;
  &:focus { border-color: #4fc3f7; }
  &::placeholder { color: #7d8ba3; }
  &.is-sm { flex: 0 0 66px; height: 24px; } }
.ep-search { display: flex; gap: 6px; margin-bottom: 7px; }
.ep-mini { flex: none; height: 24px; padding: 0 9px; font-size: 10.5px; border-radius: 5px; cursor: pointer;
  color: #cfdcea; background: rgba(255,255,255,0.06); border: 1px solid rgba(120,160,220,0.28);
  &:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #e6edf7; }
  &:disabled { opacity: 0.45; cursor: default; }
  &.is-primary { color: #eaf4ff; border-color: rgba(90,160,255,0.55); background: rgba(45,105,205,0.55); }
  &.is-armed { color: #ffd98a; border-color: rgba(242,193,78,0.6); background: rgba(242,193,78,0.16); } }

/* 星历列表 */
.ep-list { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
.ep-item { position: relative; padding: 7px 46px 7px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  &:hover { background: rgba(40,80,140,0.44); border-color: rgba(120,175,255,0.4); }
  &.on { border-color: #4f8de0; background: rgba(50,100,180,0.42); } }
.ep-item-main { display: flex; align-items: center; gap: 5px; min-width: 0;
  .ep-item-name { flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: #eaf2fc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
.ep-tag { flex: none; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 3px;
  color: #9dbbdd; background: rgba(110,160,230,0.16); border: 1px solid rgba(110,160,230,0.22);
  &.cov { color: #6fe0c0; background: rgba(80,220,180,0.12); border-color: rgba(80,220,180,0.28); }
  &.muted { color: #ffd98a; background: rgba(242,193,78,0.12); border-color: rgba(242,193,78,0.3); } }
.ep-item-sub { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px;
  span { font-size: 9.5px; color: #8ea4c4; } }
.ep-del { position: absolute; top: 5px; right: 5px; min-width: 18px; height: 18px; padding: 0 4px;
  line-height: 16px; border-radius: 4px; border: 0; background: transparent; color: #7d92b0;
  font-size: 13px; cursor: pointer;
  &:hover { background: rgba(255,90,90,0.18); color: #ffb0b0; }
  &.on { font-size: 9.5px; color: #ffd98a; background: rgba(242,193,78,0.18); } }
.ep-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding-top: 8px;
  span { font-size: 10.5px; color: #93a4bd; } }

/* 当前星历卡片 */
.ep-card { margin: 8px 0; padding: 8px 9px; border-radius: 8px;
  background: rgba(38,92,156,0.28); border: 1px solid rgba(90,160,255,0.42); }
.ep-card-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  b { font-size: 12px; color: #eaf4ff; } }
.ep-card-sub { margin-top: 4px; font-size: 9.5px; line-height: 1.5; color: #a7b6cc; }
.ep-card-acts { display: flex; gap: 6px; margin-top: 6px; }

/* 折叠卡 */
.ep-fold { border-bottom: 1px solid rgba(120,160,220,0.12);
  summary { padding: 8px 0; font-size: 11px; font-weight: 700; color: #cfe0f5; cursor: pointer;
    list-style: none; position: relative;
    &::-webkit-details-marker { display: none; }
    &::after { content: '▾'; position: absolute; right: 2px; color: #7d92b0; font-size: 9px; }
  }
  &:not([open]) summary::after { content: '▸'; }
  > *:last-child { padding-bottom: 10px; } }
.ep-kv { display: flex; flex-direction: column; gap: 4px; }
.ep-kv-row { display: flex; align-items: baseline; gap: 8px; font-size: 10.5px;
  span { flex: none; width: 84px; color: #8ea4c4; }
  b { flex: 1 1 auto; min-width: 0; color: #eaf2fc; font-weight: 600; word-break: break-all; } }

/* 质量卡 */
.ep-quality { padding: 2px 0; }
.ep-q-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px;
  .ep-q-label { font-size: 10.5px; color: #8ea4c4; }
  .ep-q-score { font-size: 16px; font-weight: 800; line-height: 1;
    i { font-size: 10px; font-style: normal; font-weight: 400; opacity: 0.7; } }
  .ep-q-grade { font-size: 11px; font-weight: 700; color: #cfe0f5; }
  .ep-q-ai { margin-left: auto; align-self: center; padding: 2px 7px; font-size: 9.5px; line-height: 1.4;
    color: #9fc6ff; background: rgba(46,96,168,0.35); border: 1px solid rgba(110,160,230,0.42);
    border-radius: 4px; cursor: pointer;
    &:hover { color: #dbe9fb; background: rgba(62,120,200,0.5); } } }
.ep-notes { margin: 6px 0 0; padding-left: 14px;
  li { font-size: 9.5px; line-height: 1.5; color: #8ea4c4; } }
.ep-tle { margin-top: 7px; padding: 7px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.28); border: 1px solid rgba(110,150,210,0.18); }
.ep-tle-head { display: flex; align-items: baseline; gap: 8px;
  b { font-size: 10.5px; color: #cfe0f5; } }
.ep-tle-norad { margin-left: auto; font-size: 9px; color: #7d92b0; }
.ep-tle-note { margin-top: 4px; font-size: 9.5px; line-height: 1.5; color: #8b9bb5; }

.ep-foot { display: flex; justify-content: space-between; gap: 8px; padding: 10px 0 24px;
  font-size: 9px; color: #6f819c; }

/* 小屏微调 */
@media (max-width: 720px) {
  .ep-kv-row span { width: 74px; }
  .ep-events { max-height: none; }
}
</style>
