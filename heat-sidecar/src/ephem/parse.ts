/**
 * 上传星历解析（03 §15.11）：ITC / CCSDS OEM / CCSDS OCM。
 *
 * 只做**格式与数值合理性校验**，不做坐标变换、不做威胁计算：
 *  - 状态向量按文件声明的 REF_FRAME 视为 J2000（EME2000 / GCRF / ICRF）；
 *  - 协方差原样保留 21 项下三角（UVW 或惯系），由核心按其策略处理；
 *  - 任何越界都抛 UploadError（code=INPUT_INVALID + 具体原因），由路由转成 400。
 */
import { parseItc, type ItcParseResult } from '../sync/parseItc.js'
import { parseUtc } from '../util/time.js'
import {
  cov6From21,
  eciCovToUvw,
  itrfToJ2000,
  itrfToJ2000Mat,
  lower21FromCov,
  rotateCov6,
  temeToJ2000,
  type Vec3
} from '../screen/frames.js'

export type EphemFormat = 'itc' | 'oem' | 'ocm'

export interface ParsedEphem {
  format: EphemFormat
  name: string
  norad: number | null
  meme: number | null
  createdMs: number | null
  /** unix ms，单调递增 */
  t: number[]
  /** 位置 km，每点 3 个 */
  r: number[]
  /** 速度 km/s，每点 3 个 */
  v: number[]
  /** 每点 21 项下三角（C11,C21,C22,…），无协方差为 null */
  cov21: number[] | null
  hasCov: boolean
  covFrame: 'UVW' | 'INERTIAL'
  stepSec: number
  warnings: string[]
}

export class UploadError extends Error {
  constructor(
    public code: 'INPUT_INVALID' | 'UNSUPPORTED_FRAME' | 'TOO_LARGE' | 'RATE_LIMITED',
    msg: string
  ) {
    super(msg)
  }
}

/** 资源上限（§15.11） */
export const LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  maxPoints: 100_000,
  maxSpanDays: 10,
  minRadiusKm: 6378,
  maxRadiusKm: 50_000,
  maxSpeedKms: 12
} as const

export function detectFormat(text: string): EphemFormat | null {
  const head = text.slice(0, 4096)
  if (/CCSDS_OEM_VERS/i.test(head)) return 'oem'
  if (/CCSDS_OCM_VERS/i.test(head)) return 'ocm'
  if (/^\s*created\s*:/im.test(head) || /ephemeris_start\s*:/i.test(head)) return 'itc'
  return null
}

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/

/** 文件名 → MEME / NORAD（§15.11 第 6 条：先匹配 MEME_<5~6 位>_） */
export function noradFromName(fileName: string): { meme: number | null; norad: number | null; name: string } {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '')
  const m = /MEME_(\d{5,6})_([^_]+)/i.exec(base)
  if (m) {
    const id = Number(m[1])
    return { meme: id, norad: id, name: m[2] }
  }
  return { meme: null, norad: null, name: base.slice(0, 100) }
}

/** 统一做数值合理性校验，返回 warnings（协方差非正定时整体丢弃） */
function validate(p: {
  t: number[]
  r: number[]
  v: number[]
  cov21: number[] | null
  warnings: string[]
}): void {
  const n = p.t.length
  if (n < 2) throw new UploadError('INPUT_INVALID', '有效状态点少于 2 个')
  if (n > LIMITS.maxPoints) throw new UploadError('INPUT_INVALID', `点数 ${n} 超过上限 ${LIMITS.maxPoints}`)
  const spanDays = (p.t[n - 1] - p.t[0]) / 86_400_000
  if (spanDays > LIMITS.maxSpanDays) {
    throw new UploadError('INPUT_INVALID', `时间跨度 ${spanDays.toFixed(1)} 天超过上限 ${LIMITS.maxSpanDays} 天`)
  }
  for (let i = 1; i < n; i++) {
    if (!(p.t[i] > p.t[i - 1])) throw new UploadError('INPUT_INVALID', `第 ${i + 1} 个状态点时刻非递增`)
  }
  for (let i = 0; i < n; i++) {
    const x = p.r[i * 3]
    const y = p.r[i * 3 + 1]
    const z = p.r[i * 3 + 2]
    const rad = Math.hypot(x, y, z)
    if (!(rad >= LIMITS.minRadiusKm && rad <= LIMITS.maxRadiusKm)) {
      throw new UploadError('INPUT_INVALID', `第 ${i + 1} 个状态点位置模长 ${rad.toFixed(1)} km 不在 ${LIMITS.minRadiusKm}~${LIMITS.maxRadiusKm} km 之间`)
    }
    const spd = Math.hypot(p.v[i * 3], p.v[i * 3 + 1], p.v[i * 3 + 2])
    if (!(spd <= LIMITS.maxSpeedKms)) {
      throw new UploadError('INPUT_INVALID', `第 ${i + 1} 个状态点速度 ${spd.toFixed(2)} km/s 超过上限 ${LIMITS.maxSpeedKms} km/s`)
    }
  }
  if (p.cov21) {
    const diag = [0, 2, 5, 9, 14, 20]
    let bad = false
    for (let i = 0; i < n && !bad; i++) {
      for (const d of diag) {
        const val = p.cov21[i * 21 + d]
        if (!Number.isFinite(val) || val < 0) {
          bad = true
          break
        }
      }
    }
    if (bad) p.warnings.push('协方差对角元存在负值或非有限值，已整份忽略协方差')
  }
}

