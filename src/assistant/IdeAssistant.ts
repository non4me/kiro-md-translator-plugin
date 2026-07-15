import * as vscode from 'vscode'
import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider, AssistantProviderType } from './types'
import { t } from '../l10n'

/**
 * IDE-hosted assistant: wraps `vscode.lm.selectChatModels` + `model.sendRequest`.
 * Serves the VS Code Copilot language model via `vscode.lm` (req 13.2/13.3, 17.3).
 */
export class IdeAssistant implements IAssistantProvider {
  readonly id: AssistantProviderType
  readonly displayName = 'VS Code Copilot'

  constructor(id: AssistantProviderType, private readonly family: string | undefined) {
    this.id = id
  }

  private async pick(): Promise<vscode.LanguageModelChat> {
    const models = await vscode.lm.selectChatModels(this.family ? { family: this.family } : {})
    if (!models.length) {
      throw new TranslatorError(
        'INVALID_ENDPOINT_URL',
        t(
          'GitHub Copilot models are unavailable. Make sure GitHub Copilot is installed and signed in, then run "Markdown Translator: Test AI Assistant Connection" once (or reload the window) to authorize access.',
        ),
      )
    }
    return models[0]
  }

  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const model = await this.pick()
    const lm = messages.map((m) =>
      m.role === 'assistant'
        ? vscode.LanguageModelChatMessage.Assistant(m.content)
        : vscode.LanguageModelChatMessage.User(m.content),
    )
    const cts = new vscode.CancellationTokenSource()
    signal.addEventListener('abort', () => cts.cancel())
    const res = await model.sendRequest(lm, {}, cts.token)
    for await (const part of res.text) yield part
  }

  async testConnection(): Promise<void> {
    await this.pick()
  }
}
