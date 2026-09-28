'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock } = require('./support/mock-posts.cjs')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')

const KEY = 'automation-test-key'
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'

function makeClip(file, color = 'blue') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:d=4:r=15`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'mpeg4', '-q:v', '8',
    '-c:a', 'aac', '-movflags', '+faststart', file])
  return file
}

test('daily slots use the configured time zone and include a short restart grace period', () => {
  const { dueSlots } = loadMain("export { dueSlots } from './src/shared/automations'", { electron: {} })
  const now = Date.parse('2026-09-25T00:02:00Z')
  assert.deepEqual(dueSlots(['23:59'], 'UTC', now), [{ time: '23:59', date: '2026-09-24' }])
  assert.deepEqual(dueSlots(['23:55'], 'UTC', now), [])
  assert.deepEqual(dueSlots(['20:00'], 'America/New_York', now), [{ time: '20:00', date: '2026-09-24' }])
})

test('reordered queues and original media provenance survive a fresh load', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-reorder-')
  try {
    const library = path.join(dir, 'library')
    fs.mkdirSync(library)
    const paths = ['first', 'second', 'third'].map((name) => {
      const file = path.join(library, `${name}.mp4`)
      fs.writeFileSync(file, name)
      return file
    })
    const source = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"
    const mocks = { electron: fakeElectron(dir).electron }
    const main = loadMain(source, mocks)
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [automation] = main.automations.createAutomation('Queue')
    const [added] = await main.automations.addAutomationContent(automation.id, paths)
    const [a, b, c] = added.content
    assert.equal(a.sourceClipPath, fs.realpathSync(paths[0]))
    main.automations.reorderAutomationContent(automation.id, c.id, a.id)
    const reloaded = loadMain(source, mocks).automations.listAutomations()[0]
    assert.deepEqual(reloaded.content.map((item) => item.id), [c.id, a.id, b.id])
    assert.equal(reloaded.content[1].sourceClipPath, a.sourceClipPath)
    assert.throws(() => main.automations.reorderAutomationContent(automation.id, 'invalid', null), /Choose queued/)
  } finally { cleanup() }
})

test('metadata dismissal is scoped to one error, persists, and new failures warn again', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-dismiss-metadata-')
  try {
    const library = path.join(dir, 'library'); fs.mkdirSync(library)
    const clip = path.join(library, 'clip.mp4'); fs.writeFileSync(clip, 'test media')
    const source = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'; export { hasContentWarnings, nextAutomationContent } from './src/shared/automations'"
    const mocks = { electron: fakeElectron(dir).electron }
    let main = loadMain(source, mocks)
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [created] = main.automations.createAutomation('Queue')
    await main.automations.addAutomationContent(created.id, [clip, clip, clip])
    const dataFile = path.join(dir, 'userData', fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-.*\.json$/.test(name)))
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    const [a, b, held] = saved.automations[0].content
    for (const item of [a, b, held]) item.metadataError = 'Previous writing failure'
    held.status = 'needs_review'; held.error = 'Check the previous post'
    fs.writeFileSync(dataFile, JSON.stringify(saved))
    main = loadMain(source, mocks)
    assert.throws(() => main.automations.dismissAutomationMetadataError(created.id, 'missing'), /Clip not found/)
    main.automations.dismissAutomationMetadataError(created.id, a.id)
    main.automations.dismissAutomationMetadataError(created.id, held.id)
    const damaged = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    damaged.automations[0].content[1].metadataErrorAcknowledged = 'yes'
    fs.writeFileSync(dataFile, JSON.stringify(damaged))
    main = loadMain(source, mocks)
    const [bank] = main.automations.listAutomations()
    assert.deepEqual(bank.content[0], { ...a, metadataErrorAcknowledged: true })
    assert.deepEqual(bank.content[1], b, 'invalid optional acknowledgement is dropped without losing the clip or hiding its error')
    assert.deepEqual(bank.content[2], { ...held, metadataErrorAcknowledged: true })
    assert.equal(main.hasContentWarnings(bank.content[0]), false)
    assert.equal(main.hasContentWarnings(bank.content[1]), true)
    assert.equal(main.hasContentWarnings(bank.content[2]), true, 'posting warning stays visible')
    assert.equal(main.nextAutomationContent(bank).id, a.id, 'dismissal does not change posting eligibility')
    // Missing media makes a retry fail before any network request.
    const banks = path.join(dir, 'userData', 'automation-bank')
    const [workspace] = fs.readdirSync(banks)
    fs.unlinkSync(path.join(banks, workspace, created.id, a.fileName))
    const retry = await main.automations.enhanceAutomationBatch(created.id, [a.id], `clip:${a.id}`)
    assert.equal(retry.errors.length, 1)
    assert.equal(retry.automations[0].content[0].metadataErrorAcknowledged, false)
    assert.equal(main.hasContentWarnings(retry.automations[0].content[0]), true)
  } finally { cleanup() }
})

test('warnings can be acknowledged individually or across banks, persist, and preserve held clips', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-acknowledge-')
  try {
    const library = path.join(dir, 'library')
    fs.mkdirSync(library)
    const clip = path.join(library, 'clip.mp4')
    fs.writeFileSync(clip, 'test media')
    const source = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'; export { hasAutomationWarnings, nextAutomationContent } from './src/shared/automations'"
    const mocks = { electron: fakeElectron(dir).electron }
    const initial = loadMain(source, mocks)
    initial.settings.replaceApiKey('zernioApiKey', KEY)
    initial.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    for (const name of ['First', 'Second']) {
      const [automation] = initial.automations.createAutomation(name)
      await initial.automations.addAutomationContent(automation.id, [clip])
    }
    const dataFile = path.join(dir, 'userData', fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-.*\.json$/.test(name)))
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    for (const automation of saved.automations) {
      automation.lastError = 'Previous upload failed'
      automation.content[0].status = 'needs_review'
      automation.content[0].error = 'Verify the previous post'
      automation.content[0].metadataError = 'Previous writing failure'
    }
    fs.writeFileSync(dataFile, JSON.stringify(saved))
    const main = loadMain(source, mocks)
    const [first, second] = main.automations.listAutomations()
    assert.throws(() => main.automations.acknowledgeAutomationWarnings(undefined), /Invalid automation/)
    assert.throws(() => main.automations.acknowledgeAutomationWarnings('../all'), /Invalid automation/)
    assert.throws(() => main.automations.acknowledgeAutomationWarnings(null, first.content[0].id), /Choose a clip/)
    assert.throws(() => main.automations.acknowledgeAutomationWarnings(first.id, second.content[0].id), /Clip not found/)
    const dismissed = main.automations.acknowledgeAutomationWarnings(first.id, first.content[0].id)
    assert.equal(dismissed[0].content[0].warningsAcknowledged, true)
    assert.equal(dismissed[0].content[0].status, 'needs_review', 'dismissal does not release held clips')
    assert.equal(dismissed[0].lastErrorAcknowledged, undefined, 'per-clip dismissal leaves run history alone')
    assert.equal(dismissed[1].content[0].warningsAcknowledged, undefined, 'other clips stay visible')
    const one = main.automations.acknowledgeAutomationWarnings(first.id)
    assert.equal(main.hasAutomationWarnings(one[0]), false)
    assert.equal(main.hasAutomationWarnings(one[1]), true, 'individual acknowledgement leaves other banks alone')
    main.automations.acknowledgeAutomationWarnings(null)
    const reloaded = loadMain(source, mocks)
    for (const automation of reloaded.automations.listAutomations()) {
      assert.equal(reloaded.hasAutomationWarnings(automation), false)
      assert.equal(automation.lastError, 'Previous upload failed', 'history remains available')
      assert.equal(automation.content[0].error, 'Verify the previous post')
      assert.equal(automation.content[0].metadataError, 'Previous writing failure')
      assert.equal(automation.content[0].status, 'needs_review')
      assert.equal(reloaded.nextAutomationContent(automation), undefined, 'acknowledgement never releases a held clip')
    }
    assert.equal(reloaded.automations.listAutomations()[1].id, second.id)
    const returned = await reloaded.automations.reviewAutomationContent(first.id, first.content[0].id, true)
    assert.equal(returned.outcome, 'queued')
    assert.equal(returned.automations[0].content[0].status, 'queued')
    assert.ok(returned.automations[0].content[0].postingAttemptId)
    const malformed = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    malformed.automations[0].lastErrorAcknowledged = 'yes'
    fs.writeFileSync(dataFile, JSON.stringify(malformed))
    assert.throws(() => loadMain(source, mocks).automations.listAutomations(), /preserved for recovery/)
  } finally { cleanup() }
})

test('library clips can be copied to a bank only from their saved run', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-library-bank-')
  try {
    const library = path.join(dir, 'library')
    const run = path.join(library, 'run-one')
    fs.mkdirSync(run, { recursive: true })
    const clip = path.join(run, 'clip_00.mp4')
    const outside = path.join(library, 'outside.mp4')
    fs.writeFileSync(clip, 'clip bytes')
    fs.writeFileSync(outside, 'outside bytes')
    const manifest = (source) => ({ clips: [{ clip_index: 0, s3_url: `file://${source}`, duration_ms: 1000,
      start_time_ms: 0, end_time_ms: 1000, virality_score: 0.8, summary: 'A useful clip' }] })
    fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(manifest(clip)))
    const main = loadMain("export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3',  })
    const [automation] = main.automations.createAutomation('My bank')

    await main.automations.addLibraryClipsToAutomation(automation.id, run, [0])
    const [added] = main.automations.listAutomations()
    assert.equal(added.content.length, 1)
    assert.equal(added.content[0].title, 'A useful clip')
    assert.equal(added.content[0].status, 'queued')
    assert.deepEqual(fs.readFileSync(clip), Buffer.from('clip bytes'), 'the source remains in the run')
    await assert.rejects(main.automations.addLibraryClipsToAutomation(automation.id, run, [1]), /no longer in this run/)
    await assert.rejects(main.automations.addLibraryClipsToAutomation(automation.id, run, [0, 0]), /unique clips/)

    fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(manifest(outside)))
    await assert.rejects(main.automations.addLibraryClipsToAutomation(automation.id, run, [0]), /outside this run/)
    assert.equal(main.automations.listAutomations()[0].content.length, 1)
  } finally { cleanup() }
})

