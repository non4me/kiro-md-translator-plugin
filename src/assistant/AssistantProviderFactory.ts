import { TranslatorError, type PluginConfig } from '../types'
import type { AiAssistantConfig, IAssistantProvider } from './types'
import { OllamaAssistant } from './OllamaAssistant'
import { OpenAIAssistant } from './OpenAIAssistant'

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
    default:
      throw new TranslatorError('INVALID_ENDPOINT_URL', `Unsupported assistant provider: ${config.provider}`)
  }
}
