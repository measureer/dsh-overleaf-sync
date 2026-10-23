import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createEventsRoute, frame, signature } from '../../lib/server/events.js'

/** Minimal `IncomingMessage`: the route only listens for `close`. */
function makeRequest(method = 'GET') {
  const req = new EventEmitter()
  req.method = method
  return req
}

/** Minimal `ServerResponse` that records writes and can be closed. */
function makeResponse() {
  const res = new EventEmitter()
  res.status = 0
  res.headers = {}
  res.chunks = []
  res.ended = false
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.flushHeaders = () => {}
  res.write = (chunk) => {
    res.chunks.push(String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(String(chunk))
    res.ended = true
    res.emit('close')
  }
  return res
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function tempRoot(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'overleaf-events-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('frame() is a well-formed SSE message', () => {
  assert.equal(frame('status', { seq: 3 }), 'event: status\ndata: {"seq":3}\n\n')
})

test('signature() is stable and moves when a watched file changes', async (t) => {
  const root = await tempRoot(t)
  const project = path.join(root, 'p1')
  await writeFile(path.join(project, 'link.json'), '{}').catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, 'link.json'), '{}')
  })

  const first = await signature(root)
  assert.equal(await signature(root), first)

  await writeFile(path.join(project, 'journal.ndjson'), '{"event":"pull"}\n')
  assert.notEqual(await signature(root), first)

  assert.equal(await signature(path.join(root, 'missing')), '')
})

test('the stream answers POST with a 405 envelope', async () => {
  const route = createEventsRoute({ root: () => path.join(tmpdir(), 'nowhere') })
  const res = makeResponse()
  await route.handler(makeRequest('POST'), res)
  assert.equal(res.status, 405)
  assert.equal(res.body, undefined)
  assert.match(res.chunks.join(''), /E_VALIDATION/)
})

test('the stream sends ready, then status once the state root changes', async (t) => {
  const root = await tempRoot(t)
  const project = path.join(root, 'p1')
  await writeFile(path.join(root, '.keep'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'state.json'), '{"files":{}}')

  const route = createEventsRoute({ root: () => root, pollMs: 20, heartbeatMs: 60 })
  const res = makeResponse()
  await route.handler(makeRequest('GET'), res)

  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  const text = () => res.chunks.join('')
  assert.match(text(), /retry: 3000/)
  assert.match(text(), /event: ready\ndata: \{"seq":0\}/)

  await writeFile(path.join(project, 'journal.ndjson'), '{"event":"pull"}\n')
  for (let i = 0; i < 100 && !text().includes('event: status'); i += 1) await sleep(10)
  assert.match(text(), /event: status\ndata: \{"seq":1\}/)

  // A heartbeat comment keeps proxies from idling the connection out.
  for (let i = 0; i < 100 && !text().includes(': ping'); i += 1) await sleep(10)
  assert.match(text(), /: ping/)

  // Closing the response stops both timers.
  res.emit('close')
  const before = res.chunks.length
  await sleep(80)
  assert.equal(res.chunks.length, before)
})
