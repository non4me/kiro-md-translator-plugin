# Draft Comment Storage + Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third comment storage (`draft`, in the extension's own storage — nothing written next to the document), make storage migration crash-safe, auto-import comments from the other storages on open, and add a bulk project-wide import.

**Architecture:** `CommentBackend` is the existing storage seam (`load` / `persist` / `clear` + `medium`). A new `DraftBackend` implements it against a JSON file under `context.globalStorageUri`, keyed by a hash of the document URI with the URI itself embedded in the record for collision safety. Migration reuses `CommentsService.migrateFrom`, hardened with one invariant: **never clear a source store before the target is on disk** (for `inline` targets, "on disk" means the document was saved). Auto-import is a two-phase merge/move: phase 1 merges all three stores into memory at `load()`, phase 2 persists + clears after the first real anchoring pass (after-paragraph placement needs the block list). Bulk import is a service with injected primitives so its logic is unit-testable without the vscode host.

**Tech Stack:** TypeScript, vitest (vscode is mocked via `test/mocks/vscode.ts`), esbuild.

---

## File Structure

- Modify `src/types.ts` — widen `CommentStorage`; add `commentAutoImport` to `PluginConfig`; add `completeImport?` to `ICommentsService`.
- Modify `src/commentBackends.ts` — `StorageMedium`/`PersistResult` gain `'draft'`; add `draftUri()`, `DraftBackend`, `moveDraft()`.
- Modify `src/CommentsService.ts` — `saveSource` param; durability invariant in `migrateFrom`; `setImportSources`/`mergeIn`/`completeImport`/`importedCount`.
- Modify `src/SettingsManager.ts` — `getCommentAutoImport()`.
- Modify `src/ActivationController.ts` — draft backend selection, `document.save()` wiring, import sources, rename tracking, the bulk-import command.
- Create `src/blocks.ts` — `blocksFromLineMap()`, shared by `PreviewController` and the bulk importer.
- Modify `src/PreviewController.ts` — use `blocksFromLineMap`; call `completeImport()` after re-anchoring.
- Create `src/CommentImporter.ts` — project-wide import: plan pass, execute pass, outcome + failure report.
- Modify `package.json` / `package.nls.json` — `draft` enum value, `commentAutoImport` setting with the action link, the command.
- Tests: `test/commentBackends.test.ts`, `test/CommentMigration.test.ts`, `test/CommentsService.test.ts`, `test/CommentImporter.test.ts` (new), `test/SettingsManager.test.ts`.

---

## Change 1 — Draft storage

### Task 1: Draft backend

**Files:**
- Modify: `src/types.ts:37`
- Modify: `src/commentBackends.ts`
- Test: `test/commentBackends.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/commentBackends.test.ts`:

```ts
import { SidecarBackend, InlineEofBackend, InlineAfterBackend, DraftBackend, draftUri, moveDraft } from '../src/commentBackends'

const storageRoot = vscode.Uri.parse('file:///global/storage') as never

describe('DraftBackend', () => {
  it('persists then loads the same threads', async () => {
    const { io } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    const res = await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    expect(res.kind).toBe('draft')
    expect((await be.load('')).threads).toHaveLength(1)
  })

  it('writes nothing next to the document', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    expect([...store.keys()][0]).toContain('/global/storage/')
    expect([...store.keys()][0]).not.toContain('/doc/')
  })

  it('removes the record when the last comment goes', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    await be.persist({ data: { version: 1, docHash: '', threads: [] }, source: '', blocks: [], live: new Map() })
    expect(store.size).toBe(0)
  })

  it('a record belonging to another document reads as empty (hash collision is a miss, never a mix-up)', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    // Same file name, but the record claims a different document.
    await io.write(draftUri(docUri, storageRoot) as never,
      JSON.stringify({ version: 1, docHash: '', docUri: 'file:///other/doc.md', threads: file.threads }))
    expect((await be.load('')).threads).toHaveLength(0)
    expect(store.size).toBe(1) // not deleted, just not ours
  })

  it('a corrupt record reads as empty and never throws', async () => {
    const { io } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await io.write(draftUri(docUri, storageRoot) as never, '{ not json')
    expect((await be.load('')).threads).toHaveLength(0)
  })

  it('clear() removes the record', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    await be.clear('')
    expect(store.size).toBe(0)
  })
})

describe('moveDraft', () => {
  it('re-keys the record to the new document uri', async () => {
    const { io, store } = memIO()
    const newUri = vscode.Uri.parse('file:///doc/renamed.md') as never
    await new DraftBackend(docUri, storageRoot, io).persist({ data: file, source: '', blocks: [], live: new Map() })
    expect(await moveDraft(docUri, newUri, storageRoot as never, io)).toBe(true)
    expect(store.size).toBe(1)
    expect((await new DraftBackend(newUri, storageRoot, io).load('')).threads).toHaveLength(1)
    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(0)
  })

  it('is a no-op when the document has no draft', async () => {
    const { io, store } = memIO()
    const newUri = vscode.Uri.parse('file:///doc/renamed.md') as never
    expect(await moveDraft(docUri, newUri, storageRoot as never, io)).toBe(false)
    expect(store.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/commentBackends.test.ts`
Expected: FAIL — `DraftBackend`/`draftUri`/`moveDraft` are not exported.

- [ ] **Step 3: Widen the storage type**

`src/types.ts:37` — replace:

```ts
export type CommentStorage = 'sidecar' | 'inline' | 'draft'
```

- [ ] **Step 4: Implement the backend**

`src/commentBackends.ts` — change the two type lines:

```ts
export type StorageMedium = 'sidecar' | 'inline' | 'draft'

export type PersistResult =
  | { kind: 'sidecar' }
  | { kind: 'draft' }
  | { kind: 'inline'; newSource: string }
```

Add the import of `hashString` at the top:

```ts
import { hashString } from './anchoring'
```

Append to the file:

