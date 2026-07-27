import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, codeThemeCss, openPreview, renderMarkdown, type PageIssue, type Preview } from './harness'

/*
 * The host <-> webview render contract, measured in a real browser.
 *
 * Every scenario in this file asserts something the product PROMISES and that no
 * amount of jsdom can observe: a CSS Grid pairing two languages row by row, a
 * dataset the native context menu reads instead of a message, a stylesheet swap
 * that must not touch the DOM, a re-render that must not steal the screen, and
 * markup from the host that must stay inert.
 *
 *  - E19 req 10.3/10.4/10.5/10.7 — the bilingual grid
 *  - E24 req 3.19               — data-vscode-context, no host round-trip
 *  - E25 req 12.4/12.5/12.6     — auto code theme follows the editor by CSS alone
 *  - E26 req 2.6/3.11           — renderContent display:false keeps the translation
 *  - E27 req 15.1               — host-supplied HTML is inert everywhere it lands
 */

// One page per test: the bundle keeps module-level state for the life of the
// document, so a reused page would make these order-dependent.
let preview: Preview | undefined

afterEach(async () => {
  await preview?.close()
  preview = undefined
})
afterAll(closeBrowser)

// --- fixtures ----------------------------------------------------------------

/* Four top-level blocks, so the bilingual grid has four unambiguous rows. Pair 1
 * is short on the left and long on the right, pair 2 the other way round: the
 * "row height = the taller side" claim is only worth measuring when the two sides
 * really do differ. The bold run in block 2 gives the pointer an element boundary
 * to cross WITHOUT leaving the block. */
const PAIR_SOURCE = [
  '# Bilingual source heading',
  '',
  'Terse.',
  '',
  'A source paragraph long enough to wrap over several lines inside a narrow bilingual column, with a **bold run** in the middle so a pointer can cross an element boundary without ever leaving the block, plus a tail of filler words that keeps this side comfortably taller than the translation sitting across from it in the very same grid row.',
  '',
  'A closing source paragraph of middling length.',
  '',
].join('\n')

const PAIR_TARGET = [
  '# Bilingual target heading',
  '',
  'A translated paragraph deliberately far longer than the two-word source it belongs to, so that this particular pair takes its height from the RIGHT column instead, and the grid still has to keep both tops flush with each other rather than letting the shorter side float.',
  '',
  'Brief.',
  '',
  'A closing target paragraph of middling length.',
  '',
].join('\n')

const SELECT_SOURCE = [
  '# Glossary candidates',
  '',
  'Kubernetes orchestrates containers across a cluster of machines.',
  '',
  'A second paragraph, so the pointer always has somewhere else to go.',
  '',
].join('\n')

const SELECT_TARGET = [
  '# Translated glossary candidates',
  '',
  'Translated sentence about orchestrating containers across machines.',
  '',
  'Translated second paragraph, matching the source block for block.',
  '',
].join('\n')

/** The first space inside SELECT_SOURCE's block 1 — the whitespace-only selection. */
const SPACE_AT = 'Kubernetes'.length

const CODE_DOC = [
  '# Highlighted code',
  '',
  'A paragraph before the fence.',
  '',
  '```js',
  'const answer = 42',
  'export function twice(n) {',
  '  return n * 2',
  '}',
  '```',
  '',
].join('\n')

const SOURCE_V1 = '# Versions\n\nAlpha source sentinel.\n'
const SOURCE_V2 = '# Versions\n\nBravo source sentinel.\n'
const TRANSLATION_V1 = '# Versions\n\nCharlie translated sentinel.\n'

/* Three ways host markup reaches the page, all through setSanitizedHtml. The
 * <script> and the inline onerror are the two shapes that would execute if the
 * fragment parser or the CSP ever stopped covering for us. */
const HOSTILE_CONTENT =
  '<p data-paragraph-index="0">Alpha paragraph with enough words to hover and to drag across.</p>' +
  '<script>window.__x1 = 1</script>' +
  '<img src="x" onerror="window.__x2 = 1">'
const HOSTILE_TOOLTIP = '<p>peek</p><script>window.__x3 = 1</script>'
const HOSTILE_REPLY = '<p>reply</p><script>window.__x4 = 1</script>'

