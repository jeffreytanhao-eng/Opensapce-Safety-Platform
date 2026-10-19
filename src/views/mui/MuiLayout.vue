<script setup lang="ts">
/**
 * MUI 数据管理后台布局（/mui 与 /mui/:table）
 * 传统后台形态：左侧固定表菜单（按前缀分组 + 搜索），右侧为当前表的 CRUD 内容区。
 * 表清单来自 /cgi/mui/crud/tables；点菜单跳 /mui/<table>（可刷新 / 可收藏），
 * /mui 不带表名时内容区显示引导空态。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listCrudTables, type TableInfo } from '@/api/muiCrud'
import CrudTable from './_crud/CrudTable.vue'
import { tableName } from './tableNames'

const route = useRoute()
const router = useRouter()

const tables = ref<TableInfo[]>([])
const loading = ref(true)
const keyword = ref('')
/** 窄屏（<900px）菜单默认收起，点顶栏按钮展开为抽屉 */
const menuOpen = ref(false)

/** 当前选中的表名（路由参数） */
const current = computed(() => String(route.params.table || ''))

/** 前缀分组的中文名（与系统模块叫法一致） */
const GROUP_NAMES: Record<string, string> = {
  sat_: '卫星',
  pass_: '过境',
  launch_: '发射',
  sys_: '系统',
  ai_: '智能体',
  contact_: '反馈',
  content_: '内容'
}

/** 按表名前缀分组（中文组名），支持按表名 / 中文名 / 注释筛选 */
const groups = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const filtered = tables.value.filter(
    (t) =>
      !kw ||
      t.name.toLowerCase().includes(kw) ||
      (t.comment || '').toLowerCase().includes(kw) ||
      tableName(t.name).toLowerCase().includes(kw)
  )
  const map = new Map<string, TableInfo[]>()
  for (const t of filtered) {
    const prefix = t.name.includes('_') ? t.name.slice(0, t.name.indexOf('_') + 1) : t.name
    if (!map.has(prefix)) map.set(prefix, [])
    map.get(prefix)!.push(t)
  }
  return [...map.entries()]
    .sort((a, b) => (GROUP_NAMES[a[0]] || a[0]).localeCompare(GROUP_NAMES[b[0]] || b[0], 'zh'))
    .map(([prefix, list]) => ({ prefix, list }))
})

function go(name: string) {
  menuOpen.value = false
  router.push(`/mui/${name}`)
}

