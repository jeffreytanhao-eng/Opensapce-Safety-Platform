# 星历热力 vs 官方 CDM 对比验证（2026-10-25）

> 对应计划：`02-安全热力开发计划.md` P5 / `.trae/documents/安全热力重构_三标签与heat-sidecar_实施计划.md` P5
> 执行环境：本地 MySQL（`openspace`，宿主机 13306）+ heat-sidecar（端口 1236 联调）
> 触发时间：2026-10-24 23:01 UTC（2026-10-25 07:01 UTC+8）；23:26 UTC 配置 Space-Track 凭据后重跑

## 1. 口径

| 项 | 口径 |
| --- | --- |
| 匹配 | NORAD 无序对相同且 ΔTCA 绝对值 ≤ 120 s |
| 对比范围 | 只统计「一方为本轮筛查主星（50 份 Starlink 精密星历）」的官方 CDM |
| 召回率分母 | 官方 Pc ≥ 1e-5 的 CDM 条数 |
| Δmiss | 我方 `miss_km` 与官方 `min_rng`（同口径 km）之差的绝对值，取中位数 / P90 |
| Pc 量级一致 | log10(Pc / Pc_cdm) 绝对值 ≤ 1 |
| 误报参考值 | 我方红/橙（Pc ≥ 1e-5）但无对应 CDM 的事件数 |

## 2. 输入数据现状

- 精密星历：`hs_eph_file` run=3，50 份 Starlink，生成时间 2026-10-24 09:21:51 UTC，72 h / 60 s，覆盖至 2026-10-27 09:21 UTC。
- 副星根数（2026-10-24 23:27 UTC 实测）：`sat_tle` 35530 行（历元龄期中位 **21.2 h**）；`sat_aoe` 19356 行（历元龄期中位 **197.5 h**，明显滞后于 TLE，前端时效条标注「历元滞后」）。注意：run 3 / run 4 筛查使用的是同步前的旧根数（TLE 龄期中位 153.6 h、AOE 317.6 h）。
- Space-Track 凭据已于 2026-10-24 23:26 UTC 写入 `heat-sidecar/.env` 并完成首次同步：`gp` 35509 条、`cdm` 351 条、`aoe` 19356 条；`hs_cdm_history` 现有 351 条，验证优先使用该表。

本轮筛查（72 h 窗口，`SCREEN_WINDOW_H` 默认值）：

| run | kind | 事件数 | 候选数 | TCA 范围（UTC） | 用时 |
| --- | --- | --- | --- | --- | --- |
| 3 | tle | 5698 | 935,508 | 2026-10-24 22:45 → 2026-10-27 08:51 | 626 s |
| 4 | aoe | 2123 | 786,594 | 2026-10-24 23:01 → 2026-10-27 08:52 | 181 s |

两轮事件的分级全部为 `info`（Pc 1e-7 ~ 1e-5）：TLE 轮 Pc ∈ [1.00e-7, 1.69e-6]，AOE 轮 Pc ∈ [1.00e-7, 7.46e-7]，均无红/橙事件。

## 3. 官方 CDM 对比结果

`GET /cgi2/validate/latest`（hs_validate id=5 / id=6，2026-10-24 23:26 UTC 凭据配置后重跑）：

| kind | run_id | cdm_source | n_cdm | n_official_high | n_matched | recall | Δmiss 中位 | Δmiss P90 | Pc 量级一致率 | false_alarm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tle | 3 | hs_cdm_history | 0 | 0 | 0 | — | — | — | — | 0 |
| aoe | 4 | hs_cdm_history | 0 | 0 | 0 | — | — | — | — | 0 |

**结果为 0 的原因（凭据已配置、同步成功，属数据覆盖限制）**

