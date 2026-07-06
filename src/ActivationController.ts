import * as vscode from 'vscode'
import { SettingsManager } from './SettingsManager'
import { SecretManager } from './SecretManager'
import { TranslationCache } from './TranslationCache'
import { LayeredTranslationCache, PersistentTranslationCache } from './PersistentTranslationCache'
import { TranslationEngine } from './TranslationEngine'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ExportService } from './ExportService'
import { CommentsService } from './CommentsService'
import { type CommentBackend, SidecarBackend, InlineEofBackend, InlineAfterBackend } from './commentBackends'
import { PreviewController, type PreviewDeps } from './PreviewController'
import { createProvider } from './providers/ProviderFactory'
import { getPreviewHtml } from './webview/getPreviewHtml'
import { getNonce } from './webview/nonce'
import type { IActivationController, ITranslationProvider, ProviderType, WebviewMessage } from './types'

const VIEW_TYPE = 'kiro-md-translator.preview'
const EXTENSION_ID = 'VladimirTroyanenko.kiro-md-translator-plugin'
const PROVIDER_LABEL: Record<ProviderType, string> = {
  deepl: 'DeepL',
  google: 'Google',
  custom: 'Custom',
  ollama: 'Ollama',
}

/**
 * Extension entry point. Registers the `CustomTextEditorProvider` for `.md`,
 * the three commands, and wires shared singletons (settings, secrets, cache)
 * into a `PreviewController` per opened document.
 */
export class ActivationController implements IActivationController, vscode.CustomTextEditorProvider {
  private readonly settings = new SettingsManager()
  /** L1 in-memory (≤50) over L2 persistent memory; built in activate() with globalState. */
  private cache!: LayeredTranslationCache
  private secrets!: SecretManager
  private context!: vscode.ExtensionContext
  private apiKey: string | undefined
  /** Resolves once the initial key migration + load has finished; the per-doc
   *  auto-translate awaits it so cold start never translates with an empty key. */
  private ready: Promise<void> = Promise.resolve()
  private active: PreviewController | undefined
  /** Every live preview controller — settings changes broadcast to ALL of them,
   *  not just the most-recently-resolved `active` (which is what commands target). */
  private readonly controllers = new Set<PreviewController>()

