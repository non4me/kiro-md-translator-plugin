import type { ITranslationProvider, PluginConfig } from '../types'
import { TranslatorError } from '../types'
import { DeepLProvider } from './DeepLProvider'
import { GoogleTranslateProvider } from './GoogleTranslateProvider'
import { CustomHttpProvider } from './CustomHttpProvider'

/** Selects the concrete provider for the active configuration (req 4.1). */
export function createProvider(config: PluginConfig, apiKey: string): ITranslationProvider {
  switch (config.providerType) {
    case 'deepl':
      return new DeepLProvider(apiKey)
    case 'google':
      return new GoogleTranslateProvider(apiKey)
    case 'custom':
      return new CustomHttpProvider(apiKey, config.customEndpoint ?? '')
    default:
      throw new TranslatorError('INVALID_ENDPOINT_URL', `Unknown provider: ${config.providerType}`)
  }
}
