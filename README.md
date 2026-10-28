# 开源太空安全平台（OpenSpace Safety Platform）

## 一、实现目的

面向空间态势感知与空间安全场景的一体化演示与研究平台，核心目标两点：

1. **展示太空目标**——在三维地球上直观呈现在轨卫星星座、空间站、碎片、火箭残骸等目标的分布、轨道与运行状态，支持点云总览、单星定位、轨道线绘制、时间轴推演（0.1x~60x 变速）；
2. **分析太空安全**——基于 TLE 根数与精密星历做轨道交会威胁筛查，以「威胁热力图 + 3D 威胁红云」呈现未来 24h/3d/7d 威胁事件的时间与等级分布，并辅以 AI 专家对话完成目标查询、碰撞预警解读与三维场景联动讲解。

平台接入公开轨道数据源（Space-Track GP/TLE、Starlink 公开星历），全部计算与展示可在本地/私有环境完成，适用于教学演示、科研交流与竞赛展示。

## 二、系统设计架构

系统由「前端三维态势 + 双后端服务 + MySQL」组成，威胁热力数据链路全部收敛在开源的 heat-sidecar 微服务中：

```
┌─────────────────────────────────────────────────────────────┐
│  前端（Vue 3 + Vite，端口 1233）                               │
│                                                              │
│  BaseScene.vue ── 三维主场景（Cesium 地球 + Three.js 叠加层）    │
│    ├─ 卫星/碎片/残骸点云、轨道线、威胁红云（热力粒子云）           │
│    ├─ 天宫(48274)/国际空间站(25544) 专用 GLB 模型 + 位置展示      │
│    └─ 时间轴仿真（GMST 恒星时驱动，Cesium↔Three 逐帧相机同步）    │
│  面板层：SatListPanel（目标列表）/ CdmHeatmap（威胁热力图）       │
│          AiChatDrawer（AI 专家）/ PassPanel（城市过境）         │
└──────────────┬───────────────────────┬──────────────────────┘
               │ /cgi /uploads 代理     │ /cgi2 代理
┌──────────────▼──────────┐ ┌──────────▼───────────────────┐
│ 主后端 server（1234）     │ │ heat-sidecar（1236，全开源）   │
│ Node 22 + V8 字节码 jsc  │ │ Node 22 + Express + TS       │
│                          │ │                              │
│ · 目标编目查询 /cgi/sat_* │ │ src/sync/  数据同步           │
│ · 城市过境计算 /cgi/pass  │ │   spacetrackGp  GP/TLE 同步   │
│ · AI 智能体网关           │ │   starlinkEph   星历同步       │
│   /cgi/ai/*（SSE 流式）   │ │ src/screen/ 威胁筛查           │
│ · Swagger /cgi-docs      │ │   prefilter→coarse→refine→pc │
│                          │ │ src/ephem/  星历存储/OCM解析    │
└──────────────┬──────────┘ │ src/routes/  /cgi2 查询接口    │
               │            │ src/scheduler.ts 定时调度       │
               │            └──────────┬───────────────────┘
┌──────────────▼───────────────────────▼───────────────────┐
│  MySQL 8（openspace 库，空库自动自举 67 张表）                │
│  sat_tle/sat_catalog 编目 · hs_ephem 统一星历表              │
│  hs_event 威胁事件 · hs_screen_run 筛查批次 · 过境结果表       │
└──────────────────────────────────────────────────────────┘
```

### 前端结构

```
src/views/situation/
├── index.vue / index.scss   # 页面编排：底部 dock、边缘外拉 tag、面板显隐状态机
├── BaseScene.vue            # 三维场景主组件（点云/轨道/热力云/模型/交互拾取）
├── scene.ts                 # 跨组件响应式状态通道（dockMode/heatMode/threatFocus 等）
├── cesiumEarth.ts           # Cesium 地球底座封装与相机双向同步
├── CdmHeatmap.vue           # 威胁热力图面板（双标签/按天柱/等级芯片/事件列表）
├── SatListPanel.vue         # 太空目标列表（星座卡片/空间站卡片/成员展开）
├── AiChatDrawer.vue         # AI 专家对话浮层（SSE 渲染/工具调用/场景联动）
├── heat/                    # 分级口径 riskLevels.ts、档位 chips、镜头聚焦
├── ephem/                   # 用户星历上传与解析
└── threatLink.ts            # 威胁事件跨面板联动总线
```

### 双后端分工

- **主后端（server/，jsc 字节码）**：目标编目、过境批算与 AI 网关等通用业务接口，以 V8 字节码分发（可运行、不含源码），对外契约由 Swagger 描述；
- **heat-sidecar（heat-sidecar/，完整开源 TS）**：威胁热力全部数据链路——TLE/星历同步、SGP4 批算、Pc 分级、`/cgi2` 查询接口与定时调度。不依赖 jsc，可独立部署、独立二次开发；启动时自动执行 `sql/` 迁移并给已有表补列。

