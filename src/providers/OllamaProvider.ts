import {
  type ITranslationProvider,
  type LanguageCode,
  type LanguageInfo,
  TranslatorError,
} from '../types'
import { chunk, ensureOk, fetchWithTimeout } from './http'
import { isValidOllamaEndpoint } from './urlValidation'

const BATCH = 20
const TRANSLATE_TIMEOUT = 120000 // local models can be slow
const TEST_TIMEOUT = 15000

/**
 * Local LLM provider backed by an Ollama server (req 4.15). Keyless: the model
 * runs on the user's machine, so no credential is sent. Uses `POST /api/chat`
 * with `stream: false` and `format: 'json'`, prompting the model to translate a
 * JSON array of segments and return `{ "translations": [...] }` of identical
 * length/order. A structural mismatch degrades per-segment to an empty string,
 * which the engine treats as "keep the source" (analogue of req 3.14) rather
 * than corrupting the batch.
 */
export class OllamaProvider implements ITranslationProvider {
  readonly id = 'ollama'
  readonly displayName = 'Ollama'
  private readonly base: string

  constructor(
    endpoint: string,
    private readonly model: string,
  ) {
    if (!isValidOllamaEndpoint(endpoint)) {
      throw new TranslatorError('INVALID_ENDPOINT_URL', 'Invalid Ollama endpoint URL')
    }
    this.base = endpoint.replace(/\/$/, '')
  }

  private systemPrompt(source: LanguageCode | 'auto', target: LanguageCode): string {
    const from = source === 'auto' ? 'the detected source language' : `language code "${source}"`
    return (
      `You are a professional translation engine. Translate every string in the ` +
      `user's JSON array from ${from} into language code "${target}". ` +
      `Preserve inline Markdown/formatting characters and do not translate code, ` +
      `identifiers or URLs. Respond with ONLY a JSON object of the form ` +
      `{"translations": [...]} whose array has EXACTLY the same number of strings, ` +
      `in the same order, as the input array. No commentary.`
    )
  }

  private async translateChunk(
    segments: string[],
    source: LanguageCode | 'auto',
    target: LanguageCode,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string[]> {
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: this.systemPrompt(source, target) },
        { role: 'user', content: JSON.stringify(segments) },
      ],
    })
    const res = await ensureOk(
      await fetchWithTimeout(
        `${this.base}/api/chat`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        signal,
        timeoutMs,
      ),
    )
    const json = (await res.json()) as { message?: { content?: string } }
    const content = json.message?.content ?? ''
    const arr = this.parseTranslations(content)
    // Same-length result; missing/non-string entries become '' so the engine
    // keeps the source segment instead of caching a wrong value.
    return segments.map((_, i) => (typeof arr[i] === 'string' ? (arr[i] as string) : ''))
  }

  /** Tolerant extraction of the translations array from the model's JSON reply. */
  private parseTranslations(content: string): unknown[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new TranslatorError('TRANSLATION_EMPTY_RESPONSE', 'Ollama returned non-JSON output')
    }
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (Array.isArray(obj.translations)) return obj.translations
      // Fallback: first array-valued property.
      const firstArray = Object.values(obj).find((v) => Array.isArray(v))
      if (Array.isArray(firstArray)) return firstArray
    }
    return []
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

  /** Ollama has no fixed language list; the model handles any language pair. */
  async getSupportedLanguages(_direction?: 'source' | 'target'): Promise<LanguageInfo[]> {
    return []
  }

  async testConnection(): Promise<void> {
    await this.translateChunk(['test'], 'auto', 'de', undefined, TEST_TIMEOUT)
  }
}
