import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { commentSpans, spliceComments, fencedBody } from '../src/codeComments'

const texts = (code: string, lang?: string) => commentSpans(code, lang).map((s) => s.text)

describe('commentSpans', () => {
  it('finds a line comment and excludes the marker', () => {
    expect(texts('const a = 1 // set the value', 'js')).toEqual(['set the value'])
  })

  it('finds a block comment', () => {
    expect(texts('/* the header */\nx = 1', 'js')).toEqual(['the header'])
  })

  // Each of the following is a specific way a naive scanner corrupts code.
  it('does NOT treat // inside a string as a comment', () => {
    expect(texts('const u = "https://example.com" // the endpoint', 'js')).toEqual(['the endpoint'])
  })

  it('does NOT treat # inside a shell parameter expansion as a comment', () => {
    expect(texts('echo "${x#y}" # strip the prefix', 'bash')).toEqual(['strip the prefix'])
  })

  it('does NOT treat # inside a python string as a comment', () => {
    expect(texts('s = "a # b"  # the separator', 'python')).toEqual(['the separator'])
  })

  it('does NOT treat # inside a python docstring as a comment', () => {
    expect(texts('def f():\n    """Not # a comment."""\n    return 1  # the answer', 'python')).toEqual([
      'the answer',
    ])
  })

  it('does NOT treat // as a comment in CSS', () => {
    expect(texts('a { background: url(http://x/y.png); /* the logo */ }', 'css')).toEqual(['the logo'])
  })

  it('treats -- as a comment in SQL but never in C', () => {
    expect(texts('SELECT 1 -- the answer', 'sql')).toEqual(['the answer'])
    expect(texts('int i = 0; i--; // the counter', 'c')).toEqual(['the counter'])
  })

  it('matches the Lua block opener before the line marker', () => {
    expect(texts('--[[ the header\n     the tail ]]\nx = 1', 'lua')).toEqual(['the header', 'the tail'])
  })

  it('handles a Lua long bracket at ANY level, not just --[[', () => {
    // A fixed `--[[` pair would fall through to the `--` line marker, put `[==[`
    // inside the span, and splice the translation over the opener — turning the
    // body of the comment into live code.
    const code = '--[==[ the header\nprint("inside")\n]==]\nprint("real")'
    expect(texts(code, 'lua')).toContain('the header')
    const spans = commentSpans(code, 'lua')
    expect(spliceComments(code, spans, spans.map(() => 'ПЕРЕВОД'))).toContain('--[==[ ПЕРЕВОД')
    expect(spliceComments(code, spans, spans.map(() => 'ПЕРЕВОД'))).toContain(']==]\nprint("real")')
  })

  it('does NOT treat -- inside a Lua long string as a comment', () => {
    // Otherwise the span swallows the `]]` terminator and the translation destroys it.
    expect(texts('s = [[ a -- b ]]\nx = 1 -- the note', 'lua')).toEqual(['the note'])
  })

  it('does NOT read the end of a JS regex literal as a comment', () => {
    // `/\/\//` puts an escaped slash next to the closing slash. Read naively, that
    // `//` starts a comment and the rest of the statement is translated away.
    expect(texts(String.raw`url.replace(/\/\//g, '/')`, 'js')).toEqual([])
    expect(texts(String.raw`const re = /\/\//; call(x) // the note`, 'js')).toEqual(['the note'])
    // Division must still not be mistaken for a regex.
    expect(texts('const r = a / b // the ratio', 'js')).toEqual(['the ratio'])
    expect(texts('const r = (a + b) / c // the mean', 'ts')).toEqual(['the mean'])
    // A regex after a keyword is still a regex.
    expect(texts(String.raw`return /a\/\//.test(s) // matched`, 'js')).toEqual(['matched'])
  })

  it('survives a Rust lifetime (no char-literal delimiter)', () => {
    expect(texts("fn f<'a>(s: &'a str) {} // borrow it", 'rust')).toEqual(['borrow it'])
  })

  it('does not treat a shebang as a comment', () => {
    expect(texts('#!/usr/bin/env bash\necho hi # say hi', 'bash')).toEqual(['say hi'])
  })

  it('leaves decoration outside the span so the splice preserves it', () => {
    const code = '/**\n * Does the thing.\n * ----------\n */'
    expect(texts(code, 'js')).toEqual(['Does the thing.'])
    // The `- ` of a list bullet is decoration too — preserved, not translated.
    const bullet = '// - first item'
    expect(texts(bullet, 'js')).toEqual(['first item'])
    expect(spliceComments(bullet, commentSpans(bullet, 'js'), ['первый пункт'])).toBe(
      '// - первый пункт',
    )
  })

  it('skips spans with no letters', () => {
    expect(texts('// ======\nx = 1 // 42', 'js')).toEqual([])
  })

  it('returns nothing for an unknown or absent language', () => {
    expect(commentSpans('// hi there', 'brainfuck')).toEqual([])
    expect(commentSpans('// hi there', undefined)).toEqual([])
    expect(commentSpans('// hi there', null)).toEqual([])
  })

  it('reads the language from an info string that carries attributes', () => {
    expect(texts('x = 1 // note', 'js title="a.js"')).toEqual(['note'])
  })

  it('finds a comment in an HTML block without an apostrophe swallowing it', () => {
    expect(texts("<p>don't</p>\n<!-- the note -->", 'html')).toEqual(['the note'])
  })
})

