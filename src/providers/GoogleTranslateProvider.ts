import {
  type ITranslationProvider,
  type LanguageCode,
  type LanguageInfo,
  TranslatorError,
} from '../types'
import { chunk, ensureOk, fetchWithTimeout } from './http'

const BASE = 'https://translation.googleapis.com/language/translate/v2'
const BATCH = 128
const TRANSLATE_TIMEOUT = 20000
const TEST_TIMEOUT = 5000

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export class GoogleTranslateProvider implements ITranslationProvider {
  readonly id = 'google'
  readonly displayName = 'Google Translate'

  constructor(private readonly apiKey: string) {}

  private async translateChunk(
    segments: string[],
    source: LanguageCode | 'auto',
    target: LanguageCode,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string[]> {
    const body = JSON.stringify({
      q: segments,
      target,
      format: 'text',
      ...(source !== 'auto' ? { source } : {}),
    })
    const res = await ensureOk(
      await fetchWithTimeout(
        `${BASE}?key=${encodeURIComponent(this.apiKey)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        signal,
        timeoutMs,
      ),
    )
    const json = (await res.json()) as {
      data?: { translations?: Array<{ translatedText: string }> }
    }
    return (json.data?.translations ?? []).map((t) => decodeEntities(t.translatedText))
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

  async getSupportedLanguages(_direction?: 'source' | 'target'): Promise<LanguageInfo[]> {
    try {
      const res = await ensureOk(
        await fetchWithTimeout(
          `${BASE}/languages?key=${encodeURIComponent(this.apiKey)}&target=en`,
          {},
          undefined,
          TEST_TIMEOUT,
        ),
      )
      const json = (await res.json()) as {
        data?: { languages?: Array<{ language: string; name?: string }> }
      }
      return (json.data?.languages ?? []).map((l) => ({ code: l.language, name: l.name ?? l.language }))
    } catch (err) {
      throw new TranslatorError('LANGUAGE_LOAD_FAILED', (err as Error).message)
    }
  }

  async testConnection(): Promise<void> {
    await this.translateChunk(['test'], 'auto', 'de', undefined, TEST_TIMEOUT)
  }
}
