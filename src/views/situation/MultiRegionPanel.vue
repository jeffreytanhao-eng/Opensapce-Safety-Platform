<script setup lang="ts">
/**
 * 多区域过境面板（左侧滑出，dock 入口 'multi'）
 *
 * 与「区域过境」面板（RegionSection）**互相独立**：状态、接口、批次与明细表全部分开，
 * 两个面板可以先后使用、互不覆盖结果；后端算法口径相同（同一份几何与判定实现），
 * 但多区域是「一次扫描覆盖多个区域」，并额外给出**同时覆盖分析**。
 *
 * ⚠ 两个面板必须共用同一套视觉与交互（用户要求「不能开发出两种风格」）：
 *   样式来自 ./region-shared.scss（rg- 类只有这一处来源），
 *   结构除「多区域列表」「区域库 / 已存组合选择」两块（多区域专有）外，与 RegionSection 对齐：
 *   框选工具条 → 兜底参数 → 预报窗口 → 提交 → 进度（可折叠 + 执行日志）→ 结果列表（可点击回显）→ 判定依据。
 *   历史上本面板另写过一套 mr-* 类与自成一体的进度块，是把两种风格写进同一个系统的根源。
 *
 * 交互：逐个区域框选 —— 开始框选 → 在地球上点选顶点（双击 / 点回起点 / 点「完成本区域」结束）
 *   → 该区域进入列表 → 继续框下一个；也可从「区域库」里挑已存区域直接加入。
 * 提交：点「计算」走后端 CPU 实算（提交 /cgi/pass/multi_region/scan，异步排队，前端轮询 /progress），
 *   结果落库按批次留档，可回看历史结果。
 *   · 不走大模型：过境是确定性 SGP4 外推，交给 CPU 算比大模型推算可靠。
 *   · 免登录：按 IP 限流（10 分钟内最多 2 次）+ 10 分钟结果缓存 —— 防无限次过境请求。
 *   · 并发：全局最多 2 个任务同时跑、总核预算 4（空闲首任务 4 核，有第 2 个任务时 2+2），多出来的排队。
 * 结果：点击明细卡片在三维地球上绘制该次过境的卫星模型 / 轨道 / **所属区域**的扫描条带，
 *   并出现播放条（播放 / 暂停 / 定位 / 取消选中）—— 与区域过境面板同一套。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  dockMode, drawerHeightVh, isDrawerDragging, useDrawerDrag,
  multiDrawMode, multiDraft, multiAreas, multiHint,
  multiPassSel, multiPassPlaying, multiPassProgress,
  TWILIGHT_LABEL, SHADOW_LABEL
} from './scene'
import {
  getMultiRegionStats, listRegionLib, listMultiRegionLib, saveMultiRegion,
  submitMultiRegionScan, getMultiRegionProgress, cancelMultiRegionScan, getMultiRegionResult, getMultiRegionCoverage,
  getMultiRegionLibDetail,
  type MultiRegionProgress, type MultiRegionResult, type CoverageAnalysis, type RegionLibItem,
  type MultiRegionLibItem, type MultiRegionAccessItem, type CoverageGroup
} from '@/api/pass_multi_region_public'
// 判定依据（卫星载荷参数）与「区域过境」共用同一份数据源与型号口径，不另建一套
import { getRegionSensors, type RegionSensorItem } from '@/api/pass_region_public'
import { cacheFirst } from '@/utils/persistCache'

const emit = defineEmits<{
  /** 框选动作：start（开始框选本区域）/ finish（完成本区域）/ stop（退出框选）/ undo（撤销顶点）/ clear（清空全部） */
  (e: 'action', a: 'start' | 'finish' | 'stop' | 'undo' | 'clear'): void
  /** 点选过境记录（null = 取消选中）：三维地球绘制该次过境的卫星模型 / 轨道 / 所属区域的扫描条带。
   *  areaPolygon 为该记录所属区域的真实多边形（多区域每区不同，不能像单区域那样用一份全局草稿） */
  (e: 'pick', rec: MultiRegionAccessItem | null, areaPolygon?: [number, number][] | null): void
  /** 点选「同时覆盖」卡片（null = 取消选中）：这是**真实的多区域过境** —— 同一颗卫星在重叠时间窗内
   *  同时命中多个区域，三维地球按组内每个区域分别绘制扫描条带（轨道与卫星模型只画一份）。
   *  areaPolygons 为各区域真实多边形（取自批次结果，用于把条带画在目标真正所在的一侧）。 */
  (e: 'pick-coverage', group: CoverageGroup | null, areaPolygons: { area_index: number; polygon: [number, number][] }[]): void
  /** 播放 / 暂停沿 AOS→LOS 的卫星飞行 */
  (e: 'play'): void
  /** 播放进度定位（ratio 0~1） */
  (e: 'seek', ratio: number): void
  (e: 'close'): void
}>()

const { onTouchStart: onDragStart, onTouchMove: onDragMove, onTouchEnd: onDragEnd } = useDrawerDrag(() => emit('close'))

/** 预报窗口可选档位（小时）：后端 normalizeRegionScanOpts 允许 1~72，面板给三档常用值（与区域过境一致） */
const WINDOW_OPTIONS = [24, 48, 72]

/* ---------------- 概览与库 ---------------- */
const stats = ref<Awaited<ReturnType<typeof getMultiRegionStats>> | null>(null)
const regionLib = ref<RegionLibItem[]>([])
const multiLib = ref<MultiRegionLibItem[]>([])
const pickRegionId = ref<number | null>(null)
const pickMultiId = ref<number | null>(null)
const comboName = ref('')

/** 最近批次的摘要（后端 lastScan 是宽松 Record，取需要的几个字段展示） */
const lastScan = computed(() => {
  const s = stats.value?.lastScan
  if (!s) return null
  return {
    id: Number(s.id || 0),
    areaCount: Number(s.area_count || 0),
    totalPasses: Number(s.total_passes || 0)
  }
})

