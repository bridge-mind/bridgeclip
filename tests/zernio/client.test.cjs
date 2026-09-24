'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { loadMain } = require('./support/load-main.cjs')

const KEY = 'test-zernio-key'
const load = () => loadMain("export * from './src/main/zernio/client'", {
  electron: {},
  '../logger': { logger: { info() {}, warn() {}, error() {} } }
})

async function withMock(fn, options) {
  const mock = await createMockZernio({ apiKey: KEY, ...options })
  try {
    const client = load()
    await fn({ mock, client, api: new client.ZernioClient(KEY, mock.apiUrl) })
  } finally {
    await mock.close()
  }
}

test('parses profiles, accounts and health from Zernio shapes', () => withMock(async ({ mock, api }) => {
  const [profile] = mock.state.profiles
  const tiktok = mock.addAccount('tiktok', profile._id, { username: '@@creator\u0007', displayName: 'Creator' })
  const yt = mock.addAccount('youtube', profile._id, { needsReconnection: true })
  mock.setHealth(tiktok._id, { status: 'warning', issues: ['Token expires soon, see https://example.test/help?token=abc'], canPost: true, integrationLane: 'business' })
  mock.setHealth(yt._id, { status: 'error', needsReconnect: true, issues: ['Token expired'], canPost: false })
  // An account id that isn't an id, and a platform with odd characters, are dropped.
  mock.state.accounts.push({ _id: '../../etc', platform: 'tiktok', profileId: profile._id })
  mock.state.accounts.push({ _id: 'c'.repeat(24), platform: 'Tik Tok!', profileId: profile._id })

  const profiles = await api.listProfiles()
  assert.deepEqual(profiles, [{ id: profile._id, name: 'Default', isDefault: true }])

  const accounts = await api.listAccounts()
  assert.equal(accounts.length, 2)
  const parsedTikTok = accounts.find((a) => a.platform === 'tiktok')
  assert.equal(parsedTikTok.username, 'creator')
  assert.equal(parsedTikTok.profileId, profile._id, 'populated profileId objects are unwrapped')
  assert.equal(accounts.find((a) => a.platform === 'youtube').needsReconnect, true, 'needsReconnection from /accounts counts')

  const health = await api.getAccountsHealth()
  assert.equal(health.get(tiktok._id).health, 'warning')
  assert.equal(health.get(tiktok._id).needsReconnect, false)
  assert.equal(health.get(tiktok._id).issue.includes('example.test'), false, 'links are stripped from issues')
  assert.deepEqual({ ...health.get(yt._id) }, { health: 'error', needsReconnect: true, issue: 'Token expired', canPost: false })
  assert.equal(await api.getTikTokIntegrationLane(tiktok._id), 'business')
  mock.setHealth(tiktok._id, { integrationLane: 'unexpected' })
  assert.equal(await api.getTikTokIntegrationLane(tiktok._id), null)
  assert.equal(await api.getTikTokIntegrationLane(yt._id), null)
}))

test('accepts bare-array and wrapped list responses', () => withMock(async ({ mock, api }) => {
  mock.route({ method: 'GET', path: '/api/v1/profiles', handler: (ctx) => ctx.json(200, [{ id: 'd'.repeat(24), name: 'Bare' }]) })
  mock.route({ method: 'GET', path: '/api/v1/accounts', handler: (ctx) => ctx.json(200, { data: [{ id: 'e'.repeat(24), platform: 'linkedin', profileId: 'd'.repeat(24) }] }) })
  assert.deepEqual(await api.listProfiles(), [{ id: 'd'.repeat(24), name: 'Bare' }])
  assert.equal((await api.listAccounts())[0].platform, 'linkedin')
}))

