'use strict'
// Posting clips through Zernio: payloads, limits, the upload and create flow
// against the local mock, and the local post history. No real key or account.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock, DEFAULT_CREATOR_INFO } = require('./support/mock-posts.cjs')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')

const KEY = 'test-zernio-key'
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'
const MINUTE = 60_000
const DAY = 86_400_000
const historyPath = (dir, key = KEY) => path.join(dir, `zernio-posts-${crypto.createHash('sha256').update(key).digest('hex')}.json`)
const attemptPath = (dir, key = KEY) => path.join(dir, `zernio-post-attempts-${crypto.createHash('sha256').update(key).digest('hex')}.json`)

const pure = loadMain(`
  export * as shared from './src/shared/zernio-posts'
  export * as payload from './src/main/zernio/posts-payload'
  export { PostsStore } from './src/main/zernio/posts-store'
  export { openAuthorizedMedia } from './src/main/security'
  export { putFile } from './src/main/zernio/posts-upload'
`, { electron: {} })
const { shared, payload } = pure

function makeClip(file, { seconds = 4, width = 360, height = 640 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(FFMPEG, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x5C8FFF:s=${width}x${height}:d=${seconds}:r=15`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-shortest', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-movflags', '+faststart', file
  ])
  return file
}

test('upload reads the authorized file handle after its path is replaced', async () => {
  const http = require('node:http')
  const { dir, cleanup } = tempDir()
  const source = path.join(dir, 'clip.mp4')
  fs.writeFileSync(source, 'authorized bytes')
  const opened = await pure.openAuthorizedMedia(source, dir)
  fs.renameSync(source, path.join(dir, 'old.mp4'))
  fs.writeFileSync(source, 'replacement bytes')
  const received = []
  const server = http.createServer((req, res) => {
    req.on('data', (chunk) => received.push(chunk))
    req.on('end', () => { res.writeHead(200); res.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await pure.putFile(`http://127.0.0.1:${server.address().port}/upload`, opened.handle, { contentType: 'video/mp4', size: opened.size })
    assert.equal(Buffer.concat(received).toString(), 'authorized bytes')
  } finally {
    await opened.handle.close()
    await new Promise((resolve) => server.close(resolve))
    cleanup()
  }
})

test('secure upload returns an address array when Undici requests all DNS results', async () => {
  const { dir, cleanup } = tempDir()
  const source = path.join(dir, 'clip.mp4')
  fs.writeFileSync(source, 'clip bytes')
  const addresses = [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]
  class MockAgent {
    constructor(options) { this.lookup = options.connect.lookup }
    async close() {}
  }
  const upload = loadMain("export { putFile } from './src/main/zernio/posts-upload'", {
    electron: {}, undici: { Agent: MockAgent },
    dns: { lookup: (_host, options, callback) => {
      assert.equal(options.all, true)
      callback(null, addresses)
    } }
  })
  const opened = await pure.openAuthorizedMedia(source, dir)
  const originalFetch = global.fetch
  let checked = false
  global.fetch = async (_url, options) => {
    await new Promise((resolve, reject) => options.dispatcher.lookup('storage.example', { all: true }, (error, result) => {
      if (error) return reject(error)
      assert.deepEqual(result, addresses.slice(1), 'only public addresses can reach the socket')
      checked = true
      resolve()
    }))
    return new Response(null, { status: 200 })
  }
  try {
    await upload.putFile('https://storage.example/upload', opened.handle, { contentType: 'video/mp4', size: opened.size })
    assert.equal(checked, true)
  } finally {
    global.fetch = originalFetch
    await opened.handle.close()
    cleanup()
  }
})

test('upload refuses a hostname that rebinds to a private address at connection time', async () => {
  const { dir, cleanup } = tempDir()
  const source = path.join(dir, 'clip.mp4')
  fs.writeFileSync(source, 'clip bytes')
  let lookups = 0
  const upload = loadMain("export { putFile } from './src/main/zernio/posts-upload'", {
    electron: {},
    dns: { lookup: (_host, _options, callback) => {
      lookups += 1
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    } }
  })
  const opened = await pure.openAuthorizedMedia(source, dir)
  try {
    await assert.rejects(upload.putFile('https://rebind.example/upload', opened.handle, { contentType: 'video/mp4', size: opened.size }), /upload was interrupted/i)
    assert.equal(lookups, 1)
  } finally { await opened.handle.close(); cleanup() }
})

function baseRequest(overrides = {}) {
  return {
    attemptId: 'attempt-0001-abcd',
    clipPath: '/library/job/clip_01.mp4',
    clipTitle: 'Why agents need tests',
    durationMs: 42_000,
    caption: 'Why agents need tests\n\n#AI #Coding',
    targets: [{ platform: 'youtube', accountId: 'a'.repeat(24) }],
    timing: { mode: 'now' },
    options: { youtube: { title: 'Why agents need tests', visibility: 'public', madeForKids: false } },
    ...overrides
  }
}

const TIKTOK_ACCOUNT = { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: true, allowStitch: true }
const TIKTOK_SHARED = { disclose: false, yourBrand: false, brandedContent: false, madeWithAi: false, draft: false, consent: true }
const T1 = 't'.repeat(24)
const T2 = 'u'.repeat(24)

/** TikTok options with the same per-account choice for each of `ids`. */
function tiktokOptions(ids, shared = {}, account = {}) {
  return { ...TIKTOK_SHARED, ...shared, accounts: Object.fromEntries(ids.map((id) => [id, { ...TIKTOK_ACCOUNT, ...account }])) }
}

// ---- Payloads -----------------------------------------------------------------

test('TikTok: shared choices at the request root, each account’s own in its entry, creator limits applied', () => {
  const request = payload.parsePostClipRequest(baseRequest({
    targets: [{ platform: 'tiktok', accountId: T1 }, { platform: 'youtube', accountId: 'y'.repeat(24) }],
    options: { tiktok: tiktokOptions([T1]), youtube: { title: 'Title', visibility: 'unlisted', madeForKids: false } }
  }))
  const body = payload.buildCreatePostBody(request, {
    publicUrl: 'https://media.zernio.com/temp/clip.mp4',
    tiktokInteractions: { [T1]: { comment: true, duet: true, stitch: false } }
  })
  // The root object carries what every TikTok account shares...
  assert.deepEqual(body.tiktokSettings, { content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: false })
  // ...and each entry the whole object for its account, which wins over the root.
  const tiktokEntry = body.platforms.find((p) => p.platform === 'tiktok')
  assert.deepEqual(tiktokEntry.platformSpecificData.tiktokSettings, {
    content_preview_confirmed: true,
    express_consent_given: true,
    video_made_with_ai: false,
    privacy_level: 'PUBLIC_TO_EVERYONE',
    allow_comment: true,
    allow_duet: true,
    allow_stitch: false // the creator turned Stitch off in TikTok
  })
  assert.deepEqual(body.mediaItems, [{ type: 'video', url: 'https://media.zernio.com/temp/clip.mp4' }])
  assert.equal(body.publishNow, true)
  assert.equal(body.scheduledFor, undefined)
})

test('TikTok consent flags are only true after the user consents; draft and disclosure map to Zernio fields', () => {
  const noConsent = payload.buildCreatePostBody(payload.parsePostClipRequest(baseRequest({
    targets: [{ platform: 'tiktok', accountId: T1 }],
    options: { tiktok: tiktokOptions([T1], { consent: false }) }
  })), { publicUrl: 'https://m.test/c.mp4', tiktokInteractions: { [T1]: { comment: true, duet: true, stitch: true } } })
  assert.equal(noConsent.tiktokSettings.content_preview_confirmed, false)
  assert.equal(noConsent.tiktokSettings.express_consent_given, false)

  const both = payload.buildCreatePostBody(payload.parsePostClipRequest(baseRequest({
    targets: [{ platform: 'tiktok', accountId: T1 }],
    options: { tiktok: tiktokOptions([T1], { draft: true, disclose: true, yourBrand: true, brandedContent: true, madeWithAi: true }) }
  })), { publicUrl: 'https://m.test/c.mp4', tiktokInteractions: { [T1]: { comment: true, duet: true, stitch: true } } })
  assert.equal(both.tiktokSettings.draft, true)
  assert.equal(both.tiktokSettings.commercialContentType, 'brand_content')
  assert.equal(both.tiktokSettings.isBrandOrganicPost, true)
  assert.equal(both.tiktokSettings.video_made_with_ai, true)

  const brand = payload.buildCreatePostBody(payload.parsePostClipRequest(baseRequest({
    targets: [{ platform: 'tiktok', accountId: T1 }],
    options: { tiktok: tiktokOptions([T1], { disclose: true, yourBrand: true }) }
  })), { publicUrl: 'https://m.test/c.mp4' })
  assert.equal(brand.tiktokSettings.commercialContentType, 'brand_organic')
  // Without creator info every interaction is sent as off.
  assert.equal(brand.platforms[0].platformSpecificData.tiktokSettings.allow_comment, false)
})

