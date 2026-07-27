import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, openPreview, renderMarkdown, type Preview } from './harness'

/*
 * Pointer and hover semantics of the preview, in a real browser.
 *
 *   E7  — double-click selects a block, triple-click opens the original, the
 *         gutter marker is exempt but the empty gutter bridge is not.
 *   E17 — the hover peek: the 500 ms arm, the above/below flip, the stale-reply
 *         guard, and a code fence surviving as a real <pre>.
 *   E18 — hover translation suppressed by a live selection and by the gutter.
 *   E22 — the edit modal: debounce coalescing, the disable/enable round-trip,
 *         and the save / cancel payloads.
 *   E23 — scroll sync: the topmost-block report and its echo suppression.
 *
 * None of these can be expressed against jsdom: they are `e.detail` accumulation,
 * hit testing over an absolutely-positioned gutter, real Selection objects,
 * `getBoundingClientRect` arithmetic and page-owned timers.
 */

// Plain paragraphs on purpose. Two things depend on it: a double-click oracle has
// to be a literal string, and an inline element inside a block would make
// `mouseover` fire again mid-drag — which is exactly what E18 must not have happen
// by accident.
const PARA_1 = 'Alpha paragraph with several words in it here.'
const PARA_3 = 'Third paragraph of the fixture text.'
const SHORT_DOC = [
  '# Title',
  '',
  PARA_1,
  '',
  'Second paragraph of the fixture text.',
  '',
  PARA_3,
  '',
  'Fourth paragraph of the fixture text.',
  '',
  'Fifth paragraph of the fixture text.',
  '',
].join('\n')

// Long enough to wrap to several lines, so block boundaries in the scroll oracle are
// tens of pixels apart instead of a couple — no threshold assertion lands in the noise.
const FILLER =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
  'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure. ' +
  'Dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat. ' +
  'Non proident sunt in culpa qui officia deserunt mollit anim id est laborum sed ut perspiciatis unde omnis iste natus. ' +
  'Error sit voluptatem accusantium doloremque laudantium totam rem aperiam eaque ipsa quae ab illo inventore veritatis.'

function longDoc(blocks: number, label = 'Block'): string {
  const lines = ['# Title', '']
  for (let i = 1; i <= blocks; i++) lines.push(`${label} ${i}. ${FILLER}`, '')
  return lines.join('\n')
}

// The peek payload is built exactly the way the host builds it — PreviewController
// renders the block's markdown through the SAME MarkdownRenderer (req 7.15) — so the
// tooltip assertions are about the product's own output, not a hand-written string.
const CODE_FENCE = ['```js', 'const a = 1', 'const b = 2', '```'].join('\n')

// --- small readers over the page ---------------------------------------------

/** The block range the cursor toolbar says its actions will operate on. */
async function toolbarRange(preview: Preview): Promise<{ first: string | null; last: string | null }> {
  return preview.page.evaluate(() => {
    const el = document.getElementById('sel-toolbar') as HTMLElement
    return { first: el.dataset.firstIndex ?? null, last: el.dataset.lastIndex ?? null }
  })
}

/** A modal textarea reduced to the two things the sync state machine drives. */
async function fieldState(preview: Preview, selector: string): Promise<{ value: string; disabled: boolean }> {
  return preview.page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLTextAreaElement
    return { value: el.value, disabled: el.disabled }
  }, selector)
}

/** "Is anything highlighted?" — the two shapes of an empty selection at once (no range at
 *  all, or a collapsed caret), so neither can pass for a stray word left selected. */
async function selectionState(preview: Preview): Promise<{ text: string; collapsed: boolean }> {
  return preview.page.evaluate(() => {
    const sel = window.getSelection()
    return {
      text: sel?.toString() ?? '',
      collapsed: !sel || sel.rangeCount === 0 || sel.isCollapsed,
    }
  })
}

/** A timestamp for a stored comment; the value is never asserted, only its presence. */
const STAMP = '2026-07-01T00:00:00Z'

/** Viewport point inside a block's text, clear of the gutter control. */
async function pointIn(preview: Preview, index: number): Promise<{ x: number; y: number }> {
  const rect = await preview.rect(`[data-paragraph-index="${index}"]`)
  if (!rect) throw new Error(`no block ${index}`)
  return { x: rect.left + 30, y: rect.top + rect.height / 2 }
}

