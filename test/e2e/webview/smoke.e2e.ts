import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeBrowser, openPreview, type Preview } from './harness'

/*
 * Feature: webview e2e harness, Scenario E1 — boot smoke + capability self-check.
 *
 * This scenario guards the harness itself, and it is the reason the rest of the
 * suite can be believed:
 *
 *  - The bundle feature-detects the CSS Custom Highlight API (`HL_OK`). On a
 *    browser without it, every highlight function returns silently — the find
 *    bar, the comment fragment tint and the active-fragment paint would all
 *    "pass" while asserting nothing. So the capability is asserted HERE, once,
 *    as a hard failure. Never as a skip.
 *  - The page must be the production one: the real CSP meta tag, the real
 *    nonce'd external script. If the harness ever drifts into hand-written
 *    markup, these assertions are what notices.
 *  - Every `--vscode-*` custom property the stylesheet uses WITHOUT a fallback
 *    must actually be defined. An unset one makes the whole declaration invalid
 *    (no background at all), which would quietly void every later
 *    computed-style oracle instead of failing it.
 */
describe('E1 webview boot smoke', () => {
  let preview: Preview | undefined

  afterEach(async () => {
    await preview?.close()
    preview = undefined
  })
  afterAll(closeBrowser)

  it('boots the production page in a browser that can run every observable', async () => {
    preview = await openPreview()

    // The handshake: the bundle reached the end of its module body and said so,
    // and it said nothing else on the way.
    expect(await preview.posted()).toEqual([{ type: 'ready' }])

    // This really is the production page, not a stand-in.
    const page = await preview.page.evaluate(() => ({
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
      scriptSrc: document.querySelector('script')?.getAttribute('src') ?? '',
      scriptNonce: document.querySelector('script')?.getAttribute('nonce') ?? '',
      contentReady: document.getElementById('content')?.getAttribute('aria-busy') ?? null,
    }))
    expect(page.csp).toContain(`default-src 'none'`)
    expect(page.csp).toContain(`script-src 'nonce-`)
    expect(page.scriptSrc).toBe('./previewPanel.js')
    expect(page.scriptNonce).not.toBe('')
    expect(page.contentReady).toBe('false')

    // Capability self-check: without these three, ~6 scenarios are theatre.
    const highlightApi = await preview.page.evaluate(() => ({
      ctor: typeof (window as unknown as { Highlight?: unknown }).Highlight,
      registry: Boolean((CSS as unknown as { highlights?: unknown }).highlights),
      set: typeof (CSS as unknown as { highlights?: { set?: unknown } }).highlights?.set,
    }))
    expect(highlightApi).toEqual({ ctor: 'function', registry: true, set: 'function' })

    // Every no-fallback theme token the stylesheet references resolves to a value.
    const missingTokens = await preview.page.evaluate(() => {
      const css = document.querySelector('style')?.textContent ?? ''
      const required = new Set<string>()
      const pattern = /var\(\s*(--vscode-[\w-]+)\s*([,)])/g
      for (let m = pattern.exec(css); m; m = pattern.exec(css)) {
        if (m[2] === ')') required.add(m[1]) // no fallback → the declaration dies without it
      }
      const root = getComputedStyle(document.documentElement)
      return [...required].filter((token) => root.getPropertyValue(token).trim() === '').sort()
    })
    expect(missingTokens).toEqual([])

    // A blocked resource or a thrown listener would silently reshape everything
    // measured after it.
    expect(preview.errors()).toEqual([])
  })
})
