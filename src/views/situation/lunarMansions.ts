/**
 * 三垣二十八宿 —— 中国传统星空图层
 *
 * 取代原先「随机撒点」的星空背景（那层随机星点只是装饰，既无天文含义又干扰观察）。
 * 本层展示固定可辨的中国传统星官，两部分合并在同一图层（同一图例开关）里：
 *   · 二十八宿：每宿取一颗「距星」（该宿的标准定标星），按四象（东方青龙 / 北方玄武 /
 *     西方白虎 / 南方朱雀）分组，同象内相邻宿连成折线；
 *   · 三垣：紫微垣 / 太微垣 / 天市垣，各取垣墙星，按「一面垣墙一条折线」相连。
 * 二十八宿每宿、三垣每垣各带一个名称悬浮标签（仿过境中文标签的手动投影范式，
 * 见 BaseScene.updateMansionLabels）。
 *
 * ── 数据来源与口径 ──────────────────────────────────────────
 * 二十八宿距星赤经（RA）/ 赤纬（Dec）取自 StellaNavigator（アストロアーツ）二十八宿距星表
 *   yamauo1945.sakura.ne.jp/28shukujapan.html（2017-03-20 视位置），28 宿全表。
 * 两处按「现代标准距星」修正（源表口径与通行标准不同，此处以标准为准，注释标明）：
 *   · 奎宿距星 = ζ And（源表作 η And）：J2000 00h47m20.3s, +24°16′02″
 *   · 参宿距星 = ζ Ori（源表作 δ Ori）：J2000 05h40m45.5s, −01°56′34″
 * 其余 26 宿沿用源表 2017 视位置值。数据以「时/分/秒 + 度/分/秒」原样存储，
 * 在代码里换算，避免手工十进制化带来的舍入错误。
 * 三垣垣墙星共 47 颗（紫微垣 15 / 太微垣 10 / 天市垣 22），现代星名对照与 J2000 赤经赤纬
 * 取自 CDS Sesame 名称解析（cds.unistra.fr/cgi-bin/nph-sesame，SIMBAD 口径）；
 * 其中紫微右垣「上丞」= BK Cam（Sesame 解析为 HD 20336）。
 *
 * ── 坐标口径 ────────────────────────────────────────────────
 * 与项目 eciToScene 同源：赤道坐标 (x=cosδcosα, y=cosδsinα, z=sinδ) → scene = (x, z, −y)，
 * 即 scene +Y = 天球北极。本图层挂在场景根（惯性系，不随地球自转），星的位置在天空中固定不动。
 */
import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

/** 四象分组键 */
export type MansionGroupKey = 'dragon' | 'tortoise' | 'tiger' | 'bird'

/** 四象：名称 + 配色（青 / 黑(蓝) / 白 / 朱） */
export const MANSION_GROUPS: { key: MansionGroupKey; label: string; color: number }[] = [
  { key: 'dragon', label: '东方青龙', color: 0x35e0d0 },
  { key: 'tortoise', label: '北方玄武', color: 0x5a8cff },
  { key: 'tiger', label: '西方白虎', color: 0xeaf0ff },
  { key: 'bird', label: '南方朱雀', color: 0xff6a4d }
]

/** 单宿：宿名 + 所属四象 + 距星赤经(时/分/秒) + 赤纬(度/分/秒，首项带符号) + 距星(注释用星名) */
export interface MansionStar {
  name: string
  group: MansionGroupKey
  ra: [number, number, number]
  dec: [number, number, number]
  star: string
}

