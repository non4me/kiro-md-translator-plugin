import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { diceSimilarity, normalize, makeAnchor, matchThread } from '../src/anchoring'
import type { Block } from '../src/types'

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
