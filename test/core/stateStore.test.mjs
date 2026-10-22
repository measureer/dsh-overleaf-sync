import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../../lib/core/fsUtil.js'
import { projectStateDir, statePath } from '../../lib/core/paths.js'
import {
  compareBaseline,
  emptyProjectState,
  readProjectState,
  StateStore,
  writeProjectState,
} from '../../lib/core/stateStore.js'

function uniqueProjectId(label) {
  return `test-${label}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanupProject(t, projectId) {
  t.after(async () => {
    await fs.rm(projectStateDir(projectId), { recursive: true, force: true })
  })
}

const BASE_HASH = sha256('base\n')

test('compareBaseline covers the whole truth table', () => {
  const baseline = {
    docId: 'doc-1',
    remoteVersion: 3,
    remoteHash: sha256('remote\n'),
    localHash: BASE_HASH,
    syncedAt: '2026-01-01T00:00:00.000Z',
    origin: 'remote',
  }

  // no baseline: both sides count as changed
  assert.equal(compareBaseline(undefined, { localHash: BASE_HASH, remoteVersion: 3 }), 'both')
  // identical: no change
  assert.equal(compareBaseline(baseline, { localHash: BASE_HASH, remoteVersion: 3 }), 'none')
  // local content changed only
  assert.equal(compareBaseline(baseline, { localHash: sha256('edited\n'), remoteVersion: 3 }), 'local')
  // remote version bumped only
  assert.equal(compareBaseline(baseline, { localHash: BASE_HASH, remoteVersion: 4 }), 'remote')
  // both sides changed
  assert.equal(compareBaseline(baseline, { localHash: sha256('edited\n'), remoteVersion: 4 }), 'both')
})

test('readProjectState returns undefined for missing or corrupted JSON', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ol-state-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const missingId = uniqueProjectId('missing')
  cleanupProject(t, missingId)
  assert.equal(await readProjectState(missingId), undefined)

  const brokenId = uniqueProjectId('broken')
  cleanupProject(t, brokenId)
  await fs.mkdir(projectStateDir(brokenId), { recursive: true })
  await fs.writeFile(statePath(brokenId), '{ "schemaVersion": 1, "files": { broken', 'utf8')
  assert.equal(await readProjectState(brokenId), undefined)

  const wrongShapeId = uniqueProjectId('shape')
  cleanupProject(t, wrongShapeId)
  await fs.mkdir(projectStateDir(wrongShapeId), { recursive: true })
  await fs.writeFile(statePath(wrongShapeId), '{"schemaVersion":1,"files":[]}', 'utf8')
  assert.equal(await readProjectState(wrongShapeId), undefined)
  await fs.writeFile(statePath(wrongShapeId), '{"hello":"world"}', 'utf8')
  assert.equal(await readProjectState(wrongShapeId), undefined)
})

test('writeProjectState round-trips state atomically and refreshes updatedAt', async (t) => {
  const id = uniqueProjectId('roundtrip')
  cleanupProject(t, id)

  const state = emptyProjectState(id, 'C:/papers/demo')
  state.updatedAt = '2000-01-01T00:00:00.000Z'
  state.files['main.tex'] = {
    docId: 'doc-main',
    remoteVersion: 7,
    remoteHash: sha256('remote main\n'),
    localHash: sha256('local main\n'),
    syncedAt: '2026-01-01T00:00:00.000Z',
    origin: 'remote',
  }
  state.files['sections/intro.tex'] = {
    docId: 'doc-intro',
    remoteVersion: 2,
    localHash: sha256('intro\n'),
    syncedAt: '2026-01-02T00:00:00.000Z',
    origin: 'local',
  }
  state.filesMissing = {
    'old/gone.tex': { docId: 'doc-gone', deletedAt: '2026-01-03T00:00:00.000Z' },
  }

  await writeProjectState(state)

  const onDisk = await fs.readFile(statePath(id), 'utf8')
  assert.ok(onDisk.length > 0)
  assert.equal((await fs.readdir(projectStateDir(id))).sort().join(','), 'state.json')
  assert.notEqual(state.updatedAt, '2000-01-01T00:00:00.000Z')

  const loaded = await readProjectState(id)
  assert.ok(loaded)
  assert.equal(loaded.schemaVersion, state.schemaVersion)
  assert.equal(loaded.localRoot, 'C:/papers/demo')
  assert.equal(loaded.updatedAt, state.updatedAt)
  assert.deepEqual(loaded.files, state.files)
  assert.deepEqual(loaded.filesMissing, state.filesMissing)
})

test('StateStore exposes get/set/remove/compare and persists through save()', async (t) => {
  const id = uniqueProjectId('store')
  cleanupProject(t, id)
  const root = 'C:/papers/store-demo'

  const store = await StateStore.load(id, root)
  assert.deepEqual(store.state.files, {})
  assert.equal(store.state.localRoot, root)
  assert.equal(store.get('main.tex'), undefined)
  assert.equal(store.compare('main.tex', { localHash: BASE_HASH, remoteVersion: 1 }), 'both')

  const main = {
    docId: 'doc-main',
    remoteVersion: 5,
    remoteHash: sha256('remote\n'),
    localHash: BASE_HASH,
    syncedAt: '2026-02-01T00:00:00.000Z',
    origin: 'remote',
  }
  store.set('main.tex', main)
  assert.deepEqual(store.get('main.tex'), main)
  assert.equal(store.compare('main.tex', { localHash: BASE_HASH, remoteVersion: 5 }), 'none')
  assert.equal(store.compare('main.tex', { localHash: sha256('x'), remoteVersion: 5 }), 'local')

  store.set('a\\b.tex', { docId: 'doc-b', remoteVersion: 1, localHash: BASE_HASH, syncedAt: main.syncedAt })
  assert.ok(store.get('a/b.tex'))
  store.remove('a/b.tex')
  assert.equal(store.get('a/b.tex'), undefined)

  await store.save()

  const reloaded = await StateStore.load(id, root)
  assert.deepEqual(reloaded.get('main.tex'), main)
  assert.equal(reloaded.state.localRoot, root)
  assert.equal(reloaded.state.filesMissing, undefined)
})

test('StateStore.load tolerates corrupt state and adopts the new localRoot', async (t) => {
  const id = uniqueProjectId('recover')
  cleanupProject(t, id)

  await fs.mkdir(projectStateDir(id), { recursive: true })
  await fs.writeFile(statePath(id), 'not json at all', 'utf8')
  const recovered = await StateStore.load(id, 'C:/new/root')
  assert.deepEqual(recovered.state.files, {})
  assert.equal(recovered.state.localRoot, 'C:/new/root')

  const moved = await StateStore.load(id, 'C:/other/root')
  assert.equal(moved.state.localRoot, 'C:/other/root')
})
