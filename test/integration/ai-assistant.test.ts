/**
 * Integration — the AI Assistant driving the REAL PreviewController (journeys J15, J16).
 *
 * The unit suite already covers each part in isolation: `PreviewController.aiAssistant`
 * stubs every collaborator (a renderer that returns `<p>${md}</p>`, `engine: {}`, a
 * comments-service object literal, no document at all), `AssistantSession` scripts a
 * provider, `assistant-context` hand-feeds `buildContext`, `IdeAssistant` calls the
 * provider directly. None of them can see the WIRING: whether the context the controller
 * assembles out of a real lineMap, a real sidecar and real settings is the one the README
 * promises; whether an applied edit really reaches the document; whether a saved summary
 * really reaches the comment store; whether the factory→session→controller chain over
 * `vscode.lm` picks the right model.
 *
 * So everything here is real except the two NETWORK boundaries — the translation provider
 * and the assistant provider — which use global `fetch` and must be scripted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as vscode from '../mocks/vscode'
import { PreviewController, type PreviewDeps } from '../../src/PreviewController'
import { MarkdownRenderer } from '../../src/MarkdownRenderer'
import { TranslationEngine } from '../../src/TranslationEngine'
import { TranslationCache } from '../../src/TranslationCache'
import { CommentsService } from '../../src/CommentsService'
import { SidecarBackend } from '../../src/commentBackends'
import { SettingsManager } from '../../src/SettingsManager'
import { ExportService } from '../../src/ExportService'
import { createAssistantProvider } from '../../src/assistant/AssistantProviderFactory'
import type { AssistantMessage, IAssistantProvider } from '../../src/assistant/types'
import type { ExtensionMessage, ITranslationProvider, WebviewMessage } from '../../src/types'

// --- the document under test -------------------------------------------------

const DOC_PATH = '/docs/retry.md'
const DOC_URI = vscode.Uri.file(DOC_PATH)
const SIDECAR_PATH = `${DOC_PATH}.comments.json`

/** Lines are numbered because both halves of this journey are line-exact: the block
 *  indices the webview sends come from the rendered lineMap, and the save splices a
 *  line range back into the source. */
const DOC_TEXT = [
  '# Retry guide', //               0  → block 0
  '', //                            1
  '## Retry policy', //             2  → block 1
  '', //                            3
  'The client retries once.', //    4  → block 2
  '', //                            5
  'Backoff is fixed at 200 ms.', // 6  → block 3
  '', //                            7
  '## Limits', //                   8  → block 4
  '', //                            9
  'Ten requests per minute.', //   10  → block 5
].join('\n')

const REVIEW_COMMENT = 'Reviewer asked for a rewrite: say what happens when the retry also fails.'

/** A sidecar as it would be on disk from a previous session: one comment on block 2.
 *  `docHash` is empty on purpose, so the thread is re-anchored by CONTENT (the path a
 *  document that has been edited since takes) rather than by the hintLine fast path. */
const SIDECAR_SEED = JSON.stringify(
  {
    version: 1,
    docHash: '',
    threads: [
      {
        anchor: {
          quote: 'The client retries once.',
          prefix: '## Retry policy',
          suffix: 'Backoff is fixed at 200 ms.',
          hintLine: 4,
          quoteHash: 'seed',
        },
        orphaned: false,
        comments: [
          {
            id: 'c-review',
            createdAt: '2026-07-01T09:00:00.000Z',
            updatedAt: '2026-07-01T09:00:00.000Z',
            body: REVIEW_COMMENT,
          },
        ],
      },
    ],
  },
  null,
  2,
)

// --- scripted network boundaries ---------------------------------------------

/** Records every batch it was asked to translate, so "did the edit trigger a
 *  translation update" (req 7.4) is answerable. */
function recordingTranslationProvider(seen: string[][]): ITranslationProvider {
  return {
    id: 'fake',
    displayName: 'Fake translation provider',
    async translateBatch(segments) {
      seen.push([...segments])
      return segments.map((s) => `[ru] ${s}`)
    },
    async getSupportedLanguages() {
      return []
    },
    async testConnection() {},
  }
}

