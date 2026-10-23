/**
 * dsh-overleaf-sync — Cordis plugin entry.
 *
 * The plugin only registers tools; all policy lives in `service.ts` and all
 * protocol details in `transport/`. Everything is created inside `ctx.effect`,
 * so a hot reload disposes the registrations cleanly.
 */

import type { Context } from '@deepseek-ai/cordis'

import { ConfigSchema, liveConfig, type Config as ResolvedConfig } from './config.js'
import { OverleafSyncService } from './service.js'
import { createOverleafTools } from './tools/index.js'
import { registerOverleafApi } from './server/index.js'

export const name = 'dsh-overleaf-sync'

/** Cordis validates the `config:` block of the profile entry with this schema. */
export const Config = ConfigSchema

export const inject = ['tools']

export function apply(ctx: Context, input?: Partial<ResolvedConfig>): void {
  // `liveConfig` keeps the volatile references: a Settings write patches them in
  // place, and every read below sees the new value without a plugin remount.
  const config = liveConfig(input ?? {})
  const service = new OverleafSyncService(config)

  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      const disposers = createOverleafTools(service, config).map((tool) => sctx.tools.register(tool))
      return () => {
        for (const dispose of disposers.reverse()) dispose()
        // Watch sessions own a socket each: they must not outlive the plugin.
        void service.stopAllWatches()
      }
    })
  })

  // `watch.autoStart` is opt-in. The delayed start keeps plugin loading cheap and
  // gives the host a moment to finish mounting before we open a socket.
  if (config.watch.autoStart) {
    ctx.inject(['tools'], (sctx) => {
      sctx.effect(() => {
        const timer = setTimeout(() => {
          void service
            .watch({ action: 'start' }, { cwd: process.cwd() })
            .catch(() => undefined)
        }, 2000)
        return () => clearTimeout(timer)
      })
    })
  }

  // The GUI half is optional: a host without a web server just never loads it.
  registerOverleafApi(ctx, { service, config, cwd: process.cwd(), namespace: 'overleaf-sync' })
}
