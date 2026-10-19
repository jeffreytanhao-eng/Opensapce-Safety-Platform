<script setup lang="ts">
/**
 * 前台迷你知识图谱（/situation 卫星详情面板内联 · 纯 canvas 手绘）
 *
 * 为什么不用图表库：与「轨道高度变化图」统一视觉语言（发光图形、圆角 tooltip 卡片），
 * 且本图节点规模小、布局一次性算完即冻结，不需要图表库的通用能力。
 * 与后台 /mui/kg 的画布图各自独立实现，互不引用（业务隔离约定）。
 *
 * 窄面板（约 320px）里节点中文名会相互压字，故图中不画常驻标签，靠 hover 的 tooltip 看名称；
 * 布局冻结后不提供缩放/拖拽，避免在窄面板里抢走纵向滚动（与既有交互口径一致）。
 *
 * 布局：自写力导向（斥力 + 弹簧 + 重力），确定性初始位置（按序铺圆，无随机抖动），
 *       迭代收敛后把包围盒等比归一化到 [-1,1]²，绘制时再按画布尺寸映射 → 换尺寸只需重算映射不重算布局。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TYPE_LABELS, TYPE_COLORS } from './kg'
import type { KgEdge, KgNode } from './kg'

const props = defineProps<{
  /** 图上的节点（中心 + 一圈邻居） */
  nodes: KgNode[]
  /** 连线 */
  edges: KgEdge[]
  /** 中心节点 id */
  centerId: string
}>()

const rootRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
/** 四周留白：只给光晕与 tooltip 一点点余量（无标签） */
const PAD = 14
/** 配色：详情面板恒为暗色底（同 OrbitHistoryChart），这里用固定亮色，不随站内主题变化 */
const C_EDGE = 'rgba(150,196,240,0.42)'
const C_LABEL = '#eaf2fc'
const C_RING = '#c8d8ee'

let W = 0
let H = 0
let dpr = 1
/** 视图变换：screen = world * k + t */
const view = { k: 1, tx: 0, ty: 0 }
/** 归一化世界坐标（布局结果，与画布尺寸无关） */
let world = new Map<string, { x: number; y: number }>()
/** 节点半径（屏幕像素） */
let radii = new Map<string, number>()
let hoverId = ''
let ro: ResizeObserver | null = null

/** '#rrggbb' + alpha → 'rgba(...)' */
function hexA(hex: string, a: number) {
  const h = hex.replace('#', '')
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
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

/** 跑一遍力导向（确定性），把结果归一化到以原点为中心的世界坐标 */
function relayout() {
  const vis = props.nodes
  world = new Map()
  radii = new Map()
  const n = vis.length
  if (!n) return

  const idx = new Map<string, number>()
  vis.forEach((x, i) => idx.set(x.id, i))
  const es = props.edges.filter((e) => idx.has(e.source) && idx.has(e.target))
  const ci = props.centerId ? idx.get(props.centerId) : undefined

  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const dxs = new Float64Array(n)
  const dys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const r = 1 + (i % 5) * 0.06
    px[i] = Math.cos(a) * r
    py[i] = Math.sin(a) * r
  }
  if (ci != null) { px[ci] = 0; py[ci] = 0 }

  // 标准 FR：斥力 k²/d + 引力 d²/k，位移受温度 temp 封顶并逐轮降温（防数值发散）
  const k = 1.1 / Math.sqrt(n)
  const GRAV = 0.05
  const ITER = 300
  let temp = 0.6

  for (let it = 0; it < ITER; it++) {
    dxs.fill(0)
    dys.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i] - px[j]
        let dy = py[i] - py[j]
        let d2 = dx * dx + dy * dy
        if (d2 < 1e-8) { dx = (i - j) * 1e-3 + 1e-3; dy = 1e-3; d2 = dx * dx + dy * dy }
        const d = Math.sqrt(d2)
        const f = (k * k) / d
        const ux = dx / d
        const uy = dy / d
        dxs[i] += ux * f; dys[i] += uy * f
        dxs[j] -= ux * f; dys[j] -= uy * f
      }
    }
    for (const e of es) {
      const a = idx.get(e.source) as number
      const b = idx.get(e.target) as number
      const dx = px[b] - px[a]
      const dy = py[b] - py[a]
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6
      const f = (d * d) / k
      const ux = dx / d
      const uy = dy / d
      dxs[a] += ux * f; dys[a] += uy * f
      dxs[b] -= ux * f; dys[b] -= uy * f
    }
    for (let i = 0; i < n; i++) {
      if (i === ci) { px[i] = 0; py[i] = 0; continue }
      const ddx = dxs[i] - px[i] * GRAV
      const ddy = dys[i] - py[i] * GRAV
      const len = Math.hypot(ddx, ddy)
      if (len > 1e-9) {
        const step = Math.min(len, temp)
        px[i] += (ddx / len) * step
        py[i] += (ddy / len) * step
      }
    }
    temp *= 0.95
  }

  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px[i]); maxX = Math.max(maxX, px[i])
    minY = Math.min(minY, py[i]); maxY = Math.max(maxY, py[i])
  }
  const bw = Math.max(1e-3, maxX - minX)
  const bh = Math.max(1e-3, maxY - minY)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const s = 2 / Math.max(bw, bh)
  for (let i = 0; i < n; i++) {
    world.set(vis[i].id, { x: (px[i] - cx) * s, y: (py[i] - cy) * s })
    radii.set(vis[i].id, vis[i].id === props.centerId ? 7.5 : 4.5)
  }
}

