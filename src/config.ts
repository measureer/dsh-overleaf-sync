import z from '@deepseek-ai/schemastery'
import type { ConflictStrategy } from './types.js'

const strategy = z
  .union([z.const('keep-both'), z.const('keep-local'), z.const('keep-remote'), z.const('auto')])
  .default('keep-both')

export const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://www.overleaf.com')
    .description('Overleaf instance root. Change it for a self-hosted or university server.'),

  localRootPattern: z
    .string()
    .default('~/Overleaf/{project}')
    .description(
      'Where a pulled project lands. `{project}` is the project name, `{date}` is YYYY-MM-DD; ' +
        'relative values resolve against the session working directory.',
    ),

  defaultStrategy: strategy.description(
    'Conflict policy when both sides changed: keep-both (default) writes a `.remote-<ts>` copy, ' +
      'keep-local / keep-remote pick a winner, auto lets the sync engine decide per file.',
  ),

  watch: z
    .object({
      autoStart: z
        .boolean()
        .default(false)
        .description('Start the background watcher as soon as the plugin loads (off by default).'),
      idleLeaveDocMs: z
        .natural()
        .default(60000)
        .description('Leave a document after this much inactivity to keep socket traffic low.'),
      maxOpenDocs: z.natural().default(20).description('Upper bound of simultaneously joined documents.'),
    })
    .default({ autoStart: false, idleLeaveDocMs: 60000, maxOpenDocs: 20 })
    .description('Background (watch) mode settings.'),

  git: z
    .object({
      autoInit: z
        .boolean()
        .default(true)
        .description('Create a git repository after the first successful full pull. Never nests inside a parent repo.'),
      autoCommit: z
        .boolean()
        .default(false)
        .description('Commit after every sync (off by default so agent edits do not flood your history).'),
      initialCommitMessage: z
        .string()
        .default('chore: import "{project}" from Overleaf')
        .description('Message of the import commit; `{project}` is replaced with the project name.'),
      includeBinaryInFirstCommit: z
        .boolean()
        .default(false)
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
      enabled: z.boolean().default(true).description('Append sync events to `journal.ndjson`.'),
      keepDays: z.natural().default(7).description('Rotate the journal after this many days.'),
    })
    .default({ enabled: true, keepDays: 7 }),

  confirmRemoteWrite: z
    .boolean()
    .default(true)
    .description(
      'Tools that write to Overleaf require `yes: true` unless this is false. ' +
        'Keep it on so the agent cannot overwrite a chapter someone else is editing.',
    ),

  debug: z.boolean().default(false).description('Log socket traffic and OT ops (credentials are redacted).'),
})

export type Config = Schemastery.TypeT<typeof ConfigSchema>

/** Resolved config with every default applied. */
export function resolveConfig(input: unknown): Config {
  return ConfigSchema(input as any) as Config
}

export function defaultStrategyOf(config: Config): ConflictStrategy {
  return config.defaultStrategy
}
