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
    const [posted] = await restarted.automations.runAutomation(created.id)
    assert.equal(posted.content[0].status, 'posted')
    assert.equal(posting.state.creates.length, 1)
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
    const journal = path.join(dir, 'userData', 'zernio-post-attempts.json')
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
    assert.ok(partial.content[1].postId, 'the partial post is linked for review')
    assert.throws(() => restarted.automations.updateAutomationContent(created.id, partial.content[1].id, {
      title: partial.content[1].title, caption: 'Must not be saved', returnToQueue: true
    }), /Use Posts on Accounts/)
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
