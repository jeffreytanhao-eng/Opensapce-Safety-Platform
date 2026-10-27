/** 极简分级日志：统一时间戳与级别前缀，便于容器日志排查 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let minLevel: LogLevel = 'info'

export function setLogLevel(level: string): void {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') minLevel = level
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return
  const line = `[${ts()}] [${level.toUpperCase()}] [${scope}] ${msg}`
  if (extra === undefined) {
    // eslint-disable-next-line no-console
    console.log(line)
  } else {
    // eslint-disable-next-line no-console
    console.log(line, extra)
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra)
  }
}
