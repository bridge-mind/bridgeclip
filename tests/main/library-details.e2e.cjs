const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const project = require('../fixtures/editor/project.json')

test('Library details keeps source and clips prominent with accessible secondary actions', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-library-details-'))
  const userDataDir = path.join(root, 'data'), run = path.join(userDataDir, 'BridgeClip', 'demo-run')
  fs.mkdirSync(run, { recursive: true })
  const title = 'Small ideas, lasting impact'
  const clips = ['Make room for better ideas', 'Start with one small change', 'The habit that makes it stick', 'A fresh perspective'].map((summary, clip_index) => ({
    clip_index, summary, s3_url: path.join(run, `clip_${clip_index}.mp4`), duration_ms: 30000 + clip_index * 5000,
    start_time_ms: (3 - clip_index) * 60000, end_time_ms: (3 - clip_index) * 60000 + 30000 + clip_index * 5000,
    virality_score: .9 - clip_index * .05, tags: ['ideas']
  }))
  const output = { job_id: 'demo-run', source_video_title: title, source_video_url: 'https://youtu.be/abcdefghijk',
    source_video_channel: 'Studio Conversations', source_video_duration_seconds: 1858, total_clips: 4, clips,
    editor_project: true, created_at: '2026-09-29T18:15:00Z', processing_time_seconds: 1596,
    metrics: { requested_settings: { aspect_ratio: '9:16' }, api_costs: { total_estimated_cost_usd: .19 }, pipeline_stages: [
      { id: 'download', state: 'completed', percent: 100, elapsed_ms: 14000 },
      { id: 'transcription', state: 'completed', percent: 100, elapsed_ms: 42000 },
      { id: 'planning', state: 'completed', percent: 100, elapsed_ms: 90000 },
      { id: 'rendering', state: 'completed', percent: 100, elapsed_ms: 1450000 }
    ] } }
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(output))
  fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ segments: [{ start_time_ms: 0, end_time_ms: 2000, text: 'Every idea starts with a little curiosity.', words: [] }] }))
  const session = await launchApp({ appDir: process.env.BRIDGECLIP_E2E_APP_DIR || buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  // Render a deterministic synthetic thumbnail locally, without external media.
  await page.evaluate(() => {
    const art = document.createElement('div'); art.id = 'test-art'
    art.style.cssText = 'position:fixed;inset:0;z-index:9999;width:360px;height:640px;background:linear-gradient(150deg,#405c75,#182b40 60%,#0e1728);display:flex;align-items:center;justify-content:center;color:#f4e6bf;font:700 32px sans-serif;text-align:center;padding:32px;box-sizing:border-box'
    art.innerHTML = '<div><div style="font-size:12px;letter-spacing:4px;margin-bottom:28px;color:#b6c6d8">STUDIO CONVERSATIONS</div>SMALL IDEAS.<br>LASTING IMPACT.<div style="height:2px;width:60px;background:#b89c61;margin:28px auto"></div><div style="font-size:13px;font-weight:400;color:#b6c6d8">A new perspective, every day.</div></div>'
    document.body.append(art)
  })
  await page.locator('#test-art').screenshot({ path: path.join(run, 'thumb.png') })
  await page.locator('#test-art').evaluate(el => el.remove())
  await app.evaluate(({ BrowserWindow, ipcMain }, { run, project }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 1080)
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
    globalThis.libraryDetailsTest = { opened: [], metadataCalls: 0, statusCalls: 0 }
    for (const name of ['source:youtubePreview', 'shell:openPath', 'thumbnails:generate', 'editor:open', 'history:postingStatus']) ipcMain.removeHandler(name)
    ipcMain.handle('source:youtubePreview', () => { globalThis.libraryDetailsTest.metadataCalls++; throw new Error('Offline') })
    ipcMain.handle('shell:openPath', (_event, file) => { globalThis.libraryDetailsTest.opened.push(file); return true })
    ipcMain.handle('thumbnails:generate', () => `${run}/thumb.png`)
    const candidates = project.candidates.map((candidate, index) => ({ ...candidate, status: index ? 'ready' : 'baked' }))
    ipcMain.handle('editor:open', () => ({ project: { ...project, candidates }, sourcePath: `${run}/source.mp4`, previewPath: `${run}/preview.mp4` }))
    ipcMain.handle('history:postingStatus', () => { globalThis.libraryDetailsTest.statusCalls++; return [0, 1, 2, 3].map(clipIndex => ({ clipIndex, state: clipIndex === 3 ? 'posted' : 'not_posted', platforms: [] })) })
  }, { run, project })
  await page.route('https://i.ytimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#223c52"/><circle cx="510" cy="95" r="70" fill="#a4946a"/><path d="M0 360V280L180 160 400 360M250 360 470 205 640 310V360" fill="#4c6475"/><text x="32" y="290" fill="#f4e6bf" font-family="sans-serif" font-weight="bold" font-size="27">SMALL IDEAS, LASTING IMPACT</text></svg>' }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click()
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
  await page.getByRole('button', { name: 'Continue editing', exact: true }).waitFor()
  await page.getByRole('region', { name: 'Not Posted 3', exact: true }).locator('img').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  const shot = async name => {
    if (!process.env.BRIDGECLIP_E2E_SHOTS) return
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, name), animations: 'disabled' })
  }
  await shot('library-details.png')
  const source = page.getByRole('region', { name: 'YouTube video preview', exact: true })
  await source.getByText('Studio Conversations', { exact: true }).waitFor()
  await source.getByText('30:58', { exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.libraryDetailsTest.metadataCalls), 0, 'saved source metadata needs no network lookup')
  const stats = page.getByRole('group', { name: 'Run stats', exact: true })
  await stats.getByText('$0.19', { exact: true }).first().waitFor()
  // Staggered cell entrances still run with reduced motion. Geometry must not
  // depend on the optional screenshot helper finishing animations for us.
  await stats.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
  })
  const sourceBox = await source.boundingBox(), statsBox = await stats.boundingBox()
  assert.ok(Math.abs(sourceBox.width - statsBox.width) < 1, 'source and stats each occupy half the row')
  assert.ok(Math.abs(sourceBox.y - statsBox.y) < 1 && Math.abs(sourceBox.height - statsBox.height) < 1, 'both panels align at the top and bottom')
  const cells = await stats.locator(':scope > *').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width } }))
  assert.equal(cells.length, 4)
  assert.equal(cells[0].y, cells[1].y)
  assert.equal(cells[2].y, cells[3].y)
  assert.equal(cells[0].x, cells[2].x)
  assert.ok(cells[1].x > cells[0].x && cells[2].y > cells[0].y, 'stats form two rows and two columns')
  assert.equal(await page.getByRole('button', { name: 'Inspect transcript & edits', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Open folder', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Refresh post status', exact: true }).count(), 0)
  await source.getByRole('button', { name: 'View on YouTube' }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.libraryDetailsTest.opened), ['https://www.youtube.com/watch?v=abcdefghijk'])
  const actions = page.getByRole('button', { name: 'Library item actions', exact: true })
  await actions.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Library item actions', exact: true })
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Transcript & edits', 'Processing details', 'Open folder', 'Refresh post status'])
  await shot('library-details-menu.png')
  await menu.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Processing details', exact: true })
  await details.getByRole('list', { name: 'Stage progress' }).getByText('0:14', { exact: true }).waitFor()
  const close = details.getByRole('button', { name: 'Close processing details' })
  assert.equal(await close.evaluate(el => el === document.activeElement), true)
  await close.press('Shift+Tab')
  assert.equal(await details.evaluate(el => el.contains(document.activeElement)), true, 'focus remains in processing details')
  await shot('library-processing-details.png')
  await page.keyboard.press('Escape')
  assert.equal(await actions.evaluate(el => el === document.activeElement), true)
  await actions.click()
  await menu.getByRole('menuitem', { name: 'Transcript & edits', exact: true }).click()
  const transcript = page.getByRole('dialog', { name: 'Inspect transcript and edits' })
  await transcript.getByText('Every idea starts with a little curiosity.', { exact: false }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await actions.evaluate(el => el === document.activeElement), true)
  await actions.click()
  await menu.getByRole('menuitem', { name: 'Open folder', exact: true }).click()
  assert.equal(fs.realpathSync((await app.evaluate(() => globalThis.libraryDetailsTest.opened)).at(-1)), fs.realpathSync(run))
  const calls = await app.evaluate(() => globalThis.libraryDetailsTest.statusCalls)
  await actions.click()
  await menu.getByRole('menuitem', { name: 'Refresh post status', exact: true }).click()
  assert.ok(await app.evaluate(async (_, calls) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (globalThis.libraryDetailsTest.statusCalls > calls) return true
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return false
  }, calls))
  // Search spans collapsed Posted clips; selection and bulk actions stay scoped to the result.
  await page.getByRole('textbox', { name: 'Search clips', exact: true }).fill('fresh')
  await page.getByText('1 of 4 clips', { exact: true }).waitFor()
  await page.getByRole('checkbox', { name: 'Select all clips', exact: true }).click()
  await page.getByRole('button', { name: 'Export 1', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Show all clips', exact: true }).click()
  await page.getByRole('button', { name: 'Export 1', exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('radio', { name: 'Timeline', exact: true }).click()
  assert.equal(await page.getByRole('region', { name: 'Not Posted 3', exact: true }).locator('article').first().getByText('The habit that makes it stick', { exact: true }).count(), 1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 800))
  await page.getByRole('checkbox', { name: 'Select all clips', exact: true }).click()
  await page.getByRole('button', { name: 'Export 3', exact: true }).waitFor()
  const smallSource = await source.boundingBox(), smallStats = await stats.boundingBox()
  assert.ok(smallStats.y >= smallSource.y + smallSource.height, 'panels stack in compact windows')
  assert.equal(await stats.evaluate(el => el.scrollWidth <= el.clientWidth), true)
  const controls = page.getByRole('region', { name: 'Clip controls', exact: true })
  assert.equal(await controls.evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await shot('library-details-small.png')
  await actions.click()
  await menu.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
  assert.equal(await details.evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.ok((await close.boundingBox()).y >= 0)
  await page.keyboard.press('Escape')
  // A missing local source and older run still have a title, saved duration, and usable clips.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click()
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ ...output, editor_project: false, source_video_url: path.join(run, 'missing.mp4'), metrics: null }))
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click()
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
  await page.getByText('Local file', { exact: true }).waitFor()
  await page.getByText('30:58', { exact: true }).first().waitFor()
  assert.equal(await page.getByRole('button', { name: 'Continue editing', exact: true }).count(), 0)
  await actions.click()
  await menu.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
  await details.getByText('Stage timings weren’t recorded for this run.', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
})
