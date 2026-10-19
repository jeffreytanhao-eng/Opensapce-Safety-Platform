import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * 超时兜底 loading：源状态为 true 时默认不提示，只有持续超过 delay 毫秒才置为 true；
 * 源状态回落时立即复位并取消计时。
 *
 * 用于「正常情况毫秒级返回、偶发才变慢」的交互：默认不显示加载提示，
 * 避免每次点击都闪一下 loading（视觉上反而像卡顿）；真变慢时才出现兜底提示。
 *
 * @param source 真实的加载状态（如 passLoading / heatLoading）
 * @param delay  出现提示的阈值，默认 1500ms
 */
export function useDelayed(source: Ref<boolean>, delay = 1500): Ref<boolean> {
  const shown = ref(false)
  let timer: number | null = null
  function clear() {
    if (timer !== null) { window.clearTimeout(timer); timer = null }
  }
  watch(source, (v) => {
    if (!v) { clear(); shown.value = false; return }
    if (shown.value || timer !== null) return
    timer = window.setTimeout(() => { timer = null; shown.value = true }, delay)
  }, { immediate: true })
  onBeforeUnmount(clear)
  return shown
}