function fromItc(p: ItcParseResult): ParsedEphem {
  const warnings = [...p.warnings]
  const cov21 = p.cov21
  const covFrame: 'UVW' | 'INERTIAL' = p.covFrame === 'UVW' ? 'UVW' : 'INERTIAL'
  if (cov21) validateCovDiag(cov21, p.t.length, warnings)
  return {
    format: 'itc',
    name: '',
    norad: null,
    meme: null,
    createdMs: p.createdUtc ? p.createdUtc.getTime() : null,
    t: p.t,
    r: p.r,
    v: p.v,
    cov21: cov21 && covDiagOk(cov21) ? cov21 : null,
    hasCov: Boolean(cov21 && covDiagOk(cov21)),
    covFrame,
    stepSec: p.stepSec,
    warnings
  }
}

function covDiagOk(cov21: number[]): boolean {
  const diag = [0, 2, 5, 9, 14, 20]
  const n = cov21.length / 21
  for (let i = 0; i < n; i++) {
    for (const d of diag) {
      const val = cov21[i * 21 + d]
      if (!Number.isFinite(val) || val < 0) return false
    }
  }
  return true
}

function validateCovDiag(cov21: number[], n: number, warnings: string[]): void {
  if (cov21.length !== n * 21) warnings.push('协方差点数与状态点数不一致，已忽略协方差')
}

