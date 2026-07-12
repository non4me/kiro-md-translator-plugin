# Design — Draft comment storage + import (auto & bulk)

Date: 2026-07-12
Status: approved
Scope: `src/`, `package.json`, `l10n/`, `.kiro/specs/kiro-md-translator-plugin/*`
Extends: `2026-07-05-inline-comment-storage-design.md` (req 11)

## Problem

Comments (req 11) can be stored in two places today: a `<name>.md.comments.json`
sidecar, or invisibly inside the `.md` itself. **Both write to disk next to the
document.** Two consequences:

1. There is no way to annotate a document you cannot or do not want to touch —
   a dependency's docs, a cloned foreign repo, a file from git history, a
   read-only or virtual filesystem. The comment layer simply does not work there.
2. Switching the storage setting only re-homes the comments of **currently open**
   documents. Everything else keeps its comments in the old location, and the next
   open reads only the new location — the comments look lost (the file on disk is
   intact, but nothing surfaces it).

## Decisions (locked)

- Add a **third storage: `draft`** — comments live in the extension's own storage,
  nothing is written next to the document, and the `.md` is never modified.
- Primary use: **working notes while reading/translating**. Durability
  expectations are correspondingly modest (see *Known limits*).
- Drafts **survive an editor restart** (they are not session-scoped).
- Location: a JSON file per document under the extension's global storage, in the
  **same format as the sidecar**.
- **Auto-import on open** (new setting, default ON): read all three stores, merge,
  move everything into the currently selected storage — **including editing the
  `.md`** when the selected storage is inline. The user accepted the trade-off
  explicitly (see *Accepted risk*).
- **Bulk import command**, surfaced as an action link at the end of the Comments
  settings section: walk every `.md` in the project, move comments into the current
  storage, with a cancellable progress bar, a final summary, and an error report
  file written to the project root **only when something failed**.
- Ship as **four separate changes** in a forced order (see *Work split*).

## The safety invariant (load-bearing — everything else follows)

> **A source store is never cleared until the target store is on disk.**

For the sidecar and for drafts, "on disk" happens the moment the file is written.
For inline storage, the comment carriers are applied to the document as a
`WorkspaceEdit` — that only dirties the editor buffer. "On disk" therefore means
**the document was saved**. If the save fails or does not happen (read-only file,
write error), the cleanup is skipped and the comments stay in the source store;
the next attempt retries.

**This fixes a bug that exists today.** The shipped sidecar→inline migration edits
the buffer and immediately deletes `.comments.json` from disk. Close without
saving, undo, or crash — and the comments are gone from *both* places. It is rare
today because it takes a deliberate settings change on an open document. Auto-import
would fire the same path on every file open, turning a rare bug into a routine one.
The invariant must therefore land **before** auto-import.

## Draft storage

The record is the same `CommentsFile` JSON the sidecar uses — same anchors, same
comment bodies. Anchoring, re-anchoring after edits, orphan handling, the
translation pipeline, rendering, scroll sync and export are therefore **completely
untouched**: export has nothing to strip in this mode.

**Identity.** The record is bound to the document by its URI. The file name is a
hash of that URI, and the URI itself is stored **inside** the record and verified on
read. A hash collision therefore yields "no comments found", never "someone else's
comments" — the failure is a miss, not a mix-up.

**Renames.** Renaming or moving a document inside the editor moves its draft record
with it. A move made outside the editor breaks the link — the record is not deleted,
just not found. This is the accepted cost of the mode.

## Auto-import on open

Two phases, and the split is not cosmetic:

**Phase 1 — merge (read only).** On load, all three stores are read and merged into
memory, de-duplicated by comment id. Comments become visible regardless of where
they were left. This alone closes "I flipped the setting and my comments vanished".

**Phase 2 — move (write).** The merged set is persisted to the current storage and
the contributing sources are cleared, under the safety invariant above.

