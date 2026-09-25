import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { isActiveJobStatus, MAX_FINISHED_JOBS, type JobSnapshot } from '../../shared/jobs'
export type { ClipArtifact, JobOutput } from '../../shared/job-output'
export type { JobSnapshot } from '../../shared/jobs'

export interface TranscriptionCost {
  provider: string
  model: string
  audio_duration_seconds: number
  estimated_cost_usd: number
  attempts?: number
}

export interface PlanningCost {
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated_cost_usd: number
  attempts: number
}

export interface LayoutVisionCost {
  provider: string
  model: string
  estimated_cost_usd: number
}

export interface ApiCosts {
  cost_incomplete?: boolean
  transcription?: TranscriptionCost
  planning?: PlanningCost
  layout_vision?: LayoutVisionCost
  total_estimated_cost_usd: number
}

/** A clipping job as the main process reports it. */
export type Job = JobSnapshot

interface JobState {
  jobs: Record<string, Job>
  /** The job the Jobs page shows in detail, or null for the list. */
  focusedJobId: string | null
  /** Apply a snapshot from the main process; older revisions are ignored. */
  upsert: (job: Job) => void
  /** Merge the main process's full list (startup, reload, reopened window). */
  hydrate: (jobs: Job[]) => void
  remove: (jobId: string) => void
  focusJob: (jobId: string | null) => void
}

function newer(current: Job | undefined, next: Job): boolean {
  return !current || next.revision >= current.revision
}

function bounded(jobs: Record<string, Job>, focusedJobId: string | null): Pick<JobState, 'jobs' | 'focusedJobId'> {
  const finished = Object.values(jobs).filter((job) => !isActiveJobStatus(job.status))
    .sort((a, b) => (b.finishedAt ?? b.queuedAt).localeCompare(a.finishedAt ?? a.queuedAt))
  for (const job of finished.slice(MAX_FINISHED_JOBS)) delete jobs[job.id]
  return { jobs, focusedJobId: focusedJobId && jobs[focusedJobId] ? focusedJobId : null }
}

export const useJobStore = create<JobState>((set) => ({
  jobs: {},
  focusedJobId: null,

  upsert: (job) => {
    set((state) => (newer(state.jobs[job.id], job)
      ? bounded({ ...state.jobs, [job.id]: job }, state.focusedJobId) : state))
  },

  hydrate: (list) => {
    set((state) => {
      const jobs = { ...state.jobs }
      for (const job of list) if (newer(jobs[job.id], job)) jobs[job.id] = job
      return bounded(jobs, state.focusedJobId)
    })
  },

  remove: (jobId) => {
    set((state) => {
      const jobs = { ...state.jobs }
      delete jobs[jobId]
      return { jobs, focusedJobId: state.focusedJobId === jobId ? null : state.focusedJobId }
    })
  },

  focusJob: (jobId) => set({ focusedJobId: jobId })
}))

export function isJobActive(job: Pick<Job, 'status'>): boolean {
  return isActiveJobStatus(job.status)
}

function byQueuedAt(a: Job, b: Job): number {
  return a.queuedAt.localeCompare(b.queuedAt)
}

/** Queued and running jobs, oldest first (the order they run in). */
export function useActiveJobs(): Job[] {
  return useJobStore(useShallow((state) => Object.values(state.jobs).filter(isJobActive).sort(byQueuedAt)))
}
