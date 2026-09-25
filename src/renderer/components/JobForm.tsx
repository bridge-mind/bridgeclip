import { normalizeVideoSource, twitchSourceError } from '../../shared/video-source'
import { useEffect, useMemo, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, ListVideo, Minus, Plus, Sparkles } from 'lucide-react'
import { cn, MOD_KEY, parseTimecode, sourceLabel } from '../lib/utils'
import { useDraftStore, type ClipDraft, type WizardStep } from '../store/use-draft-store'
import { useActiveJobs } from '../store/use-job-store'
import type { ClipJobRequest } from '../../shared/jobs'
import { MAX_PARALLEL_JOBS } from '../../shared/jobs'
import { CaptionPresetPicker, CAPTION_PRESET_NAMES } from './CaptionPresetPicker'
import { SourcePicker } from './SourcePicker'
import { Panel } from './ui/Panel'
import { Switch } from './ui/Switch'
import { Button } from './ui/Button'
import { TextInput } from './ui/Field'
import { IconTile } from './ui/IconTile'
import { SettingRow } from './ui/SettingRow'
import { onRadioKeyDown } from './ui/Segmented'
import { DURATION_OPTIONS, VIDEO_SPEED_OPTIONS } from '../../shared/job-contract'
import { isModelId } from '../../shared/openrouter-models'
import { useModelStore } from '../store/use-model-store'
import { ModelPicker } from './ModelPicker'

const DURATIONS = DURATION_OPTIONS

const FORMATS = [
  { id: '9:16', label: 'Vertical', hint: 'Shorts, Reels, TikTok', w: 12, h: 21 },
  { id: '16:9', label: 'Horizontal', hint: 'YouTube, X, LinkedIn', w: 24, h: 14 }
] as const

const LAYOUT_STYLES = [
  { id: 'auto', label: 'Smart', hint: 'Auto frames each shot' },
  { id: 'fill', label: 'Full frame', hint: 'Follows the speaker' },
  { id: 'fit', label: 'Classic', hint: 'Whole frame, blurred' }
] as const

const MAX_CLIPS = 100

export const WIZARD_STEPS: { id: WizardStep; label: string; title: string; description: string }[] = [
  { id: 'video', label: 'Video', title: 'Choose a video', description: 'A local file, YouTube link or Twitch VOD link. Optionally clip only part of it.' },
  { id: 'format', label: 'Format', title: 'Format, framing and speed', description: 'Choose the look and pace of every clip in this job.' },
  { id: 'clips', label: 'Clips', title: 'Clip length and count', description: 'Pick one or more lengths, or leave them all off for any length.' },
  { id: 'captions', label: 'Captions', title: 'Captions', description: 'Word-by-word captions burned into each clip. Silent videos are clipped without them.' },
  { id: 'review', label: 'Review', title: 'Review and generate', description: 'Check the run, then generate. You can queue another video right after.' }
]

export function parseTrimRange(enabled: boolean, startText: string, endText: string): {
  start: number | null
  end: number | null
  error: string | null
} {
  const start = enabled ? parseTimecode(startText) : null
  const end = enabled ? parseTimecode(endText) : null
  let error: string | null = null
  if (Number.isNaN(start) || Number.isNaN(end)) error = 'Use seconds (90) or a timecode (1:30).'
  else if (end != null && end <= (start ?? 0)) error = 'End must be after the start.'
  return { start, end, error }
}

/** The run request for the current draft. */
export function buildJobRequest(draft: ClipDraft, trim: { start: number | null; end: number | null }): ClipJobRequest {
  return {
    videoUrl: normalizeVideoSource(draft.source),
    clippingMode: draft.clippingMode,
    ...(draft.clippingMode === 'advanced' ? { plannerModel: draft.plannerModel, transcriptionModel: draft.transcriptionModel } : {}),
    maxClips: draft.autoClipCount ? null : draft.maxClips,
    autoClipCount: draft.autoClipCount,
    durationRanges: draft.durations.length > 0 ? draft.durations : null,
    aspectRatio: draft.aspectRatio,
    layoutStyle: draft.layoutStyle,
    layoutVision: draft.clippingMode !== 'economy' && draft.aspectRatio === '9:16' && draft.layoutStyle === 'auto' && draft.layoutVision,
    pacing: draft.pacing,
    videoSpeed: draft.videoSpeed ?? 1,
    includeCaptions: draft.includeCaptions,
    captionPreset: draft.captionPreset,
    startTimeSeconds: trim.start,
    endTimeSeconds: trim.end,
    bannerPlatform: null,
    bannerChannelUrl: null
  }
}

