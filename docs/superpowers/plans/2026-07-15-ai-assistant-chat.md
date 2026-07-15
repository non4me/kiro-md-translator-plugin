# AI Assistant Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select a fragment in the rendered preview, discuss it with an LLM (which already knows the whole document and anchored comments), then either save a summary as a comment or apply a suggested edit through the existing paragraph-edit modal.

**Architecture:** A new provider seam (`IAssistantProvider`) parallel to `ITranslationProvider`, an ephemeral host-side `AssistantSession` that assembles context once and streams each turn, and new message variants in the two `src/types.ts` discriminated unions. Apply-Changes reuses the existing `openEditModal` write path; Save-Summary reuses `CommentsService.addComment`. The webview stays a dumb renderer — all model-reply markdown is rendered to HTML on the host.

**Tech Stack:** TypeScript, VS Code extension API (`vscode.lm` for the IDE provider), esbuild (host `cjs` + webview `iife`), vitest with the hand-written `test/mocks/vscode.ts`, `fetch` streaming (NDJSON for Ollama, SSE for hosted APIs).

**Reference design:** `docs/superpowers/specs/2026-07-15-ai-assistant-chat-design.md`. Spec id chain: `.kiro/specs/ai-assistant-chat/requirements.md` Requirements 1–17.

> **Post-implementation update (2026-07-16):** the `kiro-ide` provider named throughout this plan was **removed**. The `vscode.lm` spike proved Kiro registers no models into `vscode.lm` and exposes no in-process model API to extensions (only the out-of-process Kiro CLI ACP, judged not worthwhile), so `kiro-ide` is not implementable as planned. The IDE provider shipped as **`vscode-copilot` only** — constrained to the `copilot` vendor, default family `claude-sonnet-4.5` with a fallback to any Copilot model. **Ignore every `kiro-ide` reference below:** wherever a task lists `['vscode-copilot', 'kiro-ide']`, a `kiro-ide` provider case, or the `id === 'kiro-ide'` branches, the shipped code has `vscode-copilot` alone. Requirements 14 and 17.4 are intentionally unimplemented. In VS Code the default provider is `vscode-copilot`; in Kiro it is `ollama`.

## Global Constraints

- **No self-attribution** in commits, code comments, or docs (no `Co-Authored-By: Claude`, no "Generated with"). Commits authored solely by `non4me`.
- **Specs/docs/comments in English.** Conversation in Russian only.
- **Webview iife bundle must stay < 50 KB** (`esbuild.mjs`). Webview code imports only `import type` from `src/types.ts`, never Node APIs, never a markdown parser.
- **`tsconfig.json` excludes `test/`.** Tests import vscode-typed objects from `./mocks/vscode` and pass them with `as never` casts. Do not widen the include.
- **`npm run typecheck` checks `src/` only; `npm test` is the test oracle.** Both must pass before every commit.
- **Storage-language invariant.** Anything written back to the `.md` is Storage_Language and goes through `TranslationEngine.replaceParagraphInSource` (a surgical line-range splice) via the existing `openEditModal`/`saveParagraph` path. Never a whole-document re-serialize, never target-language text.
- **API keys live only in the OS keychain** (`vscode.SecretStorage`), namespaced `kiro-md-translator.apiKey.aiAssistant.<provider>`. Never in `settings.json`.
- **Engine floor stays `^1.85`** until Task 12 (the IDE provider), which raises it to `^1.90` for `vscode.lm`.
- **Feature is off by default** (`aiAssistant.enabled` defaults `false`); when off, the Ask AI button never appears.
- **Bump `package.json` version on every new `.vsix`**; never `ovsx publish` without an explicit user command.

## New Provider / Assistant Types (single source of truth)

These names are referenced by every task. Definitions land in Task 1.

```ts
// src/assistant/types.ts
export type AssistantProviderType =
  | 'ollama' | 'openai' | 'anthropic' | 'google' | 'vscode-copilot' // 'kiro-ide' dropped — see the update note above

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
export const KEYLESS_IDE_PROVIDERS: AssistantProviderType[] = ['vscode-copilot'] // 'kiro-ide' dropped — see the update note above
```

---

## File Structure

**New files (host):**
- `src/assistant/types.ts` — the interfaces/types above + `DEFAULT_SYSTEM_PROMPT`.
- `src/assistant/stream.ts` — streaming read helpers: `streamNdjson` (Ollama), `streamSse` (OpenAI/Anthropic/Google).
- `src/assistant/OllamaAssistant.ts`, `OpenAIAssistant.ts`, `AnthropicAssistant.ts`, `GoogleAssistant.ts`, `IdeAssistant.ts` — one `IAssistantProvider` each.
- `src/assistant/AssistantProviderFactory.ts` — `createAssistantProvider(config, apiKey, translationConfig)`.
- `src/assistant/context.ts` — `buildContext(...)` (context assembly + budget/degradation) and `headingPath(...)`.
- `src/assistant/editFence.ts` — `extractEdit(reply): string | undefined` (the `rmt-edit` fence parser).
- `src/assistant/AssistantSession.ts` — ephemeral per-dialog conversation + orchestration.
- `src/AssistantSecretManager.ts` — keychain access under the `aiAssistant` namespace.

**Modified files (host):**
- `src/types.ts` — new `WebviewMessage`/`ExtensionMessage` variants (Task 6).
- `src/SettingsManager.ts` — `getAiAssistantConfig()` + per-field getters.
- `src/PreviewController.ts` + `PreviewDeps` — Ask AI message handlers, session ownership.
- `src/ActivationController.ts` — wire the assistant deps, register the two new commands, build the assistant provider.
- `package.json` — new `AI Assistant` configuration section + two commands (order after Comments).

**Modified files (webview):**
- `src/webview/getPreviewHtml.ts` — the `#sel-ai` toolbar button + the `#assistant-modal` dialog markup/CSS.
- `src/webview/previewPanel.ts` — Ask AI button handler, dialog render/stream/close, apply/save buttons.

**Tests:** one `*.test.ts` per new host module under `test/`, plus additions to `test/PreviewController.test.ts`.

---

## Task 1: Assistant types, default prompt, and settings reader

**Files:**
- Create: `src/assistant/types.ts`
- Modify: `src/SettingsManager.ts`
- Modify: `src/types.ts` (add `getAiAssistantConfig` to `ISettingsManager`)
- Test: `test/SettingsManager.aiAssistant.test.ts`

**Interfaces:**
- Produces: `AssistantProviderType`, `AssistantMessage`, `AiAssistantConfig`, `IAssistantProvider`, `KEYED_ASSISTANT_PROVIDERS`, `KEYLESS_IDE_PROVIDERS`, `DEFAULT_SYSTEM_PROMPT` (all from `src/assistant/types.ts`), and `ISettingsManager.getAiAssistantConfig(): AiAssistantConfig`.

- [ ] **Step 1: Write `src/assistant/types.ts`** with the block from "New Provider / Assistant Types" above, plus:

```ts
export const DEFAULT_SYSTEM_PROMPT =
  'You are a documentation assistant embedded in a Markdown specification reader. ' +
  'The user selected a fragment of a spec and wants to understand or improve it. ' +
  'Explain clearly and concisely, grounded in the provided document and comments. ' +
  'When — and ONLY when — the user asks you to rewrite the selected fragment, output the ' +
  'FULL replacement text of the fragment, in the document\'s storage language, inside a ' +
  'fenced block tagged `rmt-edit`, e.g.\n\n```rmt-edit\n<full replacement here>\n```\n\n' +
  'Never put an rmt-edit fence around code you are merely quoting or explaining.'
```

