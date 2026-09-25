const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')
const { fileLinksAvailable, directoryLinkType } = require('../support/symlinks.cjs')

function loadSource(file, mocks = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, __dirname: path.join(__dirname, '../../src/main'), ...globals })
  return module.exports
}
function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require, URL })
  return module.exports
}
const TEST_WORK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-worker-test-'))
process.on('exit', () => fs.rmSync(TEST_WORK_HOME, { recursive: true, force: true }))
const jobContract = loadShared('job-contract.ts')
const jobOutput = loadShared('job-output.ts')
const videoSource = loadShared('video-source.ts')
const runHistory = loadSource('run-history.ts', { '../shared/video-source': videoSource })
const security = loadSource('security.ts', { electron: {}, '../shared/brand': loadShared('brand.ts') })
const { validateJobConfig } = loadSource('validation.ts', { './security': security, '../shared/video-source': videoSource, '../shared/job-contract': jobContract })

test('development checks the staged FFmpeg that the clipping engine uses', async () => {
  const binDir = path.join(__dirname, '../../engine-bin')
  const ffmpeg = path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const invoked = []
  const execFile = () => {}
  execFile[require('node:util').promisify.custom] = async (command) => {
    invoked.push(command)
    return { stdout: ' .. ass V->V Render ASS subtitles\n', stderr: '' }
  }
  const tools = loadSource('tools.ts', {
    electron: { app: { isPackaged: false } },
    fs: { existsSync: (file) => file === ffmpeg },
    child_process: { execFile }
  })
  assert.equal(tools.resolveBinary('ffmpeg'), ffmpeg)
  assert.equal(tools.resolveBinary('ffprobe'), 'ffprobe')
  assert.equal(tools.resolveBinary('yt-dlp'), 'yt-dlp')
  assert.equal(await tools.supportsCaptionFilter(), true)
  assert.deepEqual(invoked, [ffmpeg])
})

test('Zernio sign-in links stay on its HTTPS origin and provider errors are sanitized', async () => {
  const provider = loadSource('zernio/client.ts', {
    '../../shared/zernio': loadShared('zernio.ts'),
    '../http-response': loadSource('http-response.ts'),
    '../logger': { logger: { info() {}, warn() {}, error() {} } },
    '../network-policy': { assertPublicWebUrl: async () => {}, isPublicAddress: security.isPublicAddress ?? (() => false) }
  }, {
    AbortSignal,
    fetch: async () => Response.json({ error: 'private-provider-token' }, { status: 500 })
  })
  assert.equal(provider.isTrustedConnectUrl('https://connect.zernio.com/start', 'linkedin'), true)
  assert.equal(provider.isTrustedConnectUrl('https://www.linkedin.com/oauth/v2/authorization', 'linkedin'), true)
  assert.equal(provider.isTrustedConnectUrl('https://accounts.google.com/o/oauth2/auth', 'youtube'), true)
  assert.equal(provider.isTrustedConnectUrl('https://www.linkedin.com/oauth/v2/authorization', 'youtube'), false)
  assert.equal(provider.isUploadUrl('https://storage.example.com/clip.mp4'), true)
  assert.equal(provider.isUploadUrl('https://127.0.0.1/clip.mp4'), false)
  assert.equal(provider.isUploadUrl('https://storage.example.com:8443/clip.mp4'), false)
  assert.equal(provider.isUploadUrl('http://localhost/clip.mp4'), false)
  for (const url of ['http://zernio.com/start', 'https://zernio.com.evil.test/start', 'https://user:pass@zernio.com/start', 'https://zernio.com:8443/start']) {
    assert.equal(provider.isTrustedConnectUrl(url, 'linkedin'), false)
  }
  await assert.rejects(new provider.ZernioClient('test-key').listProfiles(), (error) =>
    error.message.includes('HTTP 500') && !error.message.includes('private-provider-token'))
})

