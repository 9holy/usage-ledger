import './usageI18nFixture'
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import LocalCostUsagePanel from '../LocalCostUsagePanel.vue'
import type { LocalCostAccount, LocalCostReport } from '@/api/localCost'
import type { MonitorQuota, MonitorTotals } from '@/api/usageMonitor'
import type { AccountUsageCycle } from '@/api/usageAccounts'
import { localCostMetrics } from '../localCostMath'

vi.mock('@/features/cost-center/components/CostLineChart.vue', () => ({ default: { name: 'CostLineChart', props: ['labels', 'series', 'state'], template: '<div class="chart-stub" />' } }))

function data() {
  const now = Date.now(), start = now - 2 * 86400000, observed = now - 60000, end = now + 5 * 86400000
  const totals: MonitorTotals = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0, requestCount: 1, pricedCostUsd: 10, incompleteRequests: 0, unpricedRequests: 0, cacheHitRatio: .4, outputTokensPerSecond: 0, automaticPriceSummary: { byCurrency: { USD: { requestedSubtotal: 10, requestedRequests: 1, responseSubtotal: 0, responseRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 } }, byMode: { standard: { requestedRequests: 1, responseRequests: 0, unknownRequests: 0, coveredRequests: 1, byCurrency: { USD: { amount: 10, requestCount: 1 } } } } } }
  const cycle: AccountUsageCycle = { startMs: start, endMs: end, observedEndMs: now, resetAtMs: end, quotaObservedAtMs: observed, usedPercent: 20, exhaustedAtMs: null, exhaustionUnknown: false, current: true, totals, quotaSnapshot: { startMs: start, endMs: end, observedEndMs: observed + 1, totals, billingTotals: { subscription: totals } } }
  const analytics = (model: string) => ({ totals, models: [{ tool: 'codex', model, totals, speeds: [] }], timeline: [{ startMs: start, endMs: start + 3600000, totals }, { startMs: start + 2 * 3600000, endMs: start + 3 * 3600000, totals }] })
  const account: LocalCostAccount = { id: 'codex:a', label: 'Account A', tool: 'codex', verifiedRequests: 1, referenceRequests: 0, totals, periods: { subscription: { startMs: start, endMs: end, checkedAtMs: now, source: 'official', error: null }, currentCycle: cycle, previousCycle: null, quotaCycles: [cycle], subscriptionMonth: null, monthCycles: [], unsegmentedMonth: { ...totals, requestCount: 0 }, verifiedHistory: null }, analytics: analytics('model-a') }
  const api: LocalCostAccount = { id: 'api:all', label: 'API', tool: 'api', verifiedRequests: 1, referenceRequests: 0, totals, analytics: analytics('api-model'), periods: null }
  const report: LocalCostReport = { settings: { cnyPerUsd: 7, apiRules: [], accounts: {} }, accounts: [account, api], apiExpense: { byCurrency: { CNY: 2 }, pricedRequests: 1, missingRequests: 0, byModel: [{ tool: 'codex', model: 'api-model', byCurrency: { CNY: 2 }, pricedRequests: 1, missingRequests: 0 }] }, purchases: {}, startMs: start, endMs: now, analytics: analytics('global-model') }
  const quota = { tool: 'codex', accountKey: 'codex:a', attribution: 'account', windowMinutes: 10080, limitId: 'codex', observedAtMs: observed, usedPercent: 20, stale: false, expired: false, sourceError: null } as MonitorQuota
  const rows = report.accounts.map(row => ({ ...row, name: row.label, metrics: localCostMetrics(row, report, []) }))
  return { report, rows, quota, cycle }
}

it('keeps each account models separate and retains paired quota amounts when a newer reading arrives', async () => {
  const { report, rows, quota } = data()
  const wrapper = mount(LocalCostUsagePanel, { props: { report, rows, quotas: [quota], quotaError: '', modelValue: 'codex:a' } })
  expect(wrapper.get('.quota-prediction').text()).toContain('$50')
  expect(wrapper.get('.model-details').text()).toContain('model-a')
  expect(wrapper.get('.model-details').text()).not.toContain('api-model')
  const chart = wrapper.get('.usage-trend').getComponent({ name: 'CostLineChart' })
  expect(chart.props('series')[0].data).toEqual([10, null, 10])
  await wrapper.setProps({ quotas: [{ ...quota, usedPercent: 50 }] })
  expect(wrapper.get('.quota-prediction').text()).toContain('$50')
  expect(wrapper.get('.quota-prediction').text()).toContain('额度待更新')
  await wrapper.setProps({ modelValue: 'api:all' }); await flushPromises()
  expect(wrapper.find('.quota-details').exists()).toBe(false)
  expect(wrapper.get('.model-details').text()).toContain('api-model')
  expect(wrapper.get('.model-details').text()).not.toContain('model-a')
  expect(wrapper.get('.model-details').text()).toContain('未记录耗时')
  wrapper.unmount()
})

