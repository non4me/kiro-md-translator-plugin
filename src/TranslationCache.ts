import type { ITranslationCache, LanguageCode } from './types'

const CAPACITY = 50

/** Collision-safe structured key (NOT `text + '::' + lang`, which collides). */
export function serializeKey(text: string, lang: LanguageCode): string {
  return JSON.stringify([text, lang])
}

/**
 * In-memory LRU cache bounded to 50 entries (reqs 3.9, 5.3). Recency is tracked
 * by delete-and-reinsert on every access, so a cache hit refreshes the entry.
 */
export class TranslationCache implements ITranslationCache {
  private readonly map = new Map<string, string>()

  get(text: string, lang: LanguageCode): string | undefined {
    const key = serializeKey(text, lang)
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as string
    this.map.delete(key)
    this.map.set(key, value) // re-insert at end → most-recently-used
    return value
  }

  set(text: string, lang: LanguageCode, translation: string): void {
    const key = serializeKey(text, lang)
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= CAPACITY) {
      const oldest = this.map.keys().next().value // first inserted = LRU
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, translation)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
