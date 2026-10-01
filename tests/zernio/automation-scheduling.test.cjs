'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock } = require('./support/mock-posts.cjs')

const SOURCE = { title: 'How reliable automations work', description: 'A long discussion.', channel: 'Example channel', url: 'https://www.youtube.com/watch?v=hqP9fivmBqI' }
const TRANSCRIPT = 'Building reliable automations starts with accurate transcripts.'
const POST = { platform: 'youtube', title: 'Why Accurate Transcripts Matter', caption: 'Accurate transcripts are the foundation for reliable automations.', tags: ['automation'], categoryId: '28', topicTag: null, evidence: 'accurate transcripts' }
const entry = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'

async function waitFor(check, message) {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function scheduledBank(t, colors) {
  const { dir, cleanup } = tempDir('bridgeclip-scheduling-')
  const posting = createPostingMock()
  const chat = { delay: 0, started: 0 }
  const mock = await createMockZernio({ apiKey: 'schedule-key', extraRoutes: [...posting.routes,
    { method: 'POST', path: '/speech', auth: false, handler: (ctx) => ctx.json(200, { text: TRANSCRIPT }) },
    { method: 'POST', path: '/chat', auth: false, handler: async (ctx) => {
      chat.started++
      if (chat.delay) await new Promise((resolve) => setTimeout(resolve, chat.delay))
      ctx.json(200, { choices: [{ message: { content: JSON.stringify({ posts: [POST] }) } }] })
    } }
  ] })
  const env = { BRIDGECLIP_ZERNIO_API_URL: mock.apiUrl, BRIDGECLIP_E2E_TRANSCRIPTION_URL: `${mock.url}/speech`, BRIDGECLIP_E2E_OPENROUTER_URL: `${mock.url}/chat`, PATH: `${process.env.PATH}${path.delimiter}${path.join(ROOT, 'engine-bin')}` }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await mock.close(); cleanup()
  })
  const { electron } = fakeElectron(dir)
  const main = loadMain(entry, { electron })
  main.settings.replaceApiKey('zernioApiKey', 'schedule-key')
  main.settings.replaceApiKey('openrouterApiKey', 'test-only')
  const library = path.join(dir, 'library'); const run = path.join(library, 'run-one'); fs.mkdirSync(run, { recursive: true })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  const clips = colors.map((color, index) => {
    const clip = path.join(run, `clip_${index}.mp4`)
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:d=2:r=15`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', clip])
    return clip
  })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ source_video_title: SOURCE.title, source_video_description: SOURCE.description, source_video_channel: SOURCE.channel, source_video_url: SOURCE.url,
    clips: clips.map((clip, index) => ({ clip_index: index, s3_url: `file://${clip}`, duration_ms: 2000, start_time_ms: 0, end_time_ms: 2000, summary: `Clip ${index}`, virality_score: 0.8 })) }))
  const [created] = main.automations.createAutomation('Scheduled')
  const profile = mock.state.profiles[0]; const account = mock.addAccount('youtube', profile._id)
  await main.automations.updateAutomation(created.id, { name: created.name, enabled: true, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: ['12:00'], youtubeVisibility: 'unlisted', youtubeMadeForKids: false, accounts: [{ platform: 'youtube', accountId: account._id }] })
  await main.automations.addLibraryClipsToAutomation(created.id, run, colors.map((_, index) => index))
  return { main, electron, posting, chat, id: created.id, bank: () => main.automations.listAutomations()[0] }
}

test('a slot that comes due during a long enhancement posts when the lock frees, and a draft holds only its own clip', async (t) => {
  const f = await scheduledBank(t, ['blue', 'red', 'green'])
  const [first, second, third] = f.bank().content
  f.chat.delay = 800
  const enhancing = f.main.automations.enhanceAutomationContent(f.id, first.id, { source: SOURCE, research: false })
  await waitFor(() => f.chat.started === 1, 'enhancement reached the writer')
  const slot = { time: '12:00', date: '2026-09-28' }
  await f.main.automations.runAutomation(f.id, slot)
  assert.equal(f.posting.state.creates.length, 0, 'the lock is held, so nothing posts yet')
  assert.notEqual(f.bank().lastSlots['12:00'], slot.date, 'the slot is not consumed while waiting')
  await enhancing
  f.chat.delay = 0
  await waitFor(() => f.posting.state.creates.length === 1 && f.bank().content[1].status === 'posted', 'the deferred slot posted')
  let bank = f.bank()
  assert.equal(bank.lastSlots['12:00'], slot.date)
  assert.ok(bank.content[0].metadataDraft, 'the enhanced clip keeps its draft for review')
  assert.equal(bank.content[0].status, 'queued')
  assert.equal(bank.content[1].id, second.id)
  assert.equal(bank.lastError, null)
  await f.main.automations.runAutomation(f.id, slot)
  assert.equal(f.posting.state.creates.length, 1, 'a slot posts once')

  // Past the deferral window, the slot is reported as missed rather than posted late.
  f.chat.delay = 800
  const again = f.main.automations.enhanceAutomationContent(f.id, third.id, { research: false })
  await waitFor(() => f.chat.started === 2, 'second enhancement reached the writer')
  const later = { time: '12:00', date: '2026-09-29' }
  await f.main.automations.runAutomation(f.id, later)
  const realNow = Date.now
  Date.now = () => realNow() + 2 * 3_600_000
  try { await again } finally { Date.now = realNow }
  await waitFor(() => f.bank().lastSlots['12:00'] === later.date, 'the missed slot was recorded')
  bank = f.bank()
  assert.match(bank.lastError, /12:00 post was skipped/)
  assert.equal(bank.lastErrorAcknowledged, false)
  assert.equal(f.posting.state.creates.length, 1)

  // Only clips with drafts remain: nothing posts, and the warning says why.
  await f.main.automations.runAutomation(f.id)
  bank = f.bank()
  assert.match(bank.lastError, /Apply or discard the enhanced metadata drafts/)
  assert.equal(f.posting.state.creates.length, 1)
  // Discarding a draft clears only that warning, never an unrelated one.
  f.main.automations.resolveAutomationMetadataDraft(f.id, first.id, bank.content[0].metadataDraft.id, false)
  assert.equal(f.bank().lastError, null)
  const store = path.join(f.electron.app.getPath('userData'), fs.readdirSync(f.electron.app.getPath('userData')).find((name) => /^automations-.*\.json$/.test(name)))
  const saved = JSON.parse(fs.readFileSync(store, 'utf8'))
  saved.automations[0].lastError = 'The selected Zernio profile is over its account limit.'
  fs.writeFileSync(store, JSON.stringify(saved))
  const reloaded = loadMain(entry, { electron: f.electron })
  const withDraft = reloaded.automations.listAutomations()[0].content[2]
  reloaded.automations.resolveAutomationMetadataDraft(f.id, withDraft.id, withDraft.metadataDraft.id, false)
  assert.equal(reloaded.automations.listAutomations()[0].lastError, 'The selected Zernio profile is over its account limit.')
})

test('each new blocked slot warns again after an acknowledgement, but repeat ticks of one slot do not', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-blocked-slots-')
  try {
    const main = loadMain(entry, { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('zernioApiKey', 'blocked-key')
    main.settings.savePublicSettings({ outputDirectory: path.join(dir, 'library'), pythonPath: 'python3' })
    const [created] = main.automations.createAutomation('Empty')
    const store = path.join(dir, 'userData', fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-.*\.json$/.test(name)))
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'))
    Object.assign(saved.automations[0], { enabled: true, times: ['12:00'] })
    fs.writeFileSync(store, JSON.stringify(saved))
    const fresh = loadMain(entry, { electron: fakeElectron(dir).electron })
    const day = (date) => ({ time: '12:00', date })
    let [automation] = await fresh.automations.runAutomation(created.id, day('2026-09-28'))
    assert.equal(automation.lastError, 'No queued clips are available.')
    assert.equal(automation.lastErrorAcknowledged, false)
    fresh.automations.acknowledgeAutomationWarnings(created.id)
    ;[automation] = await fresh.automations.runAutomation(created.id, day('2026-09-28'))
    assert.equal(automation.lastErrorAcknowledged, true, 'the same slot ticking again stays acknowledged')
    ;[automation] = await fresh.automations.runAutomation(created.id, day('2026-09-29'))
    assert.equal(automation.lastErrorAcknowledged, false, 'the next day’s stall warns again')
    fresh.automations.acknowledgeAutomationWarnings(created.id)
    ;[automation] = await fresh.automations.runAutomation(created.id)
    assert.equal(automation.lastErrorAcknowledged, false, 'a manual run warns again')
  } finally { cleanup() }
})
