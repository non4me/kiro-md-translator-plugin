# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] — 2026-07-04

### Added

- **Local LLM provider (Ollama).** A new `ollama` provider translates via a local Ollama server
  (`ollamaEndpoint`, default `http://localhost:11434`) using `ollamaModel` (default `llama3.1`).
  Keyless and offline; `http://` is allowed for localhost. Uses `/api/chat` with `format: json`.
- **Bilingual two-column view.** A **Bilingual** header toggle shows the source and its translation
  side by side with paragraph-synced scrolling (reusing the shared `data-paragraph-index`). No extra
  API call — it reuses the already-rendered source/translation. Hover tooltips are suppressed while
  bilingual (both languages are already visible).
- **Glossary (do-not-translate terms).** A `glossary` setting lists terms (product names, identifiers)
  that are masked before the provider call and restored verbatim afterwards, so they are never sent as
  translatable text and never mistranslated.
- **Persistent translation memory.** Translations are now remembered across IDE sessions via a
  second-tier LRU (≤ 2000) backed by `globalState`, layered under the in-session 50-entry cache.
  Reopening a file no longer re-spends API quota on already-translated text.

### Changed

- The translation cache is now two-tier (L1 in-memory ≤ 50 over L2 persistent memory). A change to the
  storage language, provider (or its endpoint/model), or glossary invalidates BOTH tiers, since the
  `[text, lang]` key does not distinguish them; a target-language change alone is safe (different key).

[0.3.0]: #030--2026-07-04

## [0.2.4] — 2026-07-02

### Fixed

- Publisher id corrected to the exact account case **`VladimirTroyanenko`** (was
  `vladimirtroyanenko`); the extension id / `@ext:` filter were updated to match.
- Edit-paragraph modal: the **Target** field was blank for any paragraph with inline markup
  (code/emphasis/links), because the full-document translate caches per text-node segment, not per
  whole paragraph. The modal now translates the paragraph on a cache miss (as hover does) and fills
  Target once ready.

[0.2.4]: #024--2026-07-02

## [0.2.3] — 2026-07-02

### Changed

- Display name changed to **Read Markdown Translator** (`displayName` + settings section title).
  Internal ids (config section `kiro-md-translator`, command ids, view type) are unchanged, so
  existing user settings are preserved.
- `publisher` set to `VladimirTroyanenko` (was a build-time placeholder); the extension id is now
  `VladimirTroyanenko.kiro-md-translator-plugin`. The `openSettings` `@ext:` filter, README and
  LICENSE were updated to match. (Fixes the VS Marketplace upload error "Value cannot be null.
  Parameter name: v1", which was caused by the manifest publisher not matching the account.)

### Added

- `npm run publish:vsce` and `npm run publish:ovsx` scripts, plus a `/publish` skill that builds
  one `.vsix` and ships it to BOTH the VS Marketplace and Open VSX (same publisher on each).

[0.2.3]: #023--2026-07-02

## [0.2.2] — 2026-07-02

### Added

- Extension icon (128×128, `media/icon.png`) — a translation motif (文 → A) shown in the
  Extensions list and marketplace.

[0.2.2]: #022--2026-07-02

## [0.2.1] — 2026-07-02

### Fixed

- Cold-start race: in automatic mode the at-open translation could build a provider with an
  unloaded (empty) API key and fail with a spurious error; it now waits for the keychain read to
  complete before the first translation.

[0.2.1]: #021--2026-07-02

## [0.2.0] — 2026-07-02

### Changed

- **Settings moved to the native VS Code settings page.** The custom settings webview is gone.
  Provider, languages, mode and custom endpoint are standard settings; each provider has **Set key**
  and **Test connection** command links in the Provider Type description. The palette command
  "Markdown Translator: Settings" now reveals the native page.
- API keys are stored **per provider** in the OS keychain; a pre-existing single key is migrated
  into the active provider's slot on first run.

### Fixed (live-host iterations 0.1.1 – 0.1.10)

- Custom-editor override diagnosis, settings API-key plumbing, DeepL bodyless-GET `Content-Type` and
  regional `source_lang` (400s), English-only UI, Translate⇄Original toggle + sticky tooltip,
  render/display coordination, cache invalidation, edit-modal `display:none`, multi-preview settings
  broadcast, and blank-preview-after-double-click (`retainContextWhenHidden`).

### Removed

- Custom settings webview (`SettingsWebviewProvider`, `settingsPage`, `getSettingsHtml`), the
  form-validation module, and the `vscode.l10n` ru/en bundles.

[0.2.0]: #020--2026-07-02

## [0.1.0] — 2026-06-24

Initial implementation of the spec
`.kiro/specs/kiro-md-translator-plugin` (extension-host layer complete; optional
`*`-marked timing/UI/e2e tests deferred).

### Added

- Rendered Markdown preview via a `CustomTextEditorProvider` (CommonMark + GFM), with
  `data-paragraph-index` annotations and a source `lineMap` for element-level scroll sync.
- Translation engine: AST-level text extraction (code / inline code / URLs excluded),
  in-session LRU cache (50 entries, structured collision-safe key), structure-preserving
  re-insertion, display via mdast→hast→HTML (no markdown round-trip), and surgical
  single-paragraph write-back.
- Providers: DeepL, Google Translate (128-segment batching), and a custom `https://`
  endpoint with URL validation; provider-agnostic factory.
- On-demand and automatic translation modes; hover reverse-translation (known source served
  without an API call); paragraph edit modal with bidirectional auto-sync.
- Export translated content as `{name}.{lang}.md`.
- Settings webview: provider/API-key/endpoint/language/mode, "Test connection",
  empty-key and non-https-endpoint save gates, provider-switch language check, custom-endpoint
  consent. API key persisted only in SecretStorage.
- Localization via `vscode.l10n` with ru / en bundles.
- Memory monitor over plugin-owned structures (warn above 150 MB).

### Tooling

- TypeScript (strict), esbuild bundling (extension host `cjs` + webview `iife`, < 50 KB),
  Vitest + fast-check tests with a hand-written `vscode` mock, `vsce` packaging.

[0.1.0]: #010--2026-06-24
