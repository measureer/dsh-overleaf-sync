import type { Credential, OverleafTransport, TransportFactory } from '../types.js'
import { OverleafSyncError } from '../core/errors.js'
import { detectSocketProtocol } from './legacy.js'
import { LegacyTransport } from './legacyTransport.js'
import { OverleafSocket } from './socket.js'

/**
 * Hard budget for a legacy connect. The 0.9 stack retries a refused upgrade on
 * the same session, and a server that is holding another editor session for the
 * same account can keep us waiting indefinitely, so the caller must never hang.
 */
const LEGACY_CONNECT_BUDGET_MS = 45_000

const LEGACY_HINT =
  'a self-hosted Overleaf instance that refuses the socket upgrade usually has another editor session for the same account and project — close the project in your browser, then retry'

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
    return await connectLegacy(credential, projectId, options)
  }
  return OverleafSocket.connect(credential, projectId, options)
}

/** `LegacyTransport.connect` with a hard deadline and an actionable timeout. */
async function connectLegacy(
  credential: Credential,
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<OverleafTransport> {
  const controller = new AbortController()
  const outer = options?.signal
  const onOuterAbort = (): void => controller.abort()
  if (outer?.aborted === true) controller.abort()
  outer?.addEventListener('abort', onOuterAbort, { once: true })

  const timer: NodeJS.Timeout = setTimeout(() => controller.abort(), LEGACY_CONNECT_BUDGET_MS)
  const deadline = new Promise<never>((_, reject) => {
    const onAbort = (): void =>
      reject(
        new OverleafSyncError(
          'E_TIMEOUT',
          `could not join the Overleaf project within ${Math.round(LEGACY_CONNECT_BUDGET_MS / 1000)} s`,
          LEGACY_HINT,
        ),
      )
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      LegacyTransport.connect(credential, projectId, {
        ...(options ?? {}),
        signal: controller.signal,
      }),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuterAbort)
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
