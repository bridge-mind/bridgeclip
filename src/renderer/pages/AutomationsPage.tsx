import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Pencil, Play, Plus, RefreshCw, Trash2, Workflow, X } from 'lucide-react'
import { AUTOMATION_PLATFORMS, needsTikTokReview, nextAutomationContent, type Automation, type AutomationContent, type AutomationContentStatus, type AutomationUpdate } from '../../shared/automations'
import { isPostableAccount, isValidProfileName } from '../../shared/zernio'
import { AutomationTikTokReviewDialog } from '../components/AutomationTikTokReviewDialog'
import { PlatformIcon, platformName } from '../components/PlatformIcon'
import { Badge, StatusDot } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { TextArea, TextInput } from '../components/ui/Field'
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
import { cn, errorMessage, formatRelativeDate } from '../lib/utils'
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

type ContentFilter = 'all' | 'queued' | 'ready' | 'tiktok_review' | 'posted' | 'needs_review'

const LIST_FORMAT = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

export function AutomationsPage({ onNavigate }: { onNavigate: (page: PageName) => void }): React.JSX.Element {
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
  const [editing, setEditing] = useState<{ id: string; title: string; caption: string } | null>(null)
  const [tiktokReview, setTiktokReview] = useState<AutomationContent | null>(null)
  const [filter, setFilter] = useState<ContentFilter>('all')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const closeConfirm = useCallback(() => setConfirm(null), [])
  const selected = automations.find((automation) => automation.id === selectedId) ?? null
  const aiKeysMissing = !writingConfigured

  useEffect(() => {
    if (!configured) return
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const result = await getApi().automations.list()
        if (active) {
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
  }, [configured, hydrate, loadAccounts])

  const connected = useMemo(() => accounts.filter((account) => account.profileId === draft?.profileId &&
    AUTOMATION_PLATFORMS.some((platform) => platform === account.platform)
  ), [accounts, draft?.profileId])

  const dirty = Boolean(selected && draft && JSON.stringify(draft) !== JSON.stringify(draftFor(selected)))

  const select = (automation: Automation | null): void => {
    setSelectedId(automation?.id ?? null)
    rememberSelection(automation?.id ?? null)
    setDraft(automation ? draftFor(automation) : null)
    setEditing(null); setTiktokReview(null); setFilter('all'); setNewProfileOpen(false)
  }

  const mutate = async (action: string, request: () => Promise<Automation[]>, success?: string): Promise<Automation[] | null> => {
    setBusy(action); setError(null); setNotice(null)
    try {
      const result = await request()
      setAutomations(result)
      if (success) setNotice(success)
      return result
    } catch (cause) {
      setError(errorMessage(cause, 'Could not update the automation.'))
      return null
    } finally { setBusy(null) }
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

  const saveContent = async (item: AutomationContent, returnToQueue = false): Promise<void> => {
    if (!selected || !editing || editing.id !== item.id) return
    const result = await mutate('content', () => getApi().automations.updateContent(selected.id, item.id, {
      title: editing.title, caption: editing.caption, returnToQueue
    }), returnToQueue ? 'Clip returned to the queue.' : 'Clip details saved.')
    if (result) setEditing(null)
  }

  const requestReturnToQueue = (item: AutomationContent): void => setConfirm({
    title: 'Return this clip to the queue?',
    body: 'Check Zernio first. Only return it if it was not posted to any selected account, or it will post twice.',
    confirmLabel: 'Return to queue',
    onConfirm: () => void saveContent(item, true)
  })

  const removeContent = (item: AutomationContent): void => {
    if (!selected) return
    setConfirm({
      title: 'Remove this clip?',
      body: <>“{item.title}” is removed from this content bank.</>,
      confirmLabel: 'Remove clip',
      onConfirm: () => void mutate('remove', () => getApi().automations.removeContent(selected.id, item.id))
    })
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
  const counts: Record<ContentFilter, number> = {
    all: selected?.content.length ?? 0,
    queued: queued.length,
    ready: queued.filter((item) => !needsTikTokReview(selected!, item)).length,
    tiktok_review: queued.filter((item) => needsTikTokReview(selected!, item)).length,
    posted: selected?.content.filter((item) => item.status === 'posted').length ?? 0,
    needs_review: selected?.content.filter((item) => item.status === 'needs_review').length ?? 0
  }
  const visibleContent = selected?.content.filter((item) => {
    if (filter === 'ready') return item.status === 'queued' && !needsTikTokReview(selected, item)
    if (filter === 'tiktok_review') return item.status === 'queued' && needsTikTokReview(selected, item)
    return filter === 'all' || item.status === filter || (filter === 'queued' && item.status === 'posting')
  }) ?? []
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
        actions={automations.length > 0 && <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)} disabled={creating}>New automation</Button>}
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
                      <AutomationBadge automation={selected} />
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
                        <Sep />
                        {selected.enabled
                          ? <span>Next run <span className="text-ink">{nextRunLabel(selected.times, selected.timezone) ?? '—'}</span></span>
                          : <span>Paused</span>}
                        <Sep />
                        <span>Last run <span className="text-ink">{selected.lastRunAt ? formatRelativeDate(selected.lastRunAt) : 'never'}</span></span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <label className={cn('mr-1 flex items-center gap-1.5 text-2xs text-ink-muted', !selected.enabled && !savedReady && 'opacity-60')} title={!selected.enabled && !savedReady ? 'Finish setup and save before turning this on' : undefined}>
                      {selected.enabled ? 'On' : 'Off'}
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
                      title={dirty ? 'Save automation changes first' : !nextClip ? 'Add a clip and complete any TikTok reviews first' : 'Post the next ready clip now'}
                      onClick={() => void runNow()}
                    >Run now</Button>
                    <Button size="sm" variant="ghost" iconOnly aria-label={`Delete ${selected.name}`} title="Delete automation" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={Boolean(busy)} onClick={remove} />
                  </div>
                  {selected.lastError && (
                    <p role="alert" className="basis-full text-2xs text-danger" data-selectable>
                      <span className="font-medium">The last run failed:</span> {selected.lastError}
                    </p>
                  )}
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
                              {checked && <Check aria-hidden className="-mr-0.5 h-3 w-3 shrink-0 text-accent-hover" strokeWidth={3} />}
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
                  </Row>

                  <Row
                    label="Schedule"
                    labelId="automation-schedule"
                    hint="One clip posts at each time, daily. BridgeClip must be open; after sleep, a run can start up to 5 minutes late."
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

                  <Row
                    label="Captions"
                    hint="Uses OpenRouter and MAI Transcribe 2. TikTok captions wait for your review. AI can make mistakes."
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
              </Panel>

              <Panel padded={false}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 py-2">
                  <h2 className="mr-auto text-sm font-semibold text-ink" title="The oldest ready clip posts next. Clips awaiting TikTok review are skipped.">Content bank</h2>
                  {selected.content.length > 0 && (
                    <Segmented
                      size="sm"
                      label="Filter clips"
                      value={filter}
                      onChange={setFilter}
                      options={[
                        { value: 'all', label: `All ${counts.all}` },
                        { value: 'ready', label: `Ready ${counts.ready}` },
                        ...((counts.tiktok_review || filter === 'tiktok_review') ? [{ value: 'tiktok_review' as const, label: `TikTok review ${counts.tiktok_review}` }] : []),
                        { value: 'posted', label: `Submitted ${counts.posted}` },
                        ...(counts.needs_review ? [{ value: 'needs_review' as const, label: `Review ${counts.needs_review}` }] : [])
                      ]}
                    />
                  )}
                  <Button size="sm" icon={<Plus className="h-3 w-3" />} loading={busy === 'upload'} onClick={() => void mutate('upload', () => getApi().automations.addContent(selected.id), 'Clips added to the bank.')} disabled={Boolean(busy)}>Add clips</Button>
                </div>
                <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                  {selected.content.length === 0 && (
                    <li className="px-3.5 py-4 text-center">
                      <p className="text-xs text-ink">No clips yet</p>
                      <p className="mt-0.5 text-2xs text-ink-muted">Add MP4, MOV, M4V or WebM files, or send clips here from the Library.</p>
                    </li>
                  )}
                  {selected.content.length > 0 && visibleContent.length === 0 && <li className="px-3.5 py-3 text-center text-2xs text-ink-muted">No clips match this filter.</li>}
                  {visibleContent.map((item) => (
                    <ContentRow
                      key={item.id}
                      item={item}
                      nextUp={item.id === nextClip?.id}
                      tiktokReviewNeeded={item.status === 'queued' && needsTikTokReview(selected, item)}
                      tiktokSelected={selected.accounts.some((account) => account.platform === 'tiktok')}
                      onReviewTikTok={() => setTiktokReview(item)}
                      reviewDisabled={dirty || editing?.id === item.id}
                      editing={editing?.id === item.id ? editing : null}
                      busy={Boolean(busy)}
                      onEdit={() => setEditing(editing?.id === item.id ? null : { id: item.id, title: item.title, caption: item.caption })}
                      onChange={setEditing}
                      onSave={() => void saveContent(item)}
                      onReturnToQueue={() => requestReturnToQueue(item)}
                      onRemove={() => removeContent(item)}
                      onCheckPosts={() => onNavigate('posts')}
                    />
                  ))}
                </ul>
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

      {selected && tiktokReview && <AutomationTikTokReviewDialog key={tiktokReview.id} automationId={selected.id} contentId={tiktokReview.id} title={tiktokReview.title}
        onPrepared={() => setAutomations((current) => current.map((automation) => automation.id === selected.id
          ? { ...automation, content: automation.content.map((item) => item.id === tiktokReview.id ? { ...item, tiktokApproval: null } : item) } : automation))}
        onClose={() => { setTiktokReview(null); void mutate('refresh', () => getApi().automations.list()); }} onApproved={(result) => { setAutomations(result); setTiktokReview(null); setNotice('TikTok review saved. This clip is ready for the automation.'); }} />}
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

function automationState(automation: Automation): { label: string; tone: 'success' | 'warning' | 'danger' | 'idle' } {
  if (automation.enabled && automation.lastError) return { label: 'Failing', tone: 'danger' }
  if (automation.enabled) return { label: 'On', tone: 'success' }
  if (missingSetup(automation)) return { label: 'Needs setup', tone: 'warning' }
  return { label: 'Paused', tone: 'idle' }
}

function AutomationBadge({ automation }: { automation: Automation }): React.JSX.Element {
  const state = automationState(automation)
  return <Badge tone={state.tone === 'idle' ? 'neutral' : state.tone}>{state.label}</Badge>
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

function ContentRow({ item, nextUp, tiktokReviewNeeded, tiktokSelected, onReviewTikTok, reviewDisabled, editing, busy, onEdit, onChange, onSave, onReturnToQueue, onRemove, onCheckPosts }: {
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
  onRemove: () => void
  onCheckPosts: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const status = tiktokReviewNeeded ? { label: 'Needs TikTok review', tone: 'warning' as const } : CONTENT_STATUS[item.status]
  const attention = item.status === 'needs_review' || tiktokReviewNeeded
  const hasDetails = Boolean(item.generatedMetadata || item.transcript)
  const note = item.status === 'queued' && tiktokSelected && !tiktokReviewNeeded && item.tiktokApproval ? 'TikTok approved'
    : item.status === 'posted' && item.tiktokApproval?.options.draft ? 'Sent to TikTok inbox' : null
  const problem = item.error ?? (item.status === 'needs_review' ? 'Confirm whether this clip posted before running it again.' : null)
  return (
    <li className={cn('group/row px-3.5 py-1 transition-colors', (editing || open) && 'bg-white/[0.025]')}>
      <div className="flex min-h-7 items-center gap-2.5">
        <StatusDot tone={status.tone} pulse={item.status === 'posting'} className="h-1.5 w-1.5 [&>span]:h-1.5 [&>span]:w-1.5" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="truncate text-xs text-ink">{item.title}</p>
          {nextUp && <Badge tone="accent" className="h-4 px-1.5 text-[10px]">Next up</Badge>}
        </div>
        <p className="shrink-0 truncate text-2xs text-ink-subtle">
          <span className={attention ? 'text-warning' : 'text-ink-muted'}>{status.label}</span>
          {note && <span className="hidden lg:inline"> · {note}</span>}
          <span className="hidden md:inline"> · {item.postedAt ? `Posted ${formatRelativeDate(item.postedAt)}` : `Added ${formatRelativeDate(item.addedAt)}`}</span>
        </p>
        <div className="-mr-1.5 flex shrink-0 items-center">
          {item.status === 'queued' && tiktokSelected && <Button size="sm" variant={tiktokReviewNeeded ? 'secondary' : 'ghost'} className="h-6 px-2" onClick={onReviewTikTok} disabled={busy || reviewDisabled} title={reviewDisabled ? 'Save automation changes and finish editing this clip first' : undefined}>{tiktokReviewNeeded ? 'Review TikTok' : 'Edit TikTok'}</Button>}
          {hasDetails && <Button size="sm" variant="ghost" className="h-6 px-2" aria-expanded={open} trailingIcon={<ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />} onClick={() => setOpen(!open)}>AI details</Button>}
          <div className={cn('flex items-center transition-opacity duration-150', !editing && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}>
            <Button size="sm" variant="ghost" iconOnly className="h-6 w-6" aria-label={editing ? 'Close editor' : `Edit ${item.title}`} title="Edit title and caption" icon={editing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />} onClick={onEdit} />
            <Button size="sm" variant="ghost" iconOnly className="h-6 w-6" aria-label={`Remove ${item.title}`} title="Remove from bank" icon={<Trash2 className="h-3 w-3" />} disabled={busy} onClick={onRemove} />
          </div>
        </div>
      </div>

      {problem && (
        <p role={item.status === 'needs_review' ? 'status' : 'alert'} className={cn('mb-1 ml-4 flex flex-wrap items-baseline gap-x-2 text-2xs', item.status === 'needs_review' ? 'text-warning' : 'text-danger')}>
          <span data-selectable>{problem}</span>
          {item.status === 'needs_review' && <button type="button" className="font-medium text-ink underline-offset-2 hover:underline" onClick={onCheckPosts}>Check posts</button>}
        </p>
      )}

      {open && hasDetails && (
        <div className="mb-1.5 mt-0.5 space-y-1 pl-4">
          {item.generatedMetadata?.map((post) => (
            <div key={post.platform} className="glass-well rounded-lg px-2.5 py-2 text-2xs text-ink-muted">
              <p className="flex items-center gap-1.5 font-medium text-ink"><PlatformIcon platform={post.platform} variant="glyph" />{platformName(post.platform)}{post.title ? ` · ${post.title}` : ''}</p>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed" data-selectable>{post.caption}</p>
              {(post.tags.length > 0 || post.categoryId || post.topicTag) && (
                <p className="mt-1 text-ink-subtle">
                  {[post.tags.length > 0 && `Tags: ${post.tags.join(', ')}`, post.categoryId && `Category ${post.categoryId}`, post.topicTag && `Topic: ${post.topicTag}`].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          ))}
          {item.transcript && (
            <details className="glass-well rounded-lg px-2.5 py-2 text-2xs text-ink-muted">
              <summary className="cursor-pointer font-medium text-ink">Transcript</summary>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed" data-selectable>{item.transcript}</p>
            </details>
          )}
        </div>
      )}

      {editing && (
        <div className="mb-1.5 mt-1 space-y-1.5 pl-4">
          <TextInput inputSize="sm" aria-label="Title" placeholder="Title" value={editing.title} maxLength={500} onChange={(event) => onChange({ ...editing, title: event.target.value })} />
          <TextArea aria-label="Caption" placeholder="Caption" className="min-h-[64px] text-xs" value={editing.caption} onChange={(event) => onChange({ ...editing, caption: event.target.value })} />
          <div className="flex flex-wrap justify-end gap-1">
            {item.status === 'needs_review' && !item.postId && <Button size="sm" variant="secondary" onClick={onReturnToQueue} disabled={busy}>Return to queue</Button>}
            <Button size="sm" variant="primary" onClick={onSave} disabled={busy}>Save clip</Button>
          </div>
        </div>
      )}
    </li>
  )
}
