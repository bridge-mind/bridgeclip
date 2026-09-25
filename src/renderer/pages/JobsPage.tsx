import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, FolderOpen, ListVideo, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import type { HistoryEntry } from '../../preload/index'
import { parseJobOutput } from '../../shared/job-output'
import { MAX_PARALLEL_JOBS } from '../../shared/jobs'
import { BackLink, ClipList } from '../components/ClipList'
import { JobFailure, JobProgress, STAGE_LABELS } from '../components/JobProgress'
import type { Page as AppPage } from '../components/Sidebar'
import { StatusDot } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { EmptyState } from '../components/ui/EmptyState'
import { TextInput } from '../components/ui/Field'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { ProgressRing } from '../components/ui/ProgressBar'
import { Skeleton } from '../components/ui/Skeleton'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatDate, formatDuration, formatRelativeDate, formatTimecode, formatUsd, sourceLabel } from '../lib/utils'
import { isJobActive, useActiveJobs, useJobStore, type Job, type JobOutput } from '../store/use-job-store'

type Filter = 'all' | HistoryEntry['status']

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'incomplete', label: 'Older unfinished' }
]

const STATUS: Record<HistoryEntry['status'], { label: string; tone: 'success' | 'accent' | 'danger' | 'warning' | 'neutral' }> = {
  completed: { label: 'Completed', tone: 'success' },
  running: { label: 'Running', tone: 'accent' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  incomplete: { label: 'Unfinished', tone: 'warning' }
}

/**
 * Clipping jobs: what is running or queued right now (live, from the main
 * process) and every earlier run in the output folder. Opening a job shows its
 * progress, its clips, or what went wrong.
 */
export function JobsPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const focusedJobId = useJobStore((s) => s.focusedJobId)
  const focused = useJobStore((s) => (s.focusedJobId ? s.jobs[s.focusedJobId] ?? null : null))
  const focusJob = useJobStore((s) => s.focusJob)
  const active = useActiveJobs()
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openRun, setOpenRun] = useState<{ entry: HistoryEntry; output: JobOutput } | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (manual = false) => {
    const request = ++requestId.current
    if (manual) setRefreshing(true)
    try {
      const result = await getApi().history.list()
      if (request === requestId.current) { setEntries(result); setError(null) }
    } catch (err) {
      if (request === requestId.current) {
        setEntries((previous) => previous ?? [])
        setError(errorMessage(err, 'Could not load previous jobs.'))
      }
    } finally {
      if (request === requestId.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 10000)
    return () => { window.clearInterval(timer); requestId.current++ }
  }, [load])

  // A job finishing moves it from Active to Previous; refresh the list then.
  const activeCount = active.length
  useEffect(() => { void load() }, [activeCount, load])

  // A focused job that was dismissed elsewhere falls back to the list.
  useEffect(() => {
    if (focusedJobId && !focused) focusJob(null)
  }, [focusedJobId, focused, focusJob])

  const cancel = async (job: Job): Promise<void> => {
    try {
      if (!await getApi().job.cancel(job.id)) setError('This job already finished.')
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel this job.'))
    }
  }

  const runAgain = async (job: Job): Promise<void> => {
    setError(null)
    try {
      const result = await getApi().job.start(job.request)
      if (result.error) setError(result.error)
      else if (result.jobId) focusJob(result.jobId)
    } catch (err) {
      setError(errorMessage(err, 'Could not start this job again.'))
    }
  }

  const openEntry = async (entry: HistoryEntry): Promise<void> => {
    setError(null)
    try {
      const output = parseJobOutput(await getApi().history.getJob(entry.outputDir))
      if (!output) { setError('This run’s saved clips are unavailable.'); return }
      setOpenRun({ entry, output })
      document.getElementById('page-scroll')?.scrollTo({ top: 0 })
    } catch (err) {
      setError(errorMessage(err, 'Could not open this run.'))
    }
  }

  const openFolder = async (outputDir: string): Promise<void> => {
    try {
      if (!await getApi().shell.openPath(outputDir)) setError('This run folder is unavailable.')
    } catch (err) {
      setError(errorMessage(err, 'Could not open this run folder.'))
    }
  }

  const back = <BackLink label="All jobs" onClick={() => { focusJob(null); setOpenRun(null) }} />
  const errorCallout = error && (
    <Page width="focus" className="pb-0">
      <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>
    </Page>
  )

  if (focused) {
    if (isJobActive(focused)) {
      return <>{errorCallout}<JobProgress job={focused} leading={back} onCancel={() => { void cancel(focused) }} /></>
    }
    if (focused.status === 'completed' && focused.output) {
      return <ClipList output={focused.output} outputDir={focused.outputDir} onNavigate={onNavigate} leading={back} />
    }
    if (focused.status === 'failed') {
      return <>{errorCallout}<JobFailure job={focused} leading={back} onRetry={() => { void runAgain(focused) }} /></>
    }
    return <>{errorCallout}<JobCancelled job={focused} leading={back} onRetry={() => { void runAgain(focused) }} /></>
  }

  if (openRun) {
    return <ClipList output={openRun.output} outputDir={openRun.entry.outputDir} onNavigate={onNavigate} leading={back} />
  }

  return (
    <JobsList
      active={active}
      entries={entries}
      filter={filter}
      query={query}
      error={error}
      refreshing={refreshing}
      onFilter={setFilter}
      onQuery={setQuery}
      onDismissError={() => setError(null)}
      onRefresh={() => { void load(true) }}
      onNew={() => onNavigate('clip')}
      onOpenJob={(job) => { focusJob(job.id); document.getElementById('page-scroll')?.scrollTo({ top: 0 }) }}
      onCancel={(job) => { void cancel(job) }}
      onOpenEntry={(entry) => {
        // This session's jobs open their live view; older runs load from disk.
        if (useJobStore.getState().jobs[entry.jobId]) focusJob(entry.jobId)
        else void openEntry(entry)
      }}
      onOpenFolder={(dir) => { void openFolder(dir) }}
    />
  )
}

