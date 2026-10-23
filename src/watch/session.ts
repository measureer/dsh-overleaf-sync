/**
 * Background two-way sync (design §5.2, §7).
 *
 * One session = one linked project while `overleaf_watch` is running:
 *
 *   fs.watch(localRoot)  ──debounce──▶ diffToOps ▶ applyOtUpdate ▶ state
 *   transport.onRemoteUpdate ────────▶ applyOps ▶ atomic write ▶ state
 *
 * Guard rails that make this safe rather than clever:
 *
 * - **Loop suppression** happens on *content*, not on events: a write we made
 *   ourselves changes the file back to a hash the baseline already knows, so the
 *   fs event is dropped. No timing assumptions, no "ignore next event" flags.
 * - **Never overwrite unread edits**: a local commit is only sent when the
 *   remote still matches the baseline's `remoteHash`; otherwise the conflict
 *   path archives both sides instead of guessing.
 * - **Docs are joined lazily** and left again after `watch.idleLeaveDocMs`, so a
 *   long-running session does not pin every document open (the reference
 *   implementation's biggest resource leak).
 * - Every side effect is cancelled by `stop()`: watcher, timers, socket.
 */

import fs from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

import type { Config } from '../config.js'
import { OverleafSyncError } from '../core/errors.js'
import { atomicWrite, normalizeEol, readTextIfExists, sha256 } from '../core/fsUtil.js'
import { loadIgnoreMatcher } from '../core/ignore.js'
import { applyOps, diffToOps } from '../core/otDiff.js'
import { StateStore } from '../core/stateStore.js'
import { writeTextConflict } from '../core/conflicts.js'
import type { LinkRecord, OverleafTransport, RemoteUpdate } from '../types.js'

export interface WatchLogger {
  info(message: string): void
  warn(message: string): void
  debug?(message: string): void
}

export interface WatchEvent {
  at: string
  type: 'started' | 'local' | 'remote' | 'conflict' | 'leave' | 'error' | 'stopped'
  path?: string
  detail?: string
  version?: number
}

export interface WatchDocRef {
  docId: string
  relPath: string
}

export interface WatchSessionOptions {
  link: LinkRecord
  transport: OverleafTransport
  config: Config
  docs: WatchDocRef[]
  logger?: WatchLogger
  onEvent?: (event: WatchEvent) => void
}

interface OpenDoc {
  docId: string
  relPath: string
  version: number
  text: string
  usedAt: number
  leaveTimer?: NodeJS.Timeout
}

/** Keep the in-memory event ring small; the GUI asks for a bounded history. */
const MAX_EVENTS = 50

export class WatchSession {
  private readonly link: LinkRecord
  private readonly transport: OverleafTransport
  private readonly config: Config
  private readonly logger?: WatchLogger
  private readonly onEvent?: (event: WatchEvent) => void
  private readonly docsByPath = new Map<string, string>()
  private readonly pathByDocId = new Map<string, string>()
  private readonly open = new Map<string, OpenDoc>()
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>()
  private readonly unsubscribers: Array<() => void> = []
  private readonly events: WatchEvent[] = []
  private ignore: (relPath: string) => boolean = () => false
  private store?: StateStore
  private watcher?: FSWatcher
  private saveTimer?: NodeJS.Timeout
  private running = false
  private startedAt = ''
  private lastEventAt?: string
  private lastError?: string
  private throttled = 0

