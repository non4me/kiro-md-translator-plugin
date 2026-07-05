import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { CommentsService } from '../src/CommentsService'
import { InlineAfterBackend } from '../src/commentBackends'
import { parseInline } from '../src/inlineComments'
import type { Block } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never

function blocksFrom(texts: string[]): Block[] {
  let line = 0
  return texts.map((text, i) => {
    const b: Block = { paragraphIndex: i, startLine: line, endLine: line, text }
    line += 2
    return b
  })
}

describe('CommentsService × inline (after-paragraph)', () => {
  it('load→add→flush writes the comment into the source via writeSource', async () => {
    let source = `First para.\n\nSecond para.`
    const ids = (() => { let n = 0; return () => `c${n++}` })()
    const svc = new CommentsService(
      docUri,
      new InlineAfterBackend(),
      ids,
      () => '2026-07-05T00:00:00Z',
      1_000_000, // large flushMs; we call flush() explicitly
      () => source,
      async (text) => { source = text },
    )
    await svc.load() // empty doc → no threads
    const blocks = blocksFrom(['First para.', 'Second para.'])
    svc.reanchor(blocks, source)
    svc.addComment(1, 'a note on the second paragraph')
    await svc.flush()

    // writeSource must have persisted a carrier after the second paragraph
    expect(source).toContain('Second para.\n\n<!-- rmt:comments')
    // and it round-trips: a fresh service loads the same thread back
    const reloaded = parseInline(source)
    expect(reloaded.threads).toHaveLength(1)
    expect(reloaded.threads[0].comments[0].body).toBe('a note on the second paragraph')
  })

  it('deleting the last comment strips the carrier back out', async () => {
    let source = `First para.\n\nSecond para.`
    const ids = (() => { let n = 0; return () => `c${n++}` })()
    const svc = new CommentsService(
      docUri, new InlineAfterBackend(), ids, () => '2026-07-05T00:00:00Z', 1_000_000,
      () => source, async (text) => { source = text },
    )
    await svc.load()
    const blocks = blocksFrom(['First para.', 'Second para.'])
    svc.reanchor(blocks, source)
    const c = svc.addComment(1, 'temp')!
    await svc.flush()
    expect(source).toContain('rmt:comments')
    // re-anchor against the now-carrier-containing source, then delete
    svc.reanchor(blocksFrom(['First para.', 'Second para.']), source)
    svc.deleteComment(c.id)
    await svc.flush()
    expect(source).not.toContain('rmt:comments')
  })
})
