/**
 * Append-only sync journal (`journal.ndjson`, design §5.3/§13).
 *
 * One JSON object per line with a generated `ts`. Journaling is best-effort
 * auditing: a broken disk must never take a sync down, so all errors are
 * swallowed. When the file grows past 5 MB it is rewritten keeping only the
 * last `keepDays` worth of entries.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { atomicWrite, ensureDir } from './fsUtil.js'
import { projectStateDir } from './paths.js'

export interface JournalEntry {
  event: string
  docId?: string
  path?: string
  v?: number
  ms?: number
  ok?: boolean
  code?: string
  [key: string]: unknown
}

const JOURNAL_FILE_NAME = 'journal.ndjson'
const DEFAULT_KEEP_DAYS = 7
const MAX_BYTES = 5 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Append one entry. `enabled: false` is a no-op; rotation happens after the
 * write so the entry that triggered it is also subject to retention.
 */
export async function appendJournal(
  projectId: string,
  entry: JournalEntry,
  options: { enabled?: boolean; keepDays?: number } = {},
): Promise<void> {
  if (options.enabled === false) return
  try {
    const dir = projectStateDir(projectId)
    await ensureDir(dir)
    const file = path.join(dir, JOURNAL_FILE_NAME)
    const line = `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`
    await fs.appendFile(file, line, 'utf8')
    await rotateJournal(file, options.keepDays ?? DEFAULT_KEEP_DAYS)
  } catch {
    // Auditing is a convenience; never break a sync because the log failed.
  }
}

async function rotateJournal(file: string, keepDays: number): Promise<void> {
  let size: number
  try {
    size = (await fs.stat(file)).size
  } catch {
    return
  }
  if (size <= MAX_BYTES) return

  const text = await fs.readFile(file, 'utf8')
  const cutoff = Date.now() - Math.max(0, keepDays) * DAY_MS
  const kept: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const ts = (parsed as { ts?: unknown }).ts
    if (typeof ts !== 'string') continue
    const stamp = Date.parse(ts)
    if (Number.isNaN(stamp) || stamp < cutoff) continue
    kept.push(line)
  }
  await atomicWrite(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
}
