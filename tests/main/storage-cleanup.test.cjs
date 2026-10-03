const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const { storageRun } = require('../support/storage-fixtures.cjs')
const { directoryLinkType, fileLinksAvailable } = require('../support/symlinks.cjs')

function fixture(extra = {}) {
  const temp = tempDir('bridgeclip-storage-cleanup-')
  const library = path.join(temp.dir, 'Library')
  fs.mkdirSync(library)
  const active = new Set(), posts = [], automations = []
  let uploading = false
  const main = loadMain("export * from './src/main/storage-cleanup'; export * as editor from './src/main/clip-editor'; export * as settings from './src/main/settings-store'", {
    electron: fakeElectron(temp.dir).electron,
    './job-manager': { liveJobIds: () => active, dismissJob: () => {} },
    './automations': { listAutomations: () => automations, automationMediaMatcher: () => () => false },
    './zernio/posts': { listPostingHistory: () => posts, hasActiveUploads: () => uploading },
    ...extra
  })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  main.settings.replaceApiKey('zernioApiKey', 'test-key')
  return { ...temp, library, main, active, posts, automations, setUploading: value => { uploading = value }, run: (name, options) => storageRun(library, name, options) }
}
const selected = preview => preview.items.filter(item => !item.keepReason).map(item => item.id)
const readProject = run => JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json')))

test('manual posted cleanup and source cleanup work without a connected posting account', async t => {
  const f = fixture({ './automations': { listAutomations: () => { throw new Error('No posting account') } } }); t.after(f.cleanup)
  f.main.settings.replaceApiKey('zernioApiKey', '')
  f.run('Manually posted', { posted: [0, 1] })
  f.run('Finished editing', { editor: true })
  for (const kind of ['published', 'sources']) {
    const preview = await f.main.previewStorageCleanup(kind)
    assert.equal(preview.items.length, 1)
    assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 1, skipped: 0, failed: 0 })
  }
})

test('published cleanup removes whole delivered runs and only posted clips in mixed runs', async t => {
  const f = fixture(); t.after(f.cleanup)
  const delivered = f.run('Delivered', { posted: [0, 1], editor: true })
  const mixed = f.run('Mixed', { posted: [0], editor: true })
  const unposted = f.run('Keep me')
  fs.writeFileSync(path.join(delivered.run, 'source-original.mp4'), 'large retained source')
  const preview = await f.main.previewStorageCleanup('published')
  assert.deepEqual(preview.items.map(item => [item.title, item.kind, item.clipCount]).sort(), [['Delivered', 'run', 2], ['Mixed', 'clips', 1]])
  assert.equal(fs.existsSync(delivered.run), true, 'preview does not delete')
  assert.ok(preview.items.every(item => item.bytes > 0))
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 2, skipped: 0, failed: 0 })
  assert.equal(fs.existsSync(delivered.run), false)
  assert.equal(fs.existsSync(mixed.clips[0].s3_url), false)
  assert.equal(fs.existsSync(mixed.clips[1].s3_url), true)
  assert.equal(fs.existsSync(path.join(mixed.run, 'editor-source.mp4')), true)
  assert.equal(fs.existsSync(unposted.clips[0].s3_url), true)
  const project = readProject(mixed.run)
  assert.equal(project.candidates[0].status, 'baked', 'cleaning a delivered export does not undo finished edits')
  assert.deepEqual(project.candidates[0].exports, [])
  assert.equal(project.candidates[1].status, 'baked')
  const output = JSON.parse(fs.readFileSync(path.join(mixed.run, 'job_output.json')))
  assert.equal(output.next_clip_index, 2, 'published IDs cannot be recycled')
  assert.deepEqual(output.clips.map(clip => clip.clip_index), [1])
  await assert.rejects(f.main.cleanStoredContent(preview.token, selected(preview)), /expired/)
})

