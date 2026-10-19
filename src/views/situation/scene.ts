/**
 * 星座总览 /situation 共享 store（单一真实来源）
 *
 * 原 situation/index.vue 过于厚重，现拆分为：基础场景(BaseScene) / 卫星列表(SatListPanel) /
 * 星座列表(ConstellationPanel) / 碰撞热力(CdmHeatmap)。本模块集中持有：
 *  - 全部坐标转换 / 格式化常量与工具（唯一出处：ECI → Three.js 场景单位）
 *  - THREE 资源持有对象 g（非响应式，渲染器/场景/相机/controls/InstancedMesh/过滤轨道线等）
 *  - 跨组件共享的响应式状态（载入进度、选中卫星、过滤条件、dock 面板、卫星/星座列表数据等）
 *
 * 约定：组件间通过 import 本 store 共享状态；纯动作（如收起面板）仍由父组件 index.vue 编排，
 * 子组件用 props + emit + expose 通信，必要时直接读写 store。
 */
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ConstellationPoint, SatTleItem, ConstellationItem } from '@/api/satTypes'
import type { CdmHeatEvent, ConjBatchItem, HeatDayGroup, HeatLegendItem, SatOfConstellation, SatSource } from '@/api/sat_public'
import type { LaunchSiteItem, LaunchUpcomingItem, LaunchRecordItem } from '@/api/launch_public'
import type { SpaceWeatherResult } from '@/api/space_weather_public'
import type { ConjEllipsoidResult } from '@/api/sat_public'
import type { PassBatchItem, PassBorderItem, PassCityDetail, PassCityItem, PassDistrictItem, PassTargetItem } from '@/api/pass_public'
import { twoline2satrec } from 'satellite.js'

/* ============================================================
 * 常量 / 坐标换算
 * ============================================================ */
export const EARTH_RADIUS_KM = 6371
export const EARTH_R = 1
export const KM_TO_SCENE = EARTH_R / EARTH_RADIUS_KM
export const BASE = import.meta.env.BASE_URL || '/'

/* ============================================================
 * 静态资源分发：优先 COS、失败回退本地（单一真实来源）
 * ------------------------------------------------------------
 * 后端 /cgi/config 的 staticBase 下发 COS 基址（未配置 COS 时为空串）；
 * 首次需要资源时拉取一次并缓存，之后 map/**、draco/** 一律优先走 COS，
 * 任一资源加载失败自动回退本地 BASE —— COS 不可达/未配置时行为与改造前完全一致。
 * ============================================================ */
/** API 基础地址（与 utils/request.ts 的 API_BASE 同口径；不引入 axios/router 依赖） */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ?? ''
/** 运行时 COS 静态基址（带末尾 /）；空串 = 未启用，全部走本地 */
export const cosBase = ref('')
let assetBasePromise: Promise<string> | null = null

/** 探测 COS 静态基址是否可用（HEAD 一个必然已同步的资源；CORS 已放行 GET/HEAD） */
async function probeAssetBase(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}map/type/satellite.gltf`, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

/** 拉取 /cgi/config 的 staticBase 并探测可达性，就绪后写入 cosBase；幂等（并发只发一次）。
 *  任何失败都静默返回 ''，资源照常走本地。 */
export function ensureAssetBase(): Promise<string> {
  if (assetBasePromise) return assetBasePromise
  assetBasePromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/cgi/config`, { headers: { Accept: 'application/json' } })
      if (!res.ok) return ''
      const body = await res.json()
      const base = String(body?.data?.staticBase || body?.staticBase || '')
      if (!base) return ''
      if (await probeAssetBase(base)) {
        cosBase.value = base
        return base
      }
    } catch {
      /* 前台静默：COS 不可用时一切走本地 */
    }
    return ''
  })()
  return assetBasePromise
}

/** 把本地 BASE 下的资源 URL 映射为「COS 优先」URL；未启用 COS 或非本地资源时原样返回 */
export function cdnUrl(localUrl: string): string {
  const cb = cosBase.value
  if (!cb || !localUrl || !localUrl.startsWith(BASE)) return localUrl
  return cb + localUrl.slice(BASE.length)
}

export const TYPE_COLOR: Record<string, number> = {
  PAYLOAD: 0xff4d4f, DEBRIS: 0x9fb0c0, 'ROCKET BODY': 0x3f9dff, UNKNOWN: 0xffd54f
}
export const TYPE_LABEL: Record<string, string> = {
  PAYLOAD: '载荷卫星', DEBRIS: '空间碎片', 'ROCKET BODY': '火箭箭体', UNKNOWN: '未知物体'
}
export const TYPE_MODEL: Record<string, string> = {
  PAYLOAD: `${BASE}map/type/satellite.gltf`,
  DEBRIS: `${BASE}map/type/gltf/debris_low.gltf`,
  'ROCKET BODY': `${BASE}map/type/gltf/rocket_body_low.gltf`,
  UNKNOWN: `${BASE}map/type/unknow.glb`
}
/** 图例：类型 -> 颜色 + 标题 + 亮色（右下角） */
export const LEGEND = [
  { type: 'PAYLOAD', label: '载荷卫星', color: '#ff4d4f', desc: '在轨工作航天器' },
  { type: 'DEBRIS', label: '空间碎片', color: '#9fb0c0', desc: '失控碎片/残骸' },
  { type: 'ROCKET BODY', label: '火箭箭体', color: '#3f9dff', desc: '末级/运载结构' },
  { type: 'UNKNOWN', label: '未知物体', color: '#ffd54f', desc: '未分类目标' }
]
export const TYPE_KEYS = ['PAYLOAD', 'DEBRIS', 'ROCKET BODY', 'UNKNOWN']
/** 轨道区域（与 mui/sat_constellation/list.vue 的 REGIME_OPTIONS 一致），供卫星列表面板勾选过滤 */
export const REGIME_KEYS = ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']
export const REGIME_LABEL: Record<string, string> = {
  LEO: 'LEO', MEO: 'MEO', GEO: 'GEO', HEO: 'HEO', OTHER: '其他'
}
/** 光照档中文（与 server/lib/illumination.js 的 twilightLevel 一一对应，供过境类面板共用） */
export const TWILIGHT_LABEL: Record<string, string> = {
  day: '昼', civil: '民用暮光', nautical: '航海暮光', astronomical: '天文暮光', night: '夜'
}
/** 目标地影状态中文（对应 illumination.js 的 shadowState：sunlit / penumbra / umbra） */
export const SHADOW_LABEL: Record<string, string> = {
  sunlit: '日照', penumbra: '半影', umbra: '本影'
}

/* ============================================================
 * 空间环境 / 天体图层开关（右下角图例）
 *  - 开关只控制「显隐」，不触发任何重新计算或请求；默认值见 skyLayers
 *  - 需要数据才有内容的图层（极光椭圆环、太阳风、误差椭球、星下点轨迹）：
 *    数据/选中未就绪时该图层不绘制，开关状态保持用户的选择
 * ============================================================ */
export type SkyLayerKey = 'sun' | 'moon' | 'mansion' | 'constellation' | 'aurora' | 'solarWind' | 'dipole' | 'shadowCone' | 'groundTrack' | 'ellipsoid'
/** 图层默认开关：太阳 / 月亮 / 地影锥 默认开启；
 *  三垣二十八宿、西方 88 星座、极光椭圆环、地磁偶极磁力线、星下点轨迹、误差椭球、太阳风粒子流默认关闭
 *  （三垣二十八宿 / 西方 88 星座是「认识星空」的观感层，但星点多、连线密，两套又互为不同体系，易混淆，故默认关闭）；
 *  （其余默认关闭者只在「选中卫星 / 选中交会事件」时才有内容，极光 / 偶极 / 粒子流属空间环境示意、易干扰观察）
 *  ——都可在图例里手动打开。 */
export const skyLayers = reactive<Record<SkyLayerKey, boolean>>({
  sun: true, moon: true, shadowCone: true, mansion: false, constellation: false,
  aurora: false, dipole: false, groundTrack: false, ellipsoid: false, solarWind: false
})

/** 当前画质档（由 BaseScene 运行时同步：静态硬件探测 + 帧率自适应降档后的真实档位）。
 *  用途：图例上标注「该图层被当前画质档主动隐藏」—— 否则开关亮着却看不到东西，
 *  使用者会以为功能坏了（地影锥在低档就是被隐藏的，见 BaseScene.updateSky）。 */
export const sceneQualityTier = ref<QualityTier>('high')

/** 低画质档隐藏地影锥时，是否由用户强制显示。
 *  低档隐藏它的理由是「大面积半透明几何的 overdraw」；使用者明确需要时（判断卫星是否进地影）
 *  可自行覆盖，代价是低端机可能出现掉帧。 */
export const shadowConeForce = ref(false)
/** 图例图层适用的视图模式（图例按当前模式过滤，不适用的图层整行不展示）：
 *  normal = 卫星云 / 星座轨道视图；heat = 碰撞热力视图；pass = 过境分析视图（城市 / 区域） */
export type SkyViewMode = 'normal' | 'heat' | 'pass'
/** 三类视图都适用的图层（天体 / 空间环境：与所选模式无关） */
const ALL_VIEW_MODES: SkyViewMode[] = ['normal', 'heat', 'pass']
/** 图例中的图层行：数组顺序即展示顺序（先默认开启的，再默认关闭的）；
 *  modes 声明该图层在哪些视图下有意义 —— 例如「误差椭球」只来自交会事件，只有碰撞热力视图才有内容，
 *  「星下点轨迹」需要选中卫星（卫星云视图的主交互），这两类就不在无关视图里占位。 */
export const SKY_LAYER_ITEMS: { key: SkyLayerKey; label: string; desc: string; dotClass: string; modes: SkyViewMode[] }[] = [
  { key: 'sun', label: '太阳', desc: '光照方向', dotClass: 'lg-sun', modes: ALL_VIEW_MODES },
  { key: 'moon', label: '月亮', desc: '月相', dotClass: 'lg-moon', modes: ALL_VIEW_MODES },
  { key: 'shadowCone', label: '地影锥', desc: '本影 / 半影', dotClass: 'lg-shadow', modes: ALL_VIEW_MODES },
  { key: 'mansion', label: '三垣二十八宿', desc: '三垣 · 四象 · 距星', dotClass: 'lg-mansion', modes: ALL_VIEW_MODES },
  { key: 'constellation', label: '西方88星座', desc: 'IAU 88 天区 · 连线', dotClass: 'lg-constellation', modes: ALL_VIEW_MODES },
  { key: 'aurora', label: '极光椭圆环', desc: '按 Kp', dotClass: 'lg-aurora', modes: ALL_VIEW_MODES },
  { key: 'dipole', label: '地磁偶极磁力线', desc: 'IGRF 偶极 · 按 Kp', dotClass: 'lg-dipole', modes: ALL_VIEW_MODES },
  { key: 'groundTrack', label: '星下点轨迹', desc: '选中卫星', dotClass: 'lg-track', modes: ['normal'] },
  { key: 'ellipsoid', label: '误差椭球', desc: '经验 σ', dotClass: 'lg-ellip', modes: ['heat'] },
  { key: 'solarWind', label: '太阳风粒子流', desc: '速度 / Bz', dotClass: 'lg-wind', modes: ALL_VIEW_MODES }
]

/** 误差椭球的最小可见尺寸（场景单位，1 单位 = 6371 km）：
 *  真实 σ 在 LEO 常见量级只有 10~100 km ≈ 0.002~0.016 单位，真按实际比例画在默认机位下完全看不见。
 *  故三维里统一放大到「最大轴不小于该值」再显示，并在界面标注放大倍数（真实 σ 数值见右侧面板）。
 *  口径只在本处定义，三维绘制与面板文案共用（见 covDisplayScale）。 */
export const COV_MIN_AXIS_SCENE = 0.06

