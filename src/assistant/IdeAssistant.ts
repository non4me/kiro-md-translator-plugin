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
  // Matches ASSISTANT_PROVIDER_LABEL['vscode-copilot'], which is what the
  // connection-test toast prefixes its message with.
  readonly displayName = 'GitHub Copilot Chat'

  constructor(id: AssistantProviderType, private readonly family: string | undefined) {
    this.id = id
  }

  private async pick(): Promise<vscode.LanguageModelChat> {
    // Constrain to the Copilot vendor so we never pick a different lm provider's
    // model (a VS Code with Copilot exposes many vendors: copilot, copilotcli,
    // claude-code, openrouter…). Try the configured/default family first, then
    // fall back to any Copilot model so a family that this account lacks does not
    // read as "Copilot unavailable".
    const vendor = 'copilot'
    let models = this.family
      ? await vscode.lm.selectChatModels({ vendor, family: this.family })
      : []
    if (!models.length) {
      models = await vscode.lm.selectChatModels({ vendor })
    }
    if (!models.length) {
      // An empty result is ambiguous by design: `selectChatModels` returns [] both
      // when Copilot is absent AND when it is installed but has not yet granted this
      // extension access (consent is only prompted from a user-initiated action).
      // The public API cannot tell them apart, so the message must not pick one.
      throw new TranslatorError(
        'INVALID_ENDPOINT_URL',
        t(
          'No GitHub Copilot chat model is available. Either GitHub Copilot is not installed and signed in, or it has not granted this extension access to its models yet. Run "Markdown Translator: Test AI Assistant Connection" from the Command Palette and approve the access prompt, then try again — or reload the window if access was already granted.',
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
