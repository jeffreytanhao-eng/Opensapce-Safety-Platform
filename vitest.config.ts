import { defineConfig } from 'vitest/config'

/**
 * 单元测试配置：只跑纯算法模块（星历坐标系 / 碰撞概率），不加载 Vue 组件与浏览器 API。
 */
export default defineConfig({
  // 缓存落在项目内，避免写入用户目录（受限环境会报错）
  cacheDir: 'node_modules/.vitest',
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.spec.ts']
  }
})
