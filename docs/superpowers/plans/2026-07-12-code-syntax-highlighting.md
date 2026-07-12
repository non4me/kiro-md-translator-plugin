# Code syntax highlighting — implementation plan

> Implemented in one pass (user: "делай"). This records the file structure and
> task breakdown for traceability. Spec: `2026-07-12-code-syntax-highlighting-design.md`.
> Spec id chain: requirement 12, Property 28, task 31 (in the gitignored `.kiro` spec).

**Goal:** Colour fenced code blocks in the preview, with a theme chosen in settings
(named theme / auto-follows-editor / off).

**Architecture:** Highlighting runs host-side in the render pipeline (rehype-highlight
before sanitize); the chosen theme is a stylesheet injected into the webview shell and
swapped live on setting change. `auto` ships a light+dark pair scoped under the webview's
`vscode-light` / `vscode-dark` body class, so an editor theme change re-colours via CSS
alone. Webview client bundle is unaffected (stays ~32 KB).

**Tech:** rehype-highlight 7 (lowlight 3 / highlight.js 11), vendored theme CSS strings.

## File structure

- Create `src/highlightThemesData.ts` — curated highlight.js theme CSS, vendored as
  strings (generated from `node_modules/highlight.js/styles` by `scratchpad/gen-themes.mjs`).
- Create `src/highlightThemes.ts` — `codeThemeCss(theme)`: '' for off, verbatim CSS for a
  named theme, a body-class-scoped light+dark pair for auto (with a small selector prefixer).
- Modify `src/types.ts` — `CodeHighlightTheme` type, `PluginConfig.codeHighlightTheme`,
  `ISettingsManager.getCodeHighlightTheme`, `ExtensionMessage` `setCodeTheme`.
- Modify `src/SettingsManager.ts` — `getCodeHighlightTheme()` (+ getConfig field).
- Modify `src/MarkdownRenderer.ts` — rehype-highlight in the pipeline + widened sanitize schema.
- Modify `src/webview/getPreviewHtml.ts` — base code-block CSS + swappable `#code-theme`
  style tag + a `codeThemeCss` parameter.
- Modify `src/webview/previewPanel.ts` — handle `setCodeTheme` (swap the style element).
- Modify `src/ActivationController.ts` — pass the theme CSS into the shell; re-post it on
  settings change.
- Modify `package.json` / `package.nls.json` — the `codeHighlightTheme` setting + Appearance section.

## Tasks (all done)

1. Vendor themes (`highlightThemesData.ts`) + `codeThemeCss` with tests (`highlightThemes.test.ts`).
2. Wire rehype-highlight into the renderer + sanitize schema; tests in `MarkdownRenderer.test.ts`.
3. Setting + type plumbing; test in `SettingsManager.test.ts`.
4. Webview shell theme injection + live swap on setting change.
5. Verify: typecheck, full suite (250 green), build (webview 32 KB), live puppeteer for auto light/dark.
