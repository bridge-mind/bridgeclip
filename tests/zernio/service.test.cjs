'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { loadMain, tempDir, fakeElectron } = require('./support/load-main.cjs')

const KEY = 'test-zernio-key-not-real-0001'

// The logger mirrors every line to the console; the log file is what these tests read.
for (const method of ['log', 'warn', 'error']) console[method] = () => {}
const ENTRY = `
  export * from './src/main/zernio/service'
  export { replaceApiKey, loadSettings } from './src/main/settings-store'
  export { getLogFilePath } from './src/main/logger'
  export { isCallbackPending } from './src/main/zernio/callback-server'
  export { resetRateLimit } from './src/main/zernio/client'
`

/** A fresh service (own module state and userData) wired to a fresh mock Zernio. */
async function setup(t, { isPackaged = false, key = KEY, browserHook = false, mockOptions } = {}) {
  const tmp = tempDir()
  const mock = await createMockZernio({ apiKey: KEY, ...mockOptions })
  const fake = fakeElectron(tmp.dir, { isPackaged })
  process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
  if (browserHook) process.env.BRIDGECLIP_E2E_BROWSER_URL = mock.browserUrl
  const service = loadMain(ENTRY, { electron: fake.electron })
  if (key) service.replaceApiKey('zernioApiKey', key)
  const getWindow = () => fake.window
  t.after(async () => {
    service.cancelZernioConnect()
    delete process.env.BRIDGECLIP_ZERNIO_API_URL
    delete process.env.BRIDGECLIP_E2E_BROWSER_URL
    await mock.close()
    tmp.cleanup()
  })
  const results = () => fake.calls.sent.filter((s) => s.channel === 'zernio:connectResult').map((s) => s.payload)
  /** Plays the user's browser: opens the URL the app handed to shell.openExternal. */
  const browse = async (url = fake.calls.openExternal.at(-1)) => {
    const res = await fetch(mock.browserUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    assert.equal(res.status, 204)
  }
  const log = () => (fs.existsSync(service.getLogFilePath()) ? fs.readFileSync(service.getLogFilePath(), 'utf8') : '')
  return { service, mock, fake, getWindow, results, browse, log, userData: path.join(tmp.dir, 'userData') }
}

test('connect: opens the platform sign-in, completes on the loopback redirect and raises the window', async (t) => {
  const { service, mock, fake, getWindow, results, browse, log } = await setup(t)
  const [profile] = mock.state.profiles
  fake.window.minimized = true

  const start = await service.connectZernioAccount('tiktok', profile._id, undefined, getWindow)
  assert.deepEqual(start, { status: 'pending', platform: 'tiktok', profileId: profile._id })
  assert.equal(fake.calls.openExternal.length, 1)
  assert.match(fake.calls.openExternal[0], /^https:\/\/www\.tiktok\.com\/v2\/auth\/authorize\//)
  assert.deepEqual({ ...service.getPendingZernioConnect(), startedAt: 0 }, { platform: 'tiktok', profileId: profile._id, reconnect: false, startedAt: 0 })
  const redirect = mock.state.sessions[0].redirectUrl
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/zernio\/connected\/[a-f0-9]{32}$/)

  mock.setBrowser('tiktok', { noise: true, then: 'success' })
  await browse()
  await mock.waitFor(() => results().length === 1)
  const [result] = results()
  assert.equal(result.success, true)
  assert.equal(result.platform, 'tiktok')
  assert.equal(result.username, 'tiktok_creator')
  assert.match(result.accountId, /^[a-f0-9]{24}$/)
  assert.equal('connect_token' in result, false)
  assert.equal(service.getPendingZernioConnect(), null)
  assert.equal(service.isCallbackPending(), false)
  assert.equal(fake.calls.restored, 1)
  assert.equal(fake.calls.shown, 1)
  assert.equal(fake.calls.focused, 1)
  if (process.platform === 'darwin') assert.deepEqual(fake.calls.focus, [{ steal: true }])

  const visits = mock.state.visits
  assert.equal(visits.find((v) => v.url.endsWith('/favicon.ico')).status, 404)
  assert.equal(visits.filter((v) => v.url === visits.at(-1).url && !v.url.endsWith('favicon.ico')).length >= 1, true)
  assert.equal(visits.find((v) => v.repeat).status, 0, 'a refresh after completion finds the one-shot server gone')
  assert.equal(results().length, 1, 'favicon and revisits never produce a second result')

  const text = log()
  for (const secret of [KEY, 'ct_mock_not_a_secret', 'tiktok_creator', 'zernio/connected', 'state=']) assert.equal(text.includes(secret), false, `log must not contain ${secret}`)
})

test('connect: Zernio appending params with ? still completes', async (t) => {
  const { service, mock, getWindow, results, browse } = await setup(t)
  mock.setBrowser('linkedin', 'success-question-mark')
  await service.connectZernioAccount('linkedin', mock.state.profiles[0]._id, {}, getWindow)
  await browse()
  await mock.waitFor(() => results().length === 1)
  assert.equal(results()[0].success, true)
  assert.equal(results()[0].username, 'linkedin_creator')
})

test('connect: error redirects become friendly, sanitised messages', async (t) => {
  const { service, mock, getWindow, results, browse } = await setup(t)
  const profileId = mock.state.profiles[0]._id
  const scenarios = [
    ['instagram', { error: 'oauth_denied' }, /Instagram sign-in was cancelled/, false],
    ['tiktok', { error: 'missing_tiktok_permissions' }, /every permission/, false],
    ['twitter', { error: 'payment_required', params: { reason: 'twitter_passthrough', dashboard_url: 'https://zernio.com/x' } }, /payment method on file before it can connect X/, true],
    ['facebook', { error: 'no_facebook_pages' }, /doesn't manage any Pages/, false],
    ['threads', { error: 'one_threads_per_profile' }, /already has a Threads account/, false],
    ['youtube', { error: 'brand_new_code', params: { error_message: 'We could not find a channel https://evil.test/?t=token_mockCredential123456 <b>' } }, /^Zernio couldn't connect YouTube: We could not find a channel \[link\] <b>$/, false]
  ]
  for (const [platform, behaviour, pattern, billing] of scenarios) {
    mock.setBrowser(platform, behaviour)
    const start = await service.connectZernioAccount(platform, profileId, undefined, getWindow)
    assert.equal(start.status, 'pending')
    const before = results().length
    await browse()
    await mock.waitFor(() => results().length === before + 1)
    const result = results().at(-1)
    assert.equal(result.success, false, platform)
    assert.match(result.error, pattern)
    assert.equal(Boolean(result.billing), billing, `${platform} billing flag`)
    assert.equal(/evil\.test|mockCredential/.test(result.error), false)
  }
})

test('connect: already connected needs no browser; reconnect forces a fresh sign-in', async (t) => {
  const { service, mock, fake, getWindow, results, browse } = await setup(t)
  const profileId = mock.state.profiles[0]._id
  const existing = mock.addAccount('youtube', profileId, { username: 'mychannel' })
  mock.setConnectResponse('youtube', 'alreadyConnected')

  const start = await service.connectZernioAccount('youtube', profileId, undefined, getWindow)
  assert.deepEqual(start, { status: 'connected', platform: 'youtube', profileId, accountId: existing._id, username: 'mychannel' })
  assert.equal(fake.calls.openExternal.length, 0)
  assert.equal(service.isCallbackPending(), false)

  mock.setHealth(existing._id, { status: 'error', needsReconnect: true })
  const again = await service.connectZernioAccount('youtube', profileId, { reconnect: true }, getWindow)
  assert.equal(again.status, 'pending')
  assert.equal(mock.state.sessions.at(-1).force, true)
  await browse()
  await mock.waitFor(() => results().length === 1)
  assert.equal(results()[0].success, true)
  const overview = await service.getZernioOverview()
  const repaired = overview.accounts.find((a) => a.platform === 'youtube')
  assert.equal(repaired.needsReconnect, false)
  assert.equal(repaired.username, 'mychannel', 'reconnecting keeps the same account')
})

test('connect: an unexpected sign-in host is never opened and only its hostname is logged', async (t) => {
  const { service, mock, fake, getWindow, log } = await setup(t)
  mock.setConnectResponse('facebook', 'untrustedHost')
  const start = await service.connectZernioAccount('facebook', mock.state.profiles[0]._id, undefined, getWindow)
  assert.equal(start.status, 'failed')
  assert.match(start.error.message, /unexpected site \(login\.example-phish\.test\)/)
  assert.equal(fake.calls.openExternal.length, 0)
  assert.equal(service.isCallbackPending(), false)
  assert.equal(service.getPendingZernioConnect(), null)
  const text = log()
  assert.match(text, /zernio\.connect\.untrustedLink/)
  assert.match(text, /login\.example-phish\.test/)
  assert.equal(text.includes('client_id'), false)
})

test('connect: API failures come back as structured errors the UI can act on', async (t) => {
  const { service, mock, fake, getWindow } = await setup(t)
  const profileId = mock.state.profiles[0]._id
  mock.failNext('GET', '/api/v1/connect/twitter', 402, { error: 'X needs a card', code: 'PAYMENT_REQUIRED', reason: 'twitter_passthrough' })
  const paid = await service.connectZernioAccount('twitter', profileId, undefined, getWindow)
  assert.equal(paid.status, 'failed')
  assert.equal(paid.error.kind, 'payment')
  assert.equal(paid.error.billing, true)

  mock.failNext('GET', '/api/v1/connect/tiktok', 400, { error: 'bad', code: 'INVALID_REDIRECT_URL' })
  const redirect = await service.connectZernioAccount('tiktok', profileId, undefined, getWindow)
  assert.match(redirect.error.message, /local sign-in return address/)

  const other = await service.connectZernioAccount('tiktok', 'f'.repeat(24), undefined, getWindow)
  assert.equal(other.error.kind, 'not_found')
  assert.equal(fake.calls.openExternal.length, 0)
  assert.equal(service.isCallbackPending(), false)
})

test('connect: with no profile it uses the default one, or creates one for BridgeClip', async (t) => {
  const { service, mock, getWindow } = await setup(t, { mockOptions: { withDefaultProfile: false } })
  const first = await service.connectZernioAccount('threads', null, undefined, getWindow)
  assert.equal(first.status, 'pending')
  assert.equal(mock.state.profiles.length, 1)
  assert.equal(mock.state.profiles[0].name, 'BridgeClip')
  assert.equal(first.profileId, mock.state.profiles[0]._id)
  const second = await service.connectZernioAccount('threads', null, undefined, getWindow)
  assert.equal(second.profileId, first.profileId, 'no duplicate profile')
  assert.equal(mock.requestsTo('POST', '/api/v1/profiles').length, 1)
})

test('connect: a named new profile is created, returned, and kept after sign-in', async (t) => {
  const { service, mock, getWindow, browse, results } = await setup(t)
  const start = await service.connectZernioAccount('youtube', null, { newProfileName: '  Clips  ' }, getWindow)
  assert.equal(start.status, 'pending')
  assert.equal(start.createdProfile.name, 'Clips')
  assert.equal(start.profileId, start.createdProfile.id)
  assert.equal(service.getPendingZernioConnect().createdProfile, true)
  await browse()
  await mock.waitFor(() => results().length === 1)
  assert.equal(results()[0].success, true)
  assert.ok(mock.state.profiles.some((profile) => profile._id === start.profileId))
  assert.ok(mock.state.accounts.some((account) => account.profileId._id === start.profileId))
})

test('connect: scoped key denial preserves the created profile and logs the failing stage without secrets', async (t) => {
  const { service, mock, getWindow, fake, log } = await setup(t)
  await service.syncZernioAccounts()
  const denied = { error: 'This API key does not have access to this profile', code: 'access_denied', platformError: { token: 'private-provider-token' } }
  mock.failNext('GET', '/api/v1/connect/youtube', 403, denied)
  mock.failNext('GET', '/api/v1/accounts', 403, denied)
  const start = await service.connectZernioAccount('youtube', null, { newProfileName: 'Private brand name' }, getWindow)
  assert.equal(start.status, 'failed')
  assert.equal(start.error.kind, 'auth')
  assert.match(start.error.message, /profile was created/)
  assert.match(start.error.message, /Full access/)
  assert.equal(start.createdProfile.id, start.profileId)
  assert.ok(service.readCachedOverview().profiles.some((p) => p.id === start.profileId))
  assert.equal(fake.calls.openExternal.length, 0)
  assert.equal(service.isCallbackPending(), false)
  assert.equal(mock.requestsTo('POST', '/api/v1/profiles').length, 1)
  assert.equal(mock.requestsTo('DELETE', `/api/v1/profiles/${start.profileId}`).length, 0)
  const entries = log().trim().split('\n').map(JSON.parse)
  const failure = entries.find((entry) => entry.event === 'zernio.connect.failed')
  assert.equal(failure.stage, 'authorize_platform')
  assert.equal(failure.profileCreated, true)
  assert.equal(failure.profileRemoved, false)
  const requests = entries.filter((entry) => entry.traceId === failure.traceId)
  assert.ok(requests.some((entry) => entry.event === 'zernio.request.completed' && entry.operation === 'profiles' && entry.method === 'POST' && entry.status === 201))
  assert.ok(requests.some((entry) => entry.event === 'zernio.request.failed' && entry.operation === 'connect.youtube' && entry.category === 'profile_access_denied' && entry.status === 403))
  for (const secret of [KEY, 'private-provider-token', 'Private brand name', start.profileId, 'redirect_url', 'Authorization']) assert.equal(log().includes(secret), false)
})

test('connect: successful cleanup does not return a deleted profile', async (t) => {
  const { service, mock, getWindow } = await setup(t)
  mock.failNext('GET', '/api/v1/connect/youtube', 403, { error: 'This API key does not have access to this profile' })
  const start = await service.connectZernioAccount('youtube', null, { newProfileName: 'Removed brand' }, getWindow)
  assert.equal(start.status, 'failed')
  assert.equal(start.createdProfile, undefined)
  assert.equal(mock.state.profiles.length, 1)
  assert.doesNotMatch(start.error.message, /profile was created/)
})

test('connect: a new profile is removed when sign-in fails or is cancelled', async (t) => {
  const { service, mock, getWindow, browse, results } = await setup(t)
  mock.setBrowser('linkedin', { error: 'oauth_denied' })
  const failed = await service.connectZernioAccount('linkedin', null, { newProfileName: 'Failed sign-in' }, getWindow)
  assert.equal(failed.status, 'pending')
  await browse()
  await mock.waitFor(() => results().length === 1)
  await mock.waitFor(() => !mock.state.profiles.some((profile) => profile._id === failed.profileId))

  const cancelled = await service.connectZernioAccount('tiktok', null, { newProfileName: 'Cancelled sign-in' }, getWindow)
  assert.equal(cancelled.status, 'pending')
  service.cancelZernioConnect()
  await mock.waitFor(() => !mock.state.profiles.some((profile) => profile._id === cancelled.profileId))
})

test('connect: cancellation keeps a new profile when the account connected without a redirect', async (t) => {
  const { service, mock, getWindow, browse } = await setup(t)
  mock.setBrowser('youtube', 'no-redirect')
  const start = await service.connectZernioAccount('youtube', null, { newProfileName: 'Already connected' }, getWindow)
  await browse()
  await mock.waitFor(() => mock.state.accounts.some((account) => account.profileId._id === start.profileId))
  service.cancelZernioConnect()
  await mock.waitFor(() => mock.requestsTo('GET', '/api/v1/accounts').some((request) => request.query.profileId === start.profileId))
  assert.ok(mock.state.profiles.some((profile) => profile._id === start.profileId))
})

test('connect: validates every IPC input', async (t) => {
  const { service, getWindow, mock } = await setup(t)
  const ok = mock.state.profiles[0]._id
  for (const [platform, profileId, options] of [
    ['myspace', ok, undefined],
    [{ toString: () => 'tiktok' }, ok, undefined],
    ['tiktok', '../../accounts', undefined],
    ['tiktok', 42, undefined],
    ['tiktok', ok, { reconnect: 'yes' }],
    ['tiktok', ok, { reconnect: true, headless: true }],
    ['tiktok', ok, { newProfileName: 'Existing profile supplied' }],
    ['tiktok', null, { newProfileName: '   ' }],
    ['tiktok', null, { newProfileName: 'Clips', reconnect: true }],
    ['tiktok', ok, []]
  ]) {
    await assert.rejects(service.connectZernioAccount(platform, profileId, options, getWindow))
  }
  await assert.rejects(service.disconnectZernioAccount('../x'))
  await assert.rejects(service.disconnectZernioAccount(null))
  assert.equal(mock.requestsTo('GET', '/api/v1/connect').length, 0)
})

test('connect: a new sign-in replaces a pending one, and cancel stops it', async (t) => {
  const { service, mock, getWindow, results } = await setup(t)
  const profileId = mock.state.profiles[0]._id
  await service.connectZernioAccount('tiktok', profileId, undefined, getWindow)
  const firstRedirect = mock.state.sessions[0].redirectUrl
  await service.connectZernioAccount('linkedin', profileId, undefined, getWindow)
  assert.equal(service.getPendingZernioConnect().platform, 'linkedin')
  await assert.rejects(fetch(`${firstRedirect}?connected=tiktok`))
  service.cancelZernioConnect()
  assert.equal(service.getPendingZernioConnect(), null)
  await assert.rejects(fetch(`${mock.state.sessions[1].redirectUrl}?connected=linkedin`))
  assert.equal(results().length, 0)
})

test('connect: a slow older start cannot replace a newer sign-in', async (t) => {
  const { service, mock, fake, getWindow, results, browse } = await setup(t)
  const profileId = mock.state.profiles[0]._id
  let releaseFirst
  let firstStarted
  const started = new Promise((resolve) => { firstStarted = resolve })
  const released = new Promise((resolve) => { releaseFirst = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(`${mock.apiUrl}/connect/tiktok?`)) {
      firstStarted()
      await released
      return new Response(JSON.stringify({ authUrl: 'https://www.tiktok.com/v2/auth/authorize/?test=1' }), { status: 200 })
    }
    return originalFetch(url, options)
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const first = service.connectZernioAccount('tiktok', profileId, undefined, getWindow)
  await started
  const second = await service.connectZernioAccount('linkedin', profileId, undefined, getWindow)
  assert.equal(second.status, 'pending')
  releaseFirst()
  assert.equal((await first).status, 'failed')
  assert.equal(service.getPendingZernioConnect()?.platform, 'linkedin')
  assert.equal(fake.calls.openExternal.length, 1, 'the cancelled sign-in does not open a browser')
  await browse()
  await mock.waitFor(() => results().length === 1)
  assert.equal(results()[0].platform, 'linkedin')
})

test('connect: gives up after 10 minutes without a redirect and says so', async (t) => {
  const { service, mock, getWindow, results } = await setup(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const start = await service.connectZernioAccount('facebook', mock.state.profiles[0]._id, undefined, getWindow)
  assert.equal(start.status, 'pending')
  t.mock.timers.tick(10 * 60 * 1000 - 1)
  assert.equal(results().length, 0)
  t.mock.timers.tick(1)
  assert.equal(results().length, 1)
  assert.equal(results()[0].ended, 'timeout')
  assert.match(results()[0].error, /stopped waiting for the browser after 10 minutes/)
  assert.equal(service.getPendingZernioConnect(), null)
  assert.equal(service.isCallbackPending(), false)
})

test('dev hooks: the scripted browser is used only in unpackaged builds', async (t) => {
  const { service, mock, fake, getWindow, results } = await setup(t, { browserHook: true })
  process.env.BRIDGECLIP_E2E = '1'
  t.after(() => { delete process.env.BRIDGECLIP_E2E })
  await service.connectZernioAccount('instagram', mock.state.profiles[0]._id, undefined, getWindow)
  assert.equal(fake.calls.openExternal.length, 0)
  assert.equal(mock.state.opened.length, 1)
  await mock.waitFor(() => results().length === 1)
  assert.equal(results()[0].success, true)
  assert.equal(fake.calls.shown + fake.calls.focused + fake.calls.focus.length, 0, 'test runs never raise or focus the window')
})

test('dev hooks: packaged builds ignore the mock API and scripted-browser variables', async (t) => {
  const { service, mock, fake, getWindow } = await setup(t, { isPackaged: true, browserHook: true })
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(String(url))
    if (String(url).startsWith('https://zernio.com/api/v1/connect/')) {
      return new Response(JSON.stringify({ authUrl: 'https://www.linkedin.com/oauth/v2/authorization?x=1' }), { status: 200 })
    }
    return realFetch(url, init)
  }
  t.after(() => { globalThis.fetch = realFetch })
  const start = await service.connectZernioAccount('linkedin', mock.state.profiles[0]._id, undefined, getWindow)
  assert.equal(start.status, 'pending')
  assert.equal(seen.some((u) => u.startsWith(mock.url)), false, 'the mock API URL is ignored')
  assert.equal(seen[0].startsWith('https://zernio.com/api/v1/connect/linkedin?'), true)
  assert.equal(fake.calls.openExternal.length, 1, 'the real browser is used')
  assert.equal(mock.state.opened.length, 0)
})

test('sync: caches the overview for offline use and reports why data is stale', async (t) => {
  const { service, mock, userData } = await setup(t)
  const profileId = mock.state.profiles[0]._id
  const account = mock.addAccount('tiktok', profileId, { username: 'cached_user' })
  mock.setHealth(account._id, { status: 'warning', issues: ['Token expiring'], integrationLane: 'business' })

  const live = await service.syncZernioAccounts()
  assert.equal(live.stale, false)
  assert.equal(live.error, null)
  assert.equal(live.overview.accounts[0].health, 'warning')
  assert.equal(live.overview.accounts[0].integrationLane, 'business')
  const cacheFile = path.join(userData, 'zernio-accounts.json')
  if (process.platform !== 'win32') assert.equal(fs.statSync(cacheFile).mode & 0o077, 0, 'cache is private to the user')
  const raw = fs.readFileSync(cacheFile, 'utf8')
  assert.equal(raw.includes(KEY), false)
  assert.equal(raw.includes('enc:'), false)

  const cached = service.readCachedOverview()
  assert.deepEqual(cached, live.overview)

  // Health failing is not fatal.
  mock.state.healthFails = true
  const withoutHealth = await service.syncZernioAccounts()
  assert.equal(withoutHealth.stale, false)
  assert.equal(withoutHealth.overview.accounts[0].health, null)
  mock.state.healthFails = false

  await mock.close()
  const offline = await service.syncZernioAccounts()
  assert.equal(offline.stale, true)
  assert.equal(offline.error.kind, 'offline')
  assert.equal(offline.overview.accounts[0].username, 'cached_user')

  // A tampered cache can't smuggle odd values to the renderer.
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 2, workspace: JSON.parse(raw).workspace, syncedAt: 5, profiles: [{ id: '<img>', name: 'x' }], accounts: [{ id: 'a'.repeat(24), platform: '<svg>' }, { id: 'b'.repeat(24), platform: 'tiktok', username: 'x'.repeat(500), health: 'pwned', integrationLane: 'untrusted' }] }))
  const cleaned = service.readCachedOverview()
  assert.equal(cleaned.profiles.length, 0)
  assert.equal(cleaned.accounts.length, 1)
  assert.equal(cleaned.accounts[0].username, null)
  assert.equal(cleaned.accounts[0].health, null)
  assert.equal(cleaned.accounts[0].integrationLane, null)
})

test('sync: a rejected key is an auth error; no key means no cache', async (t) => {
  const { service } = await setup(t, { key: 'wrong-key-000' })
  const result = await service.syncZernioAccounts()
  assert.equal(result.error.kind, 'auth')
  assert.match(result.error.message, /rejected your API key/)
  service.replaceApiKey('zernioApiKey', '')
  assert.equal(service.readCachedOverview(), null)
  const none = await service.syncZernioAccounts()
  assert.equal(none.error.kind, 'auth')
  assert.match(none.error.message, /Add your Zernio API key/)
})

test('legacy and oversized account caches are never shown and legacy data is quarantined privately', async (t) => {
  const { service, userData } = await setup(t)
  const file = path.join(userData, 'zernio-accounts.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ id: 'a'.repeat(24), name: 'Old workspace' }], accounts: [] }))
  assert.equal(service.readCachedOverview(), null)
  const quarantined = fs.readdirSync(userData).find((name) => name.startsWith('zernio-accounts.json.quarantine-'))
  assert.ok(quarantined)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(userData, quarantined)).mode & 0o077, 0)
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1))
  assert.equal(service.readCachedOverview(), null)
})

