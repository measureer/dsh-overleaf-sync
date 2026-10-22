import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'

import { OverleafSyncError } from '../../lib/core/errors.js'
import { OverleafHttp } from '../../lib/transport/http.js'

const COOKIE = 'overleaf_session2=good; sharelatex.sid=ok'
const CSRF = 'csrf-token-123'

function makeCredential(baseUrl, cookie = COOKIE) {
  return { baseUrl, cookie, csrfToken: CSRF, savedAt: new Date().toISOString() }
}

function isOverleafError(code) {
  return (error) => error instanceof OverleafSyncError && error.code === code
}

function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'text/plain' })
  res.end('Unauthorized')
}

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  try {
    return await run(origin)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const PROJECTS_JSON = JSON.stringify({
  projects: [
    { _id: 'proj-1', name: 'Thesis', lastUpdated: '2026-01-02T03:04:05.000Z', archived: false },
    { _id: 'proj-2', name: 'Slides' },
  ],
})

function mainHandler(req, res) {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
  const authorized = req.headers.cookie === COOKIE

  switch (pathname) {
    case '/user/projects':
      if (!authorized) return unauthorized(res)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(PROJECTS_JSON)
      return
    case '/project':
      if (!authorized) return unauthorized(res)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head>' +
          '<meta name="ol-user_id" content="user-1">' +
          '<meta name="ol-usersEmail" content="me@example.com">' +
          `<meta name="ol-csrfToken" content="${CSRF}">` +
          '</head><body>project</body></html>',
      )
      return
    case '/project/proj-1/file/file-1':
      if (!authorized) return unauthorized(res)
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff]))
      return
    default:
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
  }
}

describe('OverleafHttp.listProjects', () => {
  it('normalizes _id to id and keeps optional fields', async () => {
    await withServer(mainHandler, async (origin) => {
      const client = new OverleafHttp(makeCredential(origin))
      const projects = await client.listProjects()

      assert.equal(projects.length, 2)
      assert.deepEqual(projects[0], {
        id: 'proj-1',
        name: 'Thesis',
        lastUpdated: '2026-01-02T03:04:05.000Z',
        archived: false,
      })
      assert.deepEqual(projects[1], { id: 'proj-2', name: 'Slides' })
    })
  })

  it('sends the cookie header', async () => {
    await withServer(mainHandler, async (origin) => {
      // mainHandler answers 401 unless the exact cookie arrives.
      const projects = await new OverleafHttp(makeCredential(origin)).listProjects()
      assert.equal(projects.length, 2)
    })
  })

  it('maps 401 to E_AUTH_EXPIRED', async () => {
    await withServer(mainHandler, async (origin) => {
      const client = new OverleafHttp(makeCredential(origin, 'overleaf_session2=stale'))
      await assert.rejects(client.listProjects(), isOverleafError('E_AUTH_EXPIRED'))
      await assert.rejects(
        client.listProjects(),
        (error) => /overleaf_login/.test(error.hint ?? ''),
      )
    })
  })

  it('maps connection failures to E_TRANSPORT', async () => {
    const server = http.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))

    const client = new OverleafHttp(makeCredential(`http://127.0.0.1:${port}`))
    await assert.rejects(client.listProjects(), isOverleafError('E_TRANSPORT'))
  })

  it('maps invalid JSON to E_TRANSPORT', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('<html>not json</html>')
      },
      async (origin) => {
        const client = new OverleafHttp(makeCredential(origin))
        await assert.rejects(client.listProjects(), isOverleafError('E_TRANSPORT'))
      },
    )
  })

  it('maps a non-array projects payload to E_TRANSPORT', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ projects: 'nope' }))
      },
      async (origin) => {
        const client = new OverleafHttp(makeCredential(origin))
        await assert.rejects(client.listProjects(), isOverleafError('E_TRANSPORT'))
      },
    )
  })

  it('maps a pre-aborted signal to E_TRANSPORT (cancelled)', async () => {
    await withServer(mainHandler, async (origin) => {
      const client = new OverleafHttp(makeCredential(origin))
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(client.listProjects(controller.signal), isOverleafError('E_TRANSPORT'))
    })
  })
})

describe('OverleafHttp.whoami', () => {
  it('reads the csrf token and login email from the project page', async () => {
    await withServer(mainHandler, async (origin) => {
      const result = await new OverleafHttp(makeCredential(origin)).whoami()
      assert.deepEqual(result, { ok: true, email: 'me@example.com', hint: 'me@example.com' })
    })
  })

  it('decodes HTML entities and single-quoted meta attributes', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(
          "<html><head><meta name='ol-usersEmail' content='a&amp;b&#64;example.com'>" +
            '<meta name="ol-csrfToken" content="tok"></head></html>',
        )
      },
      async (origin) => {
        const result = await new OverleafHttp(makeCredential(origin)).whoami()
        assert.equal(result.ok, true)
        assert.equal(result.email, 'a&b@example.com')
      },
    )
  })

  it('maps 401 to E_AUTH_EXPIRED', async () => {
    await withServer(mainHandler, async (origin) => {
      const client = new OverleafHttp(makeCredential(origin, 'nope=1'))
      await assert.rejects(client.whoami(), isOverleafError('E_AUTH_EXPIRED'))
    })
  })

  it('reports a redirect to the login page as not ok', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { location: '/login?redirect=%2Fproject' })
        res.end()
      },
      async (origin) => {
        const result = await new OverleafHttp(makeCredential(origin)).whoami()
        assert.equal(result.ok, false)
        assert.match(result.hint ?? '', /login/i)
      },
    )
  })

  it('reports a page without the login meta tags as not ok', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body>anonymous</body></html>')
      },
      async (origin) => {
        const result = await new OverleafHttp(makeCredential(origin)).whoami()
        assert.equal(result.ok, false)
        assert.ok(result.hint)
      },
    )
  })
})

describe('OverleafHttp.downloadFile', () => {
  it('returns the raw file bytes', async () => {
    await withServer(mainHandler, async (origin) => {
      const bytes = await new OverleafHttp(makeCredential(origin)).downloadFile('proj-1', 'file-1')
      assert.deepEqual([...bytes], [0x25, 0x50, 0x44, 0x46, 0x2d, 0xff])
    })
  })

  it('maps 404 to E_PROJECT_NOT_FOUND', async () => {
    await withServer(mainHandler, async (origin) => {
      const client = new OverleafHttp(makeCredential(origin))
      await assert.rejects(client.downloadFile('proj-1', 'missing'), isOverleafError('E_PROJECT_NOT_FOUND'))
    })
  })

  it('maps 500 to E_TRANSPORT', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('boom')
      },
      async (origin) => {
        const client = new OverleafHttp(makeCredential(origin))
        await assert.rejects(client.downloadFile('proj-1', 'file-1'), isOverleafError('E_TRANSPORT'))
      },
    )
  })

  it('maps 403 to E_AUTH_EXPIRED', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
      },
      async (origin) => {
        const client = new OverleafHttp(makeCredential(origin))
        await assert.rejects(client.downloadFile('proj-1', 'file-1'), isOverleafError('E_AUTH_EXPIRED'))
      },
    )
  })
})

describe('OverleafHttp constructor', () => {
  it('requires a cookie and csrf token', () => {
    assert.throws(
      () => new OverleafHttp({ ...makeCredential('https://www.overleaf.com'), cookie: '' }),
      isOverleafError('E_CONFIG'),
    )
    assert.throws(
      () => new OverleafHttp({ ...makeCredential('https://www.overleaf.com'), csrfToken: '' }),
      isOverleafError('E_CONFIG'),
    )
  })
})
