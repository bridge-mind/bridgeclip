'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: {
    contents: "export * from './src/renderer/store/use-accounts-store'",
    resolveDir: path.resolve(__dirname, '../..'),
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent'
}).outputFiles[0].text

const P1 = 'a'.repeat(24)
const P2 = 'b'.repeat(24)
const account = (id, platform, extra = {}) => ({
  id: id.padStart(24, '0'), platform, username: `${platform}_user`, displayName: null, profileId: P1,
  isActive: true, health: 'healthy', needsReconnect: false, issue: null, canPost: true, ...extra
})
const overview = (accounts, syncedAt = Date.now(), profiles = [{ id: P1, name: 'Default', isDefault: true }, { id: P2, name: 'Brand' }]) => ({ profiles, accounts, syncedAt })

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))
/** Objects from the vm realm have foreign prototypes; compare plain copies. */
const plain = (value) => JSON.parse(JSON.stringify(value))

/** A fresh store with a scripted preload API. */
function load({ cached = null, pending = null } = {}) {
  const calls = { sync: 0, connect: [], cancel: 0, disconnect: [] }
  const handlers = { result: [], reset: [], focus: [] }
  const syncQueue = []
  const zernio = {
    sync: () => { calls.sync += 1; const next = syncQueue.shift(); return typeof next === 'function' ? next() : Promise.resolve(next ?? { overview: null, stale: true, error: null }) },
    cachedOverview: async () => cached,
    pendingConnect: async () => pending,
    connect: async (platform, profileId, options) => { calls.connect.push({ platform, profileId, options }); return zernio.nextConnect ?? { status: 'pending', platform, profileId } },
    cancelConnect: async () => { calls.cancel += 1 },
    disconnect: async (id) => { calls.disconnect.push(id) },
    onConnectResult: (cb) => { handlers.result.push(cb); return () => {} },
    onReset: (cb) => { handlers.reset.push(cb); return () => {} }
  }
  const window = { bridgeclip: { zernio }, addEventListener: (type, fn) => { if (type === 'focus') handlers.focus.push(fn) } }
  const module = { exports: {} }
  vm.runInNewContext(bundle, { module, exports: module.exports, require, window, setImmediate, Date, Promise, console })
  const store = module.exports.useAccountsStore
  return {
    ...module.exports,
    store,
    state: () => store.getState(),
    zernio,
    calls,
    queueSync: (...results) => syncQueue.push(...results),
    emitResult: (result) => handlers.result.forEach((cb) => cb(result)),
    emitReset: (payload) => handlers.reset.forEach((cb) => cb(payload)),
    focus: () => handlers.focus.forEach((fn) => fn())
  }
}

test('hydrate shows cached accounts at once and restores a pending sign-in', async () => {
  const cachedAt = Date.now() - 3_600_000
  const s = load({ cached: overview([account('1', 'tiktok')], cachedAt), pending: { platform: 'youtube', profileId: P1, reconnect: false, startedAt: 1 } })
  await s.state().hydrate()
  assert.equal(s.calls.sync, 0, 'hydrate never touches the network')
  assert.equal(s.state().accounts.length, 1)
  assert.equal(s.state().syncedAt, cachedAt)
  assert.equal(s.state().profileId, P1, 'the default profile is selected')
  assert.equal(s.state().connecting.platform, 'youtube')

  // Live data replaces it; an older cached answer never replaces newer data.
  s.queueSync({ overview: overview([account('1', 'tiktok'), account('2', 'linkedin')]), stale: false, error: null })
  await s.state().load()
  assert.equal(s.state().accounts.length, 2)
  s.queueSync({ overview: overview([], cachedAt), stale: true, error: { kind: 'offline', message: 'Could not reach Zernio.' } })
  await s.state().load()
  assert.equal(s.state().accounts.length, 2)
  assert.equal(s.state().error.kind, 'offline')
})

test('a profile left behind after an access denial stays selected for recovery', async () => {
  const s = load({ cached: overview([]) })
  await s.state().hydrate()
  const id = 'c'.repeat(24)
  s.zernio.nextConnect = { status: 'failed', platform: 'youtube', profileId: id, createdProfile: { id, name: 'New brand' }, error: { kind: 'auth', message: 'Update the key in Settings.' } }
  await s.state().connect('youtube', { newProfileName: 'New brand' })
  assert.equal(s.state().profileId, id)
  assert.equal(s.state().profiles.filter((p) => p.id === id).length, 1)
  assert.equal(s.state().notice.action, 'settings')
  assert.equal(s.state().notice.tone, 'danger')
  assert.equal(s.state().connecting, null)
})

test('concurrent loads share one request', async () => {
  const s = load()
  const gate = deferred()
  s.queueSync(() => gate.promise)
  const a = s.state().load()
  const b = s.state().load()
  assert.equal(a, b)
  gate.resolve({ overview: overview([]), stale: false, error: null })
  await a
  assert.equal(s.calls.sync, 1)
  assert.equal(s.state().loading, false)
})

