/**
 * Zero-dependency Socket.IO 0.9 client for self-hosted Overleaf CE servers.
 *
 * The official overleaf.com runs Socket.IO v4 (Engine.IO 4) and is handled by
 * `socket.ts`; older community/CE builds (for example a ShareLaTeX fork behind
 * Caddy) still speak Socket.IO 0.9 with the `protocol=1` HTTP handshake:
 *
 *   GET /socket.io/1/?projectId=<id>&t=<ms>    -> "<sid>:60:60:websocket,xhr-polling"
 *   GET /socket.io/1/websocket/<sid>           -> RFC6455 upgrade
 *
 * Everything below is built from `node:http` / `node:https` / `node:crypto`, so
 * no new npm dependency is required. Wire format notes: `docs/legacy-socket.md`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'

import { authErrorFor, isOverleafError, OverleafSyncError } from '../core/errors.js'
import { normalizeBaseUrl, normalizeCookie } from './credentials.js'

/** Default budget for the whole `connect()` (handshake + upgrade + joinProject). */
const CONNECT_BUDGET_MS = 15_000
/** Default timeout for one `emitWithAck` round trip. */
const ACK_TIMEOUT_MS = 5_000
/** Socket.IO 0.9 heartbeat cadence (the server advertises 60 s before closing). */
const HEARTBEAT_INTERVAL_MS = 20_000
/** Budget for the read-only protocol probe. */
const DETECT_TIMEOUT_MS = 5_000
const DEBUG_PREFIX = '[overleaf-sync:legacy]'
const USER_AGENT = 'dsh-overleaf-sync/0.1'
/** Handshake bodies are tiny; anything bigger is an HTML error page. */
const HANDSHAKE_MAX_BYTES = 64 * 1024
/** Refuse absurd frame lengths instead of allocating gigabytes. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** RFC6455 opcodes we understand. */
export const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const

/** Socket.IO 0.9 packet type names, indexed by their wire digit. */
const PACKET_TYPES = [
  'disconnect',
  'connect',
  'heartbeat',
  'message',
  'json',
  'event',
  'ack',
  'error',
  'noop',
] as const

export type SioPacketType = (typeof PACKET_TYPES)[number]

const ERROR_REASONS = ['transport not supported', 'client not handshaken', 'unauthorized'] as const
const ERROR_ADVICE = ['reconnect'] as const

/** A decoded Socket.IO 0.9 packet (`<type>:<id>:<endpoint>:<data>`). */
export interface SioPacket {
  type: SioPacketType
  /** Packet id; for events sent with an ack callback this is the ack id. */
  id: string
  /** Namespace, `''` for the default one. */
  endpoint: string
  /** True when the id was followed by `+` (the sender expects ack data). */
  ackData: boolean
  /** Event name (type `event`). */
  name?: string
  /** Event arguments (type `event`) or ack arguments (type `ack`). */
  args?: unknown[]
  /** Ack id referenced by an ack packet. */
  ackId?: string
  /** Decoded json payload (type `json`) or raw text (type `message`). */
  data?: unknown
  /** Reason/advice text of an error packet. */
  reason?: string
  advice?: string
  /** Raw payload after the third colon, kept for diagnostics. */
  raw: string
}

export interface LegacyHandshake {
  /** Session id used in the websocket upgrade path. */
  sid: string
  /** Server heartbeat timeout, in milliseconds. */
  heartbeatTimeoutMs: number
  /** Server close timeout, in milliseconds. */
  closeTimeoutMs: number
  /** Transports advertised by the server, e.g. `['websocket', 'xhr-polling']`. */
  transports: string[]
}

export interface LegacySocketOptions {
  /** e.g. https://latex.cstcloud.cn/ (sub-paths such as https://host/overleaf/ are fine) */
  baseUrl: string
  /** Full Cookie request header value. */
  cookie: string
  projectId: string
  /** Total budget for `connect()`, 15000 ms by default. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Debug sink, silent by default. */
  onDebug?: (message: string) => void
}

export interface LegacyJoinProjectResult {
  /** Full payload of `joinProjectResponse` (its first argument). */
  payload: unknown
  /** Socket id of this connection (the handshake sid). */
  socketId: string
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

function cancelledError(label: string): OverleafSyncError {
  return new OverleafSyncError(
    'E_TRANSPORT',
    `${label} was cancelled`,
    'the operation was aborted by the caller',
  )
}

function networkFailure(error: unknown, label: string): OverleafSyncError {
  if (isOverleafError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new OverleafSyncError(
    'E_TRANSPORT',
    `${label} failed: ${message || 'network error'}`,
    'check the Overleaf baseUrl, network connectivity and proxy settings, then retry',
  )
}

function timedOutError(label: string, ms: number): OverleafSyncError {
  return new OverleafSyncError(
    'E_TIMEOUT',
    `${label} timed out after ${Math.round(ms)} ms`,
    'check that the self-hosted Overleaf server is reachable and the Cookie is still valid, then retry',
  )
}

function isTimeoutError(error: unknown): boolean {
  return isOverleafError(error) && error.code === 'E_TIMEOUT'
}

function sleep(ms: number, capMs: number): Promise<void> {
  const budget = Math.max(1, Math.min(ms, capMs))
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budget)
    timer.unref()
  })
}

/**
 * The fork's proxy balances websocket upgrades without sticky sessions: an
 * upgrade that lands on a backend which never saw our handshake is answered
 * with `7:::1+0` (`client not handshaken` / `reconnect`) and hung up.
 */
function upgradeRefusedError(raw: string): OverleafSyncError {
  return new OverleafSyncError(
    'E_TRANSPORT',
    `socket.io server error frame: ${raw}`,
    'the proxy in front of Overleaf kept routing the websocket upgrade to a backend that did not know the handshake; retry the connection, or configure sticky sessions on the proxy',
  )
}

