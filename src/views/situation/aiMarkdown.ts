/**
 * 智能体正文的轻量 Markdown 解析器（零依赖）
 *
 * 项目里没有 marked / markdown-it / DOMPurify，模型正文又只需一小撮语法，
 * 故自写一个够用且可控的解析器：支持 段落 / 标题 / 有序·无序列表 / 表格 /
 * 代码块 / 分隔线 / 加粗 / 行内代码 / 链接，以及两类内嵌标记：
 *   · 图表标记 [[chart:<type>[:<arg>]]]   → 渲染成统计图表卡片
 *   · 图谱标记 [[kg:<type>:<key>]]        → 渲染成知识图谱关系图卡片
 * 另把「猜你想问」的候选项（行首「· 」）识别为可点击链接（前端点击仅回填输入框）。
 *
 * 安全：所有来自模型的文本先做 HTML 转义，标签只由本文件自己拼出，
 * 因此返回值可直接交给 v-html，不需要额外的净化库。
 *
 * 单一职责：只做「文本 → 块数组」，不发请求、不碰 DOM；渲染交给 AiRichText.vue。
 */
import { uploadUrl } from '@/utils/request'

/** 内嵌标记：[[chart:sat_orbit:66523]] / [[kg:satellite:65489]] / [[evt:conj:67942]] */
const MARK_RE = /\[\[\s*(chart|kg|evt)\s*:\s*([^\]]*?)\s*\]\]/gi
/** chart 载荷：<type>[:<arg>]，arg 可省略 */
const CHART_PAYLOAD_RE = /^([a-z_]+)(?::([^\]\s]+))?$/i
/** kg 载荷：<type>:<key>，key 必填（norad_id / 主键 id / 机构码） */
const KG_PAYLOAD_RE = /^([a-z_]+)\s*:\s*(.+)$/i
/** evt 载荷：<source>:<key>；source ∈ conj|cri|pass；key 为事件 id，或 pass 的 <norad>:<targetId> */
const EVT_PAYLOAD_RE = /^([a-z]+)\s*:\s*([\d:]+)$/i
/** 行内事件标记（表格单元格 / 段落里）：转义后替换为可点击「定位」按钮。
 *  与块级事件卡共用同一套定位链路（前端按 source:key 取数）。 */
const EVT_INLINE_RE = /\[\[\s*evt\s*:\s*([a-z]+)\s*:\s*([\d:]+)\s*\]\]/gi

/** 打平后的块结构（用可选字段而非可辨识联合，避免模板里类型收窄带来的编译噪音） */
export interface MdBlock {
  type: 'p' | 'h' | 'ul' | 'ol' | 'table' | 'code' | 'hr' | 'chart' | 'guess' | 'kg' | 'evt'
  /** 行内 HTML（p / h） */
  html?: string
  /** 列表项：ul/ol 为行内 HTML；guess 为纯文本候选项 */
  items?: string[]
  /** 表头单元格（行内 HTML） */
  head?: string[]
  /** 表格数据行（单元格为行内 HTML） */
  rows?: string[][]
  /** 代码块内容（原文，不转义由插值负责） */
  text?: string
  /** 标题级别 */
  level?: number
  /** 图表类型 */
  chartType?: string
  /** 图谱中心节点类型 */
  kgType?: string
  /** 图表参数 / 图谱中心节点 key */
  arg?: string
  /** 事件卡：事件来源（conj 碰撞预警 / cri 交会分析 / pass 过境） */
  evtSource?: string
  /** 事件卡：事件 key（事件 id，或 pass 的 <norad>:<targetId>） */
  evtKey?: string
  /** 标记原文（前端兜底展示 / 便于排查） */
  raw?: string
}

/** HTML 转义：模型输出里的尖括号一律当普通文字 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内解析：先转义，再依次还原 `code`、链接（Markdown 形式 + 裸 /uploads 产物地址）、
 *  行内事件标记、**加粗**，最后把换行变 <br> */
