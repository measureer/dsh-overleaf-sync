/**
 * Conflict discovery and resolution (design §5.6, §7.4).
 *
 * Every time a pull or push finds both sides changed, the sync layer writes
 * three files under `~/.dsh/overleaf-sync/projects/<id>/conflicts/<stamp>/`:
 *
 *   <relPath>.local      the local text/bytes that were kept on disk
 *   <relPath>.remote     the remote text/bytes that lost the race
 *   <relPath>.meta.json  path, reason, versions, timestamp
 *
 * plus a visible `<name>.remote-<stamp>.<ext>` next to the file itself, so the
 * user can read the losing side in their editor without digging into state.
 *
 * Resolving a conflict means: decide which text the main file should hold, and
 * hand the service the two hashes it needs to record a new baseline. The
 * artifact directory is archived under `conflicts/resolved/<stamp>/` instead of
 * being deleted — "the overwritten version can always be recovered" is a hard
 * rule of the design, and an archive makes it true even after resolution.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { LinkRecord } from '../types.js'
import { conflictsDir } from './paths.js'
import { atomicWrite, normalizeEol, readTextIfExists, sha256 } from './fsUtil.js'
import { sha256Bytes } from './files.js'

/** How a conflict is settled; `merge` keeps both and only clears the record. */
export type ConflictChoice = 'keep_local' | 'keep_remote' | 'merge'

export interface ConflictEntry {
  /** project-relative path of the contested file, POSIX separators */
  path: string
  /** how the file is compared: documents hash normalized text, files raw bytes */
  kind: 'doc' | 'file'
  /** why the conflict was recorded, e.g. `remote-changed` */
  reason?: string
  localVersion?: number
  remoteVersion?: number
  createdAt: string
  /** artifact directory (`conflicts/<stamp>`) holding .local/.remote/.meta.json */
  dir: string
  /** visible copy next to the file (`foo.remote-<stamp>.tex`), when the stamp is known */
  copyPath?: string
}

export interface ResolvedConflict {
  path: string
  choice: ConflictChoice
  kind: 'doc' | 'file'
  /** hash of the content the main file now holds, for `state.json` */
  localHash: string
  /** hash of the remote side that was recorded, so a later push notices new remote edits */
  remoteHash: string
  remoteVersion: number
  /** where the artifacts were archived */
  archivedTo?: string
}

/** Extensions the pull path stores as binary files rather than documents. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
  '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.mp3', '.mp4', '.wav', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.eps', '.psd', '.ai', '.sketch', '.fig',
])

function looksBinary(relPath: string): boolean {
  return BINARY_EXTENSIONS.has(path.posix.extname(relPath).toLowerCase())
}

interface ConflictMeta {
  path?: string
  reason?: string
  localVersion?: number
  remoteVersion?: number
  createdAt?: string
  kind?: 'doc' | 'file'
}

/** Recursively collect `*.meta.json` files below `dir`. */
async function findMetaFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  let entries: Array<{ name: string; dir: boolean }>
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      dir: entry.isDirectory(),
    }))
  } catch {
    return found
  }
  for (const entry of entries) {
    // `resolved/` holds archives: they are history, not open conflicts.
    if (entry.dir && entry.name === 'resolved') continue
    const child = path.join(dir, entry.name)
    if (entry.dir) found.push(...(await findMetaFiles(child)))
    else if (entry.name.endsWith('.meta.json')) found.push(child)
  }
  return found
}

/**
 * List every unresolved conflict of a project, newest first.
 *
 * A conflict directory that lost its `.remote`/`.local` file (hand-edited state)
 * is ignored instead of reported — resolving it could not restore the losing
 * side any more, so pretending it is resolvable would be a lie.
 */
