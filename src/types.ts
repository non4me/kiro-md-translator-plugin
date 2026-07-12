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
export type CommentStorage = 'sidecar' | 'inline' | 'draft'
export type CommentPlacement = 'after-paragraph' | 'end-of-file'
/** Code-block syntax highlighting theme (req 12). `auto` follows the editor's
 *  light/dark theme; `off` disables colouring; the rest are named highlight.js themes. */
export type CodeHighlightTheme =
  | 'auto'
  | 'off'
  | 'github-dark'
  | 'github-light'
  | 'monokai'
  | 'nord'
  | 'atom-one-dark'
  | 'dracula'
  | 'solarized-light'

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
  /** Merge comments left in the other storages into the selected one on open (req 11.17). */
  commentAutoImport: boolean
  /** Syntax-highlighting theme for code blocks (req 12). Default 'auto'. */
  codeHighlightTheme: CodeHighlightTheme
}

// ---------------------------------------------------------------------------
// Comments (req 11) — a block-anchored, sidecar-stored annotation layer.
// Comments are NEVER part of the .md; they live in `<name>.comments.json`.
// ---------------------------------------------------------------------------

/** A block of the current document, in document order (built from the lineMap). */
export interface Block {
  paragraphIndex: number
  startLine: number
  endLine: number
  text: string
}

/**
 * A comment bound to a text FRAGMENT within its block (affordance redesign,
 * stage 3). `quote` is the trimmed selected text; `prefix`/`suffix` are the block
 * text immediately around it, to disambiguate a fragment that repeats in the block.
 * Absent on a whole-block comment — its absence IS backward compatibility: an old
 * anchor has no fragment and resolves to the entire block.
 */
export interface FragmentAnchor {
  quote: string
  prefix: string
  suffix: string
}

/**
 * Content anchor that survives edits to the original (req 11.4). `quote` is the
 * primary selector (the BLOCK's text — this is what finds the block); `prefix`/`suffix`
 * (adjacent block text) disambiguate ties; `hintLine` is a non-authoritative position
 * hint; `quoteHash` is a fast-equality digest of `quote`. `fragment`, when present,
 * pins the comment to a sub-span of that block. Re-anchoring prefers an orphan over a
 * wrong match (req 11.9).
 */
export interface CommentAnchor {
  quote: string
  prefix: string
  suffix: string
  hintLine: number
  quoteHash: string
  fragment?: FragmentAnchor
  /** Present ⇒ a MULTI-BLOCK comment (req 10.17). The primary anchor above pins the FIRST
   *  block (its `fragment` is the selected tail of that block); `end` pins the LAST block
   *  (its `fragment` is the selected head). Everything between is the span. */
  end?: SpanEnd
}

/** The far end of a multi-block comment: the last block's own content anchor plus the
 *  fragment (the selection's head within it). Same shape as a block anchor, resolved by
 *  the same `matchThread`/`locateFragment` machinery. */
export interface SpanEnd {
  quote: string
  prefix: string
  suffix: string
  hintLine: number
  quoteHash: string
  fragment: FragmentAnchor
}

/** A resolved multi-block span: the first and last block it now covers (start < end).
 *  Undefined from `resolveSpan` means orphaned — never a partial or inverted span. */
export interface ResolvedSpan {
  startIndex: number
  endIndex: number
}

/** Where a thread resolves in the current document: the block and, for a fragment
 *  comment, the character span within that block's text (start..end). */
