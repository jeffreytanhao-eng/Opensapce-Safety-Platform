<script setup lang="ts">
/**
 * 空间态势页的智能体入口（前台免登录）—— 全屏毛玻璃覆盖层
 *
 * 走 /cgi/ai/chat：只读工具 + 按 IP 限流（可配为不限制），与后台 /mui/ai_assistant
 * 共用同一套后端实现，只是工具集与护栏不同（/cgi 是公开只读前缀，鉴权权重低）。
 *
 * 形态（按用户口径）：毛玻璃覆盖整个 /situation，用三维地球当底图，三种态：
 *   ① idle   —— 默认全屏搜索界面：居中大输入框 + 能力快捷词；
 *   ② chat   —— 有对话后收成全屏居中的对话流；
 *   ③ docked —— 底部收成小窗，上方露出三维态势实时定位（模型下发「态势类界面动作」时自动进入，也可用标题栏按钮手动切换）。
 *   ④ collapsed（仅移动端）—— 底部大卡片收成一条小横条（仅由模型下发「态势类界面动作」时自动进入），毛玻璃底一并放行。
 *
 * 标题栏按钮：宽屏是「小窗 / 全屏」缩放；移动端是「收起」——直接关闭浮层，
 * 底部 dock 的「智能体」入口随之取消高亮（用户口径：移动端「收起」即关闭，不再收成小横条挡住底部菜单 / 列表）。
 * 智能体是态势页主体，其余态势内容都是它的辅助；覆盖层本身的启停也交给页面左侧入口（index.vue 的 dock-btn）。
 *
 * 模型不直接操作前端：它只下发声明式 action（见 utils/aiStream.ts 的 AiAction），
 * 由本组件上抛给 /situation 容器执行；动作失败绝不影响文字回答的呈现。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { fetchAiStatus, streamAiChat, TOOL_LABEL } from '@/utils/aiStream'
import type { AiStatus, AiToolCall, AiAction, AiMessage } from '@/utils/aiStream'
import { useTypewriter } from '@/composables/useTypewriter'
import AiRichText from './AiRichText.vue'
import { buildSuggestions, toContext } from './aiTarget'
import type { AiTarget } from './aiTarget'
import { uploadUrl } from '@/utils/request'
import ContactDialog from '@/components/ContactDialog.vue'

const props = defineProps<{ open: boolean; target?: AiTarget | null }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  /** 界面动作上抛：/situation 容器负责定位选中 / 打开面板 / 绘制区域 / 图谱下钻 */
  (e: 'action', a: AiAction): void
  /** 新一轮提问开始：容器据此重置「本轮是否已清空展示效果」标志（保证下次效果前清空） */
  (e: 'round-start'): void
}>()

interface ChatItem {
  role: 'user' | 'assistant'
  /** 完整正文：发给模型的历史与最终态都用它 */
  content: string
  /** 打字机已显示的部分：模板渲染它，才能逐字出现而不是一坨蹦出来 */
  shown: string
  /** 是否仍在吐字（末尾显示闪烁光标） */
  typing: boolean
  /** 本轮耗时（ms，done 事件带回）：输出完成后显示「输出完成」提示 */
  elapsedMs: number
  tools: AiToolCall[]
  /** 本轮下发的界面动作：在对话里留一条轨迹，让用户知道「已经帮你定位/打开了什么」 */
  actions: AiAction[]
  phase: string
  error: string
  streaming: boolean
  /** 系统提示行（如「目标已切换」）：居中细字，不按气泡渲染、不进对话历史 */
  note?: boolean
  /** 本条提问发出时的界面上下文快照（之后切换目标不会改这条提问的指代） */
  ctx?: Record<string, unknown> | null
  /** 思考轨迹（工具调用 / 界面动作）是否被用户手动展开：结束后默认折叠，点标题可回看 */
  trailOpen?: boolean
  /** 本地生成的消息（无意义输入的委婉回绝）：只展示，不进对话历史、不发模型 */
  local?: boolean
  /** 诊断信息（meta 事件）：本轮实际使用的模型与暴露给模型的工具集，仅用于排障展示 */
  meta?: { provider: string; model: string; tools: string[] }
  /** 本条为「区域过境推算模式」：前端固定渲染免责声明条（不依赖模型自己声明） */
  estimate?: boolean
}

/** 左侧 dock 面板中文名（与 index.vue 的 DOCK_TYPES 对齐） */
const PANEL_LABEL: Record<string, string> = {
  sat: '卫星', cons: '星座', site: '发射站', heat: '碰撞热力', pass: '城市过境', region: '区域过境', multi: '多区域过境'
}
const ACTION_LABEL: Record<string, string> = {
  select_satellite: '已定位并高亮', select_constellation: '已选中星座', select_site: '已定位发射场',
  compare_constellations: '已绘制星座对比', select_conj_event: '已定位事件',
  select_pass_city: '已定位过境目标', open_panel: '已打开面板', draw_region: '已绘制区域', kg_focus: '已下钻知识图谱',
  open_url: '已打开链接', toggle_layers: '已切换图层',
  show_satellites: '已绘制卫星集合', clear_display: '已清空展示效果'
}
/** 空间环境 / 天体图层 key → 中文名（与 scene.ts 的 SKY_LAYER_ITEMS 对齐，仅用于对话轨迹文案） */
const SKY_LAYER_LABEL: Record<string, string> = {
  sun: '太阳', moon: '月亮', stars: '星空', mansion: '三垣二十八宿', constellation: '西方88星座', aurora: '极光椭圆环',
  solarWind: '太阳风粒子流', dipole: '地磁偶极磁力线', groundTrack: '星下点轨迹', ellipsoid: '误差椭球'
}
/** 会改变三维态势的动作：命中它们就把覆盖层收成右侧小框，让左边态势露出来 */
const SITUATION_KINDS = new Set(['select_satellite', 'select_constellation', 'compare_constellations', 'select_site', 'select_conj_event', 'select_pass_city', 'open_panel', 'draw_region', 'kg_focus', 'toggle_layers', 'show_satellites'])

/** select_satellite 的目标名双口径：用户口径名（开运一号）+ 实际编目名（OBJECT-B）+ NORAD 一起给 */
function satActionName(a: AiAction): string {
  if (a.kind !== 'select_satellite') return ''
  const cn = (a.cnName || '').trim()
  const nm = (a.name || '').trim()
  const id = Number.isFinite(a.norad) && a.norad > 0 ? `NORAD ${a.norad}` : ''
  if (cn && nm && cn !== nm) return `${cn}（${nm}${id ? ` / ${id}` : ''}）`
  if (cn) return id ? `${cn}（${id}）` : cn
  if (nm) return id ? `${nm}（${id}）` : nm
  return id
}

function actionText(a: AiAction): string {
  const t = ACTION_LABEL[a.kind] || a.kind
  switch (a.kind) {
    case 'select_satellite': return `${t} · ${satActionName(a)}`
    case 'select_constellation': return `${t} · ${a.name}`
    case 'compare_constellations': return `${t} · ${(a.names || []).join(' / ')}`
    case 'select_site': return `${t} · ${(a.name || '').trim() || `站点 #${a.siteId}`}`
    case 'select_conj_event': return `${t} · ${a.source === 'cri' ? '交会分析' : '碰撞预警'} #${a.key}`
    case 'select_pass_city': return `${t} · ${(a.name || '').trim() || `目标 #${a.targetId}`}`
    case 'open_panel': {
      const focus = Number.isFinite(a.norad) && (a.norad as number) > 0 ? `（定位 NORAD ${a.norad} 的交会）` : ''
      const first = a.selectFirst ? '（自动选中目标卫星第一条交会）' : ''
      return `${t} · ${PANEL_LABEL[a.panel] || a.panel}${focus}${first}`
    }
    case 'draw_region': return `${t} · ${a.vertices?.length || 0} 个顶点`
    case 'kg_focus': return `${t} · ${a.kgType}`
    case 'open_url': return `${t} · ${a.label || a.url}`
    case 'toggle_layers': return `${t} · ${(a.layers || []).map((k) => SKY_LAYER_LABEL[k] || k).join(' / ')}`
    case 'show_satellites': return `${t} · ${(a.name || '').trim() || '目标集合'}（${a.norads?.length || 0} 颗）`
    default: return t
  }
}

/** 下载入口文案：报告类工具（create_*_report）为 Word/CSV，查询导出（export_query_result）为 JSON 数据 */
function dlLabel(t: AiToolCall): string {
  return /report/i.test(t.name || '') ? '下载报告' : '下载数据'
}