/**
 * Replies with `script[n]` on the n-th turn and records the messages it received.
 * Chunked with `[\s\S]{1,3}` rather than `.{1,3}` — `.` excludes `\n`, and dropping a
 * newline would silently corrupt the multi-line ```rmt-edit fence being streamed.
 */
function scriptedAssistant(script: string[], seen: AssistantMessage[][]): IAssistantProvider {
  let turn = 0
  return {
    id: 'ollama',
    displayName: 'Fake assistant',
    async *chat(messages) {
      seen.push(messages.map((m) => ({ ...m })))
      const text = script[turn++] ?? ''
      for (const chunk of text.match(/[\s\S]{1,3}/g) ?? []) yield chunk
    },
    async testConnection() {},
  }
}

/** A `vscode.lm` model that records when it was the one actually asked, and with what. */
function lmModel(
  vendor: string,
  family: string,
  parts: string[],
  used: string[],
  received: string[] = [],
): vscode.MockLmModel {
  return {
    vendor,
    family,
    id: `${vendor}/${family}`,
    name: `${vendor} ${family}`,
    sendRequest: async (messages) => {
      used.push(`${vendor}/${family}`)
      received.push(...messages.map((m) => m.content))
      return {
        text: (async function* () {
          for (const part of parts) yield part
        })(),
      }
    },
  }
}

// --- the harness: PreviewController wired the way ActivationController wires it ---

interface Harness {
  controller: PreviewController
  doc: vscode.MockTextDocument
  comments: CommentsService | undefined
  /** Everything the host posted to the webview, oldest first. */
  posted: () => ExtensionMessage[]
  clearPosted: () => void
  /** Deliver a webview→host message through the webview seam, as the panel does. */
  send: (message: WebviewMessage) => void
  translated: string[][]
  dispose: () => void
}

function openPreview(
  buildAssistantProvider: () => IAssistantProvider,
  opts: { comments?: boolean } = {},
): Harness {
  const settings = new SettingsManager()
  const doc = vscode.__addTextDocument(new vscode.MockTextDocument(DOC_URI, DOC_TEXT))
  const webview = new vscode.MockWebview()
  const renderer = new MarkdownRenderer((rel) => `webview://${rel}`)
  const cache = new TranslationCache()
  const translated: string[][] = []
  const provider = recordingTranslationProvider(translated)
  const engine = new TranslationEngine(() => provider, cache, renderer, () => settings.getGlossary())

  // Same closures ActivationController.resolveCustomTextEditor installs: the document is
  // written through a WorkspaceEdit, never a raw filesystem write.
  const replaceAll = (newText: string) => {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText)
    return vscode.workspace.applyEdit(edit)
  }
  const comments =
    opts.comments === false
      ? undefined
      : new CommentsService(
          doc.uri as never,
          new SidecarBackend(doc.uri as never), // default fsIO → the mock's workspace.fs
          undefined, // default id generator
          undefined, // default timestamp
          undefined, // default 500 ms flush debounce
          () => doc.getText(),
          replaceAll,
          async () => (await doc.save()) || !doc.isDirty,
        )

  const deps: PreviewDeps = {
    post: (message) => void webview.postMessage(message),
    renderer,
    engine,
    cache,
    settings,
    exportService: new ExportService(),
    commentsService: comments,
    getDocumentText: () => doc.getText(),
    getDocumentUri: () => doc.uri as never,
    applyEdit: async (newText) => {
      await replaceAll(newText)
    },
    aiAssistant: () => settings.getAiAssistantConfig(),
    buildAssistantProvider,
  }

  const controller = new PreviewController(deps)
  const subs = [
    webview.onDidReceiveMessage((m) => controller.onWebviewMessage(m as WebviewMessage)),
    // The host's own subscription: a document edit (including the one applyEdit just made)
    // comes back in through onDidChangeTextDocument, which is what makes req 7.4 work.
    vscode.workspace.onDidChangeTextDocument((e) => {
      const changed = (e as { document: vscode.MockTextDocument }).document
      if (changed.uri.toString() === doc.uri.toString()) controller.onDocumentChange(changed as never)
    }),
  ]

  return {
    controller,
    doc,
    comments,
    posted: () => webview.posted as ExtensionMessage[],
    clearPosted: () => webview.__clearPosted(),
    send: (message) => webview.__receive(message),
    translated,
    dispose: () => {
      controller.dispose()
      subs.forEach((s) => s.dispose())
    },
  }
}

