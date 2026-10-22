<script setup lang="ts">
/**
 * 星历分析面板（桌面右侧滑出 / 移动端底部抽屉，由独立开关 ephOpen 控制）
 *
 * 对标 SpaceX Space Safety Platform 的「高精度星历 + 快速交会筛选」：
 * - 上传 / 内置样本 → 解析（ITC / OEM / OCM）→ 本机 IndexedDB 持久化；
 * - 激活后三维绘出该星历的完整轨道与当前位置；
 * - 一键与在轨目录做 24h / 48h / 72h 交会筛选（Worker 内粗筛 + 精筛 + Pc 计算）；
 * - 事件列表点击即在三维中定位并高亮该次接近。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ephOpen, fmtNum, drawerHeightVh, isDrawerDragging, useDrawerDrag } from './scene'
import {
  MAX_FILE_MB,
  activeEphem, activeQuality, ephemBusy, ephemError, ephemMetas,
  qualityTle, qualityTleBusy, qualityTleError, qualityTleNorad, qualityTleNote,
  qualityCompare, qualityCompareId, qualityCompareBusy, qualityCompareError, setQualityCompare,
  uploadProgress, uploadName, builtinSamples, loadBuiltinIndex, loadBuiltinSample,
  refreshEphemList, activateEphem, deactivateEphem, removeEphem, uploadEphemerides,
  threatEvents, threatSelected, screening, screenProgress, screenError, screenStats,
  runScreening, selectThreat, DEFAULT_SCREEN,
  maneuverConfig, maneuverStates, maneuverBurnMs, maneuverDvMps, maneuverError,
  applyManeuver, clearManeuver,
  maneuverCompare, maneuverCompareBusy, maneuverCompareError,
  type ScreenParams, type BuiltinSample, type ManeuverDir
} from './ephem/useUserEphemeris'
import type { PairCompareRow } from './ephem/screening'
import type { ThreatEvent } from './ephem/types'
import { getSet } from './ephem/store'

const emit = defineEmits<{
  (e: 'close'): void
  /** 激活星历后：三维绘出该星历轨道并飞到目标 */
  (e: 'focus-set'): void
  /** 点选一条威胁事件：三维定位并高亮（null = 取消） */
  (e: 'focus-event', ev: ThreatEvent | null): void
  /** 质量卡「AI 解读」：把组织好的评估指标交给智能体抽屉提问 */
  (e: 'ai-explain', text: string): void
}>()

const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

/** 筛选参数（面板可调；默认 24h / 50 km / Pc 1e-6） */
const params = ref<ScreenParams>({ ...DEFAULT_SCREEN })

/* ---- 机动仿真（脉冲机动） ----
 * 只做「参数 + 双轨迹」：时刻（TCA 前 N 分钟 / 星历起点、中点）+ 方向（RTN）+ 幅值，
 * 应用后由 store 的 maneuverStates 驱动三维叠加「原方案虚线 + 机动后实线」。 */
const MAN_DIRS: { v: ManeuverDir; label: string }[] = [
  { v: 'T', label: '沿迹' }, { v: 'R', label: '径向' }, { v: 'N', label: '法向' }
]
interface ManPreset { key: string; label: string; needTca: boolean }
const MAN_PRESETS: ManPreset[] = [
  { key: 'tca60', label: 'TCA-60min', needTca: true },
  { key: 'tca30', label: 'TCA-30min', needTca: true },
  { key: 'tca10', label: 'TCA-10min', needTca: true },
  { key: 'start1h', label: '起点+1h', needTca: false },
  { key: 'mid', label: '星历中点', needTca: false }
]
const manDirLabel = computed(() => MAN_DIRS.find((d) => d.v === maneuverConfig.value.dir)?.label || '')
const manAtText = computed(() => {
  const at = maneuverConfig.value.atMs
  return at == null ? '未选择' : `${fmtUtc(at, true)} UTC`
})

/** 星历实际数据范围（内置样本的元数据跨度可能长于状态序列，机动时刻以真实数据为准） */
const manRange = computed(() => {
  const set = activeEphem.value
  if (!set) return null
  if (!set.states.length) return { t0: set.start, t1: set.stop }
  return { t0: set.states[0].t, t1: set.states[set.states.length - 1].t }
})

/** 预设 → 绝对时刻（TCA 类需先选中一条威胁事件） */
function presetMs(key: string): number | null {
  const r = manRange.value
  if (!r) return null
  if (key === 'mid') return (r.t0 + r.t1) / 2
  if (key.startsWith('tca')) {
    const tca = threatSelected.value?.tca
    if (tca == null) return null
    return tca + (key === 'tca60' ? -60 : key === 'tca30' ? -30 : -10) * 60000
  }
  return r.t0 + 3600e3
}
function pickPreset(key: string) {
  const r = manRange.value
  const ms = presetMs(key)
  if (!r || ms == null) return
  maneuverConfig.value.atMs = Math.min(Math.max(ms, r.t0), r.t1)
}
function onApplyManeuver() { applyManeuver() }
function onClearManeuver() { clearManeuver() }

