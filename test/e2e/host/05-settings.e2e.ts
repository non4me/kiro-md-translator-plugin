/**
 * E11 — SettingsManager against the REAL configuration service.
 *
 * This is not a re-run of business logic; it is the one place where the vitest
 * mock is provably a different machine. The mock fakes `getConfiguration` with flat
 * `section.key` string concatenation and an `inspect()` that ALWAYS returns
 * `defaultValue`/`workspaceValue`/`workspaceFolderValue` as undefined — and
 * `SettingsManager.getAiAssistantProvider` makes a real product decision on exactly
 * those three fields plus `vscode.env.appName`. Under the mock, the precedence
 * chain the documentation promises has never once executed.
 *
 * The promise being tested is the one written into the setting's own description:
 * "When unset, this defaults to GitHub Copilot in VS Code (no key needed) and to
 * Ollama everywhere else, unless you pick a provider explicitly."
 */
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { SettingsManager } from '../../../src/SettingsManager'
import { CONFIG_SECTION, activatedExtension } from './helpers/host'

const cfg = () => vscode.workspace.getConfiguration(CONFIG_SECTION)

/** The documented rule, not the code's rule. */
const documentedDefaultProvider = (): string =>
  /visual studio code/i.test(vscode.env.appName ?? '') ? 'vscode-copilot' : 'ollama'

describe('E11: SettingsManager on the live configuration service', () => {
  let settings: SettingsManager

  before(async function () {
    this.timeout(60_000)
    await activatedExtension()
    settings = new SettingsManager()
  })

  it('documents the host it is running on', () => {
    // `appName` is the input to the host-aware default below; recording it here is
    // what makes the next assertion interpretable rather than mysterious.
    assert.match(
      vscode.env.appName,
      /visual studio code/i,
      `this run reports appName "${vscode.env.appName}" — the Copilot default below is then not exercised`,
    )
  })

  it('overrides the manifest default with the host-aware one when nothing is set', () => {
    // The manifest default is a "no explicit value" sentinel; the effective value is
    // decided at read time. The two must genuinely differ, or this proves nothing.
    assert.equal(cfg().inspect('aiAssistant.provider')?.defaultValue, 'ollama')
    assert.equal(settings.getAiAssistantConfig().provider, documentedDefaultProvider())
    assert.notEqual(documentedDefaultProvider(), 'ollama')
  })

  it('lets an explicit workspace value win, and falls back again when it is cleared', async () => {
    // Writes <workspace>/.vscode/settings.json — safe only because the workspace is
    // a throwaway copy made by .vscode-test.mjs. The clear MUST happen whatever the
    // assertions do, hence the finally.
    try {
      await cfg().update('aiAssistant.provider', 'openai', vscode.ConfigurationTarget.Workspace)
      assert.equal(settings.getAiAssistantConfig().provider, 'openai')
    } finally {
      await cfg().update('aiAssistant.provider', undefined, vscode.ConfigurationTarget.Workspace)
    }
    assert.equal(cfg().inspect('aiAssistant.provider')?.workspaceValue, undefined)
    assert.equal(settings.getAiAssistantConfig().provider, documentedDefaultProvider())
  })

  it('reads the documented defaults for every field of the plugin config', () => {
    // Target Language empty maps to undefined, which is what switches translation
    // off (req 4.12) and what keeps this whole layer off the network.
    assert.deepEqual(settings.getConfig(), {
      targetLanguage: undefined,
      storageLanguage: 'en',
      translationMode: 'on-demand',
      providerType: 'deepl',
      customEndpoint: undefined,
      ollamaEndpoint: 'http://localhost:11434',
      ollamaModel: 'llama3.1',
      glossary: [],
      commentStorage: 'sidecar',
      commentPlacement: 'after-paragraph',
      commentAutoImport: true,
      codeHighlightTheme: 'auto',
    })
  })

  it('reads the documented AI Assistant defaults', () => {
    assert.deepEqual(settings.getAiAssistantConfig(), {
      enabled: false,
      provider: documentedDefaultProvider(),
      model: '',
      endpoint: 'http://localhost:11434',
      systemPrompt: '',
      reuseTranslationProvider: true,
    })
  })
})
