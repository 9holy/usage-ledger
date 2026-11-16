import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import UsagePeriodSummary from '../UsagePeriodSummary.vue'
import UsageTrend from '../UsageTrend.vue'
import type { MonitorTotals } from '@/api/usageMonitor'

const totals: MonitorTotals = {
  inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0,
  requestCount: 7, pricedCostUsd: 12, pricedCostCny: 3, incompleteRequests: 0, unpricedRequests: 0,
  cacheHitRatio: .4, outputTokensPerSecond: 0,
  automaticPriceSummary: { byMode: { standard: { requestedRequests: 2, responseRequests: 0, unknownRequests: 5, coveredRequests: 2, byCurrency: { USD: { amount: 2, requestCount: 1 }, CNY: { amount: 3, requestCount: 1 } } } }, byCurrency: {
    USD: { requestedSubtotal: 2, requestedRequests: 1, responseSubtotal: 0, responseRequests: 0, unknownReferenceSubtotal: 10, unknownReferenceRequests: 5 },
    CNY: { requestedSubtotal: 3, requestedRequests: 1, responseSubtotal: 0, responseRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 },
  } },
}

it('converts only identified amounts in the displayed totals and retains activity and request counts', () => {
  const wrapper = mount(UsagePeriodSummary, { props: { totals, cnyPerUsd: 7, overview: true, counts: { running: 3, activeLast30m: 10, recent: 2, stale: 0, idle: 0, unknown: 0 }, costText: '$2 / ¥3', costNote: 'saved evidence' } })
  expect(wrapper.get('.converted-value').text()).toContain('17.00')
  expect(wrapper.get('.activity-counts').text()).toContain('3 / 10')
  expect(wrapper.get('.money small[title]').text()).toContain('2 / 7')
  expect(wrapper.findAll('.period-summary>div')[3].text()).toContain('120 Token')
  wrapper.unmount()
})

it('uses the same period totals for total-token and request trends and keeps missing rates unknown', async () => {
  const wrapper = mount(UsageTrend, { props: { totals, timeline: [{ startMs: 0, endMs: 3600000, totals }], history: [{ startMs: 0, endMs: 3600000, observedOutputTokens: 0, outputTokens: null, coveredMs: 0, sourceComplete: false }] }, global: { stubs: { CostLineChart: true } } })
  const chart = wrapper.getComponent({ name: 'CostLineChart' }), buttons = wrapper.findAll('.source-selector button')
  await buttons[4].trigger('click')
  expect(chart.props('series')[0].data).toEqual([120])
  await buttons[5].trigger('click')
  expect(chart.props('series')[0].data).toEqual([7])
  await wrapper.get('.rate-history-toggle input').setValue(true)
  expect(chart.props('series')[0].data).toEqual([null])
  expect(chart.props('state')).toBe('partial')
  wrapper.unmount()
})
