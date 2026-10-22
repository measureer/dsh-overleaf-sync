/**
 * Local git convenience (design §5.8).
 *
 * After the first full pull we may put the freshly written project under local
 * version control. Git is **never** part of the sync protocol and every failure
 * downgrades gracefully: `ensureGitRepository` always resolves, returning a
 * `warning` instead of throwing, because a pull that succeeded must never be
 * reported as failed just because `git` is missing or unhappy.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { GitInitResult } from '../types.js'
import { atomicWrite, listFilesRecursive, pathExists, readTextIfExists } from './fsUtil.js'

/** Runs `git <args>` in `cwd`. Injected by tests; the default shells out to PATH. */
export interface GitSpawn {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface EnsureGitOptions {
  enabled: boolean
  localRoot: string
  projectName: string
  projectId: string
  /** Default: `chore: import "{project}" from Overleaf` + ` (<id> @<ISO>)`. */
  initialCommitMessage?: string
  /** Put images/PDFs into the first commit even for large projects. */
  includeBinary?: boolean
  /** Test injection point. */
  spawn?: GitSpawn
  now?: Date
}

const GITIGNORE_MARKER = '# dsh-overleaf-sync'
const GITIGNORE_ENTRIES = ['*.LOCAL.*', '*.REMOTE.*', '*.merge.*', '.dsh-bak/', '*.sync-conflict.*']
const GITATTRIBUTES_LINE = '* text=auto eol=lf'
const DEFAULT_COMMIT_TEMPLATE = 'chore: import "{project}" from Overleaf'
const LARGE_FILE_BYTES = 20 * 1024 * 1024
const LARGE_PROJECT_FILES = 2000
const TEXT_EXTENSIONS = new Set(['.tex', '.bib', '.cls', '.sty', '.md', '.txt', '.yaml', '.yml', '.json', '.csv'])
/** Files per `git add` invocation when we cannot use `-A` (Windows argv limits). */
const ADD_BATCH_SIZE = 200
/** Signals a spawn failure (as opposed to git exiting non-zero). */
const SPAWN_FAILURE_CODE = 127

interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** Set when the spawn itself failed (e.g. `git` is not in PATH). */
  spawnError?: NodeJS.ErrnoException
}

type StageOutcome = { ok: true; count: number } | { ok: false; result: GitInitResult }

/** Real `git` invocation. Never rejects for a non-zero exit — only for spawn errors. */
const defaultGitSpawn: GitSpawn = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })

async function runGit(git: GitSpawn, args: string[], cwd: string): Promise<RunResult> {
  try {
    const result = await git(args, cwd)
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  } catch (err) {
    const spawnError = (typeof err === 'object' && err !== null ? err : new Error(String(err))) as NodeJS.ErrnoException
    return { code: SPAWN_FAILURE_CODE, stdout: '', stderr: errorText(err), spawnError }
  }
}

/**
 * Create/repair a repository for `localRoot` unless it already sits inside one.
 *
 * Order (design §5.8): disabled → existing repo (own/parent/broken) → init.
 */
export async function ensureGitRepository(options: EnsureGitOptions): Promise<GitInitResult> {
  if (!options.enabled) {
    return { mode: 'none', created: false, reason: 'git.autoInit=false' }
  }

  const now = options.now ?? new Date()
  const root = path.resolve(options.localRoot)
  const git = options.spawn ?? defaultGitSpawn

  try {
    const top = await runGit(git, ['rev-parse', '--show-toplevel'], root)
    if (isGitUnavailable(top)) return unavailableResult()

    if (top.code === 0) {
      const toplevel = parseToplevel(top.stdout)
      if (toplevel !== '' && sameDirectory(toplevel, root)) {
        // Already a repository of its own: only top up the ignore files.
        try {
          await ensureGitMetadata(root)
        } catch (err) {
          return {
            mode: 'own',
            created: false,
            root,
            warning: `E_LOCAL_IO: ${firstLine(errorText(err)) || 'cannot write .gitignore/.gitattributes'}`,
          }
        }
        return { mode: 'own', created: false, root }
      }
      // A repository above us: never create a nested one.
      return {
        mode: 'parent',
        created: false,
        ...(toplevel === '' ? {} : { root: path.resolve(toplevel) }),
      }
    }

    // `rev-parse` failed. An existing (but unusable) `.git` is never deleted.
    if (await pathExists(path.join(root, '.git'))) {
      return {
        mode: 'none',
        created: false,
        warning: `E_GIT_BROKEN: ${firstLine(top.stderr) || 'git rev-parse --show-toplevel failed'}`,
      }
    }

    // Fresh repository. `-b main` needs git >= 2.28; fall back to plain `init`.
    let init = await runGit(git, ['init', '-b', 'main'], root)
    if (isGitUnavailable(init)) return unavailableResult()
    if (init.code !== 0) {
      init = await runGit(git, ['init'], root)
      if (isGitUnavailable(init)) return unavailableResult()
      if (init.code !== 0) return initFailedResult(init)
    }

    await ensureGitMetadata(root)

    const staged = await stageInitialCommit(git, root, options.includeBinary === true)
    if (!staged.ok) return staged.result

    const identity = await resolveIdentity(git, root)
    const message = buildCommitMessage(options, now)
    const commit = await runGit(
      git,
      ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-m', message],
      root,
    )
    if (isGitUnavailable(commit)) return unavailableResult()
    if (commit.code !== 0) return initFailedResult(commit)

    const short = await shortCommitSha(git, root)
    return {
      mode: 'own',
      created: true,
      root,
      ...(short === undefined ? {} : { initialCommit: short }),
      initializedAt: now.toISOString(),
      committedFiles: staged.count,
    }
  } catch (err) {
    return initFailedResult({ code: -1, stdout: '', stderr: errorText(err) })
  }
}

