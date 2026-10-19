<script setup lang="ts">
/**
 * 轨道高度变化图（纯 canvas 绘制，独立组件）
 *
 * 用途：卫星详情面板「轨道高度变化图」块 —— 用 canvas 画远地点 / 近地点随历元变化的双折线，
 * 替代此前的 echarts 版本（灰暗、数据堆叠、无指示器）。
 *
 * 设计要点：
 *  - 亮色坐标轴与刻度（#c8d8ee），不再用暗灰，窄面板下也清晰可读；
 *  - x 轴按样本索引等距铺满（而非按真实时间刻度），避免历元密集时数据挤成一团；
 *  - y 轴按数据实际范围自适应并留 14% 余量，避免贴边；
 *  - 鼠标悬停有指示器：竖十字虚线 + 双线指示点 + tooltip（历元 / 远地点 / 近地点 / 半长轴）；
 *  - DPR 缩放（≤2）保证高分屏清晰；ResizeObserver 自适应容器（含折叠展开 0→有高）；
 *  - 空数据 / 无有效高度值时给居中兜底文案。
 *
 * 单一职责：只接收 points 渲染，不发请求、不管折叠与加载态（由父级 index.vue 编排）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { parseEpoch } from './scene'
import type { SatHistoryPoint } from '@/api/sat_public'

const props = defineProps<{ points: SatHistoryPoint[] }>()

const rootRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()

let ro: ResizeObserver | null = null
/** 当前悬停命中的样本索引（-1 = 无） */
let hoverIdx = -1

/** 配色：远地点橙 / 近地点蓝；坐标轴与文字用亮色，保证可读 */
const C_APO = '#ff9f43'
const C_PERI = '#3f9dff'
const C_AXIS = 'rgba(150,196,240,0.62)'
const C_LABEL = '#c8d8ee'
const C_GRID = 'rgba(120,170,230,0.16)'
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

/** 绘图内边距（左留 y 轴刻度、上留图例、下留 x 轴标签） */
const PAD = { left: 46, right: 14, top: 24, bottom: 22 }

