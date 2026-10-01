const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../../src/main/password-store.ts'), 'utf8')
const loaded = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: loaded, exports: loaded.exports })
const { linuxPasswordStore } = loaded.exports

test('desktops Chromium does not recognise use the Secret Service keyring instead of plaintext', () => {
  for (const desktop of ['sway', 'i3', 'Hyprland', 'LXQt', 'niri', '']) {
    assert.equal(linuxPasswordStore({ XDG_CURRENT_DESKTOP: desktop }, false), 'gnome-libsecret', desktop || 'no desktop')
  }
  assert.equal(linuxPasswordStore({}, false), 'gnome-libsecret')
  // GNOME-family desktops already use libsecret; naming it changes nothing.
  assert.equal(linuxPasswordStore({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, false), 'gnome-libsecret')
})

test('KDE keeps KWallet, where existing keys may already be encrypted', () => {
  for (const env of [{ XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'Kubuntu:KDE' }, { DESKTOP_SESSION: 'plasma' }, { DESKTOP_SESSION: 'kde-plasma' }, { KDE_FULL_SESSION: 'true' }]) {
    assert.equal(linuxPasswordStore(env, false), null, JSON.stringify(env))
  }
})

test('an explicit --password-store always wins', () => {
  assert.equal(linuxPasswordStore({ XDG_CURRENT_DESKTOP: 'sway' }, true), null)
})
