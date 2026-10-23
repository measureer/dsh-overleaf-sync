/**
 * `WatchSession` end to end: a real temp directory, a real state store and a
 * fake socket. Both directions are exercised — remote edits land on disk and
 * local edits go back through `applyOtUpdate`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-watch-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { WatchSession } = await import('../../lib/watch/session.js')
const { resolveConfig } = await import('../../lib/config.js')
const { statePath } = await import('../../lib/core/paths.js')

const PROJECT_ID = 'watch-1'
let projectSeq = 0
const SNAPSHOT = {
  id: PROJECT_ID,
  name: 'Watched Project',
  folders: [],
  docs: [{ id: 'd1', name: 'main.tex', parentFolderId: null }],
  files: [],
}

function applyOpsToText(text, ops) {
  let next = text
  for (const op of ops) {
    if (op.d != null) next = next.slice(0, op.p) + next.slice(op.p + op.d.length)
    if (op.i != null) next = next.slice(0, op.p) + op.i + next.slice(op.p)
  }
  return next
}

function fakeTransport(text) {
  const state = { text, version: 4 }
  const callbacks = []
  return {
    state,
    updates: [],
    callbacks,
    async joinProject() {
      return structuredClone(SNAPSHOT)
    },
    async joinDoc() {
      return { docId: 'd1', version: state.version, text: state.text }
    },
    async leaveDoc() {},
    async applyOtUpdate(docId, version, ops) {
      assert.equal(version, state.version)
      state.text = applyOpsToText(state.text, ops)
      state.version += 1
      this.updates.push({ docId, version: state.version, ops })
      return { version: state.version }
    },
    onRemoteUpdate(cb) {
      callbacks.push({ type: 'remote', cb })
      return () => {}
    },
    onConnectionState(cb) {
      callbacks.push({ type: 'state', cb })
      return () => {}
    },
    async close() {},
  }
}

/** The store flushes ~300 ms after a change; `undefined` while it has not yet. */
async function readState(projectId) {
  try {
    return JSON.parse(await fs.readFile(statePath(projectId), 'utf8'))
  } catch {
    return undefined
  }
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function setup(t, text = 'hello\n') {
  const projectId = `watch-${++projectSeq}`
  const localRoot = path.join(home, `watch-root-${projectId}`)
  await fs.mkdir(localRoot, { recursive: true })
  await fs.writeFile(path.join(localRoot, 'main.tex'), text, 'utf8')
  t.after(async () => {
    await fs.rm(localRoot, { recursive: true, force: true }).catch(() => {})
  })

  const link = {
    schemaVersion: 1,
    projectId,
    projectName: 'Watched Project',
    localRoot,
    include: [],
    exclude: [],
    strategy: 'auto',
    autoPush: true,
    throttleMs: 60,
    binary: 'download-only',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const transport = fakeTransport(text)
  const config = resolveConfig({})
  const session = new WatchSession({
    link,
    transport,
    config,
    docs: [{ docId: 'd1', relPath: 'main.tex' }],
  })
  return { session, transport, localRoot, projectId }
}

test('a remote update is written to disk and recorded in the baseline', async (t) => {
  const { session, transport, localRoot, projectId } = await setup(t)
  await session.start()
  t.after(() => session.stop('test finished'))

  const remote = transport.callbacks.find((entry) => entry.type === 'remote')
  assert.ok(remote, 'session must subscribe to remote updates')
  remote.cb({ docId: 'd1', version: 5, ops: [{ p: 6, i: 'world\n' }] })

  await waitFor(
    async () => (await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8')) === 'hello\nworld\n',
    'remote update on disk',
  )

  await waitFor(async () => (await readState(projectId))?.files['main.tex']?.remoteVersion === 5, 'baseline flush')
  const state = await readState(projectId)
  assert.equal(state.files['main.tex'].remoteVersion, 5)
  assert.ok(
    session.recentEvents.some((event) => event.type === 'remote'),
    'the remote event must be visible in the panel',
  )
})

test('a local file change is pushed as an OT update', async (t) => {
  const { session, transport, localRoot, projectId } = await setup(t)
  await session.start()
  t.after(() => session.stop('test finished'))

  await fs.writeFile(path.join(localRoot, 'main.tex'), 'hello local\n', 'utf8')

  await waitFor(
    async () => {
      if (transport.updates.length === 0) return false
      return (await readState(projectId))?.files['main.tex'] !== undefined
    },
    'local push',
  )

  assert.equal(transport.state.text, 'hello local\n')
  assert.ok(
    session.recentEvents.some((event) => event.type === 'local'),
    'the push must be visible in the panel',
  )
})

test('stop() detaches the watcher and marks the session stopped', async (t) => {
  const { session } = await setup(t)
  await session.start()
  assert.equal(session.isRunning, true)

  await session.stop('test finished')

  assert.equal(session.isRunning, false)
  assert.ok(session.recentEvents.some((event) => event.type === 'stopped'))
})
