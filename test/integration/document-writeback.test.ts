/**
 * Integration tests for the paths that WRITE BYTES — the data-integrity core.
 *
 * These wire the real PreviewController, TranslationEngine, MarkdownRenderer and
 * (for the export) ExportService together over the vscode mock and a fake provider
 * that records what it was asked to translate. Nothing under test is stubbed, and
 * `primeRenderState` is deliberately avoided: the lineMap the splice is measured
 * against is the one the renderer really produced, which is what a unit test over a
 * hand-written lineMap can never check.
 *
 * The promise being defended (CLAUDE.md "three distinct output paths, and mixing
 * them corrupts the user's file"): a save is a surgical line-range splice, an export
 * is a NEW file, and the display path never reaches disk at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { PreviewController, type PreviewDeps } from '../../src/PreviewController'
import { TranslationEngine } from '../../src/TranslationEngine'
import { TranslationCache } from '../../src/TranslationCache'
import { MarkdownRenderer } from '../../src/MarkdownRenderer'
import { ExportService } from '../../src/ExportService'
import type { ExtensionMessage, LineMapping, PluginConfig } from '../../src/types'
import * as vscode from '../mocks/vscode'

/** Mirrors RENDER_DEBOUNCE_MS in src/PreviewController.ts — the save schedules a re-render. */
const RENDER_DEBOUNCE_MS = 300

const CONFIG: PluginConfig = {
  targetLanguage: 'de',
  storageLanguage: 'en',
  translationMode: 'on-demand',
  providerType: 'deepl',
  customEndpoint: undefined,
  ollamaEndpoint: undefined,
  ollamaModel: '',
  glossary: [],
  commentStorage: 'sidecar',
  commentPlacement: 'after-paragraph',
  commentAutoImport: false,
  codeHighlightTheme: 'off',
}

const DOC_URI = vscode.Uri.file('/docs/readme.md')

interface Harness {
  controller: PreviewController
  posted: ExtensionMessage[]
  /** Every batch handed to the provider, in call order — code must never appear here. */
  sent: string[][]
  /** The last text the controller asked the host to persist (req 7.14 write-back). */
  written: () => string
}

/** Wire the real modules around a source document and a recording fake provider. */
function harness(source: string, opts: Partial<PreviewDeps> = {}): Harness {
  const posted: ExtensionMessage[] = []
  const sent: string[][] = []
  let written = ''
  const cache = new TranslationCache()
  const renderer = new MarkdownRenderer()
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    // A marked, idempotent-looking translation: a byte that says "this went through
    // the provider", so target-language leakage into a written file is visible.
    translateBatch: async (segments: string[]) => {
      sent.push([...segments])
      return segments.map((s) => `DE(${s})`)
    },
    getSupportedLanguages: async () => [],
    testConnection: async () => {},
  }
  const engine = new TranslationEngine(() => provider as never, cache, renderer, () => CONFIG.glossary)
  const settings = {
    getConfig: () => CONFIG,
    getTargetLanguage: () => CONFIG.targetLanguage,
    getStorageLanguage: () => CONFIG.storageLanguage,
    getTranslationMode: () => CONFIG.translationMode,
    getProviderType: () => CONFIG.providerType,
    getCustomEndpoint: () => CONFIG.customEndpoint,
    onDidChangeSettings: () => ({ dispose() {} }),
  }
  const deps: PreviewDeps = {
    post: (m) => posted.push(m),
    renderer,
    engine,
    cache,
    settings: settings as never,
    exportService: { exportTranslation: async () => {} } as never,
    getDocumentText: () => source,
    getDocumentUri: () => DOC_URI as never,
    applyEdit: async (text) => {
      written = text
      return true
    },
    ...opts,
  }
  return { controller: new PreviewController(deps), posted, sent, written: () => written }
}

/** What a whole-document `remark-stringify` round-trip would produce — the corruption
 *  the surgical splice exists to prevent. Used to prove each trap is a real trap. */
function reserialize(markdown: string): string {
  return unified()
    .use(remarkGfm)
    .use(remarkStringify)
    .stringify(new MarkdownRenderer().parse(markdown) as never)
}

function mapping(lineMap: LineMapping[], paragraphIndex: number): LineMapping {
  const hit = lineMap.find((m) => m.paragraphIndex === paragraphIndex)
  if (!hit) throw new Error(`no lineMap entry for block ${paragraphIndex}`)
  return hit
}

/** The block index whose source lines contain `needle` — resolved from the REAL
 *  lineMap, so a wrong lineMap fails the test instead of being written into it. */