test('several TikTok accounts each get their own privacy level and toggles; options for other accounts are dropped', () => {
  const options = tiktokOptions([T1, T2])
  options.accounts[T2] = { privacyLevel: 'SELF_ONLY', allowComment: true, allowDuet: false, allowStitch: true }
  options.accounts['v'.repeat(24)] = { privacyLevel: 'PUBLIC_TO_EVERYONE' }
  const request = payload.parsePostClipRequest(baseRequest({
    targets: [{ platform: 'tiktok', accountId: T1 }, { platform: 'tiktok', accountId: T2 }],
    options: { tiktok: options }
  }))
  assert.deepEqual(Object.keys(request.options.tiktok.accounts), [T1, T2])
  const body = payload.buildCreatePostBody(request, {
    publicUrl: 'https://m.test/c.mp4',
    tiktokInteractions: { [T1]: { comment: true, duet: true, stitch: true }, [T2]: { comment: false, duet: true, stitch: true } }
  })
  const [first, second] = body.platforms.map((p) => p.platformSpecificData.tiktokSettings)
  assert.equal(first.privacy_level, 'PUBLIC_TO_EVERYONE')
  assert.equal(second.privacy_level, 'SELF_ONLY')
  assert.equal(second.allow_comment, false, 'the second creator turned comments off')
  assert.equal(second.allow_duet, false)
  assert.equal(body.tiktokSettings.privacy_level, undefined, 'no single privacy level at the root')
  // A privacy level that isn't an enum-shaped string is refused.
  assert.throws(() => payload.parsePostClipRequest(baseRequest({
    targets: [{ platform: 'tiktok', accountId: T1 }],
    options: { tiktok: { ...TIKTOK_SHARED, accounts: { [T1]: { privacyLevel: 'public; drop' } } } }
  })), /privacy level/)
})

test('YouTube metadata, Facebook Reel title, Threads topic and scheduling fields', () => {
  const request = payload.parsePostClipRequest(baseRequest({
    targets: [
      { platform: 'youtube', accountId: 'y'.repeat(24) },
      { platform: 'instagram', accountId: 'i'.repeat(24) },
      { platform: 'facebook', accountId: 'f'.repeat(24) },
      { platform: 'threads', accountId: 'h'.repeat(24) },
      { platform: 'twitter', accountId: 'x'.repeat(24) }
    ],
    timing: { mode: 'schedule', scheduledFor: '2026-09-24T15:30:00-04:00', timezone: 'America/New_York' },
    options: {
      youtube: { title: '  A   title  ', visibility: 'private', madeForKids: true },
      instagram: { shareToFeed: false },
      facebook: { format: 'reel', title: 'A useful Reel title' },
      threads: { topicTag: 'Automation' }
    }
  }))
  const body = payload.buildCreatePostBody(request, { publicUrl: 'https://m.test/c.mp4' })
  const byPlatform = Object.fromEntries(body.platforms.map((p) => [p.platform, p]))
  assert.deepEqual(byPlatform.youtube.platformSpecificData, { title: 'A title', visibility: 'private', madeForKids: true })
  assert.deepEqual(byPlatform.instagram.platformSpecificData, { shareToFeed: false })
  assert.deepEqual(byPlatform.facebook.platformSpecificData, { contentType: 'reel', title: 'A useful Reel title' })
  assert.deepEqual(byPlatform.threads.platformSpecificData, { topic_tag: 'Automation' })
  assert.equal(byPlatform.twitter.platformSpecificData, undefined)
  assert.equal(body.scheduledFor, '2026-09-24T19:30:00.000Z', 'sent as UTC so Zernio takes it as-is')
  assert.equal(body.timezone, 'America/New_York')
  assert.equal(body.publishNow, undefined)
  assert.equal(body.tiktokSettings, undefined)
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ targets: [{ platform: 'facebook', accountId: 'f'.repeat(24) }], options: { facebook: { format: 'feed', title: 'Wrong place' } } })), /Facebook Reel title/)
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ targets: [{ platform: 'threads', accountId: 'h'.repeat(24) }], options: { threads: { topicTag: 'Bad.Topic' } } })), /Threads topic tag/)
})

test('request validation rejects long YouTube titles, bad time zones and unknown platforms', () => {
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ options: { youtube: { title: 'x'.repeat(101), visibility: 'public' } } })), /at most 100/)
  assert.doesNotThrow(() => payload.parsePostClipRequest(baseRequest({ options: { youtube: { title: '😀'.repeat(100), visibility: 'public' } } })), 'emoji count as one character each')
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ options: { youtube: { title: '<b>', visibility: 'public' } } })), /< or >/)
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ timing: { mode: 'schedule', scheduledFor: '2026-09-24T10:00:00Z', timezone: 'Mars/Olympus' } })), /time zone/)
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ targets: [{ platform: 'myspace', accountId: 'a'.repeat(24) }] })), /account/)
  assert.throws(() => payload.parsePostClipRequest(baseRequest({ targets: [] })), /at least one account/)
})

// ---- Limits -----------------------------------------------------------------

test('scheduling is at least 5 minutes ahead and stays inside the 7-day upload window', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  assert.match(shared.scheduleError(now + 2 * MINUTE, now), /at least 5 minutes/)
  assert.equal(shared.scheduleError(now + 5 * MINUTE, now), null)
  assert.equal(shared.scheduleError(now + 6.5 * DAY, now), null)
  assert.match(shared.scheduleError(now + 6.5 * DAY + MINUTE, now), /6½ days/)
  assert.match(shared.scheduleError(now + 7 * DAY, now), /7 days/)
  // Time spent in the dialog: a choice that was 5 minutes out is still accepted a little later.
  assert.equal(shared.scheduleError(now + 3 * MINUTE, now, now, 3 * MINUTE), null)
  // Rescheduling counts from when the clip was uploaded, not from now.
  const uploaded = now - 3 * DAY
  assert.equal(shared.scheduleError(now + 3 * DAY, now, uploaded), null)
  assert.match(shared.scheduleError(now + 4 * DAY, now, uploaded), /keeps this upload for 7 days/)
  assert.match(shared.scheduleError(NaN, now), /Choose a date/)
})

test('clip duration and format checks per platform', () => {
  const vertical = (seconds, extra = {}) => ({ durationMs: seconds * 1000, width: 1080, height: 1920, sizeBytes: 20e6, ...extra })
  const wide = (seconds) => ({ durationMs: seconds * 1000, width: 1920, height: 1080, sizeBytes: 20e6 })

  assert.equal(shared.checkClip('instagram', vertical(90)).blocking, null)
  assert.match(shared.checkClip('instagram', vertical(95)).blocking, /Instagram Reels can be at most 1:30\. This clip is 1:35/)
  assert.match(shared.checkClip('tiktok', vertical(2)).blocking, /at least 3 seconds/)
  assert.equal(shared.checkClip('tiktok', vertical(600)).blocking, null)
  assert.match(shared.checkClip('tiktok', vertical(601)).blocking, /at most 10:00/)
  assert.match(shared.checkClip('tiktok', vertical(90), { tiktokMaxSec: 60 }).blocking, /at most 1:00 for this account/)
  assert.deepEqual(shared.checkClip('tiktok', wide(30)).notes, ['TikTok works best with vertical 9:16 video.'])
  assert.deepEqual(shared.checkClip('youtube', vertical(180)).notes, ['Posts as a Short.'])
  assert.deepEqual(shared.checkClip('youtube', vertical(181)).notes, ['Posts as a regular video.'])
  assert.deepEqual(shared.checkClip('youtube', wide(60)).notes, ['Posts as a regular video.'])
  assert.match(shared.checkClip('facebook', wide(30), { facebookFormat: 'reel' }).blocking, /need a vertical video/)
  assert.equal(shared.checkClip('facebook', vertical(60), { facebookFormat: 'reel' }).blocking, null)
  assert.match(shared.checkClip('facebook', vertical(61), { facebookFormat: 'reel' }).blocking, /Facebook Reels can be at most 1:00/)
  assert.equal(shared.checkClip('facebook', vertical(120), { facebookFormat: 'feed' }).blocking, null)
  assert.equal(shared.defaultFacebookFormat(vertical(45)), 'reel')
  assert.equal(shared.defaultFacebookFormat(vertical(60)), 'reel')
  assert.equal(shared.defaultFacebookFormat(vertical(61)), 'feed')
  assert.equal(shared.defaultFacebookFormat(wide(45)), 'feed')
  assert.equal(shared.defaultFacebookFormat({ ...vertical(45), durationMs: null }), 'feed')
  assert.equal(shared.defaultFacebookFormat({ ...vertical(45), width: null }), 'feed')
  const GB = 1024 ** 3
  assert.equal(shared.checkClip('tiktok', vertical(30, { sizeBytes: 4 * GB })).blocking, null)
  assert.match(shared.checkClip('tiktok', vertical(30, { sizeBytes: 4 * GB + 1 })).blocking, /TikTok accepts videos up to 4 GB/)
  assert.equal(shared.checkClip('facebook', vertical(30, { sizeBytes: 4 * GB }), { facebookFormat: 'reel' }).blocking, null)
  assert.match(shared.checkClip('facebook', vertical(30, { sizeBytes: 4 * GB + 1 }), { facebookFormat: 'feed' }).blocking, /Facebook accepts videos up to 4 GB/)
  assert.match(shared.checkClip('threads', vertical(301)).blocking, /at most 5:00/)
  assert.match(shared.checkClip('threads', vertical(30, { sizeBytes: GB + 1 })).blocking, /Threads accepts videos up to 1 GB/)
  assert.match(shared.checkClip('twitter', vertical(30, { sizeBytes: 600 * 1024 * 1024 })).blocking, /512 MB/)
  assert.equal(shared.checkClip('twitter', vertical(3600)).blocking, null, 'X sets its own duration cap per account')
  assert.match(shared.checkClip('linkedin', vertical(2)).blocking, /at least 3 seconds/)
  // Unknown duration (no ffprobe and nothing recorded) never blocks.
  assert.equal(shared.checkClip('instagram', { durationMs: null, width: null, height: null, sizeBytes: 1 }).blocking, null)
})

