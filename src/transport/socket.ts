import { randomUUID } from 'node:crypto'

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client'

import { describeError, isOverleafError, OverleafSyncError } from '../core/errors.js'
import type {
  ConnectionState,
  Credential,
  DocContent,
  OverleafTransport,
  ProjectSnapshot,
  RemoteUpdate,
  TextOp,
} from '../types.js'
import { linesToText } from './packed.js'

/** Overall budget for `connect()` (handshake + joinProject), in milliseconds. */
const CONNECT_BUDGET_MS = 15_000
/** Timeout for a regular socket emit/ack round trip, in milliseconds. */
const EMIT_TIMEOUT_MS = 5_000
const DEBUG_PREFIX = '[overleaf-sync:socket]'

type Scheme = 'v1' | 'v2'

/** Socket options we pass, plus legacy option names that are not in the types. */
type SocketClientOptions = Partial<ManagerOptions & SocketOptions> & Record<string, unknown>

/** Payload understood by the Overleaf socket server (`UpdateSchema`). */
export interface UpdatePayload {
  doc: string
  op: TextOp[]
  v: number
  lastV: number
  meta: { source: string; ts: number; user_id?: string }
}

export interface ParsedRemoteUpdate {
  update: RemoteUpdate
  /** `meta.source` of the update, used to ignore echoes of our own writes. */
  source?: string
}

interface JoinedProject {
  project: unknown
  publicId?: string
}

interface RawEntity {
  _id?: unknown
  id?: unknown
  name?: unknown
  deleted?: unknown
  _deleted?: unknown
  archived?: unknown
  trashed?: unknown
}

interface RawFolder extends RawEntity {
  docs?: unknown
  fileRefs?: unknown
  folders?: unknown
}

interface RawProject extends RawEntity {
  rootFolder?: unknown
}

function entityId(entity: RawEntity): string | undefined {
  const id = entity._id ?? entity.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function isLiveEntity(entity: RawEntity): boolean {
  return (
    entity.deleted !== true &&
    entity._deleted !== true &&
    entity.archived !== true &&
    entity.trashed !== true
  )
}

function entityName(entity: RawEntity): string {
  return typeof entity.name === 'string' ? entity.name : ''
}

function asEntityArray(value: unknown): RawEntity[] {
  if (!Array.isArray(value)) return []
  const entities: RawEntity[] = []
  for (const item of value) {
    if (item !== null && typeof item === 'object') entities.push(item as RawEntity)
  }
  return entities
}

/**
 * Normalize the `project` entity returned by `joinProject` into a flat
 * snapshot. `rootFolder` may be an object or a one-element array; folders are
 * walked recursively and every child records its direct parent folder
 * (`null` = project root). Deleted / archived / trashed entities are skipped.
 */
export function normalizeProjectTree(
  project: unknown,
  fallbackProjectId: string,
): ProjectSnapshot {
  const snapshot: ProjectSnapshot = {
    id: fallbackProjectId,
    name: 'project',
    folders: [],
    docs: [],
    files: [],
  }
  if (project === null || typeof project !== 'object') return snapshot

  const raw = project as RawProject
  const id = entityId(raw)
  if (id) snapshot.id = id
  if (typeof raw.name === 'string' && raw.name.trim().length > 0) snapshot.name = raw.name

  const roots = Array.isArray(raw.rootFolder)
    ? raw.rootFolder
    : raw.rootFolder !== undefined && raw.rootFolder !== null
      ? [raw.rootFolder]
      : []
  for (const candidate of roots) {
    if (candidate === null || typeof candidate !== 'object') continue
    const root = candidate as RawFolder
    if (!isLiveEntity(root)) continue
    walkFolder(root, null, snapshot)
    // Overleaf projects have a single root folder; ignore any extra roots.
    break
  }
  return snapshot
}

function walkFolder(folder: RawFolder, parentFolderId: string | null, out: ProjectSnapshot): void {
  for (const doc of asEntityArray(folder.docs)) {
    if (!isLiveEntity(doc)) continue
    const id = entityId(doc)
    if (!id) continue
    out.docs.push({ id, name: entityName(doc), parentFolderId })
  }
  for (const file of asEntityArray(folder.fileRefs)) {
    if (!isLiveEntity(file)) continue
    const id = entityId(file)
    if (!id) continue
    out.files.push({ id, name: entityName(file), parentFolderId })
  }
  for (const child of asEntityArray(folder.folders)) {
    if (!isLiveEntity(child)) continue
    const id = entityId(child)
    if (!id) continue
    out.folders.push({ id, name: entityName(child), parentFolderId })
    walkFolder(child, id, out)
  }
}

/**
 * Build the payload expected by `applyOtUpdate`. `v`/`lastV` are the version
 * the operation is based on; the server answers with the new version.
 */
export function buildUpdate(
  docId: string,
  version: number,
  ops: TextOp[],
  source: string,
  userId?: string,
  ts: number = Date.now(),
): UpdatePayload {
  if (typeof docId !== 'string' || docId.length === 0) {
    throw new OverleafSyncError(
      'E_TRANSPORT',
      'applyOtUpdate: docId is empty',
      're-run the sync; report this as a bug if it persists',
    )
  }
  if (!Number.isInteger(version) || version < 0) {
    throw new OverleafSyncError(
      'E_TRANSPORT',
      `applyOtUpdate: invalid base version ${version}`,
      're-join the document to refresh its version, then retry',
    )
  }

  const op: TextOp[] = []
  for (const next of ops) {
    if (next === null || typeof next !== 'object' || !Number.isInteger(next.p) || next.p < 0) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'applyOtUpdate: malformed OT operation',
        're-run the sync; report this as a bug if it persists',
      )
    }
    const normalized: TextOp = { p: next.p }
    if (typeof next.i === 'string' && next.i.length > 0) normalized.i = next.i
    if (typeof next.d === 'string' && next.d.length > 0) normalized.d = next.d
    if (normalized.i === undefined && normalized.d === undefined) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'applyOtUpdate: operation has neither insert nor delete text',
        're-run the sync; report this as a bug if it persists',
      )
    }
    op.push(normalized)
  }

  return {
    doc: docId,
    op,
    v: version,
    lastV: version,
    meta: userId ? { source, ts, user_id: userId } : { source, ts },
  }
}

