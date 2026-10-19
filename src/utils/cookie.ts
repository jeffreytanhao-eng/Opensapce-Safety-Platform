/**
 * 轻量 Cookie 工具
 * 认证 JWT 已改为 httpOnly Cookie（mui_token，JS 读不到，由浏览器随请求自动携带）。
 * 前端仅用普通 Cookie「mui_logged」标记登录状态，供路由守卫/WS 重连等判断。
 */

/** 登录状态标记 Cookie 名 */
export const LOGGED_KEY = 'mui_logged'

export function getCookie(name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${esc}=([^;]*)`))
  return m ? decodeURIComponent(m[1]) : ''
}

export function setCookie(name: string, value: string, maxAgeSec = 7 * 86400, path = '/') {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSec}; path=${path}; SameSite=Lax`
}

export function removeCookie(name: string, path = '/') {
  document.cookie = `${name}=; max-age=0; path=${path}`
}

/** 是否已登录（登录成功后由前端写入 mui_logged 标记） */
export function isLoggedIn(): boolean {
  return !!getCookie(LOGGED_KEY)
}