test('captions: hard limits block, X only warns, hashtags come from tags', () => {
  assert.equal(shared.checkCaption('threads', 'x'.repeat(500)).error, null)
  assert.match(shared.checkCaption('threads', 'x'.repeat(501)).error, /Threads allows 500/)
  assert.equal(shared.checkCaption('twitter', 'x'.repeat(300)).error, null)
  assert.match(shared.checkCaption('twitter', 'x'.repeat(300)).warning, /X Premium/)
  assert.equal(shared.defaultCaption('Big news', ['AI coding', 'ai-coding', 'startups', '!!!']), 'Big news\n\n#AICoding #startups')
  assert.equal(shared.youtubeTitleFor('a'.repeat(120)).length, 100)
  assert.ok(shared.youtubeTitleFor('a'.repeat(120)).endsWith('…'))
})

test('TikTok choices are checked against creator info', () => {
  const info = payload.parseTikTokCreatorInfo('t'.repeat(24), DEFAULT_CREATOR_INFO)
  assert.deepEqual(info.privacyLevels.map((l) => l.value), ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'])
  assert.deepEqual(info.interactions, { comment: true, duet: true, stitch: false })
  assert.equal(info.maxVideoDurationSec, 600)
  assert.deepEqual(info.commercialContentTypes, ['none', 'brand_organic', 'brand_content'])

  const one = [info]
  const check = (sharedChoices = {}, account = {}, infos = one) => shared.tiktokOptionsError(tiktokOptions([info.accountId], sharedChoices, account), infos)
  assert.match(check({}, { privacyLevel: '' }), /Choose who can view/)
  assert.match(check({}, { privacyLevel: 'FOLLOWER_OF_CREATOR' }), /isn’t available/)
  assert.match(check({ consent: false }), /Agree to TikTok/)
  assert.match(check({ disclose: true }), /your brand, a third party, or both/)
  assert.match(check({ disclose: true, brandedContent: true }, { privacyLevel: 'SELF_ONLY' }), /can’t be private/)
  assert.match(check({ disclose: true, brandedContent: true }, {}, [{ ...info, commercialContentTypes: ['none', 'brand_organic'] }]), /does not offer the selected commercial/)
  assert.equal(check({ disclose: true, yourBrand: true }, {}, [{ ...info, commercialContentTypes: ['none', 'brand_organic'] }]), null)
  assert.match(check({}, {}, [{ ...info, canPostMore: false }]), /isn’t accepting more posts/)
  assert.equal(check({ draft: true }, {}, [{ ...info, canPostMore: false }]), null, 'inbox drafts are allowed')
  assert.equal(check(), null)
  assert.deepEqual(shared.sharedCommercialTypes(one), ['none', 'brand_organic', 'brand_content'])
  assert.equal(shared.tiktokConsentText(false), "By posting, you agree to TikTok's Music Usage Confirmation.")
  assert.equal(shared.tiktokConsentText(true), "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.")

  // TikTok's raw field names, in case Zernio passes them through.
  const raw = payload.parseTikTokCreatorInfo('t'.repeat(24), { privacy_level_options: ['SELF_ONLY'], stitch_disabled: true, max_video_post_duration_sec: 60, creator_nickname: 'raw' })
  assert.deepEqual(raw.interactions, { comment: true, duet: true, stitch: false })
  assert.equal(raw.maxVideoDurationSec, 60)
  // Two accounts: each is checked against its own options, and the error names the account.
  const second = payload.parseTikTokCreatorInfo(T2, { privacy_level_options: ['SELF_ONLY'] })
  const two = tiktokOptions([info.accountId, T2])
  const label = (id) => (id === T2 ? 'TikTok @second' : 'TikTok @first')
  assert.match(shared.tiktokOptionsError(two, [info, second], label), /^TikTok @second: That TikTok privacy option isn’t available/)
  two.accounts[T2].privacyLevel = 'SELF_ONLY'
  assert.equal(shared.tiktokOptionsError(two, [info, second], label), null)
  assert.deepEqual(shared.sharedCommercialTypes([info, second]), [], 'only disclosures every account reports')
})

test('Zernio post responses map to per-platform history, and only platform links are kept', () => {
  const record = {
    id: '', clipPath: '/c.mp4', clipTitle: 'c', status: 'publishing', error: null, scheduledFor: null, timezone: null,
    createdAt: '2026-09-23T12:00:00.000Z', uploadedAt: '2026-09-23T12:00:00.000Z', refreshedAt: null,
    targets: [
      { platform: 'youtube', accountId: 'y'.repeat(24), handle: '@y', status: 'pending', error: null, url: null, inbox: false },
      { platform: 'tiktok', accountId: 't'.repeat(24), handle: '@t', status: 'pending', error: null, url: null, inbox: false },
      { platform: 'instagram', accountId: 'i'.repeat(24), handle: '@i', status: 'pending', error: null, url: null, inbox: false }
    ]
  }
  const post = {
    _id: 'p'.repeat(24),
    status: 'partial',
    platforms: [
      { platform: 'youtube', accountId: { _id: 'y'.repeat(24) }, status: 'published', platformPostUrl: 'https://www.youtube.com/shorts/abc' },
      { platform: 'tiktok', accountId: 't'.repeat(24), status: 'failed', errorMessage: 'TikTok direct posting is at capacity right now. Token token_mockCredential123456 leaked?' },
      { platform: 'instagram', accountId: 'i'.repeat(24), status: 'published', platformPostUrl: 'https://instagram.com.evil.test/p/1' }
    ]
  }
  const merged = payload.applyZernioPost(record, post, { platformResults: [{ platform: 'tiktok', status: 'failed', error: 'x' }] })
  assert.equal(merged.id, 'p'.repeat(24))
  assert.equal(merged.status, 'partial')
  assert.equal(merged.targets[0].status, 'published')
  assert.equal(merged.targets[0].url, 'https://www.youtube.com/shorts/abc')
  assert.equal(merged.targets[1].status, 'failed')
  assert.match(merged.targets[1].error, /at capacity/)
  assert.equal(merged.targets[1].error.includes('sk_live'), false, 'key-shaped text is redacted')
  assert.equal(merged.targets[2].url, null, 'a look-alike host is not kept')

  assert.equal(payload.isPostUrl('https://www.tiktok.com/@me/video/1', 'tiktok'), true)
  assert.equal(payload.isPostUrl('https://www.tiktok.com/@me/video/1', 'youtube'), false)
  assert.equal(payload.isPostUrl('http://www.youtube.com/watch?v=1', 'youtube'), false)
  assert.equal(payload.isPostUrl('https://user:pass@x.com/a', 'twitter'), false)
  assert.equal(payload.isPostUrl('javascript:alert(1)', 'twitter'), false)
})

test('account-free platform rows never assign one account’s result to another on the same platform', () => {
  const first = 'a'.repeat(24)
  const second = 'b'.repeat(24)
  const record = {
    id: 'p'.repeat(24), clipPath: '/c.mp4', clipTitle: 'c', status: 'publishing', error: null, scheduledFor: null, timezone: null,
    createdAt: '2026-09-23T12:00:00.000Z', uploadedAt: '2026-09-23T12:00:00.000Z', refreshedAt: null,
    targets: [first, second].map((accountId) => ({ platform: 'youtube', accountId, handle: null, status: 'pending', error: null, url: null, inbox: false }))
  }
  const post = { status: 'partial', platforms: [
    { platform: 'youtube', status: 'published', platformPostUrl: 'https://www.youtube.com/watch?v=first' },
    { platform: 'youtube', status: 'failed', errorMessage: 'Second account failed' }
  ] }
  const ambiguous = payload.applyZernioPost(record, post, { platformResults: [{ platform: 'youtube', status: 'published' }] })
  assert.deepEqual(ambiguous.targets.map((target) => target.status), ['pending', 'pending'])
  assert.deepEqual(ambiguous.targets.map((target) => target.url), [null, null])

  const identified = payload.applyZernioPost(ambiguous, { status: 'partial', platforms: [
    { ...post.platforms[0], accountId: { _id: first } },
    { ...post.platforms[1], accountId: second }
  ] })
  assert.deepEqual(identified.targets.map((target) => target.status), ['published', 'failed'])
  assert.equal(identified.targets[0].url, 'https://www.youtube.com/watch?v=first')
  assert.match(identified.targets[1].error, /Second account failed/)
})

// ---- History --------------------------------------------------------------------

test('post history rejects another workspace and quarantines unbound legacy records', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'zernio-posts.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, posts: [{ id: 'a'.repeat(24) }] }))
    const store = new pure.PostsStore(file, 'workspace-one')
    assert.deepEqual(store.list(), [])
    const retained = fs.readdirSync(dir).find((name) => name.startsWith('zernio-posts.json.quarantine-'))
    assert.ok(retained)
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, retained)).mode & 0o077, 0)
    store.clear()
    assert.deepEqual(new pure.PostsStore(file, 'workspace-two').list(), [])
    assert.equal(fs.existsSync(file), false)
  } finally { cleanup() }
})

