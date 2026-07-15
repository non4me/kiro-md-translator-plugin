import { describe, it, expect, vi } from 'vitest'
import { PreviewController, type PreviewDeps } from '../src/PreviewController'
import type { IAssistantProvider } from '../src/assistant/types'

function fake(reply: string): IAssistantProvider {
  return { id: 'ollama', displayName: 'x', async *chat() { yield reply }, async testConnection() {} }
}
function deps(over: Partial<PreviewDeps>): PreviewDeps {
  return {
    post: vi.fn(),
    renderer: { render: async (md: string) => ({ html: `<p>${md}</p>`, lineMap: [] }) } as never,
    engine: {} as never,
    cache: { get: () => undefined, set: () => {}, clear: () => {}, size: 0 } as never,
    settings: { getConfig: () => ({ targetLanguage: 'ru', storageLanguage: 'en' }) } as never,
    exportService: {} as never,
    getDocumentText: () => 'Block one source.\n\nBlock two.',
    getDocumentUri: () => ({ toString: () => 'file:///d.md' }) as never,
    aiAssistant: () => ({ enabled: true, provider: 'ollama', model: 'm', endpoint: '', systemPrompt: '', reuseTranslationProvider: true }),
    buildAssistantProvider: () => fake('Hello.'),
    commentsService: { getThreads: () => [], addComment: vi.fn(() => ({ id: 'c1' })), reanchor: () => ({ forBlocks: [], orphaned: [] }) } as never,
    ...over,
  }
}

describe('PreviewController — AI Assistant', () => {
  it('opens a session and posts assistantOpen', async () => {
    const post = vi.fn()
    const c = new PreviewController(deps({ post }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(post.mock.calls.some((c) => c[0].type === 'assistantOpen')).toBe(true)
  })

  it('save summary adds a comment and closes', async () => {
    const addComment = vi.fn(() => ({ id: 'c1' }))
    const post = vi.fn()
    const c = new PreviewController(deps({ post, commentsService: { getThreads: () => [], addComment, reanchor: () => ({ forBlocks: [], orphaned: [] }) } as never }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSaveSummary' } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(addComment).toHaveBeenCalled()
    expect(post.mock.calls.some((c) => c[0].type === 'assistantClosed')).toBe(true)
  })
})