test('media authorization rejects traversal, symlink escapes, and non-media files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-test-'))
  try {
    const library = path.join(root, 'library')
    fs.mkdirSync(library)
    const video = path.join(library, 'clip.mp4')
    const outside = path.join(root, 'outside.mp4')
    const secret = path.join(library, 'settings.json')
    fs.writeFileSync(video, '')
    fs.writeFileSync(outside, '')
    fs.writeFileSync(secret, '{}')
    if (fileLinksAvailable) fs.symlinkSync(outside, path.join(library, 'escape.mp4'))
    else t.diagnostic('File symlinks unavailable; symlink escape assertion skipped')
    assert.doesNotThrow(() => security.assertMediaPath(video, library))
    assert.throws(() => security.assertMediaPath(outside, library))
    if (fileLinksAvailable) assert.throws(() => security.assertMediaPath(path.join(library, 'escape.mp4'), library))
    assert.throws(() => security.assertMediaPath(secret, library))
    assert.equal(security.isWithinDirectory(outside, library), false)
    security.authorizeMedia(outside)
    assert.doesNotThrow(() => security.assertMediaPath(outside, library))
    fs.renameSync(outside, path.join(root, 'original.mp4'))
    fs.writeFileSync(outside, '')
    assert.throws(() => security.assertMediaPath(outside, library))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('validated media handle keeps the authorized file after its pathname changes', { skip: !fileLinksAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-media-handle-'))
  try {
    const library = path.join(root, 'library')
    fs.mkdirSync(library)
    const video = path.join(library, 'clip.mp4')
    const outside = path.join(root, 'outside.mp4')
    fs.writeFileSync(video, 'authorized')
    fs.writeFileSync(outside, 'untrusted')
    const opened = await security.openAuthorizedMedia(video, library)
    fs.renameSync(video, path.join(library, 'old.mp4'))
    fs.symlinkSync(outside, video)
    try {
      assert.equal(await opened.handle.readFile('utf-8'), 'authorized')
    } finally { await opened.handle.close() }
    await assert.rejects(() => security.openAuthorizedMedia(video, library))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('thumbnail generation uses a private cache and does not follow an adjacent symlink', { skip: !fileLinksAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-thumb-'))
  try {
    const video = path.join(root, 'clip.mp4')
    const adjacent = path.join(root, 'clip_thumb.jpg')
    const outside = path.join(root, 'outside.jpg')
    const userData = path.join(root, 'user-data')
    fs.writeFileSync(video, 'video')
    fs.writeFileSync(outside, 'keep')
    fs.symlinkSync(outside, adjacent)
    fs.mkdirSync(userData)
    const manager = loadSource('file-manager.ts', {
      electron: { app: { getPath: () => userData } },
      '../shared/job-output': jobOutput,
      './run-history': runHistory,
      './tools': { resolveBinary: () => 'ffmpeg' },
      child_process: { execFile: (_command, args, _options, callback) => {
        fs.writeFileSync(args.at(-1), 'thumbnail')
        callback(null, '', '')
      } }
    })
    const thumbnail = await manager.generateThumbnail(video, 1)
    assert.ok(thumbnail.startsWith(path.join(userData, 'thumbnails') + path.sep))
    assert.equal(fs.readFileSync(thumbnail, 'utf-8'), 'thumbnail')
    assert.equal(fs.readFileSync(outside, 'utf-8'), 'keep')
    assert.equal(fs.lstatSync(adjacent).isSymbolicLink(), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('IPC authentication requires the registered window main frame', () => {
  const frame = {}
  const contents = { mainFrame: frame }
  const window = { webContents: contents, isDestroyed: () => false }
  assert.doesNotThrow(() => security.assertTrustedSender({ sender: contents, senderFrame: frame }, window))
  assert.throws(() => security.assertTrustedSender({ sender: contents, senderFrame: {} }, window))
  assert.throws(() => security.assertTrustedSender({ sender: {}, senderFrame: frame }, window))
  assert.throws(() => security.assertTrustedSender({ sender: contents, senderFrame: frame }, null))
})

test('the native picker authorizes media and shell opening rejects aliased application bundles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-picker-'))
  try {
    const library = path.join(root, 'library')
    fs.mkdirSync(library)
    const video = path.join(root, 'selected.mp4')
    fs.writeFileSync(video, '')
    const handlers = new Map()
    const frame = {}
    const contents = { mainFrame: frame }
    const window = { webContents: contents, isDestroyed: () => false }
    const ipc = loadSource('ipc-handlers.ts', {
      electron: {
        app: { isPackaged: false },
        shell: { openPath: async () => { throw new Error('Unexpected shell launch') } },
        ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [video] }) }
      },
      './settings-store': { loadSettings: () => ({ outputDirectory: library }) },
      './file-manager': {},
      './run-history': runHistory,
      './pipeline-runner': {},
      './job-manager': { initJobManager() {} },
      './logger': {},
      './security': security,
      './network-policy': {},
      './validation': {},
      './tools': {},
      './zernio/service': {},
      './zernio/posts': {},
      './automations': {}
    })
    ipc.registerIpcHandlers(() => window)
    assert.equal(handlers.has('files:registerMedia'), false)
    assert.throws(() => security.assertMediaPath(video, library))
    const picker = handlers.get('dialog:selectVideo')
    assert.throws(() => picker({ sender: contents, senderFrame: {} }), /Unauthorized application request/)
    assert.equal(await picker({ sender: contents, senderFrame: frame }), fs.realpathSync(video))
    assert.doesNotThrow(() => security.assertMediaPath(video, library))
    const bundle = path.join(library, 'unsafe.app')
    fs.mkdirSync(bundle)
    const alias = path.join(library, 'ordinary-folder')
    if (directoryLinkType) {
      fs.symlinkSync(bundle, alias, directoryLinkType)
      await assert.rejects(handlers.get('shell:openPath')({ sender: contents, senderFrame: frame }, alias), /Application bundles cannot be opened/)
    } else t.diagnostic('Directory links unavailable; aliased bundle assertion skipped')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('external URLs reject executable schemes and embedded credentials', () => {
  for (const url of ['file:///tmp/run', 'javascript:alert(1)', 'https://user:pass@example.com', null]) assert.equal(security.isWebUrl(url), false)
  assert.equal(security.isWebUrl('https://example.com/video'), true)
  assert.equal(security.isTrustedExternalUrl('https://example.com/video'), false)
  assert.equal(security.isTrustedExternalUrl('https://github.com/bridge-mind/bridgeclip'), true)
})

test('job validation rejects malformed options and invalid trim intervals', () => {
  const job = { videoUrl: 'https://example.com/video', maxClips: 5, autoClipCount: true, includeCaptions: true, aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight', captionPreset: 'pop', durationRanges: ['short'], startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null }
  assert.doesNotThrow(() => validateJobConfig(job))
  assert.equal(validateJobConfig(job).videoSpeed, 1)
  for (const videoSpeed of jobContract.VIDEO_SPEED_OPTIONS) assert.equal(validateJobConfig({ ...job, videoSpeed }).videoSpeed, videoSpeed)
  for (const videoSpeed of [null, true, '1.5', 0, 0.5, 2.01, NaN, Infinity, -Infinity]) {
    assert.throws(() => validateJobConfig({ ...job, videoSpeed }), /Video speed/)
  }
  assert.doesNotThrow(() => validateJobConfig({ ...job, clippingMode: 'economy' }))
  assert.doesNotThrow(() => validateJobConfig({ ...job, clippingMode: 'quality' }))
  for (const option of jobContract.DURATION_OPTIONS) assert.doesNotThrow(() => validateJobConfig({ ...job, durationRanges: [option.id] }))
  assert.equal(validateJobConfig({ ...job, videoUrl: 'https://go.twitch.tv/videos/123?t=30s' }).videoUrl, 'https://www.twitch.tv/videos/123')
  for (const videoUrl of ['https://twitch.tv/channel', 'https://clips.twitch.tv/Clip']) assert.throws(() => validateJobConfig({ ...job, videoUrl }), /completed Twitch VOD/)
  for (const patch of [{ maxClips: -1 }, { startTimeSeconds: NaN }, { startTimeSeconds: 5, endTimeSeconds: 3 }, { videoUrl: 'file:///etc/passwd' }, { durationRanges: ['unexpected'] }, { includeCaptions: 'false' }, { layoutVision: 'true' }, { aspectRatio: '1:1' }, { clippingMode: 'unknown' }]) assert.throws(() => validateJobConfig({ ...job, ...patch }))
})

test('saved provider keys remain in main and migrate away from legacy encoding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-settings-'))
  const userData = path.join(root, 'userdata')
  const file = path.join(userData, 'settings.json')
  fs.mkdirSync(userData)
  fs.writeFileSync(file, JSON.stringify({ openrouterApiKey: Buffer.from('dummy-provider-value').toString('base64'), outputDirectory: root }))
  const settingsStore = loadSource('settings-store.ts', {
    electron: {
      app: { getPath: (name) => ({ home: root, appData: root, userData }[name]), isReady: () => true },
      safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }
    }
  })
  try {
    const loaded = settingsStore.loadSettings()
    assert.equal(loaded.openrouterApiKey, 'dummy-provider-value')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).openrouterApiKey.scheme, 'safeStorage')
    const publicView = settingsStore.publicSettings(loaded)
    assert.equal(publicView.openrouterConfigured, true)
    assert.equal(JSON.stringify(publicView).includes('dummy-provider-value'), false)
    settingsStore.savePublicSettings({ ...publicView, openrouterApiKey: 'untrusted-replacement' })
    assert.equal(settingsStore.loadSettings().openrouterApiKey, 'dummy-provider-value')
    settingsStore.replaceApiKey('zernioApiKey', 'dummy-social-value')
    assert.equal(settingsStore.publicSettings(settingsStore.loadSettings()).zernioConfigured, true)
    assert.equal(JSON.stringify(settingsStore.publicSettings(settingsStore.loadSettings())).includes('dummy-social-value'), false)
    settingsStore.replaceApiKey('openrouterApiKey', '')
    assert.equal(settingsStore.publicSettings(settingsStore.loadSettings()).openrouterConfigured, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('settings migration retires ElevenLabs without decrypting it and preserves the OpenRouter key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-single-key-'))
  const userData = path.join(root, 'userdata')
  fs.mkdirSync(userData)
  const file = path.join(userData, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ version: 6, outputDirectory: root,
    openrouterApiKey: { scheme: 'safeStorage', value: Buffer.from('active-openrouter').toString('base64') },
    elevenLabsApiKey: { scheme: 'safeStorage', value: Buffer.from('retired-key').toString('base64') }
  }))
  const store = loadSource('settings-store.ts', { electron: {
    app: { getPath: (name) => ({ home: root, appData: root, userData }[name]), isReady: () => true },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value) => Buffer.from(value),
      decryptString: (value) => { assert.notEqual(value.toString(), 'retired-key'); return value.toString() } }
  } })
  try {
    const loaded = store.loadSettings()
    assert.equal(loaded.openrouterApiKey, 'active-openrouter')
    assert.equal(Object.hasOwn(loaded, 'elevenLabsApiKey'), false)
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'elevenLabsApiKey'), false)
    assert.equal(Object.hasOwn(store.publicSettings(loaded), 'elevenLabsConfigured'), false)
    assert.equal(Object.hasOwn(store.getSettingsForBridge(loaded), 'ELEVENLABS_API_KEY'), false)
    assert.throws(() => store.replaceApiKey('elevenLabsApiKey', 'unused'), /Invalid API key/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('settings migration writes a private file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-settings-private-'))
  const userData = path.join(root, 'userdata')
  fs.mkdirSync(userData)
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ openrouterApiKey: Buffer.from('old-key').toString('base64'), outputDirectory: root }), { mode: 0o666 })
  fs.writeFileSync(path.join(userData, 'settings.json.tmp'), 'stale', { mode: 0o666 })
  const store = loadSource('settings-store.ts', {
    electron: {
      app: { getPath: (name) => ({ home: root, appData: root, userData }[name]), isReady: () => true },
      safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }
    }
  })
  try {
    assert.equal(store.loadSettings().openrouterApiKey, 'old-key')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(userData, 'settings.json')).mode & 0o077, 0)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Windows resolves the saved legacy Python default without replacing an installed or explicit interpreter', () => {
  const winProcess = Object.create(process)
  Object.defineProperty(winProcess, 'platform', { value: 'win32' })
  Object.defineProperty(winProcess, 'env', { value: { PATH: 'C:\\Python;C:\\Windows' } })
  Object.defineProperty(winProcess, 'resourcesPath', { value: 'C:\\BridgeClip\\resources' })
  const userData = 'C:\\Users\\Test\\BridgeClip'
  const engine = 'C:\\BridgeClip\\engine'
  const present = new Set()
  let python3Runnable = false
  let saved = null
  const app = { isPackaged: false, getPath: (name) => name === 'home' ? 'C:\\Users\\Test' : userData }
  const store = loadSource('settings-store.ts', {
    electron: { app, safeStorage: {} }, path: path.win32,
    fs: {
      existsSync: (file) => file === userData || (file === path.win32.join(userData, 'settings.json') && saved !== null),
      readFileSync: () => JSON.stringify(saved)
    }
  }, { process: winProcess })
  const runner = loadSource('pipeline-runner.ts', {
    electron: { app }, path: path.win32,
    fs: { existsSync: (file) => present.has(file) },
    child_process: { execFile() {}, execFileSync(command, args) {
      assert.equal(command, 'python3')
      assert.deepEqual(Array.from(args), ['-c', 'import sys; assert sys.version_info[0] == 3'])
      if (!python3Runnable) throw new Error('Python is unavailable')
    } },
    './settings-store': {}, './logger': {}, '../shared/job-output': {},
    '../shared/job-contract': {}, './run-history': {}, './tools': {}
  }, { process: winProcess })

  assert.equal(store.loadSettings().pythonPath, 'python')
  saved = { version: 7, openrouterApiKey: '', zernioApiKey: '', outputDirectory: 'C:\\Clips', pythonPath: 'python3' }
  assert.equal(store.loadSettings().pythonPath, 'python3', 'the persisted setting is not rewritten')
  assert.equal(runner.resolvePythonPath(engine, store.loadSettings().pythonPath), 'python')

  python3Runnable = true
  assert.equal(runner.resolvePythonPath(engine, 'python3'), 'python3', 'an installed python3 remains usable')
  python3Runnable = false
  const venv = path.win32.join(engine, '.venv', 'Scripts', 'python.exe')
  present.add(venv)
  assert.equal(runner.resolvePythonPath(engine, 'python3'), venv, 'the project venv retains priority')
  present.delete(venv)

  const explicit = 'C:\\Python\\python.exe'
  saved.pythonPath = explicit
  present.add(explicit)
  assert.equal(store.loadSettings().pythonPath, explicit)
  assert.equal(runner.resolvePythonPath(engine, explicit), explicit)
  assert.equal(runner.resolvePythonPath(engine, 'py'), 'py', 'other command settings remain untouched')
  app.isPackaged = true
  assert.equal(runner.resolvePythonPath(engine, explicit), path.win32.join(winProcess.resourcesPath, 'engine-venv', 'Scripts', 'python.exe'))
})

