import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicAssistant } from '../src/assistant/AnthropicAssistant'
function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() } })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())
describe('AnthropicAssistant', () => {
  it('hoists system, streams content_block_delta text', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      sse(['data: {"type":"content_block_delta","delta":{"text":"Yo"}}\n\n']) as never)
    const p = new AnthropicAssistant('k', 'claude-3-5-sonnet-latest')
    let out = ''
    for await (const s of p.chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }], new AbortController().signal)) out += s
    expect(out).toBe('Yo')
    const [, init] = (f.mock.calls[0] as any)
    expect(init.headers['x-api-key']).toBe('k')
    expect(JSON.parse(init.body).system).toBe('S')
    expect(JSON.parse(init.body).messages.some((m: any) => m.role === 'system')).toBe(false)
  })
})
