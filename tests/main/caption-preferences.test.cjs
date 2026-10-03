const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

function fixture(t) {
  const { dir, cleanup } = tempDir('bridgeclip-caption-preferences-')
  t.after(cleanup)
  const { electron } = fakeElectron(dir)
  const load = () => loadMain(`
    export * from './src/main/caption-preferences'
    export * from './src/main/caption-library'
    export { defaultCaptionStyle } from './src/shared/custom-captions'
  `, { electron })
  return { load, file: path.join(dir, 'userData', 'caption-preferences.json') }
}

test('caption preferences migrate bookmarks once and preserve defaults across reloads and bookmark updates', t => {
  const { load } = fixture(t), mod = load()
  assert.deepEqual(mod.loadCaptionPreferences(), { defaultId: null, favorites: [] })
  mod.loadCaptionPreferences(['paper', 'paper', 'custom-studio'])
  assert.deepEqual(load().loadCaptionPreferences(['glow']), { defaultId: null, favorites: ['paper', 'custom-studio'] })
  mod.saveCaptionPreferences({ defaultId: 'neon' })
  mod.saveCaptionPreferences({ favorites: ['glow'] })
  assert.deepEqual(load().loadCaptionPreferences(), { defaultId: 'neon', favorites: ['glow'] })
  const preset = { id: 'custom-studio', name: 'Studio', baseId: 'pop', style: mod.defaultCaptionStyle('pop') }
  mod.saveCaptionStyle(preset)
  mod.saveCaptionPreferences({ defaultId: preset.id })
  mod.saveCaptionStyle({ ...preset, name: 'Studio renamed' })
  assert.equal(load().loadCaptionPreferences().defaultId, preset.id)
  mod.deleteCaptionStyle(preset.id)
  assert.deepEqual(load().loadCaptionPreferences(), { defaultId: null, favorites: ['glow'] })
})

test('retired built-in defaults and bookmarks do not prevent loading the remaining preferences', t => {
  const { load, file } = fixture(t), mod = load()
  mod.loadCaptionPreferences([])
  fs.writeFileSync(file, JSON.stringify({ defaultId: 'retired-style', favorites: ['retired-style', 'neon'] }))
  assert.deepEqual(mod.loadCaptionPreferences(), { defaultId: null, favorites: ['neon'] })
})

test('caption preferences validate IPC input and preserve damaged files instead of silently resetting', t => {
  const { load, file } = fixture(t), mod = load()
  mod.loadCaptionPreferences([])
  for (const patch of [null, [], { unknown: true }, { defaultId: '' }, { defaultId: 'custom-missing' }, { defaultId: '../secret' }, { favorites: 'pop' }, { favorites: Array(257).fill('pop') }, { favorites: ['../secret'] }]) {
    assert.throws(() => mod.saveCaptionPreferences(patch), /Invalid caption preferences|no longer available/)
    assert.deepEqual(mod.loadCaptionPreferences(), { defaultId: null, favorites: [] })
  }
  fs.writeFileSync(file, '{broken')
  assert.throws(() => mod.loadCaptionPreferences(['glow']), /kept for recovery/)
  assert.throws(() => mod.saveCaptionPreferences({ defaultId: 'neon' }), /kept for recovery/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})
