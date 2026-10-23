/**
 * `GET /overleaf/events` — the sidebar's change feed (design §14.4.5).
 *
 * The frame carries only an invalidation notice plus a sequence number, never a
 * payload: the panel reacts by re-reading `status`/`conflicts`, so a stale event
 * can only cause an extra read, never a wrong render. That is also why the feed
 * can be driven by file timestamps instead of a bus — every write the service
 * makes (state, journal, conflicts) lives under the plugin's state root.
 *
 * `text/event-stream` keeps the request open, so this route is the only one
 * that is not a request/response envelope.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { stateRoot } from '../core/paths.js'
import type { WebRoute } from './routes.js'

export interface EventStreamOptions {
  /** Directory to watch; defaults to the plugin state root. */
  root?: () => string
  /** How often the state root is polled for changes. */
  pollMs?: number
  /** Comment frame cadence, so proxies keep the connection open. */
  heartbeatMs?: number
}

const DEFAULT_POLL_MS = 2_000
const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * Build the SSE route.
 *
 * Every open panel gets its own poll loop. The loop reads only `stat` timestamps
 * (link/state/journal/conflicts per project), which is a handful of syscalls —
 * cheap enough that a second connection costs less than a shared watcher.
 */
export function createEventsRoute(options: EventStreamOptions = {}): WebRoute {
  return {
    kind: 'exact',
    path: '/overleaf/events',
    handler: (req: IncomingMessage, res: ServerResponse) => streamEvents(req, res, options),
  }
}

async function streamEvents(req: IncomingMessage, res: ServerResponse, options: EventStreamOptions): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' })
    res.end(JSON.stringify({ ok: false, code: 'E_VALIDATION', message: 'the event stream is GET-only' }))
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // nginx and friends buffer `text/event-stream` unless told not to.
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()

  const root = options.root ?? stateRoot
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

  let seq = 0
  let closed = false
  const write = (chunk: string): void => {
    if (closed) return
    try {
      res.write(chunk)
    } catch {
      closed = true
    }
  }

  write(`retry: 3000\n\n`)
  write(frame('ready', { seq }))

  let last = await signature(root())
  const poll = setInterval(() => {
    void (async () => {
      const next = await signature(root())
      if (next === last) return
      last = next
      seq += 1
      write(frame('status', { seq }))
    })()
  }, pollMs)
  const beat = setInterval(() => write(': ping\n\n'), heartbeatMs)

  const stop = (): void => {
    if (closed) return
    closed = true
    clearInterval(poll)
    clearInterval(beat)
    try {
      res.end()
    } catch {
      // the peer is already gone
    }
  }
  req.on('close', stop)
  res.on('close', stop)
  res.on('error', stop)
}

/** One SSE frame; `\n\n` terminates it (EventSource splits on blank lines). */
export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * A change fingerprint of everything the panel renders.
 *
 * `mtime` alone would miss a same-millisecond rewrite, so the size rides along;
 * `journal` and `conflicts` are included because a pull can append rows without
 * touching `state.json`.
 */
export async function signature(root: string): Promise<string> {
  let projects: string[]
  try {
    projects = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return ''
  }

  const parts: string[] = []
  for (const project of projects) {
    const dir = path.join(root, project)
    parts.push(project, await stamp(path.join(dir, 'link.json')))
    parts.push(await stamp(path.join(dir, 'state.json')))
    parts.push(await stamp(path.join(dir, 'journal.ndjson')))
    parts.push(await stamp(path.join(dir, 'conflicts')))
  }
  return parts.join('|')
}

/** `mtimeMs:size`, or `-` when the path does not exist yet. */
async function stamp(target: string): Promise<string> {
  try {
    const stat = await fs.stat(target)
    return `${Math.round(stat.mtimeMs)}:${stat.size}`
  } catch {
    return '-'
  }
}
