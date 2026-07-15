import { describe, it, expect } from 'vitest'
import { streamNdjson, streamSse } from '../src/assistant/stream'

function resFrom(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() },
  })
  return { body } as unknown as Response
}
async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []; for await (const s of it) out.push(s); return out
}

describe('stream helpers', () => {
  it('streamNdjson yields message.content per line, tolerating split chunks', async () => {
    const res = resFrom(['{"message":{"content":"Hel', 'lo"}}\n{"message":{"content":" world"}}\n'])
    expect(await collect(streamNdjson(res, (o) => o.message?.content))).toEqual(['Hello', ' world'])
  })

  it('streamSse yields deltas and stops at [DONE]', async () => {
    const res = resFrom([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(await collect(streamSse(res, (o) => o.choices?.[0]?.delta?.content))).toEqual(['A', 'B'])
  })
})