test('profile access denials explain key scope and are never mistaken for a plan limit', () => withMock(async ({ mock, api }) => {
  for (const code of [undefined, 'access_denied', 'profile_access_denied']) {
    mock.failNext('POST', '/api/v1/profiles', 403, { error: 'This API key does not have access to this profile', code })
    await assert.rejects(api.createProfile('New brand'), (error) => {
      assert.equal(error.code, 'profile_access_denied')
      assert.match(error.message, /Full access/)
      assert.match(error.message, /Settings/)
      assert.doesNotMatch(error.message, /plan.*limit/)
      return true
    })
  }
  mock.failNext('POST', '/api/v1/profiles', 403, { error: 'Forbidden' })
  await assert.rejects(api.createProfile('New brand'), (error) => !/plan.*limit/.test(error.message))
  mock.failNext('POST', '/api/v1/profiles', 403, { error: 'Profile limit reached' })
  await assert.rejects(api.createProfile('New brand'), (error) => error.code === 'profile_limit')
}))

test('only a documented content conflict is treated as a duplicate post', () => withMock(async ({ mock, client, api }) => {
  mock.route({ method: 'POST', path: '/api/v1/posts', handler: (ctx) => ctx.json(409, { error: 'Account is already connected', code: 'account_conflict' }) })
  await assert.rejects(api.createPost({}, 'request-one', 1000), (error) =>
    error instanceof client.ZernioApiError && !(error instanceof client.ZernioDuplicatePostError) && error.status === 409)
}))

test('legacy duplicate details work when Zernio changes its human-readable error', () => withMock(async ({ mock, client, api }) => {
  const existingPostId = 'p'.repeat(24)
  mock.route({ method: 'POST', path: '/api/v1/posts', handler: (ctx) => ctx.json(409, {
    error: 'This request conflicts with a recent publish.',
    details: { existingPostId, accountId: 'a'.repeat(24), platform: 'youtube' }
  }) })
  await assert.rejects(api.createPost({}, 'request-two', 1000), (error) =>
    error instanceof client.ZernioDuplicatePostError && error.existingPostId === existingPostId && error.platform === 'youtube')
}))

