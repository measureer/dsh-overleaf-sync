/**
 * Best-effort diagnostics for the Host half.
 *
 * The GUI is useless without `/overleaf/api/*`, and a missing route is
 * indistinguishable from a crashed registration once the page is open. Every
 * registration step is therefore recorded to
 * `~/.dsh/overleaf-sync/diagnostics.ndjson` (or `$DSH_HOME`), which survives a
 * restart and can be read without a debugger.
 *
 * Never throws: a broken diagnostics file must not take the plugin down.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const MAX_LINES = 200

function diagnosticsFile(): string {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'overleaf-sync', 'diagnostics.ndjson')
}

/** Append one event; keeps the file bounded by rewriting it when it grows. */
export function recordDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  try {
    const file = diagnosticsFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`
    appendFileSync(file, line)
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((entry) => entry.length > 0)
      if (lines.length > MAX_LINES) {
        writeFileSync(file, `${lines.slice(lines.length - MAX_LINES).join('\n')}\n`)
      }
    } catch {
      // Rotation is cosmetic; the append above already succeeded.
    }
  } catch {
    // Diagnostics must never break the plugin.
  }
}

/** Message + first stack frames, safe for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ?? ''
    return stack.length > 800 ? `${stack.slice(0, 800)}…` : stack
  }
  return String(error)
}