// --- helpers -----------------------------------------------------------------

interface BlockProbe {
  classChanges: number
  mouseovers: number
}

/** Arm a measurement for "the pair highlight did not re-toggle": a class-attribute
 *  observer on every indexed block plus a mouseover counter. Without the counter,
 *  "zero class changes" is also what a pointer that never moved would report. */
async function watchBlocks(view: Preview): Promise<void> {
  await view.page.evaluate(() => {
    const w = window as unknown as { __blockProbe: BlockProbe }
    w.__blockProbe = { classChanges: 0, mouseovers: 0 }
    const observer = new MutationObserver((records) => {
      w.__blockProbe.classChanges += records.length
    })
    for (const el of Array.from(document.querySelectorAll('[data-paragraph-index]'))) {
      observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    }
    document.getElementById('content')?.addEventListener('mouseover', () => {
      w.__blockProbe.mouseovers += 1
    })
  })
}

async function readBlockProbe(view: Preview): Promise<BlockProbe> {
  return view.page.evaluate(() => (window as unknown as { __blockProbe: BlockProbe }).__blockProbe)
}

/** Arm a measurement for "no re-render happened". An innerHTML snapshot alone cannot
 *  tell a untouched DOM from one rebuilt with identical markup; a mutation count can. */
async function watchContentDom(view: Preview): Promise<void> {
  await view.page.evaluate(() => {
    const w = window as unknown as { __domChanges: number }
    w.__domChanges = 0
    const observer = new MutationObserver((records) => {
      w.__domChanges += records.length
    })
    const target = document.getElementById('content')
    if (target) {
      observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true })
    }
  })
}

async function readDomChanges(view: Preview): Promise<number> {
  return view.page.evaluate(() => (window as unknown as { __domChanges: number }).__domChanges)
}

/** Render `markdown` through the real renderer and deliver it as a finished translation. */
async function showTranslation(view: Preview, markdown: string): Promise<string> {
  const { html } = await renderMarkdown(markdown)
  await view.send({ type: 'translationComplete', translatedHtml: html })
  return html
}

/** The raw `data-vscode-context` string — the exact bytes VS Code reads at right-click
 *  time. Compared verbatim when the assertion is "left untouched". */
async function rawSelectionContext(view: Preview): Promise<string | undefined> {
  return view.page.evaluate(() => document.body.dataset.vscodeContext)
}

async function selectionContext(view: Preview): Promise<unknown> {
  const raw = await rawSelectionContext(view)
  return raw === undefined ? undefined : JSON.parse(raw)
}

/** The context as the MENU reads it. `when: kiroMdHasSelection` (package.json) is a
 *  context key: an absent `data-vscode-context` contributes no keys at all, and an
 *  unset key is falsy — indistinguishable from `false` for both the item's visibility
 *  and the command argument. So "the item is not offered" is the oracle, not one of
 *  the two shapes that express it. */
async function contextOffer(view: Preview): Promise<{ offered: boolean; term: string }> {
  const ctx = (await selectionContext(view)) as
    | { kiroMdHasSelection?: boolean; kiroMdSelection?: string }
    | undefined
  return { offered: ctx?.kiroMdHasSelection === true, term: ctx?.kiroMdSelection ?? '' }
}

async function postedTypes(view: Preview): Promise<string[]> {
  return (await view.posted()).map((m) => m.type)
}

// -----------------------------------------------------------------------------
// E19 — the bilingual grid
// -----------------------------------------------------------------------------

/*
 * Feature: Bilingual_View, Scenario E19.
 *
 * req 10.3 promises each pair is ONE grid row whose height comes from the taller
 * side, "so a block and its translation are always exactly across from each
 * other regardless of the height difference". That is a CSS Grid outcome: only
 * measuring can check it. req 10.7 promises the hover highlight reaches BOTH
 * columns and stays purely visual, and req 10.5 promises no reverse-translation
 * tooltip at all in this view — a silence, so it is proven next to a positive
 * control in the same test.
 */