/** CCSDS OEM（KVN） */
function parseOem(text: string): ParsedEphem {
  const warnings: string[] = []
  const kv = new Map<string, string>()
  const t: number[] = []
  const r: number[] = []
  const v: number[] = []
  const cov21: number[] = []
  let covFrame: 'UVW' | 'INERTIAL' = 'UVW'
  let covAcc: number[] = []
  let inMeta = false

  const diag = (key: string): void => {
    if (key === 'REF_FRAME') {
      const frame = (kv.get(key) ?? '').toUpperCase()
      if (!['EME2000', 'GCRF', 'ICRF', 'J2000'].includes(frame)) {
        throw new UploadError('UNSUPPORTED_FRAME', `暂不支持该坐标系：${frame || '空'}`)
      }
    }
    if (key === 'TIME_SYSTEM' && (kv.get(key) ?? '').toUpperCase() !== 'UTC') {
      throw new UploadError('UNSUPPORTED_FRAME', `时间系统只接受 UTC（收到 ${kv.get(key)}）`)
    }
    if (key === 'CENTER_NAME' && (kv.get(key) ?? '').toUpperCase() !== 'EARTH') {
      throw new UploadError('UNSUPPORTED_FRAME', `CENTER_NAME 必须是 EARTH（收到 ${kv.get(key)}）`)
    }
    if (key === 'COV_REF_FRAME') {
      const f = (kv.get(key) ?? '').toUpperCase()
      covFrame = f === 'UVW' || f === 'RTN' || f === 'RSW' ? 'UVW' : 'INERTIAL'
    }
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line === 'META_START') { inMeta = true; continue }
    if (line === 'META_STOP') { inMeta = false; continue }
    if (line === 'COVARIANCE_START' || line === 'COVARIANCE_STOP') { continue }
    const eq = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line)
    if (eq) {
      kv.set(eq[1].toUpperCase(), eq[2].trim())
      diag(eq[1].toUpperCase())
      continue
    }
    const tokens = line.split(/\s+/)
    if (ISO_RE.test(tokens[0]) && tokens.length >= 7) {
      const ms = Date.parse(tokens[0].endsWith('Z') ? tokens[0] : `${tokens[0]}Z`)
      if (!Number.isFinite(ms)) throw new UploadError('INPUT_INVALID', `历元无法解析：${tokens[0]}`)
      const nums = tokens.slice(1, 7)
      if (!nums.every((c) => NUM_RE.test(c))) throw new UploadError('INPUT_INVALID', `历元 ${tokens[0]} 的状态分量非法`)
      const vals = nums.map(Number)
      t.push(ms)
      r.push(vals[0], vals[1], vals[2])
      v.push(vals[3], vals[4], vals[5])
      continue
    }
    if (tokens.every((c) => NUM_RE.test(c))) {
      for (const c of tokens) covAcc.push(Number(c))
      while (covAcc.length >= 21) {
        cov21.push(...covAcc.slice(0, 21))
        covAcc = covAcc.slice(21)
      }
      continue
    }
    if (inMeta) continue
  }
  if (!kv.has('TIME_SYSTEM')) throw new UploadError('INPUT_INVALID', 'OEM 头缺少 TIME_SYSTEM')
  if (!kv.has('REF_FRAME')) throw new UploadError('INPUT_INVALID', 'OEM 头缺少 REF_FRAME')

  let stepSec = 0
  if (t.length >= 2) stepSec = Math.round((t[1] - t[0]) / 1000)
  const hasCov = cov21.length === t.length * 21 && covDiagOk(cov21)
  if (cov21.length && !hasCov) warnings.push('协方差数量与状态点不匹配或对角元非法，已忽略协方差')

  const name = kv.get('OBJECT_NAME')?.replace(/^"|"$/g, '') ?? ''
  const norad = Number(kv.get('NORAD_CAT_ID') ?? kv.get('OBJECT_ID')?.match(/\d{4,6}/)?.[0] ?? NaN)
  return {
    format: 'oem',
    name,
    norad: Number.isFinite(norad) && norad > 0 ? norad : null,
    meme: null,
    createdMs: kv.get('CREATION_DATE') ? (parseUtc(kv.get('CREATION_DATE') as string)?.getTime() ?? null) : null,
    t, r, v,
    cov21: hasCov ? cov21 : null,
    hasCov,
    covFrame,
    stepSec,
    warnings
  }
}

/** ISO 时间整列（用于判断某行是否为「时间 + 数值」的数据行） */
const ISO_TOKEN_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/i

type FrameKind = 'ITRF' | 'TEME' | 'INERTIAL'

/** 轨迹/协方差参考系归一：ITRF2000 → ITRF，GCRF/ICRF/J2000 → INERTIAL */
function frameKind(v: string): FrameKind | null {
  const f = v.trim().toUpperCase()
  if (!f) return null
  if (f.startsWith('ITRF')) return 'ITRF'
  if (f === 'TEME') return 'TEME'
  if (f === 'EME2000' || f === 'J2000' || f === 'GCRF' || f === 'ICRF' || f === 'ECI') return 'INERTIAL'
  return null
}

function covFrameKind(v: string): 'UVW' | FrameKind | null {
  const f = v.trim().toUpperCase()
  if (f === 'UVW' || f === 'RTN' || f === 'RSW') return 'UVW'
  return frameKind(v)
}