test('bound legacy history migrates only for its workspace and survives key switches', () => {
  const { dir, cleanup } = tempDir()
  try {
    const legacy = path.join(dir, 'zernio-posts.json')
    const record = { id: 'a'.repeat(24), clipPath: '/c.mp4', clipTitle: 'c', status: 'scheduled', error: null,
      scheduledFor: '2026-09-25T10:00:00.000Z', timezone: 'UTC', createdAt: '2026-09-01T00:00:00.000Z',
      uploadedAt: '2026-09-01T00:00:00.000Z', refreshedAt: null,
      targets: [{ platform: 'youtube', accountId: 'y'.repeat(24), handle: '@y', status: 'pending', error: null, url: null, inbox: false }] }
    fs.writeFileSync(legacy, JSON.stringify({ version: 2, workspace: 'workspace-one', posts: [record] }), { mode: 0o600 })
    assert.deepEqual(new pure.PostsStore(legacy, 'workspace-two').list(), [])
    assert.equal(fs.existsSync(legacy), true, 'another workspace cannot consume or discard the legacy file')
    assert.equal(new pure.PostsStore(legacy, 'workspace-one').list().length, 1)
    assert.equal(fs.existsSync(path.join(dir, 'zernio-posts-workspace-one.json')), true)
    new pure.PostsStore(legacy, 'workspace-two').clear()
    assert.equal(new pure.PostsStore(legacy, 'workspace-one').list().length, 1)
  } finally { cleanup() }
})

test('post history keeps active posts and stays below its read limit', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'zernio-posts.json')
    const store = new pure.PostsStore(file)
    const make = (i, status, large = false) => ({
      id: i.toString(16).padStart(24, '0'), clipPath: '/c.mp4', clipTitle: 'c', status, error: null,
      scheduledFor: status === 'scheduled' ? '2026-09-25T10:00:00.000Z' : null, timezone: 'UTC',
      createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + i * MINUTE).toISOString(),
      uploadedAt: '2026-09-01T00:00:00.000Z', refreshedAt: null,
      targets: Array.from({ length: large ? 7 : 1 }, () => ({ platform: 'youtube', accountId: 'y'.repeat(24),
        handle: '@y', status: 'failed', error: large ? 'e'.repeat(1000) : null, url: null, inbox: false }))
    })
    store.save(make(999, 'scheduled'), ...Array.from({ length: 300 }, (_, i) => make(i, 'published', true)))
    assert.ok(fs.statSync(file).size <= 2 * 1024 * 1024)
    assert.ok(store.list().some((post) => post.id === make(999, 'scheduled').id))
    assert.ok(store.list().length < 300, 'old finished records are trimmed to meet the byte limit')
    const prior = fs.readFileSync(file)
    const active = Array.from({ length: 301 }, (_, i) => make(i + 2000, 'scheduled'))
    assert.throws(() => store.save(...active), /full of active posts/)
    assert.deepEqual(fs.readFileSync(file), prior, 'a failed write preserves the good file')
    assert.equal(store.list().some((post) => post.id === make(999, 'scheduled').id), true)
    store.remove(make(999, 'scheduled').id)
    store.save(...active.slice(0, 300))
    assert.throws(() => store.reserveActive(make(8888, 'scheduled')), /full of active posts/)
    store.remove(active[0].id)
    const release = store.reserveActive(make(8888, 'scheduled'))
    assert.throws(() => store.reserveActive(make(8889, 'scheduled')), /full of active posts/)
    release()
    const releaseAgain = store.reserveActive(make(8889, 'scheduled'))
    releaseAgain()
    const byteFile = path.join(dir, 'large-posts.json')
    const byteStore = new pure.PostsStore(byteFile)
    byteStore.save(make(8000, 'scheduled'))
    const activeHistory = fs.readFileSync(byteFile)
    assert.throws(() => byteStore.save(...Array.from({ length: 250 }, (_, i) => make(i + 5000, 'scheduled', true))), /storage limit/)
    assert.deepEqual(fs.readFileSync(byteFile), activeHistory, 'an oversized active history does not replace existing posts')
  } finally { cleanup() }
})

test('post history persists atomically, survives a damaged file and keeps scheduled posts when pruning', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = path.join(dir, 'zernio-posts.json')
    const store = new pure.PostsStore(file)
    const record = (id, status, createdAt) => ({
      id, clipPath: '/c.mp4', clipTitle: 'c', status, error: null, scheduledFor: status === 'scheduled' ? '2026-09-25T10:00:00.000Z' : null,
      timezone: 'Europe/Madrid', createdAt, uploadedAt: createdAt, refreshedAt: null,
      targets: [{ platform: 'youtube', accountId: 'y'.repeat(24), handle: '@y', status: 'pending', error: null, url: null, inbox: false }]
    })
    store.save(record('a'.repeat(24), 'scheduled', '2026-09-01T00:00:00.000Z'), record('b'.repeat(24), 'published', '2026-09-02T00:00:00.000Z'))
    assert.deepEqual(new pure.PostsStore(file).list().map((p) => p.id), ['b'.repeat(24), 'a'.repeat(24)], 'newest first')
    assert.equal(fs.existsSync(`${file}.tmp`), false)
    if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(JSON.stringify(onDisk).includes(KEY), false)

    // Invalid records are dropped, not trusted.
    fs.writeFileSync(file, JSON.stringify({ version: 1, posts: [record('c'.repeat(24), 'bogus', '2026-09-03T00:00:00.000Z'), { id: '../x' }] }))
    assert.deepEqual(store.list(), [])

    fs.writeFileSync(file, '{not json')
    assert.deepEqual(store.list(), [])
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('zernio-posts.json.damaged-')), 'damaged history is set aside')

    // 300 finished posts plus an old scheduled one: the scheduled post survives pruning.
    const many = Array.from({ length: 300 }, (_, i) => record(i.toString(16).padStart(24, '0'), 'published', new Date(Date.parse('2026-09-10T00:00:00Z') + i * MINUTE).toISOString()))
    store.save(record('f'.repeat(24), 'scheduled', '2026-01-01T00:00:00.000Z'), ...many)
    const kept = store.list()
    assert.equal(kept.length, 300)
    assert.ok(kept.some((p) => p.id === 'f'.repeat(24)))

    store.remove('f'.repeat(24))
    assert.equal(store.get('f'.repeat(24)), null)
  } finally {
    cleanup()
  }
})

