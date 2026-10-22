/**
 * Typed failures. Every user-facing message is `code: message (hint)` so the
 * agent can branch on the code and the user still gets a next step.
 */

export type OverleafErrorCode =
  | 'E_AUTH_REQUIRED'
  | 'E_AUTH_EXPIRED'
  | 'E_NOT_LINKED'
  | 'E_PROJECT_NOT_FOUND'
  | 'E_TRANSPORT'
  | 'E_TIMEOUT'
  | 'E_LOCAL_IO'
  | 'E_CONFLICT'
  | 'E_APPROVAL_DENIED'
  | 'E_GIT_UNAVAILABLE'
  | 'E_GIT_INIT_FAILED'
  | 'E_GIT_BROKEN'
  | 'E_CONFIG'

export class OverleafSyncError extends Error {
  readonly code: OverleafErrorCode
  readonly hint?: string

  constructor(code: OverleafErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'OverleafSyncError'
    this.code = code
    if (hint !== undefined) this.hint = hint
  }
}

export function isOverleafError(err: unknown): err is OverleafSyncError {
  return err instanceof OverleafSyncError
}

/** One-line rendering used by every tool result. */
export function describeError(err: unknown): string {
  if (isOverleafError(err)) {
    return err.hint ? `${err.code}: ${err.message} — ${err.hint}` : `${err.code}: ${err.message}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/** Map an HTTP status / socket rejection onto our codes. */
export function authErrorFor(status: number): OverleafSyncError | undefined {
  if (status === 401 || status === 403) {
    return new OverleafSyncError(
      'E_AUTH_EXPIRED',
      `Overleaf rejected the stored session (HTTP ${status})`,
      'run overleaf_login again with a fresh Cookie + CSRF token',
    )
  }
  return undefined
}
