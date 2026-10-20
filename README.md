# 开源太空安全平台（OpenSpace Safety Platform）

面向空间安全场景的一体化演示与研究平台：**Cesium + Three.js 混合三维全球态势底座** + 碰撞预警 / 过境分析 / 区域评估 / 报告生成 / AI 智能体问答等能力。

前端（本仓库 `src/`）**完整开源**；服务端算法引擎（轨道计算、碰撞扫描、报告编排、AI 工具链等）以 **V8 字节码（`server/*.jsc`）** 形式分发——可直接运行，但不含源码。

## 功能总览

- **三维全球态势（Cesium + Three.js 混合底座）**
  - Cesium 承载高清地球影像与地理坐标底座，Three.js 叠加卫星星座 / 轨道 / 地面站 / 区域可视化
  - 星空背景（Tycho 星表 SkyBox）、日月透视修复，太阳不再穿透地球显示
  - 鼠标滚轮缩放、左键拖拽平移，默认视点定位东北亚，初始视野放大
  - 左下角复位按钮一键回到初始视角
- **太空安全目标列表（左侧面板）**：卫星目标清单，默认收起、外拉 tag 展开，展开后不遮挡复位按钮
- **太空安全专家（右侧 AI 面板）**：SSE 流式智能体对话，接平台数据工具链，默认收起、外拉 tag 展开
- **碰撞预警**：TLE/CDM 数据接入、接近事件计算与告警
- **过境分析**：目标对地面区域的过境窗口批量扫描（多进程并行）
- **区域评估 / AOE**：多区域任务规划与轨道库管理
- **报告生成**：docx 报告模板化生成（含图表渲染）
- **Swagger 接口文档**：`/cgi-docs`

## 技术栈

| 层 | 技术 |
| --- | --- |
| 三维引擎 | Cesium 1.146（地球底座）+ Three.js 0.185（卫星/轨道叠加层） |
| 前端 | Vue 3 + Vite 6 + TypeScript + Element Plus + ECharts + Pinia |
| 轨道计算 | satellite.js 7（wasm 多线程） |
| 后端 | Node 22 + V8 字节码（`server/*.jsc`） |
| 数据库 | MySQL 8 |

## 环境要求

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 22.12 且 < 23** | 服务端字节码与 Node 大版本绑定，务必使用 Node 22 |
| MySQL | 8.x | 首次启动自动建库建表（67 张业务表 + 内置账号） |
| Docker | 可选 | 本地开发用 `docker-compose.dev.yml` 起 MySQL 容器 |
| npm | 随 Node 22 分发 | 前后端各装一次依赖 |

> ⚠️ `server.jsc` 是 **Windows 版 Node 22.12.0** 编译的字节码：只能用 Node 22.12.0（Windows x64）加载，Linux 容器会报 `cachedDataRejected`（详见 `docker-compose.dev.yml` 头注释）。如系统装了其他 Node 大版本，可用便携版 Node 22.12.0 单独启动后端（见下文 `start-dev.cmd`）。

## 快速开始（本地开发）

```bash
# 1. 启动 MySQL 容器（宿主机端口 13306）
docker compose -f docker-compose.dev.yml up -d

# 2. 安装依赖（根目录 = 前端；server/ = 后端）
npm install
npm --prefix server install

# 3. 配置环境变量：复制模板并填写数据库连接
cp .env.example .env
#    至少配置：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
#    生产环境必须配置：JWT_SECRET（随机长字符串，否则拒绝启动）

# 4. 启动后端（端口 1234；Windows 下也可直接双击 start-dev.cmd）
npm run dev:server

# 5. 启动前端 vite dev server（端口 1233）
npm run dev:all   # 或 npm run dev:web 仅启前端
```

启动后：

- 前端：<http://localhost:1233>
- 服务端接口：<http://localhost:1234/cgi>
- 接口文档：<http://localhost:1234/cgi-docs>
- 默认管理员：`admin / admin123456`（首次启动时自动创建并在控制台提示，请立即修改）