describe('E19 bilingual grid', () => {
  it('lays every pair out as one grid row, so a block and its translation share a top edge', async () => {
    preview = await openPreview()
    await preview.configure() // a target language is what enables #bilingual-btn (req 10.2)
    await preview.render(PAIR_SOURCE)
    await showTranslation(preview, PAIR_TARGET)

    await preview.click('#bilingual-btn')
    expect(await preview.classList('#content')).toContain('bilingual')

    const rows = await preview.page.evaluate(() =>
      Array.from(document.querySelectorAll('.bcell-l')).map((cell) => {
        const left = cell.querySelector('[data-paragraph-index]') as HTMLElement | null
        const right = cell.nextElementSibling?.querySelector('[data-paragraph-index]') as HTMLElement | null
        const lr = left?.getBoundingClientRect()
        const rr = right?.getBoundingClientRect()
        return {
          leftIndex: left ? Number(left.dataset.paragraphIndex) : null,
          rightIndex: right ? Number(right.dataset.paragraphIndex) : null,
          leftTop: lr?.top ?? 0,
          rightTop: rr?.top ?? 0,
          leftHeight: lr?.height ?? 0,
          rightHeight: rr?.height ?? 0,
          leftText: left?.textContent ?? '',
          rightText: right?.textContent ?? '',
        }
      }),
    )

    // The fixture has four top-level blocks; both columns must carry all four.
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.leftIndex)).toEqual([0, 1, 2, 3])
    expect(rows.map((r) => r.rightIndex)).toEqual([0, 1, 2, 3])

    // Fixture self-check: the property is only interesting when the two sides really
    // differ in height, in BOTH directions. Without this the alignment oracle below
    // could pass on a fixture where every pair happens to be the same size.
    expect(rows.some((r) => r.rightHeight - r.leftHeight > 15)).toBe(true)
    expect(rows.some((r) => r.leftHeight - r.rightHeight > 15)).toBe(true)

    // The promise itself: same row, same top edge. getBoundingClientRect is
    // fractional, so alignment gets a 1px tolerance and never an equality.
    for (const row of rows) {
      expect(Math.abs(row.leftTop - row.rightTop)).toBeLessThanOrEqual(1)
    }

    // ...and the right column really is the other language, not a second copy.
    expect(rows[1].leftText).toContain('Terse.')
    expect(rows[1].rightText).toContain('A translated paragraph deliberately far longer')

    expect(preview.errors()).toEqual([])
  })

  it('highlights both sides of the hovered pair and leaves the class list alone within a block', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(PAIR_SOURCE)
    await showTranslation(preview, PAIR_TARGET)
    await preview.click('#bilingual-btn')

    const block = await preview.rect('.bcell-l [data-paragraph-index="2"]')
    expect(block).not.toBeNull()
    await preview.moveMouse(block!.left + 20, block!.top + 6)

    // req 10.7: the hovered block AND its counterpart in the other column.
    expect(await preview.count('.pair-highlight')).toBe(2)
    const highlighted = await preview.page.evaluate(() =>
      Array.from(document.querySelectorAll('.pair-highlight')).map((el) => ({
        index: (el as HTMLElement).dataset.paragraphIndex,
        pane: el.closest('.bcell-r') ? 'right' : el.closest('.bcell-l') ? 'left' : 'none',
      })),
    )
    expect(highlighted).toEqual([
      { index: '2', pane: 'left' },
      { index: '2', pane: 'right' },
    ])

    // The accent bar is a generated box in the cell's left padding: it must exist,
    // and it must be painted (an unset custom property would void the declaration).
    const accent = await preview.page.evaluate(() => {
      const el = document.querySelector('.bcell-l [data-paragraph-index="2"]')
      if (!el) return null
      const before = getComputedStyle(el, '::before')
      return { content: before.content, width: before.width, background: before.backgroundColor }
    })
    expect(accent).not.toBeNull()
    expect(accent!.content).not.toBe('none')
    expect(accent!.width).toBe('3px')
    expect(accent!.background).not.toBe('rgba(0, 0, 0, 0)')

    // Moving INSIDE the same block crosses into <strong>, so a mouseover really does
    // fire — and the highlight still must not be torn down and rebuilt.
    await watchBlocks(preview)
    await preview.hover('.bcell-l [data-paragraph-index="2"] strong')
    const inside = await readBlockProbe(preview)
    expect(inside.mouseovers).toBeGreaterThan(0)
    expect(inside.classChanges).toBe(0)
    expect(await preview.count('.pair-highlight')).toBe(2)

    // Positive control: crossing into a DIFFERENT block does move the highlight, so
    // the zero above is a short-circuit and not a dead listener.
    const other = await preview.rect('.bcell-l [data-paragraph-index="3"]')
    await preview.moveMouse(other!.left + 20, other!.top + 6)
    const moved = await readBlockProbe(preview)
    expect(moved.classChanges).toBeGreaterThan(0)
    const nowHighlighted = await preview.page.evaluate(() =>
      Array.from(document.querySelectorAll('.pair-highlight')).map((el) => (el as HTMLElement).dataset.paragraphIndex),
    )
    expect(nowHighlighted).toEqual(['3', '3'])

    expect(preview.errors()).toEqual([])
  })

  it('binds no hover tooltip in bilingual view, while single view still posts one', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(PAIR_SOURCE)

    // Positive control FIRST: in single view this exact hover is a paragraphHover.
    await preview.clearPosted()
    await preview.hover('[data-paragraph-index="2"]')
    await preview.wait(700) // HOVER_MS is 500, and it runs inside the page
    expect(await preview.posted()).toEqual([{ type: 'paragraphHover', paragraphIndex: 2 }])

    await showTranslation(preview, PAIR_TARGET)
    await preview.click('#bilingual-btn')
    await preview.clearPosted()

    const block = await preview.rect('.bcell-l [data-paragraph-index="2"]')
    await preview.moveMouse(block!.left + 20, block!.top + 6)
    await preview.wait(900) // the whole hover window, with margin

    // req 10.5: both languages are already on screen, so there is nothing to peek at.
    expect(await postedTypes(preview)).not.toContain('paragraphHover')
    expect(await preview.css('#tooltip', 'display')).toBe('none')
    // ...and the pointer WAS over the block the whole time — the pair highlight proves it.
    expect(await preview.count('.pair-highlight')).toBe(2)

    expect(preview.errors()).toEqual([])
  })

  it('exits to the translation, and a target-language change drops back to the source', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(PAIR_SOURCE)
    await showTranslation(preview, PAIR_TARGET)

    await preview.click('#bilingual-btn')
    expect(await preview.classList('#content')).toContain('bilingual')

    // Leaving the two-column view lands on the translation, and the host is told so:
    // it owns the hover direction and would otherwise answer for the wrong language.
    await preview.clearPosted()
    await preview.click('#bilingual-btn')
    expect(await preview.classList('#content')).not.toContain('bilingual')
    expect((await preview.posted()).filter((m) => m.type === 'displayModeChanged')).toEqual([
      { type: 'displayModeChanged', displaying: 'translation' },
    ])
    const afterExit = (await preview.text('#content')) ?? ''
    expect(afterExit).toContain('A translated paragraph deliberately far longer')
    expect(afterExit).not.toContain('Terse.')

    // Re-enter, then change the target language: the cached translation is now stale,
    // so there is nothing left to pair and the view must fall back to the source.
    await preview.click('#bilingual-btn')
    expect(await preview.classList('#content')).toContain('bilingual')
    await preview.clearPosted()
    await preview.configure({ targetLang: 'de' })

    expect(await preview.classList('#content')).not.toContain('bilingual')
    expect((await preview.posted()).filter((m) => m.type === 'displayModeChanged')).toEqual([
      { type: 'displayModeChanged', displaying: 'source' },
    ])
    const afterTargetChange = (await preview.text('#content')) ?? ''
    expect(afterTargetChange).toContain('Terse.')
    expect(afterTargetChange).not.toContain('A translated paragraph deliberately far longer')

    expect(preview.errors()).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// E24 — data-vscode-context
// -----------------------------------------------------------------------------

/*
 * Feature: Glossary exclusion from the preview, Scenario E24.
 *
 * req 3.19 / README: right-click in the preview offers "Exclude Selection from
 * Translation", and "in the preview the item appears only while the source is
 * shown, because the Glossary is a storage-language list". Both the `when` clause
 * and the command argument come from `data-vscode-context` — there is no message
 * to observe, so a unit test has nothing to assert and only a real Selection
 * produces the value at all.
 */
describe('E24 native context menu selection', () => {
  it('publishes the trimmed selection to the native context menu without asking the host', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SELECT_SOURCE)

    // The channel is demonstrably alive before we claim nothing travels over it.
    expect(await postedTypes(preview)).toContain('requestComments')
    await preview.clearPosted()

    const selected = await preview.dragSelect('[data-paragraph-index="1"]')
    expect(selected.trim().length).toBeGreaterThan(0)
    expect(await selectionContext(preview)).toEqual({
      kiroMdHasSelection: true,
      kiroMdSelection: selected.trim(),
    })
    // The whole point of the dataset: the menu is fed without a host round-trip.
    expect(await preview.posted()).toEqual([])

    await preview.clearSelection()
    expect(await selectionContext(preview)).toEqual({ kiroMdHasSelection: false, kiroMdSelection: '' })

    // A selection that trims to nothing must not offer an empty Glossary term.
    const block = '[data-paragraph-index="1"]'
    const again = await preview.dragSelect(block)
    expect(again.trim().length).toBeGreaterThan(0)
    const space = await preview.selectChars(block, SPACE_AT, block, SPACE_AT + 1)
    expect(space).toBe(' ')
    expect(await selectionContext(preview)).toEqual({ kiroMdHasSelection: false, kiroMdSelection: '' })

    expect(preview.errors()).toEqual([])
  })

  it('offers nothing while the translation is displayed, and resumes on the source', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SELECT_SOURCE)
    // Nothing selected yet, so there is nothing to exclude and no item to show.
    expect(await contextOffer(preview)).toEqual({ offered: false, term: '' })

    await showTranslation(preview, SELECT_TARGET)
    await preview.clearPosted()

    const translated = await preview.dragSelect('[data-paragraph-index="1"]')
    expect(translated.trim().length).toBeGreaterThan(0) // a live selection really exists
    // The Glossary stores storage-language terms, so a target-language selection is
    // not offered at all — even though the toolbar over it is.
    expect(await contextOffer(preview)).toEqual({ offered: false, term: '' })
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    // Positive control: back on the source the identical gesture does offer the term,
    // so the silence above is the display mode and not a broken listener.
    await preview.click('#translate-btn')
    const source = await preview.dragSelect('[data-paragraph-index="1"]')
    expect(await selectionContext(preview)).toEqual({
      kiroMdHasSelection: true,
      kiroMdSelection: source.trim(),
    })

    expect(preview.errors()).toEqual([])
  })

  it('leaves the context untouched while a form field owns the selection', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SELECT_SOURCE)

    const selected = await preview.dragSelect('[data-paragraph-index="1"]')
    const before = await rawSelectionContext(preview)
    expect(before).toContain(selected.trim())

    // Selecting inside the edit modal is the native Cut/Copy/Paste menu's business;
    // overwriting the context there would silently replace the Glossary candidate.
    await preview.send({
      type: 'openEditModal',
      paragraphIndex: 1,
      storageText: 'storage side of the block',
      targetText: 'target side of the block',
    })
    await preview.click('#modal-storage')
    await preview.press('a', { ctrl: true })
    expect(await preview.page.evaluate(() => document.activeElement?.id)).toBe('modal-storage')
    expect(
      await preview.page.evaluate(() => {
        const ta = document.getElementById('modal-storage') as HTMLTextAreaElement
        return ta.selectionEnd - ta.selectionStart
      }),
    ).toBe('storage side of the block'.length)

    expect(await rawSelectionContext(preview)).toBe(before)

    expect(preview.errors()).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// E25 — the auto code theme
