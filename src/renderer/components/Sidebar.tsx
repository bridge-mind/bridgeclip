import { ChevronRight, Film, Layers, PanelLeftClose, PanelLeftOpen, Send, Settings, UsersRound, WandSparkles, Workflow, type LucideIcon } from 'lucide-react'
import { cn, MOD_KEY, sourceLabel } from '../lib/utils'
import { useIsWide, useSidebarExpanded, useSidebarStore } from '../store/use-sidebar-store'
import { useActiveJobs } from '../store/use-job-store'
import { useSetupState } from '../store/use-settings-store'
import { APP_VERSION } from '../config/brand'
import { BridgeClipLogo } from './brand/BridgeClipLogo'
import { ProgressBar } from './ui/ProgressBar'
import { StatusDot } from './ui/Badge'
import { STAGE_LABELS } from './JobProgress'

export type Page = 'clip' | 'library' | 'jobs' | 'accounts' | 'posts' | 'automations' | 'settings'

export const NAV_ITEMS: { id: Page; label: string; icon: LucideIcon; shortcut: string; group: 'studio' | 'app' }[] = [
  { id: 'clip', label: 'Create', icon: WandSparkles, shortcut: '1', group: 'studio' },
  { id: 'library', label: 'Library', icon: Film, shortcut: '2', group: 'studio' },
  { id: 'jobs', label: 'Jobs', icon: Layers, shortcut: '3', group: 'studio' },
  { id: 'accounts', label: 'Accounts', icon: UsersRound, shortcut: '4', group: 'app' },
  { id: 'posts', label: 'Posts', icon: Send, shortcut: '5', group: 'app' },
  { id: 'automations', label: 'Automations', icon: Workflow, shortcut: '6', group: 'app' },
  { id: 'settings', label: 'Settings', icon: Settings, shortcut: ',', group: 'app' }
]

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
}

/** Shortcut that collapses and expands the sidebar (⌘\ on macOS, Ctrl+\ elsewhere). */
export const SIDEBAR_SHORTCUT_KEY = '\\'

/**
 * Full sidebar (200px), or a 72px icon rail when the user collapses it or the
 * window is narrower than 1024px. Labels stay available to screen readers and
 * as tooltips in the rail.
 */
export function Sidebar({ currentPage, onNavigate }: SidebarProps): React.JSX.Element {
  const expanded = useSidebarExpanded()
  return (
    <aside
      id="sidebar"
      className={cn(
        'no-drag relative flex shrink-0 flex-col overflow-hidden border-r border-white/[0.06] transition-[width] duration-200 ease-out',
        expanded ? 'w-[200px]' : 'w-[72px]'
      )}
    >
      {/* Title-bar strip: the macOS traffic lights sit here. Matches Layout's strip height. */}
      <div className="drag h-10 shrink-0" />

      <div className={cn('flex h-9 items-center pb-3', expanded ? 'justify-between pl-4 pr-2.5' : 'justify-center px-2')}>
        {expanded ? (
          <>
            <BridgeClipLogo className="h-5" />
            <SidebarToggle />
          </>
        ) : (
          <SidebarToggle rail />
        )}
      </div>

      <nav className={expanded ? 'px-2.5' : 'px-3'} aria-label="Main">
        <NavGroup label="Studio" expanded={expanded}>
          {NAV_ITEMS.filter((item) => item.group === 'studio').map((item) => (
            <NavButton key={item.id} item={item} expanded={expanded} active={currentPage === item.id} onNavigate={onNavigate} />
          ))}
        </NavGroup>
        <NavGroup label="Workspace" expanded={expanded} className={cn('mt-4', !expanded && 'mx-2 border-t border-white/[0.06] pt-3 [&>div]:-mx-2')}>
          {NAV_ITEMS.filter((item) => item.group === 'app').map((item) => (
            <NavButton key={item.id} item={item} expanded={expanded} active={currentPage === item.id} onNavigate={onNavigate} />
          ))}
        </NavGroup>
      </nav>

      <div className={cn('mt-auto space-y-1.5', expanded ? 'p-2.5' : 'p-2')}>
        {currentPage !== 'jobs' && <ActiveJobsCard expanded={expanded} onOpen={() => onNavigate('jobs')} />}
        <div className={cn('flex items-center gap-1', !expanded && 'justify-center')}>
          <SetupStatus expanded={expanded} onOpenSettings={() => onNavigate('settings')} />
          {expanded && <span className="shrink-0 pr-2 font-mono text-[10px] tabular text-ink-faint">v{APP_VERSION}</span>}
        </div>
      </div>
    </aside>
  )
}

/**
 * Collapse/expand control, part of the sidebar itself. Expanded, it sits at
 * the right of the logo row. In the rail, the brand mark is the control and
 * turns into the expand icon on hover or focus. Narrow windows force the rail,
 * so there the mark is only a mark.
 */
function SidebarToggle({ rail = false }: { rail?: boolean }): React.JSX.Element {
  const wide = useIsWide()
  const expanded = useSidebarExpanded()
  const toggle = useSidebarStore((s) => s.toggle)
  if (rail && !wide) return <BridgeClipLogo variant="mark" className="h-6" />
  const label = expanded ? 'Collapse sidebar' : 'Expand sidebar'
  const hint = `${label} (${MOD_KEY}${SIDEBAR_SHORTCUT_KEY})`
  if (!rail && !wide) return <span />
  return (
    <button
      onClick={toggle}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls="sidebar"
      title={hint}
      className={cn(
        'group/toggle relative flex shrink-0 items-center justify-center text-ink-subtle transition-colors duration-150 hover:bg-white/[0.07] hover:text-ink',
        rail ? 'h-9 w-9 rounded-xl' : 'h-7 w-7 rounded-lg'
      )}
    >
      {rail ? (
        <>
          <BridgeClipLogo variant="mark" className="h-6 transition-opacity duration-150 group-hover/toggle:opacity-0 group-focus-visible/toggle:opacity-0" />
          <PanelLeftOpen className="absolute h-4 w-4 opacity-0 transition-opacity duration-150 group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100" strokeWidth={1.9} />
        </>
      ) : (
        <PanelLeftClose className="h-4 w-4" strokeWidth={1.9} />
      )}
    </button>
  )
}

