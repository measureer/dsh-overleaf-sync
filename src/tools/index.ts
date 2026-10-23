/**
 * The agent-facing surface: narrow tools, all thin wrappers over
 * {@link OverleafSyncService}. Every tool returns `{ text, ...data }` so the
 * model always gets a readable summary plus structured fields to branch on.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { Config } from '../config.js'
import { describeError, isOverleafError, OverleafSyncError } from '../core/errors.js'
import {
  OverleafSyncService,
  type ConflictsSummary,
  type PullSummary,
  type PushSummary,
  type ResolveSummary,
  type ServiceContext,
  type WatchStatus,
} from '../service.js'

/** Output schema shared by every tool: a human summary plus free-form fields. */
const summaryOutput = {
  type: 'object',
  additionalProperties: true,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

function textOf(value: unknown): string {
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return JSON.stringify(value)
}

/**
 * Canonical values are plain summary objects; the model only ever sees `text`.
 * The cast keeps `defineTool`'s strict `JsonValue` inference out of the way.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJson(value: unknown): any {
  return value
}

function renderText(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: textOf(value) }]
}

function contextOf(exec: { signal?: AbortSignal }, cwd: string): ServiceContext {
  return {
    cwd,
    ...(exec.signal ? { signal: exec.signal } : {}),
  }
}

/** Wrap a failure so the model sees `code: message — hint`. */
function failure(error: unknown): never {
  if (isOverleafError(error)) throw error
  const message = describeError(error)
  throw new OverleafSyncError('E_TRANSPORT', message)
}

export function createOverleafTools(service: OverleafSyncService, config: Config): ToolDefinition[] {
  const cwd = process.cwd()

  const status = defineTool({
    name: 'overleaf_status',
    description:
      'Show whether an Overleaf session is stored, the instance URL, the watcher state, and every project ' +
      'linked to a local folder. Start here when the user asks what is synced.',
    parameters: {},
    output: { schema: summaryOutput, render: renderText },
    execute: async () => {
      const summary = await service.status({ cwd })
      return asJson({
        text: summary.text,
        authenticated: summary.authenticated,
        baseUrl: summary.baseUrl,
        projects: summary.projects,
      })
    },
  })

  const login = defineTool({
    name: 'overleaf_login',
    description:
      'Store an Overleaf browser session so later tools can act as the user. Takes the raw `Cookie` header value ' +
      'and, optionally, the CSRF token from a logged-in Overleaf tab. Never asks for the password.',
    parameters: {
      cookie: {
        type: 'string',
        required: true,
        description: 'Full `Cookie:` request header copied from a logged-in Overleaf tab (contains overleaf_session2).',
      },
      csrfToken: {
        type: 'string',
        description: 'Value of X-Csrf-Token / <meta name="ol-csrfToken">. Omitted: fetched from the Overleaf home page.',
      },
      baseUrl: {
        type: 'string',
        description: 'Overleaf root such as https://www.overleaf.com (defaults to the plugin config).',
      },
      userHint: { type: 'string', description: 'Optional label shown in overleaf_status, e.g. the account email.' },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args) => {
      try {
        const result = await service.login({
          cookie: args.cookie,
          ...(args.csrfToken ? { csrfToken: args.csrfToken } : {}),
          ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
          ...(args.userHint ? { userHint: args.userHint } : {}),
        })
        return asJson({ text: result.text, ok: result.ok, baseUrl: result.baseUrl })
      } catch (error) {
        failure(error)
      }
    },
  })

  const logout = defineTool({
    name: 'overleaf_logout',
    description: 'Delete the stored Overleaf session (credentials.json). Local files and links stay untouched.',
    parameters: {},
    output: { schema: summaryOutput, render: renderText },
    execute: async () => asJson({ text: await service.logout() }),
  })

  const projects = defineTool({
    name: 'overleaf_projects',
    description:
      'List the Overleaf projects this session can see (id, name, last update). Use it to resolve a project name ' +
      'to the projectId required by overleaf_link.',
    parameters: {},
    output: { schema: summaryOutput, render: renderText },
    execute: async (_args, exec) => {
      try {
        const list = await service.listProjects(contextOf(exec, cwd))
        const lines = list.map((project) => `- ${project.name} (${project.id})${project.lastUpdated ? ` · ${project.lastUpdated}` : ''}`)
        return asJson({
          text: list.length === 0 ? 'No projects visible to this session.' : `Projects (${list.length}):\n${lines.join('\n')}`,
          projects: list,
        })
      } catch (error) {
        failure(error)
      }
    },
  })

  const link = defineTool({
    name: 'overleaf_link',
    description:
      'Link an Overleaf project to a local folder. Without localRoot the folder is derived from the ' +
      '`localRootPattern` config (~/Overleaf/<project> by default). Re-linking keeps the existing folder.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Project id from overleaf_projects.' },
      localRoot: {
        type: 'string',
        description: 'Target folder. Relative paths resolve against the session working directory.',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns of remote files to sync (defaults to LaTeX/text extensions).',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to skip (defaults to PDFs, .git and node_modules).',
      },
      strategy: {
        type: 'string',
        enum: ['keep-both', 'keep-local', 'keep-remote', 'auto'],
        description: 'Conflict policy for later pushes/pulls.',
      },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const record = await service.link(
          {
            projectId: args.projectId,
            ...(args.localRoot ? { localRoot: args.localRoot } : {}),
            ...(args.include ? { include: args.include } : {}),
            ...(args.exclude ? { exclude: args.exclude } : {}),
            ...(args.strategy ? { strategy: args.strategy } : {}),
          },
          contextOf(exec, cwd),
        )
        return asJson({
          text:
            `Linked "${record.projectName}" (${record.projectId}) → ${record.localRoot}\n` +
            `strategy: ${record.strategy} · include: ${(record.include ?? []).join(', ')}\n` +
            'Next: overleaf_pull to download the project.',
          link: record,
        })
      } catch (error) {
        failure(error)
      }
    },
  })

  const pull = defineTool({
    name: 'overleaf_pull',
    description:
      'Download a linked project (or some of its documents) into the local folder, then create a git repository ' +
      'on first run when `git.autoInit` is on. Never overwrites files whose local edits are not yet pushed: those ' +
      'get a conflict copy instead unless `force` is set.',
    parameters: {
      projectId: { type: 'string', description: 'Defaults to the only linked project.' },
      docs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit the pull to these project-relative paths or document ids.',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite locally modified files (a conflict copy is still written first).',
      },
      dryRun: { type: 'boolean', description: 'Report what would change without touching the disk.' },
      gitInit: {
        type: 'boolean',
        description: 'Override `git.autoInit` for this call (false = do not create a repository).',
      },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const summary = await service.pull(
          {
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.docs ? { docs: args.docs } : {}),
            ...(args.force === undefined ? {} : { force: args.force }),
            ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
            ...(args.gitInit === undefined ? {} : { gitInit: args.gitInit }),
          },
          contextOf(exec, cwd),
        )
        return asJson({ text: describePull(summary, config), summary })
      } catch (error) {
        failure(error)
      }
    },
  })

  const push = defineTool({
    name: 'overleaf_push',
    description:
      'Upload local edits of a linked project to Overleaf. Dry run by default — pass `dryRun: false` to write. ' +
      'A document whose remote text moved since the last sync is never overwritten: it is reported as a conflict ' +
      'and the remote text is saved next to it as `<name>.remote-<ts>.tex`.',
    parameters: {
      projectId: { type: 'string', description: 'Defaults to the only linked project.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit the push to these project-relative paths, document ids or file names.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Report what would be sent without writing to Overleaf (default true).',
      },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const summary = await service.push(
          {
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.paths ? { paths: args.paths } : {}),
            dryRun: args.dryRun ?? true,
          },
          contextOf(exec, cwd),
        )
        return asJson({ text: describePush(summary), summary })
      } catch (error) {
        failure(error)
      }
    },
  })

  const diff = defineTool({
    name: 'overleaf_diff',
    description:
      'Compare one document three ways (local file / last synced baseline / current Overleaf text) and say whether ' +
      'a push or a pull is safe. Use `format: "unified"` to see the actual line changes.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project-relative path, document id or file name.' },
      projectId: { type: 'string', description: 'Defaults to the only linked project.' },
      format: {
        type: 'string',
        enum: ['summary', 'unified'],
        description: '`summary` (default) or `unified` for the line diff.',
      },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const summary = await service.diff(
          {
            path: args.path,
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.format ? { format: args.format } : {}),
          },
          contextOf(exec, cwd),
        )
        return asJson({ text: summary.text, diff: summary })
      } catch (error) {
        failure(error)
      }
    },
  })

  const conflictsTool = defineTool({
    name: 'overleaf_conflicts',
    description:
      'List unresolved sync conflicts: files where the local copy and Overleaf both changed, so one side ' +
      'was kept and the other saved next to it. Shows the suggested command to settle each one.',
    parameters: {
      projectId: { type: 'string', description: 'Defaults to the only linked project.' },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const summary = await service.conflicts(
          { ...(args.projectId ? { projectId: args.projectId } : {}) },
          contextOf(exec, cwd),
        )
        return asJson({ text: describeConflicts(summary), conflicts: summary.conflicts })
      } catch (error) {
        failure(error)
      }
    },
  })

  const resolveTool = defineTool({
    name: 'overleaf_resolve',
    description:
      'Settle a sync conflict. `keep_local` keeps your file (the next push sends it), `keep_remote` ' +
      'overwrites it with the Overleaf copy, `merge` keeps both and only clears the conflict record. ' +
      'Both sides stay archived under the plugin state directory, so nothing is lost.',
    parameters: {
      path: { type: 'string', description: 'Project-relative path (or file name) of the conflicted file.' },
      projectId: { type: 'string', description: 'Defaults to the only linked project.' },
      choice: {
        type: 'string',
        enum: ['keep_local', 'keep_remote', 'merge'],
        description: 'How to settle it. Defaults to `keep_local`.',
      },
      all: { type: 'boolean', description: 'Settle every open conflict instead of a single path.' },
      dryRun: { type: 'boolean', description: 'Report what would change without touching files.' },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const summary = await service.resolve(
          {
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.path ? { path: args.path } : {}),
            ...(args.all === undefined ? {} : { all: args.all }),
            ...(args.choice ? { choice: args.choice as ResolveSummary['choice'] } : {}),
            ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
          },
          contextOf(exec, cwd),
        )
        return asJson({ text: describeResolve(summary), resolve: summary })
      } catch (error) {
        failure(error)
      }
    },
  })

  const watchTool = defineTool({
    name: 'overleaf_watch',
    description:
      'Start or stop the background two-way sync: local edits to linked documents are pushed to Overleaf ' +
      'within a second, and Overleaf edits are written back to disk. Off by default — while it runs it ' +
      'holds one socket open, and a server that only allows one live session per project may reject it.',
    parameters: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status'],
        required: true,
        description: '`start` begins watching, `stop` ends it, `status` reports recent activity.',
      },
      projectId: { type: 'string', description: 'Defaults to the only linked project.' },
    },
    output: { schema: summaryOutput, render: renderText },
    execute: async (args, exec) => {
      try {
        const summary = await service.watch(
          {
            action: args.action as 'start' | 'stop' | 'status',
            ...(args.projectId ? { projectId: args.projectId } : {}),
          },
          contextOf(exec, cwd),
        )
        return asJson({ text: describeWatch(summary), watch: summary })
      } catch (error) {
        failure(error)
      }
    },
  })

  return [status, login, logout, projects, link, pull, push, diff, conflictsTool, resolveTool, watchTool]
}


