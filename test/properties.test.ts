/**
 * Host-side property tests for the PreviewController properties that had none:
 * P4 (auto-translate debounce), P5 (scroll mapping), P6 (translate-button state),
 * P7 (render debounce cancels superseded renders) and P13 (a translation error
 * preserves the displayed content). Tasks 10.2–10.6.
 *
 * Every oracle below is the DESIGN's statement of the property, never a value read
 * back out of the code under test:
 *   P4  — "exactly once after the quiet period" is a literal count from design.md.
 *   P5  — the expected block index comes from the RENDERED HTML (which element
 *         carries the marker) and the expected line from the GENERATED source; the
 *         controller's own lineMap lookup is what is being judged, so it is never
 *         used to compute the expectation.
 *   P6  — the boolean `!(mode === 'on-demand' && lang !== undefined)` is written out
 *         here exactly as design.md states it.
 *   P7  — "at most one render COMPLETES; every superseded token is cancelled by the
 *         time the final render begins" (design.md + task 10.2).
 *   P13 — the generated (status, message) pair is the expectation; the previously
 *         rendered HTML is captured BEFORE the failure and compared afterwards.
 *
 * Timing properties run under `vi.useFakeTimers()` — no real sleeps anywhere.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fc from 'fast-check'
import { PreviewController, type PreviewDeps } from '../src/PreviewController'
import { TranslationCache } from '../src/TranslationCache'
import { MarkdownRenderer } from '../src/MarkdownRenderer'
import { TranslationEngine } from '../src/TranslationEngine'
import { TranslatorError, type ExtensionMessage, type PluginConfig } from '../src/types'
import { Uri } from './mocks/vscode'

/** The debounce constants the design fixes (src/PreviewController.ts). */
const RENDER_DEBOUNCE_MS = 300
const TRANSLATE_DEBOUNCE_MS = 1000

const BASE_CONFIG: PluginConfig = {
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
  codeHighlightTheme: 'auto',
}

interface HarnessOptions {
  config?: Partial<PluginConfig>
  /** Renderer handed to the CONTROLLER. The engine always keeps a real
   *  MarkdownRenderer, so a stub here only removes rendering from the picture. */
  renderer?: MarkdownRenderer
  translateBatch?: (segs: string[]) => Promise<string[]>
  text?: string
}

/**
 * Local PreviewController harness (deliberately self-contained: the other unit
 * files own their own). Everything the controller needs is a plain object, which
 * is the point of the PreviewDeps seam.
 */
function harness(options: HarnessOptions = {}) {
  const posted: ExtensionMessage[] = []
  const cache = new TranslationCache()
  const engineRenderer = new MarkdownRenderer()
  const config: PluginConfig = { ...BASE_CONFIG, ...options.config }
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    translateBatch:
      options.translateBatch ?? (async (segs: string[]) => segs.map((s) => `T(${s})`)),
    getSupportedLanguages: async () => [],
    testConnection: async () => {},
  }
  const engine = new TranslationEngine(() => provider as never, cache, engineRenderer)
  const translate = vi.spyOn(engine, 'translate')
  const settings = {
    getConfig: () => config,
    getTargetLanguage: () => config.targetLanguage,
    getStorageLanguage: () => config.storageLanguage,
    getTranslationMode: () => config.translationMode,
    getProviderType: () => config.providerType,
    getCustomEndpoint: () => config.customEndpoint,
    onDidChangeSettings: () => ({ dispose() {} }),
  }
  let text = options.text ?? 'Hello world.'
  const deps: PreviewDeps = {
    post: (m) => posted.push(m),
    renderer: options.renderer ?? engineRenderer,
    engine,
    cache,
    settings: settings as never,
    exportService: { exportTranslation: async () => {} } as never,
    getDocumentText: () => text,
    getDocumentUri: () => Uri.file('/docs/readme.md') as never,
  }
  const controller = new PreviewController(deps)
  return {
    controller,
    posted,
    /** How often TranslationEngine.translate() was invoked (the P4 oracle). */
    translateCalls: () => translate.mock.calls.length,
    /** Every posted message of one kind. */
    of: <T extends ExtensionMessage['type']>(type: T) =>
      posted.filter((m) => m.type === type) as Array<Extract<ExtensionMessage, { type: T }>>,
    clear: () => {
      posted.length = 0
    },
    /** Simulate an editor edit (what ActivationController forwards). */
    change: (next: string) => {
      text = next
      controller.onDocumentChange({ getText: () => next } as never)
    },
  }
}

