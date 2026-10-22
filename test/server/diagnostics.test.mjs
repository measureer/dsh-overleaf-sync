import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { describeError, recordDiagnostic } from '../../lib/server/diagnostics.js'

describe('diagnostics', () => {
  let home

  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'overleaf-sync-diag-'))
    process.env.DSH_HOME = home
  })

  after(async () => {
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('appends one JSON line per event under DSH_HOME', async () => {
    recordDiagnostic('unit-test-a', { n: 1 })
    recordDiagnostic('unit-test-b')
    const file = path.join(home, 'overleaf-sync', 'diagnostics.ndjson')
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].event, 'unit-test-a')
    assert.equal(lines[0].n, 1)
    assert.equal(typeof lines[0].at, 'string')
    assert.equal(lines[1].event, 'unit-test-b')
  })

  it('never throws, whatever the payload', () => {
    assert.doesNotThrow(() => recordDiagnostic('weird', { big: { deep: [1, 2, 3] } }))
  })

  it('describeError returns stack text and tolerates non-errors', () => {
    const text = describeError(new Error('boom'))
    assert.match(text, /boom/)
    assert.equal(describeError('plain'), 'plain')
  })
})
