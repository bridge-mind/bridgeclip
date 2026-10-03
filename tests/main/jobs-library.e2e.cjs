const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const editorFixture = require('../fixtures/editor/project.json')

test('Jobs actions inspect runs and open completed jobs in the shared Library view', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-jobs-library-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'BridgeClip')
  const completedId = '11111111-1111-4111-8111-111111111111'
  const failedId = '22222222-2222-4222-8222-222222222222'
  const liveId = '33333333-3333-4333-8333-333333333333'
  const date = '2026-01-01T12:00:00.000Z'
  const writeRun = (id, title, status) => {
    const dir = path.join(library, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'run-history.json'), JSON.stringify({ jobId: id, sourceLabel: title, status,
      startedAt: date, finishedAt: status === 'running' ? null : date, errorMessage: status === 'failed' ? 'Test failure' : null }))
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ segments: [
      { start_time_ms: 0, end_time_ms: 2000, text: `Saved transcript for ${title}.`, words: [] }
    ] }))
    return dir
  }
  const output = (id, title) => ({ job_id: id, source_video_title: title, source_video_url: 'source.mp4',
    source_video_duration_seconds: 2, clips: [], total_clips: 0 })
  const completedDir = writeRun(completedId, 'Completed test run', 'completed')
  fs.writeFileSync(path.join(completedDir, 'job_output.json'), JSON.stringify(output(completedId, 'Completed test run')))
  const failedDir = writeRun(failedId, 'Failed test run', 'failed')
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  // Exercise the real folder IPC without opening Finder during the test.
  await app.evaluate(({ shell, BrowserWindow }) => {
    globalThis.jobsTestFolders = []
    shell.openPath = async file => { globalThis.jobsTestFolders.push(file); return '' }
    BrowserWindow.getAllWindows()[0].setSize(1300, 900)
  })
  const jobs = async () => {
    await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
    await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor()
  }
  const expectLibrary = async title => {
    await page.getByRole('heading', { name: title, exact: true }).waitFor()
    assert.equal(await page.locator('button[aria-current="page"]').getAttribute('aria-label'), 'Library')
    assert.equal(await page.getByRole('button', { name: 'All jobs', exact: true }).count(), 0)
  }
  await jobs()
  const completedActions = page.getByRole('button', { name: 'Actions for Completed test run', exact: true })
  await completedActions.waitFor()
  assert.equal(await page.getByRole('button', { name: 'Inspect transcript & edits', exact: true }).count(), 0)
  await completedActions.focus()
  await completedActions.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Actions for Completed test run', exact: true })
  await menu.waitFor()
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Open in Library', 'Open folder', 'Details'])
  assert.equal(await menu.getByRole('menuitem', { name: 'Open in Library' }).evaluate(el => el === document.activeElement), true)
  await menu.press('Escape')
  assert.equal(await completedActions.evaluate(el => el === document.activeElement), true)

  await completedActions.click()
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click()
  const inspector = page.getByRole('dialog', { name: 'Inspect transcript and edits' })
  await inspector.getByText('Saved transcript for Completed test run.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Close edit inspector' }).click()
  await completedActions.click()
  await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.jobsTestFolders), [fs.realpathSync(completedDir)])

  await completedActions.click()
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'jobs-actions.png') })
  }
  await page.getByRole('menuitem', { name: 'Open in Library', exact: true }).click()
  await expectLibrary('Completed test run')
  await jobs()
  await page.getByTitle('Open in Library', { exact: true }).click()
  await expectLibrary('Completed test run')

  // Old failed runs still expose their saved transcript, even without a live job.
  await jobs()
  const failedActions = page.getByRole('button', { name: 'Actions for Failed test run', exact: true })
  await failedActions.click()
  assert.equal(await page.getByRole('menuitem', { name: 'Open job', exact: true }).isDisabled(), true)
  await page.getByRole('menuitem', { name: 'Details', exact: true }).click()
  await inspector.getByText('Saved transcript for Failed test run.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Close edit inspector' }).click()

  // Real snapshot events cover session jobs and completion while watching progress.
  const publish = job => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('jobs:update', value), job)
  const snapshot = (id, status, outputDir) => ({ id, revision: 1, status, outputDir, output: null,
    request: { videoUrl: 'source.mp4' }, percent: 50, step: '', clipsDone: 0, clipsTotal: 0,
    error: status === 'failed' ? 'Test failure' : null, errorHint: null, queuedAt: date, startedAt: date, finishedAt: null })
  await publish(snapshot(failedId, 'failed', failedDir))
  await failedActions.click()
  await page.getByRole('menuitem', { name: 'Open job', exact: true }).click()
  await page.getByRole('button', { name: 'Run again', exact: true }).waitFor()
  assert.equal(await page.locator('button[aria-current="page"]').getAttribute('aria-label'), 'Jobs')
  await page.getByText('Test failure', { exact: true }).waitFor()
  const structuredError = JSON.stringify({ message: 'Provider temporarily unavailable', retryable: true })
  await publish({ ...snapshot(failedId, 'failed', failedDir), revision: 2, error: structuredError })
  const errorDetails = page.getByRole('region', { name: 'Engine error details', exact: true })
  await errorDetails.getByText('"Provider temporarily unavailable"', { exact: true }).waitFor()
  await errorDetails.getByRole('radio', { name: 'Original', exact: true }).click()
  assert.equal(await errorDetails.getByRole('textbox', { name: 'Original JSON' }).inputValue(), structuredError)
  await jobs()

  const liveDir = writeRun(liveId, 'Watched test run', 'running')
  const live = { ...snapshot(liveId, 'downloading', liveDir), startedAt: new Date(Date.now() - 7000).toISOString(), progressAt: Date.now(), stages: [
    { id: 'download', state: 'running', percent: 25, elapsed_ms: 2000, completed: 25000000, total: 100000000, unit: 'bytes' },
    { id: 'planning', state: 'pending', percent: null, elapsed_ms: 0 }
  ] }
  await publish(live)
  await page.getByRole('region', { name: 'Active jobs' }).getByRole('button').first().click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
  const download = page.getByRole('progressbar', { name: 'Download / read video progress' })
  await download.waitFor()
  assert.equal(await download.getAttribute('value'), '25')
  await page.getByText('25.0 MB of 100.0 MB', { exact: true }).waitFor()
  await publish({ ...live, revision: 2, stages: [{ ...live.stages[0], percent: 80 }] })
  await page.waitForFunction(() => document.querySelector('progress[aria-label="Download / read video progress"]')?.value === 80)
  await publish({ ...live, revision: 3, status: 'planning', stages: [
    { ...live.stages[0], state: 'completed', percent: 100, elapsed_ms: 5000 },
    { id: 'planning', state: 'running', percent: null, elapsed_ms: 1000 }
  ] })
  const planning = page.getByRole('progressbar', { name: 'Find moments progress' })
  await planning.waitFor()
  assert.equal(await planning.getAttribute('value'), null)
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'stage-progress.png') })
  const finishedOutput = { ...output(liveId, 'Watched test run'), metrics: { pipeline_stages: [
    { ...live.stages[0], state: 'completed', percent: 100, elapsed_ms: 5000 },
    { id: 'planning', state: 'completed', percent: 100, elapsed_ms: 9000 }
  ] } }
  fs.writeFileSync(path.join(liveDir, 'job_output.json'), JSON.stringify(finishedOutput))
  await publish({ ...live, revision: 4, status: 'completed', percent: 100, output: finishedOutput, finishedAt: date })
  await expectLibrary('Watched test run')
  await page.getByRole('button', { name: 'Library item actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
  await page.getByRole('list', { name: 'Stage progress' }).getByText('0:05', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close processing details', exact: true }).click()
  // Returning to Jobs must stay at the list, without a stale completion redirect.
  await jobs()
  await page.getByRole('button', { name: 'Actions for Watched test run', exact: true }).waitFor()
  await page.getByTitle('Open in Library', { exact: true }).filter({ hasText: 'Watched test run' }).click()
  await expectLibrary('Watched test run')
  await page.getByRole('button', { name: 'Library item actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
  await page.getByRole('list', { name: 'Stage progress' }).getByText('0:05', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
})

test('Jobs marks review runs as Editing until every candidate is baked or discarded', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-jobs-editing-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'BridgeClip')
  const runs = [
    { title: 'Unbaked review', statuses: ['refining', 'ready'], clips: 0, review: true },
    { title: 'Earlier exports with new edits', statuses: ['refining', 'baked'], clips: 1, review: true },
    { title: 'Finished review', statuses: ['baked', 'discarded'], clips: 1, review: true },
    { title: 'Automatic run', statuses: ['refining', 'ready'], clips: 1, review: false }
  ]
  for (const [i, run] of runs.entries()) {
    run.dir = path.join(library, `review-${i}`)
    fs.mkdirSync(run.dir, { recursive: true })
    run.project = structuredClone(editorFixture)
    run.project.candidates.forEach((candidate, index) => {
      candidate.status = run.statuses[index]
      // An exported candidate can require editing/baking again.
      candidate.exports = run.clips > 0 ? [0] : []
    })
    fs.writeFileSync(path.join(run.dir, 'editor-project.json'), JSON.stringify(run.project))
    // Jobs only reads project state; it must not try to decode the source video.
    for (const file of ['editor-source.mp4', 'editor-preview.mp4']) fs.writeFileSync(path.join(run.dir, file), '')
    fs.writeFileSync(path.join(run.dir, 'job_output.json'), JSON.stringify({ job_id: `review-${i}`,
      source_video_url: 'source.mp4', source_video_title: run.title, editor_project: run.review,
      source_video_duration_seconds: 12, total_clips: run.clips,
      clips: run.clips ? [{ clip_index: 0, s3_url: path.join(run.dir, 'clip_00.mp4'), duration_ms: 5000, start_time_ms: 0, end_time_ms: 5000, virality_score: .8 }] : [] }))
  }
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page, app } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900))
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  const row = title => page.getByTitle('Open in Library', { exact: true }).filter({ hasText: title })
  await row(runs[0].title).getByLabel('Editing: 2 clips left to finish', { exact: true }).waitFor()
  await row(runs[1].title).getByLabel('Editing: 1 clip left to finish', { exact: true }).waitFor()
  for (const run of runs.slice(2)) {
    await row(run.title).waitFor()
    assert.equal(await row(run.title).locator('[aria-label^="Editing:"]').count(), 0)
  }
  if (process.env.BRIDGECLIP_E2E_SHOTS) {
    fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'jobs-editing.png') })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(740, 600))
  assert.equal(await row(runs[0].title).getByLabel('Editing: 2 clips left to finish', { exact: true }).isVisible(), true)
  assert.equal(await row(runs[0].title).evaluate(el => el.scrollWidth > el.clientWidth), false)
  const save = async statuses => {
    runs[0].project.candidates.forEach((candidate, index) => { candidate.status = statuses[index] })
    fs.writeFileSync(path.join(runs[0].dir, 'editor-project.json'), JSON.stringify(runs[0].project))
    await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click()
  }
  await save(['discarded', 'discarded'])
  await row(runs[0].title).locator('[aria-label^="Editing:"]').waitFor({ state: 'detached' })
  await save(['discarded', 'ready'])
  await row(runs[0].title).getByLabel('Editing: 1 clip left to finish', { exact: true }).waitFor()
  await save(['discarded', 'baked'])
  await row(runs[0].title).locator('[aria-label^="Editing:"]').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
})