```ts
const DRAFT_DIR = 'comments'

/** `<globalStorage>/comments/<hash>.json`. `hashString` is djb2, NOT cryptographic, so
 *  the record also carries `docUri` and `load` verifies it: a collision must yield a
 *  MISS (no comments), never another document's comments. */
export function draftUri(docUri: vscode.Uri, storageRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storageRoot, DRAFT_DIR, `${hashString(docUri.toString())}.json`)
}

/** True when `raw` is a draft record for exactly this document. */
function ownedBy(raw: string, key: string): boolean {
  try {
    const o = JSON.parse(raw) as { docUri?: unknown }
    return o.docUri === key
  } catch {
    return false
  }
}

/**
 * Comments in the extension's own storage (req 11.15): nothing is written next to the
 * document and the `.md` is never modified — the only backend that works on a document
 * you cannot write to. Drafts do NOT travel with the file; that is the mode, not a gap.
 */
export class DraftBackend implements CommentBackend {
  readonly medium = 'draft' as const
  private readonly uri: vscode.Uri
  private readonly key: string
  constructor(docUri: vscode.Uri, storageRoot: vscode.Uri, private readonly io: SidecarIO = fsIO) {
    this.uri = draftUri(docUri, storageRoot)
    this.key = docUri.toString()
  }
  async load(): Promise<CommentsFile> {
    const raw = await this.io.read(this.uri)
    if (raw === undefined || !ownedBy(raw, this.key)) return parseCommentsFile(undefined)
    return parseCommentsFile(raw)
  }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    if (ctx.data.threads.length === 0) {
      await this.io.remove(this.uri) // tolerant of an already-missing record
      return { kind: 'draft' }
    }
    await this.io.write(this.uri, JSON.stringify({ ...ctx.data, docUri: this.key }, null, 2))
    return { kind: 'draft' }
  }
  async clear(): Promise<{ newSource?: string }> {
    await this.io.remove(this.uri)
    return {}
  }
}

/** Follow a document rename: move its draft record and re-stamp the embedded uri (without
 *  the re-stamp the record would fail its own ownership check at the new location).
 *  Returns false when there was no draft to move. */
export async function moveDraft(
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
  storageRoot: vscode.Uri,
  io: SidecarIO = fsIO,
): Promise<boolean> {
  const from = draftUri(oldUri, storageRoot)
  const raw = await io.read(from)
  if (raw === undefined || !ownedBy(raw, oldUri.toString())) return false
  const data = parseCommentsFile(raw)
  await io.write(draftUri(newUri, storageRoot), JSON.stringify({ ...data, docUri: newUri.toString() }, null, 2))
  await io.remove(from)
  return true
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/commentBackends.test.ts`
Expected: PASS (all DraftBackend + moveDraft cases).

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/commentBackends.ts test/commentBackends.test.ts
git commit -m "feat(comments): draft backend — comments in extension storage, nothing written next to the document"
git push
```

---

### Task 2: Migration matrix for draft

**Files:**
- Test: `test/CommentMigration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/CommentMigration.test.ts` (import `DraftBackend` and add `storageRoot` next to the existing `docUri`):

```ts
import { SidecarBackend, InlineEofBackend, InlineAfterBackend, DraftBackend } from '../src/commentBackends'
const storageRoot = vscode.Uri.parse('file:///global/storage') as never

