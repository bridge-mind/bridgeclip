const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const { storageRun } = require('../support/storage-fixtures.cjs')
const { PostsStore } = loadMain("export { PostsStore } from './src/main/zernio/posts-store'")

const record = (id, clipPath, status = 'published') => ({
  id, clipPath, clipTitle: 'Test clip', status, error: null, scheduledFor: null, timezone: null,
  createdAt: '2026-09-01T00:00:00Z', uploadedAt: '2026-09-01T00:00:00Z', refreshedAt: null,
  targets: [{ platform: 'youtube', accountId: 'a'.repeat(24), handle: null, status: status === 'published' ? 'published' : 'pending', error: null, url: null, inbox: false }]
})

for (const listFirst of [false, true]) test(`cleanup preserves pending media with damaged activity, including after restart (list first: ${listFirst})`, async t => {
  const f = tempDir('bridgeclip-history-integrity-'); t.after(f.cleanup)
  const library = path.join(f.dir, 'library'), file = path.join(f.dir, 'posts.json')
  const run = storageRun(library, 'Test run', { count: 1 })
  let store = new PostsStore(file)
  const published = record('a'.repeat(24), run.clips[0].s3_url)
  store.save(published); store.remove(published.id)
  const main = loadMain("export * from './src/main/storage-cleanup'; export * as settings from './src/main/settings-store'", {
    electron: fakeElectron(f.dir).electron,
    './job-manager': { liveJobIds: () => new Set(), dismissJob: () => {} },
    './automations': { listAutomations: () => [], automationMediaMatcher: () => () => false },
    './zernio/posts': { listPostingHistory: () => store.history(), hasActiveUploads: () => false }
  })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  main.settings.replaceApiKey('zernioApiKey', 'test-key')
  const preview = await main.previewStorageCleanup('published')
  assert.equal(preview.items.length, 1)
  store.save(record('b'.repeat(24), published.clipPath, 'scheduled'))
  assert.equal((await main.previewStorageCleanup('published')).items.length, 0, 'pending deliveries protect published copies')
  fs.writeFileSync(file, '{broken')
  if (listFirst) assert.deepEqual(store.list(), [])
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(main.previewStorageCleanup('published'), /publishing history could not be read/)
    await assert.rejects(main.cleanStoredContent(preview.token, preview.items.map(item => item.id)), /publishing history could not be read/)
    assert.equal(fs.existsSync(published.clipPath), true)
    // Saving fresh activity invokes list/quarantine, but cannot certify recovery.
    store = new PostsStore(file)
    store.save(record('c'.repeat(24), '/other.mp4'))
  }
  assert.throws(() => new PostsStore(file).history(), /publishing history could not be read/)
})

test('strict history rejects invalid containers, malformed records and duplicate IDs', t => {
  const f = tempDir('bridgeclip-history-schema-'); t.after(f.cleanup)
  const file = path.join(f.dir, 'posts.json'), store = new PostsStore(file, 'one')
  const scoped = path.join(f.dir, 'posts-one.json'), valid = record('a'.repeat(24), '/clip.mp4')
  for (const payload of [null, {}, { version: 2, workspace: 'two', posts: [valid] },
    { version: 2, workspace: 'one', posts: [valid, { ...valid, id: 'bad/id' }] },
    { version: 2, workspace: 'one', posts: [valid, { ...valid, status: 'scheduled' }] }]) {
    fs.writeFileSync(scoped, JSON.stringify(payload))
    assert.throws(() => store.history(), /publishing history could not be read/)
  }
  fs.writeFileSync(scoped, JSON.stringify({ version: 2, workspace: 'one', posts: [valid] }))
  assert.equal(store.history().length, 1, 'a restored valid file is readable when no quarantine occurred')
  assert.deepEqual(new PostsStore(file, 'two').history(), [], 'another workspace stays isolated')
})

for (const suffix of ['damaged-1', 'quarantine-1']) test(`old ${suffix} evidence blocks cleanup even after quarantine expiry`, t => {
  const f = tempDir('bridgeclip-history-quarantine-'); t.after(f.cleanup)
  const file = path.join(f.dir, 'posts.json'), quarantined = `${file}.${suffix}`
  fs.writeFileSync(quarantined, '{broken')
  const store = new PostsStore(file, 'one')
  assert.throws(() => store.history(), /publishing history could not be read/)
  fs.unlinkSync(quarantined)
  store.save(record('a'.repeat(24), '/new.mp4'))
  assert.throws(() => new PostsStore(file, 'one').history(), /publishing history could not be read/)
})

test('damaged bound legacy history cannot silently lose records during migration', t => {
  const f = tempDir('bridgeclip-history-migration-'); t.after(f.cleanup)
  const file = path.join(f.dir, 'posts.json')
  fs.writeFileSync(file, JSON.stringify({ version: 2, workspace: 'one', posts: [record('a'.repeat(24), '/clip.mp4'), { id: 'broken' }] }))
  const store = new PostsStore(file, 'one')
  assert.deepEqual(store.list(), [])
  assert.throws(() => new PostsStore(file, 'one').history(), /publishing history could not be read/)
})
