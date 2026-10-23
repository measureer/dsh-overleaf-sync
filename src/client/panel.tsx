import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  isMissingRoute,
  post,
  type ApiFailure,
  type ApiResult,
  type FieldValue,
  type LinkRecord,
  type LoginView,
  type LogoutView,
  type PathValidation,
  type PickDirectoryResult,
  type ProjectListEntry,
  type SettingsField,
  type SettingsView,
  type StatusSummary,
} from './api'
import { RenderBoundary } from './boundary'
import { Hint, type DraftValue } from './fields'
import { AccountBlock, AdvancedBlock, ProjectBlock, StrategyBlock } from './sections'

/**
 * Props handed to a `settings.section` entry: the slot supplies the runtime face
 * (`close` and friends), and `locale: 'overleaf-sync'` on the registration adds
 * the typed translator.
 */
type PanelProps = PropsRuntime<'settings.section'> & PropsLocale<'overleaf-sync'>

type Notice = { tone: 'ok' | 'warn' | 'error'; text: string }

/** Fields that belong to the "sync strategy" block when the host omits `group`. */
const STRATEGY_FIELD_KEYS = new Set<string>([
  'defaultStrategy',
  'confirmRemoteWrite',
  'git.autoInit',
  'git.autoCommit',
  'git.initialCommitMessage',
  'git.includeBinaryInFirstCommit',
])

const page: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '4px 2px 16px',
  maxWidth: 760,
}

const pageTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 650,
}

const footer: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  paddingTop: 4,
  borderTop: '1px solid rgba(127, 127, 127, 0.25)',
}

