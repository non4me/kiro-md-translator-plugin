import fc from 'fast-check'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, openPreview, renderMarkdown, type Preview } from './harness'

/*
 * The two webview properties, in a real browser.
 *
 *   P14 — the hover peek arms after a dwell of ≥ 500 ms and never before it.
 *   P15 — the edit modal syncs the OTHER field after a 1000 ms quiet period, and
 *         that field is locked while the request is in flight.
 *
 * Both were deferred (tasks 13.3 / 13.4) for want of a harness: the webview is a
 * browser IIFE that grabs the DOM at module load, so vitest never loads it and
 * `vi.useFakeTimers()` — which the design assumes for these two — cannot reach the
 * timers, because they belong to the page. Here the timers are the page's own and
 * the clock is real; every timing oracle is therefore MEASURED with the page's
 * clock (`performance.now()`), never inferred from a Node-side sleep.
 *
 * Iteration count: the design asks for `numRuns: 100`, which is right for a pure
 * function and impossible here — a single case spends its dwell (up to 1.2 s) or
 * its quiet period (1 s) in real wall-clock time, so 100 cases would be a
 * multi-minute suite. Each property draws a small, FIXED sample instead
 * (`fc.sample` with a literal seed), so the inputs are still generated rather than
 * hand-picked, and the run is reproducible case for case.
 *
 * Where the oracles come from:
 *   - the 500 ms / 1000 ms thresholds are the DESIGN's numbers (P14: "hovering for
 *     a duration d ≥ 500 ms"; P15: "after a quiet period of 1000 ms" / req 7.9).
 *     They are repeated here as literals on purpose: HOVER_MS / MODAL_MS at the top
 *     of src/webview/previewPanel.ts currently agree with them, and if the source
 *     constant drifts these tests must fail rather than follow it.
 *   - the visible/not-visible and disabled/enabled states come from the property
 *     text, not from what the bundle happens to do.
 *   - the harness plays the host, so anything the host owns (that the reply really
 *     IS a translation of the typed text) is not asserted here; it is
 *     PreviewController.handleModalSync's obligation and is covered by the unit
 *     suite. What is asserted is the webview's half: which field is asked for,
 *     when, and which field the answer lands in.
 */

// The design's thresholds. See the note above before "fixing" either of these.
const HOVER_MS = 500
const MODAL_MS = 1000

/**
 * How late the message may be and still count as "after the window", measured on the
 * page's clock: the page timer's own lag plus the probe's 4 ms poll. It is not a second
 * debounce — it is what makes the timing assertions two-sided. Without an upper bound a
 * bundle that waited 3 s would satisfy "not before 500 ms" perfectly.
 */
const LAG_MS = 200

/**
 * How far a generated dwell must stay from the 500 ms edge to be classified up front.
 *
 * A browser cannot be told to release the pointer at exactly t = 500.000 ms: the
 * mouse events travel over CDP and the dwell that actually happens is the requested
 * one plus a few milliseconds of jitter. A case landing on the edge would be a coin
 * flip, so generated durations inside the band are dropped — and the edge itself is
 * covered exactly, not statistically, by the `post - mouseover ≥ 500` measurement on
 * every long case, which is the property's "not before" clause with sub-millisecond
 * precision.
 */
const EDGE_BAND_MS = 100

/**
 * Hover durations, `fc.nat(1200)` exactly as the design's generator table specifies,
 * sampled once with a fixed seed. 8 cases: see the iteration-count note above.
 */
const DURATIONS = fc
  .sample(fc.nat(1200), { numRuns: 40, seed: 20260727 })
  .filter((d) => Math.abs(d - HOVER_MS) > EDGE_BAND_MS)
  .slice(0, 8)

/**
 * Text typed into a modal field, `fc.string({ minLength: 1 })` as the design's table
 * specifies, capped in length because every character is a real keystroke over CDP.
 */
const TEXTS = fc
  .sample(fc.string({ minLength: 1, maxLength: 16 }), { numRuns: 30, seed: 20260728 })
  .slice(0, 8)

/** What the host would send back. The webview's contract is that this lands verbatim in
 *  the OTHER field; whether it is a good translation is the host's business. */
function translationOf(text: string): string {
  return `⇄ ${text}`
}

/** One-line paragraphs so every case of the hover property gets its own block, all of
 *  them on screen at once in the harness's fixed 1280×900 viewport. */
