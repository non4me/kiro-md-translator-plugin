import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_VIEWPORT, MOD, closeBrowser, openPreview, renderMarkdown, type Preview } from './harness'

/*
 * Feature: in-document search (req 1.8), Scenarios E8–E12.
 *
 * The oracle for this file is req 1.8 + README + the 0.6.1–0.6.5 CHANGELOG entries,
 * which promise, in order:
 *
 *   - `Ctrl+F` / `Cmd+F` opens a webview-local find bar over the DISPLAYED text
 *     (both columns in bilingual view);
 *   - HIGHLIGHT: typing paints EVERY match at once and shows their number, without
 *     ever moving focus out of the input;
 *   - NAVIGATE: `Enter` / `Shift+Enter` (and ↓ / ↑) step through the matches,
 *     scrolling to the current one and painting it stronger, with an `i/N` counter;
 *   - `Esc` (and ✕) closes the bar; `No results` when nothing matches;
 *   - painting goes through the CSS Custom Highlight API — paint-only, so the ONLY
 *     observable is the `CSS.highlights` registry, never the DOM;
 *   - matches are recomputed whenever the shown content changes;
 *   - the whole feature is webview-local: no host↔webview messages at all.
 *
 * Every count below is read off the fixture by hand, not recomputed with the
 * algorithm under test — an oracle derived from the code could not catch the code.
 */

/** 4 case-varied `the` (2 blocks), an `aaaa` overlap trap, and a Cyrillic sentence
 *  whose case differs between its two occurrences. Each block renders as exactly one
 *  text node, so every expected offset below is an offset into the block's own text. */
const DOC = [
  '# Theme heading',
  '',
  'The quick fox; the lazy dog; THE end.',
  '',
  'Sequence aaaa here.',
  '',
  'Кириллица: ЭТО пример. И это тоже.',
  '',
].join('\n')

/** `the`, case-insensitively, in DOC — in document order, in the SOURCE casing. */
const THE_MATCHES = ['The', 'The', 'the', 'THE']
const THE_BLOCKS = [0, 1, 1, 1]

/** 3 × `note`: `Note` in the heading, two in the paragraph ("another" is NOT one). */
const SRC_V1 = ['# Note heading', '', 'A note here and another note follows.', ''].join('\n')
/** 5 × `note`: one in `Notes`, four in the paragraph. */
const TRANSLATED_V1 = ['# Notes', '', 'Note alpha. Note beta. Note gamma. note delta.', ''].join('\n')
/** 1 × `note`. Same block structure so it can replace SRC_V1 in place. */
const SRC_V2 = ['# Different', '', 'Only one note remains.', ''].join('\n')

/** Tall enough that its single `needle` starts well below the fold. */
const LONG_DOC = [
  '# Long document',
  '',
  ...Array.from({ length: 40 }, (_, i) => [`Filler paragraph number ${i} with enough words to fill a line.`, '']).flat(),
  'The last paragraph holds the needle.',
  '',
].join('\n')

interface KeyRecord {
  phase: 'capture' | 'bubble'
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  defaultPrevented: boolean
}

declare global {
  interface Window {
    __keys: KeyRecord[]
  }
}

/**
 * Two probes around the bundle's own keydown handling.
 *
 * The CAPTURE probe (on `window`, so it runs before anything the bundle registers on
 * `document`) records the raw event. It is the positive control for the E8 mechanism:
 * without it, a harness that quietly delivered `key:'f'` would let the layout scenario
 * pass against the exact bug it exists to catch.
 *
 * The BUBBLE probe runs last — and not at all when a handler consumed the event with
 * `stopPropagation`. That absence is how "Esc was taken by the topmost layer" is
 * observed, and its presence with `defaultPrevented === false` is how "Esc kept its
 * default meaning because nothing was open" is observed.
 */
