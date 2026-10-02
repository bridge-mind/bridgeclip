const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { loadMain } = require('../zernio/support/load-main.cjs')
const { CAPTION_DEMO_WORDS: words, CAPTION_DEMO_DURATION_MS: duration } = loadMain("export { CAPTION_DEMO_WORDS, CAPTION_DEMO_DURATION_MS } from './src/renderer/lib/caption-demo'")
const midpoint = word => Math.round((word.start + word.end) / 20) * 10

test('caption preview follows its audio clock, retains sound preference and stops when unavailable', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-caption-preview-'))
  const appDir = buildApp(path.join(root, 'app'))
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  // Keep the isolated test window hidden while allowing real media/animation ticks.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  await page.evaluate(() => {
    globalThis.captionTestHidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => globalThis.captionTestHidden })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => globalThis.captionTestHidden ? 'hidden' : 'visible' })
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByPlaceholder('YouTube, Twitch VOD or direct video link').fill('https://example.com/video.mp4')
  await page.getByRole('button', { name: 'Use link', exact: true }).click()
  await page.getByRole('radio', { name: 'Automatic', exact: true }).click()
  const steps = page.getByRole('navigation', { name: 'Create steps' })
  await steps.getByRole('button', { name: /Captions/ }).click()
  const preview = page.getByRole('region', { name: 'Caption preview' })
  const slider = preview.getByRole('slider', { name: 'Caption preview position' })
  const audio = preview.locator('audio')
  const presets = page.getByRole('radiogroup', { name: 'Caption style' })
  const active = () => preview.locator('[data-caption-state="active"]').evaluate(el => el.firstChild.textContent)
  const seek = async ms => {
    await slider.evaluate((input, ms) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(ms))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, ms)
    await page.waitForFunction(ms => {
      const region = document.querySelector('[aria-label="Caption preview"]')
      const media = region?.querySelector('audio'), input = region?.querySelector('input[type="range"]')
      return media?.paused && Math.abs(media.currentTime * 1000 - ms) < 25 && Math.abs(Number(input?.value) - ms) < 25
    }, ms)
  }
  const clockMatches = async () => {
    const clock = await preview.evaluate(el => ({ media: el.querySelector('audio').currentTime * 1000, slider: Number(el.querySelector('input[type="range"]').value) }))
    assert.ok(Math.abs(clock.media - clock.slider) < 100, `caption position ${clock.slider} follows audio ${clock.media}`)
  }

  await preview.getByRole('button', { name: 'Pause caption preview', exact: true }).waitFor()
  await page.waitForFunction(() => {
    const media = document.querySelector('[aria-label="Caption preview"] audio')
    return media?.readyState >= 2 && media.currentTime > .1
  })
  assert.equal(await audio.evaluate(el => el.muted), true, 'autoplay is silent')
  assert.equal(await preview.getByRole('button', { name: 'Enable preview audio', exact: true }).getAttribute('aria-pressed'), 'false')
  assert.ok(Math.abs(await audio.evaluate(el => el.duration * 1000) - duration) < 100, 'the bundled audio matches the demo timeline')
  await clockMatches()
  await preview.getByRole('button', { name: 'Pause caption preview', exact: true }).click()
  const paused = await audio.evaluate(el => el.currentTime)
  await page.waitForTimeout(150)
  assert.equal(await audio.evaluate(el => el.currentTime), paused)
  await clockMatches()

  // A user can enable sound while paused; the choice survives preset remounts.
  await preview.getByRole('button', { name: 'Enable preview audio', exact: true }).click()
  assert.equal(await audio.evaluate(el => el.muted), false)
  assert.equal(await preview.getByRole('button', { name: 'Mute preview audio', exact: true }).getAttribute('aria-pressed'), 'true')
  const oldAudio = await audio.elementHandle()
  await presets.getByRole('radio', { name: 'Spotlight', exact: true }).click()
  await preview.getByText('Spotlight preview', { exact: true }).waitFor()
  assert.equal(await audio.evaluate(el => el.muted), false)
  assert.equal(await oldAudio.evaluate(el => el.paused), true, 'the previous preset audio stops on remount')
  await oldAudio.dispose()
  await preview.getByRole('button', { name: 'Mute preview audio', exact: true }).click()
  assert.equal(await audio.evaluate(el => el.muted), true)

  for (const name of ['Pop', 'Spotlight', 'Impact', 'Glow', 'Boxed', 'Sweep', 'Editorial', 'Hype', 'Punch', 'Neon', 'Headline', 'Paper', 'Subtle']) {
    await presets.getByRole('radio', { name, exact: true }).click()
    await preview.getByText(`${name} preview`, { exact: true }).waitFor()
    await seek(midpoint(words[1]))
    assert.equal((await active()).toLowerCase(), words[1].text.toLowerCase(), `${name} follows the second spoken word`)
    assert.equal(await audio.evaluate(el => el.muted), true, 'mute preference survives remounts')
    const visibleWords = preview.locator('[data-caption-state]')
    if (name === 'Punch') assert.equal(await visibleWords.count(), 1)
    if (name === 'Impact') {
      assert.equal(await visibleWords.count(), 2)
      await seek(midpoint(words[2]))
      assert.equal((await active()).toLowerCase(), words[2].text.toLowerCase())
      assert.equal(await preview.locator('[data-caption-state="future"]').evaluate(el => getComputedStyle(el).visibility), 'hidden')
    }
    if (name === 'Editorial' || name === 'Subtle') assert.ok(Number(await preview.locator('[data-caption-state="future"]').first().evaluate(el => getComputedStyle(el).opacity)) < 1)
    if (name === 'Spotlight' || name === 'Headline') {
      assert.notEqual(await preview.locator('[data-caption-state="active"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
      assert.equal(await preview.locator('[data-caption-state="past"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)')
    }
    if (name === 'Sweep') {
      const fill = preview.locator('[data-caption-state="active"] > span')
      const sweep = await fill.evaluate(el => Number(el.style.clipPath.match(/([\d.]+)%/)[1]))
      const expected = (1 - (midpoint(words[1]) - words[1].start) / (words[1].end - words[1].start)) * 100
      assert.ok(Math.abs(sweep - expected) < 1, 'karaoke fill follows the spoken word timestamps')
      await seek(words[1].start + (words[1].end - words[1].start) * .75)
      assert.ok(await fill.evaluate(el => Number(el.style.clipPath.match(/([\d.]+)%/)[1])) < sweep)
    }
  }

  // Native keyboard scrubbing seeks the same media clock and pauses playback.
  await slider.press('Home')
  await slider.press('ArrowRight')
  assert.equal(await audio.evaluate(el => el.paused), true)
  await clockMatches()
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await presets.getByRole('radio', { name: 'Spotlight', exact: true }).click()
    await seek(midpoint(words[1]))
    await page.screenshot({ path: path.join(shots, 'caption-preview.png') })
  }
  await slider.press('End')
  await clockMatches()
  await preview.getByRole('button', { name: 'Replay caption preview', exact: true }).click()
  await page.waitForFunction(() => {
    const media = document.querySelector('[aria-label="Caption preview"] audio')
    return media && !media.paused && media.currentTime < .6
  })
  await clockMatches()

  await page.getByRole('switch', { name: 'Captions', exact: true }).click()
  assert.equal(await slider.isDisabled(), true)
  assert.equal(await audio.evaluate(el => el.paused), true)
  const disabled = await audio.evaluate(el => el.currentTime)
  await page.waitForTimeout(150)
  assert.equal(await audio.evaluate(el => el.currentTime), disabled)
  await page.getByRole('switch', { name: 'Captions', exact: true }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).waitFor()
  await presets.getByRole('radio', { name: 'Pop', exact: true }).click()
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).waitFor()
  assert.equal(await audio.evaluate(el => el.paused), true)
  assert.equal(await slider.inputValue(), '0')
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="Caption preview"] audio')?.currentTime > .15)
  await clockMatches()

  // Hiding or leaving the preview must not leave audio playing in the background.
  await page.evaluate(() => { globalThis.captionTestHidden = true; document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(await audio.evaluate(el => el.paused), true)
  const hiddenAt = await audio.evaluate(el => el.currentTime)
  await page.waitForTimeout(150)
  assert.equal(await audio.evaluate(el => el.currentTime), hiddenAt)
  await page.evaluate(() => { globalThis.captionTestHidden = false; document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForFunction(() => !document.querySelector('[aria-label="Caption preview"] audio')?.paused)
  const leavingAudio = await audio.elementHandle()
  await steps.getByRole('button', { name: /Review/ }).click()
  assert.equal(await preview.count(), 0)
  assert.equal(await leavingAudio.evaluate(el => el.paused), true)
  await leavingAudio.dispose()
  await steps.getByRole('button', { name: /Captions/ }).click()
  assert.equal(await audio.evaluate(el => el.muted), true, 'sound preference survives leaving the caption step')
  assert.equal(await audio.evaluate(el => el.paused), true, 'reduced motion also suppresses autoplay on reentry')
  assert.deepEqual(errors, [])
})