test('reset: a different key drops the cache, the pending sign-in and tells the renderer', async (t) => {
  const { service, mock, fake, getWindow, userData } = await setup(t)
  let listenerCalls = 0
  service.onZernioReset(() => { listenerCalls += 1 })
  await service.syncZernioAccounts()
  await service.connectZernioAccount('tiktok', mock.state.profiles[0]._id, undefined, getWindow)
  assert.equal(fs.existsSync(path.join(userData, 'zernio-accounts.json')), true)

  // A request that started with the old key must not refill the cache after the reset.
  const inflight = service.getZernioOverview()
  service.replaceApiKey('zernioApiKey', 'another-workspace-key')
  service.resetZernioState(getWindow)
  await inflight.catch(() => {})
  assert.equal(fs.existsSync(path.join(userData, 'zernio-accounts.json')), false)
  assert.equal(service.getPendingZernioConnect(), null)
  assert.equal(service.isCallbackPending(), false)
  assert.equal(listenerCalls, 1)
  assert.deepEqual(fake.calls.sent.filter((s) => s.channel === 'zernio:reset').map((s) => s.payload), [{ configured: true }])

  service.replaceApiKey('zernioApiKey', '')
  service.resetZernioState(getWindow)
  assert.deepEqual(fake.calls.sent.filter((s) => s.channel === 'zernio:reset').at(-1).payload, { configured: false })
})

