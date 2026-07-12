# Comment & Edit Affordance Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Gutter shows only existing-comment markers; actions appear at the cursor on selection; comments bind to trimmed text fragments (overlaps allowed); code blocks and table rows become first-class editable/commentable/hoverable units.

**Architecture:** Generalise three things already in the codebase — the text-quote anchor (`anchoring.ts`), the many-threads-per-block store (`CommentsService`), and the CSS Custom Highlight API (`previewPanel.ts`) — rather than rewrite. Staged so each stage ships on its own.

**Spec:** `docs/superpowers/specs/2026-07-12-comment-affordance-redesign-design.md`

---

## Stage 1 — Block model (code blocks + table rows become indexed units)

**Why first:** it is the foundation (everything else needs code blocks/rows to be indexed) and it alone closes "code blocks have no icons" and brings tables to life. The engine already scans code-block comments and refuses to send code, so an indexed `<pre>` gets correct hover/edit for free.

### Task 1.1: Index `<pre>` and `<tr>`

**Files:**
- Modify: `src/MarkdownRenderer.ts:15` (`BLOCK_TAGS`), `buildLineMap`, `annotate`
- Test: `test/MarkdownRenderer.test.ts`

- [ ] **Step 1: failing test** — a doc with a fenced code block and a GFM table asserts the `<pre>` and each `<tr>` carry a `data-paragraph-index`, `<table>`/`<th>`/`<td>` do NOT, and the lineMap ranges match the source (pre spans its fence lines, each tr its own line).

```ts
it('indexes code blocks and table rows, not the table wrapper', () => {
  const md = 'Intro.\n\n```js\nconst x = 1 // n\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |'
  const { html, lineMap } = new MarkdownRenderer().renderMdast(
    new MarkdownRenderer().parse(md), Uri.file('/d') as never)
  expect(/<pre[^>]*data-paragraph-index="1"/.test(html)).toBe(true)
  // table rows indexed, table/cells not
  const idxCount = (html.match(/data-paragraph-index/g) ?? []).length
  expect(idxCount).toBe(5) // p(0) + pre(1) + 3 tr(2,3,4)  — header row + 2 body rows
  expect(html).not.toMatch(/<table[^>]*data-paragraph-index/)
  expect(html).not.toMatch(/<td[^>]*data-paragraph-index/)
})
```

- [ ] **Step 2: run, expect FAIL** (`npx vitest run test/MarkdownRenderer.test.ts`).
- [ ] **Step 3: implement** — `const BLOCK_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','li','pre','tr'])`. Verify `buildLineMap`/`annotate` need no other change (they already filter on `BLOCK_TAGS`).
- [ ] **Step 4: run, expect PASS**, then `npm test` — the shared-index contract means every existing scroll/anchor test must still pass; if any asserts a specific index that shifted because a `<pre>`/`<tr>` now precedes it, update the expected index (this is the lock-step contract working as intended).
- [ ] **Step 5: commit** `feat(preview): index code blocks and table rows as blocks (req 10.8)`.

### Task 1.2: Paragraph text + translation for a code block and a table row

**Files:**
- Modify: `src/PreviewController.ts` (`handleHover`, `handleEditParagraph`, `paragraphText` already returns the range)
- Modify: `src/TranslationEngine.ts` (`translateParagraph` — the fenced branch already exists; add a table-row branch that translates only cell text, not the `|` scaffolding)
- Test: `test/TranslationEngine.test.ts`, `test/PreviewController.test.ts`

- [ ] **Step 1: failing test** — `translateParagraph('| 1 | 2 |', …)` must send only the cell texts (`1`, `2`), never the `|` scaffolding, and reassemble the row. A code block routes through the existing fenced branch (already tested).

```ts
it('translateParagraph on a table row translates cells, not the pipes', async () => {
  const seen: string[] = []
  const { engine } = makeEngine(async (s) => { seen.push(...s); return s.map((x) => `T(${x})`) })
  const out = await engine.translateParagraph('| one | two |', 'en', 'de', new AbortController().signal)
  expect(seen).toEqual(['one', 'two'])
  expect(out).toContain('T(one)')
  expect(out).toContain('T(two)')
})
```

