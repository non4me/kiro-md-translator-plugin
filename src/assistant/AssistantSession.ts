import type { ExtensionMessage } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { extractEdit } from './editFence'
import { assistantErrorMessage } from './errors'

export interface AssistantSessionDeps {
  provider: IAssistantProvider
  initial: AssistantMessage[]
  post: (m: ExtensionMessage) => void
  renderMarkdown: (md: string) => Promise<string>
}

/** Ephemeral per-dialog conversation object (req 1). Not persisted — closing the
 *  panel discards it. `initial` (from buildContext) is prepended to every turn but
 *  never stored in `history`, so it is not re-sent redundantly by the caller. */
export class AssistantSession {
  private readonly history: AssistantMessage[] = []
  private lastReply = ''
  private abort: AbortController | undefined
  constructor(private readonly deps: AssistantSessionDeps) {}

  private async run(messages: AssistantMessage[]): Promise<string> {
    this.abort?.abort()
    this.abort = new AbortController()
    let acc = ''
    for await (const chunk of this.deps.provider.chat(messages, this.abort.signal)) {
      acc += chunk
      this.deps.post({ type: 'assistantChunk', text: chunk })
    }
    return acc
  }

  async ask(text: string): Promise<void> {
    this.history.push({ role: 'user', content: text })
    try {
      const reply = await this.run([...this.deps.initial, ...this.history])
      this.history.push({ role: 'assistant', content: reply })
      this.lastReply = reply
      const html = await this.deps.renderMarkdown(reply)
      this.deps.post({ type: 'assistantReply', html, canApply: extractEdit(reply) !== undefined })
    } catch (err) {
      console.error('AI Assistant: chat request failed', err)
      this.deps.post({ type: 'assistantError', message: assistantErrorMessage(err) })
    }
  }

  async summarize(): Promise<string> {
    const messages: AssistantMessage[] = [
      ...this.deps.initial,
      ...this.history,
      { role: 'user', content: 'Summarize this discussion into a concise note I can keep as a comment. Plain prose, no preamble.' },
    ]
    return this.run(messages)
  }

  lastEdit(): string | undefined { return extractEdit(this.lastReply) }
  cancel(): void { this.abort?.abort() }
}
