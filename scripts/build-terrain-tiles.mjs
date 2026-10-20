#!/usr/bin/env node
/* ============================================================
 * build-terrain-tiles.mjs —— DEM GeoTIFF → Cesium 离线 heightmap 地形包
 *
 * 用法（项目根目录执行，依赖 devDependency 的 geotiff.js，无需 GDAL）：
 *   node scripts/build-terrain-tiles.mjs --input <DEM.tif> [--out public/terrain]
 *        [--grid 129] [--max-level <n>]
 *
 * 输入：GeoTIFF 高程栅格（须带地理参考；全球 GMTED2020 30s / ETOPO 2022 60s，
 *       或任意区域的 DEM——覆盖范围外自动填 0 米海平面）。
 * 输出目录结构（cesiumEarth.ts 的 OfflineHeightmap 约定）：
 *   <out>/meta.json           { scheme, format, grid, maxLevel, ... }
 *   <out>/<level>/<x>/<y>.bin Int16 米值，行主序：北→南、西→东，grid×grid
 *
 * 瓦片方案与 Cesium 内建 GeographicTilingScheme（level0 = 2×1 根瓦片）对齐：
 *   level L：x 瓦片数 = 2^(L+1)，y 瓦片数 = 2^L；y=0 为最北行。
 *
 * 分辨率参考（grid=129 时，瓦片内采样间距 = 360/(128·2^(L+1))）：
 *   L5 ≈ 4.9km（全套 ~67MB）  L6 ≈ 2.4km（~540MB）  L7 ≈ 1.2km（~2.1GB）
 *   默认 max-level 按 DEM 源分辨率自动推导（不做过采样），可 --max-level 覆盖。
 * ============================================================ */
import { fromFile } from 'geotiff'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/* ---------------- CLI 参数 ---------------- */

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const input = args.input
if (!input) {
  console.error('用法：node scripts/build-terrain-tiles.mjs --input <DEM.tif> [--out public/terrain] [--grid 129] [--max-level n]')
  process.exit(1)
}
const outDir = args.out ?? 'public/terrain'
const grid = Number(args.grid ?? 129)
if (!Number.isInteger(grid) || grid < 33 || grid > 513 || ((grid - 1) & (grid - 2)) !== 0) {
  // 约定 2^n + 1（33/65/129/257…）：与 Cesium heightmap 顶点划分惯例一致
  console.error(`--grid 必须是 2^n+1 形式（33/65/129/257），收到：${args.grid}`)
  process.exit(1)
}

/* ---------------- 读取 DEM ---------------- */

console.log(`读取 DEM：${input}`)
const tiff = await fromFile(input)
const image = await tiff.getImage()
const W = image.getWidth()
const H = image.getHeight()
const origin = image.getOrigin() // 西北角像素的外边缘点：[minLon, maxLat]（geotiff.js 对北朝上图像的约定）
const res = image.getResolution() // [度/列, 度/行]；北朝上图像 res[1] 为负值（行向下 → 纬度递减）
if (!origin || !res || res[0] <= 0 || res[1] >= 0) {
  console.error('GeoTIFF 缺少地理参考或非北朝上布局（resolution[1] 应为负），请提供 GDAL 标准北朝上 DEM。')
  process.exit(1)
}
const resX = res[0]
const resY = -res[1] // 转为正值：度/行
const originLon = origin[0]
const originLat = origin[1] // maxLat
const demLon0 = originLon
const demLon1 = originLon + W * resX
const demLat1 = originLat
const demLat0 = originLat - H * resY

const bands = await image.readRasters({ samples: [0] })
const dem = bands[0]
const nodataRaw = image.getGDALNoData()
const nodata = nodataRaw == null ? NaN : Number(nodataRaw)

// NoData / NaN 归零（海平面），并统计高程范围
let minH = Infinity
let maxH = -Infinity
for (let i = 0; i < dem.length; i++) {
  let v = dem[i]
  if (!Number.isFinite(v) || v === nodata) v = 0
  dem[i] = v
  if (v < minH) minH = v
  if (v > maxH) maxH = v
}
console.log(
  `DEM ${W}×${H}，像素 ${resX.toPrecision(6)}°/列 × ${resY.toPrecision(6)}°/行，` +
  `覆盖经度 [${demLon0.toFixed(4)}, ${demLon1.toFixed(4)}] 纬度 [${demLat0.toFixed(4)}, ${demLat1.toFixed(4)}]，` +
  `高程 ${minH} ~ ${maxH} m`
)

