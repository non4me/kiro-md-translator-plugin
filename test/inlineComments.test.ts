import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
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
    // Share ONE thread object between `live` and `data.threads` — production's
    // reanchor() stores the same references into both, so the EOF fallback (which
    // dedupes by object identity) sees this thread as already placed.
    const tB = thread('B.')
    const live = new Map<number, CommentThread[]>([[1, [tB]]])
    const out = serializeAfter(src, { version: 1, docHash: '', threads: [tB] }, blocks, live)
    expect(out).toContain('B.\n\n<!-- rmt:comments')
    expect(parseInline(out).threads.map((t) => t.anchor.quote)).toEqual(['B.'])
  })

  it('rewrites cleanly when run twice (no duplication)', () => {
    const src = `A.\n\nB.`
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
    ]
    // Share ONE thread object between `live` and `data.threads` (see note above).
    const tB = thread('B.')
    const live = new Map<number, CommentThread[]>([[1, [tB]]])
    const file = { version: 1, docHash: '', threads: [tB] }
    const once = serializeAfter(src, file, blocks, live)
    const twice = serializeAfter(once, file, blocks, live)
    expect((twice.match(/rmt:comments/g) ?? []).length).toBe(1)
  })
})

describe('serializeAfter never drops a thread', () => {
  // Data-integrity invariant: EVERY thread in `data.threads` must survive one
  // round-trip, placed after its block when placeable else appended at EOF. These
  // regression tests share thread OBJECT IDENTITY between `data.threads` and the
  // `live` map — mirroring production (CommentsService.reanchor stores references
  // from this.data.threads into this.live), so the EOF fallback never double-emits.

  it('keeps a comment that sits below an existing carrier (coordinate bug)', () => {
    const tA = thread('A.')
    const tC = thread('C.')
    // A LADEN source that already carries tA above block C. `blocks` endLines are in
    // LADEN coordinates (C really sits at line 6 of the carrier-laden document).
    const laden = `A.\n\n<!-- rmt:comments\n${JSON.stringify({ threads: [tA] })}\n-->\n\nC.`
    const lines = laden.split('\n')
    const aEnd = lines.indexOf('A.')
    const cEnd = lines.indexOf('C.')
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: aEnd, text: 'A.' },
      { paragraphIndex: 1, startLine: cEnd, endLine: cEnd, text: 'C.' },
    ]
    const live = new Map<number, CommentThread[]>([[0, [tA]], [1, [tC]]])
    const out = serializeAfter(laden, { version: 1, docHash: '', threads: [tA, tC] }, blocks, live)
    const back = parseInline(out).threads
    expect(back).toHaveLength(2)
    expect(back.map((t) => t.anchor.quote).sort()).toEqual(['A.', 'C.'])
  })

  it('persists an orphaned thread at EOF', () => {
    const tOrphan = thread('Orphan.')
    tOrphan.orphaned = true
    const src = 'One.\n\nTwo.'
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'One.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'Two.' },
    ]
    const out = serializeAfter(src, { version: 1, docHash: '', threads: [tOrphan] }, blocks, new Map())
    const back = parseInline(out).threads
    expect(back).toHaveLength(1)
    expect(back[0].anchor.quote).toBe('Orphan.')
    expect(back[0].comments[0].body).toBe('note')
  })

  it('persists a thread whose endLine is out of range at EOF, without crashing', () => {
    const t = thread('X.')
    const blocks: Block[] = [{ paragraphIndex: 0, startLine: 0, endLine: 999, text: 'X' }]
    const live = new Map<number, CommentThread[]>([[0, [t]]])
    const src = 'One.\nTwo.'
    let out = ''
    expect(() => {
      out = serializeAfter(src, { version: 1, docHash: '', threads: [t] }, blocks, live)
    }).not.toThrow()
    const back = parseInline(out).threads
    expect(back).toHaveLength(1)
    expect(back[0].anchor.quote).toBe('X.')
  })

  it('keeps both threads when two blocks share an endLine', () => {
    const tX = thread('X.')
    const tY = thread('Y.')
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'X' },
      { paragraphIndex: 1, startLine: 0, endLine: 0, text: 'Y' },
    ]
    const live = new Map<number, CommentThread[]>([[0, [tX]], [1, [tY]]])
    const src = 'Row.'
    const out = serializeAfter(src, { version: 1, docHash: '', threads: [tX, tY] }, blocks, live)
    const back = parseInline(out).threads
    expect(back).toHaveLength(2)
    expect(back.map((t) => t.anchor.quote).sort()).toEqual(['X.', 'Y.'])
  })

  it('is idempotent for an orphaned thread (no duplication on re-serialize)', () => {
    const tOrphan = thread('Orphan.')
    tOrphan.orphaned = true
    const src = 'One.\n\nTwo.'
    const blocks: Block[] = [
      { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'One.' },
      { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'Two.' },
    ]
    const data = { version: 1, docHash: '', threads: [tOrphan] }
    const once = serializeAfter(src, data, blocks, new Map())
    const twice = serializeAfter(once, data, blocks, new Map())
    expect((twice.match(/rmt:comments/g) ?? []).length).toBe(1)
    expect(parseInline(twice).threads).toHaveLength(1)
  })

  // Feature: kiro-md-translator-plugin — serializeAfter data integrity: never lose a thread
  it('Property: recovered thread count always equals data.threads.length', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        (quotes, mask) => {
          const threads = quotes.map((q) => thread(q))
          const paras = threads.map((_, i) => `P${i}.`)
          const source = paras.join('\n\n') // one paragraph per thread, blank-separated
          const blocks: Block[] = threads.map((_, i) => ({
            paragraphIndex: i,
            startLine: 2 * i,
            endLine: 2 * i, // paragraph i sits at line 2*i in the blank-separated source
            text: paras[i],
          }))
          const live = new Map<number, CommentThread[]>()
          threads.forEach((t, i) => {
            if (mask[i % mask.length]) live.set(i, [t]) // placeable: share the SAME object
            else t.orphaned = true // left out of live → must fall through to EOF
          })
          const out = serializeAfter(source, { version: 1, docHash: '', threads }, blocks, live)
          expect(parseInline(out).threads.length).toBe(threads.length)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('inline carrier round-trip (property)', () => {
  // Raw strings — INCLUDING ones containing `-->`, `<!--`, `<`, `>`. makeBlock
  // escapes `<`/`>` in the payload so the delimiters can never appear in a body,
  // making the round-trip unconditional (design Property 21).
  const genThread = fc.record({
    anchor: fc.record({
      quote: fc.string({ minLength: 1 }),
      prefix: fc.constant(''),
      suffix: fc.constant(''),
      hintLine: fc.nat(),
      quoteHash: fc.constant(''),
    }),
    orphaned: fc.constant(false),
    comments: fc.array(
      fc.record({
        id: fc.string({ minLength: 1 }),
        body: fc.string({ minLength: 1 }),
        createdAt: fc.constant('2026-07-05T00:00:00Z'),
        updatedAt: fc.constant('2026-07-05T00:00:00Z'),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  })

  const project = (threads: CommentThread[]) =>
    threads.map((t) => ({ quote: t.anchor.quote, bodies: t.comments.map((c) => c.body) }))

  // Feature: kiro-md-translator-plugin, Property 21: inline carrier round-trips the comment set
  it('Property 21: parseInline(serializeEof(...)) round-trips quotes and bodies exactly', () => {
    fc.assert(
      fc.property(fc.array(genThread, { maxLength: 4 }), (threads) => {
        const out = serializeEof('Doc body.\n', { version: 1, docHash: '', threads: threads as never })
        const back = parseInline(out).threads
        expect(project(back)).toEqual(project(threads as never))
      }),
      { numRuns: 200 },
    )
  })

  it('inline carrier survives a comment body containing --> and <!--', () => {
    const t = {
      anchor: { quote: 'Q --> end', prefix: '', suffix: '', hintLine: 0, quoteHash: '' },
      orphaned: false,
      comments: [{ id: 'c0', body: 'arrow --> and opener <!-- inside', createdAt: '', updatedAt: '' }],
    }
    const out = serializeEof('Body.\n', { version: 1, docHash: '', threads: [t as never] })
    const back = parseInline(out).threads
    expect(back).toHaveLength(1)
    expect(back[0].comments[0].body).toBe('arrow --> and opener <!-- inside')
    expect(back[0].anchor.quote).toBe('Q --> end')
    // The adversarial delimiters in the body must not leave a stray carrier fragment.
    expect(stripInlineComments(out)).toBe('Body.\n')
  })
})
