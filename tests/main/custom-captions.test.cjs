const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const schema = loadMain("export * from './src/shared/custom-captions'; export * from './src/shared/clip-editor'; export { validateJobConfig } from './src/main/validation'")
const preset = () => ({ id: 'custom-test', name: 'My Pop', baseId: 'pop', style: schema.defaultCaptionStyle('pop') })

test('caption library persists copies, updates and deletion without changing embedded snapshots', t => {
  const root = tempDir('bridgeclip-captions-'); t.after(root.cleanup)
  const { electron } = fakeElectron(root.dir)
  const load = () => loadMain("export * from './src/main/caption-library'", { electron })
  const library = load(), original = preset()
  assert.deepEqual(library.listCaptionStyles(), [])
  library.saveCaptionStyle(original)
  assert.deepEqual(load().listCaptionStyles(), [original])
  const next = { ...original, style: { ...original.style, font_size: 116, highlight_color: '#123456' } }
  library.saveCaptionStyle(next)
  assert.equal(load().listCaptionStyles()[0].style.font_size, 116)
  assert.equal(original.style.font_size, 84)
  assert.throws(() => library.saveCaptionStyle({ ...next, id: 'custom-duplicate', name: 'my pop' }), /already exists/)
  library.deleteCaptionStyle(next.id)
  assert.deepEqual(load().listCaptionStyles(), [])
  assert.equal(schema.parseCustomCaption(original).style.font_size, 84)
  const file = path.join(root.dir, 'userData', 'caption-styles.json')
  fs.writeFileSync(file, '{broken')
  assert.throws(() => library.saveCaptionStyle(original), /kept for recovery/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})

test('caption validation rejects unsafe renderer input and bounds expensive effects', () => {
  for (const patch of [{ font_name: 'font,with,ASS,tags' }, { primary_color: '{\\pos(1,2)}' }, { font_size: 0 }, { font_size: 161 },
    { max_words_per_line: 50 }, { max_lines: 0 }, { max_lines: 4 }, { max_lines: 1.5 }, { max_lines: true }, { max_lines: '2' },
    { outline_width: Infinity }, { line_box_opacity: NaN }, { uppercase: 'true' }, { shell_command: 'bad' },
    { shadow_blur: 500 }, { shadow_opacity: NaN }, { glow_radius: -1 }, { position: 'outside' }, { bold: 'yes' }]) {
    assert.throws(() => schema.parseCustomCaption({ ...preset(), style: { ...preset().style, ...patch } }), /Invalid custom caption/)
  }
  for (const patch of [{ name: '' }, { name: 'a'.repeat(49) }, { baseId: '../missing' }, { id: '../../outside' }]) assert.throws(() => schema.parseCustomCaption({ ...preset(), ...patch }))
})

test('retired defaults do not prevent custom presets loading, saving or reaching a job and editor', t => {
  const root = tempDir('bridgeclip-retired-caption-'); t.after(root.cleanup)
  const { electron } = fakeElectron(root.dir)
  const library = loadMain("export * from './src/main/caption-library'", { electron })
  const standalone = { ...preset(), baseId: 'retired-default', style: schema.defaultCaptionStyle('impact') }
  library.saveCaptionStyle(standalone)
  assert.deepEqual(library.listCaptionStyles(), [standalone])
  const request = { videoUrl: 'https://example.com/video', workflow: 'review', autoClipCount: true, maxClips: null,
    aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'natural', includeCaptions: true,
    captionPreset: standalone.baseId, customCaption: standalone, durationRanges: null,
    startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null }
  assert.deepEqual(schema.validateJobConfig(request).customCaption, standalone)
  const project = structuredClone(require('../fixtures/editor/project.json'))
  project.candidates[0].caption_preset = standalone.baseId
  project.candidates[0].custom_caption = standalone
  assert.deepEqual(schema.parseEditorProject(project).candidates[0].custom_caption, standalone)
})

test('older partial snapshots recover frozen rendering details independently of current defaults', () => {
  const legacy = require('../../engine/clip_engine/data/legacy-caption-rendering.json')
  for (const baseId of Object.keys(legacy.presets)) {
    const complete = schema.defaultCaptionStyle(baseId)
    const partial = { ...complete }
    for (const key of Object.keys(legacy.common)) delete partial[key]
    const restored = schema.parseCustomCaption({ ...preset(), baseId, style: partial })
    assert.deepEqual(restored.style, complete, baseId)
    assert.deepEqual(partial, Object.fromEntries(Object.entries(complete).filter(([key]) => !Object.hasOwn(legacy.common, key))), 'migration does not mutate old snapshots')
  }
  const unknown = { ...preset(), baseId: 'retired-default', style: { ...preset().style } }
  delete unknown.style.shadow_blur
  assert.throws(() => schema.parseCustomCaption(unknown), /Invalid custom caption/)
})

test('line limits round-trip and legacy presets keep automatic wrapping', t => {
  const legacy = preset()
  delete legacy.style.max_lines
  assert.equal(schema.parseCustomCaption(legacy).style.max_lines, null)
  const root = tempDir('bridgeclip-caption-lines-'); t.after(root.cleanup)
  const { electron } = fakeElectron(root.dir)
  const load = () => loadMain("export * from './src/main/caption-library'", { electron })
  const file = path.join(root.dir, 'userData', 'caption-styles.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify([legacy]))
  assert.equal(load().listCaptionStyles()[0].style.max_lines, null)
  for (const max_lines of [1, 2, 3, null]) {
    const snapshot = { ...preset(), style: { ...preset().style, max_lines } }
    load().saveCaptionStyle(snapshot)
    assert.deepEqual(load().listCaptionStyles(), [snapshot])
  }
})

test('custom captions survive job validation and editor saves, invalidate bakes and preserve Jev reviews', () => {
  const request = { videoUrl: 'https://example.com/video', workflow: 'review', autoClipCount: true, maxClips: null,
    aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'natural', includeCaptions: true, captionPreset: 'pop',
    customCaption: preset(), durationRanges: null, startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null }
  assert.deepEqual(schema.validateJobConfig(request).customCaption, request.customCaption)
  assert.throws(() => schema.validateJobConfig({ ...request, captionPreset: 'glow' }), /base/)
  const project = structuredClone(require('../fixtures/editor/project.json'))
  const candidate = project.candidates[0]
  candidate.caption_preset = 'pop'; candidate.custom_caption = preset()
  const parsed = schema.parseEditorProject(project).candidates[0]
  assert.deepEqual(schema.candidateEdit(parsed).custom_caption, preset())
  const changed = schema.refineEdit({ ...parsed, status: 'baked' }, { custom_caption: { ...preset(), style: { ...preset().style, font_size: 120 } } })
  assert.equal(changed.status, 'refining')
  assert.notEqual(schema.renderEditKey(changed), schema.renderEditKey(parsed))
  assert.equal(schema.editSignature(changed), schema.editSignature(parsed))
  const limited = schema.refineEdit({ ...parsed, status: 'baked' }, { custom_caption: { ...preset(), style: { ...preset().style, max_lines: 1 } } })
  assert.equal(limited.status, 'refining')
  assert.notEqual(schema.renderEditKey(limited), schema.renderEditKey(parsed))
  assert.equal(schema.editSignature(limited), schema.editSignature(parsed))
  assert.throws(() => schema.parseCandidateEdit({ ...candidate, caption_preset: 'glow' }, project.duration_ms))
})

test('the actual worker input carries the selected caption snapshot', t => {
  const root = tempDir('bridgeclip-caption-worker-'); t.after(root.cleanup)
  const { electron } = fakeElectron(root.dir)
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let input = ''
  child.stdin.on('data', data => { input += data.toString() })
  const runner = loadMain("export * from './src/main/pipeline-runner'", {
    electron,
    fs: { ...fs, existsSync: () => true },
    child_process: { ...require('node:child_process'), spawn: () => child },
    './settings-store': { loadSettings: () => ({ outputDirectory: root.dir, enginePath: root.dir, pythonPath: 'python3' }),
      getSettingsForBridge: () => ({}), vocabularyTerms: () => [] },
    './tools': { resolveBinary: () => '/staged/ffmpeg' },
    './logger': { logger: { info() {}, warn() {}, error() {} } }
  })
  const snapshot = preset()
  snapshot.style.font_size = 115
  snapshot.style.max_lines = 2
  runner.startClipJob('custom-caption-job', { videoUrl: 'https://example.com/video', captionPreset: 'pop', customCaption: snapshot },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } })
  assert.deepEqual(JSON.parse(input).custom_caption, snapshot)
  assert.equal(JSON.parse(input).caption_preset, snapshot.baseId)
  child.emit('close', 1, null)
})