/** A neutral resting place with no block listeners under it — used to leave and
 *  re-enter a block, which is the only thing that re-fires `mouseover`. */
const NEUTRAL = { x: 640, y: 5 }

let preview: Preview | undefined

afterEach(async () => {
  await preview?.close()
  preview = undefined
})
afterAll(closeBrowser)

// ---------------------------------------------------------------------------

// Feature: block gestures (req 1.2 / 1.9), Scenario E7.
describe('E7 double-click selects a block, triple-click opens the original', () => {
  it('selects the whole block on a double-click and opens the source on a triple-click', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SHORT_DOC)
    // Mark the block so its gutter badge carries a literal "3" INSIDE the block
    // element. The selection oracle below is then a real test of "the block's own
    // text, gutter excluded" rather than a coincidence of an empty gutter.
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 1, count: 3 }] })
    expect(await preview.text('[data-paragraph-index="1"] .cmt-count')).toBe('3')
    expect(await preview.text('[data-paragraph-index="1"]')).toBe(`${PARA_1}3`)

    const point = await pointIn(preview, 1)

    await preview.clearPosted()
    await preview.clickAt(point.x, point.y, { count: 2 })
    await preview.page.waitForFunction(
      () => !(document.getElementById('sel-toolbar') as HTMLElement).hidden,
      { timeout: 5000 },
    )

    // req 1.9: the block's text, and only the block's text.
    expect(await preview.selectionText()).toBe(PARA_1)
    expect(await toolbarRange(preview)).toEqual({ first: '1', last: '1' })
    expect((await preview.posted()).filter((m) => m.type === 'openOriginal')).toEqual([])

    // The SAME point, three presses. The second press still fires `dblclick`, so the
    // block gets selected on the way through — the third click has to undo that and
    // open the source (req 1.2). Exactly one open, not one per press.
    await preview.clearPosted()
    await preview.clickAt(point.x, point.y, { count: 3 })
    await preview.waitForPost('openOriginal')

    const posted = await preview.posted()
    expect(posted.filter((m) => m.type === 'openOriginal')).toEqual([{ type: 'openOriginal' }])
    expect(posted.filter((m) => m.type === 'editParagraph' || m.type === 'addComment')).toEqual([])
    expect(await preview.selectionText()).toBe('')
    expect(await preview.page.evaluate(() => window.getSelection()?.isCollapsed ?? null)).toBe(true)
    expect(await preview.hidden('#sel-toolbar')).toBe(true)

    expect(preview.errors()).toEqual([])
  })

  it('selects from the empty gutter bridge but never from the marker icon', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SHORT_DOC)
    // A block WITH a comment: that is the state in which the marker is actually shown,
    // so clicking it is a gesture a user can really perform.
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 1, count: 1 }] })

    const block = (await preview.rect('[data-paragraph-index="1"]'))!
    const gutter = (await preview.rect('[data-paragraph-index="1"] > .bctl'))!
    const icon = (await preview.rect('[data-paragraph-index="1"] > .bctl > .bctl-comment'))!

    // The bridge: the transparent stretch of .bctl between the marker and the block's
    // own left edge. It exists so the pointer can reach the icons, but a double-click
    // on it is not on a control and must still reach #content.
    const bridge = { x: (icon.right + gutter.right) / 2, y: block.top + block.height / 2 }
    expect(bridge.x).toBeGreaterThan(icon.right)
    expect(bridge.x).toBeLessThan(block.left)
    const onBridge = (await preview.hitTest(bridge.x, bridge.y))!
    expect({ inBctl: onBridge.inBctl, inButton: onBridge.inButton }).toEqual({ inBctl: true, inButton: false })

    await preview.clearPosted()
    await preview.clickAt(bridge.x, bridge.y, { count: 2 })
    await preview.page.waitForFunction(
      () => !(document.getElementById('sel-toolbar') as HTMLElement).hidden,
      { timeout: 5000 },
    )
    expect(await preview.selectionText()).toBe(PARA_1)
    expect(await toolbarRange(preview)).toEqual({ first: '1', last: '1' })

    // Now the marker itself. Clear first, so "the selection did not change" is a state
    // the test can actually observe.
    await preview.clearSelection()
    expect(await preview.hidden('#sel-toolbar')).toBe(true)
    await preview.clearPosted()

    const center = { x: (icon.left + icon.right) / 2, y: (icon.top + icon.bottom) / 2 }
    expect((await preview.hitTest(center.x, center.y))!.inButton).toBe(true)
    await preview.clickAt(center.x, center.y, { count: 2 })

    // Positive control: the double-click really landed on the marker, because the
    // marker did its own job and opened the thread.
    await preview.page.waitForFunction(
      () => !(document.getElementById('comment-modal') as HTMLElement).hidden,
      { timeout: 5000 },
    )
    // And none of the block gestures ran — with NOTHING highlighted anywhere, not merely
    // no block. The first press opens the modal, so the second press of the same gesture
    // lands on the overlay that appeared in front of the marker, where Chromium's own
    // double-click word-select used to grab the dialog's chrome (the word "Comments"): a
    // stray highlight the user never asked for, from a gesture aimed at the gutter.
    expect(await selectionState(preview)).toEqual({ text: '', collapsed: true })
    expect(await preview.hidden('#sel-toolbar')).toBe(true)
    expect((await preview.posted()).filter((m) => m.type === 'openOriginal')).toEqual([])

    // The suppression belongs to the backdrop alone: inside the dialog a comment's text
    // is still selectable, which is what makes it copyable.
    const body = 'a stored comment body long enough to drag a selection across'
    const thread = { comments: [{ id: 'c1', createdAt: STAMP, updatedAt: STAMP, body }] }
    await preview.send({ type: 'commentThread', paragraphIndex: 1, comments: thread.comments, threads: [thread] })
    expect(await preview.text('#comment-list .cmt-body')).toBe(body)
    const dragged = await preview.dragSelect('#comment-list .cmt-body')
    expect(dragged.trim().length).toBeGreaterThan(0)
    expect(body).toContain(dragged.trim())

    expect(preview.errors()).toEqual([])
  })
})

