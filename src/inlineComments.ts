/**
 * Pure (de)serialization of block comments embedded in the .md as invisible
 * HTML comments. Carrier: `<!-- rmt:comments\n{json}\n-->`. mdast parses these as
 * `html` nodes, so they are never translated and are stripped from the preview.
 * These functions never touch the filesystem and never throw on bad input.
 */
import type { Block, CommentThread, CommentsFile } from './types'

export const INLINE_MARKER = 'rmt:comments'
const VERSION = 1

/** Core carrier shape (non-greedy body): `<!-- rmt:comments … -->`. */
const CORE = `<!--[ \\t]*${INLINE_MARKER}\\b[\\s\\S]*?-->`

/** Matches one carrier block core — used to enumerate payloads for parsing. */
const BLOCK_RE = new RegExp(CORE, 'g')

/**
 * Strip form. Also swallows the blank line that PRECEDES the block (up to two
 * leading newlines) plus any trailing inline spaces, so removing a block that sat
 * between two paragraphs leaves them separated by a single blank line rather than a
 * double gap — and a trailing/EOF block does not leave a dangling blank line.
 * (Consuming the leading — not trailing — blank line is what makes both the
 * after-paragraph and end-of-file cases collapse correctly: an EOF block is
 * followed by only the document's final newline.)
 */
const STRIP_RE = new RegExp(`\\n?\\n?[ \\t]*${CORE}[ \\t]*`, 'g')

/** Remove every carrier block. Leaves the surrounding text otherwise intact. */
export function stripInlineComments(source: string): string {
  return source.replace(STRIP_RE, '')
}

function isThread(t: unknown): t is CommentThread {
  if (typeof t !== 'object' || t === null) return false
  const o = t as Record<string, unknown>
  const a = o.anchor as Record<string, unknown> | undefined
  return !!a && typeof a.quote === 'string' && Array.isArray(o.comments)
}

/** Extract every carrier block's JSON payload and merge the threads (tolerant). */
export function parseInline(source: string): CommentsFile {
  const threads: CommentThread[] = []
  for (const m of source.matchAll(BLOCK_RE)) {
    const body = m[0].replace(/^<!--[ \t]*/, '').replace(/-->$/, '')
    const json = body.slice(INLINE_MARKER.length).trim()
    try {
      const obj = JSON.parse(json) as { threads?: unknown }
      const found = Array.isArray(obj.threads) ? obj.threads : [obj]
      for (const t of found) if (isThread(t) && t.comments.length > 0) threads.push(t)
    } catch {
      // malformed block — skip it, never throw
    }
  }
  return { version: VERSION, docHash: '', threads }
}

/** One carrier block for a payload object. Escapes `<`/`>` in the JSON payload
 *  (valid `<`/`>` string escapes, restored transparently by JSON.parse)
 *  so the HTML-comment delimiters `<!--`/`-->` can NEVER appear inside a carrier
 *  body — comment text may contain them verbatim without truncating the block. */
function makeBlock(payload: object): string {
  const json = JSON.stringify(payload, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `<!-- ${INLINE_MARKER}\n${json}\n-->`
}

/** Strip old blocks, then append one block holding the whole CommentsFile. */
export function serializeEof(source: string, data: CommentsFile): string {
  const clean = stripInlineComments(source).replace(/\s+$/, '')
  if (data.threads.length === 0) return clean + '\n'
  return `${clean}\n\n${makeBlock({ version: data.version, threads: data.threads })}\n`
}

/**
 * Rebuild the source with each thread's carrier placed after its anchored block.
 *
 * `blocks` line ranges are measured against `source` AS GIVEN (the live document,
 * which may already contain carriers), so we walk `source` in its own coordinates —
 * indexing a stripped copy with live coordinates is what silently dropped comments
 * that sat below an existing carrier.
 *
 * INVARIANT (data integrity): every thread in `data.threads` is persisted exactly
 * once. A thread is placed after its block when that block is present with an
 * in-range endLine; otherwise (orphaned, unmatched paragraphIndex, or a stale/
 * out-of-range endLine) it is appended as an end-of-file carrier. Nothing is dropped.
 */
export function serializeAfter(
  source: string,
  data: CommentsFile,
  blocks: Block[],
  live: Map<number, CommentThread[]>,
): string {
  const lines = source.split('\n')
  const isCarrierStart = (s: string) => /^[ \t]*<!--[ \t]*rmt:comments\b/.test(s)

  // Mark lines occupied by existing carriers (+ the single blank line before each)
  // so re-serializing strips the old carriers before re-inserting fresh ones.
  const drop = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (!isCarrierStart(lines[i])) continue
    let j = i
    while (j < lines.length && !lines[j].includes('-->')) j++
    for (let k = i; k <= j && k < lines.length; k++) drop[k] = true
    if (i > 0 && lines[i - 1].trim() === '') drop[i - 1] = true
    i = j
  }

  // Placeable threads → their block's (in-range) endLine. Accumulate so two blocks
  // sharing an endLine both get a carrier (last-write-wins would drop one).
  const byEnd = new Map<number, CommentThread[]>()
  for (const b of blocks) {
    if (b.endLine < 0 || b.endLine >= lines.length) continue
    const threads = live.get(b.paragraphIndex)
    if (!threads || !threads.length) continue
    const arr = byEnd.get(b.endLine) ?? []
    for (const t of threads) arr.push(t)
    byEnd.set(b.endLine, arr)
  }

  // Walk in source coordinates; drop old carriers; emit fresh carriers after each
  // block's endLine. Track what actually got emitted (a byEnd entry keyed to a
  // dropped line is never emitted here — it must fall through to the EOF fallback).
  const out: string[] = []
  const placed = new Set<CommentThread>()
  for (let i = 0; i < lines.length; i++) {
    if (drop[i]) continue
    out.push(lines[i])
    const threads = byEnd.get(i)
    if (threads) for (const t of threads) { out.push('', makeBlock({ threads: [t] })); placed.add(t) }
  }

  // Never drop: any authoritative thread not placed after a block goes to EOF.
  for (const t of data.threads) {
    if (!placed.has(t)) out.push('', makeBlock({ threads: [t] }))
  }
  return out.join('\n')
}
