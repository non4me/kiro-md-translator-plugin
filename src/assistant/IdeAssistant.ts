import * as vscode from 'vscode'
import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider, AssistantProviderType } from './types'
import { t } from '../l10n'

/**
 * IDE-hosted assistant: wraps `vscode.lm.selectChatModels` + `model.sendRequest`.
 * Serves BOTH `vscode-copilot` and `kiro-ide` — the model is whatever the running
 * IDE surfaces through `vscode.lm`, no IDE-specific API. See the factory below for
 * a note on the `kiro-ide` assumption (req 13.2/13.3, 17.3/17.4).
 */
export class IdeAssistant implements IAssistantProvider {
  readonly id: AssistantProviderType
  readonly displayName: string

  constructor(id: AssistantProviderType, private readonly family: string | undefined) {
    this.id = id
    this.displayName = id === 'kiro-ide' ? 'Kiro IDE' : 'VS Code Copilot'
  }

  private async pick(): Promise<vscode.LanguageModelChat> {
    const models = await vscode.lm.selectChatModels(this.family ? { family: this.family } : {})
    if (!models.length) {
      throw new TranslatorError(
        'INVALID_ENDPOINT_URL',
        this.id === 'kiro-ide'
          ? t('Kiro IDE Provider is only available in Kiro IDE')
          : t('GitHub Copilot not found. Please install and authenticate the GitHub Copilot extension'),
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