test('library rejects parseable but incomplete job output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-library-'))
  const run = path.join(root, 'run-one')
  fs.mkdirSync(run)
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'run-one' }))
  const manager = loadSource('file-manager.ts', { '../shared/job-output': jobOutput, './run-history': runHistory, './tools': { resolveBinary: () => 'ffprobe' } })
  try {
    assert.equal((await manager.getJobHistory(root))[0].status, 'failed')
    assert.equal(await manager.getJobOutput(run), null)
    fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'run-one', clips: [] }))
    assert.equal((await manager.getJobHistory(root))[0].status, 'completed')
    const outside = path.join(root, 'outside.json')
    fs.writeFileSync(outside, JSON.stringify({ job_id: 'outside', clips: [] }))
    if (fileLinksAvailable) {
      fs.rmSync(path.join(run, 'job_output.json'))
      fs.symlinkSync(outside, path.join(run, 'job_output.json'))
      assert.equal(await manager.getJobOutput(run), null)
      assert.equal((await manager.getJobHistory(root))[0].status, 'failed')
      const withoutNoFollow = loadSource('file-manager.ts', {
        fs: { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined } },
        '../shared/job-output': jobOutput, './run-history': runHistory, './tools': { resolveBinary: () => 'ffprobe' }
      })
      assert.equal(await withoutNoFollow.getJobOutput(run, root), null)
      assert.equal((await withoutNoFollow.getJobHistory(root))[0].status, 'failed', 'a link inside the library is still rejected')
    } else t.diagnostic('File symlinks unavailable; linked job output assertions skipped')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('job output rejects a link substituted during open when O_NOFOLLOW is unavailable', { skip: !fileLinksAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-output-open-'))
  const run = path.join(root, 'run-one')
  const output = path.join(run, 'job_output.json')
  const outside = path.join(root, 'outside.json')
  let closed = false
  try {
    fs.mkdirSync(run)
    fs.writeFileSync(output, JSON.stringify({ job_id: 'run-one', clips: [] }))
    fs.writeFileSync(outside, JSON.stringify({ job_id: 'outside', clips: [] }))
    const manager = loadSource('file-manager.ts', {
      fs: { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined } },
      'fs/promises': { ...fs.promises, open: async (...args) => {
        fs.rmSync(output)
        fs.symlinkSync(outside, output)
        const handle = await fs.promises.open(...args)
        return {
          stat: () => handle.stat(),
          readFile: (...readArgs) => handle.readFile(...readArgs),
          close: async () => { closed = true; await handle.close() }
        }
      } },
      '../shared/job-output': jobOutput, './run-history': runHistory, './tools': { resolveBinary: () => 'ffprobe' }
    })
    assert.equal(await manager.getJobOutput(run, root), null)
    assert.equal(closed, true, 'the opened file is closed after rejection')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('library retains unfinished desktop runs and ignores unrelated folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-library-'))
  const jobId = '9d69d14f-2b56-414e-b11e-bdb38a0e2877'
  fs.mkdirSync(path.join(root, jobId))
  fs.mkdirSync(path.join(root, 'Other files'))
  const manager = loadSource('file-manager.ts', { '../shared/job-output': jobOutput, './run-history': runHistory, './tools': { resolveBinary: () => 'ffprobe' } })
  try {
    const entries = await manager.getJobHistory(root)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].jobId, jobId)
    assert.equal(entries[0].status, 'incomplete')
    assert.equal(entries[0].videoTitle, 'Unfinished run')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run history persists outcomes, identifies interrupted work, and omits source query data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-history-'))
  const failedId = '4de005c2-1234-4123-8123-567890abcdef'
  const runningId = '4de005c3-1234-4123-8123-567890abcdef'
  const cancelledId = '4de005c4-1234-4123-8123-567890abcdef'
  const manager = loadSource('file-manager.ts', { '../shared/job-output': jobOutput, './run-history': runHistory, './tools': { resolveBinary: () => 'ffprobe' } })
  try {
    runHistory.createRunRecord(root, failedId, 'https://www.youtube.com/watch?v=abc123def45&token=private-query')
    const raw = fs.readFileSync(path.join(root, failedId, 'run-history.json'), 'utf8')
    assert.equal(raw.includes('private-query'), false)
    assert.equal(raw.includes('abc123def45'), true)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(root, failedId, 'run-history.json')).mode & 0o077, 0)
    }
    runHistory.finishRunRecord(root, failedId, 'failed', 'Audio transcription failed.')
    runHistory.createRunRecord(root, runningId, '/tmp/local-video.mp4')
    runHistory.createRunRecord(root, cancelledId, '/tmp/cancelled.mp4')
    runHistory.finishRunRecord(root, cancelledId, 'cancelled')

    const active = await manager.getJobHistory(root, new Set([runningId]))
    assert.equal(active.find((entry) => entry.jobId === failedId).status, 'failed')
    assert.equal(active.find((entry) => entry.jobId === failedId).errorMessage, 'Audio transcription failed.')
    assert.equal(active.find((entry) => entry.jobId === runningId).status, 'running')
    assert.equal(active.find((entry) => entry.jobId === cancelledId).status, 'cancelled')
    assert.equal((await manager.getJobHistory(root)).find((entry) => entry.jobId === runningId).status, 'interrupted')

    if (fileLinksAvailable) {
      const outside = path.join(root, 'outside.json')
      fs.writeFileSync(outside, raw)
      fs.rmSync(path.join(root, failedId, 'run-history.json'))
      fs.symlinkSync(outside, path.join(root, failedId, 'run-history.json'))
      assert.equal(runHistory.readRunRecord(root, failedId), null)
    } else t.diagnostic('File symlinks unavailable; linked run history assertion skipped')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('diagnostic logs omit source URLs and use private file permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-logs-'))
  const loggerModule = loadSource('logger.ts', {
    electron: { app: { getPath: () => root } }
  }, { console: { log() {}, warn() {}, error() {} } })
  try {
    loggerModule.logger.error('test.failure', {
      message: 'https://example.com/private?token=dummy', status: 1,
      failureCode: 'transcription.bad_request', failureStage: 'transcription', httpStatus: 400
    })
    const log = fs.readFileSync(loggerModule.getLogFilePath(), 'utf8')
    assert.equal(log.includes('example.com'), false)
    assert.equal(log.includes('dummy'), false)
    assert.equal(JSON.parse(log).failureCode, 'transcription.bad_request')
    assert.equal(JSON.parse(log).httpStatus, 400)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(loggerModule.getLogFilePath()).mode & 0o077, 0)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test('pipeline preserves split JSON messages and protects the job identity', async () => {
  const { PassThrough } = require('node:stream')
  const { EventEmitter } = require('node:events')
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  let workerInput = ''
  child.stdin.on('data', (chunk) => { workerInput += chunk.toString() })
  const sent = []
  const settings = { openrouterApiKey: 'test-secret', outputDirectory: '/tmp', pythonPath: 'python3', enginePath: '/tmp' }
  const runner = loadSource('pipeline-runner.ts', {
    electron: { app: { isPackaged: false, getPath: () => TEST_WORK_HOME } },
    fs: { ...fs, existsSync: () => true },
    child_process: { execFile: require('node:child_process').execFile, spawn: (_python, args, options) => {
      assert.equal(args.length, 1)
      assert.equal(options.env.PATH.split(path.delimiter)[0], '/staged/engine-bin')
      return child
    } },
    './settings-store': { loadSettings: () => settings, getSettingsForBridge: () => ({}), vocabularyTerms: () => [] },
    './logger': { logger: { info() {}, error() {}, warn() {} } },
    '../shared/job-output': jobOutput,
    './run-history': runHistory,
    '../shared/job-contract': jobContract,
    './tools': { resolveBinary: () => '/staged/engine-bin/ffmpeg' }
  })
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }
  runner.startClipJob('trusted-job', { videoUrl: '/tmp/video.mp4', videoSpeed: 1.5 }, window, undefined, '/tmp/queued-output')
  assert.equal(JSON.parse(workerInput).output_dir, '/tmp/queued-output')
  assert.equal(JSON.parse(workerInput).video_speed, 1.5)
  assert.equal(JSON.parse(workerInput).contract_version, 2)
  child.stdout.write('{"type":"prog')
  child.stdout.write('ress","jobId":"spoof","percent":42}\n{"type":"result","status":"completed","job_id":"trusted-job","output":{"job_id":"trusted-job","clips":[]}}\n')
  child.stdout.end()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sent.some((event) => event.channel === 'job:complete'), false)
  child.emit('close', 0, null)
  assert.equal(sent[0].channel, 'job:progress')
  assert.equal(sent[0].data.jobId, 'trusted-job')
  assert.equal(sent[1].channel, 'job:complete')
  assert.equal(sent.length, 2)
})