function inline(src: string): string {
  let t = esc(src)
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code class="md-code">${c}</code>`)
  // 链接：① Markdown 形式 [文字](http(s)://… 或 /uploads/…)；② 裸产物地址 /uploads/…（模型常直接把下载地址写进正文）。
  // 两种形式在同一遍扫描里处理：生成的 <a> 不会被二次匹配，避免 href 里的 /uploads 被再包一层链接。
  // href 一律经 uploadUrl() 补部署前缀（子路径部署下裸路径会 404）。
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/uploads\/[\w\-./%?#=&:@+~]+)\)|(\/uploads\/[\w\-./%?#=&:@+~]+)/g,
    (_m, txt, mdUrl, bareUrl) => {
      if (mdUrl) return `<a class="md-a" href="${uploadUrl(mdUrl)}" target="_blank" rel="noopener">${txt}</a>`
      // 裸地址：剥掉句末标点（中英文），免得把「。」逗号也吞进链接
      const mBare = String(bareUrl).match(/^(.*?)([.,;:!?，。、；：！？…]+)?$/)
      const url = mBare ? mBare[1] : bareUrl
      const tail = mBare && mBare[2] ? mBare[2] : ''
      return `<a class="md-a" href="${uploadUrl(url)}" target="_blank" rel="noopener">${url}</a>${tail}`
    }
  )
  // 行内事件标记（表格单元格 / 段落里）→ 可点击「定位」按钮（前端按 data-evt 取数并定位，非模型改写）
  t = t.replace(EVT_INLINE_RE, (_m, s, k) => `<button type="button" class="md-evt" data-evt="${s.toLowerCase()}:${k}">定位</button>`)
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return t.replace(/\n/g, '<br>')
}

/** 表格行 → 单元格数组（去掉首尾竖线） */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((x) => x.trim())
}

/** 表格对齐行：|---|:--:|---|（必须含 - 与 |） */
function isTableSep(line: string): boolean {
  return /^[\s:|-]+$/.test(line) && line.includes('-') && line.includes('|')
}

/** 行首是否开启一个新块（列表 / 标题 / 代码围栏 / 表格 / 分隔线 / 猜你想问候选） */
function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^\s*#{1,6}\s+/.test(line) ||
    /^\s*[-*•]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*·\s+/.test(line) ||
    /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)
  )
}

/** 逐行解析纯文本片段 → 块数组 */
function parseBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 空行：块分隔
    if (!line.trim()) {
      i++
      continue
    }

    // 代码围栏
    const fence = line.match(/^\s*```\s*([a-zA-Z0-9_+-]*)\s*$/)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过收尾围栏（可能不存在，容忍截断）
      out.push({ type: 'code', text: buf.join('\n') })
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      out.push({ type: 'hr' })
      i++
      continue
    }

    // 标题
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (h) {
      out.push({ type: 'h', level: h[1].length, html: inline(h[2]) })
      i++
      continue
    }

    // 表格：当前行以 | 开头，下一行是对齐行
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      const head = splitRow(line).map(inline)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]).map(inline))
        i++
      }
      out.push({ type: 'table', head, rows })
      continue
    }

    // 无序列表
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*•]\s+/, '')))
        i++
      }
      out.push({ type: 'ul', items })
      continue
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')))
        i++
      }
      out.push({ type: 'ol', items })
      continue
    }

    // 猜你想问候选项（行首「· 」；与无序列表的 • 不同字符，故不会冲突）
    if (/^\s*·\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*·\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*·\s+/, '').trim())
        i++
      }
      out.push({ type: 'guess', items })
      continue
    }

    // 段落：连续非空、且不开启新块的行，合成一段（保留软换行）
    const buf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i])
      i++
    }
    out.push({ type: 'p', html: inline(buf.join('\n')) })
  }
  return out
}

/** 标记是否「单独成行」（行首到标记、标记到行尾之间都只有空白）：
 *  区分块级事件卡（单独成行）与行内「定位」按钮（夹在表格单元格 / 段落文字中）。 */
function isAloneOnLine(text: string, idx: number, len: number): boolean {
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1
  if (text.slice(lineStart, idx).trim()) return false
  const nl = text.indexOf('\n', idx + len)
  const lineEnd = nl === -1 ? text.length : nl
  return !text.slice(idx + len, lineEnd).trim()
}

/**
 * 解析入口：先按内嵌标记（chart / kg / evt）把正文切段（标记可独立成行，也可夹在文字中），
 * 再对每个纯文本段做块解析，最后按原顺序拼成一个块数组。
 *
 * evt 特殊：它允许写进 Markdown 表格单元格（渲染成「定位」按钮）—— 只有「单独成行」时才切段成块级事件卡，
 * 否则跳过、留给 parseBlocks 的 inline() 处理；否则会把整行表格切断、破坏表格结构。
 */
export function parseAiMarkdown(src: string): MdBlock[] {
  const text = String(src || '')
  const out: MdBlock[] = []
  const re = new RegExp(MARK_RE.source, 'gi')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase()
    if (kind === 'evt' && !isAloneOnLine(text, m.index, m[0].length)) continue
    if (m.index > last) out.push(...parseBlocks(text.slice(last, m.index)))
    const raw = m[0]
    const payload = (m[2] || '').trim()
    if (kind === 'kg') {
      const km = payload.match(KG_PAYLOAD_RE)
      if (km) out.push({ type: 'kg', kgType: km[1].toLowerCase(), arg: km[2].trim(), raw })
    } else if (kind === 'evt') {
      const em = payload.match(EVT_PAYLOAD_RE)
      if (em) out.push({ type: 'evt', evtSource: em[1].toLowerCase(), evtKey: em[2].trim(), raw })
    } else {
      const cm = payload.match(CHART_PAYLOAD_RE)
      if (cm) out.push({ type: 'chart', chartType: cm[1].toLowerCase(), arg: (cm[2] || '').trim(), raw })
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(...parseBlocks(text.slice(last)))
  return out
}

export default parseAiMarkdown
