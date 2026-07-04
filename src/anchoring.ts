/**
 * Pure content re-anchoring for block comments (req 11.4/11.9). No `vscode`
 * import — this is the testable core (Property 19). Given a comment's stored
 * anchor and the CURRENT document blocks, it decides which block the comment
 * now points to, or that it is orphaned. It prefers an orphan over a wrong
 * match — the trust-critical invariant — and never mutates the source.
 */
import type { Block, CommentAnchor } from './types'

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

/** Sørensen–Dice coefficient over character bigrams ∈ [0,1]; 1 iff identical. */
export function diceSimilarity(a: string, b: string): number {
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
 *  block is gone). `prefix`/`suffix` are the adjacent blocks' text (context). */
export function makeAnchor(blocks: Block[], paragraphIndex: number): CommentAnchor | undefined {
  const i = blocks.findIndex((b) => b.paragraphIndex === paragraphIndex)
  if (i < 0) return undefined
  const quote = blocks[i].text
  return {
    quote,
    prefix: i > 0 ? blocks[i - 1].text : '',
    suffix: i < blocks.length - 1 ? blocks[i + 1].text : '',
    hintLine: blocks[i].startLine,
    quoteHash: hashString(quote),
  }
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