  activate(context: vscode.ExtensionContext): void {
    this.context = context
    // L1 (in-memory, ≤50) over L2 persistent translation memory (globalState),
    // so reopening a file across sessions reuses prior translations (req 9).
    this.cache = new LayeredTranslationCache(
      new TranslationCache(),
      new PersistentTranslationCache(
        context.globalState,
        undefined,
        undefined,
        () => this.configFingerprint(),
      ),
      () => this.configFingerprint(),
    )
    this.secrets = new SecretManager(context.secrets)
    this.ready = this.initApiKey()

    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
        // Keep the preview's DOM alive while its tab is hidden (e.g. a double-click
        // opens the source editor over it): the host does not re-render on the
        // webview's post-reload `ready`, so without this the preview returns blank.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      // Settings live in the native settings UI now; the command just reveals it,
      // filtered to this extension. When a workspace/folder is open, land on the
      // Workspace tab (that is where a project's `.vscode/settings.json` values live);
      // fall back to the User settings page when no folder is open.
      vscode.commands.registerCommand('kiro-md-translator.openSettings', () => {
        const query = `@ext:${EXTENSION_ID}`
        const inWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        return vscode.commands.executeCommand(
          inWorkspace ? 'workbench.action.openWorkspaceSettings' : 'workbench.action.openSettings',
          query,
        )
      }),
      // Store a provider's API key in the OS keychain (masked input). `provider` is
      // passed by the settings-page command links; from the palette it defaults to
      // the active provider.
      vscode.commands.registerCommand('kiro-md-translator.setApiKey', (provider?: ProviderType) =>
        this.promptSetApiKey(provider),
      ),
      // Test a provider's connection with its stored key; result shown as a toast.
      vscode.commands.registerCommand('kiro-md-translator.testConnection', (provider?: ProviderType) =>
        this.testProviderConnection(provider),
      ),
      // Add the selection to the Glossary do-not-translate list (req 3.19). Invoked
      // from the editor context menu (reads the text editor) and the preview webview
      // context menu (the `data-vscode-context` arg carries the selection).
      vscode.commands.registerCommand('kiro-md-translator.excludeSelection', (ctx?: unknown) =>
        this.excludeSelection(ctx),
      ),
      vscode.commands.registerCommand('kiro-md-translator.saveTranslation', () =>
        this.active?.onWebviewMessage({ type: 'saveTranslation' }),
      ),
      this.settings.onDidChangeSettings(() => {
        // The key reload is async; once it settles, re-push the button state so a
        // provider switch that changes the key requirement updates the toolbar hint
        // (req 3.20) rather than showing the previous provider's key status.
        void this.refreshApiKey().then(() => {
          for (const c of this.controllers) c.updateButtonState()
        })
        // Drop the shared cache when the fingerprint (storage lang / provider /
        // endpoint / model / glossary) changed. The L1+L2 tiers are owned here and
        // outlive any preview, so this must happen at the owner level — a settings
        // change made with NO preview open would otherwise leave stale entries that
        // `deactivate()`'s flush re-persists under the new fingerprint (req 9.5).
        this.cache.onConfigChanged()
        // Rewire the button AND refresh a now-stale translation on a language change.
        // Broadcast to EVERY open preview: `active` is only the most-recently-resolved
        // one, so a focused-but-not-last doc would otherwise never refresh.
        for (const c of this.controllers) c.onSettingsChanged()
      }),
    )
  }

  deactivate(): Thenable<void> | void {
    // Persist the translation memory to disk on shutdown (req 9.6). Return the
    // Thenable so VS Code awaits the write before tearing the host process down.
    return this.cache?.flush()
  }

  /**
   * Fingerprint of the config dimensions a cached `[text, targetLang]` entry
   * depends on — storage language, provider (+ its endpoint/model), and glossary.
   * `targetLanguage` is NOT included (it is already part of the cache key). The
   * persistent tier stores this alongside its entries and drops them on a
   * mismatch at hydration, so a between-sessions or cross-workspace settings
   * divergence cannot serve stale translations (req 9.5).
   */
  private configFingerprint(): string {
    const c = this.settings.getConfig()
    return JSON.stringify([
      c.storageLanguage,
      c.providerType,
      c.customEndpoint ?? '',
      c.ollamaEndpoint ?? '',
      c.ollamaModel,
      [...c.glossary].sort(),
    ])
  }

  /** Migrate a pre-per-provider key into the active slot, then cache the key. */
  private async initApiKey(): Promise<void> {
    await this.secrets.migrateLegacyKey(this.settings.getProviderType())
    await this.refreshApiKey()
  }

  private async refreshApiKey(): Promise<void> {
    this.apiKey = await this.secrets.getApiKey(this.settings.getProviderType())
  }

  private buildProvider(): ITranslationProvider {
    return createProvider(this.settings.getConfig(), this.apiKey ?? '')
  }

  /** Select the comment persistence backend from settings (req 11): sidecar by
   *  default; inline end-of-file or after-paragraph when `commentStorage` is
   *  `inline`, per `commentPlacement`. */
  private makeCommentBackend(docUri: vscode.Uri): CommentBackend {
    if (this.settings.getCommentStorage() !== 'inline') return new SidecarBackend(docUri)
    return this.settings.getCommentPlacement() === 'end-of-file'
      ? new InlineEofBackend()
      : new InlineAfterBackend()
  }

  /** Command: prompt for a provider's API key (masked) and store it in the keychain. */
  private async promptSetApiKey(provider?: ProviderType): Promise<void> {
    const p = provider ?? this.settings.getProviderType()
    const label = PROVIDER_LABEL[p] ?? p
    if (p === 'ollama') {
      // Ollama runs locally and is keyless — there is nothing to store.
      void vscode.window.showInformationMessage('Ollama runs locally and requires no API key.')
      return
    }
    const key = await vscode.window.showInputBox({
      prompt: `${label} API key`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Paste the key, or leave empty and press Enter to clear it',
    })
    if (key === undefined) return // user cancelled
    if (key.trim() === '') {
      await this.secrets.deleteApiKey(p)
      void vscode.window.showInformationMessage(`${label} API key cleared.`)
    } else {
      await this.secrets.saveApiKey(p, key.trim())
      void vscode.window.showInformationMessage(`${label} API key saved.`)
    }
    await this.refreshApiKey()
    // The key lives in the keychain, not in settings, so no settings-change event
    // fires — re-push button state so the toolbar hint clears/appears (req 3.20).
    for (const c of this.controllers) c.updateButtonState()
  }

  /** Command: build the provider with its stored key and report the test as a toast. */
  private async testProviderConnection(provider?: ProviderType): Promise<void> {
    const p = provider ?? this.settings.getProviderType()
    const label = PROVIDER_LABEL[p] ?? p
    const key = (await this.secrets.getApiKey(p)) ?? ''
    try {
      await createProvider({ ...this.settings.getConfig(), providerType: p }, key).testConnection()
      void vscode.window.showInformationMessage(`${label}: connection successful.`)
    } catch (err) {
      void vscode.window.showErrorMessage(`${label}: ${(err as Error).message || 'connection failed'}`)
    }
  }

  /** Command: add the current selection to the Glossary (do-not-translate) list.
   *  From the editor context menu it reads the active text editor's selection; from
   *  the preview webview context menu it reads the selection out of the forwarded
   *  `data-vscode-context`. The config change re-anchors the cache and re-translates
   *  automatically via the settings listener (req 3.19). */
  private async excludeSelection(context?: unknown): Promise<void> {
    // A `webview/context` invocation carries the merged `data-vscode-context`; its
    // presence (the `kiroMdHasSelection` key) marks the preview as the source, so we
    // use the webview's selection and NEVER a possibly-stale background text editor.
    const ctx = context as { kiroMdHasSelection?: boolean; kiroMdSelection?: string } | undefined
    let selected: string
    if (ctx && typeof ctx === 'object' && 'kiroMdHasSelection' in ctx) {
      // Webview context menu: VS Code forwards the same data-vscode-context that
      // gated the item, so the selection is always present here.
      selected = (typeof ctx.kiroMdSelection === 'string' ? ctx.kiroMdSelection : '').trim()
    } else {
      const editor = vscode.window.activeTextEditor
      selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : ''
    }
    if (!selected) {
      void vscode.window.showInformationMessage('Select some text to exclude from translation first.')
      return
    }
    const added = await this.settings.addGlossaryTerm(selected)
    void vscode.window.showInformationMessage(
      added
        ? `Excluded from translation: "${selected}"`
        : `Already excluded from translation: "${selected}"`,
    )
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    const webview = webviewPanel.webview
    const docDir = vscode.Uri.joinPath(document.uri, '..')
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, docDir] }

    const nonce = getNonce()
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'previewPanel.js'),
    )
    webview.html = getPreviewHtml(webview, scriptUri, nonce)

    const renderer = new MarkdownRenderer((rel) =>
      webview.asWebviewUri(vscode.Uri.joinPath(docDir, rel)).toString(),
    )
    const engine = new TranslationEngine(
      () => this.buildProvider(),
      this.cache,
      renderer,
      () => this.settings.getGlossary(),
    )

    const applyEdit = async (newText: string) => {
      const edit = new vscode.WorkspaceEdit()
      const fullRange = new vscode.Range(0, 0, document.lineCount, 0)
      edit.replace(document.uri, fullRange, newText)
      await vscode.workspace.applyEdit(edit)
    }
    const commentsService = new CommentsService(
      document.uri,
      this.makeCommentBackend(document.uri),
      undefined, // default genId
      undefined, // default now
      undefined, // default flushMs
      () => document.getText(),
      applyEdit,
    )

    const deps: PreviewDeps = {
      post: (message) => void webview.postMessage(message),
      renderer,
      engine,
      cache: this.cache,
      settings: this.settings,
      exportService: new ExportService(),
      commentsService,
      getDocumentText: () => document.getText(),
      getDocumentUri: () => document.uri,
      applyEdit,
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      whenReady: () => this.ready,
      hasApiKey: () => (this.apiKey ?? '').trim().length > 0,
      commentsEnabled: () => this.settings.getCommentsEnabled(),
    }

    const controller = new PreviewController(deps)
    this.active = controller
    this.controllers.add(controller)

    const subs: vscode.Disposable[] = [
      webview.onDidReceiveMessage((m: WebviewMessage) => controller.onWebviewMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          controller.onDocumentChange(e.document)
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor.document.uri.toString() === document.uri.toString()) {
          controller.onEditorScroll(e.visibleRanges[0]?.start.line ?? 0)
        }
      }),
      // Swap the comment backend + migrate ONLY when the backend TYPE actually
      // changed, so unrelated settings changes (targetLanguage, provider, …) don't
      // re-home comments. `constructor` equality holds when neither commentStorage
      // nor the *effective* placement moved (e.g. placement change while storage is
      // sidecar still yields SidecarBackend both times → correctly skipped).
      this.settings.onDidChangeSettings(() => {
        const next = this.makeCommentBackend(document.uri)
        const prev = commentsService.currentBackend()
        if (next.constructor === prev.constructor) return
        commentsService.setBackend(next)
        // migrateFrom's writeSource already fires onDidChangeTextDocument; this guarantees a UI refresh even when migration produced no text change (empty comment set).
        void commentsService.migrateFrom(prev).then(() => controller.onDocumentChange(document)).catch(() => {})
      }),
    ]

    webviewPanel.onDidDispose(() => {
      controller.dispose()
      subs.forEach((s) => s.dispose())
      this.controllers.delete(controller)
      if (this.active === controller) this.active = undefined
    })

    controller.start()
  }
}