function blockContaining(lineMap: LineMapping[], source: string, needle: string): number {
  const lines = source.split('\n')
  const hit = lineMap.find((m) =>
    lines.slice(m.startLine, m.endLine + 1).some((l) => l.includes(needle)),
  )
  if (!hit) throw new Error(`no block containing ${JSON.stringify(needle)}`)
  return hit.paragraphIndex
}

function renderContents(posted: ExtensionMessage[]) {
  return posted.filter(
    (m): m is Extract<ExtensionMessage, { type: 'renderContent' }> => m.type === 'renderContent',
  )
}

// ---------------------------------------------------------------------------
// J3 — in-place paragraph save (req 7.14)
// ---------------------------------------------------------------------------

/**
 * Every construct below is one `remark-stringify` normalizes away. If the save path
 * ever re-serialized the whole document instead of splicing a line range, the user's
 * untouched bytes would silently change — which is exactly the corruption CLAUDE.md
 * describes and requirement 7.14 forbids: a save replaces only that element's own
 * source range, without rewriting the rest of the file.
 */
const TRAP_SOURCE = [
  'Read Markdown Translator',
  '========================', // setext underline → stringify emits `# Title`
  '',
  '+ persistent translation memory', // `+` bullet → stringify emits `*`
  '+ glossary terms never reach the provider',
  '',
  '---', // thematic break → stringify emits `***`
  '',
  'MARKER: this paragraph is the one under test.',
  '',
  'A line that ends in a hard break.  ', // two trailing spaces → stringify emits `\`
  'The continuation of that same paragraph.',
  '',
  '1) first ordered item', // `)` delimiter → stringify emits `1.`
  '2) second ordered item',
  '',
  'An entity: AT&amp;T keeps its escape.', // stringify decodes it to `AT&T`
  '',
  '````text', // 4-backtick fence over a backtick-free body → stringify emits 3
  'Four backticks here, three would do.',
  '````',
  '',
  '| Term | Meaning |',
  '|---|--------------|', // ragged delimiter → stringify pads every column
  '| Storage | the language on disk |',
  '',
  'The closing paragraph mentions _emphasis_ and stays put.', // `_x_` → `*x*`
  '',
].join('\n')

const TRAPS = [
  '========================',
  '+ persistent translation memory',
  '\n---\n',
  'A line that ends in a hard break.  \n',
  '1) first ordered item',
  'AT&amp;T',
  '````text',
  '|---|--------------|',
  '_emphasis_',
]

