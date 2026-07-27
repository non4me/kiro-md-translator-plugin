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

  // The test above only ever grows the stack, so it passes even for an
  // implementation that never pops. This one walks back OUT of a deeper level,
  // and asserts the exact joined string — the value is embedded verbatim into the
  // LLM context as "Location: …", so its format is part of the contract.
  it('pops siblings and deeper levels when the trail walks back out', () => {
    const src = [
      '# Doc', //          0
      '', //               1
      '## A', //           2
      '', //               3
      '### A.1', //        4
      '', //               5
      'deep text', //      6
      '', //               7
      '## B', //           8
      '', //               9
      'target line', //   10
      '', //              11
      '# Doc 2', //       12
      '', //              13
      'second doc', //    14
    ].join('\n')

    expect(headingPath(src, 6)).toBe('# Doc › ## A › ### A.1') // descending: baseline
    expect(headingPath(src, 10)).toBe('# Doc › ## B') // ### A.1 and its parent ## A both popped
    expect(headingPath(src, 14)).toBe('# Doc 2') // back to level 1: the whole stack goes
  })

  it('a heading on the start line itself is not part of the path', () => {
    const src = '# Doc\n\n## A\ntarget'
    // The loop is `i < startLine`, so the heading the cursor sits on is excluded.
    expect(headingPath(src, 2)).toBe('# Doc')
    expect(headingPath(src, 3)).toBe('# Doc › ## A')
  })

  it('is empty when nothing precedes the line', () => {
    expect(headingPath('plain text\nmore', 0)).toBe('')
    expect(headingPath('plain text\nmore', 2)).toBe('')
  })
})
