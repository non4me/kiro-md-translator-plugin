import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, openPreview, type Preview, type Rect } from './harness'

/*
 * Layout scenarios E2/E3/E4 — the three places where the preview's contract IS
 * geometry, so a real engine is the only thing that can judge them:
 *
 *  E2  the gutter comment marker: one column for every block whatever its own
 *      indentation (req 10.8), confined to its own block, and reachable — the
 *      82d3e2a regression made a dense list's marker literally unclickable
 *      because the NEXT item's control painted on top of it.
 *  E3  the sticky header: blocks are position:relative for the gutter icons, so
 *      without an explicit stacking order they scroll OVER the header instead of
 *      behind it (CHANGELOG 0.5.6).
 *  E4  the selection toolbar: a JS-set fixed position combined with a CSS
 *      translate(-50%,-100%), plus the block range its actions operate on.
 *
 * Every oracle here is a RELATION (alignment, containment, ordering) with a
 * pixel tolerance, never an absolute coordinate: getBoundingClientRect is
 * fractional and the font stack outside VS Code is not the production one.
 */

// Deliberately mixed indentation: a heading and a paragraph at the pane's own
// text edge, a tight five-item list and a blockquote paragraph pushed right, and
// a nested list (whose inner item is NOT a control owner — its <li> ancestor is).
const GUTTER_DOC = [
  '# Layout fixture heading',
  '',
  'A plain paragraph that carries enough words to drag a selection across it.',
  '',
  '- item one',
  '- item two',
  '- item three',
  '- item four',
  '- item five',
  '',
  '> A blockquote paragraph indented away from the pane edge.',
  '',
  '- outer item',
  '  - nested item',
  '',
  'Closing paragraph after the nested list.',
  '',
].join('\n')

