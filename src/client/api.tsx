/**
 * Client-side view of the host API contract (`docs/m4a-api-contract.md`).
 *
 * No runtime dependency on the host sources — only the shapes are mirrored here,
 * because the browser half ships separately from the node half.
 */

/** Failure envelope, mirroring `src/server/envelope.ts`. */
export interface ApiFailure {
  ok: false
  code: string
  message: string
  hint?: string
}

/** Success envelope. */
export interface ApiSuccess<T> {
  ok: true
  value: T
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure

/** Client-side failure code used when the response is not a DSH envelope at all. */
export const E_NO_ROUTE = 'E_NO_ROUTE'

/** Client-side failure code used when `fetch` itself failed. */
export const E_NETWORK = 'E_NETWORK'

/** `status` → StatusSummary. */
export interface StatusSummary {
  baseUrl: string
  authenticated: boolean
  credential?: {
    hint?: string
    savedAt?: string
  }
  current?: {
    projectId: string
    projectName: string
    localRoot: string
    files: number
    remoteVersion?: string
    lastPullAt?: string
    git?: {
      root: string
      mode: 'own' | 'parent' | 'none'
      head?: string
    }
  }
  projects: Array<{
    projectId: string
    projectName: string
    localRoot: string
    files: number
    linkedAt: string
  }>
  pending: {
    localChanges: number
    conflicts: number
  }
  text: string
}

/** `projects` → ProjectListEntry (note: a different shape from `StatusSummary.projects`). */
export interface ProjectListEntry {
  id: string
  name: string
  lastUpdated?: string
  archived?: boolean
}

/** One editable configuration field, as returned by `settings.describe`. */
export interface SettingsField {
  key: string
  type: 'string' | 'boolean' | 'number' | 'enum'
  value: unknown
  /** Optional presentation hints sent by the host (hit `settings.describe`), honored when present. */
  label?: string
  default?: unknown
  group?: 'strategy' | 'advanced'
  options?: string[]
  min?: number
  max?: number
  description?: string
}

/** `settings.describe` / `settings.update` → SettingsView. */
export interface SettingsView {
  writable: boolean
  revision: number
  fields: SettingsField[]
}

/** `validate-path` → PathValidation. */
export interface PathValidation {
  ok: boolean
  resolved: string
  problems: string[]
}

/** `login` → login view. */
export interface LoginView {
  baseUrl: string
  hint?: string
}

/** `logout` → logout view. */
export interface LogoutView {
  text: string
}

/** `link` → LinkRecord (only the fields the settings page reads). */
export interface LinkRecord {
  projectId: string
  projectName?: string
  localRoot: string
  files?: number
  linkedAt?: string
}

/** A JSON value sent as a settings patch entry. */
export type FieldValue = string | boolean | number

const ENDPOINT = '/overleaf/api/'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Narrow an unknown JSON body to an API envelope. */
export function isEnvelope(value: unknown): value is ApiResult<unknown> {
  if (!isRecord(value)) return false
  if (value.ok === true) return 'value' in value
  if (value.ok === false) return typeof value.code === 'string'
  return false
}

/**
 * POST one host route and decode the envelope.
 *
 * The client never inspects HTTP status: the contract says success/failure is
 * expressed by the envelope only (HTTP codes are informational). Anything that
 * is not an envelope — a bare 404 from the web server, an HTML error page, a
 * redirect — becomes {@link E_NO_ROUTE} so a not-yet-installed host half
 * degrades into a notice instead of an exception.
 */
export async function post<T>(name: string, payload: unknown = {}, signal?: AbortSignal): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(ENDPOINT + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal,
    })
  } catch (error) {
    return { ok: false, code: E_NETWORK, message: messageOf(error) }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    return {
      ok: false,
      code: E_NO_ROUTE,
      message: `HTTP ${response.status} from ${ENDPOINT + name}: ${messageOf(error)}`,
    }
  }

  if (!isEnvelope(body)) {
    return { ok: false, code: E_NO_ROUTE, message: `unexpected response body from ${ENDPOINT + name}` }
  }
  return body as ApiResult<T>
}

/** True when the failure means "this host half does not serve the route". */
export function isMissingRoute(failure: ApiFailure): boolean {
  return failure.code === E_NO_ROUTE
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
