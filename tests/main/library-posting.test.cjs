'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

test('only a confirmed published post is hidden; partial, scheduled and inbox deliveries stay visible', () => {
  const { clipPostingStatus } = loadMain("export * from './src/shared/library-posting'")
  const post = (status, targets) => ({ status, targets })
  const target = (status, inbox = false) => ({ platform: 'youtube', status, inbox })
  for (const [posts, expected] of [
    [[], 'not_posted'], [[post('published', [target('published')])], 'posted'],
    [[post('partial', [target('published'), target('failed')])], 'partial'],
    [[post('scheduled', [target('pending')])], 'scheduled'],
    [[post('publishing', [target('pending')])], 'publishing'],
    [[post('published', [target('published', true)])], 'draft'],
    [[post('failed', [target('failed')])], 'failed']
  ]) assert.equal(clipPostingStatus(0, posts).state, expected)
  assert.deepEqual(clipPostingStatus(0, [post('published', [target('published', true)])]).platforms, [])
})

test('queue reordering leaves submitted and uncertain slots fixed and preserves metadata', () => {
  const { reorderQueuedContent, hasEnhancedMetadata } = loadMain("export * from './src/shared/automations'")
  const a = { id: 'a', status: 'queued', metadataEnhancement: {}, generatedMetadata: [{ platform: 'youtube' }] }
  const fixed = { id: 'fixed', status: 'posted', postId: 'post' }
  const uncertain = { id: 'uncertain', status: 'needs_review' }
  const b = { id: 'b', status: 'queued' }
  const c = { id: 'c', status: 'queued', postId: 'post-c' }
  const initial = [a, fixed, b, uncertain, c]
  const reordered = reorderQueuedContent(initial, 'b', 'a')
  assert.deepEqual(reordered.map((item) => item.id), ['b', 'fixed', 'a', 'uncertain', 'c'])
  assert.equal(reordered[2], a)
  assert.deepEqual(reorderQueuedContent(reordered, 'b', null), initial)
  for (const id of ['fixed', 'uncertain', 'c']) {
    assert.throws(() => reorderQueuedContent(initial, id, 'a'), /Only unposted/)
    assert.throws(() => reorderQueuedContent(initial, 'a', id), /Only unposted/)
  }
  assert.equal(hasEnhancedMetadata(a, ['youtube']), true)
  assert.equal(hasEnhancedMetadata(a, ['youtube', 'instagram']), false)
  assert.equal(hasEnhancedMetadata({ ...a, metadataEnhancement: undefined }, ['youtube']), false)
})

function makeRun(library, name, count = 3) {
  const run = path.join(library, name)
  fs.mkdirSync(run, { recursive: true })
  const clips = Array.from({ length: count }, (_, index) => {
    const file = path.join(run, `clip_${index}.mp4`)
    fs.writeFileSync(file, `${name}-clip-${index}`)
    return { clip_index: index, s3_url: `file://${file}`, summary: 'Same title', duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.8 }
  })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ clips }))
  return { run, clips }
}

function fixture(mocks = {}) {
  const temp = tempDir('bridgeclip-library-status-')
  const library = path.join(temp.dir, 'library')
  const { run, clips } = makeRun(library, 'run')
  for (const [index, clip] of clips.entries()) fs.writeFileSync(clip.s3_url.slice(7), `clip-${index}`)
  const posts = [], automations = []
  const { electron } = fakeElectron(temp.dir)
  const decrypt = electron.safeStorage.decryptString
  const counters = { decrypts: 0 }
  electron.safeStorage.decryptString = (value) => { counters.decrypts++; return decrypt(value) }
  const isBankFile = (file) => typeof file === 'string' && file.startsWith(path.join(temp.dir, 'bank'))
  const main = loadMain("export * from './src/main/library-posting'; export * as settings from './src/main/settings-store'", {
    electron,
    './zernio/posts': { listPostingHistory: () => posts },
    './automations': { listAutomations: () => automations, automationMediaMatcher: () => isBankFile },
    ...mocks
  })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  main.settings.replaceApiKey('zernioApiKey', 'test-key')
  return { ...temp, main, library, run, clips, posts, automations, counters }
}