async function installKeyProbe(preview: Preview): Promise<void> {
  await preview.page.evaluate(() => {
    window.__keys = []
    const record = (phase: 'capture' | 'bubble') => (e: KeyboardEvent) => {
      window.__keys.push({
        phase,
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        defaultPrevented: e.defaultPrevented,
      })
    }
    window.addEventListener('keydown', record('capture'), true)
    window.addEventListener('keydown', record('bubble'))
  })
}

async function keyRecords(preview: Preview): Promise<KeyRecord[]> {
  return preview.page.evaluate(() => window.__keys)
}

async function clearKeyRecords(preview: Preview): Promise<void> {
  await preview.page.evaluate(() => {
    window.__keys.length = 0
  })
}

/** Ctrl+F the way an ordinary Latin layout produces it. E8 owns the layout claim. */
async function openFind(preview: Preview): Promise<void> {
  await preview.key('KeyF', 'f', MOD.ctrl)
}

async function activeId(preview: Preview): Promise<string> {
  return preview.page.evaluate(() => document.activeElement?.id ?? '')
}

async function findInputState(
  preview: Preview,
): Promise<{ value: string; start: number | null; end: number | null; focused: boolean }> {
  return preview.page.evaluate(() => {
    const el = document.getElementById('find-input') as HTMLInputElement
    return {
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
      focused: document.activeElement === el,
    }
  })
}

/** Empty the query the way a user does — the bar keeps its value when it closes, so
 *  there is no reset message to send. */
async function eraseQuery(preview: Preview, chars: number): Promise<void> {
  for (let i = 0; i < chars; i++) await preview.press('Backspace')
}

let preview: Preview | undefined

afterEach(async () => {
  await preview?.close()
  preview = undefined
})
afterAll(closeBrowser)

// ---------------------------------------------------------------------------

