'use strict'
const fs = require('node:fs')
const yaml = require('js-yaml')
const config = yaml.load(fs.readFileSync('electron-builder.yml', 'utf8'))
for (const key of ['SIGNING_ENDPOINT', 'SIGNING_ACCOUNT', 'SIGNING_PROFILE']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`)
}
config.forceCodeSigning = true
delete config.win.signtoolOptions
config.win.azureSignOptions = {
  publisherName: 'BRIDGEMIND LLC',
  endpoint: process.env.SIGNING_ENDPOINT,
  codeSigningAccountName: process.env.SIGNING_ACCOUNT,
  certificateProfileName: process.env.SIGNING_PROFILE,
  fileDigest: 'SHA256',
  timestampDigest: 'SHA256',
  timestampRfc3161: 'http://timestamp.acs.microsoft.com'
}
fs.writeFileSync('release-windows.json', JSON.stringify(config, null, 2))