test('library history matches original paths, source provenance and byte-identical legacy bank copies', async () => {
  const f = fixture()
  try {
    const direct = f.clips[0].s3_url.slice(7)
    f.posts.push({ id: 'direct', clipPath: direct, status: 'scheduled', targets: [] })
    f.posts.push({ id: 'origin', clipPath: '/deleted/bank-copy.mp4', status: 'published', targets: [{ platform: 'youtube', status: 'published' }] })
    f.automations.push({ content: [{ postId: 'origin', sourceClipPath: f.clips[1].s3_url.slice(7) }] })
    const bank = path.join(f.dir, 'bank-copy.mp4')
    fs.copyFileSync(f.clips[2].s3_url.slice(7), bank)
    f.posts.push({ id: 'legacy', clipPath: bank, status: 'published', targets: [{ platform: 'instagram', status: 'published' }] })
    f.posts.push({ id: 'missing', clipPath: path.join(f.dir, 'bank-missing.mp4'), status: 'published', targets: [] })
    assert.deepEqual((await f.main.libraryPostingStatus(f.run)).map((item) => item.state), ['scheduled', 'posted', 'posted'])
    fs.writeFileSync(bank, 'other!')
    assert.equal((await f.main.libraryPostingStatus(f.run))[2].state, 'not_posted', 'same title and size do not imply identical content')
    f.main.settings.replaceApiKey('zernioApiKey', '')
    assert.ok((await f.main.libraryPostingStatus(f.run)).every((item) => item.state === 'not_posted'))
  } finally { f.cleanup() }
})

test('Library enhancement uses automation generators and returns a reviewable draft without publishing', async () => {
  const calls = []
  const generated = [{ platform: 'youtube', title: 'Enhanced title', caption: 'Caption', tags: ['tag'], categoryId: '22', topicTag: null }]
  const f = fixture({
    './automation-source': { sourceFromOutput: () => null, parseSourceContext: (value) => value, completeSourceContext: async (value) => value },
    './automation-metadata': {
      transcribeAutomationClip: async (file) => { calls.push(['transcribe', file]); return 'spoken words' },
      researchAutomationTopic: async (...args) => { calls.push(['research', ...args]); return { status: 'success', summary: 'Context', sources: [] } },
      generateAutomationMetadata: async (...args) => { calls.push(['generate', ...args]); return generated }
    }
  })
  try {
    f.main.settings.replaceApiKey('openrouterApiKey', 'test-writing-key')
    const options = { platforms: ['youtube'], research: true, source: { title: 'Original', description: '', channel: '', url: null }, notes: 'Notes' }
    const result = await f.main.enhanceLibraryMetadata(f.run, 0, options)
    assert.deepEqual(result.posts, generated)
    assert.deepEqual(calls.map((call) => call[0]), ['transcribe', 'research', 'generate'])
    assert.equal(calls[2][1], 'spoken words')
    assert.equal(calls[2][3], 'Notes')
    assert.deepEqual(calls[2][4], ['youtube'])
    assert.equal(result.source.title, 'Original')
    assert.equal(f.posts.length, 0)
    await assert.rejects(f.main.enhanceLibraryMetadata(f.run, 9, options), /no longer/)
    await assert.rejects(f.main.enhanceLibraryMetadata(f.dir, 0, options), /Library/)
    await assert.rejects(f.main.enhanceLibraryMetadata(f.run, 0, { ...options, platforms: ['unknown'] }), /valid platforms/)
    const before = calls.length
    await f.main.enhanceLibraryMetadata(f.run, 0, { ...options, research: false })
    assert.deepEqual(calls.slice(before).map((call) => call[0]), ['transcribe', 'generate'])
  } finally { f.cleanup() }
})

