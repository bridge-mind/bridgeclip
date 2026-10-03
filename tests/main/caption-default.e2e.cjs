const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { loadMain } = require('../zernio/support/load-main.cjs')
const { defaultCaptionStyle } = loadMain("export { defaultCaptionStyle } from './src/shared/custom-captions'")

test('choose a shared caption default, preserve the current draft and use saved defaults for new clips', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-caption-default-'))
  const appDir = buildApp(path.join(root, 'app')), userDataDir = path.join(root, 'data')
  let session = await launchApp({ appDir, userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  await app.evaluate(({ BrowserWindow, ipcMain }, root) => {
    BrowserWindow.getAllWindows()[0].setSize(1360, 1000)
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    globalThis.captionRequests = []
    for (const [channel, handler] of [
      ['settings:load', () => ({ openrouterConfigured: true, zernioConfigured: false, outputDirectory: root, pythonPath: '' })],
      ['system:checkTools', () => ({ python: true, pythonDeps: true, ffmpeg: true, ffmpegCaptions: true, ffprobe: true, ytdlp: true, engine: true, bridgeRunner: true })],
      ['job:start', (_event, request) => { globalThis.captionRequests.push(request); return { error: 'Captured test request' } }]
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  }, root)
  const preset = { id: 'custom-studio', name: 'Studio Mint', baseId: 'sweep', style: { ...defaultCaptionStyle('sweep'), highlight_color: '#73FBC9' } }
  await page.evaluate(async preset => {
    await window.bridgeclip.captions.save(preset)
    await window.bridgeclip.captions.savePreferences({ defaultId: null, favorites: ['paper'] })
  }, preset)
  await page.reload()
  const nav = name => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true })
  const setupVideo = async () => {
    await nav('Create').click()
    await page.getByPlaceholder('YouTube, Twitch VOD or direct video link').fill('https://example.com/captions.mp4')
    await page.getByRole('button', { name: 'Use link', exact: true }).click()
    await page.getByRole('radio', { name: 'Automatic', exact: true }).click()
  }
  const captionsStep = () => page.getByRole('navigation', { name: 'Create steps' }).getByRole('button', { name: /Captions/ }).click()
  await setupVideo()
  await captionsStep()
  const defaults = page.getByRole('radiogroup', { name: 'Caption style', exact: true })
  assert.equal(await defaults.getByRole('radio', { name: 'Paper', exact: true }).getAttribute('aria-checked'), 'true')
  await defaults.getByRole('radio', { name: 'Pop', exact: true }).click()
  await nav('Captions').click()
  const control = page.getByRole('combobox', { name: 'Default caption', exact: true })
  assert.match(await control.innerText(), /First bookmark.*Paper/)
  await control.click()
  await page.getByRole('option', { name: 'Studio Mint · Custom', exact: true }).click()
  await page.waitForFunction(async () => (await window.bridgeclip.captions.preferences()).defaultId === 'custom-studio')
  await nav('Create').click()
  assert.equal(await defaults.getByRole('radio', { name: 'Pop', exact: true }).getAttribute('aria-checked'), 'true', 'changing defaults preserves an existing selection')

  // A fresh wizard uses the custom default even when Generate is used before Captions.
  await page.reload()
  await setupVideo()
  await page.getByRole('button', { name: 'Next: Format', exact: true }).click()
  await page.getByRole('button', { name: 'Generate now', exact: true }).click()
  await page.getByText('Captured test request', { exact: true }).waitFor()
  const request = await app.evaluate(() => globalThis.captionRequests.at(-1))
  assert.deepEqual(request.customCaption, preset)
  assert.equal(request.captionPreset, 'sweep')
  await captionsStep()
  assert.equal(await page.getByRole('radiogroup', { name: 'Your caption styles', exact: true }).getByRole('radio', { name: 'Studio Mint', exact: true }).getAttribute('aria-checked'), 'true')
  await nav('Captions').click()
  await page.getByRole('radiogroup', { name: 'Your caption presets', exact: true }).getByRole('radio', { name: 'Studio Mint', exact: true }).click()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'captions-default-setting.png'), animations: 'disabled' })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 850))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  await control.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('option', { name: 'Neon', exact: true }).click()
  await page.waitForFunction(async () => (await window.bridgeclip.captions.preferences()).defaultId === 'neon')
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'captions-default-compact.png'), animations: 'disabled' })
  await session.close()
  session = await launchApp({ appDir, userDataDir })
  await session.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Captions', exact: true }).click()
  const restored = session.page.getByRole('combobox', { name: 'Default caption', exact: true })
  assert.match(await restored.innerText(), /Neon/)
  await restored.click()
  await session.page.getByRole('option', { name: 'First bookmark (Paper)', exact: true }).click()
  await session.page.waitForFunction(async () => (await window.bridgeclip.captions.preferences()).defaultId === null)
})
