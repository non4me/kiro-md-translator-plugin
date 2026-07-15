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

/** True when `err` is how a provider reports its stream having been aborted — a DOM
 *  `AbortError` (fetch) or a vscode cancellation (`IdeAssistant`'s `CancellationTokenSource`).
 *  Distinct from a genuine provider/network failure, which must still surface. */
function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name
  return name === 'AbortError' || name === 'Canceled' || name === 'Cancelled'
}

/** Ephemeral per-dialog conversation object (req 1). Not persisted — closing the
 *  panel discards it. `initial` (from buildContext) is prepended to every turn but
 *  never stored in `history`, so it is not re-sent redundantly by the caller. */
export class AssistantSession {
  private readonly history: AssistantMessage[] = []
  private lastReply = ''
  private abort: AbortController | undefined
  constructor(private readonly deps: AssistantSessionDeps) {}

  /** `controller` is owned by the caller (one per `ask`/`summarize` turn), not shared
   *  state, so a superseded call can tell it was aborted even after a later turn has
   *  already installed its own controller in `this.abort`. */
  private async run(messages: AssistantMessage[], controller: AbortController): Promise<string> {
    this.abort?.abort()
    this.abort = controller
    let acc = ''
    for await (const chunk of this.deps.provider.chat(messages, controller.signal)) {
      acc += chunk
      this.deps.post({ type: 'assistantChunk', text: chunk })
    }
    return acc
  }

  async ask(text: string): Promise<void> {
    this.history.push({ role: 'user', content: text })
    const controller = new AbortController()
    try {
      const reply = await this.run([...this.deps.initial, ...this.history], controller)
      // Cancelled (Close) or superseded (re-open/new turn) mid-stream: a provider
      // that returns cleanly on abort instead of throwing must not surface either.
      if (controller.signal.aborted) return
      this.history.push({ role: 'assistant', content: reply })
      this.lastReply = reply
      const html = await this.deps.renderMarkdown(reply)
      this.deps.post({ type: 'assistantReply', html, canApply: extractEdit(reply) !== undefined })
    } catch (err) {
      // Cancellation is not an error (req: cancelling must stay silent, never cross-talk
      // an assistantError into a re-opened dialog). Only genuine provider/network
      // failures reach the user.
      if (controller.signal.aborted || isAbortError(err)) return
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
    return this.run(messages, new AbortController())
  }

  lastEdit(): string | undefined { return extractEdit(this.lastReply) }
  cancel(): void { this.abort?.abort() }
}
