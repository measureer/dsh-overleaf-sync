import { defineConfig } from 'tsdown'

/**
 * Browser-half bundle for the DSH web client.
 *
 * The output must look exactly like what the DSH client runtime expects:
 *
 * ```js
 * window.__ModuleLoader__.load({ id: "…", factory: (require) => { … return module.exports; } });
 * ```
 *
 * This is the same contract the shipped `@deepseek-ai/dsh-client-*` packages use
 * (see `packages/client/tsdown.client.ts` in the harness checkout): CJS code
 * wrapped in a `factory` that receives the runtime's `require`, with `module` /
 * `exports` provided by the `intro` line so the emitted CJS body works unchanged.
 */

/** Client plugin id: the module id the runtime registers the factory under. */
const CLIENT_ID = 'dsh-overleaf-sync'

/**
 * Modules the DSH web runtime provides to every client plugin.
 *
 * Keep this list in sync with `docs/client-ui-notes.md`; React (and its JSX
 * runtime) must never be bundled here, and the `@deepseek-ai/dsh-client-*`
 * packages are shared singletons of the host application.
 */
const EXTERNAL_MODULES: readonly RegExp[] = [
  /^react$/,
  /^react\//,
  /^react-dom$/,
  /^react-dom\//,
  /^cordis$/,
  /^@deepseek-ai\/cordis$/,
  /^@deepseek-ai\/dsh-client-/,
]

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // The host half is built by `tsc` into the same directory; never clean it.
  clean: false,
  dts: false,
  sourcemap: false,
  deps: {
    // Everything the runtime injects stays a live `require()`; everything else
    // (our own sources) is inlined.
    neverBundle: EXTERNAL_MODULES,
    onlyBundle: false,
  },
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    banner: (chunk) =>
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, ` +
      `${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
