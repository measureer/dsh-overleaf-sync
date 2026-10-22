import os from 'node:os'
import path from 'node:path'

/** `~/.dsh/overleaf-sync` — everything we persist lives here, never inside the project. */
export function stateRoot(): string {
  return path.join(os.homedir(), '.dsh', 'overleaf-sync')
}

export function credentialsPath(): string {
  return path.join(stateRoot(), 'credentials.json')
}

export function projectStateDir(projectId: string): string {
  return path.join(stateRoot(), 'projects', sanitizeSegment(projectId))
}

export function linkPath(projectId: string): string {
  return path.join(projectStateDir(projectId), 'link.json')
}

export function statePath(projectId: string): string {
  return path.join(projectStateDir(projectId), 'state.json')
}

export function conflictsDir(projectId: string): string {
  return path.join(projectStateDir(projectId), 'conflicts')
}

/** Keep ids usable as directory names even if Overleaf ever hands us odd ones. */
export function sanitizeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

export interface LocalRootOptions {
  /** Overleaf project name */
  project: string
  /** current session working directory, used for relative patterns */
  cwd: string
  /** ISO date, used by `{date}` */
  now?: Date
}

/**
 * Resolve the configured `localRootPattern` into an absolute directory.
 *
 * Supported placeholders: `{project}` (name, filesystem-safe) and `{date}`
 * (`YYYY-MM-DD`). A relative result is resolved against the session cwd — the
 * default pattern is under the home directory on purpose, so a pull never
 * silently lands inside whatever repository the agent happens to be in.
 */
export function resolveLocalRoot(pattern: string, options: LocalRootOptions): string {
  const now = options.now ?? new Date()
  const date = now.toISOString().slice(0, 10)
  const expanded = expandHome(pattern)
    .replaceAll('{project}', filesystemSafeName(options.project))
    .replaceAll('{date}', date)
  return path.resolve(options.cwd, expanded)
}

/** Windows-forbidden characters plus trailing dots/spaces. */
export function filesystemSafeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned.length > 0 ? cleaned : 'overleaf-project'
}

/** `dir`, then `dir (1)`, `dir (2)` … for the first path that does not exist. */
export function uniquePath(dir: string, exists: (candidate: string) => boolean): string {
  if (!exists(dir)) return dir
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${dir} (${i})`
    if (!exists(candidate)) return candidate
  }
  throw new Error(`cannot find a free directory name for ${dir}`)
}