/** The controller's per-render CancellationTokenSource. It is deliberately not
 *  handed to the renderer (the renderer is synchronous under the hood), so this
 *  private field is the only place its cancelled state can be observed — P7's
 *  second clause is about that state, so the read is the measurement. */
type TokenSource = { token: { isCancellationRequested: boolean } }
function renderTokenOf(controller: PreviewController): TokenSource | undefined {
  return (controller as unknown as { renderToken?: TokenSource }).renderToken
}

// ---------------------------------------------------------------------------
// Property 4 — auto-translate debounce (reqs 5.5, 2.6)
// ---------------------------------------------------------------------------

describe('PreviewController auto-translate debounce', () => {
  afterEach(() => vi.useRealTimers())

  // Feature: kiro-md-translator-plugin, Property 4: Auto-translate edit debounce fires exactly once after the quiet period
  it('Property 4: a burst of edits translates exactly once, after the quiet period', async () => {
    await fc.assert(
      // Inter-change intervals, all < 1000 ms — i.e. every change lands inside the
      // quiet window of the one before it.
      fc.asyncProperty(fc.array(fc.nat(800), { minLength: 2, maxLength: 12 }), async (gaps) => {
        vi.useFakeTimers()
        try {
          const h = harness({ config: { translationMode: 'automatic' } })
          h.change('edit 0')
          for (let i = 0; i < gaps.length; i++) {
            await vi.advanceTimersByTimeAsync(gaps[i])
            h.change(`edit ${i + 1}`)
          }
          // Not once per change event: no gap ever reached the quiet period.
          expect(h.translateCalls()).toBe(0)
          await vi.advanceTimersByTimeAsync(TRANSLATE_DEBOUNCE_MS)
          expect(h.translateCalls()).toBe(1)
          // …and it stays at one however long the document then sits still.
          await vi.advanceTimersByTimeAsync(10 * TRANSLATE_DEBOUNCE_MS)
          expect(h.translateCalls()).toBe(1)
        } finally {
          vi.useRealTimers()
        }
      }),
      { numRuns: 100 },
    )
  })

  // The exact boundary, as a deterministic example (design.md, Testing Strategy).
  it('translates once when the next edit lands at 999 ms, twice when it lands at 1000 ms', async () => {
    vi.useFakeTimers()
    const inside = harness({ config: { translationMode: 'automatic' } })
    inside.change('a')
    await vi.advanceTimersByTimeAsync(TRANSLATE_DEBOUNCE_MS - 1)
    inside.change('b')
    await vi.advanceTimersByTimeAsync(TRANSLATE_DEBOUNCE_MS)
    expect(inside.translateCalls()).toBe(1)

    const outside = harness({ config: { translationMode: 'automatic' } })
    outside.change('a')
    await vi.advanceTimersByTimeAsync(TRANSLATE_DEBOUNCE_MS)
    outside.change('b')
    await vi.advanceTimersByTimeAsync(TRANSLATE_DEBOUNCE_MS)
    expect(outside.translateCalls()).toBe(2)
  })

  it('on-demand mode never auto-translates, however long the document sits still', async () => {
    vi.useFakeTimers()
    const h = harness({ config: { translationMode: 'on-demand' } })
    h.change('a')
    await vi.advanceTimersByTimeAsync(10 * TRANSLATE_DEBOUNCE_MS)
    expect(h.translateCalls()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Property 5 — element-to-line scroll mapping (reqs 2.2, 2.3)
// ---------------------------------------------------------------------------

type BlockKind = 'para' | 'setext' | 'code' | 'list' | 'table'

/** One indexed block of the generated document: a marker that appears in exactly
 *  one rendered element, the source line the block starts on, and a source line
 *  inside the block to scroll to. */
interface GeneratedBlock {
  marker: string
  firstLine: number
  markerLine: number
}

/**
 * Build a document whose rendered element heights deliberately disagree with its
 * source line counts: a setext heading is 2 source lines and one `<h1>`, a fenced
 * block is 4 source lines and one `<pre>`, a table is 3 source lines and two
 * `<tr>`s. Bullets alternate so two adjacent lists never merge into one loose
 * list (which would wrap the items in `<p>` and add blocks).
 */
function buildDocument(kinds: BlockKind[]): { source: string; blocks: GeneratedBlock[] } {
  const lines: string[] = []
  const blocks: GeneratedBlock[] = []
  kinds.forEach((kind, n) => {
    if (lines.length > 0) lines.push('')
    const at = lines.length
    if (kind === 'para') {
      blocks.push({ marker: `Para${n}`, firstLine: at, markerLine: at })
      lines.push(`Para${n} text here.`)
    } else if (kind === 'setext') {
      blocks.push({ marker: `Head${n}`, firstLine: at, markerLine: at })
      lines.push(`Head${n} title`, '===')
    } else if (kind === 'code') {
      blocks.push({ marker: `Code${n}`, firstLine: at, markerLine: at + 1 })
      lines.push('```', `Code${n} one`, 'filler', '```')
    } else if (kind === 'list') {
      const bullet = n % 2 === 0 ? '-' : '*'
      blocks.push({ marker: `Item${n}a`, firstLine: at, markerLine: at })
      blocks.push({ marker: `Item${n}b`, firstLine: at + 1, markerLine: at + 1 })
      lines.push(`${bullet} Item${n}a`, `${bullet} Item${n}b`)
    } else {
      blocks.push({ marker: `Cell${n}a`, firstLine: at, markerLine: at })
      blocks.push({ marker: `Cell${n}c`, firstLine: at + 2, markerLine: at + 2 })
      lines.push(`| Cell${n}a | Cell${n}b |`, '| --- | --- |', `| Cell${n}c | Cell${n}d |`)
    }
  })
  return { source: lines.join('\n'), blocks }
}

/** Which `data-paragraph-index` element carries `marker`, read out of the HTML the
 *  webview was given. Tags are stripped, so a syntax-highlight span inside a code
 *  block cannot hide the marker. Independent of the controller's lineMap. */
function indexOfMarker(html: string, marker: string): number | undefined {
  const hits: Array<{ index: number; at: number }> = []
  for (const m of html.matchAll(/data-paragraph-index="(\d+)"/g)) {
    hits.push({ index: Number(m[1]), at: (m.index ?? 0) + m[0].length })
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].at : html.length
    const text = html.slice(hits[i].at, end).replace(/<[^>]*>/g, '')
    if (text.includes(marker)) return hits[i].index
  }
  return undefined
}

describe('PreviewController scroll mapping', () => {
  const kinds = fc.constantFrom<BlockKind>('para', 'setext', 'code', 'list', 'table')

  // Feature: kiro-md-translator-plugin, Property 5: Scroll mapping is element-to-line consistent
  it('Property 5: an editor line scrolls the element of the block that owns it, with no echo back', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(kinds, { minLength: 1, maxLength: 5 }),
        fc.nat(5),
        async (rest, at) => {
          // At least one block whose rendered height differs from its line count.
          const mixed = [...rest]
          mixed.splice(at % (mixed.length + 1), 0, 'code')
          const { source, blocks } = buildDocument(mixed)
          const renderer = new MarkdownRenderer()
          const { html, lineMap } = await renderer.render(source, Uri.file('/docs') as never)
          // Every generated block is an indexed block, and nothing else is.
          expect(lineMap.length).toBe(blocks.length)

          const h = harness()
          h.controller.primeRenderState(source, lineMap, false)

          for (const block of blocks) {
            const index = indexOfMarker(html, block.marker)
            expect(index, `no element carries ${block.marker}`).toBeDefined()

            // editor → preview: the element holding this line is scrolled to top…
            h.clear()
            h.controller.onEditorScroll(block.markerLine)
            expect(h.posted).toEqual([{ type: 'editorScrollSync', paragraphIndex: index }])

            // …and the inverse maps that element back to the line it starts on.
            expect(h.controller.paragraphStartLine(index as number)).toBe(block.firstLine)

            // preview → editor: the webview's own scroll is never echoed back to it
            // (the reveal happens in the editor; no feedback loop).
            h.clear()
            h.controller.onWebviewMessage({ type: 'scrollChanged', topParagraphIndex: index as number })
            expect(h.posted).toEqual([])
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 6 — Translate_Button state (reqs 3.1, 3.2, 3.3, 3.15)
// ---------------------------------------------------------------------------

describe('PreviewController translate-button state', () => {
  // Feature: kiro-md-translator-plugin, Property 6: Translate_Button is always present; its disabled state follows the (mode, language) rule
  it('Property 6: the button state is always pushed and disabled === !(on-demand && language set)', () => {
    fc.assert(
      fc.property(
        fc.record({
          mode: fc.constantFrom<PluginConfig['translationMode']>('on-demand', 'automatic'),
          // `nil: undefined` — "language unset" is undefined, which is what
          // SettingsManager maps an empty setting to (req 4.12).
          lang: fc.option(fc.string(), { nil: undefined }),
        }),
        ({ mode, lang }) => {
          const h = harness({ config: { translationMode: mode, targetLanguage: lang } })
          h.controller.updateButtonState()
          // Host side of "always present": the state is pushed for EVERY combination —
          // the host never withholds it, whatever the mode or the language. (That the
          // element itself stays in the DOM is a webview fact; the host cannot see it.)
          const states = h.of('updateButtonState')
          expect(states.length).toBe(1)
          const disabled = !states[0].translateEnabled
          expect(disabled).toBe(!(mode === 'on-demand' && lang !== undefined))
          expect(states[0].mode).toBe(mode)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 7 — render debounce cancels superseded renders (req 2.1)
// ---------------------------------------------------------------------------

describe('PreviewController render debounce', () => {
  afterEach(() => vi.useRealTimers())

  // Feature: kiro-md-translator-plugin, Property 7: Render debounce cancels superseded renders
  it('Property 7: a burst inside the debounce window completes at most one render, every superseded token cancelled', async () => {
    await fc.assert(
      // Inter-change intervals, all < 300 ms — the burst never leaves the window.
      fc.asyncProperty(fc.array(fc.nat(250), { minLength: 2, maxLength: 10 }), async (gaps) => {
        vi.useFakeTimers()
        try {
          let controller!: PreviewController
          // Token sources seen alive before the final render started.
          const seen: TokenSource[] = []
          const observe = (): void => {
            const source = renderTokenOf(controller)
            if (source && !seen.includes(source)) seen.push(source)
          }
          /** What each render START observed: how many earlier tokens it superseded,
           *  and whether all of them were already cancelled at that moment. */
          const starts: Array<{ superseded: number; allCancelled: boolean }> = []
          const renderer = {
            render: async () => {
              const active = renderTokenOf(controller)
              const superseded = seen.filter((s) => s !== active)
              starts.push({
                superseded: superseded.length,
                allCancelled: superseded.every((s) => s.token.isCancellationRequested),
              })
              return { html: '<p>rendered</p>', lineMap: [] }
            },
          }
          const h = harness({ renderer: renderer as never })
          controller = h.controller

          // Prime: one completed render, so the burst below has a real predecessor
          // token to supersede (without it the second clause would be vacuous).
          h.change('v0')
          await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS + 100)
          expect(h.of('renderContent').length).toBe(1)
          observe()
          h.clear()
          starts.length = 0

          h.change('burst 0')
          observe()
          for (let i = 0; i < gaps.length; i++) {
            await vi.advanceTimersByTimeAsync(gaps[i])
            h.change(`burst ${i + 1}`)
            observe()
          }
          await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS + 100)

          // (a) at most one render COMPLETED (and the debounce did fire).
          expect(h.of('renderContent').length).toBeLessThanOrEqual(1)
          expect(h.of('renderContent').length).toBe(1)
          // (b) every superseded token was cancelled before that render began — and
          // there really was one to cancel, so the check is not vacuous.
          expect(starts.length).toBeGreaterThanOrEqual(1)
          for (const start of starts) {
            expect(start.superseded).toBeGreaterThanOrEqual(1)
            expect(start.allCancelled).toBe(true)
          }
        } finally {
          vi.useRealTimers()
        }
      }),
      { numRuns: 100 },
    )
  })

  // The exact boundary, as a deterministic example (design.md, Testing Strategy).
  it('coalesces a change at 299 ms and supersedes — cancelling the old token — at 300 ms', async () => {
    vi.useFakeTimers()
    const inside = harness({ renderer: { render: async () => ({ html: '<p>a</p>', lineMap: [] }) } as never })
    inside.change('a')
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS - 1)
    inside.change('b')
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS + 100)
    expect(inside.of('renderContent').length).toBe(1)

    let controller!: PreviewController
    const cancelledWhenNextBegan: boolean[] = []
    let first: TokenSource | undefined
    const outside = harness({
      renderer: {
        render: async () => {
          if (first) cancelledWhenNextBegan.push(first.token.isCancellationRequested)
          else first = renderTokenOf(controller)
          return { html: '<p>b</p>', lineMap: [] }
        },
      } as never,
    })
    controller = outside.controller
    outside.change('a')
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS) // first render runs
    outside.change('b') // 300 ms later: outside the window, so it supersedes
    await vi.advanceTimersByTimeAsync(RENDER_DEBOUNCE_MS + 100)
    expect(outside.of('renderContent').length).toBe(2)
    expect(cancelledWhenNextBegan).toEqual([true])
  })
})

// ---------------------------------------------------------------------------
// Property 13 — a translation error preserves the displayed content (req 3.13)
// ---------------------------------------------------------------------------

describe('PreviewController translation error', () => {
  // Feature: kiro-md-translator-plugin, Property 13: Translation error response preserves previous content
  it('Property 13: the failure is reported with code AND message, and the shown content is untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        fc.string({ minLength: 1 }),
        async (status, message) => {
          const h = harness({
            text: '# Title\n\nHello world.',
            translateBatch: async () => {
              throw new TranslatorError('TRANSLATION_HTTP_ERROR', message, status)
            },
          })
          // A successful render first — this HTML is what the webview is displaying.
          await h.controller.renderNow()
          const shown = h.of('renderContent')
          expect(shown.length).toBe(1)
          h.clear()

          await h.controller.translateNow()

          // (a) the notification carries BOTH the status code and the message…
          const errors = h.of('translationError')
          expect(errors.length).toBe(1)
          expect(errors[0].code).toBe(status)
          expect(errors[0].message).toBe(message)
          // (b) …and nothing that could replace the displayed content was sent:
          // only the start marker and the error itself reached the webview.
          expect(h.posted.map((m) => m.type)).toEqual(['translationStart', 'translationError'])
          expect(h.of('renderContent')).toEqual([])
          expect(h.of('translationComplete')).toEqual([])

          // The last content the webview was given is still the successful render.
          const stillShown = shown[shown.length - 1]
          expect(stillShown.html).toContain('Hello world.')
          expect(stillShown.html).toContain('<h1')
        },
      ),
      { numRuns: 100 },
    )
  })
})
