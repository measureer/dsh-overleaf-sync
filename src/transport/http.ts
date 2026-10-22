import { authErrorFor, isOverleafError, OverleafSyncError } from '../core/errors.js'
import type { Credential, ProjectListEntry } from '../types.js'
import { normalizeBaseUrl } from './credentials.js'

const REQUEST_TIMEOUT_MS = 15_000
const USER_AGENT = 'dsh-overleaf-sync/0.1'

/** Result of validating a stored Overleaf session against the website. */
export interface WhoAmIResult {
  ok: boolean
  /** Login e-mail when the project page exposes it. */
  email?: string
  /** Short human hint (service layer renders it after "as ..."). */
  hint?: string
}

interface RawResponse {
  status: number
  location?: string
  text?: string
  bytes?: Uint8Array
}

interface SendInit {
  method?: string
  body?: string
  headers?: Record<string, string>
  redirect?: 'follow' | 'manual' | 'error'
}

interface Deadline {
  readonly signal: AbortSignal
  timedOut(): boolean
  dispose(): void
}

/** Abort after `timeoutMs`, also aborting when the caller's signal aborts. */
function withDeadline(callerSignal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()
  const onAbort = (): void => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onAbort)
    },
  }
}

function failureForStatus(status: number, label: string, location?: string): OverleafSyncError {
  const auth = authErrorFor(status)
  if (auth) return auth
  if (status === 404) {
    return new OverleafSyncError(
      'E_PROJECT_NOT_FOUND',
      `${label} returned HTTP 404`,
      'check the project/file id (and the baseUrl for self-hosted servers); make sure the account can open the project',
    )
  }
  if (status >= 300 && status < 400) {
    return new OverleafSyncError(
      'E_AUTH_EXPIRED',
      `${label} was redirected to ${location ?? 'the login page'}`,
      'run overleaf_login again with a fresh Cookie + CSRF token',
    )
  }
  if (status === 429) {
    return new OverleafSyncError(
      'E_TRANSPORT',
      `${label} was rate limited (HTTP 429)`,
      'wait a minute and retry; Overleaf throttles busy accounts',
    )
  }
  return new OverleafSyncError(
    'E_TRANSPORT',
    `${label} returned HTTP ${status}`,
    'Overleaf may be temporarily unavailable; retry in a moment',
  )
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

const META_TAG = /<meta\b[^>]*>/gi
const ATTR = (name: string): RegExp =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, 'i')

function readMeta(html: string, name: string): string | undefined {
  const tags = html.match(META_TAG)
  if (!tags) return undefined
  for (const tag of tags) {
    const nameMatch = ATTR('name').exec(tag)
    if (!nameMatch) continue
    const tagName = nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? ''
    if (tagName.toLowerCase() !== name.toLowerCase()) continue
    const contentMatch = ATTR('content').exec(tag)
    if (!contentMatch) continue
    return decodeHtmlEntities(contentMatch[1] ?? contentMatch[2] ?? contentMatch[3] ?? '')
  }
  return undefined
}

/**
 * Minimal Overleaf REST client. Everything goes through the global `fetch`
 * (Node 22+), a shared 15 s deadline, and `OverleafSyncError` for failures.
 */
export class OverleafHttp {
  private readonly baseUrl: string
  private readonly cookie: string
  private readonly csrfToken: string

  constructor(credential: Credential) {
    this.baseUrl = normalizeBaseUrl(credential.baseUrl)
    this.cookie = credential.cookie.trim()
    this.csrfToken = credential.csrfToken.trim()
    if (this.cookie.length === 0 || this.csrfToken.length === 0) {
      throw new OverleafSyncError(
        'E_CONFIG',
        'Overleaf credential is missing the Cookie or CSRF token',
        'run overleaf_login again to store a fresh Cookie + CSRF token',
      )
    }
  }

