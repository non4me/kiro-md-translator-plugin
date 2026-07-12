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
import { SidecarBackend, InlineAfterBackend, DraftBackend } from '../src/commentBackends'
import type { Block, CommentsFile } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never
const storageRoot = vscode.Uri.parse('file:///global/storage') as never

function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = {
    async read(uri) {
      return store.get(String(uri))
    },
    async write(uri, content) {
      store.set(String(uri), content)
    },
    async remove(uri) {
      store.delete(String(uri))
    },
  }
  return { io, store }
}

function blocksFrom(texts: string[]): Block[] {
  let line = 0
  return texts.map((text, i) => {
    const b: Block = { paragraphIndex: i, startLine: line, endLine: line, text }
    line += 2
    return b
  })
}

/** flushMs large so the debounce never fires mid-test; tests call flush() explicitly. */
function svc(io: SidecarIO, ids: () => string = (() => { let n = 0; return () => `c${n++}` })()) {
  return new CommentsService(docUri, new SidecarBackend(docUri, io), ids, () => '2026-07-04T00:00:00Z', 1_000_000)
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

  it('flush() removes the sidecar once the last comment is deleted', async () => {
    const { io, store } = memIO()
    const s = svc(io)
    await s.load()
    s.reanchor(blocksFrom(['Block one']), 'Block one')
    const c = s.addComment(0, 'first')!
    await s.flush()
    expect(store.has(String(sidecarUri(docUri)))).toBe(true) // written while it has a comment
    s.deleteComment(c.id)
    await s.flush()
    expect(store.has(String(sidecarUri(docUri)))).toBe(false) // deleted, not left empty
  })

  it('re-anchors an untrusted sidecar with under-specified anchor fields without throwing', async () => {
    // Repro of the crash: a hand-crafted sidecar whose anchor omits prefix/suffix,
    // plus a document with TWO identical blocks (forces the disambiguation path that
    // reaches diceSimilarity with the missing fields). Must not throw (req 11.8).
    const { io } = memIO()
    await io.write(
      sidecarUri(docUri),
      JSON.stringify({
        version: 1,
        docHash: 'stale',
        threads: [
          { anchor: { quote: 'foo' }, comments: [{ id: 'c1', body: 'x', createdAt: 'T', updatedAt: 'T' }] },
        ],
      }),
    )
    const s = svc(io)
    await s.load()
    const blocks = blocksFrom(['foo', 'foo'])
    expect(() => s.reanchor(blocks, 'foo\n\nfoo')).not.toThrow()
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

/**
 * Auto-import (req 11.18): a storage setting flipped while a document was closed leaves
 * its comments behind in the old store. On open we read all three, merge, and move them
 * into the selected one — in two phases, because the move needs the block list.
 */
describe('auto-import', () => {
  const ids = () => {
    let n = 0
    return () => `c${n++}`
  }
  const svcFor = (
    backend: ConstructorParameters<typeof CommentsService>[1],
    src: () => string,
    write: (t: string) => void,
  ) =>
    new CommentsService(docUri, backend, ids(), () => 't', 1_000_000, src, async (t) => {
      write(t)
      return true // the write landed (a rejected WorkspaceEdit would resolve false)
    })

  it('surfaces comments left in another store and moves them into the current one', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const old = svcFor(new SidecarBackend(docUri, io), () => source, (t) => { source = t })
    await old.load()
    old.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    old.addComment(1, 'note')
    await old.flush()
    expect(store.size).toBe(1)

    // The user is now in draft mode; the sidecar was left behind.
    const svc = svcFor(new DraftBackend(docUri, storageRoot, io), () => source, (t) => { source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new InlineAfterBackend()])
    await svc.load()
    expect(svc.importedCount).toBe(1)

    const res = svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    expect(res.forBlocks).toEqual([{ paragraphIndex: 1, count: 1 }]) // visible before any write
    await svc.completeImport()

    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(1)
    expect(store.size).toBe(1) // sidecar gone, draft written
    expect([...store.keys()][0]).toContain('/global/storage/')
  })

  it('de-duplicates by comment id when the same comment sits in two stores', async () => {
    const { io } = memIO()
    const source = `Alpha.\n\nBeta.`
    const data: CommentsFile = {
      version: 1,
      docHash: '',
      threads: [
        {
          anchor: { quote: 'Beta.', prefix: '', suffix: '', hintLine: 2, quoteHash: '' },
          orphaned: false,
          comments: [{ id: 'dup', body: 'note', createdAt: 't', updatedAt: 't' }],
        },
      ],
    }
    const ctx = { data, source, blocks: [], live: new Map() }
    await new SidecarBackend(docUri, io).persist(ctx)
    await new DraftBackend(docUri, storageRoot, io).persist(ctx)

    const svc = svcFor(new DraftBackend(docUri, storageRoot, io), () => source, () => {})
    svc.setImportSources([new SidecarBackend(docUri, io), new InlineAfterBackend()])
    await svc.load()
    expect(svc.importedCount).toBe(0) // already present → nothing to move

    const res = svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    expect(res.forBlocks).toEqual([{ paragraphIndex: 1, count: 1 }]) // counted ONCE
  })

  it('nothing to import ⇒ the document is not touched at all', async () => {
    const { io } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    let writes = 0
    const svc = svcFor(new InlineAfterBackend(), () => source, (t) => { writes++; source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new DraftBackend(docUri, storageRoot, io)])
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    await svc.completeImport()
    expect(writes).toBe(0)
    expect(source).toBe(original)
  })

  it('imports from BOTH other stores into an inline target and clears BOTH', async () => {
    // The second migrate pass produces no further text change, so a `saveSource` that
    // reported "did the buffer change?" instead of "is it on disk?" would skip the second
    // clear and strand that store forever. The injected contract is durability.
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const sidecarData: CommentsFile = {
      version: 1,
      docHash: '',
      threads: [
        {
          anchor: { quote: 'Alpha.', prefix: '', suffix: '', hintLine: 0, quoteHash: '' },
          orphaned: false,
          comments: [{ id: 's1', body: 'from sidecar', createdAt: 't', updatedAt: 't' }],
        },
      ],
    }
    const draftData: CommentsFile = {
      version: 1,
      docHash: '',
      threads: [
        {
          anchor: { quote: 'Beta.', prefix: '', suffix: '', hintLine: 2, quoteHash: '' },
          orphaned: false,
          comments: [{ id: 'd1', body: 'from draft', createdAt: 't', updatedAt: 't' }],
        },
      ],
    }
    await new SidecarBackend(docUri, io).persist({ data: sidecarData, source, blocks: [], live: new Map() })
    await new DraftBackend(docUri, storageRoot, io).persist({ data: draftData, source, blocks: [], live: new Map() })
    expect(store.size).toBe(2)

    const svc = new CommentsService(
      docUri, new InlineAfterBackend(), (() => { let n = 0; return () => `c${n++}` })(),
      () => 't', 1_000_000,
      () => source,
      async (t) => { source = t; return true },
      async () => true, // durable
    )
    svc.setImportSources([new SidecarBackend(docUri, io), new DraftBackend(docUri, storageRoot, io)])
    await svc.load()
    expect(svc.importedCount).toBe(2)

    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    await svc.completeImport()

    expect(store.size).toBe(0) // BOTH stores cleared, neither stranded
    expect(source).toContain('Alpha.\n\n<!-- rmt:comments')
    expect(source).toContain('Beta.\n\n<!-- rmt:comments')
  })

  it('moves nothing before the blocks exist — otherwise every carrier lands at EOF', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const old = svcFor(new SidecarBackend(docUri, io), () => source, (t) => { source = t })
    await old.load()
    old.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    old.addComment(1, 'note')
    await old.flush()

    const svc = svcFor(new InlineAfterBackend(), () => source, (t) => { source = t })
    svc.setImportSources([new SidecarBackend(docUri, io), new DraftBackend(docUri, storageRoot, io)])
    await svc.load()
    await svc.completeImport() // no reanchor yet → must be a no-op

    expect(source).not.toContain('rmt:comments')
    expect(store.size).toBe(1) // sidecar untouched

    // …and once the blocks are known, the carrier lands after ITS paragraph, not at EOF.
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    await svc.completeImport()
    expect(source).toContain('Beta.\n\n<!-- rmt:comments')
    expect(store.size).toBe(0)
  })
})

describe('fragment comments (stage 3)', () => {
  const text = 'The quick brown fox jumps.'
  const fragOf = (q: string) => ({ quote: q, prefix: '', suffix: '' })

  it('a fragment comment is a thread separate from the whole-block one', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom([text]), text)
    s.addComment(0, 'about the whole block')
    s.addComment(0, 'about the fox', fragOf('fox'))
    const res = s.reanchor(blocksFrom([text]), text)
    expect(res.forBlocks.find((b) => b.paragraphIndex === 0)?.count).toBe(2)
  })

  it('a second comment on the same fragment joins its thread', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom([text]), text)
    s.addComment(0, 'one', fragOf('fox'))
    s.addComment(0, 'two', fragOf('fox'))
    expect(s.getThreadComments(0)).toHaveLength(2)
    const res = s.reanchor(blocksFrom([text]), text)
    expect(res.forBlocks.find((b) => b.paragraphIndex === 0)?.count).toBe(2)
  })

  it('a comment on a different fragment starts a new thread', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom([text]), text)
    s.addComment(0, 'fox note', fragOf('fox'))
    s.addComment(0, 'quick note', fragOf('quick'))
    expect(s.getThreadComments(0)).toHaveLength(2)
  })

  it('reports each fragment quote to the webview for highlighting', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom([text]), text)
    s.addComment(0, 'fox note', fragOf('fox'))
    s.addComment(0, 'quick note', fragOf('quick'))
    const res = s.reanchor(blocksFrom([text]), text)
    const block = res.forBlocks.find((b) => b.paragraphIndex === 0)!
    expect(block.fragments?.sort()).toEqual(['fox', 'quick'])
  })

  it('a fragment orphans when its text is gone, even though the block remains', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom([text]), text)
    s.addComment(0, 'fox note', fragOf('fox'))
    const edited = 'The quick brown CAT jumps.'
    const res = s.reanchor(blocksFrom([edited]), edited)
    expect(res.forBlocks.find((b) => b.paragraphIndex === 0)).toBeUndefined()
    expect(res.orphaned).toHaveLength(1)
  })

  it('a fragment survives persist + reload', async () => {
    const { io } = memIO()
    const s = svc(io)
    s.reanchor(blocksFrom([text]), text)
    s.addComment(0, 'fox note', fragOf('fox'))
    await s.flush()
    const s2 = svc(io)
    await s2.load()
    const res = s2.reanchor(blocksFrom([text]), text)
    expect(res.forBlocks.find((b) => b.paragraphIndex === 0)?.count).toBe(1)
  })
})

