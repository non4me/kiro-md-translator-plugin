import { describe, it, expect } from 'vitest'
import { MarkdownRenderer } from '../src/MarkdownRenderer'
import { Uri } from './mocks/vscode'

const dir = Uri.file('/docs') as never

describe('MarkdownRenderer', () => {
  it('renders CommonMark/GFM and annotates blocks with data-paragraph-index', async () => {
    const r = new MarkdownRenderer()
    const { html, lineMap } = await r.render('# Title\n\nHello **bold** and `code`.\n', dir)
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('data-paragraph-index="0"')
    expect(html).toContain('data-paragraph-index="1"')
    expect(lineMap).toHaveLength(2)
    expect(lineMap[0].startLine).toBe(0)
  })

  it('renders a GFM table and a list', async () => {
    const r = new MarkdownRenderer()
    const { html } = await r.render('- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', dir)
    expect(html).toContain('<li')
    expect(html).toContain('<table>')
  })

  // Feature: kiro-md-translator-plugin, Property 25: every fenced code block and every table row
  // carries a data-paragraph-index and a lineMap entry matching its source lines; the table wrapper
  // and cells do not. Covers the indexing half of P25 by example; the "single-block translation
  // never leaks structure" half is marked in TranslationEngine.test.ts, and the "source and
  // translated renders assign identical indices" clause lives in test/integration/preview-render.
  it('Property 25: indexes code blocks and table rows, but not the table wrapper or cells', () => {
    const r = new MarkdownRenderer()
    const md = 'Intro.\n\n```js\nconst x = 1 // n\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |'
    const { html, lineMap } = r.renderMdast(r.parse(md), dir)
    // p(0), pre(1), then three rows: header(2) + two body rows(3,4).
    expect(/<pre[^>]*data-paragraph-index="1"/.test(html)).toBe(true)
    expect((html.match(/data-paragraph-index/g) ?? []).length).toBe(5)
    expect(html).not.toMatch(/<table[^>]*data-paragraph-index/)
    expect(html).not.toMatch(/<td[^>]*data-paragraph-index/)
    expect(html).not.toMatch(/<th[^>]*data-paragraph-index/)
    // The code block's lineMap range spans its fence lines (source lines 2..4, 0-based:
    // the opening ```js, the one code line, and the closing ```).
    expect(lineMap[1]).toMatchObject({ paragraphIndex: 1, startLine: 2, endLine: 4 })
    // Each table row maps to its own single source line.
    expect(lineMap[3].startLine).toBe(lineMap[3].endLine)
  })

  // Feature: kiro-md-translator-plugin, Property 28: rendering wraps code tokens in hljs-* spans
  // without highlighting inline code, and an unknown language yields no colouring and never throws.
  // Covers the rendering half of P28 by example; the theme-selector half is marked in
  // highlightThemes.test.ts. The "without altering" half is the differential case at the end:
  // highlighting runs inside the same pipeline that builds the lineMap, so a token wrapper that
  // shifted a block's range would corrupt the surgical write-back for the whole document.
  it('Property 28: syntax-highlights fenced code blocks (req 12): tags tokens with hljs classes', async () => {
    const r = new MarkdownRenderer()
    const { html } = await r.render('```js\nconst x = 1 // note\n```\n', dir)
    expect(html).toContain('class="hljs') // the code element is marked highlighted
    expect(html).toContain('hljs-comment') // the comment is coloured as a comment (translation synergy)
    expect(html).toMatch(/hljs-keyword|hljs-number/) // at least one code token span
  })

  it('Property 28: highlighting changes no code byte and shifts no block line range', async () => {
    const src = [
      '# Title',
      '',
      'A paragraph before the code.',
      '',
      '```js',
      'const url = "https://x/y"  //  spaced note',
      '\tconst tabbed = 1',
      'if (a < b && c > d) { /* ok */ }',
      '```',
      '',
      'A paragraph after the code.',
    ]
    const doc = src.join('\n')
    const { html, lineMap } = await new MarkdownRenderer().render(doc, dir)
    expect(html).toContain('hljs-') // the guard: colouring really happened

    // (a) The code TEXT survives the token wrapping. The oracle is the SOURCE, not a
    //     second render — the double space, the tab and the operators that have to be
    //     entity-escaped are exactly what a careless wrapper would eat.
    // `<pre>` carries a data-paragraph-index of its own (req 10.9), so it is not a bare tag.
    const m = /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/.exec(html)
    expect(m).not.toBeNull()
    // One pass over the entities, never a chain: decoding `&#x26;` to `&` and THEN
    // decoding `&amp;` would turn `&amp;` in the source into a bare `&`.
    const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }
    const codeText = m![1]
      .replace(/<[^>]+>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
        if (/^#x/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16))
        if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)))
        return NAMED[entity.toLowerCase()] ?? whole
      })
    expect(codeText.replace(/\n$/, '')).toBe(src.slice(5, 8).join('\n'))

    // (b) Every block's line range still points at its own source lines. This is the
    //     clause that matters: the map is what replaceParagraphInSource splices against,
    //     so a range shifted by the wrapper would corrupt a save anywhere in the file.
    const sliceOf = (i: number): string => {
      const map = lineMap.find((e) => e.paragraphIndex === i)!
      return src.slice(map.startLine, map.endLine + 1).join('\n').trim()
    }
    expect(lineMap.length).toBeGreaterThanOrEqual(4)
    expect(sliceOf(0)).toBe('# Title')
    expect(sliceOf(1)).toBe('A paragraph before the code.')
    expect(sliceOf(lineMap[lineMap.length - 1].paragraphIndex)).toBe('A paragraph after the code.')
    // The fence is an indexed block too (req 10.9); its range must cover the whole fence.
    const fence = lineMap.find((e) => sliceOf(e.paragraphIndex).startsWith('```js'))
    expect(fence).toBeDefined()
    expect(sliceOf(fence!.paragraphIndex)).toBe(src.slice(4, 9).join('\n'))
  })

  it('Property 28: does not highlight inline code (req 12): only fenced blocks are coloured', async () => {
    const r = new MarkdownRenderer()
    const { html } = await r.render('a `const x` inline.\n', dir)
    expect(html).toContain('<code>const x</code>') // inline code left untouched, no hljs spans
  })

  it('Property 28: leaves an unknown code language untouched (req 12): no throw, no colouring', async () => {
    const r = new MarkdownRenderer()
    const { html } = await r.render('```not-a-language\nplain text body\n```\n', dir)
    expect(html).toContain('plain text body') // rendered fine, pipeline did not throw
  })

  it('shows the empty-content placeholder for an empty file', async () => {
    const r = new MarkdownRenderer()
    const { html, lineMap } = await r.render('   \n', dir)
    expect(html).toContain('empty-content')
    expect(html).toContain('The file has no content')
    expect(lineMap).toEqual([])
  })

  it('resolves relative image paths and keeps absolute URLs', async () => {
    const r = new MarkdownRenderer((rel) => `RES:${rel}`)
    const { html } = await r.render('![a](pic.png)\n\n![b](https://x/y.png)', dir)
    expect(html).toContain('RES:pic.png')
    expect(html).toContain('https://x/y.png')
  })
})
