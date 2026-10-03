import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bookmark, Clapperboard, FolderOpen, HardDrive, ListVideo, Pencil, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { useDataVersion } from '../store/use-data-version-store'
import { cn, errorMessage, formatBytes, formatRelativeDate, formatUsd, localFileUrl } from '../lib/utils'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import { useSettingsStore } from '../store/use-settings-store'
import { usePostsStore } from '../store/use-posts-store'
import type { JobOutput } from '../store/use-job-store'
import { parseJobOutput } from '../../shared/job-output'
import type { HistoryEntry } from '../../preload/index'
import { BackLink, ClipList } from '../components/ClipList'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { TextInput } from '../components/ui/Field'
import { EmptyState } from '../components/ui/EmptyState'
import { Callout } from '../components/ui/Callout'
import { Skeleton } from '../components/ui/Skeleton'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { LibraryDeleteSummary } from '../components/LibraryDeleteSummary'
import { HoverCard } from '../components/ui/HoverCard'
import { useLibraryMotion } from '../hooks/use-library-motion'
import { useLibraryStorage } from '../hooks/use-library-storage'
import { usePageRoot } from '../hooks/use-page-root'
import type { OutputStorageUsage } from '../../shared/output-storage'
import './library.css'
import type { Page as AppPage } from '../components/Sidebar'

