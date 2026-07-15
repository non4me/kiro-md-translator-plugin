import * as vscode from 'vscode'
import {
  type Block,
  type ExtensionMessage,
  type ICommentsService,
  type IExportService,
  type IPreviewController,
  type ISettingsManager,
  type ITranslationCache,
  type LineMapping,
  type PluginError,
  type RenderResult,
  type WebviewMessage,
} from './types'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TranslationEngine } from './TranslationEngine'
import { stripInlineComments } from './inlineComments'
import { blocksFromLineMap } from './blocks'
import { t } from './l10n'
import { AssistantSession } from './assistant/AssistantSession'
import { buildContext, headingPath } from './assistant/context'
import { DEFAULT_SYSTEM_PROMPT, type AiAssistantConfig, type IAssistantProvider } from './assistant/types'

const RENDER_DEBOUNCE_MS = 300
const TRANSLATE_DEBOUNCE_MS = 1000
const MEMORY_CHECK_INTERVAL_MS = 10_000
const LARGE_FILE_BYTES = 1024 * 1024 // 1 MB
const MEMORY_WARN_BYTES = 150 * 1024 * 1024 // 150 MB (req 5.6, margin above the 100 MB budget)

export interface PreviewDeps {
  post: (message: ExtensionMessage) => void
  renderer: MarkdownRenderer
  engine: TranslationEngine
  /** Shared cache. `invalidate` (when present, LayeredTranslationCache) also
   *  wipes the persistent tier; a plain TranslationCache falls back to `clear`. */
  cache: ITranslationCache & { invalidate?: () => void }
  settings: ISettingsManager
  exportService: IExportService
  /** Block-anchored comments store (req 11). Optional: without it the preview has
   *  no comment layer and every comment path is a no-op. */
  commentsService?: ICommentsService
  getDocumentText: () => string
  getDocumentUri: () => vscode.Uri
  /** Persist edited source back to the document (used by saveParagraph, req 7.14). */
  applyEdit?: (newText: string) => Promise<void>
  /** Run a VS Code command (Edit_Mode opens the source editor via `vscode.openWith`). */
  executeCommand?: (command: string, ...args: unknown[]) => Thenable<unknown>
  /** Plugin-owned memory size in bytes (injected for the monitor, req 5.1/5.6). */
  ownedMemoryBytes?: () => number
  /** Resolves once the API key has finished loading from the keychain; the
   *  at-open auto-translate awaits it so it never builds a provider with an
   *  unloaded (empty) key on cold start. */
  whenReady?: () => Promise<void>
  /** Whether the active provider currently has a non-empty API key in the keychain.
   *  Used to decide if the "configure settings" hint replaces the toolbar buttons
   *  (req 3.20). Absent in unit contexts → treated as present (key not required). */
  hasApiKey?: () => boolean
  /** Whether the per-block comment control is shown (req 11.13). Absent → true. */
  commentsEnabled?: () => boolean
  /** AI Assistant configuration (req 1/17). Absent → the assistant is off. */
  aiAssistant?: () => AiAssistantConfig
  /** Builds the provider for the current assistant config. Throws a user-facing
   *  message when the assistant is unconfigured (req 17.1/17.2). */
  buildAssistantProvider?: () => IAssistantProvider
  /** Approximate token budget for the assembled context (req 5). Default 24_000. */
  aiTokenBudget?: () => number
}

type State =
  | 'IDLE'
  | 'RENDERING'
  | 'RENDERED'
  | 'TRANSLATING'
  | 'TRANSLATED'
  | 'RENDER_ERROR'
  | 'TRANSLATION_ERROR'

/**
 * Per-document coordinator between the Kiro host, the renderer and the engine.
 * Owns the render/translate debounce timers and a single per-document
 * AbortController. The preview shows the translated render once translation is
 * active; scroll sync is element-level via the source lineMap.
 */
export class PreviewController implements IPreviewController {
  private state: State = 'IDLE'
  private sourceText = ''
  private lineMap: LineMapping[] = []
  private displayingTranslation = false
  private editMode = false
  private lastHtmlBytes = 0
  private lastTarget: string | undefined
  private lastStorage = ''
  private lastMode = ''
  private lastProvider = ''
  private lastEndpoint: string | undefined
  private lastOllamaEndpoint: string | undefined
  private lastOllamaModel = ''
  private lastGlossary = '[]'

