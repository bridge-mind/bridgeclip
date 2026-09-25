'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function canCreateLink(type) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-link-probe-'))
  const target = path.join(root, 'target')
  try {
    if (type === 'file') fs.writeFileSync(target, '')
    else fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(root, 'link'), type)
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'EINVAL'].includes(error.code)) return false
    throw error
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const fileLinksAvailable = canCreateLink('file')
const directoryLinkType = canCreateLink('dir') ? 'dir' : canCreateLink('junction') ? 'junction' : null

module.exports = { fileLinksAvailable, directoryLinkType }