- `hs_cdm_history` 共 351 条，TCA 范围 2026-10-24 01:02 ~ 2026-10-27 06:58 UTC，**与本轮窗口重叠**，时间维度不再是阻碍；
- 351 条 CDM 涉及 90 个不同 NORAD，全部为碎片/火箭体（FENGYUN 1C DEB 30 条、CZ-6A DEB 22 条、COSMOS 1275 DEB 21 条等），名称含 `STARLINK` 的 CDM 为 **0 条**；
- 与 run 3 / run 4 全部事件的 NORAD（主星 + 副星）交集为 **0**，删除「一方为本轮主星」的过滤条件后仍无可匹配项；
- 账户仅能访问 `cdm_public` 数据集；尝试全量 `class/cdm` 返回 `HTTP 400 Your Class Does Not Exist`，即该账号无全量 CDM 权限；
- 因此召回率、Δmiss、Pc 量级一致率均无法计算（返回 `null`）：Space-Track 公开 CDM 不包含 Starlink，而本轮主星正是 50 颗 Starlink。

## 4. 替代一致性核对（TLE vs AOE，同主星同星历）

在缺少官方基准时，用两套副星根数（`sat_tle` vs `sat_aoe`）对同一批主星、同一份精密星历的结果做交叉比对，作为误差的间接参考：

| 指标 | 值 |
| --- | --- |
| 匹配对（NORAD 无序对 + ΔTCA 绝对值 ≤ 120 s） | 70 |
| Δmiss 中位数 | 1.365 km |
| Δmiss P90 | 3.39 km |
| Δmiss 均值 | 1.632 km |

说明：匹配对仅 70 对，主要因为 AOE 目录（19308）与 TLE 目录（35471）的目标集合差异较大，并非算法差异；该值只能说明两套根数在同一几何下的结果量级一致，**不能替代官方 CDM 的召回率验证**。

## 5. P5 验收结论

| 验收项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 召回率（官方 Pc ≥ 1e-5） | ≥ 80% | 无法计算（官方 CDM 覆盖 0 条） | 未判定 |
| TLE 标签 Δmiss 中位数 | ≤ 1 km | 无法计算（无匹配 CDM） | 未判定 |

按计划「首轮不达标则记录实测值并说明原因」，本轮记录为空值并说明：**阻塞原因不是凭据（已配置且 cdm/gp/aoe 同步成功），而是 Space-Track 公开 CDM 数据集不包含 Starlink，且当前账号无全量 CDM 权限**，无法为「以 50 颗 Starlink 为主星」的筛查提供官方基准。

若后续获得含 Starlink 的 CDM 数据源（全量 CDM 权限、或 Starlink 专项 CDM 通道），无需改代码，按下述步骤重跑即可得到正式指标：

```bash
# 1) heat-sidecar/.env 已配置 SAT_USERNAME / SAT_PASSWORD（不写日志、不入库）
# 2) 同步官方 CDM 与 GP（本次已执行：cdm 351 条、gp 35509 条）
curl -X POST -H "X-Admin-Token: <SIDECAR_ADMIN_TOKEN>" http://127.0.0.1:1235/cgi2/admin/sync/cdm
curl -X POST -H "X-Admin-Token: <SIDECAR_ADMIN_TOKEN>" http://127.0.0.1:1235/cgi2/admin/sync/gp
# 3) 重跑一轮筛查后触发验证
curl -X POST -H "X-Admin-Token: <SIDECAR_ADMIN_TOKEN>" http://127.0.0.1:1235/cgi2/admin/screen/tle
curl -X POST -H "X-Admin-Token: <SIDECAR_ADMIN_TOKEN>" http://127.0.0.1:1235/cgi2/admin/validate/tle
curl "http://127.0.0.1:1235/cgi2/validate/latest?kind=tle"
```

## 6. 其他结论与待办

