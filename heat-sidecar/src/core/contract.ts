/**
 * HeatCore 契约（apiVersion = 1）—— 仓库与私有核心之间的唯一边界（03 §6）。
 * 仓库内其它代码只能 import 本文件、./loader、./stub，不得按路径直接 import 私有实现。
 */

export type Level = 'red' | 'orange' | 'yellow' | 'insufficient' | 'none'
export type Quality = 'eph' | 'tle_only' | 'cdm'
export type V3 = [number, number, number]

/** Space-Track / Celestrak OMM JSON 原样 */
export interface OmmRecord {
  NORAD_CAT_ID: number
  OBJECT_NAME: string
  EPOCH: string
  [k: string]: unknown
}

export interface EphemerisInput {
  norad: number
  meme: number
  name: string
  createdMs: number
  /** 各点时刻，unix ms */
  t: Float64Array
  /** 每点 6 个值：J2000 坐标，km、km/s */
  rv: Float64Array
  /** 每点 21 个值：6×6 下三角，UVW 坐标系，km² */
  cov21?: Float64Array
  origin?: 'official' | 'uploaded'
  format?: 'itc' | 'oem' | 'ocm'
  covSource?: 'file' | 'none'
  covFrame?: 'UVW' | 'INERTIAL'
}

export interface CdmAssessInput {
  cdmId: string
  tcaMs: number
  noradA: number
  noradB: number
  missKm: number
  pc: number | null
  ommA?: OmmRecord
  ommB?: OmmRecord
}

export interface ScreenInput {
  kind: 'tle' | 'aoe'
  window: { startMs: number; endMs: number }
  primaries: EphemerisInput[]
  secondaries: OmmRecord[]
  secondaryEphemerides?: EphemerisInput[]
  cdms?: CdmAssessInput[]
  options: { missMaxKm: number; hbrM: number; workers?: number }
}

export interface CoreEvent {
  primaryNorad: number
  secondaryNorad: number
  secondarySrc: 'tle' | 'aoe' | 'eph' | 'supgp'
  tcaMs: number
  missKm: number
  missRtnKm?: V3
  relSpeedKms: number
  pc: number | null
  pcMax: number | null
  pcMethod: string
  pcSource: 'cdm' | 'core' | null
  quality: Quality
  level: Level
  diluted: boolean
  sigmaPSrc?: string
  sigmaSSrc?: string
  sigmaSTKm?: number
  secAgeH?: number
  ephAgeH?: number
  cdmId?: string
  cdmPc?: number
  cdmMissKm?: number
  cdmDtcaS?: number
  /** 渲染用，单位 km，坐标系 TEME */
  aTeme: V3
  bTeme: V3
  midTeme: V3
}

export interface ScreenResult {
  events: CoreEvent[]
  stats: {
    nPrimary: number
    nSecondary: number
    nCandidates: number
    nEvents: number
    nPropErrors: number
    elapsedMs: number
  }
  warnings: string[]
}

export interface LevelBand {
  key: Level
  label: string
  color: string
  min: number | null
  max: number | null
}

export interface LevelTable {
  bands: LevelBand[]
  missMaxKm: number
}

export interface ScreenControl {
  signal?: AbortSignal
  onProgress?(done: number, total: number): void
}

export interface HeatCore {
  readonly apiVersion: 1
  readonly name: string
  readonly version: string
  readonly capabilities: ReadonlyArray<'screen' | 'assessCdm' | 'pc' | 'compareTle'>
  selfTest(): Promise<{ ok: boolean; detail?: string }>
  levels(): LevelTable
  screen(input: ScreenInput, ctl?: ScreenControl): Promise<ScreenResult>
  assessCdm?(input: CdmAssessInput): Promise<CoreEvent | null>
  compareTle?(eph: EphemerisInput, omm: OmmRecord): Promise<{ tMs: Float64Array; dRtnKm: Float64Array }>
}

export type HeatCoreFactory = () => HeatCore | Promise<HeatCore>

export type HeatCoreErrorCode =
  | 'CORE_NOT_LOADED'
  | 'CORE_API_MISMATCH'
  | 'CORE_SELFTEST_FAILED'
  | 'INPUT_INVALID'
  | 'ABORTED'
  | 'TIMEOUT'

export class HeatCoreError extends Error {
  constructor(public code: HeatCoreErrorCode, msg: string) {
    super(msg)
  }
}