/** CCSDS OCM（XML 写法：<stateVector> 块） */
function parseOcmXml(text: string): ParsedEphem {
  const warnings: string[] = ['OCM 仅解析笛卡尔状态向量，其它字段已忽略']
  const t: number[] = []
  const r: number[] = []
  const v: number[] = []
  const epochRe = /<EPOCH>\s*([^<]+?)\s*<\/EPOCH>/gi
  const pick = (block: string, tag: string): number => {
    const m = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(block)
    return m ? Number(m[1]) : NaN
  }
  const blocks = text.split(/<stateVector>/i).slice(1)
  for (const block of blocks) {
    const em = epochRe.exec(block)
    epochRe.lastIndex = 0
    if (!em) continue
    const ms = Date.parse(em[1].endsWith('Z') ? em[1] : `${em[1]}Z`)
    const vals = [pick(block, 'X'), pick(block, 'Y'), pick(block, 'Z'), pick(block, 'X_DOT'), pick(block, 'Y_DOT'), pick(block, 'Z_DOT')]
    if (!Number.isFinite(ms) || vals.some((n) => !Number.isFinite(n))) continue
    t.push(ms)
    r.push(vals[0], vals[1], vals[2])
    v.push(vals[3], vals[4], vals[5])
  }
  if (!t.length) throw new UploadError('INPUT_INVALID', '暂不支持该 OCM 结构（未找到 stateVector/EPOCH）')
  const frame = /<REF_FRAME>\s*([^<]+?)\s*<\/REF_FRAME>/i.exec(text)?.[1]?.toUpperCase() ?? ''
  if (frame && !['EME2000', 'GCRF', 'ICRF', 'J2000'].includes(frame)) {
    throw new UploadError('UNSUPPORTED_FRAME', `暂不支持该坐标系：${frame}`)
  }
  let stepSec = 0
  if (t.length >= 2) stepSec = Math.round((t[1] - t[0]) / 1000)
  const name = /<OBJECT_NAME>\s*([^<]+?)\s*<\/OBJECT_NAME>/i.exec(text)?.[1]?.trim() ?? ''
  return {
    format: 'ocm', name, norad: null, meme: null, createdMs: null,
    t, r, v, cov21: null, hasCov: false, covFrame: 'UVW', stepSec, warnings
  }
}

/**
 * CCSDS OCM 3.0（KVN 写法，SpaceX Starlink 公开星历的实际格式）：
 * ```
 * CCSDS_OCM_VERS = 3.0
 * META_START … TRAJ_REF_FRAME = ITRF2000 … META_STOP
 * TRAJ_START
 * 2026-10-26T07:25:42.000000Z  x y z vx vy vz
 * TRAJ_STOP
 * COV_START
 * COV_REF_FRAME = ITRF2000
 * COV_ORDERING = LTM
 * 2026-10-26T07:25:42.000000Z  c11 c21 c22 …
 * COV_STOP
 * ```
 * 状态与协方差统一转到 J2000；协方差再转到 UVW 下三角（与契约一致）。
 */