// ---------------------------------------------------------------------------
// Socket.IO 0.9 packets (protocol 1 framing)
// ---------------------------------------------------------------------------

/** `5:::<json>` (or `5:<ackId>+::<json>` when an ack callback is expected). */
export function encodeEventPacket(event: string, args: unknown[] = [], ackId?: string): string {
  const payload: { name: string; args?: unknown[] } = { name: event }
  if (args.length > 0) payload.args = args
  const id = ackId === undefined ? '' : `${ackId}+`
  return joinPacket(5, id, '', JSON.stringify(payload))
}

/** `6:::<ackId>+[args...]` — the reply to an event that requested an ack. */
export function encodeAckPacket(ackId: string, args: unknown[] = []): string {
  const data = args.length > 0 ? `${ackId}+${JSON.stringify(args)}` : ackId
  return joinPacket(6, '', '', data)
}

/** `2::` */
export function encodeHeartbeatPacket(): string {
  return joinPacket(2, '', '')
}

/** `1::` (default namespace) or `1::<endpoint>`. */
export function encodeConnectPacket(endpoint = ''): string {
  return joinPacket(1, '', endpoint)
}

/** `0::` */
export function encodeDisconnectPacket(endpoint = ''): string {
  return joinPacket(0, '', endpoint)
}

/** `7:::<reasonIndex>(+<adviceIndex>)?` */
export function encodeErrorPacket(reasonIndex: number, adviceIndex?: number): string {
  const data = adviceIndex === undefined ? String(reasonIndex) : `${reasonIndex}+${adviceIndex}`
  return joinPacket(7, '', '', data)
}

function joinPacket(typeIndex: number, id: string, endpoint: string, data?: string): string {
  const parts = [String(typeIndex), id, endpoint]
  if (data !== undefined) parts.push(data)
  return parts.join(':')
}

const PACKET_PATTERN = /([^:]+):([0-9]+)?(\+)?:([^:]+)?:?([\s\S]*)?/
const ACK_PATTERN = /^([0-9]+)(\+)?([\s\S]*)/

/**
 * Decode one Socket.IO 0.9 packet. Returns `undefined` for a packet whose type
 * digit is unknown (the 0.9 client behaves the same way: it drops it).
 */
export function decodePacket(raw: string): SioPacket | undefined {
  const match = PACKET_PATTERN.exec(raw)
  if (!match) return undefined
  const typeName = PACKET_TYPES[Number(match[1])]
  if (typeName === undefined) return undefined

  const id = match[2] ?? ''
  const ackData = Boolean(match[3])
  const endpoint = match[4] ?? ''
  const payload = match[5] ?? ''
  const packet: SioPacket = { type: typeName, id, endpoint, ackData, raw: payload }

  switch (typeName) {
    case 'error': {
      const [reasonPart, advicePart] = payload.split('+')
      const reason = ERROR_REASONS[Number(reasonPart)] ?? ''
      const advice = ERROR_ADVICE[Number(advicePart)] ?? ''
      if (reason.length > 0) packet.reason = reason
      if (advice.length > 0) packet.advice = advice
      return packet
    }
    case 'message': {
      packet.data = payload
      return packet
    }
    case 'event': {
      try {
        const parsed = JSON.parse(payload) as { name?: unknown; args?: unknown }
        if (typeof parsed.name === 'string') packet.name = parsed.name
        if (Array.isArray(parsed.args)) packet.args = parsed.args
      } catch {
        // Malformed JSON: keep the packet but with no name/args, like 0.9 does.
      }
      packet.args = packet.args ?? []
      return packet
    }
    case 'json': {
      try {
        packet.data = JSON.parse(payload)
      } catch {
        // ignore malformed json payloads
      }
      return packet
    }
    case 'connect': {
      packet.data = payload
      return packet
    }
    case 'ack': {
      const ackMatch = ACK_PATTERN.exec(payload)
      if (ackMatch) {
        packet.ackId = ackMatch[1] ?? ''
        const rest = ackMatch[3] ?? ''
        packet.args = []
        if (rest.length > 0) {
          try {
            const parsed = JSON.parse(rest) as unknown
            packet.args = Array.isArray(parsed) ? parsed : [parsed]
          } catch {
            // ignore malformed ack payloads
          }
        }
      }
      return packet
    }
    default:
      return packet
  }
}

const BATCH_MARK = '\ufffd'

/**
 * Decode a transport payload. Socket.IO 0.9 batches several packets into one
 * websocket frame as `\ufffd<length>\ufffd<packet>…`; a plain frame is a single
 * packet. Both shapes are handled (same algorithm as the 0.9 client).
 */
export function decodePayload(data: string): SioPacket[] {
  const packets: SioPacket[] = []
  if (data.charAt(0) === BATCH_MARK) {
    // Wire form: `\ufffd<len>\ufffd<packet>` per packet, so the mark that ends
    // one packet opens the next length field (same walk as the 0.9 client).
    let i = 1
    while (i < data.length) {
      let length = ''
      while (i < data.length && data.charAt(i) !== BATCH_MARK) {
        length += data.charAt(i)
        i += 1
      }
      const size = Number(length)
      if (!Number.isFinite(size) || size <= 0) break
      const packet = decodePacket(data.substr(i + 1, size))
      if (packet) packets.push(packet)
      i += size + 2
    }
    return packets
  }
  const packet = decodePacket(data)
  return packet ? [packet] : []
}

/**
 * Parse the Socket.IO 0.9 handshake body:
 * `<sid>:<heartbeat seconds>:<close seconds>:<transport,transport,…>`.
 */
