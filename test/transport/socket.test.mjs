import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as transport from '../../lib/transport/index.js'
import {
  buildUpdate,
  nextVersionFromAck,
  normalizeProjectTree,
  parseRemoteUpdate,
} from '../../lib/transport/socket.js'

describe('buildUpdate (UpdateSchema)', () => {
  it('builds op/v/lastV/meta with the client source and a timestamp', () => {
    const ops = [
      { p: 3, i: 'x' },
      { p: 0, d: 'y' },
    ]
    const before = Date.now()
    const update = buildUpdate('doc-1', 7, ops, 'client-1')
    const after = Date.now()

    assert.equal(update.doc, 'doc-1')
    assert.equal(update.v, 7)
    assert.equal(update.lastV, 7)
    assert.deepEqual(update.op, ops)
    assert.equal(update.meta.source, 'client-1')
    assert.equal(update.meta.user_id, undefined)
    assert.ok(update.meta.ts >= before && update.meta.ts <= after)
  })

  it('includes user_id and an explicit timestamp when given', () => {
    const update = buildUpdate('doc', 0, [], 'src', 'user-9', 1234)
    assert.deepEqual(update.meta, { source: 'src', ts: 1234, user_id: 'user-9' })
    assert.deepEqual(update.op, [])
  })

  it('copies ops and keeps only p/i/d', () => {
    const ops = [{ p: 0, i: 'a', u: true }]
    const update = buildUpdate('doc', 1, ops, 'src')
    assert.deepEqual(update.op, [{ p: 0, i: 'a' }])
    assert.notEqual(update.op, ops)
    assert.notEqual(update.op[0], ops[0])
  })

  it('rejects an invalid version and malformed ops', () => {
    assert.throws(
      () => buildUpdate('doc', -1, [], 'src'),
      (error) => error.code === 'E_TRANSPORT',
    )
    assert.throws(
      () => buildUpdate('doc', 1.5, [], 'src'),
      (error) => error.code === 'E_TRANSPORT',
    )
    for (const bad of [
      [{ p: 'x' }],
      [null],
      [{ p: 0 }],
      [{ p: 0, i: '' }],
      [{ p: -1, i: 'x' }],
    ]) {
      assert.throws(
        () => buildUpdate('doc', 2, bad, 'src'),
        (error) => error.code === 'E_TRANSPORT',
      )
    }
  })
})

describe('nextVersionFromAck', () => {
  it('reads the new version from an ack number or update object', () => {
    assert.equal(nextVersionFromAck([8], 7, true), 8)
    assert.equal(nextVersionFromAck([{ v: 8 }], 7, true), 8)
    assert.equal(nextVersionFromAck([{ version: 8 }], 7, true), 8)
    assert.equal(nextVersionFromAck([{ v: 10 }], 9, false), 10)
  })

  it('falls back to baseVersion (+1 when an op was sent)', () => {
    assert.equal(nextVersionFromAck([], 7, true), 8)
    assert.equal(nextVersionFromAck([], 7, false), 7)
    assert.equal(nextVersionFromAck([undefined, 'junk'], 3, true), 4)
    assert.equal(nextVersionFromAck([Number.NaN], 3, false), 3)
  })
})

