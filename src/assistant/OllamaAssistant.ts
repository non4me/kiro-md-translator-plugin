import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { isValidOllamaEndpoint } from '../providers/urlValidation'
import { streamNdjson } from './stream'

const CHAT_TIMEOUT = 300000 // local models can take minutes per turn
const TEST_TIMEOUT = 15000

export class OllamaAssistant implements IAssistantProvider {
  readonly id = 'ollama' as const
  readonly displayName = 'Ollama'
  private readonly base: string
  constructor(endpoint: string, private readonly model: string) {
    if (!isValidOllamaEndpoint(endpoint)) {
      throw new TranslatorError('INVALID_ENDPOINT_URL', 'Invalid Ollama endpoint URL')
    }
    this.base = endpoint.replace(/\/$/, '')
  }

  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const res = await ensureOk(
      await fetchWithTimeout(
        `${this.base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, stream: true, messages }),
        },
        signal,
        CHAT_TIMEOUT,
      ),
    )
    yield* streamNdjson(res, (o) => o.message?.content)
  }

  async testConnection(): Promise<void> {
    const res = await ensureOk(
      await fetchWithTimeout(
        `${this.base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
        },
        undefined,
        TEST_TIMEOUT,
      ),
    )
    await res.json()
  }
}
