const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { editorTools, linkEngine } = require('./editor-e2e-tools.cjs')
const { loadMain } = require('../zernio/support/load-main.cjs')
const { defaultCaptionStyle } = loadMain("export { defaultCaptionStyle } from './src/shared/custom-captions'")
const fixture = require('../fixtures/editor/project.json')

test('editor refreshes a custom preset only when selected and bakes its complete padded background', { timeout: 150000 }, async t => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-editor-preset-'))
  const userDataDir = path.join(root, 'data'), library = path.join(userDataDir, 'BridgeClip'), run = path.join(library, 'preset-test')
  fs.mkdirSync(run, { recursive: true })
  const latest = { id: 'custom-editor-test', name: 'Studio test', baseId: 'sweep', style: {
    ...defaultCaptionStyle('sweep'), font_size: 76, max_words_per_line: 5, max_lines: 2,
    primary_color: '#FFFFFF', highlight_color: '#FF0000', outline_width: 6, future_words: 'show',
    entrance_pop: false, karaoke_fill: false, shadow_opacity: 0,
    line_box_color: '#00FF00', line_box_opacity: 1, line_box_padding_x: 24, line_box_padding_y: 4
  } }
  const old = { ...latest, style: { ...latest.style, line_box_opacity: .4, line_box_padding_x: 2, line_box_padding_y: 2 } }
  const project = { ...structuredClone(fixture), title: 'Caption bake test', width: 360, height: 640, duration_ms: 2000,
    transcript: [{ start_ms: 0, end_ms: 1500, text: 'START SMALL MAKE BIG CHANGES' }] }
  project.candidates = [{ ...project.candidates[0], status: 'ready', ranges: [[0, 1800]],
    scenes: [{ at_ms: 0, layout: 'fill', crops: [[0, 0, 1, 1]] }], caption_y: .5,
    caption_preset: 'sweep', custom_caption: old, caption_edits: [], caption_suppression_ranges: [],
    captions: true, video_speed: 1, review: null, exports: [] }]
  fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(project))
  fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ segments: [{ start_time_ms: 0, end_time_ms: 1500,
    text: project.transcript[0].text, words: project.transcript[0].text.split(' ').map((word, i) => ({ word, start_time_ms: i * 300, end_time_ms: (i + 1) * 300 })) }] }))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'preset-test', source_video_title: project.title, clips: [], total_clips: 0, editor_project: true }))
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 6, outputDirectory: library, pythonPath: tools.python, openrouterApiKey: '', zernioApiKey: '' }))
  execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x243347:s=360x640:r=10:d=2',
    ...tools.encoder, '-pix_fmt', 'yuv420p', path.join(run, 'editor-source.mp4')])
  fs.copyFileSync(path.join(run, 'editor-source.mp4'), path.join(run, 'editor-preview.mp4'))
  const appDir = buildApp(path.join(root, 'app')); linkEngine(appDir)
  const session = await launchApp({ appDir, userDataDir, env: tools.appEnv })
  t.after(async () => {
    await session.page.evaluate(() => window.bridgeclip.editor.closeReady(true)).catch(() => {})
    await session.close(); fs.rmSync(root, { recursive: true, force: true })
  })
  const { app, page } = session
  page.setDefaultTimeout(12000)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 1000)
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
  })
  await page.evaluate(preset => window.bridgeclip.captions.save(preset), latest)
  await page.reload()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'Open Caption bake test', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor' }).waitFor()
  await page.locator('.editor-tabs').getByRole('button', { name: 'Captions', exact: true }).click()
  const selected = page.getByRole('radiogroup', { name: 'Your caption styles', exact: true }).getByRole('radio', { name: 'Studio test', exact: true })
  assert.equal(await selected.getAttribute('aria-checked'), 'true')
  const saved = () => JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'))).candidates[0]
  assert.deepEqual(saved().custom_caption, old, 'opening an existing candidate preserves its saved appearance')
  await selected.click()
  await page.waitForFunction(() => document.querySelector('.editor-header')?.textContent.includes('All changes saved'))
  assert.deepEqual(saved().custom_caption, latest, 'explicitly reselecting the same preset refreshes every saved field')
  assert.equal(saved().status, 'refining', 'the changed appearance needs to be marked ready again')
  await page.getByRole('button', { name: 'Mark ready', exact: true }).click()
  await page.getByRole('button', { name: 'Bake captions', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.editor-stagebar .editor-status')?.textContent === 'Baked', undefined, { timeout: 90000 })
  assert.deepEqual(saved().custom_caption, latest)
  const output = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'))).clips[0].s3_url
  const rgb = execFileSync(tools.ffmpeg, ['-v', 'error', '-ss', '0.2', '-i', output,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 })
  const width = 1080, height = 1920
  assert.equal(rgb.length, width * height * 3)
  const green = (x, y) => { const i = (y * width + x) * 3; return rgb[i] < 45 && rgb[i + 1] > 190 && rgb[i + 2] < 45 }
  let left = width, right = 0, top = height, bottom = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (green(x, y)) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  assert.ok(Math.abs(bottom - top + 1 - (76 * 2 + 4 * 2)) <= 3, 'baked background includes both line boxes and vertical padding')
  assert.ok(Math.abs((top + bottom + 1) / 2 - height / 2) <= 2, 'background stays at the chosen caption position')
  for (let y = top + 3; y < bottom - 2; y++) assert.ok(green(left + 3, y) && green(right - 3, y), 'the background fills the whole block, including the shorter row')
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    execFileSync(tools.ffmpeg, ['-v', 'error', '-ss', '0.2', '-i', output, '-frames:v', '1', '-y', path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'editor-custom-caption-bake.png')])
  }
})
