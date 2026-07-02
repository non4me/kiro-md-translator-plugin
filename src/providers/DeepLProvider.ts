import {
  type ITranslationProvider,
  type LanguageCode,
  type LanguageInfo,
  TranslatorError,
} from '../types'
import { chunk, ensureOk, fetchWithTimeout } from './http'

const BASE = 'https://api.deepl.com/v2'
const BATCH = 50
const TRANSLATE_TIMEOUT = 20000
const TEST_TIMEOUT = 5000

export class DeepLProvider implements ITranslationProvider {
  readonly id = 'deepl'
  readonly displayName = 'DeepL'

  constructor(private readonly apiKey: string) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `DeepL-Auth-Key ${this.apiKey}` }
  }

  private headers(): Record<string, string> {
    return { ...this.authHeaders(), 'Content-Type': 'application/json' }
  }

  private async translateChunk(
    segments: string[],
    source: LanguageCode | 'auto',
    target: LanguageCode,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string[]> {
    const body = JSON.stringify({
      text: segments,
      target_lang: target.toUpperCase(),
      // DeepL source_lang accepts ONLY base codes (EN, PT), never regional
      // variants (EN-US, PT-BR) — those are target-only. Strip the region.
      ...(source !== 'auto' ? { source_lang: source.split('-')[0].toUpperCase() } : {}),
    })
    const res = await ensureOk(
      await fetchWithTimeout(`${BASE}/translate`, { method: 'POST', headers: this.headers(), body }, signal, timeoutMs),
    )
    const json = (await res.json()) as { translations?: Array<{ text: string }> }
    return (json.translations ?? []).map((t) => t.text)
  }

  async translateBatch(
    segments: string[],
    source: LanguageCode | 'auto',
    target: LanguageCode,
    signal: AbortSignal,
  ): Promise<string[]> {
    const out: string[] = []
    for (const part of chunk(segments, BATCH)) {
      out.push(...(await this.translateChunk(part, source, target, signal, TRANSLATE_TIMEOUT)))
    }
    return out
  }

  async getSupportedLanguages(direction: 'source' | 'target' = 'target'): Promise<LanguageInfo[]> {
    try {
      // Bodyless GET: send ONLY the auth header. Adding Content-Type: application/json
      // makes the DeepL gateway reject the request with HTTP 400 "non-empty request body required".
      // type=source returns base codes (EN); type=target adds regional variants (EN-US).
      const res = await ensureOk(
        await fetchWithTimeout(`${BASE}/languages?type=${direction}`, { headers: this.authHeaders() }, undefined, TEST_TIMEOUT),
      )
      const json = (await res.json()) as Array<{ language: string; name: string }>
      return json.map((l) => ({ code: l.language.toLowerCase(), name: l.name }))
    } catch (err) {
      throw new TranslatorError('LANGUAGE_LOAD_FAILED', (err as Error).message)
    }
  }

  async testConnection(): Promise<void> {
    await this.translateChunk(['test'], 'auto', 'de', undefined, TEST_TIMEOUT)
  }
}
