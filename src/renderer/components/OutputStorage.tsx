import { useEffect, useState } from 'react'
import { HardDrive, RefreshCw } from 'lucide-react'
import type { OutputStorageUsage } from '../../shared/output-storage'
import { getApi } from '../lib/ipc'
import { Button } from './ui/Button'
import { formatBytes } from '../lib/utils'

export function OutputStorage({ outputDirectory }: { outputDirectory: string }): React.JSX.Element {
  const [refresh, setRefresh] = useState(0)
  const [usage, setUsage] = useState<OutputStorageUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)

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
    }
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
    </section>
  )
}
