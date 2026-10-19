/**
 * 全局设备检测 composable
 * 检测 UA + 窗口宽度，自动判断是否移动端
 * 断点：768px 以下或 UA 含移动设备标识 → 移动端
 */
import { onMounted, onUnmounted, ref } from 'vue'

const MOBILE_BREAKPOINT = 768
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)

const isMobile = ref(false)
const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1920)
const height = ref(typeof window !== 'undefined' ? window.innerHeight : 1080)

let listeners = 0
let resizeHandler: (() => void) | null = null

function recalc() {
  const w = window.innerWidth
  const h = window.innerHeight
  width.value = w
  height.value = h
  // UA 标识为移动设备 或 窗口小于断点 → 移动端
  isMobile.value = uaMobile || w < MOBILE_BREAKPOINT
  // 同步到 <html> 类，供全局 CSS 使用
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('is-mobile', isMobile.value)
  }
}

export function useDevice() {
  onMounted(() => {
    listeners++
    if (listeners === 1) {
      recalc()
      resizeHandler = () => recalc()
      window.addEventListener('resize', resizeHandler, { passive: true })
      window.addEventListener('orientationchange', resizeHandler, { passive: true })
    }
  })

  onUnmounted(() => {
    listeners--
    if (listeners === 0 && resizeHandler) {
      window.removeEventListener('resize', resizeHandler)
      window.removeEventListener('orientationchange', resizeHandler)
      resizeHandler = null
    }
  })

  return { isMobile, width, height }
}

/** 同步判定当前是否移动端：不依赖组件生命周期，供 setup 里需要立刻取初值的场景使用
 *  （如 v-collapse 的初始值——指令在 mounted 时取值，此时 useDevice 的 onMounted 尚未执行） */
export function isMobileNow(): boolean {
  if (typeof window === 'undefined') return false
  return uaMobile || window.innerWidth < MOBILE_BREAKPOINT
}

/** 在路由守卫中使用（非组件上下文，不需要 onMounted） */
export function checkDevice() {
  if (typeof window === 'undefined') return false
  if (listeners === 0) recalc()
  return isMobile.value
}

/** 静态硬件档位探测（仅作初始档位，运行时还会按实测帧率自适应降档）：
 *  低端 = 2 核及以下 / deviceMemory ≤ 2GB；中端 = 4 核及以下 / ≤ 4GB；
 *  deviceMemory 仅 Chromium 系可用，缺失时不下判（避免误伤 Firefox 桌面端）。 */
export type DeviceTier = 'high' | 'mid' | 'low'
export function detectDeviceTier(): DeviceTier {
  if (typeof navigator === 'undefined') return 'high'
  const cores = navigator.hardwareConcurrency
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const lowEnd = (typeof cores === 'number' && cores <= 2) || (typeof mem === 'number' && mem <= 2)
  const midEnd = (typeof cores === 'number' && cores <= 4) || (typeof mem === 'number' && mem <= 4)
  if (lowEnd) return 'low'
  // 移动端（含老年安卓机）：无高配证据时至少中档，4 核及以下降到低档
  if (uaMobile) return midEnd ? 'low' : 'mid'
  if (midEnd) return 'mid'
  return 'high'
}
