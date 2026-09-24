import { app, shell, type BrowserWindow } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { quarantineUnbound, readableCache, workspaceId } from './workspace-cache'
import { loadSettings } from '../settings-store'
import { logger } from '../logger'
import {
  cleanHandle,
  connectUrlHost,
  isTrustedConnectUrl,
  paymentMessage,
  resetRateLimit,
  sanitizeProviderText,
  ZernioApiError,
  ZernioClient
} from './client'
import { isCallbackPending, startCallbackServer, stopCallbackServer } from './callback-server'
import { APP_NAME } from '../../shared/brand'
import {
  isZernioId,
  isZernioPlatform,
  isValidProfileName,
  ZERNIO_PLATFORM_NAMES,
  type ZernioAccount,
  type ZernioConnectResult,
  type ZernioConnectStart,
  type ZernioErrorInfo,
  type ZernioOverview,
  type ZernioPendingConnect,
  type ZernioPlatform,
  type ZernioProfile,
  type ZernioSyncResult
} from '../../shared/zernio'

type GetWindow = () => BrowserWindow | null

/** Development-only environment hooks for end-to-end tests; always off in packaged builds. */
function devHook(name: 'BRIDGECLIP_ZERNIO_API_URL' | 'BRIDGECLIP_E2E_BROWSER_URL' | 'BRIDGECLIP_E2E'): string | undefined {
  return app.isPackaged ? undefined : process.env[name] || undefined
}

export function getClient(): ZernioClient {
  const { zernioApiKey } = loadSettings()
  if (!zernioApiKey) throw new ZernioApiError('Add your Zernio API key to connect social accounts.', 401, 'missing_key')
  // Development-only hook for end-to-end tests against a local mock Zernio.
  return new ZernioClient(zernioApiKey, devHook('BRIDGECLIP_ZERNIO_API_URL'))
}

/** Renderer-safe description of any failure from this module. */
export function describeZernioError(error: unknown): ZernioErrorInfo {
  if (error instanceof ZernioApiError) {
    const kind = error.status === 401 || error.code === 'profile_access_denied' || error.code === 'insufficient_permissions' ? 'auth'
      : error.status === 0 ? 'offline'
        : error.status === 429 ? 'rate_limit'
          : error.status === 402 ? 'payment'
            : error.status === 404 ? 'not_found'
              : 'other'
    return {
      message: error.message,
      kind,
      ...(kind === 'payment' ? { billing: true } : {}),
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {})
    }
  }
  const message = error instanceof Error ? sanitizeProviderText(error.message, 200) : undefined
  return { message: message ?? 'Something went wrong talking to Zernio. Try again.', kind: 'other' }
}

// ---- Cached overview --------------------------------------------------------
// Zernio is the source of truth. The last overview is kept in userData so the
// Accounts page renders instantly and offline. It holds no secrets: profile
// names, account ids, platforms, handles and health.

const CACHE_VERSION = 2
const MAX_CACHE_BYTES = 2 * 1024 * 1024
/** Bumped whenever the key changes, so a request made with the old key can't refill the cache. */
let generation = 0

function cachePath(): string {
  return join(app.getPath('userData'), 'zernio-accounts.json')
}

