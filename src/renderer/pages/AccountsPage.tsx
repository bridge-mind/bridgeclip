import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowUpRight, KeyRound, Loader2, Plus, RefreshCw, RotateCw, Unplug, WifiOff, X } from 'lucide-react'
import { useSettingsStore } from '../store/use-settings-store'
import { useAccountsStore, type AccountsNotice } from '../store/use-accounts-store'
import { useApiKeyDrafts } from '../hooks/use-api-key-drafts'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import { PROVIDER_LINKS, ZERNIO_LINKS } from '../config/brand'
import { isValidProfileName, isZernioPlatform, ZERNIO_PLATFORMS, ZERNIO_PROFILE_NAME_MAX, type ZernioAccount } from '../../shared/zernio'
import { ApiKeyInput } from '../components/ApiKeyInput'
import { PLATFORM_INFO, PlatformIcon, platformName } from '../components/PlatformIcon'
import { PageHeader } from '../components/ui/PageHeader'
import { Page as PageColumn } from '../components/ui/Page'
import { Panel } from '../components/ui/Panel'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { TextInput } from '../components/ui/Field'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import type { Page } from '../components/Sidebar'

const TITLE = 'Accounts'
/** Opening the page re-reads Zernio only when the shown data is older than this. */
const REFRESH_ON_OPEN_AFTER_MS = 30_000
/** Account tiles: two columns at the page's full width, one in a narrow window. */
const TILE_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-1.5'

function openLink(url: string): void {
  void getApi().shell.openPath(url).catch(() => {})
}

export function AccountsPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const configured = useSettingsStore((s) => s.zernioConfigured)
  return (
    <PageColumn width="narrow">
      {configured ? <ConnectedAccounts onNavigate={onNavigate} /> : <ZernioSetup />}
    </PageColumn>
  )
}

function ZernioSetup(): React.JSX.Element {
  const keys = useApiKeyDrafts()

  return (
    <>
      <PageHeader title={TITLE} />
      <Panel padded={false} className="mt-4 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">Connect with Zernio</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Post and schedule clips to {ZERNIO_PLATFORMS.length} platforms. BridgeClip only holds your Zernio key; platform sign-in happens in your browser.
            </p>
          </div>
          <div aria-hidden className="hidden shrink-0 -space-x-1 sm:flex">
            {ZERNIO_PLATFORMS.map((platform) => (
              <PlatformIcon key={platform} platform={platform} className="h-6 w-6 rounded-full ring-2 ring-canvas [&_svg]:h-3 [&_svg]:w-3" />
            ))}
          </div>
        </div>
        <ol className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          <SetupStep
            step={1}
            action={
              <Button size="sm" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => openLink(ZERNIO_LINKS.signup)}>
                Sign up
              </Button>
            }
          >
            <StepText title="Create a free Zernio account" hint="The first two connected accounts are free on most platforms; X may require a card." />
          </SetupStep>
          <SetupStep
            step={2}
            action={
              <Button size="sm" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => openLink(PROVIDER_LINKS.zernio)}>
                API keys
              </Button>
            }
          >
            <StepText title="Create an API key" hint="Full access with Read & Write permission, so BridgeClip can create and connect profiles. Copy it right away: Zernio only shows it once." />
          </SetupStep>
          <SetupStep step={3}>
            <ApiKeyInput
              label="Paste your Zernio API key"
              value={keys.drafts.zernioApiKey}
              onChange={(v) => keys.setDraft('zernioApiKey', v)}
              onBlur={() => void keys.persist()}
              placeholder="sk_…"
              description="Encrypted with your system keychain. You can change it later in Settings."
            />
            {keys.error && <p role="alert" className="mt-2 text-xs text-danger">{keys.error}</p>}
          </SetupStep>
        </ol>
      </Panel>
    </>
  )
}

function SetupStep({ step, action, children }: { step: number; action?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-mono text-2xs tabular text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
        {step}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </li>
  )
}

function StepText({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <p className="text-sm leading-[18px]">
      <span className="font-medium text-ink">{title}</span>
      <span className="mt-0.5 block text-xs text-ink-muted">{hint}</span>
    </p>
  )
}

