const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('About shows output storage and update state, and restart installs updates', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-updates-e2e-'))
  const outputDirectory = path.join(root, 'user-data', 'BridgeClip')
  fs.mkdirSync(path.join(outputDirectory, 'run', '.editor'), { recursive: true })
  fs.writeFileSync(path.join(outputDirectory, 'run', 'clip.mp4'), Buffer.alloc(2_000_000))
  fs.writeFileSync(path.join(outputDirectory, 'run', '.editor', 'source.mp4'), Buffer.alloc(500_000))
  const appDir = buildApp(path.join(root, 'app'))
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  const shot = async (name) => {
    if (!shots) return
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, name) })
  }

  // An unpackaged build never updates itself, and says so.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await page.getByText('Updates are off when running from source.', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Check for updates' }).count(), 0)

  // Real preload + IPC scan: nested editor files count, and refresh reflects changes.
  const storage = page.getByRole('region', { name: 'Content storage' })
  await storage.getByText('2.5 MB', { exact: true }).waitFor()
  await storage.getByText('2 files · Total file size in your output folder', { exact: true }).waitFor()
  await storage.getByText(outputDirectory, { exact: true }).waitFor()
  fs.unlinkSync(path.join(outputDirectory, 'run', 'clip.mp4'))
  await storage.getByRole('button', { name: 'Refresh storage usage' }).click()
  await storage.getByText('500 KB', { exact: true }).waitFor()
  await storage.getByText('1 file · Total file size in your output folder', { exact: true }).waitFor()
  fs.rmSync(outputDirectory, { recursive: true })
  await storage.getByRole('button', { name: 'Refresh storage usage' }).click()
  await storage.getByText('0 B', { exact: true }).waitFor()
  await storage.getByText('Your output folder has not been created yet.', { exact: true }).waitFor()

  // Failed scans remain recoverable from the same control.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:storageUsage')
    ipcMain.handle('settings:storageUsage', () => { throw new Error('Folder unavailable') })
  })
  await storage.getByRole('button', { name: 'Refresh storage usage' }).click()
  await storage.getByText('Could not read the output folder.', { exact: false }).waitFor()
  assert.equal(await storage.getByRole('button', { name: 'Refresh storage usage' }).isEnabled(), true)
  await app.evaluate(({ ipcMain }, outputDirectory) => {
    ipcMain.removeHandler('settings:storageUsage')
    ipcMain.handle('settings:storageUsage', () => ({ outputDirectory, bytes: 2_500_000, fileCount: 2, exists: true, unreadableCount: 1 }))
  }, outputDirectory)
  await storage.getByRole('button', { name: 'Refresh storage usage' }).click()
  await storage.getByText('At least 2.5 MB', { exact: true }).waitFor()
  await storage.getByText('Some files or folders could not be read.', { exact: false }).waitFor()

  // Stand in for the main process: record installs and report update states.
  await app.evaluate(({ ipcMain }) => {
    globalThis.updateTest = { installs: 0 }
    ipcMain.removeHandler('update:install')
    ipcMain.handle('update:install', () => { globalThis.updateTest.installs++; return true })
  })
  const report = (state) => app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows()[0].webContents.send('update:state', { currentVersion: '0.1.17', lastCheckedAt: new Date().toISOString(), ...state })
  }, state)

  await report({ status: 'up-to-date' })
  await page.getByText('You have the latest version.', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Check for updates' }).isEnabled(), true)

  await report({ status: 'downloading', version: '0.1.18', progress: { percent: 37.2, transferred: 37, total: 100, bytesPerSecond: 10 } })
  await page.getByText('Downloading version 0.1.18… 37%').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Check for updates' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: /Restart to update/ }).count(), 0)

  // DEB and RPM installs update only from Restart to update, behind a password prompt.
  await report({ status: 'ready', version: '0.1.18', installsOnQuit: false })
  await page.getByText('Restart to install it; your system asks for an administrator password.', { exact: false }).waitFor()
  await report({ status: 'ready', version: '0.1.18', installsOnQuit: true })
  await page.getByText('Version 0.1.18 is ready. Restart to install it, or it installs the next time you quit.', { exact: false }).waitFor()
  const sidebar = page.getByRole('button', { name: 'BridgeClip 0.1.18 is ready. Restart to update' })
  await sidebar.waitFor()
  if (shots) {
    await page.locator('#settings-about').scrollIntoViewIfNeeded()
    await shot('updates-ready-sidebar.png')
    await page.locator('#settings-about').screenshot({ path: path.join(shots, 'updates-ready-about.png') })
  }

  // No jobs are running, so restart goes straight to the installer.
  await sidebar.click()
  const installs = () => app.evaluate(() => globalThis.updateTest.installs)
  for (let i = 0; i < 40 && await installs() === 0; i++) await page.waitForTimeout(50)
  assert.equal(await installs(), 1)

  await report({ status: 'error', message: 'Could not reach GitHub. Check your connection and try again.' })
  await page.getByText('Could not reach GitHub.', { exact: false }).waitFor()
  assert.equal(await sidebar.count(), 0)

  await report({ status: 'off', reason: 'unsupported-install' })
  await page.getByText('This copy can’t update itself.', { exact: false }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Check for updates' }).count(), 0)
  assert.deepEqual(errors, [])

  // Reproduce renderer hot-reload against an older preload in a real Electron window.
  const preloadPath = path.join(appDir, 'out', 'preload', 'index.js')
  const preload = fs.readFileSync(preloadPath, 'utf8')
  assert.match(preload, /^\s*storageUsage:.*$/m)
  for (const [implementation, message] of [
    ['undefined', 'Restart BridgeClip to load the storage display.'],
    ['() => { throw new Error("Storage unavailable") }', 'Could not read the output folder.']
  ]) {
    fs.writeFileSync(preloadPath, preload.replace(/^(\s*)storageUsage:.*$/m, `$1storageUsage: ${implementation},`))
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('region', { name: 'Content storage' }).getByText(message, { exact: false }).waitFor({ timeout: 10000 })
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('heading', { name: 'Library', exact: true }).waitFor()
    assert.deepEqual(errors, [], 'an unavailable storage bridge must not unmount the app')
  }
})