export function parseHandshakeResponse(body: string): LegacyHandshake {
  const text = (body ?? '').trim()
  const parts = text.split(':')
  const sid = parts[0] ?? ''
  const heartbeat = Number(parts[1] ?? '')
  const closeTimeout = Number(parts[2] ?? '')
  const badBody = (): OverleafSyncError =>
    new OverleafSyncError(
      'E_TRANSPORT',
      `socket.io handshake returned an unexpected body: ${clip(text, 120) || '<empty>'}`,
      'the Cookie may be rejected by this server, or it does not expose a Socket.IO 0.9 endpoint; verify baseUrl and log in again',
    )
  if (parts.length < 3 || sid.length === 0 || sid.includes('<')) throw badBody()
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) throw badBody()
  if (!Number.isFinite(closeTimeout) || closeTimeout <= 0) throw badBody()
  const transports = (parts[3] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return {
    sid,
    heartbeatTimeoutMs: heartbeat * 1000,
    closeTimeoutMs: closeTimeout * 1000,
    transports,
  }
}

// ---------------------------------------------------------------------------
// RFC6455 framing
// ---------------------------------------------------------------------------

export interface WebSocketFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** `base64(sha1(<key> + <guid>))`, the value the server must echo back. */
export function acceptKeyFor(secWebSocketKey: string): string {
  return createHash('sha1').update(`${secWebSocketKey}${WS_GUID}`).digest('base64')
}

/**
 * Encode a client-to-server frame. Client frames are always masked, as the RFC
 * requires, and all three payload length forms (7 bit / 16 bit / 64 bit) are
 * supported because a joinProject response easily exceeds 125 bytes.
 */
export function encodeWebSocketFrame(
  payload: string | Buffer,
  options: { opcode?: number; fin?: boolean } = {},
): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const opcode = options.opcode ?? WS_OPCODE.TEXT
  const fin = options.fin !== false
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i]! ^ mask[i & 3]!

  let header: Buffer
  if (data.length < 126) {
    header = Buffer.from([firstByte, 0x80 | data.length])
  } else if (data.length < 65_536) {
    header = Buffer.allocUnsafe(4)
    header[0] = firstByte
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = firstByte
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

/**
 * Incremental frame reader. Feed it whatever arrives on the socket; it returns
 * every frame that became complete and keeps the rest buffered. Handles masked
 * and unmasked (server) frames plus 16/64 bit extended lengths.
 */
export class WebSocketFrameParser {
  #buffer: Buffer = Buffer.alloc(0)

  /** Bytes buffered from an incomplete frame. */
  get bufferedBytes(): number {
    return this.#buffer.length
  }

  push(chunk: Buffer): WebSocketFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames: WebSocketFrame[] = []
    for (;;) {
      const frame = this.#readOne()
      if (frame === undefined) break
      frames.push(frame)
    }
    return frames
  }

  #readOne(): WebSocketFrame | undefined {
    const buffer = this.#buffer
    if (buffer.length < 2) return undefined
    const first = buffer[0] ?? 0
    const second = buffer[1] ?? 0
    if ((first & 0x70) !== 0) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'websocket frame used an unsupported RSV bit',
        'the server spoke a websocket extension we did not negotiate; retry the connection',
      )
    }
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      const extended = buffer.readBigUInt64BE(2)
      if (extended > BigInt(MAX_FRAME_BYTES)) {
        throw new OverleafSyncError('E_TRANSPORT', 'websocket frame was too large to handle')
      }
      length = Number(extended)
      offset = 10
    }
    if (length > MAX_FRAME_BYTES) {
      throw new OverleafSyncError('E_TRANSPORT', 'websocket frame was too large to handle')
    }
    const maskOffset = offset
    if (masked) offset += 4
    if (buffer.length < offset + length) return undefined

    let payload: Buffer
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4)
      payload = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) {
        payload[i] = (buffer[offset + i] ?? 0) ^ (mask[i & 3] ?? 0)
      }
    } else {
      // Copy out of the receive buffer before slicing it away.
      payload = Buffer.from(buffer.subarray(offset, offset + length))
    }
    this.#buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number
  headers: IncomingHttpHeaders
  body: string
}

function requestOptions(
  url: URL,
  headers: Record<string, string>,
): {
  method: string
  protocol: string
  hostname: string
  port: number | undefined
  path: string
  headers: Record<string, string>
  agent: false
} {
  return {
    method: 'GET',
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port === '' ? undefined : Number(url.port),
    path: `${url.pathname}${url.search}`,
    headers,
    agent: false,
  }
}

function handshakeFailure(status: number, location?: string): OverleafSyncError {
  const auth = authErrorFor(status)
  if (auth) return auth
  if (status >= 300 && status < 400) {
    return new OverleafSyncError(
      'E_AUTH_EXPIRED',
      `socket.io handshake was redirected to ${location ?? 'the login page'}`,
      'run overleaf_login again with a fresh Cookie + CSRF token',
    )
  }
  if (status === 404) {
    return new OverleafSyncError(
      'E_TRANSPORT',
      'socket.io handshake returned HTTP 404',
      'this server does not expose /socket.io/1/; check the baseUrl (including any sub-path) and that the instance really runs Socket.IO 0.9',
    )
  }
  return new OverleafSyncError(
    'E_TRANSPORT',
    `socket.io handshake returned HTTP ${status}`,
    'check the self-hosted Overleaf server and retry',
  )
}

function httpGet(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
  label = 'socket.io handshake',
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let request: ClientRequest | undefined
    const onAbort = (): void => fail(cancelledError(label))
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        request?.destroy()
      } catch {
        // already destroyed
      }
      reject(error)
    }
    timer = setTimeout(() => fail(timedOutError(label, timeoutMs)), timeoutMs)
    timer.unref()
    if (signal !== undefined) {
      if (signal.aborted) {
        fail(cancelledError(label))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const options = requestOptions(url, headers)
      request = url.protocol === 'http:' ? httpRequest(options) : httpsRequest(options)
    } catch (error) {
      fail(networkFailure(error, label))
      return
    }
    request.on('error', (error) => fail(networkFailure(error, label)))
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > HANDSHAKE_MAX_BYTES) {
          response.destroy()
          fail(new OverleafSyncError('E_TRANSPORT', `${label} returned an oversized body`))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', (error) => fail(networkFailure(error, label)))
      response.on('end', () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.end()
  })
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type EventListener = (payload: unknown) => void
type ArgsListener = (args: unknown[]) => void