- 本轮已把 `sigma_p_t_km`（主星沿迹方向 σ）写入全部 5698 / 2123 条事件，事件详情面板可正常显示；旧轮次事件该字段为 `null`，属增量列的历史数据。
- 主星 σT 范围：TLE 轮 1.16 ~ 16.65 km（随星历龄期增长），与精密星历 `PcMax ≥ 1e-4` 的「数据不足」灰档逻辑配合使用。
- AOE 根数历元明显滞后于 TLE（筛查时 317.6 h vs 153.6 h；凭据配置同步后 197.5 h vs 21.2 h），前端数据时效条按差值 ≥48 h 自动标注「历元滞后」。
- 凭据已配置且同步链路验证通过（cdm 3 s、aoe 6 s、gp 15 s）；SpaceTrack 标签所用的 `sat_cdm` 已由 351 条最新公开 CDM 整表覆盖（TCA 2026-10-24 01:02 ~ 2026-10-27 06:58）。
- 后续若要完成 P5 正式验收，需要：① 含 Starlink 的官方 CDM 数据源（全量 CDM 权限或 Starlink 专项通道）；② 刷新的 TLE/AOE 根数下重跑一轮筛查（本次同步后 TLE 龄期中位已从 153.6 h 降到 21.2 h）；③ 用新数据重跑验证并新增 `validation-YYYYMMDD.md` 轮次，不覆盖本篇。

## 7. 05 修复清单执行记录（2026-10-25 15:10 UTC）

### 7.1 P0-1 等级口径统一为契约值 `red / orange / yellow / insufficient`

- 前端 `heat/riskLevels.ts` 的 `HeatLevel` 改为契约四档，`levelOfPc` 直接返回 `red/orange/yellow/insufficient`；
  旧口径 `danger/warning/info` 仅在读取旧缓存时通过 `normalizeLevel()` 一次性映射，不再写入新数据。
- `BaseScene.showThreatPair` 构造 `ThreatEvent` 时不再映射成 `high/medium/low`，直接 `normalizeLevel(f.level) ?? 'yellow'`；
  事件图层配色 `THREAT_LEVEL_HEX` 同步改为四档（不足档灰色 `#93a4bd`）。
- 热力三标签芯片、星历窗事件列表的颜色/文案均来自同一套 `PC_LEVELS`，`vue-tsc -b` 无 level 相关告警。

### 7.2 P0-2 私有核心接入 + CDM Pc 优先

- `heat-sidecar/.env` 本地配置 `HEAT_CORE_PATH=…\heat-core\dist\index.cjs`（源与产物均不入库），重启后
  `GET /cgi2/health` 返回 `core=ready / core_kind=external / core_name=heat-core / core_version=1.0.0`（修前为 `bundled`）。
- `screen/run.ts` 新增官方 CDM 索引（`hs_cdm_history` 优先，空则回落 `sat_cdm`）：同一 NORAD 无序对且
  `|ΔTCA| ≤ 120 s` 视为同一交会事件；命中则 `pc = cdm.pc`、`pc_source='cdm'`，并写入
  `cdm_id / cdm_pc / cdm_miss_km / cdm_dtca_s`；未命中保持核心 Pc、`pc_source='core'`。
- 本轮重跑（AOE run=5）实测：事件 2589 条，**`pc_source` 全部为 `core`、`cdm_id` 全为空**——原因是公开 CDM
  数据集不含 Starlink（见 §3），本轮没有可匹配的官方 CDM；机制已就位，待获得含 Starlink 的 CDM 后自动生效。
- 重跑验证（15:45 UTC）：tle run=6 `n_cdm=0 / n_matched=0 / false_alarm=7`；aoe run=5 `n_cdm=0 / n_matched=0 / false_alarm=8`。
  `false_alarm` 即本轮警告档事件无对应官方 CDM，受 §3 覆盖限制，仅作参考。

### 7.3 P0-3 威胁事件点击后播放卡死

| 根因 | 修法 |
| --- | --- |
| TCA 可能是 `NaN` | `toThreat` 后过滤 `!Number.isFinite(tca)` 的条目；`focusUserEphemEvent` / `showThreatPair` 对非法 TCA 直接跳过并给出提示，不写虚拟时钟 |
| TCA 落在星历窗外 | 写完 `g.simTimeMs` 后调用 `clampEphemTime()`，并同步播放条 `simTimeMs.value` |
| 缺副星 TLE 时解引用 `otherEci!` | 改为可选判断，仅在本星位置定位（不再抛 TypeError） |
| 播放时钟为 `NaN` 时无法回绕 | `simTogglePlay` 先判 `Number.isFinite(g.simTimeMs)`，非法则回到星历起点再播 |
| 强制暂停无提示 | 定位成功后提示「已定位到交会时刻，仿真已暂停」（4 s 自动消失） |

