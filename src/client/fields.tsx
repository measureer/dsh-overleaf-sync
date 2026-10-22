import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'

import type { FieldValue, SettingsField } from './api'
import type { OverleafLocaleKey } from './locale'

/** Draft value held by the panel: numbers may temporarily be empty while typing. */
export type DraftValue = FieldValue | ''

/** Translate function bound to this plugin's locale namespace. */
export type Translate = TranslateNS<'overleaf-sync'>

/** Locale keys for the well-known fields of `settings.describe`. */
const FIELD_LABELS: Record<string, OverleafLocaleKey> = {
  defaultStrategy: 'strategyLabel',
  confirmRemoteWrite: 'confirmRemoteWrite',
  'git.autoInit': 'gitAutoInit',
  'git.autoCommit': 'gitAutoCommit',
  'git.initialCommitMessage': 'gitInitialCommitMessage',
  'git.includeBinaryInFirstCommit': 'gitIncludeBinary',
  localRootPattern: 'localRootPattern',
  baseUrl: 'baseUrl',
  'watch.autoStart': 'watchAutoStart',
  'watch.idleLeaveDocMs': 'watchIdleLeaveDocMs',
  'watch.maxOpenDocs': 'watchMaxOpenDocs',
  'journal.enabled': 'journalEnabled',
  'journal.keepDays': 'journalKeepDays',
  debug: 'debug',
}

/** Locale keys for the conflict-handling choices of `defaultStrategy`. */
const STRATEGY_LABELS: Record<string, OverleafLocaleKey> = {
  'keep-both': 'strategyKeepBoth',
  'keep-local': 'strategyKeepLocal',
  'keep-remote': 'strategyKeepRemote',
  auto: 'strategyAuto',
}

/**
 * Human label of one field.
 *
 * Our own dictionary wins so the page stays in one language: the host sends
 * Chinese `label`s, which would mix languages for an English shell. The host
 * label is still the fallback for a field this build does not know yet.
 */
export function fieldLabel(t: Translate, field: SettingsField): string {
  const key = FIELD_LABELS[field.key]
  if (key !== undefined) return t(key)
  if (typeof field.label === 'string' && field.label.length > 0) return field.label
  return t('unknownField', { key: field.key })
}

/** Human label of one `defaultStrategy` choice. */
export function strategyLabel(t: Translate, choice: string): string {
  const key = STRATEGY_LABELS[choice]
  return key === undefined ? choice : t(key)
}

/** The `defaultStrategy` choices, used when the host does not send `options`. */
export const DEFAULT_STRATEGIES = ['keep-both', 'keep-local', 'keep-remote', 'auto'] as const

const card: React.CSSProperties = {
  border: '1px solid rgba(127, 127, 127, 0.28)',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const cardTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
}

const cardDescription: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  opacity: 0.68,
}

const rowLabel: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const rowDescription: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.62,
  fontWeight: 400,
}

const hint: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.68,
  margin: '2px 0 0',
}

const choiceRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 14,
  fontSize: 13,
}

const choice: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
}

/** One titled block of the settings page. */
export function SectionCard(props: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={cardTitle}>{props.title}</h3>
        <span style={{ flex: 1 }} />
        {props.actions}
      </div>
      {props.description === undefined ? null : <p style={cardDescription}>{props.description}</p>}
      {props.children}
    </section>
  )
}

/** Label + optional description + control. */
export function FieldRow(props: { label: string; description?: string; control: ReactNode; hint?: string }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={rowLabel}>
        {props.label}
        {props.description === undefined ? null : <span style={rowDescription}>{props.description}</span>}
      </span>
      {props.control}
      {props.hint === undefined ? null : <p style={hint}>{props.hint}</p>}
    </div>
  )
}

/** Toggle row; the label lives on the switch itself to keep it clickable. */
export function SwitchRow(props: {
  label: string
  description?: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Switch label={props.label} checked={props.checked} disabled={props.disabled} onChange={props.onChange} />
      {props.description === undefined ? null : <p style={hint}>{props.description}</p>}
    </div>
  )
}

/** Render one configuration field according to its declared type. */
export function FieldControl(props: {
  field: SettingsField
  value: DraftValue
  disabled: boolean
  t: Translate
  onChange: (key: string, next: DraftValue) => void
}): ReactNode {
  const { field, value, disabled, t } = props
  const label = fieldLabel(t, field)

  if (field.type === 'boolean') {
    return (
      <SwitchRow
        label={label}
        description={field.description}
        checked={value === true}
        disabled={disabled}
        onChange={(next) => props.onChange(field.key, next)}
      />
    )
  }

  if (field.type === 'enum') {
    const choices = field.options ?? [...DEFAULT_STRATEGIES]
    return (
      <FieldRow
        label={label}
        description={field.description}
        control={
          <div style={choiceRow} role="radiogroup" aria-label={label}>
            {choices.map((option) => (
              <label key={option} style={choice}>
                <input
                  type="radio"
                  name={field.key}
                  value={option}
                  disabled={disabled}
                  checked={value === option}
                  onChange={() => props.onChange(field.key, option)}
                />
                <span>{strategyLabel(t, option)}</span>
              </label>
            ))}
          </div>
        }
      />
    )
  }

  if (field.type === 'number') {
    return (
      <FieldRow
        label={label}
        description={field.description}
        control={
          <Input
            type="number"
            aria-label={label}
            disabled={disabled}
            value={value === '' ? '' : String(value)}
            min={field.min}
            max={field.max}
            onChange={(event) => {
              const text = event.currentTarget.value
              const parsed = Number(text)
              props.onChange(field.key, text === '' || Number.isNaN(parsed) ? '' : parsed)
            }}
          />
        }
      />
    )
  }

  return (
    <FieldRow
      label={label}
      description={field.description}
      control={
        <Input
          aria-label={label}
          disabled={disabled}
          value={value === '' || typeof value === 'boolean' ? String(value) : String(value)}
          onChange={(event) => props.onChange(field.key, event.currentTarget.value)}
        />
      }
    />
  )
}

/** A small inline notice line. */
export function Hint(props: { tone?: 'info' | 'ok' | 'warn' | 'error'; children: ReactNode }): ReactNode {
  const color =
    props.tone === 'error' ? '#d05252' : props.tone === 'warn' ? '#c08a2e' : props.tone === 'ok' ? '#3f9a63' : 'inherit'
  return (
    <p style={{ ...hint, color, opacity: props.tone === undefined ? 0.68 : 0.95 }} role="status">
      {props.children}
    </p>
  )
}