test('source inventory is read-only, separates unfinished projects, and frees only selected finished media', async t => {
  const f = fixture(); t.after(f.cleanup)
  const ready = f.run('Ready', { editor: true })
  const editing = f.run('Still editing', { editor: true, unfinished: true })
  f.run('Automatic')
  fs.writeFileSync(path.join(ready.run, 'editor-source-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4'), Buffer.alloc(700))
  const summary = await f.main.sourceStorageSummary()
  assert.deepEqual({ ...summary, outputDirectory: '' }, { outputDirectory: '', sourceBytes: 4700, previewBytes: 1000, projects: 2, readyProjects: 1, readyBytes: 3200, unfinishedProjects: 1, unavailableProjects: 0 })
  assert.equal(fs.existsSync(path.join(ready.run, 'editor-source-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4')), true, 'inventory must not sweep old sources')
  const preview = await f.main.previewStorageCleanup('sources')
  assert.equal(preview.items.find(item => item.title === 'Still editing').keepReason, '1 clip still to finish')
  const blocked = preview.items.find(item => item.keepReason)
  await assert.rejects(f.main.cleanStoredContent(preview.token, [blocked.id]), /Select projects/)
  const result = await f.main.cleanStoredContent(preview.token, selected(preview))
  assert.deepEqual(result, { cleaned: 1, skipped: 0, failed: 0 })
  assert.equal(readProject(ready.run).media_freed, true)
  assert.equal(fs.existsSync(path.join(ready.run, 'editor-source.mp4')), false)
  assert.equal(fs.existsSync(path.join(ready.run, 'editor-preview.mp4')), false)
  assert.equal(fs.existsSync(ready.clips[0].s3_url), true, 'exports survive source cleanup')
  assert.equal(fs.existsSync(path.join(editing.run, 'editor-source.mp4')), true)
  assert.equal((await f.main.sourceStorageSummary()).readyBytes, 0)
})

test('all posted exports do not authorize deleting an unfinished editor project', async t => {
  const f = fixture(); t.after(f.cleanup)
  const run = f.run('Not finished', { posted: [0, 1], editor: true, unfinished: true })
  const preview = await f.main.previewStorageCleanup('published')
  assert.equal(preview.items[0].kind, 'clips')
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 1, skipped: 0, failed: 0 })
  assert.equal(fs.existsSync(path.join(run.run, 'editor-source.mp4')), true)
  assert.equal(readProject(run.run).candidates[1].status, 'ready')
})

test('published copies never override pending, partial, inbox, failed or queued deliveries', async t => {
  const f = fixture(); t.after(f.cleanup)
  const run = f.run('Published twice', { posted: [0] })
  const published = { id: 'ok', clipPath: run.clips[0].s3_url, status: 'published', targets: [{ platform: 'youtube', status: 'published' }] }
  for (const status of ['scheduled', 'publishing', 'partial', 'failed', 'draft', 'missing']) {
    f.posts.splice(0, f.posts.length, published, { ...published, id: 'pending', status })
    assert.equal((await f.main.previewStorageCleanup('published')).items.length, 0, status)
  }
  f.posts.splice(0, f.posts.length, published, { ...published, id: 'inbox', targets: [{ platform: 'tiktok', status: 'published', inbox: true }] })
  assert.equal((await f.main.previewStorageCleanup('published')).items.length, 0)
  f.posts.splice(0, f.posts.length, published)
  f.automations.push({ content: [{ sourceClipPath: run.clips[0].s3_url, status: 'queued' }] })
  assert.equal((await f.main.previewStorageCleanup('published')).items.length, 0)
  f.automations.length = 0
  assert.equal((await f.main.previewStorageCleanup('published')).items[0].clipCount, 1)
})

test('confirmation rechecks manual marks, editor revisions, live jobs and publishing context', async t => {
  const f = fixture(); t.after(f.cleanup)
  const run = f.run('Changing', { posted: [0, 1], editor: true })
  let preview = await f.main.previewStorageCleanup('published')
  fs.unlinkSync(path.join(run.run, '.bridgeclip-posted-0'))
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 0, skipped: 1, failed: 0 })
  assert.equal(fs.existsSync(run.clips[0].s3_url), true)
  preview = await f.main.previewStorageCleanup('sources')
  const project = readProject(run.run); project.revision++; project.candidates[0].status = 'refining'
  fs.writeFileSync(path.join(run.run, 'editor-project.json'), JSON.stringify(project))
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 0, skipped: 1, failed: 0 })
  assert.equal(fs.existsSync(path.join(run.run, 'editor-source.mp4')), true)
  preview = await f.main.previewStorageCleanup('published')
  f.active.add('Changing')
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 0, skipped: 1, failed: 0 })
  f.active.clear()
  preview = await f.main.previewStorageCleanup('published')
  f.setUploading(true)
  await assert.rejects(f.main.cleanStoredContent(preview.token, selected(preview)), /posting status changed/)
  await assert.rejects(f.main.previewStorageCleanup('published'), /uploads/)
  f.setUploading(false)
  f.posts.push({ id: 'new', clipPath: run.clips[1].s3_url, status: 'scheduled', targets: [] })
  await assert.rejects(f.main.cleanStoredContent(preview.token, selected(preview)), /posting status changed/)
})

