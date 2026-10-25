import './usageI18nFixture'
import i18n from '@/i18n'
import { describe, expect, it } from 'vitest'
import type { LiveWindow } from '@/api/usageMonitor'
import { displayLiveRate } from '../liveRate'

const window = (overrides: Partial<LiveWindow> = {}): LiveWindow => ({ seconds: 300, observedOutputTokens: 600, outputTokensPerSecond: null, coveredMs: 30000, complete: false, sourceComplete: true, ...overrides })

describe('displayLiveRate', () => {
  it('switches empty-state language without changing measured values or coverage semantics', () => {
    i18n.global.locale.value = 'en'
    expect(displayLiveRate()).toEqual({ text: 'No samples', value: null, partial: true })
    expect(displayLiveRate(window({ observedOutputTokens: 0 }))).toEqual({ text: 'Insufficient sampling', value: null, partial: true })
    expect(displayLiveRate(window({ observedOutputTokens: 0, outputTokensPerSecond: 0, complete: true, sourceComplete: false }))).toEqual({ text: 'Waiting for new records', value: null, partial: true })
    expect(displayLiveRate(window())).toEqual({ text: '2.00', value: 2, partial: true })
    i18n.global.locale.value = 'zh'
    expect(displayLiveRate()).toEqual({ text: '暂无样本', value: null, partial: true })
  })
  it('uses the fixed window for partial positive reports, not the covered duration', () => {
    expect(displayLiveRate(window())).toEqual({ text: '2.00', value: 2, partial: true })
  })

  it('distinguishes measured silence, incomplete silence and missing samples', () => {
    expect(displayLiveRate(window({ observedOutputTokens: 0, outputTokensPerSecond: 0, complete: true, coveredMs: 300000 }))).toEqual({ text: '暂无输出', value: 0, partial: false })
    expect(displayLiveRate(window({ observedOutputTokens: 0 }))).toEqual({ text: '采样不足', value: null, partial: true })
    expect(displayLiveRate(window({ seconds: 60, observedOutputTokens: 0, outputTokensPerSecond: 0, sourceComplete: false }))).toEqual({ text: '采样不足', value: null, partial: true })
    expect(displayLiveRate(window({ observedOutputTokens: 0, coveredMs: 0 }))).toEqual({ text: '暂无样本', value: null, partial: true })
    expect(displayLiveRate()).toEqual({ text: '暂无样本', value: null, partial: true })
  })

  it('qualifies positive source-incomplete rates, even with complete time coverage', () => {
    expect(displayLiveRate(window({ outputTokensPerSecond: 2, complete: true, sourceComplete: false, coveredMs: 300000 }))).toEqual({ text: '2.00', value: 2, partial: true })
    expect(displayLiveRate(window({ observedOutputTokens: 0, outputTokensPerSecond: 0, complete: true, sourceComplete: false, coveredMs: 300000 }))).toEqual({ text: '等待新记录', value: null, partial: true })
  })

  it('does not round small positive rates to zero and honors requested precision', () => {
    expect(displayLiveRate(window({ observedOutputTokens: 1 }))).toEqual({ text: '0.0033', value: 1 / 300, partial: true })
    expect(displayLiveRate(window({ complete: true, outputTokensPerSecond: 1 / 300 }))).toEqual({ text: '0.0033', value: 1 / 300, partial: false })
    expect(displayLiveRate(window(), 1).text).toBe('2.0')
  })
})