/** 由三轴 σ（km）算三维显示所需的放大倍数（≥1；1 表示按真实比例） */
export function covDisplayScale(sigmasKm: number[]): number {
  const maxKm = Math.max(0, ...sigmasKm.filter((v) => Number.isFinite(v)))
  const maxScene = maxKm / EARTH_RADIUS_KM
  if (!(maxScene > 0)) return 1
  return Math.max(1, COV_MIN_AXIS_SCENE / maxScene)
}

/** 当前选中交会事件两端的经验误差椭球（三维绘制 + 详情面板展示共用；null = 未选中/无数据） */
export const conjEllipsoid = shallowRef<ConjEllipsoidResult | null>(null)
export const conjEllipsoidError = ref('')
export const conjEllipsoidLoading = ref(false)

/* ============================================================
 * 空间环境数据（/cgi/space_weather 定时拉取）
 *  驱动：极光椭圆环大小/亮度（Kp）、太阳风粒子流速度/密度、以及图例上的地磁暴徽标。
 *  仅用于展示；不参与任何误差模型（当前 σ 为伪值，分层须等真实观测残差）。
 * ============================================================ */
export const spaceWeather = shallowRef<SpaceWeatherResult | null>(null)
export const spaceWeatherError = ref('')
export const spaceWeatherLoading = ref(false)
/** 上次成功拉取时刻（ms） */
export const spaceWeatherAt = ref(0)
/** 类型 -> 十六进制颜色（CSS，供左侧列表圆点 / 类型标签着色），与 TYPE_COLOR 保持一致 */
export const TYPE_HEX: Record<string, string> = {
  PAYLOAD: '#ff4d4f', DEBRIS: '#9fb0c0', 'ROCKET BODY': '#3f9dff', UNKNOWN: '#ffd54f'
}

/* ============================================================
 * 卫星型号库：把「卫星管理」里的 gltf 素材关联到点云
 *  - 星座名 / object_name 关键词 → 型号（如 星链 → starlink、Iridium 100+ → iridium_next）
 *  - 每个型号在 src/assets/map/type/gltf 下按 LOD 分档（low/med/high，三角形数递增）
 *  - 由 BaseScene 按「画质档位 + 相机距地距离 + 可见卫星数」决定当前使用哪一档，
 *    实现「先粗后精」：首屏/远景统一 low 快速出图，拉近且数量可控时逐级升到 med/high
 *  - 粗类型（TYPE_KEYS 的 4 分类）仍用于图例显隐 / 轨道线配色 / 列表筛选；型号只决定模型文件
 * ============================================================ */
/** 模型 LOD 档位（三角形数由少到多） */
export type ModelLod = 'low' | 'med' | 'high'
/** 档位升序（取档回退用） */
export const MODEL_LOD_ORDER: ModelLod[] = ['low', 'med', 'high']
/** 三档齐全的型号（占绝大多数） */
const LOD_FULL: ModelLod[] = ['low', 'med', 'high']
/** 型号 -> 可用档位（升序）。素材缺档时 modelUrlOf 回退到最接近的可用档
 *  （spacebee 无 low 档 → 低档回退 med），保证任意档位都能取到模型。 */
export const MODEL_LODS: Record<string, ModelLod[]> = {
  starlink: LOD_FULL, oneweb: LOD_FULL, iridium: LOD_FULL, iridium_next: LOD_FULL,
  orbcomm1: LOD_FULL, orbcomm2: LOD_FULL, flock: LOD_FULL, lemur1: LOD_FULL,
  lemur2: LOD_FULL, worldview1: LOD_FULL, worldview23: LOD_FULL, satellite: LOD_FULL,
  rocket_body: LOD_FULL, debris: LOD_FULL,
  fengyun: LOD_FULL, kuiper: LOD_FULL, meteor: LOD_FULL, qianfan: LOD_FULL,
  yaogan: LOD_FULL, guowang: LOD_FULL, intelsat: LOD_FULL, glonass: LOD_FULL,
  globalstar: LOD_FULL, gps: LOD_FULL, beidou: LOD_FULL, geely: LOD_FULL,
  spacebee: ['med', 'high']
}
/** 型号 -> 粗类型（4 分类）：图例显隐 / 轨道线配色 / 热力·过境显隐仍按粗类型走 */
export const MODEL_COARSE: Record<string, string> = {
  starlink: 'PAYLOAD', oneweb: 'PAYLOAD', iridium: 'PAYLOAD', iridium_next: 'PAYLOAD',
  orbcomm1: 'PAYLOAD', orbcomm2: 'PAYLOAD', flock: 'PAYLOAD', lemur1: 'PAYLOAD',
  lemur2: 'PAYLOAD', spacebee: 'PAYLOAD', worldview1: 'PAYLOAD', worldview23: 'PAYLOAD',
  satellite: 'PAYLOAD',
  fengyun: 'PAYLOAD', kuiper: 'PAYLOAD', meteor: 'PAYLOAD', qianfan: 'PAYLOAD',
  yaogan: 'PAYLOAD', guowang: 'PAYLOAD', intelsat: 'PAYLOAD', glonass: 'PAYLOAD',
  globalstar: 'PAYLOAD', gps: 'PAYLOAD', beidou: 'PAYLOAD', geely: 'PAYLOAD',
  debris: 'DEBRIS', rocket_body: 'ROCKET BODY', unknow: 'UNKNOWN'
}
/** 粗类型 -> 型号键：碎片 / 箭体 / 载荷均走分档素材（debris_* / rocket_body_* / 各星座型号_*），
 *  统一由 modelUrlOf 按档位拼 URL；只有未知物体仍沿用原有单文件模型 unknow.glb。
 *  未被识别出具体型号的载荷回退到通用卫星模型 satellite。 */
export const COARSE_MODEL: Record<string, string> = {
  PAYLOAD: 'satellite', DEBRIS: 'debris', 'ROCKET BODY': 'rocket_body', UNKNOWN: 'unknow'
}
/** 型号 + 档位 -> 模型 URL。gltf 素材由 vite 原样复制到 public/map（见 vite.config.ts 的
 *  copyMapAssets），故与 satellite.gltf 一样可直接按 URL 加载，无需 import。 */
export function modelUrlOf(model: string, lod: ModelLod): string {
  // 未知物体：无 LOD 分档，沿用原有单文件模型
  if (model === 'unknow') return TYPE_MODEL.UNKNOWN
  const lods = MODEL_LODS[model] || LOD_FULL
  let use = lod
  if (!lods.includes(lod)) {
    // 缺档回退：优先退到更低档（三角形更少、代价更小），没有更低档才往高取
    const wi = MODEL_LOD_ORDER.indexOf(lod)
    use = MODEL_LOD_ORDER.find((l, i) => i < wi && lods.includes(l)) ||
      MODEL_LOD_ORDER.find((l, i) => i > wi && lods.includes(l)) || lods[0]
  }
  return `${BASE}map/type/gltf/${model}_${use}.gltf`
}
/** 不做头尾翻转的型号：碎片 / 箭体 / 未知物体没有固定机头（机头朝哪都一样），
 *  且本身带有缓慢翻滚（见 BaseScene 的 tumble），故保持素材原朝向。
 *  其余型号（全部卫星型号 + 通用卫星模型 satellite）统一绕本地 Y 轴翻转 180°：
 *  这些素材的机身头部朝向本地 -Z，与「本地 +Z 对齐天顶、背离地球」的姿态约定相反，
 *  翻转后头部朝 +Z，与约定一致（本地 +Y 仍对齐飞行方向，故飞行方向不受影响）。 */
export const MODEL_NO_FLIP_Y: ReadonlySet<string> = new Set(['debris', 'rocket_body', 'unknow'])
/** Iridium 一/二代：Space-Track 里 NEXT 编号 ≥ 100（如 IRIDIUM 133），第一代编号 < 100（如 IRIDIUM 33） */
function iridiumGen(name: string): string {
  const m = /IRIDIUM[ -]?(\d+)/.exec(name)
  return m && Number(m[1]) >= 100 ? 'iridium_next' : 'iridium'
}
/** Orbcomm 一/二代：FM101+ / OG2 为第二代，FM1~FM43 为第一代 */
function orbcommGen(name: string): string {
  if (name.includes('OG2')) return 'orbcomm2'
  const m = /ORBCOMM[ -]*(?:FM[ -]*)?(\d+)/.exec(name)
  return m && Number(m[1]) >= 100 ? 'orbcomm2' : 'orbcomm1'
}
/** 卫星 -> 型号键（决定用哪套模型）。
 *  优先级：星座名（后端下发的中文名，归属准确）→ object_name 关键词兜底
 *  （覆盖星座种子表未收录的 Spire Lemur / SpaceBee / DigitalGlobe WorldView）。
 *  粗类型非 PAYLOAD 的按 COARSE_MODEL 取型号键：碎片 / 箭体走分档素材，
 *  未知物体沿用单文件 unknow.glb。 */
export function resolveModelKey(p: { object_type?: string; object_name?: string; cons?: string[] }): string {
  const ot = p.object_type || ''
  // 与旧口径一致：仅 PAYLOAD / DEBRIS / ROCKET BODY / UNKNOWN 四个粗类型有效，其余归为 UNKNOWN
  const coarse = TYPE_MODEL[ot] ? ot : 'UNKNOWN'
  if (coarse !== 'PAYLOAD') return COARSE_MODEL[coarse]
  const name = (p.object_name || '').toUpperCase()
  const cons = p.cons || []
  const has = (s: string) => cons.includes(s)
  if (has('星链')) return 'starlink'
  if (has('OneWeb')) return 'oneweb'
  if (has('Iridium')) return iridiumGen(name)
  if (has('Orbcomm')) return orbcommGen(name)
  if (has('Flock')) return 'flock'
  // 规模较大的星座（数量从多到少）—— 各自生成专属模型，避免统一回退到通用卫星模型
  if (has('风云星座')) return 'fengyun'
  if (has('Kuiper')) return 'kuiper'
  if (has('METEOR')) return 'meteor'
  if (has('千帆星座')) return 'qianfan'
  if (has('遥感星座')) return 'yaogan'
  if (has('国网星座')) return 'guowang'
  if (has('Intelsat')) return 'intelsat'
  if (has('Glonass')) return 'glonass'
  if (has('Globalstar')) return 'globalstar'
  if (has('GPS')) return 'gps'
  if (has('北斗导航星座')) return 'beidou'
  if (has('吉利未来星座')) return 'geely'
  if (name.includes('STARLINK')) return 'starlink'
  if (name.includes('ONEWEB') || name.includes('ONE WEB')) return 'oneweb'
  if (name.includes('IRIDIUM')) return iridiumGen(name)
  if (name.includes('ORBCOMM')) return orbcommGen(name)
  if (name.includes('FLOCK')) return 'flock'
  if (name.includes('SPACEBEE') || name.includes('SPACE BEE')) return 'spacebee'
  if (name.includes('WORLDVIEW')) return /WORLDVIEW[ -]?[23]/.test(name) ? 'worldview23' : 'worldview1'
  if (name.includes('LEMUR')) return /LEMUR[ -]?2/.test(name) ? 'lemur2' : 'lemur1'
  // 星座种子表未收录时的关键词兜底（均取识别度高的关键词，避免误匹配）
  if (name.includes('FENGYUN') || /^FY[ -]?\d/.test(name)) return 'fengyun'
  if (name.includes('KUIPER')) return 'kuiper'
  if (name.includes('METEOR')) return 'meteor'
  if (name.includes('QIANFAN')) return 'qianfan'
  if (name.includes('YAOGAN')) return 'yaogan'
  if (name.includes('GUOWANG')) return 'guowang'
  if (name.includes('INTELSAT')) return 'intelsat'
  if (name.includes('GLONASS')) return 'glonass'
  if (name.includes('GLOBALSTAR')) return 'globalstar'
  if (name.includes('NAVSTAR')) return 'gps'
  if (name.includes('BEIDOU') || name.includes('COMPASS')) return 'beidou'
  if (name.includes('GEESAT')) return 'geely'
  return 'satellite'
}

