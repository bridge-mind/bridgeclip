import { ChildProcess, spawn, execFile, execFileSync } from 'child_process'
import { app } from 'electron'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'fs'
import { delimiter, dirname, join, resolve } from 'path'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { createInterface } from 'readline'
import { Transform } from 'stream'
import { loadSettings, getSettingsForBridge, vocabularyTerms } from './settings-store'
import { logger } from './logger'
import { parseJobOutput, type JobOutput } from '../shared/job-output'
import { BRIDGE_CONTRACT_VERSION } from '../shared/job-contract'
import type { ClipJobRequest } from '../shared/jobs'
import { finishRunRecord, type StoredRunStatus } from './run-history'
import { resolveBinary } from './tools'

export type ClipJobConfig = ClipJobRequest

/**
 * Where a run's events go. The job manager passes its own sink so it can track
 * every job; tests pass a stand-in window. A BrowserWindow also fits.
 */
export interface JobEventSink {
  isDestroyed: () => boolean
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }
}

export interface ProgressUpdate {
  type: 'progress'
  status: string
  percent: number
  step: string
  clips_done: number
  clips_total: number
}

export interface ResultUpdate {
  type: 'result'
  status: string
  job_id: string
  output: Record<string, unknown>
}

export interface ErrorUpdate {
  type: 'error'
  message: string
  hint?: string
  code?: string
  stage?: string
  http_status?: number
}

type BridgeMessage = ProgressUpdate | ResultUpdate | ErrorUpdate

function safeBridgeText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300 || /https?:\/\/|[\\/]|(?:token|secret|key)\s*[:=]/i.test(value)) {
    return 'The clipping engine could not complete this step.'
  }
  return value
}

/**
 * Rich error payload sent to the renderer on `job:error`. The renderer is
 * free to surface any subset of these fields; at minimum it should display
 * `message`. Old callers that only read `{ jobId, message }` still work.
 */
export interface JobErrorPayload {
  jobId: string
  message: string
  failureCode?: string
  failureStage?: string
  httpStatus?: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  errno?: string
  stderrTail?: string
  stdoutTail?: string
  pythonPath?: string
  bridgePath?: string
  enginePath?: string
  hint?: string
}

const activeProcesses = new Map<string, ChildProcess>()
const activeJobDirectories = new Map<string, string>()
const cancelledJobs = new Set<string>()
const pendingProcessGroups = new Set<number>()

function workRoot(): string {
  const root = join(app.getPath('userData'), 'work')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid clipping work directory')
  chmodSync(root, 0o700)
  return root
}

function cleanJobWork(jobId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return
  try {
    const root = workRoot()
    const jobPath = join(root, jobId)
    if (existsSync(jobPath)) rmSync(jobPath, { recursive: true, force: true })
  } catch { logger.warn('job.work.cleanupFailed', { jobId }) }
}

const MAX_DEV_ENGINE_LOG_BYTES = 5 * 1024 * 1024

/**
 * Development builds keep the engine's stderr in a private per-job log so a
 * failed run can be diagnosed. Packaged builds never write it: raw engine
 * output can contain provider URLs, credentials and local paths.
 */
function openDevEngineLog(jobId: string): { write: (data: Buffer) => void; close: () => void } {
  const disabled = { write: () => {}, close: () => {} }
  if (app.isPackaged || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) return disabled
  let fd: number
  try {
    const dir = join(app.getPath('logs'), 'engine')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    fd = openSync(join(dir, `${jobId}.log`), 'w', 0o600)
  } catch { return disabled }
  let written = 0
  let open = true
  logger.info('job.engineLog', { jobId })
  return {
    write(data) {
      if (!open || written >= MAX_DEV_ENGINE_LOG_BYTES) return
      const chunk = data.subarray(0, MAX_DEV_ENGINE_LOG_BYTES - written)
      try { written += writeSync(fd, chunk) } catch { open = false }
    },
    close() {
      if (!open) return
      open = false
      try { closeSync(fd) } catch { /* The log is best effort. */ }
    }
  }
}

