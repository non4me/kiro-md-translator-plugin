/**
 * Block-anchored comment store (req 11). Owns the content re-anchoring, live-map,
 * and debounce; the *where/how* of persistence lives behind a `CommentBackend`
 * (default `SidecarBackend`, which owns the `<name>.comments.json` sidecar). The
 * `.md` original is NEVER written here in sidecar mode. The pure anchoring logic
 * lives in `./anchoring`; the sidecar file format in `./commentSidecar`.
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
import { VERSION } from './commentSidecar'
import { SidecarBackend, type CommentBackend } from './commentBackends'

// Re-export the sidecar primitives so existing import paths keep working.
export { parseCommentsFile, serializeCommentsFile, sidecarUri, fsIO } from './commentSidecar'
export type { SidecarIO } from './commentSidecar'

const FLUSH_MS = 500

function defaultId(): string {
  return 'c_' + Math.random().toString(36).slice(2, 8)
}

export class CommentsService implements ICommentsService {
  private data: CommentsFile = { version: VERSION, docHash: '', threads: [] }
  private lastBlocks: Block[] = []
  private lastSource = ''
  /** paragraphIndex → the live threads resolved there (usually one). */
  private live = new Map<number, CommentThread[]>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    docUri: vscode.Uri,
    private backend: CommentBackend = new SidecarBackend(docUri),
    private readonly genId: () => string = defaultId,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly flushMs: number = FLUSH_MS,
    private readonly getSource: () => string = () => '',
    private readonly writeSource?: (text: string) => Promise<void>,
  ) {}

  async load(): Promise<void> {
    this.data = await this.backend.load(this.getSource())
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
   *  source so a later unchanged-document open takes the hintLine fast-path. The
   *  removal-when-empty semantics (deleting the last comment removes the sidecar
   *  rather than leaving `{threads:[]}` behind; opening/closing never litters a
   *  file) live in the backend. An inline backend may return rewritten source to
   *  write back via `writeSource`. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.data.threads.length > 0) this.data.docHash = hashString(this.lastSource)
    const res = await this.backend.persist({
      data: this.data,
      source: this.getSource(),
      blocks: this.lastBlocks,
      live: this.live,
    })
    if (res.kind === 'inline' && this.writeSource && res.newSource !== this.getSource()) {
      await this.writeSource(res.newSource)
    }
  }

  private stampAndFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), this.flushMs)
  }
}