/** 画质档位：high=正常机器原画质；mid=老机降一档；low=老年机/低端核显兜底。
 *  静态探测（useDevice.detectDeviceTier）决定初始档位，运行时帧率自适应可再降档（只降不升，避免抖动）。 */
export type QualityTier = 'high' | 'mid' | 'low'
export interface QualityPreset {
  /** WebGLRenderer antialias（仅创建时生效） */
  antialias: boolean
  /** setPixelRatio 上限（与 devicePixelRatio 取小） */
  pixelRatio: number
  /** 地球球体分段数 */
  earthSeg: number
  /** 大气层球体分段数 */
  atmoSeg: number
  /** 每轮所有 SGP4 propagate 计算的总预算（次）：单轮传播达到该次数后立即让出主线程给渲染，
   *  避免「一帧一帧卡顿」。过滤轨道线绘制与卫星精确校准共享该预算；
   *  构建轨道线期间轨道线独享全部预算（最快出线），建完后再回到全速卫星校准。 */
  propBudget: number
  /** 是否启用 hover 预览轨道线（需高频拾取，低端机关闭） */
  hover: boolean
  /** hover 拾取节流（ms） */
  hoverThrottle: number
}
export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  high: { antialias: true, pixelRatio: 2, earthSeg: 96, atmoSeg: 64, propBudget: 2400, hover: true, hoverThrottle: 100 },
  mid: { antialias: true, pixelRatio: 1.5, earthSeg: 64, atmoSeg: 48, propBudget: 1600, hover: true, hoverThrottle: 160 },
  low: { antialias: false, pixelRatio: 1, earthSeg: 48, atmoSeg: 32, propBudget: 1000, hover: false, hoverThrottle: 220 }
}
/** 模拟时间推进下过滤轨道线跟随当前时刻的滚动刷新参数：
 *  模拟时间前进超过该值(ms)才滚动更新轨道线顶点，实时推进下跳过大部分无效更新省预算。 */
export const ORBIT_LIVE_STEP_MS = 60000
/** 用于隐藏 InstancedMesh 单个实例的零矩阵（缩放为 0 即不可见） */
export const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0)
/** 屏幕空间吸附阈值（像素）：鼠标落点距离卫星投影点小于该值即视为可拾取 */
export const PICK_TOLERANCE_PX = 40

/* ============================================================
 * 坐标转换 / 工具（唯一出处：ECI → Three.js 场景单位）
 * ============================================================ */
export function eciToScene(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x * KM_TO_SCENE, z * KM_TO_SCENE, -y * KM_TO_SCENE)
}
/**
 * 太阳在 ECI（当日平春分点的平赤道，与 satellite.js 的 TEME 相差约 1″）的单位方向向量。
 *
 * 口径与 server/lib/illumination.js 的太阳位置一致（同一套低精度公式），两者应保持同步。
 * 两处坑（历史上都踩过，改动时务必保持）：
 *   1) 必须是真 ECI 方向的 y = cosε·sinλ、z = sinε·sinλ。y/z 写反会让昼夜分界线在至点附近
 *      偏 43°（春分/秋分才恰好接近 0°，所以只在分点附近验证是查不出来的）；
 *   2) jd 取「JD − 2451545.0」，不要再 +0.5：多半天会让太阳黄经偏约 0.5°。
 */
export function sunDirection(date: Date): THREE.Vector3 {
  const jd = date.getTime() / 86400000 - 10957.5
  const L = ((280.460 + 0.9856474 * jd) % 360) * Math.PI / 180
  const g = ((357.528 + 0.9856003 * jd) % 360) * Math.PI / 180
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180
  const epsilon = (23.439 - 0.0000004 * jd) * Math.PI / 180
  return new THREE.Vector3(
    Math.cos(lambda),
    Math.cos(epsilon) * Math.sin(lambda),
    Math.sin(epsilon) * Math.sin(lambda)
  ).normalize()
}

/**
 * 月亮在 ECI 的单位方向向量（**仅供三维场景显示**）。
 *
 * 这里用天文年历的低精度月亮级数（黄经误差约 0.3°），够画一个天体标记；
 * 需要精确值（月相/角距/月光背景）一律走 server/lib/illumination.js 或 /cgi/illumination/sky，
 * 不要把这个精简实现当作精度基准。
 *
 * @returns dir：ECI 单位方向向量；distKm：地心距（km，约 35.6~40.7 万）
 */
export function moonDirection(date: Date): { dir: THREE.Vector3; distKm: number } {
  const jd = date.getTime() / 86400000 - 10957.5
  const T = jd / 36525
  const rad = Math.PI / 180
  // 月亮平黄经 L'、平距角 D、太阳平近点角 M、月亮平近点角 M'、升交点角距 F
  const Lp = 218.316 + 481267.881 * T
  const D = 297.850 + 445267.112 * T
  const M = 357.529 + 35999.050 * T
  const Mp = 134.963 + 477198.867 * T
  const F = 93.272 + 483202.018 * T
  const sin = (deg: number) => Math.sin(deg * rad)
  const cos = (deg: number) => Math.cos(deg * rad)
  // 黄经 / 黄纬主项（度）
  const lon = Lp + 6.289 * sin(Mp) - 1.274 * sin(Mp - 2 * D) + 0.658 * sin(2 * D)
    + 0.214 * sin(2 * Mp) - 0.186 * sin(M) - 0.114 * sin(2 * F)
  const lat = 5.128 * sin(F) + 0.281 * sin(Mp + F) - 0.278 * sin(F - Mp)
    - 0.173 * sin(F - 2 * D)
  // 地心距（km）：视差 π 换算
  const par = 0.9508 + 0.0518 * cos(Mp) + 0.0095 * cos(Mp - 2 * D)
    + 0.0078 * cos(2 * D) + 0.0028 * cos(2 * Mp)
  const distKm = 6378.14 / Math.sin(par * rad)
  const lr = lon * rad
  const br = lat * rad
  const eps = (23.439 - 0.0000004 * jd) * rad
  return {
    dir: new THREE.Vector3(
      Math.cos(br) * Math.cos(lr),
      Math.cos(eps) * Math.cos(br) * Math.sin(lr) - Math.sin(eps) * Math.sin(br),
      Math.sin(eps) * Math.cos(br) * Math.sin(lr) + Math.cos(eps) * Math.sin(br)
    ).normalize(),
    distKm
  }
}
export function fmtNum(v?: number | null, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  return Number(v).toFixed(digits)
}
/** 解析时间字符串 → ms。
 *  - DB 的 DATETIME 经 JSON 序列化后为 ISO（带 Z 或时区偏移），直接 parse；
 *  - TLE epoch / 'YYYY-MM-DD HH:MM:SS' 为 UTC 且不带时区，补 'T' + 'Z' 后再 parse。 */
export function parseEpoch(s: string) {
  const str = String(s || '').trim()
  const hasZone = /[Zz]$/.test(str) || /[+-]\d{2}:?\d{2}$/.test(str)
  const ms = Date.parse(hasZone ? str : str.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? Date.now() : ms
}
/** 按过滤后卫星数量动态决定轨道线采样密度：命中越多采样越稀，但始终绘制、不省略 */
export function orbitSteps(n: number) {
  if (n <= 300) return 256
  if (n <= 2000) return 128
  if (n <= 8000) return 96
  if (n <= 20000) return 64
  return 48
}
/** 释放一个 THREE 对象（Group / InstancedMesh 等）的所有几何体 / 材质（用于回收过滤轨道线组、热力卫星端点标记等） */
export function disposeGroup(grp: import('three').Object3D) {
  grp.traverse((o: any) => {
    const m = o as import('three').Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material as import('three').Material | import('three').Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else if (mat) mat.dispose()
  })
}
/** 释放场景内全部 Three 资源的 GPU 端（几何体 / 材质 / 其引用的纹理），幂等，可重复调用。 */
export function disposeScene(scene: import('three').Scene) {
  const geoms = new Set<import('three').BufferGeometry>()
  const mats = new Set<import('three').Material>()
  const texs = new Set<import('three').Texture>()
  const releaseTexture = (mat: import('three').Material) => {
    const anyM = mat as unknown as Record<string, unknown>
    for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'specularMap', 'bumpMap', 'displacementMap']) {
      const t = anyM[k]
      if (t instanceof Object && (t as any).isTexture && !texs.has(t as import('three').Texture)) { texs.add(t as import('three').Texture); (t as any).dispose() }
    }
  }
  scene.traverse((o: any) => {
    if (o.geometry && !geoms.has(o.geometry)) {
      geoms.add(o.geometry as import('three').BufferGeometry)
      ;(o.geometry as import('three').BufferGeometry).dispose()
    }
    const mat = o.material as import('three').Material | import('three').Material[] | undefined
    if (!mat) return
    if (Array.isArray(mat)) {
      for (const m of mat) { if (!mats.has(m)) { mats.add(m); releaseTexture(m); m.dispose() } }
    } else if (!mats.has(mat)) {
      mats.add(mat); releaseTexture(mat); mat.dispose()
    }
  })
}

/* ============================================================
 * 类型定义 / g 对象（非响应式，集中持有 THREE 资源）
 * ============================================================ */
