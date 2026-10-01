import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DragDropContext, Draggable, Droppable, type DraggableProvided, type DropResult } from '@hello-pangea/dnd'
import { Check, FolderOpen, GripVertical, Info, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { canReorderContent, reorderQueuedContent, hasAutomationWarnings, hasContentWarnings, hasEnhancedMetadata } from '../../shared/automations'
import { MAX_ENHANCEMENT_GUIDANCE, AUTOMATION_PLATFORMS, needsTikTokReview, nextAutomationContent, type Automation, type AutomationContent, type AutomationContentStatus, type AutomationUpdate, type AutomationSourceGroup, type MissedSlotNotice } from '../../shared/automations'
import { isPostableAccount, isValidProfileName } from '../../shared/zernio'
import { AutomationTikTokReviewDialog } from '../components/AutomationTikTokReviewDialog'
import { ZernioStatusCheck } from '../components/ZernioStatusCheck'
import { AutomationMetadataDialog } from '../components/AutomationMetadataDialog'
import { PlatformIcon, platformName } from '../components/PlatformIcon'
import { ActionMenu } from '../components/ui/ActionMenu'
import { HoverCard } from '../components/ui/HoverCard'
import { Badge, StatusDot } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Field, TextArea, TextInput } from '../components/ui/Field'
import { Select } from '../components/ui/Select'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Segmented } from '../components/ui/Segmented'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { useAccountsStore } from '../store/use-accounts-store'
import { useSettingsStore } from '../store/use-settings-store'
import { getApi } from '../lib/ipc'
import { useDataVersion } from '../store/use-data-version-store'
import { cn, errorMessage, formatRelativeDate, isMac } from '../lib/utils'
import type { Page as PageName } from '../components/Sidebar'

function draftFor(automation: Automation): AutomationUpdate {
  return { name: automation.name, enabled: automation.enabled, profileId: automation.profileId, metadataMode: automation.metadataMode, accounts: automation.accounts, times: automation.times, timezone: automation.timezone, youtubeVisibility: automation.youtubeVisibility, youtubeMadeForKids: automation.youtubeMadeForKids }
}

const SELECTED_STORAGE_KEY = 'bridgeclip.automations.selectedId'

function rememberSelection(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(SELECTED_STORAGE_KEY, id)
    else sessionStorage.removeItem(SELECTED_STORAGE_KEY)
  } catch { /* Optional convenience only. */ }
}

/** What the backend requires before an automation can be switched on. */
function missingSetup(value: Pick<AutomationUpdate, 'profileId' | 'accounts' | 'times'>): boolean {
  return !value.profileId || value.accounts.length === 0 || value.times.length === 0
}