describe('J3: saving one paragraph is a line-range splice, in the storage language (req 7.14)', () => {
  afterEach(() => vi.useRealTimers())

  it('rewrites only the edited block and leaves every formatter-normalizable byte alone', async () => {
    // README:24 "edit a paragraph (original ↔ translation auto-sync) and save it back";
    // README:8-9 "The file on disk always stays in the Storage language".
    vi.useFakeTimers()
    const { controller, posted, written } = harness(TRAP_SOURCE)

    // The user is looking at the GERMAN preview when they hit save — the situation in
    // which target-language bytes could plausibly leak onto disk.
    await controller.renderNow()
    await controller.translateNow()
    expect(posted.find((m) => m.type === 'translationComplete')).toMatchObject({
      translatedHtml: expect.stringContaining('DE('),
    })
    const lineMap = renderContents(posted)[0].lineMap
    const index = blockContaining(lineMap, TRAP_SOURCE, 'MARKER:')
    const { startLine, endLine } = mapping(lineMap, index)

    controller.onWebviewMessage({
      type: 'saveParagraph',
      paragraphIndex: index,
      storageText: 'Rewritten paragraph.',
      targetText: 'Umgeschriebener Absatz.',
    })
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS)

    const oldLines = TRAP_SOURCE.split('\n')
    const newLines = written().split('\n')
    // (a) Only the block's own line range moved: everything before it, and everything
    //     after it, is element-wise identical.
    const delta = 1 - (endLine - startLine + 1)
    expect(newLines.slice(0, startLine)).toEqual(oldLines.slice(0, startLine))
    expect(newLines.slice(endLine + 1 + delta)).toEqual(oldLines.slice(endLine + 1))
    expect(newLines.slice(startLine, endLine + 1 + delta)).toEqual(['Rewritten paragraph.'])

    // (b) Each trap really is a trap: a whole-document round-trip destroys it, the
    //     splice keeps it. Without the first half of this pair the second proves nothing.
    const reserialized = reserialize(TRAP_SOURCE)
    for (const trap of TRAPS) {
      expect(reserialized, `remark-stringify should normalize ${JSON.stringify(trap)}`).not.toContain(trap)
      expect(written(), `${JSON.stringify(trap)} must survive the splice`).toContain(trap)
    }

    // (c) Storage_Language only. The modal offered a German field; not one byte of it,
    //     nor of anything the provider returned, may reach the document.
    expect(written()).toContain('Rewritten paragraph.')
    expect(written()).not.toContain('Umgeschriebener Absatz.')
    expect(written()).not.toContain('DE(')

    // (d) The preview refreshes from the spliced source: the second render's lineMap
    //     must point at the new text, or scroll sync and the next save would be wrong.
    const renders = renderContents(posted)
    expect(renders).toHaveLength(2)
    const fresh = mapping(renders[1].lineMap, index)
    expect(newLines.slice(fresh.startLine, fresh.endLine + 1)).toEqual(['Rewritten paragraph.'])
    controller.dispose()
  })

  /**
   * The save write-back has NO failure channel. `PreviewDeps.applyEdit` is typed
   * `(newText: string) => Promise<void>` (src/PreviewController.ts:46), and
   * ActivationController's implementation (src/ActivationController.ts:547-552)
   * awaits `vscode.workspace.applyEdit(edit)` and discards its boolean — while the
   * comment write-back three lines below it keeps that same boolean precisely because
   * "a rejected edit leaves the document byte-identical, hence CLEAN, which is
   * indistinguishable from 'already saved'".
   *
   * Verified consequence (run against this harness with `applyEdit: async () => {}`,
   * which is what the rejected path looks like from the controller's side): the
   * controller commits `this.sourceText = newSource` BEFORE the write
   * (src/PreviewController.ts:550), re-renders, and the preview shows the edited
   * paragraph — while the document still holds the old bytes and NOTHING is posted to
   * the webview. The user's edit is silently dropped and the preview lies about it.
   *
   * FIXED (2026-07-27): `applyEdit` now resolves a boolean, the controller writes before
   * it commits `sourceText`, and a rejected write re-opens the edit dialog carrying the
   * text the user typed — the dialog hides itself on Save, so without that their work
   * would die with it. Req 7.14 gained the failure branch it never named.
   */
  it('re-opens the dialog with the typed text when the host rejects the write-back', async () => {
    vi.useFakeTimers() // the render debounce; the suite's afterEach restores real timers
    let accept = false
    const { controller, posted } = harness(TRAP_SOURCE, {
      applyEdit: async () => accept,
    })
    await controller.renderNow()
    const before = renderContents(posted)[0]
    const index = blockContaining(before.lineMap, TRAP_SOURCE, 'MARKER:')

    controller.onWebviewMessage({
      type: 'saveParagraph',
      paragraphIndex: index,
      storageText: 'Rewritten paragraph.',
      targetText: 'Umgeschriebener Absatz.',
    })
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS)

    // (a) The user is told, and gets both fields back exactly as they left them.
    const reopen = posted.filter((m) => m.type === 'openEditModal').at(-1)
    expect(reopen).toMatchObject({
      paragraphIndex: index,
      storageText: 'Rewritten paragraph.',
      targetText: 'Umgeschriebener Absatz.',
    })
    expect(String((reopen as { error?: string }).error)).toMatch(/could not save/i)

    // (b) The preview does NOT show the edit as applied. This is the actual defect:
    //     `sourceText` used to be committed before the write, so a rejected edit
    //     re-rendered as if it had landed while the document kept the old bytes.
    expect(renderContents(posted)).toHaveLength(1)

    // (c) And the retry works — the controller did not corrupt its own source in the
    //     meantime, so the splice still lands on the original line range.
    accept = true
    controller.onWebviewMessage({
      type: 'saveParagraph',
      paragraphIndex: index,
      storageText: 'Rewritten paragraph.',
      targetText: 'Umgeschriebener Absatz.',
    })
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS)
    const after = renderContents(posted)
    expect(after).toHaveLength(2)
    const fresh = mapping(after[1].lineMap, index)
    const lines = TRAP_SOURCE.split('\n')
    const { startLine, endLine } = mapping(before.lineMap, index)
    const spliced = [...lines.slice(0, startLine), 'Rewritten paragraph.', ...lines.slice(endLine + 1)]
    expect(spliced.slice(fresh.startLine, fresh.endLine + 1)).toEqual(['Rewritten paragraph.'])
    controller.dispose()
  })
})

// ---------------------------------------------------------------------------
// J4 — multi-block selection edit (req 10.16)
// ---------------------------------------------------------------------------

