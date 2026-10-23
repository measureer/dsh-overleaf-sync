/**
 * Right-sidebar panel (design §14.4).
 *
 * Read-only overview plus the two write actions that need to be one click away:
 * pull and push. The page deliberately owns no authoritative state — it re-reads
 * `status`/`conflicts`/`journal` after every event, so a hot reload or a second
 * window can never leave stale numbers on screen.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  EVENTS_URL,
  isMissingRoute,
  post,
  type ApiFailure,
  type ConflictEntry,
  type JournalEntryView,
  type PullSummary,
  type PushSummary,
  type ResolveView,
  type StatusSummary,
  type WatchView,
} from './api'
import { Hint } from './fields'

type PanelProps = PropsLocale<'overleaf-sync'>

type Tone = 'ok' | 'warn' | 'error'
type Notice = { tone: Tone; text: string }
type Feed = 'live' | 'poll' | 'offline'
type Busy = 'pull' | 'push' | 'watch' | 'resolve' | undefined
type ConfirmKind = 'pull' | 'push'

/** How often the panel re-reads when the event feed is unavailable. */
const POLL_MS = 15_000

const JOURNAL_LIMIT = 12

const page: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '8px 10px 16px',
  fontSize: 13,
}

const card: React.CSSProperties = {
  border: '1px solid rgba(127, 127, 127, 0.28)',
  borderRadius: 8,
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const muted: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.66,
}

const mono: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  wordBreak: 'break-all',
}

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const statGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 6,
}

const stat: React.CSSProperties = {
  border: '1px solid rgba(127, 127, 127, 0.22)',
  borderRadius: 7,
  padding: '5px 7px',
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
}

const statValue: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 650,
  lineHeight: 1.2,
}

const list: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  maxHeight: 132,
  overflowY: 'auto',
}

/** Tone of a stat value: a non-zero number the user must act on is highlighted. */
function statColor(kind: 'files' | 'pending' | 'conflicts', value: number): string | undefined {
  if (kind === 'conflicts') return value > 0 ? '#d05252' : undefined
  if (kind === 'pending') return value > 0 ? '#c08a2e' : undefined
  return undefined
}

