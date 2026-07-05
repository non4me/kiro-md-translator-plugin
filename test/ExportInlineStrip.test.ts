import { describe, it, expect, vi } from 'vitest'
import { PreviewController, type PreviewDeps } from '../src/PreviewController'
import { TranslationCache } from '../src/TranslationCache'
import { MarkdownRenderer } from '../src/MarkdownRenderer'
import type { ExtensionMessage, PluginConfig } from '../src/types'
import { Uri } from './mocks/vscode'

const CONFIG: PluginConfig = {
  targetLanguage: 'de',
  storageLanguage: 'en',
  translationMode: 'on-demand',
  providerType: 'deepl',
  customEndpoint: undefined,
}

const CARRIER_SOURCE = 'Body para.\n\n<!-- rmt:comments\n{"threads":[]}\n-->\n'

function setup(opts: Partial<PreviewDeps> = {}) {
  const posted: ExtensionMessage[] = []
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
    renderer: new MarkdownRenderer(),
    engine: {} as never,
    cache: new TranslationCache(),
    settings: settings as never,
    exportService: { exportTranslation: async () => {} } as never,
    getDocumentText: () => CARRIER_SOURCE,
    getDocumentUri: () => Uri.file('/docs/readme.md') as never,
    ...opts,
  }
  return { controller: new PreviewController(deps), posted }
}

describe('PreviewController export strips inline comment carriers (Task 9)', () => {
  it('export strips inline comment carriers before translating', async () => {
    let captured = ''
    const exportTranslation = vi.fn(async () => {})
    const engine = {
      translateToMarkdown: async (src: string) => {
        captured = src
        return 'TRANSLATED'
      },
    }
    const { controller } = setup({
      engine: engine as never,
      exportService: { exportTranslation } as never,
    })

    controller.onWebviewMessage({ type: 'saveTranslation' })
    await vi.waitFor(() => expect(exportTranslation).toHaveBeenCalled())

    expect(captured).not.toContain('rmt:comments')
    expect(captured).toContain('Body para.')
    expect(exportTranslation).toHaveBeenCalledWith('TRANSLATED', expect.anything(), 'de')
  })
})
