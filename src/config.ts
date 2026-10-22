import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

import type { ConflictStrategy } from './types.js'

const strategy = z
  .union([z.const('keep-both'), z.const('keep-local'), z.const('keep-remote'), z.const('auto')])
  .default('keep-both')

/**
 * Fields a form may edit must be declared `.volatile()`: the Settings service
 * only projects volatile fields, and a volatile value is a stable reference the
 * Loader can swap without re-instantiating the plugin.
 */
export const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://www.overleaf.com')
    .volatile()
    .description('Overleaf instance root. Change it for a self-hosted or university server.'),

  localRootPattern: z
    .string()
    .default('~/Overleaf/{project}')
    .volatile()
    .description(
      'Where a pulled project lands. `{project}` is the project name, `{date}` is YYYY-MM-DD; ' +
        'relative values resolve against the session working directory.',
    ),

  defaultStrategy: strategy.description(
    'Conflict policy when both sides changed: keep-both (default) writes a `.remote-<ts>` copy, ' +
      'keep-local / keep-remote pick a winner, auto lets the sync engine decide per file.',
  ).volatile(),

  watch: z
    .object({
      autoStart: z
        .boolean()
        .default(false)
        .volatile()
        .description('Start the background watcher as soon as the plugin loads (off by default).'),
      idleLeaveDocMs: z
        .natural()
        .default(60000)
        .volatile()
        .description('Leave a document after this much inactivity to keep socket traffic low.'),
      maxOpenDocs: z
        .natural()
        .default(20)
        .volatile()
        .description('Upper bound of simultaneously joined documents.'),
    })
    .default({ autoStart: false, idleLeaveDocMs: 60000, maxOpenDocs: 20 })
    .description('Background (watch) mode settings.'),

  git: z
    .object({
      autoInit: z
        .boolean()
        .default(true)
        .volatile()
        .description('Create a git repository after the first successful full pull. Never nests inside a parent repo.'),
      autoCommit: z
        .boolean()
        .default(false)
        .volatile()
        .description('Commit after every sync (off by default so agent edits do not flood your history).'),
      initialCommitMessage: z
        .string()
        .default('chore: import "{project}" from Overleaf')
        .volatile()
        .description('Message of the import commit; `{project}` is replaced with the project name.'),
      includeBinaryInFirstCommit: z
        .boolean()
        .default(false)
        .volatile()
        .description('Also add images/PDFs to the import commit (large projects stay text-only otherwise).'),
    })
    .default({
      autoInit: true,
      autoCommit: false,
      initialCommitMessage: 'chore: import "{project}" from Overleaf',
      includeBinaryInFirstCommit: false,
    })
    .description('Local git repository convenience (never used as the sync channel).'),

  journal: z
    .object({
      enabled: z.boolean().default(true).volatile().description('Append sync events to `journal.ndjson`.'),
      keepDays: z.natural().default(7).volatile().description('Rotate the journal after this many days.'),
    })
    .default({ enabled: true, keepDays: 7 }),

  confirmRemoteWrite: z
    .boolean()
    .default(true)
    .volatile()
    .description(
      'Tools that write to Overleaf require `yes: true` unless this is false. ' +
        'Keep it on so the agent cannot overwrite a chapter someone else is editing.',
    ),

  debug: z.boolean().default(false).volatile().description('Log socket traffic and OT ops (credentials are redacted).'),
})

/** Resolved config: every default applied, every volatile reference unwrapped. */
export interface Config {
  baseUrl: string
  localRootPattern: string
  defaultStrategy: ConflictStrategy
  watch: { autoStart: boolean; idleLeaveDocMs: number; maxOpenDocs: number }
  git: { autoInit: boolean; autoCommit: boolean; initialCommitMessage: string; includeBinaryInFirstCommit: boolean }
  journal: { enabled: boolean; keepDays: number }
  confirmRemoteWrite: boolean
  debug: boolean
}

/** Recursively unwrap `.volatile()` references into plain values. */
function unwrapVolatile(value: unknown): unknown {
  if (isVolatile(value)) return unwrapVolatile((value as { get(): unknown }).get())
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = unwrapVolatile(entry)
    return out
  }
  return value
}

/** Resolved config with every default applied. Idempotent: schema output is accepted too. */
export function resolveConfig(input: unknown): Config {
  return unwrapVolatile(ConfigSchema(unwrapVolatile(input) as never)) as Config
}

/** Schema defaults as plain values; the settings page shows them as placeholders. */
export const DEFAULTS: Config = resolveConfig({})

/**
 * Live view over a parsed config: every read unwraps the current value of the
 * volatile reference behind it.
 *
 * The Loader keeps volatile references stable and swaps their values in place
 * when Settings writes a patch, so a snapshot taken in `apply()` would go stale
 * after the first save. A proxy read keeps the service current without a
 * remount.
 */
