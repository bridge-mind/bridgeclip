import { app, clipboard } from 'electron'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { release } from 'os'
import { randomUUID } from 'crypto'
import { errorSummary, getLogFilePath } from './logger'
import type { CrashReport } from '../shared/crash-report'

const LABELS = {
  'main-error': 'App error', 'renderer-error': 'Interface error', 'renderer-crash': 'Interface crash',
  'child-crash': 'Background process crash', 'unexpected-exit': 'Unexpected shutdown'
} as const
type Kind = keyof typeof LABELS
type Environment = { app: string; electron: string; node: string; os: string; arch: string; packaged: boolean }
interface SavedReport { version: 1; session: string; recordedAt: string; kind: Kind; environment: Environment; name: string; code: string; frame: string; reason: string; exitCode: number | null; events: string[] }
const EVENTS = new Set(['app.boot', 'main.uncaughtException', 'main.unhandledRejection', 'jobs.start', 'job.start', 'job.preflight.failed', 'job.spawn.threw', 'job.spawned', 'job.bridge.outputLimit', 'job.bridge.invalidResult', 'job.bridge.error', 'job.spawn.error', 'job.close', 'job.failed', 'job.cancel', 'editor.worker.spawnFailed', 'editor.worker.failed', 'zernio.post.create.retry', 'zernio.post.uploaded', 'zernio.post.created', 'zernio.post.cancelled'])
const REASONS = new Set(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction', 'unknown'])
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const FRAME = /^(?:(?:main|preload)\.index\.js|renderer\.js):\d+(?::\d+)?$/
const version = (v: unknown): string => typeof v === 'string' && /^\d[\d.a-z+-]{0,40}$/i.test(v) ? v : 'unknown'
const file = (name: string): string => join(app.getPath('userData'), name)
let session = ''
let environment: Environment
let last: { kind: Kind; at: number } | null = null

/** Read a bounded regular file without following a symlink. Logs use only the tail. */
function read(path: string, limit: number, tail = false): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || !tail && stat.size > limit) throw new Error('Diagnostic file unavailable')
    const length = Math.min(limit, stat.size), buffer = Buffer.alloc(length)
    const used = readSync(fd, buffer, 0, length, tail ? stat.size - length : 0)
    return buffer.subarray(0, used).toString('utf8')
  } finally { closeSync(fd) }
}
function json(name: string): unknown { try { return JSON.parse(read(file(name), 32_768)) } catch { return null } }
function write(name: string, value: unknown): void {
  const temporary = file(`.diagnostics-${randomUUID()}.tmp`)
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file(name))
  } finally { try { unlinkSync(temporary) } catch { /* Already committed. */ } }
}
function safeEnvironment(raw: unknown): Environment {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Partial<Environment>
  return { app: version(e.app), electron: version(e.electron), node: version(e.node),
    os: typeof e.os === 'string' && /^(darwin|win32|linux) [\d.]+$/.test(e.os) ? e.os : 'unknown',
    arch: ['arm64', 'x64', 'ia32', 'arm', 'riscv64'].includes(e.arch ?? '') ? e.arch! : 'unknown', packaged: e.packaged === true }
}
function recentEvents(): string[] {
  try {
    return read(getLogFilePath(), 64 * 1024, true).split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line)
        return ISO.test(entry.ts) && ['info', 'warn', 'error'].includes(entry.level) && EVENTS.has(entry.event) ? [`${entry.ts} ${entry.level} ${entry.event}`] : []
      } catch { return [] }
    }).slice(-30)
  } catch { return [] }
}
function safeEvents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => {
    if (typeof value !== 'string') return false
    const [ts, level, event, extra] = value.split(' ')
    return !extra && ISO.test(ts) && ['info', 'warn', 'error'].includes(level) && EVENTS.has(event)
  }).slice(-30)
}
function savedReport(): SavedReport | null {
  const raw = json('crash-report.json') as Partial<SavedReport> | null
  if (!raw || raw.version !== 1 || !raw.kind || !Object.hasOwn(LABELS, raw.kind) || typeof raw.recordedAt !== 'string' || !ISO.test(raw.recordedAt)) return null
  const summary = errorSummary({ name: raw.name, code: raw.code })
  return { version: 1, session: typeof raw.session === 'string' && /^[a-f\d-]{36}$/.test(raw.session) ? raw.session : '',
    kind: raw.kind, recordedAt: raw.recordedAt, environment: safeEnvironment(raw.environment), ...summary,
    frame: typeof raw.frame === 'string' && FRAME.test(raw.frame) ? raw.frame : '',
    reason: REASONS.has(raw.reason ?? '') ? raw.reason! : '', exitCode: Number.isSafeInteger(raw.exitCode) ? raw.exitCode! : null, events: safeEvents(raw.events) }
}

