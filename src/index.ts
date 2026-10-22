/**
 * dsh-overleaf-sync — Cordis plugin entry.
 *
 * The plugin only registers tools; all policy lives in `service.ts` and all
 * protocol details in `transport/`. Everything is created inside `ctx.effect`,
 * so a hot reload disposes the registrations cleanly.
 */

import type { Context } from '@deepseek-ai/cordis'

import { ConfigSchema, resolveConfig, type Config as ResolvedConfig } from './config.js'
import { OverleafSyncService } from './service.js'
import { createOverleafTools } from './tools/index.js'

export const name = 'dsh-overleaf-sync'

/** Cordis validates the `config:` block of the profile entry with this schema. */
export const Config = ConfigSchema

export const inject = ['tools']

export function apply(ctx: Context, input?: Partial<ResolvedConfig>): void {
  const config = resolveConfig(input ?? {})
  const service = new OverleafSyncService(config)

  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      const disposers = createOverleafTools(service, config).map((tool) => sctx.tools.register(tool))
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    })
  })
}
