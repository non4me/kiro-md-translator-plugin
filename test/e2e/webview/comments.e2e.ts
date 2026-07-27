import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, openPreview, type Preview } from './harness'

/*
 * Comment affordances, end to end in a real browser.
 *
 * Scenarios E5, E6, E13, E14 and E16 of the webview e2e plan. Everything here is
 * an oracle taken from what the product PROMISES:
 *
 *  - req 10.17 — a comment on a selection that spans several blocks anchors to the
 *    two ends independently (the selected TAIL of the first block, the selected
 *    HEAD of the last), highlights the whole range, and marks the first block only.
 *  - req 10.12 — the quote is the trimmed selection ("the comment highlights
 *    exactly what you selected", README), with the surrounding block text as
 *    prefix/suffix; each fragment is painted through the CSS Custom Highlight API.
 *  - `FragmentAnchor.translated` (src/types.ts) — a quote captured over a
 *    target-language view is NOT a substring of the storage-language source, so it
 *    must be flagged or the host anchors it against the wrong text and orphans it.
 *  - req 11.13 — while comments are disabled the block's comment icon is hidden and a
 *    comment can neither be added nor opened: unreachable, not merely invisible. The
 *    paragraph-edit control stays untouched, and the toggle applies without a reopen.
 *  - req 10.13 / 11.6 — a block with several fragment threads shows a count and, on
 *    hover, one popover row per fragment; hovering a row highlights exactly that
 *    fragment, clicking opens THAT thread.
 *
 * Why a browser: every observable below is a Selection/Range fact, a hit test, or a
 * CSS Custom Highlight registry entry. None of them exists in jsdom, and the two
 * regressions these scenarios guard (an endpoint inside inline markup orphaning the
 * comment; a target-language quote anchored against the source) are both data loss.
 */

// --- fixtures ---------------------------------------------------------------

/** Block 2 ends inside `<strong>`, block 4 opens inside `<code>` — the two endpoint
 *  shapes that used to orphan a span comment. Indices are the renderer's document
 *  order over p/h1-6/li/pre/tr: 0 = the heading, 1..5 = the paragraphs. */
const SPAN_DOC = [
  '# Span fixture heading',
  '',
  'Alpha paragraph opens the document body.',
  '',
  'Beta paragraph carries a **bold tail ending here**.',
  '',
  'Gamma paragraph sits wholly inside the selected span.',
  '',
  '`Delta code head` opens the fourth paragraph plainly.',
  '',
  'Epsilon paragraph closes the fixture text.',
  '',
].join('\n')

const SPAN_BLOCK_2 = 'Beta paragraph carries a bold tail ending here.'
const SPAN_BLOCK_4 = 'Delta code head opens the fourth paragraph plainly.'

/** Source and translation must share block structure so the indices stay in lock-step
 *  (the lineMap contract); only the words differ, so a quote proves WHICH side it came from. */
const STORAGE_DOC = [
  '# Storage heading',
  '',
  'Alpha original wording lives in the storage language.',
  '',
  'Beta original wording lives in the storage language.',
  '',
].join('\n')

const TARGET_DOC = [
  '# Target heading',
  '',
  'Alpha translated wording lives in the target language.',
  '',
  'Beta translated wording lives in the target language.',
  '',
].join('\n')

const STORAGE_BLOCK_1 = 'Alpha original wording lives in the storage language.'
const TARGET_BLOCK_1 = 'Alpha translated wording lives in the target language.'

const FRAGMENT_DOC = [
  '# Fragment highlight fixture',
  '',
  'First block holds a single quoted fragment inside it.',
  '',
  'Second block holds two distinct quoted fragments here.',
  '',
  'Third block lies wholly inside a multi block span.',
  '',
  'Fourth block keeps a comment whose quote no longer exists.',
  '',
  'Fifth block sits inside a span and carries its own notes.',
  '',
  'Sixth block closes the fixture.',
  '',
].join('\n')

const FRAGMENT_BLOCK_3 = 'Third block lies wholly inside a multi block span.'
const FRAGMENT_BLOCK_5 = 'Fifth block sits inside a span and carries its own notes.'

