/**
 * Host half of the GUI: register `/overleaf/api/*` on the DSH web server.
 *
 * `webServer` and `settings` are optional services — a headless host simply
 * never has them, and the plugin keeps working through tools only.
 */

import type { Context } from '@deepseek-ai/cordis'

import type { Config } from '../config.js'
import type { OverleafSyncService } from '../service.js'
import { createOverleafRoutes, type WebRoute } from './routes.js'
import { SettingsBridge, type SettingsServiceLike } from './settingsBridge.js'

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
 * Register every API route. Returns a disposer so a hot reload removes them
 * (the web server throws on duplicate paths, so this is not optional).
 */
export function registerOverleafApi(ctx: Context, deps: ServerDeps): () => void {
  const disposers: Array<() => void> = []

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const webServer = (sctx as unknown as { webServer?: WebServerLike }).webServer
      if (webServer === undefined) return () => {}
      const settings = new SettingsBridge(readSettings(sctx), {
        config: deps.config,
        ...(deps.namespace === undefined ? {} : { namespace: deps.namespace }),
      })
      const routes = createOverleafRoutes({ ...deps, settings })
      for (const route of routes) disposers.push(webServer.register(route))
      return () => {
        for (const dispose of disposers.splice(0).reverse()) dispose()
      }
    })
  })

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

function readSettings(ctx: Context): SettingsServiceLike | undefined {
  return (ctx as unknown as { settings?: SettingsServiceLike }).settings
}

export { SettingsBridge } from './settingsBridge.js'
export { createOverleafRoutes } from './routes.js'
export type { StatusSummary, ConflictEntry, SettingsView, SettingsFieldView, PathValidation } from './types.js'
