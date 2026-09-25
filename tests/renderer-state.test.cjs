const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: {
    contents: `export { useJobStore } from './src/renderer/store/use-job-store';
      export { useSettingsStore } from './src/renderer/store/use-settings-store';
      export { parseTimecode } from './src/renderer/lib/utils';
      export { parseJobOutput } from './src/shared/job-output';
      export { loadThumbnail } from './src/renderer/lib/thumbnails';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

function load(api = {}) {
  const module = { exports: {} }
  vm.runInNewContext(bundle, { module, exports: module.exports, require, window: { bridgeclip: api } })
  return module.exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const settings = {
  openrouterConfigured: false, outputDirectory: '/clips',
  pythonPath: 'python3', 
}

function snapshot(id, revision, patch = {}) {
  return {
    id, revision, request: { videoUrl: '/source.mp4' }, status: 'queued', percent: 0, step: '', clipsDone: 0, clipsTotal: 0,
    error: null, errorHint: null, output: null, outputDir: `/clips/${id}`, queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null, finishedAt: null, ...patch
  }
}

test('job snapshots apply in revision order, so a late update cannot undo a newer one', () => {
  const { useJobStore } = load()
  const state = useJobStore.getState()
  state.upsert(snapshot('one', 3, { status: 'rendering', percent: 75 }))
  state.upsert(snapshot('one', 2, { status: 'transcribing', percent: 20 }))
  assert.equal(useJobStore.getState().jobs.one.status, 'rendering')
  assert.equal(useJobStore.getState().jobs.one.percent, 75)
  state.upsert(snapshot('one', 4, { status: 'cancelled' }))
  state.upsert(snapshot('one', 3, { status: 'rendering', percent: 90 }))
  assert.equal(useJobStore.getState().jobs.one.status, 'cancelled')
})

test('hydrating from the main process adds missing jobs without replacing newer live updates', () => {
  const { useJobStore } = load()
  const state = useJobStore.getState()
  // An update pushed while the list request was in flight is newer than the list.
  state.upsert(snapshot('live', 5, { status: 'completed', percent: 100 }))
  state.hydrate([snapshot('live', 4, { status: 'rendering', percent: 80 }), snapshot('other', 1, { status: 'pending' })])
  assert.equal(useJobStore.getState().jobs.live.status, 'completed')
  assert.equal(useJobStore.getState().jobs.other.status, 'pending')
})

test('removing the focused job returns the jobs page to its list', () => {
  const { useJobStore } = load()
  const state = useJobStore.getState()
  state.upsert(snapshot('one', 1, { status: 'failed' }))
  state.focusJob('one')
  state.remove('one')
  assert.equal(useJobStore.getState().focusedJobId, null)
  assert.equal(useJobStore.getState().jobs.one, undefined)
})

test('finished job snapshots stay bounded while active jobs remain visible', () => {
  const { useJobStore } = load()
  const state = useJobStore.getState()
  state.upsert(snapshot('active', 1, { status: 'rendering' }))
  for (let index = 0; index < 60; index++) {
    state.upsert(snapshot(`done-${index}`, 1, {
      status: 'completed', finishedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    }))
  }
  const jobs = useJobStore.getState().jobs
  assert.equal(Object.keys(jobs).length, 51)
  assert.ok(jobs.active)
  assert.equal(jobs['done-0'], undefined)
  assert.ok(jobs['done-59'])
})

test('overlapping settings writes merge at dispatch and retain saving state', async () => {
  const first = deferred()
  const writes = []
  const { useSettingsStore } = load({ settings: {
    load: async () => settings,
    save: async (next) => {
      writes.push(next)
      if (writes.length === 1) await first.promise
      return next
    }
  } })
  await useSettingsStore.getState().load()
  const a = useSettingsStore.getState().save({ pythonPath: '/usr/bin/python3' })
  const b = useSettingsStore.getState().save({ outputDirectory: '/new-clips' })
  await Promise.resolve()
  assert.equal(writes.length, 1)
  assert.equal(useSettingsStore.getState().saving, true)
  first.resolve()
  await Promise.all([a, b])
  assert.equal(writes[1].pythonPath, '/usr/bin/python3')
  assert.equal(useSettingsStore.getState().outputDirectory, '/new-clips')
  assert.equal(useSettingsStore.getState().saving, false)
})

test('failed settings write does not poison subsequent writes', async () => {
  let calls = 0
  const { useSettingsStore } = load({ settings: {
    load: async () => settings,
    save: async (next) => {
      if (++calls === 1) throw new Error('Unavailable')
      return next
    }
  } })
  await useSettingsStore.getState().load()
  const a = useSettingsStore.getState().save({ outputDirectory: '/failed' })
  const b = useSettingsStore.getState().save({ pythonPath: '/usr/bin/python3' })
  await assert.rejects(a, /Unavailable/)
  await b
  assert.equal(useSettingsStore.getState().outputDirectory, '/clips')
  assert.equal(useSettingsStore.getState().pythonPath, '/usr/bin/python3')
  assert.equal(useSettingsStore.getState().saving, false)
})

test('API key changes share the settings queue and keep the saving indicator active', async () => {
  const first = deferred()
  const keyWrite = deferred()
  const calls = []
  const { useSettingsStore } = load({ settings: {
    load: async () => settings,
    save: async (next) => {
      calls.push('settings')
      await first.promise
      return next
    },
    replaceApiKey: async (key) => {
      calls.push(key)
      await keyWrite.promise
      return { ...settings, outputDirectory: '/new-clips', openrouterConfigured: true }
    }
  } })
  await useSettingsStore.getState().load()
  const folder = useSettingsStore.getState().save({ outputDirectory: '/new-clips' })
  const key = useSettingsStore.getState().replaceApiKey('openrouterApiKey', 'test-key')
  await Promise.resolve()
  assert.deepEqual(calls, ['settings'])
  first.resolve()
  await folder
  assert.deepEqual(calls, ['settings', 'openrouterApiKey'])
  assert.equal(useSettingsStore.getState().saving, true)
  keyWrite.resolve()
  await key
  assert.equal(useSettingsStore.getState().openrouterConfigured, true)
  assert.equal(useSettingsStore.getState().saving, false)
})

test('tool check errors clear stale successful status and remain retryable', async () => {
  const { useSettingsStore } = load({ system: { checkTools: async () => { throw new Error('Check failed') } } })
  useSettingsStore.setState({ toolStatus: { python: true } })
  await useSettingsStore.getState().checkTools()
  assert.equal(useSettingsStore.getState().toolStatus, null)
  assert.equal(useSettingsStore.getState().checkingTools, false)
  assert.ok(useSettingsStore.getState().toolError)
})

test('late system check result cannot replace a newer result', async () => {
  const first = deferred()
  let calls = 0
  const { useSettingsStore } = load({ system: { checkTools: async () => {
    if (++calls === 1) return first.promise
    return { python: true, ffmpeg: true }
  } } })
  const oldCheck = useSettingsStore.getState().checkTools()
  await useSettingsStore.getState().checkTools()
  assert.equal(useSettingsStore.getState().toolStatus.ffmpeg, true)
  first.resolve({ python: false, ffmpeg: false })
  await oldCheck
  assert.equal(useSettingsStore.getState().toolStatus.ffmpeg, true)
  assert.equal(useSettingsStore.getState().checkingTools, false)
})

test('timecode parser rejects invalid minute/second fields and infinity', () => {
  const { parseTimecode } = load()
  assert.equal(parseTimecode('1:02:03.5'), 3723.5)
  assert.equal(parseTimecode('90'), 90)
  assert.equal(parseTimecode(''), null)
  assert.ok(Number.isNaN(parseTimecode('1:99')))
  assert.ok(Number.isNaN(parseTimecode('1:60:00')))
  assert.ok(Number.isNaN(parseTimecode('9'.repeat(400))))
})

test('failed thumbnail generation can retry and successful results stay cached', async () => {
  let calls = 0
  const { loadThumbnail } = load({ thumbnails: {
    generate: async () => ++calls === 1 ? null : '/clip_thumb.jpg'
  } })
  assert.equal(await loadThumbnail('/clip.mp4'), null)
  assert.equal(await loadThumbnail('/clip.mp4'), '/clip_thumb.jpg')
  assert.equal(await loadThumbnail('/clip.mp4'), '/clip_thumb.jpg')
  assert.equal(calls, 2)
})

test('historical clip results reject paths, duplicate indexes, and impossible time ranges', () => {
  const { parseJobOutput } = load()
  const clip = {
    clip_index: 0,
    s3_url: 'file:///clips/clip.mp4',
    duration_ms: 6000,
    start_time_ms: 10_000,
    end_time_ms: 16_000,
    virality_score: 0.8
  }
  const valid = parseJobOutput({ job_id: 'old-run', clips: [clip] })
  assert.equal(valid.clips[0].summary, null)
  assert.equal(valid.clips[0].render_fallback, null)
  assert.equal(valid.total_clips, 1)
  assert.equal(parseJobOutput({ clips: [{ ...clip, s3_url: ' ' }] }), null)
  assert.equal(parseJobOutput({ clips: [clip, { ...clip }] }), null)
  assert.equal(parseJobOutput({ clips: [{ ...clip, start_time_ms: 20_000 }] }), null)
})

test('clip results retain bounded framing, pacing, and complete cost metrics', () => {
  const { parseJobOutput } = load()
  const output = parseJobOutput({
    job_id: 'run-one', clips: [], metrics: {
      analysis_duration_seconds: 120,
      smart_framing_available: true, failed_clip_count: 1,
      stage_durations_seconds: { rendering: 12.5, 'invalid/name': 99 },
      clip_layouts: [{ clip_index: 0, layout_type: 'screen_cam', pacing_removed_ms: 1200,
        render_fallback: 'letterbox', shots: [{ start_ms: 0, end_ms: 5000,
          layout: 'screen_cam', source: 'vision', cam_box: [0.5, 0.5, 0.4, 0.4],
          screen_box: [0, 0, 1, 1], secret: 'ignored' }] }],
      api_costs: { total_estimated_cost_usd: 0.04,
        planning: { provider: 'openrouter', model: 'example', prompt_tokens: 100,
          completion_tokens: 20, total_tokens: 120, attempts: 1, estimated_cost_usd: 0.03, secret: 'ignored' } },
      secret: 'ignored'
    }
  })
  assert.equal(output.metrics.clip_layouts[0].pacing_removed_ms, 1200)
  assert.deepEqual(Array.from(output.metrics.clip_layouts[0].shots[0].cam_box), [0.5, 0.5, 0.4, 0.4])
  assert.equal(output.metrics.clip_layouts[0].shots[0].secret, undefined)
  assert.equal(output.metrics.api_costs.planning.prompt_tokens, 100)
  assert.equal(output.metrics.api_costs.planning.completion_tokens, 20)
  assert.equal(output.metrics.stage_durations_seconds['invalid/name'], undefined)
  assert.equal(output.metrics.secret, undefined)
  assert.equal(output.metrics.analysis_duration_seconds, 120)
})
