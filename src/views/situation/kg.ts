/**
 * 前台（/situation）知识图谱类型与配色（本地副本 · 只读）
 *
 * 为什么本地再声明一份：/situation 是免登录前台、与后台 /mui 各自独立演进，
 * 约定「两端图谱组件及其类型定义不相互引用」；两份字段结构保持一致，
 * 口径的单一真实来源仍是后端 server/lib/knowledgeGraph.js，这里只保留前台用得到的部分。
 *
 * 八类节点与 key 语义（与后端严格一致）：
 *   satellite → sat_tle.norad_id（仅 PAYLOAD）/ rocket_body → sat_tle.norad_id（仅箭体）
 *   launch → launch_record.id / vehicle → launch_vehicle.id / site → launch_site.id
 *   owner → sat_owner.code / catalog → sat_catalog.id / constellation → sat_constellation.id
 * 节点 id 统一为 `type:key`。
 */

export type KgType =
  | 'satellite'
  | 'rocket_body'
  | 'launch'
  | 'vehicle'
  | 'site'
  | 'owner'
  | 'catalog'
  | 'constellation'

/** 八类节点的展示名 */
export const TYPE_LABELS: Record<KgType, string> = {
  satellite: '卫星',
  rocket_body: '箭体',
  launch: '发射记录',
  vehicle: '运载火箭',
  site: '发射场',
  owner: '国家/机构',
  catalog: '资料库条目',
  constellation: '星座'
}

/** 八类节点配色（与后台 /mui/kg 保持一致） */
export const TYPE_COLORS: Record<KgType, string> = {
  satellite: '#5aa9ff',
  rocket_body: '#a3e635',
  launch: '#f5b942',
  vehicle: '#ff7a45',
  site: '#4ade80',
  owner: '#b388ff',
  catalog: '#38d6d6',
  constellation: '#ff6ec7'
}

/** 图谱节点 */
export interface KgNode {
  id: string
  name: string
  type: KgType
  sub: string
  size: number
}

/** 图谱连线 */
export interface KgEdge {
  source: string
  target: string
  label: string
}

/** 中心节点 */
export interface KgCenter {
  id: string
  name: string
  type: KgType
  sub: string
}

/** 邻居展开结果（/cgi/kg/neighbors 下发） */
export interface KgNeighbors {
  center: KgCenter
  nodes: KgNode[]
  edges: KgEdge[]
  totals: Record<string, number>
  truncated: Record<string, boolean>
}