async function loadLib() {
  // 先出本地持久缓存（区域库 / 组合库 / 概览打开面板即可用），随后静默拉最新替换
  await cacheFirst<[Awaited<ReturnType<typeof getMultiRegionStats>>, RegionLibItem[], MultiRegionLibItem[]]>(
    'situation:multiregion:lib:v1',
    async () => {
      const [s, r, m] = await Promise.all([getMultiRegionStats(), listRegionLib(), listMultiRegionLib()])
      return [s, r || [], m || []]
    },
    ([s, r, m]) => {
      stats.value = s
      regionLib.value = r
      multiLib.value = m
    },
    () => !!stats.value
  ).catch((e: any) => {
    ElMessage.error(e?.message || '多区域概览加载失败')
  })
}

/* ---------------- 已框选区域 ---------------- */
const areaCount = computed(() => multiAreas.value.length + (multiDraft.value.length ? 1 : 0))
const maxAreas = computed(() => Number(stats.value?.limits?.maxAreasPerScan || 24))

function renameArea(i: number, v: string) {
  const list = [...multiAreas.value]
  if (!list[i]) return
  list[i] = { ...list[i], name: v }
  multiAreas.value = list
}

function removeArea(i: number) {
  const list = [...multiAreas.value]
  list.splice(i, 1)
  multiAreas.value = list
}

