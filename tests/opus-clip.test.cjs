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
const { comparisonDurationSeconds, opusClipCredits, opusClipCostUsd, percentLessThanOpusClip, timesFasterThanOpusClip, formatTimes } = mod.exports

test('comparisons use the analyzed window and omit unknown or invalid durations', () => {
  assert.equal(comparisonDurationSeconds(3600, 120), 120)
  assert.equal(percentLessThanOpusClip(0.2, comparisonDurationSeconds(3600, 120)), null)
  for (const duration of [undefined, null, 0, -1, 3601, Infinity, NaN, '120']) {
    assert.equal(comparisonDurationSeconds(3600, duration), null)
  }
})

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

test('speed is measured against the low end of OpusClip’s stated 20–40 minutes', () => {
  assert.equal(formatTimes(timesFasterThanOpusClip(238)), '5×', '20 min / 3m 58s, rounded down')
  assert.equal(formatTimes(timesFasterThanOpusClip(60)), '20×')
  assert.equal(formatTimes(timesFasterThanOpusClip(420)), '2.8×')
  assert.equal(formatTimes(10.9), '10×', 'never round a comparison upward')
  assert.equal(timesFasterThanOpusClip(19 * 60), null, 'no claim when not clearly faster')
  assert.equal(timesFasterThanOpusClip(0), null)
})
