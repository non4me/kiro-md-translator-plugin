/**
 * Integration tests for the rendering half of the preview: J1, J12, J13, J14.
 *
 * These wire the REAL PreviewController, MarkdownRenderer, TranslationEngine,
 * TranslationCache and SettingsManager together over the vscode mock, with only the
 * network boundary faked (a provider that records what it was asked to translate).
 * Nothing here calls `primeRenderState` — the whole point is that the lineMap and the
 * block indices come out of a real render, so a drift between `BLOCK_TAGS`,
 * `buildLineMap` and `annotate` shows up as a wrong block instead of passing silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fromHtml } from 'hast-util-from-html'
import { visit } from 'unist-util-visit'
import { PreviewController, type PreviewDeps } from '../../src/PreviewController'
import { MarkdownRenderer } from '../../src/MarkdownRenderer'
import { TranslationCache } from '../../src/TranslationCache'
import { TranslationEngine } from '../../src/TranslationEngine'
import { SettingsManager } from '../../src/SettingsManager'
import type { ExtensionMessage, LineMapping } from '../../src/types'
import * as vscode from '../mocks/vscode'

// --- hast helpers ----------------------------------------------------------
// The webview reads the emitted HTML, so these tests read it the same way — parsed,
// with entities decoded — rather than by regex over the string.

/** The subset of a hast node these tests touch. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function walkElements(html: string, fn: (node: HastNode) => void): void {
  visit(fromHtml(html, { fragment: true }) as never, 'element', (node) => fn(node as HastNode))
}

/** Every indexed block, in document order: its `data-paragraph-index` and its tag. */
function blockTags(html: string): Array<{ index: number; tag: string }> {
  const out: Array<{ index: number; tag: string }> = []
  walkElements(html, (node) => {
    const raw = node.properties?.dataParagraphIndex
    if (raw === undefined || raw === null) return
    out.push({ index: Number(raw), tag: node.tagName ?? '' })
  })
  return out
}

const blockIndices = (html: string): number[] => blockTags(html).map((b) => b.index)

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** paragraphIndex → the block's visible text. A nested indexed block (the `<p>` inside
 *  a loose `<li>`) is counted in both, which is what the DOM does too. */
function blockTexts(html: string): Map<number, string> {
  const out = new Map<number, string>()
  walkElements(html, (node) => {
    const raw = node.properties?.dataParagraphIndex
    if (raw === undefined || raw === null) return
    out.set(Number(raw), textOf(node))
  })
  return out
}

/** All text of an HTML fragment (used for tooltip payloads, which have no indices). */
function htmlText(html: string): string {
  let out = ''
  visit(fromHtml(html, { fragment: true }) as never, 'text', (node) => {
    out += (node as HastNode).value ?? ''
  })
  return out
}

/** Letters and digits only. Markdown syntax (`**`, backticks, `|`, `#`, list markers) is
 *  consumed by the parser, so comparing raw strings would only prove that the renderer
 *  strips syntax; the interesting question is whether the WORDS line up. */
const words = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '')

/** The source lines a lineMap entry claims its block came from — the same slice the
 *  hover peek reads and `replaceParagraphInSource` would splice. */
function sourceSlice(source: string, mapping: LineMapping): string {
  return source.split('\n').slice(mapping.startLine, mapping.endLine + 1).join('\n').trim()
}

// --- wiring ----------------------------------------------------------------

interface ProviderCall {
  segments: string[]
  sourceLang: string
  targetLang: string
}

function lastOf<T extends ExtensionMessage['type']>(
  posted: ExtensionMessage[],
  type: T,
): Extract<ExtensionMessage, { type: T }> {
  const found = [...posted].reverse().find((m) => m.type === type)
  if (!found) throw new Error(`no ${type} message was posted`)
  return found as Extract<ExtensionMessage, { type: T }>
}

function tooltipFor(posted: ExtensionMessage[], paragraphIndex: number): string {
  const found = [...posted]
    .reverse()
    .find((m) => m.type === 'showTooltip' && m.paragraphIndex === paragraphIndex)
  if (!found || found.type !== 'showTooltip') throw new Error(`no tooltip for block ${paragraphIndex}`)
  return found.html
}

