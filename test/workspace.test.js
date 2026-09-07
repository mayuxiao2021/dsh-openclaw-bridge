'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createWorkspaceManagerPlugin } = require('../src/dsh-workspace-manager.js')

test('exports a cordis-shaped plugin', () => {
  const plugin = createWorkspaceManagerPlugin()
  assert.equal(typeof plugin.apply, 'function')
})

test('apply needs the DSH sandbox harness global', () => {
  const plugin = createWorkspaceManagerPlugin()
  assert.throws(() => plugin.apply({ get() { return undefined } }), /harness is not defined/)
})
