const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('../zernio/support/load-main.cjs')

const KEY = 'bridgeclip.captions.favorites'
const load = (api = {}) => loadMain(`
  export { useCaptionFavoritesStore } from './src/renderer/store/use-caption-favorites-store'
  export { useCaptionStore } from './src/renderer/store/use-caption-store'
`, { '../lib/ipc': { getApi: () => api } })

function storageFor(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  return storage
}

test('default and custom bookmarks persist independently of caption edits and job snapshots', t => {
  storageFor(t)
  const { useCaptionFavoritesStore: favorites, useCaptionStore: captions } = load()
  const before = captions.getState()
  favorites.getState().toggle('paper')
  favorites.getState().toggle('custom-studio')
  assert.deepEqual(load().useCaptionFavoritesStore.getState().favorites, ['paper', 'custom-studio'])
  assert.equal(captions.getState(), before, 'bookmarking never modifies the edit or selected caption')
  favorites.getState().toggle('paper')
  assert.deepEqual(load().useCaptionFavoritesStore.getState().favorites, ['custom-studio'])
  assert.equal(favorites.getState().favorites.includes('custom-studio-copy'), false, 'a duplicate has its own preference')
})

test('invalid preferences are ignored and unavailable storage preserves session bookmarks', t => {
  const storage = storageFor(t)
  for (const value of ['{broken', 'null', '{}']) {
    storage.setItem(KEY, value)
    assert.deepEqual(load().useCaptionFavoritesStore.getState().favorites, [])
  }
  storage.setItem(KEY, JSON.stringify(['paper', 'paper', 'retired-default', 'custom-studio', 12, '../clip']))
  const store = load().useCaptionFavoritesStore
  assert.deepEqual(store.getState().favorites, ['paper', 'custom-studio'])
  store.getState().toggle('../clip')
  assert.deepEqual(store.getState().favorites, ['paper', 'custom-studio'])
  storage.setItem = () => { throw new Error('Unavailable') }
  assert.doesNotThrow(() => store.getState().toggle('pop'))
  assert.equal(store.getState().favorites.includes('pop'), true)
  storage.getItem = () => { throw new Error('Unavailable') }
  assert.deepEqual(load().useCaptionFavoritesStore.getState().favorites, [])
})

test('deleting a custom preset removes its bookmark only after deletion succeeds', async t => {
  storageFor(t)
  let failure = true
  const { useCaptionFavoritesStore: favorites, useCaptionStore: captions } = load({ captions: {
    delete: async () => { if (failure) throw new Error('Read only'); return [] }
  } })
  favorites.getState().toggle('custom-studio')
  favorites.getState().toggle('paper')
  await assert.rejects(captions.getState().remove('custom-studio'), /Read only/)
  assert.deepEqual(favorites.getState().favorites, ['custom-studio', 'paper'])
  failure = false
  await captions.getState().remove('custom-studio')
  assert.deepEqual(load().useCaptionFavoritesStore.getState().favorites, ['paper'])
})