export function describePush(summary: PushSummary): string {
  const head = summary.dryRun ? `Dry run: ${summary.projectName}` : `Pushed ${summary.projectName}`
  const lines = [
    `${head} → ${summary.localRoot}`,
    `files: ${summary.pushed.length} ${summary.dryRun ? 'to send' : 'sent'} · ${summary.unchanged.length} unchanged · ${summary.skipped.length} skipped`,
  ]
  if (summary.pushed.length > 0) {
    const shown = summary.pushed.slice(0, 12)
    lines.push(`${summary.dryRun ? 'would send' : 'sent'}: ${shown.join(', ')}${summary.pushed.length > shown.length ? ` … (+${summary.pushed.length - shown.length})` : ''}`)
  }
  if (summary.conflicts.length > 0) {
    lines.push(`conflicts (${summary.conflicts.length}): ${summary.conflicts.slice(0, 5).join(', ')} — Overleaf changed too, local kept, remote saved as *.remote-<ts>`)
  }
  if (summary.warnings.length > 0) lines.push(`warnings: ${summary.warnings.join('; ')}`)
  if (summary.dryRun) lines.push('(dry run: nothing was written to Overleaf; call again with dryRun: false to send)')
  return lines.join('\n')
}

export function describePull(summary: PullSummary, config: Config): string {
  const head = summary.dryRun ? `Dry run: ${summary.projectName}` : `Pulled ${summary.projectName}`
  const lines = [
    `${head} → ${summary.localRoot}`,
    `files: ${summary.pulled.length} written · ${summary.unchanged.length} unchanged · ${summary.skipped.length} skipped`,
  ]
  if (summary.pulled.length > 0) {
    const shown = summary.pulled.slice(0, 12)
    lines.push(`written: ${shown.join(', ')}${summary.pulled.length > shown.length ? ` … (+${summary.pulled.length - shown.length})` : ''}`)
  }
  if (summary.conflicts.length > 0) {
    lines.push(`conflicts (${summary.conflicts.length}): ${summary.conflicts.slice(0, 5).join(', ')} — kept the local copy, remote saved as *.remote`)
  }
  if (summary.git) {
    const git = summary.git
    if (git.mode === 'own') lines.push(`git: initialised a new repository, import commit ${git.initialCommit ?? '(none)'}`)
    else if (git.mode === 'parent') lines.push(`git: reusing the parent repository at ${git.root ?? '(unknown)'}`)
    else lines.push(`git: no repository (${git.reason ?? 'disabled'})`)
  }
  if (summary.warnings.length > 0) lines.push(`warnings: ${summary.warnings.join('; ')}`)
  if (summary.dryRun) lines.push(`(dry run: nothing was written; config git.autoInit=${String(config.git.autoInit)})`)
  return lines.join('\n')
}

