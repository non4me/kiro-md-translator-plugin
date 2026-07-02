import * as vscode from 'vscode'
import type {
  ISettingsManager,
  LanguageCode,
  PluginConfig,
  ProviderType,
  TranslationMode,
} from './types'

const SECTION = 'kiro-md-translator'

export class SettingsManager implements ISettingsManager {
  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION)
  }

  getStorageLanguage(): LanguageCode {
    return this.cfg().get<string>('storageLanguage', 'en') || 'en'
  }

  /** Undefined when unset (req 4.12) — empty config string maps to undefined. */
  getTargetLanguage(): LanguageCode | undefined {
    const value = this.cfg().get<string>('targetLanguage', '')
    return value ? value : undefined
  }

  getTranslationMode(): TranslationMode {
    return this.cfg().get<TranslationMode>('translationMode', 'on-demand')
  }

  getProviderType(): ProviderType {
    return this.cfg().get<ProviderType>('providerType', 'deepl')
  }

  getCustomEndpoint(): string | undefined {
    const value = this.cfg().get<string>('customEndpoint', '')
    return value ? value : undefined
  }

  getConfig(): PluginConfig {
    return {
      targetLanguage: this.getTargetLanguage(),
      storageLanguage: this.getStorageLanguage(),
      translationMode: this.getTranslationMode(),
      providerType: this.getProviderType(),
      customEndpoint: this.getCustomEndpoint(),
    }
  }

  onDidChangeSettings(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) handler()
    })
  }
}
