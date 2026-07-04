import { describe, it, expect } from 'vitest'
import { Glossary } from '../src/Glossary'

describe('Glossary', () => {
  it('is a no-op identity transform when empty', () => {
    const g = new Glossary([])
    expect(g.isEmpty).toBe(true)
    const { masked, restore } = g.mask('anything at all')
    expect(masked).toBe('anything at all')
    expect(restore(masked)).toBe('anything at all')
  })

  it('masks a term out of the text and restores it verbatim', () => {
    const g = new Glossary(['GitHub'])
    const { masked, restore } = g.mask('Use GitHub for hosting.')
    expect(masked).not.toContain('GitHub')
    expect(restore(`translated ${masked}`)).toContain('GitHub')
  })

  it('matches on word boundaries so a term does not mask a longer word', () => {
    const g = new Glossary(['cat'])
    const { masked } = g.mask('the category of cat food')
    // "category" must be untouched; the standalone "cat" must be masked
    expect(masked).toContain('category')
    expect(masked).not.toMatch(/\bcat\b/)
  })

  it('applies longer terms first so a short term does not split a long one', () => {
    const g = new Glossary(['Git', 'GitHub Actions'])
    const { masked, restore } = g.mask('CI runs on GitHub Actions today')
    expect(masked).not.toContain('GitHub Actions')
    expect(restore(masked)).toContain('GitHub Actions')
  })

  it('restores multiple occurrences and multiple terms', () => {
    const g = new Glossary(['API', 'SDK'])
    const src = 'API then SDK then API again'
    const { masked, restore } = g.mask(src)
    for (const t of ['API', 'SDK']) expect(masked).not.toContain(t)
    expect(restore(masked)).toBe(src)
  })

  it('handles terms with regex-special / non-word edge characters', () => {
    const g = new Glossary(['C++'])
    const { masked, restore } = g.mask('written in C++ mostly')
    expect(masked).not.toContain('C++')
    expect(restore(masked)).toContain('C++')
  })

  it('matches non-ASCII (Cyrillic) terms on word boundaries, not as substrings', () => {
    const g = new Glossary(['код'])
    const { masked, restore } = g.mask('кодировка использует код тут')
    // the longer word 'кодировка' must be untouched; standalone 'код' is masked
    expect(masked).toContain('кодировка')
    expect(masked).not.toMatch(/(^|[^\p{L}\p{N}])код([^\p{L}\p{N}]|$)/u)
    expect(restore(masked)).toContain('код')
  })

  it('ignores purely-numeric terms (they never translate and would corrupt sentinels)', () => {
    // The bare-digit term '1' previously matched the index inside a sentinel ⟦1⟧.
    const g = new Glossary(['Foo', 'Bar', '1'])
    const m = g.mask('Foo Bar Bar')
    expect(m.restore(m.masked)).toBe('Foo Bar Bar') // no corruption / no lost 'Bar'
    // a real term alongside numbers still round-trips
    const g2 = new Glossary(['API', '42'])
    const m2 = g2.mask('API has 42 routes')
    expect(m2.masked).not.toContain('API')
    expect(m2.restore(m2.masked)).toContain('API')
  })
})
