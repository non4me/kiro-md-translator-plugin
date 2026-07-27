# Read Markdown Translator

A Kiro / VS Code extension that opens `.md` files in a rendered preview and translates the
content into any supported language — without leaving the editor.

By default a `.md` file opens as a full rendered preview (no editor). **Double-click** a block to
select it (bringing up its Edit / Comment / Ask AI toolbar); **triple-click** to enter **Edit Mode** (split
view: source editor on the left, translated preview on the right). The file on disk always stays in
the **Storage language** (default English); the **Target language** is an in-memory display transform.

## Features

- Rendered CommonMark + GFM preview (headings, lists, tables, fenced/inline code, links, images).
- **Code syntax highlighting** — fenced code is coloured with a theme you pick (auto-follows the editor's theme, a named theme, or off).
- Translation in two modes: **on-demand** (a Translate button) and **automatic** (on open / after edits settle).
- Pluggable translation providers: **DeepL**, **Google Translate**, a local **Ollama** LLM (offline, keyless), or a custom `https://` endpoint.
- **Bilingual view** — a two-column toggle showing source and translation side by side with paragraph-synced scrolling.
- **AI Assistant** — ask a model about the fragment you selected: explain it, discuss it, have it rewrite the text, or keep the conversation as a comment. Off by default; see [AI Assistant](#ai-assistant).
- **In-document search** (`Ctrl+F` / `Cmd+F`) — a find bar over the displayed text: every match is highlighted at once with an `i/N` counter, `Enter` / `Shift+Enter` (or ↓ / ↑) step through them, `Esc` closes. Searches both columns in bilingual view.
- **Glossary** — do-not-translate terms (product names, identifiers) kept verbatim and never sent to the translation API; add the current selection to it by right-clicking — in the preview itself or in a Markdown source editor — and choosing *Markdown Translator: Exclude Selection from Translation*.
- **Translated code comments** — prose inside code comments is translated, while the code itself is never sent to the translation provider and never altered.
- **Persistent translation memory** — translations are remembered across IDE sessions, so reopening a file does not re-spend API quota on already-translated text.
- **Comments** — annotate a whole block, a selected text fragment, or a span across several blocks, without touching the `.md`. A toolbar by the selection offers **Edit**, **Comment** and **Ask AI**; comments re-anchor to their text as the original is edited. Keep them in a sidecar file, inline in the `.md`, or as local drafts.
- Hover any block to see the reverse translation; edit a paragraph (original ↔ translation auto-sync) and save it back.
- Export the translated document as `{name}.{lang}.md` — run **"Save Translation"** from the Command Palette (this is the one command without the `Markdown Translator:` prefix) and pick where to save. A Target language must be set.
- Translate and Bilingual are also icons in the editor tab title bar and Command Palette commands — **"Markdown Translator: Toggle Translation"** and **"Markdown Translator: Toggle Bilingual View"** — shown only for the active preview and hidden while a required setting is missing.
- Two-tier cache: an in-session LRU (50 entries) over the persistent memory; code, inline code and URLs are never sent to the translation API (only the prose of code comments is, when present).
- API keys stored only in the IDE SecretStorage / OS keychain, per provider (never in workspace config).
- English UI; all configuration lives in the standard VS Code settings page.

### Settings
All settings live in the **standard VS Code settings page** — open it with the command
**"Markdown Translator: Settings"** (`kiro-md-translator.openSettings`) or via Extensions → gear →
Settings (`@ext:VladimirTroyanenko.kiro-md-translator-plugin`). There is no separate settings window.
They are grouped exactly as below.

**Provider**
- **Provider Type** — DeepL, Google, Ollama (local), or a custom `https://` endpoint. Its description
  hosts per-provider **Set key** and **Test connection** command links.

**Provider settings**
- **API keys** — click *Set key* for a provider to enter its key in a masked input box; keys are
  stored only in the OS keychain (per provider), never in `settings.json`. *Test connection* runs a
  live check and reports success/failure as a notification. (Both are also available from the Command
  Palette: **"Markdown Translator: Set API Key"** / **"Markdown Translator: Test Connection"**.)
  **Ollama needs no key.**
- **Ollama Endpoint / Model** — the local Ollama server URL (default `http://localhost:11434`, `http://`
  allowed) and model (default `llama3.1`, must be pulled locally). Used only when Provider Type is `ollama`.
- **Custom Endpoint** — base URL for the custom provider (used only when Provider Type is `custom`).

**Languages**
- **Storage / Target Language** — language codes. Storage must be a base code (e.g. `en`); Target may
  be regional (e.g. `en-US`). Leave Target empty to disable translation.

**Translation**
- **Translation Mode** — `on-demand` (default: translate when you click **Translate**) or `automatic`
  (translate on open and on every edit).
- **Glossary** — a list of do-not-translate terms. Each is kept verbatim in the output and is never sent
  as translatable text to the provider. To add a term quickly, select it — in the preview or in a
  Markdown source editor — right-click, and choose **Exclude Selection from Translation**. In the
  preview the item appears only while the source is shown, because the Glossary is a storage-language list.

**Comments**
- **Comments Enabled** — on by default. Turning it off hides the per-block comment control: comments can
  no longer be added or opened, while the edit (pencil) control is unaffected. Existing comments are kept.
- **Comment Storage** — `sidecar` (default, a separate file), `inline` (inside the `.md`) or `draft`
  (the editor's own storage). See [Comments](#comments).
- **Comment Placement** — where inline comments are written: `after-paragraph` (default) or
  `end-of-file`. Applies only when Comment Storage is `inline`.
- **Comment Auto Import** — on by default; when a document is opened, comments found in the other
  storages are moved into the selected one. With `inline` storage this modifies and saves the `.md` itself.

**AI Assistant** — the on/off switch, provider, model, Ollama endpoint, system prompt and the
translation-provider reuse flag. All six are described in [AI Assistant](#ai-assistant).

**Appearance**
- **Code Highlight Theme** — `auto` (default: follow the editor's light/dark theme), `off` (plain
  monospaced code), or a named theme: github-dark, github-light, monokai, nord, atom-one-dark,
  dracula, solarized-light. Switching it re-colours the preview instantly; no document is modified.

### Bilingual view
Click **Bilingual** in the preview header to show the source and its translation side by side in two
columns, with each paragraph laid out exactly across from its translation (the columns scroll as one).
Hovering a paragraph highlights it and its counterpart in the other column. Click **Single view** to
return. The button is enabled once a Target language is set (a translation is requested automatically if
none exists yet).

### Comments
Add comments without modifying the `.md` file. **Select text** — a word, a fragment, or a span across
several blocks — and a small toolbar appears next to the selection with **Edit**, **Comment** and
(when the AI Assistant is enabled) **Ask AI**; the comment highlights exactly what you selected. A
marker next to a block shows it already has comments — hovering it previews the threads, clicking
opens a modal to add, edit, or delete.

By default comments are stored in a **sidecar** next to the file (`docs/api.md` →
`docs/api.md.comments.json`) — never inside the Markdown; deleting the last comment removes the sidecar.
Two other stores can be chosen in settings: **inline** (embedded in the `.md` as invisible HTML
comments, placed after each paragraph or collected at end-of-file, and stripped from exported files) and
**draft** (kept in the extension's own storage, with nothing written beside the file — for read-only or
foreign files). Optional **auto-import** merges comments found in the other stores when a file is opened,
and the **"Markdown Translator: Import Comments into the Current Storage"** command moves a whole
project's comments into your chosen store.

Each comment is anchored to its **content**, so editing the original — even while the preview is closed —
re-anchors it. If a commented block is deleted, its comments are shown under **Outdated comments** rather
than lost or moved to the wrong block. Whether you commit a sidecar to git is your call (the extension
adds no `.gitignore` rule).

### AI Assistant
Select text in the preview — a word, a paragraph, or a span across several blocks — and click
**Ask AI** in the selection toolbar. A chat opens over the document. The model is given what you
highlighted, the source of the blocks it touches, the headings above it, the document itself, and any
comments already attached to that block; it answers as it types, and you can keep asking follow-up
questions in the same conversation. A document too large to send whole is trimmed to the selection and
its surroundings rather than refused. Closing the dialog discards the conversation — nothing is stored.

Two actions turn a reply into something durable:

- **Apply Changes** appears when the model proposes a replacement for your fragment. It opens the usual
  paragraph-edit dialog pre-filled with the suggestion in the file's storage language, so you review and
  save it yourself — nothing is written behind your back — and the chat stays open so you can iterate.
- **Save Summary** (available once the assistant has replied) asks it to condense the discussion into a
  short note and saves that as a comment on the block you selected, in whichever comment store you use.

**Turning it on.** The assistant is **off by default**. Tick **Enabled** in the AI Assistant settings
section; while it is off the Ask AI button is hidden and no chat request is ever sent.

**Providers.** Five, set by **Provider**:

| Provider | API key | Notes |
| --- | --- | --- |
| **Ollama** | not needed | Local server, offline. **Endpoint** defaults to `http://localhost:11434`, **Model** to `llama3.1`. |
| **OpenAI** | required | **Model** defaults to `gpt-4o-mini`. |
| **Anthropic** | required | **Model** defaults to `claude-3-5-sonnet-latest`. |
| **Google Gemini** | required | **Model** defaults to `gemini-1.5-flash`. |
| **GitHub Copilot Chat** | not needed | Real VS Code only; uses the Copilot you already have. **Model** is a Copilot model family, `claude-sonnet-4.5` by default, falling back to any Copilot model your account can use. |

If you never pick one, the effective default depends on the editor: real **VS Code** uses GitHub
Copilot Chat, every other host (Kiro, Cursor, VSCodium…) uses Ollama — even though the settings page
shows `ollama` as the declared default. Keys are entered with **"Markdown Translator: Set AI Assistant
API Key"** and verified with **"Markdown Translator: Test AI Assistant Connection"** (both are also
links in the Provider description). AI Assistant keys live in the OS keychain, separate from the
translation keys. Two more settings: **System Prompt** (empty uses the built-in documentation-assistant
prompt) and **Reuse Translation Provider** (on by default — when both the assistant and translation are
set to Ollama, the assistant borrows the translation endpoint and model, so you configure Ollama once).

**Privacy — read this before picking a provider.** Every chat turn sends the model your selection, the
source of the blocks it covers, the document (or its trimmed context) and the comments anchored to that
block. With **OpenAI**, **Anthropic** or **Google Gemini** all of that leaves your machine and goes to
that company's API. **Ollama** keeps it on your machine, and **GitHub Copilot Chat** goes through the
Copilot service that already handles chat in your editor rather than an additional third party.

**GitHub Copilot has to grant access first.** VS Code only lets an extension see Copilot models after
you have allowed it, and that consent can only be requested from something you started. Until then the
assistant reports that no Copilot chat model is available — meaning either Copilot is not installed and
signed in, or it has not granted access yet. Run **"Markdown Translator: Test AI Assistant Connection"**
once from the Command Palette, approve the prompt, and try again; if access was already granted, reload
the window.

#### License
MIT — see the `LICENSE` file.