const banner: React.CSSProperties = {
  border: '1px solid rgba(192, 138, 46, 0.5)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

/** Convert a host-provided field value into its editable draft form. */
function draftValueOf(value: unknown): DraftValue {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function draftOf(view: SettingsView): Record<string, DraftValue> {
  const draft: Record<string, DraftValue> = {}
  for (const field of view.fields) draft[field.key] = draftValueOf(field.value)
  return draft
}

/**
 * Build the flat dotted-key patch the host expects, containing only the fields
 * the user actually changed. Untouched fields are never sent, so a concurrent
 * edit of an unrelated key is preserved.
 */
export function buildPatch(fields: SettingsField[], draft: Record<string, DraftValue>): Record<string, FieldValue> {
  const patch: Record<string, FieldValue> = {}
  for (const field of fields) {
    const next = draft[field.key]
    if (next === undefined) continue
    if (field.type === 'boolean') {
      if (typeof next === 'boolean' && next !== (field.value === true)) patch[field.key] = next
      continue
    }
    if (next === '') continue
    if (field.type === 'number') {
      if (typeof next === 'number' && next !== Number(field.value)) patch[field.key] = next
      continue
    }
    if (typeof next === 'boolean') continue
    if (String(next) !== String(field.value ?? '')) patch[field.key] = String(next)
  }
  return patch
}

/** Number fields the user cleared: the patch cannot represent them, so saving is blocked. */
function invalidNumberKeys(fields: SettingsField[], draft: Record<string, DraftValue>): string[] {
  return fields.filter((field) => field.type === 'number' && draft[field.key] === '').map((field) => field.key)
}

/** Root of the Overleaf settings page. */
export function OverleafSettingsSection(props: PanelProps): ReactNode {
  const { t } = props
  const [status, setStatus] = useState<StatusSummary | null>(null)
  const [view, setView] = useState<SettingsView | null>(null)
  const [draft, setDraft] = useState<Record<string, DraftValue>>({})
  const [projects, setProjects] = useState<ProjectListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState(false)
  const [hostReady, setHostReady] = useState(true)
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null)
  const [expired, setExpired] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const applyView = useCallback((next: SettingsView) => {
    setView(next)
    setDraft(draftOf(next))
  }, [])

  const describeFailure = useCallback(
    (failure: ApiFailure): string => {
      if (isMissingRoute(failure)) return t('hostNotReadyHint')
      return failure.hint === undefined ? failure.message : `${failure.message} (${failure.hint})`
    },
    [t],
  )

  const noteFailure = useCallback(
    (failure: ApiFailure) => {
      if (failure.code === 'E_AUTH_EXPIRED' || failure.code === 'E_AUTH_INVALID') setExpired(true)
      setNotice({ tone: 'error', text: describeFailure(failure) })
    },
    [describeFailure],
  )

  const loadStatus = useCallback(async () => {
    const result = await post<StatusSummary>('status')
    if (result.ok) {
      setStatus(result.value)
      return
    }
    if (isMissingRoute(result)) {
      setHostReady(false)
      setLoadFailure(result)
      return
    }
    noteFailure(result)
  }, [noteFailure])

  // Initial load: everything in parallel, one abort controller for the page lifetime.
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    void (async () => {
      setLoading(true)
      const [statusResult, settingsResult, projectsResult] = await Promise.all([
        post<StatusSummary>('status', {}, controller.signal),
        post<SettingsView>('settings.describe', {}, controller.signal),
        post<ProjectListEntry[]>('projects', {}, controller.signal),
      ])
      if (controller.signal.aborted) return
      setLoading(false)

      const missing = [statusResult, settingsResult, projectsResult].find(
        (result): result is ApiFailure => !result.ok && isMissingRoute(result),
      )
      if (missing !== undefined) {
        setHostReady(false)
        setLoadFailure(missing)
        return
      }
      setHostReady(true)
      if (statusResult.ok) setStatus(statusResult.value)
      else noteFailure(statusResult)
      if (projectsResult.ok) setProjects(projectsResult.value)
      if (settingsResult.ok) {
        setLoadFailure(null)
        applyView(settingsResult.value)
      } else {
        setLoadFailure(settingsResult)
      }
    })()
    return () => controller.abort()
  }, [applyView, noteFailure])

  const reloadAll = useCallback(async () => {
    setBusy('reload')
    setNotice(null)
    setConflict(false)
    const [statusResult, settingsResult] = await Promise.all([
      post<StatusSummary>('status'),
      post<SettingsView>('settings.describe'),
    ])
    setBusy(null)
    if (settingsResult.ok) {
      applyView(settingsResult.value)
      setLoadFailure(null)
      setHostReady(true)
    } else if (isMissingRoute(settingsResult)) {
      setHostReady(false)
      setLoadFailure(settingsResult)
    } else {
      setLoadFailure(settingsResult)
      noteFailure(settingsResult)
    }
    if (statusResult.ok) {
      setStatus(statusResult.value)
      setExpired(false)
    }
  }, [applyView, noteFailure])

  const login = useCallback(
    async (payload: { cookie: string; csrfToken?: string; baseUrl?: string }): Promise<boolean> => {
      setBusy('login')
      setNotice(null)
      const result = await post<LoginView>('login', payload)
      setBusy(null)
      if (!result.ok) {
        noteFailure(result)
        return false
      }
      setExpired(false)
      setNotice({ tone: 'ok', text: t('signedIn') })
      await loadStatus()
      return true
    },
    [loadStatus, noteFailure, t],
  )

  const logout = useCallback(async (): Promise<void> => {
    setBusy('logout')
    setNotice(null)
    const result = await post<LogoutView>('logout')
    setBusy(null)
    if (!result.ok) {
      noteFailure(result)
      return
    }
    setNotice({ tone: 'ok', text: t('signedOut') })
    await loadStatus()
  }, [loadStatus, noteFailure, t])

  const refreshProjects = useCallback(async (): Promise<void> => {
    setBusy('projects')
    setNotice(null)
    const result = await post<ProjectListEntry[]>('projects', { refresh: true })
    setBusy(null)
    if (result.ok) setProjects(result.value)
    else noteFailure(result)
  }, [noteFailure])

  const validatePath = useCallback(
    async (payload: { path: string; projectId?: string }): Promise<ApiResult<PathValidation>> => {
      setBusy('validate')
      const result = await post<PathValidation>('validate-path', payload)
      setBusy(null)
      if (!result.ok) noteFailure(result)
      return result
    },
    [noteFailure],
  )

  const pickDirectory = useCallback(async (options: { probe?: boolean } = {}): Promise<ApiResult<PickDirectoryResult>> => {
    // A probe only asks whether the host has a chooser: no busy flag, no toast.
    if (options.probe !== true) setBusy('pick')
    setNotice(null)
    const result = await post<PickDirectoryResult>('pick-directory', options.probe === true ? { probe: true } : {})
    if (options.probe !== true) setBusy(null)
    // A host without a chooser is a normal fallback, not an error to toast.
    if (!result.ok && options.probe !== true) noteFailure(result)
    return result
  }, [noteFailure])

  const link = useCallback(
    async (payload: { projectId: string; localRoot?: string; force?: boolean }): Promise<ApiResult<LinkRecord>> => {
      setBusy('link')
      setNotice(null)
      const result = await post<LinkRecord>('link', payload)
      setBusy(null)
      if (result.ok) {
        setNotice({ tone: 'ok', text: t('linkButton') })
        await loadStatus()
        return result
      }
      // The force confirmation is rendered by the project block; keep it quiet here.
      if (result.code !== 'E_LOCAL_DIR_CONFIRM_REQUIRED') noteFailure(result)
      return result
    },
    [loadStatus, noteFailure, t],
  )

  const fields = useMemo(() => view?.fields ?? [], [view])
  const patch = useMemo(() => buildPatch(fields, draft), [draft, fields])
  const invalid = useMemo(() => invalidNumberKeys(fields, draft), [draft, fields])
  const dirty = Object.keys(patch).length > 0
  const readOnly = !hostReady || (view !== null && !view.writable)

  const save = useCallback(async (): Promise<void> => {
    if (view === null || Object.keys(patch).length === 0 || invalid.length > 0) return
    setBusy('save')
    setNotice(null)
    setConflict(false)
    const result = await post<SettingsView>('settings.update', { patch, expectedRevision: view.revision })
    setBusy(null)
    if (result.ok) {
      applyView(result.value)
      setNotice({ tone: 'ok', text: t('savedNotice') })
      return
    }
    if (result.code === 'E_SETTINGS_CONFLICT') {
      // Never overwrite: the caller has to reload and redo the edit.
      setConflict(true)
      return
    }
    noteFailure(result)
  }, [applyView, invalid.length, noteFailure, patch, t, view])

  const change = useCallback((key: string, next: DraftValue) => {
    setDraft((previous) => ({ ...previous, [key]: next }))
  }, [])

  // The host tags each field with its page group; fall back to the well-known keys
  // so an older host (no `group`) still lands in the right block.
  const strategyFields = useMemo(
    () => fields.filter((field) => field.group === 'strategy' || STRATEGY_FIELD_KEYS.has(field.key)),
    [fields],
  )
  const advancedFields = useMemo(
    () => fields.filter((field) => field.group !== 'strategy' && !STRATEGY_FIELD_KEYS.has(field.key)),
    [fields],
  )
  const patternField = fields.find((field) => field.key === 'localRootPattern')
  const pattern =
    patternField === undefined
      ? '~/Overleaf/{project}'
      : String(draft[patternField.key] ?? patternField.value ?? '~/Overleaf/{project}')

  return (
    <div style={page}>
      <h2 style={pageTitle}>{t('nav')}</h2>

      {hostReady ? null : (
        <div style={{ ...banner, borderColor: 'rgba(192, 138, 46, 0.5)' }} role="alert">
          <strong style={{ fontSize: 13 }}>{t('hostNotReady')}</strong>
          <span style={{ opacity: 0.8 }}>{loadFailure === null ? t('hostNotReadyHint') : describeFailure(loadFailure)}</span>
          <div>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reloadAll()}>
              {t('retryButton')}
            </Button>
          </div>
        </div>
      )}

      {hostReady && loadFailure !== null && view === null ? (
        <div style={{ ...banner, borderColor: 'rgba(208, 82, 82, 0.5)' }} role="alert">
          <strong style={{ fontSize: 13 }}>{t('loadFailed')}</strong>
          <span style={{ opacity: 0.8 }}>{describeFailure(loadFailure)}</span>
        </div>
      ) : null}

      {readOnly && hostReady && view !== null ? <Hint tone="warn">{t('readOnlyNotice')}</Hint> : null}

      <RenderBoundary title={t('boundaryTitle', { section: t('accountTitle') })} retryLabel={t('boundaryRetry')}>
        <AccountBlock
          t={t}
          status={status}
          expired={expired}
          disabled={readOnly}
          busy={busy === 'login' || busy === 'logout'}
          baseUrl={String(draft.baseUrl ?? '')}
          onLogin={login}
          onLogout={logout}
        />
      </RenderBoundary>

      <RenderBoundary title={t('boundaryTitle', { section: t('projectTitle') })} retryLabel={t('boundaryRetry')}>
        <ProjectBlock
          t={t}
          status={status}
          projects={projects}
          pattern={pattern}
          disabled={!hostReady}
          busy={busy === 'projects' || busy === 'validate' || busy === 'link' || busy === 'pick'}
          onRefresh={() => void refreshProjects()}
          onValidatePath={validatePath}
          onPickDirectory={pickDirectory}
          onLink={link}
        />
      </RenderBoundary>

      <RenderBoundary title={t('boundaryTitle', { section: t('strategyTitle') })} retryLabel={t('boundaryRetry')}>
        <StrategyBlock t={t} fields={strategyFields} draft={draft} disabled={readOnly} onChange={change} />
      </RenderBoundary>

      <RenderBoundary title={t('boundaryTitle', { section: t('advancedTitle') })} retryLabel={t('boundaryRetry')}>
        <AdvancedBlock
          t={t}
          fields={advancedFields}
          failure={loadFailure === null ? undefined : describeFailure(loadFailure)}
          draft={draft}
          disabled={readOnly}
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((open) => !open)}
          onChange={change}
        />
      </RenderBoundary>

      <div style={footer}>
        <Button
          variant="primary"
          size="sm"
          disabled={readOnly || !dirty || busy !== null || invalid.length > 0}
          onClick={() => void save()}
        >
          {busy === 'save' ? t('saving') : t('saveButton')}
        </Button>
        <Button variant="outline" size="sm" disabled={readOnly || !dirty || busy !== null} onClick={() => void reloadAll()}>
          {t('discardButton')}
        </Button>
        {dirty ? <Hint tone="warn">{t('dirtyNotice')}</Hint> : null}
        {invalid.length > 0 ? <Hint tone="error">{invalid.join(', ')}</Hint> : null}
        {loading ? <Hint>{t('loadFailed')}</Hint> : null}
        <span style={{ flex: 1 }} />
        <Hint>{t('effectNotice')}</Hint>
      </div>

      {conflict ? (
        <div style={{ ...banner, borderColor: 'rgba(208, 82, 82, 0.55)' }} role="alert">
          <strong style={{ fontSize: 13 }}>{t('conflictNotice')}</strong>
          <div>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reloadAll()}>
              {t('reloadButton')}
            </Button>
          </div>
        </div>
      ) : null}

      {notice === null ? null : (
        <Hint tone={notice.tone === 'ok' ? 'ok' : notice.tone === 'warn' ? 'warn' : 'error'}>{notice.text}</Hint>
      )}
    </div>
  )
}