const RANGE_SOURCE = [
  'Opening paragraph, untouched.',
  '',
  '- alpha',
  '- beta',
  '- gamma',
  '',
  '```js',
  'const RETRIES = 3 // retry the failing request',
  '```',
  '',
  '| Term | Meaning |',
  '| --- | --- |',
  '| Storage | the language on disk |',
  '',
  'Closing paragraph, untouched.',
  '',
].join('\n')

describe('J4: a span across several blocks edits and splices exactly that range (req 10.16)', () => {
  it('opens the modal on the raw markdown of the range and writes back only those lines', async () => {
    // README:23 "annotate a whole block, a selected text fragment, or a span across
    // several blocks"; req 10.16 "load the raw source of the whole selected block range
    // … and save it back by splicing exactly that line range".
    const { controller, posted, written } = harness(RANGE_SOURCE)
    await controller.renderNow()
    const lineMap = renderContents(posted)[0].lineMap
    const first = blockContaining(lineMap, RANGE_SOURCE, '- alpha')
    const last = blockContaining(lineMap, RANGE_SOURCE, '| Storage |')
    // The range must really cross block kinds — li, pre and tr only became indexed
    // blocks in 0.7.0, and a range that did not span them would not test the feature.
    expect(last - first).toBeGreaterThanOrEqual(4)
    const startLine = mapping(lineMap, first).startLine
    const endLine = mapping(lineMap, last).endLine
    const lines = RANGE_SOURCE.split('\n')

    controller.onWebviewMessage({ type: 'editParagraph', paragraphIndex: first, lastIndex: last })
    const modal = posted.find(
      (m): m is Extract<ExtensionMessage, { type: 'openEditModal' }> => m.type === 'openEditModal',
    )

    // (a) The modal is fed MARKDOWN, not rendered text. Feeding it rendered text would
    //     look fine on screen and destroy the fence and the table on save.
    expect(modal).toBeDefined()
    expect(modal?.storageText).toBe(lines.slice(startLine, endLine + 1).join('\n').trim())
    expect(modal?.storageText).toContain('- alpha')
    expect(modal?.storageText).toContain('```js')
    expect(modal?.storageText).toContain('const RETRIES = 3 // retry the failing request')
    expect(modal?.storageText).toContain('| Storage | the language on disk |')
    // (d) The range is echoed back so the webview can round-trip it into the save.
    expect(modal?.lastIndex).toBe(last)

    controller.onWebviewMessage({
      type: 'saveParagraph',
      paragraphIndex: first,
      lastIndex: last,
      storageText: 'ONE\nTWO',
      targetText: '',
    })
    await vi.waitFor(() => expect(written()).not.toBe(''))

    // (b) Exactly the selected line range became the new text.
    expect(written().split('\n')).toEqual([
      ...lines.slice(0, startLine),
      'ONE',
      'TWO',
      ...lines.slice(endLine + 1),
    ])
    // (c) The blocks outside the selection are byte-identical.
    expect(written().startsWith('Opening paragraph, untouched.\n')).toBe(true)
    expect(written().endsWith('\nClosing paragraph, untouched.\n')).toBe(true)
    controller.dispose()
  })
})

// ---------------------------------------------------------------------------
// J5 — export (req 6.2/6.3/6.5/6.6, 11.12)
// ---------------------------------------------------------------------------

const EXPORT_SOURCE = [
  '# Read Markdown Translator',
  '',
  'Storage stays on disk.',
  '',
  '## Usage',
  '',
  '```js',
  'const RETRIES = 3 // retry the failing request',
  '```',
  '',
  '| Term | Meaning |',
  '| --- | --- |',
  '| Storage | the language on disk |',
  '',
  '<!-- rmt:comments',
  '{"threads":[{"anchor":{"quote":"Storage stays on disk."},"comments":[{"id":"c1","body":"a note","createdAt":0}]}]}',
  '-->',
  '',
].join('\n')

