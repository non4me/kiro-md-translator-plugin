import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import * as vscode from './mocks/vscode'
import {
  CommentsService,
  parseCommentsFile,
  serializeCommentsFile,
  sidecarUri,
  type SidecarIO,
} from '../src/CommentsService'
import type { Block, CommentsFile } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never

function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = {
    async read(uri) {
      return store.get(String(uri))
    },
    async write(uri, content) {
      store.set(String(uri), content)
    },
  }
  return { io, store }
}

function blocksFrom(texts: string[]): Block[] {
  let line = 0
  return texts.map((text, i) => {
    const b: Block = { paragraphIndex: i, startLine: line, text }
    line += 2
    return b
  })
}

/** flushMs large so the debounce never fires mid-test; tests call flush() explicitly. */
function svc(io: SidecarIO, ids: () => string = (() => { let n = 0; return () => `c${n++}` })()) {
  return new CommentsService(docUri, io, ids, () => '2026-07-04T00:00:00Z', 1_000_000)
}

describe('sidecar (de)serialization', () => {
  // Feature: kiro-md-translator-plugin, Property 20: sidecar round-trips
  it('Property 20: serialize → parse yields the identical comment set', () => {
    const genComment = fc.record({
      id: fc.string({ minLength: 1 }),
      createdAt: fc.constant('2026-07-04T00:00:00Z'),
      updatedAt: fc.constant('2026-07-04T00:00:00Z'),
      body: fc.string({ minLength: 1 }),
    })
    const genThread = fc.record({
      anchor: fc.record({
        quote: fc.string(),
        prefix: fc.string(),
        suffix: fc.string(),
        hintLine: fc.nat(),
        quoteHash: fc.string(),
      }),
      orphaned: fc.boolean(),
      comments: fc.array(genComment, { minLength: 1, maxLength: 4 }),
    })
    const genFile = fc.record({
      version: fc.constant(1),
      docHash: fc.string(),
      threads: fc.array(genThread, { maxLength: 5 }),
    })
    fc.assert(
      fc.property(genFile, (file) => {
        expect(parseCommentsFile(serializeCommentsFile(file as CommentsFile))).toEqual(file)
      }),
    )
  })

  it('parse tolerates malformed / empty input (never throws)', () => {
    expect(parseCommentsFile(undefined).threads).toEqual([])
    expect(parseCommentsFile('{ not json').threads).toEqual([])
    expect(parseCommentsFile('{"threads":"nope"}').threads).toEqual([])
    // a thread with no valid comments is dropped
    expect(parseCommentsFile('{"threads":[{"anchor":{"quote":"x"},"comments":[]}]}').threads).toEqual([])
  })
})

describe('CommentsService', () => {
  it('adds a comment, persists it, and reloads it across instances', async () => {
    const { io } = memIO()
    const s = svc(io)
    await s.load()
    const blocks = blocksFrom(['Alpha block', 'Beta block'])
    s.reanchor(blocks, 'Alpha block\n\nBeta block')
    expect(s.addComment(0, 'hello')).toBeDefined()
    expect(s.getThreadComments(0).map((c) => c.body)).toEqual(['hello'])
    await s.flush()

    const s2 = svc(io)
    await s2.load()
    s2.reanchor(blocks, 'Alpha block\n\nBeta block')
    expect(s2.getThreadComments(0).map((c) => c.body)).toEqual(['hello'])
  })

  it('rejects a blank comment body', async () => {
    const { io } = memIO()
    const s = svc(io)
    await s.load()
    s.reanchor(blocksFrom(['A']), 'A')
    expect(s.addComment(0, '   ')).toBeUndefined()
    expect(s.snapshot().forBlocks).toEqual([])
  })

  it('re-anchors to the shifted block after lines are inserted above it', async () => {
    const { io } = memIO()
    const s = svc(io)
    await s.load()
    const b1 = blocksFrom(['Target paragraph text', 'Second'])
    s.reanchor(b1, b1.map((b) => b.text).join('\n\n'))
    s.addComment(0, 'note')

    const b2 = blocksFrom(['NEW A', 'NEW B', 'Target paragraph text', 'Second'])
    const res = s.reanchor(b2, b2.map((b) => b.text).join('\n\n'))
    expect(res.forBlocks).toEqual([{ paragraphIndex: 2, count: 1 }])
    expect(s.getThreadComments(2).map((c) => c.body)).toEqual(['note'])
  })

  it('surfaces an orphaned thread (not a wrong anchor) when its block is deleted', async () => {
    const { io } = memIO()
    const s = svc(io)
    await s.load()
    const b1 = blocksFrom(['Delete me later paragraph', 'Keeper paragraph'])
    s.reanchor(b1, b1.map((b) => b.text).join('\n\n'))
    s.addComment(0, 'doomed')

    const b2 = blocksFrom(['Keeper paragraph'])
    const res = s.reanchor(b2, 'Keeper paragraph')
    expect(res.forBlocks).toEqual([])
    expect(res.orphaned).toEqual([
      { quote: 'Delete me later paragraph', comments: [expect.objectContaining({ body: 'doomed' })] },
    ])
  })

  it('edits and deletes comments; an emptied thread stops drawing an indicator', async () => {
    const { io } = memIO()
    const s = svc(io)
    await s.load()
    s.reanchor(blocksFrom(['Block one']), 'Block one')
    const c = s.addComment(0, 'first')!
    s.editComment(c.id, 'edited')
    expect(s.getThreadComments(0)[0].body).toBe('edited')
    s.deleteComment(c.id)
    expect(s.getThreadComments(0)).toEqual([])
    expect(s.snapshot().forBlocks).toEqual([])
  })

  it('takes the hintLine fast-path when the document hash is unchanged since save', async () => {
    const { io, store } = memIO()
    const s = svc(io)
    await s.load()
    const blocks = blocksFrom(['One', 'Two'])
    const source = 'One\n\nTwo'
    s.reanchor(blocks, source)
    s.addComment(1, 'on two')
    await s.flush()
    // The persisted sidecar carries a docHash for the saved source.
    expect(store.get(String(sidecarUri(docUri)))).toContain('"docHash"')

    const s2 = svc(io)
    await s2.load()
    const res = s2.reanchor(blocks, source) // same source → fast-path
    expect(res.forBlocks).toEqual([{ paragraphIndex: 1, count: 1 }])
  })

  it('flush() writes nothing when there are no comments (open+close must not litter a sidecar)', async () => {
    const { io, store } = memIO()
    const s = svc(io)
    await s.load() // no sidecar exists yet
    s.reanchor(blocksFrom(['Untouched paragraph']), 'Untouched paragraph')
    await s.flush() // simulates PreviewController.dispose() with no comments added
    expect(store.size).toBe(0) // nothing was written to disk
  })

  it('load tolerates a malformed sidecar file', async () => {
    const { io } = memIO()
    await io.write(sidecarUri(docUri), '{ corrupt')
    const s = svc(io)
    await s.load()
    const res = s.reanchor(blocksFrom(['A']), 'A')
    expect(res.forBlocks).toEqual([])
  })
})
