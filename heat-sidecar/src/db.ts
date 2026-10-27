/**
 * MySQL 连接池。
 *
 * 时区口径（探针实测，见 sync/probe.ts）：
 *  - 现有库 `sat_tle.epoch`、`sat_aoe.epoch`、`sat_cdm.tca` 存的都是 UTC；
 *  - mysql2 配 `timezone:'Z'`（读 DATETIME 按 UTC 解释、写 Date 转 UTC 字符串）；
 *  - 每个连接再执行 `SET SESSION time_zone='+00:00'`，保证 NOW()/CURRENT_TIMESTAMP 也走 UTC。
 * 注意：jsc 自己的会话是 +8，所以它的 `tca >= NOW()` 实际会多过滤未来 8 小时；
 * 这是既有行为，不在本服务可改范围（计划 D11：jsc 不动）。
 */
import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise'
import { config } from './config.js'
import { logger } from './logger.js'

const log = logger('db')

export const pool: Pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  charset: 'utf8mb4',
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: config.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  supportBigNumbers: true,
  bigNumberStrings: false,
  enableKeepAlive: true
})

pool.on('connection', (conn) => {
  conn.query("SET SESSION time_zone = '+00:00'")
})

export async function query<T extends RowDataPacket = RowDataPacket>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const [rows] = await pool.query<T[]>(sql, params)
  return rows
}

export async function execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
  const [res] = await pool.query<ResultSetHeader>(sql, params)
  return res
}

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch (e) {
    log.error('数据库连接失败', e instanceof Error ? e.message : e)
    return false
  }
}

/** 事务封装（批量写入用） */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const out = await fn(conn)
    await conn.commit()
    return out
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

/**
 * MySQL 咨询锁（跨进程互斥，避免调度器与手动触发同时跑同一同步源）。
 * 拿不到立即返回，不排队。
 */
export async function acquireLock(name: string): Promise<{ ok: boolean; release: () => Promise<void> }> {
  const conn = await pool.getConnection()
  const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS ok', [name])
  const ok = Number(rows[0]?.ok) === 1
  if (!ok) {
    conn.release()
    return { ok: false, release: async () => undefined }
  }
  return {
    ok: true,
    release: async () => {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [name])
      } finally {
        conn.release()
      }
    }
  }
}

/** 按 chunks 切分数组（批量 INSERT 控制单条 SQL 体积） */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** 批量插入（`INSERT ... VALUES ?`） */
export async function bulkInsert(conn: PoolConnection, sql: string, rows: unknown[][]): Promise<void> {
  for (const part of chunk(rows, 300)) {
    await conn.query(sql, [part])
  }
}
