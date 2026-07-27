import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * The host↔webview protocol is two discriminated unions in src/types.ts, and CLAUDE.md
 * makes them the contract: add a variant there first, then handle it on both sides.
 * Nothing enforced the other direction — that every declared variant is actually SENT.
 *
 * `paragraphHoverEnd` drifted exactly that way: the webview stopped posting it, the host
 * kept answering it, and the union kept advertising an interaction that no longer
 * existed. An integration test even asserted the handler, by synthesising a message the
 * product never produces. This pins the union to reality from now on.
 */

const SRC = fileURLToPath(new URL('../src/types.ts', import.meta.url))
const WEBVIEW_ENTRY = fileURLToPath(new URL('../src/webview/previewPanel.ts', import.meta.url))
const HOST_ENTRY = fileURLToPath(new URL('../src/ActivationController.ts', import.meta.url))

/** The `type: '…'` literals of one union in types.ts, read from the source text. */
function variantsOf(union: 'WebviewMessage' | 'ExtensionMessage'): string[] {
  const text = readFileSync(SRC, 'utf8')
  const start = text.indexOf(`export type ${union} =`)
  expect(start, `${union} not found in types.ts`).toBeGreaterThan(-1)
  // The union ends at the next top-level declaration.
  const rest = text.slice(start + 1)
  const end = rest.search(/\nexport (type|interface|class|function|const) /)
  const body = end === -1 ? rest : rest.slice(0, end)
  const names = [...body.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1])
  return [...new Set(names)]
}

/** Bundle an entry point the way the real build does, and return its code as text. */
async function bundleOf(entry: string, platform: 'browser' | 'node'): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: platform === 'browser' ? 'iife' : 'cjs',
    platform,
    target: 'es2020',
    external: platform === 'node' ? ['vscode'] : [],
    logLevel: 'silent',
  })
  return out.outputFiles.map((f) => f.text).join('\n')
}

/**
 * Variants of `WebviewMessage` that the webview legitimately never posts, because the
 * HOST synthesises them to reuse the controller's handler. Each one is named here with
 * its injection point, so the exception is a decision on the record rather than a hole
 * the next dead variant can slip through.
 */
const HOST_INJECTED: Record<string, string> = {
  // The Command Palette entry bridges into the same handler the preview would use:
  // ActivationController registers `kiro-md-translator.saveTranslation` and calls
  // `this.active?.onWebviewMessage({ type: 'saveTranslation' })`.
  saveTranslation: 'ActivationController command bridge',
}

describe('host ↔ webview protocol', () => {
  it('every WebviewMessage variant is really sent by the webview or injected by the host', async () => {
    const declared = variantsOf('WebviewMessage')
    expect(declared.length).toBeGreaterThan(10) // the reader works at all

    const code = await bundleOf(WEBVIEW_ENTRY, 'browser')
    // The bundle keeps the literals verbatim: every post site writes `type: 'name'`.
    const unsent = declared.filter(
      (name) => !code.includes(`"${name}"`) && !code.includes(`'${name}'`) && !(name in HOST_INJECTED),
    )
    expect(unsent, 'declared but never posted by the webview').toEqual([])

    // The allowlist must not outlive its entries, or it becomes the hole it exists to close.
    const hostCode = await bundleOf(HOST_ENTRY, 'node')
    for (const name of Object.keys(HOST_INJECTED)) {
      expect(declared, `${name} is allowlisted but no longer declared`).toContain(name)
      expect(
        hostCode.includes(`"${name}"`) || hostCode.includes(`'${name}'`),
        `${name} is allowlisted as host-injected (${HOST_INJECTED[name]}) but the host never sends it`,
      ).toBe(true)
    }
  }, 30_000)

  it('every ExtensionMessage variant is really sent by the host', async () => {
    const declared = variantsOf('ExtensionMessage')
    expect(declared.length).toBeGreaterThan(10)

    const code = await bundleOf(HOST_ENTRY, 'node')
    const unsent = declared.filter((name) => !code.includes(`"${name}"`) && !code.includes(`'${name}'`))
    expect(unsent, 'declared but never posted by the host').toEqual([])
  }, 30_000)

  it('every WebviewMessage variant is really handled by the host', async () => {
    const declared = variantsOf('WebviewMessage')
    const code = await bundleOf(HOST_ENTRY, 'node')
    const unhandled = declared.filter((name) => !code.includes(`"${name}"`) && !code.includes(`'${name}'`))
    expect(unhandled, 'posted by the webview but never handled by the host').toEqual([])
  }, 30_000)
})
