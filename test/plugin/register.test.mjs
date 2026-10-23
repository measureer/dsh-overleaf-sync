/**
 * Plugin wiring test: no DSH host, just enough of a Cordis context to prove that
 * `apply()` registers every tool exactly once and that the config schema accepts
 * a bare `config: {}` block.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const plugin = await import('../../lib/index.js')
const { resolveConfig } = await import('../../lib/config.js')

function fakeContext() {
  const registered = []
  const disposed = []
  const cleanups = []
  const sctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => disposed.push(tool.name)
      },
    },
    effect(factory) {
      const dispose = factory()
      const run = () => {
        if (typeof dispose === 'function') dispose()
      }
      cleanups.push(run)
      return run
    },
  }
  const ctx = {
    inject(_deps, callback) {
      callback(sctx)
    },
  }
  return { ctx, registered, disposed, cleanups }
}

test('plugin exposes the documented module shape', () => {
  assert.equal(plugin.name, 'dsh-overleaf-sync')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function', 'Config must be a schemastery schema')
  assert.deepEqual(plugin.inject, ['tools'])
})

test('apply() registers every overleaf_* tool and disposes them cleanly', () => {
  const { ctx, registered, disposed, cleanups } = fakeContext()

  plugin.apply(ctx, {})

  assert.deepEqual(registered.map((tool) => tool.name).sort(), [
    'overleaf_conflicts',
    'overleaf_diff',
    'overleaf_link',
    'overleaf_login',
    'overleaf_logout',
    'overleaf_projects',
    'overleaf_pull',
    'overleaf_push',
    'overleaf_resolve',
    'overleaf_status',
    'overleaf_watch',
  ])
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`)
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  for (const cleanup of cleanups) cleanup()
  assert.deepEqual(disposed.sort(), registered.map((tool) => tool.name).sort())
})

test('config schema fills in the documented defaults', () => {
  // Editable fields are `.volatile()`, so the schema yields references; the
  // public way to read them is `resolveConfig`, which unwraps every one.
  const config = resolveConfig(plugin.Config({}))

  assert.equal(config.baseUrl, 'https://www.overleaf.com')
  assert.equal(config.localRootPattern, '~/Overleaf/{project}')
  assert.equal(config.defaultStrategy, 'keep-both')
  assert.equal(config.git.autoInit, true)
  assert.equal(config.watch.autoStart, false)
})

test('volatile fields stay references until resolveConfig unwraps them', () => {
  const raw = plugin.Config({})
  assert.equal(typeof raw.baseUrl, 'object')
  assert.equal(raw.baseUrl.get(), 'https://www.overleaf.com')
  assert.equal(resolveConfig(raw).baseUrl, 'https://www.overleaf.com')
})
