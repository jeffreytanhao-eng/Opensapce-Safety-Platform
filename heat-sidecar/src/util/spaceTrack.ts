/**
 * Space-Track 客户端：登录（cookie 会话）+ 查询 JSON。
 * 路径写法与 jsc 现有实现一致（计划 §3.4）。
 */
import { config } from '../config.js'
import { logger } from '../logger.js'
import { CookieJar, fetchJson } from './http.js'

const log = logger('spacetrack')

export class SpaceTrackClient {
  private jar = new CookieJar()
  private loggedIn = false

  async login(): Promise<void> {
    if (this.loggedIn) return
    const url = `${config.SAT_BASE_URL.replace(/\/$/, '')}/ajaxauth/login`
    const body = new URLSearchParams({
      identity: config.SAT_USERNAME,
      password: config.SAT_PASSWORD
    }).toString()
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'openspace-heat-sidecar/1.0'
        },
        body,
        signal: AbortSignal.timeout(60_000)
      })
    } catch (e) {
      throw new Error(`Space-Track 登录请求失败：${e instanceof Error ? e.message : String(e)}`)
    }
    this.jar.absorb(res)
    const text = await res.text()
    if (!res.ok) throw new Error(`Space-Track 登录失败：HTTP ${res.status} ${text.slice(0, 200)}`)
    // 登录失败时 Space-Track 返回 200 + { "Login": "Failed" } 或 HTML 提示
    if (/"Login"\s*:\s*"Failed"/i.test(text) || /failed/i.test(text.slice(0, 500))) {
      throw new Error('Space-Track 登录失败：账号或密码错误')
    }
    if (this.jar.size === 0) {
      log.warn('登录响应未返回 cookie，后续查询可能被拒绝')
    }
    this.loggedIn = true
  }

  async getJson<T>(path: string): Promise<T> {
    await this.login()
    const url = `${config.SAT_BASE_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    return await fetchJson<T>(url, {
      headers: { 'User-Agent': 'openspace-heat-sidecar/1.0' },
      cookie: () => this.jar.header(),
      retries: 3,
      timeoutMs: 180_000
    })
  }
}
