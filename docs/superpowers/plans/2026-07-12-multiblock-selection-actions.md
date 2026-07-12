# Multi-block selection actions — implementation plan

> Spec: `2026-07-12-multiblock-selection-actions-design.md`.
> Spec id chain: Requirement 10 criteria 10.14–10.17, Properties 29–30, task 32.
> Four stages, each shippable and committed on its own.

**Goal:** During a live selection show only the action bar (no translation peek),
let the bar appear for word..multi-block selections, and make Edit/Comment operate
on the whole selected block range.

**Architecture:** The selection→toolbar wiring and the translation-suppression are
webview-only (browser code, verified in puppeteer). The range edit generalizes the
host's surgical line splice. The multi-block comment anchor is a pure two-ended
span model in `anchoring.ts` (property-tested), distributed to per-block highlight
quotes by `CommentsService` — the webview highlight painter is unchanged.

## File structure

- Modify `src/webview/previewPanel.ts` — suppress the hover tooltip while a
  selection is active; generalize `homeBlockOfSelection` → `selectedBlocks()`
  (ordered blocks the selection intersects); carry first/last index + a span flag
  on the toolbar; build a span anchor for the comment action.
- Modify `src/TranslationEngine.ts` — `replaceParagraphInSource` gains a block
  range (first..last index); the single-index call is the first===last case.
- Modify `src/PreviewController.ts` — `handleEditParagraph` / `handleSaveParagraph`
  accept a block range; `addComment` accepts a span end; thread the span through
  `onWebviewMessage`.
- Modify `src/anchoring.ts` — `makeSpanAnchor` / `resolveSpan` (pure two-ended
  anchor + resolve), reusing `matchThread` / `locateFragment` per end.
- Modify `src/CommentsService.ts` — store the span end on the thread; on reanchor,
  resolve the span and distribute per-block highlight quotes (count on the first
  block only); `addComment` takes the span end.
- Modify `src/types.ts` — `CommentAnchor.end?` (the last block + its end fragment);
  `WebviewMessage` `editParagraph` / `addComment` carry an optional block range /
  span end.
- Tests: `TranslationEngine.test.ts` (range splice), `anchoring.test.ts`
  (Property 29/30 span anchor), `CommentsService.test.ts` (multi-block add +
  per-block quote distribution).

## Stages (all committed separately)

1. **Suppress translation/peek during selection.** Guard the hover arm + show on
   a live non-empty selection; clear a pending/open tooltip when a selection
   forms. Puppeteer: drag a multi-item selection → no tooltip, bar visible.
2. **Toolbar for multi-block.** `selectedBlocks()` returns the intersected blocks;
   the bar positions over the selection rect and stores first/last index.
   Puppeteer: select across list items → bar appears.
3. **Multi-block edit.** Range splice in the engine; the modal loads the whole span
   source. Unit tests for the range splice (boundaries, first===last, single).
4. **Multi-block comment.** Two-ended span anchor + resolve (pure, property-tested);
   `CommentsService` distributes span quotes across blocks and orphans when an end
   is gone; the marker stays on the first block. Puppeteer: comment a span → whole
   range highlighted, one marker on the first block.