Phase 2 **cannot** run at load time: the document's block list does not exist yet,
and after-paragraph placement needs it — serializing without blocks would dump every
carrier at the end of the file. So phase 2 runs after the first real anchoring pass.

If nothing was imported, phase 2 does not run at all — opening a document must not
touch it when there is nothing to move.

## Bulk import

An action link at the end of the Comments settings section runs a command over every
`.md` in the project. It scans once, building a work list (which files hold comments
in the wrong store, and how many), shows a confirmation with the counts, then executes
that list — the document text is re-read at write time in case it changed in between.

Progress is a cancellable notification. Cancelling is safe: each file moves
independently and completely, so a cancelled run is "some moved, some did not", never
a half-state — that is what the safety invariant buys.

The summary reports comments moved, files touched, files skipped, files failed.

**Error report.** Written to the root of the first project folder, and only when
something failed. One line per problem: which document, from where to where, what
failed — and, stated explicitly, that **the comments were not lost**: they are still
in the source store, because cleanup does not run until the move is on disk. The
report is a "did not move" list, not a "lost" list. It also names a case that is
invisible today: a **corrupt source** — a sidecar or carrier whose JSON cannot be
parsed is silently treated as empty everywhere else in the system; bulk import is the
one place that can say it out loud.

A successful run leaves nothing behind — a tool whose whole point is "no litter in the
repo" must not litter the repo on every run.

**Requires an open folder.** Without one there is nothing to walk and nowhere to put
the report; the command says so rather than silently doing nothing.

**Document writes** go through the editor (open the document, apply the edit, save),
never a raw filesystem write — the same disciplined path as in-place paragraph save.
Files that are open **and** have unsaved changes are skipped and reported, rather than
having their dirty buffer rewritten underneath the user.

Markdown is parsed only when the target is after-paragraph placement; the other three
targets do not need the block list, which makes them dramatically cheaper.

## Accepted risk (explicit)

With auto-import on and inline storage selected, **opening a document can modify and
save that document** — for example when a leftover sidecar or draft is found and moved
into the file. With `files.autoSave` enabled this happens without any further
interaction. The user chose this over a "read-only until you press the button"
variant. It is stated in the setting's description, and the setting can be turned off.

## Known limits (accepted, not defects)

- Drafts do not travel with the file: not in git, not to a colleague. That is the
  definition of the mode, not a gap — the other two storages exist for that.
- A document moved outside the editor loses its draft link.
- Bulk import only sees documents inside the project; drafts for documents elsewhere
  are not consolidated by it.
- No garbage collection of drafts for deleted documents.

## Work split (forced order)

1. **Draft storage** — the third backend, the setting, the rename tracking. The
   existing open-document migration already carries comments into and out of it.
2. **Safety invariant** — never clear a source before the target is durable. This is
   a bug fix, and it must precede auto-import.
3. **Auto-import on open** — the two-phase merge/move, behind a setting, default on.
4. **Bulk import** — the command, the settings action link, progress, summary, report.

Each lands as its own commit with its own tests, so a regression can be attributed.

## Testing

- Draft backend: round-trip; corrupt/foreign record reads as empty; URI mismatch
  yields empty, never another document's comments.
- **Migration matrix**: all ordered pairs across the three media. For each: the target
  holds the comments with their ids intact, the source is gone, and the document
  contains carriers **iff** the target is inline.
- Safety invariant: a target save that fails leaves the source store intact.
- Auto-import: nothing to import ⇒ the document is not touched at all; merge
  de-duplicates by comment id; phase 2 does not run before blocks exist.
- Bulk import: work list counts; cancel mid-run leaves moved files moved and the rest
  untouched; a failing file lands in the report and keeps its comments.

## Spec chain (project convention)

New EARS ids extend req 11 in `requirements.md`; a `Validates:` Property in
`design.md`; matching tasks in `tasks.md` — updated together with the code.