// Feature: hover peek (req 7.1 / 7.2 / 7.15), Scenario E17.
describe('E17 hover peek arming, placement and content', () => {
  it('arms only after the dwell and renders the peek as real HTML above the block', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    const point = await pointIn(preview, 5)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)

    // Paragraph_Hover is defined as dwelling LONGER than 500 ms, so nothing may be
    // posted well inside the window. Measured in the page: a Node-side sleep plus two
    // CDP round trips could drift past the deadline and turn this into a coin flip.
    const early = await preview.page.evaluate(async () => {
      const started = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 350))
      return {
        elapsed: performance.now() - started,
        hovers: window.__posted.filter((m) => m.type === 'paragraphHover').length,
      }
    })
    expect(early.elapsed).toBeLessThan(500)
    expect(early.hovers).toBe(0)

    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 5 })
    // One-shot, not a repeating poll: dwelling longer must not keep asking the host.
    await preview.wait(500)
    expect((await preview.posted()).filter((m) => m.type === 'paragraphHover')).toEqual([
      { type: 'paragraphHover', paragraphIndex: 5 },
    ])

    await preview.send({ type: 'showTooltip', paragraphIndex: 5, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('block')

    const tip = (await preview.rect('#tooltip'))!
    const block = (await preview.rect('[data-paragraph-index="5"]'))!
    // Above the block with the 6 px gap. `offsetHeight` is integral while the client
    // rect is fractional, so the measured gap lands within a pixel of it.
    expect(tip.bottom).toBeLessThanOrEqual(block.top - 6 + 1)
    expect(tip.bottom).toBeGreaterThanOrEqual(block.top - 6 - 1.5)
    // Anchored to the block's left edge, and inside the viewport either way.
    expect(Math.abs(tip.left - block.left)).toBeLessThanOrEqual(1)
    const clientWidth = await preview.page.evaluate(() => document.documentElement.clientWidth)
    expect(tip.left).toBeGreaterThanOrEqual(3)
    expect(tip.right).toBeLessThanOrEqual(clientWidth - 3)

    // req 7.15: a mini preview, not raw Markdown. A real <pre><code> that preserves the
    // newline, with the fence delimiters gone.
    expect(await preview.count('#tooltip pre code')).toBe(1)
    expect(await preview.css('#tooltip pre', 'white-space')).toMatch(/^pre/)
    const text = (await preview.text('#tooltip')) ?? ''
    expect(text).toContain('const a = 1\nconst b = 2')
    expect(text).not.toContain('`')

    expect(preview.errors()).toEqual([])
  })

  it('flips the peek below the block when it would clip the top of the viewport', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    // Park block 5 just under the sticky header. The peek is ~110 px tall, so above is
    // impossible and the only placement that does not clip is below.
    await preview.scrollTo(
      await preview.page.evaluate(
        () =>
          window.scrollY +
          document.querySelector('[data-paragraph-index="5"]')!.getBoundingClientRect().top -
          40,
      ),
    )
    const block = (await preview.rect('[data-paragraph-index="5"]'))!
    const headerBottom = (await preview.rect('header'))!.bottom
    expect(block.top).toBeGreaterThan(headerBottom) // still hoverable, not under the header
    expect(block.top).toBeLessThan(60)

    await preview.clearPosted()
    await preview.moveMouse(block.left + 30, block.top + block.height / 2)
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 5 })
    await preview.send({ type: 'showTooltip', paragraphIndex: 5, html: peek.html })

    const tip = (await preview.rect('#tooltip'))!
    expect(await preview.css('#tooltip', 'display')).toBe('block')
    expect(tip.height + 6).toBeGreaterThan(block.top) // it genuinely could not fit above
    expect(tip.top).toBeGreaterThanOrEqual(block.bottom + 6 - 1)
    expect(tip.top).toBeLessThanOrEqual(block.bottom + 6 + 1)

    expect(preview.errors()).toEqual([])
  })

  it('drops a peek that arrives for a block the pointer already left', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    const point = await pointIn(preview, 7)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 7 })

    // A reply for the block the pointer has moved off must not paint over the one it
    // is on now.
    await preview.send({ type: 'showTooltip', paragraphIndex: 5, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('none')
    // Positive control: the reply for the block actually under the pointer does paint.
    await preview.send({ type: 'showTooltip', paragraphIndex: 7, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('block')

    expect(preview.errors()).toEqual([])
  })

  it('survives the pointer travelling from the block into the peek', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    const point = await pointIn(preview, 5)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    await preview.waitForPost('paragraphHover')
    await preview.send({ type: 'showTooltip', paragraphIndex: 5, html: peek.html })
    const tip = (await preview.rect('#tooltip'))!
    expect(await preview.css('#tooltip', 'display')).toBe('block')

    // Cross the gap in one move, the way a pointer heading for the peek does. Leaving
    // the block schedules the hide; entering the peek has to cancel it (req 7.7 — the
    // peek only goes away once BOTH areas are left).
    await preview.moveMouse(tip.left + tip.width / 2, tip.top + tip.height / 2)
    await preview.wait(400) // longer than the 250 ms grace period
    expect(await preview.css('#tooltip', 'display')).toBe('block')

    // Positive control for the hide path: leaving the peek for good does dismiss it.
    await preview.moveMouse(NEUTRAL.x, NEUTRAL.y)
    await preview.page.waitForFunction(
      () => getComputedStyle(document.getElementById('tooltip') as HTMLElement).display === 'none',
      { timeout: 5000 },
    )

    expect(preview.errors()).toEqual([])
  })
})

