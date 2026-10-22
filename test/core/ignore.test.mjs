import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  BUILTIN_IGNORES,
  createIgnoreMatcher,
  globToRegExp,
  loadIgnoreMatcher,
  parseIgnoreFile,
} from '../../lib/core/ignore.js'

async function tempDir(t, prefix = 'dsh-ol-ignore-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('BUILTIN_IGNORES matches the documented defaults', () => {
  assert.deepEqual(BUILTIN_IGNORES, ['.git/', '.dsh-*/', '*.tmp', '*.swp', '.DS_Store', 'node_modules/'])
})

test('globToRegExp: * stays inside one path segment', () => {
  const re = globToRegExp('*.tmp')
  assert.equal(re.test('a.tmp'), true)
  assert.equal(re.test('dir/a.tmp'), true)
  assert.equal(re.test('a.tmpx'), false)
  assert.equal(re.test('a.tmp.bak'), false)
})

test('globToRegExp: ? matches exactly one character', () => {
  const re = globToRegExp('file?.tex')
  assert.equal(re.test('file1.tex'), true)
  assert.equal(re.test('dir/filea.tex'), true)
  assert.equal(re.test('file10.tex'), false)
})

test('globToRegExp: trailing slash matches a directory and its contents', () => {
  const re = globToRegExp('.dsh-*/')
  assert.equal(re.test('.dsh-bak'), true)
  assert.equal(re.test('.dsh-bak/state.json'), true)
  assert.equal(re.test('sub/.dsh-tmp/x'), true)
  assert.equal(re.test('dsh-bak/x'), false)
})

test('globToRegExp: ** spans directories and can match zero of them', () => {
  const md = globToRegExp('docs/**/*.md')
  assert.equal(md.test('docs/a.md'), true)
  assert.equal(md.test('docs/ch1/a.md'), true)
  assert.equal(md.test('docs/ch1/ch2/a.md'), true)
  assert.equal(md.test('notes/docs/a.md'), false)
  assert.equal(md.test('docs/a.md/extra'), false)

  const build = globToRegExp('**/build/')
  assert.equal(build.test('build/out.js'), true)
  assert.equal(build.test('pkg/build/out.js'), true)
  assert.equal(build.test('src/build'), true)
  assert.equal(build.test('src/buildx'), false)

  const src = globToRegExp('src/**')
  assert.equal(src.test('src/main.ts'), true)
  assert.equal(src.test('src/a/b.ts'), true)
  assert.equal(src.test('src'), false)
  assert.equal(src.test('other/src/main.ts'), false)
})

test('parseIgnoreFile strips comments/blank lines and keeps ! prefixes', () => {
  const text = '\uFEFF# comment\n\n*.log\n!keep.log\nfigures/\n   \n'
  assert.deepEqual(parseIgnoreFile(text), ['*.log', '!keep.log', 'figures/'])
  assert.deepEqual(parseIgnoreFile(''), [])
})

test('createIgnoreMatcher applies later patterns last (negation wins when later)', () => {
  const matcher = createIgnoreMatcher({ patterns: ['*.log', '!keep.log'] })
  assert.equal(matcher('debug.log'), true)
  assert.equal(matcher('logs/keep.log'), false)
  assert.equal(matcher('main.tex'), false)

  const reversed = createIgnoreMatcher({ patterns: ['!keep.log', '*.log'] })
  assert.equal(reversed('keep.log'), true)
})

test('loadIgnoreMatcher combines builtins, .overleaf-syncignore and extras in order', async (t) => {
  const root = await tempDir(t)

  let match = await loadIgnoreMatcher(root)
  assert.equal(match('main.tex'), false)
  assert.equal(match('.git/config'), true)
  assert.equal(match('.dsh-bak/state.json'), true)
  assert.equal(match('main.tex.tmp'), true)
  assert.equal(match('.DS_Store'), true)
  assert.equal(match('node_modules/x/y.js'), true)
  assert.equal(match('sub/node_modules/y.js'), true)

  await fs.writeFile(path.join(root, '.overleaf-syncignore'), '# local rules\n!*.tmp\nbuild/\n', 'utf8')
  match = await loadIgnoreMatcher(root)
  assert.equal(match('foo.tmp'), false)
  assert.equal(match('build/out.js'), true)
  assert.equal(match('sub/build/out.bin'), true)
  assert.equal(match('main.tex'), false)

  match = await loadIgnoreMatcher(root, ['!build/keep.tex', 'draft/**'])
  assert.equal(match('build/keep.tex'), false)
  assert.equal(match('build/other.tex'), true)
  assert.equal(match('draft/a.tex'), true)
  assert.equal(match('x/draft/a.tex'), false)
})
