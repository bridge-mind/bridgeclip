import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Clock3, FileVideo2, Globe2, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { AUTOMATION_PLATFORMS, needsTikTokReview, nextAutomationContent, type Automation, type AutomationContent, type AutomationContentStatus, type AutomationUpdate } from '../../shared/automations'
import { isPostableAccount, isValidProfileName } from '../../shared/zernio'
import { AutomationTikTokReviewDialog } from '../components/AutomationTikTokReviewDialog'
import { PlatformIcon, platformName } from '../components/PlatformIcon'
import { Badge, StatusDot } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { Dialog, DialogFooter } from '../components/ui/Dialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Field, Select, TextArea, TextInput } from '../components/ui/Field'
import { IconTile } from '../components/ui/IconTile'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { Segmented } from '../components/ui/Segmented'
import { SettingRow } from '../components/ui/SettingRow'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { useAccountsStore } from '../store/use-accounts-store'
import { useSettingsStore } from '../store/use-settings-store'
import { usePostsStore } from '../store/use-posts-store'
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

interface ConfirmRequest {
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => void
}

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
        <PageHeader eyebrow="Workspace" title="Automations" description="Post the next clip from a content bank at set times each day." />
        <EmptyState
          className="mt-6"
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
  const profileName = profiles.find((profile) => profile.id === selected?.profileId)?.name

  return (
    <Page width="default">
      <PageHeader
        eyebrow="Workspace"
        title="Automations"
        description="Post the next clip from a content bank at set times each day."
        actions={automations.length > 0 && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)} disabled={creating}>New automation</Button>}
      />
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-subtle">
        <Clock3 className="h-3.5 w-3.5 shrink-0" />
        BridgeClip must be open at a scheduled time. After sleep or reopening, a run can start up to five minutes late.
      </p>

      {(error || notice) && (
        <div className="mt-4 space-y-2">
          {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
          {notice && <Callout tone="success" onDismiss={() => setNotice(null)}>{notice}</Callout>}
        </div>
      )}

      {!loaded && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
          <div className="space-y-2">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-[58px] rounded-2xl" />)}</div>
          <div className="space-y-4"><Skeleton className="h-[148px] rounded-3xl" /><Skeleton className="h-[240px] rounded-3xl" /></div>
        </div>
      )}

      {loaded && automations.length === 0 && (
        <EmptyState
          className="mt-6"
          icon={<Workflow />}
          title="Create your first automation"
          description="Pick a Zernio profile and its accounts, fill a content bank with clips, and choose daily posting times."
          action={<CreateForm busy={busy === 'create'} onCreate={create} className="w-[320px] max-w-full" />}
        />
      )}

      {loaded && automations.length > 0 && (
        <div className="mt-5 grid items-start gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
          <nav aria-label="Automations" className="space-y-1.5 lg:sticky lg:top-12">
            {creating && (
              <div className="glass-tile rounded-2xl p-2">
                <CreateForm busy={busy === 'create'} onCreate={create} onCancel={() => setCreating(false)} autoFocus />
              </div>
            )}
            {automations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                selected={automation.id === selectedId}
                onSelect={() => select(automation)}
              />
            ))}
          </nav>

          {selected && draft && (
            <div className="min-w-0 space-y-4">
              <Panel>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <IconTile size="lg" tone={selected.enabled ? 'accent' : 'neutral'}><Workflow /></IconTile>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-lg font-semibold text-ink">{selected.name}</h2>
                        <AutomationBadge automation={selected} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {profileName ?? 'No profile'} · {selected.accounts.length} account{selected.accounts.length === 1 ? '' : 's'} · {selected.timezone}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className={cn('flex items-center gap-2 text-sm text-ink-muted', !selected.enabled && !savedReady && 'opacity-60')} title={!selected.enabled && !savedReady ? 'Finish setup and save before turning this on' : undefined}>
                      {selected.enabled ? 'On' : 'Off'}
                      <Switch
                        checked={selected.enabled}
                        disabled={Boolean(busy) || (!selected.enabled && !savedReady)}
                        onChange={(value) => void setEnabled(value)}
                        label="Automation on"
                      />
                    </label>
                    <Button
                      variant="secondary"
                      icon={<Play className="h-3.5 w-3.5" />}
                      loading={busy === 'run'}
                      disabled={Boolean(busy) || !nextClip || dirty}
                      title={dirty ? 'Save automation changes first' : !nextClip ? 'Add a clip and complete any TikTok reviews first' : 'Post the next ready clip now'}
                      onClick={() => void runNow()}
                    >Run now</Button>
                    <Button variant="ghost" iconOnly aria-label={`Delete ${selected.name}`} title="Delete automation" icon={<Trash2 className="h-4 w-4" />} disabled={Boolean(busy)} onClick={remove} />
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Ready to post" value={String(counts.ready)} hint={counts.tiktok_review ? `${counts.tiktok_review} need TikTok review` : `${counts.queued} queued`} hintTone={counts.tiktok_review ? 'warning' : undefined} />
                  <Stat label="Submitted" value={String(counts.posted)} hint={counts.needs_review ? `${counts.needs_review} to review` : undefined} hintTone={counts.needs_review ? 'warning' : undefined} />
                  <Stat label="Next run" value={selected.enabled ? nextRunLabel(selected.times, selected.timezone) ?? '—' : 'Paused'} />
                  <Stat label="Last run" value={selected.lastRunAt ? formatRelativeDate(selected.lastRunAt) : 'Never'} />
                </dl>

                {selected.lastError && <Callout tone="danger" title="The last run failed" className="mt-3">{selected.lastError}</Callout>}
              </Panel>

              {!selected.enabled && (
                <SetupChecklist
                  steps={[
                    { label: 'Choose a profile', done: Boolean(draft.profileId) },
                    { label: 'Select an account', done: draft.accounts.length > 0 },
                    { label: 'Add a daily time', done: draft.times.length > 0 },
                    { label: 'Add clips', done: counts.queued > 0 },
                    ...(draft.metadataMode === 'ai' ? [{ label: 'Add OpenRouter key', done: !aiKeysMissing, action: () => onNavigate('settings') }] : [])
                  ]}
                />
              )}

              <div className="grid items-start gap-4 xl:grid-cols-2">
                <Panel>
                  <PanelHeader
                    icon={<IconTile><Globe2 /></IconTile>}
                    title="Where it posts"
                    description="One Zernio profile. Each run posts to every selected account."
                    action={<Button size="sm" variant="ghost" iconOnly aria-label="Refresh accounts" title="Refresh accounts" loading={accountsLoading} onClick={() => void loadAccounts()} icon={<RefreshCw className="h-3.5 w-3.5" />} />}
                  />
                  <Field
                    className="mt-4"
                    label="Zernio profile"
                    htmlFor="automation-profile"
                    aside={!newProfileOpen && <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setNewProfileOpen(true)}>New profile</button>}
                  >
                    <Select id="automation-profile" value={draft.profileId ?? ''} onChange={(event) => setDraft({ ...draft, profileId: event.target.value || null, accounts: [], enabled: false })}>
                      <option value="">Choose a profile</option>
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.isOverLimit ? ' · over limit' : ''}</option>)}
                    </Select>
                  </Field>
                  {newProfileOpen && (
                    <form onSubmit={(event) => void addProfile(event)} className="mt-2 flex gap-2">
                      <TextInput className="flex-1" autoFocus aria-label="New profile name" placeholder="New profile name" value={newProfileName} maxLength={80} onChange={(event) => setNewProfileName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setNewProfileOpen(false) }} />
                      <Button type="submit" loading={busy === 'profile'} disabled={!isValidProfileName(newProfileName) || Boolean(busy)}>Create</Button>
                      <Button type="button" variant="ghost" iconOnly aria-label="Cancel" icon={<X className="h-4 w-4" />} onClick={() => setNewProfileOpen(false)} />
                    </form>
                  )}

                  {draft.profileId && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-ink">Accounts</p>
                        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} disabled={Boolean(busy)} onClick={() => void connectAccount()}>Connect</Button>
                      </div>
                      {connected.length === 0 ? (
                        <p className="mt-2 rounded-xl glass-well px-3 py-3 text-xs text-ink-muted">No supported accounts in this profile yet. Connect TikTok, Instagram, YouTube, X, Facebook, LinkedIn or Threads.</p>
                      ) : (
                        <div className="mt-2 grid gap-1.5">
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
                                disabled={!available}
                                onClick={() => setDraft({ ...draft, accounts: checked ? draft.accounts.filter((item) => item.accountId !== account.id) : [...draft.accounts, { accountId: account.id, platform: account.platform as AutomationUpdate['accounts'][number]['platform'] }] })}
                                className={cn('glass-tile flex items-center gap-3 rounded-xl p-2 pr-3 text-left transition-colors', available && 'glass-tile-hover', checked && 'glass-selected', !available && 'cursor-not-allowed opacity-60')}
                              >
                                <PlatformIcon platform={account.platform} className="h-8 w-8 rounded-lg" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-ink">{handle}</span>
                                  <span className="block text-2xs text-ink-subtle">{available ? platformName(account.platform) : `${platformName(account.platform)} · reconnect in Accounts`}</span>
                                </span>
                                <span aria-hidden className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px]', checked ? 'bg-accent text-accent-ink' : 'bg-black/25 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]')}>
                                  {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {accounts.some((account) => account.profileId === draft.profileId && account.platform === 'tiktok') && (
                        <p className="mt-2 text-2xs text-ink-subtle">TikTok is supported. Review each clip in the content bank once; approved clips post automatically at your daily times.</p>
                      )}
                    </div>
                  )}
                </Panel>

                <Panel>
                  <PanelHeader icon={<IconTile><Clock3 /></IconTile>} title="When it posts" description="One queued clip posts at each time, every day." />
                  <div className="mt-4">
                    <p className="text-sm font-medium text-ink">Daily times</p>
                    {draft.times.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {draft.times.map((time) => (
                          <li key={time} className="glass-tile inline-flex h-8 items-center gap-1 rounded-full pl-3 pr-1 font-mono text-xs tabular text-ink">
                            {formatTime(time)}
                            <button type="button" aria-label={`Remove ${formatTime(time)}`} className="flex h-6 w-6 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-white/[0.08] hover:text-ink" onClick={() => setDraft({ ...draft, times: draft.times.filter((item) => item !== time) })}>
                              <X className="h-3 w-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="mt-2 text-xs text-ink-muted">No times yet.</p>}
                    <div className="mt-2 flex gap-2">
                      <TextInput type="time" aria-label="New daily time" mono className="w-[132px] [color-scheme:dark]" value={newTime} onChange={(event) => setNewTime(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTime() }} />
                      <Button icon={<Plus className="h-3.5 w-3.5" />} onClick={addTime} disabled={!newTime || draft.times.includes(newTime) || draft.times.length >= 24}>Add time</Button>
                    </div>
                  </div>
                  <Field className="mt-4" label="Time zone" htmlFor="automation-timezone">
                    <Select id="automation-timezone" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
                      {timeZones(draft.timezone).map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
                    </Select>
                  </Field>
                </Panel>
              </div>

              <Panel>
                <PanelHeader icon={<IconTile><Sparkles /></IconTile>} title="Post details" description="How each clip is named and described when it posts." />
                <div className="mt-4 space-y-2">
                  <Field label="Automation name" htmlFor="automation-name">
                    <TextInput id="automation-name" value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                  </Field>
                  <SettingRow
                    className="mt-3"
                    title="Write captions with AI"
                    description="When enabled, OpenRouter transcribes each clip with MAI Transcribe 2 and writes platform-specific captions. TikTok captions are prepared for your review before the clip can post; other platforms publish automatically. AI can make mistakes; leave this off to use your own captions."
                    control={<Switch checked={draft.metadataMode === 'ai'} onChange={(on) => setDraft({ ...draft, metadataMode: on ? 'ai' : 'manual' })} label="Write captions with AI" />}
                  />
                  {draft.metadataMode === 'ai' && aiKeysMissing && (
                    <Callout tone="warning" action={<Button size="sm" onClick={() => onNavigate('settings')}>Open Settings</Button>}>
                      Add an OpenRouter key before turning this automation on.
                    </Callout>
                  )}
                  {draft.accounts.some((account) => account.platform === 'youtube') && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <SettingRow
                        title="YouTube visibility"
                        control={<Segmented size="sm" label="YouTube visibility" value={draft.youtubeVisibility} onChange={(value) => setDraft({ ...draft, youtubeVisibility: value })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'private', label: 'Private' }]} />}
                      />
                      <SettingRow
                        title="Made for kids"
                        control={<Switch checked={draft.youtubeMadeForKids} onChange={(value) => setDraft({ ...draft, youtubeMadeForKids: value })} label="Made for kids" />}
                      />
                    </div>
                  )}
                </div>
              </Panel>

              <Panel>
                <PanelHeader
                  icon={<IconTile><FileVideo2 /></IconTile>}
                  title="Content bank"
                  description="The oldest ready clip posts first. Clips awaiting TikTok review are skipped until approved."
                  action={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'upload'} onClick={() => void mutate('upload', () => getApi().automations.addContent(selected.id), 'Clips added to the bank.')} disabled={Boolean(busy)}>Add clips</Button>}
                />
                {selected.content.length > 0 && (
                  <Segmented
                    className="mt-4"
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
                <ul className="mt-3 space-y-1.5">
                  {selected.content.length === 0 && (
                    <li className="glass-well rounded-xl px-4 py-6 text-center">
                      <p className="text-sm text-ink">No clips yet</p>
                      <p className="mt-1 text-xs text-ink-muted">Add MP4, MOV, M4V or WebM files, or send clips here from the Library.</p>
                    </li>
                  )}
                  {selected.content.length > 0 && visibleContent.length === 0 && <li className="py-4 text-center text-xs text-ink-muted">No clips match this filter.</li>}
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
                      onCheckPosts={() => { usePostsStore.getState().requestReveal(); onNavigate('accounts') }}
                    />
                  ))}
                </ul>
              </Panel>

              {dirty && (
                <div className="glass-thick sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-full py-2 pl-5 pr-2 animate-fade-in" role="region" aria-label="Unsaved changes">
                  <p className="flex items-center gap-2 text-sm text-ink"><StatusDot tone="warning" />Unsaved changes</p>
                  <div className="flex gap-2">
                    <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDraft(draftFor(selected))}>Discard</Button>
                    <Button variant="primary" loading={busy === 'save'} disabled={Boolean(busy)} onClick={() => void save()}>Save changes</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
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

function AutomationRow({ automation, selected, onSelect }: { automation: Automation; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const state = automationState(automation)
  const queued = automation.content.filter((item) => item.status === 'queued')
  const ready = queued.filter((item) => !needsTikTokReview(automation, item)).length
  const pending = queued.length - ready
  const next = automation.enabled ? nextRunLabel(automation.times, automation.timezone) : null
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn('glass-tile glass-tile-hover flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left', selected && 'glass-selected')}
    >
      <StatusDot tone={state.tone} pulse={state.tone === 'success'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{automation.name}</span>
        <span className="mt-0.5 block truncate text-2xs text-ink-subtle">
          {state.label} · {ready} ready{pending ? ` · ${pending} to review` : next ? ` · ${next}` : ''}
        </span>
      </span>
    </button>
  )
}

function CreateForm({ busy, onCreate, onCancel, autoFocus, className }: {
  busy: boolean
  onCreate: (name: string) => Promise<boolean>
  onCancel?: () => void
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  const [name, setName] = useState('')
  return (
    <form
      className={cn('flex gap-1.5', className)}
      onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onCreate(name).then((ok) => { if (ok) setName('') }) }}
    >
      <TextInput className="flex-1" autoFocus={autoFocus} aria-label="Automation name" placeholder="Automation name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onCancel?.() }} />
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || busy}>Create</Button>
      {onCancel && <Button type="button" variant="ghost" iconOnly aria-label="Cancel" icon={<X className="h-4 w-4" />} onClick={onCancel} />}
    </form>
  )
}

