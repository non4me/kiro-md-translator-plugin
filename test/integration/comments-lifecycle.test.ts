/**
 * Integration — the whole life of a comment (journeys J6–J9).
 *
 * Everything here runs the REAL chain: MarkdownRenderer → lineMap → blocksFromLineMap →
 * anchoring → CommentsService → a real persistence backend, driven through the webview
 * message protocol of a real PreviewController (and, for the storage switch, through
 * ActivationController + the real SettingsManager over the host mock).
 *
 * The unit suite already covers each layer with hand-built `Block[]` arrays and injected
 * IO. What it cannot cover is the seam: that the paragraph indices a comment is anchored
 * to are the ones the renderer really assigns (`li`/`pre`/`tr` included since 0.7.0), that
 * the bytes really land in `<name>.comments.json`, and that the backend swap wired to the
 * settings event really re-homes them. Hence: no stubbed collaborators, no
 * `primeRenderState`, no injected `SidecarIO` — the default `fsIO` writes to the mock's
 * in-memory `workspace.fs` and the tests read it back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fromHtml } from 'hast-util-from-html'
import * as vscode from '../mocks/vscode'
import { PreviewController, type PreviewDeps } from '../../src/PreviewController'
import { MarkdownRenderer } from '../../src/MarkdownRenderer'
import { TranslationEngine } from '../../src/TranslationEngine'
import { TranslationCache } from '../../src/TranslationCache'
import { CommentsService } from '../../src/CommentsService'
import { SidecarBackend } from '../../src/commentBackends'
import { SettingsManager } from '../../src/SettingsManager'
import { ExportService } from '../../src/ExportService'
import { ActivationController } from '../../src/ActivationController'
import { parseInline } from '../../src/inlineComments'
import type {
  BlockCommentCount,
  Comment,
  CommentsFile,
  ExtensionMessage,
  ITranslationProvider,
  WebviewMessage,
} from '../../src/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type HastNode = any

const DOC_URI = vscode.Uri.file('/docs/guide.md')
/** Where `sidecarUri(DOC_URI)` lands once the mock filesystem collapses its `..`. */
const SIDECAR = 'file:///docs/guide.md.comments.json'

// --- helpers ---------------------------------------------------------------

/** Translates by rewriting each segment through `map`; never touches the network. */
function fakeProvider(map: (segment: string) => string = (s) => s): ITranslationProvider {
  return {
    id: 'fake',
    displayName: 'Fake',
    async translateBatch(segments) {
      return segments.map(map)
    },
    async getSupportedLanguages() {
      return []
    },
    async testConnection() {},
  }
}

/**
 * The text a webview selection carries for one rendered block — the element's
 * `textContent`. Fragment quotes are captured from the DOM, so a quote built any other
 * way would not be the one the product actually stores.
 */
function renderedBlockText(html: string, paragraphIndex: number): string {
  const textOf = (node: HastNode): string =>
    node.type === 'text' ? String(node.value) : (node.children ?? []).map(textOf).join('')
  let found: string | undefined
  const walk = (node: HastNode): void => {
    if (found !== undefined) return
    if (node.type === 'element' && String(node.properties?.dataParagraphIndex) === String(paragraphIndex)) {
      found = textOf(node)
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(fromHtml(html, { fragment: true }))
  if (found === undefined) throw new Error(`the render has no block ${paragraphIndex}`)
  return found
}

function lastOf<T extends ExtensionMessage['type']>(
  posted: ExtensionMessage[],
  type: T,
): Extract<ExtensionMessage, { type: T }> {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i].type === type) return posted[i] as Extract<ExtensionMessage, { type: T }>
  }
  throw new Error(`no ${type} was posted`)
}

const blocksOf = (posted: ExtensionMessage[]): BlockCommentCount[] => lastOf(posted, 'commentsForBlocks').blocks
const orphansOf = (posted: ExtensionMessage[]) => lastOf(posted, 'orphanedComments').threads

/** Read the sidecar back the way a fresh session would. */
function readSidecar(): CommentsFile | undefined {
  const raw = vscode.__getFile(SIDECAR)
  return raw === undefined ? undefined : (JSON.parse(raw) as CommentsFile)
}

/**
 * One open preview over `source`: real renderer, real engine, real comment store on the
 * real (mock) filesystem. `flushMs` is effectively infinite so persistence happens exactly
 * where a test asks for it — the debounce itself is a unit concern.
 */
