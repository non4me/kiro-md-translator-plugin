import { describe, it, expect, vi } from 'vitest'
import { PreviewController, type PreviewDeps } from '../src/PreviewController'
import type { IAssistantProvider } from '../src/assistant/types'
import { TranslatorError } from '../src/types'

function fake(reply: string): IAssistantProvider {
  return { id: 'ollama', displayName: 'x', async *chat() { yield reply }, async testConnection() {} }
}

// Chunks with a 3-char window that NEVER drops newlines (`.` in a regex excludes `\n`,
// which would corrupt a multi-line ```rmt-edit fence). Mirrors how a real streaming
// provider would split a reply containing a fenced edit block.
function fakeChunked(reply: string): IAssistantProvider {
  return {
    id: 'ollama',
    displayName: 'x',
    async *chat() {
      for (const chunk of reply.match(/[\s\S]{1,3}/g) ?? []) yield chunk
    },
    async testConnection() {},
  }
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

  it('askAiApply posts openEditModal pre-filled with the assistant last edit', async () => {
    const post = vi.fn()
    const reply = 'Here you go.\n\n```rmt-edit\nNew paragraph text.\n```\n'
    const c = new PreviewController(deps({ post, buildAssistantProvider: () => fakeChunked(reply) }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)

    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSend', text: 'Rewrite this' } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiApply' } as never)

    const applyPost = post.mock.calls.find((call) => call[0].type === 'openEditModal')
    expect(applyPost).toBeDefined()
    expect(applyPost?.[0]).toMatchObject({ paragraphIndex: 0, lastIndex: 0, storageText: 'New paragraph text.' })
  })

  it('askAiApply is a no-op when the assistant has no edit to apply', async () => {
    const post = vi.fn()
    const c = new PreviewController(deps({ post, buildAssistantProvider: () => fake('Just a plain answer, no edit.') }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)

    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSend', text: 'Explain this' } as never)
    await new Promise((r) => setTimeout(r, 0))
    post.mockClear()
    c.onWebviewMessage({ type: 'askAiApply' } as never)

    expect(post.mock.calls.some((call) => call[0].type === 'openEditModal')).toBe(false)
  })

  it('re-opening the dialog cancels a still-streaming prior session (no stale-stream cross-talk)', async () => {
    const post = vi.fn()
    let firstAborted = false
    let resumeFirst: (() => void) | undefined
    const firstProvider: IAssistantProvider = {
      id: 'ollama',
      displayName: 'x',
      async *chat(_messages, signal) {
        signal.addEventListener('abort', () => { firstAborted = true })
        await new Promise<void>((resolve) => { resumeFirst = resolve })
        if (signal.aborted) return // real providers stop yielding once aborted
        yield 'late chunk from the abandoned first session'
      },
      async testConnection() {},
    }
    let opens = 0
    const c = new PreviewController(deps({
      post,
      buildAssistantProvider: () => {
        opens += 1
        return opens === 1 ? firstProvider : fake('Second session reply.')
      },
    }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)

    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSend', text: 'hi' } as never)
    await new Promise((r) => setTimeout(r, 0)) // first session's chat() is now suspended awaiting resumeFirst

    // Re-open while the first session is still streaming.
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block two', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(firstAborted).toBe(true) // re-opening tore down the abandoned session

    // Let the abandoned session's generator resume; its late chunk must never surface.
    resumeFirst?.()
    await new Promise((r) => setTimeout(r, 0))

    const lateChunk = post.mock.calls.some(
      (call) => call[0].type === 'assistantChunk' && call[0].text === 'late chunk from the abandoned first session',
    )
    expect(lateChunk).toBe(false)
  })

  it('M-1: a failed re-open leaves no stale session — a later askAiSend does not drive it', async () => {
    const post = vi.fn()
    const chatCalls: string[] = []
    const firstProvider: IAssistantProvider = {
      id: 'ollama',
      displayName: 'x',
      async *chat(messages) { chatCalls.push('first'); yield 'first reply' },
      async testConnection() {},
    }
    let opens = 0
    const c = new PreviewController(deps({
      post,
      buildAssistantProvider: () => {
        opens += 1
        if (opens === 1) return firstProvider
        throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for OpenAI')
      },
    }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)

    // First open succeeds and binds a session to selection "Block one".
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(post.mock.calls.some((call) => call[0].type === 'assistantOpen')).toBe(true)

    // Re-open for a new selection fails to build a provider — the old session must not survive.
    post.mockClear()
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block two', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(post.mock.calls.some((call) => call[0].type === 'assistantError')).toBe(true)

    // A later send must not revive the stale (cancelled) first session.
    c.onWebviewMessage({ type: 'askAiSend', text: 'hi' } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(chatCalls).toEqual([])
  })

  // --- req 17: error-message wording (routed through t()) -----------------

  const openAndError = (post: ReturnType<typeof vi.fn>): string | undefined => {
    const call = post.mock.calls.find((c) => c[0].type === 'assistantError')
    return call?.[0].message as string | undefined
  }

  it('17.1: an unconfigured provider posts "AI Assistant not configured"', async () => {
    const post = vi.fn()
    const c = new PreviewController(deps({ post, buildAssistantProvider: () => undefined }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(openAndError(post)).toBe('AI Assistant not configured')
  })

  it('17.2: a missing API key surfaces "API key required for <provider>"', async () => {
    const post = vi.fn()
    const c = new PreviewController(deps({
      post,
      buildAssistantProvider: () => { throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for OpenAI') },
    }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(openAndError(post)).toBe('API key required for OpenAI')
  })

  it('17.5: a transport failure surfaces "Connection failed: <reason>"', async () => {
    const post = vi.fn()
    const c = new PreviewController(deps({
      post,
      buildAssistantProvider: () => { throw new TranslatorError('TRANSLATION_HTTP_ERROR', 'HTTP 503') },
    }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(openAndError(post)).toBe('Connection failed: HTTP 503')
  })

  it('17.7: a failed apply surfaces "Failed to apply changes: <reason>"', async () => {
    const reply = 'Here you go.\n\n```rmt-edit\nNew paragraph text.\n```\n'
    const post = vi.fn((m: { type: string }) => {
      if (m.type === 'openEditModal') throw new Error('webview disposed')
    })
    const c = new PreviewController(deps({ post: post as never, buildAssistantProvider: () => fakeChunked(reply) }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSend', text: 'Rewrite this' } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiApply' } as never)
    expect(openAndError(post)).toBe('Failed to apply changes: webview disposed')
  })

  it('17.8: a failed comment save surfaces "Failed to save summary as comment: <reason>"', async () => {
    const post = vi.fn()
    const addComment = vi.fn(() => { throw new Error('disk full') })
    const c = new PreviewController(deps({
      post,
      commentsService: { getThreads: () => [], addComment, reanchor: () => ({ forBlocks: [], orphaned: [] }) } as never,
    }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSaveSummary' } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(openAndError(post)).toBe('Failed to save summary as comment: disk full')
  })
})