function hoverDoc(count: number): string {
  const lines = ['# Property fixture', '']
  for (let i = 1; i <= count; i++) lines.push(`Block ${i} of the hover fixture, one line tall and wide enough to aim at.`)
  return lines.join('\n\n')
}

const NEUTRAL = { x: 640, y: 5 }

/** Viewport point inside a block's text, clear of the gutter control. */
async function pointIn(preview: Preview, index: number): Promise<{ x: number; y: number }> {
  const rect = await preview.rect(`[data-paragraph-index="${index}"]`)
  if (!rect) throw new Error(`no block ${index}`)
  return { x: rect.left + 30, y: rect.top + rect.height / 2 }
}

/** A modal textarea reduced to the two things the sync state machine drives. */
async function fieldState(preview: Preview, selector: string): Promise<{ value: string; disabled: boolean }> {
  return preview.page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLTextAreaElement
    return { value: el.value, disabled: el.disabled }
  }, selector)
}

/**
 * Page-clock stamps for one case: when the window opened (`start`), when it was cut
 * short (`end`), and when the message the window is supposed to produce reached the
 * host stub (`post`). Zero means "did not happen".
 */
interface Stamp {
  start: number
  end: number
  post: number
}

/**
 * Install the hover probe for one block.
 *
 * The listeners are CAPTURE listeners on the document, so they run BEFORE the block's
 * own — the stamp can therefore never be later than the moment the bundle armed the
 * timer, which is what keeps "not before 500 ms" one-sided. The arrival of the message
 * is polled rather than intercepted: wrapping the host stub would be a second
 * implementation of it, and a poll only ever reports the post LATER than it happened,
 * which is the safe direction for the same assertion.
 */
async function probeHover(preview: Preview, index: number): Promise<void> {
  await preview.page.evaluate((i) => {
    const w = window as unknown as { __probe: Record<string, number>; __probeStop?: () => void }
    w.__probeStop?.()
    const probe = { start: 0, end: 0, post: 0 }
    w.__probe = probe
    const inBlock = (e: Event): boolean => {
      const target = e.target as Element | null
      return target !== null && target.closest(`[data-paragraph-index="${i}"]`) !== null
    }
    const onOver = (e: Event): void => {
      if (!probe.start && inBlock(e)) probe.start = performance.now()
    }
    const onOut = (e: Event): void => {
      if (probe.start && !probe.end && inBlock(e)) probe.end = performance.now()
    }
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    const id = window.setInterval(() => {
      if (!probe.post && window.__posted.some((m) => m.type === 'paragraphHover')) probe.post = performance.now()
    }, 4)
    w.__probeStop = (): void => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      window.clearInterval(id)
    }
  }, index)
}

/** The same idea for the modal: `start` is the LAST keystroke — every `input` restarts
 *  the quiet period, so a per-keystroke regression shows up as a negative measurement. */
async function probeModal(preview: Preview, fieldId: string): Promise<void> {
  await preview.page.evaluate((id) => {
    const w = window as unknown as { __probe: Record<string, number>; __probeStop?: () => void }
    w.__probeStop?.()
    const probe = { start: 0, end: 0, post: 0 }
    w.__probe = probe
    const onInput = (e: Event): void => {
      if ((e.target as Element | null)?.id === id) probe.start = performance.now()
    }
    document.addEventListener('input', onInput, true)
    const timer = window.setInterval(() => {
      if (!probe.post && window.__posted.some((m) => m.type === 'modalSyncRequest')) probe.post = performance.now()
    }, 4)
    w.__probeStop = (): void => {
      document.removeEventListener('input', onInput, true)
      window.clearInterval(timer)
    }
  }, fieldId)
}

async function readProbe(preview: Preview): Promise<Stamp> {
  return preview.page.evaluate(() => {
    const probe = (window as unknown as { __probe: Stamp }).__probe
    return { start: probe.start, end: probe.end, post: probe.post }
  })
}

/** The probe once it has SEEN the message: its 4 ms poll can lag the Node-side one that
 *  released `waitForPost`, and reading a zero stamp would be a false failure. */
async function postStamp(preview: Preview): Promise<Stamp> {
  await preview.page.waitForFunction(
    () => (window as unknown as { __probe: { post: number } }).__probe.post > 0,
    { timeout: 5000 },
  )
  return readProbe(preview)
}

/**
 * Per-test budget. Both properties spend their cases' dwells and quiet periods in real
 * wall-clock time — roughly 9 s each on an idle machine, half again as much when the
 * machine is busy — so the suite's 30 s default is a plausible false failure rather than
 * a real one. Nothing here waits on a condition for longer than 5 s, so a genuine hang
 * still fails on its own assertion first.
 */
