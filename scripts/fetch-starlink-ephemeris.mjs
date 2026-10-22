#!/usr/bin/env node
/**
 * 拉取 Starlink 公开星历并转成精简 JSON 样本。
 *
 * 用法：
 *   node scripts/fetch-starlink-ephemeris.mjs                 # 联网拉取前 8 个文件
 *   node scripts/fetch-starlink-ephemeris.mjs --count=12      # 指定数量
 *   node scripts/fetch-starlink-ephemeris.mjs --offline       # 只转换 public/ephemeris-samples/raw/ 里的原始 txt
 *   node scripts/fetch-starlink-ephemeris.mjs --save-raw      # 联网时同时保存原始 txt 以便离线复跑
 *
 * 输出：public/ephemeris-samples/<norad>.json 与 index.json。
 * 每个文件保留首个历元起 72 小时、步长 60s 的状态（4320 点），与面板标注的「72h / 60s」一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'public', 'ephemeris-samples')
const RAW_DIR = path.join(OUT_DIR, 'raw')
const BASE_URL = 'https://api.starlink.com/public-files/ephemerides/'

const DAY_MS = 86400000
/** 保留时长：面板标注 72h 预报，样本按 72h 落盘（60s 步长 = 4320 点） */
const KEEP_HOURS = 72
const MAX_POINTS = KEEP_HOURS * 60
const EPOCH_RE = /^\d{13}(?:\.\d+)?$/

const args = process.argv.slice(2)
const offline = args.includes('--offline')
const saveRaw = args.includes('--save-raw')
const countArg = args.find((a) => a.startsWith('--count='))
const limit = countArg ? Math.max(1, parseInt(countArg.split('=')[1], 10) || 8) : 8

/** ITC 历元 YYYYDDDHHMMSS.sss → Unix ms */
function parseEpoch(tok) {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(tok.trim())
  if (!m) return null
  const dayStart = Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * DAY_MS
  return dayStart + Math.round(((Number(m[3]) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000)
}

/** 从文件名提取名称与 NORAD */
function metaFromFileName(fileName) {
  const base = path.basename(fileName).replace(/\.txt$/i, '')
  const m = /^MEME_(\d+)_([A-Za-z0-9-]+)_/.exec(base)
  const name = m ? m[2] : base
  const num = /\b(\d{5})\b/.exec(name)
  const norad = num ? Number(num[1]) : m ? Number(m[1]) : 0
  return { name, norad }
}

/** 解析 ITC 文本，只取状态行（协方差行跳过） */
function parseItc(text, fileName) {
  const { name, norad } = metaFromFileName(fileName)
  const lines = text.split(/\r?\n/)
  let start = null
  let stop = null
  let stepSec = 60
  const rows = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^ephemeris_start/i.test(line)) {
      const times = line.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?/g) || []
      start = times[0] ? Date.parse(times[0].replace(' ', 'T') + 'Z') : null
      stop = times[1] ? Date.parse(times[1].replace(' ', 'T') + 'Z') : null
      const sm = /step_size\s*:\s*([\d.]+)/i.exec(line)
      if (sm) stepSec = Number(sm[1])
      continue
    }
    const toks = line.split(/\s+/)
    if (!EPOCH_RE.test(toks[0]) || toks.length < 7) continue
    const t = parseEpoch(toks[0])
    if (t === null) continue
    const nums = toks.slice(1, 7).map(Number)
    if (nums.some((n) => !Number.isFinite(n))) continue
    rows.push([t, ...nums])
  }

  rows.sort((a, b) => a[0] - b[0])
  if (!rows.length) throw new Error('未解析到状态行')
  const t0 = rows[0][0]
  const kept = rows.filter((r) => r[0] < t0 + KEEP_HOURS * 3600e3).slice(0, MAX_POINTS)
  return {
    norad,
    name,
    format: 'itc',
    start: start ?? kept[0][0],
    stop: stop ?? kept[kept.length - 1][0],
    stepSec,
    states: kept
  }
}

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.mkdirSync(RAW_DIR, { recursive: true })
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
}

/** 把一条样本写入磁盘，返回 index 条目 */
function writeSample(sample) {
  const file = `${sample.norad || 'X'}.json`
  const text = JSON.stringify(sample)
  fs.writeFileSync(path.join(OUT_DIR, file), text)
  console.log(
    `  ✓ ${sample.name} (NORAD ${sample.norad}) → ${file}  ${sample.states.length} 点  ${formatSize(Buffer.byteLength(text))}`
  )
  return { norad: sample.norad, name: sample.name, file, points: sample.states.length }
}

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return await res.text()
}

async function main() {
  ensureDirs()
  const index = []

  if (offline) {
    if (!fs.existsSync(RAW_DIR)) {
      console.error(`离线模式：未找到原始目录 ${RAW_DIR}`)
      process.exitCode = 1
      return
    }
    const files = fs
      .readdirSync(RAW_DIR)
      .filter((f) => f.toLowerCase().endsWith('.txt'))
      .sort()
      .slice(0, limit)
    if (!files.length) {
      console.error(`离线模式：${RAW_DIR} 下没有 .txt 原始星历（可用 --save-raw 联网时保存）`)
      process.exitCode = 1
      return
    }
    console.log(`离线模式：共 ${files.length} 个原始文件`)
    for (const f of files) {
      try {
        const text = fs.readFileSync(path.join(RAW_DIR, f), 'utf8')
        index.push(writeSample(parseItc(text, f)))
      } catch (e) {
        console.warn(`  ! ${f} 转换失败：${e.message}`)
      }
    }
  } else {
    console.log('下载 MANIFEST...')
    const manifest = await fetchText(BASE_URL + 'MANIFEST.txt')
    const all = manifest
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && s.toLowerCase().endsWith('.txt'))
    console.log(`清单共 ${all.length} 个文件，取前 ${limit} 个`)
    const picked = all.slice(0, limit)

    for (let i = 0; i < picked.length; i++) {
      const name = picked[i]
      process.stdout.write(`[${i + 1}/${picked.length}] ${name} ... `)
      try {
        const text = await fetchText(BASE_URL + name)
        const sample = parseItc(text, name)
        console.log(`下载 ${formatSize(Buffer.byteLength(text))}，保留 ${sample.states.length} 点`)
        if (saveRaw) fs.writeFileSync(path.join(RAW_DIR, name), text)
        index.push(writeSample(sample))
      } catch (e) {
        console.log(`失败：${e.message}（跳过）`)
      }
    }
  }

  const indexPath = path.join(OUT_DIR, 'index.json')
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))
  const total = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .reduce((sum, f) => sum + fs.statSync(path.join(OUT_DIR, f)).size, 0)
  console.log(`\n完成：${index.length}/${limit} 个样本，输出目录总大小 ${formatSize(total)}`)
  console.log(`索引：${indexPath}`)
  if (!index.length) process.exitCode = 1
}

main().catch((e) => {
  console.error('执行失败：', e)
  process.exitCode = 1
})