function openPreview(source: string, translate?: (segment: string) => string) {
  const doc = vscode.__addTextDocument(new vscode.MockTextDocument(DOC_URI, source))
  const posted: ExtensionMessage[] = []
  const renderer = new MarkdownRenderer((rel) => `vscode-webview://res/${rel}`)
  const provider = fakeProvider(translate)
  const cache = new TranslationCache()
  const engine = new TranslationEngine(() => provider, cache, renderer)
  let seq = 0
  const comments = new CommentsService(
    DOC_URI as never,
    new SidecarBackend(DOC_URI as never),
    () => `c${seq++}`,
    () => '2026-07-27T00:00:00Z',
    1_000_000,
    () => doc.getText(),
  )
  const deps: PreviewDeps = {
    post: (message) => void posted.push(message),
    renderer,
    engine,
    cache,
    settings: new SettingsManager(),
    exportService: new ExportService(),
    commentsService: comments,
    getDocumentText: () => doc.getText(),
    getDocumentUri: () => DOC_URI as never,
  }
  const controller = new PreviewController(deps)
  return {
    controller,
    comments,
    posted,
    send: (message: WebviewMessage) => controller.onWebviewMessage(message),
    /** Rewrite the document as an editor would, and tell the preview about it. */
    edit: (text: string) => {
      doc.__setText(text)
      controller.onDocumentChange(doc as never)
    },
  }
}

beforeEach(() => {
  vscode.__resetHost()
  vscode.__clearConfig()
  vscode.__setConfig('kiro-md-translator', {
    storageLanguage: 'en',
    targetLanguage: 'de',
    translationMode: 'on-demand',
    providerType: 'ollama',
  })
})

// --- J6 --------------------------------------------------------------------

/**
 * README: "comments re-anchor to their text as the original is edited … If a commented
 * block is deleted, its comments are shown under Outdated comments rather than lost or
 * moved to the wrong block." (reqs 11.2, 11.4, 11.8, 11.9)
 */
