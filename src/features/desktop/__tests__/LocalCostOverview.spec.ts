import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import LocalCostOverview from '../LocalCostOverview.vue'
import { localCostMetrics } from '../localCostMath'
import type { LocalCostReport } from '@/api/localCost'
import type { MonitorTotals } from '@/api/usageMonitor'

function fixture(prices: Record<string, number>) {
  const currencies = Object.entries(prices)
  const totals: MonitorTotals = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50, cacheWriteTokens: 0, requestCount: currencies.length, pricedCostUsd: 0, unpricedRequests: 0, incompleteRequests: 0, cacheHitRatio: .5, outputTokensPerSecond: 0,
    automaticPriceSummary: { byCurrency: Object.fromEntries(currencies.map(([currency, amount]) => [currency, { requestedSubtotal: amount, requestedRequests: 1, responseSubtotal: 0, responseRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 }])), byMode: { standard: { requestedRequests: currencies.length, responseRequests: 0, unknownRequests: 0, coveredRequests: currencies.length, byCurrency: Object.fromEntries(currencies.map(([currency, amount]) => [currency, { amount, requestCount: 1 }])) } } } }
  const report: LocalCostReport = { settings: { cnyPerUsd: 7, apiRules: [], accounts: {} }, apiExpense: { byCurrency: {}, pricedRequests: 0, missingRequests: 0 }, purchases: {}, startMs: 0, endMs: 10000, accounts: [{ id: 'codex:a', tool: 'codex', label: 'Example account', verifiedRequests: currencies.length, referenceRequests: 0, totals }], analytics: { totals, models: [], timeline: [] } }
  return { report, rows: report.accounts.map(account => ({ ...account, name: account.label, metrics: localCostMetrics(account, report, []) })) }
}

it('shows original USD usage alongside the CNY total without inventing USD for CNY-only records', async () => {
  const initial = fixture({ USD: 100, CNY: 10 })
  const wrapper = mount(LocalCostOverview, { props: { ...initial, finances: [] } })
  expect(wrapper.get('.usage-usd').text()).toBe('$100.00')
  expect(wrapper.get('.usage-cny').text()).toContain('710.00')
  expect(wrapper.find('.asset-overview').exists()).toBe(false)
  const graphic = wrapper.getComponent({ name: 'UsageTokenComposition' })
  expect(graphic.element.closest('details')).toBeNull()
  expect(graphic.props()).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, partial: false })
  expect(wrapper.findComponent({ name: 'UsageEvidenceRibbon' }).exists()).toBe(false)
  expect(wrapper.getComponent({ name: 'UsagePeriodSummary' }).props('totals')).toEqual(initial.report.analytics!.totals)
  await wrapper.setProps(fixture({ CNY: 10 }))
  expect(wrapper.get('.usage-usd').text()).toBe('—')
  expect(wrapper.get('.usage-cny').text()).toContain('10.00')
  wrapper.unmount()
})
