import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fc from 'fast-check'
import {
  PersistentTranslationCache,
  LayeredTranslationCache,
  type MementoLike,
} from '../src/PersistentTranslationCache'
import { TranslationCache } from '../src/TranslationCache'

/** Single-slot in-memory Memento; `update` stores synchronously so a `flush()`
 *  is visible to a freshly constructed cache without awaiting (simulates the
 *  globalState surviving an IDE restart). */
function fakeMemento(): MementoLike & { peek: () => unknown } {
  let store: unknown
  return {
    get<T>(_key: string, def: T): T {
      return (store === undefined ? def : store) as T
    },
    update(_key: string, value: unknown): Thenable<void> {
      store = value
      return Promise.resolve()
    },
    peek: () => store,
  }
}

describe('PersistentTranslationCache', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('round-trips a value within one instance', () => {
    const c = new PersistentTranslationCache(fakeMemento())
    c.set('hello', 'de', 'hallo')
    expect(c.get('hello', 'de')).toBe('hallo')
    expect(c.get('hello', 'fr')).toBeUndefined() // different lang → different key
  })

  it('defaults to a 2000-entry cap', () => {
    const c = new PersistentTranslationCache(fakeMemento())
    for (let i = 0; i < 2001; i++) c.set(`t${i}`, 'de', `v${i}`)
    expect(c.size).toBe(2000)
    expect(c.get('t0', 'de')).toBeUndefined() // oldest evicted
    expect(c.get('t2000', 'de')).toBe('v2000')
  })

  it('ignores malformed persisted entries on hydration', () => {
    const mem = fakeMemento()
    // seed a store (new {f,e} shape) with some malformed entries, then hydrate
    void mem.update('kiro-md-translator.translationMemory', {
      f: '',
      e: [['["ok","de"]', 'value'], 'not-an-array', [42, 'bad-key']],
    } as unknown)
    const c = new PersistentTranslationCache(mem)
    expect(c.size).toBe(1)
    expect(c.get('ok', 'de')).toBe('value')
  })

  it('drops the persisted store when the config fingerprint differs (stale provider/lang/glossary)', () => {
    const mem = fakeMemento()
    const a = new PersistentTranslationCache(mem, 2000, 1000, () => 'fp-A')
    a.set('x', 'de', 'X')
    a.flush()
    // same fingerprint (settings unchanged) → survives a restart
    expect(new PersistentTranslationCache(mem, 2000, 1000, () => 'fp-A').get('x', 'de')).toBe('X')
    // different fingerprint (provider/storage/glossary changed while closed) → dropped
    expect(new PersistentTranslationCache(mem, 2000, 1000, () => 'fp-B').get('x', 'de')).toBeUndefined()
  })

  // Feature: kiro-md-translator-plugin, Property 17: persistent cache survives reconstruction, bounded LRU
  it('Property 17: survives reconstruction over the same Memento; LRU-bounded; invalidate wipes', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.string(), fc.string()), {
          minLength: 1,
          maxLength: 40,
          selector: ([t, l]) => JSON.stringify([t, l]),
        }),
        (pairs) => {
          const mem = fakeMemento()
          const cap = 25
          const c1 = new PersistentTranslationCache(mem, cap)
          pairs.forEach(([t, l], i) => c1.set(t, l, `v${i}`))
          expect(c1.size).toBeLessThanOrEqual(cap)
          c1.flush()

          // Reconstruct over the SAME Memento (simulates an IDE restart).
          const c2 = new PersistentTranslationCache(mem, cap)
          const firstSurvivor = Math.max(0, pairs.length - cap)
          for (let i = 0; i < pairs.length; i++) {
            const [t, l] = pairs[i]
            expect(c2.get(t, l)).toBe(i >= firstSurvivor ? `v${i}` : undefined)
          }

          // invalidate() empties the mirror AND the persisted store.
          c2.invalidate()
          expect(c2.size).toBe(0)
          expect(new PersistentTranslationCache(mem, cap).size).toBe(0)
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe('LayeredTranslationCache', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Feature: kiro-md-translator-plugin, Property 18: L1 stays ≤ 50; L2 serves keys evicted from L1
  it('Property 18: keeps L1 ≤ 50 and serves L1-evicted keys from L2, re-promoting them', () => {
    const mem = fakeMemento()
    const l1 = new TranslationCache()
    const l2 = new PersistentTranslationCache(mem, 2000)
    const layered = new LayeredTranslationCache(l1, l2)

    const keys = Array.from({ length: 60 }, (_, i) => [`t${i}`, `l${i}`] as const)
    keys.forEach(([t, l], i) => layered.set(t, l, `v${i}`))

    expect(l1.size).toBeLessThanOrEqual(50) // L1 bound preserved (req 9.7)

    const [t0, l0] = keys[0]
    expect(l1.get(t0, l0)).toBeUndefined() // evicted from the hot tier
    expect(layered.get(t0, l0)).toBe('v0') // still served from L2…
    expect(l1.get(t0, l0)).toBe('v0') // …and promoted back into L1
  })

  it('onConfigChanged() drops both tiers on a fingerprint drift, even with no preview open', () => {
    const mem = fakeMemento()
    let fp = 'fp-A'
    const l2 = new PersistentTranslationCache(mem, 2000, 1000, () => fp)
    const layered = new LayeredTranslationCache(new TranslationCache(), l2, () => fp)
    layered.set('hello', 'de', 'hallo')
    layered.flush()

    // Same fingerprint → no-op; the entry (and the persisted store) survive.
    layered.onConfigChanged()
    expect(layered.get('hello', 'de')).toBe('hallo')

    // Fingerprint drifts (provider/storage/glossary changed while no preview was
    // open, so no PreviewController fired): the owner calls onConfigChanged().
    fp = 'fp-B'
    layered.onConfigChanged()
    expect(layered.get('hello', 'de')).toBeUndefined() // L1 + L2 both dropped
    expect(l2.size).toBe(0)
    // …and the persisted store re-stamped with fp-B holds no stale entry, so a
    // future session cannot hydrate the pre-change translation as valid.
    expect(new PersistentTranslationCache(mem, 2000, 1000, () => 'fp-B').get('hello', 'de')).toBeUndefined()
  })

  it('invalidate() clears both tiers; clear() resets only the hot tier', () => {
    const mem = fakeMemento()
    const l2 = new PersistentTranslationCache(mem, 2000)
    const layered = new LayeredTranslationCache(new TranslationCache(), l2)
    layered.set('a', 'de', 'A')

    layered.clear()
    expect(layered.get('a', 'de')).toBe('A') // still served from the persistent tier

    layered.invalidate()
    expect(layered.get('a', 'de')).toBeUndefined()
    expect(l2.size).toBe(0)
  })
})
