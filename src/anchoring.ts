/**
 * Pure content re-anchoring for block comments (req 11.4/11.9). No `vscode`
 * import — this is the testable core (Property 19). Given a comment's stored
 * anchor and the CURRENT document blocks, it decides which block the comment
 * now points to, or that it is orphaned. It prefers an orphan over a wrong
 * match — the trust-critical invariant — and never mutates the source.
 */
import type { Block, CommentAnchor, FragmentAnchor, ResolvedLocation, ResolvedSpan } from './types'

/** Block context kept on each side of a fragment, to disambiguate a repeat. */
export const FRAGMENT_CTX = 24

/** Fuzzy match acceptance bar (Sørensen–Dice on character bigrams). */
export const FUZZY_THRESHOLD = 0.7

/** djb2 hash → base-36. A cheap fast-equality digest, NOT cryptographic. */
export function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Collapse whitespace runs to a single space and trim — the "normalized" match. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** Sørensen–Dice coefficient over character bigrams ∈ [0,1]; 1 iff identical.
 *  Non-string inputs score 0 — a defensive guard so a malformed/untrusted anchor
 *  (e.g. a hand-crafted sidecar with a missing `prefix`/`suffix`) cannot throw. */
export function diceSimilarity(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  let total = 0
  for (const n of A.values()) total += n
  for (const n of B.values()) total += n
  let inter = 0
  for (const [g, na] of A) {
    const nb = B.get(g)
    if (nb) inter += Math.min(na, nb)
  }
  return total === 0 ? 0 : (2 * inter) / total
}

/** Build an anchor for `paragraphIndex` from the current blocks (undefined if the
 *  block is gone). `prefix`/`suffix` are the adjacent blocks' text (context). When
 *  `fragment` (a char span within the block's text) is given, the anchor also pins the
 *  comment to that sub-span, with its own in-block prefix/suffix to survive repeats. */
export function makeAnchor(
  blocks: Block[],
  paragraphIndex: number,
  fragment?: { start: number; end: number },
): CommentAnchor | undefined {
  const i = blocks.findIndex((b) => b.paragraphIndex === paragraphIndex)
  if (i < 0) return undefined
  const quote = blocks[i].text
  const anchor: CommentAnchor = {
    quote,
    prefix: i > 0 ? blocks[i - 1].text : '',
    suffix: i < blocks.length - 1 ? blocks[i + 1].text : '',
    hintLine: blocks[i].startLine,
    quoteHash: hashString(quote),
  }
  if (fragment && fragment.start < fragment.end && fragment.end <= quote.length) {
    anchor.fragment = {
      quote: quote.slice(fragment.start, fragment.end),
      prefix: quote.slice(Math.max(0, fragment.start - FRAGMENT_CTX), fragment.start),
      suffix: quote.slice(fragment.end, fragment.end + FRAGMENT_CTX),
    }
  }
  return anchor
}

/** Locate a fragment's char span within a block's current text, or undefined if its
 *  text is gone (→ orphan, never a guess). Repeats are disambiguated by in-block context. */
export function locateFragment(
  fragment: FragmentAnchor,
  blockText: string,
): { start: number; end: number } | undefined {
  const q = fragment.quote
  if (!q) return undefined
  const hits: number[] = []
  for (let at = blockText.indexOf(q); at >= 0; at = blockText.indexOf(q, at + 1)) hits.push(at)
  if (hits.length === 0) return undefined
  let best = hits[0]
  if (hits.length > 1) {
    let bestScore = -Infinity
    for (const at of hits) {
      const before = blockText.slice(Math.max(0, at - FRAGMENT_CTX), at)
      const after = blockText.slice(at + q.length, at + q.length + FRAGMENT_CTX)
      const score = diceSimilarity(before, fragment.prefix) + diceSimilarity(after, fragment.suffix)
      if (score > bestScore) {
        bestScore = score
        best = at
      }
    }
  }
  return { start: best, end: best + q.length }
}

/** Resolve a thread to its block AND, for a fragment comment, its char span within
 *  that block. A whole-block comment (no fragment) spans the block. A fragment whose
 *  text no longer exists in the matched block is an orphan — never the whole block. */
export function resolveThread(anchor: CommentAnchor, blocks: Block[]): ResolvedLocation | undefined {
  const paragraphIndex = matchThread(anchor, blocks)
  if (paragraphIndex === undefined) return undefined
  const block = blocks.find((b) => b.paragraphIndex === paragraphIndex)
  if (!block) return undefined
  if (!anchor.fragment) return { paragraphIndex, start: 0, end: block.text.length }
  const loc = locateFragment(anchor.fragment, block.text)
  return loc ? { paragraphIndex, start: loc.start, end: loc.end } : undefined
}

