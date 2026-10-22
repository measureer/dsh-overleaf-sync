import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig } from '../../lib/config.js'
import { createOverleafRoutes } from '../../lib/server/routes.js'
import { SettingsBridge } from '../../lib/server/settingsBridge.js'
import { isCrossSite, readJson, statusForCode, toFailure } from '../../lib/server/envelope.js'
import { OverleafSyncError } from '../../lib/core/errors.js'

const config = resolveConfig({ confirmRemoteWrite: true })

/** A request stub: async-iterable body + headers + method. */
function makeRequest(body, { headers = {}, method = 'POST' } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

function makeResponse() {
  const out = { status: 0, body: undefined, headers: {} }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(text) {
      out.body = JSON.parse(text)
    },
  }
}

/** Call one route by name and wait for its async handler to settle. */
async function callRoute(routes, name, body, options) {
  const route = routes.find((entry) => entry.path === `/overleaf/api/${name}`)
  assert.ok(route, `route ${name} exists`)
  const res = makeResponse()
  route.handler(makeRequest(body, options), res)
  // dispatch() is fire-and-forget; wait for res.end to land.
  for (let i = 0; i < 200 && res.out.body === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return res.out
}

function fakeService(overrides = {}) {
  const calls = []
  const service = {
    calls,
    async status() {
      calls.push('status')
      return {
        baseUrl: 'https://www.overleaf.com',
        authenticated: true,
        projects: [],
        text: 'ok',
      }
    },
    async credential() {
      return { baseUrl: 'https://www.overleaf.com/', cookie: 'c', csrfToken: 't', userHint: 'me', savedAt: 'now' }
    },
    async readLink() {
      throw new OverleafSyncError('E_NOT_LINKED', 'none')
    },
    async listProjects() {
      calls.push('projects')
      return [{ projectId: 'p1', projectName: 'Paper', localRoot: '/tmp/paper', files: 3, linkedAt: 'now' }]
    },
    async login(input) {
      calls.push(['login', input])
      return { ok: true, baseUrl: input.baseUrl, text: 'ok' }
    },
    async logout() {
      return 'logged out'
    },
    async link(input) {
      calls.push(['link', input])
      return { projectId: input.projectId, projectName: 'Paper', localRoot: '/tmp/paper', createdAt: 'now' }
    },
    async pull(input) {
      calls.push(['pull', input])
      return { projectId: 'p1', files: 1, text: 'pulled' }
    },
    async push(input) {
      calls.push(['push', input])
      return { projectId: 'p1', pushed: [], text: 'dry run' }
    },
    async diff(input) {
      calls.push(['diff', input])
      return { projectId: 'p1', path: input.path, status: 'in-sync', text: 'same' }
    },
    ...overrides,
  }
  return service
}

function fakeSettings({ writable = true, value = { defaultStrategy: 'keep-both', git: { autoInit: true } } } = {}) {
  const state = { value, revision: 3, updates: [] }
  return {
    state,
    writable,
    describe() {
      return [{ ns: 'overleaf-sync', value: state.value, revision: state.revision, schema: {} }]
    },
    async update(ns, patch, expectedRevision) {
      state.updates.push({ ns, patch, expectedRevision })
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        const error = new Error('revision mismatch')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      state.value = { ...state.value, ...patch }
      state.revision += 1
      return { ok: true }
    },
  }
}

test('statusForCode maps the contract table', () => {
  assert.equal(statusForCode('E_AUTH_REQUIRED'), 401)
  assert.equal(statusForCode('E_NOT_LINKED'), 404)
  assert.equal(statusForCode('E_CONFLICT'), 409)
  assert.equal(statusForCode('E_VALIDATION'), 400)
  assert.equal(statusForCode('E_WEIRD'), 500)
})

test('toFailure keeps code, message and hint', () => {
  const { status, body } = toFailure(new OverleafSyncError('E_AUTH_EXPIRED', 'expired', 'login again'))
  assert.equal(status, 401)
  assert.deepEqual(body, { ok: false, code: 'E_AUTH_EXPIRED', message: 'expired', hint: 'login again' })
})

test('readJson rejects oversized and non-object bodies', async () => {
  await assert.rejects(
    () => readJson(makeRequest({ big: 'x'.repeat(300 * 1024) })),
    /exceeds/,
  )
  await assert.rejects(async () => {
    const req = {
      method: 'POST',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('[1,2]')
      },
    }
    await readJson(req)
  }, /JSON object/)
  assert.deepEqual(await readJson(makeRequest(undefined)), {})
})

test('isCrossSite only blocks foreign browser origins', () => {
  assert.equal(isCrossSite({ headers: {} }), false)
  assert.equal(isCrossSite({ headers: { 'sec-fetch-site': 'same-origin' } }), false)
  assert.equal(isCrossSite({ headers: { 'sec-fetch-site': 'cross-site' } }), true)
})

test('settings bridge is read-only without the Settings service', () => {
  const bridge = new SettingsBridge(undefined, { config })
  const view = bridge.describeView()
  assert.equal(view.writable, false)
  assert.equal(view.revision, 0)
  const strategy = view.fields.find((field) => field.key === 'defaultStrategy')
  assert.equal(strategy.value, 'keep-both')
  assert.deepEqual(strategy.options, ['keep-both', 'keep-local', 'keep-remote', 'auto'])
})