test('pipeline rejects a mismatched result identity and a failed process exit', async () => {
  const { PassThrough } = require('node:stream')
  const { EventEmitter } = require('node:events')
  for (const [resultId, exitCode] of [['other-job', 0], ['trusted-job', 1]]) {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const sent = []
    const settings = { outputDirectory: '/tmp', pythonPath: 'python3', enginePath: '/tmp' }
    const runner = loadSource('pipeline-runner.ts', {
      electron: { app: { isPackaged: false, getPath: () => TEST_WORK_HOME } },
      fs: { ...fs, existsSync: () => true },
      child_process: { execFile: require('node:child_process').execFile, spawn: () => child },
      './settings-store': { loadSettings: () => settings, getSettingsForBridge: () => ({}), vocabularyTerms: () => [] },
      './logger': { logger: { info() {}, error() {}, warn() {} } },
      '../shared/job-output': jobOutput,
      './run-history': runHistory,
      '../shared/job-contract': jobContract,
      './tools': { resolveBinary: () => 'ffmpeg' }
    })
    const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }
    runner.startClipJob('trusted-job', { videoUrl: '/tmp/video.mp4' }, window)
    child.stdout.write(JSON.stringify({ type: 'result', status: 'completed', job_id: resultId,
      output: { job_id: 'trusted-job', clips: [] } }) + '\n')
    child.stdout.end()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.some((event) => event.channel === 'job:complete'), false)
    child.emit('close', exitCode, null)
    assert.equal(sent.filter((event) => event.channel === 'job:error').length, 1)
    assert.equal(sent.some((event) => event.channel === 'job:complete'), false)
  }
})

