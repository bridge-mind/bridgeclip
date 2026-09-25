'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { bridgeTestCommand } = require('./run-bridge-tests.cjs')

test('bridge tests select the Windows Python command without a shell', () => {
  assert.deepEqual(bridgeTestCommand('win32'), {
    command: 'python', args: ['-m', 'unittest', 'discover', '-s', 'bridge', '-p', 'test_*.py']
  })
  assert.equal(bridgeTestCommand('darwin').command, 'python3')
  assert.equal(bridgeTestCommand('linux').command, 'python3')
})