> 数据库无需手工初始化：服务启动时检测到空库会自动执行 `server/db/schema.sql` 建表并写入内置账号。

### 开发注意事项

- vite 已配置 `hmr: false`：修改 `src/` 代码后**需手动刷新浏览器**（Ctrl+F5）
- vite 代理 `/api`、`/cgi`、`/uploads` 到后端（目标优先级：`VITE_PROXY_TARGET` > 根 `.env` 的 `SERVER_HOST`/`BACK_PORT` > `127.0.0.1:1234`）
- dev/build 时 vite 插件自动复制三类静态资源到 `public/`：three 的 draco 解码器、`src/assets/map` 地球纹理与卫星模型、Cesium 引擎资源（Assets/Workers/ThirdParty/Widgets），无需手工维护
- Cesium 引擎（约 10MB）构建时独立分包，经 `cesiumEarth.ts` 动态 import 惰性加载

## 目录结构

```
├── src/                          # 前端源码（Vue 3 + Vite + Element Plus + Cesium + Three.js）
│   └── views/situation/
│       ├── cesiumEarth.ts        # Cesium 地球底座封装
│       ├── starfield.ts          # 星空背景（Three.js）
│       ├── BaseScene.vue         # 三维场景主组件（卫星/轨道/交互）
│       ├── SatListPanel.vue      # 左侧「太空安全目标列表」面板
│       ├── AiChatDrawer.vue      # 右侧「太空安全专家」AI 对话面板
│       └── scene.ts / index.vue  # 场景逻辑与页面编排
├── public/                       # 前端静态资源（含构建时自动复制的 cesium/draco/map）
├── scripts/
│   └── build-terrain-tiles.mjs   # 地形瓦片切片脚本（npm run build:terrain）
├── server/
│   ├── index.cjs                 # 服务端入口加载器（加载字节码）
│   ├── server.jsc                # 服务端主程序（V8 字节码，不可逆）
│   ├── *.worker.js/.jsc          # 算法 worker（同上）
│   ├── db/schema.sql             # 全量建表 SQL（空库自举用）
│   └── public/                   # 服务端公共资源（地理数据 / 上传目录）
├── docker-compose.dev.yml        # 本地开发编排：MySQL 8 容器（13306）
├── start-dev.cmd                 # Windows 一键启动后端（便携 Node 22.12.0）
├── Dockerfile                    # 前端镜像（构建 dist 后由 nginx 托管）
├── server/Dockerfile             # 后端镜像（需 Linux 版字节码，见头注释）
└── .env.example                  # 环境变量模板（全量键位说明）
```

## 生产部署（Docker）

```bash
# 前端（构建上下文 = 仓库根）
docker build -t openspace-web -f Dockerfile .
docker run -d -p 1233:1233 openspace-web

# 后端（构建上下文 = server 目录）
# ⚠️ 仓库内 server.jsc 为 Windows 编译，Linux 容器无法加载；
#    容器化部署须先以源码重编 Linux 版字节码，详见 server/Dockerfile 头注释
docker build -t openspace-server -f server/Dockerfile server
docker run -d -p 1234:1234 \
  --env-file .env \
  -v $(pwd)/server/public/uploads:/repo/server/public/uploads \
  openspace-server
```

外层 nginx 将 `/cgi`、`/uploads` 反代到后端 1234，其余流量走前端静态容器 1233。

## 关于服务端字节码

- `server/*.jsc` 由 Windows 版 Node 22.12.0 的 V8 编译，**只能在配套运行时上运行**（换大版本或平台会报 `invalid bytecode` / `cachedDataRejected`）
- 字节码不含可读源码；`server/db/schema.sql` 保留了完整表结构，便于自建库与二次开发数据层
- 服务端对外契约完全由 `/cgi-docs` 的 OpenAPI 文档描述，前后端可独立开发

## 免责声明

本项目用于教学演示与科研交流。空间轨道数据与计算结果仅供参考，不得用于任何违反法律法规或危害国家与公共安全的用途。使用者自行承担因使用本项目产生的全部责任与风险。

## License

见 [LICENSE](./LICENSE)。
