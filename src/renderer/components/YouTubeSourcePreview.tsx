import { useEffect, useState } from 'react'
import { Check, ExternalLink, RefreshCw, X, Youtube } from 'lucide-react'
import type { YouTubePreview } from '../../shared/youtube-preview'
import { getApi } from '../lib/ipc'
import { cn, formatTimecode } from '../lib/utils'
import { Button } from './ui/Button'
import { Skeleton } from './ui/Skeleton'

export type SavedSourceMetadata = Pick<YouTubePreview, 'title' | 'channel' | 'durationSeconds'>

export function YouTubeSourcePreview({ url, onClear, onReplace, disabled, readOnly = false, saved, className }: {
  /** Canonical YouTube watch URL. */
  url: string
  onClear?: () => void
  onReplace?: () => void
  disabled?: boolean
  readOnly?: boolean
  /** Completed runs already have metadata; show it immediately without refetching. */
  saved?: SavedSourceMetadata
  className?: string
}): React.JSX.Element {
  const [summary, setSummary] = useState<YouTubePreview | null>(null)
  const [details, setDetails] = useState<YouTubePreview | null>(null)
  const [pending, setPending] = useState(2)
  const [attempt, setAttempt] = useState(0)
  const [imageFailed, setImageFailed] = useState(false)
  const [openError, setOpenError] = useState(false)
  const id = new URL(url).searchParams.get('v')!
  const hasSaved = !!saved

  useEffect(() => {
    if (hasSaved) return
    let active = true
    setSummary(null)
    setDetails(null)
    setPending(2)
    for (const full of [false, true]) {
      void getApi().source.youtubePreview(url, full).then((result) => {
        if (active) (full ? setDetails : setSummary)(result)
      }).catch(() => { /* Metadata is optional; the selected source remains usable. */ }).finally(() => {
        if (active) setPending((count) => count - 1)
      })
    }
    return () => { active = false }
  }, [url, attempt, hasSaved])

  const preview = saved ? { ...saved, viewCount: null, uploadedOn: null } : details ?? summary
  const channel = saved?.channel ?? details?.channel ?? summary?.channel
  const loading = !preview && pending > 0
  const uploaded = preview?.uploadedOn ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${preview.uploadedOn}T00:00:00Z`)) : null
  const views = preview?.viewCount != null ? `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(preview.viewCount)} views` : null
  const openVideo = async (): Promise<void> => {
    try { setOpenError(!await getApi().shell.openPath(url)) } catch { setOpenError(true) }
  }

  return (
    <section aria-label="YouTube video preview" className={cn('glass flex flex-col overflow-hidden rounded-2xl animate-fade-in', className)}>
      <div className="flex flex-1 flex-col gap-3 p-3 sm:flex-row sm:gap-4">
        <div className="relative aspect-video w-full shrink-0 self-start overflow-hidden rounded-xl bg-black/40 sm:w-44 xl:w-52">
          {!imageFailed ? <img
            src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="Video thumbnail" draggable={false}
            className="h-full w-full object-cover" onError={() => setImageFailed(true)}
          /> : <div className="flex h-full items-center justify-center text-ink-subtle"><Youtube className="h-8 w-8" aria-hidden="true" /></div>}
          {preview?.durationSeconds != null && preview.durationSeconds > 0 && (
            <span className="absolute bottom-2 right-2 rounded-md bg-black/85 px-1.5 py-0.5 font-mono text-2xs font-medium tabular text-white" aria-label={`Duration ${formatTimecode(preview.durationSeconds * 1000)}`}>
              {formatTimecode(preview.durationSeconds * 1000)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 py-0.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium text-ink-muted">
            <Youtube className="h-3.5 w-3.5 text-[#ff0033]" aria-hidden="true" /> YouTube
          </div>
          {loading ? <div role="status" aria-label="Loading YouTube video details" className="space-y-2">
            <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /><Skeleton className="mt-3 h-3 w-1/3" />
          </div> : <>
            <h3 className="line-clamp-2 break-words text-base font-semibold leading-snug text-ink" title={preview?.title} data-selectable>
              {preview?.title ?? 'YouTube video'}
            </h3>
            {channel && <div className="mt-2 flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[10px] font-semibold text-ink-muted">{Array.from(channel)[0]?.toLocaleUpperCase()}</span>
              <p className="truncate text-xs text-ink-muted" title={channel}>{channel}</p>
            </div>}
            {(views || uploaded) && <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-subtle">
              {views && <span title={`${preview?.viewCount?.toLocaleString()} views`}>{views}</span>}
              {views && uploaded && <span aria-hidden="true">·</span>}
              {uploaded && <time dateTime={preview?.uploadedOn ?? undefined}>{uploaded}</time>}
            </p>}
            {!preview && <p role="status" className="mt-2 text-xs text-ink-muted">{readOnly ? "Video details are unavailable. Processing can continue." : "Details couldn’t load. You can still continue."}</p>}
          </>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-2xs text-ink-muted"><Check className="h-3 w-3" aria-hidden="true" /> {readOnly ? 'Source video' : 'Video added'}</span>
        <div className="flex flex-wrap items-center gap-1">
          {!preview && !loading && <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3 w-3" />} onClick={() => setAttempt((value) => value + 1)} disabled={disabled}>Retry details</Button>}
          <Button size="sm" variant="ghost" trailingIcon={<ExternalLink className="h-3 w-3" />} onClick={() => void openVideo()}>View on YouTube</Button>
          {!readOnly && <Button size="sm" variant="secondary" onClick={onReplace} disabled={disabled}>Replace</Button>}
          {!readOnly && <Button size="sm" variant="ghost" iconOnly aria-label="Remove video" icon={<X className="h-3.5 w-3.5" />} onClick={onClear} disabled={disabled} />}
        </div>
      </div>
      {openError && <p role="alert" className="px-3 pb-2 text-xs text-danger">Could not open YouTube. Please try again.</p>}
    </section>
  )
}
