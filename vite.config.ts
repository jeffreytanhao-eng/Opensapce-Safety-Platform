import { fileURLToPath, URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import zlib from 'node:zlib'
import viteCompression from 'vite-plugin-compression'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

/**
 * 复制 three 内置 draco 解码器到 public/draco。
 * 卫星 3D 模型（src/assets/map/type/*.glb|gltf）为 KHR_draco_mesh_compression 压缩，
 * DRACOLoader 需要 draco_decoder.js / draco_decoder.wasm / draco_wasm_wrapper.js。
 * dev：configureServer 写入 public（sirv 惰性读取，请求前完成即可）；
 * build：buildStart 写入 public，vite 的 copyPublicDir 会一并复制进 dist。
 */
function copyDracoDecoder(): Plugin {
  const src = fileURLToPath(new URL('./node_modules/three/examples/jsm/libs/draco', import.meta.url))
  const dest = fileURLToPath(new URL('./public/draco', import.meta.url))
  const copy = () => {
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true, force: true })
  }
  return { name: 'copy-draco-decoder', buildStart: copy, configureServer: copy }
}

/**
 * 复制 src/assets/map（地球纹理 + 卫星 3D 模型）到 public/map。
 * satellite.gltf 通过相对路径引用 satellite.bin，必须原样复制（不做 hash 重命名），
 * 页面用 BASE_URL + 'map/...' 引用，dev/build 均可用。
 */
function copyMapAssets(): Plugin {
  const src = fileURLToPath(new URL('./src/assets/map', import.meta.url))
  const dest = fileURLToPath(new URL('./public/map', import.meta.url))
  const copy = () => {
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true, force: true })
  }
  return { name: 'copy-map-assets', buildStart: copy, configureServer: copy }
}

/**
 * vite dev 模式启用 gzip 压缩（仅本地开发 / 直连 dev server 时生效）。
 * 生产前端已改为「构建期 vite build 出 dist + 容器内 nginx 托管」，走的是
 * vite-plugin-compression 预压缩 + nginx gzip_static，不再经这里；本插件保留给 dev 用。
 */
function devGzip() {
  const COMPRESSIBLE = /^(application\/javascript|application\/json|text\/|image\/svg\+xml)/
  return {
    name: 'dev-gzip',
    configureServer(server: ViteDevServer) {
      // pre hook：注册在 vite 内置中间件之前，先拦截 res.write/end，vite 处理完响应后统一 gzip
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        const accept = req.headers['accept-encoding']
        if (typeof accept !== 'string' || !accept.includes('gzip')) return next()

        const chunks: Buffer[] = []
        let shouldCompress = false
        const _write = res.write.bind(res)
        const _end = res.end.bind(res)

        const collect = (chunk: unknown) => {
          if (!chunk) return
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
        }
        // 首个数据到达时判定：content-type 可压缩、未被压缩过（避免后端 compression 已压缩的 /api 被二次压缩）、响应头尚未发送
        const judge = () => {
          if (shouldCompress) return
          const type = res.getHeader('content-type')
          const ce = res.getHeader('content-encoding')
          shouldCompress =
            !ce &&
            !res.headersSent &&
            typeof type === 'string' &&
            COMPRESSIBLE.test(type) &&
            !type.startsWith('text/event-stream') // SSE 是流式响应，缓冲后整体 gzip 会破坏实时推送
        }

        res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
          judge()
          if (!shouldCompress) return _write(chunk as never, encoding as never, cb as never)
          collect(chunk)
          if (typeof cb === 'function') (cb as () => void)()
          return true
        }) as ServerResponse['write']

        res.end = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
          judge()
          if (!shouldCompress) return _end(chunk as never, encoding as never, cb as never)
          collect(chunk)
          const body = Buffer.concat(chunks)
          res.removeHeader('Content-Length')
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Vary', 'Accept-Encoding')
          zlib.gzip(body, (err, gz) => {
            if (err) {
              _write(body)
              return _end(cb as never)
            }
            res.setHeader('Content-Length', gz.length)
            _write(gz)
            _end(cb as never)
          })
        }) as ServerResponse['end']

        next()
      })
    }
  }
}

/**
 * 从仓库根 .env 解析指定键（文件不存在或解析失败返回 ''）。
 * 唯一配置源：根 .env（模板见 .env.example，已被 gitignore）。
 */
