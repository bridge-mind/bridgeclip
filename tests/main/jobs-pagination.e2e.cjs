const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('Previous remembers the page size, resets filters and clamps history without affecting Active', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-jobs-pages-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow, ipcMain }, root) => {
    BrowserWindow.getAllWindows()[0].setSize(1300, 1100)
    const date = new Date().toISOString()
    globalThis.paginationTest = { history: Array.from({ length: 23 }, (_, i) => ({
      jobId: `previous-${i}`, date, videoTitle: `Saved video ${String(i + 1).padStart(2, '0')}`,
      clipCount: 3, status: i < 5 ? 'failed' : 'completed', outputDir: root,
      totalCostUsd: .03, finishedAt: date, durationMs: 90000, errorMessage: null
    })) }
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => globalThis.paginationTest.history)
    ipcMain.removeHandler('jobs:list')
    ipcMain.handle('jobs:list', () => Array.from({ length: 12 }, (_, i) => ({
      id: `active-${i}`, revision: 1, request: { videoUrl: `Live video ${i + 1}.mp4` },
      status: i < 2 ? 'planning' : 'queued', percent: 40, step: 'Finding moments', clipsDone: 0, clipsTotal: 0,
      error: null, errorHint: null, output: null, outputDir: root, queuedAt: date, startedAt: i < 2 ? date : null, finishedAt: null
    })))
  }, root)
  await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
  const previous = page.getByRole('region', { name: 'Previous jobs', exact: true })
  const active = page.getByRole('region', { name: 'Active jobs', exact: true })
  const nav = page.getByRole('navigation', { name: 'Previous jobs pages' })
  const list = number => previous.getByRole('list', { name: `Previous jobs, page ${number}`, exact: true })
  await list(1).waitFor()
  assert.equal(await list(1).locator(':scope > li').count(), 10)
  assert.equal(await active.locator('li').count(), 12)
  assert.equal(await nav.getByRole('button', { name: 'Previous page', exact: true }).isDisabled(), true)
  assert.equal(await nav.getByRole('status').innerText(), '1–10 of 23')

  await nav.getByRole('button', { name: 'Next page', exact: true }).focus()
  await page.keyboard.press('Enter')
  await list(2).waitFor()
  assert.equal(await list(2).locator(':scope > li').count(), 10)
  await list(2).getByText('Saved video 11', { exact: true }).waitFor()
  assert.equal(await nav.getByRole('button', { name: 'Next page', exact: true }).evaluate(el => el === document.activeElement), true)
  assert.equal(await nav.getByRole('button', { name: 'Page 2', exact: true }).getAttribute('aria-current'), 'page')
  assert.equal(await list(2).evaluate(el => getComputedStyle(el).animationName), 'history-page-enter')
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await previous.screenshot({ path: path.join(shots, 'jobs-pagination.png'), animations: 'disabled' })
  }

  await nav.getByRole('button', { name: 'Page 3', exact: true }).click()
  await list(3).waitFor()
  assert.equal(await list(3).locator(':scope > li').count(), 3)
  assert.equal(await nav.getByRole('status').innerText(), '21–23 of 23')
  assert.equal(await nav.getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true)
  assert.equal(await active.locator('li').count(), 12)

  // A refresh shrinking history clamps to the last valid page and stays there
  // if later history grows again.
  await app.evaluate(() => { globalThis.paginationTest.original = globalThis.paginationTest.history; globalThis.paginationTest.history = globalThis.paginationTest.history.slice(0, 12) })
  await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click()
  await list(2).waitFor()
  assert.equal(await list(2).locator(':scope > li').count(), 2)
  await app.evaluate(() => { globalThis.paginationTest.history = globalThis.paginationTest.original })
  await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click()
  await nav.getByRole('status').filter({ hasText: '11–20 of 23' }).waitFor()

  await previous.getByRole('button', { name: /^Failed/ }).click()
  await list(1).waitFor()
  assert.equal(await list(1).locator(':scope > li').count(), 5)
  assert.equal(await nav.getByRole('status').innerText(), '1–5 of 5')
  assert.equal(await nav.getByRole('combobox', { name: 'Rows per page' }).isVisible(), true)
  await previous.getByRole('button', { name: /^All/ }).click()
  await nav.getByRole('button', { name: 'Page 2', exact: true }).click()
  await previous.getByRole('textbox', { name: 'Search jobs' }).fill('video 23')
  await list(1).getByText('Saved video 23', { exact: true }).waitFor()
  assert.equal(await list(1).locator(':scope > li').count(), 1)
  await previous.getByRole('textbox', { name: 'Search jobs' }).fill('no matching video')
  await previous.getByText('No jobs match this filter.').waitFor()
  assert.equal(await nav.getByRole('status').innerText(), '0–0 of 0')
  assert.equal(await nav.getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true)
  await previous.getByRole('textbox', { name: 'Search jobs' }).fill('')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await nav.getByRole('button', { name: 'Page 2', exact: true }).click()
  await list(2).waitFor()
  assert.equal(await list(2).evaluate(el => getComputedStyle(el).animationName), 'none')
  assert.equal(await list(2).locator('li').first().evaluate(el => getComputedStyle(el).animationName), 'none')
  await nav.getByRole('button', { name: 'Previous page', exact: true }).click()
  await list(1).waitFor()
  assert.equal(await list(1).getAttribute('data-direction'), 'back')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 700))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  assert.equal(await nav.evaluate(el => el.scrollWidth > el.clientWidth), false)

  // Long histories keep first/last page access without an overflowing control.
  await app.evaluate(() => {
    const fixture = globalThis.paginationTest.history[5]
    globalThis.paginationTest.history.push(...Array.from({ length: 60 }, (_, i) => ({ ...fixture, jobId: `older-${i}`, videoTitle: `Older video ${i + 1}` })))
  })
  await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click()
  await nav.getByRole('button', { name: 'Page 9', exact: true }).click()
  await list(9).waitFor()
  assert.equal(await list(9).locator(':scope > li').count(), 3)
  assert.ok(await nav.getByRole('button').count() <= 9)
  assert.equal(await nav.getByRole('button', { name: 'Page 1', exact: true }).isVisible(), true)
  assert.equal(await nav.evaluate(el => el.scrollWidth > el.clientWidth), false)
  const chooseSize = async size => {
    await nav.getByRole('combobox', { name: 'Rows per page' }).click()
    await page.getByRole('option', { name: `${size} / page`, exact: true }).click()
    await list(1).waitFor()
    assert.equal(await list(1).locator(':scope > li').count(), Math.min(size, 83))
    assert.equal(await active.locator('li').count(), 12)
  }
  await chooseSize(25)
  await nav.getByRole('button', { name: 'Page 4', exact: true }).click()
  await list(4).waitFor()
  assert.equal(await list(4).locator(':scope > li').count(), 8)
  await chooseSize(50)
  await chooseSize(100)
  assert.equal(await nav.getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true)
  await chooseSize(25)
  if (shots) await previous.screenshot({ path: path.join(shots, 'jobs-page-size.png'), animations: 'disabled' })

  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Captions', exact: true }).click()
  await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
  await list(1).waitFor()
  assert.equal(await list(1).locator(':scope > li').count(), 25, 'navigation retains the preference')
  await page.reload()
  await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
  await list(1).waitFor()
  assert.equal(await list(1).locator(':scope > li').count(), 25, 'a new renderer restores the stored preference')
  await previous.getByRole('button', { name: /^Failed/ }).click()
  assert.equal(await nav.getByRole('combobox', { name: 'Rows per page' }).innerText(), '25 / page')
  await previous.getByRole('button', { name: /^All/ }).click()
  await page.evaluate(() => localStorage.setItem('bridgeclip.tables.pageSize', '-7'))
  await page.reload()
  await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
  await list(1).waitFor()
  assert.equal(await list(1).locator(':scope > li').count(), 10, 'invalid stored values fall back to ten')
  assert.deepEqual(errors, [])
})
