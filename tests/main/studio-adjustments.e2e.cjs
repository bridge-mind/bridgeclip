const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { loadMain } = require('../zernio/support/load-main.cjs')
const { defaultCaptionStyle } = loadMain("export * from './src/shared/custom-captions'")

test('caption navigation offers save, discard and cancel; failed saves stay; reload saves and discards correctly', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-caption-save-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'data'), env: { BRIDGECLIP_E2E_UNLOAD_CHOICE: 'save' } })
  t.after(async () => {
    if (t.passed === false) t.diagnostic(await session.page.locator('body').innerText().catch(() => 'Window closed'))
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await session.close(); fs.rmSync(root, { recursive: true, force: true })
  })
  const { app, page } = session
  // Electron owns before-unload dialogs; prevent Playwright from auto-answering.
  page.on('dialog', () => {})
  page.setDefaultTimeout(10000)
  const preset = { id: 'custom-test', name: 'Studio', baseId: 'pop', style: defaultCaptionStyle('pop') }
  await page.evaluate(preset => window.bridgeclip.captions.save(preset), preset)
  // Create preloads the caption list; reload after seeding outside the renderer store.
  await page.reload()
  const nav = name => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true })
  await nav('Captions').click()
  await page.getByRole('button', { name: 'Edit Studio', exact: true }).click()
  const name = page.getByRole('textbox', { name: 'Style name', exact: true })
  const leave = page.getByRole('dialog', { name: 'Save changes before leaving?' })
  await name.fill('Saved in place')
  await page.getByRole('button', { name: 'Save preset', exact: true }).click()
  await page.getByText('All changes saved', { exact: true }).waitFor()
  assert.equal(await name.inputValue(), 'Saved in place')
  assert.equal(await page.getByRole('table').count(), 0)
  await name.fill('Saved on exit')
  await nav('Jobs').click()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await leave.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'caption-save-prompt.png') })
  }
  await leave.getByRole('button', { name: 'Keep editing' }).click()
  assert.equal(await name.inputValue(), 'Saved on exit')
  // A menu-triggered destination must respect the same save guard.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update:show'))
  await leave.getByRole('button', { name: 'Keep editing' }).click()
  // Sidebar keyboard navigation is also guarded.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+3' : 'Control+3')
  await leave.getByRole('button', { name: 'Save & leave' }).click()
  await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.bridgeclip.captions.list()))[0].name, 'Saved on exit')
  await nav('Captions').click()
  await page.getByRole('button', { name: 'Edit Saved on exit', exact: true }).click()
  await name.fill('Discard me')
  await page.getByRole('button', { name: 'Back to presets' }).click()
  await leave.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Saved on exit', exact: true }).click()
  assert.equal(await name.inputValue(), 'Saved on exit')
  await name.fill('Saved on reload')
  // Electron's real will-prevent-unload Save path resumes only after the write.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
  await nav('Captions').click()
  await page.getByRole('button', { name: 'Edit Saved on reload', exact: true }).click()
  await name.fill('Discard on reload')
  await app.evaluate(() => { process.env.BRIDGECLIP_E2E_UNLOAD_CHOICE = 'discard' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
  await nav('Captions').click()
  await page.getByRole('button', { name: 'Edit Saved on reload', exact: true }).click()
  await name.fill('Save fails')
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('captions:save'); ipcMain.handle('captions:save', () => { throw new Error('Preset folder is read-only.') }) })
  await nav('Library').click()
  await leave.getByRole('button', { name: 'Save & leave' }).click()
  await leave.getByRole('alert').getByText(/read-only/).waitFor()
  assert.equal(await name.inputValue(), 'Save fails')
  await leave.getByRole('button', { name: 'Keep editing' }).click()
  await nav('Library').click()
  await leave.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor()
})