/** 区域库的 polygon（JSON 列可能是字符串，也可能已被驱动解析成数组）→ 地球用的 { lon, lat } 顶点 */
function parseRegionPolygon(poly: unknown): { lon: number; lat: number }[] {
  let arr: unknown = poly
  if (typeof poly === 'string') {
    try { arr = JSON.parse(poly) } catch { arr = [] }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map((p) => (Array.isArray(p) ? { lon: Number(p[0]), lat: Number(p[1]) } : null))
    .filter((p): p is { lon: number; lat: number } => !!p && Number.isFinite(p.lon) && Number.isFinite(p.lat))
}

function addFromLib() {
  const id = Number(pickRegionId.value)
  if (!id) return
  const r = regionLib.value.find((x) => Number(x.id) === id)
  if (!r) return
  if (multiAreas.value.length >= maxAreas.value) {
    ElMessage.warning(`一次最多 ${maxAreas.value} 个区域`)
    return
  }
  // 带上区域库的顶点：这样「加入」后立即在地球上回显该区域轮廓（可继续框选下一个做对照）
  const points = parseRegionPolygon(r.polygon)
  multiAreas.value = [...multiAreas.value, { name: r.name, points, region_id: id }]
  pickRegionId.value = null
  if (!points.length) {
    ElMessage.warning(`已加入「${r.name}」，但该区域在库中没有可用顶点，无法在地球上回显`)
  } else {
    ElMessage.success(`已加入「${r.name}」并在地球上显示（${points.length} 个顶点）`)
  }
}

/** 载入已存组合：把组合内的区域（含快照顶点）填充到列表 → **立即在地球上回显**，并允许继续编辑 */
async function loadCombo() {
  const id = Number(pickMultiId.value)
  if (!id) return
  const item = multiLib.value.find((x) => Number(x.id) === id)
  if (!item) return
  await ElMessageBox.confirm(`载入组合「${item.name}」将替换当前已框选的 ${multiAreas.value.length} 个区域，继续？`, '提示', { type: 'warning' })
  try {
    const d = await getMultiRegionLibDetail(id)
    const list = (d.areas || [])
      .map((a, i) => ({
        name: a.name || `区域${i + 1}`,
        points: (a.polygon || []).map(([lon, lat]) => ({ lon: Number(lon), lat: Number(lat) })),
        region_id: Number(a.region_id) || undefined
      }))
      .filter((a) => a.points.length >= 3 || a.region_id)
    multiAreas.value = list
    multiDraft.value = []
    comboName.value = d.name || item.name
    multiHint.value = list.length
      ? `已载入组合「${comboName.value}」的 ${list.length} 个区域，已在地球上显示（可继续修改后再扫描）`
      : ''
    if (list.length) ElMessage.success(`已载入组合「${comboName.value}」（${list.length} 个区域），已在地球上回显`)
    else ElMessage.warning(`组合「${item.name}」内没有可用区域（顶点缺失）`)
  } catch (e: any) {
    ElMessage.error(e?.message || '载入组合失败')
  }
}

async function doSave() {
  const name = comboName.value.trim()
  if (!name) return ElMessage.warning('请填写多区域组合名称')
  const areas = buildAreasPayload()
  if (!areas.length) return ElMessage.warning('请先框选或加入至少一个区域')
  try {
    const r = await saveMultiRegion({ name, areas })
    ElMessage.success(`已保存组合「${name}」（${r.area_count} 个区域${r.region_saved ? `，新写入区域库 ${r.region_saved} 个` : ''}）`)
    await loadLib()
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败')
  }
}

/** 待提交的区域列表：已框选（顶点）优先；用区域库加入的走 region_id */
function buildAreasPayload() {
  const out: { name: string; polygon: [number, number][]; region_id?: number }[] = []
  for (const a of multiAreas.value as any[]) {
    const regionId = Number(a.region_id || 0)
    if (regionId > 0) {
      out.push({ name: a.name, polygon: [], region_id: regionId })
      continue
    }
    const pts = (a.points || []) as { lon: number; lat: number }[]
    if (pts.length < 3) continue
    out.push({ name: a.name, polygon: pts.map((p) => [p.lon, p.lat] as [number, number]) })
  }
  // 还把当前未「完成」的草稿算进去（≥3 点时），避免用户忘记点「完成本区域」而丢区域
  if (multiDraft.value.length >= 3) {
    out.push({
      name: `区域${out.length + 1}`,
      polygon: multiDraft.value.map((p) => [p.lon, p.lat] as [number, number])
    })
  }
  return out
}

/* ---------------- 参数（口径与区域过境一致） ---------------- */
/** 预报窗口（小时）：默认 24 */
const windowHours = ref(24)
/** 是否让未匹配到载荷参数的卫星按默认值参与 */
const useDefaultSensor = ref(true)
/** 默认成像幅宽（km）：初值取算法缺省 */
const defaultSwathKm = ref(100)
/** 默认最大侧摆（°）：0 = 按星下点正下方成像估算 */
const defaultRollDeg = ref(0)
/** 面板内提示（与区域过境同款轻量提示，不走 ElMessage） */
const tip = ref('')
/** 正在提交 */
const submitting = ref(false)

/* ---------------- 提交 / 进度 ---------------- */
const progress = ref<MultiRegionProgress | null>(null)
let timer: number | null = null

function startPoll() {
  if (timer !== null) return
  timer = window.setInterval(() => { void poll() }, 2000)
}
function stopPoll() {
  if (timer !== null) { window.clearInterval(timer); timer = null }
}

/** 是否展示进度块（有进度或本次提交后） */
const progressVisible = computed(() => {
  const p = progress.value
  if (!p) return false
  return p.stage !== 'idle'
    && (p.running || p.stage === 'queued' || p.stage === 'done' || p.stage === 'error' || p.stage === 'cancelled')
})
/** 本浏览器是否有任务在推进（运行中或排队中）：结果列表据此决定展不展示 */
const scanRunning = computed(() => {
  const p = progress.value
  if (!p) return false
  return p.running === true || (p.owned === true && p.stage === 'queued')
})
/** 进度块的展开态：默认折叠 —— 折叠时只留「阶段 + 百分比」一行摘要 */
const progressOpen = ref(false)
const logOpen = ref(false)

/**
 * 执行日志的展示过滤：子进程 / 任务块调度细节属于运维信息，对前台用户只是噪声。
 * 只滤 info 级噪声 —— warn / error 一律保留（隐藏的是噪声，不是问题线索）。
 */
const SCHEDULE_NOISE = [
  /^\[W\d+\/\d+\]/,
  /扫描子进程/,
  /^并行策略：/,
  /^任务块划分/,
  /^子进程退出 code=/
]
/** 面板实际展示的日志行 */
const progressLogs = computed(() =>
  (progress.value?.logs || []).filter((l) => {
    if (l.level === 'warn' || l.level === 'error') return true
    const t = String(l.text || '').trim()
    return !SCHEDULE_NOISE.some((re) => re.test(t))
  })
)

async function poll() {
  try {
    const p = await getMultiRegionProgress()
    progress.value = p
    // 扫描已结束（成功/失败/取消且无运行中任务）→ 停轮询并拉结果
    if (!p.running && (p.stage === 'done' || p.stage === 'error' || p.stage === 'cancelled')) {
      stopPoll()
      // 扫描已结束：清掉提交期的「已提交，正在计算…」提示，避免算完仍显示「正在计算」
      tip.value = ''
      if (p.stage === 'done') await loadResult(p.runId)
    } else if (p.stage === 'idle') {
      stopPoll()
    } else if (p.running || p.stage === 'queued') {
      // 有任务在跑或本浏览器在排队：清掉上一次的结果列表，面板只留进度
      clearPrevResult()
      startPoll()
    }
  } catch { /* 轮询失败下次再试 */ }
}

/**
 * 点「计算」：提交后端实时计算（/cgi/pass/multi_region/scan），异步排队后前端轮询进度。
 *  · 免登录：后端按 IP 限流（10 分钟内最多 2 次）+ 同批区域 10 分钟结果缓存；
 *  · 逐个区域提交框选顶点（每个区域 ≥ 3 点），或从区域库选中的带 region_id。
 */
async function doScan() {
  const areas = buildAreasPayload()
  if (!areas.length) {
    tip.value = '请先框选区域（每个区域至少 3 个顶点），或从区域库 / 已存组合里选择'
    return
  }
  if (submitting.value) return
  submitting.value = true
  tip.value = ''
  emit('action', 'stop')
  try {
    const r = await submitMultiRegionScan({
      areas,
      window_hours: windowHours.value,
      use_default_sensor: useDefaultSensor.value,
      default_swath_km: defaultSwathKm.value,
      default_roll_deg: defaultRollDeg.value
    })
    if (r.cached) {
      // 命中 10 分钟缓存：直接载入上次批次
      stopPoll()
      await loadResult(r.scan_id ?? undefined)
      tip.value = '这批区域在有效期内已计算过，直接载入上次结果'
      return
    }
    if (r.already) {
      tip.value = r.queued ? '本浏览器已有任务在排队，正在查看排队进度' : '本浏览器已有扫描正在运行，正在查看进度'
    } else if (r.queued) {
      tip.value = r.ahead ? `已进入队列（前面还有 ${r.ahead} 个任务），轮到时自动开跑` : '已进入队列，即将开始'
    } else {
      tip.value = '已提交，扫描进行中'
    }
    clearPrevResult()
    startPoll()
    await poll()
  } catch (e: unknown) {
    tip.value = (e as { message?: string })?.message || '提交失败'
  } finally {
    submitting.value = false
  }
}

async function doCancel() {
  try {
    const r = await cancelMultiRegionScan()
    if (r.cancelled) {
      ElMessage.success('已请求取消')
      await poll()
    } else {
      ElMessage.info('当前没有可取消的任务')
    }
  } catch (e: any) {
    ElMessage.error(e?.message || '取消失败')
  }
}

/* ---------------- 结果（服务端分页） ---------------- */
const result = ref<MultiRegionResult | null>(null)
const coverage = ref<CoverageAnalysis | null>(null)
/** 「同时覆盖分析」的最少同时覆盖区域数 */
const minAreas = ref(2)
/** 当前页码（从 1 开始） */
const page = ref(1)
/** 每页条数：与区域过境同一口径（服务端分页，前端只渲染当前页） */
const PAGE_SIZE = 20

/** 总页数（分页控件用；无结果时为 1，避免出现「1 / 0」） */
const totalPages = computed(() => Math.max(1, Math.ceil((result.value?.total || 0) / PAGE_SIZE)))
/** 当前页数据 */
const list = computed(() => result.value?.list || [])

/**
 * 拉取结果：scanId 显式指定批次（刚算完 / 命中缓存），缺省沿用当前进度或已展示批次的 id。
 * 有任务在跑、又没指定批次时不展示任何结果 —— 否则取到的是上一次的旧结果，正是要避免的新旧混淆。
 */
async function loadResult(scanId?: number | null) {
  if (scanId == null && scanRunning.value) {
    clearPrevResult()
    return
  }
  // 批次在取缓存之前先锁定：默认视图会先用缓存把 result 填上，
  // 若在 query 里才读 result.value?.scan?.id，就会把批次钉在缓存那一次、永远追不上最新批次
  const pinnedScanId = scanId ?? progress.value?.runId ?? result.value?.scan?.id ?? undefined
  const query = () => getMultiRegionResult({
    scan_id: pinnedScanId,
    page: page.value,
    pageSize: PAGE_SIZE,
    object_name: listKw.value.trim() || undefined
  })
  const applyResult = (r: MultiRegionResult) => {
    result.value = r
    void reloadCoverage()
  }
  // 默认视图（第 1 页、未指定批次且无名称检索）走本地持久缓存：
  // 打开面板即显示上次结果，随后静默拉最新替换；翻页 / 检索仍走原路径，避免串数据
  const isDefault = page.value === 1 && scanId == null && !listKw.value.trim()
  if (isDefault) {
    await cacheFirst('situation:multiregion:result:p1:v1', query, applyResult, () => !!result.value)
      .catch((e: any) => ElMessage.error(e?.message || '结果加载失败'))
    return
  }
  try {
    applyResult(await query())
  } catch (e: any) {
    ElMessage.error(e?.message || '结果加载失败')
  }
}

/** 翻页（服务端分页） */
async function gotoPage(p: number) {
  const target = Math.min(Math.max(1, p), totalPages.value)
  if (target === page.value) return
  page.value = target
  await loadResult()
}

/** 有新任务在跑时清掉上一次的结果展示（含页码与选中的过境记录），避免新旧结果混在一起 */
function clearPrevResult() {
  result.value = null
  coverage.value = null
  page.value = 1
  if (multiPassSel.value) emit('pick', null)
}

/* ---------------- 结果检索（按名称 / NORAD 号，服务端过滤） ---------------- */
const listKw = ref('')
let listKwTimer: number | null = null
/** 输入防抖 400ms 后回到第 1 页重取：明细动辄上万条，只过滤当前页会很误导（与区域过境同口径） */
function onListKwInput() {
  if (listKwTimer !== null) window.clearTimeout(listKwTimer)
  listKwTimer = window.setTimeout(() => {
    listKwTimer = null
    page.value = 1
    void loadResult()
  }, 400)
}

/* ---------------- 选中过境记录：三维绘制 + 播放条（与区域过境同一套） ---------------- */
/** 播放条显隐：直接跟随选中态（结果分页后选中的那条多半已不在当前页） */
const picked = computed(() => multiPassSel.value)

/** 列表项是否选中：按 norad + AOS 时刻 + 区域序号判等（同一颗星可能过多个区域，各算一条） */
function isPicked(it: MultiRegionAccessItem) {
  const s = multiPassSel.value
  return !!s && s.norad_id === it.norad_id && s.aos_ms === it.aos_ms && s.area_index === it.area_index
}

/** 点击明细卡片：交给父组件转发到 BaseScene，绘制该次过境的卫星模型 / 轨道 / 所属区域的扫描条带。
 *  区域多边形取自后端结果（多区域每区不同，单区域那套全局草稿在这里不适用）。 */
function selectItem(it: MultiRegionAccessItem) {
  const poly = result.value?.areas?.find((a) => a.area_index === it.area_index)?.polygon || null
  emit('pick', it, poly)
}

/** 取消选中：清除三维绘制并交回时间推进 */
function clearPick() {
  emit('pick', null)
}

/* ---------------- 同时覆盖「组」的选中：一次真实的多区域过境 ---------------- */
/** 卡片是否选中：组级标识 = norad + 组起始时刻（**不带 area_index**，与明细行选中互不干扰） */
function isCoveragePicked(g: CoverageGroup) {
  const s = multiPassSel.value
  return !!s && s.area_index === undefined && s.norad_id === g.norad_id && s.aos_ms === g.start_ms
}

/** 点击同时覆盖卡片：把组内各区域的多边形（取自批次结果）一并交给三维，逐区域绘制扫描条带 */
function selectCoverage(g: CoverageGroup) {
  const polys = (g.areas || []).map((a) => ({
    area_index: a.area_index,
    polygon: result.value?.areas?.find((x) => x.area_index === a.area_index)?.polygon || []
  }))
  emit('pick-coverage', g, polys)
}

/** 点击进度条定位播放进度 */
function onSeek(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  if (!r.width) return
  emit('seek', Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
}

/* ---------------- 判定依据：卫星载荷参数（与区域过境共用同一份数据源） ---------------- */
const sensors = ref<RegionSensorItem[]>([])
const sensorOpen = ref(false)
const sensorKw = ref('')
const sensorShown = computed(() => {
  const k = sensorKw.value.trim().toLowerCase()
  if (!k) return sensors.value
  return sensors.value.filter((s) => (s.name || '').toLowerCase().includes(k))
})
async function fetchSensors() {
  await cacheFirst<RegionSensorItem[]>('situation:region:sensors:v1', getRegionSensors, (v) => { sensors.value = v || [] })
    .catch(() => { /* 判定依据加载失败不影响扫描 */ })
}

async function reloadCoverage() {
  if (!result.value?.scan) return
  try {
    coverage.value = await getMultiRegionCoverage({ scan_id: result.value.scan.id, min_areas: minAreas.value })
  } catch (e: any) {
    ElMessage.error(e?.message || '同时覆盖分析失败')
  }
}

/* ---------------- 展示工具 ---------------- */
const p2 = (n: number) => String(n).padStart(2, '0')

/** 时间戳 → `MM-DD HH:mm:ss`（本地时区，与区域过境同一口径） */
function fmtTime(ms?: number | null) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—'
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return '—'
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
const fmtNum = (v: unknown, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d))
/** 持续秒 → `Xm Ys`（与区域过境同一写法） */
function fmtDur(sec: unknown) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return '—'
  const s = Math.max(0, Math.round(n))
  const m = Math.floor(s / 60)
  return m ? `${m}m${p2(s % 60)}s` : `${s}s`
}
/** 载荷类型中文名（与区域过境同一口径） */
const typeLabel: Record<string, string> = { optical: '光学', sar: 'SAR', other: '其他' }