test('manual marks work without an account and undo reveals provider status without altering history', async () => {
  const f = fixture()
  try {
    f.posts.push({ id: 'published', clipPath: f.clips[0].s3_url.slice(7), status: 'published', targets: [{ platform: 'youtube', status: 'published' }] })
    f.posts.push({ id: 'failed', clipPath: f.clips[1].s3_url.slice(7), status: 'failed', targets: [] })
    const original = JSON.stringify(f.posts)
    for (const id of [0, 1]) fs.writeFileSync(path.join(f.run, `.bridgeclip-posted-${id}`), '')
    let statuses = await f.main.libraryPostingStatus(f.run)
    assert.deepEqual(statuses.map(s => s.state), ['posted', 'posted', 'not_posted'])
    assert.equal(statuses[0].manuallyPosted, true)
    assert.deepEqual(statuses[0].platforms, ['youtube'])
    f.main.settings.replaceApiKey('zernioApiKey', '')
    statuses = await f.main.libraryPostingStatus(f.run)
    assert.deepEqual(statuses[1], { clipIndex: 1, state: 'posted', platforms: [], manuallyPosted: true })
    f.main.settings.replaceApiKey('zernioApiKey', 'test-key')
    for (const id of [0, 1]) fs.unlinkSync(path.join(f.run, `.bridgeclip-posted-${id}`))
    statuses = await f.main.libraryPostingStatus(f.run)
    assert.deepEqual(statuses.map(s => s.state), ['posted', 'failed', 'not_posted'])
    assert.equal(statuses[0].manuallyPosted, undefined)
    assert.equal(JSON.stringify(f.posts), original)
  } finally { f.cleanup() }
})

test('the Library summary checks many runs in one request, reading settings a fixed number of times', async () => {
  const f = fixture()
  try {
    const runs = [f.run, ...Array.from({ length: 8 }, (_, index) => makeRun(f.library, `run-${index}`, 10).run)]
    const second = makeRun(f.library, 'run-0', 10)
    f.posts.push({ id: 'direct', clipPath: second.clips[3].s3_url.slice(7), status: 'published', targets: [{ platform: 'youtube', status: 'published' }] })
    const bank = path.join(f.dir, 'bank-copy.mp4')
    fs.copyFileSync(f.clips[2].s3_url.slice(7), bank)
    f.posts.push({ id: 'legacy', clipPath: bank, status: 'published', targets: [{ platform: 'instagram', status: 'published' }] })
    fs.writeFileSync(path.join(runs[2], '.bridgeclip-posted-0'), '')

    f.counters.decrypts = 0
    await f.main.libraryPostingSummary([f.run])
    const single = f.counters.decrypts
    f.counters.decrypts = 0
    const results = await f.main.libraryPostingSummary([...runs, 'relative/run', path.join(f.dir, 'outside'), f.run])
    assert.equal(f.counters.decrypts, single, 'settings are read once per request, not per run or clip')
    const byRun = Object.fromEntries(results.map((result) => [result.outputDir, result.counts]))
    assert.deepEqual(byRun[f.run], { posted: 1, notPosted: 2 }, 'byte-identical bank copies still count')
    assert.deepEqual(byRun[runs[1]], { posted: 1, notPosted: 9 })
    assert.deepEqual(byRun[runs[2]], { posted: 1, notPosted: 9 }, 'manual marks count')
    assert.deepEqual(byRun[runs[3]], { posted: 0, notPosted: 10 })
    assert.equal(byRun['relative/run'], null, 'an invalid run fails alone')
    assert.equal(byRun[path.join(f.dir, 'outside')], null)
    assert.equal(results.length, runs.length + 2, 'duplicates are checked once')

    for (const input of ['not-an-array', [1], Array.from({ length: 5001 }, () => f.run)]) await assert.rejects(f.main.libraryPostingSummary(input), /Choose runs/)
    await assert.rejects(f.main.libraryPostingStatus('relative/run'), /absolute path/)
    f.main.settings.replaceApiKey('zernioApiKey', '')
    assert.deepEqual((await f.main.libraryPostingSummary([runs[2]]))[0].counts, { posted: 1, notPosted: 9 }, 'manual marks work without an account')
  } finally { f.cleanup() }
})
