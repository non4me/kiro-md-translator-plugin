import { describe, it, expect, afterEach } from 'vitest'
import { IdeAssistant } from '../src/assistant/IdeAssistant'
import { __setLmModels, type MockLmModel } from './mocks/vscode'

function model(vendor: string, family: string, reply: string): MockLmModel {
  return {
    vendor,
    family,
    id: `${vendor}-${family}`,
    name: `${vendor} ${family}`,
    sendRequest: async () => ({
      text: (async function* () {
        yield reply
      })(),
    }),
  }
}

async function collect(p: IdeAssistant): Promise<string> {
  let out = ''
  for await (const s of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) out += s
  return out
}

afterEach(() => __setLmModels([]))

describe('IdeAssistant', () => {
  it('streams accumulated text from the selected model', async () => {
    __setLmModels([model('copilot', 'gpt-4o', 'Hi there')])
    expect(await collect(new IdeAssistant('vscode-copilot', undefined))).toBe('Hi there')
  })

  it('constrains selection to the copilot vendor (never another lm provider)', async () => {
    __setLmModels([model('openrouter', 'grok', 'WRONG'), model('copilot', 'gpt-4o', 'RIGHT')])
    expect(await collect(new IdeAssistant('vscode-copilot', undefined))).toBe('RIGHT')
  })

  it('prefers the configured/default family, else falls back to any copilot model', async () => {
    __setLmModels([
      model('copilot', 'gpt-4o', 'GPT'),
      model('copilot', 'claude-sonnet-4.5', 'SONNET'),
    ])
    // Exact family wins.
    expect(await collect(new IdeAssistant('vscode-copilot', 'claude-sonnet-4.5'))).toBe('SONNET')
    // A family this account lacks falls back to any copilot model — not "unavailable".
    expect(await collect(new IdeAssistant('vscode-copilot', 'no-such-family'))).toBe('GPT')
  })

  it('throws an actionable Copilot-unavailable message when no copilot model exists (req 17.3)', async () => {
    __setLmModels([model('openrouter', 'grok', 'x')]) // a model exists, but not from Copilot
    const p = new IdeAssistant('vscode-copilot', 'claude-sonnet-4.5')
    await expect(p.testConnection()).rejects.toThrow(
      'GitHub Copilot models are unavailable. Make sure GitHub Copilot is installed and signed in, then run "Markdown Translator: Test AI Assistant Connection" once (or reload the window) to authorize access.',
    )
  })
})