/**
 * 清空：三维地球上的框选（全部区域 + 当前草稿）+ 下方「进度 / 结果 / 提示 / 选中的过境记录」回到初始状态。
 * 概览（区域库 / 组合数）不在此列 —— 那是库里的数据现状，不是本次操作的结果。
 * 若此时本浏览器的扫描仍在进行/排队：停掉轮询并给出提示，避免「看不见进度却以为没在跑」。
 */
function clearAll() {
  const wasRunning = scanRunning.value
  emit('action', 'clear')
  emit('pick', null)
  stopPoll()
  result.value = null
  coverage.value = null
  progress.value = null
  page.value = 1
  listKw.value = ''
  pickRegionId.value = null
  pickMultiId.value = null
  tip.value = wasRunning
    ? '面板已清空；本浏览器提交的扫描仍在进行/排队中，完成后重新进入本页签即可查看结果'
    : ''
}

onMounted(async () => {
  await Promise.all([loadLib(), fetchSensors()])
  await poll()
  // 页面打开时若本浏览器仍有任务在跑/排队，继续轮询，避免面板与真实进度脱节
  if (scanRunning.value) startPoll()
})

onBeforeUnmount(() => {
  stopPoll()
  if (listKwTimer !== null) { window.clearTimeout(listKwTimer); listKwTimer = null }
  // 离开多区域页签时退出框选模式（已框区域保留，回到页签可继续），
  // 避免「看不见面板却还在球面上画点」—— 与区域过境的 onBeforeUnmount 同一处理
  if (multiDrawMode.value) emit('action', 'stop')
})

