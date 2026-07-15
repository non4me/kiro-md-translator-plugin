import { describe, it, expect, afterEach } from 'vitest'
import { IdeAssistant } from '../src/assistant/IdeAssistant'
import { __setLmModels, type MockLmModel } from './mocks/vscode'

function scriptedModel(chunks: string[]): MockLmModel {
  return {
    vendor: 'copilot',
    family: 'gpt-4o',
    id: 'copilot-gpt-4o',
    name: 'GitHub Copilot',
    sendRequest: async () => ({
      text: (async function* () {
        for (const c of chunks) yield c
      })(),
    }),
  }
}

afterEach(() => __setLmModels([]))

describe('IdeAssistant', () => {
  it('streams accumulated text from the selected model', async () => {
    __setLmModels([scriptedModel(['Hi', ' there'])])
    const p = new IdeAssistant('vscode-copilot', undefined)
    const out: string[] = []
    for await (const s of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) out.push(s)
    expect(out.join('')).toBe('Hi there')
  })

  it('throws the Copilot-not-found message when no model is available (req 17.3)', async () => {
    __setLmModels([])
    const p = new IdeAssistant('vscode-copilot', undefined)
    await expect(p.testConnection()).rejects.toThrow(
      'GitHub Copilot not found. Please install and authenticate the GitHub Copilot extension',
    )
  })
})
