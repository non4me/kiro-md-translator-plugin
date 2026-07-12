# Read Markdown Translator

A Kiro / VS Code extension that opens `.md` files in a rendered preview and translates the
content into any supported language — without leaving the editor.

By default a `.md` file opens as a full rendered preview (no editor). **Double-click** a block to
select it (bringing up its Edit/Comment toolbar); **triple-click** to enter **Edit Mode** (split
view: source editor on the left, translated preview on the right). The file on disk always stays in
the **Storage language** (default English); the **Target language** is an in-memory display transform.

## Features

- Rendered CommonMark + GFM preview (headings, lists, tables, fenced/inline code, links, images).
- **Code syntax highlighting** — fenced code is coloured with a theme you pick (auto-follows the editor's theme, a named theme, or off).
- Translation in two modes: **on-demand** (a Translate button) and **automatic** (on open / after edits settle).
- Pluggable translation providers: **DeepL**, **Google Translate**, a local **Ollama** LLM (offline, keyless), or a custom `https://` endpoint.
- **Bilingual view** — a two-column toggle showing source and translation side by side with paragraph-synced scrolling.
- **Glossary** — do-not-translate terms (product names, identifiers) kept verbatim and never sent to the translation API; add the current selection to it by right-clicking in a Markdown editor → *Exclude Selection from Translation*.
- **Persistent translation memory** — translations are remembered across IDE sessions, so reopening a file does not re-spend API quota on already-translated text.
- **Comments** — annotate a whole block, a selected text fragment, or a span across several blocks, without touching the `.md`. A toolbar by the selection offers **Edit** and **Comment**; comments re-anchor to their text as the original is edited. Keep them in a sidecar file, inline in the `.md`, or as local drafts.
- Hover any block to see the reverse translation; edit a paragraph (original ↔ translation auto-sync) and save it back.
- Export the translated document as `{name}.{lang}.md`.
- Two-tier cache: an in-session LRU (50 entries) over the persistent memory; code, inline code and URLs are never sent to the translation API (only the prose of code comments is, when present).
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
columns, with each paragraph laid out exactly across from its translation (the columns scroll as one).
Hovering a paragraph highlights it and its counterpart in the other column. Click **Single view** to
return. The button is enabled once a Target language is set (a translation is requested automatically if
none exists yet).

### Comments
Add comments without modifying the `.md` file. **Select text** — a word, a fragment, or a span across
several blocks — and a small toolbar appears next to the selection with **Edit** and **Comment**; the
comment highlights exactly what you selected. A marker next to a block shows it already has comments —
hovering it previews the threads, clicking opens a modal to add, edit, or delete.

By default comments are stored in a **sidecar** next to the file (`docs/api.md` →
`docs/api.md.comments.json`) — never inside the Markdown; deleting the last comment removes the sidecar.
Two other stores can be chosen in settings: **inline** (embedded in the `.md` as invisible HTML
comments, stripped from exported files) and **draft** (kept in the extension's own storage, with nothing
written beside the file — for read-only or foreign files). Optional **auto-import** merges comments found
in the other stores when a file is opened, and the **"Import comments"** command moves a whole project's
comments into your chosen store.

Each comment is anchored to its **content**, so editing the original — even while the preview is closed —
re-anchors it. If a commented block is deleted, its comments are shown under **Outdated comments** rather
than lost or moved to the wrong block. Whether you commit a sidecar to git is your call (the extension
adds no `.gitignore` rule).

#### License
MIT — see the `LICENSE` file.