describe('comment migration — draft', () => {
  it('sidecar → draft: sidecar removed, draft written, .md untouched', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    const prev = svc.currentBackend()
    svc.setBackend(new DraftBackend(docUri, storageRoot, io))
    await svc.migrateFrom(prev)
    expect(source).toBe(original)                        // document never touched
    expect(store.size).toBe(1)                           // exactly one record left…
    expect([...store.keys()][0]).toContain('/global/storage/')  // …and it is the draft
  })

  it('draft → sidecar: draft removed, sidecar written (materialise the draft)', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new DraftBackend(docUri, storageRoot, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    const prev = svc.currentBackend()
    svc.setBackend(new SidecarBackend(docUri, io))
    await svc.migrateFrom(prev)
    expect(store.size).toBe(1)
    expect([...store.keys()][0]).toContain('/doc/api.md.comments.json')
    expect(source).not.toContain('rmt:comments')
  })

  it('draft → inline(after): carrier written into .md, draft removed', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new DraftBackend(docUri, storageRoot, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(store.size).toBe(1)
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(source).toContain('Beta.\n\n<!-- rmt:comments')
    expect(parseInline(source).threads).toHaveLength(1)
    expect(store.size).toBe(0)                           // draft record gone
  })

  it('inline(after) → draft: carrier stripped from .md, draft written', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new InlineAfterBackend(), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(source).toContain('rmt:comments')
    const prev = svc.currentBackend()
    svc.setBackend(new DraftBackend(docUri, storageRoot, io))
    await svc.migrateFrom(prev)
    expect(source).not.toContain('rmt:comments')
    expect(store.size).toBe(1)
    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(1)
  })

  it('empty comment set: sidecar → draft creates no record and does not touch the .md', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    const prev = svc.currentBackend()
    svc.setBackend(new DraftBackend(docUri, storageRoot, io))
    await svc.migrateFrom(prev)
    expect(source).toBe(original)
    expect(store.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/CommentMigration.test.ts`
Expected: PASS immediately — `migrateFrom` already generalises; these tests prove the `medium: 'draft'` value makes the "same medium ⇒ skip clear" rule do the right thing. If any FAIL, the medium wiring in Task 1 is wrong — fix it there.

- [ ] **Step 3: Commit**

```bash
git add test/CommentMigration.test.ts
git commit -m "test(comments): migration matrix covers draft ↔ sidecar and draft ↔ inline"
git push
```

---

### Task 3: Wire the draft backend into the extension

**Files:**
- Modify: `src/ActivationController.ts:46` (activate), `src/ActivationController.ts:187` (makeCommentBackend)
- Modify: `package.json` (Comments section)

- [ ] **Step 1: Select the backend from the setting**

`src/ActivationController.ts` — extend the import on line 10:

```ts
import { type CommentBackend, SidecarBackend, InlineEofBackend, InlineAfterBackend, DraftBackend, moveDraft } from './commentBackends'
```

Replace `makeCommentBackend` (line 187):

```ts
  /** Select the comment persistence backend from settings (req 11): sidecar by
   *  default; inline end-of-file or after-paragraph when `commentStorage` is
   *  `inline`, per `commentPlacement`; draft (extension storage) when `draft`. */
  private makeCommentBackend(docUri: vscode.Uri): CommentBackend {
    const storage = this.settings.getCommentStorage()
    if (storage === 'draft') return new DraftBackend(docUri, this.context.globalStorageUri)
    if (storage !== 'inline') return new SidecarBackend(docUri)
    return this.settings.getCommentPlacement() === 'end-of-file'
      ? new InlineEofBackend()
      : new InlineAfterBackend()
  }
```

- [ ] **Step 2: Create the draft directory and follow renames**

In `activate(context)` (line 46), after `this.context = context`, add:

```ts
    // The draft store lives here. `createDirectory` is recursive and idempotent.
    void vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(context.globalStorageUri, 'comments'),
    )
    // A document renamed INSIDE the editor keeps its drafts. A move made outside the
    // editor breaks the link — accepted, drafts are drafts.
    context.subscriptions.push(
      vscode.workspace.onDidRenameFiles(async (e) => {
        for (const { oldUri, newUri } of e.files) {
          if (!newUri.path.toLowerCase().endsWith('.md')) continue
          await moveDraft(oldUri, newUri, context.globalStorageUri)
        }
      }),
    )
```

- [ ] **Step 3: Add the setting value**

`package.json` — in `kiro-md-translator.commentStorage`, extend the three arrays:

```json
            "enum": [
              "sidecar",
              "inline",
              "draft"
            ],
            "enumItemLabels": [
              "Separate file",
              "Inside the Markdown file",
              "Draft (editor storage)"
            ],
            "enumDescriptions": [
              "Store comments in a separate `<name>.md.comments.json` file next to the document (default). The Markdown file itself is never modified.",
              "Embed comments inside the Markdown file as invisible HTML comments, so a single file carries its comments.",
              "Keep comments in the editor's own storage. Nothing is written next to the document and the Markdown file is never modified — the only mode that works on documents you cannot write to. Drafts stay on this machine and do NOT travel with the file."
            ],
```

- [ ] **Step 4: Typecheck, test, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ActivationController.ts package.json
git commit -m "feat(comments): select draft storage from settings; follow renames"
git push
```

---

## Change 2 — The safety invariant

### Task 4: Never clear a source before the target is on disk

**Files:**
- Modify: `src/CommentsService.ts:40-48` (constructor), `src/CommentsService.ts:194` (migrateFrom)
- Modify: `src/ActivationController.ts:298`
- Test: `test/CommentMigration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/CommentMigration.test.ts`:

```ts
describe('migration durability', () => {
  it('inline target that cannot be saved keeps the sidecar (comments never live in neither place)', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(
      docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000,
      () => source, async (t) => { source = t },
      async () => false, // read-only document: the save fails
    )
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(store.size).toBe(1)
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(store.size).toBe(1) // sidecar SURVIVES — the carrier only reached the buffer
  })

  it('inline target that saves clears the sidecar', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    let saves = 0
    const svc = new CommentsService(
      docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000,
      () => source, async (t) => { source = t },
      async () => { saves++; return true },
    )
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(store.size).toBe(0)
    expect(saves).toBeGreaterThan(0)
    expect(source).toContain('rmt:comments')
  })

  it('an empty comment set never saves the document', async () => {
    const { io } = memIO()
    let source = `Alpha.\n\nBeta.`
    let saves = 0
    const svc = new CommentsService(
      docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000,
      () => source, async (t) => { source = t },
      async () => { saves++; return true },
    )
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(saves).toBe(0) // opening/switching with no comments must not touch the file
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/CommentMigration.test.ts -t "durability"`
Expected: FAIL — the first test currently clears the sidecar.

- [ ] **Step 3: Add the injected save + the invariant**

`src/CommentsService.ts` — add the 8th constructor parameter:

```ts
    private readonly writeSource?: (text: string) => Promise<void>,
    /** Flush the document to disk. Resolves false when it could not be saved (read-only,
     *  write error). Absent ⇒ treated as durable (unit tests, sidecar-only setups). */
    private readonly saveSource?: () => Promise<boolean>,
  ) {}
```

Replace `migrateFrom`:

```ts
  /**
   * Re-home comments from `previous` to the CURRENT backend (already set via
   * setBackend). Persists to the new location, then clears the old ONLY when the
   * storage medium actually changed — for an inline→inline placement change the
   * flush already stripped the old carriers and rewrote them in place, so clearing
   * would wipe what we just wrote. Comment ids are stable, so nothing is lost.
   *
   * SAFETY INVARIANT: an inline target only reaches the editor BUFFER. Clearing the
   * source now would leave the comments in NEITHER place if that buffer is never
   * saved (close-without-save, undo, crash). So: clear only once the target is on
   * disk. If the save fails, keep the source and retry on the next attempt.
   */
  async migrateFrom(previous: CommentBackend): Promise<void> {
    await this.flush() // writes to the NEW backend (this.backend)
    if (previous.medium === this.backend.medium) return // inline↔inline placement: already re-homed in place
    if (this.backend.medium === 'inline' && this.data.threads.length > 0) {
      const durable = this.saveSource ? await this.saveSource() : true
      if (!durable) return // target not on disk → the source stays intact
    }
    const cleared = await previous.clear(this.getSource())
    if (cleared.newSource !== undefined && this.writeSource && cleared.newSource !== this.getSource()) {
      await this.writeSource(cleared.newSource)
      await this.saveSource?.() // finish the move: the stripped document must reach disk too
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/CommentMigration.test.ts`
Expected: PASS (including the five pre-existing migration tests, which inject no `saveSource` and therefore treat the target as durable).

- [ ] **Step 5: Wire the real save**

`src/ActivationController.ts:298` — extend the `CommentsService` construction:

```ts
    const commentsService = new CommentsService(
      document.uri,
      this.makeCommentBackend(document.uri),
      undefined, // default genId
      undefined, // default now
      undefined, // default flushMs
      () => document.getText(),
      applyEdit,
      () => Promise.resolve(document.save()), // durability: see migrateFrom's invariant
    )
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/CommentsService.ts src/ActivationController.ts test/CommentMigration.test.ts
git commit -m "fix(comments): never clear the source store before the target is on disk"
git push
```

---

## Change 3 — Auto-import on open

### Task 5: Merge on load, move after anchoring

**Files:**
- Modify: `src/CommentsService.ts`
- Modify: `src/types.ts` (`ICommentsService`)
- Test: `test/CommentsService.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/CommentsService.test.ts` (reuse its existing `memIO`/`blocksFrom`/`ids` helpers; if it lacks them, copy the three from `test/CommentMigration.test.ts`):

```ts
import { SidecarBackend, InlineAfterBackend, DraftBackend } from '../src/commentBackends'
const storageRoot = vscode.Uri.parse('file:///global/storage') as never

describe('auto-import', () => {
  it('surfaces comments left in another store and moves them into the current one', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    // A comment was left behind in the sidecar…
    const old = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await old.load()
    old.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    old.addComment(1, 'note')
    await old.flush()

    // …and the user is now in draft mode.
    const svc = new CommentsService(docUri, new DraftBackend(docUri, storageRoot, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new InlineAfterBackend()])
    await svc.load()
    expect(svc.importedCount).toBe(1)
    const res = svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    expect(res.forBlocks).toEqual([{ paragraphIndex: 1, count: 1 }]) // visible immediately
    await svc.completeImport()
    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(1)
    expect(store.size).toBe(1) // sidecar gone, draft written
  })

  it('de-duplicates by comment id when the same comment sits in two stores', async () => {
    const { io } = memIO()
    let source = `Alpha.\n\nBeta.`
    const sidecar = new SidecarBackend(docUri, io)
    const draft = new DraftBackend(docUri, storageRoot, io)
    const data = { version: 1, docHash: '', threads: [
      { anchor: { quote: 'Beta.', prefix: '', suffix: '', hintLine: 2, quoteHash: '' }, orphaned: false,
        comments: [{ id: 'dup', body: 'note', createdAt: 't', updatedAt: 't' }] },
    ] }
    await sidecar.persist({ data, source, blocks: [], live: new Map() })
    await draft.persist({ data, source, blocks: [], live: new Map() })

    const svc = new CommentsService(docUri, new DraftBackend(docUri, storageRoot, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new InlineAfterBackend()])
    await svc.load()
    expect(svc.importedCount).toBe(0) // already present → nothing imported
    const res = svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    expect(res.forBlocks).toEqual([{ paragraphIndex: 1, count: 1 }]) // shown ONCE
  })

  it('nothing to import ⇒ the document is not touched at all', async () => {
    const { io } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    let writes = 0
    const svc = new CommentsService(docUri, new InlineAfterBackend(), ids(), () => 't', 1_000_000, () => source, async (t) => { writes++; source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new DraftBackend(docUri, storageRoot, io)])
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    await svc.completeImport()
    expect(writes).toBe(0)
    expect(source).toBe(original)
  })

  it('does not move anything before the block list exists (would dump carriers at EOF)', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const old = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await old.load()
    old.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    old.addComment(1, 'note')
    await old.flush()

    const svc = new CommentsService(docUri, new InlineAfterBackend(), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new DraftBackend(docUri, storageRoot, io)])
    await svc.load()
    await svc.completeImport() // no reanchor yet → must be a no-op
    expect(source).not.toContain('rmt:comments')
    expect(store.size).toBe(1) // sidecar untouched
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/CommentsService.test.ts -t "auto-import"`
Expected: FAIL — `setImportSources` / `importedCount` / `completeImport` do not exist.

- [ ] **Step 3: Implement**

`src/CommentsService.ts` — add the fields next to `flushTimer`:

```ts
  /** Backends to pull comments in from at load (auto-import). Empty ⇒ feature off. */
  private importSources: CommentBackend[] = []
  /** Sources that actually contributed at the last load — the ones to clear in phase 2. */
  private pendingImport: CommentBackend[] = []
  /** How many comments the last `load()` pulled in from other stores. 0 ⇒ nothing to move. */
  importedCount = 0
```

Replace `load`:

```ts
  /** Phase 1 of auto-import: read the current store, then merge whatever the other
   *  stores still hold (a setting flipped while the document was closed leaves comments
   *  behind). Read-only — the move itself is `completeImport`, which needs the blocks. */
  async load(): Promise<void> {
    this.data = await this.backend.load(this.getSource())
    this.importedCount = 0
    this.pendingImport = []
    for (const source of this.importSources) {
      if (source.medium === this.backend.medium) continue
      const added = this.mergeIn(await source.load(this.getSource()))
      if (added > 0) {
        this.importedCount += added
        this.pendingImport.push(source)
      }
    }
  }

  /** Auto-import sources. Set before `load()`; empty disables the feature. */
  setImportSources(sources: CommentBackend[]): void { this.importSources = sources }

  /** Union `other` into the live set, de-duplicating by comment id (the same comment can
   *  sit in two stores after a half-finished move). Returns how many were added — zero
   *  must NOT trigger a write, or merely opening a document would dirty it. */
  private mergeIn(other: CommentsFile): number {
    const seen = new Set(this.data.threads.flatMap((t) => t.comments.map((c) => c.id)))
    let added = 0
    for (const thread of other.threads) {
      const fresh = thread.comments.filter((c) => !seen.has(c.id))
      if (fresh.length === 0) continue
      fresh.forEach((c) => seen.add(c.id))
      this.data.threads.push({ ...thread, comments: fresh, orphaned: false })
      added += fresh.length
    }
    return added
  }

  /**
   * Phase 2 of auto-import: move what `load` merged into the current backend and clear
   * the sources it came from, under `migrateFrom`'s durability invariant.
   *
   * Deliberately NOT done inside `load`: the block list does not exist yet at that point,
   * and after-paragraph placement needs it — serialising without blocks would dump every
   * carrier at end-of-file. Hence the guard on `lastBlocks`.
   */
  async completeImport(): Promise<void> {
    if (this.pendingImport.length === 0 || this.lastBlocks.length === 0) return
    const sources = this.pendingImport
    this.pendingImport = []
    for (const source of sources) await this.migrateFrom(source)
  }
```

`src/types.ts` — extend `ICommentsService` (line 310):

```ts
export interface ICommentsService {
  load(): Promise<void>
  reanchor(blocks: Block[], sourceText: string): ReanchorResult
  getThreadComments(paragraphIndex: number): Comment[]
  addComment(paragraphIndex: number, body: string): Comment | undefined
  editComment(commentId: string, body: string): void
  deleteComment(commentId: string): void
  flush(): Thenable<void>
  /** Finish an auto-import once the blocks are known. Optional: test doubles may omit it. */
  completeImport?(): Promise<void>
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/CommentsService.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/CommentsService.ts src/types.ts test/CommentsService.test.ts
git commit -m "feat(comments): merge other storages on load, move them once blocks are known"
git push
```

---

### Task 6: The auto-import setting and its wiring

**Files:**
- Modify: `src/types.ts` (`PluginConfig`), `src/SettingsManager.ts`, `src/PreviewController.ts:305`, `src/ActivationController.ts`
- Modify: `package.json`
- Test: `test/SettingsManager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/SettingsManager.test.ts`:

```ts
  it('commentAutoImport defaults to true', () => {
    const mgr = new SettingsManager()
    expect(mgr.getCommentAutoImport()).toBe(true)
  })

  it('commentAutoImport can be turned off', () => {
    vscode.__setConfig({ commentAutoImport: false })
    const mgr = new SettingsManager()
    expect(mgr.getCommentAutoImport()).toBe(false)
    vscode.__clearConfig()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/SettingsManager.test.ts`
Expected: FAIL — `getCommentAutoImport` is not a function.

- [ ] **Step 3: Add the getter**

`src/types.ts` — in `PluginConfig`, after `commentPlacement`:

```ts
  commentAutoImport: boolean
```

`src/SettingsManager.ts` — after `getCommentPlacement`:

```ts
  getCommentAutoImport(): boolean {
    return this.cfg().get<boolean>('commentAutoImport', true)
  }
```

…and add `commentAutoImport: this.getCommentAutoImport(),` to the object returned by `getConfig()`.

- [ ] **Step 4: Declare the setting + the action link**

`package.json` — add to the Comments section, after `commentPlacement`:

```json
          "kiro-md-translator.commentAutoImport": {
            "type": "boolean",
            "order": 3,
            "default": true,
            "markdownDescription": "When a document is opened, look in the other comment storages and move anything found there into the selected one — so flipping Comment Storage never makes comments disappear.\n\n⚠️ When storage is `inline`, this **modifies and saves the Markdown document itself**.\n\n[Import all project comments into the current storage](command:kiro-md-translator.importComments)"
          }
```

- [ ] **Step 5: Finish the import after re-anchoring**

`src/PreviewController.ts` — in `emitComments()` (line 305), after the two `post` calls inside the `try`:

```ts
      // Phase 2 of auto-import: the blocks now exist, so the merged set can be moved
      // into the selected storage. No-op unless load() actually pulled something in.
      void svc.completeImport?.()
```

- [ ] **Step 6: Wire the sources**

`src/ActivationController.ts` — after the `commentsService` construction, before `const deps: PreviewDeps`:

```ts
    if (this.settings.getCommentAutoImport()) {
      commentsService.setImportSources(this.otherCommentBackends(document.uri))
    }
```

…and add the helper next to `makeCommentBackend`:

```ts
  /** The backends the current one must import from — one per OTHER medium. Inline is a
   *  single medium: an end-of-file carrier is read by the after-paragraph backend too. */
  private otherCommentBackends(docUri: vscode.Uri): CommentBackend[] {
    const current = this.settings.getCommentStorage()
    const all: CommentBackend[] = [
      new SidecarBackend(docUri),
      new InlineAfterBackend(),
      new DraftBackend(docUri, this.context.globalStorageUri),
    ]
    const currentMedium = current === 'draft' ? 'draft' : current === 'inline' ? 'inline' : 'sidecar'
    return all.filter((b) => b.medium !== currentMedium)
  }
```

- [ ] **Step 7: Typecheck, test, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/SettingsManager.ts src/PreviewController.ts src/ActivationController.ts package.json test/SettingsManager.test.ts
git commit -m "feat(comments): auto-import on open, behind a setting (default on)"
git push
```

---

## Change 4 — Bulk import

### Task 7: Shared block builder

**Files:**
- Create: `src/blocks.ts`
- Modify: `src/PreviewController.ts:295`

- [ ] **Step 1: Create the helper**

`src/blocks.ts`:

```ts
import type { Block, LineMapping } from './types'

/** Slice a document into anchorable blocks. Comments always anchor to the STORAGE text,
 *  never the rendered/translated view — so this only ever sees the raw source. */
export function blocksFromLineMap(lineMap: LineMapping[], source: string): Block[] {
  const lines = source.split('\n')
  return lineMap.map((m) => ({
    paragraphIndex: m.paragraphIndex,
    startLine: m.startLine,
    endLine: m.endLine,
    text: lines.slice(m.startLine, m.endLine + 1).join('\n').trim(),
  }))
}
```

- [ ] **Step 2: Use it in the controller**

`src/PreviewController.ts` — add `import { blocksFromLineMap } from './blocks'` and replace `currentBlocks()`:

```ts
  private currentBlocks(): Block[] {
    return blocksFromLineMap(this.lineMap, this.sourceText)
  }
```

- [ ] **Step 3: Run the suite (the controller's existing comment tests are the oracle)**

Run: `npm run typecheck && npm test`
Expected: PASS — identical behaviour, the logic is byte-for-byte the old `paragraphText` slice.

- [ ] **Step 4: Commit**

```bash
git add src/blocks.ts src/PreviewController.ts
git commit -m "refactor(comments): extract blocksFromLineMap for headless use"
git push
```

---

### Task 8: The import service

**Files:**
- Create: `src/CommentImporter.ts`
- Test: `test/CommentImporter.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/CommentImporter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { CommentImporter, type ImportDeps } from '../src/CommentImporter'
import { SidecarBackend, InlineAfterBackend, DraftBackend } from '../src/commentBackends'
import type { SidecarIO } from '../src/commentSidecar'
import type { Block, CommentsFile } from '../src/types'

const storageRoot = vscode.Uri.parse('file:///global/storage') as never
const uriA = vscode.Uri.parse('file:///p/a.md') as never
const uriB = vscode.Uri.parse('file:///p/b.md') as never

function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = {
    async read(u) { return store.get(String(u)) },
    async write(u, c) { store.set(String(u), c) },
    async remove(u) { store.delete(String(u)) },
  }
  return { io, store }
}

