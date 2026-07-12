/**
 * Project-wide comment import (req 11.19): move every document's comments into the storage
 * the user currently has selected. Two passes — `plan()` finds the work, `run()` does it —
 * so the confirmation can quote real numbers and the expensive pass only touches documents
 * that need it. The document text is re-read at write time, in case it changed in between.
 *
 * Each document moves independently and completely, so a cancelled or partly failed run is
 * "some moved, some did not" — never a half-state. That is what `migrateFrom`'s durability
 * invariant buys: a failure means the comments did not MOVE, never that they were lost.
 *
 * Every host touch is injected (`ImportDeps`), so the logic is testable without an
 * extension host.
 */
import type * as vscode from 'vscode'
import type { Block } from './types'
import { CommentsService } from './CommentsService'
import type { CommentBackend } from './commentBackends'

export interface ImportDeps {
  /** Every markdown document in the project. */
  listDocuments(): Promise<vscode.Uri[]>
  /** Current text, plus whether an editor is holding unsaved changes for it. */
  readDocument(uri: vscode.Uri): Promise<{ text: string; dirty: boolean } | undefined>
  /** Apply + save. Resolves false when the document could not be written. */
  writeDocument(uri: vscode.Uri, text: string): Promise<boolean>
  /** The storage the user selected, plus the ones to import from. */
  backendsFor(uri: vscode.Uri): { target: CommentBackend; sources: CommentBackend[] }
  /** Anchorable blocks of a source text. */
  blocksOf(source: string): Block[]
}

export interface ImportPlanItem {
  uri: vscode.Uri
  commentCount: number
}

export interface ImportFailure {
  uri: string
  reason: string
}

export interface ImportOutcome {
  movedComments: number
  movedFiles: number
  failures: ImportFailure[]
  cancelled: boolean
}

export class CommentImporter {
  constructor(private readonly deps: ImportDeps) {}

  /** Pass 1: which documents hold comments in a store other than the selected one. */
  async plan(): Promise<ImportPlanItem[]> {
    const items: ImportPlanItem[] = []
    for (const uri of await this.deps.listDocuments()) {
      const doc = await this.deps.readDocument(uri)
      if (!doc) continue
      const { target, sources } = this.deps.backendsFor(uri)
      const svc = new CommentsService(uri, target, undefined, undefined, undefined, () => doc.text)
      svc.setImportSources(sources)
      await svc.load()
      if (svc.importedCount > 0) items.push({ uri, commentCount: svc.importedCount })
    }
    return items
  }

  /** Pass 2: execute the plan, reporting progress and honouring cancellation. */
  async run(
    plan: ImportPlanItem[],
    onProgress: (item: ImportPlanItem, done: number) => void,
    isCancelled: () => boolean,
  ): Promise<ImportOutcome> {
    const outcome: ImportOutcome = { movedComments: 0, movedFiles: 0, failures: [], cancelled: false }
    let done = 0
    for (const item of plan) {
      if (isCancelled()) {
        outcome.cancelled = true
        break
      }
      const failure = await this.moveOne(item)
      if (failure) {
        outcome.failures.push({ uri: item.uri.toString(), reason: failure })
      } else {
        outcome.movedFiles++
        outcome.movedComments += item.commentCount
      }
      onProgress(item, ++done)
    }
    return outcome
  }

  /** Move one document's comments. Returns a failure reason, or undefined on success. */
  private async moveOne(item: ImportPlanItem): Promise<string | undefined> {
    const doc = await this.deps.readDocument(item.uri)
    if (!doc) return 'the document could not be read'
    // Never rewrite a buffer the user is still editing underneath them.
    if (doc.dirty) return 'unsaved changes in the editor'

    let text = doc.text
    let writeFailed = false
    const { target, sources } = this.deps.backendsFor(item.uri)
    const svc = new CommentsService(
      item.uri,
      target,
      undefined, // default genId
      undefined, // default now
      undefined, // default flushMs — no comment is added here, so no timer is ever armed
      () => text,
      async (next) => {
        text = next
      },
      async () => {
        const ok = await this.deps.writeDocument(item.uri, text)
        if (!ok) writeFailed = true
        return ok
      },
    )
    svc.setImportSources(sources)
    await svc.load()
    if (svc.importedCount === 0) return undefined // already moved since the plan was built
    svc.reanchor(this.deps.blocksOf(text), text)
    await svc.completeImport()
    return writeFailed ? 'the document could not be written' : undefined
  }

  /** The failure report. Its most important sentence is that a failure is a "did not move",
   *  not a "lost": the source store is only cleared once the move has reached disk. */
  static formatReport(outcome: ImportOutcome): string {
    return [
      'Read Markdown Translator — comment import report',
      '',
      `Moved:  ${outcome.movedComments} comment(s) in ${outcome.movedFiles} file(s).`,
      `Failed: ${outcome.failures.length} file(s).`,
      '',
      'Failures:',
      ...outcome.failures.map((f) => `  ${f.uri}\n      ${f.reason}`),
      '',
      'These comments were NOT lost. They are still in the storage they were already in:',
      'a source store is never cleared until the move has reached disk. Fix the cause',
      '(unsaved changes, a read-only file) and run the import again.',
      '',
      'This file is a one-off report — delete it whenever you like.',
      '',
    ].join('\n')
  }
}