test('connect: the redirect result lands, with a billing action for payment failures', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  await s.state().connect('tiktok')
  assert.deepEqual(plain(s.calls.connect[0]), { platform: 'tiktok', profileId: P1, options: { reconnect: false } })
  assert.equal(s.state().connecting.platform, 'tiktok')

  s.queueSync({ overview: overview([account('9', 'tiktok')]), stale: false, error: null })
  s.emitResult({ platform: 'tiktok', success: true, username: 'newuser' })
  assert.equal(s.state().connecting, null)
  assert.deepEqual(plain(s.state().notice), { tone: 'success', text: 'TikTok connected as @newuser.' })
  await flush()
  assert.equal(s.calls.sync, 2, 'the list is re-read after a result')

  await s.state().connect('twitter')
  s.emitResult({ platform: 'twitter', success: false, error: 'Zernio needs a payment method.', billing: true })
  assert.equal(s.state().notice.tone, 'danger')
  assert.equal(s.state().notice.action, 'billing')
})

test('connect creates and selects a named profile before browser sign-in finishes', async () => {
  const s = load()
  s.queueSync({ overview: overview([account('1', 'youtube')]), stale: false, error: null })
  await s.state().load()
  const createdProfile = { id: 'c'.repeat(24), name: 'My clips' }
  s.zernio.nextConnect = { status: 'pending', platform: 'youtube', profileId: createdProfile.id, createdProfile }

  await s.state().connect('youtube', { newProfileName: '  My clips  ' })
  assert.deepEqual(plain(s.calls.connect.at(-1)), {
    platform: 'youtube', profileId: null, options: { newProfileName: 'My clips' }
  })
  assert.equal(s.state().profileId, createdProfile.id)
  assert.equal(s.state().profiles.at(-1).name, 'My clips')
  assert.equal(s.state().connecting.profileId, createdProfile.id)

  s.queueSync({ overview: overview([account('1', 'youtube'), account('2', 'youtube', { profileId: createdProfile.id })], Date.now(), [
    { id: P1, name: 'Default', isDefault: true }, createdProfile
  ]), stale: false, error: null })
  s.emitResult({ platform: 'youtube', success: true, username: 'newchannel' })
  await flush()
  assert.equal(s.state().profileId, createdProfile.id, 'the new profile stays selected after sync')
  assert.equal(s.state().notice.text, 'YouTube connected as @newchannel.')
})

test('an unsuccessful new-profile start keeps the previous profile selected', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  const newId = 'c'.repeat(24)
  s.zernio.nextConnect = { status: 'failed', platform: 'tiktok', profileId: newId, error: { kind: 'other', message: 'Could not open sign-in.' } }
  await s.state().connect('tiktok', { newProfileName: 'Campaign' })
  assert.equal(s.state().profileId, P1)
  assert.equal(s.state().profiles.some((profile) => profile.id === newId), false)
  assert.equal(s.state().notice.tone, 'danger')
})

test('blank new-profile names are rejected before calling Zernio', async () => {
  const s = load()
  await s.state().connect('instagram', { newProfileName: '   ' })
  assert.equal(s.calls.connect.length, 0)
  assert.equal(s.state().connecting, null)
  assert.equal(s.state().notice.tone, 'danger')
})

test('connect: already connected, API failures and cancel-while-starting', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()

  s.zernio.nextConnect = { status: 'connected', platform: 'youtube', profileId: P1, accountId: 'x'.repeat(24), username: 'chan' }
  await s.state().connect('youtube')
  assert.equal(s.state().connecting, null)
  assert.equal(s.state().notice.text, 'YouTube is already connected as @chan.')

  s.zernio.nextConnect = { status: 'failed', platform: 'youtube', profileId: P1, error: { kind: 'auth', message: 'Zernio rejected your API key. Check the key in Settings.' } }
  await s.state().connect('youtube', { reconnect: true })
  assert.deepEqual(plain(s.calls.connect.at(-1).options), { reconnect: true })
  assert.equal(s.state().notice.action, 'settings')

  // The user cancels while Zernio is still answering: the sign-in it started is cancelled too.
  const answer = deferred()
  s.zernio.connect = async () => answer.promise
  const connecting = s.state().connect('linkedin')
  s.state().cancelConnect()
  const cancelsBefore = s.calls.cancel
  answer.resolve({ status: 'pending', platform: 'linkedin', profileId: P1 })
  await connecting
  assert.equal(s.calls.cancel, cancelsBefore + 1)
  assert.equal(s.state().connecting, null)
})

