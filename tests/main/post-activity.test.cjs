const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const { storageRun } = require('../support/storage-fixtures.cjs')

const source = `
  export * as posts from './src/main/zernio/posts'
  export * as library from './src/main/library-posting'
  export * as storage from './src/main/storage-cleanup'
  export * as settings from './src/main/settings-store'
  export { PostsStore } from './src/main/zernio/posts-store'
  export { workspaceId } from './src/main/zernio/workspace-cache'
`

function fixture(t, extra = {}) {
  const temp = tempDir('bridgeclip-post-activity-')
  t.after(temp.cleanup)
  const electron = fakeElectron(temp.dir).electron
  const automations = []
  const mocks = {
    electron,
    './job-manager': { liveJobIds: () => new Set(), dismissJob: () => {} },
    './automations': { listAutomations: () => automations, automationMediaMatcher: () => () => false },
    ...extra
  }
  const reload = () => loadMain(source, mocks)
  const main = reload()
  const library = path.join(temp.dir, 'Library')
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  main.settings.replaceApiKey('zernioApiKey', 'test-key')
  const file = path.join(electron.app.getPath('userData'), 'zernio-posts.json')
  const workspace = main.workspaceId('test-key')
  const store = new main.PostsStore(file, workspace)
  const scoped = file.replace('.json', `-${workspace}.json`)
  const { run, clips } = storageRun(library, 'Published project', { count: 3 })
  const record = (id, clip = 0, status = 'published', overrides = {}) => ({
    id, clipPath: clips[clip].s3_url, clipTitle: clips[clip].summary, status,
    targets: [{ platform: 'youtube', accountId: 'test-account', handle: '@studio', status: status === 'published' ? 'published' : 'pending', error: null, url: null, inbox: false }],
    scheduledFor: null, timezone: null, error: null, createdAt: '2026-09-01T00:00:00.000Z', uploadedAt: '2026-09-01T00:00:00.000Z', refreshedAt: null,
    ...overrides
  })
  return { ...temp, main, reload, file, scoped, workspace, store, run, clips, record, automations }
}

test('dismissing existing activity preserves Posted, platforms, counts and cleanup across restarts', async t => {
  const f = fixture(t)
  // A pre-upgrade activity file needs no special migration step before dismissal.
  fs.writeFileSync(f.scoped, JSON.stringify({ version: 2, workspace: f.workspace, posts: [f.record('published')] }))
  const before = await f.main.library.libraryPostingStatus(f.run)
  const preview = await f.main.storage.previewStorageCleanup('published')
  assert.equal(preview.items[0].clipCount, 1)
  assert.deepEqual(f.main.posts.dismissPost('published'), [])
  assert.deepEqual(await f.main.library.libraryPostingStatus(f.run), before)
  const restarted = f.reload()
  assert.deepEqual(restarted.posts.listPosts(), [], 'dismissal survives restarting')
  assert.deepEqual(await restarted.library.libraryPostingStatus(f.run), before)
  assert.deepEqual(before[0], { clipIndex: 0, state: 'posted', platforms: ['youtube'] })
  assert.deepEqual((await restarted.library.libraryPostingSummary([f.run]))[0].counts, { posted: 1, notPosted: 2 })
  assert.equal((await restarted.storage.previewStorageCleanup('published')).items[0].clipCount, 1)
  // Dismissing activity does not invalidate a previously reviewed cleanup.
  assert.deepEqual(await f.main.storage.cleanStoredContent(preview.token, [preview.items[0].id]), { cleaned: 1, skipped: 0, failed: 0 })
  assert.equal(fs.existsSync(f.clips[0].s3_url), false)
  assert.equal(fs.existsSync(f.clips[1].s3_url), true)
})

test('automatic count and byte limits only trim activity, preserving every publishing record', async t => {
  const f = fixture(t)
  f.store.save(f.record('first'))
  f.store.save(...Array.from({ length: 300 }, (_, i) => f.record(`new-${i}`, 1, 'published', { createdAt: new Date(Date.parse('2026-09-02T00:00:00Z') + i * 60_000).toISOString() })))
  assert.equal(f.main.posts.listPosts().length, 300)
  assert.equal(f.store.get('first'), null)
  assert.equal(f.main.posts.listPostingHistory().length, 301)
  assert.equal((await f.reload().library.libraryPostingStatus(f.run))[0].state, 'posted')

  const large = f.record('large').targets[0]
  f.store.save(...Array.from({ length: 290 }, (_, i) => f.record(`large-${i}`, 2, 'published', {
    createdAt: new Date(Date.parse('2026-09-03T00:00:00Z') + i * 60_000).toISOString(),
    targets: Array.from({ length: 7 }, () => ({ ...large, error: 'e'.repeat(1000) }))
  })))
  assert.ok(f.main.posts.listPosts().length < 300)
  assert.equal(f.reload().posts.listPostingHistory().length, 591)
  assert.ok((await f.main.library.libraryPostingStatus(f.run)).every(s => s.state === 'posted'))
})

