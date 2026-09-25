'use strict'

const { spawnSync } = require('node:child_process')

function bridgeTestCommand(platform = process.platform) {
  return {
    command: platform === 'win32' ? 'python' : 'python3',
    args: ['-m', 'unittest', 'discover', '-s', 'bridge', '-p', 'test_*.py']
  }
}

function main() {
  const { command, args } = bridgeTestCommand()
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true })
  if (result.error) {
    console.error(result.error.message)
    process.exitCode = 1
  } else {
    process.exitCode = result.status ?? 1
  }
}

if (require.main === module) main()

module.exports = { bridgeTestCommand }
