import { execFile, spawn, type ChildProcess } from 'child_process'
import { constants, closeSync, createWriteStream, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'fs'
import { pipeline } from 'stream/promises'
import { delimiter, dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { EDITOR_REVISION_CONFLICT, editorFailureMessage, editorProgress, isEditorErrorCode, parseCandidateEdit, parseEditorProject, renderEditKey, type CandidateEdit, type EditorBatch, type EditorErrorCode, type EditorProgressSummary, type EditorProject, type EditorSession } from '../shared/clip-editor'
import { loadSettings, getSettingsForBridge } from './settings-store'
import { assertAbsolutePath, assertMediaPath, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, resolvePythonPath, runtimeEnvironment } from './pipeline-runner'
import { resolveBinary } from './tools'
import { logger } from './logger'

type WorkerAction = 'review' | 'export' | 'export-all' | 'scan-cameras' | 'replace-source'
interface EditorOperation { progress?: EditorSession['progress']; action: NonNullable<EditorSession['operation']>; child?: ChildProcess; cancelled?: boolean; abort?: AbortController; batch?: EditorBatch }
const operations = new Map<string, EditorOperation>()
export function editorBusy(path: string): boolean { return operations.has(realpathSync(path)) }
function runPath(path: unknown): string {
  assertAbsolutePath(path)
  const run = realpathSync(path as string), library = realpathSync(loadSettings().outputDirectory)
  if (dirname(run) !== library || lstatSync(path as string).isSymbolicLink()) throw new Error('Editor project is outside the library')
  return run
}
function readProject(run: string): ReturnType<typeof parseEditorProject> {
  const path = join(run, 'editor-project.json')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !isWithinDirectory(path, run)) throw new Error('Invalid editor file')
    const data = Buffer.alloc(stat.size + 1)
    let used = 0, count = 0
    do { count = readSync(fd, data, used, data.length - used, null); used += count } while (count && used < data.length)
    if (used !== stat.size) throw new Error('Editor project changed while reading')
    return parseEditorProject(JSON.parse(data.subarray(0, used).toString('utf8')))
  } finally { closeSync(fd) }
}
function writeProject(run: string, project: EditorProject): void {
  const data = JSON.stringify(project)
  if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('This editor project has too many caption edits to save')
  if (runPath(run) !== run) throw new Error('Editor folder changed')
  const temporary = join(run, `.editor-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(run, 'editor-project.json'))
  } finally { try { unlinkSync(temporary) } catch { /* Already committed. */ } }
}
function mediaNames(project: EditorProject): { source: string; preview: string } {
  const suffix = project.source_id ? `-${project.source_id}` : ''
  return { source: `editor-source${suffix}.mp4`, preview: `editor-preview${project.preview_id ? `-${project.preview_id}` : suffix}.mp4` }
}

const EDITOR_MEDIA = /^editor-(?:source|preview)(?:-[a-f0-9]{32})?\.mp4(?:\.partial\.mp4)?$/
/**
 * Remove leftovers of killed or cancelled operations: `.editor-*` temp files and
 * folders, and editor media the project does not reference. Runs only while no
 * editor operation owns the run, so nothing here can be in use by a worker.
 */
function sweepEditorFiles(run: string, project?: EditorProject): void {
  if (operations.has(run)) return
  let keep: Set<string> | null = null
  try {
    project ??= readProject(run)
    keep = new Set(project.media_freed ? [] : Object.values(mediaNames(project)))
  } catch { /* Unreadable state: keep all media, still remove temporary entries. */ }
  let entries: Dirent[]
  try { entries = readdirSync(run, { withFileTypes: true }) } catch { return }
  let removed = 0
  for (const entry of entries) {
    const temporary = entry.name.startsWith('.editor-')
    if (!temporary && !(keep && EDITOR_MEDIA.test(entry.name) && !keep.has(entry.name) && (entry.isFile() || entry.isSymbolicLink()))) continue
    try { rmSync(join(run, entry.name), { recursive: temporary && entry.isDirectory(), force: true }); removed++ } catch { /* A playing preview can stay open on Windows; retry next time. */ }
  }
  if (removed) logger.info('editor.sweep', { removed })
}

function mediaSize(paths: string[]): number {
  return paths.reduce((total, file) => { try { return total + statSync(file).size } catch { return total } }, 0)
}
/** Read-only storage inventory. Unlike openEditor, this never sweeps files. */
export function readEditorStorage(path: unknown): { revision: number; remaining: number; sourceBytes: number; previewBytes: number; reclaimableBytes: number } {
  const run = runPath(path), project = readProject(run)
  let sourceBytes = 0, previewBytes = 0, reclaimableBytes = 0
  const links = new Map<string, { size: number; links: number; seen: number }>()
  for (const name of readdirSync(run).filter(name => EDITOR_MEDIA.test(name)).sort()) {
    const file = join(run, name), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || dirname(realpathSync(file)) !== run) throw new Error('Editor media could not be checked safely.')
    const key = `${stat.dev}:${stat.ino}`
    const known = links.get(key)
    if (known) known.seen++
    else {
      links.set(key, { size: stat.size, links: stat.nlink, seen: 1 })
      if (name.startsWith('editor-source')) sourceBytes += stat.size
      else previewBytes += stat.size
    }
  }
  for (const file of links.values()) if (file.seen >= file.links) reclaimableBytes += file.size
  return { revision: project.revision, remaining: editorProgress(project.candidates).remaining, sourceBytes, previewBytes, reclaimableBytes }
}
export async function openEditor(path: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (!(await getJobOutput(run, loadSettings().outputDirectory))?.editor_project) throw new Error('This run has no editor project')
  const project = readProject(run), names = mediaNames(project)
  sweepEditorFiles(run, project)
  const operation = operations.get(run)
  const state = { progress: operation?.progress ? { ...operation.progress } : undefined, operation: operation?.action ?? null, batch: operation?.batch ? { ...operation.batch } : undefined }
  if (project.media_freed) return { project, sourcePath: '', previewPath: '', mediaBytes: 0, ...state }
  const sourcePath = join(run, names.source), previewPath = join(run, names.preview)
  for (const file of [sourcePath, previewPath]) {
    if (lstatSync(file).isSymbolicLink() || !isWithinDirectory(file, run)) throw new Error('Editor source is missing')
    assertMediaPath(file, loadSettings().outputDirectory)
  }
  return { project, sourcePath, previewPath, mediaBytes: mediaSize([sourcePath, previewPath]), ...state }
}

type ProgressCounts = Omit<EditorProgressSummary, 'operation' | 'batch' | 'progress'>
const progressCache = new Map<string, { mtimeMs: number; size: number; ino: number; summary: ProgressCounts }>()
/**
 * Status counts for Library cards, Jobs rows and editor polling. Unlike
 * openEditor, it sends no project to the renderer and re-reads the project
 * only when its file changes.
 */
export async function readEditorProgress(path: unknown): Promise<EditorProgressSummary> {
  const run = runPath(path)
  const stat = lstatSync(join(run, 'editor-project.json'))
  if (!stat.isFile()) throw new Error('This run has no editor project')
  let summary = progressCache.get(run)
  if (!summary || summary.mtimeMs !== stat.mtimeMs || summary.size !== stat.size || summary.ino !== stat.ino) {
    const project = readProject(run)
    const { remaining, initialCandidate } = editorProgress(project.candidates)
    const counts = { refining: 0, ready: 0, baked: 0, discarded: 0 }
    for (const c of project.candidates) counts[c.status]++
    let previewPath: string | null = project.media_freed ? null : join(run, mediaNames(project).preview)
    try { if (previewPath && (lstatSync(previewPath).isSymbolicLink() || !isWithinDirectory(previewPath, run))) previewPath = null } catch { previewPath = null }
    summary = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, summary: {
      total: project.candidates.length, remaining, initialCandidate, counts, previewPath,
      thumbnailMs: project.candidates[initialCandidate].ranges[0][0], mediaFreed: project.media_freed === true } }
    progressCache.delete(run)
    progressCache.set(run, summary)
    if (progressCache.size > 1000) progressCache.delete(progressCache.keys().next().value!)
  }
  const operation = operations.get(run)
  return { ...summary.summary, counts: { ...summary.summary.counts }, operation: operation?.action ?? null,
    ...(operation?.batch ? { batch: { ...operation.batch } } : {}), ...(operation?.progress ? { progress: { ...operation.progress } } : {}) }
}

const bakedHash = (c: CandidateEdit): string => createHash('sha256').update(renderEditKey(c)).digest('hex')
export async function saveEditor(path: unknown, revision: unknown, edits: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    const { project } = await openEditor(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error(EDITOR_REVISION_CONFLICT)
    if (project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    if (!Array.isArray(edits) || edits.length !== project.candidates.length) throw new Error('Invalid candidate edits')
    const clean = edits.map((c) => parseCandidateEdit(c, project.duration_ms, project.transcript.length))
    if (new Set(clean.map((c) => c.id)).size !== clean.length) throw new Error('Duplicate candidates')
    project.candidates = project.candidates.map((c) => {
      const edit = clean.find((e) => e.id === c.id)
      if (!edit) throw new Error('Candidate is missing')
      const next = { ...c, ...edit }
      if (edit.status === 'baked') {
        // Unchanged since its render, or restored to the exact render "Refine again" left.
        const unchanged = c.status === 'baked' ? renderEditKey(edit) === renderEditKey(c) : !!c.baked_hash && c.exports.length > 0 && bakedHash(edit) === c.baked_hash
        if (!unchanged) throw new Error('Only a completed render can mark a clip as baked')
        delete next.baked_hash
      } else if (c.status === 'baked') next.baked_hash = bakedHash(c)
      return next
    })
    project.revision++
    writeProject(run, project)
  } finally { operations.delete(run) }
  return openEditor(run)
}
/** Delete the source and preview once every clip is baked or discarded. The project becomes read-only. */
export async function freeEditorMedia(path: unknown, revision: unknown, beforeFree?: () => void): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    // Do not sweep anything until revision and cleanup approval have been checked.
    if (!(await getJobOutput(run, loadSettings().outputDirectory))?.editor_project) throw new Error('This run has no editor project')
    const project = readProject(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error(EDITOR_REVISION_CONFLICT)
    if (editorProgress(project.candidates).remaining) throw new Error('Bake or discard every clip before freeing editor media.')
    beforeFree?.()
    if (!project.media_freed) {
      project.media_freed = true
      project.revision++
      writeProject(run, project)
    }
  } finally { operations.delete(run) }
  sweepEditorFiles(run)
  logger.info('editor.mediaFreed')
  return openEditor(run)
}
function stop(child?: ChildProcess, force = false): void {
  if (!child?.pid) return
  try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => {}); else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Already exited. */ }
}
export function stopEditorsForQuit(): void { for (const op of operations.values()) { op.abort?.abort(); stop(op.child, true) } }
export function cancelEditor(path: unknown): void {
  const operation = operations.get(runPath(path))
  if (operation) operation.cancelled = true
  operation?.abort?.abort()
  const child = operation?.child
  stop(child)
  if (child) { const timer = setTimeout(() => stop(child, true), 3000); timer.unref(); child.once('close', () => clearTimeout(timer)) }
}
export async function replaceEditorSource(path: unknown, revision: unknown, replacement: unknown): Promise<EditorSession> {
  assertAbsolutePath(replacement)
  return executeEditor(path, revision, undefined, 'replace-source', replacement)
}
export async function runEditor(path: unknown, revision: unknown, candidateId: unknown, action: unknown): Promise<EditorSession> {
  if (action !== 'review' && action !== 'export' && action !== 'export-all' && action !== 'scan-cameras') throw new Error('Invalid editor operation')
  return executeEditor(path, revision, candidateId, action)
}

/** Worker output can contain private paths and keys: log only a short, redacted tail. */
function safeTail(stderr: string): Record<string, string> {
  const lines = stderr.split(/\r?\n/).map((line) => line
    .replace(/^\d{4}-\d{2}-\d{2} [\d:,.]+ - [\w.]+ - [A-Z]+ - /, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/g, '[key]')
    .replace(/\b(?:authorization|api[_ -]?key|token|password|secret|bearer)\b\S*\s*[:=]?\s*\S+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*/g, '[path]')
    .replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean).slice(-8)
  return Object.fromEntries(lines.map((line, i) => [`line${i + 1}`, line]))
}
/** Generous for long sources on CPU encoders, yet bounded if a worker hangs. */
const workerLimitMs = (durationMs: number): number => 30 * 60 * 1000 + 3 * durationMs

function runWorker(run: string, operation: EditorOperation, action: WorkerAction, env: Record<string, string | undefined>, python: string, limitMs: number, request: Record<string, unknown>): Promise<void> {
  const engine = env.PYTHONPATH!
  return new Promise<void>((resolve, reject) => {
    const child = spawn(python, [join(dirname(getBridgeRunnerPath()), 'editor_runner.py')],
      { cwd: engine, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    operation.child = child
    let stdout = '', stderr = '', settled = false, protocolFailed = false, timedOut = false
    let result: { ok: boolean; error?: unknown } | undefined
    const consume = (line: string): void => {
      if (!line.trim()) return
      if (line.length > 16384) { protocolFailed = true; stop(child); return }
      try {
        const value = JSON.parse(line)
        if (value?.type === 'progress') {
          if (action === 'scan-cameras' && (value.phase === 'scan' || value.phase === 'preview') &&
              typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) {
            const previous = operation.progress
            if (!previous || (previous.phase === 'scan' && value.phase === 'preview') ||
                (previous.phase === value.phase && value.percent >= previous.percent)) {
              operation.progress = { phase: value.phase, percent: Math.floor(value.percent) }
            }
          }
        } else if (typeof value?.ok === 'boolean' && !result) result = value
        else protocolFailed = true
      } catch { protocolFailed = true }
    }
    const timer = setTimeout(() => { timedOut = true; stop(child, true) }, limitMs)
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve() }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      let end: number
      while ((end = stdout.indexOf('\n')) >= 0) { consume(stdout.slice(0, end)); stdout = stdout.slice(end + 1) }
      if (stdout.length > 16384) { protocolFailed = true; stdout = ''; stop(child) }
    })
    // Keep a bounded tail for the log; it is redacted before it is written.
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8192) })
    child.on('error', (error) => {
      logger.error('editor.worker.spawnFailed', { action, errno: (error as NodeJS.ErrnoException).code ?? 'unknown' })
      finish(new Error('Could not start the editor engine. Open Settings and run System check.'))
    })
    child.on('close', (exitCode, signal) => {
      consume(stdout)
      if (exitCode === 0 && !protocolFailed && result?.ok === true) return finish()
      const code: EditorErrorCode | undefined = timedOut ? 'timeout' : operation.cancelled ? 'cancelled' : isEditorErrorCode(result?.error) ? result.error : undefined
      logger.warn('editor.worker.failed', { action, code: code ?? 'unknown', exitCode, signal, protocolFailed, ...safeTail(stderr) })
      finish(new Error(editorFailureMessage(action === 'export-all' ? 'export' : action, code)))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

const quote = (title: string): string => `“${title.length > 60 ? `${title.slice(0, 59)}…` : title}”`
class BatchError extends Error {}
/** Report a partial "Bake all": what finished, which clips failed and why, and what is still ready. */
function batchFailure(batch: EditorBatch, failed: { title: string; error: Error }[], cancelled: boolean, stoppedBy?: unknown): Error {
  const parts = [`Baked ${batch.completed} of ${batch.total} ready clips.`]
  if (failed.length) {
    const reasons = [...new Set(failed.map((f) => f.error.message))]
    parts.push(`Could not bake ${failed.slice(0, 3).map((f) => quote(f.title)).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}:`,
      reasons.length === 1 ? reasons[0] : `${reasons[0]} (and other errors)`)
  }
  if (cancelled) parts.push('Batch cancelled.')
  else if (stoppedBy !== undefined) parts.push(`Batch stopped: ${stoppedBy instanceof Error ? stoppedBy.message : 'Export failed.'}`)
  if (batch.completed < batch.total) parts.push('Clips that were not baked are still ready.')
  return new BatchError(parts.join(' '))
}
async function executeEditor(path: unknown, revision: unknown, candidateId: unknown, action: WorkerAction, replacement?: string): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action, ...(action === 'scan-cameras' ? { progress: { phase: 'scan', percent: 0 } as const } : {}) }
  operations.set(run, operation)
  const sourceId = action === 'replace-source' ? randomUUID().replaceAll('-', '') : undefined
  const previewId = action === 'scan-cameras' ? randomUUID().replaceAll('-', '') : undefined
  let previousPreview: string | undefined
  let previousMedia: string[] = []
  const failed: { title: string; error: Error }[] = []
  try {
    const session = await openEditor(run)
    if (session.project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    previousPreview = session.previewPath
    if (revision !== session.project.revision || (action !== 'export-all' && action !== 'replace-source' && !session.project.candidates.some((c) => c.id === candidateId))) throw new Error('Project changed. Reopen it and retry.')
    if (sourceId) {
      const media = await openAuthorizedMedia(replacement!, loadSettings().outputDirectory)
      operation.abort = new AbortController()
      try {
        if (operation.cancelled) throw new Error('Source replacement cancelled.')
        await pipeline(media.handle.createReadStream({ autoClose: false }), createWriteStream(join(run, `editor-source-${sourceId}.mp4`), { flags: 'wx', mode: 0o600 }), { signal: operation.abort.signal })
      } finally { await media.handle.close() }
      previousMedia = [session.sourcePath, session.previewPath]
    }
    if (action === 'export' && session.project.candidates.find((c) => c.id === candidateId)!.status !== 'ready') throw new Error('Mark this clip ready before baking it')
    const candidates = action === 'replace-source' ? session.project.candidates.slice(0, 1) : action === 'export-all' ? session.project.candidates.filter((c) => c.status === 'ready') : session.project.candidates.filter((c) => c.id === candidateId)
    if (!candidates.length) throw new Error('Mark at least one clip ready before baking.')
    if (action === 'export-all') operation.batch = { completed: 0, total: candidates.length }
    const settings = loadSettings(), engine = getEnginePath()
    if (action === 'review' && !settings.openrouterApiKey) throw new Error('Add your OpenRouter key in Settings to run this review.')
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge({ ...settings, jevEnabled: 'on' }), PYTHONPATH: engine, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }
    const ffmpeg = resolveBinary('ffmpeg')
    if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
    const python = resolvePythonPath(engine, settings.pythonPath), limitMs = workerLimitMs(session.project.duration_ms)
    for (const candidate of candidates) {
      if (operation.cancelled) break
      try {
        await runWorker(run, operation, action, env, python, limitMs, { run, library: realpathSync(settings.outputDirectory), revision, candidate_id: candidate.id, action: action === 'export-all' ? 'export' : action, source_id: sourceId, preview_id: previewId })
        if (operation.batch) operation.batch.completed++
      } catch (error) {
        // One failed clip must not strand the rest of "Bake all".
        if (action !== 'export-all' || operation.cancelled) throw error
        failed.push({ title: candidate.title, error: error as Error })
        operation.batch!.failed = failed.length
      } finally { operation.child = undefined }
      revision = readProject(run).revision
    }
    if (operation.batch && (operation.cancelled || failed.length)) throw batchFailure(operation.batch, failed, !!operation.cancelled)
    if (operation.cancelled) throw new Error(editorFailureMessage(action, 'cancelled'))
  } catch (error) {
    if (operation.batch && !(error instanceof BatchError)) throw batchFailure(operation.batch, failed, !!operation.cancelled, error)
    throw error
  } finally {
    if (previewId) {
      let active: string | undefined, readable = false
      try { active = readProject(run).preview_id; readable = true } catch { /* Preserve media if state is unreadable. */ }
      const stale = !readable ? [] : active === previewId ? (previousPreview ? [previousPreview] : [])
        : [join(run, `editor-preview-${previewId}.mp4`), join(run, `editor-preview-${previewId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* A playing preview can remain open on Windows. */ } }
    }
    if (sourceId) {
      // The JSON pointer switches both media files together. Never delete the active pair,
      // including when cancellation/worker exit races with the commit.
      let active: string | undefined, readable = false
      try { active = readProject(run).source_id; readable = true } catch { /* Preserve files if the project cannot be read. */ }
      const stale = !readable ? [] : active === sourceId ? previousMedia : [join(run, `editor-source-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* Open previews may remain until a later cleanup on Windows. */ } }
    }
    operations.delete(run)
    try { sweepEditorFiles(run) } catch { /* Cleanup is best effort. */ }
  }
  return openEditor(run)
}
// Keep IPC's editable surface narrow; no media paths, reviews or export records come from React.
export type { CandidateEdit }

let resumeAfterSave: (() => void) | null = null
/** Closing with unsaved edits: main asked the renderer to save, and resumes the close only after it succeeds. */
export function awaitEditorSaveBeforeClose(resume: () => void): void { resumeAfterSave = resume }
export function editorCloseReady(saved: unknown): void {
  const resume = resumeAfterSave
  resumeAfterSave = null
  if (saved === true && resume) setImmediate(resume)
}
