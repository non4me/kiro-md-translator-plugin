import type * as vscode from 'vscode'
import type { ISecretManager, ProviderType } from './types'

const KEY_PREFIX = 'kiro-md-translator.apiKey'
/** The single-slot key used before per-provider storage (v <= 0.1.10). */
const LEGACY_KEY = 'kiro-md-translator.apiKey'

/**
 * Stores each provider's API key ONLY in the IDE SecretStorage (OS keychain) —
 * never in workspace configuration (req 4.3). Keys are namespaced per provider
 * (`kiro-md-translator.apiKey.<provider>`) so switching provider keeps them apart.
 * It has no access to `getConfiguration`, so a key cannot leak into a plaintext
 * settings file by construction.
 */
export class SecretManager implements ISecretManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private slot(provider: ProviderType): string {
    return `${KEY_PREFIX}.${provider}`
  }

  async saveApiKey(provider: ProviderType, key: string): Promise<void> {
    await this.secrets.store(this.slot(provider), key)
  }

  async getApiKey(provider: ProviderType): Promise<string | undefined> {
    return this.secrets.get(this.slot(provider))
  }

  async deleteApiKey(provider: ProviderType): Promise<void> {
    await this.secrets.delete(this.slot(provider))
  }

  /**
   * One-time migration of the pre-0.1.10 single-slot key into the given
   * provider's slot, so an upgrading user keeps their stored key. Runs only when
   * the legacy key exists and the target slot is still empty; then clears legacy.
   */
  async migrateLegacyKey(provider: ProviderType): Promise<void> {
    const legacy = await this.secrets.get(LEGACY_KEY)
    if (!legacy) return
    if (!(await this.secrets.get(this.slot(provider)))) {
      await this.secrets.store(this.slot(provider), legacy)
    }
    await this.secrets.delete(LEGACY_KEY)
  }
}
