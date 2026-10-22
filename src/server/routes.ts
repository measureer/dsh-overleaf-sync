/**
 * `/overleaf/api/*` routes (docs/m4a-api-contract.md §2).
 *
 * Every handler is the same shape: parse a tiny JSON body, call the service
 * that the tools already use, answer with the envelope. Nothing here holds
 * state between requests — the page re-reads `status` after every action.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { conflictsDir, expandHome, journalPath, stateRoot } from '../core/paths.js'
import { readProjectState } from '../core/stateStore.js'
import { listFilesRecursive, normalizeEol, sha256 } from '../core/fsUtil.js'
import { describeError } from '../core/errors.js'
import type { Config } from '../config.js'
import type { OverleafSyncService } from '../service.js'
import type { ConflictStrategy } from '../types.js'
import {
  ApiError,
  isCrossSite,
  optionalBoolean,
  optionalNumber,
  optionalString,
  readJson,
  requireString,
  sendFailure,
  sendResult,
} from './envelope.js'
import type { SettingsBridge } from './settingsBridge.js'
import type { ConflictEntry, JournalEntryView, PathValidation, StatusSummary } from './types.js'

/** Structural copy of the web server's route record. */
export interface WebRoute {
  kind: 'exact' | 'prefix' | 'regex'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => unknown
}

export interface RouteDeps {
  service: OverleafSyncService
  config: Config
  settings: SettingsBridge
  /** Session working directory, for relative paths in `link`. */
  cwd: string
}

const PREFIX = '/overleaf/api/'

type Handler = (body: Record<string, unknown>) => Promise<unknown>

/**
 * Build the route table. Each entry gets the same guard (same-origin, JSON
 * body, error envelope) so a new route cannot forget one of them.
 */
export function createOverleafRoutes(deps: RouteDeps): WebRoute[] {
  const routes: Array<[string, Handler]> = [
    ['status', () => statusView(deps)],
    ['login', (body) => loginView(deps, body)],
    ['logout', () => logoutView(deps)],
    ['projects', (body) => projectsView(deps, body)],
    ['validate-path', (body) => validatePath(deps, body)],
    ['link', (body) => linkView(deps, body)],
    ['pull', (body) => pullView(deps, body)],
    ['push', (body) => pushView(deps, body)],
    ['diff', (body) => diffView(deps, body)],
    ['conflicts', (body) => conflictsView(deps, body)],
    ['journal', (body) => journalView(deps, body)],
    ['settings.describe', async () => deps.settings.describeView()],
    ['settings.update', (body) => settingsUpdateView(deps, body)],
  ]

  return routes.map(([name, run]) => ({
    kind: 'exact' as const,
    path: `${PREFIX}${name}`,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void dispatch(deps, run, req, res)
    },
  }))
}

async function dispatch(
  deps: RouteDeps,
  run: Handler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      throw new ApiError('E_VALIDATION', `${req.method ?? 'GET'} is not supported; use POST`, 405)
    }
    if (isCrossSite(req)) {
      throw new ApiError('E_CROSS_SITE', 'cross-site requests are not allowed', 403)
    }
    const body = await readJson(req)
    const value = await run(body)
    sendResult(res, value)
  } catch (err) {
    if (deps.config.debug) {
      // The GUI has no logger of its own; `debug` opts into a stderr line.
      process.stderr.write(`[overleaf-sync] api error: ${describeError(err)}\n`)
    }
    sendFailure(res, err)
  }
}

// --------------------------------------------------------------------- status

async function statusView(deps: RouteDeps): Promise<StatusSummary> {
  const service = deps.service
  const base = await service.status({ cwd: deps.cwd })
  const credential = await service.credential()

  const current = await currentProject(deps)
  const pending = { localChanges: 0, conflicts: 0 }
  if (current !== undefined) {
    pending.localChanges = await countLocalChanges(current.localRoot, current.projectId)
    pending.conflicts = (await listConflicts(deps, current.projectId, deps.config.defaultStrategy)).length
  }

  const text =
    base.authenticated === false
      ? 'Overleaf 未登录：粘贴浏览器 Cookie 后即可拉取项目'
      : current === undefined
        ? '已登录，尚未绑定项目'
        : `已绑定 ${current.projectName}（${current.files} 个文件${pending.conflicts > 0 ? `，${pending.conflicts} 个冲突待处理` : ''}）`

  const view: StatusSummary = {
    baseUrl: base.baseUrl,
    authenticated: base.authenticated,
    projects: base.projects.map((entry) => ({
      projectId: entry.projectId,
      projectName: entry.projectName,
      localRoot: entry.localRoot,
      files: entry.files,
      linkedAt: entry.linkedAt,
    })),
    pending,
    text,
  }
  if (credential !== undefined) {
    const credentialView: { hint?: string; savedAt?: string } = {}
    if (credential.userHint !== undefined) credentialView.hint = credential.userHint
    if (credential.savedAt !== undefined) credentialView.savedAt = credential.savedAt
    view.credential = credentialView
  }
  if (current !== undefined) view.current = current
  return view
}