interface JobFormProps {
  onSubmit: (config: ClipJobRequest) => void
  /** Opens a queued job on the Jobs page. */
  onViewJob?: (jobId: string) => void
  /** Why the job can't start yet (missing keys, tools); disables submit. */
  blockedReason?: ReactNode
  submitting?: boolean
  className?: string
}

type Update = (patch: Partial<ClipDraft>) => void

/**
 * The Create wizard: Video → Format → Clips → Captions → Review. Each step is
 * one compact panel with Back/Next pinned below it. After Generate the job is
 * queued and the wizard offers the next video, so several runs can go at once.
 */
export function JobForm({ onSubmit, onViewJob, blockedReason, submitting, className }: JobFormProps): React.JSX.Element {
  const draft = useDraftStore()
  const { update, step, setStep } = draft

  const trim = useMemo(
    () => parseTrimRange(draft.trimOpen, draft.trimStart, draft.trimEnd),
    [draft.trimOpen, draft.trimStart, draft.trimEnd]
  )

  const index = WIZARD_STEPS.findIndex((s) => s.id === step)
  const meta = WIZARD_STEPS[index]
  const sourceError = twitchSourceError(draft.source)
  const hasSource = Boolean(draft.source.trim()) && !sourceError
  const modelsValid = draft.clippingMode !== 'advanced' || (isModelId(draft.plannerModel) && isModelId(draft.transcriptionModel))
  const stepValid = step === 'video' ? hasSource && !trim.error : step !== 'clips' || modelsValid
  const canSubmit = hasSource && modelsValid && !blockedReason && !trim.error && !submitting && !draft.started

  const submit = (): void => {
    if (canSubmit) onSubmit(buildJobRequest(draft, trim))
  }

  // ⌘↵ / Ctrl+↵ generates from any step once a video is chosen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (draft.started) {
    return <StartedPanel className={className} onViewJob={onViewJob} />
  }

  const goTo = (target: WizardStep): void => {
    setStep(target)
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }
  const next = WIZARD_STEPS[index + 1]
  const back = WIZARD_STEPS[index - 1]

  return (
    <div className={cn('space-y-3', className)}>
      <Stepper current={step} reachable={hasSource ? WIZARD_STEPS.length - 1 : 0} onSelect={goTo} />

      <Panel className="p-4 xl:p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-ink">{meta.title}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{meta.description}</p>
        </div>
        {sourceError && <p role="alert" className="text-sm text-danger">{sourceError}</p>}
        {step === 'video' && <VideoStep draft={draft} update={update} trimError={trim.error} disabled={submitting} />}
        {step === 'format' && <FormatStep draft={draft} update={update} />}
        {step === 'clips' && <ClipsStep draft={draft} update={update} />}
        {step === 'captions' && <CaptionsStep draft={draft} update={update} />}
        {step === 'review' && <ReviewStep draft={draft} trim={trim} onEdit={goTo} />}
      </Panel>

      {/* Actions stay pinned to the bottom edge on a solid strip. */}
      <div className="sticky bottom-0 z-10 -mb-3 flex items-center gap-3 bg-canvas pb-3 pt-2">
        {back ? (
          <Button variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => goTo(back.id)}>
            Back
          </Button>
        ) : <span />}
        <p className="min-w-0 flex-1 truncate text-center text-2xs text-ink-subtle">
          {blockedReason ?? (!modelsValid ? 'Choose both models in Advanced mode.' : step === 'video' && !hasSource ? 'Add a video to continue.' : `${MOD_KEY}↵ generates from any step`)}
        </p>
        {next && step !== 'review' ? (
          <div className="flex items-center gap-2">
            {step !== 'video' && (
              <Button variant="ghost" onClick={submit} disabled={!canSubmit} loading={submitting} className="max-sm:hidden">
                Generate now
              </Button>
            )}
            <Button variant="primary" trailingIcon={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => goTo(next.id)} disabled={!stepValid}>
              Next: {next.label}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={submit} disabled={!canSubmit} loading={submitting}>
            Generate clips
          </Button>
        )}
      </div>
    </div>
  )
}

