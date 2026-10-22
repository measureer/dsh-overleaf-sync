import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

import en from '../../locale/en.json'
import zhCN from '../../locale/zh-CN.json'

/** Locale namespace of every string this client plugin renders. */
export const NAMESPACE = 'overleaf-sync'

/** One translation key; derived from the shipped dictionaries so both stay in sync. */
export type OverleafLocaleKey = keyof typeof zhCN

// Teach the type system about this plugin's namespace, so `PropsLocale<'overleaf-sync'>`
// hands components a `t` typed against the dictionary keys below.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'overleaf-sync': OverleafLocaleKey
  }
}

/**
 * Dictionaries registered through `ctx.locale.register()`. The `LocaleDictOf`
 * annotation is the guard rail: a key missing from either language is a compile
 * error, and the same files are the source of truth shipped in `locale/*.json`.
 */
export const zh: LocaleDictOf<typeof NAMESPACE> = zhCN
export const enDict: LocaleDictOf<typeof NAMESPACE> = en

export const dictionaries = { zh, en: enDict }