function unavailableResult(): GitInitResult {
  return { mode: 'none', created: false, warning: 'E_GIT_UNAVAILABLE: git not found in PATH' }
}

function initFailedResult(run: RunResult): GitInitResult {
  const detail = firstLine(run.stderr) || firstLine(run.stdout) || 'git command failed'
  return { mode: 'none', created: false, warning: `E_GIT_INIT_FAILED: ${detail}` }
}

function isGitUnavailable(run: RunResult): boolean {
  if (run.spawnError !== undefined && (run.spawnError.code === 'ENOENT' || run.spawnError.code === 'EACCES')) {
    return true
  }
  return /ENOENT/.test(run.stderr) && run.code === SPAWN_FAILURE_CODE
}

/** `git rev-parse` may quote paths that contain special characters. */
function parseToplevel(stdout: string): string {
  let value = stdout.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(.)/g, (_match, escaped: string) => {
      if (escaped === 'n') return '\n'
      if (escaped === 't') return '\t'
      return escaped
    })
  }
  return value
}

function sameDirectory(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  const normalize = (value: string): string => {
    const trimmed = value.length > 3 ? value.replace(/[\\/]+$/, '') : value
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  return normalize(left) === normalize(right)
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function firstLine(text: string): string {
  const line = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .find((candidate) => candidate.trim() !== '')
  return line === undefined ? '' : line.trim()
}

/**
 * Write/append `.gitignore` + `.gitattributes` without ever clobbering user
 * content: only missing entries are added, under a recognizable marker.
 */
async function ensureGitMetadata(root: string): Promise<void> {
  const ignoreFile = path.join(root, '.gitignore')
  const existing = (await readTextIfExists(ignoreFile)) ?? ''
  const missing = GITIGNORE_ENTRIES.filter((entry) => !hasIgnoreEntry(existing, entry))
  if (missing.length > 0) {
    await atomicWrite(ignoreFile, appendIgnoreEntries(existing, missing))
  }

  const attributesFile = path.join(root, '.gitattributes')
  const attributes = await readTextIfExists(attributesFile)
  if (attributes === undefined) {
    await atomicWrite(attributesFile, `${GITATTRIBUTES_LINE}\n`)
    return
  }
  if (!hasAttributeLine(attributes)) {
    let next = attributes.replace(/\r\n/g, '\n')
    if (next.length > 0 && !next.endsWith('\n')) next += '\n'
    await atomicWrite(attributesFile, `${next}${GITATTRIBUTES_LINE}\n`)
  }
}

function hasIgnoreEntry(content: string, entry: string): boolean {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => line.trim() === entry)
}

function hasAttributeLine(content: string): boolean {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => /^\*\s+text=auto\s+eol=lf\s*$/.test(line.trim()))
}

