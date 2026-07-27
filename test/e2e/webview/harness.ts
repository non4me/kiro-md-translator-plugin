/*
 * Webview end-to-end harness.
 *
 * Boots the REAL preview page in real Chromium: the production `getPreviewHtml`
 * markup, the production webview bundle (rebuilt from source on every run), the
 * production CSP, served from disk over file:// so the nonce'd external script
 * loads exactly as it does in the extension host. Nothing here hand-writes or
 * string-patches markup the product emits — a patched page would test the patch.
 *
 * A browser is not a convenience here: the webview's contract IS layout, hit
 * testing, the CSS Custom Highlight API, Selection/Range arithmetic and real
 * key/mouse events. jsdom has none of those, so a jsdom "pass" proves nothing.
 *
 * This module is also the vitest `globalSetup` (see `setup` below): the bundle
 * and the page are built once per run, before any worker starts.
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import puppeteer, { type Browser, type BrowserContext, type CDPSession, type KeyInput, type Page, type Viewport } from 'puppeteer'
import { MarkdownRenderer } from '../../../src/MarkdownRenderer'
import { codeThemeCss } from '../../../src/highlightThemes'
import { getPreviewHtml } from '../../../src/webview/getPreviewHtml'
import type { ExtensionMessage, LineMapping, WebviewMessage } from '../../../src/types'

export { codeThemeCss }

declare global {
  interface Window {
    /** Every message the webview posted to the (stubbed) host, in order. */
    __posted: WebviewMessage[]
  }
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// Keyed by checkout path so two working copies never fight over the same page,
// but stable within a checkout so the harness can find what globalSetup built
// without env/provide plumbing across the fork pool.
const BUILD_ID = createHash('sha1').update(REPO_ROOT).digest('hex').slice(0, 8)

/** Where the built bundle + page live. Left behind after a run on purpose: a failing
 *  run leaves a real page you can open in a browser by hand. */
export const PAGE_DIR = path.join(tmpdir(), `kiro-md-e2e-webview-${BUILD_ID}`)
export const PAGE_URL = pathToFileURL(path.join(PAGE_DIR, 'preview.html')).href

const NONCE = 'e2e-nonce'

/** Fixed so geometry oracles are deterministic across machines. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 900, deviceScaleFactor: 1 }

/** `Input.dispatchKeyEvent` modifier bits (CDP). */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

/**
 * The `--vscode-*` theme variables VS Code injects into a real webview. Several
 * rules reference them with NO fallback (`.paragraph-highlight`, `#tooltip`, the
 * badge, the find input …) and an unset custom property makes the whole
 * declaration invalid — no background at all — so without this fixture every
 * computed-style oracle on those rules would be measuring nothing.
 *
 * Scenario E1 diffs this against the tokens the production stylesheet actually
 * uses, so a new no-fallback token fails the suite instead of silently voiding a
 * later assertion.
 */
export const THEME_VARS_CSS = `:root{
  --vscode-font-family: system-ui, sans-serif;
  --vscode-editor-font-family: ui-monospace, Consolas, monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-panel-border: #333333;
  --vscode-focusBorder: #007fd4;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-errorForeground: #f48771;
  --vscode-textLink-foreground: #3794ff;
  --vscode-textLink-activeForeground: #4daafc;
  --vscode-editor-hoverHighlightBackground: rgba(70,130,180,.3);
  --vscode-editorHoverWidget-background: #252526;
  --vscode-editorHoverWidget-border: #454545;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-toolbar-hoverBackground: rgba(128,128,128,.2);
  --vscode-list-hoverBackground: rgba(128,128,128,.15);
  --vscode-textCodeBlock-background: rgba(127,127,127,.12);
  --vscode-editor-findMatchHighlightBackground: rgba(234,92,0,.33);
  --vscode-editor-findMatchBackground: rgba(234,92,0,.66);
  --vscode-editor-selectionHighlightBackground: rgba(90,150,90,.25);
}`

// ---------------------------------------------------------------------------
// Build (vitest globalSetup)
// ---------------------------------------------------------------------------

/**
 * vitest `globalSetup`: rebuild the webview bundle from source and write the
 * production page next to it. Never reads `out/webview/previewPanel.js` — that
 * artefact can be stale, and a stale bundle turns the whole suite into a lie.
 */
