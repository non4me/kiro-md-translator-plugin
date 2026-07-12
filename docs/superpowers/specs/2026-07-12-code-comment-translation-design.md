# Code Comment Translation — Design

**Date:** 2026-07-12
**Status:** Approved
**Spec ids:** requirements `3.7` (amended), `3.22` (new); design `Property 2` (narrowed), `Property 24` (new); tasks `29`

## Problem

A fenced code block is currently opaque to translation. Requirement 3.7 excludes it
wholesale, and Property 2 asserts — with a 100-run property test — that no byte of a
fenced body ever reaches `translateBatch`.

That exclusion is too coarse. Code blocks in documentation carry **comments**, and a
comment is prose: it is exactly the thing a reader of a foreign-language document needs
translated. The rationale recorded in `design.md` for the exclusion is structure
preservation ("translating code would break it"), not privacy — so translating the prose
*inside* comments is compatible with the intent of 3.7, just not with its letter.

## What changes for the user

Prose inside code-block comments is translated like any other paragraph — in the normal
translated view, in the bilingual view, in the paragraph-edit modal, in the hover tooltip,
and in an exported file.

**The code itself does not change by a single byte.** Not the indentation, not the comment
markers, not the string literals, not the fence delimiters. Only the prose *inside* a
comment is replaced.

This is always on. There is no setting: a comment is prose, and prose is translated.

## The governing rule

> A false negative is free. A false positive is fatal.

Failing to recognise a comment costs one untranslated fragment. Mistaking code for a
comment splices translated text into the program and corrupts it. **Every ambiguity
therefore resolves to "this is not a comment."**

This rule is why the obvious implementation — a regular expression for "everything after
`//`" — is rejected outright: `//` also occurs inside `"https://example.com"`.

## Architecture

### The scanner

A three-state machine over the code body: *code*, *string literal*, *comment*. It is not a
language parser. It knows, per language, only four things: the line-comment markers, the
block-comment marker pairs, the string/character delimiters (with their escape character),
and whether a line marker requires a preceding boundary.

The language comes from the fence info string. **A block with no info string, or one whose
language is not in the table, is left completely untouched.**

The scanner emits **spans**: half-open offset ranges into the code body, each covering the
*prose of a comment on a single line*. Markers, indentation, and decoration lie **outside**
every span.

### Decoration lies outside the span

Leading and trailing ornament — the `*` continuation of a JSDoc block, the extra `/` of a
Rust doc comment, banner runs of `=`, `-`, `#` — is trimmed from the span boundaries rather
than from the text. Because the splice copies everything between spans verbatim, **the
decoration is preserved automatically**. A `// - first item` yields a span covering only
`first item`; the `- ` survives untouched.

A span whose text contains no letter at all (`// ------`, `# 42`) is not emitted — a
separator is not prose.

### The splice

Re-insertion walks the spans in ascending order and rebuilds the string: everything outside
a span is copied from the source byte for byte. The "code is unchanged" guarantee is
therefore **structural, not tested into existence** — no code path exists that could touch a
non-comment byte.

Its invariant, and the new Property 24:

> Splicing a block's own span texts back into it must reproduce the block exactly.

### Output guards

Translated text is not trusted. Before a translation is spliced in:

1. **Newlines are collapsed to spaces.** A newline inside a line comment would push the
   remainder of the comment onto a fresh line — as *code*.
2. **A translation containing the comment's closing token is discarded** and the original
   text is kept. A `*/` inside a `/* … */` body would end the comment early and turn the
   rest of it into code. Each span therefore carries the set of tokens forbidden in its
   replacement (the block closer; for the modal path, also the fence delimiter).
3. **An empty or blank translation is discarded**, keeping the source text — the existing
   per-segment rule from 3.14.

These guards are the governing rule applied to the provider's output rather than to the
source.

### Where it plugs in

The pipeline already flattens the document into a list of translatable segments, translates
them in one batch through the cache, and writes them back. A code block contributes *many*
segments rather than one, so the flat "node → segment" mapping generalises to "unit →
segments + a way to put them back". Cache, batching, glossary masking, cancellation and the
export path are all inherited unchanged; nothing downstream knows a segment came from code.

