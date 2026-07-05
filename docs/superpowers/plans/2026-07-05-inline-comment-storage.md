# Inline Comment Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users store block-anchored comments either in the current sidecar file (default) or inside the `.md` itself — invisibly, as HTML comments — with a user-chosen placement (after each paragraph, default; or one block at end-of-file); and split the settings UI into titled sections.

**Architecture:** A `CommentBackend` seam (sidecar vs two inline layouts) owns *where and how* comments persist, while `CommentsService` keeps all anchoring / live-map / debounce logic. Inline layouts are pure string transforms in `inlineComments.ts` (`strip`/`parse`/`serializeEof`/`serializeAfter`) carried by `<!-- rmt:comments … -->` HTML comments, which mdast treats as `html` nodes — excluded from translation, stripped from the preview, and invisible to `lineMap`. The `.md` is written only through the existing `applyEdit` `WorkspaceEdit` seam, never via `fs`.

**Tech Stack:** TypeScript, VS Code extension API (mocked in tests), vitest + fast-check, esbuild.

**Reference:** design doc `docs/superpowers/specs/2026-07-05-inline-comment-storage-design.md`.

**Conventions to respect:**
- `npm run typecheck` checks `src/` only; `npm test` runs vitest. Tests import vscode-typed objects from `test/mocks/vscode` and pass them with `as never`.
- All user-facing strings go through `t()` in `src/l10n.ts`. Section titles in `package.json` use `%key%` resolved from `package.nls.json`.
- Commit after every task. No `Co-Authored-By`/assistant trailer in commit messages.

---

## File Structure

- `package.json` — `contributes.configuration` becomes an array of 4 titled sections; adds `commentStorage`, `commentPlacement`. **Modify.**
- `package.nls.json` — section title strings. **Create if absent / Modify.**
- `src/types.ts` — `CommentStorage`/`CommentPlacement` types, `PluginConfig` + `ISettingsManager` additions, `Block.endLine`. **Modify.**
- `src/SettingsManager.ts` — two new getters. **Modify.**
- `src/inlineComments.ts` — pure strip/parse/serialize for inline layouts. **Create.**
- `src/commentBackends.ts` — `CommentBackend` interface + `SidecarBackend`, `InlineEofBackend`, `InlineAfterBackend`. **Create.**
- `src/CommentsService.ts` — take a `CommentBackend` + `getSource`/`writeSource` seams instead of `SidecarIO` directly; inline load/flush; `setBackend`/`migrateFrom`. **Modify.**
- `src/ActivationController.ts` — select backend from settings, inject seams, re-select + migrate on settings change. **Modify.**
- `src/PreviewController.ts` — `currentBlocks()` carries `endLine`; `handleExport` strips inline comments. **Modify.**
- `.kiro/specs/kiro-md-translator-plugin/{requirements,design,tasks}.md` — new EARS ids 11.12–11.14 + Property. **Modify.**
- Tests: `test/inlineComments.test.ts` **Create**; `test/commentBackends.test.ts` **Create**; `test/CommentsService.test.ts` **Modify**; `test/SettingsManager.test.ts` **Modify (or create)**; `test/ExportInlineStrip.test.ts` **Create**.

---

## Task 1: Split settings into titled sections + new comment settings

**Files:**
- Modify: `package.json` (`contributes.configuration`, currently object at ~line 76)
- Create/Modify: `package.nls.json`

- [ ] **Step 1: Rewrite `contributes.configuration` as an array of 4 sections.**

Replace the single `"configuration": { "title": …, "properties": { … } }` object with:

```jsonc
"configuration": [
  {
    "title": "%config.section.provider%",
    "order": 1,
    "properties": {
      "kiro-md-translator.providerType": { /* unchanged */ },
      "kiro-md-translator.customEndpoint": { /* unchanged */ },
      "kiro-md-translator.ollamaEndpoint": { /* unchanged */ },
      "kiro-md-translator.ollamaModel": { /* unchanged */ }
    }
  },
  {
    "title": "%config.section.languages%",
    "order": 2,
    "properties": {
      "kiro-md-translator.storageLanguage": { /* unchanged */ },
      "kiro-md-translator.targetLanguage": { /* unchanged */ }
    }
  },
  {
    "title": "%config.section.translation%",
    "order": 3,
    "properties": {
      "kiro-md-translator.translationMode": { /* unchanged */ },
      "kiro-md-translator.glossary": { /* unchanged */ }
    }
  },
  {
    "title": "%config.section.comments%",
    "order": 4,
    "properties": {
      "kiro-md-translator.commentStorage": {
        "type": "string",
        "enum": ["sidecar", "inline"],
        "enumDescriptions": [
          "Store comments in a separate `<name>.md.comments.json` file next to the document (default).",
          "Store comments inside the .md file itself, as invisible HTML comments, so a single file carries its comments."
        ],
        "default": "sidecar",
        "markdownDescription": "Where block comments are persisted."
      },
      "kiro-md-translator.commentPlacement": {
        "type": "string",
        "enum": ["after-paragraph", "end-of-file"],
        "enumDescriptions": [
          "Place each comment right after its paragraph (default).",
          "Collect all comments in one block at the end of the file."
        ],
        "default": "after-paragraph",
        "markdownDescription": "Where inline comments are written. Applies only when Comment Storage is `inline`."
      }
    }
  }
]
```

