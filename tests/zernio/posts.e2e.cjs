'use strict'
// End to end: an isolated BridgeClip (hidden window, own userData, mock
// keychain) posts a real clip from the Library to a local mock Zernio, then
// cancels a scheduled post from the Accounts page. No real key or account.
//
//   npm run test:e2e
//
// Set BRIDGECLIP_E2E_SKIP_BUILD=1 to reuse the last build, and
// BRIDGECLIP_E2E_SHOTS=<dir> to save screenshots of each step.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { createPostingMock } = require('./support/mock-posts.cjs')
const { buildApp, launchApp, ROOT } = require('./support/electron-app.cjs')

const KEY = 'e2e-zernio-key-not-a-secret'
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'
const CLIP_TITLE = 'Agents that test their own code'
const SHOTS = process.env.BRIDGECLIP_E2E_SHOTS

function toLocalInput(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A Library run of 6-second vertical clips, the way the engine writes it. Returns the clip paths. */
function seedLibrary(library, titles = [CLIP_TITLE]) {
  const jobDir = path.join(library, '11111111-2222-3333-4444-555555555555')
  fs.mkdirSync(jobDir, { recursive: true })
  const clips = titles.map((title, i) => {
    const file = path.join(jobDir, `clip_${String(i + 1).padStart(2, '0')}.mp4`)
    execFileSync(FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=s=360x640:d=6:r=15`,
      '-f', 'lavfi', '-i', `sine=frequency=${330 + i * 110}:duration=6`,
      '-shortest', '-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'aac', '-movflags', '+faststart', file
    ])
    return {
      clip_index: i,
      s3_url: `file://${file}`,
      duration_ms: 6000,
      start_time_ms: 10_000 + i * 20_000,
      end_time_ms: 16_000 + i * 20_000,
      virality_score: 0.8 - i * 0.1,
      layout_type: 'talking_head',
      summary: title,
      tags: i === 0 ? ['AI coding', 'testing'] : ['clip two']
    }
  })
  fs.writeFileSync(path.join(jobDir, 'job_output.json'), JSON.stringify({
    job_id: 'e2e-job',
    source_video_url: '/videos/source.mp4',
    source_video_title: 'E2E source video',
    source_video_duration_seconds: 600,
    total_clips: clips.length,
    clips,
    transcript_url: null,
    plan_url: null,
    processing_time_seconds: 12,
    metrics: null,
    created_at: new Date().toISOString()
  }))
  return clips.map((clip) => clip.s3_url.slice('file://'.length))
}

let appDir = null
/**
 * An isolated app on a fresh userData whose Library holds `titles`, talking to
 * a fresh mock Zernio. `key: false` leaves Zernio unconfigured. Cleanup is
 * registered on `t` before anything launches.
 */
async function start(t, { titles, key = true, tiktokLane = null } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-posts-e2e-'))
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  let app = null
  t.after(async () => {
    await app?.close()
    await mock.close()
    fs.rmSync(work, { recursive: true, force: true })
  })
  const [profile] = mock.state.profiles
  const accounts = {
    tiktok: mock.addAccount('tiktok', profile._id, { username: 'clipper' }),
    youtube: mock.addAccount('youtube', profile._id, { username: 'channel' }),
    instagram: mock.addAccount('instagram', profile._id, { username: 'insta' })
  }
  if (tiktokLane) mock.setHealth(accounts.tiktok._id, { integrationLane: tiktokLane })
  const userDataDir = path.join(work, 'userData')
  // launchApp seeds settings (no keys) with this folder, inside the isolated dir, as the Library.
  const clipPaths = seedLibrary(path.join(userDataDir, 'BridgeClip'), titles)
  appDir ??= buildApp(process.env.BRIDGECLIP_E2E_APP_DIR || path.join(os.tmpdir(), 'bridgeclip-posts-e2e-app'))
  app = await launchApp({ appDir, userDataDir, mock })
  // Links never reach a real browser from a test run.
  await app.app.evaluate(({ shell }) => { shell.openExternal = async () => {} })
  if (key) {
    // Through the app, so the mock keychain encrypts it.
    await app.page.evaluate((value) => window.bridgeclip.settings.replaceApiKey('zernioApiKey', value), KEY)
    await app.page.reload()
    await app.page.waitForLoadState('domcontentloaded')
  }
  const openRun = async () => {
    await app.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click()
    await app.page.getByRole('button', { name: /E2E source video/ }).click()
  }
  return { ...app, mock, posting, accounts, userDataDir, clipPaths, openRun }
}

/** Picks an option from one of the app's dropdowns (a combobox button with a listbox menu). */
async function choose(page, combobox, name) {
  await combobox.click()
  await page.getByRole('listbox').getByRole('option', { name, exact: true }).click()
}

/** The options a dropdown offers, read from its open menu, which is then closed again. */
async function menuOptions(page, combobox) {
  await combobox.click()
  const options = await page.getByRole('listbox').getByRole('option').allTextContents()
  await combobox.press('Escape')
  return options
}

async function shot(page, name) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {})
}

