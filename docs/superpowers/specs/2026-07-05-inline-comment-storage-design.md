# Design — Comment storage mode (sidecar vs inline) + settings sectioning

Date: 2026-07-05
Status: approved (pending written-spec review)
Scope: `src/`, `package.json`, `.kiro/specs/kiro-md-translator-plugin/*`

## Problem

Block-anchored comments (req 11) are today persisted **only** in a
`<name>.md.comments.json` sidecar. Users want the option to keep comments **inside
the `.md` itself** so a single file carries its comments (git, sending a file to a
colleague) while staying **invisible** in any ordinary Markdown renderer. The
placement inside the file must itself be user-choosable.

Secondarily, the flat `contributes.configuration` block is split into titled
sections for a readable Settings UI.

## Decisions (locked)

- Inline comments must be **invisible** in normal Markdown renderers (portability,
  not visible footnotes) → carrier is the HTML comment `<!-- … -->`.
- Placement is a **user setting**, default **after-paragraph**.
- **Export strips inline comments** — the exported file is clean output.
- Settings gain a dedicated **Comments** section.
- Config split + comment feature ship as **one spec / one plan** (config split may
  still land as its own first commit for clean attribution).

## Why HTML comments (the load-bearing fact)

`<!-- … -->` parses in mdast as an `html` node, which means:

1. The translation walker only visits `text` nodes → comment payload is **never
   sent to the provider** (same mechanism that excludes code fences / link URLs).
2. `rehype-sanitize` drops it → **invisible in the preview** and in any renderer.
3. `lineMap` is built only from `<p>/<h1-6>/<li>` → the comment gets **no
   paragraph index and does not shift block indices**, so re-anchoring, scroll
   sync, and surgical write-back are unaffected.

A line starting with `<!--` ends the preceding paragraph (CommonMark HTML block
type 2), so an after-paragraph comment never merges into the paragraph's text
node. We still insert it separated by a blank line for clean diffs.

CriticMarkup (`{>>…<<}`) and footnotes were rejected: the former sits inside the
text node (would be translated), the latter renders (visible).

## Settings surface

`contributes.configuration` becomes an array of titled sections. **Property ids are
unchanged** (`kiro-md-translator.*`) — no breaking change to existing user
settings; sectioning is UI-only.

| Section | Properties |
|---|---|
| Provider | `providerType`, `customEndpoint`, `ollamaEndpoint`, `ollamaModel` |
| Languages | `storageLanguage`, `targetLanguage` |
| Translation | `translationMode`, `glossary` |
| Comments | `commentStorage`, `commentPlacement` |

New properties:

- `kiro-md-translator.commentStorage`: enum `"sidecar"` (default) \| `"inline"`.
- `kiro-md-translator.commentPlacement`: enum `"after-paragraph"` (default) \|
  `"end-of-file"`. Description notes it applies only when `commentStorage` is
  `inline`.

Read via two new `SettingsManager` getters (`getCommentStorage`,
`getCommentPlacement`), mirroring the existing getter style, and surfaced through
`PluginConfig`. Section titles go through l10n (`%…%` in `package.nls.json`).

## Storage format

Single carrier token `<!-- rmt:comments … -->`; two layouts.

**end-of-file** — one block at the very end of the file whose body is the same
`CommentsFile` JSON as the sidecar (`version` + `threads` with full anchor).
Re-anchoring logic is byte-for-byte the current logic.

**after-paragraph** (default) — one block per thread, immediately after the thread's
anchored block, separated by blank lines:

```
Paragraph text.

<!-- rmt:comments {"anchor":{"quote":"Paragraph text",…},"comments":[…]} -->

Next paragraph.
```

Primary anchor is physical adjacency; the embedded compact `anchor` (quote/prefix)
lets re-matching recover the thread if the raw `.md` is hand-edited and the block
moves. The `anchoring.ts` engine is reused unchanged.

## Architecture — storage-strategy seam

`CommentsService` keeps all anchoring / live-map / debounce logic. The **location +
format** are extracted behind a backend interface:

```ts
interface CommentBackend {
  // sidecar: ignores source, reads its file; inline: parses threads out of source
  load(source: string): Promise<CommentsFile> | CommentsFile
  // sidecar: writes/removes its file; inline: returns the rewritten .md source
  persist(data: CommentsFile, source: string): Promise<PersistResult>
}
type PersistResult =
  | { kind: 'sidecar' }              // side effect done internally (fs write/remove)
  | { kind: 'inline'; newSource: string }  // caller applies to the open document
```

Three implementations:

- `SidecarBackend` — the current `SidecarIO`-backed read/write/remove.
- `InlineEofBackend` — parse/serialize the single trailing block.
- `InlineAfterBackend` — parse/serialize per-block trailing comments.

**The `.md` is never written via `fs`.** Inline `persist` returns `newSource`; the
actual write goes through an injected `writeSource(newText: string)` callback wired
in `ActivationController` to a `WorkspaceEdit` on the open document — the same
disciplined path as in-place paragraph save (req 7.14), so we never clobber the
document or bypass the editor. Reads use the existing `getDocumentText()`.

`ActivationController` selects the backend from `SettingsManager` at construction
and re-selects on the `commentStorage`/`commentPlacement` settings change.

## Export

`ExportService` (remark-stringify path) strips `html` nodes matching the
`rmt:comments` marker before serialization, so exported files carry no comments.

## Migration on mode change

On `load`, read whichever location the current mode names. When the mode setting
changes for an open document, the next `flush` **re-homes**: write threads to the
new location and clear the old (delete sidecar / strip inline blocks). Threads are
identity-preserving (ids stable), so no comment is lost. This is the trickiest step
and is broken out as its own plan task with dedicated tests.

## Pipeline safety (verified against code)

- Translation: html nodes excluded from the text-node walk — no change needed.
- Display: `rehype-sanitize` already strips comments — invisible.
- Surgical write-back: splices only `[startLine,endLine]` of the target paragraph;
  after-paragraph comment lives on later lines and is preserved.
- lineMap / scroll sync / block indexing: comments are not `<p>/<h>/<li>`, so
  indices are unaffected.

## Spec-first chain (project convention)

This extends req 11. Add new EARS ids (e.g. 11.12–11.14) to `requirements.md`, a
`Validates:` Property to `design.md`, and matching tasks in `tasks.md`, updated
together with the code.

## Testing

- Unit per backend: parse ⇄ serialize round-trip; missing/malformed payload → empty
  store (never throws), matching the sidecar's tolerant parse.
- Property (numRuns 100): a paragraph with an after-paragraph inline comment
  translates and saves in place without corrupting the comment; re-anchoring still
  resolves the thread after edits.
- e2e: add → translate → save → reopen cycle in both placements; mode-change
  migration re-homes comments and removes the old location; export contains no
  comment markers.

## Out of scope / YAGNI

- Visible-footnote comment rendering (explicitly rejected).
- Per-comment author identity / threading UI changes.
- CriticMarkup interop.
