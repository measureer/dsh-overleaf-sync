import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { OverleafSyncError } from '../../lib/core/errors.js'
import {
  clearCredential,
  credentialsFile,
  loadCredential,
  normalizeBaseUrl,
  normalizeCookie,
  saveCredential,
} from '../../lib/transport/credentials.js'

let root

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'overleaf-cred-'))
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('normalizeBaseUrl', () => {
  it('normalizes to URL href with a trailing slash', () => {
    assert.equal(normalizeBaseUrl('https://www.overleaf.com'), 'https://www.overleaf.com/')
    assert.equal(normalizeBaseUrl('  https://www.overleaf.com/  '), 'https://www.overleaf.com/')
    assert.equal(normalizeBaseUrl('example.test/overleaf'), 'https://example.test/overleaf/')
    // API bases have no query/hash; the path still gets its trailing slash.
    assert.equal(normalizeBaseUrl('https://example.test/overleaf?x=1#frag'), 'https://example.test/overleaf/')
  })

  it('rejects an empty or unparsable baseUrl', () => {
    for (const bad of ['', '   ', 'http://', 'ftp://example.test', 'https://exa mple.test']) {
      assert.throws(
        () => normalizeBaseUrl(bad),
        (error) => error instanceof OverleafSyncError && error.code === 'E_CONFIG',
      )
    }
  })
})

describe('normalizeCookie', () => {
  it('trims, drops a Cookie: label and joins semicolons', () => {
    assert.equal(normalizeCookie('  a=1;  b=2  '), 'a=1; b=2')
    assert.equal(normalizeCookie('Cookie: overleaf_session2=abc; sharelatex.sid=xyz'), 'overleaf_session2=abc; sharelatex.sid=xyz')
    assert.equal(normalizeCookie('cookie:a=1;b=2'), 'a=1; b=2')
  })

  it('joins multi-line pasted cookies', () => {
    assert.equal(normalizeCookie('a=1\nb=2\n\n'), 'a=1; b=2')
    assert.equal(normalizeCookie('Cookie:\na=1\r\nb=2'), 'a=1; b=2')
  })

  it('returns an empty string for empty input', () => {
    assert.equal(normalizeCookie(''), '')
    assert.equal(normalizeCookie('   \n  '), '')
  })
})

describe('saveCredential / loadCredential / clearCredential', () => {
  it('saves and loads a normalized credential', async () => {
    const saved = await saveCredential(
      {
        baseUrl: 'https://www.overleaf.com',
        cookie: ' Cookie: overleaf_session2=abc; sharelatex.sid=xyz ',
        csrfToken: ' csrf-token ',
        userHint: ' me@example.com ',
      },
      root,
    )

    assert.equal(saved.baseUrl, 'https://www.overleaf.com/')
    assert.equal(saved.cookie, 'overleaf_session2=abc; sharelatex.sid=xyz')
    assert.equal(saved.csrfToken, 'csrf-token')
    assert.equal(saved.userHint, 'me@example.com')
    assert.ok(!Number.isNaN(Date.parse(saved.savedAt)))

    const loaded = await loadCredential(root)
    assert.deepEqual(loaded, saved)

    const file = credentialsFile(root)
    const raw = await readFile(file, 'utf8')
    assert.ok(!raw.startsWith('\uFEFF'))
    assert.deepEqual(JSON.parse(raw), saved)
  })

  it('creates the credential directory when missing', async () => {
    const nested = path.join(root, 'deep', 'nested')
    await saveCredential(
      { baseUrl: 'https://example.test', cookie: 'a=1', csrfToken: 'tok' },
      nested,
    )
    const loaded = await loadCredential(nested)
    assert.equal(loaded?.baseUrl, 'https://example.test/')
  })

  it('writes owner-only permissions where POSIX modes exist', async () => {
    await saveCredential(
      { baseUrl: 'https://www.overleaf.com', cookie: 'a=1', csrfToken: 'tok' },
      root,
    )
    const fileStat = await stat(credentialsFile(root))
    if (process.platform !== 'win32') {
      assert.equal(fileStat.mode & 0o777, 0o600)
    }
  })

  it('returns undefined for a missing file', async () => {
    assert.equal(await loadCredential(root), undefined)
  })

  it('returns undefined for corrupt JSON and incomplete objects', async () => {
    const file = credentialsFile(root)
    await writeFile(file, '{not json', 'utf8')
    assert.equal(await loadCredential(root), undefined)

    await writeFile(file, JSON.stringify({ baseUrl: 'https://www.overleaf.com', cookie: 'a=1' }), 'utf8')
    assert.equal(await loadCredential(root), undefined)

    await writeFile(file, JSON.stringify(null), 'utf8')
    assert.equal(await loadCredential(root), undefined)

    await writeFile(file, JSON.stringify([]), 'utf8')
    assert.equal(await loadCredential(root), undefined)
  })

  it('clears the credential and is idempotent', async () => {
    await saveCredential(
      { baseUrl: 'https://www.overleaf.com', cookie: 'a=1', csrfToken: 'tok' },
      root,
    )
    await clearCredential(root)
    assert.equal(await loadCredential(root), undefined)
    await clearCredential(root)
  })

  it('rejects empty cookie or CSRF token', async () => {
    await assert.rejects(
      saveCredential({ baseUrl: 'https://www.overleaf.com', cookie: '', csrfToken: 'tok' }, root),
      (error) => error instanceof OverleafSyncError && error.code === 'E_CONFIG',
    )
    await assert.rejects(
      saveCredential({ baseUrl: 'https://www.overleaf.com', cookie: 'a=1', csrfToken: '  ' }, root),
      (error) => error instanceof OverleafSyncError && error.code === 'E_CONFIG',
    )
  })
})