export interface InstInfo {
  /** 型号键（决定用哪套模型，见 resolveModelKey） */
  model: string
  /** 粗类型（4 分类，供图例显隐 / 配色等仍按粗类型走的逻辑使用） */
  coarse: string
}
/** 过滤轨道线中的一条轨道：关联其卫星 gi、所属 LineSegments、动态顶点缓冲与起始顶点下标。 */
export interface FilterOrbitItem {
  gi: number
  steps: number
  line: import('three').LineSegments
  positions: Float32Array
  base: number
}
export interface GState {
  renderer: import('three').WebGLRenderer | null
  scene: import('three').Scene | null
  camera: import('three').PerspectiveCamera | null
  controls: OrbitControls | null
  rafId: number
  lastTs: number
  simTimeMs: number
  lastLive: number
  earthMat: import('three').MeshPhongMaterial | null
  sunLight: import('three').DirectionalLight | null
  /** 二十八星宿图层（28 距星点 + 四象连线，挂场景根、惯性系不随地球自转；宿名标签由 BaseScene 的 DOM 层呈现） */
  mansionGroup: import('three').Group | null
  /** 西方 88 星座连线图层（IAU 天区连线，挂场景根、惯性系不随地球自转；星座名标签由 BaseScene 的 DOM 层呈现） */
  constellationGroup: import('three').Group | null
  /** 大气层辉光壳（运行时降档可整体隐藏） */
  atmo: import('three').Mesh | null
  /** 太阳标记（发光球 + 光晕，方向真实、距离压缩到场景内） */
  sunMarker: import('three').Group | null
  /** 月亮（方向与月相真实，按真实地心距放置、半径放大便于观察） */
  moonMesh: import('three').Mesh | null
  /** 地球地影锥（本影 + 半影，随太阳方向实时定向） */
  shadowGroup: import('three').Group | null
  /** 地固系叠加层（随地球自转，rotation.y = GMST）：极光椭圆环、星下点轨迹等贴地元素都挂这里 */
  earthFixedGroup: import('three').Group | null
  /** 极光椭圆环（南北两环，圆心为偶极磁极；环下沿/宽度/亮度由当日 Kp 驱动） */
  auroraGroup: import('three').Group | null
  /** 地磁偶极磁力线（按 IGRF 偶极轴（80.7°N/72.7°W）倾斜画出的一族嵌套场线 + 沿场线流动的粒子；
   *  亮度/流速由 Kp / 太阳风驱动，挂 earthFixedGroup 随地球自转，磁极钉在正确地理位置） */
  dipoleGroup: import('three').Group | null
  /** 太阳风粒子流（沿日地连线流动的短流线；速度/Bz 由 NOAA 数据驱动，默认不展示） */
  solarWind: import('three').LineSegments | null
  /** 星下点轨迹（选中卫星的一整圈贴地轨迹，地固系） */
  groundTrack: import('three').Line | null
  /** 误差椭球组（选中交会事件的两端；经验 σ 的 RTN 三分量） */
  covGroup: import('three').Group | null
  cloudList: ConstellationPoint[]
  satrecs: (ReturnType<typeof twoline2satrec> | null)[]
  /** 每颗全局索引 -> 其场景位置（每帧外推推进，供 compose 复用） */
  scenePos: import('three').Vector3[]
  /** 每颗全局索引 -> 场景坐标系下的速度向量（场景单位/模拟秒），供每帧轻量外推实现连续平滑运动 */
  sceneVel: import('three').Vector3[]
  /** 每颗全局索引 -> 所属型号（模型文件）+ 粗类型（姿态逐帧按位置 / 速度重算，不在此固化） */
  instOf: InstInfo[]
  /** 型号键 -> 该型号卫星的全局索引列表（local 顺序，见 resolveModelKey） */
  modelIndices: Record<string, number[]>
  /** 型号键 -> 当前档位下该型号的 InstancedMesh（切换档位时整体重建） */
  modelMeshes: Record<string, import('three').InstancedMesh | null>
  /** 当前生效的模型 LOD 档位（先粗后精：见 BaseScene 的 pickModelLod） */
  modelLod: ModelLod
  /** 所有 InstancedMesh（raycast + dispose 用） */
  meshes: import('three').InstancedMesh[]
  batchCursor: number
  /** 全局索引 -> 该卫星在其型号内的 local 序号（避免每帧 indexOf O(n) 查找，拖慢缩放拖拽） */
  localOf: Int32Array
  /** 卫星精确校准（SGP4 重算位置+速度）节流：距上次校准的毫秒数 */
  lastCalib: number
  /** 用户正在缩放/拖拽（controls start/end），此间暂停卫星传播以保证交互帧流畅 */
  userInteracting: boolean
  /** 选中卫星的可视锚点（供 HTML 四角准星投影跟随，纯空对象不渲染几何体） */
  selAnchor: import('three').Group | null
  /** 选中卫星轨道线（基于 TLE 历元采样一整圈，固定于世界坐标系） */
  orbitLine: import('three').Line | null
  /** hover 预览轨道线（鼠标悬停 / 移动端滑动命中某颗卫星时临时显示，移开或命中变化即清除） */
  previewOrbitLine: import('three').Line | null
  satrec: ReturnType<typeof twoline2satrec> | null
  /** 每颗全局索引 -> 是否可见（检索/星座/高度过滤后的可见掩码，1=显示 0=隐藏） */
  filterMask: Uint8Array
  /** 星座 / 高度过滤时批量绘制的轨道线组（LineSegments 按类型合并） */
  filterOrbitGroup: import('three').Group | null
  /** 过滤轨道线分批生成：待处理命中卫星的全局索引队列 */
  filterOrbitQueue: number[]
  /** 过滤轨道线分批生成：已处理到的队列下标 */
  filterOrbitCursor: number
  /** 过滤轨道线分批生成：本批轨道线的固定采样参考时刻(ms)，防止各批次按不同时刻采样而错位 */
  filterOrbitT0: number
  /** 过滤轨道线分批生成：按类型累积的线段顶点 */
  filterOrbitSegs: Record<string, import('three').Vector3[]>
  /** 平滑替换：重建新轨道线期间暂存的旧组（在新组建好前继续显示，避免重建空窗闪烁） */
  filterOrbitPending: import('three').Group | null
  /** 过滤轨道线构建完成后，全部轨道线项（每帧滚动更新顶点，跟随卫星位置实时变化） */
  filterOrbitItems: FilterOrbitItem[]
  /** 过滤轨道线分批生成期间，按类型记录每条轨道线在顶点缓冲中的起始下标 */
  filterOrbitMeta: Record<string, { gi: number; segStart: number; steps: number }[]>
  /** 过滤轨道线滚动更新的模拟时间基准：模拟时间前进超过 LiveStepMs 才触发一轮顶点滚动，省掉无效更新 */
  filterOrbitLiveT0: number
  /** 碰撞热力标记组：事件中点云状标记(Points) + 两端点连线(LineSegments)；热力模式显示，普通模式隐藏 */
  heatGroup: import('three').Group | null
  /** 热力事件中点标记（Points 粒子和云，颜色/大小按碰撞概率） */
  heatPoints: import('three').Points | null
  /** 热力云状区域（Points 柔边光斑，加法混合，按碰撞概率决定尺寸/颜色，重叠形成区域色云） */
  heatClouds: import('three').Points | null
  /** 热力事件两端点连线（LineSegments，逐事件 A→B 一条线段） */
  heatLines: import('three').LineSegments | null
  /** 热力选中交会目标的轨道线组（含 A/B 两条轨道 + TCA 时刻的两颗目标模型，取消选中清除） */
  heatSelOrbitGroup: import('three').Group | null
  /** 选中交会目标的端点拾取缓存（NORAD + ECI 坐标），供热力模式下点击目标模型拾取卫星 */
  heatSatTargets: { norad: number; eci: import('three').Vector3 }[]
  /** 过境分析：地表叠加根组（行政区划面 + 国界 + 城市标注同挂此组，每帧同步贴图自转 offset） */
  passGroup: import('three').Group | null
  /** 过境分析：国界线组（LineSegments 合并，图例开关控制显隐） */
  passBorderGroup: import('three').Group | null
  /** 过境分析：中国行政区划面组（边界线 + 高亮面填充，图例开关控制显隐） */
  passDistrictGroup: import('three').Group | null
  /** 过境分析：目标面拾取网格（与 passTargetPickIds 同序；材质 visible=false，仅用于射线拾取，不参与渲染） */
  passTargetPickMeshes: import('three').Mesh[]
  /** 过境分析：拾取网格对应的 pass_geo.id（与 passTargetPickMeshes 同序） */
  passTargetPickIds: number[]
  /** 过境分析：选中目标面的高亮组（边界加粗 + 半透明面填充，随 passGroup 自转） */
  passHighlightGroup: import('three').Group | null
  /** 过境分析：选中过境记录的空间轨道标记组（AOS / 最高仰角 / LOS 三处空间位置点，passGroup 子组，随自转） */
  passTrackGroup: import('three').Group | null
  /** 区域过境：框选多边形叠加组（描边 + 顶点 + 面填充 + 预览线，passGroup 子组，随自转） */
  regionGroup: import('three').Group | null
  /** 多区域过境的框选叠加组（多个已框区域 + 当前草稿；与 regionGroup 各画各的，互不覆盖） */
  multiGroup: import('three').Group | null
  /** 区域过境：选中过境记录的惯性系叠加组（整圈轨道线 + 卫星模型，挂场景根，不随地球自转） */
  regionPassGroup: import('three').Group | null
  /** 区域过境：选中过境记录的贴地扫描叠加组（判定可达范围 + 成像条带 + 星下点轨迹，passGroup 子组，随自转） */
  regionPassScanGroup: import('three').Group | null
  /** 多区域过境：选中记录的惯性系叠加组（整圈轨道线 + 卫星模型，挂场景根，不随地球自转） */
  multiPassGroup: import('three').Group | null
  /** 多区域过境：选中记录的贴地扫描叠加组（判定可达范围 + 成像条带 + 星下点轨迹，passGroup 子组，随自转） */
  multiPassScanGroup: import('three').Group | null
  /** 城市过境：选中目标全部过境卫星的整圈轨道线组（每颗一根，挂 passGroup，地球固连系随自转 —— 与目标高亮面同系，轨道环才会穿过区域面） */
  passCityOrbitGroup: import('three').Group | null
  /** 城市过境：右侧过境列表选中项的三维卫星模型组（挂场景根，惯性系不随地球自转；轨道线只复染不重建，见 passCityOrbitGroup） */
  passSatGroup: import('three').Group | null
  /** 发射站标记组（挂 earthFixedGroup，随地球自转；按经纬度打点，含选中高亮环） */
  siteGroup: import('three').Group | null
}
export const g: GState = {
  renderer: null, scene: null, camera: null, controls: null,
  rafId: 0, lastTs: 0, simTimeMs: Date.now(), lastLive: 0,
  earthMat: null, sunLight: null, mansionGroup: null, constellationGroup: null, atmo: null,
  sunMarker: null, moonMesh: null, shadowGroup: null, earthFixedGroup: null, auroraGroup: null, dipoleGroup: null, solarWind: null,
  groundTrack: null, covGroup: null, cloudList: [], satrecs: [],
  scenePos: [], sceneVel: [], instOf: [], modelIndices: {},
  modelMeshes: {}, modelLod: 'low',
  meshes: [], batchCursor: 0,
  localOf: new Int32Array(0),
  lastCalib: 0,
  userInteracting: false,
  selAnchor: null, orbitLine: null, previewOrbitLine: null, satrec: null,
  filterMask: new Uint8Array(0),
  filterOrbitGroup: null,
  filterOrbitQueue: [], filterOrbitCursor: 0, filterOrbitT0: Date.now(),
  filterOrbitSegs: { PAYLOAD: [], DEBRIS: [], 'ROCKET BODY': [], UNKNOWN: [] },
  filterOrbitPending: null,
  filterOrbitItems: [],
  filterOrbitMeta: { PAYLOAD: [], DEBRIS: [], 'ROCKET BODY': [], UNKNOWN: [] },
  filterOrbitLiveT0: Date.now(),
  heatGroup: null, heatPoints: null, heatLines: null, heatClouds: null, heatSelOrbitGroup: null,
  heatSatTargets: [],
  passGroup: null, passBorderGroup: null, passDistrictGroup: null,
  passTargetPickMeshes: [], passTargetPickIds: [],
  passHighlightGroup: null, passTrackGroup: null,
  regionGroup: null,
  multiGroup: null,
  regionPassGroup: null, regionPassScanGroup: null,
  multiPassGroup: null, multiPassScanGroup: null,
  passCityOrbitGroup: null, passSatGroup: null,
  siteGroup: null
}

/* ============================================================
 * 载入 / 选中 / 过滤 共享响应式状态
 * ============================================================ */
export const loading = ref(true)
export const error = ref('')
export const notice = ref('')
export const modelNotice = ref('')

export const sel = reactive({ id: 0, name: '', type: '', lat: 0, lon: 0, alt: 0, vel: 0, simTime: '' })
export const hasSel = ref(false)
export const selDetail = ref<SatTleItem | null>(null)
/** 选中卫星所属星座（详情面板展示）：随选中异步拉取，取消选中即清空。
 *  在 sat_constellation_sat 中按 NORAD 等值反查（与知识图谱同一口径）。 */
export const selConstellations = ref<SatOfConstellation[]>([])
/** 右侧详情面板开关：选中时打开，可点击 ✕ 收起（保留选中/准星/轨道线），浮标可重新展开 */
export const detailOpen = ref(true)

/** 星座 / 检索 / 高度 过滤条件 */
export const constellations = ref<ConstellationItem[]>([])
export const filterKw = ref('')
export const filterConst = ref('')            // 星座名，空 = 全部
export const altMin = ref<number | undefined>(undefined) // 轨道高度下限(km)
export const altMax = ref<number | undefined>(undefined) // 轨道高度上限(km)
/** NORAD 集合过滤（智能体/接口下发的「一批目标」，如某国/某机构的卫星、某事件涉及的两星）：
 *  null = 不启用；与 kw / 星座 / 高度三条**AND 叠加**（不覆盖，避免搜索框失灵）。
 *  注意两个定位来源在各自入口互清：showSatelliteSet() 会先清 kw/星座/高度，pickConstellation() 会清空本集合。 */
export const filterNorads = ref<number[] | null>(null)

