import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { SidecarBackend } from '../src/commentBackends'
import type { SidecarIO } from '../src/CommentsService'
import type { CommentsFile } from '../src/types'

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
