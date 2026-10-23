/**
 * Contract tests for the right-sidebar half of the client bundle.
 *
 * The bundle is evaluated against the same `__ModuleLoader__` shape the DSH web
 * runtime uses; the sidebar registry, the slot registry and the locale service
 * are stand-ins that record what the plugin asked for. Nothing here renders, so
 * the assertions stay about registration — the rendering test lives next to the
 * settings page in `render.test.mjs`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const noderequire = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '../../lib/client.js')

async function readBundle() {
  try {
    return await readFile(bundlePath, 'utf8')
  } catch {
    return undefined
  }
}

/** Evaluate `lib/client.js` and return the plugin's exports plus the loader record. */
function loadBundle(source) {
  let loaded
  const window = { __ModuleLoader__: { load: (mod) => void (loaded = mod) } }
  const modules = {
    react: noderequire('react'),
    'react/jsx-runtime': noderequire('react/jsx-runtime'),
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  const load = (id) => {
    if (!(id in modules)) throw new Error(`unexpected external module in the bundle: ${id}`)
    return modules[id]
  }
  new Function('window', 'require', source)(window, load)
  return { loaded, load }
}

/** A client context recording every registration the plugin performs. */
function mockContext(options = {}) {
  const registered = []
  const effects = []
  const ctx = {
    effect(callback, label) {
      effects.push(label)
      const dispose = callback()
      return () => dispose?.()
    },
    inject(_names, callback) {
      return callback(ctx)
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(opts, component) {
        registered.push({ opts, component })
        return () => {}
      },
    },
  }
  if (options.sidebar === true) {
    ctx.sidebarRightTabs = {
      entries: () => definitions,
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    }
  }
  const definitions = []
  return { ctx, registered, definitions, effects }
}

test('with a sidebar registry the plugin registers the tab type and its body', async (t) => {
  const source = await readBundle()
  if (source === undefined) {
    t.skip('lib/client.js missing: run `pnpm run bundle` first')
    return
  }
  const { loaded, load } = loadBundle(source)
  const exportsObject = loaded.factory(load)
  const { ctx, registered, definitions } = mockContext({ sidebar: true })

  exportsObject.apply(ctx)

  assert.equal(definitions.length, 1, 'exactly one tab type is contributed')
  const definition = definitions[0]
  assert.equal(definition.id, 'overleaf-sync')
  assert.equal(definition.kind, 'overleaf-sync')
  assert.equal(definition.multiple, false, 'one status pane per session')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.title(''), 'tabTitle')
  assert.equal(definition.patterns, undefined, 'a page type must not claim addresses')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'overleaf-sync')
  assert.equal(definition.guide[0].title(), 'tabTitle')
  assert.equal(definition.guide[0].description(), 'tabGuide')

  const bySlot = new Map(registered.map((entry) => [entry.opts.name, entry.opts]))
  assert.ok(bySlot.has('settings.section'))
  const body = bySlot.get('sidebar.right.pane.tab')
  assert.ok(body !== undefined, 'the pane body is registered under the same id')
  assert.equal(body.key, 'overleaf-sync')
  assert.equal(body.locale, 'overleaf-sync')
})

test('a shell without a right sidebar still mounts the settings page', async (t) => {
  const source = await readBundle()
  if (source === undefined) {
    t.skip('lib/client.js missing: run `pnpm run bundle` first')
    return
  }
  const { loaded, load } = loadBundle(source)
  const exportsObject = loaded.factory(load)
  const { ctx, registered, definitions } = mockContext({ sidebar: false })

  assert.doesNotThrow(() => exportsObject.apply(ctx))
  assert.equal(definitions.length, 0)
  assert.deepEqual(
    registered.map((entry) => entry.opts.name),
    ['settings.section'],
  )
})
