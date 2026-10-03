'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const path = require('node:path')
const { loadMain, tempDir } = require('../zernio/support/load-main.cjs')
const { directoryLinkType, fileLinksAvailable } = require('../support/symlinks.cjs')
const source = "export * from './src/main/output-storage'"
const { scanOutputStorage: measureOutputStorage } = loadMain(source)

test('storage totals include nested and hidden files, and reflect added/deleted files', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  fs.mkdirSync(path.join(temp.dir, 'run', '.editor'), { recursive: true })
  fs.writeFileSync(path.join(temp.dir, 'run', '.editor', 'source.mp4'), Buffer.alloc(1234))
  fs.writeFileSync(path.join(temp.dir, '.metadata'), Buffer.alloc(56))
  fs.writeFileSync(path.join(temp.dir, 'empty'), '')
  assert.deepEqual(await measureOutputStorage(temp.dir), { outputDirectory: temp.dir, bytes: 1290, fileCount: 3, exists: true, unreadableCount: 0 })
  fs.unlinkSync(path.join(temp.dir, '.metadata'))
  fs.writeFileSync(path.join(temp.dir, 'clip.mp4'), Buffer.alloc(1000))
  assert.equal((await measureOutputStorage(temp.dir)).bytes, 2234)
})

test('empty and missing output folders report zero without creating a directory', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  assert.equal((await measureOutputStorage(temp.dir)).bytes, 0)
  const missing = path.join(temp.dir, 'missing')
  assert.deepEqual(await measureOutputStorage(missing), { outputDirectory: missing, bytes: 0, fileCount: 0, exists: false, unreadableCount: 0 })
  assert.equal(fs.existsSync(missing), false)
})

test('links inside the output folder are excluded, including loops; a linked output root works', { skip: !directoryLinkType }, async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  const output = path.join(temp.dir, 'output')
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'clip'), '123')
  fs.mkdirSync(path.join(temp.dir, 'external'))
  fs.writeFileSync(path.join(temp.dir, 'external', 'video'), '123456789')
  fs.symlinkSync(path.join(temp.dir, 'external'), path.join(output, 'external'), directoryLinkType)
  fs.symlinkSync(output, path.join(output, 'loop'), directoryLinkType)
  fs.symlinkSync(output, path.join(temp.dir, 'alias'), directoryLinkType)
  if (fileLinksAvailable) fs.symlinkSync(path.join(output, 'clip'), path.join(output, 'file-link'), 'file')
  const result = await measureOutputStorage(path.join(temp.dir, 'alias'))
  assert.equal(result.bytes, 3)
  assert.equal(result.fileCount, 1)
  assert.equal(result.unreadableCount, 0)
})

test('unreadable entries mark totals as partial and files removed during scanning are skipped', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  fs.mkdirSync(path.join(temp.dir, 'blocked'))
  for (const name of ['readable', 'denied', 'removed']) fs.writeFileSync(path.join(temp.dir, name), '1234')
  const scanner = loadMain(source, { 'fs/promises': {
    ...promises,
    readdir: async (dir) => {
      if (path.basename(dir) === 'blocked') throw Object.assign(new Error('Denied'), { code: 'EACCES' })
      return promises.readdir(dir)
    },
    lstat: async (file) => {
      const name = path.basename(file)
      if (['denied', 'removed'].includes(name)) throw Object.assign(new Error(name), { code: name === 'denied' ? 'EACCES' : 'ENOENT' })
      return promises.lstat(file)
    }
  } })
  assert.deepEqual(await scanner.scanOutputStorage(temp.dir), { outputDirectory: temp.dir, bytes: 4, fileCount: 1, exists: true, unreadableCount: 2 })
})

test('Settings requests share one walk, reuse a recent result, and Refresh counts again', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  fs.writeFileSync(path.join(temp.dir, 'clip.mp4'), Buffer.alloc(100))
  let walks = 0
  const storage = loadMain(source, { 'fs/promises': { ...promises, readdir: async (dir) => { if (dir === temp.dir) walks++; return promises.readdir(dir) } } })
  const [first, second] = await Promise.all([storage.measureOutputStorage(temp.dir), storage.measureOutputStorage(temp.dir)])
  assert.equal(walks, 1, 'concurrent requests share the walk in progress')
  assert.equal(first, second)
  fs.writeFileSync(path.join(temp.dir, 'new.mp4'), Buffer.alloc(50))
  assert.equal((await storage.measureOutputStorage(temp.dir)).bytes, 100, 'a recent result is reused')
  assert.equal(walks, 1)
  assert.equal((await storage.measureOutputStorage(temp.dir, { fresh: true })).bytes, 150, 'Refresh counts again')
  assert.equal(walks, 2)
  const other = path.join(temp.dir, 'other'); fs.mkdirSync(other)
  assert.equal((await storage.measureOutputStorage(other)).outputDirectory, other, 'a different folder is never served from the cache')
})

test('reclaimable estimates count internal hard links once and exclude links retained elsewhere', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  const run = path.join(temp.dir, 'run')
  fs.mkdirSync(run)
  fs.writeFileSync(path.join(run, 'clip.mp4'), Buffer.alloc(100))
  fs.linkSync(path.join(run, 'clip.mp4'), path.join(run, 'duplicate.mp4'))
  fs.writeFileSync(path.join(temp.dir, 'original.mp4'), Buffer.alloc(200))
  fs.linkSync(path.join(temp.dir, 'original.mp4'), path.join(run, 'source.mp4'))
  fs.writeFileSync(path.join(run, 'metadata'), Buffer.alloc(20))
  const estimate = await measureOutputStorage(run, undefined, { reclaimable: true })
  assert.equal(estimate.bytes, 120)
  assert.equal(estimate.fileCount, 4)
  assert.equal((await measureOutputStorage(run)).bytes, 420, 'Settings still reports logical file size')
})

test('a huge or deeply nested folder stops at the scan limits and reports a lower bound', async (t) => {
  const temp = tempDir()
  t.after(temp.cleanup)
  for (let index = 0; index < 20; index++) fs.writeFileSync(path.join(temp.dir, `file-${index}`), Buffer.alloc(10))
  const wide = await measureOutputStorage(temp.dir, { maxEntries: 5, maxDepth: 32 })
  assert.equal(wide.truncated, true)
  assert.ok(wide.fileCount <= 5 && wide.bytes <= 50)
  let deep = path.join(temp.dir, 'nested')
  for (let level = 0; level < 6; level++) { fs.mkdirSync(deep); fs.writeFileSync(path.join(deep, 'file'), Buffer.alloc(1)); deep = path.join(deep, 'more') }
  const shallow = await measureOutputStorage(temp.dir, { maxEntries: 1000, maxDepth: 2 })
  assert.equal(shallow.truncated, true)
  assert.equal(shallow.fileCount, 20 + 2, 'files below the depth limit are not counted')
  const full = await measureOutputStorage(temp.dir)
  assert.equal(full.truncated, undefined)
  assert.equal(full.fileCount, 26)
})
