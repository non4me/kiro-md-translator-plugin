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

  // Idempotence: trimming an already-trimmed fragment changes nothing.
  it('is idempotent', () => {
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

  // The trimmed text is always a contiguous slice of the input at the reported offsets.
  it('offsets always identify the trimmed text', () => {
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