export interface ResolvedLocation {
  paragraphIndex: number
  start: number
  end: number
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

/** Per-block comment count sent to the webview to draw the comment markers. `fragments`
 *  carries the quote of each fragment thread on the block, so the webview can paint a
 *  highlight over the exact text each comment points at (stage 3). */
export interface BlockCommentCount {
  paragraphIndex: number
  count: number
  fragments?: string[]
  /** True for a block that lies WHOLLY inside a multi-block span (req 10.17) — the webview
   *  highlights the entire block, with no marker (its `count` is 0). */
  whole?: boolean
}

/** One thread on a block, for the group popover (stage 4): the fragment it points at
 *  (undefined = the whole block) and its comments. */
export interface ThreadView {
  fragment?: string
  comments: Comment[]
}

/** Messages Webview → Extension Host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'dblclick' }
  | { type: 'translateRequest' }
  | { type: 'paragraphHover'; paragraphIndex: number }
  | { type: 'paragraphHoverEnd'; paragraphIndex: number }
  | { type: 'editParagraph'; paragraphIndex: number; lastIndex?: number }
  | { type: 'saveParagraph'; paragraphIndex: number; lastIndex?: number; storageText: string; targetText: string }
  | { type: 'modalSyncRequest'; field: 'storage' | 'target'; text: string }
  | { type: 'cancelParagraphEdit' }
  | { type: 'scrollChanged'; topParagraphIndex: number }
  | { type: 'saveTranslation' }
  | { type: 'displayModeChanged'; displaying: 'source' | 'translation' }
  | { type: 'requestComments' }
  | { type: 'requestCommentThread'; paragraphIndex: number }
  | {
      type: 'addComment'
      paragraphIndex: number
      body: string
      fragment?: FragmentAnchor
      // Multi-block comment (req 10.17): the last block index + the selection's head fragment
      // within it. The `paragraphIndex`/`fragment` above are the first block + its tail.
      endIndex?: number
      endFragment?: FragmentAnchor
    }
  | { type: 'editComment'; commentId: string; body: string }
  | { type: 'deleteComment'; commentId: string }
  | { type: 'openSettings' }

/** Messages Extension Host → Webview. */
export type ExtensionMessage =
  | { type: 'renderContent'; html: string; lineMap: LineMapping[]; display?: boolean }
  | { type: 'setCodeTheme'; css: string }
  | { type: 'translationStart' }
  | { type: 'translationComplete'; translatedHtml: string }
  | { type: 'translationError'; code: number; message: string }
  | { type: 'showTooltip'; paragraphIndex: number; html: string }
  | { type: 'tooltipLoading'; paragraphIndex: number }
  | { type: 'tooltipError'; paragraphIndex: number; message: string }
  | { type: 'hideTooltip' }
  | { type: 'openEditModal'; paragraphIndex: number; lastIndex?: number; storageText: string; targetText: string }
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
      /** When required settings are missing (Target_Language, or an API key for a
       *  provider that needs one), a ready-to-display localized message. The webview
       *  replaces the toolbar buttons with a link carrying this text (req 3.20).
       *  Undefined/empty when the configuration is complete. */
      settingsHint?: string
      /** Whether the per-block comment control is shown (req 11.13). When false the
       *  webview hides the comment icon; the edit (pencil) control is unaffected. */
      commentsEnabled: boolean
    }
  | { type: 'memoryWarning'; level: 'large-file' | 'high-memory' }
  // Native editor-title toolbar commands (req 3.21): the host forwards a title-bar
  // icon click to the webview, which runs the same toggle as its own toolbar button.
  | { type: 'hostToggleTranslate' }
  | { type: 'hostToggleBilingual' }
  | { type: 'commentsForBlocks'; blocks: BlockCommentCount[] }
  | { type: 'commentThread'; paragraphIndex: number; comments: Comment[]; threads: ThreadView[] }
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
  /** Whether the per-block comment control is shown (req 11.13). Default true. */
  getCommentsEnabled(): boolean
  /** Code-block syntax highlighting theme (req 12). Default 'auto'. */
  getCodeHighlightTheme(): CodeHighlightTheme
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
  getThreads(paragraphIndex: number): ThreadView[]
  addComment(
    paragraphIndex: number,
    body: string,
    fragment?: FragmentAnchor,
    endIndex?: number,
    endFragment?: FragmentAnchor,
  ): Comment | undefined
  editComment(commentId: string, body: string): void
  deleteComment(commentId: string): void
  flush(): Thenable<void>
  /** Finish an auto-import now that the blocks are known (req 11.17). Optional: test
   *  doubles and comment-less setups may omit it. */
  completeImport?(): Promise<void>
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
