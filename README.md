# 开放空间安全平台（OpenSpace Safety Platform）

面向空间安全场景的一体化演示与研究平台：三维全球态势底座 + 碰撞预警 / 过境分析 / 区域评估 / 报告生成 / AI 智能体问答等能力。

前端（本仓库 `src/`）**完整开源**；服务端算法引擎（轨道计算、碰撞扫描、报告编排、AI 工具链等）以 **V8 字节码（`server/*.jsc`）** 形式分发——可直接运行，但不含源码。

## 功能总览

- **三维全球态势**：Three.js 地球场景，卫星星座、轨道、地面站、区域可视化
- **碰撞预警**：TLE/CDM 数据接入、接近事件计算与告警
- **过境分析**：目标对地面区域的过境窗口批量扫描（多进程并行）
- **区域评估 / AOE**：多区域任务规划与轨道库管理
- **报告生成**：docx 报告模板化生成（含图表渲染）
- **AI 智能体**：SSE 流式对话，接平台数据工具链
- **Swagger 接口文档**：`/cgi-docs`

## 环境要求

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 22.12 且 < 23** | 服务端字节码与 Node 大版本绑定，务必使用 Node 22 |
| MySQL | 8.x | 首次启动自动建库建表（67 张业务表 + 内置账号） |
| npm | 随 Node 22 分发 | 前后端各装一次依赖 |

## 快速开始

```bash
# 1. 安装依赖（根目录 = 前端；server/ = 后端）
npm install
npm --prefix server install

# 2. 配置环境变量：复制模板并填写数据库连接
cp .env.example .env
#    至少配置：DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
#    生产环境必须配置：JWT_SECRET（随机长字符串，否则拒绝启动）

# 3. 一键启动（后端 1234 + 前端 vite 5173）
npm run dev:all
```

启动后：

- 前端：<http://localhost:5173>
- 服务端接口：<http://localhost:1234/cgi>
- 接口文档：<http://localhost:1234/cgi-docs>
- 默认管理员：`admin / admin123456`（首次启动时自动创建并在控制台提示，请立即修改）

> 数据库无需手工初始化：服务启动时检测到空库会自动执行 `server/db/schema.sql` 建表并写入内置账号。

## 目录结构

```
├── src/                 # 前端源码（Vue 3 + Vite + Element Plus + Three.js）
├── public/              # 前端静态资源
├── server/
│   ├── index.cjs        # 服务端入口加载器（加载字节码）
│   ├── server.jsc       # 服务端主程序（V8 字节码，不可逆）
│   ├── *.worker.js/.jsc # 算法 worker（同上）
│   ├── db/schema.sql    # 全量建表 SQL（空库自举用）
│   └── public/          # 服务端公共资源（地理数据 / 上传目录）
├── Dockerfile           # 前端镜像（构建 dist 后由 nginx 托管）
├── server/Dockerfile    # 后端镜像
└── .env.example         # 环境变量模板（全量键位说明）
```

## 生产部署（Docker）

```bash
# 前端（构建上下文 = 仓库根）
docker build -t openspace-web -f Dockerfile .
docker run -d -p 1233:1233 openspace-web

# 后端（构建上下文 = server 目录）
docker build -t openspace-server -f server/Dockerfile server
docker run -d -p 1234:1234 \
  --env-file .env \
  -v $(pwd)/server/public/uploads:/repo/server/public/uploads \
  openspace-server
```

外层 nginx 将 `/cgi`、`/uploads` 反代到后端 1234，其余流量走前端静态容器 1233。

## 关于服务端字节码

- `server/*.jsc` 由 Node 22 的 V8 编译，**只能在 Node 22.x 上运行**（换大版本会报「invalid bytecode」）
- 字节码不含可读源码；`server/db/schema.sql` 保留了完整表结构，便于自建库与二次开发数据层
- 服务端对外契约完全由 `/cgi-docs` 的 OpenAPI 文档描述，前后端可独立开发

## 免责声明

本项目用于教学演示与科研交流。空间轨道数据与计算结果仅供参考，不得用于任何违反法律法规或危害国家与公共安全的用途。使用者自行承担因使用本项目产生的全部责任与风险。

## License

见 [LICENSE](./LICENSE)。