export function LibraryPage({ onNavigate, initialRun, initialClipIndex }: { onNavigate: (page: AppPage) => void; initialRun?: string | null; initialClipIndex?: number }): React.JSX.Element {
  const initialRunOpened = useRef(false)
  const outputDirectory = useSettingsStore((s) => s.outputDirectory)
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ entry: HistoryEntry; output: JobOutput; clipIndex?: number } | null>(null)
  usePageRoot(open === null)
  const requestId = useRef(0)
  const openRequestId = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const closeConfirm = useCallback(() => setConfirm(null), [])
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const busyRef = useRef(new Set<string>())
  const pendingBookmarks = useRef(new Map<string, boolean>())
  const [previewRevision, setPreviewRevision] = useState(0)
  const { gridRef, capture } = useLibraryMotion()
  const [bookmarkMessage, setBookmarkMessage] = useState('')
  const [counts, setCounts] = useState<Record<string, { posted: number; notPosted: number } | null>>({})
  const posts = usePostsStore((state) => state.posts)
  const postError = usePostsStore((state) => state.error)
  const configured = useSettingsStore((state) => state.zernioConfigured)
  const directoryRef = useRef(outputDirectory)
  directoryRef.current = outputDirectory

  const load = useCallback(async () => {
    const request = ++requestId.current
    setRefreshing(true)
    setError(null)
    try {
      const result = await getApi().history.list()
      if (request === requestId.current) {
        setEntries(result.filter((entry) => entry.status === 'completed').map(entry =>
          pendingBookmarks.current.has(entry.outputDir) ? { ...entry, favorite: pendingBookmarks.current.get(entry.outputDir)! } : entry))
        setPreviewRevision(revision => revision + 1)
      }
    } catch (err) {
      if (request === requestId.current) {
        setEntries((previous) => previous ?? [])
        setError(errorMessage(err, 'Could not load the library. Please refresh to retry.'))
      }
    } finally {
      if (request === requestId.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    setOpen(null)
    setConfirm(null)
    setCounts({})
    setBookmarkMessage('')
    setEntries(null)
    openRequestId.current++
    void load()
    return () => { requestId.current++; openRequestId.current++ }
  }, [load, outputDirectory])

  // The assistant changed the Library (deleted clips, marked posted, exported): reload what's shown.
  const libraryVersion = useDataVersion('library')
  const seenLibraryVersion = useRef(libraryVersion)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (libraryVersion === seenLibraryVersion.current) return
    seenLibraryVersion.current = libraryVersion
    void load()
    const current = openRef.current
    if (!current) return
    void getApi().history.getJob(current.entry.outputDir).then((output) => {
      if (openRef.current?.entry.outputDir !== current.entry.outputDir) return
      const parsed = output ? parseJobOutput(output) : null
      setOpen(parsed ? { ...openRef.current, output: parsed } : null)
    }).catch(() => {})
  }, [libraryVersion, load])

  useEffect(() => {
    if (!configured || open) return
    void usePostsStore.getState().refresh()
    const timer = window.setInterval(() => { void usePostsStore.getState().refresh() }, 30000)
    return () => window.clearInterval(timer)
  }, [configured, open])

  const entryPaths = JSON.stringify(entries?.map((entry) => entry.outputDir).sort() ?? [])
  const storage = useLibraryStorage(entryPaths, previewRevision)
  // The posts store refreshes every 30 s with a new array. Re-check posting
  // status only when a post's link to a clip or its outcome actually changed.
  const postsRevision = useMemo(() => JSON.stringify(posts.map((post) => [post.id, post.clipPath, post.status,
    post.targets.map((target) => [target.platform, target.status, target.inbox])])), [posts])
  useEffect(() => {
    if (open) return
    const paths = JSON.parse(entryPaths) as string[]
    if (!paths.length) return
    let active = true
    // One request for every run: the main process reads settings, post history
    // and automation banks once, and recovers older bank copies by byte identity.
    getApi().history.postingSummary(paths).then((results) => {
      if (active) setCounts(Object.fromEntries(results.map((result) => [result.outputDir, result.counts])))
    }).catch(() => {
      if (active) setCounts(Object.fromEntries(paths.map((path) => [path, null])))
    })
    return () => { active = false }
  }, [entryPaths, postsRevision, open, configured])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = query.trim().toLowerCase()
    return entries.filter((entry) => !q || entry.videoTitle.toLowerCase().includes(q))
  }, [entries, query])

  const bookmarked = filtered.filter(entry => entry.favorite)
  const recent = filtered.filter(entry => !entry.favorite)
  const totalClips = entries?.reduce((sum, e) => sum + e.clipCount, 0) ?? 0

  const openRun = useCallback(async (entry: HistoryEntry, clipIndex?: number): Promise<void> => {
    if (busyRef.current.has(entry.outputDir)) return
    const request = ++openRequestId.current
    setError(null)
    try {
      const output = await getApi().history.getJob(entry.outputDir)
      if (request !== openRequestId.current) return
      if (!output) {
        setError('This run is no longer available. Its files may have moved or been removed.')
        return
      }
      const parsed = parseJobOutput(output)
      if (!parsed) {
        setError('This run has an unsupported or damaged result file.')
        return
      }
      setOpen({ entry, output: parsed, clipIndex })
      document.getElementById('page-scroll')?.scrollTo({ top: 0 })
    } catch (err) {
      if (request === openRequestId.current) setError(errorMessage(err, 'Could not open this run.'))
    }
  }, [])

  useEffect(() => {
    if (!initialRun || !entries || initialRunOpened.current) return
    initialRunOpened.current = true
    const entry = entries.find((item) => item.outputDir === initialRun)
    if (entry) void openRun(entry, initialClipIndex)
    else setError('The source run is no longer in this Library. It may have been moved or deleted.')
  }, [initialRun, initialClipIndex, entries, openRun])

  const changeRun = async (entry: HistoryEntry, action: 'favorite' | 'delete'): Promise<void> => {
    if (busyRef.current.has(entry.outputDir)) return
    busyRef.current.add(entry.outputDir)
    setBusy(new Set(busyRef.current))
    const directory = directoryRef.current
    ++requestId.current
    ++openRequestId.current
    setRefreshing(false)
    setError(null)
    const favorite = !entry.favorite
    if (action === 'favorite') {
      pendingBookmarks.current.set(entry.outputDir, favorite)
      capture(entry.outputDir)
      setEntries(current => current?.map(item => item.outputDir === entry.outputDir ? { ...item, favorite } : item) ?? null)
      setBookmarkMessage('')
    }
    try {
      if (action === 'delete') await getApi().history.delete(entry.outputDir)
      else await getApi().history.setFavorite(entry.outputDir, favorite)
      if (directoryRef.current !== directory) return
      if (action === 'delete') setEntries(current => current?.filter(item => item.outputDir !== entry.outputDir) ?? null)
      else {
        setEntries(current => current?.map(item => item.outputDir === entry.outputDir ? { ...item, favorite } : item) ?? null)
        setBookmarkMessage(favorite ? `Bookmarked “${entry.videoTitle}”.` : `Removed “${entry.videoTitle}” from bookmarks.`)
      }
    } catch (cause) {
      if (directoryRef.current === directory) {
        if (action === 'favorite') {
          capture(entry.outputDir)
          setEntries(current => current?.map(item => item.outputDir === entry.outputDir ? { ...item, favorite: entry.favorite } : item) ?? null)
        }
        setError(errorMessage(cause, action === 'delete' ? 'Could not delete this run. Refresh the Library to check its files.' : 'Could not save this bookmark. Please try again.'))
      }
    } finally {
      // A list requested during the write may still contain the old disk value.
      if (directoryRef.current === directory) { ++requestId.current; setRefreshing(false) }
      pendingBookmarks.current.delete(entry.outputDir)
      busyRef.current.delete(entry.outputDir)
      setBusy(new Set(busyRef.current))
    }
  }

  const confirmDelete = (entry: HistoryEntry): void => setConfirm({
    title: 'Delete this Library item?',
    body: <LibraryDeleteSummary key={entry.outputDir} entry={entry} />,
    confirmLabel: 'Delete local files',
    onConfirm: () => { void changeRun(entry, 'delete') }
  })

  if (open) {
    return (
      <ClipList
        output={open.output}
        outputDir={open.entry.outputDir}
        initialClipIndex={open.clipIndex}
        onNavigate={onNavigate}
        leading={<BackLink label="Library" onClick={() => {
          setOpen(null)
          setCounts({})
          void load()
        }} />}
      />
    )
  }

  return (
    <Page width="wide">
      <PageHeader
        eyebrow="Studio"
        title="Library"
        description={
          entries && entries.length > 0
            ? `${entries.length} run${entries.length === 1 ? '' : 's'} · ${totalClips} clips`
            : 'Every run you finish lands here.'
        }
        actions={
          <>
            <Button variant="ghost" icon={<ListVideo className="h-4 w-4" />} onClick={() => onNavigate('jobs')}>
              Jobs
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              title="Refresh"
              onClick={() => { void load(); if (configured) void usePostsStore.getState().refresh(true) }}
              disabled={refreshing || busy.size > 0}
              icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}
            />
            {outputDirectory && (
              <Button icon={<FolderOpen className="h-4 w-4" />} onClick={() => getApi().shell.openPath(outputDirectory)}>
                Open folder
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Callout tone="danger" className="mt-4" onDismiss={() => setError(null)}>
          {error}
        </Callout>
      )}
      {configured && postError && <Callout tone="warning" className="mt-4">{postError} Showing saved posting status.</Callout>}

      {entries && entries.length > 0 && (
        <TextInput
          className="mt-5 max-w-sm rounded-full"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by video title"
          leading={<Search className="h-3.5 w-3.5" />}
          aria-label="Search runs"
        />
      )}

      <p className="sr-only" role="status" aria-live="polite">{bookmarkMessage}</p>
      <div className="mt-4">
        {entries === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4" aria-busy="true" aria-label="Loading library">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass rounded-2xl p-1.5">
                <Skeleton className="aspect-video rounded-xl" />
                <div className="space-y-2.5 px-2 pb-2 pt-3.5">
                  <Skeleton className="h-3.5 w-3/4 rounded-full" />
                  <Skeleton className="h-3 w-1/3 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Clapperboard />}
            title="No clips yet"
            description="Generate clips from a long video and every run will show up here, newest first."
            action={
              <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={() => onNavigate('clip')}>
                Create your first clips
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <div className="glass flex flex-col items-center rounded-3xl px-5 py-10 text-center">
            <Search className="h-5 w-5 text-ink-subtle" />
            <p className="mt-3 text-sm text-ink-muted">No runs match “{query}”.</p>
          </div>
        ) : (
          <div ref={gridRef} className="library-grid grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {[
              ...(bookmarked.length ? [{ key: 'bookmarked', title: 'Bookmarked', items: bookmarked }] : []),
              ...(recent.length ? [{ key: 'recent', title: bookmarked.length ? 'Recent runs' : 'All runs', items: recent }] : [])
            ].flatMap(group => [
              <div key={`heading:${group.key}`} data-library-layout={`heading:${group.key}`} className="library-section-heading">
                {group.key === 'bookmarked' && <Bookmark size={15} className="text-[#f2c66d]" fill="currentColor" aria-hidden />}
                <h2 className="text-sm font-medium text-ink">{group.title}</h2>
                <span className="text-xs tabular-nums text-ink-subtle">{group.items.length}</span>
              </div>,
              ...group.items.map(entry => <div key={entry.outputDir} data-library-layout={entry.outputDir} data-bookmarked={Boolean(entry.favorite)} className="library-run-slot">
              <RunCard
                entry={entry}
                previewRevision={previewRevision}
                counts={counts[entry.outputDir]}
                storage={storage[entry.outputDir]}
                busy={busy.has(entry.outputDir)}
                onFavorite={() => { void changeRun(entry, 'favorite') }}
                onDelete={() => confirmDelete(entry)}
                onOpen={() => openRun(entry)}
                onOpenFolder={async () => {
                  try {
                    if (!await getApi().shell.openPath(entry.outputDir)) setError('This run folder is no longer available.')
                  } catch (err) {
                    setError(errorMessage(err, 'Could not open this run folder.'))
                  }
                }}
              />
              </div>)
            ])}
          </div>
        )}
      </div>
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