**The paragraph path needs the same treatment, and this is not optional.** The edit modal
and the hover tooltip translate one block's raw text. Handed a code block, they would send
the *entire program* to the provider — precisely what 3.7 forbids. They therefore run the
same scan-and-splice over the fenced body, copying the fence delimiter lines verbatim.

This is currently unreachable (code blocks carry no paragraph index yet), but it is built
now on purpose: it is the reason the follow-up affordance work can treat a code block as an
ordinary block with no special case.

## Language coverage

| Family | Line | Block | Notes |
|---|---|---|---|
| C-like | `//` | `/* */` | js, ts, java, c, cpp, cs, go, swift, kotlin, scala, php, dart, proto, less, scss |
| Rust | `//` | `/* */` | **no `'` string delimiter** — a lifetime `&'a str` would open a string that never closes |
| Hash | `#` | — | python, ruby, shell, yaml, toml, perl, r, make, dockerfile, ini, elixir, julia |
| SQL | `--` | `/* */` | |
| Lua | `--` | `--[[ ]]` | the block opener is matched **before** the line marker, or `--[[` would be read as a line comment and its opener destroyed |
| Haskell | `--` | `{- -}` | |
| Markup | — | `<!-- -->` | html, xml, svg, vue — **no string delimiters**: an apostrophe in prose (`don't`) would otherwise swallow the rest |
| CSS | — | `/* */` | **`//` is not a CSS comment** — treating it as one would destroy `url(http://…)` |
| Lisp | `;` | — | clojure, lisp, scheme, elisp |
| PowerShell | `#` | `<# #>` | |
| LaTeX/Erlang | `%` | — | |

Deliberate exclusions, each of which would otherwise corrupt code:

- **`#` in C** is a preprocessor directive, so the C family carries no `#` marker.
- **`#` requires a preceding boundary** (start of line or whitespace) in the hash family, so
  `${x#y}` and `$#` in shell stay code. The cost is a missed comment in `x=1#c` — a false
  negative, which is free.
- **A `#!` shebang at offset 0** is not a comment. Translating it would break the script.
- **Python triple-quoted strings are strings, not comments.** Docstrings are not translated:
  they are string literals, and rewriting them changes `__doc__`.
- **Inline code spans remain excluded** entirely. An inline span is an identifier, not prose.

## Known limitation

A segment is the prose of **one line** of a comment. A sentence wrapped across three lines of
a JSDoc block is translated as three independent fragments and will read badly.

Joining the lines and redistributing the translation back across them is possible, but it
needs a re-wrapping algorithm and gives up the property that markers are never touched. The
case is rare in documentation, where comments are overwhelmingly single-line. Deferred.

## Spec changes

- **3.7** is narrowed, not deleted: inline code, URLs, and HTML attributes stay excluded, and
  so does every byte of a fenced code block **except the prose content of its comments**.
- **3.22** (new) states the scanner's contract: comments-only, unknown language untouched,
  non-comment bytes byte-identical, output guards.
- **Property 2** is restated against the narrowed 3.7. Its existing test survives unchanged,
  because the fence it generates has no info string and is therefore untouched by the new
  rule; the test gains a case for a fence *with* a language.
- **Property 24** (new) is the splice round-trip: identity replacement reproduces the block.

## Testing

- **Property 24**: for any code block, `splice(code, spans, spans.map(s => s.text)) === code`.
- **Property 2 (extended)**: for a fence *with* a language, no segment sent to the provider
  contains any non-comment token of the body.
- **Trap cases**, each a regression test for a specific corruption: `//` inside a string,
  `#` inside a shell parameter expansion, `#` inside a Python string, `--` in SQL versus C,
  `//` in CSS `url()`, a Lua `--[[` block, a Rust lifetime, a shebang, a `*/` returned by the
  provider, a newline returned by the provider.
- **Integration**: a translated document's code block has translated comments and identical
  code; an unknown-language block is byte-identical; the paragraph path never sends code.