// Long enough to scroll: block index of paragraph i is i + 1 (the heading is 0).
const LONG_DOC = [
  '# Scrolling fixture',
  '',
  ...Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} carries a handful of words to select.`).flatMap(
    (line) => [line, ''],
  ),
].join('\n')

/** Where the icon column sits inside the pane's left gutter (previewPanel's
 *  GUTTER_INSET_PX). The product promise is the ALIGNMENT — this is the concrete
 *  offset that promise is implemented at. */
const GUTTER_INSET_PX = 6

interface MarkerGeometry {
  index: number
  tag: string
  block: Rect
  /** `:scope > .bctl` — the control, which stretches across the gutter. */
  control: Rect | null
  /** The comment marker button inside it. */
  button: Rect | null
  /** The count badge, only when it carries a number. */
  badge: Rect | null
  badgeText: string
  pane: Rect
  /** Top of the NEXT control-owning block, or null for the last one. */
  nextBlockTop: number | null
  /** Viewport point of the block's first rendered character. */
  textPoint: { x: number; y: number } | null
}

/**
 * Geometry of every block that OWNS a gutter control. A block nested inside
 * another indexed block is skipped by `drawBlockControls` on purpose (a loose
 * list's inner `<p>`, a nested list item) — its ancestor carries the marker — so
 * measuring those would just measure the absence of one.
 */
async function readMarkers(preview: Preview): Promise<MarkerGeometry[]> {
  return preview.page.evaluate(() => {
    const toJson = (r: DOMRect): Rect => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
    })
    const contentEl = document.getElementById('content') as HTMLElement
    const owners = Array.from(document.querySelectorAll<HTMLElement>('[data-paragraph-index]')).filter(
      (el) => (el.parentElement ? el.parentElement.closest('[data-paragraph-index]') : null) === null,
    )
    return owners.map((el, i) => {
      const control = el.querySelector<HTMLElement>(':scope > .bctl')
      const button = el.querySelector<HTMLElement>(':scope > .bctl > .bctl-comment')
      const badge = button ? button.querySelector<HTMLElement>('.cmt-count') : null
      const badgeText = badge?.textContent ?? ''
      const pane = (el.closest('.bcell') as HTMLElement | null) ?? contentEl
      const next = owners[i + 1]
      // First rendered character of the block itself — gutter text excluded, so
      // this is where the user's eye (and pointer) starts from.
      let textPoint: { x: number; y: number } | null = null
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('.bctl')) continue
        if ((n.nodeValue ?? '').trim().length === 0) continue
        const r = document.createRange()
        r.setStart(n, 0)
        r.setEnd(n, 1)
        const box = r.getBoundingClientRect()
        textPoint = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        break
      }
      return {
        index: Number(el.dataset.paragraphIndex),
        tag: el.tagName.toLowerCase(),
        block: toJson(el.getBoundingClientRect()),
        control: control ? toJson(control.getBoundingClientRect()) : null,
        button: button ? toJson(button.getBoundingClientRect()) : null,
        badge: badge && badgeText !== '' ? toJson(badge.getBoundingClientRect()) : null,
        badgeText,
        pane: toJson(pane.getBoundingClientRect()),
        nextBlockTop: next ? next.getBoundingClientRect().top : null,
        textPoint,
      }
    })
  })
}

/** Which of the page's stacking layers the topmost element at a point belongs to.
 *  `hitTest` answers "which block"; this answers "which layer won the paint". */
async function layersAt(preview: Preview, x: number, y: number): Promise<{ tag: string; layers: string[] }> {
  return preview.page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px as number, py as number)
      if (!el) return { tag: '', layers: [] }
      const candidates = ['#modal', '#comment-modal', '#assistant-modal', '#sel-toolbar', '#find-bar', '#tooltip', 'header', '#content']
      return { tag: el.tagName.toLowerCase(), layers: candidates.filter((sel) => el.closest(sel) !== null) }
    },
    [x, y] as [number, number],
  )
}

interface ToolbarView {
  hidden: boolean
  toolbar: Rect
  selection: Rect | null
  buttons: Array<{ id: string; rect: Rect }>
  dataset: { firstIndex?: string; lastIndex?: string }
  viewport: { width: number; height: number }
}

/** The selection toolbar as the user sees it: its own box, the box of the live
 *  selection it is positioned against, its visible buttons and the block range
 *  its actions will carry. */
async function readToolbar(preview: Preview): Promise<ToolbarView> {
  return preview.page.evaluate(() => {
    const toJson = (r: DOMRect): Rect => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
    })
    const tb = document.getElementById('sel-toolbar') as HTMLElement
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    return {
      hidden: tb.hidden,
      toolbar: toJson(tb.getBoundingClientRect()),
      selection: range ? toJson(range.getBoundingClientRect()) : null,
      buttons: Array.from(tb.querySelectorAll<HTMLElement>('button'))
        .filter((b) => !b.hidden)
        .map((b) => ({ id: b.id, rect: toJson(b.getBoundingClientRect()) })),
      dataset: { firstIndex: tb.dataset.firstIndex, lastIndex: tb.dataset.lastIndex },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    }
  })
}

const centreX = (r: Rect): number => r.left + r.width / 2

// One page per test (the bundle's module state lives for the life of the
// document) but ONE browser for the whole file: with a `closeBrowser` per
// describe, Chromium would be torn down and relaunched twice mid-file, and a
// launch under load is exactly the kind of thing that fails once in fifty runs.
let preview: Preview | undefined

afterEach(async () => {
  await preview?.close()
  preview = undefined
})
afterAll(closeBrowser)

// Feature: gutter comment marker (req 10.8 / 11.6), Scenario E2: alignment,
// containment and hit-test across a dense list, a blockquote and a paragraph.
describe('E2 gutter comment marker geometry', () => {
  it('aligns every marker into one gutter column and confines it to its own block', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(GUTTER_DOC)
    // Markers are only PERSISTENTLY visible on blocks that carry comments
    // (req 11.6), so give them comments — otherwise this would be measuring an
    // affordance the user never sees. One block gets a count > 1 for the badge.
    const owners = await readMarkers(preview)
    await preview.send({
      type: 'commentsForBlocks',
      blocks: owners.map((m) => ({ paragraphIndex: m.index, count: m.index === 3 ? 3 : 1 })),
    })
    const markers = await readMarkers(preview)

    // The fixture must actually mix indentation, or "aligned regardless of the
    // block's own indent" is a claim about nothing.
    expect(markers.length).toBeGreaterThanOrEqual(8)
    expect(new Set(markers.map((m) => Math.round(m.block.left))).size).toBeGreaterThanOrEqual(2)
    expect(markers.filter((m) => m.control === null || m.button === null).map((m) => m.index)).toEqual([])

    // req 10.8: the icons line up in the pane's left gutter whatever the block's
    // own indentation — a list item's marker does not drift out to its bullet.
    const columns = markers.map((m) => Math.round(m.button!.left))
    expect(new Set(columns).size).toBe(1)
    expect(
      markers
        .filter((m) => Math.abs(m.button!.left - (m.pane.left + GUTTER_INSET_PX)) > 1)
        .map((m) => ({ index: m.index, left: m.button!.left, pane: m.pane.left })),
    ).toEqual([])

    // Nothing in the gutter reaches the text: not the control's hit area, not the
    // marker, and not the count badge, which overhangs the marker to the RIGHT
    // (the reason the gutter is as wide as it is).
    expect(
      markers
        .filter((m) => m.control!.right > m.block.left + 1)
        .map((m) => ({ index: m.index, controlRight: m.control!.right, blockLeft: m.block.left })),
    ).toEqual([])
    const badged = markers.filter((m) => m.badge !== null)
    expect(badged.map((m) => ({ index: m.index, text: m.badgeText }))).toEqual([{ index: 3, text: '3' }])
    expect(badged[0].badge!.right).toBeLessThanOrEqual(badged[0].block.left)

    // The control spans exactly its own block's height and stops there. Both
    // halves matter: taller than the block and it hangs into the next list item,
    // where — every block being position:relative — the later sibling paints on
    // top and the earlier marker becomes unclickable.
    expect(
      markers
        .filter((m) => Math.abs(m.control!.height - m.block.height) > 1)
        .map((m) => ({ index: m.index, control: m.control!.height, block: m.block.height })),
    ).toEqual([])
    expect(
      markers
        .filter((m) => m.nextBlockTop !== null && m.control!.bottom > m.nextBlockTop + 0.5)
        .map((m) => ({ index: m.index, bottom: m.control!.bottom, nextTop: m.nextBlockTop })),
    ).toEqual([])

    expect(preview.errors()).toEqual([])
  })

  it('hit-tests each marker to its own block, bridges the gutter, and opens that block', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(GUTTER_DOC)
    const owners = await readMarkers(preview)
    await preview.send({
      type: 'commentsForBlocks',
      blocks: owners.map((m) => ({ paragraphIndex: m.index, count: 1 })),
    })
    const markers = await readMarkers(preview)
    expect(markers.length).toBeGreaterThanOrEqual(8)

    // The regression this pins: hit-testing the centre of item one's marker used
    // to resolve to item TWO. Sweep every block, dense list included.
    for (const marker of markers) {
      const hit = await preview.hitTest(centreX(marker.button!), marker.button!.top + marker.button!.height / 2)
      expect({ index: marker.index, ...hit }).toMatchObject({
        index: marker.index,
        blockIndex: marker.index,
        inBctl: true,
        inButton: true,
      })
    }

    // Walking from the first character to the marker must never leave the block:
    // the icons only exist while the BLOCK is hovered, and the gutter they sit in
    // is outside the block's own box, so the control has to bridge the gap.
    for (const marker of markers) {
      expect(marker.textPoint).not.toBeNull()
      const escaped = await preview.page.evaluate(
        ([index, x0, y0, x1, y1]) => {
          const el = document.querySelector(`[data-paragraph-index="${index}"]`) as HTMLElement
          const out: Array<{ step: number; tag: string }> = []
          for (let step = 0; step <= 20; step++) {
            const x = (x0 as number) + (((x1 as number) - (x0 as number)) * step) / 20
            const y = (y0 as number) + (((y1 as number) - (y0 as number)) * step) / 20
            const at = document.elementFromPoint(x, y)
            if (!at || !el.contains(at)) out.push({ step, tag: at?.tagName.toLowerCase() ?? 'none' })
          }
          return out
        },
        [
          marker.index,
          marker.textPoint!.x,
          marker.textPoint!.y,
          centreX(marker.button!),
          marker.button!.top + marker.button!.height / 2,
        ] as [number, number, number, number, number],
      )
      expect({ index: marker.index, escaped }).toEqual({ index: marker.index, escaped: [] })
    }

    // A real click on the first item of the dense list opens THAT item's thread.
    const listItem = markers.find((m) => m.tag === 'li')!
    await preview.clearPosted()
    await preview.clickAt(centreX(listItem.button!), listItem.button!.top + listItem.button!.height / 2)

    // Two requests, both for the clicked block: the pointer arriving on the marker
    // asks for the hover popover, the click then opens the modal. The neighbour's
    // index appearing here is the regression.
    expect(await preview.posted()).toEqual([
      { type: 'requestCommentThread', paragraphIndex: listItem.index },
      { type: 'requestCommentThread', paragraphIndex: listItem.index },
    ])
    expect(await preview.hidden('#comment-modal')).toBe(false)

    expect(preview.errors()).toEqual([])
  })

  // Measured while writing the sweep above: in GUTTER_DOC the nested `- nested
  // item` is `data-paragraph-index="9"` with its own lineMap entry, yet it owns
  // no `.bctl` at all — `drawBlockControls` skips every block whose ancestor is
  // also indexed. So `commentsForBlocks` can carry a count for it while req 11.6
  // ("a block that has comments is marked with a permanently visible icon") has
  // nowhere to paint, and the thread is unreachable from the gutter. Req 10.8
  // lists list items among the icon-bearing blocks and excepts only a LOOSE
  // list's inner `<p>`; whether a nested `<li>` falls under that exception is a
  // product decision, so this stays open rather than being settled from the code.
  it.todo('shows a marker for a commented NESTED list item (req 10.8 vs 11.6 — undecided)')
})

