import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { streamSse } from './stream'

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GoogleAssistant implements IAssistantProvider {
  readonly id = 'google' as const
  readonly displayName = 'Google Gemini'
  constructor(private readonly key: string, private readonly model: string) {
    if (!key) throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for Google')
  }
  private payload(messages: AssistantMessage[]) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    return JSON.stringify(system ? { systemInstruction: { parts: [{ text: system }] }, contents } : { contents })
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const url = `${HOST}/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.key)}`
    const res = await ensureOk(await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: this.payload(messages) }, signal, 120000))
    yield* streamSse(res, (o) => o.candidates?.[0]?.content?.parts?.[0]?.text)
  }
  async testConnection(): Promise<void> {
    const url = `${HOST}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.key)}`
    const res = await ensureOk(await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: this.payload([{ role: 'user', content: 'ping' }]) }, undefined, 15000))
    await res.json()
  }
}
