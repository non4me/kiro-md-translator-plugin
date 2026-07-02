import type * as vscode from 'vscode'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import type { IMarkdownRenderer, LineMapping, RenderResult } from './types'
import { t } from './l10n'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'])

/** Resolves a relative image path to a URL the webview can load. */
export type ImageResolver = (relativePath: string, fileDir: vscode.Uri) => string

const defaultImageResolver: ImageResolver = (rel) => rel

/**
 * Markdown → sanitized HTML for the Preview_Panel. The display path is
 * mdast → hast → HTML (no `remark-stringify` round-trip). Each `<p>`/`<h1-6>`/
 * `<li>` is annotated with `data-paragraph-index` in document order, and a
 * `lineMap` (paragraphIndex → source line range) is built for scroll sync and
 * surgical write-back. Source and translated renders share the same indices.
 */
export class MarkdownRenderer implements IMarkdownRenderer {
  private readonly cancelled = new Set<string>()

  constructor(private readonly resolveImageUri: ImageResolver = defaultImageResolver) {}

  /** Parse Markdown into a (gfm-transformed) mdast tree. */
  parse(markdown: string): AnyNode {
    const processor = unified().use(remarkParse).use(remarkGfm)
    const tree = processor.parse(markdown)
    return processor.runSync(tree)
  }

  async render(markdown: string, fileDir: vscode.Uri): Promise<RenderResult> {
    if (markdown.trim().length === 0) {
      return { html: this.emptyHtml(), lineMap: [] }
    }
    return this.renderMdast(this.parse(markdown), fileDir)
  }

  /** Convert an existing (possibly translated) mdast tree to a RenderResult. */
  renderMdast(mdast: AnyNode, fileDir: vscode.Uri): RenderResult {
    const hast = unified().use(remarkRehype).runSync(mdast) as AnyNode
    const lineMap = this.buildLineMap(hast)
    const sanitized = unified().use(rehypeSanitize).runSync(hast) as AnyNode
    this.annotate(sanitized)
    this.resolveImages(sanitized, fileDir)
    const html = unified().use(rehypeStringify).stringify(sanitized)
    return { html, lineMap }
  }

  cancel(documentUri: string): void {
    this.cancelled.add(documentUri)
  }

  private emptyHtml(): string {
    return `<p class="empty-content">${t('The file has no content')}</p>`
  }

  /** lineMap from pre-sanitize hast (carries source positions copied by remark-rehype). */
  private buildLineMap(hast: AnyNode): LineMapping[] {
    const lineMap: LineMapping[] = []
    let index = 0
    visit(hast, 'element', (node: AnyNode) => {
      if (!BLOCK_TAGS.has(node.tagName)) return
      const pos = node.position
      lineMap.push({
        paragraphIndex: index,
        startLine: pos ? pos.start.line - 1 : 0,
        endLine: pos ? pos.end.line - 1 : 0,
      })
      index += 1
    })
    return lineMap
  }

  /** Assign data-paragraph-index in document order (post-sanitize so it survives). */
  private annotate(hast: AnyNode): void {
    let index = 0
    visit(hast, 'element', (node: AnyNode) => {
      if (!BLOCK_TAGS.has(node.tagName)) return
      node.properties = node.properties ?? {}
      node.properties.dataParagraphIndex = index
      index += 1
    })
  }

  private resolveImages(hast: AnyNode, fileDir: vscode.Uri): void {
    visit(hast, 'element', (node: AnyNode) => {
      if (node.tagName !== 'img') return
      node.properties = node.properties ?? {}
      const src = node.properties.src
      if (typeof src === 'string' && !/^(https?:|data:|vscode)/i.test(src)) {
        node.properties.src = this.resolveImageUri(src, fileDir)
      }
    })
  }
}