## 三、技术实现

### 三维态势（Cesium + Three.js 双引擎）

- Cesium 承载高清影像与地理坐标，Three.js 叠加数十万级点云与线体；构建时 Cesium 独立分包，经 `cesiumEarth.ts` 动态 import 惰性加载；
- 双引擎逐帧相机同步：Three 主导交互 → `setCameraFromScene` 推入 Cesium → 渲染 → `syncCameraToThree` 回读，同帧同 GMST 数学无损；
- 时间轴仿真以仿射推演 simTimeMs 驱动，GMST 恒星时换算所有目标的地理定点，支持 0.1x~60x 变速与暂停；
- 3D 模型统一色彩规则：正常绿、选中蓝、威胁目标橙；同一目标在点云与星历数据集间去重渲染；天宫/ISS 使用专用 GLB 并做朝向校正与真实尺寸缩放。

### 威胁筛查算法流水线（heat-sidecar/src/screen）

```
TLE×TLE（或 星历×TLE）全库候选对
  → prefilter   近地点/倾角/高度带粗筛，剪除不可能交会对
  → coarse      SGP4 外推 + 时间窗粗算最近距离
  → refine      Brent 极值搜索精确 TCA（±半窗边界命中即弃，配合 30s 去重窗防重复事件）
  → pc          Foster 2D 方法结合双方协方差计算碰撞概率 Pc
                PcMax 为 Alfano 缩放上界（协方差不足时的保守估计）
  → 分级入库    hs_event（记录 pc_source/quality 溯源字段）
```

统一分级口径（前端 `heat/riskLevels.ts` 与后端同一套门限）：

| 等级 | 门限 | 说明 |
| --- | --- | --- |
| 高危（红） | Pc ≥ 1e-4 | |
| 警告（橙） | 1e-5 ≤ Pc < 1e-4 | |
| 关注（黄） | 1e-7 ≤ Pc < 1e-5 | |
| 数据不足（灰） | Pc < 1e-7 但 PcMax ≥ 1e-4 | 协方差不足以支撑「安全」结论 |

### 数据同步

- **Space-Track GP/TLE**：登录 + 单批全量 JSON 拉取仅 2 次 HTTP 请求，天然规避 2 秒/请求限流与 IP 封禁；同步后统计龄期中位数用于数据时效展示；
- **Starlink 公开星历**：解析 MANIFEST 清单，单轮最多 50 份（防全量拉取），`INSERT ... ON DUPLICATE KEY UPDATE`（sat_key 唯一键）增量覆盖；
- **OCM 星历解析**：同时支持 CCSDS OCM 3.0（TRAJ_REF_FRAME / COV_START~STOP / 分历元协方差）与 1.x 旧格式，参考系归一化 + 二分查找协方差，带 EOF 完整性校验（防超时截断文件入库）；
- 所有官方/上传星历统一入 `hs_ephem` 表，不落磁盘 bin 文件。

### AI 专家（LLM + 场景联动）

- 兼容 OpenAI 协议的 LLM 接入（火山方舟），后端经环境变量配置：`AI_API_BASE` / `AI_API_KEY` / `AI_MODEL` / `AI_MAX_TOKENS` 等；
- 前端 SSE 事件流协议：`meta`（轮次元数据）→ `phase`（阶段提示）→ `tool`（工具调用：编目统计/目标查询/联网检索）→ `delta`（正文增量）→ `action`（场景联动指令）→ `done`/`error` 收尾；
- `action` 指令反向驱动三维场景：定位卫星/空间站、打开指定面板并自动选中第一条威胁事件、切换星座展示；同一轮内已钉住的展示效果不会被晚到的 `clear_display` 清空。

### 前端工程

- Vue 3 组合式 API + TypeScript 严格模式 + Pinia + Element Plus + ECharts；
- vite 插件在 dev/build 时自动复制 three 的 draco 解码器、地球纹理与卫星模型、Cesium 引擎资源到 `public/`，无需手工维护；
- 跨组件通信走 `scene.ts` 的响应式通道（dockMode/heatMode/threatFocus 等），热力面板点击事件列表 → `threatLink` 总线 → BaseScene 绘制双星轨道线并将目标置为橙色威胁态。

## 四、平台使用指南

### 界面入口

