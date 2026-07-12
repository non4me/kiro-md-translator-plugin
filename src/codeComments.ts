/**
 * Finds the prose inside code-block comments so it can be translated (req 3.22),
 * while every other byte of the code is left alone (req 3.7, Property 24).
 *
 * The governing rule is asymmetric: a false negative costs one untranslated
 * fragment, a false positive splices translated text into the program. So every
 * ambiguity resolves to "this is not a comment".
 *
 * The scanner is a three-state machine — code / string literal / comment — not a
 * language parser. It emits SPANS covering only comment prose; markers, indentation
 * and decoration fall outside every span and are therefore copied verbatim by the
 * splice. That is what makes "the code does not change" structural rather than
 * merely tested.
 */

interface StringSpec {
  open: string
  close: string
  escape?: string
}

interface LangSpec {
  /** Line-comment markers. */
  line: string[]
  /** Block-comment marker pairs. */
  block: Array<readonly [string, string]>
  /** Literals the scanner must skip over, so a marker inside one is not a comment. */
  strings: StringSpec[]
  /** Marker only counts at start-of-line or after whitespace. Keeps `${x#y}` code. */
  lineNeedsBoundary?: boolean
  /** The language has `/…/` regex literals, which can end in `//` and be misread
   *  as a comment. See `startsRegex`. */
  regexLiterals?: boolean
  /** Lua long brackets, at ANY level: `--[==[ … ]==]` comments and `[==[ … ]==]`
   *  strings. A fixed `--[[`/`]]` pair silently corrupts every other level — the
   *  scanner would read `--[==[` as a plain `--` line comment, splice a translation
   *  over the `[==[`, and the body of the long comment would become live code. */
  longBrackets?: boolean
}

export interface CommentSpan {
  start: number
  /** Exclusive. */
  end: number
  text: string
  /** Tokens that must not appear in a replacement — they would end the comment early. */
  forbidden: readonly string[]
}

const DQ: StringSpec = { open: '"', close: '"', escape: '\\' }
const SQ: StringSpec = { open: "'", close: "'", escape: '\\' }
const BQ: StringSpec = { open: '`', close: '`', escape: '\\' }

const C_LIKE: LangSpec = { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ, BQ] }
/** JavaScript and friends only: `/…/` is a regex literal, and one ending in an
 *  escaped slash puts two slashes side by side — `replace(/\/\//g, '/')`. Without
 *  regex skipping the scanner reads that as a line comment and translates the rest
 *  of the statement, destroying it. Java, C, Go, Rust have no regex literal, so
 *  they keep the simpler spec. */
const JS_LIKE: LangSpec = { ...C_LIKE, regexLiterals: true }
/** Rust drops the char-literal quote: a lifetime (`&'a str`) would open a string
 *  that never closes and swallow every comment after it. `//` cannot occur inside
 *  a Rust char literal anyway, so nothing is lost. */
const RUST: LangSpec = { line: ['//'], block: [['/*', '*/']], strings: [DQ] }
/** `#` in C is a preprocessor directive, which is why the C family carries none. */
const HASH: LangSpec = { line: ['#'], block: [], strings: [DQ, SQ], lineNeedsBoundary: true }
/** Triple quotes come first (longest opener wins), so a `#` inside a docstring is
 *  code, not a comment. Docstrings themselves are strings and are never translated. */
const PYTHON: LangSpec = {
  line: ['#'],
  block: [],
  strings: [
    { open: '"""', close: '"""', escape: '\\' },
    { open: "'''", close: "'''", escape: '\\' },
    DQ,
    SQ,
  ],
  lineNeedsBoundary: true,
}
const SQL: LangSpec = { line: ['--'], block: [['/*', '*/']], strings: [SQ, DQ] }
const LUA: LangSpec = { line: ['--'], block: [], strings: [DQ, SQ], longBrackets: true }
const HASKELL: LangSpec = { line: ['--'], block: [['{-', '-}']], strings: [DQ] }
/** No string specs: an apostrophe in prose (`don't`) would otherwise open a literal
 *  and hide every later comment. A literal `<!--` in markup IS a comment anyway. */
