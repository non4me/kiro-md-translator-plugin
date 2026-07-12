# Code Comment Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the prose inside code-block comments while leaving every non-comment byte of the code untouched.

**Architecture:** A dependency-free three-state scanner (`code` / `string` / `comment`) turns a fenced body plus its info-string language into offset spans covering only comment prose. A splice rebuilds the body, copying everything outside the spans verbatim. `TranslationEngine` feeds those spans into the existing segment/cache/batch pipeline, so glossary masking, caching, cancellation and export are all inherited.

**Tech Stack:** TypeScript, unified/remark (mdast), vitest, fast-check.

**Spec:** `docs/superpowers/specs/2026-07-12-code-comment-translation-design.md`

---

### Task 29.1: The scanner and the splice

**Files:**
- Create: `src/codeComments.ts`
- Test: `test/codeComments.test.ts`

- [ ] **Step 1: Write the failing tests** — the trap cases first, because they are the reason the module exists.

```typescript
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { commentSpans, spliceComments, fencedBody } from '../src/codeComments'

const texts = (code: string, lang?: string) => commentSpans(code, lang).map((s) => s.text)

describe('commentSpans', () => {
  it('finds a line comment and excludes the marker', () => {
    expect(texts('const a = 1 // set the value', 'js')).toEqual(['set the value'])
  })

  it('does NOT treat // inside a string as a comment', () => {
    expect(texts('const u = "https://example.com" // the endpoint', 'js')).toEqual(['the endpoint'])
  })

  it('does NOT treat # inside a shell parameter expansion as a comment', () => {
    expect(texts('echo "${x#y}" # strip the prefix', 'bash')).toEqual(['strip the prefix'])
  })

  it('does NOT treat # inside a python string as a comment', () => {
    expect(texts('s = "a # b"  # the separator', 'python')).toEqual(['the separator'])
  })

  it('does NOT treat // as a comment in CSS', () => {
    expect(texts('a { background: url(http://x/y.png); /* the logo */ }', 'css')).toEqual(['the logo'])
  })

  it('treats -- as a comment in SQL but not in C', () => {
    expect(texts('SELECT 1 -- the answer', 'sql')).toEqual(['the answer'])
    expect(texts('int i = 0; i--; // the counter', 'c')).toEqual(['the counter'])
  })

  it('matches the Lua block opener before the line marker', () => {
    expect(texts('--[[ the header\n     the tail ]]\nx = 1', 'lua')).toEqual(['the header', 'the tail'])
  })

  it('survives a Rust lifetime (no char-literal string delimiter)', () => {
    expect(texts("fn f<'a>(s: &'a str) {} // borrow it", 'rust')).toEqual(['borrow it'])
  })

  it('does not treat a shebang as a comment', () => {
    expect(texts('#!/usr/bin/env bash\necho hi # say hi', 'bash')).toEqual(['say hi'])
  })

  it('strips decoration but leaves it outside the span', () => {
    const code = '/**\n * Does the thing.\n * ----------\n */'
    expect(texts(code, 'js')).toEqual(['Does the thing.'])
  })

  it('skips spans with no letters', () => {
    expect(texts('// ======\nx = 1 // 42', 'js')).toEqual([])
  })

  it('returns nothing for an unknown or absent language', () => {
    expect(commentSpans('// hi', 'brainfuck')).toEqual([])
    expect(commentSpans('// hi', undefined)).toEqual([])
  })
})

describe('spliceComments', () => {
  it('replaces only the span text', () => {
    const code = 'const a = 1 // set the value'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['задать значение'])).toBe('const a = 1 // задать значение')
  })

  it('collapses a newline in the translation (it would become code)', () => {
    const code = 'x = 1 // one'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['один\nдва'])).toBe('x = 1 // один два')
  })

  it('discards a translation containing the block closer', () => {
    const code = '/* the thing */'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['штука */ x'])).toBe(code)
  })

  it('discards a blank translation', () => {
    const code = '// the thing'
    const spans = commentSpans(code, 'js')
    expect(spliceComments(code, spans, ['   '])).toBe(code)
  })

  // Feature: kiro-md-translator-plugin, Property 24: the splice round-trips
  it('Property 24: identity replacement reproduces the block exactly', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('js', 'python', 'sql', 'lua', 'css', 'html', 'rust', 'bash'),
        fc.string(),
        (lang, code) => {
          const spans = commentSpans(code, lang)
          expect(spliceComments(code, spans, spans.map((s) => s.text))).toBe(code)
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

  it('returns undefined for text that is not a fenced block', () => {
    expect(fencedBody('Just a paragraph.')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/codeComments.test.ts`
Expected: FAIL — `Failed to resolve import "../src/codeComments"`.

- [ ] **Step 3: Implement `src/codeComments.ts`**

The module has no imports. Structure:

- `interface StringSpec { open: string; close: string; escape?: string }`
- `interface LangSpec { line: string[]; block: Array<[string, string]>; strings: StringSpec[]; lineNeedsBoundary?: boolean }`
- `export interface CommentSpan { start: number; end: number; text: string; forbidden: readonly string[] }`
- `const SPECS: Record<string, LangSpec>` built from shared `C_LIKE` / `RUST` / `HASH` / `PY` / `SQL` / `LUA` / `HASKELL` / `XML` / `CSS` / `LISP` / `PS` / `PERCENT` constants, keyed by every alias (`js`, `javascript`, `jsx`, `mjs`, `cjs`, `ts`, …).
- `export function specFor(lang?: string | null): LangSpec | undefined` — lowercase, trim, table lookup.
- `export function commentSpans(code: string, lang?: string | null): CommentSpan[]` — the scanner.
- `export function spliceComments(code, spans, translations): string` — the splice + output guards.
- `export function fencedBody(raw: string): { start: number; end: number; lang?: string; fence: string } | undefined`

