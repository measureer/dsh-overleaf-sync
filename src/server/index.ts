/**
 * Host half of the GUI: register `/overleaf/api/*` on the DSH web server.
 *
 * `webServer` and `settings` are optional services — a headless host simply
 * never has them, and the plugin keeps working through tools only.
 *
 * Registration goes through two paths on purpose:
 *
 * 1. when `ctx.webServer` is already resolved at `apply()` time it is used
 *    directly (the shape every official plugin uses);
 * 2. otherwise a late `ctx.inject(['webServer'])` scope registers the routes as
 *    soon as the service appears.
 *
 * Both paths write to the diagnostics file, because "the page says the Host
 * half is not ready" and "registration silently failed" look identical from
 * the browser.
 */

import type { Context } from '@deepseek-ai/cordis'

import type { Config } from '../config.js'
import type { OverleafSyncService } from '../service.js'
import { describeError, recordDiagnostic } from './diagnostics.js'
import { createOverleafRoutes, type WebRoute } from './routes.js'
import { SettingsBridge, type SettingsServiceLike } from './settingsBridge.js'
import type { PickDirectoryResult } from './types.js'
import { pickViaWindows, windowsPickerAvailable } from './windowsPicker.js'

export interface ServerDeps {
  service: OverleafSyncService
  config: Config
  cwd: string
  /** Config entry id; the Settings namespace normally equals it. */
  namespace?: string
}

/** The slice of `ctx.webServer` we use. */
export interface WebServerLike {
  register(route: WebRoute): () => void
}

/**
 * The slice of `ctx.directoryPicker` we use (see `@deepseek-ai/dsh-host-directory-picker`).
 *
 * The capability is a discriminated seam: `native` opens one OS chooser on the
 * host display, `browse` only serves listing primitives for an in-app browser.
 */
export interface DirectoryPickerLike {
  capability(): { kind: string; pick?: (signal: AbortSignal) => Promise<string | null> }
}

/** How long the operator may leave the folder dialog open before we give up. */
const PICK_TIMEOUT_MS = 15 * 60_000

/**
 * Turn `ctx.directoryPicker` into the route's chooser.
 *
 * Read lazily on every call so a service that appears after `apply()` still
 * works, and never through a declared `inject` — the picker is optional.
 */
function createDirectoryPicker(ctx: Context): ((probe?: boolean) => Promise<PickDirectoryResult>) | undefined {
  return async (probe = false) => {
    const picker = readService<DirectoryPickerLike>(ctx, 'directoryPicker')
    const capability = picker === undefined ? undefined : safelyCapability(picker)
    try {
      if (capability !== undefined && capability.kind === 'native' && typeof capability.pick === 'function') {
        if (probe) return { kind: 'native', path: null }
        const picked = await capability.pick(AbortSignal.timeout(PICK_TIMEOUT_MS))
        recordDiagnostic('picker-native', { picked: picked !== null })
        return { kind: 'native', path: picked ?? null }
      }
      // The seam was repointed to its in-browser backend (dsh-remote-web does
      // that on desktop so phones can pick folders). That leaves no OS dialog,
      // so on Windows we show our own — the desktop user expects one.
      if (windowsPickerAvailable()) {
        if (probe) return { kind: 'native', path: null }
        const picked = await pickViaWindows(AbortSignal.timeout(PICK_TIMEOUT_MS))
        if (picked !== undefined) {
          recordDiagnostic('picker-windows', { seam: capability?.kind ?? 'missing', picked: picked.path !== null })
          return { kind: 'native', path: picked.path }
        }
        recordDiagnostic('picker-windows-failed', { seam: capability?.kind ?? 'missing' })
      }
      recordDiagnostic('picker-non-native', { kind: capability === undefined ? 'missing' : String(capability.kind) })
      return { kind: capability === undefined ? 'unavailable' : 'browse', path: null }
    } catch (error) {
      recordDiagnostic('picker-failed', { error: describeError(error) })
      throw error
    }
  }
}

/** `capability()` may throw when the service is mid-swap; treat that as unknown. */
function safelyCapability(picker: DirectoryPickerLike): { kind: string; pick?: (signal: AbortSignal) => Promise<string | null> } | undefined {
  try {
    return picker.capability()
  } catch {
    return undefined
  }
}

/**
 * Register every API route. Returns a disposer so a hot reload removes them
 * (the web server throws on duplicate paths, so this is not optional).
 */
export function registerOverleafApi(ctx: Context, deps: ServerDeps): () => void {
  const disposers: Array<() => void> = []
  let registered = false

  const install = (webServer: WebServerLike | undefined, how: 'static' | 'injected' | 'polled'): void => {
    if (webServer === undefined) {
      recordDiagnostic('webServer-missing', { how })
      return
    }
    if (registered) return
    try {
      const settings = new SettingsBridge(readSettings(ctx), {
        config: deps.config,
        ...(deps.namespace === undefined ? {} : { namespace: deps.namespace }),
      })
      const pickDirectory = createDirectoryPicker(ctx)
      const routes = createOverleafRoutes({ ...deps, settings, pickDirectory })
      for (const route of routes) disposers.push(webServer.register(route))
      registered = true
      recordDiagnostic('routes-registered', { how, count: routes.length })
    } catch (error) {
      recordDiagnostic('routes-register-failed', { how, error: describeError(error) })
    }
  }

  const direct = readWebServer(ctx)
  recordDiagnostic('register-overleaf-api', { webServerAtApply: direct !== undefined })
  if (direct !== undefined) {
    ctx.effect(() => {
      install(direct, 'static')
      return () => {
        for (const dispose of disposers.splice(0).reverse()) dispose()
        registered = false
      }
    })
  } else {
    ctx.inject(['webServer'], (sctx) => {
      recordDiagnostic('webServer-inject-fired', {})
      sctx.effect(() => {
        install(readWebServer(sctx), 'injected')
        return () => {
          for (const dispose of disposers.splice(0).reverse()) dispose()
          registered = false
        }
      })
    })
  }

  // Belt and braces: some compositions publish `webServer` from an async
  // bootstrap without ever waking the inject scope above. Watch the service
  // registry for a few seconds and register as soon as it shows up.
  if (!registered) {
    const timer = setInterval(() => {
      if (registered) {
        clearInterval(timer)
        return
      }
      const late = readWebServer(ctx)
      if (late !== undefined) {
        clearInterval(timer)
        install(late, 'polled')
      }
    }, 250)
    timer.unref?.()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
  }

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    registered = false
  }
}

/**
 * Read an optional service without declaring a hard `inject` dependency.
 *
 * Cordis throws on `ctx.<service>` reads for plugins that did not inject the
 * name, so a GUI half that must stay optional cannot touch the property
 * directly. `ctx.get(name)` is the sanctioned escape hatch, and the property
 * read stays as a fallback for hosts where `get` is unavailable.
 */
function readService<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (service: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const value = getter.call(ctx, name)
      if (value !== undefined) return value as T
    } catch {
      // fall through to the property read
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
}

/** `ctx.webServer` without the inject requirement. */
function readWebServer(ctx: Context): WebServerLike | undefined {
  return readService<WebServerLike>(ctx, 'webServer')
}

/** `ctx.settings` without the inject requirement. */
function readSettings(ctx: Context): SettingsServiceLike | undefined {
  return readService<SettingsServiceLike>(ctx, 'settings')
}

export { SettingsBridge } from './settingsBridge.js'
export { createOverleafRoutes } from './routes.js'
export type {
  StatusSummary,
  ConflictEntry,
  SettingsView,
  SettingsFieldView,
  PathValidation,
  PickDirectoryResult,
} from './types.js'