function NavGroup({ label, expanded, className, children }: { label: string; expanded: boolean; className?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={className}>
      {expanded && <p aria-hidden className="eyebrow mb-1 px-2.5 text-[10px] text-ink-faint">{label}</p>}
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function NavButton({ item, expanded, active, onNavigate }: {
  item: (typeof NAV_ITEMS)[number]
  expanded: boolean
  active: boolean
  onNavigate: (page: Page) => void
}): React.JSX.Element {
  const Icon = item.icon
  const liveJobs = useActiveJobs().length
  const badge = item.id === 'jobs' && liveJobs > 0 ? liveJobs : null
  return (
    <button
      onClick={() => onNavigate(item.id)}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${item.label}, ${badge} active` : item.label}
      title={expanded ? undefined : badge ? `${item.label} · ${badge} active` : item.label}
      className={cn(
        'group relative flex w-full items-center gap-2.5 text-sm transition-[background,color,box-shadow] duration-200 ease-out',
        expanded ? 'h-8 justify-start rounded-full px-3' : 'h-9 justify-center rounded-xl',
        active
          ? 'bg-white/[0.1] font-medium text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.16),inset_0_0_0_1px_rgb(255_255_255/0.08)]'
          : 'text-ink-muted hover:bg-white/[0.05] hover:text-ink'
      )}
    >
      <Icon
        className={cn(
          'h-4 w-4 shrink-0 transition-colors',
          active ? 'text-accent-hover' : 'text-ink-subtle group-hover:text-ink-muted'
        )}
        strokeWidth={active ? 2.2 : 1.9}
      />
      {!expanded && badge && (
        <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_0_2px_rgb(var(--canvas))]" />
      )}
      {expanded && (
        <>
          <span className="flex-1 truncate text-left">{item.label}</span>
          {badge && (
            <span aria-hidden className="rounded-full bg-accent/20 px-1.5 font-mono text-2xs tabular text-accent-hover group-hover:hidden">{badge}</span>
          )}
          <kbd className="font-sans text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
            {MOD_KEY}
            {item.shortcut}
          </kbd>
        </>
      )}
    </button>
  )
}

/** Live jobs at a glance: one job shows its stage; several show a count and their average progress. */
function ActiveJobsCard({ expanded, onOpen }: { expanded: boolean; onOpen: () => void }): React.JSX.Element | null {
  const jobs = useActiveJobs()
  if (jobs.length === 0) return null
  const running = jobs.filter((job) => job.status !== 'queued')
  const queued = jobs.length - running.length
  const percent = running.length > 0 ? Math.round(running.reduce((sum, job) => sum + job.percent, 0) / running.length) : 0
  const single = jobs.length === 1 ? jobs[0] : null
  const title = single
    ? (STAGE_LABELS[single.status] ?? 'Working')
    : `${running.length} running${queued > 0 ? ` · ${queued} queued` : ''}`

  return (
    <button
      onClick={onOpen}
      aria-label={`${title}, ${percent}%. Open jobs`}
      title={expanded ? undefined : `${title} · ${percent}%`}
      className={cn('glass-tile glass-tile-hover group w-full rounded-xl text-left animate-fade-in', expanded ? 'p-2.5' : 'p-1.5')}
    >
      <div className={cn('flex items-center gap-2 text-xs', !expanded && 'justify-center')}>
        {expanded && <StatusDot tone="accent" pulse />}
        {expanded && <span className="truncate font-medium text-ink">{title}</span>}
        <span className={cn('font-mono text-2xs tabular text-accent-hover', expanded && 'ml-auto')}>{percent}%</span>
      </div>
      <ProgressBar value={percent} className={cn('h-1', expanded ? 'mt-2' : 'mt-1.5')} />
      {expanded && (
        <p className="mt-1.5 flex items-center gap-1 text-2xs text-ink-subtle">
          <span className="truncate">{single ? sourceLabel(single.request.videoUrl) : 'View all jobs'}</span>
          <ChevronRight className="ml-auto h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </p>
      )}
    </button>
  )
}

function SetupStatus({ expanded, onOpenSettings }: { expanded: boolean; onOpenSettings: () => void }): React.JSX.Element {
  const { ready, missingKeys, toolsOk } = useSetupState()

  let tone: 'success' | 'warning' | 'danger' | 'idle' = 'success'
  let label = 'Ready to clip'
  if (missingKeys.length > 0) {
    tone = 'warning'
    label = missingKeys.length === 2 ? 'Add API keys' : `Add ${missingKeys[0]} key`
  } else if (toolsOk === false) {
    tone = 'danger'
    label = 'System check failed'
  } else if (toolsOk === null) {
    tone = 'idle'
    label = 'Checking system…'
  }

  return (
    <button
      onClick={onOpenSettings}
      aria-label={label}
      title={expanded ? undefined : label}
      className={cn(
        'flex h-8 min-w-0 items-center gap-2 rounded-full text-xs transition-colors hover:bg-white/[0.06]',
        expanded ? 'flex-1 justify-start px-3' : 'w-9 justify-center',
        ready ? 'text-ink-subtle hover:text-ink-muted' : 'text-ink-muted hover:text-ink'
      )}
    >
      <StatusDot tone={tone} />
      {expanded && <span className="truncate">{label}</span>}
    </button>
  )
}
