import { describe, it, expect, beforeEach } from 'vitest'
import * as vscode from './mocks/vscode'
import { SettingsManager } from '../src/SettingsManager'

describe('SettingsManager — AI Assistant', () => {
  beforeEach(() => {
    ;(vscode as any).__clearConfig()
    ;(vscode as any).__setAppName('Test Host')
  })

  it('reads defaults: disabled, ollama, reuse on, empty prompt', () => {
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg).toEqual({
      enabled: false,
      provider: 'ollama',
      model: '',
      endpoint: 'http://localhost:11434',
      systemPrompt: '',
      reuseTranslationProvider: true,
    })
  })

  it('reflects overrides', () => {
    ;(vscode as any).__setConfig('kiro-md-translator', {
      'aiAssistant.enabled': true,
      'aiAssistant.provider': 'openai',
      'aiAssistant.model': 'gpt-4o-mini',
      'aiAssistant.reuseTranslationProvider': false,
    })
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.provider).toBe('openai')
    expect(cfg.model).toBe('gpt-4o-mini')
    expect(cfg.reuseTranslationProvider).toBe(false)
  })

  it('defaults to vscode-copilot in real VS Code when no explicit provider is set', () => {
    ;(vscode as any).__setAppName('Visual Studio Code')
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg.provider).toBe('vscode-copilot')
  })

  it('defaults to ollama on non-VS-Code hosts when no explicit provider is set', () => {
    ;(vscode as any).__setAppName('Kiro')
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg.provider).toBe('ollama')
  })

  it('honors an explicit provider even in real VS Code', () => {
    ;(vscode as any).__setAppName('Visual Studio Code')
    ;(vscode as any).__setConfig('kiro-md-translator', 'aiAssistant.provider', 'openai')
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg.provider).toBe('openai')
  })
})
