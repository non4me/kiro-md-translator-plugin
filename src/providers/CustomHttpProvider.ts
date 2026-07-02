import {
  type ITranslationProvider,
  type LanguageCode,
  type LanguageInfo,
  TranslatorError,
} from '../types'
import { chunk, ensureOk, fetchWithTimeout } from './http'
import { isValidEndpoint } from './urlValidation'

const BATCH = 50
const TRANSLATE_TIMEOUT = 20000
const TEST_TIMEOUT = 5000

/**
 * Calls a user-supplied `https://` endpoint expecting the response shape
 * `{ "translations": [{ "text": "..." }] }` (req 4.8 / 4.14). The endpoint URL
 * is validated as `https://` before any request is sent.
 */
export class CustomHttpProvider implements ITranslationProvider {
  readonly id = 'custom'
  readonly displayName = 'Custom HTTP'

  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string,
  ) {
    if (!isValidEndpoint(endpoint)) {
      throw new TranslatorError('INVALID_ENDPOINT_URL', 'Invalid URL format')
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  private async translateChunk(
    segments: string[],
    source: LanguageCode | 'auto',
    target: LanguageCode,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string[]> {
    const body = JSON.stringify({ segments, source, target })
    const res = await ensureOk(
      await fetchWithTimeout(this.endpoint, { method: 'POST', headers: this.headers(), body }, signal, timeoutMs),
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

  async getSupportedLanguages(_direction?: 'source' | 'target'): Promise<LanguageInfo[]> {
    try {
      const res = await ensureOk(
        await fetchWithTimeout(
          this.endpoint.replace(/\/$/, '') + '/languages',
          { headers: this.headers() },
          undefined,
          TEST_TIMEOUT,
        ),
      )
      const json = (await res.json()) as { languages?: Array<{ code: string; name?: string }> }
      return (json.languages ?? []).map((l) => ({ code: l.code, name: l.name ?? l.code }))
    } catch (err) {
      throw new TranslatorError('LANGUAGE_LOAD_FAILED', (err as Error).message)
    }
  }

  async testConnection(): Promise<void> {
    await this.translateChunk(['test'], 'auto', 'de', undefined, TEST_TIMEOUT)
  }
}
