-- ============================================================
-- kind 列扩宽到 VARCHAR(16)：新增 tle-threat（TLE×TLE 初筛）
-- MODIFY 可重复执行
-- ============================================================

ALTER TABLE hs_screen_run MODIFY kind VARCHAR(16) NOT NULL COMMENT 'tle|tle-threat|aoe';
ALTER TABLE hs_event MODIFY kind VARCHAR(16) NOT NULL COMMENT 'tle|tle-threat|aoe';
ALTER TABLE hs_screen_job MODIFY kind VARCHAR(16) NOT NULL COMMENT 'tle|tle-threat|aoe';