Scanner loop, at each offset `i`, in this order (longest-opener-first within each group):

1. a block opener → consume to its closer, emit prose spans from the enclosed lines, `forbidden = [closer]`
2. a line marker (respecting `lineNeedsBoundary`, and never a `#!` at offset 0) → consume to end of line, emit one prose span, `forbidden = []`
3. a string opener → consume to its close, honouring `escape`
4. otherwise advance one character

Prose extraction from one raw line: trim `/^[\s*/#;=~+!<>|-]+/` from the left and `/[\s*/#;=~+|-]+$/` from the right; emit only if the remainder matches `/\p{L}/u`.

Splice: walk spans ascending, `out += code.slice(cursor, s.start) + replacement; cursor = s.end`, then append the tail. `replacement` is `s.text` unless the translation is a non-blank string that, after `replace(/[\r\n]+/g, ' ')`, contains none of `s.forbidden`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/codeComments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codeComments.ts test/codeComments.test.ts
git commit -m "feat(translate): comment scanner for fenced code blocks (req 3.22, P24)"
```

---

### Task 29.2: Wire the scanner into the translation pipeline

**Files:**
- Modify: `src/TranslationEngine.ts` (`translateMdast`, `translateParagraph`)
- Test: `test/TranslationEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
it('translates comments inside a fenced code block and leaves the code identical', async () => {
  const seen: string[] = []
  const { engine } = makeEngine(async (segs) => {
    seen.push(...segs)
    return segs.map((s) => `T(${s})`)
  })
  const md = '```js\nconst u = "https://x/y" // the endpoint\n```\n'
  const out = await engine.translateToMarkdown(md, 'en', 'de', new AbortController().signal)
  expect(seen).toContain('the endpoint')
  expect(seen.some((s) => s.includes('https://x/y'))).toBe(false)
  expect(out).toContain('const u = "https://x/y" // T(the endpoint)')
})

it('leaves a fenced block with an unknown language byte-identical', async () => {
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

it('translateParagraph on a code block sends only the comment prose', async () => {
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
```

Also extend the existing Property 2 test with a language-carrying fence: assert no segment
contains `CODE_TOKEN` from `` ```js\nconst CODE_TOKEN = 1 // prose\n``` ``.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/TranslationEngine.test.ts`
Expected: FAIL — code is not translated; `translateParagraph` sends the whole block.

- [ ] **Step 3: Implement**

In `translateMdast`, replace the `text`-only walk with a unit list:

```typescript
interface Unit { segments: string[]; apply(translated: string[]): void }
const units: Unit[] = []
visit(mdast, (node: AnyNode) => {
  if (node.type === 'text' && typeof node.value === 'string' && node.value.trim().length > 0) {
    units.push({ segments: [node.value], apply: ([t]) => { node.value = t } })
  } else if (node.type === 'code' && typeof node.value === 'string') {
    const spans = commentSpans(node.value, node.lang)
    if (spans.length === 0) return
    units.push({
      segments: spans.map((s) => s.text),
      apply: (ts) => { node.value = spliceComments(node.value, spans, ts) },
    })
  }
})
const flat = units.flatMap((u) => u.segments)
const translated = await this.translateSegments(flat, sourceLang, targetLang, signal)
let k = 0
for (const u of units) u.apply(translated.slice(k, (k += u.segments.length)))
```

In `translateParagraph`, short-circuit a fenced block before the normal path:

```typescript
const fence = fencedBody(text)
if (fence) {
  const body = text.slice(fence.start, fence.end)
  const spans = commentSpans(body, fence.lang).map((s) => ({ ...s, forbidden: [...s.forbidden, fence.fence] }))
  if (spans.length === 0) return text
  const ts = await this.translateSegments(spans.map((s) => s.text), sourceLang, targetLang, signal)
  return text.slice(0, fence.start) + spliceComments(body, spans, ts) + text.slice(fence.end)
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green; the pre-existing Property 2 test still passes (its fence has no info string).

- [ ] **Step 5: Commit**

```bash
git add src/TranslationEngine.ts test/TranslationEngine.test.ts
git commit -m "feat(translate): translate comments inside fenced code blocks (req 3.7, 3.22)"
```

---

### Task 29.3: Spec id chain

**Files:**
- Modify: `.kiro/specs/kiro-md-translator-plugin/requirements.md` (amend 3.7, add 3.22)
- Modify: `.kiro/specs/kiro-md-translator-plugin/design.md` (restate Property 2, add Property 24, amend pipeline step 2, add the testing-table row)
- Modify: `.kiro/specs/kiro-md-translator-plugin/tasks.md` (add task 29, add 29.1 to the mandatory test set)

- [ ] **Step 1:** Amend 3.7 to exclude fenced code "except the prose content of its comments (3.22)".
- [ ] **Step 2:** Add 3.22 — the scanner contract, the unknown-language rule, the byte-identity rule, the output guards.
- [ ] **Step 3:** Restate Property 2; add Property 24 (splice round-trip); add its testing-table row.
- [ ] **Step 4:** Add task 29 with a `_Requirements: 3.7, 3.22_` footer.

Note: `.kiro/specs/` is gitignored — these edits stay working-tree-only and are not committed.
