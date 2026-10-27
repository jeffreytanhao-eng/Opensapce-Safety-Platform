/**
 * 私有核心加载器（03 §7.2）
 *
 *  - 配置了 HEAT_CORE_PATH：加载外部模块（.js / .cjs / bytenode 的加载器 .cjs），
 *    校验 apiVersion 与 selfTest，失败时按 HEAT_CORE_REQUIRED 决定是否退出；
 *  - 未配置：使用随 sidecar 一起部署的内置引擎（当前实现），状态记为 ready / bundled。
 *
 * 只记录错误码，不打印私有模块源码或堆栈。
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { HeatCore, HeatCoreFactory } from './contract.js'
import { createStubCore } from './stub.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

const log = logger('core')

export interface CoreState {
  core: HeatCore
  status: 'ready' | 'stub' | 'error'
  /** bundled = 随 sidecar 部署的内置引擎（未配置 HEAT_CORE_PATH）；external = 私有核心；stub = 空实现 */
  kind: 'bundled' | 'external' | 'stub'
  name: string
  version: string
  reason?: string
}

let state: CoreState = {
  core: createStubCore(),
  status: 'stub',
  kind: 'stub',
  name: 'stub',
  version: '0',
  reason: 'CORE_NOT_LOADED'
}

export function getCoreState(): CoreState {
  return state
}

export function coreReady(): boolean {
  return state.status === 'ready'
}

export async function loadHeatCore(): Promise<CoreState> {
  const p = config.HEAT_CORE_PATH
  if (!p) {
    // 内置引擎：算法随 sidecar 部署（私有核心交付时改为配置 HEAT_CORE_PATH 并移除内置实现）
    state = { core: createStubCore(), status: 'ready', kind: 'bundled', name: 'bundled', version: '1.0.0' }
    log.info('未配置 HEAT_CORE_PATH，使用内置引擎（bundled）')
    return state
  }
  try {
    const mod = p.endsWith('.cjs')
      ? createRequire(import.meta.url)(p)
      : await import(pathToFileURL(p).href)
    const factory: HeatCoreFactory = mod.createHeatCore ?? mod.default?.createHeatCore ?? mod.default
    const core = await factory()
    if (core?.apiVersion !== 1) throw new Error('CORE_API_MISMATCH')
    const st = await core.selfTest()
    if (!st.ok) throw new Error('CORE_SELFTEST_FAILED')
    state = { core, status: 'ready', kind: 'external', name: core.name, version: core.version }
    log.info(`私有核心已加载：${core.name} ${core.version}`)
    return state
  } catch (e) {
    const reason = String((e as Error).message).slice(0, 60)
    if (config.HEAT_CORE_REQUIRED) throw e
    log.error(`私有核心加载失败：${reason}`)
    state = { core: createStubCore(), status: 'error', kind: 'stub', name: 'stub', version: '0', reason }
    return state
  }
}