// ---- The flow against the mock -------------------------------------------------

async function withPosting(fn, { clip = {}, mockOptions = {} } = {}) {
  const { dir, cleanup } = tempDir()
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes, ...mockOptions })
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  const previousPath = process.env.PATH
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  // ffprobe as the packaged app ships it, when the machine has none.
  process.env.PATH = `${previousPath}${path.delimiter}${path.join(ROOT, 'engine-bin')}`
  try {
    const library = path.join(dir, 'library')
    const clipPath = makeClip(path.join(library, 'job-1', 'clip_01.mp4'), clip)
    const { electron, calls } = fakeElectron(dir)
    const main = loadMain(`
      export * as posts from './src/main/zernio/posts'
      export * as settings from './src/main/settings-store'
      export * as service from './src/main/zernio/service'
    `, { electron })
    main.settings.replaceApiKey('zernioApiKey', KEY)
    main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3',  })

    const [profile] = mock.state.profiles
    const accounts = {
      tiktok: mock.addAccount('tiktok', profile._id, { username: 'clipper' }),
      youtube: mock.addAccount('youtube', profile._id, { username: 'channel' }),
      instagram: mock.addAccount('instagram', profile._id, { username: 'insta' })
    }
    const progress = []
    const publish = (overrides = {}) => main.posts.publishClip({
      attemptId: overrides.attemptId ?? 'attempt-1234-abcd',
      clipPath,
      clipTitle: 'Why agents need tests',
      durationMs: 4000,
      caption: 'Why agents need tests\n\n#AI',
      targets: [{ platform: 'youtube', accountId: accounts.youtube._id }],
      timing: { mode: 'now' },
      options: { youtube: { title: 'Why agents need tests', visibility: 'public', madeForKids: false } },
      ...overrides
    }, (p) => progress.push(p))
    await fn({ mock, posting, main, electron, clipPath, accounts, publish, progress, calls, userData: path.join(dir, 'userData') })
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    process.env.PATH = previousPath
    await mock.close()
    cleanup()
  }
}

