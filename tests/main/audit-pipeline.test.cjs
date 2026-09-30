// Security audit regressions for the worker process boundary in pipeline-runner.ts:
// what the child inherits, and how far untrusted worker stdout is trusted.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')
const { PassThrough } = require('node:stream')
const { EventEmitter } = require('node:events')

function loadSource(file, mocks = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, queueMicrotask, __dirname: path.join(__dirname, '../../src/main'), ...globals })
  return module.exports
}
function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => id.startsWith('./') ? loadShared(`${id.slice(2)}.ts`) : require(id), URL })
  return module.exports
}

const WORK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-audit-pipeline-'))
process.on('exit', () => fs.rmSync(WORK_HOME, { recursive: true, force: true }))
const jobOutput = loadShared('job-output.ts')
const jobContract = loadShared('job-contract.ts')
const runHistory = loadSource('run-history.ts', { '../shared/video-source': loadShared('video-source.ts') })
const SECRET = 'sk-or-v1-audit-secret'

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

function startRunner({ child, env = process.env, onSpawn = () => {} }) {
  const sent = []
  const signals = []
  const settings = { openrouterApiKey: SECRET, outputDirectory: WORK_HOME, pythonPath: '/opt/python3', enginePath: WORK_HOME }
  const runner = loadSource('pipeline-runner.ts', {
    electron: { app: { isPackaged: false, getPath: () => WORK_HOME } },
    fs: { ...fs, existsSync: () => true },
    child_process: { execFile: require('node:child_process').execFile, spawn: (command, args, options) => { onSpawn(command, args, options); return child } },
    './settings-store': { loadSettings: () => settings, getSettingsForBridge: () => ({ OPENROUTER_API_KEY: SECRET, LOCAL_MODE: 'true', LOCAL_OUTPUT_DIR: WORK_HOME }), vocabularyTerms: () => [] },
    './logger': { logger: { info() {}, error() {}, warn() {} } },
    '../shared/job-output': jobOutput,
    '../shared/run-diagnostics': loadShared('run-diagnostics.ts'),
    '../shared/job-progress': loadShared('job-progress.ts'),
    './run-history': runHistory,
    '../shared/job-contract': jobContract,
    './tools': { resolveBinary: () => '/staged/engine-bin/ffmpeg' }
  }, {
    process: { ...process, platform: 'darwin', env, kill: (pid, signal) => { signals.push({ pid, signal }) } }
  })
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }
  return { runner, window, sent, signals }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the worker gets a minimal environment: no proxies, interpreter hooks or injected libraries, and the key never touches argv or stdin', () => {
  const child = fakeChild()
  let workerInput = ''
  child.stdin.on('data', (chunk) => { workerInput += chunk.toString() })
  const hostile = {
    PATH: '/usr/bin:/bin', HOME: WORK_HOME,
    HTTP_PROXY: 'http://127.0.0.1:8080', HTTPS_PROXY: 'http://127.0.0.1:8080', ALL_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: '*',
    PYTHONSTARTUP: '/tmp/hook.py', PYTHONHOME: '/tmp/py', PYTHONPATH: '/tmp/site', PYTHONWARNINGS: 'x', PYTHONINSPECT: '1',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', DYLD_LIBRARY_PATH: '/tmp', LD_PRELOAD: '/tmp/evil.so', LD_LIBRARY_PATH: '/tmp',
    NODE_OPTIONS: '--require /tmp/evil.js', REQUESTS_CA_BUNDLE: '/tmp/ca.pem', CURL_CA_BUNDLE: '/tmp/ca.pem',
    OPENROUTER_API_KEY: 'stale-process-key', AWS_SECRET_ACCESS_KEY: 'aws', BRIDGECLIP_API_KEY: 'server', YTDLP_PROXIES: 'socks5h://u:p@10.0.0.1:1'
  }
  let spawned
  const { runner, window } = startRunner({ child, env: hostile, onSpawn: (command, args, options) => { spawned = { command, args, options } } })
  runner.startClipJob('audit-job', { videoUrl: path.join(WORK_HOME, 'video.mp4') }, window)
  assert.ok(spawned, 'worker spawned')
  assert.equal(spawned.command, '/opt/python3')
  assert.equal(spawned.args.length, 1)
  assert.ok(!JSON.stringify(spawned.args).includes(SECRET))
  assert.ok(!workerInput.includes(SECRET), 'stdin config carries no key')
  assert.equal(Object.hasOwn(JSON.parse(workerInput), 'clip_request'), false, 'no clip request, no clip_request field')
  assert.equal(spawned.options.shell, undefined)
  assert.equal(spawned.options.detached, true)
  assert.equal(spawned.options.cwd, runner.getEnginePath())
  const env = spawned.options.env
  for (const name of Object.keys(hostile)) {
    if (['PATH', 'HOME', 'PYTHONPATH', 'OPENROUTER_API_KEY'].includes(name)) continue
    assert.equal(env[name], undefined, `${name} must not reach the worker`)
  }
  assert.equal(env.OPENROUTER_API_KEY, SECRET)
  assert.equal(env.PYTHONPATH, runner.getEnginePath())
  assert.equal(env.PATH.split(path.delimiter)[0], '/staged/engine-bin')
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  assert.ok(env.BRIDGECLIP_WORK_ROOT.startsWith(WORK_HOME))
  child.emit('close', 1, null)
})

