/**
 * `pull`/`push` share one project at a time: a second concurrent call must get
 * `E_BUSY` instead of interleaving writes into the same state store.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-busy-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { OverleafSyncService } = await import('../../lib/service.js')
const { resolveConfig } = await import('../../lib/config.js')
const { saveCredential } = await import('../../lib/transport/credentials.js')

const SNAPSHOT = { id: 'p1', name: 'Demo', folders: [], docs: [], files: [] }

/** Transport whose `joinProject` blocks until the test releases it. */
function gatedTransport() {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  return {
    release: () => release(),
    async joinProject() {
      await gate
      return structuredClone(SNAPSHOT)
    },
    async joinDoc(docId) {
      return { docId, version: 1, text: '' }
    },
    async leaveDoc() {},
    async applyOtUpdate() {},
    async close() {},
  }
}

test('a second concurrent pull for the same project is refused with E_BUSY', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-busy-proj-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })
  await saveCredential({
    baseUrl: 'https://www.overleaf.com/',
    cookie: 'overleaf_session2=x',
    csrfToken: 'csrf',
  })

  const transport = gatedTransport()
  const service = new OverleafSyncService(resolveConfig({}), {
    createTransport: async () => transport,
  })

  // Link without touching the network: the link record is what pull reads.
  const { linkPath, statePath } = await import('../../lib/core/paths.js')
  await fs.mkdir(path.dirname(linkPath('p1')), { recursive: true })
  await fs.writeFile(
    linkPath('p1'),
    JSON.stringify({ projectId: 'p1', projectName: 'Demo', localRoot: root, linkedAt: new Date().toISOString() }),
  )
  await fs.writeFile(
    statePath('p1'),
    JSON.stringify({ projectId: 'p1', localRoot: root, files: {}, updatedAt: new Date().toISOString() }),
  )

  const first = service.pull({ projectId: 'p1' }, { cwd: root })
  await new Promise((resolve) => setTimeout(resolve, 30))

  await assert.rejects(() => service.pull({ projectId: 'p1' }, { cwd: root }), (err) => {
    assert.equal(err.code, 'E_BUSY')
    return true
  })

  transport.release()
  const summary = await first
  assert.equal(summary.projectId, 'p1')
})