  private renderTimer: ReturnType<typeof setTimeout> | undefined
  private translateTimer: ReturnType<typeof setTimeout> | undefined
  private memoryTimer: ReturnType<typeof setInterval> | undefined
  private abortController: AbortController | undefined
  private renderToken: vscode.CancellationTokenSource | undefined

  constructor(private readonly deps: PreviewDeps) {
    this.sourceText = deps.getDocumentText()
    const cfg = deps.settings.getConfig()
    this.lastTarget = cfg.targetLanguage
    this.lastStorage = cfg.storageLanguage
    this.lastMode = cfg.translationMode
    this.lastProvider = cfg.providerType
    this.lastEndpoint = cfg.customEndpoint
    this.lastOllamaEndpoint = cfg.ollamaEndpoint
    this.lastOllamaModel = cfg.ollamaModel ?? ''
    this.lastGlossary = JSON.stringify([...(cfg.glossary ?? [])].sort())
  }

  // --- lifecycle ---------------------------------------------------------

  start(): void {
    this.scheduleRender()
    this.updateButtonState()
    const cfg = this.deps.settings.getConfig()
    // The key loads asynchronously; re-push once it settles so a provider that needs
    // a key does not flash a false "set the API key" hint before the key arrives.
    if (this.deps.whenReady && this.deps.hasApiKey) {
      void this.deps.whenReady().then(() => this.updateButtonState())
    }
    if (cfg.translationMode === 'automatic' && cfg.targetLanguage) {
      // req 3.5: translate immediately on file open — but wait for the API key to
      // finish loading first, or the first translation goes out with an empty key.
      const ready = this.deps.whenReady?.() ?? Promise.resolve()
      void ready.then(() => this.translateNow())
    }
    this.memoryTimer = setInterval(() => this.checkMemory(), MEMORY_CHECK_INTERVAL_MS)
    // Load the comment sidecar, then push indicators (covers the case where the
    // first render already completed; the webview also pulls after every render).
    void this.deps.commentsService?.load().then(() => this.emitComments())
  }

  onDocumentChange(document: vscode.TextDocument): void {
    this.sourceText = document.getText()
    this.scheduleRender()
    const cfg = this.deps.settings.getConfig()
    if (cfg.translationMode === 'automatic' && cfg.targetLanguage) {
      this.scheduleTranslate()
    } else if (this.editMode && this.displayingTranslation && cfg.targetLanguage) {
      // Edit_Mode with a translated preview re-translates edited paragraphs (req 2.6).
      this.scheduleTranslate()
    } else if (this.displayingTranslation) {
      // On-demand edit with no re-translate coming: the shown translation is now
      // stale → let the upcoming render fall back to source instead of keeping it.
      this.displayingTranslation = false
    }
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    if (this.translateTimer) clearTimeout(this.translateTimer)
    if (this.memoryTimer) clearInterval(this.memoryTimer)
    this.abortController?.abort()
    this.renderToken?.cancel()
    this.renderToken?.dispose()
    void this.deps.commentsService?.flush() // persist any pending comment edits
  }

  // --- rendering ---------------------------------------------------------