// Feature: sticky header stacking (CHANGELOG 0.5.6), Scenario E3: the header
// stays above blocks scrolled under it, and below the tooltip and the modals.
describe('E3 sticky header stacking', () => {
  it('keeps content behind its opaque background at every scroll position', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(LONG_DOC)

    const header = (await preview.rect('header'))!
    expect(header.height).toBeGreaterThan(0)
    // "slides cleanly behind its OPAQUE background" — a translucent header would
    // show the text through even with the stacking order right. Chromium reports
    // `rgb(…)` only at alpha 1; anything see-through comes back as `rgba(…)`.
    const background = await preview.css('header', 'background-color')
    expect(background).toMatch(/^rgb\(\d+, \d+, \d+\)$/)

    const maxScroll = await preview.page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    )
    expect(maxScroll).toBeGreaterThan(200)

    const bandY = header.top + header.height / 2
    // Two scroll positions, each parked so a chosen block genuinely covers the
    // probe point — a fixed scroll offset can land the probe in the gap between
    // two paragraphs, where "no block was hit" would mean nothing.
    for (const anchorIndex of [4, 12]) {
      const probe = await preview.page.evaluate(
        ([index, y, headerBottom]) => {
          const block = document.querySelector(`[data-paragraph-index="${index}"]`) as HTMLElement
          window.scrollTo(0, window.scrollY + block.getBoundingClientRect().top - ((y as number) - 5))
          const midX = document.documentElement.clientWidth / 2
          const covers = (el: Element, px: number, py: number): boolean => {
            const r = el.getBoundingClientRect()
            return r.top <= py && r.bottom >= py && r.left <= px && r.right >= px
          }
          const all = Array.from(document.querySelectorAll<HTMLElement>('[data-paragraph-index]'))
          const inBand = all.find((el) => covers(el, midX, y as number))
          // A block lying entirely clear of the header, for the control probe.
          const clear = all.find((el) => el.getBoundingClientRect().top > (headerBottom as number) + 2)
          const clearRect = clear?.getBoundingClientRect()
          return {
            scrollY: window.scrollY,
            midX,
            bandBlock: inBand ? Number(inBand.dataset.paragraphIndex) : null,
            clearBlock: clear ? Number(clear.dataset.paragraphIndex) : null,
            clearY: clearRect ? clearRect.top + clearRect.height / 2 : null,
          }
        },
        [anchorIndex, bandY, header.bottom] as [number, number, number],
      )
      await preview.frames(2)
      expect(probe.scrollY).toBeGreaterThan(0)

      // Positive control: a block really does occupy the probe point. Without it,
      // "the header won the hit test" is also what a blank strip produces.
      expect(probe.bandBlock).not.toBeNull()
      const hit = await preview.hitTest(probe.midX, bandY)
      expect({ anchorIndex, ...hit }).toMatchObject({ anchorIndex, tag: 'header', blockIndex: null })

      // …and clear of the header the content is reachable again, so the header
      // wins the band it owns and nothing more.
      expect(probe.clearBlock).not.toBeNull()
      const below = await preview.hitTest(probe.midX, probe.clearY!)
      expect(below).toMatchObject({ blockIndex: probe.clearBlock })
    }

    expect(preview.errors()).toEqual([])
  })

  it('stacks the edit modal above an open hover tooltip', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(LONG_DOC)
    await preview.clearPosted()

    // Arm the peek the way a user does, then answer it as the host does.
    await preview.hover('[data-paragraph-index="5"]')
    const hover = await preview.waitForPost('paragraphHover', { timeoutMs: 3000 })
    expect(hover).toEqual({ type: 'paragraphHover', paragraphIndex: 5 })
    await preview.send({ type: 'showTooltip', paragraphIndex: 5, html: '<p>reverse translation of block five</p>' })
    expect(await preview.css('#tooltip', 'display')).not.toBe('none')

    const tip = (await preview.rect('#tooltip'))!
    const probe = { x: centreX(tip), y: tip.top + tip.height / 2 }

    // Positive control: the tooltip is on top of the content it overlaps.
    const overContent = await layersAt(preview, probe.x, probe.y)
    expect(overContent.layers).toContain('#tooltip')
    expect(overContent.layers).not.toContain('#modal')

    await preview.send({ type: 'openEditModal', paragraphIndex: 5, storageText: 'source', targetText: 'target' })
    expect(await preview.hidden('#modal')).toBe(false)

    // The tooltip is still open underneath — the modal wins purely on stacking.
    expect(await preview.css('#tooltip', 'display')).not.toBe('none')
    const overTooltip = await layersAt(preview, probe.x, probe.y)
    expect(overTooltip.layers).toContain('#modal')
    expect(overTooltip.layers).not.toContain('#tooltip')

    expect(preview.errors()).toEqual([])
  })
})

