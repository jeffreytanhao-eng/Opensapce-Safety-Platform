/**
 * 表中文名映射（与系统模块命名保持一致，缺失的按同一风格补齐）
 * 菜单/顶栏以中文名为主展示，表名保留为副行（技术标识仍可查）。
 */
export const TABLE_NAMES: Record<string, string> = {
  // ---- 系统 ----
  sys_user: '用户管理',
  sys_role: '角色管理',
  sys_log: '操作日志',
  sys_message: '消息管理',
  sys_message_user: '用户消息',
  // ---- 内容 / 反馈 ----
  content_banner: '轮播图',
  contact_feedback: '问题反馈',
  contact_cooperation: '商业合作',
  // ---- 智能体 / AI ----
  ai_chat_log: '历史对话',
  ai_question_log: '用户提问记录',
  ai_gap_log: '平台遗漏数据',
  ai_download_log: '下载记录',
  // ---- 卫星基础 ----
  sat_tle: 'TLE管理',
  sat_tle_history: 'TLE历史',
  sat_aoe: 'AOE管理',
  sat_aoe_history: 'AOE历史',
  sat_aoe_sync_log: 'AOE同步日志',
  sat_catalog: '卫星资料库',
  sat_owner: '国家/机构管理',
  sat_payload: '卫星载荷明细',
  sat_sensor: '卫星载荷参数',
  sat_search_log: '卫星搜索日志',
  sat_sync_log: '同步日志',
  sat_space_weather: '空间环境指数',
  sat_manual_tle: '手动TLE',
  sat_manual_tle_aoe: '手动TLE(AOE)',
  sat_constellation: '星座管理',
  sat_constellation_sat: '星座成员',
  sat_constellation_log: '星座匹配日志',
  // ---- 碰撞预警（sat_conj*，国际库） ----
  sat_conj_run: '碰撞预警批次',
  sat_conj_run_aoe: '碰撞预警批次(AOE)',
  sat_conjunction: '碰撞事件',
  sat_conjunction_aoe: '碰撞事件(AOE)',
  sat_report: '碰撞报告',
  sat_report_aoe: '碰撞报告(AOE)',
  sat_cdm: 'TLE碰撞',
  sat_cdm_sync_log: 'CDM同步日志',
  // ---- 交会分析（sat_cri*，国际库） ----
  sat_cri_run: '交会分析批次',
  sat_cri_run_aoe: '交会分析批次(AOE)',
  sat_cri_conjunction: '交会事件',
  sat_cri_conjunction_aoe: '交会事件(AOE)',
  // ---- 联合分析（sat_joint*） ----
  sat_joint_conj_run: '碰撞联合分析',
  sat_joint_conj_pair: '碰撞联合配对',
  sat_joint_conj_report: '碰撞联合报告',
  sat_joint_cri_run: '交会联合分析',
  sat_joint_cri_pair: '交会联合配对',
  sat_joint_cri_report: '交会联合报告',
  sat_joint_health: '联合健康度',
  // ---- 覆盖模型 ----
  sat_cov_model: '覆盖模型',
  sat_cov_model_aoe: '覆盖模型(AOE)',
  // ---- 发射 ----
  launch_record: '发射记录',
  launch_payload: '发射载荷明细',
  launch_site: '发射站管理',
  launch_vehicle: '运载火箭管理',
  launch_upcoming: '即将发射',
  // ---- 过境分析 ----
  pass_geo: '地理信息',
  pass_region: '区域库',
  pass_region_scan: '区域过境',
  pass_region_access: '区域过境明细',
  pass_region_report: '过境报告',
  pass_multi_region: '多区域过境',
  pass_multi_region_scan: '多区域过境扫描',
  pass_multi_region_access: '多区域过境明细',
  pass_multi_region_report: '多区域过境报告',
  pass_scan_run: '过境计算记录',
  pass_info: '过境信息',
  pass_detail: '过境明细'
}

/** 取表中文名（未映射时回落为表名本身） */
export function tableName(name: string): string {
  return TABLE_NAMES[name] || name
}