test('disconnect: removes the account from Zernio and the cache; already-gone is fine', async (t) => {
  const { service, mock } = await setup(t)
  const account = mock.addAccount('linkedin', mock.state.profiles[0]._id)
  await service.syncZernioAccounts()
  await service.disconnectZernioAccount(account._id)
  assert.equal(mock.state.accounts.length, 0)
  assert.equal(service.readCachedOverview().accounts.length, 0)
  await service.disconnectZernioAccount(account._id)
})

test('describeConnectError covers the documented redirect codes', () => {
  const tmp = tempDir()
  try {
    const { describeConnectError } = loadMain(ENTRY, { electron: fakeElectron(tmp.dir).electron })
    const codes = ['oauth_denied', 'connection_cancelled', 'session_expired', 'missing_tiktok_permissions', 'missing_google_permissions',
      'personal_account_not_supported', 'no_facebook_pages', 'facebook_pages_error', 'platform_requires_destination', 'reconnect_account_mismatch',
      'payment_required', 'account_limit_exceeded', 'profile_limit_exceeded', 'profile_not_found', 'invalid_profile_id', 'access_denied',
      'unsupported_platform', 'byok_config_error', 'one_whatsapp_per_profile', 'token_exchange_failed', 'internal_error', '<script>']
    for (const code of codes) {
      const { message } = describeConnectError('instagram', new URLSearchParams({ error: code, platform: 'instagram' }))
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 20 && message.length < 240, code)
      assert.equal(message.includes('<script>'), false)
    }
    assert.equal(describeConnectError('twitter', new URLSearchParams({ error: 'payment_required', reason: 'free_tier_exceeded' })).billing, true)
  } finally { tmp.cleanup() }
})
