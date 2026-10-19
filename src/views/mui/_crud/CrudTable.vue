<script setup lang="ts">
/**
 * 通用表 CRUD 管理组件（MUI）
 * 每张表的 src/views/mui/<table>/index.vue 只是传入 table 名的薄壳；
 * 列结构 / 表格列 / 编辑表单全部由 /cgi/mui/crud/:table/schema 动态驱动：
 *   - 列表：分页 + keyword 对全部文本列模糊搜索 + 点击表头排序
 *   - 新增/编辑：按列类型出控件（enum→下拉、数值→数字、datetime→日期时间、text→多行）
 *   - 删除：确认后按主键删除
 * 自增列不进表单；无主键的表只读（不提供编辑/删除）。
 */
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getCrudSchema,
  listCrudRows,
  createCrudRow,
  updateCrudRow,
  deleteCrudRow,
  type TableSchema,
  type ColInfo
} from '@/api/muiCrud'

const props = defineProps<{ table: string }>()

const schema = ref<TableSchema | null>(null)
const rows = ref<Record<string, unknown>[]>([])
const total = ref(0)
const loading = ref(false)
const keyword = ref('')

const query = reactive({ page: 1, pageSize: 20, sort: '', order: 'desc' as 'asc' | 'desc' })

/** 拉取列表 */
async function load() {
  loading.value = true
  try {
    const data = await listCrudRows(props.table, {
      page: query.page,
      pageSize: query.pageSize,
      keyword: keyword.value || undefined,
      sort: query.sort || undefined,
      order: query.order
    })
    rows.value = data.rows
    total.value = data.total
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败')
  } finally {
    loading.value = false
  }
}

function onSearch() {
  query.page = 1
  void load()
}

/** 表头点击排序 */
function onSortChange({ prop, order }: { prop: string; order: string | null }) {
  if (!order) { query.sort = ''; } else { query.sort = prop; query.order = order === 'ascending' ? 'asc' : 'desc' }
  void load()
}

/* ---------------- 新增 / 编辑对话框（动态表单） ---------------- */
const dialog = ref(false)
const editingId = ref<string | number | null>(null) // null=新增
const form = reactive<Record<string, unknown>>({})

