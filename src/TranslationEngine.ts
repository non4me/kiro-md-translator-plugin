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
import { Glossary } from './Glossary'
import { commentSpans, fencedBody, spliceComments } from './codeComments'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TranslatorError('TRANSLATION_TIMEOUT', 'Translation cancelled')
  }
}

/** One tree node's contribution to the flat segment list, plus the way back.
 *  A `text` node yields one segment; a `code` node yields one per comment. */
interface Unit {
  segments: string[]
  apply(translated: string[]): void
}

/** Collect the translatable units of an mdast tree: `text` node values, and the
 *  prose of comments inside `code` nodes (req 3.22). Shared by the whole-document
 *  path and the single-block path so both exclude code identically. */
function collectUnits(mdast: AnyNode): Unit[] {
  const units: Unit[] = []
  visit(mdast, (node: AnyNode) => {
    if (typeof node.value !== 'string') return
    if (node.type === 'text' && node.value.trim().length > 0) {
      units.push({
        segments: [node.value],
        apply: ([translated]) => {
          node.value = translated
        },
      })
      return
    }
    if (node.type === 'code') {
      const body = node.value as string
      const spans = commentSpans(body, node.lang)
      if (spans.length === 0) return
      units.push({
        segments: spans.map((s) => s.text),
        apply: (translated) => {
          node.value = spliceComments(body, spans, translated)
        },
      })
    }
  })
  return units
}

/** A line that opens a fenced code block — used to decide whether a single block's
 *  text hides a code fence (a list item wrapping one), which must NOT be sent whole. */
