'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { loadMain, tempDir, fakeElectron, ROOT } = require('../zernio/support/load-main.cjs')
const { fileLinksAvailable } = require('../support/symlinks.cjs')
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin/ffmpeg')) ? path.join(ROOT, 'engine-bin/ffmpeg') : 'ffmpeg'

async function server(handler) {
  const instance = http.createServer(handler)
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections() }) }
}
function main(dir) {
  const api = loadMain("export * from './src/main/automation-metadata'; export * as settings from './src/main/settings-store'", { electron: fakeElectron(dir).electron })
  api.settings.replaceApiKey('openrouterApiKey', 'dummy-openrouter-key')
  return api
}
function clip(file) {
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=0.3', '-f', 'lavfi', '-i', 'sine=duration=0.3', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', file])
}

test('a playlist disguised as video cannot read sibling media or generate a thumbnail', async () => {
  const { dir, cleanup } = tempDir()
  const oldFetch = global.fetch
  let requests = 0
  global.fetch = async () => { requests++; return Response.json({ text: 'private recording' }) }
  try {
    clip(path.join(dir, 'private.mp4'))
    const disguised = path.join(dir, 'playlist.mp4')
    fs.writeFileSync(disguised, "ffconcat version 1.0\nfile 'private.mp4'\n")
    await assert.rejects(main(dir).transcribeAutomationClip(disguised), /could not be transcribed/)
    const { generateThumbnail } = loadMain("export { generateThumbnail } from './src/main/file-manager'", { electron: fakeElectron(dir).electron })
    assert.equal(await generateThumbnail(disguised), null)
    assert.equal(requests, 0)
  } finally { global.fetch = oldFetch; cleanup() }
})

test('provider redirects cannot forward audio, custom API keys, or transcripts', async () => {
  const { dir, cleanup } = tempDir()
  let leaked = 0
  const sink = await server((req, res) => { leaked++; req.resume(); res.end('{}') })
  const redirect = await server((req, res) => { req.resume(); res.writeHead(307, { Location: `${sink.url}/capture` }); res.end() })
  const names = ['BRIDGECLIP_E2E_TRANSCRIPTION_URL', 'BRIDGECLIP_E2E_OPENROUTER_URL']
  const previous = names.map((name) => process.env[name])
  try {
    for (const name of names) process.env[name] = redirect.url
    const api = main(dir)
    const file = path.join(dir, 'valid.mp4'); clip(file)
    await assert.rejects(api.transcribeAutomationClip(file), /could not be transcribed/)
    await assert.rejects(api.generateAutomationMetadata('private transcript', '', '', ['instagram']), /could not be reached/)
    assert.equal(leaked, 0)
  } finally {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i] })
    await redirect.close(); await sink.close(); cleanup()
  }
})

test('oversized provider streams are cancelled before the full body is buffered', async () => {
  const { dir, cleanup } = tempDir()
  const oldFetch = global.fetch
  let cancelled = false
  let pulled = 0
  global.fetch = async () => new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(60_000)) },
    cancel() { cancelled = true }
  }))
  try {
    await assert.rejects(main(dir).generateAutomationMetadata('text', '', '', ['instagram']), /too much metadata/)
    assert.equal(cancelled, true)
    assert.ok(pulled <= 3)
  } finally { global.fetch = oldFetch; cleanup() }
})

test('a bad OpenRouter request is not reported as a credit failure', async () => {
  const { dir, cleanup } = tempDir()
  const oldFetch = global.fetch
  try {
    const file = path.join(dir, 'valid.mp4'); clip(file)
    global.fetch = async () => new Response('{}', { status: 400 })
    await assert.rejects(main(dir).transcribeAutomationClip(file), (error) => {
      assert.match(error.message, /transcription request \(400\)/)
      assert.doesNotMatch(error.message, /credits|key/i)
      return true
    })
    await assert.rejects(main(dir).generateAutomationMetadata('Transcript', '', '', ['instagram']), (error) => {
      assert.match(error.message, /metadata request \(400\)/)
      assert.doesNotMatch(error.message, /credits|key/i)
      return true
    })
  } finally { global.fetch = oldFetch; cleanup() }
})

test('post cache writes do not follow predictable temporary-file symlinks', { skip: !fileLinksAvailable }, () => {
  const { dir, cleanup } = tempDir()
  try {
    const { PostsStore } = loadMain("export { PostsStore } from './src/main/zernio/posts-store'", { electron: fakeElectron(dir).electron })
    const cache = path.join(dir, 'posts.json')
    const victim = path.join(dir, 'unrelated.txt')
    fs.writeFileSync(victim, 'keep me')
    fs.symlinkSync(victim, `${cache}.tmp`)
    new PostsStore(cache).save()
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me')
  } finally { cleanup() }
})

test('packaged tools never fall back to PATH or a user-selected Python', () => {
  const { dir, cleanup } = tempDir()
  const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true })
  try {
    const api = loadMain("export { resolveBinary } from './src/main/tools'; export { resolvePythonPath, preflightCheck } from './src/main/pipeline-runner'", { electron: fakeElectron(dir, { isPackaged: true }).electron })
    for (const name of ['ffmpeg', 'ffprobe', 'yt-dlp']) {
      assert.equal(api.resolveBinary(name), path.join(dir, 'engine-bin', name + (process.platform === 'win32' ? '.exe' : '')))
    }
    assert.equal(api.resolvePythonPath(dir, '/untrusted/python'), path.join(dir, 'engine-venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'])))
    const check = api.preflightCheck({ pythonPath: '/untrusted/python', bridgePath: dir, enginePath: dir })
    assert.equal(check.ok, false)
    assert.match(check.error, /Bundled ffmpeg is missing/)
  } finally {
    if (previous) Object.defineProperty(process, 'resourcesPath', previous)
    else delete process.resourcesPath
    cleanup()
  }
})
