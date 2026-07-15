import { describe, it, expect } from 'vitest'
import { MemSecretStorage } from './mocks/vscode'
import { AssistantSecretManager } from '../src/AssistantSecretManager'

describe('AssistantSecretManager', () => {
  it('stores under the aiAssistant namespace, isolated from translation keys', async () => {
    const store = new MemSecretStorage()
    const m = new AssistantSecretManager(store as never)
    await m.saveKey('openai', 'sk-123')
    expect(await m.getKey('openai')).toBe('sk-123')
    // Never collides with a translation key of the same-named provider.
    expect(await (store as any).get('kiro-md-translator.apiKey.openai')).toBeUndefined()
    expect(await (store as any).get('kiro-md-translator.apiKey.aiAssistant.openai')).toBe('sk-123')
  })

  it('deletes a key', async () => {
    const m = new AssistantSecretManager(new MemSecretStorage() as never)
    await m.saveKey('anthropic', 'x')
    await m.deleteKey('anthropic')
    expect(await m.getKey('anthropic')).toBeUndefined()
  })
})
