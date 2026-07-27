import { describe, it, expect, afterEach } from 'vitest'
import { IdeAssistant } from '../src/assistant/IdeAssistant'
import { assistantErrorMessage } from '../src/assistant/errors'
import type { TranslatorError } from '../src/types'
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

  it('names BOTH causes when no copilot model exists — not-installed and not-authorized (req 17.3)', async () => {
    __setLmModels([model('openrouter', 'grok', 'x')]) // a model exists, but not from Copilot
    const p = new IdeAssistant('vscode-copilot', 'claude-sonnet-4.5')
    const err = await p.testConnection().then(
      () => undefined,
      (e: Error) => e,
    )
    const msg = err?.message ?? ''
    // The two causes are indistinguishable through the public API, so the message
    // must offer both rather than asserting the wrong one (it used to lead with
    // "make sure Copilot is installed" at users who had it installed all along).
    expect(msg).toContain('not installed and signed in')
    expect(msg).toContain('has not granted this extension access')
    // The remedy names a real command title, verbatim from package.json.
    expect(msg).toContain('Markdown Translator: Test AI Assistant Connection')
  })

  it('reports the Copilot-unavailable message verbatim, never re-wrapped as a connection failure', async () => {
    __setLmModels([])
    const p = new IdeAssistant('vscode-copilot', undefined)
    const err = (await p.testConnection().catch((e: Error) => e)) as TranslatorError
    // `INVALID_ENDPOINT_URL` is load-bearing: errors.ts passes it through its
    // default branch untouched. Any other code would prefix "Connection failed:".
    expect(err.code).toBe('INVALID_ENDPOINT_URL')
    expect(assistantErrorMessage(err)).toBe(err.message)
  })
})