function appendIgnoreEntries(existing: string, missing: string[]): string {
  const normalized = existing.replace(/\r\n/g, '\n')
  if (normalized.trim() === '') {
    return `${GITIGNORE_MARKER}\n${GITIGNORE_ENTRIES.join('\n')}\n`
  }
  const lines = normalized.split('\n')
  const markerIndex = lines.findIndex((line) => line.trim() === GITIGNORE_MARKER)
  if (markerIndex >= 0) {
    lines.splice(markerIndex + 1, 0, ...missing)
    let next = lines.join('\n')
    if (!next.endsWith('\n')) next += '\n'
    return next
  }
  let next = normalized
  if (!next.endsWith('\n')) next += '\n'
  return `${next}\n${GITIGNORE_MARKER}\n${missing.join('\n')}\n`
}

/** Stage the first commit, degrading to text files for large media-heavy trees. */
async function stageInitialCommit(git: GitSpawn, root: string, includeBinary: boolean): Promise<StageOutcome> {
  const files = await listFilesRecursive(root)
  let fallbackCount = files.length

  const tooLarge = includeBinary ? false : await exceedsLargeProjectLimits(root, files)
  if (!tooLarge) {
    const add = await runGit(git, ['add', '-A'], root)
    if (isGitUnavailable(add)) return { ok: false, result: unavailableResult() }
    if (add.code !== 0) return { ok: false, result: initFailedResult(add) }
  } else {
    const textFiles = files.filter((rel) => TEXT_EXTENSIONS.has(path.posix.extname(rel).toLowerCase()))
    const paths = [...new Set(['.gitignore', '.gitattributes', ...textFiles])]
    fallbackCount = paths.length
    for (let index = 0; index < paths.length; index += ADD_BATCH_SIZE) {
      const batch = paths.slice(index, index + ADD_BATCH_SIZE)
      const add = await runGit(git, ['add', '--', ...batch], root)
      if (isGitUnavailable(add)) return { ok: false, result: unavailableResult() }
      if (add.code !== 0) return { ok: false, result: initFailedResult(add) }
    }
  }

  const staged = await runGit(git, ['ls-files', '--cached'], root)
  if (staged.code === 0) {
    const count = staged.stdout.split('\n').filter((line) => line.trim() !== '').length
    if (count > 0) return { ok: true, count }
  }
  return { ok: true, count: fallbackCount }
}

async function exceedsLargeProjectLimits(root: string, files: string[]): Promise<boolean> {
  if (files.length > LARGE_PROJECT_FILES) return true
  const largest = await largestFileSize(root, files)
  return largest > LARGE_FILE_BYTES
}

/** Largest file size, stat'ed in bounded parallel batches (large repos stay fast). */
async function largestFileSize(root: string, files: string[]): Promise<number> {
  let largest = 0
  for (let index = 0; index < files.length; index += 64) {
    const batch = files.slice(index, index + 64)
    const sizes = await Promise.all(
      batch.map(async (rel) => {
        try {
          const stat = await fs.stat(path.join(root, rel))
          return stat.isFile() ? stat.size : 0
        } catch {
          return 0
        }
      }),
    )
    for (const size of sizes) {
      if (size > largest) largest = size
    }
  }
  return largest
}

/** `git config user.name/email` if set, else the plugin's throwaway identity. */
async function resolveIdentity(git: GitSpawn, root: string): Promise<{ name: string; email: string }> {
  const name = await configValue(git, 'user.name', root)
  const email = await configValue(git, 'user.email', root)
  return {
    name: name ?? 'dsh-overleaf-sync',
    email: email ?? 'noreply@localhost',
  }
}

async function configValue(git: GitSpawn, key: string, root: string): Promise<string | undefined> {
  const result = await runGit(git, ['config', '--get', key], root)
  if (result.code !== 0) return undefined
  const value = result.stdout.trim()
  return value === '' ? undefined : value
}

function buildCommitMessage(options: EnsureGitOptions, now: Date): string {
  const template = options.initialCommitMessage ?? DEFAULT_COMMIT_TEMPLATE
  const message = template.replaceAll('{project}', options.projectName)
  if (options.initialCommitMessage !== undefined) return message
  return `${message} (${options.projectId} @${now.toISOString()})`
}

async function shortCommitSha(git: GitSpawn, root: string): Promise<string | undefined> {
  const short = await runGit(git, ['rev-parse', '--short', 'HEAD'], root)
  const shortValue = short.code === 0 ? short.stdout.trim() : ''
  if (shortValue !== '') return shortValue
  const full = await runGit(git, ['rev-parse', 'HEAD'], root)
  const fullValue = full.code === 0 ? full.stdout.trim() : ''
  return fullValue === '' ? undefined : fullValue.slice(0, 7)
}
