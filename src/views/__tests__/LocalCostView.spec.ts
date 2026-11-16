import '@/features/desktop/__tests__/usageI18nFixture'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { getLocalCostReport, getLocalCostLive, saveLocalCostSettings, LOCAL_FINANCE_SCOPE, type LocalCostReport, type LocalCostLiveReport } from '@/api/localCost'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'
import LocalCostView from '../LocalCostView.vue'
import { setUsageAccountName } from '@/api/usageAccounts'

vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/api/localCost', async original => ({ ...await original<typeof import('@/api/localCost')>(), getLocalCostReport: vi.fn(), saveLocalCostSettings: vi.fn(), getLocalCostLive: vi.fn().mockResolvedValue(null) }))
vi.mock('@/api/usageAccounts', () => ({ setUsageAccountName: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/api/financeLedger', () => ({ getFinanceLedger: vi.fn() }))
vi.mock('@/api/usageMonitor', async original => ({ ...await original<typeof import('@/api/usageMonitor')>(), getUsageMonitorQuotas: vi.fn().mockResolvedValue({ collectedAtMs: 10000, quotas: [], sources: [] }) }))
vi.mock('@/features/desktop/ConsoleWorkspaceHeader.vue', () => ({ default: { template: '<header />' } }))
const eventActions = vi.hoisted(() => ({ selectAccount: vi.fn(), openEntry: vi.fn() }))
vi.mock('@/features/cost-center/components/CostEventsPanel.vue', () => ({ default: { name: 'CostEventsPanel', props: { source: String, instanceId: String, accounts: Array, restrictAccounts: Boolean, startMs: Number, endMs: Number }, setup(_props: unknown, { expose }: { expose: (value: unknown) => void }) { expose(eventActions) }, template: '<div class="events" />' } }))

const fixture = (): LocalCostReport => ({
  settings: { cnyPerUsd: 7, apiRules: [], accounts: {} }, apiExpense: { byCurrency: {}, pricedRequests: 0, missingRequests: 1 }, purchases: {}, startMs: 1, endMs: 10000,
  accounts: [{ id: 'codex:stable', label: 'Account 2', tool: 'codex', verifiedRequests: 1, referenceRequests: 0, totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 1, pricedCostUsd: 0, unpricedRequests: 1, incompleteRequests: 0, cacheHitRatio: 0, outputTokensPerSecond: 0 } }],
})
const finances = (): FinanceSnapshot => ({ events: [], totalEvents: 0, purchaseChannels: [], planLabels: [], byAccount: [], summary: { eventCount: 0, hasEnteredFacts: false, unresolvedTerminationCount: 0, currencies: [] } })

describe('local cost workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getLocalCostReport).mockResolvedValue(fixture())
    vi.mocked(getFinanceLedger).mockResolvedValue(finances())
    vi.mocked(saveLocalCostSettings).mockResolvedValue()
    vi.mocked(getLocalCostLive).mockResolvedValue(null as unknown as LocalCostLiveReport)
  })

  it('keeps every cost section when embedded and queries inclusive custom dates without changing quota scope', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:00:00'))
    const wrapper = mount(LocalCostView, { props: { embedded: true } })
    try {
      await flushPromises()
      expect(wrapper.find('main').exists()).toBe(false)
      expect(wrapper.find('h1').exists()).toBe(false)
      expect(wrapper.findAll('.local-tabs [role="tab"]')).toHaveLength(5)
      await wrapper.get('.local-cost-toolbar select').setValue('custom'); await flushPromises()
      await wrapper.get('[aria-label="开始日期"]').setValue('2026-11-10')
      await wrapper.get('[aria-label="结束日期"]').setValue('2026-11-12'); await flushPromises()
      const start = new Date('2026-11-10T00:00:00').getTime(), end = new Date('2026-11-13T00:00:00').getTime()
      expect(getLocalCostReport).toHaveBeenLastCalledWith(start,end)
      expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({ ...LOCAL_FINANCE_SCOPE, startMs: start, endMs: end }))
      const calls = vi.mocked(getLocalCostReport).mock.calls.length
      await wrapper.get('[aria-label="开始日期"]').setValue('2026-11-14'); await flushPromises()
      expect(getLocalCostReport).toHaveBeenCalledTimes(calls)
      expect(wrapper.get('[role="alert"]').text()).toContain('请选择有效的开始和结束日期')
      expect(wrapper.get('.accounts-table').text()).toContain('2')
    } finally { wrapper.unmount(); vi.useRealTimers() }
  })

  it('refreshes active account amounts and quotas without a full accounting scan on every rate poll', async () => {
    vi.useFakeTimers()
    const updated = fixture()
    updated.accounts[0].totals.inputTokens = 200
    updated.accounts[0].totals.totalTokens = 220
    updated.accounts[0].totals.requestCount = 2
    vi.mocked(getLocalCostReport).mockResolvedValueOnce(fixture()).mockResolvedValue(updated)
    vi.mocked(getLocalCostLive).mockImplementation(async () => ({ accountKey: 'all', live: { windows: [{ seconds: 60, observedOutputTokens: 120, outputTokensPerSecond: 2, complete: true, sourceComplete: true, coveredMs: 60000 }], byModel: [], byTool: [], timeline: [], sampledAtMs: Date.now() } } as unknown as LocalCostLiveReport))
    const wrapper = mount(LocalCostView)
    try {
      await flushPromises()
      await vi.advanceTimersByTimeAsync(20000)
      expect(getLocalCostLive).toHaveBeenCalledTimes(11)
      expect(getLocalCostReport).toHaveBeenCalledTimes(2)
      expect(wrapper.get('.accounts-table tbody tr').findAll('td')[2].text()).toContain('220')
      const quota = await import('@/api/usageMonitor')
      expect(quota.getUsageMonitorQuotas).toHaveBeenCalledTimes(2)
    } finally { wrapper.unmount(); vi.useRealTimers() }
  })

  it('uses only local data and named accounts, and retains the loaded period on a refresh error', async () => {
    const wrapper = mount(LocalCostView); await flushPromises()
    expect(getFinanceLedger).toHaveBeenCalledWith(expect.objectContaining(LOCAL_FINANCE_SCOPE))
    const panel = wrapper.getComponent({ name: 'CostEventsPanel' })
    expect(panel.props()).toMatchObject({ ...LOCAL_FINANCE_SCOPE, restrictAccounts: true, startMs: 1, endMs: 10000, accounts: [{ id: 'codex:stable', name: expect.stringContaining('2') }] })
    expect(wrapper.get('.local-cost-table').text()).toContain('待录入')
    const period = wrapper.get('[data-testid="loaded-period"]').text()
    vi.mocked(getLocalCostReport).mockRejectedValue(new Error('read failed'))
    await wrapper.get('.local-cost-toolbar select').setValue('7d'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('仍显示上次成功读取时段的数据')
    expect(wrapper.get('[data-testid="loaded-period"]').text()).toBe(period)
    expect(panel.props('startMs')).toBe(1)
    expect(wrapper.get('.local-cost-table').text()).toContain('2')
    wrapper.unmount()
  })

  it('persists manual status without inventing a loss or moving the financial account', async () => {
    const wrapper = mount(LocalCostView); await flushPromises()
    await wrapper.get('button[title="账号状态"]').trigger('click')
    await wrapper.get('form.status-editor select').setValue('banned')
    await wrapper.get('form.status-editor').trigger('submit'); await flushPromises()
    expect(saveLocalCostSettings).toHaveBeenCalledWith(expect.objectContaining({ accounts: { 'codex:stable': { status: 'banned', updatedAtMs: expect.any(Number) } }, apiRules: [] }))
    wrapper.unmount()
  })

  it('saves a name against the original identity and reloads its existing finance records', async () => {
    const wrapper = mount(LocalCostView); await flushPromises()
    await wrapper.get('.name-heading .console-icon-button').trigger('click')
    await wrapper.get('.name-editor input').setValue('My subscription')
    const renamed = fixture(); renamed.accounts[0].label = 'My subscription'
    vi.mocked(getLocalCostReport).mockResolvedValue(renamed)
    await wrapper.get('.name-editor').trigger('submit'); await flushPromises()
    expect(setUsageAccountName).toHaveBeenCalledWith('codex:stable', 'My subscription')
    expect(wrapper.get('.accounts-table').text()).toContain('My subscription')
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining(LOCAL_FINANCE_SCOPE))
    wrapper.unmount()
  })

  it('saves an explicit dated API multiplier and supports English labels', async () => {
    const wrapper = mount(LocalCostView); await flushPromises()
    await wrapper.get('[title="API 成本"]').trigger('click')
    await wrapper.get('.prices-heading .local-command').trigger('click')
    const form = wrapper.get('form.price-editor')
    await wrapper.get('.exchange-form input').setValue('6.5')
    expect(form.get('input[type="number"]').element.value).toBe('')
    await form.get('input[type="number"]').setValue('0.2')
    await form.get('input[type="datetime-local"]').setValue('2026-11-01T00:00')
    await form.trigger('submit'); await flushPromises()
    expect(saveLocalCostSettings).toHaveBeenCalledWith(expect.objectContaining({ cnyPerUsd: 7, apiRules: [expect.objectContaining({ model: null, startMs: new Date('2026-11-01T00:00').getTime(), multiplier: 0.2, currency: 'USD', input: null })] }))
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(wrapper.get('h1').text()).toBe('Local Costs')
    expect(wrapper.text()).not.toMatch(/desktop\.localCost\./)
    wrapper.unmount()
  })

  it('opens account-specific records and entry forms with the original stable identity', async () => {
    const wrapper = mount(LocalCostView); await flushPromises()
    await wrapper.get('.row-actions [title="录入此账号费用"]').trigger('click'); await flushPromises()
    expect(wrapper.get('#tab-records').attributes('aria-selected')).toBe('true')
    expect(eventActions.selectAccount).toHaveBeenLastCalledWith('codex:stable')
    expect(eventActions.openEntry).toHaveBeenLastCalledWith('codex:stable')
    wrapper.unmount()
  })

  it('filters accounts without shrinking the global overview or changing financial scope', async () => {
    const usage = fixture()
    usage.accounts.push({ ...usage.accounts[0], id: 'api:all', label: 'API', tool: 'api' })
    vi.mocked(getLocalCostReport).mockResolvedValue(usage)
    const wrapper = mount(LocalCostView); await flushPromises()
    expect(wrapper.findAll('.accounts-table tbody tr')).toHaveLength(2)
    const overview = wrapper.get('.local-overview').text()
    await wrapper.get('.account-filters select[aria-label="客户端"]').setValue('api')
    expect(wrapper.findAll('.accounts-table tbody tr')).toHaveLength(1)
    expect(wrapper.get('.accounts-table tbody').text()).toContain('API')
    expect(wrapper.get('.local-overview').text()).toBe(overview)
    expect(getFinanceLedger).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
  it('distinguishes known subscription calls missing an account from calls missing authentication evidence', async () => {
    const report = fixture()
    report.accounts = [{ ...report.accounts[0], id: 'unassigned', label: 'unassigned', tool: 'unknown', billingCounts: { subscription: 3, unknown: 2 } }]
    vi.mocked(getLocalCostReport).mockResolvedValue(report)
    const wrapper = mount(LocalCostView); await flushPromises()
    expect(wrapper.get('.accounts-table').text()).toContain('订阅登录 3 次')
    expect(wrapper.get('.accounts-table').text()).toContain('方式待核实 2 次')
    wrapper.unmount()
  })
})