/**
 * Resolve the new document version from an `applyOtUpdate` ack. The server may
 * send `[version]`, `[{ version }]`, `[{ v }]` or nothing at all, so fall back
 * to `baseVersion + 1` when an operation was actually sent.
 */
export function nextVersionFromAck(
  ack: readonly unknown[],
  baseVersion: number,
  applied: boolean,
): number {
  for (const item of ack) {
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const version = record.version ?? record.v
      if (typeof version === 'number' && Number.isFinite(version)) return version
    }
  }
  return applied ? baseVersion + 1 : baseVersion
}

function parseOps(raw: unknown): TextOp[] | undefined {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return undefined
  const ops: TextOp[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return undefined
    const record = item as Record<string, unknown>
    if (typeof record.p !== 'number' || !Number.isFinite(record.p)) return undefined
    const op: TextOp = { p: record.p }
    if (typeof record.i === 'string') op.i = record.i
    if (typeof record.d === 'string') op.d = record.d
    ops.push(op)
  }
  return ops
}

/**
 * Validate an `otUpdateApplied` payload. `v` is the *new* version
 * (previous version + 1), `op` the ops to apply, `doc` the document id.
 * Returns `undefined` for malformed payloads so the caller can ignore them.
 */
export function parseRemoteUpdate(raw: unknown): ParsedRemoteUpdate | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const docId = typeof record.doc === 'string' && record.doc.length > 0 ? record.doc : undefined
  const version =
    typeof record.v === 'number' && Number.isFinite(record.v) ? record.v : undefined
  if (!docId || version === undefined) return undefined
  const ops = parseOps(record.op)
  if (!ops) return undefined
  const meta =
    record.meta !== null && typeof record.meta === 'object'
      ? (record.meta as Record<string, unknown>)
      : undefined
  const source = typeof meta?.source === 'string' && meta.source.length > 0 ? meta.source : undefined
  const parsed: ParsedRemoteUpdate = { update: { docId, version, ops } }
  if (source) parsed.source = source
  return parsed
}