const threadFor = (quote: string, id: string): CommentsFile => ({
  version: 1, docHash: '', threads: [
    { anchor: { quote, prefix: '', suffix: '', hintLine: 2, quoteHash: '' }, orphaned: false,
      comments: [{ id, body: 'note', createdAt: 't', updatedAt: 't' }] },
  ],
})

const blocksOf = (src: string): Block[] =>
  src.split('\n\n').map((text, i) => ({ paragraphIndex: i, startLine: i * 2, endLine: i * 2, text: text.trim() }))

function makeDeps(io: SidecarIO, texts: Map<string, string>, opts: { dirty?: string[]; unwritable?: string[] } = {}): ImportDeps {
  return {
    listDocuments: async () => [uriA, uriB],
    readDocument: async (u) => {
      const text = texts.get(String(u))
      return text === undefined ? undefined : { text, dirty: (opts.dirty ?? []).includes(String(u)) }
    },
    writeDocument: async (u, text) => {
      if ((opts.unwritable ?? []).includes(String(u))) return false
      texts.set(String(u), text)
      return true
    },
    backendsFor: (u) => ({
      target: new DraftBackend(u, storageRoot, io),
      sources: [new SidecarBackend(u, io), new InlineAfterBackend()],
    }),
    blocksOf,
  }
}

