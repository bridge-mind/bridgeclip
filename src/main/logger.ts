import { app } from 'electron'
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

// Simple structured JSON-lines logger that writes to app.getPath('logs').
// On macOS that is ~/Library/Logs/BridgeClip/bridgeclip.log.
// On Windows that is %APPDATA%\BridgeClip\logs\bridgeclip.log.
//
// Why a custom logger instead of electron-log: zero new dependencies, and we
// only need info/warn/error + bounded rotation. Good enough for diagnostics.

const MAX_LOG_BYTES = 5 * 1024 * 1024 // 5 MB before rotation

let cachedLogFilePath: string | null = null

function resolveLogFilePath(): string {
  if (cachedLogFilePath) return cachedLogFilePath
  try {
    const dir = app.getPath('logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    cachedLogFilePath = join(dir, 'bridgeclip.log')
  } catch {
    // Fallback: write next to userData if getPath('logs') is unavailable.
    const dir = app.getPath('userData')
    cachedLogFilePath = join(dir, 'bridgeclip.log')
  }
  return cachedLogFilePath
}

export function getLogFilePath(): string {
  return resolveLogFilePath()
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return
    const stats = statSync(path)
    if (stats.size > MAX_LOG_BYTES) {
      renameSync(path, `${path}.old`)
    }
  } catch {
    // ignore rotation errors — logging must never throw
  }
}

type Level = 'info' | 'warn' | 'error'

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context ?? {})) {
    if (/path|url|secret|token|password|key|stack|message|error|hint|chunk|stdout|stderr|reason|resources|userData|logs|exec/i.test(key)) {
      safe[key] = '[omitted]'
    } else if (typeof value === 'string') {
      safe[key] = /https?:\/\/|[\\/]|[\r\n]|(?:token|secret|key)\s*[:=]/i.test(value) ? '[omitted]' : value.slice(0, 160)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      safe[key] = value
    } else {
      safe[key] = '[omitted]'
    }
  }
  return safe
}

/** Keep useful crash metadata without copying untrusted error text into logs. */
export function errorSummary(error: unknown): { name: string; code: string; frame: string } {
  const err = error && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown; stack?: unknown }
    : null
  const safeNames = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'])
  const safeCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOSPC', 'EPIPE'])
  // Stack paths, filenames and function names can themselves contain secrets.
  // Report a line only for a known, bundled application entry point.
  const frameLine = typeof err?.stack === 'string' ? err.stack.split('\n').find((line) => /^\s+at\s/.test(line)) ?? '' : ''
  const match = /(?:^|[\\/])out[\\/](main|preload)[\\/]index\.js:(\d+)(?::\d+)?\)?$/.exec(frameLine)
  return {
    name: typeof err?.name === 'string' && safeNames.has(err.name) ? err.name : 'Error',
    code: typeof err?.code === 'string' && safeCodes.has(err.code) ? err.code : '',
    frame: match ? `${match[1]}.index.js:${match[2]}` : ''
  }
}

function write(level: Level, event: string, context?: Record<string, unknown>): void {
  const safeContext = sanitizeContext(context)
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...safeContext
  }

  let line: string
  try {
    line = JSON.stringify(entry) + '\n'
  } catch {
    line = JSON.stringify({ ts: entry.ts, level, event, error: 'unserializable context' }) + '\n'
  }

  // Mirror to console so `npm run dev` still shows logs in the terminal.
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[${level}] ${event}`, safeContext)

  try {
    const path = resolveLogFilePath()
    rotateIfNeeded(path)
    appendFileSync(path, line, { encoding: 'utf-8', mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // If file writes fail, console output is the fallback. Never throw.
  }
}

export const logger = {
  info: (event: string, context?: Record<string, unknown>) => write('info', event, context),
  warn: (event: string, context?: Record<string, unknown>) => write('warn', event, context),
  error: (event: string, context?: Record<string, unknown>) => write('error', event, context)
}
