<script setup lang="ts">
/**
 * 区域过境面板的内容区（由 RegionPanel.vue 承载外壳，dock 入口 'region'）
 *
 * 链路：三维地球框选多边形（BaseScene.pickEarthLonLat，顶点存 scene.ts 的 regionDraft）
 *   → 点「计算」走后端 CPU 实算（提交 /cgi/pass/region/scan，异步排队，前端轮询 /progress），
 *     结果落库并按批次留档，可回看历史结果。
 *   · 不走大模型：过境是确定性 SGP4 外推，交给 CPU 算比大模型推算可靠。
 *   · 免登录：按 IP 限流（10 分钟内最多 3 次）+ 10 分钟结果缓存 —— 防无限次过境请求。
 *   · 并发：全局最多 2 个任务同时跑、总核预算 4（空闲首任务 4 核，有第 2 个任务时 2+2），多出来的排队。
 *   （进度轮询 / 结果列表 / 区域库等 UI 均复用于展示本次与历史批次。）
 *
 * 判定口径（与后端 lib/passRegionScan.js 一致，两个口径不可混用）：
 *   ① 过境判定：以星下点为中心、半径 halfW = 幅宽/2 + 最大侧摆可达地面偏移 的地面判定圆与多边形相交即算一次过境（**部分覆盖即算**，只回答「有没有这次过境」）；
 *   ② 覆盖率：单帧最大同时覆盖 —— 边长 = 幅宽 W 的方形成像足迹（中心按所需侧摆横向偏移星下点）在窗口内
 *      「单帧最多能同时盖住多少采样点」的占比，不是窗口累积并集，仅作展示过滤，不进算法门限。
 *   列表给出所需最小侧摆 required_roll_deg 与单帧最大覆盖率 coverage_pct。
 * 框选动作不直接调 BaseScene：emit('action') 由 PassPanel → index.vue → sceneRef.expose 转发（与本项目既有面板一致）。
 */
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { regionDrawMode, regionDraft, regionHint, regionPassSel, regionPassPlaying, regionPassProgress, TWILIGHT_LABEL, SHADOW_LABEL } from './scene'
import {
  submitRegionScan, getRegionProgress, getRegionResult, getRegionStats, getRegionList, getRegionSensors,
  cancelRegionScan,
  type RegionProgress, type RegionResult, type RegionItem, type RegionSensorItem, type RegionAccessItem
} from '@/api/pass_region_public'
import { cacheFirst } from '@/utils/persistCache'

const emit = defineEmits<{
  /** 框选动作：start/stop = 开关框选，undo = 撤销一顶点，clear = 清空 */
  (e: 'action', a: 'start' | 'stop' | 'undo' | 'clear'): void
  /** 点选过境记录（null = 取消选中）：三维地球绘制该次过境的卫星模型 / 轨道 / 扫描区域；
   *  runId 为该条记录所属结果批次 id（智能体出报告时用它精确定位明细） */
  (e: 'pick', rec: RegionAccessItem | null, runId?: number): void
  /** 播放 / 暂停沿 AOS→LOS 的卫星飞行 */
  (e: 'play'): void
  /** 播放进度定位（ratio 0~1） */
  (e: 'seek', ratio: number): void
}>()

/** 预报窗口可选档位（小时）：后端 normalizeRegionScanOpts 允许 1~72，面板给三档常用值 */
const WINDOW_OPTIONS = [24, 48, 72]
/** 预报窗口（小时）：默认 24（与后端 REGION_WINDOW_HOURS 一致），提交时随 window_hours 下发；
 *  窗口已计入后端区域指纹（regionFingerprint），不同窗口各自独立缓存，互不复用结果 */
const windowHours = ref(24)
/* ---------- 缺参数卫星的兜底参数（默认启用） ----------
 * 库里只有很少一部分载荷星能匹配到公开的幅宽 / 侧摆；此前这些星不参与扫描，
 * 结果是「只有几十颗星能算」。开启后，未匹配到参数的卫星一律按下面的默认值参与判定，
 * 结果行标「参数缺失」，与取到真实参数的行区分开。 */
/** 是否让未匹配到载荷参数的卫星按默认值参与 */
const useDefaultSensor = ref(true)
/** 默认成像幅宽（km）：初值取算法缺省（后端 fallbackSwathKm） */
const defaultSwathKm = ref(100)
/** 默认最大侧摆（°）：0 = 按星下点正下方成像估算 */
const defaultRollDeg = ref(0)
/** 输入框是否已用后端算法缺省值初始化（只初始化一次，避免覆盖用户已改的值） */
let fallbackInited = false
/** 面板内提示（不走 ElMessage：本页为自绘轻量 UI，与 PassPanel 风格一致） */
const tip = ref('')
/** 正在提交 */
const submitting = ref(false)

