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
