import { app, ipcMain, powerMonitor, shell, type BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { resolve } from 'path'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { REPO_URL } from '../shared/brand'
import {
  UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS, updateErrorMessage,
  type UpdateState, type UpdatesOffReason
} from '../shared/updates'
import { assertTrustedSender } from './security'
import { logger } from './logger'
import { PlatformGitHubProvider } from './update-provider'

/** The Developer ID team that signs official macOS builds (electron-builder.yml `mac.identity`). */
const MAC_TEAM_ID = '9CBJCDR3J2'

let getWindow: () => BrowserWindow | null = () => null
let lastCheckedAt: string | null = null
let state: UpdateState = { status: 'idle', currentVersion: app.getVersion(), lastCheckedAt }
let checkInFlight: Promise<void> | null = null

function publish(next: UpdateState): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

function base(): { currentVersion: string; lastCheckedAt: string | null } {
  return { currentVersion: app.getVersion(), lastCheckedAt }
}

function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : ''
}

function macBundlePath(): string {
  // …/BridgeClip.app/Contents/MacOS/BridgeClip
  return resolve(app.getPath('exe'), '..', '..', '..')
}

/** Official builds carry BridgeMind's Developer ID; a local `npm run dist:mac` build doesn't. */
function signedByBridgeMind(): Promise<boolean> {
  return new Promise((done) => {
    execFile('/usr/bin/codesign', ['--display', '--verbose=2', macBundlePath()], { timeout: 10_000 }, (error, _stdout, stderr) => {
      done(!error && stderr.includes(`TeamIdentifier=${MAC_TEAM_ID}`) && stderr.includes('Authority=Developer ID Application: '))
    })
  })
}

async function updatesOffReason(): Promise<UpdatesOffReason | null> {
  if (process.env.BRIDGECLIP_DISABLE_AUTO_UPDATE === '1') return 'disabled'
  if (is.dev || !app.isPackaged) return 'development'
  if (process.platform === 'darwin') {
    if (!(await signedByBridgeMind())) return 'unofficial'
    // Squirrel.Mac replaces the app bundle in place. It can't from the
    // read-only disk image or a quarantined copy macOS runs from a random path.
    const bundle = macBundlePath()
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return 'move-to-applications'
  }
  return null
}

/**
 * One check at a time. With autoDownload on, a found update starts downloading
 * right away; the events below move the state along.
 */
function check(trigger: 'scheduled' | 'user' | 'resume'): Promise<void> {
  if (state.status === 'off' || state.status === 'downloading' || state.status === 'ready') return Promise.resolve()
  if (checkInFlight) return checkInFlight
  logger.info('update.check', { trigger })
  publish({ ...base(), status: 'checking' })
  checkInFlight = autoUpdater.checkForUpdates()
    .then((result) => {
      // Download failures also arrive as 'error' events, which set the state.
      result?.downloadPromise?.catch(() => {})
    })
    .catch(() => { /* Reported through the 'error' event. */ })
    .finally(() => {
      checkInFlight = null
      lastCheckedAt = new Date().toISOString()
      // A check that ended without an event (nothing to report) goes back to idle.
      publish(state.status === 'checking' ? { ...base(), status: 'idle' } : { ...state, lastCheckedAt })
    })
  return checkInFlight
}

function registerIpc(): void {
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, getWindow())
    return listener(event, ...args)
  })
  handle('update:getState', () => state)
  handle('update:check', async () => {
    await check('user')
    return state
  })
  handle('update:install', () => {
    if (state.status !== 'ready') throw new Error('No update is ready to install.')
    logger.info('update.install', { version: state.version })
    // Reply to the renderer before the app starts quitting. The usual quit
    // handlers still run and stop any clipping jobs.
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  })
  handle('update:moveToApplications', () => {
    if (process.platform !== 'darwin' || state.status !== 'off' || state.reason !== 'move-to-applications') return false
    try {
      // Moves the bundle and relaunches from /Applications on success.
      return app.moveToApplicationsFolder()
    } catch (error) {
      logger.warn('update.move_failed', { code: errorCode(error) })
      return false
    }
  })
  handle('update:openReleaseNotes', async () => {
    const version = state.status === 'downloading' || state.status === 'ready' ? state.version : state.currentVersion
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false
    await shell.openExternal(`${REPO_URL}/releases/tag/v${version}`)
    return true
  })
}

async function start(): Promise<void> {
  const reason = await updatesOffReason()
  if (reason) {
    logger.info('update.off', { reason })
    publish({ ...base(), status: 'off', reason })
    return
  }

  autoUpdater.setFeedURL({ provider: 'custom', updateProvider: PlatformGitHubProvider })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('update-available', (info) => {
    logger.info('update.available', { version: info.version })
    publish({ ...base(), status: 'downloading', version: info.version, progress: null })
  })
  autoUpdater.on('update-not-available', () => {
    publish({ ...base(), status: 'up-to-date' })
  })
  autoUpdater.on('download-progress', (progress) => {
    if (state.status !== 'downloading') return
    publish({
      ...state,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    logger.info('update.ready', { version: info.version })
    publish({ ...base(), status: 'ready', version: info.version })
  })
  autoUpdater.on('error', (error) => {
    const httpStatus = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode: unknown }).statusCode) : null
    logger.warn('update.failed', { code: errorCode(error), httpStatus, during: state.status })
    // A later failed check must not hide an update that is already downloaded.
    if (state.status === 'ready') return
    publish({ ...base(), status: 'error', message: updateErrorMessage(error) })
  })

  setTimeout(() => void check('scheduled'), UPDATE_CHECK_DELAY_MS)
  setInterval(() => void check('scheduled'), UPDATE_CHECK_INTERVAL_MS)
  // A laptop that slept through a scheduled check catches up on wake.
  powerMonitor.on('resume', () => {
    if (!lastCheckedAt || Date.now() - Date.parse(lastCheckedAt) > UPDATE_CHECK_INTERVAL_MS) void check('resume')
  })
}

/**
 * Updates from GitHub Releases: check shortly after launch and every few
 * hours, download in the background, and install when the user restarts from
 * the app or the next time they quit.
 */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow
  registerIpc()
  void start()
}
