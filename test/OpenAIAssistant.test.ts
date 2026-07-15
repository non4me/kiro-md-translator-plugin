import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIAssistant } from '../src/assistant/OpenAIAssistant'

function sse(chunks: string[], ok = true, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() } })
  return { ok, status, body, text: async () => 'err' } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())

describe('OpenAIAssistant', () => {
  it('streams delta content with a bearer key', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']) as never,
    )
    const p = new OpenAIAssistant('sk-1', 'gpt-4o-mini')
    let out = ''
    for await (const s of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) out += s
    expect(out).toBe('Hi')
    const [, init] = (f.mock.calls[0] as any)
    expect(init.headers.Authorization).toBe('Bearer sk-1')
  })

  it('surfaces a 401 as an error', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(sse([], false, 401) as never)
    const p = new OpenAIAssistant('bad', 'gpt-4o-mini')
    await expect((async () => { for await (const _ of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) {} })()).rejects.toThrow()
  })
})
