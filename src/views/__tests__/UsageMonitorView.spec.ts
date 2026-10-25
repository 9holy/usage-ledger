import '@/features/desktop/__tests__/usageI18nFixture'
import i18n from '@/i18n'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeLocationKey } from 'vue-router'
import UsageMonitorView from '../UsageMonitorView.vue'
import CostLineChart from '@/features/cost-center/components/CostLineChart.vue'
import { usageColors, usageModelColor, usageModeColor } from '@/features/desktop/usageChartPalette'
import { getUsageMonitorSnapshot, getUsageMonitorAnalysis, getUsageMonitorSession, getUsageMonitorWeekly, getUsageMonitorQuotas, monitorWeekBounds, type MonitorQuota, type MonitorSnapshot, type MonitorAnalysis, type MonitorRequest, type MonitorCostEstimate, type PriceEvidence, type MonitorSessionDetail } from '@/api/usageMonitor'
import { getModelCatalogStatus, quoteModelCatalogBatch } from '@/api/modelCatalog'
import { isDesktopRuntime } from '@/api/url'
import { getUsageMonitorAccounts, type AccountUsage } from '@/api/usageAccounts'
import UsageAccountPeriods from '@/features/desktop/UsageAccountPeriods.vue'
import { ACCOUNT_QUOTA_SNAPSHOTS_KEY, type AccountQuotaSnapshot } from '@/features/desktop/accountQuotaSnapshot'