function setup(source: string, translate: (segment: string) => string = (s) => `T(${s})`) {
  const posted: ExtensionMessage[] = []
  const calls: ProviderCall[] = []
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    translateBatch: async (segments: string[], sourceLang: string, targetLang: string) => {
      calls.push({ segments: [...segments], sourceLang, targetLang })
      return segments.map(translate)
    },
    getSupportedLanguages: async () => [],
    testConnection: async () => {},
  }
  const renderer = new MarkdownRenderer((rel) => `vscode-webview://res/${rel}`)
  const cache = new TranslationCache()
  const engine = new TranslationEngine(() => provider as never, cache, renderer)
  const doc = { text: source }
  const applied: string[] = []
  const deps: PreviewDeps = {
    post: (m) => posted.push(m),
    renderer,
    engine,
    cache,
    settings: new SettingsManager(),
    exportService: { exportTranslation: async () => {} } as never,
    getDocumentText: () => doc.text,
    getDocumentUri: () => vscode.Uri.file('/docs/readme.md') as never,
    applyEdit: async (text: string) => void applied.push(text),
  }
  return { controller: new PreviewController(deps), posted, calls, cache, doc, applied }
}

beforeEach(() => {
  vscode.__resetHost()
  vscode.__clearConfig()
  vscode.__setConfig('kiro-md-translator', {
    storageLanguage: 'en',
    targetLanguage: 'de',
    translationMode: 'on-demand',
    // Keyless provider: these journeys are about rendering and language direction,
    // not about the missing-API-key hint.
    providerType: 'ollama',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// J1 — open a .md and get a rendered, block-indexed preview whose lineMap really
// points at the source.
// ---------------------------------------------------------------------------

const RICH_DOC = [
  '# Read Markdown Translator',
  '',
  'Intro paragraph with **bold**, _em_, `inline code` and a [link](https://example.com).',
  '',
  '## Features',
  '',
  '- first bullet',
  '- second bullet',
  '',
  '### Steps',
  '',
  '1. clone the repo',
  '2. run the build',
  '',
  '| Feature | State |',
  '| --- | --- |',
  '| Preview | done |',
  '| Export | ready |',
  '',
  '```js',
  'const answer = 42 // the note',
  '```',
  '',
  '![local diagram](img/a.png)',
  '',
  '![remote badge](https://img.example.com/b.png)',
].join('\n')

describe('J1: opening a .md renders every documented element with usable block indices', () => {
  // README: "Rendered CommonMark + GFM preview (headings, lists, tables, fenced/inline
  // code, links, images)"; req 1.4 lists the same set, req 10.9 adds `<pre>`/`<tr>` to the
  // indexed blocks and excludes the table wrapper and cells.
  it('indexes exactly the promised block set and nothing else', async () => {
    const { controller, posted } = setup(RICH_DOC)
    await controller.renderNow()
    controller.dispose()

    const renders = posted.filter((m) => m.type === 'renderContent')
    expect(renders).toHaveLength(1)
    const render = lastOf(posted, 'renderContent')
    expect(render.display).toBe(true) // nothing translated yet → show the source

    const tags = blockTags(render.html)
    expect([...new Set(tags.map((b) => b.tag))].sort()).toEqual([
      'h1',
      'h2',
      'h3',
      'li',
      'p',
      'pre',
      'tr',
    ])
    // The row is the unit: header + two body rows, and no wrapper/cell carries an index.
    expect(tags.filter((b) => b.tag === 'tr')).toHaveLength(3)
    expect(render.html).not.toMatch(/<(table|th|td)[^>]*data-paragraph-index/)
  })

  // CLAUDE.md ("lineMap correspondence") and req 7.14/10.16: the lineMap is what the
  // surgical write-back splices and what element-level scroll sync resolves. If an entry
  // pointed at the wrong lines, saving a paragraph would overwrite a different one.
  it('every lineMap entry really spans the source lines of its block', async () => {
    const { controller, posted } = setup(RICH_DOC)
    await controller.renderNow()
    controller.dispose()
    const render = lastOf(posted, 'renderContent')

    const indices = blockIndices(render.html)
    // Dense, gap-free, in document order — the webview addresses blocks by position.
    expect(indices).toEqual(indices.map((_, i) => i))
    expect(render.lineMap.map((m) => m.paragraphIndex)).toEqual(indices)

    const texts = blockTexts(render.html)
    for (const mapping of render.lineMap) {
      const label = `block ${mapping.paragraphIndex} (lines ${mapping.startLine}-${mapping.endLine})`
      const rendered = words(texts.get(mapping.paragraphIndex) ?? '')
      expect(words(sourceSlice(RICH_DOC, mapping)), label).toContain(rendered)
    }
    // Guard against the loop above passing vacuously: only the two image-only paragraphs
    // carry no text of their own, and an empty string is a substring of anything.
    const withText = render.lineMap.filter((m) => words(texts.get(m.paragraphIndex) ?? '').length > 0)
    expect(withText.length).toBe(render.lineMap.length - 2)
  })

  // Req 1.5: relative image paths resolve against the Active_File's directory. An
  // absolute URL is already loadable and must survive untouched.
  it('rewrites relative image paths through the resolver and leaves absolute URLs alone', async () => {
    const { controller, posted } = setup(RICH_DOC)
    await controller.renderNow()
    controller.dispose()
    const { html } = lastOf(posted, 'renderContent')

    expect(html).toContain('vscode-webview://res/img/a.png')
    expect(html).toContain('src="https://img.example.com/b.png"')
    expect(html).not.toContain('res/https')
  })

  // Req 1.7: "IF a .md file is empty, THEN the Preview_Panel SHALL display 'The file has
  // no content'." An empty lineMap matters as much as the message: a stale one would let
  // a hover or a save address a block that is no longer there.
  it('an empty file renders the placeholder and an empty lineMap', async () => {
    const { controller, posted } = setup('   \n')
    await controller.renderNow()
    controller.dispose()
    const render = lastOf(posted, 'renderContent')

    expect(render.html).toContain('The file has no content')
    expect(render.lineMap).toEqual([])
    expect(blockIndices(render.html)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// J12 — the Storage-vs-Target invariant across every controller entry point.
// ---------------------------------------------------------------------------

const LANG_DOC = [
  'Plain opening line.',
  '',
  'A paragraph with **emphasis** that no single cache key covers.',
  '',
  'Another paragraph with **markup** for the edit modal.',
].join('\n')

/** Let the microtask-only chains behind a `void`-fired webview message settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

describe('J12: the source language is always Storage, and no display path writes bytes', () => {
  // README: "The file on disk always stays in the Storage language (default English); the
  // Target language is an in-memory display transform." Req 3.17: the engine SHALL use
  // Storage_Language as the source language even when the provider auto-detects something
  // else. Req 7.10 is the ONE legitimate reverse direction (the modal's Target field).
  it('every provider call runs Storage→Target except the modal Target→Storage sync', async () => {
    vi.useFakeTimers()
    vscode.__setConfig('kiro-md-translator', 'translationMode', 'automatic')
    const { controller, posted, calls, doc, applied } = setup(LANG_DOC)

    // Open the file: automatic mode translates immediately (req 3.5).
    controller.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls[0]).toMatchObject({ sourceLang: 'en', targetLang: 'de' })

    // The user switches the preview back to the original, then hovers a block: the
    // reverse of a SOURCE preview is a forward Storage→Target translation (req 7.4).
    controller.onWebviewMessage({ type: 'displayModeChanged', displaying: 'source' })
    await controller.handleHover(1)
    // …and back to the translation: now the reverse is the known source, no call (req 7.3).
    const beforeReverseHover = calls.length
    controller.onWebviewMessage({ type: 'displayModeChanged', displaying: 'translation' })
    await controller.handleHover(1)
    expect(calls.length).toBe(beforeReverseHover)

    // The edit modal prefills its Target field (req 7.9)…
    controller.onWebviewMessage({ type: 'editParagraph', paragraphIndex: 2 })
    await flush()
    expect(posted.find((m) => m.type === 'editModalSyncComplete' && m.field === 'target')).toBeDefined()

    // …and syncs both ways as the user types in either field (reqs 7.9 / 7.10).
    await controller.handleModalSync('storage', 'Another paragraph with **markup**, edited.')
    await controller.handleModalSync('target', 'Ein anderer Absatz mit **Markup**.')
    controller.onWebviewMessage({ type: 'cancelParagraphEdit' })

    // Changing the Target language re-translates into the new one (still from Storage).
    vscode.__setConfig('kiro-md-translator', 'targetLanguage', 'fr')
    controller.onSettingsChanged()
    await vi.advanceTimersByTimeAsync(1500)
    controller.dispose()

    expect(calls.length).toBeGreaterThanOrEqual(6) // the journey really exercised every path

    // Exactly one call may run in the reverse direction, and it must be the Target→Storage
    // one. Asserting the direction (rather than "some reverse call is allowed") keeps a
    // leak the other way — e.g. a hover that sends Target as the source — failing.
    const reverse = calls.filter((c) => c.sourceLang !== 'en')
    expect(reverse).toHaveLength(1)
    expect(reverse[0]).toMatchObject({ sourceLang: 'de', targetLang: 'en' })
    for (const call of calls.filter((c) => c !== reverse[0])) {
      expect(call.sourceLang).toBe('en') // never 'auto', never the target
      expect(['de', 'fr']).toContain(call.targetLang)
    }
    expect(calls.some((c) => c.targetLang === 'fr')).toBe(true)

    // The other half of the promise: displaying and hovering never touch the file.
    expect(doc.text).toBe(LANG_DOC)
    expect(applied).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// J13 — reverse hover on a translated preview.
// ---------------------------------------------------------------------------

const HOVER_DOC = [
  'The opening block, which the tooltip must never show.',
  '',
  'The second prose block, which is the one the tooltip must show.',
  '',
  '- a bullet item',
  '',
  '```bash',
  'docker run -d \\',
  '  --name graph neo4j:5',
  '```',
  '',
  '| Command | Effect |',
  '| --- | --- |',
  '| build | compiles |',
].join('\n')

describe('J13: hovering a translated preview costs nothing and peeks at the right source', () => {
  it('serves the known source for prose, code and table rows without a single API call', async () => {
    const { controller, posted, calls } = setup(HOVER_DOC)
    await controller.renderNow()
    const render = lastOf(posted, 'renderContent')

    controller.onWebviewMessage({ type: 'translateRequest' })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'translationComplete')).toBe(true))
    const afterTranslate = calls.length
    expect(afterTranslate).toBeGreaterThan(0)

    // Address blocks by what they are, so a renderer change that shifts the numbering
    // fails on the index-lock-step test (J14) rather than silently here.
    const tags = blockTags(render.html)
    const proseIndex = tags.filter((b) => b.tag === 'p')[1].index
    const fenceIndex = tags.filter((b) => b.tag === 'pre')[0].index
    const rowIndex = tags.filter((b) => b.tag === 'tr').slice(-1)[0].index

    await controller.handleHover(proseIndex)
    await controller.handleHover(fenceIndex)
    await controller.handleHover(rowIndex)

    // Req 7.3: the reverse of a translated preview is the already-known source, taken
    // from the Active_File without contacting the Translation_API.
    expect(calls.length).toBe(afterTranslate)

    // The peek must be THIS block's source. The tooltip is resolved through the lineMap,
    // while the index the user hovered is the one `annotate` painted onto the DOM — two
    // independent passes over the tree, so comparing them is exactly the drift check that
    // `<pre>`/`<tr>` indexing put at risk. (Comparing the tooltip against the lineMap's
    // own slice would only restate the controller's arithmetic back to itself.)
    const proseTip = htmlText(tooltipFor(posted, proseIndex))
    expect(words(proseTip)).toBe(words(blockTexts(render.html).get(proseIndex) ?? ''))
    expect(proseTip).not.toContain('opening block')
    expect(proseTip).not.toContain('bullet')

    // CHANGELOG 0.7.0 / req 7.15: "a code block in the reverse-translation tooltip stays a
    // real code block (whitespace kept, ``` fences gone)".
    const fenceTip = tooltipFor(posted, fenceIndex)
    expect(fenceTip).toMatch(/<pre[^>]*>\s*<code/)
    expect(fenceTip).not.toContain('```')
    expect(htmlText(fenceTip)).toContain('docker run -d \\\n  --name graph neo4j:5')

    // A table row is an indexed block too (req 10.9), so its peek shows its cells.
    // NOTE: today it shows them as the raw `| build | compiles |` line inside a <p>, not
    // as a rendered row — a bare row is not a table without its separator line. Req 7.15
    // asks for "formatted content the same way as the main preview, NOT raw Markdown
    // text", so this assertion deliberately checks only the cell TEXT: it stays true when
    // that gap is closed, and it does not bless the current pipes as correct.
    const rowText = htmlText(tooltipFor(posted, rowIndex))
    expect(rowText).toContain('build')
    expect(rowText).toContain('compiles')

    // Req 7.7: leaving the block hides the tooltip.
    controller.onWebviewMessage({ type: 'paragraphHoverEnd', paragraphIndex: rowIndex })
    expect(posted.some((m) => m.type === 'hideTooltip')).toBe(true)
    controller.dispose()
  })
})

// ---------------------------------------------------------------------------
// J14 — source and translated renders assign identical block indices.
// ---------------------------------------------------------------------------

const BILINGUAL_DOC = [
  '# Bilingual contract',
  '',
  '- loose one',
  '',
  '- loose two',
  '',
  'An ordered list follows.',
  '',
  '1. tight one',
  '2. tight two',
  '',
  'A nested list follows.',
  '',
  '- outer',
  '  - inner',
  '',
  '| Col A | Col B |',
  '| --- | --- |',
  '| r1a | r1b |',
  '| r2a | r2b |',
  '',
  '```js',
  'const x = 1 // note',
  '```',
  '',
  '> A quoted paragraph.',
  '',
  'Text with `inline code` and a [link](https://example.com).',
].join('\n')

/** Wraps the original in brackets so a test can read back, from the TRANSLATED html,
 *  which source segments landed in which block — and drastically changes the length, so
 *  a length-sensitive indexing bug has somewhere to show up. */
const LOUD = (s: string): string => `SEHR LANGER UEBERSETZTER TEXT [${s}]`

describe('J14: source and translated renders share one set of block indices', () => {
  // README: Bilingual view lays out "each paragraph laid out exactly across from its
  // translation", reusing the shared `data-paragraph-index` (reqs 10.3/10.4). CLAUDE.md
  // calls the same property the reason element-level scroll sync and surgical write-back
  // work. Nothing pairs the two columns except this index.
  it('the translated html carries the same indices, in the same order, as the source', async () => {
    const { controller, posted } = setup(BILINGUAL_DOC, LOUD)
    await controller.renderNow()
    const render = lastOf(posted, 'renderContent')

    controller.onWebviewMessage({ type: 'translateRequest' })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'translationComplete')).toBe(true))
    const translated = lastOf(posted, 'translationComplete')
    expect(translated.translatedHtml).toContain('SEHR LANGER UEBERSETZTER TEXT')

    const sourceIdx = blockIndices(render.html)
    expect(sourceIdx.length).toBeGreaterThan(12) // headings, both list shapes, rows, fence, quote
    expect(sourceIdx).toEqual(sourceIdx.map((_, i) => i))
    expect(blockIndices(translated.translatedHtml)).toEqual(sourceIdx)
    expect(render.lineMap.map((m) => m.paragraphIndex)).toEqual(sourceIdx)

    controller.dispose()
  })

  it('block N in the translated column is built from block N of the source', async () => {
    const { controller, posted } = setup(BILINGUAL_DOC, LOUD)
    await controller.renderNow()
    const render = lastOf(posted, 'renderContent')
    controller.onWebviewMessage({ type: 'translateRequest' })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'translationComplete')).toBe(true))
    const translated = lastOf(posted, 'translationComplete')

    // Index equality alone would still pass if a translation merged two blocks or shifted
    // their content by one. `LOUD` carries each original segment along, so every segment
    // that surfaced at index N can be checked against the SOURCE block at index N — a
    // block whose content came from a neighbour fails here.
    const sourceTexts = blockTexts(render.html)
    const translatedTexts = blockTexts(translated.translatedHtml)
    expect(translatedTexts.size).toBe(sourceTexts.size)
    for (const [index, text] of translatedTexts) {
      const originals = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1])
      expect(originals.length, `block ${index} carries no translated segment`).toBeGreaterThan(0)
      for (const original of originals) {
        expect(sourceTexts.get(index) ?? '', `block ${index}`).toContain(original)
      }
    }

    controller.dispose()
  })

  // Req 10.6: toggling Bilingual_View reuses the two already-rendered HTMLs and SHALL NOT
  // contact the Translation_API. The host's share of that is to forward the toggle only.
  it('the Bilingual toggle forwards one message and spends no API call', async () => {
    const { controller, posted, calls } = setup(BILINGUAL_DOC, LOUD)
    await controller.renderNow()
    controller.onWebviewMessage({ type: 'translateRequest' })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'translationComplete')).toBe(true))

    const callsBefore = calls.length
    const postedBefore = posted.length
    controller.hostToggleBilingual()

    expect(posted.slice(postedBefore)).toEqual([{ type: 'hostToggleBilingual' }])
    expect(calls.length).toBe(callsBefore)
    controller.dispose()
  })
})
