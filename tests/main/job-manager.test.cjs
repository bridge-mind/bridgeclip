const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function transpile(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

function loadModule(file, mocks = {}) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(file), { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, console, queueMicrotask })
  return module.exports
}

const jobs = loadModule('shared/jobs.ts')
const jobOutput = loadModule('shared/job-output.ts')

/** A job manager wired to a fake runner that records each start and lets the test drive it. */
function setup() {
  const starts = []
  const cancelled = []
  const records = []
  const runner = {
    startClipJob: (jobId, config, sink, onExit, outputDirectory) => starts.push({ jobId, config, sink, onExit, outputDirectory }),
    cancelJob: (jobId) => { cancelled.push(jobId); return true }
  }
  const manager = loadModule('main/job-manager.ts', {
    './pipeline-runner': runner,
    './run-history': { finishRunRecord: (dir, jobId, status) => records.push({ dir, jobId, status }) },
    './logger': { logger: { info() {}, warn() {}, error() {} } },
    '../shared/job-output': jobOutput,
    '../shared/jobs': jobs
  })
  const sent = []
  let window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) } }
  manager.initJobManager(() => window)
  const enqueue = (id, outputDirectory = '/clips') => manager.enqueueJob(id, { videoUrl: `/videos/${id}.mp4` }, outputDirectory)
  const status = (id) => manager.listJobs().find((job) => job.id === id)?.status
  return { manager, starts, cancelled, records, sent, enqueue, status, setWindow: (next) => { window = next } }
}

test('runs at most MAX_PARALLEL_JOBS at once and starts queued jobs in order as slots free', () => {
  const { starts, enqueue, status } = setup()
  assert.equal(jobs.MAX_PARALLEL_JOBS, 2)
  enqueue('a'); enqueue('b'); enqueue('c'); enqueue('d')
  assert.deepEqual(starts.map((s) => s.jobId), ['a', 'b'])
  assert.equal(status('a'), 'pending')
  assert.equal(status('c'), 'queued')
  assert.equal(status('d'), 'queued')

  starts[0].sink.webContents.send('job:complete', { output: { job_id: 'a', clips: [] } })
  // Completion alone does not free the slot; the process has to exit.
  assert.equal(starts.length, 2)
  assert.equal(status('a'), 'completed')
  starts[0].onExit()
  assert.deepEqual(starts.map((s) => s.jobId), ['a', 'b', 'c'])
  starts[1].onExit()
  assert.deepEqual(starts.map((s) => s.jobId), ['a', 'b', 'c', 'd'])
  // A repeated exit callback cannot free a second slot.
  starts[1].onExit()
  assert.equal(starts.length, 4)
})

test('queued jobs start in the output folder captured when they were enqueued', () => {
  const { starts, enqueue } = setup()
  enqueue('a', '/original')
  enqueue('b', '/original')
  enqueue('c', '/original')
  enqueue('d', '/new-selection')
  starts[0].onExit()
  starts[1].onExit()
  assert.deepEqual(starts.map((start) => start.outputDirectory),
    ['/original', '/original', '/original', '/new-selection'])
})

test('runner events become snapshots with rising revisions, sent to the window open at the time', () => {
  const { starts, sent, enqueue, setWindow, manager } = setup()
  enqueue('a')
  const sink = starts[0].sink
  sink.webContents.send('job:progress', { status: 'transcribing', percent: 30, step: 'Transcribing', clips_done: 0, clips_total: 0 })

  // The window was reloaded or reopened: later updates go to the new one.
  const later = []
  setWindow({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => later.push({ channel, data }) } })
  sink.webContents.send('job:progress', { status: 'rendering', percent: 150, step: 'Rendering', clips_done: 1, clips_total: 3 })
  sink.webContents.send('job:error', { message: 'Audio transcription failed.', hint: 'Check the OpenRouter key.' })

  const revisions = [...sent, ...later].map((event) => event.data.revision)
  assert.deepEqual(revisions, [...revisions].sort((x, y) => x - y))
  assert.ok(sent.every((event) => event.channel === 'jobs:update'))
  const last = later.at(-1).data
  assert.equal(last.status, 'failed')
  assert.equal(last.error, 'Audio transcription failed.')
  assert.equal(last.errorHint, 'Check the OpenRouter key.')
  assert.equal(later[0].data.percent, 100, 'percent is clamped')
  assert.equal(manager.listJobs()[0].status, 'failed')
})

test('cancelling a queued job removes it from the queue and records the cancellation', () => {
  const { manager, starts, records, enqueue, status } = setup()
  enqueue('a'); enqueue('b'); enqueue('c')
  assert.equal(manager.cancelTrackedJob('c'), true)
  assert.equal(status('c'), 'cancelled')
  assert.deepEqual(records, [{ dir: '/clips', jobId: 'c', status: 'cancelled' }])
  starts[0].onExit()
  starts[1].onExit()
  assert.deepEqual(starts.map((s) => s.jobId), ['a', 'b'], 'the cancelled job never starts')
  assert.equal(manager.cancelTrackedJob('c'), false, 'a finished job cannot be cancelled again')
})

test('cancelling a running job ignores its late events and frees the slot only when it exits', () => {
  const { manager, starts, cancelled, enqueue, status } = setup()
  enqueue('a'); enqueue('b'); enqueue('c')
  assert.equal(manager.cancelTrackedJob('a'), true)
  assert.deepEqual(cancelled, ['a'])
  assert.equal(status('a'), 'cancelled')
  starts[0].sink.webContents.send('job:complete', { output: { job_id: 'a', clips: [] } })
  assert.equal(status('a'), 'cancelled')
  assert.equal(starts.length, 2, 'the process is still stopping')
  starts[0].onExit()
  assert.deepEqual(starts.map((s) => s.jobId), ['a', 'b', 'c'])
})

test('live job ids cover queued and running jobs; quitting records queued jobs as cancelled', () => {
  const { manager, records, enqueue } = setup()
  enqueue('a'); enqueue('b'); enqueue('c')
  assert.deepEqual([...manager.liveJobIds()].sort(), ['a', 'b', 'c'])
  manager.cancelQueuedJobsForQuit()
  assert.deepEqual(records, [{ dir: '/clips', jobId: 'c', status: 'cancelled' }])
})

test('only finished jobs can be dismissed from the session list', () => {
  const { manager, starts, enqueue } = setup()
  enqueue('a')
  assert.equal(manager.dismissJob('a'), false)
  starts[0].sink.webContents.send('job:error', { message: 'Stopped.' })
  assert.equal(manager.dismissJob('a'), true)
  assert.equal(manager.listJobs().length, 0)
})
