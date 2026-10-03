import type { ReactNode } from 'react'
import { Captions, Clock3, Film, Gauge, Pencil, ScanLine, Scissors, Sparkles, WandSparkles } from 'lucide-react'
import { CLIPPING_MODELS } from '../../shared/clipping-modes'
import { DURATION_OPTIONS } from '../../shared/job-contract'
import { MAX_PARALLEL_JOBS, type ClipJobRequest } from '../../shared/jobs'
import { twitchVodId, youtubeSourceUrl } from '../../shared/video-source'
import type { WizardStep } from '../store/use-draft-store'
import { useActiveJobs } from '../store/use-job-store'
import { useSettingsStore } from '../store/use-settings-store'
import { useModelStore } from '../store/use-model-store'
import { SourcePreview } from './SourcePicker'
import { CaptionSample, captionPreviewPreset } from './CaptionPresetPicker'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import './review-step.css'

/** Review the same effective request that Generate submits. */
export function ReviewStep({ request, onEdit }: { request: ClipJobRequest; onEdit: (step: WizardStep) => void }): React.JSX.Element {
  const active = useActiveJobs()
  const settings = useSettingsStore()
  const catalog = useModelStore(s => s.catalog)
  const review = request.workflow === 'review'
  const mode = request.clippingMode ?? 'quality'
  const models = mode === 'advanced' ? {
    plannerName: catalog?.planning.find(m => m.id === request.plannerModel)?.name ?? request.plannerModel,
    transcriptionName: catalog?.transcription.find(m => m.id === request.transcriptionModel)?.name ?? request.transcriptionModel
  } : CLIPPING_MODELS[mode]
  const preset = captionPreviewPreset(request.captionPreset, request.customCaption)
  const lengths = DURATION_OPTIONS.filter(option => request.durationRanges?.includes(option.id))
  const jev = review || settings.jevEnabled === 'on'
  const framing = request.aspectRatio === '16:9' ? 'Whole frame' : ({ auto: 'Smart framing', fill: 'Full frame', fit: 'Classic framing' } as Record<string, string>)[request.layoutStyle]
  const running = active.filter(job => job.status !== 'queued').length
  const time = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

  return <div className="review-step space-y-3">
    <div className="mb-4 flex items-center gap-3"><span className="glass-tile flex h-10 w-10 items-center justify-center rounded-xl"><WandSparkles className="h-5 w-5 text-ink-muted" /></span><div><h2 className="text-lg font-semibold">{review ? 'Ready to find your moments' : 'Ready to make the cut'}</h2><p className="mt-0.5 text-xs text-ink-subtle">{review ? 'Find candidates, refine in the editor, export when ready.' : 'Your video, with everything set the way you want.'}</p></div></div>
    <section aria-label="Video summary" className="review-source">
      <div className="mb-2 flex items-center justify-between"><Badge icon={review ? <Scissors size={12} /> : <Sparkles size={12} />}>{review ? 'Review & edit' : 'Automatic'}</Badge><Edit label="video" onClick={() => onEdit('video')} /></div>
      <SourcePreview key={request.videoUrl} source={request.videoUrl} readOnly />
      {(request.startTimeSeconds !== null || request.endTimeSeconds !== null) && <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted"><Clock3 size={13} />Preferred range <span className="font-mono">{time(request.startTimeSeconds ?? 0)} — {request.endTimeSeconds !== null ? time(request.endTimeSeconds) : 'end'}</span></p>}
    </section>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ReviewCard label="Format & pace" icon={<Film size={14} />} onEdit={() => onEdit('format')} editLabel="format">
        <div className="flex items-center gap-3"><span aria-hidden className={`review-format ${request.aspectRatio === '9:16' ? 'review-format-vertical' : 'review-format-wide'}`}><span /><span /><span /></span><div><p className="text-base font-semibold">{request.aspectRatio === '9:16' ? 'Vertical' : 'Horizontal'} <span className="ml-1 font-mono text-xs font-normal text-ink-subtle">{request.aspectRatio}</span></p><p className="mt-0.5 text-xs text-ink-muted">{framing}</p></div></div>
        <div className="mt-3 flex flex-wrap gap-1.5"><Badge icon={<Gauge size={12} />}>{request.videoSpeed ?? 1}× speed</Badge><Badge icon={<Scissors size={12} />}>{review ? 'Manual cuts' : request.pacing === 'tight' ? 'Cut dead air' : 'Keep pauses'}</Badge>{request.layoutVision && <Badge icon={<ScanLine size={12} />}>AI vision</Badge>}</div>
      </ReviewCard>
      <ReviewCard label="The moments" icon={<Scissors size={14} />} onEdit={() => onEdit('clips')} editLabel="clips">
        <p className="text-base font-semibold">{request.autoClipCount ? 'Let AI decide' : <>Up to <span className="font-mono">{request.maxClips}</span> clips</>}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{lengths.length ? lengths.map(length => <Badge key={length.id}>{length.range}</Badge>) : <Badge>15–90s · Auto length</Badge>}</div>
        {(request.videoSpeed ?? 1) > 1 && <p className="mt-2 text-2xs text-ink-subtle">Source lengths · shorter at {request.videoSpeed}×</p>}
        <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-muted">{request.clipRequest?.trim() || 'The strongest moments from your video.'}</p>
      </ReviewCard>
      <ReviewCard label="Captions & title" icon={<Captions size={14} />} onEdit={() => onEdit('captions')} editLabel="captions">
        {request.includeCaptions ? <><div className="review-caption-sample glass-well flex h-16 items-center justify-center overflow-hidden rounded-xl px-2"><CaptionSample preset={preset} /></div><div className="mt-2 flex items-center justify-between"><span className="truncate text-sm font-medium">{preset.name}</span><span className="text-2xs text-ink-subtle">{request.customCaption ? 'Your style' : 'Default'}</span></div></> : <div className="flex h-16 items-center justify-center gap-2 rounded-xl bg-white/[0.025] text-xs text-ink-subtle"><Captions size={18} />Captions off</div>}
        <p className="mt-2 text-2xs text-ink-subtle">{review ? 'No title overlay · captions editable before export' : request.includeTitle ? 'Title shown at the top' : 'Title overlay off'}</p>
      </ReviewCard>
      <ReviewCard label="Clipping mode" icon={<Sparkles size={14} />} onEdit={() => onEdit('clips')} editLabel="mode">
        <p className="mb-3 text-base font-semibold">{{ quality: 'Quality', economy: 'Economy', advanced: 'Advanced' }[mode]}</p>
        <dl className="space-y-2 text-xs"><div><dt className="text-2xs text-ink-subtle">Find moments</dt><dd className="mt-0.5 break-words text-ink">{models.plannerName || 'Choose a model'}</dd></div><div><dt className="text-2xs text-ink-subtle">Transcribe</dt><dd className="mt-0.5 break-words text-ink">{models.transcriptionName || 'Choose a model'}</dd></div></dl>
        <p className="mt-3 text-2xs text-ink-subtle">{review ? 'Jev review required' : jev ? 'Jev review enabled' : 'Jev review off'}{mode === 'advanced' ? ' · No planner fallback' : ''}</p>
        {mode === 'quality' && <p className="mt-1 text-2xs text-ink-subtle">Planner fallback: {CLIPPING_MODELS.quality.fallbacks}</p>}
      </ReviewCard>
    </div>
    {settings.sourceContextWebResearch === 'on' && (youtubeSourceUrl(request.videoUrl) || twitchVodId(request.videoUrl)) && <p className="text-2xs text-ink-subtle">Source web research enabled</p>}
    <p className="flex items-start gap-2 px-1 pt-1 text-2xs text-ink-subtle"><Clock3 className="mt-px h-3.5 w-3.5 shrink-0" />{running >= MAX_PARALLEL_JOBS ? 'Joins the queue. Starts when a slot opens.' : active.length ? 'Starts alongside your current jobs.' : review ? 'Finds moments first. Export after editing.' : 'Renders on this computer. AI usage bills your OpenRouter account.'}</p>
  </div>
}

function Edit({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return <Button size="sm" variant="ghost" iconOnly icon={<Pencil size={13} />} aria-label={`Edit ${label}`} tooltip={`Edit ${label}`} onClick={onClick} />
}
function ReviewCard({ label, icon, children, onEdit, editLabel }: { label: string; icon: ReactNode; children: ReactNode; onEdit: () => void; editLabel: string }): React.JSX.Element {
  return <section aria-label={label} className="review-card glass-tile rounded-2xl p-3"><div className="mb-2 flex items-center gap-2 text-ink-subtle">{icon}<h3 className="mr-auto text-xs">{label}</h3><Edit label={editLabel} onClick={onEdit} /></div>{children}</section>
}
