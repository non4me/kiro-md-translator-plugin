import { describe, it, expect, beforeEach } from 'vitest'
import { SettingsManager } from '../src/SettingsManager'
import { __clearConfig, __setConfig } from './mocks/vscode'

describe('SettingsManager', () => {
  beforeEach(() => __clearConfig())

  it('returns sensible defaults (storage=en, target=undefined, on-demand)', () => {
    const s = new SettingsManager()
    expect(s.getStorageLanguage()).toBe('en')
    expect(s.getTargetLanguage()).toBeUndefined()
    expect(s.getTranslationMode()).toBe('on-demand')
    expect(s.getProviderType()).toBe('deepl')
    expect(s.getCustomEndpoint()).toBeUndefined()
  })

  it('comment storage defaults to sidecar, auto-import to on', () => {
    const s = new SettingsManager()
    expect(s.getCommentStorage()).toBe('sidecar')
    expect(s.getCommentAutoImport()).toBe(true)
  })

  it('reads the draft storage and a disabled auto-import', () => {
    __setConfig('kiro-md-translator', 'commentStorage', 'draft')
    __setConfig('kiro-md-translator', 'commentAutoImport', false)
    const cfg = new SettingsManager().getConfig()
    expect(cfg.commentStorage).toBe('draft')
    expect(cfg.commentAutoImport).toBe(false)
  })

  it('reads configured values into a PluginConfig snapshot', () => {
    __setConfig('kiro-md-translator', 'targetLanguage', 'ru')
    __setConfig('kiro-md-translator', 'translationMode', 'automatic')
    __setConfig('kiro-md-translator', 'providerType', 'google')
    const cfg = new SettingsManager().getConfig()
    expect(cfg.targetLanguage).toBe('ru')
    expect(cfg.translationMode).toBe('automatic')
    expect(cfg.providerType).toBe('google')
    expect(cfg.storageLanguage).toBe('en')
  })

  it('addGlossaryTerm appends a new do-not-translate term (req 3.19)', async () => {
    const s = new SettingsManager()
    expect(await s.addGlossaryTerm('GitHub')).toBe(true)
    expect(s.getGlossary()).toContain('GitHub')
  })

  it('addGlossaryTerm trims, dedupes, and ignores blanks', async () => {
    __setConfig('kiro-md-translator', 'glossary', ['API'])
    const s = new SettingsManager()
    expect(await s.addGlossaryTerm('API')).toBe(false) // already present
    expect(await s.addGlossaryTerm('   ')).toBe(false) // blank
    expect(await s.addGlossaryTerm('  SDK  ')).toBe(true) // trimmed then added
    expect(s.getGlossary()).toEqual(['API', 'SDK'])
  })
})

describe('comment storage settings', () => {
  beforeEach(() => __clearConfig())

  it('defaults to sidecar + after-paragraph', () => {
    const s = new SettingsManager()
    expect(s.getCommentStorage()).toBe('sidecar')
    expect(s.getCommentPlacement()).toBe('after-paragraph')
  })

  it('reads configured values', () => {
    __setConfig('kiro-md-translator', 'commentStorage', 'inline')
    __setConfig('kiro-md-translator', 'commentPlacement', 'end-of-file')
    const s = new SettingsManager()
    expect(s.getCommentStorage()).toBe('inline')
    expect(s.getCommentPlacement()).toBe('end-of-file')
  })

  it('surfaces both in the PluginConfig snapshot', () => {
    __setConfig('kiro-md-translator', 'commentStorage', 'inline')
    const cfg = new SettingsManager().getConfig()
    expect(cfg.commentStorage).toBe('inline')
    expect(cfg.commentPlacement).toBe('after-paragraph')
  })
})
