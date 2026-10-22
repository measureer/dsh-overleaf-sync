import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { ensureGitRepository } from '../../lib/core/gitInit.js'

const execFileAsync = promisify(execFile)

const GITIGNORE_HEADER = '# dsh-overleaf-sync'
const GITIGNORE_ENTRIES = ['*.LOCAL.*', '*.REMOTE.*', '*.merge.*', '.dsh-bak/', '*.sync-conflict.*']
const GITATTRIBUTES_LINE = '* text=auto eol=lf'
const GIT_UNAVAILABLE = 'E_GIT_UNAVAILABLE: git not found in PATH'
const REAL_GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

async function tempDir(t, prefix = 'dsh-ol-git-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function write(pathname, text) {
  await fs.mkdir(path.dirname(pathname), { recursive: true })
  await fs.writeFile(pathname, text, 'utf8')
}

/**
 * Fake git for a fresh-init scenario: `rev-parse --show-toplevel` always fails,
 * everything else succeeds with configurable identity/staging/fallbacks.
 */
function freshGitSpawn(options = {}) {
  const {
    initWithB = true,
    userName,
    userEmail,
    staged = 'main.tex\n.gitignore\n.gitattributes\n',
    sha = 'abc1234',
    failAdd = false,
    failCommit = false,
  } = options
  const calls = []
  const unexpected = []
  const spawn = async (args) => {
    calls.push([...args])
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
    }
    if (args[0] === 'init') {
      if (!initWithB && args.includes('-b')) {
        return { code: 129, stdout: '', stderr: "error: unknown switch `b'" }
      }
      return { code: 0, stdout: 'Initialized empty Git repository', stderr: '' }
    }
    if (args[0] === 'add') {
      return failAdd
        ? { code: 1, stdout: '', stderr: 'fatal: could not add files' }
        : { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--get') {
      const value = args[2] === 'user.name' ? userName : args[2] === 'user.email' ? userEmail : undefined
      return value === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${value}\n`, stderr: '' }
    }
    if (args[0] === 'ls-files') {
      return { code: 0, stdout: staged, stderr: '' }
    }
    if (args[0] === '-c' && args[4] === 'commit') {
      return failCommit
        ? { code: 1, stdout: '', stderr: 'fatal: unable to auto-detect email address' }
        : { code: 0, stdout: '[main abc1234] commit', stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--short') {
      return { code: 0, stdout: `${sha}\n`, stderr: '' }
    }
    unexpected.push([...args])
    return { code: 1, stdout: '', stderr: `unexpected git command: ${args.join(' ')}` }
  }
  return { spawn, calls, unexpected }
}

test('gitInit: disabled does not run git at all', async () => {
  let called = false
  const result = await ensureGitRepository({
    enabled: false,
    localRoot: 'C:/no/such/dir',
    projectName: 'Paper',
    projectId: 'proj-1',
    spawn: async () => {
      called = true
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(result, { mode: 'none', created: false, reason: 'git.autoInit=false' })
  assert.equal(called, false)
})

test('gitInit: existing own repository only tops up .gitignore/.gitattributes', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, '.gitignore'), 'build/\nnode_modules/\n')

  const calls = []
  const spawn = async (args) => {
    calls.push([...args])
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { code: 0, stdout: `${dir}\n`, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected git command: ${args.join(' ')}` }
  }

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-own',
    spawn,
  })

  assert.equal(result.mode, 'own')
  assert.equal(result.created, false)
  assert.equal(result.root, path.resolve(dir))
  assert.equal(calls.length, 1)

  const expected = `build/\nnode_modules/\n\n${GITIGNORE_HEADER}\n${GITIGNORE_ENTRIES.join('\n')}\n`
  assert.equal(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), expected)
  assert.equal(await fs.readFile(path.join(dir, '.gitattributes'), 'utf8'), `${GITATTRIBUTES_LINE}\n`)

  // A second run must be a no-op for the metadata files.
  await ensureGitRepository({ enabled: true, localRoot: dir, projectName: 'Paper', projectId: 'proj-own', spawn })
  assert.equal(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'), expected)
  assert.equal(await fs.readFile(path.join(dir, '.gitattributes'), 'utf8'), `${GITATTRIBUTES_LINE}\n`)
})

test('gitInit: a repository above localRoot is reported as parent, never nested', async (t) => {
  const dir = await tempDir(t)
  const parent = path.dirname(dir)
  const calls = []
  const spawn = async (args) => {
    calls.push([...args])
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { code: 0, stdout: `${parent}\n`, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-parent',
    spawn,
  })

  assert.equal(result.mode, 'parent')
  assert.equal(result.created, false)
  assert.equal(result.root, path.resolve(parent))
  assert.equal(result.warning, undefined)
  assert.equal(calls.length, 1)
  assert.equal(await fs.stat(path.join(dir, '.gitignore')).then(() => true, () => false), false)
})