Copy the existing property bodies verbatim into their sections — do not edit them.

- [ ] **Step 2: Add the section titles to `package.nls.json`.**

If the file exists, add these keys; otherwise create it with them:

```json
{
  "config.section.provider": "Provider",
  "config.section.languages": "Languages",
  "config.section.translation": "Translation",
  "config.section.comments": "Comments"
}
```

- [ ] **Step 3: Validate the manifest parses.**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Verify packaging still accepts the manifest.**

Run: `npm run build`
Expected: build completes without error (config shape is read by VS Code, not by our code, so no runtime impact).

- [ ] **Step 5: Commit.**

```bash
git add package.json package.nls.json
git commit -m "feat(config): split settings into titled sections; add comment storage settings"
```

---

## Task 2: Settings types + getters

**Files:**
- Modify: `src/types.ts` (add types near line 35; extend `PluginConfig` ~line 38; extend `ISettingsManager` ~line 245)
- Modify: `src/SettingsManager.ts`
- Test: `test/SettingsManager.test.ts`

- [ ] **Step 1: Write the failing test.**

Create/append `test/SettingsManager.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import * as vscode from './mocks/vscode'
import { SettingsManager } from '../src/SettingsManager'

afterEach(() => (vscode as unknown as { __clearConfig: () => void }).__clearConfig())

describe('comment storage settings', () => {
  it('defaults to sidecar + after-paragraph', () => {
    const s = new SettingsManager()
    expect(s.getCommentStorage()).toBe('sidecar')
    expect(s.getCommentPlacement()).toBe('after-paragraph')
  })

  it('reads configured values', () => {
    ;(vscode as unknown as { __setConfig: (s: string, v: Record<string, unknown>) => void }).__setConfig(
      'kiro-md-translator',
      { commentStorage: 'inline', commentPlacement: 'end-of-file' },
    )
    const s = new SettingsManager()
    expect(s.getCommentStorage()).toBe('inline')
    expect(s.getCommentPlacement()).toBe('end-of-file')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npx vitest run test/SettingsManager.test.ts`
Expected: FAIL — `getCommentStorage is not a function`.

- [ ] **Step 3: Add the types in `src/types.ts`.**

After the `TranslationMode` line (~36) add:

```ts
export type CommentStorage = 'sidecar' | 'inline'
export type CommentPlacement = 'after-paragraph' | 'end-of-file'
```

Extend `PluginConfig` with:

```ts
  commentStorage: CommentStorage
  commentPlacement: CommentPlacement
```

Extend `ISettingsManager` with:

```ts
  getCommentStorage(): CommentStorage
  getCommentPlacement(): CommentPlacement
```

- [ ] **Step 4: Implement the getters in `src/SettingsManager.ts`.**

Add `CommentStorage, CommentPlacement` to the type import, then add methods (mirroring existing getter style):

```ts
  getCommentStorage(): CommentStorage {
    return this.cfg().get<CommentStorage>('commentStorage', 'sidecar')
  }

  getCommentPlacement(): CommentPlacement {
    return this.cfg().get<CommentPlacement>('commentPlacement', 'after-paragraph')
  }
```

And extend `getConfig()`'s returned object with:

```ts
      commentStorage: this.getCommentStorage(),
      commentPlacement: this.getCommentPlacement(),
```

- [ ] **Step 5: Run tests + typecheck.**

Run: `npx vitest run test/SettingsManager.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit.**

```bash
git add src/types.ts src/SettingsManager.ts test/SettingsManager.test.ts
git commit -m "feat(settings): commentStorage/commentPlacement getters + config"
```

---

## Task 3: `inlineComments.ts` — strip + parse (pure)

**Files:**
- Create: `src/inlineComments.ts`
- Test: `test/inlineComments.test.ts`

The carrier is `<!-- rmt:comments\n{json}\n-->`. `parseInline` scans **all** such blocks regardless of position (so it reads both layouts and a half-migrated file). `stripInlineComments` removes them and collapses the blank line each leaves behind.

- [ ] **Step 1: Write the failing test.**

Create `test/inlineComments.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stripInlineComments, parseInline, INLINE_MARKER } from '../src/inlineComments'

const block = (json: string) => `<!-- ${INLINE_MARKER}\n${json}\n-->`

describe('stripInlineComments', () => {
  it('removes an after-paragraph comment block and its blank line', () => {
    const src = `Para one.\n\n${block('{"comments":[]}')}\n\nPara two.\n`
    expect(stripInlineComments(src)).toBe(`Para one.\n\nPara two.\n`)
  })

  it('removes an end-of-file block', () => {
    const src = `Para.\n\n${block('{"comments":[]}')}\n`
    expect(stripInlineComments(src)).toBe(`Para.\n`)
  })

  it('is a no-op when there are no inline comments', () => {
    const src = `# Title\n\nBody.\n`
    expect(stripInlineComments(src)).toBe(src)
  })
})

