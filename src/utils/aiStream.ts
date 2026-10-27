/**
 * 空间态势分析智能体 —— 前端流式对话客户端（SSE over POST）
 *
 * 为什么不用 EventSource：EventSource 只能 GET、不能带请求体，而对话必须 POST 消息数组。
 * 所以用 fetch + ReadableStream 手工解析 SSE（event:/data: 成对），与后端 lib/ai/agent.js
 * 的 openSse 一一对应。中途关闭（关面板 / 点停止）会 abort 请求，后端据此中断模型请求。
 *
 * 两套入口严格分离（项目约定）：
 *   admin  → /api/ai/*  后台，需登录（带 Cookie 凭证），含管理员写工具
 *   public → /cgi/ai/*  前台免登录态势页，只读工具 + 报告生成工具（按 IP 每日限额），按 IP 限流
 *
 * 另含历史对话的读取接口（/api/ai/history*）：只给「历史对话」页面浏览用，只读、不喂模型。
 */
import { API_BASE, http } from '@/utils/request'

export type AiRole = 'user' | 'assistant'

export interface AiMessage {
  role: AiRole
  content: string
}

export interface AiToolCall {
  name: string
  args: Record<string, unknown>
  ok: boolean
  result: string
  /** 产物下载地址：仅报告生成类工具有（docx 的 /uploads 链接），供对话里直接给出下载入口 */
  url?: string
}

/**
 * 智能体的「界面动作」：模型不直接操作前端，只下发声明式指令，由 /situation 容器执行。
 * 后端在工具轮次里以 SSE `action` 事件下发（可能一轮多条），前端逐条消费；
 * 约定「不认识的动作直接丢弃」——动作失败绝不能影响文字回答的呈现。
 */
