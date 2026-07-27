import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, openPreview, type PageIssue, type Preview } from './harness'

/*
 * Feature: AI Assistant chat dialog (req 3/4/6/7/8/17), Scenarios E20 + E21.
 *
 * Everything here is an ORDERING contract between host messages, and ordering is
 * exactly what a unit test of the bundle cannot reach: the dialog's whole state
 * lives in DOM nodes and one module-level `aiStreamBubble` reference that four
 * different message handlers hand back and forth. The failure modes are a bubble
 * per chunk instead of one growing bubble, a late chunk overwriting the rendered
 * reply, a "Save Summary" that is live before any reply exists — and a Send
 * button that looks alive while there is no session behind it.
 *
 * The Send button state machine is the reason this file exists in its current
 * shape. `2cf7cfe` made Send dead on open, alive only on `assistantOpen`, and
 * dead again on close — deliberately NOT re-disabled by `assistantError`, since
 * an error raised mid-conversation leaves a working session and retry has to
 * stay possible. There is no other test of that anywhere, so each of those four
 * edges is asserted here both as the `disabled` property and as behaviour (a
 * real click that does or does not post).
 */

const DOC = [
  '# Streaming assistant',
  '',
  'Alpha paragraph introduces the document and says very little of substance.',
  '',
  'Beta paragraph is the first half of the fragment the user wants explained.',
  '',
  'Gamma paragraph is the second half of that very same selected fragment.',
  '',
  'Delta paragraph is never part of any selection made in this scenario.',
  '',
].join('\n')

/** Block indices in `DOC`: 0 = the h1, 1..4 = the paragraphs. The selection spans 2..3. */
const FIRST_BLOCK = 2
const LAST_BLOCK = 3

/*
 * Six lines per chunk on purpose: `#assistant-log` is capped at 40vh, so while the
 * whole conversation fits without a scrollbar the auto-scroll oracle would hold
 * trivially (scrollTop 0 IS the bottom). Overflowing the cap is what makes
 * "the log follows the stream" a real assertion.
 */
const CHUNKS = ['first', 'second', 'third', 'fourth', 'fifth'].map(
  (name) => `${name} chunk:\n${`${name} streamed line\n`.repeat(6)}`,
)
const STREAMED = CHUNKS.join('')
const LATE_CHUNK = 'a chunk that arrived after the reply'

/*
 * The reply the host renders is host-sanitized markdown, injected with
 * createContextualFragment. The `<script>` rides along to prove the injection point
 * is inert: the production CSP (`script-src 'nonce-…'`) is real on this page, so an
 * un-nonced inline script must never run.
 */
const REPLY_HTML = '<p>done <code>x</code></p><script>window.__e2eAssistantXss = 1</script>'
const REPLY_TEXT = 'done x'

/** Page complaints the scenario did not deliberately cause. The reply fixture carries a
 *  `<script>`, and the production CSP refusing to execute it is the desired outcome —
 *  Chromium logs that refusal, so exactly that one message is tolerated. The predicate is
 *  narrowed to the inline-script refusal on purpose: a CSP message about a blocked
 *  stylesheet or image is NOT expected, and would quietly reshape the layout measured
 *  around it. */
function unexpectedIssues(issues: PageIssue[]): PageIssue[] {
  return issues.filter(
    (issue) => !(/Content Security Policy/i.test(issue.text) && /inline script/i.test(issue.text)),
  )
}

/** Arrange the dialog the way a user opens it: real document, AI enabled in settings, then
 *  the selection + toolbar click below. */
async function askAiAboutTwoBlocks(preview: Preview): Promise<string> {
  await preview.configure({ aiAssistantEnabled: true })
  await preview.render(DOC)
  return reopenAskAi(preview)
}

/** Just the user's part of the gesture — a real drag across two blocks and a real click on
 *  the toolbar's Ask AI button. Returns the selected text, the same string the `askAiOpen`
 *  payload has to carry. Kept apart from the render because `showContent` posts
 *  `requestComments`, which would pollute a re-open's posted-message oracle. */
