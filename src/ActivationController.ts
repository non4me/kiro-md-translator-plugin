import * as vscode from 'vscode'
import { SettingsManager } from './SettingsManager'
import { SecretManager } from './SecretManager'
import { TranslationCache } from './TranslationCache'
import { LayeredTranslationCache, PersistentTranslationCache } from './PersistentTranslationCache'
import { TranslationEngine } from './TranslationEngine'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ExportService } from './ExportService'
import { CommentsService } from './CommentsService'
import {
  type CommentBackend,
  SidecarBackend,
  InlineEofBackend,
  InlineAfterBackend,
  DraftBackend,
  moveDraft,
} from './commentBackends'
import { CommentImporter, type ImportDeps } from './CommentImporter'
import { blocksFromLineMap } from './blocks'
import { t } from './l10n'
import { PreviewController, type PreviewDeps } from './PreviewController'
import { createProvider } from './providers/ProviderFactory'
import { getPreviewHtml } from './webview/getPreviewHtml'
import { codeThemeCss } from './highlightThemes'
import { getNonce } from './webview/nonce'
import type { IActivationController, ITranslationProvider, ProviderType, WebviewMessage } from './types'
import { AssistantSecretManager } from './AssistantSecretManager'
import { createAssistantProvider } from './assistant/AssistantProviderFactory'
import { KEYLESS_IDE_PROVIDERS, type AssistantProviderType } from './assistant/types'

