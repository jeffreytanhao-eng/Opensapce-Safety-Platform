-- ============================================================
-- openspace-safety-platform 空库自举表结构
-- 由旧库结构快照一次性生成，此后直接人工维护本文件
-- 启动时由 server/db/bootstrap.js 执行
-- 全部为 CREATE TABLE IF NOT EXISTS：可重复执行，已有表不受影响
-- ============================================================

-- ai_chat_log（旧库 481 行）
CREATE TABLE IF NOT EXISTS `ai_chat_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `scope` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'admin',
  `user_id` bigint DEFAULT '0',
  `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `ip` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `question` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `answer` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `tools` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `provider` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `model` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `rounds` int DEFAULT '0',
  `elapsed_ms` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `error` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次提问一行：提问、回答、工具调用轨迹与耗时；scope 区分后台(admin)与前台免登录(public)';

-- ai_question_log（旧库 423 行）
CREATE TABLE IF NOT EXISTS `ai_question_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `scope` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'admin',
  `user_id` bigint DEFAULT '0',
  `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `ip` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `question` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `tools` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `rounds` int DEFAULT '0',
  `elapsed_ms` int DEFAULT '0',
  `chat_id` bigint DEFAULT '0',
  `status` tinyint DEFAULT '0',
  `remark` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `answer` text COLLATE utf8mb4_unicode_ci,
  `req_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `rating` tinyint DEFAULT '0',
  `feedback` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `vote` tinyint DEFAULT '0',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='一次对话记一条（一问一条，成功/失败都记）：提问人 + 入口 + 原始提问 + 耗时/轮次/调用工具；status 为处理闭环';

-- ai_gap_log（旧库 62 行）
CREATE TABLE IF NOT EXISTS `ai_gap_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `scope` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'admin',
  `user_id` bigint DEFAULT '0',
  `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `ip` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `question` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `web_query` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `engine` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `engine_label` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `hit_count` int DEFAULT '0',
  `items` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `tried` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `chat_id` bigint DEFAULT '0',
  `status` tinyint DEFAULT '0',
  `remark` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='一次对话里调用 web_search（平台工具覆盖不到）即记一条：用户提问 + 检索词 + 命中的引擎 + 联网结果；status 为处理闭环';

-- ai_download_log（旧库 2 行）
CREATE TABLE IF NOT EXISTS `ai_download_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `scope` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'admin',
  `user_id` bigint DEFAULT '0',
  `username` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `ip` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `question` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tool` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `args` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `chat_id` bigint DEFAULT '0',
  `status` tinyint DEFAULT '0',
  `remark` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='对话里工具产出可下载产物（返回 url）即记一条：触发提问 + 工具 + 文件名 + 下载地址；status 为处理闭环';

-- contact_feedback（旧库 0 行）
CREATE TABLE IF NOT EXISTS `contact_feedback` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` int unsigned DEFAULT NULL COMMENT '提交人 id',
  `user_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '提交人展示名',
  `source` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'app' COMMENT '来源：app 前台 / mui 后台',
  `content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '反馈内容',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '提交时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='问题反馈';

