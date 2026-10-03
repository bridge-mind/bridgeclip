const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('../zernio/support/load-main.cjs')

const KEY = 'bridgeclip.caption-lab-draft'
const load = () => loadMain("export * from './src/renderer/lib/caption-lab-draft'; export { defaultCaptionStyle } from './src/shared/custom-captions'")

function storageFor(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) }
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  return storage
}

function draft(api) {
  return { id: 'custom-unsaved', name: 'Studio draft', baseId: 'pop', style: {
    ...api.defaultCaptionStyle('pop'), font_size: 76, max_words_per_line: 5, max_lines: 2,
    primary_color: '#FFFFFF', highlight_color: '#000000', outline_color: '#000000', highlight_box_color: '#FFFF00'
  } }
}

test('unfinished caption settings recover across module reloads and clear after completion', t => {
  const storage = storageFor(t), api = load(), original = draft(api)
  assert.equal(api.readCaptionLabDraft(), null)
  api.writeCaptionLabDraft(original)
  const recovered = load().readCaptionLabDraft()
  assert.deepEqual(recovered, original)
  recovered.style.font_size = 160
  assert.equal(load().readCaptionLabDraft().style.font_size, 76, 'the stored snapshot is independent of later edits')
  load().writeCaptionLabDraft(null)
  assert.equal(storage.getItem(KEY), null)
  assert.equal(load().readCaptionLabDraft(), null)
})

test('recovery preserves a temporarily empty name and migrates legacy automatic lines', t => {
  const storage = storageFor(t), api = load(), unfinished = { ...draft(api), name: '' }
  api.writeCaptionLabDraft(unfinished)
  assert.deepEqual(load().readCaptionLabDraft(), unfinished)
  const legacy = draft(api)
  delete legacy.style.max_lines
  storage.setItem(KEY, JSON.stringify(legacy))
  assert.deepEqual(load().readCaptionLabDraft(), { ...legacy, style: { ...legacy.style, max_lines: null } })
})

test('missing, malformed and invalid stored drafts cannot break the lab', t => {
  const storage = storageFor(t), api = load(), original = draft(api)
  for (const raw of ['', '{broken', 'null', '[]', '{}', JSON.stringify({ ...original, name: null }),
    JSON.stringify({ ...original, style: { ...original.style, font_size: 500 } }),
    JSON.stringify({ ...original, style: { ...original.style, max_lines: 9 } })]) {
    storage.setItem(KEY, raw)
    assert.equal(api.readCaptionLabDraft(), null)
    assert.equal(storage.getItem(KEY), raw, 'failed recovery leaves storage untouched')
  }
})

test('unavailable browser storage leaves in-memory editing usable', t => {
  const storage = storageFor(t), api = load()
  for (const method of ['getItem', 'setItem', 'removeItem']) storage[method] = () => { throw new Error('Storage unavailable') }
  assert.equal(api.readCaptionLabDraft(), null)
  assert.doesNotThrow(() => api.writeCaptionLabDraft(draft(api)))
  assert.doesNotThrow(() => api.writeCaptionLabDraft(null))
})

test('caption store restores its edit view and synchronously persists only unfinished edits', t => {
  const storage = storageFor(t), api = load()
  const original = { ...draft(api), baseId: 'spotlight' }
  api.writeCaptionLabDraft(original)
  const { useCaptionStore: store } = loadMain("export { useCaptionStore } from './src/renderer/store/use-caption-store'")
  assert.deepEqual(store.getState().editing, original)
  assert.equal(store.getState().view, 'edit')
  assert.equal(store.getState().selectedBaseId, 'spotlight')

  const changed = { ...original, style: { ...original.style, font_size: 92 } }
  store.setState({ editing: changed, view: 'base' })
  assert.deepEqual(api.readCaptionLabDraft(), changed, 'edits persist immediately without a mounted lab page')
  store.setState({ editing: null, view: 'home' })
  assert.equal(storage.getItem(KEY), null, 'leaving or discarding an edit clears recovery immediately')

  store.setState({ styles: [structuredClone(original)], editing: original, view: 'edit' })
  assert.equal(storage.getItem(KEY), null, 'viewing an unchanged saved preset does not create a recovery draft')
  store.setState({ editing: changed })
  assert.deepEqual(api.readCaptionLabDraft(), changed)
  store.setState({ styles: [structuredClone(changed)] })
  assert.equal(storage.getItem(KEY), null, 'a successful library save clears the matching recovery draft')
})
