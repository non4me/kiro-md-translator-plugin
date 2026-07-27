/**
 * Integration tests for the translation pipeline — journeys J2, J10 and J11.
 *
 * Everything below the network boundary is REAL: `ActivationController` wires the
 * real `SettingsManager`, `MarkdownRenderer`, `TranslationEngine`, `TranslationCache`,
 * `PersistentTranslationCache`/`LayeredTranslationCache`, `Glossary`, `codeComments`
 * and `PreviewController` over the vscode mock, and the tests drive it the way the
 * host does — a webview message in, posted messages out. That is the point: the
 * promises here ("reopening a file does not re-spend API quota", "glossary terms are
 * never sent", "code is never sent") live in the seams BETWEEN those modules, and no
 * unit test that stubs a collaborator can observe them.
 *
 * The ONE thing that is faked is `createProvider` — the HTTP boundary. The real
 * providers call global `fetch`, and `ActivationController` offers no seam to inject
 * a provider, so the factory is mocked to hand back a recorder. What the provider was
 * actually asked to translate is the only observable form of most of these promises.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from '../mocks/vscode'
import { ActivationController } from '../../src/ActivationController'
import { SettingsManager } from '../../src/SettingsManager'
import type { ExtensionMessage } from '../../src/types'

/** Recorder standing in for the translation API. `translate` is swappable so a suite
 *  can choose an output that is provably absent from the source. */
const provider = vi.hoisted(() => ({
  calls: [] as Array<{ segments: string[]; sourceLang: string; targetLang: string }>,
  translate: (segment: string): string => `T(${segment})`,
}))

vi.mock('../../src/providers/ProviderFactory', () => ({
  createProvider: () => ({
    id: 'recording',
    displayName: 'Recording',
    translateBatch: async (segments: string[], sourceLang: string, targetLang: string) => {
      provider.calls.push({ segments: [...segments], sourceLang, targetLang })
      return segments.map((s) => provider.translate(s))
    },
    getSupportedLanguages: async () => [],
    testConnection: async () => {},
  }),
}))

const SECTION = 'kiro-md-translator'

interface Session {
  doc: vscode.MockTextDocument
  panel: vscode.MockWebviewPanel
  /** Every message the host posted to this preview, oldest first. */
  posted: ExtensionMessage[]
  close(): Promise<void>
}

const live: Session[] = []

/** Open one document in a real preview, exactly as the host does: activate the
 *  extension over an ExtensionContext, then resolve the custom editor. Passing the
 *  SAME `globalState` to a later call is what an IDE restart looks like. */
async function openPreview(
  source: string,
  globalState: vscode.MemMemento,
  path = '/docs/readme.md',
): Promise<Session> {
  const activation = new ActivationController()
  const context = vscode.__createExtensionContext({ globalState })
  activation.activate(context as never)
  const doc = vscode.__addTextDocument(new vscode.MockTextDocument(vscode.Uri.file(path), source))
  const panel = new vscode.MockWebviewPanel()
  activation.resolveCustomTextEditor(doc as never, panel as never)

  let closed = false
  const session: Session = {
    doc,
    panel,
    posted: panel.webview.posted as ExtensionMessage[],
    async close() {
      if (closed) return
      closed = true
      panel.dispose()
      for (const sub of context.subscriptions) sub.dispose()
      // req 9.6: the shutdown path is what persists the translation memory.
      await activation.deactivate()
    },
  }
  live.push(session)
  // The first render lands on a 300 ms debounce. Draining it here is what makes a
  // later "nothing was re-rendered" assertion mean something.
  await waitFor(session, (m) => m.type === 'renderContent')
  return session
}

