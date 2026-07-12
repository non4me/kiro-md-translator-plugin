import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  diceSimilarity,
  normalize,
  makeAnchor,
  matchThread,
  locateFragment,
  resolveThread,
  makeSpanAnchor,
  resolveSpan,
} from '../src/anchoring'
import type { Block, FragmentAnchor } from '../src/types'

function blocksFrom(texts: string[]): Block[] {
  let line = 0
  return texts.map((text, i) => {
    const b: Block = { paragraphIndex: i, startLine: line, text }
    line += text.split('\n').length + 1 // block + a blank separator line
    return b
  })
}

describe('anchoring primitives', () => {
  it('dice similarity: identical=1, disjoint=0, partial in (0,1)', () => {
    expect(diceSimilarity('hello world', 'hello world')).toBe(1)
    expect(diceSimilarity('abcdef', 'uvwxyz')).toBe(0)
    const partial = diceSimilarity('night', 'nacht')
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(1)
  })

  it('normalize collapses whitespace runs and trims', () => {
    expect(normalize('  a\n\t b  ')).toBe('a b')
  })

  it('dice similarity returns 0 for non-string args (untrusted-anchor guard)', () => {
    expect(diceSimilarity(undefined as never, 'x')).toBe(0)
    expect(diceSimilarity('x', undefined as never)).toBe(0)
  })

  it('makeAnchor captures quote + adjacent-block context + hint line', () => {
    const blocks = blocksFrom(['First', 'Middle', 'Last'])
    const a = makeAnchor(blocks, 1)
    expect(a).toBeDefined()
    expect(a!.quote).toBe('Middle')
    expect(a!.prefix).toBe('First')
    expect(a!.suffix).toBe('Last')
    expect(a!.hintLine).toBe(blocks[1].startLine)
  })
})

