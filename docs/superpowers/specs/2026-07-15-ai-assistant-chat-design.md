# AI Assistant Chat — design

> Spec id chain: `.kiro/specs/ai-assistant-chat/requirements.md` Requirements 1–17
> (gitignored spec). This design refines that spec: three criteria are deliberately
> re-shaped where a literal reading would corrupt the user's file or is technically
> impossible, and several gaps the spec does not mention are filled in. Each such
> departure is called out under "Where this design departs from the spec".
>
> Depends on the translated-fragment orphan fix (`fix/comment-fragment-orphan`): the
> assistant anchors context and the summary comment through the same block-level
> machinery, which that fix makes correct while a translation is shown.

## What changes for the user

Select any text in the preview — a phrase, or a span across several blocks — and the
selection toolbar now offers a third action beside Edit and Comment: **Ask AI**. It
opens a chat dialog over the preview, pinned to what you selected.

1. **You discuss the fragment.** The dialog shows your selected text at the top and a
   back-and-forth conversation below. You ask questions ("why does this contradict
   3.14?", "what does this requirement actually mean?"), the assistant answers, you
   keep going. The assistant already knows the whole document and any comments that
   touch your selection — you do not paste them in.

2. **You save the outcome as a comment.** One button asks the assistant to summarize
   the discussion and stores that summary as a normal comment anchored to the
   fragment — in whatever comment storage you already use (separate file, inline, or
   draft). The chat itself is thrown away; only the summary you chose to keep survives.

3. **You apply a suggested edit.** When the assistant proposes a concrete rewrite of
   the selected text, an **Apply Changes** button appears. Clicking it opens the same
   paragraph-edit modal you already know, pre-filled with the suggestion, so you see
   exactly what will replace your text before you save it. Saving goes through the
   existing surgical write — the rest of the document is never touched.

4. **You choose the model.** AI Assistant settings are separate from translation
   settings: you can translate with DeepL and discuss with a local Ollama model, or
   any mix. Providers include local Ollama, the big hosted APIs (OpenAI, Anthropic,
   Google), and — where the IDE exposes them — the editor's own built-in models with
   no key to configure.

The feature is off until you enable it; when disabled, the Ask AI button does not
appear and nothing about the preview changes.

## The provider layer (load-bearing decision #1)

The existing translation providers are the wrong abstraction for chat. Two of them
(DeepL, Google Translate) are not language models at all — they have no chat endpoint
and cannot "explain" anything. So the assistant gets its **own** provider seam: a
single small interface whose one job is "take a conversation, stream back a reply".
It shares nothing with the translation provider interface beyond both being network
clients.

Keys live in the existing keychain-backed secret store, but under a separate
namespace (`…apiKey.aiAssistant.<provider>`) so an assistant key can never be
confused with a translation key for the same-named provider. A `reuseTranslation
Provider` flag (default on) means a user already translating with Ollama gets the
assistant pointed at that same Ollama endpoint and model for free; turn it off, or
translate with something that isn't Ollama, and the assistant uses its own provider
configuration.

Settings form a new configuration section placed after Comments: an enabled flag,
provider type, model name, endpoint (for Ollama), a customizable system prompt, and
the reuse flag. Two commands — set key, test connection — mirror the translation
provider commands, and the key command short-circuits with an informational message
for providers that need no key.

**Streaming is one contract for every provider.** The provider yields reply text
incrementally; the host accumulates it and forwards each increment to the dialog as
raw text, then renders the finished reply to sanitized HTML once the turn completes
(see the rendering decision below). Ollama and the hosted APIs stream over HTTP; the
IDE provider streams through the editor's language-model API. The existing HTTP helper
cannot be reused as-is — it buffers the whole response and cuts on one hard timeout —
so chat gets its own streaming read path with per-turn cancellation.

## Chat orchestration and context (load-bearing decision #2)

The conversation lives in host memory for as long as the dialog is open and is
discarded when it closes. Nothing about the chat is persisted; the only things that
outlive the dialog are what the user explicitly saves (a summary comment, or an
applied edit). This keeps the storage model untouched — no new on-disk format, no
re-anchoring of chat history.

**Context is assembled once, but sent every turn.** The spec's wording ("send the
context payload only once") cannot be taken literally — every chat API in scope is
stateless, so each turn necessarily resends the full message array. What is true, and
what the design guarantees, is that the *expensive assembly* (reading the document,
collecting comments, building the heading path) happens once at dialog open; each
subsequent turn reuses that assembled context and appends the running conversation.
The system prompt is included on every request.

The context payload carries: the selected fragment, the full document source, the
heading path above the selection (e.g. "## 3 › ### 3.4"), and the comments that
anchor to the selection. Comments go to the model but are **not** shown in the dialog
UI; the dialog shows a quiet "N comments considered" line so the feature is not opaque
about what it fed the model.

**The selection-over-translation subtlety.** When the user selects while reading the
translation, the selected characters are target-language text, and there is no
under-block map from a rendered sub-phrase back to exact source characters — the line
map is block-level only. So the context sends the **source of the whole blocks the
selection touches** (via the line map) and marks which rendered sub-phrase (in the
target language) the user highlighted. The model sees both the authoritative source
and what the user pointed at. This is also why an applied edit is block-ranged, not
sub-phrase (next decision).

## Apply Changes through the edit modal (load-bearing decision #3)

This is the riskiest part of the feature, because a wrong move here overwrites the
user's file. Two decisions contain the risk.

**A structured edit channel, not heuristic scraping.** The spec proposes detecting
edits by scanning the reply for markdown code blocks. That is a false-positive machine:
these documents are *specifications*, so a model explaining one quotes fenced code
constantly, and every such quote would light up an Apply button. Instead, the model is
instructed (in the system prompt) to emit a proposed edit only inside a fence with a
dedicated info-string, carrying the **full replacement text of the selected range** in
the **storage language**. A code quote inside an explanation is an ordinary fence and
never reads as an edit. Apply Changes appears only when that dedicated fence is present.

**The edit modal is the preview.** The spec says apply with no diff preview. Taken
with the block-level write reality, that would mean one unlabelled button silently
rewrites a whole block after the user selected three words. So Apply Changes does not
write the file — it opens the existing paragraph-edit modal, pre-filled with the
suggested replacement, over the block range the selection touched. The user sees
exactly what will be written and saves it through the write path that already exists.
No new write path is introduced, and the block-level splice invariant (only the
selected source range is rewritten, never a whole-document re-serialize) is inherited
intact. Applying leaves the dialog open, and the edit flows back into the translation
pipeline exactly as a manual paragraph edit does.

The storage-language guarantee matters here: the user discusses in their own language,
so a naive model asked to "rewrite this paragraph" would answer in that language and
push non-source text into the source file. The dedicated edit fence is specified as
storage-language, pinned by the system prompt; the modal, showing the source text,
is the human check that catches a violation before it is saved.

## Saving the discussion as a comment (Requirement 8)

Save Summary sends the full conversation to the model with a summarization prompt,
takes the returned synopsis, and stores it as a new comment through the existing
comments service — anchored to the selection fragment, in the user's current comment
storage. The fragment anchor is captured as a content anchor (not a raw block index)
at dialog open and re-resolved at save time, so a re-render during a long conversation
cannot land the summary on the wrong block. On success the dialog closes; on failure
it stays open with an error.

## The IDE-model provider (resolved: VS Code Copilot only)

> **Post-implementation update (2026-07-16):** the spike below was run for real, in both
> IDEs. Kiro implements the `vscode.lm` API surface but registers **zero** models into it
> (`selectChatModels({})` → 0 for every vendor, incl. `copilot`), so an extension running
> inside Kiro cannot reach Kiro's agent through `vscode.lm`. Kiro's only documented
> programmatic model access is the Kiro CLI's ACP protocol (`kiro-cli acp`, JSON-RPC over
> stdio) — a separate, out-of-process integration requiring a separate `kiro-cli` install,
> judged not worthwhile. **`kiro-ide` was therefore dropped.** The IDE provider ships as
> `vscode-copilot` only, verified working in real VS Code (277 models available;
> constrained to the `copilot` vendor; default family `claude-sonnet-4.5` with a fallback
> to any Copilot model). Requirements 14 and 17.4 are intentionally not implemented — no
> public in-process API exists to satisfy them.

