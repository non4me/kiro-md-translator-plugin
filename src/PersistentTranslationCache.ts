import type { ITranslationCache, LanguageCode } from './types'
import { TranslationCache, serializeKey } from './TranslationCache'

/** Minimal `vscode.Memento` surface used for persistence (get + update). */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Thenable<void>
}

const STORE_KEY = 'kiro-md-translator.translationMemory'
const CAPACITY = 2000
const FLUSH_DEBOUNCE_MS = 1000

/** Persisted shape: a config fingerprint `f` plus the LRU entries `e`. The
 *  fingerprint lets hydration reject a store written under a different
 *  storage-language / provider / model / glossary (req 9.5, cross-session). */
interface PersistedStore {
  f: string
  e: Array<[string, string]>
}

/**
 * L2 translation memory (req 9): an LRU (≤ 2000) persisted across IDE sessions
 * via a `vscode.Memento` (`context.globalState`). The mirror is hydrated
 * synchronously at construction so the `get`/`set` contract stays synchronous;
 * writes schedule a debounced flush, and `flush()` persists immediately (called
 * on deactivation). `invalidate()` wipes both the mirror and the persisted store.
 */
export class PersistentTranslationCache {
  private readonly map = new Map<string, string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly memento: MementoLike,
    private readonly capacity: number = CAPACITY,
    private readonly flushMs: number = FLUSH_DEBOUNCE_MS,
    /** Fingerprint of the config an entry's validity depends on (storage lang,
     *  provider, endpoint/model, glossary). Persisted with the entries; on
     *  hydration a mismatch (settings changed while the IDE was closed, or a
     *  different workspace sharing globalState) drops the store instead of
     *  serving stale/wrong translations. */
    private readonly getFingerprint: () => string = () => '',
  ) {
    const stored = memento.get<PersistedStore | null>(STORE_KEY, null)
    if (stored && typeof stored === 'object' && stored.f === getFingerprint() && Array.isArray(stored.e)) {
      for (const entry of stored.e) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          this.map.set(entry[0], entry[1])
        }
      }
    }
  }

  get(text: string, lang: LanguageCode): string | undefined {
    const key = serializeKey(text, lang)
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as string
    this.map.delete(key)
    this.map.set(key, value) // LRU refresh
    return value
  }

  set(text: string, lang: LanguageCode, translation: string): void {
    const key = serializeKey(text, lang)
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value // first inserted = LRU
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, translation)
    this.scheduleFlush()
  }

  get size(): number {
    return this.map.size
  }

  /** Persist the mirror to the Memento now, cancelling any pending debounce. */
  flush(): Thenable<void> {
    this.cancelFlush()
    return this.memento.update(STORE_KEY, { f: this.getFingerprint(), e: [...this.map.entries()] })
  }

  /** Wipe the mirror and the persisted store (used when cached keys go stale). */
  invalidate(): void {
    this.map.clear()
    this.cancelFlush()
    void this.memento.update(STORE_KEY, { f: this.getFingerprint(), e: [] })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), this.flushMs)
  }

  private cancelFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }
}

/**
 * Two-tier cache (req 9): an in-memory `TranslationCache` (L1, ≤ 50) over a
 * persistent `PersistentTranslationCache` (L2). A `get` checks L1 then L2,
 * promoting an L2 hit into L1; a `set` writes both. L1 keeps its own 50-entry
 * bound independent of L2 (req 9.7). Beyond `ITranslationCache` it exposes
 * `invalidate()` (wipe both tiers + persisted store) and `flush()` (persist L2).
 */
export class LayeredTranslationCache implements ITranslationCache {
  private lastFingerprint: string

  constructor(
    private readonly l1: TranslationCache,
    private readonly l2: PersistentTranslationCache,
    /** Config fingerprint the cached entries depend on (same closure the L2 uses
     *  for hydration). `onConfigChanged()` compares against it to drop both tiers
     *  when a settings change makes same-key entries stale — even when no preview
     *  is open. */
    private readonly getFingerprint: () => string = () => '',
  ) {
    this.lastFingerprint = getFingerprint()
  }

  get(text: string, lang: LanguageCode): string | undefined {
    const hot = this.l1.get(text, lang)
    if (hot !== undefined) return hot
    const cold = this.l2.get(text, lang)
    if (cold !== undefined) {
      this.l1.set(text, lang, cold) // promote into the hot tier
      return cold
    }
    return undefined
  }

  set(text: string, lang: LanguageCode, translation: string): void {
    this.l1.set(text, lang, translation)
    this.l2.set(text, lang, translation)
  }

  /** Reset only the hot tier; the persistent tier survives (see `invalidate`). */
  clear(): void {
    this.l1.clear()
  }

  get size(): number {
    return this.l1.size
  }

  invalidate(): void {
    this.l1.clear()
    this.l2.invalidate()
  }

  /**
   * Drop both tiers when the config fingerprint has drifted since the last check.
   * The owner (ActivationController) calls this on every settings change, so a
   * provider / storage-language / glossary change invalidates the shared cache
   * even when NO preview is open — otherwise the in-memory tiers (which outlive
   * a preview) keep serving, and `flush()` re-persists, translations produced
   * under the old config, mislabelled with the new fingerprint (req 9.5). The
   * per-preview handler cannot cover this: it only fires while a preview exists.
   */
  onConfigChanged(): void {
    const fp = this.getFingerprint()
    if (fp !== this.lastFingerprint) {
      this.lastFingerprint = fp
      this.invalidate()
    }
  }

  flush(): Thenable<void> {
    return this.l2.flush()
  }
}