test('Posts pages preserve actionable groups and count preferences; crash reports can be reviewed and copied safely', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-posts-diagnostics-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'data') })
  t.after(async () => {
    if (t.passed === false) t.diagnostic(await session.page.locator('body').innerText().catch(() => 'Window closed'))
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await session.close(); fs.rmSync(root, { recursive: true, force: true })
  })
  const { app, page } = session
  // Electron owns before-unload dialogs; prevent Playwright from auto-answering.
  page.on('dialog', () => {})
  page.setDefaultTimeout(10000)
  await app.evaluate(({ ipcMain, BrowserWindow, clipboard }) => {
    clipboard.writeText = value => { globalThis.copiedReport = value }
    BrowserWindow.getAllWindows()[0].setSize(1200, 1000)
    globalThis.testPosts = Array.from({ length: 32 }, (_, i) => ({ id: `post-${i}`, clipPath: '/example.mp4', clipTitle: `Studio clip ${i + 1}`, createdAt: new Date(Date.now() - i * 60_000).toISOString(), uploadedAt: new Date().toISOString(), status: i === 30 ? 'scheduled' : i === 31 ? 'failed' : 'published', targets: [{ platform: 'youtube', accountId: 'test', handle: '@studio', status: i === 30 ? 'pending' : i === 31 ? 'failed' : 'published' }] }))
    for (const [channel, handler] of [
      ['settings:load', () => ({ openrouterConfigured: true, zernioConfigured: true, outputDirectory: '', pythonPath: '' })],
      ['zernio:posts:list', () => globalThis.testPosts],
      ['zernio:posts:refresh', () => ({ posts: globalThis.testPosts, error: null })],
      ['thumbnails:generate', () => null]
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  })
  await page.reload()
  const nav = name => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true })
  await nav('Posts').click()
  const recent = page.getByRole('region', { name: 'Recent', exact: true })
  const pages = page.getByRole('navigation', { name: 'Recent posts pages' })
  await recent.getByText('Studio clip 1', { exact: true }).waitFor()
  assert.equal(await recent.getByRole('listitem').count(), 10)
  await pages.getByRole('button', { name: 'Page 3', exact: true }).click()
  await recent.getByText('Studio clip 21', { exact: true }).waitFor()
  assert.equal(await page.getByRole('region', { name: 'Scheduled' }).getByRole('listitem').count(), 1)
  assert.equal(await page.getByRole('region', { name: 'Needs attention' }).getByRole('listitem').count(), 1)
  await pages.getByRole('combobox', { name: 'Rows per page' }).click()
  await page.getByRole('option', { name: '25 / page', exact: true }).click()
  await recent.getByText('Studio clip 1', { exact: true }).waitFor()
  assert.equal(await recent.getByRole('listitem').count(), 25)
  await pages.getByRole('button', { name: 'Next page' }).click()
  assert.equal(await recent.getByRole('listitem').count(), 5)
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'posts-pages.png'), animations: 'disabled' }) }
  await app.evaluate(() => { globalThis.testPosts = globalThis.testPosts.filter(p => p.status !== 'published').concat(globalThis.testPosts.slice(0, 3)) })
  await page.getByRole('button', { name: 'Refresh posts' }).click()
  await pages.getByRole('status').getByText('1–3 of 3', { exact: true }).waitFor()
  await page.reload()
  await nav('Posts').click()
  await pages.getByRole('combobox').getByText('25 / page', { exact: true }).waitFor()
  // A renderer error writes safe metadata, never the message or private path.
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { error: Object.assign(new Error('SECRET private media'), { stack: 'TypeError: SECRET\n    at private (/app/out/renderer/assets/index.js:42:10)', name: 'TypeError' }) })))
  await nav('Settings').click()
  const reports = page.getByRole('region', { name: 'Crash reports' })
  await reports.getByRole('button', { name: 'View report' }).click()
  const dialog = page.getByRole('dialog', { name: 'Crash report', exact: true })
  const body = await dialog.getByRole('textbox', { name: 'Crash report text' }).inputValue()
  assert.match(body, /Interface error/)
  assert.match(body, /renderer.js:42:10/)
  assert.doesNotMatch(body, /SECRET|private|\/app\//)
  await dialog.getByRole('button', { name: 'Copy issue report' }).click()
  await dialog.getByRole('button', { name: 'Copied', exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.copiedReport), body)
  if (shots) await dialog.screenshot({ path: path.join(shots, 'crash-report.png') })
  await page.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 })
  })
  assert.match((await page.evaluate(() => window.bridgeclip.diagnostics.crashReport())).markdown, /Interface crash[\s\S]*oom · Exit code: 137/)
})
