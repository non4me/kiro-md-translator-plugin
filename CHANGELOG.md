# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [0.6.2] — 2026-07-10

### Fixed

- **Find bar keeps focus while typing.** `window.find` moves focus into the matched content, so
  after the first character the search input lost focus and you couldn't keep typing. Focus is now
  restored to the input synchronously after each search; the match highlight (a document selection,
  independent of input focus) stays visible. (req 1.8)

## [0.6.1] — 2026-07-10

### Fixed

- **In-document search now works in Kiro.** The native find widget shipped in 0.6.0 relies on
  Electron's `findInPage`, which is inert in Code OSS builds (Kiro) — the widget opened but never
  matched. Replaced it with a small webview-local find bar driven by `window.find`: `Ctrl+F` /
  `Cmd+F` opens it, `Enter` / `Shift+Enter` (or ↓ / ↑) step through matches with scroll-to, `Esc`
  closes, and "No results" shows when nothing matches. Searches the displayed text (both columns in
  bilingual view); no translation calls, no host↔webview protocol change. (req 1.8)

## [0.6.0] — 2026-07-10

### Added

- **In-document search (Ctrl+F).** The rendered preview enables VS Code's native find widget to
  search the displayed text. *(Superseded by 0.6.1 — the native widget does not function in Code OSS
  builds such as Kiro.)* (req 1.8)

## [0.5.9] — 2026-07-06

### Changed

- **Toolbar polish.** The preview toolbar strip is thinner (2px/6px padding), the Translate / Bilingual
  icons are larger (20px) and rest at half opacity. The per-block edit / comment gutter icons stay
  hidden until the block is hovered and then appear dimmed (.5), including the persistent
  has‑comments indicator.

## [0.5.8] — 2026-07-06

### Changed

- **Custom toolbar icons.** The title-bar and preview toolbar now use a hand-drawn dictionary‑book
  glyph with 文A for Translate (and split columns for Bilingual) instead of the generic codicons, so the
  actions read as translation at a glance. Title-bar icons ship as light/dark SVGs (`media/`).

## [0.5.7] — 2026-07-06

### Added

- **Translate / Bilingual actions in the editor title bar.** The two toolbar actions now also appear as
  icons in the native editor tab title bar (next to split / …), shown only for the active preview and
  hidden when required settings are missing. They toggle the same as the in-preview buttons.

### Changed

- **Preview toolbar buttons are now outline icons, right-aligned.** The Translate / Bilingual buttons in
  the preview strip switched from bordered text to outline icon buttons (matching the per-block gutter
  icons), aligned to the right edge; the text label moved to the tooltip. Both placements are available
  so you can pick the one you prefer.

## [0.5.6] — 2026-07-06

### Fixed

- **Header no longer overlaps the content on scroll.** The sticky toolbar (Translate / Bilingual, or
  the settings link) had no stacking order, so the relatively-positioned content blocks scrolled over
  it and the text showed through. The header now has a `z-index`, so content slides cleanly behind its
  opaque background (still below the hover tooltip and modals).

## [0.5.5] — 2026-07-06

### Added

- **Comments can be turned off.** A new `kiro-md-translator.commentsEnabled` setting (on by default) hides
  the per-block comment icon when disabled — comments can no longer be added or opened, while the
  paragraph edit (pencil) control stays. Existing comments in the file or sidecar are kept, just not
  shown; toggling the setting takes effect immediately without reopening the preview.

### Changed

- **Settings link opens the Workspace tab.** When a folder is open, the "open settings" action (command
  palette and the missing-settings link) now lands on the Workspace settings tab, where a project's
  `.vscode/settings.json` values live; it falls back to User settings when no folder is open.

[0.5.5]: #055--2026-07-06

## [0.5.4] — 2026-07-06

### Added

- **Settings link instead of dead buttons.** When a required setting is missing — no Target Language,
  or no API key for a provider that needs one (DeepL, Google; Ollama is keyless and Custom treats the
  key as optional) — the header now shows a clickable message naming exactly what is missing (the target
  language and/or the API key) that opens the extension settings, in place of the disabled Translate /
  Bilingual buttons. The hint clears the moment the missing setting is provided, including an API key
  saved via the command (which lives in the keychain, outside the settings-change event).

[0.5.4]: #054--2026-07-06

## [0.4.10] — 2026-07-05

### Changed

- **Comment sidecar renamed and cleaned up.** The per-file comment store is now `<name>.comments.json`
  (previously the dot-prefixed `.<name>.comments.json`). Deleting the last comment on a file now removes
  the sidecar entirely instead of leaving an empty one behind.

[0.4.10]: #0410--2026-07-05

## [0.4.9] — 2026-07-05

### Fixed

- **Edit/comment icons now appear on list items and other indented blocks too.** In 0.4.7 the icons
  were limited to top-level paragraphs/headings to avoid landing on list bullets. They are now shown for
  every block (list items, block-quote paragraphs included) and aligned into the same left gutter
  regardless of the block's indentation, so they never overlap a bullet or number. A loose list still
  shows a single set of icons per item.

[0.4.9]: #049--2026-07-05

