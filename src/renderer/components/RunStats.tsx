import { useEffect, useState, type ReactNode } from 'react'
import { CalendarClock, Clapperboard, CircleDollarSign, Info, Timer } from 'lucide-react'
import { formatDuration, formatTimecode, formatUsd } from '../lib/utils'
import type { ApiCosts, JobOutput } from '../store/use-job-store'
import { comparisonDurationSeconds, formatTimes, OPUS_CLIP, opusClipCostUsd, opusClipCredits, percentLessThanOpusClip, timesFasterThanOpusClip } from '../config/opus-clip'
import { OpusClipLogo } from './brand/OpusClipLogo'
import { HoverCard } from './ui/HoverCard'
import { IconTile } from './ui/IconTile'

/** Cells enter one after another; numbers count up once their cell is in. */
const STAGGER_MS = 70
const COUNT_MS = 700

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Counts from 0 to `target` once, easing out, starting after `delay` ms. */
function useCountUp(target: number, delay: number): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0))
  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target)
      return
    }
    let frame = 0
    const start = performance.now() + delay
    const tick = (now: number): void => {
      const t = Math.min(1, Math.max(0, (now - start) / COUNT_MS))
      setValue(t >= 1 ? target : target * (1 - (1 - t) ** 3))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    // A hidden or throttled window may never paint a frame; the number still lands.
    const settle = window.setTimeout(() => setValue(target), delay + COUNT_MS + 100)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(settle)
    }
  }, [target, delay])
  return value
}

interface RunStatsProps {
  output: JobOutput
  costs: ApiCosts | null
  /** Export speed when clips were sped up. */
  videoSpeed: number | null
}

/**
 * The run at a glance, with published OpusClip price and time references.
 */