/** Remove temporary media left by a worker terminated before Python cleanup. */
export function cleanStaleWorkspaces(): void {
  try {
    for (const entry of readdirSync(workRoot(), { withFileTypes: true })) {
      if (entry.isDirectory() && !activeProcesses.has(entry.name)) cleanJobWork(entry.name)
    }
  } catch { logger.warn('job.work.staleCleanupFailed') }
}

export function getEnginePath(): string {
  if (app.isPackaged) {
    return resolve(join(process.resourcesPath, 'engine'))
  }
  return resolve(join(__dirname, '..', '..', 'engine'))
}

/**
 * Resolve the path to bridge_runner.py.
 *
 * In a packaged app, the bridge directory is shipped via electron-builder's
 * `extraResources:` into `Contents/Resources/bridge/` on macOS (and the
 * equivalent on Windows/Linux). In development, `__dirname` points at
 * `out/main`, so we walk up two levels to the repo's `bridge/` directory.
 *
 * Without the packaged-app branch, `__dirname` inside `app.asar/out/main`
 * resolves to a path that does not exist, and `spawn()` fails with libuv
 * UV_ENOENT (surfaced as `code: -2` on the close event) with empty stderr.
 */
export function getBridgeRunnerPath(): string {
  if (app.isPackaged) {
    return resolve(join(process.resourcesPath, 'bridge', 'bridge_runner.py'))
  }
  return resolve(join(__dirname, '..', '..', 'bridge', 'bridge_runner.py'))
}

/**
 * Resolve the Python interpreter to use.
 *
 * Priority order:
 * 1. Explicit path from user settings (if set and not "python3")
 * 2. Bundled venv inside the app (packaged builds)
 * 3. In-repo engine venv python (engine/.venv/bin/python)
 * 4. System python3
 */
export function resolvePythonPath(enginePath: string, userPythonPath: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'engine-venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']))
  }
  if (!app.isPackaged && userPythonPath && userPythonPath !== 'python3') {
    if (existsSync(userPythonPath)) return userPythonPath
  }

  const venvCandidates: string[] = []

  venvCandidates.push(
    join(enginePath, 'venv', 'bin', 'python'),
    join(enginePath, 'venv', 'bin', 'python3'),
    join(enginePath, '.venv', 'bin', 'python'),
    join(enginePath, '.venv', 'bin', 'python3'),
    join(enginePath, 'venv', 'Scripts', 'python.exe'),
    join(enginePath, '.venv', 'Scripts', 'python.exe')
  )

  for (const candidate of venvCandidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return (!app.isPackaged && userPythonPath) || (process.platform === 'win32' ? 'python' : 'python3')
}

/**
 * Validate that the resolved Python can import the bundled clipping engine.
 * Returns { ok, python, error }.
 */
export async function validatePython(
  pythonPath: string,
  enginePath: string
): Promise<{ ok: boolean; python: string; error: string | null }> {
  try {
    await execFileAsync(
      pythonPath, ['-c', `
import cv2
from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION
from clip_engine.services.ai_clipping_pipeline import ClippingJobRequest
from clip_engine.services.layout_analyzer import LayoutAnalyzer
if BRIDGE_CONTRACT_VERSION != ${BRIDGE_CONTRACT_VERSION}:
    raise SystemExit('Incompatible clipping engine contract')
if not LayoutAnalyzer().available:
    raise SystemExit('Smart framing model is unavailable')
`],
      {
        cwd: enginePath,
        env: { ...runtimeEnvironment(), PYTHONPATH: enginePath },
        timeout: 10000
      }
    )
    return { ok: true, python: pythonPath, error: null }
  } catch {
    return { ok: false, python: pythonPath, error: 'The clipping engine is missing a required dependency, smart framing model, or compatible bridge contract.' }
  }
}

export interface PreflightResult {
  ok: boolean
  error?: string
  hint?: string
}

/**
 * Validate that everything needed to spawn the pipeline is in place BEFORE
 * calling spawn(). This turns cryptic `code -2: Unknown error` failures into
 * specific, actionable messages.
 */
