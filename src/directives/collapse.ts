/**
 * 面板折叠指令（v-collapse）：挂在面板内的标题元素上
 *   <div class="dock-menu-title" v-collapse>标题</div>        —— 点击标题可折叠/展开
 *   <div class="lg-title" v-collapse="true"></div>            —— true = 初始即为折叠态
 * 配套样式在 assets/scss/tech.scss 的「面板折叠」段：
 *   标题加 .collapsible-title（手型 + ::after 箭头），父容器加 .collapsible-panel，
 *   点击切换父容器 .is-collapsed —— CSS 负责隐藏标题后的兄弟内容并旋转箭头。
 */
import type { Directive } from 'vue'

/** el -> click 监听引用（unmounted 时移除） */
const toggles = new WeakMap<HTMLElement, () => void>()

export const collapse: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    el.classList.add('collapsible-title')
    const panel = el.parentElement
    if (!panel) return
    panel.classList.add('collapsible-panel')
    // 初始折叠态：v-collapse="true" 时收起，只显示标题条（面板常显但内容占空间的场景，如右下角图例）
    if (binding.value === true) panel.classList.add('is-collapsed')
    const toggle = () => panel.classList.toggle('is-collapsed')
    toggles.set(el, toggle)
    el.addEventListener('click', toggle)
  },
  unmounted(el) {
    const toggle = toggles.get(el)
    if (toggle) el.removeEventListener('click', toggle)
    toggles.delete(el)
  }
}

export default collapse
