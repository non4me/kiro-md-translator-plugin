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
  FragmentAnchor,
  ICommentsService,
  ReanchorResult,
  ThreadView,
} from './types'
import { hashString, makeAnchor, matchThread, locateFragment, makeSpanAnchor, resolveSpan } from './anchoring'
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
  /** Multi-block span highlights beyond the first block (req 10.17): a block's extra
   *  highlight quotes (the last block's head) and/or a whole-block flag (a middle block).
   *  Recomputed every `reanchor` — carries NO comment count (the marker stays on block one). */
  private spanExtra = new Map<number, { fragments: string[]; whole: boolean }>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Backends to pull comments in from at load (auto-import). Empty ⇒ feature off. */
  private importSources: CommentBackend[] = []
  /** The sources that actually contributed at the last load — the ones to clear in phase 2. */
  private pendingImport: CommentBackend[] = []
  /** How many comments the last `load()` pulled in from other stores. 0 ⇒ nothing to move. */
  importedCount = 0
  /**
   * Did the last write-back actually land in the document? A `WorkspaceEdit` can be
   * REJECTED — it resolves false rather than throwing — and a rejected edit leaves the
   * document byte-identical and therefore CLEAN. "Clean" is exactly what an already-saved
   * document looks like, so the disk probe alone cannot tell the two apart: without this
   * flag, carriers that were never written read as "safely on disk" and the source store
   * gets cleared out from under them.
   */
  private lastWriteLanded = true

  constructor(
    docUri: vscode.Uri,
    private backend: CommentBackend = new SidecarBackend(docUri),
    private readonly genId: () => string = defaultId,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly flushMs: number = FLUSH_MS,
    private readonly getSource: () => string = () => '',
    /** Write the rewritten source back to the document. Resolves FALSE when the write did
     *  not land (a `WorkspaceEdit` is REJECTED — not thrown — when the document version
     *  moved under us). See `lastWriteLanded`. */
    private readonly writeSource?: (text: string) => Promise<boolean>,
    /** Flush the document to disk. Resolves false when it could not be saved (read-only
     *  file, write error). Absent ⇒ the target is treated as durable — that is only true
     *  for unit tests and sidecar-only setups; the extension always injects it. */
    private readonly saveSource?: () => Promise<boolean>,
  ) {}

  /**
   * Phase 1 of auto-import (req 11.17): read the current store, then merge whatever the
   * OTHER stores still hold — a storage setting flipped while this document was closed
   * leaves its comments behind, and reading only the selected store makes them look lost.
   * Read-only: the move itself is `completeImport`, which needs the block list.
   */
  async load(): Promise<void> {
    this.data = await this.backend.load(this.getSource())
    this.importedCount = 0
    this.pendingImport = []
    for (const source of this.importSources) {
      if (source.medium === this.backend.medium) continue
      const added = this.mergeIn(await source.load(this.getSource()))
      if (added > 0) {
        this.importedCount += added
        this.pendingImport.push(source)
      }
    }
  }

  /** Auto-import sources; set before `load()`. Empty (the default) disables the feature. */
  setImportSources(sources: CommentBackend[]): void {
    this.importSources = sources
  }

  /**
   * Phase 2 of auto-import: move what `load` merged into the current backend and clear the
   * sources it came from, under `migrateFrom`'s durability invariant.
   *
   * Deliberately NOT done inside `load`: the block list does not exist yet at that point,
   * and after-paragraph placement needs it — serializing without blocks would dump every
   * carrier at end-of-file. Hence the `lastBlocks` guard. Nothing imported ⇒ nothing runs,
   * so merely opening a document never touches it.
   */
  async completeImport(): Promise<void> {
    if (this.pendingImport.length === 0 || this.lastBlocks.length === 0) return
    const sources = this.pendingImport
    this.pendingImport = []
    for (const source of sources) await this.migrateFrom(source)
  }

  /** Union `other` into the live set, de-duplicating by comment id — the same comment can
   *  sit in two stores after a half-finished move. Returns how many were added; zero must
   *  NOT trigger a write, or opening a document would dirty it for nothing. */
  private mergeIn(other: CommentsFile): number {
    const seen = new Set(this.data.threads.flatMap((t) => t.comments.map((c) => c.id)))
    let added = 0
    for (const thread of other.threads) {
      const fresh = thread.comments.filter((c) => !seen.has(c.id))
      if (fresh.length === 0) continue
      fresh.forEach((c) => seen.add(c.id))
      this.data.threads.push({ ...thread, comments: fresh, orphaned: false })
      added += fresh.length
    }
    return added
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
    this.spanExtra = new Map()
    const fast = this.data.docHash !== '' && this.data.docHash === hashString(sourceText)

    for (const thread of this.data.threads) {
      if (thread.comments.length === 0) continue
      // Multi-block span thread (req 10.17): resolve BOTH ends together or orphan the whole
      // thread. The comment lives on the FIRST block (marker + count); the highlight is spread
      // to the middle blocks (whole) and the last block (its head-fragment quote).
      if (thread.anchor.end) {
        const span = resolveSpan(thread.anchor, blocks)
        if (!span) {
          thread.orphaned = true
          continue
        }
        thread.orphaned = false
        const arr = this.live.get(span.startIndex) ?? []
        arr.push(thread)
        this.live.set(span.startIndex, arr)
        for (const b of blocks) {
          if (b.paragraphIndex > span.startIndex && b.paragraphIndex < span.endIndex) {
            const e = this.spanExtra.get(b.paragraphIndex) ?? { fragments: [], whole: false }
            e.whole = true
            this.spanExtra.set(b.paragraphIndex, e)
          }
        }
        const endEntry = this.spanExtra.get(span.endIndex) ?? { fragments: [], whole: false }
        endEntry.fragments.push(thread.anchor.end.fragment.quote)
        this.spanExtra.set(span.endIndex, endEntry)
        continue
      }
      let idx: number | undefined
      if (fast) {
        idx = blocks.find((b) => b.startLine === thread.anchor.hintLine)?.paragraphIndex
        if (idx === undefined) idx = matchThread(thread.anchor, blocks)
      } else {
        idx = matchThread(thread.anchor, blocks)
      }
      // A fragment thread needs the fragment itself to still exist in the matched block,
      // not just the block — otherwise it is orphaned (never re-pinned to the whole block).
      // A `translated` fragment is the exception: its quote is display text, never a substring of
      // the source, so it anchors at block level (like a span) and the source-side check is skipped.
      const block = idx === undefined ? undefined : blocks.find((b) => b.paragraphIndex === idx)
      const fragmentGone =
        block !== undefined &&
        thread.anchor.fragment !== undefined &&
        !thread.anchor.fragment.translated &&
        locateFragment(thread.anchor.fragment, block.text) === undefined
      if (idx === undefined || fragmentGone) {
        thread.orphaned = true
      } else {
        thread.orphaned = false
        const fresh = makeAnchor(blocks, idx)
        if (fresh) {
          // Preserve the fragment across the block-anchor refresh — makeAnchor only
          // rebuilds the block-level context (quote/prefix/suffix/hintLine).
          if (thread.anchor.fragment) fresh.fragment = thread.anchor.fragment
          thread.anchor = fresh
        }
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
    // Accumulate per block: the comment count (drives the marker), the highlight quotes, and a
    // whole-block flag. A span contributes its count to the FIRST block only; the middle/last
    // blocks pick up highlight-only entries from `spanExtra` (count 0 → no marker).
    const byBlock = new Map<number, { count: number; fragments: string[]; whole: boolean }>()
    for (const [paragraphIndex, arr] of this.live) {
      const count = arr.reduce((n, t) => n + t.comments.length, 0)
      if (count === 0) continue
      // The quote of every fragment thread on this block (for a span, the first block's tail),
      // so the webview can highlight the exact text each comment points at.
      const fragments = arr
        .map((t) => t.anchor.fragment?.quote)
        .filter((q): q is string => typeof q === 'string' && q.length > 0)
      byBlock.set(paragraphIndex, { count, fragments, whole: false })
    }
    for (const [paragraphIndex, extra] of this.spanExtra) {
      const e = byBlock.get(paragraphIndex) ?? { count: 0, fragments: [], whole: false }
      e.fragments.push(...extra.fragments)
      e.whole = e.whole || extra.whole
      byBlock.set(paragraphIndex, e)
    }
    const forBlocks: BlockCommentCount[] = []
    for (const [paragraphIndex, e] of byBlock) {
      if (e.count === 0 && e.fragments.length === 0 && !e.whole) continue
      const bc: BlockCommentCount = { paragraphIndex, count: e.count }
      if (e.fragments.length) bc.fragments = e.fragments
      if (e.whole) bc.whole = true
      forBlocks.push(bc)
    }
    const orphaned = this.data.threads
      .filter((t) => t.orphaned && t.comments.length > 0)
      .map((t) => ({ quote: t.anchor.quote, comments: t.comments }))
    return { forBlocks, orphaned }
  }

  getThreadComments(paragraphIndex: number): Comment[] {
    return (this.live.get(paragraphIndex) ?? []).flatMap((t) => t.comments)
  }

  /** Each non-empty thread on a block, with the fragment it points at (stage 4 popover). */
  getThreads(paragraphIndex: number): ThreadView[] {
    return (this.live.get(paragraphIndex) ?? [])
      .filter((t) => t.comments.length > 0)
      .map((t) => ({ fragment: t.anchor.fragment?.quote, comments: t.comments }))
  }

  /** Add a comment to a block, a text FRAGMENT within it (stage 3), or a multi-block SPAN
   *  (req 10.17, when `endIndex`/`endFragment` are given — the last block + its head fragment).
   *  One fragment/span is one thread: a repeat comment on the same fragment (or the same pair of
   *  span ends) joins its discussion; a different fragment — even an overlapping one — starts a new
   *  thread. A whole-block comment (no fragment) joins/creates the block's fragment-less thread.
   *  A span binds to its first block (marker + count there); the highlight spreads across the range. */
  addComment(
    paragraphIndex: number,
    body: string,
    fragment?: FragmentAnchor,
    endIndex?: number,
    endFragment?: FragmentAnchor,
  ): Comment | undefined {
    const text = body.trim()
    if (!text) return undefined
    const ts = this.now()
    const comment: Comment = { id: this.genId(), createdAt: ts, updatedAt: ts, body: text }
    const threads = this.live.get(paragraphIndex) ?? []
    // A span (req 10.17) is identified by BOTH its end fragments; single-block by the one fragment.
    const isSpan = fragment !== undefined && endIndex !== undefined && endFragment !== undefined
    let thread = isSpan
      ? threads.find(
          (t) =>
            t.anchor.fragment?.quote === fragment.quote && t.anchor.end?.fragment.quote === endFragment.quote,
        )
      : fragment
        ? threads.find((t) => t.anchor.fragment?.quote === fragment.quote && !t.anchor.end)
        : threads.find((t) => !t.anchor.fragment)
    if (!thread) {
      const anchor = isSpan
        ? makeSpanAnchor(this.lastBlocks, paragraphIndex, fragment, endIndex, endFragment)
        : makeAnchor(this.lastBlocks, paragraphIndex)
      if (!anchor) return undefined // block(s) no longer present → cannot anchor
      if (!isSpan && fragment) anchor.fragment = fragment // makeSpanAnchor already set it for a span
      thread = { anchor, orphaned: false, comments: [] }
      this.data.threads.push(thread)
      this.live.set(paragraphIndex, [...threads, thread])
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
    this.lastWriteLanded = true // nothing to write ⇒ the document already says what we want
    if (res.kind === 'inline' && this.writeSource && res.newSource !== this.getSource()) {
      this.lastWriteLanded = await this.writeSource(res.newSource)
    }
  }

  /** Swap the persistence backend at runtime (settings change). */
  setBackend(backend: CommentBackend): void { this.backend = backend }

  /** The active backend (for the controller to detect mode changes). */
  currentBackend(): CommentBackend { return this.backend }

  /**
   * Re-home comments from `previous` to the CURRENT backend (already set via
   * setBackend). Persists to the new location, then clears the old ONLY when the
   * storage medium actually changed — for an inline→inline placement change the
   * flush already stripped the old carriers and rewrote them in place, so clearing
   * would wipe what we just wrote. Thread ids are stable, so nothing is lost.
   *
   * SAFETY INVARIANT (req 11.16): an inline target only reaches the editor BUFFER —
   * `writeSource` is a WorkspaceEdit, not a save. Clearing the source at that moment
   * leaves the comments in NEITHER place if the buffer is never saved (close-without-
   * save, undo, crash). So: clear only once the target has reached disk.
   *
   * The carriers can fail to reach disk in TWO independent ways, and both must be ruled
   * out before the source is cleared:
   *  1. the edit never landed — a WorkspaceEdit is REJECTED (resolves false, does not
   *     throw) when the document moved under us, leaving it byte-identical and CLEAN;
   *  2. the save failed — read-only file, write error.
   * Checking only (2) is a trap: a document that never received the edit is clean, and
   * "clean" is indistinguishable from "already saved" to the disk probe. Either failure
   * keeps the source intact and the move is simply retried later.
   */
  async migrateFrom(previous: CommentBackend): Promise<void> {
    await this.flush() // writes to the NEW backend (this.backend)
    if (previous.medium === this.backend.medium) return // inline↔inline placement: already re-homed in place
    if (this.backend.medium === 'inline' && this.data.threads.length > 0) {
      if (!this.lastWriteLanded) return // (1) the carriers never reached the buffer
      const durable = this.saveSource ? await this.saveSource() : true
      if (!durable) return // (2) the buffer never reached disk
    }
    const cleared = await previous.clear(this.getSource())
    if (cleared.newSource !== undefined && this.writeSource && cleared.newSource !== this.getSource()) {
      // Deliberately NOT gated: a failed strip is not a loss. The target already holds the
      // comments, and the leftover carriers are de-duplicated by comment id on the next open.
      await this.writeSource(cleared.newSource)
      await this.saveSource?.() // finish the move: the stripped document must reach disk too
    }
  }

  private stampAndFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), this.flushMs)
  }
}
