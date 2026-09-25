import { useEffect, useState } from 'react'
import { FolderOpen, ImageOff, ListPlus, Play, Send, TrendingUp, TriangleAlert } from 'lucide-react'
import { cn, formatTimecode, isMac, localFileUrl } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import type { ClipArtifact } from '../store/use-job-store'
import { Checkbox } from './ui/Checkbox'
import { Badge } from './ui/Badge'
import { Skeleton } from './ui/Skeleton'

// How the engine framed a vertical clip (its dominant layout).
const LAYOUT_LABELS: Record<string, string> = {
  talking_head: 'Speaker',
  two_shot: 'Two people',
  screen_cam: 'Screen + webcam',
  screen: 'Whole frame',
  fit: 'Whole frame',
  center_crop: 'Center crop'
}

interface ClipCardProps {
  clip: ClipArtifact
  vertical: boolean
  topPick?: boolean
  selected: boolean
  selecting: boolean
  onToggleSelect: () => void
  /** Reports the thumbnail's aspect ratio so the grid can size to the output. */
  onAspect?: (ratio: number) => void
  /** Opens the post dialog for this clip. */
  onPost?: () => void
  onAddToAutomation?: () => void
}

export function ClipCard({
  clip,
  vertical,
  topPick,
  selected,
  selecting,
  onToggleSelect,
  onAspect,
  onPost,
  onAddToAutomation
}: ClipCardProps): React.JSX.Element {
  const filePath = clipFilePath(clip.s3_url)
  const [thumb, setThumb] = useState<string | null | undefined>(undefined)
  const [aspect, setAspect] = useState<number | null>(null)
  const [hovering, setHovering] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const title = clip.summary || `Clip ${clip.clip_index + 1}`
  const score = (clip.virality_score * 10).toFixed(1)
  const clipVertical = aspect == null ? vertical : aspect < 1
  const layout = clipVertical && Object.prototype.hasOwnProperty.call(LAYOUT_LABELS, clip.layout_type)
    ? LAYOUT_LABELS[clip.layout_type]
    : undefined

  useEffect(() => {
    let cancelled = false
    setThumb(undefined)
    setAspect(null)
    setPreviewFailed(false)
    setActionError(null)
    const seek = clip.duration_ms > 0 ? (clip.duration_ms / 1000) * 0.5 : undefined
    loadThumbnail(filePath, seek).then((path) => {
      if (!cancelled) setThumb(path)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, clip.duration_ms])

  const openClip = async (): Promise<void> => {
    setActionError(null)
    try {
      if (!await getApi().shell.openPath(filePath)) setActionError('Clip file is no longer available.')
    } catch {
      setActionError('Could not open this clip.')
    }
  }

  const showInFolder = async (): Promise<void> => {
    setActionError(null)
    try {
      if (!await getApi().shell.showItemInFolder(filePath)) setActionError('Clip file is no longer available.')
    } catch {
      setActionError('Could not show this clip in its folder.')
    }
  }

  return (
    <article
      className={cn(
        'glass group relative flex flex-col rounded-2xl p-1.5 transition-[transform,box-shadow] duration-300 ease-out',
        selected
          ? 'shadow-accent-ring'
          : 'hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(255_255_255/0.08),0_24px_48px_-20px_rgb(0_0_0/0.75)]'
      )}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]',
          clipVertical ? 'aspect-[9/16]' : 'aspect-video'
        )}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {thumb ? (
          <img
            src={localFileUrl(thumb)}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            onLoad={(e) => {
              const ratio = e.currentTarget.naturalWidth / e.currentTarget.naturalHeight
              if (Number.isFinite(ratio) && ratio > 0) {
                setAspect(ratio)
                onAspect?.(ratio)
              }
            }}
            onError={() => setThumb(null)}
          />
        ) : thumb === null ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-subtle">
            <ImageOff className="h-6 w-6" />
            <span className="text-xs">Preview unavailable</span>
          </div>
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
        {hovering && !previewFailed && (
          <video
            src={localFileUrl(filePath)}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setPreviewFailed(true)}
          />
        )}

        {/* The media plays the clip, or picks it while clips are being selected (the checkbox is the labelled control then). */}
        <button
          type="button"
          onClick={selecting ? onToggleSelect : () => { void openClip() }}
          aria-label={`Play “${title}”`}
          aria-hidden={selecting || undefined}
          tabIndex={selecting ? -1 : undefined}
          className="absolute inset-0 flex items-center justify-center focus-visible:[outline-offset:-3px]"
        >
          {!selecting && (
            <span className="glass-chip flex h-11 w-11 scale-90 items-center justify-center rounded-full text-white opacity-0 transition-[opacity,transform] duration-300 ease-spring group-focus-within:opacity-100 group-hover:scale-100 group-hover:opacity-100">
              <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
            </span>
          )}
        </button>

        <div
          className={cn(
            'absolute left-2 top-2 z-10 transition-opacity duration-200',
            selecting || selected ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
          )}
        >
          <Checkbox variant="overlay" checked={selected} onChange={onToggleSelect} label={`Select ${title}`} />
        </div>
        <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1">
          {topPick && (
            <span className="inline-flex h-5 items-center rounded-full bg-accent px-2 text-2xs font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]">
              Top pick
            </span>
          )}
          <span
            className="glass-chip pointer-events-auto inline-flex h-5 items-center gap-1 rounded-full px-1.5 font-mono text-2xs font-medium tabular text-white"
            title="Virality score"
          >
            <TrendingUp className="h-3 w-3 text-brand-gold" />
            {score}
          </span>
        </div>
        <span className="glass-chip pointer-events-none absolute bottom-2 left-2 z-10 rounded-full px-1.5 py-px font-mono text-2xs tabular text-white/95">
          {formatTimecode(clip.duration_ms)}
        </span>
        {!selecting && (
          <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
            {onPost && <MediaAction label={`Post “${title}”`} title="Post to social accounts" icon={<Send />} onClick={onPost} />}
            {onAddToAutomation && <MediaAction label={`Add “${title}” to automation`} title="Add to automation" icon={<ListPlus />} onClick={onAddToAutomation} />}
            <MediaAction label={isMac ? 'Show in Finder' : 'Show in folder'} icon={<FolderOpen />} onClick={() => { void showInFolder() }} />
          </div>
        )}
      </div>

      <div className="px-1.5 pb-1 pt-2">
        <h3 className="line-clamp-2 text-sm font-medium leading-[18px] text-ink" title={title}>
          {title}
        </h3>
        <p className="mt-1 truncate text-2xs text-ink-subtle">
          <span className="font-mono tabular" title="Position in the source video">
            {formatTimecode(clip.start_time_ms)} – {formatTimecode(clip.end_time_ms)}
          </span>
          {layout && <span title="How this clip was framed"> · {layout}</span>}
        </p>
        {clip.render_fallback && (
          <Badge
            tone="warning"
            icon={<TriangleAlert className="h-3 w-3" />}
            className="mt-1.5 self-start"
          >
            <span title="Smart framing failed to render this clip, so it used the classic whole-frame layout. The log has the details.">
              {clip.render_fallback === 'letterbox_natural' ? 'Fallback: whole frame, no cuts' : 'Fallback: whole frame'}
            </span>
          </Badge>
        )}
        {actionError && <p role="alert" className="mt-1.5 text-xs text-danger">{actionError}</p>}
      </div>
    </article>
  )
}

/** Small frosted button over the clip's media; shown on hover or focus. */
function MediaAction({ label, title, icon, onClick }: { label: string; title?: string; icon: React.ReactNode; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      className="glass-chip flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition-colors duration-150 hover:bg-white/25 hover:text-white [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {icon}
    </button>
  )
}