function Stat({ label, value, hint, hintTone }: { label: string; value: string; hint?: string; hintTone?: 'warning' }): React.JSX.Element {
  return (
    <div className="glass-tile rounded-xl px-3 py-2">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular text-ink">
        {value}{hint && <span className={cn('ml-1.5 text-2xs font-normal', hintTone === 'warning' ? 'text-warning' : 'text-ink-subtle')}>{hint}</span>}
      </dd>
    </div>
  )
}

function SetupChecklist({ steps }: { steps: { label: string; done: boolean; action?: () => void }[] }): React.JSX.Element | null {
  const remaining = steps.filter((step) => !step.done).length
  if (remaining === 0) return null
  return (
    <div className="glass rounded-3xl p-4 xl:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Finish setup</p>
        <p className="text-xs text-ink-subtle">{steps.length - remaining} of {steps.length} done</p>
      </div>
      <ol className="mt-3 flex flex-wrap gap-1.5">
        {steps.map((step) => {
          const content = <>
            <span className={cn('flex h-4 w-4 items-center justify-center rounded-full', step.done ? 'bg-success/20 text-success' : 'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]')}>
              {step.done && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
            </span>
            {step.label}
          </>
          const className = cn('inline-flex h-7 items-center gap-2 rounded-full pl-1.5 pr-3 text-xs', step.done ? 'text-ink-subtle line-through decoration-ink-faint' : 'glass-tile text-ink')
          return <li key={step.label}>
            {step.action && !step.done
              ? <button type="button" className={cn(className, 'glass-tile-hover')} onClick={step.action}>{content}</button>
              : <span className={className}>{content}</span>}
          </li>
        })}
      </ol>
    </div>
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
  const hasDetails = Boolean(item.generatedMetadata || item.transcript)
  return (
    <li className={cn('glass-tile rounded-2xl p-2', (editing || open) && 'bg-white/[0.06]')}>
      <div className="flex items-center gap-3">
        <IconTile size="lg" tone={item.status === 'needs_review' || tiktokReviewNeeded ? 'warning' : 'neutral'}><FileVideo2 /></IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-ink">{item.title}</p>
            {nextUp && <Badge tone="accent">Next up</Badge>}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-ink-subtle">
            <StatusDot tone={status.tone} pulse={item.status === 'posting'} className="h-1.5 w-1.5 [&>span]:h-1.5 [&>span]:w-1.5" />
            <span className={cn(item.status === 'needs_review' || tiktokReviewNeeded ? 'text-warning' : 'text-ink-muted')}>{status.label}</span>
            {item.status === 'queued' && tiktokSelected && !tiktokReviewNeeded && item.tiktokApproval && <span>· TikTok approved</span>}
            {item.status === 'posted' && item.tiktokApproval?.options.draft && <span>· Sent to TikTok inbox</span>}
            <span aria-hidden>·</span>
            <span className="truncate">{item.postedAt ? `Posted ${formatRelativeDate(item.postedAt)}` : `Added ${formatRelativeDate(item.addedAt)}`}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {item.status === 'queued' && tiktokSelected && <Button size="sm" variant="secondary" onClick={onReviewTikTok} disabled={busy || reviewDisabled} title={reviewDisabled ? 'Save automation changes and finish editing this clip first' : undefined}>{tiktokReviewNeeded ? 'Review TikTok' : 'Edit TikTok'}</Button>}
          {hasDetails && <Button size="sm" variant="ghost" aria-expanded={open} trailingIcon={<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />} onClick={() => setOpen(!open)}>AI details</Button>}
          <Button size="sm" variant="ghost" iconOnly aria-label={editing ? 'Close editor' : `Edit ${item.title}`} title="Edit title and caption" icon={editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />} onClick={onEdit} />
          <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${item.title}`} title="Remove from bank" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={busy} onClick={onRemove} />
        </div>
      </div>

      {item.error && (
        <Callout tone={item.status === 'needs_review' ? 'warning' : 'danger'} className="mt-2" action={item.status === 'needs_review' && <Button size="sm" onClick={onCheckPosts}>Check posts</Button>}>
          {item.error}
        </Callout>
      )}
      {!item.error && item.status === 'needs_review' && (
        <Callout tone="warning" className="mt-2" action={<Button size="sm" onClick={onCheckPosts}>Check posts</Button>}>Confirm whether this clip posted before running it again.</Callout>
      )}

      {open && hasDetails && (
        <div className="mt-2 space-y-1.5 px-1 pb-1">
          {item.generatedMetadata?.map((post) => (
            <div key={post.platform} className="glass-well rounded-xl p-3 text-xs text-ink-muted">
              <p className="flex items-center gap-2 font-medium text-ink"><PlatformIcon platform={post.platform} variant="glyph" />{platformName(post.platform)}{post.title ? ` · ${post.title}` : ''}</p>
              <p className="mt-1.5 whitespace-pre-wrap leading-relaxed" data-selectable>{post.caption}</p>
              {(post.tags.length > 0 || post.categoryId || post.topicTag) && (
                <p className="mt-1.5 text-2xs text-ink-subtle">
                  {[post.tags.length > 0 && `Tags: ${post.tags.join(', ')}`, post.categoryId && `Category ${post.categoryId}`, post.topicTag && `Topic: ${post.topicTag}`].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          ))}
          {item.transcript && (
            <details className="glass-well rounded-xl p-3 text-xs text-ink-muted">
              <summary className="cursor-pointer font-medium text-ink">Transcript</summary>
              <p className="mt-1.5 whitespace-pre-wrap leading-relaxed" data-selectable>{item.transcript}</p>
            </details>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-2 space-y-3 px-1 pb-1">
          <Field label="Title">
            <TextInput value={editing.title} maxLength={500} onChange={(event) => onChange({ ...editing, title: event.target.value })} />
          </Field>
          <Field label="Caption">
            <TextArea className="min-h-[86px]" value={editing.caption} onChange={(event) => onChange({ ...editing, caption: event.target.value })} />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            {item.status === 'needs_review' && !item.postId && <Button size="sm" variant="secondary" onClick={onReturnToQueue} disabled={busy}>Return to queue</Button>}
            <Button size="sm" variant="primary" onClick={onSave} disabled={busy}>Save clip</Button>
          </div>
        </div>
      )}
    </li>
  )
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [onClose])
  return (
    <Dialog role="alertdialog" aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[420px]">
      <div className="px-5 pb-5 pt-5">
        <h2 id={titleId} className="text-base font-semibold text-ink">{request.title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{request.body}</p>
      </div>
      <DialogFooter>
        <Button ref={cancelRef} onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => { onClose(); request.onConfirm() }}>{request.confirmLabel}</Button>
      </DialogFooter>
    </Dialog>
  )
}
