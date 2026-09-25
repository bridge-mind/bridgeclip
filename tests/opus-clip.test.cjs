const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/renderer/config/opus-clip.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const mod = { exports: {} }
new Function('module', 'exports', bundle)(mod, mod.exports)
const { opusClipCredits, opusClipCostUsd, percentLessThanOpusClip, timesFasterThanOpusClip, formatTimes } = mod.exports

test('OpusClip charges a credit per whole minute of source, at least one', () => {
  assert.equal(opusClipCredits(0), 1)
  assert.equal(opusClipCredits(59), 1)
  assert.equal(opusClipCredits(270), 4, '4.5 minutes round down to 4 credits')
  assert.equal(opusClipCredits(22 * 60 + 53), 22)
})

test('cost is credits at the Pro list price, and the saving is a whole percent', () => {
  assert.equal(opusClipCostUsd(22 * 60 + 53).toFixed(2), '2.13', '22 × $29/300')
  assert.equal(opusClipCostUsd(0), null)
  assert.equal(percentLessThanOpusClip(0.12, 22 * 60 + 53), 94)
  assert.equal(percentLessThanOpusClip(2.13, 22 * 60 + 53), null, 'no claim when BridgeClip costs as much or more')
  assert.equal(percentLessThanOpusClip(5, 22 * 60), null)
  assert.equal(percentLessThanOpusClip(Number.NaN, 22 * 60), null)
})

test('speed is measured against the low end of OpusClip’s stated 20–40 minutes, for sources at least that long', () => {
  const longSource = 22 * 60 + 53
  assert.equal(formatTimes(timesFasterThanOpusClip(238, longSource)), '5×', '20 min / 3m 58s, rounded down')
  assert.equal(formatTimes(timesFasterThanOpusClip(420, longSource)), '2.8×')
  assert.equal(formatTimes(timesFasterThanOpusClip(113, longSource)), '10×', '10.6× rounds down, not up')
  assert.equal(timesFasterThanOpusClip(19 * 60, longSource), null, 'no claim when not clearly faster')
  assert.equal(timesFasterThanOpusClip(0, longSource), null)
  assert.equal(timesFasterThanOpusClip(60, 60), null, 'a 1-minute source is not held to OpusClip’s 20 minutes')
  assert.equal(timesFasterThanOpusClip(60, 19 * 60), null)
  assert.equal(formatTimes(timesFasterThanOpusClip(60, 20 * 60)), '20×')
})
