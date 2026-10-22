/**
 * End-to-end policy test: real filesystem, real state store, real git — fake socket.
 *
 * The transport is the only injected dependency, so everything the user cares
 * about (paths, conflict copies, state.json, the initial commit) runs for real.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// `stateRoot()` is derived from os.homedir() on every call, so redirecting the
// home directory here keeps the developer's ~/.dsh/overleaf-sync untouched.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { OverleafSyncService } = await import('../../lib/service.js')
const { resolveConfig } = await import('../../lib/config.js')
const { saveCredential } = await import('../../lib/transport/credentials.js')
const { linkPath, statePath } = await import('../../lib/core/paths.js')

const BASE_URL = 'https://www.overleaf.com/'

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}'
const INTRO_TEX = 'This is the introduction.'

const SNAPSHOT = {
  id: 'p1',
  name: 'Demo Project',
  folders: [{ id: 'f1', name: 'chapters', parentFolderId: null }],
  docs: [
    { id: 'd1', name: 'main.tex', parentFolderId: null },
    { id: 'd2', name: 'intro.tex', parentFolderId: 'f1' },
  ],
  files: [],
}

/** A transport that speaks the interface but never touches the network. */
function fakeTransport(initial = { d1: MAIN_TEX, d2: INTRO_TEX }) {
  const texts = { ...initial }
  const versions = { d1: 3, d2: 7 }
  const updates = []
  return {
    texts,
    versions,
    updates,
    async joinProject() {
      return structuredClone(SNAPSHOT)
    },
    async joinDoc(docId) {
      return { docId, version: versions[docId], text: texts[docId] }
    },
    async leaveDoc() {},
    async applyOtUpdate(docId, version, ops) {
      assert.equal(version, versions[docId], 'push must be based on the current server version')
      let next = texts[docId]
      for (const op of ops) {
        if (op.d != null) next = next.slice(0, op.p) + next.slice(op.p + op.d.length)
        if (op.i != null) next = next.slice(0, op.p) + op.i + next.slice(op.p)
      }
      texts[docId] = next
      versions[docId] = version + 1
      updates.push({ docId, version: versions[docId], ops })
      return { version: versions[docId] }
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
  const localRoot = path.join(home, 'Overleaf', 'Demo Project')
  await saveCredential({
    baseUrl: BASE_URL,
    cookie: 'overleaf_session2=test-session',
    csrfToken: 'test-csrf',
    userHint: 'tester',
  })
  const link = {
    schemaVersion: 1,
    projectId: 'p1',
    projectName: 'Demo Project',
    localRoot,
    include: ['**/*.tex'],
    exclude: ['*.pdf'],
    strategy: options.strategy ?? 'auto',
    autoPush: true,
    throttleMs: 400,
    binary: 'download-only',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await fs.mkdir(path.dirname(linkPath('p1')), { recursive: true })
  await fs.writeFile(linkPath('p1'), JSON.stringify(link, null, 2))

  const transport = fakeTransport(options.texts)
  const config = resolveConfig({
    localRootPattern: path.join(home, 'Overleaf', '{project}'),
    git: { autoInit: options.gitInit ?? true },
  })
  const service = new OverleafSyncService(config, {
    createTransport: async () => transport,
  })
  t.after(async () => {
    await fs.rm(localRoot, { recursive: true, force: true }).catch(() => {})
  })
  return { service, transport, localRoot }
}

const ctx = () => ({ cwd: home, sessionId: 'test-session' })

test('pull writes the remote tree, records state.json and creates a git repository', async (t) => {
  const { service, localRoot } = await setup(t)

  const summary = await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(summary.pulled.sort(), ['chapters/intro.tex', 'main.tex'])
  assert.deepEqual(summary.conflicts, [])
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), MAIN_TEX)
  assert.equal(await fs.readFile(path.join(localRoot, 'chapters', 'intro.tex'), 'utf8'), INTRO_TEX)

  const state = JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))
  assert.equal(state.files['main.tex'].docId, 'd1')
  assert.equal(state.files['main.tex'].remoteVersion, 3)

  assert.equal(summary.git?.mode, 'own')
  assert.equal(summary.git?.created, true)
  const log = execFileSync('git', ['-C', localRoot, 'log', '--oneline'], { encoding: 'utf8' })
  assert.match(log, /chore: import "Demo Project" from Overleaf/)
  const status = execFileSync('git', ['-C', localRoot, 'status', '--porcelain'], { encoding: 'utf8' })
  assert.equal(status.trim(), '', 'the initial import must be committed cleanly')
})

test('a second pull is a no-op when nothing changed on either side', async (t) => {
  const { service } = await setup(t)
  await service.pull({ projectId: 'p1' }, ctx())

  const second = await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(second.pulled, [])
  assert.deepEqual(second.conflicts, [])
  assert.deepEqual(second.unchanged.sort(), ['chapters/intro.tex', 'main.tex'])
})

test('push sends only the local edits and advances the stored version', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await service.pull({ projectId: 'p1' }, ctx())
  await fs.writeFile(path.join(localRoot, 'main.tex'), `${MAIN_TEX}\n% local note`)

  const summary = await service.push({ projectId: 'p1' }, ctx())

  assert.deepEqual(summary.pushed, ['main.tex'])
  assert.equal(transport.texts.d1, `${MAIN_TEX}\n% local note`)
  assert.equal(transport.updates.length, 1)
  assert.equal(transport.updates[0].ops.length, 1)
  assert.equal(transport.updates[0].ops[0].i, '\n% local note')

  const state = JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))
  assert.equal(state.files['main.tex'].remoteVersion, 4)
})

test('a pull that collides with a local edit keeps both sides (strategy auto)', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await service.pull({ projectId: 'p1' }, ctx())
  await fs.writeFile(path.join(localRoot, 'main.tex'), 'local draft')

  // Remote changed in the meantime: both sides moved since the baseline.
  transport.texts.d1 = `${MAIN_TEX}\n% remote note`
  transport.versions.d1 = 4

  const summary = await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(summary.conflicts, ['main.tex'])
  const dir = await fs.readdir(localRoot)
  const conflictCopies = dir.filter((name) => /^main\.remote-.+\.tex$/.test(name))
  assert.equal(conflictCopies.length, 1, `expected one conflict copy, got ${dir.join(', ')}`)
  assert.equal(
    await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'),
    'local draft',
    'the local edit stays in place; the remote text goes to the conflict copy',
  )
  assert.equal(
    await fs.readFile(path.join(localRoot, conflictCopies[0]), 'utf8'),
    `${MAIN_TEX}\n% remote note`,
    'the conflict copy holds the remote text',
  )
})