const CONTAINS_FENCE = /^[ \t]*(`{3,}|~{3,})/m

/** A GFM table row (a `<tr>` block's text). Only the cell text is translatable —
 *  the `|` scaffolding must survive verbatim. */
const TABLE_ROW = /^\s*\|.*\|\s*$/

/**
 * Orchestrates the translation pipeline: extract translatable segments, cache
 * lookup, a single batched provider call for misses, structure-preserving
 * re-insertion, then mdast → HTML for display (no markdown round-trip).
 * `remark-stringify` is used ONLY for the export path (a new file), never to
 * overwrite the source.
 *
 * Segments come from `text` nodes and from the PROSE OF COMMENTS inside `code`
 * nodes (req 3.22). `inlineCode` and link `url`s are distinct node types /
 * properties and are never collected, so they stay excluded (Property 2). Code
 * outside its comments is never sent and never altered (Property 24) — see
 * `codeComments.ts` for why that holds by construction.
 */
export class TranslationEngine implements ITranslationEngine {
  constructor(
    private readonly getProvider: () => ITranslationProvider,
    private readonly cache: ITranslationCache,
    private readonly renderer: MarkdownRenderer,
    /** Do-not-translate terms (req 3.18). Defaults to none for isolated use. */
    private readonly getGlossary: () => string[] = () => [],
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

  /**
   * One block's text (hover tooltip, edit modal). A fenced code block is scanned
   * for comments like any other code block — WITHOUT this branch the modal would
   * hand the provider the entire program, which is exactly what req 3.7 forbids.
   * The fence delimiters are copied verbatim and are added to the forbidden set,
   * so a translation can never close the fence early.
   */
  async translateParagraph(
    text: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string> {
    const fence = fencedBody(text)
    if (fence) {
      const body = text.slice(fence.start, fence.end)
      const spans = commentSpans(body, fence.lang).map((s) => ({
        ...s,
        forbidden: [...s.forbidden, fence.fence],
      }))
      if (spans.length === 0) return text
      const translated = await this.translateSegments(
        spans.map((s) => s.text),
        sourceLang,
        targetLang,
        signal,
      )
      return text.slice(0, fence.start) + spliceComments(body, spans, translated) + text.slice(fence.end)
    }
    // A GFM table row: wrap it as a one-row table so remark splits the cells, then
    // translate only the cell text and take the row back — the `|` scaffolding is
    // never sent. (A bare row is not a table without a separator line.)
    if (TABLE_ROW.test(text)) {
      const cols = (text.match(/(?<!\\)\|/g)?.length ?? 1) - 1
      if (cols >= 1) {
        const row = await this.translateMarkdownFragment(
          `${text}\n|${' --- |'.repeat(cols)}`,
          sourceLang,
          targetLang,
          signal,
        )
        return row === undefined ? text : row.split('\n')[0].trimEnd()
      }
    }
    // A block that merely STARTS with prose can still hide a fenced code block — a
    // list item wrapping one. Sending it as a single segment would leak the code to
    // the provider (req 3.7). Route it through the same unit walk instead, which
    // sends only prose + comment text; the reassembled markdown is display-only
    // (hover tooltip / edit-modal target field), never written to disk.
    if (CONTAINS_FENCE.test(text)) {
      const out = await this.translateMarkdownFragment(text, sourceLang, targetLang, signal)
      return out === undefined ? text : out.trimEnd()
    }
    const [result] = await this.translateSegments([text], sourceLang, targetLang, signal)
    return result
  }

  /** Parse a markdown fragment, translate its units (text + code comments), and
   *  serialize it back. Display-only (never written to disk), so the stringify
   *  round-trip is acceptable here. Returns undefined if there was nothing to translate. */
  private async translateMarkdownFragment(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const mdast = this.renderer.parse(markdown)
    const units = collectUnits(mdast)
    if (units.length === 0) return undefined
    const translated = await this.translateSegments(
      units.flatMap((u) => u.segments),
      sourceLang,
      targetLang,
      signal,
    )
    let at = 0
    for (const unit of units) {
      unit.apply(translated.slice(at, at + unit.segments.length))
      at += unit.segments.length
    }
    return unified().use(remarkGfm).use(remarkStringify).stringify(mdast)
  }

  /** Surgically replace one block — or a whole block RANGE (req 10.16) — with new source
   *  text, splicing exactly the lines [firstBlock.startLine .. lastBlock.endLine] and leaving
   *  everything else byte-identical (never a full re-serialize). `lastIndex` defaults to
   *  `paragraphIndex`, so the single-block call (req 7.14) is unchanged; min/max guards an
   *  inverted pair. */
  replaceParagraphInSource(
    source: string,
    lineMap: LineMapping[],
    paragraphIndex: number,
    newStorageText: string,
    lastIndex: number = paragraphIndex,
  ): string {
    const first = lineMap.find((m) => m.paragraphIndex === paragraphIndex)
    const last = lineMap.find((m) => m.paragraphIndex === lastIndex)
    if (!first || !last) return source
    const startLine = Math.min(first.startLine, last.startLine)
    const endLine = Math.max(first.endLine, last.endLine)
    const lines = source.split('\n')
    const before = lines.slice(0, startLine)
    const after = lines.slice(endLine + 1)
    return [...before, ...newStorageText.split('\n'), ...after].join('\n')
  }

  /** Parse, translate in place, return the mutated mdast. Only `value` is touched —
   *  `position` keeps pointing at the ORIGINAL source range, which is what lets the
   *  lineMap stay correct however much longer a translation is. */
  private async translateMdast(
    markdown: string,
    sourceLang: LanguageCode,
    targetLang: LanguageCode,
    signal: AbortSignal,
  ): Promise<AnyNode> {
    assertNotAborted(signal)
    const mdast = this.renderer.parse(markdown)

    const units = collectUnits(mdast)
    const flat = units.flatMap((u) => u.segments)
    const translations = await this.translateSegments(flat, sourceLang, targetLang, signal)
    let at = 0
    for (const unit of units) {
      unit.apply(translations.slice(at, at + unit.segments.length))
      at += unit.segments.length
    }
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
      // Mask glossary terms so they are never sent to the provider and are
      // restored verbatim afterwards (req 3.18). Empty glossary → identity.
      const glossary = new Glossary(this.getGlossary())
      const masks = missSegments.map((s) => glossary.mask(s))
      const translated = await this.getProvider().translateBatch(
        masks.map((m) => m.masked),
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
          // Restore glossary terms before caching, so the cache stores the final
          // (restored) text keyed by the ORIGINAL unmasked segment.
          const restored = masks[k].restore(raw)
          this.cache.set(segments[segIndex], targetLang, restored)
          results[segIndex] = restored
        } else {
          results[segIndex] = segments[segIndex]
        }
      })
    }

    return results.map((r, i) => r ?? segments[i])
  }
}