test('maps Zernio error codes to friendly text without echoing provider payloads', () => withMock(async ({ mock, client, api }) => {
  const bad = new client.ZernioClient('not-the-key', mock.apiUrl)
  await assert.rejects(bad.listProfiles(), (e) => e.status === 401 && /rejected your API key/.test(e.message))

  const cases = [
    [402, { error: 'x', code: 'PAYMENT_REQUIRED', reason: 'twitter_passthrough', dashboard_url: 'https://zernio.com/dashboard' }, /payment method on file before it can connect X/],
    [402, { error: 'x', code: 'PAYMENT_REQUIRED', reason: 'free_tier_exceeded' }, /used its free connected accounts/],
    [402, { error: 'x', code: 'PAYMENT_REQUIRED', reason: 'card_verification_required' }, /verify your card/],
    [402, { error: 'x', code: 'PAYMENT_REQUIRED', reason: 'enterprise_required' }, /contract/],
    [403, { error: 'Snapchat is in beta', code: 'PLATFORM_BETA_RESTRICTED' }, /closed beta/],
    [403, { error: 'nope', type: 'permission_error', code: 'insufficient_permissions' }, /isn't allowed/],
    [400, { error: 'bad redirect', code: 'INVALID_REDIRECT_URL' }, /local sign-in return address/],
    [404, { error: 'Profile not found', code: 'profile_not_found' }, /couldn't find that: Profile not found/],
    [503, { error: 'db down', code: 'temporarily_unavailable' }, /temporarily unavailable/],
    [500, { error: 'private-provider-token', platformError: { access_token: 'secret' } }, /HTTP 500/]
  ]
  for (const [status, body, pattern] of cases) {
    mock.failNext('GET', '/api/v1/profiles', status, body, status === 503 ? { 'Retry-After': '5' } : {})
    await assert.rejects(api.listProfiles(), (e) => {
      assert.equal(e.status, status)
      assert.match(e.message, pattern)
      assert.equal(e.message.includes('private-provider-token'), false)
      assert.equal(e.message.includes('secret'), false)
      assert.equal(e.message.includes('zernio.com/dashboard'), false)
      return true
    })
  }

  // Unmapped 4xx: Zernio's own message, with links and token-like strings removed.
  mock.failNext('GET', '/api/v1/profiles', 422, { error: 'Bad value near https://evil.test/x?t=1 with key token_mockCredential123456 and Bearer abc.def', code: 'invalid_field_value' })
  await assert.rejects(api.listProfiles(), (e) => {
    assert.match(e.message, /^Zernio couldn't complete the request: Bad value near \[link\]/)
    assert.equal(/evil\.test|mockCredential|abc\.def/.test(e.message), false)
    assert.equal(e.code, 'invalid_field_value')
    return true
  })
}))

test('a 429 closes a shared gate so no further requests are spent until Retry-After', () => withMock(async ({ mock, client, api }) => {
  mock.failNext('GET', '/api/v1/accounts', 429, { error: 'Rate limit exceeded. Please retry after 30 seconds.', details: { retryAfterSeconds: 30 } }, { 'Retry-After': '30' })
  await assert.rejects(api.listAccounts(), (e) => e.status === 429 && e.retryAfterSeconds === 30 && /Try again in 30s/.test(e.message))
  const before = mock.state.requests.length
  // A different client instance (e.g. the posting code) shares the gate.
  await assert.rejects(new client.ZernioClient(KEY, mock.apiUrl).listProfiles(), (e) => e.status === 429 && e.retryAfterSeconds <= 30)
  assert.equal(mock.state.requests.length, before, 'no request reached Zernio while rate limited')
  client.resetRateLimit()
  assert.equal((await api.listProfiles()).length, 1)
}))

test('a 503 exposes Retry-After to callers without closing the rate-limit gate', () => withMock(async ({ mock, api }) => {
  mock.failNext('GET', '/api/v1/profiles', 503, { type: 'api_error', code: 'temporarily_unavailable' }, { 'Retry-After': '7' })
  await assert.rejects(api.listProfiles(), (e) => e.status === 503 && e.retryAfterSeconds === 7 && /Try again in 7s/.test(e.message))
  assert.equal((await api.listProfiles()).length, 1)

  const retryAt = new Date(Date.now() + 10_000).toUTCString()
  mock.failNext('GET', '/api/v1/profiles', 503, { type: 'api_error', code: 'temporarily_unavailable' }, { 'Retry-After': retryAt })
  await assert.rejects(api.listProfiles(), (e) => e.status === 503 && e.retryAfterSeconds >= 8 && e.retryAfterSeconds <= 10)
}))

test('X-RateLimit-Remaining: 0 on a success also waits for the reset', () => withMock(async ({ mock, client, api }) => {
  await api.listProfiles()
  await api.listProfiles()
  await assert.rejects(api.listProfiles(), (e) => e.status === 429)
  assert.equal(mock.state.requests.length, 2, 'the third call never left the app')
  client.resetRateLimit()
}, { rateLimit: 2 }))

test('network failures read as offline', async () => {
  const client = load()
  const api = new client.ZernioClient(KEY, 'http://127.0.0.1:9/api/v1')
  await assert.rejects(api.listProfiles(), (e) => e.status === 0 && /Could not reach Zernio/.test(e.message))
})

test('startConnect returns authUrl, handles alreadyConnected and re-enabled accounts, and sends force', () => withMock(async ({ mock, api }) => {
  const [profile] = mock.state.profiles
  const redirect = 'http://127.0.0.1:5555/zernio/connected/abc'

  const start = await api.startConnect('linkedin', profile._id, redirect)
  assert.equal(start.kind, 'redirect')
  assert.match(start.authUrl, /^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/)
  const [request] = mock.requestsTo('GET', '/api/v1/connect/linkedin')
  assert.equal(request.query.redirect_url, redirect)
  assert.equal(request.query.profileId, profile._id)
  assert.equal('force' in request.query, false)

  const existing = mock.addAccount('tiktok', profile._id, { username: 'already' })
  mock.setConnectResponse('tiktok', 'alreadyConnected')
  assert.deepEqual(await api.startConnect('tiktok', profile._id, redirect), { kind: 'connected', accountId: existing._id, username: 'already' })
  const forced = await api.startConnect('tiktok', profile._id, redirect, { force: true })
  assert.equal(forced.kind, 'redirect', 'force asks for a fresh sign-in')
  assert.equal(mock.requestsTo('GET', '/api/v1/connect/tiktok').at(-1).query.force, 'true')

  mock.setConnectResponse('youtube', 'reenabled')
  const reenabled = await api.startConnect('youtube', profile._id, redirect)
  assert.equal(reenabled.kind, 'connected')
  assert.match(reenabled.accountId, /^[a-f0-9]{24}$/)

  mock.setConnectResponse('threads', { status: 200, body: { state: 'x' } })
  await assert.rejects(api.startConnect('threads', profile._id, redirect), /didn't return a sign-in link/)
}))

test('deleteAccount treats 404 as already disconnected', () => withMock(async ({ mock, api }) => {
  const account = mock.addAccount('facebook', mock.state.profiles[0]._id)
  assert.equal(await api.deleteAccount(account._id), true)
  assert.equal(await api.deleteAccount(account._id), false)
}))

test('connect links are allowed only to Zernio or the platform’s own HTTPS OAuth hosts', () => {
  const { isTrustedConnectUrl, connectUrlHost } = load()
  const allowed = {
    tiktok: ['https://www.tiktok.com/v2/auth/authorize/?client_key=x', 'https://business-api.tiktok.com/portal/auth?app_id=1'],
    youtube: ['https://accounts.google.com/o/oauth2/auth?x=1', 'https://accounts.google.com/o/oauth2/v2/auth'],
    instagram: ['https://www.instagram.com/oauth/authorize?x', 'https://api.instagram.com/oauth/authorize', 'https://www.facebook.com/v21.0/dialog/oauth'],
    facebook: ['https://www.facebook.com/v21.0/dialog/oauth?client_id=1'],
    twitter: ['https://twitter.com/i/oauth2/authorize?x', 'https://x.com/i/oauth2/authorize'],
    linkedin: ['https://www.linkedin.com/oauth/v2/authorization?x'],
    threads: ['https://threads.net/oauth/authorize?x', 'https://www.threads.com/oauth/authorize']
  }
  for (const [platform, urls] of Object.entries(allowed)) {
    for (const url of [...urls, 'https://zernio.com/connect/x', 'https://app.zernio.com/connect/x', 'https://connect.zernio.com/start']) {
      assert.equal(isTrustedConnectUrl(url, platform), true, `${platform} ${url}`)
    }
  }
  const refused = [
    ['youtube', 'https://sites.google.com/view/phish'],
    ['youtube', 'https://www.linkedin.com/oauth/v2/authorization'],
    ['facebook', 'https://apps.facebook.com/evil'],
    ['tiktok', 'https://tiktok.com.evil.test/auth'],
    ['tiktok', 'https://eviltiktok.com/auth'],
    ['tiktok', 'http://www.tiktok.com/v2/auth/authorize/'],
    ['tiktok', 'https://www.tiktok.com:8443/v2/auth/authorize/'],
    ['tiktok', 'https://user:pass@www.tiktok.com/v2/auth/authorize/'],
    ['linkedin', 'https://zernio.com.evil.test/start'],
    ['linkedin', 'https://user-content.zernio.com/start'],
    ['linkedin', 'javascript:alert(1)'],
    ['linkedin', 'file:///etc/passwd'],
    ['linkedin', 'data:text/html,hi'],
    ['linkedin', 'not a url'],
    ['pinterest', 'https://www.pinterest.com/oauth/']
  ]
  for (const [platform, url] of refused) assert.equal(isTrustedConnectUrl(url, platform), false, `${platform} ${url}`)
  assert.equal(connectUrlHost('https://login.example-phish.test/oauth?state=secret'), 'login.example-phish.test')
  assert.equal(connectUrlHost('::::'), 'an invalid link')
})

test('provider text sanitising caps length and removes links, tokens and control characters', () => {
  const { sanitizeProviderText, cleanHandle } = load()
  assert.equal(sanitizeProviderText('Line\u0000one\nwww.evil.test/path eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig token_ABCDEFGHIJKL'), 'Line one [link] [redacted] [redacted]')
  assert.equal(sanitizeProviderText('x'.repeat(500)).length <= 160, true)
  assert.equal(sanitizeProviderText(42), undefined)
  assert.equal(sanitizeProviderText('   '), undefined)
  assert.equal(cleanHandle('@@name\u202e'), 'name')
  assert.equal(cleanHandle('\u0001'), null)
  assert.equal(cleanHandle('a'.repeat(300)).length, 120)
})
