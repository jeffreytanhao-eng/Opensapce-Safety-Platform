<script setup lang="ts">
/**
 * 星座总览 /situation 基础场景组件
 * 承载全部 3D 场景逻辑：一次性渲染全部在轨物体（每个卫星型号一个 InstancedMesh 实例化对应真实模型，
 * 型号由 resolveModelKey 从星座名 / object_name 识别，模型按 low/med/high 分档「先粗后精」加载）、
 * 点击卫星四角准星标记 + 绘制轨道线 + 详情、hover 预览轨道线、检索/星座/高度过滤轨道线、
 * 卫星持续运动（全量外推 + 预算内精确校准）、动画循环、拾取与镜头飞行。
 *
 * 本组件只做「场景」：渲染 canvas + 准星覆盖 + 加载/错误遮罩 + 顶部通知；
 * dock / 面板 / 图例 / 右侧详情面板由父组件 index.vue 编排，通过 props + emit + expose 与本组件通信，
 * 共享响应式状态集中在 scene.ts。
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch, type Ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLat, degreesLong } from 'satellite.js'
import { listConstellationPublic, listTleLinesPublic, decodeConstellation, getSatDetailPublic, listAllConstellationsPublic, listSatConstellationsPublic, getCdmHeatmap, getConjHeatmap, getConjBatches, getCriHeatmap, getCriBatches, getConjEllipsoid, type ConstellationPoint, type ConstellationSnapshot, type SatTleItem, type CdmHeatEvent, type HeatmapResult, type ConjEllipsoidSide, type SatSource } from '@/api/sat_public'
import { cacheGet, cacheSet, cacheFirst, ensurePersistent } from '@/utils/persistCache'
import { useDevice, detectDeviceTier } from '@/composables/useDevice'
import { useDelayed } from '@/composables/useDelayed'
import { useRoute, useRouter } from 'vue-router'
import {
  TYPE_MODEL, TYPE_KEYS, TYPE_COLOR,
  ORBIT_LIVE_STEP_MS, ZERO_M,
  EARTH_R, KM_TO_SCENE, EARTH_RADIUS_KM, PICK_TOLERANCE_PX,
  BASE, cdnUrl, ensureAssetBase,
  QUALITY_PRESETS, MODEL_COARSE, MODEL_NO_FLIP_Y,
  resolveModelKey, modelUrlOf, modelVisible,
  colorMode, colorLegend, bucketKeyOf, bucketColorHexOf, colorBucketDefs, NA_BUCKET_KEY,
  type QualityTier, type QualityPreset, type ModelLod, type InstInfo, type HeatSource,
  eciToScene, sunDirection, moonDirection, parseEpoch, orbitSteps, disposeGroup, disposeScene,
  g, loading, error, notice, modelNotice,
  sel, hasSel, selDetail, detailOpen, selConstellations,
  constellations, filterKw, filterConst, altMin, altMax, filterNorads, satSetActive, cloudRevealed,
  consShowMap, consOverrideActive, consShowOf, consCardBound,
  compareConsts, compareActive,
  visibleCount, orbitTotal, orbitSkipped, loadProgress, orbitBuilding, orbitProgress, filterActive,
  consHighlightNorad, CONS_HIGHLIGHT_COLOR, rebuildConsSatIndex, consOrbitOn,
  dockMode, dockActive, satPanel, dataSource, visible, rebuildSatIndex, orbitVisible,
  simSpeed, simPlaying, simTimeMs,
  heatMode, heatDays, heatDay, heatList, heatLoading, heatError, heatSel, heatSelList, heatOpen,
  heatSource, heatLegend, heatMetricLabel, heatDayGroups,
  heatBatchRunId, heatBatches,
  heatFiltered, heatHiddenColors,
  heatAltBand, heatMetric, heatRiskFloor, heatPcFloor, heatMissCeil,
  heatCell, heatColorOf,
  passMode, passGeoLoading, passGeoError, passBorders, passDistricts, passProvinces, passCities, passTargets, findPassTargetById,
  passDistrictVisible, passBorderVisible, passCityVisible, passSelTarget, passDetail, passLoading, passError,
  passDetailOpen,
  passBatchRunId, passBatches, passBatchCityIds, passBatchCityIdSet,
  regionDrawMode, regionDraft, regionHint,
  multiDrawMode, multiDraft, multiAreas, multiHint,
  regionPassSel, regionPassPlaying, regionPassProgress,
  multiPassSel, multiPassPlaying, multiPassProgress,
  skyLayers, spaceWeather, spaceWeatherError, spaceWeatherLoading, spaceWeatherAt,
  sceneQualityTier,
  conjEllipsoid, conjEllipsoidError, conjEllipsoidLoading, covDisplayScale,
  launchSites, siteMarkersVisible, siteSel, siteOpen
} from './scene'
import {
  configureEarthBase, initCesium,
  renderCesium, syncCameraToThree, setCameraFromScene,
  resizeCesium, destroyCesium, applyCesiumQuality,
  pickEarthLonLat as cesiumPickEarthLonLat
} from './cesiumEarth'
import { buildLunarMansions, SKY_LABELS } from './lunarMansions'
import { buildWesternConstellations, WESTERN_LABELS } from './westernConstellations'
import { interpolateAt } from './ephem/interp'
import type { EphemSet, EphemState, ThreatEvent } from './ephem/types'
import { buildStarfield } from './starfield'
import {
  getPassMap, getPassBatches, getPassCityIds, getPassCityDetail,
  type PassTargetItem, type PassDetailItem
} from '@/api/pass_public'
import { getSpaceWeather } from '@/api/space_weather_public'
import type { LaunchSiteItem } from '@/api/launch_public'
import type { RegionAccessItem } from '@/api/pass_region_public'
import type { MultiRegionAccessItem } from '@/api/pass_multi_region_public'

/** 组件是否已真正销毁（keep-alive 清缓存 / 移除 include / 页面关闭）。加载流程每个 await 返回后都要重查。 */
let disposed = false
/** 加载期间：若真实进度长时间停留（网络请求 / CPU 构建），用假进度缓慢推进，让加载条有变化 */
let fakeTimer: number | null = null
/** 容器尺寸监听：keep-alive 切回 / 安卓 WebView 首帧布局晚于 onMounted / 横竖屏切换时，
 *  只有它能在「容器真正拿到尺寸」的那一刻纠正画布尺寸，避免画布停在 0×0（大白板） */
let ro: ResizeObserver | null = null

const container = ref<HTMLDivElement>()
const { isMobile } = useDevice()

/** 首屏加载阶段文案：随流程推进（加载卫星 → 解析轨道 → 构建星座 → 渲染场景），
 *  避免整段加载只显示一句「正在加载星座数据」显得死板 */
const loadStage = ref('正在加载卫星数据…')

/* ============================================================
 * 地球中央操作 loading
 * 「正在绘制轨道线…」「正在加载碰撞事件…」原先分散在星座列表 / 热力面板 / 右侧碰撞列表内部，
 * 位置凌乱；这里统一收敛到地球正中央展示（主加载遮罩 loading 已覆盖时不再叠加）。
 * 两者都走「超时兜底」：正常毫秒级返回时不显示提示，持续超过 1.5s 才出现，
 * 避免每次切换星座 / 切换热力来源都闪一下 loading。
 * ============================================================ */
const orbitBuildingHint = useDelayed(orbitBuilding)
const heatLoadingHint = useDelayed(heatLoading)
/** 过滤轨道线的「准备轨道数据」阶段（等 satrec 懒加载）：TLE 首次拉取 + 3.5 万分块解析是秒级的，
 *  这段时间还没进入分批绘制（orbitBuilding 尚未置位就会被 1.5s 兜底阈值截断），必须单独给提示，
 *  否则表现为「点星座后 loading 消失了、轨道线迟迟不出」（见 rebuildFilterOrbits）。 */
const orbitPreparing = ref(false)
const orbitPreparingHint = useDelayed(orbitPreparing)

/** 点云后台装载中（骨架已出、整屏遮罩已撤）：仅当装载超过阈值才提示，
 *  有本地缓存时毫秒级完成、根本不会出现提示 */
const cloudLoading = ref(false)
const cloudLoadingHint = useDelayed(cloudLoading)

const centerLoading = computed<{ text: string; bar: number | null } | null>(() => {
  if (loading.value) return null
  if (cloudLoadingHint.value) {
    return { text: loadStage.value, bar: loadProgress.value > 0 ? loadProgress.value : null }
  }
  if (orbitPreparingHint.value) {
    return { text: '正在准备轨道数据…', bar: null }
  }
  if (orbitBuildingHint.value) {
    return {
      text: `正在绘制轨道线… ${orbitProgress.value}%（${visibleCount.value.toLocaleString()} 颗）`,
      bar: orbitProgress.value
    }
  }
  // 仅热力视图下才提示碰撞事件加载：卫星/星座模块相对独立，不串入热力模块的 loading
  if (heatMode.value && heatLoadingHint.value) return { text: '碰撞云图生成中…', bar: null }
  return null
})

/* ============================================================
 * 画质档位：静态硬件探测定初值，运行时按实测帧率只降不升（避免来回抖动）
 * ============================================================ */
let qualityTier: QualityTier = detectDeviceTier()
let quality: QualityPreset = QUALITY_PRESETS[qualityTier]
// 把实际生效的档位同步到响应式状态：供调试与运行时参考
sceneQualityTier.value = qualityTier
/** 每轮 SGP4 传播预算（随档位变化：低端机下调，避免播放/交互掉帧） */
let propBudget = quality.propBudget
/** SGP4 校准（消除长期漂移）的执行节奏 —— 与「一次性绘制」用的 propBudget 分开：
 *  · 单批预算 = 档位预算的 1/4：校准只影响长时间漂移，不需要和绘制抢同一份预算；
 *  · 批次间隔 100ms（原为 33ms）。
 *  为什么改：实测 /situation/sat 存在「每约 0.6s 一批」的主线程长帧（LoAF 归因到本文件的 loop，
 *  脚本耗时 75~88ms、阻塞 25~32ms，期间 draw calls 与三角形数完全不变），根因就是这批校准——
 *  原参数每 33ms 就有 1600~2400 颗 SGP4 传播 + 实例矩阵整批重写。现在单批降到 400~600 颗、
 *  间隔 100ms：单批约 5~15ms（不再形成长帧），一轮全量校准由约 0.7s 拉长到约 6s。
 *  代价：实时档下卫星位置在两次校准之间最多外推约 6s，位置偏差约 1km（可视尺度下不足 0.5px）。 */
const CALIB_INTERVAL_MS = 100
function calibBudget(): number {
  return Math.max(200, Math.floor(propBudget / 4))
}
/** 自上次落实例矩阵以来、按「最大可能速度」累计的位移（场景单位）：用于跳过位移不可见的整批矩阵重写
 *  （阈值与判定见 updateExtrapolate 的 MATRIX_SKIP_SCENE）。声明在此是为了让「整批重写矩阵」的函数
 *  （rewriteInstanceMatrices / buildModelInstances）也能安全地把它清零。 */
let matrixDrift = 0

/* ============================================================
 * 初始机位：进入本页与镜头复位时正对的地表点（中国中部）
 *  - 不写死相机坐标：地球贴图 offset 与贴地组 rotation.y 都随 gstime 变化，
 *    写死的方向在不同时刻进入会指向不同海域（原实现固定 (3.0, 1.9, 4.6)，进入时常落在太平洋）；
 *  - 时间仍只体现在地球自转与晨昏线上，不影响「进入时看到哪里」。
 * ============================================================ */
/** 目标地表点（°）：武汉（缺省打开系统时的屏幕定位中心，南北极与屏幕垂直中线重合——
 *  相机 up 恒为世界 +Y（北极轴），正对点居中即极轴竖直） */
const HOME_LON = 114.3
const HOME_LAT = 30.6
/** 初始/复位机位距地心距离：4.5 —— 地球直径约占视口高 50%（外置浏览器窗口较矮时，
 *  顶部仍留出标题栏与余量，不再遮挡球体；866px 高视口下观感依然饱满）。
 *  原值 3.5（直径约 64%）在矮窗口下顶部会被标题栏遮住；历史值 Math.hypot(3.0, 1.9, 4.6) ≈ 5.83 时仅约 37%。
 *  4.5 仍远大于穿地限位 EARTH_ORBIT_MIN_DIST(1.08)，滚轮缩放不受影响。 */
const HOME_CAM_DIST = 4.5

/** 当前时刻该地表点在场景世界坐标中的方向（含 passGroup 自转相位） */
function homeDirection(): THREE.Vector3 {
  const local = lonLatToScene(HOME_LON, HOME_LAT, 1)
  const rotY = gstime(new Date(g.simTimeMs))
  const cosR = Math.cos(rotY)
  const sinR = Math.sin(rotY)
  // 局部（ECEF 口径）→ 世界：与 passGroup.rotation.y 施加的是同一个旋转量
  return new THREE.Vector3(
    local.x * cosR + local.z * sinR,
    local.y,
    -local.x * sinR + local.z * cosR
  )
}

/** 把相机放到「正对该地表点」的位置（不改地球自转相位，故任意时刻进入都能对准） */
function applyHomeCamera() {
  const cam = g.camera
  if (!cam) return
  cam.position.copy(homeDirection()).multiplyScalar(HOME_CAM_DIST)
  cam.up.copy(WORLD_UP)
  cam.lookAt(0, 0, 0)
  if (g.controls) {
    g.controls.target.set(0, 0, 0)
    // 焦点回到地心 → 极角限位保持同一套口径（见 applyOrbitPolarLimits）
    applyOrbitPolarLimits()
    g.controls.update()
  }
  // Cesium 模式：同一机位写入 Cesium 相机（Cesium 是相机主控，只写 Three 会被下一帧
  // syncCameraToThree 反灌覆盖；setView 立即生效，不触发 moveStart/End）
  if (cesiumActive) {
    const dir = homeDirection().negate() // 望向地心（homeDirection 每次返回新向量，negate 安全）
    setCameraFromScene(cam.position, dir, cam.up, g.simTimeMs)
  }
}

/** 仅复位镜头：回到初始机位（武汉 + 初始地球大小），不清选中与过滤（区别于 resetSelected） */
function resetCameraToHome() {
  restoreEarthOrbitLimits()
  applyHomeCamera()
}

/* 运行时帧率自适应状态：滚动窗口统计帧耗时，连续偏低才降一档（只降不升，避免反复抖动） */
const FPS_WINDOW_FRAMES = 24   // 每窗口采样帧数
const FPS_SLOW_MS = 32         // 窗口平均帧耗时阈值（≈31fps 以下视为卡顿）
const FPS_SLOW_WINDOWS = 2     // 连续多个窗口超标才降档，滤掉偶发抖动
let fpsSamples = 0
let fpsAccum = 0
let fpsSlowWindows = 0
/** 启动预热截止时间：刚进入页面（模型构建/纹理上传/轨道线绘制）帧耗时偏高，不参与判定 */
let fpsWarmupUntil = 0
/** 降一档画质（high→mid→low，low 为下限）：把档位参数同步到渲染器与场景对象 */
function applyRuntimeQuality() {
  const next: QualityTier | null = qualityTier === 'high' ? 'mid' : qualityTier === 'mid' ? 'low' : null
  if (!next) return
  qualityTier = next
  quality = QUALITY_PRESETS[next]
  propBudget = quality.propBudget
  sceneQualityTier.value = next
  // 低档隐藏大气辉光壳（半透明大球最耗填充率）
  if (g.atmo) g.atmo.visible = next !== 'low'
  // Cesium 底座同档降开销（影像误差阈值 / MSAA / 分辨率）
  if (cesiumActive) applyCesiumQuality(next)
  // 降采样：重建帧缓冲尺寸（一次性开销，仅降档时发生）
  const renderer = g.renderer
  const el = container.value
  if (renderer && canMeasure(el)) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio))
    renderer.setSize(el.clientWidth, el.clientHeight)
  }
}

/** 选中卫星跟随准星（HTML div，CSS 像素恒定，平行于浏览器）。
 *  位置由动画循环逐帧直接写 DOM style，**不走 Vue 响应式** —— 与地表标签层（passLabelNodes）同一口径：
 *  准星每帧都在跟随卫星，若写成响应式会连带把 BaseScene 这个大组件的模板每帧重渲染一次。 */
const reticleEl = ref<HTMLDivElement>()
const overlayName = ref<HTMLDivElement>()

/** 绕地心观察时「相机到焦点」的最小距离（≈地表之上），防止滚轮缩放钻入地球。
 *  注意它是「相机到 controls.target」的下限：只有 target 在地心时才等价于距地心。
 *  右键环绕把 target 切到选中卫星后必须放宽（见 SATELLITE_FOCUS_MIN_DIST），
 *  否则滚轮拉近会立刻被卡死 —— 聚焦瞬间相机到卫星的距离本就 ≈ 该值。 */
const EARTH_ORBIT_MIN_DIST = 1.08
/** 以选中卫星为焦点环绕时的最小距离：允许滚轮贴近观察卫星细节，
 *  相机穿地球由每帧 clampCameraOutsideEarth() 兜底。 */
const SATELLITE_FOCUS_MIN_DIST = 0.01
/** 绕地心观察 / 以卫星为焦点环绕时的滚轮缩放速度。
 *  OrbitControls 的 dolly 是等比缩放（每次 ×0.95^zoomSpeed），距离越近绝对步长越小；
 *  卫星本身尺度远小于地球，沿用 1 时从「聚焦距离≈1.08」拉到能看清卫星要滚几十下，
 *  体感上像滚轮失灵，故聚焦卫星时调大。 */
const EARTH_ORBIT_ZOOM_SPEED = 1
const SATELLITE_FOCUS_ZOOM_SPEED = 3
/** 拖拽旋转灵敏度（OrbitControls.rotateSpeed 口径）：默认 1 = 拖满一屏高转 360°。
 *  曾因「小幅甩动即越过目标极点」降到 0.5，但 0.5 会让拖动明显发沉（同样距离只转一半），
 *  故回调到 0.7（拖满一屏高转 252°）：比 1 稳、比 0.5 跟手。
 *  移动端环绕摇杆（orbitAroundSel）共用该系数，保证桌面与触屏手感一致。 */
const ORBIT_ROTATE_SPEED = 0.7
/** 极角限位（弧度）——相机 up 恒为世界 +Y，焦点在地心 / 在卫星都用同一套限位（见 applyOrbitPolarLimits）：
 *
 *  「南北不翻」是相机 up 的口径决定的：up 恒取世界 +Y（地球北极永远朝屏幕上方），
 *  绝不随焦点切到「卫星当地天顶」——后者会让南半球卫星的当地天顶 ≈ −Y，
 *  画面整体转 180°（地球南北颠倒），且落位动画期间 up 一路插值还会让地球滚转一大下，
 *  拾取一次就"翻"一次、靠拖动很难调回（历史上两版口径都踩过这个坑）。
 *
 *  极角范围取 [π/6, π−π/6]：与南北极各留 30° 余量 —— 视线一旦与 up 近平行，
 *  three 的 lookAt 取不到稳定滚转角、OrbitControls 的方位角也会退化，画面会当场跳。
 *  焦点在卫星时同样受此限位，故拾取落位机位（flyToSat）必须先把落位方向夹进该范围，
 *  否则落位瞬间 OrbitControls 会把机位拉回限位、画面抖一下。
 *
 *  桌面 OrbitControls（minPolarAngle/maxPolarAngle）、移动端环绕摇杆（orbitAroundSel）、
 *  拾取落位机位（flyToSat）三处共用本限位。 */
const ORBIT_POLE_LIMIT = Math.PI / 6
/** 拾取目标（hasSel）时的极角限位：用户口径「拾取目标时视角可任意旋转，只要不穿地球」。
 *  放宽到仅留 ~2° 余量（近「正对天顶/正对地心」两个奇异点仍被挡住）——完全不限（0）会让视线与 up
 *  平行、lookAt 取不到稳定滚转角、OrbitControls 方位角退化，画面当场乱跳，故留极小余量兜底。
 *  穿地由 clampCameraOutsideEarth 每帧兜底（与极角无关）。未选中时回到 ORBIT_POLE_LIMIT。 */
const ORBIT_POLE_LIMIT_SEL = Math.PI / 90
/** 当前生效的极角限位（弧度）：拾取目标时放宽，其余情况收紧（口径见上两处常量） */
function currentPoleLimit(): number {
  return hasSel.value ? ORBIT_POLE_LIMIT_SEL : ORBIT_POLE_LIMIT
}
/** 世界天顶：相机 up 恒定取值（applyHomeCamera / 镜头飞行 / 每帧渲染都不改写它） */
const WORLD_UP = new THREE.Vector3(0, 1, 0)

/* ============================================================
 * 场景搭建
 * ============================================================ */
function initScene() {
  // 尽早开始解析静态资源基址（/cgi/config 的 staticBase），让地球贴图/模型加载时就已就绪
  void ensureAssetBase()
  const el = container.value!
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x04060b)
  g.scene = scene

  const camera = new THREE.PerspectiveCamera(50, el.clientWidth / Math.max(el.clientHeight, 1), 0.01, 1000)
  // 初始机位对准中国（见 applyHomeCamera）：不写死坐标，否则不同时刻进入会落在随机海域
  g.camera = camera
  applyHomeCamera()

  // alpha:true：Cesium 底座就绪后 Three 背景转透明（scene.background 置 null），地球由下层 Cesium canvas 呈现；
  // Cesium 初始化失败时降级回纯 Three（此时 scene.background 仍为深色，alpha 不影响视觉）
  const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio))
  renderer.setSize(el.clientWidth, el.clientHeight)
  el.appendChild(renderer.domElement)
  g.renderer = renderer

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  // 阻尼系数（OrbitControls 口径）：本版 three 每帧只把「累计旋转增量」按该系数落一部分
  // （spherical.theta += sphericalDelta.theta × dampingFactor），所以系数越小，相机越跟不上手 ——
  // 0.08 时稳态滞后约 11 帧，拖动起来发黏、像有阻力；提到 0.25 后滞后约 3 帧，跟手且松手仍有一小段惯性滑行。
  controls.dampingFactor = 0.25
  // 镜头最近距离限制在地球半径(1)之外，防止滚轮缩放钻入地球
  controls.minDistance = EARTH_ORBIT_MIN_DIST
  controls.zoomSpeed = EARTH_ORBIT_ZOOM_SPEED
  controls.rotateSpeed = ORBIT_ROTATE_SPEED
  // 极角限位：初始焦点在地心，先用「绕地心」口径；焦点切到卫星时由 applyOrbitPolarLimits 收紧（见 ORBIT_POLE_LIMIT）
  controls.minPolarAngle = ORBIT_POLE_LIMIT
  controls.maxPolarAngle = Math.PI - ORBIT_POLE_LIMIT
  controls.maxDistance = 400
  controls.target.set(0, 0, 0)
  // 鼠标映射：左键 = 绕焦点旋转；右键 = 环绕浏览（绕焦点旋转，焦点在右键按下时切到选中卫星，
  // 见 onPointerDown）；中键 = 缩放。OrbitControls 在 ROTATE 态按住 Shift 拖动即平移，故平移能力保留。
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
  g.controls = controls
  // 交互期间（缩放/拖拽）冻结虚拟时间（simStepSec=0），卫星/地球/太阳唯一静止，全把主线程 GPU 让给交互；松手后从冻结点无缝继续
  controls.addEventListener('start', () => { g.userInteracting = true })
  controls.addEventListener('end', () => { g.userInteracting = false })

  scene.add(new THREE.AmbientLight(0xffffff, 0.28))
  const sun = new THREE.DirectionalLight(0xffffff, 2.6)
  sun.position.set(5, 2.5, 4)
  g.sunLight = sun
  scene.add(sun)
  // 补光：增加冷色环境光，增强卫星/轨道轮廓的科技感
  const fill = new THREE.DirectionalLight(0x4a9eff, 0.5)
  fill.position.set(-6, -2, -5)
  scene.add(fill)

  // 背景星空：装饰性星点壳（挂场景根，惯性系固定不动；默认开启，可在图例关闭；见 starfield.ts）
  const starfield = buildStarfield()
  scene.add(starfield)
  g.starfieldGroup = starfield
  // 三垣二十八宿：取代原先的随机星空背景（挂场景根，惯性系固定不动；星官名称标签由模板的 mansionLabelLayer 呈现）
  const mansion = buildLunarMansions()
  scene.add(mansion.group)
  g.mansionGroup = mansion.group
  mansionLineMat = mansion.lineMaterial
  const skySize = g.renderer ? g.renderer.getSize(new THREE.Vector2()) : null
  mansion.lineMaterial.resolution.set(Math.max(1, skySize?.x || 1), Math.max(1, skySize?.y || 1))
  // 西方 88 星座：与三垣二十八宿并列的另一套星空体系（同挂场景根、惯性系；星座名标签由 constellationLabelLayer 呈现）
  const constellation = buildWesternConstellations()
  scene.add(constellation.group)
  g.constellationGroup = constellation.group
  constellationLineMat = constellation.lineMaterial
  constellation.lineMaterial.resolution.set(Math.max(1, skySize?.x || 1), Math.max(1, skySize?.y || 1))
  buildEarth(scene, quality.earthSeg, quality.atmoSeg)
  // Cesium 接管前先隐藏 Three 地球（含大气辉光子节点）：刷新时 initCesium 异步就绪有间隙，
  // 若此时 Three 地球先上屏会「闪一下旧贴图/夜光地球」再切高清影像（用户反馈的闪旧底层贴图）。
  // Cesium 成功后保持隐藏（见 applyCesiumBase），失败降级回纯 Three 时在 applyCesiumBase 内恢复显示。
  if (g.earthMesh) g.earthMesh.visible = false
  buildSky(scene)
  // 场景重建时 passMode 可能仍为 true（keep-alive 切回）：watch 不会补触发，这里按当前模式对齐夜晚灯光层
  applyEarthNightLights(!passMode.value)
  // 静态探测已是最低档时直接隐藏大气（运行时降档由 applyRuntimeQuality 处理）
  if (g.atmo && qualityTier === 'low') g.atmo.visible = false
  window.addEventListener('resize', onResize)
  // 容器尺寸变化（含「首次拿到非 0 尺寸」「keep-alive 切回」「横竖屏切换」）时重算并立刻补一帧，
  // 安卓 WebView 首帧布局晚于 onMounted，仅靠 window.resize 兜不住
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (!canMeasure(container.value) || !g.renderer || !g.camera) return
      onResize()
      if (g.scene && g.camera) g.renderer.render(g.scene, g.camera)
    })
    ro.observe(el)
  }

  // Cesium 底座接线（异步）：成功 = 双引擎混合（Cesium 画地球、Three 画卫星/轨道/星空），
  // 失败 = 自动降级回纯 Three 套路（OrbitControls + Three 地球），交互与视觉全部保持原行为
  void applyCesiumBase()
}

/** 相机距地心硬约束：controls.minDistance 只约束「相机到 target」的距离，target 一旦被
 *  平移（滚轮 dolly 尚可，移动端双指在 OrbitControls 中是 DOLLY_PAN，捏合会同时平移）就会
 *  偏离地心，minDistance 随之失效，镜头可能钻入地球。故每帧对相机位置做兜底修正，
 *  保证滚轮 / 双指 / 平移 / 飞行动画任何操作都不穿透地球。 */
function clampCameraOutsideEarth() {
  const cam = g.camera
  if (!cam) return
  const d = cam.position.length()
  const minD = EARTH_R * 1.02
  if (d > 1e-6 && d < minD) cam.position.multiplyScalar(minD / d)
}

/* ============================================================
 * Cesium 底座接线（双引擎混合模式）
 * 成功后：Cesium canvas 在下层（zIndex 0）承载影像/地形/大气/晨昏线并接收全部相机交互；
 * Three 画布退居透明叠加层（zIndex 1 + pointer-events:none），只画卫星/轨道/星空/标签。
 * 相机由 Cesium 的 ScreenSpaceCameraController 驱动，动画循环每帧被动同步到 g.camera
 * （见 renderCesium / syncCameraToThree / setCameraFromScene），Three 层拾取与投影口径不变。
 * 失败（WebGL 上下文不足 / 资源缺失等）时 cesiumActive 保持 false，一切走原 Three 套路。
 * ============================================================ */
let cesiumActive = false
/** 隐形遮挡球（只写深度不写颜色的 WGS84 椭球）：Three 叠加层不共享 Cesium 深度，
 *  卫星/轨道/星空的地球背面遮挡靠它实现（视觉透明，行为与被隐藏的 Three 地球 mesh 一致） */
let cesiumOccluder: THREE.Mesh | null = null
/** 飞行期间逐帧转递 g.camera 姿态用（避免每帧新建向量） */
const _cesiumFlyDir = new THREE.Vector3()
async function applyCesiumBase() {
  const el = container.value
  if (!el) return
  // 首屏遮罩此刻仍在（onMounted 延迟到 Cesium 首帧才撤，避免「骨架撤罩 → Cesium 未就绪」的黑屏间隙，
  // 也不再闪 Three 旧贴图地球），这里同步阶段文案
  loadStage.value = '正在启动三维地球底座…'
  // 离线数据源地址（影像瓦片包 / DEM 地形包）：后续由 /cgi/config 下发后在此注入；
  // 未配置时 cesiumEarth 内部用 ArcGIS Online 公网影像兜底、椭球面无地形。
  // 地形包生成：node scripts/build-terrain-tiles.mjs --input <DEM.tif>（产物输出到 public/terrain），
  // 启用示例：configureEarthBase({ terrainUrl: import.meta.env.BASE_URL + 'terrain' })
  configureEarthBase({})
  const ok = await initCesium(el, {
    // 对齐原 OrbitControls 'start'/'end'：相机交互期间冻结虚拟时间（simStepSec=0），帧率让给交互。
    // 程序化跟踪（双击卫星 / 点击星历）每帧都会推相机，Cesium 因此持续发 moveStart、迟迟不发 moveEnd，
    // 若照单全收会把 userInteracting 焊死为 true → 虚拟时间永久冻结（播放键失效），故跟踪态下忽略。
    onMoveStart: () => { if (trackGi != null || trackEphem) return; g.userInteracting = true },
    onMoveEnd: () => { g.userInteracting = false }
  }).catch(() => false)
  // 异步期间组件可能已卸载 / 场景可能已重建
  if (!ok || disposed || !g.scene || !g.renderer) {
    // Cesium 失败降级回纯 Three 套路：恢复 Three 地球显示（initScene 里为避闪旧贴图先藏了它；
    // disposed 卸载场景无需恢复），并撤掉首屏遮罩（此时 Three 地球已可见，黑屏结束）
    if (!disposed && g.scene && g.earthMesh) g.earthMesh.visible = true
    if (!disposed) loading.value = false
    return
  }
  cesiumActive = true
  // Three 背景转透明，露出下层 Cesium 地球
  g.scene.background = null
  // Three 画布退居叠加层：绝对定位铺满 + 置顶 + 不再接收输入（事件由 Cesium canvas 接收后冒泡到容器，
  // onMounted 里的 pointer 监听挂的就是容器，拾取/框选链路不用改）
  const canvas = g.renderer.domElement
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.zIndex = '1'
  canvas.style.pointerEvents = 'none'
  // 相机交互权整体移交 Cesium（OrbitControls 保留对象用于降级兜底，仅停用）
  if (g.controls) g.controls.enabled = false
  // Three 地球（含大气辉光子节点与夜光 emissiveMap）整体让位：影像/地形/晨昏线由 Cesium 渲染
  if (g.earthMesh) g.earthMesh.visible = false
  // 隐形遮挡球：WGS84 椭球口径（正球沿赤道/极轴缩放），与 Cesium 地球表面同形，
  // 深度遮挡贴合影像表面；colorWrite=false 只写深度，视觉完全透明。
  // raycast 置空：过境目标面拾取（intersectObjects）不应命中山体。
  const occ = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 96),
    new THREE.MeshBasicMaterial({ colorWrite: false })
  )
  occ.scale.set(WGS84_A_KM / EARTH_RADIUS_KM, WGS84_B_KM / EARTH_RADIUS_KM, WGS84_A_KM / EARTH_RADIUS_KM)
  occ.raycast = () => {}
  // ⚠ 必须最先渲染：Three 不透明队列按 renderOrder → material.id（创建顺序）→ 距离排序
  //（见 three.module.js painterSortStable），而本材质在 buildSky 的太阳/月亮之后才创建，
  //  若不加 renderOrder，日月会先上屏、遮挡球后写深度 —— 背面日月「透过地球」可见。
  //  renderOrder=-1 强制深度先落盘，其后所有不透明/透明对象都会被正确遮挡。
  occ.renderOrder = -1
  g.scene.add(occ)
  cesiumOccluder = occ
  applyCesiumQuality(qualityTier)
  // Cesium 异步就绪晚于首帧布局，而默认渲染循环已关闭（useDefaultRenderLoop=false，
  // 每帧 resize 不再由 Cesium 自跑），ResizeObserver 首班车赶不上：canvas 停在 300×150
  // 默认尺寸。这里按当前容器补一次画布尺寸，让 Cesium canvas 铺满容器（地球居中）。
  resizeCesium()
  // 就绪后立刻渲一帧 Cesium（动画循环下一帧也会带，这里让地球与 Three 叠加层同帧出现，避免闪纯色底）
  renderCesium(g.simTimeMs)
  // Cesium 首帧已渲染：地球此刻真实可见，此刻才撤首屏遮罩（取代 onMounted 骨架期撤除——
  // 那会在「遮罩撤了但 Cesium 还没就绪」留下黑屏/闪旧贴图间隙）
  loading.value = false
  // Cesium 默认视图（本初子午线/赤道上空）会经 syncCameraToThree 反灌成初始机位，
  // 这里在其之前主动写入 home 机位：缺省打开系统时定位到武汉（极轴与屏幕垂直中线重合）
  applyHomeCamera()
  syncCameraToThree(g.camera!, g.simTimeMs)
}

/* ============================================================
 * 太阳 / 月亮（把「光照条件」画进场景）
 *
 * 为什么方向真实、距离压缩：
 *   太阳真实距离 1 AU = 23481 倍地球半径、月亮 60.3 倍地球半径。太阳按真实比例根本进不了
 *   场景（相机 far=1000、星空壳在 110~170），故只压距离、不压方向：太阳放在太阳方向的固定
 *   距离处（星空壳之外），月亮按真实地心距 60.3 放置（本来就在可视范围内），仅把半径放大
 *   约 4 倍使其可辨认（真实视直径仅 0.5°，在 800px 画布上约 8px）。
 *
 * 为什么月亮不需要专门的「月相」计算：
 *   月亮与地球共用同一盏太阳平行光（g.sunLight），朝向太阳的一面被照亮、背面全黑，
 *   月相天然正确。地球同理——昼夜分界线由太阳方向决定，这正是 sunDirection 必须准确的原因。
 *
 * 注：曾经画过的「地影锥」（本影 / 半影实体锥）已移除 —— 半透明锥壁在相机掠过背阳侧时
 *   会呈现为覆盖半个屏幕的巨大扇形暗区（时隐时现、难以预期）。昼夜明暗已由 Cesium
 *   globe.enableLighting 与太阳平行光表达，卫星是否处于地影仍由后端 illumination 计算
 *   （pass_detail.shadow_state），不再需要这层视觉示意。
 * ============================================================ */
/** 太阳标记到地心的场景距离（地球半径 = 1）：取在星空壳 110~170 之外，避免与星点重叠 */
const SUN_MARKER_DIST = 200
const SUN_MARKER_R = 5
/** 月亮：真实地心距 384400 km / 6371 ≈ 60.3 场景单位；半径真实仅 0.27，放大 4 倍便于观察 */
const MOON_MARKER_DIST = 60.3
const MOON_MARKER_R = 1.1

/** 极光椭圆环：贴地半径取地球半径的 1.004 倍，避免与地表贴图 z-fighting */
const AURORA_R = EARTH_R * 1.004
/** 极光环环向分段（越大越圆；128 段在近距离观察也不见棱角） */
const AURORA_SEG = 128

/** 地磁偶极磁力线：L 壳（赤道穿越距离，单位地球半径）与经向条数。
 *  基准场线按 r = L·sin²θ 采样（纯偶极），再按太阳风做「日侧压缩 / 夜侧拖尾」变形（见 dipoleFieldLine）。 */
const DIPOLE_L_SHELLS = [1.4, 2.0, 3.0, 4.4, 6.2]
const DIPOLE_MERIDIANS = 12
/** 单条场线的采样段数（越大越平滑；64 段在 6.2 L 壳也足够顺滑） */
const DIPOLE_STEPS = 64
/** 场线基准色（平静态）：白色（按用户要求「线改回白色」）；磁暴时按 Kp 强度向后端 storm.color 过渡 */
const DIPOLE_BASE_COLOR = 0xffffff
/** 每次重建给单条场线布置的流动粒子数 */
const DIPOLE_PARTICLES_PER_LINE = 4
/** 粒子初始尺寸（场景单位，sizeAttenuation 下随距离缩放） */
const DIPOLE_PARTICLE_SIZE = 0.035
/** 白色主芯线像素线宽：WebGL 下 LineBasicMaterial.linewidth 恒为 1 无效，故场线改用 Line2 管线（真实像素宽，缩放不变形）。
 *  按用户口径「地磁线细一点」由 2.4 → 1.4（配合发光层收窄，整体更清瘦）。 */
const DIPOLE_LINE_WIDTH = 1.4
/** 彩虹发光壳带（Line2 顶点色：赤道红 → 中纬黄绿 → 两极蓝）的像素线宽，略比主芯线粗，叠加成柔和辉光（9 → 4.5 收窄） */
const DIPOLE_GLOW_WIDTH = 4.5
/** 赤道处色相（红） → 磁极点处色相（蓝）：沿场线按 |cosθ| 插值，复刻参考图的彩虹壳带 */
const DIPOLE_GLOW_HUE_EQUATOR = 0.0
const DIPOLE_GLOW_HUE_POLE = 0.66

/* ---- 太阳风对磁层的塑形（去理想化）----
 *  真实磁层不是对称偶极：太阳风动压把日侧磁力线压向地球、把夜侧吹成细长的磁尾。
 *  这里对「地表之外的径向余量 e = r − EARTH_R」做缩放来近似：日侧收（f<1）、夜侧伸（f>1），
 *  足点处 e=0 → 足点位置恒不变、也不会把场线压进地球；过渡用 smoothstep 平滑，避免折角。
 *  变形量 = 太阳风强度（见 dipoleSwStrength）× L 壳权重（外壳变形大）。 */
const DIPOLE_DAY_COMPRESS = 0.45
const DIPOLE_NIGHT_TAIL = 1.35
/** 日向（地固局部系）漂移超过该阈值才重建几何，避免每帧重传顶点缓冲（约 2°） */
const DIPOLE_SUNLOCAL_DRIFT_COS = Math.cos((2 * Math.PI) / 180)

/** 太阳风粒子流：流线条数 / 起始距离 / 终点距离 / 近端收拢半径 / 远端张开半径（场景单位） */
const SW_COUNT = 380
const SW_FAR = 150
const SW_NEAR = 1.6
const SW_SPREAD_NEAR = 1.2
const SW_SPREAD_FAR = 30
/** 流线基准长度（场景单位）与随速度的增量 */
const SW_STREAK_MIN = 1.6
const SW_STREAK_GAIN = 2.6
/** 太阳风速度映射到粒子推进速度（场景单位/秒）：300 km/s → 约 22，700 km/s → 约 62 */
const SW_SPEED_MIN_KMS = 250
const SW_SPEED_MAX_KMS = 900

/** 程序化生成径向渐变贴图（太阳光晕 / 月亮表面），避免引入额外图片资源 */
function radialSprite(inner: string, outer: string, size = 256): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  const gd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gd.addColorStop(0, inner)
  gd.addColorStop(0.35, outer)
  gd.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = gd
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 程序化月亮表面：中性灰底 + 确定性斑块（不用随机数，保证每次构建一致） */
function moonSurfaceTexture(size = 256): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#c9c9c9'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 220; i++) {
    // 确定性伪随机（黄金角分布），避免每次刷新斑点位置变化
    const u = (i * 0.6180339887) % 1
    const v = (i * 0.7548776662) % 1
    const r = 3 + ((i * 37) % 17)
    const dark = (i % 3 === 0)
    ctx.beginPath()
    ctx.arc(u * size, v * size, r, 0, Math.PI * 2)
    ctx.fillStyle = dark ? 'rgba(120,120,126,0.55)' : 'rgba(176,176,182,0.45)'
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function buildSky(scene: THREE.Scene) {
  // ---- 太阳：发光球 + 光晕（用 MeshBasicMaterial，不受光照影响，始终明亮）----
  const sunGroup = new THREE.Group()
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_MARKER_R * 0.45, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4 })
  )
  sunGroup.add(core)
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialSprite('rgba(255,246,214,1)', 'rgba(255,196,80,0.55)'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  }))
  glow.scale.setScalar(SUN_MARKER_R * 4.2)
  sunGroup.add(glow)
  scene.add(sunGroup)
  g.sunMarker = sunGroup

  // ---- 月亮：共用太阳平行光，明暗（月相）天然正确 ----
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_MARKER_R, 32, 32),
    new THREE.MeshPhongMaterial({ map: moonSurfaceTexture(), shininess: 2, specular: 0x111111 })
  )
  scene.add(moon)
  g.moonMesh = moon

  // ---- 地固系叠加层：极光椭圆环与星下点轨迹都挂这里（统一随地球自转，见 syncEarthSpin）----
  const earthFixed = new THREE.Group()
  scene.add(earthFixed)
  g.earthFixedGroup = earthFixed
  const aurora = new THREE.Group()
  earthFixed.add(aurora)
  g.auroraGroup = aurora
  rebuildAurora()
  // 地磁偶极磁力线：同样挂地固系（磁极钉在正确地理位置，随地球自转）
  const dipole = new THREE.Group()
  earthFixed.add(dipole)
  g.dipoleGroup = dipole
  rebuildDipole()

  // ---- 星下点轨迹：选中卫星的一整圈贴地轨迹（虚线）；未选中时不可见 ----
  const trackGeo = new THREE.BufferGeometry()
  trackGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((GROUND_TRACK_STEPS + 1) * 3), 3))
  const track = new THREE.Line(trackGeo, new THREE.LineDashedMaterial({
    color: 0xffe082, dashSize: 0.055, gapSize: 0.045, transparent: true, opacity: 0.8
  }))
  track.visible = false
  track.frustumCulled = false // 顶点每帧可能改写，避免自动包围球误剔除
  earthFixed.add(track)
  g.groundTrack = track

  // ---- 太阳风粒子流：粒子位置每帧沿日地连线推进（见 updateSolarWind）----
  initSolarWind(scene)

  // ---- 误差椭球组（惯性系，挂场景根；选中交会事件后重建，见 loadConjEllipsoids）----
  const cov = new THREE.Group()
  cov.visible = false
  scene.add(cov)
  g.covGroup = cov
}

/* ============================================================
 * 误差椭球（选中交会事件的两端）
 *
 * ⚠ 数据是「经验 σ」——由同一目标连续两条 TLE 的预报差按 区域×类型×dt 分桶统计，
 *   反映 TLE 自洽性，**不是定轨协方差**。故图例与详情面板都必须显著标注，禁止当真实协方差展示。
 * 椭球三轴 = RTN 基方向上的 (σr, σt, σn)。真实 σ 在 LEO 常见量级只有 10~100 km ≈ 0.002~0.016 场景单位，
 * 按实际比例画在默认机位下**完全看不见**，故统一放大到「最大轴 ≥ COV_MIN_AXIS_SCENE」再显示，
 * 倍数由 scene.ts 的 covDisplayScale 给出，并在右侧面板如实标注（数值口径两处共用同一函数）。
 * ============================================================ */
const COV_COLOR = 0xff9a5c

/**
 * 单个椭球：三个主轴平面上的椭圆环（而不是 wireframe 球）+ 中心点
 *
 * 为什么不用 wireframe 球：WebGL 里线宽恒为 1 像素，球面网格是一大堆 1px 线，在椭球很小时会糊成
 * 一团看不见的东西；三个主轴椭圆环（rt / rn / tn 三个平面）线条少、形状可读得多，也是协方差可视化的惯例。
 * 放大口径：真实 σ 太小（LEO 常见 10~100 km ≈ 0.002~0.016 场景单位），按实际比例画完全看不见，
 * 故统一放大到「最大轴 ≥ COV_MIN_AXIS_SCENE」，倍数由 scene.ts 的 covDisplayScale 给出，
 * 并在右侧面板如实标注放大倍数（数值口径两处共用同一个函数）。
 */
function buildEllipsoidMesh(side: ConjEllipsoidSide): THREE.Object3D | null {
  if (!side?.pos || !side.sigma) return null
  const group = new THREE.Group()
  // 三轴一律按真实比例取，**不能设「每轴下限」**：逐轴钳位会把小轴单独抬起来，椭球直接变成球
  //（真实 σ 的径向 / 法向往往只有沿迹的 1/3 甚至更小，如 LEO 载荷 0.022 / 0.070 / 0.046 km，
  // 若三轴都钳到 0.1 km，形状信息就全丢了 —— 这正是「交会热力 / 交会分析热力 椭球都是圆的」的原因）。
  // 可见性由 covDisplayScale 的「等比放大」（把最大轴抬到 COV_MIN_AXIS_SCENE）保证，三轴比例不变。
  const sr = Math.abs(Number(side.sigma.sr) || 0)
  const st = Math.abs(Number(side.sigma.st) || 0)
  const sn = Math.abs(Number(side.sigma.sn) || 0)
  const k = covDisplayScale([sr, st, sn])
  const a = (sr * k) * KM_TO_SCENE
  const b = (st * k) * KM_TO_SCENE
  const c = (sn * k) * KM_TO_SCENE
  const center = eciToScene(side.pos.x, side.pos.y, side.pos.z)
  // RTN 基：ECI 向量经同一映射进入场景系（映射是正交变换，右手性保持）
  const bx = eciToScene(side.r.x, side.r.y, side.r.z).normalize()
  const by = eciToScene(side.t.x, side.t.y, side.t.z).normalize()
  const bz = eciToScene(side.n.x, side.n.y, side.n.z).normalize()
  const basis = new THREE.Matrix4().makeBasis(bx, by, bz)
  const rot = new THREE.Quaternion().setFromRotationMatrix(basis)
  const SEG = 96
  /** 第 i 个主轴平面上的椭圆：u/v 为该平面的两个半轴 */
  const addEllipse = (u: number, v: number, ui: number, vi: number) => {
    const pts: number[] = []
    for (let i = 0; i <= SEG; i++) {
      const th = (i / SEG) * Math.PI * 2
      const p = new THREE.Vector3()
      p.setComponent(ui, Math.cos(th) * u)
      p.setComponent(vi, Math.sin(th) * v)
      pts.push(p.x, p.y, p.z)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: COV_COLOR, transparent: true, opacity: 0.95, depthWrite: false
    }))
    line.position.copy(center)
    line.quaternion.copy(rot)
    line.frustumCulled = false
    group.add(line)
  }
  addEllipse(a, b, 0, 1) // R-T 平面（沿迹误差主导的那个面）
  addEllipse(a, c, 0, 2) // R-N 平面
  addEllipse(b, c, 1, 2) // T-N 平面
  // 中心点：椭球被缩到很小时也能一眼找到位置
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.01, 10, 10),
    new THREE.MeshBasicMaterial({ color: COV_COLOR })
  )
  dot.position.copy(center)
  group.add(dot)
  return group
}

/** 清空椭球组（取消选中 / 切换事件时调用） */
function clearConjEllipsoids() {
  const grp = g.covGroup
  if (!grp) return
  const old = grp.children.slice()
  grp.clear()
  for (const c of old) disposeGroup(c as THREE.Object3D)
  grp.visible = false
}

/** 拉取并绘制某交会事件两端的误差椭球（经验 σ） */
async function loadConjEllipsoids(ev: CdmHeatEvent) {
  const tcaMs = parseEpoch(ev.tca)
  if (!Number.isFinite(tcaMs) || !ev.norad_a || !ev.norad_b) { clearConjEllipsoids(); return }
  conjEllipsoidLoading.value = true
  conjEllipsoidError.value = ''
  try {
    const r = await getConjEllipsoid({ norad_a: ev.norad_a, norad_b: ev.norad_b, tca: tcaMs })
    if (disposed) return
    conjEllipsoid.value = r
    clearConjEllipsoids()
    const grp = g.covGroup
    if (!grp) return
    for (const side of [r.a, r.b]) {
      const obj = side ? buildEllipsoidMesh(side) : null
      if (obj) grp.add(obj)
    }
  } catch (e: unknown) {
    if (!disposed) conjEllipsoidError.value = e instanceof Error ? e.message : '误差椭球数据获取失败'
  } finally {
    conjEllipsoidLoading.value = false
  }
}

/** 选中交会事件变化：拉取椭球；取消选中则清空 */
watch(heatSel, (ev) => {
  if (ev) void loadConjEllipsoids(ev)
  else { conjEllipsoid.value = null; clearConjEllipsoids() }
})

/* ============================================================
 * 星下点轨迹（选中卫星的一整圈贴地轨迹）
 *
 * 为什么按「当前模拟时刻」起算一个周期、而不是按 TLE 历元：
 *   地固系里下一圈的星下点曲线与当前几乎重合（这正是星下点轨迹可复用的原因），
 *   按现在起算才能保证轨迹与卫星当前位置对得上；只有交点进动会让曲线缓慢西移，
 *   故虚拟时间前进超过一定幅度后重采样一次即可（见 GROUND_TRACK_REFRESH_MS）。
 * 挂法：与极光环同属地固系（earthFixedGroup，rotation.y = GMST），否则轨迹会随地球漂移错位。
 * ============================================================ */
/** 轨迹采样点数（一整圈） */
const GROUND_TRACK_STEPS = 256
/** 虚拟时间前进超过该值才重采样（交点进动很慢，不必每帧重建） */
const GROUND_TRACK_REFRESH_MS = 30 * 60 * 1000
/** 上次采样所用的模拟时刻 */
let trackBaseMs = 0
/** 轨迹是否已有有效顶点 */
let trackHasData = false

/** 由 satrec 的平均运动推算轨道周期（分钟） */
function satPeriodMin(): number {
  const no = Number((g.satrec as unknown as { no?: number })?.no)
  return Number.isFinite(no) && no > 0 ? (2 * Math.PI) / no : 100
}

/** 重采样星下点轨迹（选中卫星变化或虚拟时间前进较多时调用） */
function updateGroundTrack() {
  const tr = g.groundTrack
  if (!tr || !g.satrec) { trackHasData = false; return }
  const periodMs = satPeriodMin() * 60000
  const attr = tr.geometry.getAttribute('position') as THREE.BufferAttribute
  const arr = attr.array as Float32Array
  const r = EARTH_R * 1.004
  const baseMs = g.simTimeMs
  let n = 0
  for (let i = 0; i <= GROUND_TRACK_STEPS; i++) {
    const ms = baseMs + (i / GROUND_TRACK_STEPS) * periodMs
    const pv = propagate(g.satrec, new Date(ms))
    if (!pv?.position) continue
    const gd = eciToGeodetic(pv.position, gstime(new Date(ms)))
    const lat = degreesLat(gd.latitude)
    const lon = degreesLong(gd.longitude)
    const p = lonLatToScene(lon, lat, r)
    arr[n * 3] = p.x
    arr[n * 3 + 1] = p.y
    arr[n * 3 + 2] = p.z
    n++
  }
  attr.needsUpdate = true
  // 顶点数不足（传播失败）时收缩有效范围：把剩余顶点收到最后一个有效点，避免拖一条假线到原点
  for (let i = n; i <= GROUND_TRACK_STEPS; i++) {
    const src = Math.max(0, n - 1)
    arr[i * 3] = arr[src * 3]
    arr[i * 3 + 1] = arr[src * 3 + 1]
    arr[i * 3 + 2] = arr[src * 3 + 2]
  }
  tr.geometry.setDrawRange(0, Math.max(2, n))
  tr.computeLineDistances()
  trackBaseMs = baseMs
  trackHasData = n > 1
}

/** 每帧检查：选中卫星后虚拟时间前进较多时重采样轨迹（很便宜，30 分钟才一次） */
function maybeRefreshGroundTrack() {
  if (!g.satrec || !trackHasData) return
  if (Math.abs(g.simTimeMs - trackBaseMs) > GROUND_TRACK_REFRESH_MS) updateGroundTrack()
}

/* ============================================================
 * 极光椭圆环（Kp 驱动）
 *
 * 圆心取「偶极磁极」（≈80.7°N / 72.7°W 及其对跖点），不是地理极；环下沿磁纬与宽度、
 * 颜色与亮度全部由后端 /cgi/space_weather 下发的 aurora 参数决定（口径只在后端一处，
 * 见 server/lib/spaceWeather.js 的 auroraOvalParams）。前端只负责把它画在球面上。
 *
 * 挂法：与「行政区域面 / 国界」同口径——几何按 ECEF 方向生成，放进 rotation.y = GMST 的组里
 * 随地球自转（见 syncEarthSpin），这样磁极才始终钉在正确的地理位置上。
 * ============================================================ */

/** 生成一条「以磁极为圆心、沿磁纬展开」的球面环带几何 */
function auroraRingGeometry(eqLatDeg: number, widthDeg: number, poleLon: number, poleLat: number): THREE.BufferGeometry {
  const pole = lonLatToScene(poleLon, poleLat, 1).normalize()
  // 与磁轴正交的一组基（参考向量不能与磁轴平行）
  const ref = Math.abs(pole.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const e1 = new THREE.Vector3().crossVectors(ref, pole).normalize()
  const e2 = new THREE.Vector3().crossVectors(pole, e1).normalize()
  // 余纬 = 90° − 磁纬：内沿靠极（纬度更高），外沿靠赤道
  const colatIn = ((90 - (eqLatDeg + widthDeg)) * Math.PI) / 180
  const colatOut = ((90 - eqLatDeg) * Math.PI) / 180
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= AURORA_SEG; i++) {
    const th = (i / AURORA_SEG) * Math.PI * 2
    for (const c of [colatIn, colatOut]) {
      const u = pole.clone().multiplyScalar(Math.cos(c))
        .addScaledVector(e1, Math.sin(c) * Math.cos(th))
        .addScaledVector(e2, Math.sin(c) * Math.sin(th))
      pos.push(u.x * AURORA_R, u.y * AURORA_R, u.z * AURORA_R)
    }
  }
  for (let i = 0; i < AURORA_SEG; i++) {
    const a = i * 2
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(idx)
  return geo
}

/** 按当前空间环境数据重建极光环（南北各一环）；无数据时清空几何，但保留组 */
function rebuildAurora() {
  const group = g.auroraGroup
  if (!group) return
  const old = group.children.slice()
  group.clear()
  for (const c of old) disposeGroup(c as THREE.Object3D)

  const sw = spaceWeather.value
  if (!sw?.aurora) return
  const { equatorwardLatDeg, widthDeg, intensity, color } = sw.aurora
  const pole = sw.geomagPole
  for (const p of [
    { lon: pole.northLon, lat: pole.northLat },
    { lon: pole.southLon, lat: pole.southLat }
  ]) {
    const mesh = new THREE.Mesh(
      auroraRingGeometry(equatorwardLatDeg, widthDeg, p.lon, p.lat),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        // 强度驱动亮度：平静时淡淡一圈，磁暴时明显发光
        opacity: 0.16 + 0.42 * Math.max(0, Math.min(1, intensity)),
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    )
    group.add(mesh)
  }
}

/* ============================================================
 * 地磁偶极磁力线（IGRF 偶极轴 + Kp / 太阳风驱动）
 *
 * 几何：以「偶极磁极」为极轴（与极光环同一个 sw.geomagPole，IGRF 偶极轴 ≈80.7°N/72.7°W，
 * 相对地理轴倾斜约 9.3°），按磁坐标 r = L·sin²θ 画一族嵌套场线：
 *   · θ = 磁余纬，L = 赤道穿越距离（单位地球半径，即 L 壳）；
 *   · 足点（贴地）落在 θ_min = asin(√(1/L))，赤道面外凸到 r = L —— 即「南北两极发散、
 *     赤道面外闭合」的经典偶极场线束（与 NASA 偶极场线示意图同形）。
 *   单条场线的具体形状不可实测（IGRF-13 / WMM2025 为国际权威模型），这里用模型口径、不编造数据。
 *
 * 动态（全部由后端已有的实时数据驱动，前端不新立物理口径）：
 *   · 呼吸脉冲发光 / 磁暴变色：强度取 sw.aurora.intensity（= Kp/9，后端算），颜色向 sw.storm.color 过渡；
 *   · 粒子沿场线流动：流速由 sw.solarWind.speed 映射（复用太阳风粒子的 250~900 km/s 口径）。
 *
 * 挂法：与极光环一致，挂在 earthFixedGroup（rotation.y = GMST）—— 磁极钉在正确地理位置，
 * 随地球自转（地磁偶极相对地球固定，这是物理正确的默认行为）。
 * 交互期 dtSec = 0（与「卫星静止、地球不转」同一口径，粒子一并冻结）。
 * ============================================================ */
/** 粒子贴图（径向渐变）：只在首次构建时生成一次并复用，避免每次重建泄漏显存 */
let dipoleParticleTex: THREE.Texture | null = null
function dipoleParticleTexture(): THREE.Texture {
  if (!dipoleParticleTex) dipoleParticleTex = radialSprite('rgba(255,255,255,1)', 'rgba(205,150,255,0.55)', 64)
  return dipoleParticleTex
}

/** 场线采样点（每条 L 壳×经向一条，扁平存 xyz），供粒子沿场线插值取位 */
let dipoleLinePts: Float32Array[] = []
/** 粒子 → 所属场线索引 / 沿场线的相位 [0,1) / 相位推进系数 */
let dipolePartLine = new Int32Array(0)
let dipolePartPhase = new Float32Array(0)
let dipolePartSpeed = new Float32Array(0)
/** 粒子几何 position 缓冲（与 dipolePartPhase 同长 ×3，直接作为 BufferAttribute 底层数组） */
let dipolePartPosArr: Float32Array | null = null
/** 场线合批与粒子对象（重建时替换，供每帧驱动）；场线是 Line2（继承 Mesh），按 Mesh 持有便于释放。
 *  场线分两层：dipoleGlow 为彩虹发光壳带（顶点色 · 加色混合），dipoleLines 为叠在其上的白色主芯线，二者共用同一几何。 */
let dipoleLines: THREE.Mesh | null = null
let dipoleGlow: THREE.Mesh | null = null
let dipoleParts: THREE.Points | null = null
/** 二十八宿四象连线的 Line2 材质（像素线宽依赖画布分辨率，resize 时同步 resolution，见 onResize） */
let mansionLineMat: LineMaterial | null = null
/** 西方 88 星座连线的 Line2 材质（同上，resize 时同步 resolution） */
let constellationLineMat: LineMaterial | null = null
/** 动画时钟（秒）：交互期不推进（与粒子冻结同口径） */
let dipoleClock = 0
/** 当前磁暴色（重建时从 sw.storm.color 解析一次，避免每帧解析字符串）+ 每帧变色用的复用色对象 */
const _dipoleStormColor = new THREE.Color(0xb06bff)
const _dipoleColor = new THREE.Color()

/** 太阳方向（单位向量）在「地固局部系」中的表示：
 *  地磁组挂在地固系（随地球自转），而磁层的日侧/夜侧是「日固系」概念 —— 必须把日向
 *  从世界系变换到地固局部系，才能与场线顶点在同一坐标系里比较。
 *  地球自转角 = gstime（earthFixedGroup.rotation.y = gst，与 homeDirection 同一约定 ⇒ local = R_y(−gst)·world）。 */
function dipoleSunLocal(): THREE.Vector3 {
  const t = new Date(g.simTimeMs)
  const s = sunDirection(t)
  return eciToScene(s.x, s.y, s.z).normalize().applyAxisAngle(WORLD_UP, -gstime(t))
}

/** 太阳风强度 [0,1]：动压（速度）× 磁场强度（Bt）× 南向 Bz（重联）加权；数据缺失取中等值 0.5。
 *  用于缩放日侧压缩 / 夜侧拖尾幅度（见 DIPOLE_DAY_COMPRESS / DIPOLE_NIGHT_TAIL）。 */
function dipoleSwStrength(): number {
  const w = spaceWeather.value?.solarWind
  if (!w) return 0.5
  const c01 = (x: number) => Math.max(0, Math.min(1, x))
  const speed = Number(w.speed)
  const bt = Number(w.bt)
  const bz = Number(w.bz)
  const vN = Number.isFinite(speed) ? c01((speed - 280) / 520) : 0.5
  const btN = Number.isFinite(bt) ? c01((bt - 2) / 18) : 0.5
  const bzN = Number.isFinite(bz) ? c01(-bz / 10) : 0.5
  // 底值 0.16：即便数据平静也保留一点非对称，避免退化成「纯偶极」的教科书图
  return c01(0.16 + 0.84 * (0.5 * vN + 0.3 * btN + 0.2 * bzN))
}

/** 上一轮构建时的日向（地固局部系）与太阳风强度快照：只有二者变化超阈值才重建几何（省每帧顶点上传） */
const _dipoleBuiltSun = new THREE.Vector3()
let _dipoleBuiltStrength = -1
let _dipoleHasBuilt = false

/** 单条偶极场线采样点（L 壳 + 磁经度 φ），极轴 = 偶极磁极方向。
 *  先按纯偶极 r = L·sin²θ 采样，再按太阳风做「日侧压缩 / 夜侧拖尾」变形：
 *  对「地表之外的径向余量 e = r − EARTH_R」乘以 f（日侧 f<1、夜侧 f>1），足点 e=0 恒不动、不穿地。 */
function dipoleFieldLine(
  L: number, phi: number, axis: THREE.Vector3, e1: THREE.Vector3, e2: THREE.Vector3,
  sunLocal: THREE.Vector3, dayComp: number, nightTail: number
): Float32Array {
  const thMin = Math.asin(Math.min(1, 1 / Math.sqrt(L)))
  const cosP = Math.cos(phi)
  const sinP = Math.sin(phi)
  const out = new Float32Array((DIPOLE_STEPS + 1) * 3)
  for (let k = 0; k <= DIPOLE_STEPS; k++) {
    // θ 从「北足点余纬」扫到「南足点余纬」：θ_min → π−θ_min（北足→赤道外凸→南足）
    const theta = thMin + (k / DIPOLE_STEPS) * (Math.PI - 2 * thMin)
    const sinT = Math.sin(theta)
    const cosT = Math.cos(theta)
    const r = L * sinT * sinT * EARTH_R
    const hx = cosP * e1.x + sinP * e2.x
    const hy = cosP * e1.y + sinP * e2.y
    const hz = cosP * e1.z + sinP * e2.z
    // 单位方向 u = cosθ·axis + sinθ·h（|u|=1）：用它投影日向得到所处分区
    const ux = cosT * axis.x + sinT * hx
    const uy = cosT * axis.y + sinT * hy
    const uz = cosT * axis.z + sinT * hz
    // c = u·日向：+1 正日侧 / −1 正夜侧；smoothstep 让过渡平滑、无折角（日/夜各只在自身半区生效）
    const c = ux * sunLocal.x + uy * sunLocal.y + uz * sunLocal.z
    let sp = 0
    let sn = 0
    if (c > 0) sp = c * c * (3 - 2 * c)
    else if (c < 0) { const nc = -c; sn = nc * nc * (3 - 2 * nc) }
    const f = 1 - dayComp * sp + nightTail * sn
    const r2 = EARTH_R + (r - EARTH_R) * f
    const o = k * 3
    out[o] = r2 * ux
    out[o + 1] = r2 * uy
    out[o + 2] = r2 * uz
  }
  return out
}

/** 按各粒子当前相位，在所属场线上线性插值取位（写回粒子几何 position 缓冲） */
function sampleDipoleParticles() {
  const arr = dipolePartPosArr
  if (!arr) return
  for (let i = 0; i < dipolePartPhase.length; i++) {
    const pts = dipoleLinePts[dipolePartLine[i]]
    if (!pts) continue
    const t = dipolePartPhase[i] * DIPOLE_STEPS
    const k0 = Math.floor(t)
    const k1 = Math.min(DIPOLE_STEPS, k0 + 1)
    const f = t - k0
    const a = k0 * 3
    const b = k1 * 3
    const o = i * 3
    arr[o] = pts[a] + (pts[b] - pts[a]) * f
    arr[o + 1] = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f
    arr[o + 2] = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f
  }
}

/** 按当前空间环境重建偶极场线（L 壳 × 经向）+ 流动粒子；无偶极轴数据时清空几何但保留组 */
function rebuildDipole() {
  const group = g.dipoleGroup
  if (!group) return
  const old = group.children.slice()
  group.clear()
  for (const c of old) disposeGroup(c as THREE.Object3D)
  dipoleLines = null
  dipoleGlow = null
  dipoleParts = null
  dipoleLinePts = []
  dipolePartLine = new Int32Array(0)
  dipolePartPhase = new Float32Array(0)
  dipolePartSpeed = new Float32Array(0)
  dipolePartPosArr = null

  const sw = spaceWeather.value
  const pole = sw?.geomagPole
  if (!pole) return
  _dipoleStormColor.set(sw?.storm?.color || DIPOLE_BASE_COLOR)

  // 极轴 + 与其正交的一组基（参考向量不能与磁轴平行；与 auroraRingGeometry 同一套构造）
  const axis = lonLatToScene(pole.northLon, pole.northLat, 1).normalize()
  const ref = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const e1 = new THREE.Vector3().crossVectors(ref, axis).normalize()
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize()

  // ---- 场线：所有线共用一份几何，分「彩虹发光壳带 + 白色主芯线」两层 Line2 叠加 ----
  // 顶点色按图片复刻：赤道（|cosθ|→0）红，磁极点（|cosθ|→1）蓝，中间经黄绿过渡；
  // 由于点沿极轴的投影 / 到原点距离 恰等于 cosθ（轴为单位向量、环向分量与轴垂直），可直接由几何反推，无需重算 θ。
  const segPos: number[] = []
  const segCol: number[] = []
  const _glowCol = new THREE.Color()
  const hueSpan = DIPOLE_GLOW_HUE_POLE - DIPOLE_GLOW_HUE_EQUATOR
  const pushGlowColor = (x: number, y: number, z: number) => {
    const r = Math.hypot(x, y, z) || 1
    const f = Math.abs((x * axis.x + y * axis.y + z * axis.z) / r) // |cosθ| ∈ [0,1]
    _glowCol.setHSL(DIPOLE_GLOW_HUE_EQUATOR + hueSpan * f, 1, 0.5)
    segCol.push(_glowCol.r, _glowCol.g, _glowCol.b)
  }
  // 太阳风塑形参数：日向（地固局部系）+ 强度 → 日侧压缩 / 夜侧拖尾（外壳变形大、内壳几乎不变）
  const sunLocal = dipoleSunLocal()
  const strength = dipoleSwStrength()
  const lShellMax = DIPOLE_L_SHELLS[DIPOLE_L_SHELLS.length - 1]
  for (const L of DIPOLE_L_SHELLS) {
    const lw = Math.max(0, Math.min(1, (L - 1) / (lShellMax - 1)))
    const dayComp = strength * lw * DIPOLE_DAY_COMPRESS
    const nightTail = strength * lw * DIPOLE_NIGHT_TAIL
    for (let m = 0; m < DIPOLE_MERIDIANS; m++) {
      const pts = dipoleFieldLine(L, (m / DIPOLE_MERIDIANS) * Math.PI * 2, axis, e1, e2, sunLocal, dayComp, nightTail)
      dipoleLinePts.push(pts)
      for (let k = 0; k < DIPOLE_STEPS; k++) {
        const a = k * 3
        const b = (k + 1) * 3
        segPos.push(pts[a], pts[a + 1], pts[a + 2], pts[b], pts[b + 1], pts[b + 2])
        pushGlowColor(pts[a], pts[a + 1], pts[a + 2])
        pushGlowColor(pts[b], pts[b + 1], pts[b + 2])
      }
    }
  }
  const lineGeo = new LineSegmentsGeometry()
  lineGeo.setPositions(segPos)
  // 顶点色仅供彩虹发光层读取；白色主芯线不声明 vertexColors，同一几何可安全共用（dispose 幂等）
  lineGeo.setColors(segCol)
  // 场线用 Line2 管线：linewidth 为真实像素宽（LineBasicMaterial.linewidth 在 WebGL 上恒为 1，
  // 无法加粗），并需把画布分辨率写入 material.resolution（resize 时同步，见 onResize）
  const canvasSize = g.renderer ? g.renderer.getSize(new THREE.Vector2()) : null
  const resX = Math.max(1, canvasSize?.x || 1)
  const resY = Math.max(1, canvasSize?.y || 1)

  // ① 彩虹发光壳带：明显更粗 + 顶点色 + 加色混合，叠成范艾伦带式的霓虹辉光
  const glowMat = new LineMaterial({
    linewidth: DIPOLE_GLOW_WIDTH,
    vertexColors: true,
    transparent: true,
    opacity: 0.30,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  glowMat.resolution.set(resX, resY)
  dipoleGlow = new LineSegments2(lineGeo, glowMat)
  dipoleGlow.frustumCulled = false
  dipoleGlow.renderOrder = 1
  group.add(dipoleGlow)

  // ② 白色主芯线：叠在发光壳带之上，以精细白线勾勒场线本体（颜色/透明度每帧统一改）
  const coreMat = new LineMaterial({
    color: new THREE.Color(DIPOLE_BASE_COLOR),
    linewidth: DIPOLE_LINE_WIDTH,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  coreMat.resolution.set(resX, resY)
  dipoleLines = new LineSegments2(lineGeo, coreMat)
  dipoleLines.frustumCulled = false
  dipoleLines.renderOrder = 2
  group.add(dipoleLines)

  // ---- 流动粒子：每条场线均匀布置若干个，沿场线参数相位推进 ----
  const lineCount = dipoleLinePts.length
  const perLine = DIPOLE_PARTICLES_PER_LINE
  const total = lineCount * perLine
  dipolePartLine = new Int32Array(total)
  dipolePartPhase = new Float32Array(total)
  dipolePartSpeed = new Float32Array(total)
  const posArr = new Float32Array(total * 3)
  let pi = 0
  for (let li = 0; li < lineCount; li++) {
    for (let j = 0; j < perLine; j++) {
      dipolePartLine[pi] = li
      // 确定性相位（黄金角错开，不用随机数，保证每次构建一致）：均分 + 按线索引错开，避免成串
      dipolePartPhase[pi] = (j / perLine + ((li * 0.6180339887) % 1)) % 1
      dipolePartSpeed[pi] = 0.8 + 0.4 * (((li * 7 + j * 13) % 11) / 10)
      pi++
    }
  }
  dipolePartPosArr = posArr
  sampleDipoleParticles()
  const pGeo = new THREE.BufferGeometry()
  pGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3))
  dipoleParts = new THREE.Points(pGeo, new THREE.PointsMaterial({
    map: dipoleParticleTexture(),
    color: new THREE.Color(DIPOLE_BASE_COLOR),
    size: DIPOLE_PARTICLE_SIZE,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.9
  }))
  dipoleParts.frustumCulled = false
  group.add(dipoleParts)

  // 记录本轮构建所用的日向 / 强度，供 maybeRebuildDipoleShape 判断是否需要重算
  _dipoleBuiltSun.copy(sunLocal)
  _dipoleBuiltStrength = strength
  _dipoleHasBuilt = true
}

/** 磁层形态不是静态的：地球自转（日向在地固系中转动）或太阳风强度变化超阈值时重算场线几何。
 *  阈值触发以省去每帧重传顶点缓冲（一次重建约 5×12×64 段），代价是形态更新有轻微滞后。 */
function maybeRebuildDipoleShape() {
  if (!g.dipoleGroup) return
  const sunLocal = dipoleSunLocal()
  const strength = dipoleSwStrength()
  if (
    _dipoleHasBuilt &&
    sunLocal.dot(_dipoleBuiltSun) > DIPOLE_SUNLOCAL_DRIFT_COS &&
    Math.abs(strength - _dipoleBuiltStrength) <= 0.06
  ) return
  rebuildDipole()
}

/** 每帧驱动偶极图层：呼吸脉冲发光 + 磁暴变色 + 粒子沿场线流动（dtSec=0 → 粒子冻结） */
function updateDipole(dtSec: number) {
  if (!dipoleLines && !dipoleGlow && !dipoleParts) return
  const sw = spaceWeather.value
  const intensity = Math.max(0, Math.min(1, Number(sw?.aurora?.intensity) || 0))

  // 呼吸脉冲：平静时几乎不闪，磁暴时幅度/频率都提高
  dipoleClock += dtSec
  const pulse = 0.5 + 0.5 * Math.sin(dipoleClock * (0.9 + 1.6 * intensity))
  const pulseAmp = 0.10 + 0.30 * intensity

  // 磁暴变色：基准色 → 后端 storm.color（口径只在后端，前端只做视觉过渡）
  _dipoleColor.set(DIPOLE_BASE_COLOR).lerp(_dipoleStormColor, intensity)

  // 彩虹发光壳带：颜色由顶点色固定（赤道红→两极蓝），此处只做强度/呼吸的透明度驱动，磁暴时整体更亮
  if (dipoleGlow) {
    const mat = dipoleGlow.material as unknown as { opacity: number }
    mat.opacity = (0.20 + 0.34 * intensity) * (1 - pulseAmp * 0.5 + pulseAmp * pulse)
  }
  if (dipoleLines) {
    // LineMaterial 的 addons 子路径在 TS 侧无类型（env.d.ts 已放开为 any），这里按结构取用
    const mat = dipoleLines.material as unknown as { color: THREE.Color; opacity: number }
    mat.color.copy(_dipoleColor)
    mat.opacity = (0.18 + 0.38 * intensity) * (1 - pulseAmp + pulseAmp * 2 * pulse)
  }
  if (dipoleParts) {
    const mat = dipoleParts.material as THREE.PointsMaterial
    mat.color.copy(_dipoleColor)
    mat.opacity = 0.55 + 0.45 * pulse
    // 流速由太阳风速度映射（复用 SW_SPEED_MIN/MAX 口径；无数据取中值）
    const speed = Number(sw?.solarWind?.speed)
    const k = Number.isFinite(speed)
      ? Math.max(0, Math.min(1, (speed - SW_SPEED_MIN_KMS) / (SW_SPEED_MAX_KMS - SW_SPEED_MIN_KMS)))
      : 0.5
    const flow = 0.05 + 0.14 * (0.4 + 0.6 * k) // 每秒走过的场线比例
    if (dtSec > 0) {
      for (let i = 0; i < dipolePartPhase.length; i++) {
        let p = dipolePartPhase[i] + dtSec * flow * dipolePartSpeed[i]
        if (p >= 1) p -= Math.floor(p)
        dipolePartPhase[i] = p
      }
    }
    sampleDipoleParticles()
    const attr = dipoleParts.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.needsUpdate = true
  }
}

/* ============================================================
 * 太阳风粒子流（流线样式）
 *
 * 沿「日地连线」从太阳侧流向地球：每条流线是一小段短线（头在近地侧、尾在远日侧），
 * 距离 d 随速度推进、到地球附近回卷；横向散布随距离张开（远端宽、近端收拢成束），
 * 顶点色由头到尾渐暗 —— 叠加混合下暗即透明，于是头亮尾淡，读起来才像「流」而不是「一盘散沙」。
 * 速度/磁场来自 /cgi/space_weather 的 solarWind（NOAA）；无数据时不绘制。**默认关闭**（图例可开）。
 * ── 与磁层的耦合（绕流）──────────────────────────────────────
 * 流线不得穿入磁层：把磁层近似为半径 a 的球（a 由太阳风强度驱动，见 magnetopauseRadius），
 * 逐流线点做横向偏移钳制（d² + off² ≥ (a+留白)²），使流线贴着磁层顶被偏转、绕流而过 ——
 * 于是打开本图层能直观看到「太阳风被地磁挡开」的相互作用，且风越强磁层顶压得越近、绕流圈越紧。
 * 说明：这是示意而不是流体解算——方向与节奏由真实数据驱动，位置不代表真实等离子体轨迹。
 * ============================================================ */
/** 每条流线的日向距离与其「单位横向偏移」（|u| ≤ 1，实际偏移按距离张开） */
let swDist = new Float32Array(0)
let swUx = new Float32Array(0)
let swUy = new Float32Array(0)
let swPhase = new Float32Array(0)
/** 流线的日向推进速度（场景单位/秒），由太阳风速度换算 */
let swAdvance = 30
/** 流线长度（场景单位）：由太阳风速度决定，速度越快流线越长 */
let swStreakLen = 2.4
/** 磁层近似球半径（场景单位，EARTH_R=1）用于流线绕流：日侧磁层顶 = BASE − SWING × 太阳风强度。
 *  与地磁偶极的「日侧压缩 / 夜侧拖尾」同源（都取 dipoleSwStrength）：风越强 → 磁层顶越靠地 → 绕流圈越小。 */
const MAGNETOPAUSE_BASE = 7.2
const MAGNETOPAUSE_SWING = 2.2
/** 绕流留白：流线保持在磁层表面之外，避免与场线穿插 */
const MAGNETOPAUSE_MARGIN = 0.35

/** 当前日侧磁层顶半径（场景单位）：驱动太阳风流线绕流包络，体现「太阳风 ↔ 磁层」耦合 */
function magnetopauseRadius(): number {
  return MAGNETOPAUSE_BASE - MAGNETOPAUSE_SWING * dipoleSwStrength()
}

function initSolarWind(scene: THREE.Scene) {
  swDist = new Float32Array(SW_COUNT)
  swUx = new Float32Array(SW_COUNT)
  swUy = new Float32Array(SW_COUNT)
  swPhase = new Float32Array(SW_COUNT)
  const pos = new Float32Array(SW_COUNT * 2 * 3)
  const col = new Float32Array(SW_COUNT * 2 * 3)
  const head = new THREE.Color(0xdff2ff)
  const tail = new THREE.Color(0x14314a)
  for (let i = 0; i < SW_COUNT; i++) {
    swDist[i] = SW_NEAR + Math.random() * (SW_FAR - SW_NEAR)
    // 单位圆盘内均匀分布（sqrt 保证外圈不过密）
    const r = Math.sqrt(Math.random())
    const a = Math.random() * Math.PI * 2
    swUx[i] = r * Math.cos(a)
    swUy[i] = r * Math.sin(a)
    swPhase[i] = 0.8 + Math.random() * 0.4
    const o = i * 6
    col[o] = head.r; col[o + 1] = head.g; col[o + 2] = head.b
    col[o + 3] = tail.r; col[o + 4] = tail.g; col[o + 5] = tail.b
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false // 位置每帧全量改写，交给 three 自动包围球会误剔除
  scene.add(lines)
  g.solarWind = lines
  applySolarWindStyle()
}

/** 按当前太阳风数据调整推进速度与流线亮度（数据到达或刷新时调用）
 *  速度 → 推进快慢与流线长度；南向 Bz → 与磁层耦合更强（Bz 越负越亮），物理上是磁暴的关键因子。 */
function applySolarWindStyle() {
  const lines = g.solarWind
  if (!lines) return
  const wind = spaceWeather.value?.solarWind
  const speed = wind?.speed
  const bz = wind?.bz
  if (!Number.isFinite(speed as number)) return
  const k = Math.max(0, Math.min(1, ((speed as number) - SW_SPEED_MIN_KMS) / (SW_SPEED_MAX_KMS - SW_SPEED_MIN_KMS)))
  swAdvance = 22 + 40 * k
  const coupling = Number.isFinite(bz as number) ? Math.max(0, Math.min(1, -(bz as number) / 10)) : 0
  const mat = lines.material as THREE.LineBasicMaterial
  mat.opacity = 0.3 + 0.45 * (0.4 * k + 0.6 * coupling)
  swStreakLen = SW_STREAK_MIN + SW_STREAK_GAIN * k
}

/** 是否有可用的太阳风数据（无数据时该图层不绘制，开关保持用户的选择） */
function hasSolarWindData() {
  return Number.isFinite(spaceWeather.value?.solarWind?.speed as number)
}

const _swE1 = new THREE.Vector3()
const _swE2 = new THREE.Vector3()
const _swRef = new THREE.Vector3()
/** 每帧推进太阳风流线：头点 = 日向距离 × 太阳方向 + 按距离张开的横向偏移；尾点 = 头点沿 +日向退一段 */
function updateSolarWind(sunUnit: THREE.Vector3, dtSec: number) {
  const lines = g.solarWind
  if (!lines || !lines.visible) return
  // 与太阳方向正交的一组基（太阳方向每日才转 1°，每帧重算的开销可忽略）
  _swRef.set(0, 1, 0)
  if (Math.abs(sunUnit.y) > 0.95) _swRef.set(1, 0, 0)
  _swE1.crossVectors(_swRef, sunUnit).normalize()
  _swE2.crossVectors(sunUnit, _swE1).normalize()
  const attr = lines.geometry.getAttribute('position') as THREE.BufferAttribute
  const arr = attr.array as Float32Array
  const span = SW_FAR - SW_NEAR
  const step = swAdvance * dtSec
  // 磁层绕流包络：流线点与地心 3D 距离不得小于 aMargin，a 由太阳风强度驱动（见 magnetopauseRadius）
  const aMargin = magnetopauseRadius() + MAGNETOPAUSE_MARGIN
  const aMargin2 = aMargin * aMargin
  for (let i = 0; i < SW_COUNT; i++) {
    let d = swDist[i] - step
    while (d < SW_NEAR) d += span
    swDist[i] = d
    // 横向偏移随距离张开：远端宽、近端收拢 —— 这是「束状」观感的来源
    const t = (d - SW_NEAR) / span
    const spread = SW_SPREAD_NEAR + (SW_SPREAD_FAR - SW_SPREAD_NEAR) * t
    // 盘内单位方向（退化为轴心时给固定方向兜底，避免除零）
    const uMag = Math.hypot(swUx[i], swUy[i])
    const ux = uMag > 1e-4 ? swUx[i] / uMag : 1
    const uy = uMag > 1e-4 ? swUy[i] / uMag : 0
    let off = uMag * spread
    // 绕流：轴距 d 处，圆柱半径 off 需满足 d² + off² ≥ aMargin²（贴在磁层球面之外）——
    // 流线越靠近地球（d 越小）被撑开的偏移越大，表现为「太阳风被磁层顶偏转、绕流而过」
    if (d < aMargin) {
      const need = Math.sqrt(Math.max(0, aMargin2 - d * d))
      if (off < need) off = need
    }
    const ox = ux * off
    const oy = uy * off
    const o = i * 6
    // 头点
    arr[o] = sunUnit.x * d + _swE1.x * ox + _swE2.x * oy
    arr[o + 1] = sunUnit.y * d + _swE1.y * ox + _swE2.y * oy
    arr[o + 2] = sunUnit.z * d + _swE1.z * ox + _swE2.z * oy
    // 尾点（沿 +日向退一段：粒子朝地球飞，拖尾留在身后）；尾点 d 更大、离地更远，沿用同一偏移必在球外
    const dt2 = d + swStreakLen * swPhase[i]
    arr[o + 3] = sunUnit.x * dt2 + _swE1.x * ox + _swE2.x * oy
    arr[o + 4] = sunUnit.y * dt2 + _swE1.y * ox + _swE2.y * oy
    arr[o + 5] = sunUnit.z * dt2 + _swE1.z * ox + _swE2.z * oy
  }
  attr.needsUpdate = true
}

/** 每帧更新：太阳光方向 / 太阳标记 / 月亮 / 极光环定向 / 太阳风粒子，并统一应用图层显隐
 *  @param {number} dtSec 真实帧间隔（秒）；交互期与虚拟时间一并冻结，粒子不动 */
function updateSky(dtSec: number) {
  const d = new Date(g.simTimeMs)
  const s = sunDirection(d)
  // eciToScene 内含 km→场景单位换算，这里要的是单位方向，故归一化后只取它的轴映射（映射仍单一出处）
  const sunUnit = eciToScene(s.x, s.y, s.z).normalize()

  if (g.sunLight && g.scene) {
    g.sunLight.position.copy(sunUnit).multiplyScalar(10)
    g.sunLight.target.position.set(0, 0, 0)
    g.sunLight.target.updateMatrixWorld()
    if (g.sunLight.target.parent !== g.scene) g.scene.add(g.sunLight.target)
  }
  if (g.sunMarker) g.sunMarker.position.copy(sunUnit).multiplyScalar(SUN_MARKER_DIST)
  if (g.moonMesh) {
    const m = moonDirection(d)
    g.moonMesh.position.copy(eciToScene(m.dir.x, m.dir.y, m.dir.z).normalize()).multiplyScalar(MOON_MARKER_DIST)
  }

  // 图层显隐：开关状态每帧读一次（赋值开销可忽略，省掉一套 watch 同步）
  if (g.sunMarker) g.sunMarker.visible = skyLayers.sun
  if (g.moonMesh) g.moonMesh.visible = skyLayers.moon
  // 二十八星宿：无画质档约束（仅 28 点 + 少量线段，开销可忽略）
  if (g.mansionGroup) g.mansionGroup.visible = skyLayers.mansion
  // 西方 88 星座：同为星空连线层，无画质档约束
  if (g.constellationGroup) g.constellationGroup.visible = skyLayers.constellation
  // 背景星空：装饰层，无画质档约束（约 2500 个点，开销可忽略）
  if (g.starfieldGroup) g.starfieldGroup.visible = skyLayers.stars
  if (g.auroraGroup) g.auroraGroup.visible = skyLayers.aurora && g.auroraGroup.children.length > 0
  if (g.dipoleGroup) g.dipoleGroup.visible = skyLayers.dipole && g.dipoleGroup.children.length > 0
  if (g.solarWind) g.solarWind.visible = skyLayers.solarWind && hasSolarWindData()
  if (g.groundTrack) g.groundTrack.visible = skyLayers.groundTrack && trackHasData
  // 误差椭球：只在选中交会事件且拿到数据时有内容（开关默认开启不影响观感）
  if (g.covGroup) g.covGroup.visible = skyLayers.ellipsoid && g.covGroup.children.length > 0
  // 星下点轨迹随虚拟时间缓慢漂移，隔一段时间重采样一次（很便宜）
  maybeRefreshGroundTrack()

  // 交互期冻结虚拟时间 → 粒子一并停住（与「卫星静止、地球不转」同一口径）
  updateSolarWind(sunUnit, g.userInteracting ? 0 : dtSec)
  // 地磁偶极磁力线：显隐已在上方统一应用；可见时先按太阳风/自转判断是否需要重算形态，再驱动动效（交互期冻结）
  if (g.dipoleGroup?.visible) {
    maybeRebuildDipoleShape()
    updateDipole(g.userInteracting ? 0 : dtSec)
  }
}

/** 地球夜晚灯光贴图（emissiveMap）引用：过境视图要把它撤下来，退出时再挂回，故留存引用 */
let earthNightTex: THREE.Texture | null = null

/** 地球贴图加载：优先 COS、失败回退本地。
 *  返回占位 Texture（与 TextureLoader.load 一致：先返回、后异步填充），保持 buildEarth 同步签名。 */
function loadEarthTexture(localUrl: string): THREE.Texture {
  const tex = new THREE.Texture()
  const loader = new THREE.TextureLoader()
  const fill = async () => {
    await ensureAssetBase() // COS 未启用/不可达时返回 ''，cdnUrl 即本地地址
    const cos = cdnUrl(localUrl)
    const tryLoad = (url: string, allowFallback: boolean): Promise<THREE.Texture> =>
      loader.loadAsync(url).catch((e) => {
        if (allowFallback) return tryLoad(localUrl, false)
        throw e
      })
    try {
      const t = await tryLoad(cos, cos !== localUrl)
      tex.image = t.image
      tex.colorSpace = t.colorSpace
      tex.needsUpdate = true
    } catch (e) {
      console.error('地球贴图加载失败', localUrl, e)
    }
  }
  void fill()
  return tex
}

function buildEarth(scene: THREE.Scene, earthSeg: number, atmoSeg: number) {
  // 白天贴图（地表细节）作为基础 map（走 public/map，与 COS key 口径一致）
  const tex = loadEarthTexture(`${BASE}map/mercator-tex.jpg`)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  // 夜晚贴图作为 emissiveMap：暗面城市灯光自发光，与白天图共同"贴"出真实地球
  const nightTex = loadEarthTexture(`${BASE}map/nightearth-4096.png`)
  earthNightTex = nightTex
  nightTex.wrapS = THREE.RepeatWrapping
  nightTex.wrapT = THREE.ClampToEdgeWrapping
  const mat = new THREE.MeshPhongMaterial({
    map: tex,
    emissive: 0xffffff,
    emissiveMap: nightTex,
    emissiveIntensity: 0.75,
    specular: 0x222222,
    shininess: 10
  })
  g.earthMat = mat
  const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, earthSeg, earthSeg), mat)
  g.earthMesh = earth
  scene.add(earth)
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 1.012, atmoSeg, atmoSeg),
    new THREE.MeshBasicMaterial({ color: 0x2a6bd8, transparent: true, opacity: 0.06, side: THREE.BackSide })
  )
  g.atmo = atmo
  earth.add(atmo)
}

/* ============================================================
 * 加载进度（假进度推进）
 * ============================================================ */
function startFakeProgress() {
  stopFakeProgress()
  fakeTimer = window.setInterval(() => {
    const cur = loadProgress.value
    if (cur >= 100) { stopFakeProgress(); return }
    const cap = 92
    if (cur < cap) {
      const step = Math.max(0.2, (cap - cur) / 16 + Math.random() * 1.4)
      loadProgress.value = Math.round(Math.min(cap, cur + step))
    }
  }, 240)
}
function stopFakeProgress() {
  if (fakeTimer !== null) { clearInterval(fakeTimer); fakeTimer = null }
}

/* ============================================================
 * 星座数据加载 / 实例化模型
 * ============================================================ */
/** satrec 是否已就绪（TLE 已拉取并解析完成） */
let satrecsReady = false
/** TLE 拉取中的共享 Promise：并发调用只发一次请求 */
let satrecsPromise: Promise<void> | null = null
/** satrec 代次：applyCloud 重建点云时自增。分块解析期间若数据源被切换（g.cloudList 已换），
 *  旧批次必须按代次作废，否则会把上一份点云的 satrec 写回新点云（错配）。 */
let satrecsGen = 0

/** 懒加载全部在轨物体的 satrec。
 *  首屏点云接口不下发 TLE（3.5 万条会撑爆响应体），而「画轨道线 / hover 预览 / 过境标记 / 逐帧精确校准」
 *  都必须用 satrec，故这些路径统一先 await 这里：首次调用拉一次 /cgi/sat_{源}/tle_lines 并缓存，
 *  之后直接命中缓存。切换数据源会重建 g.cloudList 并复位缓存标记（见 loadConstellation），
 *  故缓存始终与当前点云同源。失败时清空 Promise 以便下次交互重试（错误提示由 request 拦截器统一弹出）。 */
function ensureSatrecs(): Promise<void> {
  if (satrecsReady || !g.cloudList.length) return Promise.resolve()
  if (satrecsPromise) return satrecsPromise
  const gen = satrecsGen
  const task = (async () => {
    const res = await listTleLinesPublic(dataSource.value)
    if (gen !== satrecsGen) return
    const map = new Map<number, [string, string]>()
    for (const [norad, l1, l2] of res?.list || []) map.set(norad, [l1, l2])
    const list = g.cloudList
    const recs: (ReturnType<typeof twoline2satrec> | null)[] = new Array(list.length).fill(null)
    // 分块解析：全量 3.5 万条 twoline2satrec 一口气跑完是秒级主线程长任务，会把首屏交互
    // （含 hover 拾取）整段冻住，表现为「刚进页面卡一阵才能拾取」。每块让出一个宏任务，
    // 动画与输入不被阻塞；总时长基本不变（略加让出开销）。
    const CHUNK = 2000
    for (let start = 0; start < list.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, list.length)
      for (let i = start; i < end; i++) {
        const tle = map.get(list[i].norad_id)
        if (!tle) continue
        try { recs[i] = twoline2satrec(tle[0], tle[1]) } catch { /* 单条解析失败留 null */ }
      }
      if (end < list.length) await new Promise((r) => setTimeout(r, 0))
      if (gen !== satrecsGen) return
    }
    g.satrecs = recs
    satrecsReady = true
    // 就绪自愈：初次进入时若鼠标已停在某颗卫星上，但那时 satrec 尚未到位导致预览线没画出来，
    // 而鼠标此后不再移动（不会再有 pointermove），此处解析完成后立即补画一次。
    if (hoverGi != null && !g.previewOrbitLine) void buildPreviewOrbit(hoverGi)
  })().catch(() => {})
  let wrapped: Promise<void>
  wrapped = task.finally(() => {
    // 本轮若被代次守卫作废（解析期间点云被重建）或中途失败，且期间没有新的加载接手，
    // 必须把 promise 归零 —— 否则后续 ensureSatrecs 会拿到这个「已完成的旧 promise」立即返回，
    // 永远等不到 satrec 就绪（表现为「首次点目标算不出轨道线、要再点一次才对」，见 buildPassCityOrbits）。
    if (satrecsPromise === wrapped && !satrecsReady) satrecsPromise = null
  })
  satrecsPromise = wrapped
  return wrapped
}

/** 等 satrec 就绪（带「解析期间点云被重建」的抗性）。TLE 首次解析是「秒级网络 + 3.5 万分块解析」，
 *  这期间若点云被重建（applyCloud 重置 satrecsGen、清空 g.satrecs），本轮 await 会「正常结束但没算出任何 satrec」，
 *  调用方拿到的 g.satrecs 全是 null —— 表现为「第一次点目标不画轨道线 / 只选中不出轨迹，再点一次才画」。
 *  代次变了就再等一轮：此时 ensureSatrecs 会接着等「重建后新发起的那次加载」，等到的才是可用的 satrec。
 *  只在代次变化时重试（真失败 / TLE 拉取异常不重试，避免网络异常时空转）。 */
async function awaitSatrecs() {
  for (let i = 0; i < 3 && !satrecsReady; i++) {
    const gen = satrecsGen
    await ensureSatrecs()
    if (satrecsGen === gen) break
  }
}

/** 点云本地缓存键（按数据源区分）；键里带版本号，编码口径变化时递增即可让旧缓存自然失效。
 *  v2：点云行 12 元 → 16 元（新增 ownerIdx / perigee / period / incl），旧的 12 元缓存必须弃用。 */
const cloudCacheKey = (src: SatSource) => `cloud:${src}:v2`
/** 星座主表（喂过滤器下拉）持久缓存键 */
const CONS_CACHE_KEY = 'cons:all:v1'
/** 热力持久缓存键（按来源 / 窗口 / 批次区分，与内存缓存 heatCache 同口径） */
const heatPersistKey = (src: string, days: number, runId: number | null) => `heat:${src}:${days}:${runId ?? 'latest'}:v1`
/** 热力批次列表持久缓存键（按来源区分） */
const heatBatchesKey = (src: string) => `heatbatches:${src}:v1`
/** 过境静态底图（行政区划面 + 国界 + 城市标注）持久缓存键；底图与批次无关，故不分批次 */
const PASS_GEO_CACHE_KEY = 'pass:geo:v1'
/** 过境批次列表 / 当前批次城市 id 集合持久缓存键 */
const PASS_BATCHES_CACHE_KEY = 'pass:batches:v1'
const PASS_CITY_IDS_CACHE_KEY = (runId: number | null) => `pass:cityids:${runId ?? 'latest'}:v1`
/** 单目标过境明细持久缓存键（目标 + 批次确定一份明细） */
const PASS_CITY_DETAIL_CACHE_KEY = (targetId: number, runId: number | null) => `pass:citydetail:${targetId}:${runId ?? 'latest'}:v1`

/** 把一份点云快照应用到场景（decode → 建索引 → 建低档模型实例）。
 *  网络首装与本地缓存直出共用同一条路径，保证两种来源的画面与状态完全一致。 */
async function applyCloud(res: ConstellationSnapshot) {
  // 后端下发的是紧凑数组（无 TLE），先还原成对象数组供后续统一消费
  g.cloudList = decodeConstellation(res)
  if (res.t) g.simTimeMs = res.t
  // 整份重建：行序/数量都可能变，之前排队的时间追赶用的快照已对不上号，直接作废
  warpRes = null
  orbitTotal.value = res.total || g.cloudList.length
  orbitSkipped.value = res.skipped || 0
  loadStage.value = '正在解析轨道数据…'
  // satrec 不随首屏加载：点云只靠后端下发的 x/y/z + vx/vy/vz 即可渲染与运动，
  // 需要 satrec 的轨道功能走 ensureSatrecs() 懒加载（首屏渲染完成后在后台静默预取）
  g.satrecs = new Array(g.cloudList.length).fill(null)
  satrecsReady = false
  satrecsPromise = null
  // 代次自增：让上一份点云仍在分块解析中的 satrec 批次作废（见 ensureSatrecs / satrecsGen）
  satrecsGen++
  buildPerInstance()
  loadProgress.value = 46
  loadStage.value = '正在构建星座模型…'
  // 先粗后精：首屏统一用 low 档（三角形最少、加载最快）先把全部卫星画出来，
  // 之后由动画循环里的 maybeSwitchModelLod 按「相机距地距离 + 可见卫星数 + 画质档位」逐级升到 med / high
  await buildModelInstances('low')
  // 初始化过滤可见掩码（默认全可见），并统计数量
  g.filterMask = new Uint8Array(g.cloudList.length).fill(1)
  visibleCount.value = g.cloudList.length
  // 点云重建后重放当前过滤条件：首次进入（点云还在网络/缓存加载）时用户可能已经点了星座或输了检索词，
  // 那一刻 watch 里的 refreshFilter 因 cloudList 为空被直接跳过，此后没人再补 —— 表现为「第一次点星座
  // 既不画轨道线、点云也没被过滤，再点一次才生效」。这里统一补一次，覆盖所有「过滤条件先于点云就绪」的场景。
  if (filterActive.value) refreshFilter()
  // 点云一就位即开拉 TLE（fire-and-forget，不阻塞首屏渲染）：绘制轨道线 / 过境标记 / 逐帧精确校准都要 satrec。
  // 提前发起只为尽早进入精确路径：首屏 hover 预览线已由点云瞬时位置/速度的「二体过渡线」兜底（见 buildInstantOrbit，
  // 零等待），不再依赖 satrec 就绪；解析本身已分块（见 ensureSatrecs），不会形成首屏长任务。
  if (!disposed) void ensureSatrecs()
}

/** 新快照与当前点云是否「逐条同序」（后端查询无 ORDER BY，行序可能变化；同序才可原地打补丁） */
function sameCloudOrder(res: ConstellationSnapshot): boolean {
  const list = g.cloudList
  if (!list.length || list.length !== res.list.length) return false
  for (let i = 0; i < list.length; i++) if (list[i].norad_id !== res.list[i][0]) return false
  return true
}

/** 把快照的坐标 / 速度 / 高度 / 星座标签 + 着色分类字段原地写进当前点云（仅在「与快照逐条同序」时可用）。
 *  smooth=true：坐标走待补位移平滑（用于时间追赶落位后的残差），本帧不整批重写矩阵（交给 decayPositionOffsets）；
 *  smooth=false：直接对齐并整批重写矩阵（时刻差过大时的一次性对齐）。
 *  分类字段（编目国 / 近地点 / 周期 / 倾角）与坐标同源，必须一并补写，否则后台静默刷新后
 *  非「目标类型」的着色维度仍拿旧值 / 空值（图例占比全落兜底档）→ 末尾按当前维度重涂一次。 */
function applyCloudCoords(res: ConstellationSnapshot, smooth: boolean) {
  const list = g.cloudList
  const countries = res.countryIndex || []
  for (let i = 0; i < list.length; i++) {
    const r = res.list[i]
    const p = list[i]
    p.x = r[4]; p.y = r[5]; p.z = r[6]
    p.vx = r[7]; p.vy = r[8]; p.vz = r[9]
    p.alt = r[10]
    p.cons = r[11] || []
    p.owner_code = countries[r[12]] || '--'
    p.perigee = r[13] ?? null
    p.period = r[14] ?? null
    p.incl = r[15] ?? null
    const sp = eciToScene(p.x, p.y, p.z)
    if (smooth) applySmoothPos(i, sp.x, sp.y, sp.z)
    else {
      posOff[i]?.set(0, 0, 0)
      g.scenePos[i] = sp
    }
    g.sceneVel[i] = eciToScene(p.vx ?? 0, p.vy ?? 0, p.vz ?? 0)
  }
  if (res.t) g.simTimeMs = res.t
  if (!smooth) rewriteInstanceMatrices((gi) => g.filterMask[gi] === 1)
  // 分类字段刚被刷新：按当前着色维度重涂并更新图例占比（「目标类型」维度不受这些字段影响，跳过省算）
  if (colorMode.value !== 'type') applyPointColors()
}

/** 同序快照替换：时刻差不大时先做「时间追赶」（见 warpRes 说明）再落位，避免整片目标瞬移闪位 */
function patchCloudCoords(res: ConstellationSnapshot) {
  const gapMs = (res.t || Date.now()) - g.simTimeMs
  // 时刻差过大（本地缓存放了很久）：不做追赶动画，直接对齐 —— 几百毫秒里掠过小半条轨道会穿过地球
  if (!Number.isFinite(gapMs) || gapMs <= CLOUD_WARP_MIN_MS || gapMs > CLOUD_WARP_MAX_MS) {
    if (gapMs > CLOUD_WARP_MIN_MS) applyCloudCoords(res, false)
    else applyCloudCoords(res, true)
    return
  }
  warpRes = res
  warpToMs = res.t || Date.now()
  warpEndWall = performance.now() + CLOUD_WARP_MS
}

/** 后台静默刷新点云：不写任何 loading 状态、失败静默（本地缓存画面仍可看）。
 *  同序 → 原地打补丁（无闪烁）；行序或数量有变 → 整体重建（此时画面已出，不会白屏）。
 *  并把最新快照回写本地缓存，供下次冷启动直出。 */
async function refreshCloudInBackground(src: SatSource) {
  try {
    const res = await listConstellationPublic(undefined, src)
    if (disposed || src !== dataSource.value || !res?.list?.length) return
    void cacheSet(cloudCacheKey(src), res)
    if (sameCloudOrder(res)) {
      patchCloudCoords(res)
      return
    }
    await applyCloud(res)
    rebuildSatIndex()
    // 过滤 / 轨道线的重放已收敛到 applyCloud 内统一执行（点云重建后按当前过滤条件补一次），
    // 这里不再重复调用 refreshFilter，避免同一次重建触发两轮过滤轨道线（前一轮必被 gen 守卫作废、留下待删组）
  } catch { /* 静默：本地缓存画面仍可用 */ }
}

async function loadConstellation() {
  const src = dataSource.value
  // ① 本地缓存直出：毫秒级出画面（首次安装 / 缓存被清时无缓存，自动落到下面的网络路径）
  const cached = await cacheGet<ConstellationSnapshot>(cloudCacheKey(src))
  if (cached?.list?.length) {
    loadStage.value = '正在载入本地缓存…'
    loadProgress.value = 30
    await applyCloud(cached)
    loadStage.value = '正在渲染场景…'
    loadProgress.value = 100
    stopFakeProgress()
    // 后台静默拉最新快照替换（不阻塞首帧，也不影响可交互性）
    void refreshCloudInBackground(src)
    return
  }
  // ② 无缓存：正常网络加载（仅在首次进入或缓存不可用时发生）
  loadStage.value = '正在加载卫星数据…'
  loadProgress.value = 8
  startFakeProgress()
  // 按当前数据源取点云：国际库（默认）/ 太空地图 AOE 库，两库响应结构一致
  const res = await listConstellationPublic(undefined, src)
  loadProgress.value = 30
  if (!res?.list?.length) {
    throw new Error(src === 'aoe' ? '暂无 AOE 在轨数据，请先同步 AOE 轨道数据' : '暂无在轨数据，请先同步 TLE')
  }
  await applyCloud(res)
  // 回写本地缓存：下次冷启动即毫秒级直出
  void cacheSet(cloudCacheKey(src), res)
  loadStage.value = '正在渲染场景…'
  loadProgress.value = 100
  stopFakeProgress()
}

/** 切换三维视图数据源（国际库 / AOE 库）：按新数据源重拉点云并重建实例，其余场景元素（地球 / 星空 /
 *  热力 / 过境图层）保持不变。切换即清掉当前选中与上一套目录的过滤索引，避免把旧索引带到新数据上；
 *  新数据源为空（该库尚未同步）时保留原画面，仅提示错误，不会把场景清空。 */
async function switchDataSource(src: SatSource) {
  if (src === dataSource.value) return
  dataSource.value = src
  clearSelected()
  error.value = ''
  loading.value = true
  try {
    await loadConstellation()
    if (disposed) return
    rebuildSatIndex()
  } catch (e: unknown) {
    if (disposed) return
    error.value = e instanceof Error ? e.message : '数据源切换失败'
  } finally {
    stopFakeProgress()
    loading.value = false
  }
}

/** 加载星座主表（去除无关联卫星的星座），供前端「按星座过滤」下拉使用。
 *  先出本地持久缓存（下拉立即可用），随后静默拉最新替换并回写缓存。 */
async function loadFilterConstellations() {
  await cacheFirst<Awaited<ReturnType<typeof listAllConstellationsPublic>>>(
    CONS_CACHE_KEY,
    listAllConstellationsPublic,
    (all) => { constellations.value = (all || []).filter((c) => (c.satellite_count || 0) > 0) },
    () => constellations.value.length > 0
  ).catch(() => { /* 拦截器已提示 */ })
}

/* 姿态基向量 / 矩阵临时对象（逐星计算复用，避免每颗卫星都新建 Vector/Matrix） */
const _poseUp = new THREE.Vector3()
const _poseFwd = new THREE.Vector3()
const _poseRight = new THREE.Vector3()
const _poseM = new THREE.Matrix4()
/** 零速度占位（速度缺失时交给 orbitBasis 自行兜参考轴，机头仍垂直地表） */
const _zeroVel = new THREE.Vector3()
/** 选中目标本帧场景坐标（准星跟随用） */
const _selNext = new THREE.Vector3()

/** 计算卫星 / 箭体基准姿态正交基（结果写入 _poseRight / _poseFwd / _poseUp，即模型本地 X / Y / Z 轴在场景中的方向）：
 *  本地 +Z（机身长轴）对齐地心→目标径向（天顶，即垂直于地球），本地 +Y 对齐飞行方向。
 *  取正交基 Z=径向、Y=速度，X=Y×Z（右手系），再把 Y 正交化为 Z×X，消除速度与径向不严格垂直的误差。
 *  速度缺失或与径向近似共线时改用参考轴定向；径向始终作为第一轴，故任何情况下机身都垂直于地球。
 *  位置每帧都在变（高倍速下变化极快），故基准姿态必须逐帧重算：若沿用某一时刻的定值，
 *  卫星沿轨道走出一段后机身长轴就会偏离天顶，看起来像「自己转向」，倍速越高越明显。 */
function orbitBasis(posScene: THREE.Vector3, velScene: THREE.Vector3) {
  _poseUp.copy(posScene).normalize()
  // 位置退化在轨目标不会出现，兜一个参考轴保证后续叉乘有效
  if (_poseUp.lengthSq() === 0) _poseUp.set(0, 1, 0)
  _poseFwd.copy(velScene).normalize()
  _poseRight.crossVectors(_poseFwd, _poseUp)
  if (_poseRight.lengthSq() < 1e-12) {
    // 速度缺失或与径向近似共线：改用参考轴与径向叉乘定向
    _poseFwd.set(0, 1, 0)
    if (Math.abs(_poseUp.y) > 0.9) _poseFwd.set(1, 0, 0)
    _poseRight.crossVectors(_poseFwd, _poseUp)
  }
  _poseRight.normalize()
  _poseFwd.crossVectors(_poseUp, _poseRight)
}

/** 基准姿态四元数：正交基 → 四元数。碎片 / 箭体的翻滚在此基础上叠加（见 writeInstance）。 */
function orbitAttitude(posScene: THREE.Vector3, velScene: THREE.Vector3, out: THREE.Quaternion) {
  orbitBasis(posScene, velScene)
  _poseM.makeBasis(_poseRight, _poseFwd, _poseUp)
  return out.setFromRotationMatrix(_poseM)
}

/* ============================================================
 * 碎片 / 箭体 360° 翻滚
 *  在轨碎片与末级箭体早已失去姿态控制，会绕自身轴持续翻滚；载荷卫星与未知物体保持三轴稳定，不加翻滚。
 *  翻滚不随相机远近变化：不论远景还是贴近地球，始终按各自角速度做三轴全方位翻滚 ——
 *  翻滚量在本地坐标叠加（基准朝向 × 本地翻滚），机身长轴不再保持天顶方向。
 * ============================================================ */
/** 三轴翻滚角速度区间（rad/s）：每轴、每实例取值不同，避免整片碎片同步翻滚而显得僵硬 */
const TUMBLE_RATE_MIN = 0.25
const TUMBLE_RATE_MAX = 0.85
/** 翻滚相位（秒）：按真实帧间隔累积、交互期冻结（与世界冻结口径一致）。
 *  只决定姿态相位、不参与位置外推，故与播放倍速无关 —— 快进时碎片不会转成一片模糊。 */
let tumbleClock = 0
const _tumbleEuler = new THREE.Euler()
const _tumbleQ = new THREE.Quaternion()

/** 确定性伪随机 [0,1)：翻滚参数由实例下标派生（不用 Math.random，保证每帧/每次进入页面姿态一致） */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** 生成某型号实例的翻滚参数：每实例 6 个值（三轴角速度 + 三轴初相），按 local 下标存放 */
function makeTumble(idxs: number[]): Float32Array {
  const out = new Float32Array(idxs.length * 6)
  for (let i = 0; i < idxs.length; i++) {
    const seed = idxs[i]
    for (let a = 0; a < 3; a++) {
      out[i * 6 + a] = TUMBLE_RATE_MIN + (TUMBLE_RATE_MAX - TUMBLE_RATE_MIN) * hash01(seed + a * 13)
      out[i * 6 + 3 + a] = hash01(seed + 71 + a * 29) * Math.PI * 2
    }
  }
  return out
}

/** 写一个实例的完整矩阵：位置 + 基准姿态（按当前位置 / 速度重算）；碎片 / 箭体在本地坐标叠加三轴 360° 翻滚。
 *  其余型号（载荷 / 未知）只用到基准姿态，与免四元数的快路径 writeInstanceUpright 结果一致。 */
function writeInstance(imesh: THREE.InstancedMesh, local: number, gi: number) {
  const spin = imesh.userData.spin as Float32Array | null
  _pos.copy(g.scenePos[gi])
  orbitAttitude(g.scenePos[gi], g.sceneVel[gi], _quat)
  if (spin) {
    const o = local * 6
    _tumbleEuler.set(
      tumbleClock * spin[o] + spin[o + 3],
      tumbleClock * spin[o + 1] + spin[o + 4],
      tumbleClock * spin[o + 2] + spin[o + 5]
    )
    _quat.multiply(_tumbleQ.setFromEuler(_tumbleEuler))
  }
  _scale.set(1, 1, 1)
  _m.compose(_pos, _quat, _scale)
  imesh.setMatrixAt(local, _m)
}

/** 逐帧快路径：把位置 + 基准姿态（不含翻滚）直接写进实例矩阵。
 *  与 writeInstance 同一口径（姿态同样按当前位置 / 速度重算，机身长轴恒垂直地球），
 *  只是跳过「正交基→四元数→compose」的中转 —— 可见实例每帧都要重写姿态，上万颗时这一步开销差一个量级。
 *  模型几何已按 MODEL_MAX_DIM 归一化（缩放恒为 1），故矩阵前三列直接就是本地 X / Y / Z 轴（列主序）。 */
function writeInstanceUpright(imesh: THREE.InstancedMesh, local: number, gi: number) {
  const p = g.scenePos[gi]
  orbitBasis(p, g.sceneVel[gi])
  const o = local * 16
  const arr = imesh.instanceMatrix.array as Float32Array
  arr[o] = _poseRight.x; arr[o + 1] = _poseRight.y; arr[o + 2] = _poseRight.z; arr[o + 3] = 0
  arr[o + 4] = _poseFwd.x; arr[o + 5] = _poseFwd.y; arr[o + 6] = _poseFwd.z; arr[o + 7] = 0
  arr[o + 8] = _poseUp.x; arr[o + 9] = _poseUp.y; arr[o + 10] = _poseUp.z; arr[o + 11] = 0
  arr[o + 12] = p.x; arr[o + 13] = p.y; arr[o + 14] = p.z; arr[o + 15] = 1
}

/** 初始化每颗卫星的场景位置 + 场景速度 + 朝向 + 归属型号 / 粗类型。
 *  位置与 ECI 速度均取后端 /cgi/sat_tle/constellation 快照（后端已按同一 snap 时刻传播并同时下发 x/y/z + vx/vy/vz），
 *  前端不再解析 TLE 重跑 SGP4；速度走同一 ECI→场景线性变换，供每帧轻量外推使用。
 *  型号键（星链 / OneWeb / Iridium 一/二代 / …，见 resolveModelKey）决定用哪套 gltf 模型；
 *  粗类型（载荷/碎片/箭体/未知）保留给图例显隐、轨道线配色、卫星列表筛选使用。 */
function buildPerInstance() {
  const list = g.cloudList
  const n = list.length
  g.scenePos = new Array<THREE.Vector3>(n)
  g.sceneVel = new Array<THREE.Vector3>(n)
  posOff = new Array<THREE.Vector3>(n)
  g.instOf = new Array<InstInfo>(n)
  g.localOf = new Int32Array(n)
  g.modelIndices = {}
  g.modelMeshes = {}
  for (let i = 0; i < n; i++) {
    const p = list[i]
    const vx = p.vx ?? 0, vy = p.vy ?? 0, vz = p.vz ?? 0
    g.scenePos[i] = eciToScene(p.x, p.y, p.z)
    posOff[i] = new THREE.Vector3()
    // 速度也走同一线性变换（ECI→场景），单位 = 场景单位/模拟秒，供每帧轻量外推使用
    g.sceneVel[i] = eciToScene(vx, vy, vz)
    // 朝向不在此固化：基准姿态逐帧按当前位置 + 速度重算（见 orbitBasis），高倍速下机身长轴才不会偏离天顶
    const model = resolveModelKey(p)
    const idxs = (g.modelIndices[model] ||= [])
    idxs.push(i)
    g.localOf[i] = idxs.length - 1
    g.instOf[i] = { model, coarse: MODEL_COARSE[model] || 'UNKNOWN' }
  }
}

/** 当前点云涉及的全部型号键（含模型加载失败的型号：位置外推仍需覆盖这些卫星） */
function modelKeys(): string[] {
  return Object.keys(g.modelIndices)
}

/** 模型几何缓存：URL -> 已归一化的 geometry + 材质。
 *  同一次进入页面内，切换 LOD 档位 / 反复重建实例 / 热力目标模型都复用同一份几何，省掉重复下载与解析。 */
const geomCache = new Map<string, { geom: THREE.BufferGeometry; mat: THREE.Material } | null>()

/** 取模型（带缓存）。url 决定几何，coarse 只决定配色与碎片/箭体的额外缩小系数，model 决定是否需头尾翻转。 */
function loadGeom(url: string, coarse: string, model: string) {
  const hit = geomCache.get(url)
  if (hit !== undefined) return Promise.resolve(hit)
  return loadModelGeom(url, coarse, model).then((gm) => { geomCache.set(url, gm); return gm })
}

/** 释放模型几何缓存（组件卸载时调用；场景内 InstancedMesh 的几何 / 材质由 disposeScene 统一回收） */
function disposeGeomCache() {
  for (const gm of geomCache.values()) {
    if (!gm) continue
    gm.geom.dispose()
    gm.mat.dispose()
  }
  geomCache.clear()
}

/** 前台全站模型的统一尺寸口径（唯一出处）：每个模型按其最大边（通常是太阳翼展）归一化到这个场景单位长度。
 *  点云、交会目标、过境卫星三处共用同一份归一化几何（见 loadGeom 的缓存），故改这一个值即全站生效；
 *  交会 / 过境模型另有相对倍数 HEAT_TARGET_MODEL_SCALE，随之等比缩放。
 *  2026-09：按需求把整体尺寸缩到原来的一半（原值 0.022）。 */
const MODEL_MAX_DIM = 0.011

/** 加载指定 URL 的模型并归一化（最大边统一缩放到 MODEL_MAX_DIM，居中），返回 geometry/material。
 *  coarse 只用于取配色（TYPE_COLOR）与碎片 / 箭体的额外缩小系数，模型文件本身由 url 决定。
 *  model 决定是否做头尾翻转（见 MODEL_NO_FLIP_Y）：卫星素材的机头朝向与姿态约定相反。 */
async function loadModelGeom(url: string, coarse: string, model: string): Promise<{ geom: THREE.BufferGeometry; mat: THREE.Material } | null> {
  try {
    // 静态资源优先 COS、失败回退本地：模型与 draco 解码器必须同源，故先等基址就绪
    await ensureAssetBase()
    const draco = new DRACOLoader()
    draco.setDecoderPath(cdnUrl(`${BASE}draco/`))
    const loader = new GLTFLoader()
    loader.setDRACOLoader(draco)
    const localUrl = url || TYPE_MODEL.UNKNOWN
    const cosUrl = cdnUrl(localUrl)
    let gltf: { scene: THREE.Object3D }
    if (cosUrl !== localUrl) {
      try {
        gltf = (await loader.loadAsync(cosUrl)) as { scene: THREE.Object3D }
      } catch {
        // COS 不可达：模型与解码器一并回退本地
        draco.setDecoderPath(`${BASE}draco/`)
        gltf = (await loader.loadAsync(localUrl)) as { scene: THREE.Object3D }
      }
    } else {
      gltf = (await loader.loadAsync(localUrl)) as { scene: THREE.Object3D }
    }
    const scene: THREE.Object3D = gltf.scene
    const geoms: THREE.BufferGeometry[] = []
    scene.updateWorldMatrix(true, true)
    scene.traverse((o: any) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      geoms.push(m.geometry.clone().applyMatrix4(m.matrixWorld))
    })
    if (!geoms.length) return null
    if (geoms.length > 1) {
      let common = Object.keys(geoms[0].attributes)
      for (const g of geoms) common = common.filter((k) => g.attributes && k in g.attributes)
      for (const g of geoms) {
        for (const k of Object.keys(g.attributes)) {
          if (!common.includes(k)) g.deleteAttribute(k)
        }
      }
    }
    let geom: THREE.BufferGeometry | null = null
    try { geom = mergeGeometries(geoms, false) } catch { geom = null }
    if (!geom) geom = geoms[0]
    // 逐实例着色：丢弃模型自带的顶点色，统一补一份白色 color 属性 —— 与材质的 vertexColors + instanceColor
    // 相乘后，每颗卫星的最终颜色完全由 setColorAt 决定（见 applyPointColors），几何顶点色只作中性占位。
    if (geom.attributes.color) geom.deleteAttribute('color')
    {
      const vcount = geom.attributes.position ? geom.attributes.position.count : 0
      if (vcount) geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vcount * 3).fill(1), 3))
    }
    if (!geom.attributes.normal) geom.computeVertexNormals()
    // 头尾对调：卫星素材的机头朝本地 -Z（与约定相反），统一绕本地 Y 轴翻转 180°（+Z 长轴反向）；
    // 碎片 / 箭体 / 未知物体无固定机头且自带翻滚，保持原朝向（见 MODEL_NO_FLIP_Y）。
    // 绕 Y 轴不改变本地 +Y 与飞行方向的对应关系，故飞行方向、拾取、LOD 口径均不变。
    if (!MODEL_NO_FLIP_Y.has(model)) geom.rotateY(Math.PI)
    geom.computeBoundingBox()
    const box = geom.boundingBox!
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    let s = maxDim > 0 ? MODEL_MAX_DIM / maxDim : 1
    if (coarse === 'DEBRIS' || coarse === 'ROCKET BODY') s *= 1 / 3
    geom.scale(s, s, s)
    geom.computeBoundingBox()
    const center = geom.boundingBox!.getCenter(new THREE.Vector3())
    geom.translate(-center.x, -center.y, -center.z)
    const mat = new THREE.MeshStandardMaterial({
      // 逐实例着色：基色 / 自发光统一置白，真实颜色由 InstancedMesh.instanceColor 逐实例提供
      // （几何补了白色 color 属性，保证 vColor 在顶点 / 片元阶段都可用）。
      color: 0xffffff,
      vertexColors: true,
      metalness: 0.45,
      roughness: 0.32,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      transparent: false,
      opacity: 1,
      depthWrite: true
    })
    // 自发光按实例着色：three 默认只把 instanceColor 乘进漫反射，自发光是常量；这里补一步乘 vColor，
    // 否则切换着色维度后「发光色」恒为白、画面被冲淡（口径 = emissive * instanceColor，等价原先按类型发光）。
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'vec3 totalEmissiveRadiance = emissive * vColor.rgb;'
      )
    }
    return { geom, mat }
  } catch (e) {
    console.error('加载模型失败', url, e)
    return null
  }
}

/** 按可见性谓词重写全部型号的实例矩阵（不可见的卫星写零矩阵 → 该实例渲染为退化三角形即隐藏）。
 *  过滤（检索/星座/高度）与「三维还原」共用，避免两处各写一遍。 */
function rewriteInstanceMatrices(show: (gi: number) => boolean) {
  for (const model of modelKeys()) {
    const imesh = g.modelMeshes[model]
    const globalIdxs = g.modelIndices[model]
    if (!imesh || !globalIdxs || !globalIdxs.length) continue
    for (let local = 0; local < globalIdxs.length; local++) {
      const gi = globalIdxs[local]
      if (show(gi)) {
        writeInstance(imesh, local, gi)
      } else {
        imesh.setMatrixAt(local, ZERO_M)
      }
    }
    imesh.instanceMatrix.needsUpdate = true
  }
  // 整批矩阵刚按当前时刻写过，外推的「待落矩阵位移」随之清零（见 updateExtrapolate）
  matrixDrift = 0
}

/* ---------- 焦点卫星光点上色：选中卫星 / 星座点名成员在点云里的光点替换为亮青 ---------- */
/** 当前需要在点云里以亮青显示的焦点卫星（全局索引集合）：选中单星（hasSel + sel.id）与星座点名成员
 *  （consHighlightNorad）都算，同一颗星只算一次（Set 去重）。 */
function focusPointGis(): Set<number> {
  const want = new Set<number>()
  const add = (norad: number) => {
    if (!(norad > 0)) return
    const gi = g.cloudList.findIndex((p) => p.norad_id === norad)
    if (gi >= 0) want.add(gi)
  }
  if (hasSel.value) add(sel.id)
  add(consHighlightNorad.value)
  return want
}

/** 上色复用色对象（避免每次新建 Color） */
const _pointPaintColor = new THREE.Color()

/** 把全局索引 gi 的卫星在点云里的光点颜色改成 hex（null = 还原为当前着色维度的分档色）。
 *  与逐实例着色（applyPointColors）写的是同一份 instanceColor，故两者互不冲突、可叠加。
 *  返回是否命中（未命中 = 点云未建好 / 该星不在当前数据源，此时待 applyPointColors 时按 paintedPointGis 重涂）。 */
function paintSatPoint(gi: number, hex: number | null): boolean {
  const info = g.instOf[gi]
  const p = g.cloudList[gi]
  if (!info || !p) return false
  const imesh = g.modelMeshes[info.model]
  if (!imesh) return false
  const local = g.localOf[gi]
  if (local < 0) return false
  _pointPaintColor.setHex(hex == null ? bucketColorHexOf(colorMode.value, p) : hex)
  imesh.setColorAt(local, _pointPaintColor)
  if (imesh.instanceColor) imesh.instanceColor.needsUpdate = true
  return true
}

/** 已按亮青上色过的焦点光点（全局索引）：焦点变化时据此精确还原旧焦点、只增量上色新焦点 */
let paintedPointGis = new Set<number>()

/** 焦点变化（选中 / 取消选中 / 星座点名 / 取消点名）后同步点云光点颜色：旧焦点还原分档色，新焦点上亮青。 */
function syncFocusPointPaint() {
  const want = focusPointGis()
  for (const gi of paintedPointGis) {
    if (!want.has(gi)) paintSatPoint(gi, null)
  }
  for (const gi of want) {
    if (!paintedPointGis.has(gi)) paintSatPoint(gi, CONS_HIGHLIGHT_COLOR)
  }
  paintedPointGis = want
}

/** 逐实例着色：按当前着色维度（colorMode）给每颗卫星算色，写进各型号 InstancedMesh 的 instanceColor，
 *  并同步统计各分档命中数 → colorLegend（右下角图例由 index.vue 渲染，分档口径见 scene.ts 的 bucketKeyOf）。
 *  几何 / 矩阵都不动：只在「建批之后」与「切换着色维度时」各跑一次（全量约 3.5 万，毫秒级）。
 *  隐藏的卫星照样上色 —— 显隐由矩阵归零控制，与颜色无关（见 rewriteInstanceMatrices）。 */
function applyPointColors() {
  const mode = colorMode.value
  const counts = new Map<string, number>()
  let total = 0
  const tmp = new THREE.Color()
  for (const model of modelKeys()) {
    const imesh = g.modelMeshes[model]
    const globalIdxs = g.modelIndices[model]
    if (!imesh || !globalIdxs || !globalIdxs.length) continue
    for (let local = 0; local < globalIdxs.length; local++) {
      const p = g.cloudList[globalIdxs[local]]
      if (!p) continue
      const key = bucketKeyOf(mode, p)
      counts.set(key, (counts.get(key) || 0) + 1)
      total++
      tmp.setHex(bucketColorHexOf(mode, p))
      imesh.setColorAt(local, tmp)
    }
    if (imesh.instanceColor) imesh.instanceColor.needsUpdate = true
  }
  // 图例分档行：只列当前维度的分档（顺序即声明顺序），计数 / 占比按当前点云统计
  const rows = colorBucketDefs(mode).map((d) => {
    const c = counts.get(d.key) || 0
    return { key: d.key, label: d.label, color: d.color, count: c, pct: total ? Math.round((c / total) * 10000) / 100 : 0 }
  })
  // 多星座对比：只列「有命中的对比星座」，不列兜底档 —— 否则会显示全库其余卫星的总数（对比视图下的干扰项）
  colorLegend.value = mode === 'compare' ? rows.filter((r) => r.key !== NA_BUCKET_KEY && r.count > 0) : rows
  // 逐实例着色已把全部实例刷成分档色，焦点光点（选中 / 星座点名）的亮青被一并覆盖：
  // 清空上色记录后按当前焦点重涂，保证换档 / 切维度 / 重建点云后焦点光点仍是亮青
  paintedPointGis.clear()
  syncFocusPointPaint()
}

/** 首页「无目标」门控：进入页面缺省隐藏全部卫星/碎片/箭体/未知物体点云（数据仍后台加载）。
 *  例外 = NORAD 集合展示态（satSetActive）：它是显式 URL 深链的分析叠加层，直接显示。 */
function cloudGate() {
  return cloudRevealed.value || satSetActive.value
}

/** 星座卡片通道的载荷 Mesh 例外：主开关关但有点亮卡片（consShowMap 非空）或绑定了卡片轨道
 *  （filterConst）时，载荷 Mesh 不依赖类型勾选即可见（逐实例显隐由掩码负责）；
 *  非载荷类型（碎片/残骸/未知）不吃这个例外 —— 卡片开关不影响这三类（需求：类型开关状态与
 *  对应目标显示不受「星座展示」任何影响）。 */
function consMeshBypass(model: string): boolean {
  if (MODEL_COARSE[model] !== 'PAYLOAD') return false
  return consOverrideActive.value || !!filterConst.value
}

/** 门控变化时统一重算点云与过滤轨道线显隐（揭示 = 恢复普通模式口径；未揭示 = 全隐藏） */
function applyCloudGateVisible() {
  const gate = cloudGate()
  for (const model of modelKeys()) {
    const im = g.modelMeshes[model]
    // 与 buildModelInstances 同口径：热力 / 过境视图整片隐藏卫星云，但集合叠加层（satSetActive）
    // 与星座展示态（filterConst，仅载荷见 consMeshBypass）例外
    if (im) im.visible = gate && (satSetActive.value || !!filterConst.value || (!heatMode.value && !passMode.value)) && (satSetActive.value || consMeshBypass(model) || modelVisible(model))
  }
  // 未揭示时过滤轨道线一并隐藏（line.visible 只控制类型勾选/总开关，组级显隐在这里收口）
  if (g.filterOrbitGroup) g.filterOrbitGroup.visible = gate && orbitVisible.value
  if (!gate) {
    if (g.orbitLine) g.orbitLine.visible = false
    if (g.previewOrbitLine) g.previewOrbitLine.visible = false
  }
}

/** 为每个非空型号创建（或换档重建）InstancedMesh，填充初始矩阵。
 *  先粗后精：首屏传 'low' 快速出图，之后 maybeUpgradeLod 判定需要升档时以新档位重跑本函数；
 *  新批全部建好后再原子替换旧批（旧批在新批挂上之前一直显示，避免切档空窗闪烁）。 */
async function buildModelInstances(lod: ModelLod) {
  const scene = g.scene
  if (!scene) return
  const models = modelKeys().filter((k) => g.modelIndices[k].length)
  const failModels: string[] = []
  const built: Record<string, THREE.InstancedMesh> = {}
  let done = 0
  // 型号之间互不依赖：并行下载 + 解码（12 个 gltf+draco 串行等待是首屏主要耗时之一），
  // 进度按完成数推进；失败型号由 loadGeom 内部兜底为 null。
  const parts = await Promise.all(models.map(async (model) => {
    const globalIdxs = g.modelIndices[model]
    const coarse = g.instOf[globalIdxs[0]].coarse
    const gm = await loadGeom(modelUrlOf(model, lod), coarse, model)
    loadProgress.value = Math.min(90, 46 + Math.round((++done / (models.length || 1)) * 44))
    return { model, globalIdxs, coarse, gm }
  }))
  if (disposed || !g.scene) return
  for (const p of parts) {
    if (!p.gm) { failModels.push(p.model); continue }
    const imesh = new THREE.InstancedMesh(p.gm.geom, p.gm.mat, p.globalIdxs.length)
    imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    imesh.userData.model = p.model
    // 碎片 / 箭体：预生成逐实例翻滚参数（载荷 / 未知物体不翻滚，留 null 走无翻滚分支）
    imesh.userData.spin = p.coarse === 'DEBRIS' || p.coarse === 'ROCKET BODY' ? makeTumble(p.globalIdxs) : null
    for (let local = 0; local < p.globalIdxs.length; local++) {
      writeInstance(imesh, local, p.globalIdxs[local])
    }
    imesh.instanceMatrix.needsUpdate = true
    // 显隐口径与外部一致：图例按粗类型勾选（modelVisible 换算），热力 / 过境视图整片隐藏卫星云；
    // 例外 = NORAD 集合展示态（satSetActive）与星座卡片载荷通道（consMeshBypass，仅载荷）：
    // 在这两个通道下目标不依赖类型勾选即可见（掩码负责把非成员实例写成零矩阵），类型开关状态不受影响。
    imesh.visible = cloudGate() && (satSetActive.value || !!filterConst.value || (!heatMode.value && !passMode.value)) && (satSetActive.value || consMeshBypass(p.model) || modelVisible(p.model))
    built[p.model] = imesh
  }
  for (const model of models) if (built[model]) scene.add(built[model])
  for (const old of g.meshes) scene.remove(old)
  g.meshes = []
  g.modelMeshes = {}
  for (const model of models) {
    if (!built[model]) continue
    g.modelMeshes[model] = built[model]
    g.meshes.push(built[model])
  }
  g.modelLod = lod
  // 新建的 InstancedMesh 没有 instanceColor：按当前着色维度逐实例上色并刷新图例（切换维度时另有 watch 重涂）
  applyPointColors()
  // 切档发生在运行中：新批矩阵按当前过滤掩码重写一遍（首屏时 filterMask 还没初始化，跳过）
  if (g.filterMask.length === g.cloudList.length) rewriteInstanceMatrices((gi) => g.filterMask[gi] === 1)
  modelNotice.value = failModels.length
    ? `⚠ 模型加载失败：${failModels.join('、')}（详见控制台 console.error）`
    : ''
}

/* ============================================================
 * 先粗后精：模型 LOD 自适应换档
 *  首屏统一 low（见 loadConstellation 的 buildModelInstances('low')），
 *  之后按「画质档位上限 + 相机距地高度 + 当前可见卫星数」挑目标档位，变了才重建。
 *  整个点云共用一套档位（InstancedMesh 一次 draw call 画完全部实例，
 *  单个实例的精细度无法独立控制）；重建复用 geomCache，同档位不会重复下载。
 * ============================================================ */
/** 换档检查间隔(ms)：重建有成本，不必每帧算 */
const LOD_CHECK_MS = 1000
/** 首次换档的等待时间(ms)：首屏刚出图那几秒帧耗时偏高，先让画面稳定再评估 */
const LOD_WARMUP_MS = 4000
let lodCheckAt = 0
let lodWarmupUntil = 0
let lodBuilding = false

/** 按「画质档位 + 相机距地高度 + 可见卫星数」挑当前应使用的档位。
 *  数量级是硬约束：实例化渲染会把全部可见实例都画一遍（与相机远近无关），
 *  几万颗时必须 low；只有过滤到少量卫星后才允许升到 med / high。 */
function pickModelLod(): ModelLod {
  const cap: ModelLod = qualityTier === 'high' ? 'high' : qualityTier === 'mid' ? 'med' : 'low'
  if (cap === 'low') return 'low'
  const vis = visibleCount.value
  if (vis > 15000) return 'low'
  if (vis > 4000) return 'med'
  // 卫星数少时还要相机足够近：模型在屏幕上占得住像素，升 high 才有意义
  const dist = g.camera ? g.camera.position.length() : 0
  const near = dist > 0 && dist - EARTH_R <= 1.2
  return cap === 'high' && near ? 'high' : 'med'
}

/** 每帧调用（内部限频）：目标档位与当前档位不同时异步重建实例。
 *  构建过滤轨道线 / 用户拖拽 / 热力·过境视图期间跳过，避免和这些耗预算的操作叠加。 */
function maybeSwitchModelLod(now: number) {
  if (lodBuilding || disposed || !g.scene || !g.cloudList.length) return
  if (heatMode.value || passMode.value || orbitBuilding.value || g.userInteracting) return
  if (now < lodWarmupUntil || now - lodCheckAt < LOD_CHECK_MS) return
  lodCheckAt = now
  const target = pickModelLod()
  if (target === g.modelLod) return
  lodBuilding = true
  void buildModelInstances(target).finally(() => { lodBuilding = false })
}

/* ============================================================
 * 卫星持续运动：全量外推（每帧平滑）+ 预算内精确校准（消除长期漂移）
 * ============================================================ */
/** 地球引力常数（场景单位）：长度 1 = 地球半径 6371km，μ 随长度单位三次方缩放 */
const MU_SCENE = 398600.4418 / (EARTH_RADIUS_KM ** 3)
/** 单步外推的最长仿真时长（秒）：实测（LEO 447km，与 SGP4 真值比）单步 30s 时一个校准周期
 *  （1800s 仿真）累计误差 251km，60s 是 497km，10s 是 81km。取 30s 作平衡点 */
const EXTRAP_MAX_STEP_SEC = 30
/** 一帧最多切几步：帧间隔被 clamp 到 0.1s，×3600 档一帧仍可前进 360s，切 8 步（每步 45s）即覆盖 */
const EXTRAP_MAX_SUBSTEPS = 8
/** 在轨最大地面速度（km/s）折算到场景单位：LEO ≈ 7.9km/s，作为「本帧最多可能移动多少」的保守上界 */
const MAX_ORBITAL_SPEED_SCENE = 7.9 / EARTH_RADIUS_KM
/** 累计位移小于该值（场景单位；1e-4 ≈ 0.64km，常见缩放下不足一像素）时不重写实例矩阵。
 *  位置照常积分，只是不把 3.5 万个实例的矩阵（2.26MB）重传到 GPU —— 实时档一帧仅前进 2e-5，
 *  约每 5 帧才需要真正落一次矩阵，而 SGP4 校准本身也会把所触碰的实例矩阵写掉。 */
const MATRIX_SKIP_SCENE = 1e-4

/** 一步二体积分：按当前半径算引力加速度，Taylor 二阶推进位置、同阶推进速度（原地改写 x/y/z）。
 *  直接读写分量而不走 Vector3 方法：这是最热的循环（3.5 万颗 × 每帧数步，实测每步约 0.1ms）。
 *  原实现把速度当常量做直线外推，误差 ∝ Δt² —— 高速档下校准周期（约 0.5s 真实时间）折算成上千秒
 *  仿真时间，实测位置误差达 1.2 万公里（两个地球直径）；换成二体积分后同一情形降到数百公里。 */
function integrateStep(p: THREE.Vector3, v: THREE.Vector3, h: number) {
  const x = p.x, y = p.y, z = p.z
  const r2 = x * x + y * y + z * z
  const k = MU_SCENE / (r2 * Math.sqrt(r2))
  const ax = -k * x, ay = -k * y, az = -k * z
  const hh = 0.5 * h * h
  p.x = x + v.x * h + ax * hh
  p.y = y + v.y * h + ay * hh
  p.z = z + v.z * h + az * hh
  v.x += ax * h
  v.y += ay * h
  v.z += az * h
}

/* ---------- 位置校正的平滑（避免「闪位置」） ----------
 * 批量校正位置的两条路径 —— 逐批 SGP4 校准（calibrateInstances）与快照坐标替换（applyCloudCoords）——
 * 都会把「按旧参考算出的坐标」换成新值。若直接赋值，画面上就是整片目标突然挪位（拾取卫星、镜头拉近时尤其明显）。
 * 这里改为：校正时不直接改 scenePos，而是把「当前值 − 新值」记为待补位移 posOff[i]，
 * 再由每帧的 decayPositionOffsets 把位移指数衰减补回 —— 表现为平滑贴到新位置。
 *
 * 衰减时间常数 0.12s（约 0.35s 收敛到 1%）；位移超过 POS_SMOOTH_MAX_OFF 时放弃平滑直接对齐：
 * 那说明两份数据的时刻差了大半条轨道，让目标在几百毫秒里直线掠过去会穿（或贴）着地球飞，反而不如一次对齐干净。 */
let posOff: THREE.Vector3[] = []
const POS_SMOOTH_TAU = 0.12
/** 待补位移小于该平方值（场景单位²，1e-10 ≈ 6cm）即视为已到位 */
const POS_SMOOTH_EPS_SQ = 1e-10
/** 可平滑的最大位移（场景单位）：0.05 ≈ 318km，约 20 分钟轨道位移 */
const POS_SMOOTH_MAX_OFF = 0.05
const POS_SMOOTH_MAX_OFF_SQ = POS_SMOOTH_MAX_OFF * POS_SMOOTH_MAX_OFF
/** 待补位移超过该数量时，本帧交给主循环整批重写矩阵（逐条重写反而更贵） */
const POS_SMOOTH_BULK = 6000

/** 平滑地设定第 i 颗卫星的位置：不直接赋值，而是把差值记为待补位移（见 posOff 说明） */
function applySmoothPos(i: number, x: number, y: number, z: number) {
  const p = g.scenePos[i]
  const off = posOff[i]
  const ox = p.x - x, oy = p.y - y, oz = p.z - z
  if (!off || ox * ox + oy * oy + oz * oz > POS_SMOOTH_MAX_OFF_SQ) {
    // 无平滑槽位（点云还没建好）或位移过大：直接对齐
    if (off) off.set(0, 0, 0)
    p.set(x, y, z)
    return
  }
  off.set(ox, oy, oz)
  // 位置保持不变：由 decayPositionOffsets 逐帧把 p 拉向 (x,y,z)，视觉上即平滑贴位
}

/** 每帧衰减待补位移（dt: 秒）。
 *  @returns 是否建议本帧整批重写实例矩阵（待补位移很多时逐条重写不如整批） */
function decayPositionOffsets(dt: number): boolean {
  const n = g.cloudList.length
  if (!n || posOff.length !== n) return false
  let cnt = 0
  for (let i = 0; i < n; i++) {
    const o = posOff[i]
    if (o.x !== 0 || o.y !== 0 || o.z !== 0) cnt++
  }
  if (!cnt) return false
  const bulk = cnt >= POS_SMOOTH_BULK
  const k = Math.exp(-dt / POS_SMOOTH_TAU)
  const drop = 1 - k
  const touched: THREE.InstancedMesh[] = []
  for (let i = 0; i < n; i++) {
    const o = posOff[i]
    if (o.x === 0 && o.y === 0 && o.z === 0) continue
    const p = g.scenePos[i]
    p.x -= o.x * drop
    p.y -= o.y * drop
    p.z -= o.z * drop
    o.multiplyScalar(k)
    // 已到位（或整批策略下不用逐条写）：清掉位移即可
    if (o.lengthSq() < POS_SMOOTH_EPS_SQ) { o.set(0, 0, 0); continue }
    if (bulk || g.filterMask[i] !== 1) continue
    const imesh = g.modelMeshes[g.instOf[i].model]
    if (!imesh) continue
    const local = g.localOf[i]
    if (local < 0) continue
    if (imesh.userData.spin) writeInstance(imesh, local, i)
    else writeInstanceUpright(imesh, local, i)
    if (!touched.includes(imesh)) touched.push(imesh)
  }
  for (const m of touched) m.instanceMatrix.needsUpdate = true
  return bulk
}

/* ---------- 快照时间追赶（cache → fresh 不瞬跳） ----------
 * 本地缓存快照（IndexedDB 直出）与最新快照的 snap 时刻不同，若直接把坐标换成最新值，
 * 画面上就是整片目标瞬移一下（就是「缓存的快照 → 加载回来位置」那一下闪位）。
 * 这里改为：把虚拟时间在 CLOUD_WARP_MS 内连续推进到最新快照时刻 —— 位置沿轨道逐帧演化、
 * 地球自转同步跟上，到点后再套用最新坐标（残差走 applySmoothPos 平滑），全程无瞬跳。
 * 时刻差过大（本地缓存放了很久）不做追赶动画，直接对齐：几百毫秒里掠过小半条轨道会穿过地球。 */
const CLOUD_WARP_MS = 600
/** 小于该时刻差就直接平滑套用：几十毫秒的差距不值得专门跑一次追赶动画 */
const CLOUD_WARP_MIN_MS = 300
/** 可追赶的最大时刻差：2 小时（0.6s 内推完，单帧约 190s 仿真，仍在「8 步 × 30s」的积分上限内） */
const CLOUD_WARP_MAX_MS = 2 * 3600 * 1000
/** 追赶时的单帧仿真推进上限（与 updateExtrapolate 的积分粒度一致），防止单帧积分量失控 */
const MAX_WARP_STEP_SEC = EXTRAP_MAX_STEP_SEC * EXTRAP_MAX_SUBSTEPS
/** 待套用的最新快照（非 null = 追赶进行中），及目标时刻 / 结束墙钟时刻 */
let warpRes: ConstellationSnapshot | null = null
let warpToMs = 0
let warpEndWall = 0

function updateExtrapolate(simStep: number) {
  const n = g.cloudList.length
  if (!n || simStep <= 0) return
  const pos = g.scenePos
  const vel = g.sceneVel
  const mask = g.filterMask
  const sub = Math.max(1, Math.min(EXTRAP_MAX_SUBSTEPS, Math.ceil(simStep / EXTRAP_MAX_STEP_SEC)))
  const h = simStep / sub
  matrixDrift += MAX_ORBITAL_SPEED_SCENE * simStep
  const writeMatrix = matrixDrift >= MATRIX_SKIP_SCENE
  if (writeMatrix) matrixDrift = 0
  for (const model of modelKeys()) {
    const imesh = g.modelMeshes[model]
    const globalIdxs = g.modelIndices[model]
    if (!globalIdxs.length) continue
    for (let local = 0; local < globalIdxs.length; local++) {
      const gi = globalIdxs[local]
      const p = pos[gi]
      const v = vel[gi]
      for (let s = 0; s < sub; s++) integrateStep(p, v, h)
      if (!writeMatrix || !imesh || mask[gi] !== 1) continue
      if (imesh.userData.spin) {
        // 碎片 / 箭体 360° 翻滚：姿态逐帧变化，须重写整个矩阵
        writeInstance(imesh, local, gi)
      } else {
        // 载荷等三轴稳定目标：姿态同样逐帧重算（机身长轴恒对齐径向天顶，见 orbitBasis），
        // 只是走免四元数 / 免 compose 的直写快路径
        writeInstanceUpright(imesh, local, gi)
      }
    }
    if (imesh && writeMatrix) imesh.instanceMatrix.needsUpdate = true
  }
}

function calibrateInstances(budget: { n: number }) {
  // satrec 懒加载：TLE 未就绪时整表都是 null，直接跳过（否则每帧空扫 3.5 万个下标）
  if (!satrecsReady) return
  // 快照时间追赶期间不校准：这一段的坐标按轨道连续演化（见 patchCloudCoords 的 warp），
  // 校准会把它拉回 SGP4 精确值，反而和追赶动画互相打架；落位后自然恢复。
  if (warpRes) return
  const satrecs = g.satrecs
  const k = satrecs.length
  if (!k) return
  const t = new Date(g.simTimeMs)
  const from = g.batchCursor
  let i = from
  const touched: THREE.InstancedMesh[] = []
  for (; i < k && budget.n > 0; i++) {
    const rec = satrecs[i]
    if (!rec) continue
    const pv = propagate(rec, t)
    budget.n--
    if (!pv?.position) continue
    // 位置走平滑校正（见 applySmoothPos）：校准是每 100ms 一批、轮完全表约 6s，
    // 直接赋值会让每批目标当场跳一下 —— 拉近看时就是「跟掉帧一样闪位置」
    applySmoothPos(i, pv.position.x * KM_TO_SCENE, pv.position.z * KM_TO_SCENE, -pv.position.y * KM_TO_SCENE)
    if (pv.velocity) {
      g.sceneVel[i].set(pv.velocity.x * KM_TO_SCENE, pv.velocity.z * KM_TO_SCENE, -pv.velocity.y * KM_TO_SCENE)
    }
    const imesh = g.modelMeshes[g.instOf[i].model]
    if (!imesh) continue
    const local = g.localOf[i]
    if (local < 0) continue
    if (g.filterMask[i] === 0) {
      imesh.setMatrixAt(local, ZERO_M)
    } else {
      writeInstance(imesh, local, i)
    }
    if (!touched.includes(imesh)) touched.push(imesh)
  }
  for (const m of touched) m.instanceMatrix.needsUpdate = true
  g.batchCursor = i >= k ? 0 : i
}

/* ============================================================
 * 过滤：检索 / 星座 / 高度 / NORAD 集合 → 可见掩码 + 批量绘制轨道线
 * ============================================================ */
/** NORAD 集合展示的硬上限：集合过滤 + 全量画线是一次性任务，超出后显存与首绘耗时增长明显
 *  （8000 颗约 96 段/颗 ≈ 12MB 顶点、首绘约 5s，密度见 scene.ts 的 orbitSteps）。超出部分截断。 */
const MAX_SAT_SET = 8000

/** 展示一批指定 NORAD 的卫星（智能体 / 接口下发）：只显示这批目标并画出它们的全部轨道线。
 *  与 pickConstellation 是两种「定位来源」，故入口互清（先清 kw / 星座 / 高度，避免旧条件 AND 出空集）。
 *  点云尚未就绪时不额外刷新——applyCloud 会在点云到位后按 filterActive 重放当前条件。 */
function showSatelliteSet(norads: number[]) {
  const arr: number[] = []
  const seen = new Set<number>()
  for (const v of norads || []) {
    const id = Math.trunc(Number(v))
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    arr.push(id)
    if (arr.length >= MAX_SAT_SET) break
  }
  filterKw.value = ''
  filterConst.value = ''
  consCardBound.value = false
  altMin.value = undefined
  altMax.value = undefined
  // 与多星座对比互清（两种定位来源 AND 在一起会得出空集）
  compareConsts.value = []
  // 赋新数组（而非原地改）保证 watch 必触发
  filterNorads.value = arr.length ? arr : null
  if (g.cloudList.length) refreshFilter()
}

function refreshFilter() {
  const list = g.cloudList
  const n = list.length
  if (!n) return
  const kw = filterKw.value.trim().toLowerCase()
  const cons = filterConst.value
  // NORAD 集合：按编号精确命中，用 Set（3.5 万次 has ≈ 1ms；禁用 Array.includes）
  const noradSet = filterNorads.value?.length ? new Set(filterNorads.value) : null
  const hasAlt = altMin.value != null || altMax.value != null
  const mask = new Uint8Array(n)
  let cnt = 0
  for (let i = 0; i < n; i++) {
    const p = list[i]
    let ok = true
    if (kw) ok = (p.object_name || '').toLowerCase().includes(kw)
    // 星座 = 卫星组网：星座过滤下只认载荷卫星。历史上按名称前缀自动匹配会把同名火箭箭体 /
    // 碎片（如退役风云卫星残骸）也关联进星座，若不过滤它们会被计入「X 颗」并画出轨道线，
    // 与「星座下只有卫星」的语义不符（关联数据的类型标识见 /mui/sat_constellation）。
    if (ok && cons && !consCardBound.value) ok = p.object_type === 'PAYLOAD' && (p.cons || []).includes(cons)
    // 星座卡片「星座展示」逐星库口径（卡片通道）：只影响载荷——
    // 主开关开 = 展示全部星座（点暗者隐藏）；主开关关 = 只展示点亮星座；无星座归属的载荷跟随主开关。
    // 碎片/残骸/未知不参与（卡片开关不影响这三类的按钮与显示）。
    if (ok && consOverrideActive.value && p.object_type === 'PAYLOAD') {
      const cs = p.cons || []
      ok = cs.length ? cs.some((nm) => consShowOf(nm)) : satPanel.typeF.PAYLOAD
    }
    // 多星座对比：命中「任一」对比星座即为可见（与星座过滤同口径：只认载荷）
    if (ok && compareActive.value) {
      ok = p.object_type === 'PAYLOAD'
        && compareConsts.value.some((c) => (p.cons || []).includes(c.name))
    }
    if (ok && noradSet) ok = noradSet.has(Number(p.norad_id))
    if (ok && hasAlt) {
      const a = p.alt
      if (a == null) ok = false
      else {
        if (altMin.value != null && a < altMin.value) ok = false
        if (altMax.value != null && a > altMax.value) ok = false
      }
    }
    if (ok) { mask[i] = 1; cnt++ }
  }
  g.filterMask = mask
  visibleCount.value = cnt
  // 星座视图右侧成员列表与过滤掩码同源同刻刷新（同一份过滤口径，避免两处各算一次）
  rebuildConsSatIndex()
  // 按型号重写实例矩阵（不可见的写零矩阵），与「三维还原」共用同一实现
  rewriteInstanceMatrices((gi) => mask[gi] === 1)
  void rebuildFilterOrbits()
}

/** 过滤轨道线重建的代次号：TLE 懒加载会 await，期间用户可能又改了过滤条件，
 *  旧的那次 await 返回后必须让位给最新一次（否则会挂上一批过期轨道线） */
let filterOrbitGen = 0

/** 过滤轨道线的分组键：默认按粗类型（TYPE_KEYS 4 类）；多星座对比态按「所属对比星座」（`cmp:<名称>`）。
 *  —— 分组键决定轨道线分成几条 LineSegments、每条一种颜色（见 stepFilterOrbits）。 */
function orbitGroupKeyOf(p: ConstellationPoint): string {
  if (compareActive.value) return bucketKeyOf('compare', p)
  return TYPE_MODEL[p.object_type] ? p.object_type : 'UNKNOWN'
}

/** 星座展示态轨道线统一蓝色（用户指定，替代原「载荷红」粗线观感） */
const CONS_ORBIT_COLOR = 0x3f9dff
/** 过滤轨道线的分组颜色：对比态取该星座的调色板色（与点云着色同一份 colorBucketDefs），
 *  星座展示态统一蓝色细线（CONS_ORBIT_COLOR），否则取类型色 TYPE_COLOR。 */
function orbitGroupColorOf(key: string): number {
  if (compareActive.value) {
    const def = colorBucketDefs('compare').find((d) => d.key === key)
    return parseInt((def?.color || '#b0bec5').slice(1), 16)
  }
  // 星座展示态：该星座成员轨道线统一蓝色（用户指定，替代原「载荷红」粗线观感）
  if (filterConst.value) return CONS_ORBIT_COLOR
  return TYPE_COLOR[key] ?? 0x8fd0ff
}

async function rebuildFilterOrbits() {
  const scene = g.scene
  if (!scene) return
  const gen = ++filterOrbitGen
  if (g.filterOrbitGroup) {
    g.filterOrbitPending = g.filterOrbitGroup
    g.filterOrbitGroup = null
  }
  g.filterOrbitQueue = []
  g.filterOrbitCursor = 0
  g.filterOrbitT0 = g.simTimeMs
  // 分组键是动态的（默认 TYPE_KEYS 4 类；多星座对比态为 `cmp:<星座名>`），
  // 故整体置空而非按 TYPE_KEYS 逐键重置 —— 否则对比态的 cmp:* 桶会残留旧数据被重复填充。
  g.filterOrbitSegs = {}
  g.filterOrbitMeta = {}
  // 画轨道线要用 satrec，而 satrec 是懒加载的（TLE 不随首屏下发）：有过滤条件时先补齐
  //（awaitSatrecs 抗「解析期间点云被重建」，否则首次设过滤条件会因 satrec 全空而不画线、要再改一次才出）
  if (filterActive.value) {
    // 先把「绘制中」状态立起来：useDelayed 的 1.5s 计时从这一刻起算，等 TLE 的秒级等待也纳入提示覆盖；
    // 并标出「准备轨道数据」子阶段（等 satrec 时文案不同），避免「loading 已消失、轨道线迟迟不出」的无提示空等。
    orbitBuilding.value = true
    orbitProgress.value = 0
    orbitPreparing.value = !satrecsReady
    await awaitSatrecs()
    // 期间又触发了新的过滤 / 已取消过滤：状态与画线都交给最新那次处理
    //（这里不能复位 preparing，否则会把最新那次正在显示的提示误关）
    if (gen !== filterOrbitGen) return
    orbitPreparing.value = false
  }
  // 期间又触发了新的过滤 / 已取消过滤：交给最新那次处理（它会重新置态并在结束时复位提示）
  if (gen !== filterOrbitGen) return
  // 星座展示态：轨道线由「轨道展示」开关显式控制 —— 点暗时不构建（省去上万条线的构建开销），
  // 点亮时由 consOrbitOn watch 重新走 refreshFilter → 本函数（届时跳过此分支正常出线）
  if (filterConst.value && !compareActive.value && !consOrbitOn.value) {
    orbitPreparing.value = false
    orbitBuilding.value = false
    g.filterOrbitItems = []
    if (g.filterOrbitPending) { scene.remove(g.filterOrbitPending); disposeGroup(g.filterOrbitPending); g.filterOrbitPending = null }
    return
  }
  // 「无过滤条件」或「TLE 尚未就绪」都不需要画轨道线，统一走清理分支
  if (!filterActive.value || !satrecsReady) {
    orbitPreparing.value = false
    orbitBuilding.value = false
    g.filterOrbitItems = []
    if (g.filterOrbitPending) { scene.remove(g.filterOrbitPending); disposeGroup(g.filterOrbitPending); g.filterOrbitPending = null }
    return
  }
  const list = g.cloudList
  const n = list.length
  // 点云里的物体都带 TLE（后端已把无 TLE / 传播失败的记录过滤掉），故只按可见掩码取队列；
  // 卡片/星座列表通道绑定星座（filterConst）时轨道线只画该星座成员 —— 掩码是「主开关+卡片」的
  // 并集口径（主开关开时可能整屏卫星），这里再收口到绑定星座，与「轨道展示」按钮语义一致
  const boundCons = filterConst.value
  for (let i = 0; i < n; i++) {
    if (!g.filterMask[i]) continue
    if (boundCons) {
      const q = list[i]
      if (!(q.object_type === 'PAYLOAD' && (q.cons || []).includes(boundCons))) continue
    }
    g.filterOrbitQueue.push(i)
  }
  if (!g.filterOrbitQueue.length) {
    orbitPreparing.value = false
    orbitBuilding.value = false
    g.filterOrbitItems = []
    if (g.filterOrbitPending) { scene.remove(g.filterOrbitPending); disposeGroup(g.filterOrbitPending); g.filterOrbitPending = null }
    return
  }
  // 近重合轨道去重：同一轨道面/相近高度的多颗卫星，各自 TLE 传播出的环彼此只差几~几十公里
  // （实测 Galileo 同面 4 星的环仅差 0.04°，Kuiper 散布赤经里也有 0.09° 的成对组），拉近看就是
  // 「一条轨道由 2~4 条蓝线组成」。按「半长轴/倾角/升交点赤经」三要素分桶（双偏移网格降低边界
  // 漏并），每桶只由首星画环，其余成员复用 —— 每条视觉轨道只画一条线，点云仍逐星渲染不受影响；
  // 高亮/染色经 paintConsOrbit 归并到共用环。分桶按轨道分组键隔离（类型态/对比态各色互不混并）。
  g.filterOrbitPrimary = new Int32Array(n).fill(-1)
  {
    const cellA = new Map<string, number>()
    const cellB = new Map<string, number>()
    for (const gi of g.filterOrbitQueue) {
      const d = list[gi]
      if (!d) continue
      const rec = g.satrecs[gi]
      if (!rec || rec.no <= 0) { g.filterOrbitPrimary[gi] = gi; continue }
      const nRadS = rec.no / 60
      const aKm = Math.cbrt(398600.4418 / (nRadS * nRadS))
      const tsMin = (g.filterOrbitT0 - rec.jdsatepoch * 86400000) / 60000
      // incco / nodec 运行时存在但 SatRec 类型未声明（倾角/升交点的长期漂移项），取值近似即可
      const recX = rec as unknown as { incco?: number; nodec?: number }
      const incDeg = (rec.inclo + (recX.incco || 0) * tsMin) * 180 / Math.PI
      let raanDeg = (rec.nodeo + (recX.nodec || 0) * tsMin) * 180 / Math.PI
      raanDeg = ((raanDeg % 360) + 360) % 360
      const gk = orbitGroupKeyOf(d)
      // 桶阈值：半长轴 12km / 倾角 0.15° / 赤经 0.6°；B 网格整体偏移半格，跨格边界的近重合环仍能并上
      const ka = `${gk}|${Math.round(aKm / 12)}|${Math.round(incDeg / 0.15)}|${Math.round(raanDeg / 0.6)}`
      const kb = `${gk}|${Math.round((aKm + 6) / 12)}|${Math.round((incDeg + 0.075) / 0.15)}|${Math.round((raanDeg + 0.3) / 0.6)}`
      let primary = cellA.get(ka)
      if (primary === undefined) primary = cellB.get(kb)
      if (primary === undefined) { cellA.set(ka, gi); cellB.set(kb, gi); primary = gi }
      g.filterOrbitPrimary[gi] = primary
    }
  }
  orbitBuilding.value = true
  stepFilterOrbits({ n: propBudget })
}

function stepFilterOrbits(budget: { n: number }) {
  if (!g.filterOrbitQueue.length) return
  const list = g.cloudList
  const t0 = g.filterOrbitT0
  const steps = orbitSteps(g.filterOrbitQueue.length)
  const qLen = g.filterOrbitQueue.length
  while (g.filterOrbitCursor < qLen && budget.n > 0) {
    if (budget.n < steps) break
    const gi = g.filterOrbitQueue[g.filterOrbitCursor]
    g.filterOrbitCursor++
    const d = list[gi]
    if (!d) continue
    const rec = g.satrecs[gi]
    if (!rec || rec.no <= 0) continue
    // 近重合轨道去重：非桶内首星不画线、不重复传播（复用 primary 的环，见 rebuildFilterOrbits 分桶）
    if (g.filterOrbitPrimary && g.filterOrbitPrimary[gi] !== gi) continue
    const periodMin = (2 * Math.PI) / rec.no
    const pts: THREE.Vector3[] = []
    const t = new Date()
    for (let i = 0; i < steps; i++) {
      t.setTime(t0 + (i / steps) * periodMin * 60000)
      const pv = propagate(rec, t)
      budget.n--
      if (!pv?.position) { pts.length = 0; break }
      pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z))
    }
    if (pts.length < 3) continue
    // 分组键：默认按粗类型；多星座对比态按所属星座（cmp:<名称>）—— 决定这条轨道线归到哪条 LineSegments
    const key = orbitGroupKeyOf(d)
    const segs = (g.filterOrbitSegs[key] ||= [])
    const segStart = segs.length
    for (let i = 0; i < pts.length; i++) segs.push(pts[i], pts[(i + 1) % pts.length])
    ;(g.filterOrbitMeta[key] ||= []).push({ gi, segStart, steps })
  }
  orbitProgress.value = Math.round((g.filterOrbitCursor / qLen) * 100)
  if (g.filterOrbitCursor >= qLen) {
    const group = new THREE.Group()
    g.filterOrbitItems = []
    for (const key of Object.keys(g.filterOrbitSegs)) {
      const segs = g.filterOrbitSegs[key]
      if (!segs.length) continue
      const positions = new Float32Array(segs.length * 3)
      for (let j = 0; j < segs.length; j++) {
        const s = segs[j]
        positions[j * 3] = s.x; positions[j * 3 + 1] = s.y; positions[j * 3 + 2] = s.z
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
      // 顶点色：默认整条轨道线统一用该分组的颜色（载荷=红…）；星座成员高亮时按顶点区间把被点名那颗
      // 替换成亮青色（见 paintConsOrbit）——「替换」而非叠加，故上万条密集轨道线里也能一眼看清。
      const baseColor = orbitGroupColorOf(key)
      const bc = new THREE.Color(baseColor)
      const colors = new Float32Array(segs.length * 3)
      for (let j = 0; j < segs.length; j++) {
        colors[j * 3] = bc.r; colors[j * 3 + 1] = bc.g; colors[j * 3 + 2] = bc.b
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage))
      const line = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.7 })
      )
      line.userData.type = key
      // 还原高亮时用的基色（分组色），见 paintConsOrbit
      line.userData.baseColor = baseColor
      // 类型勾选 + 图例「轨道线」总开关叠加（总开关关闭时该类轨道线也不显示）；
      // 多星座对比态的键是 `cmp:<星座名>`（不在 TYPE_KEYS 里），不受类型勾选约束、只受总开关控制
      //（与 applyOrbitToggle / watch(visible) 里「非类型键视为应显示」同口径）。
      // 星座展示态：轨道线显隐归「轨道展示」开关把口，构建完成即应显示（总开关仍叠加）。
      line.visible = (TYPE_KEYS.includes(key) ? (!!filterConst.value || !!visible[key]) : true) && orbitVisible.value
      group.add(line)
      for (const m of g.filterOrbitMeta[key]) {
        g.filterOrbitItems.push({ gi: m.gi, steps: m.steps, line, positions, base: m.segStart })
      }
    }
    if (g.filterOrbitPending) {
      g.scene?.remove(g.filterOrbitPending)
      disposeGroup(g.filterOrbitPending)
      g.filterOrbitPending = null
    }
    if (group.children.length) {
      g.filterOrbitGroup = group
      // 首页「无目标」门控：未揭示前连过滤轨道线也不显示（揭示后由 applyCloudGateVisible / 各模式重算）
      group.visible = cloudGate()
      g.scene?.add(group)
    }
    g.filterOrbitSegs = {}
    g.filterOrbitQueue = []
    g.filterOrbitCursor = 0
    g.filterOrbitLiveT0 = g.simTimeMs
    orbitBuilding.value = false
    // 星座成员高亮：过滤轨道线重建后几何是全新的（默认分组色），按当前高亮 NORAD 重新上色
    if (consHighlightNorad.value > 0) {
      const hi = g.cloudList.findIndex((p) => p.norad_id === consHighlightNorad.value)
      if (hi >= 0) paintConsOrbit(hi, CONS_HIGHLIGHT_COLOR)
    }
  }
}

function updateFilterOrbitsLive(budget: { n: number }) {
  const items = g.filterOrbitItems
  const qLen = items.length
  if (!qLen) return
  if (g.simTimeMs - g.filterOrbitLiveT0 < ORBIT_LIVE_STEP_MS) return
  const t = new Date()
  let attempts = 0
  while (budget.n > 0 && attempts < qLen) {
    attempts++
    const it = items[g.filterOrbitCursor]
    g.filterOrbitCursor = (g.filterOrbitCursor + 1) % qLen
    if (budget.n < it.steps) break
    if (!it.line.visible) continue
    const rec = g.satrecs[it.gi]
    if (!rec || rec.no <= 0) continue
    const periodMin = (2 * Math.PI) / rec.no
    const positions = it.positions
    const base = it.base
    const steps = it.steps
    t.setTime(g.simTimeMs)
    const pv0 = propagate(rec, t)
    budget.n--
    if (!pv0?.position) continue
    let cx = pv0.position.x * KM_TO_SCENE
    let cy = pv0.position.z * KM_TO_SCENE
    let cz = -pv0.position.y * KM_TO_SCENE
    let ok = true
    for (let i = 0; i < steps; i++) {
      let nx: number, ny: number, nz: number
      if (i === steps - 1) { nx = cx; ny = cy; nz = cz }
      else {
        t.setTime(g.simTimeMs + ((i + 1) / steps) * periodMin * 60000)
        const pv = propagate(rec, t)
        budget.n--
        if (!pv?.position) { ok = false; break }
        nx = pv.position.x * KM_TO_SCENE
        ny = pv.position.z * KM_TO_SCENE
        nz = -pv.position.y * KM_TO_SCENE
      }
      const o = (base + i * 2) * 3
      positions[o] = cx; positions[o + 1] = cy; positions[o + 2] = cz
      positions[o + 3] = nx; positions[o + 4] = ny; positions[o + 5] = nz
      cx = nx; cy = ny; cz = nz
    }
    if (ok) {
      // 只把这一条轨道占用的顶点区间标脏：同类轨道线共用一个 BufferGeometry，
      // 直接 needsUpdate 会把整缓冲（N 条 × orbitSteps × 2 顶点，上千条即 MB 级）逐帧重传；
      // 走 updateRanges 后每次只上传这一条的 steps*2 个顶点（去重合并由 three 在 WebGLAttributes 里做）。
      const attr = it.line.geometry.getAttribute('position') as THREE.BufferAttribute
      attr.addUpdateRange(it.base * 3, it.steps * 2 * 3)
      attr.needsUpdate = true
    }
  }
  if (g.simTimeMs - g.filterOrbitLiveT0 >= ORBIT_LIVE_STEP_MS) g.filterOrbitLiveT0 = g.simTimeMs
}

function resetFilter() {
  filterKw.value = ''
  filterConst.value = ''
  // 星座卡片逐星库开关一并还原（全部回到跟随主开关态），轨道绑定解除
  for (const k2 of Object.keys(consShowMap)) delete consShowMap[k2]
  consCardBound.value = false
  altMin.value = undefined
  altMax.value = undefined
  filterNorads.value = null
  // 多星座对比一并清掉（还原到「按类型着色」的干净初始态）
  compareConsts.value = []
  // 直接重建掩码与实例矩阵：还原时即使过滤 ref 本就为空（watch 不触发 refreshFilter），
  // 也确保 filterMask 恢复全 1、各类型矩阵恢复非零，规避热力/星座过滤残留导致的卫星隐藏。
  if (g.cloudList.length) refreshFilter()
}

/* ============================================================
 * 选中卫星：四角准星跟随 + 轨道线 + 详情
 * ============================================================ */
/** 选中卫星：四角准星跟随 + 轨道线 + 详情。
 *  fly=false 时不飞镜头（热力模式下点击目标端点拾取时使用，保留当前观察机位与热力云）。 */
/** 选中序号：异步拉取 TLE 期间用户可能又点了别的卫星，只允许「最后一次点击」的结果落地，
 *  否则先发的请求若后返回，会把后点的选中结果覆盖掉（表现为点了 B 却选中 A / 像点不动）。 */
let selectSeq = 0
async function selectSatellite(pt: ConstellationPoint, fly = true) {
  const seq = ++selectSeq
  try {
    notice.value = ''
    const data = await getSatDetailPublic(pt.norad_id, dataSource.value)
    if (seq !== selectSeq) return
    if (!data?.tle_line1 || !data?.tle_line2) throw new Error('该物体缺少 TLE 两行根数，无法计算轨道')
    clearSelected()
    g.satrec = twoline2satrec(data.tle_line1, data.tle_line2)
    buildOrbit(data)
    const pv = propagate(g.satrec, new Date(g.simTimeMs))
    const scenePos = pv?.position ? eciToScene(pv.position.x, pv.position.y, pv.position.z) : eciToScene(pt.x, pt.y, pt.z)
    selDetail.value = data
    sel.id = data.norad_id
    sel.name = data.object_name || `NORAD ${data.norad_id}`
    sel.type = data.object_type
    hasSel.value = true
    // 选中卫星在点云里的光点也换成亮青（与轨道环同色）
    syncFocusPointPaint()
    detailOpen.value = true
    // 所属星座为附加信息：异步反查，失败静默留空；按 norad 校验防止快速连点时串号
    selConstellations.value = []
    const norad = data.norad_id
    listSatConstellationsPublic(norad)
      .then((list) => { if (sel.id === norad) selConstellations.value = list || [] })
      .catch(() => { if (sel.id === norad) selConstellations.value = [] })
    const anchor = new THREE.Group()
    anchor.position.copy(scenePos)
    g.selAnchor = anchor
    g.scene?.add(anchor)
    if (fly && g.selAnchor) flyToSat(g.selAnchor.position)
    g.controls!.update()
    updateLiveData()
    // 热力模式下拾取目标端点：选中卫星的独立轨道线与准星不能被热力视图的隐藏逻辑盖掉，这里确保可见
    if (heatMode.value) {
      if (g.orbitLine) g.orbitLine.visible = true
      if (g.selAnchor) g.selAnchor.visible = true
    }
    // 普通视图：新建的选中轨道线要服从图例「轨道线」总开关（热力模式下该函数自行跳过）
    applyOrbitToggle()
  } catch (e: unknown) {
    if (seq !== selectSeq) return
    notice.value = e instanceof Error ? e.message : '卫星选中失败'
  }
}

/** 由卫星列表面板点击触发：按全局索引拾取该卫星 */
function selectSatelliteByIndex(gi: number) {
  const pt = g.cloudList[gi]
  if (!pt) return
  selectSatellite(pt)
}

/** 由星座成员列表点击触发：与该星被双击完全一致（选中 + 详情面板 + 拉近到 TRACK_CAM_DIST 并居中跟踪） */
function trackSatelliteByIndex(gi: number) {
  const pt = g.cloudList[gi]
  if (!pt) return
  startTargetTracking(gi, pt)
}

/* ---------- 双击跟踪：拉近 + 居中逐帧跟随 ---------- */
/** 双击跟踪态：被跟踪目标在点云中的全局下标（null = 未跟踪）。
 *  跟踪时镜头与环绕焦点逐帧随目标平移（保持落位时的相对机位，目标恒居中），
 *  直到用户单击画布任意位置解除；右侧详情面板是普通 DOM，点击事件不落在画布上，不影响跟踪态。 */
let trackGi: number | null = null
/** 跟踪目标上一帧的场景坐标：与当前帧求差得到镜头逐帧平移量 */
const _trackPrev = new THREE.Vector3()
const _trackDelta = new THREE.Vector3()
/** 双击识别：同一目标两次单击的间隔窗口（ms）与上次记录 */
const DBL_PICK_MS = 400
const _pickDbl = { norad: -1, ts: 0 }
/** 跟踪的落位距离（场景单位，1 = 地球半径 6371km）：模型几何归一化到 MODEL_MAX_DIM = 0.011，
 *  该距离下模型可完整看清且不至于贴脸（普通单击落位距离是轨道半径，模型只是亚像素小点） */
const TRACK_CAM_DIST = 0.15

/** 进入跟踪：先走常规选中链路（准星 + 轨道线 + 详情面板），成功后把镜头拉近到 TRACK_CAM_DIST。
 *  载荷 / 碎片 / 箭体 / 未知统一走点云拾取，四类目标行为一致。 */
function startTargetTracking(gi: number, pt: ConstellationPoint) {
  selectSatellite(pt).then(() => {
    if (!hasSel.value || sel.id !== pt.norad_id || !g.selAnchor) return
    const cam = g.camera, controls = g.controls
    if (!cam || !controls) return
    trackGi = gi
    _trackPrev.copy(g.selAnchor.position)
    // 机位沿用 flyToPoint 的「镜头—目标—地心」共线口径，只是距离从轨道半径拉近到 TRACK_CAM_DIST
    const off = clampPolarToLimit(_trackPrev.clone().normalize())
    const toPos = _trackPrev.clone().addScaledVector(off, TRACK_CAM_DIST)
    beginCamFly(toPos, _trackPrev.clone(), 'sel')
  })
}

/** 解除跟踪：镜头停在当前位置不再跟随（已选中的目标、轨道线与详情面板保持不变） */
function stopTargetTracking() {
  trackGi = null
}

/** 智能体动作：按 NORAD 编号定位并选中卫星，走与列表点击完全相同的选中链路
 *  （准星 + 轨道线 + 详情面板 + 镜头飞向）。
 *  点云未就绪 / 该星不在当前数据源时，用最小 point 兜底构造，位置由 selectSatellite 内部按 TLE 现算。 */
function selectByNorad(norad: number) {
  const n = Number(norad)
  if (!Number.isFinite(n) || n <= 0) return
  const gi = g.cloudList.findIndex((p) => p.norad_id === n)
  if (gi >= 0) {
    selectSatelliteByIndex(gi)
    return
  }
  selectSatellite({ norad_id: n, object_name: '', object_type: 'UNKNOWN', x: 0, y: 0, z: 0 })
}

/** 智能体动作：直接以经纬度顶点绘制区域（写 regionDraft 即触发 watch 自动重绘，与手动框选同一份数据）。
 *  vertices 为 [lon, lat] 顶点数组（外环、简单多边形）；不足 3 点或越界点被丢弃，超上限自动截断。 */
function setRegionPolygon(vertices: Array<[number, number]>) {
  const pts = (Array.isArray(vertices) ? vertices : [])
    .map((p) => (Array.isArray(p) && p.length >= 2 ? { lon: Number(p[0]), lat: Number(p[1]) } : null))
    .filter(
      (p): p is { lon: number; lat: number } =>
        !!p && Number.isFinite(p.lon) && Number.isFinite(p.lat) &&
        p.lon >= -180 && p.lon <= 180 && p.lat >= -90 && p.lat <= 90
    )
    .slice(0, REGION_MAX_POINTS)
    .map((p) => ({ lon: Number(p.lon.toFixed(6)), lat: Number(p.lat.toFixed(6)) }))
  if (pts.length < 3) {
    notice.value = '绘制区域至少需要 3 个有效经纬度顶点（lon∈[-180,180]、lat∈[-90,90]）'
    return
  }
  setRegionDrawMode(false)
  regionDraft.value = pts
  regionHint.value = `已选 ${pts.length} 个顶点（已首尾闭合，可提交计算）`
}

function buildOrbit(data: SatTleItem) {
  const scene = g.scene
  if (!scene || !g.satrec) return
  const periodMs = (data.period && data.period > 0 ? data.period : 100) * 60000
  // 轨道环以「卫星当前时刻」为中心采样，而不是按 TLE 历元采样：
  // 历元与当前时刻常相隔数天，期间 J2 交点进动会让轨道面偏转（实测可达数百公里），
  // 按历元采样的环会与卫星实际位置明显错开；以当前时刻为中心则卫星必在所画环上。
  const t0 = g.simTimeMs - periodMs / 2
  const steps = 512
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= steps; i++) {
    const pv = propagate(g.satrec, new Date(t0 + (i / steps) * periodMs))
    if (!pv?.position) continue
    pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z))
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    // 选中卫星的独立轨道环统一用亮青（与星座点名成员高亮同色），一线即可从密集点云中辨识
    new THREE.LineBasicMaterial({ color: CONS_HIGHLIGHT_COLOR })
  )
  g.orbitLine = line
  scene.add(line)
  // 选中卫星即重算星下点轨迹（与轨道环同一份 satrec，避免两处各推一次采样时刻口径）
  updateGroundTrack()
}

function clearSelected() {
  // 双击跟踪随选中一并解除（换星 / 取消选中 / 还原等所有清选中路径通用）
  trackGi = null
  // 星历本星跟踪同样随选中解除（选中编目卫星时不能再被本星拽着镜头）
  stopEphemTracking()
  if (g.selAnchor) {
    g.scene?.remove(g.selAnchor)
    g.selAnchor = null
  }
  if (g.orbitLine) {
    g.scene?.remove(g.orbitLine)
    g.orbitLine.geometry.dispose()
    const m = g.orbitLine.material as THREE.LineBasicMaterial | undefined
    if (m) m.dispose()
    g.orbitLine = null
  }
  g.satrec = null
  // 星座归属与选中强绑定：取消选中即清空，避免旧值残留到下一颗星（异步回调里的 norad 校验也会拦一次）
  selConstellations.value = []
  // 星下点轨迹没有独立的销毁逻辑，只按 trackHasData 决定显隐；satrec 已清空，
  // 这里同步让它失效，避免「取消选中后旧轨迹还挂在场景里」（切星座、还原等路径通用）
  updateGroundTrack()
}

/* ---------- 星座视图：右侧成员列表点名高亮某颗卫星的轨道线 ---------- */
/** 高亮请求代次：异步等 TLE 期间用户可能又点了别的成员，只允许最后一次请求落地 */
let consHighlightSeq = 0
/** 上色复用色对象（避免每次新建 Color） */
const _consPaintColor = new THREE.Color()

/** 把「全局索引 gi 的卫星」在过滤轨道线里的顶点色改成 hex —— 直接替换该星那一段（载荷红等）的颜色，
 *  而不是额外叠加一条线；hex 传 null 表示还原为所在轨道线的分组基色。返回是否命中
 *  （未命中 = 该星不在当前过滤轨道线里，例如轨道线尚未建好，此时待 stepFilterOrbits 建好后重新上色）。 */
function paintConsOrbit(gi: number, hex: number | null): boolean {
  // 近重合轨道去重后非首星成员没有自己的环：归并到所属 primary 的共用环上染色
  const prim = g.filterOrbitPrimary && gi >= 0 && gi < g.filterOrbitPrimary.length ? g.filterOrbitPrimary[gi] : gi
  const target = prim >= 0 ? prim : gi
  let hit = false
  for (const it of g.filterOrbitItems) {
    if (it.gi !== target) continue
    const attr = it.line.geometry.getAttribute('color') as THREE.BufferAttribute | undefined
    if (!attr) continue
    const baseColor = (it.line.userData?.baseColor as number | undefined) ?? 0x8fd0ff
    _consPaintColor.setHex(hex == null ? baseColor : hex)
    const arr = attr.array as Float32Array
    const start = it.base * 3
    const end = (it.base + it.steps * 2) * 3
    for (let i = start; i < end; i += 3) {
      arr[i] = _consPaintColor.r
      arr[i + 1] = _consPaintColor.g
      arr[i + 2] = _consPaintColor.b
    }
    // 只把这一条轨道占用的顶点区间标脏（同类轨道线共用一个 BufferGeometry，见 updateFilterOrbitsLive）
    attr.addUpdateRange(start, end - start)
    attr.needsUpdate = true
    hit = true
  }
  return hit
}

/** 清除高亮配色（切星座 / 还原 / 卸载时调用）：把被点名那颗卫星的轨道线颜色还原为分组基色 */
function clearConstHighlight() {
  consHighlightSeq++
  const prev = consHighlightNorad.value
  consHighlightNorad.value = 0
  if (prev > 0) {
    const gi = g.cloudList.findIndex((p) => p.norad_id === prev)
    if (gi >= 0) paintConsOrbit(gi, null)
  }
  // 点云里被点名成员的光点一并还原（可能仍被「选中」占用，故交给同步函数按当前焦点重算）
  syncFocusPointPaint()
}

/** 高亮某颗卫星的轨道线（星座视图右侧成员列表点击触发）：先把镜头飞到该星当前位置，再把它在
 *  星座轨道线里那一段的颜色从载荷红「替换」为亮青（直接改顶点色，故上万条密集轨道线里也能一眼
 *  看清）；norad<=0 即只清除（并把镜头环绕轴心放回地心）。不改变选中单星状态（不设 hasSel / 详情）。 */
async function highlightConstSat(norad: number) {
  const n = Math.trunc(Number(norad))
  const had = consHighlightNorad.value > 0
  clearConstHighlight()
  if (!(n > 0)) {
    // 取消高亮：镜头焦点从该星放回地心（相机位置不动，仅换环绕轴心，避免缩放绕空中空点）
    if (had) resetOrbitFocusToEarth()
    return
  }
  const seq = ++consHighlightSeq
  const scene = g.scene
  if (!scene) return
  const gi = g.cloudList.findIndex((p) => p.norad_id === n)
  if (gi < 0) return
  // 列表高亮态先落地（轨道线尚未建好时也先记着，建好后会自动重新上色）
  consHighlightNorad.value = n
  // 该成员在点云里的光点也换成亮青
  syncFocusPointPaint()
  /** 该星不在此数据源 / 拿不到 TLE：撤销高亮标记，避免列表高亮态与实际轨道线不一致 */
  const abort = () => { if (seq === consHighlightSeq) { consHighlightNorad.value = 0; syncFocusPointPaint() } }
  // 定位 / 上色都要 satrec（TLE 懒加载），未就绪时先补齐；等待期间可能又被点 / 被清除，用代次守卫
  if (!satrecsReady) await awaitSatrecs()
  if (seq !== consHighlightSeq) return
  const rec = g.satrecs[gi]
  if (!rec || rec.no <= 0) return abort()
  // 镜头先飞到该星当前位置（与「选中单星」同一套落位算法，落位后环绕焦点切到该星）
  const pv = propagate(rec, new Date(g.simTimeMs))
  if (pv?.position) flyToPoint(eciToScene(pv.position.x, pv.position.y, pv.position.z), 'point')
  // 再把该星轨道线那一段的颜色替换成亮青（见 paintConsOrbit）
  paintConsOrbit(gi, CONS_HIGHLIGHT_COLOR)
}

function updateReticle() {
  const el = reticleEl.value
  if (!el) return
  const anchor = g.selAnchor
  let x = 0
  let y = 0
  let show = false
  if (anchor && g.camera && container.value) {
    _proj.copy(anchor.position).project(g.camera)
    if (_proj.z <= 1 && _proj.z >= -1) {
      const rect = container.value.getBoundingClientRect()
      x = (_proj.x * 0.5 + 0.5) * rect.width
      y = (-_proj.y * 0.5 + 0.5) * rect.height
      // 相机不再逐帧跟随卫星后，卫星会随时间走出视口：投影像素落在画布外时收起准星，
      // 否则会在画面角落留一个「指着空处」的圆环（离屏一点点仍显示，避免抖动闪烁）。
      const margin = 24
      show = x >= -margin && x <= rect.width + margin && y >= -margin && y <= rect.height + margin
    }
  }
  if (show) el.style.transform = `translate(${x}px, ${y}px)`
  // 显式写 block/none（不写空串）：本元素的 style 是模板里的静态属性，与其余页面的同名 class 共用样式，
  // 不依赖 class 默认 display，避免「谁覆盖谁」的隐式约定
  const want = show ? 'block' : 'none'
  if (el.style.display !== want) el.style.display = want
}

/** 取消选中卫星。resetCam=false 时不复位镜头：热力模式在「卫星详情 ↔ 事件详情」间切换时用它保留观察机位。 */
function resetSelected(resetCam = true) {
  clearSelected()
  hasSel.value = false
  selDetail.value = null
  detailOpen.value = true
  sel.id = 0; sel.name = ''; sel.type = ''; sel.lat = 0; sel.lon = 0; sel.alt = 0; sel.vel = 0; sel.simTime = ''
  // 取消选中：点云里那颗亮青光点还原为当前着色维度的分档色
  syncFocusPointPaint()
  if (resetCam && g.camera && g.controls) {
    restoreEarthOrbitLimits()
    // 复位到「正对中国」的初始机位（与进入本页时一致；按当前自转相位现算，不写死坐标）
    applyHomeCamera()
  }
}

/** 还原初始状态 = 全部过滤条件复位（检索 / 星座 / 高度 / 单星白名单清空，各型号 InstancedMesh 重建实例矩阵，
 *  位置=当前场景坐标、缩放=1），彻底规避热力/星座过滤残留掩码导致的零矩阵隐藏。
 *
 *  注意：「还原过滤条件」不等于「显示卫星云」，也不等于「勾选类型开关」——热力 / 过境视图下卫星云本就应隐藏；
 *  类型开关属于用户显式选择，还原时不得改动（详见下方 restoreSatVisible 内注释）。 */
function restoreSatVisible() {
  const list = g.cloudList
  // 注意：这里**不再强制把类型开关（visible / satPanel.typeF）置为 true**。
  // 打开左侧「太空安全目标列表」或右侧「星历分析」面板都会经 clearScene → resetToInitial 走到本函数，
  // 若在此强制勾选，会表现为「一弹面板『卫星』开关就自动亮起」（用户明确要求：缺省 false，弹面板不改状态）。
  // 点云显隐由 cloudRevealed 门控与 filterMask 决定，与类型开关解耦，故去掉这一行不影响列表使用。
  // 图例「轨道线」总开关一并复位：进入发射站视图会把它关掉（见 index.vue applyDock），
  // 若不复位则切回卫星 / 星座视图后点云恢复可见、但过滤轨道线（含星座轨道线）始终不显示。
  orbitVisible.value = true
  // 例外 = NORAD 集合展示态（satSetActive）：它是「分析叠加层」，在这两个视图下仍要显示卫星云
  const hideCloud = (heatMode.value || passMode.value) && !satSetActive.value
  for (const model of modelKeys()) {
    const im = g.modelMeshes[model]
    if (im) im.visible = cloudGate() && (hideCloud ? false : true)
  }
  if (!list.length) return
  rewriteInstanceMatrices((gi) => !!list[gi])
}

/** 三维还原到初始状态：清除全部过滤（含星座轨道线）、取消选中卫星、镜头回到地球中心初始机位 */
function resetToInitial() {
  resetFilter()
  resetSelected()
  restoreSatVisible()
  // 兜底：无论此前是否触发过 watch(heatSel) / applyHeatMode 清理，还原时都确保热力轨道线/标记被移除，
  // 避免「热力模式点云团后点还原，轨道线永久残留」问题
  clearHeatSelOrbits()
  // 过境视图还原：清空选中城市与明细（地表图层保留，退出过境由父组件切 dockMode 编排）
  resetPass()
}

function updateLiveData() {
  if (!g.satrec) return
  const date = new Date(g.simTimeMs)
  const pv = propagate(g.satrec, date)
  if (!pv?.position) return
  const gd = eciToGeodetic(pv.position, gstime(date))
  sel.lat = degreesLat(gd.latitude)
  sel.lon = degreesLong(gd.longitude)
  sel.alt = gd.height
  sel.vel = pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : 0
  sel.simTime = date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}

/* ============================================================
 * 交互：拾取 / 选中 / hover 预览轨道线 / 镜头飞行
 * ============================================================ */
function isOccludedByEarth(camPos: THREE.Vector3, satPos: THREE.Vector3): boolean {
  const r = EARTH_R
  _dirS.copy(satPos).sub(camPos)
  const distToSat = _dirS.length()
  if (distToSat <= 1e-6) return false
  _dirS.divideScalar(distToSat)
  _ocS.copy(camPos).negate()
  const t = _ocS.dot(_dirS)
  if (t <= 0 || t >= distToSat) return false
  const perp2 = _ocS.lengthSq() - t * t
  return perp2 < r * r
}

function pickNearestSat(ev: MouseEvent): number | null {
  const el = g.renderer?.domElement
  if (!el) return null
  const r = el.getBoundingClientRect()
  return pickNearestAt(ev.clientX - r.left, ev.clientY - r.top)
}

function pickNearestAt(px: number, py: number): number | null {
  const renderer = g.renderer, cam = g.camera
  if (!renderer || !cam || !g.scenePos.length) return null
  // 首页「无目标」门控：点云未揭示时卫星不可见也不可交互——hover 预览轨道线 / 点击选中一并禁用
  // （本函数是屏幕空间投影拾取，不感知 mesh.visible，必须在此收口）
  if (!cloudGate()) return null
  const rect = renderer.domElement.getBoundingClientRect()
  // 屏幕空间最近投影点拾取（PICK_TOLERANCE_PX 内吸附）：直接遍历 scenePos 做投影+遮挡判定。
  // 不再用 raycaster.intersectObjects(InstancedMesh)：three 对实例化网格是「逐实例包围球+三角形求交」，
  // 3.5 万实例时单次拾取可达数十~上百毫秒，是低端机拖拽/悬停卡顿的主因。
  const tolerance2 = PICK_TOLERANCE_PX * PICK_TOLERANCE_PX
  let bestGi: number | null = null
  let bestD2 = tolerance2
  const proj = _proj
  for (let i = 0; i < g.scenePos.length; i++) {
    if (g.filterMask[i] !== 1) continue
    // 图例按粗类型隐藏的物体不可拾取（含 hover 命中）：隐藏后不应再被点到 / 高亮。
    // 例外 = 星座展示通道（constellation 卡片 / 星座过滤）：类型开关默认全关时，
    //   星座展示仍会渲染载荷点云，这些点必须保持可拾取（与 consMeshBypass 的显隐口径一致）。
    const info = g.instOf[i]
    const coarse = info?.coarse
    if (coarse && visible[coarse] === false && !(info && consMeshBypass(info.model))) continue
    if (isOccludedByEarth(cam.position, g.scenePos[i])) continue
    proj.copy(g.scenePos[i]).project(cam)
    if (proj.z > 1 || proj.z < -1) continue
    const sx = (proj.x * 0.5 + 0.5) * rect.width
    const sy = (-proj.y * 0.5 + 0.5) * rect.height
    const dx = sx - px
    const dy = sy - py
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; bestGi = i }
  }
  return bestGi
}

const CLICK_MS = 300
const CLICK_PX = 6
let pressDown = false
let pressX = 0
let pressY = 0
let pressTime = 0

/** 同步 OrbitControls 的极角限位（口径说明见 ORBIT_POLE_LIMIT / ORBIT_POLE_LIMIT_SEL）。
 *  相机 up 恒为世界 +Y，焦点在地心 / 在卫星同一套限位，故与焦点无关；拾取目标时放宽以允许任意旋转。 */
function applyOrbitPolarLimits() {
  const controls = g.controls
  if (!controls) return
  const limit = currentPoleLimit()
  controls.minPolarAngle = limit
  controls.maxPolarAngle = Math.PI - limit
}

/** 把「焦点 → 相机」方向夹进极角限位内（与 applyOrbitPolarLimits 同一口径，见 ORBIT_POLE_LIMIT）。
 *  flyToSat 落位机位用：先夹再落位，OrbitControls 落位后就不会再把机位拉回、画面不跳。 */
const _polarDir = new THREE.Vector3()
function clampPolarToLimit(dir: THREE.Vector3): THREE.Vector3 {
  const cosLimit = Math.cos(currentPoleLimit())
  if (Math.abs(dir.y) <= cosLimit) return dir
  _polarDir.set(dir.x, Math.max(-cosLimit, Math.min(cosLimit, dir.y)), dir.z)
  const h = Math.hypot(_polarDir.x, _polarDir.z)
  const wantH = Math.sqrt(Math.max(0, 1 - _polarDir.y * _polarDir.y))
  if (h > 1e-8) { _polarDir.x *= wantH / h; _polarDir.z *= wantH / h }
  else _polarDir.x = wantH
  return dir.copy(_polarDir).normalize()
}

/** 环绕浏览：把 OrbitControls 的旋转焦点切到当前选中卫星，之后右键拖动即「以该卫星为焦点」
 *  的球面环绕 —— 卫星（目标）与焦点都不动，只有相机沿球面绕它转，可 360° 环视 / 俯仰 / 侧视。
 *  拖动期间 OrbitControls 的 start 事件会冻结虚拟时间，卫星静止，旋转轴心稳定不漂移。
 *  滚轮缩放照常可用：焦点切到卫星后同步放宽 minDistance（见 SATELLITE_FOCUS_MIN_DIST），
 *  否则相机到卫星的距离会被「绕地心不穿地球」的 EARTH_ORBIT_MIN_DIST 卡住，滚轮拉近无效。 */
function focusOrbitOnSel() {
  const anchor = g.selAnchor
  if (!anchor) return
  focusOrbitOnPoint(anchor.position)
}

/** 把环绕焦点切到任意场景点位（热力交会点等）：放宽最小距离 + 提高缩放速度，与「聚焦卫星」同一套口径
 *  （见 focusOrbitOnSel），只是焦点不是一个选中卫星。需在镜头飞行落位后调用（见 camFly.focusMode）。 */
function focusOrbitOnPoint(pos: THREE.Vector3) {
  const controls = g.controls
  if (!controls) return
  controls.target.copy(pos)
  controls.minDistance = SATELLITE_FOCUS_MIN_DIST
  controls.zoomSpeed = SATELLITE_FOCUS_ZOOM_SPEED
  // 极角限位不变（相机 up 仍为世界 +Y，见 applyOrbitPolarLimits）
  applyOrbitPolarLimits()
}

/** 把环绕焦点切回地心（相机位置不动、不硬跳）并恢复「绕地心」的缩放口径；若正在飞往某目标的途中则取消该次飞行。
 *  用于镜头不再需要聚焦在空中目标的时候：取消选中交会事件、退出热力模式等 ——
 *  否则滚轮缩放会绕着天上那个交会点进行，回到卫星云视图后观感不对。 */
function resetOrbitFocusToEarth() {
  camFly.active = false
  if (!g.controls) return
  g.controls.target.set(0, 0, 0)
  restoreEarthOrbitLimits()
}

/** 焦点切回地心（取消选中 / 飞行到地面目标）时恢复「绕地心」的最小距离与缩放速度，
 *  否则绕地心旋转时相机会贴着地心缩放，观感异常。 */
function restoreEarthOrbitLimits() {
  if (!g.controls) return
  g.controls.minDistance = EARTH_ORBIT_MIN_DIST
  g.controls.zoomSpeed = EARTH_ORBIT_ZOOM_SPEED
  // 焦点回到地心 → 极角限位保持同一套口径（见 applyOrbitPolarLimits）
  applyOrbitPolarLimits()
}

/** 屏蔽画布右键菜单，否则右键拖动环绕时每按一次都会弹出浏览器上下文菜单 */
function onContextMenu(ev: MouseEvent) {
  ev.preventDefault()
}

function onPointerDown(ev: PointerEvent) {
  if (ev.button === 2) { focusOrbitOnSel(); return }
  if (ev.button !== 0) return
  pressDown = true
  pressX = ev.clientX
  pressY = ev.clientY
  pressTime = performance.now()
}

function onPointerUp(ev: PointerEvent) {
  if (!pressDown || ev.button !== 0) return
  pressDown = false
  const dt = performance.now() - pressTime
  const dx = ev.clientX - pressX
  const dy = ev.clientY - pressY
  if (dt > CLICK_MS || dx * dx + dy * dy > CLICK_PX * CLICK_PX) return
  onCanvasClick(ev)
}

/* ============================================================
 * 移动端环绕轮盘（桌面端右键的替代）
 * 安卓 / 移动端没有鼠标右键，focusOrbitOnSel() 那条「右键拖动 = 绕选中目标环绕浏览」的入口无法触发。
 * 这里在命中拾取（hasSel）后于画布右下角浮出一枚半透明圆形摇杆：按住拖动即以选中目标为焦点做球面旋转
 * （水平拖动 = 绕极轴环视，垂直拖动 = 俯仰），等价桌面端右键按住拖动；取消选中 / 点空白即隐藏。
 * 拖动期间置 userInteracting=true 冻结虚拟时间：目标静止，旋转轴心不漂移（与桌面右键同口径）。
 * ============================================================ */
/** 摇杆把手最大偏移（px）：控制在轮盘半径内，避免拖出边界 */
const WHEEL_MAX_KNOB = 24
const wheel = reactive({ dragging: false, kx: 0, ky: 0 })
let wheelPointerId: number | null = null
let wheelLastX = 0
let wheelLastY = 0

/** 移动端轮盘球坐标复用的中间量（按 up 取球坐标，避免每帧新建） */
const _wheelQuat = new THREE.Quaternion()
const _wheelUp = new THREE.Vector3()
const _wheelOffset = new THREE.Vector3()

/** 以选中目标为焦点，按拖动像素量旋转相机（球面环绕）。灵敏度与 OrbitControls 拖拽一致（2π × ORBIT_ROTATE_SPEED / 视口高）。 */
function orbitAroundSel(dxPx: number, dyPx: number) {
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) return
  // 焦点 / 最小距离口径与桌面右键一致（选中后镜头跟随会把 target 同步到目标本帧位置，这里再兜一次）
  focusOrbitOnSel()
  const k = (Math.PI * 2 * ORBIT_ROTATE_SPEED) / Math.max(container.value?.clientHeight || 800, 200)
  // 相机 up 可能是「焦点当地天顶」而非世界 Y，球坐标必须按 up 取：
  // 先把偏移矢量转到「up 对齐 Y」的坐标系里，水平/垂直拖动与限位都在该坐标系内完成，再转回世界
  // （OrbitControls 内部对 object.up 也是同一做法）。
  const q = _wheelQuat.setFromUnitVectors(_wheelUp.copy(cam.up).normalize(), WORLD_UP)
  const offset = _wheelOffset.copy(cam.position).sub(controls.target).applyQuaternion(q)
  const sph = new THREE.Spherical().setFromVector3(offset)
  sph.theta -= dxPx * k
  sph.phi -= dyPx * k
  // 极角限位与桌面端共用 controls 上的取值（焦点在卫星时上限为当地地平线，见 ORBIT_POLE_LIMIT）
  sph.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, sph.phi))
  sph.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, sph.radius))
  offset.setFromSpherical(sph)
  q.invert()
  offset.applyQuaternion(q)
  cam.position.copy(controls.target).add(offset)
  cam.lookAt(controls.target)
  // OrbitControls.update() 每帧从相机位置反推球坐标，故直接写位置后调用它即可同步内部状态
  controls.update()
}

function onWheelDown(ev: PointerEvent) {
  if (!isMobile.value || !hasSel.value) return
  ev.preventDefault()
  ev.stopPropagation()
  wheel.dragging = true
  wheelPointerId = ev.pointerId
  wheelLastX = ev.clientX
  wheelLastY = ev.clientY
  g.userInteracting = true
  ;(ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId)
}

function onWheelMove(ev: PointerEvent) {
  if (!wheel.dragging || ev.pointerId !== wheelPointerId) return
  ev.preventDefault()
  ev.stopPropagation()
  const dx = ev.clientX - wheelLastX
  const dy = ev.clientY - wheelLastY
  wheelLastX = ev.clientX
  wheelLastY = ev.clientY
  // 把手跟手位移（限幅在轮盘半径内），仅作视觉反馈
  const kx = wheel.kx + dx
  const ky = wheel.ky + dy
  const len = Math.hypot(kx, ky)
  const s = len > WHEEL_MAX_KNOB ? WHEEL_MAX_KNOB / len : 1
  wheel.kx = kx * s
  wheel.ky = ky * s
  orbitAroundSel(dx, dy)
}

function onWheelUp(ev: PointerEvent) {
  if (!wheel.dragging || ev.pointerId !== wheelPointerId) return
  wheel.dragging = false
  wheelPointerId = null
  wheel.kx = 0
  wheel.ky = 0
  g.userInteracting = false
}

/* ============================================================
 * 碰撞热力：标记构建 / 模式切换 / 事件拾取
 * ============================================================ */
function heatMidPoint(e: CdmHeatEvent): THREE.Vector3 {
  return eciToScene(e.mid_x, e.mid_y, e.mid_z)
}

/** 柔边光斑 vertex：按每顶点尺寸 aSize（世界单位）＋距离衰减算出屏幕点大小，颜色传给片元。
 *  使用 billboard 柔光而非实心球体，避免热力在地球表面叠加成「实体瘤」的立体观感。 */
const HEAT_GLOW_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vWorld;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 0.001);
    gl_PointSize = min(aSize * uScale / d, 320.0);
    gl_Position = projectionMatrix * mv;
  }
`
/** 地球背面遮挡系数：相机→该点的线段若穿过地球球体（半径 1），说明光斑在球背面，淡出为 0。
 *  取线段到地心的最小距离，在 0.96~1.02 之间平滑过渡，避免球缘出现硬边。 */
const HEAT_OCCLUDE_GLSL = /* glsl */ `
  float earthOcc(vec3 world) {
    vec3 d = world - cameraPosition;
    float t = clamp(-dot(cameraPosition, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
    float minD = length(cameraPosition + d * t);
    return smoothstep(0.96, 1.02, minD);
  }
`
/** 柔边光斑 fragment（加法混合）：中心亮、外围柔；预乘 vColor*a 让边缘叠加自然增亮。
 *  用于 CDM 热力「逐事件柔光云」。 */
const HEAT_GLOW_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vWorld;
  ${HEAT_OCCLUDE_GLSL}
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float core = max(0.0, 1.0 - d);
    float a = core * core * vAlpha * earthOcc(vWorld);
    gl_FragColor = vec4(vColor * a, a);
  }
`
/** 柔边光斑 vertex（普通混合）：多一个每顶点不透明度 aAlpha，供宏观聚合热力斑按格内事件数控制浓淡。 */
const HEAT_SOFT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vWorld;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 0.001);
    gl_PointSize = min(aSize * uScale / d, 320.0);
    gl_Position = projectionMatrix * mv;
  }
`
/** 柔边光斑 fragment（普通混合）：颜色不预乘，叠加时按 alpha 正常混合，避免多片热力斑加成一坨白。
 *  用于交会热力「宏观聚合热力斑」。 */
const HEAT_SOFT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vWorld;
  ${HEAT_OCCLUDE_GLSL}
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    float core = max(0.0, 1.0 - d);
    float a = core * core * vAlpha * earthOcc(vWorld);
    gl_FragColor = vec4(vColor, a);
  }
`
let _heatScaleV = new THREE.Vector2()
/** 换算世界尺寸 → 屏幕像素：viewportH / (2·tan(fov/2))，供柔光点 sizeAttenuation 使用 */
function heatPixelScale(): number {
  const r = g.renderer, cam = g.camera
  if (!r || !cam) return 300
  r.getDrawingBufferSize(_heatScaleV)
  const fov = cam.fov || 50
  return _heatScaleV.y / (2 * Math.tan((fov * Math.PI) / 360))
}
function makeHeatGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: heatPixelScale() } },
    vertexShader: HEAT_GLOW_VERT,
    fragmentShader: HEAT_GLOW_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  })
}
/** 普通混合柔边材质：颜色不预乘、逐顶点不透明度，用于交会热力的宏观聚合热力斑（与 CDM 的加法柔光云区分） */
function makeHeatSoftMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: heatPixelScale() } },
    vertexShader: HEAT_SOFT_VERT,
    fragmentShader: HEAT_SOFT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending
  })
}

/** 事件超过上限时按当前格边抽稀：同一格只保留风险最高的代表事件。
 *  用于官方 CDM（逐事件柔光云）——事件量过大时既保热点又不让点云粒子上限爆掉。 */
function downsampleHeat(evs: CdmHeatEvent[], max = HEAT_MAX_EVENTS): CdmHeatEvent[] {
  if (evs.length <= max) return evs
  const inv = 1 / heatCell.value
  const best = new Map<string, CdmHeatEvent>()
  for (const e of evs) {
    const mx = e.mid_x, my = e.mid_y, mz = e.mid_z
    if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mz)) continue
    const key = `${Math.floor(mx * inv)},${Math.floor(my * inv)},${Math.floor(mz * inv)}`
    const cur = best.get(key)
    if (!cur || (e.risk ?? 0) > (cur.risk ?? 0)) best.set(key, e)
  }
  const reps = [...best.values()]
  if (reps.length > max) {
    reps.sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0))
    reps.length = max
  }
  return reps
}

/** 依据当前热力过滤列表重建事件标记，全量替换。
 *  三个来源走两套渲染逻辑，视觉上必须能区分：
 *   · CDM 热力（spacetrack）：逐事件柔光云（加法混合）——事件量小，叠加体现单次交会强弱；
 *   · 交会热力（local）/ 交会分析热力（cri）：宏观聚合热力斑（普通混合）——本地事件上万条，先按立方网格聚合再着色。
 *  三者共用「点选事件后用 buildHeatSelOrbits 展示两颗卫星完整轨道」的交互。
 *  着色 / 风险权重由后端按来源口径下发（事件自带 color / risk），三个口径各自忠实、不互相冒充。 */
function buildHeatMarkers() {
  const scene = g.scene
  if (!scene) return
  clearHeatMarkers()
  const evs = heatFiltered.value
  // 注意：时间为空 / 事件被筛选掉时不清理 heatSel —— 右侧事件列表的选中与热力窗口彼此独立，
  // 清掉会导致「切回有数据的时间窗后选中态与同簇高亮丢失、必须重新点一次」（列表行仍高亮）。
  if (!evs.length) return
  // 官方 CDM 逐事件出点：超过上限时按格边抽稀（保留每格最高风险），其余来源本身已按格聚合
  const renderEvs = heatSource.value === 'spacetrack' ? downsampleHeat(evs) : evs
  const group = new THREE.Group()
  if (heatSource.value === 'spacetrack') buildEventHeat(group, renderEvs)
  else buildAggregatedHeat(group, renderEvs)

  g.heatGroup = group
  group.visible = heatMode.value
  scene.add(group)

  // 重建后重新套用「同簇高亮」（过滤/格边变化后标记是新几何，旧的淡出状态需重算）
  applyHeatDim()
}

/** CDM 热力（官方 CDM，事件量小）：逐事件一簇柔光云（加法混合）。
 *  去除两端 A→B 短线（省去杂乱），改为点选事件后用 buildHeatSelOrbits 展示两颗卫星的完整轨道。 */
function buildEventHeat(group: THREE.Group, evs: CdmHeatEvent[]) {
  const c = new THREE.Color()

  // ① 事件中点核心光斑（billboard 柔光点，逐事件一顶点，颜色按碰撞概率，作为可拾取锚点）
  //   size 略大于云粒子，中心清晰可点选；用柔边 shader 而非实心点，避免突兀的硬圆点
  const pos = new Float32Array(evs.length * 3)
  const col = new Float32Array(evs.length * 3)
  const coreSize = new Float32Array(evs.length)
  for (let i = 0; i < evs.length; i++) {
    const p = heatMidPoint(evs[i])
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
    c.set(heatColorOf(evs[i]))
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    coreSize[i] = 0.05 * (0.6 + evs[i].risk * 1.2)
  }
  const pgeom = new THREE.BufferGeometry()
  pgeom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
  pgeom.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  pgeom.setAttribute('aSize', new THREE.BufferAttribute(coreSize, 1))
  // aAlpha：选中事件时「同簇高亮、其它淡出」（见 applyHeatDim）
  const coreAlpha = new Float32Array(evs.length).fill(1)
  pgeom.setAttribute('aAlpha', new THREE.BufferAttribute(coreAlpha, 1).setUsage(THREE.DynamicDrawUsage))
  ;(pgeom.userData as { heatDim?: HeatDimMeta }).heatDim = { base: coreAlpha.slice(), ids: evs.map((e) => e.id) }
  const pts = new THREE.Points(pgeom, makeHeatGlowMaterial())
  pts.frustumCulled = false
  group.add(pts)
  g.heatPoints = pts

  // ② 云状热力区域（柔边光斑 Points，加法混合）：逐事件一簇簇内粒子中心偏置 → 中心更亮；
  //    颜色/半径按碰撞概率，多个事件重叠叠加形成红色/黄色热云，体现「区域内颜色/频率」。
  // 全量（含历史）时事件上千，适当降低每事件云粒子数，平衡渲染性能与热云观感
  const CLOUD_PER_EVENT = evs.length > 800 ? 8 : 14
  const CLOUD_BASE_R = 0.022
  const total = evs.length * CLOUD_PER_EVENT
  const cpos = new Float32Array(total * 3)
  const ccol = new Float32Array(total * 3)
  const csize = new Float32Array(total)
  const cids: number[] = new Array(total)
  let idx = 0
  for (let i = 0; i < evs.length; i++) {
    const evt = evs[i]
    const mid = heatMidPoint(evt)
    // 局部交会密度（同一片「碰撞云」内事件数）已由后端网格分桶统计并下发（dens_boost，含 log2 换算）；
    // 事件越密集热力云越大，体现「频繁交会区域更醒目、哪怕单次交会也给一个热力点」的需求。
    const R = CLOUD_BASE_R * (0.6 + evt.risk * 1.9) * evt.dens_boost
    const cc = c.set(heatColorOf(evt))
    for (let j = 0; j < CLOUD_PER_EVENT; j++) {
      const rr = R * Math.cbrt(Math.random()) // 中心偏置（内密外疏 → 中心更亮）
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      _off.set(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)).multiplyScalar(rr)
      _pos.copy(mid).add(_off)
      cpos[idx * 3] = _pos.x; cpos[idx * 3 + 1] = _pos.y; cpos[idx * 3 + 2] = _pos.z
      ccol[idx * 3] = cc.r; ccol[idx * 3 + 1] = cc.g; ccol[idx * 3 + 2] = cc.b
      csize[idx] = R * 1.1 * (0.5 + Math.random() * 0.6)
      cids[idx] = evt.id
      idx++
    }
  }
  const cgeom = new THREE.BufferGeometry()
  cgeom.setAttribute('position', new THREE.BufferAttribute(cpos, 3).setUsage(THREE.DynamicDrawUsage))
  cgeom.setAttribute('aColor', new THREE.BufferAttribute(ccol, 3))
  cgeom.setAttribute('aSize', new THREE.BufferAttribute(csize, 1))
  const cloudAlpha = new Float32Array(total).fill(1)
  cgeom.setAttribute('aAlpha', new THREE.BufferAttribute(cloudAlpha, 1).setUsage(THREE.DynamicDrawUsage))
  ;(cgeom.userData as { heatDim?: HeatDimMeta }).heatDim = { base: cloudAlpha.slice(), ids: cids }
  const clouds = new THREE.Points(cgeom, makeHeatGlowMaterial())
  clouds.frustumCulled = false
  group.add(clouds)
  g.heatClouds = clouds
}

/** 宏观聚合网格边长由 scene.ts 的 heatCell 提供（默认 0.15 ≈ 950km，面板可切 0.05/0.15/0.30）。
 *  交会热力（本地初筛）的「高危 + 警告」通常上万条，逐事件出粒子在加法混合下必然叠成一坨白；
 *  这里按立方网格把邻近事件聚成一个热力斑，宏观层面体现热力分布即可。
 *  超级事件抽稀上限：超过该数量时按格边取「格内风险最高」的代表点，避免逐事件云把 GPU 压满。 */
const HEAT_MAX_EVENTS = 2000

/** 热力标记「同簇高亮」辅助数据（挂在 BufferGeometry.userData 上）：
 *  - base：逐顶点原始不透明度（聚合斑按格内事件数不同，淡出时按比例缩放，不能直接写常量）；
 *  - ids：逐顶点事件 id（逐事件模式，直接用 id 判断是否同簇）；
 *  - centers：逐顶点场景中点 xyz（网格聚合模式，一个斑代表一格，用距离判断是否同簇）。 */
interface HeatDimMeta {
  base: Float32Array
  ids?: number[]
  centers?: Float32Array
}
/** 热力斑基准世界尺寸（格内 1 条时）与上限（放大后约为 2 倍屏幕半径，见 shader） */
const HEAT_BLOB_BASE = 0.06
const HEAT_BLOB_MAX = 0.34
/** 网格聚合格：事件数 / 风险加权色累加 / 中点累加 */
interface HeatCell {
  n: number
  w: number
  r: number
  g: number
  b: number
  x: number
  y: number
  z: number
}

/** 交会热力（本地初筛）：立方网格聚合 → 每格一个热力斑（普通混合，颜色不预乘，叠加不会泛白）。
 *  斑心取格内中点均值；颜色按格内风险加权（警告橙 ↔ 高危红随风险占比自然过渡，与图例两端一致）；
 *  大小与不透明度按格内事件数对数增长（避免个别超密格吃掉整个视野）；再叠一层同色加法小核点出热点中心。 */
function buildAggregatedHeat(group: THREE.Group, evs: CdmHeatEvent[]) {
  const cells = new Map<string, HeatCell>()
  const inv = 1 / heatCell.value
  const tc = new THREE.Color()
  for (const e of evs) {
    const mx = e.mid_x, my = e.mid_y, mz = e.mid_z
    if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mz)) continue
    const key = `${Math.floor(mx * inv)},${Math.floor(my * inv)},${Math.floor(mz * inv)}`
    let cell = cells.get(key)
    if (!cell) { cell = { n: 0, w: 0, r: 0, g: 0, b: 0, x: 0, y: 0, z: 0 }; cells.set(key, cell) }
    // 每事件至少给 0.15 基础权重，避免低风险事件的颜色与计数被同格高风险完全吞掉
    const w = 0.15 + (e.risk || 0)
    tc.set(heatColorOf(e))
    cell.n++
    cell.w += w
    cell.r += tc.r * w; cell.g += tc.g * w; cell.b += tc.b * w
    cell.x += mx; cell.y += my; cell.z += mz
  }
  const total = cells.size
  if (!total) return

  const bpos = new Float32Array(total * 3)
  const bcol = new Float32Array(total * 3)
  const bsize = new Float32Array(total)
  const balpha = new Float32Array(total)
  const kpos = new Float32Array(total * 3)
  const kcol = new Float32Array(total * 3)
  const ksize = new Float32Array(total)
  // 逐格场景中点：选中事件时按距离判断「同簇」，用于其它格淡出（见 applyHeatDim）
  const centers = new Float32Array(total * 3)

  let i = 0
  for (const cell of cells.values()) {
    const p = eciToScene(cell.x / cell.n, cell.y / cell.n, cell.z / cell.n)
    centers[i * 3] = p.x; centers[i * 3 + 1] = p.y; centers[i * 3 + 2] = p.z
    const cc = tc.setRGB(cell.r / cell.w, cell.g / cell.w, cell.b / cell.w)
    const grow = Math.log2(1 + cell.n) // 0(1 条) → 6.6(100 条)
    const R = Math.min(HEAT_BLOB_MAX, HEAT_BLOB_BASE * (1 + grow))
    bpos[i * 3] = p.x; bpos[i * 3 + 1] = p.y; bpos[i * 3 + 2] = p.z
    bcol[i * 3] = cc.r; bcol[i * 3 + 1] = cc.g; bcol[i * 3 + 2] = cc.b
    bsize[i] = R
    balpha[i] = Math.min(0.85, 0.3 + grow * 0.1)
    kpos[i * 3] = p.x; kpos[i * 3 + 1] = p.y; kpos[i * 3 + 2] = p.z
    kcol[i * 3] = cc.r; kcol[i * 3 + 1] = cc.g; kcol[i * 3 + 2] = cc.b
    ksize[i] = R * 0.45
    i++
  }

  const bgeom = new THREE.BufferGeometry()
  bgeom.setAttribute('position', new THREE.BufferAttribute(bpos, 3).setUsage(THREE.DynamicDrawUsage))
  bgeom.setAttribute('aColor', new THREE.BufferAttribute(bcol, 3))
  bgeom.setAttribute('aSize', new THREE.BufferAttribute(bsize, 1))
  bgeom.setAttribute('aAlpha', new THREE.BufferAttribute(balpha, 1))
  ;(bgeom.userData as { heatDim?: HeatDimMeta }).heatDim = { base: balpha.slice(), centers }
  const blobs = new THREE.Points(bgeom, makeHeatSoftMaterial())
  blobs.frustumCulled = false
  group.add(blobs)
  g.heatClouds = blobs

  const kgeom = new THREE.BufferGeometry()
  kgeom.setAttribute('position', new THREE.BufferAttribute(kpos, 3).setUsage(THREE.DynamicDrawUsage))
  kgeom.setAttribute('aColor', new THREE.BufferAttribute(kcol, 3))
  kgeom.setAttribute('aSize', new THREE.BufferAttribute(ksize, 1))
  const coreAlpha = new Float32Array(total).fill(1)
  kgeom.setAttribute('aAlpha', new THREE.BufferAttribute(coreAlpha, 1).setUsage(THREE.DynamicDrawUsage))
  ;(kgeom.userData as { heatDim?: HeatDimMeta }).heatDim = { base: coreAlpha.slice(), centers }
  const cores = new THREE.Points(kgeom, makeHeatGlowMaterial())
  cores.frustumCulled = false
  group.add(cores)
  g.heatPoints = cores
}

/** 销毁全部热力标记（组 + 中点核心点 + 云 + 选中轨道组），回收 GPU 资源 */
function clearHeatMarkers() {
  const grp = g.heatGroup
  if (grp) {
    g.scene?.remove(grp)
    disposeGroup(grp)
  }
  g.heatGroup = null
  g.heatPoints = null
  g.heatClouds = null
  g.heatLines = null
  clearHeatSelOrbits()
}

/** 绘制交会目标（两星轨道线 + TCA 目标模型）所需的最小信息：
 *  点击热力云事件（CdmHeatEvent）与点击「本批次交会数据」列表项（ConjEvent）都满足该结构，
 *  位置一律由前端按 TLE 在 TCA 用 SGP4 自行传播，不依赖后端下发坐标。 */
interface HeatPairRef {
  norad_a: number
  norad_b: number
  tca: string
}

/** 选中交会事件的构建序号：每次构建 / 清除都自增，用于丢弃 await 期间已过期的轨道线与目标模型
 *  （切换事件 / 取消选中 / 退出热力后，异步加载完成的模型不得再挂进场景） */
let heatSelSeq = 0

/** 最近一次请求绘制 / 正在绘制的交会目标：异步构建完成后用它校验「仍是当前请求」，否则丢弃结果 */
let heatDrawRef: HeatPairRef | null = null

/** 移除选中事件的 A/B 两星轨道线与 TCA 目标模型（取消选中 / 清除标记 / 退出热力时调用） */
function clearHeatSelOrbits() {
  heatSelSeq++
  heatDrawRef = null
  const grp = g.heatSelOrbitGroup
  if (grp) {
    g.scene?.remove(grp)
    disposeGroup(grp)
  }
  g.heatSelOrbitGroup = null
  g.heatSatTargets = []
}

/** 聚合空间半径（场景单位）：同一片「碰撞云」（同一对卫星多次交会 / 邻近卫星对交会）的中点距离阈值 */
const HEAT_CLUSTER_R = 0.07
/** 依据被点击事件，聚合该「碰撞云」覆盖区域内的全部事件（中点距离 ≤ HEAT_CLUSTER_R），用于右侧整片云碰撞列表 */
function clusterHeatEvents(base: CdmHeatEvent): CdmHeatEvent[] {
  const bm = heatMidPoint(base)
  const res: CdmHeatEvent[] = []
  for (const e of heatFiltered.value) {
    if (heatMidPoint(e).distanceTo(bm) <= HEAT_CLUSTER_R) res.push(e)
  }
  return res
}

/** 选中事件时的「同簇高亮」：同簇顶点保持原不透明度，其余淡出到 HEAT_DIM。
 *  逐事件模式按事件 id 命中；网格聚合模式按斑心到选中点距离 ≤ HEAT_CLUSTER_R 判定同簇。
 *  只改 aAlpha 属性，不重建几何 —— 选中/取消选中都不会让热力云随机粒子重排（无闪动）。 */
const HEAT_DIM = 0.16
function applyHeatDim() {
  const sel = heatSelList.value
  const has = sel.length > 0
  const ids = has ? new Set(sel.map((e) => e.id)) : null
  const mids = has ? sel.map((e) => heatMidPoint(e)) : []
  const r2 = HEAT_CLUSTER_R * HEAT_CLUSTER_R
  for (const pts of [g.heatPoints, g.heatClouds]) {
    const geom = pts?.geometry
    const meta = (geom?.userData as { heatDim?: HeatDimMeta } | undefined)?.heatDim
    if (!geom || !meta) continue
    const attr = geom.getAttribute('aAlpha') as THREE.BufferAttribute | undefined
    if (!attr) continue
    const arr = attr.array as Float32Array
    if (!has) {
      arr.set(meta.base)
    } else if (meta.ids) {
      for (let i = 0; i < arr.length; i++) arr[i] = meta.base[i] * (ids!.has(meta.ids[i]) ? 1 : HEAT_DIM)
    } else if (meta.centers) {
      for (let i = 0; i < arr.length; i++) {
        const x = meta.centers[i * 3], y = meta.centers[i * 3 + 1], z = meta.centers[i * 3 + 2]
        let keep = false
        for (const m of mids) {
          const dx = x - m.x, dy = y - m.y, dz = z - m.z
          if (dx * dx + dy * dy + dz * dz <= r2) { keep = true; break }
        }
        arr[i] = meta.base[i] * (keep ? 1 : HEAT_DIM)
      }
    }
    attr.needsUpdate = true
  }
}

/** 目标模型（A/B 两星在 TCA 时刻的真实卫星模型）相对「卫星云模型」的放大倍数：
 *  云里模型归一化到 MODEL_MAX_DIM（远看形成星云），选中的交会目标需要在地球尺度下清晰可辨。
 *  相对倍数，故整体尺寸口径（MODEL_MAX_DIM）调整时无需跟着改。 */
const HEAT_TARGET_MODEL_SCALE = 4.5

/** 交会目标模型：按该星的型号取 high 档模型（交会目标在近处显示，直接上最精细的一档）。
 *  几何复用统一的 geomCache，与卫星云同 URL 时不再重复下载 / 解码。 */
async function loadHeatModel(det?: { object_type?: string; object_name?: string; cons?: string[] }) {
  const model = resolveModelKey(det || {})
  return loadGeom(modelUrlOf(model, 'high'), MODEL_COARSE[model] || 'UNKNOWN', model)
}

/** 加载一颗交会目标卫星模型并高亮挂到选中组内的 TCA 位置（A 青蓝 / B 洋红，与轨道线同色系）。
 *  velScene 为该星 TCA 时刻的场景速度：用来定姿（机头垂直地表，口径见 orbitBasis），
 *  缺速度时 orbitBasis 会自行兜参考轴，机头同样保持垂直于地表。
 *  seq 为本次构建序号：await 期间若已切换事件 / 取消选中（序号自增），则丢弃结果，避免模型残留。 */
async function addHeatTargetModel(group: THREE.Group, det: { object_type?: string; object_name?: string; cons?: string[] } | undefined, color: number, pos: THREE.Vector3, seq: number, velScene?: THREE.Vector3 | null) {
  const gm = await loadHeatModel(det)
  if (!gm) return
  if (seq !== heatSelSeq) return
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.45,
    roughness: 0.3,
    emissive: color,
    emissiveIntensity: 0.85
  })
  const mesh = new THREE.Mesh(gm.geom.clone(), mat)
  mesh.position.copy(pos)
  mesh.scale.setScalar(HEAT_TARGET_MODEL_SCALE)
  // 定姿：机头（本地 +Z）对齐当地天顶、机身 +Y 对齐飞行方向 —— 与卫星云 / 过境模型同一口径（见 orbitBasis）。
  // 这里是一次性静态模型（TCA 定格），不逐帧重算；漏掉这一步模型就是世界坐标下的默认朝向，
  // 机头会指向某个固定的惯性方向，看起来「没垂直于地表」。
  orbitAttitude(pos, velScene || _zeroVel, mesh.quaternion)
  group.add(mesh)
}

/** 构建选中事件的两星轨道线 + 两颗目标模型（TCA 时刻的真实卫星模型）：
 *  分别取双方 TLE，按各自轨道周期采样一整圈（与 buildOrbit 一致）画出轨道线；
 *  再用同一 TLE 在 TCA 时刻传播出位置，把该卫星模型放在轨道上（与轨道线同源，必定落在所画轨道）。
 *  A 青蓝、B 洋红；取消选中 / 切换事件时由 clearHeatSelOrbits 移除。 */
async function buildHeatSelOrbits(evt: HeatPairRef) {
  clearHeatSelOrbits()
  if (!evt) return
  const scene = g.scene
  if (!scene) return
  heatDrawRef = evt
  const seq = ++heatSelSeq
  // 交会事件（CDM / 本地初筛 / 交会分析）的两端 NORAD 属于国际库编目，
  // 取详情固定用国际库（不跟随卫星列表的数据源切换），否则切到 AOE 库时会取不到该目标
  const [ad, bd] = await Promise.all([
    getSatDetailPublic(evt.norad_a),
    getSatDetailPublic(evt.norad_b)
  ])
  if (seq !== heatSelSeq) return
  const sides = [
    { det: ad, norad: evt.norad_a, hex: '#37c2ff', color: 0x37c2ff },
    { det: bd, norad: evt.norad_b, hex: '#ff6b9d', color: 0xff6b9d }
  ]
  const tcaMs = parseEpoch(evt.tca)
  const group = new THREE.Group()
  const targets: { norad: number; eci: THREE.Vector3 }[] = []
  const modelJobs: Promise<void>[] = []
  for (const s of sides) {
    const l1 = s.det?.tle_line1, l2 = s.det?.tle_line2
    if (!l1 || !l2) continue
    let recr: ReturnType<typeof twoline2satrec>
    try { recr = twoline2satrec(l1, l2) } catch { continue }
    const periodMs = (recr.no ? (Math.PI * 2) / recr.no : 100) * 60000
    // 轨道环以「TCA 时刻」为中心采样一整圈：TCA 与 TLE 历元常相隔数天，
    // 期间 J2 交点进动会使轨道面偏转（实测数十~数百公里），按历元采样会让环与模型错开；
    // 以 TCA 为中心则 TCA 处的模型必位于所画环上。
    const t0 = tcaMs - periodMs / 2
    const steps = 384
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= steps; i++) {
      const pv = propagate(recr, new Date(t0 + (i / steps) * periodMs))
      if (pv?.position) pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z))
    }
    if (!pts.length) continue
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(s.hex), transparent: true, opacity: 0.75 })
    ))
    // TCA 时刻的位置与速度：目标模型落点 + 定姿依据
    // （与轨道线同源 TLE 传播，不依赖后端下发坐标，避免坐标缺失时模型不绘制）
    let tcaEci: { x: number; y: number; z: number } | null = null
    let tcaVel: { x: number; y: number; z: number } | null = null
    try {
      const pv = propagate(recr, new Date(tcaMs))
      if (pv?.position) tcaEci = { x: pv.position.x, y: pv.position.y, z: pv.position.z }
      if (pv?.velocity) tcaVel = { x: pv.velocity.x, y: pv.velocity.y, z: pv.velocity.z }
    } catch { /* 单点传播失败则只画轨道线 */ }
    if (!tcaEci) continue
    targets.push({ norad: s.norad, eci: new THREE.Vector3(tcaEci.x, tcaEci.y, tcaEci.z) })
    modelJobs.push(addHeatTargetModel(
      group,
      s.det || undefined,
      s.color,
      eciToScene(tcaEci.x, tcaEci.y, tcaEci.z),
      seq,
      tcaVel ? eciToScene(tcaVel.x, tcaVel.y, tcaVel.z) : null
    ))
  }
  if (!group.children.length) { disposeGroup(group); return }
  // 以下为 async 构建，await 期间可能已被还原/切换事件/退出热力取消：
  // 若当前请求已不是本次交会目标、或已退出热力模式，则丢弃刚构建的组，避免轨道线永久残留
  if (seq !== heatSelSeq || heatDrawRef !== evt || !heatMode.value) { disposeGroup(group); return }
  g.heatSelOrbitGroup = group
  g.heatSatTargets = targets
  scene.add(group)
  // 列表点选的事件没有 mid 坐标时，交会点要等两端 ECI 就绪（就在这里）才能算出来，故飞行推迟到此刻（见 selectHeatPair）
  if (pendingHeatFly) { pendingHeatFly = false; flyToHeatTargetsMid() }
  // 轨道线先上屏，模型并行加载后补挂（过期结果由 addHeatTargetModel 内的 seq 校验丢弃）
  await Promise.all(modelJobs)
}

/** 「列表点选、但事件没有 mid 坐标」时置真：等两星轨道构建完成（两端 TCA 位置就绪）后再取中点飞过去 */
let pendingHeatFly = false

/** 用当前选中事件两端的 ECI 位置（g.heatSatTargets，由各自 TLE 在 TCA 传播得到）取中点，飞到该交会位置 */
function flyToHeatTargetsMid() {
  const list = g.heatSatTargets
  if (!list.length) return
  const mid = new THREE.Vector3()
  for (const t of list) mid.add(eciToScene(t.eci.x, t.eci.y, t.eci.z))
  mid.multiplyScalar(1 / list.length)
  flyToPoint(mid, 'point')
}

/** 由左侧热力列表面板点击某一对触发（三个来源同一路径）：效果与「点击热力云团」完全一致 ——
 *  ① 选中该事件（watch(heatSel) 随之绘制两端误差椭球 + 两星轨道线 + TCA 目标模型）
 *  ② 右侧展开事件详情，并列出该事件所属云团的碰撞列表
 *  ③ 镜头平滑飞到该事件的交会位置（两端 TCA 中点），落位后以交会点为环绕焦点
 *  列表项只有 norad 对 + TCA（无坐标）：先在已加载的热力事件里按「norad 对 + TCA」找完整事件
 *  （热力事件带 mid_x/y/z 等渲染与配色字段，直接可用）；找不到（列表筛选出了不进热力图的事件）
 *  就用列表项兜底构造，此时交会点改由两端 TLE 在 TCA 传播后取中点得到，飞行顺延到轨道构建完成。 */
async function selectHeatPair(pair: HeatPairRef) {
  const tcaMs = parseEpoch(pair.tca)
  const hit = heatFiltered.value.find(
    (e) => e.norad_a === pair.norad_a && e.norad_b === pair.norad_b && parseEpoch(e.tca) === tcaMs
  )
  const evt: CdmHeatEvent = hit || {
    id: 0, cdm_id: '', tca: pair.tca,
    norad_a: pair.norad_a, norad_b: pair.norad_b,
    name_a: `NORAD ${pair.norad_a}`, name_b: `NORAD ${pair.norad_b}`,
    miss_distance_km: 0, rel_speed_km_per_s: 0, collision_probability: 0, hard_body_radius_m: 0,
    a_x: 0, a_y: 0, a_z: 0, b_x: 0, b_y: 0, b_z: 0, mid_x: 0, mid_y: 0, mid_z: 0,
    color: '#93a4bd', risk: 0.5, dens_boost: 1, metric_text: '—', day: 0
  }
  const dup = !!heatSel.value &&
    heatSel.value.norad_a === evt.norad_a && heatSel.value.norad_b === evt.norad_b &&
    parseEpoch(heatSel.value.tca) === tcaMs
  heatSelList.value = clusterHeatEvents(evt)
  if (!dup) heatSel.value = evt
  heatOpen.value = true
  // 交会点：有 mid 坐标就用它（与点热力云团同一口径，响应也最快）；没有则等两星轨道构建完成
  const mx = Number(evt.mid_x), my = Number(evt.mid_y), mz = Number(evt.mid_z)
  const hasMid = Number.isFinite(mx) && Number.isFinite(my) && Number.isFinite(mz) && (mx !== 0 || my !== 0 || mz !== 0)
  if (hasMid) flyToPoint(heatMidPoint(evt), 'point')
  else if (dup) flyToHeatTargetsMid()
  else pendingHeatFly = true
}

/** 切换热力模式：进入显示事件标记与云、隐藏卫星云/轨道线/选中；退出反向恢复 */
function applyHeatMode() {
  const on = heatMode.value
  // 过境视图与热力视图互斥且都会隐藏卫星云：任一开启即隐藏（两个 watch 各自读当前值，结果一致，不依赖触发顺序）
  // 例外 = NORAD 集合展示态（satSetActive）：集合叠加层在这两个视图下仍要显示卫星云与过滤轨道线
  const hideCloud = (on || passMode.value) && !satSetActive.value
  for (const model of modelKeys()) {
    const im = g.modelMeshes[model]
    if (im) im.visible = cloudGate() && (hideCloud ? false : modelVisible(model))
  }
  // 轨道线：热力/过境视图隐藏卫星云时一并隐藏，同时叠加图例的「轨道线」总开关
  const orbitOn = cloudGate() && !hideCloud && orbitVisible.value
  // 集合叠加层在过境视图下改由「目标明细过境轨道环」（passCityOrbitGroup）呈现，故隐藏批量过滤轨道线组，
  // 避免同一颗星出现两条轨道线；热力视图（on=false）仍保留过滤轨道线。
  if (g.filterOrbitGroup) g.filterOrbitGroup.visible = orbitOn && !(on && satSetActive.value)
  if (g.orbitLine) g.orbitLine.visible = orbitOn
  if (g.previewOrbitLine) g.previewOrbitLine.visible = orbitOn
  if (g.selAnchor) g.selAnchor.visible = !hideCloud
  if (g.passGroup) g.passGroup.visible = passMode.value
  if (g.heatGroup) g.heatGroup.visible = on
  if (g.heatSelOrbitGroup) g.heatSelOrbitGroup.visible = on
  if (on) {
    // 进入热力：未加载则拉取，已加载则按需重建标记；local / cri 同时补拉各自的「数据批次」下拉列表
    if (heatSource.value !== 'spacetrack' && !heatBatches.value.length) loadHeatBatches()
    if (!heatList.value.length && !heatLoading.value) loadHeat()
    else if (!g.heatGroup) buildHeatMarkers()
  } else {
    heatSel.value = null
    heatSelList.value = []
    // 退出热力时显式清除选中事件的 A/B 轨道线与 TCA 目标模型：
    // 仅靠 heatSel=null 依赖 watch 间接清理，若 heatSel 本就为 null 则不会触发，导致轨道线永久残留
    clearHeatSelOrbits()
    // 拾取云团会把环绕焦点飞到交会点（见 flyToPoint + focusOrbitOnPoint）：退出热力时把它切回地心，
    // 否则回到卫星云视图后滚轮会绕着天上那个交会点缩放，观感不对（见 resetOrbitFocusToEarth）。
    resetOrbitFocusToEarth()
  }
}

/** 最近一次已加载的交会热力批次 id：loadHeat 把后端解析出的批次回填到 heatBatchRunId 时，
 *  用它让 watch(heatBatchRunId) 识别「这是回显而非用户切换」，避免多触发一次重载。 */
let loadedHeatBatchId: number | null = null

/** 热力数据内存缓存：键 = 来源|窗口天数|批次（未指定批次时为 'latest'）。
 *  同一来源 / 批次再次访问（含「切走再切回」）直接命中，不再请求后端、不显示任何加载提示；
 *  配合首屏后的静默预取，切换来源即可秒出。 */
const heatCache = new Map<string, HeatmapResult>()
function heatCacheKey(src: string, days: number, runId: number | null): string {
  return `${src}|${days}|${runId ?? 'latest'}`
}
/** 写入缓存：请求未指定批次时，把返回的实际批次 id 也建成别名（回填后按批次回看可直接命中）；
 *  同时落 IndexedDB：下次冷启动（含安卓重开 App）切到热力来源也是毫秒级直出。 */
function cacheHeat(src: string, days: number, res: HeatmapResult, runId: number | null) {
  heatCache.set(heatCacheKey(src, days, runId), res)
  const rid = res?.run_id ?? null
  if (runId == null && rid != null) heatCache.set(heatCacheKey(src, days, rid), res)
  void cacheSet(heatPersistKey(src, days, runId), res)
  if (runId == null && rid != null && rid !== runId) void cacheSet(heatPersistKey(src, days, rid), res)
}

/** 当前 heatList 所属的来源：与 heatSource 分开记录，用于判断「某来源的热力数据是否已真正加载」。
 *  切换来源时 heatList 仍是上一来源的旧数据（loadHeat 异步替换），故必须靠它区分「数据未到」与「数据到了但没有该事件」。 */
let heatLoadedSrc: HeatSource | '' = ''
/** 7 天窗口空结果的自动回落标记：进入热力默认 7 天，若本地批次偏旧导致 7 天内无事件，
 *  自动切回「全部」一次，避免首屏热力图为空。切到非 7 天窗口时复位，用户再次手动选 7 天仍会重新判断。 */
let heatDaysFallbackDone = false
/** 判断某来源的热力数据是否已落到当前状态（供 URL 预置的「事件拾取」判断可否立即选中） */
function heatDataReady(src: HeatSource): boolean {
  return heatLoadedSrc === src
}

/** 把一份热力响应落到各状态并重建标记（缓存命中与网络返回共用，保证两条路径完全同口径） */
function applyHeatPayload(res: HeatmapResult | undefined, batchBased: boolean, src: HeatSource) {
  heatLoadedSrc = src
  heatList.value = res?.list || []
  // 配色图例 / 指标名 / 按日切片分组均由后端按来源口径算好下发，前端只存不换算
  heatLegend.value = res?.legend || []
  heatMetricLabel.value = res?.metric_label || ''
  heatDayGroups.value = res?.day_groups || []
  heatDay.value = -1
  // 回填后端实际解析出的批次 id：未选批次时即为「总库」当前批次，供下拉回显
  loadedHeatBatchId = batchBased ? (res?.run_id ?? null) : null
  if (batchBased && res?.run_id) heatBatchRunId.value = res.run_id
  heatError.value = ''
  buildHeatMarkers()
  // 进入热力默认 7 天窗口：若该窗口无事件（本地批次偏旧时常见），自动回落到「全部」一次，避免首屏空图。
  if (heatDays.value !== 7) heatDaysFallbackDone = false
  else if (!heatList.value.length && !heatDaysFallbackDone) {
    heatDaysFallbackDone = true
    heatDays.value = 0
  }
}

/** 拉取未来 heatDays 窗口的碰撞事件并重建标记。
 *  按 heatSource 分派数据源：'local' 走本项目 SGP4 初筛（/cgi/sat_conj/heatmap），
 *  'spacetrack' 走官方 CDM（/cgi/sat_cdm/heatmap），'cri' 走交会分析（/cgi/sat_cri/heatmap）；
 *  三者坐标口径一致，仅事件集与着色口径不同。local / cri 均为批次口径（可回看历史全量批次）。
 *  命中热力缓存时同步落状态（不置 heatLoading，不出现加载提示）。 */
async function loadHeat() {
  const src = heatSource.value
  // local / cri 走各自「总库」口径：默认最近一次全体 × 全体全量批次，
  // 若面板「数据批次」下拉选了历史批次则按 run_id 回看；CDM 热力无批次概念，不传。
  const batchBased = src !== 'spacetrack'
  const runId = batchBased ? (heatBatchRunId.value || null) : null
  const cached = heatCache.get(heatCacheKey(src, heatDays.value, runId))
  if (cached) { applyHeatPayload(cached, batchBased, src); return }
  // 内存未命中：取本地持久缓存先出图（毫秒级），随即后台静默拉最新并回写缓存。
  // 首次安装 / 缓存被清时无持久缓存，自动落到下面的网络路径。
  const persisted = await cacheGet<HeatmapResult>(heatPersistKey(src, heatDays.value, runId))
  if (persisted) {
    if (src !== heatSource.value) return
    cacheHeat(src, heatDays.value, persisted, runId)
    applyHeatPayload(persisted, batchBased, src)
    void refreshHeatInBackground(src, batchBased, runId)
    return
  }
  heatLoading.value = true
  heatError.value = ''
  try {
    const fetchHeat = src === 'local' ? getConjHeatmap : src === 'cri' ? getCriHeatmap : getCdmHeatmap
    const params = batchBased
      ? { days: heatDays.value, run_id: runId || undefined }
      : { days: heatDays.value }
    const res = await fetchHeat(params)
    // 若 await 期间来源已被切换，丢弃这批数据，避免把旧来源的事件画成新来源的配色
    if (src !== heatSource.value) return
    cacheHeat(src, heatDays.value, res, runId)
    applyHeatPayload(res, batchBased, src)
  } catch {
    if (src !== heatSource.value) return
    heatError.value = src === 'local' ? '交会热力数据加载失败' : src === 'cri' ? '交会分析热力数据加载失败' : 'CDM 热力数据加载失败'
  } finally {
    if (src === heatSource.value) heatLoading.value = false
  }
}

/** 后台静默刷新热力：不置 heatLoading、失败静默（本地持久缓存画面仍可看）。
 *  仅在「批次或事件数量变化」时才重绘标记 —— 数据没变时不重建，避免无谓闪动。 */
async function refreshHeatInBackground(src: typeof heatSource.value, batchBased: boolean, runId: number | null) {
  const days = heatDays.value
  try {
    const fetchHeat = src === 'local' ? getConjHeatmap : src === 'cri' ? getCriHeatmap : getCdmHeatmap
    const params = batchBased ? { days, run_id: runId || undefined } : { days }
    const res = await fetchHeat(params)
    if (disposed || src !== heatSource.value || days !== heatDays.value) return
    cacheHeat(src, days, res, runId)
    const sameBatch = (res?.run_id ?? null) === loadedHeatBatchId
    if (sameBatch && (res?.list?.length ?? 0) === heatList.value.length) return
    applyHeatPayload(res, batchBased, src)
  } catch { /* 静默 */ }
}

/** 静默预取某来源的热力数据（只写缓存，不改动当前状态、不建标记）：用户切到该来源时秒出。
 *  失败静默——真正切换时 loadHeat 会再请求一次并给出错误提示。 */
async function prefetchHeat(src: typeof heatSource.value) {
  const key = heatCacheKey(src, heatDays.value, null)
  if (heatCache.has(key)) return
  try {
    const res = src === 'cri' ? await getCriHeatmap({ days: heatDays.value })
      : src === 'spacetrack' ? await getCdmHeatmap({ days: heatDays.value })
        : await getConjHeatmap({ days: heatDays.value })
    cacheHeat(src, heatDays.value, res, null)
  } catch { /* 预取失败静默，不影响任何交互 */ }
}

/** 加载当前来源的批次列表（最近 N 个全体 × 全体全量批次），供面板「数据批次」下拉回看历史扫描。
 *  local / cri 各有独立批次表（sat_conj_run / sat_cri_run）；CDM 热力无批次概念，直接跳过。
 *  失败静默（下拉为空即退化为只看当前批次）。 */
async function loadHeatBatches() {
  const src = heatSource.value
  if (src === 'spacetrack') return
  // 本地持久缓存直出（下拉立即可用），再静默拉最新替换
  const persisted = await cacheGet<{ list?: typeof heatBatches.value }>(heatBatchesKey(src))
  if (persisted?.list?.length && src === heatSource.value && !heatBatches.value.length) {
    heatBatches.value = persisted.list
  }
  try {
    const res = src === 'cri' ? await getCriBatches(12) : await getConjBatches(12)
    // 若 await 期间来源已切换，丢弃结果，避免把旧来源批次列表填进新来源下拉
    if (src !== heatSource.value) return
    heatBatches.value = res?.list || []
    void cacheSet(heatBatchesKey(src), res)
  } catch {
    if (src === heatSource.value && !heatBatches.value.length) heatBatches.value = []
  }
}

/** 热力模式下拾取最近的事件（屏幕投影距离），返回事件下标与距离平方。
 *  同时给出距离是为了与「已选中云的 A/B 端点标记」做就近比较（见 onCanvasClick）：两者常常重叠在一处。 */
function pickNearestHeat(px: number, py: number): { idx: number; d2: number } | null {
  const cam = g.camera, renderer = g.renderer
  if (!cam || !renderer) return null
  const evs = heatFiltered.value
  if (!evs.length) return null
  const rect = renderer.domElement.getBoundingClientRect()
  const tolerance2 = PICK_TOLERANCE_PX * PICK_TOLERANCE_PX
  let best: number | null = null
  let bestD2 = tolerance2
  for (let i = 0; i < evs.length; i++) {
    _proj.copy(heatMidPoint(evs[i])).project(cam)
    if (_proj.z > 1 || _proj.z < -1) continue
    const sx = (_proj.x * 0.5 + 0.5) * rect.width
    const sy = (-_proj.y * 0.5 + 0.5) * rect.height
    const dx = sx - px
    const dy = sy - py
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = i }
  }
  return best == null ? null : { idx: best, d2: bestD2 }
}

/** 热力模式下拾取已选中「碰撞云」内的目标端点（屏幕投影距离），
 *  返回该端点的 NORAD、ECI 坐标与距离平方（距离用于与云团事件点做就近比较，见 onCanvasClick） */
function pickNearestHeatTarget(px: number, py: number): { norad: number; eci: THREE.Vector3; d2: number } | null {
  const cam = g.camera, renderer = g.renderer
  if (!cam || !renderer || !g.heatSatTargets.length) return null
  const rect = renderer.domElement.getBoundingClientRect()
  const tolerance2 = PICK_TOLERANCE_PX * PICK_TOLERANCE_PX
  let best: { norad: number; eci: THREE.Vector3 } | null = null
  let bestD2 = tolerance2
  for (const t of g.heatSatTargets) {
    _proj.copy(eciToScene(t.eci.x, t.eci.y, t.eci.z))
    if (isOccludedByEarth(cam.position, _proj)) continue
    _proj.project(cam)
    if (_proj.z > 1 || _proj.z < -1) continue
    const sx = (_proj.x * 0.5 + 0.5) * rect.width
    const sy = (-_proj.y * 0.5 + 0.5) * rect.height
    const dx = sx - px
    const dy = sy - py
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = t }
  }
  return best == null ? null : { ...best, d2: bestD2 }
}

/** 热力模式点击目标端点 → 换成该卫星详情（位置 + TLE），保留热力云，额外画该星独立轨道线 + 准星。
 *  不飞镜头以保留当前交会现场；右侧事件详情收起，让位给卫星详情（heatSel 仍保留，两星轨道继续显示）。 */
function selectHeatTarget(t: { norad: number; eci: THREE.Vector3 }) {
  const gi = g.cloudList.findIndex((p) => p.norad_id === t.norad)
  const pt: ConstellationPoint = gi >= 0
    ? g.cloudList[gi]
    : { norad_id: t.norad, object_name: '', object_type: 'UNKNOWN', x: t.eci.x, y: t.eci.y, z: t.eci.z }
  heatOpen.value = false
  selectSatellite(pt, false)
}

function onCanvasClick(ev: MouseEvent) {
  const renderer = g.renderer, cam = g.camera
  if (!renderer || !cam) return
  // 左侧列表与右侧详情两两相对但互斥：点画布空白处 / 拾取三维目标后收起左侧卫星/星座列表，让位给右侧详情
  // （热力面板不在此列：它本身即热力视图入口，收起会连带退出热力视图）
  const collapseList = () => { if (dockMode.value === 'sat' || dockMode.value === 'cons') dockMode.value = '' }
  // 热力模式：点击事件点 → 聚合该「碰撞云」覆盖区域内的全部事件（右侧列出整片云的碰撞列表），
  // 并聚焦被点击的那一个事件（画 A/B 两星轨道 + 卫星端点标记）；再次点击已选中事件取消选中。
  if (heatMode.value) {
    const r = renderer.domElement.getBoundingClientRect()
    const px = ev.clientX - r.left
    const py = ev.clientY - r.top
    // 已选中「碰撞云」内的 A/B 端点标记 与 云团事件点 常常重叠在一处（TCA 处两星就落在云团里，
    // 落位后屏幕上相距只有几 px），故取**就近者**：点在端点标记上仍看该卫星详情（保留热力云与两星轨道），
    // 点在事件点上则按「云团列表第一条」选中整片云。若一律端点优先，选中一次之后就再也点不到云团了。
    const tgt = pickNearestHeatTarget(px, py)
    const hit = pickNearestHeat(px, py)
    if (tgt && (!hit || tgt.d2 <= hit.d2)) {
      if (hasSel.value && sel.id === tgt.norad) resetSelected(false)
      else selectHeatTarget(tgt)
      return
    }
    if (!hit) return
    const seed = heatFiltered.value[hit.idx]
    if (!seed) return
    // 点中的事件只作为「这一片云团」的聚合种子，真正聚焦的不是它 ——
    // 同一片云团里事件密集，点哪个像素都可能落在不同事件上，若按「屏幕上离点击最近的事件」聚焦，
    // 会出现「同一片云、每次点选中的都是不同事件」的随机感。改为统一聚焦云团列表的第一条。
    const cluster = clusterHeatEvents(seed)
    // 再次点击同一片云团（点在已选云团的任意一个事件上）→ 取消选中
    if (heatSel.value && cluster.some((e) => e.id === heatSel.value!.id)) {
      heatSel.value = null
      heatSelList.value = []
      heatOpen.value = false
      // 焦点从交会点切回地心（见 resetOrbitFocusToEarth），别把焦点留在天上
      resetOrbitFocusToEarth()
      return
    }
    heatSelList.value = cluster
    // 「列表第一条」= 该云团在热力列表里的第一个（前端不重排，顺序 = 后端下发顺序，
    // 与右侧「本区域碰撞列表」展示顺序完全一致）：本项目两个来源按 min_distance 升序（最危险优先）、
    // 官方 CDM 来源按 tca 升序（最近要发生的优先）。点云团任意位置都聚焦它，行为可预期。
    const focus = cluster[0] ?? seed
    heatSel.value = focus
    heatOpen.value = true
    // 镜头飞到该事件的交会位置（两星 TCA 中点，后端下发的 mid_x/y/z），落位后以它作为环绕焦点
    flyToPoint(heatMidPoint(focus), 'point')
    return
  }
  // 过境模式：点击目标面（行政区划/国界）→ 计算并展示该目标未来 24h 过境明细（点空白处不处理）
  if (passMode.value) {
    const r = renderer.domElement.getBoundingClientRect()
    const px = ev.clientX - r.left
    const py = ev.clientY - r.top
    // 区域过境框选：单击逐点取经纬度选顶点，此期间不拾取目标面
    if (regionDrawMode.value) { addRegionVertex(px, py); return }
    // 多区域过境框选：同样逐点取经纬度，但顶点进的是「多区域」自己的草稿（与区域过境互不干扰）
    if (multiDrawMode.value) { addMultiVertex(px, py); return }
    const targetId = pickPassTargetAt(px, py)
    if (targetId != null) selectPassTarget(targetId)
    return
  }
  // 发射站视图：点击地球上的发射站标记 → 选中并弹右侧详情（即将发射 + 发射历史）；点空白不处理
  if (siteMarkersVisible.value) {
    const r = renderer.domElement.getBoundingClientRect()
    const id = pickLaunchSiteAt(ev.clientX - r.left, ev.clientY - r.top)
    if (id != null) selectLaunchSiteById(id)
    return
  }
  if (!g.meshes.length) { collapseList(); return }
  // 双击跟踪态：单击画布任意位置（含空白处）即解除跟踪，本次点击不再触发选中/取消逻辑
  if (trackGi != null) { stopTargetTracking(); collapseList(); return }
  if (trackEphem) { stopEphemTracking(); collapseList(); return }
  const gi = pickNearestSat(ev)
  if (gi == null) { collapseList(); return }
  const pt = g.cloudList[gi]
  if (!pt) { collapseList(); return }
  // 双击识别：同一目标 400ms 内的第二击 → 拉近 + 居中跟踪。放在「再点一次取消选中」分支之前，
  // 否则双击的第二次点击会先取消选中、再由选中链路重建，轨道线会闪断一次
  const nowMs = performance.now()
  const dbl = _pickDbl.norad === pt.norad_id && nowMs - _pickDbl.ts < DBL_PICK_MS
  _pickDbl.norad = pt.norad_id
  _pickDbl.ts = nowMs
  if (dbl) { startTargetTracking(gi, pt); collapseList(); return }
  if (hasSel.value && sel.id === pt.norad_id) {
    resetSelected()
    collapseList()
    return
  }
  selectSatellite(pt)
  collapseList()
}

/* ---------- hover 预览轨道线 ---------- */
let hoverGi: number | null = null
let lastHoverTs = 0

function clearPreviewOrbit() {
  if (g.previewOrbitLine) {
    g.scene?.remove(g.previewOrbitLine)
    g.previewOrbitLine.geometry.dispose()
    const m = g.previewOrbitLine.material as THREE.LineBasicMaterial | undefined
    if (m) m.dispose()
    g.previewOrbitLine = null
  }
}

/** 建一条 hover 预览轨道线并挂到场景：精确 SGP4 线与首屏二体过渡线共用同一套建线口径 */
function addPreviewLine(pts: THREE.Vector3[], objectType: string) {
  const scene = g.scene
  if (!scene || !pts.length) return
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: TYPE_COLOR[objectType] || 0x8fd0ff, transparent: true, opacity: 0.55 })
  )
  g.previewOrbitLine = line
  scene.add(line)
  // hover 预览轨道线只受图例「轨道线」总开关控制（预览仅存在于普通视图）
  line.visible = orbitVisible.value
}

/** 用点云自带的瞬时位置 / 速度（与点云同一快照由后端一并下发）在场景坐标系里积分出一整圈二体轨道线。
 *  仅用于「首屏 satrec 尚未就绪」时立刻画出 hover 预览线：全量 TLE 还在下载 / 解析，若死等
 *  ensureSatrecs 就会出现「刚进页面 hover 要卡一阵才有轨道线」。本地计算、零网络等待。
 *  与 SGP4 的差别只是 J2 摄动，单圈内位置差几 km（可视尺度下不足 1px），作过渡线足够；
 *  satrec 就绪后鼠标再移动即走 SGP4 精确路径（见 buildPreviewOrbit）。 */
function buildInstantOrbit(gi: number): THREE.Vector3[] | null {
  const p = g.cloudList[gi]
  if (!p) return null
  const pos = eciToScene(p.x, p.y, p.z)
  const vel = eciToScene(p.vx ?? 0, p.vy ?? 0, p.vz ?? 0)
  const r0 = pos.length()
  if (!(r0 > 1e-6)) return null
  // vis-viva 求半长轴：非椭圆（双曲线 / 退化）不画
  const semi = 1 / (2 / r0 - vel.lengthSq() / MU_SCENE)
  if (!Number.isFinite(semi) || semi <= 0) return null
  const periodSec = 2 * Math.PI * Math.sqrt((semi * semi * semi) / MU_SCENE)
  if (!Number.isFinite(periodSec) || periodSec <= 0) return null
  const steps = 512
  const dt = periodSec / steps
  const a1 = new THREE.Vector3()
  const a2 = new THREE.Vector3()
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= steps; i++) {
    pts.push(pos.clone())
    // Velocity Verlet：先把位置推到 n+1，再用 a_n / a_{n+1} 的平均更新速度
    const d1 = pos.length() || 1e-9
    a1.copy(pos).multiplyScalar(-MU_SCENE / (d1 * d1 * d1))
    pos.addScaledVector(vel, dt).addScaledVector(a1, 0.5 * dt * dt)
    const d2 = pos.length() || 1e-9
    a2.copy(pos).multiplyScalar(-MU_SCENE / (d2 * d2 * d2))
    vel.addScaledVector(a1, 0.5 * dt).addScaledVector(a2, 0.5 * dt)
  }
  return pts
}

async function buildPreviewOrbit(gi: number) {
  const scene = g.scene
  const p = g.cloudList[gi]
  if (!scene || !p) return
  if (hasSel.value && sel.id === p.norad_id) return
  // 首屏过渡：全量 TLE 尚未就绪时用点云瞬时位置 / 速度画二体近似线（零等待），
  // 避免「刚进页面 hover 要等 TLE 下载 + 解析完才有轨道线」。
  if (!satrecsReady) {
    const quick = buildInstantOrbit(gi)
    if (quick) addPreviewLine(quick, p.object_type)
    return
  }
  // satrec 懒加载：TLE 首次拉取要等一会儿，期间鼠标可能已移到别处 / 移出画面，回来后再校验
  await ensureSatrecs()
  if (hoverGi !== gi) return
  const rec = g.satrecs[gi]
  if (!rec || !rec.no) return
  const periodMin = (Math.PI * 2) / rec.no
  const periodMs = periodMin * 60000
  // 以「当前时刻」为中心采样一整圈，保证卫星当前位置落在预览环上（按 TLE 历元采样会因 J2 进动偏开）
  const epochMs = g.simTimeMs - periodMs / 2
  const steps = 512
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= steps; i++) {
    const pv = propagate(rec, new Date(epochMs + (i / steps) * periodMs))
    if (pv?.position) pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z))
  }
  addPreviewLine(pts, p.object_type)
}

function onPointerMove(ev: PointerEvent) {
  // 区域框选期间：只更新预览线（最后一个顶点 → 光标），并抑制 hover 预览轨道线
  if (regionDrawMode.value) {
    if (hoverGi != null) { hoverGi = null; clearPreviewOrbit() }
    const el0 = g.renderer?.domElement
    if (el0) {
      const r0 = el0.getBoundingClientRect()
      updateRegionPreview(ev.clientX - r0.left, ev.clientY - r0.top)
    }
    return
  }
  // 多区域框选期间：同样抑制 hover 预览轨道线（本模式不画预览线，只保证不误触发 hover）
  if (multiDrawMode.value) {
    if (hoverGi != null) { hoverGi = null; clearPreviewOrbit() }
    return
  }
  // hover 目标预览轨道线：PC 保留；移动端整体移除（无 hover，避免误触发轨道线）；
  // 低端机档位关闭 hover（拾取开销大）；交互期（拖拽/缩放）直接跳过，把主线程全让给渲染
  if (heatMode.value || passMode.value || isMobile.value || !quality.hover || g.userInteracting) {
    if (hoverGi != null) { hoverGi = null; clearPreviewOrbit() }
    return
  }
  const now = performance.now()
  if (now - lastHoverTs < quality.hoverThrottle) return
  lastHoverTs = now
  const el = g.renderer?.domElement
  if (!el) return
  const r = el.getBoundingClientRect()
  const gi = pickNearestAt(ev.clientX - r.left, ev.clientY - r.top)
  // 目标未变时通常直接返回；若该目标还没画出预览线（退化轨道连二体过渡线也画不出，或 satrec 尚未就绪），
  // 让后续 pointermove 继续重试，条件满足即补线，否则光标停在原地永远等不到线。
  if (gi === hoverGi && (gi == null || g.previewOrbitLine)) return
  hoverGi = gi
  clearPreviewOrbit()
  if (gi != null) void buildPreviewOrbit(gi)
}

/* ---------- 镜头平滑飞行 ---------- */
const camFly = {
  active: false,
  t0: 0,
  dur: 900,
  fromPos: new THREE.Vector3(),
  toPos: new THREE.Vector3(),
  fromTarget: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
  /** 落位后环绕焦点的处理方式（都要等落位再做，见 updateCameraFly）：
   *  · 'sel'   切到当前选中卫星（拾取卫星用，见 focusOrbitOnSel）
   *  · 'point' 切到落位焦点本身（热力交会点：镜头飞到交会位置并聚焦它，见 focusOrbitOnPoint）
   *  · 'none'  不动（飞向地面目标：焦点留在地心，由调用方先调 restoreEarthOrbitLimits） */
  focusMode: 'none' as 'none' | 'sel' | 'point'
}
function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
function updateCameraFly(now: number): boolean {
  if (!camFly.active) return false
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) { camFly.active = false; return false }
  const k = Math.min((now - camFly.t0) / camFly.dur, 1)
  const e = easeInOutCubic(k)
  cam.position.lerpVectors(camFly.fromPos, camFly.toPos, e)
  controls.target.lerpVectors(camFly.fromTarget, camFly.toTarget, e)
  // 相机 up 全程不动（恒为世界 +Y，见 ORBIT_POLE_LIMIT）：镜头只平移 + 改变朝向，
  // 不会随焦点切换滚转，也就没有「拾取一次地球南北翻一下」的问题。
  // 相机与焦点重合时 lookAt 的方向向量退化为 0（滚轮拉到最近后再次拾取可能出现），
  // 此时 three 会取兜底朝向导致画面突然跳 —— 距离过近就跳过本次朝向重建，保留上一帧朝向
  if (cam.position.distanceToSquared(controls.target) > 1e-8) cam.lookAt(controls.target)
  if (k >= 1) {
    camFly.active = false
    // 落位后才切焦点 / 放宽最小距离（见 focusOrbitOnSel / focusOrbitOnPoint）。
    // 不能在起飞瞬间切：那一刻相机还在原位，OrbitControls 会立刻按新焦点重算球坐标，
    // 画面在动画开始前就跳一下 —— 方位极端时即表现为「拾取瞬间镜头翻过来」。
    if (camFly.focusMode === 'sel') focusOrbitOnSel()
    else if (camFly.focusMode === 'point') focusOrbitOnPoint(camFly.toTarget)
    return false
  }
  return true
}
/** flyToSat 落位方向复用向量 */
const _flyZen = new THREE.Vector3()
const _flyOff = new THREE.Vector3()
/** 飞回地心视角的落位焦点（恒为原点；beginCamFly 的 toTarget 入参） */
const _flyHomeTarget = new THREE.Vector3()
/** 起飞公共入口：写 fromPos/fromTarget/toPos/toTarget 并激活飞行（flyToPoint / flyToPassPoint /
 *  flyToEarthFixedPoint 三个起飞点共用，保证起点口径只有这一份）。
 *  Cesium 模式下 controls.target 不再随交互更新（ScreenSpaceCameraController 接管后它是旧焦点残值），
 *  直接拿它做 lookAt 插值会在起飞瞬间把视线拽向旧焦点 —— 改取「当前视线上、与落点等距」的点，
 *  起飞方向 = 当前视线、落位方向 = 目标，全程平滑；Three 模式下 controls.target 恒为当前环绕焦点
 *  （OrbitControls 始终保持相机注视它），原样使用零跳变。 */
function beginCamFly(toPos: THREE.Vector3, toTarget: THREE.Vector3, focusMode: 'none' | 'sel' | 'point') {
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) return
  camFly.fromPos.copy(cam.position)
  if (cesiumActive) {
    cam.getWorldDirection(_cesiumFlyDir)
    camFly.fromTarget
      .copy(cam.position)
      .addScaledVector(_cesiumFlyDir, Math.max(cam.position.distanceTo(toTarget), 1e-3))
  } else {
    camFly.fromTarget.copy(controls.target)
  }
  camFly.toPos.copy(toPos)
  camFly.toTarget.copy(toTarget)
  camFly.t0 = performance.now()
  camFly.active = true
  camFly.focusMode = focusMode
}

/** 镜头飞到某个场景点位并聚焦它（拾取卫星 / 热力交会点共用同一套落位算法，口径只有这一份）。
 *  focusMode 决定落位后焦点怎么切（见 camFly.focusMode）；
 *  dist 可选：指定「相机到目标」的距离（缺省 = 目标到地心距离，即全球视角的落位口径）。 */
function flyToPoint(point: THREE.Vector3, focusMode: 'sel' | 'point', dist?: number) {
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) return
  // 坐标缺失（后端未下发 mid 坐标等）时直接不飞：NaN 会污染相机矩阵，画面会整屏坏掉
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return
  if (point.lengthSq() < 1e-12) return
  const r = Math.max(point.length(), 1e-3)
  // 落位机位 = 「镜头—目标—地心」三点共线：相机落在「地心→目标」射线的延长线上、到目标距离 = r
  // （即相机到地心 2r），视线直指地心 —— 落位后目标居中、地球作正后方背景（用户口径：垂直卫星、垂直地心）。
  const zen = _flyZen.copy(point).normalize()
  // 相机 up 恒为世界 +Y，落位方向（焦点→相机）即目标当地天顶 zen。
  // 目标靠近南北极时 zen 近乎平行世界 +Y，lookAt 会退化到「正对天顶」奇异点（画面翻转），
  // 故先夹进极角限位：|纬度| > 60° 时相机自动偏出 30°，其余情况严格共线。
  const off = clampPolarToLimit(_flyOff.copy(zen))
  const toPos = point.clone().addScaledVector(off, dist ?? r)
  // up 不动：全程世界 +Y（见 ORBIT_POLE_LIMIT），飞行只改机位与焦点，画面不会滚转 / 南北翻转；
  // 焦点切换推迟到落位时执行（见 updateCameraFly）：不能在这里切，否则动画未开始就先按新焦点重算相机球坐标
  beginCamFly(toPos, point, focusMode)
}

function flyToSat(anchorPos: THREE.Vector3) {
  flyToPoint(anchorPos, 'sel')
}

/** 容器是否可测量：keep-alive 缓存期间组件 DOM 被移出文档，clientWidth/Height 为 0，
 *  若此时响应 window.resize 会把画布内联尺寸写成 0px，切回后 canvas 不可见（安卓 WebView 上表现为大白板）。 */
function canMeasure(el: HTMLDivElement | undefined): el is HTMLDivElement {
  return !!el && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0
}

function onResize() {
  const el = container.value
  if (!canMeasure(el) || !g.renderer || !g.camera) return
  g.camera.aspect = el.clientWidth / el.clientHeight
  g.camera.updateProjectionMatrix()
  g.renderer.setSize(el.clientWidth, el.clientHeight)
  // Cesium 底座画布同步尺寸（内部含相机 frustum.aspectRatio 更新，被动同步会带给 g.camera）
  resizeCesium()
  // 偶极场线（Line2 管线）的像素线宽依赖画布分辨率，须同步，否则线宽随窗口比例失真（发光层与白芯线两层都要）
  const lm = dipoleLines?.material as unknown as { resolution?: THREE.Vector2 } | undefined
  if (lm?.resolution) lm.resolution.set(el.clientWidth, el.clientHeight)
  const gm = dipoleGlow?.material as unknown as { resolution?: THREE.Vector2 } | undefined
  if (gm?.resolution) gm.resolution.set(el.clientWidth, el.clientHeight)
  // 二十八宿四象连线（Line2 管线）同理：像素线宽依赖画布分辨率
  if (mansionLineMat) mansionLineMat.resolution.set(el.clientWidth, el.clientHeight)
  // 西方 88 星座连线（Line2 管线）同理
  if (constellationLineMat) constellationLineMat.resolution.set(el.clientWidth, el.clientHeight)
}

/* ============================================================
 * 过境分析：地表叠加图层（行政区划面 + 国界 + 城市标注）/ 模式切换 / 目标面拾取
 *
 * 贴图自转模型：地球 mesh 不旋转，动画循环改 mercator 贴图 offset.x = -gstime/2π 模拟自转。
 * 地表叠加物必须每帧施加同一旋转量才能"贴"在地理位置上。经推导（等距圆柱贴图 lon 与 u 线性、
 * 球面 UV u 与绕 Y 角 φ 线性），叠加根组恰为 passGroup.rotation.y = gstime(t)，
 * 且经纬度 → 场景基坐标就是 ECEF 的 eciToScene 变换：(cosLat·cosLon, sinLat, -cosLat·sinLon)。
 * ============================================================ */
/** 过境目标面（中国行政区划面）贴地半径：在所有描边之下（面要贴地），又高于地球面避免 z-fighting */
const PASS_TARGET_R = EARTH_R * 1.0015
/** 国界线贴地半径（略高于地表，避免与地球面 z-fighting） */
const PASS_BORDER_R = EARTH_R * 1.002
/** 其他国家国界面目标线的配色：有过境数据（亮蓝） / 无数据（灰蓝）。
 *  中国行政区划面（district）的边界线统一白色（见 buildPassLayers），不走这两个色值。 */
const PASS_TARGET_LINE_HAS = 0x4da3ff
const PASS_TARGET_LINE_NONE = 0x53627a
/** 选中目标面的高亮色（填充 + 描边） */
const PASS_TARGET_SEL_COLOR = 0x59d3ff
/** 框选区域多边形贴地半径：面 / 描边 / 顶点分三层抬高，互不 z-fighting（沿用本项目「按半径分层」的做法，不用 polygonOffset）。
 *  取值必须**高于**「选中过境记录的扫描叠加层」（REGION_PASS_FILL_R / BAND_R / TRACK_R）：
 *  点击结果列表项时框选区域与扫描区域同时在场，要让使用者看清两者的相交关系，
 *  故把用户所框的区域压在最上面（且成像条带改成与框选边不同的颜色，见 REGION_PASS_BAND_COLOR）。 */
const REGION_FILL_R = EARTH_R * 1.012
const REGION_EDGE_R = EARTH_R * 1.0135
const REGION_VERTEX_R = EARTH_R * 1.015
/** 框选顶点上限：顶点过多会让球面判定与三角剖分变慢，交互上也无必要 */
const REGION_MAX_POINTS = 60
/** 区域描边 / 顶点 / 预览线配色（与过境图例的青色系区分开） */
const REGION_EDGE_COLOR = 0xffd166
const REGION_FILL_COLOR = 0xffd166
const REGION_PREVIEW_COLOR = 0x9ef0ff
/** 贴地连线的圆弧采样：约每 2° 采样一段，单段最多 48 段。
 *  区域跨大时若直接连直线弦，边线与预览线会从地球内部穿过（穿模），故一律沿大圆弧加密。 */
const REGION_ARC_STEP = (2 * Math.PI) / 180
const REGION_ARC_MAX_SEG = 48
/** 预览线预分配点数（= 单段弧最大采样点数 + 1）：鼠标移动时只改坐标 + drawRange，不重建几何 */
const REGION_PREVIEW_MAX_PTS = REGION_ARC_MAX_SEG + 1
/** 点回起始点闭合框选的屏幕容差（像素） */
const REGION_CLOSE_TOLERANCE_PX = 14
/** 双击判定窗口（ms）与同点容差（像素）：第二次落点落在该窗口内视为「双击闭合」而非再选一个顶点 */
const REGION_DBLCLICK_MS = 350
const REGION_DBLCLICK_PX = 8

/** 当前是否为「区域过境」子项（dock 过境分析菜单的二选一）：
 *  该模式下点击不再拾取城市，城市信息只保留中文标注（三维城市点云已整体取消）。 */
const regionMode = computed(() => passMode.value && dockActive.value === 'region')

/** WGS84 椭球参数（km）：与 Cesium 底座同口径，地表叠加物才能贴合影像/地形表面
 *  （正球 6371km 与 WGS84 椭球最大差约 21km，贴地表元素在高倍缩放下会明显悬空/入地） */
const WGS84_A_KM = 6378.137
const WGS84_B_KM = 6356.752314245
/** WGS84 地心半径（km）随纬度变化：r(φ) = √(((a²cosφ)² + (b²sinφ)²) / ((a·cosφ)² + (b·sinφ)²)) */
function wgs84RadiusKm(latRad: number): number {
  const s = Math.sin(latRad)
  const c = Math.cos(latRad)
  const a2 = WGS84_A_KM * WGS84_A_KM
  const b2 = WGS84_B_KM * WGS84_B_KM
  return Math.sqrt((a2 * a2 * c * c + b2 * b2 * s * s) / (a2 * c * c + b2 * s * s))
}

/** 经纬度（度）→ 场景坐标（WGS84 口径：r=1 落在该纬度的椭球表面，r 按场景单位缩放）。
 *  轴映射口径与 eciToScene 一致：scene = (ECEF.x, ECEF.z, -ECEF.y)；
 *  模长按当地椭球地心半径 / 6371（场景单位基准）换算，使贴地半径常量（PASS_TARGET_R 等）语义不变。 */
function lonLatToScene(lon: number, lat: number, r: number): THREE.Vector3 {
  const lonRad = (lon * Math.PI) / 180
  const latRad = (lat * Math.PI) / 180
  const cosLat = Math.cos(latRad)
  const k = (r * wgs84RadiusKm(latRad)) / EARTH_RADIUS_KM
  return new THREE.Vector3(k * cosLat * Math.cos(lonRad), k * Math.sin(latRad), -k * cosLat * Math.sin(lonRad))
}

/* ---------------- 过境高亮：目标行政区划面 + 空间轨道标记 ----------------
 * 点击目标面 / 过境列表项时，在 passGroup 内叠加高亮物（随地球贴图一同自转），并把镜头飞到目标：
 *  · 目标面 → 该目标的行政区划面（半透明填充 + 加粗边界线，面而不是「点画圆」）；
 *  · 过境记录 → 该次过境的 AOS / 最高仰角 / LOS 三处**空间位置**标记（点在空间轨道上，不是贴地星下点轨迹）。
 * 镜头飞行复用 camFly 缓动：相机落在目标点的地心方向延长线上、控件 target 仍为地心，
 * 故该点恰好被投影到屏幕正中。
 * ------------------------------------------------------------------ */
/** 过境标记：AOS 时刻的标记色（另一处标记色见 buildPassTrackMarks 内的最高仰角 / LOS） */
const PASS_TRACK_COLOR = 0x7dffb0
/** 镜头飞到地表目标点时相机距地心距离（场景单位）：约 1.6 个地球半径，兼顾目标面与细节 */
const PASS_FOCUS_DIST = EARTH_R * 1.6

/* ---------------- 过境轨道线：选中目标全部过境卫星（每颗一根）+ 单次过境卫星模型 ----------------
 *  · 城市全部卫星轨道线 —— 点击地球目标面 / 左侧列表项后，把该目标过境明细里的卫星各画一根整圈轨道环；
 *  · 单次过境卫星 —— 点击右侧过境列表项后，把那根已有轨道线复染成红色 + 放上三维模型（机头垂直地球）。
 *  轨道线挂 passGroup（地球固连系，随地球自转）而非场景根（惯性系）：选中目标的高亮面是 passGroup 的
 *  子节点，只有同处固连系，轨道线才会与区域面相交（穿过区域面 / 擦一个角）。
 *  采样相位取「该星在本目标的过境中点」：该时刻的星下点轨迹正经过目标区域，把此时刻的 ECI 轨道环
 *  转成 ECEF 局部坐标（绕极轴旋转 −gstime）后，环必然骑在区域面上。
 *  （对比区域过境 buildRegionPassOrbit：那里只有单星单窗口，可直接把虚拟时间对齐到过境窗口后在
 *   惯性系里画环；这里一次几十颗、过境时刻各不相同，无法共用同一虚拟时间，故改走固连相位。）
 * ------------------------------------------------------------------ */
/** 城市过境：每颗卫星的整圈轨道环采样步数（后端明细每目标上限 1000 条，去重后按一屏数十根预算） */
const PASS_CITY_ORBIT_STEPS = 192
/** 城市过境：全部卫星轨道环配色（透明度低，便于与单次选中复染的红色区分） */
const PASS_CITY_ORBIT_COLOR = 0x37c2ff
/** 单次过境：选中卫星三维模型的配色（与区域过境卫星模型同色） */
const PASS_SAT_MODEL_COLOR = 0x66e0ff
/** 单次过境：被点选那根轨道线的复染高亮色 */
const PASS_SAT_HL_COLOR = 0xff3b30
/** 场景极轴（ECI 的 Z 轴即场景 Y 轴）：ECI → ECEF 就是绕它旋转 −gstime */
const PASS_ORBIT_AXIS_Y = new THREE.Vector3(0, 1, 0)

/** 城市过境：全部卫星轨道环的绘制序号（异步构建期间若已切换目标 / 清空明细，用它丢弃过期结果） */
let passCityOrbitSeq = 0
/** 单次过境：选中卫星的绘制序号（同上，异步模型下载期间可能已切换记录） */
let passSatSeq = 0
/** 单次过境：选中卫星的 satrec 与模型（模型位置 / 姿态每帧按虚拟时间重算，机身长轴恒垂直地球） */
let passSatSr: ReturnType<typeof twoline2satrec> | null = null
let passSatModel: THREE.Mesh | null = null
/** 城市过境：norad_id → 该星的整圈轨道线（点右侧过境列表时直接复染其中的一根，不再另建线） */
const passCityOrbitLines = new Map<number, THREE.Line>()
/** 单次过境：当前被复染成红色的那根线（复染前材质存在 userData.baseMat，取消选中时换回） */
let passSatHlLine: THREE.Line | null = null
/** 过境轨道环的可见范围口径：true = 明细里全部卫星的轨道环照常构建，但只有 filterNorads（回答列出的那几颗）
 *  可见，其余隐藏（AI 过境回答路径，避免满屏轨道线）；false = 明细全部卫星轨道环都可见
 *  （手动点选目标、或用户明确「看全部过境」）。图层重建补画（resyncPassSelectionVisuals）也必须遵守该口径。 */
let passOrbitListOnly = false

/** 释放「选中目标全部过境卫星的轨道线」组（passGroup 子组，随地球自转） */
function clearPassCityOrbits() {
  passCityOrbitSeq++
  // 轨道线随本组一并释放，复染引用必须同步撤销，否则恢复颜色时会操作已释放对象
  restorePassSatHlLine()
  passCityOrbitLines.clear()
  const grp = g.passCityOrbitGroup
  if (grp) { g.passGroup?.remove(grp); disposeGroup(grp); g.passCityOrbitGroup = null }
}

/** 取消轨道线的红色复染（换回复染前的材质，并释放临时红色材质） */
function restorePassSatHlLine() {
  const line = passSatHlLine
  if (!line) return
  passSatHlLine = null
  const base = line.userData.baseMat as THREE.Material | THREE.Material[] | undefined
  if (!base) return
  const hl = line.material
  line.material = base
  if (Array.isArray(hl)) hl.forEach((m) => m.dispose())
  else hl.dispose()
}

/** 采样一颗卫星的整圈轨道环，并转成 passGroup 局部坐标（ECEF）：
 *  p_local = R_y(−gstime(tMid)) · p_scene(ECI)，与 lonLatToScene / flyToPassPoint 同一口径。 */
function samplePassOrbitLocal(sr: ReturnType<typeof twoline2satrec>, tMidMs: number): THREE.Vector3[] {
  const periodMs = (sr.no ? (Math.PI * 2) / sr.no : 100) * 60000
  const t0 = tMidMs - periodMs / 2
  const gst = gstime(new Date(tMidMs))
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= PASS_CITY_ORBIT_STEPS; i++) {
    const pv = propagate(sr, new Date(t0 + (i / PASS_CITY_ORBIT_STEPS) * periodMs))
    if (!pv?.position) continue
    pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z).applyAxisAngle(PASS_ORBIT_AXIS_Y, -gst))
  }
  return pts
}

/** 一颗卫星的整圈轨道线（passGroup 局部坐标 = 地球固连，与区域面同系） */
function makePassCityOrbitLine(sr: ReturnType<typeof twoline2satrec>, tMidMs: number): THREE.Line | null {
  const pts = samplePassOrbitLocal(sr, tMidMs)
  if (pts.length < 2) return null
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: PASS_CITY_ORBIT_COLOR, transparent: true, opacity: 0.45 })
  )
}

/** 按「只显示列表」口径刷新过境轨道环的单根可见性：
 *  passOrbitListOnly 且 filterNorads 非空 → 仅 filterNorads 里的那几颗可见，其余隐藏；
 *  否则（手动点选 / 「看全部过境」）全部可见。 */
function syncPassCityOrbitVisibility() {
  if (!passCityOrbitLines.size) return
  const want = passOrbitListOnly && filterNorads.value?.length
    ? new Set(filterNorads.value.map((v) => Number(v)))
    : null
  for (const [norad, line] of passCityOrbitLines) line.visible = want ? want.has(norad) : true
}

/** 绘制「选中目标过境明细里全部卫星」的整圈轨道环（每颗一根）。
 *  明细（passDetail.list，后端每目标上限 1000 条）里同一颗星可能被多个过境窗口重复列出，故先按 norad 去重；
 *  明细只给 norad 不给坐标，轨道必须靠全局 satrec 反演（见 ensureSatrecs）。
 *  相位：每颗星取「它自己在本目标的过境窗口中点」——该时刻星下点正落在目标区域，按此相位把轨道环换算到
 *  地球固连系后，环必然穿过该区域面（或至少擦过区域的一角），即用户要的「轨道线穿过区域面」。
 *  与单次过境共用同一批线（passCityOrbitLines：norad_id → Line），点右侧列表项时只复染其中一根，不另建线。
 *  与 regionPassGroup 同一可见口径：过境视图关闭时整组隐藏（图层保留，再次进入无需重画）。 */
async function buildPassCityOrbits() {
  clearPassCityOrbits()
  if (!g.scene) return
  const list = passDetail.value?.list
  if (!list?.length) return
  const seq = passCityOrbitSeq
  // satrec 懒加载：TLE 未就绪时先补齐（awaitSatrecs 抗「解析期间点云被重建」，避免首建拿到全空的 satrec 数组）
  await awaitSatrecs()
  // passGroup 缺失时直接放弃（轨道线必须挂在地球固连系，挂错父级会画到错误相位上）
  if (seq !== passCityOrbitSeq || !g.scene || !g.passGroup) return

  // norad → 该星在本目标的首个过境的**峰值时刻**（相位基准：该时刻星下点正落在目标区域，
  // 按此相位换算到地球固连系后轨道环必穿过区域面）。旧批次多圈过境被合并的脏数据中点会漂到错误半球，
  // 故优先 maxAtMs；缺失时回退窗口中点。
  const midByNorad = new Map<number, number>()
  for (const rec of list) {
    if (!midByNorad.has(rec.norad_id)) {
      midByNorad.set(rec.norad_id, Number.isFinite(rec.maxAtMs) ? rec.maxAtMs : (rec.aosMs + rec.losMs) / 2)
    }
  }

  const group = new THREE.Group()
  group.name = 'pass-city-orbits'
  for (const [norad, tMid] of midByNorad) {
    const gi = g.cloudList.findIndex((p) => p.norad_id === norad)
    if (gi < 0) continue
    const sr = g.satrecs[gi]
    if (!sr) continue
    const line = makePassCityOrbitLine(sr, tMid)
    if (!line) continue
    group.add(line)
    passCityOrbitLines.set(norad, line)
  }
  if (!group.children.length) { disposeGroup(group); return }
  group.visible = passMode.value
  g.passCityOrbitGroup = group
  // 挂地球固连系（passGroup）：与目标高亮面同系，轨道线才会穿过区域面
  g.passGroup?.add(group)
  // 可见性收口：AI 过境回答只让回答列出的那几颗可见（其余构建后即隐藏）
  syncPassCityOrbitVisibility()
}

/** 按当前虚拟时间更新单次过境卫星模型的位置与姿态（与 updateRegionPassModel 同一口径）。
 *  姿态用 orbitAttitude：机身长轴 = 本地 +Z = 机头，恒对齐径向天顶，即机头垂直地球朝外。
 *  位置逐帧在变（过境视图虚拟时间仍在按档位推进），故姿态必须逐帧重算，否则走出一段后机头会偏离天顶。 */
function updatePassSatModel() {
  const mesh = passSatModel
  if (!mesh || !passSatSr) return
  try {
    const pv = propagate(passSatSr, new Date(g.simTimeMs))
    if (!pv?.position) return
    const pos = eciToScene(pv.position.x, pv.position.y, pv.position.z)
    mesh.position.copy(pos)
    if (pv.velocity) {
      orbitAttitude(pos, eciToScene(pv.velocity.x, pv.velocity.y, pv.velocity.z), mesh.quaternion)
    }
  } catch { /* 单帧传播失败保持上一位置与姿态 */ }
}

/** 释放「单次过境选中卫星的模型」组（挂场景根，惯性系）并撤销轨道线的红色复染。
 *  轨道线本体归 passCityOrbitGroup（地球固连系），这里只把被复染那根的材质换回原色，不删线。 */
function clearPassSatOrbit() {
  passSatSeq++
  passSatSr = null
  passSatModel = null
  restorePassSatHlLine()
  const grp = g.passSatGroup
  if (grp) { g.scene?.remove(grp); disposeGroup(grp); g.passSatGroup = null }
}

/** 绘制「右侧过境列表选中项」的卫星：把该星已有那根轨道线复染成红色 + 放上三维模型（机头垂直地球）。
 *  轨道线不再另建 —— 城市过境已按每星过境中点画好整圈环（见 buildPassCityOrbits），这里只做复染，
 *  避免同一颗星出现「两根相位不同的环」。模型位置由 updatePassSatModel 逐帧按虚拟时间传播，
 *  虚拟时间在 focusPassRecord 里已对齐到本次过境中点，故模型出现时正落在这根红线上、位于目标区域上空。 */
async function buildPassSatOrbit(rec: PassDetailItem) {
  clearPassSatOrbit()
  const scene = g.scene
  if (!scene) return
  const gi = g.cloudList.findIndex((p) => p.norad_id === rec.norad_id)
  if (gi < 0) return
  const seq = passSatSeq
  // satrec 懒加载：TLE 未就绪时先补齐（awaitSatrecs 抗「解析期间点云被重建」）
  await awaitSatrecs()
  const sr = g.satrecs[gi]
  if (!sr || seq !== passSatSeq || !g.scene) return

  // 复染该星已存在的那根轨道线（材质换红，原材质存进 userData.baseMat 供取消选中时还原）
  const line = passCityOrbitLines.get(rec.norad_id)
  if (line) {
    line.userData.baseMat = line.material
    line.material = new THREE.LineBasicMaterial({ color: PASS_SAT_HL_COLOR, transparent: true, opacity: 0.95 })
    passSatHlLine = line
  }

  const group = new THREE.Group()
  group.name = 'pass-sat'
  const gm = await loadHeatModel(g.cloudList[gi])
  if (seq !== passSatSeq) { disposeGroup(group); return }
  if (gm) {
    const mesh = new THREE.Mesh(gm.geom.clone(), new THREE.MeshStandardMaterial({
      color: PASS_SAT_MODEL_COLOR, metalness: 0.45, roughness: 0.3,
      emissive: PASS_SAT_MODEL_COLOR, emissiveIntensity: 0.85
    }))
    mesh.scale.setScalar(HEAT_TARGET_MODEL_SCALE)
    group.add(mesh)
    passSatModel = mesh
  }
  if (seq !== passSatSeq) { disposeGroup(group); return }
  passSatSr = sr
  group.visible = passMode.value
  g.passSatGroup = group
  g.scene?.add(group)
  updatePassSatModel()
}

/** 释放目标面高亮 / 过境标记（两者均为 passGroup 的子组） */
function clearPassHighlight() {
  const grp = g.passGroup
  for (const key of ['passHighlightGroup', 'passTrackGroup'] as const) {
    const sub = g[key]
    if (!sub) continue
    grp?.remove(sub)
    disposeGroup(sub)
    g[key] = null
  }
}

/** 镜头飞到过境地表目标点（local 为 passGroup 局部坐标，内部按 passGroup 自转量换算世界坐标） */
function flyToPassPoint(local: THREE.Vector3, dist: number) {
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) return
  const rotY = g.passGroup ? g.passGroup.rotation.y : 0
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY)
  const dir = new THREE.Vector3(
    local.x * cosR + local.z * sinR,
    local.y,
    -local.x * sinR + local.z * cosR
  )
  if (dir.lengthSq() < 1e-9) return
  dir.normalize().multiplyScalar(dist)
  // 终点焦点在地心，落位时不切焦点（清掉上一次「飞行到卫星 / 交会点」的标记）
  beginCamFly(dir, _flyHomeTarget, 'none')
  // 焦点即将回到地心，恢复「绕地心」最小距离（右键环绕卫星时被放宽过）
  restoreEarthOrbitLimits()
}

/** 填充面细分粒度（三角网最长边，单位：经纬度度数）：
 *  面填充是「在经纬度平面三角化 → 顶点投到球面」，三角面本身仍是平面（弦面），
 *  弦中点会沉到球面之下，下沉量 ≈ r·(1 − cos(θ/2))（θ 为边长对应的地心角）。
 *  高亮面贴地半径只比地球高约 0.3%（≈19km），边长超过约 8.9°（≈990km）的大三角就会沉进地球，
 *  被地表贴图遮出缺口（即「穿模」）。压到 3°（≈330km，下沉约 2km）即可完全贴合球面。 */
const FACE_SUBDIV_DEG = 3
/** 细分后顶点上限（约 8 万个三角 ≈ 2.9MB）：跨 100° 以上的大目标（俄罗斯、南极洲）按 3° 细分会成百倍膨胀，
 *  超限后剩余三角原样输出（局部保留轻微穿模），换取内存与构建耗时可控。 */
const FACE_SUBDIV_MAX_POS = 240000 * 3

/** 三角网平面细分：在经纬度平面上按「最长边二分」递归切分，直到每边都短于 maxEdgeDeg。
 *  显式栈迭代（不用递归）：单个大三角可分裂上百次，递归深度会爆栈。
 *  切分点取两端的经纬度线性插值 —— 细分发生在投影之前，随后顶点才投到球面，故三角越小弦面越贴合球面。 */
function subdividePlaneTris(geo: THREE.BufferGeometry, maxEdgeDeg: number) {
  const src = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!src) return
  const idx = geo.getIndex()
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(src.count / 3)
  const maxSq = maxEdgeDeg * maxEdgeDeg
  const out: number[] = []
  const stack: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (out.length >= FACE_SUBDIV_MAX_POS) break
    const i0 = idx ? idx.getX(t * 3) : t * 3
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
    stack.length = 0
    stack.push(src.getX(i0), src.getY(i0), src.getX(i1), src.getY(i1), src.getX(i2), src.getY(i2), 0)
    while (stack.length) {
      const depth = stack.pop() as number
      const cy = stack.pop() as number; const cx = stack.pop() as number
      const by = stack.pop() as number; const bx = stack.pop() as number
      const ay = stack.pop() as number; const ax = stack.pop() as number
      const ab = (ax - bx) * (ax - bx) + (ay - by) * (ay - by)
      const bc = (bx - cx) * (bx - cx) + (by - cy) * (by - cy)
      const ca = (cx - ax) * (cx - ax) + (cy - ay) * (cy - ay)
      const longest = ab >= bc && ab >= ca ? 0 : (bc >= ca ? 1 : 2)
      const maxSeg = longest === 0 ? ab : (longest === 1 ? bc : ca)
      if (maxSeg <= maxSq || depth >= 12) {
        // 每个顶点必须补足 3 个分量：ShapeGeometry 产出的是 XY 平面（z 恒为 0），
        // 只压 x,y 会让顶点数据整体错位（后续按 Float32BufferAttribute(out, 3) 解析），
        // 三角面乱连成横穿国土的细长条纹
        out.push(ax, ay, 0, bx, by, 0, cx, cy, 0)
        continue
      }
      if (longest === 0) {
        const mx = (ax + bx) / 2; const my = (ay + by) / 2
        stack.push(mx, my, bx, by, cx, cy, depth + 1)
        stack.push(ax, ay, mx, my, cx, cy, depth + 1)
      } else if (longest === 1) {
        const mx = (bx + cx) / 2; const my = (by + cy) / 2
        stack.push(ax, ay, bx, by, mx, my, depth + 1)
        stack.push(ax, ay, mx, my, cx, cy, depth + 1)
      } else {
        const mx = (cx + ax) / 2; const my = (cy + ay) / 2
        stack.push(ax, ay, bx, by, mx, my, depth + 1)
        stack.push(mx, my, bx, by, cx, cy, depth + 1)
      }
    }
  }
  geo.setIndex(null)
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
}

/** 环是否跨日期线（相邻顶点经度跳变 > 180°）：这类环在经纬度平面里会被拉成横贯全图的形状，
 *  三角化必然失真，只能整环退出填充（边界线仍按大圆弧照画）。 */
function ringCrossesDateLine(ring: number[][]): boolean {
  const n = ring?.length || 0
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    if (Math.abs(Number(b[0]) - Number(a[0])) > 180) return true
  }
  return false
}

/** 点在环内的射线法判定（经纬度平面近似）：inner 的首点是否落在 outer 内。
 *  行政区划数据里洞与外轮廓互不相交，取环上首点即可判定该环的归属。 */
function ringInsideRing(inner: number[][], outer: number[][]): boolean {
  const pt = inner?.[0]
  if (!pt) return false
  const x = Number(pt[0])
  const y = Number(pt[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  let inside = false
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const xi = Number(outer[i][0]); const yi = Number(outer[i][1])
    const xj = Number(outer[j][0]); const yj = Number(outer[j][1])
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 多环经纬度 → 贴地球面网格几何体：
 *  先用 THREE.ShapeGeometry 在「经纬度平面」三角化（Earcut 正确处理凹多边形与内环），
 *  再把每个顶点投到半径 r 的球面。三角面是「弦面」，弦中点会沉进球面（下沉量随边长增大）——
 *  需要渲染的填充面必须传 maxEdgeDeg 先细分（见 subdividePlaneTris），否则大目标会穿模；
 *  仅用于射线拾取的网格（不渲染）可以不细分。
 *  多环归属：rings[0] 是外轮廓，其后既可能是「洞」（落在某外轮廓内），也可能是独立外轮廓 ——
 *  数据里大量第 1 环之后并非洞，而是离岛 / 飞地（加拿大 30 环、印尼 13 环、三沙市 112 环…）。
 *  一律当洞会让 Earcut 把洞外的顶点连成穿越国土的伪三角，故按点包含关系分别归入「洞」或「新外轮廓」。
 *  跨日期线的环整环退出填充并继续处理其余环（若其为主环，则不再整块丢失填充面与拾取面）。 */
function buildSphereFaceGeometry(rings: number[][][], r: number, maxEdgeDeg = 0): THREE.BufferGeometry | null {
  const contour = rings?.[0]
  if (!contour || contour.length < 3) return null
  const toV2 = (ring: number[][]) => ring.map(([lon, lat]) => new THREE.Vector2(lon, lat))
  const outers: { raw: number[][]; holes: THREE.Vector2[][] }[] = []
  for (const ring of rings) {
    if (!ring || ring.length < 3 || ringCrossesDateLine(ring)) continue
    const host = outers.find((o) => ringInsideRing(ring, o.raw))
    if (host) host.holes.push(toV2(ring))
    else outers.push({ raw: ring, holes: [] })
  }
  if (!outers.length) return null
  try {
    // 每个外轮廓建一个 Shape（其洞挂在该 Shape 上），一起交给 ShapeGeometry 三角化
    const shapes = outers.map((o) => {
      const shape = new THREE.Shape(toV2(o.raw))
      for (const hole of o.holes) shape.holes.push(new THREE.Path(hole))
      return shape
    })
    const geo = new THREE.ShapeGeometry(shapes)
    const pos0 = geo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!pos0 || pos0.count < 3) { geo.dispose(); return null }
    if (maxEdgeDeg > 0) subdividePlaneTris(geo, maxEdgeDeg)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const arr = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const p = lonLatToScene(pos.getX(i), pos.getY(i), r)
      arr[i * 3] = p.x
      arr[i * 3 + 1] = p.y
      arr[i * 3 + 2] = p.z
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    geo.computeVertexNormals()
    return geo
  } catch { return null }
}

/** 边界线圆弧加密步长（度）与单边最大分段数：与区域框选的 pushArcPoints 同一口径。
 *  球面上两点的直线弦是从球体内部穿的（弦中点下沉 ≈ r·(1 − cos(θ/2))），
 *  边界线只抬高约 0.2%（≈13km），数据里跨度过大的边（简化过的国界、离岛）会表现为
 *  一条扎进地表的长条带 / 被地球贴图吃掉一截，故一律沿大圆弧加密后再连线段。 */
const BORDER_ARC_STEP_DEG = 1.5
const BORDER_ARC_MAX_SEG = 60

/** 单条边（经纬度两点）沿大圆弧加密，逐段压入线段对（每段 2 个顶点）。
 *  相邻点角距小于步长时保持原样（seg=1），不增加任何顶点，故点密集的行政区划数据零开销。 */
function pushArcSegments(out: number[], a: number[], b: number[], r: number) {
  const va = lonLatToScene(a[0], a[1], 1)
  const vb = lonLatToScene(b[0], b[1], 1)
  // 夹角夹在 (0, π) 开区间内：slerp 的两端（重合 / 对跖）分母 sin 为 0，需要兜一手
  const ang = Math.max(1e-6, Math.min(Math.PI - 1e-3, Math.acos(Math.max(-1, Math.min(1, va.dot(vb))))))
  const seg = Math.max(1, Math.min(BORDER_ARC_MAX_SEG, Math.ceil(((ang * 180) / Math.PI) / BORDER_ARC_STEP_DEG)))
  if (seg === 1) {
    out.push(va.x * r, va.y * r, va.z * r, vb.x * r, vb.y * r, vb.z * r)
    return
  }
  const sinA = Math.sin(ang)
  let prevX = 0, prevY = 0, prevZ = 0
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const k1 = Math.sin((1 - t) * ang) / sinA
    const k2 = Math.sin(t * ang) / sinA
    const x = va.x * k1 + vb.x * k2
    const y = va.y * k1 + vb.y * k2
    const z = va.z * k1 + vb.z * k2
    if (i > 0) out.push(prevX * r, prevY * r, prevZ * r, x * r, y * r, z * r)
    prevX = x; prevY = y; prevZ = z
  }
}

/** 多环经纬度 → 球面线段顶点数组（首尾相连，供边界线 / 高亮描边），逐边沿大圆弧加密 */
function ringSegments(rings: number[][][], r: number): number[] {
  const out: number[] = []
  for (const ring of rings || []) {
    const n = ring?.length || 0
    if (n < 2) continue
    for (let i = 0; i < n; i++) pushArcSegments(out, ring[i], ring[(i + 1) % n], r)
  }
  return out
}

/** 高亮选中目标：该目标的行政区划面（半透明填充）+ 加粗边界线 */
function buildPassTargetHighlight(target: PassTargetItem) {
  const grp = g.passGroup
  if (!grp) return
  const old = g.passHighlightGroup
  if (old) { grp.remove(old); disposeGroup(old); g.passHighlightGroup = null }
  if (!target || !target.rings?.length) return

  const group = new THREE.Group()
  // 面填充：与拾取网格同源（球面三角化），用高亮色半透明呈现。
  // 必须细分（FACE_SUBDIV_DEG）：国界级的大面三角边长可达十几度，不细分会沉进球面被地表贴图遮出缺口
  const faceGeo = buildSphereFaceGeometry(target.rings, PASS_TARGET_R * 1.0015, FACE_SUBDIV_DEG)
  if (faceGeo) {
    group.add(new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial({
      color: PASS_TARGET_SEL_COLOR, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false
    })))
  }
  // 边界加粗（贴地略高于填充面，避免被面遮住）
  const seg = ringSegments(target.rings, PASS_TARGET_R * 1.0022)
  if (seg.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3))
    group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: PASS_TARGET_SEL_COLOR, transparent: true, opacity: 0.98
    })))
  }
  grp.add(group)
  g.passHighlightGroup = group
}

/** 在**空间轨道**上标出本次过境的 AOS（绿）/ 最高仰角（黄）/ LOS（洋红）三处位置。
 *  三处取该星在这三个时刻的空间位置（TLE 传播的 ECI 位置 → 场景坐标），**不是**贴地的星下点地面轨迹。
 *  相位换算：按本次过境中点把 ECI 转成 passGroup 局部坐标（R_y(−gstime(tMid))），与那根整圈轨道线
 *  （buildPassCityOrbits，选中后被复染为红色）同相位 —— 三点恰好落在那根线上；又因挂在地球固连系，
 *  随地球自转一起走，与「该星在本地的过境位置」始终自洽。
 *  返回组；userData.focusLocal 为镜头对准点（优先最高仰角时刻，无则退化为 AOS 时刻）。 */
function buildPassTrackMarks(
  sr: ReturnType<typeof twoline2satrec>,
  rec: PassDetailItem,
  tMidMs: number
): THREE.Group | null {
  const t0 = rec.aosMs
  const t1 = rec.losMs > rec.aosMs ? rec.losMs : rec.aosMs + 60000
  const gst = gstime(new Date(Number.isFinite(tMidMs) ? tMidMs : t0))
  const marks: { p: THREE.Vector3; color: number }[] = []
  const markAt = (ms: number, color: number): THREE.Vector3 | null => {
    if (!Number.isFinite(ms)) return null
    try {
      const pv = propagate(sr, new Date(ms))
      if (!pv?.position) return null
      const p = eciToScene(pv.position.x, pv.position.y, pv.position.z)
        .applyAxisAngle(PASS_ORBIT_AXIS_Y, -gst)
      marks.push({ p, color })
      return p
    } catch { /* 单点传播失败则跳过该标记 */ return null }
  }
  const aosP = markAt(t0, PASS_TRACK_COLOR)
  const maxP = rec.maxAtMs > t0 && rec.maxAtMs < t1 ? markAt(rec.maxAtMs, 0xffd166) : null
  markAt(t1, 0xff6b9d)
  if (!marks.length) return null

  const geo = new THREE.BufferGeometry().setFromPoints(marks.map((m) => m.p))
  const colors = new Float32Array(marks.length * 3)
  const col = new THREE.Color()
  marks.forEach((m, i) => { col.setHex(m.color); colors.set([col.r, col.g, col.b], i * 3) })
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const group = new THREE.Group()
  group.name = 'pass-track-marks'
  group.add(new THREE.Points(geo, new THREE.PointsMaterial({
    size: 10, sizeAttenuation: false, vertexColors: true, transparent: true
  })))
  group.userData.focusLocal = maxP ?? aosP
  return group
}

/** 选中目标：高亮该目标的行政区划面（并清掉上一条过境标记）+ 镜头转到该目标 */
function focusPassTarget(target: PassTargetItem) {
  focusPassRecord(null)
  buildPassTargetHighlight(target)
  const lon = Number.isFinite(target.longitude) ? target.longitude : 0
  const lat = Number.isFinite(target.latitude) ? target.latitude : 0
  flyToPassPoint(lonLatToScene(lon, lat, EARTH_R), PASS_FOCUS_DIST)
}

/** 选中/取消过境记录：在该星的空间轨道上标记本次过境 + 复染该星轨道线 + 卫星模型，镜头转过去
 *  （rec 为空则仅清除）。注意画的是**空间轨道**（连同 AOS/最高仰角/LOS 三处空间位置标记），
 *  不是贴地星下点地面轨迹。 */
async function focusPassRecord(rec: PassDetailItem | null) {
  // 无论选中还是取消，先撤掉上一条过境留下的标记
  const old = g.passTrackGroup
  if (old) { g.passGroup?.remove(old); disposeGroup(old); g.passTrackGroup = null }
  if (!rec) {
    // 取消选中：连同该次过境的卫星三维模型与轨道线复染一并撤掉
    clearPassSatOrbit()
    return
  }
  // 虚拟时间对齐到本次过境的**峰值时刻**（maxAtMs）：该时刻星下点正落在目标区域，按虚拟时间传播的
  // 卫星模型才会出现在目标区域上空那根红线附近（否则模型会跑到轨道另一侧甚至地球背面，看起来像「没有模型」）。
  // 旧批次存在多圈过境被合并成一条超长记录的脏数据（aos 与 los 跨越十余小时），此时中点会漂到错误半球，
  // 故一律以 maxAtMs 为准；缺失时回退中点。
  const tMid = Number.isFinite(rec.maxAtMs) ? rec.maxAtMs : (rec.aosMs + rec.losMs) / 2
  if (Number.isFinite(tMid)) { g.simTimeMs = tMid; syncEarthSpin() }

  // 先启动卫星模型 / 轨道线复染（它同步地推进 passSatSeq），再取序号做标记的竞态守卫：
  // 标记要 await satrec 就绪，两次快速切换记录时靠该序号丢弃过期标记，与卫星模型保持同一取舍（同一次点击要么都生效、要么都不生效）
  void buildPassSatOrbit(rec)
  const seq = passSatSeq
  // 过境标记：取该星 AOS / 最高仰角 / LOS 三时刻的空间位置，标在那根轨道线上（详见 buildPassTrackMarks）
  const gi = g.cloudList.findIndex((p) => p.norad_id === rec.norad_id)
  if (gi < 0) return
  // satrec 懒加载：TLE 未就绪时先补齐（awaitSatrecs 抗「解析期间点云被重建」）
  await awaitSatrecs()
  const sr = g.satrecs[gi]
  if (!sr || seq !== passSatSeq || !g.passGroup) return
  const marks = buildPassTrackMarks(sr, rec, tMid)
  if (!marks) return
  g.passTrackGroup = marks
  g.passGroup.add(marks)
  const focusLocal = marks.userData.focusLocal as THREE.Vector3 | undefined
  if (focusLocal) flyToPassPoint(focusLocal, PASS_FOCUS_DIST)
}

/* ---------------- 地表中文标签（国名 + 中国省级名 + 主要城市名） ----------------
 * 中文名来自后端（pass_geo.name_cn，词典生成）：政区 177 个全部有值；
 * 城市 1249 座中约 506 座有值（「首都或人口 >= 100 万」的 395 座主要城市全覆盖），
 * 故有 name_cn 的城市即为主城，再按人口做「随缩放显隐」分级。
 * 中国省级名由行政区划面（pass_geo.geo_type='district'）按 province_adcode 聚合得到。
 * 标签用 HTML 覆盖层渲染（CSS 像素恒定的清晰文字，不做纹理贴字），
 * 每帧按 passGroup 自转量把本地坐标换算成世界坐标后投影到屏幕。
 * ------------------------------------------------------------------ */
/** 标签贴地半径：国名 / 省名略高（不与国界线、城市点压字），城市名再高一层；省名介于两者之间 */
const PASS_LABEL_R_BORDER = EARTH_R * 1.004
const PASS_LABEL_R_PROVINCE = EARTH_R * 1.008
const PASS_LABEL_R_CITY = EARTH_R * 1.012
/** 城市标签数量上限：贴近地表时避免上百个标签互相堆叠 */
const CITY_LABEL_LIMIT = 80
/** 国名显形距离（相机距地心）：拉远到全球视角后不再显示，避免小地球上 177 个国名糊成一团。
 *  默认相机距约 5.8、拉到「半个地球宽」约 3.0，故超过 3.0 只留城市点不写字。 */
const BORDER_LABEL_REVEAL = 3.0
/** 省名显形距离：与国名同档（拉远到全球视角后中国省级名同样糊成一团，一并收起；
 *  拉近到能看清中国全境时 34 个省名铺开正好）。 */
const PROVINCE_LABEL_REVEAL = 3.0

/** 城市标签的「显形距离」（相机距地心）：人口越多、越早（拉得越远）出现，实现随缩放显隐。
 *  参照图二的洲际视角（约 2.0）：仅首都级 / 两千万以上大城（北京、东京、首尔…）在列；
 *  继续拉近到 1.5 左右主要城市全部展开，贴地（<1.2）时 100 万人口城市才出现。 */
function cityRevealDist(population: number | null): number {
  const p = Math.max(Number(population) || 0, 1e6)
  const norm = Math.min(1, Math.max(0, Math.log10(p / 1e6) / 1.6))
  return 1.2 + 0.9 * norm
}

/** 政区标签落点：取面积最大的那个环的中心（避开海外领地/飞地把重心拉偏，如法国、俄罗斯） */
function borderLabelPoint(rings: number[][][]): { lon: number; lat: number } | null {
  let best: { lon: number; lat: number } | null = null
  let bestArea = -1
  for (const ring of rings || []) {
    if (!ring || ring.length < 3) continue
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const pt of ring) {
      const lon = Number(pt[0]); const lat = Number(pt[1])
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
    if (minLon === Infinity) continue
    const area = (maxLon - minLon) * (maxLat - minLat)
    if (area > bestArea) {
      bestArea = area
      best = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 }
    }
  }
  return best
}

/** 地表标签（local 为未参与地球自转的本地坐标；reveal 为相机距地心的显形阈值） */
interface PassLabel {
  key: string
  text: string
  kind: 'country' | 'province' | 'city'
  local: THREE.Vector3
  reveal: number
}

/** 省名缩写：去掉「省 / 市 / 自治区 / 特别行政区」后缀（「广西壮族自治区」→「广西」），
 *  否则 34 个省名标签会因长名互相压字。 */
function provinceLabelText(name: string): string {
  const s = String(name || '').trim()
  if (!s) return ''
  const m = s.match(/^(.+?)(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/)
  return m ? m[1] : s
}

/** 中国省级标注：行政区划面按 province_adcode 聚合出「省名 + 落点」。
 *  · 直辖市 / 港澳台：整省就是一个目标面（level='province'），直接用它的落点中心；
 *  · 其余省份：取下辖各地级市中心的平均 —— 不用顶点均值（会被密集边界拉偏），
 *    更不能用包围盒中心（内蒙古、甘肃这类狭长省份的包围盒中心会落到省外）。 */
function buildProvinceLabels(): PassLabel[] {
  // name：省名；lonSum/latSum/n：下辖市中心的累计；selfLon/selfLat：整省即一个目标面时的落点（NaN = 无）
  const groups = new Map<string, { name: string; lonSum: number; latSum: number; n: number; selfLon: number; selfLat: number }>()
  for (const d of passDistricts.value) {
    const key = d.province_adcode || d.province || d.name
    if (!key) continue
    let g = groups.get(key)
    if (!g) {
      g = { name: d.province || d.name_cn || d.name || '', lonSum: 0, latSum: 0, n: 0, selfLon: NaN, selfLat: NaN }
      groups.set(key, g)
    }
    const lon = Number(d.longitude)
    const lat = Number(d.latitude)
    if (d.level === 'province') {
      g.selfLon = lon
      g.selfLat = lat
      g.name = d.province || d.name_cn || d.name || g.name
      continue
    }
    if (Number.isFinite(lon) && Number.isFinite(lat)) { g.lonSum += lon; g.latSum += lat; g.n++ }
  }
  const out: PassLabel[] = []
  for (const [key, g] of groups) {
    let lon = NaN
    let lat = NaN
    if (Number.isFinite(g.selfLon) && Number.isFinite(g.selfLat)) {
      lon = g.selfLon
      lat = g.selfLat
    } else if (g.n) {
      lon = g.lonSum / g.n
      lat = g.latSum / g.n
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    const text = provinceLabelText(g.name)
    if (!text) continue
    out.push({
      key: `p${key}`,
      text,
      kind: 'province',
      local: lonLatToScene(lon, lat, PASS_LABEL_R_PROVINCE),
      reveal: PROVINCE_LABEL_REVEAL
    })
  }
  return out
}

const passLabels = computed<PassLabel[]>(() => {
  const list: PassLabel[] = []
  const provinces = buildProvinceLabels()
  // 省级名集合：国界数据里中国台湾 / 中国香港等也各有一个独立面，其国名标签会与省级标签重复
  //（同一个岛并排出现「台湾」和「中国台湾」），故国名标签凡是已被省级标签覆盖的一律跳过
  const provinceTexts = provinces.map((p) => p.text)
  passBorders.value.forEach((b, i) => {
    const nameCn = b.name_cn
    if (!nameCn) return
    if (provinceTexts.some((t) => t === nameCn || t === `中国${nameCn}`)) return
    const pt = borderLabelPoint(b.rings)
    if (!pt) return
    list.push({ key: `b${i}`, text: nameCn, kind: 'country', local: lonLatToScene(pt.lon, pt.lat, PASS_LABEL_R_BORDER), reveal: BORDER_LABEL_REVEAL })
  })
  // 仅当前数据批次有过境明细的城市（passBatchCityIdSet，与地球城市点、左侧列表口径一致），按人口降序：超限时优先保留大城市
  const cities = passCities.value
    .filter((c) => passBatchCityIdSet.value.has(c.id) && c.name_cn && c.longitude != null && c.latitude != null)
    .slice()
    .sort((a, b) => (Number(b.population) || 0) - (Number(a.population) || 0))
  for (const c of cities) {
    list.push({
      key: `c${c.id}`,
      text: c.name_cn,
      kind: 'city',
      local: lonLatToScene(c.longitude, c.latitude, PASS_LABEL_R_CITY),
      reveal: cityRevealDist(c.population)
    })
  }
  // 省名放最后：DOM 顺序即层叠顺序，省名压在国名 / 城市名之上（三者重叠时优先看清省）
  list.push(...provinces)
  return list
})

const passLabelLayer = ref<HTMLDivElement>()
/** 标签 DOM 节点（与 passLabels 同序，逐帧直接写 style，不走 Vue 响应式） */
let passLabelNodes: (HTMLElement | null)[] = []
/** 标签上一帧显示状态（0 隐藏 / 1 显示 / 2 未知）：与上一帧相同就不重复写 style，省掉逐帧无谓的样式失效 */
let passLabelShown: number[] = []
/** v-for 的 ref 回调：按下标登记标签节点（新挂载的节点状态记未知，强制下一帧写一次 opacity） */
function setPassLabelNode(i: number, el: unknown) {
  passLabelNodes[i] = (el as HTMLElement) || null
  passLabelShown[i] = 2
}

/** 每帧把地表中文标签投影到屏幕：图例开关 + 缩放分级 + 背面/出屏剔除，隐藏用 opacity=0 */
function updatePassLabels() {
  const cam = g.camera
  const grp = g.passGroup
  const rect = container.value?.getBoundingClientRect()
  if (!cam || !grp || !rect) return
  const list = passLabels.value
  if (!list.length) return
  const dist = cam.position.length()
  const rotY = grp.rotation.y
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY)
  let cityShown = 0
  for (let i = 0; i < list.length; i++) {
    const el = passLabelNodes[i]
    if (!el) continue
    const it = list[i]
    // 国名跟「国界」开关、省名跟「行政区域」开关（与三维图层显隐一致），城市名跟「城市标注」开关
    let show: boolean
    if (it.kind === 'country') show = passBorderVisible.value && dist <= it.reveal
    else if (it.kind === 'province') show = passDistrictVisible.value && dist <= it.reveal
    else show = passCityVisible.value && dist <= it.reveal && cityShown < CITY_LABEL_LIMIT
    if (show) {
      const lp = it.local
      _pos.set(lp.x * cosR + lp.z * sinR, lp.y, -lp.x * sinR + lp.z * cosR)
      if (isOccludedByEarth(cam.position, _pos)) {
        show = false
      } else {
        _proj.copy(_pos).project(cam)
        if (_proj.z > 1 || _proj.z < -1) {
          show = false
        } else {
          const x = (_proj.x * 0.5 + 0.5) * rect.width
          const y = (-_proj.y * 0.5 + 0.5) * rect.height
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -160%)`
          if (it.kind === 'city') cityShown++
        }
      }
    }
    const want = show ? 1 : 0
    if (passLabelShown[i] !== want) {
      passLabelShown[i] = want
      el.style.opacity = want ? '1' : '0'
    }
  }
}

/** 星官名称标签层容器（三垣二十八宿，与地表标签同范式：逐帧手动投影 + 直写 DOM style，不走响应式） */
const mansionLabelLayer = ref<HTMLDivElement>()
/** 星官名称标签 DOM 节点（与 SKY_LABELS 同序） */
let mansionLabelNodes: (HTMLElement | null)[] = []
/** 星官名称标签上一帧显示状态（0 隐藏 / 1 显示 / 2 未知），同 passLabelShown 的省流策略 */
let mansionLabelShown: number[] = []
/** v-for 的 ref 回调：按下标登记节点，新挂载节点状态记未知强制下一帧写一次 opacity */
function setMansionLabelNode(i: number, el: unknown) {
  mansionLabelNodes[i] = (el as HTMLElement) || null
  mansionLabelShown[i] = 2
}

/** 每帧把星官名称（三垣二十八宿）投影到屏幕（挂场景根，惯性系固定不动）：背面/出屏剔除，隐藏用 opacity=0 */
function updateMansionLabels() {
  const cam = g.camera
  const rect = container.value?.getBoundingClientRect()
  if (!cam || !rect) return
  for (let i = 0; i < SKY_LABELS.length; i++) {
    const el = mansionLabelNodes[i]
    if (!el) continue
    const pos = SKY_LABELS[i].pos
    let show = !isOccludedByEarth(cam.position, pos)
    if (show) {
      _proj.copy(pos).project(cam)
      if (_proj.z > 1 || _proj.z < -1) {
        show = false
      } else {
        const x = (_proj.x * 0.5 + 0.5) * rect.width
        const y = (-_proj.y * 0.5 + 0.5) * rect.height
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -150%)`
      }
    }
    const want = show ? 1 : 0
    if (mansionLabelShown[i] !== want) {
      mansionLabelShown[i] = want
      el.style.opacity = want ? '1' : '0'
    }
  }
}

/** 星座名称标签层容器（西方 88 星座，与星官标签同范式：逐帧手动投影 + 直写 DOM style，不走响应式） */
const constellationLabelLayer = ref<HTMLDivElement>()
/** 星座名称标签 DOM 节点（与 WESTERN_LABELS 同序） */
let constellationLabelNodes: (HTMLElement | null)[] = []
/** 星座名称标签上一帧显示状态（0 隐藏 / 1 显示 / 2 未知），同 mansionLabelShown 的省流策略 */
let constellationLabelShown: number[] = []
/** v-for 的 ref 回调：按下标登记节点，新挂载节点状态记未知强制下一帧写一次 opacity */
function setConstellationLabelNode(i: number, el: unknown) {
  constellationLabelNodes[i] = (el as HTMLElement) || null
  constellationLabelShown[i] = 2
}

/** 每帧把西方 88 星座名投影到屏幕（挂场景根，惯性系固定不动）：背面/出屏剔除，隐藏用 opacity=0 */
function updateConstellationLabels() {
  const cam = g.camera
  const rect = container.value?.getBoundingClientRect()
  if (!cam || !rect) return
  for (let i = 0; i < WESTERN_LABELS.length; i++) {
    const el = constellationLabelNodes[i]
    if (!el) continue
    const pos = WESTERN_LABELS[i].pos
    let show = !isOccludedByEarth(cam.position, pos)
    if (show) {
      _proj.copy(pos).project(cam)
      if (_proj.z > 1 || _proj.z < -1) {
        show = false
      } else {
        const x = (_proj.x * 0.5 + 0.5) * rect.width
        const y = (-_proj.y * 0.5 + 0.5) * rect.height
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -150%)`
      }
    }
    const want = show ? 1 : 0
    if (constellationLabelShown[i] !== want) {
      constellationLabelShown[i] = want
      el.style.opacity = want ? '1' : '0'
    }
  }
}

/* ============================================================
 * 区域过境：三维框选（射线拾取地表经纬度 → 逐点连线 → 提交现算）
 *  - 拾取用 THREE.Ray.intersectSphere 对数学球求解析解，不用 raycaster.intersectObjects(地球 mesh)：
 *    与本项目 pickNearestAt 的取舍一致（避免逐三角形求交），且解析解在球面拾取上精度更好；
 *  - 交点先换算到 passGroup 局部坐标（该组只绕 Y 旋转，手工做逆旋转），再按 lonLatToScene 的逆式反算经纬度；
 *  - 绘制全部挂在 g.passGroup 下（随贴图自转同源旋转），面/描边/顶点按半径分层避免 z-fighting。
 * ============================================================ */
const _pickRay = new THREE.Ray()
const _pickSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), EARTH_R)
const _pickHit = new THREE.Vector3()
const _pickNdc = new THREE.Vector2()

/** 预览线（最后一个顶点 → 光标）在重建叠加层时创建，移动鼠标时只改坐标不重建几何 */
let regionPreviewLine: THREE.Line | null = null

/** 屏幕像素 → 地表经纬度（射线未命中地球返回 null）。
 *  Cesium 模式走 Cesium 精确拾取：优先含地形的真实地表（pickPosition），退回 WGS84 椭球交点
 *  （pickEllipsoid）——与 Cesium 影像/地形表面同口径（本局数学球口径会带 ~21km 椭球扁率视差）；
 *  Three 兜底模式仍走解析球交点。调用点传的是画布局部像素，两画布同容器 inset:0，加 rect 偏移即 client 坐标。 */
function pickEarthLonLat(px: number, py: number): { lon: number; lat: number } | null {
  const renderer = g.renderer, cam = g.camera
  if (!renderer || !cam) return null
  if (cesiumActive) {
    const crect = renderer.domElement.getBoundingClientRect()
    const hit = cesiumPickEarthLonLat(px + crect.left, py + crect.top)
    return hit ? { lon: hit.lon, lat: hit.lat } : null
  }
  const rect = renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  _pickNdc.x = (px / rect.width) * 2 - 1
  _pickNdc.y = -(py / rect.height) * 2 + 1
  _pickRay.origin.copy(cam.position)
  _pickRay.direction.set(_pickNdc.x, _pickNdc.y, 0.5).unproject(cam).sub(cam.position).normalize()
  const hit = _pickRay.intersectSphere(_pickSphere, _pickHit)
  if (!hit) return null
  // 世界坐标 → passGroup 局部坐标：正向 world = (x·cosR + z·sinR, y, −x·sinR + z·cosR)，
  // 逆变换 local.x = wx·cosR − wz·sinR、local.z = wx·sinR + wz·cosR（比 worldToLocal 少一次矩阵求逆）
  const rotY = g.passGroup ? g.passGroup.rotation.y : 0
  const cosR = Math.cos(rotY)
  const sinR = Math.sin(rotY)
  const wx = hit.x, wy = hit.y, wz = hit.z
  const lx = wx * cosR - wz * sinR
  const lz = wx * sinR + wz * cosR
  const len = Math.sqrt(lx * lx + wy * wy + lz * lz) || 1
  return {
    lat: (Math.asin(Math.max(-1, Math.min(1, wy / len))) * 180) / Math.PI,
    lon: (Math.atan2(-lz, lx) * 180) / Math.PI
  }
}

/** 区域局部平面基：顶点单位向量平均得中心，再取东 / 北切向基（与后端 buildRegionGeom 同一套口径）。
 *  场景坐标里 Y 轴是极轴，故中心接近极点时改用 X 轴作参考向量。 */
function regionPlaneBasis(pts: { lon: number; lat: number }[]) {
  const up = new THREE.Vector3()
  for (const p of pts) up.add(lonLatToScene(p.lon, p.lat, 1))
  if (up.lengthSq() < 1e-9) return null
  up.normalize()
  const ref = Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const east = new THREE.Vector3().crossVectors(ref, up).normalize()
  const north = new THREE.Vector3().crossVectors(up, east).normalize()
  return { up, east, north }
}

/** 一条边（经纬度两点）沿大圆弧加密：单位向量 slerp 后缩放到半径 r。
 *  includeEnd=false 用于闭合环（终点由下一条边补上，避免重复点）；
 *  true 用于开放折线（两点草稿 / 光标预览线）。 */
function pushArcPoints(
  out: THREE.Vector3[],
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
  r: number,
  includeEnd: boolean
) {
  const va = lonLatToScene(a.lon, a.lat, 1)
  const vb = lonLatToScene(b.lon, b.lat, 1)
  // 夹角夹在 (0, π) 开区间内：slerp 的两端（重合 / 对跖）分母 sin 为 0，需要兜一手
  const ang = Math.max(1e-6, Math.min(Math.PI - 1e-3, Math.acos(Math.max(-1, Math.min(1, va.dot(vb))))))
  const seg = Math.max(1, Math.min(REGION_ARC_MAX_SEG, Math.ceil(ang / REGION_ARC_STEP)))
  const sinA = Math.sin(ang)
  const last = includeEnd ? seg : seg - 1
  for (let i = 0; i <= last; i++) {
    const t = i / seg
    const k1 = Math.sin((1 - t) * ang) / sinA
    const k2 = Math.sin(t * ang) / sinA
    out.push(new THREE.Vector3(va.x * k1 + vb.x * k2, va.y * k1 + vb.y * k2, va.z * k1 + vb.z * k2).multiplyScalar(r))
  }
}

/** 闭合环的贴地折线：逐边沿大圆弧加密，末边不重复起点（由 LineLoop 收口） */
function regionRingPoints(pts: { lon: number; lat: number }[], r: number): THREE.Vector3[] {
  const ring: THREE.Vector3[] = []
  for (let i = 0; i < pts.length; i++) pushArcPoints(ring, pts[i], pts[(i + 1) % pts.length], r, false)
  return ring
}

/** 平面三角形按最长边中点递归二分，边长收敛到 maxLen 后把三个顶点压进 out（x,y 交替）。
 *  深度上限 8 级：极端输入（超长边）也不会把顶点数打爆。 */
function subdivideTriangle(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  maxLen: number, depth: number, out: number[]
) {
  const ab = Math.hypot(bx - ax, by - ay)
  const bc = Math.hypot(cx - bx, cy - by)
  const ca = Math.hypot(ax - cx, ay - cy)
  const longest = Math.max(ab, bc, ca)
  if (longest <= maxLen || depth >= 8) {
    out.push(ax, ay, bx, by, cx, cy)
    return
  }
  if (longest === ab) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2
    subdivideTriangle(ax, ay, mx, my, cx, cy, maxLen, depth + 1, out)
    subdivideTriangle(mx, my, bx, by, cx, cy, maxLen, depth + 1, out)
  } else if (longest === bc) {
    const mx = (bx + cx) / 2, my = (by + cy) / 2
    subdivideTriangle(ax, ay, bx, by, mx, my, maxLen, depth + 1, out)
    subdivideTriangle(ax, ay, mx, my, cx, cy, maxLen, depth + 1, out)
  } else {
    const mx = (cx + ax) / 2, my = (cy + ay) / 2
    subdivideTriangle(ax, ay, bx, by, mx, my, maxLen, depth + 1, out)
    subdivideTriangle(mx, my, bx, by, cx, cy, maxLen, depth + 1, out)
  }
}

const _fillV = new THREE.Vector3()

/** 球面多边形 → 贴地面网格：顶点先 gnomonic 投影到区域局部平面（切平面内直线 = 球面大圆弧，
 *  故边界无需额外加密），交给 ShapeGeometry 三角剖分（earcut，支持凹多边形）；
 *  再把每个三角形按最长边细分到约 1.5° 量级，最后逐点反投影回球面。
 *  细分这一步是必需的：三角形直接投影时面片是平面，跨区域大时会切进球体（表现为面被地球吃掉一块）。
 *  区域跨度过大（有顶点落到另一半球）时返回 null，调用方退化为只画描边。 */
function buildRegionFillGeometry(pts: { lon: number; lat: number }[], r: number): THREE.BufferGeometry | null {
  const basis = regionPlaneBasis(pts)
  if (!basis) return null
  const { up, east, north } = basis
  const shape = new THREE.Shape()
  let extent = 0
  for (let i = 0; i < pts.length; i++) {
    const u = lonLatToScene(pts[i].lon, pts[i].lat, 1)
    const dn = u.dot(up)
    if (dn <= 0.05) return null
    const x = u.dot(east) / dn
    const y = u.dot(north) / dn
    extent = Math.max(extent, Math.abs(x), Math.abs(y))
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  shape.closePath()
  const planar = new THREE.ShapeGeometry(shape)
  const triPos = planar.getAttribute('position') as THREE.BufferAttribute
  // ShapeGeometry 是「带索引」几何：position 是去重后的顶点表，三角形要按 index 三元组取。
  // 若按 position 顺序每 3 个当作一个三角形，顶点数不是 3 的倍数时（四边形 4 点即如此）
  // 只有前 3 个点参与剖分，填充面会退化成「前三个顶点围成的三角形」。
  const idx = planar.getIndex()
  if (!idx) { planar.dispose(); return null }
  // 细分边长上限随区域尺度自适应：区域越大格子越粗，顶点数保持在可控范围
  const maxLen = Math.max(0.015, extent / 22)
  const flat: number[] = []
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i)
    const b = idx.getX(i + 1)
    const c = idx.getX(i + 2)
    subdivideTriangle(
      triPos.getX(a), triPos.getY(a),
      triPos.getX(b), triPos.getY(b),
      triPos.getX(c), triPos.getY(c),
      maxLen, 0, flat
    )
  }
  planar.dispose()
  // 退化多边形（顶点共线等）剖分不出三角形：直接放弃面填充，只留描边
  if (flat.length < 6) return null
  const arr = new Float32Array((flat.length / 2) * 3)
  for (let i = 0, o = 0; i < flat.length; i += 2, o += 3) {
    _fillV.copy(up).addScaledVector(east, flat[i]).addScaledVector(north, flat[i + 1]).normalize().multiplyScalar(r)
    arr[o] = _fillV.x
    arr[o + 1] = _fillV.y
    arr[o + 2] = _fillV.z
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  geo.computeBoundingSphere()
  return geo
}

/** 释放框选叠加层（挂在 passGroup 下的子组） */
function clearRegionOverlay() {
  regionPreviewLine = null
  if (g.regionGroup) {
    g.regionGroup.parent?.remove(g.regionGroup)
    disposeGroup(g.regionGroup)
    g.regionGroup = null
  }
}

/** 重建框选叠加层：描边闭环 + 半透明面 + 顶点标记 + 预览线（画布上无顶点时仅清空）。
 *  描边与预览线都沿大圆弧加密，避免直线弦穿进地球（穿模）。 */
function rebuildRegionOverlay() {
  clearRegionOverlay()
  const grp = g.passGroup
  const pts = regionDraft.value
  if (!grp || (!pts.length && !regionDrawMode.value)) return
  const root = new THREE.Group()
  root.name = 'region-draft'

  if (pts.length === 2) {
    // 只有两点：画一条开放大圆弧（此时用 LineLoop 会按直线弦从球内闭合，反而穿模）
    const arc: THREE.Vector3[] = []
    pushArcPoints(arc, pts[0], pts[1], REGION_EDGE_R, true)
    root.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(arc),
      new THREE.LineBasicMaterial({ color: REGION_EDGE_COLOR, transparent: true, opacity: 0.95 })
    ))
  } else if (pts.length >= 3) {
    // 三点及以上：首尾相连的闭合环
    root.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(regionRingPoints(pts, REGION_EDGE_R)),
      new THREE.LineBasicMaterial({ color: REGION_EDGE_COLOR, transparent: true, opacity: 0.95 })
    ))
  }
  if (pts.length >= 3) {
    const fillGeo = buildRegionFillGeometry(pts, REGION_FILL_R)
    if (fillGeo) {
      root.add(new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
        color: REGION_FILL_COLOR, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false
      })))
    }
  }
  if (pts.length) {
    const geo = new THREE.BufferGeometry().setFromPoints(
      pts.map((p) => lonLatToScene(p.lon, p.lat, REGION_VERTEX_R))
    )
    root.add(new THREE.Points(geo, new THREE.PointsMaterial({
      color: REGION_EDGE_COLOR, size: 7, sizeAttenuation: false, transparent: true, opacity: 1
    })))
  }
  // 预览线：预分配整段圆弧的最大点数缓冲，鼠标移动时只改坐标 + drawRange（避免每次 move 重建几何）
  if (regionDrawMode.value && pts.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(REGION_PREVIEW_MAX_PTS * 3), 3))
    geo.setDrawRange(0, 0)
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: REGION_PREVIEW_COLOR, transparent: true, opacity: 0.85 })
    )
    line.visible = false
    regionPreviewLine = line
    root.add(line)
  }
  grp.add(root)
  g.regionGroup = root
}

/* ============================================================
 * 多区域过境：多个区域的框选叠加层（与单区域共用同一套绘制工具，但状态完全独立）
 *  - 已完成的区域用一种颜色、正在框的草稿用另一种颜色，避免混淆；
 *  - 每个区域各自闭合（LineLoop），互不相连；
 *  - 与单区域同款规则：双击 / 点回起始点 / 面板「完成本区域」结束当前区域，
 *    结束后草稿清空、可继续框下一个（这正是「多区域」的交互形态）。
 * ============================================================ */
/** 画一个区域的叠加（闭合环 + 半透明填充 + 顶点），返回 Group */
function buildAreaOverlay(pts: { lon: number; lat: number }[], color: number, fillOpacity: number): THREE.Group | null {
  if (pts.length < 3) return null
  const grp = new THREE.Group()
  grp.add(new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(regionRingPoints(pts, REGION_EDGE_R)),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
  ))
  const fillGeo = buildRegionFillGeometry(pts, REGION_FILL_R)
  if (fillGeo) {
    grp.add(new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: fillOpacity, side: THREE.DoubleSide, depthWrite: false
    })))
  }
  grp.add(new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(pts.map((p) => lonLatToScene(p.lon, p.lat, REGION_VERTEX_R))),
    new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, transparent: true, opacity: 1 })
  ))
  return grp
}

/** 点选过境记录 / 「同时覆盖」卡片时回显的**目标区域轮廓**（闭合环 + 半透明填充 + 顶点）。
 *  与框选叠加层同一套绘制口径（buildAreaOverlay），颜色取「区域」黄 —— 条带只说明「扫到了哪一段」，
 *  轮廓才能回答「是哪（几）个区域」。
 *  为什么必须单独回画：批次结果里的区域未必是本次框选的那些（打开面板即自动载入上一批次结果、
 *  也可能直接载入已存组合），此时球面上没有任何框选叠加层，不画轮廓就等于看不到区域。
 *  返回的 Group 挂进本次过境的扫描叠加组，随该槽位一起被替换 / 释放，不引入新的槽位状态。 */
function buildPickRegionOverlay(polys: { lon: number; lat: number }[][]): THREE.Group | null {
  const root = new THREE.Group()
  root.name = 'pass-pick-region'
  for (const pts of polys) {
    const sub = buildAreaOverlay(pts, PASS_PICK_REGION_COLOR, 0.18)
    if (sub) root.add(sub)
  }
  return root.children.length ? root : null
}

/** 释放多区域框选叠加层 */
function clearMultiOverlay() {
  if (g.multiGroup) {
    g.multiGroup.parent?.remove(g.multiGroup)
    disposeGroup(g.multiGroup)
    g.multiGroup = null
  }
}

/** 重建多区域框选叠加层：已完成区域（描边色）+ 当前草稿（预览色） */
function rebuildMultiOverlay() {
  clearMultiOverlay()
  const grp = g.passGroup
  const done = multiAreas.value
  const draft = multiDraft.value
  if (!grp || (!done.length && !draft.length && !multiDrawMode.value)) return
  const root = new THREE.Group()
  root.name = 'multi-region-draft'
  for (const a of done) {
    const sub = buildAreaOverlay(a.points, REGION_EDGE_COLOR, 0.16)
    if (sub) root.add(sub)
  }
  if (draft.length >= 3) {
    const sub = buildAreaOverlay(draft, REGION_PREVIEW_COLOR, 0.22)
    if (sub) root.add(sub)
  } else if (draft.length) {
    // 不足 3 点：先画顶点与折线，便于确认已点位置
    root.add(new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(draft.map((p) => lonLatToScene(p.lon, p.lat, REGION_VERTEX_R))),
      new THREE.PointsMaterial({ color: REGION_PREVIEW_COLOR, size: 7, sizeAttenuation: false, transparent: true, opacity: 1 })
    ))
    if (draft.length >= 2) {
      const arc: THREE.Vector3[] = []
      for (let i = 0; i + 1 < draft.length; i++) pushArcPoints(arc, draft[i], draft[i + 1], REGION_EDGE_R, true)
      root.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arc),
        new THREE.LineBasicMaterial({ color: REGION_PREVIEW_COLOR, transparent: true, opacity: 0.95 })
      ))
    }
  }
  grp.add(root)
  g.multiGroup = root
}

/** 多区域：追加一个顶点（规则与单区域一致：越界/重合/超上限给提示；双击或点回起点 = 完成本区域） */
function addMultiVertex(px: number, py: number) {
  const pts = multiDraft.value
  const now = performance.now()
  if (
    pts.length >= 3 &&
    now - lastVertexTs < REGION_DBLCLICK_MS &&
    Math.abs(px - lastVertexX) <= REGION_DBLCLICK_PX &&
    Math.abs(py - lastVertexY) <= REGION_DBLCLICK_PX
  ) {
    finishMultiArea()
    return
  }
  const hit = pickEarthLonLat(px, py)
  if (!hit) { multiHint.value = '请点击地球表面（当前光标不在球面上）'; return }
  if (pts.length >= 3 && hitFirstRegionVertex(px, py, pts[0])) { finishMultiArea(); return }
  if (pts.length >= REGION_MAX_POINTS) { multiHint.value = `单个区域最多 ${REGION_MAX_POINTS} 个顶点`; return }
  const last = pts[pts.length - 1]
  if (last && Math.abs(last.lon - hit.lon) < 1e-6 && Math.abs(last.lat - hit.lat) < 1e-6) return
  multiDraft.value = [...pts, { lon: Number(hit.lon.toFixed(6)), lat: Number(hit.lat.toFixed(6)) }]
  lastVertexTs = now
  lastVertexX = px
  lastVertexY = py
  multiHint.value = `当前区域已选 ${multiDraft.value.length} 个顶点`
    + (multiDraft.value.length < 3 ? '（至少 3 个）' : '（双击 / 点回起点 / 点「完成本区域」结束，然后接着框下一个）')
}

/** 多区域：完成当前区域（≥3 点才收进列表，随后可继续框下一个） */
function finishMultiArea() {
  const pts = multiDraft.value
  if (pts.length >= 3) {
    multiAreas.value = [...multiAreas.value, { name: `区域${multiAreas.value.length + 1}`, points: pts }]
    multiDraft.value = []
    multiHint.value = `已完成 ${multiAreas.value.length} 个区域，可继续框选下一个`
  } else if (pts.length) {
    multiHint.value = '当前区域顶点不足 3 个，无法构成区域'
  }
}

/** 多区域：撤销当前区域最后一个顶点 */
function removeLastMultiVertex() {
  const pts = multiDraft.value
  if (!pts.length) return
  multiDraft.value = pts.slice(0, -1)
  multiHint.value = multiDraft.value.length ? `当前区域已选 ${multiDraft.value.length} 个顶点` : ''
}

/** 多区域：清空全部（已完成的区域 + 当前草稿） */
function clearMultiAreas() {
  multiAreas.value = []
  multiDraft.value = []
  multiHint.value = ''
}

/** 多区域：开关框选模式（与单区域框选互斥；开启期间虚拟时间冻结，见动画循环的 interacting 判定） */
function setMultiDrawMode(on: boolean) {
  // 与单区域框选互斥：两个模式同时开着会让「点击落到哪个草稿」变得不确定
  if (on) regionDrawMode.value = false
  multiDrawMode.value = on
  if (on) {
    lastVertexTs = 0
    multiHint.value = multiDraft.value.length
      ? `当前区域已选 ${multiDraft.value.length} 个顶点`
      : '在地球上依次点击选点，至少 3 个；双击 / 点回起点 / 点「完成本区域」结束当前区域'
  } else {
    finishMultiArea()
    multiHint.value = multiAreas.value.length ? `已框选 ${multiAreas.value.length} 个区域，可提交扫描` : ''
  }
  rebuildMultiOverlay()
}

// 多区域草稿 / 已完成区域变化即重绘（数据驱动：外部只要改 scene.ts 的这两个 ref 就会刷新地球上的框选）
watch([multiDraft, multiAreas], () => rebuildMultiOverlay())

/** 更新预览线（最后顶点 → 光标）：同样沿大圆弧加密，落点在地球背面时线段自然被球体遮挡；
 *  光标未落在地球上时隐藏 */
function updateRegionPreview(px: number, py: number) {
  const line = regionPreviewLine
  if (!line) return
  const pts = regionDraft.value
  if (!pts.length) { line.visible = false; return }
  const hit = pickEarthLonLat(px, py)
  if (!hit) { line.visible = false; return }
  const a = pts[pts.length - 1]
  const va = lonLatToScene(a.lon, a.lat, 1)
  const vb = lonLatToScene(hit.lon, hit.lat, 1)
  const ang = Math.max(1e-6, Math.min(Math.PI - 1e-3, Math.acos(Math.max(-1, Math.min(1, va.dot(vb))))))
  const seg = Math.max(1, Math.min(REGION_ARC_MAX_SEG, Math.ceil(ang / REGION_ARC_STEP)))
  const sinA = Math.sin(ang)
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const k1 = Math.sin((1 - t) * ang) / sinA
    const k2 = Math.sin(t * ang) / sinA
    attr.setXYZ(
      i,
      (va.x * k1 + vb.x * k2) * REGION_VERTEX_R,
      (va.y * k1 + vb.y * k2) * REGION_VERTEX_R,
      (va.z * k1 + vb.z * k2) * REGION_VERTEX_R
    )
  }
  attr.needsUpdate = true
  line.geometry.setDrawRange(0, seg + 1)
  line.geometry.computeBoundingSphere()
  line.visible = true
}

/** 屏幕落点是否命中「起始顶点」（像素容差内）：点回起点即手动闭合框选 */
function hitFirstRegionVertex(px: number, py: number, first: { lon: number; lat: number }) {
  const renderer = g.renderer, cam = g.camera, grp = g.passGroup
  if (!renderer || !cam || !grp) return false
  const rect = renderer.domElement.getBoundingClientRect()
  // passGroup 仅绕 Y 旋转：手工换算世界坐标（与 targetGroup 的贴地物同一口径）
  const rotY = grp.rotation.y
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY)
  const lp = lonLatToScene(first.lon, first.lat, REGION_VERTEX_R)
  _pos.set(lp.x * cosR + lp.z * sinR, lp.y, -lp.x * sinR + lp.z * cosR)
  if (isOccludedByEarth(cam.position, _pos)) return false
  _proj.copy(_pos).project(cam)
  if (_proj.z > 1 || _proj.z < -1) return false
  const sx = (_proj.x * 0.5 + 0.5) * rect.width
  const sy = (-_proj.y * 0.5 + 0.5) * rect.height
  const dx = sx - px, dy = sy - py
  return dx * dx + dy * dy <= REGION_CLOSE_TOLERANCE_PX * REGION_CLOSE_TOLERANCE_PX
}

/** 上一次落点的时间与屏幕坐标：用于识别「双击」（dblclick 由两次 click 组成，第二次不应再落一个重合顶点） */
let lastVertexTs = 0
let lastVertexX = 0
let lastVertexY = 0

/** 追加一个框选顶点：落在球外 / 与上一点重合 / 超上限时给出提示；
 *  双击（同点同刻第二次落点）与点回起始点都视为「闭合结束」，不再追加顶点。 */
function addRegionVertex(px: number, py: number) {
  const pts = regionDraft.value
  const now = performance.now()
  if (
    pts.length >= 3 &&
    now - lastVertexTs < REGION_DBLCLICK_MS &&
    Math.abs(px - lastVertexX) <= REGION_DBLCLICK_PX &&
    Math.abs(py - lastVertexY) <= REGION_DBLCLICK_PX
  ) {
    finishRegionDraft()
    return
  }
  const hit = pickEarthLonLat(px, py)
  if (!hit) { regionHint.value = '请点击地球表面（当前光标不在球面上）'; return }
  if (regionDrawMode.value && pts.length >= 3 && hitFirstRegionVertex(px, py, pts[0])) {
    finishRegionDraft()
    return
  }
  if (pts.length >= REGION_MAX_POINTS) {
    regionHint.value = `最多 ${REGION_MAX_POINTS} 个顶点，请先完成或清空`
    return
  }
  const last = pts[pts.length - 1]
  if (last && Math.abs(last.lon - hit.lon) < 1e-6 && Math.abs(last.lat - hit.lat) < 1e-6) return
  regionDraft.value = [...pts, { lon: Number(hit.lon.toFixed(6)), lat: Number(hit.lat.toFixed(6)) }]
  lastVertexTs = now
  lastVertexX = px
  lastVertexY = py
  regionHint.value = `已选 ${regionDraft.value.length} 个顶点${regionDraft.value.length < 3 ? '（至少 3 个才能计算）' : ''}`
}

/** 撤销最后一个顶点 */
function removeLastRegionVertex() {
  const pts = regionDraft.value
  if (!pts.length) return
  regionDraft.value = pts.slice(0, -1)
  regionHint.value = regionDraft.value.length
    ? `已选 ${regionDraft.value.length} 个顶点${regionDraft.value.length < 3 ? '（至少 3 个才能计算）' : ''}`
    : '在地球上依次点击选点，至少 3 个点'
}

/** 清空框选（顶点与叠加层一并清除） */
function clearRegionDraft() {
  regionDraft.value = []
  regionHint.value = ''
}

// 顶点草稿变化即重绘（数据驱动）：外部只要改 scene.ts 的 regionDraft 就会刷新地球上的框选，
// 无需各自记得调重绘（区域库回填顶点、面板清空等都走这一条路径）
watch(regionDraft, () => rebuildRegionOverlay())

/** 结束本轮框选（双击 / 点回起始点 / 面板「完成框选」）：
 *  退出框选模式并收起预览线；顶点草稿保留（描边闭环 + 面填充继续显示），可提交计算。
 *  注意：闭合是「顶点首尾相连」——描边用 LineLoop 收口，提交后端时同样按闭合多边形处理。 */
function finishRegionDraft() {
  setRegionDrawMode(false)
  if (regionDraft.value.length >= 3) {
    regionHint.value = `已选 ${regionDraft.value.length} 个顶点（已首尾闭合，可提交计算）`
  }
}

/** 双击结束框选（PC 快捷；移动端用面板「完成框选」按钮）。
 *  双击的第二次落点已在 addRegionVertex 中被识别并触发闭合，这里只作兜底。 */
function onRegionDblClick() {
  if (regionDrawMode.value) finishRegionDraft()
}

/** 开启 / 关闭框选模式（开启期间虚拟时间冻结，见动画循环的 interacting 判定） */
function setRegionDrawMode(on: boolean) {
  // 与多区域框选互斥（两个模式同时开着会让「点击落到哪个草稿」变得不确定）
  if (on) multiDrawMode.value = false
  regionDrawMode.value = on
  const el = g.renderer?.domElement
  if (el) {
    el.removeEventListener('dblclick', onRegionDblClick)
    if (on) el.addEventListener('dblclick', onRegionDblClick)
  }
  if (on) {
    // 重置双击计时：换一轮框选时不受上一轮的落点影响
    lastVertexTs = 0
    regionHint.value = regionDraft.value.length
      ? `已选 ${regionDraft.value.length} 个顶点`
      : '在地球上依次点击选点，至少 3 个（双击、点回起始点或点「完成框选」结束）'
  } else {
    regionHint.value = regionDraft.value.length ? `已选 ${regionDraft.value.length} 个顶点（可提交计算）` : ''
  }
  rebuildRegionOverlay()
}

/* ============================================================
 * 区域过境：选中记录的「卫星模型 + 轨道 + 扫描区域」
 * 列表点击后绘制三件套，判定口径与后端 lib/passRegionScan.js 完全一致：
 *  · 卫星模型 / 整圈轨道线 → 惯性系（ECI），挂场景根，不随地球自转；
 *  · 扫描区域 / 星下点轨迹 → 贴地（ECEF），挂 passGroup 子组，随地球自转；
 *  三者时刻一致靠「虚拟时间对齐过境窗口」保证：选中时把 g.simTimeMs 置为 AOS，
 *  播放时沿 AOS→LOS 推进，静止时冻结（见动画循环）。
 * 「扫描区域」画两层（与用户确认的口径一致）：
 *  · 判定可达范围（半透明打底）—— 沿轨迹以星下点为中心、半径 half_width_km 的判定圆扫出的等宽带；
 *  · 成像条带（窄条高亮）—— 按所需侧摆偏移中心线、宽度 swath_km 的真实成像带。
 * ============================================================ */
/** 扫描区域贴合半径：打底面 / 成像条带 / 星下点轨迹分三层抬高，互不 z-fighting。
 *  取值**低于**框选草稿的 REGION_FILL_R / EDGE_R / VERTEX_R ——
 *  框选区域是使用者的参照物、压在最上面，才能同时看清「所框区域」与「扫描覆盖」的相交关系。 */
const REGION_PASS_FILL_R = EARTH_R * 1.0075
const REGION_PASS_BAND_R = EARTH_R * 1.0095
const REGION_PASS_TRACK_R = EARTH_R * 1.0115
/** 星下点轨迹采样步数（AOS→LOS 通常数分钟，96 段已足够平滑） */
const REGION_PASS_TRACK_STEPS = 96
/** 整圈轨道线采样步数（与 buildHeatSelOrbits 同量级） */
const REGION_PASS_ORBIT_STEPS = 384
/** 播放倍速：过境窗口通常 5~10 分钟，60× 播完约 5~10 秒 */
const REGION_PASS_PLAY_SPEED = 60
/** 配色：打底面（青蓝）/ 成像条带（洋红 —— 刻意避开框选边的黄色，否则两条边叠在一起分不清）/
 *  星下点轨迹（绿）/ 轨道线与模型（青蓝） */
const REGION_PASS_FILL_COLOR = 0x37c2ff
const REGION_PASS_BAND_COLOR = 0xff6b9d
const REGION_PASS_TRACK_COLOR = 0x7dffb0
const REGION_PASS_ORBIT_COLOR = 0x37c2ff
/** 点选过境记录时回显的**目标区域轮廓**颜色：沿用「区域」黄（与框选 / 区域库叠加层同色）。
 *  条带（青蓝 / 洋红）回答「扫到了哪一段」，区域轮廓（黄）回答「是哪（几）个区域」。 */
const PASS_PICK_REGION_COLOR = 0xffd166

/** 一次过境的地面采样帧：星下点单位向量 + 指向目标一侧的切向基 */
interface RegionPassFrame { u: THREE.Vector3; side: THREE.Vector3 }

/** 过境选中记录的两种归属：单区域过境 / 多区域过境。
 *  两者的**几何构建与播放逻辑只有一份**（下面按 kind 取槽位），差别仅在挂载点与状态槽 ——
 *  两套状态彼此独立：可各自选中、各自播放，互不打断；面板互斥，同屏只显示自己那套。 */
type PassKind = 'region' | 'multi'

/** 过境选中标识（单区域不带 area_index，多区域带区域序号） */
type PassSelKey = { norad_id: number; aos_ms: number; area_index?: number }

/** 一套过境选中态（单区域 / 多区域各持一份） */
interface PassSlot {
  /** 绘制序号：异步构建（satrec 懒加载 + 模型下载）期间若已切换记录，用它丢弃过期结果 */
  seq: number
  /** 当前选中过境的 [AOS, LOS] 毫秒；t1 <= t0 表示未选中（此时虚拟时间按真实时钟正常推进） */
  t0: number
  t1: number
  /** 当前选中卫星的 satrec 与模型（模型位置每帧按虚拟时间传播，播放时沿轨道飞行） */
  sr: ReturnType<typeof twoline2satrec> | null
  model: THREE.Mesh | null
  /** 选中标识 / 播放开关 / 播放进度（响应式，面板与列表据此高亮与显示播放条） */
  sel: Ref<PassSelKey | null>
  playing: Ref<boolean>
  progress: Ref<number>
  /** GState 槽位键名：空气系组（挂场景根，不随自转）/ 贴地扫描组（passGroup 子组，随自转） */
  airKey: 'regionPassGroup' | 'multiPassGroup'
  scanKey: 'regionPassScanGroup' | 'multiPassScanGroup'
  airName: string
  scanName: string
}

const passSlots: Record<PassKind, PassSlot> = {
  region: {
    seq: 0, t0: 0, t1: 0, sr: null, model: null,
    sel: regionPassSel, playing: regionPassPlaying, progress: regionPassProgress,
    airKey: 'regionPassGroup', scanKey: 'regionPassScanGroup',
    airName: 'region-pass-air', scanName: 'region-pass-scan'
  },
  multi: {
    seq: 0, t0: 0, t1: 0, sr: null, model: null,
    sel: multiPassSel, playing: multiPassPlaying, progress: multiPassProgress,
    airKey: 'multiPassGroup', scanKey: 'multiPassScanGroup',
    airName: 'multi-pass-air', scanName: 'multi-pass-scan'
  }
}

/** 地球自转同步：passGroup / earthFixedGroup.rotation.y = gstime，保证地表叠加物（过境目标面 /
 *  区域 / 发射站 / 极光环）始终贴在地理位置上 —— Cesium 底座模式下亦然：Cesium 地球是地固系
 *  （贴图/地形钉在经纬度），叠加物随 gst 旋转才能与影像表面对齐。动画循环每帧调用；
 *  切换过境窗口（虚拟时间跳变）时也需立即同步一次。 */
function syncEarthSpin() {
  const gst = gstime(new Date(g.simTimeMs))
  // Three 地球贴图 offset 仅降级模式存在（g.earthMat 在 Cesium 模式下随 earthMesh 一并隐藏，贴图停更无妨）
  if (g.earthMat?.map) {
    const off = -gst / (Math.PI * 2)
    g.earthMat.map.offset.x = off
    if (g.earthMat.emissiveMap) g.earthMat.emissiveMap.offset.x = off
  }
  if (g.passGroup) g.passGroup.rotation.y = gst
  // 地固系叠加层（极光椭圆环 / 星下点轨迹）同样随地球自转，否则会钉在惯性方向、随地球漂移
  if (g.earthFixedGroup) g.earthFixedGroup.rotation.y = gst
}

/* ============================================================
 * 发射站标记（/situation 综合态势「发射站列表」）
 *  按经纬度把发射站打到地球上，挂 earthFixedGroup（随地球自转，见 syncEarthSpin）。
 *  配色：有即将发射 → 琥珀色高亮；现役 → 青色；退役 → 灰色。
 *  拾取沿用卫星的屏幕空间投影口径（见 pickNearestAt），并用地球遮挡剔除背面的点。
 * ============================================================ */
/** 标记贴地半径（略高于地表，避免与地球贴图 z-fighting） */
const SITE_MARKER_ALT = EARTH_R * 1.006
/** 标记核心球半径（场景单位） */
const SITE_MARKER_R = 0.008
/** 发射站拾取屏幕容差（像素） */
const SITE_PICK_TOLERANCE_PX = 12
/** 镜头飞到发射站时的相机距地心距离（与过境目标同一观感） */
const SITE_FOCUS_DIST = EARTH_R * 1.6
/** 标记配色（有即将发射 / 现役 / 退役） */
const SITE_COLOR_UPCOMING = 0xffb43a
const SITE_COLOR_ACTIVE = 0x35d0ff
const SITE_COLOR_RETIRED = 0x8b97a8
/** 标记状态三态：有即将发射 / 现役 / 退役（核心球配色与光晕贴图共用同一判定） */
type SiteState = 'upcoming' | 'active' | 'retired'
/** 标记光晕尺寸（世界单位，约核心球 4 倍直径 —— 远看地球时小球会被贴图淹没，靠光晕保证可见） */
const SITE_GLOW_SIZE = 0.032
/** 光晕呼吸脉冲：相对基准尺寸的振幅与角频率（弧度/秒） */
const SITE_GLOW_PULSE_AMP = 0.26
const SITE_GLOW_PULSE_SPEED = 2.4
/** 光晕径向渐变配色（内 / 外），与三态核心球配色同色系（程序化贴图，见 radialSprite） */
const SITE_GLOW_COLORS: Record<SiteState, [string, string]> = {
  upcoming: ['rgba(255,214,130,1)', 'rgba(255,160,40,0.55)'],
  active: ['rgba(170,240,255,1)', 'rgba(50,170,255,0.55)'],
  retired: ['rgba(214,222,234,1)', 'rgba(140,155,175,0.5)']
}
/** 选中涟漪配色（与三态核心球同色系，区别于原来的纯白线框球） */
const SITE_RIPPLE_COLORS: Record<SiteState, number> = {
  upcoming: 0xffcf7a, active: 0x7fe0ff, retired: 0xc9d4e4
}
/** 选中涟漪：贴地切面上的扩散圆环，自内向外扩 3 轮后淡出 */
const SITE_RIPPLE_CYCLES = 3
/** 单轮扩散时长（ms） */
const SITE_RIPPLE_PERIOD_MS = 900
/** 涟漪起始半径（世界单位，约核心球直径的倍数） */
const SITE_RIPPLE_BASE_R = SITE_MARKER_R * 1.5
/** 扩散终点相对起始半径的倍数 */
const SITE_RIPPLE_GROW = 5.5

/** 标记核心网格（拾取用：userData.siteId = launch_site.id） */
let sitePickMeshes: THREE.Mesh[] = []
/** 选中站涟漪环（挂标记组，未选中时隐藏；选中后自内向外扩散 SITE_RIPPLE_CYCLES 轮） */
let siteSelRipple: THREE.Mesh | null = null
/** 涟漪动画：起始墙钟（ms）与是否在播 */
let siteRippleStart = 0
let siteRippleActive = false
/** 标记光晕精灵（仅强化可见性，不参与拾取），逐帧做呼吸脉冲 */
let siteGlowSprites: THREE.Sprite[] = []
/** 本批标记自建的光晕贴图：disposeGroup 只释放 geometry/material、不释放贴图，须在清除时显式释放，避免反复重建泄漏显存 */
let siteGlowTextures: THREE.Texture[] = []

/** 清除发射站标记组（含高亮环与光晕），释放几何 / 材质 / 自建贴图 */
function clearLaunchSiteMarkers() {
  const grp = g.siteGroup
  if (grp) {
    grp.parent?.remove(grp)
    disposeGroup(grp)
    g.siteGroup = null
  }
  // 光晕贴图不在 disposeGroup 范围内（它只释放 geometry / material），此处显式释放
  for (const t of siteGlowTextures) t.dispose()
  siteGlowTextures = []
  siteGlowSprites = []
  sitePickMeshes = []
  siteSelRipple = null
  siteRippleActive = false
}

/** 把选中涟漪环摆到某站位置并重新起播（不重建标记，仅移动 + 重置动画） */
function placeSiteHighlight(site: LaunchSiteItem) {
  const rp = siteSelRipple
  if (!rp) return
  const pos = lonLatToScene(site.lon, site.lat, SITE_MARKER_ALT)
  rp.position.copy(pos)
  // 环面贴合地表：RingGeometry 位于 XY 平面（法向 +Z），把 +Z 旋转到站点径向朝外
  rp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pos.clone().normalize())
  // 配色与标记三态一致（有即将发射 / 现役 / 退役）
  const st: SiteState = (site.upcoming_count ?? 0) > 0 ? 'upcoming' : (site.status === 1 ? 'active' : 'retired')
  ;(rp.material as THREE.MeshBasicMaterial).color.setHex(SITE_RIPPLE_COLORS[st])
  rp.visible = true
  siteRippleStart = performance.now()
  siteRippleActive = true
}

/** 隐藏选中涟漪环并停止动画 */
function clearSiteHighlight() {
  if (siteSelRipple) siteSelRipple.visible = false
  siteRippleActive = false
}

/** 依据 launchSites 重建地球发射站标记（数据到达 / 图层显示时调用） */
function buildLaunchSiteMarkers() {
  clearLaunchSiteMarkers()
  const sites = launchSites.value.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
  if (!sites.length || !g.earthFixedGroup) return
  const geo = new THREE.SphereGeometry(SITE_MARKER_R, 10, 10)
  const matUpcoming = new THREE.MeshBasicMaterial({ color: SITE_COLOR_UPCOMING })
  const matActive = new THREE.MeshBasicMaterial({ color: SITE_COLOR_ACTIVE })
  const matRetired = new THREE.MeshBasicMaterial({ color: SITE_COLOR_RETIRED, transparent: true, opacity: 0.75 })
  const grp = new THREE.Group()
  grp.name = 'launch-sites'
  const pick: THREE.Mesh[] = []
  const glows: THREE.Sprite[] = []
  // 三态渐变贴图按需生成、本批共用（同状态多站共享一张贴图，减少显存与绘制切换）
  const texCache: Partial<Record<SiteState, THREE.Texture>> = {}
  const texFor = (st: SiteState) => {
    if (!texCache[st]) {
      const [inner, outer] = SITE_GLOW_COLORS[st]
      const t = radialSprite(inner, outer)
      texCache[st] = t
      siteGlowTextures.push(t)
    }
    return texCache[st]!
  }
  for (const s of sites) {
    const st: SiteState = (s.upcoming_count ?? 0) > 0 ? 'upcoming' : (s.status === 1 ? 'active' : 'retired')
    const mat = st === 'upcoming' ? matUpcoming : (st === 'active' ? matActive : matRetired)
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(lonLatToScene(s.lon, s.lat, SITE_MARKER_ALT))
    m.userData.siteId = s.id
    grp.add(m)
    pick.push(m)
    // 光晕精灵：与核心球同位，叠加径向渐变 + 加色混合 —— 远看地球时小球会被贴图淹没，靠光晕保证「看得到点」
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texFor(st), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }))
    glow.position.copy(m.position)
    glow.scale.setScalar(SITE_GLOW_SIZE)
    // 用站点 id 派生确定性相位，避免所有光晕同频闪烁（同屏脉冲错开、观感更自然）
    glow.userData.phase = (s.id % 17) * 0.37
    grp.add(glow)
    glows.push(glow)
  }
  // 选中涟漪环：贴地切面上的细圆环，选中时自内向外扩散并淡出（替代原来的白色线框球；
  // 参与深度测试，站点转到地球背面时随标记一起被遮挡；加色混合使其随地球暗面也透亮）
  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 1, 64),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending
    })
  )
  ripple.visible = false
  ripple.renderOrder = 998
  grp.add(ripple)
  siteSelRipple = ripple
  g.earthFixedGroup.add(grp)
  g.siteGroup = grp
  sitePickMeshes = pick
  siteGlowSprites = glows
  // 重建后若仍有选中项，重新摆上高亮环
  if (siteSel.value) placeSiteHighlight(siteSel.value)
}

/** 发射站光晕呼吸脉冲：按站点相位错开、随墙钟推进；图层隐藏 / 无标记时直接跳过（不做无谓计算） */
function updateSiteGlow(now: number) {
  if (!siteGlowSprites.length || !g.siteGroup || !g.siteGroup.visible) return
  const t = (now / 1000) * SITE_GLOW_PULSE_SPEED
  for (const sp of siteGlowSprites) {
    sp.scale.setScalar(SITE_GLOW_SIZE * (1 + SITE_GLOW_PULSE_AMP * Math.sin(t + (sp.userData.phase as number))))
  }
}

/** 选中涟漪扩散：3 轮自内向外放大并淡出；播完自动隐藏（图层隐藏 / 未选中时直接跳过） */
function updateSiteRipple(now: number) {
  const rp = siteSelRipple
  if (!rp || !siteRippleActive || !rp.visible) return
  const elapsed = now - siteRippleStart
  const totalMs = SITE_RIPPLE_CYCLES * SITE_RIPPLE_PERIOD_MS
  if (elapsed >= totalMs) {
    rp.visible = false
    siteRippleActive = false
    return
  }
  // 单轮进度 p ∈ [0,1)：半径线性放大、不透明度线性淡出，周期间由 visibility 无缝衔接成连环涟漪
  const p = (elapsed % SITE_RIPPLE_PERIOD_MS) / SITE_RIPPLE_PERIOD_MS
  rp.scale.setScalar(SITE_RIPPLE_BASE_R * (1 + (SITE_RIPPLE_GROW - 1) * p))
  ;(rp.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.85
}

/** 发射站拾取：射线屏幕空间投影取容差内最近者；被地球遮挡的点不参与。返回 launch_site.id 或 null */
function pickLaunchSiteAt(px: number, py: number): number | null {
  const renderer = g.renderer, cam = g.camera, grp = g.siteGroup
  if (!renderer || !cam || !grp || !grp.visible || !sitePickMeshes.length) return null
  const rect = renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  grp.updateMatrixWorld(true)
  const tolerance2 = SITE_PICK_TOLERANCE_PX * SITE_PICK_TOLERANCE_PX
  let bestId: number | null = null
  let bestD2 = tolerance2
  for (const m of sitePickMeshes) {
    m.getWorldPosition(_pos)
    if (isOccludedByEarth(cam.position, _pos)) continue
    _proj.copy(_pos).project(cam)
    if (_proj.z > 1 || _proj.z < -1) continue
    const dx = (_proj.x * 0.5 + 0.5) * rect.width - px
    const dy = (-_proj.y * 0.5 + 0.5) * rect.height - py
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; bestId = m.userData.siteId as number }
  }
  return bestId
}

/** 镜头飞到地固系某点（发射站）：与 flyToPassPoint 同一算法，但取 earthFixedGroup 的自转角
 *  （发射站标记挂 earthFixedGroup，与过境 passGroup 无关）。 */
function flyToEarthFixedPoint(local: THREE.Vector3, dist: number) {
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) return
  const rotY = g.earthFixedGroup ? g.earthFixedGroup.rotation.y : 0
  const cosR = Math.cos(rotY), sinR = Math.sin(rotY)
  const dir = new THREE.Vector3(
    local.x * cosR + local.z * sinR,
    local.y,
    -local.x * sinR + local.z * cosR
  )
  if (dir.lengthSq() < 1e-9) return
  dir.normalize().multiplyScalar(dist)
  beginCamFly(dir, _flyHomeTarget, 'none')
  restoreEarthOrbitLimits()
}

/** 选中发射站：写 siteSel（即将发射 / 发射历史的加载由父组件 watch siteSel 触发）+ 高亮 + 镜头飞过去。
 *  点击地球标记与点击左侧列表项走同一路径。
 *  返回是否命中：站点列表尚未加载（loadLaunchSites 是异步的）时返回 false，
 *  供 URL 预置识别「待重试」，等 launchSites 到达后再重放。 */
function selectLaunchSiteById(id: number): boolean {
  const site = launchSites.value.find((s) => s.id === id)
  if (!site) return false
  siteSel.value = site
  siteOpen.value = true
  dockMode.value = 'site'
  placeSiteHighlight(site)
  flyToEarthFixedPoint(lonLatToScene(site.lon, site.lat, EARTH_R), SITE_FOCUS_DIST)
  return true
}

/* ============================================================
 * URL 预置（把地址栏参数还原成对应的拾取动作）
 *
 * 三维实现全站只保留本页，各后台/前台入口一律改成「带参跳转 /situation/<type>?…」，
 * 参数与目标视图必须一一对应（用户要求「千万要对应好」）：
 *   · /situation/sat?norad=     选中该 NORAD 的卫星并飞过去（卫星列表入口）
 *   · /situation/cons?const=    按星座名过滤（星座列表入口）
 *   · /situation/site?site=     选中该发射站（发射站列表入口）
 *   · /situation/heat?source=&a=&b=&tca=  选中该碰撞 / 交会事件（碰撞列表用 source=local，交会用 source=cri）
 *
 * 实现要点：
 *  ① keep-alive 下同一组件实例会被反复复用，不能用「一次性布尔」守卫；改用「预置内容签名」去重 ——
 *     签名 = type 段之外的各预置参数拼接，内容一变即视为新预置、重放；消费成功后清掉地址栏预置参数，
 *     使同一目标的再次跳转仍形成新签名，从而可重放。
 *  ② 首次挂载时 onActivated 早于 onMounted 的 await loadConstellation()，此刻点云/站点列表可能为空；
 *     命中不了视为「待重试」：不置签名、不清 URL，等数据就绪后由 onMounted / watch(launchSites) 重放。
 *  ③ 时序：keep-alive 恢复时父组件（index.vue）的 onActivated 先于本组件的 onActivated 执行，
 *     故此处消费预置必在父组件 clearScene + applyDock 之后，拾取结果不会被清掉。
 * ============================================================ */
const route = useRoute()
const router = useRouter()

/** 会被消费的预置参数名（消费后从地址栏移除） */
const PRESET_KEYS = ['norad', 'const', 'site', 'source', 'a', 'b', 'tca'] as const

/** 由当前地址栏预置参数生成签名：内容变化即视为新预置，需要重放 */
function presetSigOf(q: Record<string, unknown>): string {
  return PRESET_KEYS
    .map((k) => `${k}=${typeof q[k] === 'string' ? q[k] : ''}`)
    .filter((s) => s.split('=')[1] !== '')
    .join('&')
}

/** 移除地址栏上的预置参数（保留 :type 段与其它无关参数），消费成功后调用 */
function clearPresetQuery() {
  const q: Record<string, string> = {}
  for (const [k, v] of Object.entries(route.query)) {
    if ((PRESET_KEYS as readonly string[]).includes(k)) continue
    if (typeof v === 'string') q[k] = v
  }
  void router.replace({ query: q })
}

/** 已消费的预置签名（消费成功后才写入，内容变化 → 重放） */
let consumedPresetSig = ''
/** 正在重放中的预置签名（同一次预置被多个触发点并发调用时去重，避免 heat 事件被重复选中） */
let applyingPresetSig = ''
/** 场景是否处于激活态：keep-alive 切走期间不处理预置（切回由 onActivated 处理） */
let routePresetActive = true

/** 该事件是否已在当前来源已加载的热力事件集合中（按 norad 对 + TCA 匹配，与 selectHeatPair 同口径） */
function heatPairInList(pair: HeatPairRef): boolean {
  const tcaMs = parseEpoch(pair.tca)
  return heatFiltered.value.some(
    (e) => e.norad_a === pair.norad_a && e.norad_b === pair.norad_b && parseEpoch(e.tca) === tcaMs
  )
}

async function applyRoutePreset() {
  if (!routePresetActive) return
  const q = route.query
  const sig = presetSigOf(q)
  if (!sig || sig === consumedPresetSig || sig === applyingPresetSig) return
  applyingPresetSig = sig

  const cons = typeof q.const === 'string' ? q.const.trim() : ''
  const norad = Number(q.norad)
  const site = Number(q.site)
  const source = typeof q.source === 'string' ? (q.source as HeatSource) : ''
  const na = Number(q.a)
  const nb = Number(q.b)
  const tca = typeof q.tca === 'string' ? q.tca : ''
  let pending = false

  try {
    // 星座过滤：进入星座视图时按名过滤（等价于原星座页的 ?name=）
    if (cons) filterConst.value = cons

    // 卫星拾取：点云未就绪（cloudList 为空）时挂起 —— 首次挂载点云尚未到达，待 onMounted 就绪后重放
    if (Number.isFinite(norad) && norad > 0) {
      const gi = g.cloudList.findIndex((p) => Number(p.norad_id) === norad)
      if (gi >= 0) {
        // URL 深链预置选中目标：视为用户显式要看目标，揭示点云并勾选其所属类型（面板开关同步加亮）
        cloudRevealed.value = true
        const tp = g.cloudList[gi]?.object_type
        if (tp && TYPE_KEYS.includes(tp)) visible[tp] = true
        requestAnimationFrame(() => selectSatelliteByIndex(gi))
      } else if (!g.cloudList.length) pending = true
    }

    // 发射站拾取：站点列表未就绪（异步 loadLaunchSites）时挂起，由 watch(launchSites) 重放
    if (Number.isFinite(site) && site > 0) {
      if (!selectLaunchSiteById(site)) pending = true
    }

    // 碰撞 / 交会事件拾取（碰撞列表用 source=local，交会用 source=cri）：
    // ① 若来源不同先切来源，并等 watch(heatSource) 的清理（pre-flush，会把 heatSel 清空）执行完，
    //    否则刚选中的事件会被随后的清理覆盖掉；
    // ② 命中已加载事件即选中（带真实名字/距离/mid 坐标 → 镜头飞到交会点）；
    //    数据已到但该事件不在列表里（被筛选排除等）→ 仍用兜底 stub 选中；
    //    数据未到 → 挂起（不置签名、不清 URL），等 watch(heatList) 重放。
    if (source && Number.isFinite(na) && na > 0 && Number.isFinite(nb) && nb > 0) {
      const pair: HeatPairRef = { norad_a: na, norad_b: nb, tca }
      if (heatSource.value !== source) {
        heatSource.value = source
        await nextTick()
      }
      if (heatPairInList(pair) || heatDataReady(source)) await selectHeatPair(pair)
      else pending = true
    }

    if (pending) return
    consumedPresetSig = sig
    nextTick(clearPresetQuery)
  } finally {
    if (applyingPresetSig === sig) applyingPresetSig = ''
  }
}

/* ============================================================
 * 空间环境数据（定时拉取）
 *  驱动极光椭圆环（Kp）与太阳风粒子流（速度/密度）；仅展示，不参与任何误差模型。
 *  默认 10 分钟一次：日粒度源本身每天才更新一次，太阳风虽是分钟级但动画只用到「速度/密度的量级」，
 *  10 分钟足够；keep-alive 切走时停表、切回立即刷新一次（返回页面时数据是新的）。
 * ============================================================ */
const SW_REFRESH_MS = 10 * 60 * 1000
let swTimer: number | null = null

/** 拉取空间环境并应用到三维场景（极光环几何重建 + 粒子观感） */
async function loadSpaceWeather() {
  if (disposed) return
  spaceWeatherLoading.value = true
  try {
    const r = await getSpaceWeather({ with_wind: 1 })
    if (disposed) return
    spaceWeather.value = r
    spaceWeatherAt.value = Date.now()
    spaceWeatherError.value = ''
    rebuildAurora()
    applySolarWindStyle()
    // 地磁偶极磁力线：几何依赖 geomagPole，首次拉到空间环境数据后重建一次
    rebuildDipole()
  } catch (e: unknown) {
    if (disposed) return
    spaceWeatherError.value = e instanceof Error ? e.message : '空间环境数据获取失败'
  } finally {
    spaceWeatherLoading.value = false
  }
}

function startSpaceWeatherTimer() {
  stopSpaceWeatherTimer()
  swTimer = window.setInterval(() => { void loadSpaceWeather() }, SW_REFRESH_MS)
}

function stopSpaceWeatherTimer() {
  if (swTimer !== null) { window.clearInterval(swTimer); swTimer = null }
}

/** 侧摆角 θ → 星下点横向地面偏移（km）：cos ε = (R+h)·sinθ/R，λ = 90°−ε−θ，d = R·λ。
 *  与后端 lib/passRegionScan.js 的 rollOffsetKm 同式（前端不再另立口径）。 */
function rollOffsetKm(rollDeg: number, hKm: number): number {
  const th = (Math.max(0, Number(rollDeg) || 0) * Math.PI) / 180
  if (!(th > 0)) return 0
  const h = Math.max(0, Number(hKm) || 0)
  const sinEps = ((EARTH_RADIUS_KM + h) * Math.sin(th)) / EARTH_RADIUS_KM
  if (!(sinEps < 1)) return EARTH_RADIUS_KM * Math.max(0, Math.PI / 2 - th)
  return EARTH_RADIUS_KM * Math.max(0, Math.PI / 2 - Math.acos(sinEps) - th)
}

/** 按 TLE 在 [t0, t1] 反演星下点，得到每帧的星下点单位向量与「侧向」单位向量。
 *  侧向 = 垂直于轨迹的切平面方向；符号取指向目标区域中心的一侧（无参考顶点时取正方向），
 *  使侧摆偏移（成像条带中心线）画在目标真正所在的一侧。
 *  refPts：目标区域多边形顶点（单区域取框选草稿，多区域取该 area_index 对应区域的多边形）。 */
function sampleRegionPassTrack(
  sr: ReturnType<typeof twoline2satrec>, t0: number, t1: number,
  refPts: { lon: number; lat: number }[] = regionDraft.value
): RegionPassFrame[] {
  const span = Math.max(1, t1 - t0)
  const us: THREE.Vector3[] = []
  for (let i = 0; i <= REGION_PASS_TRACK_STEPS; i++) {
    const d = new Date(t0 + (span * i) / REGION_PASS_TRACK_STEPS)
    try {
      const pv = propagate(sr, d)
      if (!pv?.position) continue
      const gd = eciToGeodetic(pv.position, gstime(d))
      us.push(lonLatToScene(degreesLong(gd.longitude), degreesLat(gd.latitude), 1))
    } catch { /* 单帧传播失败跳过，不影响其余采样 */ }
  }
  if (us.length < 2) return []
  // 侧向符号参考：目标区域中心的切向分量（无参考顶点时为 null，保持默认正方向）
  const pts = refPts
  let ref: THREE.Vector3 | null = null
  if (pts.length >= 3) {
    const c = new THREE.Vector3()
    for (const p of pts) c.add(lonLatToScene(p.lon, p.lat, 1))
    if (c.lengthSq() > 1e-9) ref = c.normalize()
  }
  const frames: RegionPassFrame[] = []
  for (let i = 0; i < us.length; i++) {
    const u = us[i]
    const prev = us[Math.max(0, i - 1)]
    const next = us[Math.min(us.length - 1, i + 1)]
    const t = new THREE.Vector3().subVectors(next, prev)
    // 投影到 u 的切平面（相邻星下点连线本身近似切向，投影只是数值上的兜底）
    t.addScaledVector(u, -t.dot(u))
    if (t.lengthSq() < 1e-12) continue
    t.normalize()
    const side = new THREE.Vector3().crossVectors(u, t).normalize()
    if (ref) {
      const proj = ref.clone().addScaledVector(u, -ref.dot(u))
      if (side.dot(proj) < 0) side.negate()
    }
    frames.push({ u, side })
  }
  return frames
}

/** 单帧上的偏移点：先沿侧向偏移 offsetRad（成像条带中心线），再向两侧展开 k·halfRad，最后落在半径 r 上 */
function ribbonPoint(f: RegionPassFrame, offsetRad: number, halfRad: number, k: number, r: number): THREE.Vector3 {
  const lam = offsetRad + k * halfRad
  return f.u.clone().multiplyScalar(Math.cos(lam)).addScaledVector(f.side, Math.sin(lam)).multiplyScalar(r)
}

/** 横向分段的单段角宽上限（弧度）：沿轨方向按 96 段采样已足够细，但横向若只用一段「平铺的弦」，
 *  弦中点会沉到球面以下被不透明地球挡住 —— 判定半带宽可以很大（GF-3：幅宽 650/2 + 43° 侧摆 ≈ 1071km，
 *  合 9.63°），一段横跨时该平面距地心仅 0.9933R（地表下约 43km），
 *  只有离轨迹中线 ±6.6°（约 737km）以外的两片露出地表，中间 1470km 宽的整条被地球吞掉，
 *  于是打底面在轨迹两侧裂成两条、与红色成像条带之间露出「缝隙」。
 *  按 ≤2° 切段后每段的弦高差不足 1km，远小于抬升量（REGION_PASS_FILL_R − 1 ≈ 48km），整条完整贴地。 */
const REGION_PASS_CROSS_MAX_RAD = (2 * Math.PI) / 180

/** 沿轨迹铺一条贴地三角带（中心线偏移 offsetRad ± halfRad）。
 *  沿轨按帧采样（96 段），横向按 REGION_PASS_CROSS_MAX_RAD 切段 —— 两个方向都必须细分，
 *  否则宽条带的横向弦会沉进球体（见该常量说明）。 */
function buildGroundRibbon(frames: RegionPassFrame[], offsetRad: number, halfRad: number, r: number): THREE.BufferGeometry {
  const arr: number[] = []
  const cross = Math.max(1, Math.ceil((2 * halfRad) / REGION_PASS_CROSS_MAX_RAD))
  for (let i = 0; i < frames.length - 1; i++) {
    for (let j = 0; j < cross; j++) {
      const k0 = -1 + (2 * j) / cross
      const k1 = -1 + (2 * (j + 1)) / cross
      const a = ribbonPoint(frames[i], offsetRad, halfRad, k0, r)
      const b = ribbonPoint(frames[i], offsetRad, halfRad, k1, r)
      const c = ribbonPoint(frames[i + 1], offsetRad, halfRad, k0, r)
      const d = ribbonPoint(frames[i + 1], offsetRad, halfRad, k1, r)
      arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      arr.push(b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

/** 构建**一组**贴地扫描叠加层（可达范围打底 + 成像条带 + 星下点轨迹 + 端点标记），返回未挂载的 Group。
 *  单区域一次过境 = 一组；多区域「同时覆盖」= 每个命中区域各一组，一起挂进同一个 root（见 focusMultiRegionCoverage）。 */
function buildPassScanGroup(
  rec: { half_width_km: number; swath_km: number; required_roll_deg: number | null },
  frames: RegionPassFrame[], hKm: number, name: string
): THREE.Group | null {
  if (frames.length < 2) return null
  const root = new THREE.Group()
  root.name = name

  // 1) 判定可达范围（半透明打底）：判定半带宽 = 幅宽/2 + 侧摆可达地面偏移，后端已算好直接复用
  const halfW = Math.max(0, rec.half_width_km) / EARTH_RADIUS_KM
  root.add(new THREE.Mesh(
    buildGroundRibbon(frames, 0, halfW, REGION_PASS_FILL_R),
    new THREE.MeshBasicMaterial({
      color: REGION_PASS_FILL_COLOR, transparent: true, opacity: 0.2,
      side: THREE.DoubleSide, depthWrite: false
    })
  ))
  for (const k of [-1, 1]) {
    const pts = frames.map((f) => ribbonPoint(f, 0, halfW, k, REGION_PASS_FILL_R))
    root.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: REGION_PASS_FILL_COLOR, transparent: true, opacity: 0.55 })
    ))
  }

  // 2) 成像条带（窄条高亮）：中心线按「所需侧摆」偏移，宽度 = 幅宽
  const rollOff = rollOffsetKm(rec.required_roll_deg ?? 0, hKm) / EARTH_RADIUS_KM
  const bandHalf = Math.max(0, rec.swath_km) / 2 / EARTH_RADIUS_KM
  if (bandHalf > 0) {
    root.add(new THREE.Mesh(
      buildGroundRibbon(frames, rollOff, bandHalf, REGION_PASS_BAND_R),
      new THREE.MeshBasicMaterial({
        color: REGION_PASS_BAND_COLOR, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false
      })
    ))
    for (const k of [-1, 1]) {
      const pts = frames.map((f) => ribbonPoint(f, rollOff, bandHalf, k, REGION_PASS_BAND_R))
      root.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: REGION_PASS_BAND_COLOR, transparent: true, opacity: 0.95 })
      ))
    }
  }

  // 3) 星下点轨迹 + AOS（绿）/ 中点（黄）/ LOS（洋红）标记
  const trackPts = frames.map((f) => f.u.clone().multiplyScalar(REGION_PASS_TRACK_R))
  root.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(trackPts),
    new THREE.LineBasicMaterial({ color: REGION_PASS_TRACK_COLOR, transparent: true, opacity: 0.95 })
  ))
  const marks = [trackPts[0], trackPts[Math.floor(trackPts.length / 2)], trackPts[trackPts.length - 1]]
  const mGeo = new THREE.BufferGeometry().setFromPoints(marks)
  const mCol = new Float32Array(3 * 3)
  ;[0x7dffb0, 0xffd166, 0xff6b9d].forEach((h, i) => {
    const c = new THREE.Color(h)
    mCol[i * 3] = c.r; mCol[i * 3 + 1] = c.g; mCol[i * 3 + 2] = c.b
  })
  mGeo.setAttribute('color', new THREE.BufferAttribute(mCol, 3))
  root.add(new THREE.Points(mGeo, new THREE.PointsMaterial({
    size: 10, sizeAttenuation: false, vertexColors: true, transparent: true
  })))

  return root
}

/** 构建贴地扫描叠加层并挂到该 kind 的槽位（passGroup 子组，随地球自转）。
 *  kind 决定挂到哪一套槽位（单区域 / 多区域），几何与配色完全一致（不做两套视觉）。
 *  outlinePolys 为本次过境所属区域的真实多边形：条带只说明「扫到了哪一段」，
 *  还必须回画区域轮廓才能看出「是哪（几）个区域」（批次结果里的区域未必是本次框选的那些）。 */
function buildPassScanLayers(
  rec: { half_width_km: number; swath_km: number; required_roll_deg: number | null },
  frames: RegionPassFrame[], hKm: number, kind: PassKind,
  outlinePolys?: { lon: number; lat: number }[][]
) {
  const slot = passSlots[kind]
  if (!g.passGroup) buildPassLayers()
  const grp = g.passGroup
  if (!grp) return
  const old = g[slot.scanKey]
  if (old) { grp.remove(old); disposeGroup(old); g[slot.scanKey] = null }

  const root = buildPassScanGroup(rec, frames, hKm, slot.scanName)
  if (!root) return
  const outline = outlinePolys?.length ? buildPickRegionOverlay(outlinePolys) : null
  if (outline) root.add(outline)
  grp.add(root)
  g[slot.scanKey] = root
}

/** 按当前虚拟时间更新过境选中卫星模型的位置与姿态（静止时定在过境时刻，播放时沿轨道飞行）。
 *  单区域 / 多区域共用（kind 选槽位）。 */
function updatePassModel(kind: PassKind) {
  const slot = passSlots[kind]
  const mesh = slot.model
  if (!mesh || !slot.sr) return
  try {
    const pv = propagate(slot.sr, new Date(g.simTimeMs))
    if (!pv?.position) return
    const pos = eciToScene(pv.position.x, pv.position.y, pv.position.z)
    mesh.position.copy(pos)
    // 姿态与卫星云 / 卫星列表同一口径（见 orbitBasis）：机身长轴 = 本地 +Z = 机头，恒对齐径向天顶，
    // 即机头垂直于球面朝外。位置逐帧在变（含过境播放），故姿态必须逐帧重算 ——
    // 若只在建组时定一次，卫星沿轨道走出一段后机头就会偏离天顶，看起来像「自己转向」。
    if (pv.velocity) {
      orbitAttitude(pos, eciToScene(pv.velocity.x, pv.velocity.y, pv.velocity.z), mesh.quaternion)
    }
  } catch { /* 单帧传播失败保持上一位置与姿态 */ }
}

/** 构建惯性系叠加组（挂场景根，不随地球自转）：整圈轨道线 + 该星模型。
 *  轨道环以「过境中点」为中心采样一整圈（与 buildHeatSelOrbits 同口径）：TLE 历元与该时刻常相隔数天，
 *  期间 J2 交点进动会让轨道面偏转，按历元采样会让模型脱离所画环。
 *  kind 决定挂到哪一套槽位；seq 为构建开始时的绘制序号，异步等待（模型下载）后若已过期即丢弃。 */
async function buildPassOrbit(
  gi: number, sr: ReturnType<typeof twoline2satrec>, tMidMs: number, seq: number, kind: PassKind
) {
  const slot = passSlots[kind]
  const scene = g.scene
  if (!scene) return
  const stale = () => seq !== slot.seq
  const old = g[slot.airKey]
  if (old) { scene.remove(old); disposeGroup(old); g[slot.airKey] = null }
  slot.model = null

  const periodMs = (sr.no ? (Math.PI * 2) / sr.no : 100) * 60000
  const t0 = tMidMs - periodMs / 2
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= REGION_PASS_ORBIT_STEPS; i++) {
    const pv = propagate(sr, new Date(t0 + (i / REGION_PASS_ORBIT_STEPS) * periodMs))
    if (pv?.position) pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z))
  }
  if (pts.length < 2) return

  const group = new THREE.Group()
  group.name = slot.airName
  group.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: REGION_PASS_ORBIT_COLOR, transparent: true, opacity: 0.75 })
  ))
  // 卫星模型：与交会目标同一套加载路径（high 档 + 高亮材质 + 同倍放大）
  const gm = await loadHeatModel(g.cloudList[gi])
  if (stale()) { disposeGroup(group); return }
  if (gm) {
    const mesh = new THREE.Mesh(gm.geom.clone(), new THREE.MeshStandardMaterial({
      color: 0x66e0ff, metalness: 0.45, roughness: 0.3, emissive: 0x66e0ff, emissiveIntensity: 0.85
    }))
    mesh.scale.setScalar(HEAT_TARGET_MODEL_SCALE)
    mesh.userData.passFocusModel = true
    group.add(mesh)
    slot.model = mesh
  }
  if (stale()) { disposeGroup(group); return }
  group.visible = passMode.value
  g[slot.airKey] = group
  scene.add(group)
  updatePassModel(kind)
}

/** 点选过境记录（单区域 / 多区域共用实现）：绘制该次过境的卫星模型 + 轨道 + 扫描区域，
 *  并把虚拟时间对齐到 AOS（贴地扫描区域为地固系、卫星在惯性系，此刻两者严格对应）。
 *  rec 传 null 表示取消选中（清除绘制并交回时间推进）；
 *  refPts 为该记录所属区域的顶点（用于确定成像条带画在目标哪一侧）；
 *  outlinePolys 为要在球面上回显的区域轮廓（多区域传所属区域多边形，回答「是哪个区域」）。 */
async function focusPass(
  rec: (RegionAccessItem | MultiRegionAccessItem) | null, kind: PassKind,
  refPts: { lon: number; lat: number }[],
  outlinePolys?: { lon: number; lat: number }[][]
) {
  const slot = passSlots[kind]
  if (!rec) { clearPass(kind); return }
  const gi = g.cloudList.findIndex((p) => p.norad_id === rec.norad_id)
  if (gi < 0) return
  // satrec 懒加载：TLE 未就绪时先补齐（awaitSatrecs 抗「解析期间点云被重建」）
  await awaitSatrecs()
  const sr = g.satrecs[gi]
  if (!sr) return

  // 起止时间：los 缺失 / 异常时退化为「AOS + 1 分钟」，保证窗口非空（播放与采样都需要）
  const t0 = Number(rec.aos_ms) || 0
  if (!(t0 > 0)) return
  const losMs = Number(rec.los_ms) || 0
  const t1 = losMs > t0 ? losMs : t0 + 60000
  const seq = ++slot.seq
  const tMid = (t0 + t1) / 2
  // 判定半带宽由后端按「该星轨道高度」算出，这里用同一口径反推 hKm 供成像条带偏移换算
  // （hKm = rKm − EARTH_R_KM，与后端 passRegionScan.scanSatRegion 一致）
  let hKm = 550
  try {
    const pv = propagate(sr, new Date(tMid))
    if (pv?.position) hKm = Math.max(100, Math.hypot(pv.position.x, pv.position.y, pv.position.z) - EARTH_RADIUS_KM)
  } catch { /* 传播失败时用典型 LEO 高度兜底（只影响条带偏移量，不影响判定范围） */ }

  slot.t0 = t0
  slot.t1 = t1
  slot.sr = sr
  slot.playing.value = false
  slot.progress.value = 0
  // 多区域记录额外带区域序号（面板据此高亮到具体区域行）；单区域不带
  slot.sel.value = { norad_id: rec.norad_id, aos_ms: t0, area_index: (rec as MultiRegionAccessItem).area_index }
  // 虚拟时间跳到 AOS：贴地扫描区域（ECEF 固定）与惯性系卫星在此刻严格对应
  g.simTimeMs = t0
  syncEarthSpin()

  const frames = sampleRegionPassTrack(sr, t0, t1, refPts)
  if (seq !== slot.seq) return
  buildPassScanLayers(rec, frames, hKm, kind, outlinePolys)
  // 镜头先飞到扫描区域中点（用同步过后的 passGroup 自转量换算世界方向）
  if (frames.length) {
    flyToPassPoint(frames[Math.floor(frames.length / 2)].u.clone().multiplyScalar(EARTH_R), PASS_FOCUS_DIST)
  }
  await buildPassOrbit(gi, sr, tMid, seq, kind)
}

/** 播放 / 暂停：沿 AOS→LOS 推进虚拟时间（卫星模型飞过扫描区域）。已播到 LOS 时从头重播。 */
function togglePassPlay(kind: PassKind) {
  const slot = passSlots[kind]
  if (!slot.sr || slot.t1 <= slot.t0) return
  if (slot.playing.value) { slot.playing.value = false; return }
  if (g.simTimeMs >= slot.t1 - 1) {
    g.simTimeMs = slot.t0
    slot.progress.value = 0
    syncEarthSpin()
    updatePassModel(kind)
  }
  slot.playing.value = true
}

/** 播放进度定位（ratio 0~1）：直接改虚拟时间，贴地扫描区域与卫星模型随之同步 */
function seekPass(kind: PassKind, ratio: number) {
  const slot = passSlots[kind]
  if (!slot.sr || slot.t1 <= slot.t0) return
  const k = Math.max(0, Math.min(1, Number(ratio) || 0))
  g.simTimeMs = slot.t0 + (slot.t1 - slot.t0) * k
  slot.progress.value = k
  syncEarthSpin()
  updatePassModel(kind)
}

/** 清除过境选中记录的绘制（卫星模型 / 轨道 / 扫描区域）并结束播放 */
function clearPass(kind: PassKind) {
  const slot = passSlots[kind]
  slot.seq++
  slot.sr = null
  slot.model = null
  slot.t0 = 0
  slot.t1 = 0
  slot.playing.value = false
  slot.progress.value = 0
  slot.sel.value = null
  const air = g[slot.airKey]
  if (air) { g.scene?.remove(air); disposeGroup(air); g[slot.airKey] = null }
  const scan = g[slot.scanKey]
  if (scan) { g.passGroup?.remove(scan); disposeGroup(scan); g[slot.scanKey] = null }
}

/** 点选区域过境列表项：绘制该次过境的卫星模型 + 轨道 + 扫描区域（侧向参考取框选草稿多边形） */
async function focusRegionPass(rec: RegionAccessItem | null) {
  await focusPass(rec, 'region', regionDraft.value)
}

/** 点选多区域过境明细项：绘制该次过境的卫星模型 + 轨道 + 扫描区域 + 所属区域轮廓。
 *  侧向参考取该记录所属区域（area_index）的多边形 —— 多区域的每个区域各自不同，
 *  不能用单区域那样一份全局草稿；优先用结果里带回的真实多边形，没有则退回本地框选顶点。 */
async function focusMultiRegionPass(rec: MultiRegionAccessItem | null, areaPolygon?: [number, number][] | null) {
  if (rec) {
    const poly = (areaPolygon || []).map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }))
    const pts = poly.length >= 3 ? poly : (multiAreas.value[rec.area_index]?.points || [])
    await focusPass(rec, 'multi', pts, pts.length >= 3 ? [pts] : undefined)
    return
  }
  await focusPass(null, 'multi', [])
}

/** 点选「同时覆盖」记录时的区域口径（CoverageGroup.areas 的元素，绘制条带所需的字段） */
interface CoverageDrawArea {
  area_index: number
  aos_ms: number | null
  los_ms: number | null
  swath_km: number | null
  half_width_km: number | null
  required_roll_deg: number | null
}

/**
 * 点选「同时覆盖」记录：这是**真实的多区域过境** —— 同一颗卫星在重叠时间窗内同时命中多个区域。
 * 与明细项（单条记录只画一个区域）的区别：这里按组内每个命中区域**各画一组**贴地扫描叠加
 * （打底盘 + 成像条带 + 星下点轨迹），全部挂进 multi 槽位的同一个 root；整圈轨道与卫星模型只画一份。
 * 播放条沿用 multi 槽位，时间轴取整组窗口 [start_ms, end_ms]。
 * areaPolygons 为各区域真实多边形（来自批次结果），用于把条带画在该区域真正所在的一侧。
 */
async function focusMultiRegionCoverage(
  group: { norad_id: number; start_ms: number; end_ms: number; areas: CoverageDrawArea[] } | null,
  areaPolygons: { area_index: number; polygon: [number, number][] }[] = []
) {
  const slot = passSlots.multi
  if (!group) { clearPass('multi'); return }
  const gi = g.cloudList.findIndex((p) => Number(p.norad_id) === Number(group.norad_id))
  if (gi < 0) return
  // satrec 懒加载：TLE 未就绪时先补齐（awaitSatrecs 抗「解析期间点云被重建」）
  await awaitSatrecs()
  const sr = g.satrecs[gi]
  if (!sr) return

  const t0 = Number(group.start_ms) || 0
  if (!(t0 > 0)) return
  const t1 = Math.max(Number(group.end_ms) || 0, t0 + 60000)
  const seq = ++slot.seq
  slot.t0 = t0
  slot.t1 = t1
  slot.sr = sr
  slot.playing.value = false
  slot.progress.value = 0
  // 组级选中：只带 norad + 组起始时刻（明细行的高亮要求 area_index 相等，两者互不干扰）
  slot.sel.value = { norad_id: Number(group.norad_id), aos_ms: t0 }
  g.simTimeMs = t0
  syncEarthSpin()

  // 轨道高度：按组窗口中点传播一次，供各区域条带的侧摆偏移换算（与 focusPass 同一口径）
  let hKm = 550
  try {
    const pv = propagate(sr, new Date((t0 + t1) / 2))
    if (pv?.position) hKm = Math.max(100, Math.hypot(pv.position.x, pv.position.y, pv.position.z) - EARTH_RADIUS_KM)
  } catch { /* 传播失败用典型 LEO 高度兜底（只影响条带偏移量，不影响判定范围） */ }

  if (!g.passGroup) buildPassLayers()
  const grp = g.passGroup
  if (grp) {
    const old = g[slot.scanKey]
    if (old) { grp.remove(old); disposeGroup(old); g[slot.scanKey] = null }
    const root = new THREE.Group()
    root.name = slot.scanName
    // 组内各区域的真实多边形：既用于把条带画在目标真正所在的一侧，也用于回画区域轮廓
    const outlinePolys: { lon: number; lat: number }[][] = []
    for (const a of group.areas || []) {
      const poly = (areaPolygons.find((p) => Number(p.area_index) === Number(a.area_index))?.polygon || [])
        .map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) }))
      if (poly.length >= 3) outlinePolys.push(poly)
      // 各区域各自的时间窗：绘制出该星「分别过境这几个区域」的真实轨迹段
      const at0 = Number(a.aos_ms) || t0
      const at1 = Math.max(Number(a.los_ms) || 0, at0 + 60000)
      const frames = sampleRegionPassTrack(sr, at0, at1, poly)
      const sub = buildPassScanGroup({
        half_width_km: Number(a.half_width_km) || 0,
        swath_km: Number(a.swath_km) || 0,
        required_roll_deg: a.required_roll_deg ?? null
      }, frames, hKm, `${slot.scanName}-${a.area_index}`)
      if (sub) root.add(sub)
    }
    // 区域轮廓：条带（青蓝 / 洋红）说明「扫到了哪一段」，轮廓（黄）说明「是哪几个区域」
    const outline = outlinePolys.length ? buildPickRegionOverlay(outlinePolys) : null
    if (outline) root.add(outline)
    if (root.children.length) {
      grp.add(root)
      g[slot.scanKey] = root
    }
  }

  // 镜头飞到组内全部区域顶点的形心方向（多区域取一处折中视角）
  const hit: THREE.Vector3[] = []
  for (const a of group.areas || []) {
    const poly = areaPolygons.find((p) => Number(p.area_index) === Number(a.area_index))?.polygon || []
    for (const [lon, lat] of poly) hit.push(lonLatToScene(Number(lon), Number(lat), 1))
  }
  if (hit.length) {
    const c = new THREE.Vector3()
    for (const v of hit) c.add(v)
    if (c.lengthSq() > 1e-9) flyToPassPoint(c.normalize().multiplyScalar(EARTH_R), PASS_FOCUS_DIST)
  }

  await buildPassOrbit(gi, sr, (t0 + t1) / 2, seq, 'multi')
}

function toggleRegionPassPlay() { togglePassPlay('region') }
function seekRegionPass(ratio: number) { seekPass('region', ratio) }
function clearRegionPass() { clearPass('region') }

function toggleMultiRegionPassPlay() { togglePassPlay('multi') }
function seekMultiRegionPass(ratio: number) { seekPass('multi', ratio) }
function clearMultiRegionPass() { clearPass('multi') }

/** 释放过境地表图层（从场景移除 + 回收几何体/材质） */
function clearPassLayers() {
  // 城市全部卫星轨道线是 passGroup 的子组，先单独回收（清 norad→线 映射并撤销复染），
  // 单次过境卫星模型挂场景根，也一并回收
  clearPassCityOrbits()
  clearPassSatOrbit()
  if (g.passGroup) {
    g.scene?.remove(g.passGroup)
    disposeGroup(g.passGroup)
    g.passGroup = null
  }
  g.passBorderGroup = null
  g.passDistrictGroup = null
  g.passTargetPickMeshes = []
  g.passTargetPickIds = []
  // 高亮面 / 过境标记是 passGroup 的子组，随根组一并释放，这里只需清引用
  g.passHighlightGroup = null
  g.passTrackGroup = null
  // 框选叠加组同为 passGroup 子组，一并清引用（顶点草稿保留，重建图层后会重画）
  g.regionGroup = null
  g.multiGroup = null
  regionPreviewLine = null
  // 区域 / 多区域过境选中记录的贴地扫描叠加组同为 passGroup 子组，随根组一并释放
  g.regionPassScanGroup = null
  g.multiPassScanGroup = null
}

/** 图层重建后按当前选中目标补画「高亮面 + 全部卫星轨道线」。
 *
 *  选中态（passSelTarget / passDetail）保存在场景 store，不随图层释放；但高亮面（passHighlightGroup）
 *  与全部卫星轨道线（passCityOrbitGroup）都是 passGroup 的子组 —— 任何一次 buildPassLayers()
 *  （底图后台静默刷新、批次信息回填、切换数据批次）都会把整个 passGroup 释放重建，两者一并消失。
 *  而 buildPassCityOrbits 是异步的（要先等 satrec 懒加载，首次数秒），期间若发生图层重建，
 *  它靠 passCityOrbitSeq 守卫会静默放弃且无人补画 —— 表现为「左侧列表已选中、地球上的区域高亮 / 卫星轨迹
 *  却不出现，连续切换几个目标（重建窗口已过）才正常」。
 *  故与 rebuildRegionOverlay / rebuildMultiOverlay 同一位置、同一原因，在这里按当前选中态补画一次。 */
function resyncPassSelectionVisuals() {
  const t = passSelTarget.value
  if (!t || !g.passGroup) return
  buildPassTargetHighlight(t)
  if (passDetail.value?.list?.length) void buildPassCityOrbits()
}

/** 依据当前行政区划面 / 国界数据构建地表叠加图层（幂等：重建前先释放旧图层）。
 *  · 目标面（中国行政区划面 + 其他国家国界面）—— 边界线合并成 4 个 LineSegments：
 *    中国行政区划面一律白色（有过境数据更亮），其他国家国界面沿用「有过境数据亮蓝 / 无数据灰蓝」，
 *    并同时为每个目标建一枚**不可见拾取网格**（材质 visible=false，不渲染但可被 Raycaster 命中），
 *    点击地球任意位置即命中该点所在的行政区划面（与后端「可见圈 ∩ 面」的判定对象一致）；
 *  · 国界 —— 合并为一个 LineSegments（单次 draw call）。
 *  · 城市 —— 不画三维点云，城市信息只由 passLabels 中文标注层呈现（见 updatePassLabels）。 */
function buildPassLayers() {
  const scene = g.scene
  if (!scene) return
  clearPassLayers()

  const root = new THREE.Group()
  root.name = 'pass-layers'

  // ---- 过境目标面：边界线（中国行政区划面统一白色）+ 不可见拾取网格 ----
  const targetGroup = new THREE.Group()
  // cn：中国行政区划面（白色）；fg：其他国家国界面（沿用灰蓝 / 亮蓝两色）
  const cnHasSeg: number[] = []
  const cnNoneSeg: number[] = []
  const fgHasSeg: number[] = []
  const fgNoneSeg: number[] = []
  g.passTargetPickMeshes = []
  g.passTargetPickIds = []
  // 拾取材质共享（不渲染，仅参与 raycast）：Mesh 数量可达数百，避免逐个建材质
  const pickMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  for (const t of passTargets.value) {
    const seg = ringSegments(t.rings, PASS_TARGET_R * 1.0002)
    const hasData = passBatchCityIdSet.value.has(t.id)
    if (t.geo_type === 'district') (hasData ? cnHasSeg : cnNoneSeg).push(...seg)
    else (hasData ? fgHasSeg : fgNoneSeg).push(...seg)
    const geo = buildSphereFaceGeometry(t.rings, PASS_TARGET_R)
    if (!geo) continue
    const mesh = new THREE.Mesh(geo, pickMat)
    targetGroup.add(mesh)
    g.passTargetPickMeshes.push(mesh)
    g.passTargetPickIds.push(t.id)
  }
  const addLines = (arr: number[], color: number, opacity: number) => {
    if (!arr.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))
    targetGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity })))
  }
  // 中国行政区划面边界线一律白色；有过境数据的画得更亮（一眼看出哪些行政区划能点开明细）
  addLines(cnNoneSeg, 0xffffff, 0.72)
  addLines(cnHasSeg, 0xffffff, 1)
  // 其他国家国界面的目标线只作拾取提示（国界描边层另有浅蓝线），沿用「有数据更亮」的蓝灰口径
  addLines(fgNoneSeg, PASS_TARGET_LINE_NONE, 0.5)
  addLines(fgHasSeg, PASS_TARGET_LINE_HAS, 0.9)
  targetGroup.visible = passDistrictVisible.value
  root.add(targetGroup)

  // ---- 国界：按环逐段拆成线段，全部合并进一个缓冲 ----
  const borderGroup = new THREE.Group()
  const segPos: number[] = []
  for (const b of passBorders.value) {
    for (const ring of b.rings || []) {
      const n = ring?.length || 0
      if (n < 2) continue
      for (let i = 0; i < n; i++) pushArcSegments(segPos, ring[i], ring[(i + 1) % n], PASS_BORDER_R)
    }
  }
  if (segPos.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(segPos, 3))
    const line = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.72 })
    )
    borderGroup.add(line)
  }
  borderGroup.visible = passBorderVisible.value
  root.add(borderGroup)

  // 城市不再画三维点云：全局铺开的黄色小点既无层级信息（大小城市一样大），
  // 又会糊住行政区划面与国界，城市信息一律交给中文标注层（见 passLabels / updatePassLabels）。

  root.rotation.y = gstime(new Date(g.simTimeMs))
  root.visible = passMode.value
  g.passGroup = root
  g.passBorderGroup = borderGroup
  g.passDistrictGroup = targetGroup
  scene.add(root)
  // 框选叠加层是 passGroup 的子组，根组重建后需重画（顶点草稿保留在 scene.ts，不随图层释放）
  if (regionDraft.value.length || regionDrawMode.value) rebuildRegionOverlay()
  // 多区域框选叠加同样要在图层重建后补画（图层重建会释放整个 passGroup，叠加组随之一并消失）
  if (multiAreas.value.length || multiDraft.value.length || multiDrawMode.value) rebuildMultiOverlay()
  // 城市过境的「选中目标高亮面 + 全部卫星轨道线」同为 passGroup 子组，重建后同样按当前选中态补画
  resyncPassSelectionVisuals()
}

/** 最近一次已加载的过境批次 id：loadPassCityIds 把后端解析出的批次回填到 passBatchRunId 时，
 *  用它让 watch(passBatchRunId) 识别「这是回显而非用户切换」，避免多触发一次重载。 */
let loadedPassBatchId: number | null = null

/** 拉取指定批次有明细的城市 id 集合（城市列表 / 地球标注点据此过滤）。
 *  不传批次时按后端解析出的当前批次回填 passBatchRunId，供面板下拉回显。失败静默（集合为空即无标注）。 */
async function loadPassCityIds() {
  const wantRun = passBatchRunId.value || null
  // 本地持久缓存直出（城市列表的标注点立即可用），随后静默拉最新替换
  const persisted = await cacheGet<{ ids?: number[]; run_id?: number | null }>(PASS_CITY_IDS_CACHE_KEY(wantRun))
  if (persisted?.ids?.length && wantRun === (passBatchRunId.value || null) && !passBatchCityIds.value.length) {
    passBatchCityIds.value = persisted.ids
    if (persisted.run_id) loadedPassBatchId = persisted.run_id
  }
  try {
    const res = await getPassCityIds(passBatchRunId.value || undefined)
    passBatchCityIds.value = res?.ids || []
    loadedPassBatchId = res?.run_id ?? null
    if (res?.run_id) passBatchRunId.value = res.run_id
    void cacheSet(PASS_CITY_IDS_CACHE_KEY(wantRun), res)
    if (res?.run_id && res.run_id !== wantRun) void cacheSet(PASS_CITY_IDS_CACHE_KEY(res.run_id), res)
  } catch {
    if (!passBatchCityIds.value.length) passBatchCityIds.value = []
  }
}

/** 拉取过境数据批次列表（最近 N 个有汇总数据的成功批次），供面板「数据批次」下拉回看。失败静默。 */
async function loadPassBatches() {
  // 本地持久缓存直出（下拉立即可用），随后静默拉最新替换
  const persisted = await cacheGet<{ list?: typeof passBatches.value }>(PASS_BATCHES_CACHE_KEY)
  if (persisted?.list?.length && !passBatches.value.length) passBatches.value = persisted.list
  try {
    const res = await getPassBatches(12)
    passBatches.value = res?.list || []
    void cacheSet(PASS_BATCHES_CACHE_KEY, res)
  } catch {
    if (!passBatches.value.length) passBatches.value = []
  }
}

/** 拉取地理底图（行政区划面 + 国界 + 城市标注）并构建图层；已加载则直接重建（图例开关不重复请求）。
 *  数据批次：同时拉批次列表与「当前批次有明细的目标 id」，静态地理底图与批次无关。 */
async function loadPassGeo() {
  if (g.passGroup) return
  if (passDistricts.value.length || passBorders.value.length || passCities.value.length) {
    if (!passBatches.value.length) loadPassBatches()
    if (!passBatchCityIds.value.length) await loadPassCityIds()
    buildPassLayers()
    return
  }
  // 本地持久缓存直出：底图体量大且与批次无关，冷启动后首次进过境视图也能立刻出图
  const cached = await cacheGet<{ borders: typeof passBorders.value; districts: typeof passDistricts.value; provinces: typeof passProvinces.value; cities: typeof passCities.value }>(PASS_GEO_CACHE_KEY)
  const hasCached = !!cached && (cached.borders?.length || cached.districts?.length || cached.provinces?.length || cached.cities?.length)
  if (hasCached) {
    passBorders.value = cached!.borders || []
    passDistricts.value = cached!.districts || []
    passProvinces.value = cached!.provinces || []
    passCities.value = cached!.cities || []
    buildPassLayers()
    // 底图与批次无关：批次信息在缓存直出路径下也要补齐（本身已有持久缓存）
    void loadPassCityIds()
    void loadPassBatches()
    void refreshPassGeoInBackground()
    return
  }
  passGeoLoading.value = true
  passGeoError.value = ''
  try {
    const [res] = await Promise.all([getPassMap(), loadPassCityIds(), loadPassBatches()])
    if (disposed) return
    passBorders.value = res.borders || []
    passDistricts.value = res.districts || []
    passProvinces.value = res.provinces || []
    passCities.value = res.cities || []
    void cacheSet(PASS_GEO_CACHE_KEY, { borders: passBorders.value, districts: passDistricts.value, provinces: passProvinces.value, cities: passCities.value })
    buildPassLayers()
  } catch (e: unknown) {
    passGeoError.value = e instanceof Error ? e.message : '地理底图加载失败'
  } finally {
    passGeoLoading.value = false
  }
}

/** 后台静默刷新过境静态底图：失败静默。仅当各类数据条数与缓存不一致时才重建图层，
 *  避免同样的底图重建一次造成闪动。 */
async function refreshPassGeoInBackground() {
  try {
    const res = await getPassMap()
    if (disposed) return
    const b = res.borders || []
    const d = res.districts || []
    const pv = res.provinces || []
    const c = res.cities || []
    void cacheSet(PASS_GEO_CACHE_KEY, { borders: b, districts: d, provinces: pv, cities: c })
    if (b.length === passBorders.value.length && d.length === passDistricts.value.length
      && pv.length === passProvinces.value.length && c.length === passCities.value.length) return
    passBorders.value = b
    passDistricts.value = d
    passProvinces.value = pv
    passCities.value = c
    buildPassLayers()
  } catch { /* 静默：本地缓存底图仍可用 */ }
}

/** 静默预取过境静态底图与批次信息（只写数据，不建图层、不置任何 loading）。
 *  进入过境视图时 loadPassGeo 会因数据已在内存而直接 buildPassLayers，秒级出图；失败静默，
 *  真正进入过境模式时 loadPassGeo 会再请求一次并给出错误提示。 */
async function prefetchPass() {
  if (g.passGroup || passDistricts.value.length || passBorders.value.length || passCities.value.length) return
  try {
    const [res] = await Promise.all([getPassMap(), loadPassCityIds(), loadPassBatches()])
    if (disposed) return
    passBorders.value = res.borders || []
    passDistricts.value = res.districts || []
    passProvinces.value = res.provinces || []
    passCities.value = res.cities || []
    // 回写本地持久缓存：下次冷启动进过境视图即毫秒级直出
    void cacheSet(PASS_GEO_CACHE_KEY, { borders: passBorders.value, districts: passDistricts.value, provinces: passProvinces.value, cities: passCities.value })
  } catch { /* 预取失败静默，不影响任何交互 */ }
}

/** 地球夜晚灯光层（nightearth-4096.png 作为 emissiveMap）的挂 / 撤。
 *  过境视图撤下：城市灯光是自发光、不参与光照计算，会整片糊在地表上，
 *  与行政区划色块、城市点、过境标注抢视觉，导致目标面看不清。
 *  注意：emissiveMap 一旦为 null，emissive 颜色会变成整球平铺的纯色（泛白），
 *  故撤下时必须把 emissive 一并置黑；挂回时两者一起还原。
 *  emissiveMap 的有无会改变着色器分支，改后需 needsUpdate 触发重编译（仅在切换模式时发生，非每帧）。 */
function applyEarthNightLights(on: boolean) {
  const mat = g.earthMat
  if (!mat || !earthNightTex) return
  const want = on ? earthNightTex : null
  if (mat.emissiveMap === want) return
  mat.emissiveMap = want
  mat.emissive.set(on ? 0xffffff : 0x000000)
  mat.needsUpdate = true
  // 撤下期间贴图的 offset 停更（syncEarthSpin 只同步在册的贴图），挂回时立即对齐一次，
  // 避免灯光层与白天贴图错开一帧（灯光是自发光，错开会看到明显的亮斑偏移）
  if (on) syncEarthSpin()
}

/** 切换过境模式：进入显示地表叠加图层与过境标记、隐藏卫星云/轨道线/选中；退出反向恢复。
 *  过境视图（城市与区域）会把虚拟时间锁到「那次过境的时刻」（点选过境记录对齐到过境中点、区域过境播放沿 AOS→LOS 推进），
 *  退出时必须还原到真实时钟 —— 否则太阳方向、地球昼夜都会停在那次过境的时刻上：
 *  切回卫星列表 / 星座列表看着「昼夜分界回不到真实位置」，只有刷新页面才恢复。 */
function applyPassMode() {
  const on = passMode.value
  if (!on) {
    // 退出过境：虚拟时间从「过境时刻」还原 —— 对齐真实时钟
    g.simTimeMs = Date.now()
    syncEarthSpin()
  }
  // 过境视图撤下地球夜晚灯光层（详见 applyEarthNightLights）
  applyEarthNightLights(!on)
  // 例外 = NORAD 集合展示态（satSetActive）：集合叠加层在过境视图下仍要显示卫星云与过滤轨道线
  const hideCloud = (on || heatMode.value) && !satSetActive.value
  for (const model of modelKeys()) {
    const im = g.modelMeshes[model]
    if (im) im.visible = cloudGate() && (hideCloud ? false : modelVisible(model))
  }
  // 轨道线：热力/过境视图隐藏卫星云时一并隐藏，同时叠加图例的「轨道线」总开关
  const orbitOn = cloudGate() && !hideCloud && orbitVisible.value
  if (g.filterOrbitGroup) g.filterOrbitGroup.visible = orbitOn
  if (g.orbitLine) g.orbitLine.visible = orbitOn
  if (g.previewOrbitLine) g.previewOrbitLine.visible = orbitOn
  if (g.selAnchor) g.selAnchor.visible = !hideCloud
  if (g.passGroup) g.passGroup.visible = on
  if (g.regionPassGroup) g.regionPassGroup.visible = on
  if (g.multiPassGroup) g.multiPassGroup.visible = on
  if (g.passCityOrbitGroup) g.passCityOrbitGroup.visible = on
  if (g.passSatGroup) g.passSatGroup.visible = on
  if (on) {
    if (!g.passGroup && !passGeoLoading.value) loadPassGeo()
    else if (!g.passGroup) buildPassLayers()
  } else {
    // 退出过境：清空选中目标与明细、高亮面与过境标记（图层保留在场景中，下次进入无需重拉）
    passSelTarget.value = null
    passDetail.value = null
    passError.value = ''
    passDetailOpen.value = true
    clearPassHighlight()
    // 区域 / 多区域过境选中记录（卫星模型 / 轨道 / 扫描区域）也一并清除并交回时间推进
    clearRegionPass()
    clearMultiRegionPass()
    // 城市全部卫星轨道线 / 单次过境卫星模型与轨道线也一并清除
    clearPassCityOrbits()
    clearPassSatOrbit()
  }
}

/** 目标面拾取：射线命中点击位置所在的行政区划面 / 国界面（不可见拾取网格）。
 *  返回 pass_geo.id；未命中返回 null。仅在过境视图 + 行政区域图层可见 + 非框选模式时生效。 */
function pickPassTargetAt(px: number, py: number): number | null {
  const renderer = g.renderer, cam = g.camera, grp = g.passGroup
  if (!renderer || !cam || !grp || !g.passTargetPickMeshes.length) return null
  if (!passDistrictVisible.value || regionMode.value) return null
  const rect = renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  // 拾取网格挂在 passGroup 下并随其自转：点击时先把矩阵刷到最新，避免命中上一帧的位置
  grp.updateMatrixWorld(true)
  _ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1)
  _raycaster.setFromCamera(_ndc, cam)
  const hits = _raycaster.intersectObjects(g.passTargetPickMeshes, false)
  if (!hits.length) return null
  const idx = g.passTargetPickMeshes.indexOf(hits[0].object as THREE.Mesh)
  return idx >= 0 ? (g.passTargetPickIds[idx] ?? null) : null
}

/** 选中目标：高亮该目标的行政区划面 + 镜头转到该目标，并读取该目标未来 24h 过境明细
 *  （只读 pass_detail 预计算结果，毫秒级返回） */
async function selectPassTarget(targetId: number) {
  const target = findPassTargetById(targetId)
  if (!target) return
  passSelTarget.value = target
  passDetailOpen.value = true   // 重新点选目标：弹窗自动展开
  dockMode.value = 'pass'
  focusPassTarget(target)
  await loadPassTargetDetail(targetId)
}

/** 拉取单目标过境明细；带竞态保护：返回时已切换到别的目标则丢弃结果。
 *  明细只跟「目标 + 批次」有关、与批次内是稳定数据，故走本地持久缓存：再次点开同一目标秒出。
 *  opts.listOnly：AI 过境回答路径 —— 目标明细里全部卫星的轨道环照常构建，但只有随后的 show_satellites
 *  列出的那几颗可见（其余隐藏）；手动点选 / 「看全部过境」不传，明细全部卫星轨道环都可见。 */
async function loadPassTargetDetail(targetId: number, opts?: { listOnly?: boolean }) {
  passLoading.value = true
  passError.value = ''
  passDetail.value = null
  passOrbitListOnly = !!opts?.listOnly
  // 切换目标：先撤掉上一个目标的全部卫星轨道线，明细就绪后再按新目标重画
  clearPassCityOrbits()
  const runId = passBatchRunId.value || null
  const applyDetail = (res: Awaited<ReturnType<typeof getPassCityDetail>>) => {
    if (passSelTarget.value?.id !== targetId) return
    passDetail.value = res
    // 明细就绪：把该目标过境涉及的全部卫星各画一根整圈轨道线（内部自带竞态序号保护）；
    // 可见性由 syncPassCityOrbitVisibility 按「只显示列表」口径收口，非列表项构建后即隐藏
    void buildPassCityOrbits()
  }
  try {
    await cacheFirst(PASS_CITY_DETAIL_CACHE_KEY(targetId, runId), () => getPassCityDetail(targetId, runId ?? undefined), applyDetail)
  } catch (e: unknown) {
    if (passSelTarget.value?.id !== targetId) return
    passError.value = e instanceof Error ? e.message : '过境数据读取失败'
  } finally {
    if (passSelTarget.value?.id === targetId) passLoading.value = false
  }
}

/** 按目标 id 触发过境展示（供父组件「左侧目标列表项点击」调用，与直接点地球目标面同一路径）。
 *  opts.listOnly：透传给 loadPassTargetDetail —— AI 过境回答只让回答列出的卫星轨道环可见，其余隐藏。 */
async function pickPassTargetById(targetId: number, opts?: { listOnly?: boolean }) {
  const target = findPassTargetById(targetId)
  if (!target) return
  passSelTarget.value = target
  passDetailOpen.value = true   // 重新点选目标：弹窗自动展开
  focusPassTarget(target)
  await loadPassTargetDetail(targetId, opts)
}

/** 过境视图还原：清空选中目标与明细、高亮面与过境标记（地表图层保留） */
function resetPass() {
  passSelTarget.value = null
  passDetail.value = null
  passError.value = ''
  passDetailOpen.value = true   // 复位，下次点选目标默认展开
  passOrbitListOnly = false     // 复位可见性口径，下次手动点选恢复「明细全部卫星轨道可见」
  clearPassHighlight()
  // 区域 / 多区域过境选中记录（卫星模型 / 轨道 / 扫描区域）一并清除，播放状态归零
  clearRegionPass()
  clearMultiRegionPass()
  // 城市全部卫星轨道线 / 单次过境卫星模型与轨道线一并清除
  clearPassCityOrbits()
  clearPassSatOrbit()
}

/* ============================================================
 * 用户星历图层（星历分析模块）
 *  - 一份上传/内置的高精度星历 → 一条 ECI 惯性系轨迹线 + 当前位置标记；
 *  - 选中某条威胁事件 → 对方轨道环 + TCA 时刻两目标位置 + 最短距离连线；
 *  - 逐帧按 g.simTimeMs 用 Hermite 插值取本星位置、用开普勒解析推进取对方位置。
 * ============================================================ */
type V3 = [number, number, number]
/** 用户星历图层根节点（独立于卫星点云，显隐只由「星历分析」模块激活态决定） */
let userEphemGroup: THREE.Group | null = null
let userEphemSet: EphemSet | null = null
/** 本星当前位置（Group：承载 3D 模型与加载期间的占位圆点，位置 / 显隐统一由它决定） */
let userEphemMarker: THREE.Object3D | null = null
/** 本星 3D 模型（型号由星历名称解析，异步加载；就绪后替换占位圆点） */
let userEphemModel: THREE.Object3D | null = null
/** 模型加载序号：切换 / 清空星历时自增，让旧的异步加载结果作废，避免模型挂在已删除的星历上 */
let userEphemModelSeq = 0
/** 本星模型姿态解算用的场景速度（ECI 速度 → 场景坐标） */
const _ephVel = new THREE.Vector3()
let userEphemLine: THREE.Line | null = null
/** 当前时刻附近的亮色高亮弧（全长星历画成淡色背景，避免 3 天 × 45 圈叠成一条粗带） */
let userEphemArc: THREE.Line | null = null
let userEphemArcMs = -Infinity
/** 高亮弧的采样点数与时间跨度（当前时刻前后各 30 分钟） */
const EPHEM_ARC_N = 240
const EPHEM_ARC_HALF_MS = 30 * 60 * 1000
/** 事件图层（对方轨道 + 对方 3D 模型标记 + 连线） */
let userEphemEventGroup: THREE.Group | null = null
let userEphemOtherMarker: THREE.Object3D | null = null
/** 事件重建序号：对方模型异步加载完成时校验，避免旧结果挂到新选中的事件上 */
let userEphemEventSeq = 0
let userEphemLink: THREE.Mesh | null = null
let userEphemEvent: { tca: number; r: V3; v: V3 } | null = null
/** 机动仿真：机动后轨迹（橙色实线）+ 机动时刻标记；原方案在对比模式下改画虚线 */
let userEphemManeuverLine: THREE.Line | null = null
let userEphemManeuverMarker: THREE.Mesh | null = null
let userEphemManeuverStates: EphemState[] | null = null
let userEphemBurnMs: number | null = null
let userEphemSolidMat: THREE.LineBasicMaterial | null = null
let userEphemDashMat: THREE.LineDashedMaterial | null = null

/** 开普勒解析推进（仅椭圆轨道）：返回 dt 秒后的 ECI 位置；退化时返回 null */
function keplerPropagate(r: V3, v: V3, dtSec: number): V3 | null {
  const MU = 398600.4418
  const rn = Math.hypot(r[0], r[1], r[2])
  const vn2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
  if (!(rn > 0)) return null
  const a = 1 / (2 / rn - vn2 / MU)
  if (!(a > 0) || !Number.isFinite(a)) return null
  const h = [
    r[1] * v[2] - r[2] * v[1],
    r[2] * v[0] - r[0] * v[2],
    r[0] * v[1] - r[1] * v[0]
  ]
  const hn = Math.hypot(h[0], h[1], h[2])
  if (!(hn > 0)) return null
  const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
  const evec: V3 = [
    ((vn2 - MU / rn) * r[0] - rv * v[0]) / MU,
    ((vn2 - MU / rn) * r[1] - rv * v[1]) / MU,
    ((vn2 - MU / rn) * r[2] - rv * v[2]) / MU
  ]
  const e = Math.hypot(evec[0], evec[1], evec[2])
  if (e >= 1) return null
  // 近焦点系基向量：P 指向近地点，W 为法向，Q = W×P
  const P: V3 = e > 1e-8
    ? [evec[0] / e, evec[1] / e, evec[2] / e]
    : [r[0] / rn, r[1] / rn, r[2] / rn]
  const W: V3 = [h[0] / hn, h[1] / hn, h[2] / hn]
  const Q: V3 = [
    W[1] * P[2] - W[2] * P[1],
    W[2] * P[0] - W[0] * P[2],
    W[0] * P[1] - W[1] * P[0]
  ]
  const b = a * Math.sqrt(1 - e * e)
  const x0 = r[0] * P[0] + r[1] * P[1] + r[2] * P[2]
  const y0 = r[0] * Q[0] + r[1] * Q[1] + r[2] * Q[2]
  const E0 = Math.atan2(y0 / b, x0 / a + e)
  const n = Math.sqrt(MU / (a * a * a))
  let M = E0 - e * Math.sin(E0) + n * dtSec
  const twoPi = Math.PI * 2
  M = ((M % twoPi) + twoPi) % twoPi
  let E = M
  for (let i = 0; i < 8; i++) {
    const f = E - e * Math.sin(E) - M
    const fp = 1 - e * Math.cos(E)
    if (!(Math.abs(fp) > 1e-12)) break
    E -= f / fp
  }
  const x = a * (Math.cos(E) - e)
  const y = b * Math.sin(E)
  return [
    P[0] * x + Q[0] * y,
    P[1] * x + Q[1] * y,
    P[2] * x + Q[2] * y
  ]
}

/** 清空用户星历图层（含事件图层） */
function clearUserEphem() {
  // 星历图层没了，本星跟踪与准星一并解除（避免准星停在一个已不存在的位置）
  stopEphemTracking()
  userEphemModelSeq++
  userEphemModel = null
  if (userEphemGroup) {
    g.scene?.remove(userEphemGroup)
    disposeGroup(userEphemGroup)
  }
  userEphemGroup = null
  userEphemMarker = null
  userEphemLine = null
  userEphemArc = null
  userEphemArcMs = -Infinity
  userEphemEventGroup = null
  userEphemOtherMarker = null
  userEphemLink = null
  userEphemEvent = null
  userEphemGapLabel = null
  userEphemThreatSeq++
  userEphemThreatGroup = null
  userEphemThreatMeshes.clear()
  userEphemSelectedEventId = null
  releaseThreatLabelTextures()
  lastUserThreats = []
}

/** 设置 / 清空当前星历：重建轨迹线（按点数抽稀到 ≤ 720 段，避免 1.7 万点 × 3 的顶点开销） */
function setUserEphem(set: EphemSet | null) {
  // 星历重建 / 清空（含面板里删除或再次点击取消激活）时，旧的跟踪态与准星必须一起解除，
  // 否则会留下一个停在不存在的目标上的光环与名称标签
  stopEphemTracking()
  userEphemModelSeq++
  userEphemModel = null
  if (userEphemGroup) {
    g.scene?.remove(userEphemGroup)
    disposeGroup(userEphemGroup)
  }
  userEphemGroup = null
  userEphemMarker = null
  userEphemLine = null
  userEphemArc = null
  userEphemArcMs = -Infinity
  userEphemEventGroup = null
  userEphemOtherMarker = null
  userEphemLink = null
  userEphemEvent = null
  userEphemGapLabel = null
  // 威胁标记随 userEphemGroup 一起释放，这里只清引用并让异步加载结果失效
  userEphemThreatSeq++
  userEphemThreatGroup = null
  userEphemThreatMeshes.clear()
  userEphemSelectedEventId = null
  releaseThreatLabelTextures()
  userEphemManeuverLine = null
  userEphemManeuverMarker = null
  userEphemManeuverStates = null
  userEphemBurnMs = null
  userEphemSolidMat = null
  userEphemDashMat = null
  userEphemSet = set
  if (!set || !g.scene || !set.states.length) return

  const group = new THREE.Group()
  // 全长轨迹（3 天 ≈ 45 圈，缩到全球视角会叠成一条带）：降到低透明度只作背景参考
  const total = set.states.length
  const stride = Math.max(1, Math.ceil(total / 720))
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < total; i += stride) {
    const s = set.states[i]
    pts.push(eciToScene(s.r[0], s.r[1], s.r[2]))
  }
  if (pts.length > 1) pts.push(pts[0].clone())
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  // 实线（常规）与虚线（施加机动后对比用）两套材质，切换时只换 material 不重建几何
  const solidMat = new THREE.LineBasicMaterial({ color: 0x2f7fd0, transparent: true, opacity: 0.22 })
  const dashMat = new THREE.LineDashedMaterial({
    color: 0x5c83b8, transparent: true, opacity: 0.4, dashSize: 0.02, gapSize: 0.014
  })
  userEphemSolidMat = solidMat
  userEphemDashMat = dashMat
  const line = new THREE.Line(geo, solidMat)
  line.computeLineDistances()
  userEphemLine = line
  group.add(line)

  // 当前时刻 ±30 分钟的亮色弧：星历的「高精度」体现在这段可判读的弧上
  const arcGeo = new THREE.BufferGeometry()
  arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EPHEM_ARC_N * 3), 3).setUsage(THREE.DynamicDrawUsage))
  const arc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0x8ee9ff, transparent: true, opacity: 0.95 }))
  arc.frustumCulled = false
  userEphemArc = arc
  group.add(arc)

  // 当前位置标记：Group 承载目标 3D 模型（型号按星历名称解析，异步加载），
  // 模型就绪前先用略大于普通卫星点的实心圆点占位，避免加载期间目标完全不可见
  const marker = new THREE.Group()
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.0055, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x9df0ff })
  )
  marker.add(dot)
  userEphemMarker = marker
  group.add(marker)
  const modelSeq = userEphemModelSeq
  const modelKey = resolveModelKey({ object_type: 'PAYLOAD', object_name: set.name })
  void loadGeom(modelUrlOf(modelKey, 'high'), MODEL_COARSE[modelKey] || 'UNKNOWN', modelKey).then((gm) => {
    // 加载期间星历可能已切换 / 被删除：序号不符直接丢弃
    if (!gm || modelSeq !== userEphemModelSeq || !userEphemMarker) return
    const mesh = new THREE.Mesh(
      gm.geom.clone(),
      new THREE.MeshStandardMaterial({
        color: 0x9df0ff,
        metalness: 0.4,
        roughness: 0.3,
        emissive: 0x2f8fb0,
        emissiveIntensity: 0.8
      })
    )
    // 与卫星云里的模型同一尺寸（几何已按 MODEL_MAX_DIM 归一化），不再额外放大：
    // 星历跟踪与「目标列表选中」用的是同一个落位距离 TRACK_CAM_DIST，缩放一致才能得到同样的镜头观感
    mesh.scale.setScalar(1)
    userEphemModel = mesh
    userEphemMarker.add(mesh)
    dot.visible = false
  })

  userEphemGroup = group
  g.scene.add(group)
  // 星历重建后把上一次的威胁点云重新挂上（切换星历时通常已被清空）
  setUserEphemThreats(lastUserThreats)
  updateUserEphem()
}

/** 威胁事件标记组：每个事件一颗对方卫星的 3D 模型 + 「目标ID · 时间」小标签 */
let userEphemThreatGroup: THREE.Group | null = null
/** 标签 canvas 贴图（SpriteMaterial.map）：disposeGroup 不回收材质贴图，单独记录并释放 */
let userEphemThreatTexes: THREE.Texture[] = []
/** 标记重建序号：模型异步加载完成时校验，避免旧结果挂到新的列表上 */
let userEphemThreatSeq = 0
let lastUserThreats: ThreatEvent[] = []
/** 事件标签 Sprite（逐帧按相机距离缩放，近距离观察时保持屏幕尺寸不变） */
const userEphemThreatLabels: THREE.Sprite[] = []
/** 选中事件的「间距 xx km」标签（同上，逐帧缩放） */
let userEphemGapLabel: THREE.Sprite | null = null
/** 威胁事件静态模型（事件 id → 模型）：选中某条事件时隐藏它的静态模型，
 *  改由事件图层的「对方模型」按仿真时刻沿轨道推进，避免两个模型完全重合闪烁 */
const userEphemThreatMeshes = new Map<string, THREE.Object3D>()
let userEphemSelectedEventId: string | null = null

/** 威胁等级配色（与事件列表 / 详情卡同一口径） */
const THREAT_LEVEL_HEX: Record<ThreatEvent['level'], number> = { high: 0xff6b6b, medium: 0xffb454, low: 0x5aa9ff }

/** 威胁事件目标模型相对「卫星云模型」的放大倍数（1 = 与星历本星模型同一尺寸，靠镜头拉近观察） */
const THREAT_MODEL_SCALE = 1

/** 威胁事件定位时的镜头距离（场景单位，地球半径 = 1）：0.06 约等于「贴着事件点看」的近距离，
 *  1 倍模型下仍能看清太阳翼结构 */
const THREAT_CAM_DIST = 0.06

/** TCA 时刻 → `MM-DD HH:mm`（UTC，与面板里的事件时刻同口径） */
function threatTimeText(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 「目标名称 · 时间」小标签（canvas 贴图 Sprite；颜色按风险等级）。
 *  名称与事件列表 / 详情卡同一口径（STARLINK-xxxxx），不用 NORAD 数字，避免和双方目标对不上。 */
function threatLabelSprite(ev: ThreatEvent): THREE.Sprite | null {
  const H = 56
  const text = `${ev.otherName} · ${threatTimeText(ev.tca)}`
  const font = 'bold 24px "Microsoft YaHei", sans-serif'
  const cv = document.createElement('canvas')
  const measure = cv.getContext('2d')
  if (!measure) return null
  measure.font = font
  // 宽度按文字实际占位自适应（名称长度不一，固定宽度会被裁切）
  const W = Math.max(360, Math.ceil(measure.measureText(text).width) + 40)
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  const color = `#${THREAT_LEVEL_HEX[ev.level].toString(16).padStart(6, '0')}`
  ctx.fillStyle = 'rgba(8,14,24,0.78)'
  ctx.fillRect(0, 6, W, H - 12)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(1, 7, W - 2, H - 14)
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, W / 2, H / 2)
  const tex = new THREE.CanvasTexture(cv)
  tex.needsUpdate = true
  userEphemThreatTexes.push(tex)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  // 场景单位 / 像素沿用原 384×56 → 0.13×0.019 的字高口径
  const k = 0.13 / 384
  sprite.userData.baseW = W * k
  sprite.userData.baseH = H * k
  sprite.scale.set(W * k, H * k, 1)
  // 锚点逐帧按相机距离调整（见 scaleEphemLabel）：镜头拉近后标签仍浮在模型上方且尺寸不变
  sprite.center.set(0.5, -1.2)
  userEphemThreatLabels.push(sprite)
  return sprite
}

/** 重建 / 清除威胁标记前释放标签贴图（disposeGroup 不处理 material.map） */
function releaseThreatLabelTextures() {
  for (const t of userEphemThreatTexes) t.dispose()
  userEphemThreatTexes = []
  userEphemThreatLabels.length = 0
}

/** 标签按相机距离等比缩放（保持屏幕尺寸恒定，镜头拉近时不会铺满整屏），
 *  并按模型尺寸把标签贴到锚点上方（side = -1）或下方（side = 1）。 */
function scaleEphemLabel(sp: THREE.Sprite | null, side: -1 | 1) {
  const cam = g.camera
  if (!cam || !sp) return
  const baseW = Number(sp.userData.baseW) || 0.13
  const baseH = Number(sp.userData.baseH) || 0.019
  const dist = cam.position.distanceTo(sp.position)
  // 远处保持原有尺寸；近处按比例收缩，屏幕尺寸不变
  const f = Math.min(1, Math.max(dist, 0.004))
  sp.scale.set(baseW * f, baseH * f, 1)
  // 模型半宽（场景单位）+ 一点余量，换算成「标签高度」倍数
  const half = (MODEL_MAX_DIM * THREAT_MODEL_SCALE) / 2 + 0.002
  const c = Math.min(60, Math.max(0.8, half / (baseH * f)))
  sp.center.set(0.5, side < 0 ? -c : 1 + c)
}

/** 设置威胁事件标记（空数组 = 清除）：每个事件在交会位置放一颗对方卫星 3D 模型，
 *  并在模型上方标出「目标名称 · 时间」。星历重建后会自动重挂最后一次的结果 */
function setUserEphemThreats(list: ThreatEvent[]) {
  lastUserThreats = list.slice()
  const seq = ++userEphemThreatSeq
  if (userEphemThreatGroup && userEphemGroup) {
    userEphemGroup.remove(userEphemThreatGroup)
    disposeGroup(userEphemThreatGroup)
  }
  userEphemThreatGroup = null
  userEphemThreatMeshes.clear()
  releaseThreatLabelTextures()
  if (!list.length || !userEphemGroup) return
  const group = new THREE.Group()
  for (const ev of list) {
    const p = eciToScene(ev.midEci[0], ev.midEci[1], ev.midEci[2])
    const color = THREAT_LEVEL_HEX[ev.level]
    // 只给当前选中事件挂「名称 · 时间」标签：其余事件只留三维模型，
    // 否则画面上会出现一串与「双方目标」无关的其他卫星名称，容易被误读
    if (ev.id === userEphemSelectedEventId) {
      const label = threatLabelSprite(ev)
      if (label) {
        label.position.copy(p)
        group.add(label)
      }
    }
    // 对方卫星模型：放在对方 TCA 的真实位置（与本星 TCA 位置相距即最小距离，远看几乎重合）
    const mp = ev.otherEci ? eciToScene(ev.otherEci[0], ev.otherEci[1], ev.otherEci[2]) : p
    // 型号按对方名称解析（同一型号复用 geomCache，不会重复下载）
    const modelKey = resolveModelKey({ object_type: 'PAYLOAD', object_name: ev.otherName })
    void loadGeom(modelUrlOf(modelKey, 'high'), MODEL_COARSE[modelKey] || 'UNKNOWN', modelKey).then((gm) => {
      // 加载期间列表已重建 / 星历已切换：丢弃结果
      if (!gm || seq !== userEphemThreatSeq) return
      const mesh = new THREE.Mesh(gm.geom.clone(), new THREE.MeshStandardMaterial({
        color: 0xdfe9f5,
        metalness: 0.4,
        roughness: 0.35,
        emissive: color,
        emissiveIntensity: 0.55
      }))
      mesh.position.copy(mp)
      mesh.scale.setScalar(THREAT_MODEL_SCALE)
      const vel = ev.otherVel ? eciToScene(ev.otherVel[0], ev.otherVel[1], ev.otherVel[2]) : _zeroVel
      orbitAttitude(mp, vel, mesh.quaternion)
      userEphemThreatMeshes.set(ev.id, mesh)
      // 该事件已被选中：静态模型让位给事件图层的「对方模型」
      if (ev.id === userEphemSelectedEventId) mesh.visible = false
      group.add(mesh)
    })
  }
  userEphemThreatGroup = group
  userEphemGroup.add(group)
}

/** 选中威胁事件：画对方轨道环 + 对方 3D 模型标记 + 最短距离连线 */
function setUserEphemEvent(ev: ThreatEvent | null) {
  // 恢复上一条被隐藏的静态模型（本次选中事件的静态模型稍后隐藏，由事件图层的推进模型代替）
  if (userEphemSelectedEventId) {
    const prev = userEphemThreatMeshes.get(userEphemSelectedEventId)
    if (prev) prev.visible = true
  }
  userEphemSelectedEventId = null
  userEphemEventSeq++
  if (userEphemEventGroup) {
    userEphemGroup?.remove(userEphemEventGroup)
    disposeGroup(userEphemEventGroup)
  }
  userEphemEventGroup = null
  userEphemOtherMarker = null
  userEphemLink = null
  userEphemEvent = null
  userEphemGapLabel = null
  if (!ev || !userEphemGroup || !ev.otherEci || !ev.otherVel) return
  // 选中事件的静态模型让位给下面按仿真时刻推进的「对方模型」，避免两个模型完全重合闪烁
  userEphemSelectedEventId = ev.id
  const selectedMesh = userEphemThreatMeshes.get(ev.id)
  if (selectedMesh) selectedMesh.visible = false
  // 标签只挂选中事件：选中项变了就重建一次标记组
  setUserEphemThreats(lastUserThreats)

  const group = new THREE.Group()
  // 对方轨道环：以 TCA 状态做开普勒解析推进，采样一整圈
  const rn = Math.hypot(ev.otherEci[0], ev.otherEci[1], ev.otherEci[2])
  const vn2 = ev.otherEci[0] ** 2 + ev.otherEci[1] ** 2 + ev.otherEci[2] ** 2
  const a = 1 / (2 / rn - vn2 / 398600.4418)
  const periodSec = a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / 398600.4418) : 5400
  const steps = 240
  const ring: THREE.Vector3[] = []
  for (let i = 0; i <= steps; i++) {
    const p = keplerPropagate(ev.otherEci, ev.otherVel, (i / steps) * periodSec)
    if (!p) break
    ring.push(eciToScene(p[0], p[1], p[2]))
  }
  if (ring.length > 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(ring)
    group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.95 })))
  }
  // 对方标记：一颗对方卫星的 3D 模型（随后逐帧按 g.simTimeMs 沿轨道推进，位置即 TCA 位置）
  const other = new THREE.Group()
  other.position.copy(eciToScene(ev.otherEci[0], ev.otherEci[1], ev.otherEci[2]))
  userEphemOtherMarker = other
  group.add(other)
  const evSeq = ++userEphemEventSeq
  const otherKey = resolveModelKey({ object_type: 'PAYLOAD', object_name: ev.otherName })
  void loadGeom(modelUrlOf(otherKey, 'high'), MODEL_COARSE[otherKey] || 'UNKNOWN', otherKey).then((gm) => {
    if (!gm || evSeq !== userEphemEventSeq) return
    const mesh = new THREE.Mesh(gm.geom.clone(), new THREE.MeshStandardMaterial({
      color: 0xdfe9f5,
      metalness: 0.4,
      roughness: 0.35,
      emissive: 0xff9a6b,
      emissiveIntensity: 0.5
    }))
    mesh.scale.setScalar(THREAT_MODEL_SCALE)
    other.add(mesh)
  })
  // 最短距离连线（TCA 时刻两目标位置之间）：WebGL 线宽固定 1px，改用细圆柱保证全球视角可见
  const pA = eciToScene(ev.midEci[0], ev.midEci[1], ev.midEci[2])
  const pB = eciToScene(ev.otherEci[0], ev.otherEci[1], ev.otherEci[2])
  const gapVec = new THREE.Vector3().subVectors(pB, pA)
  const gapLen = gapVec.length()
  const link = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0016, 0.0016, Math.max(gapLen, 1e-4), 6),
    new THREE.MeshBasicMaterial({ color: 0xffd166 })
  )
  link.position.copy(pA).addScaledVector(gapVec, 0.5)
  link.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), gapVec.clone().normalize())
  userEphemLink = link
  group.add(link)

  // 间距标签：十几公里的间距在球面尺度下不足 1 像素，直接以文字给出数值
  const labelCv = document.createElement('canvas')
  labelCv.width = 256
  labelCv.height = 64
  const lctx = labelCv.getContext('2d')
  if (lctx) {
    lctx.fillStyle = 'rgba(12,18,24,0.82)'
    lctx.fillRect(8, 10, 240, 44)
    lctx.font = 'bold 30px "Microsoft YaHei", sans-serif'
    lctx.textAlign = 'center'
    lctx.textBaseline = 'middle'
    lctx.fillStyle = '#ffd166'
    lctx.fillText(`间距 ${ev.missKm.toFixed(2)} km`, 128, 33)
    const tex = new THREE.CanvasTexture(labelCv)
    tex.needsUpdate = true
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
    sprite.position.copy(pA).addScaledVector(gapVec, 0.5)
    sprite.userData.baseW = 0.1
    sprite.userData.baseH = 0.025
    sprite.scale.set(0.1, 0.025, 1)
    userEphemGapLabel = sprite
    group.add(sprite)
  }

  userEphemEvent = { tca: ev.tca, r: ev.otherEci, v: ev.otherVel }
  userEphemEventGroup = group
  userEphemGroup.add(group)
  updateUserEphem()
}

/** 星历本星跟踪态（点击星历面板里的星历触发）：镜头逐帧跟随本星当前位置 */
let trackEphem = false
/** 本星上一帧的场景坐标（与当前帧求差得到镜头平移量） */
const _trackEphemPrev = new THREE.Vector3()

/** 逐帧：更新本星标记位置（Hermite 插值）+ 事件对方标记（开普勒推进） */
function updateUserEphem() {
  const group = userEphemGroup
  if (!group) return
  group.visible = dockActive.value === 'eph'
  if (!group.visible || !userEphemSet) return
  // 标签按当前相机距离缩放并贴到模型外侧：拉近观察事件点时文字不会被放大成整屏
  for (const sp of userEphemThreatLabels) scaleEphemLabel(sp, -1)
  scaleEphemLabel(userEphemGapLabel, 1)
  // 选中某条事件时，其余事件的模型会让画面混入无关卫星：只保留事件图层里的「本星 + 对方」
  // （注意不能整组隐藏：选中事件的标签就挂在这个组里）
  if (userEphemSelectedEventId) {
    for (const m of userEphemThreatMeshes.values()) m.visible = false
  } else {
    for (const m of userEphemThreatMeshes.values()) m.visible = true
  }
  // 间距连线：圆柱半径同样按距离收缩（否则拉近后会变成一个比两颗星还大的六边形块）
  if (userEphemLink && g.camera) {
    const dl = Math.min(1, Math.max(g.camera.position.distanceTo(userEphemLink.position), 0.004))
    userEphemLink.scale.set(dl, 1, dl)
  }
  // 机动生效后（simTime ≥ 机动时刻）当前位置 / 弧段改用机动后的状态序列，双轨迹才真实
  const states = userEphemManeuverStates && userEphemBurnMs != null && g.simTimeMs >= userEphemBurnMs
    ? userEphemManeuverStates
    : userEphemSet.states
  const s = interpolateAt(states, g.simTimeMs)
  if (userEphemMarker) {
    if (s) {
      userEphemMarker.visible = true
      userEphemMarker.position.copy(eciToScene(s.r[0], s.r[1], s.r[2]))
      // 3D 模型定姿：机头（本地 +Z）对齐当地天顶、机身 +Y 对齐飞行方向（与卫星云同一口径）
      if (userEphemModel) {
        _ephVel.copy(eciToScene(s.v[0], s.v[1], s.v[2]))
        orbitAttitude(userEphemMarker.position, _ephVel, userEphemModel.quaternion)
      }
    } else {
      userEphemMarker.visible = false
    }
  }
  // 亮色弧每秒重建一次（240 点，开销可忽略），避免每帧重算
  if (userEphemArc && Math.abs(g.simTimeMs - userEphemArcMs) >= 1000) {
    userEphemArcMs = g.simTimeMs
    const attr = userEphemArc.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const st = states
    let cnt = 0
    for (let i = 0; i < EPHEM_ARC_N; i++) {
      let t = g.simTimeMs - EPHEM_ARC_HALF_MS + (i / (EPHEM_ARC_N - 1)) * 2 * EPHEM_ARC_HALF_MS
      if (t < st[0].t) t = st[0].t
      else if (t > st[st.length - 1].t) t = st[st.length - 1].t
      const p = interpolateAt(st, t)
      if (!p) continue
      const v = eciToScene(p.r[0], p.r[1], p.r[2])
      arr[cnt * 3] = v.x
      arr[cnt * 3 + 1] = v.y
      arr[cnt * 3 + 2] = v.z
      cnt++
    }
    attr.needsUpdate = true
    userEphemArc.geometry.setDrawRange(0, cnt)
  }
  if (userEphemEvent && userEphemOtherMarker) {
    const dtSec = (g.simTimeMs - userEphemEvent.tca) / 1000
    const p = keplerPropagate(userEphemEvent.r, userEphemEvent.v, dtSec)
    if (p) {
      userEphemOtherMarker.visible = true
      const pos = eciToScene(p[0], p[1], p[2])
      userEphemOtherMarker.position.copy(pos)
      // 模型定姿：用 1 秒后位置差分出速度方向（与卫星云 / 本星模型同一口径）
      const pNext = keplerPropagate(userEphemEvent.r, userEphemEvent.v, dtSec + 1)
      if (pNext) {
        _ephVel.subVectors(eciToScene(pNext[0], pNext[1], pNext[2]), pos)
        orbitAttitude(pos, _ephVel, userEphemOtherMarker.quaternion)
      }
    } else {
      userEphemOtherMarker.visible = false
    }
  }
  // 本星跟踪：与双击卫星同口径，镜头与环绕焦点逐帧随目标平移（保持落位时的相对机位），目标恒居中
  if (trackEphem && g.selAnchor && userEphemMarker?.visible) {
    const p = userEphemMarker.position
    const cam = g.camera, controls = g.controls
    if (cam && controls) {
      _trackDelta.subVectors(p, _trackEphemPrev)
      cam.position.add(_trackDelta)
      controls.target.add(_trackDelta)
    }
    _trackEphemPrev.copy(p)
    g.selAnchor.position.copy(p)
  }
}

/** 星历实际数据的末时刻（内置样本等元数据跨度可能长于状态序列，一律以状态序列为准） */
function ephemEndMs(set: { states: EphemState[]; stop: number }): number {
  return set.states.length ? set.states[set.states.length - 1].t : set.stop
}

/** 把虚拟时刻对齐到星历数据范围（过期星历 / 未来星历都能正常显示） */
function clampEphemTime() {
  const set = userEphemSet
  if (!set || !set.states.length) return
  const t0 = set.states[0].t
  const t1 = ephemEndMs(set)
  if (g.simTimeMs < t0) g.simTimeMs = t0
  else if (g.simTimeMs > t1) g.simTimeMs = t1
}

/** 定位到当前星历目标：时间对齐 + 镜头飞到当前位置 */
function focusUserEphem() {
  clampEphemTime()
  updateUserEphem()
  if (userEphemMarker?.visible) flyToPoint(userEphemMarker.position.clone(), 'point')
}

/** 解除星历本星跟踪（星历轨迹 / 亮弧 / 机动轨迹保持不变，只停镜头跟随并收起准星） */
function stopEphemTracking() {
  trackEphem = false
  // 准星锚点只在「跟踪星历本星」时由本模块创建；编目卫星选中态（hasSel）的锚点不能动
  if (!hasSel.value && g.selAnchor) {
    g.scene?.remove(g.selAnchor)
    g.selAnchor = null
  }
}

/** 星历面板点选星历：复用「双击卫星」的落位与跟随（TRACK_CAM_DIST 机位 + 准星 + 逐帧跟随），
 *  轨道仍按星历当前显示模式呈现（全长轨迹 / 当前亮弧 / 机动双轨迹），不重建编目轨道。 */
function trackUserEphem() {
  if (!userEphemSet || !userEphemGroup) return
  // 编目卫星的选中态与星历跟踪互斥：先清掉旧选中（保留当前机位），避免两套准星 / 轨道抢占
  if (hasSel.value || g.satrec) resetSelected(false)
  stopEphemTracking()
  clampEphemTime()
  updateUserEphem()
  if (!g.scene || !userEphemMarker?.visible) return
  const pos = userEphemMarker.position.clone()
  const anchor = new THREE.Group()
  anchor.position.copy(pos)
  g.selAnchor = anchor
  g.scene.add(anchor)
  sel.name = userEphemSet.name
  trackEphem = true
  _trackEphemPrev.copy(pos)
  const cam = g.camera, controls = g.controls
  if (!cam || !controls) return
  // 与双击卫星一致：镜头—目标—地心共线，距离拉到 TRACK_CAM_DIST（模型可完整看清）
  const off = clampPolarToLimit(pos.clone().normalize())
  beginCamFly(pos.clone().addScaledVector(off, TRACK_CAM_DIST), pos.clone(), 'sel')
}

/** 定位到某条威胁事件：时间对齐到 TCA + 镜头飞到两目标中点 */
function focusUserEphemEvent(ev: ThreatEvent | null) {
  // 事件定位与「本星跟踪」互斥，否则镜头会被本星逐帧拽回
  stopEphemTracking()
  setUserEphemEvent(ev)
  if (!ev) return
  // 近距离机位下 1 倍速的位移几秒内就会飞出视野：定位事件时暂停仿真，保持 TCA 定格观察
  simPlaying.value = false
  g.simTimeMs = ev.tca
  updateUserEphem()
  const mid = new THREE.Vector3()
    .add(eciToScene(ev.midEci[0], ev.midEci[1], ev.midEci[2]))
    .add(eciToScene(ev.otherEci![0], ev.otherEci![1], ev.otherEci![2]))
    .multiplyScalar(0.5)
  // 交会事件用近距离机位：1 倍模型在地球尺度下只有几个像素，必须拉近才能看清两颗卫星
  flyToPoint(mid, 'point', THREAT_CAM_DIST)
}

/** 把 ECI 坐标投影为视口像素（右侧事件详情卡跟随交会点定位用）；
 *  相机后方 / 投影异常时返回 null，调用方据此保持原位或隐藏 */
function projectEciToViewport(r: V3): { x: number; y: number } | null {
  const cam = g.camera
  const renderer = g.renderer
  if (!cam || !renderer) return null
  _proj.copy(eciToScene(r[0], r[1], r[2])).project(cam)
  if (!(_proj.z > -1 && _proj.z < 1)) return null
  const rect = renderer.domElement.getBoundingClientRect()
  return {
    x: rect.left + (_proj.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-_proj.y * 0.5 + 0.5) * rect.height
  }
}

/** 机动仿真：设置机动后的星历（null = 清除），三维画「原方案虚线 + 机动后橙色实线」双轨迹；
 *  机动时刻处加一颗琥珀色标记，机动前（含当前位置与亮色弧）仍用原状态，机动后改用新状态。 */
function setUserEphemManeuver(states: EphemState[] | null, burnMs: number | null) {
  const clearLine = () => {
    if (userEphemManeuverLine) {
      userEphemGroup?.remove(userEphemManeuverLine)
      userEphemManeuverLine.geometry.dispose()
      ;(userEphemManeuverLine.material as THREE.Material).dispose()
      userEphemManeuverLine = null
    }
    if (userEphemManeuverMarker) {
      userEphemGroup?.remove(userEphemManeuverMarker)
      userEphemManeuverMarker.geometry.dispose()
      ;(userEphemManeuverMarker.material as THREE.Material).dispose()
      userEphemManeuverMarker = null
    }
  }
  clearLine()
  userEphemManeuverStates = null
  userEphemBurnMs = null
  // 未施加机动：原方案恢复实线
  if (userEphemLine && userEphemSolidMat) userEphemLine.material = userEphemSolidMat
  if (!states || !states.length || burnMs == null || !userEphemGroup || !userEphemLine) {
    updateUserEphem()
    return
  }
  userEphemManeuverStates = states
  userEphemBurnMs = burnMs
  // 对比模式：原方案改虚线，避免两条轨迹在地球同侧重叠时难以分辨
  if (userEphemDashMat) userEphemLine.material = userEphemDashMat

  // 机动后轨迹：只画机动时刻之后的部分（之前与原方案完全重合）
  const from = Math.max(0, states.findIndex((s) => s.t >= burnMs))
  const total = states.length - from
  if (total > 1) {
    const stride = Math.max(1, Math.ceil(total / 720))
    const pts: THREE.Vector3[] = []
    for (let i = from; i < states.length; i += stride) {
      const s = states[i]
      pts.push(eciToScene(s.r[0], s.r[1], s.r[2]))
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9 }))
    line.frustumCulled = false
    userEphemManeuverLine = line
    userEphemGroup.add(line)
  }
  const burn = interpolateAt(states, burnMs)
  if (burn) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd166 })
    )
    marker.position.copy(eciToScene(burn.r[0], burn.r[1], burn.r[2]))
    userEphemManeuverMarker = marker
    userEphemGroup.add(marker)
  }
  updateUserEphem()
}

/* ============================================================
 * 动画循环
 * ============================================================ */
/** 仿真时间条 UI 回写节流（ms）：5Hz 足够跟手，又不让每帧写 ref 触发重渲染 */
const SIM_UI_INTERVAL_MS = 200
let lastSimUiMs = 0

function startAnimation() {
  cancelAnimationFrame(g.rafId)
  g.lastTs = performance.now()
  fpsWarmupUntil = performance.now() + 6000
  lodWarmupUntil = performance.now() + LOD_WARMUP_MS
  const loop = (now: number) => {
    g.rafId = requestAnimationFrame(loop)
    const frameMs = now - g.lastTs
    const dt = Math.min(frameMs / 1000, 0.1)
    g.lastTs = now
    // 框选期间同样冻结虚拟时间（interacting 含 regionDrawMode）：地球与贴地层静止，
    // 否则自转会让「点击时刻的拾取点」与「渲染时刻的位置」错位，框选结果偏移
    const interacting = g.userInteracting || regionDrawMode.value
    // 区域 / 多区域过境选中态：虚拟时间交给播放条接管 —— 播放时沿 AOS→LOS 推进（地球随 gstime 自转、
    // 卫星模型沿轨道飞行），未播放时冻结在该时刻（卫星/轨道/扫描区域静态呈现，三者时刻一致）。
    // 两套状态各自独立、互不打断，但面板互斥：同一时刻只有一套处于选中（region 优先，仅作兜底）。
    const passSlot = passSlots.region.t1 > passSlots.region.t0
      ? passSlots.region
      : (passSlots.multi.t1 > passSlots.multi.t0 ? passSlots.multi : null)
    let simStepSec = interacting || !simPlaying.value ? 0 : dt * simSpeed.value
    if (passSlot) {
      if (passSlot.playing.value) {
        simStepSec = REGION_PASS_PLAY_SPEED
        if (g.simTimeMs + simStepSec * 1000 >= passSlot.t1) {
          simStepSec = Math.max(0, (passSlot.t1 - g.simTimeMs) / 1000)
          passSlot.playing.value = false
        }
      } else {
        simStepSec = 0
      }
    }
    // 快照时间追赶：把「本地缓存快照 → 最新快照」的时刻差在 CLOUD_WARP_MS 内连续补齐（见 patchCloudCoords），
    // 而不是把坐标一次性换掉（那会在画面里闪一下）。过境播放自带时钟、热力/过境视图不显示卫星云，故都跳过；
    // 交互期（拖拽/缩放）暂停追赶，松手后继续。
    if (warpRes && !passSlot && !interacting && simPlaying.value && !heatMode.value && !passMode.value) {
      const remain = warpEndWall - now
      const gapMs = warpToMs - g.simTimeMs
      if (remain <= 0 || gapMs <= 0) {
        const res = warpRes
        warpRes = null
        // 落位：套用最新坐标（残差走平滑，不再跳）
        applyCloudCoords(res, true)
        simStepSec = 0
      } else {
        // 按剩余墙钟时间线性消耗时刻差；单帧推进量夹在积分粒度内
        const step = (gapMs / 1000) * (Math.min(dt * 1000, remain) / remain)
        simStepSec = Math.max(simStepSec, Math.min(step, MAX_WARP_STEP_SEC))
      }
    }
    g.simTimeMs += simStepSec * 1000
    // 星历仿真：跑到数据末端自动停在最后一帧，避免插值越界导致本星标记 / 亮弧消失
    if (simPlaying.value && dockActive.value === 'eph' && userEphemSet) {
      const endMs = ephemEndMs(userEphemSet)
      if (g.simTimeMs >= endMs) {
        g.simTimeMs = endMs
        simPlaying.value = false
      }
    }
    // 时间条播放头：节流回写当前虚拟时刻（暂停 / 拖动后也能立即对齐）
    if (now - lastSimUiMs >= SIM_UI_INTERVAL_MS) {
      lastSimUiMs = now
      simTimeMs.value = g.simTimeMs
    }
    if (passSlot) {
      passSlot.progress.value = Math.max(0, Math.min(1, (g.simTimeMs - passSlot.t0) / (passSlot.t1 - passSlot.t0)))
    }

    // 碎片 / 箭体 360° 翻滚：姿态相位按真实帧间隔累积、交互期冻结（与世界冻结口径一致）
    if (!interacting) tumbleClock += dt

    syncEarthSpin()
    // 区域 / 多区域过境选中的卫星模型：位置 / 姿态随虚拟时间逐帧重算（机身长轴恒垂直地球）
    updatePassModel('region')
    updatePassModel('multi')
    // 单次过境选中的卫星模型：位置 / 姿态随虚拟时间逐帧重算（机身长轴恒垂直地球）
    updatePassSatModel()
    // 太阳光方向 / 太阳标记 / 月亮 / 极光环 / 太阳风粒子（内部含图层显隐判定）
    updateSky(dt)
    // 星历分析：本星标记按 Hermite 插值逐帧更新，事件对方标记按开普勒解析推进
    updateUserEphem()
    // 发射站光晕呼吸脉冲（图层隐藏时内部直接跳过）
    updateSiteGlow(now)
    // 发射站选中涟漪扩散（3 轮后自动隐藏；未选中 / 已播完时内部直接跳过）
    updateSiteRipple(now)

    // 热力 / 过境模式仅显示固定时刻的事件标记或地表叠加图层：跳过卫星外推/校准/过滤轨道线，省预算
    if (!heatMode.value && !passMode.value) {
      // 位置校正的平滑：把本帧该补的位移补回（见 decayPositionOffsets）。
      // 待补位移很多（整份快照替换）时让它顺带触发本帧整批矩阵重写，省掉逐条重写
      if (simStepSec > 0 && decayPositionOffsets(dt)) matrixDrift = MATRIX_SKIP_SCENE
      updateExtrapolate(simStepSec)

      if (!g.userInteracting) {
        if (g.filterOrbitQueue.length) {
          stepFilterOrbits({ n: propBudget })
        } else if (g.filterOrbitItems.length) {
          const b = { n: Math.floor(propBudget * 0.7) }
          updateFilterOrbitsLive(b)
          if (b.n > 0 && now - g.lastCalib > CALIB_INTERVAL_MS) {
            g.lastCalib = now
            calibrateInstances({ n: calibBudget() })
          }
        } else if (now - g.lastCalib > CALIB_INTERVAL_MS) {
          g.lastCalib = now
          calibrateInstances({ n: calibBudget() })
        }
      }
    } else if (satSetActive.value && !g.userInteracting) {
      // NORAD 集合叠加层：热力 / 过境模式本来是静止的（只显示事件标记），但集合展示态下
      // 卫星云与过滤轨道线仍要显示并随时间推进 —— 否则地球自转而卫星/轨道线不动，画面明显错位。
      if (simStepSec > 0) {
        if (decayPositionOffsets(dt)) matrixDrift = MATRIX_SKIP_SCENE
        updateExtrapolate(simStepSec)
      }
      if (g.filterOrbitQueue.length) {
        stepFilterOrbits({ n: propBudget })
      } else if (g.filterOrbitItems.length) {
        updateFilterOrbitsLive({ n: Math.floor(propBudget * 0.7) })
      }
    }

    if (g.satrec && g.selAnchor) {
      const pv = propagate(g.satrec, new Date(g.simTimeMs))
      if (pv?.position) {
        _selNext.copy(eciToScene(pv.position.x, pv.position.y, pv.position.z))
        // 双击跟踪：镜头与环绕焦点逐帧随目标平移同一位移（保持落位时的相对机位），目标恒居中；
        // 用户仍可拖动旋转 / 滚轮缩放（围绕跟踪目标），单击画布任意位置解除跟踪
        if (trackGi != null) {
          const cam = g.camera, controls = g.controls
          if (cam && controls) {
            _trackDelta.subVectors(_selNext, _trackPrev)
            cam.position.add(_trackDelta)
            controls.target.add(_trackDelta)
          }
          _trackPrev.copy(_selNext)
        }
        // 观赏视角只在点击当次生效一次（落位机位动画由 flyToSat/updateCameraFly 完成），此后相机与环绕焦点
        // 保持在落位时刻不动，不再逐帧跟随卫星：否则虚拟时间推进时相机被卫星拖着跑，画面持续狂摆。
        // 这里只同步锚点坐标，屏幕准星（updateReticle 按 anchor.position 投影）随之移动。
        g.selAnchor.position.copy(_selNext)
      }
      if (now - g.lastLive > 250) { g.lastLive = now; updateLiveData() }
    }
    updateReticle()

    // 先粗后精：按当前渲染情况（可见卫星数 / 相机距地高度 / 画质档位）评估是否换模型档位
    maybeSwitchModelLod(now)

    // 运行时帧率自适应（只降不升）：跳过预热期、交互期与热力模式，
    // 非交互下连续两个窗口平均帧耗时超标才降一档，避免偶发抖动误判。
    if (
      qualityTier !== 'low' && !interacting && !heatMode.value && !passMode.value &&
      !orbitBuilding.value && now > fpsWarmupUntil
    ) {
      fpsAccum += frameMs
      fpsSamples++
      if (fpsSamples >= FPS_WINDOW_FRAMES) {
        const avgMs = fpsAccum / fpsSamples
        fpsAccum = 0
        fpsSamples = 0
        if (avgMs > FPS_SLOW_MS) {
          fpsSlowWindows++
          if (fpsSlowWindows >= FPS_SLOW_WINDOWS) { fpsSlowWindows = 0; applyRuntimeQuality() }
        } else {
          fpsSlowWindows = 0
        }
      }
    }

    if (g.camera && g.controls && g.scene && g.renderer) {
      const flying = updateCameraFly(now)
      if (cesiumActive) {
        // Cesium 底座模式（每帧时序见 cesiumEarth.ts 头注释）：
        // 飞行期间把 updateCameraFly 的缓动结果（已写入 g.camera）转递给 Cesium 相机；
        // 非飞行期间 Cesium 的 ScreenSpaceCameraController 自主驱动相机（滚轮/拖拽/惯性）。
        if (flying || trackGi != null || trackEphem) {
          g.camera.getWorldDirection(_cesiumFlyDir)
          setCameraFromScene(g.camera.position, _cesiumFlyDir, g.camera.up, g.simTimeMs)
        }
        // 先渲 Cesium（内部先处理本帧输入再更新相机），再把最新 Cesium 相机被动同步到 g.camera：
        // Three 层所有卫星/标签/拾取继续用 g.camera，口径与原 OrbitControls 时代一致。
        // 双击跟踪 / 星历本星跟踪也要转递：上面的逐帧跟随只改了 g.camera，不推送会被本帧
        // syncCameraToThree 用「静止的 Cesium 相机」冲掉，表现为目标逐渐漂出画面中心（跟踪名存实亡）
        renderCesium(g.simTimeMs)
        if (!flying) syncCameraToThree(g.camera, g.simTimeMs)
      } else {
        // 降级模式（Cesium 初始化失败）：原 OrbitControls + 每帧地心外推兜底
        if (!flying) g.controls.update()
        clampCameraOutsideEarth()
      }
      g.renderer.render(g.scene, g.camera)
      // 过境视图：渲染之后再投影地表中文标签 —— 必须在 controls.update() 与 render() 之后，
      // 标签用的是本帧刚渲染的相机矩阵（camera.matrixWorldInverse 只在 render 里刷新）。
      // 放在渲染前会让标签落后一帧，拖动 / 缩放时表现为文字浮在地表上方抖动、不贴地。
      if (passMode.value) updatePassLabels()
      // 二十八宿宿名：与地表标签同口径，渲染后投影（用本帧相机矩阵），挂场景根不受地球自转影响
      if (skyLayers.mansion) updateMansionLabels()
      // 西方 88 星座名：同口径
      if (skyLayers.constellation) updateConstellationLabels()
    }
  }
  g.rafId = requestAnimationFrame(loop)
}

/* ============================================================
 * watch：图例勾选联动、卫星列表过滤索引、检索/星座/高度过滤
 * ============================================================ */
/** 图例「轨道线」总开关：把当前存在的三类轨道线按开关一次性显隐
 *  - 批量过滤轨道线（g.filterOrbitGroup）：子线 = 类型勾选 visible + 总开关
 *  - 选中单星轨道线（g.orbitLine）：类型勾选 visible + 总开关
 *  - hover 预览轨道线（g.previewOrbitLine）：只受总开关控制
 *  热力 / 过境视图有各自的轨道显隐口径（applyHeatMode / applyPassMode，其中已叠加本开关），此处不介入。 */
function applyOrbitToggle() {
  // 例外 = NORAD 集合展示态（satSetActive）：叠加层下轨道线在热力 / 过境视图也应受图例开关控制
  if ((heatMode.value || passMode.value) && !satSetActive.value) return
  const on = orbitVisible.value
  // 星座展示态：轨道线显隐由「轨道展示」开关单独把口（点亮即显示，不叠加类型勾选）
  const orbOk = filterConst.value ? consOrbitOn.value : true
  const grp = g.filterOrbitGroup
  if (grp) {
    for (const child of grp.children) {
      const line = child as THREE.LineSegments
      const t = line.userData?.type as string | undefined
      line.visible = on && orbOk && (!t || !TYPE_KEYS.includes(t) ? true : (!!filterConst.value || !!visible[t]))
    }
  }
  if (g.orbitLine) {
    g.orbitLine.visible = on && (!sel.type || !TYPE_KEYS.includes(sel.type) ? true : (!!filterConst.value || !!visible[sel.type]))
  }
  if (g.previewOrbitLine) g.previewOrbitLine.visible = on
}
// 图例勾选：过滤 / 预览 / 选中 三类轨道线的显示隐藏
watch(orbitVisible, () => applyOrbitToggle())
// 切换着色维度（图例顶部按钮）：只重涂 instanceColor + 刷新图例，几何 / 矩阵 / 实例分组都不重建
// （点云尚未加载时也照样刷新，图例先把各分档列出来、计数为 0，避免切换后图例空白）
watch(colorMode, () => applyPointColors())
// 首页「无目标」门控：揭示由用户主动入口触发（index.vue 的 openSatPanel / chooseSatView / toggleSatDock
// 与 URL 深链预置选中），不能 watch dockMode —— restoreDock 静默恢复也会把 dockMode 置 'sat'
watch(cloudRevealed, () => applyCloudGateVisible())
// 拾取状态依赖「选中目标所属类型」的图例可见性：隐藏该类型（含「全部物体」总开关一次性关掉 4 类）即取消选中，
// 与「环境图层隐藏也取消选中」同一口径（见下方 skyLayers.groundTrack 的 watch）。
watch(hasSel, () => applyOrbitPolarLimits())
watch(
  () => ({ ...visible }),
  () => {
    // 点云按「型号」分 Mesh，图例按「粗类型」勾选 → 用 modelVisible 换算（型号 -> 粗类型见 MODEL_COARSE）
    for (const model of modelKeys()) {
      const im = g.modelMeshes[model]
      // 与 buildModelInstances 同口径：热力 / 过境视图整片隐藏卫星云，但集合叠加层（satSetActive）
      // 与星座卡片载荷通道（consMeshBypass，仅载荷）例外；叠加首页「无目标」门控（cloudGate）
      if (im) im.visible = cloudGate() && (satSetActive.value || !!filterConst.value || (!heatMode.value && !passMode.value)) && (satSetActive.value || consMeshBypass(model) || modelVisible(model))
    }
    const grp = g.filterOrbitGroup
    if (grp) {
      for (const child of grp.children) {
        const line = child as THREE.LineSegments
        const t = line.userData?.type as string | undefined
        // 星座展示态：轨道线显隐由「轨道展示」开关单独把口（点亮即显示，不再叠加类型勾选）
        const orbOk = filterConst.value ? consOrbitOn.value : true
        if (t && TYPE_KEYS.includes(t)) line.visible = orbOk && (!!filterConst.value || !!visible[t])
      }
    }
    if (g.orbitLine && sel.type && TYPE_KEYS.includes(sel.type)) {
      g.orbitLine.visible = filterConst.value ? true : !!visible[sel.type]
    }
    // 选中目标所属类型被隐藏 → 拾取状态一并消失（resetCam=false：保留当前机位，不硬跳）
    if (hasSel.value && sel.type && TYPE_KEYS.includes(sel.type) && visible[sel.type] === false) {
      resetSelected(false)
    }
  },
  { deep: true }
)
// 星下点轨迹是唯一与「卫星拾取」强绑定的环境图层：它被隐藏 → 拾取状态一并消失
watch(
  () => skyLayers.groundTrack,
  (on) => { if (!on && hasSel.value) resetSelected(false) }
)
watch(
  () => satPanel.q,
  () => { if (g.cloudList.length) rebuildSatIndex() }
)
watch(
  () => ({ ...satPanel.typeF }),
  () => { if (g.cloudList.length) rebuildSatIndex() },
  { deep: true }
)
watch(
  () => ({ ...satPanel.regimeF }),
  () => { if (g.cloudList.length) rebuildSatIndex() },
  { deep: true }
)
// 切换星座（含从星座切回「全部」）：原先拾取的卫星未必还在当前星座范围内，
// 需要清掉拾取态（准星 / 选中轨道环 / 星下点轨迹）与卫星详情，否则旧卫星和它的轨迹会留在场景里。
// 只清拾取、不复位镜头，保留用户当前的观察机位。
watch(filterConst, (v, old) => {
  if (v === old) return
  resetSelected(false)
  // 换了星座：旧成员的高亮轨道线不再属于当前星座，一并清掉
  clearConstHighlight()
  // 星座展示对象变化（含清空 / 换星座）：「轨道展示」随星座复位（用户需重新点亮）
  consOrbitOn.value = false
  // 星座展示通道接入/退出会改变 mesh 显隐口径（不依赖类型勾选），此处统一重算
  //（watch(visible) 与 cloudRevealed watch 都不会因 filterConst 变化而触发）
  applyCloudGateVisible()
})
// 「轨道展示」点亮：星座轨道线此前因点暗未构建，重新走一遍过滤刷新出线；
// 点暗：refreshFilter 内的跳过分支会清掉现有轨道线
watch(consOrbitOn, (v) => {
  if (!filterConst.value || !g.cloudList.length) return
  refreshFilter()
  if (v) applyOrbitToggle()
})
watch([filterKw, filterConst, altMin, altMax, filterNorads, compareConsts], () => {
  // 过境轨道环的可见集合跟随 filterNorads（回答列出的 NORAD 集合）变化
  syncPassCityOrbitVisibility()
  if (!g.cloudList.length) return
  refreshFilter()
})
// 星座卡片「星座展示」逐星库开关 / 主开关（卫星）切换：掩码口径变化 → 重建过滤与实例矩阵。
// 主开关切换时 scene.ts 会清空 consShowMap，两个源都会触发；refreshFilter 幂等，重复执行无害。
watch([consShowMap, () => satPanel.typeF.PAYLOAD], () => {
  if (g.cloudList.length) refreshFilter()
}, { deep: true })
watch(heatMode, () => applyHeatMode())
// 过境视图：进入拉取地理底图并显示地表叠加图层，退出恢复卫星云
watch(passMode, () => applyPassMode())
// NORAD 集合展示态变化：热力 / 过境视图的「整片隐藏卫星云」门控需要重算
// （集合开启时要在这些视图下也显示卫星云与过滤轨道线，清空时恢复隐藏）
watch(satSetActive, () => {
  if (heatMode.value) applyHeatMode()
  if (passMode.value) applyPassMode()
})
// 图例开关：行政区域（中国行政区划面）/ 国界 / 城市标注 图层显隐（纯前端，不重复请求）
watch(passDistrictVisible, (v) => { if (g.passDistrictGroup) g.passDistrictGroup.visible = v })
watch(passBorderVisible, (v) => { if (g.passBorderGroup) g.passBorderGroup.visible = v })
// 发射站视图：进入图层时按经纬度打点，退出时隐藏标记并清掉选中高亮环
watch(siteMarkersVisible, (v) => {
  if (v) buildLaunchSiteMarkers()
  else { if (g.siteGroup) g.siteGroup.visible = false; clearSiteHighlight() }
})
// 发射站数据到达 / 刷新 → 若图层正显示则重建标记（重建后自动补摆选中高亮环）；
// 同时重放一次 URL 预置：/situation/site?site=<id> 在站点列表尚未到达时被挂起，靠这里补拾取
watch(launchSites, () => {
  if (siteMarkersVisible.value) buildLaunchSiteMarkers()
  void applyRoutePreset()
})
// 地址栏变化（同一页面内被外部带参跳转、前进/后退）：预置签名变化即重放对应拾取
watch(() => route.fullPath, () => { if (routePresetActive) void applyRoutePreset() })
// 热力事件到达 / 重建 → 重放一次 URL 预置：/situation/heat?source=&a=&b=&tca= 在热力数据尚未加载时被挂起，
// 靠这里补拾取（heatList 整体替换，引用变化即触发）
watch(heatList, () => { if (routePresetActive) void applyRoutePreset() })
// 城市中文标注的显隐由 updatePassLabels 每帧按 passCityVisible 判定，无三维图层需要联动
// 切换「数据批次」（过境面板下拉回看历史批次）→ 重拉本批次目标 id 集合并重建地表图层（目标面着色随批次变化）；
// 忽略 loadPassCityIds 回填批次 id 造成的变更（loadedPassBatchId 已同步，非用户切换）
watch(passBatchRunId, async (v) => {
  if ((v ?? null) === loadedPassBatchId) return
  // 切换批次后原选中目标可能在新批次无数据：清掉选中与高亮面 / 过境标记，重建后由用户重新点选
  passSelTarget.value = null
  passDetail.value = null
  passError.value = ''
  passDetailOpen.value = true
  clearPassHighlight()
  // 城市全部卫星轨道线 / 单次过境卫星模型与轨道线一并清除
  clearPassCityOrbits()
  clearPassSatOrbit()
  await loadPassCityIds()
  if (g.passGroup || passMode.value) buildPassLayers()
})
watch(heatDay, () => { if (g.heatGroup || heatMode.value) buildHeatMarkers() })
// 图例勾选显隐：档位增删后 heatFiltered 变化，需重建热力标记（隐藏的档位不再参与渲染、也不可拾取）
watch(() => heatHiddenColors.size, () => { if (g.heatGroup || heatMode.value) buildHeatMarkers() })
// P3 高度层 / 指标阈值：同样只影响 heatFiltered，实时重建热力标记
watch([heatAltBand, heatMetric, heatRiskFloor, heatPcFloor, heatMissCeil], () => {
  if (g.heatGroup || heatMode.value) buildHeatMarkers()
})
// P3 聚合格边：格边只影响聚合/抽稀粒度，无需重新请求后端，直接重建热力标记
watch(heatCell, () => { if (g.heatGroup || heatMode.value) buildHeatMarkers() })
watch(heatDays, () => { if (heatMode.value || heatList.value.length) loadHeat() })
// 切换热力来源（dock 弹出的来源菜单）：清掉当前选中事件，按新来源重载列表并重绘热力云；
// 若当前正有选中的卫星（右侧碰撞列表），一并按新来源重载，避免两个口径混在同一屏
watch(heatSource, () => {
  heatSel.value = null
  heatSelList.value = []
  // 批次 id / 列表按来源隔离：三个来源的 run_id 分属不同表（sat_conj_run / sat_cri_run），互不通用，
  // 切换来源时必须先清空，否则会把上一来源的批次 id 当作本来源的「回看批次」请求出去。
  loadedHeatBatchId = null
  heatBatchRunId.value = null
  heatBatches.value = []
  // heatList 此刻仍是上一来源的旧数据（loadHeat 异步替换）：先把来源标记清空，
  // 使 URL 预置的「事件拾取」不会误把旧来源事件当成本来源的（见 heatDataReady）
  heatLoadedSrc = ''
  if (heatSource.value !== 'spacetrack') loadHeatBatches()
  if (heatMode.value || heatList.value.length) loadHeat()
})
// 切换「数据批次」（交会热力面板下拉回看历史全量批次）→ 重载热力云
// 忽略 loadHeat 回填批次 id 造成的变更（loadedHeatBatchId 已同步，非用户切换）
watch(heatBatchRunId, (v) => {
  if ((v ?? null) === loadedHeatBatchId) return
  heatSel.value = null
  heatSelList.value = []
  if (heatMode.value || heatList.value.length) loadHeat()
})
// 选中事件变化 → 构建/清除其 A/B 两星轨道线与 TCA 时刻的两颗目标模型（均由 buildHeatSelOrbits 一并处理）
watch(heatSel, (v) => {
  if (v) {
    buildHeatSelOrbits(v)
  } else {
    clearHeatSelOrbits()
    heatSelList.value = []
  }
})
// 同簇列表变化（点选事件 / 取消高亮）→ 仅调整热力标记不透明度，不重建几何
watch(heatSelList, () => applyHeatDim())

/* ============================================================
 * 生命周期
 * ============================================================ */
/** 首屏之后的后台预热：把「用户接下来大概率会点」的数据提前静默拉好，
 *  使卫星列表、画轨道线、星座下拉、热力三个来源、过境底图都是「点了就有」。
 *  全部不写任何 loading 状态、失败不提示；排在首帧渲染之后，避免与首屏抢主线程 / 带宽。 */
function scheduleIdleWarmup() {
  /** 延后 delay 毫秒，并在浏览器空闲时执行（无 requestIdleCallback 的老 WebView 直接执行） */
  const idle = (cb: () => void, delay = 0) => {
    const run = () => { if (!disposed) cb() }
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    window.setTimeout(() => {
      if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 3000 })
      else run()
    }, delay)
  }
  // 卫星列表索引（同步一次 ~3.5 万遍历，毫秒级且纯本地）、TLE（画轨道线 / 过境标记 / 逐帧校准用）、星座下拉：
  // 数据已在内存，直接建好，避免首个点击时现算或多等一次往返
  idle(() => { void ensurePersistent(); rebuildSatIndex(); void ensureSatrecs(); void loadFilterConstellations() })
  // 热力三来源与过境底图错峰发起，避免首屏刚结束就挤占带宽
  idle(() => void prefetchHeat('local'), 600)
  idle(() => void prefetchHeat('cri'), 1400)
  idle(() => void prefetchHeat('spacetrack'), 2200)
  idle(() => void prefetchPass(), 3000)
}

onMounted(async () => {
  try {
    initScene()
    // 骨架优先：地球 / 星空 / 光照一建好就立刻开始渲染，不再等点云与模型。
    // 这样首帧（可交互时间）只取决于本地场景构建（毫秒级），卫星云随后在后台补上：
    // 有本地缓存时几乎同时就位；首次冷启动无缓存时先看到地球，再由中央小提示兜底。
    // 首屏整屏遮罩（loading）不在这里撤：Cesium 底座异步就绪有间隙，提前撤会露出
    // 「黑屏 / 闪 Three 旧贴图地球」，改由 applyCesiumBase 在 Cesium 首帧渲染后撤除；
    // 下方 10s 兜底只防极端挂起（本地分包 + 影像层元数据正常毫秒~秒级）。
    startAnimation()
    if (g.renderer && g.scene && g.camera) g.renderer.render(g.scene, g.camera)
    const bootGuard = window.setTimeout(() => { loading.value = false }, 10000)
    void bootGuard
    // 交互事件紧跟骨架挂上：卫星云未就绪时也允许先转动地球观察。
    // 挂容器而非 Three canvas：Cesium 底座模式下 Three canvas 是 pointer-events:none 的叠加层，
    // 事件由下层 Cesium canvas 接收后冒泡到容器，两种模式同一套监听（见 applyCesiumBase）
    const eventEl: HTMLElement = container.value ?? g.renderer!.domElement
    eventEl.addEventListener('pointerdown', onPointerDown)
    eventEl.addEventListener('pointerup', onPointerUp)
    eventEl.addEventListener('pointermove', onPointerMove)
    eventEl.addEventListener('contextmenu', onContextMenu)
    // 点云后台装载（缓存命中即毫秒级；无缓存走网络，全程不阻塞地球渲染）
    cloudLoading.value = true
    try {
      await loadConstellation()
    } finally {
      cloudLoading.value = false
    }
    if (disposed) return
    // 空间环境（极光椭圆环 / 太阳风）：异步拉取，不阻塞首屏
    void loadSpaceWeather()
    startSpaceWeatherTimer()
    // URL 预置（选中某颗卫星 / 按星座过滤）：点云已就绪，可还原
    void applyRoutePreset()
    // 首帧已画出来，再排队预热后续数据
    requestAnimationFrame(() => { if (!disposed) scheduleIdleWarmup() })
  } catch (e: unknown) {
    stopFakeProgress()
    if (disposed) return
    error.value = e instanceof Error ? e.message : '星座加载失败'
    loading.value = false
    cloudLoading.value = false
  }
})

// keep-alive 路由缓存：切走（deactivate）暂停动画循环，切回（activate）无缝恢复
onDeactivated(() => {
  cancelAnimationFrame(g.rafId)
  stopSpaceWeatherTimer()
  // 切走后不再消费地址栏预置（切回由 onActivated 统一重放），避免在隐藏页里做无谓的拾取与镜头飞行
  routePresetActive = false
})
onActivated(() => {
  routePresetActive = true
  if (!g.renderer) return
  // 缓存期间画布可能被 resize 事件改坏尺寸（见 canMeasure），切回时先按当前容器重算尺寸，
  // 再立即强制渲染一帧，最后恢复动画循环；否则安卓 WebView 回到本页会白屏
  onResize()
  if (g.scene && g.camera) g.renderer.render(g.scene, g.camera)
  // Cesium 底座切回：画布尺寸已由 onResize→resizeCesium 同步，这里补渲一帧避免地球短暂空白
  if (cesiumActive) {
    renderCesium(g.simTimeMs)
    if (g.camera) syncCameraToThree(g.camera, g.simTimeMs)
  }
  startAnimation()
  // 缓存期间空间环境可能已更新：切回立即刷一次并恢复定时
  void loadSpaceWeather()
  startSpaceWeatherTimer()
  // 按地址栏预置拾取（父组件 onActivated 已先执行 clearScene + applyDock，此处拾取结果不会被清掉）
  void applyRoutePreset()
})

onBeforeUnmount(() => {
  disposed = true
  // Cesium 底座先于 Three 资源回收（其 canvas 挂在容器里，destroy 时移除）
  cesiumActive = false
  destroyCesium()
  stopFakeProgress()
  stopSpaceWeatherTimer()
  cancelAnimationFrame(g.rafId)
  window.removeEventListener('resize', onResize)
  ro?.disconnect()
  ro = null
  const eventEl: HTMLElement | undefined = container.value ?? g.renderer?.domElement
  eventEl?.removeEventListener('pointerdown', onPointerDown)
  eventEl?.removeEventListener('pointerup', onPointerUp)
  eventEl?.removeEventListener('pointermove', onPointerMove)
  eventEl?.removeEventListener('contextmenu', onContextMenu)
  g.controls?.dispose()
  clearSelected()
  clearHeatMarkers()
  clearUserEphem()
  clearRegionPass()
  clearMultiRegionPass()
  disposeGeomCache()
  clearPassLayers()
  hoverGi = null
  clearPreviewOrbit()
  clearConstHighlight()
  if (g.scene) disposeScene(g.scene)
  // 二十八宿四象连线材质随场景一并释放（disposeScene 遍历 scene），这里清掉模块级引用
  mansionLineMat = null
  // 西方 88 星座连线材质同理
  constellationLineMat = null
  if (g.filterOrbitGroup) g.scene?.remove(g.filterOrbitGroup)
  if (g.filterOrbitPending) { g.scene?.remove(g.filterOrbitPending); disposeGroup(g.filterOrbitPending) }
  for (const mesh of g.meshes) { if (g.scene) g.scene.remove(mesh) }
  g.filterOrbitGroup = null
  g.filterOrbitPending = null
  g.filterOrbitItems = []
  g.meshes = []
  g.scene = null
  if (g.renderer) { g.renderer.dispose(); g.renderer.domElement.remove(); g.renderer = null }
})

/* ============================================================
 * 供父组件 index.vue 调用的方法（expose）
 * ============================================================ */
defineExpose({
  /** 由卫星列表面板点击触发：按全局索引拾取该卫星（准星 + 轨道线 + 详情 + 镜头飞向） */
  selectSatelliteByIndex,
  /** 由星座成员列表点击触发：与该星被双击一致（拉近并居中跟踪，右侧弹出详情） */
  trackSatelliteByIndex,
  /** 智能体动作：按 NORAD 编号定位并选中卫星（与列表点击同一链路） */
  selectByNorad,
  /** 星座视图右侧成员列表点击：高亮/取消高亮某颗卫星的轨道线（亮青色，不改变选中单星状态） */
  highlightConstSat,
  /** 智能体动作：以经纬度顶点直接绘制区域（写 regionDraft 自动重绘） */
  setRegionPolygon,
  /** 智能体动作：展示一批指定 NORAD 的卫星（只显示这批目标并画出全部轨道线；
   *  与热力 / 过境视图可叠加，见 satSetActive 叠加层） */
  showSatelliteSet,
  /** 清除过滤（关键词 / 星座 / 高度 / NORAD 集合）并重建轨道线 */
  resetFilter,
  /** 取消选中卫星并复位镜头 */
  resetSelected,
  /** 三维还原到初始状态（清过滤 + 取消选中 + 镜头复位） */
  resetToInitial,
  /** 仅复位镜头：回到初始机位（武汉 + 初始地球大小），不清选中与过滤 */
  resetCameraToHome,
  /** 重算卫星列表过滤索引（面板数据就绪后调用一次；搜索/类型变化由 watch 自动触发） */
  rebuildSatIndex,
  /** 切换卫星列表数据源（国际库 / AOE 库）：按新数据源重拉点云并重建实例，失败保留原画面 */
  switchDataSource,
  /** 由左侧热力列表面板（三个来源）点选某一对触发：选中该事件（两端误差椭球 + 两星轨道 + TCA 模型）、
   *  右侧展开事件详情与所属云团列表、镜头飞到交会位置 —— 与点击热力云团完全同一套效果。 */
  selectHeatPair,
  /** 清除当前绘制的交会目标（两星轨道线 + 目标模型） */
  clearHeatPair: clearHeatSelOrbits,
  /** 过境分析：拉取并构建地表叠加图层（行政区划面 + 国界 + 城市标注） */
  loadPassGeo,
  /** 过境分析：按目标 id 展示该目标过境（高亮行政区划面 + 镜头转到该目标 + 读取明细） */
  pickPassTargetById,
  /** 过境分析：选中/取消某次过境记录（复染该星空间轨道线 + 标出本次过境 + 卫星模型 + 镜头转过去；传 null 仅清除） */
  focusPassRecord,
  /** 过境分析：清空选中目标与明细、高亮面与过境标记 */
  resetPass,
  /** 区域过境：开启 / 关闭框选模式（开启后在地球上逐点单击选顶点；关闭保留已选顶点与描边） */
  setRegionDrawMode,
  /** 区域过境：撤销最后一个框选顶点 */
  removeLastRegionVertex,
  /** 区域过境：清空框选顶点与叠加层 */
  clearRegionDraft,
  /** 多区域过境：开启 / 关闭框选模式（与区域过境框选互斥；关闭时把当前草稿收进区域列表） */
  setMultiDrawMode,
  /** 多区域过境：完成当前区域（≥3 点收入列表，随后可继续框下一个） */
  finishMultiArea,
  /** 多区域过境：撤销当前区域最后一个顶点 */
  removeLastMultiVertex,
  /** 多区域过境：清空全部已框区域与当前草稿 */
  clearMultiAreas,
  /** 区域过境：点选/取消过境记录（绘制该次过境的卫星模型 + 轨道 + 扫描区域，并把虚拟时间对齐过境窗口；传 null 清除） */
  focusRegionPass,
  /** 区域过境：播放 / 暂停沿 AOS→LOS 的卫星飞行（已播到 LOS 时从头重播） */
  toggleRegionPassPlay,
  /** 区域过境：播放进度定位（ratio 0~1） */
  seekRegionPass,
  /** 区域过境：清除选中记录的绘制与播放状态 */
  clearRegionPass,
  /** 多区域过境：点选/取消明细记录（绘制该次过境的卫星模型 + 轨道 + 所属区域扫描条带；传 null 清除）
   *  areaPolygon 为结果里带回的该区域真实多边形，缺省时退回本地已框区域 */
  focusMultiRegionPass,
  /** 多区域过境：点选/取消「同时覆盖」组（真实多区域过境：同一颗星同一时段命中多个区域）。
   *  逐区域绘制该区域各自的扫描叠加，轨道与卫星模型只画一份；areaPolygons 为各区域真实多边形 */
  focusMultiRegionCoverage,
  /** 多区域过境：播放 / 暂停沿 AOS→LOS 的卫星飞行（已播到 LOS 时从头重播） */
  toggleMultiRegionPassPlay,
  /** 多区域过境：播放进度定位（ratio 0~1） */
  seekMultiRegionPass,
  /** 多区域过境：清除选中记录的绘制与播放状态 */
  clearMultiRegionPass,
  /** 发射站：按 launch_site.id 选中（左侧列表点击与点击地球标记同一路径：写选中态 + 高亮 + 镜头飞过去） */
  pickLaunchSiteById: selectLaunchSiteById,
  /** 星历分析：设置当前高精度星历（null = 清除图层） */
  setUserEphem,
  /** 星历分析：设置威胁事件标记（TCA 位置 3D 卫星模型 + 「目标ID · 时间」标签，空数组清除） */
  setUserEphemThreats,
  /** 星历分析：把 ECI 点投影到视口像素（事件详情卡跟随交会点定位；不可见时返回 null） */
  projectEciToViewport,
  /** 星历分析：定位到当前星历目标（时间对齐 + 镜头飞到当前位置） */
  focusUserEphem,
  /** 星历分析：拉近并逐帧跟踪星历本星（与双击卫星同一套机位 / 准星 / 跟随效果） */
  trackUserEphem,
  /** 星历分析：定位到某条威胁事件（null = 只清除事件图层） */
  focusUserEphemEvent,
  /** 星历分析：设置机动后的星历并绘制「原方案虚线 + 机动后实线」双轨迹（null = 清除） */
  setUserEphemManeuver
})

/* ---------- 拾取 / 投影 / 矩阵 复用对象 ---------- */
const _proj = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _ocS = new THREE.Vector3()
const _dirS = new THREE.Vector3()
const _off = new THREE.Vector3()
/** 目标面拾取（Raycaster）复用对象 */
const _raycaster = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
</script>

<template>
  <div class="constel-canvas" ref="container"></div>

  <!-- 选中卫星跟随准星（HTML div，CSS 像素恒定，平行于浏览器）：位置由动画循环逐帧直写 style，不走响应式 -->
  <div ref="reticleEl" class="sat-reticle" style="display: none">
    <span class="sat-reticle-ring"></span>
    <span ref="overlayName" class="sat-reticle-name">{{ sel.name }}</span>
  </div>

  <!-- 移动端环绕轮盘：桌面端右键拖动「绕选中目标环绕」在移动端没有右键，改为拾取后浮出的摇杆 -->
  <div
    v-show="isMobile && hasSel"
    class="orbit-wheel"
    :class="{ 'is-dragging': wheel.dragging }"
    @pointerdown="onWheelDown"
    @pointermove="onWheelMove"
    @pointerup="onWheelUp"
    @pointercancel="onWheelUp"
  >
    <span class="ow-knob" :style="{ transform: `translate(${wheel.kx}px, ${wheel.ky}px)` }"></span>
    <span class="ow-hint">环绕</span>
  </div>

  <!-- 过境视图地表中文标签层（国名 + 中国省级名 + 主要城市名）：落点由动画循环逐帧投影写 transform -->
  <div v-show="passMode" ref="passLabelLayer" class="pass-label-layer">
    <span
      v-for="(item, i) in passLabels"
      :key="item.key"
      :ref="(el) => setPassLabelNode(i, el)"
      class="pass-label"
      :class="`pass-label-${item.kind}`"
    >{{ item.text }}</span>
  </div>

  <!-- 星官名称标签层（三垣二十八宿）：落点由动画循环逐帧投影写 transform（挂场景根，固定不动） -->
  <div v-show="skyLayers.mansion" ref="mansionLabelLayer" class="mansion-label-layer">
    <span
      v-for="(item, i) in SKY_LABELS"
      :key="item.name"
      :ref="(el) => setMansionLabelNode(i, el)"
      class="mansion-label"
      :class="`mansion-label-${item.group}`"
    >{{ item.name }}</span>
  </div>

  <!-- 星座名称标签层（西方 88 星座）：同星官标签范式，落点由动画循环逐帧投影写 transform -->
  <div v-show="skyLayers.constellation" ref="constellationLabelLayer" class="constellation-label-layer">
    <span
      v-for="(item, i) in WESTERN_LABELS"
      :key="item.abbr"
      :ref="(el) => setConstellationLabelNode(i, el)"
      class="constellation-label"
    >{{ item.name }}</span>
  </div>

  <div v-if="loading" class="constel-mask">
    <div class="loading-box">
      <span class="loading-txt">{{ loadStage }} {{ loadProgress }}%</span>
      <div class="load-bar"><i :style="{ width: loadProgress + '%' }"></i></div>
    </div>
  </div>
  <div v-else-if="error" class="constel-mask">
    <p class="err">{{ error }}</p>
  </div>

  <!-- 操作类 loading（绘制轨道线 / 加载碰撞事件）：统一显示在地球正中央 -->
  <div v-if="centerLoading" class="constel-center">
    <div class="loading-box">
      <span class="spin"></span>
      <span class="loading-txt">{{ centerLoading.text }}</span>
      <div v-if="centerLoading.bar != null" class="load-bar"><i :style="{ width: centerLoading.bar + '%' }"></i></div>
    </div>
  </div>

  <!-- 顶部通知条（模型加载失败 / 卫星选中提示） -->
  <div v-if="modelNotice" class="constel-toast err">{{ modelNotice }}</div>
  <div v-else-if="notice" class="constel-toast">{{ notice }}</div>
</template>

<style scoped lang="scss">
@use './index.scss' as *;
</style>
