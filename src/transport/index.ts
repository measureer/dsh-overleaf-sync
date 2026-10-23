import type { Credential, OverleafTransport, TransportFactory } from '../types.js'
import { OverleafSyncError } from '../core/errors.js'
import { detectSocketProtocol } from './legacy.js'
import { LegacyTransport } from './legacyTransport.js'
import { OverleafSocket } from './socket.js'

/**
 * Overall budget for a legacy connect. The 0.9 client retries a refused
 * upgrade on the same session, so this is the last line of defence against a
 * server that silently accepts the handshake and then never upgrades.
 */
const LEGACY_CONNECT_BUDGET_MS = 90_000

/**
 * Transport factory used by the service layer. Resolves only after the socket
 * has joined the project, so callers immediately get a usable transport.
 *
 * Overleaf deployments come in two socket.io generations and they are not wire
 * compatible (see `docs/design.md` §12.1). Probe once, then pick the matching
 * implementation: `OverleafSocket` for Engine.IO 4 (`overleaf.com`), and
 * `LegacyTransport` for Socket.IO 0.9 (older self-hosted builds). The probe
 * falls back to `v4`, so the official path keeps its behaviour.
 */
export const createTransport: TransportFactory = async (
  credential: Credential,
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<OverleafTransport> => {
  const protocol = await detectSocketProtocol(credential.baseUrl, {
    ...(credential.cookie ? { cookie: credential.cookie } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  })
  if (protocol === 'legacy') {
    return await withBudget(
      LegacyTransport.connect(credential, projectId, options ?? {}),
      LEGACY_CONNECT_BUDGET_MS,
      options?.signal,
    )
  }
  return OverleafSocket.connect(credential, projectId, options)
}

/**
 * Reject if `task` has not settled within `budgetMs`. The socket client owns
 * its own timers; this only guarantees the caller is never stuck forever.
 */
async function withBudget<T>(
  task: Promise<T>,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new OverleafSyncError('E_TIMEOUT', 'the Overleaf request was cancelled', 'retry the operation')
  }
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new OverleafSyncError(
              'E_TIMEOUT',
              `could not join the Overleaf project within ${Math.round(budgetMs / 1000)} s`,
              'a self-hosted Overleaf instance that keeps refusing the socket upgrade usually has another editor session for the same account and project — close the project in your browser, then retry',
            ),
          )
        }, budgetMs)
        timer.unref()
        if (signal) {
          onAbort = () =>
            reject(
              new OverleafSyncError('E_TIMEOUT', 'the Overleaf request was cancelled', 'retry the operation'),
            )
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export { OverleafHttp } from './http.js'
export { OverleafSocket, socketEndpoint } from './socket.js'
export { LegacyOverleafSocket, detectSocketProtocol } from './legacy.js'
export { LegacyTransport } from './legacyTransport.js'
export type { LegacySocketOptions, LegacyJoinProjectResult, SocketProtocol } from './legacy.js'
export type { SocketEndpoint } from './socket.js'
export * from './credentials.js'
export * from './packed.js'
