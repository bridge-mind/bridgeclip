const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('Update state appears in Settings and the sidebar, and restart installs it', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-updates-e2e-'))
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

  await report({ status: 'ready', version: '0.1.18' })
  await page.getByText('Version 0.1.18 is ready.', { exact: false }).waitFor()
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
  assert.deepEqual(errors, [])
})
