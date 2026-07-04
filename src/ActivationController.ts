import * as vscode from 'vscode'
import { SettingsManager } from './SettingsManager'
import { SecretManager } from './SecretManager'
import { TranslationCache } from './TranslationCache'
import { LayeredTranslationCache, PersistentTranslationCache } from './PersistentTranslationCache'
import { TranslationEngine } from './TranslationEngine'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ExportService } from './ExportService'
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
      // Settings live in the native settings UI now; the command just reveals it.
      vscode.commands.registerCommand('kiro-md-translator.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`),
      ),
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
      vscode.commands.registerCommand('kiro-md-translator.saveTranslation', () =>
        this.active?.onWebviewMessage({ type: 'saveTranslation' }),
      ),
      this.settings.onDidChangeSettings(() => {
        void this.refreshApiKey()
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

    const deps: PreviewDeps = {
      post: (message) => void webview.postMessage(message),
      renderer,
      engine,
      cache: this.cache,
      settings: this.settings,
      exportService: new ExportService(),
      getDocumentText: () => document.getText(),
      getDocumentUri: () => document.uri,
      applyEdit: async (newText) => {
        const edit = new vscode.WorkspaceEdit()
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0)
        edit.replace(document.uri, fullRange, newText)
        await vscode.workspace.applyEdit(edit)
      },
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      whenReady: () => this.ready,
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
