/**
 * Views the browser gets from `/overleaf/api/*` (docs/m4a-api-contract.md §2.1–2.3).
 *
 * These are deliberately GUI-shaped: they flatten what the tools return and add
 * the few derived numbers a page needs. The service types stay untouched.
 */

import type { ConflictStrategy } from '../types.js'

export interface StatusSummary {
  baseUrl: string
  authenticated: boolean
  credential?: { hint?: string; savedAt?: string }
  current?: {
    projectId: string
    projectName: string
    localRoot: string
    files: number
    remoteVersion?: number
    lastPullAt?: string
    git?: { root: string; mode: 'own' | 'parent' | 'none'; head?: string }
  }
  projects: Array<{ projectId: string; projectName: string; localRoot: string; files: number; linkedAt: string }>
  pending: { localChanges: number; conflicts: number }
  /** One line for a toast/badge; always human-readable, never a code. */
  text: string
}

export interface ConflictEntry {
  /** Project-relative path of the main file. */
  path: string
  /** Project-relative path of the remote copy (`main.remote-20261023T013000.tex`). */
  copyPath: string
  at: string
  strategy: ConflictStrategy
}

export type FieldType = 'string' | 'boolean' | 'number' | 'enum'

export interface SettingsFieldView {
  /** Dotted config path, e.g. `git.autoInit`; also the locale dictionary key. */
  key: string
  type: FieldType
  value: unknown
  /** Display label (Chinese). Optional: the client may prefer its locale dictionary. */
  label?: string
  /** Value used when the entry does not override the schema default. */
  default?: unknown
  /** `strategy` renders in the main form, `advanced` behind a disclosure. */
  group?: 'strategy' | 'advanced'
  options?: string[]
  min?: number
  max?: number
  description?: string
}

export interface SettingsView {
  /** `false` when the Settings service is absent or the deployment is read-only. */
  writable: boolean
  /** Must be sent back with a write; `0` when Settings is absent. */
  revision: number
  fields: SettingsFieldView[]
}

/**
 * Outcome of `pick-directory`.
 *
 * - `native`: the host's OS folder dialog was shown; `path` is the picked
 *   absolute folder or `null` when the operator cancelled.
 * - `browse`: the host only offers in-app browse primitives, so the page has to
 *   fall back to typing the path (and `path` is always `null`).
 * - `unavailable`: no directory-picker service in this host at all.
 */
export interface PickDirectoryResult {
  kind: 'native' | 'browse' | 'unavailable'
  path: string | null
}

export interface PathValidation {
  ok: boolean
  /** Absolute, symlink-resolved directory the link would use. */
  resolved: string
  problems: string[]
}

export interface JournalEntryView {
  ts?: string
  event: string
  path?: string
  docId?: string
  v?: number
  ok?: boolean
  code?: string
  [key: string]: unknown
}