export function describeConflicts(summary: ConflictsSummary): string {
  const { conflicts } = summary
  if (conflicts.length === 0) {
    return `No unresolved conflicts in "${summary.projectName}" → ${summary.localRoot}.`
  }
  const lines = [`Unresolved conflicts: ${conflicts.length} in "${summary.projectName}" → ${summary.localRoot}`]
  conflicts.slice(0, 10).forEach((entry, index) => {
    const versions =
      entry.localVersion !== undefined || entry.remoteVersion !== undefined
        ? ` (local v${entry.localVersion ?? '?'}, remote v${entry.remoteVersion ?? '?'})`
        : ''
    lines.push(`${index + 1}. ${entry.path} — ${entry.reason ?? 'both changed'}${versions}, ${entry.createdAt}`)
    if (entry.copyPath) lines.push(`   remote copy: ${entry.copyPath}`)
    lines.push(`   settle: overleaf_resolve path="${entry.path}" choice=keep_local|keep_remote|merge`)
  })
  if (conflicts.length > 10) lines.push(`… (+${conflicts.length - 10} more)`)
  return lines.join('\n')
}

export function describeResolve(summary: ResolveSummary): string {
  const head = summary.dryRun ? 'Dry run: ' : ''
  if (summary.resolved.length === 0) {
    return `${head}No conflict settled (nothing matched).`
  }
  const verb =
    summary.choice === 'keep_remote'
      ? 'kept the Overleaf copy'
      : summary.choice === 'merge'
        ? 'kept both sides'
        : 'kept the local copy'
  const lines = [
    `${head}Settled ${summary.resolved.length} conflict(s) in "${summary.projectName}" (${verb})`,
  ]
  summary.resolved.slice(0, 10).forEach((entry) => {
    const archive = entry.archivedTo ? ` · archived: ${entry.archivedTo}` : ''
    lines.push(`- ${entry.path} (${entry.kind}, remote v${entry.remoteVersion})${archive}`)
  })
  if (summary.resolved.length > 10) lines.push(`… (+${summary.resolved.length - 10} more)`)
  if (summary.choice === 'keep_local' && !summary.dryRun) {
    lines.push('Next: overleaf_push dryRun:false to send the kept local copy (still three-way checked).')
  }
  if (summary.choice === 'keep_remote' && !summary.dryRun) {
    lines.push('The local file now matches Overleaf; nothing to push.')
  }
  if (summary.choice === 'merge' && !summary.dryRun) {
    lines.push('Both versions are on disk — edit the file into what you want, then overleaf_push.')
  }
  return lines.join('\n')
}

export function describeWatch(summary: WatchStatus): string {
  if (!summary.running) {
    const lines = ['Background sync: not running']
    if (summary.projectId && summary.projectName) {
      lines.push(`last state for "${summary.projectName}": stopped`)
    }
    lines.push('start it with overleaf_watch action="start" (holds one socket open while it runs)')
    return lines.join('\n')
  }
  const lines = [
    `Background sync: running — ${summary.sessions.length} project(s), ${summary.openDocs} document(s) open`,
  ]
  for (const session of summary.sessions) {
    lines.push(
      `- ${session.projectName} → ${session.localRoot} · open docs ${session.openDocs}` +
        (session.startedAt ? ` · since ${session.startedAt}` : '') +
        (session.lastError ? ` · last error: ${session.lastError}` : ''),
    )
  }
  if (summary.events.length > 0) {
    lines.push('recent activity:')
    for (const event of summary.events.slice(-5)) {
      lines.push(`- ${event.at} ${event.type}${event.path ? ` ${event.path}` : ''}${event.detail ? ` — ${event.detail}` : ''}`)
    }
  } else {
    lines.push('recent activity: none yet — edit a linked file to see it move')
  }
  return lines.join('\n')
}
