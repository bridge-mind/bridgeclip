'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const ROOT = path.join(__dirname, '../..')

function loadTools(t, mocks = {}) {
  const { dir, cleanup } = tempDir('bridgeclip-assistant-tools-')
  t.after(cleanup)
  const { electron } = fakeElectron(dir)
  const host = { changed: [], shown: [] }
  const mod = loadMain(`
    export * from './src/main/assistant/bridgeclip-tools'
    export * from './src/main/caption-library'
    export { defaultCaptionStyle } from './src/shared/custom-captions'
    export { parseCandidateEdit } from './src/shared/clip-editor'
    export { validateJobConfig } from './src/main/validation'
    export { validateToolInput } from './src/main/assistant/tool-input'
  `, { electron: { ...electron, dialog: {} }, ...mocks })
  const tools = mod.createBridgeClipTools({
    getMainWindow: () => null,
    dataChanged: (scope) => host.changed.push(scope),
    navigate: (page, runDir) => host.shown.push([page, runDir])
  })
  return { mod, tools, host, dir }
}

test('every BridgeClip tool has a strict schema, and anything that publishes, deletes or spends asks first', (t) => {
  const { tools } = loadTools(t)
  const names = tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, 'names are unique')
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z_]{3,64}$/, tool.name)
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
    for (const key of tool.inputSchema.required ?? []) assert.ok(tool.inputSchema.properties[key], `${tool.name}.${key}`)
    assert.ok(tool.description.length > 20, tool.name)
    if (tool.destructive) assert.equal(typeof tool.confirm, 'function', `${tool.name} is destructive and must ask`)
    if (tool.readOnly) assert.equal(tool.confirm, undefined, `${tool.name} is read-only`)
  }
  for (const name of ['start_clip_job', 'post_clip', 'run_automation_now', 'delete_library_run', 'delete_clips', 'delete_automation', 'cancel_job', 'cancel_scheduled_post', 'retry_post', 'reschedule_post', 'update_settings', 'update_automation', 'remove_automation_clip']) {
    assert.equal(typeof tools.find((tool) => tool.name === name)?.confirm, 'function', `${name} asks first`)
  }
  // Never exposed: keys, updates, TikTok consent, account sign-in.
  for (const forbidden of ['replace_api_key', 'install_update', 'approve_tiktok_review', 'connect_account']) assert.ok(!names.includes(forbidden))
})

test('start_clip_job builds a request the Create page’s validator accepts, with its defaults', (t) => {
  const { mod } = loadTools(t)
  const minimal = mod.clipJobRequestFromInput({ source: ' https://www.youtube.com/watch?v=hqP9fivmBqI ' })
  assert.deepEqual(minimal, {
    videoUrl: 'https://www.youtube.com/watch?v=hqP9fivmBqI',
    workflow: 'automatic',
    clippingMode: 'quality',
    maxClips: null,
    autoClipCount: true,
    durationRanges: ['short'],
    aspectRatio: '9:16',
    layoutStyle: 'auto',
    layoutVision: true,
    pacing: 'tight',
    videoSpeed: 1,
    includeCaptions: true,
    captionPreset: 'pop',
    includeTitle: true,
    startTimeSeconds: null,
    endTimeSeconds: null,
    bannerPlatform: null,
    bannerChannelUrl: null
  })
  assert.doesNotThrow(() => mod.validateJobConfig(minimal))
  const custom = mod.clipJobRequestFromInput({
    source: 'https://www.twitch.tv/videos/123', workflow: 'review', mode: 'economy', aspectRatio: '16:9', captions: false, captionStyle: 'neon',
    titleCard: false, durations: ['xshort', 'medium'], maxClips: 4, speed: 1.25, pacing: 'natural', layout: 'fit', startSeconds: 30, endSeconds: 900, clipRequest: '  the pricing debate '
  })
  assert.equal(custom.layoutVision, false, 'economy never pays for vision')
  assert.equal(custom.autoClipCount, false)
  assert.equal(custom.clipRequest, 'the pricing debate')
  const validated = mod.validateJobConfig(custom)
  assert.equal(validated.maxClips, 4)
  assert.equal(validated.captionPreset, 'neon')
})

test('job validation drops fields it doesn’t know, so a typo can’t ride along in the job record', (t) => {
  const { mod } = loadTools(t)
  const request = { ...mod.clipJobRequestFromInput({ source: 'https://example.com/video.mp4' }), clip_request: 'typo', speed: 2, plannerCapabilities: { maxOutputTokens: 1 } }
  const validated = mod.validateJobConfig(request)
  assert.equal('clip_request' in validated, false)
  assert.equal('speed' in validated, false)
  assert.equal(validated.plannerCapabilities, undefined)
  assert.equal(validated.videoSpeed, 1)
})