test('automation imports require prior media authorization for files outside the library', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-bank-authorization-')
  try {
    const library = path.join(dir, 'library')
    const outside = path.join(dir, 'private.mp4')
    fs.mkdirSync(library)
    fs.writeFileSync(outside, 'private media')
    const main = loadMain("export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'; export * as security from './src/main/security'", { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3', customVocabulary: '' })
    const [automation] = main.automations.createAutomation('Authorized imports')

    await assert.rejects(main.automations.addAutomationContent(automation.id, [outside]), /outside the library/)
    assert.equal(main.automations.listAutomations()[0].content.length, 0)
    main.security.authorizeMedia(outside)
    await main.automations.addAutomationContent(automation.id, [outside])
    assert.equal(main.automations.listAutomations()[0].content.length, 1)
  } finally { cleanup() }
})

test('a failed batch import leaves no copied clips to duplicate on retry', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-bank-batch-')
  try {
    const library = path.join(dir, 'library')
    fs.mkdirSync(library)
    const clip = path.join(library, 'clip.mp4')
    const unsupported = path.join(library, 'notes.txt')
    fs.writeFileSync(clip, 'clip bytes')
    fs.writeFileSync(unsupported, 'not a clip')
    const main = loadMain("export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'; export { workspaceId } from './src/main/zernio/workspace-cache'", { electron: fakeElectron(dir).electron })
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3', customVocabulary: '' })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    const [automation] = main.automations.createAutomation('Batch import')
    await assert.rejects(main.automations.addAutomationContent(automation.id, [clip, unsupported]), /Invalid media path/)
    assert.equal(main.automations.listAutomations()[0].content.length, 0)
    const bank = path.join(dir, 'userData', 'automation-bank', main.workspaceId(KEY), automation.id)
    assert.deepEqual(fs.readdirSync(bank), [])
    await main.automations.addAutomationContent(automation.id, [clip])
    assert.equal(main.automations.listAutomations()[0].content.length, 1)
  } finally { cleanup() }
})

test('a key switch during an automation import cannot overwrite the old workspace', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-bank-key-switch-')
  try {
    const library = path.join(dir, 'library')
    fs.mkdirSync(library)
    const clip = path.join(library, 'clip.mp4')
    fs.writeFileSync(clip, 'clip bytes')
    const main = loadMain("export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'; export { workspaceId } from './src/main/zernio/workspace-cache'", { electron: fakeElectron(dir).electron })
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3', customVocabulary: '' })
    main.settings.replaceApiKey('zernioApiKey', 'old-workspace-key')
    const [oldAutomation] = main.automations.createAutomation('Old workspace')
    const oldFile = path.join(dir, 'userData', `automations-${main.workspaceId('old-workspace-key')}.json`)
    const oldContents = fs.readFileSync(oldFile, 'utf8')

    const pendingImport = main.automations.addAutomationContent(oldAutomation.id, [clip])
    main.settings.replaceApiKey('zernioApiKey', 'new-workspace-key')
    const [newAutomation] = main.automations.createAutomation('New workspace')
    const newFile = path.join(dir, 'userData', `automations-${main.workspaceId('new-workspace-key')}.json`)
    const newContents = fs.readFileSync(newFile, 'utf8')

    await assert.rejects(pendingImport, /workspace changed|Automation changed/)
    assert.equal(fs.readFileSync(oldFile, 'utf8'), oldContents)
    assert.equal(fs.readFileSync(newFile, 'utf8'), newContents)
    main.settings.replaceApiKey('zernioApiKey', 'old-workspace-key')
    assert.equal(main.automations.listAutomations()[0].id, oldAutomation.id)
    main.settings.replaceApiKey('zernioApiKey', 'new-workspace-key')
    assert.equal(main.automations.listAutomations()[0].id, newAutomation.id)
  } finally { cleanup() }
})

