import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { countPendingLocalChanges, isUnchanged } from '../../lib/server/pending.js'
import { normalizeEol, sha256 } from '../../lib/core/fsUtil.js'
import { sha256Bytes } from '../../lib/core/files.js'

/** A baseline entry for a text document, hashed the way `pull` hashes it. */
function docEntry(text) {
  const hash = sha256(normalizeEol(text))
  return {
    docId: 'd1',
    remoteVersion: 3,
    remoteHash: hash,
    localHash: hash,
    syncedAt: new Date(0).toISOString(),
    origin: 'remote',
    kind: 'doc',
  }
}

/** A baseline entry for a pulled binary upload. */
function fileEntry(bytes) {
  const hash = sha256Bytes(bytes)
  return {
    docId: 'f1',
    remoteVersion: 0,
    remoteHash: hash,
    localHash: hash,
    syncedAt: new Date(0).toISOString(),
    origin: 'remote',
    kind: 'file',
  }
}

test('a freshly pulled tree reports no pending changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pending-'))
  try {
    await writeFile(path.join(root, 'main.tex'), 'hello\nworld\n', 'utf8')
    await writeFile(path.join(root, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
    const state = {
      files: {
        'main.tex': docEntry('hello\nworld\n'),
        'figure.png': fileEntry(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])),
      },
    }
    assert.equal(await countPendingLocalChanges(state, root), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('binary files must be compared over raw bytes, not UTF-8 text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pending-'))
  try {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80])
    await writeFile(path.join(root, 'photo.jpg'), bytes)
    const state = { files: { 'photo.jpg': fileEntry(bytes) } }
    assert.equal(await countPendingLocalChanges(state, root), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy entries without kind still match their byte hash', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10])
  const entry = fileEntry(bytes)
  delete entry.kind
  assert.equal(isUnchanged(entry, bytes), true)
  assert.equal(isUnchanged(entry, Buffer.from([0x01, 0x02])), false)
})

test('edited, deleted and ignored files are counted correctly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pending-'))
  try {
    await writeFile(path.join(root, 'kept.tex'), 'same\n', 'utf8')
    await writeFile(path.join(root, 'edited.tex'), 'changed\n', 'utf8')
    await writeFile(path.join(root, 'ignored.aux'), 'x\n', 'utf8')
    const state = {
      files: {
        'kept.tex': docEntry('same\n'),
        'edited.tex': docEntry('original\n'),
        'deleted.tex': docEntry('gone\n'),
        'ignored.aux': docEntry('other\n'),
      },
    }
    assert.equal(await countPendingLocalChanges(state, root), 3)
    assert.equal(
      await countPendingLocalChanges(state, root, (rel) => rel.endsWith('.aux')),
      2,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('untracked local files never count as pending', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pending-'))
  try {
    await writeFile(path.join(root, 'main.tex'), 'ok\n', 'utf8')
    await writeFile(path.join(root, '.gitattributes'), '* text=auto\n', 'utf8')
    const state = { files: { 'main.tex': docEntry('ok\n') } }
    assert.equal(await countPendingLocalChanges(state, root), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
