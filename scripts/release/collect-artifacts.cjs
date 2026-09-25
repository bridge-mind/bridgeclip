'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const yaml = require('js-yaml')
const { mergeMetadata, verifyArtifacts } = require('../merge-update-metadata.cjs')

const targets = {
  'mac-arm64': { metadata: 'latest-mac.yml', extensions: ['dmg', 'zip'] },
  'mac-x64': { metadata: 'latest-mac.yml', extensions: ['dmg', 'zip'] },
  'windows-x64': { metadata: 'latest.yml', extensions: ['exe'] },
  'linux-x64': { metadata: 'latest-linux.yml', extensions: ['AppImage', 'deb'] }
}
async function collect(root, output, version, sourceSha) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid release identity')
  if (fs.existsSync(output)) throw new Error('Publication directory already exists')
  fs.mkdirSync(output)
  const metadata = new Map()
  for (const [target, contract] of Object.entries(targets)) {
    const directory = path.join(root, target)
    const doc = yaml.load(fs.readFileSync(path.join(directory, contract.metadata), 'utf8'))
    if (doc.version !== version) throw new Error(`Wrong ${target} version`)
    const platform = target.startsWith('mac-') ? 'mac' : target.startsWith('windows-') ? 'win' : 'linux'
    const expectedNames = new Set(contract.extensions.map(extension => `BridgeClip-${version}-${platform}-${target.split('-').at(-1)}.${extension}`))
    for (const file of doc.files || []) {
      if (!expectedNames.has(file.url)) throw new Error(`Unexpected ${target} updater entry: ${file.url}`)
    }
    await verifyArtifacts(doc, directory)
    const docs = metadata.get(contract.metadata) || []
    docs.push(doc); metadata.set(contract.metadata, docs)
    for (const extension of contract.extensions) {
      const name = `BridgeClip-${version}-${platform}-${target.split('-').at(-1)}.${extension}`
      const file = path.join(directory, name)
      if (!fs.lstatSync(file).isFile()) throw new Error(`Missing release asset ${name}`)
      // These are the actual updater payloads for each platform. A valid hash
      // for a differently named file is not a complete update feed.
      if (['zip', 'exe', 'AppImage'].includes(extension) && !doc.files.some(entry => entry.url === name)) {
        throw new Error(`Update metadata omits ${name}`)
      }
      fs.copyFileSync(file, path.join(output, name), fs.constants.COPYFILE_EXCL)
    }
    for (const name of fs.readdirSync(directory)) {
      if (/^(node-sbom-|python-packages-|verification-).+\.json$/.test(name) || /^BridgeClip-[A-Za-z0-9._-]+\.blockmap$/.test(name)) {
        if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error('Non-file release evidence')
        fs.copyFileSync(path.join(directory, name), path.join(output, name), fs.constants.COPYFILE_EXCL)
      }
    }
  }
  for (const [name, documents] of metadata) fs.writeFileSync(path.join(output, name), yaml.dump(mergeMetadata(documents)))
  const entries = []
  for (const name of fs.readdirSync(output).sort()) {
    const data = fs.readFileSync(path.join(output, name))
    entries.push({ name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') })
  }
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify({ version, sourceRepository: 'bridge-mind/bridgeclip', sourceSha, files: entries }, null, 2) + '\n')
  const manifest = fs.readFileSync(path.join(output, 'release-manifest.json'))
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), entries.map(entry => `${entry.sha256}  ${entry.name}\n`).join('') + `${crypto.createHash('sha256').update(manifest).digest('hex')}  release-manifest.json\n`)
}
if (require.main === module) collect(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { collect, targets }
