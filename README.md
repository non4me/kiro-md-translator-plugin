# Read Markdown Translator

A Kiro / VS Code extension that opens `.md` files in a rendered preview and translates the
content into any supported language — without leaving the editor.

By default a `.md` file opens as a full rendered preview (no editor). Double-clicking the
preview enters **Edit Mode** (split view: source editor on the left, translated preview on the
right). The file on disk always stays in the **Storage language** (default English); the
**Target language** is an in-memory display transform.

## Features

- Rendered CommonMark + GFM preview (headings, lists, tables, fenced/inline code, links, images).
- Translation in two modes: **on-demand** (a Translate button) and **automatic** (on open / after edits settle).
- Pluggable translation providers: **DeepL**, **Google Translate**, or a custom `https://` endpoint.
- Hover any block to see the reverse translation; edit a paragraph (original ↔ translation auto-sync) and save it back.
- Export the translated document as `{name}.{lang}.md`.
- In-session LRU translation cache (50 entries); code, inline code and URLs are never sent to the translation API.
- API keys stored only in the IDE SecretStorage / OS keychain, per provider (never in workspace config).
- English UI; all configuration lives in the standard VS Code settings page.

## Install

Build the `.vsix` and install it:

```bash
npm install
npm run package          # produces kiro-md-translator-plugin-<version>.vsix
```

Then in the IDE: Extensions → "Install from VSIX…" → select the file (or
`code --install-extension kiro-md-translator-plugin-<version>.vsix`).

## Settings

All settings live in the **standard VS Code settings page** — open it with the command
**"Markdown Translator: Settings"** (`kiro-md-translator.openSettings`) or via Extensions → gear →
Settings (`@ext:VladimirTroyanenko.kiro-md-translator-plugin`). There is no separate settings window.

- **Provider Type** — DeepL, Google, or a custom `https://` endpoint. Its description hosts
  per-provider **Set key** and **Test connection** command links.
- **API keys** — click *Set key* for a provider to enter its key in a masked input box; keys are
  stored only in the OS keychain (per provider), never in `settings.json`. *Test connection* runs a
  live check and reports success/failure as a notification. (Both are also available from the Command
  Palette: "Markdown Translator: Set API Key" / "Test Connection".)
- **Storage / Target Language** — language codes. Storage must be a base code (e.g. `en`); Target may
  be regional (e.g. `en-US`). Leave Target empty to disable translation.
- **Custom Endpoint** — base URL for the custom provider (used only when Provider Type is `custom`).
- **Translation Mode** — `on-demand` (Translate button) or `automatic` (on open / after edits).

## Development

```bash
npm run typecheck    # tsc --noEmit (src/ only)
npm test             # vitest run — unit + property tests
npm run build        # esbuild → out/extension.js + out/webview/*.js
npm run package      # build + vsce package → .vsix
```

Run a single test: `npx vitest run test/<file>.test.ts` or `npx vitest run -t "<name>"`.

The project is **spec-driven**: the authoritative source is
`.kiro/specs/kiro-md-translator-plugin/{requirements.md,design.md,tasks.md}`. Architecture notes,
conventions, and the (important) `vscode`-is-mocked-in-tests detail live in `CLAUDE.md`.
An implementation/verification journal is in `.ai_docs/INDEX.md`.

## Status

Verified: type-check, the unit/property test suite, and esbuild bundling. The mandatory test set
(spec Properties P1–P3, P8–P12 and the data-integrity / memory / reverse-cache units) passes; the
remaining `*`-marked timing/UI/e2e tests in `tasks.md` are optional and not yet implemented. The
extension has been iterated inside a live Kiro host (custom-editor preview, DeepL translation,
native settings); providers are unit-tested against mocked HTTP (no live DeepL/Google calls in CI).

## License

MIT — see the `LICENSE` file.
