<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useDevice } from '@/composables/useDevice'
import { useMobileTable } from '@/composables/useMobileTable'

const { isMobile } = useDevice()
useMobileTable(isMobile)
</script>

<template>
  <!-- ElConfigProvider 提供中文 locale（按需引入后不再全量 app.use(ElementPlus)） -->
  <el-config-provider :locale="zhCn">
    <!-- 顶层路由缓存：/situation 三维态势场景切走再回来时保留现场（场景/镜头/选中/轨道线），不再重新加载；
     include 白名单只缓存 situation -->
    <router-view v-slot="{ Component }">
      <keep-alive include="situation">
        <component :is="Component" />
      </keep-alive>
    </router-view>
  </el-config-provider>
</template>

<style>
/* 让 router 内容浮在 #app::before/::after 装饰层之上 */
#app > * { position: relative; z-index: 1; }
</style>