test('a late result from another platform cannot finish the current sign-in', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  await s.state().connect('tiktok')
  s.state().cancelConnect()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await flush()
  await s.state().connect('youtube')
  s.emitResult({ platform: 'tiktok', success: true, username: 'late' })
  assert.equal(s.state().connecting.platform, 'youtube')
  assert.equal(s.state().notice, null)
})

test('a late start response cannot cancel a newer sign-in', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  const first = deferred()
  s.zernio.connect = async (platform) => platform === 'tiktok' ? first.promise : { status: 'pending', platform, profileId: P1 }
  const starting = s.state().connect('tiktok')
  s.state().cancelConnect()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().connect('youtube')
  const cancelsBefore = s.calls.cancel
  first.resolve({ status: 'pending', platform: 'tiktok', profileId: P1 })
  await starting
  assert.equal(s.state().connecting.platform, 'youtube')
  assert.equal(s.calls.cancel, cancelsBefore)
})

test('a disconnect result from an old workspace is discarded after a key change', async () => {
  const s = load()
  s.queueSync({ overview: overview([account('1', 'tiktok')]), stale: false, error: null })
  await s.state().load()
  const disconnect = deferred()
  s.zernio.disconnect = () => disconnect.promise
  const pending = s.state().disconnect(account('1', 'tiktok').id)
  s.emitReset({ configured: false })
  disconnect.resolve()
  await pending
  assert.equal(s.state().loaded, false)
  assert.equal(s.state().notice, null)
  assert.equal(s.state().disconnecting, null)
})

test('a sync started before disconnect cannot restore the removed account', async () => {
  const s = load()
  const old = overview([account('1', 'tiktok')])
  s.queueSync({ overview: old, stale: false, error: null })
  await s.state().load()

  const staleSync = deferred()
  s.queueSync(() => staleSync.promise)
  const pendingSync = s.state().load()
  s.zernio.disconnect = async () => {}
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().disconnect(account('1', 'tiktok').id)
  assert.equal(s.state().accounts.length, 0)

  staleSync.resolve({ overview: old, stale: false, error: null })
  await pendingSync
  await flush()
  assert.equal(s.state().accounts.length, 0)
  assert.equal(s.calls.sync, 3, 'a fresh sync follows the stale in-flight request')
})

test('a successful sign-in fetches again after a sync started before completion', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  await s.state().connect('youtube')
  const staleSync = deferred()
  s.queueSync(() => staleSync.promise)
  const pendingSync = s.state().load()
  s.queueSync({ overview: overview([account('2', 'youtube')]), stale: false, error: null })

  s.emitResult({ platform: 'youtube', success: true, username: 'newchannel' })
  staleSync.resolve({ overview: overview([]), stale: false, error: null })
  await pendingSync
  await flush()
  assert.equal(s.state().accounts.length, 1)
  assert.equal(s.state().accounts[0].platform, 'youtube')
  assert.equal(s.calls.sync, 3)
})

test('an already-connected result fetches again after a prior sync settles', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  const staleSync = deferred()
  s.queueSync(() => staleSync.promise)
  const pendingSync = s.state().load()
  s.zernio.nextConnect = { status: 'connected', platform: 'instagram', profileId: P1, accountId: account('3', 'instagram').id, username: 'ready' }
  s.queueSync({ overview: overview([account('3', 'instagram')]), stale: false, error: null })

  await s.state().connect('instagram')
  staleSync.resolve({ overview: overview([]), stale: false, error: null })
  await pendingSync
  await flush()
  assert.equal(s.state().accounts.length, 1)
  assert.equal(s.state().accounts[0].platform, 'instagram')
  assert.equal(s.calls.sync, 3)
})

test('focus fallback: a new account on refresh completes the sign-in without the redirect', async () => {
  const s = load()
  s.queueSync({ overview: overview([account('1', 'instagram', { profileId: P2 })]), stale: false, error: null })
  await s.state().load()
  await s.state().connect('instagram')
  assert.equal(s.state().connecting.knownAccountIds.length, 1)

  // Nothing new yet: still waiting.
  s.queueSync({ overview: overview([account('1', 'instagram', { profileId: P2 })]), stale: false, error: null })
  await s.state().load()
  assert.equal(s.state().connecting.platform, 'instagram')

  s.queueSync({ overview: overview([account('1', 'instagram', { profileId: P2 }), account('2', 'instagram', { username: 'fresh' })]), stale: false, error: null })
  await s.state().load()
  assert.equal(s.state().connecting, null)
  assert.equal(s.state().notice.text, 'Instagram connected as @fresh.')
  assert.equal(s.calls.cancel, 1, 'the loopback wait is stopped')
})

test('focus fallback: a reconnect is done when the flagged account is healthy again', async () => {
  const s = load()
  s.queueSync({ overview: overview([account('1', 'facebook', { needsReconnect: true, health: 'error' })]), stale: false, error: null })
  await s.state().load()
  await s.state().connect('facebook', { reconnect: true })
  s.queueSync({ overview: overview([account('1', 'facebook')]), stale: false, error: null })
  await s.state().load()
  assert.equal(s.state().connecting, null)
  assert.equal(s.state().notice.tone, 'success')
})

