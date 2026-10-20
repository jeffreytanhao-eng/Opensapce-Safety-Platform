import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { routeOverrides } from './autoOverrides'

/**
 * 文件即路由（类 Nuxt3 自动注册）—— 纯前台版
 * —— 自动扫描 src/views 下的约定页面自动生成路由，无需手改：
 *   1) 各子目录里的 index.vue → 目录入口，按所在路径访问（如 src/views/home/index.vue → /home）
 *   - index.vue 会折叠掉末段：views/home/index.vue → /home
 *   - 目录名以 _ 开头（如 _components）不会被注册为页面
 * —— 手动修改（可覆盖自动推导的 name/meta，或禁用某条）：
 *   在 src/router/autoOverrides.ts 的 routeOverrides 按访问路径配置
 * —— /situation 保留显式声明：带 :type 参数（sat 卫星 | cons 星座 | heat 热力 | pass 过境），
 *   底部 dock 选中模块写入地址栏，刷新时按参数恢复选中模块
 */

/** 扫描：目录入口 index.vue（目录名以 _ 开头的不会被注册为页面） */
const dirEntries = import.meta.glob('../views/**/index.vue')

/** 相对 src/views 的 posix 路径（去 .vue）：如 'home' */
function relFromViews(file: string): string {
  return file.split('/views/')[1].replace(/\.vue$/, '')
}

/** 折叠 index 末段后的访问路径：'home/index' → 'home' */
function derivePath(rel: string): string {
  if (rel.endsWith('/index')) return rel.slice(0, -'/index'.length)
  return rel
}

/** 生成自动注册的顶层路由（已应用覆盖 + 去重） */
function resolveTopRoutes(): RouteRecordRaw[] {
  const routes: RouteRecordRaw[] = []
  const used = new Set<string>()
  for (const file of Object.keys(dirEntries)) {
    const rel = relFromViews(file)
    if (rel.split('/').some((s) => s.startsWith('_'))) continue // 私有/组件目录
    if (rel === 'mui' || rel.startsWith('mui/')) continue // /mui 显式声明（数据管理后台布局，带 :table 参数）
    const rawPath = derivePath(rel)
    if (rawPath === 'situation') continue // 显式声明（带 :type 参数），不参与自动注册
    const route: RouteRecordRaw = {
      path: `/${rawPath}`,
      name: `auto-${rel.replace(/[^0-9a-zA-Z]+/g, '_')}`,
      component: dirEntries[file],
      meta: { auto: true }
    }
    // 手动覆盖（autoOverrides.ts）：改 name/meta 或禁用
    const ov = routeOverrides[`/${rawPath}`] || routeOverrides[rawPath]
    if (ov) {
      if (ov.disabled) continue
      if (ov.name) route.name = ov.name
      if (ov.meta) route.meta = { ...route.meta, ...ov.meta }
    }
    if (!used.has(route.path)) { used.add(route.path); routes.push(route) }
  }
  return routes
}

const routes: RouteRecordRaw[] = [
  // 态势页带 :type（sat 卫星 | cons 星座 | heat 热力 | pass 过境）：底部 dock 选中模块写入地址栏，
  // 刷新时按参数恢复选中模块（不再落回第一个）；type 缺省时页面内会规范化到 sat
  { path: '/situation/:type?', name: 'situation', component: () => import('@/views/situation/index.vue'), meta: { title: '开源太空安全平台' } },
  // MUI 数据管理后台：/mui 表目录（空态引导）+ /mui/:table 表 CRUD；
  // 单页布局（左侧表菜单 + 右侧内容区），菜单数据来自 /cgi/mui/crud/tables
  { path: '/mui/:table?', name: 'mui', component: () => import('@/views/mui/MuiLayout.vue'), meta: { title: '数据表管理' } },
  // 自动注册的顶层页面（如 src/views/home/index.vue → /home）
  ...resolveTopRoutes(),
  { path: '/', redirect: '/situation/sat' },
  { path: '/:pathMatch(.*)*', redirect: '/situation/sat' }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

/** 默认站点标题（与 index.html 一致）；路由 meta.title 优先 */
const DEFAULT_TITLE = '开源太空安全平台'

router.afterEach((to) => {
  document.title = (to.meta.title as string) || DEFAULT_TITLE
})

export default router