function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  return `${((hours + 11) % 12) + 1}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}

function timeList(times: readonly string[]): string {
  const labels = times.map(formatTime)
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

function missedNoticeText(notice: MissedSlotNotice): string {
  const skipped = notice.skipped.length
    ? `Skipped ${timeList(notice.skipped)} because BridgeClip was closed or asleep.` : 'BridgeClip was closed or asleep at the scheduled time.'
  return `${skipped}${notice.late ? ` The ${formatTime(notice.late)} post went out late.` : ''} Keep BridgeClip open to post on schedule.`
}

/** The next daily slot in the automation's own time zone. */
function nextRunLabel(times: readonly string[], timezone: string): string | null {
  if (times.length === 0) return null
  let current: string
  try {
    current = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now())
  } catch { return null }
  const sorted = [...times].sort()
  const next = sorted.find((time) => time > current)
  return next ? `Today ${formatTime(next)}` : `Tomorrow ${formatTime(sorted[0])}`
}

function timeZones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  return supported.includes(current) ? supported : [current, ...supported]
}

const CONTENT_STATUS: Record<AutomationContentStatus, { label: string; tone: 'idle' | 'accent' | 'success' | 'warning' }> = {
  queued: { label: 'Queued', tone: 'idle' },
  posting: { label: 'Posting', tone: 'accent' },
  posted: { label: 'Submitted', tone: 'success' },
  needs_review: { label: 'Needs review', tone: 'warning' }
}

const LIST_FORMAT = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

export function AutomationsPage({ onNavigate, onViewLibrary }: { onNavigate: (page: PageName) => void; onViewLibrary: (outputDir: string, clipIndex?: number) => void }): React.JSX.Element {
  const configured = useSettingsStore((state) => state.zernioConfigured)
  const writingConfigured = useSettingsStore((state) => state.openrouterConfigured)
  const { accounts, profiles, hydrate, load: loadAccounts, loading: accountsLoading, setProfile, createProfile } = useAccountsStore()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SELECTED_STORAGE_KEY) } catch { return null }
  })
  const initialSelectionDone = useRef(false)
  const [draft, setDraft] = useState<AutomationUpdate | null>(null)
  const [creating, setCreating] = useState(false)
  const [newProfileOpen, setNewProfileOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [newTime, setNewTime] = useState('09:00')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Do not let an in-flight poll replace the list during a drag or a save.
  const contentInteraction = useRef(false)
  const refreshVersion = useRef(0)
  const [editing, setEditing] = useState<{ id: string; title: string; caption: string } | null>(null)
  const [enhancing, setEnhancing] = useState<{ automationId: string; contentId: string } | null>(null)
  const [bulkProgress, setBulkProgress] = useState<string | null>(null)
  const stopBulk = useRef(false)
  const [sourceGroups, setSourceGroups] = useState<AutomationSourceGroup[] | null>(null)
  const [sourceGroupKey, setSourceGroupKey] = useState('')
  const [sourceGuidance, setSourceGuidance] = useState<Record<string, string>>({})
  const activeSourceGroup = sourceGroups?.find((group) => group.key === sourceGroupKey)
  const [tiktokReview, setTiktokReview] = useState<AutomationContent | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const closeConfirm = useCallback(() => setConfirm(null), [])
  const selected = automations.find((automation) => automation.id === selectedId) ?? null
  const aiKeysMissing = !writingConfigured
  const automationsVersion = useDataVersion('automations')

  useEffect(() => {
    if (!configured) return
    let active = true
    const refresh = async (): Promise<void> => {
      if (contentInteraction.current) return
      const version = refreshVersion.current
      try {
        const result = await getApi().automations.list()
        if (active && !contentInteraction.current && version === refreshVersion.current) {
          setAutomations(result); setLoaded(true)
          if (!initialSelectionDone.current) {
            initialSelectionDone.current = true
            const initial = result.find((item) => item.id === selectedId) ?? result[0]
            setSelectedId(initial?.id ?? null)
            setDraft(initial ? draftFor(initial) : null)
            rememberSelection(initial?.id ?? null)
          }
        }
      } catch (cause) {
        if (active) { setError(errorMessage(cause, 'Could not load automations.')); setLoaded(true) }
      }
    }
    void refresh()
    void hydrate().then(() => loadAccounts()).catch(() => {})
    const timer = setInterval(() => void refresh(), 5_000)
    return () => { active = false; clearInterval(timer) }
    // automationsVersion: the assistant changed automations; reload now instead of at the next poll.
  }, [configured, hydrate, loadAccounts, automationsVersion])

  const connected = useMemo(() => accounts.filter((account) => account.profileId === draft?.profileId &&
    AUTOMATION_PLATFORMS.some((platform) => platform === account.platform)
  ), [accounts, draft?.profileId])

  const dirty = Boolean(selected && draft && JSON.stringify(draft) !== JSON.stringify(draftFor(selected)))

  const select = (automation: Automation | null): void => {
    setSelectedId(automation?.id ?? null)
    rememberSelection(automation?.id ?? null)
    setDraft(automation ? draftFor(automation) : null)
    setSourceGroups(null); setSourceGroupKey(''); setSourceGuidance({});
    setEditing(null); setTiktokReview(null); setNewProfileOpen(false)
  }

  const mutate = async (action: string, request: () => Promise<Automation[]>, success?: string): Promise<Automation[] | null> => {
    contentInteraction.current = true; refreshVersion.current++
    setBusy(action); setError(null); setNotice(null)
    try {
      const result = await request()
      setAutomations(result)
      if (success) setNotice(success)
      return result
    } catch (cause) {
      setError(errorMessage(cause, 'Could not update the automation.'))
      return null
    } finally { contentInteraction.current = false; refreshVersion.current++; setBusy(null) }
  }

  const prepareEnhancementGroups = async (): Promise<void> => {
    if (!selected) return
    setBusy('group-sources'); setError(null); setSourceGroups(null)
    try {
      const groups = await getApi().automations.enhancementGroups(selected.id)
      if (groups.some((group) => !group.sourceType)) throw new Error('Restart BridgeClip to use source enhancement prompts.')
      setSourceGroups(groups); setSourceGroupKey(groups[0]?.key ?? '')
    } catch (cause) { setError(errorMessage(cause, 'Could not group clips by source.')) }
    finally { setBusy(null) }
  }

  const enhanceQueued = async (): Promise<void> => {
    if (!selected) return
    const group = sourceGroups?.find((group) => group.key === sourceGroupKey)
    if (!group) return
    const ids = group.contentIds.slice(0, 30)
    const guidance = sourceGuidance[group.key] ?? ''
    setBusy('enhance-bulk'); setError(null); setNotice(null); stopBulk.current = false
    let completed = 0
    let skipped = 0
    let attempted = 0
    const failures: string[] = []
    try {
      for (let offset = 0; offset < ids.length; offset += 5) {
        if (stopBulk.current) break
        setBulkProgress(`${group.title} · preparing clips ${offset + 1}–${Math.min(offset + 5, ids.length)} of ${ids.length}`)
        try {
          const result = await getApi().automations.enhanceBatch(selected.id, ids.slice(offset, offset + 5), group.key, guidance)
          setAutomations(result.automations)
          completed += result.completed
          skipped += result.skipped
          attempted += ids.slice(offset, offset + 5).length
          failures.push(...result.errors.map((error) => `${selected.content.find((item) => item.id === error.contentId)?.title ?? 'Clip'}: ${error.message}`))
        } catch (cause) {
          const message = errorMessage(cause, 'Could not generate this batch.')
          const batchIds = ids.slice(offset, offset + 5)
          attempted += batchIds.length
          failures.push(...batchIds.map((id) => `${selected.content.find((item) => item.id === id)?.title ?? 'Clip'}: ${message}`))
        }
      }
      setNotice(`${completed} drafts ready to review · ${failures.length} failed · ${skipped} already handled · ${ids.length - attempted} not attempted. ${stopBulk.current ? 'Stopped after the current batch.' : 'All selected clips were attempted.'} Failed clips remain available to retry; research and transcripts are reused.`)
      if (failures.length) setError(`${failures.length} clips need another attempt. ${failures.slice(0, 3).join(' · ')}`)
    } finally { setBusy(null); setBulkProgress(null); setSourceGroups(null) }
  }

  const create = async (name: string): Promise<boolean> => {
    const result = await mutate('create', () => getApi().automations.create(name))
    if (!result) return false
    select(result[0]); setCreating(false)
    return true
  }

  const save = async (): Promise<void> => {
    if (!selected || !draft) return
    const result = await mutate('save', () => getApi().automations.update(selected.id, draft), 'Changes saved.')
    const updated = result?.find((automation) => automation.id === selected.id)
    if (updated) setDraft(draftFor(updated))
  }

  /** Saves only the on/off state, so other unsaved edits stay in the draft. */
  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (!selected) return
    const result = await mutate('toggle', () => getApi().automations.update(selected.id, { ...draftFor(selected), enabled }), enabled ? `${selected.name} is on.` : `${selected.name} is paused.`)
    if (result) setDraft((current) => current && { ...current, enabled })
  }

  const runNow = async (): Promise<void> => {
    if (!selected) return
    const nextClip = nextAutomationContent(selected)
    if (!nextClip) return
    const result = await mutate('run', () => getApi().automations.run(selected.id))
    const updated = result?.find((automation) => automation.id === selected.id)
    if (!updated) return
    if (updated.lastError) setError(updated.lastError)
    else if (updated.content.find((item) => item.id === nextClip.id)?.status === 'queued') setError('This automation is already running. Try again when it finishes.')
    else setNotice('Run finished. Check the content bank for the result.')
  }

  const retryContent = async (item: AutomationContent): Promise<void> => {
    if (!selected || busy || dirty || editing) return
    const result = await mutate('retry-content', () => getApi().automations.retryContent(selected.id, item.id))
    const updated = result?.find((automation) => automation.id === selected.id)
    if (!updated) return
    if (updated.lastError) setError(updated.lastError)
    else setNotice('Retry finished. Check the clip’s status in the content bank.')
  }

  const remove = (): void => {
    if (!selected) return
    setConfirm({
      title: `Delete ${selected.name}?`,
      body: 'Its schedule and every clip in its content bank are removed. Posts already submitted stay on your accounts.',
      confirmLabel: 'Delete automation',
      onConfirm: async () => {
        const result = await mutate('delete', () => getApi().automations.delete(selected.id))
        if (result) select(result[0] ?? null)
      }
    })
  }

  const addProfile = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selected || !draft || !isValidProfileName(newProfileName)) return
    setBusy('profile'); setError(null); setNotice(null)
    try {
      const profile = await createProfile(newProfileName)
      const updatedDraft = { ...draft, profileId: profile.id, accounts: [], enabled: false }
      const result = await getApi().automations.update(selected.id, updatedDraft)
      setAutomations(result)
      setDraft(updatedDraft)
      setNewProfileName(''); setNewProfileOpen(false)
      setNotice(`Profile “${profile.name}” created. Connect accounts to it, then select them here.`)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not create the Zernio profile.'))
    } finally { setBusy(null) }
  }

  const connectAccount = async (): Promise<void> => {
    if (!selected || !draft?.profileId) return
    const result = await mutate('save', () => getApi().automations.update(selected.id, draft))
    if (!result) return
    setProfile(draft.profileId)
    onNavigate('accounts')
  }

  const saveContent = async (item: AutomationContent): Promise<void> => {
    if (!selected || !editing || editing.id !== item.id) return
    const result = await mutate('content', () => getApi().automations.updateContent(selected.id, item.id, {
      title: editing.title, caption: editing.caption
    }), 'Clip details saved.')
    if (result) setEditing(null)
  }

  const moveContent = async ({ draggableId, source, destination }: DropResult): Promise<void> => {
    contentInteraction.current = false; refreshVersion.current++
    if (!selected || busy || dirty || editing || !destination || source.droppableId !== destination.droppableId || source.index === destination.index) return
    const visibleQueue = selected.content.filter((item) => item.status === 'queued' || item.status === 'posting')
    const target = visibleQueue[destination.index]
    const queue = selected.content.filter(canReorderContent)
    const from = queue.findIndex((item) => item.id === draggableId)
    const to = queue.findIndex((item) => item.id === target?.id)
    if (from < 0 || to < 0) return
    const beforeId = from < to ? queue[to + 1]?.id ?? null : target.id
    const previous = selected.content
    const content = reorderQueuedContent(previous, draggableId, beforeId)
    // Commit immediately so the drop settles into its final place while IPC saves.
    setAutomations((items) => items.map((item) => item.id === selected.id ? { ...item, content } : item))
    const result = await mutate('reorder', () => getApi().automations.reorder(selected.id, draggableId, beforeId))
    if (!result) setAutomations((items) => items.map((item) => item.id === selected.id ? { ...item, content: previous } : item))
  }

  const reviewContent = async (item: AutomationContent, returnToQueue: boolean): Promise<void> => {
    if (!selected || busy) return
    setBusy('review-content'); setError(null); setNotice(null)
    try {
      const result = await getApi().automations.reviewContent(selected.id, item.id, returnToQueue)
      setAutomations(result.automations)
      if (returnToQueue && result.outcome === 'held') setError(result.message)
      else setNotice(result.message)
    } catch (cause) { setError(errorMessage(cause, 'Could not review this clip.')) }
    finally { setBusy(null) }
  }

  const requestReturnToQueue = (item: AutomationContent): void => setConfirm({
    title: 'Return this clip to the queue?',
    tone: 'primary',
    body: item.postId
      ? 'We’ll check its Zernio post first. Published or in-progress posts move to Submitted. Only posts that failed on every account can return to the queue.'
      : 'Confirm this clip was not published to any selected account before returning it. It will be eligible for the next scheduled run.',
    confirmLabel: 'Return to queue',
    onConfirm: () => void reviewContent(item, true)
  })

  const removeContent = (item: AutomationContent): void => {
    if (!selected || item.status === 'posting') return
    // Removing only deletes the bank copy. It never re-queues or retries a post.
    const submitted = item.status === 'posted'
    const linked = !submitted && Boolean(item.postId)
    setConfirm({
      title: submitted ? 'Remove this clip from Submitted?' : linked ? 'Remove this held clip?' : 'Remove this clip from the queue?',
      body: submitted
        ? <>“{item.title}” and its bank copy will be removed from this automation’s history. Its post stays on your accounts and in Posts, and the original file remains available.</>
        : linked
          ? <>“{item.title}” and its bank copy will be removed from this content bank. Its Zernio post is not changed; check Posts before posting this clip again. The original file remains available.</>
          : <>“{item.title}” and its queue copy will be removed from this content bank. The original file will remain available.</>,
      confirmLabel: submitted ? 'Remove from history' : linked ? 'Remove clip' : 'Remove from queue',
      tone: 'primary',
      onConfirm: () => void mutate('remove', () => getApi().automations.removeContent(selected.id, item.id))
    })
  }

  const viewLibrary = async (item: AutomationContent): Promise<void> => {
    if (!selected || busy) return
    setBusy('library'); setError(null); setNotice(null)
    try {
      const run = await getApi().automations.libraryClip(selected.id, item.id)
      if (run) onViewLibrary(run.outputDir, run.clipIndex)
      else setError('This clip’s source run is no longer in the Library, or it was added from outside the Library.')
    } catch (cause) { setError(errorMessage(cause, 'Could not open the source run.')) }
    finally { setBusy(null) }
  }

  const showInFolder = async (item: AutomationContent): Promise<void> => {
    if (!selected || busy) return
    setError(null); setNotice(null)
    try {
      if (!await getApi().automations.showInFolder(selected.id, item.id)) setError('This clip’s video file is no longer available.')
    } catch (cause) { setError(errorMessage(cause, 'Could not show this clip in its folder.')) }
  }

  const addTime = (): void => {
    if (!draft || !newTime || draft.times.includes(newTime) || draft.times.length >= 24) return
    setDraft({ ...draft, times: [...draft.times, newTime].sort() })
  }

  if (!configured) {
    return (
      <Page width="narrow">
        <PageHeader title="Automations" description="Post the next clip from a content bank at set times each day." />
        <EmptyState
          className="mt-4"
          icon={<Workflow />}
          title="Connect Zernio first"
          description="Automations post through Zernio. Add your API key and connect the accounts you want to post to."
          action={<Button variant="primary" onClick={() => onNavigate('accounts')}>Open Accounts</Button>}
        />
      </Page>
    )
  }

  const nextClip = selected ? nextAutomationContent(selected) : undefined
  const queued = selected?.content.filter((item) => item.status === 'queued') ?? []
  const counts = {
    all: selected?.content.length ?? 0,
    queued: queued.length,
    ready: queued.filter((item) => !needsTikTokReview(selected!, item)).length,
    tiktok_review: queued.filter((item) => needsTikTokReview(selected!, item)).length,
    posted: selected?.content.filter((item) => item.status === 'posted').length ?? 0,
    needs_review: selected?.content.filter((item) => item.status === 'needs_review' && hasContentWarnings(item)).length ?? 0
  }
  const reorderDisabled = Boolean(busy) || dirty || Boolean(editing) || Boolean(selected?.content.some((item) => item.status === 'posting'))
  const contentGroups = [
    { label: 'Queued', items: selected?.content.filter((item) => item.status === 'queued' || item.status === 'posting') ?? [], empty: 'No clips waiting to be submitted.' },
    { label: 'Needs attention', items: selected?.content.filter((item) => item.status === 'needs_review' && !item.warningsAcknowledged) ?? [], empty: '' },
    { label: 'Held clips', items: selected?.content.filter((item) => item.status === 'needs_review' && item.warningsAcknowledged) ?? [], empty: '' },
    { label: 'Submitted', items: selected?.content.filter((item) => item.status === 'posted') ?? [], empty: 'No clips submitted yet.' }
  ]
  const nextSlot = selected ? nextRunLabel(selected.times, selected.timezone) : null
  const savedReady = selected ? !missingSetup(selected) && !(selected.metadataMode === 'ai' && aiKeysMissing) : false
  const setupTodo = draft ? [
    !draft.profileId && 'choose a profile',
    draft.accounts.length === 0 && 'select an account',
    draft.times.length === 0 && 'add a daily time',
    counts.queued === 0 && 'add clips',
    draft.metadataMode === 'ai' && aiKeysMissing && 'add an OpenRouter key'
  ].filter((step): step is string => Boolean(step)) : []

  return (
    <Page width="narrow">
      <PageHeader
        title="Automations"
        description="Post the next clip from a content bank at set times each day."
        actions={automations.length > 0 && <>
          {automations.some(hasAutomationWarnings) && <Button size="sm" variant="ghost" icon={<Check className="h-3.5 w-3.5" />} disabled={Boolean(busy)} title="Acknowledge existing warnings across all automations. Held clips stay held; new failures will warn again." onClick={() => void mutate('acknowledge', () => getApi().automations.acknowledgeWarnings(null), 'Warnings acknowledged across all automations. Held clips remain held.')}>Acknowledge all warnings</Button>}
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)} disabled={creating}>New automation</Button>
        </>}
      />

      {(error || notice) && (
        <div className="mt-3 space-y-2">
          {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
          {notice && <Callout tone="success" onDismiss={() => setNotice(null)}>{notice}</Callout>}
        </div>
      )}

      {!loaded && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-1">{[0, 1].map((key) => <Skeleton key={key} className="h-7 w-28 rounded-full" />)}</div>
          <Skeleton className="h-[260px] rounded-3xl" />
          <Skeleton className="h-[160px] rounded-3xl" />
        </div>
      )}

      {loaded && automations.length === 0 && (
        <EmptyState
          className="mt-4"
          icon={<Workflow />}
          title="Create your first automation"
          description="Pick a Zernio profile and its accounts, fill a content bank with clips, and choose daily posting times."
          action={<CreateForm busy={busy === 'create'} onCreate={create} className="w-[320px] max-w-full" />}
        />
      )}

      {loaded && automations.length > 0 && (
        <>
          <nav aria-label="Automations" className="mt-3 flex flex-wrap items-center gap-1">
            {automations.map((automation) => (
              <AutomationTab
                key={automation.id}
                automation={automation}
                selected={automation.id === selectedId}
                onSelect={() => select(automation)}
              />
            ))}
            {creating && <CreateForm size="sm" busy={busy === 'create'} onCreate={create} onCancel={() => setCreating(false)} autoFocus className="w-[280px] max-w-full" />}
          </nav>

          {selected && draft && (
            <div className="mt-2 space-y-2">
              <Panel padded={false}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-sm font-semibold text-ink">{selected.name}</h2>
                    </div>
                    {!selected.enabled && setupTodo.length > 0 ? (
                      <p className="text-2xs text-ink-muted">
                        <span className="text-warning">Finish setup:</span> {LIST_FORMAT.format(setupTodo)}.
                      </p>
                    ) : (
                      <p className="flex flex-wrap gap-x-1.5 text-2xs text-ink-muted">
                        <span><span className="tabular text-ink">{counts.ready}</span> ready</span>
                        {counts.tiktok_review > 0 && <><Sep /><span className="text-warning">{counts.tiktok_review} need TikTok review</span></>}
                        {counts.needs_review > 0 && <><Sep /><span className="text-warning">{counts.needs_review} to check</span></>}
                        {selected.enabled && <><Sep /><span>Next run <span className="text-ink">{nextSlot ?? '—'}</span></span></>}
                        <Sep />
                        <span>Last run <span className="text-ink">{selected.lastRunAt ? formatRelativeDate(selected.lastRunAt) : 'never'}</span></span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <label className={cn('mr-1 flex items-center gap-1.5 text-2xs text-ink-muted', !selected.enabled && !savedReady && 'opacity-60')} title={!selected.enabled && !savedReady ? 'Finish setup and save before turning this on' : undefined}>
                      {selected.enabled ? 'Scheduled' : 'Paused'}
                      <Switch
                        checked={selected.enabled}
                        disabled={Boolean(busy) || (!selected.enabled && !savedReady)}
                        onChange={(value) => void setEnabled(value)}
                        label="Automation on"
                      />
                    </label>
                    <Button
                      size="sm"
                      icon={<Play className="h-3 w-3" />}
                      loading={busy === 'run'}
                      disabled={Boolean(busy) || !nextClip || dirty}
                      title={dirty ? 'Save automation changes first' : !nextClip ? 'Add a clip, then complete any TikTok reviews and enhanced drafts first' : 'Post the next ready clip now'}
                      onClick={() => void runNow()}
                    >Run now</Button>
                    <Button size="sm" variant="ghost" iconOnly aria-label={`Delete ${selected.name}`} title="Delete automation" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={Boolean(busy)} onClick={remove} />
                  </div>
                  {selected.missedNotice && <p className="basis-full text-2xs text-ink-subtle" data-selectable>{missedNoticeText(selected.missedNotice)}</p>}
                  {(selected.lastError || hasAutomationWarnings(selected)) && <div className="flex basis-full flex-wrap items-start justify-between gap-2">
                    {selected.lastError && <details className="min-w-0 flex-1 text-2xs">
                      <summary className={cn('w-fit cursor-pointer', selected.lastErrorAcknowledged ? 'text-ink-subtle' : 'text-warning')}>{selected.lastErrorAcknowledged ? 'Previous run issue · Acknowledged' : 'Last run failed · View details'}</summary>
                      <p className="mt-1 text-ink-muted" data-selectable>{selected.lastError}</p>
                      <p className="mt-1 text-ink-subtle">Saved message from that run. Any wait time shown is not a live countdown.</p>
                    </details>}
                    {hasAutomationWarnings(selected) && <Button size="sm" variant="ghost" icon={<Check className="h-3 w-3" />} disabled={Boolean(busy)} title="Acknowledge this automation’s existing warnings without retrying held clips" onClick={() => void mutate('acknowledge', () => getApi().automations.acknowledgeWarnings(selected.id), 'Warnings acknowledged. Held clips remain held.')}>Acknowledge warnings</Button>}
                  </div>}
                </div>

                <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                  <Row label="Profile" htmlFor="automation-profile">
                    <div className="flex items-center gap-1">
                      <Select
                        id="automation-profile"
                        aria-label="Zernio profile"
                        size="sm"
                        className="min-w-0 flex-1 sm:max-w-[240px]"
                        value={draft.profileId ?? ''}
                        onChange={(profileId) => setDraft({ ...draft, profileId: profileId || null, accounts: [], enabled: false })}
                        options={profiles.map((profile) => ({ value: profile.id, label: profile.name, detail: profile.isOverLimit ? 'over limit' : undefined }))}
                        placeholder="Choose a profile"
                        emptyText="No profiles yet. Create one with New profile."
                      />
                      {!newProfileOpen && <Button size="sm" variant="ghost" onClick={() => setNewProfileOpen(true)}>New profile</Button>}
                    </div>
                    {newProfileOpen && (
                      <form onSubmit={(event) => void addProfile(event)} className="mt-1.5 flex gap-1 sm:max-w-[380px]">
                        <TextInput inputSize="sm" className="flex-1" autoFocus aria-label="New profile name" placeholder="New profile name" value={newProfileName} maxLength={80} onChange={(event) => setNewProfileName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setNewProfileOpen(false) }} />
                        <Button size="sm" type="submit" loading={busy === 'profile'} disabled={!isValidProfileName(newProfileName) || Boolean(busy)}>Create</Button>
                        <Button size="sm" type="button" variant="ghost" iconOnly aria-label="Cancel" icon={<X className="h-3.5 w-3.5" />} onClick={() => setNewProfileOpen(false)} />
                      </form>
                    )}
                  </Row>

                  <Row
                    label="Accounts"
                    labelId="automation-accounts"
                    hint={connected.some((account) => account.platform === 'tiktok') && 'TikTok clips need a one-time review in the content bank before they post.'}
                  >
                    {!draft.profileId ? (
                      <p className="flex h-7 items-center text-2xs text-ink-subtle">Choose a profile first.</p>
                    ) : (
                      <div role="group" aria-labelledby="automation-accounts" className="flex flex-wrap items-center gap-1">
                        {connected.length === 0 && <p className="mr-1 text-2xs text-ink-muted">No supported accounts in this profile yet.</p>}
                        {connected.map((account) => {
                          const available = isPostableAccount(account)
                          const checked = draft.accounts.some((item) => item.accountId === account.id)
                          const handle = account.username ? `@${account.username}` : account.displayName || 'Connected account'
                          return (
                            <button
                              key={account.id}
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              aria-label={`${handle} on ${platformName(account.platform)}`}
                              title={available ? platformName(account.platform) : `${platformName(account.platform)}: reconnect in Accounts`}
                              disabled={!available}
                              onClick={() => setDraft({ ...draft, accounts: checked ? draft.accounts.filter((item) => item.accountId !== account.id) : [...draft.accounts, { accountId: account.id, platform: account.platform as AutomationUpdate['accounts'][number]['platform'] }] })}
                              className={cn(
                                'group/chip inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-full border pl-0.5 pr-2.5 text-xs transition-colors duration-150',
                                checked
                                  ? 'border-accent/60 bg-accent/[0.14] text-ink'
                                  : 'border-white/[0.08] bg-white/[0.03] text-ink-muted hover:border-white/[0.14] hover:text-ink',
                                !available && 'cursor-not-allowed opacity-50 hover:border-white/[0.08] hover:text-ink-muted'
                              )}
                            >
                              <PlatformIcon
                                platform={account.platform}
                                className={cn('h-[22px] w-[22px] rounded-full transition-[filter,opacity] duration-150 [&_svg]:h-3 [&_svg]:w-3', !checked && 'opacity-70 grayscale group-hover/chip:opacity-100 group-hover/chip:grayscale-0')}
                              />
                              <span className="truncate">{handle}</span>
                              {checked && <Check aria-hidden className="-mr-0.5 h-3 w-3 shrink-0 text-accent" strokeWidth={3} />}
                            </button>
                          )
                        })}
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void connectAccount()}
                          className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-white/[0.16] px-2.5 text-xs text-ink-muted transition-colors duration-150 hover:border-white/[0.3] hover:text-ink disabled:opacity-50"
                        >
                          <Plus aria-hidden className="h-3 w-3" />Connect
                        </button>
                        <Button size="sm" variant="ghost" iconOnly aria-label="Refresh accounts" title="Refresh accounts" loading={accountsLoading} onClick={() => void loadAccounts()} icon={<RefreshCw className="h-3 w-3" />} />
                      </div>
                    )}
                    {draft.accounts.length > 0 && <ZernioStatusCheck
                      key={`${selected.id}:${draft.profileId}:${draft.accounts.map((account) => account.accountId).join(',')}`}
                      accounts={draft.accounts.map((account) => {
                        const connectedAccount = accounts.find((item) => item.id === account.accountId)
                        return { ...account, label: connectedAccount?.username ? `@${connectedAccount.username}` : connectedAccount?.displayName || 'Selected account' }
                      })}
                      disabled={Boolean(busy)}
                    />}
                  </Row>

                  <Row
                    label="Schedule"
                    labelId="automation-schedule"
                    hint="One clip at each time, daily. Keep BridgeClip open."
                  >
                    <div role="group" aria-labelledby="automation-schedule" className="flex flex-wrap items-center gap-1">
                      {draft.times.map((time) => (
                        <span key={time} className="inline-flex h-7 items-center rounded-full border border-white/[0.08] bg-white/[0.03] pl-2.5 pr-0.5 font-mono text-2xs tabular text-ink">
                          {formatTime(time)}
                          <button type="button" aria-label={`Remove ${formatTime(time)}`} className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-white/[0.08] hover:text-ink" onClick={() => setDraft({ ...draft, times: draft.times.filter((item) => item !== time) })}>
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                      <TextInput type="time" inputSize="sm" aria-label="New daily time" mono className="w-[120px] [color-scheme:dark]" value={newTime} onChange={(event) => setNewTime(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTime() }} />
                      <Button size="sm" variant="ghost" icon={<Plus className="h-3 w-3" />} onClick={addTime} disabled={!newTime || draft.times.includes(newTime) || draft.times.length >= 24}>Add time</Button>
                      <Select
                        id="automation-timezone"
                        aria-label="Time zone"
                        title="Time zone"
                        size="sm"
                        className="w-[190px] max-w-full"
                        value={draft.timezone}
                        onChange={(timezone) => setDraft({ ...draft, timezone })}
                        options={timeZones(draft.timezone).map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))}
                        searchable
                        searchPlaceholder="Search time zones"
                      />
                    </div>
                  </Row>

                  <details>
                    <summary className="cursor-pointer px-3.5 py-2.5 text-xs text-ink-muted hover:text-ink">More settings</summary>
                    <div className="divide-y divide-white/[0.06]">
                      <Row
                        label="Captions"
                        hint={draft.metadataMode === 'ai' ? 'Uses reviewed drafts first; otherwise AI writes the captions. Review TikTok captions before posting.' : undefined}
                      >
                        <label className="flex h-7 items-center gap-2 text-xs text-ink">
                          <Switch checked={draft.metadataMode === 'ai'} onChange={(on) => setDraft({ ...draft, metadataMode: on ? 'ai' : 'manual' })} label="Write captions with AI" />
                          Write captions with AI
                        </label>
                        {draft.metadataMode === 'ai' && aiKeysMissing && (
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-2xs text-warning">
                            Add an OpenRouter key before turning this automation on.
                            <button type="button" className="font-medium text-ink underline-offset-2 hover:underline" onClick={() => onNavigate('settings')}>Open Settings</button>
                          </p>
                        )}
                      </Row>

                      {draft.accounts.some((account) => account.platform === 'youtube') && (
                        <Row label="YouTube">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                            <Segmented size="sm" label="YouTube visibility" value={draft.youtubeVisibility} onChange={(value) => setDraft({ ...draft, youtubeVisibility: value })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'private', label: 'Private' }]} />
                            <label className="flex items-center gap-2 text-xs text-ink-muted">
                              <Switch checked={draft.youtubeMadeForKids} onChange={(value) => setDraft({ ...draft, youtubeMadeForKids: value })} label="Made for kids" />
                              Made for kids
                            </label>
                          </div>
                        </Row>
                      )}

                      <Row label="Name" htmlFor="automation-name">
                        <TextInput id="automation-name" inputSize="sm" className="sm:max-w-[240px]" value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                      </Row>
                    </div>
                  </details>
                </div>
              </Panel>

              <Panel padded={false}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 py-2">
                  <h2 className="mr-auto text-sm font-semibold text-ink" title="The first ready clip in queue order posts next. Drag queued clips to reorder them. Clips awaiting TikTok review are skipped.">Content bank</h2>
                  <Button size="sm" icon={<Plus className="h-3 w-3" />} loading={busy === 'upload'} onClick={() => void mutate('upload', () => getApi().automations.addContent(selected.id), 'Clips added to the bank.')} disabled={Boolean(busy)}>Add clips</Button>
                </div>
                {selected.content.some((item) => item.status === 'queued' && !hasEnhancedMetadata(item, selected.accounts.length ? selected.accounts.map((account) => account.platform) : ['youtube'])) && <div className="border-t border-white/[0.06] px-3.5 py-3 flex flex-wrap items-center gap-3">
                  <Button size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} disabled={Boolean(busy) || dirty || !writingConfigured} loading={busy === 'group-sources'} onClick={() => void prepareEnhancementGroups()}>Enhance by source video</Button>
                  <span className="text-xs text-ink-subtle">Linked videos & attached files · shared context and research · uses OpenRouter credits{!selected.accounts.length ? ' · drafts for YouTube until accounts are selected' : ''}</span>
                </div>}
                {sourceGroups && <div className="glass-well mt-3 space-y-3 rounded-xl p-3">
                  {sourceGroups.length ? <>
                    <Field label="Original video" htmlFor="enhancement-source-video"><Select id="enhancement-source-video" value={sourceGroupKey} disabled={Boolean(busy)} onChange={setSourceGroupKey} options={sourceGroups.map((group) => ({ value: group.key, label: `${group.title} · ${group.contentIds.length} ${group.contentIds.length === 1 ? 'clip' : 'clips'}` }))} /></Field>
                    <p className="text-xs text-ink-muted">{activeSourceGroup?.sourceType === 'linked'
                      ? 'Linked video · We’ll use the original description. Add a prompt to guide the enhancements.'
                      : 'Attached file · Tell us what the video is about and how you’d like to enhance its clips. No link is needed.'}</p>
                    <Field label="Enhancement prompt (optional)" htmlFor="enhancement-guidance">
                      <TextArea id="enhancement-guidance" rows={3} maxLength={MAX_ENHANCEMENT_GUIDANCE} disabled={Boolean(busy)} value={sourceGuidance[sourceGroupKey] ?? ''}
                        onChange={(event) => setSourceGuidance((previous) => ({ ...previous, [sourceGroupKey]: event.target.value }))}
                        placeholder="e.g. A workshop on building reliable AI tools. Focus on practical tips for developers, with clear, conversational titles." />
                    </Field>
                    <p className="text-xs text-ink-subtle">Describe the topic, audience, tone, or points to emphasize. Each draft stays grounded in what its clip actually says. Up to {MAX_ENHANCEMENT_GUIDANCE.toLocaleString()} characters.</p>
                    <p className="text-xs text-ink-muted">Research is shared across this video’s clips and reused for 7 days when the context and prompt match. Each clip keeps its own transcript and reviewable draft. Already reviewed metadata is skipped. Up to 30 clips per batch.</p>
                    <Button size="sm" disabled={Boolean(busy) || dirty} onClick={() => void enhanceQueued()}>Enhance {Math.min(30, activeSourceGroup?.contentIds.length ?? 0)} {activeSourceGroup?.contentIds.length === 1 ? 'clip' : 'clips'} from this video</Button>
                  </> : <p className="text-sm text-ink-muted">No queued clips need a new draft.</p>}
                </div>}
                {bulkProgress && <Callout tone="info" className="mt-3" action={<Button size="sm" onClick={() => { stopBulk.current = true; setBulkProgress('Stopping after the current operation…') }}>Stop after batch</Button>}>{bulkProgress}</Callout>}
                <DragDropContext key={selected.id} onBeforeCapture={() => { contentInteraction.current = true; refreshVersion.current++ }} onDragEnd={(result) => void moveContent(result)}>
                  {contentGroups.filter((group) => !['Needs attention', 'Held clips'].includes(group.label) || group.items.length > 0).map((group) => (
                    <section key={group.label} aria-label={group.label} className="border-t border-white/[0.06]">
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-white/[0.02] px-3.5 py-2.5">
                        <h3 className="flex items-center gap-2 text-xs font-semibold text-ink-muted">{group.label}<span className="tabular rounded-full bg-white/[0.06] px-2 py-0.5 text-2xs">{group.items.length}</span></h3>
                        {group.label === 'Queued' && <span role="status" aria-label="Next posting slot" className="ml-auto text-right text-2xs text-ink-muted">
                          {!nextSlot ? 'No times scheduled' : !selected.enabled ? 'Paused' : <>Next slot <span className="text-ink">{nextSlot}</span><span className="text-ink-subtle"> · {selected.timezone.replace(/_/g, ' ')}</span></>}
                        </span>}
                      </div>
                      {group.label === 'Held clips' && <p className="px-3.5 py-2 text-2xs text-ink-subtle">Warnings acknowledged. These clips stay out of the queue until you review and return them.</p>}
                      {group.items.length === 0 && <p className="px-3.5 py-4 text-xs text-ink-subtle">{group.empty}</p>}
                      <Droppable droppableId={group.label} isDropDisabled={group.label !== 'Queued' || reorderDisabled}>
                        {(listProvided, listSnapshot) => <ul ref={listProvided.innerRef} {...listProvided.droppableProps} className={cn('divide-y divide-white/[0.06] transition-colors', listSnapshot.isDraggingOver && 'bg-accent/[0.035]')}>
                          {group.items.map((item, index) => (
                            <Draggable key={item.id} draggableId={item.id} index={index} isDragDisabled={reorderDisabled || !canReorderContent(item)}>
                              {(provided, snapshot) => <ContentRow
                                dragProvided={provided}
                                dragging={snapshot.isDragging}
                                item={item}
                                nextUp={item.id === nextClip?.id}
                                tiktokReviewNeeded={item.status === 'queued' && needsTikTokReview(selected, item)}
                                tiktokSelected={selected.accounts.some((account) => account.platform === 'tiktok')}
                                onReviewTikTok={() => setTiktokReview(item)}
                                reviewDisabled={dirty || editing?.id === item.id}
                                editing={editing?.id === item.id ? editing : null}
                                busy={Boolean(busy)}
                                onEdit={() => setEditing(editing?.id === item.id ? null : { id: item.id, title: item.title, caption: item.caption })}
                                onEnhance={() => setEnhancing({ automationId: selected.id, contentId: item.id })}
                                enhancementDisabled={dirty || !writingConfigured}
                                enhanced={hasEnhancedMetadata(item, selected.accounts.length ? selected.accounts.map((account) => account.platform) : ['youtube'])}
                                onRetry={() => void retryContent(item)}
                                retryDisabled={dirty || Boolean(editing) || needsTikTokReview(selected, item)}
                                onDismissError={() => { if (!busy) void mutate('dismiss-warning', () => getApi().automations.acknowledgeWarnings(selected.id, item.id)) }}
                                onDismissMetadataError={() => { if (!busy) void mutate('dismiss-metadata', () => getApi().automations.dismissMetadataError(selected.id, item.id)) }}
                                onChange={setEditing}
                                onSave={() => void saveContent(item)}
                                onReturnToQueue={() => requestReturnToQueue(item)}
                                onRefreshPost={() => void reviewContent(item, false)}
                                onRemove={() => removeContent(item)}
                                onCheckPosts={() => onNavigate('posts')}
                                onViewLibrary={() => void viewLibrary(item)}
                                onShowInFolder={() => void showInFolder(item)}
                              />}
                            </Draggable>
                          ))}
                          {listProvided.placeholder}
                        </ul>}
                      </Droppable>
                    </section>
                  ))}
                </DragDropContext>
              </Panel>

              {dirty && (
                <div className="glass-thick sticky bottom-3 z-10 flex items-center justify-between gap-3 rounded-full py-1.5 pl-4 pr-1.5 animate-fade-in" role="region" aria-label="Unsaved changes">
                  <p className="flex items-center gap-2 text-xs text-ink"><StatusDot tone="warning" className="h-1.5 w-1.5 [&>span]:h-1.5 [&>span]:w-1.5" />Unsaved changes</p>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setDraft(draftFor(selected))}>Discard</Button>
                    <Button size="sm" variant="primary" loading={busy === 'save'} disabled={Boolean(busy)} onClick={() => void save()}>Save changes</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {enhancing && (() => {
        const item = automations.find((automation) => automation.id === enhancing.automationId)?.content.find((content) => content.id === enhancing.contentId)
        return item ? <AutomationMetadataDialog key={item.id} automationId={enhancing.automationId} item={item} youtubeOnly={!automations.find((automation) => automation.id === enhancing.automationId)?.accounts.length} onUpdated={setAutomations} onClose={() => setEnhancing(null)} onBusy={(value) => setBusy(value ? 'enhance' : null)} /> : null
      })()}
      {selected && tiktokReview && <AutomationTikTokReviewDialog key={tiktokReview.id} automationId={selected.id} contentId={tiktokReview.id} title={tiktokReview.title}
        onPrepared={() => setAutomations((current) => current.map((automation) => automation.id === selected.id
          ? { ...automation, content: automation.content.map((item) => item.id === tiktokReview.id ? { ...item, tiktokApproval: null } : item) } : automation))}
        onClose={() => { setTiktokReview(null); void mutate('refresh', () => getApi().automations.list()); }} onApproved={(result) => { setAutomations(result); setTiktokReview(null); setNotice('TikTok review saved. This clip is ready for the automation.'); }} />}
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

function automationState(automation: Automation): { label: string; tone: 'success' | 'warning' | 'danger' | 'idle' } {
  if (automation.enabled && automation.lastError && !automation.lastErrorAcknowledged) return { label: 'Failing', tone: 'danger' }
  if (automation.enabled) return { label: 'On', tone: 'success' }
  if (missingSetup(automation)) return { label: 'Needs setup', tone: 'warning' }
  return { label: 'Paused', tone: 'idle' }
}

function Sep(): React.JSX.Element {
  return <span aria-hidden className="text-ink-faint">·</span>
}

/** One labelled line of the automation's settings: label on the left, controls on the right. */
function Row({ label, htmlFor, labelId, hint, children }: {
  label: string
  /** The control the label names. */
  htmlFor?: string
  /** Lets a group of controls use the label as its name. */
  labelId?: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const labelClass = 'text-xs font-medium leading-7 text-ink-muted'
  return (
    <div className="grid gap-x-3 gap-y-0.5 px-3.5 py-1.5 sm:grid-cols-[80px_minmax(0,1fr)]">
      {htmlFor
        ? <label htmlFor={htmlFor} className={labelClass}>{label}</label>
        : <p id={labelId} className={labelClass}>{label}</p>}
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1 text-2xs leading-snug text-ink-subtle">{hint}</p>}
      </div>
    </div>
  )
}

function AutomationTab({ automation, selected, onSelect }: { automation: Automation; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const state = automationState(automation)
  const ready = automation.content.filter((item) => item.status === 'queued' && !needsTikTokReview(automation, item)).length
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={`${state.label} · ${ready} ready`}
      className={cn(
        'inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-150',
        selected
          ? 'border-white/[0.16] bg-white/[0.1] font-medium text-ink'
          : 'border-transparent text-ink-muted hover:bg-white/[0.05] hover:text-ink'
      )}
    >
      <StatusDot tone={state.tone} pulse={state.tone === 'success' && selected} className="h-1.5 w-1.5 [&>span]:h-1.5 [&>span]:w-1.5" />
      <span className="truncate">{automation.name}</span>
    </button>
  )
}

function CreateForm({ busy, onCreate, onCancel, autoFocus, size = 'md', className }: {
  busy: boolean
  onCreate: (name: string) => Promise<boolean>
  onCancel?: () => void
  autoFocus?: boolean
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const [name, setName] = useState('')
  return (
    <form
      className={cn('flex gap-1', className)}
      onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onCreate(name).then((ok) => { if (ok) setName('') }) }}
    >
      <TextInput inputSize={size} className="flex-1" autoFocus={autoFocus} aria-label="Automation name" placeholder="Automation name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onCancel?.() }} />
      <Button size={size} type="submit" variant="primary" loading={busy} disabled={!name.trim() || busy}>Create</Button>
      {onCancel && <Button size={size} type="button" variant="ghost" iconOnly aria-label="Cancel" icon={<X className="h-3.5 w-3.5" />} onClick={onCancel} />}
    </form>
  )
}

function ContentRow({ item, nextUp, tiktokReviewNeeded, tiktokSelected, onReviewTikTok, reviewDisabled, editing, busy, onEdit, onChange, onSave, onReturnToQueue, onRefreshPost, onRemove, onCheckPosts, onViewLibrary, onShowInFolder, onEnhance, enhancementDisabled, enhanced, dragProvided, dragging, onDismissMetadataError, onDismissError, onRetry, retryDisabled }: {
  item: AutomationContent
  nextUp: boolean
  tiktokReviewNeeded: boolean
  tiktokSelected: boolean
  onReviewTikTok: () => void
  reviewDisabled: boolean
  editing: { id: string; title: string; caption: string } | null
  busy: boolean
  onEdit: () => void
  onChange: (value: { id: string; title: string; caption: string }) => void
  onSave: () => void
  onReturnToQueue: () => void
  onRefreshPost: () => void
  onRemove: () => void
  onCheckPosts: () => void
  onViewLibrary: () => void
  onShowInFolder: () => void
  onEnhance: () => void
  enhancementDisabled: boolean
  enhanced: boolean
  dragProvided: DraggableProvided
  dragging: boolean
  onDismissMetadataError: () => void
  onDismissError: () => void
  onRetry: () => void
  retryDisabled: boolean
}): React.JSX.Element {
  const status = item.status === 'needs_review' && item.warningsAcknowledged ? { label: 'Held · Warning acknowledged', tone: 'neutral' as const }
    : tiktokReviewNeeded ? { label: 'Needs TikTok review', tone: 'warning' as const } : CONTENT_STATUS[item.status]
  const note = item.status === 'queued' && tiktokSelected && !tiktokReviewNeeded && item.tiktokApproval ? 'TikTok approved'
    : item.status === 'posted' && item.tiktokApproval?.options.draft ? 'Sent to TikTok inbox' : null
  const problem = item.warningsAcknowledged ? null : item.error ?? (item.status === 'needs_review' ? 'Confirm whether this clip posted before running it again.' : null)
  const row = (
    <li ref={dragProvided.innerRef} {...dragProvided.draggableProps}
      className={cn('group/row list-none px-3.5 py-2.5', editing && 'bg-white/[0.025]', dragging && 'rounded-xl bg-raised shadow-pop ring-1 ring-accent/40')}>
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        {canReorderContent(item) && <span role="button" tabIndex={-1} aria-disabled={!dragProvided.dragHandleProps} {...dragProvided.dragHandleProps} aria-label={`Reorder ${item.title}`} title="Drag to reorder. Or press Space, use arrow keys, then Space to drop; Escape to cancel." className={cn('touch-none rounded p-1 text-ink-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', dragProvided.dragHandleProps ? 'cursor-grab hover:bg-fill-hover hover:text-ink active:cursor-grabbing' : 'cursor-default opacity-40')}><GripVertical className="h-3.5 w-3.5" /></span>}
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <p className="truncate text-xs text-ink">{item.title}</p>
          {item.metadataDraft && <Badge tone="warning">Draft to review</Badge>}
          {item.status === 'posting' && <Badge tone="accent">Submitting…</Badge>}
          {nextUp && <Badge tone="accent" className="h-4 px-1.5 text-[10px]">Next up</Badge>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {item.status === 'queued' && !item.postId && item.error && <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3 w-3" />} disabled={busy || retryDisabled || Boolean(item.metadataDraft)} onClick={onRetry} title="Retry this clip now, using the saved automation settings">Retry clip</Button>}
          {item.status === 'queued' && !item.postId && (item.metadataDraft || !enhanced) && <Button size="sm" variant="ghost" disabled={busy || (!item.metadataDraft && enhancementDisabled)} onClick={onEnhance}>{item.metadataDraft ? 'Review draft' : 'Enhance'}</Button>}
          {tiktokReviewNeeded && <Button size="sm" variant="secondary" onClick={onReviewTikTok} disabled={busy || reviewDisabled || Boolean(item.metadataDraft)}>Review TikTok</Button>}
          {item.status === 'needs_review' && <Button size="sm" variant="secondary" onClick={onReturnToQueue} disabled={busy || Boolean(editing)} title={editing ? 'Save or close the editor first' : 'Review and return this clip to the queue'}>Return to queue</Button>}
          {item.status === 'needs_review' && item.postId && <Button size="sm" variant="ghost" onClick={onRefreshPost} disabled={busy || Boolean(editing)} icon={<RefreshCw className="h-3 w-3" />}>Refresh post status</Button>}
          <HoverCard label={`Info about ${item.title}`} className="rounded-lg p-1.5 text-ink-subtle hover:text-ink" cardClassName="w-80 max-w-[calc(100vw-16px)]" content={
            <div className="space-y-3 p-4 text-xs">
              <p className="line-clamp-3 font-semibold text-ink">{item.title}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-ink-muted">
                <dt>Added to queue</dt><dd className="text-ink">{new Date(item.addedAt).toLocaleString()}</dd>
                {item.postedAt && <><dt>Submitted</dt><dd className="text-ink">{new Date(item.postedAt).toLocaleString()}</dd></>}
                <dt>Status</dt><dd className="text-ink">{status.label}{note ? ` · ${note}` : ''}</dd>
                <dt>Metadata</dt><dd className="text-ink">{item.metadataDraft ? 'Draft awaiting review' : enhanced ? 'Enhanced' : 'Original'}</dd>
                {(item.sourceContext?.title || item.metadataEnhancement?.source?.title) && <><dt>Source</dt><dd className="line-clamp-2 text-ink">{item.sourceContext?.title || item.metadataEnhancement?.source?.title}</dd></>}
              </dl>
              {item.caption && <p className="line-clamp-3 whitespace-pre-wrap text-ink-muted">{item.caption}</p>}
              {((item.warningsAcknowledged && (item.error || item.metadataError)) || (item.metadataErrorAcknowledged && item.metadataError)) && <div className="space-y-1 border-t border-white/[0.08] pt-2 text-ink-subtle">
                <p className="font-medium">Acknowledged warnings</p>
                {item.warningsAcknowledged && item.error && <p>{item.error}</p>}
                {item.metadataError && <p>{item.metadataError}</p>}
              </div>}
              {Boolean(item.generatedMetadata?.length) && <div className="space-y-1.5 border-t border-white/[0.08] pt-2">
                <p className="text-ink-muted">Prepared for {item.generatedMetadata?.map((post) => platformName(post.platform)).join(', ')}</p>
                {item.generatedMetadata?.[0]?.tags.length ? <p className="line-clamp-2 text-ink-subtle">Tags: {item.generatedMetadata[0].tags.join(', ')}</p> : null}
              </div>}
            </div>
          }><Info aria-hidden className="h-4 w-4" /></HoverCard>
          <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />} disabled={busy} onClick={onViewLibrary} aria-label={`View ${item.title} in Library`} title="Show this clip in Library">View in Library</Button>
          <ActionMenu label={`Actions for ${item.title}`} disabled={busy || item.status === 'posting'} actions={[
            { label: editing ? 'Close editor' : 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, disabled: Boolean(item.metadataDraft), onSelect: onEdit },
            { label: isMac ? 'Show in Finder' : 'Show in folder', icon: <FolderOpen className="h-3.5 w-3.5" />, onSelect: onShowInFolder },
            ...(item.status === 'queued' && tiktokSelected && !tiktokReviewNeeded ? [{ label: 'Edit TikTok', disabled: reviewDisabled || Boolean(item.metadataDraft), onSelect: onReviewTikTok }] : []),
            { label: item.status === 'posted' ? 'Remove from history' : item.postId ? 'Remove clip' : 'Remove from queue', icon: <X className="h-3.5 w-3.5" />, onSelect: onRemove }
          ]} />
        </div>
      </div>

      {item.metadataError && !item.warningsAcknowledged && !item.metadataErrorAcknowledged && <Callout tone="warning" className="mt-2" onDismiss={busy ? undefined : onDismissMetadataError}>Metadata enhancement failed: {item.metadataError} Use Enhance to retry this clip, or select its source video to retry all remaining clips.</Callout>}
      {problem && <Callout tone={item.status === 'needs_review' ? 'warning' : 'danger'} className="mt-2" onDismiss={busy ? undefined : onDismissError}>
        {problem}
        {item.status === 'queued' && !item.postId && <p className="mt-1 text-xs text-ink-muted">Failed clips wait behind other ready clips. Use Retry clip to try this one now.</p>}
        {item.status === 'needs_review' && <button type="button" className="ml-2 font-medium text-ink underline-offset-2 hover:underline" onClick={onCheckPosts}>Check posts</button>}
      </Callout>}
      {item.warningsAcknowledged && item.status === 'needs_review' && <p className="mb-1 ml-4 text-2xs text-ink-subtle">
        Held for review · <button type="button" className="text-ink-muted underline-offset-2 hover:underline" onClick={onCheckPosts}>Check posts</button>
      </p>}

      {editing && (
        <div className="mb-1.5 mt-1 space-y-1.5 pl-4">
          <TextInput inputSize="sm" aria-label="Title" placeholder="Title" value={editing.title} maxLength={500} onChange={(event) => onChange({ ...editing, title: event.target.value })} />
          <TextArea aria-label="Caption" placeholder="Caption" className="min-h-[64px] text-xs" value={editing.caption} onChange={(event) => onChange({ ...editing, caption: event.target.value })} />
          <div className="flex flex-wrap justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={onSave} disabled={busy}>Save clip</Button>
          </div>
        </div>
      )}
    </li>
  )
  // Glass panels create a containing block for fixed descendants. Keep the
  // lifted row in viewport coordinates so it stays attached to the pointer.
  return dragging ? createPortal(row, document.body) : row
}
