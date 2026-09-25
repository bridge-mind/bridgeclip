import { useCallback, useState } from 'react'
import { ArrowUpRight, FolderInput, RefreshCw, RotateCw } from 'lucide-react'
import type { UpdateState } from '../../shared/updates'
import { cn, formatRelativeDate } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { useUpdateStore } from '../store/use-update-store'
import { useActiveJobs } from '../store/use-job-store'
import { Button } from './ui/Button'
import { StatusDot } from './ui/Badge'
import { ConfirmDialog, type ConfirmRequest } from './ui/ConfirmDialog'

/**
 * Restart into the downloaded update. Restarting stops clipping jobs, so ask
 * first when any are queued or running.
 */
function useRestartToUpdate(): { restart: () => void; dialog: React.JSX.Element | null } {
  const activeJobs = useActiveJobs().length
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const close = useCallback(() => setRequest(null), [])
  const install = (): void => { void getApi().update.install().catch(() => {}) }
  const restart = (): void => {
    if (activeJobs === 0) return install()
    setRequest({
      title: 'Restart to update?',
      body: `${activeJobs === 1 ? 'A clipping job is' : `${activeJobs} clipping jobs are`} still running. Restarting stops ${activeJobs === 1 ? 'it' : 'them'}; the update also installs the next time you quit BridgeClip.`,
      confirmLabel: 'Restart anyway',
      tone: 'danger',
      onConfirm: install
    })
  }
  return { restart, dialog: request && <ConfirmDialog request={request} onClose={close} /> }
}

/** Sidebar footer: appears once an update has downloaded. */
export function SidebarUpdateButton({ expanded }: { expanded: boolean }): React.JSX.Element | null {
  const update = useUpdateStore((s) => s.update)
  const { restart, dialog } = useRestartToUpdate()
  if (update?.status !== 'ready') return null
  const label = `BridgeClip ${update.version} is ready. Restart to update`
  return (
    <>
      <button
        onClick={restart}
        aria-label={label}
        title={expanded ? undefined : label}
        className={cn('glass-tile glass-tile-hover group w-full rounded-xl text-left animate-fade-in', expanded ? 'px-2.5 py-2' : 'p-1.5')}
      >
        <div className={cn('flex items-center gap-2 text-xs', !expanded && 'justify-center')}>
          {expanded ? <StatusDot tone="accent" /> : <RotateCw className="h-3.5 w-3.5 text-accent-hover" aria-hidden />}
          {expanded && <span className="truncate font-medium text-ink">Update ready</span>}
          {expanded && <span className="ml-auto shrink-0 text-2xs font-medium text-accent-hover">Restart</span>}
        </div>
      </button>
      {dialog}
    </>
  )
}

function describe(update: UpdateState): string {
  const checked = update.lastCheckedAt ? ` Last checked ${formatRelativeDate(update.lastCheckedAt).replace(/^(Today|Yesterday)/, (day) => day.toLowerCase())}.` : ''
  switch (update.status) {
    case 'off':
      return {
        development: 'Updates are off when running from source. Pull the latest code to update.',
        unofficial: 'Updates are off for builds not signed by BridgeMind. Download the official app from bridgeclip.ai to get updates.',
        'move-to-applications': 'Move BridgeClip to your Applications folder to get updates.',
        disabled: 'Updates are turned off (BRIDGECLIP_DISABLE_AUTO_UPDATE).'
      }[update.reason]
    case 'idle':
      return `BridgeClip checks for updates automatically.${checked}`
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `You have the latest version.${checked}`
    case 'downloading': {
      const percent = update.progress ? ` ${Math.round(update.progress.percent)}%` : ''
      return `Downloading version ${update.version}…${percent}`
    }
    case 'ready':
      return `Version ${update.version} is ready. Restart to install it, or it installs the next time you quit.`
    case 'error':
      return `${update.message}${checked}`
  }
}

/** Settings → About: current state and the one action that fits it. */
export function UpdatesRow(): React.JSX.Element | null {
  const update = useUpdateStore((s) => s.update)
  const { restart, dialog } = useRestartToUpdate()
  if (!update) return null
  const api = getApi().update
  const busy = update.status === 'checking' || update.status === 'downloading'

  let action: React.JSX.Element | null = null
  if (update.status === 'ready') {
    action = <Button size="sm" variant="primary" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={restart}>Restart to update</Button>
  } else if (update.status === 'off') {
    if (update.reason === 'move-to-applications') {
      action = <Button size="sm" icon={<FolderInput className="h-3.5 w-3.5" />} onClick={() => void api.moveToApplications()}>Move to Applications</Button>
    }
  } else {
    action = (
      <Button
        size="sm"
        onClick={() => void api.check().catch(() => {})}
        disabled={busy}
        icon={<RefreshCw className={cn('h-3.5 w-3.5', update.status === 'checking' && 'animate-spin')} />}
      >
        Check for updates
      </Button>
    )
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <StatusDot tone={update.status === 'error' ? 'warning' : update.status === 'ready' || busy ? 'accent' : update.status === 'up-to-date' ? 'success' : 'idle'} pulse={busy} />
          Updates
        </p>
        <p role="status" className="mt-0.5 text-2xs leading-relaxed text-ink-subtle">{describe(update)}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(update.status === 'downloading' || update.status === 'ready') && (
          <Button size="sm" variant="ghost" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => void api.openReleaseNotes()}>
            What’s new
          </Button>
        )}
        {action}
      </div>
      {dialog}
    </div>
  )
}