function RunCard({ entry, previewRevision, counts, storage, busy, onFavorite, onDelete, onOpen, onOpenFolder }: {
  entry: HistoryEntry
  previewRevision: number
  counts: { posted: number; notPosted: number } | null | undefined
  storage: OutputStorageUsage | null | undefined
  busy: boolean
  onFavorite: () => void
  onDelete: () => void
  onOpen: () => void
  onOpenFolder: () => void
}): React.JSX.Element {
  const failed = entry.status !== 'completed'
  const { thumb, remaining } = useRunPreview(failed ? null : entry, previewRevision)
  const editing = remaining !== null && remaining > 0
  const partialSize = Boolean(storage?.truncated || storage?.unreadableCount)
  const storageLabel = storage ? `${partialSize ? 'At least ' : ''}${formatBytes(storage.bytes)} of local files${partialSize ? ' · Some files couldn’t be counted' : ''}`
    : storage === null ? 'Size unavailable · Refresh the Library to retry' : 'Calculating local file size…'
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => { setPreviewFailed(false) }, [thumb, previewRevision])

  return (
    <article
      className={cn(
        'glass group relative rounded-2xl border p-1.5 text-left transition-[transform,box-shadow] duration-300 ease-out',
        editing ? 'border-accent/60' : 'border-transparent',
        'hover:-translate-y-1 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(255_255_255/0.08),0_28px_56px_-24px_rgb(0_0_0/0.8)]'
      )}
    >
      <button type="button" className="block w-full text-left" disabled={busy} onClick={failed ? onOpenFolder : onOpen} aria-label={`Open ${entry.videoTitle}`}>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
        {thumb && !previewFailed ? (
          <>
            {/* Vertical clips sit on a blurred copy of themselves to fill the 16:9 frame. */}
            <img src={localFileUrl(thumb)} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-2xl saturate-150" />
            <img
              src={localFileUrl(thumb)}
              alt=""
              draggable={false}
              className="relative h-full w-full object-contain transition-transform duration-500 ease-out group-hover:scale-[1.04]"
              onError={() => setPreviewFailed(true)}
            />
          </>
        ) : failed ? (
          <div className="flex h-full items-center justify-center text-danger/70">
            <AlertTriangle className="h-6 w-6" />
          </div>
        ) : (
          <Skeleton className="h-full rounded-none" />
        )}
        {!failed && (
          <span className="glass-chip absolute left-2 top-2 inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-2xs font-medium text-white">
            <Clapperboard className="h-3 w-3" />
            {entry.editorProject && entry.clipCount === 0 ? entry.candidateCount == null ? 'Clip candidates' : `${entry.candidateCount} candidates` : `${entry.clipCount} clip${entry.clipCount === 1 ? '' : 's'}`}
          </span>
        )}
        {editing && <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-2xs font-medium text-accent-ink shadow-lg"
          aria-label={`Editing: ${remaining} clip${remaining === 1 ? '' : 's'} left to finish`} title={`${remaining} clip${remaining === 1 ? '' : 's'} left to finish`}>
          <Pencil className="h-3 w-3" aria-hidden="true" />Editing<span className="opacity-80">· {remaining} left</span>
        </span>}
      </div>
      <div className="px-2 pb-2 pt-3.5">
        <p className="truncate text-sm font-medium text-ink" title={entry.videoTitle}>
          {failed ? `${entry.status === 'incomplete' ? 'Unfinished' : 'Unreadable'} run · Open folder` : entry.videoTitle}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-subtle">
          <p className="flex flex-wrap items-center gap-1.5">
            <span>{formatRelativeDate(entry.date)}</span>
            {entry.totalCostUsd != null && (
              <>
                <span className="text-ink-faint">·</span>
                <span className="font-mono tabular">{formatUsd(entry.totalCostUsd)}</span>
              </>
            )}
          </p>
          <span data-library-storage className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums" title={storageLabel} aria-label={storageLabel}>
            <HardDrive aria-hidden className="h-3 w-3" />
            {storage ? `${partialSize ? '≥ ' : ''}${formatBytes(storage.bytes)}` : storage === null ? '—' : '…'}
          </span>
        </div>
        <p className="mt-2 text-xs text-ink-muted" title="Only fully published clips count as posted. Scheduled, partial and inbox deliveries remain Not Posted.">
          {entry.editorProject && entry.clipCount === 0 ? remaining === 0 ? 'No clips to finish' : 'No clips baked yet' : counts ? <><span className="text-success">{counts.posted} Posted</span><span className="mx-2 text-ink-faint">·</span><span>{counts.notPosted} Not Posted</span></>
            : counts === null ? 'Posting status unavailable' : 'Checking posting status…'}
        </p>
      </div>
      </button>
      <div className="absolute right-3.5 top-3.5 flex items-center gap-1.5">
        <Button size="sm" iconOnly className="glass-chip library-bookmark" aria-disabled={busy || undefined}
          tooltip={entry.favorite ? 'Remove bookmark. This run returns to its place among your recent runs.' : 'Bookmark this run to keep it in the Bookmarked section.'}
          aria-label={`${entry.favorite ? 'Remove bookmark from' : 'Bookmark'} ${entry.videoTitle}`} aria-pressed={Boolean(entry.favorite)}
          onClick={() => { if (!busy) onFavorite() }} icon={<Bookmark className="h-3.5 w-3.5" fill={entry.favorite ? 'currentColor' : 'none'} />} />
        <HoverCard cardClassName="px-3 py-2 text-xs" content="Delete this Library item and its local files">
          <Button size="sm" iconOnly className="glass-chip hover:text-danger" disabled={busy} aria-label={`Delete ${entry.videoTitle}`} onClick={onDelete} icon={<Trash2 className="h-3.5 w-3.5" />} />
        </HoverCard>
      </div>
    </article>
  )
}