describe('J6 — a comment follows its text, and orphans instead of moving', () => {
  const GUIDE = [
    '# Guide',
    '',
    'Intro paragraph about the project.',
    '',
    'The translation pipeline keeps the storage language on disk.',
    '',
    'Closing note.',
  ].join('\n')

  // Two paragraphs inserted above the commented one, which is itself lightly reworded.
  const GUIDE_EDITED = [
    '# Guide',
    '',
    'Intro paragraph about the project.',
    '',
    'Newly added paragraph one.',
    '',
    'Newly added paragraph two.',
    '',
    'The translation pipeline keeps the storage language on disk at all times.',
    '',
    'Closing note.',
  ].join('\n')

  // The commented paragraph is rewritten from scratch — the block is gone as content.
  const GUIDE_REWRITTEN = [
    '# Guide',
    '',
    'Intro paragraph about the project.',
    '',
    'Both languages are chosen in the settings page.',
    '',
    'Closing note.',
  ].join('\n')

  it('re-anchors to the shifted block and refreshes the hint line it persisted', async () => {
    const h = openPreview(GUIDE)
    await h.comments.load()
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })
    h.send({ type: 'addComment', paragraphIndex: 2, body: 'Is this still true?' })
    await h.comments.flush()

    // The comment really reached `<name>.comments.json` through the default fsIO.
    expect(vscode.__listFiles()).toContain(SIDECAR)
    const stored = readSidecar()!
    expect(stored.threads[0].comments[0].body).toBe('Is this still true?')
    // Anchored to the paragraph the renderer indexed as 2, at its real source line.
    expect(stored.threads[0].anchor.quote).toBe(
      'The translation pipeline keeps the storage language on disk.',
    )
    expect(stored.threads[0].anchor.hintLine).toBe(4)
    expect(blocksOf(h.posted)).toEqual([{ paragraphIndex: 2, count: 1 }])

    h.edit(GUIDE_EDITED)
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })

    // Two paragraphs above ⇒ the same comment, now on block 4 and on no other block.
    expect(blocksOf(h.posted)).toEqual([{ paragraphIndex: 4, count: 1 }])
    expect(orphansOf(h.posted)).toEqual([])

    await h.comments.flush()
    const reanchored = readSidecar()!
    expect(reanchored.threads[0].anchor.hintLine).toBe(8)
    expect(reanchored.threads[0].anchor.quote).toBe(
      'The translation pipeline keeps the storage language on disk at all times.',
    )
    expect(reanchored.threads[0].comments[0].id).toBe(stored.threads[0].comments[0].id)
  })

  it('orphans the thread when its paragraph is rewritten, rather than adopting a neighbour', async () => {
    const h = openPreview(GUIDE)
    await h.comments.load()
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })
    h.send({ type: 'addComment', paragraphIndex: 2, body: 'Outdated after the rewrite.' })
    expect(blocksOf(h.posted)).toEqual([{ paragraphIndex: 2, count: 1 }])

    h.edit(GUIDE_REWRITTEN)
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })

    // Not re-pinned to the paragraph that took its place, nor to any other block…
    expect(blocksOf(h.posted)).toEqual([])
    // …and surfaced under "Outdated comments" with its quote, so the user can act on it.
    expect(orphansOf(h.posted)).toEqual([
      {
        quote: 'The translation pipeline keeps the storage language on disk.',
        comments: [expect.objectContaining({ body: 'Outdated after the rewrite.' })],
      },
    ])

    // An orphan is never deleted automatically (req 11.9) — it must survive a save.
    await h.comments.flush()
    expect(readSidecar()!.threads[0].comments[0].body).toBe('Outdated after the rewrite.')
  })

  it('req 10.12: a fragment whose text was deleted orphans after a reopen, never re-pins to the block', async () => {
    // "A fragment whose text no longer exists in its re-matched block SHALL be orphaned
    // (11.9), never re-pinned to the whole block." README frames re-anchoring as working
    // "even while the preview is closed", so closing and reopening the document must not
    // change the answer — the sidecar is the only thing carrying the comment across.
    // The edit below leaves the BLOCK all but identical (it still matches on content) so
    // the fragment rule, and nothing else, decides the outcome.
    //
    // KNOWN DEFECT — this second half currently fails. `serializeCommentsFile` writes the
    // fragment out, but `normalizeThread` (src/commentSidecar.ts:81-94) rebuilds the anchor
    // from five fields only, silently dropping `fragment` and `end`. So a reopened sidecar
    // (or draft) comment is a plain whole-block comment: the fragment rule stops applying,
    // and a multi-block span loses the `end` that spreads its highlight. Inline storage
    // keeps both (`parseInline` does not normalize), which is what shows this is an
    // oversight rather than a design choice. Do not relax the assertion — fix the reader.
    const edited = GUIDE.replace('the storage language on disk', 'the storage locale on disk')

    const first = openPreview(GUIDE)
    await first.comments.load()
    await first.controller.renderNow()
    first.send({ type: 'requestComments' })
    first.send({
      type: 'addComment',
      paragraphIndex: 2,
      body: 'Which languages?',
      fragment: { quote: 'the storage language', prefix: 'keeps ', suffix: ' on disk' },
    })
    await first.comments.flush()
    expect(blocksOf(first.posted)).toEqual([
      { paragraphIndex: 2, count: 1, fragments: ['the storage language'] },
    ])

    // Same session, phrase deleted: orphaned, as req 10.12 demands.
    first.edit(edited)
    await first.controller.renderNow()
    first.send({ type: 'requestComments' })
    expect(blocksOf(first.posted)).toEqual([])
    expect(orphansOf(first.posted)).toHaveLength(1)

    // Reopen the document: a brand-new store over the same sidecar file. The comment
    // crossed sessions in `<name>.comments.json`, so the same edit must yield the same
    // answer — the block it once pointed at is NOT a valid home for it any more.
    const second = openPreview(edited)
    await second.comments.load()
    await second.controller.renderNow()
    second.send({ type: 'requestComments' })

    expect(blocksOf(second.posted)).toEqual([])
    expect(orphansOf(second.posted)).toHaveLength(1)
  })
})

// --- J7 --------------------------------------------------------------------

/**
 * CHANGELOG 0.8.0: "A comment on a phrase no longer disappears when made on the translated
 * view… Such a comment is now anchored to its block instead. (A fragment whose source text
 * really was deleted still shows up under Outdated comments, as before.)" (reqs 10.12, 11.9)
 */
