-- ============================================================
-- 已上传星历与按需筛选任务（03 §15.8）
-- 只新增 hs_ 前缀表；hs_screen_run / hs_event 的增量列由 server.ts 的 ensureColumn 补齐
-- 可重复运行
-- ============================================================

CREATE TABLE IF NOT EXISTS hs_uploaded_ephem (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(100),
  norad_id INT NULL,
  meme_id INT NULL,
  file_format VARCHAR(8) NOT NULL,          -- itc|oem|ocm
  sha256 CHAR(64) NOT NULL,
  size_bytes INT NOT NULL,
  points INT NOT NULL,
  step_s INT,
  has_cov TINYINT NOT NULL,
  start_utc DATETIME(3),
  stop_utc DATETIME(3),
  bin_path VARCHAR(300) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  UNIQUE KEY uk_sha (sha256),
  KEY idx_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='已上传星历（全局共享，默认保留 7 天）';

CREATE TABLE IF NOT EXISTS hs_screen_job (
  id CHAR(36) NOT NULL PRIMARY KEY,
  ephem_id CHAR(36) NOT NULL,
  kind VARCHAR(8) NOT NULL,                 -- tle|aoe
  window_h INT NOT NULL,                    -- 24|72|168
  status VARCHAR(10) NOT NULL,              -- queued|running|done|failed|canceled
  progress DOUBLE DEFAULT 0,
  run_id BIGINT NULL,
  n_events INT NULL,
  error_code VARCHAR(40) NULL,
  message VARCHAR(500) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  KEY idx_status (status, created_at),
  KEY idx_ephem (ephem_id, kind, window_h)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='按需筛查任务（全局排队，同时只跑 1 个）';
