/**
 * Block-anchored comment store (req 11). Owns the `.<name>.comments.json` sidecar
 * and the content re-anchoring; the `.md` original is NEVER written here. IO is an
 * injected seam (`SidecarIO`, default `vscode.workspace.fs`) so the service is
 * unit-testable in-memory. The pure anchoring logic lives in `./anchoring`.
 */
import * as vscode from 'vscode'
import type {
  Block,
  Comment,
  CommentThread,
  CommentsFile,
  BlockCommentCount,
  ICommentsService,
  ReanchorResult,
} from './types'
import { hashString, makeAnchor, matchThread } from './anchoring'

const SIDE_SUFFIX = '.comments.json'
const VERSION = 1
const FLUSH_MS = 500

/** File IO seam. `read` returns undefined when the sidecar does not exist yet. */
export interface SidecarIO {
  read(uri: vscode.Uri): Promise<string | undefined>
  write(uri: vscode.Uri, content: string): Promise<void>
}

/** Default IO backed by the workspace filesystem; a missing file reads as undefined. */
const fsIO: SidecarIO = {
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
}

function defaultId(): string {
  return 'c_' + Math.random().toString(36).slice(2, 8)
}

/** `docs/api.md` → `docs/.api.md.comments.json` (hidden sidecar next to the file). */
export function sidecarUri(docUri: vscode.Uri): vscode.Uri {
  const dir = vscode.Uri.joinPath(docUri, '..')
  const name = docUri.path.split('/').pop() || 'document.md'
  return vscode.Uri.joinPath(dir, `.${name}${SIDE_SUFFIX}`)
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

/** Tolerant parse: unknown/malformed input yields an empty store (never throws). */
export function parseCommentsFile(raw: string | undefined): CommentsFile {
  if (!raw) return { version: VERSION, docHash: '', threads: [] }
  try {
    const obj = JSON.parse(raw) as Partial<CommentsFile>
    const threads = Array.isArray(obj.threads)
      ? obj.threads.filter((t): t is CommentThread => isValidThread(t) && t.comments.length > 0)
      : []
    return { version: VERSION, docHash: typeof obj.docHash === 'string' ? obj.docHash : '', threads }
  } catch {
    return { version: VERSION, docHash: '', threads: [] }
  }
}

export class CommentsService implements ICommentsService {
  private data: CommentsFile = { version: VERSION, docHash: '', threads: [] }
  private lastBlocks: Block[] = []
  private lastSource = ''
  /** paragraphIndex → the live threads resolved there (usually one). */
  private live = new Map<number, CommentThread[]>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** True once a comment was added/edited/deleted this session. */
  private dirty = false
  /** True if a sidecar already existed on disk when loaded. */
  private existed = false
  private readonly uri: vscode.Uri

  constructor(
    docUri: vscode.Uri,
    private readonly io: SidecarIO = fsIO,
    private readonly genId: () => string = defaultId,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly flushMs: number = FLUSH_MS,
  ) {
    this.uri = sidecarUri(docUri)
  }

  async load(): Promise<void> {
    const raw = await this.io.read(this.uri)
    this.existed = raw !== undefined
    this.data = parseCommentsFile(raw)
  }

  /**
   * Resolve every stored thread against the current document. Fast-path: when the
   * document hash is unchanged since the last save, trust `hintLine`; otherwise
   * content-match (exact → normalized → fuzzy) and mark unmatched threads orphaned
   * — never anchoring at random (req 11.9). Refreshes each live thread's anchor.
   */
  reanchor(blocks: Block[], sourceText: string): ReanchorResult {
    this.lastBlocks = blocks
    this.lastSource = sourceText
    this.live = new Map()
    const fast = this.data.docHash !== '' && this.data.docHash === hashString(sourceText)

    for (const thread of this.data.threads) {
      if (thread.comments.length === 0) continue
      let idx: number | undefined
      if (fast) {
        idx = blocks.find((b) => b.startLine === thread.anchor.hintLine)?.paragraphIndex
        if (idx === undefined) idx = matchThread(thread.anchor, blocks)
      } else {
        idx = matchThread(thread.anchor, blocks)
      }
      if (idx === undefined) {
        thread.orphaned = true
      } else {
        thread.orphaned = false
        const fresh = makeAnchor(blocks, idx)
        if (fresh) thread.anchor = fresh
        const arr = this.live.get(idx) ?? []
        arr.push(thread)
        this.live.set(idx, arr)
      }
    }
    return this.snapshot()
  }

  /** Current indicator counts + orphaned threads, WITHOUT re-matching (used after a
   *  pure add/edit/delete that cannot change anchoring). */
  snapshot(): ReanchorResult {
    const forBlocks: BlockCommentCount[] = []
    for (const [paragraphIndex, arr] of this.live) {
      const count = arr.reduce((n, t) => n + t.comments.length, 0)
      if (count > 0) forBlocks.push({ paragraphIndex, count })
    }
    const orphaned = this.data.threads
      .filter((t) => t.orphaned && t.comments.length > 0)
      .map((t) => ({ quote: t.anchor.quote, comments: t.comments }))
    return { forBlocks, orphaned }
  }

  getThreadComments(paragraphIndex: number): Comment[] {
    return (this.live.get(paragraphIndex) ?? []).flatMap((t) => t.comments)
  }

  addComment(paragraphIndex: number, body: string): Comment | undefined {
    const text = body.trim()
    if (!text) return undefined
    const ts = this.now()
    const comment: Comment = { id: this.genId(), createdAt: ts, updatedAt: ts, body: text }
    let thread = this.live.get(paragraphIndex)?.[0]
    if (!thread) {
      const anchor = makeAnchor(this.lastBlocks, paragraphIndex)
      if (!anchor) return undefined // block no longer present → cannot anchor
      thread = { anchor, orphaned: false, comments: [] }
      this.data.threads.push(thread)
      this.live.set(paragraphIndex, [thread])
    }
    thread.comments.push(comment)
    this.stampAndFlush()
    return comment
  }

  editComment(commentId: string, body: string): void {
    const text = body.trim()
    if (!text) return
    for (const t of this.data.threads) {
      const c = t.comments.find((x) => x.id === commentId)
      if (c) {
        c.body = text
        c.updatedAt = this.now()
        this.stampAndFlush()
        return
      }
    }
  }

  deleteComment(commentId: string): void {
    for (const t of this.data.threads) {
      const i = t.comments.findIndex((x) => x.id === commentId)
      if (i < 0) continue
      t.comments.splice(i, 1)
      if (t.comments.length === 0) {
        // Drop the now-empty thread so it stops drawing an indicator / persisting.
        this.data.threads = this.data.threads.filter((x) => x !== t)
        for (const [k, arr] of [...this.live]) {
          const f = arr.filter((x) => x !== t)
          if (f.length) this.live.set(k, f)
          else this.live.delete(k)
        }
      }
      this.stampAndFlush()
      return
    }
  }

  /** Persist now, cancelling any pending debounce; stamps `docHash` to the current
   *  source so a later unchanged-document open takes the hintLine fast-path. Writes
   *  NOTHING when there is nothing to persist and no sidecar existed — so merely
   *  opening and closing a preview never litters the workspace with an empty file. */
  flush(): Thenable<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.data.threads.length === 0 && !this.dirty && !this.existed) {
      return Promise.resolve()
    }
    this.data.docHash = hashString(this.lastSource)
    return this.io.write(this.uri, serializeCommentsFile(this.data))
  }

  private stampAndFlush(): void {
    this.dirty = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), this.flushMs)
  }
}
