import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, Clapperboard, HardDrive, RefreshCw, Video } from 'lucide-react'
import type { OutputStorageUsage, SourceStorageSummary, StorageCleanupKind, StorageCleanupResult } from '../../shared/output-storage'
import { getApi } from '../lib/ipc'
import { Button } from './ui/Button'
import { formatBytes } from '../lib/utils'
import { StorageCleanupDialog } from './StorageCleanupDialog'

export function OutputStorage({ outputDirectory }: { outputDirectory: string }): React.JSX.Element {
  const [refresh, setRefresh] = useState(0)
  const [usage, setUsage] = useState<OutputStorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [sources, setSources] = useState<SourceStorageSummary | null>(null)
  const [sourceError, setSourceError] = useState(false)
  const [cleanup, setCleanup] = useState<StorageCleanupKind | null>(null)
  const [notice, setNotice] = useState<StorageCleanupResult | null>(null)
  const closeCleanup = useCallback(() => setCleanup(null), [])
  const cleaned = useCallback((result: StorageCleanupResult) => {
    setCleanup(null); setNotice(result); setRefresh(value => value + 1)
  }, [])

  useEffect(() => { setCleanup(null); setNotice(null) }, [outputDirectory])
  useEffect(() => {
    let cancelled = false
    setSources(null); setSourceError(false)
    void (async () => {
      try {
        const result = await getApi().settings.sourceStorage()
        if (!cancelled) {
          if (result.outputDirectory !== outputDirectory) throw new Error('Output folder changed')
          setSources(result)
        }
      } catch { if (!cancelled) setSourceError(true) }
    })()
    return () => { cancelled = true }
  }, [outputDirectory, refresh])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setUsage(null)
    setFailure(null)
    if (outputDirectory) {
      // A renderer hot update can arrive before Electron restarts its preload.
      // Catch synchronous bridge failures as well as rejected IPC requests.
      void (async () => {
        try {
          const storageUsage = getApi().settings.storageUsage
          if (typeof storageUsage !== 'function') {
            if (!cancelled) setFailure('Restart BridgeClip to load the storage display.')
            return
          }
          const result = await storageUsage(refresh > 0)
          if (!cancelled) {
            if (result.outputDirectory === outputDirectory) setUsage(result)
            else setFailure('The output folder changed. Refresh to recalculate its size.')
          }
        } catch {
          if (!cancelled) setFailure('Could not read the output folder. Check that it is accessible and try refreshing.')
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    } else setLoading(false)
    return () => { cancelled = true }
  }, [outputDirectory, refresh])

  return (
    <section aria-label="Content storage" className="mt-4 border-t border-white/[0.06] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
          <HardDrive aria-hidden className="h-4 w-4 text-ink-muted" />
          Content storage
        </h3>
        <Button size="sm" variant="ghost" aria-label="Refresh storage usage" loading={loading} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </Button>
      </div>
      <div role="status" className="mt-2">
        {loading ? <p className="text-xs text-ink-muted">Calculating size…</p> : failure ? (
          <p className="text-xs text-warning">{failure}</p>
        ) : usage && (
          <>
            <p className="text-xl font-semibold tabular-nums text-ink">{(usage.unreadableCount > 0 || usage.truncated) && 'At least '}{formatBytes(usage.bytes)}</p>
            <p className="mt-0.5 text-2xs text-ink-muted">
              {usage.exists ? `${usage.fileCount.toLocaleString()} ${usage.fileCount === 1 ? 'file' : 'files'} · Total file size in your output folder` : 'Your output folder has not been created yet.'}
            </p>
            {usage.unreadableCount > 0 && <p className="mt-1 text-2xs text-warning">Some files or folders could not be read. Refresh to try again.</p>}
            {usage.truncated && <p className="mt-1 text-2xs text-ink-muted">This folder is very large or deeply nested, so counting stopped early.</p>}
          </>
        )}
      </div>
      <p className="mt-2 break-all text-2xs text-ink-subtle">{outputDirectory}</p>
      <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5"><Clapperboard size={17} className="text-ink-muted" /><div><p className="text-xs font-medium text-ink">Published content</p><p className="mt-1 text-2xs text-ink-muted">Clear local copies. Keep your online posts.</p></div></div>
          <Button size="sm" disabled={loading || Boolean(failure) || !usage?.exists} onClick={() => setCleanup('published')}>Clean published content</Button>
        </div>
      </div>
      {sources && (sources.projects > 0 || sources.unavailableProjects > 0) && <section aria-label="Source file storage" className="mt-2 rounded-xl border border-white/[0.07] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5"><Video size={17} className="text-ink-muted" /><div><h4 className="text-xs font-medium text-ink">Source files</h4><p className="mt-1 text-2xs text-ink-muted">Retained for Review & edit</p></div></div>
          <Button size="sm" onClick={() => setCleanup('sources')}>Review sources</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3 border-t border-white/[0.06] pt-3">
          <div><p className="text-base font-semibold tabular-nums text-ink">{formatBytes(sources.sourceBytes)}</p><p className="text-2xs text-ink-muted">Source videos</p></div>
          <div><p className="text-base font-semibold tabular-nums text-ink">{formatBytes(sources.previewBytes)}</p><p className="text-2xs text-ink-muted">Editor previews</p></div>
          <div className="ml-auto text-right"><p className="text-base font-semibold tabular-nums text-success">{formatBytes(sources.readyBytes)}</p><p className="text-2xs text-ink-muted">Ready to free · {sources.readyProjects} {sources.readyProjects === 1 ? 'project' : 'projects'}</p></div>
        </div>
        {sources.unfinishedProjects > 0 && <p className="mt-2 text-2xs text-ink-subtle">{sources.unfinishedProjects} {sources.unfinishedProjects === 1 ? 'project still has' : 'projects still have'} clips to finish.</p>}
        {sources.unavailableProjects > 0 && <p className="mt-2 text-2xs text-warning">Some source files couldn’t be checked. Refresh to try again.</p>}
      </section>}
      {sourceError && <p className="mt-2 text-2xs text-warning">Source storage couldn’t be checked. Refresh to try again.</p>}
      {notice && <div role="status" className="mt-3 flex items-start gap-2 text-xs text-ink-muted">{notice.failed > 0 ? <AlertCircle size={15} className="shrink-0 text-warning" /> : <Check size={15} className="shrink-0 text-success" />}<p>Cleaned {notice.cleaned} {notice.cleaned === 1 ? 'project' : 'projects'}.{notice.skipped > 0 && ` ${notice.skipped} changed since the preview and were kept.`}{notice.failed > 0 && ` ${notice.failed} couldn’t be fully cleaned. Close any apps using those files, restart BridgeClip and review storage again.`}</p></div>}
      {cleanup && <StorageCleanupDialog kind={cleanup} onClose={closeCleanup} onCleaned={cleaned} />}
    </section>
  )
}
