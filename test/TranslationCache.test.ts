import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { TranslationCache, serializeKey } from '../src/TranslationCache'

describe('TranslationCache', () => {
  it('hit returns value, miss returns undefined, clear resets', () => {
    const c = new TranslationCache()
    expect(c.get('a', 'en')).toBeUndefined()
    c.set('a', 'en', 'A')
    expect(c.get('a', 'en')).toBe('A')
    c.clear()
    expect(c.size).toBe(0)
    expect(c.get('a', 'en')).toBeUndefined()
  })

  it('structured key is collision-safe for inputs containing "::"', () => {
    const c = new TranslationCache()
    c.set('a', 'b::c', 'X')
    c.set('a::b', 'c', 'Y')
    expect(c.get('a', 'b::c')).toBe('X')
    expect(c.get('a::b', 'c')).toBe('Y')
  })

  it('recency-on-hit: a cache hit refreshes the entry (true LRU)', () => {
    const c = new TranslationCache()
    for (let i = 0; i < 50; i++) c.set(`t${i}`, 'en', `v${i}`)
    expect(c.get('t0', 'en')).toBe('v0') // refresh oldest
    c.set('t50', 'en', 'v50') // evicts the now-LRU entry (t1), not t0
    expect(c.size).toBe(50)
    expect(c.get('t0', 'en')).toBe('v0')
    expect(c.get('t1', 'en')).toBeUndefined()
  })

  // Feature: kiro-md-translator-plugin, Property 9: LRU eviction maintains cache size ≤ 50
  it('Property 9: size never exceeds 50; the oldest distinct key is evicted past 50', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.string(), fc.string()), {
          minLength: 51,
          maxLength: 120,
          selector: ([t, l]) => serializeKey(t, l),
        }),
        (pairs) => {
          const c = new TranslationCache()
          for (const [text, lang] of pairs) {
            c.set(text, lang, `${text}|${lang}`)
            expect(c.size).toBeLessThanOrEqual(50)
          }
          expect(c.size).toBe(50)
          const [t0, l0] = pairs[0]
          expect(c.get(t0, l0)).toBeUndefined() // first inserted, evicted
          const [tn, ln] = pairs[pairs.length - 1]
          expect(c.get(tn, ln)).toBe(`${tn}|${ln}`) // most recent, present
        },
      ),
      { numRuns: 100 },
    )
  })
})
