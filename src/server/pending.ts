/**
 * "How many local files differ from the sync baseline?" — the number behind the
 * GUI's 待推送 badge (design §14.5).
 *
 * Two things make this less obvious than a hash loop:
 *
 * 1. **Binary uploads are not text.** A pulled image is hashed over raw bytes
 *    (`sha256Bytes`), while a document is hashed over LF-normalized text
 *    (`fsUtil.sha256(normalizeEol(…))`). Reading an image as UTF-8 and comparing
 *    that hash reports every picture as "changed" the moment it is pulled.
 * 2. **Only baseline paths can be pushed.** Untracked local files (a `.git`
 *    artifact, an editor swap file, a build output) are not something `push`
 *    would ever send, so counting them makes the badge cry wolf.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { normalizeEol, sha256 } from '../core/fsUtil.js'
import { sha256Bytes } from '../core/files.js'
import type { FileState, ProjectState } from '../types.js'

/**
 * Count baseline entries whose local file changed or disappeared.
 *
 * `shouldIgnore` is optional: paths the link excludes (or `.overleaf-syncignore`
 * matches) are not "pending", they are deliberately out of sync.
 */
export async function countPendingLocalChanges(
  state: Pick<ProjectState, 'files'>,
  localRoot: string,
  shouldIgnore?: (relPath: string) => boolean,
): Promise<number> {
  let changed = 0
  for (const [rel, baseline] of Object.entries(state.files)) {
    if (shouldIgnore?.(rel) === true) continue
    const absolute = path.join(localRoot, rel)
    let bytes: Buffer
    try {
      bytes = await fs.readFile(absolute)
    } catch {
      changed += 1
      continue
    }
    if (isUnchanged(baseline, bytes)) continue
    changed += 1
  }
  return changed
}

/**
 * Entries written before `FileState.kind` existed cannot say how they were
 * hashed, so either hash matching counts as in sync. That keeps old state files
 * from flagging every pulled image as a local edit.
 */
export function isUnchanged(baseline: FileState, bytes: Buffer): boolean {
  if (baseline.localHash === sha256Bytes(bytes)) return true
  if (baseline.kind === 'file') return false
  return baseline.localHash === sha256(normalizeEol(bytes.toString('utf8')))
}
