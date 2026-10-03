import { useEffect, useId, useState } from 'react'
import { AlertCircle, Check, ChevronDown, Clapperboard, Folder, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import type { HistoryEntry } from '../../preload'
import type { LibraryDeletionPreview } from '../../shared/output-storage'
import { getApi } from '../lib/ipc'
import { cn, formatBytes } from '../lib/utils'
import { Button } from './ui/Button'

export function LibraryDeleteSummary({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  const [preview, setPreview] = useState<LibraryDeletionPreview | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [showFolder, setShowFolder] = useState(false)
  const folderId = useId()

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    setFailed(false)
    void (async () => {
      try {
        const result = await getApi().history.deletionPreview(entry.outputDir)
        if (result.outputDirectory !== entry.outputDir) throw new Error('Library folder changed')
        if (!cancelled) setPreview(result)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [entry.outputDir, attempt])

  const clipCount = preview?.clipCount ?? entry.clipCount
  return (
    <div className="space-y-4">
      <p className="line-clamp-2 break-words text-sm leading-relaxed" title={entry.videoTitle}>{entry.videoTitle}</p>

      <div className="flex min-h-[92px] items-center gap-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.04] px-4 py-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><HardDrive aria-hidden className="h-5 w-5" /></span>
        <div role="status" aria-label="Space freed estimate" className="min-w-0 flex-1">
          <p className="text-xs text-ink-muted">Estimated space freed</p>
          <p className={cn('mt-0.5 font-semibold tracking-tight text-ink', preview ? 'text-2xl tabular-nums' : 'text-base')}>
            {preview ? `${preview.partial ? 'At least ' : ''}${formatBytes(preview.bytes)}` : failed ? 'Size unavailable' : 'Calculating…'}
          </p>
          {preview?.partial && <p className="mt-0.5 text-2xs text-warning">Some files couldn’t be counted.</p>}
        </div>
        {(failed || preview?.partial) && <Button size="sm" variant="ghost" aria-label="Retry size estimate" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setAttempt((value) => value + 1)} />}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-ink"><Trash2 aria-hidden className="h-3.5 w-3.5 text-danger" />Deleted</p>
          {preview && <span className="text-ink-subtle">{preview.partial ? `${preview.fileCount.toLocaleString()}+` : preview.fileCount.toLocaleString()} files</span>}
        </div>
        <div className="grid grid-cols-[0.85fr_1.6fr] gap-2">
          <div className="rounded-xl border border-white/[0.07] px-3 py-3">
            <Clapperboard aria-hidden className="mb-2 h-4 w-4 text-ink-muted" />
            <p className="text-sm font-medium text-ink">{clipCount} {clipCount === 1 ? 'clip' : 'clips'}</p>
            <p className="mt-1 text-xs text-ink-muted">Local exports</p>
          </div>
          <div className="rounded-xl border border-white/[0.07] px-3 py-3">
            <Folder aria-hidden className="mb-2 h-4 w-4 text-ink-muted" />
            <p className="text-sm font-medium text-ink">All run files</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">Source copies, edits, previews, transcripts & logs</p>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2.5 text-xs leading-relaxed">
        <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <p><span className="font-medium text-ink">Kept</span><br />Published posts & copies saved elsewhere</p>
      </div>

      <div className="border-t border-white/[0.07] pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs text-ink-muted"><AlertCircle aria-hidden className="h-3.5 w-3.5" />Can’t be undone</p>
          <button type="button" aria-expanded={showFolder} aria-controls={folderId} onClick={() => setShowFolder((value) => !value)} className="flex items-center gap-1 rounded-md px-1 py-1 text-xs text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Folder location<ChevronDown aria-hidden className={cn('h-3 w-3 transition-transform motion-reduce:transition-none', showFolder && 'rotate-180')} />
          </button>
        </div>
        <p id={folderId} hidden={!showFolder} className="mt-2 break-all rounded-lg bg-black/20 p-2.5 text-2xs leading-relaxed text-ink-muted">{entry.outputDir}</p>
      </div>
    </div>
  )
}
