const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { loadMain } = require('../zernio/support/load-main.cjs')
const { CAPTION_DEMO_WORDS, CAPTION_LONG_DEMO_WORDS } = loadMain("export { CAPTION_DEMO_WORDS, CAPTION_LONG_DEMO_WORDS } from './src/renderer/lib/caption-demo'")

test('caption presets start with a base wizard, open a saved library table, and retain faithful snapshots', { timeout: 150000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-captions-lab-'))
  const appDir = buildApp(path.join(root, 'app'))
  const userDataDir = path.join(root, 'user-data')
  let session = await launchApp({ appDir, userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ ipcMain, BrowserWindow }, root) => {
    BrowserWindow.getAllWindows()[0].setSize(1560, 1000)
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    ipcMain.removeHandler('settings:load')
    ipcMain.handle('settings:load', () => ({ openrouterConfigured: true, zernioConfigured: false, outputDirectory: root, pythonPath: '', customVocabulary: '' }))
    ipcMain.removeHandler('system:checkTools')
    ipcMain.handle('system:checkTools', () => ({ python: true, pythonDeps: true, ffmpeg: true, ffmpegCaptions: true, ffprobe: true, ytdlp: true, engine: true, bridgeRunner: true }))
    ipcMain.removeHandler('job:start')
    ipcMain.handle('job:start', (_event, request) => { globalThis.captionRequest = request; return { jobId: 'caption-lab-test', queued: false } })
  }, root)
  await page.reload()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByPlaceholder('YouTube, Twitch VOD or direct video link').fill('https://example.com/captions.mp4')
  await page.getByRole('button', { name: 'Use link', exact: true }).click()
  await page.getByRole('radio', { name: 'Automatic', exact: true }).click()
  const steps = page.getByRole('navigation', { name: 'Create steps' })
  await steps.getByRole('button', { name: /Captions/ }).click()
  await page.getByRole('button', { name: 'Open captions lab', exact: true }).click()
  await page.getByRole('heading', { name: 'Choose a base', exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Style name', exact: true }).count(), 0, 'empty library starts before editing')
  assert.equal(await page.getByRole('table').count(), 0)
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  const screenshot = async name => {
    if (!shots) return
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, name) })
  }
  await screenshot('captions-base-wide.png')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  await screenshot('captions-base-compact.png')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1000))
  const defaults = page.getByRole('radiogroup', { name: 'Default styles', exact: true })
  await defaults.getByRole('radio', { name: 'Pop', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await defaults.getByRole('radio', { name: 'Spotlight', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await defaults.locator('[tabindex="0"]').count(), 1)
  await page.keyboard.press('Home')
  await page.getByRole('button', { name: 'Customize', exact: true }).last().click()
  await page.getByRole('heading', { name: 'Customize preset', exact: true }).waitFor()
  assert.equal(await defaults.count(), 0, 'base tiles leave the screen while customizing')
  await page.getByRole('textbox', { name: 'Style name', exact: true }).fill('Studio Mint')
  const choose = async (name, value) => {
    await page.getByRole('combobox', { name, exact: true }).click()
    await page.getByRole('option', { name: value, exact: true }).click()
  }
  const setInput = async (name, value) => {
    await page.getByLabel(name, { exact: true }).evaluate(async (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      // Let React commit before the next control reads the editing snapshot.
      await new Promise(resolve => requestAnimationFrame(resolve))
    }, value)
  }
  await choose('Typeface', 'Poppins ExtraBold')
  await choose('Animation', 'Karaoke sweep')
  await setInput('Font size', '100')
  await setInput('Words at once', '4')
  await setInput('Text color', '#eeffdd')
  await setInput('Highlight color', '#00ddaa')
  await setInput('Outline color', '#112233')
  await page.getByRole('switch', { name: 'Background', exact: true }).click()
  await setInput('Background opacity', '75')
  await setInput('Background padding', '35')
  assert.equal(await page.getByRole('switch', { name: 'Word pill', exact: true }).isDisabled(), true)
  const preview = page.getByRole('region', { name: 'Caption preview', exact: true })
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).waitFor()
  const sampleWord = CAPTION_DEMO_WORDS[2]
  const sampleTime = Math.round((sampleWord.start + sampleWord.end) / 20) * 10

  // A portrait-width preview must wrap the same timed word group as export,
  // rather than replacing it after one visual line. Exercise actual geometry.
  const demoAudio = await preview.locator('audio').elementHandle()
  const muted = await demoAudio.evaluate(audio => audio.muted)
  const seekWord = async index => {
    const word = CAPTION_DEMO_WORDS[index]
    const ms = Math.round((word.start + word.end) / 20) * 10
    await setInput('Caption preview position', String(ms))
    await page.waitForFunction(ms => {
      const audio = document.querySelector('[aria-label="Caption preview"] audio')
      return audio.paused && Math.abs(audio.currentTime * 1000 - ms) < 25
    }, ms)
    assert.equal(await preview.locator('[data-caption-state="active"]').evaluate(el => el.firstChild.textContent), word.text)
    return ms
  }
  const lineGeometry = async () => {
    // Native range events update inline styles before Chromium necessarily
    // commits the new font metrics; inspect layout only after they agree.
    await page.waitForFunction(() => {
      const frame = document.querySelector('[aria-label="Caption preview"] .caption-preview-stage')?.firstElementChild
      if (!frame) return false
      const style = getComputedStyle(frame)
      return Math.abs(parseFloat(style.fontSize) - parseFloat(frame.style.fontSize)) < .05 &&
        Math.abs(parseFloat(style.lineHeight) - parseFloat(frame.style.lineHeight)) < .05 &&
        [...frame.querySelectorAll('[data-caption-state]')].every(word => {
          const wordStyle = getComputedStyle(word)
          return Math.abs(parseFloat(wordStyle.fontSize) - parseFloat(style.fontSize)) < .05 &&
            Math.abs(parseFloat(wordStyle.lineHeight) - parseFloat(style.lineHeight)) < .05
        })
    })
    return preview.evaluate(region => {
    const stageElement = region.querySelector('.caption-preview-stage')
    const stage = stageElement.getBoundingClientRect()
    const frame = stageElement.firstElementChild
    const frameRect = frame.getBoundingClientRect()
    const frameStyle = getComputedStyle(frame)
    const boxes = [...region.querySelectorAll('[data-caption-state]')].map(el => {
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el), parentStyle = getComputedStyle(el.parentElement)
      return { text: el.firstChild.textContent, top: box.top, left: box.left, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height, active: el.dataset.captionState === 'active', fontSize: style.fontSize,
        parentFont: parentStyle.font, parentWidth: el.parentElement.getBoundingClientRect().width }
    })
    const rows = []
    for (const box of boxes) if (!rows.some(top => Math.abs(top - box.top) < 2)) rows.push(box.top)
    return { rows: rows.sort((a, b) => a - b), activeTop: boxes.find(box => box.active)?.top,
      fontSizeControl: document.querySelector('input[aria-label="Font size"]').value,
      wordsPerLineControl: document.querySelector('input[aria-label="Words at once"]').value,
      frame: { width: frameRect.width, height: frameRect.height, font: frameStyle.font, fontSize: frameStyle.fontSize,
        lineHeight: frameStyle.lineHeight, inlineStyle: frame.getAttribute('style') },
      stage: { width: stage.width, height: stage.height, left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom }, boxes,
      count: boxes.length, fits: boxes.every(box => box.left >= stage.left - 1 && box.right <= stage.right + 1 && box.top >= stage.top - 1 && box.bottom <= stage.bottom + 1) }
    })
  }
  await setInput('Font size', '120')
  await setInput('Words at once', '6')
  await seekWord(0)
  const firstLine = await lineGeometry()
  await screenshot('captions-wrapping-large.png')
  assert.equal(firstLine.count, 6)
  assert.equal(firstLine.rows.length, 2, `large six-word captions must wrap to two lines: ${JSON.stringify(firstLine)}`)
  assert.equal(firstLine.fits, true, 'wrapped captions stay inside the preview')
  assert.ok(Math.abs(firstLine.activeTop - firstLine.rows[0]) < 2)
  const lastWordTime = await seekWord(5)
  const lastLine = await lineGeometry()
  assert.equal(lastLine.count, 6, 'speaking the second line retains the whole timed group')
  assert.ok(lastLine.activeTop > firstLine.activeTop + 2, 'the highlight advances into the next visual line')
  assert.equal(lastLine.fits, true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  const compactLines = await lineGeometry()
  await screenshot('captions-wrapping-compact.png')
  assert.equal(compactLines.rows.length, 2, `compact captions keep two lines: ${JSON.stringify(compactLines)}`)
  assert.equal(compactLines.fits, true, `compact captions stay inside the preview: ${JSON.stringify(compactLines)}`)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1000))
  await page.waitForFunction(() => window.innerWidth === 1560)
  await setInput('Font size', '40')
  const smallType = await lineGeometry()
  await screenshot('captions-wrapping-small.png')
  assert.equal(smallType.rows.length, 1, `the same six words fit on one line at a smaller font size: ${JSON.stringify(smallType)}`)
  assert.equal(smallType.fits, true)
  assert.equal(await demoAudio.evaluate(audio => audio === document.querySelector('[aria-label="Caption preview"] audio')), true, 'typography changes retain the media element')
  assert.equal(await demoAudio.evaluate(audio => audio.paused), true)
  assert.equal(await demoAudio.evaluate(audio => audio.muted), muted)
  assert.ok(Math.abs(await demoAudio.evaluate(audio => audio.currentTime * 1000) - lastWordTime) < 25, 'reflow preserves the paused audio position')

  // A line limit splits timed groups earlier; it must never shrink the type
  // or drop a spoken word to meet the selected number of visual rows.
  await setInput('Font size', '160')
  await seekWord(0)
  const uncapped = await lineGeometry()
  const fontRatio = parseFloat(uncapped.frame.fontSize) / uncapped.frame.width
  assert.equal(uncapped.rows.length, 3, 'Auto keeps the natural three-line wrap for large type')
  for (const cap of [1, 2, 3]) {
    await choose('Lines', `${cap} ${cap === 1 ? 'line' : 'lines'}`)
    let mostRows = 0
    for (let index = 0; index < CAPTION_DEMO_WORDS.length; index++) {
      const ms = await seekWord(index)
      const geometry = await lineGeometry()
      mostRows = Math.max(mostRows, geometry.rows.length)
      assert.ok(geometry.rows.length <= cap, `${cap}-line limit at word ${index}: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.count > 0 && geometry.count <= 6, 'line limits preserve the words-at-once ceiling')
      assert.equal(geometry.fits, true, `${cap}-line captions remain inside the preview`)
      assert.equal(geometry.fontSizeControl, '160')
      assert.ok(Math.abs(parseFloat(geometry.frame.fontSize) / geometry.frame.width - fontRatio) < .0001, 'line limits preserve the selected font scale')
      assert.equal(await demoAudio.evaluate(audio => audio === document.querySelector('[aria-label="Caption preview"] audio')), true)
      assert.equal(await demoAudio.evaluate(audio => audio.paused), true)
      assert.equal(await demoAudio.evaluate(audio => audio.muted), muted)
      assert.ok(Math.abs(await demoAudio.evaluate(audio => audio.currentTime * 1000) - ms) < 25)
      if (index === 0) await screenshot(`captions-line-limit-${cap}.png`)
    }
    assert.equal(mostRows, cap, `the demo exercises the ${cap}-line layout`)
  }

  // Numeric Lines is an explicit layout choice even when small type could
  // fit the entire group on one line. Exercise the normal three-word setting.
  await setInput('Font size', '76')
  await setInput('Words at once', '3')
  await choose('Lines', 'Auto')
  await seekWord(0)
  const natural = await lineGeometry()
  const normalFontRatio = parseFloat(natural.frame.fontSize) / natural.frame.width
  assert.equal(natural.rows.length, 1, 'Auto leaves a fitting three-word group on one line')
  for (const lines of [2, 3, 1]) {
    await choose('Lines', `${lines} ${lines === 1 ? 'line' : 'lines'}`)
    for (let index = 0; index < CAPTION_DEMO_WORDS.length; index++) {
      const ms = await seekWord(index)
      const geometry = await lineGeometry()
      const groupStart = Math.floor(index / 3) * 3
      assert.equal(geometry.count, 3, 'line selection retains the three-word timed group')
      assert.deepEqual(geometry.boxes.map(box => box.text), CAPTION_DEMO_WORDS.slice(groupStart, groupStart + 3).map(word => word.text))
      assert.equal(geometry.rows.length, lines, `${lines} selected lines at word ${index}: ${JSON.stringify(geometry)}`)
      assert.equal(geometry.fits, true, 'balanced lines stay inside the preview')
      assert.equal(geometry.fontSizeControl, '76')
      assert.ok(Math.abs(parseFloat(geometry.frame.fontSize) / geometry.frame.width - normalFontRatio) < .0001, 'explicit lines retain the chosen font scale')
      assert.equal(await demoAudio.evaluate(audio => audio === document.querySelector('[aria-label="Caption preview"] audio')), true)
      assert.equal(await demoAudio.evaluate(audio => audio.paused), true)
      assert.equal(await demoAudio.evaluate(audio => audio.muted), muted)
      assert.ok(Math.abs(await demoAudio.evaluate(audio => audio.currentTime * 1000) - ms) < 25)
      if (index === 0) await screenshot(`captions-lines-realistic-${lines}.png`)
    }
  }
  // Both recordings share the media clock; line shortcuts and live reflow
  // must continue working after switching to the longer conversation.
  const samples = page.getByRole('radiogroup', { name: 'Preview sample', exact: true })
  const transcript = page.getByRole('group', { name: 'Caption lines', exact: true })
  await samples.getByRole('radio', { name: 'Short', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await samples.getByRole('radio', { name: 'Long', exact: true }).getAttribute('aria-checked'), 'true')
  await page.waitForFunction(() => {
    const audio = document.querySelector('[aria-label="Caption preview"] audio')
    return audio.duration > 8 && audio.currentTime === 0 && audio.paused
  })
  assert.equal(await preview.locator('audio').count(), 1)
  assert.equal(await demoAudio.evaluate(audio => audio.muted), muted)
  assert.equal((await transcript.locator('button > span:last-child').allTextContents()).join(' '), 'This is an example of longer text. With this example, you should be able to see how captions behave in a longer conversation.')
  await setInput('Words at once', '5')
  await choose('Lines', '2 lines')
  assert.equal(await transcript.getByRole('button').count(), 6, 'the transcript respects grouping and sentence breaks')
  await transcript.getByRole('button').last().click()
  await page.waitForFunction(ms => {
    const audio = document.querySelector('[aria-label="Caption preview"] audio')
    return audio.paused && Math.abs(audio.currentTime * 1000 - ms) < 25
  }, CAPTION_LONG_DEMO_WORDS[20].start)
  assert.equal(await transcript.getByRole('button').last().getAttribute('aria-current'), 'true')
  for (const word of CAPTION_LONG_DEMO_WORDS) {
    const ms = Math.round((word.start + word.end) / 20) * 10
    await setInput('Caption preview position', String(ms))
    await page.waitForFunction(text => document.querySelector('[data-caption-state="active"]')?.firstChild.textContent === text, word.text)
    const geometry = await lineGeometry()
    assert.equal(geometry.rows.length, 2)
    assert.equal(geometry.fits, true)
  }
  await screenshot('captions-long-wide.png')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  assert.equal((await lineGeometry()).fits, true)
  await screenshot('captions-long-compact.png')
  await preview.getByRole('button', { name: 'Enable preview audio', exact: true }).click()
  await preview.getByRole('button', { name: 'Play caption preview', exact: true }).click()
  await page.waitForFunction(() => {
    const audio = document.querySelector('[aria-label="Caption preview"] audio')
    return !audio.paused && !audio.muted
  })
  await samples.getByRole('radio', { name: 'Short', exact: true }).click()
  await page.waitForFunction(() => {
    const audio = document.querySelector('[aria-label="Caption preview"] audio')
    return audio.duration < 3 && audio.currentTime < 3 && !audio.paused && !audio.muted
  })
  await preview.getByRole('button', { name: 'Pause caption preview', exact: true }).click()
  await preview.getByRole('button', { name: 'Mute preview audio', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1000))
  await demoAudio.dispose()
  await setInput('Font size', '100')
  await setInput('Words at once', '4')
  await choose('Lines', '2 lines')

  await setInput('Caption preview position', String(sampleTime))
  await page.waitForFunction(ms => Math.abs(document.querySelector('[aria-label="Caption preview"] audio').currentTime * 1000 - ms) < 25, sampleTime)
  const active = preview.locator('[data-caption-state="active"]')
  const appearance = await active.evaluate(el => {
    const style = getComputedStyle(el)
    const line = el.closest('[data-caption-line]')
    const plate = line ? line.parentElement : el.parentElement
    return { font: style.fontFamily, weight: style.fontWeight, color: style.color, shadow: style.textShadow,
      plate: getComputedStyle(plate).backgroundColor, plateInline: plate.getAttribute('style'), sweep: el.firstElementChild.style.clipPath,
      highlight: getComputedStyle(el.firstElementChild).color }
  })
  assert.match(appearance.font, /Poppins/)
  assert.equal(appearance.weight, '800')
  assert.equal(appearance.color, 'rgb(238, 255, 221)')
  assert.equal(appearance.highlight, 'rgb(0, 221, 170)')
  assert.match(appearance.shadow, /rgb\(17, 34, 51\)/)
  assert.equal(appearance.plate, 'rgba(0, 0, 0, 0.75)', JSON.stringify(appearance))
  const sweepPercent = Number(appearance.sweep.match(/([\d.]+)%/)[1])
  const expectedSweep = (1 - (sampleTime - sampleWord.start) / (sampleWord.end - sampleWord.start)) * 100
  assert.ok(Math.abs(sweepPercent - expectedSweep) < 1, 'custom karaoke follows the bundled audio timing')
  assert.equal(await preview.locator('[data-caption-state]').count(), 4)

  // Leaving asks first; cancelling preserves the exact editing state.
  const discard = page.getByRole('dialog', { name: 'Save changes before leaving?', exact: true })
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click()
  assert.equal(await page.getByRole('textbox', { name: 'Style name', exact: true }).inputValue(), 'Studio Mint')
  await page.getByRole('button', { name: 'Back to Create', exact: true }).click()
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await page.getByRole('button', { name: 'Back to base', exact: true }).click()
  await defaults.getByRole('radio', { name: 'Paper', exact: true }).click()
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).waitFor()
  assert.equal(await discard.getByRole('button', { name: 'Keep editing' }).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Escape')
  assert.equal(await discard.count(), 0)
  await page.getByRole('button', { name: 'Customize', exact: true }).last().click()
  assert.equal(await page.getByRole('textbox', { name: 'Style name', exact: true }).inputValue(), 'Studio Mint')
  await screenshot('captions-lab-wide.png')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.waitForFunction(() => window.innerWidth === 720)
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  if (shots) {
    await page.screenshot({ path: path.join(shots, 'captions-lab-compact.png') })
    await page.getByRole('textbox', { name: 'Style name', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(shots, 'captions-lab-controls-compact.png') })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1000))
  await page.getByRole('button', { name: 'Save & use', exact: true }).click()
  const mine = page.getByRole('radiogroup', { name: 'Your caption styles', exact: true })
  await mine.getByRole('radio', { name: 'Studio Mint', exact: true }).waitFor()
  assert.equal(await mine.getByRole('radio', { name: 'Studio Mint', exact: true }).getAttribute('aria-checked'), 'true')
  const saved = await page.evaluate(() => window.bridgeclip.captions.list())
  assert.equal(saved.length, 1)
  assert.equal(saved[0].style.line_box_padding, 35)
  assert.equal(saved[0].style.font_size, 100)
  assert.equal(saved[0].style.karaoke_fill, true)
  assert.equal(saved[0].style.max_lines, 2)

  // Saved presets open the table first; a new preset starts from the wizard's selected base.
  await page.getByRole('radiogroup', { name: 'Caption style', exact: true }).getByRole('radio', { name: 'Paper', exact: true }).click()
  await page.getByRole('button', { name: 'Open captions lab', exact: true }).click()
  const table = page.getByRole('table', { name: 'Your caption presets', exact: true })
  assert.equal(await table.getByRole('columnheader', { name: 'Base', exact: true }).count(), 0)
  await table.waitFor()
  assert.equal(await defaults.count(), 0)
  assert.equal(await page.getByRole('textbox', { name: 'Style name', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'New preset', exact: true }).click()
  assert.equal(await defaults.getByRole('radio', { name: 'Paper', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await page.getByRole('textbox', { name: 'Style name', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Back to presets', exact: true }).click()
  await table.getByRole('button', { name: 'Use Studio Mint', exact: true }).click()
  assert.equal(await mine.getByRole('radio', { name: 'Studio Mint', exact: true }).getAttribute('aria-checked'), 'true')

  // Editing the library after selection keeps the wizard's embedded snapshot.
  await page.getByRole('button', { name: 'Open captions lab', exact: true }).click()
  await table.getByRole('button', { name: 'Edit Studio Mint', exact: true }).click()
  await page.getByRole('textbox', { name: 'Style name', exact: true }).fill('Studio Rose')
  await setInput('Highlight color', '#ff66bb')
  await choose('Lines', '3 lines')
  await page.getByRole('button', { name: 'Save preset', exact: true }).click()
  await page.getByText('All changes saved', { exact: true }).waitFor()
  assert.equal(await table.count(), 0, 'saving stays in the editor')
  await page.getByRole('button', { name: 'Back to Create', exact: true }).click()
  assert.equal(await mine.getByRole('radio', { name: 'Studio Mint', exact: true }).getAttribute('aria-checked'), 'true')
  await steps.getByRole('button', { name: /Review/ }).click()
  await page.getByText('Studio Mint', { exact: true }).first().waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, 'captions-review.png') })
  await page.getByRole('button', { name: 'Generate clips', exact: true }).click()
  await page.getByRole('button', { name: 'View job', exact: true }).waitFor()
  const request = await app.evaluate(() => globalThis.captionRequest)
  assert.equal(request.includeCaptions, true)
  assert.equal(request.captionPreset, 'pop')
  assert.equal(request.customCaption.style.max_lines, 2, 'queued jobs keep their selected line limit after library edits')
  assert.deepEqual(request.customCaption, saved[0])

  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Captions', exact: true }).click()
  await table.getByRole('button', { name: 'Duplicate Studio Rose', exact: true }).click()
  await page.getByRole('textbox', { name: 'Style name', exact: true }).fill('Studio Copy')
  await page.getByRole('button', { name: 'Save preset', exact: true }).click()
  await page.getByText('All changes saved', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Back to presets', exact: true }).click()
  assert.equal((await page.evaluate(() => window.bridgeclip.captions.list())).length, 2)
  await table.waitFor()
  await screenshot('captions-table-wide.png')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 800))
  await page.waitForFunction(() => window.innerWidth === 720 && document.documentElement.scrollWidth <= window.innerWidth)
  await screenshot('captions-table-compact.png')
  await table.getByRole('button', { name: 'Delete Studio Copy', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete preset?', exact: true }).getByRole('button', { name: 'Delete preset', exact: true }).click()
  await table.getByRole('button', { name: 'Edit Studio Rose', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.bridgeclip.captions.list())).length, 1)
  assert.deepEqual(errors, [])

  // Relaunch the real isolated main process to prove styles are stored on disk.
  await session.close()
  // This base no longer exists in either default picker; the saved style owns its appearance.
  const libraryPath = path.join(userDataDir, 'caption-styles.json')
  const retiredLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
  retiredLibrary[0].baseId = 'retired-default'
  fs.writeFileSync(libraryPath, JSON.stringify(retiredLibrary))
  session = await launchApp({ appDir, userDataDir })
  await session.page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Captions', exact: true }).click()
  const restoredTable = session.page.getByRole('table', { name: 'Your caption presets', exact: true })
  await restoredTable.waitFor()
  assert.equal(await session.page.getByRole('textbox', { name: 'Style name', exact: true }).count(), 0)
  await restoredTable.getByRole('button', { name: 'Edit Studio Rose', exact: true }).click()
  assert.equal(await session.page.getByRole('textbox', { name: 'Style name', exact: true }).inputValue(), 'Studio Rose')
  const persisted = await session.page.evaluate(() => window.bridgeclip.captions.list())
  assert.equal(persisted[0].style.highlight_color, '#FF66BB')
  assert.equal(persisted[0].style.max_lines, 3)
  assert.match(await session.page.getByRole('combobox', { name: 'Lines', exact: true }).innerText(), /3 lines/)
  assert.equal(persisted[0].id, saved[0].id)
  assert.equal(persisted[0].baseId, 'retired-default')
  await session.page.getByRole('button', { name: 'Back to presets', exact: true }).click()
  await restoredTable.getByRole('button', { name: 'Delete Studio Rose', exact: true }).click()
  await session.page.getByRole('dialog', { name: 'Delete preset?', exact: true }).getByRole('button', { name: 'Delete preset', exact: true }).click()
  await session.page.getByRole('heading', { name: 'Choose a base', exact: true }).waitFor()
  assert.equal(await restoredTable.count(), 0, 'deleting the last preset restores the initial wizard')
})
