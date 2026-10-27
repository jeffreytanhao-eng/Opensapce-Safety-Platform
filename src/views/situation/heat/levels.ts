/**
 * 安全热力等级档位（03 §15.4）：安全热力面板与星历分析窗共用。
 *
 * 默认用 heat/riskLevels.ts 的官方门限；heat-sidecar 就绪时用 /cgi2/meta 的
 * levels（label / color）覆盖展示文案，门限仍以核心为准，前端不参与分级。
 * 模块级缓存 10 分钟，两个面板各自挂载时只请求一次。
 */
import { computed, ref } from 'vue'
import { getHeat2Meta, type Heat2LevelBand } from '@/api/heat2'
import { PC_LEVELS, colorOfLevel, labelOfLevel, normalizeLevel, type HeatLevel } from './riskLevels'

const bands = ref<Record<string, Heat2LevelBand> | null>(null)
let loadedAt = 0
let inflight: Promise<void> | null = null

/** 四档定义（顺序即图例顺序：高危 → 警告 → 关注 → 数据不足） */
export const levelDefs = computed(() => PC_LEVELS.map((d) => {
  const m = bands.value?.[d.level]
  return { ...d, label: m?.label || d.label, color: m?.color || d.color }
}))

/** 等级 → 颜色 */
export function colorForLevel(lv: HeatLevel | null | undefined): string {
  if (!lv) return '#5a6b82'
  return levelDefs.value.find((d) => d.level === lv)?.color || colorOfLevel(lv)
}

/** 等级 → 中文标签 */
export function labelForLevel(lv: HeatLevel | null | undefined): string {
  if (!lv) return '—'
  return levelDefs.value.find((d) => d.level === lv)?.label || labelOfLevel(lv)
}

/** 拉取档位定义（失败静默沿用本地官方档位；10 分钟内不重复请求） */
export function loadHeatLevels(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 10 * 60_000) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const m = await getHeat2Meta()
      const list = Array.isArray(m.levels) ? m.levels : m.levels?.bands
      if (!list?.length) return
      const map: Record<string, Heat2LevelBand> = {}
      for (const b of list) {
        const k = normalizeLevel(b.key)
        if (k) map[k] = b
      }
      if (Object.keys(map).length) bands.value = map
    } catch {
      /* sidecar 未就绪：沿用本地官方档位 */
    } finally {
      loadedAt = Date.now()
      inflight = null
    }
  })()
  return inflight
}
