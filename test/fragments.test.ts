import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { trimFragment } from '../src/fragments'

const text = (s: string) => trimFragment(s)?.text

describe('trimFragment', () => {
  it('drops edge whitespace', () => {
    expect(text('  hello world  ')).toBe('hello world')
  })

  it('drops edge punctuation but never interior', () => {
    expect(text('"hello."')).toBe('hello')
    expect(text('(a, b and c)')).toBe('a, b and c')
    expect(text("don't")).toBe("don't")
  })

  it('alternates whitespace and punctuation at the edges', () => {
    expect(text('«  привет  »')).toBe('привет')
    expect(text('  — a dash — ')).toBe('a dash')
  })

  it('handles non-Latin edge punctuation', () => {
    expect(text('。こんにちは、')).toBe('こんにちは')
  })

  it('returns undefined when nothing meaningful remains', () => {
    expect(trimFragment('   ')).toBeUndefined()
    expect(trimFragment('.,;:!?')).toBeUndefined()
    expect(trimFragment('«»— …')).toBeUndefined()
  })

  it('reports offsets into the input', () => {
    const f = trimFragment('  [hello]  ')
    expect(f).toMatchObject({ text: 'hello' })
    expect('  [hello]  '.slice(f!.start, f!.end)).toBe('hello')
  })

  it('keeps a number-only or letter-only fragment', () => {
    expect(text('[42]')).toBe('42')
    expect(text('  x  ')).toBe('x')
  })

  // Feature: kiro-md-translator-plugin, Property 26: the trimmed text is exactly the input with
  // its edge whitespace and edge punctuation removed — the clause the two properties below cannot
  // see. Both of those relate two outputs of trimFragment to each other (idempotence, and a slice
  // of the input at trimFragment's OWN offsets), so a degenerate implementation satisfies them:
  // `s => ({ text: s, start: 0, end: s.length })` is idempotent and slice-consistent while trimming
  // nothing at all. This one uses an INDEPENDENT oracle built from the Unicode classes the design
  // names, so it fails for that implementation and for any that trims too much.
  it('Property 26: trims exactly the edges, against an oracle that is not the implementation', () => {
    const EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu
    // Built from explicit sets rather than fc.stringMatching, which cannot compile
    // Unicode property escapes.
    const EDGE_CHARS = [' ', '\t', '"', "'", '«', '»', '(', ')', '.', ',', ';', ':', '!', '?', '—', '…', '-']
    const ALNUM = ['a', 'Z', 'я', '漢', '1', '9']
    const noise = fc.array(fc.constantFrom(...EDGE_CHARS), { maxLength: 4 }).map((a) => a.join(''))
    // A core that BEGINS and ENDS with a letter or digit, with punctuation allowed inside:
    // interior punctuation is the half these properties must not be free to eat.
    const core = fc
      .tuple(
        fc.constantFrom(...ALNUM),
        fc.array(fc.constantFrom(...ALNUM, ' ', ',', "'", '.', '-'), { maxLength: 6 }).map((a) => a.join('')),
        fc.constantFrom(...ALNUM),
      )
      .map(([head, mid, tail]) => `${head}${mid}${tail}`)
    fc.assert(
      fc.property(
        fc.tuple(noise, core, noise),
        ([lead, core, trail]) => {
          const f = trimFragment(`${lead}${core}${trail}`)
          // The oracle: strip edge whitespace/punctuation from the WHOLE string directly.
          const expected = `${lead}${core}${trail}`.replace(EDGE, '')
          expect(f?.text).toBe(expected)
          // …and the core's own interior characters all survive, in order.
          expect(f?.text).toContain(core.replace(EDGE, ''))
        },
      ),
      { numRuns: 200 },
    )
  })

  // Feature: kiro-md-translator-plugin, Property 26: trimming an already-trimmed fragment yields
  // the same text.
  it('Property 26: is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = trimFragment(s)
        if (once === undefined) return
        const twice = trimFragment(once.text)
        expect(twice?.text).toBe(once.text)
      }),
      { numRuns: 200 },
    )
  })

  // Feature: kiro-md-translator-plugin, Property 26: the trimmed text is always a contiguous slice
  // of the input at the reported offsets — which is what forbids dropping an interior character.
  it('Property 26: offsets always identify the trimmed text', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const f = trimFragment(s)
        if (f === undefined) return
        expect(s.slice(f.start, f.end)).toBe(f.text)
      }),
      { numRuns: 200 },
    )
  })
})