describe('J7 — a comment made on the translated preview keeps its block', () => {
  const RENDERING = [
    '# Rendering',
    '',
    'The preview keeps a stable index per block.',
    '',
    'Call the `renderNow` helper to force a _synchronous_ redraw.',
    '',
    'Everything else is unchanged.',
  ].join('\n')

  const EDITED = RENDERING.replace(
    'Everything else is unchanged.',
    'Everything else is unchanged in this release.',
  )

  /** Comment the given rendered fragment of block 2, then edit an unrelated block. */
  async function commentOnTheTranslation(translated: boolean | undefined) {
    const h = openPreview(RENDERING, (s) => `Ü(${s})`)
    await h.comments.load()
    await h.controller.renderNow()
    h.send({ type: 'requestComments' }) // the webview pulls after every render
    h.send({ type: 'translateRequest' })
    await vi.waitFor(() => lastOf(h.posted, 'translationComplete'))
    const shown = lastOf(h.posted, 'translationComplete').translatedHtml

    // Exactly what a selection across the inline code and the emphasis would carry.
    const line = renderedBlockText(shown, 2)
    const quote = line.slice(line.indexOf('renderNow'), line.indexOf('Ü( redraw.)'))
    expect(quote).toContain('renderNow') // the inline-code endpoint…
    expect(quote).toContain('Ü(synchronous)') // …and the emphasised one, both translated
    expect(RENDERING).not.toContain(quote) // display text: not in the stored file

    h.send({
      type: 'addComment',
      paragraphIndex: 2,
      body: 'Why synchronous?',
      fragment: { quote, prefix: 'Ü(Call the )', suffix: 'Ü( redraw.)', translated },
    })
    h.send({ type: 'requestComments' })
    const onAdd = { blocks: blocksOf(h.posted), orphaned: orphansOf(h.posted) }

    h.edit(EDITED)
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })
    return { quote, onAdd, afterEdit: { blocks: blocksOf(h.posted), orphaned: orphansOf(h.posted) } }
  }

  it('stays on its block and keeps its highlight quote; the same quote without the flag orphans', async () => {
    const marked = await commentOnTheTranslation(true)
    // Live the moment it is made — the 0.8.0 bug orphaned it instantly…
    expect(marked.onAdd.blocks).toEqual([{ paragraphIndex: 2, count: 1, fragments: [marked.quote] }])
    expect(marked.onAdd.orphaned).toEqual([])
    // …and still live after the document moves under it, with the quote echoed back so
    // the webview painter can find it in the (translated) DOM.
    expect(marked.afterEdit.blocks).toEqual([
      { paragraphIndex: 2, count: 1, fragments: [marked.quote] },
    ])
    expect(marked.afterEdit.orphaned).toEqual([])

    // The contrast that keeps the rule honest: an unflagged fragment is matched against
    // the source, so this same quote — genuinely absent there — is an orphan.
    const plain = await commentOnTheTranslation(undefined)
    expect(plain.onAdd.blocks).toEqual([])
    expect(plain.onAdd.orphaned).toHaveLength(1)
  })
})

// --- J8 --------------------------------------------------------------------

/**
 * CHANGELOG 0.7.0: "A comment highlights exactly the selected text (or the whole selected
 * range across blocks)"; "Code blocks and table rows are now full blocks — each gets a
 * comment marker". Multi-block comments "no longer disappear when a selection end lands on
 * a block containing inline code or emphasis". (reqs 10.17, 11.9)
 */