describe('J5: export writes {name}.{lang}.md (req 6.2/6.3/6.5/6.6, 11.12)', () => {
  beforeEach(() => {
    vscode.__resetHost()
    vscode.__setFile('/docs/readme.md', EXPORT_SOURCE)
  })
  afterEach(() => vi.restoreAllMocks())

  it('offers {name}.{lang}.md and saves translated MARKDOWN with code and carriers handled', async () => {
    // README:25 "Export the translated document as {name}.{lang}.md"; README:65 inline
    // comments are "stripped from exported files"; CLAUDE.md:42 "Export (new file only):
    // remark-stringify is acceptable here and ONLY here".
    const dialog = vi
      .spyOn(vscode.window, 'showSaveDialog')
      .mockResolvedValue(vscode.Uri.file('/docs/readme.de.md'))
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
    const { controller, sent } = harness(EXPORT_SOURCE, { exportService: new ExportService() as never })

    controller.onWebviewMessage({ type: 'saveTranslation' })
    await vi.waitFor(() => expect(vscode.__getFile('/docs/readme.de.md')).toBeDefined())
    const exported = vscode.__getFile('/docs/readme.de.md') as string

    // (a) The suggested name is derived from the real document uri (req 6.2).
    const defaultUri = (dialog.mock.calls[0][0] as { defaultUri: { path: string } }).defaultUri
    expect(defaultUri.path.endsWith('/readme.de.md')).toBe(true)

    // (b) What lands on disk is Markdown, not the preview's HTML. Heading levels and
    //     fences survive (req 6.3). The paired guard shows the display path really does
    //     emit these markers, so the two negatives below discriminate the paths rather
    //     than merely being true of any string.
    const display = await new MarkdownRenderer().render(EXPORT_SOURCE, DOC_URI as never)
    expect(display.html).toContain('data-paragraph-index')
    expect(exported).toContain('# DE(Read Markdown Translator)')
    expect(exported).toContain('## DE(Usage)')
    expect(exported).toContain('```js')
    expect(exported).not.toContain('<p')
    expect(exported).not.toContain('data-paragraph-index')

    // (c) The inline comment carrier never reaches the exported file (req 11.12). The
    //     guard proves the strip is doing the work: mdast keeps the carrier as an `html`
    //     node, so a translate+stringify without the strip would write it straight out.
    expect(reserialize(EXPORT_SOURCE)).toContain('rmt:comments')
    expect(exported).not.toContain('rmt:comments')
    expect(exported).not.toContain('a note')

    // (d) Code is byte-identical; only the comment prose is translated — and the code
    //     was never even offered to the provider.
    expect(exported).toContain('const RETRIES = 3 // DE(retry the failing request)')
    expect(sent.length).toBeGreaterThan(0)
    for (const batch of sent) {
      for (const segment of batch) expect(segment).not.toContain('RETRIES')
    }

    // (e) The table's `|` scaffolding survives the round-trip (req 6.3).
    expect(exported).toMatch(/^\|.*DE\(Storage\).*\|$/m)

    // (f) Success notification carries the saved path (req 6.5).
    expect(info).toHaveBeenCalledWith(expect.stringContaining('readme.de.md'))

    // Export creates a NEW file: the original is untouched, byte for byte.
    expect(vscode.__getFile('/docs/readme.md')).toBe(EXPORT_SOURCE)
    controller.dispose()
  })

  // README: "A Target language must be set; without one the command says so instead of
  // doing nothing." Returning quietly made the palette command indistinguishable from a
  // broken one — no dialog, no file, no message at all.
  it('says what is missing instead of silently doing nothing without a Target language', async () => {
    const dialog = vi.spyOn(vscode.window, 'showSaveDialog')
    const warn = vi.spyOn(vscode.window, 'showWarningMessage')
    const noTarget = { ...CONFIG, targetLanguage: undefined }
    const { controller } = harness(EXPORT_SOURCE, {
      exportService: new ExportService() as never,
      settings: { getConfig: () => noTarget, onDidChangeSettings: () => ({ dispose() {} }) } as never,
      // The wiring ActivationController installs: PreviewDeps.notify → a warning toast.
      notify: (m: string) => void vscode.window.showWarningMessage(m),
    })

    controller.onWebviewMessage({ type: 'saveTranslation' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/target language/i))
    expect(dialog).not.toHaveBeenCalled() // nothing to save, so no dialog is offered
    expect(vscode.__listFiles()).not.toContain('file:///docs/readme..md')
    controller.dispose()
  })

  it('cancelling the save dialog writes nothing and notifies nothing (req 6.6)', async () => {
    const dialog = vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(undefined)
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
    const error = vi.spyOn(vscode.window, 'showErrorMessage')
    const { controller } = harness(EXPORT_SOURCE, { exportService: new ExportService() as never })

    controller.onWebviewMessage({ type: 'saveTranslation' })
    await vi.waitFor(() => expect(dialog).toHaveBeenCalled())

    expect(vscode.__listFiles()).toEqual(['file:///docs/readme.md'])
    expect(info).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    controller.dispose()
  })
})