test('a bridge failure is saved in run history before the UI receives it', async () => {
  const { PassThrough } = require('node:stream')
  const { EventEmitter } = require('node:events')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-run-failure-'))
  const jobId = 'a45127ce-1234-4123-8123-567890abcdef'
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const settings = { outputDirectory: root, pythonPath: 'python3', enginePath: root }
  const logs = []
  const runner = loadSource('pipeline-runner.ts', {
    electron: { app: { isPackaged: false, getPath: () => TEST_WORK_HOME } },
    fs: { ...fs, existsSync: () => true },
    child_process: { execFile: require('node:child_process').execFile, spawn: () => child },
    './settings-store': { loadSettings: () => settings, getSettingsForBridge: () => ({}), vocabularyTerms: () => [] },
    './logger': { logger: { info() {}, error(event, context) { logs.push({ event, context }) }, warn() {} } },
    './run-history': runHistory,
    '../shared/job-output': jobOutput,
    '../shared/job-contract': jobContract,
    './tools': { resolveBinary: () => 'ffmpeg' }
  })
  const sent = []
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }
  try {
    runHistory.createRunRecord(root, jobId, 'https://www.youtube.com/watch?v=abc123def45')
    runner.startClipJob(jobId, { videoUrl: 'https://www.youtube.com/watch?v=abc123def45' }, window)
    child.stdout.write('{"type":"error","message":"OpenRouter rejected the transcription audio request.","code":"transcription.bad_request","stage":"transcription","http_status":400}\n')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.filter((event) => event.channel === 'job:error').length, 1)
    assert.equal(runHistory.readRunRecord(root, jobId).status, 'failed')
    assert.equal(runHistory.readRunRecord(root, jobId).errorMessage, 'OpenRouter rejected the transcription audio request.')
    assert.equal(runHistory.readRunRecord(root, jobId).failureCode, 'transcription.bad_request')
    assert.equal(runHistory.readRunRecord(root, jobId).failureStage, 'transcription')
    assert.equal(runHistory.readRunRecord(root, jobId).httpStatus, 400)
    assert.equal(sent.find((event) => event.channel === 'job:error').data.failureCode, 'transcription.bad_request')
    assert.equal(logs.find((entry) => entry.event === 'job.bridge.error').context.failureCode, 'transcription.bad_request')
    child.emit('close', 1, null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})


