const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { editorTools } = require('./editor-e2e-tools.cjs')

test('Library deletion previews space and scope, supports keyboard cancellation and retries failed estimates', { timeout: 90000 }, async t => {
  const tools = editorTools(t, { playable: false })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-deletion-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userDataDir = path.join(root, 'user-data')
  const jobId = '11111111-1111-4111-8111-111111111111'
  const run = path.join(userDataDir, 'BridgeClip', jobId)
  fs.mkdirSync(path.join(run, '.editor'), { recursive: true })
  const title = 'Diogo Almeida (ex-OpenAI) reveals JEV: 200x faster, 400x cheaper, zero hallucinations.'
  const clip = path.join(run, 'clip.mp4')
  execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1', ...tools.encoder, '-pix_fmt', 'yuv420p', clip])
  fs.writeFileSync(path.join(run, 'run-history.json'), JSON.stringify({ jobId, sourceLabel: title, status: 'completed', errorMessage: null, startedAt: '2026-09-20T12:00:00Z', finishedAt: '2026-09-20T12:01:00Z' }))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: jobId, source_video_title: title, source_video_url: 'local.mp4', total_clips: 1,
    clips: [{ clip_index: 0, summary: title, s3_url: clip, duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 90 }] }))
  fs.writeFileSync(path.join(run, '.editor', 'source-copy.mp4'), Buffer.alloc(2_400_000))
  const expectedBytes = [clip, path.join(run, 'run-history.json'), path.join(run, 'job_output.json'), path.join(run, '.editor', 'source-copy.mp4')].reduce((total, file) => total + fs.statSync(file).size, 0)
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir, env: tools.appEnv })
  // Close before cleaning up the isolated user data, even after an assertion fails.
  const { app, page } = session
  try {
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 900))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    const size = page.locator('[data-library-storage]')
    await size.getByText('2.4 MB', { exact: true }).waitFor()
    const remove = page.getByRole('button', { name: `Delete ${title}`, exact: true })
    const dialog = page.getByRole('alertdialog')
    const estimate = dialog.getByRole('status', { name: 'Space freed estimate' })
    await remove.click()
    await estimate.getByText('2.4 MB', { exact: true }).waitFor()
    const preview = await page.evaluate(run => window.bridgeclip.history.deletionPreview(run), run)
    assert.equal(preview.bytes, expectedBytes)
    assert.equal(preview.fileCount, 4)
    await dialog.getByText('1 clip', { exact: true }).waitFor()
    await dialog.getByText('All run files', { exact: true }).waitFor()
    await dialog.getByText('Published posts & copies saved elsewhere').waitFor()
    assert.equal(await dialog.getByText(run, { exact: true }).isVisible(), false)
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const confirm = dialog.getByRole('button', { name: 'Delete local files', exact: true })
    assert.equal(await cancel.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await confirm.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Tab')
    const folder = dialog.getByRole('button', { name: 'Folder location' })
    assert.equal(await folder.evaluate(el => el === document.activeElement), true, 'Focus stays in the dialog')
    const screenshot = async name => {
      if (!process.env.BRIDGECLIP_E2E_SHOTS) return
      fs.mkdirSync(process.env.BRIDGECLIP_E2E_SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, name) })
    }
    await screenshot('library-delete.png')
    await folder.click()
    await dialog.getByText(run, { exact: true }).waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 560))
    await screenshot('library-delete-small.png')
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.equal(await confirm.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await remove.evaluate(el => el === document.activeElement), true)
    assert.equal(fs.existsSync(clip), true, 'Cancel never deletes files')

    // The estimate fails independently; retry recovers without reopening the dialog.
    await app.evaluate(({ ipcMain }, preview) => {
      let calls = 0
      ipcMain.removeHandler('history:deletionPreview')
      ipcMain.handle('history:deletionPreview', async () => {
        if (++calls === 1) throw new Error('Folder temporarily unavailable')
        return { ...preview, partial: true }
      })
    }, preview)
    await remove.click()
    await estimate.getByText('Size unavailable', { exact: true }).waitFor()
    assert.equal(await estimate.getByText('0 B', { exact: true }).count(), 0)
    await dialog.getByRole('button', { name: 'Retry size estimate' }).click()
    await estimate.getByText('At least 2.4 MB', { exact: true }).waitFor()
    await estimate.getByText('Some files couldn’t be counted.', { exact: true }).waitFor()
    await cancel.click()
    assert.equal(fs.existsSync(clip), true)

    // Card totals refresh even when the run's ID and clip count stay unchanged.
    fs.writeFileSync(path.join(run, 'extra-preview.bin'), Buffer.alloc(1_000_000))
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await size.getByText('3.4 MB', { exact: true }).waitFor()
    assert.equal(await size.evaluate(el => el.getBoundingClientRect().right <= el.closest('article').getBoundingClientRect().right), true)
    await screenshot('library-card-storage.png')
    const usage = await page.evaluate(run => window.bridgeclip.history.storageUsage(run), run)
    await app.evaluate(({ ipcMain }, usage) => {
      let calls = 0
      ipcMain.removeHandler('history:storageUsage')
      ipcMain.handle('history:storageUsage', () => {
        if (++calls === 1) throw new Error('Size unavailable')
        return { ...usage, unreadableCount: 1 }
      })
    }, usage)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await size.getByText('—', { exact: true }).waitFor()
    assert.match(await size.getAttribute('title'), /Size unavailable/)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await size.getByText('≥ 3.4 MB', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await session.close() }
})
