import { twitchVodId } from '../shared/video-source'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, isAbsolute, join, relative, sep } from 'path'
import { randomUUID } from 'crypto'

export type StoredRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunRecord {
  jobId: string
  startedAt: string
  finishedAt: string | null
  sourceLabel: string
  status: StoredRunStatus
  errorMessage: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
}

const RUN_FILE = 'run-history.json'
const MAX_RECORD_BYTES = 16 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function runDirectory(baseDir: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new Error('Invalid run identifier')
  return join(baseDir, jobId)
}

function checkedDirectory(baseDir: string, jobId: string): string {
  const dir = runDirectory(baseDir, jobId)
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid run directory')
  const rel = relative(realpathSync(baseDir), realpathSync(dir))
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Run is outside the output folder')
  return dir
}

function sourceLabel(source: string): string {
  const twitchId = twitchVodId(source)
  if (twitchId) return `Twitch VOD · ${twitchId}`.slice(0, 160)
  let label: string
  try {
    const url = new URL(source)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Local source')
    const host = url.hostname.toLowerCase()
    const videoId = (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch'
      ? url.searchParams.get('v') : null
    label = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? `YouTube · ${videoId}` : host
  } catch {
    label = basename(source)
  }
  return Array.from(label, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('').trim().slice(0, 160) || 'Video source'
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

export function readRunRecord(baseDir: string, jobId: string): RunRecord | null {
  let fd: number | null = null
  try {
    const dir = checkedDirectory(baseDir, jobId)
    const file = join(dir, RUN_FILE)
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null
    const fileStat = lstatSync(file)
    if (fileStat.isSymbolicLink() || fileStat.dev !== stat.dev || fileStat.ino !== stat.ino) return null
    const data: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!data || typeof data !== 'object') return null
    const record = data as Partial<RunRecord>
    if (record.jobId !== jobId || !validDate(record.startedAt) ||
        (record.finishedAt !== null && !validDate(record.finishedAt)) ||
        typeof record.sourceLabel !== 'string' || record.sourceLabel.length > 160 ||
        !['running', 'completed', 'failed', 'cancelled'].includes(record.status ?? '') ||
        (record.errorMessage !== null && (typeof record.errorMessage !== 'string' || record.errorMessage.length > 300)) ||
        (record.failureCode != null && (typeof record.failureCode !== 'string' || !/^[a-z]+(?:[._][a-z]+)*$/.test(record.failureCode) || record.failureCode.length > 64)) ||
        (record.failureStage != null && !['setup', 'download', 'transcription', 'planning', 'rendering', 'saving', 'uploading'].includes(record.failureStage)) ||
        (record.httpStatus != null && (!Number.isInteger(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599))) return null
    return record as RunRecord
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function writeRunRecord(baseDir: string, record: RunRecord): void {
  const dir = checkedDirectory(baseDir, record.jobId)
  const temp = join(dir, `${RUN_FILE}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temp, join(dir, RUN_FILE))
  } finally {
    try { unlinkSync(temp) } catch { /* The rename already moved it. */ }
  }
}

export function createRunRecord(baseDir: string, jobId: string, source: string): void {
  mkdirSync(runDirectory(baseDir, jobId), { recursive: true, mode: 0o700 })
  writeRunRecord(baseDir, {
    jobId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceLabel: sourceLabel(source),
    status: 'running',
    errorMessage: null
  })
}

export function finishRunRecord(baseDir: string, jobId: string, status: Exclude<StoredRunStatus, 'running'>, errorMessage: string | null = null,
  details: Pick<RunRecord, 'failureCode' | 'failureStage' | 'httpStatus'> = {}): void {
  const previous = readRunRecord(baseDir, jobId)
  if (!previous || previous.status !== 'running') return
  writeRunRecord(baseDir, { ...previous, status, finishedAt: new Date().toISOString(), errorMessage, ...details })
}