interface Waiter {
  resolve: (key: string, payload: unknown) => void
  reject: (error: Error) => void
}

interface WaitResult {
  key: string
  payload: unknown
}

/** Internal wait keys (a real event name can never contain a newline). */
const CONNECT_WAIT_KEY = 'packet:connect'
const EVENT_WAIT_PREFIX = 'event:'
const ACK_WAIT_PREFIX = 'ack:'
/** Resolved when the proxy answers an upgrade with `7:::1+0` (retryable). */
const UPGRADE_REJECTED_KEY = 'connect:rejected'
const JOIN_RESPONSE_EVENT = 'joinProjectResponse'
const JOIN_EVENT_WAIT_KEY = `${EVENT_WAIT_PREFIX}${JOIN_RESPONSE_EVENT}`

/**
 * The sharelatex fork pushes `1::` and `joinProjectResponse` by itself right
 * after the upgrade, so give it a moment before falling back to the packets
 * the documented 0.9 flow sends.
 */
const AUTO_PUSH_GRACE_MS = 250
/**
 * The proxy in front of the fork load balances upgrades without sticky
 * sessions, so an upgrade sometimes lands on a backend that never saw our
 * handshake; it answers `7:::1+0` and hangs up. The sid stays valid, so the
 * same sid is worth retrying a few times before a new handshake.
 */
const UPGRADE_ATTEMPTS_PER_SID = 4
const UPGRADE_RETRY_DELAY_MS = 75
const MIN_RETRY_BUDGET_MS = 250

/** `joinProjectResponse` carries the project as its single argument. */
function firstPayload(args: unknown[]): unknown {
  if (args.length === 1) return args[0]
  if (args.length === 0) return undefined
  return args
}

export class LegacyOverleafSocket {
  readonly #origin: string
  readonly #prefix: string
  readonly #cookie: string
  readonly #projectId: string
  readonly #timeoutMs: number
  readonly #signal: AbortSignal | undefined
  readonly #onDebug: ((message: string) => void) | undefined

  #socket: Duplex | undefined
  #frames = new WebSocketFrameParser()
  #closed = false
  #retrying = false
  #sid = ''
  #joined = false
  #joinResult: LegacyJoinProjectResult | undefined
  #pendingJoinSeen = false
  #pendingJoinPayload: unknown
  #connectSeen = false
  #upgradeRejection: string | undefined
  #lastRejection: OverleafSyncError | undefined
  #ackSeq = 0
  #heartbeatTimer: NodeJS.Timeout | undefined
  #fragmentOpcode: number | undefined
  #fragment: Buffer[] = []
  readonly #listeners = new Map<string, Set<EventListener>>()
  readonly #argListeners = new Map<string, Set<ArgsListener>>()
  readonly #anyListeners = new Set<(event: string, args: unknown[]) => void>()
  readonly #waiters = new Map<string, Set<Waiter>>()