export function liveConfig(input: unknown): Config {
  // The Loader hands `apply()` an already-parsed config whose volatile fields
  // are the live references. Re-parsing would mint fresh references that the
  // Loader never updates, so only parse a plain (unparsed) input.
  const parsed = containsVolatile(input) ? input : ConfigSchema(unwrapVolatile(input) as never)
  return proxyObject(parsed) as Config
}

function containsVolatile(value: unknown): boolean {
  if (isVolatile(value)) return true
  if (value === null || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some(containsVolatile)
}

function proxyObject(source: unknown): unknown {
  if (isVolatile(source)) return unwrapVolatile(source)
  if (source === null || typeof source !== 'object') return source
  const target = source as Record<string, unknown>
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(target, {
    get(object, key) {
      const raw = Reflect.get(object, key)
      if (isVolatile(raw)) {
        // Never cache a volatile read: the Loader swaps the value in place, so a
        // cached scalar would go stale after a Settings write.
        return unwrapVolatile(raw)
      }
      if (raw !== null && typeof raw === 'object') {
        if (!cache.has(key)) cache.set(key, proxyObject(raw))
        return cache.get(key)
      }
      return raw
    },
  })
}

export function defaultStrategyOf(config: Config): ConflictStrategy {
  return config.defaultStrategy
}

// ---------------------------------------------------------------------------
// Form projection
// ---------------------------------------------------------------------------

export type EditableFieldType = 'string' | 'boolean' | 'number' | 'enum'

/** One editable field as the GUI sees it. Order here is the form order. */
export interface EditableField {
  /** Dotted path inside the config object, e.g. `git.autoInit`. */
  key: string
  type: EditableFieldType
  group: 'strategy' | 'advanced'
  description: string
  /** UI label. The client falls back to its own locale dictionary by `key`. */
  label?: string
  options?: string[]
  min?: number
  max?: number
}

/** The fields the settings page may edit — exactly the volatile ones above. */
export const EDITABLE_FIELDS: readonly EditableField[] = [
  {
    key: 'defaultStrategy',
    label: '冲突策略',
    type: 'enum',
    group: 'strategy',
    options: ['keep-both', 'keep-local', 'keep-remote', 'auto'],
    description: 'Conflict policy when both sides changed.',
  },
  {
    key: 'confirmRemoteWrite',
    label: '写入远端前确认',
    type: 'boolean',
    group: 'strategy',
    description: 'Require an explicit confirmation before writing to Overleaf.',
  },
  {
    key: 'git.autoInit',
    label: '首次拉取后自动 git init',
    type: 'boolean',
    group: 'strategy',
    description: 'Create a git repository after the first successful pull.',
  },
  { key: 'baseUrl', label: 'Overleaf 站点', type: 'string', group: 'advanced', description: 'Overleaf instance root.' },
  { key: 'localRootPattern', label: '默认拉取目录', type: 'string', group: 'advanced', description: 'Default pull directory pattern.' },
  { key: 'git.autoCommit', label: '每次同步后提交', type: 'boolean', group: 'advanced', description: 'Commit after every sync.' },
  {
    key: 'git.initialCommitMessage',
    label: '导入提交信息',
    type: 'string',
    group: 'advanced',
    description: 'Message of the import commit.',
  },
  {
    key: 'git.includeBinaryInFirstCommit',
    label: '导入提交包含二进制',
    type: 'boolean',
    group: 'advanced',
    description: 'Include images and PDFs in the import commit.',
  },
  { key: 'watch.autoStart', label: '加载时启动 watch', type: 'boolean', group: 'advanced', description: 'Start the watcher at load time.' },
  {
    key: 'watch.idleLeaveDocMs',
    label: '空闲离开文档（毫秒）',
    type: 'number',
    group: 'advanced',
    description: 'Leave an idle document after this.',
    min: 1000,
  },
  {
    key: 'watch.maxOpenDocs',
    label: '最大同时打开文档数',
    type: 'number',
    group: 'advanced',
    description: 'Maximum simultaneously joined docs.',
    min: 1,
    max: 200,
  },
  { key: 'journal.enabled', label: '启用同步流水', type: 'boolean', group: 'advanced', description: 'Append events to the journal.' },
  {
    key: 'journal.keepDays',
    label: '流水保留天数',
    type: 'number',
    group: 'advanced',
    description: 'Journal retention in days.',
    min: 1,
    max: 365,
  },
  { key: 'debug', label: '调试日志', type: 'boolean', group: 'advanced', description: 'Log socket traffic and OT ops.' },
]

/** Read one dotted path out of a config-like object. */
export function readField(config: unknown, key: string): unknown {
  let current: unknown = config
  for (const segment of key.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Turn a flat `{ 'git.autoInit': true }` patch into the nested shape Settings expects. */
export function nestPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const segments = key.split('.')
    let cursor = out
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment]
      if (next === undefined || typeof next !== 'object' || next === null) cursor[segment] = {}
      cursor = cursor[segment] as Record<string, unknown>
    }
    cursor[segments[segments.length - 1]!] = value
  }
  return out
}
