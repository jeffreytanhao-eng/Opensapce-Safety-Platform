import type { EphemSet, ParseResult } from './types'
import { detectFormat } from './detect'
import { parseItc } from './parseItc'
import { parseOem } from './parseOem'
import { parseOcm } from './parseOcm'

/** 去掉路径与扩展名，取纯文件名 */
function baseName(fileName: string): string {
  const parts = fileName.replace(/\\/g, '/').split('/')
  const name = parts[parts.length - 1]
  return name.replace(/\.[A-Za-z0-9]+$/, '')
}

/**
 * 从文件名兜底提取对象名，例如
 * `MEME_100001_STARLINK-38128_2941004_Operational_...` → `STARLINK-38128`。
 */
export function extractNameFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined
  const base = baseName(fileName)
  const m = /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/.exec(base)
  if (m) return m[0].toUpperCase()
  // 退化为第二段（MEME_<id>_<NAME>_...）
  const segs = base.split('_').filter(Boolean)
  return segs.length >= 3 ? segs[2] : undefined
}

/** 从文件名里找 5 位 NORAD 编号兜底 */
export function extractNoradFromFileName(fileName?: string): number | undefined {
  if (!fileName) return undefined
  const base = baseName(fileName)
  // Starlink ITC 文件名形如 MEME_100008_STARLINK-38124_...：MEME id 才是 NORAD，
  // 后面的 38124 是生产编号（03 §15.11 第 6 条）。6 位编号同样适用。
  const meme = /MEME[_-](\d{5,6})(?!\d)/i.exec(base)
  if (meme) return Number(meme[1])
  // 不再取文件名中的任意 5 位数（旧实现会把 38124 误读成 NORAD）
  return undefined
}

/** 从 OEM / OCM 头部取 NORAD（OBJECT_ID = 100008 这类纯数字字段） */
export function extractNoradFromText(text: string): number | undefined {
  const m = /OBJECT_ID\s*=\s*(\d{5,6})(?!\d)/i.exec(text)
  return m ? Number(m[1]) : undefined
}

/** 相邻状态间隔中位数（秒） */
function medianStep(set: EphemSet): number {
  const st = set.states
  if (st.length < 2) return 0
  const diffs: number[] = []
  for (let i = 1; i < st.length; i++) diffs.push((st[i].t - st[i - 1].t) / 1000)
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}

/**
 * 星历统一入口：识别格式 → 调对应解析器 → 补齐 id / stepSec / 名称与 NORAD 兜底。
 */
export function parseEphemeris(
  text: string,
  hint?: { name?: string; norad?: number; fileName?: string }
): ParseResult {
  if (!text || !text.trim()) {
    return { ok: false, error: '文件内容为空', warnings: [] }
  }
  const fmt = detectFormat(text)
  if (!fmt) {
    return {
      ok: false,
      error: '无法识别的星历格式（未发现 CCSDS_OEM_VERS / CCSDS_OCM_VERS / ephemeris_start 标识）',
      warnings: []
    }
  }

  const nameHint = hint?.name?.trim() || extractNameFromFileName(hint?.fileName)
  const noradHint = hint?.norad
    ?? extractNoradFromFileName(hint?.fileName)
    ?? extractNoradFromText(text)

  let res: ParseResult
  if (fmt === 'itc') {
    res = parseItc(text, { name: nameHint, norad: noradHint })
  } else if (fmt === 'oem') {
    res = parseOem(text)
  } else {
    res = parseOcm(text)
  }

  if (!res.ok || !res.set) return res
  const set = res.set

  if (nameHint && (!set.name || set.name === 'UNKNOWN')) set.name = nameHint
  if (!set.norad && noradHint) set.norad = noradHint

  const step = medianStep(set)
  if (step > 0) set.stepSec = step
  if (set.states.length) {
    set.start = set.states[0].t
    set.stop = set.states[set.states.length - 1].t
  }
  set.id = `${set.norad || 'X'}-${set.start}`
  set.warnings.push(`格式识别为 ${fmt.toUpperCase()}，共 ${set.states.length} 个状态点`)
  res.warnings = set.warnings
  return res
}