it('refuses to replace an unverified subscription sample with API amounts', () => {
  const { report, rows, quota, cycle } = data()
  cycle.quotaSnapshot!.billingTotals = { api: cycle.quotaSnapshot!.totals }
  const wrapper = mount(LocalCostUsagePanel, { props: { report, rows, quotas: [quota], quotaError: '', modelValue: 'codex:a' } })
  expect(wrapper.get('.quota-prediction').text()).not.toContain('$50')
  expect(wrapper.get('.quota-metrics').text()).toContain('—')
  wrapper.unmount()
})

it('does not invent subscription quota for a genuinely metered API account',()=>{
  const {report,rows,quota}=data();rows[0].billingKind='api'
  const wrapper=mount(LocalCostUsagePanel,{props:{report,rows,quotas:[quota],quotaError:'',modelValue:'codex:a'}})
  expect(wrapper.find('.quota-details').exists()).toBe(false)
  expect(wrapper.get('.usage-note').text()).toContain('API')
  expect(wrapper.get('.model-cost-table').text()).toContain('model-a')
  wrapper.unmount()
})

it('does not round a positive recorded rate down to zero', () => {
  const { report, rows, quota } = data()
  rows[0].analytics!.models[0].speeds = [{ basis: 'request', validSamples: 1, totalSamples: 1, outputTokens: 20, durationMs: 100000000, outputTokensPerSecond: 0.0002 }]
  const wrapper = mount(LocalCostUsagePanel, { props: { report, rows, quotas: [quota], quotaError: '', modelValue: 'codex:a' } })
  expect(wrapper.get('.model-details').text()).toContain('0.0002 Token/s')
  wrapper.unmount()
})

it('selects the available currency when an account only has CNY quotes', () => {
  const { report, rows, quota } = data()
  const summary = rows[0].totals.automaticPriceSummary!
  summary.byCurrency = { CNY: summary.byCurrency.USD }
  summary.byMode.standard.byCurrency = { CNY: summary.byMode.standard.byCurrency.USD }
  const wrapper = mount(LocalCostUsagePanel, { props: { report, rows, quotas: [quota], quotaError: '', modelValue: 'codex:a' } })
  expect(wrapper.get<HTMLSelectElement>('.usage-trend select[aria-label="币种"]').element.value).toBe('CNY')
  expect(wrapper.get('.usage-trend').getComponent({ name: 'CostLineChart' }).props('series')[0].data).toEqual([10, null, 10])
  wrapper.unmount()
})

it('keeps missing sampling intervals as gaps and marks incomplete rate history', async () => {
  const { report, rows, quota } = data()
  rows[0].analytics!.observedTimeline = [
    { startMs: 0, endMs: 3600000, observedOutputTokens: 3600, outputTokens: 3600, coveredMs: 3600000, sourceComplete: true },
    { startMs: 7200000, endMs: 10800000, observedOutputTokens: 3600, outputTokens: null, coveredMs: 1800000, sourceComplete: false },
  ]
  const wrapper = mount(LocalCostUsagePanel, { props: { report, rows, quotas: [quota], quotaError: '', modelValue: 'codex:a' } })
  await wrapper.get('.rate-history-toggle input').setValue(true)
  const chart = wrapper.get('.usage-trend').getComponent({ name: 'CostLineChart' })
  expect(chart.props('series')[0].data).toEqual([1, null, 2])
  expect(chart.props('state')).toBe('partial')
  expect(wrapper.get('.model-details').element.compareDocumentPosition(wrapper.get('.quota-infographics').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  wrapper.unmount()
})

it('filters one account by actual call source without borrowing aggregate amounts or rate samples', async()=>{
  const {report,rows,quota}=data()
  const original=rows[0].analytics!
  const routed={...original,totals:{...original.totals,inputTokens:500},models:[{...original.models[0],model:'routed-model',totals:{...original.totals,inputTokens:500}}]}
  rows[0].sources={direct:original,sub2api:routed}
  const wrapper=mount(LocalCostUsagePanel,{props:{report,rows,quotas:[quota],quotaError:'',modelValue:'codex:a'}})
  await wrapper.get('.account-call-sources select').setValue('sub2api')
  expect(wrapper.get('.model-cost-table').text()).toContain('routed-model')
  expect(wrapper.get('.model-cost-table').text()).not.toContain('model-a')
  expect(wrapper.get('.recorded-usage').text()).toContain('500')
  expect(wrapper.get('.quota-prediction').text()).toContain('$50')
  expect(wrapper.emitted('update:source')).toEqual([['sub2api']])
  await wrapper.get('.account-call-sources select').setValue('all')
  expect(wrapper.get('.model-cost-table').text()).toContain('model-a')
  wrapper.unmount()
})