function JobsList({ active, entries, filter, query, error, refreshing, onFilter, onQuery, onDismissError, onRefresh, onNew, onOpenJob, onCancel, onOpenEntry, onOpenFolder }: {
  active: Job[]
  entries: HistoryEntry[] | null
  filter: Filter
  query: string
  error: string | null
  refreshing: boolean
  onFilter: (filter: Filter) => void
  onQuery: (query: string) => void
  onDismissError: () => void
  onRefresh: () => void
  onNew: () => void
  onOpenJob: (job: Job) => void
  onCancel: (job: Job) => void
  onOpenEntry: (entry: HistoryEntry) => void
  onOpenFolder: (dir: string) => void
}): React.JSX.Element {
  const sessionJobs = useJobStore((s) => s.jobs)
  const liveIds = useMemo(() => new Set(active.map((job) => job.id)), [active])
  // Queued and running jobs show above; their disk records would duplicate them.
  const previous = useMemo(() => (entries ?? []).filter((entry) => !liveIds.has(entry.jobId) && entry.status !== 'running'), [entries, liveIds])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return previous.filter((entry) =>
      (filter === 'all' || entry.status === filter) &&
      (!q || entry.videoTitle.toLowerCase().includes(q) || entry.jobId.toLowerCase().includes(q)))
  }, [previous, filter, query])
  const counts = previous.reduce<Partial<Record<Filter, number>>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1
    return acc
  }, { all: previous.length })
  const running = active.filter((job) => job.status !== 'queued').length
  const queued = active.length - running
  const nothingYet = entries !== null && previous.length === 0 && active.length === 0

  return (
    <Page width="default">
      <PageHeader
        title="Jobs"
        className="items-center"
        actions={
          <>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh jobs"
              title="Refresh jobs"
              onClick={onRefresh}
              disabled={refreshing}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />}
            />
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={onNew}>New job</Button>
          </>
        }
      />

      <div className="mt-4 space-y-3">
        {error && <Callout tone="danger" onDismiss={onDismissError}>{error}</Callout>}

        {active.length > 0 && (
          <Panel padded={false} className="overflow-hidden">
            <section aria-label="Active jobs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] py-2 pl-4 pr-3">
                <SectionTitle label="Active" count={active.length} />
                <p className="text-2xs text-ink-subtle">
                  {running} running{queued > 0 && ` · ${queued} queued`} · up to {MAX_PARALLEL_JOBS} at once
                </p>
              </div>
              <ul className="divide-y divide-white/[0.05]">
                {active.map((job) => (
                  <ActiveJobRow
                    key={job.id}
                    job={job}
                    position={job.status === 'queued' ? active.filter((j) => j.status === 'queued').indexOf(job) + 1 : null}
                    onOpen={() => onOpenJob(job)}
                    onCancel={() => onCancel(job)}
                  />
                ))}
              </ul>
            </section>
          </Panel>
        )}

        {nothingYet ? (
          <EmptyState
            icon={<ListVideo />}
            title="No clipping jobs yet"
            description="Jobs appear here as soon as you generate clips. Queue as many videos as you like; up to two run at once."
            action={<Button variant="primary" onClick={onNew}>Create clips</Button>}
          />
        ) : (
          <Panel padded={false} className="overflow-hidden">
            <section aria-label="Previous jobs">
              <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] py-1.5 pl-4 pr-1.5">
                <SectionTitle label="Previous" count={previous.length} className="mr-auto" />
                {previous.length > 0 && (
                  <>
                    <div className="inline-flex flex-wrap items-center gap-0.5" role="group" aria-label="Filter jobs">
                      {FILTERS.filter((option) => option.id === 'all' || (counts[option.id] ?? 0) > 0).map((option) => {
                        const selected = filter === option.id
                        return (
                          <button
                            key={option.id}
                            onClick={() => onFilter(option.id)}
                            aria-pressed={selected}
                            className={cn(
                              'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-150',
                              selected ? 'bg-white/[0.1] text-ink' : 'text-ink-muted hover:bg-white/[0.05] hover:text-ink'
                            )}
                          >
                            {option.label}
                            <span className={cn('font-mono text-2xs tabular', selected ? 'text-ink-muted' : 'text-ink-faint')}>{counts[option.id] ?? 0}</span>
                          </button>
                        )
                      })}
                    </div>
                    <TextInput
                      className="w-44 rounded-full max-sm:w-full"
                      value={query}
                      onChange={(event) => onQuery(event.target.value)}
                      placeholder="Search jobs"
                      aria-label="Search jobs"
                      leading={<Search className="h-3.5 w-3.5" />}
                    />
                  </>
                )}
              </div>

              {entries === null ? (
                <ul className="divide-y divide-white/[0.05]" aria-busy="true" aria-label="Loading jobs">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <li key={i} className="flex h-10 items-center gap-3 px-4">
                      <Skeleton className="h-2 w-2 rounded-full" />
                      <Skeleton className="h-3 w-2/5 rounded-full" />
                      <Skeleton className="ml-auto h-3 w-24 rounded-full" />
                    </li>
                  ))}
                </ul>
              ) : previous.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-subtle">Finished jobs will appear here.</p>
              ) : visible.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-subtle">No jobs match this filter.</p>
              ) : (
                <ul className="divide-y divide-white/[0.05]">
                  {visible.map((entry) => (
                    <PreviousJobRow key={entry.jobId} entry={entry} hasDetails={Boolean(sessionJobs[entry.jobId])} onOpen={() => onOpenEntry(entry)} onOpenFolder={() => onOpenFolder(entry.outputDir)} />
                  ))}
                </ul>
              )}
            </section>
          </Panel>
        )}
      </div>
    </Page>
  )
}