/** A confirmation waiting on the dialog, by account id so a removed account ends it. */
interface PendingConfirm {
  kind: 'disconnect' | 'reconnect'
  accountId: string
}

function ConnectedAccounts({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const {
    profiles,
    accounts,
    profileId,
    syncedAt,
    loaded,
    loading,
    error,
    connecting,
    disconnecting,
    notice,
    hydrate,
    load,
    refreshOnFocus,
    setProfile,
    createProfile,
    connect,
    cancelConnect,
    disconnect,
    dismissNotice
  } = useAccountsStore()

  // Cached accounts show at once; Zernio is only asked again when they're old.
  useEffect(() => {
    void hydrate().then(() => {
      const state = useAccountsStore.getState()
      if (!state.loading && Date.now() - Math.max(state.syncedAt, state.lastAttemptAt) > REFRESH_ON_OPEN_AFTER_MS) void state.load()
    })
  }, [hydrate])

  // Coming back from the browser is the moment an account appears.
  useEffect(() => {
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [refreshOnFocus])

  const profile = profiles.find((p) => p.id === profileId)
  const inProfile = accounts.filter((a) => a.profileId === profileId)
  const byPlatform = new Map(inProfile.map((a) => [a.platform, a]))
  const platforms = [...ZERNIO_PLATFORMS, ...inProfile.filter((a) => !isZernioPlatform(a.platform)).map((a) => a.platform)]
  const attention = inProfile.filter((a) => accountHealth(a) !== 'ok').length
  const hasData = syncedAt > 0
  const busy = Boolean(connecting) || Boolean(disconnecting) || savingProfile
  const profileNameValid = isValidProfileName(newProfileName)

  // An account disappearing (disconnected elsewhere) ends a pending confirmation.
  const pendingAccount = pending ? accounts.find((a) => a.id === pending.accountId) : undefined
  useEffect(() => {
    if (pending && !pendingAccount) setPending(null)
  }, [pending, pendingAccount])
  const closeConfirm = useCallback(() => setPending(null), [])

  let confirmRequest: ConfirmRequest | null = null
  if (pending && pendingAccount) {
    const name = platformName(pendingAccount.platform)
    const label = accountLabel(pendingAccount)
    confirmRequest = pending.kind === 'disconnect'
      ? {
          title: `Disconnect ${name}?`,
          body: `This also removes ${label} from your Zernio workspace. You can connect it again later.`,
          confirmLabel: 'Disconnect',
          confirmAriaLabel: `Confirm disconnecting ${name}`,
          onConfirm: () => void disconnect(pendingAccount.id)
        }
      : {
          title: `Reconnect ${name}?`,
          body: `Sign in as ${label}. A different ${name} account replaces it and permanently deletes its Zernio analytics, inbox and DM history. A renamed handle may also be treated as different.`,
          confirmLabel: 'Continue',
          confirmAriaLabel: `Confirm reconnecting ${name}`,
          tone: 'primary',
          onConfirm: () => { if (isZernioPlatform(pendingAccount.platform)) void connect(pendingAccount.platform, { reconnect: true }) }
        }
  }

  const toggleNewProfile = (): void => {
    setCreatingProfile((open) => !open)
    setProfileError(null)
  }
  const submitProfile = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!profileNameValid || busy) return
    setSavingProfile(true)
    setProfileError(null)
    try {
      await createProfile(newProfileName.trim())
      setCreatingProfile(false)
      setNewProfileName('')
    } catch (err) {
      setProfileError(errorMessage(err, 'Could not create the profile. Try again.'))
    } finally {
      setSavingProfile(false)
    }
  }
  const openNoticeAction = (action: AccountsNotice['action']): void => {
    if (action === 'billing') openLink(ZERNIO_LINKS.billing)
    else if (action === 'settings') onNavigate('settings')
  }

  return (
    <>
      <PageHeader
        title={TITLE}
        className="items-center"
        actions={
          <>
            {hasData && (
              <>
                <div className="flex items-center gap-2">
                  <span aria-hidden className="text-xs text-ink-subtle">Profile</span>
                  <Select
                    aria-label="Zernio profile"
                    value={profileId ?? ''}
                    onChange={setProfile}
                    options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder="No profiles yet"
                    disabled={busy || profiles.length === 0}
                    className="w-44"
                  />
                </div>
                <Button
                  iconOnly
                  aria-label="New profile"
                  title="New profile: one account per platform, for another brand or project"
                  icon={<Plus className="h-4 w-4" />}
                  onClick={toggleNewProfile}
                  disabled={busy}
                  aria-expanded={creatingProfile}
                  aria-controls="new-zernio-profile-form"
                />
              </>
            )}
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh accounts"
              title="Refresh"
              onClick={() => void load()}
              disabled={loading}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />}
            />
          </>
        }
      />

      <div className="mt-4 space-y-3">
        {creatingProfile && (
          <form id="new-zernio-profile-form" className="animate-fade-in" onSubmit={(event) => void submitProfile(event)}>
            <div className="glass-tile flex items-center gap-1.5 rounded-2xl p-1.5">
              <TextInput
                aria-label="Profile name"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
                maxLength={ZERNIO_PROFILE_NAME_MAX}
                required
                autoFocus
                disabled={savingProfile}
                placeholder="New profile name, e.g. My brand"
                aria-describedby="zernio-new-profile-hint"
                aria-invalid={Boolean(profileError)}
                onKeyDown={(event) => { if (event.key === 'Escape') setCreatingProfile(false) }}
                leading={<Plus className="h-3.5 w-3.5" />}
                className="min-w-0 flex-1"
              />
              <Button variant="ghost" disabled={savingProfile} onClick={() => setCreatingProfile(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={savingProfile} disabled={!profileNameValid || busy}>Create profile</Button>
            </div>
            {profileError ? (
              <p role="alert" className="mt-1.5 px-2 text-xs text-danger" data-selectable>{profileError}</p>
            ) : (
              <p id="zernio-new-profile-hint" className="mt-1.5 px-2 text-2xs text-ink-subtle">
                A profile holds one account per platform. Your Zernio key needs Full access and Read &amp; Write permission to use new ones.
              </p>
            )}
          </form>
        )}

        {notice && <NoticeBar notice={notice} onDismiss={dismissNotice} onAction={openNoticeAction} />}

        {error && (!hasData || error.kind === 'auth') ? (
          <Callout
            tone="danger"
            icon={error.kind === 'auth' ? <KeyRound /> : undefined}
            action={
              <>
                <Button size="sm" variant="ghost" onClick={() => onNavigate('settings')}>
                  Open Settings
                </Button>
                <Button size="sm" onClick={() => void load()} loading={loading}>
                  Try again
                </Button>
              </>
            }
          >
            {error.message}
            {hasData && <p className="mt-0.5 text-xs text-ink-muted">Showing the accounts from {syncedAgo(syncedAt)}.</p>}
          </Callout>
        ) : error ? (
          <StaleNotice error={error.message} offline={error.kind === 'offline'} syncedAt={syncedAt} loading={loading} onRetry={() => void load()} />
        ) : null}

        {profile?.isOverLimit && (
          <Callout tone="warning" action={<Button size="sm" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => openLink(ZERNIO_LINKS.billing)}>Zernio billing</Button>}>
            {profile.name} is over your Zernio plan’s profile limit, so its accounts can’t post.
          </Callout>
        )}

        {!hasData && !error && (loading || !loaded) && <LoadingTiles />}

        {hasData && (
          <Panel padded={false} className="p-1.5">
            {profile ? (
              <>
                <ul aria-label={`Accounts in ${profile.name}`} className={TILE_GRID}>
                  {platforms.map((platform) => {
                    const account = byPlatform.get(platform)
                    const connectable = isZernioPlatform(platform)
                    return (
                      <AccountTile
                        key={`${profileId}:${platform}:${account?.id ?? 'empty'}`}
                        platform={platform}
                        account={account}
                        connecting={connecting?.platform === platform}
                        busy={busy}
                        disconnecting={Boolean(account && disconnecting === account.id)}
                        onConnect={connectable ? () => void connect(platform) : undefined}
                        onReconnect={connectable && account
                          ? () => platform === 'tiktok' ? setPending({ kind: 'reconnect', accountId: account.id }) : void connect(platform, { reconnect: true })
                          : undefined}
                        onCancel={cancelConnect}
                        onDisconnect={() => { if (account) setPending({ kind: 'disconnect', accountId: account.id }) }}
                      />
                    )
                  })}
                </ul>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 pb-0.5 pt-2 text-2xs text-ink-subtle">
                  <p>
                    {inProfile.length === 0 ? (
                      'Nothing connected yet. Pick a platform; sign-in opens in your browser.'
                    ) : (
                      <>
                        <span className="font-mono tabular text-ink-muted">{inProfile.length}</span> connected
                        {attention > 0 && <span className="text-warning"> · {attention} need{attention === 1 ? 's' : ''} attention</span>}
                        {' · '}A second account on a platform goes in another profile.
                      </>
                    )}
                  </p>
                  <SyncedLabel syncedAt={syncedAt} stale={Boolean(error)} />
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 px-2.5 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">Create your first profile</p>
                  <p className="text-xs text-ink-muted">A profile groups the accounts for one brand or project.</p>
                </div>
                {!creatingProfile && (
                  <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={toggleNewProfile} disabled={busy}>
                    Create profile
                  </Button>
                )}
              </div>
            )}
          </Panel>
        )}

        <p className="px-1 text-2xs text-ink-subtle">
          Zernio bills per connected account, and your first 2 are free.{' '}
          <button
            onClick={() => openLink(ZERNIO_LINKS.pricing)}
            className="inline-flex items-center gap-0.5 text-ink-muted transition-colors hover:text-ink"
          >
            Pricing
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </p>
      </div>

      {confirmRequest && <ConfirmDialog request={confirmRequest} onClose={closeConfirm} />}
    </>
  )
}