test('editor disk saves keep snapshots across library edits and clear them when selecting a default', async t => {
  const root = tempDir('bridgeclip-caption-editor-'); t.after(root.cleanup)
  const library = path.join(root.dir, 'library'), run = path.join(library, 'caption-run')
  fs.mkdirSync(run, { recursive: true })
  for (const file of ['editor-source.mp4', 'editor-preview.mp4']) fs.writeFileSync(path.join(run, file), 'video')
  fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(require('../fixtures/editor/project.json')))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'caption-run', clips: [], editor_project: true }))
  const { electron } = fakeElectron(root.dir)
  const load = () => loadMain("export * from './src/main/clip-editor'; export * from './src/main/caption-library'; export * as settings from './src/main/settings-store'", { electron })
  const main = load()
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  const opened = await main.openEditor(run)
  const candidates = opened.project.candidates
  candidates[0].caption_preset = 'pop'; candidates[0].custom_caption = preset()
  const saved = await main.saveEditor(run, opened.project.revision, candidates)
  main.saveCaptionStyle({ ...preset(), style: { ...preset().style, font_size: 128 } })
  assert.equal((await load().openEditor(run)).project.candidates[0].custom_caption.style.font_size, 84)
  const defaults = saved.project.candidates
  defaults[0].caption_preset = 'glow'; delete defaults[0].custom_caption
  await main.saveEditor(run, saved.project.revision, defaults)
  const reloaded = await load().openEditor(run)
  assert.equal(reloaded.project.candidates[0].caption_preset, 'glow')
  assert.equal(reloaded.project.candidates[0].custom_caption, undefined)
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8')).candidates[0], 'custom_caption'), false)
})
