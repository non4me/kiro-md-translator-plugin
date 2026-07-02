import type * as vscode from 'vscode'

/** BCP-47 language tag, e.g. "en", "ru", "zh". */
export type LanguageCode = string

export interface LanguageInfo {
  code: LanguageCode
  name: string
}

/** Maps a rendered block (paragraph/heading/list-item) index to its source line range. */
export interface LineMapping {
  paragraphIndex: number
  startLine: number
  endLine: number
}

export interface RenderResult {
  html: string
  lineMap: LineMapping[]
}

/** Structured, collision-safe cache key (NOT a `text + '::' + lang` concatenation). */
export interface CacheKey {
  text: string
  /** Target language of THIS translation: targetLang for forward, storageLang for reverse. */
  lang: LanguageCode
}

export interface CacheEntry {
  translation: string
  lastAccessed: number
}

export type ProviderType = 'deepl' | 'google' | 'custom'
export type TranslationMode = 'on-demand' | 'automatic'

export interface PluginConfig {
  targetLanguage: LanguageCode | undefined
  storageLanguage: LanguageCode
  translationMode: TranslationMode
  providerType: ProviderType
  customEndpoint: string | undefined
}

/** Messages Webview → Extension Host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'dblclick' }
  | { type: 'translateRequest' }
  | { type: 'paragraphHover'; paragraphIndex: number }
  | { type: 'paragraphHoverEnd'; paragraphIndex: number }
  | { type: 'editParagraph'; paragraphIndex: number }
  | { type: 'saveParagraph'; paragraphIndex: number; storageText: string; targetText: string }
  | { type: 'modalSyncRequest'; field: 'storage' | 'target'; text: string }
  | { type: 'cancelParagraphEdit' }
  | { type: 'scrollChanged'; topParagraphIndex: number }
  | { type: 'saveTranslation' }
  | { type: 'displayModeChanged'; displaying: 'source' | 'translation' }

/** Messages Extension Host → Webview. */
export type ExtensionMessage =
  | { type: 'renderContent'; html: string; lineMap: LineMapping[]; display?: boolean }
  | { type: 'translationStart' }
  | { type: 'translationComplete'; translatedHtml: string }
  | { type: 'translationError'; code: number; message: string }
  | { type: 'showTooltip'; paragraphIndex: number; reverseTranslation: string }
  | { type: 'tooltipLoading'; paragraphIndex: number }
  | { type: 'tooltipError'; paragraphIndex: number; message: string }
  | { type: 'hideTooltip' }
  | { type: 'openEditModal'; paragraphIndex: number; storageText: string; targetText: string }
  | { type: 'editModalSyncStart'; field: 'storage' | 'target' }
  | { type: 'editModalSyncComplete'; field: 'storage' | 'target'; text: string }
  | { type: 'editModalSyncError'; field: 'storage' | 'target'; message: string }
  | { type: 'editorScrollSync'; paragraphIndex: number }
  | {
      type: 'updateButtonState'
      translateEnabled: boolean
      mode: TranslationMode
      storageLang: LanguageCode
      targetLang: LanguageCode | undefined
    }
  | { type: 'memoryWarning'; level: 'large-file' | 'high-memory' }

export type ErrorCode =
  | 'RENDER_TIMEOUT'
  | 'TRANSLATION_HTTP_ERROR'
  | 'TRANSLATION_EMPTY_RESPONSE'
  | 'TRANSLATION_TIMEOUT'
  | 'EXPORT_WRITE_FAILED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'INVALID_ENDPOINT_URL'
  | 'LANGUAGE_LOAD_FAILED'

export interface PluginError {
  code: ErrorCode
  message: string
  httpStatus?: number
}

/** Throwable typed error so controllers can branch on `code`/`httpStatus`. */
export class TranslatorError extends Error implements PluginError {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'TranslatorError'
  }
}

// ---------------------------------------------------------------------------
// Component interfaces
// ---------------------------------------------------------------------------

export interface IMarkdownRenderer {
  render(markdown: string, fileDir: vscode.Uri): Promise<RenderResult>
  cancel(documentUri: string): void
}

export interface ITranslationCache {
  get(sourceText: string, lang: LanguageCode): string | undefined
  set(sourceText: string, lang: LanguageCode, translation: string): void
  clear(): void
  readonly size: number
}

export interface ITranslationProvider {
  readonly id: string
  readonly displayName: string
  translateBatch(
    segments: string[],
    sourceLang: LanguageCode | 'auto',
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string[]>
  /** `direction` lets a provider return a different set for source vs target
   *  (DeepL rejects regional codes like EN-US as source_lang). Providers whose
   *  source and target sets are identical may ignore it. */
  getSupportedLanguages(direction?: 'source' | 'target'): Promise<LanguageInfo[]>
  testConnection(): Promise<void>
}

export interface ITranslationEngine {
  /** Translate the document and return display HTML (mdast→hast→HTML, no round-trip). */
  translate(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
    fileDir: vscode.Uri,
  ): Promise<RenderResult>
  translateParagraph(
    text: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string>
  /** Translate and serialize back to Markdown — export path only (req 6.3). */
  translateToMarkdown(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string>
  /** Surgically replace ONLY one paragraph's source range (req 7.14). */
  replaceParagraphInSource(
    source: string,
    lineMap: LineMapping[],
    paragraphIndex: number,
    newStorageText: string,
  ): string
}

export interface ISettingsManager {
  getConfig(): PluginConfig
  getTargetLanguage(): LanguageCode | undefined
  getStorageLanguage(): LanguageCode
  getTranslationMode(): TranslationMode
  getProviderType(): ProviderType
  getCustomEndpoint(): string | undefined
  onDidChangeSettings(handler: () => void): vscode.Disposable
}

export interface ISecretManager {
  saveApiKey(provider: ProviderType, key: string): Promise<void>
  getApiKey(provider: ProviderType): Promise<string | undefined>
  deleteApiKey(provider: ProviderType): Promise<void>
}

export interface IExportService {
  exportTranslation(
    translatedMarkdown: string,
    originalUri: vscode.Uri,
    targetLang: LanguageCode,
  ): Promise<void>
}

export interface IPreviewController {
  onDocumentChange(document: vscode.TextDocument): void
  onWebviewMessage(message: WebviewMessage): void
  dispose(): void
}

export interface IActivationController {
  activate(context: vscode.ExtensionContext): void
  deactivate(): void
}