/** 二十八宿（按传统顺序：东方青龙 → 北方玄武 → 西方白虎 → 南方朱雀，每象 7 宿） */
export const LUNAR_MANSIONS: MansionStar[] = [
  // 东方青龙
  { name: '角', group: 'dragon', ra: [13, 26, 6.9], dec: [-11, 15, 3], star: 'α Vir' },
  { name: '亢', group: 'dragon', ra: [14, 13, 49.6], dec: [-10, 21, 13], star: 'κ Vir' },
  { name: '氐', group: 'dragon', ra: [14, 51, 50.5], dec: [-16, 6, 41], star: 'α Lib' },
  { name: '房', group: 'dragon', ra: [15, 59, 54.0], dec: [-26, 9, 36], star: 'π Sco' },
  { name: '心', group: 'dragon', ra: [16, 22, 14.3], dec: [-25, 37, 49], star: 'σ Sco' },
  { name: '尾', group: 'dragon', ra: [16, 53, 2.3], dec: [-38, 4, 18], star: 'μ Sco' },
  { name: '箕', group: 'dragon', ra: [18, 6, 54.1], dec: [-30, 25, 10], star: 'γ Sgr' },
  // 北方玄武
  { name: '斗', group: 'tortoise', ra: [18, 46, 42.9], dec: [-26, 58, 10], star: 'φ Sgr' },
  { name: '牛', group: 'tortoise', ra: [20, 21, 57.2], dec: [-14, 43, 33], star: 'β Cap' },
  { name: '女', group: 'tortoise', ra: [20, 48, 34.9], dec: [-9, 25, 57], star: 'ε Aqr' },
  { name: '虚', group: 'tortoise', ra: [21, 32, 26.3], dec: [-5, 29, 46], star: 'β Aqr' },
  { name: '危', group: 'tortoise', ra: [22, 6, 38.4], dec: [-0, 14, 16], star: 'α Aqr' },
  { name: '室', group: 'tortoise', ra: [23, 5, 35.6], dec: [15, 17, 43], star: 'α Peg' },
  { name: '壁', group: 'tortoise', ra: [0, 14, 5.8], dec: [15, 16, 34], star: 'γ Peg' },
  // 西方白虎
  { name: '奎', group: 'tiger', ra: [0, 47, 20.3], dec: [24, 16, 2], star: 'ζ And' },
  { name: '娄', group: 'tiger', ra: [1, 55, 34.1], dec: [20, 53, 19], star: 'β Ari' },
  { name: '胃', group: 'tiger', ra: [2, 44, 26.6], dec: [27, 46, 37], star: '35 Ari' },
  { name: '昴', group: 'tiger', ra: [3, 45, 52.9], dec: [24, 9, 49], star: '17 Tau' },
  { name: '毕', group: 'tiger', ra: [4, 29, 36.5], dec: [19, 12, 52], star: 'ε Tau' },
  { name: '觜', group: 'tiger', ra: [5, 36, 4.6], dec: [9, 56, 27], star: 'λ Ori' },
  { name: '参', group: 'tiger', ra: [5, 40, 45.5], dec: [-1, 56, 34], star: 'ζ Ori' },
  // 南方朱雀
  { name: '井', group: 'bird', ra: [6, 23, 59.7], dec: [22, 30, 4], star: 'μ Gem' },
  { name: '鬼', group: 'bird', ra: [8, 32, 34.8], dec: [18, 2, 0], star: 'θ Cnc' },
  { name: '柳', group: 'bird', ra: [8, 38, 34.3], dec: [5, 38, 23], star: 'δ Hya' },
  { name: '星', group: 'bird', ra: [9, 28, 26.6], dec: [-8, 44, 14], star: 'α Hya' },
  { name: '张', group: 'bird', ra: [9, 52, 19.2], dec: [-14, 55, 52], star: 'υ¹ Hya' },
  { name: '翼', group: 'bird', ra: [11, 0, 38.4], dec: [-18, 23, 37], star: 'α Crt' },
  { name: '轸', group: 'bird', ra: [12, 16, 42.6], dec: [-17, 38, 18], star: 'γ Crv' }
]

/** 三垣分组键 */
export type EnclosureKey = 'ziwei' | 'taiwei' | 'tianshi'

