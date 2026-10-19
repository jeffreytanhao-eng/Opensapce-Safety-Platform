/**
 * 全局主题切换 composable
 * 主题缓存到 localStorage（key: openspace-theme），默认暗月（dark）
 *  - dark（暗月）        ：html.dark 类 + tech.scss 深色变量（配合 Element Plus 暗色变量）
 *  - light（日间·经典）  ：html[data-theme="light"] + light.scss
 *  - saas（日间·SaaS）   ：html[data-theme="saas"]  + saas.scss
 *
 * 三个主题互斥：切换时只保留一个标记（dark 用类名，浅色两套用 data-theme 属性）。
 */
import { computed, ref } from 'vue'
import type { Component } from 'vue'
import { Brush, Moon, Sunny } from '@element-plus/icons-vue'

const THEME_KEY = 'openspace-theme'

export type Theme = 'dark' | 'light' | 'saas'

/** 主题选项（下拉三选一）；icon 供切换按钮与下拉项复用，避免三处各写一份映射 */
export const THEME_OPTIONS: { value: Theme; label: string; icon: Component }[] = [
  { value: 'dark', label: '暗月（金属科技风）', icon: Moon },
  { value: 'light', label: '日间（经典浅色）', icon: Sunny },
  { value: 'saas', label: '日间（商用 SaaS）', icon: Brush }
]

const theme = ref<Theme>('dark')

function apply(t: Theme) {
  theme.value = t
  const root = document.documentElement
  if (t === 'dark') {
    root.classList.add('dark')
    root.removeAttribute('data-theme')
  } else {
    root.classList.remove('dark')
    root.setAttribute('data-theme', t)
  }
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/** 应用入口初始化：读取 localStorage 并应用主题 */
export function initTheme() {
  let t: Theme = 'dark'
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'dark' || saved === 'light' || saved === 'saas') t = saved
  } catch {
    /* ignore */
  }
  apply(t)
}

export function useTheme() {
  const current = computed(() => THEME_OPTIONS.find((o) => o.value === theme.value) || THEME_OPTIONS[0])
  return {
    theme,
    /** 当前主题图标 / 名称（切换按钮直接用，避免各页面重复判断） */
    currentIcon: computed(() => current.value.icon),
    currentLabel: computed(() => current.value.label),
    /** 切换主题（供下拉 @command 直接使用） */
    setTheme: apply
  }
}