  private scheduleRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderToken?.cancel()
    this.renderTimer = setTimeout(() => void this.renderNow(), RENDER_DEBOUNCE_MS)
  }

  async renderNow(): Promise<void> {
    if (new TextEncoder().encode(this.sourceText).length > LARGE_FILE_BYTES) {
      this.deps.post({ type: 'memoryWarning', level: 'large-file' })
    }
    this.state = 'RENDERING'
    this.renderToken = new vscode.CancellationTokenSource()
    try {
      const result = await this.deps.renderer.render(this.sourceText, this.fileDir())
      this.applyRenderResult(result)
      this.state = 'RENDERED'
      // Keep a still-valid translation on screen while its refresh is in flight
      // (req 2.6/3.11). Callers clear displayingTranslation when the shown
      // translation is stale with no re-translate coming, so we fall back to source.
      const display = !this.displayingTranslation
      this.deps.post({ type: 'renderContent', html: result.html, lineMap: result.lineMap, display })
    } catch (err) {
      this.state = 'RENDER_ERROR'
      this.deps.post({ type: 'translationError', code: 0, message: t('Failed to load the preview') })
    }
  }

  private applyRenderResult(result: RenderResult): void {
    this.lineMap = result.lineMap
    this.lastHtmlBytes = result.html.length * 2
  }

  // --- translation -------------------------------------------------------

  private scheduleTranslate(): void {
    if (this.translateTimer) clearTimeout(this.translateTimer)
    this.translateTimer = setTimeout(() => void this.translateNow(), TRANSLATE_DEBOUNCE_MS)
  }

  async translateNow(): Promise<void> {
    const cfg = this.deps.settings.getConfig()
    if (!cfg.targetLanguage) return
    this.state = 'TRANSLATING'
    this.deps.post({ type: 'translationStart' })
    this.abortController?.abort()
    this.abortController = new AbortController()
    try {
      const result = await this.deps.engine.translate(
        this.sourceText,
        cfg.storageLanguage,
        cfg.targetLanguage,
        this.abortController.signal,
        this.fileDir(),
      )
      this.displayingTranslation = true
      this.lastHtmlBytes = result.html.length * 2
      this.state = 'TRANSLATED'
      this.deps.post({ type: 'translationComplete', translatedHtml: result.html })
    } catch (err) {
      this.state = 'TRANSLATION_ERROR'
      const e = err as PluginError
      // HTTP error (req 3.13): notify with code + message, keep previous content.
      // Empty/null responses never throw (engine keeps the source per req 3.14),
      // so reaching here implies a real error worth surfacing.
      this.deps.post({ type: 'translationError', code: e.httpStatus ?? 0, message: e.message })
    }
  }

  // --- webview messages --------------------------------------------------

  onWebviewMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'translateRequest':
        void this.translateNow()
        break
      case 'openSettings':
        // The toolbar hint links here when required settings are missing (req 3.20).
        void this.deps.executeCommand?.('kiro-md-translator.openSettings')
        break
      case 'openOriginal':
        this.enterEditMode()
        break
      case 'paragraphHover':
        void this.handleHover(message.paragraphIndex)
        break
      case 'paragraphHoverEnd':
        this.deps.post({ type: 'hideTooltip' })
        break
      case 'displayModeChanged':
        // The webview toggled Translate<->Original locally (cached HTML, no API);
        // keep the host's hover direction (req 7.3/7.4) in sync.
        this.displayingTranslation = message.displaying === 'translation'
        break
      case 'scrollChanged':
        this.handlePreviewScroll(message.topParagraphIndex)
        break
      case 'editParagraph':
        void this.handleEditParagraph(message.paragraphIndex, message.lastIndex)
        break
      case 'saveParagraph':
        void this.handleSaveParagraph(message.paragraphIndex, message.storageText, message.lastIndex)
        break
      case 'modalSyncRequest':
        void this.handleModalSync(message.field, message.text)
        break
      case 'saveTranslation':
        void this.handleExport()
        break
      case 'requestComments':
        this.emitComments()
        break
      case 'requestCommentThread':
        this.postThread(message.paragraphIndex)
        break
      case 'addComment':
        this.deps.commentsService?.addComment(
          message.paragraphIndex,
          message.body,
          message.fragment,
          message.endIndex,
          message.endFragment,
        )
        this.emitComments()
        break
      case 'editComment':
        this.deps.commentsService?.editComment(message.commentId, message.body)
        this.emitComments()
        break
      case 'deleteComment':
        this.deps.commentsService?.deleteComment(message.commentId)
        this.emitComments()
        break
      case 'askAiOpen':
        void this.openAssistant(message)
        break
      case 'askAiSend':
        void this.assistant?.ask(message.text)
        break
      case 'askAiApply':
        this.applyAssistantEdit()
        break
      case 'askAiSaveSummary':
        void this.saveAssistantSummary()
        break
      case 'askAiClose':
        this.assistant?.cancel()
        this.assistant = undefined
        break
      case 'cancelParagraphEdit':
      case 'ready':
        break
    }
  }

  // --- AI Assistant (req 1/5/7/8/17) --------------------------------------

  private assistant: AssistantSession | undefined
  private assistantSel: { first: number; last: number } | undefined

  private async openAssistant(m: Extract<WebviewMessage, { type: 'askAiOpen' }>): Promise<void> {
    if (!this.deps.aiAssistant?.().enabled) return
    const first = m.paragraphIndex
    const last = m.lastIndex ?? first
    this.assistantSel = { first, last }
    let provider: IAssistantProvider | undefined
    try {
      provider = this.deps.buildAssistantProvider?.()
    } catch (err) {
      this.deps.post({ type: 'assistantError', message: (err as Error).message })
      return
    }
    if (!provider) {
      this.deps.post({ type: 'assistantError', message: t('AI Assistant not configured') })
      return
    }
    const cfg = this.deps.aiAssistant()
    const source = this.paragraphRangeText(first, last) ?? ''
    const comments = (this.deps.commentsService?.getThreads(first) ?? []).flatMap((tv) =>
      tv.comments.map((c) => c.body),
    )
    const initial = buildContext({
      systemPrompt: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      selection: m.selection,
      selectionIsTranslated: m.translated,
      sourceOfSelectedBlocks: source,
      fullDocument: this.sourceText,
      headingPath: headingPath(this.sourceText, this.paragraphStartLine(first) ?? 0),
      comments,
      tokenBudget: this.deps.aiTokenBudget?.() ?? 24_000,
    })
    this.assistant = new AssistantSession({
      provider,
      initial,
      post: (msg) => this.deps.post(msg),
      renderMarkdown: async (md) => (await this.deps.renderer.render(md, this.fileDir())).html,
    })
    this.deps.post({ type: 'assistantOpen', selection: m.selection, commentCount: comments.length })
  }

  private applyAssistantEdit(): void {
    const edit = this.assistant?.lastEdit()
    if (edit === undefined || !this.assistantSel) return
    const { first, last } = this.assistantSel
    // Reuse the existing edit path: open the modal pre-filled; the user saves (req 7.2/7.5).
    this.deps.post({ type: 'openEditModal', paragraphIndex: first, lastIndex: last, storageText: edit, targetText: '' })
  }

  private async saveAssistantSummary(): Promise<void> {
    if (!this.assistant || !this.assistantSel) return
    try {
      const body = await this.assistant.summarize()
      this.deps.commentsService?.addComment(this.assistantSel.first, body)
      this.emitComments()
      this.assistant = undefined
      this.deps.post({ type: 'assistantClosed' })
    } catch (err) {
      this.deps.post({ type: 'assistantError', message: t('Failed to save summary as comment: {0}', (err as Error).message) })
    }
  }

  // --- comments (req 11) -------------------------------------------------

  /** Build the current document's blocks (source text) for anchoring. Comments
   *  always anchor to the STORAGE/source text, independent of the display mode. */
  private currentBlocks(): Block[] {
    return blocksFromLineMap(this.lineMap, this.sourceText)
  }

  /** Re-anchor every thread and push the indicator counts + orphaned list. */
  private emitComments(): void {
    const svc = this.deps.commentsService
    if (!svc) return
    try {
      const res = svc.reanchor(this.currentBlocks(), this.sourceText)
      this.deps.post({ type: 'commentsForBlocks', blocks: res.forBlocks })
      this.deps.post({ type: 'orphanedComments', threads: res.orphaned })
      // Phase 2 of auto-import (req 11.17): the blocks exist now, so what `load` merged
      // from the other stores can be moved into the selected one. Self-guarding no-op
      // unless something was actually imported.
      void svc.completeImport?.()
    } catch {
      // A malformed/untrusted sidecar must never break the preview; drop the comment
      // layer for this pass instead of throwing into the host's event dispatcher.
      this.deps.post({ type: 'commentsForBlocks', blocks: [] })
    }
  }

  private postThread(paragraphIndex: number): void {
    this.deps.post({
      type: 'commentThread',
      paragraphIndex,
      comments: this.deps.commentsService?.getThreadComments(paragraphIndex) ?? [],
      threads: this.deps.commentsService?.getThreads(paragraphIndex) ?? [],
    })
  }

  /** Hover reverse translation (reqs 7.3/7.4). */
  async handleHover(paragraphIndex: number): Promise<void> {
    const paraText = this.paragraphText(paragraphIndex)
    if (paraText === undefined) return

    if (this.displayingTranslation) {
      // Preview shows the translation → reverse is the KNOWN source; no API (req 7.3).
      this.deps.post({ type: 'showTooltip', paragraphIndex, html: await this.tooltipHtml(paraText) })
      return
    }

    // Preview shows the source → reverse = Storage → Target (req 7.4).
    const cfg = this.deps.settings.getConfig()
    if (!cfg.targetLanguage) return
    const cached = this.deps.cache.get(paraText, cfg.targetLanguage)
    if (cached !== undefined) {
      this.deps.post({ type: 'showTooltip', paragraphIndex, html: await this.tooltipHtml(cached) })
      return
    }
    this.deps.post({ type: 'tooltipLoading', paragraphIndex })
    try {
      const ac = new AbortController()
      const res = await this.deps.engine.translateParagraph(
        paraText,
        cfg.storageLanguage,
        cfg.targetLanguage,
        ac.signal,
      )
      this.deps.cache.set(paraText, cfg.targetLanguage, res)
      this.deps.post({ type: 'showTooltip', paragraphIndex, html: await this.tooltipHtml(res) })
    } catch {
      this.deps.post({ type: 'tooltipError', paragraphIndex, message: t('Failed to load the translation') })
    }
  }

  /** Render a hover peek's Markdown to sanitized HTML so the tooltip is a true mini
   *  preview, not raw markup: a fenced code block becomes a real `<pre>` (whitespace
   *  preserved, ``` delimiters gone) instead of collapsed one-line text. The peek is
   *  a single block's source/translation, so this is one small parse — no API call. */
  private async tooltipHtml(markdown: string): Promise<string> {
    const { html } = await this.deps.renderer.render(markdown, this.fileDir())
    return html
  }

  /** Modal bidirectional auto-sync (reqs 7.9–7.11). */
  async handleModalSync(field: 'storage' | 'target', text: string): Promise<void> {
    const cfg = this.deps.settings.getConfig()
    if (!cfg.targetLanguage) return
    const from = field === 'storage' ? cfg.storageLanguage : cfg.targetLanguage
    const to = field === 'storage' ? cfg.targetLanguage : cfg.storageLanguage
    const other: 'storage' | 'target' = field === 'storage' ? 'target' : 'storage'
    this.deps.post({ type: 'editModalSyncStart', field: other })
    try {
      const ac = new AbortController()
      const res = await this.deps.engine.translateParagraph(text, from, to, ac.signal)
      this.deps.post({ type: 'editModalSyncComplete', field: other, text: res })
    } catch {
      this.deps.post({ type: 'editModalSyncError', field: other, message: t('Failed to load the translation') })
    }
  }

  private async handleEditParagraph(
    paragraphIndex: number,
    lastIndex: number = paragraphIndex,
  ): Promise<void> {
    // Multi-block edit (req 10.16): load the raw source of the WHOLE selected block range
    // as one editable text. A single-block edit is the first===last case (unchanged).
    const storageText = this.paragraphRangeText(paragraphIndex, lastIndex) ?? ''
    const cfg = this.deps.settings.getConfig()
    const cached = cfg.targetLanguage
      ? this.deps.cache.get(storageText, cfg.targetLanguage)
      : undefined
    // Open the modal right away. The full-document translate caches per text-node
    // SEGMENT (code/inline-code excluded), not per whole paragraph, so a paragraph
    // with any inline markup is never a single-key hit — on a miss, translate the
    // paragraph (as hover does) and fill the Target field instead of leaving it blank (req 7.9).
    // The Target field is a display-only preview — only storageText is written back on save.
    this.deps.post({ type: 'openEditModal', paragraphIndex, lastIndex, storageText, targetText: cached ?? '' })
    if (cached !== undefined || !cfg.targetLanguage || !storageText) return
    this.deps.post({ type: 'editModalSyncStart', field: 'target' })
    try {
      const ac = new AbortController()
      const res = await this.deps.engine.translateParagraph(
        storageText,
        cfg.storageLanguage,
        cfg.targetLanguage,
        ac.signal,
      )
      this.deps.cache.set(storageText, cfg.targetLanguage, res)
      this.deps.post({ type: 'editModalSyncComplete', field: 'target', text: res })
    } catch {
      this.deps.post({ type: 'editModalSyncError', field: 'target', message: t('Failed to load the translation') })
    }
  }

  private async handleSaveParagraph(
    paragraphIndex: number,
    storageText: string,
    lastIndex: number = paragraphIndex,
  ): Promise<void> {
    const newSource = this.deps.engine.replaceParagraphInSource(
      this.sourceText,
      this.lineMap,
      paragraphIndex,
      storageText,
      lastIndex,
    )
    this.sourceText = newSource
    if (this.deps.applyEdit) await this.deps.applyEdit(newSource)
    this.scheduleRender()
  }

  private async handleExport(): Promise<void> {
    const cfg = this.deps.settings.getConfig()
    if (!cfg.targetLanguage) return
    const ac = new AbortController()
    // Export must produce a CLEAN translated file: inline comment carriers
    // (<!-- rmt:comments … -->) are stripped before translating so they never
    // reach the exported document.
    const cleanSource = stripInlineComments(this.sourceText)
    const md = await this.deps.engine.translateToMarkdown(
      cleanSource,
      cfg.storageLanguage,
      cfg.targetLanguage,
      ac.signal,
    )
    await this.deps.exportService.exportTranslation(md, this.deps.getDocumentUri(), cfg.targetLanguage)
  }

  private enterEditMode(): void {
    this.editMode = true
    void this.deps.executeCommand?.('vscode.openWith', this.deps.getDocumentUri(), 'default', vscode.ViewColumn.One)
  }

  // --- scroll sync (element-level via lineMap) ---------------------------

  /** Editor first visible line → paragraphIndex → scroll that element into view. */
  editorLineToParagraphIndex(line: number): number | undefined {
    const hit = this.lineMap.find((m) => line >= m.startLine && line <= m.endLine)
    return hit ? hit.paragraphIndex : this.lineMap[this.lineMap.length - 1]?.paragraphIndex
  }

  onEditorScroll(firstVisibleLine: number): void {
    const index = this.editorLineToParagraphIndex(firstVisibleLine)
    if (index !== undefined) this.deps.post({ type: 'editorScrollSync', paragraphIndex: index })
  }

  /** Preview top element → source line → reveal in editor (handled by host wiring). */
  private handlePreviewScroll(topParagraphIndex: number): void {
    // The reveal itself is performed by the activation-layer editor wiring; here we
    // only resolve the target line so the controller stays editor-agnostic.
    void this.paragraphStartLine(topParagraphIndex)
  }

  paragraphStartLine(paragraphIndex: number): number | undefined {
    return this.lineMap.find((m) => m.paragraphIndex === paragraphIndex)?.startLine
  }

  // --- button + memory ---------------------------------------------------

  updateButtonState(): void {
    const cfg = this.deps.settings.getConfig()
    const translateEnabled = cfg.translationMode === 'on-demand' && cfg.targetLanguage !== undefined
    this.deps.post({
      type: 'updateButtonState',
      translateEnabled,
      mode: cfg.translationMode,
      storageLang: cfg.storageLanguage,
      targetLang: cfg.targetLanguage,
      settingsHint: this.settingsHint(),
      commentsEnabled: this.deps.commentsEnabled?.() ?? true,
    })
  }

  /** Localized "configure settings" message when a required setting is missing, else
   *  undefined (req 3.20). Target_Language is always required; an API key is required
   *  only for providers that authenticate with one (DeepL, Google) — Ollama is keyless
   *  and Custom treats the key as optional, matching `createProvider`. */
  private settingsHint(): string | undefined {
    const cfg = this.deps.settings.getConfig()
    const missingTarget = cfg.targetLanguage === undefined
    const keyRequired = cfg.providerType === 'deepl' || cfg.providerType === 'google'
    // Absent hasApiKey (unit contexts) → assume present, so the hint stays off.
    const missingKey = keyRequired && !(this.deps.hasApiKey?.() ?? true)
    if (missingTarget && missingKey) return t('Set the target language and API key in settings')
    if (missingTarget) return t('Set the target language in settings')
    if (missingKey) return t('Set the API key in settings')
    return undefined
  }

  /** True when a required setting is missing — drives the `kiroMd.settingsMissing`
   *  context key that hides the native editor-title toolbar icons (req 3.21). */
  isSettingsMissing(): boolean {
    return this.settingsHint() !== undefined
  }

  /** Native editor-title toolbar commands (req 3.21): forward the icon click to the
   *  webview, which runs the same toggle as its own toolbar button. */
  hostToggleTranslate(): void {
    this.deps.post({ type: 'hostToggleTranslate' })
  }

  hostToggleBilingual(): void {
    this.deps.post({ type: 'hostToggleBilingual' })
  }

  /**
   * A settings change refreshes the button and, when the translation LANGUAGES
   * changed, drops the now-stale rendering: automatic mode re-translates into the
   * new language; on-demand falls back to the source so the user re-translates.
   * Without this the preview keeps showing the previous-language translation.
   */
  onSettingsChanged(): void {
    const cfg = this.deps.settings.getConfig()
    // Sort so a pure reorder of the same terms is NOT treated as a change (the
    // config fingerprint sorts too); reordering does not change output, so it must
    // not invalidate the cache. A genuine add/remove still differs after sorting.
    const glossaryKey = JSON.stringify([...(cfg.glossary ?? [])].sort())
    const langChanged =
      cfg.targetLanguage !== this.lastTarget || cfg.storageLanguage !== this.lastStorage
    // An endpoint/model only affects its own provider; comparing it while another
    // provider is active would needlessly invalidate the cache + force a re-translate
    // (req: no spurious calls). Custom → customEndpoint; Ollama → endpoint + model.
    const providerChanged =
      cfg.providerType !== this.lastProvider ||
      (cfg.providerType === 'custom' && cfg.customEndpoint !== this.lastEndpoint) ||
      (cfg.providerType === 'ollama' &&
        (cfg.ollamaEndpoint !== this.lastOllamaEndpoint ||
          (cfg.ollamaModel ?? '') !== this.lastOllamaModel))
    const glossaryChanged = glossaryKey !== this.lastGlossary
    const modeChanged = cfg.translationMode !== this.lastMode
    // Cached translations key on [text, targetLang]; a storage-language, provider,
    // or glossary change makes same-key entries wrong, so the cache must be dropped
    // (a target change alone is safe — it uses a different key). req 9.5.
    const cacheStale = cfg.storageLanguage !== this.lastStorage || providerChanged || glossaryChanged
    const inputsChanged = langChanged || providerChanged || glossaryChanged
    this.lastTarget = cfg.targetLanguage
    this.lastStorage = cfg.storageLanguage
    this.lastProvider = cfg.providerType
    this.lastEndpoint = cfg.customEndpoint
    this.lastOllamaEndpoint = cfg.ollamaEndpoint
    this.lastOllamaModel = cfg.ollamaModel ?? ''
    this.lastGlossary = glossaryKey
    this.lastMode = cfg.translationMode
    this.updateButtonState()
    // Invalidate BOTH tiers (persistent memory too, req 9.5); a plain
    // TranslationCache without invalidate() falls back to clear().
    if (cacheStale) {
      if (this.deps.cache.invalidate) this.deps.cache.invalidate()
      else this.deps.cache.clear()
    }
    if (cfg.translationMode === 'automatic' && cfg.targetLanguage) {
      // Automatic mode must always show the CURRENT translation: (re)translate on
      // an input change or when we've just switched into automatic (its button is
      // disabled, so the user cannot trigger it manually).
      if (inputsChanged || modeChanged) this.scheduleTranslate()
    } else if (inputsChanged && this.displayingTranslation) {
      // On-demand with a now-stale translation on screen → fall back to source.
      this.displayingTranslation = false
      this.scheduleRender()
    }
  }

  /** Plugin-owned-memory check (reqs 5.1/5.6). */
  checkMemory(): void {
    const bytes = this.deps.ownedMemoryBytes ? this.deps.ownedMemoryBytes() : this.lastHtmlBytes
    if (bytes > MEMORY_WARN_BYTES) {
      this.deps.post({ type: 'memoryWarning', level: 'high-memory' })
    }
  }

  // --- helpers -----------------------------------------------------------

  private paragraphText(paragraphIndex: number): string | undefined {
    const mapping = this.lineMap.find((m) => m.paragraphIndex === paragraphIndex)
    if (!mapping) return undefined
    return this.sourceText
      .split('\n')
      .slice(mapping.startLine, mapping.endLine + 1)
      .join('\n')
      .trim()
  }

  /** Raw source of a whole block range (req 10.16): lines [first.startLine .. last.endLine].
   *  first===last is the single-block case (equals `paragraphText`). */
  private paragraphRangeText(first: number, last: number): string | undefined {
    const a = this.lineMap.find((m) => m.paragraphIndex === first)
    const b = this.lineMap.find((m) => m.paragraphIndex === last)
    if (!a || !b) return undefined
    const startLine = Math.min(a.startLine, b.startLine)
    const endLine = Math.max(a.endLine, b.endLine)
    return this.sourceText
      .split('\n')
      .slice(startLine, endLine + 1)
      .join('\n')
      .trim()
  }

  private fileDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.deps.getDocumentUri(), '..')
  }

  /** @internal test seam: prime render state without driving the full pipeline. */
  primeRenderState(sourceText: string, lineMap: LineMapping[], displayingTranslation: boolean): void {
    this.sourceText = sourceText
    this.lineMap = lineMap
    this.displayingTranslation = displayingTranslation
  }
}