export async function setup(): Promise<void> {
  await rm(PAGE_DIR, { recursive: true, force: true })
  await mkdir(PAGE_DIR, { recursive: true })
  // Same options as esbuild.mjs's webview bundle (bundle/iife/browser/es2020);
  // the sourcemap is inlined so the emitted page is a single self-contained pair.
  await build({
    entryPoints: [path.join(REPO_ROOT, 'src/webview/previewPanel.ts')],
    outfile: path.join(PAGE_DIR, 'previewPanel.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: 'inline',
    logLevel: 'silent',
  })
  // getPreviewHtml touches exactly two things on its vscode arguments: the CSP
  // source and the script URL. Doubling more than that would be inventing API.
  const webview = { cspSource: 'vscode-webview:' } as unknown as Parameters<typeof getPreviewHtml>[0]
  const scriptUri = { toString: () => './previewPanel.js' } as unknown as Parameters<typeof getPreviewHtml>[1]
  const html = getPreviewHtml(webview, scriptUri, NONCE, codeThemeCss('auto'))
  await writeFile(path.join(PAGE_DIR, 'preview.html'), html, 'utf8')
}

// ---------------------------------------------------------------------------
// Markdown fixtures through the real renderer
// ---------------------------------------------------------------------------

const renderer = new MarkdownRenderer()

/** Production markup for a fixture: real `data-paragraph-index`, real `hljs-*`
 *  spans, real sanitize schema, real lineMap. `fileDir` only reaches the image
 *  resolver, which the default implementation ignores. */
export async function renderMarkdown(markdown: string): Promise<{ html: string; lineMap: LineMapping[] }> {
  return renderer.render(markdown, {} as never)
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

let browser: Browser | undefined
const live = new Set<Preview>()

/** Launch (or reuse) the browser for this worker. A missing Chromium must FAIL —
 *  never skip: a skip turns the release gate into a no-op. */
export async function launchBrowser(): Promise<Browser> {
  if (!browser) browser = await puppeteer.launch({ headless: true })
  return browser
}

/** Close every page and the browser. Call from `afterAll`. */
export async function closeBrowser(): Promise<void> {
  for (const p of [...live]) await p.close()
  await browser?.close()
  browser = undefined
}

// ---------------------------------------------------------------------------
// Public value shapes (everything crossing `evaluate` is plain JSON)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

export interface PageIssue {
  kind: 'pageerror' | 'console' | 'requestfailed'
  /** console message type ('error', 'warning', 'log', …); absent for the others. */
  level?: string
  text: string
}

export interface HighlightRange {
  text: string
  /** False once a re-render detached the node the Range points at — a non-zero
   *  registry size with detached ranges paints nothing. */
  connected: boolean
  /** `data-paragraph-index` of the block the range starts in, or null. */
  blockIndex: number | null
  /** Either endpoint sits inside a gutter control. */
  inBctl: boolean
  startOffset: number
  endOffset: number
  rect: Rect
}

export interface HighlightView {
  size: number
  priority: number
  ranges: HighlightRange[]
}

export interface HitTarget {
  tag: string
  id: string
  className: string
  blockIndex: number | null
  inBctl: boolean
  inButton: boolean
  text: string
}

export interface OpenOptions {
  viewport?: Viewport
}

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
}

type ButtonState = Extract<ExtensionMessage, { type: 'updateButtonState' }>

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * One booted preview page. ONE PER TEST: the bundle keeps module-level state
 * (`displaying`, `translatedHtml`, `commentCounts`, `blockFragments`,
 * `findRanges`, `openThreadIndex`) for the life of the document, so a reused
 * page makes tests order-dependent.
 */
export class Preview {
  private cdp: CDPSession | undefined

  private constructor(
    readonly page: Page,
    private readonly context: BrowserContext,
    private readonly issues: PageIssue[],
  ) {}

  static async open(opts: OpenOptions = {}): Promise<Preview> {
    const b = await launchBrowser()
    const context = await b.createBrowserContext()
    const page = await context.newPage()
    const issues: PageIssue[] = []
    page.on('pageerror', (e) => issues.push({ kind: 'pageerror', text: e.message }))
    page.on('console', (m) => issues.push({ kind: 'console', level: m.type(), text: m.text() }))
    page.on('requestfailed', (r) =>
      issues.push({ kind: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText ?? ''}` }),
    )

    await page.setViewport(opts.viewport ?? DEFAULT_VIEWPORT)
    // `scrollRangeIntoView` scrolls with behavior:'smooth'; an animation would race
    // every position assertion that follows a navigation.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    // previewPanel.ts calls acquireVsCodeApi at module top level, so the stub has to
    // exist before the document runs any script — CDP injection, not a page script,
    // so the CSP does not apply to it.
    await page.evaluateOnNewDocument(() => {
      window.__posted = []
      ;(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: WebviewMessage) => {
          window.__posted.push(m)
        },
        getState: () => undefined,
        setState: () => undefined,
      })
    })

    await page.goto(PAGE_URL, { waitUntil: 'load' })
    await page.addStyleTag({ content: THEME_VARS_CSS })
    await page.evaluate(() => {
      document.body.classList.add('vscode-dark')
    })
    // Metrics differ until the fonts settle; every geometry oracle depends on this.
    await page.evaluate(() => document.fonts.ready.then(() => undefined))

    const preview = new Preview(page, context, issues)
    try {
      await page.waitForFunction(() => window.__posted.length > 0, { timeout: 10_000 })
    } catch {
      await preview.close()
      throw new Error(`the webview bundle never booted. Page issues: ${JSON.stringify(issues, null, 2)}`)
    }
    live.add(preview)
    return preview
  }

  // --- host → webview -------------------------------------------------------

  /** Deliver a host message exactly as the extension host does. Typed as the real
   *  union: a new variant with no webview case becomes a compile-visible gap. */
  async send(message: ExtensionMessage): Promise<void> {
    await this.page.evaluate((m) => {
      window.postMessage(m, '*')
    }, message as unknown as Record<string, unknown>)
    await this.drain()
  }

  /** Render a Markdown fixture through the REAL renderer and show it. Returns the
   *  html/lineMap so a scenario can build oracles from the same source of truth.
   *  NB: `showContent` posts `requestComments` — clear the record after arranging. */
  async render(markdown: string, opts: { display?: boolean } = {}): Promise<{ html: string; lineMap: LineMapping[] }> {
    const result = await renderMarkdown(markdown)
    await this.renderHtml(result.html, result.lineMap, opts.display)
    return result
  }

  /** Raw `renderContent` — for fixtures that must NOT come from the renderer
   *  (hostile markup, hand-built structures). */
  async renderHtml(html: string, lineMap: LineMapping[] = [], display?: boolean): Promise<void> {
    const msg: ExtensionMessage =
      display === undefined
        ? { type: 'renderContent', html, lineMap }
        : { type: 'renderContent', html, lineMap, display }
    await this.send(msg)
  }

  /** A complete `updateButtonState` with sane defaults; override what the scenario
   *  is about. Send it BEFORE a translation: a changed `targetLang` drops the
   *  webview's cached translation. */
  async configure(partial: Partial<Omit<ButtonState, 'type'>> = {}): Promise<void> {
    await this.send({
      type: 'updateButtonState',
      translateEnabled: true,
      mode: 'on-demand',
      storageLang: 'en',
      targetLang: 'ru',
      commentsEnabled: true,
      aiAssistantEnabled: false,
      ...partial,
    })
  }

  // --- webview → host -------------------------------------------------------

  /** Everything posted so far, in order. `undefined` properties do not survive the
   *  serialisation boundary — assert absence with `'endIndex' in msg`, not
   *  `toStrictEqual`. */
  async posted(): Promise<WebviewMessage[]> {
    return this.page.evaluate(() => window.__posted)
  }

  async clearPosted(): Promise<void> {
    await this.page.evaluate(() => {
      window.__posted.length = 0
    })
  }

  /** First posted message of `type`, waiting for it to appear. */
  async waitForPost<T extends WebviewMessage['type']>(
    type: T,
    opts: WaitOptions = {},
  ): Promise<Extract<WebviewMessage, { type: T }>> {
    const hit = await this.waitForPosted((m) => m.type === type, opts)
    return hit as Extract<WebviewMessage, { type: T }>
  }

  /** First posted message matching `predicate`. The predicate runs in Node (polling),
   *  so it may close over anything the test has. */
  async waitForPosted(
    predicate: (message: WebviewMessage) => boolean,
    opts: WaitOptions = {},
  ): Promise<WebviewMessage> {
    const timeoutMs = opts.timeoutMs ?? 5000
    const intervalMs = opts.intervalMs ?? 25
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const all = await this.posted()
      const hit = all.find(predicate)
      if (hit) return hit
      if (Date.now() >= deadline) {
        throw new Error(`no posted message matched within ${timeoutMs}ms. Posted: ${JSON.stringify(all)}`)
      }
      await this.wait(intervalMs)
    }
  }

  // --- scheduling -----------------------------------------------------------

  /** Let message delivery + one paint settle. Handlers re-post (`showContent` →
   *  `requestComments`), so a bare `evaluate` is not enough. */
  async drain(): Promise<void> {
    await this.page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(), 0))),
    )
  }

  /** Wait n animation frames (selectionchange is coalesced — 2 is the usual dose). */
  async frames(n = 2): Promise<void> {
    for (let i = 0; i < n; i++) {
      await this.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    }
  }

  /** Real wall-clock wait. HOVER_MS/HIDE_MS/MODAL_MS run inside the page, where
   *  `vi.useFakeTimers()` cannot reach — always wait the window plus margin. */
  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  // --- DOM reads ------------------------------------------------------------

  async rect(selector: string): Promise<Rect | null> {
    return this.page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }
    }, selector)
  }

  /** Rects of every match, in document order (both panes of a bilingual row, all list items …). */
  async rects(selector: string): Promise<Rect[]> {
    return this.page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }
      })
    }, selector)
  }

  /** Viewport-space centre of an element — the coordinate to click or hit-test. */
  async centerOf(selector: string): Promise<{ x: number; y: number }> {
    const r = await this.rect(selector)
    if (!r) throw new Error(`no element matches ${selector}`)
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  /** The `hidden` property. Every dismissible surface uses it; `offsetParent` is
   *  null for position:fixed elements and would mislead you. */
  async hidden(selector: string): Promise<boolean> {
    const value = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null
      return el ? el.hidden : null
    }, selector)
    if (value === null) throw new Error(`no element matches ${selector}`)
    return value
  }

  async text(selector: string): Promise<string | null> {
    return this.page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selector)
  }

  async count(selector: string): Promise<number> {
    return this.page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
  }

  /** Computed style — the only honest oracle for `display:none`, `:empty` rules and
   *  themed colours. */
  async css(selector: string, property: string): Promise<string | null> {
    return this.page.evaluate(
      ([sel, prop]) => {
        const el = document.querySelector(sel as string)
        return el ? getComputedStyle(el).getPropertyValue(prop as string) : null
      },
      [selector, property],
    )
  }

  async classList(selector: string): Promise<string[] | null> {
    return this.page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el ? Array.from(el.classList) : null
    }, selector)
  }

  async hitTest(x: number, y: number): Promise<HitTarget | null> {
    return this.page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px, py)
        if (!el) return null
        const block = el.closest('[data-paragraph-index]')
        const index = block?.getAttribute('data-paragraph-index')
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          className: el.getAttribute('class') ?? '',
          blockIndex: index === null || index === undefined ? null : Number(index),
          inBctl: el.closest('.bctl') !== null,
          inButton: el.closest('button') !== null,
          text: (el.textContent ?? '').slice(0, 60),
        }
      },
      [x, y],
    )
  }

  /** A CSS Custom Highlight registry entry reduced to JSON (`Highlight`/`Range`
   *  cannot cross the boundary). `null` when the entry does not exist. */
  async highlight(name: string): Promise<HighlightView | null> {
    return this.page.evaluate((n) => {
      const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
      const entry = registry?.get(n) as (Iterable<Range> & { size: number; priority: number }) | undefined
      if (!entry) return null
      const ranges = Array.from(entry).map((r) => {
        const startEl = r.startContainer.parentElement
        const endEl = r.endContainer.parentElement
        const block = startEl?.closest('[data-paragraph-index]') as HTMLElement | null
        const rect = r.getBoundingClientRect()
        return {
          text: r.toString(),
          connected: r.startContainer.isConnected && r.endContainer.isConnected,
          blockIndex: block ? Number(block.dataset.paragraphIndex) : null,
          inBctl: Boolean(startEl?.closest('.bctl')) || Boolean(endEl?.closest('.bctl')),
          startOffset: r.startOffset,
          endOffset: r.endOffset,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        }
      })
      return { size: entry.size, priority: entry.priority, ranges }
    }, name)
  }

  // --- input ----------------------------------------------------------------

  /** Real mouse click at an element's centre. Never `el.click()` in `evaluate`:
   *  `#sel-toolbar` depends on `mousedown → preventDefault` to keep the selection
   *  alive, and a programmatic click skips it. Does not scroll — puppeteer's own
   *  `page.click` scrolls into view, and a scroll hides the toolbar. */
  async click(selector: string, opts: { count?: number; button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    const { x, y } = await this.centerOf(selector)
    await this.clickAt(x, y, opts)
  }

  /** Click at viewport coordinates. `count: 3` is a real triple click — no `delay`,
   *  no movement between presses, or `e.detail` never accumulates. */
  async clickAt(
    x: number,
    y: number,
    opts: { count?: number; button?: 'left' | 'right' | 'middle' } = {},
  ): Promise<void> {
    await this.page.mouse.click(Math.round(x), Math.round(y), {
      count: opts.count ?? 1,
      button: opts.button ?? 'left',
    })
    await this.frames(2)
  }

  /** Move the pointer to an element's centre (a real `mouseover`/`mouseenter`). */
  async hover(selector: string): Promise<void> {
    const { x, y } = await this.centerOf(selector)
    await this.moveMouse(x, y)
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.page.mouse.move(Math.round(x), Math.round(y))
    await this.frames(1)
  }

  /** Type into a field the way a user does (click to focus, then keystrokes). */
  async typeInto(selector: string, text: string, opts: { delay?: number } = {}): Promise<void> {
    await this.click(selector)
    await this.page.keyboard.type(text, { delay: opts.delay ?? 0 })
    await this.drain()
  }

  /** Type into whatever currently has focus — use this for the find input, which
   *  Ctrl+F already focused (clicking it again would prove nothing about focus). */
  async typeText(text: string, opts: { delay?: number } = {}): Promise<void> {
    await this.page.keyboard.type(text, { delay: opts.delay ?? 0 })
    await this.drain()
  }

  async press(
    key: KeyInput,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  ): Promise<void> {
    const held: KeyInput[] = []
    if (mods.ctrl) held.push('Control')
    if (mods.shift) held.push('Shift')
    if (mods.alt) held.push('Alt')
    if (mods.meta) held.push('Meta')
    for (const k of held) await this.page.keyboard.down(k)
    await this.page.keyboard.press(key)
    for (const k of held.reverse()) await this.page.keyboard.up(k)
    await this.drain()
  }

  /** Raw CDP key event: the ONLY way to produce a mismatched `key`/`code` pair, i.e.
   *  the physical key of a non-Latin layout (`code:'KeyF'`, `key:'а'`). puppeteer's
   *  own keyboard fills `key` from a US keymap and would pass against layout bugs.
   *  `modifiers` are the CDP bits — see `MOD`. */
  async key(code: string, keyChar: string, modifiers = 0): Promise<void> {
    const cdp = await this.cdpSession()
    const vk = virtualKeyCode(code)
    const event = {
      code,
      key: keyChar,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    await this.drain()
  }

  // --- selection ------------------------------------------------------------

  /** Real drag-select from a point inside `fromSelector`'s text to a point inside
   *  `toSelector`'s text. Fractions are positions along the element's visible text
   *  (0 = start, 1 = end). Returns the resulting selection text. */
  async dragSelect(
    fromSelector: string,
    toSelector: string = fromSelector,
    opts: { fromFraction?: number; toFraction?: number; steps?: number } = {},
  ): Promise<string> {
    const from = await this.textPoint(fromSelector, opts.fromFraction ?? 0.15)
    const to = await this.textPoint(toSelector, opts.toFraction ?? 0.85)
    await this.page.mouse.move(from.x, from.y)
    await this.page.mouse.down()
    await this.page.mouse.move(to.x, to.y, { steps: opts.steps ?? 10 })
    await this.page.mouse.up()
    await this.frames(2)
    return this.selectionText()
  }

  /** Character-exact selection, built as a Range (no mouse). Use when the endpoints
   *  must land on specific characters — inside `<strong>`/`<code>`, a whitespace-only
   *  run — which a mouse drag cannot hit reliably. Character offsets index the
   *  element's own text nodes, gutter controls excluded (the same text
   *  `wholeBlockRange` sees). Returns the resulting selection text. */
  async selectChars(
    fromSelector: string,
    fromChar: number,
    toSelector: string = fromSelector,
    toChar?: number,
  ): Promise<string> {
    const ok = await this.page.evaluate(
      ([fromSel, fromOffset, toSel, toOffset]) => {
        const locate = (selector: string, offset: number): { node: Text; at: number } | null => {
          const root = document.querySelector(selector)
          if (!root) return null
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let remaining = offset
          let last: Text | undefined
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.parentElement?.closest('.bctl')) continue
            const text = n as Text
            const len = (text.nodeValue ?? '').length
            last = text
            if (remaining <= len) return { node: text, at: remaining }
            remaining -= len
          }
          return last ? { node: last, at: (last.nodeValue ?? '').length } : null
        }
        const start = locate(fromSel as string, fromOffset as number)
        const end = locate(toSel as string, toOffset as number)
        const selection = window.getSelection()
        if (!start || !end || !selection) return false
        const range = document.createRange()
        range.setStart(start.node, start.at)
        range.setEnd(end.node, end.at)
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      },
      [fromSelector, fromChar, toSelector, toChar ?? fromChar] as [string, number, string, number],
    )
    if (!ok) throw new Error(`could not select ${fromSelector}[${fromChar}] .. ${toSelector}[${toChar ?? fromChar}]`)
    await this.frames(2)
    return this.selectionText()
  }

  async selectionText(): Promise<string> {
    return this.page.evaluate(() => window.getSelection()?.toString() ?? '')
  }

  async clearSelection(): Promise<void> {
    await this.page.evaluate(() => {
      window.getSelection()?.removeAllRanges()
    })
    await this.frames(2)
  }

  // --- scrolling ------------------------------------------------------------

  async scrollBy(dy: number): Promise<void> {
    await this.page.evaluate((d) => {
      window.scrollBy(0, d)
    }, dy)
    await this.frames(2)
  }

  async scrollTo(y: number): Promise<void> {
    await this.page.evaluate((top) => {
      window.scrollTo(0, top)
    }, y)
    await this.frames(2)
  }

  // --- diagnostics ----------------------------------------------------------

  /** Every page error, console entry and failed request seen so far. A blocked
   *  resource silently changes the layout you are asserting, so scenarios should
   *  assert this is empty. */
  errors(): PageIssue[] {
    return [...this.issues]
  }

  clearErrors(): void {
    this.issues.length = 0
  }

  async close(): Promise<void> {
    live.delete(this)
    await this.context.close().catch(() => undefined)
  }

  // --- internals ------------------------------------------------------------

  private async cdpSession(): Promise<CDPSession> {
    if (!this.cdp) this.cdp = await this.page.createCDPSession()
    return this.cdp
  }

  /**
   * Viewport point at a fraction through an element's visible text.
   *
   * Rounded to whole pixels ON PURPOSE: a synthetic `mousePressed` at a
   * fractional x does not start a text selection in Chromium at all (verified —
   * an identical drag pressed at x=99 selects, at x=99.5 selects nothing), which
   * would turn every selection scenario into a silent false pass. Real pointer
   * input lands on whole CSS pixels anyway, so this is the faithful coordinate,
   * not a workaround.
   */
  private async textPoint(selector: string, fraction: number): Promise<{ x: number; y: number }> {
    const point = await this.page.evaluate(
      ([sel, f]) => {
        const root = document.querySelector(sel as string)
        if (!root) return null
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.parentElement?.closest('.bctl')) continue
          if ((n.nodeValue ?? '').trim().length === 0) continue
          nodes.push(n as Text)
        }
        const total = nodes.reduce((sum, n) => sum + (n.nodeValue ?? '').length, 0)
        if (total === 0) return null
        let target = Math.min(total - 1, Math.max(0, Math.floor(total * (f as number))))
        for (const node of nodes) {
          const len = (node.nodeValue ?? '').length
          if (target < len) {
            const range = document.createRange()
            range.setStart(node, target)
            range.setEnd(node, target + 1)
            const rect = range.getBoundingClientRect()
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            }
          }
          target -= len
        }
        return null
      },
      [selector, fraction] as [string, number],
    )
    if (!point) throw new Error(`no visible text inside ${selector}`)
    return point
  }
}

/** Boot a fresh page. One per test — see the note on `Preview`. */
export async function openPreview(opts: OpenOptions = {}): Promise<Preview> {
  return Preview.open(opts)
}

const NAMED_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  Space: 32,
  Tab: 9,
  Backspace: 8,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
}

function virtualKeyCode(code: string): number {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
  return NAMED_KEY_CODES[code] ?? 0
}
