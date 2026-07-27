/**
 * E12 — the markdown pipeline loads AND executes under Electron's CommonJS runtime.
 *
 * Every runtime dependency (unified, remark-parse, remark-gfm, remark-rehype,
 * rehype-highlight, rehype-sanitize, rehype-stringify, unist-util-visit,
 * hast-util-from-html) is pure ESM, and esbuild flattens the whole graph into ONE
 * CommonJS file with `vscode` external. Vitest loads those same modules as real ESM
 * through Vite — a different module system, which cannot answer this question.
 *
 * Activation alone only proves the graph LOADS. It does not prove the pipeline
 * RUNS: the only place it executes in the host is `PreviewController.renderNow`,
 * whose failure is caught and turned into a webview-only error message. A pipeline
 * that throws on every document therefore ships as "the preview shows an error",
 * with nothing in the logs.
 *
 * CAVEAT to keep in mind: this is a SECOND copy of the modules, bundled by the same
 * options but a separate esbuild invocation, so tree-shaking differences make it a
 * strong signal about the production bundle rather than a proof.
 *
 * Deliberately NOT asserting on HTML content, sanitization or lineMap values — that
 * is test/MarkdownRenderer.test.ts's job and it does it better. The only question
 * here is whether the graph survives ESM -> CJS bundling and executes.
 */
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { MarkdownRenderer } from '../../../src/MarkdownRenderer'
import { getNonce } from '../../../src/webview/nonce'
import { activatedExtension, readText, wsUri, workspaceDir } from './helpers/host'

describe('E12: the bundled markdown pipeline executes in the host', () => {
  before(async function () {
    this.timeout(60_000)
    await activatedExtension()
  })

  it('renders the fixture, which exercises every node kind that pulls a different dependency', async () => {
    // Heading, paragraph, emphasis, inline code, link, both list kinds, a GFM table
    // (remark-gfm), a fenced ts block (rehype-highlight), a relative image (the URI
    // resolver) and a block quote.
    const source = await readText(wsUri('sample.md'))
    const renderer = new MarkdownRenderer((rel) => `resolved:${rel}`)

    const out = await renderer.render(source, vscode.Uri.file(workspaceDir()))

    assert.ok(out.html.length > 0, 'the pipeline produced no HTML')
    assert.ok(out.lineMap.length > 0, 'the pipeline produced no lineMap')
    assert.ok(
      out.html.includes('data-paragraph-index'),
      'no block was indexed — scroll sync and surgical write-back both key on this attribute',
    )
  })

  it('resolves node:crypto inside the packaged bundle', async () => {
    // src/webview/nonce.ts pulls node:crypto into the HOST bundle (the preview's CSP
    // nonce). An import that fails to resolve after bundling breaks every preview.
    const nonce = getNonce()
    assert.ok(nonce.length > 0)
    // The CSP `script-src 'nonce-...'` directive only accepts base64 characters; the
    // implementation strips everything else, so anything left must be alphanumeric.
    assert.match(nonce, /^[A-Za-z0-9]+$/)
  })
})