const VIEW_TYPE = 'kiro-md-translator.preview'
const EXTENSION_ID = 'VladimirTroyanenko.kiro-md-translator-plugin'
const PROVIDER_LABEL: Record<ProviderType, string> = {
  deepl: 'DeepL',
  google: 'Google',
  custom: 'Custom',
  ollama: 'Ollama',
}
const ASSISTANT_PROVIDER_LABEL: Record<AssistantProviderType, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'vscode-copilot': 'GitHub Copilot Chat',
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
  private aiSecrets!: AssistantSecretManager
  private context!: vscode.ExtensionContext
  private apiKey: string | undefined
  /** Keyed by assistant provider so a provider switch doesn't require a re-fetch
   *  round-trip before `buildAssistantProvider` can run synchronously. */
  private aiKeyCache: Partial<Record<AssistantProviderType, string>> = {}
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
    this.aiSecrets = new AssistantSecretManager(context.secrets)
    this.ready = this.initApiKey()
    // Home of the draft comment store (req 11.14). `createDirectory` is recursive and
    // idempotent, so this is safe to fire on every activation.
    void vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(context.globalStorageUri, 'comments'),
    )

    context.subscriptions.push(
      // A document renamed INSIDE the editor keeps its drafts (the record is keyed by the
      // document URI). A move made outside the editor breaks the link — accepted: drafts
      // are drafts, and the record is never deleted, just not found.
      vscode.workspace.onDidRenameFiles(async (e) => {
        for (const { oldUri, newUri } of e.files) {
          if (!newUri.path.toLowerCase().endsWith('.md')) continue
          await moveDraft(oldUri, newUri, context.globalStorageUri)
        }
      }),
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
        // Keep the preview's DOM alive while its tab is hidden (e.g. a double-click
        // opens the source editor over it): the host does not re-render on the
        // webview's post-reload `ready`, so without this the preview returns blank.
        // NB: we deliberately do NOT set enableFindWidget — the native find widget
        // relies on Electron's findInPage, which is inert in Code OSS builds (Kiro)
        // and would also swallow Ctrl+F before the webview's own handler. In-document
        // search (req 1.8) is implemented inside the webview via window.find instead.
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
      // Store an AI Assistant provider's API key in the OS keychain (masked input),
      // namespaced apart from translation keys (req 16.5/16.6).
      vscode.commands.registerCommand(
        'kiro-md-translator.setAiAssistantKey',
        (provider?: AssistantProviderType) => this.promptSetAiKey(provider),
      ),
      // Test an AI Assistant provider's connection with its stored key; result shown
      // as a toast (req 16.7–16.9).
      vscode.commands.registerCommand(
        'kiro-md-translator.testAiAssistantConnection',
        (provider?: AssistantProviderType) => this.testAiConnection(provider),
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
      // Move every project document's comments into the selected storage (req 11.18).
      // Reachable from the palette and from the action link in the Comments settings.
      vscode.commands.registerCommand('kiro-md-translator.importComments', () =>
        this.importAllComments(),
      ),
      // Native editor-title toolbar (req 3.21): forward the icon click to the active
      // preview, which runs the same toggle as its own toolbar button.
      vscode.commands.registerCommand('kiro-md-translator.toggleTranslate', () =>
        this.active?.hostToggleTranslate(),
      ),
      vscode.commands.registerCommand('kiro-md-translator.toggleBilingual', () =>
        this.active?.hostToggleBilingual(),
      ),
      this.settings.onDidChangeSettings(() => {
        // The key reload is async; once it settles, re-push the button state so a
        // provider switch that changes the key requirement updates the toolbar hint
        // (req 3.20) rather than showing the previous provider's key status.
        void Promise.all([this.refreshApiKey(), this.refreshAiKey()]).then(() => {
          for (const c of this.controllers) c.updateButtonState()
          this.updateTitleContext() // key requirement may have changed → refresh icons
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
        this.updateTitleContext() // targetLanguage change may change settingsMissing
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
    await Promise.all([this.refreshApiKey(), this.refreshAiKey()])
  }

  private async refreshApiKey(): Promise<void> {
    this.apiKey = await this.secrets.getApiKey(this.settings.getProviderType())
  }

  /** Load the active AI Assistant provider's key into the cache, so
   *  `buildAssistantProvider` (in `PreviewDeps`) can stay synchronous. */
  private async refreshAiKey(): Promise<void> {
    const p = this.settings.getAiAssistantConfig().provider
    this.aiKeyCache[p] = (await this.aiSecrets.getKey(p)) ?? ''
  }

  private buildProvider(): ITranslationProvider {
    return createProvider(this.settings.getConfig(), this.apiKey ?? '')
  }

  /** Refresh the `kiroMd.settingsMissing` context key from the active preview, so the
   *  native editor-title toolbar icons hide when a required setting is missing (req
   *  3.21). No active preview → hidden. */
  private updateTitleContext(): void {
    const missing = this.active ? this.active.isSettingsMissing() : true
    void vscode.commands.executeCommand('setContext', 'kiroMd.settingsMissing', missing)
  }

  /** Select the comment persistence backend from settings (req 11): sidecar by
   *  default; inline end-of-file or after-paragraph when `commentStorage` is
   *  `inline`, per `commentPlacement`; the extension's own storage when `draft`
   *  (req 11.14 — nothing is written beside the document). */
  private makeCommentBackend(docUri: vscode.Uri): CommentBackend {
    const storage = this.settings.getCommentStorage()
    if (storage === 'draft') return new DraftBackend(docUri, this.context.globalStorageUri)
    if (storage !== 'inline') return new SidecarBackend(docUri)
    return this.settings.getCommentPlacement() === 'end-of-file'
      ? new InlineEofBackend()
      : new InlineAfterBackend()
  }

  /** The stores the selected backend must import from — one per OTHER medium (req 11.17).
   *  Inline is a single medium: an end-of-file carrier is read by the after-paragraph
   *  backend too, so one inline reader covers both placements. */
  private otherCommentBackends(docUri: vscode.Uri): CommentBackend[] {
    const current = this.makeCommentBackend(docUri).medium
    return [
      new SidecarBackend(docUri),
      new InlineAfterBackend(),
      new DraftBackend(docUri, this.context.globalStorageUri),
    ].filter((b) => b.medium !== current)
  }

  /** Host bindings for the project-wide import. Document writes go through the editor
   *  (open → edit → save), never a raw filesystem write — the same disciplined path as
   *  in-place paragraph save (req 7.14). */
  private importDeps(): ImportDeps {
    const renderer = new MarkdownRenderer(() => '')
    const anyDir = vscode.Uri.parse('file:///')
    return {
      listDocuments: () =>
        Promise.resolve(vscode.workspace.findFiles('**/*.md', '**/node_modules/**')),
      // Only an ALREADY-OPEN document can be dirty, so ask the open set first and read the
      // rest as bytes. Opening a TextDocument model for every .md in the project — which the
      // plan pass would do — is a needless memory hit on a large repo.
      readDocument: async (uri) => {
        const open = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString(),
        )
        if (open) return { text: open.getText(), dirty: open.isDirty }
        try {
          return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), dirty: false }
        } catch {
          return undefined
        }
      },
      writeDocument: async (uri, text) => {
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          const edit = new vscode.WorkspaceEdit()
          edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text)
          if (!(await vscode.workspace.applyEdit(edit))) return false
          // `save()` resolves false when the document is not dirty — which is exactly what
          // happens when files.autoSave already flushed our edit. That is a success, not a
          // failure, so ask the document whether it is on disk rather than trusting the
          // return value; otherwise the import reports a phantom failure.
          return (await doc.save()) || !doc.isDirty
        } catch {
          return false
        }
      },
      backendsFor: (uri) => ({
        target: this.makeCommentBackend(uri),
        sources: this.otherCommentBackends(uri),
      }),
      // Only the anchoring blocks are wanted; the rendered HTML (and therefore the image
      // resolver) is thrown away, hence the stub resolver.
      blocksOf: (source) =>
        blocksFromLineMap(renderer.renderMdast(renderer.parse(source), anyDir).lineMap, source),
    }
  }

  /** Move every project document's comments into the selected storage (req 11.18). */
  private async importAllComments(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]
    if (!root) {
      // No folder ⇒ nothing to walk and nowhere to put a failure report. Say so instead
      // of silently doing nothing.
      void vscode.window.showInformationMessage(
        t('Open a folder first — there is no project to import comments from.'),
      )
      return
    }

    const importer = new CommentImporter(this.importDeps())
    const plan = await importer.plan()
    if (plan.length === 0) {
      void vscode.window.showInformationMessage(
        t('Nothing to import: every comment is already in the selected storage.'),
      )
      return
    }

    const comments = plan.reduce((n, i) => n + i.commentCount, 0)
    const confirm = t('Import')
    const go = await vscode.window.showInformationMessage(
      t(
        '{0} comment(s) in {1} file(s) are stored elsewhere. Move them into the selected storage?',
        String(comments),
        String(plan.length),
      ),
      { modal: true },
      confirm,
    )
    if (go !== confirm) return

    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Importing comments…'),
        cancellable: true,
      },
      (progress, token) =>
        importer.run(
          plan,
          (item, done) =>
            progress.report({
              increment: 100 / plan.length,
              message: `${done}/${plan.length} — ${item.uri.path.split('/').pop() ?? ''}`,
            }),
          () => token.isCancellationRequested,
        ),
    )

    const summary = t(
      'Imported {0} comment(s) in {1} file(s). Failed: {2}.',
      String(outcome.movedComments),
      String(outcome.movedFiles),
      String(outcome.failures.length),
    )
    if (outcome.failures.length === 0) {
      void vscode.window.showInformationMessage(
        outcome.cancelled ? `${summary} ${t('Cancelled.')}` : summary,
      )
      return
    }

    // A report file appears ONLY on failure — a feature whose point is "no litter in the
    // repo" must not drop a file there after every successful run.
    const report = vscode.Uri.joinPath(root.uri, 'rmt-comment-import-errors.log')
    await vscode.workspace.fs.writeFile(
      report,
      new TextEncoder().encode(CommentImporter.formatReport(outcome)),
    )
    const show = t('Show report')
    const picked = await vscode.window.showWarningMessage(summary, show)
    if (picked === show) {
      void vscode.window.showTextDocument(await vscode.workspace.openTextDocument(report))
    }
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
    this.updateTitleContext() // and refresh the native-toolbar icon visibility
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

  /** Command: prompt for an AI Assistant provider's API key (masked) and store it
   *  in the keychain. Keyless IDE providers (`vscode-copilot`) need no
   *  key — inform the user and return (req 16.5). */
  private async promptSetAiKey(provider?: AssistantProviderType): Promise<void> {
    const p = provider ?? this.settings.getAiAssistantConfig().provider
    const label = ASSISTANT_PROVIDER_LABEL[p] ?? p
    if (KEYLESS_IDE_PROVIDERS.includes(p)) {
      void vscode.window.showInformationMessage(`${label} runs inside the IDE and requires no API key.`)
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
      await this.aiSecrets.deleteKey(p)
      void vscode.window.showInformationMessage(`${label} API key cleared.`)
    } else {
      await this.aiSecrets.saveKey(p, key.trim())
      void vscode.window.showInformationMessage(`${label} API key saved.`)
    }
    await this.refreshAiKey()
    for (const c of this.controllers) c.updateButtonState()
  }

  /** Command: build the AI Assistant provider with its stored key and report the
   *  test as a toast (req 16.7–16.9). Providers the factory does not support yet
   *  (openai/anthropic/google/vscode-copilot land in later tasks) throw
   *  from `createAssistantProvider` — caught and toasted, never crashed. */
  private async testAiConnection(provider?: AssistantProviderType): Promise<void> {
    const p = provider ?? this.settings.getAiAssistantConfig().provider
    const label = ASSISTANT_PROVIDER_LABEL[p] ?? p
    const key = (await this.aiSecrets.getKey(p)) ?? ''
    try {
      const cfg = { ...this.settings.getAiAssistantConfig(), provider: p }
      await createAssistantProvider(cfg, key, this.settings.getConfig()).testConnection()
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
    webview.html = getPreviewHtml(webview, scriptUri, nonce, codeThemeCss(this.settings.getCodeHighlightTheme()))

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
    // The comment layer needs to KNOW whether its write-back landed, which the paragraph-save
    // closure above throws away. `applyEdit` RESOLVES FALSE (it does not throw) when the
    // document version moved under us — and a rejected edit leaves the document
    // byte-identical, hence CLEAN, which is indistinguishable from "already saved" to the
    // disk probe below. Swallow that boolean and migrateFrom clears the source store for
    // carriers that were never written: comments in neither place.
    const writeComments = (newText: string): Promise<boolean> => {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), newText)
      return Promise.resolve(vscode.workspace.applyEdit(edit))
    }
    const commentsService = new CommentsService(
      document.uri,
      this.makeCommentBackend(document.uri),
      undefined, // default genId
      undefined, // default now
      undefined, // default flushMs
      () => document.getText(),
      writeComments,
      // The DISK probe. `save()` resolves FALSE when the document was not dirty, not only
      // when the save failed — and "already on disk" is a success for us (a second migrate
      // pass, or files.autoSave beating us to it). So ask whether the content is on disk,
      // never the return value alone. Whether the edit itself landed is a separate question,
      // answered by `writeComments` above; migrateFrom requires both.
      async () => (await document.save()) || !document.isDirty,
    )
    // Comments left in a store the user has since switched away from would otherwise look
    // lost. Read them all, merge, and move them into the selected store (req 11.17).
    if (this.settings.getCommentAutoImport()) {
      commentsService.setImportSources(this.otherCommentBackends(document.uri))
    }

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
      aiAssistant: () => this.settings.getAiAssistantConfig(),
      buildAssistantProvider: () => {
        const cfg = this.settings.getAiAssistantConfig()
        const key = this.aiKeyCache[cfg.provider] ?? ''
        return createAssistantProvider(cfg, key, this.settings.getConfig())
      },
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
      // Track focus so the native editor-title toolbar (req 3.21) reflects THIS
      // preview: when it becomes active, make it the command target and refresh the
      // `kiroMd.settingsMissing` context key from its state.
      webviewPanel.onDidChangeViewState(() => {
        if (webviewPanel.active) {
          this.active = controller
          this.updateTitleContext()
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
      // Re-paint the code-highlight theme live when the setting changes (req 12). Only
      // the stylesheet swaps — no re-render, no host round-trip for editor theme changes
      // (the `auto` pair is scoped by the webview's vscode-light/dark body class).
      this.settings.onDidChangeSettings(() => {
        void webview.postMessage({
          type: 'setCodeTheme',
          css: codeThemeCss(this.settings.getCodeHighlightTheme()),
        })
      }),
    ]

    webviewPanel.onDidDispose(() => {
      controller.dispose()
      subs.forEach((s) => s.dispose())
      this.controllers.delete(controller)
      if (this.active === controller) this.active = undefined
      this.updateTitleContext()
    })

    controller.start()
    this.updateTitleContext()
  }
}
