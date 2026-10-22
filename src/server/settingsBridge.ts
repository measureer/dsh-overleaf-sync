/**
 * Bridge between the GUI form and the DSH Settings service.
 *
 * The plugin config lives in the profile entry (`cordis.patch.yml`). Fields
 * declared `.volatile()` are editable at runtime and are projected by
 * `settings.describe()`; everything else in `Config` is not exposed here.
 *
 * When the Settings service is absent (older host, or a bare `apply()` in a
 * test) the view degrades to read-only values taken from the resolved config.
 */

import { DEFAULTS, EDITABLE_FIELDS, nestPatch, readField, type Config } from '../config.js'
import { ApiError } from './envelope.js'
import type { SettingsFieldView, SettingsView } from './types.js'

/** The slice of `ctx.settings` we rely on. Kept structural so tests can fake it. */
export interface SettingsServiceLike {
  readonly writable?: boolean
  describe(options?: { redactSecrets?: boolean }): SettingsNamespaceLike[]
  update(namespace: string, patch: unknown, expectedRevision?: number): Promise<unknown> | unknown
}

export interface SettingsNamespaceLike {
  ns: string
  value: unknown
  revision: number
  schema?: unknown
  secrets?: unknown[]
}

export interface SettingsBridgeOptions {
  /** Preferred namespace; usually the config entry id (`overleaf-sync`). */
  namespace?: string
  /** Fallbacks tried when the preferred one is not registered. */
  candidates?: string[]
  config: Config
}

/** Distinctive keys used to find our namespace when its id is not what we expect. */
const SNIFF_KEYS = ['localRootPattern', 'defaultStrategy']

export class SettingsBridge {
  private readonly settings?: SettingsServiceLike
  private readonly preferred?: string
  private readonly candidates: string[]
  private readonly config: Config
  private resolvedNamespace?: string | null

  constructor(settings: SettingsServiceLike | undefined, options: SettingsBridgeOptions) {
    this.settings = settings
    this.preferred = options.namespace
    this.candidates = options.candidates ?? ['overleaf-sync', 'dsh-overleaf-sync']
    this.config = options.config
  }

  get available(): boolean {
    return this.settings !== undefined && this.namespace() !== undefined
  }

  /** Namespace id for our config entry, or `undefined` when Settings is absent. */
  namespace(): string | undefined {
    if (this.resolvedNamespace !== undefined) return this.resolvedNamespace ?? undefined
    if (this.settings === undefined) {
      this.resolvedNamespace = null
      return undefined
    }
    let namespaces: SettingsNamespaceLike[]
    try {
      namespaces = this.settings.describe({ redactSecrets: true })
    } catch {
      this.resolvedNamespace = null
      return undefined
    }
    const wanted = [this.preferred, ...this.candidates].filter((entry): entry is string => Boolean(entry))
    for (const id of wanted) {
      const hit = namespaces.find((entry) => entry.ns === id)
      if (hit) {
        this.resolvedNamespace = hit.ns
        return hit.ns
      }
    }
    for (const entry of namespaces) {
      const serialized = safeStringify(entry.schema)
      if (SNIFF_KEYS.some((key) => serialized.includes(key))) {
        this.resolvedNamespace = entry.ns
        return entry.ns
      }
    }
    this.resolvedNamespace = null
    return undefined
  }

  private descriptor(): SettingsNamespaceLike | undefined {
    const ns = this.namespace()
    if (ns === undefined || this.settings === undefined) return undefined
    return this.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === ns)
  }

  /** Current values + revision. Never throws for a missing Settings service. */
  describeView(): SettingsView {
    const descriptor = this.descriptor()
    const writable = descriptor !== undefined && (this.settings?.writable ?? true)
    const fields: SettingsFieldView[] = EDITABLE_FIELDS.map((field) => {
      const raw = descriptor === undefined ? readField(this.config, field.key) : readField(descriptor.value, field.key)
      const view: SettingsFieldView = {
        key: field.key,
        type: field.type,
        value: raw,
        group: field.group,
        description: field.description,
      }
      if (field.label !== undefined) view.label = field.label
      const fallback = readField(DEFAULTS, field.key)
      if (fallback !== undefined) view.default = fallback
      if (field.options !== undefined) view.options = [...field.options]
      if (field.min !== undefined) view.min = field.min
      if (field.max !== undefined) view.max = field.max
      return view
    })
    return { writable, revision: descriptor?.revision ?? 0, fields }
  }

  /**
   * Apply a flat `{ 'git.autoInit': true }` patch through Settings and return
   * the refreshed view. Optimistic concurrency: the caller's revision must
   * still match, otherwise the write is refused with `E_SETTINGS_CONFLICT`.
   */
  async updateView(patch: Record<string, unknown>, expectedRevision?: number): Promise<SettingsView> {
    if (Object.keys(patch).length === 0) return this.describeView()
    const ns = this.namespace()
    if (ns === undefined || this.settings === undefined) {
      throw new ApiError(
        'E_CONFIG',
        'the DSH Settings service is not available in this host, so configuration cannot be edited from the GUI',
        400,
        'edit the profile entry (`dsh plugin --profile <name>`) or the `cordis.patch.yml` config block instead',
      )
    }
    this.validatePatch(patch)
    const nested = nestPatch(patch)
    try {
      await this.settings.update(ns, nested, expectedRevision)
    } catch (err) {
      const code = errorCode(err)
      if (code === 'SETTINGS_CONFLICT' || code === 'E_SETTINGS_CONFLICT') {
        throw new ApiError(
          'E_SETTINGS_CONFLICT',
          'the configuration changed elsewhere while this page was open',
          409,
          'reload the page to pick up the new revision, then apply the change again',
        )
      }
      throw err
    }
    // Force a fresh read: the Loader may have swapped the volatile references.
    this.resolvedNamespace = undefined
    return this.describeView()
  }

  /** Reject unknown keys and values that do not match the declared field type. */
  private validatePatch(patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
      const field = EDITABLE_FIELDS.find((entry) => entry.key === key)
      if (field === undefined) {
        throw new ApiError('E_VALIDATION', `\`${key}\` is not an editable setting`, 400)
      }
      switch (field.type) {
        case 'string':
          if (typeof value !== 'string') throw new ApiError('E_VALIDATION', `\`${key}\` must be a string`, 400)
          break
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new ApiError('E_VALIDATION', `\`${key}\` must be a number`, 400)
          }
          break
        case 'boolean':
          if (typeof value !== 'boolean') throw new ApiError('E_VALIDATION', `\`${key}\` must be a boolean`, 400)
          break
        case 'enum':
          if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
            throw new ApiError('E_VALIDATION', `\`${key}\` must be one of ${(field.options ?? []).join(', ')}`, 400)
          }
          break
      }
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const record = err as { code?: unknown; name?: unknown }
  if (typeof record.code === 'string') return record.code
  if (typeof record.name === 'string') return record.name
  return undefined
}