/* ---------- 进度 ---------- */
const progress = ref<RegionProgress | null>(null)
/** 是否展示进度块（有进度或本次提交后；含「排队中」） */
const progressVisible = computed(() => {
  const p = progress.value
  if (!p) return false
  return p.stage !== 'idle'
    && (p.running || p.stage === 'queued' || p.stage === 'done' || p.stage === 'error' || p.stage === 'cancelled')
})
/**
 * 本浏览器是否有任务在推进（运行中或排队中）。
 * 结果列表据此决定展不展示：本浏览器的任务没结束时列表一律保持空，面板只留进度。
 * 只认「本客户端自己的任务」（owned）—— 别的浏览器提交、后台 /api、定时任务跑起来的扫描
 * 都不该清空自己的结果列表（排队制下每次只跑一个，否则会互相干扰）。
 * 只靠「提交时清空」不够 —— 刷新浏览器、切回本页签都会绕过它。
 */
const scanRunning = computed(() => {
  const p = progress.value
  if (!p) return false
  return p.running === true || (p.owned === true && p.stage === 'queued')
})
const logOpen = ref(false)
/** 进度块的展开态：默认折叠 —— 折叠时只留「阶段 + 百分比」一行摘要，展开才是完整进度与执行日志 */
const progressOpen = ref(false)

/**
 * 执行日志的展示过滤：子进程 / 任务块调度细节（开了几个进程、谁领了哪块、哪个进程退了）
 * 属于运维信息，对前台用户只是噪声，面板里不展示；
 * 完整日志仍在后端日志文件与后台「区域过境」页，排查问题不缺线索。
 * 只滤 info 级调度噪声 —— warn / error 一律保留，隐藏的是噪声不是问题线索。
 */