function Stepper({ current, reachable, onSelect }: { current: WizardStep; reachable: number; onSelect: (step: WizardStep) => void }): React.JSX.Element {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === current)
  return (
    <nav aria-label="Create steps">
      <ol className="flex items-center gap-1.5">
        {WIZARD_STEPS.map((s, i) => {
          const active = i === currentIndex
          const done = i < currentIndex
          const enabled = i <= reachable
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none">
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                disabled={!enabled}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'group flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-xs transition-colors duration-200',
                  active ? 'bg-white/[0.08] font-medium text-ink' : enabled ? 'text-ink-muted hover:bg-white/[0.05] hover:text-ink' : 'text-ink-faint'
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-2xs tabular',
                    active ? 'bg-accent text-accent-ink' : done ? 'bg-ink text-canvas' : 'bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]'
                  )}
                >
                  {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn('truncate', !active && 'max-md:hidden')}>{s.label}</span>
              </button>
              {i < WIZARD_STEPS.length - 1 && (
                <span aria-hidden className={cn('h-px min-w-3 flex-1', done ? 'bg-ink/40' : 'bg-white/[0.08]')} />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function VideoStep({ draft, update, trimError, disabled }: { draft: ClipDraft; update: Update; trimError: string | null; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <SourcePicker value={draft.source} onChange={(source) => update({ source })} disabled={disabled} />
      <SettingRow
        title="Clip only part of the video"
        description="Set a start and end time. Leave either empty for an open range."
        control={<Switch label="Trim the source" checked={draft.trimOpen} onChange={(trimOpen) => update({ trimOpen })} />}
      />
      {draft.trimOpen && (
        <div className="animate-fade-in">
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              mono
              placeholder="Start 0:00"
              value={draft.trimStart}
              onChange={(e) => update({ trimStart: e.target.value })}
              aria-label="Start time"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
            <TextInput
              mono
              placeholder="End"
              value={draft.trimEnd}
              onChange={(e) => update({ trimEnd: e.target.value })}
              aria-label="End time"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
          </div>
          <p id="trim-help" role={trimError ? 'alert' : undefined} className={cn('mt-1.5 text-2xs', trimError ? 'text-danger' : 'text-ink-subtle')}>
            {trimError ?? 'Use seconds (90) or mm:ss (1:30).'}
          </p>
        </div>
      )}
    </div>
  )
}

/** Format, framing and pacing. Exported for the keyboard-navigation test. */
export function FormatStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Group label="Format">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => {
            const selected = draft.aspectRatio === f.id
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onKeyDown={onRadioKeyDown}
                onClick={() => update({ aspectRatio: f.id })}
                className={cn('glass-tile glass-tile-hover flex items-center gap-3 rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}
              >
                <span className="flex h-6 w-7 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      'rounded-[4px] border-[1.5px] transition-colors duration-200',
                      selected ? 'border-accent-hover bg-accent/25' : 'border-ink-subtle bg-white/[0.04]'
                    )}
                    style={{ width: f.w, height: f.h }}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">
                    {f.label} <span className="font-mono text-2xs font-normal text-ink-subtle">{f.id}</span>
                  </span>
                  <span className="block truncate text-2xs text-ink-subtle">{f.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Group>

      {draft.aspectRatio === '9:16' && (
        <Group label="Framing">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Framing">
            {LAYOUT_STYLES.map((style) => {
              const selected = draft.layoutStyle === style.id
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={onRadioKeyDown}
                  onClick={() => update({ layoutStyle: style.id })}
                  className={cn(
                    'glass-tile glass-tile-hover flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left',
                    selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                  )}
                >
                  <FramingGlyph style={style.id} selected={selected} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{style.label}</span>
                    <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{style.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {draft.layoutStyle === 'auto' && draft.clippingMode === 'economy' && (
            <p className="mt-2 text-2xs text-ink-subtle">AI vision checks are off in Economy mode.</p>
          )}
          {draft.layoutStyle === 'auto' && draft.clippingMode !== 'economy' && (
            <SettingRow
              className="mt-2"
              title="Check tricky shots with AI vision"
              description="Checks uncertain shots. May add OpenRouter charges."
              control={<Switch label="AI vision for smart framing" checked={draft.layoutVision} onChange={(layoutVision) => update({ layoutVision })} />}
            />
          )}
        </Group>
      )}

      <Group label="Pacing">
        <SettingRow
          title="Cut dead air"
          description="Trims long pauses and filler words, keeps demos."
          control={
            <Switch label="Cut dead air and filler words" checked={draft.pacing === 'tight'} onChange={(on) => update({ pacing: on ? 'tight' : 'natural' })} />
          }
        />
      </Group>

      <Group label="Video speed" aside="All clips in this job">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" role="radiogroup" aria-label="Video speed" aria-describedby="video-speed-help">
          {VIDEO_SPEED_OPTIONS.map((speed) => {
            const selected = (draft.videoSpeed ?? 1) === speed
            return (
              <button key={speed} type="button" role="radio" aria-checked={selected}
                aria-label={`${speed}×${speed === 1 ? ' (Normal)' : ''}`}
                tabIndex={selected ? 0 : -1} onKeyDown={onRadioKeyDown}
                onClick={() => update({ videoSpeed: speed })}
                className={cn('glass-tile glass-tile-hover rounded-xl px-2 py-2 text-center', selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}>
                <span className="block font-mono text-sm tabular">{speed}×</span>
                <span className="block text-2xs text-ink-subtle">{speed === 1 ? 'Normal' : `${Math.round(60 / speed)}s per minute`}</span>
              </button>
            )
          })}
        </div>
        <p id="video-speed-help" className="mt-2 text-2xs text-ink-subtle">Speeds up every exported clip, keeping voice pitch natural and captions in sync. Faster clips are shorter.</p>
      </Group>
    </div>
  )
}

export function ClipsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const toggleDuration = (id: string): void => {
    update({ durations: draft.durations.includes(id) ? draft.durations.filter((d) => d !== id) : [...draft.durations, id] })
  }
  return (
    <div className="space-y-4">
      <Group label="Clipping mode">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Clipping mode">
          {([
            { id: 'quality', label: 'Quality', hint: 'Opus 5.5 planning · MAI Transcribe 2' },
            { id: 'economy', label: 'Economy', hint: 'GLM 5.3 Flash planning · Whisper Turbo' },
            { id: 'advanced', label: 'Advanced', hint: 'Choose your OpenRouter models' }
          ] as const).map((mode) => {
            const selected = draft.clippingMode === mode.id
            return <button key={mode.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1}
              onKeyDown={onRadioKeyDown} onClick={() => update({ clippingMode: mode.id })}
              className={cn('glass-tile glass-tile-hover rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}>
              <span className="block text-sm font-medium text-ink">{mode.label}</span>
              <span className="block text-2xs text-ink-subtle">{mode.hint}</span>
            </button>
          })}
        </div>
        {draft.clippingMode === 'advanced' ? <AdvancedModels draft={draft} update={update} /> :
          <p className="mt-2 text-2xs text-ink-subtle">Economy uses lower-cost models and skips paid vision checks. Transcription retries temporary errors and can fall back to Whisper Large V3, then MAI Transcribe 2. Clip choices and captions may be less accurate.</p>}
      </Group>
      <Group label="Clip length" aside={draft.durations.length === 0 ? 'Any length' : `${draft.durations.length} selected`}>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="group" aria-label="Clip length options">
          {DURATIONS.map((d) => {
            const selected = draft.durations.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleDuration(d.id)}
                className={cn(
                  'glass-tile glass-tile-hover rounded-xl px-1 py-1.5 text-center',
                  selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                )}
              >
                <span className="block font-mono text-xs tabular">{d.range}</span>
                <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{d.label}</span>
              </button>
            )
          })}
        </div>
        {(draft.videoSpeed ?? 1) > 1 && <p className="mt-2 text-2xs text-ink-subtle">Lengths refer to the original footage. At {draft.videoSpeed}×, 60 seconds becomes about {Math.round(60 / draft.videoSpeed)} seconds before dead-air cuts.</p>}
      </Group>

      <Group label="Number of clips">
        <SettingRow
          title="Let AI decide"
          description="Every moment worth posting."
          control={<Switch label="Let AI decide how many clips" checked={draft.autoClipCount} onChange={(autoClipCount) => update({ autoClipCount })} />}
        />
        {!draft.autoClipCount && (
          <div className="mt-2 flex max-w-xs items-center gap-2 animate-fade-in">
            <Button
              iconOnly
              aria-label="Fewer clips"
              onClick={() => update({ maxClips: Math.max(1, draft.maxClips - 1) })}
              disabled={draft.maxClips <= 1}
              icon={<Minus className="h-3.5 w-3.5" />}
            />
            <TextInput
              className="flex-1 rounded-full [&_input]:text-center"
              inputMode="numeric"
              value={String(draft.maxClips)}
              onChange={(e) => {
                const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
                update({ maxClips: Number.isFinite(n) ? Math.min(MAX_CLIPS, Math.max(1, n)) : 1 })
              }}
              aria-label="Maximum clips"
              mono
            />
            <Button
              iconOnly
              aria-label="More clips"
              onClick={() => update({ maxClips: Math.min(MAX_CLIPS, draft.maxClips + 1) })}
              disabled={draft.maxClips >= MAX_CLIPS}
              icon={<Plus className="h-3.5 w-3.5" />}
            />
          </div>
        )}
      </Group>
    </div>
  )
}

function CaptionsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <SettingRow
        title="Burn in captions"
        description="Turn off for clean clips without on-screen text."
        control={<Switch label="Captions" checked={draft.includeCaptions} onChange={(includeCaptions) => update({ includeCaptions })} />}
      />
      <div
        className={cn('transition-[opacity,filter] duration-300 ease-out', !draft.includeCaptions && 'pointer-events-none opacity-35 saturate-50')}
        aria-disabled={!draft.includeCaptions}
      >
        <CaptionPresetPicker
          value={draft.captionPreset}
          onChange={(captionPreset) => update({ captionPreset })}
          disabled={!draft.includeCaptions}
        />
      </div>
    </div>
  )
}

function ReviewStep({ draft, trim, onEdit }: {
  draft: ClipDraft
  trim: { start: number | null; end: number | null }
  onEdit: (step: WizardStep) => void
}): React.JSX.Element {
  const active = useActiveJobs()
  const runningCount = active.filter((job) => job.status !== 'queued').length
  const lengths = draft.durations.length === 0
    ? 'Any length'
    : DURATIONS.filter((d) => draft.durations.includes(d.id)).map((d) => d.range).join(', ')
  const framing = draft.aspectRatio === '9:16'
    ? `${LAYOUT_STYLES.find((s) => s.id === draft.layoutStyle)?.label ?? 'Smart'} framing${draft.clippingMode !== 'economy' && draft.layoutStyle === 'auto' && draft.layoutVision ? ' · AI vision' : ''}`
    : 'Whole frame'
  const trimLabel = draft.trimOpen && (trim.start != null || trim.end != null)
    ? ` · ${trim.start != null ? formatSeconds(trim.start) : 'start'} to ${trim.end != null ? formatSeconds(trim.end) : 'end'}`
    : ''

  const rows: { step: WizardStep; label: string; value: string }[] = [
    { step: 'video', label: 'Video', value: `${sourceLabel(draft.source)}${trimLabel}` },
    { step: 'format', label: 'Format', value: `${FORMATS.find((f) => f.id === draft.aspectRatio)?.label ?? draft.aspectRatio} ${draft.aspectRatio} · ${framing}` },
    { step: 'format', label: 'Pacing', value: draft.pacing === 'tight' ? 'Cut dead air' : 'Keep pauses' },
    { step: 'format', label: 'Speed', value: `${draft.videoSpeed ?? 1}×${(draft.videoSpeed ?? 1) === 1 ? ' · Normal' : ' · All exported clips'}` },
    { step: 'clips', label: 'Mode', value: draft.clippingMode === 'advanced' ? 'Advanced · custom models' : draft.clippingMode === 'economy' ? 'Economy · lower cost' : 'Quality · higher accuracy' },
    { step: 'clips', label: 'Clips', value: `${lengths}${(draft.videoSpeed ?? 1) > 1 && draft.durations.length > 0 ? ' of source footage' : ''} · ${draft.autoClipCount ? 'AI decides how many' : `Up to ${draft.maxClips}`}` },
    { step: 'captions', label: 'Captions', value: draft.includeCaptions ? CAPTION_PRESET_NAMES[draft.captionPreset] ?? draft.captionPreset : 'Off' }
  ]
  if (draft.clippingMode === 'advanced') rows.splice(5, 0,
    { step: 'clips', label: 'Transcribe', value: draft.transcriptionModel || 'Choose a model' },
    { step: 'clips', label: 'Plan', value: draft.plannerModel || 'Choose a model' })

  return (
    <div className="space-y-3">
      <dl className="glass-well divide-y divide-white/[0.05] overflow-hidden rounded-xl">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-3 py-2">
            <dt className="w-20 shrink-0 text-xs text-ink-subtle">{row.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-sm text-ink" title={row.value}>{row.value}</dd>
            <Button size="sm" variant="ghost" onClick={() => onEdit(row.step)} aria-label={`Edit ${row.label.toLowerCase()}`}>
              Edit
            </Button>
          </div>
        ))}
      </dl>
      <p className="flex items-start gap-2 text-2xs text-ink-subtle">
        <Clock3 className="mt-px h-3.5 w-3.5 shrink-0" />
        {runningCount >= MAX_PARALLEL_JOBS
          ? `${runningCount} jobs are running. This one waits in the queue and starts automatically.`
          : active.length > 0
            ? `Runs alongside ${active.length} other job${active.length === 1 ? '' : 's'}. Up to ${MAX_PARALLEL_JOBS} run at once.`
            : 'Runs on this computer. Transcription and clip planning bill your OpenRouter account.'}
      </p>
    </div>
  )
}

function StartedPanel({ className, onViewJob }: { className?: string; onViewJob?: (jobId: string) => void }): React.JSX.Element | null {
  const started = useDraftStore((s) => s.started)
  const startAnother = useDraftStore((s) => s.startAnother)
  if (!started) return null
  return (
    <Panel className={cn('flex flex-col items-center px-5 py-8 text-center animate-fade-in', className)}>
      <IconTile tone="success" size="lg">
        <CheckCircle2 />
      </IconTile>
      <h2 className="mt-3 text-base font-semibold text-ink">{started.queued ? 'Queued' : 'Clipping started'}</h2>
      <p className="mt-1 max-w-md truncate text-sm text-ink-muted" title={started.source}>{sourceLabel(started.source)}</p>
      <p className="mt-1 max-w-md text-xs text-ink-subtle">
        {started.queued
          ? `Up to ${MAX_PARALLEL_JOBS} jobs run at once. This one starts as soon as a slot frees up.`
          : 'It keeps running while you queue more videos or use the rest of BridgeClip.'}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={startAnother}>
          Clip another video
        </Button>
        {onViewJob && (
          <Button icon={<ListVideo className="h-3.5 w-3.5" />} onClick={() => onViewJob(started.jobId)}>
            View job
          </Button>
        )}
      </div>
    </Panel>
  )
}

function AdvancedModels({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const { catalog, loading, error, load } = useModelStore()
  useEffect(() => { void load() }, [load])
  return <div className="mt-3 space-y-4 rounded-xl border border-white/10 p-3">
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-ink-muted">Search OpenRouter’s live model catalog.</p>
      <Button size="sm" variant="ghost" loading={loading} disabled={loading} onClick={() => void load(true)}>Refresh models</Button>
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <ModelPicker task="transcription" models={catalog?.transcription ?? []} value={draft.transcriptionModel} loading={loading}
      onChange={(transcriptionModel) => update({ transcriptionModel })} />
    <ModelPicker task="planning" models={catalog?.planning ?? []} value={draft.plannerModel} loading={loading}
      onChange={(plannerModel) => update({ plannerModel })} />
    <p className="text-2xs text-ink-subtle">Temporary errors are retried with your selected models. No automatic model switching. Usage bills your OpenRouter account. Optional AI framing checks use Gemini and can be changed in Format.</p>
  </div>
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Tiny 9:16 diagram of a framing style: split panels, full bleed, or letterbox. */
function FramingGlyph({ style, selected }: { style: 'auto' | 'fill' | 'fit'; selected: boolean }): React.JSX.Element {
  const fill = selected ? 'bg-accent-hover/80' : 'bg-ink-subtle/60'
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[24px] w-[14px] shrink-0 flex-col gap-px overflow-hidden rounded-[4px] border-[1.5px] p-px transition-colors duration-200',
        selected ? 'border-accent-hover' : 'border-ink-subtle'
      )}
    >
      {style === 'auto' && (
        <>
          <span className={cn('flex-1 rounded-[1px]', fill)} />
          <span className={cn('flex-1 rounded-[1px] opacity-60', fill)} />
        </>
      )}
      {style === 'fill' && <span className={cn('flex-1 rounded-[1px]', fill)} />}
      {style === 'fit' && <span className={cn('my-auto h-[6px] rounded-[1px]', fill)} />}
    </span>
  )
}

function Group({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {aside && <span className="text-2xs text-ink-subtle">{aside}</span>}
      </div>
      {children}
    </div>
  )
}