export type AiAction =
  /** 定位并选中某颗卫星（按 NORAD 编号）；前端负责拾取、轨道线、镜头飞向与详情面板。
   *  name 为实际编目名（如 OBJECT-B），cnName 为用户/资料库口径的中文名（如 开运一号），
   *  轨迹里两者一起展示（双口径），缺失时退回单一名称。 */
  | { kind: 'select_satellite'; norad: number; name?: string; cnName?: string }
  /** 选中某星座（按名称过滤并绘制该星座全部卫星的轨道线） */
  | { kind: 'select_constellation'; name: string }
  /** 多星座对比：一次把多个星座在三维里同时着色展示（各用一个公用调色板色，点云 + 轨道线一起着色），
   *  并切到星座列表视图。names 为星座名称数组（去重、2~10 个）；前端先写对比集再进模块，
   *  避免被「默认星座」覆盖。多条 select_constellation 会互相覆盖，故多星座对比一律用本动作。 */
  | { kind: 'compare_constellations'; names: string[] }
  /** 定位并选中某个发射场（按 launch_site.id）；前端打开发射站面板、高亮该站并把镜头带过去。
   *  name 为发射站展示名（可选，仅用于对话轨迹文案）。 */
  | { kind: 'select_site'; siteId: number; name?: string }
  /** 定位到某条接近 / 交会事件（按事件 id + 来源），前端打开安全热力面板并选中该事件
   *  （镜头与轨道线定位到这对卫星的交会点）；不切换热力标签（热力已收敛为三源）。
   *  source：'conj' 本项目 SGP4 初筛（sat_conjunction）/ 'cri' 交会分析（sat_cri_conjunction）；
   *  key 为事件主键 id（字符串形式，取自工具结果，禁模型改写）；data 可携带 norad_a/norad_b/tca 直接定位
   *  （缺省时前端再按 id 查 /cgi/event/one 补全）。 */
  | { kind: 'select_conj_event'; source: string; key: string; data?: { norad_a?: number; norad_b?: number; tca?: string } }
  /** 选中并定位某个城市/区域过境目标（按 pass_geo.id）；前端打开城市过境面板、把列表选中该目标
   *  （高亮区域面 + 镜头飞过去 + 读该目标过境明细），与手动点左侧列表同一路径。
   *  name 为过境目标展示名（可选，仅用于对话轨迹文案；目标 id 未命中时前端按名称再兜一次匹配）。
   *  norad（可选）：该过境事件涉及的卫星编号，前端在选中目标后再定位到该星的那条过境明细。
   *  allOrbits（可选）：是否画出该目标明细里的「全部过境卫星」轨道环 —— 仅当用户明确说「看全部过境」时为 true；
   *  缺省（false）时只画回答列出的那几颗（由 show_satellites 负责），视觉更干净。 */
  | { kind: 'select_pass_city'; targetId: number; name?: string; norad?: number; allOrbits?: boolean }
  /** 打开某个左侧面板视图：sat 卫星 / cons 星座 / site 发射站 / heat 碰撞热力 / pass 城市过境 / region 区域过境 / multi 多区域过境。
   *  selectFirst（仅 heat 面板实现）：打开后自动选中列表第一条（交会 / 碰撞类问题用它直接展示第一条交会信息；
   *  面板无数据时只停在页面、不选中任何项）。
   *  norad（仅 heat 有意义）：本次要聚焦的目标卫星 —— 前端把列表过滤到该卫星的交会后再选中第一条，
   *  避免落到列表里第一条别的卫星上；缺省时前端回落到当前三维已选中的那颗星。 */
  | { kind: 'open_panel'; panel: string; selectFirst?: boolean; norad?: number }
  /** 在地球上绘制一块区域（经纬度多边形顶点，[lon, lat] 顺序；调用区域过境框选） */
  | { kind: 'draw_region'; vertices: Array<[number, number]> }
  /** 知识图谱定位到某节点（type 见后端 KG_TYPES，key 为节点 key） */
  | { kind: 'kg_focus'; kgType: string; key: string }
  /** 切换三维态势右下角图例里的空间环境 / 天体图层（成组开关：这组图层当前已全部打开就全部关闭，否则全部打开）。
   *  layers 取值见 scene.ts 的 SkyLayerKey：sun/moon/stars/mansion/constellation/aurora/solarWind/dipole/groundTrack/ellipsoid。
   *  例：「看看地磁情况」→ ['dipole','solarWind']；「极光」→ ['aurora','solarWind']。 */
  | { kind: 'toggle_layers'; layers: string[] }
  /** 打开外部链接（如报告下载、互联网检索来源） */
  | { kind: 'open_url'; url: string; label?: string }
  /** 在三维态势页展示「一批卫星」：把它们作为 NORAD 集合过滤条件下发，绘制这批星的全部轨道线
   *  （并在热力 / 过境视图下叠加显示）。前端会清掉搜索框 / 星座 / 高度条件后应用该集合。
   *  name 为这批星的来源名（如「巴基斯坦」），仅用于对话轨迹文案。 */
  | { kind: 'show_satellites'; norads: number[]; name?: string }
  /** 清空三维态势页的展示效果（过滤条件 / 集合轨道线 / 选中目标）：每轮提问的首个展示型动作前
   *  由后端自动补发一次，保证「下次效果前清空」；也可由模型显式调用。 */
  | { kind: 'clear_display' }

/**
 * 历史对话列表行（列表不返回回答与工具轨迹全文，点详情再取，避免大字段拖慢列表）
 * ⚠ 这张表只是「谁问过什么」的浏览记录，不作为模型的数据源（模型回答一律实时查库）。
 */
export interface AiChatLogRow {
  id: number
  scope: string
  user_id: number
  username: string
  ip: string
  question: string
  provider: string
  model: string
  rounds: number
  elapsed_ms: number
  status: number
  error: string
  created_at: string
  has_tools: number
}

/**
 * 平台遗漏数据列表行（/mui/ai_gap）
 * 一次对话里智能体调用 web_search（平台工具覆盖不到、只能联网兜底）即记一条；
 * 列表不返回联网结果全文（items），点详情再取，避免大字段拖慢列表。
 */
export interface AiGapRow {
  id: number
  scope: string
  user_id: number
  username: string
  ip: string
  question: string
  web_query: string
  engine: string
  engine_label: string
  hit_count: number
  chat_id: number
  /** 处理状态：0 待处理 / 1 已补齐 / 2 已忽略 */
  status: number
  remark: string
  created_at: string
}

/** 平台遗漏数据详情：完整提问 + 联网结果数组（items 由后端 JSON 解析而来） + 尝试过的引擎 + 备注 */
export interface AiGapDetail extends AiGapRow {
  items: Array<{ title?: string; url?: string; snippet?: string }>
  /** 未命中时用「；」拼接的已尝试引擎列表（详情 SELECT * 才有，列表不返回） */
  tried: string
}

