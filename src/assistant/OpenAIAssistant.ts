import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { streamSse } from './stream'
import { t } from '../l10n'

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT = 120000

export class OpenAIAssistant implements IAssistantProvider {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  constructor(private readonly key: string, private readonly model: string) {
    if (!key) throw new TranslatorError('INVALID_ENDPOINT_URL', t('API key required for {0}', 'OpenAI'))
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, stream: true, messages }),
    }, signal, TIMEOUT))
    yield* streamSse(res, (o) => o.choices?.[0]?.delta?.content)
  }
  async testConnection(): Promise<void> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }, undefined, 15000))
    await res.json()
  }
}
