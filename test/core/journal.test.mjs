import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { pathExists } from '../../lib/core/fsUtil.js'
import { appendJournal } from '../../lib/core/journal.js'
import { projectStateDir } from '../../lib/core/paths.js'

function uniqueProjectId(label) {
  return `test-${label}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanupProject(t, projectId) {
  t.after(async () => {
    await fs.rm(projectStateDir(projectId), { recursive: true, force: true })
  })
}

function journalPath(projectId) {
  return path.join(projectStateDir(projectId), 'journal.ndjson')
}

async function readLines(file) {
  return (await fs.readFile(file, 'utf8'))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

test('appendJournal writes one NDJSON line per entry with ts and payload', async (t) => {
  const id = uniqueProjectId('append')
  cleanupProject(t, id)

  await appendJournal(id, { event: 'sync', docId: 'doc-1', path: 'main.tex', v: 3, ms: 12, ok: true })
  await appendJournal(id, { event: 'pull', code: 'E_DEMO', extra: { nested: [1, 2] } })

  const entries = await readLines(journalPath(id))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].event, 'sync')
  assert.equal(entries[0].docId, 'doc-1')
  assert.equal(entries[0].path, 'main.tex')
  assert.equal(entries[0].v, 3)
  assert.equal(entries[0].ms, 12)
  assert.equal(entries[0].ok, true)
  assert.match(entries[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(entries[1].extra, { nested: [1, 2] })
  assert.equal(entries[1].code, 'E_DEMO')
  assert.ok(Date.parse(entries[1].ts) >= Date.parse(entries[0].ts))

  const raw = await fs.readFile(journalPath(id), 'utf8')
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 2)
})

test('appendJournal is a no-op when disabled', async (t) => {
  const id = uniqueProjectId('disabled')
  cleanupProject(t, id)

  await appendJournal(id, { event: 'ignored' }, { enabled: false })
  assert.equal(await pathExists(journalPath(id)), false)

  await appendJournal(id, { event: 'written' }, { enabled: true })
  assert.equal(await pathExists(journalPath(id)), true)
})

test('appendJournal rotates a >5MB journal down to the retention window', async (t) => {
  const id = uniqueProjectId('rotate')
  cleanupProject(t, id)

  const dir = projectStateDir(id)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'journal.ndjson')
  const pad = 'x'.repeat(1800)
  const oldTs = '2020-01-01T00:00:00.000Z'
  const recentTs = new Date().toISOString()

  const lines = []
  for (let i = 0; i < 3200; i += 1) {
    lines.push(JSON.stringify({ event: 'old', ts: oldTs, pad }))
  }
  lines.push(JSON.stringify({ event: 'recent', ts: recentTs, pad }))
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8')

  assert.ok((await fs.stat(file)).size > 5 * 1024 * 1024)

  await appendJournal(id, { event: 'after-rotation' })

  assert.ok((await fs.stat(file)).size < 5 * 1024 * 1024)
  const kept = await readLines(file)
  assert.deepEqual(kept.map((entry) => entry.event), ['recent', 'after-rotation'])
})