export function RunStats({ output, costs, videoSpeed }: RunStatsProps): React.JSX.Element {
  const clips = output.total_clips
  const topScore = output.clips.reduce((best, clip) => Math.max(best, clip.virality_score), 0) * 10
  const sourceSeconds = output.source_video_duration_seconds
  const processingMs = output.processing_time_seconds * 1000
  const created = output.created_at && Number.isFinite(Date.parse(output.created_at)) ? new Date(output.created_at) : null

  const clipCount = Math.round(useCountUp(clips, 0))
  const processing = useCountUp(processingMs, STAGGER_MS)
  const cost = useCountUp(costs?.total_estimated_cost_usd ?? 0, STAGGER_MS * 2)

  // Price comparisons require a known analysis window and a complete cost.
  const exactCost = costs && !costs.cost_incomplete ? costs.total_estimated_cost_usd : null
  const analysisSeconds = comparisonDurationSeconds(sourceSeconds, output.metrics?.analysis_duration_seconds)
  const percentLess = exactCost !== null && analysisSeconds !== null ? percentLessThanOpusClip(exactCost, analysisSeconds) : null
  const theirCost = analysisSeconds !== null ? opusClipCostUsd(analysisSeconds) : null
  const faster = timesFasterThanOpusClip(output.processing_time_seconds)

  const processingCell = (
    <StatCell
      index={1}
      icon={<Timer />}
      label="Processing"
      hint={faster && <HoverHint />}
      value={formatDuration(processing)}
      final={formatDuration(processingMs)}
      sub={faster ? <Win>{formatTimes(faster)} vs OpusClip reference</Win> : <><Num>{formatTimecode(sourceSeconds * 1000)}</Num> source</>}
    />
  )
  const costCell = (
    <StatCell
      index={2}
      icon={<CircleDollarSign />}
      label="API cost"
      hint={percentLess && <HoverHint />}
      value={costs ? `${costs.cost_incomplete ? '≥ ' : ''}${cost === costs.total_estimated_cost_usd ? formatUsd(cost) : `$${cost.toFixed(2)}`}` : '—'}
      final={costs ? `${costs.cost_incomplete ? 'At least ' : ''}${formatUsd(costs.total_estimated_cost_usd)}` : 'Not recorded'}
      sub={percentLess ? <Win>{percentLess}% below OpusClip credit rate</Win> : costs ? costParts(costs) : 'Not recorded for this run'}
    />
  )

  return (
    <div role="group" aria-label="Run stats" className="glass grid grid-cols-2 overflow-hidden rounded-3xl min-[960px]:grid-cols-4 [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(odd)]:border-r min-[960px]:[&>*:nth-child(-n+2)]:border-b-0 min-[960px]:[&>*:not(:last-child)]:border-r [&>*]:border-white/[0.06]">
      <StatCell
        index={0}
        icon={<Clapperboard />}
        label="Clips"
        value={String(clipCount)}
        final={String(clips)}
        sub={clips > 0 && <>Top score <Num>{topScore.toFixed(1)}</Num>{videoSpeed && <> · <Num>{videoSpeed}×</Num> speed</>}</>}
      />
      {faster ? (
        <HoverCard
          label={`Processing took ${formatDuration(processingMs)}, ${formatTimes(faster)} compared with OpusClip's published reference`}
          content={
            <OpusClipCard
              headline={`${formatTimes(faster)} time ratio`}
              comparison="vs published processing time"
              basis={`OpusClip publishes a typical ${OPUS_CLIP.processingTerms}. The ratio uses ${OPUS_CLIP.processingMinutes} minutes; this run took ${formatDuration(processingMs)}. This is not a same-video benchmark.`}
            />
          }
          className={HOVER_CELL}
        >
          {processingCell}
        </HoverCard>
      ) : processingCell}
      {percentLess && theirCost !== null && exactCost !== null && analysisSeconds !== null ? (
        <HoverCard
          label={`API cost ${formatUsd(exactCost)}, ${percentLess}% below OpusClip's allocated credit price`}
          content={
            <OpusClipCard
              headline={`${percentLess}% less`}
              comparison="vs allocated credit price"
              basis={`${formatTimecode(analysisSeconds * 1000)} analyzed: ${opusClipCredits(analysisSeconds)} credits at ${OPUS_CLIP.priceTerms} allocate ${formatUsd(theirCost)}. This run's API cost: ${formatUsd(exactCost)}. Subscription features and local computing costs differ. Prices as of ${OPUS_CLIP.checked}.`}
            />
          }
          className={HOVER_CELL}
        >
          {costCell}
        </HoverCard>
      ) : costCell}
      <StatCell
        index={3}
        icon={<CalendarClock />}
        label="Created"
        value={created ? created.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'}
        sub={created && dayLabel(created)}
      />
    </div>
  )
}

const HOVER_CELL = 'group/hover transition-colors duration-150 hover:bg-white/[0.025] focus-visible:bg-white/[0.025]'

function HoverHint(): React.JSX.Element {
  return <Info aria-hidden className="h-3 w-3 text-ink-subtle transition-colors group-hover/hover:text-ink" />
}

function Win({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="text-success">{children}</span>
}

function dayLabel(date: Date): string {
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

function Num({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="font-mono tabular text-ink-muted">{children}</span>
}

function StatCell({ index, icon, label, hint, value, final, sub }: {
  index: number
  icon: ReactNode
  label: string
  /** Shown after the label, e.g. a sign that hovering explains more. */
  hint?: ReactNode
  /** What is on screen now (it may still be counting). */
  value: string
  /** The settled value, for assistive tech while the number counts. */
  final?: string
  sub?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-3 px-4 py-3.5 animate-pop-in" style={{ animationDelay: `${index * STAGGER_MS}ms` }}>
      <IconTile>{icon}</IconTile>
      <dl className="min-w-0 flex-1">
        <dt className="eyebrow flex items-center gap-1.5">{label}{hint}</dt>
        <dd className="mt-1 truncate font-mono text-2xl font-medium leading-7 tabular tracking-[-0.03em] text-ink">
          {final ? (
            <>
              <span aria-hidden>{value}</span>
              <span className="sr-only">{final}</span>
            </>
          ) : value}
        </dd>
        {sub && <dd className="mt-1 truncate text-xs text-ink-subtle">{sub}</dd>}
      </dl>
    </div>
  )
}

/** OpusClip's logo, the one number that matters, and one line on where it comes from. */
function OpusClipCard({ headline, comparison, basis }: { headline: string; comparison: string; basis: string }): React.JSX.Element {
  return (
    <div className="w-[260px] max-w-[calc(100vw-16px)]">
      <div className="px-4 pb-3.5 pt-4">
        <OpusClipLogo className="h-[18px] text-ink" />
        <p className="mt-3 text-3xl font-semibold leading-none tracking-[-0.03em] text-success">{headline}</p>
        <p className="mt-1.5 text-sm text-ink-muted">{comparison}</p>
      </div>
      <p className="border-t border-white/[0.07] bg-black/15 px-4 py-2.5 text-2xs leading-relaxed text-ink-subtle">{basis}</p>
    </div>
  )
}

/** "Transcribe $0.02 · plan $0.11", from the parts the run recorded. */
function costParts(costs: ApiCosts): string | null {
  if (costs.cost_incomplete) return 'Partial: a model didn’t report its price'
  const parts = [
    costs.transcription && `Transcribe ${formatUsd(costs.transcription.estimated_cost_usd)}`,
    costs.planning && `plan ${formatUsd(costs.planning.estimated_cost_usd)}`,
    costs.layout_vision && `framing ${formatUsd(costs.layout_vision.estimated_cost_usd)}`
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}