async function waitFor(
  session: Session,
  match: (m: ExtensionMessage) => boolean,
  from = 0,
): Promise<ExtensionMessage> {
  const deadline = Date.now() + 5000
  for (;;) {
    const hit = session.posted.slice(from).find(match)
    if (hit) return hit
    if (Date.now() > deadline) {
      throw new Error(`timed out; the host posted: ${session.posted.map((m) => m.type).join(', ')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** Click Translate and return the HTML the preview was given. A translationError is
 *  raised rather than swallowed — otherwise a broken harness reads as "no API calls". */
async function translate(session: Session): Promise<string> {
  const from = session.posted.length
  session.panel.webview.__receive({ type: 'translateRequest' })
  const done = await waitFor(
    session,
    (m) => m.type === 'translationComplete' || m.type === 'translationError',
    from,
  )
  if (done.type === 'translationError') {
    throw new Error(`translation failed (${done.code}): ${done.message}`)
  }
  return (done as Extract<ExtensionMessage, { type: 'translationComplete' }>).translatedHtml
}

/** The persisted Translation_Memory. The store key is private to
 *  PersistentTranslationCache, so find it rather than restate it. */
function readMemory(
  memento: vscode.MemMemento,
): { f: string; e: Array<[string, string]> } | undefined {
  const key = memento.keys().find((k) => k.includes('translationMemory'))
  return key ? memento.get<{ f: string; e: Array<[string, string]> }>(key) : undefined
}

/** Visible text of a render: highlighting wraps code tokens in `<span>`s, so a code
 *  line only reads back as one string once the markup is off and entities are back. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([\da-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function sentSegments(): string[] {
  return provider.calls.flatMap((c) => c.segments)
}

beforeEach(() => {
  vscode.__resetHost()
  vscode.__clearConfig()
  provider.calls.length = 0
  provider.translate = (segment: string) => `T(${segment})`
})

afterEach(async () => {
  for (const session of live.splice(0)) await session.close()
})

// ---------------------------------------------------------------------------
// J2 — "Persistent translation memory — translations are remembered across IDE
// sessions, so reopening a file does not re-spend API quota on already-translated
// text." (README:22; reqs 3.4, 3.9, 5.3, 9.1, 9.2, 9.3, 9.5, 9.6)
// ---------------------------------------------------------------------------

const RELEASE_NOTES = [
  '# Release notes',
  '',
  'Reopening a file does not re-spend API quota.',
  '',
  'Translations are remembered across IDE sessions.',
  '',
].join('\n')

/** Every prose segment of RELEASE_NOTES, in document order. */
const RELEASE_PROSE = [
  'Release notes',
  'Reopening a file does not re-spend API quota.',
  'Translations are remembered across IDE sessions.',
]

describe('J2: on-demand translation, the in-session cache, and the memory across a restart', () => {
  beforeEach(() => {
    vscode.__setConfig(SECTION, {
      storageLanguage: 'en',
      targetLanguage: 'de',
      translationMode: 'on-demand',
      providerType: 'ollama',
    })
  })

  it('spends one API call, then serves the second click from L1 and a reopened file from L2', async () => {
    const memory = new vscode.MemMemento()
    const first = await openPreview(RELEASE_NOTES, memory)

    const before = first.posted.length
    const firstHtml = await translate(first)

    // req 3.10: the spinner goes up before the answer comes back, not after.
    const types = first.posted.slice(before).map((m) => m.type)
    expect(types.indexOf('translationStart')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('translationStart')).toBeLessThan(types.indexOf('translationComplete'))

    // req 3.4 + 3.7: ONE batched call carrying the document's prose and nothing else.
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].segments).toEqual(RELEASE_PROSE)
    // req 3.17: the source language is Storage_Language, never the provider's guess.
    expect(provider.calls[0].sourceLang).toBe('en')
    expect(provider.calls[0].targetLang).toBe('de')

    // reqs 3.9 / 5.3: clicking Translate again is a pure L1 hit.
    expect(await translate(first)).toBe(firstHtml)
    expect(provider.calls).toHaveLength(1)

    // req 9.6: deactivation is what writes the memory down.
    await first.close()
    const stored = readMemory(memory)
    expect(stored?.e).toHaveLength(RELEASE_PROSE.length)

    // The IDE restarts: a brand-new extension host, a brand-new L1, the same
    // globalState. README:22 says this must cost nothing.
    provider.calls.length = 0
    const reopened = await openPreview(RELEASE_NOTES, memory)
    expect(await translate(reopened)).toBe(firstHtml)
    expect(provider.calls).toEqual([])
  })

  it('re-fetches after a restart when the storage language moved while the IDE was closed (req 9.5)', async () => {
    const memory = new vscode.MemMemento()
    const first = await openPreview(RELEASE_NOTES, memory)
    await translate(first)
    await first.close()
    expect(readMemory(memory)?.e).toHaveLength(RELEASE_PROSE.length)

    // The user edits settings with no window open, so no configuration event ever
    // fires — the stored entries can only be rejected when they are hydrated.
    // Serving them would answer an en→de question with a fr→de translation.
    vscode.__setConfig(SECTION, 'storageLanguage', 'fr')
    provider.calls.length = 0

    const reopened = await openPreview(RELEASE_NOTES, memory)
    await translate(reopened)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].segments).toEqual(RELEASE_PROSE)
    expect(provider.calls[0].sourceLang).toBe('fr')
  })
})

// ---------------------------------------------------------------------------
// J10 — "Glossary — do-not-translate terms (product names, identifiers) kept verbatim
// and never sent to the translation API; add the current selection to it by
// right-clicking." (README:18; reqs 3.18, 3.19, 9.5)
// ---------------------------------------------------------------------------

const HANDBOOK = [
  '# DataLite handbook',
  '',
  'DataLite ships TSM as part of the platform.',
  '',
  'Every DataLite deployment bundles WidgetKit.',
  '',
].join('\n')

describe('J10: the glossary never leaves the host, and changing it drops both cache tiers', () => {
  beforeEach(() => {
    vscode.__setConfig(SECTION, {
      storageLanguage: 'en',
      targetLanguage: 'de',
      translationMode: 'on-demand',
      providerType: 'ollama',
      glossary: ['DataLite', 'TSM'],
    })
  })

  it('masks configured terms out of every request, restores them verbatim, and re-translates once a term is added', async () => {
    const session = await openPreview(HANDBOOK, new vscode.MemMemento())

    const firstHtml = await translate(session)
    const firstSent = sentSegments().join('\n')
    // req 3.18: the term is absent from what is sent, and a sentinel stands in its place.
    expect(firstSent).not.toContain('DataLite')
    expect(firstSent).not.toContain('TSM')
    expect(firstSent).toContain('⟦')
    // Differential baseline: a word that is NOT in the glossary DOES go out, so the
    // two assertions above are about the glossary and not about a dead pipeline.
    expect(firstSent).toContain('WidgetKit')
    // ...and the protected terms come back untouched in what the user reads.
    expect(firstHtml).toContain('DataLite')
    expect(firstHtml).toContain('TSM')

    // req 3.19: "add the current selection to it by right-clicking" ends here.
    expect(await new SettingsManager().addGlossaryTerm('WidgetKit')).toBe(true)
    provider.calls.length = 0
    vscode.__fireConfigChange(`${SECTION}.glossary`)

    // req 9.5: entries produced under the OLD glossary are wrong now, so the click
    // must reach the provider again rather than replay them.
    const secondHtml = await translate(session)
    expect(provider.calls.length).toBeGreaterThan(0)
    const secondSent = sentSegments().join('\n')
    for (const term of ['DataLite', 'TSM', 'WidgetKit']) {
      expect(secondSent).not.toContain(term)
      expect(secondHtml).toContain(term)
    }
  })

  it('reordering the same terms is not a glossary change and costs no API call', async () => {
    const session = await openPreview(HANDBOOK, new vscode.MemMemento())
    const firstHtml = await translate(session)
    provider.calls.length = 0

    // Same set, different order. Nothing about the output can differ, so req 9.5's
    // "the glossary changed" does not apply and README:22's quota promise holds.
    vscode.__setConfig(SECTION, 'glossary', ['TSM', 'DataLite'])
    vscode.__fireConfigChange(SECTION)

    expect(await translate(session)).toBe(firstHtml)
    expect(provider.calls).toEqual([])
  })

  // RESOLVED 2026-07-27. Two layers disagreed and the blunter one won:
  // `configFingerprint` hashed every provider's endpoint/model unconditionally, so
  // editing a DORMANT provider's endpoint dropped both cache tiers, while
  // `PreviewController.onSettingsChanged` already scoped each endpoint to its own
  // provider — a guard that could therefore never be reached. Req 9.5's «провайдер
  // (его тип, эндпоинт или модель)» is now read as the ACTIVE provider's, the reading
  // README's quota promise requires: a setting no future translation reads must not
  // cost one. `providerType` stays in the hash, so switching provider still invalidates.
  it("keeps the memory when a dormant provider's endpoint changes, drops it for the active one", async () => {
    vscode.__setConfig(SECTION, 'providerType', 'ollama')
    const session = await openPreview(HANDBOOK, new vscode.MemMemento())
    const firstHtml = await translate(session)
    provider.calls.length = 0

    // Ollama is active; `customEndpoint` belongs to the custom provider and is read by
    // nothing on this path. The memory must survive.
    vscode.__setConfig(SECTION, 'customEndpoint', 'https://example.invalid/v1')
    vscode.__fireConfigChange(SECTION)
    expect(await translate(session)).toBe(firstHtml)
    expect(provider.calls).toEqual([])

    // The ACTIVE provider's own endpoint is a different matter: those entries were
    // produced by a different server, so they must go.
    vscode.__setConfig(SECTION, 'ollamaEndpoint', 'http://localhost:11500')
    vscode.__fireConfigChange(SECTION)
    await translate(session)
    expect(provider.calls.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// J11 — "Translated code comments — prose inside code comments is translated, while
// the code itself is never sent to the translation provider and never altered."
// (README:21, README:27; reqs 3.7, 3.22, 12.1, 12.3, 12.6, 12.7)
// ---------------------------------------------------------------------------

const CODE_TRAPS = [
  '# Pipeline notes',
  '',
  'Run `npm run build` before shipping; see [the docs](https://example.com/build).',
  '',
  '```js',
  "const clean = url.replace(/\\/\\//g, '/') // collapse double slashes",
  '```',
  '',
  '```lua',
  '--[==[ module notes ]==]',
  'local s = [[ raw -- not a comment ]]',
  'print(s) -- show it',
  '```',
  '',
  '```bash',
  '#!/usr/bin/env bash',
  'echo "${PATH#/usr}" # strip the prefix',
  '```',
  '',
  '```python',
  'def f():',
  '    """Docstring stays a string."""',
  '    x = "a # b"  # separator',
  '```',
  '',
].join('\n')

describe('J11: code stays home, comment prose travels, and a translated comment is still a comment', () => {
  beforeEach(() => {
    vscode.__setConfig(SECTION, {
      storageLanguage: 'en',
      targetLanguage: 'ru',
      translationMode: 'on-demand',
      providerType: 'ollama',
      codeHighlightTheme: 'auto',
    })
    // A prefix no source byte carries, so "this came back from the provider" and
    // "this was never sent" are both decidable by looking at the output.
    provider.translate = (segment: string) => `[RU]${segment}`
  })

  it('sends only prose and comment prose, and leaves every executable byte alone', async () => {
    const session = await openPreview(CODE_TRAPS, new vscode.MemMemento())
    const html = await translate(session)
    const text = visibleText(html)

    // README:27 — "code, inline code and URLs are never sent to the translation API
    // (only the prose of code comments is, when present)". Each entry below is a
    // documented corruption trap from req 3.22.2-3.22.4.
    for (const segment of sentSegments()) {
      for (const forbidden of [
        'url.replace', // 3.22.3 — a regex ending in an escaped slash
        'const clean',
        'print(s)',
        'raw -- not a comment', // 3.22.4 — a Lua long-bracket string
        'usr/bin/env', // 3.22.2 — a shebang is not a comment
        'PATH#', // 3.22.2 — `#` inside a string is not a comment
        'Docstring stays a string', // 3.22.2 — a Python docstring is a string
        'def f()',
        'npm run build', // inline code
        'example.com', // a link URL
        '```', // a fence delimiter
      ]) {
        expect(segment).not.toContain(forbidden)
      }
    }
    // ...and the comment prose really did travel (otherwise "nothing was sent" would
    // satisfy the loop above).
    expect(sentSegments()).toEqual(
      expect.arrayContaining([
        'collapse double slashes',
        'module notes',
        'show it',
        'strip the prefix',
        'separator',
      ]),
    )

    // req 3.22: every other byte of the block is unchanged — marker, indentation,
    // string literals, code and fence delimiters — with the prose swapped in place.
    for (const line of [
      "const clean = url.replace(/\\/\\//g, '/') // [RU]collapse double slashes",
      '--[==[ [RU]module notes ]==]',
      'local s = [[ raw -- not a comment ]]',
      'print(s) -- [RU]show it',
      '#!/usr/bin/env bash',
      'echo "${PATH#/usr}" # [RU]strip the prefix',
      '"""Docstring stays a string."""',
      'x = "a # b"  # [RU]separator',
    ]) {
      expect(text).toContain(line)
    }

    // req 12.7: "Highlighting SHALL run AFTER translation, so a translated code
    // comment is highlighted as a comment and NEVER coloured as executable code."
    expect(html).toMatch(
      /<span class="hljs-comment">[^<]*\[RU\]collapse double slashes[^<]*<\/span>/,
    )
    // req 12.3: inline code is not highlighted (and was not translated either).
    expect(html).toContain('<code>npm run build</code>')
  })

  it('switching the highlight theme swaps the stylesheet without touching content (req 12.6)', async () => {
    const session = await openPreview(CODE_TRAPS, new vscode.MemMemento())
    const html = await translate(session)
    const documentBefore = session.doc.getText()
    const before = session.posted.length
    provider.calls.length = 0

    vscode.__setConfig(SECTION, 'codeHighlightTheme', 'off')
    vscode.__fireConfigChange(`${SECTION}.codeHighlightTheme`)

    const after = session.posted.slice(before)
    const themes = after.filter((m) => m.type === 'setCodeTheme')
    expect(themes).toHaveLength(1)
    expect((themes[0] as Extract<ExtensionMessage, { type: 'setCodeTheme' }>).css).toBe('')
    // "without re-rendering the content and without modifying any document"
    expect(after.map((m) => m.type)).not.toContain('renderContent')
    expect(after.map((m) => m.type)).not.toContain('translationComplete')
    expect(session.doc.getText()).toBe(documentBefore)

    // Colour is a stylesheet concern: the markup is theme-independent, so a fresh
    // translate produces the identical HTML — and, the theme being no part of what a
    // cached entry depends on, costs nothing.
    expect(await translate(session)).toBe(html)
    expect(provider.calls).toEqual([])
  })
})