/** 垣墙星：传统星名 + 赤经(时/分/秒) + 赤纬(度/分/秒，首项带符号) + 现代星名(注释用) */
export interface EnclosureStar {
  name: string
  ra: [number, number, number]
  dec: [number, number, number]
  star: string
}

/** 一面垣墙：stars 按墙内相邻顺序排列（相邻两颗相连成一段，不闭合） */
export interface EnclosureWall {
  stars: EnclosureStar[]
}

/** 一垣：名称 + 配色 + 若干面垣墙（紫微 / 太微 / 天市各 2 面，即左垣 / 右垣） */
export interface Enclosure {
  key: EnclosureKey
  label: string
  color: number
  walls: EnclosureWall[]
}

/** 三垣垣墙星（共 47 颗：紫微垣 15 / 太微垣 10 / 天市垣 22），J2000，来源见文件头 */
export const ENCLOSURES: Enclosure[] = [
  {
    key: 'ziwei', label: '紫微垣', color: 0xc07bff,
    walls: [
      // 左垣（东藩）：左枢 → 少丞，绕天极的钩状弧（RA 递增，末尾越过 0h）
      {
        stars: [
          { name: '左枢', ra: [15, 24, 55.77], dec: [58, 57, 57.8], star: 'ι Dra' },
          { name: '上宰', ra: [16, 1, 53.40], dec: [58, 33, 54.4], star: 'θ Dra' },
          { name: '少宰', ra: [16, 23, 59.48], dec: [61, 30, 51.1], star: 'η Dra' },
          { name: '上弼', ra: [17, 8, 47.18], dec: [65, 42, 52.7], star: 'ζ Dra' },
          { name: '少弼', ra: [18, 54, 23.85], dec: [71, 17, 49.9], star: 'υ Dra' },
          { name: '上卫', ra: [20, 31, 30.40], dec: [74, 57, 16.6], star: '73 Dra' },
          { name: '少卫', ra: [23, 7, 53.85], dec: [75, 23, 14.9], star: 'π Cep' },
          { name: '少丞', ra: [0, 47, 46.05], dec: [74, 50, 51.2], star: '23 Cas' }
        ]
      },
      // 右垣（西藩）：右枢 → 上丞（RA 递减）
      {
        stars: [
          { name: '右枢', ra: [14, 4, 23.35], dec: [64, 22, 33.1], star: 'α Dra' },
          { name: '少尉', ra: [12, 33, 28.94], dec: [69, 47, 17.6], star: 'κ Dra' },
          { name: '上辅', ra: [11, 31, 24.22], dec: [69, 19, 51.8], star: 'λ Dra' },
          { name: '少辅', ra: [9, 34, 28.85], dec: [69, 49, 49.2], star: '24 UMa' },
          { name: '上卫', ra: [6, 53, 42.24], dec: [68, 53, 17.9], star: '43 Cam' },
          { name: '少卫', ra: [4, 54, 3.01], dec: [66, 20, 33.6], star: 'α Cam' },
          { name: '上丞', ra: [3, 19, 59.26], dec: [65, 39, 8.2], star: 'BK Cam' }
        ]
      }
    ]
  },
  {
    key: 'taiwei', label: '太微垣', color: 0xffb347,
    walls: [
      // 左垣（东藩）：左执法 → 东上将，自南向北
      {
        stars: [
          { name: '左执法', ra: [12, 19, 54.34], dec: [-0, 40, 0.4], star: 'η Vir' },
          { name: '东上相', ra: [12, 41, 39.62], dec: [-1, 26, 57.8], star: 'γ Vir' },
          { name: '东次相', ra: [12, 55, 36.20], dec: [3, 23, 50.8], star: 'δ Vir' },
          { name: '东次将', ra: [13, 2, 10.59], dec: [10, 57, 32.9], star: 'ε Vir' },
          { name: '东上将', ra: [13, 9, 59.28], dec: [17, 31, 46.0], star: '42 Com' }
        ]
      },
      // 右垣（西藩）：右执法 → 西上相，自南向北
      {
        stars: [
          { name: '右执法', ra: [11, 50, 41.71], dec: [1, 45, 53.0], star: 'β Vir' },
          { name: '西上将', ra: [11, 21, 8.19], dec: [6, 1, 45.5], star: 'σ Leo' },
          { name: '西次将', ra: [11, 23, 55.45], dec: [10, 31, 46.2], star: 'ι Leo' },
          { name: '西次相', ra: [11, 14, 14.38], dec: [15, 25, 45.7], star: 'θ Leo' },
          { name: '西上相', ra: [11, 14, 6.50], dec: [20, 31, 25.3], star: 'δ Leo' }
        ]
      }
    ]
  },
  {
    key: 'tianshi', label: '天市垣', color: 0x7fe8b8,
    walls: [
      // 右垣（西）：河中 → 韩，自北向南
      {
        stars: [
          { name: '河中', ra: [16, 30, 13.20], dec: [21, 29, 22.5], star: 'β Her' },
          { name: '河间', ra: [16, 21, 55.21], dec: [19, 9, 11.2], star: 'γ Her' },
          { name: '晋', ra: [16, 8, 4.69], dec: [17, 3, 2.0], star: 'κ Her' },
          { name: '郑', ra: [15, 56, 27.18], dec: [15, 39, 41.8], star: 'γ Ser' },
          { name: '周', ra: [15, 46, 11.25], dec: [15, 25, 18.5], star: 'β Ser' },
          { name: '秦', ra: [15, 34, 48.14], dec: [10, 32, 19.9], star: 'δ Ser' },
          { name: '蜀', ra: [15, 44, 16.07], dec: [6, 25, 32.2], star: 'α Ser' },
          { name: '巴', ra: [15, 50, 48.96], dec: [4, 28, 39.8], star: 'ε Ser' },
          { name: '梁', ra: [16, 14, 20.73], dec: [-3, 41, 39.5], star: 'δ Oph' },
          { name: '楚', ra: [16, 18, 19.29], dec: [-4, 41, 33.0], star: 'ε Oph' },
          { name: '韩', ra: [16, 37, 9.54], dec: [-10, 34, 1.5], star: 'ζ Oph' }
        ]
      },
      // 左垣（东）：魏 → 宋，自北向南
      {
        stars: [
          { name: '魏', ra: [17, 15, 1.91], dec: [24, 50, 21.1], star: 'δ Her' },
          { name: '赵', ra: [17, 30, 44.30], dec: [26, 6, 38.3], star: 'λ Her' },
          { name: '九河', ra: [17, 46, 27.54], dec: [27, 43, 14.5], star: 'μ Her' },
          { name: '中山', ra: [18, 7, 32.55], dec: [28, 45, 44.9], star: 'ο Her' },
          { name: '齐', ra: [18, 45, 39.72], dec: [20, 32, 46.7], star: '110 Her' },
          { name: '吴越', ra: [19, 5, 24.60], dec: [13, 51, 48.5], star: 'ζ Aql' },
          { name: '徐', ra: [18, 56, 13.18], dec: [4, 12, 12.9], star: 'θ¹ Ser' },
          { name: '东海', ra: [18, 21, 18.60], dec: [-2, 53, 55.7], star: 'η Ser' },
          { name: '南海', ra: [17, 59, 1.59], dec: [-9, 46, 25.0], star: 'ν Oph' },
          { name: '燕', ra: [17, 37, 35.19], dec: [-15, 23, 54.8], star: 'ξ Ser' },
          { name: '宋', ra: [17, 10, 22.68], dec: [-15, 43, 29.6], star: 'η Oph' }
        ]
      }
    ]
  }
]