export function preflightCheck(paths: {
  pythonPath: string
  bridgePath: string
  enginePath: string
}): PreflightResult {
  if (app.isPackaged) {
    const missing = (['ffmpeg', 'ffprobe', 'yt-dlp'] as const).find((name) => !existsSync(resolveBinary(name)))
    if (missing) return { ok: false, error: `Bundled ${missing} is missing.`, hint: 'Reinstall BridgeClip to repair the clipping tools.' }
  }
  if (!existsSync(paths.bridgePath)) {
    return {
      ok: false,
      error: `Bridge runner script not found at: ${paths.bridgePath}`,
      hint: app.isPackaged
        ? 'This is a BridgeClip packaging bug — bridge_runner.py is missing from the app bundle. Please reinstall or report this issue.'
        : 'Expected to find bridge/bridge_runner.py in the repo. Did you delete it?'
    }
  }
  if (!paths.enginePath || !existsSync(paths.enginePath)) {
    return {
      ok: false,
      error: `BridgeClip clipping engine not found at: ${paths.enginePath}`,
      hint: 'Reinstall BridgeClip or restore the engine/ directory in your source checkout.'
    }
  }
  if (!existsSync(join(paths.enginePath, 'clip_engine', 'bridge_contract.py'))) {
    return {
      ok: false,
      error: `BridgeClip clipping engine is incomplete at: ${paths.enginePath}`,
      hint: 'Reinstall BridgeClip or restore engine/clip_engine/bridge_contract.py in your source checkout.'
    }
  }
  // For absolute python paths, verify existence up-front. For bare commands
  // ("python3") we let spawn resolve via PATH, but we warn loudly because
  // macOS GUI-launched apps have a minimal PATH that excludes /opt/homebrew/bin
  // and /usr/local/bin, which is where most users' python3 lives.
  if (paths.pythonPath.includes('/') || paths.pythonPath.includes('\\')) {
    if (!existsSync(paths.pythonPath)) {
      return {
        ok: false,
        error: `Python interpreter not found at: ${paths.pythonPath}`,
        hint: 'Open Settings and set "Python Path" to an absolute path, or install the in-repo engine dependencies.'
      }
    }
  }
  return { ok: true }
}

/**
 * Runs one clipping job in its own bridge process. Events go to `sink`;
 * `onExit` fires once when the run no longer holds a process (after the bridge
 * exits, or right away when it could not start), so a queue can start the next.
 */
