import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import type {
  ApiResult,
  LinkRecord,
  PathValidation,
  PickDirectoryResult,
  ProjectListEntry,
  SettingsField,
  StatusSummary,
} from './api'
import { FieldControl, FieldRow, Hint, SectionCard, SwitchRow, type DraftValue, type Translate } from './fields'

/** Keys rendered by the "sync strategy" block, in order. */
const STRATEGY_KEYS = [
  'defaultStrategy',
  'confirmRemoteWrite',
  'git.autoInit',
  'git.autoCommit',
  'git.initialCommitMessage',
  'git.includeBinaryInFirstCommit',
] as const

/** Keys rendered by the advanced block, in order; unknown fields follow. */
const ADVANCED_KEYS = [
  'baseUrl',
  'localRootPattern',
  'watch.autoStart',
  'watch.idleLeaveDocMs',
  'watch.maxOpenDocs',
  'journal.enabled',
  'journal.keepDays',
  'debug',
] as const

const inputRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const mono: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  opacity: 0.75,
  wordBreak: 'break-all',
}

const problems: React.CSSProperties = {
  margin: '2px 0 0',
  paddingLeft: 18,
  fontSize: 12,
  color: '#c08a2e',
}

/**
 * Expand the local folder pattern for a preview.
 *
 * Only presentation: the host owns the real expansion (`validate-path` and
 * `link` both resolve the pattern server-side). `~` is intentionally left alone
 * because the browser has no notion of a home directory.
 */
export function expandPattern(pattern: string, projectName: string): string {
  return pattern.replaceAll('{project}', projectName).replaceAll('{name}', projectName)
}

/** Render a list of fields, preserving the host order. */
function FieldList(props: {
  fields: SettingsField[]
  draft: Record<string, DraftValue>
  disabled: boolean
  t: Translate
  onChange: (key: string, next: DraftValue) => void
}): ReactNode {
  return (
    <>
      {props.fields.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          value={props.draft[field.key] ?? ''}
          disabled={props.disabled}
          t={props.t}
          onChange={props.onChange}
        />
      ))}
    </>
  )
}

/** Section ①: credential state, cookie/CSRF entry and sign out. */
export function AccountBlock(props: {
  t: Translate
  status: StatusSummary | null
  expired: boolean
  disabled: boolean
  busy: boolean
  baseUrl: string
  onLogin: (payload: { cookie: string; csrfToken?: string; baseUrl?: string }) => Promise<boolean>
  onLogout: () => Promise<void>
}): ReactNode {
  const { t } = props
  const [cookie, setCookie] = useState('')
  const [csrfToken, setCsrfToken] = useState('')
  const [confirmLogout, setConfirmLogout] = useState(false)

  const authenticated = props.status?.authenticated === true
  const hint = props.status?.credential?.hint
  const savedAt = props.status?.credential?.savedAt
  const canSubmit = cookie.trim().length > 0 && !props.disabled && !props.busy

  const submit = async (): Promise<void> => {
    const csrf = csrfToken.trim()
    const ok = await props.onLogin({
      cookie: cookie.trim(),
      ...(csrf.length > 0 ? { csrfToken: csrf } : {}),
      ...(props.baseUrl.trim().length > 0 ? { baseUrl: props.baseUrl.trim() } : {}),
    })
    // The secret never survives a submit — success or failure — and is never echoed.
    setCookie('')
    setCsrfToken('')
    if (!ok) return
  }

  return (
    <SectionCard
      title={t('accountTitle')}
      description={t('accountHint')}
      actions={<StatusBadge authenticated={authenticated} expired={props.expired} t={t} />}
    >
      {hint === undefined ? null : (
        <Hint tone="ok">
          {t('credentialSet')}: {hint}
          {savedAt === undefined ? '' : ` · ${t('savedAt', { time: formatTime(savedAt) })}`}
        </Hint>
      )}
      <FieldRow
        label={t('cookieLabel')}
        control={
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('cookieLabel')}
            placeholder={t('cookiePlaceholder')}
            disabled={props.disabled}
            value={cookie}
            onChange={(event) => setCookie(event.currentTarget.value)}
          />
        }
      />
      <FieldRow
        label={t('csrfLabel')}
        hint={t('csrfHint')}
        control={
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('csrfLabel')}
            disabled={props.disabled}
            value={csrfToken}
            onChange={(event) => setCsrfToken(event.currentTarget.value)}
          />
        }
      />
      <div style={inputRow}>
        <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {props.busy ? t('signingIn') : t('loginButton')}
        </Button>
        {authenticated ? (
          confirmLogout ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={props.disabled || props.busy}
                onClick={() => {
                  setConfirmLogout(false)
                  void props.onLogout()
                }}
              >
                {t('logoutConfirm')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmLogout(false)}>
                {t('cancel')}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={props.disabled || props.busy}
              onClick={() => setConfirmLogout(true)}
            >
              {t('logoutButton')}
            </Button>
          )
        ) : null}
      </div>
    </SectionCard>
  )
}

