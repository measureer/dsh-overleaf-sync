/**
 * `OverleafTransport` on top of the Socket.IO 0.9 client (`./legacy.ts`).
 *
 * Old self-hosted Overleaf builds (the ones shipping
 * `Socket.IO.min.js build:0.9.17-overleaf-5`) speak protocol 1 instead of
 * Engine.IO 4, so `OverleafSocket` can never connect to them — it reports the
 * misleading "joinProject did not answer within 15000 ms". This class gives
 * those servers the same transport surface as the modern one, so `service.ts`
 * stays generation-agnostic.
 *
 * Protocol notes (verified against a live 0.9 instance):
 * - `joinProject` answers with an **event** (`joinProjectResponse`), not an ack;
 *   the low-level client already waits for it inside `connect()`.
 * - `joinDoc` / `applyOtUpdate` / `leaveDoc` answer with ack frames
 *   (`6:::<id>+[...]`).
 * - Remote edits arrive as events (`otUpdateApplied`); the payload carries
 *   `doc_id` / `v` / `op` (sometimes wrapped in an array).
 */
import type {
  ConnectionState,
  Credential,
  DocContent,
  OverleafTransport,
  ProjectSnapshot,
  RemoteUpdate,
  TextOp,
} from '../types.js'
import { OverleafSyncError } from '../core/errors.js'
import { LegacyOverleafSocket } from './legacy.js'
import {
  buildUpdate,
  nextVersionFromAck,
  normalizeProjectTree,
  parseRemoteUpdate,
} from './socket.js'
import { linesToText } from './packed.js'

/** Ack budget for regular 0.9 round trips. */
const EMIT_TIMEOUT_MS = 5_000
/** Budget for connect (handshake + upgrade + joinProject). */
const CONNECT_BUDGET_MS = 15_000

export interface LegacyTransportOptions {
  signal?: AbortSignal
  /** Log protocol traffic to stderr (never logs the cookie). */
  debug?: boolean
}

function debugSink(enabled: boolean): ((message: string) => void) | undefined {
  if (!enabled) return undefined
  return (message: string) => {
    process.stderr.write(`[overleaf-sync:legacy] ${message}\n`)
  }
}

/**
 * Unwrap the `joinProjectResponse` payload into the shape `normalizeProjectTree`
 * expects. The server nests the project under `project`, next to `publicId`.
 */
function projectFromPayload(payload: unknown, projectId: string): {
  project: unknown
  publicId?: string
} {
  if (payload === null || typeof payload !== 'object') {
    throw new OverleafSyncError(
      'E_TRANSPORT',
      'joinProjectResponse returned an unexpected payload',
      'retry; if it persists, verify the Overleaf baseUrl and the stored credential',
    )
  }
  const record = payload as Record<string, unknown>
  const publicId =
    typeof record.publicId === 'string' && record.publicId.length > 0
      ? record.publicId
      : undefined
  const nested = record.project
  if (nested !== null && typeof nested === 'object') {
    return publicId ? { project: nested, publicId } : { project: nested }
  }
  void projectId
  return publicId ? { project: record, publicId } : { project: record }
}

/** Pull the string lines out of whatever joinDoc answered with. */
function linesFromAck(ack: unknown[], docId: string): string[] {
  const first = ack[0]
  const candidate = Array.isArray(first)
    ? first
    : ack.length > 1 && Array.isArray(ack[1])
      ? ack[1]
      : undefined
  if (candidate === undefined) {
    throw new OverleafSyncError(
      'E_TRANSPORT',
      `joinDoc(${docId}) returned no lines`,
      'retry; if the document still fails, re-link the project',
    )
  }
  const lines: string[] = []
  for (const line of candidate) {
    if (typeof line !== 'string') {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `joinDoc(${docId}) returned a non-string line`,
        'retry; if it persists, report the protocol mismatch',
      )
    }
    lines.push(line)
  }
  return lines
}

/** The document version sits right after the lines (`[lines, version, …]`). */
function versionFromAck(ack: unknown[], docId: string): number {
  for (const value of ack) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  throw new OverleafSyncError(
    'E_TRANSPORT',
    `joinDoc(${docId}) returned no document version`,
    'retry; if the document still fails, re-link the project',
  )
}

/** Normalize an `otUpdateApplied`-style payload into `parseRemoteUpdate` input. */
function updateCandidate(payload: unknown): unknown {
  const record = payload === null || typeof payload !== 'object' ? undefined : (payload as Record<string, unknown>)
  if (record === undefined) return payload
  const candidate: Record<string, unknown> = { ...record }
  if (typeof candidate.doc !== 'string' && typeof candidate.doc_id === 'string') {
    candidate.doc = candidate.doc_id
  }
  if (typeof candidate.v !== 'number' && typeof candidate.version === 'number') {
    candidate.v = candidate.version
  }
  return candidate
}

