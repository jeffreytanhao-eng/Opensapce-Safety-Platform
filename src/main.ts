import { createApp } from 'vue'
import { createPinia } from 'pinia'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
// 不再全量 app.use(ElementPlus)：组件由 unplugin-vue-components 在模板处按需自动引入，
// 仅单独注册 ElLoading 以保住全局 v-loading 指令（该指令无法被模板自动导入覆盖）。
import { ElLoading } from 'element-plus'
import 'normalize.css'
// Element Plus 全量样式（一次性加载，彻底消除切换页面时按需样式即时编译的卡顿；
// 暗黑模式变量在 html.dark 下单独生效）
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/scss/tech.scss'
import './assets/scss/mobile.scss'
// 两套浅色主题各占一个 data-theme：light=日间·经典（原版），saas=日间·商用 SaaS
import './assets/scss/light.scss'
import './assets/scss/saas.scss'
import App from './App.vue'
import router from './router'
import { initTheme } from '@/composables/useTheme'
// 面板折叠指令（v-collapse）：situation 页 dock 子菜单标题 / 右下角图例标题使用
import { collapse } from './directives/collapse'

const app = createApp(App)

// 初始化主题（读取 localStorage，dark 走 html.dark 暗色体系，light 走 data-theme 浅色体系）
initTheme()

// 全局注册所有 Element Plus 图标（供界面 <component :is="iconName"> 使用）
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
// 注册 ElLoading（全局 v-loading 指令）；其余 EP 组件按需自动引入，不再全量 app.use(ElementPlus)
app.use(ElLoading)
// 全局折叠指令：v-collapse（点击标题切换父面板 is-collapsed，样式见 tech.scss「面板折叠」段）
app.directive('collapse', collapse)

app.mount('#app')