function parseRootEnv(key: string): string {
  try {
    const p = fileURLToPath(new URL('./.env', import.meta.url))
    if (!existsSync(p)) return ''
    const m = readFileSync(p, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

/**
 * dev server 的代理目标（/api、/cgi、/uploads 转发到后端）。
 * 优先级：VITE_PROXY_TARGET 环境变量 > 根 .env 的 SERVER_HOST / BACK_PORT > 127.0.0.1:1234。
 *   - 本地连本地后端（推荐）：根 .env 写 SERVER_HOST=127.0.0.1；
 *   - 或临时覆盖：VITE_PROXY_TARGET=http://127.0.0.1:1234/ npm run dev
 * 注意：生产前端已改为 dist 静态包（容器内 nginx 托管），不再跑 dev server，
 * 该代理只在本地开发时使用，与部署无关。
 */
const SERVER_HOST = parseRootEnv('SERVER_HOST')
const PROXY_TARGET =
  process.env.VITE_PROXY_TARGET ||
  `http://${SERVER_HOST || '127.0.0.1'}:${parseRootEnv('BACK_PORT') || 1234}/`

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    vue(),
    devGzip(),
    copyDracoDecoder(),
    copyMapAssets(),
    // Element Plus 按需自动导入：模板里的 <el-xxx> 只引入用到的组件 JS，
    // 样式仍由 main.ts 全量引入 element-plus/dist/index.css（importStyle: false），
    // 避免按需样式在 dev/build 下产生切页即时编译；组件 <el-config-provider> 等也在此自动注册。
    // dirs: [] 关闭对 src/components 的自动全局注册（项目内组件均为显式 import），避免冲突。
    Components({
      dts: 'components.d.ts',
      dirs: [],
      resolvers: [ElementPlusResolver({ importStyle: false })]
    }),
    // 构建产物生成 .gz 预压缩文件（网关可直接下发，省 CPU）
    viteCompression({ algorithm: 'gzip', threshold: 1024 })
  ],
  // 部署到网关子路径（如 haproxy 的 /zxsd/）时，用 VITE_BASE=/zxsd/ 覆盖；
  // 不设置则部署在根路径。它决定 index.html 里的模块资源地址与 import.meta.env.BASE_URL
  //（vue-router 的 history base、draco / map 静态资源均依赖它）。
  base: process.env.VITE_BASE || '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    // 监听 0.0.0.0，允许局域网/公网通过服务器 IP 访问
    host: true,
    port: 1233,
    // vite 6 默认校验 Host 头，此处允许任意 Host（部署服务器公网 IP/域名时必需）
    allowedHosts: true,
    // 关闭 HMR 热更新的「服务端」WebSocket 服务。
    // 实测说明（vite 6.4.3）：hmr:false 只能让服务端不再起 ws server，并不会阻止客户端连接——
    // vite 仍会把 <script type="module" src="/@vite/client"> 注入 index.html，而该客户端是无条件
    // 发起 ws 连接的；又因这里没配 hmr.port / hmr.host，hmrPort 为 null 会触发「直连兜底」。
    // 于是生产部署在 haproxy 的 /zxsd/ 子路径下（页面走 https，前端容器是明文 1233、网关不透传
    // WebSocket 升级）时，控制台依旧会报：
    //   WebSocket connection to 'wss://example.com/zxsd/...' failed: Unexpected response code: 200
    //   WebSocket connection to 'wss://localhost:1233/zxsd/...' failed: ERR_CONNECTION_REFUSED
    // 即：本配置本身无法消除该报错；要彻底消除需移除注入的 /@vite/client 脚本，或让网关支持 WS 升级。
    // 业务代码不使用 WebSocket（消息推送走 SSE）。
    // 保留 hmr:false 的意义：不再提供热更新能力，改 src 下的代码（含代码生成写入的页面）后需手动刷新浏览器。
    hmr: false,
    proxy: {
      '/api': {
        //target: 'https://example.com/zxsd/server/',
        target: PROXY_TARGET,
        changeOrigin: false,
        // 后端未就绪时返回可识别的 502 JSON（避免前端收到无意义的 500 空响应）
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ code: 502, msg: '后端服务未就绪，请稍后重试', data: null }))
          })
        }
      },
      // 前台 / 免登录接口前缀（cgi 免鉴权），代理到后端 1234
      '/cgi': {
        //target: 'https://example.com/zxsd/server/',
           target: PROXY_TARGET,
        changeOrigin: false,
        // 语音识别流式识别走 WebSocket（/cgi/ai/asr/stream），必须开启 ws 透传升级请求
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ code: 502, msg: '后端服务未就绪，请稍后重试', data: null }))
          })
        }
      },
      
      // 静态库存储公开访问（大文件 Range 流式由后端 serve-static 支持）
      '/uploads': {
        //target: 'https://example.com/zxsd/server/',
           target: PROXY_TARGET,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ code: 502, msg: '后端服务未就绪，请稍后重试', data: null }))
          })
        }
      }
    }
  },
  // satellite.js v7 多线程 wasm 运行时（emscripten pthreads）内部用
  // `new Worker(new URL("index.js", import.meta.url), { type: "module" })` 创建 Worker，
  // 该 worker 脚本含 top-level await，iife 格式不支持；本项目无其他 Worker，
  // 全局改为 es 格式（与 type: "module" 一致），避免构建报错
  worker: {
    format: 'es'
  },
  build: {
    // satellite.js v7 的 wasm 运行时（#wasm-multi-thread）含 top-level await，
    // 构建目标需 >= es2022 才能编译（现代浏览器均支持，不影响兼容性）
    target: 'es2022',
    // satellite.js 的 wasm 运行时是 ESM，但 vite 会误判为 CommonJS 并以 iife 格式输出，
    // 而 iife 不支持 top-level await；排除后按 ESM 编译即可（es2022 目标支持 top-level await）
    commonjsOptions: {
      exclude: [/node_modules[\\/]satellite\.js/]
    },
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Element Plus 已改按需引入（见 main.ts / unplugin-vue-components），
          // 不再整包拆独立 chunk，交由 Rollup 按各页面的实际引用做代码分割。
          vendor: ['vue', 'vue-router', 'pinia', 'axios'],
          icons: ['@element-plus/icons-vue']
        }
      }
    }
  },
  // dev 依赖预构建同样需要 es2022 目标，否则 esbuild 编译 satellite.js 的 wasm 文件时报 top-level await 错误
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' }
  }
}))
