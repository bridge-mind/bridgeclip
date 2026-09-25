'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock, DEFAULT_CREATOR_INFO } = require('./support/mock-posts.cjs')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')

const SOURCE = "export * as automations from './src/main/automations'; export * as settings from './src/main/settings-store'"

async function withTikTokBank(run) {
  const { dir, cleanup } = tempDir('bridgeclip-tiktok-review-')
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: 'tiktok-review-test', extraRoutes: posting.routes })
  const previous = { url: process.env.BRIDGECLIP_ZERNIO_API_URL, path: process.env.PATH }
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  process.env.PATH = `${previous.path}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  try {
    const library = path.join(dir, 'library')
    fs.mkdirSync(library)
    const clip = path.join(library, 'video.mp4')
    const ffmpeg = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:d=4:r=15', '-c:v', 'mpeg4', '-q:v', '8', clip])
    const { electron } = fakeElectron(dir)
    let failWrites = false
    const mocks = { electron, fs: { ...fs, writeFileSync: (file, ...args) => {
      if (failWrites && path.basename(String(file)).startsWith('automations-')) throw new Error('Simulated disk full')
      return fs.writeFileSync(file, ...args)
    } } }
    const main = loadMain(SOURCE, mocks)
    main.settings.replaceApiKey('zernioApiKey', 'tiktok-review-test')
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
    const [profile] = mock.state.profiles
    const account = mock.addAccount('tiktok', profile._id)
    const [created] = main.automations.createAutomation('TikTok review')
    const update = { name: created.name, enabled: true, profileId: profile._id, metadataMode: 'manual', timezone: 'UTC', times: ['12:00'],
      youtubeVisibility: 'public', youtubeMadeForKids: false, accounts: [{ platform: 'tiktok', accountId: account._id }] }
    await main.automations.updateAutomation(created.id, update)
    const [bank] = await main.automations.addAutomationContent(created.id, [clip])
    const contentId = bank.content[0].id
    const options = { accounts: { [account._id]: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: true } },
      disclose: false, yourBrand: false, brandedContent: false, madeWithAi: false, draft: false, consent: true }
    const request = (reviewId) => ({ reviewId, caption: 'The caption I edited for TikTok', options, previewConfirmed: true })
    await run({ api: main.automations, id: bank.id, contentId, account, update, request, posting, mock,
      failWrites: (value) => { failWrites = value }, restart: () => loadMain(SOURCE, mocks).automations })
  } finally {
    if (previous.url === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previous.url
    process.env.PATH = previous.path
    await mock.close()
    cleanup()
  }
}

test('cancelled TikTok reviews retain edited captions across restarts without retaining approval', () => withTikTokBank(async ({ api, id, contentId, request, restart, posting }) => {
  const initial = await api.prepareAutomationTikTokReview(id, contentId)
  await api.approveAutomationTikTokReview(id, contentId, request(initial.reviewId))
  const reopened = await api.prepareAutomationTikTokReview(id, contentId)
  assert.equal(reopened.caption, request('').caption)
  assert.equal(api.listAutomations()[0].content[0].tiktokApproval, null)
  const restored = restart()
  const afterCancel = await restored.prepareAutomationTikTokReview(id, contentId)
  assert.equal(afterCancel.caption, reopened.caption, 'cancel/reopen cannot revert to the generic caption')
  const [waiting] = await restored.runAutomation(id)
  assert.equal(waiting.content[0].status, 'queued')
  assert.equal(posting.state.uploads.length, 0)
}))

test('no-op and rejected clip edits preserve approval; failed saves roll back pending edits and consent', () => withTikTokBank(async ({ api, id, contentId, request, update, failWrites, posting }) => {
  const review = await api.prepareAutomationTikTokReview(id, contentId)
  const beforeApproval = api.listAutomations()
  failWrites(true)
  await assert.rejects(api.approveAutomationTikTokReview(id, contentId, request(review.reviewId)), /disk full/)
  assert.deepEqual(api.listAutomations(), beforeApproval, 'a failed approval must not leave an approved clip in memory')
  failWrites(false)
  await api.approveAutomationTikTokReview(id, contentId, request(review.reviewId))
  const approved = api.listAutomations()
  const clip = approved[0].content[0]
  api.updateAutomationContent(id, contentId, { title: clip.title, caption: clip.caption })
  assert.deepEqual(api.listAutomations(), approved, 'saving unchanged details preserves approval')
  assert.throws(() => api.updateAutomationContent(id, contentId, { title: 'Rejected title', caption: 'Rejected copy', returnToQueue: true }), /Only clips needing review/)
  assert.deepEqual(api.listAutomations(), approved, 'validation must precede mutation')
  failWrites(true)
  assert.throws(() => api.updateAutomationContent(id, contentId, { title: 'Unsaved title', caption: 'Unsaved copy' }), /disk full/)
  assert.deepEqual(api.listAutomations(), approved, 'failed content writes restore the original clip')
  await assert.rejects(api.updateAutomation(id, { ...update, enabled: false, accounts: [] }), /disk full/)
  assert.deepEqual(api.listAutomations(), approved, 'failed settings writes restore the targets and approvals')
  await assert.rejects(api.prepareAutomationTikTokReview(id, contentId), /disk full/)
  assert.deepEqual(api.listAutomations(), approved, 'failed review preparation preserves saved state')
  assert.equal(posting.state.uploads.length, 0)
}))

test('a clip approved during a due slot can still post, with fresh creator permissions and no duplicate slot', () => withTikTokBank(async ({ api, id, contentId, request, account, posting }) => {
  const slot = { time: '12:00', date: '2026-09-25' }
  const [waiting] = await api.runAutomation(id, slot)
  assert.equal(waiting.lastSlots[slot.time], undefined, 'waiting for approval does not consume the posting slot')
  const review = await api.prepareAutomationTikTokReview(id, contentId)
  await api.approveAutomationTikTokReview(id, contentId, request(review.reviewId))
  assert.equal(api.listAutomations()[0].content[0].tiktokApproval.options.accounts[account._id].allowStitch, false, 'approval freezes disabled interactions as off')
  posting.state.creatorInfo[account._id] = { ...DEFAULT_CREATOR_INFO, privacyLevels: [{ value: 'SELF_ONLY', label: 'Only me' }] }
  const [changed] = await api.runAutomation(id)
  assert.match(changed.lastError, /privacy option isn’t available/)
  assert.equal(posting.state.uploads.length, 0, 'stale cached creator info cannot authorize an upload')
  posting.state.creatorInfo[account._id] = { ...DEFAULT_CREATOR_INFO, postingLimits: { ...DEFAULT_CREATOR_INFO.postingLimits,
    interactionSettings: { ...DEFAULT_CREATOR_INFO.postingLimits.interactionSettings, allow_stitch: { enabled: true } } } }
  const [posted] = await api.runAutomation(id, slot)
  assert.equal(posted.content[0].status, 'posted')
  assert.equal(posting.state.creates[0].body.platforms[0].platformSpecificData.tiktokSettings.allow_stitch, false, 'a newly available interaction is not silently enabled')
  await api.runAutomation(id, slot)
  assert.equal(posting.state.creates.length, 1)
}))

test('a changed approved clip can be reviewed again during the same due slot', () => withTikTokBank(async ({ api, id, contentId, request, posting }) => {
  const slot = { time: '12:00', date: '2026-09-25' }
  const review = await api.prepareAutomationTikTokReview(id, contentId)
  await api.approveAutomationTikTokReview(id, contentId, request(review.reviewId))
  fs.utimesSync(review.clipPath, new Date(), new Date(Date.now() + 10_000))

  const [changed] = await api.runAutomation(id, slot)
  assert.match(changed.lastError, /clip file changed/i)
  assert.equal(changed.content[0].tiktokApproval, null)
  assert.equal(changed.lastSlots[slot.time], undefined, 'no upload started, so the due slot remains available')
  assert.equal(posting.state.uploads.length, 0)

  const fresh = await api.prepareAutomationTikTokReview(id, contentId)
  await api.approveAutomationTikTokReview(id, contentId, request(fresh.reviewId))
  const [posted] = await api.runAutomation(id, slot)
  assert.equal(posted.content[0].status, 'posted')
  assert.equal(posted.lastSlots[slot.time], slot.date)
  assert.equal(posting.state.creates.length, 1)
  await api.runAutomation(id, slot)
  assert.equal(posting.state.creates.length, 1, 'the completed slot cannot post again')
}))

test('ordinary TikTok preflight failures keep the due slot reserved', () => withTikTokBank(async ({ api, id, contentId, request, account, posting }) => {
  const slot = { time: '12:00', date: '2026-09-25' }
  const review = await api.prepareAutomationTikTokReview(id, contentId)
  await api.approveAutomationTikTokReview(id, contentId, request(review.reviewId))
  posting.state.creatorInfo[account._id] = { ...DEFAULT_CREATOR_INFO, privacyLevels: [{ value: 'SELF_ONLY', label: 'Only me' }] }

  const [failed] = await api.runAutomation(id, slot)
  assert.match(failed.lastError, /privacy option isn’t available/)
  assert.equal(failed.content[0].status, 'queued')
  assert.equal(failed.lastSlots[slot.time], slot.date)
  assert.equal(posting.state.uploads.length, 0)

  posting.state.creatorInfo[account._id] = DEFAULT_CREATOR_INFO
  await api.runAutomation(id, slot)
  assert.equal(posting.state.uploads.length, 0, 'an ordinary failed attempt cannot repeat during the same slot')
}))

test('changing and restoring TikTok targets invalidates the original open review', () => withTikTokBank(async ({ api, id, contentId, update, request, posting }) => {
  const review = await api.prepareAutomationTikTokReview(id, contentId)
  await api.updateAutomation(id, { ...update, enabled: false, accounts: [] })
  await api.updateAutomation(id, update)
  await assert.rejects(api.approveAutomationTikTokReview(id, contentId, request(review.reviewId)), /changed/)
  assert.equal(posting.state.uploads.length, 0)
}))
