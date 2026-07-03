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

## License

MIT — see the `LICENSE` file.
