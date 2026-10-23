import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Smoke tests for the browser half.
 *
 * They run against the built artifact (`lib/client.js`) and only mock the DSH
 * module loader, so they prove the two things that break a client plugin in
 * practice: the wrapper shape and the module body evaluating against the real
 * externals. React itself is not rendered here.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundlePath = join(root, 'lib', 'client.js')

async function readBundle() {
  try {
    return await readFile(bundlePath, 'utf8')
  } catch {
    return undefined
  }
}

function makeReact() {
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = typeof next === 'function' ? next(this.state) : { ...this.state, ...next }
    }
  }
  return {
    Component,
    useEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
    useRef(value) {
      return { current: value }
    },
    useState(value) {
      return [value, () => {}]
    },
  }
}

function loadBundle(source) {
  let loaded
  const window = { __ModuleLoader__: { load: (mod) => void (loaded = mod) } }
  const modules = {
    react: makeReact(),
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }
  const require = (id) => {
    if (!(id in modules)) throw new Error(`unexpected external module in the bundle: ${id}`)
    return modules[id]
  }
  new Function('window', 'require', source)(window, require)
  return { loaded, require }
}

test('lib/client.js is a DSH module-loader wrapper with the plugin id', async (t) => {
  const source = await readBundle()
  if (source === undefined) {
    t.skip('lib/client.js missing: run `pnpm run bundle` first')
    return
  }
  assert.ok(source.startsWith('window.__ModuleLoader__.load({'), 'bundle must start with the loader call')
  assert.match(source, /id: "dsh-overleaf-sync"/)
  assert.match(source, /return module\.exports;/)
  assert.match(source, /^\}\);$/m, 'the loader call must be closed')
  assert.doesNotMatch(source, /require\("react-dom"\)/, 'react-dom must not be required by the settings page')
})

test('the factory evaluates against mock externals and registers the settings section', async (t) => {
  const source = await readBundle()
  if (source === undefined) {
    t.skip('lib/client.js missing: run `pnpm run bundle` first')
    return
  }
  const { loaded, require } = loadBundle(source)
  assert.ok(loaded !== undefined, 'the loader must be called')
  assert.equal(loaded.id, 'dsh-overleaf-sync')

  const exportsObject = loaded.factory(require)
  assert.equal(typeof exportsObject.apply, 'function')
  assert.deepEqual([...exportsObject.inject], ['slots', 'locale'])

  const registrations = []
  let localeRegistered = 0
  const ctx = {
    effect: (callback) => callback(),
    inject: (_names, callback) => callback(ctx),
    locale: {
      bind: () => (key) => key,
      register: () => {
        localeRegistered += 1
        return () => {}
      },
    },
    slots: {
      inject: (name, callback) => {
        assert.equal(name, 'settings.section')
        return callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  exportsObject.apply(ctx)

  assert.equal(localeRegistered, 1, 'the dictionaries must be registered once')
  assert.equal(registrations.length, 1)
  const [{ options, component }] = registrations
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'overleaf-sync')
  assert.equal(options.order, 120)
  assert.equal(options.locale, 'overleaf-sync')
  assert.equal(typeof component, 'function')
  assert.equal(options.label(), 'nav')
})

test('a context without the slots service degrades instead of throwing', async (t) => {
  const source = await readBundle()
  if (source === undefined) {
    t.skip('lib/client.js missing: run `pnpm run bundle` first')
    return
  }
  const { loaded, require } = loadBundle(source)
  const exportsObject = loaded.factory(require)
  const ctx = {
    effect: (callback) => callback(),
    inject: (_names, callback) => callback(ctx),
    locale: { bind: () => (key) => key, register: () => () => {} },
  }
  assert.doesNotThrow(() => exportsObject.apply(ctx))
})
