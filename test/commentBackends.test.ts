import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import {
  SidecarBackend,
  InlineEofBackend,
  InlineAfterBackend,
  DraftBackend,
  draftUri,
  moveDraft,
} from '../src/commentBackends'
import type { SidecarIO } from '../src/commentSidecar'
import type { Block, CommentsFile } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never
const storageRoot = vscode.Uri.parse('file:///global/storage') as never

function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = {
    async read(u) { return store.get(String(u)) },
    async write(u, c) { store.set(String(u), c) },
    async remove(u) { store.delete(String(u)) },
  }
  return { io, store }
}

const file: CommentsFile = {
  version: 1, docHash: '', threads: [
    { anchor: { quote: 'A', prefix: '', suffix: '', hintLine: 0, quoteHash: '' }, orphaned: false,
      comments: [{ id: 'c0', body: 'x', createdAt: '', updatedAt: '' }] },
  ],
}

describe('SidecarBackend', () => {
  it('persists then loads the same threads', async () => {
    const { io } = memIO()
    const be = new SidecarBackend(docUri, io)
    const res = await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    expect(res.kind).toBe('sidecar')
    expect((await be.load('')).threads).toHaveLength(1)
  })

  it('removes the file when persisting an empty set that existed', async () => {
    const { io, store } = memIO()
    const be = new SidecarBackend(docUri, io)
    await be.persist({ data: file, source: '', blocks: [], live: new Map() })
    await be.persist({ data: { version: 1, docHash: '', threads: [] }, source: '', blocks: [], live: new Map() })
    expect(store.size).toBe(0)
  })
})

describe('inline backends', () => {
  const src = `A.\n\nB.`
  const blocks: Block[] = [
    { paragraphIndex: 0, startLine: 0, endLine: 0, text: 'A.' },
    { paragraphIndex: 1, startLine: 2, endLine: 2, text: 'B.' },
  ]
  const live = new Map([[1, file.threads.map((t) => ({ ...t, anchor: { ...t.anchor, quote: 'B.' } }))]])
  const data = { version: 1, docHash: '', threads: live.get(1)! }

  it('end-of-file: persist emits inline newSource that parses back', async () => {
    const be = new InlineEofBackend()
    const res = await be.persist({ data, source: src, blocks, live })
    expect(res.kind).toBe('inline')
    if (res.kind === 'inline') expect((await be.load(res.newSource)).threads).toHaveLength(1)
  })

  it('after-paragraph: comment lands after its block', async () => {
    const be = new InlineAfterBackend()
    const res = await be.persist({ data, source: src, blocks, live })
    if (res.kind === 'inline') expect(res.newSource).toContain('B.\n\n<!-- rmt:comments')
  })

  it('clear strips inline blocks', async () => {
    const be = new InlineEofBackend()
    const withBlock = (await be.persist({ data, source: src, blocks, live })) as { newSource: string }
    const cleared = await be.clear(withBlock.newSource)
    expect(cleared.newSource).not.toContain('rmt:comments')
  })
})

describe('DraftBackend', () => {
  const ctx = (data: CommentsFile) => ({ data, source: '', blocks: [], live: new Map() })

  it('persists then loads the same threads', async () => {
    const { io } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    const res = await be.persist(ctx(file))
    expect(res.kind).toBe('draft')
    expect((await be.load('')).threads).toHaveLength(1)
  })

  it('writes into the extension storage, never next to the document', async () => {
    const { io, store } = memIO()
    await new DraftBackend(docUri, storageRoot, io).persist(ctx(file))
    const key = [...store.keys()][0]
    expect(key).toContain('/global/storage/')
    expect(key).not.toContain('/doc/')
  })

  it('removes the record when the last comment goes', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await be.persist(ctx(file))
    await be.persist(ctx({ version: 1, docHash: '', threads: [] }))
    expect(store.size).toBe(0)
  })

  it('a record claiming another document reads as empty (a hash collision is a miss, never a mix-up)', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await io.write(
      draftUri(docUri, storageRoot),
      JSON.stringify({ version: 1, docHash: '', docUri: 'file:///other/doc.md', threads: file.threads }),
    )
    expect((await be.load('')).threads).toHaveLength(0)
    expect(store.size).toBe(1) // not ours → left alone, not deleted
  })

  it('a corrupt record reads as empty and never throws', async () => {
    const { io } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await io.write(draftUri(docUri, storageRoot), '{ not json')
    expect((await be.load('')).threads).toHaveLength(0)
  })

  it('clear removes the record', async () => {
    const { io, store } = memIO()
    const be = new DraftBackend(docUri, storageRoot, io)
    await be.persist(ctx(file))
    await be.clear('')
    expect(store.size).toBe(0)
  })
})

describe('moveDraft', () => {
  const renamed = vscode.Uri.parse('file:///doc/renamed.md') as never

  it('re-keys the record to the new document uri', async () => {
    const { io, store } = memIO()
    await new DraftBackend(docUri, storageRoot, io).persist({
      data: file, source: '', blocks: [], live: new Map(),
    })
    expect(await moveDraft(docUri, renamed, storageRoot, io)).toBe(true)
    expect(store.size).toBe(1)
    expect((await new DraftBackend(renamed, storageRoot, io).load('')).threads).toHaveLength(1)
    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(0)
  })

  it('is a no-op when the document has no draft', async () => {
    const { io, store } = memIO()
    expect(await moveDraft(docUri, renamed, storageRoot, io)).toBe(false)
    expect(store.size).toBe(0)
  })
})
