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

const parseFeed = (raw, file, url) => ({ version: /version: (\S+)/.exec(raw)[1], files: [], path: file, sha512: 'x', from: url.href })

function loadProvider({ latest, responses, parse = parseFeed }) {
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
    'electron-updater/out/providers/Provider': { parseUpdateInfo: parse }
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

test('the fallback takes the highest version, not the first listed', async () => {
  const { provider } = loadProvider({
    latest: missingFeed,
    responses: {
      // GitHub lists by creation date: a patch for an older line can come first.
      [LISTING]: JSON.stringify([release('v0.2.10', ['latest-mac.yml']), release('v0.3.0', ['latest.yml']), release('v0.2.9', ['latest-mac.yml']), release('v0.11.0', ['latest-mac.yml'])]),
      'https://github.com/bridge-mind/bridgeclip/releases/download/v0.11.0/latest-mac.yml': 'version: 0.11.0\n'
    }
  })
  assert.equal((await new provider.PlatformGitHubProvider({}, {}, {}).getLatestVersion()).tag, 'v0.11.0')
})

test('a fallback feed must describe its own release, and cannot replace its tag', async () => {
  const listing = { [LISTING]: JSON.stringify([release('v0.2.1', ['latest-mac.yml'])]) }
  const feedUrl = 'https://github.com/bridge-mind/bridgeclip/releases/download/v0.2.1/latest-mac.yml'
  const mismatched = loadProvider({ latest: missingFeed, responses: { ...listing, [feedUrl]: 'version: 9.9.9\n' } })
  await assert.rejects(new mismatched.provider.PlatformGitHubProvider({}, {}, {}).getLatestVersion(), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })

  // parseUpdateInfo keeps unknown keys, so a `tag:` in the yml must not win.
  const tagged = loadProvider({ latest: missingFeed, responses: { ...listing, [feedUrl]: '' }, parse: () => ({ version: '0.2.1', tag: 'v6.6.6', files: [] }) })
  assert.equal((await new tagged.provider.PlatformGitHubProvider({}, {}, {}).getLatestVersion()).tag, 'v0.2.1')
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

const SIGNED = 'Executable=/Applications/BridgeClip.app/Contents/MacOS/BridgeClip\nAuthority=Developer ID Application: BRIDGEMIND LLC (9CBJCDR3J2)\nTeamIdentifier=9CBJCDR3J2\n'

function setup({ platform = 'darwin', dev = false, packaged = true, env = {}, codesign = SIGNED, holdCodesign = false, exe = '/Applications/BridgeClip.app/Contents/MacOS/BridgeClip' } = {}) {
  const handlers = {}
  let releaseCodesign = null
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
      shell: { openExternal: async (url) => { opened.push(url) } },
      dialog: { showMessageBoxSync: () => 1 }
    },
    child_process: {
      execFile: (_cmd, _args, _options, callback) => {
        const answer = (result) => callback(result ? null : new Error('not signed'), '', result || '')
        if (holdCodesign) releaseCodesign = answer
        else answer(codesign)
      }
    },
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
  const window = {
    shown: 0,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore() {},
    show() { this.shown++ },
    webContents: { send: (channel, state) => sent.push({ channel, state }) }
  }
  return {
    updater, timers, sent, opened, window,
    init: async () => { moduleExports.initAutoUpdater(() => window); await flush() },
    invoke: (channel, ...args) => handlers[channel]({}, ...args),
    menu: () => moduleExports.checkForUpdatesFromMenu(),
    releaseCodesign: (result) => releaseCodesign(result),
    last: () => sent.filter((message) => message.channel === 'update:state').at(-1)?.state
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
    // electron-updater's own defaults would download and install on quit.
    assert.equal(t.updater.autoDownload, false)
    assert.equal(t.updater.autoInstallOnAppQuit, false)
    assert.equal((await t.invoke('update:check')).status, 'off')
    t.menu()
    await flush()
    assert.equal(t.updater.checks, 0)
    assert.ok(t.sent.some((message) => message.channel === 'update:show'), 'the menu still opens Settings to say why')
  })
}

test('a check before the build is vetted waits for the decision, and never downloads', async () => {
  const t = setup({ holdCodesign: true })
  t.updater.nextCheck = async () => { throw new Error('checked before the build was vetted') }
  const init = t.init()
  assert.equal(t.updater.autoDownload, false)
  assert.equal(t.updater.autoInstallOnAppQuit, false)
  const pending = t.invoke('update:check')
  t.menu()
  t.releaseCodesign('')
  await init
  assert.equal((await pending).status, 'off')
  await flush()
  assert.equal(t.updater.checks, 0)
})

test('Help → Check for Updates… checks and shows the Updates row', async () => {
  const t = setup()
  await t.init()
  t.updater.nextCheck = async () => { t.updater.emit('update-not-available', { version: '0.1.17' }); return {} }
  t.menu()
  await flush()
  assert.equal(t.updater.checks, 1)
  assert.equal(t.window.shown, 1)
  assert.ok(t.sent.some((message) => message.channel === 'update:show'))
  assert.equal(t.last().status, 'up-to-date')
})

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

  assert.equal(await t.invoke('update:install'), true)
  assert.deepEqual(t.updater.installs, [[false, true]])

  await t.invoke('update:openReleaseNotes')
  assert.deepEqual(t.opened, ['https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.18'])
})

test('an install failure after "ready" (Squirrel rejecting the signature) is reported and can be retried', async () => {
  const t = setup()
  await t.init()
  t.updater.nextCheck = async () => {
    t.updater.emit('update-available', { version: '0.1.18' })
    t.updater.emit('update-downloaded', { version: '0.1.18' })
    return { downloadPromise: Promise.resolve() }
  }
  assert.equal((await t.invoke('update:check')).status, 'ready')
  t.updater.emit('error', Object.assign(new Error('Code signature did not pass validation'), { code: 'SQRLCodeSignatureErrorDomain' }))
  const failed = await t.invoke('update:getState')
  assert.equal(failed.status, 'error')
  await assert.rejects(async () => t.invoke('update:install'), /No update is ready/)
  await t.invoke('update:check')
  assert.equal(t.updater.checks, 2)
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