/** 本轮产出的可下载产物（报告 / 导出数据）：从工具调用里收集带 url 的条目，按地址去重。
 *  渲染在正文气泡下方（不放思考轨迹里）——思考轨迹结束后默认折叠，放里面用户根本看不到入口。 */
function msgDownloads(m: ChatItem): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = []
  const seen = new Set<string>()
  for (const t of m.tools) {
    const u = (t.url || '').trim()
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push({ url: u, label: dlLabel(t) })
  }
  return out
}

/** 思考轨迹条数（界面动作 + 工具调用） */
function trailCount(m: ChatItem): number {
  return m.actions.length + m.tools.length
}
/** 思考轨迹是否展开：流式进行中恒展开（边想边看），回答结束后收起为一行，点标题可手动回看 */
function trailExpanded(m: ChatItem): boolean {
  return !!m.streaming || !!m.trailOpen
}

const status = ref<AiStatus | null>(null)
const items = ref<ChatItem[]>([])
const input = ref('')
const sending = ref(false)
const listRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
/** 卡片与输入框外层、下拉本体（用于判断联想下拉该朝下还是朝上展开） */
const cardRef = ref<HTMLElement | null>(null)
const wrapRef = ref<HTMLElement | null>(null)
const dropRef = ref<HTMLElement | null>(null)
/** 打开即底部小窗（不进全屏毛玻璃态）：上方三维态势保持可见可交互；标题栏 ⤢ 可随时放大全屏 */
const docked = ref(true)
/** 移动端「收起小横条」态：底部大卡片收成一条小横条，给三维主屏让位。
 *  仅由模型下发「态势类界面动作」时自动进入（见 dockForSituation）；标题栏「收起」按钮走的是关闭浮层，不进入此态 */
const collapsed = ref(false)
/** 是否窄屏（≤768px，与样式断点一致）：收起只在移动端生效，回到宽屏自动复位避免残留 */
const narrow = ref(false)
let mqNarrow: MediaQueryList | null = null

/** 标题栏入口：问题反馈 / 商业合作（免登录匿名提交） */
const feedbackOpen = ref(false)
const cooperationOpen = ref(false)
function openFeedback() {
  feedbackOpen.value = true
}
function openCooperation() {
  cooperationOpen.value = true
}

/** 标题栏缩放按钮：全屏 ↔ 右侧小窗切换 */
function onToggleDock() {
  docked.value = !docked.value
}

/** 标题栏「最小化」（宽屏）：关闭整个浮层，底部 dock 的「智能体」入口取消高亮、框体隐藏。
 *  与移动端「收起」同义（同一意图的两种形态），故直接复用其关闭逻辑。 */
function onMinimize() {
  onToggleCollapse()
}

/** 标题栏「收起」（仅移动端显示）：展开态点它 = 直接关闭整个浮层，底部 dock 的「智能体」入口随之取消高亮，
 *  把三维主屏交还用户（用户口径：移动端「收起」即关闭，不再收成小横条挡住底部菜单 / 列表）；
 *  若已处于收起小横条（模型下发态势类动作自动进入），点它先展开回对话。 */
function onToggleCollapse() {
  if (collapsed.value) { collapsed.value = false; return }
  emit('update:open', false)
}

/** 窄屏变化：仅移动端允许收起；回到宽屏自动展开，避免残留收起态 */
function onNarrowChange(e: MediaQueryList | MediaQueryListEvent) {
  narrow.value = e.matches
  if (!e.matches) collapsed.value = false
}

/** 命中态势类动作：桌面端收成右侧小窗、移动端收成底部小横条——同一意图的两种形态，都把三维主屏露出来 */
function dockForSituation() {
  if (narrow.value) collapsed.value = true
  else docked.value = true
}

/**
 * docked 小窗：拖动标题栏可自由移动位置。
 * 偏移是「相对默认贴底居中位置」的像素位移，仅 docked 态生效（全屏态忽略，回到小窗时沿用上次位置）。
 */
const dragX = ref(0)
const dragY = ref(0)
const dragging = ref(false)
let dragFrom = { px: 0, py: 0, x: 0, y: 0, id: -1 }

/** 把拖动偏移约束在视口内（四周留 8px 边距），避免卡片被拖出屏幕找不回来 */
function clampDrag() {
  const el = cardRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // r 已含当前 transform → 反推未偏移的基准矩形
  const baseLeft = r.left - dragX.value
  const baseRight = r.right - dragX.value
  const baseTop = r.top - dragY.value
  const baseBottom = r.bottom - dragY.value
  const m = 8
  const minX = m - baseLeft
  const maxX = window.innerWidth - m - baseRight
  const minY = m - baseTop
  const maxY = window.innerHeight - m - baseBottom
  dragX.value = Math.min(Math.max(dragX.value, minX), Math.max(minX, maxX))
  dragY.value = Math.min(Math.max(dragY.value, minY), Math.max(minY, maxY))
}

function onHeadPointerDown(e: PointerEvent) {
  // 仅小窗态可拖；点在标题栏按钮上不启动拖动，保证按钮仍可点击
  if (!docked.value || e.button !== 0) return
  if ((e.target as HTMLElement | null)?.closest('button')) return
  dragging.value = true
  dragFrom = { px: e.clientX, py: e.clientY, x: dragX.value, y: dragY.value, id: e.pointerId }
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  e.preventDefault()
}

function onHeadPointerMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== dragFrom.id) return
  dragX.value = dragFrom.x + (e.clientX - dragFrom.px)
  dragY.value = dragFrom.y + (e.clientY - dragFrom.py)
  clampDrag()
}

function onHeadPointerUp(e: PointerEvent) {
  if (e.pointerId !== dragFrom.id) return
  dragging.value = false
  dragFrom.id = -1
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
  clampDrag()
}

/** 视口尺寸变化（旋转 / 缩放）后重新约束偏移，避免小窗跑到屏幕外 */
function onViewportResize() {
  if (docked.value) clampDrag()
}

/** 进入小窗态时卡片布局刚变（宽度/高度带过渡），下一帧再按新布局约束一次 */
watch(docked, (v) => {
  if (v) nextTick(clampDrag)
})

let ac: AbortController | null = null

/** 上一次提问的快照：断流 / 出错后「重新生成」复用同一提问（context、estimate 口径都不变） */
let lastAsk: { ctx: Record<string, unknown> | null; estimate: boolean } | null = null

/** 打字机当前正在写的消息：每帧把「已显示文本 + 是否还在吐字」写回它（通过 reactive 代理，才能触发渲染） */
let twTarget: ChatItem | null = null
const tw = useTypewriter((s, typing) => {
  if (twTarget) {
    twTarget.shown = s
    twTarget.typing = typing
    scrollToBottom()
  }
})

/** 覆盖层三态：idle 居中搜索 / chat 居中对话 / docked 右贴小框 */
const mode = computed(() => (docked.value ? 'docked' : items.value.length ? 'chat' : 'idle'))

/** 输入联想池：每条带一个能力标签，点下拉里的一项把问句填进输入框（不直接发送）供继续编辑 */
const IDEAS: Array<{ tag: string; q: string }> = [
  { tag: '态势感知', q: '现在有多少在轨目标，数据新鲜吗？' },
  { tag: '碰撞预警', q: '最近一次碰撞扫描有哪些危险的接近事件？' },
  { tag: '交会分析', q: '最近的交会扫描事件结论如何？' },
  { tag: '过境预报', q: '帮我看看近期的卫星过境情况' },
  { tag: '即将发射', q: '最近哪个发射站即将发射火箭？' },
  { tag: '知识图谱', q: '这个系统的知识图谱里都关联了哪些内容？' },
  { tag: '找卫星', q: '帮我搜一下开运一号卫星的详细信息' },
  { tag: '找星座', q: '帮我找一下国网星座并展示它的全部成员' },
  { tag: '发射记录', q: '最近有哪些火箭发射记录？' }
]

/** 基于当前选中目标的推荐问题：本地模板生成，秒出、不占 CPU、不经过大模型 */
const suggestions = computed(() => buildSuggestions(props.target || null))

/** 输入联想池：当前目标推荐问题在前，其后补通用能力问句（按问句去重）；
 *  仅用于「有字符时」的输入联想下拉 */
const ideaPool = computed<Array<{ tag: string; q: string }>>(() => {
  const out: Array<{ tag: string; q: string }> = []
  const seen = new Set<string>()
  for (const s of suggestions.value) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push({ tag: '当前目标', q: s })
  }
  for (const c of IDEAS) {
    if (seen.has(c.q)) continue
    seen.add(c.q)
    out.push(c)
  }
  return out
})