const SCHEDULE_NOISE = [
  /^\[W\d+\/\d+\]/, // 单个子进程的输出（数据已加载 / 任务块完成 / 队列已空 / 子进程已启动…）
  /扫描子进程/, // 「已启动 N 个扫描子进程（PID …），每进程堆上限 …」
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

/** TLE 时效提示的展开态：默认折叠 —— 折叠时只留「多少颗 / 最老天数」的摘要，展开才是完整说明 */
const warnOpen = ref(false)

let timer: number | null = null

function startPolling() {
  if (timer != null) return
  timer = window.setInterval(() => { void fetchProgress() }, 2000)
}
function stopPolling() {
  if (timer == null) return
  window.clearInterval(timer)
  timer = null
}

async function fetchProgress() {
  try {
    const p = await getRegionProgress()
    progress.value = p
    // 扫描已结束（成功/失败/取消且无运行中任务）→ 停轮询并拉结果
    if (!p.running && (p.stage === 'done' || p.stage === 'error' || p.stage === 'cancelled')) {
      stopPolling()
      if (p.stage === 'done') await fetchResult(p.runId)
    } else if (p.stage === 'idle') {
      stopPolling()
    } else if (p.running || p.stage === 'queued') {
      // 本浏览器有任务在跑 / 排队：清掉结果列表，面板只留进度。
      // 放在这里（而不是只放在提交处）才能覆盖刷新浏览器、切回本页签这几种情况。
      clearPrevResult()
      startPolling()
    }
  } catch { /* 网络抖动下一次轮询重试 */ }
}

/* ---------- 结果（服务端分页） ----------
 * 一次扫描动辄上万条结果（默认幅宽兜底后参与星上万颗），此前按 pageSize=0 一次取全，
 * 前端要渲染上万条 DOM，直接拖垮面板与浏览器。现改为服务端分页（每页 20 条），
 * 排序与覆盖率过滤也一并交给后端 —— 只对当前页做本地排序会让「翻页后顺序错乱」，
 * 本地过滤则会让总数与实际条数对不上。 */
const result = ref<RegionResult | null>(null)
/** 排序口径（服务端排序）：按过境时刻 / 按覆盖率 */
const order = ref<'time' | 'coverage'>('time')
/** 覆盖率下限（%，服务端过滤；0 = 不过滤） */
const minCoverage = ref(0)
/** 只看光学可成像（服务端过滤）：区域中心太阳高度 ≥ 10°，即地面被照得够亮、适合光学成像 */
const opticalOnly = ref(false)
/** 当前页码（从 1 开始） */
const page = ref(1)
/** 每页条数：与后端 /result 的 pageSize 对应 */
const PAGE_SIZE = 20

/** 总页数（分页控件用；无结果时为 1，避免出现「1 / 0」） */
const totalPages = computed(() => Math.max(1, Math.ceil((result.value?.total || 0) / PAGE_SIZE)))

/** 当前页数据：后端已按 order / min_coverage 排好序并分页，前端不再改写顺序 */
const list = computed(() => result.value?.list || [])

/** 列表搜索关键字（名称 / NORAD 号）：过滤交给后端 —— 结果动辄上万条，
 *  只过滤当前页那 20 条会造成「搜索像没生效」，总数与分页也会对不上 */
const listKw = ref('')
/** 搜索输入防抖定时器（避免每敲一个字就发一次请求） */
let listKwTimer: number | null = null

/** 搜索输入：400ms 防抖后回到第 1 页重新取 */
function onListKwInput() {
  if (listKwTimer != null) window.clearTimeout(listKwTimer)
  listKwTimer = window.setTimeout(() => {
    listKwTimer = null
    void fetchResult(undefined, 1)
  }, 400)
}

/** 拉取结果：toPage 缺省回到第 1 页（提交完成 / 切换批次后都应回到首页） */
async function fetchResult(runId?: number | null, toPage = 1) {
  // 有任务在跑、又没指定批次（进面板 / 翻页 / 改排序 / 改过滤）→ 不展示任何结果：
  // 这些入口取到的是「最近一次有明细的批次」＝上一次的旧结果，正是要避免的新旧混淆。
  // 显式传 runId 的调用（刚算完的批次、命中的缓存批次）不受影响。
  if (runId == null && scanRunning.value) {
    clearPrevResult()
    return
  }
  page.value = Math.max(1, toPage)
  // 批次在取缓存之前先锁定：默认视图会先用缓存把 result 填上，
  // 若在 query 里才读 result.value?.run_id，就会把批次钉在缓存那一次、永远追不上最新批次
  const pinnedRunId = runId ?? result.value?.run_id ?? undefined
  const query = () => getRegionResult({
    // 翻页时沿用当前批次，避免中途有扫描完成导致跳到别的批次
    run_id: pinnedRunId,
    page: page.value,
    pageSize: PAGE_SIZE,
    order: order.value,
    min_coverage: minCoverage.value || undefined,
    optical: opticalOnly.value ? 1 : undefined,
    object_name: listKw.value.trim() || undefined
  })
  // 默认视图（第 1 页、无排序 / 过滤，且未指定批次）走本地持久缓存：
  // 打开面板即显示上次结果，随后静默拉最新替换；带条件查询/翻页仍走原路径，避免串数据
  const isDefault = page.value === 1 && runId == null && order.value === 'time' &&
    !minCoverage.value && !opticalOnly.value && !listKw.value.trim()
  if (isDefault) {
    await cacheFirst('situation:region:result:p1:v1', query, (v) => { result.value = v }, () => !!result.value)
      .catch(() => { /* 拦截器已提示 */ })
    return
  }
  try {
    result.value = await query()
  } catch { /* 拦截器已提示 */ }
}

/** 翻页（页码夹在 [1, totalPages] 内） */
function gotoPage(p: number) {
  const target = Math.min(Math.max(1, p), totalPages.value)
  if (target === page.value) return
  void fetchResult(undefined, target)
}

/** 切换排序：回到第 1 页重新取（服务端排序，保证跨页顺序一致） */
function onOrderChange(e: Event) {
  order.value = (e.target as HTMLSelectElement).value as 'time' | 'coverage'
  void fetchResult(undefined, 1)
}

/** 切换覆盖率下限：回到第 1 页重新取（服务端过滤，总数与分页才准确） */
function onCoverageChange(e: Event) {
  minCoverage.value = Number((e.target as HTMLSelectElement).value) || 0
  void fetchResult(undefined, 1)
}

/** 切换「只看可光学成像」：同样走服务端过滤（注意光照字段上线前的老批次会过滤成空） */
function onOpticalChange(e: Event) {
  opticalOnly.value = (e.target as HTMLInputElement).checked
  void fetchResult(undefined, 1)
}

const stats = ref<{
  total: number
  fullCover: number
  bestCoverage: number | null
  /** 已匹配到型号参数、可直接参与扫描的卫星数 */
  matchedSats: number
  /** 未匹配到型号参数、需按默认值兜底才参与的卫星数 */
  noSensorSats: number
  /** TLE 时效：候选集中 epoch 距今超过 days 天的卫星数（仅提示） */
  staleTle: { days: number; count: number; oldestDays: number | null }
} | null>(null)

/** 概览：先出本地持久缓存（面板打开即显示上次概览），随后静默拉最新替换 */
async function fetchStats() {
  await cacheFirst<Awaited<ReturnType<typeof getRegionStats>>>(
    'situation:region:stats:v1',
    getRegionStats,
    (s) => {
      stats.value = {
        total: s.total,
        fullCover: s.fullCover,
        bestCoverage: s.bestCoverage,
        matchedSats: Number(s.matchedSats || 0),
        noSensorSats: Number(s.noSensorSats || 0),
        staleTle: s.staleTle || { days: 0, count: 0, oldestDays: null }
      }
      // 首次拿到概览时，用后端算法缺省值填一次输入框（用户改过就不再覆盖）
      if (!fallbackInited && s.fallbackSwathKm != null) {
        defaultSwathKm.value = Number(s.fallbackSwathKm)
        defaultRollDeg.value = Number(s.fallbackRollDeg || 0)
        fallbackInited = true
      }
    }
  ).catch(() => { /* 拦截器已提示 */ })
}

/* ---------- 选中过境记录：三维绘制卫星模型 / 轨道 / 扫描区域 + 播放条 ---------- */
/** 播放条显隐：直接跟随选中态 —— 结果改为分页后，选中的那条多半已不在当前页，
 *  若仍要求它出现在 list 里，一翻页播放条就会莫名消失（而三维绘制其实还在）。 */
const picked = computed(() => regionPassSel.value)

/** 列表项是否选中：按 norad + AOS 时刻判等（同一颗星的多次过境各算一条） */
function isPicked(it: RegionAccessItem) {
  const s = regionPassSel.value
  return !!s && s.norad_id === it.norad_id && s.aos_ms === it.aos_ms
}

/** 点击列表项：先把该批次所用区域轮廓回显到框选草稿（BaseScene 的 watch 会自动重画），
 *  再交给父组件转发到 BaseScene 绘制该次过境。
 *  顺序不能反 —— 扫描带的侧向符号由 regionDraft 决定；页面刷新后草稿已丢，
 *  靠批次记录里存的顶点复原「那次所画的区域」。 */
function selectItem(it: RegionAccessItem) {
  restoreBatchRegion()
  // 第二个参数带上当前结果批次 id：父组件接住后传给智能体上下文，
  // 让「选中这条 → 出报告」能直接定位到 pass_region_access 明细，不必再向用户索要 id
  emit('pick', it, result.value?.run_id ?? undefined)
}

/** 用当前结果批次记录的区域顶点复原框选草稿（顶点不足 3 个时不动草稿，仅在草稿为空时提示）。
 *  草稿与该批次顶点一致时不重复赋值，避免多余重绘、打断正在进行的框选。 */
function restoreBatchRegion() {
  const poly = result.value?.region?.polygon
  const pts = Array.isArray(poly)
    ? poly
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => ({ lon: Number(p[0]), lat: Number(p[1]) }))
    : []
  if (pts.length < 3) {
    // 更新前的临时框选批次没记顶点，无处复原；只在草稿为空时提示，避免覆盖其他提示
    if (!regionDraft.value.length) tip.value = '该批次未记录区域顶点（更新前的临时框选批次），无法回显轮廓；重新框选计算即可记录'
    return
  }
  const cur = regionDraft.value
  const same = cur.length === pts.length
    && cur.every((p, i) => Math.abs(p.lon - pts[i].lon) < 1e-9 && Math.abs(p.lat - pts[i].lat) < 1e-9)
  if (same) return
  regionDraft.value = pts
  regionHint.value = `已回显该批次区域轮廓（${pts.length} 个顶点）`
}

