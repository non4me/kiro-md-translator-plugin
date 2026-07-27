import { describe, it, expect } from 'vitest'
import { createAssistantProvider } from '../src/assistant/AssistantProviderFactory'
import { ASSISTANT_PROVIDER_LABEL } from '../src/ActivationController'
import type { AiAssistantConfig, AssistantProviderType } from '../src/assistant/types'
import type { PluginConfig } from '../src/types'

const TRANSLATION = { providerType: 'deepl' } as unknown as PluginConfig

function build(provider: AssistantProviderType) {
  const cfg = { provider, model: '', endpoint: '', reuseTranslationProvider: false } as AiAssistantConfig
  return createAssistantProvider(cfg, 'dummy-key', TRANSLATION)
}

describe('assistant provider labels', () => {
  // Two parallel sources of a provider's name exist: the class field and the map the
  // toasts read. They drifted — 'Google Gemini' vs 'Google', 'VS Code Copilot' vs
  // 'GitHub Copilot Chat' — so the connection-test toast and the provider disagreed
  // about what the user had selected. Pin every provider, not just the two that broke.
  const ids = Object.keys(ASSISTANT_PROVIDER_LABEL) as AssistantProviderType[]

  it.each(ids)('%s: displayName matches the label used in toasts', (id) => {
    expect(build(id).displayName).toBe(ASSISTANT_PROVIDER_LABEL[id])
  })

  it('every provider the factory supports has a label (no silent fallback to the raw id)', () => {
    expect(ids).toEqual(['ollama', 'openai', 'anthropic', 'google', 'vscode-copilot'])
    for (const id of ids) expect(ASSISTANT_PROVIDER_LABEL[id]).not.toBe(id)
  })

  it('the key-required message names the provider by the same label (req 17.2)', () => {
    // GoogleAssistant is the one that carried the mismatched literal; its own error
    // already said 'Google', which is why the class field was the wrong side to keep.
    expect(() => build('google')).not.toThrow()
    const cfg = { provider: 'google', model: '', endpoint: '', reuseTranslationProvider: false } as AiAssistantConfig
    expect(() => createAssistantProvider(cfg, '', TRANSLATION)).toThrow(
      `API key required for ${ASSISTANT_PROVIDER_LABEL.google}`,
    )
  })
})
