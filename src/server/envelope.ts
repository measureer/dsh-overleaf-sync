/**
 * HTTP envelope shared by every `/overleaf/api/*` route (docs/m4a-api-contract.md §1).
 *
 * The browser only looks at `ok`; the status code exists for `fetch` semantics
 * and for logs, so the mapping lives here and nowhere else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { OverleafSyncError, describeError, isOverleafError } from '../core/errors.js'

export type ApiBody = Record<string, unknown>

export interface ApiFailure {
  ok: false
  code: string
  message: string
  hint?: string
}

export type ApiResult<T> = { ok: true; value: T } | ApiFailure

/** Request bodies are tiny JSON objects; anything bigger is a mistake. */
export const MAX_BODY_BYTES = 256 * 1024

/** Raised by a route for a client mistake we can name precisely. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly hint?: string

  constructor(code: string, message: string, status = 400, hint?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    if (hint !== undefined) this.hint = hint
  }
}

/** Status code per error code — keep in sync with the contract table. */
export function statusForCode(code: string): number {
  switch (code) {
    case 'E_AUTH_REQUIRED':
    case 'E_AUTH_EXPIRED':
    case 'E_AUTH_INVALID':
      return 401
    case 'E_CROSS_SITE':
    case 'E_APPROVAL_DENIED':
      return 403
    case 'E_NOT_LINKED':
    case 'E_PROJECT_NOT_FOUND':
      return 404
    case 'E_CONFLICT':
    case 'E_SETTINGS_CONFLICT':
    case 'E_BUSY':
      return 409
    case 'E_VALIDATION':
    case 'E_LOCAL_DIR_INVALID':
    case 'E_LOCAL_DIR_CONFIRM_REQUIRED':
    case 'E_CONFIRM_REQUIRED':
    case 'E_CONFIG':
      return 400
    default:
      return 500
  }
}

/** Normalise any thrown value into a status + envelope body. */
export function toFailure(err: unknown): { status: number; body: ApiFailure } {
  if (err instanceof ApiError) {
    const body: ApiFailure = { ok: false, code: err.code, message: err.message }
    if (err.hint !== undefined) body.hint = err.hint
    return { status: err.status, body }
  }
  if (isOverleafError(err)) {
    const body: ApiFailure = { ok: false, code: err.code, message: err.message }
    if (err.hint !== undefined) body.hint = err.hint
    return { status: statusForCode(err.code), body }
  }
  const message = describeError(err)
  return { status: 500, body: { ok: false, code: 'E_INTERNAL', message } }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function sendResult(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value } satisfies ApiResult<unknown>)
}

export function sendFailure(res: ServerResponse, err: unknown): void {
  const { status, body } = toFailure(err)
  sendJson(res, status, body)
}

/**
 * A browser page on another origin must not drive sync actions.
 *
 * `Sec-Fetch-Site` is sent by every current browser; a missing header means a
 * non-browser client (curl, tests, the DSH host itself), which is allowed.
 */
export function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site !== 'string') return false
  return site !== 'same-origin' && site !== 'none'
}

/** Read a JSON object body, enforcing size, content type and object-ness. */
export async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<ApiBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > limit) {
      throw new ApiError('E_VALIDATION', `request body exceeds ${limit} bytes`, 413, 'send a smaller payload')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError('E_VALIDATION', 'request body is not valid JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('E_VALIDATION', 'request body must be a JSON object', 400)
  }
  return parsed as ApiBody
}

/** Small helpers used by route bodies; all throw `E_VALIDATION` on bad input. */
export function requireString(body: ApiBody, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError('E_VALIDATION', `\`${key}\` must be a non-empty string`, 400)
  }
  return value
}

export function optionalString(body: ApiBody, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError('E_VALIDATION', `\`${key}\` must be a string`, 400)
  return value
}

export function optionalBoolean(body: ApiBody, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ApiError('E_VALIDATION', `\`${key}\` must be a boolean`, 400)
  return value
}

export function optionalNumber(body: ApiBody, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError('E_VALIDATION', `\`${key}\` must be a number`, 400)
  }
  return value
}

/** Re-export so route modules do not need to reach into core/errors. */
export { OverleafSyncError }