  constructor(options: WatchSessionOptions) {
    this.link = options.link
    this.transport = options.transport
    this.config = options.config
    this.logger = options.logger
    this.onEvent = options.onEvent
    for (const doc of options.docs) {
      this.docsByPath.set(doc.relPath, doc.docId)
      this.pathByDocId.set(doc.docId, doc.relPath)
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** The binding this session watches; the service reports it in status output. */
  get linkInfo(): LinkRecord {
    return this.link
  }

  get recentEvents(): WatchEvent[] {
    return this.events.slice(-MAX_EVENTS)
  }

  get lastErrorText(): string | undefined {
    return this.lastError
  }

  get openDocCount(): number {
    return this.open.size
  }

  get stats() {
    return {
      startedAt: this.startedAt,
      ...(this.lastEventAt ? { lastEventAt: this.lastEventAt } : {}),
      openDocs: this.open.size,
      throttledSubmissions: this.throttled,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** Join the project, load the baseline, attach fs + socket listeners. */
  async start(): Promise<void> {
    if (this.running) return
    const store = await StateStore.load(this.link.projectId, this.link.localRoot)
    this.store = store
    this.ignore = await loadIgnoreMatcher(this.link.localRoot, this.link.exclude)
    this.running = true
    this.startedAt = new Date().toISOString()

    this.unsubscribers.push(
      this.transport.onRemoteUpdate((update) => {
        void this.handleRemoteUpdate(update).catch((error: unknown) => this.fail(error))
      }),
      this.transport.onConnectionState((state) => {
        if (state !== 'connected') this.record('error', undefined, `connection ${state}`)
      }),
    )

    try {
      this.watcher = watch(this.link.localRoot, { recursive: true }, (_event, filename) => {
        if (typeof filename !== 'string' || filename.length === 0) return
        this.scheduleFile(filename.replaceAll('\\', '/'))
      })
      this.watcher.on('error', (error: unknown) => this.fail(error))
    } catch (error) {
      this.fail(error)
      throw error
    }

    this.record('started', undefined, `${this.docsByPath.size} documents`)
    this.logger?.info(`watching ${this.link.localRoot} (${this.docsByPath.size} docs)`)
  }

  /** Detach everything, leave every open document, keep the baseline. */
  async stop(reason = 'stopped by user'): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    this.debounceTimers.clear()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    try {
      this.watcher?.close()
    } catch {
      // closing an already-closed watcher is not an error
    }
    this.watcher = undefined
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // a dead transport may throw here; nothing to recover
      }
    }
    for (const doc of [...this.open.values()]) await this.leave(doc, 'shutdown')
    await this.flushState()
    this.record('stopped', undefined, reason)
  }

  // ------------------------------------------------------------- local changes

  /** Debounce one fs event; `throttleMs` is the per-file coalescing window. */
  private scheduleFile(relPath: string): void {
    if (!this.running) return
    const key = relPath.toLowerCase()
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    const window = Math.max(50, this.link.throttleMs ?? 400)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key)
      void this.handleLocalFile(relPath).catch((error: unknown) => this.fail(error, relPath))
    }, window)
    // Node keeps the process alive for timers; that is what we want while
    // watching, but the timer must not hold a stopped session open.
    if (!this.running) clearTimeout(timer)
    this.debounceTimers.set(key, timer)
  }

  private async handleLocalFile(relPath: string): Promise<void> {
    if (!this.running) return
    const normalized = relPath.replaceAll('\\', '/')
    // Editor temp files (`~$paper.tex`, `.#paper.tex`), git internals, ignored
    // globs and anything that is not a known document never reach the socket.
    const base = path.posix.basename(normalized)
    if (base.startsWith('.') || base.startsWith('~$')) return
    if (this.ignore(normalized)) return
    const docId = this.docsByPath.get(normalized)
    if (!docId) return

    const abs = path.join(this.link.localRoot, ...normalized.split('/'))
    const localText = await readTextIfExists(abs)
    if (localText === undefined) return
    const localHash = sha256(normalizeEol(localText))
    const store = this.store
    if (!store) return
    const baseline = store.get(normalized)
    if (baseline && baseline.localHash === localHash) return

    const doc = await this.openDoc(docId, normalized)
    if (sha256(normalizeEol(doc.text)) === localHash) return

    const remoteHash = sha256(normalizeEol(doc.text))
    if (baseline?.remoteHash !== undefined && baseline.remoteHash !== remoteHash) {
      // Both sides moved since the last sync: archive instead of clobbering.
      const copy = await writeTextConflict({
        link: this.link,
        relPath: normalized,
        localText,
        remoteText: doc.text,
        meta: { reason: 'remote-changed', remoteVersion: doc.version },
      })
      this.record('conflict', normalized, `remote changed; copy: ${copy}`)
      return
    }

    const ops = diffToOps(doc.text, localText)
    if (ops.length === 0) return
    const applied = await this.transport.applyOtUpdate(docId, doc.version, ops)
    doc.text = localText
    doc.version = applied.version
    doc.usedAt = Date.now()
    store.set(normalized, {
      docId,
      remoteVersion: applied.version,
      remoteHash: localHash,
      localHash,
      syncedAt: new Date().toISOString(),
      origin: 'local',
      kind: 'doc',
    })
    this.scheduleSave()
    this.record('local', normalized, `pushed v${applied.version}`, applied.version)
  }

  // ------------------------------------------------------------ remote changes

  private async handleRemoteUpdate(update: RemoteUpdate): Promise<void> {
    if (!this.running) return
    let doc = this.open.get(update.docId)
    if (!doc) {
      // Nobody has the document open yet: joining it is what brings its text
      // (already including this update) onto disk.
      const relPath = this.pathByDocId.get(update.docId)
      if (relPath === undefined) return
      doc = await this.openDoc(update.docId, relPath)
    }
    const nextText = applyOps(doc.text, update.ops)
    const nextHash = sha256(normalizeEol(nextText))
    const abs = path.join(this.link.localRoot, ...doc.relPath.split('/'))
    const localText = await readTextIfExists(abs)
    const localHash = localText === undefined ? undefined : sha256(normalizeEol(localText))
    const store = this.store
    const baseline = store?.get(doc.relPath)

    if (baseline !== undefined && localText !== undefined && localHash !== baseline.localHash) {
      // Local edits are in flight: archive the remote side, do not touch the file.
      const copy = await writeTextConflict({
        link: this.link,
        relPath: doc.relPath,
        localText,
        remoteText: nextText,
        meta: { reason: 'local-changed', remoteVersion: update.version },
      })
      this.record('conflict', doc.relPath, `local edits pending; copy: ${copy}`)
      return
    }

    await atomicWrite(abs, nextText)
    doc.text = nextText
    doc.version = update.version
    doc.usedAt = Date.now()
    store?.set(doc.relPath, {
      docId: doc.docId,
      remoteVersion: update.version,
      remoteHash: nextHash,
      localHash: nextHash,
      syncedAt: new Date().toISOString(),
      origin: 'remote',
      kind: 'doc',
    })
    this.scheduleSave()
    this.record('remote', doc.relPath, `pulled v${update.version}`, update.version)
  }

  // --------------------------------------------------------------- doc handles

  private async openDoc(docId: string, relPath: string): Promise<OpenDoc> {
    const existing = this.open.get(docId)
    if (existing) {
      existing.usedAt = Date.now()
      this.refreshLeaveTimer(existing)
      return existing
    }
    if (this.open.size >= Math.max(1, this.config.watch.maxOpenDocs)) {
      const oldest = [...this.open.values()].sort((a, b) => a.usedAt - b.usedAt)[0]
      if (oldest) await this.leave(oldest, 'max open documents')
    }
    const content = await this.transport.joinDoc(docId)
    const doc: OpenDoc = {
      docId,
      relPath,
      version: content.version,
      text: content.text,
      usedAt: Date.now(),
    }
    this.open.set(docId, doc)
    this.refreshLeaveTimer(doc)
    return doc
  }

  private refreshLeaveTimer(doc: OpenDoc): void {
    if (doc.leaveTimer) clearTimeout(doc.leaveTimer)
    const idle = Math.max(1000, this.config.watch.idleLeaveDocMs)
    doc.leaveTimer = setTimeout(() => {
      void this.leave(doc, 'idle').catch((error: unknown) => this.fail(error, doc.relPath))
    }, idle)
    doc.leaveTimer.unref?.()
  }

  private async leave(doc: OpenDoc, reason: string): Promise<void> {
    if (doc.leaveTimer) clearTimeout(doc.leaveTimer)
    doc.leaveTimer = undefined
    if (!this.open.delete(doc.docId)) return
    try {
      await this.transport.leaveDoc(doc.docId)
    } catch {
      // leaveDoc is best-effort: the socket may already be gone
    }
    this.record('leave', doc.relPath, reason)
  }

  // ------------------------------------------------------------------- shared

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flushState()
    }, 300)
  }

  private async flushState(): Promise<void> {
    try {
      await this.store?.save()
    } catch (error) {
      this.fail(error)
    }
  }

  private record(type: WatchEvent['type'], relPath?: string, detail?: string, version?: number): void {
    const event: WatchEvent = {
      at: new Date().toISOString(),
      type,
      ...(relPath !== undefined ? { path: relPath } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(version !== undefined ? { version } : {}),
    }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.shift()
    this.lastEventAt = event.at
    if (type === 'local') this.throttled += 1
    try {
      this.onEvent?.(event)
    } catch {
      // a broken subscriber must not break the sync
    }
    this.logger?.debug?.(`[watch] ${type} ${relPath ?? ''} ${detail ?? ''}`.trim())
  }

  private fail(error: unknown, relPath?: string): void {
    const message =
      error instanceof OverleafSyncError
        ? error.hint
          ? `${error.code}: ${error.message} — ${error.hint}`
          : `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    this.lastError = message
    this.record('error', relPath, message)
    this.logger?.warn(`[watch] ${message}`)
  }
}

/** Read a file only when it exists, tolerating a racing delete. */
export async function readWatchFile(abs: string): Promise<string | undefined> {
  try {
    return await fs.readFile(abs, 'utf8')
  } catch {
    return undefined
  }
}