/** 多星座对比：参与对比的星座（名称 + 分配给它的颜色，顺序即对比顺序 / 图例顺序）。
 *  [] = 未启用对比；与 filterNorads 是两种定位来源，入口处互清。
 *  启用时 filterActive 为真（画轨道线），并由调用方把 colorMode 置 'compare'（点云按星座着色）。 */
export const compareConsts = ref<{ name: string; color: string }[]>([])
export const compareActive = computed(() => compareConsts.value.length > 0)

/** 星座列表面板：名称模糊检索 */
export const constPanel = reactive({ q: '' })
/** 按名称过滤后的星座列表 */
export const consFiltered = computed(() => {
  const q = constPanel.q.trim().toLowerCase()
  if (!q) return constellations.value
  return constellations.value.filter((c) => c.name.toLowerCase().includes(q))
})

/** 星座视图右侧「成员列表」：当前星座下命中过滤口径的卫星全局索引 + 滚动加载计数。
 *  点击列表项即高亮该星轨道线（见 consHighlightNorad），不改变「选中单星」状态。 */
export const consSatPanel = reactive({
  idx: [] as number[],
  count: 0,
  BATCH: 200
})

/** 星座视图中被高亮轨道线的卫星 NORAD（0 = 未高亮）；由右侧成员列表点击设置。
 *  高亮方式 = 直接替换该星在过滤轨道线里那一段的顶点色（载荷红 → 亮青），而非额外叠加一条线。 */
export const consHighlightNorad = ref(0)
/** 高亮配色：星座成员轨道线是载荷红，用亮青色拉开对比（见 BaseScene 的 paintConsOrbit） */
export const CONS_HIGHLIGHT_COLOR = 0x00e5ff

/** 重建星座视图的成员列表（filterConst 指定星座下只认载荷，与 refreshFilter 的过滤口径一致）。
 *  点云未就绪 / 未选星座时置空；由 BaseScene 在每次重建过滤时同步刷新。 */
export function rebuildConsSatIndex() {
  const name = filterConst.value
  const idx: number[] = []
  if (name && g.cloudList.length) {
    for (let i = 0; i < g.cloudList.length; i++) {
      const p = g.cloudList[i]
      if (p.object_type === 'PAYLOAD' && (p.cons || []).includes(name)) idx.push(i)
    }
  }
  consSatPanel.idx = idx
  consSatPanel.count = Math.min(consSatPanel.BATCH, idx.length)
}

export const visibleCount = ref(0)
/** 轨道线总开关（右下角图例最后一行「轨道线」勾选）：
 *  关闭后一次性隐藏普通模式下全部卫星轨道线——批量过滤轨道线、hover 预览轨道线、选中卫星的单星轨道线，
 *  与按类型勾选（visible）叠加生效（取消勾选某类型时该类轨道线本就不显示，故总开关只在开启时进一步收口）。
 *  交会热力 / 过境分析视图内部的轨道展示属专项分析，不受本开关影响。 */
export const orbitVisible = ref(true)
/** constellation 接口元数据：在轨总数 / 因无TLE或传播失败跳过的数量（用于明确口径，避免误读） */
export const orbitTotal = ref(0)
export const orbitSkipped = ref(0)
/** 加载进度（0-100），供简约加载态显示 */
export const loadProgress = ref(0)
/** 是否正在分批绘制过滤轨道线（命中多时按帧逐步出线，全量绘制不省略） */
export const orbitBuilding = ref(false)
/** 过滤轨道线绘制进度（0-100，命中多时给出可视进度） */
export const orbitProgress = ref(0)
export const filterActive = computed(() =>
  !!filterKw.value.trim() || !!filterConst.value || altMin.value != null || altMax.value != null
    || (filterNorads.value?.length ?? 0) > 0
    || compareActive.value
)
/** 是否处于「NORAD 集合展示」态：供 heat/pass 视图的**集合叠加层**做单开关门控
 *  （集合展示要能与热力/过境视图叠加，不能像普通卫星云那样在这两个视图里被整体隐藏）。 */
export const satSetActive = computed(() => (filterNorads.value?.length ?? 0) > 0)

/* ============================================================
 * dock 导航 / 面板数据（卫星列表 / 星座列表）
 * ============================================================ */
/** 当前展开的面板：'sat' 卫星列表 | 'cons' 星座列表 | 'site' 发射站列表 | 'heat' 碰撞热力 | 'pass' 城市过境 | 'region' 区域过境 | 'multi' 多区域过境 | '' 全收起 */
export type DockMode = '' | 'sat' | 'cons' | 'site' | 'heat' | 'pass' | 'region' | 'multi'
/** 当前展开的面板 */
export const dockMode = ref<DockMode>('')
/** 当前激活的面板（dock 高亮 + × 显示）：被动开启后一直保持，直到点 × 关闭还原 */
export const dockActive = ref<DockMode>('')

/**
 * 「综合态势」的三个子项：卫星列表（'sat'）/ 星座列表（'cons'）/ 发射站列表（'site'）。
 *  三者都是「总览态势」入口，dock 上合并为一个「综合态势」按钮 + 子项菜单，默认子项为「卫星列表」。
 */
export type SatView = 'sat' | 'cons' | 'site'
export const SAT_SOURCES: { key: SatView; label: string; desc: string }[] = [
  { key: 'sat', label: '卫星列表', desc: '按名称 / 类型 / 轨道区域检索 · 拾取单星' },
  { key: 'cons', label: '星座列表', desc: '按星座检索 · 过滤成员并绘出轨道线' },
  { key: 'site', label: '发射站列表', desc: '地球按经纬度打点 · 点站看即将发射与发射历史' }
]

/* ============================================================
 * 发射站列表（/situation 综合态势第三项）
 *  地球按经纬度打点（BaseScene 消费 launchSites 建标记）；点站后右侧面板展示即将发射 + 发射历史。
 *  数据源：/cgi/launch_site/all、/cgi/launch_upcoming/by_site/:id、/cgi/launch_record/by_site/:id（免登录只读）。
 * ============================================================ */
/** 全部发射站（含经纬度）：地球打点 + 左侧列表面板数据源 */
export const launchSites = ref<LaunchSiteItem[]>([])
/** 发射站列表加载态 / 错误信息 */
export const siteLoading = ref(false)
export const siteError = ref('')
/** 左侧列表面板：搜索词 + 仅现役勾选 */
export const sitePanel = reactive({ q: '', onlyActive: false })
/** 按搜索词（名称 / 国家码）与「仅现役」过滤后的发射站列表 */
export const siteFiltered = computed(() => {
  const q = sitePanel.q.trim().toLowerCase()
  return launchSites.value.filter((s) => {
    if (sitePanel.onlyActive && s.status !== 1) return false
    if (!q) return true
    return (s.name_cn || '').toLowerCase().includes(q)
      || (s.name_en || '').toLowerCase().includes(q)
      || (s.country_code || '').toLowerCase().includes(q)
  })
})
/** 地球标记图层显隐（进入发射站模式即显示，退出隐藏） */
export const siteMarkersVisible = ref(false)
/** 当前选中的发射站（点击地球标记或左侧列表项） */
export const siteSel = ref<LaunchSiteItem | null>(null)
/** 右侧「发射站详情」面板开关：选中时打开，可 ✕ 收起（保留选中/高亮），浮标可重新展开 */
export const siteOpen = ref(true)
/** 选中站的即将发射计划 */
export const siteUpcoming = ref<LaunchUpcomingItem[]>([])
export const siteUpcomingLoading = ref(false)
export const siteUpcomingError = ref('')
/** 选中站的发射历史（分页） */
export const siteHistory = ref<LaunchRecordItem[]>([])
export const siteHistoryTotal = ref(0)
export const siteHistoryPage = ref(1)
export const siteHistoryLoading = ref(false)
export const siteHistoryError = ref('')
/** 发射历史每页条数（与后端默认口径一致） */
export const SITE_HISTORY_PAGE_SIZE = 20
/** 该站是否有选中（右侧面板 / 浮标的显示条件） */
export const hasSiteSel = computed(() => !!siteSel.value)

/** 图例类型勾选过滤：取消勾选则隐藏对应类型模型（初始全部显示）。
 *  注意图例 / 卫星列表按「粗类型」4 分类（TYPE_KEYS），而渲染按「型号」分 Mesh，故需用 modelVisible 换算。 */
export const visible = reactive<Record<string, boolean>>(
  Object.fromEntries(TYPE_KEYS.map((k) => [k, true]))
)
/** 型号是否被图例勾选显示：按型号所属粗类型查 visible（型号 -> 粗类型见 MODEL_COARSE） */
export function modelVisible(model: string): boolean {
  return visible[MODEL_COARSE[model] || 'UNKNOWN'] !== false
}

/* ============================================================
 * 着色维度（右下角图例顶部切换）
 * ------------------------------------------------------------
 * 同一份点云可切换四种附加着色维度（默认仍是「目标类型」）：
 *   type    目标类型（载荷 / 碎片 / 箭体 / 未知，沿用 TYPE_COLOR）
 *   country 编目国（主要航天国家各自一色，其余归「其他」）
 *   perigee 近地点高度分档（km）
 *   period  轨道周期分档（分钟）
 *   incl    轨道倾角分档（度）
 * 分档定义（ColorBucket）是「3D 逐实例取色」与「图例渲染」的共同口径（单一真实来源）：
 * 3D 侧由 BaseScene 按 bucketKeyOf 逐实例 setColorAt，图例侧由 index.vue 渲染 colorLegend。
 * ============================================================ */
export type ColorMode = 'type' | 'country' | 'perigee' | 'period' | 'incl' | 'compare'
/** 当前着色维度（图例顶部切换）。
 *  注意 'compare'（多星座对比）**不在 COLOR_MODES 按钮组里** —— 它由智能体动作 / 对比态驱动，
 *  图例按钮组在 compareActive 时临时追加一个「星座对比」项（见 index.vue 的 colorModeItems）。 */
export const colorMode = ref<ColorMode>('type')
/** 着色维度切换项（图例顶部按钮，顺序即展示顺序） */
export const COLOR_MODES: { key: ColorMode; label: string }[] = [
  { key: 'type', label: '目标类型' },
  { key: 'country', label: '国家' },
  { key: 'perigee', label: '近地点' },
  { key: 'period', label: '周期' },
  { key: 'incl', label: '倾角' }
]
/** 未分类 / 无数据档的公共键与颜色 */
export const NA_BUCKET_KEY = 'na'
const NA_BUCKET_COLOR = '#7a8794'

/** 对比态一旦清空（改点单星座 / 还原 / 切到热力·过境面板等入口都会清 compareConsts），
 *  着色维度若仍停在 'compare' 会因分档只剩兜底档、把整片点云染成灰色 —— 这里统一回落 'type'。
 *  单一兜底点：覆盖 pickConstellation / resetFilter / applyDock / showSatelliteSet 等所有清空入口。 */
watch(compareActive, (on) => {
  if (!on && colorMode.value === 'compare') colorMode.value = 'type'
})