describe('spliceComments', () => {
  it('replaces only the span text', () => {
    const code = 'const a = 1 // set the value'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['задать значение'])).toBe('const a = 1 // задать значение')
  })

  it('collapses a newline in the translation — it would otherwise become code', () => {
    const code = 'x = 1 // one'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['один\nдва'])).toBe('x = 1 // один два')
    expect(spliceComments(code, spans, ['один\r\nдва'])).toBe('x = 1 // один два')
    // U+2028/U+2029 are line terminators in JavaScript — \n-only collapsing misses them.
    expect(spliceComments(code, spans, ['один\u2028два'])).toBe('x = 1 // один два')
    expect(spliceComments(code, spans, ['один\u2029два'])).toBe('x = 1 // один два')
  })

  it('discards a translation containing the block closer', () => {
    const code = '/* the thing */\nrm -rf /'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['штука */ evil()'])).toBe(code)
  })

  it('discards a blank translation, keeping the source text', () => {
    const code = '// the thing'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['   '])).toBe(code)
    expect(spliceComments(code, spans, [undefined])).toBe(code)
  })

  // Feature: kiro-md-translator-plugin, Property 24: the splice round-trips
  it('Property 24: identity replacement reproduces the block exactly', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('js', 'python', 'sql', 'lua', 'css', 'html', 'rust', 'bash', 'clojure'),
        fc.string(),
        (lang, code) => {
          const spans = commentSpans(code, lang)
          expect(spliceComments(code, spans, spans.map((s) => s.text))).toBe(code)
        },
      ),
      { numRuns: 100 },
    )
  })

  // Feature: kiro-md-translator-plugin, Property 24: non-comment bytes never move
  it('Property 24: the block outside its comments is identical after translation', () => {
    // Everything that is not comment prose — code, markers, indentation, decoration.
    const skeleton = (s: string, lang: string) => {
      let out = ''
      let cursor = 0
      for (const span of commentSpans(s, lang)) {
        out += s.slice(cursor, span.start)
        cursor = span.end
      }
      return out + s.slice(cursor)
    }
    fc.assert(
      fc.property(
        fc.constantFrom('js', 'python', 'sql', 'lua', 'css', 'html', 'rust', 'bash'),
        fc.string(),
        (lang, code) => {
          const spans = commentSpans(code, lang)
          const out = spliceComments(code, spans, spans.map(() => 'ПЕРЕВОД'))
          expect(skeleton(out, lang)).toBe(skeleton(code, lang))
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('fencedBody', () => {
  it('locates the body of a fenced block and its language', () => {
    const raw = '```js\nconst a = 1 // hi\n```'
    const body = fencedBody(raw)
    expect(body?.lang).toBe('js')
    expect(raw.slice(body!.start, body!.end)).toBe('const a = 1 // hi')
  })

  it('handles an empty body and a missing closer', () => {
    expect(fencedBody('```js\n```')).toMatchObject({ lang: 'js' })
    const empty = fencedBody('```js\n```')!
    expect('```js\n```'.slice(empty.start, empty.end)).toBe('')
    const open = fencedBody('```js\nx = 1')!
    expect('```js\nx = 1'.slice(open.start, open.end)).toBe('x = 1')
  })

  it('returns undefined for text that is not a fenced block', () => {
    expect(fencedBody('Just a paragraph.')).toBeUndefined()
    expect(fencedBody('    indented code')).toBeUndefined()
  })
})
