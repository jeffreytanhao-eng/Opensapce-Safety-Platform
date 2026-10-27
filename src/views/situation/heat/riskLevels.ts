/**
 * 安全热力统一分级口径（两标签共用）
 *
 * 依据《02-安全热力开发计划.md》§3.5 / §7 与 HeatCore 契约（apiVersion = 1）：
 *  - 两个热力标签（卫星轨道威胁事件 / 星历增强）统一按碰撞概率 Pc 分档，
 *    不再使用后端下发的 color/risk 字段（D9）；
 *  - 等级取值与契约 `Level` 一致：red / orange / yellow / insufficient，前后端同一口径；
 *  - Pc 由 heat-core 用 Foster 2D + 双方协方差算出；PcMax 为 Alfano 缩放后的上界，
 *    当 Pc 极低但 PcMax 已达高危门限时，说明当前协方差不足以支撑「安全」结论，标为「数据不足」。
 */

/** 热力等级（与 HeatCore 契约 level 一致） */
export type HeatLevel = 'red' | 'orange' | 'yellow' | 'insufficient'

const LEVEL_ALIAS: Record<string, HeatLevel> = {
  red: 'red',
  orange: 'orange',
  yellow: 'yellow',
  insufficient: 'insufficient',
  // 旧缓存 / 旧接口口径一次性兼容
  danger: 'red',
  warning: 'orange',
  info: 'yellow'
}

/**
 * 等级字符串归一化（契约值直通，旧口径 danger/warning/info 映射到新口径）。
 * 'none' 与未知值返回 null（不进入热力视图）。
 */
export function normalizeLevel(v: unknown): HeatLevel | null {
  return typeof v === 'string' ? LEVEL_ALIAS[v] ?? null : null
}

export interface PcLevelDef {
  level: HeatLevel
  label: string
  color: string
  /** 下界（含），null = 无下界 */
  minPc: number | null
  /** 上界（不含），null = 无上界 */
  maxPc: number | null
  /** 判断依据文案（图例展示） */
  basis: string
}

/** 按 Pc 门限的四档定义（顺序即图例展示顺序：高 → 低 → 数据不足） */
export const PC_LEVELS: PcLevelDef[] = [
  {
    level: 'red',
    label: '高危',
    color: '#e8453c',
    minPc: 1e-4,
    maxPc: null,
    basis: 'Pc ≥ 1e-4'
  },
  {
    level: 'orange',
    label: '警告',
    color: '#f08a3c',
    minPc: 1e-5,
    maxPc: 1e-4,
    basis: '1e-5 ≤ Pc < 1e-4'
  },
  {
    level: 'yellow',
    label: '关注',
    color: '#f2c14e',
    minPc: 1e-7,
    maxPc: 1e-5,
    basis: '1e-7 ≤ Pc < 1e-5'
  },
  {
    level: 'insufficient',
    label: '数据不足',
    color: '#93a4bd',
    minPc: null,
    maxPc: 1e-7,
    basis: 'Pc < 1e-7 但 PcMax ≥ 1e-4'
  }
]

const LEVEL_MAP: Record<HeatLevel, PcLevelDef> = PC_LEVELS.reduce((acc, d) => {
  acc[d.level] = d
  return acc
}, {} as Record<HeatLevel, PcLevelDef>)

/**
 * Pc → 等级。
 * @param pc 标称碰撞概率
 * @param pcMax Alfano 缩放后的上界；省略时按「数据充足」处理（Pc 极低即不显示）
 * @returns null 表示该事件不进入热力视图（Pc 过低且上界也未达高危门限）
 */
export function levelOfPc(pc: number, pcMax?: number): HeatLevel | null {
  const p = Number.isFinite(pc) ? Math.max(0, pc) : 0
  if (p >= 1e-4) return 'red'
  if (p >= 1e-5) return 'orange'
  if (p >= 1e-7) return 'yellow'
  const upper = Number.isFinite(pcMax as number) ? (pcMax as number) : 0
  return upper >= 1e-4 ? 'insufficient' : null
}

export function colorOfLevel(level: HeatLevel): string {
  return LEVEL_MAP[level].color
}

export function labelOfLevel(level: HeatLevel): string {
  return LEVEL_MAP[level].label
}

/** Pc → 综合风险权重（0~1），与源计划 §7 一致：log10(Pc) 在 [-7, -3] 线性映射 */
export function riskOfPc(pc: number): number {
  const p = Number.isFinite(pc) ? Math.max(pc, 1e-30) : 1e-30
  return Math.min(1, Math.max(0, (Math.log10(p) + 7) / 4))
}