test('post a Library clip now and on a schedule, then cancel the scheduled one', { timeout: 300_000 }, async (t) => {
  const { page, mock, posting, accounts, userDataDir, clipPaths: [clipPath], openRun } = await start(t, { tiktokLane: 'business' })
  const { tiktok, youtube, instagram } = accounts
  // Library → the run → Post on the clip.
  await openRun()
  await page.getByRole('button', { name: `Post “${CLIP_TITLE}”` }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: /^TikTok/ }).waitFor()
  await shot(page, '01-dialog-open')

  // Caption prefilled from the title and tags.
  assert.equal(await dialog.getByLabel('Caption').inputValue(), `${CLIP_TITLE}\n\n#AICoding #testing`)

  // TikTok + YouTube, publish now.
  await dialog.getByRole('checkbox', { name: /^TikTok/ }).click()
  await dialog.getByRole('checkbox', { name: /^YouTube/ }).click()
  const privacy = dialog.getByLabel('Who can view this video')
  await privacy.waitFor()
  assert.equal(await privacy.textContent(), 'Choose who can view', 'TikTok privacy starts unselected')
  await dialog.getByText('Direct video posts from this TikTok Business connection are public.', { exact: false }).waitFor()
  await privacy.click()
  assert.equal(await page.getByRole('option', { name: /^Only me/ }).getAttribute('aria-disabled'), 'true', 'Business direct video cannot be private')
  await page.getByRole('option', { name: /^Only me/ }).click({ force: true })
  assert.equal(await privacy.textContent(), 'Choose who can view', 'a disabled option cannot be chosen')
  await privacy.press('Escape')
  await page.getByRole('listbox').waitFor({ state: 'detached' })
  assert.equal(await dialog.isVisible(), true, 'Escape closes only the menu, not the dialog')
  await dialog.getByRole('switch', { name: 'Send to your TikTok inbox' }).click()
  await privacy.click()
  assert.equal(await page.getByRole('option', { name: 'Only me', exact: true }).getAttribute('aria-disabled'), null, 'inbox delivery allows a private audience')
  await page.getByRole('option', { name: 'Only me', exact: true }).click()
  assert.equal(await privacy.textContent(), 'Only me')
  await dialog.getByRole('switch', { name: 'Send to your TikTok inbox' }).click()
  await dialog.getByText('Choose who can view the TikTok post.').waitFor()
  assert.equal(await privacy.textContent(), 'Choose who can view', 'switching back to direct posting clears a private choice')
  assert.equal(await dialog.getByRole('button', { name: 'Post now' }).isDisabled(), true, 'nothing is posted before TikTok choices are made')
  assert.equal(await dialog.getByRole('checkbox', { name: 'Stitch' }).isDisabled(), true, 'the creator turned Stitch off')
  await choose(page, privacy, 'Everyone')
  await dialog.getByRole('checkbox', { name: 'Comment' }).click()
  assert.equal(await dialog.getByRole('button', { name: 'Post now' }).isDisabled(), true, 'consent is still required')
  await dialog.getByRole('checkbox', { name: "By posting, you agree to TikTok's Music Usage Confirmation." }).click()
  await shot(page, '02-dialog-filled')
  await dialog.getByRole('button', { name: 'Post now' }).click()
  await dialog.getByRole('status').getByText('Posted', { exact: true }).waitFor({ timeout: 30_000 })
  await shot(page, '03-posted')

  assert.equal(posting.state.uploads.length, 1)
  const upload = posting.state.uploads[0]
  assert.equal(upload.bytes, fs.statSync(clipPath).size)
  assert.equal(upload.sha256, crypto.createHash('sha256').update(fs.readFileSync(clipPath)).digest('hex'))
  assert.equal(upload.contentType, 'video/mp4')
  assert.equal(upload.authorization, false)
  assert.equal(upload.transferEncoding, null)
  const presigns = mock.requestsTo('POST', '/api/v1/media/presign')
  assert.equal(presigns.length, 1)
  assert.equal(presigns[0].authorized, true)

  const now = posting.state.creates[0]
  assert.match(now.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(now.status, 201)
  assert.equal(now.body.publishNow, true)
  assert.equal(now.body.content, `${CLIP_TITLE}\n\n#AICoding #testing`)
  assert.deepEqual(now.body.mediaItems, [{ type: 'video', url: posting.state.presigned.get(upload.key).publicUrl }])
  assert.deepEqual(now.body.platforms.map((p) => [p.platform, p.accountId]).sort(), [['tiktok', tiktok._id], ['youtube', youtube._id]].sort())
  assert.deepEqual(now.body.platforms.find((p) => p.platform === 'youtube').platformSpecificData, { title: CLIP_TITLE, visibility: 'public', madeForKids: false })
  assert.deepEqual(now.body.tiktokSettings, { content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: false })
  assert.deepEqual(now.body.platforms.find((p) => p.platform === 'tiktok').platformSpecificData.tiktokSettings, {
    content_preview_confirmed: true,
    express_consent_given: true,
    video_made_with_ai: false,
    privacy_level: 'PUBLIC_TO_EVERYONE',
    allow_comment: true,
    allow_duet: false,
    allow_stitch: false
  })
  await dialog.getByRole('button', { name: 'Done' }).click()
  await dialog.waitFor({ state: 'detached' })

  // Instagram, scheduled two hours out.
  await page.getByRole('button', { name: `Post “${CLIP_TITLE}”` }).click()
  await dialog.getByRole('checkbox', { name: /^Instagram/ }).click()
  await dialog.getByRole('radio', { name: 'Schedule' }).click()
  const at = Math.ceil((Date.now() + 2 * 3_600_000) / 60_000) * 60_000
  await dialog.getByLabel('Publish date and time').fill(toLocalInput(at))
  await shot(page, '04-schedule')
  await dialog.getByRole('button', { name: 'Schedule' }).click()
  await dialog.getByRole('status').getByText('Scheduled', { exact: true }).waitFor({ timeout: 30_000 })
  await shot(page, '05-scheduled')

  const scheduled = posting.state.creates[1]
  assert.equal(scheduled.status, 201)
  assert.equal(scheduled.body.publishNow, undefined)
  assert.equal(scheduled.body.scheduledFor, new Date(at).toISOString())
  assert.equal(scheduled.body.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.deepEqual(scheduled.body.platforms, [{ platform: 'instagram', accountId: instagram._id, platformSpecificData: { shareToFeed: true } }])
  assert.notEqual(scheduled.requestId, now.requestId, 'each post gets its own x-request-id')
  assert.equal(posting.state.uploads.length, 2, 'a new dialog uploads again')

  // The Posts page: both entries, then cancel the scheduled one.
  await dialog.getByRole('button', { name: 'View posts' }).click()
  const scheduledGroup = page.getByRole('region', { name: 'Scheduled' })
  await scheduledGroup.getByText(CLIP_TITLE).waitFor({ timeout: 15_000 })
  const recentGroup = page.getByRole('region', { name: 'Recent' })
  await recentGroup.getByText(CLIP_TITLE).waitFor()
  await recentGroup.getByRole('button', { name: /Open on YouTube/ }).waitFor()
  // "View posts" opens the Posts page at the top.
  assert.ok(await page.getByRole('heading', { name: 'Posts', level: 1 }).evaluate((el) => {
    const box = el.getBoundingClientRect()
    return box.top >= 0 && box.bottom <= window.innerHeight
  }), 'the Posts page is in view')
  await shot(page, '06-posts-panel')

  const scheduledId = [...posting.state.posts.values()].find((p) => p.status === 'scheduled')._id
  await scheduledGroup.getByRole('button', { name: 'Cancel', exact: true }).click()
  await scheduledGroup.getByRole('button', { name: 'Cancel post' }).click()
  await scheduledGroup.waitFor({ state: 'detached', timeout: 15_000 })
  assert.equal(posting.state.posts.has(scheduledId), false, 'DELETE /v1/posts/{id} reached Zernio')
  assert.equal(mock.requestsTo('DELETE', `/api/v1/posts/${scheduledId}`).length, 1)
  await page.getByText(/^Cancelled · created/).waitFor()
  await shot(page, '07-cancelled')

  const historyPath = path.join(userDataDir, `zernio-posts-${crypto.createHash('sha256').update(KEY).digest('hex')}.json`)
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  assert.deepEqual(history.posts.map((p) => p.status).sort(), ['cancelled', 'published'])
  assert.equal(fs.readFileSync(historyPath, 'utf8').includes(KEY), false)
  // No request ever carried a key other than the test one, and storage never saw it.
  assert.ok(mock.state.requests.filter((r) => r.path.startsWith('/api/')).every((r) => r.authorized))
})

test('without a Zernio key the dialog points to Accounts', { timeout: 300_000 }, async (t) => {
  const { page, mock, openRun } = await start(t, { key: false })
  await openRun()
  await page.getByRole('button', { name: `Post “${CLIP_TITLE}”` }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Connect your social accounts').waitFor()
  await shot(page, '08-no-key')
  await dialog.getByRole('button', { name: 'Go to Accounts' }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('heading', { name: 'Accounts', level: 1 }).waitFor()
  assert.equal(mock.state.requests.length, 0, 'nothing reaches Zernio without a key')
})

test('Post on several selected clips posts them one after another with the same accounts', { timeout: 300_000 }, async (t) => {
  const second = 'The second clip in the run'
  const { page, posting, accounts, openRun } = await start(t, { titles: [CLIP_TITLE, second] })
  await openRun()
  await page.getByRole('checkbox', { name: 'Select all clips' }).click()
  await page.getByRole('button', { name: 'Post 2' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Post clip 1 of 2').waitFor()
  await dialog.getByRole('checkbox', { name: /^YouTube/ }).click()
  await dialog.getByRole('button', { name: 'Post now' }).click()
  await dialog.getByRole('status').getByText('Posted', { exact: true }).waitFor({ timeout: 30_000 })

  await dialog.getByRole('button', { name: 'Next clip (2 of 2)' }).click()
  await dialog.getByText('Post clip 2 of 2').waitFor()
  assert.equal(await dialog.getByLabel('Caption').inputValue(), `${second}\n\n#ClipTwo`)
  assert.equal(await dialog.getByRole('checkbox', { name: /^YouTube/ }).getAttribute('aria-checked'), 'true', 'accounts carry over')
  assert.equal(await dialog.getByLabel('Title').inputValue(), second)
  await shot(page, '09-next-clip')
  await dialog.getByRole('button', { name: 'Post now' }).click()
  await dialog.getByRole('status').getByText('Posted', { exact: true }).waitFor({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Done' }).click()

  assert.equal(posting.state.uploads.length, 2)
  assert.deepEqual(posting.state.creates.map((c) => c.body.platforms[0].platformSpecificData.title), [CLIP_TITLE, second])
  assert.ok(posting.state.creates.every((c) => c.body.platforms[0].accountId === accounts.youtube._id))
  assert.notEqual(posting.state.creates[0].body.mediaItems[0].url, posting.state.creates[1].body.mediaItems[0].url)
})

test('many accounts across profiles: several TikToks with their own privacy choices and two YouTube channels in one post', { timeout: 300_000 }, async (t) => {
  const { page, mock, posting, accounts, openRun } = await start(t)
  // A Zernio profile holds one account per platform, so more accounts mean more profiles.
  const brandB = mock.addProfile('Brand B')
  const brandC = mock.addProfile('Brand C')
  const tiktokB = mock.addAccount('tiktok', brandB._id, { username: 'brand_b' })
  const tiktokC = mock.addAccount('tiktok', brandC._id, { username: 'brand_c' })
  const youtubeB = mock.addAccount('youtube', brandB._id, { username: 'channel_b' })
  posting.state.creatorInfo[tiktokC._id] = {
    creator: { nickname: 'brand c', canPostMore: true },
    privacyLevels: [{ value: 'SELF_ONLY', label: 'Self Only' }, { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' }],
    postingLimits: { maxVideoDurationSec: 600, interactionSettings: { allow_comment: { enabled: false }, allow_duet: { enabled: true }, allow_stitch: { enabled: true } } },
    commercialContentTypes: []
  }
  // The app only knows the new accounts after a sync, as when you come back from connecting them.
  await page.evaluate(() => window.bridgeclip.zernio.sync())
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  await openRun()
  await page.getByRole('button', { name: `Post “${CLIP_TITLE}”` }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Select all TikTok accounts' }).click()
  await dialog.getByRole('button', { name: 'Select all YouTube accounts' }).click()
  assert.equal(await dialog.getByText('5 selected').isVisible(), true)
  assert.equal(await dialog.getByRole('checkbox', { name: 'TikTok @brand_c, Brand C' }).getAttribute('aria-checked'), 'true')
  await shot(page, '09-account-picker')

  // Each TikTok account has its own privacy options; Brand C doesn't offer "Everyone".
  const block = (heading) => dialog.getByRole('group', { name: `TikTok ${heading}` })
  const brandCBlock = block('@brand_c · Brand C')
  await brandCBlock.getByLabel('Who can view this video').waitFor()
  const offered = await menuOptions(page, brandCBlock.getByLabel('Who can view this video'))
  assert.deepEqual(offered, ['Only me', 'Followers'])
  assert.equal(await brandCBlock.getByRole('checkbox', { name: 'Comment' }).isDisabled(), true)
  await choose(page, block('@clipper · Default').getByLabel('Who can view this video'), 'Everyone')
  await choose(page, block('@brand_b · Brand B').getByLabel('Who can view this video'), 'Friends')
  await dialog.getByRole('checkbox', { name: "By posting, you agree to TikTok's Music Usage Confirmation." }).click()
  assert.equal(await dialog.getByRole('button', { name: 'Post now' }).isDisabled(), true, 'Brand C still needs its own choice')
  await choose(page, brandCBlock.getByLabel('Who can view this video'), 'Followers')
  await shot(page, '10-many-accounts')
  await dialog.getByRole('button', { name: 'Post now' }).click()
  await dialog.getByRole('status').getByText('Posted', { exact: true }).waitFor({ timeout: 30_000 })
  await shot(page, '11-many-posted')

  assert.equal(posting.state.uploads.length, 1)
  assert.equal(posting.state.creates.length, 1, 'one post for all five accounts')
  const entries = Object.fromEntries(posting.state.creates[0].body.platforms.map((p) => [p.accountId, p]))
  assert.deepEqual(Object.keys(entries).sort(), [accounts.tiktok._id, tiktokB._id, tiktokC._id, accounts.youtube._id, youtubeB._id].sort())
  assert.equal(entries[accounts.tiktok._id].platformSpecificData.tiktokSettings.privacy_level, 'PUBLIC_TO_EVERYONE')
  assert.equal(entries[tiktokB._id].platformSpecificData.tiktokSettings.privacy_level, 'MUTUAL_FOLLOW_FRIENDS')
  assert.equal(entries[tiktokC._id].platformSpecificData.tiktokSettings.privacy_level, 'FOLLOWER_OF_CREATOR')
  assert.equal(entries[tiktokC._id].platformSpecificData.tiktokSettings.allow_comment, false)
  assert.equal(mock.state.requests.filter((r) => r.path.endsWith('/tiktok/creator-info')).length, 3, 'creator info once per TikTok account')
  assert.equal(await dialog.getByRole('listitem').count(), 5)
})