test('tools refuse run ids that could leave the Library', async (t) => {
  const { tools } = loadTools(t)
  const getRun = tools.find((tool) => tool.name === 'get_library_run')
  for (const runId of ['../secrets', '/etc', 'C:\\Windows', '11111111-1111-4111-8111-11111111111']) {
    await assert.rejects(getRun.run({ runId }, { conversationId: 'c', signal: new AbortController().signal }), /run id/)
  }
})

test('get_clip_options lists exactly the caption styles the engine and the picker know', (t) => {
  const { tools } = loadTools(t)
  return tools.find((tool) => tool.name === 'get_clip_options').run({}, {}).then((options) => {
    const ids = options.captionStyles.map((style) => style.id)
    const engine = fs.readFileSync(path.join(ROOT, 'engine/clip_engine/config.py'), 'utf8')
    const engineIds = [...engine.slice(engine.indexOf('class CaptionPreset:'), engine.indexOf('DEFAULT_CAPTION_PRESET')).matchAll(/^\s+[A-Z_]+ = "([a-z_-]+)"/gm)].map((match) => match[1])
    const picker = fs.readFileSync(path.join(ROOT, 'src/renderer/components/CaptionPresetPicker.tsx'), 'utf8')
    const pickerIds = [...picker.matchAll(/^\s{4}id: '([a-z_-]+)',$/gm)].map((match) => match[1])
    assert.deepEqual(ids, engineIds)
    assert.deepEqual(ids, pickerIds)
  })
})

function customPreset(mod) {
  return { id: 'custom-chat-test', name: 'Preset 1', baseId: 'sweep', style: { ...mod.defaultCaptionStyle('sweep'), highlight_color: '#FF0000', max_lines: 2, line_box_padding_x: 24, line_box_padding_y: 8 } }
}

test('Chat discovers newly saved, renamed and deleted caption presets without recreating its tools', async (t) => {
  const { mod, tools, dir } = loadTools(t)
  const options = tools.find((tool) => tool.name === 'get_clip_options')
  assert.deepEqual((await options.run({}, {})).customCaptionStyles, [])
  const preset = customPreset(mod)
  mod.saveCaptionStyle(preset)
  assert.deepEqual((await options.run({}, {})).customCaptionStyles, [{ id: preset.id, name: 'Preset 1' }])
  mod.saveCaptionStyle({ ...preset, name: 'My captions' })
  assert.deepEqual((await options.run({}, {})).customCaptionStyles, [{ id: preset.id, name: 'My captions' }])
  mod.deleteCaptionStyle(preset.id)
  assert.deepEqual((await options.run({}, {})).customCaptionStyles, [])
  fs.writeFileSync(path.join(dir, 'userData', 'caption-styles.json'), '{broken')
  await assert.rejects(options.run({}, {}), /Could not read your caption styles/, 'a damaged library must not be reported as empty')
})

test('Chat uses validated custom style snapshots in either workflow and refuses missing presets', async (t) => {
  const { mod, tools } = loadTools(t)
  const preset = customPreset(mod)
  mod.saveCaptionStyle(preset)
  const start = tools.find((tool) => tool.name === 'start_clip_job')
  for (const workflow of ['automatic', 'review']) {
    const input = mod.validateToolInput({ source: 'https://example.com/video.mp4', workflow, captionStyle: preset.id }, start.inputSchema)
    const request = mod.validateJobConfig(mod.clipJobRequestFromInput(input))
    assert.equal(request.captionPreset, 'sweep')
    assert.deepEqual(request.customCaption, preset)
    mod.saveCaptionStyle({ ...preset, style: { ...preset.style, font_size: 116 } })
    assert.equal(request.customCaption.style.font_size, preset.style.font_size, 'existing jobs keep their style snapshot')
    mod.saveCaptionStyle(preset)
  }
  for (const captionStyle of ['Preset 1', 'custom-missing', 'unknown-default']) {
    assert.throws(() => mod.clipJobRequestFromInput({ source: '/picked.mp4', captionStyle }), /Caption style not found/)
    await assert.rejects(start.confirm({ source: '/picked.mp4', captionStyle }), /get_clip_options/)
  }
  const builtin = mod.clipJobRequestFromInput({ source: '/picked.mp4', captionStyle: 'neon' })
  assert.equal(builtin.captionPreset, 'neon')
  assert.equal(builtin.customCaption, undefined)
})

