/**
 * MUI 表数据通用 CRUD 接口（/cgi/mui/crud，免登录）
 * 后端实现见 server/routes/muiCrud.js：表/列白名单来自 information_schema，
 * 前端不需要维护字段清单 —— 全部由 schema 接口动态驱动。
 */
import { httpCgi } from '@/utils/request'

/** 表清单条目（目录菜单用） */
export interface TableInfo {
  name: string
  comment: string
  approxRows: number
}

/** 列描述（动态表格列 + 动态表单共用） */
export interface ColInfo {
  name: string
  /** MySQL 基础类型（varchar/int/datetime/text/enum…） */
  type: string
  /** 完整类型（如 enum('a','b')、varchar(255)） */
  fullType: string
  comment: string
  nullable: boolean
  pk: boolean
  /** 自增列：新增/编辑表单不出现 */
  auto: boolean
  /** enum 列的取值清单（非 enum 为 null） */
  enumValues: string[] | null
}

/** 单表结构 */
export interface TableSchema {
  name: string
  /** 主键列名（无主键表只读） */
  pk: string | null
  columns: ColInfo[]
}

/** 分页列表 */
export interface PageData {
  total: number
  page: number
  pageSize: number
  rows: Record<string, unknown>[]
}

/** 全部可管理表（含注释与近似行数） */
export function listCrudTables() {
  return httpCgi<TableInfo[]>({ url: '/mui/crud/tables', method: 'get' })
}

/** 单表结构（列定义） */
export function getCrudSchema(table: string) {
  return httpCgi<TableSchema>({ url: `/mui/crud/${table}/schema`, method: 'get' })
}

/** 分页列表：keyword 对全部文本列 LIKE；sort/order 排序（缺省主键倒序） */
export function listCrudRows(table: string, params?: { page?: number; pageSize?: number; keyword?: string; sort?: string; order?: 'asc' | 'desc' }) {
  return httpCgi<PageData>({ url: `/mui/crud/${table}`, method: 'get', params })
}

/** 新增一行，返回自增主键 */
export function createCrudRow(table: string, data: Record<string, unknown>) {
  return httpCgi<{ insertId: number }>({ url: `/mui/crud/${table}`, method: 'post', data })
}

/** 更新一行（按主键） */
export function updateCrudRow(table: string, id: string | number, data: Record<string, unknown>) {
  return httpCgi<{ changed: number }>({ url: `/mui/crud/${table}/${id}`, method: 'put', data })
}

/** 删除一行（按主键） */
export function deleteCrudRow(table: string, id: string | number) {
  return httpCgi<{ affected: number }>({ url: `/mui/crud/${table}/${id}`, method: 'delete' })
}
