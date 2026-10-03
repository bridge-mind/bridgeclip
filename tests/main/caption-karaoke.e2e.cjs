const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('karaoke previews dim unspoken faces like exports and preserve the non-karaoke setting', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-karaoke-'))
  const session = await launchApp({ appDir: process.env.BRIDGECLIP_E2E_APP_DIR || buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'data') })
  t.after(async () => {
    await session.page.evaluate(() => window.bridgeclip.editor.closeReady(true)).catch(() => {})
    await session.close(); fs.rmSync(root, { recursive: true, force: true })
  })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 1080)
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Captions', exact: true }).click()
  await page.getByRole('radiogroup', { name: 'Default styles', exact: true }).getByRole('radio', { name: 'Impact', exact: true }).click()
  await page.getByRole('button', { name: 'Customize', exact: true }).click()
  const choose = async (label, option) => {
    await page.getByRole('combobox', { name: label, exact: true }).click()
    await page.getByRole('option', { name: option, exact: true }).click()
  }
  const preview = page.getByRole('region', { name: 'Caption preview', exact: true })
  const future = preview.locator('[data-caption-state="future"]').first()
  const upcoming = page.getByRole('combobox', { name: 'Upcoming words', exact: true })
  assert.equal(await upcoming.innerText(), 'Reveal as spoken')
  assert.equal(await future.evaluate(el => getComputedStyle(el).visibility), 'hidden')
  await choose('Animation', 'Karaoke sweep')
  await page.evaluate(() => document.fonts.ready)
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'caption-karaoke.png'), animations: 'disabled' })
  }
  assert.equal(await future.evaluate(el => getComputedStyle(el).visibility), 'visible')
  assert.equal(await upcoming.isDisabled(), true)
  assert.equal(await upcoming.innerText(), 'Dim')
  const setInput = async (label, value) => {
    await page.getByRole('slider', { name: label, exact: true }).evaluate((el, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
  }
  await setInput('Caption preview position', '220')
  await setInput('Upcoming opacity', '25')
  for (const state of ['future', 'active']) {
    const style = await preview.locator(`[data-caption-state="${state}"]`).first().evaluate(el => {
      const css = getComputedStyle(el)
      return { color: css.color, opacity: css.opacity, visibility: css.visibility, shadow: css.textShadow }
    })
    // ASS uses 25% face alpha for both future words and the unswept active face,
    // while leaving outlines opaque. The active overlay supplies the highlight.
    assert.match(style.color, /^rgba\(255, 255, 255, 0\.25\d*\)$/)
    assert.equal(style.opacity, '1')
    assert.equal(style.visibility, 'visible')
    assert.notEqual(style.shadow, 'none')
  }
  assert.match(await preview.locator('[data-caption-state="active"] > span').evaluate(el => getComputedStyle(el).color), /^rgb\(/)
  await choose('Animation', 'Clean switch')
  assert.equal(await upcoming.isDisabled(), false)
  assert.equal(await upcoming.innerText(), 'Reveal as spoken')
  assert.equal(await future.evaluate(el => getComputedStyle(el).visibility), 'hidden')
  // Show also gives way to karaoke's secondary opacity without losing the choice.
  await choose('Upcoming words', 'Show')
  await choose('Animation', 'Karaoke sweep')
  assert.equal(await upcoming.innerText(), 'Dim')
  await choose('Animation', 'Clean switch')
  assert.equal(await upcoming.innerText(), 'Show')
  assert.equal(await future.evaluate(el => getComputedStyle(el).visibility), 'visible')
  await page.getByRole('button', { name: 'Save preset', exact: true }).click()
  await page.getByText('All changes saved', { exact: true }).waitFor()
})
