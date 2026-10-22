import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'

import { dictionaries, NAMESPACE } from './locale'
import { OverleafSettingsSection } from './panel'

/**
 * Services this client plugin needs before it can mount.
 *
 * `slots` is provided by the DSH UI renderer (it types the augmentation in
 * `@deepseek-ai/dsh-client-ui-renderer`, a package this plugin deliberately does
 * not depend on); `locale` is the dictionary service used for every string.
 */
export const inject = ['slots', 'locale'] as const

/**
 * The slice of the renderer's `SlotRegistry` this plugin uses.
 *
 * `register` is the registry's typed face; `inject` installs the registration
 * only while the slot declaration exists, which tolerates the settings page
 * being declared after (or collapsed and re-declared later).
 */
export interface SlotService {
  readonly register: SlotCore['register']
  inject(key: keyof SlotMap & string, callback: () => (() => void) | Iterable<() => void>): () => void
}

function slotService(ctx: Context): SlotService | undefined {
  // `ctx.slots` is declared by the renderer, which we do not import; one local
  // cast keeps the whole plugin free of a dependency on it.
  return (ctx as Context & { slots?: SlotService }).slots
}

/**
 * Register the Overleaf Sync settings section.
 *
 * @param ctx - plugin context (with `slots` and `locale` injected).
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NAMESPACE)

  // Dictionaries travel with the bundle, so the label thunk can run before the
  // slot is declared.
  ctx.effect(() => ctx.locale.register(NAMESPACE, dictionaries), 'overleaf-sync: locale dictionaries')

  const slots = slotService(ctx)
  if (slots === undefined) {
    // Degrade instead of throwing: the host half keeps working without the page.
    console.warn('[overleaf-sync] slots service unavailable; the settings section was not mounted')
    return
  }

  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'overleaf-sync',
        order: 120,
        label: () => t('nav'),
        locale: NAMESPACE,
      },
      OverleafSettingsSection,
    ),
  )
}