// 面板收起时停轮询（下次展开会重新同步一次），避免后台空轮询
watch(dockMode, (m) => {
  if (m !== 'multi') stopPoll()
  else { void poll(); if (scanRunning.value) startPoll() }
})
</script>

<template>
  <transition name="panel">
    <aside v-if="dockMode === 'multi'" class="side-panel multi-panel"
      :class="{ 'is-dragging': isDrawerDragging }"
      :style="{ '--drawer-h': drawerHeightVh + 'vh' }">
      <div class="sp-head"
        @touchstart="onDragStart"
        @touchmove="onDragMove"
        @touchend="onDragEnd"
        @touchcancel="onDragEnd">
        <div class="sp-head-main">
          <b class="sp-title">多区域过境</b>
          <span class="sp-count">已选 {{ areaCount }} 个区域</span>
          <span class="sp-meta">连续框选多个区域 → 一次扫描全部区域</span>
        </div>
        <button class="sp-close" title="收起（点底部菜单可再次展开）" @click="emit('close')">»</button>
      </div>

      <div class="rg-wrap">
        <!-- 概览：区域库规模与最近批次（面板里入库数据的现状，不是本次操作的结果） -->
        <div class="rg-stats">
          <span>区域库 <b>{{ stats?.regionCount ?? 0 }}</b> 条</span>
          <span>多区域组合 <b>{{ stats?.multiRegionCount ?? 0 }}</b> 个</span>
          <span v-if="lastScan">
            最近批次 <b>#{{ lastScan.id }}</b> · {{ lastScan.areaCount }} 区域 / {{ lastScan.totalPasses }} 次过境
          </span>
        </div>

        <!-- 框选工具条（多区域的框选是「逐个区域」：完成本区域后继续框下一个） -->
        <div class="rg-tools">
          <button class="rg-btn primary" @click="emit('action', multiDrawMode ? 'finish' : 'start')">
            {{ multiDrawMode ? '完成本区域' : '开始框选区域' }}
          </button>
          <button class="rg-btn" :disabled="!multiDraft.length" @click="emit('action', 'undo')">撤销</button>
          <button class="rg-btn" :disabled="!areaCount && !result && !progressVisible"
            title="清空框选的全部区域与下方扫描结果，回到初始状态" @click="clearAll">清空</button>
          <span class="rg-count">{{ multiDraft.length }} 点</span>
        </div>
        <div class="rg-hint">{{ multiHint || '在地球上依次点击选点，至少 3 个；双击 / 点回起点 / 点「完成本区域」结束当前区域，然后接着框下一个' }}</div>

        <!-- 区域列表：多区域专有（单区域没有「多块区域」的概念） -->
        <div class="rg-box">
          <div class="rg-tools">
            <span class="rg-pick-label">区域列表（{{ multiAreas.length }} 个已完成{{ multiDraft.length ? ' + 1 个正在框选' : '' }}）</span>
            <span class="rg-count">上限 {{ maxAreas }} 个</span>
          </div>
          <div v-if="multiDraft.length" class="rg-area-row draft">
            <span class="rg-idx">草稿</span>
            <input class="rg-text" :value="`区域${multiAreas.length + 1}`" disabled>
            <span class="rg-sub">{{ multiDraft.length }} 点</span>
          </div>
          <div v-for="(a, i) in multiAreas" :key="i" class="rg-area-row">
            <span class="rg-idx">{{ i + 1 }}</span>
            <input class="rg-text" :value="a.name" @input="renameArea(i, ($event.target as HTMLInputElement).value)">
            <span class="rg-sub">{{ (a as any).region_id ? '区域库' : `${a.points?.length || 0} 点` }}</span>
            <button class="rg-x" title="移除" @click="removeArea(i)">×</button>
          </div>
          <div v-if="!multiAreas.length && !multiDraft.length" class="rg-detail dim">
            还没有区域：点上面的「开始框选区域」，或从下面的区域库 / 已存组合里选。
          </div>
        </div>

        <!-- 区域库 / 已存组合选择：多区域专有 -->
        <div class="rg-box">
          <div class="rg-pick">
            <span class="rg-pick-label">区域库</span>
            <select v-model="pickRegionId" class="rg-select">
              <option :value="null">选择要加入的区域…</option>
              <option v-for="r in regionLib" :key="r.id" :value="r.id">{{ r.name }} · {{ fmtNum(r.area_km2, 0) }} km²</option>
            </select>
            <button class="rg-btn" :disabled="!pickRegionId" @click="addFromLib">加入</button>
          </div>
          <div class="rg-pick">
            <span class="rg-pick-label">已存组合</span>
            <select v-model="pickMultiId" class="rg-select">
              <option :value="null">选择要载入的组合…</option>
              <option v-for="m in multiLib" :key="m.id" :value="m.id">{{ m.name }}（{{ m.area_count }} 区域）</option>
            </select>
            <button class="rg-btn" :disabled="!pickMultiId" @click="loadCombo">载入</button>
          </div>
          <div class="rg-pick">
            <span class="rg-pick-label">保存组合</span>
            <input v-model="comboName" class="rg-text" placeholder="多区域组合名称（保存到多区域库）">
            <button class="rg-btn" :disabled="!comboName.trim()" @click="doSave">保存</button>
          </div>
        </div>

        <!-- 缺参数卫星的兜底参数：库里多数载荷星没有公开的幅宽/侧摆，开启后按下面两个值参与判定 -->
        <div class="rg-fb">
          <label class="rg-fb-switch">
            <input type="checkbox" :checked="useDefaultSensor"
              @change="useDefaultSensor = ($event.target as HTMLInputElement).checked">
            <span>无参数卫星按默认值参与</span>
          </label>
          <label class="rg-fb-item">
            <span>幅宽</span>
            <input class="rg-num" type="number" min="0" max="10000" step="10" :disabled="!useDefaultSensor"
              :value="defaultSwathKm"
              @input="defaultSwathKm = Math.max(0, Number(($event.target as HTMLInputElement).value) || 0)">
            <i>km</i>
          </label>
          <label class="rg-fb-item">
            <span>侧摆</span>
            <input class="rg-num" type="number" min="0" max="90" step="1" :disabled="!useDefaultSensor"
              :value="defaultRollDeg"
              @input="defaultRollDeg = Math.max(0, Number(($event.target as HTMLInputElement).value) || 0)">
            <i>°</i>
          </label>
        </div>
        <div class="rg-hint dim">
          <template v-if="useDefaultSensor">
            未匹配到载荷参数的卫星将按 {{ defaultSwathKm }}km / {{ defaultRollDeg }}° 估算参与（结果标「参数缺失」）
          </template>
          <template v-else>
            未启用默认值：只统计已匹配到载荷参数的卫星，缺参数的整颗跳过（计入「无参数跳过」）
          </template>
          　·　判定半带宽 = 幅宽/2 + 侧摆可达地面偏移（随轨道高度急剧放大）
        </div>

        <!-- 预报窗口：三档时长，窗口越长过境越多、耗时越长 -->
        <div class="rg-win">
          <span class="rg-win-label">预报窗口</span>
          <button v-for="h in WINDOW_OPTIONS" :key="h" class="rg-win-btn" :class="{ active: windowHours === h }"
            @click="windowHours = h">{{ h }}h</button>
        </div>

        <button class="rg-submit" :disabled="submitting || scanRunning" @click="doScan">
          {{ submitting ? '提交中…' : scanRunning ? (progress?.stage === 'queued' ? '排队中…' : '扫描中…') : `计算未来 ${windowHours}h · ${areaCount} 个区域过境` }}
        </button>
        <div v-if="tip" class="rg-tip">{{ tip }}</div>
        <div class="rg-tools">
          <button class="rg-btn" :disabled="!scanRunning" @click="doCancel">
            {{ progress?.stage === 'queued' ? '取消排队' : '取消扫描' }}
          </button>
          <button class="rg-btn" @click="loadResult()">载入最近结果</button>
        </div>

        <!-- 进度（默认折叠：折叠态只留「阶段 + 百分比」一行摘要，展开才是完整进度与执行日志） -->
        <div v-if="progressVisible" class="rg-progress">
          <button class="rg-fold-btn rg-progress-head" @click="progressOpen = !progressOpen">
            <span class="rg-stage">{{ progress?.stageLabel || '—' }}</span>
            <span v-if="progress?.stage === 'queued'" class="rg-pct">
              {{ progress?.queue?.ahead ? `前面 ${progress.queue.ahead} 个` : '即将开始' }}
            </span>
            <span v-else class="rg-pct">{{ progress?.percent ?? 0 }}%</span>
            <span class="rg-fold">{{ progressOpen ? '▲' : '▼' }}</span>
          </button>
          <template v-if="progressOpen">
            <div v-if="progress?.stage !== 'queued'" class="rg-bar"><i :style="{ width: (progress?.percent ?? 0) + '%' }" /></div>
            <div class="rg-detail">{{ progress?.detail }}</div>
            <div class="rg-detail dim">
              <template v-if="progress?.running">已运行 {{ progress?.elapsed }}s<template v-if="progress?.eta">，预计剩余 {{ progress?.eta }}s</template></template>
              <template v-else>{{ progress?.message || progress?.detail }}</template>
            </div>
            <div v-if="progress?.areaCount" class="rg-detail dim">
              {{ progress.areaCount }} 个区域 · 匹配 {{ progress.matched }} 颗卫星 · 已产出 {{ progress.found }} 次过境 · 已处理 {{ progress.processed }}
            </div>
            <!-- 未勾选「无参数卫星按默认值参与」时，未匹配载荷参数的卫星整颗跳过（按 区域×卫星 计次） -->
            <div v-if="progress?.skippedNoSensor" class="rg-detail warn">
              有 {{ progress.skippedNoSensor }} 次判定因卫星未匹配到载荷参数（幅宽 / 侧摆）被跳过：
              勾选「无参数卫星按默认值参与」可让这些星按默认值参与，或在后台「卫星载荷参数」补齐
            </div>
            <button class="rg-log-toggle" @click="logOpen = !logOpen">{{ logOpen ? '收起日志' : '展开执行日志' }}</button>
            <div v-if="logOpen" class="rg-log">
              <div v-for="(l, i) in progressLogs" :key="i" class="rg-log-line" :class="l.level">
                <span v-if="l.time" class="rg-log-time">{{ l.time }}</span>{{ l.text }}
              </div>
            </div>
          </template>
        </div>

        <!-- 结果：批次摘要 + 按区域汇总 + 明细（服务端分页，前端只渲染当前页） -->
        <template v-if="result?.scan">
          <div class="rg-hint dim">
            <div>
              批次 #{{ result.scan.id }} ｜ {{ result.scan.name || '（临时多区域）' }} ｜ {{ result.scan.area_count }} 区域 ｜
              {{ result.scan.total_passes }} 次过境 ｜ {{ result.scan.total_sats }} 颗 ｜ {{ result.scan.duration }}s
            </div>
            <div>
              {{ fmtTime(result.scan.start_ms) }} 起 {{ result.scan.window_hours }}h ｜ {{ result.scan.message }}
            </div>
            <!-- 本批次判定口径：兜底幅宽/侧摆 + 无参数跳过数（0 且未勾选 = 未启用兜底，只算有参数的卫星） -->
            <div>
              载荷判定口径：
              <template v-if="result.scan.default_swath_km > 0 || result.scan.default_roll_deg > 0">
                未匹配参数卫星按默认 {{ result.scan.default_swath_km }}km / {{ result.scan.default_roll_deg }}° 参与（结果标「参数缺失」）
              </template>
              <template v-else>未启用默认值，只统计有载荷参数的卫星</template>
              <template v-if="result.scan.skipped_no_sensor"> · 无参数跳过 {{ result.scan.skipped_no_sensor }} 次</template>
            </div>
          </div>

          <table class="rg-table">
            <thead><tr><th>#</th><th>区域</th><th>过境次数</th><th>卫星数</th><th>最高覆盖率</th><th>首次 / 末次</th></tr></thead>
            <tbody>
              <tr v-for="s in result.summary" :key="s.area_index">
                <td>{{ s.area_index + 1 }}</td>
                <td class="rg-l">{{ s.area_name || `区域${s.area_index + 1}` }}</td>
                <td>{{ s.passes }}</td>
                <td>{{ s.sats }}</td>
                <td>{{ s.max_coverage === null ? '—' : `${fmtNum(s.max_coverage, 1)}%` }}</td>
                <td>{{ fmtTime(s.first_aos_ms) }} / {{ fmtTime(s.last_aos_ms) }}</td>
              </tr>
              <tr v-if="!result.summary.length"><td colspan="6">无过境命中</td></tr>
            </tbody>
          </table>

          <div class="rg-result-bar">
            <span class="rg-total">过境明细 共 {{ result.total.toLocaleString() }} 条</span>
          </div>

          <!-- 选中记录的播放条：点击明细卡片后出现，可播放 / 定位 / 取消选中 -->
          <div v-if="picked" class="rg-play">
            <button class="rg-btn primary sm" @click="emit('play')">
              {{ multiPassPlaying ? '暂停' : (multiPassProgress >= 0.999 ? '重播' : '播放') }}
            </button>
            <div class="rg-play-bar" title="点击定位播放进度" @click="onSeek">
              <i :style="{ width: (multiPassProgress * 100) + '%' }" />
            </div>
            <span class="rg-play-pct">{{ Math.round(multiPassProgress * 100) }}%</span>
            <button class="rg-btn sm" title="取消选中（清除三维绘制）" @click="clearPick">✕</button>
          </div>

          <!-- 名称 / NORAD 号搜索：服务端过滤（结果动辄上万条，只过滤当前页会很误导） -->
          <input v-model="listKw" class="rg-search" type="search" placeholder="按名称或 NORAD 号搜索（如 GAOFEN 3 03 / 52200）"
            @input="onListKwInput">

          <div class="rg-list">
            <div v-for="(it, i) in list" :key="`${it.norad_id}-${it.area_index}-${it.aos_ms}-${i}`" class="rg-item"
              :class="{ on: isPicked(it) }"
              title="点击在三维地球上绘制该次过境的卫星模型 / 轨道 / 所属区域的扫描条带"
              @click="selectItem(it)">
              <div class="rg-item-head">
                <span class="rg-item-name">{{ it.object_name || '未命名目标' }}</span>
                <span class="rg-item-norad">区域 {{ it.area_index + 1 }}{{ it.area_name ? ` · ${it.area_name}` : '' }} · NORAD {{ it.norad_id }}</span>
                <span class="rg-item-cov" :class="{ full: (it.coverage_pct ?? 0) >= 100 }">
                  {{ it.coverage_pct == null ? '—' : it.coverage_pct + '%' }}
                </span>
              </div>
              <div class="rg-item-sub">
                {{ fmtTime(it.aos_ms) }} → {{ fmtTime(it.los_ms) }} · 持续 {{ fmtDur(it.duration_sec) }}
              </div>
              <div class="rg-item-sub dim">
                <span v-if="it.sensor_missing" class="rg-tag" title="该星未匹配到公开的载荷参数，本行按本次扫描的默认幅宽/侧摆估算">参数缺失</span>
                {{ it.sensor_name || '未匹配载荷参数' }}
                <template v-if="it.sensor_name">（{{ typeLabel[it.sensor_type] || it.sensor_type }}，幅宽 {{ it.swath_km }}km / 侧摆 ±{{ it.max_roll_deg }}°）</template>
                <template v-else-if="it.sensor_missing">（按默认 {{ it.swath_km }}km / {{ it.max_roll_deg }}° 估算）</template>
                · 判定半带宽 {{ it.half_width_km }}km
              </div>
              <div class="rg-item-sub dim">
                所需侧摆 {{ it.required_roll_deg ?? '—' }}° · 星下点最近 {{ fmtNum(it.min_dist_km, 1) }}km ·
                覆盖采样 {{ it.sample_covered }}/{{ it.sample_total }}
              </div>
              <!-- 光照：与区域过境同一判据 —— 取区域中心（地面）的太阳高度角 -->
              <div class="rg-item-light">
                <template v-if="it.sun_elev_deg != null">
                  <span class="rg-light-tag">
                    {{ TWILIGHT_LABEL[it.twilight || ''] || '—' }} · 太阳高度 {{ it.sun_elev_deg }}°
                  </span>
                  <span v-if="it.optical_ok === 1" class="rg-light-tag ok">可光学成像</span>
                  <span v-else-if="it.ground_lit === 1" class="rg-light-tag warn">低太阳角</span>
                  <span v-else class="rg-light-tag dark">夜间</span>
                  <span
                    v-if="it.sat_shadow_state && it.sat_shadow_state !== 'sunlit'"
                    class="rg-light-tag tw"
                    title="卫星自身处于地球阴影，仅影响供电/热控，不影响成像判定"
                  >卫星{{ SHADOW_LABEL[it.sat_shadow_state] }}</span>
                </template>
                <span v-else class="rg-light-tag tw" title="光照条件上线前落库的批次没有该字段；重算一次多区域过境后可用">光照 —</span>
              </div>
            </div>
            <div v-if="!list.length" class="rg-empty">
              <template v-if="listKw.trim()">没有匹配「{{ listKw.trim() }}」的过境记录（名称或 NORAD 号）</template>
              <template v-else>暂无明细：先框选区域并提交扫描，或该批次内没有卫星覆盖这些区域</template>
            </div>
          </div>

          <!-- 分页：结果动辄上万条，一次只渲染一页，避免拖垮面板与浏览器 -->
          <div v-if="result.total > PAGE_SIZE" class="rg-page">
            <button class="rg-btn sm" :disabled="page <= 1" @click="gotoPage(page - 1)">上一页</button>
            <span class="rg-page-num">{{ page }} / {{ totalPages }}</span>
            <button class="rg-btn sm" :disabled="page >= totalPages" @click="gotoPage(page + 1)">下一页</button>
            <span class="rg-page-hint">每页 {{ PAGE_SIZE }} 条</span>
          </div>
        </template>

        <!-- 同时覆盖分析：多区域专有 -->
        <template v-if="coverage">
          <div class="rg-pick">
            <span class="rg-pick-label">同时覆盖分析 · 最少同时覆盖区域数</span>
            <input v-model.number="minAreas" class="rg-num" type="number" min="2" max="10" @change="reloadCoverage">
          </div>
          <div class="rg-hint">
            同一颗卫星在**重叠时间窗**内命中 ≥ {{ coverage.minAreas }} 个区域即为一条记录：共 {{ coverage.groupCount }} 条，
            最多同时覆盖 {{ coverage.maxAreas }} 个区域（参与卫星 {{ coverage.satCount }} 颗）。
            点击卡片在地球上绘制这次真实的多区域过境（各命中区域分别画扫描条带）。
            这是「能同时覆盖」的机会口径，是否真能一帧覆盖多区还要看各区域覆盖率。
          </div>
          <!-- 卡片列表（原为 7 列宽表：列多 + 「命中区域」文本长，文字被严重挤压；
               改为卡片后各区域以标签换行铺开，且整卡可点击回显到三维地球） -->
          <div class="rg-list">
            <div v-for="(g, i) in coverage.groups" :key="`${g.norad_id}-${g.start_ms}-${i}`" class="rg-item"
              :class="{ on: isCoveragePicked(g) }"
              title="点击在三维地球上绘制这次真实的多区域过境：卫星模型 / 轨道 / 各命中区域的扫描条带"
              @click="selectCoverage(g)">
              <div class="rg-item-head">
                <span class="rg-item-name">{{ g.object_name || `NORAD ${g.norad_id}` }}</span>
                <span class="rg-item-norad">NORAD {{ g.norad_id }}</span>
                <span class="rg-item-cov" :class="{ full: (g.max_coverage_pct ?? 0) >= 100 }">
                  同时覆盖 {{ g.area_count }} 区
                </span>
              </div>
              <div class="rg-item-sub">
                {{ fmtTime(g.start_ms) }} → {{ fmtTime(g.end_ms) }} · 窗口 {{ g.span_sec }}s ·
                最高覆盖率 {{ g.max_coverage_pct === null ? '—' : `${fmtNum(g.max_coverage_pct, 1)}%` }} ·
                最佳覆盖跨度 {{ g.cover_span_ms === null ? '—' : `${Math.round(g.cover_span_ms / 1000)}s` }}
              </div>
              <div class="rg-item-sub dim">
                命中区域（{{ g.areas.length }} 个，hover 看各区过境与覆盖率）
              </div>
              <div class="rg-cov-areas">
                <span v-for="a in g.areas" :key="a.area_index" class="rg-cov-tag"
                  :title="`区域${a.area_index + 1} · ${a.area_name || '未命名'}\n过境 ${fmtTime(a.aos_ms)} → ${fmtTime(a.los_ms)}\n最佳覆盖 ${fmtTime(a.max_cover_at_ms)} · 覆盖率 ${a.coverage_pct == null ? '—' : `${a.coverage_pct}%`} · 星下点最近 ${fmtNum(a.min_dist_km, 1)}km`">
                  <b>{{ a.area_name || `区域${a.area_index + 1}` }}</b>
                  <i>{{ a.coverage_pct == null ? '—' : `${fmtNum(a.coverage_pct, 1)}%` }}</i>
                </span>
              </div>
            </div>
            <div v-if="!coverage.groups.length" class="rg-empty">
              没有卫星在同一时段命中多个区域（可调低「最少同时覆盖区域数」或扩大窗口）
            </div>
          </div>
        </template>

        <!-- 判定依据：本次判定按哪些载荷型号的幅宽 / 侧摆（与「区域过境」同一份数据源） -->
        <div class="rg-sensors">
          <button class="rg-log-toggle" @click="sensorOpen = !sensorOpen">
            判定依据：卫星载荷参数（{{ sensors.length }} 个型号）{{ sensorOpen ? '▲' : '▼' }}
          </button>
          <template v-if="sensorOpen">
            <input v-model="sensorKw" class="rg-search" type="search" placeholder="按型号名搜索（如 MERSI / SAR / 雷达）">
            <div class="rg-sensor-list">
              <div v-for="s in sensorShown" :key="s.id" class="rg-sensor-row">
                <span class="rg-sensor-name">{{ s.name }}</span>
                <span class="rg-sensor-val">幅宽 {{ s.swath_km }}km · 侧摆 ±{{ s.max_roll_deg }}°</span>
              </div>
              <div v-if="!sensorShown.length" class="rg-detail dim">没有匹配「{{ sensorKw }}」的型号</div>
            </div>
            <div class="rg-detail dim">
              <template v-if="sensorKw">匹配 {{ sensorShown.length }} / {{ sensors.length }} 个型号 · </template>
              未匹配到型号的卫星：勾选「无参数卫星按默认值参与」时按默认幅宽/侧摆估算并标 sensor_missing，不勾选则整颗跳过。
              参数为各型号公开资料口径，可在后台「卫星载荷参数」页面查看来源与备注。
            </div>
          </template>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped lang="scss">
/* 样式单一来源：
   - 面板外壳 sp-* 类（头部 .sp-head / .sp-title / .sp-close 等）来自 ./index.scss，
     必须在本组件 scoped 样式里 @use，规则才会带上本组件的 data-v 命中内部元素；
   - rg-* 内容类与「区域过境」面板（RegionSection.vue）共用 ./region-shared.scss。
   两个面板是同一套视觉与交互口径，样式只此一份，改一处两端同时生效 ——
   历史上本面板另写过一套 mr-* 类，导致同一个系统里出现两种风格。
   此处只保留面板外壳（头部固定、内容区自己滚动）。 */
@use './index.scss' as *;
@use './region-shared.scss' as *;

.multi-panel {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  color: #e6edf7;

  :deep(.rg-wrap) {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
}
</style>