// Feature: hover suppression (req 10.14), Scenario E18.
describe('E18 hover translation suppressed by a selection and by the gutter', () => {
  it('stays silent while a selection is live and speaks again once it is cleared', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const point = await pointIn(preview, 3)

    // Positive control: with nothing selected the hover arms normally.
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 3 })

    // Drag INSIDE that same block and leave the pointer where the drag ended. The
    // pointer never crosses an element boundary, so nothing re-arms by accident: a post
    // in the next 900 ms could only come from the path req 10.14 forbids.
    await preview.clearPosted()
    const selected = await preview.dragSelect('[data-paragraph-index="3"]')
    expect(selected.trim().length).toBeGreaterThan(0)
    await preview.wait(900)
    expect((await preview.posted()).filter((m) => m.type === 'paragraphHover')).toEqual([])

    // Clearing the selection lets hover translation resume unchanged. The pointer has to
    // leave and re-enter: `mouseover` is what arms the timer and it does not re-fire
    // while the pointer stays inside the same element.
    await preview.clearSelection()
    await preview.moveMouse(NEUTRAL.x, NEUTRAL.y)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 3 })

    expect(preview.errors()).toEqual([])
  })

  // req 10.14 promises the peek resumes WHEN THE SELECTION IS CLEARED, and the pointer
  // does not have to move for that to be the moment: dwelling is already satisfied. The
  // timer used to be armed only by `mouseover`, which never re-fires inside the element
  // the pointer is already in, so a drag-select followed by a click-away left the peek
  // silent forever. The clearing edge itself now re-arms whatever is under the pointer.
  it('resumes the peek when the selection is cleared under a resting pointer', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    // Drag inside block 3 and leave the pointer exactly where the drag ended.
    const selected = await preview.dragSelect('[data-paragraph-index="3"]')
    expect(selected.trim().length).toBeGreaterThan(0)
    await preview.clearPosted()

    // Clear it WITHOUT moving the pointer — a click away would move it, and moving is
    // precisely the thing this scenario must not need.
    await preview.clearSelection()

    // Nothing re-entered the block, so the clearing edge is the only path that can have
    // posted this.
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 3 })
    expect(await preview.count('.paragraph-highlight')).toBe(1)

    // "Unchanged" means the whole peek, not just the request: the hovered-block reference
    // came back with it, so the host's reply paints instead of being dropped as stale.
    await preview.send({ type: 'showTooltip', paragraphIndex: 3, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('block')
    // Still one-shot — resuming must not turn into a repeating poll.
    await preview.wait(700)
    expect((await preview.posted()).filter((m) => m.type === 'paragraphHover')).toEqual([
      { type: 'paragraphHover', paragraphIndex: 3 },
    ])

    expect(preview.errors()).toEqual([])
  })

  it('re-arms nothing when the gutter or an open dialog owns the pointer', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 4, count: 1 }] })

    // --- the gutter marker keeps the exemption it has under `mouseover`.
    await preview.dragSelect('[data-paragraph-index="3"]')
    const icon = (await preview.rect('[data-paragraph-index="4"] > .bctl > .bctl-comment'))!
    await preview.moveMouse((icon.left + icon.right) / 2, (icon.top + icon.bottom) / 2)
    await preview.clearPosted()
    await preview.clearSelection()
    await preview.wait(900) // the whole hover window, with margin
    expect((await preview.posted()).filter((m) => m.type === 'paragraphHover')).toEqual([])
    expect(await preview.count('.paragraph-highlight')).toBe(0)

    // --- a dialog covers the content, so the pointer is not resting on a block at all.
    const point = await pointIn(preview, 5)
    await preview.dragSelect('[data-paragraph-index="5"]')
    await preview.send({ type: 'openEditModal', paragraphIndex: 5, storageText: 'a', targetText: 'b' })
    await preview.moveMouse(point.x, point.y)
    expect((await preview.hitTest(point.x, point.y))!.blockIndex).toBeNull()
    await preview.clearPosted()
    await preview.clearSelection()
    await preview.wait(900)
    expect((await preview.posted()).filter((m) => m.type === 'paragraphHover')).toEqual([])

    // Positive control: with the dialog gone, the identical clear at the identical point
    // does resume — so both silences above are the suppression, not a dead path.
    await preview.press('Escape')
    expect(await preview.hidden('#modal')).toBe(true)
    await preview.dragSelect('[data-paragraph-index="5"]')
    await preview.moveMouse(point.x, point.y)
    await preview.clearPosted()
    await preview.clearSelection()
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 5 })

    expect(preview.errors()).toEqual([])
  })

  it('never arms from the gutter marker, and leaves the block unhighlighted', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 4, count: 1 }] })

    // Positive control on the same page and the same listeners.
    const point = await pointIn(preview, 3)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    expect(await preview.waitForPost('paragraphHover')).toEqual({ type: 'paragraphHover', paragraphIndex: 3 })

    // Approach block 4's marker from OUTSIDE the block, so the gutter guard is the only
    // thing that can keep the highlight off it.
    await preview.moveMouse(NEUTRAL.x, NEUTRAL.y)
    await preview.clearPosted()
    const icon = (await preview.rect('[data-paragraph-index="4"] > .bctl > .bctl-comment'))!
    await preview.moveMouse((icon.left + icon.right) / 2, (icon.top + icon.bottom) / 2)
    await preview.wait(900)

    const posted = await preview.posted()
    // The pointer really is on the marker — it asked for that block's thread.
    expect(posted.some((m) => m.type === 'requestCommentThread' && m.paragraphIndex === 4)).toBe(true)
    expect(posted.filter((m) => m.type === 'paragraphHover')).toEqual([])
    expect(await preview.count('.paragraph-highlight')).toBe(0)

    expect(preview.errors()).toEqual([])
  })

  it('tears down an open peek when a selection appears, and refuses to reopen it', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    const point = await pointIn(preview, 3)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    await preview.waitForPost('paragraphHover')
    await preview.send({ type: 'showTooltip', paragraphIndex: 3, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('block')

    const selected = await preview.selectChars('[data-paragraph-index="3"]', 0, '[data-paragraph-index="3"]', 20)
    expect(selected.trim().length).toBeGreaterThan(0)
    expect(await preview.css('#tooltip', 'display')).toBe('none')

    // The hovered-block reference went with it, so a reply still in flight cannot bring
    // the peek back over the text being selected.
    await preview.send({ type: 'showTooltip', paragraphIndex: 3, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('none')

    expect(preview.errors()).toEqual([])
  })
})

// Feature: paragraph edit modal (req 7.8–7.14, 10.16), Scenario E22.
describe('E22 edit modal', () => {
  it('carries the block range from the toolbar to save and coalesces typing into one sync', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SHORT_DOC)

    const selected = await preview.dragSelect('[data-paragraph-index="2"]', '[data-paragraph-index="4"]')
    expect(selected).toContain(PARA_3) // block 3 lies wholly inside the span
    expect(await preview.hidden('#sel-toolbar')).toBe(false)
    expect(await toolbarRange(preview)).toEqual({ first: '2', last: '4' })

    // req 10.16: the edit action targets the whole selected block RANGE.
    await preview.clearPosted()
    await preview.click('#sel-edit')
    expect(await preview.waitForPost('editParagraph')).toEqual({
      type: 'editParagraph',
      paragraphIndex: 2,
      lastIndex: 4,
    })
    expect(await preview.hidden('#sel-toolbar')).toBe(true)

    await preview.send({
      type: 'openEditModal',
      paragraphIndex: 2,
      lastIndex: 4,
      storageText: 'orig',
      targetText: 'trans',
    })
    expect(await preview.hidden('#modal')).toBe(false)
    expect(await fieldState(preview, '#modal-storage')).toEqual({ value: 'orig', disabled: false })
    expect(await fieldState(preview, '#modal-target')).toEqual({ value: 'trans', disabled: false })

    // req 7.9: ONE request, 1000 ms after the last change — not one per keystroke. The
    // gaps here are 60 ms, so every one of them is far inside the window; a per-keystroke
    // regression would fire eleven translation requests instead of one, and the text
    // asserted is the FINAL value, not a prefix.
    await preview.click('#modal-storage')
    await preview.press('End', { ctrl: true })
    await preview.clearPosted()
    await preview.typeText('hello world', { delay: 60 })
    await preview.wait(1400)
    expect((await preview.posted()).filter((m) => m.type === 'modalSyncRequest')).toEqual([
      { type: 'modalSyncRequest', field: 'storage', text: 'orighello world' },
    ])

    // A selection inside a form field belongs to the field, not to the document, so the
    // cursor toolbar must not appear over the modal. Counting the events proves the
    // listener DID run — otherwise "still hidden" would be true for the wrong reason.
    await preview.page.evaluate(() => {
      const w = window as unknown as { __selchanges: number }
      w.__selchanges = 0
      document.addEventListener('selectionchange', () => {
        w.__selchanges++
      })
    })
    await preview.press('a', { ctrl: true })
    await preview.frames(2)
    expect(await preview.page.evaluate(() => (window as unknown as { __selchanges: number }).__selchanges)).toBeGreaterThan(0)
    expect(await preview.hidden('#sel-toolbar')).toBe(true)

    // req 7.11: the field being synced is locked while the request is in flight.
    await preview.send({ type: 'editModalSyncStart', field: 'target' })
    expect(await fieldState(preview, '#modal-target')).toEqual({ value: 'trans', disabled: true })
    await preview.send({ type: 'editModalSyncComplete', field: 'target', text: 'nouveau' })
    expect(await fieldState(preview, '#modal-target')).toEqual({ value: 'nouveau', disabled: false })

    await preview.clearPosted()
    await preview.click('#modal-save')
    expect(await preview.waitForPost('saveParagraph')).toEqual({
      type: 'saveParagraph',
      paragraphIndex: 2,
      lastIndex: 4,
      storageText: 'orighello world',
      targetText: 'nouveau',
    })
    expect(await preview.hidden('#modal')).toBe(true)
    // Saving is not abandoning: the host must not also be told the edit was cancelled.
    expect((await preview.posted()).filter((m) => m.type === 'cancelParagraphEdit')).toEqual([])

    expect(preview.errors()).toEqual([])
  })

  it('re-enables the field and surfaces the message when a sync fails', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SHORT_DOC)
    await preview.send({
      type: 'openEditModal',
      paragraphIndex: 3,
      storageText: 'source text',
      targetText: 'target text',
    })
    expect(await preview.hidden('#modal')).toBe(false)
    expect(await preview.text('#modal-error')).toBe('')

    await preview.send({ type: 'editModalSyncStart', field: 'storage' })
    expect(await fieldState(preview, '#modal-storage')).toEqual({ value: 'source text', disabled: true })

    // req 7.12: the error shows under the modal AND the field keeps its last good value
    // and becomes editable again — a permanently disabled field would strand the edit.
    await preview.send({
      type: 'editModalSyncError',
      field: 'storage',
      message: 'Failed to load the translation',
    })
    expect(await fieldState(preview, '#modal-storage')).toEqual({ value: 'source text', disabled: false })
    expect(await preview.text('#modal-error')).toBe('Failed to load the translation')
    expect(await preview.hidden('#modal')).toBe(false) // an error does not close the edit

    expect(preview.errors()).toEqual([])
  })

  it('abandons the edit identically from Cancel and from Escape', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SHORT_DOC)

    await preview.send({ type: 'openEditModal', paragraphIndex: 3, storageText: 'a', targetText: 'b' })
    await preview.clearPosted()
    await preview.click('#modal-cancel')
    expect(await preview.hidden('#modal')).toBe(true)
    expect(await preview.posted()).toEqual([{ type: 'cancelParagraphEdit' }])

    // Esc is the same door: same close, same single notification to the host.
    await preview.send({ type: 'openEditModal', paragraphIndex: 3, storageText: 'a', targetText: 'b' })
    expect(await preview.hidden('#modal')).toBe(false)
    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.hidden('#modal')).toBe(true)
    expect(await preview.posted()).toEqual([{ type: 'cancelParagraphEdit' }])

    expect(preview.errors()).toEqual([])
  })

  // The dialog hides itself the moment Save is clicked, so a write the host then refuses
  // would take the user's text with it. The host re-opens the dialog carrying that text
  // plus the reason; a plain open must still come up clean.
  it('re-opens carrying the typed text and the reason when the host refused the save', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SHORT_DOC)

    await preview.send({ type: 'openEditModal', paragraphIndex: 3, storageText: 'a', targetText: 'b' })
    await preview.click('#modal-save')
    expect(await preview.hidden('#modal')).toBe(true)

    await preview.send({
      type: 'openEditModal',
      paragraphIndex: 3,
      storageText: 'my edited text',
      targetText: 'mein Text',
      error: 'Could not save — the document changed while the dialog was open.',
    })
    expect(await preview.hidden('#modal')).toBe(false)
    expect(await fieldState(preview, '#modal-storage')).toEqual({ value: 'my edited text', disabled: false }) // the work survives
    expect(await fieldState(preview, '#modal-target')).toEqual({ value: 'mein Text', disabled: false })
    expect(await preview.text('#modal-error')).toMatch(/could not save/i)

    // A subsequent ordinary open must not inherit the stale reason.
    await preview.send({ type: 'openEditModal', paragraphIndex: 3, storageText: 'a', targetText: 'b' })
    expect(await preview.text('#modal-error')).toBe('')
    expect(preview.errors()).toEqual([])
  })
})

