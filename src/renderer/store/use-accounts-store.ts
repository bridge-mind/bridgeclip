import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { platformName } from '../components/PlatformIcon'
import {
  isPostableAccount,
  type ZernioAccount,
  type ZernioConnectResult,
  type ZernioErrorInfo,
  type ZernioOverview,
  type ZernioPlatform,
  type ZernioProfile,
  isValidProfileName
} from '../../shared/zernio'

const PROFILE_STORAGE_KEY = 'bridgeclip.zernio.profileId'
/**
 * Coming back to the window refreshes at most this often. A refresh costs 3
 * Zernio requests and the free tier allows 60 a minute, so there is no polling.
 */
const FOCUS_REFRESH_MS = 60_000
/** While a sign-in is pending, returning to the window is when the new account appears (at most ~22 requests a minute). */
const FOCUS_REFRESH_CONNECTING_MS = 8_000

interface Connecting {
  platform: ZernioPlatform
  reconnect: boolean
  /** The profile the sign-in adds the account to, once known. */
  profileId: string | null
  /** Account ids on this platform before sign-in, to spot the new one on refresh. */
  knownAccountIds: string[]
  /** Accounts on this platform that needed a new sign-in before it started. */
  flaggedAccountIds: string[]
}

export interface AccountsNotice {
  tone: 'success' | 'danger' | 'neutral'
  text: string
  /** A next step the notice offers: Zernio's billing page, or BridgeClip's Settings. */
  action?: 'billing' | 'settings'
}

interface AccountsState {
  profiles: ZernioProfile[]
  accounts: ZernioAccount[]
  /** The selected Zernio profile. */
  profileId: string | null
  /** When the accounts shown were read from Zernio (ms); 0 before the first sync. */
  syncedAt: number
  /** Accounts are available to show, live or cached. */
  loaded: boolean
  loading: boolean
  /** Why the last refresh failed; the accounts shown are then from `syncedAt`. */
  error: ZernioErrorInfo | null
  lastAttemptAt: number
  connecting: Connecting | null
  disconnecting: string | null
  notice: AccountsNotice | null
  /** Shows the last synced accounts straight away and restores a pending sign-in. */
  hydrate: () => Promise<void>
  /** Re-reads accounts from Zernio; concurrent calls share one request. */
  load: () => Promise<void>
  refreshOnFocus: () => void
  setProfile: (profileId: string) => void
  createProfile: (name: string) => Promise<ZernioProfile>
  connect: (platform: ZernioPlatform, options?: { reconnect?: boolean; newProfileName?: string }) => Promise<void>
  cancelConnect: () => void
  disconnect: (accountId: string) => Promise<void>
  dismissNotice: () => void
}

function readSavedProfile(): string | null {
  try {
    return localStorage.getItem(PROFILE_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveProfile(profileId: string): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, profileId)
  } catch {
    // Only a convenience; the default profile is used next time.
  }
}

function pickProfile(profiles: ZernioProfile[], current: string | null): string | null {
  for (const preferred of [current, readSavedProfile()]) {
    if (preferred && profiles.some((p) => p.id === preferred)) return preferred
  }
  return (profiles.find((p) => p.isDefault) ?? profiles.find((p) => p.name.toLowerCase() === 'default') ?? profiles[0])?.id ?? null
}

function connectedText(platform: string, username?: string | null): string {
  return `${platformName(platform)} connected${username ? ` as @${username}` : ''}.`
}

function noticeFor(error: ZernioErrorInfo): AccountsNotice {
  return { tone: 'danger', text: error.message, action: error.billing ? 'billing' : error.kind === 'auth' ? 'settings' : undefined }
}

const INITIAL = {
  profiles: [] as ZernioProfile[],
  accounts: [] as ZernioAccount[],
  profileId: null,
  syncedAt: 0,
  loaded: false,
  loading: false,
  error: null,
  lastAttemptAt: 0,
  connecting: null,
  disconnecting: null,
  notice: null
} satisfies Partial<AccountsState>

// A key change bumps `generation`, so answers for the old workspace are dropped.
let generation = 0
// A completed local change must not be replaced by a sync that started before it.
let accountRevision = 0
let inFlight: Promise<void> | null = null
let hydrating: Promise<void> | null = null
let subscribed = false

