// Social accounts are connected through the user's own Zernio workspace
// (https://zernio.com). Zernio owns each platform's OAuth app and token
// refresh; BridgeClip only ever holds the user's Zernio API key.

/** Platforms BridgeClip offers to connect, in display order. Values are Zernio's API names. */
export const ZERNIO_PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook', 'twitter', 'linkedin', 'threads'] as const
export type ZernioPlatform = (typeof ZERNIO_PLATFORMS)[number]

/** Display names, shared by main-process messages and the renderer. */
export const ZERNIO_PLATFORM_NAMES: Record<ZernioPlatform, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'X',
  linkedin: 'LinkedIn',
  threads: 'Threads'
}

export function isZernioPlatform(value: unknown): value is ZernioPlatform {
  return typeof value === 'string' && (ZERNIO_PLATFORMS as readonly string[]).includes(value)
}

/** Zernio ids are 24-character hex object ids; accept a slightly wider shape. */
export function isZernioId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/**
 * A Zernio profile holds at most one account per platform; connecting a
 * platform a profile already has replaces that account. More accounts on one
 * platform therefore live in more profiles (profiles are free).
 */
export interface ZernioProfile {
  id: string
  name: string
  /** Zernio's default profile for the workspace, when it says so. */
  isDefault?: boolean
  /** Beyond a legacy plan's profile limit: its accounts can't post. */
  isOverLimit?: boolean
}

export const ZERNIO_PROFILE_NAME_MAX = 80

/** A profile name BridgeClip will send: 1–80 visible characters, no control characters. */
export function isValidProfileName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= ZERNIO_PROFILE_NAME_MAX &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
}

export interface ZernioAccount {
  id: string
  /** Zernio platform name; can be one BridgeClip doesn't offer (connected elsewhere). */
  platform: string
  username: string | null
  displayName: string | null
  profileId: string | null
  isActive: boolean
  /** From Zernio's account health check; null when unavailable. */
  health: 'healthy' | 'warning' | 'error' | null
  needsReconnect: boolean
  issue: string | null
  /** From the health check: false when Zernio knows posts would fail; null when unknown. */
  canPost?: boolean | null
  /** TikTok's connection lane, from this account's health endpoint. */
  integrationLane?: 'business' | 'developer' | null
  /** In a profile over a legacy plan's limit. */
  overLimit?: boolean
}

export interface ZernioOverview {
  profiles: ZernioProfile[]
  accounts: ZernioAccount[]
  /** When this data was read from Zernio (ms since epoch). */
  syncedAt?: number
}

export interface ZernioConnectResult {
  platform: string
  success: boolean
  username?: string
  error?: string
  accountId?: string
  /** The failure is fixed on Zernio's billing page (a card, a plan or a limit). */
  billing?: boolean
  /** Why the flow ended without a redirect from Zernio. */
  ended?: 'timeout' | 'unknown'
}

/** Accounts BridgeClip can post to: active and not waiting for a new sign-in. */
export function isPostableAccount(account: ZernioAccount): boolean {
  return account.isActive && !account.needsReconnect && account.canPost !== false && !account.overLimit
}

export type ZernioErrorKind = 'auth' | 'offline' | 'rate_limit' | 'payment' | 'not_found' | 'other'

/** A Zernio failure as the renderer sees it: safe text plus what the UI can offer. */
export interface ZernioErrorInfo {
  message: string
  kind: ZernioErrorKind
  /** Offer BridgeClip's fixed link to Zernio billing. */
  billing?: boolean
  retryAfterSeconds?: number
}

/** Freshest account data available: live from Zernio, or the cached copy when Zernio can't be reached. */
export interface ZernioSyncResult {
  overview: ZernioOverview | null
  /** `overview` is the cached copy from `overview.syncedAt`, not live data. */
  stale: boolean
  error: ZernioErrorInfo | null
}

export interface ZernioConnectOptions {
  /** Ask Zernio for a fresh sign-in on the account already in this profile (never for a new one). */
  reconnect?: boolean
  /** Create a profile with this name and connect into it (with `profileId` null). */
  newProfileName?: string
}

export type ZernioConnectStart =
  /** The browser is open; the outcome arrives as a `zernio:connectResult` event. */
  | { status: 'pending'; platform: ZernioPlatform; profileId: string; createdProfile?: ZernioProfile }
  /** Zernio finished without a browser (already connected, or a disconnected account re-enabled). */
  | { status: 'connected'; platform: ZernioPlatform; profileId: string; accountId: string | null; username: string | null; createdProfile?: ZernioProfile }
  | { status: 'failed'; platform: ZernioPlatform; profileId: string | null; error: ZernioErrorInfo; createdProfile?: ZernioProfile }

/** A sign-in waiting for its browser redirect; survives a renderer reload. */
export interface ZernioPendingConnect {
  platform: ZernioPlatform
  profileId: string
  reconnect: boolean
  startedAt: number
  /** The profile was created for this sign-in (and is removed again if it fails while still empty). */
  createdProfile?: boolean
}
