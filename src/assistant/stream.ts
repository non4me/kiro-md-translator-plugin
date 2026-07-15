import { TranslatorError } from '../types'

async function* lines(res: Response): AsyncIterable<string> {
  if (!res.body) throw new TranslatorError('TRANSLATION_EMPTY_RESPONSE', 'No response body')
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl)
      buf = buf.slice(nl + 1)
    }
  }
  if (buf.trim()) yield buf
}

export async function* streamNdjson(res: Response, pick: (o: any) => string | undefined): AsyncIterable<string> {
  for await (const line of lines(res)) {
    const s = line.trim()
    if (!s) continue
    let obj: any
    try { obj = JSON.parse(s) } catch { continue }
    const piece = pick(obj)
    if (typeof piece === 'string' && piece.length) yield piece
  }
}

export async function* streamSse(res: Response, pick: (o: any) => string | undefined): AsyncIterable<string> {
  for await (const line of lines(res)) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const data = s.slice(5).trim()
    if (data === '[DONE]') return
    let obj: any
    try { obj = JSON.parse(data) } catch { continue }
    const piece = pick(obj)
    if (typeof piece === 'string' && piece.length) yield piece
  }
}