/** 历史对话详情：完整提问/回答 + 工具调用轨迹 */
export interface AiChatLogDetail {
  id: number
  scope: string
  user_id: number
  username: string
  ip: string
  question: string
  answer: string
  tools: AiToolCall[]
  provider: string
  model: string
  rounds: number
  elapsed_ms: number
  status: number
  error: string
  created_at: string
}

export type AiEvent =
  | { type: 'meta'; provider: string; model: string; tools: string[]; adminTools: boolean }
  | { type: 'phase'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; call: AiToolCall }
  /** 界面动作（与 tool 并列下发）：前端据此定位选中 / 打开面板 / 绘制区域 / 图谱下钻 */
  | { type: 'action'; action: AiAction }
  | { type: 'done'; finish: string; rounds: number; elapsedMs: number }
  | { type: 'error'; message: string }

export interface AiStatus {
  enabled: boolean
  provider: string | null
  cloud?: { configured: boolean; baseUrl: string; model: string; keyMasked: string }
  canAdmin?: boolean
  tools?: Array<{ name: string; kind: string; description: string }>
  perMinute?: number
  maxChars?: number
  roleCode?: string
}

const base = API_BASE ? `${API_BASE}` : ''

function pathOf(scope: 'admin' | 'public', tail: string) {
  return scope === 'admin' ? `${base}/api/ai/${tail}` : `${base}/cgi/ai/${tail}`
}

