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
- Pluggable translation providers: **DeepL**, **Google Translate**, a local **Ollama** LLM (offline, keyless), or a custom `https://` endpoint.
- **Bilingual view** — a two-column toggle showing source and translation side by side with paragraph-synced scrolling.
- **Glossary** — do-not-translate terms (product names, identifiers) kept verbatim and never sent to the translation API; add the current selection to it by right-clicking in a Markdown editor → *Exclude Selection from Translation*.
- **Persistent translation memory** — translations are remembered across IDE sessions, so reopening a file does not re-spend API quota on already-translated text.
- **Comments** — annotate any block without touching the `.md`; comments live in a hidden sidecar and re-anchor to their block when the original is edited.
- Hover any block to see the reverse translation; edit a paragraph (original ↔ translation auto-sync) and save it back.
- Export the translated document as `{name}.{lang}.md`.
- Two-tier cache: an in-session LRU (50 entries) over the persistent memory; code, inline code and URLs are never sent to the translation API.
- API keys stored only in the IDE SecretStorage / OS keychain, per provider (never in workspace config).
- English UI; all configuration lives in the standard VS Code settings page.

### Settings
All settings live in the **standard VS Code settings page** — open it with the command
**"Markdown Translator: Settings"** (`kiro-md-translator.openSettings`) or via Extensions → gear →
Settings (`@ext:VladimirTroyanenko.kiro-md-translator-plugin`). There is no separate settings window.

- **Provider Type** — DeepL, Google, Ollama (local), or a custom `https://` endpoint. Its description
  hosts per-provider **Set key** and **Test connection** command links.
- **API keys** — click *Set key* for a provider to enter its key in a masked input box; keys are
  stored only in the OS keychain (per provider), never in `settings.json`. *Test connection* runs a
  live check and reports success/failure as a notification. (Both are also available from the Command
  Palette: "Markdown Translator: Set API Key" / "Test Connection".) **Ollama needs no key.**
- **Storage / Target Language** — language codes. Storage must be a base code (e.g. `en`); Target may
  be regional (e.g. `en-US`). Leave Target empty to disable translation.
- **Custom Endpoint** — base URL for the custom provider (used only when Provider Type is `custom`).
- **Ollama Endpoint / Model** — the local Ollama server URL (default `http://localhost:11434`, `http://`
  allowed) and model (default `llama3.1`, must be pulled locally). Used only when Provider Type is `ollama`.
- **Glossary** — a list of do-not-translate terms. Each is kept verbatim in the output and is never sent
  as translatable text to the provider. To add a term quickly, select it in a Markdown **source editor**
  (Edit Mode), right-click, and choose **Exclude Selection from Translation**.

### Bilingual view
Click **Bilingual** in the preview header to show the source and its translation side by side in two
columns; scrolling one column keeps the other aligned by paragraph. Click **Single view** to return.
The button is enabled once a Target language is set (a translation is requested automatically if none
exists yet).

### Comments
Add comments to any block without modifying the `.md` file. Hover a paragraph and click **Comment**
(next to *Edit*), or click the **💬** indicator that appears next to a block that already has comments —
hovering the indicator previews the thread, clicking it opens a modal to add, edit, or delete comments.

Comments are stored in a hidden sidecar next to the file (`docs/api.md` → `docs/.api.md.comments.json`)
— never inside the Markdown. Whether you commit that sidecar to git is your call (the extension does not
add any `.gitignore` rule). Each comment is anchored to its block's **content**, so editing the original
— even while the preview is closed — re-anchors the comment to the same block. If a commented block is
deleted, its comments are shown under **Outdated comments** rather than lost or moved to the wrong block.

#### License
MIT — see the `LICENSE` file.
