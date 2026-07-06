import { describe, it, expect, vi, afterEach } from 'vitest'
import { PreviewController, type PreviewDeps } from '../src/PreviewController'
import { TranslationCache } from '../src/TranslationCache'
import { MarkdownRenderer } from '../src/MarkdownRenderer'
import { TranslationEngine } from '../src/TranslationEngine'
import type { ExtensionMessage, PluginConfig } from '../src/types'
import { Uri } from './mocks/vscode'

const CONFIG: PluginConfig = {
  targetLanguage: 'de',
  storageLanguage: 'en',
  translationMode: 'on-demand',
  providerType: 'deepl',
  customEndpoint: undefined,
}

function setup(opts: Partial<PreviewDeps> = {}) {
  const posted: ExtensionMessage[] = []
  const cache = new TranslationCache()
  const renderer = new MarkdownRenderer()
  const state = { providerCalls: 0 }
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    translateBatch: async (segs: string[]) => {
      state.providerCalls += 1
      return segs.map((s) => `T(${s})`)
    },
    getSupportedLanguages: async () => [],
    testConnection: async () => {},
  }
  const engine = new TranslationEngine(() => provider as never, cache, renderer)
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
    getDocumentText: () => '',
    getDocumentUri: () => Uri.file('/docs/readme.md') as never,
    ...opts,
  }
  return { controller: new PreviewController(deps), posted, cache, state }
}

describe('PreviewController memory monitor (req 5.1/5.6)', () => {
  it('warns only when plugin-owned memory exceeds the threshold', () => {
    let bytes = 100 * 1024 * 1024
    const { controller, posted } = setup({ ownedMemoryBytes: () => bytes })
    controller.checkMemory()
    expect(posted.find((m) => m.type === 'memoryWarning')).toBeUndefined() // 100 MB < 150 MB
    bytes = 151 * 1024 * 1024
    controller.checkMemory()
    expect(
      posted.find((m) => m.type === 'memoryWarning' && m.level === 'high-memory'),
    ).toBeDefined()
  })
})

describe('PreviewController reverse translation (req 7.3/7.4)', () => {
  const lineMap = [{ paragraphIndex: 0, startLine: 0, endLine: 0 }]

  it('7.3: translated preview returns the known source WITHOUT an API call', async () => {
    const { controller, posted, state } = setup()
    controller.primeRenderState('Hello world.', lineMap, true)
    await controller.handleHover(0)
    expect(posted.find((m) => m.type === 'showTooltip')).toMatchObject({
      reverseTranslation: 'Hello world.',
    })
    expect(state.providerCalls).toBe(0)
  })

  it('7.4: source preview — cache MISS calls the provider once, HIT does not', async () => {
    const { controller, posted, state } = setup()
    controller.primeRenderState('Hello world.', lineMap, false)
    await controller.handleHover(0) // miss → provider
    expect(state.providerCalls).toBe(1)
    expect(posted.find((m) => m.type === 'showTooltip')).toMatchObject({
      reverseTranslation: 'T(Hello world.)',
    })
    await controller.handleHover(0) // hit → no extra provider call
    expect(state.providerCalls).toBe(1)
  })
})

describe('PreviewController display-mode toggle (Translate <-> Original)', () => {
  const lineMap = [{ paragraphIndex: 0, startLine: 0, endLine: 0 }]

  it('updateButtonState reports the storage and target language codes', () => {
    const { controller, posted } = setup()
    controller.updateButtonState()
    expect(posted.find((m) => m.type === 'updateButtonState')).toMatchObject({
      storageLang: 'en',
      targetLang: 'de',
    })
  })

  it('displayModeChanged=translation makes hover serve the known source without an API call', async () => {
    const { controller, posted, state } = setup()
    controller.primeRenderState('Hello world.', lineMap, false) // showing source
    controller.onWebviewMessage({ type: 'displayModeChanged', displaying: 'translation' })
    await controller.handleHover(0)
    expect(state.providerCalls).toBe(0) // treated as translation → reverse is the known source
    expect(posted.find((m) => m.type === 'showTooltip')).toMatchObject({
      reverseTranslation: 'Hello world.',
    })
  })
})