const POPOVER_DOC = [
  '# Popover fixture',
  '',
  'Alpha paragraph before the target block.',
  '',
  'Beta paragraph holds alpha quote and beta quote inside it.',
  '',
  'Gamma paragraph after the target block.',
  '',
].join('\n')

const TOGGLE_DOC = [
  '# Comments toggle fixture',
  '',
  'Alpha paragraph carries the only comment in this fixture.',
  '',
  'Beta paragraph is here to be selected.',
  '',
].join('\n')

/** A host `Comment`; only `body` is read by the popover, the rest is the real shape. */
function comment(id: string, body: string): { id: string; createdAt: string; updatedAt: string; body: string } {
  return { id, createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z', body }
}

// --- shared helpers ---------------------------------------------------------

/** The block range the selection toolbar says its actions will operate on. */
async function toolbarRange(preview: Preview): Promise<{ firstIndex?: string; lastIndex?: string }> {
  return preview.page.evaluate(() => {
    const el = document.getElementById('sel-toolbar') as HTMLElement
    return { firstIndex: el.dataset.firstIndex, lastIndex: el.dataset.lastIndex }
  })
}

/** Tag names of the live selection's endpoints — proves a range really does end inside
 *  the inline markup, rather than the test having silently selected plain text. */
async function selectionEndpointTags(preview: Preview): Promise<{ start: string; end: string }> {
  return preview.page.evaluate(() => {
    const range = window.getSelection()!.getRangeAt(0)
    return {
      start: (range.startContainer.parentElement?.tagName ?? '').toLowerCase(),
      end: (range.endContainer.parentElement?.tagName ?? '').toLowerCase(),
    }
  })
}

/** prefix/suffix must be the block text IMMEDIATELY around the quote (req 10.12), which
 *  is what lets the host tell two identical quotes in one block apart. */
function expectContextAround(
  blockText: string,
  fragment: { quote: string; prefix: string; suffix: string },
): void {
  const at = blockText.indexOf(fragment.quote)
  expect(at).toBeGreaterThanOrEqual(0)
  expect(blockText.slice(0, at).endsWith(fragment.prefix)).toBe(true)
  expect(blockText.slice(at + fragment.quote.length).startsWith(fragment.suffix)).toBe(true)
}

/** A span's first-block quote must run to the END of that block, and its last-block quote
 *  from the START (req 10.17) — modulo the edge-punctuation trim of req 10.12, so what is
 *  left over on the far side may be a full stop but never another word. */
const PROSE = /[\p{L}\p{N}]/u

function expectBlockTail(blockText: string, quote: string): void {
  const at = blockText.indexOf(quote)
  expect(at).toBeGreaterThanOrEqual(0)
  expect(PROSE.test(blockText.slice(at + quote.length))).toBe(false)
}

function expectBlockHead(blockText: string, quote: string): void {
  const at = blockText.indexOf(quote)
  expect(at).toBeGreaterThanOrEqual(0)
  expect(PROSE.test(blockText.slice(0, at))).toBe(false)
}

// ---------------------------------------------------------------------------
// E5 — multi-block comment: the span payload
// ---------------------------------------------------------------------------

// Feature: comments on a multi-block selection (req 10.17), Scenario E5.
describe('E5 multi-block comment span payload', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('anchors both ends when the endpoints sit inside inline markup', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SPAN_DOC)

    // Endpoints exactly inside <strong> (block 2) and <code> (block 4). A mouse drag
    // cannot be told to land on a given character; a real Range can, and it is just as
    // live a Selection as a drag leaves behind.
    const selected = await preview.selectChars('[data-paragraph-index="2"]', 30, '[data-paragraph-index="4"]', 10)
    expect(await selectionEndpointTags(preview)).toEqual({ start: 'strong', end: 'code' })
    expect(selected.startsWith('tail ending here.')).toBe(true)
    expect(selected.includes('Gamma paragraph sits wholly')).toBe(true)
    expect(selected.endsWith('Delta code')).toBe(true)

    // The toolbar appears for a span of any extent (req 10.15) and carries the range.
    expect(await preview.hidden('#sel-toolbar')).toBe(false)
    expect(await toolbarRange(preview)).toEqual({ firstIndex: '2', lastIndex: '4' })

    // A REAL mouse click: #sel-toolbar keeps the selection alive through its
    // mousedown → preventDefault, and a programmatic click would skip exactly that.
    await preview.clearPosted()
    await preview.click('#sel-comment')

    const opened = await preview.waitForPost('requestCommentThread')
    expect(opened).toEqual({ type: 'requestCommentThread', paragraphIndex: 2 })
    expect(await preview.hidden('#comment-modal')).toBe(false)
    // Opening the thread is not yet a comment.
    expect((await preview.posted()).filter((m) => m.type === 'addComment')).toEqual([])

    await preview.typeInto('#comment-input', 'Span note')
    await preview.clearPosted()
    await preview.click('#comment-add')

    const added = await preview.waitForPost('addComment')
    expect(added.paragraphIndex).toBe(2)
    expect(added.endIndex).toBe(4)
    expect(added.body).toBe('Span note')
    // The orphan regression: an endpoint inside <strong>/<code> used to yield an empty
    // quote, which the host could never re-anchor.
    expect(added.fragment!.quote).toBe('tail ending here')
    expect(added.endFragment!.quote).toBe('Delta code')
    expectContextAround(SPAN_BLOCK_2, added.fragment!)
    expectContextAround(SPAN_BLOCK_4, added.endFragment!)
    // Captured over the storage-language source, so the target-language flag must be absent.
    expect('translated' in added.fragment!).toBe(false)
    expect('translated' in added.endFragment!).toBe(false)

    // The modal re-pulls its thread so the new comment shows up in the list.
    expect((await preview.posted()).map((m) => m.type)).toEqual(['addComment', 'requestCommentThread'])

    expect(preview.errors()).toEqual([])
  })

  it('carries the same two-ended payload from a real cross-block drag', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SPAN_DOC)

    // A drag across a block boundary leaves endpoints Chromium chose, not ones the test
    // placed — the arithmetic `spanCommentPayload` has to survive in the field.
    const selected = await preview.dragSelect('[data-paragraph-index="1"]', '[data-paragraph-index="3"]', {
      fromFraction: 0.4,
      toFraction: 0.6,
    })
    expect(selected.length).toBeGreaterThan(0)
    expect(await toolbarRange(preview)).toEqual({ firstIndex: '1', lastIndex: '3' })

    await preview.clearPosted()
    await preview.click('#sel-comment')
    expect(await preview.waitForPost('requestCommentThread')).toEqual({
      type: 'requestCommentThread',
      paragraphIndex: 1,
    })

    await preview.typeInto('#comment-input', 'Dragged span')
    await preview.clearPosted()
    await preview.click('#comment-add')

    const added = await preview.waitForPost('addComment')
    expect(added.paragraphIndex).toBe(1)
    expect(added.endIndex).toBe(3)
    const firstText = (await preview.text('[data-paragraph-index="1"]')) ?? ''
    const lastText = (await preview.text('[data-paragraph-index="3"]')) ?? ''
    // Each end quote is the selected part of ITS OWN block — a tail of the first, a head
    // of the last — never empty, never text from the other end.
    expect(added.fragment!.quote.length).toBeGreaterThan(0)
    expect(added.endFragment!.quote.length).toBeGreaterThan(0)
    expectBlockTail(firstText, added.fragment!.quote)
    expectBlockHead(lastText, added.endFragment!.quote)

    expect(preview.errors()).toEqual([])
  })

  /*
   * KNOWN PRODUCT DEFECT — this test is expected to FAIL until previewPanel.ts is fixed.
   *
   * `spanCommentPayload` ends the first block's tail range at
   * `setEnd(firstBlock, firstBlock.childNodes.length)` (previewPanel.ts:869). The gutter
   * control `.bctl` is a DOM CHILD of the block (appended by `drawBlockControls`), and its
   * `.cmt-count` badge carries the comment count as real text whenever the block already
   * has more than one comment. So the range runs past the prose and swallows the badge:
   * commenting on a span that starts at a block with 3 comments stores the quote
   * "…ending here.3" instead of "…ending here".
   *
   * Everywhere else in the file this is handled — `findTextRange` (1172) and
   * `wholeBlockRange` (1217) both skip `.bctl` on purpose. Only the span payload does not.
   *
   * What breaks: the stored anchor is not what the user selected (README: "the comment
   * highlights exactly what you selected"), and because the painter searches with
   * `findTextRange`, which DOES skip `.bctl`, the quote can never be found again — the
   * first block's tail highlight promised by req 10.17 silently never paints. The thread
   * itself survives (`resolveSpan` re-matches both ends at BLOCK level and ignores the
   * fragment text), so this is corruption of the anchor and the highlight, not data loss.
   *
   * The differential is exact: this is the same document and the same selection as the
   * first test in this block. The only thing added is a pre-existing comment count.
   */
  it('keeps the gutter count badge out of the span quote', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SPAN_DOC)
    // Block 2 already carries 3 comments, so its marker renders the badge text "3".
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 2, count: 3 }] })
    expect(await preview.text('[data-paragraph-index="2"] .cmt-count')).toBe('3')

    await preview.selectChars('[data-paragraph-index="2"]', 30, '[data-paragraph-index="4"]', 10)
    await preview.click('#sel-comment')
    await preview.waitForPost('requestCommentThread')
    await preview.typeInto('#comment-input', 'Span note')
    await preview.clearPosted()
    await preview.click('#comment-add')

    const added = await preview.waitForPost('addComment')
    // Identical selection to the first test ⇒ identical quote. The badge is chrome the
    // webview injected into the block; the user never selected it.
    expect(added.fragment!.quote).toBe('tail ending here')
    // And the quote must live in the block's own prose, because that is where the
    // fragment painter (which skips the gutter) will look for it.
    const prose = await preview.page.evaluate(() => {
      const block = document.querySelector('[data-paragraph-index="2"]')!.cloneNode(true) as HTMLElement
      block.querySelector('.bctl')?.remove()
      return block.textContent ?? ''
    })
    expect(prose.includes(added.fragment!.quote)).toBe(true)

    expect(preview.errors()).toEqual([])
  })

  it('omits the span fields entirely for a selection inside one block', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SPAN_DOC)

    const selected = await preview.dragSelect('[data-paragraph-index="1"]', '[data-paragraph-index="1"]', {
      fromFraction: 0.2,
      toFraction: 0.8,
    })
    expect(selected.length).toBeGreaterThan(0)
    expect(await toolbarRange(preview)).toEqual({ firstIndex: '1', lastIndex: '1' })

    await preview.click('#sel-comment')
    await preview.waitForPost('requestCommentThread')
    await preview.typeInto('#comment-input', 'Single block note')
    await preview.clearPosted()
    await preview.click('#comment-add')

    const added = await preview.waitForPost('addComment')
    expect(added.paragraphIndex).toBe(1)
    // Absence, not `undefined`: the host branches on the property being there at all.
    expect('endIndex' in added).toBe(false)
    expect('endFragment' in added).toBe(false)
    expect(added.fragment!.quote.length).toBeGreaterThan(0)
    // Trimmed of edge whitespace and edge punctuation (req 10.12).
    expect(added.fragment!.quote).toBe(added.fragment!.quote.trim())

    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E6 — the `translated` flag on a fragment captured over a translated view
