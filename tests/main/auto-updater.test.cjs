const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function transpile(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

function loadModule(file, mocks = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(file), {
    module, exports: module.exports, require: (id) => mocks[id] ?? require(id),
    URL, Set, Map, Promise, Date, JSON, Error, console, queueMicrotask, process, ...globals
  })
  return module.exports
}

const updates = loadModule('shared/updates.ts')
const brand = loadModule('shared/brand.ts')
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('update errors become short messages without URLs or paths', () => {
  const coded = (code, message = 'https://github.com/x /Users/me/secret') => Object.assign(new Error(message), { code })
  assert.match(updates.updateErrorMessage(coded('ENOTFOUND')), /Could not reach GitHub/)
  assert.match(updates.updateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED')), /Could not reach GitHub/)
  assert.equal(updates.updateErrorMessage(coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), 'No release for this platform yet.')
  assert.equal(updates.updateErrorMessage(coded('ERR_UPDATER_LATEST_VERSION_NOT_FOUND')), 'No release for this platform yet.')
  assert.match(updates.updateErrorMessage(coded('ERR_CHECKSUM_MISMATCH')), /failed verification/)
  assert.match(updates.updateErrorMessage(coded('ENOSPC')), /disk space/)
  const generic = updates.updateErrorMessage(coded('SOMETHING_ELSE'))
  assert.doesNotMatch(generic, /github\.com|\/Users/)
})

// ---- PlatformGitHubProvider ------------------------------------------------

function loadProvider({ latest, responses }) {
  const requests = []
  class GitHubProvider {
    constructor(options) { this.options = options }
    getDefaultChannelName() { return 'latest-mac' }
    async getLatestVersion() { return latest() }
    async httpRequest(url) {
      requests.push(url.href)
      if (!(url.href in responses)) throw Object.assign(new Error('404'), { statusCode: 404 })
      return responses[url.href]
    }
  }
  const provider = loadModule('main/update-provider.ts', {
    'electron-updater/out/providers/GitHubProvider': { GitHubProvider },
    'electron-updater/out/providers/Provider': {
      parseUpdateInfo: (raw, file, url) => ({ version: /version: (\S+)/.exec(raw)[1], files: [], path: file, sha512: 'x', from: url.href })
    }
  })
  return { provider, requests }
}

const LISTING = 'https://api.github.com/repos/bridge-mind/bridgeclip/releases?per_page=30'
const missingFeed = () => { throw Object.assign(new Error('Cannot find latest-mac.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }) }
const release = (tag, assets, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: assets.map((name) => ({ name })), ...extra })

test('the provider always reads BridgeClip releases and uses the latest release when it has this platform', async () => {
  const { provider, requests } = loadProvider({ latest: () => ({ tag: 'v0.2.0', version: '0.2.0' }), responses: {} })
  const instance = new provider.PlatformGitHubProvider({ provider: 'custom' }, {}, {})
  assert.deepEqual({ ...instance.options }, { provider: 'github', owner: 'bridge-mind', repo: 'bridgeclip' })
  assert.deepEqual({ ...(await instance.getLatestVersion()) }, { tag: 'v0.2.0', version: '0.2.0' })
  assert.deepEqual(requests, [])
})

test('a latest release without this platform falls back to the newest release that has it', async () => {
  const { provider, requests } = loadProvider({
    latest: missingFeed,
    responses: {
      [LISTING]: JSON.stringify([
        release('v0.3.0', ['latest.yml', 'BridgeClip-0.3.0-win-x64.exe']),
        release('v0.2.9', ['latest-mac.yml'], { draft: true }),
        release('v0.2.8', ['latest-mac.yml'], { prerelease: true }),
        release('nightly', ['latest-mac.yml']),
        release('v0.2.1', ['latest-mac.yml', 'BridgeClip-0.2.1-mac-arm64.zip']),
        release('v0.2.0', ['latest-mac.yml'])
      ]),
      'https://github.com/bridge-mind/bridgeclip/releases/download/v0.2.1/latest-mac.yml': 'version: 0.2.1\n'
    }
  })
  const instance = new provider.PlatformGitHubProvider({}, {}, {})
  const result = await instance.getLatestVersion()
  assert.equal(result.tag, 'v0.2.1')
  assert.equal(result.version, '0.2.1')
  assert.equal(result.from, 'https://github.com/bridge-mind/bridgeclip/releases/download/v0.2.1/latest-mac.yml')
  assert.deepEqual(requests, [LISTING, result.from])
})

test('the fallback keeps the original error when no release ships this platform', async () => {
  const { provider } = loadProvider({ latest: missingFeed, responses: { [LISTING]: JSON.stringify([release('v0.3.0', ['latest.yml'])]) } })
  await assert.rejects(new provider.PlatformGitHubProvider({}, {}, {}).getLatestVersion(), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
})

test('other update errors are not retried', async () => {
  const { provider, requests } = loadProvider({ latest: () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }) }, responses: {} })
  await assert.rejects(new provider.PlatformGitHubProvider({}, {}, {}).getLatestVersion(), { code: 'ENOTFOUND' })
  assert.deepEqual(requests, [])
})

// ---- auto-updater state machine ---------------------------------------------

function setup({ platform = 'darwin', dev = false, packaged = true, env = {}, codesign = 'Authority=Developer ID Application: BRIDGEMIND LLC (9CBJCDR3J2)\nTeamIdentifier=9CBJCDR3J2\n', exe = '/Applications/BridgeClip.app/Contents/MacOS/BridgeClip' } = {}) {
  const handlers = {}
  const sent = []
  const timers = []
  const opened = []
  const updater = Object.assign(new EventEmitter(), {
    feed: null,
    installs: [],
    checks: 0,
    nextCheck: async () => null,
    setFeedURL(options) { this.feed = options },
    checkForUpdates() { this.checks++; return this.nextCheck() },
    quitAndInstall(...args) { this.installs.push(args) }
  })
  const moduleExports = loadModule('main/auto-updater.ts', {
    electron: {
      app: { getVersion: () => '0.1.17', isPackaged: packaged, getPath: () => exe, moveToApplicationsFolder: () => true },
      ipcMain: { handle: (channel, listener) => { handlers[channel] = listener } },
      powerMonitor: { on() {} },
      shell: { openExternal: async (url) => { opened.push(url) } }
    },
    child_process: { execFile: (_cmd, _args, _options, callback) => callback(codesign ? null : new Error('not signed'), '', codesign || '') },
    'electron-updater': { autoUpdater: updater },
    '@electron-toolkit/utils': { is: { dev } },
    '../shared/brand': brand,
    '../shared/updates': updates,
    './security': { assertTrustedSender() {} },
    './logger': { logger: { info() {}, warn() {}, error() {} } },
    './update-provider': { PlatformGitHubProvider: class {} }
  }, {
    process: { platform, env },
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    setInterval: (fn) => { timers.push(fn); return timers.length },
    setImmediate: (fn) => fn()
  })
  const window = { isDestroyed: () => false, webContents: { send: (channel, state) => sent.push({ channel, state }) } }
  return {
    updater, timers, sent, opened,
    init: async () => { moduleExports.initAutoUpdater(() => window); await flush() },
    invoke: (channel, ...args) => handlers[channel]({}, ...args),
    last: () => sent.at(-1)?.state
  }
}

test('official macOS builds read the platform-aware GitHub feed and download in the background', async () => {
  const t = setup()
  await t.init()
  assert.equal(t.updater.feed.provider, 'custom')
  assert.equal(t.updater.autoDownload, true)
  assert.equal(t.updater.autoInstallOnAppQuit, true)
  assert.equal(t.updater.allowPrerelease, false)
  assert.equal(t.updater.allowDowngrade, false)
  assert.equal(t.timers.length, 2, 'one check shortly after launch, then a repeating one')
  assert.equal((await t.invoke('update:getState')).status, 'idle')
})

for (const [name, options, reason] of [
  ['running from source', { dev: true, packaged: false }, 'development'],
  ['turned off by the environment', { env: { BRIDGECLIP_DISABLE_AUTO_UPDATE: '1' } }, 'disabled'],
  ['a macOS build not signed by BridgeMind', { codesign: '' }, 'unofficial'],
  ['a macOS build signed by another team', { codesign: 'Authority=Developer ID Application: Someone Else (ABCDE12345)\nTeamIdentifier=ABCDE12345\n' }, 'unofficial'],
  ['a macOS app running from its disk image', { exe: '/Volumes/BridgeClip/BridgeClip.app/Contents/MacOS/BridgeClip' }, 'move-to-applications'],
  ['a quarantined macOS app', { exe: '/private/var/folders/x/AppTranslocation/ABC/d/BridgeClip.app/Contents/MacOS/BridgeClip' }, 'move-to-applications']
]) {
  test(`updates are off for ${name}`, async () => {
    const t = setup(options)
    await t.init()
    const state = await t.invoke('update:getState')
    assert.equal(state.status, 'off')
    assert.equal(state.reason, reason)
    assert.equal(t.updater.feed, null)
    assert.equal(t.timers.length, 0)
    assert.equal((await t.invoke('update:check')).status, 'off')
    assert.equal(t.updater.checks, 0)
  })
}

test('Windows and Linux packages update without the macOS signature check', async () => {
  for (const platform of ['win32', 'linux']) {
    const t = setup({ platform, codesign: '' })
    await t.init()
    assert.equal(t.updater.feed.provider, 'custom')
  }
})

test('a check that finds an update downloads it, then it is ready to install', async () => {
  const t = setup()
  await t.init()
  t.updater.nextCheck = async () => {
    t.updater.emit('update-available', { version: '0.1.18' })
    return { downloadPromise: Promise.resolve() }
  }
  const checked = await t.invoke('update:check')
  assert.equal(checked.status, 'downloading')
  assert.equal(checked.version, '0.1.18')
  assert.ok(checked.lastCheckedAt)
  assert.equal(t.sent[0].state.status, 'checking')

  // Background downloads don't start a second check.
  await t.invoke('update:check')
  assert.equal(t.updater.checks, 1)

  t.updater.emit('download-progress', { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 100 })
  assert.deepEqual({ ...t.last().progress }, { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 100 })

  await assert.rejects(async () => t.invoke('update:install'), /No update is ready/)
  t.updater.emit('update-downloaded', { version: '0.1.18' })
  assert.equal(t.last().status, 'ready')

  // A later failure (say, offline) must not hide the downloaded update.
  t.updater.emit('error', Object.assign(new Error('offline'), { code: 'ENOTFOUND' }))
  assert.equal((await t.invoke('update:getState')).status, 'ready')

  assert.equal(await t.invoke('update:install'), true)
  assert.deepEqual(t.updater.installs, [[false, true]])

  await t.invoke('update:openReleaseNotes')
  assert.deepEqual(t.opened, ['https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.18'])
})

test('up to date and failed checks report their result', async () => {
  const t = setup()
  await t.init()
  t.updater.nextCheck = async () => { t.updater.emit('update-not-available', { version: '0.1.17' }); return {} }
  assert.equal((await t.invoke('update:check')).status, 'up-to-date')

  t.updater.nextCheck = async () => {
    const error = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED https://github.com'), { code: '' })
    t.updater.emit('error', error)
    throw error
  }
  const failed = await t.invoke('update:check')
  assert.equal(failed.status, 'error')
  assert.equal(failed.message, 'Could not reach GitHub. Check your connection and try again.')
  assert.ok(failed.lastCheckedAt)

  // A check with nothing to report goes back to idle rather than spinning.
  t.updater.nextCheck = async () => null
  assert.equal((await t.invoke('update:check')).status, 'idle')
})