  /** `GET user/projects`, normalizing `_id` to `id` and dropping junk entries. */
  async listProjects(signal?: AbortSignal): Promise<ProjectListEntry[]> {
    const label = 'GET user/projects'
    const response = await this.send('user/projects', label, signal, 'text', {
      headers: { Accept: 'application/json' },
    })
    if (response.status < 200 || response.status >= 300) {
      throw failureForStatus(response.status, label, response.location)
    }

    let body: unknown
    try {
      body = JSON.parse(response.text ?? '')
    } catch {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `${label} returned malformed JSON`,
        'the baseUrl may point at the wrong server, or Overleaf changed its API',
      )
    }
    const rawList =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).projects
        : undefined
    if (!Array.isArray(rawList)) {
      throw new OverleafSyncError(
        'E_TRANSPORT',
        `${label} response did not contain a projects array`,
        'the baseUrl may point at the wrong server, or the session expired',
      )
    }

    const entries: ProjectListEntry[] = []
    for (const raw of rawList) {
      if (raw === null || typeof raw !== 'object') continue
      const record = raw as Record<string, unknown>
      const id =
        typeof record._id === 'string'
          ? record._id
          : typeof record.id === 'string'
            ? record.id
            : undefined
      const name = typeof record.name === 'string' ? record.name : undefined
      if (!id || !name) continue
      const entry: ProjectListEntry = { id, name }
      if (typeof record.lastUpdated === 'string') entry.lastUpdated = record.lastUpdated
      if (typeof record.archived === 'boolean') entry.archived = record.archived
      entries.push(entry)
    }
    return entries
  }

  /** `GET project/<id>/file/<fileId>` as raw bytes (PDFs, images, ...). */
  async downloadFile(
    projectId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const label = `GET project/${projectId}/file/${fileId}`
    const pathname = `project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`
    const response = await this.send(pathname, label, signal, 'bytes')
    if (response.status < 200 || response.status >= 300) {
      throw failureForStatus(response.status, label, response.location)
    }
    return response.bytes ?? new Uint8Array(0)
  }

  /**
   * Validate the stored session: fetch the project list page and read the
   * login e-mail + CSRF meta tags. 401/403 raise E_AUTH_EXPIRED; a redirect to
   * the login page returns `{ ok: false }` with a hint instead.
   */
  async whoami(signal?: AbortSignal): Promise<WhoAmIResult> {
    const label = 'GET project'
    const response = await this.send('project', label, signal, 'text', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    if (response.status === 401 || response.status === 403) {
      throw authErrorFor(response.status) ?? failureForStatus(response.status, label)
    }
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        hint: `Overleaf redirected to ${response.location ?? 'the login page'}; the stored Cookie is no longer accepted — copy a fresh one from a logged-in tab`,
      }
    }
    if (response.status < 200 || response.status >= 300) {
      throw failureForStatus(response.status, label, response.location)
    }

    const html = response.text ?? ''
    const csrfToken = readMeta(html, 'ol-csrfToken')
    const email = readMeta(html, 'ol-usersEmail')
    if (!csrfToken && !email) {
      return {
        ok: false,
        hint: 'the Overleaf page contained no session (no ol-csrfToken meta tag); the stored Cookie is not accepted',
      }
    }
    const result: WhoAmIResult = { ok: true }
    if (email) {
      result.email = email
      result.hint = email
    }
    return result
  }

  private async send(
    pathname: string,
    label: string,
    signal: AbortSignal | undefined,
    mode: 'text' | 'bytes',
    init: SendInit = {},
  ): Promise<RawResponse> {
    const url = new URL(pathname.replace(/^\/+/, ''), this.baseUrl)
    const gate = withDeadline(signal, REQUEST_TIMEOUT_MS)
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = {
      Cookie: this.cookie,
      Accept:
        init.headers?.Accept ??
        (mode === 'bytes' ? '*/*' : 'application/json, text/html;q=0.9, */*;q=0.8'),
      'User-Agent': USER_AGENT,
      ...init.headers,
    }
    if (method !== 'GET') headers['X-Csrf-Token'] = this.csrfToken

    try {
      let response: Response
      try {
        response = await fetch(url, {
          method,
          headers,
          redirect: init.redirect ?? 'manual',
          signal: gate.signal,
          ...(init.body === undefined ? {} : { body: init.body }),
        })
      } catch (error) {
        throw this.failureFromFetch(error, label, gate, signal)
      }

      const result: RawResponse = { status: response.status }
      const location = response.headers.get('location')
      if (location) result.location = location
      try {
        if (mode === 'bytes') result.bytes = new Uint8Array(await response.arrayBuffer())
        else result.text = await response.text()
      } catch (error) {
        throw this.failureFromFetch(error, label, gate, signal)
      }
      return result
    } finally {
      gate.dispose()
    }
  }

  private failureFromFetch(
    error: unknown,
    label: string,
    gate: Deadline,
    callerSignal?: AbortSignal,
  ): OverleafSyncError {
    if (gate.timedOut()) {
      return new OverleafSyncError(
        'E_TIMEOUT',
        `${label} timed out after ${REQUEST_TIMEOUT_MS} ms`,
        'check network/proxy access to Overleaf, then retry',
      )
    }
    if (callerSignal?.aborted) {
      return new OverleafSyncError(
        'E_TRANSPORT',
        `${label} was cancelled`,
        'the operation was aborted by the caller',
      )
    }
    if (isOverleafError(error)) return error
    const message = error instanceof Error ? error.message : String(error)
    return new OverleafSyncError(
      'E_TRANSPORT',
      `${label} failed: ${message || 'network error'}`,
      'check the Overleaf baseUrl, network connectivity and proxy settings, then retry',
    )
  }
}
