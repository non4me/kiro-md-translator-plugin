# Comment & Edit Affordance Redesign — Design

**Date:** 2026-07-12
**Status:** Approved (direction), staged
**Supersedes the interaction model of:** req 7.8, 10.8, 11.6, 11.7

## Problem

Today every interactive block shows its action icons (edit pencil, comment bubble)
in the left gutter on hover. Two things are wrong with this as the document grows:

1. **Code blocks and tables have no affordances at all.** Only paragraphs, headings
   and list items are indexed (`<pre>` and `<tr>` are not), so a code block cannot be
   edited, commented, hovered for a translation, or scroll-synced.
2. **The gutter does not scale.** Every added action is another icon crowding a ~45px
   strip against the text. And a comment can only attach to a whole block — you cannot
   comment on a single sentence, and you cannot have two comments on one paragraph
   pointing at different phrases.

## What changes for the user

The gutter stops being a toolbar. It shows **only what already exists** — a marker that
this block carries comments, with their count. Actions appear **where you are working**:
select text, and a small toolbar pops up by the cursor with *edit* and *comment*.

**Edit** always takes the whole self-contained unit the selection fell into — a paragraph,
heading, list item, code block, or table row — expanding a partial selection out to it.
Code blocks and table rows become first-class units, which is what gives them their
affordances and their hover translation.

**Comment** attaches to exactly the selected fragment, not the whole block. Edge
whitespace is dropped; edge punctuation is dropped; if nothing but punctuation was
selected, no comment is made. A block may carry many fragments, and they may overlap.

The gutter marker shows the number of fragments. Hovering it opens a compact list — one
row per fragment, showing its text; hovering a row highlights exactly that span in the
document; clicking opens its discussion.

## The load-bearing architectural facts

Three things already in the codebase make this a generalisation rather than a rewrite:

- **The comment anchor is already a text-quote anchor** — it stores the quoted text,
  its neighbouring context, and a digest, and re-finds it by exact → normalized → fuzzy
  match. Today the quote always happens to be the whole block's text. Making the quote a
  *fragment* is precisely what such an anchor is for; the matcher generalises, and its
  resilience to edits of the source comes for free.
- **The browser can paint arbitrary ranges over the document without touching it** — the
  CSS Custom Highlight API, already used for in-document find. Overlapping fragment
  highlights are native, and the block-index / line-map contract that scroll sync and
  surgical write-back depend on stays intact. Wrapping selections in tags would destroy
  exactly that contract; highlights never do.
- **The comment store already holds many threads per block** — a block index already maps
  to a *list* of threads, and the on-disk carrier already writes one per thread. Today the
  add path only ever writes the first; opening that to one-thread-per-fragment is the change.

Because an old thread's quote *is* the whole block's text, the fragment matcher finds it at
the full span and highlights the whole block. **Backward compatibility is free — no migration.**

## The four stages, each shippable on its own

### Stage 1 — Block model

Code blocks and table rows become indexed units, exactly like paragraphs. They gain a
block index and a line-map entry (source positions are present for both, verified), so they
get the gutter marker, hover translation, scroll sync, and editability. Editing a code block
shows its source with translated comments (never sending the code — the engine already does
this); editing a table row edits that row. This alone closes "code blocks have no icons" and
brings tables to life. The action icons still live in the gutter at this stage; only the set
of interactive blocks grows.

### Stage 2 — Cursor toolbar

The action set (edit, comment) moves off the gutter to a small toolbar that appears by the
cursor when text is selected. The gutter keeps only the existing-comment marker. No storage
or anchoring change — this is where the actions are *shown*, not what they *do*.

### Stage 3 — Fragment anchoring

A comment binds to the selected fragment, not the block. The selection's edges are trimmed
of whitespace and punctuation; the trimmed text becomes the anchor's quote; the matcher —
already text-quote — now resolves a quote that is a sub-span of a block and reports where in
the block it sits. The fragment is painted with a highlight (overlaps allowed, zero DOM
change). The stored record gains a version so old whole-block anchors still load and resolve
to the full block. One fragment is one thread; a second comment on the same fragment joins its
discussion, a comment on a different (even overlapping) fragment starts a new thread.

### Stage 4 — Group affordance

When a block carries several fragments, the gutter marker shows the count and, on hover,
expands into a compact list — one row per fragment with its text. Hovering a row highlights
that fragment; clicking opens its discussion. This replaces the single-thread modal-open with
a fragment picker.

## Decisions taken (defaults, correctable)

- **A comment lives within one block.** A selection spanning two paragraphs is clamped to the
  first — the thread's home block drives the gutter marker, the live map, and where the inline
  carrier is written.
- **Edge-punctuation trimming is Unicode-aware.** The trim drops leading/trailing characters in
  the Unicode punctuation classes (so `.`, `,`, `"`, `）`, `。`, `、`, `«»`, `—` all go), never
  interior ones. This matters because the extension translates into non-Latin scripts with their
  own punctuation.
- **Editing a block with anchored fragments re-resolves them after the edit** via the same
  text-quote match, exactly as an external edit already does; a fragment whose text no longer
  matches becomes an orphan (shown separately), never silently reattached — the existing
  orphan rule (req 11.9) already covers this and extends to fragments unchanged.
- **Hovering a highlighted fragment does not show its comment** — hover already owns the
  reverse-translation tooltip; the comment is reached through the gutter marker, so one gesture
  never drives two popups.

## Open surface deferred, not dropped

- **Indented (non-fenced) code blocks** cannot be told from indented paragraphs once cut out of
  the document, so an indexed `<pre>` must carry its block kind for the edit/hover path to treat
  it as code. Fenced blocks are unambiguous; indented ones are rare in practice. Carried into
  Stage 1's block metadata.
- **Table-cell vs table-row granularity.** Stage 1 indexes the row. Commenting a single cell is a
  fragment within the row's text and falls out of Stage 3 for free; editing a single cell is not
  offered (the unit is the row).

## Spec impact

- Requirements 7.8 / 10.8 (gutter action icons) are restated: the gutter shows only the
  existing-comment marker; actions appear at the cursor on selection.
- Requirement 11.6 / 11.7 (comment attaches to a block) is generalised to a fragment, with the
  block as the fragment's home.
- New criteria for: the indexed block set (adds code block, table row); the cursor toolbar; the
  fragment anchor (trimming rules, sub-block match, versioned record); the group marker + list.
- New properties for: fragment trimming is idempotent and never drops interior characters;
  sub-block anchoring round-trips and stays stable under edits; overlapping highlights render.
