export type AssistantProviderType =
  | 'ollama' | 'openai' | 'anthropic' | 'google' | 'vscode-copilot'

export interface AssistantMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiAssistantConfig {
  enabled: boolean
  provider: AssistantProviderType
  model: string
  endpoint: string            // Ollama base URL; '' for others
  systemPrompt: string        // '' ⇒ use DEFAULT_SYSTEM_PROMPT
  reuseTranslationProvider: boolean
}

export interface IAssistantProvider {
  readonly id: AssistantProviderType
  readonly displayName: string
  /** Stream a reply to `messages`; yields incremental text chunks (may be many per turn). */
  chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string>
  /** Minimal round-trip used by the Test Connection command (req 16.7). */
  testConnection(): Promise<void>
}

/** Providers that authenticate with a keychain key (req 1.4). */
export const KEYED_ASSISTANT_PROVIDERS: AssistantProviderType[] = ['openai', 'anthropic', 'google']
/** Providers that need no key or endpoint (req 1.6). */
export const KEYLESS_IDE_PROVIDERS: AssistantProviderType[] = ['vscode-copilot']

export const DEFAULT_SYSTEM_PROMPT =
  'You are a documentation assistant embedded in a Markdown specification reader. ' +
  'The user selected a fragment of a spec and wants to understand or improve it. ' +
  'Explain clearly and concisely, grounded in the provided document and comments. ' +
  'When — and ONLY when — the user asks you to rewrite the selected fragment, output the ' +
  'FULL replacement text of the fragment, in the document\'s storage language, inside a ' +
  'fenced block tagged `rmt-edit`, e.g.\n\n```rmt-edit\n<full replacement here>\n```\n\n' +
  'Never put an rmt-edit fence around code you are merely quoting or explaining.'