/** 读取智能体状态（配置是否完整 / 当前是否走云端） */
export async function fetchAiStatus(scope: 'admin' | 'public'): Promise<AiStatus> {
  const res = await fetch(pathOf(scope, 'status'), {
    credentials: scope === 'admin' ? 'include' : 'omit'
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || body.code !== 0) {
    throw new Error(body?.msg || `状态查询失败（HTTP ${res.status}）`)
  }
  return body.data as AiStatus
}

/* ------------------------------------------------- 历史对话（只读浏览，/mui/ai_history） */
/* ⚠ 只用于「看看之前谁问了什么」，绝不回灌给模型当数据源（历史是滞后的，回答必须实时查库） */

/** 历史对话列表：管理员看全部，普通用户只看自己的 */
export function listChatLogs(params?: { page?: number; pageSize?: number; keyword?: string; scope?: string }) {
  return http<{ list: AiChatLogRow[]; total: number; page: number; pageSize: number; isAdmin: boolean }>({
    url: '/ai/history',
    method: 'get',
    params
  })
}

/** 历史对话详情：完整提问/回答 + 工具调用轨迹 */
export function getChatLog(id: number) {
  return http<AiChatLogDetail>({ url: `/ai/history/${id}`, method: 'get' })
}

/** 删除一条历史对话记录（仅管理员） */
export function removeChatLog(id: number) {
  return http<{ removed: boolean }>({ url: `/ai/history/${id}`, method: 'delete' })
}

/* ------------------------------------------------- 平台遗漏数据（/mui/ai_gap） */
/* 智能体每次联网检索（web_search）即记一条：平台工具覆盖不到、只能靠外部信息兜底的提问，
   供管理员盘点数据缺口并做处理闭环（待处理/已补齐/已忽略）。 */

/** 平台遗漏数据列表：管理员看全部，普通用户只看自己的 */
export function listGaps(params?: {
  page?: number
  pageSize?: number
  keyword?: string
  scope?: string
  status?: number | string
}) {
  return http<{ list: AiGapRow[]; total: number; page: number; pageSize: number; isAdmin: boolean; pending: number }>({
    url: '/ai/gaps',
    method: 'get',
    params
  })
}

/** 平台遗漏数据详情（含联网结果原文） */
export function getGap(id: number) {
  return http<AiGapDetail>({ url: `/ai/gaps/${id}`, method: 'get' })
}

/** 更新处理状态 / 备注（仅管理员）；status 0 待处理 / 1 已补齐 / 2 已忽略 */
export function updateGap(id: number, data: { status?: number; remark?: string }) {
  return http<{ updated: boolean }>({ url: `/ai/gaps/${id}`, method: 'patch', data })
}

/** 删除一条遗漏记录（仅管理员） */
export function removeGap(id: number) {
  return http<{ removed: boolean }>({ url: `/ai/gaps/${id}`, method: 'delete' })
}

/* ------------------------------------------------- 用户提问台账（/mui/ai_question_log） */
/* 一次对话（runAgent）结束就记一条（一问一条，成功/失败都记），收集用户真实关注点；
   列表只返回左截断的提问，点详情再取全文。status 为处理闭环（0 待处理/1 已处理/2 已忽略）。 */

export interface AiQuestionRow {
  id: number
  scope: string
  user_id: number
  username: string
  ip: string
  /** 列表里为 LEFT(question,500)，详情里为完整提问 */
  question: string
  /** 本轮调用的工具名，以「；」拼接 */
  tools: string
  rounds: number
  elapsed_ms: number
  chat_id: number
  status: number
  remark: string
  created_at: string
}

/** 用户提问详情（完整提问） */
export type AiQuestionDetail = AiQuestionRow

/** 用户提问列表：管理员看全部，普通用户只看自己的 */
export function listQuestions(params?: {
  page?: number
  pageSize?: number
  keyword?: string
  scope?: string
  status?: number | string
}) {
  return http<{ list: AiQuestionRow[]; total: number; page: number; pageSize: number; isAdmin: boolean; pending: number }>({
    url: '/ai/questions',
    method: 'get',
    params
  })
}

/** 用户提问详情（完整提问） */
export function getQuestion(id: number) {
  return http<AiQuestionDetail>({ url: `/ai/questions/${id}`, method: 'get' })
}

/** 更新处理状态 / 备注（仅管理员）；status 0 待处理 / 1 已处理 / 2 已忽略 */
export function updateQuestion(id: number, data: { status?: number; remark?: string }) {
  return http<{ updated: boolean }>({ url: `/ai/questions/${id}`, method: 'patch', data })
}

/** 删除一条提问记录（仅管理员） */
export function removeQuestion(id: number) {
  return http<{ removed: boolean }>({ url: `/ai/questions/${id}`, method: 'delete' })
}

/* ------------------------------------------------- 下载记录台账（/mui/ai_download_log） */
/* 对话里工具返回非空 url（报告/导出产物）即记一条，盘点哪些产物被下载得多、由谁触发。 */

export interface AiDownloadRow {
  id: number
  scope: string
  user_id: number
  username: string
  ip: string
  /** 触发下载的提问（截断） */
  question: string
  /** 触发工具名 */
  tool: string
  file_name: string
  url: string
  chat_id: number
  status: number
  remark: string
  created_at: string
}

/** 下载记录详情：完整工具参数（args 由后端 JSON 解析而来） */
export interface AiDownloadDetail extends Omit<AiDownloadRow, 'question'> {
  question: string
  args: Record<string, unknown>
}

/** 下载记录列表：管理员看全部，普通用户只看自己的 */
export function listDownloads(params?: {
  page?: number
  pageSize?: number
  keyword?: string
  scope?: string
  status?: number | string
}) {
  return http<{ list: AiDownloadRow[]; total: number; page: number; pageSize: number; isAdmin: boolean; pending: number }>({
    url: '/ai/downloads',
    method: 'get',
    params
  })
}

/** 下载记录详情（含工具参数） */
export function getDownload(id: number) {
  return http<AiDownloadDetail>({ url: `/ai/downloads/${id}`, method: 'get' })
}

/** 更新处理状态 / 备注（仅管理员）；status 0 待处理 / 1 已处理 / 2 已忽略 */
export function updateDownload(id: number, data: { status?: number; remark?: string }) {
  return http<{ updated: boolean }>({ url: `/ai/downloads/${id}`, method: 'patch', data })
}

/** 删除一条下载记录（仅管理员） */
export function removeDownload(id: number) {
  return http<{ removed: boolean }>({ url: `/ai/downloads/${id}`, method: 'delete' })
}

/**
 * 流式对话。逐事件回调，返回时流已结束（正常结束或出错）。
 * @throws 网络/鉴权/限流类错误（业务错误也会以 error 事件形式回调一次）
 */
export async function streamAiChat(opts: {
  scope: 'admin' | 'public'
  messages: AiMessage[]
  /** 界面上下文（如态势页当前选中的目标）：仅作「指代消歧」，不是数据来源；后端会做白名单校验 */
  context?: Record<string, unknown> | null
  /**
   * 推算模式：仅「区域 / 多区域过境」面板的「计算」入口使用。
   * 后端据此豁免系统提示词「禁止自行推算」并禁用历史批次查询工具，按用户给定顶点 + 口径直接给示意性推算。
   */
  estimate?: boolean
  onEvent: (e: AiEvent) => void
  signal?: AbortSignal
}): Promise<void> {
  const { scope, messages, context, estimate, onEvent, signal } = opts
  const body: Record<string, unknown> = { messages }
  if (context) body.context = context
  if (estimate) body.estimate = true
  let res: Response
  try {
    res = await fetch(pathOf(scope, 'chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 公开接口无需登录态，但带上 Cookie 无害（同源部署下保持会话连续性）
      credentials: 'include',
      signal
    })
  } catch (e: any) {
    if (e?.name === 'AbortError') return
    throw new Error('连接智能体失败：' + (e?.message || '网络错误'))
  }

  // 非 SSE（限流 / 未配置）会返回普通 JSON
  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('text/event-stream')) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.msg || `智能体请求失败（HTTP ${res.status}）`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('浏览器不支持流式读取')

  const decoder = new TextDecoder()
  let buf = ''
  let event = 'message'
  // 是否收到过服务端的「终止信号」（done 或 error）：正常收尾二者必居其一。
  // 若底层流结束（chunk.done）却从未收到终止信号，说明连接被中途切断
  // （代理空闲超时 / 上游断开 / 服务端未发 done 就关闭）——此时必须显式告知用户，
  // 否则界面会静默停在半截，用户无法判断「说完了」还是「断了」。
  let gotTerminal = false
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e: any) {
      if (e?.name === 'AbortError' || signal?.aborted) return
      throw e
    }
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (!line.trim()) continue
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        continue
      }
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      let data: any = null
      try { data = payload ? JSON.parse(payload) : null } catch { data = null }
      switch (event) {
        case 'meta':
          onEvent({ type: 'meta', provider: data?.provider || '', model: data?.model || '', tools: data?.tools || [], adminTools: Boolean(data?.adminTools) })
          break
        case 'phase':
          if (data?.message) onEvent({ type: 'phase', message: String(data.message) })
          break
        case 'delta':
          if (data?.text) onEvent({ type: 'delta', text: String(data.text) })
          break
        case 'tool':
          onEvent({
            type: 'tool',
            call: {
              name: data?.name || '',
              args: (data?.args || {}) as Record<string, unknown>,
              ok: Boolean(data?.ok),
              result: String(data?.result || ''),
              url: String(data?.url || '')
            }
          })
          break
        case 'done':
          gotTerminal = true
          onEvent({ type: 'done', finish: data?.finish || 'stop', rounds: data?.rounds || 1, elapsedMs: data?.elapsedMs || 0 })
          break
        case 'action':
          if (data?.action && data.action.kind) onEvent({ type: 'action', action: data.action as AiAction })
          break
        case 'error':
          gotTerminal = true
          onEvent({ type: 'error', message: data?.message || '智能体执行失败' })
          break
        default:
          break
      }
      event = 'message'
    }
  }
  // 流正常结束但从未收到 done/error：判定为「中途断流」，显式报错，避免静默停在半截
  if (!gotTerminal) {
    onEvent({ type: 'error', message: '连接中断，内容可能不完整，请重试' })
  }
}

