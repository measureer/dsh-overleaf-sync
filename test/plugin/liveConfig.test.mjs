import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

import { ConfigSchema, liveConfig, resolveConfig } from '../../lib/config.js'

test('liveConfig sees a volatile write made after it was created', () => {
  const raw = ConfigSchema({})
  const config = liveConfig(raw)

  assert.equal(config.defaultStrategy, 'keep-both')
  assert.equal(config.git.autoInit, true)

  // This is exactly what the Loader does for a Settings patch: the reference
  // stays, its value is replaced.
  updateVolatile(raw.defaultStrategy, createVolatile('auto'))
  updateVolatile(raw.git.autoInit, createVolatile(false))

  assert.equal(config.defaultStrategy, 'auto')
  assert.equal(config.git.autoInit, false)
})

test('liveConfig still applies schema defaults and plain overrides', () => {
  const config = liveConfig({ defaultStrategy: 'keep-local', git: { autoInit: false } })
  assert.equal(config.defaultStrategy, 'keep-local')
  assert.equal(config.git.autoInit, false)
  assert.equal(config.baseUrl, 'https://www.overleaf.com')
  assert.equal(config.watch.autoStart, false)
})

test('liveConfig and resolveConfig agree on a fresh parse', () => {
  const live = liveConfig({})
  const plain = resolveConfig({})
  assert.deepEqual(
    { baseUrl: live.baseUrl, strategy: live.defaultStrategy, git: live.git },
    { baseUrl: plain.baseUrl, strategy: plain.defaultStrategy, git: plain.git },
  )
})