describe('J8 — a span across list items, a code fence and table rows', () => {
  const SPEC = [
    'Opening paragraph.',
    '',
    '- First item mentions `renderNow`',
    '- Second item is plain',
    '',
    '```js',
    'const total = a + b',
    '```',
    '',
    '| Field | Meaning |',
    '| --- | --- |',
    '| `id` | the _unique_ key |',
    '',
    'Closing paragraph.',
  ].join('\n')

  const WITHOUT_TABLE = [
    'Opening paragraph.',
    '',
    '- First item mentions `renderNow`',
    '- Second item is plain',
    '',
    '```js',
    'const total = a + b',
    '```',
    '',
    'Closing paragraph.',
  ].join('\n')

  it('marks only the first block, highlights the whole range, and orphans whole when an end dies', async () => {
    const h = openPreview(SPEC)
    await h.comments.load()
    await h.controller.renderNow()
    h.send({ type: 'requestComments' }) // the webview pulls after every render
    const html = lastOf(h.posted, 'renderContent').html

    // The indices come from the renderer, so `li`, `pre` and `tr` really participate.
    const li1 = renderedBlockText(html, 1)
    const row = renderedBlockText(html, 5)
    expect(li1).toBe('First item mentions renderNow')
    expect(renderedBlockText(html, 3)).toContain('const total = a + b') // the fence is block 3
    expect(row).toContain('unique') // the last table row is block 5

    // The selection ends as the webview supplies them: RENDERED text, which the markdown
    // never contains verbatim (backticks, underscores). A row's cells come through as
    // separate text nodes, so its selection text is cell-per-line.
    const startQuote = li1.slice(li1.indexOf('mentions'))
    const endQuote = row.trim()
    expect(SPEC).not.toContain(startQuote)
    expect(SPEC).not.toContain(endQuote)

    const span = {
      type: 'addComment' as const,
      paragraphIndex: 1,
      fragment: { quote: startQuote, prefix: 'First item ', suffix: '' },
      endIndex: 5,
      endFragment: { quote: endQuote, prefix: '', suffix: '' },
    }
    h.send({ ...span, body: 'This whole example is stale.' })
    h.send({ type: 'requestComments' })

    expect(blocksOf(h.posted)).toEqual([
      { paragraphIndex: 1, count: 1, fragments: [startQuote] }, // the only marker
      { paragraphIndex: 2, count: 0, whole: true }, // second list item, highlight only
      { paragraphIndex: 3, count: 0, whole: true }, // the code fence
      { paragraphIndex: 4, count: 0, whole: true }, // the table header row
      { paragraphIndex: 5, count: 0, fragments: [endQuote] }, // the far end's head
    ])
    expect(orphansOf(h.posted)).toEqual([])

    // A repeat comment on the same two ends joins the discussion — it is one thread.
    h.send({ ...span, body: 'Agreed, rewrite it.' })
    h.send({ type: 'requestComments' })
    const joined = blocksOf(h.posted)
    expect(joined.filter((b) => b.count > 0)).toEqual([
      { paragraphIndex: 1, count: 2, fragments: [startQuote] },
    ])
    expect(joined.map((b) => b.paragraphIndex)).toEqual([1, 2, 3, 4, 5])

    // Delete the table: the far end is gone, so the span orphans WHOLE — never a partial
    // or inverted highlight over the blocks that survived.
    h.edit(WITHOUT_TABLE)
    await h.controller.renderNow()
    h.send({ type: 'requestComments' })

    expect(blocksOf(h.posted)).toEqual([])
    expect(orphansOf(h.posted)).toHaveLength(1)
    expect(orphansOf(h.posted)[0].comments.map((c: Comment) => c.body)).toEqual([
      'This whole example is stale.',
      'Agreed, rewrite it.',
    ])
  })
})

// --- J9 --------------------------------------------------------------------

/**
 * README: "By default comments are stored in a sidecar next to the file … Two other stores
 * can be chosen in settings: inline … and draft." Switching the store must move what is
 * already there, and switching only the *placement* while on sidecar must move nothing.
 * (reqs 11.1, 11.10, 11.11, 11.14, 11.16)
 */
