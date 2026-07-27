import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Webview end-to-end suite: real Chromium, real bundle, real page.
 *
 * Deliberately a SEPARATE config from `vitest.config.ts`, which includes
 * `test/**\/*.test.ts` only — so `npm test` stays a fast unit run and never
 * launches a browser. The `*.e2e.ts` suffix is what keeps the two apart.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/webview/**/*.e2e.ts'],
    // Builds the webview bundle + the production page ONCE per run, before any
    // worker starts (never reads out/webview, which can be stale).
    globalSetup: ['test/e2e/webview/harness.ts'],
    // Real timers run inside the page (HOVER_MS 500, MODAL_MS 1000 …), so a
    // scenario legitimately spends seconds waiting; the hook budget also covers
    // the first Chromium launch.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Each worker owns a browser; a fork keeps that (and the page's module-level
    // state) isolated from the rest of the suite.
    pool: 'forks',
  },
  resolve: {
    alias: {
      // Needed for the same reason as in vitest.config.ts: the harness renders
      // its fixtures with the real MarkdownRenderer, which value-imports
      // `vscode` through src/l10n.ts. The webview bundle itself needs no alias.
      vscode: fileURLToPath(new URL('./test/mocks/vscode.ts', import.meta.url)),
    },
  },
})
