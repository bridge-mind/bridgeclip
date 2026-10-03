const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { loadMain } = require('../zernio/support/load-main.cjs')
const { defaultCaptionStyle } = loadMain("export { defaultCaptionStyle } from './src/shared/custom-captions'")

test('browse custom captions in a consistent preview and animate bookmarks without remounting cards', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-caption-browsing-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page, app } = session
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1560, 1040)
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
  })
  await page.evaluate(async presets => { for (const preset of presets) await window.bridgeclip.captions.save(preset) }, [
    { id: 'custom-mint', name: 'Studio Mint', baseId: 'pop', style: { ...defaultCaptionStyle('pop'), highlight_color: '#00DDAA', max_lines: 2 } },
    { id: 'custom-paper', name: 'Soft Paper', baseId: 'paper', style: defaultCaptionStyle('paper') }
  ])
  await page.reload()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Captions', exact: true }).click()
  const table = page.getByRole('table', { name: 'Your caption presets', exact: true })
  const defaults = page.getByRole('radiogroup', { name: 'Default caption presets', exact: true })
  const preview = page.locator('.caption-lab-preview')
  const settled = () => page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-reorder-key]')).some(el => el.getAnimations().some(a => a.playState === 'running')))
  const shot = async name => {
    if (!process.env.BRIDGECLIP_E2E_SHOTS) return
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, name) })
  }
  await table.waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.locator('.caption-lab').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
  const bounds = () => preview.locator('.caption-preview-stage').boundingBox()
  const initial = await bounds()
  const sameFrame = async () => {
    const next = await bounds()
    for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(next[axis] - initial[axis]) < 1, `preview ${axis} stays fixed: ${initial[axis]} → ${next[axis]}`)
  }
  await table.getByRole('button', { name: 'Preview Studio Mint', exact: true }).click()
  await preview.getByRole('heading', { name: 'Studio Mint', exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Style name', exact: true }).count(), 0, 'previewing does not open an edit')
  assert.equal(await table.getByRole('button', { name: 'Preview Studio Mint', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await preview.locator('audio').evaluate(audio => audio.paused), true)
  assert.equal(await preview.locator('[data-caption-state="active"]').evaluate(el => getComputedStyle(el).color), 'rgb(0, 221, 170)', 'custom appearance reaches the main preview')
  assert.equal(await defaults.locator('[aria-checked="true"]').count(), 0)
  await sameFrame()
  await shot('captions-custom-preview.png')
  await preview.getByRole('button', { name: 'Edit preset', exact: true }).click()
  await page.getByRole('textbox', { name: 'Style name', exact: true }).waitFor()
  await sameFrame()
  await shot('captions-consistent-edit.png')
  await page.getByRole('button', { name: 'Back to presets', exact: true }).click()
  await sameFrame()
  await preview.getByRole('heading', { name: 'Studio Mint', exact: true }).waitFor()

  // The bookmark and tile travel together during the hover lift.
  await page.mouse.move(0, 0)
  const paper = defaults.locator('[data-reorder-key="paper"]')
  const geometry = () => paper.evaluate(el => {
    const card = el.querySelector('[role="radio"]').getBoundingClientRect()
    const bookmark = el.querySelector('.caption-bookmark').getBoundingClientRect()
    return { card: card.y, bookmark: bookmark.y, relative: bookmark.y - card.y }
  })
  const beforeHover = await geometry()
  await paper.getByRole('radio').hover()
  await page.waitForTimeout(240)
  const hovered = await geometry()
  assert.ok(hovered.card < beforeHover.card - 1)
  assert.ok(Math.abs(hovered.relative - beforeHover.relative) < .5, 'bookmark follows the card lift')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(240)
  await page.evaluate(() => { window.captionNodes = Array.from(document.querySelectorAll('[data-reorder-key]')) })
  const stableNodes = async () => assert.equal(await page.evaluate(() => window.captionNodes.every(node => node.isConnected)), true, 'bookmark moves preserve the existing card and row nodes')
  await paper.getByRole('button', { name: 'Bookmark Paper', exact: true }).focus()
  const recording = process.env.BRIDGECLIP_E2E_SHOTS ? path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'caption-motion') : null
  const frames = []
  const frame = async () => {
    const file = path.join(recording, `${String(frames.length).padStart(3, '0')}.png`)
    frames.push({ file, time: Date.now() })
    await page.screenshot({ path: file, scale: 'css' })
  }
  if (recording) { fs.mkdirSync(recording, { recursive: true }); await frame() }
  await page.keyboard.press('Enter')
  assert.equal(await defaults.getByRole('radio').first().getAttribute('aria-label'), 'Paper')
  assert.ok(await paper.evaluate(el => el.getAnimations().length > 0), 'bookmark moves animate')
  if (recording) {
    for (let i = 0; i < 8; i++) { await frame(); await page.waitForTimeout(40) }
    fs.writeFileSync(path.join(recording, 'frames.json'), JSON.stringify(frames))
  }
  await settled(); await stableNodes()
  assert.equal(await paper.getByRole('button').evaluate(el => el === document.activeElement), true, 'keyboard focus travels with the card')
  await preview.getByRole('heading', { name: 'Studio Mint', exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Favorites', exact: true }).count(), 0, 'favorites remain in their original group')
  assert.equal(await preview.getByText('The all-rounder', { exact: true }).count(), 0)

  const lastRow = table.locator('tbody tr').last()
  const lastName = await lastRow.getAttribute('aria-label')
  await lastRow.getByRole('button', { name: `Bookmark ${lastName}`, exact: true }).click()
  assert.equal(await table.locator('tbody tr').first().getAttribute('aria-label'), lastName)
  assert.ok(await table.locator('tbody tr').evaluateAll(rows => rows.some(row => row.getAnimations().length > 0)))
  await settled(); await stableNodes()
  await shot('captions-bookmarks.png')
  // Rapid changes settle in the right order and honor reduced motion immediately.
  await defaults.getByRole('button', { name: 'Bookmark Glow', exact: true }).evaluate(el => el.click())
  await defaults.getByRole('button', { name: 'Remove bookmark from Glow', exact: true }).evaluate(el => el.click())
  await settled(); await stableNodes()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await paper.getByRole('button', { name: 'Remove bookmark from Paper', exact: true }).click()
  assert.equal(await defaults.getByRole('radio').first().getAttribute('aria-label'), 'Pop')
  assert.equal(await paper.evaluate(el => el.getAnimations().length), 0)
  await defaults.getByRole('radio', { name: 'Pop', exact: true }).click()
  await preview.getByRole('heading', { name: 'Pop', exact: true }).waitFor()
  assert.equal(await preview.getByText('The all-rounder', { exact: true }).count(), 0)
  await sameFrame()

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  await table.getByRole('button', { name: 'Preview Studio Mint', exact: true }).click()
  await shot('captions-browse-compact.png')
  await preview.getByRole('button', { name: 'Edit preset', exact: true }).click()
  await page.getByRole('textbox', { name: 'Style name', exact: true }).fill('Studio Mint edited')
  await shot('captions-edit-compact.png')
  await page.getByRole('button', { name: 'Back to presets', exact: true }).click()
  await page.getByRole('dialog', { name: 'Save changes before leaving?', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click()
  await preview.getByRole('heading', { name: 'Studio Mint', exact: true }).waitFor()
  assert.deepEqual(errors, [])
})