type AccountHealth = 'ok' | 'sign-in' | 'unhealthy'

function accountHealth(account: ZernioAccount): AccountHealth {
  if (account.needsReconnect || !account.isActive) return 'sign-in'
  if (account.health === 'error' || account.canPost === false) return 'unhealthy'
  return 'ok'
}

/** "just now", "4 min ago", "3 h ago", or a date. */
function syncedAgo(syncedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - syncedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(syncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Re-renders on an interval so relative times stay current (no network). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function SyncedLabel({ syncedAt, stale }: { syncedAt: number; stale: boolean }): React.JSX.Element {
  const now = useNow(30_000)
  return (
    <span className={cn('whitespace-nowrap', stale ? 'text-warning' : 'text-ink-subtle')} data-testid="accounts-synced">
      {stale ? 'Last synced' : 'Synced'} {syncedAgo(syncedAt, now)}
    </span>
  )
}

/** Refresh failed but cached accounts are on screen: say so quietly, without hiding them. */
function StaleNotice({
  error,
  offline,
  syncedAt,
  loading,
  onRetry
}: {
  error: string
  offline: boolean
  syncedAt: number
  loading: boolean
  onRetry: () => void
}): React.JSX.Element {
  const now = useNow(30_000)
  return (
    <Callout
      tone="warning"
      role="status"
      icon={offline ? <WifiOff /> : undefined}
      action={
        <Button size="sm" variant="ghost" onClick={onRetry} loading={loading}>
          Try again
        </Button>
      }
    >
      <p>
        {error} <span className="text-ink-muted">Showing accounts from {syncedAgo(syncedAt, now)}.</span>
      </p>
    </Callout>
  )
}

function LoadingTiles(): React.JSX.Element {
  return (
    <Panel padded={false} className="p-1.5" aria-busy="true" aria-label="Loading your Zernio accounts">
      <ul className={TILE_GRID}>
        {ZERNIO_PLATFORMS.slice(0, 4).map((platform) => (
          <li key={platform} className="glass-tile flex items-center gap-2.5 rounded-xl p-1.5">
            <Skeleton className="h-8 w-8" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-2 w-32" />
            </div>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-2 px-2 pb-0.5 pt-2 text-2xs text-ink-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading your Zernio accounts…
      </p>
    </Panel>
  )
}

function NoticeBar({
  notice,
  onDismiss,
  onAction
}: {
  notice: AccountsNotice
  onDismiss: () => void
  onAction: (action: AccountsNotice['action']) => void
}): React.JSX.Element {
  const failed = notice.tone === 'danger'
  return (
    <Callout
      tone={failed ? 'danger' : notice.tone === 'success' ? 'success' : 'info'}
      role={failed ? 'alert' : 'status'}
      data-testid="accounts-notice"
      onDismiss={onDismiss}
      action={
        notice.action === 'billing' ? (
          <Button size="sm" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => onAction('billing')}>
            Zernio billing
          </Button>
        ) : notice.action === 'settings' ? (
          <Button size="sm" onClick={() => onAction('settings')}>
            Open Settings
          </Button>
        ) : undefined
      }
    >
      {notice.text}
    </Callout>
  )
}

function accountLabel(account: ZernioAccount): string {
  const handle = account.username ? `@${account.username}` : null
  if (account.displayName && handle && account.displayName.replace(/^@/, '') !== account.username) {
    return `${account.displayName} · ${handle}`
  }
  return handle ?? account.displayName ?? 'Connected account'
}

type LensStatus = 'off' | 'ok' | 'warning' | 'connecting'

/** The platform's lens with a status dot on its corner. */
function PlatformLens({ platform, status }: { platform: string; status: LensStatus }): React.JSX.Element {
  return (
    <span className="relative shrink-0">
      <PlatformIcon platform={platform} className={cn('h-8 w-8 rounded-lg transition-[filter,opacity] duration-150', status === 'off' && 'opacity-60 grayscale group-hover/tile:opacity-90 group-hover/tile:grayscale-0')} />
      {status !== 'off' && (
        <span
          aria-hidden
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-canvas',
            status === 'ok' ? 'bg-success' : status === 'warning' ? 'bg-warning' : 'animate-pulse bg-accent'
          )}
        />
      )}
    </span>
  )
}

/** Platform name over one line of detail; both truncate, the full detail is the tooltip. */
function TileText({ name, detail, title, detailId, dim = false }: {
  name: string
  detail: ReactNode
  title?: string
  detailId?: string
  dim?: boolean
}): React.JSX.Element {
  return (
    <span className="block min-w-0 flex-1">
      <span className={cn('block truncate text-sm font-medium leading-4', dim ? 'text-ink-muted group-hover/tile:text-ink' : 'text-ink')}>{name}</span>
      <span id={detailId} className="block truncate text-xs leading-4 text-ink-muted" title={title} data-selectable>{detail}</span>
    </span>
  )
}

interface AccountTileProps {
  platform: string
  account?: ZernioAccount
  connecting: boolean
  busy: boolean
  disconnecting: boolean
  /** Absent for platforms BridgeClip can't connect (accounts added in Zernio itself). */
  onConnect?: () => void
  /** Asks Zernio for a fresh sign-in on the connected account. */
  onReconnect?: () => void
  onCancel: () => void
  onDisconnect: () => void
}

function AccountTile({
  platform,
  account,
  connecting,
  busy,
  disconnecting,
  onConnect,
  onReconnect,
  onCancel,
  onDisconnect
}: AccountTileProps): React.JSX.Element {
  const detailId = useId()
  const name = platformName(platform)
  const health = account ? accountHealth(account) : 'ok'
  const attention = health !== 'ok'
  const state = account ? (health === 'sign-in' ? 'reconnect' : 'connected') : 'disconnected'

  // Not connected: the whole tile is the Connect button.
  if (!account && !connecting) {
    const note = isZernioPlatform(platform) ? PLATFORM_INFO[platform].note : undefined
    const disabled = busy || !onConnect
    return (
      <li data-platform={platform} data-state={state}>
        <button
          type="button"
          onClick={onConnect}
          disabled={disabled}
          aria-label={`Connect ${name}`}
          aria-describedby={note ? detailId : undefined}
          className={cn(
            'glass-tile group/tile flex w-full items-center gap-2.5 rounded-xl p-1.5 pr-2 text-left',
            disabled ? 'cursor-not-allowed opacity-60' : 'glass-tile-hover'
          )}
        >
          <PlatformLens platform={platform} status="off" />
          <TileText name={name} detail={<span className="text-ink-subtle">{note ?? 'Not connected'}</span>} title={note} detailId={detailId} dim />
          <span
            aria-hidden
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-2 text-2xs font-medium text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] transition-colors duration-150 group-hover/tile:bg-white/[0.11] group-hover/tile:text-ink"
          >
            <Plus className="h-3 w-3" />
            Connect
          </span>
        </button>
      </li>
    )
  }

  let detail: ReactNode
  let title: string | undefined
  if (connecting) {
    detail = account
      ? `Sign in again as ${account.username ? `@${account.username}` : 'the same account'} in your browser…`
      : `Finish signing in to ${name} in your browser…`
    title = account ? 'Finish in your browser. Sign in as the same account to keep its history.' : undefined
  } else if (account && disconnecting) {
    detail = 'Disconnecting…'
  } else if (account && attention) {
    const status = account.needsReconnect ? 'Reconnect needed' : !account.isActive ? 'Inactive' : 'Needs attention'
    detail = (
      <>
        <span className="text-warning">{status}</span> · {account.issue ?? accountLabel(account)}
      </>
    )
    title = [accountLabel(account), account.issue].filter(Boolean).join(' · ')
  } else if (account) {
    const issue = account.health === 'warning' ? account.issue : null
    detail = (
      <>
        {accountLabel(account)}
        {issue && <span className="text-ink-subtle"> · {issue}</span>}
      </>
    )
    title = [accountLabel(account), issue].filter(Boolean).join(' · ')
  }

  return (
    <li
      data-platform={platform}
      data-state={state}
      className={cn(
        'group/tile flex items-center gap-2.5 rounded-xl p-1.5 transition-colors duration-150',
        connecting
          ? 'border border-accent/30 bg-accent/[0.07]'
          : attention
            ? 'border border-warning/25 bg-warning/[0.05]'
            : 'glass-tile glass-tile-hover'
      )}
    >
      <PlatformLens platform={platform} status={connecting ? 'connecting' : attention ? 'warning' : 'ok'} />
      <TileText name={name} detail={connecting ? <span className="text-accent-hover">{detail}</span> : detail} title={title} />
      <div className="flex shrink-0 items-center gap-0.5">
        {connecting ? (
          <>
            <Loader2 className="mx-1 h-3.5 w-3.5 animate-spin text-accent-hover" aria-label="Waiting for your browser" />
            <Button variant="ghost" size="sm" iconOnly title="Cancel" aria-label={`Cancel connecting ${name}`} onClick={onCancel} icon={<X className="h-3.5 w-3.5" />} />
          </>
        ) : (
          <>
            {attention && onReconnect && (
              <Button size="sm" onClick={onReconnect} disabled={busy} aria-label={`Reconnect ${name}`}>
                Reconnect
              </Button>
            )}
            {/* Quiet until the tile is hovered or focused, so a full grid doesn't repeat the same buttons. */}
            <div className={cn('flex items-center gap-0.5 transition-opacity duration-150', disconnecting ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover/tile:opacity-100')}>
              {!attention && onReconnect && (
                <Button variant="ghost" size="sm" iconOnly title="Reconnect" aria-label={`Reconnect ${name}`} onClick={onReconnect} disabled={busy} icon={<RotateCw className="h-3.5 w-3.5" />} />
              )}
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                title="Disconnect"
                aria-label={`Disconnect ${name}`}
                onClick={onDisconnect}
                disabled={busy}
                loading={disconnecting}
                icon={<Unplug className="h-3.5 w-3.5" />}
                className="hover:bg-danger/10 hover:text-danger"
              />
            </div>
          </>
        )}
      </div>
    </li>
  )
}
