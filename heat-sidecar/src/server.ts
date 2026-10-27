/**
 * heat-sidecar 入口：建表 → 探针 → 启动 HTTP（/cgi2）→ 启动同步调度。
 * 监听端口见 config.PORT（默认 1235），不依赖、不修改 server.jsc。
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config } from './config.js'
import { execute, pingDb, query } from './db.js'
import { logger, setLogLevel } from './logger.js'
import { cgi2 } from './routes/cgi2.js'
import { runProbe } from './sync/probe.js'
import { startScheduler, stopScheduler } from './scheduler.js'
import { loadHeatCore } from './core/loader.js'
import { resetStaleJobs } from './ephem/jobs.js'
import { migrateLegacyEphem } from './ephem/migrate.js'

const log = logger('server')
const here = dirname(fileURLToPath(import.meta.url))

async function ensureSchema(): Promise<void> {
  // dist/../sql = heat-sidecar/sql（按文件名顺序执行所有迁移）
  const sqlDir = resolve(here, '../sql')
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort()
  let total = 0
  for (const file of files) {
    const sql = await readFile(resolve(sqlDir, file), 'utf8')
    // 先按行剔除 -- 注释，再按 ; 拆分：否则每段 CREATE 都因前置注释被整体丢弃
    const stripped = sql
      .split(/\r?\n/)
      .map((line) => (line.trim().startsWith('--') ? '' : line))
      .join('\n')
    const statements = stripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const stmt of statements) await execute(stmt)
    total += statements.length
  }
  // 增量列：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，已有库需单独 ALTER
  await ensureColumn('hs_event', 'sigma_p_t_km', 'DOUBLE')
  await ensureColumn('hs_event', 'pc_source', 'VARCHAR(8) NULL')
  await ensureColumn('hs_event', 'quality', 'VARCHAR(10) NULL')
  await ensureColumn('hs_event', 'core_name', 'VARCHAR(40) NULL')
  await ensureColumn('hs_event', 'core_version', 'VARCHAR(20) NULL')
  await ensureColumn('hs_screen_run', 'scope', "VARCHAR(8) NOT NULL DEFAULT 'official'")
  await ensureColumn('hs_screen_run', 'ephem_id', 'CHAR(36) NULL')
  await ensureColumn('hs_screen_run', 'core_name', 'VARCHAR(40) NULL')
  await ensureColumn('hs_screen_run', 'core_version', 'VARCHAR(20) NULL')
  log.info(`建表检查完成（${files.length} 个文件 / ${total} 条 DDL）`)
}

/** 给已有表补列（列已存在则跳过；MySQL 8 的 ADD COLUMN 不支持 IF NOT EXISTS） */
async function ensureColumn(table: string, column: string, ddl: string): Promise<void> {
  const rows = await query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  if (Number(rows[0]?.n ?? 0) > 0) return
  await execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  log.info(`补列：${table}.${column}`)
}

function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  // 允许跨域：dev 走 vite 代理同源，直接访问 1235 时也能用
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    next()
  })
  app.options('*', (_req, res) => res.sendStatus(204))

  app.use('/cgi2', cgi2)
  app.use((_req, res) => {
    res.status(404).json({ code: 404, msg: 'not found', data: null })
  })
  return app
}

async function main(): Promise<void> {
  setLogLevel(config.LOG_LEVEL)
  const dbUp = await pingDb()
  if (!dbUp) {
    log.error(`数据库不可达：${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}`)
    process.exit(1)
  }
  await ensureSchema()
  await migrateLegacyEphem()
  await loadHeatCore()
  await resetStaleJobs()
  await runProbe().catch((e) => log.warn(`探针执行失败：${e instanceof Error ? e.message : String(e)}`))

  const app = createApp()
  const server = app.listen(config.PORT, () => {
    log.info(`heat-sidecar 已启动：http://127.0.0.1:${config.PORT}/cgi2/health`)
    log.info(`星历存储：MySQL hs_ephem（统一表，BLOB 存点数据，每轮最多 ${config.STARLINK_EPH_MAX_FILES || '不限'} 个文件，同星覆盖）`)
  })
  startScheduler()

  const shutdown = (signal: string) => {
    log.info(`收到 ${signal}，正在关闭…`)
    stopScheduler()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e))
  process.on('uncaughtException', (e) => log.error('uncaughtException', e))
}

void main()