/** 星空球半径（场景单位）：与旧随机星空同量级，远在地球与轨道之外、相机远平面之内 */
export const MANSION_RADIUS = 150
/** 距星点尺寸（sizeAttenuation）：该半径下约合屏幕 6px，清晰可辨又不喧宾夺主 */
const MANSION_STAR_SIZE = 2.6
/** 四象连线线宽（CSS 像素，LineMaterial 走像素口径） */
const MANSION_LINE_WIDTH = 1.4

/** 赤经/赤纬（时/分/秒，度/分/秒）→ 场景坐标（挂场景根，惯性系） */
function raDecToScene(ra: [number, number, number], dec: [number, number, number]): THREE.Vector3 {
  const raRad = (ra[0] + ra[1] / 60 + ra[2] / 3600) * (Math.PI / 12) // 1h = 15°
  // 注意负零：「−0°xx′yy″」（度数在 −1~0 之间，如危宿 dec:[-0,14,16]、太微左执法 [-0,40,0.4]）
  // 在 JS 里 -0 < 0 === false，必须用 Object.is 兜住，否则会误判成正赤纬
  const decSign = Object.is(dec[0], -0) || dec[0] < 0 ? -1 : 1
  const decRad = decSign * (Math.abs(dec[0]) + dec[1] / 60 + dec[2] / 3600) * (Math.PI / 180)
  // 赤道坐标 → 与 eciToScene 同口径：scene = (cosδcosα, sinδ, −cosδsinα)
  const x = Math.cos(decRad) * Math.cos(raRad)
  const y = Math.sin(decRad)
  const z = -Math.cos(decRad) * Math.sin(raRad)
  return new THREE.Vector3(x, y, z).multiplyScalar(MANSION_RADIUS)
}

