const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('../zernio/support/load-main.cjs')
const fixture = require('../fixtures/editor/project.json')
const schema = loadMain("export * from './src/shared/clip-editor'; export * from './src/renderer/lib/caption-preview'")

test('caption position is validated, saved in render edits and reset without changing review evidence', () => {
  const old = schema.parseEditorProject(structuredClone(fixture)).candidates[0]
  assert.equal(old.caption_y, null)
  for (const y of [NaN, Infinity, -.1, .09, .91, true, '0.5', {}]) {
    assert.throws(() => schema.parseCandidateEdit({ ...old, caption_y: y }, fixture.duration_ms))
  }
  const ready = { ...old, status: 'ready' }
  const placed = schema.refineEdit(ready, { caption_y: .25 })
  assert.equal(placed.status, 'refining')
  assert.equal(schema.candidateEdit(placed).caption_y, .25)
  assert.equal(schema.editSignature(placed), schema.editSignature(ready))
  assert.notEqual(schema.renderEditKey(placed), schema.renderEditKey(ready))
  const reset = schema.parseCandidateEdit(schema.candidateEdit({ ...placed, caption_y: null }), fixture.duration_ms)
  assert.equal(reset.caption_y, null)
})

test('automatic caption anchors follow portrait layouts and landscape; manual placement overrides them', () => {
  const project = schema.parseEditorProject(structuredClone(fixture)), c = project.candidates[0]
  c.scenes = [{ at_ms: 0, layout: 'fill', crops: [[0, 0, 1, 1]] }]
  assert.deepEqual(schema.captionAnchor(project, c, 2000), { y: 1340 / 1920, bottom: false })
  c.scenes[0].layout = 'split'
  assert.deepEqual(schema.captionAnchor(project, c, 2000), { y: .5, bottom: false })
  c.scenes[0].layout = 'fit'
  assert.equal(schema.captionAnchor(project, c, 2000).bottom, true)
  project.aspect_ratio = '16:9'
  assert.deepEqual(schema.captionAnchor(project, c, 2000), { y: 1 - 100 / 1080, bottom: true })
  c.caption_y = .2
  assert.deepEqual(schema.captionAnchor(project, c, 2000), { y: .2, bottom: false })
})


test('caption highlight switches instantly unless the export uses a color fade', () => {
  assert.equal(schema.captionColorProgress(0, 300, false), 1)
  assert.equal(schema.captionColorProgress(0, 149, true), 1)
  assert.equal(schema.captionColorProgress(0, 150, true), 0)
  assert.equal(schema.captionColorProgress(45, 300, true), .5)
  assert.equal(schema.captionColorProgress(90, 300, true), 1)
  assert.equal(schema.captionColorProgress(400, 300, true), 1)
})