describe('E8 Ctrl+F matches the physical key', () => {
  it('opens on a Cyrillic layout, ignores Ctrl+Alt+F, opens for Cmd+F, and never talks to the host', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await installKeyProbe(preview)
    await preview.clearPosted()

    // A Cyrillic layout reports the physical F key as `а`. v0.6.4 shipped a handler
    // that tested `e.key`, so the shortcut silently never fired for those users.
    await preview.key('KeyF', 'а', MOD.ctrl)

    // Control for the mechanism: prove the event really carried the mismatched pair.
    // A harness that filled `key` from a US keymap would pass against the old bug.
    const raw = (await keyRecords(preview)).find((e) => e.phase === 'capture')
    expect(raw).toMatchObject({ key: 'а', code: 'KeyF', ctrlKey: true, altKey: false })

    expect(await preview.hidden('#find-bar')).toBe(false)
    expect(await activeId(preview)).toBe('find-input')

    // A query typed now must land in the input, not in the document.
    await preview.typeText('the')
    expect(await preview.text('#find-status')).toBe(`${THE_MATCHES.length} found`)

    await preview.press('Escape')
    expect(await preview.hidden('#find-bar')).toBe(true)

    // Reopening offers the previous query, preselected, so the next keystroke
    // replaces it instead of appending to it.
    await preview.key('KeyF', 'а', MOD.ctrl)
    expect(await findInputState(preview)).toEqual({ value: 'the', start: 0, end: 3, focused: true })

    // AltGr is Ctrl+Alt on a Windows layout and produces characters, so it must not
    // be the find shortcut.
    await preview.press('Escape')
    await clearKeyRecords(preview)
    await preview.key('KeyF', 'а', MOD.ctrl | MOD.alt)
    const withAlt = (await keyRecords(preview)).find((e) => e.phase === 'capture')
    expect(withAlt).toMatchObject({ code: 'KeyF', ctrlKey: true, altKey: true })
    expect(await preview.hidden('#find-bar')).toBe(true)

    // Cmd+F — the macOS spelling of the same shortcut.
    await preview.key('KeyF', 'а', MOD.meta)
    expect(await preview.hidden('#find-bar')).toBe(false)
    expect(await activeId(preview)).toBe('find-input')

    // Find is webview-local: opening, typing and closing produce no host traffic.
    expect(await preview.posted()).toEqual([])
    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('E9 find highlighting', () => {
  it('paints one range per case-insensitive match, in the source casing, never overlapping', async () => {
    preview = await openPreview()
    const { html } = await preview.render(DOC)
    expect(html).toContain('data-paragraph-index="3"') // the fixture really rendered
    await preview.clearPosted()

    await openFind(preview)

    // An empty query paints nothing and claims nothing.
    expect(await preview.text('#find-status')).toBe('')
    expect(await preview.highlight('find-matches')).toBeNull()

    await preview.typeText('the')
    const matches = await preview.highlight('find-matches')
    expect(matches).not.toBeNull()
    expect(matches!.size).toBe(THE_MATCHES.length)
    // The needle is lowercased; the RANGES must point at the real text, so each one
    // reads back in the casing the document uses.
    expect(matches!.ranges.map((r) => r.text)).toEqual(THE_MATCHES)
    expect(matches!.ranges.map((r) => r.blockIndex)).toEqual(THE_BLOCKS)
    expect(matches!.ranges.every((r) => r.connected)).toBe(true)
    expect(matches!.ranges.every((r) => !r.inBctl)).toBe(true)
    expect(await preview.text('#find-status')).toBe('4 found')

    // `aa` in `aaaa` is 2 matches, not 3: a match starts after the previous one ends.
    await eraseQuery(preview, 3)
    await preview.typeText('aa')
    const overlap = await preview.highlight('find-matches')
    expect(overlap!.size).toBe(2)
    expect(overlap!.ranges.map((r) => r.text)).toEqual(['aa', 'aa'])
    expect(overlap!.ranges.map((r) => r.startOffset)).toEqual([9, 11])
    expect(overlap!.ranges.map((r) => r.blockIndex)).toEqual([2, 2])
    expect(await preview.text('#find-status')).toBe('2 found')

    // Case folding is not an ASCII-only affair.
    await eraseQuery(preview, 2)
    await preview.typeText('это')
    const cyrillic = await preview.highlight('find-matches')
    expect(cyrillic!.size).toBe(2)
    expect(cyrillic!.ranges.map((r) => r.text)).toEqual(['ЭТО', 'это'])
    expect(cyrillic!.ranges.map((r) => r.blockIndex)).toEqual([3, 3])
    expect(await preview.text('#find-status')).toBe('2 found')

    // A miss says so, and leaves nothing painted.
    await eraseQuery(preview, 3)
    await preview.typeText('zzz')
    expect(await preview.highlight('find-matches')).toBeNull()
    expect(await preview.text('#find-status')).toBe('No results')

    // Back to empty: the count disappears rather than reading `0 found`.
    await eraseQuery(preview, 3)
    expect(await preview.text('#find-status')).toBe('')
    expect(await preview.highlight('find-matches')).toBeNull()

    expect(await preview.posted()).toEqual([])
    expect(preview.errors()).toEqual([])
  })

  it('keeps the find input focused through every keystroke', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await openFind(preview)

    // req 1.8(a): the highlight process must never move focus out of the input, or
    // typing is aborted mid-query — the concrete regression `window.find` caused.
    for (const ch of 'the') {
      await preview.typeText(ch)
      expect(await activeId(preview)).toBe('find-input')
    }
    expect(await findInputState(preview)).toMatchObject({ value: 'the', focused: true })
    expect(await preview.text('#find-status')).toBe('4 found')
    expect(preview.errors()).toEqual([])
  })

  // req 1.8 scopes the search to the document's DISPLAYED TEXT, and makes `i/N` a
  // promise about that text — a 9px count bubble in the gutter is chrome, not
  // content. `highlightMatches` used to walk all of `#content`, which includes the
  // gutter control appended inside every block, so the badge digit was searchable.
  it('does not count the gutter comment-count badge as document text', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await preview.send({ type: 'commentsForBlocks', blocks: [{ paragraphIndex: 1, count: 7 }] })
    await preview.drain()
    // Precondition: the badge really does read '7', or the test proves nothing.
    expect(await preview.text('[data-paragraph-index="1"] .cmt-count')).toBe('7')

    await openFind(preview)
    await preview.typeText('7')
    expect(await preview.text('#find-status')).toBe('No results')
    expect(await preview.highlight('find-matches')).toBeNull()
    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('E10 find navigation', () => {
  it('steps with Enter / Shift+Enter, wraps both ways, and leaves the match set alone', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await preview.clearPosted()
    await openFind(preview)
    await preview.typeText('the')

    const all = await preview.highlight('find-matches')
    expect(all!.size).toBe(4)
    expect(all!.priority).toBe(0)
    expect(await preview.text('#find-status')).toBe('4 found')
    // Highlighting and navigating are independent: nothing is "current" until asked.
    expect(await preview.highlight('find-current')).toBeNull()

    await preview.press('Enter')
    const first = await preview.highlight('find-current')
    expect(first!.size).toBe(1)
    // The current match must win the paint wherever it overlaps the resting one.
    expect(first!.priority).toBe(1)
    expect(first!.ranges[0]).toMatchObject({
      text: all!.ranges[0].text,
      blockIndex: all!.ranges[0].blockIndex,
      startOffset: all!.ranges[0].startOffset,
    })
    expect(await preview.text('#find-status')).toBe('1/4')
    expect(await activeId(preview)).toBe('find-input')

    for (const expected of ['2/4', '3/4', '4/4']) {
      await preview.press('Enter')
      expect(await preview.text('#find-status')).toBe(expected)
      expect(await activeId(preview)).toBe('find-input')
    }
    const last = await preview.highlight('find-current')
    expect(last!.ranges[0]).toMatchObject({ text: 'THE', blockIndex: 1 })

    // Past the end, back to the beginning.
    await preview.press('Enter')
    expect(await preview.text('#find-status')).toBe('1/4')
    // And backwards past the beginning, back to the end.
    await preview.press('Enter', { shift: true })
    expect(await preview.text('#find-status')).toBe('4/4')
    expect((await preview.highlight('find-current'))!.ranges[0].text).toBe('THE')

    // Navigation is a cursor move — the painted match set is untouched by it.
    const after = await preview.highlight('find-matches')
    expect(after!.size).toBe(4)
    expect(after!.ranges.map((r) => r.text)).toEqual(THE_MATCHES)
    expect(after!.ranges.every((r) => r.connected)).toBe(true)

    // Every match here is already on screen, so nothing scrolled: find itself is
    // webview-local and must not have said a word to the host.
    expect(await preview.posted()).toEqual([])
    expect(preview.errors()).toEqual([])
  })

  it('steps with the ↓ / ↑ buttons without letting focus escape the bar', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await openFind(preview)
    await preview.typeText('the')

    await preview.click('#find-next')
    expect(await preview.text('#find-status')).toBe('1/4')
    await preview.click('#find-next')
    expect(await preview.text('#find-status')).toBe('2/4')
    await preview.click('#find-prev')
    expect(await preview.text('#find-status')).toBe('1/4')
    expect((await preview.highlight('find-current'))!.ranges[0]).toMatchObject({ text: 'The', blockIndex: 0 })

    // The pre-0.6.3 implementation moved focus INTO the matched content, which is
    // what aborted typing. Wherever the pointer puts it, focus stays in the bar.
    const inBar = await preview.page.evaluate(() => document.activeElement?.closest('#find-bar') !== null)
    expect(inBar).toBe(true)
    expect(preview.errors()).toEqual([])
  })

  it('starts from the LAST match when the first navigation is Shift+Enter', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await openFind(preview)
    await preview.typeText('the')

    // A freshly opened bar has no cursor yet; stepping backwards from there must
    // land on the last match, not refuse to move.
    await preview.press('Escape')
    await openFind(preview)
    expect(await preview.text('#find-status')).toBe('4 found')

    await preview.press('Enter', { shift: true })
    expect(await preview.text('#find-status')).toBe('4/4')
    expect((await preview.highlight('find-current'))!.ranges[0]).toMatchObject({ text: 'THE', blockIndex: 1 })
    expect(await activeId(preview)).toBe('find-input')
    expect(preview.errors()).toEqual([])
  })

  it('scrolls a match that is below the fold into view', async () => {
    preview = await openPreview()
    await preview.render(LONG_DOC)
    await openFind(preview)
    await preview.typeText('needle')

    expect(await preview.text('#find-status')).toBe('1 found')
    const before = await preview.highlight('find-matches')
    expect(before!.size).toBe(1)
    // Positive control for the scroll assertion below: it really is off screen now.
    expect(before!.ranges[0].rect.top).toBeGreaterThan(DEFAULT_VIEWPORT.height)

    await preview.press('Enter')
    expect(await preview.text('#find-status')).toBe('1/1')

    // req 1.8(b): navigating reveals the current match. Waited on as a condition —
    // the scroll is animated, so a fixed pause would either race it or be a sleep.
    await preview.page.waitForFunction(
      () => {
        const registry = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights
        const entry = registry?.get('find-current')
        if (!entry) return false
        const [range] = Array.from(entry)
        if (!range) return false
        const rect = range.getBoundingClientRect()
        return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
      },
      { timeout: 10_000 },
    )
    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('E11 find survives a content re-render', () => {
  it('recomputes against the new DOM on a translation swap and on a fresh source', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SRC_V1)
    await openFind(preview)
    await preview.typeText('note')

    const v1 = await preview.highlight('find-matches')
    expect(v1!.size).toBe(3)
    expect(v1!.ranges.map((r) => r.text)).toEqual(['Note', 'note', 'note'])
    expect(await preview.text('#find-status')).toBe('3 found')

    // Give the bar a current match, so losing it is observable.
    await preview.press('Enter')
    expect(await preview.highlight('find-current')).not.toBeNull()

    const translated = await renderMarkdown(TRANSLATED_V1)
    await preview.send({ type: 'translationComplete', translatedHtml: translated.html })

    const shown = await preview.highlight('find-matches')
    expect(shown!.size).toBe(5)
    expect(shown!.ranges.map((r) => r.text)).toEqual(['Note', 'Note', 'Note', 'Note', 'note'])
    // A stale Range keeps a non-zero registry size while painting nothing, so the
    // count alone would not notice the failure this scenario exists for.
    expect(shown!.ranges.every((r) => r.connected)).toBe(true)
    expect(await preview.text('#find-status')).toBe('5 found')
    // The old "current" pointed into a DOM that no longer exists.
    expect(await preview.highlight('find-current')).toBeNull()

    await preview.render(SRC_V2)
    const v2 = await preview.highlight('find-matches')
    expect(v2!.size).toBe(1)
    expect(v2!.ranges[0]).toMatchObject({ text: 'note', connected: true, blockIndex: 1 })
    expect(await preview.text('#find-status')).toBe('1 found')

    expect(preview.errors()).toEqual([])
  })

  it('reopens against the content that is on screen now, not the one it was closed over', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SRC_V1)
    await openFind(preview)
    await preview.typeText('note')
    expect(await preview.text('#find-status')).toBe('3 found')

    await preview.press('Escape')
    expect(await preview.hidden('#find-bar')).toBe(true)
    expect(await preview.highlight('find-matches')).toBeNull()

    // The content changes while the bar is closed — nothing repaints until it opens.
    await preview.render(SRC_V2)
    expect(await preview.highlight('find-matches')).toBeNull()

    await openFind(preview)
    const reopened = await preview.highlight('find-matches')
    expect(reopened!.size).toBe(1)
    expect(reopened!.ranges[0]).toMatchObject({ text: 'note', connected: true })
    expect(await preview.text('#find-status')).toBe('1 found')
    expect(preview.errors()).toEqual([])
  })

  it('searches BOTH columns after entering bilingual view', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SRC_V1)
    const translated = await renderMarkdown(TRANSLATED_V1)
    await preview.send({ type: 'translationComplete', translatedHtml: translated.html })

    await openFind(preview)
    await preview.typeText('note')
    expect(await preview.text('#find-status')).toBe('5 found') // the translation alone

    await preview.click('#bilingual-btn')
    expect(await preview.classList('#content')).toContain('bilingual')

    // README: "Searches both columns in bilingual view." 3 in the source column plus
    // 5 in the translation column.
    const both = await preview.highlight('find-matches')
    expect(both!.size).toBe(8)
    expect(both!.ranges.every((r) => r.connected)).toBe(true)
    expect(await preview.text('#find-status')).toBe('8 found')

    const panes = await preview.page.evaluate(() => {
      const registry = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights
      const entry = registry?.get('find-matches')
      if (!entry) return []
      return Array.from(entry).map((r) => {
        const cell = r.startContainer.parentElement?.closest('.bcell')
        if (cell?.classList.contains('bcell-r')) return 'right'
        if (cell?.classList.contains('bcell-l')) return 'left'
        return 'none'
      })
    })
    expect(panes.filter((p) => p === 'left')).toHaveLength(3)
    expect(panes.filter((p) => p === 'right')).toHaveLength(5)
    expect(panes.filter((p) => p === 'none')).toHaveLength(0)

    expect(preview.errors()).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('E12 Esc dismisses the topmost layer only', () => {
  it('closes the edit modal first and the find bar underneath it second', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await installKeyProbe(preview)
    await openFind(preview)
    await preview.typeText('the')
    expect((await preview.highlight('find-matches'))!.size).toBe(4)

    await preview.send({
      type: 'openEditModal',
      paragraphIndex: 1,
      lastIndex: 1,
      storageText: 'The quick fox; the lazy dog; THE end.',
      targetText: 'перевод',
    })
    expect(await preview.hidden('#modal')).toBe(false)

    // Focus inside a textarea: the dismissal is a capture-phase document listener
    // precisely so it does not depend on which control holds focus.
    await preview.click('#modal-storage')
    expect(await activeId(preview)).toBe('modal-storage')

    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.hidden('#modal')).toBe(true)
    expect(await preview.posted()).toEqual([{ type: 'cancelParagraphEdit' }])
    // The layer UNDER the dialog must survive: one Esc, one layer.
    expect(await preview.hidden('#find-bar')).toBe(false)
    expect((await preview.highlight('find-matches'))!.size).toBe(4)

    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.hidden('#find-bar')).toBe(true)
    expect(await preview.highlight('find-matches')).toBeNull()
    expect(await preview.highlight('find-current')).toBeNull()
    expect(await activeId(preview)).not.toBe('find-input')
    expect(await preview.posted()).toEqual([])

    // Both Escapes were consumed by the handler, so neither reached the bubble phase.
    expect((await keyRecords(preview)).filter((e) => e.key === 'Escape' && e.phase === 'bubble')).toEqual([])
    expect(preview.errors()).toEqual([])
  })

  it('closes the find bar from a focused ↓ button', async () => {
    preview = await openPreview()
    await preview.render(DOC)
    await openFind(preview)
    await preview.typeText('the')

    // 0.6.5: Escape used to be handled on the input only, so once a click on ↓ moved
    // focus the key just shifted focus again instead of closing the bar.
    await preview.click('#find-next')
    expect(await activeId(preview)).not.toBe('find-input')

    await preview.press('Escape')
    expect(await preview.hidden('#find-bar')).toBe(true)
    expect(await preview.highlight('find-matches')).toBeNull()
    expect(await preview.text('#find-status')).toBe('')
    expect(preview.errors()).toEqual([])
  })

  it('cancels an in-progress comment edit before closing the comment modal', async () => {
    const thread = {
      comments: [
        { id: 'c1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', body: 'first note' },
        { id: 'c2', createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', body: 'second note' },
      ],
    }
    preview = await openPreview()
    await preview.configure()
    await preview.render(DOC)
    await installKeyProbe(preview)

    await preview.click('[data-paragraph-index="1"] > .bctl > .bctl-comment')
    expect(await preview.hidden('#comment-modal')).toBe(false)
    await preview.send({ type: 'commentThread', paragraphIndex: 1, comments: thread.comments, threads: [thread] })
    expect(await preview.count('#comment-list .cmt-item')).toBe(2)

    await preview.click('#comment-list .cmt-item .row button') // the first item's Edit
    expect(await preview.count('#comment-list textarea')).toBe(1)
    await preview.click('#comment-list textarea')

    await preview.clearPosted()
    await preview.press('Escape')
    // An in-progress edit is a layer of its own — throwing the whole modal away here
    // would silently discard the list the user was working in.
    expect(await preview.hidden('#comment-modal')).toBe(false)
    expect(await preview.posted()).toEqual([{ type: 'requestCommentThread', paragraphIndex: 1 }])

    // The host answers that refresh, which is what actually retires the editor.
    await preview.send({ type: 'commentThread', paragraphIndex: 1, comments: thread.comments, threads: [thread] })
    expect(await preview.count('#comment-list textarea')).toBe(0)
    expect(await preview.count('#comment-list .cmt-item')).toBe(2)

    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.hidden('#comment-modal')).toBe(true)
    expect(await preview.posted()).toEqual([])
    expect((await keyRecords(preview)).filter((e) => e.key === 'Escape' && e.phase === 'bubble')).toEqual([])
    expect(preview.errors()).toEqual([])
  })

  it('closes the assistant dialog above an open find bar, discarding its log', async () => {
    preview = await openPreview()
    await preview.configure({ aiAssistantEnabled: true })
    await preview.render(DOC)
    await openFind(preview)
    await preview.typeText('the')

    // Selecting in the content blurs the find input, which is what makes the toolbar
    // eligible at all — the bar stays open underneath.
    const selected = await preview.dragSelect('[data-paragraph-index="1"]')
    expect(selected.length).toBeGreaterThan(0)
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    await preview.clearPosted()
    await preview.click('#sel-ai')
    await preview.waitForPost('askAiOpen')
    expect(await preview.hidden('#assistant-modal')).toBe(false)

    await preview.send({ type: 'assistantOpen', selection: selected, commentCount: 0 })
    await preview.send({ type: 'assistantChunk', text: 'a streamed answer' })
    expect(await preview.count('#assistant-log .ai-msg')).toBe(1)

    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.posted()).toEqual([{ type: 'askAiClose' }])
    expect(await preview.hidden('#assistant-modal')).toBe(true)
    expect(await preview.count('#assistant-log .ai-msg')).toBe(0) // req 4.8: the log is discarded
    // Only the top layer went: the find bar is still there, still painted.
    expect(await preview.hidden('#find-bar')).toBe(false)
    expect((await preview.highlight('find-matches'))!.size).toBe(4)
    expect(preview.errors()).toEqual([])
  })

  it('dismisses the selection toolbar, then hands Esc back when nothing is open', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(DOC)
    await installKeyProbe(preview)

    const selected = await preview.dragSelect('[data-paragraph-index="1"]')
    expect(selected.length).toBeGreaterThan(0)
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    await preview.clearPosted()
    await preview.press('Escape')
    expect(await preview.hidden('#sel-toolbar')).toBe(true)
    expect(await preview.posted()).toEqual([])
    // Consumed: the toolbar was the topmost (and only) layer.
    expect((await keyRecords(preview)).filter((e) => e.key === 'Escape' && e.phase === 'bubble')).toEqual([])

    await clearKeyRecords(preview)
    await preview.press('Escape')
    // Nothing left to dismiss ⇒ Esc keeps its default meaning for everyone else.
    const escaped = (await keyRecords(preview)).filter((e) => e.key === 'Escape' && e.phase === 'bubble')
    expect(escaped).toHaveLength(1)
    expect(escaped[0].defaultPrevented).toBe(false)
    expect(await preview.posted()).toEqual([])
    expect(preview.errors()).toEqual([])
  })
})
