const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
function fixture(t) {
  const temp = tempDir('bridgeclip-crash-'); t.after(temp.cleanup)
  const { electron } = fakeElectron(temp.dir)
  electron.app.getVersion = () => '0.1.19'
  let copied = ''
  electron.clipboard = { writeText: text => { copied = text } }
  const load = () => loadMain("export * from './src/main/crash-reports'; export { logger, getLogFilePath } from './src/main/logger'", { electron })
  return { load, file: name => path.join(electron.app.getPath('userData'), name), copied: () => copied }
}
test('crash issue reports persist useful diagnostics and exclude private error text and context', t => {
  const f = fixture(t), api = f.load()
  api.startCrashSession()
  const secret = 'sk-test-private-credential'
  api.logger.info('job.start', { jobId: secret, source: '/Users/private/video.mp4', token: secret })
  const error = { name: 'TypeError', code: 'ENOSPC', stack: `TypeError: ${secret}\n    at ${secret} (/Users/private/app/out/main/index.js:42:13)` }
  api.recordCrash('main-error', error)
  const report = f.load().getCrashReport()
  assert.match(report.markdown, /TypeError · ENOSPC · main.index.js:42/)
  assert.match(report.markdown, /BridgeClip: 0.1.19/)
  assert.match(report.markdown, /info job.start/)
  assert.doesNotMatch(JSON.stringify(report), /sk-test|Users|private|video.mp4/)
  assert.equal(api.copyCrashReport(), true)
  assert.equal(f.copied(), report.markdown)
  assert.equal(api.copyCrashReport('2000-01-01T00:00:00.000Z'), false, 'do not copy a newer report than the user reviewed')
  assert.equal(api.copyCrashReport(report.recordedAt), true)
  api.endCrashSession()
  const next = f.load(); next.startCrashSession()
  assert.equal(next.getCrashReport().recordedAt, report.recordedAt, 'clean restarts preserve the last error report')
})
test('unclean sessions are detected without claiming that forced quits were crashes', t => {
  const f = fixture(t), first = f.load()
  first.startCrashSession()
  assert.equal(first.getCrashReport(), null)
  const second = f.load(); second.startCrashSession()
  assert.equal(second.getCrashReport().label, 'Unexpected shutdown')
  assert.match(second.getCrashReport().markdown, /forced quit or power loss/)
  second.endCrashSession()
  fs.unlinkSync(f.file('crash-report.json'))
  const third = f.load(); third.startCrashSession()
  assert.equal(third.getCrashReport(), null)
  assert.equal(third.copyCrashReport(), false)
})
test('a recorded process crash survives relaunch with its original reason and exit code', t => {
  const f = fixture(t), api = f.load(); api.startCrashSession()
  api.recordCrash('renderer-crash', undefined, { reason: 'oom', exitCode: 137 })
  const next = f.load(); next.startCrashSession()
  assert.equal(next.getCrashReport().label, 'Interface crash')
  assert.match(next.getCrashReport().markdown, /oom · Exit code: 137/)
})
test('stored report fields and log event names are allowlisted again before copying', t => {
  const f = fixture(t), api = f.load(); api.startCrashSession()
  api.recordCrash('renderer-error', { name: 'RangeError', stack: 'Error\n    at secret (/app/out/renderer/assets/index-secret.js:15:21)' })
  assert.match(api.getCrashReport().markdown, /renderer.js:15:21/)
  const file = f.file('crash-report.json'), raw = JSON.parse(fs.readFileSync(file))
  Object.assign(raw, { name: 'SECRET', code: 'SECRET', frame: 'SECRET:123', reason: 'SECRET', exitCode: 'SECRET', events: ['2026-10-02T10:00:00.000Z error SECRET'] })
  raw.environment = { app: 'SECRET', os: 'SECRET', arch: 'SECRET' }
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.doesNotMatch(api.getCrashReport().markdown, /SECRET/)
  fs.writeFileSync(file, 'broken JSON')
  assert.equal(api.getCrashReport(), null)
  fs.writeFileSync(file, 'x'.repeat(40_000))
  assert.equal(api.getCrashReport(), null)
})
