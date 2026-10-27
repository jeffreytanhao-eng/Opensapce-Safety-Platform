-- ============================================================
-- 统一星历表（官方 Starlink 星历 + 用户上传星历）
--  - 点数据以 HSEPH1 gzip BLOB 直接存库，不再依赖磁盘 bin 文件；
--  - 官方星历按卫星唯一（sat_key='MEME:<meme_id>'），新星历覆盖旧星历；
--  - 上传星历 sat_key 为 NULL，保留 sha256 去重与 expires_at 过期清理。
-- 可重复运行
-- ============================================================

CREATE TABLE IF NOT EXISTS hs_ephem (
  id VARCHAR(64) NOT NULL PRIMARY KEY,          -- 官方 off:<meme_id> | 上传 <uuid>
  scope VARCHAR(8) NOT NULL,                    -- official | uploaded
  sat_key VARCHAR(100) NULL,                    -- 官方 MEME:<meme_id>，上传 NULL
  meme_id INT NULL,
  norad_id INT NULL,
  name VARCHAR(100),
  file_name VARCHAR(200),
  file_format VARCHAR(8),                       -- itc|oem|ocm
  frame VARCHAR(20),
  cov_frame VARCHAR(20),
  has_cov TINYINT NOT NULL DEFAULT 0,
  points INT NOT NULL,
  step_s INT,
  start_utc DATETIME(3),
  stop_utc DATETIME(3),
  created_utc DATETIME,
  sha1 CHAR(40) NULL,
  sha256 CHAR(64) NULL,
  size_bytes INT NULL,
  data LONGBLOB NOT NULL,                       -- HSEPH1 头 + Float64 数组的 gzip
  run_id BIGINT NULL,                           -- 最近一次写入该星的同步轮次
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at DATETIME NULL,                     -- 仅上传星历
  UNIQUE KEY uk_sat (sat_key),
  KEY idx_scope (scope),
  KEY idx_norad (norad_id),
  KEY idx_exp (expires_at),
  KEY idx_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='统一星历表（官方+上传，点数据以 HSEPH1 gzip 存库）';