/** 取消选中：清除三维绘制并交回时间推进 */
function clearPick() {
  emit('pick', null)
}

/** 点击进度条定位播放进度 */
function onSeek(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  if (!r.width) return
  emit('seek', Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
}

/* ---------- 区域库（可选已存区域直接算） ---------- */
const regions = ref<RegionItem[]>([])
const regionId = ref<number | ''>('')

/** 区域库列表：先出本地持久缓存（下拉立即可选），随后静默拉最新替换 */
async function fetchRegions() {
  await cacheFirst<RegionItem[]>('situation:region:lib:v1', getRegionList, (v) => { regions.value = v || [] })
    .catch(() => { /* 拦截器已提示 */ })
}

/** 选中区域库条目：把顶点回填到框选草稿（BaseScene 的 watch 会自动重画），用户可直接提交 */
function pickRegion(id: number | '') {
  regionId.value = id
  if (!id) return
  const r = regions.value.find((x) => x.id === id)
  if (!r || !Array.isArray(r.polygon)) return
  const pts = (r.polygon as number[][])
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => ({ lon: Number(p[0]), lat: Number(p[1]) }))
  if (pts.length < 3) {
    tip.value = `区域「${r.name}」顶点不足 3 个，无法计算`
    return
  }
  regionDraft.value = pts
  regionHint.value = `已载入区域「${r.name}」（${pts.length} 个顶点）`
  emit('action', 'stop')
}

/* ---------- 载荷参数（说明判定依据） ---------- */
const sensors = ref<RegionSensorItem[]>([])
const sensorOpen = ref(false)
/** 型号名搜索关键字（仅前端本地过滤，不再请求接口） */
const sensorKw = ref('')
/** 按名称过滤后的型号列表（关键字为空即全量） */
const sensorShown = computed(() => {
  const kw = sensorKw.value.trim().toLowerCase()
  if (!kw) return sensors.value
  return sensors.value.filter((s) => (s.name || '').toLowerCase().includes(kw))
})
/** 载荷参数（判定依据）：与区域库同口径，先出本地持久缓存再静默刷新 */
async function fetchSensors() {
  await cacheFirst<RegionSensorItem[]>('situation:region:sensors:v1', getRegionSensors, (v) => { sensors.value = v || [] })
    .catch(() => { /* 判定依据加载失败不影响扫描 */ })
}

/* ---------- 提交 ---------- */
const canSubmit = computed(() => regionDraft.value.length >= 3 && !submitting.value)