- [ ] **Step 2: run FAIL. Step 3: implement** — detect a leading `|` (GFM row); parse the row as markdown, run `collectUnits`, stringify (display-only, same pattern as the list-item branch). **Step 4: run PASS + `npm test`.**
- [ ] **Step 5:** verify the edit modal on a code block suppresses nothing harmful — the Target field shows the code with translated comments (the engine already produces this). Add a `PreviewController` test that editing a `<pre>` block fills Target from `translateParagraph` without sending the code.
- [ ] **Step 6: commit** `feat(preview): hover + edit translation for code blocks and table rows`.

### Task 1.3: Spec chain for Stage 1

- [ ] Amend req 10.8 (indexed block set adds code block + table row); add the block-kind note for the code path. Add a Property for "a code block / table row is indexed and its lineMap range matches source". `.kiro/specs` — working-tree only, not committed.

---

## Stage 2 — Cursor toolbar (actions move off the gutter)

*Detailed when Stage 1 lands. Shape:*
- Webview: on `selectionchange` inside `#content` with a non-empty selection, position a small floating toolbar (edit, comment) near the selection's client rect. Hide on empty selection / scroll / Esc.
- The gutter keeps ONLY `.bctl-comment.has` (existing-comment marker); remove the edit pencil and the always-drawn comment-add icon from `drawBlockControls`.
- Edit action → resolve the selection's home block index (nearest ancestor `[data-paragraph-index]`) → existing `editParagraph` message. Comment action → Stage 3.
- No host/protocol change; no storage change. Tests: puppeteer harness (selection → toolbar appears at rect; Esc hides; gutter no longer shows action icons).

---

## Stage 3 — Fragment anchoring (comment binds to trimmed selection)

*Detailed when Stage 2 lands. Shape:*
- New pure `fragments.ts`: `trim(sel)` drops edge whitespace then edge Unicode-punctuation, never interior; returns `{ text, startOffsetInBlock }` or null if empty after trim. Property: idempotent, interior chars preserved.
- Generalise `anchoring.ts`: `makeAnchor` takes an optional fragment `{quote, offset}`; `matchThread` returns `{paragraphIndex, start, end}` (sub-span) instead of just the index. Old records (quote = whole block) resolve to the full span — no migration.
- `CommentsService`: `addComment(paragraphIndex, fragment)` creates a NEW thread per distinct fragment (not `live.get(idx)[0]`); the live map value stays `CommentThread[]`. Record format gains `version: 2` + `range`.
- Webview: paint each fragment via `CSS.highlights` (a named highlight per block, ranges added; overlaps native). No DOM mutation.
- Properties: sub-block anchor round-trips; stable under edits (same fragment or orphan, never another); overlapping ranges both render.

---

## Stage 4 — Group affordance (count + popover list)

*Detailed when Stage 3 lands. Shape:*
- Gutter marker shows fragment count (reuse `.cmt-count`). Hover → a compact popover list over the content, one row per fragment (its text); row hover → highlight that fragment; row click → open its discussion.
- Replaces the single-thread modal-open. Popover chosen over an icon fan (gutter is ~45px; a vertical fan re-creates the dense-list overlap bug fixed in `82d3e2a`).
- Tests: puppeteer (count shown; hover expands; row hover highlights the right span; click opens the right thread).

---

## Self-review note

Stage 1 is the only stage fully detailed here on purpose — Stages 2–4 depend on how 1 lands and are specified at the shape level to avoid planning fiction. Each stage is re-planned in detail (bite-sized, TDD) before it starts. The shared-index lock-step (Task 1.1 Step 4) is the highest-risk point: source and translated renders MUST assign identical indices, which they do because both filter on the one `BLOCK_TAGS` set.
