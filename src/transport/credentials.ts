import { promises as fs } from 'node:fs'
import path from 'node:path'

import { OverleafSyncError } from '../core/errors.js'
import { credentialsPath } from '../core/paths.js'
import type { Credential } from '../types.js'

/** Input accepted by `saveCredential`; everything is normalized before saving. */
export interface CredentialInput {
  baseUrl: string
  cookie: string
  csrfToken: string
  userHint?: string
}

const CREDENTIALS_FILE = 'credentials.json'

/**
 * Location of the credential file. `rootDir` is a test hook: the plugin always
 * calls it without arguments and gets `~/.dsh/overleaf-sync/credentials.json`.
 */
export function credentialsFile(rootDir?: string): string {
  return rootDir ? path.join(rootDir, CREDENTIALS_FILE) : credentialsPath()
}

/** Normalize an Overleaf origin to `new URL(x).href`, which always ends in `/`. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = (input ?? '').trim()
  if (trimmed.length === 0) {
    throw new OverleafSyncError(
      'E_CONFIG',
      'Overleaf baseUrl is empty',
      'pass the Overleaf origin, e.g. https://www.overleaf.com',
    )
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  let parsed: URL
  try {
    parsed = hasScheme ? new URL(trimmed) : new URL(`https://${trimmed}`)
  } catch {
    throw new OverleafSyncError(
      'E_CONFIG',
      `invalid Overleaf baseUrl: ${trimmed}`,
      'pass a full URL, e.g. https://www.overleaf.com',
    )
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.hostname === '') {
    throw new OverleafSyncError(
      'E_CONFIG',
      `invalid Overleaf baseUrl: ${trimmed}`,
      'pass an http(s) origin, e.g. https://www.overleaf.com',
    )
  }
  // An API base has no query/hash, and every request path is appended to it.
  parsed.search = ''
  parsed.hash = ''
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`
  return parsed.href
}

/**
 * Clean up a pasted Cookie header:
 * - trim leading/trailing whitespace,
 * - drop a leading `Cookie:` label,
 * - accept either one `name=value; name2=value2` line or several lines
 *   (DevTools copies multi-line values) and re-join them with `; `.
 */
export function normalizeCookie(input: string): string {
  const text = (input ?? '').replace(/^\uFEFF/, '').trim()
  const withoutLabel = text.replace(/^cookie\s*:\s*/i, '')
  const parts: string[] = []
  for (const line of withoutLabel.split(/\r?\n/)) {
    for (const piece of line.split(';')) {
      const part = piece.trim()
      if (part.length > 0) parts.push(part)
    }
  }
  return parts.join('; ')
}

/** Read the stored credential; missing or corrupt files yield `undefined`. */
export async function loadCredential(rootDir?: string): Promise<Credential | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(credentialsFile(rootDir), 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const record = parsed as Record<string, unknown>
  const baseUrlRaw = typeof record.baseUrl === 'string' ? record.baseUrl : ''
  const cookieRaw = typeof record.cookie === 'string' ? record.cookie : ''
  const csrfToken = typeof record.csrfToken === 'string' ? record.csrfToken.trim() : ''
  if (baseUrlRaw.trim().length === 0 || cookieRaw.trim().length === 0 || csrfToken.length === 0) {
    return undefined
  }

  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(baseUrlRaw)
  } catch {
    return undefined
  }
  const cookie = normalizeCookie(cookieRaw)
  if (cookie.length === 0) return undefined

  const credential: Credential = {
    baseUrl,
    cookie,
    csrfToken,
    savedAt:
      typeof record.savedAt === 'string' && record.savedAt.length > 0
        ? record.savedAt
        : new Date(0).toISOString(),
  }
  if (typeof record.userHint === 'string' && record.userHint.trim().length > 0) {
    credential.userHint = record.userHint.trim()
  }
  return credential
}

/**
 * Persist a credential. Creates the directory when needed and makes the file
 * owner-only (0600; on Windows the chmod is a no-op and the profile ACL
 * protects the file instead).
 */
export async function saveCredential(
  input: CredentialInput,
  rootDir?: string,
): Promise<Credential> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const cookie = normalizeCookie(input.cookie)
  if (cookie.length === 0) {
    throw new OverleafSyncError(
      'E_CONFIG',
      'Overleaf cookie is empty',
      'paste the Cookie request header copied from a logged-in overleaf.com tab',
    )
  }
  const csrfToken = (input.csrfToken ?? '').trim()
  if (csrfToken.length === 0) {
    throw new OverleafSyncError(
      'E_CONFIG',
      'Overleaf CSRF token is empty',
      'pass the ol-csrfToken value from the page source or the X-Csrf-Token request header',
    )
  }

  const credential: Credential = {
    baseUrl,
    cookie,
    csrfToken,
    savedAt: new Date().toISOString(),
  }
  const userHint = input.userHint?.trim()
  if (userHint) credential.userHint = userHint

  const file = credentialsFile(rootDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(credential, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await fs.chmod(file, 0o600)
  } catch {
    // Windows has no POSIX permission bits; the file is covered by the user profile ACL.
  }
  return credential
}

/** Remove the stored credential. Missing files are not an error. */
export async function clearCredential(rootDir?: string): Promise<void> {
  try {
    await fs.rm(credentialsFile(rootDir), { force: true })
  } catch {
    // Treat "already gone" and permission errors the same: logout is best effort.
  }
}