/**
 * 有新任务在跑时，清掉上一次的结果展示：结果列表 + 页码 + 选中的过境记录
 * （选中态同时驱动三维绘制与下方播放条，属于上一次结果的延伸，一并撤掉，
 * 否则会出现「列表已空、播放条还挂着上一批那条记录」的错位）。
 * 概览（stats）不在此列 —— 那是库里已入库数据的现状，不是本次操作的结果。
 * 轮询期间每 2s 会被调一次，故所有动作都做成幂等，且只在确有选中时才下发取消选中。
 */
function clearPrevResult() {
  result.value = null
  page.value = 1
  if (regionPassSel.value) emit('pick', null)
}

/**
 * 点「计算」：提交后端实时计算（/cgi/pass/region/scan），异步排队后前端轮询进度。
 *  · 免登录：后端按 IP 限流（10 分钟内最多 3 次）+ 同区域 10 分钟结果缓存；
 *  · 选了区域库条目就带 region_id，否则带框选顶点 polygon。
 */
async function submit() {
  if (regionDraft.value.length < 3) {
    tip.value = '请先框选至少 3 个顶点（点「开始框选」后在地球上依次单击）'
    return
  }
  if (submitting.value) return
  submitting.value = true
  tip.value = ''
  emit('action', 'stop')
  const regionIdNum = typeof regionId.value === 'number' && regionId.value > 0 ? regionId.value : undefined
  try {
    const r = await submitRegionScan({
      region_id: regionIdNum,
      name: regionIdNum ? undefined : `临时框选 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      polygon: regionIdNum ? undefined : regionDraft.value.map((p) => [p.lon, p.lat]),
      window_hours: windowHours.value,
      use_default_sensor: useDefaultSensor.value,
      default_swath_km: defaultSwathKm.value,
      default_roll_deg: defaultRollDeg.value
    })
    if (r.cached) {
      // 命中 10 分钟缓存：直接载入上次批次
      stopPolling()
      await fetchResult(r.run_id ?? undefined)
      tip.value = '该区域在有效期内已计算过，直接载入上次结果'
      return
    }
    if (r.already) {
      tip.value = r.queued ? '本浏览器已有任务在排队，正在查看排队进度' : '本浏览器已有扫描正在运行，正在查看进度'
    } else if (r.queued) {
      tip.value = r.ahead ? `已进入队列（前面还有 ${r.ahead} 个任务），轮到时自动开跑` : '已进入队列，即将开始'
    } else {
      tip.value = '已提交，扫描进行中'
    }
    // 框选提交会同步把区域写入区域库：刷新下拉让新区域立即可复用；同时清掉当前草稿里的旧选中
    if (r.region_id) {
      regionId.value = ''
      void fetchRegions()
    }
    clearPrevResult()
    startPolling()
    await fetchProgress()
  } catch (e: unknown) {
    tip.value = (e as { message?: string })?.message || '提交失败'
  } finally {
    submitting.value = false
  }
}

/**
 * 取消本浏览器的任务：运行中 → 通知后端软取消（等待子进程退出）；排队中 → 直接出队。
 * 排队制下位次可能较靠后，用户有权撤回自己排的队。
 */
async function doCancel() {
  try {
    const r = await cancelRegionScan()
    if (r.cancelled) {
      ElMessage.success('已请求取消')
      await fetchProgress()
    } else {
      ElMessage.info('当前没有可取消的任务')
    }
  } catch (e: unknown) {
    ElMessage.error((e as { message?: string })?.message || '取消失败')
  }
}

/* ---------- 展示工具 ---------- */
const p2 = (n: number) => String(n).padStart(2, '0')

/** 时间戳 → `MM-DD HH:mm:ss`（本地时区） */
function fmtTime(ms: number | null | undefined) {
  if (!ms) return '—'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** 持续秒 → `Xm Ys` */
function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return m ? `${m}m${p2(s % 60)}s` : `${s}s`
}

const typeLabel: Record<string, string> = { optical: '光学', sar: 'SAR', other: '其他' }

onMounted(async () => {
  // 先取进度、再取结果：进度里的本浏览器任务状态决定结果列表展不展示 ——
  // 本浏览器有任务在跑/排队时（本次刷新前提交的），进面板只看到进度，列表保持空；
  // 无本浏览器任务时照旧展示最近批次的明细。
  await fetchProgress()
  void fetchResult()
  void fetchStats()
  void fetchRegions()
  void fetchSensors()
})

/**
 * 清空：三维地球上的框选顶点 + 下方「扫描结果 / 进度 / 提示 / 排序过滤 / 选中的区域库」一并回到初始状态。
 * 概览（区域内入库的过境统计）不在此列 —— 那是库里的数据现状，不是本次操作的结果。
 * 若此时本浏览器的扫描仍在进行/排队：停掉轮询并给出提示，避免「看不见进度却以为没在跑」；
 * 扫描结果仍会入库，重新进入本页签会按最近批次自动展示。
 */
function clearAll() {
  const wasRunning = scanRunning.value
  emit('action', 'clear')
  // 取消选中：清除三维上该次过境的卫星模型 / 轨道 / 扫描区域
  emit('pick', null)
  stopPolling()
  result.value = null
  progress.value = null
  order.value = 'time'
  minCoverage.value = 0
  opticalOnly.value = false
  page.value = 1
  regionId.value = ''
  listKw.value = ''
  tip.value = wasRunning
    ? '面板已清空；本浏览器提交的扫描仍在进行/排队中，完成后重新进入本页签即可查看结果'
    : ''
}

/**
 * 点「开始框选」：若此刻已选中某条过境记录（三维地球上正绘制该次过境的卫星模型 / 轨道 / 扫描区域），
 * 先弹确认再清场 —— 框选的语义是「重新画一圈区域」，留着上一轮的过境绘制与结果列表会让新旧内容
 * 混在一起，分不清哪条结果属于哪次框选。确认后清掉地球上的绘制与框选草稿、下方结果列表
 * （含排序 / 覆盖率过滤 / 搜索关键字），再进入框选模式。
 * 未选中记录时保持原行为：直接进入框选（继续在已有顶点上加点）。
 * 用 ElMessageBox 而非 window.confirm：原生 confirm 在部分安卓浏览器/WebView 里会被静默屏蔽或样式不可控。
 */
async function onStartDraw() {
  const sel = regionPassSel.value
  if (!sel) {
    emit('action', 'start')
    return
  }
  // 选中的那条多半已被翻页/搜索滤出当前页，取不到名称就退回 NORAD 号
  const cur = list.value.find((x) => x.norad_id === sel.norad_id && x.aos_ms === sel.aos_ms)
  const who = cur?.object_name ? `${cur.object_name}（NORAD ${sel.norad_id}）` : `NORAD ${sel.norad_id}`
  try {
    // 用 VNode 而非带 \n 的字符串：MessageBox 的正文默认 white-space: normal，换行符会被吞掉
    await ElMessageBox.confirm(
      h('div', { style: 'line-height: 1.7' }, [
        h('div', `当前已选中过境记录：${who}`),
        h('div', { style: 'margin-top: 8px' }, '开始重新框选将清除：'),
        h('div', '· 三维地球上该次过境的卫星模型 / 轨道 / 扫描区域，以及已框选的多边形'),
        h('div', '· 下方结果列表（含排序、覆盖率过滤与搜索关键字）'),
        h('div', { style: 'margin-top: 8px' }, '清除后请在地球上重新框选区域，再点「计算」。')
      ]),
      '重新框选',
      { type: 'warning', confirmButtonText: '清空并开始框选', cancelButtonText: '取消' }
    )
  } catch { return /* 取消 / 关闭：不清场，保持现状 */ }
  const wasRunning = scanRunning.value
  clearAll()
  emit('action', 'start')
  tip.value = wasRunning
    ? '已清空地球绘制与结果列表，进入框选模式；本浏览器提交的扫描仍在进行/排队中，完成后重新进入本页签即可查看结果'
    : '已清空地球绘制与结果列表，请在地球上重新框选区域，完成后点「计算」'
}

onBeforeUnmount(() => {
  stopPolling()
  if (listKwTimer != null) { window.clearTimeout(listKwTimer); listKwTimer = null }
  // 离开区域页签时退出框选模式（顶点草稿保留，回到页签可继续），避免「看不见面板却还在球面上画点」
  if (regionDrawMode.value) emit('action', 'stop')
})
</script>

<template>
  <div class="rg-wrap">
    <!-- 概览：当前批次的过境规模与运行态。
         有任务在跑时只留实时进度里的「参与卫星」，上一批的三个统计（次过境 / 全覆盖 / 最佳覆盖）
         隐藏 —— 它们取的是「最近一个有明细的批次」＝上一次，跑着的时候头部写着上一批的数字、
         下面列表却是空的，自相矛盾。 -->
    <div v-if="!scanRunning || progress?.matched" class="rg-stats">
      <template v-if="!scanRunning">
        <span><b>{{ (stats?.total ?? 0).toLocaleString() }}</b> 次过境</span>
        <span><b>{{ (stats?.fullCover ?? 0).toLocaleString() }}</b> 次全覆盖</span>
        <span>最佳覆盖 <b>{{ stats?.bestCoverage == null ? '—' : stats.bestCoverage + '%' }}</b></span>
      </template>
      <span v-if="progress?.matched">参与卫星 <b>{{ progress.matched }}</b></span>
    </div>

    <!-- 框选工具条 -->
    <div class="rg-tools">
      <button v-if="!regionDrawMode" class="rg-btn primary"
        :title="picked ? '开始新一轮框选：会先清除三维地球上已绘制的过境内容与下方结果列表' : '进入框选模式，在地球上依次单击选点'"
        @click="onStartDraw">开始框选</button>
      <button v-else class="rg-btn primary" @click="emit('action', 'stop')">完成框选</button>
      <button class="rg-btn" :disabled="!regionDraft.length" @click="emit('action', 'undo')">撤销</button>
      <button class="rg-btn" :disabled="!regionDraft.length && !result && !progressVisible" title="清空框选与下方扫描结果，回到初始状态" @click="clearAll">清空</button>
      <span class="rg-count">{{ regionDraft.length }} 点</span>
    </div>
    <div class="rg-hint">{{ regionHint || '在地球上依次单击选点，至少 3 个点（双击、点回起点或点「完成框选」闭合）' }}</div>

    <!-- 可选：直接选区域库中已存区域 -->
    <div v-if="regions.length" class="rg-pick">
      <span class="rg-pick-label">区域库</span>
      <select class="rg-select" :value="regionId" @change="pickRegion(Number(($event.target as HTMLSelectElement).value) || '')">
        <option value="">（用框选顶点）</option>
        <option v-for="r in regions" :key="r.id" :value="r.id">{{ r.name }} · {{ Math.round(r.area_km2) }} km²</option>
      </select>
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
      <div>参与扫描：仅低轨（LEO）载荷星，非 LEO（MEO / HEO / IGSO / GEO）不参与。</div>
      <template v-if="useDefaultSensor">
        未匹配到载荷参数的 <b>{{ (stats?.noSensorSats ?? 0).toLocaleString() }}</b> 颗卫星将按
        {{ defaultSwathKm }}km / {{ defaultRollDeg }}° 估算参与（结果标「参数缺失」）；
        另有 <b>{{ (stats?.matchedSats ?? 0).toLocaleString() }}</b> 颗按各自型号的真实参数判定
      </template>
      <template v-else>
        仅计算已匹配到载荷参数的 <b>{{ (stats?.matchedSats ?? 0).toLocaleString() }}</b> 颗卫星，
        其余 {{ (stats?.noSensorSats ?? 0).toLocaleString() }} 颗缺参数卫星不参与
      </template>
    </div>

    <!--
      TLE 时效提示（仅提示，不过滤扫描）：候选集里混着一些 epoch 距今很久的 TLE，
      多为「已离开地球的深空探测器」（TLE 停在发射初期的近地逃逸轨道，如火星快车 / 朱诺号 /
      嫦娥系列）或长期失联卫星 —— 它们仍被标为在轨 LEO，若又启用了上面的默认值参与，
      会按兜底幅宽产出不可信的过境记录。此处把数量与最老天数摆出来，便于判断结果可信度。
    -->
    <div v-if="stats?.staleTle?.count" class="rg-warn">
      <button class="rg-fold-btn" @click="warnOpen = !warnOpen">
        <span class="rg-fold-text">
          <b>注意</b>：候选卫星中有 <b>{{ stats.staleTle.count }}</b> 颗的 TLE 已超过
          {{ stats.staleTle.days }} 天未更新<template v-if="stats.staleTle.oldestDays != null">（最老 {{ stats.staleTle.oldestDays.toLocaleString() }} 天）</template>
        </span>
        <span class="rg-fold">{{ warnOpen ? '▲' : '▼' }}</span>
      </button>
      <div v-if="warnOpen" class="rg-warn-body">
        这类多为已飞离地球的深空探测器或失联卫星，轨道位置已不可信，
        若它们出现在结果里请勿采信（关闭上方「无参数卫星按默认值参与」可排除其中无参数的星）。
      </div>
    </div>

    <!-- 预报窗口：三档时长，窗口越长过境越多、耗时越长 -->
    <div class="rg-win">
      <span class="rg-win-label">预报窗口</span>
      <button v-for="h in WINDOW_OPTIONS" :key="h" class="rg-win-btn" :class="{ active: windowHours === h }"
        @click="windowHours = h">{{ h }}h</button>
    </div>

    <button class="rg-submit" :disabled="!canSubmit" @click="submit">
      {{ submitting ? '提交中…' : `计算未来 ${windowHours}h 过境` }}
    </button>
    <div v-if="tip" class="rg-tip">{{ tip }}</div>
    <!-- 取消本浏览器的任务（排队制下位次可能靠后，可撤回；运行中则软取消，等待子进程退出） -->
    <div class="rg-tools">
      <button class="rg-btn" :disabled="!scanRunning" @click="doCancel">
        {{ progress?.stage === 'queued' ? '取消排队' : '取消扫描' }}
      </button>
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
        <div v-if="progress?.skippedNoSensor" class="rg-detail warn">
          有 {{ progress.skippedNoSensor }} 颗卫星未匹配到载荷参数（幅宽 / 侧摆），已跳过；可在后台「卫星载荷参数」补齐
        </div>
        <button class="rg-log-toggle" @click="logOpen = !logOpen">{{ logOpen ? '收起日志' : '展开执行日志' }}</button>
        <div v-if="logOpen" class="rg-log">
          <div v-for="(l, i) in progressLogs" :key="i" class="rg-log-line" :class="l.level">
            <span v-if="l.time" class="rg-log-time">{{ l.time }}</span>{{ l.text }}
          </div>
        </div>
      </template>
    </div>

    <!-- 结果（服务端分页：排序 / 覆盖率过滤都走后端，前端只渲染当前页 20 条） -->
    <div class="rg-result-bar">
      <select class="rg-select sm" :value="order" @change="onOrderChange">
        <option value="time">按过境时刻</option>
        <option value="coverage">按覆盖率</option>
      </select>
      <select class="rg-select sm" :value="minCoverage" @change="onCoverageChange">
        <option :value="0">覆盖率不限</option>
        <option :value="25">覆盖率 ≥ 25%</option>
        <option :value="50">覆盖率 ≥ 50%</option>
        <option :value="100">仅全覆盖</option>
      </select>
      <label class="rg-optical" title="只看区域中心太阳高度 ≥ 10° 的过境（地面被照得够亮，适合光学成像）；光照条件上线前的老批次会过滤成空">
        <input type="checkbox" :checked="opticalOnly" @change="onOpticalChange">
        <span>只看可光学成像</span>
      </label>
      <span class="rg-total">共 {{ (result?.total ?? 0).toLocaleString() }} 条</span>
    </div>

    <!-- 选中记录的播放条：显示本次过境窗口与进度，可播放 / 定位；点击列表项后出现 -->
    <div v-if="picked" class="rg-play">
      <button class="rg-btn primary sm" @click="emit('play')">
        {{ regionPassPlaying ? '暂停' : (regionPassProgress >= 0.999 ? '重播' : '播放') }}
      </button>
      <div class="rg-play-bar" title="点击定位播放进度" @click="onSeek">
        <i :style="{ width: (regionPassProgress * 100) + '%' }" />
      </div>
      <span class="rg-play-pct">{{ Math.round(regionPassProgress * 100) }}%</span>
      <button class="rg-btn sm" title="取消选中（清除三维绘制）" @click="clearPick">✕</button>
    </div>

    <!-- 名称 / NORAD 号搜索：服务端过滤（结果动辄上万条，只过滤当前页会很误导） -->
    <input v-model="listKw" class="rg-search" type="search" placeholder="按名称或 NORAD 号搜索（如 GAOFEN 3 03 / 52200）"
      @input="onListKwInput">

    <div class="rg-list">
      <div v-for="(it, i) in list" :key="`${it.norad_id}-${it.aos_ms}-${i}`" class="rg-item"
        :class="{ on: isPicked(it) }"
        title="点击在三维地球上绘制该次过境的卫星模型 / 轨道 / 扫描区域"
        @click="selectItem(it)">
        <div class="rg-item-head">
          <span class="rg-item-name">{{ it.object_name || '未命名目标' }}</span>
          <span class="rg-item-norad">NORAD {{ it.norad_id }}</span>
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
          所需侧摆 {{ it.required_roll_deg }}° · 星下点最近 {{ it.min_dist_km }}km · 覆盖采样 {{ it.sample_covered }}/{{ it.sample_total }}
        </div>
        <!-- 光照条件：区域过境是「卫星拍地面」，判据取区域中心（地面）的太阳高度角 -->
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
          <span v-else class="rg-light-tag tw" title="光照条件上线前落库的批次没有该字段；重算一次区域过境后可用">光照 —</span>
        </div>
      </div>
      <div v-if="!list.length" class="rg-empty">
        <template v-if="listKw.trim()">没有匹配「{{ listKw.trim() }}」的过境记录（名称或 NORAD 号）</template>
        <template v-else>暂无结果：先框选区域并点「计算」，或该批次内没有卫星覆盖此区域</template>
      </div>
    </div>

    <!-- 分页：结果动辄上万条，一次只渲染一页（20 条），避免拖垮面板与浏览器 -->
    <div v-if="result && result.total > PAGE_SIZE" class="rg-page">
      <button class="rg-btn sm" :disabled="page <= 1" @click="gotoPage(page - 1)">上一页</button>
      <span class="rg-page-num">{{ page }} / {{ totalPages }}</span>
      <button class="rg-btn sm" :disabled="page >= totalPages" @click="gotoPage(page + 1)">下一页</button>
      <span class="rg-page-hint">每页 {{ PAGE_SIZE }} 条</span>
    </div>

    <!-- 载荷参数：说明本次判定按哪些型号的幅宽 / 侧摆 -->
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
          参数为各型号公开资料口径，可在后台「卫星载荷参数」页面查看来源与备注
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 样式单一来源：与「多区域过境」面板（MultiRegionPanel.vue）共用 ./region-shared.scss。
   两个面板是同一套视觉与交互口径，样式只此一份，改一处两端同时生效 ——
   历史上多区域面板另写过一套 mr-* 类，导致同一个系统里出现两种风格。 */
@use './region-shared.scss' as *;
</style>