- [ ] **Step 2: Write the failing settings test** in `test/SettingsManager.aiAssistant.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import * as vscode from './mocks/vscode'
import { SettingsManager } from '../src/SettingsManager'

describe('SettingsManager — AI Assistant', () => {
  beforeEach(() => (vscode as any).__clearConfig())

  it('reads defaults: disabled, ollama, reuse on, empty prompt', () => {
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg).toEqual({
      enabled: false,
      provider: 'ollama',
      model: '',
      endpoint: 'http://localhost:11434',
      systemPrompt: '',
      reuseTranslationProvider: true,
    })
  })

  it('reflects overrides', () => {
    ;(vscode as any).__setConfig('kiro-md-translator', {
      'aiAssistant.enabled': true,
      'aiAssistant.provider': 'openai',
      'aiAssistant.model': 'gpt-4o-mini',
      'aiAssistant.reuseTranslationProvider': false,
    })
    const cfg = new SettingsManager().getAiAssistantConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.provider).toBe('openai')
    expect(cfg.model).toBe('gpt-4o-mini')
    expect(cfg.reuseTranslationProvider).toBe(false)
  })
})
```

- [ ] **Step 3: Run it — expect FAIL** (`getAiAssistantConfig` not a function).

Run: `npx vitest run test/SettingsManager.aiAssistant.test.ts`

- [ ] **Step 4: Add the getter to `SettingsManager`** (after `getCodeHighlightTheme`):

```ts
getAiAssistantConfig(): AiAssistantConfig {
  const c = this.cfg()
  return {
    enabled: c.get<boolean>('aiAssistant.enabled', false),
    provider: c.get<AssistantProviderType>('aiAssistant.provider', 'ollama'),
    model: c.get<string>('aiAssistant.model', '') || '',
    endpoint: c.get<string>('aiAssistant.endpoint', 'http://localhost:11434') || 'http://localhost:11434',
    systemPrompt: c.get<string>('aiAssistant.systemPrompt', '') || '',
    reuseTranslationProvider: c.get<boolean>('aiAssistant.reuseTranslationProvider', true),
  }
}
```

Add imports `AiAssistantConfig, AssistantProviderType` from `./assistant/types`, and add `getAiAssistantConfig(): AiAssistantConfig` to the `ISettingsManager` interface in `src/types.ts`.

- [ ] **Step 5: Run test + typecheck — expect PASS.**

Run: `npx vitest run test/SettingsManager.aiAssistant.test.ts && npm run typecheck`

- [ ] **Step 6: Commit.**

```bash
git add src/assistant/types.ts src/SettingsManager.ts src/types.ts test/SettingsManager.aiAssistant.test.ts
git commit -m "feat(ai-assistant): assistant types, default prompt, settings reader"
```

---

## Task 2: Assistant secret manager (keychain namespace)

**Files:**
- Create: `src/AssistantSecretManager.ts`
- Test: `test/AssistantSecretManager.test.ts`

**Interfaces:**
- Consumes: `AssistantProviderType`.
- Produces: `class AssistantSecretManager` with `saveKey(p): Promise<void>`… exactly — `saveKey(provider, key)`, `getKey(provider)`, `deleteKey(provider)`, storing under `kiro-md-translator.apiKey.aiAssistant.<provider>` (req 2.4/2.6).

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest'
import { MemSecretStorage } from './mocks/vscode'
import { AssistantSecretManager } from '../src/AssistantSecretManager'

describe('AssistantSecretManager', () => {
  it('stores under the aiAssistant namespace, isolated from translation keys', async () => {
    const store = new MemSecretStorage()
    const m = new AssistantSecretManager(store as never)
    await m.saveKey('openai', 'sk-123')
    expect(await m.getKey('openai')).toBe('sk-123')
    // Never collides with a translation key of the same-named provider.
    expect(await (store as any).get('kiro-md-translator.apiKey.openai')).toBeUndefined()
    expect(await (store as any).get('kiro-md-translator.apiKey.aiAssistant.openai')).toBe('sk-123')
  })

  it('deletes a key', async () => {
    const m = new AssistantSecretManager(new MemSecretStorage() as never)
    await m.saveKey('anthropic', 'x')
    await m.deleteKey('anthropic')
    expect(await m.getKey('anthropic')).toBeUndefined()
  })
})
```

> If `MemSecretStorage` is not exported from `test/mocks/vscode.ts`, export it there in this step (additive, no behaviour change).

- [ ] **Step 2: Run it — expect FAIL.**

Run: `npx vitest run test/AssistantSecretManager.test.ts`

- [ ] **Step 3: Implement `src/AssistantSecretManager.ts`:**

```ts
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
```

- [ ] **Step 4: Run test + typecheck — expect PASS.**

Run: `npx vitest run test/AssistantSecretManager.test.ts && npm run typecheck`

- [ ] **Step 5: Commit.**

```bash
git add src/AssistantSecretManager.ts test/AssistantSecretManager.test.ts test/mocks/vscode.ts
git commit -m "feat(ai-assistant): keychain secret manager under aiAssistant namespace"
```

---

## Task 3: Streaming read helpers

**Files:**
- Create: `src/assistant/stream.ts`
- Test: `test/assistant-stream.test.ts`

**Interfaces:**
- Produces:
  - `async function* streamNdjson(res: Response, pick: (obj: any) => string | undefined): AsyncIterable<string>` — yields `pick(...)` for each newline-delimited JSON object whose pick is a non-empty string.
  - `async function* streamSse(res: Response, pick: (obj: any) => string | undefined): AsyncIterable<string>` — parses `data: {...}` SSE lines, stops on `data: [DONE]`, yields non-empty picks.

These decode `res.body` (a `ReadableStream<Uint8Array>`) with a `TextDecoder`, buffering partial lines across chunks. Reused by every HTTP assistant provider.

- [ ] **Step 1: Write the failing test** (feed a fake `Response` whose `body` is a `ReadableStream` built from chunk strings):

```ts
import { describe, it, expect } from 'vitest'
import { streamNdjson, streamSse } from '../src/assistant/stream'

function resFrom(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() },
  })
  return { body } as unknown as Response
}
async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []; for await (const s of it) out.push(s); return out
}

