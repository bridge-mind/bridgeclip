import { app, BrowserWindow, nativeTheme, shell, protocol } from 'electron'
import { extname, join } from 'path'
import { mkdirSync } from 'fs'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createMenu } from './menu'
import { registerIpcHandlers } from './ipc-handlers'
import { initAutoUpdater } from './auto-updater'
import { logger, getLogFilePath, errorSummary } from './logger'
import { authorizeMedia, isTrustedExternalUrl, openAuthorizedMedia } from './security'
import { loadSettings } from './settings-store'
import { cleanStaleWorkspaces, stopAllJobsForQuit } from './pipeline-runner'
import { cancelQueuedJobsForQuit } from './job-manager'
import { cancelZernioConnect } from './zernio/service'
import { isAutomationMedia, startAutomationScheduler } from './automations'

// Catch crashes anywhere in the main process so we get a log line instead
// of a silent exit. Without these, an unhandled rejection in an IPC handler
// would disappear into the void in a packaged build.
process.on('uncaughtException', (err) => {
  logger.error('main.uncaughtException', errorSummary(err))
})
process.on('unhandledRejection', (reason) => {
  logger.error('main.unhandledRejection', errorSummary(reason))
})

let mainWindow: BrowserWindow | null = null

// Development-only: isolated settings (and single-instance lock) for
// end-to-end tests, so a test run never touches the developer's real app.
if (!app.isPackaged && process.env.BRIDGECLIP_USER_DATA_DIR) {
  const isolated = process.env.BRIDGECLIP_USER_DATA_DIR
  app.setPath('userData', isolated)
  // Settings migrate (and then delete) pre-rename files found under appData
  // and home, and logs default to the real app's file: point all of those
  // inside the isolated folder too.
  for (const name of ['appData', 'home'] as const) {
    const dir = join(isolated, `isolated-${name}`)
    mkdirSync(dir, { recursive: true })
    app.setPath(name, dir)
  }
  app.setAppLogsPath(join(isolated, 'logs'))
}

// Development-only: scripted end-to-end runs keep the window hidden and out
// of the Dock, so a test run never takes over the developer's screen.
const hiddenForTests = !app.isPackaged && process.env.BRIDGECLIP_E2E === '1'
if (hiddenForTests) {
  // Nor may it open the developer's real browser from any link.
  shell.openExternal = async (url: string): Promise<void> => {
    let host = 'invalid'
    try { host = new URL(url).hostname } catch { /* logged as invalid */ }
    logger.info('e2e.openExternal.blocked', { host })
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Packaged builds take their icon from the .app / .exe. Dev runs the stock
// Electron binary, so without this the dock and taskbar show the Electron atom.
const devIcon = join(__dirname, '../../build/icon.png')

function createWindow(): void {
  // The UI is dark-only; keep the vibrancy material and native menus dark too.
  nativeTheme.themeSource = 'dark'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    // Small enough for split screen and 13" laptops; below 1024px wide the
    // renderer collapses the sidebar to an icon rail.
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'BridgeClip',
    icon: is.dev ? devIcon : undefined,
    // macOS-only window chrome: 'hiddenInset' and trafficLightPosition are
    // ignored on other platforms, so only pass them on darwin.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // Vertically centred in the renderer's 40px title-bar strip, inside the
          // sidebar (72px icon rail or 200px full width).
          trafficLightPosition: { x: 16, y: 12 }
        }
      : {}),
    // macOS: a native vibrancy material under the renderer's translucent
    // backdrop (html.vibrant in globals.css). Elsewhere, a solid base.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000' }
      : { backgroundColor: '#07080c' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!hiddenForTests) mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isTrustedExternalUrl(details.url)) void shell.openExternal(details.url).catch(() => {})
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)

  createMenu(mainWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } }
])

app.whenReady().then(() => {
  cleanStaleWorkspaces()
  electronApp.setAppUserModelId('com.bridgemind.bridgeclip')
  if (hiddenForTests) app.dock?.hide()
  else if (is.dev) app.dock?.setIcon(devIcon)

  // Boot-time diagnostic dump. This is the first thing in the log file and
  // gives any future failure a full environment snapshot to reference.
  logger.info('app.boot', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
    logFile: getLogFilePath(),
    execPath: process.execPath
  })

  protocol.handle('local-file', async (request) => {
    let media: Awaited<ReturnType<typeof openAuthorizedMedia>> | undefined
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      const filePath = decodeURIComponent(request.url.slice('local-file://'.length))
      if (isAutomationMedia(filePath)) authorizeMedia(filePath)
      media = await openAuthorizedMedia(filePath, loadSettings().outputDirectory)
      const mimeType: Record<string, string> = {
        '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
        '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.flv': 'video/x-flv',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
      }
      const headers = new Headers({
        'Content-Type': mimeType[extname(media.canonical).toLowerCase()] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      })
      let start = 0
      let end = media.size - 1
      let status = 200
      const range = request.headers.get('range')
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match || (!match[1] && !match[2])) {
          await media.handle.close()
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.size}` } })
        }
        if (match[1]) {
          start = Number(match[1])
          end = match[2] ? Number(match[2]) : end
        } else {
          start = Math.max(0, media.size - Number(match[2]))
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= media.size) {
          await media.handle.close()
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.size}` } })
        }
        end = Math.min(end, media.size - 1)
        headers.set('Content-Range', `bytes ${start}-${end}/${media.size}`)
        status = 206
      }
      headers.set('Content-Length', String(Math.max(0, end - start + 1)))
      if (request.method === 'HEAD' || media.size === 0) {
        await media.handle.close()
        return new Response(null, { status, headers })
      }
      const stream = media.handle.createReadStream({ start, end, autoClose: true })
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers })
    } catch {
      await media?.handle.close().catch(() => {})
      return new Response('Media unavailable', { status: 403 })
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers(() => mainWindow)
  const stopAutomations = startAutomationScheduler()
  app.on('before-quit', stopAutomations)
  createWindow()
  initAutoUpdater(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  cancelQueuedJobsForQuit()
  stopAllJobsForQuit()
})
// A sign-in still waiting for its browser redirect must not hold the loopback port.
app.on('before-quit', () => cancelZernioConnect())
