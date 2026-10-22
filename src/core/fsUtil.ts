/**
 * Small filesystem/hashing helpers shared by the core layer.
 *
 * Everything here is deliberately dependency-free and platform-neutral: paths
 * are handled with `node:path`, relative paths are reported with POSIX
 * separators (the sync tree is keyed by POSIX paths), and writes are atomic so
 * a crash can never leave a half-written document behind.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Content hash used for every baseline comparison: `sha256:<hex>` of UTF-8 bytes. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** `fs.access` without the throw: any error (missing, inaccessible) means "no". */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** `mkdir -p`. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Read a UTF-8 text file, or `undefined` when it does not exist.
 *
 * Only "missing" is mapped to `undefined`; real IO errors (EACCES, EISDIR…)
 * still throw so callers do not silently lose data.
 */
export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw err
  }
}

/**
 * Write `text` atomically: create the parent directory, write a uniquely named
 * temporary file in the same directory, then rename it over the target.
 *
 * The temp file lives next to the target on purpose — a rename across devices
 * is not atomic (and may fail outright on Windows). A failed write/rename
 * removes the temp file again instead of leaving clutter behind.
 */
export async function atomicWrite(file: string, text: string): Promise<void> {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, text, 'utf8')
    await fs.rename(temp, file)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** Normalize Windows line endings to `\n`; used before hashing/comparing text. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Recursively list files under `root` as POSIX-separated relative paths.
 *
 * `.git` and `node_modules` are always skipped (they are never part of a
 * document tree), symlinks are not followed (loop safety), and the result is
 * sorted so callers/tests see a stable order. A missing root yields `[]`.
 */
export async function listFilesRecursive(
  root: string,
  filter?: (relPosix: string) => boolean,
): Promise<string[]> {
  const out: string[] = []

  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw err
    }
    for (const entry of entries) {
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        await walk(path.join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        if (filter === undefined || filter(rel)) out.push(rel)
      }
    }
  }

  await walk(root, '')
  return out.sort()
}