function parseOcmKvn(text: string): ParsedEphem {
  const warnings: string[] = []
  const t: number[] = []
  const r: number[] = []
  const v: number[] = []
  const covRaw: number[][] = []
  const kv = new Map<string, string>()

  let section: 'meta' | 'traj' | 'cov' | 'none' = 'none'
  let covAcc: number[] = []
  let covEpochMs: number | null = null
  let covOrdering: 'LTM' | 'UTM' = 'LTM'
  let covRef = ''
  let covType = 'CARTPV'
  let trajFrameRaw = ''

  const flushCov = (): void => {
    if (covEpochMs === null || covAcc.length === 0) {
      covAcc = []
      covEpochMs = null
      return
    }
    if (covAcc.length < 21) {
      warnings.push(`协方差历元 ${new Date(covEpochMs).toISOString()} 只有 ${covAcc.length} 个值（应为 21 个），已忽略`)
    } else {
      covRaw.push(covAcc.slice(0, 21))
    }
    covAcc = []
    covEpochMs = null
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^COMMENT/i.test(line)) continue
    const up = line.toUpperCase()

    if (up === 'META_START') { section = 'meta'; continue }
    if (up === 'META_STOP') { section = 'none'; continue }
    if (up.startsWith('TRAJ_START') || up.startsWith('TRAJ_BLK_START')) { section = 'traj'; continue }
    if (up.startsWith('TRAJ_STOP') || up.startsWith('TRAJ_BLK_STOP')) { section = 'none'; continue }
    if (up.startsWith('COVARIANCE_START') || up.startsWith('COV_START')) { section = 'cov'; continue }
    if (up.startsWith('COVARIANCE_STOP') || up.startsWith('COV_STOP')) { flushCov(); section = 'none'; continue }

    const eq = line.indexOf('=')
    if (eq > 0 && !NUM_RE.test(line.slice(0, eq).trim())) {
      const key = line.slice(0, eq).trim().toUpperCase()
      const value = line.slice(eq + 1).trim()
      kv.set(key, value)

      if (key === 'COV_ORDERING') covOrdering = value.toUpperCase() === 'UTM' ? 'UTM' : 'LTM'
      else if (key === 'COV_REF_FRAME') covRef = value
      else if (key === 'COV_TYPE') covType = value.toUpperCase()
      else if (key === 'TRAJ_REF_FRAME' || (key === 'REF_FRAME' && !trajFrameRaw)) trajFrameRaw = value
      else if (key === 'TIME_SYSTEM' && value.toUpperCase() !== 'UTC') {
        throw new UploadError('UNSUPPORTED_FRAME', `时间系统只接受 UTC（收到 ${value}）`)
      } else if (key === 'CENTER_NAME' && value.toUpperCase() !== 'EARTH') {
        throw new UploadError('UNSUPPORTED_FRAME', `CENTER_NAME 必须是 EARTH（收到 ${value}）`)
      }

      if (section === 'cov' && key === 'EPOCH') {
        flushCov()
        covEpochMs = parseUtc(value)?.getTime() ?? null
        if (covEpochMs === null) warnings.push(`协方差 EPOCH 无法解析：${value}`)
      }
      continue
    }

    const tokens = line.split(/\s+/)

    if (section === 'cov') {
      // 每历元一行：ISO 时间 + 21 个协方差元素
      if (ISO_TOKEN_RE.test(tokens[0]) && tokens.length >= 22) {
        const nums = tokens.slice(1, 22)
        if (nums.every((c) => NUM_RE.test(c))) {
          flushCov()
          covEpochMs = parseUtc(tokens[0])?.getTime() ?? null
          covAcc = nums.map(Number)
          flushCov()
          continue
        }
      }
      // 旧写法：EPOCH 之后的 21 个数（可跨行）
      if (tokens.every((c) => NUM_RE.test(c))) {
        for (const c of tokens) covAcc.push(Number(c))
        while (covAcc.length >= 21) {
          if (covEpochMs !== null) covRaw.push(covAcc.slice(0, 21))
          covAcc = covAcc.slice(21)
          covEpochMs = null
        }
        continue
      }
      continue
    }

    // 轨迹行：ISO + 位置 + 速度
    if (ISO_TOKEN_RE.test(tokens[0]) && tokens.length >= 7) {
      const ms = parseUtc(tokens[0])?.getTime() ?? null
      if (ms === null) throw new UploadError('INPUT_INVALID', `历元无法解析：${tokens[0]}`)
      const nums = tokens.slice(1, 7)
      if (!nums.every((c) => NUM_RE.test(c))) throw new UploadError('INPUT_INVALID', `历元 ${tokens[0]} 的状态分量非法`)
      const vals = nums.map(Number)
      t.push(ms)
      r.push(vals[0], vals[1], vals[2])
      v.push(vals[3], vals[4], vals[5])
      continue
    }
    // 其它行（单位、注释等）忽略
  }
  flushCov()

  if (!t.length) throw new UploadError('INPUT_INVALID', 'OCM 中未找到轨迹状态行')
  if (!kv.has('TIME_SYSTEM')) warnings.push('OCM 头缺少 TIME_SYSTEM，按 UTC 处理')

  const trajKind = frameKind(trajFrameRaw || 'EME2000')
  if (!trajKind) throw new UploadError('UNSUPPORTED_FRAME', `暂不支持该坐标系：${trajFrameRaw || '空'}`)
  if (trajKind === 'ITRF') {
    for (let i = 0; i < t.length; i++) {
      const rr: Vec3 = [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]]
      const vv: Vec3 = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]
      const out = itrfToJ2000(rr, vv, t[i])
      r[i * 3] = out.r[0]; r[i * 3 + 1] = out.r[1]; r[i * 3 + 2] = out.r[2]
      v[i * 3] = out.v[0]; v[i * 3 + 1] = out.v[1]; v[i * 3 + 2] = out.v[2]
    }
    warnings.push(`状态参考系 ${trajFrameRaw}，已按 GMST 旋转到 J2000（速度补 ω×r）`)
  } else if (trajKind === 'TEME') {
    for (let i = 0; i < t.length; i++) {
      const rr: Vec3 = [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]]
      const vv: Vec3 = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]
      const out = temeToJ2000(rr, vv, t[i])
      r[i * 3] = out.r[0]; r[i * 3 + 1] = out.r[1]; r[i * 3 + 2] = out.r[2]
      v[i * 3] = out.v[0]; v[i * 3 + 1] = out.v[1]; v[i * 3 + 2] = out.v[2]
    }
    warnings.push('状态参考系 TEME，已旋转到 J2000')
  }

  let cov21: number[] | null = null
  if (covRaw.length) {
    if (covType !== 'CARTPV') warnings.push(`COV_TYPE=${covType}，协方差按笛卡尔 [r,v] 处理`)
    const kind = covFrameKind(covRef || trajFrameRaw)
    if (!kind) {
      warnings.push(`协方差坐标系 ${covRef || '未知'} 暂不支持，已忽略协方差`)
    } else if (covRaw.length !== t.length) {
      warnings.push(`协方差历元 ${covRaw.length} 个与状态点 ${t.length} 个不一致，已忽略协方差`)
    } else {
      const out: number[] = []
      for (let i = 0; i < t.length; i++) {
        let c6 = cov6From21(covRaw[i], covOrdering === 'UTM')
        const rr: Vec3 = [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]]
        const vv: Vec3 = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]
        if (kind === 'ITRF') {
          c6 = rotateCov6(c6, itrfToJ2000Mat(t[i]))
          c6 = eciCovToUvw(c6, rr, vv)
        } else if (kind === 'INERTIAL') {
          c6 = eciCovToUvw(c6, rr, vv)
        }
        out.push(...lower21FromCov(c6))
      }
      if (covDiagOk(out)) {
        cov21 = out
        warnings.push('协方差已统一到 UVW（RTN）系下三角')
      } else {
        warnings.push('协方差对角元存在负值或非有限值，已整份忽略协方差')
      }
    }
  }

  const clean = (s: string | undefined): string => (s ?? '').replace(/^"|"$/g, '').trim()
  const designator = clean(kv.get('OBJECT_DESIGNATOR')) || clean(kv.get('OBJECT_ID'))
  const noradM = /\d{5,6}/.exec(designator)
  let stepSec = 0
  if (t.length >= 2) stepSec = Math.round((t[1] - t[0]) / 1000)

  return {
    format: 'ocm',
    name: clean(kv.get('OBJECT_NAME')),
    norad: noradM ? Number(noradM[0]) : null,
    meme: null,
    createdMs: parseUtc(kv.get('CREATION_DATE'))?.getTime() ?? null,
    t, r, v,
    cov21,
    hasCov: Boolean(cov21),
    covFrame: 'UVW',
    stepSec,
    warnings
  }
}