test('Jobs recovers live runs after missed events and refreshes them even when history fails', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-jobs-recovery-'))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir: path.join(root, 'user-data') })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { app, page } = session
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  // The initial list was empty. The job is created afterward, with all push
  // events deliberately omitted. Only the authoritative jobs:list can find it.
  await app.evaluate(({ ipcMain }, root) => {
    const now = new Date().toISOString()
    globalThis.recoveryJob = { id: 'missed-run', revision: 1, request: { videoUrl: 'missed-event.mp4' },
      status: 'downloading', percent: 25, step: 'Downloading video', clipsDone: 0, clipsTotal: 0,
      error: null, errorHint: null, output: null, outputDir: root, queuedAt: now, startedAt: now, finishedAt: null }
    ipcMain.removeHandler('jobs:list')
    ipcMain.handle('jobs:list', () => [globalThis.recoveryJob])
  }, root)
  await page.getByRole('button', { name: /^Jobs(?:,|$)/ }).click()
  const active = page.getByRole('region', { name: 'Active jobs' })
  await active.getByText('missed-event.mp4', { exact: true }).waitFor()
  await active.getByRole('button').first().click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
  await page.getByRole('button', { name: 'All jobs', exact: true }).click()
  await app.evaluate(({ ipcMain }) => {
    globalThis.recoveryJob = { ...globalThis.recoveryJob, revision: 2, status: 'failed', error: 'Test download failure', finishedAt: new Date().toISOString() }
    ipcMain.removeHandler('history:list')
    ipcMain.handle('history:list', () => { throw new Error('History unavailable') })
  })
  await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click()
  await active.waitFor({ state: 'detached' })
  await page.getByRole('alert').filter({ hasText: 'History unavailable' }).waitFor()
  assert.deepEqual(errors, [])
})