Requirement 13 (VS Code Copilot) asks for "the editor's own model with no
configuration". The provider calls `vscode.lm.selectChatModels({ vendor: 'copilot' })`
and streams `model.sendRequest`. `vscode.lm` requires raising the manifest engine floor
from `^1.85` to `^1.90`; that bump ships with this stage, so the HTTP-only providers
remain installable on the current floor until then. Note that `vscode.lm` gates model
access on a user-initiated action, so the first Copilot turn triggered from the webview
can return empty until consent is granted (run the Test Connection command / reload the
window once); the empty result is surfaced as an actionable message, not a false
"Copilot not found".

## Context budget and degradation (Requirement 5.2)

Sending the whole document on every turn is fine for a normal spec and ruinous for a
large one — a hundred-kilobyte spec would go over the wire on every question, blowing
a local model's context window and costing a full-file translation's worth of tokens
per question on a paid API. So the whole document is sent only while it fits a
configurable token budget. Past that, the context degrades to: the selection, its
blocks, the heading path, the neighbouring blocks (±2), and the anchored comments —
and the dialog says plainly that the context was trimmed, so an answer that misses a
cross-reference is understood, not mysterious. This mirrors the extension's existing
large-file awareness (it already warns past 1 MB).

## Where this design departs from the spec

- **Req 5.6 / 6.5 ("send context once")** — impossible against stateless chat APIs;
  re-read as "assemble once, send every turn". No behavioural loss; sets correct
  implementer expectations.