describe('normalizeProjectTree', () => {
  const project = {
    _id: 'proj-1',
    name: 'Thesis',
    rootFolder: [
      {
        _id: 'root',
        name: 'root',
        docs: [
          { _id: 'doc-root', name: 'main.tex' },
          { _id: 'doc-gone', name: 'old.tex', deleted: true },
        ],
        fileRefs: [{ _id: 'file-root', name: 'refs.bib' }],
        folders: [
          {
            _id: 'folder-a',
            name: 'chapters',
            docs: [{ _id: 'doc-a', name: 'intro.tex' }],
            fileRefs: [{ _id: 'file-a', name: 'figure.png' }],
            folders: [{ _id: 'folder-b', name: 'deep', docs: [{ _id: 'doc-b', name: 'deep.tex' }] }],
          },
          {
            _id: 'folder-gone',
            name: 'trash',
            archived: true,
            docs: [{ _id: 'doc-hidden', name: 'x.tex' }],
          },
        ],
      },
    ],
  }

  it('flattens rootFolder recursively with null parents at the root', () => {
    const snapshot = normalizeProjectTree(project, 'fallback')

    assert.equal(snapshot.id, 'proj-1')
    assert.equal(snapshot.name, 'Thesis')

    assert.deepEqual(snapshot.folders, [
      { id: 'folder-a', name: 'chapters', parentFolderId: null },
      { id: 'folder-b', name: 'deep', parentFolderId: 'folder-a' },
    ])
    assert.deepEqual(snapshot.docs, [
      { id: 'doc-root', name: 'main.tex', parentFolderId: null },
      { id: 'doc-a', name: 'intro.tex', parentFolderId: 'folder-a' },
      { id: 'doc-b', name: 'deep.tex', parentFolderId: 'folder-b' },
    ])
    assert.deepEqual(snapshot.files, [
      { id: 'file-root', name: 'refs.bib', parentFolderId: null },
      { id: 'file-a', name: 'figure.png', parentFolderId: 'folder-a' },
    ])
  })

  it('skips deleted and archived entities together with their subtrees', () => {
    const snapshot = normalizeProjectTree(project, 'fallback')
    const ids = [...snapshot.folders, ...snapshot.docs, ...snapshot.files].map((node) => node.id)
    assert.ok(!ids.includes('doc-gone'))
    assert.ok(!ids.includes('folder-gone'))
    assert.ok(!ids.includes('doc-hidden'))
  })

  it('accepts a single rootFolder object and id-based projects', () => {
    const snapshot = normalizeProjectTree(
      { id: 'p', name: 'N', rootFolder: { id: 'r', docs: [{ id: 'd', name: 'a.tex' }] } },
      'p',
    )
    assert.equal(snapshot.id, 'p')
    assert.deepEqual(snapshot.docs, [{ id: 'd', name: 'a.tex', parentFolderId: null }])
  })

  it('falls back to an empty snapshot for malformed input', () => {
    for (const bad of [undefined, null, 'x', 42, {}]) {
      const snapshot = normalizeProjectTree(bad, 'proj-1')
      assert.equal(snapshot.id, 'proj-1')
      assert.equal(snapshot.name, 'project')
      assert.deepEqual(snapshot.folders, [])
      assert.deepEqual(snapshot.docs, [])
      assert.deepEqual(snapshot.files, [])
    }
  })
})

describe('parseRemoteUpdate', () => {
  it('maps UpdateSchema to RemoteUpdate and keeps the source', () => {
    const parsed = parseRemoteUpdate({
      doc: 'd1',
      v: 5,
      op: [{ p: 0, i: 'a' }],
      lastV: 4,
      meta: { source: 'other-client', ts: 1 },
    })
    assert.deepEqual(parsed, {
      update: { docId: 'd1', version: 5, ops: [{ p: 0, i: 'a' }] },
      source: 'other-client',
    })
  })

  it('treats a missing op array as no ops', () => {
    assert.deepEqual(parseRemoteUpdate({ doc: 'd', v: 2 }), {
      update: { docId: 'd', version: 2, ops: [] },
    })
  })

  it('returns undefined for malformed payloads', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { doc: 'd' },
      { v: 1 },
      { doc: 'd', v: 1, op: [{ i: 'no position' }] },
      { doc: '', v: 1 },
    ]) {
      assert.equal(parseRemoteUpdate(bad), undefined)
    }
  })
})

describe('transport index exports', () => {
  it('exposes the factory, classes and helpers', () => {
    assert.equal(typeof transport.createTransport, 'function')
    assert.equal(typeof transport.OverleafHttp, 'function')
    assert.equal(typeof transport.OverleafSocket, 'function')
    assert.equal(typeof transport.loadCredential, 'function')
    assert.equal(typeof transport.saveCredential, 'function')
    assert.equal(typeof transport.clearCredential, 'function')
    assert.equal(typeof transport.linesToText, 'function')
    assert.equal(typeof transport.textToLines, 'function')
  })
})