const BUDGET_MS = 90_000

let preview: Preview | undefined

afterEach(async () => {
  await preview?.close()
  preview = undefined
})
afterAll(closeBrowser)

// ---------------------------------------------------------------------------

describe('P14 hover peek timing', () => {
  // Feature: kiro-md-translator-plugin, Property 14: Hover tooltip appears after ≥ 500 ms
  // hover, not before
  it('shows the peek for every dwell that reached the window and for no dwell that did not', async () => {
    // Fixture guard on the generated table: a sample that degenerated to one side would
    // still pass every assertion below while proving only half the property.
    expect(DURATIONS.filter((d) => d < HOVER_MS).length).toBeGreaterThanOrEqual(2)
    expect(DURATIONS.filter((d) => d >= HOVER_MS).length).toBeGreaterThanOrEqual(2)

    preview = await openPreview()
    await preview.configure()
    await preview.render(hoverDoc(DURATIONS.length + 4))
    const peek = await renderMarkdown('The known source text of the block.')

    let armed = 0
    let silent = 0

    for (const [i, duration] of DURATIONS.entries()) {
      // Its own block per case, so "the peek is for the block under the pointer" is a real
      // claim; index 0 is the heading and index 1 can sit under the sticky header.
      const index = i + 2

      // Rest state: pointer parked off the content, nothing shown, record cleared.
      await preview.moveMouse(NEUTRAL.x, NEUTRAL.y)
      await preview.page.waitForFunction(
        () => getComputedStyle(document.getElementById('tooltip') as HTMLElement).display === 'none',
        { timeout: 5000 },
      )
      await preview.clearPosted()
      await probeHover(preview, index)

      const point = await pointIn(preview, index)
      // Aim guard: the case is only about block `index` if the pointer really lands on its
      // text. The gutter control is a CHILD of the block, and hovering it deliberately arms
      // nothing (req 10.14), so a point that drifted onto it would fake the silent half.
      const target = await preview.hitTest(point.x, point.y)
      expect({ blockIndex: target?.blockIndex, inBctl: target?.inBctl }).toEqual({
        blockIndex: index,
        inBctl: false,
      })
      await preview.moveMouse(point.x, point.y)
      await preview.wait(duration)

      if (duration < HOVER_MS) {
        // The property's second half: dwell, then leave, then nothing may happen — ever,
        // not merely "not yet". Wait out the rest of the window plus the hide grace.
        await preview.moveMouse(NEUTRAL.x, NEUTRAL.y)
        await preview.wait(HOVER_MS - duration + 250)

        const stamp = await readProbe(preview)
        expect(stamp.start).toBeGreaterThan(0) // the pointer really entered …
        expect(stamp.end).toBeGreaterThan(0) // … and really left
        const hovers = (await preview.posted()).filter((m) => m.type === 'paragraphHover')

        // Classify by the dwell that HAPPENED, never by the one that was asked for: a
        // stalled machine can stretch a short case past the window, and the property is
        // about the dwell, so the case then simply belongs to the other half.
        if (stamp.end - stamp.start < HOVER_MS) {
          expect(hovers).toEqual([])
          expect(await preview.css('#tooltip', 'display')).toBe('none')
          silent++
        } else {
          expect(hovers).toEqual([{ type: 'paragraphHover', paragraphIndex: index }])
          armed++
        }
      } else {
        // The property's first half. The pointer stays where it is: a reply for the block
        // it is on is what makes the peek appear. Both readings are taken in ONE evaluate,
        // so the clock and the record cannot drift apart between them.
        const snapshot = await preview.page.evaluate(() => {
          const probe = (window as unknown as { __probe: { start: number } }).__probe
          return {
            dwell: performance.now() - probe.start,
            hovers: window.__posted.filter((m) => m.type === 'paragraphHover'),
          }
        })
        expect(snapshot.dwell).toBeGreaterThanOrEqual(HOVER_MS) // the dwell reached the window …
        // … and by then the request was ALREADY out. Asserted without waiting for it: a
        // `waitForPost` here would pass just as happily against a bundle that armed at 3 s.
        expect(snapshot.hovers).toEqual([{ type: 'paragraphHover', paragraphIndex: index }])

        const stamp = await postStamp(preview)
        // "not before": measured from the mouseover the page itself saw, so the 500 ms
        // edge is asserted exactly rather than approached from a Node-side sleep.
        expect(stamp.post - stamp.start).toBeGreaterThanOrEqual(HOVER_MS)
        expect(stamp.post - stamp.start).toBeLessThanOrEqual(HOVER_MS + LAG_MS)

        await preview.send({ type: 'showTooltip', paragraphIndex: index, html: peek.html })
        expect(await preview.css('#tooltip', 'display')).toBe('block')
        expect(await preview.text('#tooltip')).toContain('The known source text of the block.')
        armed++
      }
    }

    // Both halves were actually exercised by measured dwells, not just by intent.
    expect(armed).toBeGreaterThanOrEqual(2)
    expect(silent).toBeGreaterThanOrEqual(2)
    expect(armed + silent).toBe(DURATIONS.length)

    expect(preview.errors()).toEqual([])
  }, BUDGET_MS)
})

