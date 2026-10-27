/**
 * 配置读取：dotenv 加载 heat-sidecar/.env（找不到则回退当前工作目录），zod 校验并给默认值。
 * 凭据缺失不抛错，只记 warning —— 对应同步任务会跳过并在 /cgi2/sync/status 标红。
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { z } from 'zod'
import { logger } from './logger.js'

const here = dirname(fileURLToPath(import.meta.url))
for (const p of [
  resolve(here, '../.env'), // dist/../.env = heat-sidecar/.env
  resolve(here, '../../heat-sidecar/.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'heat-sidecar/.env')
]) {
  if (existsSync(p)) {
    loadEnv({ path: p })
    break
  }
}

const log = logger('config')

/** 布尔：接受 true/false/1/0（z.coerce.boolean 会把 "false" 当成 true，不能直接用） */
const bool = (def: boolean) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return def
    const s = String(v).trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes'
  }, z.boolean())

const optHours = z.preprocess(
  (v) => (v === undefined || v === null || String(v).trim() === '' ? undefined : Number(v)),
  z.number().positive().optional()
)

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(1235),
  LOG_LEVEL: z.string().default('info'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(13306),
  DB_USER: z.string().default('openspace'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('openspace'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(48),
  SYNC_GP_HOURS: optHours,
  SYNC_CDM_HOURS: optHours,
  SYNC_EPH_HOURS: optHours,
  SYNC_AOE_HOURS: optHours,
  SYNC_SUPGP_HOURS: optHours,

  SAT_USERNAME: z.string().default(''),
  SAT_PASSWORD: z.string().default(''),
  SAT_BASE_URL: z.string().default('https://www.space-track.org'),

  AOE_API_TOKEN: z.string().default(''),
  AOE_BASE_URL: z.string().default('https://spacemapper.cn'),

  STARLINK_EPH_BASE: z.string().default('https://api.starlink.com/public-files/ephemerides/'),
  /** 每轮最多处理的星历文件数（默认 50，0 = 不限） */
  STARLINK_EPH_MAX_FILES: z.coerce.number().int().min(0).default(50),
  STARLINK_EPH_CONCURRENCY: z.coerce.number().int().positive().default(8),

  SIDECAR_ADMIN_TOKEN: z.string().default(''),

  HBR_M: z.coerce.number().positive().default(10),
  MISS_MAX_KM: z.coerce.number().positive().default(10),
  SCREEN_WINDOW_H: z.coerce.number().positive().default(72),
  SCREEN_ON_SYNC: bool(true),
  /** 筛查并行 worker 数（0 = min(4, CPU)） */
  SCREEN_WORKERS: z.coerce.number().int().min(0).default(0),
  /** 单轮最多参与的主星（星历文件）数，0 = 不限；防 1 万+ 份星历把内存打满 */
  SCREEN_MAX_PRIMARY: z.coerce.number().int().min(0).default(200),

  /** 已上传星历存放目录（必须在 web 根目录与 jsc /uploads 之外） */
  HEAT_UPLOAD_DIR: z.string().default('./data/uploads'),
  /** 已上传星历保留天数 */
  HEAT_UPLOAD_TTL_D: z.coerce.number().positive().default(7),
  /** 全局每小时上传上限（防误操作，§15.11） */
  HEAT_UPLOAD_PER_HOUR: z.coerce.number().int().positive().default(20),
  /** 按需任务排队上限（同时只跑 1 个） */
  HEAT_SCREEN_QUEUE_MAX: z.coerce.number().int().positive().default(5),
  /** 按需任务的 worker 数 */
  HEAT_UPLOAD_WORKERS: z.coerce.number().int().positive().default(2),
  /** 单个按需任务超时（分钟） */
  SCREEN_TIMEOUT_MIN: z.coerce.number().positive().default(60),
  /** 私有核心入口（不配置 = stub，TLE/AOE 标签显示「核心算法模块未加载」） */
  HEAT_CORE_PATH: z.string().default(''),
  HEAT_CORE_REQUIRED: bool(false)
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  // 配置项类型错误属于部署问题，直接退出，避免带着错误参数跑同步
  // eslint-disable-next-line no-console
  console.error('[FATAL] 配置校验失败：', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data

export const syncHours = {
  gp: config.SYNC_GP_HOURS ?? config.SYNC_INTERVAL_HOURS,
  cdm: config.SYNC_CDM_HOURS ?? config.SYNC_INTERVAL_HOURS,
  eph: config.SYNC_EPH_HOURS ?? config.SYNC_INTERVAL_HOURS,
  aoe: config.SYNC_AOE_HOURS ?? config.SYNC_INTERVAL_HOURS,
  supgp: config.SYNC_SUPGP_HOURS ?? config.SYNC_INTERVAL_HOURS
} as const

export function hasSpaceTrackCreds(): boolean {
  return Boolean(config.SAT_USERNAME && config.SAT_PASSWORD)
}

if (!hasSpaceTrackCreds()) log.warn('SAT_USERNAME / SAT_PASSWORD 未配置：gp、cdm 同步将被跳过')
if (!config.AOE_API_TOKEN) log.warn('AOE_API_TOKEN 未配置：aoe 同步将被跳过')
if (!config.SIDECAR_ADMIN_TOKEN) log.warn('SIDECAR_ADMIN_TOKEN 未配置：/cgi2/admin/* 将一律拒绝')