describe('PreviewController settings-change refresh', () => {
  afterEach(() => vi.useRealTimers())

  it('re-translates on a target-language change in automatic mode (no stale language)', async () => {
    vi.useFakeTimers()
    let target: string | undefined = 'de'
    const settings = {
      getConfig: () => ({ ...CONFIG, targetLanguage: target, translationMode: 'automatic' as const }),
      getTargetLanguage: () => target,
      getStorageLanguage: () => 'en',
      getTranslationMode: () => 'automatic' as const,
      getProviderType: () => 'deepl' as const,
      getCustomEndpoint: () => undefined,
      onDidChangeSettings: () => ({ dispose() {} }),
    }
    const { controller, state } = setup({ settings: settings as never })
    controller.primeRenderState('Hello world.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], true)
    const before = state.providerCalls
    target = 'fr' // user changes the target language
    controller.onSettingsChanged()
    await vi.runAllTimersAsync()
    expect(state.providerCalls).toBe(before + 1)
  })

  it('does NOT re-translate on a custom-endpoint change while a non-custom provider is active', async () => {
    vi.useFakeTimers()
    let endpoint: string | undefined = 'https://a.example'
    const settings = {
      getConfig: () => ({
        ...CONFIG,
        translationMode: 'automatic' as const,
        providerType: 'deepl' as const,
        customEndpoint: endpoint,
      }),
      getTargetLanguage: () => CONFIG.targetLanguage,
      getStorageLanguage: () => CONFIG.storageLanguage,
      getTranslationMode: () => 'automatic' as const,
      getProviderType: () => 'deepl' as const,
      getCustomEndpoint: () => endpoint,
      onDidChangeSettings: () => ({ dispose() {} }),
    }
    const { controller, state } = setup({ settings: settings as never })
    controller.primeRenderState('Hello world.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], true)
    const before = state.providerCalls
    endpoint = 'https://b.example' // endpoint changed, but provider is deepl → irrelevant
    controller.onSettingsChanged()
    await vi.runAllTimersAsync()
    expect(state.providerCalls).toBe(before) // no spurious re-translate
  })

  it('DOES re-translate on a custom-endpoint change while the custom provider is active', async () => {
    vi.useFakeTimers()
    let endpoint = 'https://a.example'
    const settings = {
      getConfig: () => ({
        ...CONFIG,
        translationMode: 'automatic' as const,
        providerType: 'custom' as const,
        customEndpoint: endpoint,
      }),
      getTargetLanguage: () => CONFIG.targetLanguage,
      getStorageLanguage: () => CONFIG.storageLanguage,
      getTranslationMode: () => 'automatic' as const,
      getProviderType: () => 'custom' as const,
      getCustomEndpoint: () => endpoint,
      onDidChangeSettings: () => ({ dispose() {} }),
    }
    const { controller, state } = setup({ settings: settings as never })
    controller.primeRenderState('Hello world.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], true)
    const before = state.providerCalls
    endpoint = 'https://b.example' // endpoint change on the custom provider → must re-translate
    controller.onSettingsChanged()
    await vi.runAllTimersAsync()
    expect(state.providerCalls).toBe(before + 1)
  })

  it('re-translates when switching on-demand -> automatic without a language change', async () => {
    vi.useFakeTimers()
    let mode: 'on-demand' | 'automatic' = 'on-demand'
    const settings = {
      getConfig: () => ({ ...CONFIG, translationMode: mode }),
      getTargetLanguage: () => CONFIG.targetLanguage,
      getStorageLanguage: () => CONFIG.storageLanguage,
      getTranslationMode: () => mode,
      getProviderType: () => CONFIG.providerType,
      getCustomEndpoint: () => CONFIG.customEndpoint,
      onDidChangeSettings: () => ({ dispose() {} }),
    }
    const { controller, state } = setup({ settings: settings as never })
    controller.primeRenderState('Hello world.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    const before = state.providerCalls
    mode = 'automatic' // switch mode only; language unchanged
    controller.onSettingsChanged()
    await vi.runAllTimersAsync()
    expect(state.providerCalls).toBe(before + 1)
  })
})

describe('PreviewController cold-start key readiness (req 3.5)', () => {
  it('automatic mode defers the first translation until the API key is loaded', async () => {
    let release!: () => void
    const ready = new Promise<void>((r) => {
      release = r
    })
    const settings = {
      getConfig: () => ({ ...CONFIG, translationMode: 'automatic' as const }),
      getTargetLanguage: () => CONFIG.targetLanguage,
      getStorageLanguage: () => CONFIG.storageLanguage,
      getTranslationMode: () => 'automatic' as const,
      getProviderType: () => CONFIG.providerType,
      getCustomEndpoint: () => CONFIG.customEndpoint,
      onDidChangeSettings: () => ({ dispose() {} }),
    }
    const { controller, state } = setup({
      settings: settings as never,
      getDocumentText: () => 'Hello world.',
      whenReady: () => ready,
    })
    controller.start()
    await Promise.resolve()
    expect(state.providerCalls).toBe(0) // key not loaded yet → no empty-key translate
    release()
    await vi.waitFor(() => expect(state.providerCalls).toBe(1))
    controller.dispose()
  })
})

describe('PreviewController edit-modal Target prefill (req 7.9)', () => {
  const lineMap = [{ paragraphIndex: 0, startLine: 0, endLine: 0 }]

  it('fills Target by translating the paragraph on a cache miss', async () => {
    const { controller, posted, state } = setup()
    controller.primeRenderState('Hello world.', lineMap, true) // translation displayed
    controller.onWebviewMessage({ type: 'editParagraph', paragraphIndex: 0 })
    // Modal opens immediately with an empty Target (whole-paragraph key is a miss)…
    expect(posted.find((m) => m.type === 'openEditModal')).toMatchObject({
      storageText: 'Hello world.',
      targetText: '',
    })
    // …then the Target is filled asynchronously from a paragraph translation.
    await vi.waitFor(() =>
      expect(
        posted.find((m) => m.type === 'editModalSyncComplete' && m.field === 'target'),
      ).toMatchObject({ text: 'T(Hello world.)' }),
    )
    expect(state.providerCalls).toBe(1)
  })

  it('prefills Target from the cache without an API call on a hit', async () => {
    const { controller, posted, cache, state } = setup()
    cache.set('Hello world.', 'de', 'HALLO Welt.')
    controller.primeRenderState('Hello world.', lineMap, true)
    controller.onWebviewMessage({ type: 'editParagraph', paragraphIndex: 0 })
    await Promise.resolve()
    expect(posted.find((m) => m.type === 'openEditModal')).toMatchObject({ targetText: 'HALLO Welt.' })
    expect(posted.find((m) => m.type === 'editModalSyncStart')).toBeUndefined()
    expect(state.providerCalls).toBe(0)
  })
})

describe('PreviewController render/display coordination (req 2.6/3.11)', () => {
  const lineMap = [{ paragraphIndex: 0, startLine: 0, endLine: 0 }]

  it('keeps a shown translation on screen (renderContent display:false) during a re-render', async () => {
    const { controller, posted } = setup()
    controller.primeRenderState('Hello world.', lineMap, true) // a translation is displayed
    await controller.renderNow()
    expect(posted.find((m) => m.type === 'renderContent')).toMatchObject({ display: false })
  })

  it('displays source (renderContent display:true) when no translation is shown', async () => {
    const { controller, posted } = setup()
    controller.primeRenderState('Hello world.', lineMap, false)
    await controller.renderNow()
    expect(posted.find((m) => m.type === 'renderContent')).toMatchObject({ display: true })
  })
})

describe('PreviewController comments wiring (req 11)', () => {
  const lineMap = [{ paragraphIndex: 0, startLine: 0, endLine: 0 }]

  function fakeComments() {
    const calls: unknown[][] = []
    const service = {
      calls,
      load: async () => void calls.push(['load']),
      reanchor: (blocks: unknown, src: unknown) => {
        calls.push(['reanchor', blocks, src])
        return { forBlocks: [{ paragraphIndex: 0, count: 2 }], orphaned: [{ quote: 'q', comments: [] }] }
      },
      getThreadComments: (i: number) => {
        calls.push(['getThreadComments', i])
        return [{ id: 'c1', body: 'hi', createdAt: 'T', updatedAt: 'T' }]
      },
      addComment: (i: number, b: string) => {
        calls.push(['addComment', i, b])
        return { id: 'c1', body: b, createdAt: 'T', updatedAt: 'T' }
      },
      editComment: (id: string, b: string) => void calls.push(['editComment', id, b]),
      deleteComment: (id: string) => void calls.push(['deleteComment', id]),
      flush: async () => void calls.push(['flush']),
    }
    return service
  }

  it('requestComments re-anchors and pushes indicator counts + the orphaned list', () => {
    const svc = fakeComments()
    const { controller, posted } = setup({ commentsService: svc as never })
    controller.primeRenderState('Hello.', lineMap, false)
    controller.onWebviewMessage({ type: 'requestComments' })
    expect(svc.calls.some((c) => c[0] === 'reanchor')).toBe(true)
    expect(posted.find((m) => m.type === 'commentsForBlocks')).toMatchObject({
      blocks: [{ paragraphIndex: 0, count: 2 }],
    })
    expect(posted.find((m) => m.type === 'orphanedComments')).toBeDefined()
  })

  it('addComment routes to the service and re-emits indicators', () => {
    const svc = fakeComments()
    const { controller, posted } = setup({ commentsService: svc as never })
    controller.primeRenderState('Hello.', lineMap, false)
    controller.onWebviewMessage({ type: 'addComment', paragraphIndex: 0, body: 'nice' })
    expect(svc.calls).toContainEqual(['addComment', 0, 'nice'])
    expect(posted.find((m) => m.type === 'commentsForBlocks')).toBeDefined()
  })

  it('requestCommentThread posts the block thread', () => {
    const svc = fakeComments()
    const { controller, posted } = setup({ commentsService: svc as never })
    controller.primeRenderState('Hello.', lineMap, false)
    controller.onWebviewMessage({ type: 'requestCommentThread', paragraphIndex: 0 })
    expect(posted.find((m) => m.type === 'commentThread')).toMatchObject({
      paragraphIndex: 0,
      comments: [{ body: 'hi' }],
    })
  })

  it('edit and delete route to the service', () => {
    const svc = fakeComments()
    const { controller } = setup({ commentsService: svc as never })
    controller.primeRenderState('Hello.', lineMap, false)
    controller.onWebviewMessage({ type: 'editComment', commentId: 'c1', body: 'x' })
    controller.onWebviewMessage({ type: 'deleteComment', commentId: 'c1' })
    expect(svc.calls).toContainEqual(['editComment', 'c1', 'x'])
    expect(svc.calls).toContainEqual(['deleteComment', 'c1'])
  })

  it('comment messages are no-ops when no comments service is injected', () => {
    const { controller, posted } = setup()
    controller.primeRenderState('Hello.', lineMap, false)
    controller.onWebviewMessage({ type: 'requestComments' })
    controller.onWebviewMessage({ type: 'addComment', paragraphIndex: 0, body: 'x' })
    expect(posted.find((m) => m.type === 'commentsForBlocks')).toBeUndefined()
  })
})

describe('PreviewController settings hint (req 3.20)', () => {
  function settingsFor(cfg: Partial<PluginConfig>) {
    const merged = { ...CONFIG, ...cfg }
    return {
      getConfig: () => merged,
      getTargetLanguage: () => merged.targetLanguage,
      getStorageLanguage: () => merged.storageLanguage,
      getTranslationMode: () => merged.translationMode,
      getProviderType: () => merged.providerType,
      getCustomEndpoint: () => merged.customEndpoint,
      onDidChangeSettings: () => ({ dispose() {} }),
    }
  }

  function hintFor(cfg: Partial<PluginConfig>, hasApiKey?: boolean): string | undefined {
    const { controller, posted } = setup({
      settings: settingsFor(cfg) as never,
      ...(hasApiKey === undefined ? {} : { hasApiKey: () => hasApiKey }),
    })
    controller.updateButtonState()
    const msg = posted.find((m) => m.type === 'updateButtonState')
    return msg && msg.type === 'updateButtonState' ? msg.settingsHint : undefined
  }

  it('deepl with a target but no key → hint names the API key', () => {
    expect(hintFor({ providerType: 'deepl', targetLanguage: 'de' }, false)).toBe(
      'Set the API key in settings',
    )
  })

  it('deepl with a target and a key → no hint', () => {
    expect(hintFor({ providerType: 'deepl', targetLanguage: 'de' }, true)).toBeUndefined()
  })

  it('deepl with neither a target nor a key → hint names both', () => {
    expect(hintFor({ providerType: 'deepl', targetLanguage: undefined }, false)).toBe(
      'Set the target language and API key in settings',
    )
  })

  it('ollama without a target → hint names only the target (key not required)', () => {
    expect(hintFor({ providerType: 'ollama', targetLanguage: undefined }, false)).toBe(
      'Set the target language in settings',
    )
  })

  it('ollama with a target and no key → no hint (keyless provider)', () => {
    expect(hintFor({ providerType: 'ollama', targetLanguage: 'de' }, false)).toBeUndefined()
  })

  it('custom with a target and no key → no hint (key optional)', () => {
    expect(hintFor({ providerType: 'custom', targetLanguage: 'de' }, false)).toBeUndefined()
  })

  it('absent hasApiKey dep (unit context) → key treated as present, no hint', () => {
    expect(hintFor({ providerType: 'deepl', targetLanguage: 'de' })).toBeUndefined()
  })

  it('openSettings message runs the openSettings command', () => {
    const calls: unknown[][] = []
    const { controller } = setup({
      executeCommand: (command, ...args) => {
        calls.push([command, ...args])
        return Promise.resolve()
      },
    })
    controller.onWebviewMessage({ type: 'openSettings' })
    expect(calls).toContainEqual(['kiro-md-translator.openSettings'])
  })
})