/** Let pending promise chains settle; with fake timers on, also runs debounces up to `ms`. */
const settle = (ms = 0): Promise<void> => vi.advanceTimersByTimeAsync(ms)

function messagesOf<T extends ExtensionMessage['type']>(
  posted: ExtensionMessage[],
  type: T,
): Array<Extract<ExtensionMessage, { type: T }>> {
  return posted.filter((m): m is Extract<ExtensionMessage, { type: T }> => m.type === type)
}

beforeEach(() => {
  vscode.__resetHost()
  vscode.__clearConfig()
  vscode.__setLmModels([])
  vscode.__setAppName('Test Host')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// =============================================================================
// J15 — ask over a selection, apply the suggested edit, keep the discussion
// =============================================================================

describe('J15: Ask AI over a multi-block selection', () => {
  const CUSTOM_PROMPT = 'You are the retry-policy reviewer. Be terse.'

  function seedJ15(over: Record<string, unknown> = {}): void {
    vscode.__setFile(SIDECAR_PATH, SIDECAR_SEED)
    vscode.__setConfig('kiro-md-translator', {
      storageLanguage: 'en',
      'aiAssistant.enabled': true,
      'aiAssistant.provider': 'ollama',
      'aiAssistant.systemPrompt': CUSTOM_PROMPT,
      ...over,
    })
  }

  it('sends the selection, the source of the selected blocks, the headings, the document and the block comments — and shows the comments to nobody', async () => {
    // README: "The model is given what you highlighted, the source of the blocks it
    // touches, the headings above it, the document itself, and any comments already
    // attached to that block". Req 5.4/5.5 add the sharp edge: those comments go to the
    // LLM and NEVER into the dialog UI. Req 6.4: the configured System_Prompt is used.
    seedJ15()
    const turns: AssistantMessage[][] = []
    const h = openPreview(() => scriptedAssistant(['Once is optimistic.'], turns))
    await h.comments!.load()
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })
    await settle()

    // The webview's selection spans blocks 2 and 3 (rendered text, so the markdown
    // markup of the source is not what the user highlighted).
    h.send({
      type: 'askAiOpen',
      paragraphIndex: 2,
      lastIndex: 3,
      selection: 'retries once. Backoff is fixed',
      translated: false,
    })
    await settle()
    h.send({ type: 'askAiSend', text: 'Why only once?' })
    await settle()

    expect(turns).toHaveLength(1)
    const [system, user] = turns[0]
    expect(system).toEqual({ role: 'system', content: CUSTOM_PROMPT })
    expect(user.role).toBe('user')
    expect(user.content).toContain('The user selected: "retries once. Backoff is fixed"')
    // The RAW SOURCE of blocks 2..3 — the selected span, not just the first block, and
    // read out of the live lineMap rather than a hand-written one.
    expect(user.content).toContain(
      'Source of the selected block(s):\nThe client retries once.\n\nBackoff is fixed at 200 ms.',
    )
    expect(user.content).toContain('Location: # Retry guide › ## Retry policy')
    expect(user.content).toContain(`Full document:\n${DOC_TEXT}`)
    expect(user.content).toContain(REVIEW_COMMENT)

    const open = messagesOf(h.posted(), 'assistantOpen')
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ selection: 'retries once. Backoff is fixed', commentCount: 1 })
    // req 5.4: the dialog is told HOW MANY comments were sent, never their text.
    expect(JSON.stringify(h.posted())).not.toContain(REVIEW_COMMENT)

    h.dispose()
  })

  it('applies a suggested rewrite through the paragraph-edit path: nothing is written until the user saves, then exactly those lines change', async () => {
    // README: "Apply Changes … opens the usual paragraph-edit dialog pre-filled with the
    // suggestion in the file's storage language, so you review and save it yourself —
    // nothing is written behind your back — and the chat stays open so you can iterate."
    // Req 7.3: applied "using the existing text editing infrastructure" — i.e. the
    // surgical line splice, not a re-serialization of the document.
    seedJ15({ targetLanguage: 'ru', translationMode: 'automatic' })
    const reply = [
      'Here is a tighter version.',
      '',
      'For reference, the current constant is:',
      '',
      '```js',
      'const RETRIES = 1',
      '```',
      '',
      '```rmt-edit',
      'The client retries up to three times.',
      '',
      'Backoff doubles from 200 ms.',
      '```',
    ].join('\n')
    const editBody = 'The client retries up to three times.\n\nBackoff doubles from 200 ms.'

    const turns: AssistantMessage[][] = []
    const h = openPreview(() => scriptedAssistant([reply], turns))
    await h.comments!.load()
    await h.controller.renderNow()
    h.send({ type: 'askAiOpen', paragraphIndex: 2, lastIndex: 3, selection: 'retries once', translated: false })
    await settle()
    h.send({ type: 'askAiSend', text: 'Rewrite this section: three retries, doubling backoff.' })
    await settle()

    // The stream reaches the webview intact and in order.
    const chunks = messagesOf(h.posted(), 'assistantChunk').map((m) => m.text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(reply)
    const replies = messagesOf(h.posted(), 'assistantReply')
    expect(replies).toHaveLength(1)
    // The ```js block is a quotation, only the ```rmt-edit fence is an offer to edit.
    expect(replies[0].canApply).toBe(true)

    h.clearPosted()
    h.send({ type: 'askAiApply' })
    await settle()

    const modals = messagesOf(h.posted(), 'openEditModal')
    expect(modals).toHaveLength(1)
    expect(modals[0]).toMatchObject({ paragraphIndex: 2, lastIndex: 3, storageText: editBody, targetText: '' })
    // "nothing is written behind your back": Apply only opens the dialog.
    expect(h.doc.getText()).toBe(DOC_TEXT)
    expect(h.doc.isDirty).toBe(false)
    // "the chat stays open" (req 7.6) — the session is not torn down.
    expect(messagesOf(h.posted(), 'assistantClosed')).toHaveLength(0)

    // The user reviews and saves, exactly as the edit modal does.
    h.send({ type: 'saveParagraph', paragraphIndex: 2, lastIndex: 3, storageText: editBody, targetText: '' })
    await settle()

    expect(h.doc.getText()).toBe(
      [
        '# Retry guide',
        '',
        '## Retry policy',
        '',
        'The client retries up to three times.',
        '',
        'Backoff doubles from 200 ms.',
        '',
        '## Limits',
        '',
        'Ten requests per minute.',
      ].join('\n'),
    )
    // The quoted code was never part of the edit, so it never reached the file.
    expect(h.doc.getText()).not.toContain('const RETRIES')

    // req 7.4: an applied edit triggers a translation update through the engine — and it
    // is the NEW text that goes out, not the text the model was asked to rewrite.
    await settle(1500)
    const segments = h.translated.flat()
    expect(segments).toContain('The client retries up to three times.')
    expect(segments).not.toContain('The client retries once.')

    h.dispose()
  })

  it('saves the discussion as a real comment on the selected block — silently, and into the sidecar on disk', async () => {
    // README: "Save Summary … asks it to condense the discussion into a short note and
    // saves that as a comment on the block you selected, in whichever comment store you
    // use." Reqs 8.1/8.2/8.5/8.7. The summarization turn is deliberately HIDDEN: the user
    // pressed Save Summary, not Send, and the webview opens an AI bubble lazily on the
    // first assistantChunk it sees.
    seedJ15()
    const summary = 'Retries go from one to three with doubling backoff; failures are logged.'
    const turns: AssistantMessage[][] = []
    const h = openPreview(() => scriptedAssistant(['Three retries would be safer.', summary], turns))
    await h.comments!.load()
    await h.controller.renderNow()
    h.send({ type: 'requestComments' }) // the webview pulls after every render; start() does it too
    await settle()
    h.send({ type: 'askAiOpen', paragraphIndex: 2, lastIndex: 3, selection: 'retries once', translated: false })
    await settle()
    h.send({ type: 'askAiSend', text: 'How many retries should we use?' })
    await settle()

    h.clearPosted()
    h.send({ type: 'askAiSaveSummary' })
    await settle()

    // req 8.1: the whole discussion goes back to the model with a summarization prompt.
    expect(turns).toHaveLength(2)
    const summarizeTurn = turns[1]
    // req 6.4 says "every LLM request", and the hidden turn is one of them.
    expect(summarizeTurn[0]).toEqual({ role: 'system', content: CUSTOM_PROMPT })
    expect(summarizeTurn.map((m) => m.content)).toContain('How many retries should we use?')
    expect(summarizeTurn.map((m) => m.content)).toContain('Three retries would be safer.')
    expect(summarizeTurn[summarizeTurn.length - 1].role).toBe('user')
    expect(summarizeTurn[summarizeTurn.length - 1].content).toMatch(/summar/i)

    // The hidden turn must not stream into the chat log, and must not look like a reply.
    expect(messagesOf(h.posted(), 'assistantChunk')).toHaveLength(0)
    expect(messagesOf(h.posted(), 'assistantReply')).toHaveLength(0)
    expect(messagesOf(h.posted(), 'assistantClosed')).toHaveLength(1) // req 8.5

    // req 8.3: anchored to the block the user selected — the seeded comment's block.
    const forBlocks = messagesOf(h.posted(), 'commentsForBlocks').at(-1)
    expect(forBlocks?.blocks).toEqual([{ paragraphIndex: 2, count: 2 }])

    // req 8.2/8.7: it went through CommentsService into the selected store. Let the 500 ms
    // flush debounce fire and read the bytes back out of the filesystem.
    await settle(600)
    const onDisk = JSON.parse(vscode.__getFile(SIDECAR_PATH) as string) as {
      threads: Array<{ comments: Array<{ body: string }> }>
    }
    expect(onDisk.threads).toHaveLength(1)
    expect(onDisk.threads[0].comments.map((c) => c.body)).toEqual([REVIEW_COMMENT, summary])

    h.dispose()
  })

  // DEFECT, reported rather than asserted — the assertion below would fail today, and a
  // test that instead pinned the current behaviour would be worthless. `addComment`
  // returns `Comment | undefined`; `saveAssistantSummary` (src/PreviewController.ts:397)
  // drops that return. Two reachable inputs make it undefined: a blank/whitespace summary
  // from the model (src/CommentsService.ts:272) and a block that no longer anchors
  // (src/CommentsService.ts:291). In both cases the host posts `assistantClosed` — the
  // success signal — the dialog closes, the conversation is discarded (req 4.8) and the
  // summary exists nowhere. Verified by driving this suite's harness with a whitespace
  // summary and with a stale paragraphIndex: the sidecar keeps only the seeded comment and
  // no `assistantError` is ever posted. Req 17.8 promises "Failed to save summary as
  // comment: <reason>"; req 8.6 promises the dialog stays open when the save fails.
  it.todo('reports an error and stays open when the summary cannot be stored (req 17.8 / 8.6)')
})