vi.mock('@/api/url', () => ({ isDesktopRuntime: vi.fn(() => true) }))
vi.mock('@/api/usageMonitor', async (original) => ({
  ...await original<typeof import('@/api/usageMonitor')>(),
  getUsageMonitorSnapshot: vi.fn(), getUsageMonitorAnalysis: vi.fn(), getUsageMonitorSession: vi.fn(), getUsageMonitorWeekly: vi.fn(), getUsageMonitorQuotas: vi.fn(),
}))
vi.mock('@/api/modelCatalog', () => ({ getModelCatalogStatus: vi.fn(), refreshModelCatalog: vi.fn(), quoteModelCatalogBatch: vi.fn() }))
vi.mock('@/api/usageAccounts', async original => ({ ...await original<typeof import('@/api/usageAccounts')>(), getUsageMonitorAccounts: vi.fn() }))
const NOW = new Date('2026-10-16T04:00:00Z').getTime()
function snapshot(): MonitorSnapshot {
  const totals = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 25, cacheWriteTokens: 0, requestCount: 1, pricedCostUsd: 0, unpricedRequests: 1, incompleteRequests: 1, cacheHitRatio: null, outputTokensPerSecond: 0.33 }
  const session = { key: 'codex:s1', tool: 'codex', id: 's1', parentId: 'parent', project: 'project', model: null, status: 'active', startedAtMs: NOW - 1000, updatedAtMs: NOW, totals }
  return { collectedAtMs: NOW, refreshMs: 2000, rateWindowSeconds: 60, totals, activeSessions: [session], sessions: [session], sessionCount: 101, sources: [], collecting: false, error: null }
}
function analysis(): MonitorAnalysis {
  const current = snapshot()
  return { startMs: new Date(2026, 9, 16).getTime(), endMs: NOW, totals: current.totals, byTool: [{ tool: 'codex', model: null, totals: current.totals }], byModel: [{ tool: 'codex', model: 'gpt-5', totals: current.totals }], timeline: [{ startMs: NOW - 3600000, endMs: NOW, totals: current.totals }], availableModels: ['gpt-5'], sessions: current.sessions, sessionCount: 101, latestRequestAtMs: { codex: NOW - 10000 } }
}
function sessionDetail(): MonitorSessionDetail {
  const current = snapshot()
  return { session: { ...current.sessions[0], totals: { ...current.totals, requestCount: 200 } }, filteredTotals: { ...current.totals, requestCount: 101 }, requests: [], requestCount: 101, turns: [{ id: 't1', startedAtMs: NOW - 1000, updatedAtMs: NOW, totals: current.totals }, { id: 'turn-outside-page', startedAtMs: NOW - 2000, updatedAtMs: NOW, totals: current.totals }] }
}
function automaticEstimate(amount: number, mode = 'standard', count = 1) {
  return { byMode: { [mode]: { responseRequests: 0, requestedRequests: count, unknownRequests: 0, coveredRequests: count, byCurrency: { USD: { amount, requestCount: count } } } }, byCurrency: { USD: { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: amount, requestedRequests: count, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 } } }
}
function forecastAccount(key = 'codex:1', amount = 100, usedPercent: number | null = 20, quotaObservedAtMs = NOW): AccountUsage {
  const period = (value: number) => ({ startMs: NOW - 3 * 86400000, endMs: NOW + 4 * 86400000, observedEndMs: NOW, totals: { ...snapshot().totals, unpricedRequests: 0, automaticPriceSummary: automaticEstimate(value) } })
  const currentCycle = { ...period(amount), resetAtMs: NOW + 4 * 86400000, quotaObservedAtMs, exhaustedAtMs: usedPercent === 100 ? NOW - 1 : null, exhaustionUnknown: false, usedPercent, current: true }
  return { accountKey: key, accountLabel: `Account ${key.split(':')[1]}`, tool: 'codex', attribution: 'session_creator', subscription: { startMs: null, endMs: null, checkedAtMs: null, source: 'none', error: null }, calendarWeek: period(999), subscriptionMonth: period(7000), currentCycle, previousCycle: null, quotaCycles: [currentCycle], monthCycles: [], unsegmentedMonth: { ...snapshot().totals, requestCount: 0 } }
}
function forecastQuota(accountKey = 'codex:1', overrides: Partial<MonitorQuota> = {}): MonitorQuota {
  return { id: 1, accountKey, accountLabel: `Account ${accountKey.split(':')[1]}`, tool: 'codex', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 10080, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 4 * 86400000, usedPercent: 20, remainingPercent: 80, source: 'codex_local_log', stale: false, expired: false, sourceError: null, ...overrides }
}
function mockAccountForecast(account = forecastAccount(), quota = forecastQuota(), collectedAtMs = NOW, currentAccountKey: string | null = account.accountKey) {
  vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs, weekStartMs: monitorWeekBounds(collectedAtMs).startMs, currentAccountKey, accounts: [account], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
  vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs, sources: [], quotas: [quota] })
}
function savedQuotaForecast(): AccountQuotaSnapshot {
  return { accountKey: 'codex:1', tool: 'codex', accountLabel: 'Codex · 账号 1', cycleStartMs: NOW - 3 * 86400000, cycleResetAtMs: NOW + 4 * 86400000,
    quotaObservedAtMs: NOW, updatedAtMs: NOW, usedPercent: 20, quotes: [{ currency: 'USD', observedSubtotal: 100, additionalSubtotal: 400, projectedSubtotal: 500 }], partial: false }
}
const HIDDEN_QUOTA_ACCOUNTS_KEY = 'usage-monitor:hidden-quota-accounts:v1'
function mockSelectableQuotaAccounts(currentAccountKey: string | null = 'codex:1') {
  vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey, accounts: [forecastAccount(), forecastAccount('codex:2', 20)], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
  vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [{ tool: 'codex', source: 'fixture', status: 'available', error: null }], quotas: [
    forecastQuota(), forecastQuota('codex:2', { id: 2, stale: true, observedAtMs: NOW - 301000, credits: { hasCredits: true, unlimited: false, balance: '62500' } }),
    forecastQuota('codex:2', { id: 3, slot: 'secondary', windowMinutes: 300, observedAtMs: NOW - 302000, resetsAtMs: NOW - 1000, stale: true, expired: true }),
    forecastQuota('codex:session:4', { id: 4, attribution: 'session', accountLabel: 'Anonymous session', stale: true }),
  ] })
}
const options = { global: { provide: { [routeLocationKey as symbol]: { path: '/usage-monitor' } }, stubs: { CostLineChart: true, UsageValueChart: true, RouterLink: { template: '<a><slot /></a>' } } } }
function evidence(model: string, currency = 'USD'): PriceEvidence {
  return { model, currency, mode: 'standard', version: 'fixture', sourceUrl: 'https://example.test/prices', checkedAt: '2026-10-16', contextTier: 'standard', inputPerMillion: 1, cachedPerMillion: 0.1, outputPerMillion: 2, cacheWritePerMillion: null, cacheWrite5mPerMillion: 1.25, cacheWrite1hPerMillion: 2 }
}
function pricedRequest(id: string, model: string, cost: MonitorCostEstimate): MonitorRequest {
  return { id, model, tool: 'codex', sessionId: 's1', turnId: 't1', requestId: id, rootTurnId: null, timestampMs: NOW, requestedModel: model, modelBasis: 'response', mode: null, requestedMode: null, modeBasis: 'unknown', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null, reasoningTokens: null, durationMs: null, contextTokens: 100, usageBasis: 'reported', unknownFields: [], cost }
}
describe('UsageMonitorView', () => {
  let wrapper: ReturnType<typeof mount> | undefined
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(isDesktopRuntime).mockReturnValue(true)
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(snapshot())
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(analysis())
    vi.mocked(getUsageMonitorSession).mockResolvedValue(sessionDetail())
    vi.mocked(getUsageMonitorWeekly).mockResolvedValue({ startMs: monitorWeekBounds(NOW).startMs, endMs: NOW, firstRecordAtMs: NOW - 1000, lastRecordAtMs: NOW, totals: snapshot().totals, byTool: [{ tool: 'codex', model: null, totals: snapshot().totals }] })
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, quotas: [], sources: [] })
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, accounts: [], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
    vi.mocked(getModelCatalogStatus).mockResolvedValue({ available: true, revision: 'test', checkedAtMs: NOW, fetchedAtMs: NOW, etag: null, refreshing: false, error: null, modelCount: 10, sourceUrl: 'https://models.dev/api.json' })
    vi.mocked(quoteModelCatalogBatch).mockResolvedValue([])
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.useRealTimers() })

  it('switches every monitor workspace label without refetching or changing quota cycles and saved estimates', async () => {
    const account = forecastAccount()
    mockAccountForecast(account)
    const data = snapshot()
    data.sessions[0].project = '用户项目 Alpha'
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(data)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const before = wrapper.getComponent(UsageAccountPeriods).props('account')
    const stored = localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)
    const requests = vi.mocked(getUsageMonitorAnalysis).mock.calls.length
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Live Overview')
    expect(wrapper.get('[aria-label="Tool filter"]').text()).toContain('All tools')
    expect(wrapper.getComponent(UsageAccountPeriods).props('account')).toEqual(before)
    expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBe(stored)
    expect(vi.mocked(getUsageMonitorAnalysis)).toHaveBeenCalledTimes(requests)
    for (const [label, title] of [['Usage Analysis', 'Usage Analysis'], ['Session Details', 'Session Details'], ['Collection & Pricing', 'Collection & Pricing']]) {
      await wrapper.findAll('[role="tab"]').find(row => row.text() === label)!.trigger('click')
      expect(wrapper.get('h1').text()).toBe(title)
    }
    expect(wrapper.text()).toContain('Model price catalog')
    i18n.global.locale.value = 'zh'; await flushPromises()
    expect(wrapper.get('h1').text()).toBe('采集与价格')
    expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBe(stored)
  })

  it('registers DeepSeek Harness and toggles its monitor scope', async () => {
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const button = wrapper.findAll('.tool-overview button').find(row => row.text().includes('DeepSeek Harness'))!
    expect(button.exists()).toBe(true)
    await button.trigger('click'); await flushPromises()
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(vi.mocked(getUsageMonitorAnalysis).mock.calls.at(-1)?.[0]?.tool).toBe('deepseek-harness')
    await button.trigger('click'); await flushPromises()
    expect(button.attributes('aria-pressed')).toBe('false')
  })

  it('shows each account amount once even when the account has multiple quota windows', async () => {
    const base = { id: 1, accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 300, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 86400000, usedPercent: 100, remainingPercent: 0, source: 'codex_local_log', stale: false, expired: false, sourceError: null, credits: { hasCredits: false, unlimited: false, balance: '0' } }
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [base, { ...base, id: 2, slot: 'secondary', windowMinutes: 10080 }] })
    const period = { startMs: NOW - 86400000, endMs: NOW + 86400000, observedEndMs: NOW, totals: snapshot().totals }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, unassignedWeek: { ...snapshot().totals, requestCount: 0 }, accounts: [{ accountKey: 'codex:1', accountLabel: 'Account 1', tool: 'codex', attribution: 'session_creator', subscription: { startMs: null, endMs: null, checkedAtMs: null, source: 'none', error: null }, calendarWeek: period, subscriptionMonth: null, currentCycle: { ...period, resetAtMs: period.endMs, quotaObservedAtMs: NOW, exhaustedAtMs: NOW - 1, exhaustionUnknown: false, usedPercent: 100, current: true }, previousCycle: null, quotaCycles: [], monthCycles: [], unsegmentedMonth: { ...snapshot().totals, requestCount: 0 } }] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const amounts = wrapper.findAllComponents(UsageAccountPeriods)
    expect(amounts).toHaveLength(1)
    expect(amounts[0].props('account').accountKey).toBe('codex:1')
    expect(amounts[0].element.closest('.quota-account-header')).not.toBeNull()
    expect(wrapper.findAll('.quota-account-header.has-account-amounts')).toHaveLength(1)
    expect(amounts[0].element.closest('.allowance-item.has-account-amounts.has-quota-dial')).not.toBeNull()
    expect(wrapper.get('.forecast-paused').text()).toContain('尚未确认有可用积分')
    expect(wrapper.get('.forecast-paused').text()).not.toContain('积分还能用')
    expect(wrapper.get('.forecast-paused').element.closest('.week-evidence')).not.toBeNull()
    expect(getUsageMonitorAccounts).toHaveBeenCalledWith(monitorWeekBounds(NOW).startMs, NOW)
  })

  it('uses the current account quota in the original prediction slot while retaining global and account recorded amounts', async () => {
    const period = (amount: number) => ({ startMs: NOW - 86400000, endMs: NOW + 86400000, observedEndMs: NOW, totals: { ...snapshot().totals, unpricedRequests: 0, automaticPriceSummary: automaticEstimate(amount) } })
    const account = { accountKey: 'codex:1', accountLabel: 'Account 1', tool: 'codex' as const, attribution: 'session_creator' as const, subscription: { startMs: NOW - 86400000, endMs: NOW + 86400000, checkedAtMs: NOW, source: 'local_auth' as const, error: null }, calendarWeek: period(999), subscriptionMonth: period(7300), currentCycle: { ...period(101), resetAtMs: NOW + 86400000, quotaObservedAtMs: NOW, exhaustedAtMs: null, exhaustionUnknown: false, usedPercent: 93, current: true }, previousCycle: null, quotaCycles: [], monthCycles: [], unsegmentedMonth: snapshot().totals }
    vi.mocked(getUsageMonitorWeekly).mockResolvedValue({ startMs: monitorWeekBounds(NOW).startMs, endMs: NOW, firstRecordAtMs: NOW - 1000, lastRecordAtMs: NOW, totals: period(4000).totals, byTool: [{ tool: 'codex', model: null, totals: period(4000).totals }], forecast: [{ currency: 'USD', method: 'week_average', projectedAmount: 70, projectedSubtotal: 70, observedSubtotal: 50, additionalSubtotal: 20, pricedRequests: 1, unpricedRequests: 0, coverage: 'observed_records_only', reason: 'fixture', comparisons: [] }] })
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey: 'codex:1', accounts: [account], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [{ id: 1, accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 10080, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 86400000, usedPercent: 93, remainingPercent: 7, source: 'codex_local_log', stale: false, expired: false, sourceError: null }] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const figures = wrapper.get('.weekly-value .week-figures')
    expect(figures.text()).toContain('$4,000.00')
    expect(figures.text()).toContain('≈ $109')
    expect(figures.text()).not.toContain('≈ $70')
    expect(figures.text()).not.toContain('$101')
    expect(figures.text()).not.toContain('$7,300')
    expect(figures.element.children).toHaveLength(2)
    expect(figures.get('.account-quota-forecast').text()).toContain('当前账号周额度总额推算')
    expect(figures.get('.account-quota-forecast').text()).toContain('Codex · 账号 1 · 本轮已用 93.0%')
    expect(figures.get('.account-quota-forecast').element.closest('details')).toBeNull()
    expect(wrapper.get('usage-value-chart-stub').element.closest('details')).toBeNull()
    const chart = wrapper.findComponent({ name: 'UsageValueChart' })
    expect(chart.props('forecast').observedSubtotal).toBe(101)
    expect(chart.props('forecast').projectedSubtotal).toBeCloseTo(101 / 0.93)
    expect(chart.props('quota')).toEqual({ accountLabel: 'Codex · 账号 1', usedPercent: 93 })
    expect(wrapper.get('.current-quotas').text()).toContain('$101.00')
    expect(wrapper.get('.current-quotas').text()).toContain('$7,300.00')
    expect(wrapper.find('.quota-projection').exists()).toBe(false)
    expect(wrapper.find('.account-total').exists()).toBe(false)
    expect(wrapper.find('.natural-week-reference').exists()).toBe(false)
  })

  it('pairs a Claude account forecast and amounts with its overall pool, not a newer model-only pool', async () => {
    const account = { ...forecastAccount('claude:1'), tool: 'claude' }
    const overall = forecastQuota('claude:1', { tool: 'claude', limitId: 'seven_day', slot: 'pool' })
    const restricted = { ...overall, id: 2, limitId: 'seven_day_sonnet', observedAtMs: NOW + 1, usedPercent: 100, remainingPercent: 0 }
    mockAccountForecast(account, overall)
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW + 1, sources: [], quotas: [restricted, overall] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    const overallRow = wrapper.get('.allowance-item.has-account-amounts')
    expect(overallRow.text()).toContain('20.0%')
    expect(overallRow.text()).not.toContain('100.0%')
    expect(wrapper.get('.current-quotas').findAll('.allowance-item')).toHaveLength(2)
  })

  it('does not infer an account-wide forecast from a restricted or ambiguous weekly pool', async () => {
    const account = { ...forecastAccount('claude:1'), tool: 'claude' }
    mockAccountForecast(account, forecastQuota('claude:1', { tool: 'claude', limitId: 'Weekly', slot: 'pool' }))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈ $500')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('周额度待更新')
    expect(wrapper.get('.current-quotas').findAll('.allowance-item')).toHaveLength(1)
  })

  it('follows live account identity instead of the newest quota, history or another account balance', async () => {
    const accounts = [forecastAccount('codex:1', 20, 10), forecastAccount('codex:2', 90, 20, NOW - 1000)]
    const report = { collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey: 'codex:2', accounts, unassignedWeek: { ...snapshot().totals, requestCount: 0 } }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue(report)
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [forecastQuota('codex:1', { usedPercent: 10, remainingPercent: 90 }), forecastQuota('codex:2', { id: 2, observedAtMs: NOW - 1000, credits: { hasCredits: true, unlimited: false, balance: '999999' } })] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $450')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('Codex · 账号 2')
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('999999')
    const selector = wrapper.get<HTMLSelectElement>('[aria-label="额度账号"]')
    expect(selector.element.value).toBe('codex:2')
    expect(selector.findAll('option')).toHaveLength(2)
    expect(selector.findAll('option').find(option => option.attributes('value') === 'codex:2')!.text()).toContain('（当前）')
    expect(wrapper.get('.current-quotas').findAll('.allowance-item')).toHaveLength(1)
    expect(wrapper.get('.current-quotas').text()).toContain('账号 2')
    expect(wrapper.find('[aria-label="删除账号显示"]').exists()).toBe(false)
    await selector.setValue('codex:1'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).toContain('账号 1')
    expect(wrapper.get('.current-quotas').text()).not.toContain('账号 2')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $450')
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('quota').accountLabel).toBe('Codex · 账号 2')
    expect(wrapper.find('[aria-label="删除账号显示"]').exists()).toBe(true)
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ ...report, currentAccountKey: 'codex:1' })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $200')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('Codex · 账号 1')
    await wrapper.get('[aria-label="额度账号"]').setValue('codex:2'); await flushPromises()
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[2].trigger('click'); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('尚未确认当前账号')
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈')
    expect(wrapper.find('[aria-label="额度账号"]').exists()).toBe(false)
    expect(wrapper.find('.current-quotas').exists()).toBe(false)
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[0].trigger('click'); await flushPromises()
    expect(wrapper.get<HTMLSelectElement>('[aria-label="额度账号"]').element.value).toBe('codex:1')
  })

  it('withholds prediction on missing identity or failed reads while preserving saved account amounts', async () => {
    const account = forecastAccount()
    const report = { collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey: 'codex:1' as string | null, accounts: [account], unassignedWeek: { ...snapshot().totals, requestCount: 0 } }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue(report)
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [forecastQuota()] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    for (const api of [getUsageMonitorQuotas, getUsageMonitorAccounts]) {
      vi.mocked(api).mockRejectedValueOnce(new Error('fixture unavailable'))
      await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
      expect(wrapper.get('.account-quota-forecast').text()).toContain('账号额度更新失败')
      expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈')
      if (api === getUsageMonitorAccounts) expect(wrapper.get('[aria-label="额度账号"]').text()).not.toContain('（当前）')
      expect(wrapper.get('.current-quotas .amount-overview').text()).toContain('$100.00')
      expect(wrapper.get('.current-quotas .amount-overview').text()).toContain('$7,000.00')
      await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
      expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ ...report, currentAccountKey: null })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('尚未确认当前账号')
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
  })

  it.each([229000, 300001, 397000, -397000])('matches same-period reset clock drift (%i ms) without a minute cutoff', async drift => {
    mockAccountForecast(forecastAccount(), forecastQuota('codex:1', { resetsAtMs: forecastAccount().currentCycle!.resetAtMs + drift }))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(savedQuotaForecast().quotes[0])
    expect(JSON.parse(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)!)[0]).toMatchObject({ cycleResetAtMs: forecastAccount().currentCycle!.resetAtMs, updatedAtMs: NOW, quotaObservedAtMs: NOW })
    expect(wrapper.get('.quota-prediction-updated').text()).toContain('推算更新于')
  })

  it('keeps the canonical period through a 397-second reset shift and correction 33 seconds later', async () => {
    mockAccountForecast(forecastAccount('codex:1', 2, 1), forecastQuota('codex:1', { usedPercent: 1, remainingPercent: 99 }))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const canonical = forecastAccount().currentCycle!
    for (const [elapsed, drift, amount] of [[14000, 397000, 2.5], [33000, 0, 3]]) {
      const observedAtMs = NOW + elapsed
      vi.setSystemTime(observedAtMs)
      mockAccountForecast(forecastAccount('codex:1', amount, 1, observedAtMs), forecastQuota('codex:1', {
        observedAtMs, resetsAtMs: canonical.resetAtMs + drift, usedPercent: 1, remainingPercent: 99,
      }), observedAtMs)
      await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
      expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual({ currency: 'USD', observedSubtotal: amount, projectedSubtotal: amount * 100, additionalSubtotal: amount * 99 })
      expect(wrapper.get('.account-quota-forecast').text()).not.toContain('待更新')
      expect(JSON.parse(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)!)[0]).toMatchObject({ cycleStartMs: canonical.startMs, cycleResetAtMs: canonical.resetAtMs, quotaObservedAtMs: observedAtMs })
    }
  })

  it.each(['quota ahead', 'account ahead'])('retains only the frozen pair when %s has the same percentage', async direction => {
    const original = forecastAccount()
    original.currentCycle!.totals.requestCount = 2
    mockAccountForecast(original)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const stored = localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)
    const updated = wrapper.get('.quota-prediction-updated').text()
    const accountObserved = NOW + (direction === 'account ahead' ? 2000 : 1000)
    const quotaObserved = NOW + (direction === 'quota ahead' ? 2000 : 1000)
    vi.setSystemTime(NOW + 3000)
    mockAccountForecast(forecastAccount('codex:1', 200, 20, accountObserved), forecastQuota('codex:1', {
      observedAtMs: quotaObserved, resetsAtMs: original.currentCycle!.resetAtMs + 397000,
    }), NOW + 3000)
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(savedQuotaForecast().quotes[0])
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('quota').usedPercent).toBe(20)
    expect(wrapper.get('.account-quota-forecast').text()).toContain('显示上次有效推算')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('仅含可计价部分')
    expect(wrapper.get('.quota-prediction-updated').text()).toBe(updated)
    expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBe(stored)
  })

  it('hides only another account display, persists that choice and restores it without changing ledger data', async () => {
    mockSelectableQuotaAccounts()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get<HTMLSelectElement>('[aria-label="额度账号"]').element.value).toBe('codex:1')
    expect(wrapper.find('[aria-label="删除账号显示"]').exists()).toBe(false)
    await wrapper.get('[aria-label="额度账号"]').setValue('codex:2'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).toContain('$20.00')
    expect(wrapper.get('.current-credits').text()).toContain('上次积分余额')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    const history = wrapper.get<HTMLDetailsElement>('.quota-group:not(.current-quotas)')
    history.element.open = true; await history.trigger('toggle'); await flushPromises()
    expect(history.findAll('.allowance-item')).toHaveLength(2)
    await wrapper.get('[aria-label="删除账号显示"]').trigger('click'); await flushPromises()
    expect(JSON.parse(localStorage.getItem(HIDDEN_QUOTA_ACCOUNTS_KEY)!)).toEqual(['codex:2'])
    expect(wrapper.get('[aria-label="额度账号"]').findAll('option')).toHaveLength(1)
    expect(wrapper.get('.current-quotas').text()).not.toContain('账号 2')
    expect(wrapper.find('.historical-credit').exists()).toBe(false)
    expect(history.findAll('.allowance-item')).toHaveLength(1)
    expect(history.text()).toContain('Anonymous session')
    expect(getUsageMonitorQuotas).toHaveBeenCalledTimes(1)
    expect(getUsageMonitorAccounts).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    wrapper.unmount()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('[aria-label="额度账号"]').findAll('option')).toHaveLength(1)
    expect(wrapper.get('.hidden-quota-accounts>summary').text()).toBe('已隐藏账号 1')
    expect(wrapper.get('.hidden-quota-accounts').attributes('open')).toBeUndefined()
    const hidden = wrapper.get<HTMLDetailsElement>('.hidden-quota-accounts')
    hidden.element.open = true
    await hidden.get('[aria-label="恢复账号显示 账号 2"]').trigger('click'); await flushPromises()
    expect(wrapper.get<HTMLSelectElement>('[aria-label="额度账号"]').element.value).toBe('codex:2')
    expect(wrapper.get('[aria-label="额度账号"]').findAll('option')).toHaveLength(2)
    expect(wrapper.get('.current-quotas').text()).toContain('账号 2')
    expect(JSON.parse(localStorage.getItem(HIDDEN_QUOTA_ACCOUNTS_KEY)!)).toEqual([])
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
  })

  it('always exposes the verified current account even if its key was previously hidden', async () => {
    localStorage.setItem(HIDDEN_QUOTA_ACCOUNTS_KEY, JSON.stringify(['codex:1', 'codex:2']))
    mockSelectableQuotaAccounts()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const selector = wrapper.get<HTMLSelectElement>('[aria-label="额度账号"]')
    expect(selector.element.value).toBe('codex:1')
    expect(selector.findAll('option')).toHaveLength(1)
    expect(selector.get('option').text()).toContain('（当前）')
    expect(wrapper.find('[aria-label="删除账号显示"]').exists()).toBe(false)
    expect(wrapper.findAll('.hidden-quota-account>span').map(row => row.text())).toEqual(['Codex · 账号 2'])
  })

  it('allows an unverified fallback to be hidden without labeling it as current, and retains unknown source records', async () => {
    mockSelectableQuotaAccounts(null)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('[aria-label="额度账号"]').text()).not.toContain('（当前）')
    await wrapper.get('[aria-label="删除账号显示"]').trigger('click'); await flushPromises()
    await wrapper.get('[aria-label="删除账号显示"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[aria-label="额度账号"]').exists()).toBe(false)
    expect(wrapper.find('.current-quotas').exists()).toBe(false)
    expect(wrapper.get('.allowance-overview').text()).toContain('暂无显示的账号')
    expect(wrapper.get('.hidden-quota-accounts>summary').text()).toBe('已隐藏账号 2')
    expect(wrapper.find('.quota-source-details').exists()).toBe(true)
    const history = wrapper.get<HTMLDetailsElement>('.quota-group:not(.current-quotas)')
    history.element.open = true; await history.trigger('toggle'); await flushPromises()
    expect(history.findAll('.allowance-item')).toHaveLength(1)
    expect(history.text()).toContain('Anonymous session')
  })

  it.each(['{', '["codex:2",42]'])('ignores malformed hidden-account preferences %s with a visible storage warning', async stored => {
    localStorage.setItem(HIDDEN_QUOTA_ACCOUNTS_KEY, stored)
    mockSelectableQuotaAccounts()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('[aria-label="额度账号"]').findAll('option')).toHaveLength(2)
    expect(wrapper.get('.allowance-overview').text()).toContain('账号显示设置读取失败')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
  })

  it('keeps hide preferences in memory and reports storage access failures without blocking usage', async () => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function(this: Storage, key) {
      if (key === HIDDEN_QUOTA_ACCOUNTS_KEY) throw new Error('preferences unavailable')
      return getItem.call(this, key)
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
      if (key === HIDDEN_QUOTA_ACCOUNTS_KEY) throw new Error('preferences unavailable')
      return setItem.call(this, key, value)
    })
    mockSelectableQuotaAccounts()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.allowance-overview').text()).toContain('账号显示设置读取失败')
    await wrapper.get('[aria-label="额度账号"]').setValue('codex:2'); await flushPromises()
    await wrapper.get('[aria-label="删除账号显示"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[aria-label="额度账号"]').findAll('option')).toHaveLength(1)
    expect(wrapper.get('.allowance-overview').text()).toContain('账号显示设置保存失败')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(wrapper.get('.allowance-overview').text()).toContain('Failed to save account display settings: preferences unavailable')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
  })

  it.each([
    ['zero use', 0, {}, '等待本轮额度消耗记录'],
    ['unknown use', null, {}, '等待本轮额度消耗记录'],
    ['exhausted quota', 100, {}, '额外用量无法用于反推总额'],
    ['stale quota', 20, { stale: true }, '周额度待更新'],
    ['expired quota', 20, { expired: true }, '周额度待更新'],
    ['source error', 20, { sourceError: 'fixture failure' }, '周额度待更新'],
    ['five-hour window', 20, { windowMinutes: 300 }, '周额度待更新'],
    ['new period after last observation', 20, { resetsAtMs: NOW + 7 * 86400000 + 1 }, '周额度待更新'],
    ['missing observation', 20, { observedAtMs: null }, '周额度待更新'],
    ['observation before cycle', 20, { observedAtMs: NOW - 3 * 86400000 - 1 }, '周额度待更新'],
    ['reset before observation', 20, { resetsAtMs: NOW }, '周额度待更新'],
    ['mismatched observation', 20, { observedAtMs: NOW - 1 }, '额度读数同步中'],
    ['newer mismatched observation', 20, { observedAtMs: NOW + 1 }, '额度读数同步中'],
    ['mismatched use', 20, { usedPercent: 21 }, '额度读数同步中'],
  ] as Array<[string, number | null, Partial<MonitorQuota>, string]>)('does not substitute global money for %s', async (_name, usedPercent, overrides, message) => {
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey: 'codex:1', accounts: [forecastAccount('codex:1', 100, usedPercent)], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [forecastQuota('codex:1', { usedPercent, ...overrides })] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain(message)
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈')
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
  })

  it('keeps currencies and partial coverage explicit without using unknown-mode references', async () => {
    const account = forecastAccount('codex:1', 10, 20)
    const totals = account.currentCycle!.totals
    totals.requestCount = 3
    totals.automaticPriceSummary!.byCurrency.USD.unknownReferenceSubtotal = 900
    totals.automaticPriceSummary!.byCurrency.USD.unknownReferenceRequests = 1
    totals.automaticPriceSummary!.byCurrency.CNY = { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: 40, requestedRequests: 1, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey: 'codex:1', accounts: [account], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [forecastQuota('codex:1', { resetsAtMs: NOW + 4 * 86400000 + 2000 })] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $50')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ ¥200')
    expect(wrapper.get('.account-quota-forecast').text()).toContain('仅含可计价部分')
    expect(wrapper.findAll('usage-value-chart-stub')).toHaveLength(2)
  })

  it('retains a whole snapshot across same, older and stale quota reads, then replaces it on a newer observation', async () => {
    const account = forecastAccount('codex:1', 10, 20)
    account.currentCycle!.totals.requestCount = 3
    account.currentCycle!.totals.automaticPriceSummary!.byCurrency.CNY = { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: 40, requestedRequests: 1, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 }
    mockAccountForecast(account)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const originalQuotes = [{ currency: 'USD', observedSubtotal: 10, additionalSubtotal: 40, projectedSubtotal: 50 }, { currency: 'CNY', observedSubtotal: 40, additionalSubtotal: 160, projectedSubtotal: 200 }]
    const forecasts = () => wrapper!.findAllComponents({ name: 'UsageValueChart' }).map(chart => chart.props('forecast'))
    expect(forecasts()).toEqual(originalQuotes)
    const updated = wrapper.get('.quota-prediction-updated').text()
    const stored = localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)
    expect(JSON.parse(stored!)[0]).toMatchObject({ updatedAtMs: NOW, quotaObservedAtMs: NOW, usedPercent: 20, partial: true })

    for (const observedAtMs of [NOW, NOW - 1000]) {
      mockAccountForecast(forecastAccount('codex:1', 30, 20), forecastQuota('codex:1', { observedAtMs }))
      await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
      expect(forecasts()).toEqual(originalQuotes)
      expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBe(stored)
    }
    const later = NOW + 6 * 60000
    vi.setSystemTime(later)
    for (const sourceError of [null, 'quota waiting']) {
      mockAccountForecast(forecastAccount('codex:1', 70, 35), forecastQuota('codex:1', { stale: true, sourceError }), later)
      await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
      expect(forecasts()).toEqual(originalQuotes)
      expect(wrapper.findAllComponents({ name: 'UsageValueChart' }).map(chart => chart.props('quota'))).toEqual([
        { accountLabel: 'Codex · 账号 1', usedPercent: 20 }, { accountLabel: 'Codex · 账号 1', usedPercent: 20 },
      ])
      expect(wrapper.get('.account-quota-forecast').text()).toContain('额度待更新 · 显示上次有效推算')
      expect(wrapper.get('.account-quota-forecast').text()).toContain('仅含可计价部分')
      expect(wrapper.get('.quota-prediction-updated').text()).toBe(updated)
      expect(wrapper.get('.week-evidence').text()).toContain('已用 20.0%')
      expect(wrapper.get('.current-quotas .amount-overview').text()).toContain('$70.00')
      expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBe(stored)
    }
    const nextObservation = later + 60000
    mockAccountForecast(forecastAccount('codex:1', 70, 35, nextObservation), forecastQuota('codex:1', { observedAtMs: nextObservation, usedPercent: 35, remainingPercent: 65 }), nextObservation)
    await vi.advanceTimersByTimeAsync(60000); await flushPromises()
    expect(forecasts()).toEqual([{ currency: 'USD', observedSubtotal: 70, additionalSubtotal: 130, projectedSubtotal: 200 }])
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('quota').usedPercent).toBe(35)
    expect(wrapper.get('.quota-prediction-updated').text()).not.toBe(updated)
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('显示上次')
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('仅含可计价部分')
    expect(JSON.parse(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)!)[0]).toMatchObject({ updatedAtMs: nextObservation, quotaObservedAtMs: nextObservation, usedPercent: 35 })
  })

  it('restores only the matching persisted account-cycle snapshot after a stale remount', async () => {
    mockAccountForecast()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const updated = wrapper.get('.quota-prediction-updated').text()
    wrapper.unmount()
    vi.setSystemTime(NOW + 6 * 60000)
    mockAccountForecast(forecastAccount('codex:1', 200), forecastQuota('codex:1', { stale: true }), NOW + 6 * 60000)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(savedQuotaForecast().quotes[0])
    expect(wrapper.get('.quota-prediction-updated').text()).toBe(updated)
    expect(wrapper.get('.account-quota-forecast').text()).toContain('显示上次有效推算')
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[2].trigger('click'); await flushPromises()
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[0].trigger('click'); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(savedQuotaForecast().quotes[0])
  })

  it('captures existing valid summary data when returning from a different tool filter', async () => {
    mockAccountForecast()
    let resolveAccounts!: (report: Awaited<ReturnType<typeof getUsageMonitorAccounts>>) => void
    vi.mocked(getUsageMonitorAccounts).mockReturnValueOnce(new Promise(resolve => { resolveAccounts = resolve }))
    wrapper = mount(UsageMonitorView, options)
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[2].trigger('click'); await flushPromises()
    resolveAccounts({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, currentAccountKey: 'codex:1', accounts: [forecastAccount()], unassignedWeek: { ...snapshot().totals, requestCount: 0 } })
    await flushPromises()
    expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBeNull()
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[0].trigger('click'); await flushPromises()
    expect(getUsageMonitorAccounts).toHaveBeenCalledTimes(1)
    const updated = wrapper.get('.quota-prediction-updated').text()
    expect(JSON.parse(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)!)[0]).toMatchObject(savedQuotaForecast())

    const later = NOW + 6 * 60000
    vi.setSystemTime(later)
    mockAccountForecast(forecastAccount('codex:1', 200), forecastQuota('codex:1', { stale: true }), later)
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(savedQuotaForecast().quotes[0])
    expect(wrapper.get('.quota-prediction-updated').text()).toBe(updated)
    expect(wrapper.get('.account-quota-forecast').text()).toContain('显示上次有效推算')
  })

  it('cannot revive a cached or live quote after the wall-clock reset before another summary read', async () => {
    mockAccountForecast()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(true)
    const resetAtMs = forecastAccount().currentCycle!.resetAtMs
    const afterReset = resetAtMs + 1
    vi.setSystemTime(afterReset)
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[2].trigger('click'); await flushPromises()
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[0].trigger('click'); await flushPromises()
    expect(getUsageMonitorAccounts).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.account-quota-forecast').text()).toContain('本轮周额度周期待确认')
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈')
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    expect(wrapper.find('.quota-prediction-updated').exists()).toBe(false)

    const next = forecastAccount()
    Object.assign(next.currentCycle!, { startMs: resetAtMs, endMs: resetAtMs + 7 * 86400000, resetAtMs: resetAtMs + 7 * 86400000, observedEndMs: afterReset, quotaObservedAtMs: afterReset })
    mockAccountForecast(next, forecastQuota('codex:1', { observedAtMs: afterReset, resetsAtMs: next.currentCycle!.resetAtMs }), afterReset)
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)!)[0]).toMatchObject({ cycleStartMs: resetAtMs, updatedAtMs: afterReset })
  })

  it.each(['unknown exhaustion', 'known exhaustion'])('cannot revive a valid cached forecast after %s is corrected to 99 percent', async reason => {
    mockAccountForecast()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('≈ $500')
    const saved = localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)
    const later = NOW + 60000
    vi.setSystemTime(later)
    const account = forecastAccount('codex:1', 100, 99)
    if (reason === 'unknown exhaustion') {
      account.currentCycle!.exhaustionUnknown = true
      account.currentCycle!.totals = { ...snapshot().totals, requestCount: 0, automaticPriceSummary: { byMode: {}, byCurrency: {} } }
    } else account.currentCycle!.exhaustedAtMs = NOW + 1
    mockAccountForecast(account, forecastQuota('codex:1', { observedAtMs: later, usedPercent: 99, remainingPercent: 1 }), later)
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    const prediction = wrapper.get('.account-quota-forecast')
    expect(prediction.text()).toContain('本轮额度已用完')
    expect(prediction.text()).not.toContain('≈')
    expect(prediction.text()).not.toContain('本轮已用')
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    expect(wrapper.find('.quota-prediction-updated').exists()).toBe(false)
    expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBe(saved)
  })

  it('does not create a fresh estimate from a known exhausted cycle corrected to 99 percent', async () => {
    const account = forecastAccount('codex:1', 100, 99)
    account.currentCycle!.exhaustedAtMs = NOW - 1
    mockAccountForecast(account, forecastQuota('codex:1', { usedPercent: 99, remainingPercent: 1 }))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.account-quota-forecast').text()).toContain('本轮额度已用完')
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈')
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBeNull()
  })

  it.each(['different account', 'different cycle', 'new quota period', 'expired cycle', 'expired quota', 'zero use', 'new zero sample', 'exhausted use', 'missing identity'])('does not reuse a saved prediction for %s', async reason => {
    localStorage.setItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY, JSON.stringify([savedQuotaForecast()]))
    const account = forecastAccount(reason === 'different account' ? 'codex:2' : 'codex:1')
    const quota = forecastQuota(account.accountKey, { stale: true })
    if (reason === 'different cycle') { account.currentCycle!.startMs += 86400000; account.currentCycle!.resetAtMs += 86400000; quota.resetsAtMs! += 86400000 }
    if (reason === 'new quota period') { quota.observedAtMs = NOW + 2; quota.resetsAtMs = NOW + 7 * 86400000 + 1 }
    if (reason === 'expired cycle') account.currentCycle!.current = false
    if (reason === 'expired quota') quota.expired = true
    if (reason === 'zero use') account.currentCycle!.usedPercent = quota.usedPercent = 0
    if (reason === 'new zero sample') { quota.observedAtMs = NOW + 1; quota.usedPercent = 0 }
    if (reason === 'exhausted use') account.currentCycle!.usedPercent = quota.usedPercent = 100
    mockAccountForecast(account, quota, NOW, reason === 'missing identity' ? null : account.accountKey)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    expect(wrapper.get('.account-quota-forecast').text()).not.toContain('≈')
    expect(wrapper.find('.quota-prediction-updated').exists()).toBe(false)
  })

  it.each(['invalid json', 'invalid money', 'inconsistent percentage'])('ignores %s persistence without blocking the next live calculation', async reason => {
    const saved = savedQuotaForecast()
    const invalidQuotes = reason === 'invalid money' ? [{ ...saved.quotes[0], observedSubtotal: null }]
      : [{ currency: 'USD', observedSubtotal: 100, additionalSubtotal: 100, projectedSubtotal: 200 }]
    localStorage.setItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY, reason === 'invalid json' ? '{' : JSON.stringify([{ ...saved, quotes: invalidQuotes }]))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockAccountForecast(forecastAccount(), forecastQuota('codex:1', { stale: true }))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    expect(warn).toHaveBeenCalledWith('[usage-monitor] quota snapshot load failed', expect.any(Error))
    mockAccountForecast()
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(saved.quotes[0])
  })

  it('keeps a valid in-memory prediction when browser storage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    mockAccountForecast()
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.findComponent({ name: 'UsageValueChart' }).props('forecast')).toEqual(savedQuotaForecast().quotes[0])
    expect(warn).toHaveBeenCalledWith('[usage-monitor] quota snapshot load failed', expect.any(Error))
    expect(warn).toHaveBeenCalledWith('[usage-monitor] quota snapshot save failed', expect.any(Error))
  })

  it('keeps history details out of Overview and restores the selected history turn on return', async () => {
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    await wrapper.findAll('.turn-choice')[1].trigger('click'); await flushPromises()
    expect(wrapper.get('.detail-scope').text()).toContain('所选时间 / 模型')
    await wrapper.get('#monitor-tab-overview').trigger('click'); await flushPromises()
    expect(wrapper.find('#monitor-session-detail').exists()).toBe(false)
    expect(wrapper.get('.sessions-table').exists()).toBe(true)
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    expect(wrapper.findAll('.turn-choice')[1].attributes('aria-pressed')).toBe('true')
    await wrapper.get('#monitor-tab-overview').trigger('click'); await flushPromises()
    await wrapper.get('.sessions-table .session-link').trigger('click'); await flushPromises()
    expect(wrapper.get('#monitor-session-detail').exists()).toBe(true)
    expect(wrapper.get('.detail-scope').text()).toContain('全部已保存轮次 / 模型')
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, false, expect.objectContaining({ startMs: null, model: null, includeDescendants: true }))
  })

  it('includes idle and nested agents, preserves request sources and native turns, and switches scope without losing members', async () => {
    const own = { ...sessionDetail().session, model: 'gpt-6-astra', parentId: null }
    const child = { ...own, key: 'codex:child-sol', id: 'child-sol', parentId: own.id, model: 'gpt-6.1-sol', status: 'idle' }
    const nested = { ...child, key: 'codex:nested-luna', id: 'nested-luna', parentId: child.id, model: 'gpt-6-luna' }
    const rows = [
      pricedRequest('main-request', own.model, { usd: 1, reason: null, evidence: evidence(own.model) }),
      { ...pricedRequest('child-request', child.model, { usd: 2, reason: null, evidence: evidence(child.model) }), sessionId: child.id, turnId: 'native-child-turn', rootTurnId: 't1' },
      { ...pricedRequest('nested-request', nested.model, { usd: 3, reason: null, evidence: evidence(nested.model) }), sessionId: nested.id, turnId: 'native-nested-turn' },
    ]
    vi.mocked(getUsageMonitorSession).mockImplementation(async (key, _offset, _unpriced, filters = {}) => {
      const include = filters.includeDescendants === true
      const requests = (include ? rows : rows.slice(0, 1)).filter(row => !filters.turnId || (row.sessionId === own.id ? row.turnId : row.rootTurnId) === filters.turnId)
      return { ...sessionDetail(), session: key === own.key ? own : child, members: [own, child, nested], includeDescendants: include, unlinkedChildRequests: include ? 1 : 0, requests, requestCount: requests.length, filteredTotals: { ...own.totals, requestCount: include ? 3 : 1 } }
    })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith(own.key, 0, false, expect.objectContaining({ includeDescendants: true }))
    expect(wrapper.get('.family-members').text()).toContain('2 个')
    expect(wrapper.findAll('.family-table tbody tr')).toHaveLength(3)
    expect(wrapper.get('.family-table').text()).toContain('gpt-6-luna')
    expect(wrapper.get('.family-table').text()).toContain('下级子代理')
    expect(wrapper.get('.detail-scope').text()).toContain('本会话与子代理 3 次请求')
    expect(wrapper.get('.unlinked-children').text()).toContain('1 条子代理请求没有对应的父轮次')
    expect(wrapper.findAll('.requests-table .request-source').map(row => row.text())).toEqual(['本会话', '子代理 · child-so', '子代理 · nested-l'])
    expect(wrapper.get('.own-timing-note').text()).toContain('只对应当前选中的会话')

    await wrapper.get('[aria-label="查看请求 child-request"]').trigger('click')
    const proof = wrapper.get('.request-original-evidence')
    expect(proof.text()).toContain('原始轮次 ID')
    expect(proof.text()).toContain('native-child-turn')
    expect(proof.text()).toContain('关联父轮次 ID')
    expect(proof.text()).toContain('t1')
    await wrapper.findAll('.turn-choice')[0].trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith(own.key, 0, false, expect.objectContaining({ turnId: 't1', includeDescendants: true }))
    expect(wrapper.get('.requests-table').text()).toContain('gpt-6.1-sol')
    expect(wrapper.get('.requests-table').text()).not.toContain('gpt-6-luna')
    await wrapper.get('[aria-label="包含子代理"]').setValue(false); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith(own.key, 0, false, expect.objectContaining({ turnId: null, includeDescendants: false }))
    expect(wrapper.get('.detail-scope').text()).toContain('仅本会话 1 次请求')
    expect(wrapper.findAll('.requests-table tbody tr')).toHaveLength(1)
    expect(wrapper.findAll('.family-table tbody tr')).toHaveLength(3)
    expect(wrapper.find('.unlinked-children').exists()).toBe(false)
    await wrapper.get('[aria-label="查看子代理 child-sol"]').trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith(child.key, 0, false, expect.objectContaining({ turnId: null, includeDescendants: true }))
  })

  it('does not leak selected session content into Analysis or Sources and preserves it on return', async () => {
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    expect(wrapper.get('#monitor-session-detail').exists()).toBe(true)
    await wrapper.findAll('.turn-choice')[1].trigger('click'); await flushPromises()
    expect(wrapper.findAll('.turn-choice')[1].attributes('aria-pressed')).toBe('true')
    await wrapper.get('#monitor-tab-analysis').trigger('click'); await flushPromises()
    expect(wrapper.find('.session-layout').exists()).toBe(false)
    expect(wrapper.find('#monitor-session-detail').exists()).toBe(false)
    expect(wrapper.get('.analysis-visuals').exists()).toBe(true)
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    expect(wrapper.find('.session-layout').exists()).toBe(false)
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    expect(wrapper.get('#monitor-session-detail').exists()).toBe(true)
    expect(wrapper.findAll('.turn-choice')[1].attributes('aria-pressed')).toBe('true')
  })

  it('keeps fresh and last-known account credits visible while source notes remain expandable', async () => {
    const base = { id: 1, accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 10080, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 86400000, usedPercent: 100, remainingPercent: 0, source: 'codex_local_log', stale: false, expired: false, sourceError: null, credits: { hasCredits: true, unlimited: false, balance: '47023.68' } }
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, quotas: [base, { ...base, id: 2, accountKey: 'codex:old', accountLabel: 'Account old', stale: true, expired: true, resetsAtMs: NOW - 1000, credits: { ...base.credits, balance: '62500' } }], sources: [{ tool: 'claude', source: 'fixture', status: 'not_reported', error: null }] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const current = wrapper.get('.current-credits')
    expect(current.attributes('open')).toBeDefined()
    expect(current.text()).toContain('47,023.68')
    expect(current.findAll('.credit-account')).toHaveLength(1)
    expect(current.text()).not.toContain('62,500')
    await wrapper.get('[aria-label="额度账号"]').setValue('codex:old'); await flushPromises()
    const saved = wrapper.get('.current-credits .historical-credit')
    expect(saved.text()).toContain('62,500')
    expect(saved.text()).toContain('上次积分余额')
    expect(saved.text()).toContain('状态待更新')
    expect(saved.text()).not.toContain('积分可用')
    const sources = wrapper.get<HTMLDetailsElement>('.quota-source-details')
    expect(sources.attributes('open')).toBeUndefined()
    expect(sources.get('summary').text()).toContain('1 项待确认')
    sources.element.open = true
    expect(sources.text()).toContain('Claude Code · 尚未报告额度')
  })

  it('keeps an account and its amounts visible after five minutes without presenting cached quotas or credits as current', async () => {
    const base = { id: 1, accountKey: 'codex:2', tool: 'codex', accountLabel: 'Account 2', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 300, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 86400000, usedPercent: 93, remainingPercent: 7, source: 'codex_local_log', stale: false, expired: false, sourceError: null, credits: { hasCredits: true, unlimited: false, balance: '47023.68' }, depletion: { status: 'estimated', reason: null, asOfMs: NOW, remainingHours: 2, survivesUntilReset: false, sampleCount: 3, spanMs: 60000, consumptionPercentPerHour: 3.5 } }
    const rows = [base, { ...base, id: 2, slot: 'secondary', windowMinutes: 10080 }]
    const anonymous = { ...base, id: 3, accountKey: 'codex:session:7', accountLabel: 'Session 7', attribution: 'session', credits: null }
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [...rows, anonymous] })
    const period = { startMs: NOW - 86400000, endMs: NOW + 86400000, observedEndMs: NOW, totals: { ...snapshot().totals, automaticPriceSummary: automaticEstimate(5) } }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, unassignedWeek: { ...snapshot().totals, requestCount: 0 }, accounts: [{ accountKey: 'codex:2', accountLabel: 'Account 2', tool: 'codex', attribution: 'session_creator', subscription: { startMs: null, endMs: null, checkedAtMs: null, source: 'none', error: null }, calendarWeek: period, subscriptionMonth: null, currentCycle: { ...period, resetAtMs: period.endMs, quotaObservedAtMs: NOW, exhaustedAtMs: null, exhaustionUnknown: false, usedPercent: 93, current: true }, previousCycle: null, quotaCycles: [], monthCycles: [], unsegmentedMonth: { ...snapshot().totals, requestCount: 0 } }] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.current-quotas').findAll('.allowance-item')).toHaveLength(2)
    expect(wrapper.get('.current-quotas').text()).toContain('约2.0小时后耗尽')
    expect(wrapper.get('.current-credits').text()).toContain('积分可用')
    expect(wrapper.findAllComponents(UsageAccountPeriods)).toHaveLength(1)

    const later = NOW + 301000
    vi.setSystemTime(later)
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: later, sources: [], quotas: [...rows.map(row => ({ ...row, stale: true })), { ...anonymous, observedAtMs: later }] })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    const current = wrapper.get('.current-quotas')
    expect(current.findAll('.allowance-item')).toHaveLength(2)
    expect(current.text()).toContain('账号 2')
    expect(current.text()).toContain('上次已用')
    expect(current.text()).toContain('上次剩余 7.0%')
    expect(current.text()).toContain('额度待更新')
    expect(current.text()).toContain('Codex 本地日志')
    expect(current.text()).not.toContain('小时后耗尽')
    expect(current.find('.quota-estimate').exists()).toBe(false)
    expect((current.get('.allowance-item').element as HTMLElement).style.getPropertyValue('--quota-color')).toBe(usageColors.unknown)
    expect(current.text()).toContain('$5.00')
    expect(wrapper.findAllComponents(UsageAccountPeriods)).toHaveLength(1)
    const credits = wrapper.get('.current-credits')
    expect(credits.findAll('.credit-account')).toHaveLength(1)
    expect(credits.text()).toContain('47,023.68')
    expect(credits.text()).toContain('上次积分余额')
    expect(credits.text()).toContain('状态待更新')
    expect(credits.text()).not.toContain('积分可用')
    const history = wrapper.get<HTMLDetailsElement>('.quota-group:not(.current-quotas)')
    history.element.open = true; await history.trigger('toggle'); await flushPromises()
    expect(history.findAll('.allowance-item')).toHaveLength(1)
    expect(history.text()).toContain('Session 7')
    expect(history.text()).not.toContain('账号 2')
    expect(history.findComponent(UsageAccountPeriods).exists()).toBe(false)

    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: later, sources: [], quotas: rows.map(row => ({ ...row, observedAtMs: later, usedPercent: 85, remainingPercent: 15 })) })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).not.toContain('待更新')
    expect(wrapper.get('.remaining-label').text()).toBe('剩余 15.0%')
    expect(wrapper.get('.quota-dial').text()).toContain('85.0%已用')
    expect(wrapper.get('.current-credits').text()).toContain('积分可用')
    expect(wrapper.find('.quota-group:not(.current-quotas)').exists()).toBe(false)
    expect(wrapper.findAllComponents(UsageAccountPeriods)).toHaveLength(1)
  })

  it('shows each identified account latest expired or undated quota without requiring recent activity', async () => {
    const base = { id: 1, accountKey: 'codex:cycle', tool: 'codex', accountLabel: 'Cycle account', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 300, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW - 1000, resetsAtMs: NOW - 1000, usedPercent: 90, remainingPercent: 10, source: 'codex_local_log', stale: true, expired: true, sourceError: null }
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [
      base,
      { ...base, id: 2, windowMinutes: 10080, observedAtMs: NOW - 2000 },
      { ...base, id: 3, accountKey: 'codex:week', accountLabel: 'Week account' },
      { ...base, id: 4, accountKey: 'codex:week', accountLabel: 'Week account', windowMinutes: 10080 },
      { ...base, id: 5, accountKey: 'codex:month', accountLabel: 'Month account', resetsAtMs: null },
      { ...base, id: 6, accountKey: 'codex:inactive', accountLabel: 'Inactive account' },
      { ...base, id: 7, accountKey: 'codex:source-error', accountLabel: 'Source error account', expired: false, resetsAtMs: NOW + 86400000, sourceError: 'fixture source unavailable' },
      { ...base, id: 8, accountKey: 'codex:no-reset', accountLabel: 'No reset account', resetsAtMs: null },
      { ...base, id: 9, accountKey: 'codex:anonymous', accountLabel: 'Anonymous session', attribution: 'session' },
    ] })
    const empty = { ...snapshot().totals, requestCount: 0 }
    const period = { startMs: NOW - 86400000, endMs: NOW + 86400000, observedEndMs: NOW, totals: empty }
    const account = (key: string) => ({ accountKey: key, accountLabel: key, tool: 'codex' as const, attribution: 'session_creator' as const, subscription: { startMs: null, endMs: null, checkedAtMs: null, source: 'none' as const, error: null }, calendarWeek: period, subscriptionMonth: null, currentCycle: null, previousCycle: null, quotaCycles: [], monthCycles: [], unsegmentedMonth: empty })
    const previousCycle = { ...period, startMs: NOW - 8 * 86400000, endMs: NOW - 86400000, observedEndMs: NOW - 86400000, resetAtMs: NOW - 86400000, quotaObservedAtMs: NOW - 86400000, exhaustedAtMs: null, exhaustionUnknown: false, usedPercent: 90, current: false, totals: { ...snapshot().totals, unpricedRequests: 0, automaticPriceSummary: automaticEstimate(31) } }
    vi.mocked(getUsageMonitorAccounts).mockResolvedValue({ collectedAtMs: NOW, weekStartMs: monitorWeekBounds(NOW).startMs, unassignedWeek: empty, accounts: [
      { ...account('codex:cycle'), currentCycle: { ...period, resetAtMs: period.endMs, quotaObservedAtMs: NOW, exhaustedAtMs: null, exhaustionUnknown: false, usedPercent: 90, current: true } },
      { ...account('codex:week'), calendarWeek: { ...period, totals: snapshot().totals } },
      { ...account('codex:month'), subscriptionMonth: period },
      { ...account('codex:inactive'), previousCycle, quotaCycles: [previousCycle], subscriptionMonth: { ...period, endMs: NOW - 1000, totals: { ...snapshot().totals, unpricedRequests: 0, automaticPriceSummary: automaticEstimate(40) } } },
      account('codex:no-reset'),
    ] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const current = wrapper.get('.current-quotas')
    const rows = current.findAll('.allowance-item')
    expect(rows).toHaveLength(1)
    expect(wrapper.get('.allowance-overview>.allowance-heading').text()).toContain('6 个账号')
    const selector = wrapper.get<HTMLSelectElement>('[aria-label="额度账号"]')
    expect(selector.findAll('option')).toHaveLength(6)
    expect(selector.findAll('option').every(option => !option.text().includes('（当前）'))).toBe(true)
    expect(rows.filter(row => row.text().includes('Cycle account'))).toHaveLength(1)
    expect(rows.find(row => row.text().includes('Cycle account'))!.text()).toContain('5小时额度')
    expect(current.text()).not.toContain('Inactive account')
    await selector.setValue('codex:week'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).toContain('7天额度')
    await selector.setValue('codex:month'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).toContain('Month account')
    await selector.setValue('codex:inactive'); await flushPromises()
    const inactive = wrapper.get('.current-quotas .allowance-item')
    expect(inactive.text()).toContain('上次已用')
    expect(inactive.text()).toContain('上次剩余 10.0%')
    expect(inactive.text()).toContain('$40.00')
    expect(inactive.findAllComponents(UsageAccountPeriods)).toHaveLength(1)
    expect(inactive.getComponent(UsageAccountPeriods).props('account').previousCycle).toEqual(previousCycle)
    expect((inactive.element as HTMLElement).style.getPropertyValue('--quota-color')).toBe(usageColors.unknown)
    expect(wrapper.findAllComponents(UsageAccountPeriods)).toHaveLength(1)
    await selector.setValue('codex:no-reset'); await flushPromises()
    const noReset = wrapper.get('.current-quotas .allowance-item')
    expect(noReset.text()).toContain('本轮边界未确认')
    expect(noReset.text()).toContain('订阅日期未确认')
    expect(noReset.findAllComponents(UsageAccountPeriods)).toHaveLength(1)
    await selector.setValue('codex:source-error'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).toContain('Source error account')
    expect(wrapper.get('.current-quotas').text()).toContain('额度待更新')
    expect(wrapper.get('.current-quotas').find('.quota-estimate').exists()).toBe(false)
    await selector.setValue('codex:cycle'); await flushPromises()
    expect(wrapper.get('.current-quotas').text()).toContain('已到重置时间，等待新记录')
    const history = wrapper.get<HTMLDetailsElement>('.quota-group:not(.current-quotas)')
    history.element.open = true; await history.trigger('toggle'); await flushPromises()
    expect(history.findAll('.allowance-item')).toHaveLength(2)
    expect(history.text()).toContain('Cycle account')
    expect(history.text()).not.toContain('Week account')
    expect(history.text()).toContain('Anonymous session')
    expect(history.text()).not.toContain('Inactive account')
    expect(history.text()).not.toContain('No reset account')
    expect(history.findComponent(UsageAccountPeriods).exists()).toBe(false)
    expect(wrapper.findAllComponents(UsageAccountPeriods)).toHaveLength(1)
    expect(wrapper.get('.current-quotas').findAllComponents(UsageAccountPeriods)).toHaveLength(1)
  })

  it('shows the true hit and miss portions in two colors without inventing a minimum wedge', async () => {
    const current = analysis()
    current.totals.cacheHitRatio = 0.98
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    expect(wrapper.get('.cache-hit').text()).toContain('98.0%')
    expect(wrapper.get('.cache-miss').text()).toContain('2.0%')
    const style = (wrapper.get('.efficiency-band').element as HTMLElement).style
    expect(style.getPropertyValue('--efficiency-hit')).toBe(usageColors.cache)
    expect(style.getPropertyValue('--efficiency-miss')).toBe(usageColors.input)
    expect(Number(wrapper.get('.cache-weave').attributes('data-hit-ratio'))).toBeCloseTo(.98)
    expect(wrapper.find('.auto-mode-breakdown').exists()).toBe(false)
    expect(wrapper.find('.week-mode-details').exists()).toBe(false)
    const next = { ...current, totals: { ...current.totals, cacheHitRatio: 1 } }
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(next)
    await wrapper.get('[aria-label="刷新数据"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.cache-miss').text()).toContain('0.0%')
    expect(wrapper.get('.cache-weave').attributes('data-hit-ratio')).toBe('1')
  })

  it('keeps missing analysis distinct from loaded zero across ranking, modes and price coverage', async () => {
    vi.mocked(getUsageMonitorAnalysis).mockRejectedValue(new Error('fixture unavailable'))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click'); await flushPromises()
    expect(wrapper.get('.model-ranking').text()).toContain('尚未取得模型用量')
    expect(wrapper.find('.auto-mode-breakdown').exists()).toBe(false)
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    expect(wrapper.get('.price-coverage .coverage-empty').text()).toBe('尚未取得完整的费用覆盖统计')
    expect(wrapper.get('.price-coverage').text()).not.toContain('所选期间暂无请求')
  })

  it('shows the inherited source-page scope and never drills unknown model rows as all models', async () => {
    const current = analysis()
    const name = 'provider/very-long-custom-model-identifier-without-spaces-2026-10-17'
    current.byModel = [{ ...current.byModel[0], model: name }, { ...current.byModel[0], model: null }]
    current.availableModels = [name]
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    expect(wrapper.get('.ranking-scroll button').attributes('title')).toContain(name)
    const reads = vi.mocked(getUsageMonitorSession).mock.calls.length
    await wrapper.get('.ranking-scroll button:disabled').trigger('click')
    expect(getUsageMonitorSession).toHaveBeenCalledTimes(reads)
    await wrapper.get('[aria-label="分析模型"]').setValue(name); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    expect((wrapper.get('[aria-label="分析模型"]').element as HTMLSelectElement).value).toBe(name)
    expect(wrapper.get('[aria-label="分析模型"]').attributes('title')).toBe(name)
    expect(wrapper.get('[aria-label="分析时间范围"]').exists()).toBe(true)
  })

  it('separates the unknown-mode gap from priced coverage and distinguishes failed, partial and idle sources', async () => {
    const current = analysis()
    const automatic = automaticEstimate(0.2)
    current.totals = { ...current.totals, requestCount: 2, automaticPriceSummary: { ...automatic, byMode: { ...automatic.byMode, unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 1, coveredRequests: 0, byCurrency: {} } } } }
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    const live = snapshot()
    live.sources = [
      { tool: 'codex', root: 'C:/failed', status: 'error', error: 'read failure', files: 1, lastScanMs: NOW },
      { tool: 'claude', root: 'C:/partial', status: 'partial', error: 'one unreadable file', files: 2, lastScanMs: NOW },
      { tool: 'antigravity', root: 'C:/idle', status: 'idle', error: null, files: 1, lastScanMs: NOW },
    ]
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(live)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    const unknown = wrapper.get('.coverage-gap[data-state=unknown]')
    expect(unknown.attributes('data-count')).toBe('1')
    expect(unknown.get('p').text()).toBe('50.0% · 缺少模式依据')
    const available = wrapper.get('.coverage-result[data-state=known]')
    expect(available.attributes('data-count')).toBe('1')
    expect(available.attributes('data-percent')).toBe('50')
    expect(available.get('b').text()).toContain('50.0%')
    expect(wrapper.findAll('.source-group>summary>[data-tone]').map(row => row.attributes('data-tone'))).toEqual(['error', 'warning', 'unknown'])
    expect(wrapper.findAll('.source-entry>summary>[data-tone]').map(row => row.attributes('data-tone'))).toEqual(['error', 'warning', 'unknown'])
    expect(wrapper.get('.source-group').text()).toContain('暂时无法读取工具用量')
  })

  it('shares quota color between ring and remaining text without rounding away a remainder', async () => {
    const base = { id: 1, accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 10080, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 86400000, usedPercent: 92, remainingPercent: 8, source: 'codex_local_log', stale: false, expired: false, sourceError: null }
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [base] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    const color = () => (wrapper!.get('.allowance-item').element as HTMLElement).style.getPropertyValue('--quota-color')
    expect(color()).toBe(usageColors.warning)
    expect(wrapper.get('.quota-dial').attributes('style')).not.toContain('--quota-color')
    expect(wrapper.get('.remaining-label').text()).toBe('剩余 8.0%')
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [{ ...base, remainingPercent: 0.04, usedPercent: 99.96 }] })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.remaining-label').text()).toBe('剩余 <0.1%')
    expect(wrapper.get('.quota-dial').text()).toContain('>99.9%已用')
    expect(wrapper.find('.forecast-paused').exists()).toBe(false)
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [{ ...base, remainingPercent: 0, usedPercent: 100 }] })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(color()).toBe(usageColors.danger)
    expect(wrapper.get('.remaining-label').text()).toBe('剩余 0.0%')
  })

  it('uses stable model colors and shared metric colors without changing trend values', async () => {
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    const controls = wrapper.get('[aria-label="图表指标"]').findAll('button')
    for (const [index, metric, value] of [[0, 'input', 100], [1, 'output', 20], [2, 'cache', 25]] as const) {
      await controls[index].trigger('click')
      expect(wrapper.getComponent(CostLineChart).props('series')[0]).toMatchObject({ color: usageColors[metric], data: [value] })
    }
    const rank = wrapper.get('.ranking-scroll>button').element as HTMLElement
    const table = wrapper.get('.model-cost-table tbody tr').element as HTMLElement
    expect(rank.style.getPropertyValue('--model-color')).toBe(usageModelColor('gpt-5'))
    expect(table.style.getPropertyValue('--model-color')).toBe(rank.style.getPropertyValue('--model-color'))
    expect((wrapper.element as HTMLElement).style.getPropertyValue('--usage-output')).toBe(usageColors.output)
  })

  it('restores trend value mode with units, saved automatic prices and separate currencies', async () => {
    const current = analysis()
    const automatic = automaticEstimate(0.144968, 'fast')
    automatic.byCurrency.USD.unknownReferenceSubtotal = 99
    automatic.byCurrency.USD.unknownReferenceRequests = 1
    const multiCurrency = { ...automatic, byCurrency: { ...automatic.byCurrency, CNY: { ...automatic.byCurrency.USD, requestedSubtotal: 2, unknownReferenceSubtotal: 0 } } }
    current.timeline = [
      { startMs: NOW - 7200000, endMs: NOW - 3600000, totals: { ...current.totals, automaticPriceSummary: multiCurrency } },
      { startMs: NOW - 3600000, endMs: NOW, totals: current.totals },
    ]
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    const metrics = wrapper.get('[aria-label="图表指标"]').findAll('button')
    expect(metrics.map(button => button.text())).toEqual(['输入', '输出', '缓存', '参考价值'])
    await metrics[3].trigger('click')
    expect(wrapper.getComponent(CostLineChart).props('series')[0].data).toEqual([0.144968, null])
    expect(wrapper.getComponent(CostLineChart).props('series')[0].colorStops.map((stop: { value: number }) => stop.value)).toEqual([0, 0.072484, 0.144968])
    expect(wrapper.getComponent(CostLineChart).props('showValues')).toBe(true)
    expect(wrapper.get('.chart-unit').text()).toContain('美元')
    await wrapper.get('[aria-label="参考价值币种"]').setValue('CNY')
    expect(wrapper.getComponent(CostLineChart).props('series')[0].data).toEqual([2, null])
    expect(wrapper.get('.chart-unit').text()).toContain('人民币')
    await metrics[0].trigger('click')
    expect(wrapper.getComponent(CostLineChart).props('series')[0].data).toEqual([100, 100])
    expect(wrapper.get('.chart-unit').text()).toContain('Token')
  })

  it('restores scoped session metrics and folds full identifiers without dropping them', async () => {
    const current = sessionDetail()
    current.session.id = 'session-with-a-complete-long-identifier'
    vi.mocked(getUsageMonitorSession).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    const cells = wrapper.get('[aria-label="所选会话用量摘要"]').findAll('strong')
    expect(cells.map(cell => cell.text())).toEqual(['100', '20', '未知', '101', '2'])
    expect(wrapper.get('.detail-id').text()).not.toContain(current.session.id)
    expect(wrapper.get('.session-identifiers').attributes('open')).toBeUndefined()
    expect(wrapper.get('.session-identifiers code').text()).toBe(current.session.id)
    expect(wrapper.get('[aria-label="复制会话 ID"]').exists()).toBe(true)
  })

  it('groups collection paths by tool and keeps metadata logs separate from usage file totals', async () => {
    const current = snapshot()
    current.sources = [
      { tool: 'codex', root: 'C:/sessions', status: 'watching', files: 3, lastScanMs: NOW, error: null, missingRegisteredFiles: 0 },
      { tool: 'codex', root: 'C:/archive', status: 'watching', files: 2, lastScanMs: NOW, error: null, missingRegisteredFiles: 1 },
      { tool: 'codex', root: 'C:/logs.sqlite', status: 'metadata', files: 1, lastScanMs: NOW, error: 'mode log busy' },
      { tool: 'claude', root: 'C:/projects', status: 'partial', files: 4, lastScanMs: NOW, error: 'source failure' },
    ]
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    const groups = wrapper.findAll('.source-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].get('summary').text()).toContain('5 个')
    expect(groups[0].get('summary').text()).toContain('2 个用量来源 · 1 个模式来源')
    expect(groups[0].get('summary').text()).toContain('用量正常 · 模式日志异常')
    expect(groups[0].findAll('.source-entry')).toHaveLength(3)
    expect(groups[0].text()).toContain('C:/logs.sqlite')
    expect(groups[0].text()).toContain('mode log busy')
    expect(groups[1].get('summary').text()).toContain('部分工具的数据不完整')
  })

  it('drills through an exact saved pricing hint and clears it without a quote-free filter', async () => {
    const current = analysis()
    current.totals.unpricedReasonCounts = { actual_mode_unknown: 2, unknown_model: 1 }
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    expect(wrapper.get('.coverage-reasons').text()).toContain('历史报价记录')
    await wrapper.get('[aria-label="筛选报价提示：未记录模型"]').trigger('click'); await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ pricingReason: 'unknown_model', unpricedOnly: false, offset: 0 }))
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, false, expect.objectContaining({ pricingReason: 'unknown_model' }))
    expect(wrapper.get('.reason-filter').text()).toContain('未记录模型')
    expect(wrapper.get('.detail-section').text()).toContain('当前筛选匹配 101 次')
    await wrapper.get('[aria-label="清除报价提示筛选"]').trigger('click'); await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ pricingReason: null, unpricedOnly: false }))
    expect(wrapper.find('.reason-filter').exists()).toBe(false)
  })

  it('keeps small nonzero money visible and puts primary panels ahead of retained graphics', async () => {
    const current = analysis()
    current.totals.automaticPriceSummary = automaticEstimate(0.000012)
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.period-summary .money').text()).toContain('$0.000012')
    expect(wrapper.get('.live-band').element.compareDocumentPosition(wrapper.get('.weekly-section').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.get('.weekly-section').element.compareDocumentPosition(wrapper.get('.minute-chart').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    expect(wrapper.get('.analysis-visuals').element.compareDocumentPosition(wrapper.get('.token-composition').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.get('.model-cost-section').element.compareDocumentPosition(wrapper.get('.token-composition').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.get('[aria-label="查看 Codex gpt-5 的报价依据"]').exists()).toBe(true)
  })

  it('rebinds overview details to active history filters when returning to sessions', async () => {
    const current = analysis()
    current.sessions = [{ ...current.sessions[0], key: 'codex:history', id: 'history' }]
    current.totals.unpricedReasonCounts = { unknown_model: 1 }
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    vi.mocked(getUsageMonitorSession).mockImplementation(async key => ({ ...sessionDetail(), session: { ...sessionDetail().session, key, id: key.split(':')[1] } }))
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('[aria-label="分析模型"]').setValue('gpt-5')
    await wrapper.get('[aria-label="分析时间范围"]').findAll('button')[1].trigger('click'); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    await wrapper.get('[aria-label="筛选报价提示：未记录模型"]').trigger('click'); await flushPromises()
    const historyScope = vi.mocked(getUsageMonitorAnalysis).mock.calls.at(-1)![0]
    await wrapper.get('#monitor-tab-overview').trigger('click'); await flushPromises()
    await wrapper.get('.sessions-table .session-link').trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, false, expect.objectContaining({ startMs: null, model: null, pricingReason: null }))
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:history', 0, false, expect.objectContaining({ startMs: historyScope.startMs, model: 'gpt-5', pricingReason: 'unknown_model' }))
    expect(wrapper.get('.reason-filter').text()).toContain('未记录模型')
    expect(wrapper.get('[aria-label="搜索会话、项目或模型"]').element.closest('.session-filter-bar')).not.toBeNull()
    expect(wrapper.get('[aria-label="分析时间范围"]').element.closest('.session-filter-bar')).not.toBeNull()
    expect(wrapper.find('.session-layout .history-controls').exists()).toBe(false)
  })

  it('shows provider identity without claiming the reference supplier is the actual service', async () => {
    vi.mocked(quoteModelCatalogBatch).mockResolvedValue([{ id: 'reference-price-preview', cost: { usd: 0, reason: null, evidence: { ...evidence('gpt-5'), pricingProvider: 'OpenAI' } } }] as any)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    expect(wrapper.get('.lookup-context').text()).toContain('报价服务商（参考）OpenAI')
    expect(wrapper.get('.lookup-context').text()).toContain('美元 / 百万 Token')
    expect(wrapper.get('.lookup-evidence').text()).toContain('不代表实际接入服务商')
    expect(wrapper.find('.tariff-visual').exists()).toBe(true)
  })

  it('stops positive usage extrapolation when current allowance is exhausted and fills the used quota ring', async () => {
    vi.mocked(getUsageMonitorWeekly).mockResolvedValue({ startMs: monitorWeekBounds(NOW).startMs, endMs: NOW, firstRecordAtMs: NOW - 1000, lastRecordAtMs: NOW, totals: { ...snapshot().totals, automaticPriceSummary: automaticEstimate(50) }, byTool: [], reference: [{ currency: 'USD', amount: 50, knownSubtotal: 50, pricedRequests: 1, unpricedRequests: 0, requestedModelRequests: 1, catalogRevision: 'fixture', ruleVersion: 'fixture' }], forecast: [{ currency: 'USD', method: 'week_average', projectedAmount: 70, projectedSubtotal: 70, observedSubtotal: 50, additionalSubtotal: 20, pricedRequests: 1, unpricedRequests: 0, coverage: 'observed_records_only', reason: 'fixture', comparisons: [] }] })
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [{ id: 1, accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 10080, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 86400000, usedPercent: 100, remainingPercent: 0, source: 'codex_local_log', stale: false, expired: false, sourceError: null }] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.week-figures').text()).toContain('$50.00')
    expect(wrapper.get('.week-figures').text()).not.toContain('$70')
    expect(wrapper.get('.forecast-paused').text()).toContain('已发生照常累计')
    expect(wrapper.find('.value-bridge').exists()).toBe(false)
    expect(wrapper.get('.quota-dial').attributes('style')).toContain('360deg')
    expect(wrapper.get('.quota-dial').text()).toContain('100.0%已用')
    expect(wrapper.get('.remaining-label').text()).toContain('0.0%')
    expect(wrapper.get('.quota-estimate').text()).toContain('套餐额度已用完 · 积分状态未报告')
    expect(wrapper.get('.forecast-paused').element.closest('.week-evidence')).not.toBeNull()
    const quota = vi.mocked(getUsageMonitorQuotas).mock.results[0].value
    const expired = await quota
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ ...expired, quotas: expired.quotas.map(item => ({ ...item, expired: true, stale: true, resetsAtMs: NOW - 1000 })) })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.forecast-paused').exists()).toBe(true)
    expect(wrapper.get('.week-figures').text()).not.toContain('$70')
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ ...expired, quotas: [
      { ...expired.quotas[0], credits: { hasCredits: true, unlimited: false, balance: '56033.5765135000' } },
      { ...expired.quotas[0], id: 2, slot: 'secondary', credits: { hasCredits: true, unlimited: false, balance: '56033.5765135000' } },
    ] })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.forecast-paused').text()).toContain('当前有额外积分')
    expect(wrapper.get('.week-figures').text()).not.toContain('额外积分可用')
    expect(wrapper.get('.forecast-paused').text()).toContain('已发生照常累计')
    expect(wrapper.findAll('.credit-account')).toHaveLength(1)
    expect(wrapper.get('.credit-account').text()).toContain('56,033.58')
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ ...expired, quotas: [{ ...expired.quotas[0], credits: { hasCredits: true, unlimited: false, balance: '0.004' } }] })
    await wrapper.get('[aria-label="刷新周价值与额度"]').trigger('click'); await flushPromises()
    expect(wrapper.get('.credit-account strong').text()).toContain('0.004')
  })

  it('shows numeric standard-reference money and completed-turn speed separately from the active turn', async () => {
    const current = snapshot()
    const totals = { ...current.totals, incompleteRequests: 0, automaticPriceSummary: automaticEstimate(0.12), priceSummary: { coveredRequests: 1, byCurrency: { USD: { confirmedSubtotal: 0, confirmedRequests: 0, standardSubtotal: 0.12, standardRequests: 1 } } } }
    const session = { ...current.sessions[0], totals, turnTiming: { turnId: 'active', startedAtMs: NOW - 4000, completedAtMs: null, durationMs: null, ttftMs: null, basis: 'events' }, latestCompletedTurn: { timing: { turnId: 'complete', startedAtMs: NOW - 10000, completedAtMs: NOW - 5000, durationMs: 5000, ttftMs: 1000, basis: 'events' }, outputTokens: 100, outputTokensPerSecond: 20 } }
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue({ ...current, sessions: [session], activeSessions: [session] })
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue({ ...analysis(), totals })
    vi.mocked(getUsageMonitorSession).mockResolvedValue({ ...sessionDetail(), session })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.period-summary .money').text()).toContain('$0.12')
    expect(wrapper.get('.period-summary .money').text()).toContain('客户端记录 1 次')
    expect(wrapper.get('.speed-cell').text()).toContain('20.0 Token/秒')
    expect(wrapper.get('.speed-cell').text()).toContain('完整轮次')
    expect(wrapper.get('.session-prices').text()).toContain('$0.12')
    await wrapper.get('.sessions-table .session-link').trigger('click'); await flushPromises()
    expect(wrapper.get('.timing-strip').text()).toContain('进行中 · 4.00秒')
    expect(wrapper.get('.timing-strip').text()).toContain('最近完整轮次耗时5.00秒')
    expect(wrapper.get('.duration-track i').attributes('style')).toContain('20%')
    expect(wrapper.get('.request-speed-details').text()).toContain('日志未记录单次请求耗时')
    const selectedDetail = { ...sessionDetail(), session, selectedCompletedTurn: { ...session.latestCompletedTurn, timing: { ...session.latestCompletedTurn.timing, turnId: 't1' } } }
    vi.mocked(getUsageMonitorSession).mockResolvedValue(selectedDetail)
    await wrapper.findAll('.turn-choice')[0].trigger('click'); await flushPromises()
    expect(wrapper.get('.timing-strip').text()).toContain('20.0 Token/秒')
    vi.mocked(getUsageMonitorSession).mockRejectedValue(new Error('fixture load failed'))
    await wrapper.findAll('.turn-choice')[1].trigger('click'); await flushPromises()
    expect(wrapper.get('.timing-strip').text()).not.toContain('20.0 Token/秒')
  })

  it('shows one runtime-detected Fast quote rather than all hypothetical prices as the request amount', async () => {
    const row = pricedRequest('runtime-fast', 'gpt-6.1-sol', { usd: null, reason: 'actual_mode_unknown', evidence: null, scenarios: [
      { mode: 'standard', amount: 0.072484, evidence: evidence('gpt-6.1-sol') },
      { mode: 'fast', amount: 0.144968, evidence: { ...evidence('gpt-6.1-sol'), mode: 'fast' } },
      { mode: 'ultrafast', amount: 0.434904, evidence: { ...evidence('gpt-6.1-sol'), mode: 'ultrafast' } },
    ] })
    row.runtimeMode = { mode: 'fast', conflicted: false, observedAtMs: NOW - 1000, source: 'codex_turn_feedback_tag' }
    vi.mocked(getUsageMonitorSession).mockResolvedValue({ ...sessionDetail(), requests: [row] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('.sessions-table .session-link').trigger('click'); await flushPromises()
    expect(wrapper.get('.requests-table').text()).toContain('快速模式')
    expect((wrapper.get('.requests-table .mode-badge').element as HTMLElement).style.getPropertyValue('--mode-color')).toBe(usageModeColor('fast'))
    expect(wrapper.get('.requests-table').text()).toContain('$0.144968')
    expect(wrapper.get('.requests-table').text()).not.toContain('$0.434904')
    await wrapper.get('[aria-label="查看请求 runtime-fast"]').trigger('click')
    expect(wrapper.findAll('.selected-price-evidence')).toHaveLength(1)
    expect(wrapper.get('.request-proof-layout .request-price-panel').exists()).toBe(true)
    expect(wrapper.get('.request-proof-layout .request-original-evidence').exists()).toBe(true)
    expect(wrapper.get('.selected-price-evidence').text()).toContain('$0.144968')
    expect((wrapper.get('.selected-price-evidence .mode-badge').element as HTMLElement).style.getPropertyValue('--mode-color')).toBe(usageModeColor('fast'))
    expect(wrapper.get('.request-detail').text()).toContain('运行日志')
    expect(wrapper.get('.alternative-price-evidence').text()).toContain('$0.434904')
  })

  it('opens the first session on entry without reopening a detail the user closed, and reports known mode zeros', async () => {
    const current = analysis()
    current.totals.actualModeCounts = { unknown: 1 }
    current.totals.automaticPriceSummary = { byMode: { unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 1, coveredRequests: 0, byCurrency: {} } }, byCurrency: {} }
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.mode-coverage').text()).toContain('标准 0 · 快速 0 · 极速 0 · 未识别 1')
    await wrapper.get('#monitor-tab-sessions').trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenCalledWith('codex:s1', 0, false, expect.any(Object))
    await wrapper.get('[aria-label="关闭会话明细"]').trigger('click')
    const reads = vi.mocked(getUsageMonitorSession).mock.calls.length
    await vi.advanceTimersByTimeAsync(15000); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenCalledTimes(reads)
    expect(wrapper.find('.session-placeholder').exists()).toBe(true)
  })

  it('queries a real context-tier tariff without mismatching input tokens or rounding a small price to zero', async () => {
    vi.mocked(quoteModelCatalogBatch).mockResolvedValue([{ id: 'reference-price-preview', cost: { usd: 0, reason: null, evidence: { ...evidence('gpt-6.1-sol'), cachedPerMillion: 0.000001 } } }])
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    await wrapper.get('.price-form input[list]').setValue('gpt-6.1-sol')
    await wrapper.get('.price-form input[type="number"]').setValue(300000)
    await wrapper.get('.price-form').trigger('submit'); await flushPromises()
    expect(quoteModelCatalogBatch).toHaveBeenCalledWith([expect.objectContaining({ inputTokens: 300000, contextTokens: 300000, actualMode: 'standard' })])
    expect(wrapper.get('.lookup-evidence').text()).toContain('0.000001')
    const reads = vi.mocked(getUsageMonitorAnalysis).mock.calls.length
    await vi.advanceTimersByTimeAsync(16000)
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(reads)
    expect(vi.mocked(getUsageMonitorSnapshot).mock.calls.length).toBeGreaterThan(1)
  })

  it('does not report epoch time or a measured zero rate before the first collection', async () => {
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue({ ...snapshot(), collectedAtMs: 0 })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.freshness').text()).toBe('首次采集中')
    expect(wrapper.get('.global-rate strong').text()).toContain('读取中')
    expect(wrapper.find('.rate-session').exists()).toBe(false)
  })

  it('uses the same honest partial and quiet rates in tool headers, live tiles and session rows', async () => {
    const current = snapshot()
    const windows = [
      { seconds: 60, observedOutputTokens: 600, outputTokensPerSecond: null, coveredMs: 10000, complete: false, sourceComplete: true },
      { seconds: 300, observedOutputTokens: 0, outputTokensPerSecond: 0, coveredMs: 300000, complete: true, sourceComplete: true },
    ]
    current.live = {
      sampledAtMs: NOW, collectionUpdatedAtMs: NOW, basis: 'collector_observed_output', windows,
      byTool: [{ tool: 'codex', model: null, sessionKey: null, windows }], byModel: [],
      bySession: [{ tool: 'codex', model: null, sessionKey: 'codex:s1', windows }],
      timeline: [], peakMinuteOutputTokens: null, sourceCoverageIncomplete: false, unavailableTools: [],
    }
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.tool-overview').text()).toContain('10.0/秒 · 只读到部分记录')
    expect(wrapper.get('.global-rate strong').text()).toContain('10.00')
    expect(wrapper.get('.sessions-table').text()).toContain('10.00 / 暂无输出')
    expect(wrapper.get('.sessions-table').text()).toContain('只读到部分记录')
    expect(wrapper.get('.sessions-table').text()).not.toContain('统计中')
  })

  it('shows all same-window rate contributors beside the global total and uses the independent standard reference', async () => {
    const live = snapshot()
    const finished = { ...live.sessions[0], key: 'codex:done', id: 'done', project: 'E:/finished', status: 'idle', totals: { ...live.totals, outputTokensPerSecond: 2 } }
    live.rateSessions = [...live.activeSessions!, finished]
    live.totals = { ...live.totals, outputTokensPerSecond: 2.33 }
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(live)
    const totals = { ...live.totals, pricedCostUsd: 99, unpricedRequests: 0, automaticPriceSummary: automaticEstimate(99) }
    vi.mocked(getUsageMonitorWeekly).mockResolvedValue({ startMs: monitorWeekBounds(NOW).startMs, endMs: NOW, firstRecordAtMs: NOW - 1000, lastRecordAtMs: NOW, totals, byTool: [], reference: [{ currency: 'USD', amount: 50, knownSubtotal: 50, pricedRequests: 1, unpricedRequests: 0, requestedModelRequests: 1, catalogRevision: 'fixture', ruleVersion: 'fixture' }], forecast: [{ currency: 'USD', method: 'week_average', projectedAmount: null, projectedSubtotal: 70, observedSubtotal: 50, additionalSubtotal: 20, pricedRequests: 1, unpricedRequests: 0, coverage: 'observed_records_only', reason: 'fixture', comparisons: [] }] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(wrapper.get('.global-rate').text()).toContain('2.33')
    expect(wrapper.findAll('.rate-session')).toHaveLength(2)
    expect(wrapper.get('.rate-sessions').text()).toContain('已完成 · 仍计入这段时间的用量')
    expect(wrapper.get('.sessions-table').text()).not.toContain('finished')
    expect(wrapper.get('.week-figures').text()).toContain('$99.00')
    expect(wrapper.get('.week-figures').text()).not.toContain('$50.00')
    expect(wrapper.get('.week-evidence').text()).toContain('$50.00')
    expect(wrapper.get('.week-figures').text()).not.toContain('≈ $70')
    expect(wrapper.get('.week-figures').element.children).toHaveLength(2)
    const evidence = wrapper.get<HTMLDetailsElement>('.week-evidence')
    expect(evidence.attributes('open')).toBeUndefined()
    const accountForecast = wrapper.get('.account-quota-forecast')
    expect(accountForecast.text()).toContain('当前账号周额度总额推算')
    expect(accountForecast.text()).toContain('尚未确认当前账号')
    expect(accountForecast.element.closest('details')).toBeNull()
    expect(evidence.text()).toContain('全局自然周的标准价对照与使用趋势参考')
    expect(wrapper.find('usage-value-chart-stub').exists()).toBe(false)
    expect(evidence.find('usage-value-chart-stub').exists()).toBe(false)
    evidence.element.open = true
    await evidence.trigger('toggle')
    expect(evidence.element.open).toBe(true)
    await wrapper.get('#monitor-tab-overview').trigger('click')
    await wrapper.findAll('.rate-session')[1].trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:done', 0, false, expect.objectContaining({ startMs: null, model: null }))
  })

  it('shows account-scoped weekly allowance and last-known expired quotas without inferring a fresh reset', async () => {
    const totals = { ...snapshot().totals, requestCount: 2, unpricedRequests: 0, incompleteRequests: 1, pricedCostUsd: 20, cacheHitRatio: null, knownCacheHitRatio: 0.25, cacheKnownRequests: 1 }
    vi.mocked(getUsageMonitorWeekly).mockResolvedValue({ startMs: monitorWeekBounds(NOW).startMs, endMs: NOW, firstRecordAtMs: NOW - 1000, lastRecordAtMs: NOW, totals, byTool: [{ tool: 'codex', model: null, totals }] })
    vi.mocked(getUsageMonitorQuotas).mockResolvedValue({ collectedAtMs: NOW, sources: [], quotas: [
      { id: 1, accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', attribution: 'account', limitId: 'codex', slot: 'primary', windowMinutes: 10080, plan: 'pro', modelId: null, poolLabel: null, observedAtMs: NOW, resetsAtMs: NOW + 60000, usedPercent: 83, remainingPercent: 17, source: 'codex_local_log', stale: false, expired: false, sourceError: null },
      { id: 2, accountKey: 'antigravity:2', tool: 'antigravity', accountLabel: 'a***', attribution: 'account', limitId: 'gemini-5h', slot: 'pool', windowMinutes: 300, plan: null, modelId: null, poolLabel: null, observedAtMs: NOW - 86400000, resetsAtMs: NOW - 60000, usedPercent: 30, remainingPercent: 70, source: 'cockpit_snapshot', stale: true, expired: true, sourceError: null },
    ] })
    wrapper = mount(UsageMonitorView, options); await flushPromises()
    expect(getUsageMonitorWeekly).toHaveBeenCalledWith(monitorWeekBounds(NOW).startMs, NOW, monitorWeekBounds(NOW).endMs)
    expect(wrapper.get('.weekly-value').text()).toContain('美元 $20.000000')
    expect(wrapper.get('.weekly-value').text()).toContain('输入和缓存信息齐全 1 / 2 次')
    const rows = wrapper.get('.current-quotas').findAll('.allowance-item')
    expect(rows[0].text()).toContain('7天额度')
    expect(rows[0].get('meter').attributes('value')).toBe('17')
    expect(rows).toHaveLength(1)
    await wrapper.get('[aria-label="额度账号"]').setValue('antigravity:2'); await flushPromises()
    const expired = wrapper.get('.current-quotas .allowance-item')
    expect(expired.text()).toContain('上次剩余')
    expect(expired.text()).toContain('已到重置时间，等待新记录')
    expect(expired.find('.quota-estimate').exists()).toBe(false)
    expect(expired.get('meter').attributes('value')).toBe('70')
    await wrapper.get('[aria-label="工具筛选"]').findAll('button')[1].trigger('click'); await flushPromises()
    expect(wrapper.findAll('.allowance-item')).toHaveLength(1)
    expect(getUsageMonitorWeekly).toHaveBeenCalledTimes(1)
    await wrapper.get('[aria-label="暂停分析跟随"]').trigger('click')
    await vi.advanceTimersByTimeAsync(2000)
    await wrapper.get('.sessions-table .session-link').trigger('click'); await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, false, expect.objectContaining({ startMs: null, model: null }))
    expect(vi.mocked(getUsageMonitorSession).mock.calls.at(-1)?.[3]).not.toHaveProperty('endMs')
    expect(wrapper.get('.detail-section').text()).toContain('全部已保存轮次 / 模型')
    await wrapper.get('#monitor-tab-sources').trigger('click'); await flushPromises()
    expect(wrapper.get('.sources-section').text()).toContain('10 条模型/服务商价格')
  })

  it('uses local today and anchored rolling/model windows without changing live scope', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    const today = new Date(NOW); today.setHours(0, 0, 0, 0)
    expect(getUsageMonitorSnapshot).toHaveBeenLastCalledWith(null, 0)
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ startMs: today.getTime(), endMs: NOW, model: null, limit: 100 }))
    await wrapper.get('[aria-label="分析时间范围"]').findAll('button')[1].trigger('click')
    await wrapper.get('[aria-label="分析模型"]').setValue('gpt-5')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ startMs: NOW - 7 * 86400000, endMs: NOW, model: 'gpt-5' }))
    expect(getUsageMonitorSnapshot).toHaveBeenCalledTimes(1)
    await wrapper.get('#monitor-tab-sessions').trigger('click')
    await wrapper.get('[aria-label="下一页会话"]').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2000)
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100, endMs: NOW }))
    expect(getUsageMonitorSnapshot).toHaveBeenCalledTimes(2)
    await wrapper.get('[aria-label="分析时间范围"]').findAll('button')[3].trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ startMs: null, endMs: NOW + 2000, offset: 0, model: 'gpt-5' }))
  })

  it('separates all active and uncertain sessions from period history, and shows scan/request timestamps honestly', async () => {
    const live = snapshot()
    live.activeSessions!.push({ ...live.activeSessions![0], id: 'waiting', key: 'codex:waiting', status: 'stale' })
    live.sources = [{ tool: 'codex', root: 'C:/logs', status: 'watching', files: 3, lastScanMs: NOW, error: 'partial source failure' }]
    const current = analysis()
    current.sessions = [{ ...current.sessions[0], key: 'codex:history', id: 'history', status: 'historical' }]
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(live)
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    expect(wrapper.get('.sessions-table').text()).toContain('waiting')
    expect(wrapper.get('.sessions-table').text()).not.toContain('history')
    expect(wrapper.get('.rate-method').text()).toContain('速度为零不代表已经停止')
    expect(wrapper.get('.live-band').text()).toContain('0.33')
    expect(wrapper.get('[aria-label="定位父会话 parent"]').text()).toBe('查看父会话')
    await wrapper.get('#monitor-tab-sessions').trigger('click')
    expect(wrapper.get('.session-browser').text()).toContain('history')
    await wrapper.get('#monitor-tab-sources').trigger('click')
    expect(wrapper.get('.sources-section').text()).toContain('最近检查')
    expect(wrapper.get('.sources-section').text()).toContain('最近用量记录')
    expect(wrapper.get('.sources-section').text()).not.toContain('写入时间')
    expect(wrapper.get('.sources-section').text()).toContain('partial source failure')
  })

  it('queries global history matches, unquoted records and parent IDs without guessing session keys', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    await wrapper.get('[aria-label="查看无法估算会话"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ unpricedOnly: true, search: '', offset: 0 }))
    const calls = vi.mocked(getUsageMonitorAnalysis).mock.calls.length
    await wrapper.get('[aria-label="搜索会话、项目或模型"]').setValue(' remote-project ')
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(calls)
    const current = analysis()
    current.sessions = [{ ...current.sessions[0], id: 'outside-first-page' }]
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    await wrapper.get('[role="search"]').trigger('submit')
    await wrapper.get('[aria-label="会话状态"]').setValue('history')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'remote-project', status: 'history', unpricedOnly: true }))
    expect(wrapper.get('.session-browser').text()).toContain('#outside-')
    await wrapper.get('[aria-label="定位父会话 parent"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'codex', search: 'parent', status: 'all', unpricedOnly: false }))
    expect(vi.mocked(getUsageMonitorSession).mock.calls.some(call => call[0] === 'codex:parent')).toBe(false)
    await wrapper.get('[aria-label="清除搜索"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ search: '' }))
  })

  it('keeps live polling independent from paused history and allows manual refresh and 15s first-page follow', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('[aria-label="暂停分析跟随"]').trigger('click')
    await vi.advanceTimersByTimeAsync(16000)
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getUsageMonitorSnapshot).mock.calls.length).toBeGreaterThan(1)
    await wrapper.get('[aria-label="刷新数据"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(2)
    await wrapper.get('#monitor-tab-sessions').trigger('click')
    await wrapper.get('[aria-label="下一页会话"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100, endMs: NOW + 16000 }))
    await vi.advanceTimersByTimeAsync(16000)
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(3)
    await wrapper.get('[aria-label="上一页会话"]').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="恢复分析跟随"]').trigger('click')
    await flushPromises()
    const before = vi.mocked(getUsageMonitorAnalysis).mock.calls.length
    await vi.advanceTimersByTimeAsync(15000)
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(before + 1)
  })

  it('drills tool summaries into the selected model/window and clears unrelated session filters', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    await wrapper.get('[aria-label="分析模型"]').setValue('gpt-5')
    await flushPromises()
    await wrapper.get('[aria-label="查看无法估算会话"]').trigger('click')
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    await wrapper.get('.breakdown-section .session-link').trigger('click')
    await flushPromises()
    expect(getUsageMonitorAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'codex', model: 'gpt-5', search: '', unpricedOnly: false }))
    expect(wrapper.get('#monitor-tab-sessions').attributes('aria-selected')).toBe('true')
  })

  it('resumes periodic analysis after closing a paginated request detail', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('.sessions-table .session-link').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="下一页请求"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 100, false, expect.any(Object))
    expect(wrapper.find('[aria-label="恢复分析跟随"]').exists()).toBe(true)
    await wrapper.get('[aria-label="关闭会话明细"]').trigger('click')
    await wrapper.get('[aria-label="恢复分析跟随"]').trigger('click')
    await flushPromises()
    const reads = vi.mocked(getUsageMonitorAnalysis).mock.calls.length
    await vi.advanceTimersByTimeAsync(15000)
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(reads + 1)
    await wrapper.get('.sessions-table .session-link').trigger('click')
    await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, false, expect.any(Object))
  })

  it('uses the complete turn index and window totals, then filters request pages without losing the turn index', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    await wrapper.get('[aria-label="查看无法估算会话"]').trigger('click')
    await flushPromises()
    await wrapper.get('.session-choice').trigger('click')
    await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, true, expect.objectContaining({ startMs: expect.any(Number), endMs: NOW, model: null, turnId: null }))
    expect(wrapper.get('[aria-label="完整轮次索引"]').text()).toContain('turn-outside-page')
    expect(wrapper.get('.detail-section').text()).toContain('仅本会话 101 次请求')
    expect(wrapper.get('.detail-section').text()).toContain('本会话自身累计 200 次')
    await wrapper.findAll('.turn-choice')[1].trigger('click')
    await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, true, expect.objectContaining({ turnId: 'turn-outside-page' }))
    await wrapper.get('[aria-label="下一页请求"]').trigger('click')
    await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 100, true, expect.objectContaining({ turnId: 'turn-outside-page' }))
    expect(wrapper.get('[aria-label="完整轮次索引"]').text()).toContain('t1')
    await wrapper.get('[aria-label="仅未能估算"]').setValue(false)
    await flushPromises()
    expect(getUsageMonitorSession).toHaveBeenLastCalledWith('codex:s1', 0, false, expect.objectContaining({ turnId: 'turn-outside-page' }))
  })

  it('keeps single/native quotes, nonadditive scenarios and all evidence available one selected request at a time', async () => {
    const current = analysis()
    const scenarios = ['standard', 'fast', 'ultrafast'].map((mode, i) => ({ mode, currency: 'USD', amount: i + 1, requestCount: 2 }))
    current.totals = { ...current.totals, requestCount: 4, unpricedRequests: 3, scenarioRequests: 2, pricedCostUsd: 0.25, pricedCostCny: 1.5, scenarios, automaticPriceSummary: {
      byMode: {
        standard: { responseRequests: 1, requestedRequests: 0, unknownRequests: 0, coveredRequests: 1, byCurrency: { USD: { amount: 0.25, requestCount: 1 }, CNY: { amount: 1.5, requestCount: 1 } } },
        fast: { responseRequests: 0, requestedRequests: 1, unknownRequests: 0, coveredRequests: 0, byCurrency: {} },
        unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 2, coveredRequests: 0, byCurrency: {} },
      },
      byCurrency: { USD: { responseSubtotal: 0.25, responseRequests: 1, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 1, unknownReferenceRequests: 2 }, CNY: { responseSubtotal: 1.5, responseRequests: 1, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 } },
    } }
    vi.mocked(getUsageMonitorAnalysis).mockResolvedValue(current)
    const glm = { ...evidence('glm-5'), pricingProvider: 'Z.AI' }
    const doubao = { ...evidence('doubao-seed', 'CNY'), pricingProvider: 'Volcengine', excludedComponents: ['cache_storage'] }
    vi.mocked(getUsageMonitorSession).mockResolvedValue({ ...sessionDetail(), turns: [{ id: 't1', totals: current.totals }], requests: [
      pricedRequest('glm', 'glm-5', { usd: null, reason: 'unknown_actual_mode', evidence: null, scenarios: ['standard', 'fast', 'ultrafast'].map((mode, i) => ({ mode, amount: i + 1, evidence: { ...glm, mode } })) }),
      pricedRequest('doubao', 'doubao-seed', { usd: null, cny: 1.5, reason: null, evidence: doubao }),
      pricedRequest('qianfan', 'qianfan-code-latest', { usd: null, reason: 'subscription_routing_alias_needs_model', evidence: null }),
    ] })
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    expect(wrapper.get('.period-summary .money').text()).toContain('$0.25')
    expect(wrapper.get('.period-summary .money').text()).toMatch(/[¥￥]1\.50/)
    const distribution = wrapper.get('[aria-label="缓存效率与费用能算到哪一步"]')
    expect(distribution.findAll('.prism-label').map(item => item.attributes('data-percent'))).toEqual(['25', '50', '25'])
    expect(distribution.find('.cache-dial').exists()).toBe(false)
    expect(wrapper.find('.scenario-band').exists()).toBe(false)
    expect(wrapper.find('.auto-mode-breakdown').exists()).toBe(false)
    expect(wrapper.find('.week-mode-details').exists()).toBe(false)
    await wrapper.get('#monitor-tab-overview').trigger('click')
    await wrapper.get('.sessions-table .session-link').trigger('click')
    await flushPromises()
    expect(wrapper.find('.request-detail').exists()).toBe(false)
    expect(wrapper.get('.requests-table').text()).toContain('模式未记录，未计入已识别金额')
    await wrapper.get('[aria-label="查看请求 glm"]').trigger('click')
    expect(wrapper.findAll('.request-detail')).toHaveLength(1)
    expect(wrapper.get('.request-detail').text()).toContain('Z.AI 官方等价价，非实际服务商确认')
    expect(wrapper.get('.alternative-price-evidence').text()).toContain('快速模式')
    expect(wrapper.get('.alternative-price-evidence').text()).toContain('美元 $2.000000')
    expect(wrapper.get('.request-detail').text()).toContain('缓存写入（5分钟） 1.25 / 1小时 2')
    expect(wrapper.get('.request-detail').text()).toContain('fixture')
    await wrapper.get('[aria-label="查看请求 doubao"]').trigger('click')
    expect(wrapper.get('.request-detail').text()).toContain('人民币 / 百万 Token')
    expect(wrapper.get('.request-detail').text()).toContain('以上金额还没有包括：缓存存储费（cache_storage）')
    expect(wrapper.findAll('.request-detail')).toHaveLength(1)
    await wrapper.get('[aria-label="查看请求 qianfan"]').trigger('click')
    expect(wrapper.get('.request-detail').text()).toContain('套餐路由别名，需底层模型或采购档案')
    expect(wrapper.get('.request-detail').text()).not.toContain('$0.000000')
  })

  it('preserves unknown usage and requested/actual provenance without fabricating a price', async () => {
    const row = pricedRequest('unknown', 'unknown', { usd: null, reason: '模型未知', evidence: null })
    row.requestedModel = 'requested'; row.requestedMode = 'priority'; row.rootTurnId = 'root'; row.unknownFields = ['cache_read_tokens']
    vi.mocked(getUsageMonitorSession).mockResolvedValue({ ...sessionDetail(), requests: [row] })
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    expect(wrapper.text()).toContain('已知小计')
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    expect(wrapper.text()).toContain('不是瞬时生成速度')
    await wrapper.get('#monitor-tab-overview').trigger('click')
    await wrapper.get('.sessions-table .session-link').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="查看请求 unknown"]').trigger('click')
    const proof = wrapper.get('.request-detail').text()
    expect(proof).toContain('模型未知')
    expect(proof).toContain('请求模型 requested')
    expect(proof).toContain('会话文件中的模式 快速模式')
    expect(proof).toContain('尚缺少：缓存读取 Token')
    expect(proof).not.toContain('$0.000000')
  })

  it('retains previous period values on analysis failure and does not claim a current zero', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    const oldRange = wrapper.get('.analysis-range').text()
    vi.mocked(getUsageMonitorAnalysis).mockRejectedValueOnce(new Error('analysis failed'))
    await wrapper.get('[aria-label="刷新数据"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('保留上次成功读取')
    expect(wrapper.get('.period-summary').text()).toContain('120')
    expect(wrapper.get('.analysis-range').text()).toBe(oldRange)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getUsageMonitorSnapshot).toHaveBeenCalledTimes(3)
  })

  it('never presents another model scope or old history matches as a pending or failed new query', async () => {
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    let rejectScope!: (error: Error) => void
    vi.mocked(getUsageMonitorAnalysis).mockImplementationOnce(() => new Promise((_resolve, fail) => { rejectScope = fail }))
    await wrapper.get('[aria-label="分析模型"]').setValue('gpt-5')
    await flushPromises()
    expect(wrapper.get('.period-summary').text()).not.toContain('120')
    expect(wrapper.get('.analysis-range').text()).toContain('尚未读取')
    rejectScope(new Error('new model failed'))
    await flushPromises()
    expect(wrapper.get('.period-summary').text()).not.toContain('120')
    expect(wrapper.get('[role="alert"]').text()).not.toContain('保留上次成功读取')
    await wrapper.get('[aria-label="刷新数据"]').trigger('click')
    await flushPromises()
    await wrapper.get('#monitor-tab-sessions').trigger('click')
    expect(wrapper.get('.session-browser').text()).toContain('s1')
    let rejectSearch!: (error: Error) => void
    vi.mocked(getUsageMonitorAnalysis).mockImplementationOnce(() => new Promise((_resolve, fail) => { rejectSearch = fail }))
    await wrapper.get('[aria-label="搜索会话、项目或模型"]').setValue('different-project')
    await wrapper.get('[role="search"]').trigger('submit')
    await flushPromises()
    expect(wrapper.get('.session-browser').text()).not.toContain('s1')
    expect(wrapper.get('.history-scope').text()).not.toContain('101 个匹配会话')
    rejectSearch(new Error('new search failed'))
    await flushPromises()
    expect(wrapper.get('.session-browser').text()).toContain('当前筛选结果尚未取得')
    expect(wrapper.get('.session-browser').text()).not.toContain('s1')
    await wrapper.get('#monitor-tab-analysis').trigger('click')
    expect(wrapper.get('.period-summary').text()).toContain('120')
  })

  it('keeps keyboard table focus, detail focus and close-return navigation', async () => {
    vi.mocked(getUsageMonitorSession).mockResolvedValue({ ...sessionDetail(), requests: [pricedRequest('focus', 'gpt-5', { usd: null, reason: 'unknown_model', evidence: null })] })
    wrapper = mount(UsageMonitorView, { ...options, attachTo: document.body })
    await flushPromises()
    expect(wrapper.get('[aria-label="会话记录表格"]').attributes('tabindex')).toBe('0')
    const trigger = wrapper.get('.sessions-table .session-link')
    await trigger.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('#monitor-session-detail').element)
    const requestButton = wrapper.get('[aria-label="查看请求 focus"]')
    await requestButton.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[aria-label="所选请求价格与用量证据"]').element)
    await wrapper.get('[aria-label="关闭请求证据"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(requestButton.element)
    await wrapper.get('[aria-label="关闭会话明细"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(trigger.element)
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('does not overlap live reads and stops both schedules after unmount', async () => {
    let resolve!: (value: MonitorSnapshot) => void
    vi.mocked(getUsageMonitorSnapshot).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    wrapper = mount(UsageMonitorView, options)
    await vi.advanceTimersByTimeAsync(6000)
    expect(getUsageMonitorSnapshot).toHaveBeenCalledTimes(1)
    resolve(snapshot())
    await flushPromises()
    wrapper.unmount(); wrapper = undefined
    await vi.advanceTimersByTimeAsync(30000)
    expect(getUsageMonitorSnapshot).toHaveBeenCalledTimes(1)
    expect(getUsageMonitorAnalysis).toHaveBeenCalledTimes(1)
  })

  it('is honest about missing global active data and never makes browser production mocks', async () => {
    const current = snapshot(); delete current.activeSessions
    vi.mocked(getUsageMonitorSnapshot).mockResolvedValue(current)
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    expect(wrapper.get('.sessions-table').text()).toContain('未提供全局活动列表')
    wrapper.unmount()
    vi.mocked(isDesktopRuntime).mockReturnValue(false)
    vi.clearAllMocks()
    wrapper = mount(UsageMonitorView, options)
    await flushPromises()
    expect(wrapper.text()).toContain('浏览器模式不提供实时监控数据')
    expect(getUsageMonitorSnapshot).not.toHaveBeenCalled()
    expect(getUsageMonitorAnalysis).not.toHaveBeenCalled()
  })
})