function fitView() {
  if (W <= 2 || H <= 2) return
  view.k = Math.max(0.001, Math.min((W - PAD * 2) / 2, (H - PAD * 2) / 2))
  view.tx = W / 2
  view.ty = H / 2
}

function toScreen(x: number, y: number) {
  return { x: x * view.k + view.tx, y: y * view.k + view.ty }
}

/** 某节点的屏幕位置与半径（不存在返回 null） */
function nodeAt(id: string) {
  const w = world.get(id)
  const r = radii.get(id)
  if (!w || r == null) return null
  const s = toScreen(w.x, w.y)
  return { x: s.x, y: s.y, r }
}

function draw() {
  const cv = canvasRef.value
  if (!cv || W <= 2 || H <= 2) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  const pw = Math.round(W * dpr)
  const ph = Math.round(H * dpr)
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  // hover 邻接集合（高亮邻接、淡化其余）
  const adj = new Set<string>()
  if (hoverId) {
    adj.add(hoverId)
    for (const e of props.edges) {
      if (e.source === hoverId) adj.add(e.target)
      else if (e.target === hoverId) adj.add(e.source)
    }
  }
  const dim = (id: string) => hoverId !== '' && !adj.has(id)

  // ---- 连线 ----
  ctx.strokeStyle = C_EDGE
  for (const e of props.edges) {
    const a = nodeAt(e.source)
    const b = nodeAt(e.target)
    if (!a || !b) continue
    const active = hoverId !== '' && (e.source === hoverId || e.target === hoverId)
    ctx.globalAlpha = hoverId === '' ? 1 : (active ? 1 : 0.18)
    ctx.lineWidth = active ? 1.8 : 1.1
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // ---- 节点（圆点，中心加描边） ----
  for (const nd of props.nodes) {
    const s = nodeAt(nd.id)
    if (!s) continue
    const isCenter = nd.id === props.centerId
    const isHover = nd.id === hoverId
    const color = TYPE_COLORS[nd.type]
    ctx.globalAlpha = dim(nd.id) ? 0.18 : 1
    ctx.save()
    ctx.shadowColor = hexA(color, dim(nd.id) ? 0 : 0.6)
    ctx.shadowBlur = isHover ? 12 : 7
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
    if (isCenter || isHover) {
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r + 2, 0, Math.PI * 2)
      ctx.strokeStyle = hexA(C_RING, 0.85)
      ctx.lineWidth = 1.4
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  drawTip(ctx)
}

/** 悬停 tooltip（圆角卡片，风格对齐轨道高度图） */
function drawTip(ctx: CanvasRenderingContext2D) {
  if (!hoverId) return
  const nd = props.nodes.find((n) => n.id === hoverId)
  const s = nodeAt(hoverId)
  if (!nd || !s) return

  const lines: { text: string; color: string; dot?: string }[] = [
    { text: `${TYPE_LABELS[nd.type]}：${nd.name}`, color: TYPE_COLORS[nd.type], dot: TYPE_COLORS[nd.type] }
  ]
  if (nd.sub) lines.push({ text: nd.sub, color: C_LABEL })

  ctx.font = `11px ${FONT}`
  let tw = 0
  for (const l of lines) tw = Math.max(tw, ctx.measureText(l.text).width + (l.dot ? 13 : 0))
  const padX = 9
  const lineH = 16
  const bw = tw + padX * 2
  const bh = lines.length * lineH + 10
  let bx = s.x + 12
  if (bx + bw > W - 4) bx = s.x - 12 - bw
  if (bx < 4) bx = 4
  let by = s.y - bh / 2
  by = Math.max(4, Math.min(H - bh - 4, by))

  rrect(ctx, bx, by, bw, bh, 7)
  ctx.fillStyle = 'rgba(12,22,38,0.94)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(120,170,230,0.42)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  let ty = by + 5 + lineH / 2
  for (const l of lines) {
    let tx = bx + padX
    if (l.dot) {
      ctx.beginPath()
      ctx.arc(tx + 3, ty, 3.2, 0, Math.PI * 2)
      ctx.fillStyle = l.dot
      ctx.fill()
      tx += 13
    }
    ctx.fillStyle = l.color
    ctx.fillText(l.text, tx, ty)
    ty += lineH
  }
}

/* ---------------- 命中测试 ---------------- */

function pickNode(x: number, y: number) {
  for (let i = props.nodes.length - 1; i >= 0; i--) {
    const s = nodeAt(props.nodes[i].id)
    if (!s) continue
    if (Math.hypot(x - s.x, y - s.y) <= s.r + 4) return props.nodes[i].id
  }
  return ''
}

function localPt(ev: MouseEvent) {
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
}

function onMove(ev: MouseEvent) {
  const { x, y } = localPt(ev)
  const id = pickNode(x, y)
  if (id !== hoverId) { hoverId = id; draw() }
}

function onLeave() {
  if (hoverId) { hoverId = ''; draw() }
}

/* ---------------- 尺寸与生命周期 ---------------- */

function syncSize() {
  const root = rootRef.value
  if (!root) return
  W = root.clientWidth
  H = root.clientHeight
  dpr = Math.min(window.devicePixelRatio || 1, 2)
}

function redraw() {
  syncSize()
  if (W <= 2 || H <= 2) return
  if (!world.size) { relayout(); fitView() }
  draw()
}

function rebuild() {
  syncSize()
  // 容器为 0（v-show 收起）时先清掉旧布局：等尺寸恢复后按新数据重算，
  // 否则新节点 id 在旧 world 里查不到，展开后会画不出任何节点
  if (W <= 2 || H <= 2) {
    world = new Map()
    radii = new Map()
    return
  }
  relayout()
  fitView()
  hoverId = ''
  draw()
}

watch(() => [props.nodes, props.edges, props.centerId], () => rebuild())

onMounted(() => {
  syncSize()
  rebuild()
  const root = rootRef.value
  if (root) {
    ro = new ResizeObserver(() => {
      const prevW = W
      const prevH = H
      syncSize()
      if (W <= 2 || H <= 2) return
      // 尺寸变化（含 0↔定高）：重算装箱映射即可，布局结果复用；
      // 若挂载时容器为 0 导致布局未跑，这里补跑一次
      if (W !== prevW || H !== prevH) {
        if (!world.size) { relayout(); hoverId = '' }
        fitView()
        draw()
      }
    })
    ro.observe(root)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

defineExpose({ redraw })
</script>

<template>
  <div ref="rootRef" class="kgmini">
    <canvas
      ref="canvasRef"
      class="kgmini-canvas"
      @mousemove="onMove"
      @mouseleave="onLeave"
    ></canvas>
  </div>
</template>

<style scoped>
.kgmini {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.kgmini-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>