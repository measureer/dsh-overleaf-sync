import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

import type { Config } from './config.js'
import { OverleafSyncError, describeError } from './core/errors.js'
import {
  conflictsDir,
  linkPath,
  projectStateDir,
  resolveLocalRoot,
  stateRoot,
  uniquePath,
} from './core/paths.js'
import { atomicWrite, ensureDir, normalizeEol, readTextIfExists, sha256 } from './core/fsUtil.js'
import { ensureGitRepository } from './core/gitInit.js'
import { loadIgnoreMatcher } from './core/ignore.js'
import { appendJournal } from './core/journal.js'
import { diffToOps } from './core/otDiff.js'
import { StateStore } from './core/stateStore.js'
import { clearCredential, loadCredential, saveCredential } from './transport/credentials.js'
import { OverleafHttp } from './transport/http.js'
import { createTransport } from './transport/index.js'
import type {
  Credential,
  GitInitResult,
  LinkRecord,
  OverleafTransport,
  ProjectListEntry,
  ProjectSnapshot,
  RemoteUpdate,
} from './types.js'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  debug?(message: string): void
}

export interface ServiceContext {
  /** session working directory, used to resolve relative paths */
  cwd: string
  signal?: AbortSignal
  logger?: Logger
}

export interface LoginInput {
  cookie: string
  csrfToken?: string
  baseUrl?: string
  userHint?: string
}

export interface LoginResult {
  ok: boolean
  baseUrl: string
  hint?: string
  text: string
}

export interface LinkInput {
  projectId: string
  localRoot?: string
  include?: string[]
  exclude?: string[]
  strategy?: LinkRecord['strategy']
}

export interface PullInput {
  projectId?: string
  docs?: string[]
  force?: boolean
  dryRun?: boolean
  gitInit?: boolean
}

export interface PullSummary {
  projectId: string
  projectName: string
  localRoot: string
  dryRun: boolean
  pulled: string[]
  unchanged: string[]
  skipped: Array<{ path: string; reason: string }>
  conflicts: string[]
  git?: GitInitResult
  warnings: string[]
}

export interface PushInput {
  projectId?: string
  paths?: string[]
  dryRun?: boolean
}

export interface PushSummary {
  projectId: string
  projectName: string
  localRoot: string
  dryRun: boolean
  pushed: string[]
  unchanged: string[]
  skipped: Array<{ path: string; reason: string }>
  conflicts: string[]
  warnings: string[]
}

export interface DiffInput {
  projectId?: string
  path: string
  format?: 'summary' | 'unified'
}

export type DiffStatus =
  | 'in-sync'
  | 'local-changed'
  | 'remote-changed'
  | 'both-changed'
  | 'missing-local'
  | 'missing-remote'

export interface DiffSummary {
  projectId: string
  path: string
  status: DiffStatus
  remoteVersion?: number
  localHash?: string
  baselineHash?: string
  remoteHash?: string
  unified?: string
  text: string
}

export interface StatusSummary {
  baseUrl: string
  authenticated: boolean
  credentialHint?: string
  credentialSavedAt?: string
  projects: Array<{
    projectId: string
    projectName: string
    localRoot: string
    files: number
    git?: string
    linkedAt: string
  }>
  text: string
}

/** A document on the remote side, with its project-relative path. */
interface RemoteDoc {
  docId: string
  relPath: string
}

/** Injection point for tests: swap the socket transport without touching policy. */
export interface ServiceDeps {
  createTransport?: (
    credential: Credential,
    projectId: string,
    options: { signal?: AbortSignal },
  ) => Promise<OverleafTransport>
}

export class OverleafSyncService {
  /** Project ids with a pull/push in flight — a second call gets `E_BUSY`. */
  private readonly busy = new Set<string>()

  constructor(
    readonly config: Config,
    readonly deps: ServiceDeps = {},
  ) {}

