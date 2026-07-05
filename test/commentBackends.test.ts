import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { SidecarBackend, InlineEofBackend, InlineAfterBackend } from '../src/commentBackends'
import type { SidecarIO } from '../src/commentSidecar'
import type { Block, CommentsFile } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never

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