describe('multi-block span comments (stage 4)', () => {
  const texts = ['Alpha one', 'Beta two', 'Gamma three']
  const source = texts.join('\n\n')
  const startFrag = { quote: 'one', prefix: 'Alpha ', suffix: '' } // selected tail of the first block
  const endFrag = { quote: 'Gamma', prefix: '', suffix: ' three' } // selected head of the last block

  it('a span comment marks the FIRST block and highlights the whole range', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom(texts), source) // sets lastBlocks so makeSpanAnchor can build
    s.addComment(0, 'across the list', startFrag, 2, endFrag)
    const res = s.reanchor(blocksFrom(texts), source)
    expect(res.forBlocks).toEqual([
      { paragraphIndex: 0, count: 1, fragments: ['one'] }, // marker + tail highlight on the first block
      { paragraphIndex: 1, count: 0, whole: true }, // middle block highlighted whole, NO marker
      { paragraphIndex: 2, count: 0, fragments: ['Gamma'] }, // last block: head highlight, NO marker
    ])
  })

  it('a second comment on the same span joins one thread (count grows on the first block only)', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom(texts), source)
    s.addComment(0, 'a', startFrag, 2, endFrag)
    s.addComment(0, 'b', startFrag, 2, endFrag)
    const res = s.reanchor(blocksFrom(texts), source)
    expect(res.forBlocks.find((b) => b.paragraphIndex === 0)).toEqual({
      paragraphIndex: 0,
      count: 2,
      fragments: ['one'],
    })
  })

  it('a span orphans (never a partial highlight) when its end block is deleted', () => {
    const s = svc(memIO().io)
    s.reanchor(blocksFrom(texts), source)
    s.addComment(0, 'across the list', startFrag, 2, endFrag)
    const shrunk = ['Alpha one', 'Beta two'] // the last block (the span's end) is gone
    const res = s.reanchor(blocksFrom(shrunk), shrunk.join('\n\n'))
    expect(res.forBlocks).toEqual([]) // no marker, no highlight anywhere
    expect(res.orphaned).toHaveLength(1)
    expect(res.orphaned[0].comments[0].body).toBe('across the list')
  })
})