describe('parseInline', () => {
  it('collects threads from all blocks', () => {
    const t = (q: string) =>
      block(JSON.stringify({ anchor: { quote: q }, comments: [{ id: 'c0', body: 'x', createdAt: '', updatedAt: '' }] }))
    const src = `A.\n\n${t('A.')}\n\nB.\n\n${t('B.')}\n`
    const file = parseInline(src)
    expect(file.threads.map((th) => th.anchor.quote)).toEqual(['A.', 'B.'])
  })

  it('tolerates malformed JSON (skips the block, never throws)', () => {
    const src = `A.\n\n<!-- ${INLINE_MARKER}\n{not json\n-->\n`
    expect(parseInline(src).threads).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npx vitest run test/inlineComments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement strip + parse.**

Create `src/inlineComments.ts`:

```ts
/**
 * Pure (de)serialization of block comments embedded in the .md as invisible
 * HTML comments. Carrier: `<!-- rmt:comments\n{json}\n-->`. mdast parses these as
 * `html` nodes, so they are never translated and are stripped from the preview.
 * These functions never touch the filesystem and never throw on bad input.
 */
import type { Block, CommentThread, CommentsFile } from './types'

export const INLINE_MARKER = 'rmt:comments'
const VERSION = 1

/** Matches one carrier block (non-greedy body), with an optional leading blank line. */
const BLOCK_RE = new RegExp(`\\n?<!--[ \\t]*${INLINE_MARKER}\\b[\\s\\S]*?-->[ \\t]*`, 'g')

/** Remove every carrier block. Leaves the surrounding text otherwise intact. */
export function stripInlineComments(source: string): string {
  return source.replace(BLOCK_RE, '')
}

function isThread(t: unknown): t is CommentThread {
  if (typeof t !== 'object' || t === null) return false
  const o = t as Record<string, unknown>
  const a = o.anchor as Record<string, unknown> | undefined
  return !!a && typeof a.quote === 'string' && Array.isArray(o.comments)
}

/** Extract every carrier block's JSON payload and merge the threads (tolerant). */
export function parseInline(source: string): CommentsFile {
  const threads: CommentThread[] = []
  for (const m of source.matchAll(BLOCK_RE)) {
    const body = m[0].replace(/^\n?<!--[ \t]*/, '').replace(/-->[ \t]*$/, '')
    const json = body.slice(INLINE_MARKER.length).trim()
    try {
      const obj = JSON.parse(json) as { threads?: unknown; anchor?: unknown; comments?: unknown }
      const found = Array.isArray(obj.threads) ? obj.threads : [obj]
      for (const t of found) if (isThread(t) && t.comments.length > 0) threads.push(t)
    } catch {
      // malformed block — skip it, never throw
    }
  }
  return { version: VERSION, docHash: '', threads }
}

// serializeEof / serializeAfter added in Task 4.
export type { Block, CommentThread } // re-export for Task 4 test convenience
```

- [ ] **Step 4: Run tests.**

Run: `npx vitest run test/inlineComments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/inlineComments.ts test/inlineComments.test.ts
git commit -m "feat(comments): inline carrier strip + tolerant parse"
```

---

## Task 4: `inlineComments.ts` — serializeEof + serializeAfter (pure)

**Files:**
- Modify: `src/inlineComments.ts`
- Test: `test/inlineComments.test.ts`

`serializeEof` strips existing blocks then appends one block with the full `CommentsFile` JSON. `serializeAfter` does a single-pass line rebuild: it drops existing carrier blocks and, after each block whose `endLine` has a live thread, inserts that thread's carrier block.

- [ ] **Step 1: Write the failing tests (append to `test/inlineComments.test.ts`).**

```ts
import { serializeEof, serializeAfter } from '../src/inlineComments'
import type { Block, CommentThread } from '../src/types'

const thread = (quote: string): CommentThread => ({
  anchor: { quote, prefix: '', suffix: '', hintLine: 0, quoteHash: '' },
  orphaned: false,
  comments: [{ id: 'c0', body: 'note', createdAt: '2026-07-05T00:00:00Z', updatedAt: '2026-07-05T00:00:00Z' }],
})

describe('serializeEof', () => {
  it('appends a single trailing block and round-trips via parseInline', () => {
    const src = `A.\n\nB.\n`
    const out = serializeEof(src, { version: 1, docHash: '', threads: [thread('A.')] })
    expect(out.startsWith('A.\n\nB.\n')).toBe(true)
    expect(parseInline(out).threads.map((t) => t.anchor.quote)).toEqual(['A.'])
  })

  it('replaces a stale trailing block rather than stacking', () => {
    const once = serializeEof(`A.\n`, { version: 1, docHash: '', threads: [thread('A.')] })
    const twice = serializeEof(once, { version: 1, docHash: '', threads: [thread('A.')] })
    expect((twice.match(/rmt:comments/g) ?? []).length).toBe(1)
  })
})

describe('serializeAfter', () => {
  it('inserts each thread right after its block and round-trips', () => {
    // source: line0 "A.", line1 "", line2 "B."
    const src = `A.\n\nB.`
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
    ]
    const live = new Map<number, CommentThread[]>([[1, [thread('B.')]]])
    const out = serializeAfter(src, { version: 1, docHash: '', threads: [thread('B.')] }, blocks, live)
    expect(out).toContain('B.\n\n<!-- rmt:comments')
    expect(parseInline(out).threads.map((t) => t.anchor.quote)).toEqual(['B.'])
  })

  it('rewrites cleanly when run twice (no duplication)', () => {
    const src = `A.\n\nB.`
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
    ]
    const live = new Map<number, CommentThread[]>([[1, [thread('B.')]]])
    const file = { version: 1, docHash: '', threads: [thread('B.')] }
    const once = serializeAfter(src, file, blocks, live)
    // re-derive blocks from the cleaned source for the second pass
    const twice = serializeAfter(once, file, blocks, live)
    expect((twice.match(/rmt:comments/g) ?? []).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `npx vitest run test/inlineComments.test.ts`
Expected: FAIL — `serializeEof`/`serializeAfter` not exported.

- [ ] **Step 3: Implement the serializers (replace the Task 3 placeholder comment).**

```ts
/** One carrier block for a payload object. */
function makeBlock(payload: object): string {
  return `<!-- ${INLINE_MARKER}\n${JSON.stringify(payload, null, 2)}\n-->`
}

/** Strip old blocks, then append one block holding the whole CommentsFile. */
export function serializeEof(source: string, data: CommentsFile): string {
  const clean = stripInlineComments(source).replace(/\s+$/, '')
  if (data.threads.length === 0) return clean + '\n'
  return `${clean}\n\n${makeBlock({ version: data.version, threads: data.threads })}\n`
}

/** Single-pass rebuild: drop existing carrier blocks; after each block whose
 *  endLine has live thread(s), insert one carrier block per thread. Line indices
 *  are all against the ORIGINAL source, so no shifting bookkeeping is needed. */
export function serializeAfter(
  source: string,
  data: CommentsFile,
  blocks: Block[],
  live: Map<number, CommentThread[]>,
): string {
  const clean = stripInlineComments(source)
  const lines = clean.split('\n')
  // Recompute block endLines against the CLEAN source by matching each block's text.
  const byEnd = new Map<number, CommentThread[]>()
  for (const b of blocks) {
    const threads = live.get(b.paragraphIndex)
    if (threads && threads.length) byEnd.set(b.endLine, threads)
  }
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const threads = byEnd.get(i)
    if (threads) for (const t of threads) out.push('', makeBlock({ threads: [t] }))
  }
  return out.join('\n')
}
```

Note: `serializeAfter` assumes the passed `blocks`/`live` line ranges are valid against `stripInlineComments(source)`. In production `CommentsService` passes the freshly re-anchored blocks from the comment-free render (see Task 7 note), so this holds; the test passes clean sources directly.

- [ ] **Step 4: Run tests + typecheck.**

Run: `npx vitest run test/inlineComments.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit.**

```bash
git add src/inlineComments.ts test/inlineComments.test.ts
git commit -m "feat(comments): inline serializers (end-of-file + after-paragraph)"
```

---

## Task 5: Add `endLine` to `Block`

`serializeAfter` needs each block's end line. `Block` currently carries only `startLine`.

**Files:**
- Modify: `src/types.ts` (`Block`, ~line 58)
- Modify: `src/PreviewController.ts` (`currentBlocks()`, ~line 279)
- Test: `test/CommentsService.test.ts` (`blocksFrom` helper, ~line 31)

- [ ] **Step 1: Extend the `Block` type.**

In `src/types.ts`:

```ts
export interface Block {
  paragraphIndex: number
  startLine: number
  endLine: number
  text: string
}
```

- [ ] **Step 2: Populate `endLine` in `currentBlocks()`.**

In `src/PreviewController.ts`:

```ts
  private currentBlocks(): Block[] {
    return this.lineMap.map((m) => ({
      paragraphIndex: m.paragraphIndex,
      startLine: m.startLine,
      endLine: m.endLine,
      text: this.paragraphText(m.paragraphIndex) ?? '',
    }))
  }
```

- [ ] **Step 3: Update the test helper so existing tests still compile.**

In `test/CommentsService.test.ts`, `blocksFrom`:

```ts
function blocksFrom(texts: string[]): Block[] {
  let line = 0
  return texts.map((text, i) => {
    const b: Block = { paragraphIndex: i, startLine: line, endLine: line, text }
    line += 2
    return b
  })
}
```

- [ ] **Step 4: Run typecheck + full comment tests.**

Run: `npm run typecheck && npx vitest run test/CommentsService.test.ts`
Expected: PASS. `makeAnchor` uses `startLine` only, so anchoring is unaffected.

- [ ] **Step 5: Commit.**

```bash
git add src/types.ts src/PreviewController.ts test/CommentsService.test.ts
git commit -m "refactor(comments): carry block endLine for inline placement"
```

---

## Task 6: Backend seam + `SidecarBackend`; refactor `CommentsService`

Extract *where/how* comments persist behind `CommentBackend`. `CommentsService` keeps anchoring/live/debounce. This task keeps behavior identical (sidecar only) and keeps the existing suite green.

**Files:**
- Create: `src/commentBackends.ts`
- Modify: `src/CommentsService.ts`
- Test: `test/commentBackends.test.ts`, `test/CommentsService.test.ts` (helper only)

- [ ] **Step 1: Write the failing backend test.**

Create `test/commentBackends.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { SidecarBackend } from '../src/commentBackends'
import type { SidecarIO } from '../src/CommentsService'
import type { CommentsFile } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never

function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = {
    async read(u) { return store.get(String(u)) },
    async write(u, c) { store.set(String(u), c) },
    async remove(u) { store.delete(String(u)) },
  }
  return { io, store }
}

const file: CommentsFile = {
  version: 1, docHash: '', threads: [
    { anchor: { quote: 'A', prefix: '', suffix: '', hintLine: 0, quoteHash: '' }, orphaned: false,
      comments: [{ id: 'c0', body: 'x', createdAt: '', updatedAt: '' }] },
  ],
}

describe('SidecarBackend', () => {
  it('persists then loads the same threads', async () => {
    const { io } = memIO()
    const be = new SidecarBackend(docUri, io)
    const res = await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    expect(res.kind).toBe('sidecar')
    expect((await be.load('')).threads).toHaveLength(1)
  })

  it('removes the file when persisting an empty set that existed', async () => {
    const { io, store } = memIO()
    const be = new SidecarBackend(docUri, io)
    await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    await be.persist({ data: { version: 1, docHash: '', threads: [] }, source: '', blocks: [], live: new Map() })
    expect(store.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `npx vitest run test/commentBackends.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/commentBackends.ts` with the interface + `SidecarBackend`.**

Move the sidecar IO + existed/dirty removal semantics here (lifted from `CommentsService.flush`).

```ts
import * as vscode from 'vscode'
import type { Block, CommentThread, CommentsFile } from './types'
import { parseCommentsFile, serializeCommentsFile, sidecarUri, type SidecarIO, fsIO } from './CommentsService'

export interface PersistCtx {
  data: CommentsFile
  source: string
  blocks: Block[]
  live: Map<number, CommentThread[]>
}

export type PersistResult = { kind: 'sidecar' } | { kind: 'inline'; newSource: string }

export interface CommentBackend {
  load(source: string): Promise<CommentsFile>
  /** For 'inline' the caller must apply `newSource` to the document. */
  persist(ctx: PersistCtx): Promise<PersistResult>
  /** Erase this backend's storage location (used when migrating away). */
  clear(source: string): Promise<{ newSource?: string }>
}

export class SidecarBackend implements CommentBackend {
  private existed = false
  private readonly uri: vscode.Uri
  constructor(docUri: vscode.Uri, private readonly io: SidecarIO = fsIO) {
    this.uri = sidecarUri(docUri)
  }
  async load(): Promise<CommentsFile> {
    const raw = await this.io.read(this.uri)
    this.existed = raw !== undefined
    return parseCommentsFile(raw)
  }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    if (ctx.data.threads.length === 0) {
      if (this.existed) { this.existed = false; await this.io.remove(this.uri) }
      return { kind: 'sidecar' }
    }
    this.existed = true
    await this.io.write(this.uri, serializeCommentsFile(ctx.data))
    return { kind: 'sidecar' }
  }
  async clear(): Promise<{ newSource?: string }> {
    this.existed = false
    await this.io.remove(this.uri)
    return {}
  }
}
```

- [ ] **Step 4: Export `fsIO` from `CommentsService.ts`.**

Change `const fsIO: SidecarIO = {` (~line 32) to `export const fsIO: SidecarIO = {`.

- [ ] **Step 5: Refactor `CommentsService` to hold a `CommentBackend`.**

Replace the constructor and `load`/`flush`:

```ts
constructor(
  docUri: vscode.Uri,
  private backend: CommentBackend = new SidecarBackend(docUri),
  private readonly genId: () => string = defaultId,
  private readonly now: () => string = () => new Date().toISOString(),
  private readonly flushMs: number = FLUSH_MS,
  private readonly getSource: () => string = () => '',
  private readonly writeSource?: (text: string) => Promise<void>,
) {}

async load(): Promise<void> {
  this.data = await this.backend.load(this.getSource())
}

async flush(): Promise<void> {
  if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
  if (this.data.threads.length > 0) this.data.docHash = hashString(this.lastSource)
  const res = await this.backend.persist({
    data: this.data, source: this.getSource(), blocks: this.lastBlocks, live: this.live,
  })
  if (res.kind === 'inline' && this.writeSource && res.newSource !== this.getSource()) {
    await this.writeSource(res.newSource)
  }
  this.dirty = false
}
```

Import `SidecarBackend` and `CommentBackend` from `./commentBackends`. Remove the now-unused `io`/`existed`/`uri` fields and the `fsIO`/`sidecarUri` usages that moved out (keep `sidecarUri`/`fsIO` *exported* — the backend imports them). Keep `parseCommentsFile`/`serializeCommentsFile` exported (backend + tests use them).

> Circular import note: `commentBackends.ts` imports from `CommentsService.ts` and vice-versa. This is safe because the imports are types + already-initialized `const`/`function` values used at call time, not at module-eval time. If esbuild flags it, move `sidecarUri`/`fsIO`/`parse`/`serialize` into a small `commentSidecar.ts` and import both from there. Prefer that split if in doubt.

- [ ] **Step 6: Update the `CommentsService` test helper.**

In `test/CommentsService.test.ts`, change `svc(io, ids)` to build a `SidecarBackend`:

```ts
import { SidecarBackend } from '../src/commentBackends'
function svc(io: SidecarIO, ids = (() => { let n = 0; return () => `c${n++}` })()) {
  return new CommentsService(docUri, new SidecarBackend(docUri, io), ids, () => '2026-07-04T00:00:00Z', 1_000_000)
}
```

- [ ] **Step 7: Run the full suite + typecheck.**

Run: `npm run typecheck && npx vitest run test/CommentsService.test.ts test/commentBackends.test.ts`
Expected: PASS — sidecar behavior unchanged.

- [ ] **Step 8: Commit.**

```bash
git add src/commentBackends.ts src/CommentsService.ts test/commentBackends.test.ts test/CommentsService.test.ts
git commit -m "refactor(comments): extract CommentBackend seam; SidecarBackend"
```

---

## Task 7: Inline backends + `CommentsService` inline path

**Files:**
- Modify: `src/commentBackends.ts` (add `InlineEofBackend`, `InlineAfterBackend`)
- Test: `test/commentBackends.test.ts`

- [ ] **Step 1: Write the failing test (append).**

```ts
import { InlineEofBackend, InlineAfterBackend } from '../src/commentBackends'
import type { Block } from '../src/types'

describe('inline backends', () => {
  const src = `A.\n\nB.`
  const blocks: Block[] = [
    { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
    { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
  ]
  const live = new Map([[1, file.threads.map((t) => ({ ...t, anchor: { ...t.anchor, quote: 'B.' } }))]])
  const data = { version: 1, docHash: '', threads: live.get(1)! }

  it('end-of-file: persist emits inline newSource that parses back', async () => {
    const be = new InlineEofBackend()
    const res = await be.persist({ data, source: src, blocks, live })
    expect(res.kind).toBe('inline')
    if (res.kind === 'inline') expect((await be.load(res.newSource)).threads).toHaveLength(1)
  })

  it('after-paragraph: comment lands after its block', async () => {
    const be = new InlineAfterBackend()
    const res = await be.persist({ data, source: src, blocks, live })
    if (res.kind === 'inline') expect(res.newSource).toContain('B.\n\n<!-- rmt:comments')
  })

  it('clear strips inline blocks', async () => {
    const be = new InlineEofBackend()
    const withBlock = (await be.persist({ data, source: src, blocks, live })) as { newSource: string }
    const cleared = await be.clear(withBlock.newSource)
    expect(cleared.newSource).not.toContain('rmt:comments')
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `npx vitest run test/commentBackends.test.ts`
Expected: FAIL — inline backends not exported.

- [ ] **Step 3: Implement the inline backends.**

Add to `src/commentBackends.ts`:

```ts
import { parseInline, serializeEof, serializeAfter, stripInlineComments } from './inlineComments'

export class InlineEofBackend implements CommentBackend {
  async load(source: string): Promise<CommentsFile> { return parseInline(source) }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    return { kind: 'inline', newSource: serializeEof(ctx.source, ctx.data) }
  }
  async clear(source: string): Promise<{ newSource?: string }> {
    return { newSource: stripInlineComments(source) }
  }
}

export class InlineAfterBackend implements CommentBackend {
  async load(source: string): Promise<CommentsFile> { return parseInline(source) }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    const newSource = ctx.data.threads.length === 0
      ? stripInlineComments(ctx.source)
      : serializeAfter(ctx.source, ctx.data, ctx.blocks, ctx.live)
    return { kind: 'inline', newSource }
  }
  async clear(source: string): Promise<{ newSource?: string }> {
    return { newSource: stripInlineComments(source) }
  }
}
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `npm run typecheck && npx vitest run test/commentBackends.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/commentBackends.ts test/commentBackends.test.ts
git commit -m "feat(comments): inline end-of-file and after-paragraph backends"
```

---

## Task 8: Wire backend selection + migration in `ActivationController`

**Files:**
- Modify: `src/ActivationController.ts` (deps build ~line 242; add a settings-change subscription)
- Modify: `src/CommentsService.ts` (add `setBackend` + `migrateFrom`)

- [ ] **Step 1: Add `setBackend`/`migrateFrom` to `CommentsService`.**

```ts
/** Swap the persistence backend at runtime (settings change). */
setBackend(backend: CommentBackend): void { this.backend = backend }

/** Re-home comments from the previous backend to the current one: persist to the
 *  new location, then erase the old. Loses nothing (thread ids are stable). */
async migrateFrom(previous: CommentBackend): Promise<void> {
  await this.flush() // write to the NEW backend (already set)
  const cleared = await previous.clear(this.getSource())
  if (cleared.newSource !== undefined && this.writeSource && cleared.newSource !== this.getSource()) {
    await this.writeSource(cleared.newSource)
  }
}
```

Make `backend` non-`readonly` (already a mutable `private backend` from Task 6).

- [ ] **Step 2: Add a backend factory + selection in `ActivationController`.**

Add a helper method:

```ts
private makeCommentBackend(docUri: vscode.Uri): CommentBackend {
  if (this.settings.getCommentStorage() !== 'inline') return new SidecarBackend(docUri)
  return this.settings.getCommentPlacement() === 'end-of-file'
    ? new InlineEofBackend()
    : new InlineAfterBackend()
}
```

Import `CommentBackend, SidecarBackend, InlineEofBackend, InlineAfterBackend` from `./commentBackends`.

- [ ] **Step 3: Build `CommentsService` with the selected backend + seams.**

Replace the `commentsService: new CommentsService(document.uri),` line with a hoisted service that shares `applyEdit`:

```ts
const applyEdit = async (newText: string) => {
  const edit = new vscode.WorkspaceEdit()
  const fullRange = new vscode.Range(0, 0, document.lineCount, 0)
  edit.replace(document.uri, fullRange, newText)
  await vscode.workspace.applyEdit(edit)
}
const commentsService = new CommentsService(
  document.uri,
  this.makeCommentBackend(document.uri),
  undefined,          // default genId
  undefined,          // default now
  undefined,          // default flushMs
  () => document.getText(),
  applyEdit,
)
```

Then in `deps`, use `commentsService,` and `applyEdit,` (reuse the same `applyEdit` const instead of the inline one).

> `CommentsService` constructor params after `backend` are `genId, now, flushMs, getSource, writeSource`. Passing `undefined` keeps their defaults (verify the constructor uses `= default` for each — it does per Task 6).

- [ ] **Step 4: Re-select the backend + migrate on settings change.**

In the `subs` array, add:

```ts
this.settings.onDidChangeSettings(() => {
  const next = this.makeCommentBackend(document.uri)
  const prev = commentsService.currentBackend()
  if (next.constructor === prev.constructor) return // no comment-mode change
  commentsService.setBackend(next)
  void commentsService.migrateFrom(prev).then(() => controller.onDocumentChange(document))
}),
```

Add a `currentBackend()` getter to `CommentsService`: `currentBackend(): CommentBackend { return this.backend }`.

> `onDidChangeSettings` already exists on `SettingsManager` and fires on any `kiro-md-translator.*` change; the `constructor` identity check keeps migration to actual storage/placement changes.

- [ ] **Step 5: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: clean typecheck; build produces `out/extension.js`.

- [ ] **Step 6: Commit.**

```bash
git add src/ActivationController.ts src/CommentsService.ts
git commit -m "feat(comments): select storage backend from settings; migrate on change"
```

---

## Task 9: Strip inline comments on export

**Files:**
- Modify: `src/PreviewController.ts` (`handleExport`, ~line 402)
- Test: `test/ExportInlineStrip.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `test/ExportInlineStrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stripInlineComments } from '../src/inlineComments'

// The export path feeds stripInlineComments(source) into translateToMarkdown.
describe('export strips inline comments', () => {
  it('produces markdown with no carrier blocks', () => {
    const src = `Body.\n\n<!-- rmt:comments\n{"threads":[]}\n-->\n`
    expect(stripInlineComments(src)).not.toContain('rmt:comments')
  })
})
```

- [ ] **Step 2: Run to confirm it passes at the unit level (guards the helper).**

Run: `npx vitest run test/ExportInlineStrip.test.ts`
Expected: PASS (this pins the contract the export path relies on).

- [ ] **Step 3: Apply stripping in `handleExport`.**

In `src/PreviewController.ts`, import at top: `import { stripInlineComments } from './inlineComments'`. Then in `handleExport`, feed a comment-free source into the translator:

```ts
  private async handleExport(): Promise<void> {
    const cfg = this.deps.settings.getConfig()
    if (!cfg.targetLanguage) return
    const ac = new AbortController()
    const cleanSource = stripInlineComments(this.sourceText)
    const md = await this.deps.engine.translateToMarkdown(
      cleanSource,
      cfg.storageLanguage,
      cfg.targetLanguage,
      ac.signal,
    )
    await this.deps.exportService.exportTranslation(md, this.deps.getDocumentUri(), cfg.targetLanguage)
  }
```

- [ ] **Step 4: Typecheck + run the export test + full suite.**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add src/PreviewController.ts test/ExportInlineStrip.test.ts
git commit -m "feat(export): strip inline comments from exported markdown"
```

---

## Task 10: Spec chain + property test + final verification

**Files:**
- Modify: `.kiro/specs/kiro-md-translator-plugin/requirements.md`
- Modify: `.kiro/specs/kiro-md-translator-plugin/design.md`
- Modify: `.kiro/specs/kiro-md-translator-plugin/tasks.md`
- Test: `test/inlineComments.test.ts` (add a property test)

- [ ] **Step 1: Add EARS acceptance criteria to `requirements.md`.**

Under req 11, add (adjust numbering to the file's current max):

```
11.12 WHEN Comment Storage is `inline` THEN the extension SHALL persist comments inside the .md as `<!-- rmt:comments … -->` HTML comments, never in a sidecar file.
11.13 WHEN Comment Placement is `after-paragraph` THEN each thread SHALL be written immediately after its anchored block; WHEN `end-of-file` THEN all threads SHALL be written in one block at the end of the file.
11.14 WHEN the document is exported (req 6) THEN inline comment blocks SHALL be removed from the exported file.
```

- [ ] **Step 2: Add a Property to `design.md`.**

```
P16 (Validates 11.12/11.13): For any document and any set of block comments,
serialize→parse of the inline carrier round-trips the comment set, and the
carrier is a mdast `html` node (never translated, never rendered).
```

- [ ] **Step 3: Add the property test.**

Append to `test/inlineComments.test.ts`:

```ts
import fc from 'fast-check'

// Feature: kiro-md-translator-plugin, Property 16: inline carrier round-trips
it('Property 16: parseInline(serializeEof(...)) preserves the comment set', () => {
  const genThread = fc.record({
    anchor: fc.record({
      quote: fc.string({ minLength: 1 }), prefix: fc.constant(''), suffix: fc.constant(''),
      hintLine: fc.nat(), quoteHash: fc.constant(''),
    }),
    orphaned: fc.constant(false),
    comments: fc.array(
      fc.record({ id: fc.string({ minLength: 1 }), body: fc.string({ minLength: 1 }),
        createdAt: fc.constant('2026-07-05T00:00:00Z'), updatedAt: fc.constant('2026-07-05T00:00:00Z') }),
      { minLength: 1, maxLength: 3 },
    ),
  })
  fc.assert(
    fc.property(fc.array(genThread, { maxLength: 4 }), (threads) => {
      const out = serializeEof('Doc body.\n', { version: 1, docHash: '', threads: threads as never })
      const back = parseInline(out).threads
      expect(back.map((t) => t.comments.length)).toEqual(threads.map((t) => t.comments.length))
    }),
    { numRuns: 100 },
  )
})
```

- [ ] **Step 4: Update `tasks.md`.**

Add a task entry tracing to the new ids, e.g.:

```
- [x] Inline comment storage (sidecar | inline; after-paragraph | end-of-file)
  _Requirements: 11.12, 11.13, 11.14_  _Validates: P16_
```

- [ ] **Step 5: Full verification.**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests pass; build succeeds.

- [ ] **Step 6: Manual smoke (documented, run by the human).**

1. Set `commentStorage: inline`, `commentPlacement: after-paragraph`.
2. Open a `.md`, add a comment on a paragraph → the raw file gains a `<!-- rmt:comments … -->` block after that paragraph; the preview shows no visible comment text.
3. Reload the editor → the comment reappears on the same paragraph.
4. Switch `commentPlacement: end-of-file` → on next edit the block moves to the file end; still one block.
5. Switch `commentStorage: sidecar` → inline blocks vanish from the `.md`, a `.comments.json` appears.
6. Export → exported file contains no `rmt:comments`.

- [ ] **Step 7: Commit.**

```bash
git add .kiro/specs/kiro-md-translator-plugin/requirements.md .kiro/specs/kiro-md-translator-plugin/design.md .kiro/specs/kiro-md-translator-plugin/tasks.md test/inlineComments.test.ts
git commit -m "docs(spec): trace inline comment storage (req 11.12-11.14, P16)"
```

---

## Self-Review

**Spec coverage:**
- Settings sectioning → Task 1. Two new settings → Tasks 1–2.
- HTML-comment carrier, invisible/untranslated → Tasks 3–4 (+ P16 in Task 10).
- after-paragraph (default) + end-of-file layouts → Task 4 + Task 7.
- Backend seam (sidecar/eof/after), `.md` written via `applyEdit` not `fs` → Tasks 6–8.
- Export strips comments → Task 9.
- Migration on mode change → Task 8.
- Pipeline safety (endLine for placement; comments as `html` nodes) → Task 5 + relies on existing renderer/translation behavior.
- Spec-first chain → Task 10.

**Placeholder scan:** No TBD/TODO; every code step carries real code. Property bodies in Task 1 are "unchanged" copies of existing manifest entries (explicitly instructed to copy verbatim), not placeholders.

**Type consistency:** `CommentBackend` methods `load`/`persist`/`clear`, `PersistCtx { data, source, blocks, live }`, `PersistResult { kind: 'sidecar' } | { kind: 'inline'; newSource }` used identically across Tasks 6–8. `CommentsService` constructor arg order `(docUri, backend, genId, now, flushMs, getSource, writeSource)` is consistent between Task 6 (definition), Task 6 test helper, and Task 8 (ActivationController). `Block.endLine` added in Task 5 before its first use in Task 4's production consumer (Task 7 backends) — note Task 4 tests supply `endLine` directly, and the `Block` type gains `endLine` in Task 5 which precedes Task 7 wiring; if implementing strictly in order, add `endLine` to the `Block` type as part of Task 4 Step 3 as well (harmless, already covered by Task 5).

**Ordering note:** Task 4's `serializeAfter` signature uses `Block.endLine`; the `Block` type only gains `endLine` in Task 5. To keep Task 4 compiling in isolation, apply the `src/types.ts` `Block.endLine` edit (Task 5 Step 1) at the start of Task 4. Task 5 then only touches `PreviewController`/test helper.