test('gitInit: rev-parse failure with a stray .git is broken, not reinitialized', async (t) => {
  const dir = await tempDir(t)
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })
  const detail = 'fatal: not a git repository (or any of the parent directories): .git'
  const calls = []
  const spawn = async (args) => {
    calls.push([...args])
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { code: 128, stdout: '', stderr: detail }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-broken',
    spawn,
  })

  assert.equal(result.mode, 'none')
  assert.equal(result.created, false)
  assert.equal(result.warning, `E_GIT_BROKEN: ${detail}`)
  assert.equal(calls.length, 1)
  assert.equal(await fs.stat(path.join(dir, '.git')).then((stat) => stat.isDirectory(), () => false), true)
})

test('gitInit: fresh init stages everything and commits with fallback identity', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), '\\documentclass{article}\n')
  await write(path.join(dir, 'sections', 'intro.tex'), 'Hello\n')
  await write(path.join(dir, 'figure.png'), 'not really a png')

  const now = new Date('2026-10-22T12:00:00.000Z')
  const git = freshGitSpawn({ staged: 'main.tex\nsections/intro.tex\nfigure.png\n.gitignore\n.gitattributes\n' })
  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'My Paper',
    projectId: 'proj-1',
    now,
    spawn: git.spawn,
  })

  assert.deepEqual(git.unexpected, [])
  assert.equal(result.mode, 'own')
  assert.equal(result.created, true)
  assert.equal(result.root, path.resolve(dir))
  assert.equal(result.initialCommit, 'abc1234')
  assert.equal(result.initializedAt, now.toISOString())
  assert.equal(result.committedFiles, 5)

  assert.deepEqual(git.calls[0], ['rev-parse', '--show-toplevel'])
  const init = git.calls.find((args) => args[0] === 'init')
  assert.deepEqual(init, ['init', '-b', 'main'])
  const add = git.calls.find((args) => args[0] === 'add')
  assert.deepEqual(add, ['add', '-A'])
  assert.deepEqual(git.calls.find((args) => args[0] === 'ls-files'), ['ls-files', '--cached'])
  assert.deepEqual(git.calls.find((args) => args[0] === 'rev-parse' && args[1] === '--short'), [
    'rev-parse',
    '--short',
    'HEAD',
  ])

  const commit = git.calls.find((args) => args[0] === '-c')
  assert.deepEqual(commit, [
    '-c',
    'user.name=dsh-overleaf-sync',
    '-c',
    'user.email=noreply@localhost',
    'commit',
    '-m',
    'chore: import "My Paper" from Overleaf (proj-1 @2026-10-22T12:00:00.000Z)',
  ])

  assert.equal(
    await fs.readFile(path.join(dir, '.gitignore'), 'utf8'),
    `${GITIGNORE_HEADER}\n${GITIGNORE_ENTRIES.join('\n')}\n`,
  )
  assert.equal(await fs.readFile(path.join(dir, '.gitattributes'), 'utf8'), `${GITATTRIBUTES_LINE}\n`)
})

test('gitInit: caller-provided commit template gets {project} substituted', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), 'x\n')
  const git = freshGitSpawn()

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'My Paper',
    projectId: 'proj-2',
    initialCommitMessage: 'chore: import {project} snapshot',
    spawn: git.spawn,
  })

  assert.deepEqual(git.unexpected, [])
  assert.equal(result.created, true)
  const commit = git.calls.find((args) => args[0] === '-c')
  assert.equal(commit[commit.length - 1], 'chore: import My Paper snapshot')
})

test('gitInit: existing git identity is reused without touching global config', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), 'x\n')
  const git = freshGitSpawn({ userName: 'Alice', userEmail: 'alice@example.com' })

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-3',
    spawn: git.spawn,
  })

  assert.deepEqual(git.unexpected, [])
  assert.equal(result.created, true)
  const commit = git.calls.find((args) => args[0] === '-c')
  assert.ok(commit.includes('user.name=Alice'))
  assert.ok(commit.includes('user.email=alice@example.com'))
  assert.ok(!git.calls.some((args) => args[0] === 'config' && args[1] !== '--get'))
})

test('gitInit: `init -b` rejection falls back to plain `git init`', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), 'x\n')
  const git = freshGitSpawn({ initWithB: false })

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-4',
    spawn: git.spawn,
  })

  assert.deepEqual(git.unexpected, [])
  assert.equal(result.mode, 'own')
  assert.equal(result.created, true)
  const inits = git.calls.filter((args) => args[0] === 'init')
  assert.deepEqual(inits, [['init', '-b', 'main'], ['init']])
})

