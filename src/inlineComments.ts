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

/** One carrier block for a payload object. */
function makeBlock(payload: object): string {
  return `<!-- ${INLINE_MARKER}\n${JSON.stringify(payload, null, 2)}\n-->`
}

/** Strip old blocks, then append one block holding the whole CommentsFile. */
export function serializeEof(source: string, data: CommentsFile): string {
  const clean = stripInlineComments(source).replace(/\s+$/, '')
  if (data.threads.length === 0) return clean + '\n'
  return `${clean}\n\n${makeBlock({ version: data.version, threads: data.threads })}\n`
}

/** Single-pass rebuild: drop existing carrier blocks; after each block whose
 *  endLine has live thread(s), insert one carrier block per thread. Line indices
 *  are all against the CLEAN (comment-free) source, so no shifting bookkeeping. */
export function serializeAfter(
  source: string,
  data: CommentsFile,
  blocks: Block[],
  live: Map<number, CommentThread[]>,
): string {
  const clean = stripInlineComments(source)
  const lines = clean.split('\n')
  const byEnd = new Map<number, CommentThread[]>()
  for (const b of blocks) {
    const threads = live.get(b.paragraphIndex)
    if (threads && threads.length) byEnd.set(b.endLine, threads)
  }
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const threads = byEnd.get(i)
    if (threads) for (const t of threads) out.push('', makeBlock({ threads: [t] }))
  }
  return out.join('\n')
}
