/**
 * Conflict policy: artifacts on disk, `service.conflicts()`, and the three ways
 * to settle one (`keep_local`, `keep_remote`, `merge`).
 *
 * Runs the real filesystem, state store and git; only the socket is fake.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-conflict-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { OverleafSyncService } = await import('../../lib/service.js')
const { resolveConfig } = await import('../../lib/config.js')
const { saveCredential } = await import('../../lib/transport/credentials.js')
const { conflictsDir, linkPath, statePath } = await import('../../lib/core/paths.js')

const BASE_URL = 'https://www.overleaf.com/'
/** What the server holds when the project is first pulled. */
const BASE_TEXT = 'base version\n'
/** What the user types afterwards - different from the baseline, so it counts. */
const LOCAL_TEXT = 'local version\n'
const REMOTE_TEXT = 'remote version\n'

const SNAPSHOT = {
  id: 'p1',
  name: 'Conflicting Project',
  folders: [],
  docs: [{ id: 'd1', name: 'main.tex', parentFolderId: null }],
  files: [],
}

function fakeTransport(texts) {
  const state = { d1: { text: texts.d1, version: 5 } }
  const updates = []
  return {
    state,
    updates,
    async joinProject() {
      return structuredClone(SNAPSHOT)
    },
    async joinDoc(docId) {
      return { docId, version: state[docId].version, text: state[docId].text }
    },
    async leaveDoc() {},
    async applyOtUpdate(docId, version, ops) {
      assert.equal(version, state[docId].version, 'push must build on the current version')
      let next = state[docId].text
      for (const op of ops) {
        if (op.d != null) next = next.slice(0, op.p) + next.slice(op.p + op.d.length)
        if (op.i != null) next = next.slice(0, op.p) + op.i + next.slice(op.p)
      }
      state[docId].text = next
      state[docId].version += 1
      updates.push({ docId, version: state[docId].version })
      return { version: state[docId].version }
    },
    onRemoteUpdate() {
      return () => {}
    },
    onConnectionState() {
      return () => {}
    },
    async close() {},
  }
}

async function setup(t, options = {}) {
  const localRoot = path.join(home, 'Overleaf', 'Conflicting Project')
  await saveCredential({
    baseUrl: BASE_URL,
    cookie: 'overleaf_session2=test-session',
    csrfToken: 'test-csrf',
    userHint: 'tester',
  })
  const link = {
    schemaVersion: 1,
    projectId: 'p1',
    projectName: 'Conflicting Project',
    localRoot,
    include: [],
    exclude: [],
    strategy: options.strategy ?? 'auto',
    autoPush: true,
    throttleMs: 400,
    binary: 'download-only',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await fs.mkdir(path.dirname(linkPath('p1')), { recursive: true })
  await fs.writeFile(linkPath('p1'), JSON.stringify(link, null, 2))

  const transport = fakeTransport({ d1: BASE_TEXT })
  const config = resolveConfig({
    localRootPattern: path.join(home, 'Overleaf', '{project}'),
    git: { autoInit: false },
  })
  const service = new OverleafSyncService(config, { createTransport: async () => transport })
  t.after(async () => {
    await fs.rm(localRoot, { recursive: true, force: true }).catch(() => {})
    await fs.rm(conflictsDir('p1'), { recursive: true, force: true }).catch(() => {})
  })
  return { service, transport, localRoot }
}

const ctx = () => ({ cwd: home, sessionId: 'test-session' })

/** Pull, edit locally, then move the remote copy — the classic divergence. */
async function createConflict(service, transport, localRoot) {
  await service.pull({ projectId: 'p1' }, ctx())
  await fs.writeFile(path.join(localRoot, 'main.tex'), LOCAL_TEXT, 'utf8')
  transport.state.d1.text = REMOTE_TEXT
  transport.state.d1.version = 6
  const summary = await service.pull({ projectId: 'p1' }, ctx())
  assert.equal(summary.conflicts.length, 1, 'the second pull must report one conflict')
  return summary
}

test('a diverged pull keeps the local file and drops the remote copy next to it', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await createConflict(service, transport, localRoot)

  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), LOCAL_TEXT)
  const names = await fs.readdir(localRoot)
  const copy = names.find((name) => /^main\.remote-.+\.tex$/.test(name))
  assert.ok(copy, `expected a remote copy, got ${names.join(', ')}`)
  assert.equal(await fs.readFile(path.join(localRoot, copy), 'utf8'), REMOTE_TEXT)

  const summary = await service.conflicts({ projectId: 'p1' })
  assert.equal(summary.conflicts.length, 1)
  assert.equal(summary.conflicts[0].path, 'main.tex')
  assert.equal(summary.conflicts[0].kind, 'doc')
  assert.equal(summary.conflicts[0].reason, 'both-changed')
})

test('keep_remote overwrites the local file, archives the old copy and clears the record', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await createConflict(service, transport, localRoot)

  const summary = await service.resolve(
    { projectId: 'p1', path: 'main.tex', choice: 'keep_remote' },
    ctx(),
  )

  assert.equal(summary.resolved.length, 1)
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), REMOTE_TEXT)
  const state = JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))
  assert.equal(state.files['main.tex'].remoteVersion, 6)
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [])
})

test('keep_local pushes the local text and bumps the baseline', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await createConflict(service, transport, localRoot)

  await service.resolve({ projectId: 'p1', path: 'main.tex', choice: 'keep_local' }, ctx())

  assert.equal(transport.updates.length, 1, 'keep_local must push to Overleaf')
  assert.equal(transport.state.d1.text, LOCAL_TEXT)
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), LOCAL_TEXT)
  const state = JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))
  assert.equal(state.files['main.tex'].remoteVersion, transport.state.d1.version)
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [])
})

test('merge writes conflict markers and keeps both baselines in step', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await createConflict(service, transport, localRoot)

  await service.resolve({ projectId: 'p1', path: 'main.tex', choice: 'merge' }, ctx())

  const merged = await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8')
  assert.match(merged, /^<<<<<<< local/m)
  assert.match(merged, /^=======/m)
  assert.match(merged, /^>>>>>>> remote/m)
  assert.match(merged, /local version/)
  assert.match(merged, /remote version/)
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [])
})

test('all: true settles every recorded conflict', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await createConflict(service, transport, localRoot)

  const summary = await service.resolve({ projectId: 'p1', all: true, choice: 'keep_remote' }, ctx())

  assert.equal(summary.resolved.length, 1)
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), REMOTE_TEXT)
})

test('resolve without path or all is rejected', async (t) => {
  const { service } = await setup(t)
  await assert.rejects(
    () => service.resolve({ projectId: 'p1', choice: 'keep_local' }, ctx()),
    /No conflict selected|pass `path`/i,
  )
})
