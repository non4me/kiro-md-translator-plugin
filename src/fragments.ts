/**
 * Trimming a raw text selection down to the fragment a comment anchors to
 * (affordance redesign, stage 3). Pure, no `vscode` — the testable core.
 *
 * Edge whitespace is dropped, then edge punctuation, alternating until neither
 * moves — so `«  hello  »` trims to `hello`. Interior punctuation is NEVER
 * touched (`don't`, `a, b and c` keep their commas). The rule is Unicode-aware
 * (`\p{P}` covers `.,"»。、—…` and every script's own marks), because the
 * extension translates into non-Latin scripts. A selection that is nothing but
 * whitespace and punctuation yields no fragment.
 */

export interface Fragment {
  /** The trimmed text. */
  text: string
  /** Offset of the first kept character within the input. */
  start: number
  /** Offset just past the last kept character within the input. */
  end: number
}

const WS = /\s/u
const PUNCT = /\p{P}/u
/** A fragment must carry at least one letter or number, or it is not prose. */
const MEANINGFUL = /[\p{L}\p{N}]/u

/** Trim edge whitespace and edge punctuation from `raw`; undefined if nothing meaningful remains. */
export function trimFragment(raw: string): Fragment | undefined {
  let start = 0
  let end = raw.length
  let moved = true
  while (moved) {
    moved = false
    while (start < end && WS.test(raw[start])) (start += 1), (moved = true)
    while (end > start && WS.test(raw[end - 1])) (end -= 1), (moved = true)
    while (start < end && PUNCT.test(raw[start])) (start += 1), (moved = true)
    while (end > start && PUNCT.test(raw[end - 1])) (end -= 1), (moved = true)
  }
  if (start >= end) return undefined
  const text = raw.slice(start, end)
  if (!MEANINGFUL.test(text)) return undefined
  return { text, start, end }
}
