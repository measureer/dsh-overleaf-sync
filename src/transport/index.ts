import type { Credential, OverleafTransport, TransportFactory } from '../types.js'
import { OverleafSocket } from './socket.js'

/**
 * Transport factory used by the service layer. Resolves only after the socket
 * has joined the project, so callers immediately get a usable transport.
 */
export const createTransport: TransportFactory = async (
  credential: Credential,
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<OverleafTransport> => {
  return OverleafSocket.connect(credential, projectId, options)
}

export { OverleafHttp } from './http.js'
export { OverleafSocket, socketEndpoint } from './socket.js'
export type { SocketEndpoint } from './socket.js'
export * from './credentials.js'
export * from './packed.js'
