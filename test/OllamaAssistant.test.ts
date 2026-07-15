import { describe, it, expect, vi, afterEach } from 'vitest'
import { OllamaAssistant } from '../src/assistant/OllamaAssistant'

function ndjsonResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() },
  })
  return { ok: true, status: 200, body } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())

describe('OllamaAssistant', () => {
  it('streams assistant content from /api/chat', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      ndjsonResponse(['{"message":{"content":"Hi"}}\n', '{"message":{"content":" there"}}\n']) as never,
    )
    const p = new OllamaAssistant('http://localhost:11434', 'llama3.1')
    const out: string[] = []
    for await (const s of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) out.push(s)
    expect(out.join('')).toBe('Hi there')
    const url = (fetchMock.mock.calls[0] as any)[0]
    expect(url).toBe('http://localhost:11434/api/chat')
  })

  it('rejects an invalid endpoint', () => {
    expect(() => new OllamaAssistant('not a url', 'm')).toThrow()
  })
})