export function OverleafSidebarPanel(props: PanelProps): ReactNode {
  const { t } = props
  const [status, setStatus] = useState<StatusSummary | null>(null)
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([])
  const [journal, setJournal] = useState<JournalEntryView[]>([])
  const [failure, setFailure] = useState<ApiFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>(undefined)
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [feed, setFeed] = useState<Feed>('poll')
  const [copied, setCopied] = useState(false)
  const [watch, setWatch] = useState<WatchView | null>(null)

  /** Set while the component is mounted; guards late async writes after unmount. */
  const alive = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    const [nextStatus, nextConflicts, nextJournal, nextWatch] = await Promise.all([
      post<StatusSummary>('status'),
      post<ConflictEntry[]>('conflicts'),
      post<JournalEntryView[]>('journal', { limit: JOURNAL_LIMIT }),
      post<WatchView>('watch', { action: 'status' }),
    ])
    if (!alive.current) return

    if (!nextStatus.ok) {
      setFailure(nextStatus)
      setLoading(false)
      return
    }
    setFailure(null)
    setStatus(nextStatus.value)
    // Conflicts and the journal are decoration next to `status`: when either
    // fails, the page keeps the last good list instead of blanking out.
    if (nextConflicts.ok) setConflicts(nextConflicts.value)
    if (nextJournal.ok) setJournal(nextJournal.value)
    if (nextWatch.ok) setWatch(nextWatch.value)
    setLoading(false)
  }, [])

  useEffect(() => {
    alive.current = true
    void load()

    let source: EventSource | undefined
    if (typeof EventSource === 'function') {
      source = new EventSource(EVENTS_URL)
      source.onopen = () => {
        if (alive.current) setFeed('live')
      }
      source.onerror = () => {
        if (alive.current) setFeed('poll')
      }
      const reload = (): void => {
        void load()
      }
      source.addEventListener('status', reload)
      source.addEventListener('ready', reload)
    }

    // The poll runs regardless of the feed: it is cheap (three routes), and it
    // keeps the numbers right when the stream silently stalls behind a proxy.
    const timer = setInterval(() => {
      void load()
    }, POLL_MS)

    return () => {
      alive.current = false
      clearInterval(timer)
      source?.close()
    }
  }, [load])

  const runPull = useCallback(async (): Promise<void> => {
    setConfirm(null)
    setBusy('pull')
    setNotice(null)
    const result = await post<PullSummary>('pull')
    if (!alive.current) return
    setBusy(undefined)
    setNotice(result.ok ? pullNotice(result.value) : failureNotice(result))
    await load()
  }, [load])

  const runPush = useCallback(
    async (dryRun: boolean): Promise<void> => {
      setConfirm(null)
      setBusy('push')
      setNotice(null)
      const result = await post<PushSummary>('push', { dryRun })
      if (!alive.current) return
      setBusy(undefined)
      setNotice(result.ok ? pushNotice(result.value) : failureNotice(result))
      await load()
    },
    [load],
  )

  const runWatch = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      setBusy('watch')
      setNotice(null)
      const result = await post<WatchView>('watch', { action })
      if (!alive.current) return
      setBusy(undefined)
      if (result.ok) {
        setWatch(result.value)
        setNotice({ tone: 'ok', text: t(action === 'start' ? 'sbWatchStarted' : 'sbWatchStopped') })
      } else {
        setNotice(failureNotice(result))
      }
      await load()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  )

  const runResolve = useCallback(
    async (path: string | undefined, choice: 'keep_local' | 'keep_remote' | 'merge'): Promise<void> => {
      setBusy('resolve')
      setNotice(null)
      const result = await post<ResolveView>('resolve', path === undefined ? { all: true, choice } : { path, choice })
      if (!alive.current) return
      setBusy(undefined)
      if (result.ok) {
        setNotice({
          tone: 'ok',
          text: result.value.resolved.length === 0
            ? t('sbResolveNone')
            : t('sbResolved', { count: result.value.resolved.length }),
        })
      } else {
        setNotice(failureNotice(result))
      }
      await load()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  )

  const copyPath = useCallback(async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [])

  const pinned = status?.current
  const pending = status?.pending.localChanges ?? 0
  const conflictCount = status?.pending.conflicts ?? conflicts.length

  const pullNotice = (value: PullSummary): Notice => {
    const parts = [t('syncPulled', { pulled: value.pulled.length, unchanged: value.unchanged.length })]
    if (value.conflicts.length > 0) parts.push(t('syncConflicts', { count: value.conflicts.length }))
    if (value.skipped.length > 0) parts.push(t('syncSkipped', { count: value.skipped.length }))
    const warning = value.warnings[0]
    if (warning !== undefined) parts.push(warning)
    return { tone: value.conflicts.length > 0 || value.warnings.length > 0 ? 'warn' : 'ok', text: parts.join(' · ') }
  }

  const pushNotice = (value: PushSummary): Notice => {
    if (value.pushed.length === 0) return { tone: 'ok', text: t('sbNothingToPush') }
    if (value.dryRun) return { tone: 'ok', text: t('syncDryRun', { pushed: value.pushed.length }) }
    const parts = [t('syncPushed', { pushed: value.pushed.length })]
    if (value.conflicts.length > 0) parts.push(t('syncConflicts', { count: value.conflicts.length }))
    return { tone: value.conflicts.length > 0 ? 'warn' : 'ok', text: parts.join(' · ') }
  }

  const failureNotice = (failure: ApiFailure): Notice => ({
    tone: 'error',
    text: isMissingRoute(failure) ? t('hostNotReadyHint') : failure.message,
  })

  if (loading) return <div style={page}>{t('sbLoading')}</div>

  if (failure !== null && status === null) {
    return (
      <div style={page}>
        <div style={card}>
          <strong>{isMissingRoute(failure) ? t('hostNotReady') : t('loadFailed')}</strong>
          <Hint tone="error">{failure.message}</Hint>
          <div style={row}>
            <Button onClick={() => void load()}>{t('retryButton')}</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={page}>
      <div style={row}>
        <strong style={{ fontSize: 13 }}>{pinned?.projectName ?? t('nav')}</strong>
        <span style={{ flex: 1 }} />
        <span style={{ ...muted, opacity: 0.9 }} title={FEED_TITLE[feed]}>
          {t(feed === 'live' ? 'sbFeedLive' : feed === 'poll' ? 'sbFeedPoll' : 'sbFeedOffline')}
        </span>
        <Button
          disabled={busy !== undefined}
          onClick={() => {
            void load()
          }}
        >
          {t('sbRefresh')}
        </Button>
      </div>

      {pinned === undefined ? (
        <div style={card}>
          <span>{t('syncUnlinked')}</span>
          <p style={muted}>{t('sbUnlinkedHint')}</p>
        </div>
      ) : (
        <>
          <div style={statGrid}>
            <div style={stat}>
              <span style={muted}>{t('syncFilesLabel')}</span>
              <span style={statValue}>{pinned.files}</span>
            </div>
            <div style={stat}>
              <span style={muted}>{t('syncPendingLabel')}</span>
              <span style={{ ...statValue, color: statColor('pending', pending) }}>{pending}</span>
            </div>
            <div style={stat}>
              <span style={muted}>{t('sbConflictsLabel')}</span>
              <span style={{ ...statValue, color: statColor('conflicts', conflictCount) }}>{conflictCount}</span>
            </div>
          </div>

          <div style={card}>
            <span style={mono}>{pinned.localRoot}</span>
            <div style={row}>
              <Button
                onClick={() => {
                  void copyPath(pinned.localRoot)
                }}
              >
                {copied ? t('sbCopied') : t('sbCopyPath')}
              </Button>
              <span style={{ ...muted, flex: 1 }}>
                {pinned.lastPullAt === undefined
                  ? t('neverPulled')
                  : `${t('sbLastPull')} ${new Date(pinned.lastPullAt).toLocaleString()}`}
              </span>
            </div>
          </div>

          <div style={card}>
            <div style={row}>
              <strong style={{ fontSize: 12 }}>{t('sbWatchTitle')}</strong>
              <span style={{ flex: 1 }} />
              <span style={{ ...muted, color: watch?.running === true ? '#2f7d32' : undefined }}>
                {t(watch?.running === true ? 'sbWatchOn' : 'sbWatchOff')}
              </span>
            </div>
            <span style={muted}>{t('sbWatchHint')}</span>
            {watch?.running !== true ? null : (
              <div style={{ ...row, ...muted }}>
                <span>
                  {t('sbWatchOpenDocs')}: {watch.openDocs}
                </span>
                {watch.lastEventAt === undefined ? null : (
                  <span>
                    {t('sbJournalTitle')}: {new Date(watch.lastEventAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            )}
            {watch?.lastError === undefined ? null : <Hint tone="error">{watch.lastError}</Hint>}
            <div style={row}>
              <Button
                disabled={busy !== undefined}
                onClick={() => {
                  void runWatch(watch?.running === true ? 'stop' : 'start')
                }}
              >
                {busy === 'watch'
                  ? t('sbLoading')
                  : t(watch?.running === true ? 'sbWatchStop' : 'sbWatchStart')}
              </Button>
            </div>
          </div>

          <div style={row}>
            <Button
              disabled={busy !== undefined}
              onClick={() => {
                if (pending > 0) {
                  setConfirm('pull')
                  return
                }
                void runPull()
              }}
            >
              {busy === 'pull' ? t('pulling') : t('pullButton')}
            </Button>
            <Button
              disabled={busy !== undefined || pending === 0}
              onClick={() => {
                setConfirm('push')
              }}
            >
              {busy === 'push' ? t('pushing') : t('pushButton')}
            </Button>
            <Button
              disabled={busy !== undefined}
              onClick={() => {
                void runPush(true)
              }}
            >
              {t('pushDryButton')}
            </Button>
          </div>

          {confirm === null ? null : (
            <div style={card}>
              <span>
                {confirm === 'pull'
                  ? t('sbPullConfirm', { count: pending })
                  : t('pushConfirm', { count: pending })}
              </span>
              <div style={row}>
                <Button
                  onClick={() => {
                    if (confirm === 'pull') void runPull()
                    else void runPush(false)
                  }}
                >
                  {confirm === 'pull' ? t('sbPullAnyway') : t('pushConfirmYes')}
                </Button>
                <Button onClick={() => setConfirm(null)}>{t('pushConfirmNo')}</Button>
              </div>
            </div>
          )}

          {notice === null ? null : <Hint tone={notice.tone}>{notice.text}</Hint>}

          <div style={card}>
            <div style={row}>
              <strong style={{ fontSize: 12 }}>{t('sbConflictsTitle')}</strong>
              <span style={{ flex: 1 }} />
              <span style={muted}>{conflictCount}</span>
            </div>
            {conflicts.length === 0 ? (
              <span style={muted}>{t('sbConflictsEmpty')}</span>
            ) : (
              <>
                <span style={muted}>{t('sbResolveHint')}</span>
                <div style={list}>
                  {conflicts.map((entry) => (
                    <div key={entry.copyPath} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={mono} title={entry.copyPath}>
                        {entry.path}
                      </span>
                      <div style={row}>
                        <Button
                          disabled={busy !== undefined}
                          onClick={() => {
                            void runResolve(entry.path, 'keep_local')
                          }}
                        >
                          {t('sbResolveKeepLocal')}
                        </Button>
                        <Button
                          disabled={busy !== undefined}
                          onClick={() => {
                            void runResolve(entry.path, 'keep_remote')
                          }}
                        >
                          {t('sbResolveKeepRemote')}
                        </Button>
                        <Button
                          disabled={busy !== undefined}
                          onClick={() => {
                            void runResolve(entry.path, 'merge')
                          }}
                        >
                          {t('sbResolveMerge')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={card}>
            <strong style={{ fontSize: 12 }}>{t('sbJournalTitle')}</strong>
            {journal.length === 0 ? (
              <span style={muted}>{t('sbJournalEmpty')}</span>
            ) : (
              <div style={list}>
                {journal.map((entry, index) => (
                  <span key={`${entry.ts ?? ''}-${index}`} style={mono} title={JSON.stringify(entry)}>
                    {journalLine(entry)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {status?.baseUrl === undefined ? null : <span style={{ ...muted, ...mono }}>{status.baseUrl}</span>}
        </>
      )}
    </div>
  )
}

/** One compact journal row: `HH:MM event path`. */
export function journalLine(entry: JournalEntryView): string {
  const time = entry.ts === undefined ? '' : new Date(entry.ts).toLocaleTimeString()
  const target = entry.path ?? entry.docId ?? ''
  return [time, entry.event, target].filter((part) => part !== '').join(' ')
}

/** Tooltip per feed state (kept out of the dictionary: developer-facing detail). */
const FEED_TITLE: Record<Feed, string> = {
  live: `EventSource ${EVENTS_URL}`,
  poll: `${POLL_MS / 1000}s polling`,
  offline: 'no feed',
}
