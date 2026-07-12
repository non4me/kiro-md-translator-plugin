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

  it('indexes code blocks and table rows, but not the table wrapper or cells', () => {
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