// =============================================================================
// J16 — the vscode-copilot provider over the host's language-model registry
// =============================================================================

describe('J16: the GitHub Copilot Chat provider', () => {
  /** Req 17.3, verbatim. The requirement quotes the message between quotation marks, so
   *  the sentence-final period is the only character not inside its quotes. */
  const COPILOT_UNAVAILABLE =
    'No GitHub Copilot chat model is available. Either GitHub Copilot is not installed and signed in, ' +
    'or it has not granted this extension access to its models yet. Run "Markdown Translator: Test AI ' +
    'Assistant Connection" from the Command Palette and approve the access prompt, then try again — or ' +
    'reload the window if access was already granted.'

  const COPILOT_PROMPT = 'You are the retry-policy reviewer. Answer in one line.'

  /** No `aiAssistant.provider` is seeded on purpose: in real VS Code the effective
   *  default has to resolve to vscode-copilot by itself (README + req 13.1). */
  function seedJ16(): SettingsManager {
    vscode.__setAppName('Visual Studio Code')
    vscode.__setConfig('kiro-md-translator', {
      storageLanguage: 'en',
      'aiAssistant.enabled': true,
      'aiAssistant.systemPrompt': COPILOT_PROMPT,
    })
    return new SettingsManager()
  }

  /** Exactly ActivationController's `buildAssistantProvider`, with an EMPTY key — req
   *  13.4/1.6: this provider needs no API key at all. */
  const buildFrom = (settings: SettingsManager) => () =>
    createAssistantProvider(settings.getAiAssistantConfig(), '', settings.getConfig())

  it('streams a Copilot reply end to end, choosing a Copilot model even when the configured family is missing', async () => {
    // README: "GitHub Copilot Chat | not needed | Real VS Code only … Model is a Copilot
    // model family, claude-sonnet-4.5 by default, falling back to any Copilot model your
    // account can use." Reqs 13.2/13.5/13.6.
    const settings = seedJ16()
    expect(settings.getAiAssistantConfig().provider).toBe('vscode-copilot')

    const used: string[] = []
    const received: string[] = []
    // The decoy carries the DEFAULT family, so a family-first lookup that forgot the
    // vendor constraint would hand the user's document to another lm provider entirely.
    vscode.__setLmModels([
      lmModel('openrouter', 'claude-sonnet-4.5', ['WRONG'], used),
      lmModel('copilot', 'gpt-4o', ['Hel', 'lo ', '**world**'], used, received),
    ])

    const h = openPreview(buildFrom(settings), { comments: false })
    await h.controller.renderNow()
    h.send({ type: 'askAiOpen', paragraphIndex: 2, selection: 'retries once', translated: false })
    await settle()
    h.send({ type: 'askAiSend', text: 'Explain this.' })
    await settle()

    expect(used).toEqual(['copilot/gpt-4o'])
    // The context survived the whole chain — settings → factory → session → IdeAssistant →
    // vscode.lm — and reached the model itself (req 6.4/5.1/5.2).
    expect(received.join('\n')).toContain(COPILOT_PROMPT)
    expect(received.join('\n')).toContain('Explain this.')
    expect(received.join('\n')).toContain('The client retries once.')
    expect(messagesOf(h.posted(), 'assistantChunk').map((m) => m.text)).toEqual(['Hel', 'lo ', '**world**'])
    const replies = messagesOf(h.posted(), 'assistantReply')
    expect(replies).toHaveLength(1)
    expect(replies[0].html).toContain('<strong>world</strong>') // rendered by the real renderer
    expect(replies[0].canApply).toBe(false)
    // No key was ever supplied, and none was ever asked for.
    expect(messagesOf(h.posted(), 'assistantError')).toHaveLength(0)
    expect(JSON.stringify(h.posted())).not.toContain('API key')

    h.dispose()
  })

  it('names BOTH causes when no Copilot model can be selected — whether none exists or only another vendor does', async () => {
    // Req 17.3: `selectChatModels` returns [] both when Copilot is absent and when it has
    // not granted this extension access, and the public API cannot tell them apart — so
    // the one message must offer both. Req 17.9: the detail is logged for debugging.
    const settings = seedJ16()
    const registries: Array<[string, vscode.MockLmModel[]]> = [
      ['no language models at all', []],
      ['only a non-Copilot vendor', [lmModel('openrouter', 'claude-sonnet-4.5', ['WRONG'], [])]],
    ]

    for (const [label, models] of registries) {
      vscode.__setLmModels(models)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const h = openPreview(buildFrom(settings), { comments: false })
      await h.controller.renderNow()
      h.send({ type: 'askAiOpen', paragraphIndex: 2, selection: 'retries once', translated: false })
      await settle()
      h.send({ type: 'askAiSend', text: 'Explain this.' })
      await settle()

      const errors = messagesOf(h.posted(), 'assistantError')
      expect(errors, label).toHaveLength(1)
      expect(errors[0].message, label).toBe(COPILOT_UNAVAILABLE)
      expect(messagesOf(h.posted(), 'assistantReply'), label).toHaveLength(0)
      expect(logged, label).toHaveBeenCalled()

      logged.mockRestore()
      h.dispose()
      vscode.__resetDocuments()
    }
  })
})
