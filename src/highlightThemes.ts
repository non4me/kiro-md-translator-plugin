import type { CodeHighlightTheme } from './types'
import { HLJS_CSS } from './highlightThemesData'

/**
 * The CSS that colours highlight.js output for a chosen theme (req 12). The
 * markup highlight.js emits (`.hljs`, `.hljs-keyword`, …) is identical for every
 * theme — only this stylesheet differs — so switching a theme is a stylesheet
 * swap, never a re-render (see `setCodeTheme` handling in the webview).
 *
 * - `off`  → no colours; code is monospaced in the base block styling.
 * - `auto` → BOTH the light and the dark theme, each scoped under the editor's
 *   `vscode-light` / `vscode-dark` body class, so the preview follows the editor
 *   theme with zero JavaScript and no host round-trip on an editor theme change.
 * - a named theme → that theme's stylesheet verbatim.
 */

/** github-dark / github(light) back the `auto` pair — neutral, high-contrast defaults. */
const AUTO_DARK = 'github-dark'
const AUTO_LIGHT = 'github-light'

const COMMENT = /\/\*[\s\S]*?\*\//g
const RULE = /([^{}]+)\{([^{}]*)\}/g

/** Prefix every selector of a flat stylesheet with each scope, so the theme only
 *  applies under that editor-theme class. The highlight.js theme files are flat
 *  (no `@media`, no nesting), which is what makes this safe. */
function scopeCss(css: string, scopes: readonly string[]): string {
  return css.replace(COMMENT, '').replace(RULE, (_m, sel: string, body: string) => {
    const selectors = sel
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const scoped = selectors.flatMap((s) => scopes.map((sc) => `${sc} ${s}`))
    return `${scoped.join(',')}{${body}}`
  })
}

export function codeThemeCss(theme: CodeHighlightTheme): string {
  if (theme === 'off') return ''
  if (theme === 'auto') {
    const dark = HLJS_CSS[AUTO_DARK]
    const light = HLJS_CSS[AUTO_LIGHT]
    return (
      scopeCss(dark, ['.vscode-dark', '.vscode-high-contrast']) +
      scopeCss(light, ['.vscode-light', '.vscode-high-contrast-light'])
    )
  }
  return HLJS_CSS[theme] ?? ''
}
