<script setup lang="ts">
/**
 * 星座总览 /situation 发射站列表面板（左侧滑出）
 * 与 SatListPanel.vue 同款结构：搜索名称/国家码 + 仅现役过滤，点击选中站。
 * 共享响应式状态集中在 scene.ts（launchSites / sitePanel / siteFiltered / siteSel）。
 * 纯动作（点选中、关闭面板）通过 emit 交给父组件 index.vue 编排（父组件调用 BaseScene.expose）。
 */
import {
  launchSites, siteLoading, siteError, sitePanel, siteFiltered, siteSel, dockMode,
  drawerHeightVh, isDrawerDragging, useDrawerDrag, fmtNum
} from './scene'

const emit = defineEmits<{
  (e: 'pick', siteId: number): void
  (e: 'close'): void
}>()

/** 移动端底部抽屉拖拽手势（PC 无 touch 事件，不影响） */
const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 标记点颜色口径与三维地球上的发射站标记一致：有即将发射→琥珀 / 现役→青 / 退役→灰 */
function siteDotColor(s: { upcoming_count?: number; status?: number }) {
  if ((s.upcoming_count || 0) > 0) return '#ffb43a'
  if (s.status === 1) return '#35d0ff'
  return '#8b97a8'
}
/** 后端 datetime（UTC，DATETIME 或 ISO 串）→ `YYYY-MM-DD HH:mm`：只重排不换算时区（与 index.vue 的 fmtUtc 同口径） */
function fmtUtc(s?: string | null) {
  if (!s) return '—'
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : String(s)
}
function close() {
  emit('close')
}
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'site'" class="side-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">发射站列表</b>
          <span class="sp-count">{{ siteFiltered.length.toLocaleString() }} / {{ launchSites.length.toLocaleString() }} 个发射站</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="close">»</button>
      </div>
      <div class="sp-search">
        <input v-model="sitePanel.q" class="sp-input" type="text" placeholder="搜名称 / 国家码" />
        <span v-if="sitePanel.q" class="sp-clear" @click="sitePanel.q = ''">×</span>
      </div>
      <div class="sp-types">
        <label class="sp-type" :class="{ on: sitePanel.onlyActive }">
          <input type="checkbox" v-model="sitePanel.onlyActive" />
          <span class="sp-type-txt">仅现役</span>
        </label>
      </div>
      <div class="sp-list">
        <div v-if="siteLoading && !launchSites.length" class="sp-empty">正在加载…</div>
        <div v-else-if="siteError" class="sp-empty">{{ siteError }}</div>
        <div
          v-for="s in siteFiltered"
          :key="s.id"
          class="sp-item"
          :class="{ active: siteSel && siteSel.id === s.id }"
          @click="emit('pick', s.id)"
        >
          <span class="sp-item-dot" :style="{ background: siteDotColor(s) }"></span>
          <div class="sp-item-main">
            <span class="sp-item-name">{{ s.name_cn || s.name_en || ('#' + s.id) }}</span>
            <span class="sp-item-nor">{{ s.country_code || '—' }} · {{ fmtNum(s.lat, 2) }}°, {{ fmtNum(s.lon, 2) }}°</span>
            <span v-if="s.next_net" class="sp-item-net">下次发射 {{ fmtUtc(s.next_net) }} UTC</span>
          </div>
          <span v-if="(s.upcoming_count || 0) > 0" class="sp-item-badge" :title="'即将发射 ' + s.upcoming_count + ' 次'">{{ s.upcoming_count }}</span>
        </div>
        <div v-if="!siteLoading && !siteError && !siteFiltered.length" class="sp-empty">无匹配发射站</div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
