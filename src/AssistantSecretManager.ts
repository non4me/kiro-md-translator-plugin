import type * as vscode from 'vscode'
import type { AssistantProviderType } from './assistant/types'

const PREFIX = 'kiro-md-translator.apiKey.aiAssistant'

/** Keychain-only storage for AI Assistant provider keys (req 2.4–2.6), namespaced
 *  apart from translation keys so a same-named provider never collides. */
export class AssistantSecretManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  private slot(p: AssistantProviderType): string { return `${PREFIX}.${p}` }
  saveKey(p: AssistantProviderType, key: string): Promise<void> { return Promise.resolve(this.secrets.store(this.slot(p), key)) }
  getKey(p: AssistantProviderType): Promise<string | undefined> { return Promise.resolve(this.secrets.get(this.slot(p))) }
  deleteKey(p: AssistantProviderType): Promise<void> { return Promise.resolve(this.secrets.delete(this.slot(p))) }
}
