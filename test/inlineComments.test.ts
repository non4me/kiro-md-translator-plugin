import { describe, it, expect } from 'vitest'
import { stripInlineComments, parseInline, INLINE_MARKER } from '../src/inlineComments'
import { serializeEof, serializeAfter } from '../src/inlineComments'
import type { Block, CommentThread } from '../src/types'

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

const thread = (quote: string): CommentThread => ({
  anchor: { quote, prefix: '', suffix: '', hintLine: 0, quoteHash: '' },
  orphaned: false,
  comments: [{ id: 'c0', body: 'note', createdAt: '2026-07-05T00:00:00Z', updatedAt: '2026-07-05T00:00:00Z' }],
})

describe('serializeEof', () => {
  it('appends a single trailing block and round-trips via parseInline', () => {
    const src = `A.\n\nB.\n`
    const out = serializeEof(src, { version: 1, docHash: '', threads: [thread('A.')] })
    expect(out.startsWith('A.\n\nB.\n')).toBe(true)
    expect(parseInline(out).threads.map((t) => t.anchor.quote)).toEqual(['A.'])
  })

  it('replaces a stale trailing block rather than stacking', () => {
    const once = serializeEof(`A.\n`, { version: 1, docHash: '', threads: [thread('A.')] })
    const twice = serializeEof(once, { version: 1, docHash: '', threads: [thread('A.')] })
    expect((twice.match(/rmt:comments/g) ?? []).length).toBe(1)
  })
})

describe('serializeAfter', () => {
  it('inserts each thread right after its block and round-trips', () => {
    const src = `A.\n\nB.`
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
    ]
    const live = new Map<number, CommentThread[]>([[1, [thread('B.')]]])
    const out = serializeAfter(src, { version: 1, docHash: '', threads: [thread('B.')] }, blocks, live)
    expect(out).toContain('B.\n\n<!-- rmt:comments')
    expect(parseInline(out).threads.map((t) => t.anchor.quote)).toEqual(['B.'])
  })

  it('rewrites cleanly when run twice (no duplication)', () => {
    const src = `A.\n\nB.`
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
    ]
    const live = new Map<number, CommentThread[]>([[1, [thread('B.')]]])
    const file = { version: 1, docHash: '', threads: [thread('B.')] }
    const once = serializeAfter(src, file, blocks, live)
    const twice = serializeAfter(once, file, blocks, live)
    expect((twice.match(/rmt:comments/g) ?? []).length).toBe(1)
  })
})