test('network policy rejects private literals and private DNS results', async () => {
  const policy = loadSource('network-policy.ts', {
    './security': security,
    'dns/promises': { lookup: async (host) => [{ address: host === 'public.example' ? '93.184.216.34' : '10.0.0.1' }] }
  })
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1',
    '2002:c000:0204::1', '2001::1', '2001:1::1', '2001:2::1', '2001:10::1', '2001:2f::1', '2001:db8::1', '3fff::1']) assert.equal(policy.isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '2606:4700::1111', '2001:4860:4860::8888', '2001:470:1f0b::1', '2001:0db9:0000:0000:0000:0000:0000:0001']) {
    assert.equal(policy.isPublicAddress(address), true, address)
  }
  for (const url of ['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://internal.example']) await assert.rejects(() => policy.assertPublicWebUrl(url))
  await policy.assertPublicWebUrl('https://public.example/video')
})


test('cancellation retains a live process group after the leader closes and forces termination', () => {
  const { PassThrough } = require('node:stream')
  const { EventEmitter } = require('node:events')
  const child = new EventEmitter()
  child.pid = 12345
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const signals = []
  let callback
  let cleared = false
  let timers = 0
  const timer = { unref() {} }
  const sent = []
  const settings = { openrouterApiKey: '', outputDirectory: '/tmp', pythonPath: 'python3', enginePath: '/tmp' }
  const runner = loadSource('pipeline-runner.ts', {
    electron: { app: { isPackaged: false, getPath: () => TEST_WORK_HOME } },
    fs: { ...fs, existsSync: () => true },
    child_process: { execFile: require('node:child_process').execFile, spawn: () => child },
    './settings-store': { loadSettings: () => settings, getSettingsForBridge: () => ({}), vocabularyTerms: () => [] },
    './logger': { logger: { info() {}, error() {}, warn() {} } },
    '../shared/job-output': jobOutput,
    './run-history': runHistory,
    '../shared/job-contract': jobContract,
    './tools': { resolveBinary: () => 'ffmpeg' }
  }, {
    process: { ...process, platform: 'darwin', kill: (pid, signal) => { if (signal !== 0) signals.push({ pid, signal }) } },
    setTimeout: (fn) => { callback = fn; timers++; return timer },
    clearTimeout: (value) => { assert.equal(value, timer); cleared = true }
  })
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } }
  runner.startClipJob('cancel-job', { videoUrl: '/tmp/video.mp4' }, window)
  assert.equal(runner.cancelJob('cancel-job'), true)
  assert.equal(runner.hasActiveJobs(), true)
  runner.cancelJob('cancel-job')
  assert.equal(timers, 1)
  child.stdout.write('{"type":"error","message":"shutdown"}\n')
  child.emit('error', new Error('shutdown'))
  assert.equal(runner.hasActiveJobs(), true)
  child.emit('close', null, 'SIGTERM')
  assert.equal(cleared, false)
  assert.equal(runner.hasActiveJobs(), true)
  callback()
  assert.deepEqual(signals, [{ pid: -12345, signal: 'SIGTERM' }, { pid: -12345, signal: 'SIGKILL' }])
  assert.equal(runner.hasActiveJobs(), false)
  assert.equal(sent.length, 0)
})