/** 工具名 → 界面上的中文说明（让用户看懂「正在查什么」） */
export const TOOL_LABEL: Record<string, string> = {
  get_catalog_overview: '编目总览',
  search_object: '目标查询',
  get_conjunction_alerts: '碰撞接近事件',
  get_conjunction_stats: '碰撞预警统计',
  get_target_events: '目标接近事件（双源）',
  scan_satellite_events: '单星接近事件现算',
  get_cri_alerts: '交会风险事件',
  get_space_weather: '空间环境',
  get_scan_status: '扫描任务状态',
  get_pass_windows: '过境窗口',
  get_region_passes: '区域过境批次',
  get_joint_runs: '联合分析批次',
  get_multi_region_scans: '多区域过境批次',
  get_satellite_profile: '卫星档案',
  get_kg_neighbors: '知识图谱关联',
  get_kg_overview: '知识图谱总览',
  get_kg_search: '知识图谱搜索',
  get_kg_sample: '知识图谱类型抽样',
  get_constellation_members: '星座档案',
  list_owner_satellites: '国家/机构卫星清单',
  get_upcoming_launches: '即将发射计划',
  web_search: '联网检索（外部信息）',
  ui_action: '界面动作',
  run_conjunction_scan: '触发碰撞扫描',
  run_cri_scan: '触发交会分析扫描',
  sync_tle: '同步 TLE 数据',
  create_event_report: '生成事件报告',
  create_region_report: '生成区域过境报告',
  create_joint_report: '生成联合分析报告',
  create_multi_region_report: '生成多区域报告'
}