/** Saved editing progress and the best clip's thumbnail (or source preview). */
function useRunPreview(entry: HistoryEntry | null, revision: number): { thumb: string | null; remaining: number | null } {
  const [thumb, setThumb] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const outputDir = entry?.outputDir
  useEffect(() => {
    if (!outputDir) { setThumb(null); setRemaining(null); return }
    let cancelled = false
    getApi()
      .history.getJob(outputDir)
      .then(async (raw) => {
        const output = parseJobOutput(raw)
        const best = output?.clips.reduce<JobOutput['clips'][number] | null>(
          (top, c) => (!top || c.virality_score > top.virality_score ? c : top),
          null
        )
        if (cancelled) return null
        setRemaining(null)
        if (output?.editor_project) {
          try {
            // Counts only, cached by main until the project file changes.
            const progress = await getApi().editor.progress(outputDir)
            if (cancelled) return null
            setRemaining(progress.remaining)
            if (!best && progress.previewPath) return loadThumbnail(progress.previewPath, progress.thumbnailMs / 1000)
          } catch { /* Existing exports remain usable if the editor project is unavailable. */ }
        }
        if (cancelled) return null
        if (!best) return null
        return loadThumbnail(clipFilePath(best.s3_url), best.duration_ms > 0 ? best.duration_ms / 2000 : undefined)
      })
      .then((path) => {
        if (!cancelled) setThumb(path ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [outputDir, entry?.clipCount, entry?.candidateCount, entry?.editorProject, entry?.date, revision])
  return { thumb, remaining }
}
