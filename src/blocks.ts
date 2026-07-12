/**
 * Turning a rendered lineMap back into anchorable blocks. Shared by the preview (which
 * has a live lineMap) and the project-wide comment importer (which renders documents
 * headlessly), so the two can never drift apart in how a block's text is sliced.
 */
import type { Block, LineMapping } from './types'

/** Comments always anchor to the STORAGE text, independent of the display mode — so this
 *  only ever sees the raw source, never a translated render. */
export function blocksFromLineMap(lineMap: LineMapping[], source: string): Block[] {
  const lines = source.split('\n')
  return lineMap.map((m) => ({
    paragraphIndex: m.paragraphIndex,
    startLine: m.startLine,
    endLine: m.endLine,
    text: lines.slice(m.startLine, m.endLine + 1).join('\n').trim(),
  }))
}