-- contact_cooperation（旧库 1 行）
CREATE TABLE IF NOT EXISTS `contact_cooperation` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` int unsigned DEFAULT NULL COMMENT '提交人 id',
  `user_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '提交人展示名',
  `source` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'app' COMMENT '来源：app 前台 / mui 后台',
  `intent` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '我想要：可视化系统/数据服务/观测申请',
  `role` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '我是：卫星业主/卫星运营/保险金融行业/高校/咨询合作',
  `content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '补充说明',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '提交时间',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商业合作';

-- content_banner（旧库 1 行）
CREATE TABLE IF NOT EXISTS `content_banner` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `image` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `link` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='首页轮播图（前台 /cgi/home/banners 消费）';

-- launch_record（旧库 7432 行）
CREATE TABLE IF NOT EXISTS `launch_record` (
  `id` int NOT NULL AUTO_INCREMENT,
  `launch_tag` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'GCAT 发射代号（如 1958-F01 / 2026-225）',
  `launch_at` datetime DEFAULT NULL COMMENT 'UTC；时刻未知时为 00:00:00',
  `time_known` tinyint DEFAULT '1' COMMENT '部分早期发射仅有日期',
  `year` int DEFAULT NULL COMMENT '冗余年份，便于筛选统计',
  `vehicle` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT LV_Type 原文（如 Chang Zheng 2C）',
  `flight_id` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '火箭序列/飞行编号（如 Y13、M1-PS）',
  `site_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT 发射场代码（如 NIIP-5）',
  `site_name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT 发射场全名',
  `site_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '中文对照（launch_site 字典匹配 / 人工维护）',
  `pad` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '发射工位（如 LC-9A）',
  `country_code` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'sat_owner.code（ISO 二字码），旗帜展示',
  `agency_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT 机构代码',
  `agency` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT orgs 目录映射的机构名',
  `outcome` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'unknown' COMMENT '发射成败（GCAT Laun：OS/DS=成功，OF/DF=失败）',
  `payload_count` int DEFAULT '1' COMMENT '本次发射的载荷数量',
  `payload_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '载荷名称串（顿号分隔，明细见 launch_payload 表）',
  `jcat` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT 主载荷目录号',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '人工备注（同步不覆盖）',
  `source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'GCAT' COMMENT '数据来源（GCAT / 手工）',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_launch_tag` (`launch_tag`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='1957 至今全球轨道发射记录（GCAT）：时间/火箭/发射场/载荷/成败';

-- launch_payload（旧库 31887 行）
CREATE TABLE IF NOT EXISTS `launch_payload` (
  `id` int NOT NULL AUTO_INCREMENT,
  `record_id` int NOT NULL COMMENT 'launch_record.id',
  `name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '载荷名称',
  `jcat` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT 载荷目录号（唯一）',
  `owner` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '拥有者（GCAT 代码）',
  `state_code` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '载荷所属国家/地区（GCAT 码）',
  `type_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'GCAT Type 状态码',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_jcat` (`jcat`) USING BTREE,
  KEY `idx_record` (`record_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='发射载荷明细（GCAT，每载荷一行）';

-- launch_site（旧库 75 行）
CREATE TABLE IF NOT EXISTS `launch_site` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '如 拜科努尔发射场',
  `name_en` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '如 Baikonur Cosmodrome',
  `codes` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'GCAT 发射场代码（逗号分隔），关联「发射记录」site_code',
  `country_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'sat_owner.code（ISO 3166-1 alpha-2），用于旗帜与国名展示',
  `lat` decimal(10,6) DEFAULT NULL COMMENT '北纬为正（WGS84）',
  `lon` decimal(10,6) DEFAULT NULL COMMENT '东经为正（WGS84）',
  `site_type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'land' COMMENT '海上平台坐标取母港或典型作业区',
  `status` tinyint DEFAULT '1' COMMENT '现役 / 退役（历史发射场）',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '承担任务、运营方、启用年份等',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全球航天发射场字典：中英文名 + 归属国（sat_owner.code）+ 经纬度 + 类型（陆基/海上）+ 状态';

-- launch_vehicle（旧库 332 行）
CREATE TABLE IF NOT EXISTS `launch_vehicle` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '如 长征二号丙；构型/变体直接写全名如 CZ-2C/YZ-1S',
  `sub_type` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '如 CZ-2D（构型一）；无子型号留空',
  `name_en` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '如 Long March 2C',
  `agency` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '如 中国运载火箭技术研究院、SpaceX、ESA',
  `country_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'sat_owner.code（欧洲=EU、中国台湾=CN_TW）；苏联时期型号归 RU 并在备注注明',
  `leo_t` decimal(8,3) DEFAULT NULL COMMENT '近地轨道典型运力，取范围下限',
  `gto_t` decimal(8,3) DEFAULT NULL COMMENT '同步转移轨道典型运力',
  `sso_t` decimal(8,3) DEFAULT NULL COMMENT '太阳同步轨道典型运力',
  `payload_note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '范围/构型/轨道高度等补充口径，如「10-15（视构型）」',
  `status` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'dev' COMMENT '现役/退役/在研/已取消',
  `codes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'GCAT 发射记录中该型号的原文（逗号分隔），关联「发射记录」vehicle',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '首飞时间、备注等',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全球运载火箭字典：名称/子型号 + 英文名 + 研发机构 + 归属国（sat_owner.code）+ LEO/GTO/SSO 运力 + 服役情况';

-- launch_upcoming（旧库 477 行）
CREATE TABLE IF NOT EXISTS `launch_upcoming` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ll2_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Launch Library 2 发射记录 UUID（同步唯一键）',
  `slug` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 人类可读标识（如 falcon-9-block-5-crew-13）',
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'LL2 名称（火箭 | 任务）',
  `net` datetime DEFAULT NULL COMMENT 'NET 计划发射时刻（UTC）',
  `net_precision` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 net_precision（Second/Minute/Hour/Day/Month/Quarter/Year）',
  `window_start` datetime DEFAULT NULL,
  `window_end` datetime DEFAULT NULL,
  `status_name` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 状态名（如 Go for Launch）',
  `status_abbrev` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 状态简称（Go/TBD/TBC/Hold 等）',
  `probability` int DEFAULT NULL COMMENT '气象/条件发射概率，可能为空',
  `provider` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 launch_service_provider 名称',
  `provider_abbrev` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '机构简称（如 SpaceX）',
  `provider_country` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 机构国别码（ISO 三字码，如 USA / CHN）',
  `rocket` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 rocket.configuration.name',
  `rocket_family` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 rocket.configuration.family',
  `mission_name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 mission.name',
  `mission_type` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 mission.type（如 Communications / Human Exploration）',
  `orbit` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 mission.orbit.abbrev（LEO/GTO/SSO 等）',
  `pad` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 pad.name',
  `pad_location` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 pad.location.name',
  `country_code` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 pad.country_code',
  `pad_lat` decimal(10,6) DEFAULT NULL COMMENT 'LL2 pad.latitude',
  `pad_lon` decimal(10,6) DEFAULT NULL COMMENT 'LL2 pad.longitude',
  `image` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 任务配图 URL',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'LL2 mission.description',
  `info_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'LL2 原始记录 API 地址',
  `last_updated` datetime DEFAULT NULL COMMENT 'LL2 last_updated',
  `synced_at` datetime DEFAULT NULL COMMENT '本地写入时间（UTC）',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '人工备注（同步不覆盖）',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `site_id` int DEFAULT NULL COMMENT '匹配到的 launch_site.id（机器列，同步不覆盖）',
  `site_name_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '匹配到的发射站中文名（冗余，随匹配写入；同步不覆盖）',
  `site_match` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '发射站匹配来源：coord 坐标 / text 名称 / manual 人工',
  `site_country_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '所在国本系统国家码（sat_owner.code，如 CN/US）',
  `site_country_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '所在国中文名（sat_owner.name_cn，随推算写入；同步不覆盖）',
  `country_match` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '所在国推算来源：site 发射站所属国 / ll2 国别兜底 / manual 人工',
  `name_cn` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'name 的中文译文（翻译写入；同步不覆盖）',
  `status_name_cn` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'status_name 的中文译文（枚举词典优先）',
  `rocket_cn` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'rocket 的中文译文',
  `provider_cn` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'provider 的中文译文',
  `mission_name_cn` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'mission_name 的中文译文',
  `mission_type_cn` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'mission_type 的中文译文（枚举词典优先）',
  `orbit_cn` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'orbit 的中文译文（枚举词典优先）',
  `pad_cn` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'pad 的中文译文',
  `pad_location_cn` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'pad_location 的中文译文（已关联发射站时直取其中文名）',
  `description_cn` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'description 的中文译文',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_ll2_id` (`ll2_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全球即将发射计划（Launch Library 2）：发射时间/状态/火箭/任务/发射场/概率';

-- pass_geo（旧库 1876 行）
CREATE TABLE IF NOT EXISTS `pass_geo` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `geo_type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'border=国界多边形 / city=城市点',
  `feature_key` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '去重键：border:<ISO A3> / city:<英文名>|<经度>|<纬度>',
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `name_en` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `country` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `iso_a2` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `longitude` double DEFAULT NULL COMMENT '城市点坐标；国界取几何外接框中心',
  `latitude` double DEFAULT NULL,
  `population` bigint DEFAULT NULL COMMENT '城市人口（pop_max）；国界为空',
  `featureclass` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'Natural Earth featureclass（首都/省会等）',
  `geom` json DEFAULT NULL COMMENT '国界多环坐标 [[[lon,lat],...],...]；城市为空',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `name_cn` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '内置词典生成（server/lib/geoNameCn.js）：政区 177/177 全覆盖；城市命中 506 条，其中「首都或人口>=100万」的 395 座主要城市 100% 覆盖，其余为空',
  `adcode` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '仅 district：国标 6 位行政区划代码（如 440100 广州市）',
  `level` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '仅 district：city=地级市 / province=直辖市港澳台整体',
  `province` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '仅 district：所属省级政区名',
  `province_adcode` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '仅 district：所属省级政区代码',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_feature_key` (`feature_key`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='全球国界与城市标注（Natural Earth 110m/50m，供三维地球绘制与过境分析定位）';

-- pass_region（旧库 12 行）
CREATE TABLE IF NOT EXISTS `pass_region` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `polygon` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'JSON 数组 [[lon,lat],...]（外环，简单多边形）；列表与详情接口都返回（后台表格不展示该列，编辑回显与前台「选已存区域」需要）',
  `point_count` int DEFAULT '0' COMMENT '多边形顶点个数（前端按顶点串算出）',
  `center_lon` double NOT NULL DEFAULT '0' COMMENT '顶点单位向量平均（跨越经度 ±180 时亦稳定）',
  `center_lat` double NOT NULL DEFAULT '0' COMMENT '顶点单位向量平均',
  `radius_km` double NOT NULL DEFAULT '0' COMMENT '中心到最远顶点的球面大圆距离，供星下点粗筛（宁可偏大不可偏小）',
  `area_km2` double DEFAULT '0' COMMENT '球面多边形面积（球面近似），仅作展示与量级判断',
  `remark` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '区域用途、数据来源等说明',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='三维地球框选的多边形区域（顶点 + 包围中心 / 外接半径 / 面积），供区域过境按带扫描';

-- pass_region_scan（旧库 2 行）
CREATE TABLE IF NOT EXISTS `pass_region_scan` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `region_id` bigint DEFAULT '0' COMMENT 'pass_region.id；临时框选（未存区域）为 0',
  `region_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `center_lon` double DEFAULT '0',
  `center_lat` double DEFAULT '0',
  `area_km2` double DEFAULT '0',
  `total_sats` int DEFAULT '0',
  `failed` int DEFAULT '0',
  `skipped_no_sensor` int DEFAULT '0' COMMENT 'TLE 库中未匹配到 sat_sensor 载荷参数、默认不参与判定的卫星数',
  `total_passes` int DEFAULT '0' COMMENT '去重后的 access 总数',
  `saved` int DEFAULT '0',
  `window_hours` int DEFAULT '24',
  `step_sec` int DEFAULT '120',
  `refine_sec` int DEFAULT '10',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1' COMMENT '0=进行中 1=成功 2=失败',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_by` bigint DEFAULT '0' COMMENT '0=系统/定时任务',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `default_swath_km` double DEFAULT '0' COMMENT '本次扫描给「缺参数卫星」用的兜底幅宽；0 = 未启用兜底（缺参数的星不参与）。明细行按此值参与，并标 sensor_missing=1',
  `default_roll_deg` double DEFAULT '0' COMMENT '本次扫描给「缺参数卫星」用的兜底最大侧摆角',
  `polygon` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '本次扫描所用区域的顶点 JSON [[经度,纬度],...]（临时框选同样落库），供结果回显区域轮廓',
  `start_ms` bigint DEFAULT NULL COMMENT '本次扫描的提交时刻 = 预报窗口起点（UTC 毫秒）；报告据此声明数据时间范围，不重算',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次区域过境现算的运行统计（保留最近 50 批）';

-- pass_region_access（旧库 9507 行）
CREATE TABLE IF NOT EXISTS `pass_region_access` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL DEFAULT '0' COMMENT '关联 pass_region_scan.id',
  `region_id` bigint DEFAULT '0' COMMENT 'pass_region.id；临时框选为 0',
  `norad_id` int NOT NULL,
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `swath_km` double DEFAULT '0',
  `max_roll_deg` double DEFAULT '0',
  `half_width_km` double DEFAULT '0' COMMENT '幅宽/2 + 侧摆可达地面偏移',
  `sensor_missing` tinyint DEFAULT '0' COMMENT '1=未匹配到 sat_sensor 载荷参数，按星下点估算',
  `aos_ms` bigint NOT NULL,
  `los_ms` bigint DEFAULT '0',
  `duration_sec` int DEFAULT '0',
  `min_dist_km` double DEFAULT '0' COMMENT '窗口内星下点到区域边界的最短地面距离',
  `required_roll_deg` double DEFAULT '0' COMMENT '该次过境所需最小侧摆角；0=星下点直接扫到',
  `coverage_pct` double DEFAULT NULL COMMENT '基于 N×N 网格采样的累积覆盖率，仅作展示/过滤',
  `max_cover_at_ms` bigint DEFAULT NULL,
  `sample_total` int DEFAULT '0',
  `sample_covered` int DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `frame_offset_km` double DEFAULT NULL COMMENT '单帧足迹中心相对星下点的横向偏移 = rollOffsetKm(本次所需侧摆, 轨道高度)',
  `tle_line1` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '扫描当时所用的根数快照（报告只读快照排版，绝不用当前 TLE 重算）',
  `tle_line2` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_epoch_ms` bigint DEFAULT NULL,
  `sun_elev_deg` double DEFAULT NULL COMMENT '区域中心在最佳覆盖时刻的太阳高度角；区域过境是「卫星拍地面」，判据是地面是否被太阳照亮',
  `twilight` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'day / civil / nautical / astronomical / night（按区域中心太阳高度 -0.833/-6/-12/-18° 分档）',
  `ground_lit` tinyint DEFAULT '0' COMMENT '1=区域中心太阳在地平线以上（白天侧）',
  `optical_ok` tinyint DEFAULT '0' COMMENT '1=区域中心太阳高度 ≥ 10°（斜射轻、阴影短），适合光学成像；0=需 SAR/夜光或另选窗口',
  `sat_shadow_state` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'sunlit / penumbra / umbra：卫星自身是否在地影（供电/热控参考，不参与成像判定）',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_run_norad_aos` (`run_id`,`norad_id`,`aos_ms`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE,
  KEY `idx_region_id` (`region_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='区域过境现算的 access 明细（每次扫描按 run_id 归属批次，保留最近 50 批）';

-- pass_region_report（旧库 5 行）
CREATE TABLE IF NOT EXISTS `pass_region_report` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `report_no` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `scope` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'run' COMMENT 'run=批次级（区域内全部过境）；pass=单条级（某一颗星的某一次过境）',
  `run_id` bigint NOT NULL DEFAULT '0' COMMENT '关联 pass_region_scan.id',
  `access_id` bigint DEFAULT '0' COMMENT 'scope=pass 时关联 pass_region_access.id；批次级为 0',
  `region_id` bigint DEFAULT '0' COMMENT 'pass_region.id；临时框选为 0',
  `region_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `center_lon` double DEFAULT '0',
  `center_lat` double DEFAULT '0',
  `area_km2` double DEFAULT '0',
  `norad_id` int DEFAULT '0' COMMENT 'scope=pass 时的目标卫星；批次级为 0',
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `window_hours` int DEFAULT '24',
  `start_ms` bigint DEFAULT NULL COMMENT '取扫描批次的提交时刻，报告据此声明数据时间范围',
  `aos_ms` bigint DEFAULT NULL COMMENT 'scope=pass 时的入境时刻；批次级为该批次最早入境时刻',
  `los_ms` bigint DEFAULT NULL,
  `pass_count` int DEFAULT '0',
  `sat_count` int DEFAULT '0',
  `best_coverage` double DEFAULT NULL,
  `coverage_avg` double DEFAULT NULL,
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_size` int DEFAULT '0',
  `payload_json` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_scope_id` (`scope`,`id`) USING BTREE,
  KEY `idx_run` (`run_id`) USING BTREE,
  KEY `idx_access` (`access_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='区域过境分析报告（docx 产物 + 生成状态 + 扫描快照指针）';

-- pass_multi_region（旧库 1 行）
CREATE TABLE IF NOT EXISTS `pass_multi_region` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `areas` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'JSON 数组：[{ name, region_id, polygon, center_lon, center_lat, radius_km, area_km2 }]，内嵌顶点以保证「同一组合的扫描口径不随区域库改动而漂移」',
  `area_count` int DEFAULT '0',
  `vertex_total` int DEFAULT '0',
  `area_km2_total` double DEFAULT '0',
  `remark` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_by` bigint DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多区域组合（一次扫描覆盖的多个区域；顶点内嵌，同时保留来源区域库 id）';

-- pass_multi_region_scan（旧库 4 行）
CREATE TABLE IF NOT EXISTS `pass_multi_region_scan` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `multi_region_id` bigint DEFAULT '0' COMMENT 'pass_multi_region.id；临时框选为 0',
  `multi_region_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `area_count` int DEFAULT '0',
  `areas_json` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '本次扫描实际使用的区域定义（含顶点与派生参数），供进度回显与报告溯源，绝不重算',
  `total_sats` int DEFAULT '0',
  `failed` int DEFAULT '0',
  `skipped_no_sensor` int DEFAULT '0',
  `default_swath_km` double DEFAULT '0' COMMENT '0 = 未启用缺参数兜底',
  `default_roll_deg` double DEFAULT '0',
  `total_passes` int DEFAULT '0',
  `saved` int DEFAULT '0',
  `window_hours` int DEFAULT '24',
  `start_ms` bigint DEFAULT NULL COMMENT '本次扫描提交时刻 = 预报窗口起点（UTC 毫秒）；报告据此声明数据时间范围，不重算',
  `step_sec` int DEFAULT '120',
  `refine_sec` int DEFAULT '10',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1' COMMENT '0=进行中 1=成功 2=失败',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_by` bigint DEFAULT '0' COMMENT '0=系统/前台免登录',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次多区域过境现算的运行统计（保留最近 30 批）';

-- pass_multi_region_access（旧库 6655 行）
CREATE TABLE IF NOT EXISTS `pass_multi_region_access` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL DEFAULT '0',
  `area_index` int NOT NULL DEFAULT '0' COMMENT '在本次区域快照中的下标（0 基），与 area_name 一起定位是哪个区域',
  `area_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `region_id` bigint DEFAULT '0' COMMENT 'pass_region.id；临时框选为 0',
  `norad_id` int NOT NULL,
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sensor_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `swath_km` double DEFAULT '0',
  `max_roll_deg` double DEFAULT '0',
  `half_width_km` double DEFAULT '0',
  `sensor_missing` tinyint DEFAULT '0',
  `aos_ms` bigint NOT NULL,
  `los_ms` bigint DEFAULT '0',
  `duration_sec` int DEFAULT '0',
  `min_dist_km` double DEFAULT '0',
  `required_roll_deg` double DEFAULT '0',
  `coverage_pct` double DEFAULT NULL COMMENT '单帧最大同时覆盖（帧步长 15s），口径与区域过境一致',
  `max_cover_at_ms` bigint DEFAULT NULL,
  `sample_total` int DEFAULT '0',
  `sample_covered` int DEFAULT '0',
  `frame_offset_km` double DEFAULT NULL,
  `sun_elev_deg` double DEFAULT NULL,
  `twilight` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ground_lit` tinyint DEFAULT '0',
  `optical_ok` tinyint DEFAULT '0',
  `sat_shadow_state` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tle_line1` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '扫描当时根数快照（报告只读快照排版）',
  `tle_line2` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_epoch_ms` bigint DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_run_area_norad_aos` (`run_id`,`area_index`,`norad_id`,`aos_ms`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE,
  KEY `idx_area` (`run_id`,`area_index`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多区域过境现算的 access 明细（按 run_id 归属批次，保留最近 30 批）';

-- pass_multi_region_report（旧库 0 行）
CREATE TABLE IF NOT EXISTS `pass_multi_region_report` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `report_no` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `scan_id` bigint NOT NULL DEFAULT '0' COMMENT 'pass_multi_region_scan.id',
  `multi_region_id` bigint DEFAULT '0',
  `multi_region_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `area_count` int DEFAULT '0',
  `total_passes` int DEFAULT '0',
  `note` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `csv_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_size` int DEFAULT '0',
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多区域过境 docx 报告（按扫描批次快照排版，含各区域地图与汇总图表）';

-- pass_scan_run（旧库 27 行）
CREATE TABLE IF NOT EXISTS `pass_scan_run` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `total_cities` int DEFAULT '0',
  `total_sats` int DEFAULT '0',
  `failed` int DEFAULT '0',
  `with_pass` int DEFAULT '0',
  `total_passes` int DEFAULT '0',
  `saved` int DEFAULT '0',
  `window_hours` int DEFAULT '24',
  `step_sec` int DEFAULT '120',
  `min_elev` double DEFAULT '10',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `detail_saved` int DEFAULT '0',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次全城过境汇总的运行统计（多批次共存，保留最近 30 批）';

-- pass_info（旧库 14950 行）
CREATE TABLE IF NOT EXISTS `pass_info` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `city_id` bigint NOT NULL COMMENT '关联 pass_geo.id（geo_type=city）',
  `city_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `country` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `longitude` double DEFAULT NULL,
  `latitude` double DEFAULT NULL,
  `total_passes` int DEFAULT '0' COMMENT '未来 24h 内最大仰角≥10° 的过境次数',
  `visible_sats` int DEFAULT '0' COMMENT '至少有一次可见过境的载荷卫星数',
  `best_sat_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `best_norad` int DEFAULT NULL,
  `best_start_at` datetime DEFAULT NULL COMMENT '最大仰角出现时刻',
  `best_max_elev` double DEFAULT NULL,
  `hour_dist` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '24 个整数（逗号分隔），按预报窗口起点的第 0~23 小时分桶',
  `window_hours` int DEFAULT '24',
  `computed_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `name_en` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '英文原名（pass_geo.name）',
  `run_id` bigint NOT NULL DEFAULT '0' COMMENT '关联 pass_scan_run.id（数据批次），复合唯一键 run_id + city_id',
  `geo_type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'district=中国行政区划面 / border=其他国家国界面',
  `adcode` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '中国行政区划的 adcode（国界面为空）',
  `level` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'city=地级市 / province=省级整体（直辖市、港澳台无市级下级数据时退化为整省） / 国界面为空',
  `province` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '中国行政区划所属省级名称（国界面为空）',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_run_city` (`run_id`,`city_id`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='各城市未来 24 小时过境汇总（定时任务预计算；明细点击城市时实时计算，不入库）';

-- pass_detail（旧库 4139200 行）
CREATE TABLE IF NOT EXISTS `pass_detail` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `city_id` bigint NOT NULL,
  `norad_id` int NOT NULL,
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `aos_ms` bigint NOT NULL,
  `los_ms` bigint DEFAULT '0',
  `duration_sec` int DEFAULT '0',
  `max_elev` double DEFAULT '0',
  `max_at_ms` bigint DEFAULT '0',
  `max_az` double DEFAULT '0',
  `min_range` int DEFAULT '0',
  `computed_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `run_id` bigint NOT NULL DEFAULT '0' COMMENT '关联 pass_scan_run.id；多批次共存，保留最近 30 批',
  `shadow_state` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'sunlit=被太阳照亮 / penumbra=地球半影 / umbra=地球本影（日影，光学不可见）',
  `sunlit_fraction` double DEFAULT NULL COMMENT '0=全黑 / 1=全照；半影区内线性过渡',
  `phase_angle` double DEFAULT NULL COMMENT '目标-太阳-观测者夹角，0°=看到被照亮的一面，180°=只见背光面',
  `sun_elev` double DEFAULT NULL COMMENT '观测点太阳高度角，判断是否夜天光',
  `twilight` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'day / civil / nautical / astronomical / night（按太阳高度 -0.833/-6/-12/-18° 分档）',
  `moon_illum` double DEFAULT NULL COMMENT '月亮被照亮比例，0=新月 1=满月',
  `moon_sep` double DEFAULT NULL COMMENT '观测点看目标与月亮的夹角，越小月光干扰越大',
  `moon_bg` double DEFAULT NULL COMMENT '0~1 工程启发式（月亮在地平线下为 0），用于排序观测适宜度，非定量信噪比',
  `optical_ok` tinyint DEFAULT '0' COMMENT '1=目标被照亮 且 观测站为天文夜 且 月光背景低，可供光学成像',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_run_city_norad_aos` (`run_id`,`city_id`,`norad_id`,`aos_ms`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE,
  KEY `idx_run_city` (`run_id`,`city_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='各城未来 24h 过境明细（汇总任务按 5s 精修预计算落库，前台点击城市直接读表）';

-- sat_tle（旧库 35672 行）
CREATE TABLE IF NOT EXISTS `sat_tle` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `norad_id` int NOT NULL,
  `object_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `intl_desig` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `regime` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `epoch` datetime DEFAULT NULL,
  `mean_motion` double DEFAULT NULL,
  `mean_motion_dot` double DEFAULT NULL,
  `ecc` double DEFAULT NULL,
  `incl` double DEFAULT NULL,
  `raan` double DEFAULT NULL,
  `arg_perigee` double DEFAULT NULL,
  `mean_anomaly` double DEFAULT NULL,
  `bstar` double DEFAULT NULL,
  `rev_num` int DEFAULT '0',
  `period` double DEFAULT NULL,
  `semimajor_axis` double DEFAULT NULL,
  `apogee` double DEFAULT NULL,
  `perigee` double DEFAULT NULL,
  `tle_line1` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_line2` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `decay_date` datetime DEFAULT NULL,
  `is_active` tinyint DEFAULT '1',
  `source` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'space-track',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `owner_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '归一化到 sat_owner.code（同步取 Space-Track COUNTRY_CODE，prc 等别名按字典归一）',
  `purpose_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '资料库匹配写入（10 类码，见 lib/satCatalogMatch.js 的 PURPOSE_TYPES）',
  `launch_site` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '本地发射记录按国际编号前缀补全，缺失时兜底 Space-Track satcat 场地码',
  `catalog_id` int DEFAULT NULL COMMENT '匹配命中的 sat_catalog.id',
  `match_source` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'auto=资料库匹配 / manual=管理员手改（手工行不再被匹配覆盖）',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_id` (`norad_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Space-Track 在轨物体最新根数（每星一行，含原始 TLE 与解析字段）';

-- sat_tle_history（旧库 2062251 行）
CREATE TABLE IF NOT EXISTS `sat_tle_history` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `norad_id` int NOT NULL,
  `object_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `intl_desig` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `regime` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `epoch` datetime DEFAULT NULL,
  `mean_motion` double DEFAULT NULL,
  `mean_motion_dot` double DEFAULT NULL,
  `ecc` double DEFAULT NULL,
  `incl` double DEFAULT NULL,
  `raan` double DEFAULT NULL,
  `arg_perigee` double DEFAULT NULL,
  `mean_anomaly` double DEFAULT NULL,
  `bstar` double DEFAULT NULL,
  `rev_num` int DEFAULT '0',
  `period` double DEFAULT NULL,
  `semimajor_axis` double DEFAULT NULL,
  `apogee` double DEFAULT NULL,
  `perigee` double DEFAULT NULL,
  `tle_line1` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_line2` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `decay_date` datetime DEFAULT NULL,
  `owner_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '归档主表当次同步的编目国代码（与 sat_owner 字典对齐）',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_epoch` (`norad_id`,`epoch`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TLE 历史版本（同步时被覆盖的旧根数自动归档）';

-- sat_aoe（旧库 19308 行）
CREATE TABLE IF NOT EXISTS `sat_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `norad_id` int NOT NULL,
  `object_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `intl_desig` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `regime` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `epoch` datetime DEFAULT NULL,
  `mean_motion` double DEFAULT NULL,
  `mean_motion_dot` double DEFAULT NULL,
  `ecc` double DEFAULT NULL,
  `incl` double DEFAULT NULL,
  `raan` double DEFAULT NULL,
  `arg_perigee` double DEFAULT NULL,
  `mean_anomaly` double DEFAULT NULL,
  `bstar` double DEFAULT NULL,
  `rev_num` int DEFAULT '0',
  `period` double DEFAULT NULL,
  `semimajor_axis` double DEFAULT NULL,
  `apogee` double DEFAULT NULL,
  `perigee` double DEFAULT NULL,
  `tle_line1` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_line2` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `channel` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'KY',
  `constellation_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `raw_json` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `is_active` tinyint DEFAULT '1',
  `source` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'aoe',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `owner_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'AOE 上游无此字段：按 NORAD 从 sat_tle 借用并归一化到 sat_owner.code',
  `purpose_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '资料库匹配写入（10 类码，见 lib/satCatalogMatch.js 的 PURPOSE_TYPES）',
  `launch_site` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '按 NORAD 从 sat_tle 借用（本地发射记录 / satcat 兜底）',
  `catalog_id` int DEFAULT NULL COMMENT '匹配命中的 sat_catalog.id',
  `match_source` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'auto=资料库匹配 / manual=管理员手改',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_id` (`norad_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AOE库（spacemapper.cn）在轨目标最新根数（每目标一行，含原始 TLE 与解析字段）';

-- sat_aoe_history（旧库 101783 行）
CREATE TABLE IF NOT EXISTS `sat_aoe_history` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `norad_id` int NOT NULL,
  `object_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `intl_desig` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `regime` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `epoch` datetime DEFAULT NULL,
  `mean_motion` double DEFAULT NULL,
  `mean_motion_dot` double DEFAULT NULL,
  `ecc` double DEFAULT NULL,
  `incl` double DEFAULT NULL,
  `raan` double DEFAULT NULL,
  `arg_perigee` double DEFAULT NULL,
  `mean_anomaly` double DEFAULT NULL,
  `bstar` double DEFAULT NULL,
  `rev_num` int DEFAULT '0',
  `period` double DEFAULT NULL,
  `semimajor_axis` double DEFAULT NULL,
  `apogee` double DEFAULT NULL,
  `perigee` double DEFAULT NULL,
  `tle_line1` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_line2` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `channel` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'KY',
  `constellation_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `raw_json` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_epoch` (`norad_id`,`epoch`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AOE 轨道历史版本（同步时被覆盖的旧根数自动归档）';

-- sat_aoe_sync_log（旧库 35 行）
CREATE TABLE IF NOT EXISTS `sat_aoe_sync_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `channel` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'KY',
  `total` int DEFAULT '0',
  `inserted` int DEFAULT '0',
  `updated` int DEFAULT '0',
  `unchanged` int DEFAULT '0',
  `decayed` int DEFAULT '0',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AOE 轨道清单同步日志（每次同步的统计与结果）';

-- sat_catalog（旧库 3948 行）
CREATE TABLE IF NOT EXISTS `sat_catalog` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '卫星系列/条目名（引导页「卫星」列），如 中星卫星',
  `name_en` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文名/代号（引导页「英文名称」列），如 ZX',
  `aliases` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'JSON 大写数组，用于与 sat_tle.object_name 对照匹配；语义：`=` 前缀=全名相等，`~` 前缀=词边界匹配（2–3 字符短代号用），其余=子串包含；管理员可手工增删（种子不覆盖已存在行），可用「匹配预览」核对是否过宽/过窄',
  `purpose_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `country_code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'sat_owner.code（苏联记 RU）',
  `agency` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「研发机构」列（可能多个，原文保留）',
  `orbit_type` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「轨道类型」列原文，如 LEO / GEO（多数为空）',
  `launch_date` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「发射日期」列原文（多为空，故按字符串存）',
  `intl_desig` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「国际卫星标识符」列原文（多为空）',
  `source` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'huiji',
  `source_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页 URL，便于回溯核对',
  `status` tinyint DEFAULT '1' COMMENT '禁用后不参与匹配',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '未映射的 wiki 原始国名等说明',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `nature` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「性质」列原文（如 载人飞船／航天飞机／载人月球着陆器／载人飞船（登月舱））',
  `mission_type` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「任务类型」列原文（如 深空探测（月球）／深空探测（火星））',
  `rocket` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '引导页「运载火箭」列原文',
  `service_status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '服役/任务状态原文（型号级用 现役/在研/退役/已取消；逐次任务用 成功/进行中/已退役）',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_country_purpose_name` (`country_code`,`purpose_type`,`name_cn`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='卫星系列/条目资料字典 + 别名库（用途类型/归属国/研发机构/轨道类型 + 对照匹配关键词）';

-- sat_owner（旧库 316 行）
CREATE TABLE IF NOT EXISTS `sat_owner` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '编目代码',
  `aliases` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '别名代码',
  `name_cn` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '中文名',
  `name_en` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文名',
  `type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'country' COMMENT '类型 country/org/other',
  `flag` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '旗帜图',
  `sort` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_code` (`code`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='卫星编目国/机构';

-- sat_payload（旧库 353 行）
CREATE TABLE IF NOT EXISTS `sat_payload` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `norad_id` int NOT NULL COMMENT '一行一颗卫星（唯一）；区域过境按此精确取值',
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '同步时取自 sat_tle.object_name（各进程加载顺序按 norad_id 排序，口径与过境算法一致）',
  `sensor_id` bigint DEFAULT '0' COMMENT 'sat_sensor.id；0 = 未归属型号（手工维护的行可能出现）',
  `sensor_code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT 'sat_sensor.code（稳定标识，如 gf1_wfv），便于与型号表对照',
  `sensor_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `swath_km` double NOT NULL DEFAULT '0' COMMENT '同步时从型号模板带入，可针对本星单独调整（改后请把本行来源改为「手工」，避免被下次同步覆盖）',
  `max_roll_deg` double NOT NULL DEFAULT '0' COMMENT '同步时从型号模板带入，可针对本星单独调整；0 = 无侧摆机构',
  `sensor_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'optical',
  `source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual' COMMENT 'auto=由型号模板同步生成（同步时会跟着模板刷新）；manual=手工维护（同步时保留不覆盖）',
  `synced_at` datetime DEFAULT NULL COMMENT '最近一次由模板同步写入/刷新的时间；手工行不写',
  `remark` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_id` (`norad_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='一行一颗卫星的载荷参数（NORAD 唯一）：幅宽 / 最大侧摆 / 归属型号，可同步生成也可逐颗手工维护';

-- sat_sensor（旧库 85 行）
CREATE TABLE IF NOT EXISTS `sat_sensor` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'seed 幂等去重键（如 sentinel2_msi / gf1_wfv），同类载荷保持不变',
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `keywords` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'JSON 数组（大写），命中 sat_tle.object_name 即套用本行参数；如 ["GAOFEN-1","GF-1"]',
  `swath_km` double NOT NULL DEFAULT '0' COMMENT '成像幅宽（多台相机组合 / 多模式取最宽值，口径见备注）',
  `max_roll_deg` double NOT NULL DEFAULT '0' COMMENT '最大侧摆角（滚转）；0 = 无侧摆机构，只能星下点成像。SAR 按入射角范围换算等效侧摆',
  `altitude_km` double DEFAULT NULL COMMENT '标称轨道高度，仅作参考（带宽换算用真实轨道高度，不读本列）',
  `sensor_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'optical' COMMENT 'optical=光学 / sar=合成孔径雷达 / other=其他',
  `source_url` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '公开资料链接（官方运营方 / 官方任务页优先）',
  `remark` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '口径差异、各模式幅宽、机动能力等说明',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_code` (`code`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='卫星载荷幅宽 / 最大侧摆角 / 标称轨道高度（区域过境扫描的带模型参数，附公开来源链接）';

-- sat_search_log（旧库 154 行）
CREATE TABLE IF NOT EXISTS `sat_search_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `keyword` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` bigint DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `module` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'tle',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户在卫星检索页的搜索关键词记录，聚合后用于「经常搜索」推荐';

-- sat_sync_log（旧库 120 行）
CREATE TABLE IF NOT EXISTS `sat_sync_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `source` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'space-track',
  `total` int DEFAULT '0',
  `inserted` int DEFAULT '0',
  `updated` int DEFAULT '0',
  `unchanged` int DEFAULT '0',
  `decayed` int DEFAULT '0',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Space-Track 同步日志（每次同步的统计与结果）';

-- sat_space_weather（旧库 2339 行）
CREATE TABLE IF NOT EXISTS `sat_space_weather` (
  `date` date NOT NULL,
  `f107_obs` double DEFAULT NULL COMMENT '10.7cm 太阳射电通量，太阳极紫外辐射的水平指标',
  `f107_adj` double DEFAULT NULL COMMENT '归一化到 1 AU 的调整值，大气密度模型的标准输入',
  `f107_center81` double DEFAULT NULL COMMENT '分层常用的平滑量，抑制逐日抖动',
  `kp_max` double DEFAULT NULL COMMENT '当日 8 个 3 小时时段的 Kp 最大值（0~9），决定极光椭圆环大小',
  `kp1` double DEFAULT NULL,
  `kp2` double DEFAULT NULL,
  `kp3` double DEFAULT NULL,
  `kp4` double DEFAULT NULL,
  `kp5` double DEFAULT NULL,
  `kp6` double DEFAULT NULL,
  `kp7` double DEFAULT NULL,
  `kp8` double DEFAULT NULL,
  `ap_avg` int DEFAULT NULL COMMENT '地磁活动日等效幅度指数（由 Kp 换算的线性量）',
  `sunspot` double DEFAULT NULL COMMENT 'ISN 国际太阳黑子数',
  `data_type` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'OBS=实测 / INT=插值 / PRD=逐日预报（45 天）/ PRM=远期稀疏预测；只有 OBS 是观测值',
  `source` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'celestrak',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`date`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='日粒度太阳与地磁活动指数（F10.7 / Kp / Ap / 太阳黑子），来源 Celestrak（含 5 年历史与 45 天预报）';

-- sat_manual_tle（旧库 4 行）
CREATE TABLE IF NOT EXISTS `sat_manual_tle` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `norad_id` bigint unsigned NOT NULL COMMENT 'NORAD 编号（TLE 第 1 行解析）',
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '目标名称',
  `object_type` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'MANUAL' COMMENT '目标类型（手输固定 MANUAL）',
  `tle_line1` varchar(90) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'TLE 第 1 行',
  `tle_line2` varchar(90) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'TLE 第 2 行',
  `epoch` datetime DEFAULT NULL COMMENT 'TLE 历元（UTC）',
  `incl` double DEFAULT NULL COMMENT '倾角(度)',
  `raan` double DEFAULT NULL COMMENT '升交点赤经(度)',
  `ecc` double DEFAULT NULL COMMENT '偏心率',
  `arg_perigee` double DEFAULT NULL COMMENT '近地点幅角(度)',
  `mean_anomaly` double DEFAULT NULL COMMENT '平近点角(度)',
  `mean_motion` double DEFAULT NULL COMMENT '平均角速度(圈/日)',
  `semimajor_axis` double DEFAULT NULL COMMENT '半长轴(km)',
  `period` double DEFAULT NULL COMMENT '周期(分钟)',
  `perigee` double DEFAULT NULL COMMENT '近地点高度(km)',
  `apogee` double DEFAULT NULL COMMENT '远地点高度(km)',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '备注',
  `created_by` int unsigned DEFAULT NULL COMMENT '录入人 sys_user.id',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '首次录入时间',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '最近更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_id` (`norad_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='手输 TLE（按目标扫描用，独立于全量库 sat_tle）';

-- sat_manual_tle_aoe（旧库 0 行）
CREATE TABLE IF NOT EXISTS `sat_manual_tle_aoe` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `norad_id` bigint unsigned NOT NULL COMMENT 'NORAD 编号（TLE 第 1 行解析）',
  `object_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '目标名称',
  `object_type` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'MANUAL' COMMENT '目标类型（手输固定 MANUAL）',
  `tle_line1` varchar(90) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'TLE 第 1 行',
  `tle_line2` varchar(90) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'TLE 第 2 行',
  `epoch` datetime DEFAULT NULL COMMENT 'TLE 历元（UTC）',
  `incl` double DEFAULT NULL COMMENT '倾角(度)',
  `raan` double DEFAULT NULL COMMENT '升交点赤经(度)',
  `ecc` double DEFAULT NULL COMMENT '偏心率',
  `arg_perigee` double DEFAULT NULL COMMENT '近地点幅角(度)',
  `mean_anomaly` double DEFAULT NULL COMMENT '平近点角(度)',
  `mean_motion` double DEFAULT NULL COMMENT '平均角速度(圈/日)',
  `semimajor_axis` double DEFAULT NULL COMMENT '半长轴(km)',
  `period` double DEFAULT NULL COMMENT '周期(分钟)',
  `perigee` double DEFAULT NULL COMMENT '近地点高度(km)',
  `apogee` double DEFAULT NULL COMMENT '远地点高度(km)',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '备注',
  `created_by` int unsigned DEFAULT NULL COMMENT '录入人 sys_user.id',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '首次录入时间',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '最近更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_norad_id` (`norad_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='手输 TLE（按目标扫描用，独立于全量库 sat_aoe）';

-- sat_constellation（旧库 139 行）
CREATE TABLE IF NOT EXISTS `sat_constellation` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_en` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `regime` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `regime_label` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `plan_count` int DEFAULT '0',
  `keywords` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_code` (`code`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='星座主数据（名称/英文名/轨道区域/组网状态/计划数量/匹配关键词）';

-- sat_constellation_sat（旧库 16669 行）
CREATE TABLE IF NOT EXISTS `sat_constellation_sat` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `constellation_id` bigint NOT NULL,
  `norad_id` int NOT NULL,
  `source` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'manual',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_constellation_sat` (`constellation_id`,`norad_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='星座与卫星(NORAD)多对多关联';

-- sat_constellation_log（旧库 8827 行）
CREATE TABLE IF NOT EXISTS `sat_constellation_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `constellation_id` bigint DEFAULT NULL,
  `constellation_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `norad_id` int DEFAULT NULL,
  `object_name` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `detail` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='星座-卫星关联自动化/手动操作变动明细';

-- sat_conj_run（旧库 31 行）
CREATE TABLE IF NOT EXISTS `sat_conj_run` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `total_objects` int DEFAULT '0',
  `candidates` int DEFAULT '0',
  `events` int DEFAULT '0',
  `threshold` double DEFAULT '10',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `scope` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `mode` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'all',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次全量碰撞扫描的运行统计与结果';

-- sat_conj_run_aoe（旧库 29 行）
CREATE TABLE IF NOT EXISTS `sat_conj_run_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `total_objects` int DEFAULT '0',
  `candidates` int DEFAULT '0',
  `events` int DEFAULT '0',
  `threshold` double DEFAULT '10',
  `duration` int DEFAULT '0',
  `scope` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `mode` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'all',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次碰撞扫描的运行统计与结果（多批次共存，保留最近 30 批）';

-- sat_conjunction（旧库 1657124 行）
CREATE TABLE IF NOT EXISTS `sat_conjunction` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL,
  `norad_a` int NOT NULL,
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `norad_b` int NOT NULL,
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_b` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `tca` datetime DEFAULT NULL,
  `min_distance` double DEFAULT NULL,
  `rel_speed` double DEFAULT NULL,
  `altitude` double DEFAULT NULL,
  `level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'info',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `cri` double DEFAULT '0',
  `crp` double DEFAULT '0',
  `risk_level` tinyint DEFAULT '5',
  `miss_level` tinyint DEFAULT '5',
  `pc` double DEFAULT NULL,
  `pc_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sigma_m` double DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='SGP4 初筛接近事件（每次扫描整体覆盖更新）';

-- sat_conjunction_aoe（旧库 136965 行）
CREATE TABLE IF NOT EXISTS `sat_conjunction_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL,
  `norad_a` int NOT NULL,
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `norad_b` int NOT NULL,
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_b` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `tca` datetime DEFAULT NULL,
  `min_distance` double DEFAULT NULL,
  `rel_speed` double DEFAULT NULL,
  `altitude` double DEFAULT NULL,
  `cri` double DEFAULT '0',
  `crp` double DEFAULT '0',
  `risk_level` tinyint DEFAULT '5',
  `miss_level` tinyint DEFAULT '5',
  `level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'info',
  `pc` double DEFAULT NULL,
  `pc_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sigma_m` double DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='SGP4 初筛接近事件（按 run_id 多批次共存，保留最近 30 批）';

-- sat_cri_run（旧库 31 行）
CREATE TABLE IF NOT EXISTS `sat_cri_run` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `total_objects` int DEFAULT '0',
  `candidates` int DEFAULT '0',
  `events` int DEFAULT '0',
  `threshold` double DEFAULT '10',
  `duration` int DEFAULT '0',
  `scope` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `mode` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'all',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次交会分析扫描的运行统计与结果（多批次共存，保留最近 30 批）';

-- sat_cri_run_aoe（旧库 30 行）
CREATE TABLE IF NOT EXISTS `sat_cri_run_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `total_objects` int DEFAULT '0',
  `candidates` int DEFAULT '0',
  `events` int DEFAULT '0',
  `threshold` double DEFAULT '10',
  `duration` int DEFAULT '0',
  `scope` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `mode` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'all',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每次交会分析扫描的运行统计与结果（多批次共存，保留最近 30 批）';

-- sat_cri_conjunction（旧库 1695412 行）
CREATE TABLE IF NOT EXISTS `sat_cri_conjunction` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL,
  `norad_a` int NOT NULL,
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `norad_b` int NOT NULL,
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_b` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `tca` datetime DEFAULT NULL,
  `min_distance` double DEFAULT NULL,
  `rel_speed` double DEFAULT NULL,
  `altitude` double DEFAULT NULL,
  `cri` double DEFAULT '0',
  `crp` double DEFAULT '0',
  `risk_level` tinyint DEFAULT '5',
  `miss_level` tinyint DEFAULT '5',
  `level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'info',
  `pc` double DEFAULT NULL,
  `pc_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sigma_m` double DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='CRI/CRP 模型接近事件（按 run_id 多批次共存，保留最近 30 批）';

-- sat_cri_conjunction_aoe（旧库 143869 行）
CREATE TABLE IF NOT EXISTS `sat_cri_conjunction_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL,
  `norad_a` int NOT NULL,
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `norad_b` int NOT NULL,
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_b` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'UNKNOWN',
  `tca` datetime DEFAULT NULL,
  `min_distance` double DEFAULT NULL,
  `rel_speed` double DEFAULT NULL,
  `altitude` double DEFAULT NULL,
  `cri` double DEFAULT '0',
  `crp` double DEFAULT '0',
  `risk_level` tinyint DEFAULT '5',
  `miss_level` tinyint DEFAULT '5',
  `level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'info',
  `pc` double DEFAULT NULL,
  `pc_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `sigma_m` double DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_run_id` (`run_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='CRI/CRP 模型接近事件（按 run_id 多批次共存，保留最近 30 批）';

-- sat_cdm（旧库 3098 行）
CREATE TABLE IF NOT EXISTS `sat_cdm` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `cdm_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `creation_date` datetime DEFAULT NULL,
  `originator` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tca` datetime DEFAULT NULL,
  `type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'SCREENING',
  `focus_a` tinyint DEFAULT '0',
  `norad_a` int NOT NULL,
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `norad_b` int NOT NULL,
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `miss_distance_km` double DEFAULT NULL,
  `radial_distance_km` double DEFAULT NULL,
  `rel_speed_km_per_s` double DEFAULT NULL,
  `collision_probability` double DEFAULT NULL,
  `hard_body_radius_m` double DEFAULT NULL,
  `raw_json` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `a_x` double DEFAULT NULL,
  `a_y` double DEFAULT NULL,
  `a_z` double DEFAULT NULL,
  `b_x` double DEFAULT NULL,
  `b_y` double DEFAULT NULL,
  `b_z` double DEFAULT NULL,
  `mid_x` double DEFAULT NULL,
  `mid_y` double DEFAULT NULL,
  `mid_z` double DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Space-Track 官方碰撞预警数据（Conjunction Data Message，每次拉取整体覆盖更新）';

-- sat_cdm_sync_log（旧库 158 行）
CREATE TABLE IF NOT EXISTS `sat_cdm_sync_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `total` int DEFAULT '0',
  `duration` int DEFAULT '0',
  `status` tinyint DEFAULT '1',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Space-Track CDM 同步日志（每次拉取的统计与结果）';

-- sat_report（旧库 4 行）
CREATE TABLE IF NOT EXISTS `sat_report` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `report_no` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'conj',
  `event_id` bigint NOT NULL DEFAULT '0',
  `run_id` bigint NOT NULL DEFAULT '0',
  `norad_a` int NOT NULL DEFAULT '0',
  `norad_b` int NOT NULL DEFAULT '0',
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tca` datetime DEFAULT NULL,
  `level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'info',
  `pc` double DEFAULT NULL,
  `miss_distance` double DEFAULT NULL,
  `rel_speed` double DEFAULT NULL,
  `sigma_m` double DEFAULT NULL,
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_size` int DEFAULT '0',
  `payload_json` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_type_id` (`type`,`id`) USING BTREE,
  KEY `idx_event` (`type`,`event_id`) USING BTREE,
  KEY `idx_pair` (`type`,`norad_a`,`norad_b`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='碰撞/交会预警报告（docx 产物 + 生成状态 + 载荷快照）';

-- sat_report_aoe（旧库 0 行）
CREATE TABLE IF NOT EXISTS `sat_report_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `report_no` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'conj_aoe',
  `event_id` bigint NOT NULL DEFAULT '0',
  `run_id` bigint NOT NULL DEFAULT '0',
  `norad_a` int NOT NULL DEFAULT '0',
  `norad_b` int NOT NULL DEFAULT '0',
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tca` datetime DEFAULT NULL,
  `level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'info',
  `pc` double DEFAULT NULL,
  `miss_distance` double DEFAULT NULL,
  `rel_speed` double DEFAULT NULL,
  `sigma_m` double DEFAULT NULL,
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_size` int DEFAULT '0',
  `payload_json` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_type_id` (`type`,`id`) USING BTREE,
  KEY `idx_event` (`type`,`event_id`) USING BTREE,
  KEY `idx_pair` (`type`,`norad_a`,`norad_b`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='碰撞/交会预警报告（docx 产物 + 生成状态 + 载荷快照）';

-- sat_joint_conj_run（旧库 3 行）
CREATE TABLE IF NOT EXISTS `sat_joint_conj_run` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `batch_no` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `mode` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'build',
  `window_hours` int DEFAULT '24',
  `look_hours` int DEFAULT '72',
  `total` int DEFAULT '0',
  `paired` int DEFAULT '0',
  `only_tle` int DEFAULT '0',
  `only_aoe` int DEFAULT '0',
  `consistent` int DEFAULT '0',
  `close` int DEFAULT '0',
  `diverge` int DEFAULT '0',
  `pc_same` int DEFAULT '0',
  `pc_near` int DEFAULT '0',
  `pc_far` int DEFAULT '0',
  `pc_unknown` int DEFAULT '0',
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='国际库 × AOE 库碰撞预警事件的对照批次（构建 / 现算两种来源）';

-- sat_joint_conj_pair（旧库 151131 行）
CREATE TABLE IF NOT EXISTS `sat_joint_conj_pair` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL DEFAULT '0',
  `norad_a` int NOT NULL DEFAULT '0',
  `norad_b` int NOT NULL DEFAULT '0',
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_b` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `verdict` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `pc_verdict` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `source` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'list',
  `tle_event_id` bigint DEFAULT '0',
  `aoe_event_id` bigint DEFAULT '0',
  `tle_tca` datetime DEFAULT NULL,
  `tle_miss` double DEFAULT NULL,
  `tle_rel_speed` double DEFAULT NULL,
  `tle_altitude` double DEFAULT NULL,
  `tle_cri` double DEFAULT NULL,
  `tle_crp` double DEFAULT NULL,
  `tle_pc` double DEFAULT NULL,
  `tle_pc_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `tle_sigma_m` double DEFAULT NULL,
  `tle_risk_level` tinyint DEFAULT NULL,
  `tle_miss_level` tinyint DEFAULT NULL,
  `tle_level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `aoe_tca` datetime DEFAULT NULL,
  `aoe_miss` double DEFAULT NULL,
  `aoe_rel_speed` double DEFAULT NULL,
  `aoe_altitude` double DEFAULT NULL,
  `aoe_cri` double DEFAULT NULL,
  `aoe_crp` double DEFAULT NULL,
  `aoe_pc` double DEFAULT NULL,
  `aoe_pc_method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `aoe_sigma_m` double DEFAULT NULL,
  `aoe_risk_level` tinyint DEFAULT NULL,
  `aoe_miss_level` tinyint DEFAULT NULL,
  `aoe_level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `dt_sec` int DEFAULT NULL,
  `d_miss_km` double DEFAULT NULL,
  `d_rel_speed` double DEFAULT NULL,
  `d_cri` double DEFAULT NULL,
  `d_pc_log` double DEFAULT NULL,
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='一对目标在两库下的碰撞预警结论对照（TCA / 距离 / 速度 / CRI / CRP / Pc / σ / 等级 / 差值 / 判定 / Pc 档位一致性）';

-- sat_joint_conj_report（旧库 0 行）
CREATE TABLE IF NOT EXISTS `sat_joint_conj_report` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `report_no` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `kind` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'run',
  `run_id` bigint NOT NULL DEFAULT '0',
  `pair_id` bigint DEFAULT '0',
  `batch_no` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `total` int DEFAULT '0',
  `paired` int DEFAULT '0',
  `consistent` int DEFAULT '0',
  `close` int DEFAULT '0',
  `diverge` int DEFAULT '0',
  `only_one` int DEFAULT '0',
  `pc_same` int DEFAULT '0',
  `pc_near` int DEFAULT '0',
  `pc_far` int DEFAULT '0',
  `pc_unknown` int DEFAULT '0',
  `note` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `csv_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_size` int DEFAULT '0',
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='碰撞联合分析 docx 报告（批次快照 / 单条对比 + Pc 档位一致性 + 生成状态 + 产物路径）';

-- sat_joint_cri_run（旧库 3 行）
CREATE TABLE IF NOT EXISTS `sat_joint_cri_run` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `batch_no` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `mode` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'build',
  `window_hours` int DEFAULT '24',
  `look_hours` int DEFAULT '72',
  `total` int DEFAULT '0',
  `paired` int DEFAULT '0',
  `only_tle` int DEFAULT '0',
  `only_aoe` int DEFAULT '0',
  `consistent` int DEFAULT '0',
  `close` int DEFAULT '0',
  `diverge` int DEFAULT '0',
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='国际库 × AOE 库交会事件的对照批次（构建 / 现算两种来源）';

-- sat_joint_cri_pair（旧库 146991 行）
CREATE TABLE IF NOT EXISTS `sat_joint_cri_pair` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` bigint NOT NULL DEFAULT '0',
  `norad_a` int NOT NULL DEFAULT '0',
  `norad_b` int NOT NULL DEFAULT '0',
  `name_a` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `name_b` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_a` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `type_b` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `verdict` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `source` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'list',
  `tle_event_id` bigint DEFAULT '0',
  `aoe_event_id` bigint DEFAULT '0',
  `tle_tca` datetime DEFAULT NULL,
  `tle_miss` double DEFAULT NULL,
  `tle_rel_speed` double DEFAULT NULL,
  `tle_altitude` double DEFAULT NULL,
  `tle_cri` double DEFAULT NULL,
  `tle_crp` double DEFAULT NULL,
  `tle_level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `aoe_tca` datetime DEFAULT NULL,
  `aoe_miss` double DEFAULT NULL,
  `aoe_rel_speed` double DEFAULT NULL,
  `aoe_altitude` double DEFAULT NULL,
  `aoe_cri` double DEFAULT NULL,
  `aoe_crp` double DEFAULT NULL,
  `aoe_level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `dt_sec` int DEFAULT NULL,
  `d_miss_km` double DEFAULT NULL,
  `d_rel_speed` double DEFAULT NULL,
  `d_cri` double DEFAULT NULL,
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `tle_age_a` int DEFAULT NULL,
  `tle_age_b` int DEFAULT NULL,
  `aoe_age_a` int DEFAULT NULL,
  `aoe_age_b` int DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='一对目标在两库下的交会结论对照（TCA / 距离 / 速度 / CRI / CRP / 等级 / 差值 / 判定）';

-- sat_joint_cri_report（旧库 4 行）
CREATE TABLE IF NOT EXISTS `sat_joint_cri_report` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `report_no` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `run_id` bigint NOT NULL DEFAULT '0',
  `batch_no` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `total` int DEFAULT '0',
  `paired` int DEFAULT '0',
  `consistent` int DEFAULT '0',
  `close` int DEFAULT '0',
  `diverge` int DEFAULT '0',
  `only_one` int DEFAULT '0',
  `note` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `status` tinyint DEFAULT '0',
  `message` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `csv_path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `file_size` int DEFAULT '0',
  `duration` int DEFAULT '0',
  `created_by` bigint DEFAULT '0',
  `created_by_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `kind` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'run',
  `pair_id` bigint DEFAULT '0',
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='联合分析 docx 报告（批次快照 + 生成状态 + 产物路径）';

-- sat_joint_health（旧库 4 行）
CREATE TABLE IF NOT EXISTS `sat_joint_health` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `week_label` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `week_start` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `week_end` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `run_id` bigint DEFAULT '0',
  `run_created_at` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `epoch_max_days` int DEFAULT '7',
  `total_rows` int DEFAULT '0',
  `paired_rows` int DEFAULT '0',
  `only_tle_rows` int DEFAULT '0',
  `only_aoe_rows` int DEFAULT '0',
  `consistent_rows` int DEFAULT '0',
  `close_rows` int DEFAULT '0',
  `diverge_rows` int DEFAULT '0',
  `consistent_rate` double DEFAULT NULL,
  `diverge_rate` double DEFAULT NULL,
  `gap_targets_tle` int DEFAULT '0',
  `gap_targets_aoe` int DEFAULT '0',
  `gap_rows` int DEFAULT '0',
  `fresh_rows` int DEFAULT '0',
  `fresh_miss_rows` int DEFAULT '0',
  `fresh_miss_tle` int DEFAULT '0',
  `fresh_miss_aoe` int DEFAULT '0',
  `true_miss_rate` double DEFAULT NULL,
  `stale_rows` int DEFAULT '0',
  `epoch_median_days` double DEFAULT NULL,
  `epoch_p90_days` double DEFAULT NULL,
  `alert_level` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'ok',
  `alert_text` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='两库对照的周健康度（覆盖缺口 / 真漏报率 / 历元年龄中位数 / 告警）';

-- sat_cov_model（旧库 15 行）
CREATE TABLE IF NOT EXISTS `sat_cov_model` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `regime` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `bins` json DEFAULT NULL,
  `sample_n` int NOT NULL DEFAULT '0',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_regime_type` (`regime`,`object_type`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='碰撞概率经验协方差模型（TLE 预报差分桶）';

-- sat_cov_model_aoe（旧库 6 行）
CREATE TABLE IF NOT EXISTS `sat_cov_model_aoe` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `regime` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `bins` json DEFAULT NULL,
  `sample_n` int NOT NULL DEFAULT '0',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_regime_type` (`regime`,`object_type`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='碰撞概率经验协方差模型（TLE 预报差分桶）';

-- sys_user（旧库 5 行）
CREATE TABLE IF NOT EXISTS `sys_user` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录账号',
  `password` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'bcrypt 哈希',
  `nickname` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `role_id` int DEFAULT NULL COMMENT '关联 sys_role',
  `phone` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `email` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `avatar` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `dept_id` int DEFAULT NULL COMMENT '关联 sys_dept，部门数据隔离依据',
  `sort` int DEFAULT '0' COMMENT '排序值，数字越小越靠前',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_username` (`username`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台管理系统用户';

-- sys_role（旧库 5 行）
CREATE TABLE IF NOT EXISTS `sys_role` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `permissions` json DEFAULT NULL COMMENT 'JSON：{ menus: [], buttons: { module:action: 1 } }',
  `status` tinyint DEFAULT '1',
  `remark` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_name` (`name`) USING BTREE,
  UNIQUE KEY `uk_code` (`code`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='角色与权限';

-- sys_log（旧库 1091 行）
CREATE TABLE IF NOT EXISTS `sys_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `module` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `method` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `path` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后台操作审计日志（只读，无需新增）';

-- sys_message（旧库 1043 行）
CREATE TABLE IF NOT EXISTS `sys_message` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `msg_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'notice',
  `target_type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'all',
  `target_ids` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_by` bigint DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `link_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='消息主表';

-- sys_message_user（旧库 3847 行）
CREATE TABLE IF NOT EXISTS `sys_message_user` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `message_id` bigint NOT NULL,
  `user_id` bigint NOT NULL,
  `is_read` tinyint DEFAULT '0',
  `read_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='消息接收人已读状态';
