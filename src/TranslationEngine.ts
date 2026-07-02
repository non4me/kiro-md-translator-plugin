import type * as vscode from 'vscode'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { visit } from 'unist-util-visit'
import {
  type ITranslationCache,
  type ITranslationEngine,
  type ITranslationProvider,
  type LanguageCode,
  type LineMapping,
  type RenderResult,
  TranslatorError,
} from './types'
import { MarkdownRenderer } from './MarkdownRenderer'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TranslatorError('TRANSLATION_TIMEOUT', 'Translation cancelled')
  }
}

/**
 * Orchestrates the translation pipeline: extract translatable text nodes
 * (skipping code/inlineCode/url — they are distinct node types / properties, so
 * collecting only `text` nodes excludes them — Property 2), cache lookup, a
 * single batched provider call for misses, structure-preserving re-insertion,
 * then mdast → HTML for display (no markdown round-trip). `remark-stringify` is
 * used ONLY for the export path (a new file), never to overwrite the source.
 */
export class TranslationEngine implements ITranslationEngine {
  constructor(
    private readonly getProvider: () => ITranslationProvider,
    private readonly cache: ITranslationCache,
    private readonly renderer: MarkdownRenderer,
  ) {}

  async translate(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
    fileDir: vscode.Uri,
  ): Promise<RenderResult> {
    const mdast = await this.translateMdast(markdown, sourceLang, targetLang, signal)
    return this.renderer.renderMdast(mdast, fileDir)
  }

  /** Translate and serialize back to Markdown — for the export path only (req 6.3). */
  async translateToMarkdown(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string> {
    const mdast = await this.translateMdast(markdown, sourceLang, targetLang, signal)
    return unified().use(remarkGfm).use(remarkStringify).stringify(mdast)
  }

  async translateParagraph(
    text: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string> {
    const [result] = await this.translateSegments([text], sourceLang, targetLang, signal)
    return result
  }

  replaceParagraphInSource(
    source: string,
    lineMap: LineMapping[],
    paragraphIndex: number,
    newStorageText: string,
  ): string {
    const mapping = lineMap.find((m) => m.paragraphIndex === paragraphIndex)
    if (!mapping) return source
    const lines = source.split('\n')
    const before = lines.slice(0, mapping.startLine)
    const after = lines.slice(mapping.endLine + 1)
    return [...before, ...newStorageText.split('\n'), ...after].join('\n')
  }

  /** Parse, translate text nodes in place, return the mutated mdast. */
  private async translateMdast(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<AnyNode> {
    assertNotAborted(signal)
    const mdast = this.renderer.parse(markdown)

    const textNodes: AnyNode[] = []
    visit(mdast, 'text', (node: AnyNode) => {
      if (typeof node.value === 'string' && node.value.trim().length > 0) {
        textNodes.push(node)
      }
    })

    const segments = textNodes.map((n) => n.value as string)
    const translations = await this.translateSegments(segments, sourceLang, targetLang, signal)
    textNodes.forEach((node, i) => {
      node.value = translations[i]
    })
    return mdast
  }

  /**
   * Translate a list of segments: serve cache hits, batch the misses through
   * one provider call, populate the cache. Order is preserved.
   */
  private async translateSegments(
    segments: string[],
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string[]> {
    const results: Array<string | undefined> = segments.map((s) => this.cache.get(s, targetLang))

    const missIndices: number[] = []
    const missSegments: string[] = []
    results.forEach((r, i) => {
      if (r === undefined) {
        missIndices.push(i)
        missSegments.push(segments[i])
      }
    })

    if (missSegments.length > 0) {
      assertNotAborted(signal)
      const translated = await this.getProvider().translateBatch(
        missSegments,
        sourceLang,
        targetLang,
        signal,
      )
      assertNotAborted(signal)
      missIndices.forEach((segIndex, k) => {
        const raw = translated[k]
        // An empty/whitespace field counts as "no translation" → keep the
        // source text (per-segment analogue of req 3.14); do not cache it.
        if (typeof raw === 'string' && raw.trim().length > 0) {
          this.cache.set(segments[segIndex], targetLang, raw)
          results[segIndex] = raw
        } else {
          results[segIndex] = segments[segIndex]
        }
      })
    }

    return results.map((r, i) => r ?? segments[i])
  }
}
