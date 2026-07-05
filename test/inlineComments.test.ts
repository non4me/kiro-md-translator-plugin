import { describe, it, expect } from 'vitest'
import { stripInlineComments, parseInline, INLINE_MARKER } from '../src/inlineComments'

const block = (json: string) => `<!-- ${INLINE_MARKER}\n${json}\n-->`

describe('stripInlineComments', () => {
  it('removes an after-paragraph comment block and its blank line', () => {
    const src = `Para one.\n\n${block('{"comments":[]}')}\n\nPara two.\n`
    expect(stripInlineComments(src)).toBe(`Para one.\n\nPara two.\n`)
  })

  it('removes an end-of-file block', () => {
    const src = `Para.\n\n${block('{"comments":[]}')}\n`
    expect(stripInlineComments(src)).toBe(`Para.\n`)
  })

  it('is a no-op when there are no inline comments', () => {
    const src = `# Title\n\nBody.\n`
    expect(stripInlineComments(src)).toBe(src)
  })
})

describe('parseInline', () => {
  it('collects threads from all blocks', () => {
    const t = (q: string) =>
      block(JSON.stringify({ anchor: { quote: q }, comments: [{ id: 'c0', body: 'x', createdAt: '', updatedAt: '' }] }))
    const src = `A.\n\n${t('A.')}\n\nB.\n\n${t('B.')}\n`
    const file = parseInline(src)
    expect(file.threads.map((th) => th.anchor.quote)).toEqual(['A.', 'B.'])
  })

  it('tolerates malformed JSON (skips the block, never throws)', () => {
    const src = `A.\n\n<!-- ${INLINE_MARKER}\n{not json\n-->\n`
    expect(parseInline(src).threads).toEqual([])
  })
})