const XML: LangSpec = { line: [], block: [['<!--', '-->']], strings: [] }
/** `//` is NOT a CSS comment — treating it as one would destroy `url(http://…)`. */
const CSS: LangSpec = { line: [], block: [['/*', '*/']], strings: [DQ, SQ] }
const LISP: LangSpec = { line: [';'], block: [], strings: [DQ] }
const POWERSHELL: LangSpec = {
  line: ['#'],
  block: [['<#', '#>']],
  strings: [DQ, SQ],
  lineNeedsBoundary: true,
}
const PERCENT: LangSpec = { line: ['%'], block: [], strings: [DQ, SQ], lineNeedsBoundary: true }
const INI: LangSpec = { line: ['#', ';'], block: [], strings: [DQ, SQ], lineNeedsBoundary: true }

function alias(spec: LangSpec, ...names: string[]): Array<[string, LangSpec]> {
  return names.map((n) => [n, spec])
}

const SPECS = new Map<string, LangSpec>([
  ...alias(JS_LIKE, 'js', 'javascript', 'jsx', 'mjs', 'cjs', 'node', 'ts', 'typescript', 'tsx'),
  ...alias(
    C_LIKE,
    'java', 'c', 'cpp', 'c++', 'cc', 'h', 'hpp', 'cs', 'csharp',
    'go', 'golang', 'swift', 'kotlin', 'kt', 'scala', 'php', 'dart', 'groovy',
    'objc', 'objective-c', 'proto', 'protobuf', 'jsonc', 'json5',
    'less', 'scss', 'glsl', 'hlsl', 'zig',
  ),
  ...alias(RUST, 'rust', 'rs'),
  ...alias(PYTHON, 'python', 'py', 'python3'),
  ...alias(
    HASH,
    'ruby', 'rb', 'shell', 'sh', 'bash', 'zsh', 'fish', 'shell-session',
    'yaml', 'yml', 'toml', 'perl', 'pl', 'r', 'make', 'makefile',
    'dockerfile', 'docker', 'elixir', 'ex', 'exs', 'julia', 'jl',
    'nginx', 'conf', 'properties', 'env', 'dotenv', 'gitignore', 'awk', 'tcl',
  ),
  ...alias(SQL, 'sql', 'postgres', 'postgresql', 'psql', 'mysql', 'plsql', 'tsql', 'sqlite'),
  ...alias(LUA, 'lua'),
  ...alias(HASKELL, 'haskell', 'hs', 'elm'),
  ...alias(XML, 'html', 'xml', 'svg', 'vue', 'xhtml', 'xaml', 'plist'),
  ...alias(CSS, 'css'),
  ...alias(LISP, 'clojure', 'clj', 'cljs', 'edn', 'lisp', 'scheme', 'elisp', 'racket'),
  ...alias(POWERSHELL, 'powershell', 'ps1', 'pwsh'),
  ...alias(PERCENT, 'latex', 'tex', 'erlang', 'erl', 'matlab', 'octave', 'prolog'),
  ...alias(INI, 'ini', 'editorconfig'),
])

