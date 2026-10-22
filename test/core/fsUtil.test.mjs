import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  atomicWrite,
  ensureDir,
  listFilesRecursive,
  normalizeEol,
  pathExists,
  readTextIfExists,
  sha256,
} from '../../lib/core/fsUtil.js'

async function tempDir(t, prefix = 'dsh-ol-fs-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function writeFile(file, text) {
  await ensureDir(path.dirname(file))
  await fs.writeFile(file, text, 'utf8')
}

test('sha256 hashes UTF-8 text with the sha256: prefix', () => {
  assert.equal(sha256(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.match(sha256('中文内容'), /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(sha256('a'), sha256('a '))
  assert.notEqual(sha256('a\r\nb'), sha256(normalizeEol('a\r\nb')))
})

test('pathExists and readTextIfExists treat a missing file as absent', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'nested', 'a.txt')

  assert.equal(await pathExists(file), false)
  assert.equal(await readTextIfExists(file), undefined)

  await writeFile(file, 'hello')
  assert.equal(await pathExists(file), true)
  assert.equal(await readTextIfExists(file), 'hello')

  assert.equal(await pathExists(dir), true)
})

test('atomicWrite creates parents, overwrites atomically and leaves no temp file', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'deep', 'nested', 'doc.tex')

  await atomicWrite(file, 'first\n')
  assert.equal(await fs.readFile(file, 'utf8'), 'first\n')

  await atomicWrite(file, '第二版\r\nline')
  assert.equal(await fs.readFile(file, 'utf8'), '第二版\r\nline')

  assert.deepEqual(await fs.readdir(path.dirname(file)), ['doc.tex'])
})

test('normalizeEol only rewrites CRLF', () => {
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(normalizeEol('a\nb'), 'a\nb')
  assert.equal(normalizeEol('a\rb'), 'a\rb')
  assert.equal(normalizeEol(''), '')
})

test('listFilesRecursive returns sorted POSIX paths and skips .git/node_modules', async (t) => {
  const root = await tempDir(t)
  await writeFile(path.join(root, 'a.tex'), 'a')
  await writeFile(path.join(root, '.hidden'), 'h')
  await writeFile(path.join(root, 'sub', 'b.bib'), 'b')
  await writeFile(path.join(root, 'sub', 'deep', 'c.txt'), 'c')
  await writeFile(path.join(root, '.git', 'config'), 'git')
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'js')
  await writeFile(path.join(root, 'sub', 'node_modules', 'x.js'), 'js')

  const files = await listFilesRecursive(root)
  assert.deepEqual(files, ['.hidden', 'a.tex', 'sub/b.bib', 'sub/deep/c.txt'])
  assert.ok(files.every((rel) => !rel.includes('\\')))

  const texOnly = await listFilesRecursive(root, (rel) => rel.endsWith('.tex'))
  assert.deepEqual(texOnly, ['a.tex'])

  assert.deepEqual(await listFilesRecursive(path.join(root, 'does-not-exist')), [])
})