test('dismissed partial, failed and inbox deliveries keep their status and cleanup protections', async t => {
  const f = fixture(t)
  const published = f.record('seed').targets[0]
  const records = [
    f.record('partial', 0, 'partial', { targets: [published, { ...published, platform: 'instagram', status: 'failed' }] }),
    f.record('failed', 1, 'failed', { targets: [{ ...published, status: 'failed' }] }),
    f.record('inbox', 2, 'published', { targets: [{ ...published, inbox: true }] })
  ]
  f.store.save(...records)
  for (const post of records) f.main.posts.dismissPost(post.id)
  assert.deepEqual((await f.reload().library.libraryPostingStatus(f.run)).map(s => s.state), ['partial', 'failed', 'draft'])
  assert.deepEqual((await f.main.storage.previewStorageCleanup('published')).items, [])
  f.store.save(f.record('another-success'))
  assert.equal((await f.main.library.libraryPostingStatus(f.run))[0].state, 'posted')
  assert.deepEqual((await f.main.storage.previewStorageCleanup('published')).items, [], 'a successful copy cannot erase an unresolved delivery')
  for (const status of ['scheduled', 'publishing']) {
    f.store.save(f.record(status, 1, status))
    assert.throws(() => f.main.posts.dismissPost(status), /Cancel the post/)
    assert.ok(f.main.posts.listPosts().some(p => p.id === status))
  }
})

test('automation provenance survives dismissal and removal of its bank copy without resurfacing activity', async t => {
  const f = fixture(t)
  const bank = path.join(f.dir, 'bank-copy.mp4')
  fs.copyFileSync(f.clips[0].s3_url, bank)
  f.automations.push({ content: [{ postId: 'automation-post', sourceClipPath: f.clips[0].s3_url, status: 'posted' }] })
  f.store.save(f.record('automation-post', 0, 'published', { clipPath: bank }))
  f.main.posts.dismissPost('automation-post')
  assert.equal((await f.main.library.libraryPostingStatus(f.run))[0].state, 'posted')
  f.main.posts.relinkAutomationPost('automation-post', bank, f.clips[0].s3_url)
  fs.unlinkSync(bank)
  f.automations.length = 0
  assert.deepEqual(f.main.posts.listPosts(), [])
  assert.equal((await f.reload().library.libraryPostingStatus(f.run))[0].state, 'posted')
})

test('retained records stay workspace scoped, and unreadable evidence blocks cleanup', async t => {
  const f = fixture(t)
  f.store.save(f.record('published'))
  f.main.posts.dismissPost('published')
  f.main.settings.replaceApiKey('zernioApiKey', 'other-key')
  assert.deepEqual(f.main.posts.listPostingHistory(), [])
  assert.equal((await f.main.library.libraryPostingStatus(f.run))[0].state, 'not_posted')
  f.main.settings.replaceApiKey('zernioApiKey', 'test-key')
  assert.equal((await f.main.library.libraryPostingStatus(f.run))[0].state, 'posted')
  const archive = path.join(`${f.scoped}.history`, fs.readdirSync(`${f.scoped}.history`)[0])
  const saved = JSON.parse(fs.readFileSync(archive))
  fs.writeFileSync(archive, JSON.stringify({ ...saved, workspace: 'wrong-workspace' }))
  await assert.rejects(f.main.storage.previewStorageCleanup('published'), /history could not be read/)
  fs.writeFileSync(archive, '{bad json')
  await assert.rejects(f.main.library.libraryPostingStatus(f.run), /history could not be read/)
  assert.ok(f.clips.every(c => fs.existsSync(c.s3_url)))
})

test('an archive failure keeps the notification and its publication evidence intact', async t => {
  const f = fixture(t, { fs: { ...fs, renameSync: (from, to) => {
    if (to.includes('.history')) throw new Error('Disk unavailable')
    return fs.renameSync(from, to)
  } } })
  f.store.save(f.record('published'))
  assert.throws(() => f.main.posts.dismissPost('published'), /Disk unavailable/)
  assert.equal(f.main.posts.listPosts().length, 1)
  assert.equal((await f.main.library.libraryPostingStatus(f.run))[0].state, 'posted')
})