  private constructor(options: LegacySocketOptions) {
    const baseUrl = normalizeBaseUrl(options.baseUrl)
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new OverleafSyncError(
        'E_CONFIG',
        `invalid Overleaf baseUrl: ${options.baseUrl}`,
        'pass an http(s) origin, e.g. https://www.overleaf.com',
      )
    }
    const cookie = normalizeCookie(options.cookie ?? '')
    if (cookie.length === 0) {
      throw new OverleafSyncError(
        'E_CONFIG',
        'Overleaf credential is missing the Cookie',
        'run overleaf_login again to store a fresh Cookie',
      )
    }
    const projectId = (options.projectId ?? '').trim()
    if (projectId.length === 0) {
      throw new OverleafSyncError(
        'E_CONFIG',
        'Legacy socket connect() requires a projectId',
        'pass the Overleaf project id, e.g. the 24-hex id from the project URL',
      )
    }
    this.#origin = `${url.protocol}//${url.host}`
    this.#prefix = url.pathname.replace(/\/+$/, '')
    this.#cookie = cookie
    this.#projectId = projectId
    this.#timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : CONNECT_BUDGET_MS
    this.#signal = options.signal
    this.#onDebug = options.onDebug
  }

  /**
   * Handshake, upgrade to websocket, connect the default namespace, then wait
   * for `joinProjectResponse`. Resolves with a socket that is ready for events.
   */
  static async connect(options: LegacySocketOptions): Promise<LegacyOverleafSocket> {
    const socket = new LegacyOverleafSocket(options)
    try {
      await socket.#open()
      return socket
    } catch (error) {
      socket.close()
      throw isOverleafError(error) ? error : networkFailure(error, 'legacy socket connect')
    }
  }

  /** The project this socket joined; throws before `connect()` succeeded. */
  get projectId(): string {
    if (!this.#joined) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'the legacy socket has not joined a project yet',
        'await LegacyOverleafSocket.connect(...) before reading projectId',
      )
    }
    return this.#projectId
  }

  /** Socket id of this connection (the handshake sid). */
  get socketId(): string {
    if (this.#sid.length === 0) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'the legacy socket has no session id yet',
        'await LegacyOverleafSocket.connect(...) before reading socketId',
      )
    }
    return this.#sid
  }

  /** True once `close()` ran or the peer closed the websocket. */
  get closed(): boolean {
    return this.#closed
  }

  /** Additive convenience: the stored joinProject payload. */
  get payload(): unknown {
    return this.#joinResult?.payload
  }

  /** Additive convenience: the stored joinProject result. */
  get joinProjectResult(): LegacyJoinProjectResult {
    if (this.#joinResult === undefined) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'the legacy socket has not joined a project yet',
        'await LegacyOverleafSocket.connect(...) before reading the join result',
      )
    }
    return this.#joinResult
  }

  /**
   * Register a listener. A one-argument event delivers that argument, a
   * zero-argument event delivers `undefined`, and a multi-argument event (e.g.
   * `joinDoc`) delivers the whole argument array.
   */
  on(event: string, listener: EventListener): () => void {
    if (typeof listener !== 'function') {
      throw new OverleafSyncError('E_CONFIG', 'on(event, listener) requires a function')
    }
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set<EventListener>()
      this.#listeners.set(event, set)
    }
    const target = set
    target.add(listener)
    return () => {
      target.delete(listener)
    }
  }

  /** Additive: like `on()` but always delivers the raw argument array. */
  onArgs(event: string, listener: ArgsListener): () => void {
    if (typeof listener !== 'function') {
      throw new OverleafSyncError('E_CONFIG', 'onArgs(event, listener) requires a function')
    }
    let set = this.#argListeners.get(event)
    if (set === undefined) {
      set = new Set<ArgsListener>()
      this.#argListeners.set(event, set)
    }
    const target = set
    target.add(listener)
    return () => {
      target.delete(listener)
    }
  }

  /** Additive: observe every event name the server pushes (diagnostics). */
  onAny(listener: (event: string, args: unknown[]) => void): () => void {
    if (typeof listener !== 'function') {
      throw new OverleafSyncError('E_CONFIG', 'onAny(listener) requires a function')
    }
    this.#anyListeners.add(listener)
    return () => {
      this.#anyListeners.delete(listener)
    }
  }

  /** Fire-and-forget event (`5:::<json>`). */
  emit(event: string, args: unknown[]): void {
    this.#assertOpen()
    this.#sendPacket(encodeEventPacket(event, Array.isArray(args) ? args : []))
  }

  /** Event with ack (`5:<id>+::<json>`), resolved by the server's `6:::` frame. */
  async emitWithAck<T>(event: string, args: unknown[], timeoutMs?: number): Promise<T[]> {
    this.#assertOpen()
    const budget =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : ACK_TIMEOUT_MS
    const ackId = String(++this.#ackSeq)
    const wait = this.#waitForAny(
      [`${ACK_WAIT_PREFIX}${ackId}`],
      budget,
      `an acknowledgement for "${event}"`,
    )
    this.#sendPacket(encodeEventPacket(event, Array.isArray(args) ? args : [], ackId))
    const result = await wait
    return (Array.isArray(result.payload) ? result.payload : [result.payload]) as T[]
  }

  /** Idempotent shutdown: stops the heartbeat, rejects pending acks, closes the socket. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = undefined
    }
    const socket = this.#socket
    this.#socket = undefined
    if (socket !== undefined) {
      try {
        socket.write(encodeWebSocketFrame(encodeDisconnectPacket()))
      } catch {
        // the peer may already be gone
      }
      try {
        socket.write(encodeWebSocketFrame(Buffer.alloc(0), { opcode: WS_OPCODE.CLOSE }))
      } catch {
        // same
      }
      try {
        socket.end()
      } catch {
        // same
      }
      try {
        socket.destroy()
      } catch {
        // same
      }
    }
    this.#failAll(
      new OverleafSyncError(
        'E_TRANSPORT',
        'the legacy socket was closed before the server answered',
        'reconnect with LegacyOverleafSocket.connect() and retry',
      ),
    )
  }

  // -- internals ------------------------------------------------------------

  #debug(message: string): void {
    this.#onDebug?.(`${DEBUG_PREFIX} ${message}`)
  }

  async #open(): Promise<void> {
    const startedAt = Date.now()
    const remaining = (): number => Math.max(1, this.#timeoutMs - (Date.now() - startedAt))
    const signal = this.#signal
    if (signal?.aborted) throw cancelledError('legacy socket connect')
    const onAbort = (): void => this.#failAll(cancelledError('legacy socket connect'))
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let handshake = await this.#handshake(remaining())
      this.#sid = handshake.sid
      this.#debug(
        `handshake ok sid=${clip(handshake.sid, 12)} heartbeat=${handshake.heartbeatTimeoutMs}ms transports=${handshake.transports.join(',') || '-'}`,
      )

      for (let attempt = 1; ; attempt += 1) {
        const rejection = await this.#attemptConnect(remaining())
        if (rejection === undefined) break
        this.#debug(`upgrade refused with ${clip(rejection, 60)}; retrying (attempt ${attempt})`)
        this.#resetTransport()
        const budget = remaining()
        if (budget <= MIN_RETRY_BUDGET_MS) {
          throw this.#lastRejection ?? upgradeRefusedError(rejection)
        }
        if (attempt % UPGRADE_ATTEMPTS_PER_SID === 0) {
          handshake = await this.#handshake(budget)
          this.#sid = handshake.sid
          this.#debug(`handshake renewed sid=${clip(handshake.sid, 12)}`)
        }
        await sleep(Math.min(UPGRADE_RETRY_DELAY_MS, remaining()), remaining())
      }
      this.#startHeartbeat()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One websocket attempt: upgrade, wait for the fork's own `1::` (falling back
   * to sending it), then joinProject unless the fork already pushed the
   * response. Returns the raw `7:::` frame when the proxy routed the upgrade to
   * a backend that never saw our handshake, so the caller can retry the sid.
   */
  async #attemptConnect(budgetMs: number): Promise<string | undefined> {
    const { socket, head } = await this.#upgrade(this.#sid, budgetMs)
    this.#attach(socket)
    if (head.length > 0) this.#onBytes(head)
    socket.resume()

    const race = (budget: number): Promise<WaitResult> =>
      this.#waitForAny(
        [CONNECT_WAIT_KEY, JOIN_EVENT_WAIT_KEY, UPGRADE_REJECTED_KEY],
        budget,
        'the socket.io connect acknowledgement',
      )

    // The upgrade response can already carry `1::` or a refusal (they arrive in
    // the same TCP segment), so look at what the server pushed before waiting.
    let ready = this.#earlyConnect()
    if (ready === undefined) {
      try {
        ready = await race(Math.min(budgetMs, AUTO_PUSH_GRACE_MS))
      } catch (error) {
        if (!isTimeoutError(error)) throw error
      }
    }
    if (ready === undefined) {
      // Nothing was pushed: run the documented 0.9 flow instead.
      const connected = race(budgetMs)
      this.#sendPacket(encodeConnectPacket())
      ready = await connected
    }
    if (ready.key === UPGRADE_REJECTED_KEY) return String(ready.payload)
    if (ready.key === CONNECT_WAIT_KEY) this.#debug('default namespace connected')

    // The fork pushes joinProjectResponse ~30 ms after its own `1::`, so give
    // it a moment before sending a joinProject the server already answered.
    if (!this.#pendingJoinSeen && ready.key === CONNECT_WAIT_KEY) {
      try {
        await this.#waitForAny(
          [JOIN_EVENT_WAIT_KEY],
          Math.min(budgetMs, AUTO_PUSH_GRACE_MS),
          JOIN_RESPONSE_EVENT,
        )
      } catch (error) {
        if (!isTimeoutError(error)) throw error
      }
    }

    if (this.#pendingJoinSeen) {
      this.#completeJoin(this.#pendingJoinPayload)
      this.#debug('joinProjectResponse was pushed by the server')
      return undefined
    }

    const ackId = String(++this.#ackSeq)
    const joined = this.#waitForAny(
      [JOIN_EVENT_WAIT_KEY, `${ACK_WAIT_PREFIX}${ackId}`],
      budgetMs,
      JOIN_RESPONSE_EVENT,
    )
    this.#sendPacket(encodeEventPacket('joinProject', [this.#joinPayload()], ackId))
    const result = await joined
    const payload = result.key.startsWith(ACK_WAIT_PREFIX)
      ? firstPayload(Array.isArray(result.payload) ? result.payload : [result.payload])
      : result.payload
    this.#completeJoin(payload)
    this.#debug(`joinProject completed via ${result.key}`)
    return undefined
  }

  #completeJoin(payload: unknown): void {
    this.#joinResult = { payload, socketId: this.#sid }
    this.#joined = true
    this.#pendingJoinSeen = false
    this.#pendingJoinPayload = undefined
  }

  /** Whatever the server already pushed before we started waiting for it. */
  #earlyConnect(): WaitResult | undefined {
    if (this.#pendingJoinSeen) return { key: JOIN_EVENT_WAIT_KEY, payload: this.#pendingJoinPayload }
    if (this.#connectSeen) return { key: CONNECT_WAIT_KEY, payload: undefined }
    if (this.#upgradeRejection !== undefined) {
      return { key: UPGRADE_REJECTED_KEY, payload: this.#upgradeRejection }
    }
    return undefined
  }

  /** Drop the current transport so the next attempt starts from a clean slate. */
  #resetTransport(): void {
    this.#retrying = true
    const socket = this.#socket
    this.#socket = undefined
    this.#frames = new WebSocketFrameParser()
    this.#fragmentOpcode = undefined
    this.#fragment = []
    this.#closed = false
    this.#pendingJoinSeen = false
    this.#pendingJoinPayload = undefined
    this.#connectSeen = false
    this.#upgradeRejection = undefined
    if (socket === undefined) return
    try {
      socket.destroy()
    } catch {
      // already gone
    }
  }

  #joinPayload(): Record<string, unknown> {
    return {
      project_id: this.#projectId,
      user_id: null,
      client_now: new Date().toISOString(),
    }
  }

  #requestHeaders(): Record<string, string> {
    return {
      Cookie: this.#cookie,
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      'User-Agent': USER_AGENT,
    }
  }

  async #handshake(budgetMs: number): Promise<LegacyHandshake> {
    const url = new URL(`${this.#prefix}/socket.io/1/`, this.#origin)
    url.searchParams.set('projectId', this.#projectId)
    url.searchParams.set('t', String(Date.now()))
    this.#debug(`GET ${url.pathname}${url.search}`)
    const response = await httpGet(url, this.#requestHeaders(), budgetMs)
    if (response.statusCode !== 200) {
      const location =
        typeof response.headers.location === 'string' ? response.headers.location : undefined
      throw handshakeFailure(response.statusCode, location)
    }
    return parseHandshakeResponse(response.body)
  }

  #upgrade(sid: string, budgetMs: number): Promise<{ socket: Duplex; head: Buffer }> {
    const url = new URL(`${this.#prefix}/socket.io/1/websocket/${encodeURIComponent(sid)}`, this.#origin)
    const secWebSocketKey = randomBytes(16).toString('base64')
    const expectedAccept = acceptKeyFor(secWebSocketKey)
    const headers: Record<string, string> = {
      ...this.#requestHeaders(),
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': secWebSocketKey,
      Origin: this.#origin,
    }
    const label = 'websocket upgrade'
    this.#debug(`GET ${url.pathname} (upgrade)`)
    return new Promise<{ socket: Duplex; head: Buffer }>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      let request: ClientRequest | undefined
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        action()
      }
      const fail = (error: Error): void => {
        finish(() => {
          try {
            request?.destroy()
          } catch {
            // already gone
          }
          reject(error)
        })
      }
      timer = setTimeout(() => fail(timedOutError(label, budgetMs)), budgetMs)
      timer.unref()

      try {
        const options = requestOptions(url, headers)
        request = url.protocol === 'http:' ? httpRequest(options) : httpsRequest(options)
      } catch (error) {
        fail(networkFailure(error, label))
        return
      }
      request.on('error', (error) => fail(networkFailure(error, label)))
      request.on('upgrade', (response, socket, head) => {
        const headerValue = response.headers['sec-websocket-accept']
        const accept = Array.isArray(headerValue) ? headerValue[0] : headerValue
        if (response.statusCode !== 101 || accept !== expectedAccept) {
          try {
            socket.destroy()
          } catch {
            // already gone
          }
          fail(
            new OverleafSyncError(
              'E_TRANSPORT',
              `websocket upgrade was rejected (HTTP ${response.statusCode ?? 0}, Sec-WebSocket-Accept ${accept ?? 'missing'})`,
              'the proxy in front of Overleaf may be blocking the websocket upgrade; check its Upgrade/Connection forwarding',
            ),
          )
          return
        }
        this.#debug('websocket upgraded')
        socket.setNoDelay(true)
        // Hold data until the caller attached its listeners.
        socket.pause()
        finish(() => resolve({ socket, head }))
      })
      request.on('response', (response) => {
        response.resume()
        const location =
          typeof response.headers.location === 'string' ? response.headers.location : undefined
        fail(handshakeFailure(response.statusCode ?? 0, location))
      })
      request.end()
    })
  }

  #attach(socket: Duplex): void {
    this.#socket = socket
    this.#retrying = false
    socket.on('data', (chunk: Buffer) => this.#onBytes(chunk))
    socket.on('error', (error: Error) => {
      if (this.#retrying || this.#closed) return
      this.#debug(`socket error: ${error.message}`)
      this.#failAll(networkFailure(error, 'websocket connection'))
      this.close()
    })
    socket.on('end', () => this.#onPeerGone('the peer ended the websocket connection'))
    socket.on('close', () => this.#onPeerGone('the websocket connection closed'))
  }

  #onPeerGone(reason: string): void {
    if (this.#closed || this.#retrying) return
    this.#debug(reason)
    const error = new OverleafSyncError(
      'E_TRANSPORT',
      `${reason} before the operation completed`,
      'reconnect with LegacyOverleafSocket.connect() and retry',
    )
    this.#failAll(error)
    this.close()
  }

  #onBytes(chunk: Buffer): void {
    let frames: WebSocketFrame[]
    try {
      frames = this.#frames.push(chunk)
    } catch (error) {
      this.#debug(`frame error: ${error instanceof Error ? error.message : String(error)}`)
      this.#failAll(networkFailure(error, 'websocket frame'))
      this.close()
      return
    }
    for (const frame of frames) this.#onFrame(frame)
  }

  #onFrame(frame: WebSocketFrame): void {
    switch (frame.opcode) {
      case WS_OPCODE.TEXT: {
        if (this.#fragmentOpcode !== undefined) {
          this.#debug('dropped a text frame inside a fragmented message')
          return
        }
        if (frame.fin) {
          this.#onText(frame.payload.toString('utf8'))
          return
        }
        this.#fragmentOpcode = WS_OPCODE.TEXT
        this.#fragment = [frame.payload]
        return
      }
      case WS_OPCODE.BINARY: {
        // Overleaf 0.9 never sends binary; swallow fragments so they cannot
        // corrupt the next text message.
        if (!frame.fin) {
          this.#fragmentOpcode = WS_OPCODE.BINARY
          this.#fragment = [frame.payload]
        }
        return
      }
      case WS_OPCODE.CONTINUATION: {
        if (this.#fragmentOpcode === undefined) return
        this.#fragment.push(frame.payload)
        if (!frame.fin) return
        const opcode = this.#fragmentOpcode
        const data = Buffer.concat(this.#fragment)
        this.#fragmentOpcode = undefined
        this.#fragment = []
        if (opcode === WS_OPCODE.TEXT) this.#onText(data.toString('utf8'))
        return
      }
      case WS_OPCODE.PING: {
        this.#writeRaw(encodeWebSocketFrame(frame.payload, { opcode: WS_OPCODE.PONG }))
        return
      }
      case WS_OPCODE.PONG:
        return
      case WS_OPCODE.CLOSE: {
        this.#debug('server sent a close frame')
        this.close()
        return
      }
      default:
        return
    }
  }

  #onText(text: string): void {
    this.#debug(`recv ${clip(text, 180)}`)
    for (const packet of decodePayload(text)) this.#onPacket(packet)
  }

  #onPacket(packet: SioPacket): void {
    switch (packet.type) {
      case 'connect': {
        if (packet.endpoint.length === 0) {
          this.#connectSeen = true
          this.#resolveWaiters(CONNECT_WAIT_KEY, packet)
        }
        return
      }
      case 'heartbeat': {
        this.#sendPacket(encodeHeartbeatPacket())
        return
      }
      case 'event': {
        const name = packet.name ?? ''
        if (name.length === 0) return
        const args = packet.args ?? []
        const payload = firstPayload(args)
        if (name === JOIN_RESPONSE_EVENT && !this.#joined && !this.#pendingJoinSeen) {
          this.#pendingJoinSeen = true
          this.#pendingJoinPayload = payload
        }
        this.#resolveWaiters(`${EVENT_WAIT_PREFIX}${name}`, payload)
        this.#dispatch(name, args, payload)
        return
      }
      case 'ack': {
        const ackId = packet.ackId ?? ''
        if (ackId.length === 0) return
        this.#resolveWaiters(`${ACK_WAIT_PREFIX}${ackId}`, packet.args ?? [])
        return
      }
      case 'error': {
        // Rebuild the wire frame so the message keeps what the server sent.
        const raw = `7:::${packet.raw}`
        this.#debug(`error frame ${clip(raw, 120)}`)
        if (!this.#joined && packet.reason === 'client not handshaken' && packet.advice === 'reconnect') {
          // Retryable while connecting: the proxy sent the upgrade to a
          // backend that does not know this sid. The sid itself stays valid.
          this.#lastRejection = upgradeRefusedError(raw)
          this.#upgradeRejection = raw
          this.#resolveWaiters(UPGRADE_REJECTED_KEY, raw)
          return
        }
        const error = new OverleafSyncError(
          'E_TRANSPORT',
          `socket.io server error frame: ${raw}`,
          `the server reported "${packet.reason ?? 'an unknown error'}"${packet.advice ? ` and advised "${packet.advice}"` : ''}; log in again or retry the connection`,
        )
        this.#failAll(error)
        this.#dispatch('error', [error], error)
        return
      }
      case 'disconnect': {
        this.#debug('server disconnected the namespace')
        this.close()
        return
      }
      default:
        return
    }
  }

  #dispatch(name: string, args: unknown[], payload: unknown): void {
    const listeners = this.#listeners.get(name)
    if (listeners !== undefined) {
      for (const listener of [...listeners]) {
        try {
          listener(payload)
        } catch (error) {
          this.#debug(`listener for "${name}" threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const argListeners = this.#argListeners.get(name)
    if (argListeners !== undefined) {
      for (const listener of [...argListeners]) {
        try {
          listener(args)
        } catch (error) {
          this.#debug(`onArgs listener for "${name}" threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    for (const listener of [...this.#anyListeners]) {
      try {
        listener(name, args)
      } catch (error) {
        this.#debug(`onAny listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  #sendPacket(text: string): void {
    this.#debug(`send ${clip(text, 180)}`)
    this.#writeRaw(encodeWebSocketFrame(text))
  }

  #writeRaw(frame: Buffer): void {
    const socket = this.#socket
    if (socket === undefined || socket.destroyed) return
    try {
      socket.write(frame)
    } catch (error) {
      this.#debug(`write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#socket === undefined) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        'the legacy socket is closed',
        'reconnect with LegacyOverleafSocket.connect() and retry',
      )
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer)
    const timer = setInterval(() => this.#sendPacket(encodeHeartbeatPacket()), HEARTBEAT_INTERVAL_MS)
    timer.unref()
    this.#heartbeatTimer = timer
    this.#debug(`heartbeat every ${HEARTBEAT_INTERVAL_MS} ms`)
  }

  #resolveWaiters(key: string, payload: unknown): boolean {
    const set = this.#waiters.get(key)
    if (set === undefined || set.size === 0) return false
    this.#waiters.delete(key)
    for (const waiter of [...set]) waiter.resolve(key, payload)
    return true
  }

  #failAll(error: Error): void {
    if (this.#waiters.size === 0) return
    const waiters = new Set<Waiter>()
    for (const set of this.#waiters.values()) {
      for (const waiter of set) waiters.add(waiter)
    }
    this.#waiters.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  /**
   * Resolve with whichever of `keys` fires first. Every key maps to one shape:
   * `packet:connect` → the connect packet, `event:<name>` → the first argument
   * (or the argument array for multi-argument events), `ack:<id>` → the ack
   * argument array.
   */
  #waitForAny(keys: string[], budgetMs: number, label: string): Promise<WaitResult> {
    return new Promise<WaitResult>((resolve, reject) => {
      let done = false
      let timer: NodeJS.Timeout | undefined
      const waiter: Waiter = {
        resolve: (key: string, payload: unknown) => finish(() => resolve({ key, payload })),
        reject: (error: Error) => finish(() => reject(error)),
      }
      const finish = (action: () => void): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        for (const key of keys) {
          const set = this.#waiters.get(key)
          if (set === undefined) continue
          set.delete(waiter)
          if (set.size === 0) this.#waiters.delete(key)
        }
        action()
      }
      for (const key of keys) {
        let set = this.#waiters.get(key)
        if (set === undefined) {
          set = new Set<Waiter>()
          this.#waiters.set(key, set)
        }
        set.add(waiter)
      }
      timer = setTimeout(() => waiter.reject(timedOutError(label, budgetMs)), budgetMs)
      timer.unref()
    })
  }
}

/** Matches `<sid>:<heartbeat>:<close>:<transports…>` — the 0.9 handshake body. */
const LEGACY_HANDSHAKE_PATTERN = /^[A-Za-z0-9_-]{6,}:\d+:\d+:/

/** Socket.IO protocol generation a baseUrl speaks. */
export type SocketProtocol = 'v4' | 'legacy'

/**
 * Read-only probe: which Socket.IO protocol does this baseUrl speak?
 * Falls back to `'v4'` on timeout, network error, non-200 or an unexpected body
 * so an existing v4 setup keeps its current behaviour.
 */
export async function detectSocketProtocol(
  baseUrl: string,
  options: { cookie?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SocketProtocol> {
  let origin: string
  let prefix: string
  try {
    const parsed = new URL(normalizeBaseUrl(baseUrl))
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'v4'
    origin = `${parsed.protocol}//${parsed.host}`
    prefix = parsed.pathname.replace(/\/+$/, '')
  } catch {
    return 'v4'
  }
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DETECT_TIMEOUT_MS
  if (options.signal?.aborted) return 'v4'
  const url = new URL(`${prefix}/socket.io/1/`, origin)
  url.searchParams.set('t', String(Date.now()))
  const headers: Record<string, string> = {
    Accept: '*/*',
    'User-Agent': USER_AGENT,
  }
  const cookie = normalizeCookie(options.cookie ?? '')
  if (cookie.length > 0) headers.Cookie = cookie
  try {
    const response = await httpGet(
      url,
      headers,
      timeoutMs,
      options.signal,
      'socket.io protocol probe',
    )
    if (response.statusCode !== 200) return 'v4'
    return LEGACY_HANDSHAKE_PATTERN.test(response.body.trim()) ? 'legacy' : 'v4'
  } catch {
    return 'v4'
  }
}