/** Pc 文本：0 表示低于模型分辨率 */
function pcText(pc?: number) {
  if (pc == null) return '—'
  return pc > 0 ? pc.toExponential(1) : '0'
}
/** TCA 相对改动（分钟）；TCA 早于机动时刻的接近不受本次机动影响 */
function tcaShiftText(r: PairCompareRow) {
  if (!r.after) return '—'
  if (maneuverBurnMs.value != null && r.before.tca <= maneuverBurnMs.value) return 'TCA 早于机动'
  const m = (r.after.tca - r.before.tca) / 60000
  return Math.abs(m) < 0.1 ? 'TCA 不变' : `TCA ${m > 0 ? '+' : ''}${m.toFixed(1)} min`
}
/** 机动后是改善（绿）还是恶化（红）：距离变大 / Pc 变小视为改善 */
function cmpClass(r: PairCompareRow, kind: 'miss' | 'pc') {
  if (!r.after) return ''
  if (kind === 'miss') return r.after.missKm >= r.before.missKm ? 'is-up' : 'is-down'
  return r.after.pc <= r.before.pc ? 'is-up' : 'is-down'
}

/** 选中威胁事件后默认把机动时刻定在 TCA 前 60 分钟（用户可再改） */
watch(threatSelected, (ev) => {
  const r = manRange.value
  if (!ev || !r) return
  maneuverConfig.value.atMs = Math.min(Math.max(ev.tca - 60 * 60000, r.t0), r.t1)
})

const activeName = computed(() => activeEphem.value?.name || '')
const activeMeta = computed(() => ephemMetas.value.find((m) => m.id === activeEphem.value?.id) || null)

/** 事件分档配色（与三维标记同一套） */
const LEVEL_COLOR: Record<ThreatEvent['level'], string> = {
  high: '#ff6b6b',
  medium: '#ffb454',
  low: '#7fb0ff'
}
const LEVEL_TEXT: Record<ThreatEvent['level'], string> = { high: '高危', medium: '警告', low: '关注' }

/** 质量分配色 */
const gradeColor = computed(() => {
  const s = activeQuality.value?.score ?? 0
  return s >= 85 ? '#4ad991' : s >= 70 ? '#7fb0ff' : s >= 50 ? '#ffb454' : '#ff6b6b'
})

/** TLE 偏差分档（km，仅示意量级）：绝对偏差随 TLE 历元变旧而增大，
 *  同一目标差到几百 km 属常见，超过 500 km 更可能是目标不匹配或数据异常 */
const tleGrade = computed(() => {
  const r = qualityTle.value
  if (!r) return null
  const v = r.rmsKm
  if (v < 10) return { label: '优秀', color: '#4ad991' }
  if (v < 100) return { label: '良好', color: '#7fb0ff' }
  if (v < 500) return { label: '可用', color: '#ffb454' }
  return { label: '偏差大', color: '#ff8f8f' }
})

/** 偏差-时间折线（SVG 240×46，纵向留 3px 边距） */
const tleCurve = computed(() => {
  const r = qualityTle.value
  if (!r || r.points.length < 2) return ''
  const t0 = r.points[0].t
  const span = Math.max(1, r.points[r.points.length - 1].t - t0)
  const max = Math.max(1, r.maxKm)
  return r.points
    .map((p) => `${(((p.t - t0) / span) * 240).toFixed(1)},${(41 - (p.dist / max) * 38).toFixed(1)}`)
    .join(' ')
})

/** 可对比的同目标星历（同名或同 NORAD，且不是当前激活项） */
const compareCandidates = computed(() => {
  const a = activeEphem.value
  if (!a) return []
  const nm = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ')
  const an = nm(a.name)
  return ephemMetas.value.filter(
    (m) => m.id !== a.id && ((an !== '' && nm(m.name) === an) || (a.norad > 0 && m.norad === a.norad))
  )
})

function onCompareChange(e: Event) {
  void setQualityCompare((e.target as HTMLSelectElement).value)
}

/** NEES 展示：任一侧无协方差时无法计算 */
const neesText = computed(() => {
  const n = qualityCompare.value?.nees
  if (n == null || !Number.isFinite(n) || n <= 0) return '—（任一侧无协方差，无法计算）'
  return `${n.toFixed(2)}（理想 1）`
})

/** 组织评估指标，交给智能体抽屉生成中文解读（不新增模型能力，只复用既有问答） */
function aiExplain() {
  const set = activeEphem.value
  const q = activeQuality.value
  if (!set || !q) return
  const scRms = q.selfConsistencyRmsKm
  const scText = typeof scRms === 'number' && Number.isFinite(scRms) ? `${scRms.toFixed(3)} km` : '未计算'
  const lines: string[] = [
    '请基于以下高精度星历质量评估结果，用中文给出简明解读（只依据已给出的数据，不要编造）：',
    '',
    `对象：${set.name}（NORAD ${set.norad || '—'}），格式 ${set.format.toUpperCase()} / ${set.frame}`,
    `时段：${fmtUtc(set.states[0]?.t ?? set.start, true)} ~ ${fmtUtc(set.states[set.states.length - 1]?.t ?? set.stop, true)} UTC，共 ${set.states.length} 点，步长 ${set.stepSec}s`,
    `综合评分：${q.score}/100（${q.grade}）`,
    `- 自洽性 RMS：${scText}` + `${qualityCompare.value ? '（同目标两份文件重叠时段口径）' : '（单文件插值残差）'}`
  ]
  const c = qualityCompare.value
  if (c) {
    lines.push(`- 双文件对比：重叠 RMS ${c.rmsKm.toFixed(3)} km / 最大 ${c.maxKm.toFixed(3)} km，漂移 ${c.driftKmPerDay.toFixed(2)} km/天，重叠 ${(c.commonSec / 3600).toFixed(1)} h`)
    lines.push(`- NEES：${Number.isFinite(c.nees) && c.nees > 0 ? `${c.nees.toFixed(2)}（理想值 1）` : '无法计算（任一侧缺协方差）'}`)
  } else {
    lines.push('- 双文件对比：未选择对比星历')
    lines.push('- NEES：无法计算（需要同目标另一份带协方差的星历）')
  }
  const t = qualityTle.value
  if (t) {
    lines.push(`- 与 TLE 外推：RMS ${t.rmsKm.toFixed(1)} km / 最大 ${t.maxKm.toFixed(1)} km`
      + `（径向 ${t.radialRmsKm.toFixed(1)} / 沿迹 ${t.alongRmsKm.toFixed(1)} / 横向 ${t.crossRmsKm.toFixed(1)} km），TLE 历元早于星历 ${t.epochLagDays.toFixed(1)} 天`)
  } else if (qualityTleBusy.value) {
    lines.push('- 与 TLE 外推：计算中')
  } else {
    lines.push(`- 与 TLE 外推：不可用（${qualityTleError.value || '未计算'}）`)
  }
  if (q.notes.length) lines.push(`- 评估备注：${q.notes.join('；')}`)
  lines.push('')
  lines.push('请按以下结构回答：1) 一句话结论（能否直接用于 72h 交会筛选）；2) 主要风险点；3) 2-3 条具体处置建议。')
  emit('ai-explain', lines.join('\n'))
}