describe('CommentImporter', () => {
  it('plans only the files that actually have comments elsewhere', async () => {
    const { io } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.'], [String(uriB), 'Gamma.']])
    await new SidecarBackend(uriA, io).persist({ data: threadFor('Beta.', 'c1'), source: '', blocks: [], live: new Map() })

    const plan = await new CommentImporter(makeDeps(io, texts)).plan()
    expect(plan).toHaveLength(1)
    expect(String(plan[0].uri)).toBe(String(uriA))
    expect(plan[0].commentCount).toBe(1)
  })

  it('moves the comments and clears the source', async () => {
    const { io, store } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.'], [String(uriB), 'Gamma.']])
    await new SidecarBackend(uriA, io).persist({ data: threadFor('Beta.', 'c1'), source: '', blocks: [], live: new Map() })

    const importer = new CommentImporter(makeDeps(io, texts))
    const outcome = await importer.run(await importer.plan(), () => {}, () => false)

    expect(outcome.movedComments).toBe(1)
    expect(outcome.movedFiles).toBe(1)
    expect(outcome.failures).toHaveLength(0)
    expect(store.size).toBe(1) // sidecar gone, draft written
    expect([...store.keys()][0]).toContain('/global/storage/')
    expect((await new DraftBackend(uriA, storageRoot, io).load('')).threads).toHaveLength(1)
  })

  it('skips a document with unsaved changes and reports it — comments stay put', async () => {
    const { io, store } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.']])
    await new SidecarBackend(uriA, io).persist({ data: threadFor('Beta.', 'c1'), source: '', blocks: [], live: new Map() })

    const deps = makeDeps(io, texts, { dirty: [String(uriA)] })
    const importer = new CommentImporter(deps)
    const outcome = await importer.run(await importer.plan(), () => {}, () => false)

    expect(outcome.movedFiles).toBe(0)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0].reason).toContain('unsaved')
    expect(store.size).toBe(1) // the sidecar is STILL there — nothing was lost
  })

  it('cancelling stops the run and reports it', async () => {
    const { io } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.'], [String(uriB), 'Gamma.\n\nDelta.']])
    await new SidecarBackend(uriA, io).persist({ data: threadFor('Beta.', 'c1'), source: '', blocks: [], live: new Map() })
    await new SidecarBackend(uriB, io).persist({ data: threadFor('Delta.', 'c2'), source: '', blocks: [], live: new Map() })

    const importer = new CommentImporter(makeDeps(io, texts))
    const plan = await importer.plan()
    expect(plan).toHaveLength(2)
    let seen = 0
    const outcome = await importer.run(plan, () => { seen++ }, () => seen >= 1) // cancel after the first
    expect(outcome.cancelled).toBe(true)
    expect(outcome.movedFiles).toBe(1)
  })

  it('formats a report that says the comments were NOT lost', () => {
    const lines = CommentImporter.formatReport({
      movedComments: 0, movedFiles: 0, skippedFiles: 0, cancelled: false,
      failures: [{ uri: 'file:///p/a.md', reason: 'unsaved changes in the editor' }],
    })
    expect(lines).toContain('file:///p/a.md')
    expect(lines).toContain('unsaved changes in the editor')
    expect(lines.toLowerCase()).toContain('not lost')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/CommentImporter.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

`src/CommentImporter.ts`:

```ts
/**
 * Project-wide comment import (req 11.17): move every document's comments into the
 * storage the user currently has selected. Two passes — `plan()` finds the work,
 * `run()` does it — so the confirmation can quote real numbers and the expensive pass
 * only touches documents that actually need it. The document text is re-read at write
 * time, in case it changed between the two.
 *
 * All host access is injected (`ImportDeps`), so the logic is testable without a
 * running extension host.
 */
import type * as vscode from 'vscode'
import type { Block } from './types'
import { CommentsService } from './CommentsService'
import type { CommentBackend } from './commentBackends'

export interface ImportDeps {
  /** Every markdown document in the project. */
  listDocuments(): Promise<vscode.Uri[]>
  /** Current text plus whether an editor is holding unsaved changes for it. */
  readDocument(uri: vscode.Uri): Promise<{ text: string; dirty: boolean } | undefined>
  /** Apply + save. Resolves false when the document could not be written. */
  writeDocument(uri: vscode.Uri, text: string): Promise<boolean>
  /** The selected backend for this document, plus the ones to import from. */
  backendsFor(uri: vscode.Uri): { target: CommentBackend; sources: CommentBackend[] }
  /** Anchorable blocks of a source text. */
  blocksOf(source: string): Block[]
}

export interface ImportPlanItem {
  uri: vscode.Uri
  commentCount: number
}

export interface ImportFailure {
  uri: string
  reason: string
}

export interface ImportOutcome {
  movedComments: number
  movedFiles: number
  skippedFiles: number
  failures: ImportFailure[]
  cancelled: boolean
}

export class CommentImporter {
  constructor(private readonly deps: ImportDeps) {}

  /** Pass 1: which documents hold comments in a store other than the selected one. */
  async plan(): Promise<ImportPlanItem[]> {
    const items: ImportPlanItem[] = []
    for (const uri of await this.deps.listDocuments()) {
      const doc = await this.deps.readDocument(uri)
      if (!doc) continue
      const { target, sources } = this.deps.backendsFor(uri)
      const svc = new CommentsService(uri, target, undefined, undefined, undefined, () => doc.text)
      svc.setImportSources(sources)
      await svc.load()
      if (svc.importedCount > 0) items.push({ uri, commentCount: svc.importedCount })
    }
    return items
  }

  /** Pass 2: execute the plan. Each document moves independently and completely, so a
   *  cancelled run is "some moved, some did not" — never a half-state. */
  async run(
    plan: ImportPlanItem[],
    onProgress: (item: ImportPlanItem, done: number) => void,
    isCancelled: () => boolean,
  ): Promise<ImportOutcome> {
    const outcome: ImportOutcome = {
      movedComments: 0, movedFiles: 0, skippedFiles: 0, failures: [], cancelled: false,
    }
    let done = 0
    for (const item of plan) {
      if (isCancelled()) {
        outcome.cancelled = true
        break
      }
      const failure = await this.moveOne(item)
      if (failure) {
        outcome.failures.push({ uri: item.uri.toString(), reason: failure })
      } else {
        outcome.movedFiles++
        outcome.movedComments += item.commentCount
      }
      onProgress(item, ++done)
    }
    return outcome
  }

  /** Move one document's comments. Returns a failure reason, or undefined on success. */
  private async moveOne(item: ImportPlanItem): Promise<string | undefined> {
    const doc = await this.deps.readDocument(item.uri)
    if (!doc) return 'the document could not be read'
    // Never rewrite a buffer the user is still editing.
    if (doc.dirty) return 'unsaved changes in the editor'

    let text = doc.text
    let writeFailed = false
    const { target, sources } = this.deps.backendsFor(item.uri)
    const svc = new CommentsService(
      item.uri, target, undefined, undefined, undefined,
      () => text,
      async (next) => { text = next },
      async () => {
        const ok = await this.deps.writeDocument(item.uri, text)
        if (!ok) writeFailed = true
        return ok
      },
    )
    svc.setImportSources(sources)
    await svc.load()
    if (svc.importedCount === 0) return undefined // moved by someone else in the meantime
    svc.reanchor(this.deps.blocksOf(text), text)
    await svc.completeImport()
    return writeFailed ? 'the document could not be written' : undefined
  }

  /** The error report. Its most important line is the last one: a failure means the
   *  comments did not MOVE — they were never deleted, because the source store is only
   *  cleared once the target is on disk. */
  static formatReport(outcome: ImportOutcome): string {
    const lines = [
      'Read Markdown Translator — comment import report',
      '',
      `Moved: ${outcome.movedComments} comment(s) in ${outcome.movedFiles} file(s).`,
      `Failed: ${outcome.failures.length} file(s).`,
      '',
      'Failures:',
      ...outcome.failures.map((f) => `  ${f.uri}\n    ${f.reason}`),
      '',
      'These comments were NOT lost. They are still in the storage they were in:',
      'a source store is never cleared until the move has reached disk. Fix the cause',
      '(unsaved changes, read-only file) and run the import again.',
      '',
      'This file is a one-off report — delete it whenever you like.',
      '',
    ]
    return lines.join('\n')
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/CommentImporter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/CommentImporter.ts test/CommentImporter.test.ts
git commit -m "feat(comments): project-wide import service (plan/run/report)"
git push
```

---

### Task 9: The command, the progress bar, the report file

**Files:**
- Modify: `src/ActivationController.ts`
- Modify: `package.json` (`contributes.commands`)

- [ ] **Step 1: Register the command**

`package.json` — add to `contributes.commands`:

```json
      {
        "command": "kiro-md-translator.importComments",
        "title": "Import Comments into the Current Storage"
      }
```

- [ ] **Step 2: Wire the host primitives**

`src/ActivationController.ts` — add the imports:

```ts
import { CommentImporter, type ImportDeps } from './CommentImporter'
import { blocksFromLineMap } from './blocks'
import { MarkdownRenderer } from './MarkdownRenderer'
```

Register the command inside `activate(context)`, next to the other command registrations:

```ts
    context.subscriptions.push(
      vscode.commands.registerCommand('kiro-md-translator.importComments', () =>
        this.importAllComments(),
      ),
    )
```

Add the methods:

```ts
  /** Host bindings for the project-wide import. Document writes go through the editor
   *  (open → edit → save), never a raw filesystem write — the same disciplined path as
   *  in-place paragraph save (req 7.14). */
  private importDeps(): ImportDeps {
    const renderer = new MarkdownRenderer(() => '')
    return {
      listDocuments: () => Promise.resolve(vscode.workspace.findFiles('**/*.md', '**/node_modules/**')),
      readDocument: async (uri) => {
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          return { text: doc.getText(), dirty: doc.isDirty }
        } catch {
          return undefined
        }
      },
      writeDocument: async (uri, text) => {
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          const edit = new vscode.WorkspaceEdit()
          edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text)
          if (!(await vscode.workspace.applyEdit(edit))) return false
          return await doc.save()
        } catch {
          return false
        }
      },
      backendsFor: (uri) => ({
        target: this.makeCommentBackend(uri),
        sources: this.otherCommentBackends(uri),
      }),
      blocksOf: (source) => {
        const dir = vscode.Uri.parse('file:///')
        return blocksFromLineMap(renderer.renderMdast(renderer.parse(source), dir).lineMap, source)
      },
    }
  }

  /** Move every project document's comments into the selected storage (req 11.17). */
  private async importAllComments(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]
    if (!root) {
      void vscode.window.showInformationMessage(
        t('Open a folder first — there is no project to import comments from.'),
      )
      return
    }

    const importer = new CommentImporter(this.importDeps())
    const plan = await importer.plan()
    if (plan.length === 0) {
      void vscode.window.showInformationMessage(
        t('Nothing to import: every comment is already in the selected storage.'),
      )
      return
    }
    const total = plan.reduce((n, i) => n + i.commentCount, 0)
    const go = await vscode.window.showInformationMessage(
      t('{0} comment(s) in {1} file(s) are stored elsewhere. Move them into the selected storage?', String(total), String(plan.length)),
      { modal: true },
      t('Import'),
    )
    if (go !== t('Import')) return

    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Importing comments…'), cancellable: true },
      (progress, token) =>
        importer.run(
          plan,
          (item, done) =>
            progress.report({
              increment: 100 / plan.length,
              message: `${done}/${plan.length} — ${item.uri.path.split('/').pop() ?? ''}`,
            }),
          () => token.isCancellationRequested,
        ),
    )

    const summary = t(
      'Imported {0} comment(s) in {1} file(s). Failed: {2}.',
      String(outcome.movedComments), String(outcome.movedFiles), String(outcome.failures.length),
    )
    if (outcome.failures.length === 0) {
      void vscode.window.showInformationMessage(outcome.cancelled ? `${summary} ${t('Cancelled.')}` : summary)
      return
    }

    // Only on failure — a tool whose point is "no litter in the repo" must not litter it.
    const reportUri = vscode.Uri.joinPath(root.uri, 'rmt-comment-import-errors.log')
    await vscode.workspace.fs.writeFile(
      reportUri,
      new TextEncoder().encode(CommentImporter.formatReport(outcome)),
    )
    const open = await vscode.window.showWarningMessage(summary, t('Show report'))
    if (open === t('Show report')) {
      void vscode.window.showTextDocument(await vscode.workspace.openTextDocument(reportUri))
    }
  }
```

- [ ] **Step 3: Typecheck, test, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ActivationController.ts package.json
git commit -m "feat(comments): bulk import command with progress, summary and failure report"
git push
```

---

## Task 10: Spec chain

**Files:**
- Modify: `.kiro/specs/kiro-md-translator-plugin/requirements.md`, `design.md`, `tasks.md`

- [ ] **Step 1: Add the EARS acceptance criteria under req 11**

```
11.15 WHEN Comment Storage is `draft` THEN the extension SHALL persist comments in its own
      storage and SHALL NOT modify the Markdown document or create any file beside it.
11.16 WHEN a draft record's embedded document URI does not match the document being opened
      THEN the extension SHALL treat the record as absent (a hash collision is a miss, never
      another document's comments).
11.17 WHEN a comment is moved between storages THEN the extension SHALL NOT clear the source
      store until the target store has reached disk; for `inline` targets this means the
      document was saved.
11.18 WHEN a document is opened AND Comment Auto Import is enabled THEN the extension SHALL
      merge comments found in the other storages and SHALL move them into the selected one.
11.19 WHEN the user runs Import Comments THEN the extension SHALL move every project
      document's comments into the selected storage, SHALL report how many moved, and SHALL
      write a failure report to the project root if and only if something failed.
```

- [ ] **Step 2: Add the Property to `design.md`**

```
P22 — Storage moves are lossless. For every ordered pair of storage media, moving comments
      leaves them readable in the target with their ids intact, removes them from the source,
      and — when the target write cannot reach disk — leaves the source untouched.
      Validates: 11.15, 11.16, 11.17, 11.18, 11.19
```

- [ ] **Step 3: Add the tasks to `tasks.md`** with `_Requirements: 11.15–11.19_` footers, mirroring Changes 1–4.

- [ ] **Step 4: Commit**

`.kiro/specs/**` is gitignored in this repo — the edits stay in the working tree. Nothing to commit; verify with `git status` that no spec file is staged.

---

## Self-review notes

- **Spec coverage:** draft storage (Tasks 1–3), safety invariant (Task 4), auto-import (Tasks 5–6), bulk import (Tasks 7–9), spec chain (Task 10). The spec's *Known limits* need no task by definition.
- **Type consistency:** `StorageMedium`/`CommentStorage` both gain `'draft'`; `PersistResult` gains `{kind:'draft'}` and `flush()` still branches only on `'inline'`, so no call site changes. `setImportSources`/`importedCount`/`completeImport` are used with exactly these names in Tasks 5, 6, 8.
- **The `medium: 'draft'` value is load-bearing**: reusing `SidecarBackend` with a different URI would make `migrateFrom`'s "same medium ⇒ skip clear" rule leave the old `.comments.json` on disk forever, and `ActivationController`'s `next.constructor === prev.constructor` guard would skip the swap entirely. Task 1 must not be "optimised" into that.