test('settings bridge nests a dotted patch and bumps the revision', async () => {
  const settings = fakeSettings()
  const bridge = new SettingsBridge(settings, { config, namespace: 'overleaf-sync' })
  assert.equal(bridge.describeView().revision, 3)
  const view = await bridge.updateView({ 'git.autoInit': false }, 3)
  assert.equal(settings.state.updates.length, 1)
  assert.deepEqual(settings.state.updates[0].patch, { git: { autoInit: false } })
  assert.equal(view.revision, 4)
})

test('settings bridge maps a revision clash onto E_SETTINGS_CONFLICT', async () => {
  const bridge = new SettingsBridge(fakeSettings(), { config, namespace: 'overleaf-sync' })
  await assert.rejects(() => bridge.updateView({ debug: true }, 1), (err) => {
    assert.equal(err.code, 'E_SETTINGS_CONFLICT')
    return true
  })
})

test('settings bridge rejects unknown and mistyped keys before writing', async () => {
  const settings = fakeSettings()
  const bridge = new SettingsBridge(settings, { config, namespace: 'overleaf-sync' })
  await assert.rejects(() => bridge.updateView({ 'not.a.field': 1 }, 3), /not an editable setting/)
  await assert.rejects(() => bridge.updateView({ 'watch.maxOpenDocs': 'many' }, 3), /must be a number/)
  assert.equal(settings.state.updates.length, 0)
})

test('status route answers the GUI shape and survives an unlinked state', async () => {
  const service = fakeService()
  const routes = createOverleafRoutes({
    service,
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const out = await callRoute(routes, 'status', {})
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.value.authenticated, true)
  assert.deepEqual(out.body.value.pending, { localChanges: 0, conflicts: 0 })
  assert.equal(out.body.value.current, undefined)
})

test('cross-site requests are refused before touching the service', async () => {
  const service = fakeService()
  const routes = createOverleafRoutes({
    service,
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const out = await callRoute(routes, 'projects', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(out.status, 403)
  assert.equal(out.body.code, 'E_CROSS_SITE')
  assert.equal(service.calls.includes('projects'), false)
})

test('non-POST methods are refused', async () => {
  const routes = createOverleafRoutes({
    service: fakeService(),
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const out = await callRoute(routes, 'status', {}, { method: 'GET' })
  assert.equal(out.status, 405)
})

test('push needs an explicit confirmation when confirmRemoteWrite is on', async () => {
  const service = fakeService()
  const routes = createOverleafRoutes({
    service,
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const refused = await callRoute(routes, 'push', { dryRun: false })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.code, 'E_CONFIRM_REQUIRED')

  const accepted = await callRoute(routes, 'push', { dryRun: false, confirm: true })
  assert.equal(accepted.status, 200)
  const calls = service.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'push')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1], { dryRun: false })
})

test('dryRun defaults to true so a stray push cannot write', async () => {
  const service = fakeService()
  const routes = createOverleafRoutes({
    service,
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  await callRoute(routes, 'push', {})
  const calls = service.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'push')
  assert.deepEqual(calls[0][1], { dryRun: true })
})

test('login forwards cookie + csrf and never echoes the cookie', async () => {
  const service = fakeService()
  const routes = createOverleafRoutes({
    service,
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const out = await callRoute(routes, 'login', { cookie: 'overleaf_session2=secret', csrfToken: 'csrf' })
  assert.equal(out.status, 200)
  assert.equal(JSON.stringify(out.body).includes('secret'), false)
  const calls = service.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'login')
  assert.deepEqual(calls[0][1], {
    cookie: 'overleaf_session2=secret',
    csrfToken: 'csrf',
    baseUrl: 'https://www.overleaf.com',
  })
})

test('missing required fields come back as E_VALIDATION', async () => {
  const routes = createOverleafRoutes({
    service: fakeService(),
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const out = await callRoute(routes, 'link', {})
  assert.equal(out.status, 400)
  assert.equal(out.body.code, 'E_VALIDATION')
})

test('diff requires an explicit path', async () => {
  const routes = createOverleafRoutes({
    service: fakeService(),
    config,
    settings: new SettingsBridge(undefined, { config }),
    cwd: process.cwd(),
  })
  const out = await callRoute(routes, 'diff', {})
  assert.equal(out.status, 400)
})

test('settings.describe exposes only editable fields and settings.update validates', async () => {
  const settings = fakeSettings()
  const routes = createOverleafRoutes({
    service: fakeService(),
    config,
    settings: new SettingsBridge(settings, { config, namespace: 'overleaf-sync' }),
    cwd: process.cwd(),
  })
  const described = await callRoute(routes, 'settings.describe', {})
  assert.equal(described.body.value.writable, true)
  assert.equal(described.body.value.revision, 3)
  const keys = described.body.value.fields.map((field) => field.key)
  assert.ok(keys.includes('defaultStrategy'))
  assert.ok(keys.includes('git.autoInit'))
  assert.equal(keys.includes('cookie'), false)

  const strategy = described.body.value.fields.find((field) => field.key === 'defaultStrategy')
  assert.equal(strategy.group, 'strategy')
  assert.equal(strategy.label, '冲突策略')
  assert.equal(strategy.default, 'keep-both')
  assert.deepEqual(strategy.options, ['keep-both', 'keep-local', 'keep-remote', 'auto'])
  const maxDocs = described.body.value.fields.find((field) => field.key === 'watch.maxOpenDocs')
  assert.equal(maxDocs.min, 1)
  assert.equal(maxDocs.max, 200)

  const updated = await callRoute(routes, 'settings.update', {
    patch: { defaultStrategy: 'auto' },
    expectedRevision: 3,
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.value.revision, 4)
})
