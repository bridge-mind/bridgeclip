import { SourcePreview } from './SourcePicker'
import { JobDiagnostics } from './JobDiagnostics'
import { StageBreakdown } from './StageBreakdown'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Clapperboard, Clock3, Gauge, Github, RotateCcw, ScrollText, TextSearch } from 'lucide-react'
import { formatTimecode, sourceLabel } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { ISSUES_URL } from '../config/brand'
import type { Job } from '../store/use-job-store'
import { Page } from './ui/Page'
import { JobTimeline } from './JobTimeline'
import { IconTile } from './ui/IconTile'
import { Button } from './ui/Button'
import { JsonViewer } from './ui/JsonViewer'
import { inspectJsonValue } from '../lib/inspect-json'

export const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  pending: 'Starting',
  downloading: 'Downloading',
  contextualizing: 'Understanding the source',
  transcribing: 'Transcribing',
  planning: 'Finding moments',
  rendering: 'Rendering clips',
  uploading: 'Saving clips',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function useElapsed(since: string, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  return Math.max(0, now - new Date(since).getTime())
}

/** Small capsule for job metadata. */
function InfoChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="glass-tile inline-flex h-8 max-w-full items-center gap-2 rounded-full px-3.5 text-xs tabular text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-ink-subtle">
      {icon}
      {children}
    </span>
  )
}

interface JobProgressProps {
  job: Job
  onCancel: () => void
  /** Rendered above the title, e.g. a back link to the jobs list. */
  leading?: React.ReactNode
}

export function JobProgress({ job, onCancel, leading }: JobProgressProps): React.JSX.Element {
  const queued = job.status === 'queued'
  const elapsed = useElapsed(job.startedAt ?? job.queuedAt, true)
  const source = job.request.videoUrl
  const clipRequest = job.request.clipRequest?.trim()

  return (
    <Page width="narrow">
      {leading && <div className="mb-3">{leading}</div>}
      <section className="glass overflow-hidden rounded-3xl p-5 sm:p-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><p className="eyebrow text-accent">{queued ? 'Waiting in the queue' : 'In progress'}</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">{job.request.workflow === 'review' ? 'Preparing your editor' : 'Creating your clips'}</h1></div>
          <InfoChip icon={<Clock3 />}>{formatTimecode(elapsed)} {queued ? 'waiting' : 'elapsed'}</InfoChip>
        </header>
        <div className="mb-6"><SourcePreview key={source} source={source} readOnly /></div>
        {((job.request.videoSpeed ?? 1) > 1 || job.clipsTotal > 0 || clipRequest) && <div className="mb-5 flex flex-wrap items-center gap-2">
          {clipRequest && <InfoChip icon={<TextSearch />}><span className="min-w-0 truncate" title={clipRequest}><span className="sr-only">What to clip: </span>{clipRequest}</span></InfoChip>}
          {(job.request.videoSpeed ?? 1) > 1 && <InfoChip icon={<Gauge />}>{job.request.videoSpeed}× export speed</InfoChip>}
          {job.clipsTotal > 0 && <InfoChip icon={<Clapperboard />}>{job.clipsDone} of {job.clipsTotal} clips rendered</InfoChip>}
        </div>}
        <JobTimeline job={job} />
        <JobDiagnostics diagnostics={job.diagnostics} />
      </section>

      <div className="mt-4 flex items-center justify-between gap-4 px-1">
        <p className="text-xs leading-relaxed text-ink-subtle">
          {queued
            ? 'Starts automatically when a running job finishes.'
            : 'Keep creating. This job continues in the background.'}
        </p>
        <Button onClick={onCancel}>{queued ? 'Remove from queue' : 'Cancel'}</Button>
      </div>
    </Page>
  )
}

export function JobFailure({ job, onRetry, leading }: { job: Job; onRetry: () => void; leading?: React.ReactNode }): React.JSX.Element {
  const error = job.error || 'The clipping engine stopped without an error message.'
  const structuredError = useMemo(() => inspectJsonValue(error).encoded, [error])
  return (
    <Page width="focus">
      {leading && <div className="mb-3">{leading}</div>}
      <IconTile tone="danger" size="lg">
        <AlertTriangle />
      </IconTile>
      <h1 className="mt-3 text-xl font-semibold tracking-[-0.02em] text-ink">Clipping failed</h1>
      <p className="mt-1 truncate text-sm text-ink-muted" title={job.request.videoUrl}>
        {sourceLabel(job.request.videoUrl)}
      </p>

      <section className="glass mt-5 overflow-hidden rounded-3xl p-2">
        {structuredError ? <JsonViewer label="Engine error details" value={error} /> : <pre
          className="glass-well max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-2xl px-3 py-3.5 font-mono text-xs leading-relaxed text-ink/90"
          data-selectable
        >
          {error}
        </pre>}
        {job.errorHint && (
          <p className="px-3 pb-3 pt-3 text-sm leading-relaxed text-ink-muted" data-selectable>
            {job.errorHint}
          </p>
        )}
        {job.failureCode && (
          <p className="px-3 pb-3 font-mono text-xs text-ink-subtle" data-selectable>
            Failure code: {job.failureCode}{job.httpStatus ? ` · HTTP ${job.httpStatus}` : ''}
          </p>
        )}
      </section>

      {job.stages && <div className="mt-4"><StageBreakdown stages={job.stages} /></div>}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<RotateCcw className="h-4 w-4" />} onClick={onRetry}>
          Run again
        </Button>
        <Button icon={<ScrollText className="h-4 w-4" />} onClick={() => getApi().diagnostics.openLogFolder()}>
          Show logs
        </Button>
        <Button variant="ghost" icon={<Github className="h-4 w-4" />} onClick={() => getApi().shell.openPath(ISSUES_URL)}>
          Report an issue
        </Button>
      </div>
    </Page>
  )
}
