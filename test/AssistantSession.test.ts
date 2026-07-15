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
})
