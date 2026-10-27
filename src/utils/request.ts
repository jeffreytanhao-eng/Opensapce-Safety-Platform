import axios, { type AxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'
import { removeCookie, LOGGED_KEY } from '@/utils/cookie'

export interface ApiResult<T = unknown> {
  code: number
  msg: string
  data: T
}

/**
 * 接口基础地址：
 * - 默认（未设置 VITE_API_BASE）：用相对前缀 '/api'、'/cgi'，开发时靠 Vite 代理转发到后端；
 * - 部署在网关子路径（如 haproxy 的 /zxsd/）时注入 `VITE_API_BASE=/zxsd/server`，
 *   接口变为 /zxsd/server/api、/zxsd/server/cgi，由网关剥离该前缀后转发给后端。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ?? ''

/** 后台接口完整前缀（含部署子路径），如 `/zxsd/server/api`；未配置时为本站相对前缀 `/api` */
export const API_PREFIX = API_BASE ? `${API_BASE}/api` : '/api'

/**
 * 拼接 /uploads 静态资源的可访问地址。
 * 库里存的是根绝对路径（如 /uploads/owner/CN.png），网关子路径部署（/zxsd/）下直接当 src 用会请求到站点根而 404，
 * 必须补上 VITE_API_BASE 前缀；已是 http(s) 绝对地址的原样返回。
 */
export function uploadUrl(fileUrl?: string | null): string {
  const p = String(fileUrl || '')
  if (!p) return ''
  if (/^https?:\/\//i.test(p)) return p
  return `${API_BASE}${p.startsWith('/') ? p : `/${p}`}`
}

/**
 * 当前是否处于后台管理上下文（/mui/**，含 /mui/login）。
 * /situation 等前台页面与 /mui 后台相互独立：
 *  - 只有后台页才弹请求错误提示、才做 401 跳登录；
 *  - 前台页（/situation、/test 等）请求失败一律静默 reject，由页面自行决定是否用轻量提示，
 *    避免登录态过期等报错弹窗、跳转打扰三维现场。
 */
function inMuiContext(): boolean {
  return router.currentRoute.value.path.startsWith('/mui')
}

/**
 * 请求级「静默」开关：配置 `silent: true` 的请求失败时不弹错误提示。
 * 用于长任务（过境汇总 / 交会碰撞扫描等）运行期的**进度轮询**：主进程繁忙时某次轮询可能超过 15s
 * 被 axios / haproxy 超时断开，这类瞬时失败下一轮（每 2s）会自动恢复，弹红框只会打断界面、误导用户。
 * 静默请求同时**跳过 GET 自动重试**：轮询本身就是重试节奏，若仍连重 3 次（每次各等 15s）会把请求堆起来。
 * 注意：静默只抑制「提示」，请求照样 reject（调用方需自行 catch）、401 仍按登录态处理。
 */
declare module 'axios' {
  export interface AxiosRequestConfig {
    silent?: boolean
  }
}

const request = axios.create({
  baseURL: API_PREFIX,
  timeout: 15000,
  // JWT 存 httpOnly Cookie，跨域/代理场景确保携带凭证
  withCredentials: true
})

request.interceptors.request.use((cfg) => {
  return cfg
})

/** 是否值得自动重试：后端重启窗口内 vite 代理返回 502 / 网络层失败 */
function isRetryable(err: any): boolean {
  if (!err?.response) return true // 无响应（连接被拒/超时/网络错误）
  const s = err.response.status
  return s === 502 || s === 504 // 代理未就绪/网关超时
}

request.interceptors.response.use(
  (res) => {
    if (res.config.responseType === 'blob') return res
    const body = res.data as ApiResult
    if (body && typeof body.code === 'number' && body.code !== 0) {
      const inMui = inMuiContext()
      if (inMui && !res.config.silent) ElMessage.error(body.msg || '请求失败')
      if (body.code === 401) {
        removeCookie(LOGGED_KEY)
        if (inMui) router.push('/mui/login')
      }
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return body?.data as never
  },
  async (err) => {
    const cfg = err?.config
    const method = String(cfg?.method || 'get').toLowerCase()
    // 仅对幂等的 GET 自动重试（最多 2 次），消化后端重启/未就绪的瞬时失败；
    // 静默轮询除外：轮询本身即重试节奏，避免单次失败连重 3 次把请求堆积起来。
    if (cfg && method === 'get' && isRetryable(err) && !cfg.silent) {
      const retryCount = (cfg as any).__retryCount || 0
      if (retryCount < 2) {
        (cfg as any).__retryCount = retryCount + 1
        await new Promise((r) => setTimeout(r, 700))
        return request(cfg)
      }
    }
    const status = err.response?.status
    const msg = err.response?.data?.msg || err.message || '网络错误'
    const inMui = inMuiContext()
    if (inMui && !cfg?.silent) ElMessage.error(msg)
    if (status === 401) {
      removeCookie(LOGGED_KEY)
      if (inMui) router.push('/mui/login')
    }
    return Promise.reject(err)
  }
)

/** 泛型封装：request<T>({ url, method, data, params }) → Promise<T> */
export function http<T = unknown>(cfg: AxiosRequestConfig): Promise<T> {
  return request(cfg) as unknown as Promise<T>
}

/**
 * /cgi —— 前台 / 免登录页面接口实例
 * 与 /api 后台完全隔离：baseURL='/cgi'，后端不挂鉴权，不触发 401 跳登录；
 * 错误提示同样只在 /mui 上下文弹出，/situation 等前台页静默 reject。
 */
const cgiRequest = axios.create({
  baseURL: API_BASE ? `${API_BASE}/cgi` : '/cgi',
  timeout: 15000,
  withCredentials: false
})

cgiRequest.interceptors.response.use(
  (res) => {
    if (res.config.responseType === 'blob') return res
    const body = res.data as ApiResult
    if (body && typeof body.code === 'number' && body.code !== 0) {
      if (inMuiContext()) ElMessage.error(body.msg || '请求失败')
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return body?.data as never
  },
  async (err) => {
    const cfg = err?.config
    const method = String(cfg?.method || 'get').toLowerCase()
    // 仅对幂等的 GET 自动重试（最多 2 次），消化后端重启/未就绪的瞬时失败
    if (cfg && method === 'get' && isRetryable(err)) {
      const retryCount = (cfg as any).__retryCount || 0
      if (retryCount < 2) {
        (cfg as any).__retryCount = retryCount + 1
        await new Promise((r) => setTimeout(r, 700))
        return cgiRequest(cfg)
      }
    }
    const msg = err.response?.data?.msg || err.message || '网络错误'
    if (inMuiContext()) ElMessage.error(msg)
    return Promise.reject(err)
  }
)

/** 泛型封装：httpCgi<T>({ url, method, data, params }) → Promise<T> */
export function httpCgi<T = unknown>(cfg: AxiosRequestConfig): Promise<T> {
  return cgiRequest(cfg) as unknown as Promise<T>
}

/**
 * /cgi2 —— 安全热力独立计算服务 heat-sidecar 的接口实例
 * 与 /cgi 隔离：sidecar 可能未部署（本地开发常见），请求失败一律静默 reject、且**不做自动重试**，
 * 由调用方展示「服务未就绪」提示，避免每次打开面板都白等 1.4s 的重试窗口。
 */
const cgi2Request = axios.create({
  baseURL: API_BASE ? `${API_BASE}/cgi2` : '/cgi2',
  timeout: 30000,
  withCredentials: false
})

cgi2Request.interceptors.response.use(
  (res) => {
    const body = res.data as ApiResult
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return body?.data as never
  },
  (err) => Promise.reject(err)
)

/** 泛型封装：httpCgi2<T>({ url, method, data, params }) → Promise<T> */
export function httpCgi2<T = unknown>(cfg: AxiosRequestConfig): Promise<T> {
  return cgi2Request(cfg) as unknown as Promise<T>
}

export default request