function pad2(n: number) {
  return String(n).padStart(2, '0')
}
/** x 轴刻度：'YY-MM-DD'（窄面板下省空间，同时能区分跨年） */
function dayLabel(epoch: string) {
  const d = new Date(parseEpoch(epoch))
  return `${String(d.getUTCFullYear()).slice(2)}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
/** tooltip 时间：'YYYY-MM-DD HH:mm'（UTC） */
function fullLabel(epoch: string) {
  const d = new Date(parseEpoch(epoch))
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
/** '#rrggbb' + alpha → 'rgba(...)' */
function hexA(hex: string, a: number) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}
/** 圆角矩形路径（不自带 fill/stroke） */
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
/** 指示点：实心圆 + 白色描边环 */
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath()
  ctx.arc(x, y, 3.2, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.stroke()
}

function draw() {
  const root = rootRef.value
  const cv = canvasRef.value
  if (!root || !cv) return
  const w = root.clientWidth
  const h = root.clientHeight
  // 折叠态（v-show display:none）尺寸为 0，跳过；展开后由 ResizeObserver 触发重绘
  if (w <= 2 || h <= 2) return

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw
    cv.height = ph
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const pts = props.points || []
  const n = pts.length
  const left = PAD.left
  const right = w - PAD.right
  const top = PAD.top
  const bottom = h - PAD.bottom
  const plotW = right - left
  const plotH = bottom - top

  /** 空数据兜底 */
  const empty = () => {
    ctx.fillStyle = C_LABEL
    ctx.font = `12px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('暂无历史数据', w / 2, h / 2)
  }

  // y 值域：遍历所有有效的高度值
  let yMin = Infinity
  let yMax = -Infinity
  for (const p of pts) {
    if (p.apogee != null && Number.isFinite(p.apogee)) { yMin = Math.min(yMin, p.apogee); yMax = Math.max(yMax, p.apogee) }
    if (p.perigee != null && Number.isFinite(p.perigee)) { yMin = Math.min(yMin, p.perigee); yMax = Math.max(yMax, p.perigee) }
  }
  if (!n || !Number.isFinite(yMin) || !Number.isFinite(yMax) || plotW <= 0 || plotH <= 0) return empty()

  let span = yMax - yMin
  if (span <= 1e-6) span = Math.max(Math.abs(yMax), 1) * 0.1 || 1
  const yLo = yMin - span * 0.14
  const yHi = yMax + span * 0.14
  const spanY = yHi - yLo

  // x 按索引等距铺满（避免历元密集时挤在一起），y 按值域线性映射
  const X = (i: number) => (n === 1 ? (left + right) / 2 : left + (i / (n - 1)) * plotW)
  const Y = (v: number) => bottom - ((v - yLo) / spanY) * plotH

  // ---- 网格 + y 轴刻度 ----
  const TICKS = 4
  ctx.font = `9px ${FONT}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let k = 0; k <= TICKS; k++) {
    const v = yLo + (spanY * k) / TICKS
    const y = Math.round(Y(v)) + 0.5
    ctx.strokeStyle = C_GRID
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
    ctx.fillStyle = C_LABEL
    ctx.fillText(String(Math.round(v)), left - 6, Y(v))
  }

  // ---- 坐标轴 ----
  ctx.strokeStyle = C_AXIS
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left + 0.5, top)
  ctx.lineTo(left + 0.5, bottom + 0.5)
  ctx.lineTo(right, bottom + 0.5)
  ctx.stroke()

  // ---- x 轴刻度 ----
  ctx.font = `10px ${FONT}`
  ctx.fillStyle = C_LABEL
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const maxXLabels = Math.max(2, Math.floor(plotW / 50))
  const stepX = Math.max(1, Math.ceil((n - 1) / maxXLabels))
  for (let i = 0; i < n; i += stepX) {
    const x = X(i)
    if (x < left + 8 || x > right - 4) continue
    ctx.fillText(dayLabel(pts[i].epoch), x, bottom + 5)
  }

  // ---- 图例（左上角，画在坐标区上方的留白里） ----
  ctx.font = `10px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const legendY = Math.max(9, top / 2)
  let lx = left + 2
  for (const [name, color] of [['远地点', C_APO], ['近地点', C_PERI]] as [string, string][]) {
    ctx.beginPath()
    ctx.arc(lx + 3, legendY, 3, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.fillStyle = C_LABEL
    ctx.fillText(name, lx + 10, legendY)
    lx += 10 + ctx.measureText(name).width + 12
  }

  // ---- 双序列：渐变面 + 发光折线（按连续有效段绘制，遇 null 断开） ----
  const drawSeries = (get: (p: SatHistoryPoint) => number | null, color: string) => {
    const runs: number[][] = []
    let cur: number[] = []
    for (let i = 0; i < n; i++) {
      const v = get(pts[i])
      if (v != null && Number.isFinite(v)) cur.push(i)
      else if (cur.length) { runs.push(cur); cur = [] }
    }
    if (cur.length) runs.push(cur)

    for (const run of runs) {
      const y0 = Y(get(pts[run[0]]) as number)
      if (run.length >= 2) {
        // 面填充：顶部带色 → 底部透明
        const grad = ctx.createLinearGradient(0, top, 0, bottom)
        grad.addColorStop(0, hexA(color, 0.24))
        grad.addColorStop(1, hexA(color, 0.02))
        ctx.beginPath()
        ctx.moveTo(X(run[0]), y0)
        for (let k = 1; k < run.length; k++) ctx.lineTo(X(run[k]), Y(get(pts[run[k]]) as number))
        ctx.lineTo(X(run[run.length - 1]), bottom)
        ctx.lineTo(X(run[0]), bottom)
        ctx.closePath()
        ctx.fillStyle = grad
        ctx.fill()
      }
      // 折线：带柔光
      ctx.beginPath()
      for (let k = 0; k < run.length; k++) {
        const xx = X(run[k])
        const yy = Y(get(pts[run[k]]) as number)
        if (k === 0) ctx.moveTo(xx, yy)
        else ctx.lineTo(xx, yy)
      }
      ctx.strokeStyle = color
      ctx.lineWidth = 1.6
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.shadowColor = hexA(color, 0.6)
      ctx.shadowBlur = 4
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
      // 孤立点：补一个小圆，避免只剩一个样本时看不见
      if (run.length === 1) {
        ctx.beginPath()
        ctx.arc(X(run[0]), y0, 2, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }
    }
  }
  drawSeries((p) => p.apogee, C_APO)
  drawSeries((p) => p.perigee, C_PERI)

  // ---- 悬停指示器 ----
  if (hoverIdx >= 0 && hoverIdx < n) {
    const p = pts[hoverIdx]
    const hx = X(hoverIdx)
    // 竖十字虚线
    ctx.save()
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = 'rgba(200,216,238,0.55)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(hx + 0.5, top)
    ctx.lineTo(hx + 0.5, bottom)
    ctx.stroke()
    ctx.restore()
    // 双线指示点
    if (p.apogee != null && Number.isFinite(p.apogee)) dot(ctx, hx, Y(p.apogee), C_APO)
    if (p.perigee != null && Number.isFinite(p.perigee)) dot(ctx, hx, Y(p.perigee), C_PERI)

    // tooltip 盒
    const rows: { text: string; color: string; dot?: string }[] = [
      { text: `${fullLabel(p.epoch)} UTC`, color: '#eaf2fc' },
      { text: `远地点 ${p.apogee != null ? p.apogee.toFixed(1) : '—'} km`, color: C_APO, dot: C_APO },
      { text: `近地点 ${p.perigee != null ? p.perigee.toFixed(1) : '—'} km`, color: C_PERI, dot: C_PERI }
    ]
    if (p.semimajor_axis != null && Number.isFinite(p.semimajor_axis)) {
      rows.push({ text: `半长轴 ${Math.round(p.semimajor_axis)} km`, color: C_LABEL })
    }
    ctx.font = `10px ${FONT}`
    let tw = 0
    for (const r of rows) tw = Math.max(tw, ctx.measureText(r.text).width + (r.dot ? 12 : 0))
    const padX = 8
    const padY = 6
    const lineH = 14
    const bw = tw + padX * 2
    const bh = rows.length * lineH + padY * 2 - 2
    let bx = hx + 12
    if (bx + bw > right) bx = hx - 12 - bw
    if (bx < 2) bx = 2
    let by = top + 2
    if (by + bh > bottom) by = Math.max(top, bottom - bh)

    rrect(ctx, bx, by, bw, bh, 6)
    ctx.fillStyle = 'rgba(12,22,38,0.94)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(120,170,230,0.42)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    let ty = by + padY + 5
    for (const r of rows) {
      let tx = bx + padX
      if (r.dot) {
        ctx.beginPath()
        ctx.arc(tx + 3, ty, 3, 0, Math.PI * 2)
        ctx.fillStyle = r.dot
        ctx.fill()
        tx += 12
      }
      ctx.fillStyle = r.color
      ctx.fillText(r.text, tx, ty)
      ty += lineH
    }
  }
}

function onMove(ev: MouseEvent) {
  const root = rootRef.value
  if (!root) return
  const n = props.points?.length || 0
  if (n <= 0) return
  const rect = root.getBoundingClientRect()
  const plotW = rect.width - PAD.left - PAD.right
  if (plotW <= 0) return
  const mx = ev.clientX - rect.left
  let idx: number
  if (n === 1) idx = 0
  else {
    idx = Math.round(((mx - PAD.left) / plotW) * (n - 1))
    idx = Math.max(0, Math.min(n - 1, idx))
  }
  if (idx !== hoverIdx) {
    hoverIdx = idx
    draw()
  }
}
function onLeave() {
  if (hoverIdx === -1) return
  hoverIdx = -1
  draw()
}

watch(() => props.points, () => { hoverIdx = -1; draw() })

onMounted(() => {
  const root = rootRef.value
  if (root) {
    ro = new ResizeObserver(() => draw())
    ro.observe(root)
  }
  draw()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

defineExpose({ redraw: draw })
</script>
<template>
  <div ref="rootRef" class="ohc">
    <canvas ref="canvasRef" class="ohc-canvas" @mousemove="onMove" @mouseleave="onLeave"></canvas>
  </div>
</template>
<style scoped lang="scss">
.ohc {
  position: relative;
  overflow: hidden;
}
.ohc-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}
</style>
