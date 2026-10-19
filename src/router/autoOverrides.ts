/**
 * 文件即路由 —— 手动覆盖配置
 *
 * 路由自动注册规则见 src/router/index.ts 顶部注释。这里按「访问路径」覆盖
 * 自动推导出的 name / meta，或禁用某条自动路由。新增页面无需在这配置，
 * 只有需要调整自动注册结果时才改这里。
 *
 * 访问路径规则示例：
 *   - src/views/foo/index.vue   → /foo    （顶层页面）
 *   - src/views/mui/bar/list.vue → /mui/bar（后台模块页面）
 *
 * 覆盖字段：
 *   { name?: string; meta?: Record<string, unknown>; disabled?: boolean }
 *   disabled: true 时该路径不会注册为路由
 */
export interface RouteOverride {
  name?: string
  meta?: Record<string, unknown>
  /** true = 不注册这条自动路由 */
  disabled?: boolean
}

export const routeOverrides: Record<string, RouteOverride> = {
  // 顶层页标题：通过 meta.title 变量配置（/mui 后台统一用 index.html 默认标题，不在此配置）
  // /situation 不再走自动注册：改为 router/index.ts 显式声明（带 :type 参数，让底部 dock 菜单随 URL 持久化，刷新后不回到第一个）
  '/situation': { disabled: true }
}