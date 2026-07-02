import { describe, it, expect } from 'vitest'
import { t } from '../src/l10n'

// Feature: kiro-md-translator-plugin, Requirement 8: localization wrapper
describe('l10n.t', () => {
  it('returns the message when there are no placeholders', () => {
    expect(t('Подключение успешно')).toBe('Подключение успешно')
  })

  it('substitutes positional placeholders', () => {
    expect(t('Файл сохранён: {0}', 'a.md')).toBe('Файл сохранён: a.md')
    expect(t('{0} из {1}', 1, 2)).toBe('1 из 2')
  })

  it('leaves an unfilled placeholder visible', () => {
    expect(t('Значение: {0}')).toBe('Значение: {0}')
  })
})