export async function discoverConflicts(projectId: string): Promise<ConflictEntry[]> {
  const root = conflictsDir(projectId)
  const metas = await findMetaFiles(root)
  const entries: ConflictEntry[] = []

  for (const metaFile of metas) {
    let meta: ConflictMeta
    try {
      meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as ConflictMeta
    } catch {
      continue
    }
    const relPath = (meta.path ?? '').replaceAll('\\', '/')
    if (relPath.length === 0) continue

    const base = metaFile.slice(0, -'.meta.json'.length)
    const [localExists, remoteExists] = await Promise.all([
      existsAsFile(`${base}.local`),
      existsAsFile(`${base}.remote`),
    ])
    if (!localExists || !remoteExists) continue

    const dir = path.dirname(metaFile)
    const kind: 'doc' | 'file' = meta.kind ?? (looksBinary(relPath) ? 'file' : 'doc')
    const parsed = path.posix.parse(relPath)
    const stamp = path.basename(dir)
    entries.push({
      path: relPath,
      kind,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      ...(meta.localVersion !== undefined ? { localVersion: meta.localVersion } : {}),
      ...(meta.remoteVersion !== undefined ? { remoteVersion: meta.remoteVersion } : {}),
      createdAt: meta.createdAt ?? stamp,
      dir,
      copyPath: path.posix.join(parsed.dir, `${parsed.name}.remote-${stamp}${parsed.ext}`),
    })
  }

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function existsAsFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    return stat.isFile()
  } catch {
    return false
  }
}

async function archiveDir(projectId: string, dir: string, dryRun: boolean): Promise<string | undefined> {
  if (dryRun) return undefined
  const stamp = path.basename(dir)
  const target = path.join(conflictsDir(projectId), 'resolved', stamp)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(dir, target).catch(async () => {
    // Cross-device rename or a locked file: fall back to copy + remove.
    await fs.cp(dir, target, { recursive: true })
    await fs.rm(dir, { recursive: true, force: true })
  })
  return target
}

/**
 * Settle one conflict.
 *
 * - `keep_local`  → the main file keeps the local side (`.local`)
 * - `keep_remote` → the main file is overwritten with the remote side (`.remote`)
 * - `merge`       → the main file is left untouched; both sides stay on disk
 *                   (`<name>.remote-<stamp>.<ext>` is already next to it)
 *
 * The returned hashes describe the *new baseline*: `localHash` matches what is
 * on disk now, `remoteHash` matches the remote text this resolution was based
 * on, so a later push still notices if Overleaf moved on in the meantime.
 */
/**
 * Whole-file merge with the familiar markers.
 *
 * Line-level diff/merge would need a three-way base we do not store, so a
 * conflict is presented as both sides in full — the user (or an editor's merge
 * UI) resolves it and the next push sends the result.
 */
export function mergeText(local: string, remote: string): string {
  const nl = String.fromCharCode(10)
  const left = local.endsWith(nl) ? local : local + nl
  const right = remote.endsWith(nl) ? remote : remote + nl
  return ['<<<<<<< local', left + '=======', right + '>>>>>>> remote', ''].join(nl)
}

export async function resolveConflict(options: {
  link: LinkRecord
  entry: ConflictEntry
  choice: ConflictChoice
  dryRun?: boolean
}): Promise<ResolvedConflict> {
  const { link, entry, choice } = options
  const dryRun = options.dryRun === true

  // `.meta.json` sits next to the payload, whose own name mirrors the rel path.
  const stem = path.join(entry.dir, ...entry.path.split('/'))
  const localFile = `${stem}.local`
  const remoteFile = `${stem}.remote`

  const mainAbs = path.join(link.localRoot, ...entry.path.split('/'))

  let localHash: string
  let remoteHash: string

  if (entry.kind === 'file') {
    const [localBytes, remoteBytes] = await Promise.all([
      fs.readFile(localFile).catch(() => undefined),
      fs.readFile(remoteFile).catch(() => undefined),
    ])
    if (localBytes === undefined || remoteBytes === undefined) {
      throw new Error(`conflict artifacts for "${entry.path}" are incomplete`)
    }
    const chosen = choice === 'keep_remote' ? remoteBytes : localBytes
    localHash = sha256Bytes(chosen)
    remoteHash = sha256Bytes(remoteBytes)
    if (!dryRun) {
      if (choice !== 'merge') {
        const dir = path.dirname(mainAbs)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(mainAbs, chosen)
      }
    }
  } else {
    const [localText, remoteText] = await Promise.all([
      readTextIfExists(localFile),
      readTextIfExists(remoteFile),
    ])
    const fallbackLocal = choice === 'merge' ? await readTextIfExists(mainAbs) : undefined
    const local = localText ?? fallbackLocal ?? ''
    const remote = remoteText ?? ''
    if (localText === undefined || remoteText === undefined) {
      if (choice !== 'merge') {
        throw new Error(`conflict artifacts for "${entry.path}" are incomplete`)
      }
    }
    const chosen = choice === 'keep_remote' ? remote : local
    const merged = choice === 'merge' ? mergeText(local, remote) : chosen
    localHash = sha256(normalizeEol(merged))
    remoteHash = sha256(normalizeEol(remote))
    if (!dryRun) await atomicWrite(mainAbs, merged)
  }

  const archivedTo = await archiveDir(link.projectId, entry.dir, dryRun)
  return {
    path: entry.path,
    choice,
    kind: entry.kind,
    localHash,
    remoteHash,
    remoteVersion: entry.remoteVersion ?? 0,
    ...(archivedTo !== undefined ? { archivedTo } : {}),
  }
}