/** No crash dumps or provider data leave the app. Reports contain allowlisted metadata only. */
export function recordCrash(kind: Kind, error?: unknown, details: { reason?: string; exitCode?: number } = {}): void {
  if (!session || last?.kind === kind && Date.now() - last.at < 10_000) return
  last = { kind, at: Date.now() }
  try {
    write('crash-report.json', { version: 1, session, recordedAt: new Date().toISOString(), kind, environment,
      ...errorSummary(error), reason: REASONS.has(details.reason ?? '') ? details.reason : '',
      exitCode: Number.isSafeInteger(details.exitCode) ? details.exitCode : null, events: recentEvents() })
  } catch { /* Diagnostics must not cause another crash. */ }
}
export function startCrashSession(): void {
  const previous = json('app-session.json') as { id?: string; environment?: Environment } | null
  session = randomUUID()
  last = null
  environment = safeEnvironment({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, os: `${process.platform} ${release()}`, arch: process.arch, packaged: app.isPackaged })
  if (previous?.id && /^[a-f\d-]{36}$/.test(previous.id) && savedReport()?.session !== previous.id) {
    const current = environment, currentSession = session
    session = previous.id
    environment = safeEnvironment(previous.environment)
    recordCrash('unexpected-exit')
    environment = current
    session = currentSession
  }
  try { write('app-session.json', { id: session, environment }) } catch { /* Read-only storage. */ }
}
export function endCrashSession(): void { try { unlinkSync(file('app-session.json')) } catch { /* Already gone. */ } }
export function getCrashReport(): CrashReport | null {
  const report = savedReport()
  if (!report) return null
  const e = report.environment
  const details = [report.name, report.code, report.frame, report.reason, report.exitCode !== null ? `Exit code: ${report.exitCode}` : ''].filter(Boolean).join(' · ')
  return { recordedAt: report.recordedAt, label: LABELS[report.kind], markdown: [
    '## What happened', 'Describe what you were doing when the problem occurred.', '',
    '## Steps to reproduce', '1. ', '2. ', '', '## Expected behavior', 'What should have happened?', '',
    '## Crash details', `- Event: ${LABELS[report.kind]}`, `- Recorded: ${report.recordedAt}`, `- BridgeClip: ${e.app} (${e.packaged ? 'packaged' : 'development'})`,
    `- System: ${e.os} (${e.arch})`, `- Electron: ${e.electron}; Node: ${e.node}`, `- Details: ${details}`,
    ...(report.kind === 'unexpected-exit' ? ['', 'The previous session did not shut down normally. This can also follow a forced quit or power loss; no crash stack was captured.'] : []),
    '', '## Recent app events', '```text', ...report.events, '```', '',
    'Generated locally. Raw error messages, API keys, media paths, URLs, and log context are excluded.'
  ].join('\n') }
}
export function copyCrashReport(expectedTimestamp?: unknown): boolean {
  const report = getCrashReport()
  if (!report || expectedTimestamp !== undefined && expectedTimestamp !== report.recordedAt) return false
  clipboard.writeText(report.markdown)
  return true
}
