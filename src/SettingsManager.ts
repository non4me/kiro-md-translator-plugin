import * as vscode from 'vscode'
import type {
  CommentPlacement,
  CommentStorage,
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

  getOllamaEndpoint(): string | undefined {
    const value = this.cfg().get<string>('ollamaEndpoint', '')
    return value ? value : undefined
  }

  getOllamaModel(): string {
    return this.cfg().get<string>('ollamaModel', 'llama3.1') || 'llama3.1'
  }

  getCommentStorage(): CommentStorage {
    return this.cfg().get<CommentStorage>('commentStorage', 'sidecar')
  }

  getCommentPlacement(): CommentPlacement {
    return this.cfg().get<CommentPlacement>('commentPlacement', 'after-paragraph')
  }

  getCommentAutoImport(): boolean {
    return this.cfg().get<boolean>('commentAutoImport', true)
  }

  getCommentsEnabled(): boolean {
    return this.cfg().get<boolean>('commentsEnabled', true)
  }

  /** Do-not-translate terms (req 3.18). Blank/whitespace entries are dropped. */
  getGlossary(): string[] {
    const value = this.cfg().get<string[]>('glossary', [])
    return Array.isArray(value) ? value.filter((t) => typeof t === 'string' && t.trim().length > 0) : []
  }

  /**
   * Append a term to the Glossary do-not-translate list (req 3.19). Persists to
   * the workspace scope when a workspace is open, else globally. A blank or
   * already-present term is a no-op. The resulting config change fires
   * `onDidChangeSettings`, which invalidates the cache and re-translates (req 9.5).
   */
  async addGlossaryTerm(term: string): Promise<boolean> {
    const t = term.trim()
    if (!t) return false
    const current = this.getGlossary()
    if (current.includes(t)) return false
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global
    await this.cfg().update('glossary', [...current, t], target)
    return true
  }

  getConfig(): PluginConfig {
    return {
      targetLanguage: this.getTargetLanguage(),
      storageLanguage: this.getStorageLanguage(),
      translationMode: this.getTranslationMode(),
      providerType: this.getProviderType(),
      customEndpoint: this.getCustomEndpoint(),
      ollamaEndpoint: this.getOllamaEndpoint(),
      ollamaModel: this.getOllamaModel(),
      glossary: this.getGlossary(),
      commentStorage: this.getCommentStorage(),
      commentPlacement: this.getCommentPlacement(),
      commentAutoImport: this.getCommentAutoImport(),
    }
  }

  onDidChangeSettings(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) handler()
    })
  }
}
