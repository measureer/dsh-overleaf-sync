import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerOverleafApi } from '../../lib/server/index.js'
import { resolveConfig } from '../../lib/config.js'

/** Minimal Cordis-ish context: `inject` runs the callback immediately. */
function fakeContext(services) {
  const effects = []
  const ctx = {
    ...services,
    inject(_names, callback) {
      callback(ctx)
    },
    effect(execute) {
      const dispose = execute()
      effects.push(dispose)
      return () => dispose?.()
    },
  }
  return { ctx, effects }
}

const config = resolveConfig({})

function fakeService() {
  return {
    async status() {
      return { baseUrl: 'https://www.overleaf.com', authenticated: false, projects: [], text: 'not logged in' }
    },
    async credential() {
      return undefined
    },
    async readLink() {
      const error = new Error('none')
      error.code = 'E_NOT_LINKED'
      throw error
    },
  }
}

test('registers one route per API method and disposes them on unload', () => {
  const registered = []
  const { ctx } = fakeContext({
    webServer: {
      register(route) {
        registered.push(route)
        return () => {
          const index = registered.indexOf(route)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  })
  const dispose = registerOverleafApi(ctx, { service: fakeService(), config, cwd: process.cwd() })

  const paths = registered.map((route) => route.path).sort()
  assert.deepEqual(paths, [
    '/overleaf/api/conflicts',
    '/overleaf/api/diff',
    '/overleaf/api/journal',
    '/overleaf/api/link',
    '/overleaf/api/login',
    '/overleaf/api/logout',
    '/overleaf/api/pick-directory',
    '/overleaf/api/projects',
    '/overleaf/api/pull',
    '/overleaf/api/push',
    '/overleaf/api/resolve',
    '/overleaf/api/settings.describe',
    '/overleaf/api/settings.update',
    '/overleaf/api/status',
    '/overleaf/api/validate-path',
    '/overleaf/api/watch',
    '/overleaf/events',
  ])
  assert.ok(registered.every((route) => route.kind === 'exact'))

  dispose()
  assert.equal(registered.length, 0)
})

test('a host without webServer still loads (tools-only)', () => {
  const { ctx } = fakeContext({})
  assert.doesNotThrow(() => registerOverleafApi(ctx, { service: fakeService(), config, cwd: process.cwd() }))
})

test('registered handler answers with the envelope', async () => {
  const registered = []
  const { ctx } = fakeContext({
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  })
  registerOverleafApi(ctx, { service: fakeService(), config, cwd: process.cwd() })

  const status = registered.find((route) => route.path === '/overleaf/api/status')
  assert.ok(status)
  const req = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{}')
    },
  }
  let body
  const res = {
    writeHead() {},
    end(text) {
      body = JSON.parse(text)
    },
  }
  status.handler(req, res)
  for (let i = 0; i < 100 && body === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(body.ok, true)
  assert.equal(body.value.authenticated, false)
})

test('optional services are read through ctx.get, not the guarded property', () => {
  // Cordis throws `cannot get property "webServer" without inject` for a plugin
  // that did not declare a hard dependency, so the GUI half must use ctx.get.
  const registered = []
  const webServer = {
    register(route) {
      registered.push(route)
      return () => {}
    },
  }
  const ctx = {
    inject(_names, callback) {
      callback(ctx)
    },
    effect(execute) {
      const dispose = execute()
      return () => dispose?.()
    },
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
  }
  for (const guarded of ['webServer', 'settings']) {
    Object.defineProperty(ctx, guarded, {
      get() {
        throw new Error(`cannot get property "${guarded}" without inject`)
      },
    })
  }

  assert.doesNotThrow(() => registerOverleafApi(ctx, { service: fakeService(), config, cwd: process.cwd() }))
  assert.equal(registered.length, 17)
})