describe('stream helpers', () => {
  it('streamNdjson yields message.content per line, tolerating split chunks', async () => {
    const res = resFrom(['{"message":{"content":"Hel', 'lo"}}\n{"message":{"content":" world"}}\n'])
    expect(await collect(streamNdjson(res, (o) => o.message?.content))).toEqual(['Hello', ' world'])
  })

  it('streamSse yields deltas and stops at [DONE]', async () => {
    const res = resFrom([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(await collect(streamSse(res, (o) => o.choices?.[0]?.delta?.content))).toEqual(['A', 'B'])
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `npx vitest run test/assistant-stream.test.ts`

- [ ] **Step 3: Implement `src/assistant/stream.ts`:**

```ts
import { TranslatorError } from '../types'

async function* lines(res: Response): AsyncIterable<string> {
  if (!res.body) throw new TranslatorError('TRANSLATION_EMPTY_RESPONSE', 'No response body')
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl)
      buf = buf.slice(nl + 1)
    }
  }
  if (buf.trim()) yield buf
}

export async function* streamNdjson(res: Response, pick: (o: any) => string | undefined): AsyncIterable<string> {
  for await (const line of lines(res)) {
    const s = line.trim()
    if (!s) continue
    let obj: any
    try { obj = JSON.parse(s) } catch { continue }
    const piece = pick(obj)
    if (typeof piece === 'string' && piece.length) yield piece
  }
}

export async function* streamSse(res: Response, pick: (o: any) => string | undefined): AsyncIterable<string> {
  for await (const line of lines(res)) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const data = s.slice(5).trim()
    if (data === '[DONE]') return
    let obj: any
    try { obj = JSON.parse(data) } catch { continue }
    const piece = pick(obj)
    if (typeof piece === 'string' && piece.length) yield piece
  }
}
```

- [ ] **Step 4: Run test + typecheck — expect PASS.**

Run: `npx vitest run test/assistant-stream.test.ts && npm run typecheck`

- [ ] **Step 5: Commit.**

```bash
git add src/assistant/stream.ts test/assistant-stream.test.ts
git commit -m "feat(ai-assistant): NDJSON + SSE streaming read helpers"
```

---

## Task 4: Ollama assistant provider + factory (keyless end-to-end)

**Files:**
- Create: `src/assistant/OllamaAssistant.ts`
- Create: `src/assistant/AssistantProviderFactory.ts`
- Test: `test/OllamaAssistant.test.ts`

**Interfaces:**
- Consumes: `IAssistantProvider`, `AssistantMessage`, `streamNdjson`, `fetchWithTimeout`/`ensureOk` (`src/providers/http.ts`), `isValidOllamaEndpoint` (`src/providers/urlValidation.ts`).
- Produces:
  - `class OllamaAssistant implements IAssistantProvider` (id `'ollama'`), `POST {endpoint}/api/chat` with `stream: true` (req 9.4/9.7).
  - `function createAssistantProvider(config: AiAssistantConfig, apiKey: string, translation: PluginConfig): IAssistantProvider`. In Task 4 it handles `ollama` only (others throw `TranslatorError('INVALID_ENDPOINT_URL', ...)` until their tasks); `reuseTranslationProvider` maps a translation Ollama endpoint/model onto the assistant (req 2.2).

- [ ] **Step 1: Write the failing test** (stub global `fetch` to return a streaming NDJSON `Response`):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OllamaAssistant } from '../src/assistant/OllamaAssistant'

function ndjsonResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() },
  })
  return { ok: true, status: 200, body } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())

describe('OllamaAssistant', () => {
  it('streams assistant content from /api/chat', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      ndjsonResponse(['{"message":{"content":"Hi"}}\n', '{"message":{"content":" there"}}\n']) as never,
    )
    const p = new OllamaAssistant('http://localhost:11434', 'llama3.1')
    const out: string[] = []
    for await (const s of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) out.push(s)
    expect(out.join('')).toBe('Hi there')
    const url = (fetchMock.mock.calls[0] as any)[0]
    expect(url).toBe('http://localhost:11434/api/chat')
  })

  it('rejects an invalid endpoint', () => {
    expect(() => new OllamaAssistant('not a url', 'm')).toThrow()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `npx vitest run test/OllamaAssistant.test.ts`

- [ ] **Step 3: Implement `src/assistant/OllamaAssistant.ts`:**

```ts
import { TranslatorError, type PluginConfig } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { isValidOllamaEndpoint } from '../providers/urlValidation'
import { streamNdjson } from './stream'

const CHAT_TIMEOUT = 300000 // local models can take minutes per turn
const TEST_TIMEOUT = 15000

export class OllamaAssistant implements IAssistantProvider {
  readonly id = 'ollama' as const
  readonly displayName = 'Ollama'
  private readonly base: string
  constructor(endpoint: string, private readonly model: string) {
    if (!isValidOllamaEndpoint(endpoint)) {
      throw new TranslatorError('INVALID_ENDPOINT_URL', 'Invalid Ollama endpoint URL')
    }
    this.base = endpoint.replace(/\/$/, '')
  }

  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const res = await ensureOk(
      await fetchWithTimeout(
        `${this.base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, stream: true, messages }),
        },
        signal,
        CHAT_TIMEOUT,
      ),
    )
    yield* streamNdjson(res, (o) => o.message?.content)
  }

  async testConnection(): Promise<void> {
    const res = await ensureOk(
      await fetchWithTimeout(
        `${this.base}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
        },
        undefined,
        TEST_TIMEOUT,
      ),
    )
    await res.json()
  }
}
```

- [ ] **Step 4: Implement `src/assistant/AssistantProviderFactory.ts`:**

```ts
import { TranslatorError, type PluginConfig } from '../types'
import type { AiAssistantConfig, IAssistantProvider } from './types'
import { OllamaAssistant } from './OllamaAssistant'

/** Build the assistant provider for the active config (req 2). When
 *  `reuseTranslationProvider` is on AND translation is Ollama, borrow its
 *  endpoint+model so the user configures Ollama once (req 2.2). */
export function createAssistantProvider(
  config: AiAssistantConfig,
  apiKey: string,
  translation: PluginConfig,
): IAssistantProvider {
  const reuseOllama = config.reuseTranslationProvider && translation.providerType === 'ollama'
  switch (config.provider) {
    case 'ollama':
      return new OllamaAssistant(
        reuseOllama ? translation.ollamaEndpoint || 'http://localhost:11434' : config.endpoint || 'http://localhost:11434',
        reuseOllama ? translation.ollamaModel || 'llama3.1' : config.model || 'llama3.1',
      )
    default:
      throw new TranslatorError('INVALID_ENDPOINT_URL', `Unsupported assistant provider: ${config.provider}`)
  }
}
```

- [ ] **Step 5: Run test + typecheck — expect PASS.**

Run: `npx vitest run test/OllamaAssistant.test.ts && npm run typecheck`

- [ ] **Step 6: Commit.**

```bash
git add src/assistant/OllamaAssistant.ts src/assistant/AssistantProviderFactory.ts test/OllamaAssistant.test.ts
git commit -m "feat(ai-assistant): Ollama streaming provider + provider factory"
```

---

## Task 5: Edit-fence parser + context assembly

**Files:**
- Create: `src/assistant/editFence.ts`
- Create: `src/assistant/context.ts`
- Test: `test/editFence.test.ts`, `test/assistant-context.test.ts`

**Interfaces:**
- Produces:
  - `function extractEdit(reply: string): string | undefined` — returns the inner text of the LAST ` ```rmt-edit ` fence, trimmed; `undefined` when none. An ordinary code fence (` ```ts `) is ignored (req 7.7 replacement).
  - `function headingPath(source: string, startLine: number): string` — e.g. `'## 3 › ### 3.4'`, from the ATX headings above `startLine`.
  - `function buildContext(input: ContextInput): AssistantMessage[]` where
    ```ts
    export interface ContextInput {
      systemPrompt: string      // resolved (default if empty)
      selection: string         // Selection_Fragment (may be target-language)
      selectionIsTranslated: boolean
      sourceOfSelectedBlocks: string  // storage-language source of the touched blocks
      fullDocument: string
      headingPath: string
      comments: string[]        // bodies of comments anchored to the selection
      tokenBudget: number       // approx chars/4 budget for the doc
    }
    ```
    It returns the initial `[{system}, {user}]` message pair: full doc while it fits `tokenBudget`, else a degraded context (selection + its blocks + heading path + comments) with a "context trimmed" note (req 5.2 degradation). It always marks the storage-language source of the selected blocks and, when `selectionIsTranslated`, notes the highlighted sub-phrase is display text.

- [ ] **Step 1: Write the failing `editFence` test:**

```ts
import { describe, it, expect } from 'vitest'
import { extractEdit } from '../src/assistant/editFence'

describe('extractEdit', () => {
  it('returns the rmt-edit fence body', () => {
    const reply = 'Sure.\n```rmt-edit\nThe new paragraph.\n```\nDone.'
    expect(extractEdit(reply)).toBe('The new paragraph.')
  })
  it('ignores ordinary code fences', () => {
    expect(extractEdit('Here is code:\n```ts\nconst x = 1\n```')).toBeUndefined()
  })
  it('takes the LAST rmt-edit fence when several exist', () => {
    expect(extractEdit('```rmt-edit\nfirst\n```\n```rmt-edit\nsecond\n```')).toBe('second')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `npx vitest run test/editFence.test.ts`

- [ ] **Step 3: Implement `src/assistant/editFence.ts`:**

```ts
/** Extract the LAST ```rmt-edit fence body (req 7 dedicated edit channel). An
 *  ordinary code fence never matches, so a spec explanation that quotes code does
 *  not light up Apply Changes. */
export function extractEdit(reply: string): string | undefined {
  const re = /```rmt-edit[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let last: string | undefined
  while ((m = re.exec(reply)) !== null) last = m[1].replace(/\n$/, '')
  return last === undefined ? undefined : last.trim()
}
```

- [ ] **Step 4: Write the failing `context` test:**

```ts
import { describe, it, expect } from 'vitest'
import { buildContext, headingPath } from '../src/assistant/context'

const base = {
  systemPrompt: 'SYS',
  selection: 'the widget',
  selectionIsTranslated: false,
  sourceOfSelectedBlocks: 'The widget does X.',
  headingPath: '## 3 › ### 3.4',
  comments: ['must be idempotent'],
}

describe('buildContext', () => {
  it('includes the full document when it fits the budget', () => {
    const msgs = buildContext({ ...base, fullDocument: 'SHORT DOC', tokenBudget: 10_000 })
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(msgs[1].content).toContain('SHORT DOC')
    expect(msgs[1].content).toContain('the widget')
    expect(msgs[1].content).toContain('must be idempotent')
  })
  it('degrades and says so when the document exceeds the budget', () => {
    const huge = 'x'.repeat(100_000)
    const msgs = buildContext({ ...base, fullDocument: huge, tokenBudget: 100 })
    expect(msgs[1].content).not.toContain(huge)
    expect(msgs[1].content.toLowerCase()).toContain('trimmed')
    expect(msgs[1].content).toContain('The widget does X.')
  })
})

describe('headingPath', () => {
  it('joins ATX headings above the line', () => {
    const src = '# Doc\n\n## 3 Section\n\ntext\n\n### 3.4 Sub\n\ntarget line'
    expect(headingPath(src, 8)).toContain('3.4 Sub')
  })
})
```

- [ ] **Step 5: Run it — expect FAIL.** Run: `npx vitest run test/assistant-context.test.ts`

- [ ] **Step 6: Implement `src/assistant/context.ts`:**

```ts
import type { AssistantMessage } from './types'

export interface ContextInput {
  systemPrompt: string
  selection: string
  selectionIsTranslated: boolean
  sourceOfSelectedBlocks: string
  fullDocument: string
  headingPath: string
  comments: string[]
  tokenBudget: number
}

/** ATX heading trail above `startLine` (0-based), e.g. "## 3 › ### 3.4". */
export function headingPath(source: string, startLine: number): string {
  const lines = source.split('\n')
  const stack: Array<{ level: number; text: string }> = []
  for (let i = 0; i < startLine && i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (!m) continue
    const level = m[1].length
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, text: `${m[1]} ${m[2].trim()}` })
  }
  return stack.map((s) => s.text).join(' › ')
}

function commentsBlock(comments: string[]): string {
  if (!comments.length) return ''
  return `\n\nExisting comments on this fragment:\n${comments.map((c) => `- ${c}`).join('\n')}`
}

/** Assemble the initial [system, user] context (req 5). Full doc within budget,
 *  else a degraded context that names its own trimming (req 5.2). */
export function buildContext(input: ContextInput): AssistantMessage[] {
  const fits = input.fullDocument.length <= input.tokenBudget * 4
  const selNote = input.selectionIsTranslated
    ? `The user highlighted this display (translated) text: "${input.selection}". The authoritative source of the block(s) it touches is below; edits must be in the source language.`
    : `The user selected: "${input.selection}".`
  const heading = input.headingPath ? `\nLocation: ${input.headingPath}` : ''
  const source = `\n\nSource of the selected block(s):\n${input.sourceOfSelectedBlocks}`
  const doc = fits
    ? `\n\nFull document:\n${input.fullDocument}`
    : `\n\n(Context trimmed: the document is too large to include in full; only the selection, its blocks, and nearby headings are provided.)`
  const user = `${selNote}${heading}${source}${doc}${commentsBlock(input.comments)}`
  return [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: user },
  ]
}
```

- [ ] **Step 7: Run both tests + typecheck — expect PASS.**

Run: `npx vitest run test/editFence.test.ts test/assistant-context.test.ts && npm run typecheck`

- [ ] **Step 8: Commit.**

```bash
git add src/assistant/editFence.ts src/assistant/context.ts test/editFence.test.ts test/assistant-context.test.ts
git commit -m "feat(ai-assistant): edit-fence parser + context assembly with budget degradation"
```

---

## Task 6: Message protocol variants + AssistantSession

**Files:**
- Modify: `src/types.ts` (add variants to both unions)
- Create: `src/assistant/AssistantSession.ts`
- Test: `test/AssistantSession.test.ts`

**Interfaces:**
- Produces (new `WebviewMessage` variants):
  ```ts
  | { type: 'askAiOpen'; paragraphIndex: number; lastIndex?: number; selection: string; translated: boolean }
  | { type: 'askAiSend'; text: string }
  | { type: 'askAiApply' }
  | { type: 'askAiSaveSummary' }
  | { type: 'askAiClose' }
  ```
- Produces (new `ExtensionMessage` variants):
  ```ts
  | { type: 'assistantOpen'; selection: string; commentCount: number }
  | { type: 'assistantChunk'; text: string }
  | { type: 'assistantReply'; html: string; canApply: boolean }
  | { type: 'assistantError'; message: string }
  | { type: 'assistantClosed' }
  ```
- Produces `class AssistantSession`:
  ```ts
  export interface AssistantSessionDeps {
    provider: IAssistantProvider
    initial: AssistantMessage[]          // from buildContext
    post: (m: ExtensionMessage) => void
    renderMarkdown: (md: string) => Promise<string>  // host renderer → sanitized HTML
  }
  class AssistantSession {
    constructor(deps: AssistantSessionDeps)
    ask(text: string): Promise<void>     // stream a turn; posts chunks then a reply
    summarize(): Promise<string>          // returns the synopsis text (no persistence)
    lastEdit(): string | undefined        // extractEdit of the last assistant reply
    cancel(): void                        // abort in-flight request
  }
  ```
  `ask` appends `{role:'user'}`, calls `provider.chat([...initial, ...history])`, posts `assistantChunk` per increment, accumulates, appends `{role:'assistant'}`, then posts `assistantReply` with rendered HTML and `canApply = !!extractEdit(reply)`. `summarize` sends history + a summarization instruction as one more turn and returns the collected text.

- [ ] **Step 1: Add the variants to both unions in `src/types.ts`** (import `AssistantMessage` type not needed here; the payloads are plain). Place the webview variants before `openSettings`, the extension variants after `orphanedComments`.

- [ ] **Step 2: Write the failing `AssistantSession` test** (fake provider yields scripted chunks):

```ts
import { describe, it, expect, vi } from 'vitest'
import { AssistantSession } from '../src/assistant/AssistantSession'
import type { IAssistantProvider } from '../src/assistant/types'

function fakeProvider(reply: string): IAssistantProvider {
  return {
    id: 'ollama', displayName: 'x',
    async *chat() { for (const ch of reply.match(/.{1,3}/g) ?? []) yield ch },
    async testConnection() {},
  }
}

describe('AssistantSession', () => {
  it('streams chunks then posts a rendered reply, flags canApply on an rmt-edit fence', async () => {
    const posts: any[] = []
    const s = new AssistantSession({
      provider: fakeProvider('Here:\n```rmt-edit\nNEW\n```'),
      initial: [{ role: 'system', content: 'S' }, { role: 'user', content: 'ctx' }],
      post: (m) => posts.push(m),
      renderMarkdown: async (md) => `<html>${md}</html>`,
    })
    await s.ask('why?')
    expect(posts.filter((p) => p.type === 'assistantChunk').length).toBeGreaterThan(0)
    const reply = posts.find((p) => p.type === 'assistantReply')
    expect(reply.canApply).toBe(true)
    expect(s.lastEdit()).toBe('NEW')
  })

  it('canApply is false without an edit fence', async () => {
    const posts: any[] = []
    const s = new AssistantSession({
      provider: fakeProvider('Just an explanation.'),
      initial: [{ role: 'system', content: 'S' }, { role: 'user', content: 'c' }],
      post: (m) => posts.push(m),
      renderMarkdown: async (md) => md,
    })
    await s.ask('q')
    expect(posts.find((p) => p.type === 'assistantReply').canApply).toBe(false)
    expect(s.lastEdit()).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it — expect FAIL.** Run: `npx vitest run test/AssistantSession.test.ts`

- [ ] **Step 4: Implement `src/assistant/AssistantSession.ts`:**

```ts
import type { ExtensionMessage } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { extractEdit } from './editFence'

export interface AssistantSessionDeps {
  provider: IAssistantProvider
  initial: AssistantMessage[]
  post: (m: ExtensionMessage) => void
  renderMarkdown: (md: string) => Promise<string>
}

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
      this.deps.post({ type: 'assistantError', message: (err as Error).message || 'Request failed' })
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
```

- [ ] **Step 5: Run test + typecheck — expect PASS.**

Run: `npx vitest run test/AssistantSession.test.ts && npm run typecheck`

- [ ] **Step 6: Commit.**

```bash
git add src/types.ts src/assistant/AssistantSession.ts test/AssistantSession.test.ts
git commit -m "feat(ai-assistant): chat message protocol + ephemeral AssistantSession"
```

---

## Task 7: PreviewController wiring (open/send/apply/save/close)

**Files:**
- Modify: `src/PreviewController.ts` (+ `PreviewDeps`)
- Test: `test/PreviewController.aiAssistant.test.ts`

**Interfaces:**
- Consumes: `AssistantSession`, `buildContext`, `headingPath`, `createAssistantProvider`, `AiAssistantConfig`, the new message variants.
- New `PreviewDeps` fields:
  ```ts
  aiAssistant?: () => AiAssistantConfig
  buildAssistantProvider?: () => IAssistantProvider   // throws with a user-facing message when unconfigured
  aiTokenBudget?: () => number                        // default 24_000
  ```
- Behaviour:
  - `askAiOpen`: if `aiAssistant().enabled` is false → ignore (button shouldn't show anyway). Build the source of the touched blocks via `paragraphRangeText`, the anchored comment bodies via `commentsService.getThreads`, `headingPath` from the first block's start line, then `buildContext(...)`, construct the `AssistantSession`, and post `assistantOpen`. On a provider build error, post `assistantError` (req 17.1/17.2).
  - `askAiSend`: `session.ask(text)`.
  - `askAiApply`: `const edit = session.lastEdit()`; if present, route through the existing edit path by posting `openEditModal` for the block range pre-filled with `edit` (req 7.2 — reuse; dialog stays open, req 7.6).
  - `askAiSaveSummary`: `const body = await session.summarize()`; `commentsService.addComment(firstIndex, body, fragment, endIndex, endFragment)`; `emitComments()`; post `assistantClosed` (req 8.5). On failure post `assistantError` (req 8.6).
  - `askAiClose`: `session.cancel()`, drop the session.

- [ ] **Step 1: Write the failing test** (drive `onWebviewMessage` with a stub `buildAssistantProvider` returning a fake streaming provider; assert posts). Prime render state so `paragraphRangeText` resolves.

```ts
import { describe, it, expect, vi } from 'vitest'
import { PreviewController, type PreviewDeps } from '../src/PreviewController'
import type { IAssistantProvider } from '../src/assistant/types'

function fake(reply: string): IAssistantProvider {
  return { id: 'ollama', displayName: 'x', async *chat() { yield reply }, async testConnection() {} }
}
function deps(over: Partial<PreviewDeps>): PreviewDeps {
  return {
    post: vi.fn(),
    renderer: { render: async (md: string) => ({ html: `<p>${md}</p>`, lineMap: [] }) } as never,
    engine: {} as never,
    cache: { get: () => undefined, set: () => {}, clear: () => {}, size: 0 } as never,
    settings: { getConfig: () => ({ targetLanguage: 'ru', storageLanguage: 'en' }) } as never,
    exportService: {} as never,
    getDocumentText: () => 'Block one source.\n\nBlock two.',
    getDocumentUri: () => ({ toString: () => 'file:///d.md' }) as never,
    aiAssistant: () => ({ enabled: true, provider: 'ollama', model: 'm', endpoint: '', systemPrompt: '', reuseTranslationProvider: true }),
    buildAssistantProvider: () => fake('Hello.'),
    commentsService: { getThreads: () => [], addComment: vi.fn(() => ({ id: 'c1' })), reanchor: () => ({ forBlocks: [], orphaned: [] }) } as never,
    ...over,
  }
}

describe('PreviewController — AI Assistant', () => {
  it('opens a session and posts assistantOpen', async () => {
    const post = vi.fn()
    const c = new PreviewController(deps({ post }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(post.mock.calls.some((c) => c[0].type === 'assistantOpen')).toBe(true)
  })

  it('save summary adds a comment and closes', async () => {
    const addComment = vi.fn(() => ({ id: 'c1' }))
    const post = vi.fn()
    const c = new PreviewController(deps({ post, commentsService: { getThreads: () => [], addComment, reanchor: () => ({ forBlocks: [], orphaned: [] }) } as never }))
    c.primeRenderState('Block one source.\n\nBlock two.', [{ paragraphIndex: 0, startLine: 0, endLine: 0 }], false)
    c.onWebviewMessage({ type: 'askAiOpen', paragraphIndex: 0, selection: 'Block one', translated: false } as never)
    await new Promise((r) => setTimeout(r, 0))
    c.onWebviewMessage({ type: 'askAiSaveSummary' } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(addComment).toHaveBeenCalled()
    expect(post.mock.calls.some((c) => c[0].type === 'assistantClosed')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `npx vitest run test/PreviewController.aiAssistant.test.ts`

- [ ] **Step 3: Implement the handlers in `PreviewController`.** Add the three optional deps fields, a `private assistant: AssistantSession | undefined`, remember the open selection's `{firstIndex, lastIndex, fragment, endIndex, endFragment, selection, translated}`, and the five `case` handlers in `onWebviewMessage`. Assemble context with `paragraphRangeText(first, last)`, `headingPath(this.sourceText, this.paragraphStartLine(first) ?? 0)`, comment bodies from `getThreads(first).flatMap(t => t.comments.map(c => c.body))`, and `aiTokenBudget?.() ?? 24_000`. Build the provider inside a try/catch that posts `assistantError`.

> Full handler code — insert into the `switch` and add helpers:

```ts
case 'askAiOpen': void this.openAssistant(message); break
case 'askAiSend': void this.assistant?.ask(message.text); break
case 'askAiApply': this.applyAssistantEdit(); break
case 'askAiSaveSummary': void this.saveAssistantSummary(); break
case 'askAiClose': this.assistant?.cancel(); this.assistant = undefined; break
```

```ts
private assistant: AssistantSession | undefined
private assistantSel: { first: number; last: number } | undefined

private async openAssistant(m: Extract<WebviewMessage, { type: 'askAiOpen' }>): Promise<void> {
  if (!(this.deps.aiAssistant?.().enabled)) return
  const first = m.paragraphIndex
  const last = m.lastIndex ?? first
  this.assistantSel = { first, last }
  let provider
  try { provider = this.deps.buildAssistantProvider?.() } catch (err) {
    this.deps.post({ type: 'assistantError', message: (err as Error).message }); return
  }
  if (!provider) { this.deps.post({ type: 'assistantError', message: t('AI Assistant not configured') }); return }
  const cfg = this.deps.aiAssistant()
  const source = this.paragraphRangeText(first, last) ?? ''
  const comments = (this.deps.commentsService?.getThreads(first) ?? []).flatMap((tv) => tv.comments.map((c) => c.body))
  const initial = buildContext({
    systemPrompt: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    selection: m.selection, selectionIsTranslated: m.translated,
    sourceOfSelectedBlocks: source, fullDocument: this.sourceText,
    headingPath: headingPath(this.sourceText, this.paragraphStartLine(first) ?? 0),
    comments, tokenBudget: this.deps.aiTokenBudget?.() ?? 24_000,
  })
  this.assistant = new AssistantSession({
    provider, initial,
    post: (msg) => this.deps.post(msg),
    renderMarkdown: async (md) => (await this.deps.renderer.render(md, this.fileDir())).html,
  })
  this.deps.post({ type: 'assistantOpen', selection: m.selection, commentCount: comments.length })
}

private applyAssistantEdit(): void {
  const edit = this.assistant?.lastEdit()
  if (edit === undefined || !this.assistantSel) return
  const { first, last } = this.assistantSel
  // Reuse the existing edit path: open the modal pre-filled; the user saves (req 7.2/7.5).
  this.deps.post({ type: 'openEditModal', paragraphIndex: first, lastIndex: last, storageText: edit, targetText: '' })
}

private async saveAssistantSummary(): Promise<void> {
  if (!this.assistant || !this.assistantSel) return
  try {
    const body = await this.assistant.summarize()
    this.deps.commentsService?.addComment(this.assistantSel.first, body)
    this.emitComments()
    this.assistant = undefined
    this.deps.post({ type: 'assistantClosed' })
  } catch (err) {
    this.deps.post({ type: 'assistantError', message: t('Failed to save summary as comment: {0}', (err as Error).message) })
  }
}
```

Add imports for `AssistantSession`, `buildContext`, `headingPath`, `DEFAULT_SYSTEM_PROMPT`, `AiAssistantConfig`, `IAssistantProvider`.

- [ ] **Step 4: Run test + typecheck — expect PASS.**

Run: `npx vitest run test/PreviewController.aiAssistant.test.ts && npm run typecheck`

- [ ] **Step 5: Commit.**

```bash
git add src/PreviewController.ts test/PreviewController.aiAssistant.test.ts
git commit -m "feat(ai-assistant): PreviewController open/send/apply/save-summary handlers"
```

---

## Task 8: Webview dialog + Ask AI button

**Files:**
- Modify: `src/webview/getPreviewHtml.ts` (add `#sel-ai` button + `#assistant-modal`)
- Modify: `src/webview/previewPanel.ts`
- Test: manual (webview has no unit harness); verify bundle size.

**Interfaces:**
- Consumes: the new message variants (via `import type`).
- Produces: the Ask AI toolbar affordance and the streaming dialog; posts `askAiOpen`/`askAiSend`/`askAiApply`/`askAiSaveSummary`/`askAiClose`.

- [ ] **Step 1: Add the toolbar button** in `getPreviewHtml.ts` after `#sel-comment`:

```html
<button id="sel-ai" title="Ask AI about selection" aria-label="Ask AI" hidden></button>
```

- [ ] **Step 2: Add the dialog markup** (sibling of `#comment-modal`):

```html
<div id="assistant-modal" role="dialog" aria-modal="true" aria-label="Ask AI" hidden>
  <div class="box">
    <div id="assistant-selection"></div>
    <div id="assistant-comments" class="muted"></div>
    <div id="assistant-log" aria-live="polite"></div>
    <div id="assistant-error" role="alert"></div>
    <textarea id="assistant-input" rows="2" placeholder="Ask about the selection…"></textarea>
    <div class="row">
      <button id="assistant-send">Send</button>
      <button id="assistant-apply" hidden>Apply Changes</button>
      <button id="assistant-summary">Save Summary</button>
      <button id="assistant-close">Close</button>
    </div>
  </div>
</div>
```

Add minimal CSS reusing the `#modal` pattern (fixed, z-index 20, scrollable `#assistant-selection` capped ~10 lines per req 4.2, scrollable `#assistant-log`).

- [ ] **Step 3: In `previewPanel.ts`**, grab the elements, and:
  - Show `#sel-ai` in the toolbar only when the host says the feature is on. Add an `aiEnabled` flag set from a new field on the `updateButtonState` message (extend that variant with `aiAssistantEnabled: boolean` in `src/types.ts` and set it in `PreviewController.updateButtonState` from `this.deps.aiAssistant?.().enabled ?? false`). Toggle `selAi.hidden = !aiEnabled` alongside `selComment.hidden`.
  - `selAi` click: read `firstIndex`/`lastIndex` like `selEdit`, capture the selection string and the translated flag (`displaying === 'translation'` or bilingual right column, mirroring `fragmentFromText`), `hideSelToolbar()`, `post({ type: 'askAiOpen', paragraphIndex: first, lastIndex: last, selection, translated })`, and open the dialog.
  - `#assistant-send`: post `askAiSend` with the input value, append a user bubble, clear input.
  - Handle `assistantOpen` (fill selection + "N comments considered", req 5.4), `assistantChunk` (append raw text to the current streaming AI bubble), `assistantReply` (replace the streaming bubble's content with `msg.html`, toggle `#assistant-apply` by `msg.canApply`), `assistantError` (show in `#assistant-error`), `assistantClosed` (close dialog).
  - `#assistant-apply`: post `askAiApply` (the existing `openEditModal` handler then shows the modal — dialog stays open).
  - `#assistant-summary`: post `askAiSaveSummary`.
  - `#assistant-close`: post `askAiClose`, hide dialog, discard the log (req 4.8).

- [ ] **Step 4: Build and check the bundle stays < 50 KB.**

Run: `npm run build`
Expected: `out/webview/previewPanel.js` well under 50 KB (currently ~35 KB; the dialog adds a few KB).

- [ ] **Step 5: Typecheck + full test suite (host untouched logic must stay green).**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Commit.**

```bash
git add src/webview/getPreviewHtml.ts src/webview/previewPanel.ts src/types.ts src/PreviewController.ts
git commit -m "feat(ai-assistant): webview Ask AI button + streaming chat dialog"
```

---

## Task 9: Settings section + key/test commands + activation wiring

**Files:**
- Modify: `package.json` (new `AI Assistant` configuration section, two commands)
- Modify: `src/ActivationController.ts`
- Test: `test/ActivationController` additions if present, else manual command test.

**Interfaces:**
- Consumes: `AssistantSecretManager`, `createAssistantProvider`, `SettingsManager.getAiAssistantConfig`.
- Produces: commands `kiro-md-translator.setAiAssistantKey`, `kiro-md-translator.testAiAssistantConnection`; the assistant deps on every `PreviewController`.

- [ ] **Step 1: Add the configuration section to `package.json`** with `order: 6` (after Comments at 5; shift Appearance to 7 — req 15.6). Properties: `aiAssistant.enabled` (boolean, default false), `aiAssistant.provider` (enum `ollama|openai|anthropic|google|vscode-copilot|kiro-ide` with `enumDescriptions` noting which need no config — req 15.8), `aiAssistant.model` (string), `aiAssistant.endpoint` (string, default `http://localhost:11434`), `aiAssistant.systemPrompt` (string, default `''`), `aiAssistant.reuseTranslationProvider` (boolean, default true). The `endpoint`/`provider` `markdownDescription` carries the command links (req 15.4/15.5) AND the privacy note for hosted providers (design: "the whole document and anchored comments leave the machine on every turn").

- [ ] **Step 2: Add the two commands to `contributes.commands`:** `setAiAssistantKey` ("Markdown Translator: Set AI Assistant API Key"), `testAiAssistantConnection` ("Markdown Translator: Test AI Assistant Connection").

- [ ] **Step 3: Wire `ActivationController`:** construct `this.aiSecrets = new AssistantSecretManager(context.secrets)`; register the two commands (`promptSetAiKey`, `testAiConnection`), mirroring `promptSetApiKey`/`testProviderConnection` but keyless-short-circuiting for `vscode-copilot`/`kiro-ide` (req 16.5). Add to `PreviewDeps` in `resolveCustomTextEditor`:

```ts
aiAssistant: () => this.settings.getAiAssistantConfig(),
buildAssistantProvider: () => {
  const cfg = this.settings.getAiAssistantConfig()
  const key = this.aiKeyCache[cfg.provider] ?? ''   // loaded lazily; see step 4
  return createAssistantProvider(cfg, key, this.settings.getConfig())
},
```

- [ ] **Step 4: Load the assistant key** for the active provider alongside the translation key (extend `refreshApiKey` or add `refreshAiKey`), caching into `this.aiKeyCache: Partial<Record<AssistantProviderType, string>>`, so `buildAssistantProvider` is synchronous. On the settings-change listener and after `promptSetAiKey`, refresh it and `updateButtonState()` (so the toolbar's `aiAssistantEnabled` re-pushes).

- [ ] **Step 5: `promptSetAiKey(provider?)`** — resolve provider (arg or `getAiAssistantConfig().provider`); if keyless IDE provider → info message "no key needed" (req 16.5); else masked `showInputBox` → `aiSecrets.saveKey`/`deleteKey`; refresh cache.

- [ ] **Step 6: `testAiConnection(provider?)`** — build the provider with its stored key and call `testConnection()`; toast success/failure (req 16.7–16.9). Keyless IDE providers before Task 12 report "not yet available".

- [ ] **Step 7: Typecheck + full suite.**

Run: `npm run typecheck && npm test`

- [ ] **Step 8: Commit.**

```bash
git add package.json src/ActivationController.ts package.nls.json
git commit -m "feat(ai-assistant): settings section, key/test commands, activation wiring"
```

---

## Task 10: OpenAI provider

**Files:**
- Create: `src/assistant/OpenAIAssistant.ts`
- Modify: `src/assistant/AssistantProviderFactory.ts` (add the `openai` case)
- Test: `test/OpenAIAssistant.test.ts`

**Interfaces:**
- Produces: `class OpenAIAssistant implements IAssistantProvider` (id `'openai'`). `POST https://api.openai.com/v1/chat/completions`, `stream: true`, `Authorization: Bearer <key>`, parsed via `streamSse((o) => o.choices?.[0]?.delta?.content)` (req 10).

- [ ] **Step 1: Write the failing test** (stub `fetch` → SSE `Response`; assert accumulated text, endpoint, and `Authorization` header; assert a 401 surfaces an auth error via `ensureOk`).

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAIAssistant } from '../src/assistant/OpenAIAssistant'

function sse(chunks: string[], ok = true, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() } })
  return { ok, status, body, text: async () => 'err' } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())

describe('OpenAIAssistant', () => {
  it('streams delta content with a bearer key', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']) as never,
    )
    const p = new OpenAIAssistant('sk-1', 'gpt-4o-mini')
    let out = ''
    for await (const s of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) out += s
    expect(out).toBe('Hi')
    const [, init] = (f.mock.calls[0] as any)
    expect(init.headers.Authorization).toBe('Bearer sk-1')
  })

  it('surfaces a 401 as an error', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(sse([], false, 401) as never)
    const p = new OpenAIAssistant('bad', 'gpt-4o-mini')
    await expect((async () => { for await (const _ of p.chat([{ role: 'user', content: 'q' }], new AbortController().signal)) {} })()).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `npx vitest run test/OpenAIAssistant.test.ts`

- [ ] **Step 3: Implement `src/assistant/OpenAIAssistant.ts`:**

```ts
import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { streamSse } from './stream'

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT = 120000

export class OpenAIAssistant implements IAssistantProvider {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  constructor(private readonly key: string, private readonly model: string) {
    if (!key) throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for OpenAI')
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, stream: true, messages }),
    }, signal, TIMEOUT))
    yield* streamSse(res, (o) => o.choices?.[0]?.delta?.content)
  }
  async testConnection(): Promise<void> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }, undefined, 15000))
    await res.json()
  }
}
```

Add to the factory: `case 'openai': return new OpenAIAssistant(apiKey, config.model || 'gpt-4o-mini')`.

- [ ] **Step 4: Run test + typecheck — expect PASS.** Run: `npx vitest run test/OpenAIAssistant.test.ts && npm run typecheck`

- [ ] **Step 5: Commit.**

```bash
git add src/assistant/OpenAIAssistant.ts src/assistant/AssistantProviderFactory.ts test/OpenAIAssistant.test.ts
git commit -m "feat(ai-assistant): OpenAI streaming provider"
```

---

## Task 11: Anthropic + Google providers

**Files:**
- Create: `src/assistant/AnthropicAssistant.ts`, `src/assistant/GoogleAssistant.ts`
- Modify: `src/assistant/AssistantProviderFactory.ts`
- Test: `test/AnthropicAssistant.test.ts`, `test/GoogleAssistant.test.ts`

**Interfaces:**
- `AnthropicAssistant` (id `'anthropic'`): `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `stream: true`. The system message is hoisted to a top-level `system` field; user/assistant messages go in `messages`. SSE deltas: `pick = (o) => o.type === 'content_block_delta' ? o.delta?.text : undefined` (req 11).
- `GoogleAssistant` (id `'google'`): `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`. Messages mapped to `contents` (`role` user/model; system → `systemInstruction`). SSE deltas: `pick = (o) => o.candidates?.[0]?.content?.parts?.[0]?.text` (req 12).

- [ ] **Step 1: Write the failing Anthropic test** (SSE with `content_block_delta`, assert `x-api-key` header and that the system message became the top-level `system` field of the request body).

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicAssistant } from '../src/assistant/AnthropicAssistant'
function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close() } })
  return { ok: true, status: 200, body, text: async () => '' } as unknown as Response
}
afterEach(() => vi.restoreAllMocks())
describe('AnthropicAssistant', () => {
  it('hoists system, streams content_block_delta text', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      sse(['data: {"type":"content_block_delta","delta":{"text":"Yo"}}\n\n']) as never)
    const p = new AnthropicAssistant('k', 'claude-3-5-sonnet-latest')
    let out = ''
    for await (const s of p.chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }], new AbortController().signal)) out += s
    expect(out).toBe('Yo')
    const [, init] = (f.mock.calls[0] as any)
    expect(init.headers['x-api-key']).toBe('k')
    expect(JSON.parse(init.body).system).toBe('S')
    expect(JSON.parse(init.body).messages.some((m: any) => m.role === 'system')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `npx vitest run test/AnthropicAssistant.test.ts`

- [ ] **Step 3: Implement `AnthropicAssistant.ts`:**

```ts
import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { streamSse } from './stream'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export class AnthropicAssistant implements IAssistantProvider {
  readonly id = 'anthropic' as const
  readonly displayName = 'Anthropic'
  constructor(private readonly key: string, private readonly model: string) {
    if (!key) throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for Anthropic')
  }
  private body(messages: AssistantMessage[], stream: boolean) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const rest = messages.filter((m) => m.role !== 'system')
    return JSON.stringify({ model: this.model, stream, max_tokens: 1024, system, messages: rest })
  }
  private headers() {
    return { 'Content-Type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' }
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, { method: 'POST', headers: this.headers(), body: this.body(messages, true) }, signal, 120000))
    yield* streamSse(res, (o) => (o.type === 'content_block_delta' ? o.delta?.text : undefined))
  }
  async testConnection(): Promise<void> {
    const res = await ensureOk(await fetchWithTimeout(ENDPOINT, { method: 'POST', headers: this.headers(), body: this.body([{ role: 'user', content: 'ping' }], false) }, undefined, 15000))
    await res.json()
  }
}
```

- [ ] **Step 4: Write the failing Google test** (SSE with `candidates[].content.parts[].text`, assert model + key in the URL, system → `systemInstruction`).

- [ ] **Step 5: Implement `GoogleAssistant.ts`:**

```ts
import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider } from './types'
import { ensureOk, fetchWithTimeout } from '../providers/http'
import { streamSse } from './stream'

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GoogleAssistant implements IAssistantProvider {
  readonly id = 'google' as const
  readonly displayName = 'Google Gemini'
  constructor(private readonly key: string, private readonly model: string) {
    if (!key) throw new TranslatorError('INVALID_ENDPOINT_URL', 'API key required for Google')
  }
  private payload(messages: AssistantMessage[]) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    return JSON.stringify(system ? { systemInstruction: { parts: [{ text: system }] }, contents } : { contents })
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const url = `${HOST}/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.key)}`
    const res = await ensureOk(await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: this.payload(messages) }, signal, 120000))
    yield* streamSse(res, (o) => o.candidates?.[0]?.content?.parts?.[0]?.text)
  }
  async testConnection(): Promise<void> {
    const url = `${HOST}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.key)}`
    const res = await ensureOk(await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: this.payload([{ role: 'user', content: 'ping' }]) }, undefined, 15000))
    await res.json()
  }
}
```

Add to the factory: `case 'anthropic': return new AnthropicAssistant(apiKey, config.model || 'claude-3-5-sonnet-latest')` and `case 'google': return new GoogleAssistant(apiKey, config.model || 'gemini-1.5-flash')`.

- [ ] **Step 6: Run both tests + typecheck — expect PASS.**

Run: `npx vitest run test/AnthropicAssistant.test.ts test/GoogleAssistant.test.ts && npm run typecheck`

- [ ] **Step 7: Commit.**

```bash
git add src/assistant/AnthropicAssistant.ts src/assistant/GoogleAssistant.ts src/assistant/AssistantProviderFactory.ts test/AnthropicAssistant.test.ts test/GoogleAssistant.test.ts
git commit -m "feat(ai-assistant): Anthropic + Google Gemini streaming providers"
```

---

## Task 12: IDE provider (parameterized on the vscode.lm spike)

> **Precondition — Stage 0 spike (throwaway, not shipped):** In a scratch branch, add a temporary command that runs `const m = await vscode.lm.selectChatModels({}); console.log(m.map(x => x.vendor + '/' + x.family))` and F5-launch it in **both** Kiro and VS Code. Record whether Kiro surfaces models through `vscode.lm`. **The result decides the branch below.** Do NOT keep the spike command.

**Files:**
- Create: `src/assistant/IdeAssistant.ts`
- Modify: `src/assistant/AssistantProviderFactory.ts`, `package.json` (`engines.vscode` → `^1.90.0`)
- Test: `test/IdeAssistant.test.ts` (against a mock `vscode.lm` added to `test/mocks/vscode.ts`)

**Interfaces:**
- Produces: `class IdeAssistant implements IAssistantProvider` wrapping `vscode.lm.selectChatModels` + `model.sendRequest`, streaming `response.text`. Constructed with the desired `vendor`/`family` (from settings model or first available).

- [ ] **Step 1: Raise `engines.vscode` to `^1.90.0`** in `package.json` (req 13.2 needs `vscode.lm`). Note in the changelog that HTTP-only providers still worked on `^1.85`.

- [ ] **Step 2: Add a minimal `lm` mock** to `test/mocks/vscode.ts`: `selectChatModels(sel)` returns a scripted model whose `sendRequest` yields an async `text` iterable; export a `__setLmModels(...)` seam.

- [ ] **Step 3: Write the failing test** — select a model, stream text, and assert that an empty model list throws the "not found" error (req 13.3/17.3).

- [ ] **Step 4: Implement `IdeAssistant.ts`:**

```ts
import * as vscode from 'vscode'
import { TranslatorError } from '../types'
import type { AssistantMessage, IAssistantProvider, AssistantProviderType } from './types'

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
      throw new TranslatorError('INVALID_ENDPOINT_URL',
        this.id === 'kiro-ide'
          ? 'Kiro IDE Provider is only available in Kiro IDE'
          : 'GitHub Copilot not found. Please install and authenticate the GitHub Copilot extension')
    }
    return models[0]
  }
  async *chat(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<string> {
    const model = await this.pick()
    const lm = messages.map((m) =>
      m.role === 'assistant'
        ? vscode.LanguageModelChatMessage.Assistant(m.content)
        : vscode.LanguageModelChatMessage.User(m.content))
    const cts = new vscode.CancellationTokenSource()
    signal.addEventListener('abort', () => cts.cancel())
    const res = await model.sendRequest(lm, {}, cts.token)
    for await (const part of res.text) yield part
  }
  async testConnection(): Promise<void> { await this.pick() }
}
```

- [ ] **Step 5: Update the factory** per the spike:
  - **Spike said Kiro uses `vscode.lm`:** `case 'vscode-copilot': case 'kiro-ide': return new IdeAssistant(config.provider, config.model || undefined)`.
  - **Spike said no:** keep `vscode-copilot` on `IdeAssistant`; make `kiro-ide` a thin adapter over the native API the spike found, or a stub that throws req 17.4's message. Document the choice in the design doc's "IDE-model provider" section.

- [ ] **Step 6: Run test + typecheck — expect PASS.** Run: `npx vitest run test/IdeAssistant.test.ts && npm run typecheck`

- [ ] **Step 7: Commit.**

```bash
git add src/assistant/IdeAssistant.ts src/assistant/AssistantProviderFactory.ts package.json test/IdeAssistant.test.ts test/mocks/vscode.ts
git commit -m "feat(ai-assistant): IDE language-model provider (vscode.lm)"
```

---

## Task 13: Error-handling polish + l10n pass

**Files:**
- Modify: `src/PreviewController.ts`, `src/ActivationController.ts`, `src/webview/previewPanel.ts`, `l10n/*` bundles
- Test: `test/PreviewController.aiAssistant.test.ts` (error cases)

**Interfaces:** No new interfaces — wire the exact req 17 message strings through `t()`.

- [ ] **Step 1: Write failing error tests** — assert the exact user-facing strings for: unconfigured provider (17.1), missing key (17.2), network failure `Connection failed: <reason>` (17.5), apply failure (17.7), summary-save failure (17.8). Drive by making `buildAssistantProvider`/`addComment`/`summarize` throw.

- [ ] **Step 2: Run — expect FAIL.** Run: `npx vitest run test/PreviewController.aiAssistant.test.ts`

- [ ] **Step 3: Route every assistant error through `t()`** with the req-17 wording; ensure `console.error(...)` logs detail (req 17.9). Confirm the webview shows `assistantError` text in `#assistant-error` and keeps the dialog open (reqs 6.3/7 stay-open, 8.6).

- [ ] **Step 4: Add the new source strings to `l10n/bundle.l10n.json`** and the Russian bundle, matching the existing `t()` catalog convention (req 8 / project l10n rule).

- [ ] **Step 5: Run full suite + typecheck + build.**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green; webview bundle < 50 KB.

- [ ] **Step 6: Commit.**

```bash
git add src/PreviewController.ts src/ActivationController.ts src/webview/previewPanel.ts l10n
git commit -m "feat(ai-assistant): req-17 error messages + l10n strings"
```

---

## Self-Review

**Spec coverage (Requirements 1–17):**
- R1 config section → Task 1 (reader) + Task 9 (package.json). R1.9 (respect commentStorage for generated comments) → Task 7 uses `commentsService.addComment`, which already honours the active backend.
- R2 reuse + key namespace → Task 2 + Task 4 (`reuseTranslationProvider`) + Task 9 (key load).
- R3 selection + Ask AI button + disabled gating → Task 8 (button, `aiAssistantEnabled` gate).
- R4 dialog interface (selection block scroll, history, input, Save/Apply buttons, close, discard) → Task 8.
- R5 context (selection, full doc, comments, comments-not-shown, once-assembled, budget) → Task 5 + Task 7. R5.6 re-shaped to "assemble once, send every turn" per design.
- R6 LLM comms (send+context, append reply, error, system prompt every request, multi-turn, Ollama, key) → Tasks 4/6/7.
- R7 apply edit (storage-language, existing infra, triggers translate, no separate diff, stay open, detect via fence) → Task 5 (fence) + Task 7 (`applyAssistantEdit` → `openEditModal`). R7.7 re-shaped to the `rmt-edit` fence per design.
- R8 summary→comment (summarize, addComment, anchor, storage, close, error) → Task 7 (`saveAssistantSummary`).
- R9 Ollama → Task 4. R10 OpenAI → Task 10. R11 Anthropic + R12 Google → Task 11. R13 Copilot + R14 Kiro → Task 12.
- R15 settings UI (section, keys, enum descriptions, command links, order after Comments, defaults, no-config markers) → Task 9.
- R16 key/test commands → Task 9.
- R17 error handling → Task 13 (with earlier tasks posting `assistantError`).

**Open item to fold in during Task 8:** the `updateButtonState` message must carry `aiAssistantEnabled` — added in Task 8 Step 3 and set in `PreviewController.updateButtonState`. Cross-check the variant edit lands in `src/types.ts`.

**Type consistency:** `AssistantProviderType`, `AssistantMessage`, `AiAssistantConfig`, `IAssistantProvider.chat(messages, signal)`, `createAssistantProvider(config, apiKey, translation)`, `AssistantSession.{ask,summarize,lastEdit,cancel}`, `extractEdit`, `buildContext`/`headingPath`, and the `askAi*`/`assistant*` message variants are used identically across Tasks 1–13. Secret methods are `saveKey/getKey/deleteKey` throughout.

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — each provider repeats its full adapter; Task 12's two branches are both specified.