- **Req 7.5 ("no diff preview") and 7.7 ("detect edits by scanning for code blocks")**
  — replaced by the edit modal as preview and a dedicated edit fence, because the
  literal design silently overwrites a block and misfires on quoted code. Req 7.2/7.3
  (edit the storage-language source via the existing edit infrastructure) are met
  exactly.
- **Req 13** — implemented as `vscode-copilot` via `vscode.lm` (vendor `copilot`,
  default family `claude-sonnet-4.5`). **Req 14 (`kiro-ide`) dropped:** the spike proved
  Kiro registers no `vscode.lm` models and exposes no in-process model API to extensions
  (only the out-of-process Kiro CLI ACP), so the provider is not implementable as
  specified; in Kiro, use Ollama or a hosted provider. Req 17.4's Kiro-only message is
  consequently unused.

## What this design adds that the spec omits

- **Privacy** — with a hosted provider (OpenAI/Anthropic/Google), the whole document
  and the anchored private comments leave the machine on every turn. The provider
  setting's description states this plainly, consistent with the project's stance of
  never putting keys in `settings.json`.
- **Cancellation** — closing the dialog (or asking a new question) aborts an in-flight
  request; a local model can take minutes, and an orphaned request must not keep
  streaming into a closed dialog.
- **Index drift over a long dialog** — the selection is held as a content anchor and
  re-resolved at Apply/Save time, so a re-render mid-conversation never targets the
  wrong block.

## What this does NOT touch

- Translation: providers, cache, the storage-language invariant, and every existing
  translation path are unchanged. The assistant is a parallel seam.
- The comment storages (sidecar / inline / draft) and their anchoring — the summary
  is stored through the existing service; no new storage or format.
- Block indexing and the line map — context and edits ride the existing block-level
  correspondence; nothing re-indexes.
- The webview bundle stays a dumb renderer with no markdown parser and no Node APIs;
  all model reply rendering happens on the host.

## Stages (one logical change per commit / MR)

0. **Spike:** `vscode.lm.selectChatModels({})` in Kiro and in VS Code — decides the
   shape of stage 8. Throwaway; not shipped.
1. **Provider seam + settings + key commands** — the interface, the new configuration
   section, keychain namespace, set-key / test-connection commands (req 1, 2, 15, 16).
2. **Ollama provider + a minimal end-to-end chat** — prove one turn round-trips
   (req 9), with the streaming read path and cancellation.
3. **Chat dialog + orchestration + context assembly** — the modal, the message
   protocol variants, the one-time context build with budget/degradation, the
   "N comments considered" line (req 3, 4, 5, 6).
4. **Reply rendering** — host renders each finished turn's markdown to sanitized HTML;
   streaming shows raw text in between.
5. **Apply Changes** — the dedicated edit fence, the Apply button gate, and routing
   the suggestion into the existing edit modal (req 7).
6. **Save Summary** — summarization request and storing the synopsis as an anchored
   comment (req 8).
7. **Hosted providers** — OpenAI, Anthropic, Google, each behind the same seam
   (req 10, 11, 12).
8. **IDE provider(s)** — per the stage-0 spike; raises the engine floor to `^1.90`
   (req 13, 14).
9. **Error-handling polish** — the full set of user-facing error messages and console
   logging (req 17).