async function currentProject(
  deps: RouteDeps,
): Promise<StatusSummary['current'] | undefined> {
  let link
  try {
    link = await deps.service.readLink()
  } catch {
    return undefined
  }
  const state = await readProjectState(link.projectId)
  const remoteVersions = state === undefined ? [] : Object.values(state.files).map((file) => file.remoteVersion)
  const current: NonNullable<StatusSummary['current']> = {
    projectId: link.projectId,
    projectName: link.projectName,
    localRoot: link.localRoot,
    files: Object.keys(state?.files ?? {}).length,
  }
  if (remoteVersions.length > 0) current.remoteVersion = Math.max(...remoteVersions)
  if (state !== undefined) current.lastPullAt = state.updatedAt
  if (link.git !== undefined && link.git.mode !== 'none') {
    current.git = { root: link.git.root ?? link.localRoot, mode: link.git.mode }
    if (link.git.initialCommit !== undefined) current.git.head = link.git.initialCommit
  }
  return current
}

/**
 * Files whose bytes no longer match the last synced baseline, plus files that
 * disappeared. Best-effort: an unreadable project reports `0` instead of
 * failing the whole status call.
 */
async function countLocalChanges(localRoot: string, projectId: string): Promise<number> {
  const state = await readProjectState(projectId)
  if (state === undefined) return 0
  let changed = 0
  const seen = new Set<string>()
  let files: string[]
  try {
    files = await listFilesRecursive(localRoot)
  } catch {
    return 0
  }
  for (const rel of files) {
    const baseline = state.files[rel]
    if (baseline === undefined) {
      changed += 1
      continue
    }
    seen.add(rel)
    try {
      const text = await fs.readFile(path.join(localRoot, rel), 'utf8')
      if (sha256(normalizeEol(text)) !== baseline.localHash) changed += 1
    } catch {
      changed += 1
    }
  }
  for (const rel of Object.keys(state.files)) {
    if (!seen.has(rel) && !files.includes(rel)) changed += 1
  }
  return changed
}

// --------------------------------------------------------------- credentials

async function loginView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  const cookie = requireString(body, 'cookie')
  const result = await deps.service.login({
    cookie,
    csrfToken: optionalString(body, 'csrfToken'),
    baseUrl: optionalString(body, 'baseUrl') ?? deps.config.baseUrl,
  })
  return { baseUrl: result.baseUrl, hint: result.hint }
}

async function logoutView(deps: RouteDeps): Promise<unknown> {
  const text = await deps.service.logout()
  return { text }
}

// ------------------------------------------------------------------ projects

async function projectsView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  // `refresh` is a hint for the UI; the service already joins the live project
  // list on every call, so both values take the same path.
  optionalBoolean(body, 'refresh')
  return deps.service.listProjects({ cwd: deps.cwd })
}

async function linkView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  const projectId = requireString(body, 'projectId')
  const localRoot = optionalString(body, 'localRoot')
  const force = optionalBoolean(body, 'force') ?? false
  const input: { projectId: string; localRoot?: string } = { projectId }
  if (localRoot !== undefined) input.localRoot = localRoot

  if (localRoot !== undefined && !force) {
    const target = path.resolve(deps.cwd, expandHome(localRoot))
    const nonEmpty = await isNonEmptyDir(target)
    const alreadyOurs = await isLinkedTo(projectId, target)
    if (nonEmpty && !alreadyOurs) {
      throw new ApiError(
        'E_LOCAL_DIR_CONFIRM_REQUIRED',
        `${target} already has files that did not come from this project`,
        400,
        'confirm with the user, then resend `link` with `force: true`',
      )
    }
  }

  return deps.service.link(input, { cwd: deps.cwd })
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir)
    return entries.some((entry) => !entry.startsWith('.') || entry === '.git')
  } catch {
    return false
  }
}

async function isLinkedTo(projectId: string, dir: string): Promise<boolean> {
  const state = await readProjectState(projectId)
  return state !== undefined && state.localRoot !== '' && path.resolve(state.localRoot) === dir
}

// -------------------------------------------------------------- path checks

async function validatePath(deps: RouteDeps, body: Record<string, unknown>): Promise<PathValidation> {
  const raw = requireString(body, 'path')
  const projectId = optionalString(body, 'projectId')
  const resolved = path.resolve(deps.cwd, expandHome(raw))
  const problems: string[] = []

  let real = resolved
  try {
    real = await fs.realpath(resolved)
  } catch {
    // not created yet: validate the closest existing ancestor instead
    const parent = await realpathParent(resolved)
    if (parent === undefined) problems.push('父目录不存在，无法创建')
    else real = path.join(parent, path.basename(resolved))
  }

  try {
    const stat = await fs.stat(real)
    if (!stat.isDirectory()) problems.push('该路径是一个文件，不是目录')
  } catch {
    // missing directory is fine: pull creates it
  }

  if (projectId !== undefined && problems.length === 0) {
    const existing = await readProjectState(projectId)
    if (existing !== undefined && existing.localRoot !== '' && existing.localRoot !== real) {
      problems.push(`该项目已绑定到 ${existing.localRoot}`)
    }
  }

  if (await isInsideStateRoot(real)) problems.push('不能把项目放到插件自己的状态目录里')

  const view: PathValidation = { ok: problems.length === 0, resolved: real, problems }
  return view
}

