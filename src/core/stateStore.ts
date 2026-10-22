/**
 * Per-file baseline store (`state.json`, design §6.5).
 *
 * Three-way comparison only needs three values: the hash currently on disk,
 * the hash recorded when the file was last in sync, and the remote version
 * recorded at the same moment. That is exactly what `compareBaseline` looks at;
 * the merge/conflict layer decides what to do with the answer.
 */

import type { FileState, ProjectState } from '../types.js'
import { atomicWrite, readTextIfExists } from './fsUtil.js'
import { statePath } from './paths.js'

export type ChangeKind = 'none' | 'local' | 'remote' | 'both'

/**
 * Which side(s) changed since the recorded baseline.
 *
 * No baseline at all means nothing has ever been synced: both sides count as
 * changed, which forces the caller through the merge path instead of silently
 * overwriting one of them.
 */
export function compareBaseline(
  file: FileState | undefined,
  current: { localHash: string; remoteVersion: number },
): ChangeKind {
  if (file === undefined) return 'both'
  const localChanged = file.localHash !== current.localHash
  const remoteChanged = file.remoteVersion !== current.remoteVersion
  if (localChanged && remoteChanged) return 'both'
  if (localChanged) return 'local'
  if (remoteChanged) return 'remote'
  return 'none'
}

/** Fresh, valid state for a project that has never been synced. */
export function emptyProjectState(projectId: string, localRoot: string): ProjectState {
  return {
    schemaVersion: 1,
    projectId,
    localRoot,
    updatedAt: new Date().toISOString(),
    files: {},
  }
}

/**
 * Read `state.json`; `undefined` when it is missing, unreadable or corrupt.
 *
 * A corrupted baseline must never crash a sync — the caller falls back to
 * `emptyProjectState`, which turns every file into a three-way merge instead of
 * trusting garbage.
 */
export async function readProjectState(projectId: string): Promise<ProjectState | undefined> {
  try {
    const text = await readTextIfExists(statePath(projectId))
    if (text === undefined) return undefined
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return undefined
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) return undefined
    if (!isRecord(parsed.files)) return undefined

    const files: Record<string, FileState> = {}
    for (const [relPath, value] of Object.entries(parsed.files)) {
      const entry = normalizeFileState(value)
      if (entry !== undefined) files[relPath] = entry
    }

    const state: ProjectState = {
      schemaVersion: 1,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : projectId,
      localRoot: typeof parsed.localRoot === 'string' ? parsed.localRoot : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      files,
    }
    const missing = normalizeFilesMissing(parsed.filesMissing)
    if (missing !== undefined) state.filesMissing = missing
    return state
  } catch {
    return undefined
  }
}

/** Atomically persist the state, stamping `updatedAt` on the way out. */
export async function writeProjectState(state: ProjectState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  const file = statePath(state.projectId)
  await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Convenience wrapper around `state.json` for one project.
 *
 * Mutations are in-memory; call `save()` to persist. `localRoot` is refreshed
 * when the project was linked/moved to a different folder so the stored record
 * follows the user instead of pointing at the old location.
 */
export class StateStore {
  private constructor(public readonly state: ProjectState) {}

  static async load(projectId: string, localRoot: string): Promise<StateStore> {
    const loaded = await readProjectState(projectId)
    if (loaded === undefined) {
      return new StateStore(emptyProjectState(projectId, localRoot))
    }
    if (loaded.localRoot !== localRoot) loaded.localRoot = localRoot
    return new StateStore(loaded)
  }

  get(relPath: string): FileState | undefined {
    const key = normalizeKey(relPath)
    if (!Object.hasOwn(this.state.files, key)) return undefined
    return this.state.files[key]
  }

  set(relPath: string, entry: FileState): void {
    this.state.files[normalizeKey(relPath)] = entry
  }

  remove(relPath: string): void {
    const key = normalizeKey(relPath)
    if (Object.hasOwn(this.state.files, key)) delete this.state.files[key]
  }

  compare(relPath: string, current: { localHash: string; remoteVersion: number }): ChangeKind {
    return compareBaseline(this.get(relPath), current)
  }

  async save(): Promise<void> {
    await writeProjectState(this.state)
  }
}

/** State keys are always POSIX relative paths; tolerate a Windows slip. */
function normalizeKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeFileState(value: unknown): FileState | undefined {
  if (!isRecord(value)) return undefined
  const docId = value.docId
  const localHash = value.localHash
  const remoteVersion = value.remoteVersion
  if (typeof docId !== 'string' || docId === '') return undefined
  if (typeof localHash !== 'string' || localHash === '') return undefined
  if (typeof remoteVersion !== 'number' || !Number.isFinite(remoteVersion)) return undefined

  const entry: FileState = {
    docId,
    remoteVersion,
    localHash,
    syncedAt: typeof value.syncedAt === 'string' ? value.syncedAt : new Date(0).toISOString(),
  }
  if (typeof value.remoteHash === 'string') entry.remoteHash = value.remoteHash
  if (value.origin === 'local' || value.origin === 'remote' || value.origin === 'both') {
    entry.origin = value.origin
  }
  return entry
}

function normalizeFilesMissing(
  value: unknown,
): Record<string, { docId: string; deletedAt: string }> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, { docId: string; deletedAt: string }> = {}
  for (const [relPath, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    if (typeof entry.docId !== 'string') continue
    out[relPath] = {
      docId: entry.docId,
      deletedAt: typeof entry.deletedAt === 'string' ? entry.deletedAt : new Date(0).toISOString(),
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}