test('raw worker output never reaches the renderer, and an oversized line stops the worker', async () => {
  const child = fakeChild()
  const { runner, window, sent, signals } = startRunner({ child })
  runner.startClipJob('audit-job', { videoUrl: path.join(WORK_HOME, 'video.mp4') }, window)
  child.stdout.write(`OPENROUTER_API_KEY=${SECRET}\nTraceback: /Users/private/${SECRET}\n`)
  child.stdout.write(`{"type":"progress","status":"rendering","step":"Rendering https://evil.example/${SECRET}","percent":5}\n`)
  child.stdout.write(`{"type":"error","message":"Provider rejected key=${SECRET}","hint":"See /Users/private/x","code":"../x","stage":"/etc","http_status":"401"}\n`)
  await tick()
  // Raw (non-JSON) lines are dropped; JSON fields with URLs, paths or key/token/secret markers are replaced.
  assert.ok(!JSON.stringify(sent).includes(SECRET))
  assert.ok(!JSON.stringify(sent).includes('/Users/private'))
  assert.equal(sent.find((event) => event.channel === 'job:progress').data.step, 'The clipping engine could not complete this step.')
  const errors = sent.filter((event) => event.channel === 'job:error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].data.message, 'The clipping engine could not complete this step.')
  assert.equal(errors[0].data.hint, 'The clipping engine could not complete this step.')
  assert.equal(errors[0].data.failureCode, undefined)
  assert.equal(errors[0].data.failureStage, undefined)
  assert.equal(errors[0].data.httpStatus, undefined)

  const huge = fakeChild()
  const oversized = startRunner({ child: huge })
  oversized.runner.startClipJob('audit-job-2', { videoUrl: path.join(WORK_HOME, 'video.mp4') }, oversized.window)
  huge.stdout.write('{"type":"progress","step":"' + 'a'.repeat(1024 * 1024 + 1) + '"}\n')
  await tick()
  assert.deepEqual(oversized.signals, [{ pid: -4242, signal: 'SIGKILL' }])
  assert.deepEqual(oversized.sent.map((event) => event.channel), ['job:error'])
  assert.equal(oversized.sent[0].data.message, 'The clipping engine produced too much output and was stopped.')
  assert.equal(signals.length, 0)
  child.emit('close', 1, null)
  huge.emit('close', null, 'SIGKILL')
})

test('a progress flood is treated as a hostile worker', async () => {
  const child = fakeChild()
  const { runner, window, sent, signals } = startRunner({ child })
  runner.startClipJob('audit-job', { videoUrl: path.join(WORK_HOME, 'video.mp4') }, window)
  child.stdout.write('{"type":"progress","status":"rendering","step":"x","percent":1}\n'.repeat(60))
  await tick()
  assert.deepEqual(signals, [{ pid: -4242, signal: 'SIGKILL' }])
  assert.equal(sent.filter((event) => event.channel === 'job:progress').length, 50)
  assert.equal(sent.filter((event) => event.channel === 'job:error').length, 1)
  child.emit('close', null, 'SIGKILL')
})

test('a result is accepted once, only for this job, and only with a clean exit', async () => {
  const child = fakeChild()
  const { runner, window, sent } = startRunner({ child })
  runner.startClipJob('audit-job', { videoUrl: path.join(WORK_HOME, 'video.mp4') }, window)
  const result = (jobId) => JSON.stringify({ type: 'result', status: 'completed', job_id: jobId, output: { job_id: jobId, clips: [{ clip_index: 0, s3_url: '/etc/passwd', duration_ms: 1, start_time_ms: 0, end_time_ms: 1, virality_score: 1 }] } }) + '\n'
  child.stdout.write(result('audit-job'))
  child.stdout.write(result('audit-job'))
  await tick()
  assert.equal(sent.filter((event) => event.channel === 'job:error').length, 1, 'a second result is an error')
  child.emit('close', 0, null)
  assert.equal(sent.some((event) => event.channel === 'job:complete'), false)
})