/** 导出某份星历为 JSON（含完整状态表，协方差转普通数组便于其它工具读取） */
async function exportSet(id: string) {
  try {
    const set = await getSet(id)
    if (!set) {
      ephemError.value = '导出失败：星历已不存在'
      return
    }
    const payload = {
      ...set,
      states: set.states.map((s) => ({
        t: s.t,
        r: [s.r[0], s.r[1], s.r[2]],
        v: [s.v[0], s.v[1], s.v[2]],
        ...(s.cov ? { cov: Array.from(s.cov) } : {})
      }))
    }
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(set.name || 'ephemeris').replace(/[\\/:*?"<>|]/g, '_')}-${set.norad || 'x'}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    ephemError.value = (e as Error)?.message || '导出失败'
  }
}

function fmtUtc(ms?: number, withSec = false) {
  if (!ms || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const base = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  return withSec ? `${base}:${p(d.getUTCSeconds())}` : base
}

function sizeText(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes)) return '—'
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/** 元数据预计占用（状态点 × 7 个 float64 的粗略值） */
function metaSize(points: number, hasCov: boolean) {
  return sizeText(points * (hasCov ? 7 * 8 + 36 * 8 : 7 * 8))
}

onMounted(() => {
  void refreshEphemList().then(() => loadBuiltinIndex())
})

function pickFiles() {
  fileInput.value?.click()
}

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

async function chooseSet(id: string) {
  // 已激活的星历再点一次 = 取消激活：列表去掉高亮，三维图层 / 目标与准星一并收起
  if (activeEphem.value?.id === id) {
    deactivateEphem()
    emit('focus-set')
    return
  }
  await activateEphem(id)
  emit('focus-set')
}

async function dropSet(id: string) {
  const wasActive = activeEphem.value?.id === id
  await removeEphem(id)
  // 删掉的正是当前激活的那份：通知三维清掉轨迹、目标标记与准星
  if (wasActive) emit('focus-set')
}

async function chooseBuiltin(s: BuiltinSample) {
  await loadBuiltinSample(s)
  if (activeEphem.value) emit('focus-set')
}

function pickEvent(ev: ThreatEvent) {
  // 已选中的行再点仍保持选中并重新定位（取消高亮用「取消高亮」按钮，避免误触把画面清掉）
  selectThreat(ev)
  emit('focus-event', ev)
}

function clearEvent() {
  selectThreat(null)
  emit('focus-event', null)
}

function startScreen() {
  void runScreening(params.value).then(() => {
    // 筛选完成后默认选中第一条最近的接近，用户可继续点其它条目
    if (threatEvents.value.length) pickEvent(threatEvents.value[0])
  })
}
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
          <span class="sp-count">{{ ephemMetas.length }} 份星历</span>
          <span class="sp-meta">{{ activeName || '上传高精度星历，生成交会威胁分析' }}</span>
        </div>
        <!-- 收起按钮：向右三角（与左侧「太空安全目标列表」收起键配套，方向相反） -->
        <button class="sp-close sp-close-tri" title="收起（点底部菜单可再次展开）" aria-label="收起星历分析" @click="emit('close')">
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5 Z" /></svg>
        </button>
      </div>

      <div class="ep-scroll">
        <!-- 上传 -->
        <div class="ep-sec">
          <div class="ep-sec-title">我的星历</div>
          <div class="ep-drop" :class="{ on: dragOver, busy: ephemBusy }"
            @click="pickFiles"
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop">
            <input ref="fileInput" class="ep-file" type="file" multiple
              accept=".itc,.txt,.oem,.ocm,.e,.json" @change="onFileChange" />
            <b>点击或拖拽星历文件到此处</b>
            <span>支持 ITC（Starlink MEME）/ CCSDS OEM / OCM，单文件 ≤ {{ MAX_FILE_MB }} MB</span>
          </div>
          <div v-if="ephemBusy && uploadName" class="ep-progress">
            <div class="ep-bar"><i :style="{ width: uploadProgress + '%' }"></i></div>
            <span>{{ uploadName }} · {{ uploadProgress }}%</span>
          </div>
          <div v-if="ephemError" class="ep-err">{{ ephemError }}</div>

          <div v-if="ephemMetas.length" class="ep-list">
            <div v-for="m in ephemMetas" :key="m.id" class="ep-item"
              :class="{ on: m.id === activeEphem?.id }"
              @click="chooseSet(m.id)">
              <div class="ep-item-main">
                <b class="ep-item-name" :title="m.name">{{ m.name }}</b>
                <span class="ep-tag">{{ m.format.toUpperCase() }}</span>
                <span class="ep-tag" :class="{ cov: m.hasCov }">{{ m.hasCov ? '含协方差' : '无协方差' }}</span>
                <span class="ep-tag">{{ m.source === 'builtin' ? '样本' : '上传' }}</span>
              </div>
              <div class="ep-item-sub">
                <span>NORAD {{ m.norad || '—' }}</span>
                <span>{{ fmtUtc(m.start) }} ~ {{ fmtUtc(m.stop) }} UTC</span>
                <span>{{ m.points.toLocaleString() }} 点 / {{ m.stepSec }}s</span>
                <span>{{ metaSize(m.points, m.hasCov) }}</span>
              </div>
              <button class="ep-dl" title="导出为 JSON（含完整状态表）" @click.stop="exportSet(m.id)">⇩</button>
              <button class="ep-del" title="删除这份星历" @click.stop="dropSet(m.id)">×</button>
            </div>
          </div>
          <div v-else-if="!ephemBusy" class="ep-empty">还没有星历文件，可先载入下方内置样本体验</div>
        </div>

        <!-- 内置样本 -->
        <div v-if="builtinSamples.length" class="ep-sec">
          <div class="ep-sec-title">内置星历样本<span class="ep-sec-sub">Starlink 官方公开星历 · 72h / 60s</span></div>
          <div class="ep-list is-builtin">
            <div v-for="s in builtinSamples" :key="s.norad" class="ep-item is-builtin"
              @click="chooseBuiltin(s)">
              <div class="ep-item-main">
                <b class="ep-item-name" :title="`${s.name} · NORAD ${s.norad}`">{{ s.name }}</b>
                <span class="ep-tag">{{ s.points.toLocaleString() }} 点</span>
              </div>
              <span class="ep-load">{{ s.loaded ? '重新载入' : '载入' }}</span>
            </div>
          </div>
        </div>

        <!-- 当前星历信息 + 质量 -->
        <div v-if="activeEphem" class="ep-sec">
          <div class="ep-sec-title">星历信息</div>
          <div class="ep-kv">
            <div class="ep-kv-row"><span>名称</span><b>{{ activeEphem.name }}</b></div>
            <div class="ep-kv-row"><span>NORAD</span><b>{{ activeEphem.norad || '—' }}</b></div>
            <div class="ep-kv-row"><span>格式 / 坐标系</span><b>{{ activeEphem.format.toUpperCase() }} · {{ activeEphem.frame }}</b></div>
            <div class="ep-kv-row"><span>有效期(UTC)</span><b>{{ fmtUtc(activeEphem.states[0]?.t ?? activeEphem.start, true) }} ~ {{ fmtUtc(activeEphem.states[activeEphem.states.length - 1]?.t ?? activeEphem.stop, true) }}</b></div>
            <div class="ep-kv-row"><span>步长 / 点数</span><b>{{ activeEphem.stepSec }} s · {{ activeEphem.states.length.toLocaleString() }}</b></div>
            <div class="ep-kv-row"><span>协方差</span><b>{{ activeMeta?.hasCov ? '含 6×6 协方差（Pc 更可信）' : '不含，Pc 按经验误差估计' }}</b></div>
          </div>

          <div v-if="activeQuality" class="ep-quality">
            <div class="ep-q-head">
              <span class="ep-q-label">星历质量</span>
              <b class="ep-q-score" :style="{ color: gradeColor }">{{ activeQuality.score }}<i>/100</i></b>
              <span class="ep-q-grade" :style="{ color: gradeColor }">{{ activeQuality.grade }}</span>
              <button class="ep-q-ai" title="把当前评估指标交给智能体生成中文解读" @click="aiExplain">AI 解读</button>
            </div>
            <div class="ep-kv-row is-sub"><span>{{ qualityCompare ? '自洽性 RMS（对比）' : '自洽性 RMS' }}</span>
              <b>{{ Number.isFinite(activeQuality.selfConsistencyRmsKm) ? `${fmtNum(activeQuality.selfConsistencyRmsKm, 3)} km` : '—' }}</b>
            </div>

            <!-- 双文件对比：同目标新旧两份星历的重叠 RMS / 漂移 / NEES -->
            <div class="ep-kv-row is-sub">
              <span>对比星历</span>
              <select class="ep-q-sel" :value="qualityCompareId" @change="onCompareChange">
                <option value="">{{ compareCandidates.length ? '选择同目标另一份星历…' : '暂无可比星历' }}</option>
                <option v-for="m in compareCandidates" :key="m.id" :value="m.id">
                  {{ m.name }} · {{ fmtUtc(m.start) }}
                </option>
              </select>
            </div>
            <div v-if="qualityCompareBusy" class="ep-q-hint">正在对比两份星历…</div>
            <div v-else-if="qualityCompareError" class="ep-q-hint is-err">{{ qualityCompareError }}</div>
            <template v-else-if="qualityCompare">
              <div class="ep-kv-row is-sub"><span>重叠 RMS / 最大</span>
                <b>{{ fmtNum(qualityCompare.rmsKm, 3) }} / {{ fmtNum(qualityCompare.maxKm, 3) }} km</b></div>
              <div class="ep-kv-row is-sub"><span>漂移 / 重叠</span>
                <b>{{ fmtNum(qualityCompare.driftKmPerDay, 2) }} km/天 · {{ (qualityCompare.commonSec / 3600).toFixed(1) }} h</b></div>
              <div class="ep-kv-row is-sub"><span>NEES</span><b>{{ neesText }}</b></div>
            </template>

            <ul v-if="activeQuality.notes.length" class="ep-notes">
              <li v-for="(n, i) in activeQuality.notes" :key="i">{{ n }}</li>
            </ul>
          </div>

          <!-- 与编目 TLE 外推的偏差（量级参考，不并入总分） -->
          <div class="ep-tle">
            <div class="ep-q-head">
              <span class="ep-q-label">TLE 外推偏差</span>
              <b v-if="tleGrade" class="ep-q-grade" :style="{ color: tleGrade.color }">{{ tleGrade.label }}</b>
              <span v-if="qualityTleNorad" class="ep-tle-norad">NORAD {{ qualityTleNorad }}</span>
            </div>
            <div v-if="qualityTleBusy" class="ep-empty is-sm">正在与编目 TLE 外推比对…</div>
            <div v-else-if="qualityTleError" class="ep-empty is-sm">{{ qualityTleError }}</div>
            <template v-else-if="qualityTle">
              <div class="ep-kv">
                <div class="ep-kv-row is-sub"><span>RMS / 最大</span>
                  <b>{{ fmtNum(qualityTle.rmsKm, 2) }} / {{ fmtNum(qualityTle.maxKm, 2) }} km</b></div>
                <div class="ep-kv-row is-sub"><span>径向 / 沿迹 / 横向</span>
                  <b>{{ fmtNum(qualityTle.radialRmsKm, 2) }} / {{ fmtNum(qualityTle.alongRmsKm, 2) }} / {{ fmtNum(qualityTle.crossRmsKm, 2) }} km</b></div>
                <div class="ep-kv-row is-sub"><span>TLE 历元</span>
                  <b>{{ fmtUtc(qualityTle.tleEpochMs, true) }} UTC · 早于星历 {{ qualityTle.epochLagDays.toFixed(1) }} 天</b></div>
              </div>
              <svg class="ep-tle-curve" viewBox="0 0 240 46" preserveAspectRatio="none" aria-label="TLE 偏差-时间曲线">
                <line x1="0" y1="45" x2="240" y2="45" stroke="rgba(120,160,220,0.25)" stroke-width="1" />
                <polyline :points="tleCurve" fill="none" stroke="#7fb0ff" stroke-width="1.2" />
              </svg>
              <div class="ep-tle-axis">
                <span>{{ fmtUtc(qualityTle.points[0].t) }}</span>
                <span>峰值 {{ fmtNum(qualityTle.maxKm, 1) }} km</span>
                <span>{{ fmtUtc(qualityTle.points[qualityTle.points.length - 1].t) }}</span>
              </div>
            </template>
            <div v-if="qualityTleNote" class="ep-tle-note">{{ qualityTleNote }}</div>
            <div v-if="qualityTle" class="ep-tle-note">
              参考 TLE 为编目外推，偏差含 TLE 自身误差与坐标系差异，仅作量级参考
            </div>
          </div>
        </div>

        <!-- 机动仿真（脉冲机动：参数 + 双轨迹） -->
        <div v-if="activeEphem" class="ep-sec">
          <div class="ep-sec-title">机动仿真<span class="ep-sec-sub">脉冲机动 · 原方案 / 机动后双轨迹</span></div>
          <div class="ep-man-time"><span>机动时刻</span><b>{{ manAtText }}</b></div>
          <div class="ep-man-presets">
            <button v-for="p in MAN_PRESETS" :key="p.key" class="ep-man-p"
              :disabled="p.needTca && !threatSelected"
              :title="p.needTca && !threatSelected ? '需先在威胁事件中选中一条' : ''"
              @click="pickPreset(p.key)">{{ p.label }}</button>
          </div>
          <div class="ep-man-row">
            <span class="ep-man-label">方向 (RTN)</span>
            <div class="ep-man-dirs">
              <button v-for="d in MAN_DIRS" :key="d.v" :class="{ on: maneuverConfig.dir === d.v }"
                @click="maneuverConfig.dir = d.v">{{ d.label }}</button>
            </div>
          </div>
          <div class="ep-man-row is-amp">
            <span class="ep-man-label">Δv</span>
            <input type="range" min="0.05" max="2" step="0.05" v-model.number="maneuverConfig.dvMps" class="ep-man-range" />
            <b class="ep-man-val">{{ maneuverConfig.dvMps.toFixed(2) }} m/s</b>
          </div>
          <button class="ep-run" :disabled="!maneuverConfig.atMs" @click="onApplyManeuver">
            {{ maneuverStates ? '重新施加机动' : '应用机动' }}
          </button>
          <div v-if="maneuverError" class="ep-err">{{ maneuverError }}</div>
          <div v-if="maneuverStates" class="ep-man-done">
            <div class="ep-man-done-row">
              <span>已施加 Δv {{ maneuverDvMps.toFixed(2) }} m/s · {{ manDirLabel }}</span>
              <button class="ep-ev-clear" @click="onClearManeuver">清除机动</button>
            </div>
            <span class="ep-man-legend"><i class="is-orig"></i>原方案（虚线） <i class="is-new"></i>机动后（实线）</span>
          </div>

          <!-- 机动前后对比：对威胁列表 Top-20 做同口径单对重筛 -->
          <div class="ep-cmp">
            <div class="ep-cmp-head">
              <b>机动前后对比</b>
              <span v-if="maneuverCompareBusy">重筛中 {{ Math.round(screenProgress * 100) }}%</span>
              <span v-else-if="maneuverCompare.length">Top {{ maneuverCompare.length }} · 前 → 后</span>
            </div>
            <div v-if="maneuverCompareError" class="ep-err">{{ maneuverCompareError }}</div>
            <div v-else-if="!maneuverCompare.length && !maneuverCompareBusy" class="ep-empty is-sm">
              施加机动后，在此对比 Top 20 交会的 TCA / 最小距离 / Pc（需先完成威胁筛选）
            </div>
            <div v-else class="ep-cmp-list">
              <div v-for="r in maneuverCompare" :key="r.norad" class="ep-cmp-item"
                :title="`TCA ${fmtUtc(r.before.tca, true)} → ${r.after ? fmtUtc(r.after.tca, true) : '—'} UTC`">
                <div class="ep-cmp-top">
                  <span class="ep-cmp-name">{{ r.name }}</span>
                  <span class="ep-cmp-dt">{{ tcaShiftText(r) }}</span>
                </div>
                <div class="ep-cmp-mid">
                  <span>距离 {{ fmtNum(r.before.missKm, 2) }} → <b :class="cmpClass(r, 'miss')">{{ r.after ? fmtNum(r.after.missKm, 2) : '—' }}</b> km</span>
                  <span>Pc {{ pcText(r.before.pc) }} → <b :class="cmpClass(r, 'pc')">{{ r.after ? pcText(r.after.pc) : '—' }}</b></span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 威胁筛选 -->
        <div v-if="activeEphem" class="ep-sec">
          <div class="ep-sec-title">威胁筛选<span class="ep-sec-sub">与在轨目录做快速交会分析</span></div>
          <div class="ep-params">
            <label class="ep-param">
              <span>时间窗</span>
              <select v-model.number="params.windowH">
                <option :value="6">6 小时</option>
                <option :value="12">12 小时</option>
                <option :value="24">24 小时</option>
                <option :value="48">48 小时</option>
                <option :value="72">72 小时</option>
              </select>
            </label>
            <label class="ep-param">
              <span>报告距离</span>
              <select v-model.number="params.maxDistKm">
                <option :value="10">10 km</option>
                <option :value="25">25 km</option>
                <option :value="50">50 km</option>
                <option :value="100">100 km</option>
              </select>
            </label>
            <label class="ep-param">
              <span>粗筛步长</span>
              <select v-model.number="params.coarseStepSec">
                <option :value="120">120 s</option>
                <option :value="300">300 s</option>
                <option :value="600">600 s</option>
              </select>
            </label>
          </div>
          <button class="ep-run" :disabled="screening" @click="startScreen">
            {{ screening ? `筛选中 ${Math.round(screenProgress * 100)}%` : '开始威胁筛选' }}
          </button>
          <div v-if="screening" class="ep-bar is-run"><i :style="{ width: Math.round(screenProgress * 100) + '%' }"></i></div>
          <div v-if="screenError" class="ep-err">{{ screenError }}</div>
          <div v-if="screenStats" class="ep-stat">
            目录 {{ screenStats.catalog.toLocaleString() }} 个 ·
            同轨道带 {{ screenStats.kept.toLocaleString() }} 个 ·
            窗口 {{ screenStats.windowH.toFixed(0) }} h ·
            耗时 {{ (screenStats.ms / 1000).toFixed(1) }} s
          </div>

          <div class="ep-events">
            <div class="ep-ev-head">
              <b>威胁事件</b>
              <span>{{ threatEvents.length }} 条</span>
              <button v-if="threatSelected" class="ep-ev-clear" @click="clearEvent">取消高亮</button>
            </div>
            <div v-if="!threatEvents.length && !screening" class="ep-empty is-sm">
              暂无结果，点击上方按钮开始筛选
            </div>
            <div v-for="ev in threatEvents" :key="ev.id" class="ep-ev"
              :class="{ on: threatSelected?.id === ev.id }"
              @click="pickEvent(ev)">
              <div class="ep-ev-top">
                <span class="ep-ev-name" :title="ev.otherName">{{ ev.otherName }}</span>
                <span class="ep-ev-miss" :style="{ color: LEVEL_COLOR[ev.level] }">{{ fmtNum(ev.missKm, 2) }} km</span>
              </div>
              <div class="ep-ev-sub">
                <span class="ep-dot" :style="{ background: LEVEL_COLOR[ev.level] }"></span>
                <span>{{ LEVEL_TEXT[ev.level] }}</span>
                <span>{{ fmtUtc(ev.tca, true) }} UTC</span>
                <span>Δv {{ fmtNum(ev.relSpeedKmS, 2) }} km/s</span>
                <span>Pc {{ ev.pc > 0 ? ev.pc.toExponential(1) : '—' }}</span>
              </div>
            </div>
          </div>
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

.ep-progress { display: flex; align-items: center; gap: 8px; margin-top: 6px;
  span { font-size: 10px; color: #8ea4c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
.ep-bar { flex: 1 1 auto; height: 4px; border-radius: 2px; background: rgba(120,160,220,0.2); overflow: hidden;
  i { display: block; height: 100%; background: linear-gradient(90deg, #3f9dff, #6fe0ff); transition: width 0.2s; }
  &.is-run { margin-top: 6px; } }

.ep-err { margin-top: 6px; font-size: 10.5px; line-height: 1.45; color: #ff8f8f;
  background: rgba(255,90,90,0.08); border: 1px solid rgba(255,90,90,0.22); border-radius: 6px; padding: 5px 8px; }
.ep-empty { font-size: 10.5px; color: #7d92b0; padding: 10px 2px; text-align: center;
  &.is-sm { padding: 8px 0; } }

/* 星历列表 */
.ep-list { display: flex; flex-direction: column; gap: 5px; margin-top: 7px; }
.ep-item { position: relative; padding: 7px 46px 7px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2); cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  &:hover { background: rgba(40,80,140,0.44); border-color: rgba(120,175,255,0.4); }
  &.on { border-color: #4f8de0; background: rgba(50,100,180,0.42); }
  &.is-builtin { padding-right: 9px; display: flex; align-items: center; justify-content: space-between; gap: 8px; } }
.ep-item-main { display: flex; align-items: center; gap: 5px; min-width: 0;
  .ep-item-name { flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: #eaf2fc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
.ep-tag { flex: none; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 3px;
  color: #9dbbdd; background: rgba(110,160,230,0.16); border: 1px solid rgba(110,160,230,0.22);
  &.cov { color: #6fe0c0; background: rgba(80,220,180,0.12); border-color: rgba(80,220,180,0.28); } }
.ep-item-sub { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px;
  span { font-size: 9.5px; color: #8ea4c4; } }
.ep-del { position: absolute; top: 5px; right: 5px; width: 18px; height: 18px; line-height: 16px;
  border-radius: 4px; border: 0; background: transparent; color: #7d92b0; font-size: 14px; cursor: pointer;
  &:hover { background: rgba(255,90,90,0.18); color: #ff8f8f; } }
.ep-dl { position: absolute; top: 5px; right: 25px; width: 18px; height: 18px; line-height: 16px;
  border-radius: 4px; border: 0; background: transparent; color: #7d92b0; font-size: 12px; cursor: pointer;
  &:hover { background: rgba(80,140,230,0.2); color: #9fc6ff; } }
.ep-load { flex: none; font-size: 10px; color: #7fb0ff; padding: 3px 7px; border-radius: 9px;
  background: rgba(80,140,230,0.16); border: 1px solid rgba(110,160,230,0.3); }
.ep-item.is-builtin:hover .ep-load { background: rgba(80,140,230,0.3); }

/* 键值表 */
.ep-kv { display: flex; flex-direction: column; gap: 4px; }
.ep-kv-row { display: flex; align-items: baseline; gap: 8px; font-size: 10.5px;
  span { flex: none; width: 84px; color: #8ea4c4; }
  b { flex: 1 1 auto; min-width: 0; color: #eaf2fc; font-weight: 600; word-break: break-all; }
  &.is-sub span { width: auto; } &.is-sub b { flex: none; } }

/* 质量卡 */
.ep-quality { margin-top: 8px; padding: 8px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.34); border: 1px solid rgba(110,150,210,0.2); }
.ep-q-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px;
  .ep-q-label { font-size: 10.5px; color: #8ea4c4; }
  .ep-q-score { font-size: 16px; font-weight: 800; line-height: 1;
    i { font-size: 10px; font-style: normal; font-weight: 400; opacity: 0.7; } }
  .ep-q-grade { font-size: 11px; font-weight: 700; } }
.ep-q-ai { margin-left: auto; align-self: center; padding: 2px 7px; font-size: 9.5px; line-height: 1.4;
  color: #9fc6ff; background: rgba(46,96,168,0.35); border: 1px solid rgba(110,160,230,0.42);
  border-radius: 4px; cursor: pointer;
  &:hover { color: #dbe9fb; background: rgba(62,120,200,0.5); } }
.ep-notes { margin: 5px 0 0; padding-left: 14px;
  li { font-size: 9.5px; line-height: 1.5; color: #8ea4c4; } }

/* 双文件对比 */
.ep-q-sel { flex: 1 1 auto; min-width: 0; height: 22px; font-size: 10px; color: #dbe9fb;
  background: rgba(20,44,82,0.9); border: 1px solid rgba(110,150,210,0.3); border-radius: 4px; outline: none; }
.ep-q-hint { margin-top: 3px; font-size: 9.5px; color: #7d92b0;
  &.is-err { color: #ff8f8f; } }

/* TLE 外推偏差卡 */
.ep-tle { margin-top: 7px; padding: 8px 9px; border-radius: 7px;
  background: rgba(26,52,96,0.28); border: 1px solid rgba(110,150,210,0.18); }
.ep-tle-norad { margin-left: auto; font-size: 9px; color: #7d92b0; }
.ep-tle-curve { display: block; width: 100%; height: 46px; margin-top: 6px;
  background: rgba(10,26,50,0.5); border-radius: 4px; }
.ep-tle-axis { display: flex; justify-content: space-between; gap: 6px; margin-top: 3px;
  span { font-size: 9px; color: #7d92b0; } }
.ep-tle-note { margin-top: 3px; font-size: 9px; line-height: 1.45; color: #7d92b0; }

/* 筛选参数 */
.ep-params { display: flex; gap: 6px; margin-bottom: 7px; }
.ep-param { flex: 1 1 0; display: flex; flex-direction: column; gap: 3px;
  span { font-size: 9.5px; color: #8ea4c4; }
  select { height: 24px; padding: 0 4px; font-size: 10.5px; color: #dbe9fb; border-radius: 5px;
    background: rgba(20,44,82,0.9); border: 1px solid rgba(110,150,210,0.3); outline: none; } }
.ep-run { width: 100%; height: 28px; border-radius: 6px; border: 1px solid rgba(90,160,255,0.5);
  background: linear-gradient(180deg, rgba(60,130,235,0.55), rgba(40,95,190,0.55)); color: #eaf2fc;
  font-size: 11.5px; font-weight: 700; cursor: pointer;
  &:hover:not(:disabled) { border-color: #7fb8ff; background: linear-gradient(180deg, rgba(70,145,250,0.7), rgba(45,105,205,0.7)); }
  &:disabled { opacity: 0.6; cursor: default; } }
.ep-stat { margin-top: 6px; font-size: 9.5px; color: #7d92b0; line-height: 1.45; }

/* 事件列表 */
.ep-events { margin-top: 9px; display: flex; flex-direction: column; gap: 5px; }
.ep-ev-head { display: flex; align-items: baseline; gap: 6px;
  b { font-size: 11px; color: #cfe0f5; }
  span { font-size: 9.5px; color: #7fb0ff; }
  .ep-ev-clear { margin-left: auto; font-size: 9.5px; color: #8ea4c4; background: transparent;
    border: 1px solid rgba(110,150,210,0.3); border-radius: 4px; padding: 1px 5px; cursor: pointer;
    &:hover { color: #dbe9fb; border-color: rgba(120,175,255,0.5); } } }
.ep-ev { padding: 6px 8px; border-radius: 6px; background: rgba(26,52,96,0.3);
  border: 1px solid rgba(110,150,210,0.18); cursor: pointer; transition: background 0.15s, border-color 0.15s;
  &:hover { background: rgba(40,80,140,0.42); }
  &.on { border-color: rgba(120,175,255,0.7); background: rgba(50,100,180,0.44); } }
.ep-ev-top { display: flex; align-items: baseline; gap: 8px;
  .ep-ev-name { flex: 1 1 auto; min-width: 0; font-size: 10.5px; color: #eaf2fc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ep-ev-miss { flex: none; font-size: 11px; font-weight: 700; } }
.ep-ev-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 8px; margin-top: 3px;
  span { font-size: 9.5px; color: #8ea4c4; } }
.ep-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; }

/* 机动仿真 */
.ep-man-time { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; color: #8ea4c4;
  b { color: #eaf2fc; font-weight: 600; } }
.ep-man-presets { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ep-man-p { flex: 1 1 auto; height: 22px; padding: 0 6px; font-size: 9.5px; border-radius: 4px; cursor: pointer;
  color: #9dbbdd; background: rgba(30,60,110,0.5); border: 1px solid rgba(110,150,210,0.28);
  &:hover:not(:disabled) { color: #eaf2fc; border-color: rgba(120,175,255,0.55); }
  &:disabled { opacity: 0.35; cursor: not-allowed; } }
.ep-man-row { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.ep-man-label { flex: none; width: 62px; font-size: 9.5px; color: #8ea4c4; }
.ep-man-dirs { display: flex; gap: 4px; flex: 1 1 auto;
  button { flex: 1 1 0; height: 22px; font-size: 10px; border-radius: 4px; cursor: pointer;
    color: #9dbbdd; background: rgba(30,60,110,0.5); border: 1px solid rgba(110,150,210,0.28);
    &:hover { color: #eaf2fc; border-color: rgba(120,175,255,0.55); }
    &.on { color: #0b1a2b; background: #7fb0ff; border-color: #7fb0ff; font-weight: 700; } } }
.ep-man-range { flex: 1 1 auto; min-width: 0; accent-color: #7fb0ff; }
.ep-man-val { flex: none; font-size: 10.5px; color: #ffd166; font-weight: 700; }
.ep-man-row.is-amp + .ep-run { margin-top: 9px; }
.ep-man-done { margin-top: 8px; padding: 6px 8px; border-radius: 6px;
  background: rgba(255,180,84,0.1); border: 1px solid rgba(255,180,84,0.3); }
.ep-man-done-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  span { font-size: 10px; color: #ffd8a0; }
  .ep-ev-clear { flex: none; font-size: 9.5px; color: #8ea4c4; background: transparent;
    border: 1px solid rgba(110,150,210,0.3); border-radius: 4px; padding: 1px 5px; cursor: pointer;
    &:hover { color: #dbe9fb; border-color: rgba(120,175,255,0.5); } } }
.ep-man-legend { display: flex; align-items: center; gap: 5px; margin-top: 5px; font-size: 9.5px; color: #8ea4c4;
  i { width: 14px; height: 2px; border-radius: 1px; display: inline-block; }
  i.is-orig { background: repeating-linear-gradient(90deg, #5c83b8 0 4px, transparent 4px 7px); margin-left: 6px; }
  i.is-new { background: #ffb454; } }

/* 机动前后对比表（前 → 后，绿=改善 / 红=恶化） */
.ep-cmp { margin-top: 9px; }
.ep-cmp-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 5px;
  b { font-size: 10.5px; color: #cfe0f5; }
  span { font-size: 9.5px; color: #7fb0ff; } }
.ep-cmp-list { display: flex; flex-direction: column; gap: 4px; max-height: 190px; overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: rgba(120,160,220,0.35) transparent; }
.ep-cmp-item { padding: 5px 7px; border-radius: 5px; background: rgba(26,52,96,0.3);
  border: 1px solid rgba(110,150,210,0.18); }
.ep-cmp-top { display: flex; align-items: baseline; gap: 6px;
  .ep-cmp-name { flex: 1 1 auto; min-width: 0; font-size: 10px; color: #eaf2fc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ep-cmp-dt { flex: none; font-size: 9px; color: #ffd166; } }
.ep-cmp-mid { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 2px;
  span { font-size: 9px; color: #8ea4c4; }
  b { font-weight: 700; color: #dbe9fb;
    &.is-up { color: #4ad991; }
    &.is-down { color: #ff8f8f; } } }

/* 小屏：面板为底部抽屉，参数区换行 */
@media (max-width: 720px) {
  .ep-params { flex-wrap: wrap; }
  .ep-param { flex: 1 1 30%; }
  .ep-kv-row span { width: 74px; }
}
</style>
