import { describe, it, expect, vi } from 'vitest'
import { AssistantSession } from '../src/assistant/AssistantSession'
import type { IAssistantProvider } from '../src/assistant/types'

function fakeProvider(reply: string): IAssistantProvider {
  return {
    id: 'ollama', displayName: 'x',
    // [\s\S] (not `.`) so chunking doesn't silently drop newlines from the scripted reply.
    async *chat() { for (const ch of reply.match(/[\s\S]{1,3}/g) ?? []) yield ch },
    async testConnection() {},
  }
}

describe('AssistantSession', () => {
  it('streams chunks then posts a rendered reply, flags canApply on an rmt-edit fence', async () => {
    const posts: any[] = []
    const s = new AssistantSession({
      provider: fakeProvider('Here:\n```rmt-edit\nNEW\n```'),
      initial: [{ role: 'system', content: 'S' }, { role: 'user', content: 'ctx' }],
      post: (m) => posts.push(m),
      renderMarkdown: async (md) => `<html>${md}</html>`,
    })
    await s.ask('why?')
    expect(posts.filter((p) => p.type === 'assistantChunk').length).toBeGreaterThan(0)
    const reply = posts.find((p) => p.type === 'assistantReply')
    expect(reply.canApply).toBe(true)
    expect(s.lastEdit()).toBe('NEW')
  })

  it('canApply is false without an edit fence', async () => {
    const posts: any[] = []
    const s = new AssistantSession({
      provider: fakeProvider('Just an explanation.'),
      initial: [{ role: 'system', content: 'S' }, { role: 'user', content: 'c' }],
      post: (m) => posts.push(m),
      renderMarkdown: async (md) => md,
    })
    await s.ask('q')
    expect(posts.find((p) => p.type === 'assistantReply').canApply).toBe(false)
    expect(s.lastEdit()).toBeUndefined()
  })

  // Finding I-1: a cancelled turn must stay silent — no assistantError, no partial
  // history — instead of cross-talking a stale error into a re-opened dialog. Real
  // providers (fetch's `reader.read()`, IdeAssistant's CancellationTokenSource) THROW
  // on abort rather than returning cleanly, so the fake here must too or the test
  // gives false confidence (a clean-return fake never exercises the catch block).
  function abortingProvider(): IAssistantProvider {
    return {
      id: 'ollama', displayName: 'x',
      async *chat(_messages, signal): AsyncIterable<string> {
        yield 'partial '
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      },
      async testConnection() {},
    }
  }

  /** First call blocks until aborted (throws AbortError, like `abortingProvider`);
   *  every later call resolves normally — models a superseding second turn. */
  function abortThenSucceedProvider(reply: string): IAssistantProvider {
    let calls = 0
    return {
      id: 'ollama', displayName: 'x',
      async *chat(_messages, signal): AsyncIterable<string> {
        calls += 1
        if (calls === 1) {
          yield 'partial '
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
          return
        }
        yield reply
      },
      async testConnection() {},
    }
  }

  it('cancel() during a still-streaming ask() posts no assistantError (I-1)', async () => {
    const posts: any[] = []
    const s = new AssistantSession({
      provider: abortingProvider(),
      initial: [{ role: 'system', content: 'S' }],
      post: (m) => posts.push(m),
      renderMarkdown: async (md) => md,
    })
    const pending = s.ask('why?')
    await new Promise((r) => setTimeout(r, 0)) // let the first chunk land, then cancel mid-stream
    s.cancel()
    await pending
    expect(posts.some((p) => p.type === 'assistantError')).toBe(false)
    expect(posts.some((p) => p.type === 'assistantReply')).toBe(false)
  })

  it('a superseding ask() aborts the prior turn without posting assistantError for it (I-1)', async () => {
    const posts: any[] = []
    const s = new AssistantSession({
      provider: abortThenSucceedProvider('Second reply.'),
      initial: [{ role: 'system', content: 'S' }],
      post: (m) => posts.push(m),
      renderMarkdown: async (md) => md,
    })
    const first = s.ask('first?')
    await new Promise((r) => setTimeout(r, 0))
    const second = s.ask('second?') // supersedes the first turn, aborting it
    await Promise.all([first, second])
    expect(posts.some((p) => p.type === 'assistantError')).toBe(false)
    expect(posts.filter((p) => p.type === 'assistantReply')).toHaveLength(1)
    expect(posts.find((p) => p.type === 'assistantReply').html).toBe('Second reply.')
  })
})
