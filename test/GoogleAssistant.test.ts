import { describe, it, expect, vi, afterEach } from 'vitest'
import { GoogleAssistant } from '../src/assistant/GoogleAssistant'
function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() } })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())
describe('GoogleAssistant', () => {
  it('puts model in the URL and key in the x-goog-api-key header, hoists system to systemInstruction, streams candidate text', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      sse(['data: {"candidates":[{"content":{"parts":[{"text":"Yo"}]}}]}\n\n']) as never)
    const p = new GoogleAssistant('k', 'gemini-1.5-flash')
    let out = ''
    for await (const s of p.chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }], new AbortController().signal)) out += s
    expect(out).toBe('Yo')
    const [url, init] = (f.mock.calls[0] as any)
    expect(url).toContain('gemini-1.5-flash')
    expect(url).not.toContain('k')
    expect(init.headers['x-goog-api-key']).toBe('k')
    const body = JSON.parse(init.body)
    expect(body.systemInstruction.parts[0].text).toBe('S')
    expect(body.contents.some((c: any) => c.parts?.[0]?.text === 'S')).toBe(false)
  })
})
