import { describe, it, expect } from 'vitest'
import { extractEdit } from '../src/assistant/editFence'

describe('extractEdit', () => {
  it('returns the rmt-edit fence body', () => {
    const reply = 'Sure.\n```rmt-edit\nThe new paragraph.\n```\nDone.'
    expect(extractEdit(reply)).toBe('The new paragraph.')
  })
  it('ignores ordinary code fences', () => {
    expect(extractEdit('Here is code:\n```ts\nconst x = 1\n```')).toBeUndefined()
  })
  it('takes the LAST rmt-edit fence when several exist', () => {
    expect(extractEdit('```rmt-edit\nfirst\n```\n```rmt-edit\nsecond\n```')).toBe('second')
  })
})