// Feature: selection toolbar (req 10.11 / 10.15), Scenario E4: position, viewport
// clamp and the block range its actions carry.
describe('E4 selection toolbar placement', () => {
  it('centres the toolbar just above a single-block selection, and a scroll dismisses it', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(LONG_DOC)
    await preview.clearPosted()

    const selected = await preview.dragSelect('[data-paragraph-index="3"]')
    expect(selected.length).toBeGreaterThan(0)
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    const view = await readToolbar(preview)
    expect(view.selection).not.toBeNull()
    // Centred over the selection: the JS-set `left` is the selection's centre and
    // the CSS translate(-50%,-100%) is what turns that into a centred box.
    expect(Math.abs(centreX(view.toolbar) - centreX(view.selection!))).toBeLessThanOrEqual(2)
    // …and sitting above it, not over the text it acts on.
    expect(view.toolbar.bottom).toBeLessThanOrEqual(view.selection!.top + 1)
    // The block the actions will target.
    expect(view.dataset).toEqual({ firstIndex: '3', lastIndex: '3' })
    // Edit + Comment offered; Ask AI stays hidden while the assistant is off.
    expect(view.buttons.map((b) => b.id)).toEqual(['sel-edit', 'sel-comment'])

    // Showing the toolbar is webview-local: no host round-trip, and the hover peek
    // armed by the pointer landing on the block is cancelled by the selection
    // (req 10.14) rather than firing behind it. The wait is the full 500ms hover
    // window plus margin — the only honest way to assert that nothing happened.
    await preview.wait(800)
    expect(await preview.posted()).toEqual([])
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    // req 10.11: a scroll moves the selection out from under a fixed toolbar, so
    // the toolbar is dismissed.
    await preview.scrollBy(200)
    expect(await preview.hidden('#sel-toolbar')).toBe(true)

    expect(preview.errors()).toEqual([])
  })

  it('clamps into the viewport when the selection leaves no room above it', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(LONG_DOC)

    // Park a block 10px below the viewport top — under the sticky header, where
    // the toolbar's natural position would be off-screen. Selecting by Range, not
    // by mouse: at that height the header would swallow the press.
    await preview.page.evaluate(() => {
      const el = document.querySelector('[data-paragraph-index="12"]') as HTMLElement
      window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 10)
    })
    await preview.frames(2)
    await preview.clearPosted()
    const selected = await preview.selectChars('[data-paragraph-index="12"]', 2, '[data-paragraph-index="12"]', 20)
    expect(selected.length).toBeGreaterThan(0)
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    const view = await readToolbar(preview)
    expect(view.selection).not.toBeNull()
    // The precondition: there genuinely is no room for a 32px toolbar above this
    // selection. If a layout change ever moves the block down, the test would
    // stop exercising the clamp — so assert it, don't assume it.
    expect(view.selection!.top).toBeLessThan(view.toolbar.height)

    // Clamped: the toolbar did NOT follow the selection off the top of the page.
    expect(view.toolbar.bottom).toBeGreaterThan(view.selection!.top - 4)
    // Every action stays fully inside the viewport — that is what the clamp is
    // for. (The toolbar's border box overshoots the top edge by a couple of
    // pixels: the clamp floor is a fixed 30px while the box is 32px tall.)
    expect(
      view.buttons.filter((b) => b.rect.top < 0 || b.rect.bottom > view.viewport.height).map((b) => b.id),
    ).toEqual([])
    // Horizontal centring survives the vertical clamp.
    expect(Math.abs(centreX(view.toolbar) - centreX(view.selection!))).toBeLessThanOrEqual(2)
    expect(view.dataset).toEqual({ firstIndex: '12', lastIndex: '12' })

    // A clamped toolbar overlaps the sticky header. It has to paint ABOVE it, or
    // the actions are on screen and still unusable.
    const edit = view.buttons.find((b) => b.id === 'sel-edit')!
    const layers = await layersAt(preview, centreX(edit.rect), edit.rect.top + edit.rect.height / 2)
    expect(layers.layers).toContain('#sel-toolbar')
    expect(layers.layers).not.toContain('header')

    expect(preview.errors()).toEqual([])
  })

  it('carries the first and last block index of a selection spanning several blocks', async () => {
    preview = await openPreview()
    await preview.configure()
    await preview.render(LONG_DOC)
    await preview.clearPosted()

    const selected = await preview.dragSelect('[data-paragraph-index="2"]', '[data-paragraph-index="4"]')
    // Positive control: the drag really crossed the middle block, so `lastIndex`
    // is a span and not just a longer selection inside one paragraph.
    expect(selected).toContain('Paragraph number 2')
    expect(await preview.hidden('#sel-toolbar')).toBe(false)

    const view = await readToolbar(preview)
    // req 10.15/10.16/10.17: the actions operate on the whole block range.
    expect(view.dataset).toEqual({ firstIndex: '2', lastIndex: '4' })
    // Still centred above the selection's own box, which now spans three blocks.
    expect(Math.abs(centreX(view.toolbar) - centreX(view.selection!))).toBeLessThanOrEqual(2)
    expect(view.toolbar.bottom).toBeLessThanOrEqual(view.selection!.top + 1)

    expect(preview.errors()).toEqual([])
  })
})