test('an upload failure keeps an automation clip retryable without creating a post', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automation-upload-')
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  const previousPath = process.env.PATH
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  process.env.PATH = `${previousPath}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  try {
    const library = path.join(dir, 'library')
    const clip = makeClip(path.join(library, 'clip.mp4'))
    const { electron } = fakeElectron(dir)
    const source = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"
    const main = loadMain(source, { electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3',  })
    const [profile] = mock.state.profiles
    const youtube = mock.addAccount('youtube', profile._id)
    const [created] = main.automations.createAutomation('Retryable bank')
    await main.automations.updateAutomation(created.id, {
      name: created.name, enabled: false, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: [],
      youtubeVisibility: 'unlisted', youtubeMadeForKids: false,
      accounts: [{ platform: 'youtube', accountId: youtube._id }]
    })
    await main.automations.addAutomationContent(created.id, [clip])
    posting.state.failNextUpload = 503
    const [failed] = await main.automations.runAutomation(created.id)
    assert.equal(failed.content[0].status, 'queued')
    assert.equal(failed.content[0].postId, null)
    assert.equal(posting.state.creates.length, 0)

    const dataFile = fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-[a-f0-9]{64}\.json$/.test(name))
    const dataPath = path.join(dir, 'userData', dataFile)
    const saved = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    saved.automations[0].content[0].status = 'needs_review'
    saved.automations[0].content[0].error = 'The upload was interrupted. Check your connection and try again.'
    fs.writeFileSync(dataPath, JSON.stringify(saved))
    const restarted = loadMain(source, { electron })
    assert.equal(restarted.automations.listAutomations()[0].content[0].status, 'queued', 'old pre-submit failures recover on restart')
    const fresh = makeClip(path.join(library, 'fresh.mp4'), 'red')
    const later = makeClip(path.join(library, 'later.mp4'), 'green')
    await restarted.automations.addAutomationContent(created.id, [fresh, later])
    const [skipped] = await restarted.automations.runAutomation(created.id)
    assert.equal(skipped.content[0].status, 'queued', 'Run now tries a fresh clip before the failed one')
    assert.equal(skipped.content[1].status, 'posted')
    const failedId = skipped.content[0].id
    restarted.automations.acknowledgeAutomationWarnings(created.id, failedId)
    let [dismissed] = loadMain(source, { electron }).automations.listAutomations()
    assert.equal(dismissed.content[0].warningsAcknowledged, true, 'per-clip dismissal survives restart')
    assert.equal(dismissed.content[0].error, skipped.content[0].error, 'dismissal preserves error history')
    assert.equal(dismissed.content[0].status, 'queued')
    posting.state.failNextUpload = 503
    const [failedAgain] = await restarted.automations.retryAutomationContent(created.id, failedId)
    assert.equal(failedAgain.content[0].warningsAcknowledged, false, 'a new failure warns again')
    assert.equal(failedAgain.content[2].status, 'queued', 'retry does not consume a different queued clip')
    const [posted] = await restarted.automations.retryAutomationContent(created.id, failedId)
    assert.equal(posted.content[0].status, 'posted')
    assert.equal(posted.content[2].status, 'queued')
    assert.equal(posted.content[0].error, null)
    assert.equal(posting.state.creates.length, 2)
    await assert.rejects(restarted.automations.retryAutomationContent(created.id, failedId), /failed, unposted queued/)
    await assert.rejects(restarted.automations.retryAutomationContent(created.id, posted.content[2].id), /failed, unposted queued/)
    await assert.rejects(restarted.automations.retryAutomationContent(created.id, 'missing'), /failed, unposted queued/)
    assert.equal(posting.state.creates.length, 2, 'invalid retries never publish')
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    process.env.PATH = previousPath
    await mock.close()
    cleanup()
  }
})

test('a reviewed uncertain post can return to the queue after its replay window expires', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automation-reviewed-retry-')
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  const previousPath = process.env.PATH
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  process.env.PATH = `${previousPath}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  const realNow = Date.now
  try {
    const library = path.join(dir, 'library')
    const clip = makeClip(path.join(library, 'clip.mp4'))
    const main = loadMain("export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [profile] = mock.state.profiles
    const youtube = mock.addAccount('youtube', profile._id)
    const [created] = main.automations.createAutomation('Reviewed retry')
    await main.automations.updateAutomation(created.id, {
      name: created.name, enabled: false, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: [],
      youtubeVisibility: 'unlisted', youtubeMadeForKids: false,
      accounts: [{ platform: 'youtube', accountId: youtube._id }]
    })
    await main.automations.addAutomationContent(created.id, [clip])
    for (let i = 0; i < 3; i++) mock.failNext('POST', '/api/v1/posts', 500, { error: 'temporary failure' })
    const [uncertain] = await main.automations.runAutomation(created.id)
    assert.equal(uncertain.content[0].status, 'needs_review')
    await main.automations.runAutomation(created.id)
    assert.equal(mock.requestsTo('POST', '/api/v1/posts').length, 3, 'uncertain posts never retry automatically')
    const oldAttemptId = uncertain.content[0].id
    const journal = path.join(dir, 'userData', `zernio-post-attempts-${require('node:crypto').createHash('sha256').update(KEY).digest('hex')}.json`)
    assert.ok(JSON.parse(fs.readFileSync(journal, 'utf8')).attempts.some(([id]) => id === oldAttemptId))

    Date.now = () => realNow() + 5 * 60_000
    const [requeued] = main.automations.updateAutomationContent(created.id, oldAttemptId, {
      title: uncertain.content[0].title, caption: 'Reviewed and ready', returnToQueue: true
    })
    assert.equal(requeued.content[0].status, 'queued')
    assert.notEqual(requeued.content[0].postingAttemptId, oldAttemptId)
    const restarted = loadMain("export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
    assert.equal(restarted.automations.listAutomations()[0].content[0].postingAttemptId, requeued.content[0].postingAttemptId)
    const [posted] = await restarted.automations.runAutomation(created.id)
    assert.equal(posted.content[0].status, 'posted')
    assert.equal(posting.state.posts.size, 1)
    assert.ok(JSON.parse(fs.readFileSync(journal, 'utf8')).attempts.some(([id]) => id === oldAttemptId), 'the uncertain attempt stays in the audit journal')
  } finally {
    Date.now = realNow
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    process.env.PATH = previousPath
    await mock.close()
    cleanup()
  }
})

test('generated copy enforces platform fields, X weights and grounded Threads topics', () => {
  const { dir, cleanup } = tempDir('bridgeclip-metadata-')
  try {
    const { parseGeneratedMetadata } = loadMain("export { parseGeneratedMetadata } from './src/main/automation-metadata'", { electron: fakeElectron(dir).electron })
    const transcript = 'Building reliable automations starts with accurate transcripts.'
    const base = { caption: 'Accurate transcripts make reliable automations.', title: null, tags: [], categoryId: null, topicTag: null, evidence: 'accurate transcripts' }
    const parse = (post, context) => parseGeneratedMetadata({ posts: [post] }, [post.platform], transcript, context)
    assert.equal(parse({ ...base, platform: 'twitter', caption: '界'.repeat(140) })[0].caption.length, 140)
    assert.throws(() => parse({ ...base, platform: 'twitter', caption: '界'.repeat(141) }), /standard length/)
    assert.throws(() => parse({ ...base, platform: 'instagram', caption: 'A clear point #one #two #three #four' }), /hashtag budget/)
    assert.equal(parse({ ...base, platform: 'threads', topicTag: 'automations' })[0].topicTag, 'automations')
    assert.throws(() => parse({ ...base, platform: 'threads', topicTag: 'unmentioned' }), /not grounded/)
    assert.equal(parse({ ...base, platform: 'facebook', title: 'Accurate transcripts' }, { facebookFormat: 'reel' })[0].title, 'Accurate transcripts')
    assert.deepEqual(parse({ ...base, platform: 'facebook', title: 'Accurate transcripts' }, { facebookFormat: 'feed' })[0],
      { platform: 'facebook', caption: base.caption, title: null, tags: [], categoryId: null, topicTag: null }, 'feed videos discard unused titles')
    assert.equal(parse({ ...base, platform: 'youtube', title: 'Accurate transcripts', categoryId: '24' })[0].categoryId, '24')
    assert.throws(() => parse({ ...base, platform: 'youtube', title: 'Accurate transcripts', tags: ['x '.repeat(249), 'a'], categoryId: '28' }), /YouTube fields/)
    assert.equal(parseGeneratedMetadata({ posts: [{ ...base, platform: 'instagram', evidence: 'GPT 4 1 is faster and costs less' }] },
      ['instagram'], 'GPT-4.1 is faster, and costs less.')[0].platform, 'instagram', 'punctuation does not change spoken evidence')
  } finally { cleanup() }
})

test('grounding accepts quotes that tidy spoken stutters but rejects changed or stitched words', () => {
  const { dir, cleanup } = tempDir('bridgeclip-evidence-')
  try {
    const { evidenceInTranscript } = loadMain("export { evidenceInTranscript } from './src/main/automation-metadata'", { electron: fakeElectron(dir).electron })
    // The transcript of the clip whose Facebook metadata failed verification on every run.
    const transcript = "Where is this all going? Anyone can do anything related to software, right, for cheap. I feel like very few great new apps, sites have been created from AI. Am I wrong? Everything that you're seeing now in today's world is created with AI. I don't think that a lot of people that are like, even if you look at some of the, like, leading, like, think about leading companies. What do you think, do you think their engineers are still coding by hand? No, everybody's using AI. Most products that you see now are, are, I think, I don't know what the, the, like, I think a couple months ago, didn't Google say that, like, 80% of their code was written by AI now? Probably not using a Gemini model, but, you know, you guys get the point. It's like everything that you see now is pretty much AI anyway, so."
    for (const evidence of [
      "Everything that you're seeing now in today's world is created with AI",
      'Most products that you see now are, I think',
      'if you look at some of the leading',
      "didn't Google say that 80 percent of their code was written by AI",
      'Do you think their engineers are still coding by hand? No, everybody’s using AI.',
      'I, um, feel like very few great new apps'
    ]) assert.equal(evidenceInTranscript(evidence, transcript), true, evidence)
    for (const evidence of [
      'Google said 80% of their code was written by AI',
      'if you look at some of the leading companies',
      'everybody is coding by hand',
      'Most products that you see now are created with AI'
    ]) assert.equal(evidenceInTranscript(evidence, transcript), false, evidence)
    assert.equal(evidenceInTranscript('I think this is good', 'I do not think this is good.'), false, 'a dropped negation is not a stutter')
    assert.equal(evidenceInTranscript('I was crazy', 'I was, I was crazy'), true, 'a restarted phrase is')
  } finally { cleanup() }
})

test('a clip that failed to prepare waits behind clips that have not', () => {
  const { dir, cleanup } = tempDir('bridgeclip-next-clip-')
  try {
    const { nextAutomationContent } = loadMain("export { nextAutomationContent } from './src/shared/automations'", { electron: fakeElectron(dir).electron })
    const clip = (id, status, error = null) => ({ id, status, error, tiktokApproval: null })
    const automation = { accounts: [{ accountId: 'fb', platform: 'facebook' }],
      content: [clip('posted', 'posted'), clip('stuck', 'queued', 'AI metadata for facebook was not grounded in the transcript. The clip was not posted.'), clip('fresh', 'queued')] }
    assert.equal(nextAutomationContent(automation).id, 'fresh')
    automation.content[2].status = 'posted'
    assert.equal(nextAutomationContent(automation).id, 'stuck', 'it is retried once nothing else is ready')
  } finally { cleanup() }
})

test('AI metadata retries ungrounded and invalid model responses before accepting them', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automation-retry-')
  const transcript = 'Building reliable automations starts with accurate transcripts.'
  let requests = 0
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: [{
    method: 'POST', path: '/chat/completions', auth: false, handler: (ctx) => {
      requests++
      const post = { platform: 'instagram', caption: requests === 3 ? 'Visit https://invalid.example' : 'Accurate transcripts help build reliable automations.',
        title: null, tags: [], categoryId: null, topicTag: null,
        evidence: requests === 1 ? 'A phrase absent from the transcript' : 'accurate transcripts' }
      return ctx.json(200, { choices: [{ message: { content: JSON.stringify({ posts: [post] }) } }] })
    }
  }] })
  const previousUrl = process.env.BRIDGECLIP_E2E_OPENROUTER_URL
  process.env.BRIDGECLIP_E2E_OPENROUTER_URL = `${mock.url}/chat/completions`
  try {
    const main = loadMain("export { generateAutomationMetadata } from './src/main/automation-metadata'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
    main.settings.replaceApiKey('openrouterApiKey', 'test-openrouter-key')
    const posts = await main.generateAutomationMetadata(transcript, 'Reliable automations', '', ['instagram'])
    assert.equal(requests, 2)
    assert.equal(posts[0].platform, 'instagram')
    assert.equal(posts[0].caption, 'Accurate transcripts help build reliable automations.')
    const second = await main.generateAutomationMetadata(transcript, 'Reliable automations', '', ['instagram'])
    assert.equal(requests, 4, 'a used-field validation error also gets one repair attempt')
    assert.equal(second[0].caption, 'Accurate transcripts help build reliable automations.')
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_E2E_OPENROUTER_URL
    else process.env.BRIDGECLIP_E2E_OPENROUTER_URL = previousUrl
    await mock.close()
    cleanup()
  }
})