/** 分档定义：key 唯一；min 含、max 不含；缺省 min/max 表示无该侧边界（末档兼作兜底） */
export interface ColorBucket {
  key: string
  label: string
  color: string
  min?: number
  max?: number
}
/** 近地点高度分档（km） */
export const PERIGEE_BUCKETS: ColorBucket[] = [
  { key: 'pg0', label: '0 – 200 km', color: '#ff5f6d', max: 200 },
  { key: 'pg1', label: '200 – 1200 km', color: '#4f8cff', min: 200, max: 1200 },
  { key: 'pg2', label: '1200 – 2000 km', color: '#3fd07a', min: 1200, max: 2000 },
  { key: 'pg3', label: '2000 – 25000 km', color: '#ffd54f', min: 2000, max: 25000 },
  { key: 'pg4', label: '25000 – 40000 km', color: '#c06bff', min: 25000, max: 40000 },
  { key: NA_BUCKET_KEY, label: '其他 / 无数据', color: NA_BUCKET_COLOR }
]
/** 轨道周期分档（分钟） */
export const PERIOD_BUCKETS: ColorBucket[] = [
  { key: 'pd0', label: '0 – 100 分钟', color: '#4f8cff', max: 100 },
  { key: 'pd1', label: '100 – 200 分钟', color: '#3fd0d0', min: 100, max: 200 },
  { key: 'pd2', label: '200 – 600 分钟', color: '#3fd07a', min: 200, max: 600 },
  { key: 'pd3', label: '600 – 1000 分钟', color: '#ffd54f', min: 600, max: 1000 },
  { key: 'pd4', label: '1000 – 1500 分钟', color: '#ff8f3f', min: 1000, max: 1500 },
  { key: 'pd5', label: '1500 – 2000 分钟', color: '#c06bff', min: 1500, max: 2000 },
  { key: 'pd6', label: '> 2000 分钟', color: '#ff5fa2', min: 2000 },
  { key: NA_BUCKET_KEY, label: '其他 / 无数据', color: NA_BUCKET_COLOR }
]
/** 轨道倾角分档（度） */
export const INCL_BUCKETS: ColorBucket[] = [
  { key: 'ic0', label: '0 – 30 度', color: '#4f8cff', max: 30 },
  { key: 'ic1', label: '30 – 60 度', color: '#3fd0d0', min: 30, max: 60 },
  { key: 'ic2', label: '60 – 70 度', color: '#3fd07a', min: 60, max: 70 },
  { key: 'ic3', label: '70 – 100 度', color: '#ffd54f', min: 70, max: 100 },
  { key: 'ic4', label: '100 – 110 度', color: '#ff8f3f', min: 100, max: 110 },
  { key: 'ic5', label: '110 – 150 度', color: '#ff5fa2', min: 110, max: 150 },
  { key: NA_BUCKET_KEY, label: '其他 / 无数据', color: NA_BUCKET_COLOR }
]
/** 国家模式：主要航天国家（编目国码 -> 中文名，顺序即图例顺序与配色顺序）；其余编目国统一归「其他」 */
export const MAJOR_COUNTRIES: { code: string; label: string }[] = [
  { code: 'US', label: '美国' },
  { code: 'RU', label: '俄罗斯' },
  { code: 'CN', label: '中国' },
  { code: 'GB', label: '英国' },
  { code: 'FR', label: '法国' },
  { code: 'JP', label: '日本' },
  { code: 'IN', label: '印度' },
  { code: 'DE', label: '德国' }
]
/** 国家着色调色板（按 MAJOR_COUNTRIES 顺序取色） */
const COUNTRY_COLORS = ['#4f8cff', '#ff8f3f', '#3fd07a', '#ffd54f', '#c06bff', '#3fd0d0', '#ff5fa2', '#b98cff']
/** 国家模式「其他」档 */
export const COUNTRY_OTHER_KEY = '__other__'

/** 「多星座对比」公用调色板：按对比顺序依次取色（高区分度，超出后循环）。
 *  单一真实来源：点云着色（colorBucketDefs('compare')）与过滤轨道线分组着色共用。 */
export const COMPARE_PALETTE = [
  '#4f8cff', '#ff8f3f', '#3fd07a', '#ffd54f', '#c06bff',
  '#3fd0d0', '#ff5fa2', '#b98cff', '#ff6b6b', '#7ee787'
]
/** 对比星座分组键前缀（轨道线分桶 / 点云分档共用；如 `cmp:千帆星座`） */
export const COMPARE_KEY_PREFIX = 'cmp:'

/** 图例行（非「目标类型」维度用：颜色 + 名称 + 计数 + 占比；由 BaseScene 着色后填充 colorLegend） */
export interface ColorLegendRow {
  key: string
  label: string
  color: string
  /** 当前点云中命中的物体数 */
  count: number
  /** 占全部可渲染物体的百分比（保留 1 位小数） */
  pct: number
}
export const colorLegend = ref<ColorLegendRow[]>([])

/** 某维度下的完整分档列表（顺序即图例顺序；含兜底「其他」档） */
export function colorBucketDefs(mode: ColorMode): { key: string; label: string; color: string }[] {
  if (mode === 'perigee') return PERIGEE_BUCKETS
  if (mode === 'period') return PERIOD_BUCKETS
  if (mode === 'incl') return INCL_BUCKETS
  if (mode === 'compare') {
    // 多星座对比：每个对比星座一档（颜色由调用方按 COMPARE_PALETTE 分配），末档兜底
    return [
      ...compareConsts.value.map((c) => ({ key: COMPARE_KEY_PREFIX + c.name, label: c.name, color: c.color })),
      { key: NA_BUCKET_KEY, label: '其他 / 无数据', color: NA_BUCKET_COLOR }
    ]
  }
  if (mode === 'country') {
    return [
      ...MAJOR_COUNTRIES.map((c, i) => ({ key: c.code, label: c.label, color: COUNTRY_COLORS[i % COUNTRY_COLORS.length] })),
      { key: COUNTRY_OTHER_KEY, label: '其他', color: NA_BUCKET_COLOR }
    ]
  }
  return TYPE_KEYS.map((k) => ({ key: k, label: TYPE_LABEL[k], color: TYPE_HEX[k] }))
}

/** 按分档区间取键（null / 越界 / 缺失一律落末档兜底） */
function bucketKeyOfValue(v: number | null | undefined, buckets: ColorBucket[]): string {
  const naKey = buckets[buckets.length - 1]?.key || NA_BUCKET_KEY
  if (v == null || !Number.isFinite(Number(v))) return naKey
  const x = Number(v)
  for (const b of buckets) {
    if ((b.min == null || x >= b.min) && (b.max == null || x < b.max)) return b.key
  }
  return naKey
}

/** 取某物体在指定着色维度下的分档键（3D 逐实例取色与图例计数共用） */
export function bucketKeyOf(mode: ColorMode, p: ConstellationPoint): string {
  if (mode === 'compare') {
    // 多星座对比：按 cons 顺序取「首个命中」的对比星座；非载荷不参与（与星座过滤同口径）
    if (p.object_type !== 'PAYLOAD') return NA_BUCKET_KEY
    const hit = compareConsts.value.find((c) => (p.cons || []).includes(c.name))
    return hit ? COMPARE_KEY_PREFIX + hit.name : NA_BUCKET_KEY
  }
  if (mode === 'country') {
    const cc = p.owner_code || '--'
    return MAJOR_COUNTRIES.some((c) => c.code === cc) ? cc : COUNTRY_OTHER_KEY
  }
  if (mode === 'perigee') return bucketKeyOfValue(p.perigee, PERIGEE_BUCKETS)
  if (mode === 'period') return bucketKeyOfValue(p.period, PERIOD_BUCKETS)
  if (mode === 'incl') return bucketKeyOfValue(p.incl, INCL_BUCKETS)
  return p.object_type || 'UNKNOWN'
}

/** 取某物体在指定着色维度下的十六进制颜色（0xRRGGBB，供 three 逐实例 setColorAt） */
export function bucketColorHexOf(mode: ColorMode, p: ConstellationPoint): number {
  const key = bucketKeyOf(mode, p)
  const def = colorBucketDefs(mode).find((d) => d.key === key)
  const hex = def?.color || '#b0bec5'
  return parseInt(hex.slice(1), 16)
}


/** 三维视图数据源（卫星列表与点云同源）：'tle' 国际库（sat_tle，默认）/ 'aoe' 太空地图 AOE 库（sat_aoe）。
 *  切换由卫星列表面板触发，实际重载在 BaseScene.switchDataSource 内完成（重新拉点云 + 重建实例）。 */
export const dataSource = ref<SatSource>('tle')
/** 数据源切换项（面板上的分段按钮，顺序即展示顺序） */
export const SAT_SOURCE_OPTIONS: { value: SatSource; label: string }[] = [
  { value: 'tle', label: '国际库' },
  { value: 'aoe', label: 'AOE库' }
]

/** 卫星列表面板：搜索词 + 类型勾选 + 轨道区域勾选 + 过滤后的全局索引 + 滚动加载计数 */
export const satPanel = reactive({
  q: '',
  typeF: { PAYLOAD: true, DEBRIS: true, 'ROCKET BODY': true, UNKNOWN: true } as Record<string, boolean>,
  regimeF: { LEO: true, MEO: true, GEO: true, HEO: true, OTHER: true } as Record<string, boolean>,
  idx: [] as number[],
  count: 0,
  BATCH: 120
})

/** 卫星列表条目是否命中当前搜索词与类型/轨道区域筛选 */
export function satMatch(i: number, q: string): boolean {
  const p = g.cloudList[i]
  if (!p) return false
  if (!satPanel.typeF[p.object_type]) return false
  // 轨道区域勾选过滤：空区域（regime 缺失）不参与过滤，始终保留
  const rg = p.regime
  if (rg && !satPanel.regimeF[rg]) return false
  if (q) {
    const name = (p.object_name || '').toLowerCase()
    if (!name.includes(q) && !String(p.norad_id).includes(q)) return false
  }
  return true
}

/** 重算卫星列表面板的过滤索引与展示条数（点云就绪后由首屏预热调用一次，搜索词 / 类型变化由 watch 触发；
 *  纯本地遍历一次 ~3.5 万，毫秒级） */
export function rebuildSatIndex() {
  const q = satPanel.q.trim().toLowerCase()
  const idx: number[] = []
  for (let i = 0; i < g.cloudList.length; i++) if (satMatch(i, q)) idx.push(i)
  satPanel.idx = idx
  satPanel.count = Math.min(satPanel.BATCH, idx.length)
}

/* ============================================================
 * 碰撞热力（三个数据源，同一坐标口径）
 *  - 'local'       本项目 SGP4 初筛：/cgi/sat_conj/heatmap（sat_conjunction + 现行 TLE 在 TCA 传播）
 *  - 'spacetrack'  Space-Track 官方 CDM：/cgi/sat_cdm/heatmap（sat_cdm 预计算坐标，缺坐标回退 SGP4）
 *  - 'cri'         本项目交会分析：/cgi/sat_cri/heatmap（sat_cri_conjunction + 现行 TLE 在 TCA 传播，
 *                  CRI/CRP 风险指数模型，与初筛完全隔离的两套表，仅着色 / 指标口径不同）
 * 三者都由后端在 TCA 时刻传播出两端点与中点 ECI 坐标；前端共用同一套拾取/交互逻辑，
 * 但渲染按来源区分：本地两类事件量大 → 立方网格宏观聚合热力斑；CDM 事件量小 → 逐事件柔光云。
 * 本 store 集中持有：热力模式开关、数据来源、事件列表、按日切片时间轴、选中事件、配色。
 * ============================================================ */
/** 一条碰撞热力事件（后端以 TLE+SGP4 在 TCA 时刻传播得到的 ECI 坐标，
 *  并由后端下发渲染参数 color/risk/dens_boost/metric_text/day，前端只消费不换算）。
 *  类型定义与 /cgi 接口共用（见 @/api/sat_public），避免前后端字段口径漂移。 */
export type { CdmHeatEvent }

/** 热力数据来源：'local' = 本项目 SGP4 初筛（sat_conjunction，默认）；'spacetrack' = Space-Track 官方 CDM；
 *  'cri' = 本项目交会分析（sat_cri_conjunction，CRI/CRP 风险指数模型，与初筛完全隔离的另一套表与口径） */
export type HeatSource = 'local' | 'spacetrack' | 'cri'
/** 当前热力来源（默认「交会热力」，见底部 dock 弹出的来源菜单） */
export const heatSource = ref<HeatSource>('local')
/** 来源菜单项（dock「碰撞热力」按钮点击后向上弹出，顺序即展示顺序） */
export const HEAT_SOURCES: { key: HeatSource; label: string; desc: string }[] = [
  { key: 'local', label: '交会热力', desc: 'SGP4 初筛 · 风险等级' },
  { key: 'spacetrack', label: 'CDM 热力', desc: 'Space-Track 官方 · 碰撞概率 Pc' },
  { key: 'cri', label: '交会分析热力', desc: 'CRI/CRP 模型 · 交会风险概率' }
]

