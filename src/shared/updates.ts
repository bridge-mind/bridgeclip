// In-app updates, as the main process reports them to the renderer.

/** Why this copy of BridgeClip does not update itself. */
export type UpdatesOffReason =
  /** Running from source (`npm run dev`) or an unpackaged build. */
  | 'development'
  /** A local package build: not signed by BridgeMind, so the signed update would be rejected. */
  | 'unofficial'
  /** macOS is running the app from the disk image or a quarantined download, which can't be replaced. */
  | 'move-to-applications'
  /** Turned off with BRIDGECLIP_DISABLE_AUTO_UPDATE. */
  | 'disabled'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

type Base = {
  currentVersion: string
  /** ISO time of the last check that finished, successful or not. */
  lastCheckedAt: string | null
}

export type UpdateState = Base & (
  | { status: 'off'; reason: UpdatesOffReason }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  /** A newer version was found and is downloading in the background. */
  | { status: 'downloading'; version: string; progress: UpdateProgress | null }
  /**
   * Downloaded and checked against its SHA-512 (and on Windows, its signature):
   * installs on restart, or the next time BridgeClip quits. On macOS, Squirrel
   * checks the signature just after this; a failure there becomes 'error'.
   */
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }
)

export type UpdateStatus = UpdateState['status']

/** Background checks: shortly after launch, then on this interval. */
export const UPDATE_CHECK_DELAY_MS = 15_000
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * A short, user-facing reason for a failed check or download. Error text from
 * the network stack or electron-updater can include URLs and paths, so only
 * known codes are translated and everything else gets a generic message.
 */
export function updateErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  // Electron's net module reports failures as "net::ERR_…" messages without a code.
  const message = error instanceof Error ? error.message : ''
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)$/.test(code) ||
      /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED)/.test(message)) {
    return 'Could not reach GitHub. Check your connection and try again.'
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
    return 'No release for this platform yet.'
  }
  if (code === 'ENOSPC') return 'Not enough disk space to download the update.'
  if (code === 'ERR_CHECKSUM_MISMATCH' || code === 'ERR_UPDATER_INVALID_SIGNATURE') {
    return 'The downloaded update failed verification and was discarded.'
  }
  return 'Could not check for or download the update. Try again later.'
}
