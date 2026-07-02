import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { SecretManager } from '../src/SecretManager'
import { MemSecretStorage, workspace } from './mocks/vscode'

describe('SecretManager', () => {
  it('round-trips a per-provider key through SecretStorage', async () => {
    const s = new SecretManager(new MemSecretStorage() as never)
    await s.saveApiKey('deepl', 'k1')
    expect(await s.getApiKey('deepl')).toBe('k1')
    await s.deleteApiKey('deepl')
    expect(await s.getApiKey('deepl')).toBeUndefined()
  })

  it('keeps each provider key in its own slot', async () => {
    const s = new SecretManager(new MemSecretStorage() as never)
    await s.saveApiKey('deepl', 'd-key')
    await s.saveApiKey('google', 'g-key')
    expect(await s.getApiKey('deepl')).toBe('d-key')
    expect(await s.getApiKey('google')).toBe('g-key')
    expect(await s.getApiKey('custom')).toBeUndefined()
  })

  it('migrates a legacy single-slot key into the active provider slot, once', async () => {
    const store = new MemSecretStorage()
    await store.store('kiro-md-translator.apiKey', 'legacy-key') // pre-per-provider key
    const s = new SecretManager(store as never)
    await s.migrateLegacyKey('deepl')
    expect(await s.getApiKey('deepl')).toBe('legacy-key')
    expect(await store.get('kiro-md-translator.apiKey')).toBeUndefined() // legacy cleared
    // A second run is a no-op and never clobbers an existing per-provider key.
    await s.saveApiKey('deepl', 'new-key')
    await s.migrateLegacyKey('deepl')
    expect(await s.getApiKey('deepl')).toBe('new-key')
  })

  // Feature: kiro-md-translator-plugin, Property 8: API key never passes through the plaintext-config write path
  it('Property 8: never touches workspace configuration', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (key) => {
        const spy = vi.spyOn(workspace, 'getConfiguration')
        const s = new SecretManager(new MemSecretStorage() as never)
        await s.saveApiKey('deepl', key)
        expect(spy).not.toHaveBeenCalled()
        expect(await s.getApiKey('deepl')).toBe(key)
        spy.mockRestore()
      }),
      { numRuns: 100 },
    )
  })
})