// -----------------------------------------------------------------------------

/*
 * Feature: Code_Highlight, Scenario E25.
 *
 * req 12.5 promises the `auto` theme follows the editor's light/dark theme "with
 * no host round-trip and no re-render", and req 12.6 promises a theme change is a
 * stylesheet swap that never re-renders the content. Both claims are cascade
 * facts: the theme is shipped as one sheet scoped under `.vscode-dark` /
 * `.vscode-light`, and the only honest oracle is a computed colour plus a DOM
 * that provably did not move.
 */
describe('E25 auto code theme', () => {
  it('recolours from the editor body class alone, with no re-render and no message', async () => {
    preview = await openPreview()
    await preview.render(CODE_DOC)

    // Fixture self-check: the real renderer must have produced highlight hooks, or
    // every colour oracle below would be comparing two absences.
    expect(await preview.count('.hljs-keyword')).toBeGreaterThan(0)

    const probe = async () =>
      preview!.page.evaluate(() => {
        const keyword = document.querySelector('.hljs-keyword')
        const code = document.querySelector('pre code')
        return {
          keywordColor: keyword ? getComputedStyle(keyword).color : null,
          codeColor: code ? getComputedStyle(code).color : null,
          codeBackground: code ? getComputedStyle(code).backgroundColor : null,
          html: document.getElementById('content')?.innerHTML ?? '',
          themeBytes: document.getElementById('code-theme')?.textContent?.length ?? -1,
        }
      })

    await preview.clearPosted()
    await watchContentDom(preview)

    await preview.page.evaluate(() => {
      document.body.className = 'vscode-dark'
    })
    await preview.send({ type: 'setCodeTheme', css: codeThemeCss('auto') })
    const dark = await probe()

    // No message, no re-render: ONLY the editor's body class changes here.
    await preview.page.evaluate(() => {
      document.body.className = 'vscode-light'
    })
    await preview.frames(2)
    const light = await probe()

    await preview.send({ type: 'setCodeTheme', css: codeThemeCss('off') })
    const off = await probe()

    // The theme actually colours the keyword, and the two editor themes disagree —
    // which is the entire content of "follows the editor".
    expect(dark.keywordColor).not.toBe(dark.codeColor)
    expect(light.keywordColor).not.toBe(light.codeColor)
    expect(dark.keywordColor).not.toBe(light.keywordColor)

    // `off` gives the keyword no colour of its own; the code block keeps its base look.
    expect(off.themeBytes).toBe(0)
    expect(off.keywordColor).toBe(off.codeColor)
    expect(off.codeBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(off.codeBackground).not.toBe(dark.codeBackground)

    // The content DOM was never touched. An innerHTML snapshot alone could not tell
    // an untouched DOM from one rebuilt with identical markup, so both are asserted.
    expect(light.html).toBe(dark.html)
    expect(off.html).toBe(dark.html)
    expect(await readDomChanges(preview)).toBe(0)
    expect(await preview.posted()).toEqual([])

    expect(preview.errors()).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// E26 — renderContent display:false
// -----------------------------------------------------------------------------

/*
 * Feature: keep the translation while the source refreshes, Scenario E26.
 *
 * req 2.6/3.11: an edit to the file while a translation is displayed must keep the
 * previous content on screen — being yanked back to the source on every keystroke
 * is the failure this flag exists to prevent. The cached source must nevertheless
 * be the NEW one, which only the next toggle can show. And every content swap
 * re-pulls comments (the rebuilt DOM lost its markers), so losing that post loses
 * every marker silently.
 */
describe('E26 renderContent display:false', () => {
  it('keeps the translation on screen, then toggles to the freshly rendered source', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(SOURCE_V1)
    await showTranslation(preview, TRANSLATION_V1)
    expect(await preview.text('#content')).toContain('Charlie translated sentinel.')

    const v2 = await renderMarkdown(SOURCE_V2)
    await preview.clearPosted()
    await preview.send({ type: 'renderContent', html: v2.html, lineMap: v2.lineMap, display: false })

    // Nothing was swapped, so nothing had to be re-pulled either.
    const shown = (await preview.text('#content')) ?? ''
    expect(shown).toContain('Charlie translated sentinel.')
    expect(shown).not.toContain('Bravo source sentinel.')
    expect(await preview.posted()).toEqual([])

    // The toggle proves the cached source WAS refreshed underneath the translation.
    await preview.clearPosted()
    await preview.click('#translate-btn')
    const source = (await preview.text('#content')) ?? ''
    expect(source).toContain('Bravo source sentinel.')
    expect(source).not.toContain('Alpha source sentinel.')
    expect(source).not.toContain('Charlie translated sentinel.')
    expect((await preview.posted()).filter((m) => m.type === 'displayModeChanged')).toEqual([
      { type: 'displayModeChanged', displaying: 'source' },
    ])
    expect((await preview.posted()).filter((m) => m.type === 'requestComments')).toHaveLength(1)
    expect((await postedTypes(preview)).sort()).toEqual(['displayModeChanged', 'requestComments'])

    // Back to the translation: still cached, so no second trip to the API.
    await preview.clearPosted()
    await preview.click('#translate-btn')
    expect(await preview.text('#content')).toContain('Charlie translated sentinel.')
    expect((await preview.posted()).filter((m) => m.type === 'displayModeChanged')).toEqual([
      { type: 'displayModeChanged', displaying: 'translation' },
    ])
    expect((await preview.posted()).filter((m) => m.type === 'requestComments')).toHaveLength(1)
    expect(await postedTypes(preview)).not.toContain('translateRequest')

    expect(preview.errors()).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// E27 — host markup is inert
// -----------------------------------------------------------------------------

/*
 * Feature: webview sandbox, Scenario E27.
 *
 * The webview parses host HTML into a detached fragment instead of assigning
 * innerHTML, and the page ships a `default-src 'none'; script-src 'nonce-…'` CSP
 * (req 15.1). Both defences are browser-level: jsdom would prove neither, and the
 * CSP is only real because the page really is served with the meta tag production
 * emits. All three injection points get the same hostile payload.
 */
describe('E27 host-supplied HTML is inert', () => {
  it('executes nothing at content, tooltip or assistant-reply injection points', async () => {
    preview = await openPreview()
    await preview.configure({ aiAssistantEnabled: true })

    // 1. Main content. The surrounding markup renders and the <script> IS in the DOM —
    //    without that, "the global is undefined" would only mean the payload never
    //    arrived, which is not what is being claimed.
    await preview.renderHtml(HOSTILE_CONTENT)
    expect(await preview.text('[data-paragraph-index="0"]')).toContain('Alpha paragraph')
    expect(await preview.count('#content img')).toBe(1)
    expect(await preview.count('#content script')).toBe(1)

    // 2. Hover peek. `showTooltip` only renders for the block the pointer is on, so
    //    the hover is arrangement, not the thing under test.
    await preview.hover('[data-paragraph-index="0"]')
    await preview.send({ type: 'showTooltip', paragraphIndex: 0, html: HOSTILE_TOOLTIP })
    expect(await preview.css('#tooltip', 'display')).toBe('block')
    expect(await preview.text('#tooltip')).toContain('peek')
    expect(await preview.count('#tooltip script')).toBe(1)

    // 3. Assistant reply, with the dialog opened the only way it can be.
    await preview.dragSelect('[data-paragraph-index="0"]')
    expect(await preview.hidden('#sel-ai')).toBe(false)
    await preview.click('#sel-ai')
    await preview.waitForPost('askAiOpen')
    expect(await preview.hidden('#assistant-modal')).toBe(false)
    await preview.send({ type: 'assistantReply', html: HOSTILE_REPLY, canApply: false })
    expect(await preview.text('#assistant-log')).toContain('reply')
    expect(await preview.count('#assistant-log script')).toBe(1)

    // The image really did try to load and fail, so its inline onerror really was the
    // handler that did not fire.
    expect(preview.errors().some((issue) => issue.kind === 'requestfailed' && /\/x\s*$/.test(issue.text))).toBe(true)

    const globals = await preview.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      return { x1: w.__x1, x2: w.__x2, x3: w.__x3, x4: w.__x4 }
    })
    expect(globals).toEqual({ x1: undefined, x2: undefined, x3: undefined, x4: undefined })

    // The fixture deliberately makes the page refuse things: the `src="x"` image can
    // never load, and an inline handler can never run under this CSP. Those entries
    // ARE the defence reporting itself. A pageerror, or any other console entry, is
    // not — and would mean something in the page actually ran.
    const expected = (issue: PageIssue): boolean =>
      /Content Security Policy|Refused to |net::ERR_/.test(issue.text) ||
      (issue.kind === 'requestfailed' && /\/x\s*$/.test(issue.text))
    expect(preview.errors().filter((issue) => issue.kind === 'pageerror')).toEqual([])
    expect(preview.errors().filter((issue) => !expected(issue))).toEqual([])
  })
})
