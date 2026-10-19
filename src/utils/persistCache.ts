/**
 * 持久缓存（IndexedDB）—— 前台「先出上次数据、后台静默刷新」的公共基建
 *
 * 背景：/situation 三维态势页的点云（约 3.5 万在轨物体）、碰撞热力、过境结果等，
 * 都是「体积大 + 变化慢」的只读数据。此前每次冷启动都要重新走网络 + 后端现算，
 * 导致首屏与模块切换都要等秒级。这里把它们落到浏览器 IndexedDB：
 *  - 再次进入页面时先取回上次快照直接渲染（毫秒级出画面），随后后台请求最新数据静默替换；
 *  - 刷新页面 / 重开浏览器都不丢。
 *
 * 兼容性：IndexedDB 在 Chromium / 安卓 WebView 内均可用；
 * 不可用（隐私模式、极老内核）时全部读写退化为 no-op，调用方按「没有缓存」处理，不影响功能。
 *
 * 与 localStorage 的区别：点云/热力单份就有几 MB，localStorage 有 5~10MB 硬上限且同步阻塞主线程，
 * 故这里统一定为 IndexedDB（异步、大容量、结构化克隆，可直接存对象/数组，省掉一次 JSON 序列化）。
 */

const DB_NAME = 'openspace-cache'
const DB_VERSION = 1
const STORE = 'kv'

/** 缓存条目：v = 数据本体，at = 写入时刻（unix ms，供过期判断） */
interface CacheEntry<T = unknown> {
  v: T
  at: number
}

/** 打开数据库的共享 Promise（只打开一次，失败缓存 null 避免反复重试） */
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** 单次事务的薄封装：拿到 store 后执行操作，任何异常都退化为「无缓存」 */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
  fallback: T
): Promise<T> {
  return openDb().then((db) => {
    if (!db) return fallback
    return new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        req.onsuccess = () => resolve((req.result as T) ?? fallback)
        req.onerror = () => resolve(fallback)
        tx.onabort = () => resolve(fallback)
      } catch {
        resolve(fallback)
      }
    })
  })
}

/**
 * 读取缓存。
 * @param key       缓存键（建议带模块前缀，如 'cloud:tle'、'heat:local:7'）
 * @param maxAgeMs  超过该年龄视为过期（返回 null）；不传表示不做过期判断
 */
export async function cacheGet<T>(key: string, maxAgeMs?: number): Promise<T | null> {
  const entry = await withStore<CacheEntry<T> | undefined>('readonly', (s) => s.get(key) as IDBRequest, undefined)
  if (!entry || entry.v === undefined) return null
  if (maxAgeMs != null && Date.now() - entry.at > maxAgeMs) return null
  return entry.v
}

/** 读取缓存的同时取回写入时刻（需要判断「这份快照有多旧」时用） */
export async function cacheGetEntry<T>(key: string): Promise<CacheEntry<T> | null> {
  const entry = await withStore<CacheEntry<T> | undefined>('readonly', (s) => s.get(key) as IDBRequest, undefined)
  return entry && entry.v !== undefined ? entry : null
}

/** 写入缓存（结构化克隆，直接存对象/数组即可）。失败静默返回 false。 */
export function cacheSet(key: string, value: unknown): Promise<boolean> {
  const entry: CacheEntry = { v: value, at: Date.now() }
  return withStore<boolean>('readwrite', (s) => s.put(entry, key) as IDBRequest, false).then((r) => r !== false)
}

/** 删除某个键 */
export function cacheDel(key: string): Promise<void> {
  return withStore<void>('readwrite', (s) => s.delete(key) as IDBRequest, undefined)
}

/** 列出全部键（可按前缀过滤）：供容量治理 / 调试用 */
export function cacheKeys(prefix = ''): Promise<string[]> {
  return withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys() as IDBRequest, []).then((keys) =>
    keys.map((k) => String(k)).filter((k) => k.startsWith(prefix))
  )
}

/** 清空缓存（可按前缀只清某个模块） */
export async function cacheClear(prefix = ''): Promise<void> {
  if (!prefix) {
    await withStore<void>('readwrite', (s) => s.clear() as IDBRequest, undefined)
    return
  }
  const keys = await cacheKeys(prefix)
  await Promise.all(keys.map((k) => cacheDel(k)))
}

/**
 * 请求「持久化存储」配额：让浏览器/WebView 在磁盘紧张时也不清理本缓存。
 * 安卓 WebView 上默认是 best-effort 存储，可能被系统回收；显式 persist 可显著降低被清概率。
 * 失败（不支持 / 用户拒绝）不影响功能，仅退化为「可能被回收」。
 */
export async function ensurePersistent(): Promise<boolean> {
  try {
    const s = navigator.storage
    if (!s?.persist) return false
    if (await s.persisted?.()) return true
    return await s.persist()
  } catch {
    return false
  }
}

/**
 * 「先出上次数据、再静默刷新」的通用包装（前台各模块统一用它，避免每处各写一遍）：
 *  1) 命中本地缓存 → 立刻 apply(缓存值)，界面毫秒级出内容；
 *  2) 同时发起 fetcher 请求，返回后 apply(最新值) 覆盖，并把最新值写回缓存；
 *  3) fetcher 失败：有缓存时静默（画面仍可用，错误提示由 request 拦截器统一弹出）；
 *     无缓存时把错误抛给调用方，由调用方决定提示。
 *
 * @param key            缓存键（建议带模块前缀，注意带上「影响结果的查询条件」以免串数据）
 * @param fetcher        拉取最新数据的函数
 * @param apply          把数据落到界面状态（缓存值与最新值共用同一条路径，保证两条来源口径一致）
 * @param skipCacheWhen  返回 true 表示此次不读缓存（例如状态已被别处刷新过）；
 *                       仍然会请求最新数据并写回缓存
 */
export async function cacheFirst<T>(
  key: string,
  fetcher: () => Promise<T>,
  apply: (v: T) => void,
  skipCacheWhen?: () => boolean
): Promise<void> {
  let hit = false
  if (!skipCacheWhen?.()) {
    const cached = await cacheGet<T>(key)
    if (cached != null && !skipCacheWhen?.()) {
      apply(cached)
      hit = true
    }
  }
  try {
    const fresh = await fetcher()
    apply(fresh)
    void cacheSet(key, fresh)
  } catch (e) {
    if (!hit) throw e
  }
}