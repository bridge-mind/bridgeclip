'use strict'
// Signing/stapling a DMG changes its bytes. Refresh both files[] and the legacy
// fields before checking/uploading metadata; ZIP bytes are already final.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const yaml = require('js-yaml')
const filename = process.argv[2]
const document = yaml.load(fs.readFileSync(filename, 'utf8'))
for (const file of document.files) {
  if (path.basename(file.url) !== file.url) throw new Error('Unsafe artifact path')
  const data = fs.readFileSync(path.join(path.dirname(filename), file.url))
  file.sha512 = crypto.createHash('sha512').update(data).digest('base64')
  file.size = data.length
}
const legacy = document.files.find(file => file.url === document.path)
if (!legacy) throw new Error('Missing primary update file')
document.sha512 = legacy.sha512
fs.writeFileSync(filename, yaml.dump(document))
