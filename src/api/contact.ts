/**
 * 问题反馈 / 商业合作接口（前台 · 免登录匿名提交）
 *
 * 后端 /cgi/contact 为公开匿名接口：按 IP 限流，不关联任何账号；
 * 失败一律静默 reject（由调用方自行提示），不做登录态处理。
 */
import axios, { type AxiosRequestConfig } from 'axios'
import { API_BASE } from '@/utils/request'

export interface ApiResult<T = unknown> {
  code: number
  msg: string
  data: T
}

const appClient = axios.create({
  baseURL: API_BASE ? `${API_BASE}/cgi/contact` : '/cgi/contact',
  timeout: 15000
})

appClient.interceptors.response.use(
  (res) => {
    const body = res.data as ApiResult
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return Promise.reject(new Error(body.msg || '请求失败'))
    }
    return body?.data as never
  },
  (err) => Promise.reject(new Error(err.response?.data?.msg || err.message || '网络错误'))
)

function appReq<T>(cfg: AxiosRequestConfig): Promise<T> {
  return appClient(cfg) as unknown as Promise<T>
}

/** 提交问题反馈（匿名） */
export function submitFeedback(content: string) {
  return appReq<null>({ url: '/feedback', method: 'post', data: { content } })
}

/** 提交商业合作（匿名） */
export function submitCooperation(data: { intent: string; role: string; content?: string }) {
  return appReq<null>({ url: '/cooperation', method: 'post', data })
}

export default {
  submitFeedback, submitCooperation
}