/** Section ②: project picker, local folder validation, binding. */
export function ProjectBlock(props: {
  t: Translate
  status: StatusSummary | null
  projects: ProjectListEntry[]
  pattern: string
  disabled: boolean
  busy: boolean
  onRefresh: () => void
  onValidatePath: (payload: { path: string; projectId?: string }) => Promise<ApiResult<PathValidation>>
  /** Opens the host's folder chooser; `kind` says whether that is possible at all. */
  onPickDirectory: (options?: { probe?: boolean }) => Promise<ApiResult<PickDirectoryResult>>
  onLink: (payload: { projectId: string; localRoot?: string; force?: boolean }) => Promise<ApiResult<LinkRecord>>
}): ReactNode {
  const { t } = props
  const current = props.status?.current
  const [projectId, setProjectId] = useState('')
  const [root, setRoot] = useState('')
  const [validation, setValidation] = useState<PathValidation | null>(null)
  const [force, setForce] = useState<{ path: string; message: string } | null>(null)
  /** Set once the host answers that it has no OS chooser: show the manual fallback instead. */
  /**
   * `null` = not asked yet, `''` = the host has the OS chooser, a string = why
   * the row falls back to manual input.
   */
  const [pickerBlocked, setPickerBlocked] = useState<string | null>(null)

  // Ask once whether this host can open an OS folder dialog, so the row shows
  // either 「选择目录」 or the manual 「校验路径」 fallback from the start.
  useEffect(() => {
    let alive = true
    void props.onPickDirectory({ probe: true }).then((result) => {
      if (!alive || !result.ok) return
      setPickerBlocked(result.value.kind === 'native' ? '' : t('pickerUnavailable'))
    })
    return () => {
      alive = false
    }
    // Probe once per mount on purpose: the capability is fixed for the host's life.
  }, [])

  const selectedId = projectId.length > 0 ? projectId : (current?.projectId ?? '')
  const selected = props.projects.find((entry) => entry.id === selectedId)
  const projectName = selected?.name ?? current?.projectName ?? ''
  const preview = projectName.length > 0 ? expandPattern(props.pattern, projectName) : props.pattern

  const canLink = selectedId.length > 0 && !props.disabled && !props.busy

  const doValidate = async (value?: string): Promise<void> => {
    setForce(null)
    const target = (value ?? root).trim()
    const result = await props.onValidatePath({
      path: target.length > 0 ? target : preview,
      ...(selectedId.length > 0 ? { projectId: selectedId } : {}),
    })
    if (result.ok) {
      setValidation(result.value)
      if (result.value.resolved.length > 0) setRoot(result.value.resolved)
    } else {
      setValidation({ ok: false, resolved: '', problems: [result.message] })
    }
  }

  /**
   * Open the host's folder chooser. A `native` answer is the OS dialog and the
   * picked folder becomes the draft (then validated in place); `browse` and
   * `unavailable` mean this host cannot show one, so the row falls back to the
   * manual input plus 「校验路径」.
   */
  const doPick = async (): Promise<void> => {
    const result = await props.onPickDirectory()
    if (!result.ok) return
    if (result.value.kind !== 'native') {
      setPickerBlocked(t('pickerUnavailable'))
      return
    }
    setPickerBlocked(null)
    if (result.value.path === null) return
    setRoot(result.value.path)
    setValidation(null)
    setForce(null)
    await doValidate(result.value.path)
  }

  const doLink = async (forceLink: boolean): Promise<void> => {
    const result = await props.onLink({
      projectId: selectedId,
      ...(root.trim().length > 0 ? { localRoot: root.trim() } : {}),
      ...(forceLink ? { force: true } : {}),
    })
    if (result.ok) {
      setForce(null)
      setValidation(null)
      return
    }
    if (result.code === 'E_LOCAL_DIR_CONFIRM_REQUIRED') {
      setForce({ path: root.trim().length > 0 ? root.trim() : preview, message: result.message })
      return
    }
    setForce(null)
  }

  return (
    <SectionCard
      title={t('projectTitle')}
      actions={
        <Button variant="ghost" size="sm" disabled={props.disabled || props.busy} onClick={props.onRefresh}>
          {props.busy ? t('refreshing') : t('refreshButton')}
        </Button>
      }
    >
      <FieldRow
        label={t('projectLabel')}
        control={
          <select
            aria-label={t('projectLabel')}
            disabled={props.disabled || props.projects.length === 0}
            value={selectedId}
            style={{ padding: '6px 8px', borderRadius: 6, fontSize: 13, minWidth: 240 }}
            onChange={(event) => {
              setProjectId(event.currentTarget.value)
              setValidation(null)
              setForce(null)
            }}
          >
            <option value="">{t('projectNone')}</option>
            {props.projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
                {entry.lastUpdated === undefined ? '' : ` — ${t('projectUpdated', { time: formatTime(entry.lastUpdated) })}`}
              </option>
            ))}
          </select>
        }
      />
      <FieldRow
        label={t('localRootLabel')}
        hint={t('localRootHint')}
        control={
          <div style={inputRow}>
            <Input
              aria-label={t('localRootLabel')}
              spellCheck={false}
              disabled={props.disabled}
              placeholder={preview}
              value={root}
              style={{ minWidth: 260 }}
              onChange={(event) => {
                setRoot(event.currentTarget.value)
                setValidation(null)
                setForce(null)
              }}
            />
            {pickerBlocked !== null && pickerBlocked.length > 0 ? (
              <Button variant="ghost" size="sm" disabled={props.disabled || props.busy} onClick={() => void doValidate()}>
                {t('validateButton')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={props.disabled || props.busy}
                onClick={() => void doPick()}
              >
                {props.busy ? t('picking') : t('pickButton')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={props.disabled}
              onClick={() => {
                setRoot('')
                setValidation(null)
                setForce(null)
              }}
            >
              {t('useDefaultButton')}
            </Button>
          </div>
        }
      />
      {pickerBlocked === null ? null : <Hint tone="warn">{pickerBlocked}</Hint>}
      {validation === null ? null : validation.ok ? (
        <Hint tone="ok">{t('pathOk', { path: validation.resolved })}</Hint>
      ) : (
        <div>
          <Hint tone="warn">{t('pathProblems')}</Hint>
          <ul style={problems}>
            {validation.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <div style={inputRow}>
        <Button variant="primary" size="sm" disabled={!canLink} onClick={() => void doLink(false)}>
          {props.busy ? t('linking') : t('linkButton')}
        </Button>
        {selectedId.length === 0 ? <Hint tone="warn">{t('projectRequired')}</Hint> : null}
      </div>
      {force === null ? null : (
        <div style={{ borderTop: '1px dashed rgba(127,127,127,0.35)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong style={{ fontSize: 13 }}>{t('forceTitle')}</strong>
          <Hint tone="warn">{t('forceBody', { path: force.path })}</Hint>
          <div style={inputRow}>
            <Button variant="outline" size="sm" disabled={props.busy} onClick={() => void doLink(true)}>
              {t('forceButton')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setForce(null)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      {current === undefined ? null : (
        <div style={mono}>
          <div>
            {t('linkedFiles', { count: current.files })} ·{' '}
            {current.lastPullAt === undefined ? t('neverPulled') : t('lastPullAt', { time: formatTime(current.lastPullAt) })}
          </div>
          <div>{current.localRoot}</div>
        </div>
      )}
    </SectionCard>
  )
}

/** Section ③: conflict strategy and git behaviour. */
export function StrategyBlock(props: {
  t: Translate
  fields: SettingsField[]
  draft: Record<string, DraftValue>
  disabled: boolean
  onChange: (key: string, next: DraftValue) => void
}): ReactNode {
  const { t } = props
  const rendered = STRATEGY_KEYS.map((key) => props.fields.find((field) => field.key === key)).filter(
    (field): field is SettingsField => field !== undefined,
  )
  return (
    <SectionCard title={t('strategyTitle')}>
      {rendered.length === 0 ? <Hint>{t('noFields')}</Hint> : null}
      <FieldList fields={rendered} draft={props.draft} disabled={props.disabled} t={t} onChange={props.onChange} />
    </SectionCard>
  )
}

/** Section ④: advanced settings, collapsed by default. */
export function AdvancedBlock(props: {
  t: Translate
  fields: SettingsField[]
  draft: Record<string, DraftValue>
  disabled: boolean
  open: boolean
  /** Why there are no fields (Host API unreachable); shown instead of the empty state. */
  failure?: string
  onToggle: () => void
  onChange: (key: string, next: DraftValue) => void
}): ReactNode {
  const { t } = props
  const ordered = ADVANCED_KEYS.map((key) => props.fields.find((field) => field.key === key)).filter(
    (field): field is SettingsField => field !== undefined,
  )
  const known = new Set<string>(ADVANCED_KEYS)
  const rest = props.fields.filter((field) => !known.has(field.key))
  const rendered = [...ordered, ...rest]

  return (
    <SectionCard
      title={t('advancedTitle')}
      actions={
        <Button variant="ghost" size="sm" onClick={props.onToggle}>
          {props.open ? t('advancedHide') : t('advancedShow')}
        </Button>
      }
    >
      {props.open ? (
        <>
          {rendered.length === 0 ? <Hint>{props.failure ?? t('noFields')}</Hint> : null}
          <FieldList fields={rendered} draft={props.draft} disabled={props.disabled} t={t} onChange={props.onChange} />
        </>
      ) : null}
    </SectionCard>
  )
}

/** Signed-in badge, driven by `status.authenticated`. */
function StatusBadge(props: { authenticated: boolean; expired: boolean; t: Translate }): ReactNode {
  const state = props.expired ? 'error' : props.authenticated ? 'done' : 'idle'
  const label = props.expired ? props.t('authExpired') : props.authenticated ? props.t('signedIn') : props.t('signedOut')
  const color = props.expired ? '#d05252' : props.authenticated ? '#3f9a63' : 'inherit'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color }}>
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: 4, background: state === 'idle' ? 'currentColor' : color, opacity: 0.85 }}
      />
      {label}
    </span>
  )
}

/** Short, locale-independent timestamp for inline metadata. */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** Re-exported so the panel can render a read-only switch row for `writable:false`. */
export { SwitchRow }
