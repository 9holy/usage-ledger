import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { MonitorTotals } from '@/api/usageMonitor'
import UsagePeriodSummary from '../UsagePeriodSummary.vue'

const totals = (overrides: Partial<MonitorTotals> = {}): MonitorTotals => ({
  requestCount: 2, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, pricedCostUsd: 0,
  unpricedRequests: 2, incompleteRequests: 2, cacheHitRatio: null,
  outputTokensPerSecond: 0, ...overrides,
})

describe('monitor period totals evidence', () => {
  it('renders completely missing token fields as unknown and preserves actual zeros', async () => {
    const wrapper = mount(UsagePeriodSummary, { props: { costText: '金额未知', costNote: '', totals: totals({ inputUnknownRequests: 2, outputUnknownRequests: 2, cacheReadUnknownRequests: 2, cacheWriteUnknownRequests: 2 }) } })
    const input = () => wrapper.findAll('strong')[0]
    const output = () => wrapper.findAll('strong')[1]
    expect(input().text()).toBe('未知')
    expect(output().text()).toBe('未知')
    expect(wrapper.text()).not.toContain('缓存读 0')
    await wrapper.setProps({ totals: totals({ incompleteRequests: 0, inputUnknownRequests: 0, outputUnknownRequests: 0, cacheReadUnknownRequests: 0, cacheWriteUnknownRequests: 0 }) })
    expect(input().text()).toBe('0')
    expect(output().text()).toBe('0')
    wrapper.unmount()
  })

  it('shows partial known subtotals and describes unsplit cumulative counts honestly', () => {
    const wrapper = mount(UsagePeriodSummary, { props: { costText: '金额未知', costNote: '', totals: totals({ inputTokens: 100, totalTokens: 100, inputUnknownRequests: 1, outputUnknownRequests: 2, unitemizedRecords: 1 }) } })
    expect(wrapper.findAll('strong')[0].text()).toBe('100')
    expect(wrapper.findAll('strong')[1].text()).toBe('未知')
    expect(wrapper.text()).toContain('已知小计 · 1 / 2 条记录提供此字段')
    expect(wrapper.text()).toContain('2 条用量记录，含 1 条未拆分累计；实际请求次数未知')
    expect(wrapper.text()).not.toContain('2 次请求')
    wrapper.unmount()
  })
})