/** 热力视图开关：进入后隐藏卫星云与轨道线，只显示碰撞事件标记；
 *  与「碰撞热力」面板显隐解耦（由 index.vue 的 toggleDock 编排）：
 *  展开面板开启热力视图；折叠面板只隐藏面板、保留热力云以便继续观察与拾取；
 *  只有还原初始 / 点 dock × / 切到卫星·星座列表 才退出热力视图。 */
export const heatMode = ref(false)
/** 时间窗口（天）：>0 未来 N 天；0 表示「全部」（含历史事件，展示全量高危，默认）。
 *  默认取全部以匹配后台高危事件全量口径，避免只看未来窗口的少数几条；3/5/7 天为警戒窗口快捷档。 */
export const heatDays = ref(0)
/** 当前按日切片选中的日期（1..heatDays），-1 = 全部（总览） */
export const heatDay = ref(-1)

/** 总交会库（仅「交会热力」来源使用）：
 *  后台「主从计算 / 配对标注」会产生 scope 更窄的批次，但前台只认「全体 × 全体」全量批次，
 *  即「总交会库」= 最近一次 mode='all' 的成功批次；下方批次下拉可回看历史全量批次。
 *  heatBatchRunId：null = 不指定，由后端解析最近全量批次；>0 = 回看指定批次。
 *  heatBatches：可选批次列表（最近 N 个全量批次，含扫描时间与事件数）。 */
export const heatBatchRunId = ref<number | null>(null)
export const heatBatches = ref<ConjBatchItem[]>([])
/** 智能体联动：本次打开碰撞热力面板要聚焦的目标卫星 NORAD（null = 不过滤）。
 *  由 index.vue 在 open_panel(heat, selectFirst) 时写入（动作显式 norad 优先，否则取当前三维已选中的那颗星 ——
 *  「先问某星位置、再问它的交会」时，会话上下文里的选中星就是目标）；
 *  CdmHeatmap 在面板打开 / 触发自动选中时**读取并消费**（置回 null），据此把列表关键词检索设为该 NORAD，
 *  保证「定位到目标卫星的交会」，而不是列表里第一条别的卫星的交会。 */
export const heatFocusNorad = ref<number | null>(null)
/** 当前来源的全部碰撞事件（后端按 heatDays 窗口 + heatSource 查询，
 *  已在后端剔除无效预警（Pc ≤ 0）、补齐配色 / 风险权重 / 聚类密度 / 指标文案 / 按日归属）。 */
export const heatList = ref<CdmHeatEvent[]>([])
/** 配色图例（后端按来源口径下发：Pc 分档 / 最近距离等级，前端直接渲染，不做换算） */
export const heatLegend = ref<HeatLegendItem[]>([])
/** 图例勾选状态（键 = 档位配色 hex）：取消勾选的档位在三维热力视图中隐藏（heatFiltered 过滤后不参与渲染）。
 *  以配色为键而非图例文案：CDM 来源的图例文案是概率区间（如「中危」），而事件 metric_text 是具体概率值，
 *  两者不同；配色由后端按同一套阈值下发，事件 color 必与某一图例项完全一致，三种来源通用。
 *  切换来源时清空（各来源档位语义不同，避免跨来源误隐藏）。 */
export const heatHiddenColors = reactive(new Set<string>())
watch(heatSource, () => { heatHiddenColors.clear() })
/** 指标名（如「碰撞概率」/「最近距离」），供面板与详情标题展示 */
export const heatMetricLabel = ref('')
/** 按日切片分组（后端按 UTC 当日 0 点切片下发 day/date/count；heatDays<=0 时为空数组） */
export const heatDayGroups = ref<HeatDayGroup[]>([])
/** 热力数据加载中 / 加载失败 */
export const heatLoading = ref(false)
export const heatError = ref('')
/** 当前选中的碰撞事件（热力模式点击事件点时，右侧展示事件详情） */
export const heatSel = ref<CdmHeatEvent | null>(null)
/** 当前选中「碰撞云」聚合出的该区域全部碰撞事件（同一对卫星多次交会 / 邻近卫星对交会合并在同一片云）；
 *  右侧据此列出整片云的碰撞列表，heatSel 为其中当前聚焦的一个事件（画两星轨道）。 */
export const heatSelList = ref<CdmHeatEvent[]>([])
/** 事件详情面板开关（热力模式点事件后打开，可收起保留选中） */
export const heatOpen = ref(true)

/** 当前按日切片过滤后的事件列表（heatDay === -1 时展示总览全部）。
 *  按日归属由后端在按日切片时写入事件字段 day（1..heatDays；不切日时为 0），前端只做等值筛选。
 *  再叠加「图例勾选」过滤：取消勾选的档位（按配色匹配）不参与热力渲染。 */
export const heatFiltered = computed(() => {
  const base = heatDay.value < 1 ? heatList.value : heatList.value.filter((e) => e.day === heatDay.value)
  if (!heatHiddenColors.size) return base
  return base.filter((e) => !heatHiddenColors.has(e.color))
})

/* ============================================================
 * 过境分析（/situation 三维地球地表叠加）
 *  口径：过境目标是**面**而不是「城市点画圆」——
 *    中国按地级行政区划面（/cgi/pass/map 的 districts），其他国家按国界面（borders 中排除中国）；
 *    点击某个市即在地球上高亮该市行政区划面，并读取该目标未来 24h 过境明细。
 *  - 地理底图：行政区划面 + 国界（110m）+ 城市标注（50m），一次性从 /cgi/pass/map 拉取，缓存在内存；
 *    目标面按当前「数据批次」着色（有过境明细的 id 在 passBatchCityIds 中），无数据目标也可点选（明细为空）；
 *  - 数据批次：passBatchRunId = null 时由后端解析最近有数据的成功批次，>0 回看指定批次；
 *    切换批次只重拉目标 id 集合（/cgi/pass/city_ids）与明细，静态地理底图不重拉；
 *  - 交互：点击目标面 → /cgi/pass/city/:id?run_id= 只读预计算明细（pass_detail，汇总任务按批落库），
 *          并高亮该目标的行政区划面 + 镜头转到该目标；点击过境列表项 → 把那颗星的整圈空间轨道线复染成红色、
 *          在该轨道上标出本次过境（AOS / 最高仰角 / LOS）+ 放上卫星模型，镜头转过去；
 *  - 图例：行政区域 / 国界 / 城市 三个图层独立显隐，纯前端控制，不重复请求。
 * ============================================================ */
/** 过境分析的两个子项（dock「过境分析」按钮点击后向上弹出，与「热力来源」菜单同款）：
 *  'pass'   = 城市过境（点地球行政区划读 pass_detail 预计算明细）；
 *  'region' = 区域过境（球面框选多边形，提交后端现算）；
 *  'multi'  = 多区域过境（连续框选多个区域 → 组成「多区域组合」→ 一次扫描覆盖多个区域）。
 *  三者共用 passMode 视图与 dock 高亮态；后两者是**互相独立**的两套链路（各自的接口与结果表），
 *  互不混用，避免把「多区域」塞进单区域的缓存与批次里。 */
export type PassSource = 'pass' | 'region' | 'multi'
export const PASS_SOURCES: { key: PassSource; label: string; desc: string }[] = [
  { key: 'pass', label: '城市过境', desc: '点行政区划面 · 未来 24h 载荷过境明细' },
  { key: 'region', label: '区域过境', desc: '球面框选区域 · 现算该区域过境' },
  { key: 'multi', label: '多区域过境', desc: '连续框选多个区域 · 一次扫全部，并给出同时覆盖分析' }
]

/** 过境视图开关：进入后隐藏卫星云 / 轨道线 / 热力标记，只显示地表叠加图层 */
export const passMode = ref(false)
/** 地理底图（行政区划面 + 国界 + 城市标注）加载中 / 加载失败 */
export const passGeoLoading = ref(false)
export const passGeoError = ref('')
/** 地理底图数据（一次性拉取后常驻，图例开关只控制显隐；与批次无关） */
export const passBorders = shallowRef<PassBorderItem[]>([])
export const passDistricts = shallowRef<PassDistrictItem[]>([])
/** 省级聚合面（level='province_agg'）：不参与过境扫描与拾取，仅用于「整省高亮」与面板省级汇总 */
export const passProvinces = shallowRef<PassDistrictItem[]>([])
export const passCities = shallowRef<PassCityItem[]>([])
/** 图例开关：行政区域（中国行政区划面）/ 国界 / 城市标注 图层显隐 */
export const passDistrictVisible = ref(true)
export const passBorderVisible = ref(true)
export const passCityVisible = ref(true)

/**
 * 参与过境的目标面（与后端 passScan.loadTargets 同口径）：
 *   中国 → districts（地级行政区划面）；其他国家 → borders 中 iso_a2 ≠ 'CN' 的国界面。
 * 中国的国界只用于地表描边，不作为过境目标（否则同一片国土会按国界面再算一遍）。
 * districts 与 borders 都是静态数据，故用 computed 惰性合成（图例 / 拾取 / 列表用到时才算）。
 */
export const passTargets = computed<PassTargetItem[]>(() => {
  const out: PassTargetItem[] = []
  for (const d of passDistricts.value) {
    out.push({
      id: Number(d.id),
      geo_type: 'district',
      name: d.name || '',
      name_cn: d.name_cn || d.name || '',
      name_en: '',
      country: '中国',
      adcode: d.adcode || '',
      level: d.level || '',
      province: d.province || '',
      province_adcode: d.province_adcode || '',
      longitude: Number(d.longitude ?? 0),
      latitude: Number(d.latitude ?? 0),
      rings: d.rings || []
    })
  }
  for (const b of passBorders.value) {
    // 中国的国界只用于地表描边，不作为过境目标（与后端 loadTargets 的 iso_a2 <> 'CN' 同口径）；
    // 台湾（iso TW）已作为中国的省级政区（中国台湾省 + 县级政区）参与过境，故国界层同样排除
    const iso = String(b.iso_a2 || '')
    if (iso === 'CN' || iso === 'TW') continue
    out.push({
      id: Number(b.id),
      geo_type: 'border',
      name: b.name || '',
      name_cn: b.name_cn || '',
      name_en: b.name_en || '',
      country: b.country || '',
      adcode: '',
      level: '',
      province: '',
      province_adcode: '',
      longitude: Number(b.longitude ?? 0),
      latitude: Number(b.latitude ?? 0),
      rings: b.rings || []
    })
  }
  return out
})

/** 省级聚合目标（与 passTargets 分离）：geo_type='province_agg'，供「整省高亮」/ 省级明细 / 面板省级列表使用。
 *  不并入 passTargets：整省面会覆盖地市拾取网格，故省级面不参与地球俯视拾取，只按 id/名称被动选中。 */
export const passProvinceTargets = computed<PassTargetItem[]>(() =>
  passProvinces.value.map((p) => ({
    id: Number(p.id),
    geo_type: 'province_agg' as const,
    name: p.name || '',
    name_cn: p.name_cn || p.name || '',
    name_en: '',
    country: '中国',
    adcode: p.adcode || '',
    level: p.level || 'province_agg',
    province: p.province || '',
    province_adcode: p.province_adcode || '',
    longitude: Number(p.longitude ?? 0),
    latitude: Number(p.latitude ?? 0),
    rings: p.rings || []
  }))
)

/** 过境「数据批次」：null = 由后端解析最近有数据的成功批次；>0 = 回看指定历史批次。
 *  与交会热力的 heatBatchRunId 同构，但不分来源（过境只有一套表）。 */
