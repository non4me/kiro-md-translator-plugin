import { TranslatorError, type PluginConfig } from '../types'
import type { AiAssistantConfig, IAssistantProvider } from './types'
import { OllamaAssistant } from './OllamaAssistant'
import { OpenAIAssistant } from './OpenAIAssistant'
import { AnthropicAssistant } from './AnthropicAssistant'
import { GoogleAssistant } from './GoogleAssistant'
import { IdeAssistant } from './IdeAssistant'

/** Build the assistant provider for the active config (req 2). When
 *  `reuseTranslationProvider` is on AND translation is Ollama, borrow its
 *  endpoint+model so the user configures Ollama once (req 2.2). */
export function createAssistantProvider(
  config: AiAssistantConfig,
  apiKey: string,
  translation: PluginConfig,
): IAssistantProvider {
  const reuseOllama = config.reuseTranslationProvider && translation.providerType === 'ollama'
  switch (config.provider) {
    case 'ollama':
      return new OllamaAssistant(
        reuseOllama ? translation.ollamaEndpoint || 'http://localhost:11434' : config.endpoint || 'http://localhost:11434',
        reuseOllama ? translation.ollamaModel || 'llama3.1' : config.model || 'llama3.1',
      )
    case 'openai':
      return new OpenAIAssistant(apiKey, config.model || 'gpt-4o-mini')
    case 'anthropic':
      return new AnthropicAssistant(apiKey, config.model || 'claude-3-5-sonnet-latest')
    case 'google':
      return new GoogleAssistant(apiKey, config.model || 'gemini-1.5-flash')
    case 'vscode-copilot':
    // Assumes Kiro surfaces its models through `vscode.lm` like VS Code Copilot does;
    // this is a Stage-0 spike result (F5 in Kiro vs VS Code), not directly verifiable
    // here. If a manual spike disproves it, only this `kiro-ide` case changes.
    case 'kiro-ide':
      return new IdeAssistant(config.provider, config.model || undefined)
    default:
      throw new TranslatorError('INVALID_ENDPOINT_URL', `Unsupported assistant provider: ${config.provider}`)
  }
}