export function startClipJob(
  jobId: string,
  config: ClipJobConfig,
  sink: JobEventSink,
  onExit?: () => void,
  queuedOutputDirectory?: string
): void {
  const send = (channel: string, payload: unknown): void => {
    if (!sink.isDestroyed() && !sink.webContents.isDestroyed()) sink.webContents.send(channel, payload)
  }
  // Runs that never spawned a process still release their slot, just not
  // re-entrantly inside the caller's start.
  const exitWithoutProcess = (): void => { if (onExit) queueMicrotask(onExit) }
  // A queued job keeps the output folder chosen when its run record was
  // created, even if Settings changes before a worker slot opens.
  const settings = { ...loadSettings(), ...(queuedOutputDirectory ? { outputDirectory: queuedOutputDirectory } : {}) }
  const finishHistory = (status: Exclude<StoredRunStatus, 'running'>, message: string | null = null): void => {
    try { finishRunRecord(settings.outputDirectory, jobId, status, message) }
    catch { logger.warn('job.history.writeFailed', { jobId }) }
  }
  const reportError = (payload: JobErrorPayload): void => {
    try {
      finishRunRecord(settings.outputDirectory, jobId, 'failed', safeBridgeText(payload.message), {
        failureCode: payload.failureCode ?? null,
        failureStage: payload.failureStage ?? null,
        httpStatus: payload.httpStatus ?? null
      })
    } catch { logger.warn('job.history.writeFailed', { jobId }) }
    send('job:error', payload)
  }
  const envVars = getSettingsForBridge(settings)
  const enginePath = getEnginePath()
  const bridgePath = getBridgeRunnerPath()
  const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

  logger.info('job.start', {
    jobId,
    sourceType: config.videoUrl.startsWith('http') ? 'remote' : 'local',
    maxClips: config.maxClips,
    autoClipCount: config.autoClipCount,
    aspectRatio: config.aspectRatio,
    captionPreset: config.captionPreset,
    envKeys: Object.keys(envVars),
    isPackaged: app.isPackaged
  })

  // Pre-flight: fail fast with an actionable error instead of letting spawn
  // fail with a cryptic libuv errno on the close event.
  const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
  if (!preflight.ok) {
    logger.error('job.preflight.failed', {
      jobId,
      reason: 'runtime-missing'
    })
    const payload: JobErrorPayload = {
      jobId,
      message: preflight.hint ? `${preflight.error}\n\n${preflight.hint}` : preflight.error!,
      pythonPath,
      bridgePath,
      enginePath,
      hint: preflight.hint
    }
    reportError(payload)
    exitWithoutProcess()
    return
  }

  const jobConfig = JSON.stringify({
    contract_version: BRIDGE_CONTRACT_VERSION,
    job_id: jobId,
    video_url: config.videoUrl,
    clipping_mode: config.clippingMode ?? 'quality',
    max_clips: config.maxClips,
    auto_clip_count: config.autoClipCount,
    duration_ranges: config.durationRanges,
    aspect_ratio: config.aspectRatio,
    layout_style: config.layoutStyle || 'auto',
    layout_vision_enabled: config.clippingMode === 'economy' ? false : config.layoutVision,
    pacing: config.pacing || 'tight',
    include_captions: config.includeCaptions,
    caption_preset: config.captionPreset,
    keyterms: vocabularyTerms(settings.customVocabulary),
    start_time_seconds: config.startTimeSeconds,
    end_time_seconds: config.endTimeSeconds,
    banner_platform: config.bannerPlatform,
    banner_channel_url: config.bannerChannelUrl,
    output_dir: settings.outputDirectory
  })

  let jobWorkRoot: string
  try { jobWorkRoot = workRoot() }
  catch {
    reportError({ jobId, message: 'BridgeClip could not create a private temporary work folder.' })
    exitWithoutProcess()
    return
  }

  const spawnEnv: Record<string, string | undefined> = {
    ...runtimeEnvironment(),
    ...envVars,
    PYTHONPATH: enginePath,
    BRIDGECLIP_WORK_ROOT: jobWorkRoot,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  }

  const ffmpeg = resolveBinary('ffmpeg')
  if (ffmpeg !== 'ffmpeg') {
    const binDir = dirname(ffmpeg)
    const existingPath = spawnEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
    spawnEnv.PATH = `${binDir}${delimiter}${existingPath}`
  }

  let child: ChildProcess
  try {
    child = spawn(pythonPath, [bridgePath], {
      cwd: enginePath,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
  } catch (err) {
    logger.error('job.spawn.threw', { jobId, errorType: err instanceof Error ? err.name : 'unknown' })
    const payload: JobErrorPayload = {
      jobId,
      message: 'Failed to start the clipping engine. Check the system setup and retry.'
    }
    reportError(payload)
    exitWithoutProcess()
    return
  }

  child.stdin?.on('error', () => { /* Process close/error reports startup failures. */ })
  child.stdin?.end(jobConfig)

  logger.info('job.spawned', { jobId, pid: child.pid })

  activeProcesses.set(jobId, child)
  activeJobDirectories.set(jobId, settings.outputDirectory)

  let stderrBytes = 0
  let stdoutNonJsonLines = 0
  const engineLog = openDevEngineLog(jobId)
  let errored = false
  let completed = false
  let pendingOutput: JobOutput | null = null
  const startedAt = Date.now()

  const MAX_BRIDGE_LINE_BYTES = 1024 * 1024
  const MAX_BRIDGE_TOTAL_BYTES = 32 * 1024 * 1024
  let bridgeBytes = 0
  let lineBytes = 0
  let progressWindowStart = Date.now()
  let progressInWindow = 0
  const failBridgeLimit = (): void => {
    if (errored || completed) return
    errored = true
    logger.error('job.bridge.outputLimit', { jobId })
    reportError({ jobId, message: 'The clipping engine produced too much output and was stopped.' })
    terminateProcessTree(child, true)
  }
  const boundedStdout = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bridgeBytes += chunk.length
      let segmentStart = 0
      for (let lineEnd = chunk.indexOf(10, segmentStart); lineEnd !== -1; lineEnd = chunk.indexOf(10, segmentStart)) {
        lineBytes += lineEnd - segmentStart
        if (lineBytes > MAX_BRIDGE_LINE_BYTES) break
        lineBytes = 0
        segmentStart = lineEnd + 1
      }
      lineBytes += chunk.length - segmentStart
      if (bridgeBytes > MAX_BRIDGE_TOTAL_BYTES || lineBytes > MAX_BRIDGE_LINE_BYTES) {
        failBridgeLimit()
        callback()
        return
      }
      callback(null, chunk)
    }
  })
  const lines = child.stdout ? createInterface({ input: child.stdout.pipe(boundedStdout), crlfDelay: Infinity }) : null
  lines?.on('line', (line: string) => {
    if (!line.trim() || errored || completed || cancelledJobs.has(jobId)) return
    {
      try {
        const msg: BridgeMessage = JSON.parse(line)
        if (msg.type === 'progress') {
          const now = Date.now()
          if (now - progressWindowStart >= 1000) { progressWindowStart = now; progressInWindow = 0 }
          if (++progressInWindow > 50) { failBridgeLimit(); return }
          send('job:progress', { type: 'progress', jobId, status: safeBridgeText(msg.status), step: safeBridgeText(msg.step),
            percent: Number.isFinite(msg.percent) ? msg.percent : 0,
            clips_done: Number.isFinite(msg.clips_done) ? msg.clips_done : 0,
            clips_total: Number.isFinite(msg.clips_total) ? msg.clips_total : 0 })
        } else if (msg.type === 'result') {
          const output = parseJobOutput(msg.output)
          if (output && !pendingOutput && msg.status === 'completed' && msg.job_id === jobId && output.job_id === jobId) {
            // The result line can arrive before Python exits. A successful exit
            // confirms the engine finished its cleanup and committed the run.
            pendingOutput = output
          } else {
            errored = true
            logger.error('job.bridge.invalidResult', { jobId })
            reportError({ jobId, message: 'The clipping engine returned an unsupported result.' })
          }
        } else if (msg.type === 'error') {
          errored = true
          const failureCode = typeof msg.code === 'string' && msg.code.length <= 64 && /^[a-z]+(?:[._][a-z]+)*$/.test(msg.code) ? msg.code : undefined
          const failureStage = typeof msg.stage === 'string' && ['setup', 'download', 'transcription', 'planning', 'rendering', 'saving', 'uploading'].includes(msg.stage) ? msg.stage : undefined
          const httpStatus = typeof msg.http_status === 'number' && Number.isInteger(msg.http_status) && msg.http_status >= 100 && msg.http_status <= 599 ? msg.http_status : undefined
          logger.error('job.bridge.error', { jobId, failureCode: failureCode ?? 'unknown', failureStage: failureStage ?? 'unknown', httpStatus: httpStatus ?? null })
          const payload: JobErrorPayload = {
            jobId,
            message: safeBridgeText(msg.message),
            hint: msg.hint ? safeBridgeText(msg.hint) : undefined,
            failureCode,
            failureStage,
            httpStatus
          }
          reportError(payload)
        }
      } catch {
        // Raw child output can contain credentials, private URLs, and local paths.
        stdoutNonJsonLines++
      }
    }
  })

  child.stderr?.on('data', (data: Buffer) => {
    stderrBytes += data.length
    engineLog.write(data)
  })

  child.on('error', (err) => {
    engineLog.close()
    if (cancelledJobs.has(jobId)) return
    errored = true
    const errno = (err as NodeJS.ErrnoException).code
    const hint =
      errno === 'ENOENT'
        ? 'The Python interpreter or bridge script was not found. Open Settings and run System check.'
        : undefined

    logger.error('job.spawn.error', {
      jobId,
      errno,
      errorType: err.name
    })

    const payload: JobErrorPayload = {
      jobId,
      message: 'Failed to start the clipping engine.',
      errno,
      hint
    }
    reportError(payload)
  })

  child.on('close', (code, signal) => {
    activeProcesses.delete(jobId)
    activeJobDirectories.delete(jobId)
    engineLog.close()
    try {
      reportClose(code, signal)
    } finally {
      cleanJobWork(jobId)
      onExit?.()
    }
  })

  function reportClose(code: number | null, signal: NodeJS.Signals | null): void {
    const durationMs = Date.now() - startedAt
    logger.info('job.close', {
      jobId,
      code,
      signal,
      durationMs,
      stderrBytes,
      stdoutNonJsonLines,
      errored
    })

    // If the 'error' event already fired, its handler already reported the
    // failure to the renderer with a more specific message. Do not clobber
    // it by emitting a second job:error with the cryptic libuv errno that
    // Node passes through as `code` on spawn failure.
    if (cancelledJobs.delete(jobId) || errored) return
    if (code === 0 && pendingOutput) {
      completed = true
      finishHistory('completed')
      send('job:complete', { type: 'result', status: 'completed', jobId, job_id: jobId, output: pendingOutput })
      return
    }

    let message: string
    let hint: string | undefined

    if (signal) {
      message = `Pipeline was killed by signal ${signal}. This usually means the process ran out of memory or was terminated by the system.`
    } else if (code === null) {
      message = 'Pipeline terminated unexpectedly with no exit code.'
    } else if (typeof code === 'number' && code < 0) {
      // Negative codes on POSIX close events come from libuv errnos when
      // uv_spawn itself failed. -2 == UV_ENOENT.
      message = `Pipeline failed to start (libuv errno ${code}). The Python interpreter or bridge script could not be spawned.`
      hint = 'Open Settings and run System check.'
    } else {
      message = `Pipeline exited with code ${code}.`
    }

    logger.error('job.failed', {
      jobId,
      code,
      signal,
      stderrBytes,
      stdoutNonJsonLines,
      durationMs
    })

    const payload: JobErrorPayload = {
      jobId,
      message,
      exitCode: code,
      signal,
      hint
    }
    reportError(payload)
  }
}

