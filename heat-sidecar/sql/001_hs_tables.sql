-- ============================================================
-- heat-sidecar 新表（只新增 hs_ 前缀表，不修改任何现有表结构）
-- 启动时自动执行（CREATE TABLE IF NOT EXISTS），可重复运行
-- 依据：openspace-safety-platform/02-安全热力开发计划.md §6.2
-- ============================================================

-- 同步任务日志（五个同步源 + 手动触发）
CREATE TABLE IF NOT EXISTS hs_sync_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(20) NOT NULL,           -- gp|cdm|eph|aoe|supgp
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  status TINYINT NOT NULL DEFAULT 0,     -- 0 运行 1 成功 2 失败 3 跳过（缺凭据等）
  total INT DEFAULT 0,
  inserted INT DEFAULT 0,
  updated INT DEFAULT 0,
  message VARCHAR(1000) DEFAULT '',
  params_json JSON NULL,
  KEY idx_src_time (source, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='heat-sidecar 同步任务日志';

-- Starlink 星历文件索引（文件本体在 EPH_STORE_DIR/<run_id>/<meme>.bin.gz）
CREATE TABLE IF NOT EXISTS hs_eph_file (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  meme_id INT NOT NULL,
  norad_id INT NULL,
  name VARCHAR(100),
  file_name VARCHAR(200),
  created_utc DATETIME,
  start_utc DATETIME,
  stop_utc DATETIME,
  step_s INT,
  frame VARCHAR(20),
  cov_frame VARCHAR(20),
  has_cov TINYINT,
  points INT,
  bin_path VARCHAR(300),
  sha1 CHAR(40),
  UNIQUE KEY uk_run_meme (run_id, meme_id),
  KEY idx_norad (norad_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Starlink 星历文件索引（DB 只存元数据，点数据落磁盘）';

-- Celestrak SupGP（SpaceX-E）根数
CREATE TABLE IF NOT EXISTS hs_supgp (
  norad_id INT NOT NULL,
  epoch DATETIME NOT NULL,
  object_name VARCHAR(100),
  line1 VARCHAR(80),
  line2 VARCHAR(80),
  source VARCHAR(20),
  fetched_at DATETIME,
  PRIMARY KEY (norad_id, epoch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Celestrak SupGP SpaceX-E 根数（每目标保留最新 2 条）';

-- 官方 CDM 历史（sat_cdm 整表覆盖前的留档，保留 90 天）
CREATE TABLE IF NOT EXISTS hs_cdm_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  fetched_at DATETIME NOT NULL,
  cdm_id VARCHAR(50),
  created DATETIME,
  tca DATETIME,
  norad_a INT,
  norad_b INT,
  min_rng_km DOUBLE,
  pc DOUBLE,
  emergency TINYINT,
  raw_json TEXT,
  KEY idx_pair_tca (norad_a, norad_b, tca),
  KEY idx_cdm (cdm_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Space-Track 公开 CDM 历史留档';

-- 筛查轮次（每个 kind 只保留最近 10 轮）
CREATE TABLE IF NOT EXISTS hs_screen_run (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(8) NOT NULL,              -- tle|aoe
  eph_run_id BIGINT,
  started_at DATETIME,
  finished_at DATETIME,
  status TINYINT,
  n_primary INT,
  n_secondary INT,
  n_candidates INT,
  n_events INT,
  params_json JSON,
  message VARCHAR(1000) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='星历筛查轮次统计';

-- 筛查事件（a_*/b_*/mid_* 为 TEME km，供三维渲染直接使用）
CREATE TABLE IF NOT EXISTS hs_event (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  kind VARCHAR(8) NOT NULL,
  primary_norad INT,
  primary_meme INT,
  primary_name VARCHAR(100),
  secondary_norad INT,
  secondary_name VARCHAR(100),
  secondary_src VARCHAR(8),             -- tle|aoe|eph|supgp
  tca DATETIME(3),
  miss_km DOUBLE,
  miss_r_km DOUBLE,
  miss_t_km DOUBLE,
  miss_n_km DOUBLE,
  rel_speed_kms DOUBLE,
  pc DOUBLE,
  pc_max DOUBLE,
  pc_method VARCHAR(20),
  hbr_m DOUBLE,
  sigma_p_src VARCHAR(20),
  sigma_p_t_km DOUBLE,                   -- 本星沿迹方向 σ（km，由精密星历协方差投影）
  sigma_s_src VARCHAR(20),
  sigma_s_t_km DOUBLE,
  sec_epoch DATETIME,
  sec_age_h DOUBLE,
  eph_created DATETIME,
  eph_age_h DOUBLE,
  level VARCHAR(10),
  diluted TINYINT DEFAULT 0,
  cdm_id VARCHAR(50) NULL,
  cdm_pc DOUBLE NULL,
  cdm_miss_km DOUBLE NULL,
  cdm_dtca_s DOUBLE NULL,
  a_x DOUBLE,
  a_y DOUBLE,
  a_z DOUBLE,
  b_x DOUBLE,
  b_y DOUBLE,
  b_z DOUBLE,
  mid_x DOUBLE,
  mid_y DOUBLE,
  mid_z DOUBLE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_run_tca (run_id, tca),
  KEY idx_p (primary_norad),
  KEY idx_s (secondary_norad),
  KEY idx_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='星历筛查事件（TCA 处状态与碰撞概率）';
