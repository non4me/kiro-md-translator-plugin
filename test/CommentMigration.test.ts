import { describe, it, expect } from 'vitest'
import * as vscode from './mocks/vscode'
import { CommentsService } from '../src/CommentsService'
import { SidecarBackend, InlineEofBackend, InlineAfterBackend, DraftBackend } from '../src/commentBackends'
import type { SidecarIO } from '../src/commentSidecar'
import { parseInline } from '../src/inlineComments'
import type { Block } from '../src/types'

const docUri = vscode.Uri.parse('file:///doc/api.md') as never
const storageRoot = vscode.Uri.parse('file:///global/storage') as never
function memIO() {
  const store = new Map<string, string>()
  const io: SidecarIO = { async read(u){return store.get(String(u))}, async write(u,c){store.set(String(u),c)}, async remove(u){store.delete(String(u))} }
  return { io, store }
}
function blocksFrom(texts: string[]): Block[] {
  let line = 0
  return texts.map((text, i) => { const b: Block = { paragraphIndex: i, startLine: line, endLine: line, text }; line += 2; return b })
}
const ids = () => { let n = 0; return () => `c${n++}` }

describe('comment migration', () => {
  it('sidecar → inline(after): sidecar removed, carrier written into .md', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush() // writes sidecar
    expect(store.size).toBe(1)
    // switch to inline-after
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(store.size).toBe(0) // sidecar cleared
    expect(source).toContain('Beta.\n\n<!-- rmt:comments')
    expect(parseInline(source).threads).toHaveLength(1)
  })

  it('inline(after) → sidecar: carrier stripped from .md, sidecar written', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new InlineAfterBackend(), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(source).toContain('rmt:comments')
    const prev = svc.currentBackend()
    svc.setBackend(new SidecarBackend(docUri, io))
    await svc.migrateFrom(prev)
    expect(source).not.toContain('rmt:comments') // .md cleaned
    expect(store.size).toBe(1) // sidecar written
  })

  it('empty comment set: sidecar → inline(after) is a no-op (no carrier, no sidecar, no throw)', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    // no comments added
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(source).toBe(original) // byte-identical: no carrier written
    expect(source).not.toContain('rmt:comments')
    expect(store.size).toBe(0) // no sidecar created
  })

  it('sidecar → inline(eof): sidecar removed, carrier appended at end-of-file', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush() // writes sidecar
    expect(store.size).toBe(1)
    const prev = svc.currentBackend()
    svc.setBackend(new InlineEofBackend())
    await svc.migrateFrom(prev)
    expect(store.size).toBe(0) // sidecar cleared
    expect(source).toContain('<!-- rmt:comments')
    expect(source.indexOf('Beta.')).toBeLessThan(source.indexOf('rmt:comments')) // carrier AFTER last paragraph
    expect(source.trimEnd().endsWith('-->')).toBe(true) // at end-of-file
    expect((source.match(/rmt:comments/g) ?? []).length).toBe(1)
    const parsed = parseInline(source)
    expect(parsed.threads).toHaveLength(1)
    expect(parsed.threads[0].comments[0].body).toBe('note')
  })

  it('sidecar → draft: sidecar removed, draft written, .md untouched', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    const prev = svc.currentBackend()
    svc.setBackend(new DraftBackend(docUri, storageRoot, io))
    await svc.migrateFrom(prev)
    expect(source).toBe(original) // the document is never touched by this mode
    expect(store.size).toBe(1)
    expect([...store.keys()][0]).toContain('/global/storage/') // …and the survivor is the draft
    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(1)
  })

  it('draft → sidecar: draft removed, sidecar written (materialise the draft)', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new DraftBackend(docUri, storageRoot, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    const prev = svc.currentBackend()
    svc.setBackend(new SidecarBackend(docUri, io))
    await svc.migrateFrom(prev)
    expect(store.size).toBe(1)
    expect([...store.keys()][0]).toContain('.comments.json') // the sidecar…
    expect([...store.keys()][0]).not.toContain('/global/storage/') // …not the draft
    expect(source).not.toContain('rmt:comments')
  })

  it('draft → inline(after): carrier written into .md, draft removed', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new DraftBackend(docUri, storageRoot, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(store.size).toBe(1)
    const prev = svc.currentBackend()
    svc.setBackend(new InlineAfterBackend())
    await svc.migrateFrom(prev)
    expect(source).toContain('Beta.\n\n<!-- rmt:comments')
    expect(parseInline(source).threads).toHaveLength(1)
    expect(store.size).toBe(0) // draft record gone
  })

  it('inline(after) → draft: carrier stripped from .md, draft written', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new InlineAfterBackend(), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(source).toContain('rmt:comments')
    const prev = svc.currentBackend()
    svc.setBackend(new DraftBackend(docUri, storageRoot, io))
    await svc.migrateFrom(prev)
    expect(source).not.toContain('rmt:comments')
    expect(store.size).toBe(1)
    expect((await new DraftBackend(docUri, storageRoot, io).load('')).threads).toHaveLength(1)
  })

  it('empty comment set: sidecar → draft creates no record and does not touch the .md', async () => {
    const { io, store } = memIO()
    let source = `Alpha.\n\nBeta.`
    const original = source
    const svc = new CommentsService(docUri, new SidecarBackend(docUri, io), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    const prev = svc.currentBackend()
    svc.setBackend(new DraftBackend(docUri, storageRoot, io))
    await svc.migrateFrom(prev)
    expect(source).toBe(original)
    expect(store.size).toBe(0)
  })

  it('inline(after) → inline(eof): carrier MOVES to EOF, not wiped', async () => {
    let source = `Alpha.\n\nBeta.`
    const svc = new CommentsService(docUri, new InlineAfterBackend(), ids(), () => 't', 1_000_000, () => source, async (t) => { source = t })
    await svc.load()
    svc.reanchor(blocksFrom(['Alpha.', 'Beta.']), source)
    svc.addComment(1, 'note')
    await svc.flush()
    expect(source).toContain('Beta.\n\n<!-- rmt:comments') // after-paragraph position
    const prev = svc.currentBackend()
    svc.setBackend(new InlineEofBackend())
    await svc.migrateFrom(prev)
    // carrier survived (NOT wiped) and moved to EOF; exactly one carrier; thread intact
    expect((source.match(/rmt:comments/g) ?? []).length).toBe(1)
    expect(parseInline(source).threads).toHaveLength(1)
    expect(parseInline(source).threads[0].comments[0].body).toBe('note')
  })
})