async function reopenAskAi(preview: Preview): Promise<string> {
  const selection = await preview.dragSelect(
    `[data-paragraph-index="${FIRST_BLOCK}"]`,
    `[data-paragraph-index="${LAST_BLOCK}"]`,
  )
  expect(selection).not.toBe('')
  expect(await preview.hidden('#sel-toolbar')).toBe(false)
  expect(await preview.hidden('#sel-ai')).toBe(false)
  await preview.click('#sel-ai')
  expect(await preview.hidden('#assistant-modal')).toBe(false)
  return selection
}

/** The host's answer to `askAiOpen`: a live session exists. */
async function confirmSession(preview: Preview, selection: string, commentCount = 0): Promise<void> {
  await preview.send({ type: 'assistantOpen', selection, commentCount })
}

/** Ask a question through the real button, the way the user does. Select-all before typing
 *  so the helper replaces the field rather than appending: a Send that did nothing leaves
 *  the question sitting in the box, which is the correct behaviour and would otherwise
 *  concatenate into the next question. */
async function ask(preview: Preview, text: string): Promise<void> {
  await preview.click('#assistant-input')
  await preview.press('a', { ctrl: true })
  await preview.typeText(text)
  await preview.click('#assistant-send')
}

/** The live text of the question field. */
async function inputValue(preview: Preview): Promise<string> {
  return preview.page.evaluate(() => (document.getElementById('assistant-input') as HTMLTextAreaElement).value)
}

/** The chat log's own scroll state — no harness helper covers element scrolling. */
async function logScroll(preview: Preview): Promise<{ scrollTop: number; clientHeight: number; scrollHeight: number }> {
  return preview.page.evaluate(() => {
    const el = document.getElementById('assistant-log') as HTMLElement
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }
  })
}

/** Tag the bubble currently receiving the stream. The reply is supposed to REPLACE that
 *  same node's content; a mark that survives is the only way to tell "replaced in place"
 *  from "removed and re-appended", which a bubble count cannot distinguish. */
async function markStreamBubble(preview: Preview): Promise<void> {
  await preview.page.evaluate(() => {
    const bubbles = document.querySelectorAll('#assistant-log .ai-msg-ai')
    const last = bubbles[bubbles.length - 1] as HTMLElement | undefined
    if (!last) throw new Error('no ai bubble to mark')
    last.dataset.e2eMark = 'stream'
  })
}

const MARKED = '#assistant-log .ai-msg-ai[data-e2e-mark="stream"]'