const COLOR_OF: Record<string, number> = {}
for (const g of MANSION_GROUPS) COLOR_OF[g.key] = g.color
for (const e of ENCLOSURES) COLOR_OF[e.key] = e.color

/** 宿名标签数据（宿名 + 四象 + 场景坐标）：模板 v-for 与逐帧投影共用（模块级常量，位置固定不变） */
export const MANSION_LABELS: { name: string; group: MansionGroupKey; star: string; pos: THREE.Vector3 }[] =
  LUNAR_MANSIONS.map((m) => ({ name: m.name, group: m.group, star: m.star, pos: raDecToScene(m.ra, m.dec) }))

/** 垣墙星场景坐标（含所属垣 key）：构建星点与连线共用 */
const ENCLOSURE_STARS: { pos: THREE.Vector3; colorKey: EnclosureKey }[] = []
for (const e of ENCLOSURES) {
  for (const w of e.walls) {
    for (const s of w.stars) ENCLOSURE_STARS.push({ pos: raDecToScene(s.ra, s.dec), colorKey: e.key })
  }
}

/** 一垣中心方向：垣墙星位置的均值方向归一后投到星空球面（用于放垣名标签） */
function enclosureLabelPos(e: Enclosure): THREE.Vector3 {
  const v = new THREE.Vector3()
  for (const w of e.walls) for (const s of w.stars) v.add(raDecToScene(s.ra, s.dec))
  if (v.lengthSq() === 0) return new THREE.Vector3()
  return v.normalize().multiplyScalar(MANSION_RADIUS)
}

/** 星官标签分组键：四象（二十八宿）+ 三垣 */
export type SkyLabelGroupKey = MansionGroupKey | EnclosureKey

/** 星官标签总表（二十八宿宿名 + 三垣垣名）：模板 v-for 与逐帧投影共用（模块级常量，位置固定不变） */
export const SKY_LABELS: { name: string; group: SkyLabelGroupKey; pos: THREE.Vector3 }[] = [
  ...MANSION_LABELS.map((m) => ({ name: m.name, group: m.group as SkyLabelGroupKey, pos: m.pos })),
  ...ENCLOSURES.map((e) => ({ name: e.label, group: e.key as SkyLabelGroupKey, pos: enclosureLabelPos(e) }))
]

/** 距星柔光贴图（圆点渐变，一次性生成后复用） */
let _starTex: THREE.Texture | null = null
function mansionStarTexture(): THREE.Texture {
  if (_starTex) return _starTex
  const s = 64
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const ctx = cv.getContext('2d')!
  const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(cv)
  t.needsUpdate = true
  _starTex = t
  return t
}