test('crash logs keep safe diagnostics without leaking credentials from errors', () => {
  const lines = []
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-log-test-'))
  const { logger, errorSummary } = loadSource('logger.ts', {
    electron: { app: { getPath: () => logDir } },
    fs: { ...fs, appendFileSync: (_file, line) => lines.push(JSON.parse(line)) }
  }, { console: { log() {}, warn() {}, error() {} } })
  const error = new Error('Authorization: Bearer sk-or-v1-secretcredential on /Users/dev/Library/clip.mp4')
  error.code = 'ENOENT'
  error.stack = `Error: ${error.message}\n    at sk-or-v1-secretcredential (/Users/dev/app/out/main/index.js:42:13)`
  logger.error('main.uncaughtException', errorSummary(error))
  const entry = lines[0]
  assert.equal(entry.name, 'Error')
  assert.equal(entry.code, 'ENOENT')
  assert.equal(entry.frame, 'main.index.js:42')
  assert.equal(errorSummary('plain rejection').name, 'Error')
  const malicious = new Error('API key sk-or-v1-secretcredential')
  malicious.name = 'sk-or-v1-secretcredential'
  malicious.code = 'sk-or-v1-secretcredential'
  malicious.stack = 'Error\n    at sk-or-v1-secretcredential (/Users/sk-or-v1-secretcredential/secrets.js:1:2)'
  logger.error('main.unhandledRejection', errorSummary(malicious))
  assert.equal(lines[1].name, 'Error')
  assert.equal(lines[1].code, '')
  assert.equal(lines[1].frame, '')
  assert.doesNotMatch(JSON.stringify(lines), /sk-or-v1-secretcredential|\/Users\/dev/)
  fs.rmSync(logDir, { recursive: true, force: true })
})
