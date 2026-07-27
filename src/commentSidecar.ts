/**
 * Sidecar primitives (req 11): the `<name>.comments.json` file format and its IO
 * seam, extracted so both `CommentsService` and the persistence backends can share
 * them without a circular import. Pure JSON/URI helpers — no anchoring math here.
 */
import * as vscode from 'vscode'
import type { Comment, CommentThread, CommentsFile, FragmentAnchor, SpanEnd } from './types'

const SIDE_SUFFIX = '.comments.json'
export const VERSION = 1

/** File IO seam. `read` returns undefined when the sidecar does not exist yet;
 *  `remove` deletes it (tolerant of an already-missing file). */
export interface SidecarIO {
  read(uri: vscode.Uri): Promise<string | undefined>
  write(uri: vscode.Uri, content: string): Promise<void>
  remove(uri: vscode.Uri): Promise<void>
}

/** Default IO backed by the workspace filesystem; a missing file reads as undefined. */
export const fsIO: SidecarIO = {
  async read(uri) {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
    } catch {
      return undefined
    }
  },
  async write(uri, content) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content))
  },
  async remove(uri) {
    try {
      await vscode.workspace.fs.delete(uri)
    } catch {
      // already gone — deleting the last comment when no file exists is a no-op.
    }
  },
}

/** `docs/api.md` → `docs/api.md.comments.json` (sidecar next to the file). */
export function sidecarUri(docUri: vscode.Uri): vscode.Uri {
  const dir = vscode.Uri.joinPath(docUri, '..')
  const name = docUri.path.split('/').pop() || 'document.md'
  return vscode.Uri.joinPath(dir, `${name}${SIDE_SUFFIX}`)
}

function isValidComment(c: unknown): c is Comment {
  if (typeof c !== 'object' || c === null) return false
  const o = c as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.body === 'string' &&
    typeof o.createdAt === 'string' &&
    typeof o.updatedAt === 'string'
  )
}

function isValidThread(t: unknown): t is CommentThread {
  if (typeof t !== 'object' || t === null) return false
  const o = t as Record<string, unknown>
  const a = o.anchor as Record<string, unknown> | undefined
  return (
    !!a &&
    typeof a.quote === 'string' &&
    Array.isArray(o.comments) &&
    o.comments.every(isValidComment)
  )
}

/** Serialize the sidecar (pretty JSON, stable key order). Pure — round-trips with parse. */
export function serializeCommentsFile(data: CommentsFile): string {
  return JSON.stringify(data, null, 2)
}

/** Coerce a fragment anchor, or drop it. A fragment with no quote cannot be
 *  located in any text, so it is not a fragment — dropping it degrades the thread
 *  to a whole-block comment, which is the safe direction (the comment survives). */
function normalizeFragment(f: unknown): FragmentAnchor | undefined {
  if (typeof f !== 'object' || f === null) return undefined
  const o = f as Record<string, unknown>
  if (typeof o.quote !== 'string' || o.quote === '') return undefined
  return {
    quote: o.quote,
    prefix: typeof o.prefix === 'string' ? o.prefix : '',
    suffix: typeof o.suffix === 'string' ? o.suffix : '',
    ...(typeof o.translated === 'boolean' ? { translated: o.translated } : {}),
  }
}

/** Coerce the far end of a multi-block span, or drop it. `SpanEnd.fragment` is
 *  required by the type and by `resolveSpan`, so an end without a usable fragment
 *  is discarded and the thread degrades to its first block. */
function normalizeEnd(e: unknown): SpanEnd | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const o = e as Record<string, unknown>
  const fragment = normalizeFragment(o.fragment)
  if (typeof o.quote !== 'string' || !fragment) return undefined
  return {
    quote: o.quote,
    prefix: typeof o.prefix === 'string' ? o.prefix : '',
    suffix: typeof o.suffix === 'string' ? o.suffix : '',
    hintLine: typeof o.hintLine === 'number' && Number.isFinite(o.hintLine) ? o.hintLine : 0,
    quoteHash: typeof o.quoteHash === 'string' ? o.quoteHash : '',
    fragment,
  }
}

/** Coerce a validated thread's anchor to safe types. `isValidThread` only checks
 *  `quote`; the re-anchoring math assumes `prefix`/`suffix` are strings and
 *  `hintLine` a number, so an untrusted sidecar that omits them (or gives wrong
 *  types) must be normalized here — otherwise `diceSimilarity` throws on
 *  `undefined.length` when a block has ≥2 anchor candidates.
 *
 *  Rebuilding field-by-field is deliberate (never spread untrusted input), which is
 *  why `fragment` and `end` must be carried over EXPLICITLY: omitting them silently
 *  downgraded every fragment and multi-block comment to a whole-block one on load,
 *  even though the writer had put them on disk. Optional keys stay absent rather
 *  than `undefined`, so serialize → parse → serialize is byte-stable. */
export function normalizeThread(t: CommentThread): CommentThread {
  const a = t.anchor as unknown as Record<string, unknown>
  const fragment = normalizeFragment(a.fragment)
  const end = normalizeEnd(a.end)
  return {
    anchor: {
      quote: typeof a.quote === 'string' ? a.quote : '',
      prefix: typeof a.prefix === 'string' ? a.prefix : '',
      suffix: typeof a.suffix === 'string' ? a.suffix : '',
      hintLine: typeof a.hintLine === 'number' && Number.isFinite(a.hintLine) ? a.hintLine : 0,
      quoteHash: typeof a.quoteHash === 'string' ? a.quoteHash : '',
      ...(fragment ? { fragment } : {}),
      ...(end ? { end } : {}),
    },
    orphaned: Boolean(t.orphaned),
    comments: t.comments,
  }
}

/** Tolerant parse: unknown/malformed input yields an empty store (never throws). */
export function parseCommentsFile(raw: string | undefined): CommentsFile {
  if (!raw) return { version: VERSION, docHash: '', threads: [] }
  try {
    const obj = JSON.parse(raw) as Partial<CommentsFile>
    const threads = Array.isArray(obj.threads)
      ? obj.threads
          .filter((t): t is CommentThread => isValidThread(t) && t.comments.length > 0)
          .map(normalizeThread)
      : []
    return { version: VERSION, docHash: typeof obj.docHash === 'string' ? obj.docHash : '', threads }
  } catch {
    return { version: VERSION, docHash: '', threads: [] }
  }
}