### 7.4 P1 项

- **P1-1 星历文件上限**：仍为 `STARLINK_EPH_MAX_FILES=50`（全量约 22 GB，本机磁盘未确认）。
  **当前结论仅代表 50 份星历的子集，不可外推全星座。**
- **P1-2 AOE 龄期提示**：星历分析窗切换到 AOE 且同步状态 `median_age_hours > 72` 时显示提示条
  「副星 AOE 编目龄期中位 N h，误差被放大…」；热力面板原有数据时效区继续展示龄期与「历元滞后」。
- **P1-3 内置引擎不再等同私有核心**：`/cgi2/health` 增加 `core_kind`（`bundled|external|stub|`），
  `/cgi2/meta` 的 `core` 同样携带；前端在 `core_kind=bundled` 时提示「当前使用内置引擎（未配置 HEAT_CORE_PATH）」。
- **P1-4 6 位 NORAD**：未新建 `hs_gp_omm`；实测 `sat_tle` 中 `norad_id ≥ 100000` 共 **1511** 条且全部带 TLE 两行，
  可正常 SGP4 传播（抽检 100000 SARAMAGO、100001 STARLINK-38128）。若后续 GP 源对 6 位目标只给 OMM，
  再按 03 §3 补表。

### 7.5 修前 / 修后筛查对比（数据同步前后差异）

| 轮次 | kind | 副星目录 | 事件数 | 等级分布 | Pc 范围 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| run 3 | tle | 35471（龄期中位 153.6 h） | 5698 | 全 `info` | 1.00e-7 ~ 1.69e-6 | 修前；副星根数陈旧 |
| run 6 | tle | 35530（龄期中位 37.1 h） | 926 | `info` 919 / `warning` 7 | 1.01e-7 ~ 3.41e-5 | 修后重跑；根数刷新，σ 变小、低 Pc 事件不再越过 1e-7 门限 |
| run 4 | aoe | 19308（龄期中位 317.6 h） | 2123 | 全 `info` | 1.00e-7 ~ 7.46e-7 | 修前；副星根数陈旧 |
| run 5 | aoe | 19356（龄期中位 213.3 h） | 2589 | `info` 2581 / `warning` 8 | 1.00e-7 ~ 1.82e-5 | 修后重跑；根数刷新后出现 8 条警告档 |

差异来源是副星目录刷新（TLE 历元龄期 153.6 h → 37.1 h、AOE 317.6 h → 213.3 h，目标数 35471→35530 / 19308→19356），
计算链路（协方差合成 / Foster 2D）未改动：TLE 侧因 σ 显著变小，低于 1e-7 的弱事件不再建条目，事件数下降同时最高档上移；
AOE 侧新历元更接近真实几何，出现少量 `warning`。两轮 `pc_source` 全为 `core`，无 CDM 覆盖（见 §7.2）。

### 7.6 为何「SpaceTrack 有高危而精密星历几乎全黄」

1. **覆盖差**：SpaceTrack 标签读同步下来的官方 CDM（当前 351 条，仅碎片/箭体）；精密星历标签的主星是本轮
   50 颗 Starlink，两者 NORAD 交集为 0，无法互相印证，也就不会出现同一事件两边同时高危。
2. **Pc 低估**：精密星历 Pc 由双方协方差 + Foster 2D 计算，副星协方差来自 TLE/AOE 误差模型，随龄期放大；
   AOE 中位龄期约 213 h（15:20 UTC 实测），σ 被放大后 Pc 集中在 1e-7~1e-5（黄档）；只有协方差较小、几何贴近的事件才升到警告档。
3. **未优先 CDM**：修前即使存在官方 CDM 也不会覆盖事件 Pc；本次已实现 CDM Pc 优先，但受 §3 数据覆盖限制，
   本轮无命中。获得含 Starlink 的 CDM 数据源后，`pc_source=cdm` 的事件会与 SpaceTrack 同量级。