export const useAccountsStore = create<AccountsState>((set, get) => {
  const refreshAfterChange = (): void => {
    const startedIn = generation
    // A request already in flight may have read the pre-change account list.
    // Let it finish, then fetch the completed provider state.
    if (inFlight) void inFlight.then(() => { if (startedIn === generation) void get().load() })
    else void get().load()
  }

  const applyOverview = (overview: ZernioOverview): void => {
    set({
      profiles: overview.profiles,
      accounts: overview.accounts,
      profileId: pickProfile(overview.profiles, get().profileId),
      syncedAt: overview.syncedAt ?? Date.now(),
      loaded: true
    })
  }

  // The browser may never reach the loopback redirect (tab closed early,
  // loopback blocked). A new or repaired account on refresh means it worked.
  const detectFinishedSignIn = (): void => {
    const connecting = get().connecting
    if (!connecting) return
    const candidates = get().accounts.filter((a) =>
      a.platform === connecting.platform && (!connecting.profileId || a.profileId === connecting.profileId))
    const found = candidates.find((a) => !connecting.knownAccountIds.includes(a.id)) ??
      (connecting.reconnect ? candidates.find((a) => connecting.flaggedAccountIds.includes(a.id) && !a.needsReconnect) : undefined)
    if (!found) return
    getApi().zernio.cancelConnect().catch(() => {})
    set({ connecting: null, notice: { tone: 'success', text: connectedText(found.platform, found.username) } })
  }

  const finishConnect = (result: ZernioConnectResult): void => {
    const connecting = get().connecting
    // A cancelled sign-in can still report its result after another platform's
    // flow has started. It must not finish that newer flow.
    if (connecting && result.platform !== connecting.platform) return
    if (connecting && result.ended === 'timeout') {
      // Check once more before giving up: the sign-in may have finished anyway.
      void get().load().then(() => {
        if (get().connecting === connecting) set({ connecting: null, notice: { tone: 'neutral', text: result.error ?? 'Stopped waiting for the browser.' } })
      })
      return
    }
    if (connecting) {
      set({
        connecting: null,
        notice: result.success
          ? { tone: 'success', text: connectedText(result.platform, result.username) }
          : { tone: 'danger', text: result.error ?? `Could not connect ${platformName(result.platform)}.`, action: result.billing ? 'billing' : undefined }
      })
    }
    if (result.success) {
      accountRevision += 1
      refreshAfterChange()
    } else void get().load()
  }

  const reset = ({ configured }: { configured: boolean }): void => {
    generation += 1
    accountRevision += 1
    inFlight = null
    hydrating = null
    set({ ...INITIAL })
    if (configured) void get().hydrate().then(() => get().load())
  }

  // Subscribe once, on first use, so a sign-in that finishes while another
  // page is open still lands.
  const ensureSubscribed = (): void => {
    if (subscribed) return
    subscribed = true
    const api = getApi().zernio
    api.onConnectResult(finishConnect)
    api.onReset(reset)
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('focus', () => {
        if (get().connecting) get().refreshOnFocus()
      })
    }
  }

  return {
    ...INITIAL,

    hydrate: () => {
      ensureSubscribed()
      const startedIn = generation
      hydrating ??= (async () => {
        const api = getApi().zernio
        const [cached, pending] = await Promise.all([api.cachedOverview().catch(() => null), api.pendingConnect().catch(() => null)])
        if (startedIn !== generation) return
        if (cached && get().syncedAt === 0) applyOverview(cached)
        if (pending && !get().connecting) {
          const onPlatform = get().accounts.filter((a) => a.platform === pending.platform)
          set({
            connecting: {
              platform: pending.platform,
              reconnect: pending.reconnect,
              profileId: pending.profileId,
              // Accounts created before the reload are unknown, so only repairs and ones added since are detected.
              knownAccountIds: onPlatform.map((a) => a.id),
              flaggedAccountIds: onPlatform.filter((a) => a.needsReconnect).map((a) => a.id)
            }
          })
        }
      })()
      return hydrating
    },

    load: () => {
      ensureSubscribed()
      if (inFlight) return inFlight
      const startedIn = generation
      const startedRevision = accountRevision
      set({ loading: true })
      const run = async (): Promise<void> => {
        try {
          const result = await getApi().zernio.sync()
          if (startedIn !== generation) return
          // A stale (cached) answer never replaces newer accounts already on screen.
          if (startedRevision === accountRevision && result.overview && (!result.stale || (result.overview.syncedAt ?? 0) > get().syncedAt)) applyOverview(result.overview)
          set({ error: result.error, loaded: true, lastAttemptAt: Date.now() })
          if (!result.stale) detectFinishedSignIn()
        } catch (err) {
          if (startedIn === generation) {
            set({ error: { message: errorMessage(err, 'Could not load your Zernio accounts.'), kind: 'other' }, loaded: true, lastAttemptAt: Date.now() })
          }
        } finally {
          if (startedIn === generation) set({ loading: false })
        }
      }
      const request = run().finally(() => {
        if (inFlight === request) inFlight = null
      })
      inFlight = request
      return request
    },

    refreshOnFocus: () => {
      const state = get()
      if (state.loading) return
      const since = Date.now() - Math.max(state.syncedAt, state.lastAttemptAt)
      const waitMs = state.error?.kind === 'rate_limit' && state.error.retryAfterSeconds
        ? state.error.retryAfterSeconds * 1000
        : state.connecting ? FOCUS_REFRESH_CONNECTING_MS : FOCUS_REFRESH_MS
      if (since >= waitMs) void state.load()
    },

    setProfile: (profileId) => {
      if (!get().profiles.some((p) => p.id === profileId)) return
      saveProfile(profileId)
      set({ profileId, notice: null })
    },

    createProfile: async (name) => {
      const startedIn = generation
      const profile = await getApi().zernio.createProfile(name)
      if (startedIn !== generation) throw new Error('The Zernio workspace changed. Please try again.')
      saveProfile(profile.id)
      set((state) => ({ profiles: [...state.profiles.filter((item) => item.id !== profile.id), profile], profileId: profile.id, notice: null }))
      return profile
    },

    connect: async (platform, { reconnect = false, newProfileName } = {}) => {
      if (get().connecting) return
      ensureSubscribed()
      const name = platformName(platform)
      const profileName = newProfileName?.trim()
      if (newProfileName !== undefined && (!isValidProfileName(newProfileName) || reconnect)) {
        set({ notice: { tone: 'danger', text: 'Enter a profile name of 1–80 characters before connecting.' } })
        return
      }
      const targetProfileId = profileName ? null : get().profileId
      const onPlatform = get().accounts.filter((a) => a.platform === platform)
      const connecting: Connecting = {
        platform,
        reconnect,
        profileId: targetProfileId,
        knownAccountIds: onPlatform.map((a) => a.id),
        flaggedAccountIds: onPlatform.filter((a) => a.needsReconnect).map((a) => a.id)
      }
      set({ connecting, notice: null })
      try {
        const start = await getApi().zernio.connect(platform, targetProfileId, profileName ? { newProfileName: profileName } : { reconnect })
        if (get().connecting !== connecting) {
          // A newer sign-in may already be running. Cancelling here would stop it.
          if (start.status === 'pending' && !get().connecting) getApi().zernio.cancelConnect().catch(() => {})
          return
        }
        if (start.createdProfile) {
          const createdProfile = start.createdProfile
          set((state) => ({ profiles: [...state.profiles.filter((p) => p.id !== createdProfile.id), createdProfile] }))
        }
        if ((start.status !== 'failed' || start.createdProfile) && start.profileId && start.profileId !== get().profileId) {
          // The workspace had no profile, or a new one was created for this sign-in.
          saveProfile(start.profileId)
          set({ profileId: start.profileId })
        }
        if (start.status === 'pending') {
          set({ connecting: { ...connecting, profileId: start.profileId } })
        } else if (start.status === 'connected') {
          set({ connecting: null, notice: { tone: 'success', text: `${name} is already connected${start.username ? ` as @${start.username}` : ''}.` } })
          accountRevision += 1
          refreshAfterChange()
        } else {
          set({ connecting: null, notice: noticeFor(start.error) })
        }
      } catch (err) {
        if (get().connecting === connecting) {
          set({ connecting: null, notice: { tone: 'danger', text: errorMessage(err, `Could not start connecting ${name}.`) } })
        }
      }
    },

    cancelConnect: () => {
      if (!get().connecting) return
      set({ connecting: null })
      getApi().zernio.cancelConnect().catch(() => {})
      // The sign-in may have finished just before the cancel.
      void get().load()
    },

    disconnect: async (accountId) => {
      if (get().disconnecting) return
      const account = get().accounts.find((a) => a.id === accountId)
      if (!account) return
      const startedIn = generation
      set({ disconnecting: accountId, notice: null })
      try {
        await getApi().zernio.disconnect(accountId)
        if (startedIn !== generation) return
        accountRevision += 1
        set((state) => ({ accounts: state.accounts.filter((a) => a.id !== accountId) }))
        set({ notice: { tone: 'success', text: `${platformName(account.platform)} disconnected.` } })
        refreshAfterChange()
      } catch (err) {
        if (startedIn === generation) set({ notice: { tone: 'danger', text: errorMessage(err, 'Could not disconnect the account.') } })
      } finally {
        if (startedIn === generation) set({ disconnecting: null })
      }
    },

    dismissNotice: () => set({ notice: null })
  }
})

/**
 * For other pages (e.g. posting): shows cached accounts at once, then
 * refreshes from Zernio when the data is older than `maxAgeMs`.
 */
export async function ensureAccountsLoaded(maxAgeMs = 60_000): Promise<void> {
  const store = useAccountsStore.getState()
  await store.hydrate()
  const { syncedAt, lastAttemptAt, loading } = useAccountsStore.getState()
  if (!loading && Date.now() - Math.max(syncedAt, lastAttemptAt) > maxAgeMs) await useAccountsStore.getState().load()
}

/** Accounts in `state`'s selected profile (or `profileId`) that can be posted to. */
export function selectPostableAccounts(state: Pick<AccountsState, 'accounts' | 'profileId'>, profileId = state.profileId): ZernioAccount[] {
  return state.accounts.filter((account) => account.profileId === profileId && isPostableAccount(account))
}

/** Postable accounts in the selected profile, stable across renders. */
export function usePostableAccounts(): ZernioAccount[] {
  return useAccountsStore(useShallow((state) => selectPostableAccounts(state)))
}
