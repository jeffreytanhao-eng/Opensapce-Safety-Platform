/** 默认实现（stub）：只用公开档位，不含任何私有逻辑（03 §7.3） */
import { HeatCoreError, type HeatCore } from './contract.js'

export function createStubCore(): HeatCore {
  return {
    apiVersion: 1,
    name: 'stub',
    version: '0',
    capabilities: [],
    async selfTest() {
      return { ok: true }
    },
    levels() {
      return {
        missMaxKm: Number(process.env.MISS_MAX_KM ?? 10),
        bands: [
          { key: 'red', label: '高危', color: '#ff4d4f', min: 1e-4, max: null },
          { key: 'orange', label: '警告', color: '#ff9f43', min: 1e-5, max: 1e-4 },
          { key: 'yellow', label: '关注', color: '#ffd24d', min: 1e-7, max: 1e-5 },
          { key: 'insufficient', label: '数据不足', color: '#8e9aab', min: null, max: null }
        ]
      }
    },
    async screen() {
      throw new HeatCoreError('CORE_NOT_LOADED', '核心算法模块未加载')
    }
  }
}
