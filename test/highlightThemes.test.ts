import { describe, it, expect } from 'vitest'
import { codeThemeCss } from '../src/highlightThemes'

// Feature: code syntax highlighting, req 12 — the theme is a stylesheet swap.
describe('codeThemeCss (req 12)', () => {
  it('off yields no stylesheet', () => {
    expect(codeThemeCss('off')).toBe('')
  })

  it('a named theme is emitted verbatim (unscoped, applies globally)', () => {
    const css = codeThemeCss('monokai')
    expect(css).toContain('.hljs')
    expect(css).toContain('#272822') // monokai background
    expect(css).not.toContain('.vscode-') // not gated on the editor theme
  })

  it('auto scopes BOTH a dark and a light theme under the editor body classes', () => {
    const css = codeThemeCss('auto')
    expect(css).toContain('.vscode-dark .hljs')
    expect(css).toContain('.vscode-high-contrast .hljs') // dark HC shares the dark theme
    expect(css).toContain('.vscode-light .hljs')
    expect(css).toContain('.vscode-high-contrast-light .hljs')
    expect(css).toContain('#0d1117') // github-dark background (dark bucket)
    expect(css).toContain('#fff') // github light background (light bucket)
  })

  it('auto strips license comments so nothing outside a scoped rule leaks', () => {
    // A raw `/* … */` would sit unscoped and could carry an unprefixed selector.
    expect(codeThemeCss('auto')).not.toContain('/*')
  })

  it('every auto rule is gated on an editor-theme class (no global .hljs leak)', () => {
    // Each rule is `selector{body}`; the selector must name a .vscode- scope, else it
    // would colour both light and dark at once.
    const rules = codeThemeCss('auto').match(/[^{}]+\{[^{}]*\}/g) ?? []
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf('{'))
      expect(selector).toContain('.vscode-')
    }
  })

  it('an unrecognised theme name falls back to no stylesheet', () => {
    // @ts-expect-error deliberately invalid theme id
    expect(codeThemeCss('does-not-exist')).toBe('')
  })
})