/** Timestamp used both for the artifact directory and the visible copy name. */
function conflictStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function findReusableCopy(
  dirAbs: string,
  relDir: string,
  stem: string,
  ext: string,
  compare: (text: string) => boolean,
): Promise<string | undefined> {
  let names: string[]
  try {
    names = await fs.readdir(dirAbs)
  } catch {
    return undefined
  }
  for (const name of names) {
    if (!name.startsWith(`${stem}.remote-`)) continue
    if (ext && !name.endsWith(ext)) continue
    const text = await readTextIfExists(path.join(dirAbs, name))
    if (text !== undefined && compare(text)) return path.posix.join(relDir, name)
  }
  return undefined
}

/**
 * Record a text conflict: write the artifacts (`.local`, `.remote`, `.meta.json`)
 * and the visible `<name>.remote-<stamp><ext>` copy next to the file.
 *
 * The visible copy is de-duplicated by content: pulling twice with the same
 * remote text reuses the existing copy instead of filling the folder.
 *
 * @returns project-relative path of the visible copy
 */
export async function writeTextConflict(options: {
  link: LinkRecord
  relPath: string
  localText: string
  remoteText: string
  meta?: Record<string, unknown>
}): Promise<string> {
  const { link, relPath, localText, remoteText } = options
  const meta = options.meta ?? {}
  const stamp = conflictStamp()
  const dir = path.join(conflictsDir(link.projectId), stamp)
  const base = path.join(dir, ...relPath.split('/'))
  await fs.mkdir(path.dirname(base), { recursive: true })
  await atomicWrite(`${base}.local`, localText)
  await atomicWrite(`${base}.remote`, remoteText)
  await atomicWrite(
    `${base}.meta.json`,
    JSON.stringify({ path: relPath, kind: 'doc', ...meta, createdAt: new Date().toISOString() }, null, 2),
  )

  const parsed = path.posix.parse(relPath)
  const visibleRel = path.posix.join(parsed.dir, `${parsed.name}.remote-${stamp}${parsed.ext}`)
  const visibleAbs = path.join(link.localRoot, ...visibleRel.split('/'))
  const wanted = sha256(normalizeEol(remoteText))
  const reusable = await findReusableCopy(
    path.dirname(visibleAbs),
    parsed.dir,
    parsed.name,
    parsed.ext,
    (text) => sha256(normalizeEol(text)) === wanted,
  )
  if (reusable) return reusable
  await fs.mkdir(path.dirname(visibleAbs), { recursive: true })
  await atomicWrite(visibleAbs, remoteText)
  return visibleRel
}

/** Binary sibling of {@link writeTextConflict}: same layout, raw bytes. */
export async function writeBinaryConflict(options: {
  link: LinkRecord
  relPath: string
  localBytes: Uint8Array
  remoteBytes: Uint8Array
  meta?: Record<string, unknown>
}): Promise<string> {
  const { link, relPath, localBytes, remoteBytes } = options
  const meta = options.meta ?? {}
  const stamp = conflictStamp()
  const dir = path.join(conflictsDir(link.projectId), stamp)
  const base = path.join(dir, ...relPath.split('/'))
  await fs.mkdir(path.dirname(base), { recursive: true })
  await fs.writeFile(`${base}.local`, localBytes)
  await fs.writeFile(`${base}.remote`, remoteBytes)
  await atomicWrite(
    `${base}.meta.json`,
    JSON.stringify({ path: relPath, kind: 'file', ...meta, createdAt: new Date().toISOString() }, null, 2),
  )

  const parsed = path.posix.parse(relPath)
  const visibleRel = path.posix.join(parsed.dir, `${parsed.name}.remote-${stamp}${parsed.ext}`)
  const visibleAbs = path.join(link.localRoot, ...visibleRel.split('/'))
  await fs.mkdir(path.dirname(visibleAbs), { recursive: true })
  await fs.writeFile(visibleAbs, remoteBytes)
  return visibleRel
}