test('a timeout checks once more, then says it stopped waiting', async () => {
  const s = load()
  s.queueSync({ overview: overview([]), stale: false, error: null })
  await s.state().load()
  await s.state().connect('threads')
  s.queueSync({ overview: overview([]), stale: false, error: null })
  s.emitResult({ platform: 'threads', success: false, ended: 'timeout', error: 'BridgeClip stopped waiting for the browser after 10 minutes.' })
  await flush(); await flush()
  assert.equal(s.state().connecting, null)
  assert.equal(s.state().notice.tone, 'neutral')

  await s.state().connect('threads')
  s.queueSync({ overview: overview([account('5', 'threads')]), stale: false, error: null })
  s.emitResult({ platform: 'threads', success: false, ended: 'timeout', error: 'x' })
  await flush(); await flush()
  assert.equal(s.state().notice.tone, 'success', 'the sign-in finished after all')
})

test('a key change resets everything and ignores answers for the old workspace', async () => {
  const s = load({ cached: overview([account('1', 'tiktok')]) })
  await s.state().hydrate()
  const slow = deferred()
  s.queueSync(() => slow.promise)
  const inflight = s.state().load()
  s.emitReset({ configured: false })
  slow.resolve({ overview: overview([account('1', 'tiktok')]), stale: false, error: null })
  await inflight
  assert.equal(s.state().accounts.length, 0)
  assert.equal(s.state().syncedAt, 0)
  assert.equal(s.state().loaded, false)

  s.queueSync({ overview: overview([account('7', 'youtube')], Date.now(), [{ id: P2, name: 'Other workspace' }]), stale: false, error: null })
  s.zernio.cachedOverview = async () => null
  s.emitReset({ configured: true })
  await flush(); await flush()
  assert.equal(s.state().accounts[0].platform, 'youtube')
  assert.equal(s.state().profileId, P2)
})

test('focus refreshes are throttled, faster while signing in, and respect rate limits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const s = load()
  s.queueSync({ overview: overview([], Date.now()), stale: false, error: null })
  await s.state().load()
  s.focus()
  s.state().refreshOnFocus()
  assert.equal(s.calls.sync, 1, 'just synced: no refresh')
  t.mock.timers.tick(61_000)
  s.queueSync({ overview: overview([], Date.now()), stale: false, error: null })
  s.state().refreshOnFocus()
  await flush()
  assert.equal(s.calls.sync, 2)

  await s.state().connect('tiktok')
  t.mock.timers.tick(4_000)
  s.focus()
  assert.equal(s.calls.sync, 2, 'not every focus while signing in')
  t.mock.timers.tick(5_000)
  s.queueSync({ overview: overview([], Date.now()), stale: false, error: null })
  s.focus()
  await flush()
  assert.equal(s.calls.sync, 3, 'while signing in, coming back refreshes after a few seconds')

  s.queueSync({ overview: null, stale: true, error: { kind: 'rate_limit', message: 'Try again in 90s.', retryAfterSeconds: 90 } })
  t.mock.timers.tick(9_000)
  s.focus()
  await flush()
  assert.equal(s.calls.sync, 4)
  t.mock.timers.tick(30_000)
  s.focus()
  assert.equal(s.calls.sync, 4, 'no refresh inside the rate-limit window')
})

test('postable accounts: selected profile, active, not waiting for a new sign-in', async () => {
  const s = load()
  s.queueSync({
    overview: overview([
      account('1', 'tiktok'),
      account('2', 'youtube', { needsReconnect: true }),
      account('3', 'linkedin', { isActive: false }),
      account('4', 'facebook', { canPost: false }),
      account('5', 'threads', { profileId: P2 }),
      account('6', 'instagram', { canPost: null })
    ]),
    stale: false,
    error: null
  })
  await s.state().load()
  assert.deepEqual(s.selectPostableAccounts(s.state()).map((a) => a.platform), ['tiktok', 'instagram'])
  assert.deepEqual(s.selectPostableAccounts(s.state(), P2).map((a) => a.platform), ['threads'])
})

test('ensureAccountsLoaded only asks Zernio when the data is old', async () => {
  const fresh = load({ cached: overview([account('1', 'tiktok')], Date.now() - 1_000) })
  await fresh.ensureAccountsLoaded()
  assert.equal(fresh.calls.sync, 0)
  const old = load({ cached: overview([account('1', 'tiktok')], Date.now() - 600_000) })
  old.queueSync({ overview: overview([account('1', 'tiktok')]), stale: false, error: null })
  await old.ensureAccountsLoaded()
  assert.equal(old.calls.sync, 1)
})