/** CCSDS OCM（自动分流：XML 的 <stateVector> 写法 / KVN 写法） */
function parseOcm(text: string): ParsedEphem {
  return /<stateVector>/i.test(text) ? parseOcmXml(text) : parseOcmKvn(text)
}

/** 入口：bytes + 原始文件名 → ParsedEphem（含全部校验） */
export function parseUpload(buf: Buffer, fileName: string): ParsedEphem {
  if (buf.length > LIMITS.maxBytes) throw new UploadError('TOO_LARGE', `文件 ${(buf.length / 1048576).toFixed(1)} MB 超过 12 MB`)
  if (buf.includes(0)) throw new UploadError('INPUT_INVALID', '文件包含 NUL 字节，疑似二进制文件')
  const text = buf.toString('utf8')
  const format = detectFormat(text)
  if (!format) throw new UploadError('INPUT_INVALID', '无法识别文件格式（只接受 ITC / OEM / OCM）')

  const base = noradFromName(fileName)
  let parsed: ParsedEphem
  if (format === 'itc') {
    let itc: ItcParseResult
    try {
      itc = parseItc(text)
    } catch (e) {
      throw new UploadError('INPUT_INVALID', e instanceof Error ? e.message : String(e))
    }
    parsed = fromItc(itc)
  } else if (format === 'oem') {
    parsed = parseOem(text)
  } else {
    parsed = parseOcm(text)
  }

  if (base.meme != null) parsed.meme = base.meme
  if (parsed.norad == null && base.norad != null) parsed.norad = base.norad
  if (!parsed.name) parsed.name = base.name
  if (parsed.meme == null && parsed.norad != null) parsed.meme = parsed.norad

  validate(parsed)
  return parsed
}