/** Build a MULTI-BLOCK comment anchor (req 10.17) from the two selection ends: the first
 *  block (`startIndex`, `startFragment` = the selected tail of that block) and the last block
 *  (`endIndex`, `endFragment` = the selected head). Undefined if either block is gone. The
 *  fragments are supplied by the caller (built from the rendered text, exactly as a single-block
 *  fragment is), so anchoring re-uses the same fragment machinery for both ends. */
export function makeSpanAnchor(
  blocks: Block[],
  startIndex: number,
  startFragment: FragmentAnchor,
  endIndex: number,
  endFragment: FragmentAnchor,
): CommentAnchor | undefined {
  const first = makeAnchor(blocks, startIndex)
  const last = makeAnchor(blocks, endIndex)
  if (!first || !last) return undefined
  first.fragment = startFragment
  first.end = {
    quote: last.quote,
    prefix: last.prefix,
    suffix: last.suffix,
    hintLine: last.hintLine,
    quoteHash: last.quoteHash,
    fragment: endFragment,
  }
  return first
}

/** Resolve a multi-block comment's two ends against the current document (req 10.17). BOTH the
 *  first and last block must re-match AND their fragment text must still exist, and the ends must
 *  stay in order (end strictly after start). Otherwise the whole span is orphaned — never a
 *  partial, wrong or inverted span (the same "orphan over a wrong match" rule as single blocks). */
export function resolveSpan(anchor: CommentAnchor, blocks: Block[]): ResolvedSpan | undefined {
  if (!anchor.end || !anchor.fragment) return undefined
  const startIndex = matchThread(anchor, blocks)
  if (startIndex === undefined) return undefined
  const startBlock = blocks.find((b) => b.paragraphIndex === startIndex)
  if (!startBlock || !locateFragment(anchor.fragment, startBlock.text)) return undefined
  // The far end is a block anchor in its own right → resolve it with the same machinery.
  const endAnchor: CommentAnchor = {
    quote: anchor.end.quote,
    prefix: anchor.end.prefix,
    suffix: anchor.end.suffix,
    hintLine: anchor.end.hintLine,
    quoteHash: anchor.end.quoteHash,
  }
  const endIndex = matchThread(endAnchor, blocks)
  if (endIndex === undefined) return undefined
  const endBlock = blocks.find((b) => b.paragraphIndex === endIndex)
  if (!endBlock || !locateFragment(anchor.end.fragment, endBlock.text)) return undefined
  if (endIndex <= startIndex) return undefined // collapsed or inverted → orphan
  return { startIndex, endIndex }
}

/** Surrounding-context similarity of a candidate block to the anchor (0..2). */
function contextScore(candidate: Block, blocks: Block[], anchor: CommentAnchor): number {
  const i = blocks.indexOf(candidate)
  const prev = i > 0 ? blocks[i - 1].text : ''
  const next = i >= 0 && i < blocks.length - 1 ? blocks[i + 1].text : ''
  return diceSimilarity(prev, anchor.prefix) + diceSimilarity(next, anchor.suffix)
}

/** Pick one block from several candidates: best surrounding context wins, ties
 *  broken by proximity to `hintLine` (weighted tiny so context dominates). */
function disambiguate(cands: Block[], blocks: Block[], anchor: CommentAnchor): number {
  if (cands.length === 1) return cands[0].paragraphIndex
  let best = cands[0]
  let bestScore = -Infinity
  for (const b of cands) {
    const score = contextScore(b, blocks, anchor) - Math.abs(b.startLine - anchor.hintLine) / 1e6
    if (score > bestScore) {
      bestScore = score
      best = b
    }
  }
  return best.paragraphIndex
}

/**
 * Resolve the anchor to a block's paragraphIndex against the current document,
 * or `undefined` when no candidate clears the bar (→ orphan). Order: exact quote,
 * then whitespace-normalized, then fuzzy (Dice ≥ FUZZY_THRESHOLD). Multiple hits
 * are disambiguated by prefix/suffix context (req 11.4).
 */
export function matchThread(anchor: CommentAnchor, blocks: Block[]): number | undefined {
  if (blocks.length === 0) return undefined

  const exact = blocks.filter((b) => b.text === anchor.quote)
  if (exact.length) return disambiguate(exact, blocks, anchor)

  const nq = normalize(anchor.quote)
  const norm = blocks.filter((b) => normalize(b.text) === nq)
  if (norm.length) return disambiguate(norm, blocks, anchor)

  const scored = blocks
    .map((b) => ({ b, s: diceSimilarity(normalize(b.text), nq) }))
    .filter((x) => x.s >= FUZZY_THRESHOLD)
  if (scored.length) {
    const best = Math.max(...scored.map((x) => x.s))
    const top = scored.filter((x) => x.s >= best - 1e-9).map((x) => x.b)
    return disambiguate(top, blocks, anchor)
  }
  return undefined
}