describe('P15 edit modal bidirectional sync', () => {
  // Feature: kiro-md-translator-plugin, Property 15: Paragraph_Edit_Modal bidirectional
  // sync updates the other field after 1000 ms
  //
  // The design's parenthetical "(with spinner)" is NOT asserted: the dialog has no spinner
  // element at all — `.spinner` exists only for the hover peek, and `editModalSyncStart`
  // does nothing but set `disabled`. Asserting a spinner would fail, so it is reported as a
  // defect instead of being quietly dropped; the substantive clause (the updated field is
  // locked for the duration of the request) is asserted in full.
  it('asks for the typed field after the quiet period and lands the answer in the other one', async () => {
    expect(TEXTS.every((text) => text.length > 0)).toBe(true) // the generator's own precondition

    preview = await openPreview()
    await preview.configure()
    await preview.render(hoverDoc(4))

    for (const [i, text] of TEXTS.entries()) {
      // Alternate the direction: the property is "either field", and the two are separate
      // listeners in the bundle, so one direction passing proves nothing about the other.
      const field = i % 2 === 0 ? ('storage' as const) : ('target' as const)
      const other = field === 'storage' ? ('target' as const) : ('storage' as const)
      const typed = `#modal-${field}`
      const updated = `#modal-${other}`

      // Empty both fields, so the typed value is the whole field value and the other
      // field's change is unmistakable.
      await preview.send({ type: 'openEditModal', paragraphIndex: 1, storageText: '', targetText: '' })
      expect(await preview.hidden('#modal')).toBe(false)
      await preview.clearPosted()
      await probeModal(preview, `modal-${field}`)

      await preview.typeInto(typed, text)
      expect(await fieldState(preview, typed)).toEqual({ value: text, disabled: false })

      const request = await preview.waitForPost('modalSyncRequest')
      const stamp = await postStamp(preview)
      // The quiet period, measured from the LAST keystroke on the page's own clock. A
      // per-keystroke regression posts before the last keystroke and goes negative here;
      // the upper bound is what keeps "after 1000 ms" from degenerating into "eventually".
      expect(stamp.post - stamp.start).toBeGreaterThanOrEqual(MODAL_MS)
      expect(stamp.post - stamp.start).toBeLessThanOrEqual(MODAL_MS + LAG_MS)
      expect(request).toEqual({ type: 'modalSyncRequest', field, text })
      expect((await preview.posted()).filter((m) => m.type === 'modalSyncRequest')).toHaveLength(1)

      // req 7.11: the field being written is locked while the request is in flight — and
      // only that one; locking the field the user is typing in would strand the edit.
      await preview.send({ type: 'editModalSyncStart', field: other })
      expect(await fieldState(preview, updated)).toEqual({ value: '', disabled: true })
      expect(await fieldState(preview, typed)).toEqual({ value: text, disabled: false })

      // req 7.10: the answer lands in the OTHER field, verbatim, and unlocks it; the text
      // the user typed is untouched.
      await preview.send({ type: 'editModalSyncComplete', field: other, text: translationOf(text) })
      expect(await fieldState(preview, updated)).toEqual({ value: translationOf(text), disabled: false })
      expect(await fieldState(preview, typed)).toEqual({ value: text, disabled: false })
    }

    // …and the update settles. Filling a field programmatically must not read as typing:
    // if it did, each answer would trigger the reverse sync and the dialog would rewrite
    // itself forever. The record still holds only the last case.
    await preview.wait(MODAL_MS + 300)
    expect((await preview.posted()).filter((m) => m.type === 'modalSyncRequest')).toHaveLength(1)

    expect(preview.errors()).toEqual([])
  }, BUDGET_MS)
})
