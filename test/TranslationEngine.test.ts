import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { visit } from 'unist-util-visit'
import { TranslationEngine } from '../src/TranslationEngine'
import { TranslationCache } from '../src/TranslationCache'
import { MarkdownRenderer } from '../src/MarkdownRenderer'
import { Uri } from './mocks/vscode'

const dir = Uri.file('/docs') as never

type Batch = (
  segs: string[],
  source: string,
  target: string,
  signal: AbortSignal,
) => Promise<string[]>

function makeEngine(translateBatch: Batch, glossary: string[] = []) {
  const cache = new TranslationCache()
  const renderer = new MarkdownRenderer()
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    translateBatch,
    getSupportedLanguages: async () => [],
    testConnection: async () => {},
  }
  const engine = new TranslationEngine(() => provider as never, cache, renderer, () => glossary)
  return { engine, cache, renderer }
}

function countType(tree: unknown, type: string): number {
  let n = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visit(tree as any, type, () => {
    n += 1
  })
  return n
}

describe('TranslationEngine', () => {
  // Feature: kiro-md-translator-plugin, Property 2: Code/URL segments are excluded from translation input
  it('Property 2: sends no code, inline code or URL — only the prose of code comments', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => !/[`[\]()\n#|>*_]/.test(s)),
        async (prose) => {
          const seen: string[] = []
          const { engine } = makeEngine(async (segs) => {
            seen.push(...segs)
            return segs.map((s) => `T(${s})`)
          })
          const md =
            `${prose}\n\n\`\`\`\nFENCED_BODY\n\`\`\`\n\n` +
            `\`\`\`js\nconst CODE_TOKEN = "https://x/y" // the prose\n\`\`\`\n\n` +
            'Inline `INLINE_CODE` and [link](https://example.com/url).'
          await engine.translateToMarkdown(md, 'en', 'de', new AbortController().signal)
          for (const seg of seen) {
            // A fence with no info string is left alone entirely.
            expect(seg).not.toContain('FENCED_BODY')
            expect(seg).not.toContain('INLINE_CODE')
            expect(seg).not.toContain('example.com/url')
            // A fence WITH a language gives up its comment prose and nothing else (3.22).
            expect(seg).not.toContain('CODE_TOKEN')
            expect(seg).not.toContain('https://x/y')
          }
          expect(seen).toContain('the prose')
        },
      ),
      { numRuns: 50 },
    )
  })

  it('translates comments inside a fenced code block, leaving the code byte-identical', async () => {
    const { engine } = makeEngine(async (segs) => segs.map((s) => `T(${s})`))
    const md = '```js\nconst u = "https://x/y" // the endpoint\n```\n'
    const out = await engine.translateToMarkdown(md, 'en', 'de', new AbortController().signal)
    expect(out).toContain('const u = "https://x/y" // T(the endpoint)')
  })

  it('leaves a fenced block with an unknown language byte-identical (3.22)', async () => {
    const seen: string[] = []
    const { engine } = makeEngine(async (segs) => {
      seen.push(...segs)
      return segs.map((s) => `T(${s})`)
    })
    const md = '```brainfuck\n+++ // not a comment here\n```\n'
    const out = await engine.translateToMarkdown(md, 'en', 'de', new AbortController().signal)
    expect(seen).toEqual([])
    expect(out).toContain('+++ // not a comment here')
  })

  it('translateParagraph on a code block sends only the comment prose (3.7)', async () => {
    const seen: string[] = []
    const { engine } = makeEngine(async (segs) => {
      seen.push(...segs)
      return segs.map((s) => `T(${s})`)
    })
    const raw = '```python\nx = "a # b"  # the separator\n```'
    const out = await engine.translateParagraph(raw, 'en', 'de', new AbortController().signal)
    expect(seen).toEqual(['the separator'])
    expect(out).toBe('```python\nx = "a # b"  # T(the separator)\n```')
  })

  it('translateParagraph never sends a code block that has no comments', async () => {
    const seen: string[] = []
    const { engine } = makeEngine(async (segs) => {
      seen.push(...segs)
      return segs.map((s) => `T(${s})`)
    })
    const raw = '```js\nconst secret = "hunter2"\n```'
    const out = await engine.translateParagraph(raw, 'en', 'de', new AbortController().signal)
    expect(seen).toEqual([])
    expect(out).toBe(raw)
  })

  it('translateParagraph still translates ordinary prose', async () => {
    const { engine } = makeEngine(async (segs) => segs.map((s) => `T(${s})`))
    const out = await engine.translateParagraph('Hello world.', 'en', 'de', new AbortController().signal)
    expect(out).toBe('T(Hello world.)')
  })

  // End-to-end guard over the whole pipeline: every trap in one document. The unit
  // tests pin the scanner; this pins the WIRING (a wrong lang, a missed node type).
  it('a document of nothing but corruption traps keeps every executable line', async () => {
    const seen: string[] = []
    const { engine } = makeEngine(async (segs) => {
      seen.push(...segs)
      return segs.map((s) => `[RU]${s}`)
    })
    const md = [
      '```js',
      "const clean = url.replace(/\\/\\//g, '/') // collapse double slashes",
      'const api = "https://api.example.com/v1" // the endpoint',
      '```',
      '',
      '```lua',
      '--[==[ module notes',
      ']==]',
      'local s = [[ raw -- not a comment ]]',
      'print(s) -- show it',
      '```',
      '',
      '```bash',
      '#!/usr/bin/env bash',
      'echo "${PATH#/usr}" # strip the prefix',
      '```',
    ].join('\n')

    const out = await engine.translateToMarkdown(md, 'en', 'ru', new AbortController().signal)

    for (const seg of seen) {
      expect(seg).not.toContain('url.replace')
      expect(seg).not.toContain('api.example.com')
      expect(seg).not.toContain('PATH#/usr')
      expect(seg).not.toContain('usr/bin/env')
    }
    for (const line of [
      "const clean = url.replace(/\\/\\//g, '/')",
      'const api = "https://api.example.com/v1"',
      'local s = [[ raw -- not a comment ]]',
      '#!/usr/bin/env bash',
      'echo "${PATH#/usr}"',
      '--[==[',
      ']==]',
    ]) {
      expect(out).toContain(line)
    }
    expect(seen).toContain('collapse double slashes')
    expect(seen).toContain('strip the prefix')
  })

  // Feature: kiro-md-translator-plugin, Property 3: Translation cache is a round-trip store
  it('Property 3: identical input is served from cache on the second call', async () => {
    let calls = 0
    const { engine } = makeEngine(async (segs) => {
      calls += 1
      return segs.map((s) => `T(${s})`)
    })
    const md = 'Hello world.\n\nSecond paragraph.'
    const signal = new AbortController().signal
    await engine.translate(md, 'en', 'de', signal, dir)
    await engine.translate(md, 'en', 'de', signal, dir)
    expect(calls).toBe(1)
  })

  // Feature: kiro-md-translator-plugin, Property 1: Markdown structure is preserved through translation
  it('Property 1: structure survives translation even with markdown-significant output', async () => {
    const { engine, renderer } = makeEngine(async (segs) => segs.map(() => 'X * | # `'))
    const md = '# H\n\n- a\n- b\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nPara.'
    const out = await engine.translateToMarkdown(md, 'en', 'de', new AbortController().signal)
    const before = renderer.parse(md)
    const after = renderer.parse(out)
    expect(countType(after, 'heading')).toBe(countType(before, 'heading'))
    expect(countType(after, 'listItem')).toBe(countType(before, 'listItem'))
    expect(countType(after, 'table')).toBe(countType(before, 'table'))
  })

  // Feature: kiro-md-translator-plugin, Property 10: Active file switch cancels pending requests
  it('Property 10: an aborted signal stops translation', async () => {
    const { engine } = makeEngine(async (segs) => segs)
    const ac = new AbortController()
    ac.abort()
    await expect(engine.translate('Hi there.', 'en', 'de', ac.signal, dir)).rejects.toBeTruthy()
  })

  it('treats an empty translation field as missing and keeps the source text (3.14)', async () => {
    const { engine } = makeEngine(async (segs) => segs.map(() => ''))
    const out = await engine.translateToMarkdown('Hello world.', 'en', 'de', new AbortController().signal)
    expect(out).toContain('Hello world')
  })

  it('uses Storage_Language as the source language, not auto (3.17)', async () => {
    let seenSource = ''
    const { engine } = makeEngine(async (segs, source) => {
      seenSource = source
      return segs.map((s) => `T(${s})`)
    })
    await engine.translate('Hello.', 'en', 'de', new AbortController().signal, dir)
    expect(seenSource).toBe('en')
  })

  // Feature: kiro-md-translator-plugin, Property 16: Glossary terms masked out of translation input, restored verbatim
  it('Property 16: glossary terms are never sent to the provider and are restored verbatim', async () => {
    const terms = ['GitHub', 'DataLite', 'TSM', 'WidgetKit']
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...terms), { minLength: 1, maxLength: 6 }),
        async (sample) => {
          const seen: string[] = []
          const { engine } = makeEngine(async (segs) => {
            seen.push(...segs)
            return segs.map((s) => `translated ${s}`)
          }, terms)
          const para = sample.map((t, i) => `word${i} ${t} tail${i}`).join(' and ')
          const out = await engine.translateToMarkdown(para, 'en', 'de', new AbortController().signal)
          // (a) no glossary term is present in any segment sent to the provider
          for (const seg of seen) {
            for (const term of terms) expect(seg).not.toContain(term)
          }
          // (b) each term that occurred is restored verbatim in the output
          for (const term of new Set(sample)) expect(out).toContain(term)
        },
      ),
      { numRuns: 50 },
    )
  })

  it('replaceParagraphInSource rewrites only the target range (7.14)', () => {
    const { engine } = makeEngine(async (segs) => segs)
    const src = 'a\nb\nc'
    const lineMap = [{ paragraphIndex: 0, startLine: 1, endLine: 1 }]
    expect(engine.replaceParagraphInSource(src, lineMap, 0, 'B')).toBe('a\nB\nc')
  })
})