| 入口 | 位置 | 功能 |
| --- | --- | --- |
| 「威胁热力图」 | 底部 dock | 打开威胁热力面板并在地球渲染威胁红云；点面板右上角倒三角键缩回面板（红云保留、按钮保持高亮），再点 dock 按钮整体退出 |
| 「AI专家」 | 底部 dock | 打开 AI 专家对话浮层，支持自然语言查询目标、解读威胁、联动场景 |
| 「初始化窗口」 | 底部 dock | 一键复位整个页面到初始状态 |
| 「太空目标列表」 | 左缘外拉 tag | 展开目标列表面板：星座卡片（Starlink/OneWeb/GPS…）+ 天宫/国际空间站卡片 |

### 威胁热力图面板

- **两个标签**：「卫星轨道威胁事件」（TLE×TLE 初筛，全星座）与「星历增强」（精密星历×TLE，协方差更紧）；
- **时间窗**：24h / 3d / 7d 切换，按天柱状图可点击筛选单日，再点取消；
- **等级芯片**：点击芯片隐藏/恢复对应等级的事件（含「数据不足」），计数与列表实时联动；
- **事件列表**：按 TCA 升序 + 关键词筛选（卫星名或 NORAD ID 双匹配）；点击某条事件 → 三维场景绘制两条轨道线、目标变橙色威胁态并镜头聚焦；点击地球红云同样可拾取定位；
- **数据时效**：面板顶部展示 TLE 同步时间 / 星历生成时间与龄期，数据异常时给出空状态卡与重试按钮。

### 目标列表与三维交互

- 星座卡片「位置展示」一键点亮该星座全部卫星；空间站卡片「位置展示」单独点亮天宫/ISS 专用模型并拉近镜头，再次点击恢复；
- 左下时间轴：播放/暂停、拖动时间、0.1x~60x 变速；左下复位按钮回到初始视角；
- 鼠标左键拖拽旋转、滚轮缩放；点击任意卫星/碎片拾取详情。

### AI 专家对话

- 输入自然语言（如「查询天宫最新过境」「未来一周星链交会风险」），AI 自动调用编目统计/目标查询/联网检索工具并流式作答；
- 回答中的联动动作会直接作用于三维场景（定位目标、打开热力面板、切换星座），实现「边问边看」。

## 五、部署方式

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **22.12（Windows x64）** | `server.jsc` 字节码与该运行时绑定，其他平台/版本会报 `cachedDataRejected` |
| MySQL | 8.x | 首次启动自动建库建表（67 张表 + 内置账号） |
| Docker | 可选 | 本地开发起 MySQL 容器（`docker-compose.dev.yml`，宿主机 13306） |

### 本地开发

```bash
# 1. 启动 MySQL
docker compose -f docker-compose.dev.yml up -d

# 2. 安装依赖（根目录=前端；server/ 与 heat-sidecar/ 各装一次）
npm install && npm --prefix server install && npm --prefix heat-sidecar install

# 3. 配置环境变量
cp .env.example .env
#    必配：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
#    AI 对话（可选）：AI_API_BASE / AI_API_KEY / AI_MODEL
#    生产必须：JWT_SECRET（随机长字符串，否则拒绝启动）

# 4. 启动三个服务
npm run dev:server                    # 主后端 1234
npm --prefix heat-sidecar run dev     # heat-sidecar 1236
npm run dev:all                       # 前端 vite 1233
```

- 前端：<http://localhost:1233>　接口文档：<http://localhost:1234/cgi-docs>
- 默认管理员 `admin / admin123456`（首次启动自动创建，请立即修改）
- vite 代理规则：`/cgi`、`/uploads` → 1234，`/cgi2` → 1236

### 生产部署（Docker）

```bash
# 前端镜像（nginx 托管 dist，/cgi /cgi2 /uploads 反代后端）
docker build -t openspace-web -f Dockerfile .
docker run -d -p 1233:1233 openspace-web

# heat-sidecar 镜像（无平台限制，任意 Linux 均可）
docker build -t openspace-heat -f heat-sidecar/Dockerfile heat-sidecar
docker run -d -p 1236:1236 --env-file .env openspace-heat

# 主后端：仓库内 server.jsc 为 Windows 编译，Linux 容器无法加载；
# 需以源码重编 Linux 版字节码后构建，详见 server/Dockerfile 头注释
```

> 生产建议：Windows 服务器直接用 `start-dev.cmd`（便携 Node 22.12.0）启动主后端，推荐 4C8G 以上配置；heat-sidecar 无平台限制，可独立部署到任意节点。

## 六、开源协议

本项目前端源码与 heat-sidecar 微服务采用 **[Apache License 2.0](./LICENSE)** 开源。

`server/*.jsc` 服务端字节码为闭源分发的可执行组件，不属于开源范围（可自由运行，不含源码）。

## 免责声明

本项目用于教学演示与科研交流。空间轨道数据与计算结果仅供参考，不得用于任何违反法律法规或危害国家与公共安全的用途。使用者自行承担因使用本项目产生的全部责任与风险。
