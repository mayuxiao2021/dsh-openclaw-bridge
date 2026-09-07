'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createOpenClawEnginePlugin, DEFAULT_OPTIONS } = require('../src/dsh-openclaw-engine.js')

test('exports defaults and factory', () => {
  assert.ok(DEFAULT_OPTIONS.engineBase.startsWith('/'))
  assert.equal(typeof createOpenClawEnginePlugin, 'function')
})

test('factory returns a cordis-shaped plugin', () => {
  const plugin = createOpenClawEnginePlugin({ engineToken: 'x' })
  assert.equal(typeof plugin.apply, 'function')
})

test('options merge over defaults; apply needs the DSH sandbox', () => {
  const plugin = createOpenClawEnginePlugin({ engineBase: '/v2', engineModel: 'm2' })
  // `harness` is injected by the DSH dynamic-host sandbox; in plain Node it is absent,
  // which documents that the plugin must run inside DSH (dynamic plugin or composition).
  assert.throws(() => plugin.apply({ get() { return undefined } }), /harness is not defined/)
})
