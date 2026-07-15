import type { AssistantMessage } from './types'

export interface ContextInput {
  systemPrompt: string
  selection: string
  selectionIsTranslated: boolean
  sourceOfSelectedBlocks: string
  fullDocument: string
  headingPath: string
  comments: string[]
  tokenBudget: number
}

/** ATX heading trail above `startLine` (0-based), e.g. "## 3 › ### 3.4". */
export function headingPath(source: string, startLine: number): string {
  const lines = source.split('\n')
  const stack: Array<{ level: number; text: string }> = []
  for (let i = 0; i < startLine && i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (!m) continue
    const level = m[1].length
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, text: `${m[1]} ${m[2].trim()}` })
  }
  return stack.map((s) => s.text).join(' › ')
}

function commentsBlock(comments: string[]): string {
  if (!comments.length) return ''
  return `\n\nExisting comments on this fragment:\n${comments.map((c) => `- ${c}`).join('\n')}`
}

/** Assemble the initial [system, user] context (req 5). Full doc within budget,
 *  else a degraded context that names its own trimming (req 5.2). */
export function buildContext(input: ContextInput): AssistantMessage[] {
  const fits = input.fullDocument.length <= input.tokenBudget * 4
  const selNote = input.selectionIsTranslated
    ? `The user highlighted this display (translated) text: "${input.selection}". The authoritative source of the block(s) it touches is below; edits must be in the source language.`
    : `The user selected: "${input.selection}".`
  const heading = input.headingPath ? `\nLocation: ${input.headingPath}` : ''
  const source = `\n\nSource of the selected block(s):\n${input.sourceOfSelectedBlocks}`
  const doc = fits
    ? `\n\nFull document:\n${input.fullDocument}`
    : `\n\n(Context trimmed: the document is too large to include in full; only the selection, its blocks, and nearby headings are provided.)`
  const user = `${selNote}${heading}${source}${doc}${commentsBlock(input.comments)}`
  return [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: user },
  ]
}