test('only selected projects can be deleted; forged, expired and other-workspace requests fail', async t => {
  const f = fixture(); t.after(f.cleanup)
  const a = f.run('A', { posted: [0, 1] }), b = f.run('B', { posted: [0, 1] })
  let preview = await f.main.previewStorageCleanup('published')
  await assert.rejects(f.main.cleanStoredContent(preview.token, [a.run]), /Select projects/)
  await assert.rejects(f.main.cleanStoredContent(preview.token, []), /Select projects/)
  await assert.rejects(f.main.cleanStoredContent(preview.token, [preview.items[0].id, preview.items[0].id]), /Select projects/)
  await assert.rejects(f.main.previewStorageCleanup('everything'), /Choose a cleanup/)
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, [preview.items.find(item => item.title === 'A').id]), { cleaned: 1, skipped: 0, failed: 0 })
  assert.equal(fs.existsSync(b.run), true)
  preview = await f.main.previewStorageCleanup('published')
  f.main.settings.replaceApiKey('zernioApiKey', 'other-workspace')
  await assert.rejects(f.main.cleanStoredContent(preview.token, selected(preview)), /changed/)
  f.main.settings.replaceApiKey('zernioApiKey', 'test-key')
  const now = Date.now
  try { Date.now = () => now() + 16 * 60_000; await assert.rejects(f.main.cleanStoredContent(preview.token, selected(preview)), /expired/) } finally { Date.now = now }
  assert.equal(fs.existsSync(b.run), true)
})

test('source estimates exclude hard-linked bytes that remain outside the project', async t => {
  const f = fixture(); t.after(f.cleanup)
  const run = f.run('Linked source', { editor: true })
  const outside = path.join(f.dir, 'original.mp4')
  fs.linkSync(path.join(run.run, 'editor-source.mp4'), outside)
  const summary = await f.main.sourceStorageSummary()
  assert.equal(summary.sourceBytes, 2000)
  assert.equal(summary.readyBytes, 500)
  const preview = await f.main.previewStorageCleanup('sources')
  assert.equal(preview.items[0].bytes, 500)
  await f.main.cleanStoredContent(preview.token, selected(preview))
  assert.equal(fs.statSync(outside).size, 2000)
})

test('symlinked projects and media cannot expose files outside the Library', { skip: !directoryLinkType || !fileLinksAvailable }, async t => {
  const f = fixture(); t.after(f.cleanup)
  const outside = storageRun(f.dir, 'Outside', { posted: [0, 1], editor: true })
  fs.symlinkSync(outside.run, path.join(f.library, 'Alias'), directoryLinkType)
  const unsafe = f.run('Linked media', { editor: true })
  fs.unlinkSync(path.join(unsafe.run, 'editor-source.mp4'))
  fs.symlinkSync(path.join(outside.run, 'editor-source.mp4'), path.join(unsafe.run, 'editor-source.mp4'), 'file')
  const preview = await f.main.previewStorageCleanup('sources')
  assert.equal(preview.items.length, 0)
  assert.ok(preview.unavailableProjects > 0)
  assert.equal(fs.existsSync(path.join(outside.run, 'editor-source.mp4')), true)
})

test('a stale source-free request does not sweep old or partial media before rejecting', async t => {
  const f = fixture(); t.after(f.cleanup)
  const run = f.run('Stale', { editor: true })
  const leftover = path.join(run.run, 'editor-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4')
  fs.writeFileSync(leftover, 'keep')
  await assert.rejects(f.main.editor.freeEditorMedia(run.run, 99), /project changed/)
  assert.equal(fs.existsSync(leftover), true)
  assert.equal(readProject(run.run).media_freed, undefined)
})

test('a posting mark changed during preview cannot become a deletion target', async t => {
  const f = fixture({ './library-posting': { publishedCleanupClips: async runs => {
    fs.unlinkSync(path.join(runs[0], '.bridgeclip-posted-0'))
    return new Map([[runs[0], [0, 1]]])
  } } }); t.after(f.cleanup)
  const run = f.run('Changed during preview', { posted: [0, 1] })
  const preview = await f.main.previewStorageCleanup('published')
  assert.equal(preview.items.length, 0)
  assert.equal(preview.unavailableProjects, 1)
  assert.equal(fs.existsSync(run.clips[0].s3_url), true)
})

test('deferred file removal reports failure and continues cleaning other selected projects', async t => {
  let blocked = false
  const f = fixture({ fs: { ...fs, rmSync: (target, options) => {
    if (!blocked && path.basename(target).startsWith('.deleting-')) {
      blocked = true
      throw Object.assign(new Error('File in use'), { code: 'EBUSY' })
    }
    return fs.rmSync(target, options)
  } } }); t.after(f.cleanup)
  f.run('First published', { posted: [0, 1] })
  f.run('Second published', { posted: [0, 1] })
  const preview = await f.main.previewStorageCleanup('published')
  assert.deepEqual(await f.main.cleanStoredContent(preview.token, selected(preview)), { cleaned: 1, skipped: 0, failed: 1 })
  assert.equal(fs.readdirSync(f.library).filter(name => name.startsWith('.deleting-')).length, 1)
})
