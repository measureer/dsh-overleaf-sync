import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Own Win32 folder dialog, used when the host's `directoryPicker` seam has been
 * repointed to its in-browser backend (dsh-remote-web does that on desktop so a
 * phone can pick folders — the cost is that no OS dialog exists any more).
 *
 * The dialog itself is Windows PowerShell showing `FolderBrowserDialog`: no
 * native module, no extra dependency. The chosen path is written to a UTF-8
 * temp file because the PowerShell console code page mangles non-ASCII paths.
 */

/** Windows folder dialogs are modal per desktop; a stray one must not hang forever. */
const DIALOG_TIMEOUT_MS = 15 * 60_000

const WINDOWS_POWERSHELL = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Absolute path of `powershell.exe`, or `undefined` when this host cannot run it. */
export function windowsPowerShellPath(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const candidate = join(root, WINDOWS_POWERSHELL)
  return existsSync(candidate) ? candidate : undefined
}

/** `true` when {@link pickViaWindows} can show a real dialog on this host. */
export function windowsPickerAvailable(): boolean {
  return windowsPowerShellPath() !== undefined
}

/**
 * Script run inside PowerShell. `-STA` is required by WinForms; the result goes
 * to `$env:DSH_OVERLEAF_PICK_OUT` so the caller controls the encoding.
 */
const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = '选择 Overleaf 项目的本地目录'",
  '$dialog.ShowNewFolderButton = $true',
  '$picked = ""',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dialog.SelectedPath }',
  '[System.IO.File]::WriteAllText($env:DSH_OVERLEAF_PICK_OUT, $picked, (New-Object System.Text.UTF8Encoding($false)))',
].join('; ')

/** Outcome of a dialog: a folder, an explicit cancel, or "no dialog available". */
export interface WindowsPickOutcome {
  /** `null` means the user cancelled or closed the dialog. */
  path: string | null
}

/**
 * Show the system folder dialog and wait for the user.
 *
 * Resolves `undefined` when the dialog cannot be shown at all (no PowerShell,
 * spawn failure, unusable output) so the caller can fall back instead of
 * reporting a bogus cancel.
 */
export async function pickViaWindows(signal?: AbortSignal): Promise<WindowsPickOutcome | undefined> {
  const exe = windowsPowerShellPath()
  if (exe === undefined) return undefined
  const outFile = join(tmpdir(), `dsh-overleaf-pick-${process.pid}-${Date.now()}.txt`)
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT]

  return new Promise<WindowsPickOutcome | undefined>((resolve) => {
    let settled = false
    const child = spawn(exe, args, {
      windowsHide: true,
      env: { ...process.env, DSH_OVERLEAF_PICK_OUT: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (value: WindowsPickOutcome | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      rmSync(outFile, { force: true })
      resolve(value)
    }
    const onAbort = (): void => {
      child.kill()
      finish(undefined)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, DIALOG_TIMEOUT_MS)
    timer.unref?.()
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stderr?.resume()
    child.stdout?.resume()
    child.on('error', () => finish(undefined))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(undefined)
        return
      }
      let text = ''
      try {
        text = readFileSync(outFile, 'utf8').trim()
      } catch {
        finish(undefined)
        return
      }
      finish({ path: text.length > 0 ? text : null })
    })
  })
}
