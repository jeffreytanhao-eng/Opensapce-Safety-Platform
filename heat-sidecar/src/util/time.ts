/** 时间工具：本项目所有 DATETIME 均按 UTC 存取（探针结论见 sync/probe.ts） */

const MS_PER_DAY = 86_400_000

/** Date → 'YYYY-MM-DD HH:mm:ss'（UTC） */
export function fmtUtc(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** Date → 'YYYY-MM-DD HH:mm:ss.SSS'（UTC，毫秒精度） */
export function fmtUtcMs(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 23).replace('T', ' ')
}

/**
 * 解析时间字符串为 Date（UTC）。
 * 兼容：'2026-09-19 04:16:48.000000'、'2026-09-20T20:03:29.529'、带 Z 或 ±hhmm 偏移。
 * 无时区标记的按 UTC 处理（Space-Track 的口径）。
 */
export function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null
  const str = String(s).trim().replace(/\s+/g, ' ')
  if (!str) return null
  const m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      str
    )
  if (!m) {
    const d = new Date(str)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0,
    m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
  )
  let out = ms
  const tz = m[8]
  if (tz && tz !== 'Z' && tz !== 'z') {
    const sign = tz[0] === '-' ? -1 : 1
    const body = tz.slice(1).replace(':', '')
    out -= sign * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4))) * 60_000
  }
  return new Date(out)
}

/**
 * ITC 历元 `YYYYDDDHHMMSS.sss` → UTC Date。
 * 例：2026294100442.000 → 2026 年第 294 天 10:04:42 UTC。
 */
export function parseItcEpoch(tok: string): Date | null {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)$/.exec(tok.trim())
  if (!m) return null
  const year = Number(m[1])
  const doy = Number(m[2])
  const hh = Number(m[3])
  const mm = Number(m[4])
  const ss = Number(m[5])
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || !(ss < 61)) return null
  const dayStart = Date.UTC(year, 0, 1) + (doy - 1) * MS_PER_DAY
  return new Date(dayStart + Math.round(((hh * 60 + mm) * 60 + ss) * 1000))
}

/** TLE 第 1 行的历元（第 19–32 列）→ UTC Date */
export function tleEpochToDate(line1: string): Date | null {
  if (!line1 || line1.length < 32) return null
  const yy = Number(line1.slice(18, 20))
  const day = Number(line1.slice(20, 32))
  if (!Number.isFinite(yy) || !Number.isFinite(day) || day <= 0) return null
  const year = yy < 57 ? 2000 + yy : 1900 + yy
  return new Date(Date.UTC(year, 0, 1) + (day - 1) * MS_PER_DAY)
}

/** 年龄（小时），未来时间为负 */
export function ageHours(t: Date | null | undefined, now = new Date()): number | null {
  if (!t || Number.isNaN(t.getTime())) return null
  return (now.getTime() - t.getTime()) / 3_600_000
}

export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000)
}
