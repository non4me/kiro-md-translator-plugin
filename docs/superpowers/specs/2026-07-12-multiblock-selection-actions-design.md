# Multi-block selection actions — design

> Spec id chain: Requirement 10 criteria 10.14–10.17, design Properties 29–30,
> tasks.md task 32 (in the gitignored `.kiro` spec). Continues the comment/edit
> affordance redesign (task 30).

## What changes for the user

Today, dragging a selection across the preview does two annoying things: the
reverse-translation tooltip keeps popping up over the text you are trying to
select, and the little action bar (Edit / Comment) only appears when the whole
selection sits inside one block — select across several list items or paragraphs
and nothing appears at all.

After this change:

1. **While a selection is live, only the buttons show.** The reverse-translation
   tooltip and the comment peek stay hidden for as long as a non-empty selection
   exists; the moment you clear the selection, hovering shows the translation
   again exactly as before. The only floating thing over a selection is the small
   action bar.

2. **The action bar appears for any selection** — a single word, or a span across
   many blocks (list items, paragraphs, table rows).

3. **Edit on a multi-block selection** opens the raw Markdown of the whole
   selected block range as one editable text; saving puts exactly that range of
   source lines back. It is the same surgical write the single-block edit already
   does, widened to a range — the rest of the document is never re-serialized.

4. **Comment on a multi-block selection** attaches one note to the whole selected
   span: the highlight covers the entire range, and the gutter marker sits on the
   first block of the group.

Single-block Edit and Comment behave exactly as they do now — they are the special
case where the span's first and last block are the same.

## The multi-block comment anchor (the load-bearing decision)

A note on a span must survive later edits to the source. We anchor the **two ends
of the selection independently**: the start (the selected tail of the first block)
and the end (the selected head of the last block), each pinned by the same
content-matching the single-block comments already use — the block it lives in,
plus a little surrounding text to tell repeats apart. Everything between the two
resolved ends is the span, and the highlight fills it: the tail of the first
block, every block in the middle whole, and the head of the last block.

If either end block is later deleted (its content anchor no longer matches), or the
ends resolve out of order, the comment **orphans** — it is never silently re-pinned to
a different span. Resolution is at the block level: the two ends are matched by their
block text, not by re-finding the exact selected characters, so a block that carries
inline markup (which renders differently from its source) never wrongly orphans the
comment. This is the same trust rule the single-block comments follow ("prefer an
orphan over a wrong match"): a comment that quietly moves to unrelated text is worse
than one that visibly loses its home.

The note counts as one thread on its first block, so the existing per-block marker,
count, and discussion popover keep working unchanged — the span only adds a
highlight on the blocks after the first, never a second marker.

## What this does NOT touch

- Single-block Edit and Comment keep their current behaviour and storage.
- The three comment storages (sidecar / inline / draft) and the invariant that
  only the Storage-language text is ever written to disk are unchanged. The
  translation shown in the edit modal is a display-only preview; only the edited
  source is saved.
- Block indexing and the line map are untouched — the highlight is painted with
  the browser's range-highlight overlay, so no DOM is mutated and the
  block-index/line-map contract holds.

## Stages (one logical change per commit)

1. Suppress the translation tooltip and comment peek while a selection is live.
2. The action bar appears for a multi-block selection.
3. Multi-block edit: a block-range source splice.
4. Multi-block comment: the two-ended span anchor, its highlight, and orphaning,
   with property tests for the anchor and the range splice.