/** 对话内事件卡 / 行内「定位」按钮 → 归一成界面动作，复用与模型下发动作同一条消费链路（index.vue onAiAction）。
 *  · conj / cri：转 select_conj_event（index.vue 按 source + 事件 id 现场查 /cgi/event/one 后定位）；
 *  · pass：key 为 "<norad>:<targetId>"，转 select_pass_city（targetId 定位过境目标，norad 再聚焦该星的那次过境）。
 *  命中态势类动作时把覆盖层收成右侧小框，让左边三维态势露出来（与模型动作为同一处理）。 */
function onRichGo(p: { source: string; key: string }) {
  const src = String(p.source || '').toLowerCase()
  const key = String(p.key || '')
  let action: AiAction
  if (src === 'pass') {
    const idx = key.indexOf(':')
    const norad = idx > 0 ? Number(key.slice(0, idx)) : NaN
    const targetId = Number(idx > 0 ? key.slice(idx + 1) : key)
    if (!(targetId > 0)) return
    action = { kind: 'select_pass_city', targetId, norad: Number.isFinite(norad) && norad > 0 ? norad : undefined }
  } else {
    action = { kind: 'select_conj_event', source: src === 'cri' ? 'cri' : 'local', key }
  }
  emit('action', action)
  if (SITUATION_KINDS.has(action.kind)) dockForSituation()
}

/** 输入联想下拉是否展开：只有在输入框有字符时才展开（聚焦空输入不弹） */
const dropOpen = ref(false)
/** 下拉展开方向：默认向下（贴输入框下沿）；只有下方确实放不下、且上方空间更大时才向上 */
const dropUp = ref(false)
/** 下拉最大高度：按最终方向的可用空间收口，避免被卡片顶/底边缘裁掉（内容超出时内部滚动） */
const dropMax = ref(260)
/** 回填联想项后会把光标重新交回输入框：那次 focus 事件不该再弹一次下拉（用完即复位） */
let skipNextFocusOpen = false
/** 展开下拉并选好方向与高度：向下优先 —— 只有「下方确实放不下」且「上方空间更大」时才向上，
 *  否则默认贴输入框下沿（不该无脑上翻）；
 *  选好方向后再按该侧可用空间收口高度，避免被卡片顶/底边缘裁掉（标题栏 z-index 高于下拉，
 *  故向上时可用高度要扣掉标题栏）。
 *  ⚠ 空输入不展开：聚焦时若没有字符，下拉不显示。 */
function openDropdown() {
  if (skipNextFocusOpen) return
  if (!input.value.trim()) { dropOpen.value = false; return }
  if (dropOpen.value) return
  dropOpen.value = true
  dropMax.value = 260 // 先按上限渲染，以便量出内容「真实高度」
  nextTick(() => {
    const card = cardRef.value
    const wrap = wrapRef.value
    const drop = dropRef.value
    if (!card || !wrap || !drop) return
    const cr = card.getBoundingClientRect()
    const wr = wrap.getBoundingClientRect()
    const head = card.querySelector('.ag-head') as HTMLElement | null
    const safeTop = head ? head.getBoundingClientRect().bottom : cr.top
    const below = cr.bottom - wr.bottom // 输入框下沿 → 卡片底边
    const above = wr.top - safeTop // 输入框上沿 → 标题栏下沿（向上时不会被标题栏盖住）
    const need = drop.getBoundingClientRect().height
    dropUp.value = below < need + 4 && above > below
    dropMax.value = Math.max(120, Math.min(260, (dropUp.value ? above : below) - 8))
  })
}
/** 下拉里的联想项：按输入关键字过滤「标签 + 问句」；空输入不返回任何项（下拉恒由字符触发）；
 *  有关键字但一条都没命中时回落整池 —— 联想池只有十余条，用户的自然问法多半命中不了，
 *  若此时返回空数组，v-if 的 dropItems.length 为 0 会让下拉整个消失（表现为「打字也不弹」） */
const dropItems = computed(() => {
  const kw = input.value.trim().toLowerCase()
  if (!kw) return []
  const all = ideaPool.value
  const hit = all.filter((x) => x.q.toLowerCase().includes(kw) || x.tag.toLowerCase().includes(kw))
  return (hit.length ? hit : all).slice(0, 8)
})
/** 点联想项：只把问句填进输入框（供继续编辑），不直接发送 */
function pickIdea(text: string) {
  input.value = text
  dropOpen.value = false
  nextTick(() => {
    const el = inputRef.value
    if (!el) return
    autoGrowInput()
    skipNextFocusOpen = true
    el.focus()
    el.setSelectionRange(text.length, text.length)
    skipNextFocusOpen = false
  })
}

/** 输入框最大高度 = 2 行文字（13px × 1.7 × 2 行 + 上下 padding 10px）：
 *  1~2 行随内容长高（不出滚动条），超过 2 行才在框内滚动 */
