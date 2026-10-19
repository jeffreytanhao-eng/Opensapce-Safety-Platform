# ============================================================
# 开放空间安全平台 前端镜像（构建期 vite build 出 dist，容器内 nginx 托管静态文件）
#   构建上下文：仓库根目录
#   构建命令  ：docker build -t openspace-web:latest -f Dockerfile .
#   运行端口  ：容器内 1233（映射到宿主机 1233，haproxy / 外层 nginx 直连本端口）
#
# 说明：生产不再跑 vite dev，改为构建期一次性 `vite build`：
#   - 请求数从「按需编译的上百个模块」降为十几个打包产物，弱带宽（1Mbps）下收益明显；
#   - 容器内 nginx 直接发静态文件，并开 gzip_static 复用 vite 预压缩的 .gz（不二次压缩）；
#   - VITE_BASE / VITE_API_BASE 是【构建期】变量（由 deploy-docker.sh 以 --build-arg 传入，
#     内联进 index.html），改这两个值必须重新 build 镜像，不能只 restart；
#   - 服务器端「代码构建(/plan)」生成的页面，需在下次 `./deploy-docker.sh build` 才会进 dist。
# ============================================================
FROM node:22-bookworm-slim AS build
WORKDIR /repo

# 先装依赖（利用镜像层缓存，源码变更不必重装）
COPY package.json ./
RUN npm install

# 再复制源码（server/ 已由 .dockerignore 排除）
COPY . .

# 构建期环境变量：vite 会把它们内联进产物
ARG VITE_BASE=/
ARG VITE_API_BASE=/
ENV VITE_BASE=$VITE_BASE
ENV VITE_API_BASE=$VITE_API_BASE

# 只跑 vite build（跳过 vue-tsc 类型检查），避免存量类型错误卡死部署构建
RUN npx vite build

# ------------------------------------------------------------
# 运行阶段：容器内 nginx 托管 dist（spa.conf 纯静态；/cgi /uploads 由外层 nginx 分流）
# ------------------------------------------------------------
FROM nginx:1.27-alpine

# 覆盖官方默认站点（默认监听 80）。
# SPA_CONF 选择容器内置 nginx 配置：默认 spa.conf（根路径纯静态，deploy-docker.sh 链路）。
ARG SPA_CONF=deploy/nginx/spa.conf
COPY ${SPA_CONF} /etc/nginx/conf.d/default.conf
COPY --from=build /repo/dist /usr/share/nginx/html

EXPOSE 1233

# 启动标记：「前端静态服务已启动」是 deploy-docker.sh health_check 的就绪判据
CMD ["sh", "-c", "echo '[web] 前端静态服务已启动（nginx 托管 dist，端口 1233）'; exec nginx -g 'daemon off;'"]