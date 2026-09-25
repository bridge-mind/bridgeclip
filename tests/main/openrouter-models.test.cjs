const assert = require('node:assert/strict')
const { test } = require('node:test')
const { buildSync } = require('esbuild')
const path = require('node:path')

const bundled = buildSync({
  stdin: { contents: `export * from './src/main/openrouter-models'; export * from './src/shared/openrouter-models';`,
    resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

function load(fetch = () => { throw new Error('Unexpected network request') }) {
  const module = { exports: {} }
  new Function('module', 'exports', 'require', 'fetch', bundled)(module, module.exports, require, fetch)
  return module.exports
}

const planner = (id = 'provider/planner', overrides = {}) => ({
  id, name: 'Provider: Clever Planner', context_length: 128000,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['structured_outputs', 'response_format'], top_provider: { max_completion_tokens: 8192 },
  pricing: { prompt: '0.000001', completion: '0.000004' }, ...overrides
})
const transcriber = (id = 'provider/transcriber') => ({
  id, name: 'Provider: Speech', architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
  supported_parameters: [], pricing: { prompt: '0.1', completion: '0' }
})

test('catalog separates tasks, rejects malformed IDs, and retains capability and price information', () => {
  const api = load()
  const data = [planner(), transcriber(), planner('https://evil.test/model'), planner('../model'), planner('bad/model\n'), null]
  const result = api.parseModelCatalog({ data }, 'planning')
  assert.equal(result.length, 1)
  assert.equal(result[0].maxOutputTokens, 8192)
  assert.equal(result[0].inputPrice, 0.000001)
  assert.equal(result[0].supportsImages, true)
  const stt = api.parseModelCatalog({ data }, 'transcription')
  assert.equal(stt.length, 1)
  assert.equal(stt[0].inputPrice, null, 'transcription price units must not be guessed')
  for (const id of ['provider/model:free', '~provider/latest', 'vendor/model-2026.09']) assert.equal(api.isModelId(id), true)
  for (const id of ['', 'provider', 'provider/a,b/c', 'p/' + 'x'.repeat(120), 'p/m?key=secret']) assert.equal(api.isModelId(id), false)
})

test('incompatible models remain searchable with an explanation and cannot start an advanced run', async () => {
  const api = load(async (url) => Response.json({ data: url.endsWith('text')
    ? [planner(), planner('provider/plain', { supported_parameters: [] })]
    : [transcriber(), transcriber('openai/gpt-4o-transcribe')] }))
  const catalog = await api.getModelCatalog()
  assert.match(catalog.planning[1].unavailableReason, /structured output/)
  assert.match(catalog.transcription[1].unavailableReason, /timestamp/)
  await assert.rejects(api.resolveAdvancedModels('provider/plain', 'provider/transcriber'), /structured output/)
  await assert.rejects(api.resolveAdvancedModels('provider/planner', 'openai/gpt-4o-transcribe'), /timestamp/)
  await assert.rejects(api.resolveAdvancedModels('missing/model', 'provider/transcriber'), /no longer listed/)
  assert.equal((await api.resolveAdvancedModels('provider/planner', 'provider/transcriber')).id, 'provider/planner')
})

test('search matches provider, name and ID with multiple words', () => {
  const api = load()
  const models = api.parseModelCatalog({ data: [planner(), planner('other/second', { name: 'Another choice' })] }, 'planning')
  assert.equal(api.searchModels(models, ' PROVIDER clever ')[0].id, 'provider/planner')
  assert.equal(api.searchModels(models, 'second').length, 1)
  assert.equal(api.searchModels(models, 'does not exist').length, 0)
})

test('public catalog requests are bounded, redirect-free, cached, and shared while in flight', async () => {
  const calls = []
  const api = load(async (url, options) => {
    calls.push({ url, options })
    return Response.json({ data: url.endsWith('text') ? [planner()] : [transcriber()] })
  })
  const [first, second] = await Promise.all([api.getModelCatalog(), api.getModelCatalog()])
  assert.equal(first, second)
  assert.equal(calls.length, 2)
  await api.getModelCatalog()
  assert.equal(calls.length, 2)
  await api.getModelCatalog(true)
  assert.equal(calls.length, 4)
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://openrouter.ai')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(Object.keys(options.headers).some((key) => key.toLowerCase() === 'authorization'), false)
  }
  await assert.rejects(api.getModelCatalog('https://private.test'), /Invalid model refresh/)
})

test('catalog failures are safe, retryable, and never replace a good cache', async () => {
  let fail = true
  const api = load(async (url) => fail ? new Response('private-provider-secret', { status: 500 })
    : Response.json({ data: url.endsWith('text') ? [planner()] : [transcriber()] }))
  await assert.rejects(api.getModelCatalog(), (error) => /refresh/.test(error.message) && !error.message.includes('private-provider-secret'))
  fail = false
  const good = await api.getModelCatalog()
  fail = true
  await assert.rejects(api.getModelCatalog(true))
  assert.equal(await api.getModelCatalog(), good)
})

test('invalid and oversized catalog responses cannot be buffered or selected', async () => {
  for (const body of ['not json', JSON.stringify({ data: [] }), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    const api = load(async () => new Response(body))
    await assert.rejects(api.getModelCatalog(), /Could not load OpenRouter models/)
  }
})
