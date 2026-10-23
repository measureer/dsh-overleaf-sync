/**
 * Path ignore rules (`state.json` never contains these, they only decide what
 * the sync engine touches). Semantics deliberately mirror `.gitignore` —
 * comments, negation, `*` / `?` / `**`, trailing slash = directory — because
 * `.overleaf-syncignore` is the file users already know from the reference
 * implementation (design §6.6).
 *
 * Directory patterns match the directory itself *and* everything below it,
 * since the matcher is normally called with file paths only.
 */

import path from 'node:path'

import { readTextIfExists } from './fsUtil.js'

/** Ignore rules that always apply, before the project file and `exclude`. */
export const BUILTIN_IGNORES: string[] = [
  '.git/',
  // Git metadata this plugin creates itself (`git init` in §5.8). It belongs to
  // the local repository, never to the Overleaf project, so it must not show up
  // as "pending push" or be uploaded.
  '.gitattributes',
  '.gitignore',
  '.dsh-*/',
  '*.tmp',
  '*.swp',
  '.DS_Store',
  'node_modules/',
]

export const IGNORE_FILE_NAME = '.overleaf-syncignore'

/**
 * Translate one glob into a RegExp matching a POSIX relative path.
 *
 * A pattern without `/` matches at any depth (`*.tmp`); a pattern containing
 * `/` is anchored to the project root; a trailing slash makes it match a
 * directory and all of its descendants. A leading `!` is ignored here — the
 * matcher owns negation.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim()
  if (glob.startsWith('!')) glob = glob.slice(1)
  if (glob.startsWith('/')) glob = glob.slice(1)

  const directoryOnly = glob.endsWith('/')
  glob = glob.replace(/\/+$/, '')
  if (glob === '') return /(?!)/

  const anchored = pattern.trim().startsWith('/') || glob.includes('/')
  let source = ''
  let index = 0
  while (index < glob.length) {
    const char = glob.charAt(index)
    if (char === '*') {
      if (glob.charAt(index + 1) === '*') {
        if (glob.charAt(index + 2) === '/') {
          // `**/` = zero or more complete directory segments.
          source += '(?:[^/]+/)*'
          index += 3
          continue
        }
        source += '.*'
        index += 2
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    source += escapeRegExp(char)
    index += 1
  }

  const prefix = anchored ? '^' : '(?:^|/)'
  const suffix = directoryOnly ? '(?:/.*)?$' : '$'
  return new RegExp(`${prefix}${source}${suffix}`)
}

/** Parse `.overleaf-syncignore`: drop comments/blank lines, keep `!` prefixes. */
export function parseIgnoreFile(text: string): string[] {
  const patterns: string[] = []
  for (const rawLine of text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    patterns.push(line)
  }
  return patterns
}

interface CompiledPattern {
  negated: boolean
  regex: RegExp
}

/**
 * Build the predicate used by the sync engine. Later patterns win, so a `!`
 * rule overrides an earlier ignore rule — including a builtin one.
 */
export function createIgnoreMatcher(options: { patterns: string[] }): (relPosix: string) => boolean {
  const compiled: CompiledPattern[] = []
  for (const raw of options.patterns) {
    const pattern = raw.trim()
    if (pattern === '' || pattern.startsWith('#')) continue
    const negated = pattern.startsWith('!')
    compiled.push({
      negated,
      regex: globToRegExp(negated ? pattern.slice(1) : pattern),
    })
  }

  return (relPosix: string): boolean => {
    const rel = relPosix.replace(/\\/g, '/').replace(/^\.\//, '')
    if (rel === '') return false
    let ignored = false
    for (const rule of compiled) {
      if (rule.regex.test(rel)) ignored = !rule.negated
    }
    return ignored
  }
}

/**
 * `BUILTIN_IGNORES` → project `.overleaf-syncignore` (if present) → `extra`.
 * Order is priority order: the project file and the link's `exclude` list can
 * both re-include something a builtin rule ignores.
 */
export async function loadIgnoreMatcher(
  localRoot: string,
  extra?: string[],
): Promise<(relPosix: string) => boolean> {
  const patterns = [...BUILTIN_IGNORES]
  const text = await readTextIfExists(path.join(localRoot, IGNORE_FILE_NAME))
  if (text !== undefined) patterns.push(...parseIgnoreFile(text))
  if (extra !== undefined) patterns.push(...extra)
  return createIgnoreMatcher({ patterns })
}

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