// Feature: scroll sync (req 2.3, 10.4), Scenario E23.
describe('E23 scroll sync', () => {
  it('reports the topmost visible block and answers a host-driven scroll with silence', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))

    // Park block 7 at the very top of the viewport: block 6 then ends above the viewport
    // entirely and block 7 runs far past the sticky header, so "the topmost visible
    // block" is unambiguous under any reading of "topmost".
    const y = await preview.page.evaluate(
      () =>
        window.scrollY +
        document.querySelector('[data-paragraph-index="7"]')!.getBoundingClientRect().top -
        4,
    )
    await preview.clearPosted()
    await preview.scrollTo(y)
    const scrolled = await preview.waitForPost('scrollChanged')

    const geometry = await preview.page.evaluate(() => {
      const headerBottom = document.querySelector('header')!.getBoundingClientRect().bottom
      const all = Array.from(document.querySelectorAll<HTMLElement>('[data-paragraph-index]'))
      const first = all.find((el) => el.getBoundingClientRect().bottom > headerBottom)
      const at = (i: number) => document.querySelector(`[data-paragraph-index="${i}"]`)!.getBoundingClientRect()
      return {
        firstBelowHeader: first ? Number(first.dataset.paragraphIndex) : null,
        previousBottom: at(6).bottom,
        targetBottom: at(7).bottom,
      }
    })
    // Fixture guard: the block before the target is off-screen and the target extends
    // well past the header, so this scroll position is not sitting on a boundary.
    expect(geometry.previousBottom).toBeLessThan(0)
    expect(geometry.targetBottom).toBeGreaterThan(60)
    // req 2.3: the preview tells the editor which element is at its top.
    expect(geometry.firstBelowHeader).toBe(7)
    expect(scrolled).toEqual({ type: 'scrollChanged', topParagraphIndex: 7 })
    expect((await preview.posted()).filter((m) => m.type === 'scrollChanged')).toHaveLength(1)

    // req 2.3, second half: the initiator of a scroll gets no answer back. The host asked
    // for block 20, so the resulting scroll must be swallowed whole — if scrollIntoView
    // emitted more than one scroll event the guard would leak and the two sides would
    // feed each other.
    await preview.clearPosted()
    await preview.send({ type: 'editorScrollSync', paragraphIndex: 20 })
    await preview.wait(400)
    expect((await preview.posted()).filter((m) => m.type === 'scrollChanged')).toEqual([])
    const target = (await preview.rect('[data-paragraph-index="20"]'))!
    expect(Math.abs(target.top)).toBeLessThanOrEqual(2)

    expect(preview.errors()).toEqual([])
  })

  it('dismisses an open peek on scroll', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(40))
    const peek = await renderMarkdown(CODE_FENCE)

    const point = await pointIn(preview, 5)
    await preview.clearPosted()
    await preview.moveMouse(point.x, point.y)
    await preview.waitForPost('paragraphHover')
    await preview.send({ type: 'showTooltip', paragraphIndex: 5, html: peek.html })
    expect(await preview.css('#tooltip', 'display')).toBe('block')

    await preview.scrollBy(120)
    expect(await preview.css('#tooltip', 'display')).toBe('none')

    expect(preview.errors()).toEqual([])
  })

  it('stops reporting scroll position in bilingual view', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(longDoc(12))
    const translated = await renderMarkdown(longDoc(12, 'Bloc'))
    await preview.send({ type: 'translationComplete', translatedHtml: translated.html })

    // Positive control: the single view does report.
    await preview.clearPosted()
    await preview.scrollBy(300)
    expect(await preview.waitForPost('scrollChanged')).toBeTruthy()

    await preview.click('#bilingual-btn')
    await preview.page.waitForFunction(() => document.querySelector('.bgrid') !== null, { timeout: 5000 })

    // req 10.4: the pair grid scrolls as one, so there is nothing to sync to the editor.
    await preview.clearPosted()
    await preview.scrollBy(300)
    await preview.wait(300)
    expect((await preview.posted()).filter((m) => m.type === 'scrollChanged')).toEqual([])

    expect(preview.errors()).toEqual([])
  })
})