/* ---------------- 采样（双线性，覆盖外填 0 海平面） ---------------- */

function sampleBilinear(lon, lat) {
  if (lon < demLon0 || lon > demLon1 || lat < demLat0 || lat > demLat1) return 0
  // 像素中心网格：col = (lon - originLon)/resX - 0.5，row = (maxLat - lat)/resY - 0.5
  const fx = (lon - originLon) / resX - 0.5
  const fy = (originLat - lat) / resY - 0.5
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)))
  const tx = Math.max(0, Math.min(1, fx - x0))
  const ty = Math.max(0, Math.min(1, fy - y0))
  const r0 = y0 * W
  const r1 = r0 + W
  return (
    (dem[r0 + x0] * (1 - tx) + dem[r0 + x0 + 1] * tx) * (1 - ty) +
    (dem[r1 + x0] * (1 - tx) + dem[r1 + x0 + 1] * tx) * ty
  )
}

/* ---------------- max-level 推导与体积预估 ---------------- */

const srcResDeg = Math.max(resX, resY)
// 不做过采样的最大层级：采样间距 360/((grid-1)·2^(L+1)) ≥ 源分辨率
const autoMaxLevel = Math.max(0, Math.floor(Math.log2(360 / ((grid - 1) * srcResDeg))) - 1)
const maxLevel = args['max-level'] != null ? Number(args['max-level']) : autoMaxLevel
if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > 12) {
  console.error(`--max-level 必须是 0~12 的整数，收到：${args['max-level']}`)
  process.exit(1)
}
const tileBytes = grid * grid * 2
let totalTiles = 0
for (let l = 0; l <= maxLevel; l++) totalTiles += (2 << l) * (1 << l)
const totalMB = ((totalTiles * tileBytes) / 1048576).toFixed(0)
console.log(`网格 ${grid}×${grid}，最大层级 ${maxLevel}${args['max-level'] == null ? '（按源分辨率自动推导）' : ''}，` +
  `共 ${totalTiles} 瓦片，预估体积 ~${totalMB} MB`)

/* ---------------- 逐级生成瓦片 ---------------- */

const int16 = new Int16Array(grid * grid)
const dirCache = new Set()
const t0 = Date.now()
let done = 0

for (let level = 0; level <= maxLevel; level++) {
  const xCount = 2 << level // 2^(level+1)
  const yCount = 1 << level // 2^level
  const tileW = 360 / xCount
  const tileH = 180 / yCount
  const dLon = tileW / (grid - 1)
  const dLat = tileH / (grid - 1)
  for (let ty = 0; ty < yCount; ty++) {
    const latTop = 90 - ty * tileH // Cesium 瓦片 y=0 为最北行；行序北→南与 heightmap 约定一致
    for (let tx = 0; tx < xCount; tx++) {
      const lon0 = -180 + tx * tileW
      let k = 0
      for (let iy = 0; iy < grid; iy++) {
        const lat = latTop - iy * dLat
        for (let ix = 0; ix < grid; ix++) {
          const h = sampleBilinear(lon0 + ix * dLon, lat)
          // Int16 钳制（地球极端高程 ±11km 均在范围内，这里防插值越界）
          int16[k++] = h > 32767 ? 32767 : h < -32768 ? -32768 : Math.round(h)
        }
      }
      const dir = path.join(outDir, String(level), String(tx))
      if (!dirCache.has(dir)) {
        await mkdir(dir, { recursive: true })
        dirCache.add(dir)
      }
      await writeFile(path.join(dir, `${ty}.bin`), Buffer.from(int16.buffer))
      done++
      if (done % 500 === 0) {
        console.log(`进度 ${done}/${totalTiles}（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
      }
    }
  }
  console.log(`层级 ${level} 完成（${xCount}×${yCount} 瓦片）`)
}

/* ---------------- meta.json ---------------- */

const meta = {
  scheme: 'geographic-2x1',
  format: 'int16-meters',
  grid,
  maxLevel,
  source: path.basename(input),
  demMinHeightM: minH,
  demMaxHeightM: maxH,
  generatedAt: new Date().toISOString()
}
await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))

console.log(`完成：${totalTiles} 瓦片 + meta.json，输出到 ${path.resolve(outDir)}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log('在应用中启用：BaseScene.vue 里 configureEarthBase({ terrainUrl: \'./terrain\' })')
