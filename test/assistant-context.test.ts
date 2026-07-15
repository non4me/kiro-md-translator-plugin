import { describe, it, expect } from 'vitest'
import { buildContext, headingPath } from '../src/assistant/context'

const base = {
  systemPrompt: 'SYS',
  selection: 'the widget',
  selectionIsTranslated: false,
  sourceOfSelectedBlocks: 'The widget does X.',
  headingPath: '## 3 › ### 3.4',
  comments: ['must be idempotent'],
}

describe('buildContext', () => {
  it('includes the full document when it fits the budget', () => {
    const msgs = buildContext({ ...base, fullDocument: 'SHORT DOC', tokenBudget: 10_000 })
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(msgs[1].content).toContain('SHORT DOC')
    expect(msgs[1].content).toContain('the widget')
    expect(msgs[1].content).toContain('must be idempotent')
  })
  it('degrades and says so when the document exceeds the budget', () => {
    const huge = 'x'.repeat(100_000)
    const msgs = buildContext({ ...base, fullDocument: huge, tokenBudget: 100 })
    expect(msgs[1].content).not.toContain(huge)
    expect(msgs[1].content.toLowerCase()).toContain('trimmed')
    expect(msgs[1].content).toContain('The widget does X.')
  })
})

describe('headingPath', () => {
  it('joins ATX headings above the line', () => {
    const src = '# Doc\n\n## 3 Section\n\ntext\n\n### 3.4 Sub\n\ntarget line'
    expect(headingPath(src, 8)).toContain('3.4 Sub')
  })
})
