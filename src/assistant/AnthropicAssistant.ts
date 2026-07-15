import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { streamSse } from './stream'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export class AnthropicAssistant implements IAssistantProvider {
  readonly id = 'anthropic' as const
  readonly displayName = 'Anthropic'
  constructor(private readonly key: string, private readonly model: string) {
    if (!key) throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for Anthropic')
  }
  private body(messages: AssistantMessage[], stream: boolean) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = messages.filter((m) => m.role !== 'system')
    return JSON.stringify({ model: this.model, stream, max_tokens: 1024, system, messages: rest })
  }
  private headers() {
    return { 'Content-Type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' }
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, { method: 'POST', headers: this.headers(), body: this.body(messages, true) }, signal, 120000))
    yield* streamSse(res, (o) => (o.type === 'content_block_delta' ? o.delta?.text : undefined))
  }
  async testConnection(): Promise<void> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, { method: 'POST', headers: this.headers(), body: this.body([{ role: 'user', content: 'ping' }], false) }, undefined, 15000))
    await res.json()
  }
}