const INPUT_MAX_H = 54
/** 输入框高度自适应：先归零再按内容撑高，最多长到 2 行；再高由浏览器出滚动条 */
function autoGrowInput() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_H)}px`
}
/** 输入时：先自适应高度，再决定联想下拉的展开方向 */
function onInput() {
  autoGrowInput()
  openDropdown()
}

/** 是否跟随输出自动滚到底部：默认跟随；用户一旦上翻就交还主动权，滚回底部再自动恢复 */
let follow = true
/** 最近一次「用户滚动意图」的时间戳：内容增长也会让位置离开底部，只有用户操作才算接管 */
let userScrollAt = 0

/** 滚轮 / 触摸拖动 / 按住滚动条：都算用户滚动意图，记一次时间戳供 onListScroll 判定 */
function markUserScroll() {
  userScrollAt = performance.now()
}

/** 列表滚动：贴底即恢复跟随；离开底部只有确认是用户操作时才收回主动权 */
function onListScroll() {
  const el = listRef.value
  if (!el) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  if (atBottom) follow = true
  else if (performance.now() - userScrollAt < 400) follow = false
}

/** 滚到底部：只在「跟随中」时执行——用户上翻后不再被打字机拽回，主动权归用户 */
function scrollToBottom(force = false) {
  if (force) follow = true
  nextTick(() => {
    const el = listRef.value
    if (!el || !follow) return
    el.scrollTop = el.scrollHeight
  })
}

async function loadStatus() {
  try {
    status.value = await fetchAiStatus('public')
  } catch {
    status.value = null
  }
}

/** 内嵌标记（[[chart:...]] / [[kg:...]] / [[evt:...]]）：历史回灌前剥离，模型不需要「重读」自己的展示指令 */
const MARK_STRIP_RE = /\[\[\s*(?:chart|kg|evt)\s*:[^\]]*?\]\]/gi
/**
 * 剥离正文里的展示标记后再喂给模型：
 *   · 块级标记独占一行的：剥离后整行丢弃，避免留下空行；
 *   · 表格单元格里的行内标记：只删标记本身，保留表格结构（否则列会被删空）。
 * 标记是给前端渲染用的展示指令，回灌给模型只会占 token 并可能诱导它复读标记。
 */
function stripMarks(s: string): string {
  const lines = String(s).split('\n').map((ln) => {
    const cleaned = ln.replace(MARK_STRIP_RE, '')
    return cleaned.trim() === '' && cleaned !== ln ? '' : cleaned
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function historyPayload() {
  // 系统提示行（note）与本地消息（local）不进对话历史，免得模型把「目标已切换」「已执行…」当成它自己说过的话
  // 助手正文先剥离展示标记（[[chart]]/[[evt]]/[[kg]]），只回灌纯文字内容
  return items.value
    .filter((m) => !m.note && !m.local && m.content.trim())
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripMarks(m.content) : m.content }))
}

/** 无意义输入的委婉回绝（不走大模型，本地直接答复） */
const JUNK_REPLY = '宝子，问点有趣的问题吧～ 比如「北京未来 24 小时有哪些卫星过境」，或者试试输入框里的联想问题'
/** 常见无意义词（去标点、转小写后精确匹配） */
const JUNK_WORDS = new Set([
  'test', 'testing', 'tests', 'ceshi', 'demo', 'sample', 'foo', 'bar',
  'aaa', 'aaaa', 'abc', 'abcd', 'qwe', 'qwer', 'qwerty', 'asdf', 'asdfg', 'zxcv', 'xxx', 'xxxx',
  '测试', '测试下', '测试一下', '试一下', '试试', '在吗', '在么', '无意义', '随便问问', '随便问'
])
/**
 * 是否为无意义输入：命中则本地委婉回绝，不消耗大模型额度。
 * 判定口径（宁松勿严，只要能构成一个真实提问就放行给模型）：先去掉空白 / 标点 / 符号（含表情）取「实义核心」，再判
 *  ① 核心为空（纯符号 / 空白 / 表情）；② 核心为纯数字（11 / 22 / 11 22 / 123…）；
 *  ③ 核心是同一字符重复 ≥3 次（aaa / 哈哈哈）；④ 核心命中常见无意义词表。
 * 像「25544 是什么卫星」这类含实词的输入不会被拦。
 */
function isMeaninglessInput(q: string): boolean {
  const core = q.trim().replace(/[\s\p{P}\p{S}]/gu, '')
  if (!core) return true
  if (/^\d+$/.test(core)) return true
  if (/^(.)\1{2,}$/u.test(core)) return true
  return JUNK_WORDS.has(core.toLowerCase())
}

/** 无意义输入：把用户的原始输入与本地回绝都记进消息流（标记 local，不入历史、不发模型） */
function replyJunk(q: string) {
  items.value.push({
    role: 'user', content: q, shown: q, typing: false, elapsedMs: 0,
    tools: [], actions: [], phase: '', error: '', streaming: false, local: true
  })
  items.value.push({
    role: 'assistant', content: JUNK_REPLY, shown: JUNK_REPLY, typing: false, elapsedMs: 0,
    tools: [], actions: [], phase: '', error: '', streaming: false, local: true
  })
  scrollToBottom(true)
}

async function send(text?: string, opts?: { estimate?: boolean }) {
  if (sending.value) return
  const q = String(text ?? input.value).trim()
  if (!q) return
  input.value = ''
  // 发出后收起联想下拉：否则空输入会把整池思路重新弹出来盖住对话流
  dropOpen.value = false
  // 清空后把输入框高度收回 1 行（否则会保留上一次长文本撑高的高度）
  nextTick(autoGrowInput)
  // 无意义输入（test / 测试 / 11 / 22…）：本地委婉回绝，不走大模型
  if (isMeaninglessInput(q)) { replyJunk(q); return }
  // 新一轮提问开始：通知容器重置「本轮已清空展示效果」标志（下一轮首个展示型动作前再清空一次）
  emit('round-start')
  // 上下文在「发出这一条」时快照：之后用户切换目标，不会改变这条提问的指代
  const ctx = toContext(props.target || null)
  items.value.push({
    role: 'user', content: q, shown: q, typing: false, elapsedMs: 0,
    tools: [], actions: [], phase: '', error: '', streaming: false, ctx
  })
  const payload = historyPayload()
  tw.reset()
  // 用 reactive 包一层：打字机每帧要修改这条消息，必须走代理才能触发渲染
  const reply = reactive<ChatItem>({
    role: 'assistant', content: '', shown: '', typing: false, elapsedMs: 0,
    tools: [], actions: [], phase: '', error: '', streaming: true,
    estimate: opts?.estimate === true
  })
  twTarget = reply
  items.value.push(reply)
  sending.value = true
  // 记下本次提问口径：断流 / 出错后「重新生成」复用同一提问（不重复用户气泡）
  lastAsk = { ctx, estimate: opts?.estimate === true }
  scrollToBottom(true)
  await runStream(reply, payload, ctx, opts?.estimate === true)
}

/**
 * 真正跑一轮流式对话：把事件写进 reply、上抛界面动作、落错误与收尾。
 * 抽出来供 send() 与 regenerate() 复用（二者只差「是否新起一条用户气泡」）。
 */
async function runStream(reply: ChatItem, payload: AiMessage[], ctx: Record<string, unknown> | null, estimate: boolean) {
  ac = new AbortController()
  try {
    await streamAiChat({
      scope: 'public',
      messages: payload,
      context: ctx,
      estimate,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'delta') {
          // content 收全文（历史与最终态），shown 由打字机逐字吐出
          reply.content += e.text
          reply.phase = ''
          reply.typing = true
          tw.push(e.text)
        } else if (e.type === 'phase') {
          // 后端进度（加载模型 / 查库 / 轮询计算任务）统一走这里，在 chat 内实时显示
          reply.phase = e.message
          scrollToBottom()
        } else if (e.type === 'tool') {
          reply.tools.push(e.call)
          scrollToBottom()
        } else if (e.type === 'action') {
          // 界面动作：留轨迹 + 上抛给容器执行；态势类动作顺便把覆盖层收成小窗（移动端小横条）
          reply.actions.push(e.action)
          emit('action', e.action)
          if (SITUATION_KINDS.has(e.action.kind)) dockForSituation()
          scrollToBottom()
        } else if (e.type === 'meta') {
          // 诊断信息：本轮实际使用的模型 + 暴露给模型的工具集（排障用，不改变业务逻辑）
          reply.meta = { provider: e.provider, model: e.model, tools: e.tools }
        } else if (e.type === 'done') {
          reply.elapsedMs = e.elapsedMs
          reply.streaming = false
        } else if (e.type === 'error') {
          reply.error = e.message
          reply.streaming = false
        }
      }
    })
  } catch (e: any) {
    reply.error = e?.message || '对话失败'
  } finally {
    reply.streaming = false
    // 流已结束，但打字机可能还有缓冲：让它继续吐完（typing 变 false 后光标消失，即「输出完成」）
    tw.finish()
    sending.value = false
    ac = null
    scrollToBottom()
  }
}

/**
 * 重新生成：仅「上一条助手回复出错（断流 / 失败）」时可用 —— 移除失败的回复气泡，
 * 用同一提问（同一 context / estimate 口径）重跑一轮。不做静默自动重连：AI 生成不可透明续传，
 * 自动重试会造成重复计费与重复消息，故交给用户显式触发。
 */
async function regenerate() {
  if (sending.value || !lastAsk) return
  const last = items.value[items.value.length - 1]
  if (!last || last.role !== 'assistant') return
  items.value.pop()
  const payload = historyPayload()
  tw.reset()
  const reply = reactive<ChatItem>({
    role: 'assistant', content: '', shown: '', typing: false, elapsedMs: 0,
    tools: [], actions: [], phase: '', error: '', streaming: true,
    estimate: lastAsk.estimate
  })
  twTarget = reply
  items.value.push(reply)
  sending.value = true
  scrollToBottom(true)
  await runStream(reply, payload, lastAsk.ctx, lastAsk.estimate)
}

function stop() {
  ac?.abort()
  // 中断：已收到的内容立即全量显示，不要卡在半截打字状态
  tw.finish(true)
  sending.value = false
}

/**
 * 对外接口：外部入口（区域 / 多区域过境面板的「计算」）把一段提示词直接交给智能体提问。
 * 语义就是「以当前用户身份发起一轮提问」，因此完全复用 send()：无意义输入过滤、
 * 上下文快照、流式渲染等都不另写一套。
 * 点「计算」时用户期待结果立刻呈现在眼前：先展开浮层并退出小窗 / 小横条，再发送。
 * 该入口固定走「推算模式」（estimate）：不占本机 CPU、不查历史批次、结果不落库。
 */
async function ask(text: string) {
  const q = String(text ?? '').trim()
  if (!q) return
  emit('update:open', true)
  docked.value = false
  collapsed.value = false
  await nextTick()
  await send(q, { estimate: true })
}
defineExpose({ ask })

onMounted(() => {
  // 窄屏监听：移动端才允许「收起」，回到宽屏自动展开，避免残留收起态
  mqNarrow = window.matchMedia('(max-width: 768px)')
  narrow.value = mqNarrow.matches
  mqNarrow.addEventListener('change', onNarrowChange)
  // 视口尺寸变化后重新约束小窗拖动偏移，避免卡片被拖出屏幕
  window.addEventListener('resize', onViewportResize)
  // 组件一挂载就拉一次状态：「只读查询」提示依赖它，
  // 不能只靠 props.open 变化触发——抽屉常随页面以 open=true 直接挂载，那样 watcher 永不触发、status 恒为 null。
  if (!status.value) loadStatus()
})

onUnmounted(() => {
  if (noteTimer) clearTimeout(noteTimer)
  mqNarrow?.removeEventListener('change', onNarrowChange)
  window.removeEventListener('resize', onViewportResize)
})

/** 打开时拉一次状态（判断后端是否配置了大模型），并把光标交给输入框。
 *  每次打开都刷新（而非只在 status 为空时拉）：后端开关后，用户重开面板即可生效，
 *  不必整页刷新。 */
watch(() => props.open, (v) => {
  if (v) loadStatus()
  if (v) {
    scrollToBottom()
    nextTick(() => inputRef.value?.focus())
  }
})

/** 目标切换：只在消息流里插一行提示（不清空对话、不打断流式）。
 *  因为上下文是「随消息快照」的，旧问答仍指向旧目标，插一行是为了让用户知道指代已经变了。
 *
 *  ⚠ 去抖（noteTimer）：拾取新目标时前端会先把当前选中态清掉（collapseList）再异步选中新星，
 *  目标键会经历「旧 → 空 → 新」两次跳变；若每次跳变立刻插提示，就会出现
 *  「先已取消选中目标、随后又目标已切换」的重复噪音。这里等 700ms 稳定后再按最终选中态插一行。 */
let noteTimer: ReturnType<typeof setTimeout> | null = null
watch(() => props.target?.key || '', (k, old) => {
  if (!old || k === old || !items.value.length || !props.open) return
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    noteTimer = null
    if (!props.open || !items.value.length) return
    const cur = props.target?.key || ''
    items.value.push({
      role: 'assistant',
      content: cur && props.target?.label ? `目标已切换：${props.target.label}` : '已取消选中目标',
      shown: '',
      typing: false,
      elapsedMs: 0,
      tools: [],
      actions: [],
      phase: '',
      error: '',
      streaming: false,
      note: true
    })
    scrollToBottom()
  }, 700)
})
</script>

<template>
  <div class="ai-glass" :class="[mode, { open, collapsed }]">
    <!-- 毛玻璃底：idle/chat 全屏虚化三维背景当底图；docked 时透明且不吃事件，让左侧态势露出可交互。
         点它不关闭智能体（智能体是页面主体），只作虚化底并吃掉点击，避免误点穿到底下的三维场景 -->
    <div class="ag-scrim"></div>

    <div
      ref="cardRef"
      class="ag-card"
      :style="docked ? { transform: `translate(${dragX}px, ${dragY}px)` } : undefined"
    >
      <div
        class="ag-head"
        :class="{ draggable: docked, dragging }"
        @pointerdown="onHeadPointerDown"
        @pointermove="onHeadPointerMove"
        @pointerup="onHeadPointerUp"
        @pointercancel="onHeadPointerUp"
      >
        <span class="ag-title"><i class="dot"></i>太空安全专家<b>AI</b></span>
        <span class="ag-links">
          <button class="ag-link" type="button" @click="openFeedback">问题反馈</button>
          <i class="ag-link-sep"></i>
          <button class="ag-link" type="button" @click="openCooperation">商业合作</button>
        </span>
        <!-- 顶部缩放入口：小窗 ↔ 全屏 一个按钮切换（宽屏用）；不提供关闭（智能体是态势页主体，由页面左侧入口启停） -->
        <button
          class="ag-icon ag-scale"
          :title="docked ? '放大全屏' : '缩小为小窗'"
          @click="onToggleDock"
        >{{ docked ? '⤢' : '⤡' }}</button>
        <!-- 最小化（宽屏）：直接关闭整个浮层，底部 dock 的「智能体」入口随之取消高亮、框体一并隐藏 -->
        <button
          class="ag-icon ag-min"
          title="最小化（关闭智能体，露出三维主屏）"
          @click="onMinimize"
        >—</button>
        <!-- 移动端「收起」：直接关闭整个浮层（底部 dock 的「智能体」入口随之取消高亮），把三维主屏交还用户；
             已处于收起小横条时点它先展开回对话（宽屏隐藏，用上面的缩放入口） -->
        <button
          class="ag-icon ag-collapse"
          :title="collapsed ? '展开智能体' : '收起（关闭智能体，露出三维主屏）'"
          @click="onToggleCollapse"
        >{{ collapsed ? '▴' : '▾' }}</button>
      </div>

      <div v-if="status?.enabled === false" class="ag-warn">
        智能体暂未开放（后端尚未配置大模型）。
      </div>

      <div
        ref="listRef"
        class="ag-list"
        :class="{ plain: !items.length }"
        @wheel="markUserScroll"
        @touchmove="markUserScroll"
        @mousedown="markUserScroll"
        @scroll="onListScroll"
      >
        <!-- 空态：品牌大标题 + 能力说明（idle 态的主体） -->
        <div v-if="!items.length" class="ag-hero">
          <h2>开源太空安全</h2>
          <p class="ag-sub">卫星资料 · 知识图谱 · 碰撞预警 · 交会分析 · 过境预报 · 发射记录</p>
        </div>

        <template v-for="(m, i) in items" :key="i">
          <div v-if="m.note" class="ag-sysnote">{{ m.content }}</div>
          <div v-else class="ag-msg" :class="m.role">
            <div class="ag-who">{{ m.role === 'user' ? '我' : 'AI' }}</div>
            <div class="ag-body">
              <!-- 思考轨迹（界面动作 + 工具调用）：流式进行中自动展开，回答结束后折叠成一行，
                   点标题可随时展开回看（用户口径：思考时展开，结束后折叠） -->
              <div v-if="m.actions.length || m.tools.length" class="ag-trail">
                <button
                  type="button"
                  class="ag-trail-head"
                  :class="{ live: m.streaming }"
                  @click="m.trailOpen = !m.trailOpen"
                >
                  <span class="th-arrow" :class="{ open: trailExpanded(m) }">▸</span>
                  <span class="th-text">思考过程</span>
                  <span class="th-count">{{ trailCount(m) }} 步</span>
                  <span v-if="m.streaming" class="th-live">进行中</span>
                  <span v-else class="th-toggle">{{ trailExpanded(m) ? '收起' : '展开' }}</span>
                </button>
                <div v-show="trailExpanded(m)" class="ag-trail-body">
                  <!-- 界面动作轨迹：让用户知道「已经帮你定位/打开了什么」，与工具轨迹分开显示 -->
                  <div v-for="(a, ai) in m.actions" :key="'a' + ai" class="ag-act">
                    <span class="ac-name">→ {{ actionText(a) }}</span>
                  </div>
                  <!-- 工具调用轨迹 -->
                  <div v-for="(t, ti) in m.tools" :key="ti" class="ag-tool" :class="{ bad: !t.ok }">
                    <span class="t-name">▸ {{ TOOL_LABEL[t.name] || t.name }}</span>
                    <span class="t-res">{{ t.result }}</span>
                  </div>
                </div>
              </div>
              <!-- 推算模式免责声明：前端确定性渲染，不依赖模型自觉在正文开头声明
                   （后端 ESTIMATE_PROMPT 已不再要求模型重复写这句，避免与模型措辞叠加） -->
              <div v-if="m.role === 'assistant' && m.estimate" class="ag-est-note">
                <span class="en-ico">⚠</span>
                <span class="en-text">示意性推算（非 SGP4 轨道外推），数值不可作为工程依据</span>
              </div>
              <!-- 正文由打字机逐字吐出：typing 为真时末尾跟一个闪烁光标。
                   AI 正文走轻量 Markdown 渲染（表格/列表/加粗/图表标记），用户提问保持纯文本 -->
              <div v-if="m.shown" class="ag-bubble" :class="{ rich: m.role === 'assistant' }">
                <!-- AI 正文：光标由 AiRichText 注入到最后一个文本块内（跟着文字走，不另起一行）；
                     「猜你想问」候选项点击 → pickIdea 只回填输入框，不直接发送；
                     事件卡 / 行内「定位」按钮点击 → onRichGo 转成界面动作定位到三维事件 -->
                <AiRichText
                  v-if="m.role === 'assistant'"
                  :text="m.shown"
                  :typing="m.typing"
                  @pick="pickIdea"
                  @go="onRichGo"
                />
                <template v-else>{{ m.shown }}<span v-if="m.typing" class="tk-cursor"></span></template>
              </div>
              <!-- 本轮产物下载入口（报告 / 导出数据）：放在正文下方而不是思考轨迹里 ——
                   轨迹结束后默认折叠，放里面用户看不到；href 经 uploadUrl() 补部署前缀（子路径部署下裸路径会 404） -->
              <div v-if="m.role === 'assistant' && msgDownloads(m).length" class="ag-dls">
                <a
                  v-for="d in msgDownloads(m)"
                  :key="d.url"
                  class="t-dl"
                  :href="uploadUrl(d.url)"
                  download
                  target="_blank"
                  rel="noopener"
                >
                  <svg class="t-dl-ico" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M8 1.5a.75.75 0 0 1 .75.75v5.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l1.72 1.72V2.25A.75.75 0 0 1 8 1.5Z"
                    />
                    <path
                      fill="currentColor"
                      d="M2.5 10a.75.75 0 0 1 .75.75v1.5c0 .414.336.75.75.75h8c.414 0 .75-.336.75-.75v-1.5a.75.75 0 0 1 1.5 0v1.5A2.25 2.25 0 0 1 12 15.5H4a2.25 2.25 0 0 1-2.25-2.25v-1.5A.75.75 0 0 1 2.5 10Z"
                    />
                  </svg>
                  <span>{{ d.label }}</span>
                </a>
              </div>
              <!-- 还没吐出正文时：三点思考动效 + 后端进度（加载模型 / 查库 / 轮询计算任务） -->
              <div v-if="m.streaming && !m.shown" class="ag-bubble pending">
                <span class="think"><i></i><i></i><i></i></span>
                <span class="think-text">{{ m.phase || '正在思考…' }}</span>
              </div>
              <!-- 正文已吐完但仍在跑后续工具调用：继续给出进度，让用户知道还没结束 -->
              <div v-else-if="m.streaming && !m.typing && m.phase" class="ag-hint">{{ m.phase }}</div>
              <!-- 出错（断流 / 失败）：仅最后一条助手消息可「重新生成」——移除这条失败回复，用同一提问重跑，
                   不做静默自动重连（AI 生成不可透明续传，自动重试会重复计费 / 重复消息） -->
              <div v-if="m.error" class="ag-bubble err">
                <span class="err-text">{{ m.error }}</span>
                <button
                  v-if="i === items.length - 1 && !sending"
                  class="err-retry"
                  type="button"
                  @click="regenerate()"
                >重新生成</button>
              </div>
              <!-- 输出完成：打字光标消失后再给一行明确标识，用户不用猜有没有说完 -->
              <div v-if="!m.streaming && !m.typing && m.elapsedMs" class="ag-done">
                ✓ 输出完成<span v-if="m.elapsedMs"> · 耗时 {{ (m.elapsedMs / 1000).toFixed(1) }}s</span>
              </div>
              <!-- 诊断信息（meta 事件）：本轮实际使用的模型 + 暴露给模型的工具集，仅用于排障，悬停看全量工具名 -->
              <div v-if="m.meta" class="ag-meta" :title="m.meta.tools.join('、')">
                <span class="am-model">{{ m.meta.model || m.meta.provider || '未知模型' }}</span>
                <span class="am-sep">·</span>
                <span class="am-tools">{{ m.meta.tools.length }} 个工具</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="ag-input">
        <div ref="wrapRef" class="ag-box-wrap">
          <!-- 输入联想下拉：仅在输入框有字符时才出现（聚焦空输入不弹），按关键字过滤检索思路，点击填入输入框继续编辑 -->
          <div
            v-if="dropOpen && mode !== 'docked' && dropItems.length"
            ref="dropRef"
            class="ag-drop"
            :class="{ up: dropUp }"
            :style="{ maxHeight: dropMax + 'px' }"
          >
            <div
              v-for="(d, di) in dropItems"
              :key="d.tag + '|' + d.q + '|' + di"
              class="ag-drop-item"
              @mousedown.prevent="pickIdea(d.q)"
            >
              <span class="dd-tag">{{ d.tag }}</span>
              <span class="dd-text">{{ d.q }}</span>
            </div>
          </div>

          <div class="ag-box">
            <textarea
              ref="inputRef"
              v-model="input"
              rows="1"
              maxlength="500"
              placeholder="问我任何空间目标、碰撞风险、过境或发射记录的问题…"
              @focus="openDropdown"
              @blur="dropOpen = false"
              @input="onInput"
              @keydown.enter.exact.prevent="send()"
            ></textarea>
            <button v-if="sending" class="ag-stop" title="停止" @click="stop">■</button>
            <button v-else class="ag-send" :disabled="!input.trim() || status?.enabled === false" @click="send()">发送</button>
          </div>
        </div>
      </div>

      <div class="ag-note">初筛结果仅供参考，不构成规避决策依据。</div>
    </div>

    <!-- 标题栏入口：问题反馈 / 商业合作（免登录匿名提交） -->
    <ContactDialog v-model="feedbackOpen" kind="feedback" />
    <ContactDialog v-model="cooperationOpen" kind="cooperation" />
  </div>
</template>

<style scoped>
/* 覆盖层：默认全屏居中（idle / chat），命中态势动作时右贴（docked） */
.ai-glass {
  /* 卡片恒为暗色玻璃，文字色必须固定为亮色：/situation 与后台是同一个 SPA，
     用户若把后台主题切成 light / saas，全局 --text-1/2/3 会变成深色，
     叠在暗色玻璃上就「看不清」（标题、输入框内容、快捷词都发暗）。
     这里在本组件作用域内重声明这几个变量，子树一律取亮色，不跟随主题。 */
  --text-1: #e8edf5;
  --text-2: #c2ccdd;
  --text-3: #93a0b4;
  --ok: #4ade80;
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: center;
  /* 覆盖层本身不吃事件（否则 docked 态整层盖住左侧三维态势，拾取/拖拽全被吞）；
     真正可交互的只有 .ag-card（卡片本体）；.ag-scrim 只作虚化底并吃掉点击，不关闭对话框 */
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s;
}
.ai-glass.open {
  opacity: 1;
  visibility: visible;
}
.ai-glass.idle {
  align-items: center;
}
.ai-glass.chat {
  align-items: center;
  padding: 56px 0 40px;
}
.ai-glass.docked {
  align-items: flex-end;
  justify-content: center;
  /* 底部小窗：浮在底部「按钮栏 + 时间条」之上，避开左侧「复位」与右侧图例 */
  padding: 0 14px calc(122px + env(safe-area-inset-bottom));
}

/* 毛玻璃底：三维背景当底图（docked 时完全透明，左侧态势直接可交互） */
.ag-scrim {
  position: absolute;
  inset: 0;
  /* idle/chat 时它是虚化底：吃事件只为「点空白别穿到底下三维场景」，点击不再关闭对话框；
     docked 时靠下面单条规则彻底放行，让左侧态势可交互 */
  pointer-events: auto;
  background: rgba(7, 11, 19, 0.5);
  backdrop-filter: blur(16px) saturate(1.25);
  -webkit-backdrop-filter: blur(16px) saturate(1.25);
  transition: background 0.24s ease, backdrop-filter 0.24s ease;
}
.ai-glass.docked .ag-scrim {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  pointer-events: none;
}

/* 卡片本体：布局容器。全屏态（idle/chat）刻意「不画框」——像搜索页那样直接浮在虚化背景上展开；
   只有收成右侧小窗（docked）时才套上玻璃框（用户口径：展开不要框，缩放变成框可以） */
.ag-card {
  position: relative;
  z-index: 1;
  /* 卡片本体要恢复吃事件（父层已关掉） */
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  width: min(820px, 92vw);
  height: min(78vh, 720px);
  color: var(--text-1);
  overflow: hidden;
  transition: width 0.26s ease, height 0.26s ease, background 0.26s ease;
}
.ai-glass.idle .ag-card {
  height: auto;
  /* 空态内容可能较高（历史恢复等场景）：封顶到 88vh，超出部分交给 .ag-list 内部滚动 */
  max-height: 88vh;
}
/* docked（底部小窗）：套上玻璃框，成为一张贴在底部的独立卡片 */
.ai-glass.docked .ag-card {
  width: min(560px, 94vw);
  height: auto;
  max-height: min(62vh, 520px);
  border: 1px solid rgba(127, 216, 255, 0.18);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(22, 30, 44, 0.78), rgba(13, 19, 30, 0.86));
  backdrop-filter: blur(22px) saturate(1.3);
  -webkit-backdrop-filter: blur(22px) saturate(1.3);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 24px 60px rgba(0, 0, 0, 0.55);
}
/* 全屏态：标题栏与输入区也一并去分隔线与底色，让整体「展开」而不是「卡片」 */
.ai-glass.idle .ag-head,
.ai-glass.chat .ag-head {
  border-bottom-color: transparent;
  background: transparent;
}
.ai-glass.idle .ag-input,
.ai-glass.chat .ag-input {
  border-top-color: transparent;
}

/* 标题栏：提升层级，保证关闭按钮永不被输入联想下拉盖住 */
.ag-head {
  position: relative;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid rgba(127, 216, 255, 0.14);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0));
}
/* 小窗态：标题栏兼作拖动把手（touch-action:none 让触摸也不抢页面手势，user-select 防止拖出选区） */
.ag-head.draggable {
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.ag-head.dragging {
  cursor: grabbing;
}
.ag-title {
  display: inline-flex;
  align-items: center;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.4px;
}
.ag-title .dot {
  width: 7px;
  height: 7px;
  margin-right: 8px;
  border-radius: 50%;
  background: #7fd8ff;
  box-shadow: 0 0 8px rgba(127, 216, 255, 0.9);
}
.ag-title b {
  margin-left: 7px;
  font-size: 10px;
  line-height: 1.6;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(127, 216, 255, 0.16);
  border: 1px solid rgba(127, 216, 255, 0.35);
  color: #7fd8ff;
}
.ag-links {
  margin-left: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  /* 窗口窄时优先让位给缩放入口：超出即裁掉，不把图标挤出可视区 */
  min-width: 0;
  overflow: hidden;
}
.ag-link {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s;
}
.ag-link:hover { color: #7fd8ff; }
.ag-link-sep {
  flex: none;
  width: 1px;
  height: 10px;
  color: var(--text-3);
  background: currentColor;
  opacity: 0.28;
}
.ag-icon {
  margin-left: auto;
  /* 图标按钮不参与收缩，避免卡片变窄时被裁掉 */
  flex: none;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1;
  padding: 4px 8px;
  transition: color 0.15s, border-color 0.15s;
}
.ag-icon:hover {
  color: #7fd8ff;
  border-color: rgba(127, 216, 255, 0.4);
}
/* 「收起」按钮：仅移动端显示（宽屏走上面的「缩小为小窗」，两者是同一意图的两种形态） */
.ag-icon.ag-collapse {
  display: none;
  margin-left: 2px;
}
/* 「最小化」按钮（宽屏）：紧贴缩放入口，关闭整个浮层（移动端由「收起」承担同一职责，故窄屏隐藏） */
.ag-icon.ag-min {
  margin-left: 2px;
}

/* 小窗（docked）态：卡片仅 420px 宽，标题栏可用宽度有限。
   收紧字号与间距，标题禁止换行且不收缩（溢出由更长的入口文字承担裁剪），避免标题折行、入口被切字 */
.ai-glass.docked .ag-head {
  gap: 5px;
  padding: 8px 12px;
}
.ai-glass.docked .ag-title {
  flex: none;
  font-size: 12px;
  letter-spacing: 0.2px;
  white-space: nowrap;
}
.ai-glass.docked .ag-title .dot {
  width: 6px;
  height: 6px;
  margin-right: 5px;
}
.ai-glass.docked .ag-title b {
  margin-left: 4px;
  font-size: 9px;
  padding: 0 4px;
}
.ai-glass.docked .ag-links {
  margin-left: 4px;
  gap: 5px;
}
.ai-glass.docked .ag-link { font-size: 11px; }
.ai-glass.docked .ag-icon {
  padding: 3px 5px;
  font-size: 12px;
}
.ai-glass.docked .ag-icon.ag-min { margin-left: 1px; }

.ag-warn {
  padding: 8px 14px;
  font-size: 12px;
  color: #ffb347;
  border-bottom: 1px solid rgba(255, 179, 71, 0.25);
  background: rgba(255, 179, 71, 0.08);
}

/* 消息区（透明容器：玻璃感来自卡片本身，避免再叠一层实色把背景糊死） */
.ag-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 4px;
  /* Firefox：细滚动条 + 亮青色滑块 */
  scrollbar-width: thin;
  scrollbar-color: rgba(95, 176, 240, 0.6) transparent;
}
/* WebKit：对话文本区滚动条改为亮青渐变（对齐输入框与三维态势的发光质感） */
.ag-list::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.ag-list::-webkit-scrollbar-track {
  background: transparent;
}
.ag-list::-webkit-scrollbar-thumb {
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(127, 216, 255, 0.55), rgba(63, 143, 214, 0.55));
}
.ag-list::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(169, 232, 255, 0.8), rgba(85, 168, 236, 0.8));
}
.ag-list.plain {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-bottom: 0;
}
.ag-hero {
  text-align: center;
  padding: 4px 8px 14px;
}
.ag-hero h2 {
  margin: 0 0 8px;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 8px;
  text-indent: 8px;
  background: linear-gradient(180deg, #eaf7ff 0%, #7fd8ff 60%, #3f9fd4 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  text-shadow: 0 0 24px rgba(127, 216, 255, 0.35);
}
.ag-hero .ag-sub {
  margin: 0 auto;
  max-width: 560px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--text-3);
}

/* 「目标已切换」等系统提示行 */
.ag-sysnote {
  margin: 4px 0 12px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}

/* ------------------------------ 消息 ------------------------------ */
.ag-msg {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.ag-who {
  flex: 0 0 30px;
  padding-top: 6px;
  text-align: right;
  font-size: 11px;
  letter-spacing: 0.5px;
  color: var(--text-3);
}
.ag-msg.user .ag-who {
  color: #7fd8ff;
}
.ag-body {
  flex: 1;
  min-width: 0;
}

/* AI 气泡：比玻璃再亮一档的浅玻璃块 */
.ag-bubble {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 1.75;
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px 10px 10px 10px;
  background: rgba(255, 255, 255, 0.05);
}
/* AI 富文本气泡：交给 Markdown 块自己排版，不再保留文本里的空白与换行 */
.ag-bubble.rich {
  white-space: normal;
}
/* 用户气泡：冷色渐变 + 左上角收口，一眼能区分「谁在说」 */
.ag-msg.user .ag-bubble {
  border-radius: 10px 4px 10px 10px;
  border-color: rgba(127, 216, 255, 0.32);
  background: linear-gradient(180deg, rgba(127, 216, 255, 0.2), rgba(127, 216, 255, 0.08));
}
/* 「正在思考…」：三点跳动 + 后端进度文字 */
.ag-bubble.pending {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-3);
}
.think {
  display: inline-flex;
  gap: 3px;
}
.think i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7fd8ff;
  opacity: 0.35;
  animation: think-bounce 1.2s ease-in-out infinite;
}
.think i:nth-child(2) {
  animation-delay: 0.16s;
}
.think i:nth-child(3) {
  animation-delay: 0.32s;
}
@keyframes think-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-4px); opacity: 1; }
}
.ag-bubble.err {
  color: #ff8a8a;
  border-color: rgba(255, 92, 92, 0.4);
  background: rgba(255, 92, 92, 0.08);
}
/* 出错气泡里的「重新生成」：仅最后一条助手消息显示，纯文字按钮贴在错误文案右侧 */
.err-retry {
  margin-left: 8px;
  padding: 1px 8px;
  border: 1px solid rgba(255, 138, 138, 0.5);
  border-radius: 6px;
  background: rgba(255, 92, 92, 0.14);
  color: #ff8a8a;
  font-size: 11.5px;
  line-height: 1.6;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.err-retry:hover {
  background: rgba(255, 92, 92, 0.26);
  color: #ffc6c6;
}

/* 打字机光标：紧跟已吐出的文字闪烁，看到它就知道「还在写」 */
.tk-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 1px;
  vertical-align: -2px;
  background: #7fd8ff;
  animation: tk-blink 0.9s steps(1, end) infinite;
}
@keyframes tk-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

/* 正文已吐完、但仍在跑后续工具调用：给一行进度，避免用户误以为回答结束 */
.ag-hint {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-3);
}
/* 推算模式免责声明条：前端固定渲染（琥珀警示色，与「已完成」的绿色区分） */
.ag-est-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 2px 0 6px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid rgba(255, 200, 97, 0.32);
  background: rgba(255, 200, 97, 0.1);
  font-size: 11.5px;
  line-height: 1.5;
  color: #ffce7a;
}
.ag-est-note .en-ico {
  flex: none;
  font-size: 12px;
  line-height: 1.45;
}
/* 输出完成：光标消失后再给一行明确标识 —— 不用猜有没有说完 */
.ag-done {
  margin-top: 5px;
  font-size: 11px;
  letter-spacing: 0.3px;
  color: var(--ok);
}
/* 诊断信息行（meta 事件）：模型名 + 工具数，弱化展示仅作排障参考 */
.ag-meta {
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--text-4);
  opacity: 0.7;
}
.ag-meta .am-sep {
  margin: 0 5px;
}

/* --------------------------- 思考轨迹（可折叠） --------------------------- */
/* 一行「思考过程 · N 步」标题：进行中常展开，回答结束后自动收起，点标题可回看 */
.ag-trail {
  margin-bottom: 6px;
}
.ag-trail-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid rgba(127, 216, 255, 0.18);
  border-radius: 999px;
  background: rgba(127, 216, 255, 0.06);
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.ag-trail-head:hover {
  color: var(--text-1);
  border-color: rgba(127, 216, 255, 0.4);
  background: rgba(127, 216, 255, 0.12);
}
.ag-trail-head.live {
  color: #7fd8ff;
  border-color: rgba(127, 216, 255, 0.42);
}
.th-arrow {
  display: inline-block;
  transition: transform 0.18s ease;
}
.th-arrow.open {
  transform: rotate(90deg);
}
.th-count {
  color: #7fd8ff;
}
.th-live {
  color: #7fd8ff;
  animation: tk-blink 1.1s steps(1, end) infinite;
}
.th-toggle {
  opacity: 0.7;
}
.ag-trail-body {
  margin-top: 6px;
}

/* --------------------------- 界面动作轨迹 --------------------------- */
.ag-act {
  margin-bottom: 5px;
  padding: 5px 9px;
  border: 1px solid rgba(127, 216, 255, 0.25);
  border-left: 2px solid rgba(127, 216, 255, 0.85);
  border-radius: 0 6px 6px 0;
  background: rgba(127, 216, 255, 0.1);
  font-size: 11.5px;
}
.ac-name {
  color: #7fd8ff;
  font-weight: 600;
}

/* --------------------------- 工具调用轨迹 --------------------------- */
.ag-tool {
  margin-bottom: 5px;
  padding: 5px 9px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-left: 2px solid rgba(127, 216, 255, 0.55);
  border-radius: 0 6px 6px 0;
  background: rgba(255, 255, 255, 0.04);
  font-size: 11.5px;
  color: var(--text-3);
}
.ag-tool.bad {
  border-left-color: #ff8a8a;
}
.t-name {
  color: #7fd8ff;
}
.t-res {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
  margin-top: 3px;
}
/* 正文下方的产物下载入口（报告 / 导出数据）：与思考轨迹分离，回答区一眼可见 */
.ag-dls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
/* 报告产物下载入口（图标 + 文字，点击即下载） */
.t-dl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 9px 2px 7px;
  border: 1px solid rgba(127, 216, 255, 0.55);
  border-radius: 4px;
  color: #7fd8ff;
  font-size: 11px;
  text-decoration: none;
  cursor: pointer;
}
.t-dl-ico {
  flex: none;
}
.t-dl:hover {
  background: rgba(127, 216, 255, 0.12);
}

/* ------------------------------ 输入区 ------------------------------ */
.ag-input {
  padding: 10px 14px 4px;
  border-top: 1px solid rgba(127, 216, 255, 0.12);
}
/* 输入框外层定位容器：下拉联想菜单相对它定位（默认贴输入框下沿） */
.ag-box-wrap {
  position: relative;
}
/* 输入联想下拉：默认贴输入框下沿弹出（向下），最多 8 条，超出滚动；
   下方放不下时加 .up 改贴输入框上沿（向上），避免被卡片底边裁掉 */
.ag-drop {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 5;
  max-height: 260px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid rgba(127, 216, 255, 0.24);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(26, 35, 51, 0.97), rgba(15, 22, 34, 0.97));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.ag-drop.up {
  top: auto;
  bottom: calc(100% + 6px);
}
.ag-drop-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.5;
  cursor: pointer;
}
.ag-drop-item:hover {
  background: rgba(127, 216, 255, 0.12);
  color: var(--text-1);
}
.dd-tag {
  flex: none;
  padding: 0 6px;
  border: 1px solid rgba(127, 216, 255, 0.35);
  border-radius: 4px;
  background: rgba(127, 216, 255, 0.12);
  color: #7fd8ff;
  font-size: 10.5px;
  line-height: 1.75;
}
.dd-text {
  min-width: 0;
}

/* 简约输入框：一整条圆角玻璃，聚焦时冷光描边 */
.ag-box {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.05);
  transition: border-color 0.18s, box-shadow 0.18s;
}
.ag-box:focus-within {
  border-color: rgba(127, 216, 255, 0.6);
  box-shadow: 0 0 0 3px rgba(127, 216, 255, 0.12);
}
.ag-box textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.7;
  box-sizing: border-box;
  /* 封顶 2 行（54px）：1~2 行随内容长高不出滚动条，超过才在框内滚动 */
  max-height: 54px;
  overflow-y: auto;
  padding: 5px 0;
  font-family: inherit;
  /* Firefox：细滚动条 + 亮青色滑块 */
  scrollbar-width: thin;
  scrollbar-color: #5fb0f0 transparent;
}
.ag-box textarea::placeholder {
  color: var(--text-3);
}
/* WebKit：滚动条改为亮青渐变（系统灰条太丑），仅在超过 2 行时才出现 */
.ag-box textarea::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.ag-box textarea::-webkit-scrollbar-track {
  background: transparent;
}
.ag-box textarea::-webkit-scrollbar-thumb {
  border-radius: 6px;
  background: linear-gradient(180deg, #7fd8ff, #3f8fd6);
}
.ag-box textarea::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, #a9e8ff, #55a8ec);
}
.ag-send {
  flex: 0 0 auto;
  cursor: pointer;
  padding: 6px 16px;
  border: 1px solid rgba(127, 216, 255, 0.5);
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(127, 216, 255, 0.3), rgba(127, 216, 255, 0.14));
  color: var(--text-1);
  font-size: 12.5px;
  transition: background 0.15s;
}
.ag-send:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(127, 216, 255, 0.44), rgba(127, 216, 255, 0.22));
}
.ag-send:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.ag-stop {
  flex: 0 0 auto;
  cursor: pointer;
  padding: 6px 14px;
  border: 1px solid rgba(255, 138, 138, 0.45);
  border-radius: 10px;
  background: rgba(255, 92, 92, 0.14);
  color: #ff8a8a;
  font-size: 12px;
}

.ag-note {
  padding: 0 14px 10px;
  font-size: 11px;
  color: var(--text-3);
}

@media (max-width: 768px) {
  /* 移动端：一律底部大卡片，不做左右分栏（屏幕太窄，态势与对话无法并存） */
  .ai-glass,
  .ai-glass.idle,
  .ai-glass.chat,
  .ai-glass.docked {
    align-items: flex-end;
    justify-content: center;
    padding: 0;
  }
  .ag-card,
  .ai-glass.idle .ag-card,
  .ai-glass.chat .ag-card,
  .ai-glass.docked .ag-card {
    width: auto;
    height: 78vh;
    margin: 0 8px 78px;
    border: 1px solid rgba(127, 216, 255, 0.18);
    border-radius: 16px;
    background: linear-gradient(180deg, rgba(22, 30, 44, 0.9), rgba(13, 19, 30, 0.94));
    backdrop-filter: blur(22px) saturate(1.3);
    -webkit-backdrop-filter: blur(22px) saturate(1.3);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 24px 60px rgba(0, 0, 0, 0.55);
  }
  .ai-glass.idle .ag-card {
    height: auto;
  }
  /* 移动端一律底部卡片：恢复标题栏/输入区的分隔线与底色 */
  .ai-glass.idle .ag-head,
  .ai-glass.chat .ag-head {
    border-bottom-color: rgba(127, 216, 255, 0.14);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0));
  }
  .ai-glass.idle .ag-input,
  .ai-glass.chat .ag-input {
    border-top-color: rgba(127, 216, 255, 0.12);
  }
  .ag-hero h2 {
    font-size: 24px;
    letter-spacing: 6px;
    text-indent: 6px;
  }
  .ag-list {
    padding: 12px 12px 4px;
  }

  /* 移动端底部卡片标题栏同样收紧：避免标题折行、入口文字被切字（与桌面小窗一致） */
  .ag-head {
    gap: 5px;
    padding: 9px 12px;
  }
  .ag-title {
    flex: none;
    font-size: 12px;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }
  .ag-title .dot {
    width: 6px;
    height: 6px;
    margin-right: 5px;
  }
  .ag-title b {
    margin-left: 4px;
    font-size: 9px;
    padding: 0 4px;
  }
  .ag-links {
    margin-left: 4px;
    gap: 5px;
  }
  .ag-link { font-size: 11px; }

  /* 移动端智能体入口：显示「收起」、隐藏「缩小为小窗」（窄屏下小窗即底部卡片，原按钮无意义） */
  .ag-icon.ag-scale,
  .ag-icon.ag-min { display: none; }
  .ag-icon.ag-collapse {
    display: inline-flex;
    margin-left: auto;
  }
  /* 移动端「收起」态：底部大卡片收成一条贴底小横条，毛玻璃底一并放行，把三维主屏整个露出来可交互 */
  .ai-glass.collapsed .ag-scrim {
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    pointer-events: none;
  }
  .ai-glass.collapsed .ag-card {
    width: auto;
    height: auto;
    max-width: calc(100vw - 16px);
    /* 与展开态同一留白：浮在底部 Tab 栏之上 */
    margin: 0 auto 78px;
    border-radius: 999px;
  }
  /* 收起时卡片只剩标题一条：正文、输入区、历史一并隐藏 */
  .ai-glass.collapsed .ag-card > *:not(.ag-head) {
    display: none;
  }
  .ai-glass.collapsed .ag-head {
    padding: 9px 12px;
    border-bottom-color: transparent;
    background: transparent;
  }
  /* 收起横条只留「标题 + 展开按钮」：入口文案让位，保持紧凑 */
  .ai-glass.collapsed .ag-links {
    display: none;
  }
}
</style>