function errorText(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error.length > 0 ? error : 'unknown error'
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.length > 0) return record.message
    if (typeof record.error === 'string' && record.error.length > 0) return record.error
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch {
      // circular payload; fall through
    }
  }
  return String(error)
}

function extractJoinedProject(raw: unknown, fallbackPublicId?: string): JoinedProject {
  if (raw === null || typeof raw !== 'object') {
    throw new OverleafSyncError(
      'E_TRANSPORT',
      'joinProject returned an unexpected payload',
      'retry; if it persists, verify the Overleaf baseUrl and the stored credential',
    )
  }
  const record = raw as Record<string, unknown>
  const publicId =
    typeof record.publicId === 'string' && record.publicId.length > 0
      ? record.publicId
      : fallbackPublicId
  const nested = record.project
  const project = nested !== null && typeof nested === 'object' ? nested : record
  return publicId ? { project, publicId } : { project }
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

function chooseJoinFailure(failures: unknown[], projectId: string): OverleafSyncError {
  for (const failure of failures) {
    if (isOverleafError(failure) && failure.code === 'E_AUTH_EXPIRED') return failure
  }
  for (const failure of failures) {
    if (isOverleafError(failure) && failure.code === 'E_PROJECT_NOT_FOUND') return failure
  }
  for (const failure of failures) {
    if (isOverleafError(failure) && failure.code !== 'E_TIMEOUT') return failure
  }
  const last = failures[failures.length - 1]
  if (isOverleafError(last)) return last
  const message = last === undefined ? 'no connection attempt was made' : errorText(last)
  return new OverleafSyncError(
    'E_TRANSPORT',
    `could not join Overleaf project ${projectId}: ${message}`,
    'check network/proxy access to Overleaf and run overleaf_login again if the session expired',
  )
}

export interface SocketConnectOptions {
  signal?: AbortSignal
  /** Log the socket protocol to stderr (never logs the cookie). */
  debug?: boolean
}

/** Where socket.io lives for a given Overleaf base URL. */
export interface SocketEndpoint {
  /** Scheme + host (+ port); sub-path deployments keep the path in `path`. */
  origin: string
  /** Non-default socket.io endpoint (`/overleaf/socket.io/`); absent on the default path. */
  path?: string
}

/**
 * Resolve the socket.io endpoint for a base URL.
 *
 * Official and root-deployed instances use `/socket.io/`; a self-hosted instance
 * mounted under a sub-path (`https://host/overleaf/`) serves it from
 * `<basePath>/socket.io/`. HTTP requests use the full base URL instead — see
 * `normalizeBaseUrl` in `./credentials.ts`.
 */
export function socketEndpoint(baseUrl: string): SocketEndpoint {
  const parsed = new URL(baseUrl)
  const basePath = parsed.pathname.replace(/\/+$/, '')
  return basePath.length === 0
    ? { origin: parsed.origin }
    : { origin: parsed.origin, path: `${basePath}/socket.io/` }
}

/**
 * socket.io transport for one Overleaf project.
 *
 * Protocol (matching `.ref/src/api/socketio.ts`):
 * - try v1 first: connect and `emit('joinProject', { project_id })`;
 * - when the server emits `connectionRejected`, retry with the v2 handshake
 *   (`?projectId=<id>&t=<ts>`) and wait for `joinProjectResponse`;
 * - `joinDoc` lines are latin1-packed UTF-8 (see `./packed.ts`);
 * - `applyOtUpdate` takes the `UpdateSchema` payload built by `buildUpdate`;
 * - remote updates arrive as `otUpdateApplied` with the new version in `v`.
 */
export class OverleafSocket implements OverleafTransport {
  readonly projectId: string

  private readonly credential: Credential
  private readonly origin: string
  /** socket.io endpoint path; non-default only for servers deployed under a sub-path. */
  private readonly socketPath?: string
  private readonly debug: boolean
  private readonly sourceId: string
  private readonly abortController = new AbortController()
  private readonly updateListeners = new Set<(update: RemoteUpdate) => void>()
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()

  private socket?: Socket
  private scheme: Scheme = 'v1'
  private snapshot?: ProjectSnapshot
  private publicId?: string
  private connected = false
  private joinedOnce = false
  private connecting = false
  private reconnecting = false
  private closed = false
  private closing?: Promise<void>
  private lastState?: ConnectionState
  private pendingJoinReject?: (error: Error) => void

  static async connect(
    credential: Credential,
    projectId: string,
    options: SocketConnectOptions = {},
  ): Promise<OverleafSocket> {
    const transport = new OverleafSocket(credential, projectId, options.debug === true)
    try {
      await transport.open(options.signal)
      return transport
    } catch (error) {
      await transport.close()
      throw error
    }
  }

  private constructor(credential: Credential, projectId: string, debug: boolean) {
    let endpoint: SocketEndpoint
    try {
      endpoint = socketEndpoint(credential.baseUrl)
    } catch {
      throw new OverleafSyncError(
        'E_CONFIG',
        `invalid Overleaf baseUrl: ${credential.baseUrl}`,
        'pass a full URL such as https://www.overleaf.com',
      )
    }
    const origin = endpoint.origin
    const socketPath = endpoint.path
    this.credential = credential
    this.projectId = projectId
    this.origin = origin
    if (socketPath !== undefined) this.socketPath = socketPath
    this.debug = debug
    this.sourceId = `dsh-overleaf-sync-${randomUUID().slice(0, 8)}`
  }

  // ------------------------------------------------------------- public API

  async joinProject(): Promise<ProjectSnapshot> {
    this.assertUsable()
    if (!this.snapshot) {
      const joined = await this.joinOnce(this.scheme, CONNECT_BUDGET_MS)
      this.applyJoinedProject(joined)
      this.joinedOnce = true
    }
    const snapshot = this.snapshot
    if (!snapshot) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'the Overleaf project tree is not available',
        'retry; if it persists, recreate the transport',
      )
    }
    return cloneSnapshot(snapshot)
  }

  async joinDoc(docId: string): Promise<DocContent> {
    this.assertUsable()
    const data = await this.emitAck<unknown>(
      'joinDoc',
      [docId, { encodeRanges: true }],
      EMIT_TIMEOUT_MS,
    )
    const rawLines = data[0]
    const rawVersion = data[1]
    if (!Array.isArray(rawLines)) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `joinDoc(${docId}) returned no lines`,
        'retry; if the document still fails, re-link the project',
      )
    }
    if (typeof rawVersion !== 'number' || !Number.isFinite(rawVersion)) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `joinDoc(${docId}) returned no document version`,
        'retry; if the document still fails, re-link the project',
      )
    }
    const lines: string[] = []
    for (const line of rawLines) {
      if (typeof line !== 'string') {
        throw new OverleafSyncError(
          'E_TRANSPORT',
          `joinDoc(${docId}) returned a non-string line`,
          'retry; if it persists, report the protocol mismatch',
        )
      }
      lines.push(line)
    }
    return { docId, version: rawVersion, text: linesToText(lines) }
  }

  async leaveDoc(docId: string): Promise<void> {
    if (this.closed || !this.socket) return
    await this.emitAck<unknown>('leaveDoc', [docId], EMIT_TIMEOUT_MS)
  }

  async applyOtUpdate(
    docId: string,
    version: number,
    ops: TextOp[],
  ): Promise<{ version: number }> {
    this.assertUsable()
    if (typeof version !== 'number' || !Number.isFinite(version) || version < 0) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `invalid document version for ${docId}: ${String(version)}`,
        'this is a bug in the sync layer; report it',
      )
    }
    const update = buildUpdate(docId, version, ops, this.currentSource())
    const data = await this.emitAck<unknown>('applyOtUpdate', [docId, update], EMIT_TIMEOUT_MS)
    return { version: nextVersionFromAck(data, version, ops.length > 0) }
  }

  onRemoteUpdate(cb: (update: RemoteUpdate) => void): () => void {
    this.updateListeners.add(cb)
    return () => {
      this.updateListeners.delete(cb)
    }
  }

  onConnectionState(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb)
    const current = this.lastState
    if (current && !this.closed) {
      queueMicrotask(() => {
        if (this.closed || !this.stateListeners.has(cb)) return
        cb(current)
      })
    }
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      this.pendingJoinReject?.(this.closedError())
      this.abortController.abort()
      this.teardownSocket()
      this.connected = false
      this.joinedOnce = false
      this.snapshot = undefined
      this.lastState = 'disconnected'
      this.updateListeners.clear()
      this.stateListeners.clear()
    })()
    return this.closing
  }

  // ----------------------------------------------------------- connection

  private async open(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + CONNECT_BUDGET_MS
    const failures: unknown[] = []
    this.connecting = true
    try {
      for (const scheme of ['v1', 'v2'] as const) {
        if (this.closed) throw this.closedError()
        if (signal?.aborted) throw this.cancelledError('connect')
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        this.scheme = scheme
        this.debugLog(`connecting via ${scheme} (budget ${remaining}ms)`)
        try {
          await this.tryJoin(scheme, remaining, signal)
          this.connected = true
          this.joinedOnce = true
          this.setConnectionState('connected')
          return
        } catch (error) {
          failures.push(error)
          this.debugLog(`join via ${scheme} failed: ${describeError(error)}`)
          this.teardownSocket()
        }
      }
      throw chooseJoinFailure(failures, this.projectId)
    } finally {
      this.connecting = false
    }
  }

  private async tryJoin(scheme: Scheme, budgetMs: number, signal?: AbortSignal): Promise<void> {
    const socket = this.createSocket(scheme)
    this.socket = socket
    this.scheme = scheme
    this.wireSocket(socket)
    const joined = await this.joinOnce(scheme, budgetMs, signal)
    this.applyJoinedProject(joined)
    this.debugLog(
      `joined project ${this.snapshot?.id ?? this.projectId} ` +
        `(${this.snapshot?.docs.length ?? 0} docs, ${this.snapshot?.files.length ?? 0} files)`,
    )
  }

  private createSocket(scheme: Scheme): Socket {
    const query =
      scheme === 'v2' ? `?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}` : ''
    const options: SocketClientOptions = {
      reconnect: true,
      'reconnection delay': 1000,
      'reconnection limit': 16_000,
      'max reconnection attempts': 10,
      'force new connection': true,
      ...(this.socketPath === undefined ? {} : { path: this.socketPath }),
      extraHeaders: {
        Origin: this.origin,
        Cookie: this.credential.cookie,
      },
    }
    return io(`${this.origin}${query}`, options)
  }

  private wireSocket(socket: Socket): void {
    socket.on('connect', () => this.onSocketConnect())
    socket.on('disconnect', (reason: string) => this.onSocketDisconnect(reason))
    socket.on('connect_error', (error: unknown) => {
      this.debugLog(`connect_error: ${errorText(error)}`)
      if (!this.connecting && !this.connected) this.setConnectionState('disconnected')
    })
    socket.on('connectionRejected', (error: unknown) => this.onConnectionRejected(error))
    socket.on('connectionAccepted', (_data: unknown, publicId?: unknown) => {
      if (typeof publicId === 'string' && publicId.length > 0) this.publicId = publicId
    })
    socket.on('error', (error: unknown) => this.debugLog(`socket error: ${errorText(error)}`))
    socket.on('otUpdateApplied', (update: unknown) => this.handleRemoteUpdate(update))
    socket.on('joinProjectResponse', (response: unknown) => this.onJoinProjectResponse(response))
  }

  private onSocketConnect(): void {
    if (this.closed) return
    this.debugLog(`${this.scheme} socket connected`)
    if (this.connecting || this.reconnecting) return
    if (this.joinedOnce) void this.rejoin()
  }

  private onSocketDisconnect(reason: string): void {
    if (this.closed) return
    this.debugLog(`socket disconnected: ${reason}`)
    this.connected = false
    this.setConnectionState('disconnected')
  }

  private onConnectionRejected(error: unknown): void {
    const message = errorText(error)
    this.debugLog(`connectionRejected: ${message}`)
    this.connected = false
    this.setConnectionState('rejected')
    this.pendingJoinReject?.(
      new OverleafSyncError(
        'E_TRANSPORT',
        `Overleaf rejected the socket connection: ${message}`,
        'the stored cookie may have expired or the account may not have access to this project',
      ),
    )
  }

  private onJoinProjectResponse(response: unknown): void {
    try {
      const joined = extractJoinedProject(response, this.publicId)
      this.applyJoinedProject(joined)
      this.connected = true
      this.joinedOnce = true
      this.setConnectionState('connected')
    } catch (error) {
      this.debugLog(`invalid joinProjectResponse: ${describeError(error)}`)
    }
  }

  private async joinOnce(
    scheme: Scheme,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JoinedProject> {
    if (!this.socket) throw this.socketMissingError()
    let rejectJoin: ((error: Error) => void) | undefined
    const rejection = new Promise<never>((_resolve, reject) => {
      rejectJoin = reject
    })
    this.pendingJoinReject = (error) => rejectJoin?.(error)
    try {
      const attempt: Promise<JoinedProject> =
        scheme === 'v1'
          ? this.emitAck<unknown>(
              'joinProject',
              [{ project_id: this.projectId }],
              timeoutMs,
              signal,
            ).then((data) => extractJoinedProject(data[0], this.stringAt(data[1])))
          : this.waitForEvent<unknown>('joinProjectResponse', timeoutMs, signal).then((response) =>
              extractJoinedProject(response, this.publicId),
            )
      return await Promise.race([attempt, rejection])
    } finally {
      this.pendingJoinReject = undefined
    }
  }

  private stringAt(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  private applyJoinedProject(joined: JoinedProject): void {
    this.snapshot = normalizeProjectTree(joined.project, this.projectId)
    if (joined.publicId) this.publicId = joined.publicId
  }

  private async rejoin(): Promise<void> {
    if (this.closed || this.reconnecting) return
    this.reconnecting = true
    try {
      const joined = await this.joinOnce(this.scheme, CONNECT_BUDGET_MS)
      this.applyJoinedProject(joined)
      this.connected = true
      this.joinedOnce = true
      this.debugLog('rejoined project after reconnect')
      this.setConnectionState('connected')
    } catch (error) {
      this.debugLog(`rejoin failed: ${describeError(error)}`)
      this.connected = false
      this.setConnectionState(
        isOverleafError(error) && error.code === 'E_AUTH_EXPIRED' ? 'rejected' : 'disconnected',
      )
    } finally {
      this.reconnecting = false
    }
  }

  // ---------------------------------------------------------------- helpers

  private currentSource(): string {
    return this.publicId ?? this.socket?.id ?? this.sourceId
  }

  private handleRemoteUpdate(raw: unknown): void {
    if (this.closed) return
    const parsed = parseRemoteUpdate(raw)
    if (!parsed) {
      this.debugLog('ignored malformed otUpdateApplied payload')
      return
    }
    const { update, source } = parsed
    this.debugLog(
      `otUpdateApplied doc=${update.docId} v=${update.version} ` +
        `ops=${update.ops.length} source=${source ?? '-'}`,
    )
    if (this.isOwnUpdate(source)) {
      this.debugLog('ignored the echo of our own update')
      return
    }
    for (const listener of [...this.updateListeners]) {
      try {
        listener(update)
      } catch (error) {
        this.debugLog(`update listener failed: ${errorText(error)}`)
      }
    }
  }

  private isOwnUpdate(source: string | undefined): boolean {
    if (!source) return false
    return (
      source === this.sourceId ||
      (this.publicId !== undefined && source === this.publicId) ||
      (this.socket?.id !== undefined && source === this.socket.id)
    )
  }

  private emitAck<T>(
    event: string,
    args: unknown[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const socket = this.socket
    if (this.closed) return Promise.reject(this.closedError())
    if (!socket) return Promise.reject(this.socketMissingError())
    return new Promise<T[]>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: () => void = () => undefined
      const finalize = (error?: unknown, data?: T[]): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.abortController.signal.removeEventListener('abort', onAbort)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined && error !== null) reject(this.normalizeSocketError(error, event))
        else resolve(data ?? [])
      }
      onAbort = () => finalize(this.cancelledError(event))
      timer = setTimeout(() => {
        finalize(
          new OverleafSyncError(
            'E_TIMEOUT',
            `socket "${event}" did not answer within ${timeoutMs} ms`,
            'Overleaf may be slow or unreachable; retry in a moment',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.abortController.signal.addEventListener('abort', onAbort, { once: true })
      if (signal) {
        if (signal.aborted) {
          finalize(this.cancelledError(event))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        socket.emit(event, ...args, (error: unknown, ...data: T[]) => finalize(error, data))
      } catch (error) {
        finalize(error)
      }
    })
  }

  private waitForEvent<T>(event: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const socket = this.socket
    if (!socket) return Promise.reject(this.socketMissingError())
    if (signal?.aborted) return Promise.reject(this.cancelledError(event))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: () => void = () => undefined
      const onEvent = (payload: T): void => finalize(undefined, payload)
      const finalize = (error?: unknown, payload?: T): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        socket.off(event, onEvent)
        this.abortController.signal.removeEventListener('abort', onAbort)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined && error !== null) reject(this.normalizeSocketError(error, event))
        else resolve(payload as T)
      }
      onAbort = () => finalize(this.cancelledError(event))
      timer = setTimeout(() => {
        finalize(
          new OverleafSyncError(
            'E_TIMEOUT',
            `waiting for socket "${event}" timed out after ${timeoutMs} ms`,
            'Overleaf may be slow or unreachable; retry in a moment',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      socket.once(event, onEvent)
      this.abortController.signal.addEventListener('abort', onAbort, { once: true })
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private normalizeSocketError(error: unknown, event: string): OverleafSyncError {
    if (isOverleafError(error)) return error
    const message = errorText(error)
    if (
      /not\s*authoriz|unauthoriz|not logged|invalid session|cookie|login|forbidden|permission denied|not allowed/i.test(
        message,
      )
    ) {
      return new OverleafSyncError(
        'E_AUTH_EXPIRED',
        `Overleaf refused "${event}": ${message}`,
        'run overleaf_login again with a fresh Cookie + CSRF token',
      )
    }
    if (/project\b.{0,40}\bnot\b.{0,20}\b(?:found|exist)/i.test(message)) {
      return new OverleafSyncError(
        'E_PROJECT_NOT_FOUND',
        `Overleaf refused "${event}": ${message}`,
        'run overleaf_projects to confirm the project id and that the account can open it',
      )
    }
    return new OverleafSyncError(
      'E_TRANSPORT',
      `socket "${event}" failed: ${message}`,
      'retry; if it persists, check the socket connection and the stored credential',
    )
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.debugLog(`connection state: ${state}`)
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state)
      } catch (error) {
        this.debugLog(`state listener failed: ${errorText(error)}`)
      }
    }
  }

  private teardownSocket(): void {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    try {
      socket.removeAllListeners()
      socket.disconnect()
    } catch {
      // the socket is already gone; nothing to clean up
    }
  }

  private assertUsable(): void {
    if (this.closed) throw this.closedError()
    if (!this.socket) throw this.socketMissingError()
  }

  private closedError(): OverleafSyncError {
    return new OverleafSyncError(
      'E_TRANSPORT',
      'the Overleaf transport is closed',
      'create a new transport (restart overleaf_watch or retry the tool)',
    )
  }

  private socketMissingError(): OverleafSyncError {
    return new OverleafSyncError(
      'E_TRANSPORT',
      'the Overleaf socket is not connected',
      'retry; if it persists, check network access and the stored credential',
    )
  }

  private cancelledError(operation: string): OverleafSyncError {
    return new OverleafSyncError(
      'E_TRANSPORT',
      `the Overleaf ${operation} operation was cancelled`,
      'the operation was aborted by the caller',
    )
  }

  private debugLog(message: string): void {
    if (!this.debug) return
    try {
      console.error(`${DEBUG_PREFIX} ${message}`)
    } catch {
      // stderr may be unavailable in a packaged host; debugging is best effort
    }
  }
}
