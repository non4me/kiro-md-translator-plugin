import type { ITranslationProvider, PluginConfig } from '../types'
import { TranslatorError } from '../types'
import { DeepLProvider } from './DeepLProvider'
import { GoogleTranslateProvider } from './GoogleTranslateProvider'
import { CustomHttpProvider } from './CustomHttpProvider'
import { OllamaProvider } from './OllamaProvider'

/** Selects the concrete provider for the active configuration (req 4.1, 4.15). */
export function createProvider(config: PluginConfig, apiKey: string): ITranslationProvider {
  switch (config.providerType) {
    case 'deepl':
      return new DeepLProvider(apiKey)
    case 'google':
      return new GoogleTranslateProvider(apiKey)
    case 'custom':
      return new CustomHttpProvider(apiKey, config.customEndpoint ?? '')
    case 'ollama':
      // Keyless local provider; apiKey is ignored.
      return new OllamaProvider(
        config.ollamaEndpoint || 'http://localhost:11434',
        config.ollamaModel || 'llama3.1',
      )
    default:
      throw new TranslatorError('INVALID_ENDPOINT_URL', `Unknown provider: ${config.providerType}`)
  }
}
