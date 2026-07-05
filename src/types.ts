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

export type ProviderType = 'deepl' | 'google' | 'custom' | 'ollama'
export type TranslationMode = 'on-demand' | 'automatic'
export type CommentStorage = 'sidecar' | 'inline'
export type CommentPlacement = 'after-paragraph' | 'end-of-file'

export interface PluginConfig {
  targetLanguage: LanguageCode | undefined
  storageLanguage: LanguageCode
  translationMode: TranslationMode
  providerType: ProviderType
  customEndpoint: string | undefined
  /** Local Ollama server base URL (providerType === 'ollama'). */
  ollamaEndpoint: string | undefined
  /** Ollama model name (providerType === 'ollama'). */
  ollamaModel: string
  /** Terms that must never be translated (kept verbatim), req 3.18. */
  glossary: string[]
  commentStorage: CommentStorage
  commentPlacement: CommentPlacement
}

// ---------------------------------------------------------------------------
// Comments (req 11) — a block-anchored, sidecar-stored annotation layer.
// Comments are NEVER part of the .md; they live in `<name>.comments.json`.
// ---------------------------------------------------------------------------

/** A block of the current document, in document order (built from the lineMap). */
export interface Block {
  paragraphIndex: number
  startLine: number
  text: string
}

/**
 * Content anchor that survives edits to the original (req 11.4). `quote` is the
 * primary selector; `prefix`/`suffix` (adjacent block text) disambiguate ties;
 * `hintLine` is a non-authoritative position hint; `quoteHash` is a fast-equality
 * digest of `quote`. Re-anchoring prefers an orphan over a wrong match (req 11.9).
 */
export interface CommentAnchor {
  quote: string
  prefix: string
  suffix: string
  hintLine: number
  quoteHash: string
}

export interface Comment {
  id: string
  createdAt: string
  updatedAt: string
  author?: string
  body: string
}

/** One anchored block's thread (req: multiple comments per block). */
export interface CommentThread {
  anchor: CommentAnchor
  orphaned: boolean
  comments: Comment[]
}

/** Persisted sidecar shape. `docHash` enables a fast-path when the document is
 *  unchanged since the last save (trust each thread's `hintLine`). */
export interface CommentsFile {
  version: number
  docHash: string
  threads: CommentThread[]
}

/** Per-block comment count sent to the webview to draw the 💬 indicators. */
export interface BlockCommentCount {
  paragraphIndex: number
  count: number
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
  | { type: 'requestComments' }
  | { type: 'requestCommentThread'; paragraphIndex: number }
  | { type: 'addComment'; paragraphIndex: number; body: string }
  | { type: 'editComment'; commentId: string; body: string }
  | { type: 'deleteComment'; commentId: string }

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
  | { type: 'commentsForBlocks'; blocks: BlockCommentCount[] }
  | { type: 'commentThread'; paragraphIndex: number; comments: Comment[] }
  | { type: 'orphanedComments'; threads: Array<{ quote: string; comments: Comment[] }> }

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
  getOllamaEndpoint(): string | undefined
  getOllamaModel(): string
  getGlossary(): string[]
  getCommentStorage(): CommentStorage
  getCommentPlacement(): CommentPlacement
  /** Append a do-not-translate term to the Glossary setting (req 3.19). Resolves
   *  to true if it was added, false if blank or already present. */
  addGlossaryTerm(term: string): Promise<boolean>
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

/** Result of re-anchoring every thread against the current document (req 11). */
export interface ReanchorResult {
  /** Live threads: block index → comment count, for the webview indicators. */
  forBlocks: BlockCommentCount[]
  /** Threads whose anchored block could not be found (req 11.9), surfaced apart. */
  orphaned: Array<{ quote: string; comments: Comment[] }>
}

/**
 * Block-anchored comment store (req 11). Owns the `.comments.json` sidecar and
 * the content re-anchoring. `reanchor` caches the block context so `addComment`
 * can build an anchor without re-passing it. The `.md` is never mutated here.
 */
export interface ICommentsService {
  load(): Promise<void>
  reanchor(blocks: Block[], sourceText: string): ReanchorResult
  getThreadComments(paragraphIndex: number): Comment[]
  addComment(paragraphIndex: number, body: string): Comment | undefined
  editComment(commentId: string, body: string): void
  deleteComment(commentId: string): void
  flush(): Thenable<void>
}

export interface IPreviewController {
  onDocumentChange(document: vscode.TextDocument): void
  onWebviewMessage(message: WebviewMessage): void
  dispose(): void
}

export interface IActivationController {
  activate(context: vscode.ExtensionContext): void
  /** Returns the shutdown persist Thenable so the host can await it (req 9.6). */
  deactivate(): Thenable<void> | void
}
