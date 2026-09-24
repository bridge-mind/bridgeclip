import { join } from 'path'
import { cancelJob as cancelRunningJob, startClipJob, type ClipJobConfig, type JobEventSink } from './pipeline-runner'
import { finishRunRecord } from './run-history'
import { logger } from './logger'
import { parseJobOutput } from '../shared/job-output'
import { isActiveJobStatus, MAX_FINISHED_JOBS, MAX_PARALLEL_JOBS, type JobSnapshot, type JobStatus } from '../shared/jobs'

/**
 * Every clipping job in this app session: queued, running and finished. Up to
 * MAX_PARALLEL_JOBS run at once, each in its own bridge process; the rest wait
 * in FIFO order. The renderer mirrors this list through `jobs:update`
 * snapshots, sent to whichever window is open at the time, so a reload or a
 * reopened window picks the jobs back up with `jobs:list`.
 */

interface TrackedJob {
  snapshot: JobSnapshot
  config: ClipJobConfig
  outputDirectory: string
}

const jobs = new Map<string, TrackedJob>()
const queue: string[] = []
/** Jobs whose bridge process has started and not yet exited. */
const running = new Set<string>()
let getSink: () => JobEventSink | null = () => null

export function initJobManager(windowGetter: () => JobEventSink | null): void {
  getSink = windowGetter
}

function broadcast(snapshot: JobSnapshot): void {
  const sink = getSink()
  if (sink && !sink.isDestroyed() && !sink.webContents.isDestroyed()) sink.webContents.send('jobs:update', snapshot)
}

function update(jobId: string, patch: Partial<Omit<JobSnapshot, 'id' | 'revision'>>): void {
  const job = jobs.get(jobId)
  if (!job) return
  job.snapshot = { ...job.snapshot, ...patch, revision: job.snapshot.revision + 1 }
  broadcast(job.snapshot)
}

function finish(jobId: string, status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>, patch: Partial<JobSnapshot> = {}): void {
  update(jobId, { ...patch, status, finishedAt: new Date().toISOString() })
  pruneFinished()
}

function pruneFinished(): void {
  const finished = [...jobs.values()].filter((job) => !isActiveJobStatus(job.snapshot.status))
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(job.snapshot.id)
}

/** Track a new job (its run record already exists) and start it as soon as a slot is free. */
export function enqueueJob(jobId: string, config: ClipJobConfig, outputDirectory: string): JobSnapshot {
  const snapshot: JobSnapshot = {
    id: jobId,
    revision: 0,
    request: config,
    status: 'queued',
    percent: 0,
    step: 'Waiting for a free slot',
    clipsDone: 0,
    clipsTotal: 0,
    error: null,
    errorHint: null,
    failureCode: null,
    failureStage: null,
    httpStatus: null,
    output: null,
    outputDir: join(outputDirectory, jobId),
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  }
  jobs.set(jobId, { snapshot, config, outputDirectory })
  queue.push(jobId)
  broadcast(snapshot)
  pump()
  return jobs.get(jobId)!.snapshot
}

function pump(): void {
  while (running.size < MAX_PARALLEL_JOBS && queue.length > 0) {
    const jobId = queue.shift()!
    const job = jobs.get(jobId)
    if (!job || job.snapshot.status !== 'queued') continue
    running.add(jobId)
    update(jobId, { status: 'pending', step: 'Starting…', startedAt: new Date().toISOString() })
    logger.info('jobs.start', { jobId, running: running.size, queued: queue.length })
    const sink: JobEventSink = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, payload) => onRunnerEvent(jobId, channel, payload) }
    }
    try {
      startClipJob(jobId, job.config, sink, () => onExit(jobId), job.outputDirectory)
    } catch {
      running.delete(jobId)
      try { finishRunRecord(job.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch { /* Output folder may be unavailable. */ }
      finish(jobId, 'failed', { error: 'Could not start this run.', step: 'Failed' })
    }
  }
}

function onExit(jobId: string): void {
  if (!running.delete(jobId)) return
  pump()
}

function onRunnerEvent(jobId: string, channel: string, payload: unknown): void {
  const job = jobs.get(jobId)
  if (!job || !isActiveJobStatus(job.snapshot.status)) return
  const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const number = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

  if (channel === 'job:progress') {
    const status = typeof data.status === 'string' && isActiveJobStatus(data.status) && data.status !== 'queued' ? data.status : job.snapshot.status
    update(jobId, {
      status,
      percent: Math.max(0, Math.min(100, number(data.percent, job.snapshot.percent))),
      step: typeof data.step === 'string' ? data.step : job.snapshot.step,
      clipsDone: number(data.clips_done, job.snapshot.clipsDone),
      clipsTotal: number(data.clips_total, job.snapshot.clipsTotal)
    })
  } else if (channel === 'job:complete') {
    const output = parseJobOutput(data.output)
    if (output) {
      finish(jobId, 'completed', { output, percent: 100, step: 'Complete', clipsDone: output.total_clips, clipsTotal: output.total_clips })
    } else {
      finish(jobId, 'failed', { error: 'The clipping engine returned an unsupported result.', step: 'Failed' })
    }
  } else if (channel === 'job:error') {
    finish(jobId, 'failed', {
      error: typeof data.message === 'string' ? data.message : 'The clipping engine stopped.',
      errorHint: typeof data.hint === 'string' ? data.hint : null,
      failureCode: typeof data.failureCode === 'string' ? data.failureCode : null,
      failureStage: typeof data.failureStage === 'string' ? data.failureStage : null,
      httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : null,
      step: 'Failed'
    })
  }
}

/** Cancel a queued or running job. Returns false when there is nothing to cancel. */
export function cancelTrackedJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || !isActiveJobStatus(job.snapshot.status)) return false
  if (job.snapshot.status === 'queued') {
    const index = queue.indexOf(jobId)
    if (index !== -1) queue.splice(index, 1)
    try { finishRunRecord(job.outputDirectory, jobId, 'cancelled') } catch { logger.warn('job.history.writeFailed', { jobId }) }
    finish(jobId, 'cancelled', { step: 'Cancelled' })
    return true
  }
  // The runner records the cancellation and stops the process group; its slot
  // frees when the process actually exits.
  if (!cancelRunningJob(jobId)) return false
  finish(jobId, 'cancelled', { step: 'Cancelled' })
  return true
}

/** Drop a finished job from this session's list (its run folder stays on disk). */
export function dismissJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || isActiveJobStatus(job.snapshot.status)) return false
  jobs.delete(jobId)
  return true
}

export function listJobs(): JobSnapshot[] {
  return [...jobs.values()].map((job) => job.snapshot).reverse()
}

/** Queued and running job IDs, so run history can tell live runs from interrupted ones. */
export function liveJobIds(): ReadonlySet<string> {
  return new Set([...jobs.values()].filter((job) => isActiveJobStatus(job.snapshot.status)).map((job) => job.snapshot.id))
}

/** On quit, queued jobs will never start: record them as cancelled rather than interrupted. */
export function cancelQueuedJobsForQuit(): void {
  for (const jobId of queue.splice(0)) {
    const job = jobs.get(jobId)
    if (!job) continue
    try { finishRunRecord(job.outputDirectory, jobId, 'cancelled') } catch { /* Quitting anyway. */ }
  }
}
