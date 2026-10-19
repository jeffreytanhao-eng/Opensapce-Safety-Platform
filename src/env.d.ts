/// <reference types="vite/client" />

// 打包成 App 时注入的公网后端地址（如 https://api.example.com），用于替换 /api 与 /cgi 相对前缀
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

// Element Plus 按需样式（副作用导入，无类型声明）：覆盖 main.ts / elPreload.ts 中的 style/css 导入
declare module 'element-plus/es/components/*/style/css'

// Three.js 子路径 addons 没有自带 .d.ts，Vite 实际能解析（指向 node_modules/three/examples/jsm/），
// TS 找不到类型时退化为 any；declare module 把整条子路径放开。
declare module 'three/addons/*'