export const passBatchRunId = ref<number | null>(null)
/** 可选批次列表（最近 N 个有汇总数据的成功批次，供面板「数据批次」下拉） */
export const passBatches = ref<PassBatchItem[]>([])
/** 当前批次有明细的目标 id 集合（/cgi/pass/city_ids 下发；目标列表与地球面层着色据此区分）。
 *  注意与 g.passTargetPickIds 区分：后者是「实际参与射线拾取」的目标（本集合的超集，无数据也可点选）。 */
export const passBatchCityIds = shallowRef<number[]>([])
/** 目标 id 集合的快速查找版（列表着色用） */
export const passBatchCityIdSet = computed(() => new Set(passBatchCityIds.value))

/** 当前批次「有过境数据」的省级聚合面 id 集合：某省下辖任一地级市在本批次有明细，即视为该省有数据
 *  （省级面无自身明细行，不参与扫描，其数据由下辖市聚合）。 */
export const passProvinceWithDataIds = computed(() => {
  const ids = new Set<number>()
  const batch = passBatchCityIdSet.value
  if (!batch.size || !passProvinces.value.length) return ids
  for (const p of passProvinces.value) {
    const pad = String(p.adcode || p.province_adcode || '')
    if (!pad) continue
    if (passDistricts.value.some((d) => String(d.province_adcode || '') === pad && batch.has(Number(d.id)))) {
      ids.add(Number(p.id))
    }
  }
  return ids
})

/** 按 id 查过境目标：先查地市 / 国界面，再查省级聚合面（省级面不在 passTargets 内，故单独兜底）。
 *  供地球点选 / 列表点击 / 智能体动作统一解析目标对象。 */
export function findPassTargetById(id: number): PassTargetItem | null {
  return passTargets.value.find((t) => t.id === id)
    || passProvinceTargets.value.find((t) => t.id === id)
    || null
}

/** 当前选中的过境目标（点击行政区划面 / 国界面后打开右侧数据面板） */
export const passSelTarget = ref<PassTargetItem | null>(null)
/** 该目标过境明细（只读 pass_detail 预计算结果；明细为空即该目标尚未跑过汇总） */
export const passDetail = ref<PassCityDetail | null>(null)
export const passLoading = ref(false)
export const passError = ref('')
/** 过境明细弹窗是否展开：与 passSelTarget 解耦 —— 收起只隐藏弹窗，
 *  保留选中目标与三维高亮面/过境标记（避免「关闭即地球还原」）；再次点选目标时自动置 true */
export const passDetailOpen = ref(true)

/* ============================================================
 * 区域过境（框选多边形 → 提交 /cgi 现算 → 轮询进度 → 结果列表）
 *  - 框选：passMode 下进入 regionDrawMode，在地球上逐点单击取经纬度（拾取与绘制在 BaseScene.vue）；
 *    绘制期间冻结虚拟时间（地球静止），否则自转会让拾取点与点击时刻错位；
 *  - 顶点只存在前端（scene.ts），提交时把 [[lon,lat],...] 交给 /cgi/pass/region/scan
 *    （后端会先把顶点写入区域库 pass_region，同顶点集合去重复用，再开始算过境）；
 *  - 结果与进度由 RegionPanel.vue 自持（BaseScene 不消费结果），此处只留框选协作状态。
 * ============================================================ */
/** 是否处于框选模式：开启后在球面逐点单击选顶点，双击（首尾闭合）/ 点回起始点 / 点「完成框选」结束 */
export const regionDrawMode = ref(false)
/** 已选顶点（经纬度，°，按点击顺序；外环、简单多边形） */
export const regionDraft = ref<{ lon: number; lat: number }[]>([])
/** 框选操作提示（顶点数不足 / 越界等，供面板展示） */
export const regionHint = ref('')

/** 区域过境：当前选中的过境记录标识（norad + AOS 毫秒；null = 未选中）。
 *  由 RegionSection 列表项点击写入，BaseScene 据此绘制卫星模型 / 轨道 / 扫描区域，列表也据此高亮。 */
export const regionPassSel = ref<{ norad_id: number; aos_ms: number } | null>(null)
/** 区域过境：是否正在沿 AOS→LOS 播放该次过境的卫星飞行（播放条驱动，动画循环推进虚拟时间） */
export const regionPassPlaying = ref(false)
/** 区域过境：播放进度 0~1（面板进度条用；未播放时为 0） */
export const regionPassProgress = ref(0)

/* ============================================================
 * 多区域过境（连续框选多个区域 → 一次扫描 → 同时覆盖分析）
 *  与「区域过境」是**独立链路**：状态、接口、批次表、明细表全部分开，互不影响（可各自运行）；
 *  交互形态 = 逐个区域框选：画完一个（双击 / 点回起点 / 点「完成本区域」）→ 存入 multiAreas，接着画下一个。
 *  - 顶点只在前端（本文件），提交时把 [{ name, polygon }] 交给 /cgi/pass/multi_region/scan
 *    （后端会把框选区域补进区域库、同顶点复用，再起独立的多区域扫描，不占用单区域链路的并发位）；
 *  - 结果与进度由 MultiRegionPanel.vue 自持（BaseScene 不消费结果），此处只留框选协作状态。
 * ============================================================ */
/** 是否处于「多区域」框选模式（与单区域的 regionDrawMode 由面板保证互斥） */
export const multiDrawMode = ref(false)
/** 正在框选的这个区域的顶点（画满一个就推入 multiAreas 再清空） */
export const multiDraft = ref<{ lon: number; lat: number }[]>([])
/** 已完成的区域列表（顺序即 area_index，提交时按此顺序；name 可在面板里改）。
 *  points 为空而 region_id > 0 表示「来自区域库」（顶点由后端按 region_id 读取，保证与区域库一致）。 */
export const multiAreas = ref<{
  name: string
  points: { lon: number; lat: number }[]
  region_id?: number
}[]>([])
/** 多区域框选提示（顶点数不足 / 越界 / 已达上限等） */
export const multiHint = ref('')

/** 多区域过境：当前选中的过境记录标识（norad + AOS 毫秒 + 所属区域序号；null = 未选中）。
 *  area_index 缺省表示选中的是「同时覆盖」组（一次真实多区域过境，跨多个区域），
 *  此时明细卡片不高亮（它们要求 area_index 相等），但播放条照常出现。
 *  由 MultiRegionPanel 写入，BaseScene 据此绘制卫星模型 / 轨道 / 该区域（或该组各区域）的扫描条带。 */
export const multiPassSel = ref<{ norad_id: number; aos_ms: number; area_index?: number } | null>(null)
/** 多区域过境：是否正在沿 AOS→LOS 播放该次过境的卫星飞行（播放条驱动，动画循环推进虚拟时间） */
export const multiPassPlaying = ref(false)
/** 多区域过境：播放进度 0~1（面板进度条用；未播放时为 0） */
export const multiPassProgress = ref(0)

/* ============================================================
 * 移动端底部抽屉：自由高度 + 下滑手势
 *  - 默认高度 20vh（原 40vh 减半），上半屏留给地球观察
 *  - 在 .sp-head 上拖拽：高度实时跟手，松手后停在任意位置（不再吸附固定档位）
 *  - 高度上限＝「右下角（收起态）图例下沿」，抽屉顶边不越界遮挡图例；
 *    下限 15vh，继续下拉越过阈值则关闭面板
 *  - 状态集中在 scene.ts（模块级 ref），切换面板时高度保持不重置；
 *    关闭面板时重置为默认高度（下次打开是默认高度）
 * ============================================================ */
/** 抽屉默认高度（vh）：打开面板时的初始高度 */
export const DRAWER_DEFAULT_VH = 20
/** 抽屉高度下限（vh）：松手后允许停住的最小高度 */
export const DRAWER_MIN_VH = 15
/** 拖拽视觉下限（vh）：拖拽中允许压到的最低高度（低于关闭阈值即视为下拉关闭意图） */
const DRAG_FLOOR_VH = 10
/** 关闭判定阈值（vh）：松手时未经裁剪的原始高度低于该值 → 关闭面板 */
const CLOSE_VH = 13
/** 顶部预留高度（px）：右下角图例（top:10px + 收起高度 + 间隙）所需空间，抽屉顶边在此之下；
 *  与 index.scss 的 .side-panel max-height 同源（略保守，确保 JS 先于 CSS 触顶） */
const DRAWER_TOP_RESERVED_PX = 145
/** 底部 dock 导航占位（px）：与 .side-panel 的 bottom 定位一致 */
const DRAWER_DOCK_PX = 88

/** 抽屉高度上限（vh）：按 .constel-page 实际高度换算（抽屉的定位上下文就是它）；
 *  JS 侧保守取值，避免出现「上拉没反应、松手后下拉先空走一段」 */
function drawerMaxVh() {
  const page = document.querySelector('.constel-page') as HTMLElement | null
  const pageH = page?.clientHeight || window.innerHeight || 800
  const viewH = window.innerHeight || 800
  return Math.max(DRAWER_MIN_VH, ((pageH - DRAWER_TOP_RESERVED_PX - DRAWER_DOCK_PX) / viewH) * 100)
}

/** 当前抽屉高度（vh）：自由拖拽模型，松手后停在当前位置 */
export const drawerHeightVh = ref(DRAWER_DEFAULT_VH)
/** 是否正在拖拽（拖拽时禁用 height 过渡，松手后恢复） */
export const isDrawerDragging = ref(false)
/** 面板关闭时重置为默认高度（下次打开回到默认高度） */
watch(dockMode, (v) => { if (!v) drawerHeightVh.value = DRAWER_DEFAULT_VH })

/**
 * 抽屉拖拽手势 composable：在移动端面板 .sp-head 上绑定 touch 事件。
 * - 拖拽改变 --drawer-h CSS 变量（高度实时跟随手指，超过上下限则停住）
 * - 松手后停在当前位置；低于关闭阈值则关闭面板
 * - 面板关闭通过 closeFn 回调交给各面板自行 emit
 */
export function useDrawerDrag(closeFn: () => void) {
  let startY = 0
  let active = false
  /** 拖拽起始高度（vh） */
  let startH = DRAWER_DEFAULT_VH
  /** 拖拽中未经下限裁剪的原始高度（vh），松手时用它判定是否关闭 */
  let rawVh = DRAWER_DEFAULT_VH
  /** 本次拖拽的高度上限（vh）：拖拽开始时算一次，避免每帧查询 DOM */
  let maxVh = DRAWER_DEFAULT_VH

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    // 不拦截 .sp-close 的触摸（关闭按钮自己处理 click）
    const target = e.target as HTMLElement
    if (target.closest('.sp-close')) return
    active = true
    isDrawerDragging.value = true
    startY = e.touches[0].clientY
    startH = drawerHeightVh.value
    rawVh = startH
    maxVh = drawerMaxVh()
  }

  function onTouchMove(e: TouchEvent) {
    if (!active) return
    e.preventDefault()
    const deltaY = e.touches[0].clientY - startY
    rawVh = startH - (deltaY / (window.innerHeight || 800)) * 100
    drawerHeightVh.value = Math.min(maxVh, Math.max(DRAG_FLOOR_VH, rawVh))
  }

  function onTouchEnd() {
    if (!active) return
    active = false
    isDrawerDragging.value = false
    // 下拉越过下限 → 关闭面板（高度复位由 dockMode 的 watch 处理）
    if (rawVh < CLOSE_VH) {
      closeFn()
      return
    }
    // 自由高度：停在松手位置，仅做上下限收敛（不吸附档位）
    drawerHeightVh.value = Math.min(maxVh, Math.max(DRAWER_MIN_VH, rawVh))
  }

  return { onTouchStart, onTouchMove, onTouchEnd }
}

// [TEMP DEBUG] 运行时调试钩子：暴露场景内部状态，排查热力还原后卫星消失问题
;(window as any).__sceneDbg = { g, visible, heatMode, heatDay, heatDays, heatList, filterConst, filterKw, heatFiltered }