describe('matchThread', () => {
  it('exact-matches after unrelated lines shift the block down', () => {
    const orig = blocksFrom(['Target paragraph', 'Other'])
    const anchor = makeAnchor(orig, 0)!
    const edited = blocksFrom(['Inserted A', 'Inserted B', 'Target paragraph', 'Other'])
    expect(matchThread(anchor, edited)).toBe(2)
  })

  it('normalized-whitespace matches when only spacing changed', () => {
    const orig = blocksFrom(['The   quick brown\tfox'])
    const anchor = makeAnchor(orig, 0)!
    const edited = blocksFrom(['Prelude', 'The quick brown fox'])
    expect(matchThread(anchor, edited)).toBe(1)
  })

  it('fuzzy-matches a lightly reworded block (Dice >= 0.7)', () => {
    const orig = blocksFrom(['The quick brown fox jumps over the lazy dog', 'Unrelated content here'])
    const anchor = makeAnchor(orig, 0)!
    const edited = blocksFrom([
      'Totally different opening line',
      'The quick brown fox leaps over the lazy dog',
    ])
    expect(matchThread(anchor, edited)).toBe(1)
  })

  it('orphans (undefined) when the block is removed and nothing similar remains', () => {
    const orig = blocksFrom([
      'Introduction paragraph about cats',
      'Middle section on dogs',
      'Closing remarks',
    ])
    const anchor = makeAnchor(orig, 1)! // "Middle section on dogs"
    const edited = blocksFrom(['Introduction paragraph about cats', 'Closing remarks'])
    expect(matchThread(anchor, edited)).toBeUndefined()
  })

  it('disambiguates duplicate blocks by surrounding context (prefix/suffix)', () => {
    const orig = blocksFrom(['Chapter one intro', 'Note', 'Chapter two intro', 'Note', 'Appendix'])
    const anchor = makeAnchor(orig, 3)! // the SECOND "Note" (between "Chapter two intro" and "Appendix")
    const edited = blocksFrom([
      'NEW TOP',
      'Chapter one intro',
      'Note',
      'Chapter two intro',
      'Note',
      'Appendix',
    ])
    expect(matchThread(anchor, edited)).toBe(4) // the second Note, not the first
  })

  // Feature: kiro-md-translator-plugin, Property 19: re-anchoring is stable under edits
  it('Property 19: an anchored block re-anchors to the SAME content after lines are added around it', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 0, maxLength: 6 }),
        fc.nat(),
        (orig, inserts, tSeed) => {
          const insertSet = inserts.filter((s) => !orig.includes(s)) // keep the target text unique
          const t = tSeed % orig.length
          const target = orig[t]
          const anchor = makeAnchor(blocksFrom(orig), t)!
          const edited = [...orig]
          insertSet.forEach((s, k) => edited.splice((k * 2) % (edited.length + 1), 0, s))
          const newBlocks = blocksFrom(edited)
          const expected = newBlocks.find((b) => b.text === target)!.paragraphIndex
          // The unique target text is present → exact match must return exactly its (shifted) index,
          // never a different block, regardless of how many lines moved around it.
          expect(matchThread(anchor, newBlocks)).toBe(expected)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('fragment anchoring (stage 3)', () => {
  const blocks = blocksFrom([
    'Intro block.',
    'The quick brown fox jumps over the lazy dog.',
    'Outro block.',
  ])

  it('an anchor without a fragment resolves to the whole block (backward compatible)', () => {
    const a = makeAnchor(blocks, 1)!
    expect(a.fragment).toBeUndefined()
    expect(resolveThread(a, blocks)).toEqual({
      paragraphIndex: 1,
      start: 0,
      end: blocks[1].text.length,
    })
  })

  it('an anchor with a fragment pins the sub-span', () => {
    const at = blocks[1].text.indexOf('brown fox')
    const a = makeAnchor(blocks, 1, { start: at, end: at + 'brown fox'.length })!
    expect(a.fragment?.quote).toBe('brown fox')
    expect(resolveThread(a, blocks)).toEqual({ paragraphIndex: 1, start: at, end: at + 9 })
  })

  it('a fragment that repeats in the block is disambiguated by in-block context', () => {
    const b = blocksFrom(['x', 'go left, then go right', 'y'])
    const second = b[1].text.indexOf('go', b[1].text.indexOf('go') + 1)
    const a = makeAnchor(b, 1, { start: second, end: second + 2 })!
    const r = resolveThread(a, b)!
    expect(r.start).toBe(second) // the SECOND 'go', not the first
  })

  it('a fragment whose text is gone becomes an orphan, never the whole block', () => {
    const at = blocks[1].text.indexOf('quick')
    const a = makeAnchor(blocks, 1, { start: at, end: at + 5 })!
    const edited = blocksFrom([
      'Intro block.',
      'The BROWN fox jumps over the lazy dog.', // 'quick' removed; block still fuzzy-matches
      'Outro block.',
    ])
    expect(matchThread(a, edited)).toBe(1) // the block is still found…
    expect(resolveThread(a, edited)).toBeUndefined() // …but the fragment is orphaned
  })

  it('a fragment survives an edit elsewhere in its block', () => {
    const at = blocks[1].text.indexOf('fox')
    const a = makeAnchor(blocks, 1, { start: at, end: at + 3 })!
    const edited = blocksFrom([
      'Intro block.',
      'The quick brown fox leaps over the lazy cat.', // edited after 'fox'
      'Outro block.',
    ])
    const r = resolveThread(a, edited)!
    expect(edited[1].text.slice(r.start, r.end)).toBe('fox')
  })

  it('locateFragment returns undefined when the quote is absent', () => {
    expect(locateFragment({ quote: 'zzz', prefix: '', suffix: '' }, 'no such text here')).toBeUndefined()
  })
})

describe('span anchoring (multi-block, stage 4)', () => {
  const blocks = blocksFrom(['First block alpha', 'Middle block beta', 'Last block gamma'])
  const startFrag: FragmentAnchor = { quote: 'alpha', prefix: 'First block ', suffix: '' }
  const endFrag: FragmentAnchor = { quote: 'Last', prefix: '', suffix: ' block gamma' }

  it('makeSpanAnchor pins the first block as primary and the last block as `end`', () => {
    const a = makeSpanAnchor(blocks, 0, startFrag, 2, endFrag)!
    expect(a.quote).toBe('First block alpha') // primary anchor is the FIRST block
    expect(a.fragment).toEqual(startFrag) // its fragment is the selected tail
    expect(a.end?.quote).toBe('Last block gamma') // the far end is the LAST block
    expect(a.end?.fragment).toEqual(endFrag) // its fragment is the selected head
  })

  it('resolveSpan returns the two in-order ends when both still exist', () => {
    const a = makeSpanAnchor(blocks, 0, startFrag, 2, endFrag)!
    expect(resolveSpan(a, blocks)).toEqual({ startIndex: 0, endIndex: 2 })
  })

  it('resolveSpan orphans when the end block is gone (never a partial span)', () => {
    const a = makeSpanAnchor(blocks, 0, startFrag, 2, endFrag)!
    const edited = blocksFrom(['First block alpha', 'Middle block beta']) // last block deleted
    expect(resolveSpan(a, edited)).toBeUndefined()
  })

  it('resolveSpan orphans when an end fragment text is gone, even if its block still matches', () => {
    const a = makeSpanAnchor(blocks, 0, startFrag, 2, endFrag)!
    const edited = blocksFrom(['First block alpha', 'Middle block beta', 'Final block gamma']) // 'Last' → 'Final'
    expect(matchThread({ ...a.end! }, edited)).toBe(2) // the last block still fuzzy-matches…
    expect(resolveSpan(a, edited)).toBeUndefined() // …but its head fragment 'Last' is gone → orphan
  })

  it('resolveSpan orphans when the ends invert after a reorder', () => {
    const a = makeSpanAnchor(blocks, 0, startFrag, 2, endFrag)!
    const swapped = blocksFrom(['Last block gamma', 'Middle block beta', 'First block alpha'])
    // start now matches index 2, end matches index 0 → end < start → orphan, never a backwards span
    expect(resolveSpan(a, swapped)).toBeUndefined()
  })

  // Feature: kiro-md-translator-plugin, Property 30: multi-block span anchoring resolves both ends or orphans, never a wrong span
  it('Property 30: a span resolves to strictly in-order ends, or orphans — never a wrong span', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 3, maxLength: 8 }),
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        (rawTexts, a, b, corruptEnd) => {
          const texts = rawTexts.map((t, i) => `B${i}-${t}`) // unique → unambiguous matching
          const bl = blocksFrom(texts)
          const n = texts.length
          let s = a % n
          let e = b % n
          if (s > e) [s, e] = [e, s]
          const sf: FragmentAnchor = { quote: texts[s], prefix: '', suffix: '' }
          const ef: FragmentAnchor = corruptEnd
            ? { quote: 'ZZZ_ABSENT_ZZZ', prefix: '', suffix: '' }
            : { quote: texts[e], prefix: '', suffix: '' }
          const anchor = makeSpanAnchor(bl, s, sf, e, ef)!
          const span = resolveSpan(anchor, bl)
          if (corruptEnd || s === e) {
            expect(span).toBeUndefined() // end fragment gone, or collapsed to one block → orphan
          } else {
            expect(span).toEqual({ startIndex: s, endIndex: e }) // exactly the two ends, in order
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
