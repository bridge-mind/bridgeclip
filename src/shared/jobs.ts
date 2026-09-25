import type { JobOutput } from './job-output'

/** Options for one clipping run, as the Create wizard submits them. */
export interface ClipJobRequest {
  videoUrl: string
  /** Missing on older queued requests; those retain the original quality mode. */
  clippingMode?: 'quality' | 'economy'
  maxClips: number | null
  autoClipCount: boolean
  durationRanges: string[] | null
  aspectRatio: string
  layoutStyle: string
  layoutVision: boolean
  pacing: string
  /** Export speed for every clip. Older requests default to normal speed. */
  videoSpeed?: number
  includeCaptions: boolean
  captionPreset: string
  startTimeSeconds: number | null
  endTimeSeconds: number | null
  bannerPlatform: string | null
  bannerChannelUrl: string | null
}

/** How many clipping runs the main process lets run at once; the rest wait in a queue. */
export const MAX_PARALLEL_JOBS = 2
/** Finished runs retained in the live session; older runs remain on disk. */
export const MAX_FINISHED_JOBS = 50

export type ActiveJobStatus = 'queued' | 'pending' | 'downloading' | 'transcribing' | 'planning' | 'rendering' | 'uploading'
export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled'
export type JobStatus = ActiveJobStatus | TerminalJobStatus

export const ACTIVE_JOB_STATUSES: readonly ActiveJobStatus[] = ['queued', 'pending', 'downloading', 'transcribing', 'planning', 'rendering', 'uploading']

export function isActiveJobStatus(status: string): status is ActiveJobStatus {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status)
}

/**
 * A job as the main process tracks it. The main process owns the list and
 * pushes a fresh snapshot on every change (`jobs:update`); `revision` only goes
 * up, so the renderer can drop a snapshot that arrives after a newer one.
 */
export interface JobSnapshot {
  id: string
  revision: number
  request: ClipJobRequest
  status: JobStatus
  percent: number
  step: string
  clipsDone: number
  clipsTotal: number
  error: string | null
  /** Suggested fix, when the main process can tell what went wrong. */
  errorHint: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  output: JobOutput | null
  /** The run folder inside the output directory. */
  outputDir: string
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
}