onMounted(async () => {
  try {
    tables.value = await listCrudTables()
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="mui-shell">
    <!-- 顶栏 -->
    <header class="mui-topbar">
      <button class="mui-menu-btn" title="表菜单" @click="menuOpen = !menuOpen">☰</button>
      <b class="mui-brand">数据表管理</b>
      <span class="mui-crumb">
        <template v-if="current">
          {{ tableName(current) }}<i> · {{ current }}</i>
        </template>
        <template v-else>从左侧选择一张表</template>
      </span>
      <a class="mui-home-link" href="/situation/sat">← 态势大屏</a>
    </header>

    <div class="mui-body">
      <!-- 左侧表菜单 -->
      <aside class="mui-side" :class="{ open: menuOpen }">
        <el-input v-model="keyword" class="mui-side-search" placeholder="筛选：中文名 / 表名…" clearable size="small" />
        <nav class="mui-nav">
          <div v-for="g in groups" :key="g.prefix" class="mui-group">
            <div class="mui-group-title">{{ GROUP_NAMES[g.prefix] || g.prefix }}<span>{{ g.list.length }}</span></div>
            <button
              v-for="t in g.list"
              :key="t.name"
              class="mui-item"
              :class="{ on: t.name === current }"
              :title="`${tableName(t.name)}（${t.name}）`"
              @click="go(t.name)"
            >
              <span class="n">{{ tableName(t.name) }}</span>
              <span class="code">{{ t.name }}</span>
              <em>{{ t.approxRows > 9999 ? `${(t.approxRows / 10000).toFixed(1)}w` : t.approxRows }}</em>
            </button>
          </div>
          <div v-if="!loading && !groups.length" class="mui-none">无匹配的表</div>
        </nav>
      </aside>
      <div v-if="menuOpen" class="mui-scrim" @click="menuOpen = false"></div>

      <!-- 右侧内容区：切表用 :key 重挂载（重新拉 schema + 列表） -->
      <main class="mui-main">
        <CrudTable v-if="current" :key="current" :table="current" />
        <div v-else class="mui-empty">
          <el-empty description="左侧选择一张表进行数据管理（列表 / 搜索 / 新增 / 编辑 / 删除）" />
        </div>
      </main>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mui-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg, #060d17);
  color: var(--text-1, #dde7f3);
}
.mui-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 14px;
  flex: none;
  border-bottom: 1px solid rgba(120, 160, 220, 0.16);
  background: rgba(255, 255, 255, 0.03);
  .mui-menu-btn { display: none; border: 1px solid rgba(120, 160, 220, 0.3); background: none; color: inherit; border-radius: 6px; padding: 3px 8px; cursor: pointer; }
  .mui-brand { font-size: 15px; letter-spacing: 1px; }
  .mui-crumb { font-size: 12px; color: var(--text-2, #b8c7de); i { font-style: normal; color: var(--text-3, #7d8ba3); } }
  .mui-home-link { margin-left: auto; font-size: 12px; color: #7fb0ff; text-decoration: none; &:hover { color: #a8c8ff; } }
}
.mui-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.mui-side {
  width: 232px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-right: 1px solid rgba(120, 160, 220, 0.16);
  overflow: hidden;
  .mui-side-search { flex: none; }
  .mui-nav { flex: 1; overflow-y: auto; padding-right: 2px;
    &::-webkit-scrollbar { width: 5px; }
    &::-webkit-scrollbar-thumb { background: rgba(120, 160, 220, 0.25); border-radius: 3px; } }
  .mui-group {
    margin-bottom: 10px;
    .mui-group-title { font-size: 11px; color: #7fb0ff; letter-spacing: 0.5px; margin: 6px 2px 4px;
      span { color: var(--text-3, #7d8ba3); margin-left: 6px; font-size: 10px; } }
  }
  .mui-item {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: 'n cnt' 'code cnt';
    column-gap: 6px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-2, #b8c7de);
    text-align: left;
    cursor: pointer;
    transition: all 0.12s;
    .n { grid-area: n; font-size: 12.5px; line-height: 1.4; }
    .code { grid-area: code; font-size: 10px; color: var(--text-3, #7d8ba3); font-family: Consolas, monospace; line-height: 1.3; }
    em { grid-area: cnt; align-self: center; font-style: normal; font-size: 10px; color: var(--text-3, #7d8ba3); }
    &:hover { background: rgba(255, 255, 255, 0.06); color: #e6edf6; }
    &.on { background: rgba(79, 195, 247, 0.16); color: #7fd8ff;
      .code { color: rgba(127, 216, 255, 0.75); } em { color: #7fd8ff; } }
  }
  .mui-none { font-size: 12px; color: var(--text-3, #7d8ba3); padding: 10px 4px; }
}
.mui-scrim { display: none; }
.mui-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  .mui-empty { display: flex; align-items: center; justify-content: center; height: 100%; }
}

/* 窄屏：菜单抽屉化 */
@media (max-width: 900px) {
  .mui-topbar .mui-menu-btn { display: inline-block; }
  .mui-side {
    position: fixed;
    top: 46px;
    bottom: 0;
    left: 0;
    z-index: 30;
    background: var(--bg, #060d17);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    &.open { transform: none; box-shadow: 8px 0 24px rgba(0, 0, 0, 0.45); }
  }
  .mui-scrim { display: block; position: fixed; inset: 46px 0 0; z-index: 25; background: rgba(0, 0, 0, 0.4); }
}
</style>
