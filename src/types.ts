/**
 * Shared domain types for dsh-overleaf-sync.
 *
 * Layers: transport (how we talk to Overleaf) → core (policy, state) → tools
 * (what the agent sees). Nothing in this file performs IO.
 */

/** One ShareJS/OT text operation. Positions are UTF-16 code units, text is real UTF-8. */
export interface TextOp {
  /** position */
  p: number
  /** insert */
  i?: string
  /** delete */
  d?: string
}

/** Overleaf entity kinds that matter to us. */
export type EntityType = 'doc' | 'file' | 'folder'

export interface FolderNode {
  id: string
  name: string
  parentFolderId: string | null
}

export interface DocNode {
  id: string
  name: string
  parentFolderId: string | null
}

export interface FileNode {
  id: string
  name: string
  parentFolderId: string | null
}

/** A joined project: the remote tree as plain data (no Overleaf internals). */
export interface ProjectSnapshot {
  id: string
  name: string
  folders: FolderNode[]
  docs: DocNode[]
  files: FileNode[]
}

/** A document as seen by the transport: full text + server-authoritative version. */
export interface DocContent {
  docId: string
  version: number
  /** Document text: wire lines decoded and joined with `'\n'` (no sentinel handling — a trailing empty line is a real trailing newline) */
  text: string
}

/** A remote change notification. */
export interface RemoteUpdate {
  docId: string
  version: number
  ops: TextOp[]
}

/** One entry of `GET /user/projects` (normalized to `id`). */
export interface ProjectListEntry {
  id: string
  name: string
  lastUpdated?: string
  archived?: boolean
}

/** Everything needed to speak to Overleaf on the user's behalf. */
export interface Credential {
  /** `https://www.overleaf.com/` — always with a trailing slash */
  baseUrl: string
  /** raw `Cookie:` header value (`overleaf_session2=…`) */
  cookie: string
  /** value of `<meta name="ol-csrfToken">` (or the login form `_csrf`) */
  csrfToken: string
  /** e.g. the account email prefix, for display only */
  userHint?: string
  savedAt: string
}

export type ConnectionState = 'connected' | 'disconnected' | 'rejected'

/**
 * The only way the core layer reaches Overleaf.
 *
 * Implementations must never leak Overleaf internals (raw `joinDoc` tuples,
 * presence payloads, `meta` blobs) through this interface.
 */
export interface OverleafTransport {
  readonly projectId: string
  /** joinProject → normalized tree */
  joinProject(): Promise<ProjectSnapshot>
  /** joinDoc → full text + version */
  joinDoc(docId: string): Promise<DocContent>
  leaveDoc(docId: string): Promise<void>
  /** submit an OT update based on `version`; resolves with the new server version */
  applyOtUpdate(docId: string, version: number, ops: TextOp[]): Promise<{ version: number }>
  /** subscribe to remote updates; returns an unsubscribe function */
  onRemoteUpdate(cb: (update: RemoteUpdate) => void): () => void
  onConnectionState(cb: (state: ConnectionState) => void): () => void
  close(): Promise<void>
}

export interface TransportFactory {
  (credential: Credential, projectId: string, options?: { signal?: AbortSignal }): Promise<OverleafTransport>
}

/** Per-project binding, persisted as `~/.dsh/overleaf-sync/projects/<id>/link.json`. */
export interface LinkRecord {
  schemaVersion: 1
  projectId: string
  projectName: string
  /** absolute path of the local folder */
  localRoot: string
  include?: string[]
  exclude?: string[]
  strategy?: ConflictStrategy
  autoPush?: boolean
  throttleMs?: number
  binary?: 'off' | 'download-only' | 'bidirectional'
  git?: GitRecord
  createdAt: string
  updatedAt: string
}

export type ConflictStrategy = 'auto' | 'keep-local' | 'keep-remote' | 'keep-both'

export interface GitRecord {
  /** `own` = created here, `parent` = already inside a bigger repository, `none` = skipped */
  mode: 'own' | 'parent' | 'none'
  root?: string
  initialCommit?: string
  initializedAt?: string
  /** why the repository was not created (mode `none`) */
  reason?: string
}

/** One file's baseline, persisted in `state.json`. */
export interface FileState {
  docId: string
  /** server version we last saw */
  remoteVersion: number
  /** sha256 of the remote text we last saw */
  remoteHash?: string
  /** sha256 of the local text we last wrote/read as in-sync */
  localHash: string
  syncedAt: string
  origin?: 'local' | 'remote' | 'both'
}

export interface ProjectState {
  schemaVersion: 1
  projectId: string
  localRoot: string
  updatedAt: string
  files: Record<string, FileState>
  filesMissing?: Record<string, { docId: string; deletedAt: string }>
}

/** Result of `core/gitInit.ensure()`. */
export interface GitInitResult extends GitRecord {
  /** true when this call created the repository */
  created: boolean
  /** files added to the initial commit */
  committedFiles?: number
  /** human-readable warning, e.g. `E_GIT_UNAVAILABLE: git not found in PATH` */
  warning?: string
}