export interface LunarMansionsBuilt {
  /** 整个图层组（挂场景根） */
  group: THREE.Group
  /** 星官连线的 Line2 材质：像素线宽依赖画布分辨率，resize 时须同步 resolution（见 BaseScene.onResize） */
  lineMaterial: LineMaterial
}

/**
 * 构建星官图层（三垣二十八宿）：距星 + 垣墙星（按所属星官着色）+ 四象相邻宿折线 + 每面垣墙折线
 * （顶点色，单几何单材质）。返回的 group 需由调用方加入场景根；lineMaterial 需在拿到画布尺寸后设置 resolution。
 */
export function buildLunarMansions(): LunarMansionsBuilt {
  const group = new THREE.Group()
  group.frustumCulled = false

  // ── ① 星点：二十八宿距星（按四象着色）+ 三垣垣墙星（按垣着色）──
  const starItems: { pos: THREE.Vector3; colorKey: string }[] = []
  for (const m of MANSION_LABELS) starItems.push({ pos: m.pos, colorKey: m.group })
  for (const s of ENCLOSURE_STARS) starItems.push({ pos: s.pos, colorKey: s.colorKey })

  const posArr = new Float32Array(starItems.length * 3)
  const colArr = new Float32Array(starItems.length * 3)
  const col = new THREE.Color()
  for (let i = 0; i < starItems.length; i++) {
    const p = starItems[i]
    posArr[i * 3] = p.pos.x
    posArr[i * 3 + 1] = p.pos.y
    posArr[i * 3 + 2] = p.pos.z
    col.setHex(COLOR_OF[p.colorKey])
    colArr[i * 3] = col.r
    colArr[i * 3 + 1] = col.g
    colArr[i * 3 + 2] = col.b
  }

  const pointGeo = new THREE.BufferGeometry()
  pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3))
  pointGeo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3))
  const stars = new THREE.Points(pointGeo, new THREE.PointsMaterial({
    map: mansionStarTexture(),
    size: MANSION_STAR_SIZE,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.95
  }))
  stars.frustumCulled = false
  group.add(stars)

  // ── ② 连线：同象内相邻宿折线 + 每面垣墙相邻星折线（不跨象、不跨墙、不闭合）──
  const segPos: number[] = []
  const segCol: number[] = []
  const lc = new THREE.Color()
  const pushSeg = (a: THREE.Vector3, b: THREE.Vector3, hex: number) => {
    lc.setHex(hex)
    segPos.push(a.x, a.y, a.z, b.x, b.y, b.z)
    // LineSegmentsGeometry.setColors 每个线段需给出两端颜色（与 setPositions 等长）
    segCol.push(lc.r, lc.g, lc.b, lc.r, lc.g, lc.b)
  }
  for (const grp of MANSION_GROUPS) {
    const members = MANSION_LABELS.filter((m) => m.group === grp.key)
    for (let i = 0; i < members.length - 1; i++) pushSeg(members[i].pos, members[i + 1].pos, grp.color)
  }
  for (const e of ENCLOSURES) {
    for (const w of e.walls) {
      for (let i = 0; i < w.stars.length - 1; i++) {
        pushSeg(
          raDecToScene(w.stars[i].ra, w.stars[i].dec),
          raDecToScene(w.stars[i + 1].ra, w.stars[i + 1].dec),
          e.color
        )
      }
    }
  }
  const lineGeo = new LineSegmentsGeometry()
  lineGeo.setPositions(segPos)
  lineGeo.setColors(segCol)
  const lineMaterial = new LineMaterial({
    linewidth: MANSION_LINE_WIDTH,
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  const lines = new LineSegments2(lineGeo, lineMaterial)
  lines.frustumCulled = false
  lines.renderOrder = 1
  group.add(lines)

  return { group, lineMaterial }
}
