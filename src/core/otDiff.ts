/**
 * Minimal text diffing for the OT wire format.
 *
 * Overleaf applies ShareJS operations against the server text: `{p, i?, d?}` where
 * `p` is a UTF-16 offset into the *server* text. We only need a correct operation,
 * not the smallest one, so a single prefix/suffix-trimmed replace is enough — and it
 * keeps the round trip (`applyOps(base, ops) === next`) trivially provable.
 */
import type { TextOp } from '../types.js'

/** Build the operations that turn `base` into `next`. */
export function diffToOps(base: string, next: string): TextOp[] {
  if (base === next) return []

  const limit = Math.min(base.length, next.length)
  let prefix = 0
  while (prefix < limit && base[prefix] === next[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < limit - prefix &&
    base[base.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removed = base.slice(prefix, base.length - suffix)
  const inserted = next.slice(prefix, next.length - suffix)
  const op: TextOp = { p: prefix }
  if (removed.length > 0) op.d = removed
  if (inserted.length > 0) op.i = inserted
  return [op]
}

/** Apply operations in order; used for local application of remote updates. */
export function applyOps(text: string, ops: TextOp[]): string {
  let out = text
  for (const op of ops) {
    if (op.d != null && op.d.length > 0) {
      out = out.slice(0, op.p) + out.slice(op.p + op.d.length)
    }
    if (op.i != null && op.i.length > 0) {
      out = out.slice(0, op.p) + op.i + out.slice(op.p)
    }
  }
  return out
}
