import { app, BrowserWindow, Menu, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { APP_NAME, ISSUES_URL, REPO_URL } from '../shared/brand'
import { getLogFilePath } from './logger'
import { checkForUpdatesFromMenu } from './auto-updater'

export function createMenu(mainWindow: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Help',
      submenu: [
        ...(!is.dev
          ? [
              {
                label: 'Check for Updates…',
                // Goes through the app's updater, which respects "updates off".
                click: (): void => checkForUpdatesFromMenu()
              },
              { type: 'separator' as const }
            ]
          : []),
        {
          label: 'Changelog',
          click: (): void => {
            if (mainWindow.isDestroyed()) return
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.webContents.send('changelog:show')
          }
        },
        {
          label: `${APP_NAME} on GitHub`,
          click: (): void => {
            shell.openExternal(REPO_URL)
          }
        },
        {
          label: 'Report an Issue…',
          click: (): void => {
            shell.openExternal(ISSUES_URL)
          }
        },
        { type: 'separator' as const },
        {
          label: 'Show Logs',
          click: (): void => {
            shell.showItemInFolder(getLogFilePath())
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  // Handle app zoom before focused renderer controls or native accelerator
  // matching can consume it. Match physical keys too (including the keypad).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || input.isComposing ||
        !(isMac ? input.meta && !input.control : input.control && !input.meta)) return
    const out = input.key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract'
    const into = input.key === '+' || input.key === '=' || input.code === 'Equal' || input.code === 'NumpadAdd'
    const reset = !input.shift && (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0')
    if (!out && !into && !reset) return
    event.preventDefault() // Also suppress the menu accelerator: apply exactly once.
    const contents = mainWindow.webContents
    contents.setZoomLevel(reset ? 0 : contents.getZoomLevel() + (out ? -.5 : .5))
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const items: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'cut', enabled: Boolean(params.selectionText) },
          { role: 'copy', enabled: Boolean(params.selectionText) },
          { role: 'paste' },
          { type: 'separator' },
          { role: 'selectAll' }
        ]
      : [{ role: 'copy' }]
    Menu.buildFromTemplate(items).popup({ window: mainWindow })
  })

  mainWindow.setTitle(APP_NAME)
}