export class LegacyTransport implements OverleafTransport {
  readonly projectId: string

  readonly #socket: LegacyOverleafSocket
  readonly #credential: Credential
  #snapshot?: ProjectSnapshot
  #closed = false

  private constructor(socket: LegacyOverleafSocket, credential: Credential, projectId: string) {
    this.#socket = socket
    this.#credential = credential
    this.projectId = projectId
  }

  /** Connect, join the project and normalize the tree in one shot. */
  static async connect(
    credential: Credential,
    projectId: string,
    options: LegacyTransportOptions = {},
  ): Promise<LegacyTransport> {
    const socket = await LegacyOverleafSocket.connect({
      baseUrl: credential.baseUrl,
      cookie: credential.cookie,
      projectId,
      timeoutMs: CONNECT_BUDGET_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.debug === true ? { onDebug: debugSink(true) } : {}),
    })
    const transport = new LegacyTransport(socket, credential, projectId)
    const { project } = projectFromPayload(socket.payload, projectId)
    transport.#snapshot = normalizeProjectTree(project, projectId)
    return transport
  }

  /** The normalized project tree captured by joinProjectResponse. */
  async joinProject(): Promise<ProjectSnapshot> {
    if (this.#closed) {
      throw this.#closedError()
    }
    if (this.#snapshot === undefined) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'the Overleaf project tree is not available',
        'retry; if it persists, recreate the transport',
      )
    }
    return cloneSnapshot(this.#snapshot)
  }

  async joinDoc(docId: string): Promise<DocContent> {
    this.#assertUsable()
    const ack = await this.#socket.emitWithAck<unknown>(
      'joinDoc',
      [docId, { encodeRanges: true }],
      EMIT_TIMEOUT_MS,
    )
    const lines = linesFromAck(ack, docId)
    const version = versionFromAck(ack, docId)
    return { docId, version, text: linesToText(lines) }
  }

  /** Best effort: a leaveDoc failure must never fail the surrounding sync. */
  async leaveDoc(docId: string): Promise<void> {
    if (this.#closed) return
    try {
      await this.#socket.emitWithAck<unknown>('leaveDoc', [docId], EMIT_TIMEOUT_MS)
    } catch {
      // The document is left when the socket closes anyway.
    }
  }

  async applyOtUpdate(docId: string, version: number, ops: TextOp[]): Promise<{ version: number }> {
    this.#assertUsable()
    if (typeof version !== 'number' || !Number.isFinite(version) || version < 0) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `invalid document version for ${docId}: ${String(version)}`,
        'this is a bug in the sync layer; report it',
      )
    }
    const update = buildUpdate(docId, version, ops, this.#socket.socketId)
    const ack = await this.#socket.emitWithAck<unknown>(
      'applyOtUpdate',
      [docId, update],
      EMIT_TIMEOUT_MS,
    )
    return { version: nextVersionFromAck(ack, version, ops.length > 0) }
  }

  onRemoteUpdate(cb: (update: RemoteUpdate) => void): () => void {
    return this.#socket.on('otUpdateApplied', (payload: unknown) => {
      const parsed = parseRemoteUpdate(updateCandidate(payload))
      if (parsed === undefined) return
      if (parsed.source !== undefined && parsed.source === this.#socket.socketId) return
      cb(parsed.update)
    })
  }

  onConnectionState(cb: (state: ConnectionState) => void): () => void {
    // The 0.9 client does not reconnect on its own; the state is fixed for the
    // lifetime of the transport, so replay it once and never fire again.
    cb('connected')
    return () => undefined
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#socket.close()
  }

  /** Cookie currently in use (never logged). */
  get credential(): Credential {
    return this.#credential
  }

  #assertUsable(): void {
    if (this.#closed) throw this.#closedError()
  }

  #closedError(): OverleafSyncError {
    return new OverleafSyncError(
      'E_TRANSPORT',
      'the Overleaf transport is closed',
      'reconnect with a fresh transport before sending more updates',
    )
  }
}

function cloneSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  return {
    id: snapshot.id,
    name: snapshot.name,
    folders: snapshot.folders.map((folder) => ({ ...folder })),
    docs: snapshot.docs.map((doc) => ({ ...doc })),
    files: snapshot.files.map((file) => ({ ...file })),
  }
}
