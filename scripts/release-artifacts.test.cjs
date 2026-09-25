'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const yaml = require('js-yaml')
const { execFileSync } = require('node:child_process')
const { collect, targets } = require('./release/collect-artifacts.cjs')

test('native Mac packaging keeps the CLI architecture for both distributable targets', () => {
  const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory')
  const { Platform } = require('app-builder-lib')
  const { Arch } = require('builder-util')
  const config = yaml.load(fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8'))
  for (const arch of [Arch.arm64, Arch.x64]) {
    const resolved = computeArchToTargetNamesMap(new Map([[arch, []]]), {
      platformSpecificBuildOptions: config.mac, defaultTarget: ['dmg', 'zip']
    }, Platform.MAC)
    assert.deepEqual([...resolved.keys()], [arch], 'foreign Electron architectures must not receive the staged native runtime')
    assert.deepEqual(resolved.get(arch).sort(), ['dmg', 'zip'])
  }
})

test('Linux artifact names stay consistent across Builder architecture aliases', () => {
  const { PlatformPackager } = require('app-builder-lib/out/platformPackager')
  const { Platform } = require('app-builder-lib')
  const { Arch } = require('builder-util')
  const config = yaml.load(fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8'))
  const packager = { config, platformSpecificBuildOptions: config.linux, appInfo: { version: '1.2.3' }, platform: Platform.LINUX }
  for (const method of ['artifactPatternConfig', 'expandArtifactNamePattern', 'computeArtifactName', 'expandMacro']) {
    packager[method] = PlatformPackager.prototype[method]
  }
  for (const extension of ['AppImage', 'deb']) {
    assert.equal(packager.expandArtifactNamePattern({}, extension, Arch.x64), `BridgeClip-1.2.3-linux-x64.${extension}`)
  }
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-artifacts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [target, contract] of Object.entries(targets)) {
    const directory = path.join(root, target)
    fs.mkdirSync(directory)
    const platform = target.startsWith('mac') ? 'mac' : target.startsWith('windows') ? 'win' : 'linux'
    const files = contract.extensions.map(extension => {
      const name = `BridgeClip-1.2.3-${platform}-${target.split('-').at(-1)}.${extension}`
      const data = Buffer.from(`fixture ${name}`)
      fs.writeFileSync(path.join(directory, name), data)
      return { url: name, size: data.length, sha512: crypto.createHash('sha512').update(data).digest('base64') }
    })
    fs.writeFileSync(path.join(directory, contract.metadata), yaml.dump({ version: '1.2.3', files, path: files[0].url, sha512: files[0].sha512 }))
  }
  return root
}
test('a release includes all platforms and metadata matches the final bytes', async t => {
  const root = fixture(t), output = path.join(root, 'publish')
  await collect(root, output, '1.2.3', 'a'.repeat(40))
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'release-manifest.json')))
  assert.equal(manifest.sourceSha, 'a'.repeat(40))
  assert.equal(manifest.files.filter(file => /\.(dmg|zip|exe|AppImage|deb)$/.test(file.name)).length, 7)
  assert.equal(yaml.load(fs.readFileSync(path.join(output, 'latest-mac.yml'), 'utf8')).files.length, 4)
  for (const entry of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(output, entry.name))).digest('hex'), entry.sha256)
})
test('missing platforms cannot produce a partial public release', async t => {
  const root = fixture(t)
  fs.rmSync(path.join(root, 'windows-x64'), { recursive: true })
  await assert.rejects(collect(root, path.join(root, 'publish'), '1.2.3', 'a'.repeat(40)))
})
test('changed installer bytes and mismatched versions are rejected', async t => {
  const root = fixture(t)
  fs.appendFileSync(path.join(root, 'windows-x64/BridgeClip-1.2.3-win-x64.exe'), 'changed')
  await assert.rejects(collect(root, path.join(root, 'publish'), '1.2.3', 'a'.repeat(40)), /size mismatch/)
  await assert.rejects(collect(root, path.join(root, 'other'), '1.2.4', 'a'.repeat(40)), /Wrong .* version/)
})

test('one native package cannot introduce updater entries for another architecture', async t => {
  const root = fixture(t), filename = path.join(root, 'mac-arm64/latest-mac.yml')
  const metadata = yaml.load(fs.readFileSync(filename, 'utf8'))
  metadata.files.push({ url: 'BridgeClip-1.2.3-mac-x64.zip', size: 1, sha512: 'fixture' })
  fs.writeFileSync(filename, yaml.dump(metadata))
  await assert.rejects(collect(root, path.join(root, 'publish'), '1.2.3', 'a'.repeat(40)), /Unexpected mac-arm64 updater entry/)
})

test('notarization metadata uses final ZIP bytes and removes stale DMG blockmaps', t => {
  const root = fixture(t), directory = path.join(root, 'mac-arm64')
  const filename = path.join(directory, 'latest-mac.yml')
  const blockmap = path.join(directory, 'BridgeClip-1.2.3-mac-arm64.dmg.blockmap')
  fs.writeFileSync(blockmap, 'old map')
  fs.appendFileSync(path.join(directory, 'BridgeClip-1.2.3-mac-arm64.dmg'), 'notarization ticket')
  execFileSync(process.execPath, [path.join(__dirname, 'release/refresh-metadata.cjs'), filename])
  const metadata = yaml.load(fs.readFileSync(filename, 'utf8'))
  assert.equal(metadata.files.length, 1)
  assert.match(metadata.path, /\.zip$/)
  assert.equal(metadata.sha512, metadata.files[0].sha512)
  assert.equal(fs.existsSync(blockmap), false)
})
