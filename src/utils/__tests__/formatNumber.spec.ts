import { beforeEach, describe, expect, it, vi } from 'vitest'

const language = vi.hoisted(() => ({ value: 'en' }))
vi.mock('@/i18n', () => ({ getLocale: () => language.value, i18n: { global: { t: (key: string) => key } } }))

describe('formatNumber formatter reuse', () => {
  beforeEach(() => {
    vi.resetModules()
    language.value = 'en'
  })

  it('preserves formatting and precision across both languages and notation boundaries', async () => {
    const { formatNumber, formatNumberLocaleString } = await import('../format')
    for (const locale of ['en', 'zh', 'en']) {
      language.value = locale
      for (const value of [0, -0, 1.2345, 9999.99, 10000, -10000, 100000000, NaN, Infinity, -Infinity]) {
        expect(formatNumber(value)).toBe(new Intl.NumberFormat(locale, {
          notation: Math.abs(value) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1,
        }).format(value))
        expect(formatNumberLocaleString(value)).toBe(new Intl.NumberFormat(locale).format(value))
      }
    }
    expect(formatNumber(null)).toBe('0')
    expect(formatNumber(undefined)).toBe('0')
    expect(formatNumberLocaleString(null)).toBe('')
  })

  it('constructs once per locale and notation, not once per table cell', async () => {
    const { formatNumber, formatNumberLocaleString } = await import('../format')
    const constructors = vi.spyOn(Intl, 'NumberFormat')
    try {
      for (const locale of ['en', 'zh', 'en']) {
        language.value = locale
        for (let index = 0; index < 100; index++) {
          formatNumber(1.234)
          formatNumber(100000)
          formatNumberLocaleString(1.234)
        }
      }
      expect(constructors).toHaveBeenCalledTimes(6)
    } finally {
      constructors.mockRestore()
    }
  })
})
