const { readFileSync, writeFileSync, constants } = require('node:fs')
const { open } = require('node:fs/promises')
const { join, basename } = require('node:path')
const { createHash } = require('node:crypto')
const yaml = require('js-yaml')

function mergeMetadata(documents) {
  const [first] = documents
  if (!first || !first.version || !Array.isArray(first.files)) throw new Error('Invalid update metadata')
  const files = new Map()
  for (const document of documents) {
    if (document.version !== first.version || !Array.isArray(document.files)) throw new Error('Mismatched update versions')
    for (const file of document.files) {
      if (!file.url || !file.sha512 || !(file.size > 0)) throw new Error('Invalid update artifact')
      if (files.has(file.url)) throw new Error('Duplicate update artifact')
      files.set(file.url, file)
    }
  }
  return { ...first, files: [...files.values()] }
}

async function verifyArtifacts(document, directory) {
  for (const file of document.files) {
    if (typeof file.url !== 'string' || basename(file.url) !== file.url ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:zip|dmg|exe|AppImage|deb)$/.test(file.url)) {
      throw new Error('Invalid update artifact name')
    }
    const artifact = join(directory, file.url)
    // Check and hash the same open inode. O_NOFOLLOW prevents a symlink swap
    // between validation and opening from redirecting the stream.
    const handle = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const artifactStat = await handle.stat()
      if (!artifactStat.isFile() || artifactStat.size !== file.size) throw new Error(`Update artifact size mismatch: ${file.url}`)
      const hash = createHash('sha512')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const digest = hash.digest('base64')
      if (digest !== file.sha512) throw new Error(`Update artifact digest mismatch: ${file.url}`)
    } finally {
      await handle.close()
    }
  }
  if (document.path !== undefined) {
    const legacy = document.files.find(file => file.url === document.path)
    if (!legacy || legacy.sha512 !== document.sha512) throw new Error('Legacy update metadata mismatch')
  }
}

async function main() {
  const root = process.argv[2]
  if (!root) throw new Error('Artifact directory required')
  const documents = []
  for (const arch of ['arm64', 'x64']) {
    const directory = join(root, `mac-${arch}`)
    const document = yaml.load(readFileSync(join(directory, 'latest-mac.yml'), 'utf8'))
    await verifyArtifacts(document, directory)
    documents.push(document)
  }
  writeFileSync(join(root, 'latest-mac.yml'), yaml.dump(mergeMetadata(documents)))
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { mergeMetadata, verifyArtifacts }