test('bank clips publish once to selected accounts and keep their used state after restart', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automations-')
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  const previousPath = process.env.PATH
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  process.env.PATH = `${previousPath}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  try {
    const library = path.join(dir, 'library')
    const clip = makeClip(path.join(library, 'clip_01.mp4'))
    const { electron } = fakeElectron(dir)
    const source = `
      export * as automations from './src/main/automations'
      export * as settings from './src/main/settings-store'
    `
    const main = loadMain(source, { electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3',  })
    const [profile] = mock.state.profiles
    const otherProfile = mock.addProfile('Other profile')
    const youtube = mock.addAccount('youtube', profile._id, { username: 'channel' })
    const instagram = mock.addAccount('instagram', profile._id, { username: 'creator' })
    const otherAccount = mock.addAccount('twitter', otherProfile._id, { username: 'other' })

    const [created] = main.automations.createAutomation('BridgeMind')
    const update = { name: 'BridgeMind', enabled: true, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: ['12:00'], youtubeVisibility: 'unlisted', youtubeMadeForKids: false, accounts: [
      { platform: 'youtube', accountId: youtube._id }, { platform: 'instagram', accountId: instagram._id }
    ] }
    await assert.rejects(main.automations.updateAutomation(created.id, { ...update, accounts: [...update.accounts, { platform: 'twitter', accountId: otherAccount._id }] }), /no longer in this Zernio profile/)
    await main.automations.updateAutomation(created.id, update)
    await main.automations.addAutomationContent(created.id, [clip])
    const before = main.automations.listAutomations()[0]
    assert.equal(before.content[0].status, 'queued')
    const bankFile = path.join(dir, 'userData', 'automation-bank', fs.readdirSync(path.join(dir, 'userData', 'automation-bank'))[0], created.id, before.content[0].fileName)
    assert.deepEqual(fs.readFileSync(bankFile), fs.readFileSync(clip))

    instagram.profileId = { _id: otherProfile._id, name: otherProfile.name }
    const [blocked] = await main.automations.runAutomation(created.id)
    assert.equal(blocked.content[0].status, 'queued', 'a profile mismatch does not consume the clip')
    assert.equal(posting.state.creates.length, 0)
    main.automations.acknowledgeAutomationWarnings(created.id)
    const [repeatedFailure] = await main.automations.runAutomation(created.id)
    assert.equal(repeatedFailure.lastError, blocked.lastError)
    assert.equal(repeatedFailure.lastErrorAcknowledged, false, 'the same failure on a new attempt warns again')
    assert.equal(repeatedFailure.content[0].warningsAcknowledged, false)
    instagram.profileId = { _id: profile._id, name: profile.name }

    const [after] = await main.automations.runAutomation(created.id)
    assert.equal(after.content[0].status, 'posted')
    assert.ok(after.content[0].postId)
    assert.equal(posting.state.uploads.length, 1)
    assert.equal(posting.state.creates.length, 1)
    assert.deepEqual(posting.state.creates[0].body.platforms.map((target) => target.platform), ['youtube', 'instagram'])
    assert.equal(posting.state.creates[0].body.platforms[0].platformSpecificData.visibility, 'unlisted')

    await main.automations.runAutomation(created.id)
    assert.equal(posting.state.creates.length, 1, 'a used clip never posts again')
    const dataFile = fs.readdirSync(path.join(dir, 'userData')).find((name) => /^automations-[a-f0-9]{64}\.json$/.test(name))
    const dataPath = path.join(dir, 'userData', dataFile)
    const legacy = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    legacy.version = 1
    delete legacy.automations[0].profileId
    fs.writeFileSync(dataPath, JSON.stringify(legacy))
    const restarted = loadMain(source, { electron })
    assert.equal(restarted.automations.listAutomations()[0].content[0].status, 'posted')
    assert.equal(restarted.automations.listAutomations()[0].profileId, profile._id, 'a single-profile legacy bank keeps its accounts')
    assert.equal(restarted.automations.listAutomations()[0].metadataMode, 'manual', 'legacy automations keep their existing posting behavior')
    await restarted.automations.runAutomation(created.id)
    assert.equal(posting.state.creates.length, 1, 'restart cannot reuse the posted clip')

    const second = makeClip(path.join(library, 'clip_02.mp4'), 'red')
    await restarted.automations.addAutomationContent(created.id, [second])
    posting.state.nextPublish.instagram = { status: 'failed', errorMessage: 'Platform unavailable' }
    const [partial] = await restarted.automations.runAutomation(created.id)
    assert.equal(partial.content[1].status, 'needs_review')
    restarted.automations.acknowledgeAutomationWarnings(created.id)
    assert.equal(restarted.automations.listAutomations()[0].content[1].status, 'needs_review')
    assert.ok(partial.content[1].postId, 'the partial post is linked for review')
    assert.equal((await restarted.automations.reviewAutomationContent(created.id, partial.content[1].id, true)).outcome, 'held', 'partial posts cannot be queued for duplicate publishing')
    assert.throws(() => restarted.automations.updateAutomationContent(created.id, partial.content[1].id, {
      title: partial.content[1].title, caption: 'Must not be saved', returnToQueue: true
    }), /Open Posts/)
    assert.equal(restarted.automations.listAutomations()[0].content[1].caption, partial.content[1].caption,
      'a rejected return does not change the clip in memory')
    await restarted.automations.runAutomation(created.id)
    assert.equal(posting.state.creates.length, 2, 'a partial post is never retried silently')

    const third = makeClip(path.join(library, 'clip_03.mp4'), 'yellow')
    await restarted.automations.addAutomationContent(created.id, [third])
    const saved = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    saved.automations[0].content[2].status = 'posting'
    fs.writeFileSync(dataPath, JSON.stringify(saved))
    const recovered = loadMain(source, { electron })
    assert.equal(recovered.automations.listAutomations()[0].content[2].status, 'needs_review')
    assert.equal(posting.state.creates.length, 2, 'an interrupted post needs review before retry')
    const previousFormat = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    previousFormat.version = 2
    delete previousFormat.automations[0].metadataMode
    for (const content of previousFormat.automations[0].content) {
      delete content.transcript
      delete content.generatedMetadata
    }
    fs.writeFileSync(dataPath, JSON.stringify(previousFormat))
    const upgraded = loadMain(source, { electron }).automations.listAutomations()[0]
    assert.equal(upgraded.metadataMode, 'manual')
    assert.equal(upgraded.content.length, 3, 'the version-2 bank survives the metadata migration')
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    process.env.PATH = previousPath
    await mock.close()
    cleanup()
  }
})

test('AI automation transcribes the bank clip and sends distinct grounded metadata to each platform', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automation-ai-')
  const posting = createPostingMock()
  const transcript = 'Building reliable automations starts with accurate transcripts.'
  const metadata = { posts: [
    { platform: 'youtube', caption: 'Building reliable automations starts with accurate transcripts. Here is why speech recognition matters.', title: 'Why Accurate Transcripts Matter for Automations', tags: ['automations', 'transcription'], categoryId: '28', topicTag: null, evidence: 'Building reliable automations starts with accurate transcripts.' },
    { platform: 'instagram', caption: 'Accurate transcripts help build reliable automations. #Automation #Transcription', title: 'Unused model title', tags: ['unused'], categoryId: '28', topicTag: 'unused', evidence: 'accurate transcripts' },
    { platform: 'facebook', caption: 'Accurate transcripts are the foundation for reliable automations.', title: 'Why accurate transcripts matter', tags: [], categoryId: null, topicTag: null, evidence: 'accurate transcripts' },
    { platform: 'threads', caption: 'Accurate transcripts make automations more reliable. What step matters most to you?', title: null, tags: [], categoryId: null, topicTag: 'automations', evidence: 'reliable automations' }
  ] }
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: [
    ...posting.routes,
    { method: 'POST', path: '/speech-to-text', auth: false, handler: (ctx) => {
      assert.equal(ctx.req.headers.authorization, 'Bearer test-openrouter-key')
      assert.equal(ctx.req.headers['xi-api-key'], undefined)
      assert.equal(ctx.body.model, 'microsoft/mai-transcribe-2')
      assert.equal(ctx.body.response_format, 'verbose_json')
      assert.equal(ctx.body.input_audio.format, 'wav')
      const audio = Buffer.from(ctx.body.input_audio.data, 'base64')
      assert.equal(audio.toString('ascii', 0, 4), 'RIFF')
      assert.equal(audio.toString('ascii', 8, 12), 'WAVE')
      ctx.json(200, { text: transcript })
    } },
    { method: 'POST', path: '/chat/completions', auth: false, handler: (ctx) => ctx.json(200, { choices: [{ message: { content: JSON.stringify(metadata) } }] }) }
  ] })
  const previous = {
    zernio: process.env.BRIDGECLIP_ZERNIO_API_URL,
    transcription: process.env.BRIDGECLIP_E2E_TRANSCRIPTION_URL,
    openrouter: process.env.BRIDGECLIP_E2E_OPENROUTER_URL,
    path: process.env.PATH
  }
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  process.env.BRIDGECLIP_E2E_TRANSCRIPTION_URL = `${mock.url}/speech-to-text`
  process.env.BRIDGECLIP_E2E_OPENROUTER_URL = `${mock.url}/chat/completions`
  process.env.PATH = `${previous.path}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  try {
    const library = path.join(dir, 'library')
    const clip = makeClip(path.join(library, 'speech.mp4'))
    const { electron } = fakeElectron(dir)
    const main = loadMain(`export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'`, { electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.replaceApiKey('openrouterApiKey', 'test-openrouter-key')
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3',  })
    const [profile] = mock.state.profiles
    const youtube = mock.addAccount('youtube', profile._id)
    const instagram = mock.addAccount('instagram', profile._id)
    const facebook = mock.addAccount('facebook', profile._id)
    const threads = mock.addAccount('threads', profile._id)
    const [created] = main.automations.createAutomation('Grounded posts')
    await main.automations.updateAutomation(created.id, {
      name: created.name, enabled: true, profileId: profile._id, metadataMode: 'ai', timezone: 'UTC', times: ['12:00'],
      youtubeVisibility: 'unlisted', youtubeMadeForKids: false,
      accounts: [{ platform: 'youtube', accountId: youtube._id }, { platform: 'instagram', accountId: instagram._id },
        { platform: 'facebook', accountId: facebook._id }, { platform: 'threads', accountId: threads._id }]
    })
    await main.automations.addAutomationContent(created.id, [clip])
    const [posted] = await main.automations.runAutomation(created.id)
    assert.equal(posted.content[0].status, 'posted')
    assert.equal(posted.content[0].transcript, transcript)
    assert.equal(posted.content[0].generatedMetadata.length, 4)
    assert.deepEqual(posted.content[0].generatedMetadata[1], {
      platform: 'instagram', caption: metadata.posts[1].caption, title: null, tags: [], categoryId: null, topicTag: null
    }, 'unsupported Instagram fields are discarded before saving or posting')
    const body = posting.state.creates[0].body
    assert.equal(body.platforms[0].customContent, metadata.posts[0].caption)
    assert.equal(body.platforms[1].customContent, metadata.posts[1].caption)
    assert.equal(body.platforms[0].platformSpecificData.title, metadata.posts[0].title)
    assert.equal(body.platforms[0].platformSpecificData.categoryId, '28')
    assert.deepEqual(body.tags, metadata.posts[0].tags)
    assert.equal(body.platforms[2].customContent, metadata.posts[2].caption)
    assert.deepEqual(body.platforms[2].platformSpecificData, { contentType: 'reel', title: metadata.posts[2].title })
    assert.equal(body.platforms[3].customContent, metadata.posts[3].caption)
    assert.deepEqual(body.platforms[3].platformSpecificData, { topic_tag: 'automations' })
    const restarted = loadMain(`export * as automations from './src/main/automations'`, { electron })
    assert.equal(restarted.automations.listAutomations()[0].content[0].generatedMetadata[0].title, metadata.posts[0].title)
    const second = makeClip(path.join(library, 'another_speech.mp4'), 'red')
    await main.automations.addAutomationContent(created.id, [second])
    metadata.posts[1].evidence = 'This sentence is not in the transcript.'
    const [blocked] = await main.automations.runAutomation(created.id)
    assert.equal(blocked.content[1].status, 'queued', 'unverified AI output does not consume the clip')
    assert.match(blocked.lastError, /not grounded in the transcript/)
    assert.equal(posting.state.creates.length, 1, 'unverified AI output never reaches Zernio')
  } finally {
    for (const [name, value] of Object.entries({
      BRIDGECLIP_ZERNIO_API_URL: previous.zernio,
      BRIDGECLIP_E2E_TRANSCRIPTION_URL: previous.transcription,
      BRIDGECLIP_E2E_OPENROUTER_URL: previous.openrouter,
      PATH: previous.path
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await mock.close()
    cleanup()
  }
})

test('TikTok automations require per-clip review, preserve approved copy, and publish once per slot', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-automation-tiktok-')
  const posting = createPostingMock()
  let generations = 0
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: [
    ...posting.routes,
    { method: 'POST', path: '/speech', auth: false, handler: (ctx) => ctx.json(200, { text: 'Accurate transcripts make reliable automations.' }) },
    { method: 'POST', path: '/metadata', auth: false, handler: (ctx) => {
      generations++
      const input = JSON.parse(ctx.body.messages[1].content)
      ctx.json(200, { choices: [{ message: { content: JSON.stringify({ posts: input.platforms.map(({ platform }) => ({
        platform, caption: 'Accurate transcripts make reliable automations.', title: null, tags: [], categoryId: null, topicTag: null,
        evidence: 'Accurate transcripts make reliable automations.'
      })) }) } }] })
    } }
  ] })
  const environment = {
    BRIDGECLIP_ZERNIO_API_URL: mock.apiUrl,
    BRIDGECLIP_E2E_TRANSCRIPTION_URL: `${mock.url}/speech`,
    BRIDGECLIP_E2E_OPENROUTER_URL: `${mock.url}/metadata`,
    PATH: `${process.env.PATH}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  }
  const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]))
  Object.assign(process.env, environment)
  try {
    const library = path.join(dir, 'library')
    const clip = makeClip(path.join(library, 'clip.mp4'))
    const { electron } = fakeElectron(dir)
    const source = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"
    const main = loadMain(source, { electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.replaceApiKey('openrouterApiKey', 'test-openrouter-key')
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [profile] = mock.state.profiles
    const tiktok = mock.addAccount('tiktok', profile._id)
    const instagram = mock.addAccount('instagram', profile._id)
    const [created] = main.automations.createAutomation('TikTok queue')
    const update = { name: created.name, enabled: true, profileId: profile._id, metadataMode: 'ai', timezone: 'UTC', times: ['12:00', '13:00'],
      youtubeVisibility: 'public', youtubeMadeForKids: false,
      accounts: [{ platform: 'tiktok', accountId: tiktok._id }, { platform: 'instagram', accountId: instagram._id }] }
    await main.automations.updateAutomation(created.id, update)
    const [bank] = await main.automations.addAutomationContent(created.id, [clip, clip])
    const [first, second] = bank.content
    const [waiting] = await main.automations.runAutomation(created.id)
    assert.match(waiting.lastError, /Review a queued clip for TikTok/)
    assert.equal(posting.state.uploads.length, 0)
    assert.equal(generations, 0, 'unapproved clips do not generate copy during a scheduled run')
    const review = await main.automations.prepareAutomationTikTokReview(created.id, second.id)
    assert.equal(review.caption, 'Accurate transcripts make reliable automations.')
    assert.equal(review.creators[0].info.accountId, tiktok._id)
    assert.equal(generations, 1)
    assert.equal(posting.state.uploads.length, 0, 'review does not upload')
    const options = { accounts: { [tiktok._id]: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: true } },
      disclose: true, yourBrand: true, brandedContent: false, madeWithAi: false, draft: false, consent: true }
    const approval = { reviewId: review.reviewId, caption: 'My reviewed caption #Automation', options, previewConfirmed: true }
    await assert.rejects(main.automations.approveAutomationTikTokReview(created.id, second.id, { ...approval, previewConfirmed: false }), /reviewed this clip/)
    await assert.rejects(main.automations.approveAutomationTikTokReview(created.id, second.id, { ...approval, options: { ...options, consent: false } }), /Agree to TikTok/)
    await assert.rejects(main.automations.approveAutomationTikTokReview(created.id, second.id, { ...approval, options: { ...options, accounts: {} } }), /Choose who can view/)
    await main.automations.approveAutomationTikTokReview(created.id, second.id, approval)
    assert.equal(posting.state.uploads.length, 0, 'approval only saves locally')
    const reopened = await main.automations.prepareAutomationTikTokReview(created.id, second.id)
    assert.equal(reopened.caption, approval.caption, 'editing TikTok preserves the reviewed caption')
    assert.equal(main.automations.listAutomations()[0].content[1].tiktokApproval, null, 'a reopened review pauses the clip until approved again')
    await main.automations.approveAutomationTikTokReview(created.id, second.id, { ...approval, reviewId: reopened.reviewId })
    const restarted = loadMain(source, { electron })
    assert.equal(restarted.automations.listAutomations()[0].content[1].tiktokApproval.caption, approval.caption)
    const slot = { time: '12:00', date: '2026-09-25' }
    const [posted] = await restarted.automations.runAutomation(created.id, slot)
    assert.equal(posted.lastError, null)
    assert.equal(posted.content[0].status, 'queued', 'unapproved first clip is skipped')
    assert.equal(posted.content[1].status, 'posted')
    assert.equal(generations, 1, 'reviewed copy is not regenerated at publish time')
    const body = posting.state.creates[0].body
    assert.equal(body.platforms[0].customContent, approval.caption)
    assert.equal(body.platforms[1].customContent, review.caption)
    assert.equal(body.platforms[0].platformSpecificData.tiktokSettings.privacy_level, 'PUBLIC_TO_EVERYONE')
    assert.equal(body.platforms[0].platformSpecificData.tiktokSettings.allow_comment, true)
    assert.equal(body.platforms[0].platformSpecificData.tiktokSettings.allow_stitch, false, 'creator-disabled interactions stay off')
    assert.equal(body.tiktokSettings.express_consent_given, true)
    assert.equal(body.tiktokSettings.content_preview_confirmed, true)
    await restarted.automations.runAutomation(created.id, slot)
    assert.equal(posting.state.creates.length, 1, 'the same slot cannot duplicate a post')

    const staleReview = await restarted.automations.prepareAutomationTikTokReview(created.id, first.id)
    restarted.automations.updateAutomationContent(created.id, first.id, { title: first.title, caption: 'Changed notes' })
    await assert.rejects(restarted.automations.approveAutomationTikTokReview(created.id, first.id, { ...approval, reviewId: staleReview.reviewId }), /changed/)
    const fresh = await restarted.automations.prepareAutomationTikTokReview(created.id, first.id)
    await restarted.automations.approveAutomationTikTokReview(created.id, first.id, { ...approval, reviewId: fresh.reviewId })
    const [changedMode] = await restarted.automations.updateAutomation(created.id, { ...update, metadataMode: 'manual' })
    assert.equal(changedMode.content[0].tiktokApproval, null, 'changing metadata mode requires review again')
    const manual = await restarted.automations.prepareAutomationTikTokReview(created.id, first.id)
    assert.equal(manual.caption, 'Changed notes')
    await restarted.automations.approveAutomationTikTokReview(created.id, first.id, { ...approval, reviewId: manual.reviewId })
    const [changedAccounts] = await restarted.automations.updateAutomation(created.id, { ...update, metadataMode: 'manual', accounts: [update.accounts[1]] })
    assert.equal(changedAccounts.content[0].tiktokApproval, null, 'removing and re-adding TikTok cannot reuse consent')
    await restarted.automations.updateAutomation(created.id, { ...update, metadataMode: 'manual' })
    const fileReview = await restarted.automations.prepareAutomationTikTokReview(created.id, first.id)
    await restarted.automations.approveAutomationTikTokReview(created.id, first.id, { ...approval, reviewId: fileReview.reviewId })
    fs.utimesSync(fileReview.clipPath, new Date(), new Date(Date.now() + 10000))
    const [changedFile] = await restarted.automations.runAutomation(created.id)
    assert.match(changedFile.lastError, /clip file changed/)
    assert.equal(changedFile.content[0].tiktokApproval, null)
    assert.equal(posting.state.creates.length, 1)
    // Fresh creator limits still apply when approving, and inbox delivery stays explicit.
    const inboxReview = await restarted.automations.prepareAutomationTikTokReview(created.id, first.id)
    const inboxApproval = { ...approval, reviewId: inboxReview.reviewId, options: { ...options, draft: true } }
    posting.state.creatorInfo[tiktok._id] = {
      creator: { nickname: 'Limited creator', canPostMore: false },
      privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE', label: 'Public' }],
      postingLimits: { maxVideoDurationSec: 600 }
    }
    await assert.rejects(restarted.automations.approveAutomationTikTokReview(created.id, first.id, { ...inboxApproval, options }), /isn’t accepting more posts/)
    await restarted.automations.approveAutomationTikTokReview(created.id, first.id, inboxApproval)
    const [delivered] = await restarted.automations.runAutomation(created.id, { time: '13:00', date: '2026-09-25' })
    assert.equal(delivered.content[0].status, 'posted')
    assert.equal(posting.state.creates[1].body.tiktokSettings.draft, true)
    assert.equal(delivered.content[0].tiktokApproval.options.draft, true)

    // Enhanced copy and TikTok consent must be reviewed together, even in manual mode.
    const [extended] = await restarted.automations.addAutomationContent(created.id, [clip])
    const third = extended.content.at(-1)
    const thirdReview = await restarted.automations.prepareAutomationTikTokReview(created.id, third.id)
    await restarted.automations.approveAutomationTikTokReview(created.id, third.id, { ...inboxApproval, reviewId: thirdReview.reviewId })
    const [enhanced] = await restarted.automations.enhanceAutomationContent(created.id, third.id, { research: false })
    const draft = enhanced.content.at(-1).metadataDraft
    assert.ok(draft)
    const heldSlot = { time: '12:00', date: '2026-09-26' }
    const [held] = await restarted.automations.runAutomation(created.id, heldSlot)
    assert.match(held.lastError, /enhanced metadata draft/)
    assert.notEqual(held.lastSlots['12:00'], heldSlot.date, 'draft review does not consume the due slot')
    await assert.rejects(restarted.automations.prepareAutomationTikTokReview(created.id, third.id), /Apply or discard/)
    const [applied] = restarted.automations.resolveAutomationMetadataDraft(created.id, third.id, draft.id, true)
    assert.equal(applied.content.at(-1).tiktokApproval, null, 'applying new copy invalidates older TikTok consent')
    const callsBeforeReview = generations
    const enhancedReview = await restarted.automations.prepareAutomationTikTokReview(created.id, third.id)
    assert.equal(enhancedReview.caption, draft.posts.find(post => post.platform === 'tiktok').caption)
    assert.equal(generations, callsBeforeReview, 'manual mode reuses applied metadata without generating new copy')
    await restarted.automations.approveAutomationTikTokReview(created.id, third.id, { ...inboxApproval, reviewId: enhancedReview.reviewId, caption: enhancedReview.caption })
    const [enhancedPosted] = await restarted.automations.runAutomation(created.id, heldSlot)
    assert.equal(enhancedPosted.content.at(-1).status, 'posted')
    assert.equal(posting.state.creates.at(-1).body.platforms[0].customContent, enhancedReview.caption)


  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await mock.close()
    cleanup()
  }
})

test('held linked clips use fresh post evidence before requeuing or marking submitted', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-held-')
  const postId = 'a'.repeat(24); const accountId = 'b'.repeat(24)
  let remote
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: [{ method: 'GET', path: `/api/v1/posts/${postId}`, handler: (ctx) => ctx.json(200, { post: remote }) }] })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  try {
    const library = path.join(dir, 'library'); fs.mkdirSync(library)
    const clip = path.join(library, 'held.mp4'); fs.writeFileSync(clip, 'test media')
    const source = `export * as automations from './src/main/automations'; export * as posts from './src/main/zernio/posts'; export * as settings from './src/main/settings-store'; export { PostsStore } from './src/main/zernio/posts-store'; export { workspaceId } from './src/main/zernio/workspace-cache'`
    const mocks = { electron: fakeElectron(dir).electron }
    const initial = loadMain(source, mocks)
    initial.settings.replaceApiKey('zernioApiKey', KEY)
    initial.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [automation] = initial.automations.createAutomation('Held')
    const [bank] = await initial.automations.addAutomationContent(automation.id, [clip])
    const workspace = initial.workspaceId(KEY)
    const file = path.join(dir, 'userData', `automations-${workspace}.json`)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    Object.assign(saved.automations[0].content[0], { status: 'needs_review', postId, error: 'All platforms failed', warningsAcknowledged: true })
    const stamp = new Date().toISOString()
    const history = { id: postId, clipPath: clip, clipTitle: 'Held', targets: [{ accountId, platform: 'youtube', handle: null, status: 'failed', error: 'Failed', url: null, inbox: false }], scheduledFor: null, timezone: null, status: 'failed', error: 'All platforms failed', createdAt: stamp, uploadedAt: stamp, refreshedAt: stamp }
    for (const historyState of ['present', 'dismissed', 'evicted']) {
      for (const [status, targetStatus, expected] of [['failed', 'failed', 'queued'], ['published', 'published', 'submitted'], ['publishing', 'processing', 'submitted'], ['partial', 'published', 'held'], ['failed', null, 'held']]) {
        fs.writeFileSync(file, JSON.stringify(saved))
        const store = new initial.PostsStore(path.join(dir, 'userData', 'zernio-posts.json'), workspace)
        store.clear(); store.save(history)
        if (historyState === 'evicted') {
          store.save(...Array.from({ length: 300 }, (_, i) => ({ ...history, id: (i + 1).toString(16).padStart(24, '0'), createdAt: new Date(Date.parse(stamp) + i + 1).toISOString() })))
          assert.equal(store.get(postId), null, 'finished history is actually evicted')
        }
        remote = { _id: postId, status, platforms: targetStatus ? [{ accountId, platform: 'youtube', status: targetStatus }] : [] }
        const main = loadMain(source, mocks)
        if (historyState === 'dismissed') main.posts.dismissPost(postId)
        const requestsBefore = mock.state.requests.length
        const result = await main.automations.reviewAutomationContent(automation.id, bank.content[0].id, true)
        assert.equal(mock.state.requests.length, requestsBefore + 1, 'recovery checks Zernio even without local history')
        assert.equal(result.outcome, expected, `${historyState}/${status}/${targetStatus}`)
        const item = result.automations[0].content[0]
        assert.equal(item.status, expected === 'submitted' ? 'posted' : expected === 'queued' ? 'queued' : 'needs_review')
        assert.equal(item.postId, expected === 'queued' ? null : postId)
        if (expected === 'queued') assert.ok(item.postingAttemptId && item.postingAttemptId !== item.id)
        assert.equal(Boolean(item.postedAt), expected === 'submitted', 'moving to Submitted records when')
      }
    }
    assert.ok(mock.state.requests.every((request) => request.method === 'GET'), 'reviewing never posts or retries')
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    await mock.close(); cleanup()
  }
})

test('requeued posts cannot also retry, across restarts and overlapping recovery requests', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-recovery-ownership-')
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  const source = "export * as automations from './src/main/automations'; export * as posts from './src/main/zernio/posts'; export * as settings from './src/main/settings-store'"
  const mocks = { electron: fakeElectron(dir).electron }
  const releases = []
  function holdRequest(method, postId) {
    const route = posting.routes.find((route) => route.method === method && route.path instanceof RegExp && route.path.test(`/api/v1/posts/${postId}${method === 'POST' ? '/retry' : ''}`))
    let release, entered
    const waiting = new Promise((resolve) => { release = resolve })
    const started = new Promise((resolve) => { entered = resolve })
    releases.push(release)
    mock.route({ method, path: `/api/v1/posts/${postId}${method === 'POST' ? '/retry' : ''}`, handler: async (ctx) => {
      entered(); await waiting; return route.handler({ ...ctx, params: [postId] })
    } })
    return { started, release }
  }
  try {
    const library = path.join(dir, 'library')
    const clip = makeClip(path.join(library, 'first.mp4'))
    let main = loadMain(source, mocks)
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [profile] = mock.state.profiles
    const youtube = mock.addAccount('youtube', profile._id)
    const [bank] = main.automations.createAutomation('Recovery')
    await main.automations.updateAutomation(bank.id, { name: bank.name, enabled: false, profileId: profile._id,
      metadataMode: 'manual', timezone: 'UTC', times: [], youtubeVisibility: 'unlisted', youtubeMadeForKids: false,
      accounts: [{ platform: 'youtube', accountId: youtube._id }] })
    await main.automations.addAutomationContent(bank.id, [clip])
    posting.state.nextPublish.youtube = { status: 'failed', errorMessage: 'Unavailable' }
    const [failed] = await main.automations.runAutomation(bank.id)
    const item = failed.content[0]
    assert.equal(item.status, 'needs_review')
    const get = holdRequest('GET', item.postId)
    const recovering = main.automations.reviewAutomationContent(bank.id, item.id, true)
    await get.started
    await assert.rejects(main.posts.retryPost(item.postId), /already in progress/)
    assert.throws(() => main.posts.dismissPost(item.postId), /already in progress/)
    get.release()
    assert.equal((await recovering).outcome, 'queued')
    main = loadMain(source, mocks)
    assert.equal(main.posts.listPosts().find((post) => post.id === item.postId).automationRequeued, true)
    await assert.rejects(main.posts.retryPost(item.postId), /returned to its automation queue/)
    assert.equal(mock.requestsTo('POST', `/api/v1/posts/${item.postId}/retry`).length, 0)
    assert.equal((await main.automations.runAutomation(bank.id))[0].content[0].status, 'posted')
    assert.equal([...posting.state.posts.values()].filter((post) => post.status === 'published').length, 1)

    // In the opposite ordering, a retry already in flight owns the post.
    await main.automations.addAutomationContent(bank.id, [makeClip(path.join(library, 'second.mp4'), 'red')])
    posting.state.nextPublish.youtube = { status: 'failed', errorMessage: 'Unavailable' }
    const second = (await main.automations.runAutomation(bank.id))[0].content[1]
    const retry = holdRequest('POST', second.postId)
    const retrying = main.posts.retryPost(second.postId)
    await retry.started
    await assert.rejects(main.automations.reviewAutomationContent(bank.id, second.id, true), /already in progress/)
    assert.equal(main.automations.listAutomations()[0].content[1].status, 'needs_review')
    retry.release(); await retrying
    assert.equal((await main.automations.reviewAutomationContent(bank.id, second.id, true)).outcome, 'submitted')
    const creates = posting.state.creates.length
    await main.automations.runAutomation(bank.id)
    assert.equal(posting.state.creates.length, creates, 'a successful old retry cannot produce a fresh automation post')
    assert.equal([...posting.state.posts.values()].filter((post) => post.status === 'published').length, 2)
  } finally {
    releases.forEach((release) => release())
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    await mock.close(); cleanup()
  }
})

test('a post missing from Zernio unlinks the held clip; returning it still needs a person to confirm', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-missing-post-')
  const postId = 'c'.repeat(24); const accountId = 'd'.repeat(24)
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: [{ method: 'GET', path: `/api/v1/posts/${postId}`, handler: (ctx) => ctx.json(404, { error: 'Post not found' }) }] })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  try {
    const library = path.join(dir, 'library'); fs.mkdirSync(library)
    const clip = path.join(library, 'held.mp4'); fs.writeFileSync(clip, 'test media')
    const source = `export * as automations from './src/main/automations'; export * as posts from './src/main/zernio/posts'; export * as settings from './src/main/settings-store'; export { PostsStore } from './src/main/zernio/posts-store'; export { workspaceId } from './src/main/zernio/workspace-cache'`
    const mocks = { electron: fakeElectron(dir).electron }
    let main = loadMain(source, mocks)
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [automation] = main.automations.createAutomation('Missing post')
    const [bank] = await main.automations.addAutomationContent(automation.id, [clip])
    const workspace = main.workspaceId(KEY)
    const file = path.join(dir, 'userData', `automations-${workspace}.json`)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    Object.assign(saved.automations[0].content[0], { status: 'needs_review', postId, error: 'BridgeClip closed while posting.' })
    fs.writeFileSync(file, JSON.stringify(saved))
    const stamp = new Date().toISOString()
    new main.PostsStore(path.join(dir, 'userData', 'zernio-posts.json'), workspace).save({ id: postId, clipPath: clip, clipTitle: 'Held', targets: [{ accountId, platform: 'youtube', handle: null, status: 'pending', error: null, url: null, inbox: false }], scheduledFor: null, timezone: null, status: 'publishing', error: null, createdAt: stamp, uploadedAt: stamp, refreshedAt: null })
    main = loadMain(source, mocks)
    const contentId = bank.content[0].id

    const held = await main.automations.reviewAutomationContent(automation.id, contentId, true)
    assert.equal(held.outcome, 'held', 'a missing post is not evidence that the clip never published')
    const item = held.automations[0].content[0]
    assert.equal(item.status, 'needs_review')
    assert.equal(item.postId, null, 'the clip is no longer stuck behind a post that cannot be checked')
    assert.match(item.error, /Confirm it was not published/)
    assert.equal(main.posts.listPosts()[0].status, 'missing')
    assert.equal(main.automations.listAutomations()[0].content[0].status, 'needs_review')

    const requeued = await main.automations.reviewAutomationContent(automation.id, contentId, true)
    assert.equal(requeued.outcome, 'queued', 'with no linked post, the confirmed Return to queue works as before')
    assert.ok(requeued.automations[0].content[0].postingAttemptId)
    assert.ok(mock.state.requests.every((request) => request.method === 'GET'), 'reviewing never posts or retries')
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    await mock.close(); cleanup()
  }
})

test('submitted and linked clips can be removed as history, never count toward the queue cap, and keep their post link', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-history-')
  try {
    const library = path.join(dir, 'library'); fs.mkdirSync(library)
    const clips = Array.from({ length: 30 }, (_, index) => { const file = path.join(library, `clip-${index}.mp4`); fs.writeFileSync(file, `clip ${index}`); return file })
    const source = `export * as automations from './src/main/automations'; export * as posts from './src/main/zernio/posts'; export * as settings from './src/main/settings-store'; export { PostsStore } from './src/main/zernio/posts-store'; export { workspaceId } from './src/main/zernio/workspace-cache'`
    const mocks = { electron: fakeElectron(dir).electron }
    let main = loadMain(source, mocks)
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [automation] = main.automations.createAutomation('History')
    await main.automations.addAutomationContent(automation.id, clips.slice(0, 3))
    const workspace = main.workspaceId(KEY)
    const file = path.join(dir, 'userData', `automations-${workspace}.json`)
    const bankDir = path.join(dir, 'userData', 'automation-bank', workspace, automation.id)
    const postIds = ['1', '2'].map((digit) => digit.repeat(24))
    let saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const [posted, linked] = saved.automations[0].content
    Object.assign(posted, { status: 'posted', postId: postIds[0], postedAt: '2026-01-01T00:00:00.000Z' })
    Object.assign(linked, { status: 'needs_review', postId: postIds[1], error: 'Some accounts failed.' })
    fs.writeFileSync(file, JSON.stringify(saved))
    const stamp = new Date().toISOString()
    const target = { accountId: 'e'.repeat(24), platform: 'youtube', handle: null, status: 'published', error: null, url: null, inbox: false }
    new main.PostsStore(path.join(dir, 'userData', 'zernio-posts.json'), workspace).save(...[posted, linked].map((item, index) => ({
      id: postIds[index], clipPath: path.join(bankDir, item.fileName), clipTitle: item.title, targets: [target], scheduledFor: null, timezone: null, status: 'published', error: null, createdAt: stamp, uploadedAt: stamp, refreshedAt: stamp })))
    main = loadMain(source, mocks)
    for (const item of [posted, linked]) {
      main.automations.removeAutomationContent(automation.id, item.id)
      assert.equal(fs.existsSync(path.join(bankDir, item.fileName)), false)
    }
    assert.deepEqual(main.automations.listAutomations()[0].content.map((item) => item.status), ['queued'])
    const history = main.posts.listPosts()
    assert.deepEqual(postIds.map((id) => history.find((post) => post.id === id).clipPath), [posted.sourceClipPath, linked.sourceClipPath], 'post history follows the original clip')

    // Fill the waiting queue: 500 unsubmitted clips is the cap, but Submitted history is not counted.
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const template = saved.automations[0].content[0]
    const fake = (status, index) => {
      const id = require('node:crypto').randomUUID()
      return { ...template, id, fileName: `${id}.mp4`, status, postId: null, postedAt: status === 'posted' ? new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() : null }
    }
    saved.automations[0].content = [...Array.from({ length: 499 }, (_, index) => fake('queued', index)), ...Array.from({ length: 480 }, (_, index) => fake('posted', index))]
    const oldest = saved.automations[0].content[499]
    fs.writeFileSync(path.join(bankDir, oldest.fileName), 'old bank copy')
    fs.writeFileSync(file, JSON.stringify(saved))
    main = loadMain(source, mocks)
    await assert.rejects(main.automations.addAutomationContent(automation.id, clips.slice(0, 2)), /up to 500 clips that have not been submitted/)
    await main.automations.addAutomationContent(automation.id, clips.slice(0, 1))
    assert.equal(main.automations.listAutomations()[0].content.length, 980)

    // At the storage bound, the oldest Submitted history makes room for new clips.
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    saved.automations[0].content = saved.automations[0].content.filter((item) => item.status === 'posted' || saved.automations[0].content.indexOf(item) < 470)
    saved.automations[0].content.push(...Array.from({ length: 1000 - saved.automations[0].content.length }, (_, index) => fake('posted', 1000 + index)))
    fs.writeFileSync(file, JSON.stringify(saved))
    main = loadMain(source, mocks)
    assert.equal(main.automations.listAutomations()[0].content.length, 1000)
    await main.automations.addAutomationContent(automation.id, clips.slice(0, 30))
    const content = main.automations.listAutomations()[0].content
    assert.equal(content.length, 1000)
    assert.equal(content.filter((item) => item.status === 'queued').length, 500)
    assert.equal(content.some((item) => item.id === oldest.id), false, 'the oldest submitted clip was pruned')
    assert.equal(fs.existsSync(path.join(bankDir, oldest.fileName)), false, 'and its bank copy removed')
    assert.equal(loadMain(source, mocks).automations.listAutomations()[0].content.length, 1000, 'the pruned bank reloads')
  } finally { cleanup() }
})