// ---------------------------------------------------------------------------

// Feature: target-language fragment anchors (FragmentAnchor.translated), Scenario E6.
describe('E6 translated-fragment flag', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('flags a quote captured over the single translated view', async () => {
    preview = await openPreview()
    // Before any translation: a later targetLang change would drop the cached one.
    await preview.configure()
    const source = await preview.render(STORAGE_DOC)
    const translated = await preview.render(TARGET_DOC)
    // Put the source back as the cached source, then hand the translation over as the
    // host does — that is what switches `displaying` to 'translation'.
    await preview.renderHtml(source.html, source.lineMap)
    await preview.send({ type: 'translationComplete', translatedHtml: translated.html })
    expect(await preview.text('[data-paragraph-index="1"]')).toBe(TARGET_BLOCK_1)

    const quote = 'translated wording'
    const at = TARGET_BLOCK_1.indexOf(quote)
    const block = '[data-paragraph-index="1"]'
    expect(await preview.selectChars(block, at, block, at + quote.length)).toBe(quote)

    await preview.click('#sel-comment')
    await preview.waitForPost('requestCommentThread')
    await preview.typeInto('#comment-input', 'On the translation')
    await preview.clearPosted()
    await preview.click('#comment-add')

    const added = await preview.waitForPost('addComment')
    expect(added.paragraphIndex).toBe(1)
    expect(added.fragment!.quote).toBe(quote)
    // Without this the host would look for a Russian quote in the English source, miss,
    // and orphan the comment.
    expect(added.fragment!.translated).toBe(true)
    expectContextAround(TARGET_BLOCK_1, added.fragment!)

    expect(preview.errors()).toEqual([])
  })

  it('flags by hovered PANE in bilingual view, not by display mode', async () => {
    preview = await openPreview()
    await preview.configure()
    const source = await preview.render(STORAGE_DOC)
    const translated = await preview.render(TARGET_DOC)
    await preview.renderHtml(source.html, source.lineMap)
    await preview.send({ type: 'translationComplete', translatedHtml: translated.html })

    await preview.click('#bilingual-btn')
    expect(await preview.classList('#content')).toContain('bilingual')
    expect(await preview.text('.bcell-l [data-paragraph-index="1"]')).toBe(STORAGE_BLOCK_1)
    expect(await preview.text('.bcell-r [data-paragraph-index="1"]')).toBe(TARGET_BLOCK_1)

    // LEFT (storage) cell — the quote IS source text, so the flag must stay off even
    // though a translation is on screen.
    const leftQuote = 'original wording'
    const leftAt = STORAGE_BLOCK_1.indexOf(leftQuote)
    expect(
      await preview.selectChars(
        '.bcell-l [data-paragraph-index="1"]',
        leftAt,
        '.bcell-l [data-paragraph-index="1"]',
        leftAt + leftQuote.length,
      ),
    ).toBe(leftQuote)
    await preview.click('#sel-comment')
    await preview.waitForPost('requestCommentThread')
    await preview.typeInto('#comment-input', 'Left cell note')
    await preview.clearPosted()
    await preview.click('#comment-add')
    const fromLeft = await preview.waitForPost('addComment')
    expect(fromLeft.fragment!.quote).toBe(leftQuote)
    expect('translated' in fromLeft.fragment!).toBe(false)

    // The modal is a full-viewport overlay; the next selection needs the content back.
    await preview.click('#comment-close')
    expect(await preview.hidden('#comment-modal')).toBe(true)

    // RIGHT (translation) cell — same row, same index, target-language quote.
    const rightQuote = 'translated wording'
    const rightAt = TARGET_BLOCK_1.indexOf(rightQuote)
    expect(
      await preview.selectChars(
        '.bcell-r [data-paragraph-index="1"]',
        rightAt,
        '.bcell-r [data-paragraph-index="1"]',
        rightAt + rightQuote.length,
      ),
    ).toBe(rightQuote)
    await preview.click('#sel-comment')
    await preview.typeInto('#comment-input', 'Right cell note')
    await preview.clearPosted()
    await preview.click('#comment-add')
    const fromRight = await preview.waitForPost('addComment')
    expect(fromRight.fragment!.quote).toBe(rightQuote)
    expect(fromRight.fragment!.translated).toBe(true)

    // Both cells of one row are the same block: a comment made on either lands on the
    // same thread key.
    expect(fromRight.paragraphIndex).toBe(fromLeft.paragraphIndex)
    expect(fromLeft.paragraphIndex).toBe(1)

    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E13 — fragment highlights painted from `commentsForBlocks`
// ---------------------------------------------------------------------------

// Feature: commented-fragment highlighting (req 10.12 / 10.17), Scenario E13.
describe('E13 comment fragment highlights', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('paints one range per resolvable quote, whole blocks for span middles, and nothing else', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(FRAGMENT_DOC)

    await preview.send({
      type: 'commentsForBlocks',
      blocks: [
        { paragraphIndex: 1, count: 1, fragments: ['single quoted fragment'] },
        { paragraphIndex: 2, count: 3, fragments: ['two distinct', 'quoted fragments here'] },
        // A block wholly inside a multi-block span: highlighted entire, no marker (req 10.17).
        { paragraphIndex: 3, count: 0, whole: true },
        // A quote whose text is gone from the block — the host has not orphaned it yet.
        { paragraphIndex: 4, count: 1, fragments: ['not present in the document'] },
        // Span middle that ALSO carries its own comments: the marker shows "2", and the
        // whole-block range must not swallow that badge (CommentsService.snapshot can
        // emit exactly this combination).
        { paragraphIndex: 5, count: 2, whole: true },
        // A block index the document does not have at all.
        { paragraphIndex: 9, count: 1, fragments: ['also absent'] },
      ],
    })

    const painted = await preview.highlight('comment-fragments')
    expect(painted).not.toBeNull()
    expect(painted!.ranges.map((r) => r.text)).toEqual([
      'single quoted fragment',
      'two distinct',
      'quoted fragments here',
      FRAGMENT_BLOCK_3,
      FRAGMENT_BLOCK_5,
    ])
    expect(painted!.ranges.map((r) => r.blockIndex)).toEqual([1, 2, 2, 3, 5])
    expect(painted!.size).toBe(5)
    expect(painted!.ranges.every((r) => r.connected)).toBe(true)
    // The gutter control is a DOM child of the block, so a naive whole-block range would
    // swallow the marker's count badge and quote "…own notes.2" back to the host.
    expect(painted!.ranges.every((r) => r.inBctl)).toBe(false)
    // Resting highlight: the active-fragment paint (priority 2) must be able to win.
    expect(painted!.priority).toBe(0)

    // Markers: a span middle carries none of its own; a block with >1 comment shows the count.
    expect(await preview.classList('[data-paragraph-index="1"] .bctl-comment')).toContain('has')
    expect(await preview.text('[data-paragraph-index="1"] .cmt-count')).toBe('')
    expect(await preview.classList('[data-paragraph-index="2"] .bctl-comment')).toContain('has')
    expect(await preview.text('[data-paragraph-index="2"] .cmt-count')).toBe('3')
    expect(await preview.classList('[data-paragraph-index="3"] .bctl-comment')).not.toContain('has')
    expect(await preview.text('[data-paragraph-index="3"] .cmt-count')).toBe('')
    expect(await preview.classList('[data-paragraph-index="5"] .bctl-comment')).toContain('has')
    expect(await preview.text('[data-paragraph-index="5"] .cmt-count')).toBe('2')
    expect(await preview.classList('[data-paragraph-index="6"] .bctl-comment')).not.toContain('has')

    expect(preview.errors()).toEqual([])
  })

  it('repaints the same ranges against the rebuilt DOM after a re-render', async () => {
    preview = await openPreview()
    await preview.configure()
    const { html, lineMap } = await preview.render(FRAGMENT_DOC)
    await preview.send({
      type: 'commentsForBlocks',
      blocks: [
        { paragraphIndex: 2, count: 3, fragments: ['two distinct', 'quoted fragments here'] },
        { paragraphIndex: 3, count: 0, whole: true },
      ],
    })
    const before = await preview.highlight('comment-fragments')
    expect(before!.ranges.map((r) => r.text)).toEqual(['two distinct', 'quoted fragments here', FRAGMENT_BLOCK_3])

    await preview.clearPosted()
    await preview.renderHtml(html, lineMap)

    const after = await preview.highlight('comment-fragments')
    expect(after!.ranges.map((r) => r.text)).toEqual(before!.ranges.map((r) => r.text))
    // A stale Range keeps a non-zero size while painting nothing — the size alone is
    // not evidence that the repaint happened.
    expect(after!.ranges.every((r) => r.connected)).toBe(true)
    // The rebuilt DOM lost its markers, so fresh comment data has to be pulled.
    expect((await preview.posted()).some((m) => m.type === 'requestComments')).toBe(true)

    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E14 — the group popover
// ---------------------------------------------------------------------------

// Feature: per-fragment thread popover (req 10.13), Scenario E14.
describe('E14 group popover', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('lists one row per thread, highlights the hovered fragment on top, and routes the click', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(POPOVER_DOC)
    await preview.send({
      type: 'commentsForBlocks',
      blocks: [{ paragraphIndex: 2, count: 4, fragments: ['alpha quote', 'beta quote'] }],
    })

    // Hovering the marker asks the host for the block's threads (req 11.6).
    await preview.clearPosted()
    await preview.hover('[data-paragraph-index="2"] .bctl-comment')
    expect(await preview.waitForPost('requestCommentThread')).toEqual({
      type: 'requestCommentThread',
      paragraphIndex: 2,
    })

    await preview.send({
      type: 'commentThread',
      paragraphIndex: 2,
      comments: [comment('c1', 'one'), comment('c2', 'two'), comment('c3', 'three'), comment('c4', 'four')],
      threads: [
        { fragment: 'alpha quote', comments: [comment('c1', 'one')] },
        { fragment: 'beta quote', comments: [comment('c2', 'two'), comment('c3', 'three')] },
        { comments: [comment('c4', 'four')] },
      ],
    })

    expect(await preview.css('#tooltip', 'display')).not.toBe('none')
    expect(await preview.count('.cmt-prow')).toBe(3)
    const rows = await preview.page.evaluate(() =>
      Array.from(document.querySelectorAll('.cmt-prow')).map((el) => el.textContent ?? ''),
    )
    // Typographic quotes, and the fragment-less thread reads as the whole block.
    expect(rows).toEqual(['“alpha quote” · 1', '“beta quote” · 2', 'Whole block · 1'])

    // Hovering a row highlights EXACTLY that fragment, above the resting tint.
    await preview.hover('.cmt-prow:nth-child(1)')
    const active = await preview.highlight('comment-fragment-active')
    expect(active).not.toBeNull()
    expect(active!.size).toBe(1)
    expect(active!.ranges[0].text).toBe('alpha quote')
    expect(active!.ranges[0].blockIndex).toBe(2)
    // Priority is a paint-order property with no DOM shadow: inverted, the strong paint
    // would sit UNDER the resting one and the row hover would look dead.
    expect(active!.priority).toBe(2)
    const resting = await preview.highlight('comment-fragments')
    expect(resting!.size).toBe(2)
    expect(resting!.priority).toBe(0)

    // Leaving the row (but staying inside the popover, so it is not dismissed) clears it.
    const tip = (await preview.rect('#tooltip'))!
    await preview.moveMouse(tip.left + 3, tip.top + 3)
    expect(await preview.highlight('comment-fragment-active')).toBeNull()

    // Clicking a row opens THAT thread — not the block's comments flattened.
    await preview.clearPosted()
    await preview.click('.cmt-prow:nth-child(2)')
    expect(await preview.css('#tooltip', 'display')).toBe('none')
    expect(await preview.hidden('#comment-modal')).toBe(false)
    expect(await preview.waitForPost('requestCommentThread')).toEqual({
      type: 'requestCommentThread',
      paragraphIndex: 2,
    })
    expect(await preview.highlight('comment-fragment-active')).toBeNull()

    await preview.typeInto('#comment-input', 'Reply on beta')
    await preview.clearPosted()
    await preview.click('#comment-add')
    const added = await preview.waitForPost('addComment')
    expect(added.paragraphIndex).toBe(2)
    expect(added.body).toBe('Reply on beta')
    // The row carries the quote only — the host re-resolves prefix/suffix — and it is a
    // fragment thread, never the whole-block one.
    expect(added.fragment).toEqual({ quote: 'beta quote', prefix: '', suffix: '' })
    expect('endIndex' in added).toBe(false)

    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E16 — comments disabled makes the marker unreachable
// ---------------------------------------------------------------------------

// Feature: commentsEnabled setting (req 11.13), Scenario E16.
describe('E16 comments disabled', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  const MARKER = '[data-paragraph-index="1"] .bctl-comment'

  it('hides the marker from the hit test and the toolbar, and restores both live', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(TOGGLE_DOC)
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 1, count: 1 }] })

    const centre = await preview.centerOf(MARKER)

    // POSITIVE CONTROL. "Nothing was posted" is also what a broken listener produces, so
    // the reachable case has to be proven in this same test.
    expect(await preview.css(MARKER, 'display')).not.toBe('none')
    expect((await preview.hitTest(centre.x, centre.y))?.inButton).toBe(true)
    await preview.clearPosted()
    await preview.clickAt(centre.x, centre.y)
    expect(await preview.waitForPost('requestCommentThread')).toEqual({
      type: 'requestCommentThread',
      paragraphIndex: 1,
    })
    expect(await preview.hidden('#comment-modal')).toBe(false)
    await preview.click('#comment-close')

    expect(await preview.selectChars('[data-paragraph-index="2"]', 0, '[data-paragraph-index="2"]', 5)).toBe('Beta ')
    expect(await preview.hidden('#sel-toolbar')).toBe(false)
    expect(await preview.hidden('#sel-comment')).toBe(false)

    // Stamp the live marker so a re-render — which would rebuild every block — is
    // detectable: req 11.13 promises the toggle takes effect at once, with no reopen.
    await preview.page.evaluate((sel) => {
      document.querySelector(sel)!.setAttribute('data-e2e-stamp', 'original')
    }, MARKER)

    await preview.clearPosted()
    await preview.configure({ commentsEnabled: false })

    expect(await preview.classList('#content')).toContain('comments-off')
    expect(await preview.css(MARKER, 'display')).toBe('none')
    // Unreachable, not merely invisible: the pointer lands on the gutter bridge instead.
    const covered = await preview.hitTest(centre.x, centre.y)
    expect(covered?.inButton).toBe(false)
    expect(covered?.inBctl).toBe(true)

    await preview.clickAt(centre.x, centre.y)
    await preview.frames(2)
    expect((await preview.posted()).filter((m) => m.type === 'requestCommentThread')).toEqual([])
    expect(await preview.hidden('#comment-modal')).toBe(true)

    // And no new comment can be started from a selection either.
    expect(await preview.selectChars('[data-paragraph-index="2"]', 0, '[data-paragraph-index="2"]', 5)).toBe('Beta ')
    expect(await preview.hidden('#sel-toolbar')).toBe(false)
    expect(await preview.hidden('#sel-comment')).toBe(true)
    // The pencil is explicitly untouched by this setting.
    expect(await preview.hidden('#sel-edit')).toBe(false)

    // Flip back: live, with no re-render in between.
    await preview.configure({ commentsEnabled: true })
    expect(await preview.classList('#content')).not.toContain('comments-off')
    const stamp = await preview.page.evaluate(
      (sel) => document.querySelector(sel)!.getAttribute('data-e2e-stamp'),
      MARKER,
    )
    expect(stamp).toBe('original')
    expect((await preview.posted()).filter((m) => m.type === 'requestComments')).toEqual([])

    expect(await preview.css(MARKER, 'display')).not.toBe('none')
    expect((await preview.hitTest(centre.x, centre.y))?.inButton).toBe(true)
    await preview.clearPosted()
    await preview.clickAt(centre.x, centre.y)
    expect(await preview.waitForPost('requestCommentThread')).toEqual({
      type: 'requestCommentThread',
      paragraphIndex: 1,
    })
    expect(await preview.hidden('#comment-modal')).toBe(false)

    expect(preview.errors()).toEqual([])
  })
})
