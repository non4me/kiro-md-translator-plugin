/**
 * Persistence backends for the comment layer (req 11). A `CommentBackend` owns
 * *where/how* comments are stored; `CommentsService` owns the anchoring, live-map,
 * and debounce. `SidecarBackend` is the default `<name>.comments.json` store —
 * behavior-identical to the store logic that previously lived in CommentsService.
 * Inline backends (Task 7) implement the same seam and return `{ kind: 'inline' }`.
 */
import * as vscode from 'vscode'
import type { Block, CommentThread, CommentsFile } from './types'
import { parseCommentsFile, serializeCommentsFile, sidecarUri, type SidecarIO, fsIO } from './commentSidecar'
import { parseInline, serializeEof, serializeAfter, stripInlineComments } from './inlineComments'
import { hashString } from './anchoring'

export interface PersistCtx {
  data: CommentsFile
  source: string
  blocks: Block[]
  live: Map<number, CommentThread[]>
}

export type StorageMedium = 'sidecar' | 'inline' | 'draft'

export type PersistResult =
  | { kind: 'sidecar' }
  | { kind: 'draft' }
  | { kind: 'inline'; newSource: string }

export interface CommentBackend {
  readonly medium: StorageMedium
  load(source: string): Promise<CommentsFile>
  persist(ctx: PersistCtx): Promise<PersistResult>
  clear(source: string): Promise<{ newSource?: string }>
}

export class SidecarBackend implements CommentBackend {
  readonly medium = 'sidecar' as const
  private existed = false
  private readonly uri: vscode.Uri
  constructor(docUri: vscode.Uri, private readonly io: SidecarIO = fsIO) {
    this.uri = sidecarUri(docUri)
  }
  async load(): Promise<CommentsFile> {
    const raw = await this.io.read(this.uri)
    this.existed = raw !== undefined
    return parseCommentsFile(raw)
  }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    if (ctx.data.threads.length === 0) {
      if (this.existed) { this.existed = false; await this.io.remove(this.uri) }
      return { kind: 'sidecar' }
    }
    this.existed = true
    await this.io.write(this.uri, serializeCommentsFile(ctx.data))
    return { kind: 'sidecar' }
  }
  async clear(): Promise<{ newSource?: string }> {
    this.existed = false
    await this.io.remove(this.uri)
    return {}
  }
}

export class InlineEofBackend implements CommentBackend {
  readonly medium = 'inline' as const
  async load(source: string): Promise<CommentsFile> { return parseInline(source) }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    return { kind: 'inline', newSource: serializeEof(ctx.source, ctx.data) }
  }
  async clear(source: string): Promise<{ newSource?: string }> {
    return { newSource: stripInlineComments(source) }
  }
}

export class InlineAfterBackend implements CommentBackend {
  readonly medium = 'inline' as const
  async load(source: string): Promise<CommentsFile> { return parseInline(source) }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    const newSource = ctx.data.threads.length === 0
      ? stripInlineComments(ctx.source)
      : serializeAfter(ctx.source, ctx.data, ctx.blocks, ctx.live)
    return { kind: 'inline', newSource }
  }
  async clear(source: string): Promise<{ newSource?: string }> {
    return { newSource: stripInlineComments(source) }
  }
}

const DRAFT_DIR = 'comments'

/** `<globalStorage>/comments/<hash>.json`. `hashString` is djb2, NOT cryptographic, so the
 *  record also carries `docUri` and `load` verifies it: a collision must yield a MISS (no
 *  comments), never another document's comments. */
export function draftUri(docUri: vscode.Uri, storageRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storageRoot, DRAFT_DIR, `${hashString(docUri.toString())}.json`)
}

/** True when `raw` is a draft record for exactly this document. */
function ownedBy(raw: string, key: string): boolean {
  try {
    return (JSON.parse(raw) as { docUri?: unknown }).docUri === key
  } catch {
    return false
  }
}

/**
 * Comments in the extension's own storage (req 11.14): nothing is written beside the
 * document and the `.md` is never modified — the only backend that works on a document you
 * cannot write to. Drafts do NOT travel with the file; that is the mode, not a gap.
 */
export class DraftBackend implements CommentBackend {
  readonly medium = 'draft' as const
  private readonly uri: vscode.Uri
  private readonly key: string
  constructor(docUri: vscode.Uri, storageRoot: vscode.Uri, private readonly io: SidecarIO = fsIO) {
    this.uri = draftUri(docUri, storageRoot)
    this.key = docUri.toString()
  }
  async load(): Promise<CommentsFile> {
    const raw = await this.io.read(this.uri)
    if (raw === undefined || !ownedBy(raw, this.key)) return parseCommentsFile(undefined)
    return parseCommentsFile(raw)
  }
  async persist(ctx: PersistCtx): Promise<PersistResult> {
    if (ctx.data.threads.length === 0) {
      await this.io.remove(this.uri) // tolerant of an already-missing record
      return { kind: 'draft' }
    }
    await this.io.write(this.uri, JSON.stringify({ ...ctx.data, docUri: this.key }, null, 2))
    return { kind: 'draft' }
  }
  async clear(): Promise<{ newSource?: string }> {
    await this.io.remove(this.uri)
    return {}
  }
}

/** Follow a document rename: move its draft record and re-stamp the embedded uri — without
 *  the re-stamp the record would fail its own ownership check at the new location. Returns
 *  false when there was no draft to move. */
export async function moveDraft(
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
  storageRoot: vscode.Uri,
  io: SidecarIO = fsIO,
): Promise<boolean> {
  const from = draftUri(oldUri, storageRoot)
  const raw = await io.read(from)
  if (raw === undefined || !ownedBy(raw, oldUri.toString())) return false
  const data = parseCommentsFile(raw)
  await io.write(
    draftUri(newUri, storageRoot),
    JSON.stringify({ ...data, docUri: newUri.toString() }, null, 2),
  )
  await io.remove(from)
  return true
}