async function realpathParent(target: string): Promise<string | undefined> {
  let current = path.dirname(target)
  for (;;) {
    try {
      return await fs.realpath(current)
    } catch {
      const next = path.dirname(current)
      if (next === current) return undefined
      current = next
    }
  }
}

async function isInsideStateRoot(target: string): Promise<boolean> {
  try {
    const root = await fs.realpath(stateRoot())
    return target === root || target.startsWith(root + path.sep)
  } catch {
    return false
  }
}

// --------------------------------------------------------------------- sync

async function pullView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  const projectId = optionalString(body, 'projectId')
  const force = optionalBoolean(body, 'force') ?? false
  const input: { projectId?: string; force?: boolean } = { force }
  if (projectId !== undefined) input.projectId = projectId
  return deps.service.pull(input, { cwd: deps.cwd })
}

async function pushView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  const projectId = optionalString(body, 'projectId')
  const dryRun = optionalBoolean(body, 'dryRun') ?? true
  const confirm = optionalBoolean(body, 'confirm') ?? false
  if (!dryRun && deps.config.confirmRemoteWrite && !confirm) {
    throw new ApiError(
      'E_CONFIRM_REQUIRED',
      'writing to Overleaf needs an explicit confirmation',
      400,
      'resend with `confirm: true` after showing the change list to the user',
    )
  }
  const input: { projectId?: string; dryRun?: boolean } = { dryRun }
  if (projectId !== undefined) input.projectId = projectId
  return deps.service.push(input, { cwd: deps.cwd })
}

async function diffView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  const projectId = optionalString(body, 'projectId')
  const relPath = requireString(body, 'path')
  const input: { projectId?: string; path: string } = { path: relPath }
  if (projectId !== undefined) input.projectId = projectId
  return deps.service.diff(input, { cwd: deps.cwd })
}

// ----------------------------------------------------------- conflicts/logs

async function conflictsView(deps: RouteDeps, body: Record<string, unknown>): Promise<ConflictEntry[]> {
  const projectId = optionalString(body, 'projectId')
  let id = projectId
  if (id === undefined) {
    try {
      id = (await deps.service.readLink()).projectId
    } catch {
      return []
    }
  }
  return listConflicts(deps, id, deps.config.defaultStrategy)
}

async function listConflicts(
  _deps: RouteDeps,
  projectId: string,
  strategy: ConflictStrategy,
): Promise<ConflictEntry[]> {
  const dir = conflictsDir(projectId)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const entries: ConflictEntry[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    let at = new Date(0).toISOString()
    try {
      at = (await fs.stat(full)).mtime.toISOString()
    } catch {
      // keep epoch; the file may vanish between readdir and stat
    }
    // `<relPath>.remote-<ts><ext>` — the copy lives in conflicts/, the main file in the project.
    const match = /^(.*)\.remote-[^.]+(\.[^.]+)?$/.exec(name)
    const mainPath = match === null ? name : `${match[1]}${match[2] ?? ''}`
    entries.push({ path: mainPath, copyPath: name, at, strategy })
  }
  entries.sort((a, b) => b.at.localeCompare(a.at))
  return entries
}

async function journalView(deps: RouteDeps, body: Record<string, unknown>): Promise<JournalEntryView[]> {
  const limit = Math.min(Math.max(optionalNumber(body, 'limit') ?? 50, 1), 500)
  let projectId = optionalString(body, 'projectId')
  if (projectId === undefined) {
    try {
      projectId = (await deps.service.readLink()).projectId
    } catch {
      return []
    }
  }
  let text: string
  try {
    text = await fs.readFile(journalPath(projectId), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const out: JournalEntryView[] = []
  for (const line of lines.slice(-limit)) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') out.push(parsed as JournalEntryView)
    } catch {
      // a torn last line is expected after a crash; skip it
    }
  }
  return out.reverse()
}

// ----------------------------------------------------------------- settings

async function settingsUpdateView(deps: RouteDeps, body: Record<string, unknown>): Promise<unknown> {
  const patch = body.patch
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ApiError('E_VALIDATION', '`patch` must be an object of `{ "dotted.key": value }`', 400)
  }
  const expectedRevision = optionalNumber(body, 'expectedRevision')
  return deps.settings.updateView(patch as Record<string, unknown>, expectedRevision)
}