describe('E20 Ask AI streaming dialog', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('accumulates chunks into one bubble, replaces it with the reply, and isolates a late chunk', async () => {
    preview = await openPreview()
    await preview.clearPosted()
    const selection = await askAiAboutTwoBlocks(preview)

    // The open payload carries the block RANGE, not just the first block.
    const opened = await preview.waitForPost('askAiOpen')
    expect(opened).toEqual({
      type: 'askAiOpen',
      paragraphIndex: FIRST_BLOCK,
      lastIndex: LAST_BLOCK,
      selection,
      translated: false,
    })

    // Optimistic open: the dialog is on screen but no session exists yet.
    expect(await preview.text('#assistant-log')).toBe('')
    expect(await preview.count('#assistant-log .ai-msg')).toBe(0)
    expect(await disabled(preview, '#assistant-summary')).toBe(true)
    expect(await preview.hidden('#assistant-apply')).toBe(true)
    expect(await disabled(preview, '#assistant-send')).toBe(true)

    // …and dead, not merely grey: a real click on it must reach nothing. The typed
    // question stays in the box — a Send that does nothing must not eat it either.
    await preview.clearPosted()
    await ask(preview, 'too early')
    expect(await preview.posted()).toEqual([])
    expect(await preview.count('#assistant-log .ai-msg')).toBe(0)
    expect(await inputValue(preview)).toBe('too early')

    // The host confirms the session.
    await confirmSession(preview, selection, 2)
    expect(await preview.text('#assistant-selection')).toBe(selection)
    expect(await preview.text('#assistant-comments')).toBe('2 comments considered')
    expect(await disabled(preview, '#assistant-send')).toBe(false)
    expect(await preview.count('#assistant-log .ai-msg')).toBe(0)

    // Send: one question posted, exactly two bubbles — the user's, then the empty
    // shell the stream will fill.
    await preview.clearPosted()
    await ask(preview, 'explain this')
    expect(await preview.posted()).toEqual([{ type: 'askAiSend', text: 'explain this' }])
    expect(await bubbles(preview)).toEqual([
      { role: 'user', text: 'explain this' },
      { role: 'ai', text: '' },
    ])
    expect(await inputValue(preview)).toBe('')

    await markStreamBubble(preview)

    // Five chunks land in ONE bubble, in order, and the log follows them down.
    for (const chunk of CHUNKS) await preview.send({ type: 'assistantChunk', text: chunk })
    expect(await bubbles(preview)).toEqual([
      { role: 'user', text: 'explain this' },
      { role: 'ai', text: STREAMED },
    ])
    const scrolled = await logScroll(preview)
    expect(scrolled.scrollHeight).toBeGreaterThan(scrolled.clientHeight) // the oracle below is vacuous otherwise
    expect(scrolled.scrollTop + scrolled.clientHeight).toBeGreaterThanOrEqual(scrolled.scrollHeight - 1)

    // The reply replaces THAT SAME bubble with rendered HTML; the script in it stays inert.
    await preview.send({ type: 'assistantReply', html: REPLY_HTML, canApply: true })
    expect(await preview.count('#assistant-log .ai-msg')).toBe(2)
    expect(await preview.count(MARKED)).toBe(1)
    expect(await preview.text(`${MARKED} p`)).toBe(REPLY_TEXT)
    expect(await preview.count(`${MARKED} code`)).toBe(1)
    expect(await preview.text(`${MARKED} code`)).toBe('x')
    const ranXss = await preview.page.evaluate(
      () => (window as unknown as { __e2eAssistantXss?: number }).__e2eAssistantXss,
    )
    expect(ranXss).toBeUndefined()

    // A reply exists → the two post-reply affordances open up.
    expect(await disabled(preview, '#assistant-summary')).toBe(false)
    expect(await preview.hidden('#assistant-apply')).toBe(false)
    expect(await disabled(preview, '#assistant-send')).toBe(false)

    // A chunk that arrives after the reply belongs to nothing: it must start its own
    // bubble rather than append plain text onto the rendered answer.
    await preview.send({ type: 'assistantChunk', text: LATE_CHUNK })
    expect(await bubbles(preview)).toEqual([
      { role: 'user', text: 'explain this' },
      { role: 'ai', text: REPLY_TEXT },
      { role: 'ai', text: LATE_CHUNK },
    ])
    expect(await preview.count(`${MARKED} code`)).toBe(1)

    // Apply and Save Summary report the intent and leave the dialog standing. Closing on
    // a saved summary (req 8.5) is the HOST's move, delivered as `assistantClosed` — the
    // webview closing itself here would discard the log before the comment was written.
    await preview.clearPosted()
    await preview.click('#assistant-apply')
    expect(await preview.posted()).toEqual([{ type: 'askAiApply' }])
    expect(await preview.hidden('#assistant-modal')).toBe(false)

    await preview.clearPosted()
    await preview.click('#assistant-summary')
    expect(await preview.posted()).toEqual([{ type: 'askAiSaveSummary' }])
    expect(await preview.hidden('#assistant-modal')).toBe(false)

    expect(unexpectedIssues(preview.errors())).toEqual([])
  })

  it('counts the considered comments in words, and says nothing when there are none', async () => {
    preview = await openPreview()
    const selection = await askAiAboutTwoBlocks(preview)

    await confirmSession(preview, selection, 0)
    expect(await preview.text('#assistant-comments')).toBe('')

    await confirmSession(preview, selection, 1)
    expect(await preview.text('#assistant-comments')).toBe('1 comment considered')

    await confirmSession(preview, selection, 2)
    expect(await preview.text('#assistant-comments')).toBe('2 comments considered')

    expect(unexpectedIssues(preview.errors())).toEqual([])
  })

  /*
   * The same optimistic-open hole the Send button was fixed for, one surface over. Every
   * failing open (assistant disabled, provider build throws, no provider configured) has
   * PreviewController.openAssistant return after posting only `assistantError`, so
   * `assistantOpen` — the ONLY writer of the two header nodes — never arrives. Before the
   * fix the dialog then sat there showing a DIFFERENT fragment's text and a stale comment
   * count right next to "AI Assistant not configured", reading as though the assistant had
   * considered comments on a selection the user never made. req 4.1 ("THE Chat_Dialog SHALL
   * display the Selection_Fragment") is the oracle: the header describes THIS session or
   * nothing at all.
   */
  it('clears the selection header on open so a failed open cannot show the previous fragment', async () => {
    preview = await openPreview()
    const first = await askAiAboutTwoBlocks(preview)
    await confirmSession(preview, first, 3)
    expect(await preview.text('#assistant-selection')).toBe(first)
    expect(await preview.text('#assistant-comments')).toBe('3 comments considered')

    await preview.click('#assistant-close')
    expect(await preview.hidden('#assistant-modal')).toBe(true)

    // A DIFFERENT fragment, and an open the host answers with an error and nothing else.
    const second = await preview.dragSelect('[data-paragraph-index="1"]')
    expect(second).not.toBe(first)
    expect(second.trim().length).toBeGreaterThan(0)
    await preview.click('#sel-ai')
    expect(await preview.hidden('#assistant-modal')).toBe(false)
    await preview.send({ type: 'assistantError', message: 'AI Assistant not configured' })

    expect(await preview.text('#assistant-selection')).toBe('')
    expect(await preview.text('#assistant-comments')).toBe('')
    // The error is the only thing the dialog claims, and there is still no session.
    expect(await preview.text('#assistant-error')).toBe('AI Assistant not configured')
    expect(await disabled(preview, '#assistant-send')).toBe(true)

    // Positive control: a confirmed session fills the header with THIS selection, so the
    // clearing above is the open path and not a header that stopped working.
    await confirmSession(preview, second, 1)
    expect(await preview.text('#assistant-selection')).toBe(second)
    expect(await preview.text('#assistant-comments')).toBe('1 comment considered')

    expect(unexpectedIssues(preview.errors())).toEqual([])
  })
})

