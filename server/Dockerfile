# ============================================================
# 开放空间安全平台 后端镜像（Node/Express API + SSE 语音流）
#   构建上下文：server 目录
#   构建命令  ：docker build -t openspace-server:latest -f server/Dockerfile server
#   运行端口  ：容器内 1234（映射到宿主机 1234，由 nginx 反代 /cgi /uploads）
#
# 配置说明：全项目唯一配置源是仓库根 .env（模板 .env.example）。
#   deploy-docker.sh 以 --env-file 在【运行时】注入容器，凭据不进镜像；
#   .dockerignore 已排除一切 .env* 文件，镜像与仓库均可安全开源。
#
# 运行时需挂载（容器重建不丢数据）：
#   server/public/uploads  → /repo/server/public/uploads （上传文件 / 算法桶 / 数据库备份）
#   server/modules         → /repo/server/modules        （代码生成写入的模块描述文件）
#   src                    → /repo/src                   （代码生成写入的前端页面）
# ============================================================
# ⚠️ 实测结论：server.jsc 是 Windows 版 Node 22.12.0 编译的 V8 字节码，
# 其 cachedData 头部 roChecksum（只读堆校验和）绑定「构建平台」，与 flags 无关：
# Linux 官方镜像（node:22.12.0 / 22.23.x 等任何小版本）均报 cachedDataRejected。
# 本文件仅供将来拿到源码重编 Linux 字节码时参考，当前后端在宿主机直跑（见 start-dev.cmd）。
FROM node:22.12.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /repo/server

# 报告图表（@napi-rs/canvas）依赖系统 fontconfig + 中文字体：不装则图内中文渲染为空白。
# util-linux 提供 taskset：进程 CPU 亲和性绑核（算法 worker / 主进程分核，见 lib/processPriority.js）。
# 放在最前面（不随源码变动）以复用层缓存。
#
# 这里必须用国内 apt 源：fonts-noto-cjk 单个包就有 56MB，走默认的 deb.debian.org（境外）
# 实测要 10 分钟以上（有效带宽 <1Mbps），换国内源通常几十秒。
# 留空 APT_MIRROR（--build-arg APT_MIRROR=）则沿用 Debian 官方源，便于境外服务器构建。
# 注意：改动 APT_MIRROR 的值会使本层缓存失效（会重新下载一次字体）。
ARG APT_MIRROR=mirrors.aliyun.com
RUN set -eux; \
  if [ -n "$APT_MIRROR" ]; then \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do \
      if [ -f "$f" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" "$f"; fi; \
    done; \
    echo "apt 源已切换为: $APT_MIRROR（下面 apt-get update 的 Get: 行可核对）"; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk util-linux; \
  rm -rf /var/lib/apt/lists/*

# 先装依赖（server/package.json 无 devDependencies）
COPY package.json ./
RUN npm install --omit=dev

# 再复制源码（.env* 已被 .dockerignore 排除，凭据不进镜像；public/uploads 运行时挂载）
COPY . .

EXPOSE 1234

CMD ["node", "index.cjs"]
