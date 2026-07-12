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
/** `--[[` must be matched as a BLOCK opener before the `--` line marker, or the
 *  opener would be eaten as a line comment and the rest of the block become code. */
const LUA: LangSpec = { line: ['--'], block: [['--[[', ']]']], strings: [DQ, SQ] }
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
  ...alias(
    C_LIKE,
    'js', 'javascript', 'jsx', 'mjs', 'cjs', 'node',
    'ts', 'typescript', 'tsx',
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

  while (i < code.length) {
    const block = blocks.find((b) => code.startsWith(b[0], i))
    if (block) {
      const [open, close] = block
      const bodyStart = i + open.length
      const closeAt = code.indexOf(close, bodyStart)
      const bodyEnd = closeAt < 0 ? code.length : closeAt
      proseSpans(code, bodyStart, bodyEnd, [close], out)
      i = closeAt < 0 ? code.length : closeAt + close.length
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
      i = j
      continue
    }

    i += 1
  }

  return out
}

/**
 * Rebuild `code` with each span replaced by its translation. Everything outside a
 * span is copied byte for byte — that is Property 24, and it holds by construction.
 *
 * A translation is not trusted: a newline in it would push the rest of a line comment
 * out as CODE, and a block closer in it would end the comment early and turn its tail
 * into code. Either way the original text is kept.
 */
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
      const flat = raw.replace(/[\r\n]+/g, ' ')
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
