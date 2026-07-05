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

export interface PersistCtx {
  data: CommentsFile
  source: string
  blocks: Block[]
  live: Map<number, CommentThread[]>
}

export type StorageMedium = 'sidecar' | 'inline'

export type PersistResult = { kind: 'sidecar' } | { kind: 'inline'; newSource: string }

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