describe('J9 — switching the Comment Storage setting re-homes what is already stored', () => {
  const NOTES_URI = vscode.Uri.file('/docs/notes.md')
  const NOTES_SIDECAR = 'file:///docs/notes.md.comments.json'
  const NOTES = ['# Notes', '', 'Alpha paragraph.', '', 'Beta paragraph.'].join('\n')

  /** Activate the extension and resolve a preview for `/docs/notes.md`. */
  async function openThroughActivation() {
    const doc = vscode.__addTextDocument(new vscode.MockTextDocument(NOTES_URI, NOTES))
    vscode.__setFile(NOTES_URI, NOTES)
    const panel = new vscode.MockWebviewPanel()
    const context = vscode.__createExtensionContext()
    const activation = new ActivationController()
    activation.activate(context as never)
    activation.resolveCustomTextEditor(doc as never, panel as never)
    // Past the 300 ms render debounce, so the comment layer has real blocks to anchor to.
    await vi.advanceTimersByTimeAsync(400)
    panel.webview.__receive({ type: 'requestComments' })
    return { doc, panel, activation }
  }

  /** Apply a settings patch and deliver the change event the extension listens for. */
  async function changeSettings(patch: Record<string, unknown>) {
    vscode.__setConfig('kiro-md-translator', patch)
    vscode.__fireConfigChange('kiro-md-translator')
    await vi.advanceTimersByTimeAsync(400)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vscode.__setConfig('kiro-md-translator', {
      commentStorage: 'sidecar',
      commentPlacement: 'after-paragraph',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves nothing on a placement-only change, then carries the comment sidecar → inline → draft', async () => {
    const { doc, panel } = await openThroughActivation()
    panel.webview.__receive({ type: 'addComment', paragraphIndex: 1, body: 'Expand this.' })
    await vi.advanceTimersByTimeAsync(600) // the 500 ms sidecar debounce

    const sidecarBytes = vscode.__getFile(NOTES_SIDECAR)
    expect(sidecarBytes).toBeDefined()
    const commentId = (JSON.parse(sidecarBytes!) as CommentsFile).threads[0].comments[0].id
    const documentBefore = doc.getText()

    // Placement only matters to the inline store; while on sidecar both settings resolve
    // to the same backend, so nothing may be re-homed and nothing may be rewritten.
    await changeSettings({ commentPlacement: 'end-of-file' })
    expect(vscode.__getFile(NOTES_SIDECAR)).toBe(sidecarBytes)
    expect(doc.getText()).toBe(documentBefore)
    await changeSettings({ commentPlacement: 'after-paragraph' })
    expect(vscode.__getFile(NOTES_SIDECAR)).toBe(sidecarBytes)
    expect(doc.getText()).toBe(documentBefore)

    // sidecar → inline: the carrier lands after the paragraph it belongs to, the sidecar
    // goes away, and the comment keeps its identity.
    await changeSettings({ commentStorage: 'inline' })
    expect(vscode.__listFiles()).not.toContain(NOTES_SIDECAR)
    expect(doc.getText()).toContain('Alpha paragraph.\n\n<!-- rmt:comments')
    expect(doc.getText()).toContain('Beta paragraph.')
    expect((doc.getText().match(/rmt:comments/g) ?? []).length).toBe(1)
    const inlined = parseInline(doc.getText())
    expect(inlined.threads).toHaveLength(1)
    expect(inlined.threads[0].comments[0].id).toBe(commentId)

    // inline → draft: the `.md` is cleaned and the record moves into the extension's own
    // storage, stamped with the document it belongs to (req 11.15).
    await changeSettings({ commentStorage: 'draft' })
    expect(doc.getText()).not.toContain('rmt:comments')
    const draftKey = vscode.__listFiles().find((f) => f.includes('/global/storage/comments/'))
    expect(draftKey).toBeDefined()
    const draft = JSON.parse(vscode.__getFile(draftKey!)!) as CommentsFile & { docUri: string }
    expect(draft.docUri).toBe(NOTES_URI.toString())
    expect(draft.threads[0].comments[0].id).toBe(commentId)

    panel.dispose()
  })

  it('req 11.16: a carrier edit that never landed keeps the sidecar, though the document looks clean', async () => {
    const { doc, panel } = await openThroughActivation()
    panel.webview.__receive({ type: 'addComment', paragraphIndex: 1, body: 'Keep me somewhere.' })
    await vi.advanceTimersByTimeAsync(600)
    const sidecarBytes = vscode.__getFile(NOTES_SIDECAR)
    expect(sidecarBytes).toBeDefined()
    const documentBefore = doc.getText()

    // A WorkspaceEdit is REJECTED by resolving false, not by throwing. The document is left
    // byte-identical and therefore NOT dirty — which is exactly what an already-saved
    // document looks like, so the disk probe alone would call this a success.
    vscode.__setApplyEditResult(false)
    await changeSettings({ commentStorage: 'inline' })

    expect(doc.getText()).toBe(documentBefore) // the carriers never reached the buffer…
    expect(doc.isDirty).toBe(false) // …so the naive probe says "already on disk"…
    expect(vscode.__getFile(NOTES_SIDECAR)).toBe(sidecarBytes) // …and the sidecar must survive
    expect((JSON.parse(sidecarBytes!) as CommentsFile).threads[0].comments[0].body).toBe(
      'Keep me somewhere.',
    )

    panel.dispose()
  })
})