## [0.4.8] — 2026-07-05

### Changed

- **Gutter icons appear on hover.** The per-paragraph edit and comment icons are now shown only while
  the pointer is over the paragraph. The one exception: a paragraph that already has comments keeps its
  comment icon visible at all times, drawn **filled** (solid) to mark it — hovering the paragraph then
  also reveals the pencil.

[0.4.8]: #048--2026-07-05

## [0.4.7] — 2026-07-05

### Changed

- **Edit and comment moved to per-paragraph gutter icons, in both views.** Each top-level paragraph and
  heading now shows a compact column of two outline icons in the left gutter — a pencil (opens the paragraph-edit dialog)
  and a speech bubble (hover to preview the comment thread, click to add / edit / delete comments). A
  paragraph that already has comments keeps its bubble marked with the count (this replaces the old 💬
  indicator). The hover tooltip is now translation-only. This also makes edit and comment reachable in
  the bilingual view, which suppresses the tooltip and previously had no way to reach them.

[0.4.7]: #047--2026-07-05

## [0.4.6] — 2026-07-05

### Fixed

- Bilingual pair highlight: the left accent bar no longer overlaps the first characters of the
  paragraph. It is now drawn in the column's left padding, just to the left of the text.

[0.4.6]: #046--2026-07-05

## [0.4.5] — 2026-07-04

### Changed

- **Bilingual view: exact paragraph alignment.** The two columns are now laid out in a single grid
  where each source/translation block pair is one row sized to the taller side, so every paragraph sits
  exactly across from its translation at any scroll position. This replaces the previous two
  independently scrolling columns (which only kept the topmost paragraph aligned and drifted further
  down the page); the view now scrolls as one (req 10.3, 10.4).

[0.4.5]: #045--2026-07-04

## [0.4.4] — 2026-07-04

### Added

- **Bilingual view: linked paragraph highlight.** Hovering a paragraph in either column now highlights
  that block *and* its counterpart (the matching translation) in the opposite column, so it is obvious
  which source paragraph maps to which translation. The pair is tinted and marked with a left accent
  bar. Highlight-only — it adds no tooltip and makes no translation request, reusing the shared
  `data-paragraph-index` that already drives the two-column scroll sync (req 10.7).

[0.4.4]: #044--2026-07-04

## [0.4.3] — 2026-07-04

### Added

- **Exclude selection from translation — now in the preview's right-click menu.** While viewing the
  source, select text in the rendered preview, right-click, and choose **Exclude from translation** to
  add it to the Glossary. The item is contributed to the webview's native context menu (via
  `webview/context` + `data-vscode-context`), so it sits alongside Copy/Paste. It appears only on the
  source view, since the Glossary is a storage-language list. The editor context menu added in 0.4.1 only
  appeared in a Markdown source editor (the preview is a custom editor, where that menu does not apply);
  this adds the action to the preview itself, which is the main surface.

[0.4.3]: #043--2026-07-04

## [0.4.2] — 2026-07-04

### Security

- Harden comment-sidecar parsing against untrusted input. A hand-crafted `.<name>.comments.json`
  (e.g. committed in an untrusted repository) whose anchor omitted `prefix`/`suffix`/`hintLine` could
  throw a `TypeError` during re-anchoring when a block had two or more matching candidates, breaking
  the comment layer for that document. Anchor fields are now coerced to safe types on load,
  `diceSimilarity` ignores non-string input, and re-anchoring failures can no longer surface into the
  preview. No code execution, secret, or file exposure was possible — the impact was a feature-level
  denial of service.

[0.4.2]: #042--2026-07-04

## [0.4.1] — 2026-07-04

### Added

- **Exclude selection from translation.** Select text in a Markdown source editor, right-click, and
  choose **"Markdown Translator: Exclude Selection from Translation"** to add it to the Glossary
  do-not-translate list. The term is masked in all future translations and the cache re-anchors
  automatically.

### Fixed

- Opening and closing a preview no longer creates an empty `.<name>.comments.json` sidecar next to the
  file — the sidecar is written only once a comment actually exists. Comment sidecars are also excluded
  from the packaged extension.

[0.4.1]: #041--2026-07-04

## [0.4.0] — 2026-07-04

### Added

- **Comments on paragraphs.** Leave comments on any block (paragraph, heading, list item) without
  touching the `.md` file — they are stored in a hidden sidecar `.<name>.comments.json` next to it.
  A 💬 indicator marks commented blocks; hovering it previews the thread, clicking it opens a modal to
  add / edit / delete comments. A **Comment** action also sits next to **Edit** in the paragraph hover
  tooltip. Multiple comments per block (threads) are supported, each with created/updated timestamps.
- **Comment anchoring that survives edits.** Each comment is anchored to its block's *content*, not a
  line number, so edits to the original — including edits made while the preview is closed — re-anchor
  the comment to the same block (exact → whitespace-normalized → fuzzy ≥ 0.7 with surrounding-context
  disambiguation). When a block is removed, its comments are surfaced as **outdated** rather than
  silently deleted or re-attached to the wrong block.

[0.4.0]: #040--2026-07-04

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