test('gitInit: missing git degrades to a warning', async () => {
  const spawn = async () => {
    const err = new Error('spawn git ENOENT')
    err.code = 'ENOENT'
    throw err
  }
  const result = await ensureGitRepository({
    enabled: true,
    localRoot: 'C:/no/such/dir',
    projectName: 'Paper',
    projectId: 'proj-5',
    spawn,
  })
  assert.deepEqual(result, { mode: 'none', created: false, warning: GIT_UNAVAILABLE })
})

test('gitInit: init failure returns E_GIT_INIT_FAILED without throwing', async (t) => {
  const dir = await tempDir(t)
  const detail = 'fatal: cannot create repository'
  const spawn = async (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    }
    if (args[0] === 'init') return { code: 128, stdout: '', stderr: detail }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-6',
    spawn,
  })

  assert.equal(result.mode, 'none')
  assert.equal(result.created, false)
  assert.equal(result.warning, `E_GIT_INIT_FAILED: ${detail}`)
})

test('gitInit: stage/commit failures degrade to warnings', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), 'x\n')

  const addFailure = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-7',
    spawn: freshGitSpawn({ failAdd: true }).spawn,
  })
  assert.equal(addFailure.mode, 'none')
  assert.equal(addFailure.created, false)
  assert.equal(addFailure.warning, 'E_GIT_INIT_FAILED: fatal: could not add files')

  const commitFailure = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-8',
    spawn: freshGitSpawn({ failCommit: true }).spawn,
  })
  assert.equal(commitFailure.mode, 'none')
  assert.equal(commitFailure.created, false)
  assert.equal(commitFailure.warning, 'E_GIT_INIT_FAILED: fatal: unable to auto-detect email address')
})

test('gitInit: large projects only stage text files unless includeBinary is set', async (t) => {
  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), 'x\n')
  const big = path.join(dir, 'big.pdf')
  await fs.writeFile(big, '')
  await fs.truncate(big, 21 * 1024 * 1024)

  const textOnly = freshGitSpawn()
  const first = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-9',
    spawn: textOnly.spawn,
  })
  assert.deepEqual(textOnly.unexpected, [])
  assert.equal(first.created, true)
  assert.deepEqual(textOnly.calls.find((args) => args[0] === 'add'), [
    'add',
    '--',
    '.gitignore',
    '.gitattributes',
    'main.tex',
  ])

  const withBinary = freshGitSpawn()
  const second = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Paper',
    projectId: 'proj-9',
    includeBinary: true,
    spawn: withBinary.spawn,
  })
  assert.deepEqual(withBinary.unexpected, [])
  assert.equal(second.created, true)
  assert.deepEqual(withBinary.calls.find((args) => args[0] === 'add'), ['add', '-A'])
})

test('gitInit: real git creates a clean, committed repository', async (t) => {
  if (!REAL_GIT_AVAILABLE) {
    t.skip('git is not available in PATH')
    return
  }

  const dir = await tempDir(t)
  await write(path.join(dir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n')
  await write(path.join(dir, 'sections', 'intro.tex'), 'Intro\n')

  const result = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Smoke Test',
    projectId: 'proj-real',
  })

  assert.equal(result.mode, 'own')
  assert.equal(result.created, true)
  assert.match(result.initialCommit ?? '', /^[0-9a-f]{7,40}$/)
  assert.ok((result.committedFiles ?? 0) >= 4)
  assert.ok(result.initializedAt)

  const top = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir })
  const normalize = (value) => path.resolve(value.trim()).replace(/[\\/]+$/, '').toLowerCase()
  assert.equal(normalize(top.stdout), normalize(dir))

  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir })
  assert.equal(status.stdout.trim(), '')

  const message = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: dir })
  assert.match(message.stdout, /^chore: import "Smoke Test" from Overleaf \(proj-real @\d{4}-\d{2}-\d{2}T/)

  // Ignore rules written by the plugin are effective.
  await write(path.join(dir, 'main.LOCAL.tex'), 'local copy\n')
  const afterLocal = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir })
  assert.equal(afterLocal.stdout.trim(), '')

  const again = await ensureGitRepository({
    enabled: true,
    localRoot: dir,
    projectName: 'Smoke Test',
    projectId: 'proj-real',
  })
  assert.equal(again.mode, 'own')
  assert.equal(again.created, false)

  const count = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })
  assert.equal(count.stdout.trim(), '1')
})
