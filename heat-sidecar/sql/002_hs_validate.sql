-- 验证轮次（P5）：用同一轮 hs_event 对比同期官方 CDM（NORAD 无序对 + |ΔTCA| ≤ 120 s）
CREATE TABLE IF NOT EXISTS hs_validate (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(8) NOT NULL,              -- tle|aoe
  run_id BIGINT,                         -- 对应的 hs_screen_run.id
  compared_at DATETIME,
  cdm_source VARCHAR(20),                -- hs_cdm_history|sat_cdm（无侧车 CDM 历史时回落官方表）
  n_cdm INT,                             -- 参与对比的官方 CDM 数（一方为本轮筛查主星）
  n_official_high INT,                   -- 其中官方 Pc ≥ 1e-5 的条数（召回率分母）
  n_matched INT,                         -- 匹配上的 CDM 条数
  n_recall_hit INT,                      -- 匹配上且官方 Pc ≥ 1e-5 的条数
  recall DOUBLE,                         -- 召回率 = n_recall_hit / n_official_high
  dm_miss_median_km DOUBLE,              -- |Δmiss| 中位数
  dm_miss_p90_km DOUBLE,                 -- |Δmiss| P90
  pc_order_rate DOUBLE,                  -- |log10(Pc/Pc_cdm)| ≤ 1 的比例
  false_alarm INT,                       -- 我们判红/橙但无对应 CDM 的事件数（参考值）
  detail_json JSON,
  note VARCHAR(1000) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='星历热力与官方 CDM 的对比验证';