describe('E21 Ask AI error surface and close paths', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('shows an error only when there is one, and keeps the session usable afterwards', async () => {
    preview = await openPreview()
    const selection = await askAiAboutTwoBlocks(preview)
    await confirmSession(preview, selection)
    await ask(preview, 'explain this')
    await preview.send({ type: 'assistantReply', html: REPLY_HTML, canApply: false })

    // `#assistant-error:empty { display: none }` — an empty node is a node that takes no
    // space; only computed style can tell, and a single stray character would defeat it.
    expect(await preview.text('#assistant-error')).toBe('')
    expect(await preview.css('#assistant-error', 'display')).toBe('none')

    await preview.send({ type: 'assistantError', message: 'model unavailable' })
    expect(await preview.text('#assistant-error')).toBe('model unavailable')
    expect(await preview.css('#assistant-error', 'display')).not.toBe('none')

    // The gate is `assistantOpen`, NOT `assistantError`: a failure mid-conversation leaves
    // the session alive, so retry has to stay one click away.
    expect(await disabled(preview, '#assistant-send')).toBe(false)

    await preview.clearPosted()
    await ask(preview, 'try again')
    expect(await preview.posted()).toEqual([{ type: 'askAiSend', text: 'try again' }])
    // The retry supersedes the failure, so the error clears with it.
    expect(await preview.text('#assistant-error')).toBe('')
    expect(await preview.css('#assistant-error', 'display')).toBe('none')

    expect(unexpectedIssues(preview.errors())).toEqual([])
  })

  it('tells the host when the user closes, and stays silent when the host closes', async () => {
    preview = await openPreview()
    const selection = await askAiAboutTwoBlocks(preview)
    await confirmSession(preview, selection)
    await ask(preview, 'explain this')
    await preview.send({ type: 'assistantChunk', text: CHUNKS[0] })
    await preview.send({ type: 'assistantError', message: 'model unavailable' })

    // --- user close: one notification, and everything transient is discarded (req 4.8).
    await preview.clearPosted()
    await preview.click('#assistant-close')
    expect(await preview.posted()).toEqual([{ type: 'askAiClose' }])
    expect(await preview.hidden('#assistant-modal')).toBe(true)
    expect(await preview.count('#assistant-log .ai-msg')).toBe(0)
    expect(await preview.text('#assistant-error')).toBe('')
    expect(await preview.css('#assistant-error', 'display')).toBe('none')
    expect(await disabled(preview, '#assistant-send')).toBe(true) // the session is gone with it

    // --- re-open: this doubles as the positive control for the silence asserted below —
    // the posting channel demonstrably still works on this page.
    await preview.clearPosted()
    const again = await reopenAskAi(preview)
    expect(await preview.posted()).toEqual([
      { type: 'askAiOpen', paragraphIndex: FIRST_BLOCK, lastIndex: LAST_BLOCK, selection: again, translated: false },
    ])
    await confirmSession(preview, again)
    await ask(preview, 'explain this again')
    expect(await preview.count('#assistant-log .ai-msg')).toBe(2)

    // --- host close: the host already knows, so a post back would be an echo it never
    // asked for — and one it would answer by cancelling a session the user may have
    // re-opened in the meantime.
    await preview.clearPosted()
    await preview.send({ type: 'assistantClosed' })
    expect(await preview.posted()).toEqual([])
    expect(await preview.hidden('#assistant-modal')).toBe(true)
    expect(await preview.count('#assistant-log .ai-msg')).toBe(0)
    expect(await preview.text('#assistant-error')).toBe('')
    expect(await disabled(preview, '#assistant-send')).toBe(true)

    expect(unexpectedIssues(preview.errors())).toEqual([])
  })

  it('closes on Escape from inside the input and reports it once', async () => {
    preview = await openPreview()
    const selection = await askAiAboutTwoBlocks(preview)
    await confirmSession(preview, selection)
    await preview.typeInto('#assistant-input', 'half-written question')

    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.posted()).toEqual([{ type: 'askAiClose' }])
    expect(await preview.hidden('#assistant-modal')).toBe(true)
    expect(await disabled(preview, '#assistant-send')).toBe(true)

    expect(unexpectedIssues(preview.errors())).toEqual([])
  })
})

/** The `disabled` property of a form control (no harness helper covers it). */
async function disabled(preview: Preview, selector: string): Promise<boolean> {
  const value = await preview.page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLButtonElement | null
    return el ? el.disabled : null
  }, selector)
  if (value === null) throw new Error(`no element matches ${selector}`)
  return value
}

/** The chat log reduced to role + text, in order — the shape every ordering oracle wants.
 *  `<script>`/`<style>` subtrees are dropped because they render nothing: they are not chat
 *  text, and counting them here would let the reply fixture's inert script masquerade as
 *  something the assistant said. Whether such a node can arrive at all is the host
 *  sanitizer's business; what matters here is that it neither runs nor shows. */
async function bubbles(preview: Preview): Promise<{ role: string; text: string }[]> {
  return preview.page.evaluate(() =>
    Array.from(document.querySelectorAll('#assistant-log .ai-msg')).map((el) => {
      const visible = el.cloneNode(true) as HTMLElement
      for (const inert of visible.querySelectorAll('script, style')) inert.remove()
      return {
        role: el.classList.contains('ai-msg-user') ? 'user' : 'ai',
        text: visible.textContent ?? '',
      }
    }),
  )
}
