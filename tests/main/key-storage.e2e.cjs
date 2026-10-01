const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('on a Linux desktop Chromium does not recognise, keys go to the Secret Service keyring, not plaintext', { skip: process.platform !== 'linux' && 'Linux key storage', timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-key-storage-e2e-'))
  const appDir = buildApp(path.join(root, 'app'))
  const session = await launchApp({ appDir, userDataDir: path.join(root, 'user-data'), env: { XDG_CURRENT_DESKTOP: 'sway', DESKTOP_SESSION: 'sway', KDE_FULL_SESSION: '' } })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  // Without BridgeClip's choice, Chromium selects basic_text on sway.
  assert.equal(await session.app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend()), 'gnome_libsecret')
})

test('a saved key the keychain cannot decrypt shows a warning in Settings instead of breaking the app', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-unreadable-key-e2e-'))
  const appDir = buildApp(path.join(root, 'app'))
  const userDataDir = path.join(root, 'user-data')
  fs.mkdirSync(userDataDir, { recursive: true })
  // Bytes no keychain on this machine encrypted, like a key saved under another desktop's keyring.
  const foreign = { scheme: 'safeStorage', value: Buffer.from('not encrypted by this keychain').toString('base64') }
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 12, openrouterApiKey: foreign, zernioApiKey: '', outputDirectory: path.join(userDataDir, 'BridgeClip'), pythonPath: 'python3' }), { mode: 0o600 })
  const session = await launchApp({ appDir, userDataDir })
  t.after(async () => { await session.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page } = session
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await page.getByText('Your saved OpenRouter key can’t be read', { exact: true }).waitFor()
  assert.equal(await page.getByText('Could not load settings', { exact: false }).count(), 0)
  // The encrypted key is still on disk for when the keychain comes back.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')).openrouterApiKey, foreign)
})
