import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { CommentImporter, type ImportDeps, type ImportOutcome } from '../src/CommentImporter'
import { SidecarBackend, InlineAfterBackend, DraftBackend } from '../src/commentBackends'
import type { SidecarIO } from '../src/commentSidecar'
import type { Block, CommentsFile } from '../src/types'

const storageRoot = vscode.Uri.parse('file:///global/storage') as never
const uriA = vscode.Uri.parse('file:///p/a.md') as never
const uriB = vscode.Uri.parse('file:///p/b.md') as never

function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = {
    async read(u) { return store.get(String(u)) },
    async write(u, c) { store.set(String(u), c) },
    async remove(u) { store.delete(String(u)) },
  }
  return { io, store }
}

const threadFor = (quote: string, id: string): CommentsFile => ({
  version: 1,
  docHash: '',
  threads: [
    {
      anchor: { quote, prefix: '', suffix: '', hintLine: 2, quoteHash: '' },
      orphaned: false,
      comments: [{ id, body: 'note', createdAt: 't', updatedAt: 't' }],
    },
  ],
})

/** Paragraphs separated by a blank line, one line each — enough for the anchoring math. */
const blocksOf = (src: string): Block[] =>
  src.split('\n\n').map((text, i) => ({
    paragraphIndex: i,
    startLine: i * 2,
    endLine: i * 2,
    text: text.trim(),
  }))

/** Draft is the selected storage; sidecar + inline are the stores to import FROM. */
function makeDeps(
  io: SidecarIO,
  texts: Map<string, string>,
  opts: { dirty?: string[]; unwritable?: string[] } = {},
): ImportDeps {
  return {
    listDocuments: async () => [uriA, uriB],
    readDocument: async (u) => {
      const text = texts.get(String(u))
      return text === undefined ? undefined : { text, dirty: (opts.dirty ?? []).includes(String(u)) }
    },
    writeDocument: async (u, text) => {
      if ((opts.unwritable ?? []).includes(String(u))) return false
      texts.set(String(u), text)
      return true
    },
    backendsFor: (u) => ({
      target: new DraftBackend(u, storageRoot, io),
      sources: [new SidecarBackend(u, io), new InlineAfterBackend()],
    }),
    blocksOf,
  }
}

const seedSidecar = (io: SidecarIO, uri: never, quote: string, id: string) =>
  new SidecarBackend(uri, io).persist({
    data: threadFor(quote, id), source: '', blocks: [], live: new Map(),
  })

describe('CommentImporter', () => {
  it('plans only the documents that actually hold comments elsewhere', async () => {
    const { io } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.'], [String(uriB), 'Gamma.']])
    await seedSidecar(io, uriA, 'Beta.', 'c1')

    const plan = await new CommentImporter(makeDeps(io, texts)).plan()

    expect(plan).toHaveLength(1)
    expect(String(plan[0].uri)).toBe(String(uriA))
    expect(plan[0].commentCount).toBe(1)
  })

  it('moves the comments into the selected storage and clears the source', async () => {
    const { io, store } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.'], [String(uriB), 'Gamma.']])
    await seedSidecar(io, uriA, 'Beta.', 'c1')

    const importer = new CommentImporter(makeDeps(io, texts))
    const outcome = await importer.run(await importer.plan(), () => {}, () => false)

    expect(outcome.movedComments).toBe(1)
    expect(outcome.movedFiles).toBe(1)
    expect(outcome.failures).toEqual([])
    expect(store.size).toBe(1)
    expect([...store.keys()][0]).toContain('/global/storage/') // sidecar gone, draft written
    expect((await new DraftBackend(uriA, storageRoot, io).load('')).threads).toHaveLength(1)
    expect(texts.get(String(uriA))).toBe('Alpha.\n\nBeta.') // draft target: .md untouched
  })

  it('skips a document with unsaved changes — its comments stay where they are', async () => {
    const { io, store } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.']])
    await seedSidecar(io, uriA, 'Beta.', 'c1')

    const deps = makeDeps(io, texts, { dirty: [String(uriA)] })
    const importer = new CommentImporter(deps)
    const outcome = await importer.run(await importer.plan(), () => {}, () => false)

    expect(outcome.movedFiles).toBe(0)
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0].reason).toContain('unsaved')
    expect(store.size).toBe(1) // the sidecar is STILL there — nothing was lost
  })

  it('cancelling stops the run; what already moved stays moved', async () => {
    const { io } = memIO()
    const texts = new Map([
      [String(uriA), 'Alpha.\n\nBeta.'],
      [String(uriB), 'Gamma.\n\nDelta.'],
    ])
    await seedSidecar(io, uriA, 'Beta.', 'c1')
    await seedSidecar(io, uriB, 'Delta.', 'c2')

    const importer = new CommentImporter(makeDeps(io, texts))
    const plan = await importer.plan()
    expect(plan).toHaveLength(2)

    let done = 0
    const outcome = await importer.run(plan, () => { done++ }, () => done >= 1) // cancel after the first

    expect(outcome.cancelled).toBe(true)
    expect(outcome.movedFiles).toBe(1)
    expect((await new DraftBackend(uriA, storageRoot, io).load('')).threads).toHaveLength(1)
    expect((await new DraftBackend(uriB, storageRoot, io).load('')).threads).toHaveLength(0)
  })

  it('an unwritable document fails without losing its comments (inline target)', async () => {
    const { io, store } = memIO()
    const texts = new Map([[String(uriA), 'Alpha.\n\nBeta.']])
    await seedSidecar(io, uriA, 'Beta.', 'c1')

    const deps: ImportDeps = {
      ...makeDeps(io, texts, { unwritable: [String(uriA)] }),
      listDocuments: async () => [uriA],
      // The selected storage is now INLINE: the move must write into the .md, which fails.
      backendsFor: (u) => ({
        target: new InlineAfterBackend(),
        sources: [new SidecarBackend(u, io), new DraftBackend(u, storageRoot, io)],
      }),
    }
    const importer = new CommentImporter(deps)
    const outcome = await importer.run(await importer.plan(), () => {}, () => false)

    expect(outcome.movedFiles).toBe(0)
    expect(outcome.failures[0].reason).toContain('could not be written')
    expect(store.size).toBe(1) // sidecar SURVIVES — the durability invariant held
    expect(texts.get(String(uriA))).toBe('Alpha.\n\nBeta.') // and the file on disk is intact
  })

  it('the report says the comments were NOT lost', () => {
    const outcome: ImportOutcome = {
      movedComments: 0,
      movedFiles: 0,
      failures: [{ uri: 'file:///p/a.md', reason: 'unsaved changes in the editor' }],
      cancelled: false,
    }
    const report = CommentImporter.formatReport(outcome)
    expect(report).toContain('file:///p/a.md')
    expect(report).toContain('unsaved changes in the editor')
    expect(report).toContain('NOT lost')
  })
})