test('job approval names the custom preset and starts with that snapshot even if the preset is changed or deleted', async (t) => {
  const requests = []
  const { mod, tools } = loadTools(t, {
    '../job-start': { startClipJobRequest: async (request) => {
      requests.push(request)
      return { jobId: 'test-job', queued: true, job: { id: 'test-job', status: 'queued', percent: 0, request } }
    } }
  })
  const preset = customPreset(mod)
  mod.saveCaptionStyle(preset)
  const start = tools.find((tool) => tool.name === 'start_clip_job')
  const first = { source: '/picked.mp4', captionStyle: preset.id }
  assert.ok((await start.confirm(first)).includes('Captions: Preset 1'))
  const changed = { ...preset, name: 'Renamed', style: { ...preset.style, highlight_color: '#00FF00' } }
  mod.saveCaptionStyle(changed)
  const second = { source: '/another.mp4', captionStyle: preset.id }
  assert.ok((await start.confirm(second)).includes('Captions: Renamed'))
  mod.deleteCaptionStyle(preset.id)
  await start.run(first, {})
  await start.run(second, {})
  assert.deepEqual(requests.map((request) => mod.validateJobConfig(request).customCaption), [preset, changed])
  await assert.rejects(start.confirm({ source: '/picked.mp4', captionStyle: preset.id }), /Caption style not found/)
})

test('review tools report and apply custom presets, preserve snapshots and clear them when choosing a default', async (t) => {
  let saves = 0
  let project = { title: 'Review project', revision: 0, candidates: [{
    id: 'candidate-1', title: 'A clip', status: 'baked', ranges: [[0, 2000]],
    scenes: [{ at_ms: 0, layout: 'fill', crops: [[0, 0, 1, 1]] }],
    captions: true, caption_preset: 'pop', video_speed: 1, exports: [1]
  }] }
  const { mod, tools, host } = loadTools(t, {
    '../clip-editor': {
      openEditor: async () => ({ project: structuredClone(project) }),
      saveEditor: async (_path, revision, edits) => {
        assert.equal(revision, project.revision)
        // Exercise the actual save boundary, including clearing custom_caption.
        const clean = edits.map((edit) => mod.parseCandidateEdit(edit, 2000))
        project = { ...project, revision: revision + 1, candidates: project.candidates.map((candidate, index) => ({ ...candidate, ...clean[index] })) }
        saves++
        return { project }
      }
    }
  })
  const preset = customPreset(mod)
  mod.saveCaptionStyle(preset)
  const update = tools.find((tool) => tool.name === 'update_review_candidates')
  const get = tools.find((tool) => tool.name === 'get_review_project')
  const runId = '11111111-1111-4111-8111-111111111111'
  const change = (fields) => update.run(mod.validateToolInput({ runId, changes: [{ candidateId: 'candidate-1', ...fields }] }, update.inputSchema), {})
  await change({ captionStyle: preset.id })
  assert.equal(project.candidates[0].status, 'ready')
  assert.deepEqual(project.candidates[0].custom_caption, preset)
  assert.equal(project.candidates[0].caption_preset, 'sweep')
  mod.deleteCaptionStyle(preset.id)
  const view = (await get.run({ runId }, {})).candidates[0]
  assert.equal(view.captionStyle, preset.id)
  assert.equal(view.captionStyleName, 'Preset 1')
  await change({ title: 'Renamed clip', captions: false })
  assert.deepEqual(project.candidates[0].custom_caption, preset, 'unrelated edits preserve deleted preset snapshots')
  await assert.rejects(change({ captionStyle: preset.id }), /Caption style not found/)
  assert.equal(saves, 2, 'missing presets never save changes')
  await change({ captionStyle: 'neon', captions: true })
  assert.equal(project.candidates[0].caption_preset, 'neon')
  assert.equal(project.candidates[0].custom_caption, undefined, 'default styles must clear the custom override')
  assert.equal((await get.run({ runId }, {})).candidates[0].captionStyleName, 'Neon')
  assert.deepEqual(host.changed, ['library', 'library', 'library'])
})

test('show_in_bridgeclip asks the window to open a page or a Library run', async (t) => {
  const { mod, tools, host, dir } = loadTools(t)
  const show = tools.find((tool) => tool.name === 'show_in_bridgeclip')
  await show.run({ page: 'automations' }, {})
  await show.run({ page: 'library', runId: '11111111-1111-4111-8111-111111111111' }, {})
  assert.deepEqual(host.shown[0], ['automations', undefined])
  assert.equal(host.shown[1][0], 'library')
  assert.equal(path.basename(host.shown[1][1]), '11111111-1111-4111-8111-111111111111')
  assert.ok(host.shown[1][1].startsWith(dir), 'inside the Library folder')
  await show.run(mod.validateToolInput({ page: 'captions' }, show.inputSchema), {})
  assert.deepEqual(host.shown[2], ['captions', undefined])
})
