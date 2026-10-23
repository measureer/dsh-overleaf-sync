import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Renders the settings section once with the real React but stubbed primitives.
 *
 * Effects do not run in `renderToStaticMarkup`, so this exercises the initial
 * ("still loading") state only — which is exactly the code path that runs
 * before any host request and therefore the one that must not throw.
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

const primitives = {
  Button: ({ children, ...rest }) => React.createElement('button', rest, children),
  Input: (props) => React.createElement('input', props),
  Switch: ({ checked, onChange, label, ...rest }) =>
    React.createElement('label', rest, React.createElement('input', { type: 'checkbox', checked: Boolean(checked), readOnly: true }), label),
}

test('the registered section renders its four blocks without a host', async (t) => {
  const source = await readBundle()
  if (source === undefined) {
    t.skip('lib/client.js missing: run `pnpm run bundle` first')
    return
  }

  let loaded
  const window = { __ModuleLoader__: { load: (mod) => void (loaded = mod) } }
  const modules = { react: React, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const require = (id) => {
    if (!(id in modules)) throw new Error(`unexpected external module in the bundle: ${id}`)
    return modules[id]
  }
  new Function('window', 'require', source)(window, require)

  const registrations = []
  const exportsObject = loaded.factory(require)
  const ctx = {
    effect: (callback) => callback(),
    inject: (_names, callback) => callback(ctx),
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exportsObject.apply(ctx)

  assert.equal(registrations.length, 1)
  const Section = registrations[0].component
  // `t` echoes keys, so the markup proves which locale strings are asked for
  // without depending on a dictionary.
  const html = renderToStaticMarkup(React.createElement(Section, { close: () => {}, t: (key) => key }))

  for (const key of ['accountTitle', 'projectTitle', 'strategyTitle', 'advancedTitle', 'saveButton']) {
    assert.match(html, new RegExp(key), `the rendered section must contain "${key}"`)
  }
  assert.doesNotMatch(html, /undefined/)
})