/** 按列类型挑表单控件 */
function controlOf(c: ColInfo): 'select' | 'number' | 'datetime' | 'date' | 'textarea' | 'input' {
  if (c.enumValues) return 'select'
  if (['int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'double', 'float'].includes(c.type)) return 'number'
  if (c.type === 'datetime' || c.type === 'timestamp') return 'datetime'
  if (c.type === 'date') return 'date'
  if (['text', 'mediumtext', 'longtext', 'tinytext'].includes(c.type)) return 'textarea'
  return 'input'
}

/** 表单出现的列：排除自增列 */
const formCols = (): ColInfo[] => (schema.value?.columns || []).filter((c) => !c.auto)

function openCreate() {
  editingId.value = null
  Object.keys(form).forEach((k) => delete form[k])
  for (const c of formCols()) form[c.name] = c.nullable ? null : ''
  dialog.value = true
}

function openEdit(row: Record<string, unknown>) {
  if (!schema.value?.pk) return
  editingId.value = String(row[schema.value.pk])
  Object.keys(form).forEach((k) => delete form[k])
  for (const c of formCols()) {
    const v = row[c.name]
    form[c.name] = v === null && !c.nullable ? '' : (v ?? null)
  }
  dialog.value = true
}

async function submit() {
  if (!schema.value?.pk) return
  try {
    if (editingId.value === null) {
      await createCrudRow(props.table, { ...form })
      ElMessage.success('已新增')
    } else {
      await updateCrudRow(props.table, editingId.value, { ...form })
      ElMessage.success('已保存')
    }
    dialog.value = false
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败')
  }
}

async function remove(row: Record<string, unknown>) {
  if (!schema.value?.pk) return
  try {
    await ElMessageBox.confirm(`确认删除该行（${schema.value.pk} = ${row[schema.value.pk]}）？删除后不可恢复。`, '删除确认', { type: 'warning' })
  } catch { return }
  try {
    await deleteCrudRow(props.table, String(row[schema.value.pk]))
    ElMessage.success('已删除')
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message || '删除失败')
  }
}

onMounted(async () => {
  try {
    schema.value = await getCrudSchema(props.table)
  } catch (e) {
    ElMessage.error((e as Error).message || '表结构加载失败')
    return
  }
  await load()
})
</script>

<template>
  <div class="crud-page">
    <header class="crud-head">
      <div class="crud-title">
        <h2>{{ schema?.name || table }}</h2>
        <span class="crud-comment">{{ schema?.columns.length || 0 }} 列 · 共 {{ total }} 行</span>
      </div>
      <div class="crud-tools">
        <el-input
          v-model="keyword"
          class="crud-search"
          placeholder="模糊搜索文本列…"
          clearable
          @keyup.enter="onSearch"
          @clear="onSearch"
        >
          <template #append><el-button @click="onSearch">搜索</el-button></template>
        </el-input>
        <el-button @click="onSearch">刷新</el-button>
        <el-button v-if="schema?.pk" type="primary" @click="openCreate">新增</el-button>
      </div>
    </header>

    <el-table
      v-loading="loading"
      :data="rows"
      class="crud-table"
      size="small"
      border
      stripe
      @sort-change="onSortChange"
    >
      <el-table-column
        v-for="c in schema?.columns || []"
        :key="c.name"
        :prop="c.name"
        :label="c.name"
        :sortable="c.pk ? 'custom' : false"
        min-width="140"
        show-overflow-tooltip
      >
        <template #header>
          {{ c.name }}
          <span class="col-type">{{ c.comment !== c.name ? `(${c.comment})` : c.fullType }}</span>
        </template>
        <template #default="{ row }">
          <span class="cell-val">{{ row[c.name] === null ? 'NULL' : String(row[c.name]) }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="schema?.pk" label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty>空表</template>
    </el-table>

    <footer class="crud-foot">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="load"
        @size-change="onSearch"
      />
    </footer>

    <el-dialog
      v-model="dialog"
      :title="editingId === null ? `新增 · ${table}` : `编辑 · ${table}（主键 ${editingId}）`"
      width="640px"
      destroy-on-close
    >
      <el-form label-width="180px" class="crud-form">
        <el-form-item v-for="c in formCols()" :key="c.name" :label="c.name">
          <span class="form-tip">{{ c.comment !== c.name ? c.comment : c.fullType }}{{ c.nullable ? ' · 可空' : '' }}</span>
          <el-select v-if="controlOf(c) === 'select'" v-model="form[c.name]" clearable filterable style="width: 100%">
            <el-option v-for="v in c.enumValues" :key="v" :label="v" :value="v" />
          </el-select>
          <el-input-number
            v-else-if="controlOf(c) === 'number'"
            v-model="form[c.name] as number"
            :controls="false"
            style="width: 100%"
          />
          <el-date-picker
            v-else-if="controlOf(c) === 'datetime'"
            v-model="form[c.name] as string"
            type="datetime"
            value-format="YYYY-MM-DD HH:mm:ss"
            style="width: 100%"
          />
          <el-date-picker
            v-else-if="controlOf(c) === 'date'"
            v-model="form[c.name] as string"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
          <el-input
            v-else-if="controlOf(c) === 'textarea'"
            v-model="form[c.name] as string"
            type="textarea"
            :rows="4"
          />
          <el-input v-else v-model="form[c.name] as string" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.crud-page {
  min-height: 100vh;
  padding: 16px 20px;
  box-sizing: border-box;
  background: var(--bg, #060d17);
  color: var(--text-1, #dde7f3);
}
.crud-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  .crud-title {
    display: flex;
    align-items: baseline;
    gap: 12px;
    h2 { margin: 0; font-size: 18px; letter-spacing: 0.5px; }
    .crud-comment { font-size: 12px; color: var(--text-3, #7d8ba3); }
  }
  .crud-tools { display: flex; gap: 8px; align-items: center; .crud-search { width: 260px; } }
}
.crud-table {
  width: 100%;
  .col-type { font-size: 10px; color: var(--text-3, #7d8ba3); font-weight: 400; margin-left: 3px; }
  .cell-val { font-family: Consolas, monospace; font-size: 12px; }
}
.crud-foot {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0 4px;
}
.crud-form {
  .form-tip { display: block; font-size: 11px; color: var(--text-3, #7d8ba3); margin-bottom: 4px; line-height: 1.4; }
}
</style>