export function cancelJob(jobId: string): boolean {
  const proc = activeProcesses.get(jobId)
  if (proc) {
    if (cancelledJobs.has(jobId)) return true
    logger.info('job.cancel', { jobId, pid: proc.pid })
    cancelledJobs.add(jobId)
    const outputDir = activeJobDirectories.get(jobId)
    if (outputDir) {
      try { finishRunRecord(outputDir, jobId, 'cancelled') }
      catch { logger.warn('job.history.writeFailed', { jobId }) }
    }
    if (process.platform !== 'win32' && proc.pid) pendingProcessGroups.add(proc.pid)
    const timeout = setTimeout(() => {
      if (activeProcesses.get(jobId) === proc || (proc.pid && pendingProcessGroups.has(proc.pid))) terminateProcessTree(proc, true)
      if (proc.pid) pendingProcessGroups.delete(proc.pid)
    }, 5000)
    timeout.unref()
    proc.once('close', () => {
      if (process.platform === 'win32' || !proc.pid || !isProcessGroupAlive(proc.pid)) {
        clearTimeout(timeout)
        if (proc.pid) pendingProcessGroups.delete(proc.pid)
      }
    })
    terminateProcessTree(proc, false)
    return true
  }
  return false
}

export function hasActiveJobs(): boolean {
  return activeProcesses.size > 0 || pendingProcessGroups.size > 0
}

export function getActiveJobIds(): ReadonlySet<string> {
  return new Set(activeProcesses.keys())
}

export function cancelAllJobs(): void {
  for (const jobId of activeProcesses.keys()) cancelJob(jobId)
}

/** App exit must not leave detached media processes running after Electron exits. */
export function stopAllJobsForQuit(): void {
  const pids = new Set([...activeProcesses.values()].map((child) => child.pid).filter((pid): pid is number => Boolean(pid)))
  for (const pid of pendingProcessGroups) pids.add(pid)
  for (const pid of pids) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }) } catch { /* Already exited. */ }
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { /* Group already exited. */ }
    }
  }
  pendingProcessGroups.clear()
}

function isProcessGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function runtimeEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {}
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) environment[key] = process.env[key]
  }
  return environment
}

function terminateProcessTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { timeout: 5000, windowsHide: true }, () => {})
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Group already exited. */ }
  }
}
