/**
 * 浏览器会话标识（前台 /cgi 免登录页的「谁是谁」隔离键）
 *
 * 背景：区域过境 / 多区域过境是进程级全局单例（同一时刻只跑一个扫描），
 * 若不同访客都读同一份全局进度，就会互相看到对方的扫描、互相打断。
 * 后端按「客户端 key」给每个访客分配独立的任务槽位与进度（排队制），
 * 本文件负责在前端生成并持久化这个 key：
 *   - 存 sessionStorage：同一标签页刷新保持、关掉标签页即换新（天然一人一份）；
 *   - 格式约束 `^[A-Za-z0-9_-]{8,64}$`（与后端 sanitizeClientKey 一致），不合法则视为无 key（后端回退按 IP 隔离）。
 */

const STORAGE_KEY = 'cgi_client_key'

/** 与后端 sanitizeClientKey 保持一致 */
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/

let cached = ''

function randomKey(): string {
  try {
    const c = globalThis.crypto
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID().replace(/-/g, '')
    }
    if (c && typeof c.getRandomValues === 'function') {
      const buf = new Uint8Array(16)
      c.getRandomValues(buf)
      let s = ''
      for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, '0')
      return s
    }
  } catch {
    /* 忽略：退到 Math.random 兜底 */
  }
  let s = ''
  while (s.length < 24) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return s.slice(0, 24)
}

/** 取（必要时创建）当前浏览器会话的客户端 key */
export function getClientKey(): string {
  if (cached) return cached
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY)
    if (saved && KEY_RE.test(saved)) {
      cached = saved
      return cached
    }
  } catch {
    /* sessionStorage 不可用（隐私模式等）：本次会话用内存缓存即可 */
  }
  const key = randomKey()
  cached = key
  try {
    sessionStorage.setItem(STORAGE_KEY, key)
  } catch {
    /* 忽略 */
  }
  return cached
}
