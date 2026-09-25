import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Clapperboard, Clock3, Download, FileText, Film, Gauge, Github, RotateCcw, ScrollText, Sparkles } from 'lucide-react'
import { cn, formatTimecode, sourceLabel } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { ISSUES_URL } from '../config/brand'
import type { Job } from '../store/use-job-store'
import { Page } from './ui/Page'
import { ProgressRing } from './ui/ProgressBar'
import { IconTile } from './ui/IconTile'
import { Button } from './ui/Button'

export const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  pending: 'Starting',
  downloading: 'Downloading',
  transcribing: 'Transcribing',
  planning: 'Finding moments',
  rendering: 'Rendering clips',
  uploading: 'Saving clips',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const STEPS = [
  { label: 'Download', icon: Download, statuses: ['downloading'] },
  { label: 'Transcribe', icon: FileText, statuses: ['transcribing'] },
  { label: 'Find moments', icon: Sparkles, statuses: ['planning'] },
  { label: 'Render', icon: Film, statuses: ['rendering', 'uploading'] }
]

function stepIndex(status: string): number {
  if (status === 'completed') return STEPS.length
  return STEPS.findIndex((s) => s.statuses.includes(status))
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

/** Small frosted capsule for a single fact under the progress ring. */
function InfoChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="glass-tile inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-xs tabular text-ink-muted [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-ink-subtle">
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
  const current = stepIndex(job.status)
  const queued = job.status === 'queued'
  const elapsed = useElapsed(job.startedAt ?? job.queuedAt, true)
  const pct = Math.round(Math.min(job.percent, 100))
  const source = job.request.videoUrl

  return (
    <Page width="focus">
      {leading && <div className="mb-2">{leading}</div>}
      <div className="text-center">
        <p className="eyebrow text-accent-hover">{queued ? 'Waiting in the queue' : 'Generating clips'}</p>
        <h1 className="mx-auto mt-1.5 max-w-[560px] truncate text-xl font-semibold tracking-[-0.025em] text-ink" title={source}>
          {sourceLabel(source)}
        </h1>
      </div>

      <section className="glass relative mt-5 overflow-hidden rounded-3xl px-5 pb-5 pt-6">
        <div className="relative flex flex-col items-center">
          <ProgressRing value={job.percent} size={168} stroke={9}>
            <p className="font-mono text-3xl font-medium tabular tracking-[-0.04em] text-ink">
              {pct}
              <span className="ml-0.5 text-xl text-ink-subtle">%</span>
            </p>
            <p className="mt-1.5 text-xs font-medium text-accent-hover">{STAGE_LABELS[job.status] ?? 'Working'}</p>
          </ProgressRing>

          <p className="mt-4 h-5 max-w-full truncate text-center text-sm text-ink-muted" aria-live="polite">
            {job.step}
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {(job.request.videoSpeed ?? 1) > 1 && (
              <InfoChip icon={<Gauge />}>{job.request.videoSpeed}× export speed</InfoChip>
            )}
            {job.clipsTotal > 0 && (
              <InfoChip icon={<Clapperboard />}>
                {job.clipsDone} of {job.clipsTotal} clip{job.clipsTotal === 1 ? '' : 's'} rendered
              </InfoChip>
            )}
            <InfoChip icon={<Clock3 />}>{formatTimecode(elapsed)} {queued ? 'waiting' : 'elapsed'}</InfoChip>
          </div>
        </div>

        <ol className="relative mt-6 flex items-start" aria-label="Progress">
          {STEPS.map((step, i) => {
            const done = current > i
            const active = current === i
            const Icon = step.icon
            return (
              <li key={step.label} className="flex flex-1 items-start last:flex-none">
                <div className="flex w-[84px] flex-col items-center gap-2.5">
                  <span
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full transition-[background,box-shadow,color] duration-300',
                      done &&
                        'bg-ink text-canvas shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_4px_14px_-4px_rgb(255_255_255/0.35)]',
                      active &&
                        'animate-pulse-ring bg-accent/25 text-accent-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.22),inset_0_0_0_1px_rgb(var(--accent)/0.6)]',
                      !done && !active && 'bg-black/25 text-ink-faint shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),inset_0_1px_2px_rgb(0_0_0/0.3)]'
                    )}
                    aria-current={active ? 'step' : undefined}
                  >
                    {done ? <Check className="h-4 w-4" strokeWidth={3} /> : <Icon className="h-4 w-4" />}
                  </span>
                  <span
                    className={cn(
                      'text-center text-2xs font-medium',
                      active ? 'text-ink' : done ? 'text-ink-muted' : 'text-ink-faint'
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className="mt-4 h-[3px] flex-1 overflow-hidden rounded-full bg-black/30 shadow-[inset_0_1px_1px_rgb(0_0_0/0.4)]">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
                      style={{ width: done ? '100%' : '0%' }}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </section>

      <div className="mt-4 flex items-center justify-between gap-4 px-1">
        <p className="text-xs leading-relaxed text-ink-subtle">
          {queued
            ? 'Starts automatically when a running job finishes.'
            : 'Long videos can take a while. Keep using BridgeClip or queue more videos; progress shows in the sidebar.'}
        </p>
        <Button onClick={onCancel}>{queued ? 'Remove from queue' : 'Cancel'}</Button>
      </div>
    </Page>
  )
}

export function JobFailure({ job, onRetry, leading }: { job: Job; onRetry: () => void; leading?: React.ReactNode }): React.JSX.Element {
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
        <pre
          className="glass-well max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-2xl px-3 py-3.5 font-mono text-xs leading-relaxed text-ink/90"
          data-selectable
        >
          {job.error || 'The clipping engine stopped without an error message.'}
        </pre>
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