function SectionTitle({ label, count, className }: { label: string; count: number; className?: string }): React.JSX.Element {
  return (
    <h2 className={cn('flex items-center gap-2', className)}>
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-2xs tabular text-ink-faint">{count}</span>
    </h2>
  )
}

function ActiveJobRow({ job, position, onOpen, onCancel }: { job: Job; position: number | null; onOpen: () => void; onCancel: () => void }): React.JSX.Element {
  const queued = job.status === 'queued'
  const since = job.startedAt ?? job.queuedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsed = Math.max(0, now - Date.parse(since))
  const stage = queued ? 'Queued' : STAGE_LABELS[job.status] ?? 'Working'
  const detail = queued ? 'Starts when a slot frees up' : job.step

  return (
    <li className="flex items-center pr-2 transition-colors duration-150 hover:bg-white/[0.025]">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 pr-3 text-left" title={job.request.videoUrl}>
        {queued ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.05] font-mono text-2xs tabular text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
            #{position}
          </span>
        ) : (
          <ProgressRing value={job.percent} size={32} stroke={3}>
            <span className="font-mono text-[9px] tabular text-accent-hover">{Math.round(job.percent)}%</span>
          </ProgressRing>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5 text-ink">{sourceLabel(job.request.videoUrl)}</span>
          <span className="block truncate text-xs text-ink-muted">
            <span className={queued ? 'text-ink-subtle' : 'text-accent-hover'}>{stage}</span>
            {detail && detail !== stage && ` · ${detail}`}
          </span>
        </span>
        {job.clipsTotal > 0 && (
          <span className="hidden shrink-0 text-right font-mono text-xs tabular text-ink-muted sm:block">
            {job.clipsDone}/{job.clipsTotal} <span className="font-sans">clips</span>
          </span>
        )}
        <span className="w-24 shrink-0 text-right text-xs text-ink-subtle">
          <span className="font-mono tabular">{formatTimecode(elapsed)}</span> {queued ? 'waiting' : 'elapsed'}
        </span>
      </button>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        aria-label={queued ? 'Remove from queue' : 'Cancel job'}
        title={queued ? 'Remove from queue' : 'Cancel job'}
        icon={queued ? <X className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
        onClick={onCancel}
        className="hover:bg-danger/10 hover:text-danger"
      />
    </li>
  )
}

const STATUS_DOT: Record<HistoryEntry['status'], 'success' | 'accent' | 'danger' | 'warning' | 'idle'> = {
  completed: 'success',
  running: 'accent',
  failed: 'danger',
  cancelled: 'idle',
  interrupted: 'warning',
  incomplete: 'warning'
}

const STATUS_TEXT: Record<HistoryEntry['status'], string> = {
  completed: 'text-success',
  running: 'text-accent-hover',
  failed: 'text-danger',
  cancelled: 'text-ink-subtle',
  interrupted: 'text-warning',
  incomplete: 'text-warning'
}

/** One line per run: status, title, then clips, run time, cost and date in aligned columns. */
function PreviousJobRow({ entry, hasDetails, onOpen, onOpenFolder }: { entry: HistoryEntry; hasDetails: boolean; onOpen: () => void; onOpenFolder: () => void }): React.JSX.Element {
  const status = STATUS[entry.status]
  const completed = entry.status === 'completed'
  // Failed and cancelled jobs from this session keep their options, so they can run again.
  const openable = completed || hasDetails
  const dated = !entry.date.startsWith('1970-')
  const cells = (
    <>
      <StatusDot tone={STATUS_DOT[entry.status]} />
      <span className="min-w-0 flex-1 truncate text-xs" title={entry.errorMessage ?? entry.videoTitle}>
        <span className="sr-only">{status.label}: </span>
        <span className="text-sm text-ink">{entry.videoTitle}</span>
        {!completed && <span className={cn('ml-2 font-medium', STATUS_TEXT[entry.status])} aria-hidden>{status.label}</span>}
        {entry.errorMessage && <span className="text-ink-subtle" data-selectable> · {entry.errorMessage}</span>}
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs text-ink-muted sm:block">
        {completed ? `${entry.clipCount} clip${entry.clipCount === 1 ? '' : 's'}` : ''}
      </span>
      <span className="hidden w-16 shrink-0 text-right font-mono text-2xs tabular text-ink-subtle md:block">
        {entry.durationMs != null ? formatDuration(entry.durationMs) : ''}
      </span>
      <span className="hidden w-14 shrink-0 text-right font-mono text-2xs tabular text-ink-subtle md:block">
        {entry.totalCostUsd != null ? formatUsd(entry.totalCostUsd) : ''}
      </span>
      <span className="w-28 shrink-0 text-right text-xs text-ink-subtle" title={dated ? formatDate(entry.date) : undefined}>
        {dated ? formatRelativeDate(entry.date) : 'Date unavailable'}
      </span>
    </>
  )
  const cellClass = 'flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 text-left'

  return (
    <li className={cn('group/row flex items-center pr-2 transition-colors duration-150', openable && 'hover:bg-white/[0.025]')}>
      {openable ? (
        <button onClick={onOpen} className={cellClass} title={completed ? 'View clips' : 'Details'}>{cells}</button>
      ) : (
        <div className={cellClass}>{cells}</div>
      )}
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        aria-label={`Open the folder for ${entry.videoTitle}`}
        title="Open folder"
        icon={<FolderOpen className="h-3.5 w-3.5" />}
        onClick={onOpenFolder}
        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
      />
    </li>
  )
}

function JobCancelled({ job, leading, onRetry }: { job: Job; leading: React.ReactNode; onRetry: () => void }): React.JSX.Element {
  return (
    <Page width="focus">
      <div className="mb-3">{leading}</div>
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">Job cancelled</h1>
      <p className="mt-1 truncate text-sm text-ink-muted" title={job.request.videoUrl}>{sourceLabel(job.request.videoUrl)}</p>
      <div className="mt-4">
        <Button variant="primary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onRetry}>Run again</Button>
      </div>
    </Page>
  )
}
