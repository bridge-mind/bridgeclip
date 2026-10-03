const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('../zernio/support/load-main.cjs')

const KEY = 'bridgeclip.captions.favorites'
const load = (api = {}) => loadMain(`
  export { useCaptionFavoritesStore } from './src/renderer/store/use-caption-favorites-store'
  export { useCaptionStore } from './src/renderer/store/use-caption-store'
  export { useDraftStore } from './src/renderer/store/use-draft-store'
  export { defaultCaptionStyle } from './src/shared/custom-captions'
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

test('new clip drafts default to the first available bookmark in picker order, falling back to Pop', t => {
  storageFor(t)
  const { useDraftStore: draft, defaultCaptionStyle } = load()
  const custom = { id: 'custom-studio', name: 'Studio', baseId: 'sweep', style: defaultCaptionStyle('sweep') }
  for (const [favorites, expected] of [
    [[], 'pop'], [['custom-deleted'], 'pop'], [['paper'], 'paper'],
    [['paper', 'custom-studio', 'glow'], 'glow'], [['custom-deleted', 'custom-studio'], 'custom-studio']
  ]) {
    draft.getState().startAnother()
    draft.getState().initializeCaption(favorites, [custom])
    const state = draft.getState()
    assert.equal(state.customCaption?.id ?? state.captionPreset, expected)
    if (expected === custom.id) {
      assert.deepEqual(state.customCaption, custom)
      assert.notEqual(state.customCaption.style, custom.style, 'the job owns a full, independent snapshot')
    } else assert.equal(state.customCaption, undefined, 'default styles clear any old custom snapshot')
  }
})

test('bookmark defaults apply once per video and never overwrite an explicit caption choice', t => {
  storageFor(t)
  const { useDraftStore: draft } = load()
  draft.getState().initializeCaption(['paper'], [])
  draft.getState().initializeCaption(['glow'], [])
  assert.equal(draft.getState().captionPreset, 'paper', 'bookmark changes do not change the active draft')
  draft.getState().startAnother()
  draft.getState().update({ captionPreset: 'pop', customCaption: undefined, includeCaptions: false })
  draft.getState().initializeCaption(['paper'], [])
  assert.equal(draft.getState().captionPreset, 'pop', 'explicitly choosing Pop is respected')
  draft.getState().startAnother()
  draft.getState().initializeCaption(['glow'], [])
  assert.equal(draft.getState().captionPreset, 'glow', 'the next video uses current bookmarks')
  assert.equal(draft.getState().includeCaptions, false, 'default selection does not enable captions')
})