/** The language table is the whitelist: an unknown or absent language is untouched. */
export function specFor(lang?: string | null): LangSpec | undefined {
  if (typeof lang !== 'string') return undefined
  // Info strings can carry attributes (```js title="x") — the language is the first word.
  const key = lang.trim().toLowerCase().split(/[\s,{]/)[0]
  return key ? SPECS.get(key) : undefined
}

/** Decoration — JSDoc `*`, a doc comment's extra `/`, banner runs — is trimmed from the
 *  span BOUNDARIES, not from the text, so the splice copies it back verbatim. */
const DECOR_LEFT = /^[\s*/#;=~+!<>|-]+/
const DECOR_RIGHT = /[\s*/#;=~+|-]+$/
const HAS_LETTER = /\p{L}/u

/** One prose span per LINE of a comment. Anything with no letter at all is a
 *  separator, not prose, and is not emitted. */
function proseSpans(
  code: string,
  from: number,
  to: number,
  forbidden: readonly string[],
  out: CommentSpan[],
): void {
  let lineStart = from
  while (lineStart < to) {
    let lineEnd = code.indexOf('\n', lineStart)
    if (lineEnd < 0 || lineEnd > to) lineEnd = to
    const raw = code.slice(lineStart, lineEnd)
    const left = raw.match(DECOR_LEFT)?.[0].length ?? 0
    const trimmed = raw.slice(left).replace(DECOR_RIGHT, '')
    if (trimmed.length > 0 && HAS_LETTER.test(trimmed)) {
      const start = lineStart + left
      out.push({ start, end: start + trimmed.length, text: trimmed, forbidden })
    }
    lineStart = lineEnd + 1
  }
}

function isBoundary(code: string, i: number): boolean {
  return i === 0 || /\s/.test(code[i - 1])
}

/** Keywords after which a `/` opens a regex rather than dividing. */
const BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
])
const OPENS_EXPR = '(,=:[!&|?{};+-*%^~<>'

/** Does the `/` at `i` open a regex literal, given the last significant code
 *  character at `prev`? The classic JS "regex or division" question. Guessing
 *  WRONG in the regex direction only costs a missed comment; guessing wrong the
 *  other way lets the closing `/` of a regex pair up with the next `/` into a
 *  phantom `//` comment — which is a corruption. */
function startsRegex(code: string, prev: number): boolean {
  if (prev < 0) return true
  const c = code[prev]
  if (OPENS_EXPR.includes(c)) return true
  if (/[A-Za-z_$]/.test(c)) {
    let s = prev
    while (s > 0 && /[\w$]/.test(code[s - 1])) s -= 1
    return BEFORE_REGEX.has(code.slice(s, prev + 1))
  }
  return false
}

/** Index just past a regex literal opening at `i`, or `i + 1` if it does not
 *  terminate on its line (in which case the `/` was not a regex after all). */
function skipRegex(code: string, i: number): number {
  let inClass = false
  for (let j = i + 1; j < code.length; j += 1) {
    const c = code[j]
    if (c === '\\') j += 1
    else if (c === '\n') break
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return j + 1
  }
  return i + 1
}

/** Index just past a `close`-terminated region opening at `from`. */
function skipTo(code: string, from: number, close: string): number {
  const at = code.indexOf(close, from)
  return at < 0 ? code.length : at + close.length
}

/** Lua long bracket at `i` — `[`, then n `=`, then `[`. Returns n, or -1. */
function longBracket(code: string, i: number): number {
  if (code[i] !== '[') return -1
  let j = i + 1
  while (code[j] === '=') j += 1
  return code[j] === '[' ? j - i - 1 : -1
}

/**
 * Comment-prose spans in `code`, in ascending order and never overlapping.
 * An unknown or absent language yields none — the block is left alone.
 */
export function commentSpans(code: string, lang?: string | null): CommentSpan[] {
  const spec = specFor(lang)
  if (!spec) return []

  // Longest opener first, so `--[[` beats `--` and `"""` beats `"`.
  const blocks = [...spec.block].sort((a, b) => b[0].length - a[0].length)
  const lines = [...spec.line].sort((a, b) => b.length - a.length)
  const strings = [...spec.strings].sort((a, b) => b.open.length - a.open.length)

  const out: CommentSpan[] = []
  let i = 0
  /** Index of the last significant character seen in CODE state. */
  let prev = -1

  while (i < code.length) {
    // Lua long-bracket comment — must beat the `--` line marker.
    const blockLevel = spec.longBrackets && code.startsWith('--', i) ? longBracket(code, i + 2) : -1
    if (blockLevel >= 0) {
      const close = `]${'='.repeat(blockLevel)}]`
      const bodyStart = i + 4 + blockLevel
      const closeAt = code.indexOf(close, bodyStart)
      proseSpans(code, bodyStart, closeAt < 0 ? code.length : closeAt, [close], out)
      i = skipTo(code, bodyStart, close)
      continue
    }

    const block = blocks.find((b) => code.startsWith(b[0], i))
    if (block) {
      const [open, close] = block
      const bodyStart = i + open.length
      const closeAt = code.indexOf(close, bodyStart)
      proseSpans(code, bodyStart, closeAt < 0 ? code.length : closeAt, [close], out)
      i = skipTo(code, bodyStart, close)
      continue
    }

    const line = lines.find((m) => code.startsWith(m, i))
    // A `#!` shebang is not a comment — translating it would break the script.
    const shebang = i === 0 && code.startsWith('#!')
    if (line && !shebang && (!spec.lineNeedsBoundary || isBoundary(code, i))) {
      const bodyStart = i + line.length
      let lineEnd = code.indexOf('\n', bodyStart)
      if (lineEnd < 0) lineEnd = code.length
      proseSpans(code, bodyStart, lineEnd, [], out)
      i = lineEnd
      continue
    }

    // A regex literal is consumed whole, so its closing `/` can never pair with a
    // following `/` into a phantom comment that swallows the rest of the statement.
    if (spec.regexLiterals && code[i] === '/' && startsRegex(code, prev)) {
      const end = skipRegex(code, i)
      if (end > i + 1) {
        prev = end - 1
        i = end
        continue
      }
    }

    // Lua long-bracket string — a `--` inside it is data, not a comment.
    const strLevel = spec.longBrackets ? longBracket(code, i) : -1
    if (strLevel >= 0) {
      const end = skipTo(code, i + 2 + strLevel, `]${'='.repeat(strLevel)}]`)
      prev = end - 1
      i = end
      continue
    }

    const str = strings.find((s) => code.startsWith(s.open, i))
    if (str) {
      let j = i + str.open.length
      while (j < code.length) {
        if (str.escape && code.startsWith(str.escape, j)) {
          j += str.escape.length + 1
          continue
        }
        if (code.startsWith(str.close, j)) {
          j += str.close.length
          break
        }
        j += 1
      }
      prev = j - 1
      i = j
      continue
    }

    if (!/\s/.test(code[i])) prev = i
    i += 1
  }

  return out
}

/**
 * Rebuild `code` with each span replaced by its translation. Everything outside a
 * span is copied byte for byte — that is Property 24, and it holds by construction.
 *
 * A translation is not trusted: a line terminator in it would push the rest of a line
 * comment out as CODE, and a block closer in it would end the comment early and turn
 * its tail into code. The terminator set includes U+2028/U+2029, which JavaScript
 * treats as line terminators even though `\n`-based collapsing would miss them.
 */
const LINE_TERMINATORS = /[\r\n\u2028\u2029]+/g

export function spliceComments(
  code: string,
  spans: readonly CommentSpan[],
  translations: ReadonlyArray<string | undefined>,
): string {
  let out = ''
  let cursor = 0
  spans.forEach((span, k) => {
    const raw = translations[k]
    let text = span.text
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const flat = raw.replace(LINE_TERMINATORS, ' ')
      if (!span.forbidden.some((f) => flat.includes(f))) text = flat
    }
    out += code.slice(cursor, span.start) + text
    cursor = span.end
  })
  return out + code.slice(cursor)
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})([^\n`]*)\n/

/**
 * The body of a raw fenced code block — the region between the delimiter lines.
 * Used by the paragraph path, which holds the block's raw source (fence lines
 * included) rather than an mdast node. The scanner must never see the delimiters:
 * in JS a backtick opens a template literal and would swallow the whole block.
 *
 * Only FENCED blocks are recognised. An indented code block is indistinguishable
 * from an indented paragraph once it is cut out of its document, and guessing
 * either way is a defect — so the block kind must come from the caller. No caller
 * passes one today (a `<pre>` carries no paragraph index).
 */
export function fencedBody(
  raw: string,
): { start: number; end: number; lang?: string; fence: string } | undefined {
  const open = raw.match(FENCE_OPEN)
  if (!open) return undefined
  const fence = open[1]
  const start = open[0].length
  // The closer is a line of at least as many of the same delimiter character.
  const closer = new RegExp(`^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`)

  let end = raw.length
  let at = start
  while (at <= raw.length) {
    const nl = raw.indexOf('\n', at)
    const lineEnd = nl < 0 ? raw.length : nl
    if (closer.test(raw.slice(at, lineEnd))) {
      // Exclude the newline that terminates the last body line.
      end = at > start ? at - 1 : start
      break
    }
    if (nl < 0) break
    at = nl + 1
  }

  return { start, end, lang: open[2].trim() || undefined, fence }
}
