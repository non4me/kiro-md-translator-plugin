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
})