  /** Serialize the two operations that touch both sides of the sync. */
  private async exclusive<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(projectId)) {
      throw new OverleafSyncError(
        'E_BUSY',
        `another pull/push is already running for project "${projectId}"`,
        'wait for it to finish, then retry',
      )
    }
    this.busy.add(projectId)
    try {
      return await run()
    } finally {
      this.busy.delete(projectId)
    }
  }

  // ---------------------------------------------------------------- credentials

  async credential(): Promise<Credential | undefined> {
    return loadCredential()
  }

  async requireCredential(): Promise<Credential> {
    const credential = await loadCredential()
    if (!credential) {
      throw new OverleafSyncError(
        'E_AUTH_REQUIRED',
        'no Overleaf session stored',
        'run overleaf_login with the Cookie and CSRF token copied from a logged-in browser tab',
      )
    }
    return credential
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? this.config.baseUrl)
    const cookie = input.cookie?.trim()
    if (!cookie) {
      throw new OverleafSyncError('E_AUTH_REQUIRED', 'cookie is empty', 'copy the full `Cookie` request header from a logged-in Overleaf tab')
    }
    const csrfToken = input.csrfToken?.trim() || (await this.fetchCsrfToken(baseUrl, cookie))
    const saved = await saveCredential({
      baseUrl,
      cookie,
      csrfToken,
      ...(input.userHint ? { userHint: input.userHint } : {}),
    })
    const check = await new OverleafHttp(saved).whoami()
    if (!check.ok) {
      throw new OverleafSyncError(
        'E_AUTH_EXPIRED',
        'the pasted session was rejected by Overleaf',
        'make sure you copied the cookie from an account that can open the project, then retry overleaf_login',
      )
    }
    const hint = check.hint ?? saved.userHint
    return {
      ok: true,
      baseUrl,
      ...(hint ? { hint } : {}),
      text: `Logged in to ${baseUrl}${hint ? ` as ${hint}` : ''}. Session saved to ${stateRoot()}\\credentials.json (no password stored).`,
    }
  }

  async logout(): Promise<string> {
    await clearCredential()
    return 'Overleaf session cleared.'
  }

  private async fetchCsrfToken(baseUrl: string, cookie: string): Promise<string> {
    const res = await fetch(baseUrl, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.text()
    const meta = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/i)
    if (meta?.[1]) return meta[1]
    const form = body.match(/<input[^>]*name="_csrf"[^>]*value="([^"]*)"/i)
    if (form?.[1]) return form[1]
    throw new OverleafSyncError(
      'E_CONFIG',
      'could not find a CSRF token on the Overleaf page',
      'pass csrfToken explicitly (DevTools → Network → any request → X-Csrf-Token), or copy it from the page <meta name="ol-csrfToken">',
    )
  }

  // ------------------------------------------------------------------- projects

  async listProjects(ctx: ServiceContext): Promise<ProjectListEntry[]> {
    const credential = await this.requireCredential()
    const http = new OverleafHttp(credential)
    return http.listProjects(ctx.signal)
  }

  async link(input: LinkInput, ctx: ServiceContext): Promise<LinkRecord> {
    const projectId = input.projectId?.trim()
    if (!projectId) throw new OverleafSyncError('E_PROJECT_NOT_FOUND', 'projectId is required', 'run overleaf_projects to list ids')

    const projects = await this.listProjects(ctx)
    const project = projects.find((entry) => entry.id === projectId)
    if (!project) {
      throw new OverleafSyncError(
        'E_PROJECT_NOT_FOUND',
        `project ${projectId} is not visible to this account`,
        'run overleaf_projects to refresh the list',
      )
    }

    const existing = await this.readLink(projectId).catch(() => undefined)
    let localRoot: string
    if (input.localRoot) {
      localRoot = path.resolve(ctx.cwd, input.localRoot)
    } else if (existing) {
      localRoot = existing.localRoot
    } else {
      const candidate = resolveLocalRoot(this.config.localRootPattern, { project: project.name, cwd: ctx.cwd })
      localRoot = uniquePath(candidate, (dir) => existsSync(dir))
    }

    const now = new Date().toISOString()
    const record: LinkRecord = {
      schemaVersion: 1,
      projectId,
      projectName: project.name,
      localRoot,
      include: input.include ?? existing?.include ?? ['**/*.tex', '**/*.bib', '**/*.cls', '**/*.sty', '**/*.md', '**/*.txt'],
      exclude: input.exclude ?? existing?.exclude ?? ['**/*.pdf', '.git/**', 'node_modules/**'],
      strategy: input.strategy ?? existing?.strategy ?? this.config.defaultStrategy,
      autoPush: existing?.autoPush ?? true,
      throttleMs: existing?.throttleMs ?? 500,
      binary: existing?.binary ?? 'download-only',
      ...(existing?.git ? { git: existing.git } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await ensureDir(projectStateDir(projectId))
    await writeJson(linkPath(projectId), record)
    return record
  }

  /** Read one link record; without an id, resolve the only linked project. */
  async readLink(projectId?: string): Promise<LinkRecord> {
    if (projectId) {
      const file = linkPath(projectId)
      if (!existsSync(file)) {
        throw new OverleafSyncError(
          'E_NOT_LINKED',
          `project ${projectId} is not linked to a local folder yet`,
          'run overleaf_link first (projectId + optional localRoot)',
        )
      }
      return JSON.parse(await fs.readFile(file, 'utf8')) as LinkRecord
    }
    const dir = path.join(stateRoot(), 'projects')
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    const records: LinkRecord[] = []
    for (const entry of entries) {
      const file = path.join(dir, entry, 'link.json')
      if (!existsSync(file)) continue
      try {
        records.push(JSON.parse(await fs.readFile(file, 'utf8')) as LinkRecord)
      } catch {
        // ignore corrupt link files; they surface through overleaf_status
      }
    }
    if (records.length === 0) {
      throw new OverleafSyncError('E_NOT_LINKED', 'no project is linked yet', 'run overleaf_projects, then overleaf_link')
    }
    if (records.length > 1) {
      throw new OverleafSyncError(
        'E_NOT_LINKED',
        `several projects are linked (${records.map((r) => r.projectName).join(', ')})`,
        'pass projectId explicitly',
      )
    }
    return records[0]!
  }

  // ----------------------------------------------------------------------- pull

  async pull(input: PullInput, ctx: ServiceContext): Promise<PullSummary> {
    const projectId = input.projectId ?? (await this.readLink()).projectId
    return this.exclusive(projectId, () => this.pullUnlocked(input, ctx))
  }

  private async pullUnlocked(input: PullInput, ctx: ServiceContext): Promise<PullSummary> {
    const link = await this.readLink(input.projectId)
    const credential = await this.requireCredential()
    const warnings: string[] = []
    const summary: PullSummary = {
      projectId: link.projectId,
      projectName: link.projectName,
      localRoot: link.localRoot,
      dryRun: input.dryRun === true,
      pulled: [],
      unchanged: [],
      skipped: [],
      conflicts: [],
      warnings,
    }

    const openTransport = this.deps.createTransport ?? createTransport
    const transport = await openTransport(credential, link.projectId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    try {
      const snapshot = await transport.joinProject()
      const remoteDocs = this.collectDocs(snapshot)
      const ignore = await loadIgnoreMatcher(link.localRoot, link.exclude)
      const wanted = new Set(input.docs?.map((doc) => doc.replaceAll('\\', '/')) ?? [])

      const store = await StateStore.load(link.projectId, link.localRoot)
      if (!input.dryRun) await ensureDir(link.localRoot)

      for (const doc of remoteDocs) {
        const relPath = doc.relPath
        if (wanted.size > 0 && !wanted.has(relPath) && !wanted.has(doc.docId)) continue
        if (ignore(relPath)) {
          summary.skipped.push({ path: relPath, reason: 'ignored' })
          continue
        }
        const target = path.join(link.localRoot, ...relPath.split('/'))
        const previous = store.get(relPath)
        const content = await transport.joinDoc(doc.docId)
        const remoteHash = sha256(normalizeEol(content.text))
        const localText = await readTextIfExists(target)
        const localHash = localText === undefined ? undefined : sha256(normalizeEol(localText))

        if (previous && localHash === previous.localHash && previous.remoteHash === remoteHash) {
          summary.unchanged.push(relPath)
          continue
        }

        const localChanged = localHash !== undefined && previous !== undefined && localHash !== previous.localHash
        if (localChanged && !input.force) {
          const conflictFile = await this.saveConflict(link, relPath, localText ?? '', content.text, {
            reason: 'local-changed',
            localVersion: previous?.remoteVersion,
            remoteVersion: content.version,
          })
          summary.conflicts.push(relPath)
          summary.skipped.push({ path: relPath, reason: `local-changed (kept; remote copy: ${conflictFile})` })
          continue
        }

        if (input.dryRun) {
          summary.pulled.push(relPath)
          continue
        }

        await ensureDir(path.dirname(target))
        await atomicWrite(target, content.text)
        store.set(relPath, {
          docId: doc.docId,
          remoteVersion: content.version,
          remoteHash,
          localHash: remoteHash,
          syncedAt: new Date().toISOString(),
          origin: 'remote',
        })
        summary.pulled.push(relPath)
        await this.journal(link.projectId, { event: 'pull', path: relPath, v: content.version, ok: true })
      }

      if (!input.dryRun) {
        await store.save()
        const gitEnabled = input.gitInit ?? this.config.git.autoInit
        const git = await ensureGitRepository({
          enabled: gitEnabled,
          localRoot: link.localRoot,
          projectName: link.projectName,
          projectId: link.projectId,
          initialCommitMessage: this.config.git.initialCommitMessage,
          includeBinary: this.config.git.includeBinaryInFirstCommit,
        })
        summary.git = git
        if (git.warning) warnings.push(git.warning)
        if (git.created || git.mode !== 'none') {
          await this.updateGitRecord(link, git)
        }
      }
      return summary
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  // --------------------------------------------------------------------- status

  /**
   * Local → remote. Only documents the baseline knows about are pushed; a document
   * whose remote text moved since the baseline is never overwritten silently.
   */
  async push(input: PushInput, ctx: ServiceContext): Promise<PushSummary> {
    const projectId = input.projectId ?? (await this.readLink()).projectId
    return this.exclusive(projectId, () => this.pushUnlocked(input, ctx))
  }

  private async pushUnlocked(input: PushInput, ctx: ServiceContext): Promise<PushSummary> {
    const link = await this.readLink(input.projectId)
    const credential = await this.requireCredential()
    const warnings: string[] = []
    const summary: PushSummary = {
      projectId: link.projectId,
      projectName: link.projectName,
      localRoot: link.localRoot,
      dryRun: input.dryRun === true,
      pushed: [],
      unchanged: [],
      skipped: [],
      conflicts: [],
      warnings,
    }

    const openTransport = this.deps.createTransport ?? createTransport
    const transport = await openTransport(credential, link.projectId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    try {
      const snapshot = await transport.joinProject()
      const remoteDocs = this.collectDocs(snapshot)
      const ignore = await loadIgnoreMatcher(link.localRoot, link.exclude)
      const wanted = new Set(input.paths?.map((item) => item.replaceAll('\\', '/')) ?? [])
      const store = await StateStore.load(link.projectId, link.localRoot)

      for (const doc of remoteDocs) {
        const relPath = doc.relPath
        if (wanted.size > 0 && !wanted.has(relPath) && !wanted.has(doc.docId) && !wanted.has(path.posix.basename(relPath))) {
          continue
        }
        if (ignore(relPath)) {
          summary.skipped.push({ path: relPath, reason: 'ignored' })
          continue
        }
        const target = path.join(link.localRoot, ...relPath.split('/'))
        const localText = await readTextIfExists(target)
        if (localText === undefined) {
          summary.skipped.push({ path: relPath, reason: 'missing locally' })
          continue
        }
        const localHash = sha256(normalizeEol(localText))
        const previous = store.get(relPath)
        if (previous && previous.localHash === localHash) {
          summary.unchanged.push(relPath)
          continue
        }

        const remote = await transport.joinDoc(doc.docId)
        const remoteHash = sha256(normalizeEol(remote.text))
        const remoteMoved = previous !== undefined && previous.remoteHash !== remoteHash
        if (remoteMoved && !previous?.localHash) {
          summary.skipped.push({ path: relPath, reason: 'no baseline' })
          continue
        }
        if (remoteMoved) {
          const conflictFile = await this.saveConflict(link, relPath, localText, remote.text, {
            reason: 'remote-changed',
            localVersion: previous?.remoteVersion,
            remoteVersion: remote.version,
          })
          summary.conflicts.push(relPath)
          summary.skipped.push({ path: relPath, reason: `remote-changed (kept; remote copy: ${conflictFile})` })
          continue
        }

        const ops = diffToOps(remote.text, localText)
        if (input.dryRun) {
          summary.pushed.push(relPath)
          continue
        }
        const applied = await transport.applyOtUpdate(doc.docId, remote.version, ops)
        store.set(relPath, {
          docId: doc.docId,
          remoteVersion: applied.version,
          remoteHash: localHash,
          localHash,
          syncedAt: new Date().toISOString(),
          origin: 'local',
        })
        summary.pushed.push(relPath)
        await this.journal(link.projectId, { event: 'push', path: relPath, v: applied.version, ok: true })
      }

      if (!input.dryRun) await store.save()
      return summary
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  /** Three-way comparison of one document: local file vs baseline vs remote. */
  async diff(input: DiffInput, ctx: ServiceContext): Promise<DiffSummary> {
    const link = await this.readLink(input.projectId)
    const credential = await this.requireCredential()
    const wanted = input.path.replaceAll('\\', '/')
    const openTransport = this.deps.createTransport ?? createTransport
    const transport = await openTransport(credential, link.projectId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    try {
      const snapshot = await transport.joinProject()
      const remoteDocs = this.collectDocs(snapshot)
      const doc =
        remoteDocs.find((item) => item.relPath === wanted) ??
        remoteDocs.find((item) => item.docId === wanted) ??
        remoteDocs.find((item) => path.posix.basename(item.relPath) === wanted)
      if (!doc) {
        throw new OverleafSyncError(
          'E_NOT_LINKED',
          `No document "${input.path}" in project "${link.projectName}".`,
          'Run overleaf_pull first to see the remote tree, or pass the exact project-relative path.',
        )
      }
      const remote = await transport.joinDoc(doc.docId)
      const target = path.join(link.localRoot, ...doc.relPath.split('/'))
      const localText = await readTextIfExists(target)
      const store = await StateStore.load(link.projectId, link.localRoot)
      const previous = store.get(doc.relPath)

      const remoteHash = sha256(normalizeEol(remote.text))
      const localHash = localText === undefined ? undefined : sha256(normalizeEol(localText))
      const baselineHash = previous?.localHash

      let status: DiffStatus
      if (localText === undefined) status = 'missing-local'
      else if (!previous) status = 'both-changed'
      else if (localHash === baselineHash && remoteHash === previous.remoteHash) status = 'in-sync'
      else if (localHash === baselineHash) status = 'remote-changed'
      else if (remoteHash === previous.remoteHash) status = 'local-changed'
      else status = 'both-changed'

      const summary: DiffSummary = {
        projectId: link.projectId,
        path: doc.relPath,
        status,
        remoteVersion: remote.version,
        ...(localHash ? { localHash } : {}),
        ...(baselineHash ? { baselineHash } : {}),
        remoteHash,
        text: '',
      }
      if (input.format === 'unified' && localText !== undefined) {
        summary.unified = unifiedDiff(previous ? 'baseline' : 'remote', 'local', remote.text, localText)
      }
      summary.text = describeDiff(summary)
      return summary
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  async status(ctx: ServiceContext): Promise<StatusSummary> {
    const credential = await this.credential()
    const projects: StatusSummary['projects'] = []
    const dir = path.join(stateRoot(), 'projects')
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const file = path.join(dir, entry, 'link.json')
      if (!existsSync(file)) continue
      try {
        const link = JSON.parse(await fs.readFile(file, 'utf8')) as LinkRecord
        const state = await StateStore.load(link.projectId, link.localRoot)
        projects.push({
          projectId: link.projectId,
          projectName: link.projectName,
          localRoot: link.localRoot,
          files: Object.keys(state.state.files).length,
          ...(link.git ? { git: describeGit(link.git) } : {}),
          linkedAt: link.createdAt,
        })
      } catch {
        // skip unreadable records
      }
    }
    const authenticated = Boolean(credential)
    const lines: string[] = []
    lines.push(`Overleaf: ${authenticated ? 'authenticated' : 'not logged in'} (${this.config.baseUrl})`)
    if (credential?.userHint) lines.push(`account hint: ${credential.userHint}`)
    lines.push(`watcher: off (watch.autoStart=${this.config.watch.autoStart})`)
    if (projects.length === 0) {
      lines.push('linked projects: none')
    } else {
      lines.push('linked projects:')
      for (const project of projects) {
        lines.push(`- ${project.projectName} (${project.projectId}) → ${project.localRoot} · ${project.files} files${project.git ? ` · git ${project.git}` : ''}`)
      }
    }
    return {
      baseUrl: this.config.baseUrl,
      authenticated,
      ...(credential?.userHint ? { credentialHint: credential.userHint } : {}),
      ...(credential?.savedAt ? { credentialSavedAt: credential.savedAt } : {}),
      projects,
      text: lines.join('\n'),
    }
  }

  // -------------------------------------------------------------------- helpers

  /** Flatten the remote tree into project-relative document paths. */
  collectDocs(snapshot: ProjectSnapshot): RemoteDoc[] {
    const folders = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
    const memo = new Map<string, string>()
    const resolveFolder = (folderId: string | null, depth = 0): string => {
      if (!folderId) return ''
      if (depth > 64) return ''
      const cached = memo.get(folderId)
      if (cached !== undefined) return cached
      const folder = folders.get(folderId)
      if (!folder) return ''
      const parent = resolveFolder(folder.parentFolderId, depth + 1)
      const full = parent ? `${parent}/${folder.name}` : folder.name
      memo.set(folderId, full)
      return full
    }
    const docs: RemoteDoc[] = []
    for (const doc of snapshot.docs) {
      const folder = resolveFolder(doc.parentFolderId)
      const relPath = sanitizeRelative(folder ? `${folder}/${doc.name}` : doc.name)
      if (!relPath) continue
      docs.push({ docId: doc.id, relPath })
    }
    return docs
  }

  private async saveConflict(
    link: LinkRecord,
    relPath: string,
    localText: string,
    remoteText: string,
    meta: Record<string, unknown>,
  ): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(conflictsDir(link.projectId), stamp)
    const base = path.join(dir, ...relPath.split('/'))
    await ensureDir(path.dirname(base))
    await atomicWrite(`${base}.local`, localText)
    await atomicWrite(`${base}.remote`, remoteText)
    await atomicWrite(`${base}.meta.json`, JSON.stringify({ path: relPath, ...meta, createdAt: new Date().toISOString() }, null, 2))

    // A copy the user can actually see: `foo.remote-<stamp>.tex` next to `foo.tex`
    // (design §5.6). Repeated pulls with the same remote text reuse the copy
    // instead of filling the folder with duplicates.
    const parsed = path.posix.parse(relPath)
    const visibleRel = path.posix.join(parsed.dir, `${parsed.name}.remote-${stamp}${parsed.ext}`)
    const visibleAbs = path.join(link.localRoot, ...visibleRel.split('/'))
    const reusable = await this.findReusableConflictCopy(
      path.dirname(visibleAbs),
      parsed.dir,
      parsed.name,
      parsed.ext,
      remoteText,
    )
    if (reusable) return reusable
    await ensureDir(path.dirname(visibleAbs))
    await atomicWrite(visibleAbs, remoteText)
    return visibleRel
  }

  /** Look for `name.remote-*.ext` next to the file whose content already equals `remoteText`. */
  private async findReusableConflictCopy(
    dirAbs: string,
    relDir: string,
    stem: string,
    ext: string,
    remoteText: string,
  ): Promise<string | undefined> {
    let names: string[]
    try {
      names = await fs.readdir(dirAbs)
    } catch {
      return undefined
    }
    const wanted = sha256(normalizeEol(remoteText))
    for (const name of names) {
      if (!name.startsWith(`${stem}.remote-`)) continue
      if (ext && !name.endsWith(ext)) continue
      const text = await readTextIfExists(path.join(dirAbs, name))
      if (text !== undefined && sha256(normalizeEol(text)) === wanted) {
        return path.posix.join(relDir, name)
      }
    }
    return undefined
  }

  private async updateGitRecord(link: LinkRecord, git: GitInitResult): Promise<void> {
    const next: LinkRecord = { ...link, git, updatedAt: new Date().toISOString() }
    await writeJson(linkPath(link.projectId), next)
  }

  private async journal(projectId: string, entry: Parameters<typeof appendJournal>[1]): Promise<void> {
    try {
      await appendJournal(projectId, entry, {
        enabled: this.config.journal.enabled,
        keepDays: this.config.journal.keepDays,
      })
    } catch {
      // journaling must never break a sync
    }
  }
}


/** Human wording for {@link DiffSummary.status}. */
export function describeDiff(summary: DiffSummary): string {
  const head = `${summary.path} (v${summary.remoteVersion ?? '?'}): ${summary.status}`
  const lines = [head]
  switch (summary.status) {
    case 'in-sync':
      lines.push('local file, baseline and remote all agree — safe to skip.')
      break
    case 'local-changed':
      lines.push('only the local file moved — `overleaf_push` would send it.')
      break
    case 'remote-changed':
      lines.push('only Overleaf moved — `overleaf_pull` would update the local file.')
      break
    case 'both-changed':
      lines.push('both sides moved since the last sync — a pull or push will produce a conflict copy.')
      break
    case 'missing-local':
      lines.push('the document exists remotely but not locally — `overleaf_pull` recreates it.')
      break
    case 'missing-remote':
      lines.push('the document is gone from Overleaf.')
      break
  }
  if (summary.unified) lines.push('', summary.unified)
  return lines.join('\n')
}

/** Line-level unified diff with a small context window; good enough for `.tex` review. */
export function unifiedDiff(fromLabel: string, toLabel: string, fromText: string, toText: string): string {
  const from = fromText.split('\n')
  const to = toText.split('\n')
  let prefix = 0
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const context = 2
  const start = Math.max(0, prefix - context)
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`, `@@ -${start + 1} +${start + 1} @@`]
  for (let i = start; i < prefix; i += 1) out.push(` ${from[i]}`)
  for (let i = prefix; i < from.length - suffix; i += 1) out.push(`-${from[i]}`)
  for (let i = prefix; i < to.length - suffix; i += 1) out.push(`+${to[i]}`)
  const tail = Math.min(from.length, from.length - suffix + context)
  for (let i = from.length - suffix; i < tail; i += 1) out.push(` ${from[i]}`)
  return out.join('\n')
}

// ------------------------------------------------------------------ utilities

export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim())
  url.pathname = url.pathname.replace(/\/?$/, '/')
  return url.href
}

export function describeGit(git: NonNullable<LinkRecord['git']>): string {
  if (git.mode === 'parent') return `parent repo (${git.root ?? 'unknown root'})`
  if (git.mode === 'own') return `own repo @${git.initialCommit ?? 'unknown'}`
  return `no repo${git.reason ? ` (${git.reason})` : ''}`
}

/** Reject absolute paths, `..` segments and Windows device names coming from the remote tree. */
export function sanitizeRelative(relPath: string): string | undefined {
  const parts = relPath.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return undefined
  for (const part of parts) {
    if (part === '.' || part === '..') return undefined
    if (/^[A-Za-z]:$/.test(part)) return undefined
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) return undefined
  }
  return parts.join('/')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await atomicWrite(file, JSON.stringify(value, null, 2))
}

/** Placeholder used by the watch service (M3); exported so the type is not dead. */
export type RemoteUpdateHandler = (update: RemoteUpdate) => void
export type TransportHandle = OverleafTransport
export type PullSummaryOf = PullSummary