test('publish now: presign, a streamed PUT to storage, then POST /v1/posts with an idempotency id', () => withPosting(async ({ mock, posting, clipPath, accounts, publish, progress, userData }) => {
  const size = fs.statSync(clipPath).size
  const result = await publish({
    targets: [{ platform: 'youtube', accountId: accounts.youtube._id }, { platform: 'tiktok', accountId: accounts.tiktok._id }],
    options: { youtube: { title: 'Why agents need tests', visibility: 'unlisted', madeForKids: false }, tiktok: tiktokOptions([accounts.tiktok._id]) }
  })

  const presign = mock.requestsTo('POST', '/api/v1/media/presign')
  assert.equal(presign.length, 1)
  assert.equal(presign[0].authorized, true)

  assert.equal(posting.state.uploads.length, 1)
  const upload = posting.state.uploads[0]
  assert.equal(upload.bytes, size, 'the whole file arrived')
  assert.equal(upload.sha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(clipPath)).digest('hex'))
  assert.equal(upload.contentType, 'video/mp4')
  assert.equal(upload.contentLength, String(size), 'sent with a Content-Length')
  assert.equal(upload.transferEncoding, null, 'not chunked')
  assert.equal(upload.authorization, false, 'no API key goes to storage')

  const uploading = progress.filter((p) => p.phase === 'uploading')
  assert.ok(uploading.length >= 2)
  assert.equal(uploading.at(-1).transferred, size)
  assert.ok(uploading.every((p, i) => i === 0 || p.transferred >= uploading[i - 1].transferred), 'progress only moves forward')
  assert.equal(progress.at(-1).phase, 'publishing')

  assert.equal(posting.state.creates.length, 1)
  const create = posting.state.creates[0]
  assert.match(create.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(create.body.publishNow, true)
  assert.equal(create.body.mediaItems[0].url, posting.state.presigned.get(upload.key).publicUrl)
  const tiktokSettings = create.body.platforms.find((p) => p.platform === 'tiktok').platformSpecificData.tiktokSettings
  assert.equal(tiktokSettings.privacy_level, 'PUBLIC_TO_EVERYONE')
  assert.equal(tiktokSettings.allow_stitch, false, "the mock creator's Stitch is off")
  assert.equal(create.body.tiktokSettings.express_consent_given, true)
  assert.equal(create.body.platforms.find((p) => p.platform === 'youtube').platformSpecificData.visibility, 'unlisted')

  assert.equal(result.outcome, 'published')
  assert.equal(result.post.status, 'published')
  const youtube = result.post.targets.find((t) => t.platform === 'youtube')
  assert.match(youtube.url, /^https:\/\/www\.youtube\.com\/shorts\//)
  assert.equal(youtube.handle, '@channel')

  const history = JSON.parse(fs.readFileSync(historyPath(userData), 'utf8'))
  assert.equal(history.posts.length, 1)
  assert.equal(history.posts[0].id, result.post.id)
  assert.equal(history.posts[0].clipPath, clipPath)
}))

test('changing the Zernio key isolates history and reuses uploads when the original key returns', () => withPosting(async ({ mock, posting, main, publish }) => {
  await publish()
  assert.equal(main.posts.listPosts().length, 1)
  assert.equal(posting.state.uploads.length, 1)

  main.settings.replaceApiKey('zernioApiKey', 'another-workspace-key')
  main.service.resetZernioState(() => null)
  assert.deepEqual(main.posts.listPosts(), [])

  main.settings.replaceApiKey('zernioApiKey', KEY)
  main.service.resetZernioState(() => null)
  assert.equal(main.posts.listPosts().length, 1, 'the original workspace history is restored')
  await publish({ caption: 'A post after switching workspaces' })
  assert.equal(posting.state.uploads.length, 1, 'the original workspace reuses its upload')
  assert.equal(main.posts.listPosts().length, 2)
  assert.equal(mock.requestsTo('POST', '/api/v1/media/presign').length, 1)
}))

test('a lost response is retried with the same x-request-id and never double-posts', () => withPosting(async ({ mock, posting, publish }) => {
  mock.failNext('POST', '/api/v1/posts', 502, { error: 'Bad gateway' })
  const result = await publish()
  assert.equal(result.outcome, 'published')
  // The mock answers the injected 502 before the route, so only the retry reaches it.
  assert.equal(mock.requestsTo('POST', '/api/v1/posts').length, 2)
  assert.equal(posting.state.posts.size, 1)

  // A replay inside Zernio's 5-minute window returns the original post.
  const [created] = posting.state.creates
  const again = await fetch(`${mock.apiUrl}/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'x-request-id': created.requestId },
    body: JSON.stringify(created.body)
  })
  assert.equal(again.status, 200)
  assert.ok((await again.json()).existingPost)
  assert.equal(posting.state.posts.size, 1)
}))

test('a 503 waits for Retry-After before replaying the same create request', () => withPosting(async ({ mock, posting, publish }) => {
  const create = posting.routes.find((r) => r.method === 'POST' && r.path === '/api/v1/posts')
  const seen = []
  mock.route({
    method: 'POST',
    path: '/api/v1/posts',
    handler: (ctx) => {
      seen.push({ at: Date.now(), requestId: ctx.req.headers['x-request-id'] })
      if (seen.length === 1) return ctx.json(503, { type: 'api_error', code: 'temporarily_unavailable' }, { 'Retry-After': '3' })
      return create.handler(ctx)
    }
  })
  const result = await publish()
  assert.equal(result.outcome, 'published')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].requestId, seen[1].requestId)
  assert.ok(seen[1].at - seen[0].at >= 2_900, 'the retry honors the provider minimum')
  assert.equal(posting.state.posts.size, 1)
}))

test('a 503 wait beyond the idempotency window does not replay the create request', () => withPosting(async ({ mock, publish }) => {
  mock.failNext('POST', '/api/v1/posts', 503, { type: 'api_error', code: 'temporarily_unavailable' }, { 'Retry-After': '290' })
  await assert.rejects(publish(), /safe retry window will end/)
  await assert.rejects(publish(), /safe retry window will end/, 'repeating the dialog attempt still honors the wait')
  assert.equal(mock.requestsTo('POST', '/api/v1/posts').length, 1)
}))

test('trying again after an error reuses the upload; the same content twice is reported as a duplicate', () => withPosting(async ({ mock, posting, publish }) => {
  // Every attempt at creating fails with 500: the upload is kept.
  for (let i = 0; i < 3; i++) mock.failNext('POST', '/api/v1/posts', 500, { error: 'boom' })
  await assert.rejects(publish(), /Retry this attempt soon/)
  assert.equal(posting.state.uploads.length, 1)

  const retried = await publish()
  assert.equal(retried.outcome, 'published')
  assert.equal(posting.state.uploads.length, 1, 'no second upload')
  assert.equal(mock.requestsTo('POST', '/api/v1/media/presign').length, 1)

  // Same caption and media for the same account within 24 hours: Zernio's 409.
  const presigned = [...posting.state.presigned.values()][0]
  mock.route({
    method: 'POST',
    path: '/api/v1/media/presign',
    handler: (ctx) => ctx.json(200, { uploadUrl: `${ctx.mock.url}/upload/${[...posting.state.presigned.keys()][0]}?X-Amz-Signature=mock-signature-not-a-secret`, publicUrl: presigned.publicUrl })
  })
  const duplicate = await publish({ attemptId: 'attempt-9999-dupe' })
  assert.equal(duplicate.outcome, 'duplicate')
  assert.match(duplicate.message, /already scheduled, publishing, or was posted/)
  assert.equal(duplicate.post.id, retried.post.id, 'points at the existing post')
}))

test('an uncertain post is not replayed after Zernio’s idempotency window or restart', () => withPosting(async ({ mock, publish, electron, clipPath, accounts, userData }) => {
  for (let i = 0; i < 3; i++) mock.failNext('POST', '/api/v1/posts', 500, { error: 'temporary failure' })
  await assert.rejects(publish(), /Retry this attempt soon/)
  const journal = attemptPath(userData)
  if (process.platform !== 'win32') assert.equal(fs.statSync(journal).mode & 0o077, 0)
  assert.equal(fs.readFileSync(journal, 'utf8').includes(KEY), false)
  const before = mock.requestsTo('POST', '/api/v1/posts').length
  const restarted = loadMain("export * as posts from './src/main/zernio/posts'", { electron })
  const realNow = Date.now
  Date.now = () => realNow() + 5 * MINUTE
  try {
    await assert.rejects(publish(), /safe retry window ended/)
    await assert.rejects(restarted.posts.publishClip({
      attemptId: 'attempt-1234-abcd', clipPath, clipTitle: 'Why agents need tests', durationMs: 4000,
      caption: 'Why agents need tests\n\n#AI', targets: [{ platform: 'youtube', accountId: accounts.youtube._id }],
      timing: { mode: 'now' }, options: { youtube: { title: 'Why agents need tests', visibility: 'public', madeForKids: false } }
    }, () => {}), /safe retry window ended/)
  } finally {
    Date.now = realNow
  }
  assert.equal(mock.requestsTo('POST', '/api/v1/posts').length, before, 'the expired idempotency key is never sent again')
}))

test('an unresolved request id survives switching away from and back to the same key', () => withPosting(async ({ mock, posting, main, publish, userData }) => {
  for (let i = 0; i < 3; i++) mock.failNext('POST', '/api/v1/posts', 500, { error: 'temporary failure' })
  await assert.rejects(publish(), /Retry this attempt soon/)
  const journal = attemptPath(userData)
  const pending = JSON.parse(fs.readFileSync(journal, 'utf8')).attempts[0][1].requestId
  assert.match(pending, /^[0-9a-f-]{36}$/)

  main.settings.replaceApiKey('zernioApiKey', 'another-workspace-key')
  main.service.resetZernioState(() => null)
  assert.equal(fs.existsSync(journal), true, 'switching keys retains the old workspace journal')
  main.settings.replaceApiKey('zernioApiKey', KEY)
  main.service.resetZernioState(() => null)

  const result = await publish()
  assert.equal(result.outcome, 'published')
  assert.equal(posting.state.creates[0].requestId, pending, 'retry replays the same idempotency key')
  assert.equal(posting.state.uploads.length, 1)
}))

test('a bound legacy attempt journal migrates only after its key returns', () => withPosting(async ({ mock, posting, main, publish, userData }) => {
  for (let i = 0; i < 3; i++) mock.failNext('POST', '/api/v1/posts', 500, { error: 'temporary failure' })
  await assert.rejects(publish(), /Retry this attempt soon/)
  const scoped = attemptPath(userData)
  const legacy = path.join(userData, 'zernio-post-attempts.json')
  const pending = JSON.parse(fs.readFileSync(scoped, 'utf8')).attempts[0][1].requestId
  fs.renameSync(scoped, legacy)

  main.settings.replaceApiKey('zernioApiKey', 'another-workspace-key')
  main.service.resetZernioState(() => null)
  assert.equal(fs.existsSync(legacy), true, 'a different key cannot consume the bound legacy journal')
  main.settings.replaceApiKey('zernioApiKey', KEY)
  main.service.resetZernioState(() => null)

  const result = await publish()
  assert.equal(result.outcome, 'published')
  assert.equal(posting.state.creates[0].requestId, pending)
  assert.equal(fs.existsSync(legacy), false)
  assert.equal(fs.existsSync(scoped), true)
}))

test('partial and failed inline publishes keep per-platform errors; Retry fixes the failed ones', () => withPosting(async ({ posting, main, accounts, publish }) => {
  posting.state.nextPublish.tiktok = { errorMessage: 'TikTok direct posting is at capacity right now. Use tiktokSettings.draft: true to deliver via Creator Inbox, or try again in a few hours as capacity frees up.' }
  const result = await publish({
    targets: [{ platform: 'youtube', accountId: accounts.youtube._id }, { platform: 'tiktok', accountId: accounts.tiktok._id }],
    options: { youtube: { title: 'T', visibility: 'public', madeForKids: false }, tiktok: tiktokOptions([accounts.tiktok._id]) }
  })
  assert.equal(result.outcome, 'partial')
  const tiktok = result.post.targets.find((t) => t.platform === 'tiktok')
  assert.equal(tiktok.status, 'failed')
  assert.match(tiktok.error, /at capacity/)

  const [retried] = await main.posts.retryPost(result.post.id)
  assert.equal(retried.status, 'published')
  assert.equal(retried.targets.find((t) => t.platform === 'tiktok').status, 'published')

  posting.state.nextPublish.youtube = { errorMessage: 'The video is too long for this channel' }
  const failed = await publish({ attemptId: 'attempt-2222-fail', caption: 'Another caption' })
  assert.equal(failed.outcome, 'failed')
  assert.match(failed.post.targets[0].error, /too long/)
}))

test('after a failed post or a 4xx, trying again keeps the upload but sends a new x-request-id', () => withPosting(async ({ mock, posting, publish }) => {
  posting.state.nextPublish.youtube = { errorMessage: 'Video processing failed' }
  const failed = await publish()
  assert.equal(failed.outcome, 'failed')
  const edited = await publish({ caption: 'Edited caption' }) // the same dialog attempt
  assert.equal(edited.outcome, 'published')
  assert.equal(posting.state.uploads.length, 1, 'the upload is reused')
  assert.notEqual(posting.state.creates[0].requestId, posting.state.creates[1].requestId, 'a new post is a new request')

  // A 400 is a definite answer: the retry must not be mistaken for a replay.
  const create = posting.routes.find((r) => r.method === 'POST' && r.path === '/api/v1/posts')
  const seen = []
  mock.route({
    method: 'POST',
    path: '/api/v1/posts',
    handler: (ctx) => {
      seen.push(ctx.req.headers['x-request-id'])
      if (seen.length === 1) return ctx.json(400, { error: 'platforms[0].platformSpecificData.title is invalid', type: 'invalid_request_error', code: 'invalid_field_value' })
      return create.handler(ctx)
    }
  })
  await assert.rejects(publish({ attemptId: 'attempt-4000-4xxx', caption: 'Third' }), /title is invalid/)
  const ok = await publish({ attemptId: 'attempt-4000-4xxx', caption: 'Third' })
  assert.equal(ok.outcome, 'published')
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
  assert.equal(posting.state.uploads.length, 2, 'a new attempt uploads once and reuses it for the retry')
}))

test('schedule, refresh, reschedule and cancel; history follows Zernio', () => withPosting(async ({ mock, posting, main, accounts, publish }) => {
  const at = new Date(Date.now() + 2 * 3_600_000).toISOString()
  const result = await publish({
    targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
    timing: { mode: 'schedule', scheduledFor: at, timezone: 'Europe/Madrid' },
    options: { instagram: { shareToFeed: true } }
  })
  assert.equal(result.outcome, 'scheduled')
  assert.equal(result.post.status, 'scheduled')
  assert.equal(result.post.scheduledFor, at)
  assert.equal(result.post.timezone, 'Europe/Madrid')
  const create = posting.state.creates.at(-1)
  assert.equal(create.body.scheduledFor, at)
  assert.equal(create.body.timezone, 'Europe/Madrid')
  assert.equal(create.body.publishNow, undefined)

  // Too far out for the upload's 7-day life, or too soon.
  await assert.rejects(main.posts.reschedulePost(result.post.id, new Date(Date.now() + 7 * DAY).toISOString(), 'Europe/Madrid'), /7 days/)
  await assert.rejects(main.posts.reschedulePost(result.post.id, new Date(Date.now() + MINUTE).toISOString(), 'Europe/Madrid'), /5 minutes/)
  const later = new Date(Date.now() + 5 * 3_600_000).toISOString()
  const [rescheduled] = await main.posts.reschedulePost(result.post.id, later, 'Europe/Madrid')
  assert.equal(rescheduled.scheduledFor, later)
  assert.equal(posting.state.posts.get(result.post.id).scheduledFor, later)

  // Just updated: nothing is due, so a refresh sends no request.
  const gets = () => mock.state.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/v1/posts/')).length
  const refreshed = await main.posts.refreshPosts(true)
  assert.equal(refreshed.error, null)
  assert.equal(gets(), 0)

  // Cancel a second scheduled post.
  const second = await publish({
    attemptId: 'attempt-3333-cncl',
    caption: 'Second caption',
    targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
    timing: { mode: 'schedule', scheduledFor: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'Europe/Madrid' },
    options: { instagram: { shareToFeed: false } }
  })
  const list = await main.posts.cancelPost(second.post.id)
  assert.equal(list.find((p) => p.id === second.post.id).status, 'cancelled')
  assert.equal(posting.state.posts.has(second.post.id), false, 'DELETE /v1/posts/{id} reached Zernio')
  await assert.rejects(main.posts.cancelPost(second.post.id), /Only scheduled posts/)
  assert.equal(main.posts.listPosts().length, 2)
}))

test('a pending cancellation blocks rescheduling the same post', () => withPosting(async ({ mock, main, accounts, publish }) => {
  const result = await publish({
    targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
    timing: { mode: 'schedule', scheduledFor: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
    options: { instagram: { shareToFeed: true } }
  })
  let releaseDelete
  let reachedDelete
  const deleteStarted = new Promise((resolve) => { reachedDelete = resolve })
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve })
  mock.route({ method: 'DELETE', path: `/api/v1/posts/${result.post.id}`, handler: async (ctx) => {
    reachedDelete()
    await deleteGate
    return ctx.json(200, { message: 'Post deleted successfully' })
  } })

  const cancelling = main.posts.cancelPost(result.post.id)
  await deleteStarted
  await assert.rejects(main.posts.reschedulePost(result.post.id, new Date(Date.now() + 5 * 3_600_000).toISOString(), 'UTC'), /already in progress/)
  assert.equal(mock.requestsTo('PUT', `/api/v1/posts/${result.post.id}`).length, 0)
  releaseDelete()
  await cancelling
  assert.equal(main.posts.listPosts().find((post) => post.id === result.post.id).status, 'cancelled')
}))

test('a delayed status refresh cannot revive a locally cancelled post', () => withPosting(async ({ mock, posting, main, accounts, publish, userData }) => {
  const result = await publish({
    targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
    timing: { mode: 'schedule', scheduledFor: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
    options: { instagram: { shareToFeed: true } }
  })
  const file = historyPath(userData)
  const history = JSON.parse(fs.readFileSync(file, 'utf8'))
  history.posts[0].refreshedAt = new Date(Date.now() - 3_600_000).toISOString()
  fs.writeFileSync(file, JSON.stringify(history))
  let releaseGet
  let reachedGet
  const getStarted = new Promise((resolve) => { reachedGet = resolve })
  const getGate = new Promise((resolve) => { releaseGet = resolve })
  mock.route({ method: 'GET', path: `/api/v1/posts/${result.post.id}`, handler: async (ctx) => {
    const oldPost = structuredClone(posting.state.posts.get(result.post.id))
    reachedGet()
    await getGate
    return ctx.json(200, { post: oldPost })
  } })

  const refreshing = main.posts.refreshPosts(true)
  await getStarted
  await main.posts.cancelPost(result.post.id)
  releaseGet()
  const refreshed = await refreshing
  assert.equal(refreshed.error, null)
  assert.equal(main.posts.listPosts().find((post) => post.id === result.post.id).status, 'cancelled')
}))

test('refresh reads only posts that can still change, a few at a time, and marks deleted ones', () => withPosting(async ({ mock, posting, main, accounts, publish, userData }) => {
  const results = []
  for (let i = 0; i < 7; i++) {
    results.push(await publish({
      attemptId: `attempt-${i}-refresh-x`,
      caption: `Caption ${i}`,
      targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
      timing: { mode: 'schedule', scheduledFor: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(), timezone: 'UTC' },
      options: { instagram: { shareToFeed: true } }
    }))
  }
  // Age every record's refresh stamp so they're all due, then make Zernio publish them.
  const file = historyPath(userData)
  const history = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const post of history.posts) {
    post.refreshedAt = new Date(Date.now() - 3_600_000).toISOString()
    post.scheduledFor = new Date(Date.now() - MINUTE).toISOString()
  }
  fs.writeFileSync(file, JSON.stringify(history))
  posting.publishScheduled()
  posting.state.posts.delete(results[0].post.id)

  const gets = () => mock.state.requests.filter((r) => r.method === 'GET' && /^\/api\/v1\/posts\//.test(r.path)).length
  const first = await main.posts.refreshPosts(false)
  assert.equal(gets(), 5, 'at most 5 requests per refresh')
  assert.equal(first.error, null)
  const second = await main.posts.refreshPosts(false)
  assert.equal(gets(), 7, 'the rest on the next refresh')
  const statuses = Object.fromEntries(second.posts.map((p) => [p.id, p.status]))
  assert.equal(statuses[results[0].post.id], 'missing')
  assert.equal(statuses[results[1].post.id], 'published')
  // Nothing left that can change: no requests.
  await main.posts.refreshPosts(false)
  assert.equal(gets(), 7)
}))

test('links open only for https platform hosts from local history; upload URLs must be https', () => withPosting(async ({ posting, main, publish, calls }) => {
  const result = await publish()
  await main.posts.openPostLink(result.post.id, 0)
  assert.equal(calls.openExternal.length, 1)
  assert.match(calls.openExternal[0], /^https:\/\/www\.youtube\.com\//)
  await assert.rejects(main.posts.openPostLink(result.post.id, 5), /doesn’t have a link/)
  await assert.rejects(main.posts.openPostLink('../../etc', 0), /no longer in your history/)
  await main.posts.openTikTokLegal('musicUsage')
  assert.equal(calls.openExternal[1], 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en')
  await assert.rejects(main.posts.openTikTokLegal('https://evil.test'), /Unknown link/)

  posting.state.uploadOrigin = 'http://uploads.example.test'
  await assert.rejects(publish({ attemptId: 'attempt-5555-http', caption: 'new' }), /secure upload link/)
}))

test('one post reaches several accounts on one platform across profiles; each TikTok keeps its own choices', () => withPosting(async ({ mock, posting, accounts, publish }) => {
  const brandB = mock.addProfile('Brand B')
  const brandC = mock.addProfile('Brand C')
  const tiktokB = mock.addAccount('tiktok', brandB._id, { username: 'brand_b' })
  const tiktokC = mock.addAccount('tiktok', brandC._id, { username: 'brand_c' })
  const youtubeB = mock.addAccount('youtube', brandB._id, { username: 'channel_b' })
  // Brand C's creator only allows private posts and turned comments off.
  posting.state.creatorInfo[tiktokC._id] = {
    ...DEFAULT_CREATOR_INFO,
    creator: { nickname: 'brand c', canPostMore: true },
    privacyLevels: [{ value: 'SELF_ONLY', label: 'Self Only' }],
    postingLimits: { maxVideoDurationSec: 600, interactionSettings: { allow_comment: { enabled: false }, allow_duet: { enabled: true }, allow_stitch: { enabled: true } } }
  }
  const tiktokIds = [accounts.tiktok._id, tiktokB._id, tiktokC._id]
  const targets = [
    ...tiktokIds.map((accountId) => ({ platform: 'tiktok', accountId })),
    { platform: 'youtube', accountId: accounts.youtube._id },
    { platform: 'youtube', accountId: youtubeB._id }
  ]
  const youtube = { title: 'Across profiles', visibility: 'public', madeForKids: false }
  const options = tiktokOptions(tiktokIds)

  // "Everyone" for Brand C's TikTok is refused before anything uploads, naming that account.
  await assert.rejects(publish({ targets, options: { tiktok: options, youtube } }), /TikTok @brand_c: That TikTok privacy option isn’t available/)
  assert.equal(posting.state.uploads.length, 0)

  options.accounts[tiktokC._id] = { privacyLevel: 'SELF_ONLY', allowComment: true, allowDuet: true, allowStitch: false }
  const result = await publish({ targets, options: { tiktok: options, youtube } })
  assert.equal(result.outcome, 'published')
  assert.equal(posting.state.uploads.length, 1, 'uploaded once')
  assert.equal(posting.state.creates.length, 1, 'one post covers every profile')

  const entries = Object.fromEntries(posting.state.creates[0].body.platforms.map((p) => [p.accountId, p]))
  assert.equal(Object.keys(entries).length, 5)
  assert.equal(entries[tiktokC._id].platformSpecificData.tiktokSettings.privacy_level, 'SELF_ONLY')
  assert.equal(entries[tiktokC._id].platformSpecificData.tiktokSettings.allow_comment, false, 'Brand C has comments off')
  assert.equal(entries[tiktokB._id].platformSpecificData.tiktokSettings.privacy_level, 'PUBLIC_TO_EVERYONE')
  assert.equal(entries[tiktokB._id].platformSpecificData.tiktokSettings.allow_stitch, false, 'the default creator has Stitch off')
  assert.equal(entries[youtubeB._id].platformSpecificData.title, 'Across profiles')

  assert.deepEqual(result.post.targets.map((t) => t.handle).sort(), ['@brand_b', '@brand_c', '@channel', '@channel_b', '@clipper'])
  assert.ok(result.post.targets.every((t) => t.status === 'published'))
  // Creator info once per TikTok account: the retry after the refusal used the cached answers.
  assert.equal(mock.state.requests.filter((r) => r.path.endsWith('/tiktok/creator-info')).length, 3)
}))

test('two accounts on one platform, one failing: each keeps its own status and error', () => withPosting(async ({ mock, posting, accounts, publish }) => {
  const second = mock.addProfile('Second channel')
  const youtube2 = mock.addAccount('youtube', second._id, { username: 'second_channel' })
  posting.state.nextPublish.youtube = { errorMessage: 'The daily upload limit was reached for this channel' }
  const result = await publish({
    targets: [{ platform: 'youtube', accountId: accounts.youtube._id }, { platform: 'youtube', accountId: youtube2._id }]
  })
  assert.equal(result.outcome, 'partial')
  const [first, other] = result.post.targets
  assert.equal(first.status, 'failed')
  assert.match(first.error, /daily upload limit/)
  assert.equal(other.status, 'published')
  assert.equal(other.error, null, "the other channel's result isn't borrowed")
  assert.match(other.url, /^https:\/\/www\.youtube\.com\//)
}))

test('the main process re-checks the clip, the accounts and TikTok rules before uploading', () => withPosting(async ({ mock, posting, accounts, publish, clipPath }) => {
  mock.setHealth(accounts.tiktok._id, { integrationLane: 'business' })
  await assert.rejects(publish({
    targets: [{ platform: 'tiktok', accountId: accounts.tiktok._id }],
    options: { tiktok: tiktokOptions([accounts.tiktok._id], {}, { privacyLevel: 'SELF_ONLY' }) }
  }), /Business connections can post videos directly to Everyone only/)
  await assert.rejects(publish({
    targets: [{ platform: 'tiktok', accountId: accounts.tiktok._id }],
    options: { tiktok: tiktokOptions([accounts.tiktok._id], { consent: false }) }
  }), /Agree to TikTok/)
  await assert.rejects(publish({
    targets: [{ platform: 'tiktok', accountId: accounts.tiktok._id }],
    options: { tiktok: tiktokOptions([accounts.tiktok._id], {}, { privacyLevel: 'FOLLOWER_OF_CREATOR' }) }
  }), /isn’t available/)
  await assert.rejects(publish({ targets: [{ platform: 'youtube', accountId: accounts.instagram._id }] }), /no longer connected/)
  await assert.rejects(publish({ caption: 'x'.repeat(5001) }), /YouTube allows 5,000/)
  await assert.rejects(publish({ clipPath: path.join(path.dirname(clipPath), '..', '..', 'outside.mp4') }), /./)
  await assert.rejects(publish({ timing: { mode: 'schedule', scheduledFor: new Date(Date.now() + 8 * DAY).toISOString(), timezone: 'UTC' } }), /6½ days/)
  assert.equal(posting.state.uploads.length, 0, 'nothing was uploaded')
  assert.equal(mock.requestsTo('POST', '/api/v1/media/presign').length, 0)
}, { clip: { seconds: 4 } }))

test('TikTok Business drafts and developer direct posts can keep creator-approved private visibility', () => withPosting(async ({ mock, posting, accounts, publish }) => {
  const target = [{ platform: 'tiktok', accountId: accounts.tiktok._id }]
  mock.setHealth(accounts.tiktok._id, { integrationLane: 'business' })
  const draft = await publish({
    attemptId: 'attempt-business-draft',
    targets: target,
    options: { tiktok: tiktokOptions([accounts.tiktok._id], { draft: true }, { privacyLevel: 'SELF_ONLY' }) }
  })
  assert.equal(draft.outcome, 'published')
  assert.equal(posting.state.creates[0].body.platforms[0].platformSpecificData.tiktokSettings.privacy_level, 'SELF_ONLY')

  mock.setHealth(accounts.tiktok._id, { integrationLane: 'developer' })
  const direct = await publish({
    attemptId: 'attempt-developer-direct',
    caption: 'Different developer post',
    targets: target,
    options: { tiktok: tiktokOptions([accounts.tiktok._id], {}, { privacyLevel: 'SELF_ONLY' }) }
  })
  assert.equal(direct.outcome, 'published')
  assert.equal(posting.state.creates[1].body.platforms[0].platformSpecificData.tiktokSettings.privacy_level, 'SELF_ONLY')
}))

test('an Instagram Reel over 90 seconds is refused before upload, from ffprobe’s real duration', () => withPosting(async ({ posting, accounts, publish }) => {
  await assert.rejects(publish({
    durationMs: 10_000, // the recorded length is wrong; the file is what counts
    targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
    options: { instagram: { shareToFeed: true } }
  }), /Instagram Reels can be at most 1:30\. This clip is 1:32/)
  assert.equal(posting.state.uploads.length, 0)
}, { clip: { seconds: 92, width: 180, height: 320 } }))

test('cancelling an upload stops the PUT and leaves no post', () => withPosting(async ({ mock, posting, main, publish }) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  mock.route({ method: 'PUT', path: /^\/upload\/(.+)$/, auth: false, handler: async (ctx) => { await gate; ctx.empty(200) } })
  const pending = publish({ attemptId: 'attempt-7777-cncl' })
  await mock.waitFor(() => mock.state.requests.some((r) => r.method === 'PUT'))
  main.posts.cancelUpload('attempt-7777-cncl')
  await assert.rejects(pending, /Upload cancelled/)
  release()
  assert.equal(posting.state.creates.length, 0)
  assert.equal(main.posts.listPosts().length, 0)
}, { clip: { seconds: 3 } }))

test('a not-found cancellation cannot write into a newly selected workspace', () => withPosting(async ({ mock, main, accounts, publish }) => {
  const result = await publish({
    targets: [{ platform: 'instagram', accountId: accounts.instagram._id }],
    timing: { mode: 'schedule', scheduledFor: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
    options: { instagram: { shareToFeed: true } }
  })
  let releaseDelete
  let reachedDelete
  const deleteStarted = new Promise((resolve) => { reachedDelete = resolve })
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve })
  mock.route({ method: 'DELETE', path: `/api/v1/posts/${result.post.id}`, handler: async (ctx) => {
    reachedDelete()
    await deleteGate
    return ctx.json(404, { error: 'Post not found' })
  } })
  const cancelling = main.posts.cancelPost(result.post.id)
  await deleteStarted
  main.settings.replaceApiKey('zernioApiKey', 'another-workspace-key')
  main.service.resetZernioState(() => null)
  releaseDelete()
  await assert.rejects(cancelling, /API key changed/)
  assert.deepEqual(main.posts.listPosts(), [])
  main.settings.replaceApiKey('zernioApiKey', KEY)
  main.service.resetZernioState(() => null)
  assert.equal(main.posts.listPosts().find((post) => post.id === result.post.id).status, 'scheduled')
}))
