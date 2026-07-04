/**
 * Do-not-translate term protection (req 3.18). Each configured term is replaced
 * by a translation-resistant sentinel (`⟦i⟧`, mathematical white brackets — MT
 * engines leave them intact) before a segment is sent to the provider, and
 * restored verbatim afterwards. Terms are applied longest-first so a shorter
 * term cannot mask part of a longer one, and word-like terms are matched on
 * word boundaries so `cat` does not mask `category`.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True for a Unicode letter or number — the "word" edge for boundary matching. */
function isWordEdge(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch)
}

function termRegex(term: string): RegExp {
  // JS `\b`/`\w` are ASCII-only, which silently disables boundary protection for
  // non-ASCII terms (e.g. Cyrillic 'код' would mask the prefix of 'кодировка').
  // Use Unicode-aware lookarounds keyed on \p{L}\p{N} with the `u` flag instead.
  // A CJK term (no letter/number edge behaviour that helps) falls back to a bare
  // substring, which is the correct behaviour for scripts without word boundaries.
  const left = isWordEdge(term[0]) ? '(?<![\\p{L}\\p{N}])' : ''
  const right = isWordEdge(term[term.length - 1]) ? '(?![\\p{L}\\p{N}])' : ''
  try {
    return new RegExp(`${left}${escapeRegExp(term)}${right}`, 'gu')
  } catch {
    // A pathological user-supplied term must never crash the translation pipeline;
    // degrade to a plain (boundary-less) match.
    return new RegExp(escapeRegExp(term), 'g')
  }
}

export interface MaskResult {
  masked: string
  restore: (translated: string) => string
}

export class Glossary {
  private readonly terms: string[]

  constructor(terms: string[]) {
    // Drop blanks and PURELY-NUMERIC terms: a bare number would match the digits
    // inside an already-inserted sentinel (⟦0⟧), corrupting restoration — and MT
    // engines do not translate bare numbers anyway, so protecting them is a no-op.
    this.terms = [
      ...new Set(
        terms.filter((t) => typeof t === 'string' && t.trim().length > 0 && !/^\d+$/.test(t.trim())),
      ),
    ].sort((a, b) => b.length - a.length)
  }

  get isEmpty(): boolean {
    return this.terms.length === 0
  }

  /**
   * Replace each glossary term occurrence in `text` with a numbered sentinel and
   * return a `restore` that maps the sentinels back to the original terms. When
   * the glossary is empty (or no term occurs), this is the identity transform.
   */
  mask(text: string): MaskResult {
    if (this.terms.length === 0) return { masked: text, restore: (t) => t }

    const found: string[] = []
    let masked = text
    for (const term of this.terms) {
      masked = masked.replace(termRegex(term), () => {
        const index = found.length
        found.push(term)
        return `⟦${index}⟧`
      })
    }
    if (found.length === 0) return { masked, restore: (t) => t }

    return {
      masked,
      restore: (translated: string): string =>
        translated.replace(/⟦(\d+)⟧/g, (whole, i: string) => {
          const term = found[Number(i)]
          return term === undefined ? whole : term
        }),
    }
  }
}