function writeCache(overview: ZernioOverview): void {
  try {
    const key = loadSettings().zernioApiKey
    if (!key) return
    const path = cachePath()
    if (existsSync(path)) readCachedOverview()
    mkdirSync(join(path, '..'), { recursive: true })
    const tempPath = `${path}.${randomUUID()}.tmp`
    writeFileSync(tempPath, JSON.stringify({ version: CACHE_VERSION, workspace: workspaceId(key), ...overview }), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    renameSync(tempPath, path)
  } catch (error) {
    logger.warn('zernio.cache.writeFailed', { code: (error as NodeJS.ErrnoException).code ?? null })
  }
}

export function clearZernioCache(): void {
  try {
    quarantineUnbound(cachePath())
  } catch (error) {
    logger.warn('zernio.cache.clearFailed', { code: (error as NodeJS.ErrnoException).code ?? null })
  }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function cachedProfile(value: unknown): ZernioProfile | null {
  const row = value as Partial<ZernioProfile> | null
  if (!row || !isZernioId(row.id)) return null
  return {
    id: row.id,
    name: text(row.name, 80) ?? 'Untitled profile',
    ...(row.isDefault === true ? { isDefault: true } : {}),
    ...(row.isOverLimit === true ? { isOverLimit: true } : {})
  }
}

function cachedAccount(value: unknown): ZernioAccount | null {
  const row = value as Partial<ZernioAccount> | null
  if (!row || !isZernioId(row.id) || typeof row.platform !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(row.platform)) return null
  return {
    id: row.id,
    platform: row.platform,
    username: text(row.username, 120),
    displayName: text(row.displayName, 120),
    profileId: isZernioId(row.profileId) ? row.profileId : null,
    isActive: row.isActive !== false,
    health: row.health === 'healthy' || row.health === 'warning' || row.health === 'error' ? row.health : null,
    needsReconnect: row.needsReconnect === true,
    issue: text(row.issue, 160),
    canPost: typeof row.canPost === 'boolean' ? row.canPost : null,
    integrationLane: row.platform === 'tiktok' && (row.integrationLane === 'business' || row.integrationLane === 'developer') ? row.integrationLane : null,
    ...(row.overLimit === true ? { overLimit: true } : {})
  }
}

/** The last overview read from Zernio, or null when there is none (or no key). */
export function readCachedOverview(): ZernioOverview | null {
  try {
    const key = loadSettings().zernioApiKey
    if (!key) return null
    const path = cachePath()
    if (!existsSync(path)) return null
    if (!readableCache(path, MAX_CACHE_BYTES)) { quarantineUnbound(path); return null }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (raw.version !== CACHE_VERSION || raw.workspace !== workspaceId(key)) {
      quarantineUnbound(path)
      return null
    }
    if (!Array.isArray(raw.profiles) || !Array.isArray(raw.accounts)) return null
    const syncedAt = Number(raw.syncedAt)
    return {
      profiles: raw.profiles.map(cachedProfile).filter((p): p is ZernioProfile => p !== null).slice(0, 5000),
      accounts: raw.accounts.map(cachedAccount).filter((a): a is ZernioAccount => a !== null).slice(0, 5000),
      syncedAt: Number.isFinite(syncedAt) && syncedAt > 0 ? syncedAt : 0
    }
  } catch {
    return null
  }
}

/** Applies a local change (disconnect, profile edits) to the cached overview. */
function updateCache(change: (overview: ZernioOverview) => ZernioOverview): void {
  const cached = readCachedOverview()
  if (cached) writeCache(change(cached))
}

function removeCachedAccount(accountId: string): void {
  updateCache((overview) => ({
    ...overview,
    accounts: overview.accounts.filter((account) => account.id !== accountId)
  }))
}

// ---- Overview ---------------------------------------------------------------

export async function getZernioOverview(): Promise<ZernioOverview> {
  const startedIn = generation
  const client = getClient()
  const [profiles, accounts, health] = await Promise.all([
    client.listProfiles(),
    client.listAccounts(),
    // Health is a nice-to-have; the page still works without it.
    client.getAccountsHealth().catch((error) => {
      logger.warn('zernio.health.failed', { status: (error as { status?: number }).status ?? null })
      return null
    })
  ])
  const lanes = new Map(await Promise.all(accounts.filter((account) => account.platform === 'tiktok').map(async (account) => {
    try {
      return [account.id, await client.getTikTokIntegrationLane(account.id)] as const
    } catch (error) {
      logger.warn('zernio.tiktok.health.failed', { status: (error as { status?: number }).status ?? null })
      return [account.id, null] as const
    }
  })))
  const overLimit = new Set(profiles.filter((profile) => profile.isOverLimit).map((profile) => profile.id))
  const overview: ZernioOverview = {
    profiles,
    accounts: accounts.map((account) => {
      const row = health?.get(account.id)
      const merged = row ? { ...account, ...row, needsReconnect: account.needsReconnect || row.needsReconnect } : account
      if (account.platform === 'tiktok') merged.integrationLane = lanes.get(account.id) ?? null
      return account.profileId && overLimit.has(account.profileId) ? { ...merged, overLimit: true } : merged
    }),
    syncedAt: Date.now()
  }
  if (startedIn === generation) writeCache(overview)
  return overview
}

export async function createZernioProfile(rawName: unknown): Promise<ZernioProfile> {
  if (!isValidProfileName(rawName)) throw new Error('Enter a profile name of 1–80 characters.')
  const key = loadSettings().zernioApiKey
  const profile = await getClient().createProfile(rawName.trim())
  if (loadSettings().zernioApiKey !== key) throw new Error('The Zernio workspace changed. Please try again.')
  updateCache((overview) => ({ ...overview, profiles: [...overview.profiles, profile] }))
  return profile
}

/** Live data when Zernio answers; otherwise the cached copy plus the reason it isn't live. */
export async function syncZernioAccounts(): Promise<ZernioSyncResult> {
  try {
    return { overview: await getZernioOverview(), stale: false, error: null }
  } catch (error) {
    const info = describeZernioError(error)
    logger.warn('zernio.sync.failed', { kind: info.kind, status: error instanceof ZernioApiError ? error.status : null })
    return { overview: readCachedOverview(), stale: true, error: info }
  }
}

// ---- Connect ----------------------------------------------------------------

let pending: ZernioPendingConnect | null = null
let pendingCleanup: (() => Promise<void>) | null = null
let connectGeneration = 0

function send(getWindow: GetWindow, channel: string, payload: unknown): BrowserWindow | null {
  const window = getWindow()
  if (!window || window.isDestroyed()) return null
  window.webContents.send(channel, payload)
  return window
}

function bringToFront(window: BrowserWindow): void {
  // Scripted test runs keep their window hidden and never take focus.
  if (devHook('BRIDGECLIP_E2E') === '1') return
  if (window.isMinimized()) window.restore()
  window.show()
  // The user is coming back from their browser; macOS won't raise the app without this.
  if (process.platform === 'darwin') app.focus({ steal: true })
  window.focus()
}

/** Opens the sign-in page in the user's browser. */
async function openInBrowser(url: string): Promise<void> {
  // Development-only: a scripted "browser" follows the link in e2e runs, so
  // tests never open the developer's real browser.
  const scriptedBrowser = devHook('BRIDGECLIP_E2E_BROWSER_URL')
  if (scriptedBrowser && /^http:\/\/127\.0\.0\.1:\d+\//.test(scriptedBrowser)) {
    const response = await fetch(scriptedBrowser, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    if (!response.ok) throw new Error('The test browser refused the sign-in link.')
    return
  }
  await shell.openExternal(url)
}

function parseConnectOptions(value: unknown): { reconnect: boolean; newProfileName: string | null } {
  if (value === undefined || value === null) return { reconnect: false, newProfileName: null }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connect options')
  const { reconnect, newProfileName, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0 || (reconnect !== undefined && typeof reconnect !== 'boolean') ||
    (newProfileName !== undefined && !isValidProfileName(newProfileName))) throw new Error('Invalid connect options')
  return { reconnect: reconnect === true, newProfileName: typeof newProfileName === 'string' ? newProfileName.trim() : null }
}

/** The workspace's default profile, or one created for BridgeClip when it has none. */
async function ensureProfile(client: ZernioClient): Promise<string> {
  // Every Zernio workspace starts with a "Default" profile, but it can be deleted.
  const profiles = await client.listProfiles()
  const existing = profiles.find((profile) => profile.isDefault) ?? profiles[0]
  if (existing) return existing.id
  try {
    return (await client.createProfile(APP_NAME)).id
  } catch (error) {
    if (error instanceof ZernioApiError && error.status === 403 && !error.code) {
      throw new ZernioApiError("Your Zernio plan's profile limit is reached, so BridgeClip couldn't create a profile. Free one up in Zernio and try again.", 403, 'profile_limit')
    }
    throw error
  }
}

/**
 * Text for the `error` codes Zernio appends to the connect redirect
 * (docs.zernio.com connect/get-connect-url). New codes appear without notice,
 * so anything unknown reads as a generic failure with Zernio's own message.
 */
export function describeConnectError(platform: ZernioPlatform, params: URLSearchParams): { message: string; billing: boolean } {
  const raw = (params.get('error') ?? '').toLowerCase()
  const code = /^[a-z0-9_]{1,64}$/.test(raw) ? raw : 'unknown'
  const name = ZERNIO_PLATFORM_NAMES[platform]
  const detail = sanitizeProviderText(params.get('error_message'))
  const billing = (message: string): { message: string; billing: boolean } => ({ message, billing: true })
  const plain = (message: string): { message: string; billing: boolean } => ({ message, billing: false })

  const perProfile = /^one_([a-z]+)_per_profile$/.exec(code)
  if (perProfile) return plain(`This Zernio profile already has a ${name} account. Disconnect it first, or connect on another profile.`)

  switch (code) {
    case 'oauth_denied':
    case 'access_denied_by_user':
      return plain(`${name} sign-in was cancelled or access wasn't approved. Connect again and approve access to finish.`)
    case 'connection_cancelled':
      return plain('The sign-in window was closed before it finished. Connect again to retry.')
    case 'session_expired':
      return plain('The sign-in took too long and expired. Connect again to start a new one.')
    case 'missing_tiktok_permissions':
      return plain("TikTok needs every permission on its consent screen. Nothing changed; connect again and leave every permission on.")
    case 'missing_google_permissions':
      return plain("Google needs every YouTube permission on its consent screen. Connect again and allow them all.")
    case 'personal_account_not_supported':
      return plain(`${name} needs a Business or Creator account. Switch the account type in the ${name} app, then connect again.`)
    case 'no_facebook_pages':
      return plain("This Facebook login doesn't manage any Pages. Create a Page or get admin access to one, then connect again.")
    case 'facebook_pages_error':
      return plain("Zernio couldn't load your Facebook Pages. Try connecting again.")
    case 'platform_requires_destination':
      return plain(`Pick a Page, organization or board on Zernio's screen to finish connecting ${name}.`)
    case 'reconnect_account_mismatch':
      return plain(`You signed in to a different ${name} account than the one being reconnected. Sign in as the same account, or disconnect it first.`)
    case 'payment_required':
      return billing(paymentMessage(params.get('reason')))
    case 'account_limit_exceeded':
      return billing("Your Zernio plan's connected-account limit is reached. Upgrade or disconnect an account in Zernio.")
    case 'profile_limit_exceeded':
      return billing("Your Zernio plan's profile limit is reached. Upgrade or remove a profile in Zernio.")
    case 'profile_not_found':
    case 'invalid_profile_id':
      return plain('That Zernio profile no longer exists. Refresh the page and try again.')
    case 'access_denied':
      return plain("Your Zernio API key can't access this profile. Check the key's access in Zernio.")
    case 'unsupported_platform':
      return plain(`Zernio can't connect ${name} for this workspace.`)
    case 'byok_config_error':
      return plain(`Your Zernio workspace's own ${name} app settings are incomplete. Check them in Zernio.`)
    default:
      return plain(detail
        ? `Zernio couldn't connect ${name}: ${detail}`
        : `Zernio couldn't connect ${name}. Try again, or check your Zernio dashboard.`)
  }
}

/** The outcome Zernio reported on the redirect. The account list stays the source of truth. */
export function connectResultFrom(platform: ZernioPlatform, params: URLSearchParams): ZernioConnectResult {
  if (params.has('error')) {
    const { message, billing } = describeConnectError(platform, params)
    return { platform, success: false, error: message, ...(billing ? { billing: true } : {}) }
  }
  const accountId = params.get('accountId')
  const username = cleanHandle(params.get('username'))
  return {
    platform,
    success: true,
    ...(username ? { username } : {}),
    ...(isZernioId(accountId) ? { accountId } : {})
  }
}

/**
 * Open Zernio's hosted sign-in for `platform` in the default browser. Zernio
 * redirects back to a one-shot loopback URL, which reports the outcome to the
 * renderer. The renderer then re-reads the account list from Zernio, so the
 * redirect is only a hint, never the source of truth.
 */
export async function connectZernioAccount(
  platform: unknown,
  profileId: unknown,
  options: unknown,
  getWindow: GetWindow
): Promise<ZernioConnectStart> {
  if (!isZernioPlatform(platform)) throw new Error('Unsupported platform')
  if (profileId !== null && !isZernioId(profileId)) throw new Error('Invalid Zernio profile')
  const { reconnect, newProfileName } = parseConnectOptions(options)
  if (newProfileName && (profileId !== null || reconnect)) throw new Error('Choose a new profile or an existing profile to reconnect.')

  // A new sign-in replaces any pending one, e.g. from before the window reloaded.
  cancelZernioConnect()
  const startedIn = connectGeneration
  const isCurrent = (): boolean => startedIn === connectGeneration
  let targetProfileId: string | null = profileId
  let client: ZernioClient | null = null
  let createdProfile: ZernioProfile | null = null
  let profileRemoved = false
  let stage = 'prepare'
  let cleanupPromise: Promise<void> | null = null
  const cleanupCreatedProfile = (): Promise<void> => {
    if (!createdProfile || !client) return Promise.resolve()
    cleanupPromise ??= (async () => {
      try {
        // A completed browser sign-in may have attached an account before its
        // redirect was lost. Never remove a profile that now has an account.
        if ((await client!.listAccounts({ profileId: createdProfile!.id })).length === 0) {
          await client!.deleteProfile(createdProfile!.id)
          profileRemoved = true
        }
        logger.info('zernio.connect.profileCleanup', { traceId: client!.traceId, outcome: profileRemoved ? 'removed' : 'has_accounts' })
      } catch (error) {
        logger.warn('zernio.connect.profileCleanupFailed', { traceId: client!.traceId, status: error instanceof ZernioApiError ? error.status : null })
      }
    })()
    return cleanupPromise
  }
  try {
    client = getClient()
    logger.info('zernio.connect.requested', { traceId: client.traceId, platform, reconnect, newProfile: Boolean(newProfileName) })
    if (newProfileName) {
      stage = 'create_profile'
      createdProfile = await client.createProfile(newProfileName)
      targetProfileId = createdProfile.id
      logger.info('zernio.connect.profileCreated', { traceId: client.traceId, platform })
    } else {
      stage = 'resolve_profile'
      targetProfileId ??= await ensureProfile(client)
    }
    if (!isCurrent()) throw new Error('This sign-in was cancelled.')

    const connect: ZernioPendingConnect = { platform, profileId: targetProfileId, reconnect, startedAt: Date.now(), ...(createdProfile ? { createdProfile: true } : {}) }
    stage = 'callback_server'
    const nonce = randomBytes(16).toString('hex')
    const redirectUrl = await startCallbackServer(`/zernio/connected/${nonce}`, {
      onCallback: (params) => {
        if (!isCurrent() || pending !== connect) return
        pending = null
        pendingCleanup = null
        const result = connectResultFrom(platform, params)
        if (!result.success) void cleanupCreatedProfile()
        logger.info('zernio.connect.result', { platform, success: result.success, category: result.success ? 'success' : 'provider_error' })
        const window = send(getWindow, 'zernio:connectResult', result)
        if (window) bringToFront(window)
      },
      onTimeout: () => {
        if (!isCurrent() || pending !== connect) return
        pending = null
        pendingCleanup = null
        void cleanupCreatedProfile()
        logger.info('zernio.connect.timeout', { platform })
        send(getWindow, 'zernio:connectResult', {
          platform,
          success: false,
          ended: 'timeout',
          error: 'BridgeClip stopped waiting for the browser after 10 minutes. If you finished signing in, refresh; otherwise connect again.'
        } satisfies ZernioConnectResult)
      }
    })
    if (!isCurrent()) throw new Error('This sign-in was cancelled.')

    stage = 'authorize_platform'
    const start = await client.startConnect(platform, targetProfileId, redirectUrl, { force: reconnect })
    if (!isCurrent()) throw new Error('This sign-in was cancelled.')
    if (start.kind === 'connected') {
      stopCallbackServer()
      logger.info('zernio.connect.withoutBrowser', { platform, reconnect })
      return { status: 'connected', platform, profileId: targetProfileId, accountId: start.accountId, username: start.username, ...(createdProfile ? { createdProfile } : {}) }
    }
    if (!isTrustedConnectUrl(start.authUrl, platform)) {
      const host = connectUrlHost(start.authUrl)
      logger.warn('zernio.connect.untrustedLink', { platform, host })
      throw new ZernioApiError(`Zernio sent a sign-in link to an unexpected site (${host}), so BridgeClip didn't open it. Please report this issue.`, 502, 'untrusted_link')
    }

    pending = connect
    pendingCleanup = cleanupCreatedProfile
    stage = 'open_browser'
    await openInBrowser(start.authUrl).catch(() => {
      throw new Error("BridgeClip couldn't open your web browser. Check that a default browser is set, then try again.")
    })
    if (!isCurrent()) throw new Error('This sign-in was cancelled.')
    logger.info('zernio.connect.start', { platform, reconnect })
    return { status: 'pending', platform, profileId: targetProfileId, ...(createdProfile ? { createdProfile } : {}) }
  } catch (error) {
    const wasCurrent = isCurrent()
    const workspaceGeneration = generation
    if (isCurrent()) cancelZernioConnect()
    await cleanupCreatedProfile()
    const info = describeZernioError(error)
    // Creation can succeed even when a scoped key cannot connect or clean up.
    // Keep the known profile visible so retries don't silently create another.
    const retainedProfile = wasCurrent && workspaceGeneration === generation && createdProfile && !profileRemoved ? createdProfile : null
    if (retainedProfile) {
      updateCache((overview) => ({ ...overview, profiles: [...overview.profiles.filter((profile) => profile.id !== retainedProfile.id), retainedProfile] }))
      info.message = `The profile was created, but connecting ${ZERNIO_PLATFORM_NAMES[platform]} failed. ${info.message} BridgeClip could not remove the new profile; check it in Zernio before creating another.`
    }
    logger.warn('zernio.connect.failed', { traceId: client?.traceId ?? null, platform, stage, profileCreated: Boolean(createdProfile), profileRemoved, kind: info.kind, status: error instanceof ZernioApiError ? error.status : null })
    return { status: 'failed', platform, profileId: targetProfileId, error: info, ...(retainedProfile ? { createdProfile: retainedProfile } : {}) }
  }
}

/** The sign-in still waiting for its redirect, so a reloaded renderer can show it. */
export function getPendingZernioConnect(): ZernioPendingConnect | null {
  if (pending && !isCallbackPending()) pending = null
  return pending
}

export function cancelZernioConnect(): void {
  connectGeneration += 1
  stopCallbackServer()
  pending = null
  const cleanup = pendingCleanup
  pendingCleanup = null
  if (cleanup) void cleanup()
}

export async function disconnectZernioAccount(accountId: unknown): Promise<void> {
  if (!isZernioId(accountId)) throw new Error('Invalid Zernio account')
  const removed = await getClient().deleteAccount(accountId)
  removeCachedAccount(accountId)
  logger.info('zernio.disconnect', { alreadyRemoved: !removed })
}

const resetListeners = new Set<() => void>()

/** Run `listener` whenever the Zernio key changes, to drop other per-workspace state. */
export function onZernioReset(listener: () => void): () => void {
  resetListeners.add(listener)
  return () => resetListeners.delete(listener)
}

/**
 * A different key may be a different Zernio workspace: drop everything tied
 * to the old one (cache, pending sign-in, rate-limit wait) and tell the renderer.
 */
export function resetZernioState(getWindow: GetWindow): void {
  generation += 1
  cancelZernioConnect()
  clearZernioCache()
  resetRateLimit()
  for (const listener of resetListeners) {
    try {
      listener()
    } catch (error) {
      logger.warn('zernio.reset.listenerFailed', { name: (error as Error)?.name ?? null })
    }
  }
  let configured = false
  try {
    configured = Boolean(loadSettings().zernioApiKey)
  } catch { /* Settings unreadable: the renderer shows the setup screen. */ }
  logger.info('zernio.reset', { configured })
  send(getWindow, 'zernio:reset', { configured })
}
