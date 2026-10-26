import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import centerEn from '@/i18n/locales/en/costCenter'
import centerZh from '@/i18n/locales/zh/costCenter'
import costDataEn from '@/i18n/locales/en/costData'
import costDataZh from '@/i18n/locales/zh/costData'
import { invoke } from '@tauri-apps/api/core'
import * as cockpitApi from '@/api/cockpit'
import { loadUsdCnyExchangeRate } from '@/features/cost-center/exchangeRate'
import type { Account } from '@/types'
import type { FinanceAccountSummary, FinanceSnapshot } from '@/api/financeLedger'
import { getFinanceLedger, saveFinanceEvent, saveFinanceBatch } from '@/api/financeLedger'
import { useConnectionStore } from '@/stores/connection'
import { buildLocalEconomicsSnapshot } from '@/features/cost-center/costEngine'
import { sourceState } from '@/features/cost-center/dataState'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '@/features/cost-center/model'
import type { useCostCenterData as DataFactory } from '@/features/cost-center/useCostCenterData'
import type { ModelRouteRow } from '@/features/cost-center/modelRouteAnalysis'
import type { RecordedQuotaProgress } from '@/features/cost-center/quotaWindowState'
import type { QuotaSnapshot } from '@/api/cockpit/quota'

const shared = vi.hoisted(() => ({ data: null as unknown as ReturnType<typeof DataFactory>, query: { desktop: '1', panel: 'oauth' }, unifiedLoad: vi.fn().mockResolvedValue(undefined) }))
const nativeWindow = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: nativeWindow }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }))
vi.mock('@/features/cost-center/exchangeRate', async original => ({ ...await original<typeof import('@/features/cost-center/exchangeRate')>(), loadUsdCnyExchangeRate: vi.fn().mockResolvedValue({ rate: 7, rateDate: null, fetchedAt: null, source: 'override' }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/admin/cost-center', query: shared.query }), useRouter: () => ({ replace: vi.fn().mockResolvedValue(undefined), push: vi.fn() }) }))
vi.mock('@/features/cost-center/useCostCenterData', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/cost-center/useCostCenterData')>()
  return { ...actual, useCostCenterData: () => shared.data }
})
vi.mock('@/features/cost-center/useUnifiedCost', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/cost-center/useUnifiedCost')>()
  return { ...actual, useUnifiedCost: (...args: Parameters<typeof actual.useUnifiedCost>) => ({ ...actual.useUnifiedCost(...args), loadUnified: shared.unifiedLoad }) }
})
vi.mock('@/api/financeLedger', () => ({ getFinanceLedger: vi.fn(), saveFinanceEvent: vi.fn(), voidFinanceEvent: vi.fn(), saveFinanceBatch: vi.fn(), getFinanceBatch: vi.fn(), voidFinanceBatch: vi.fn(), getFinanceRelatedEvents: vi.fn() }))
import CostCenterView from '../admin/CostCenterView.vue'

const end = new Date('2026-10-16T12:00:00Z'), start = new Date(end.getTime() - 30 * 86_400_000)
const period = { start, end }
const emptyFinance = (): FinanceSnapshot => ({ events: [], totalEvents: 0, purchaseChannels: [], planLabels: [], byAccount: [], summary: { hasEnteredFacts: false, eventCount: 0, unresolvedTerminationCount: 0, currencies: [] } })
const account = (id: number, type: Account['type'], platform: Account['platform'] = 'openai'): Account => ({ id, name: `Account ${id}`, type, platform, status: 'active', schedulable: true, created_at: start.toISOString(), credentials: {}, extra: {}, groups: [], concurrency: 1, priority: 0 } as Account)
const usage = (overrides = {}) => ({ requests: 7, tokens: 100, cost: 0.5, standard_cost: 10, user_cost: 2.12924, ...overrides })
const recorded = (): FinanceAccountSummary => ({ accountId: '1', currency: 'CNY', cashOutlay: 40, refunds: 0, accruedExpense: 40, recognizedLoss: 0, expenseCredits: 0, netExpense: 40, remainingPrepaid: 0, ongoingHourlyExpense: 0, unresolvedCount: 0, hasEnteredFacts: true, terminationLoss: 0, amortizedExpense: 40, missingCoverageCount: 0, coverageIntervals: [{ startMs: start.getTime(), endMs: end.getTime() }], lifetimeAccruedExpense: 40, lifetimeRecognizedLoss: 0, lifetimeExpenseCredits: 0, lifetimeCoverageIntervals: [{ startMs: start.getTime(), endMs: end.getTime() }] })
let wrapper: VueWrapper | null = null

beforeEach(async () => {
  i18n.global.setLocaleMessage('en', { ...en, costData: costDataEn, costCenter: centerEn })
  i18n.global.setLocaleMessage('zh', { ...zh, costData: costDataZh, costCenter: centerZh })
  i18n.global.locale.value = 'zh'
  vi.useFakeTimers(); vi.setSystemTime(end); vi.clearAllMocks()
  vi.mocked(invoke).mockImplementation(async command => {
    if (['quota_list_channels', 'quota_current_accounts', 'quota_snapshots', 'quota_history'].includes(command)) return [] as never
    if (command === 'read_cost_profiles') return '{}' as never
    return null as never
  })
  vi.mocked(loadUsdCnyExchangeRate).mockResolvedValue({ rate: 7, rateDate: null, fetchedAt: null, source: 'override' })
  shared.unifiedLoad.mockResolvedValue(undefined)
  localStorage.clear(); setActivePinia(createPinia())
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  const connection = useConnectionStore()
  connection.connections = [{ id: 'saved-A', type: 'sub2api', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: '', lastUsed: 1 }]
  connection.activeId = 'saved-A'
  const actual = await vi.importActual<typeof import('@/features/cost-center/useCostCenterData')>('@/features/cost-center/useCostCenterData')
  shared.data = actual.useCostCenterData()
  shared.data.reload = vi.fn().mockResolvedValue(undefined)
  shared.data.preloadLocalCostProfiles = vi.fn().mockResolvedValue(undefined)
  shared.data.loadAccountEconomics = vi.fn().mockResolvedValue(null)
  shared.data.invalidatePendingRequest = vi.fn()
  shared.data.rangeAccountStatsScope.value = { source: 'sub2api', instanceId: 'saved-A' }
  shared.data.rangeAccountStatsWindow.value = period
  shared.data.rangeAccountStatsComplete.value = true
  shared.data.rangeWindowAuthoritative.value = true
  shared.data.trendQueryWindow.value = period
  shared.data.sub2apiRequestWindow.value = period
  shared.data.lastUpdated.value = end
  shared.data.exchangeRate.value = { rate: 7, rateDate: null, fetchedAt: null, source: 'override' }
  for (const key of ['accounts', 'rangeStats', 'dashboard'] as const) shared.data.sourceStates.value[key] = sourceState(key, 'measured')
  shared.data.sourceStates.value.todayStats = sourceState('todayStats', 'empty')
  shared.data.sourceStates.value.costLoss = sourceState('costLoss', 'empty')
  vi.mocked(getFinanceLedger).mockResolvedValue(emptyFinance())
})
afterEach(() => { wrapper?.unmount(); wrapper = null; delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.restoreAllMocks(); vi.useRealTimers() })

async function open(onError?: (error: unknown) => void) {
  wrapper = mount(CostCenterView, { global: { plugins: [i18n], config: onError ? { errorHandler: onError } : {}, stubs: {
    RouterLink: { template: '<a><slot /></a>' },
    MetricCell: { props: ['label', 'value', 'note'], template: '<div class="metric" :data-label="label"><strong>{{ value }}</strong><small>{{ note }}</small></div>' },
    CostLineChart: true, AdaptiveOperationsCharts: true, ModelContributionChart: true, CostProfileInspector: true,
    CostApiAccessPanel: true, DataGovernancePanel: true, CostEventsPanel: true, UpstreamProbeCell: true,
  } } })
  await wrapper.get('[aria-label="统计时间"]').setValue('30d'); await flushPromises()
  return wrapper
}
function mixed() {
  const subscription = account(1, 'oauth'); subscription.extra = { plan_type: 'plus', cost_profile: { amount: 730, currency: 'CNY', billing_cycle: 'monthly', started_at: start.toISOString(), algorithm_version: 'fixture' } }
  const metered = account(2, 'apikey', 'anthropic')
  shared.data.accounts.value = [subscription, metered]
  shared.data.rangeAccountStats.value = { '1': usage({ cost: 1000, standard_cost: 1000, user_cost: 100 }), '2': usage({ cost: 10, standard_cost: 100, user_cost: 50 }) }
  const fact = recorded()
  vi.mocked(getFinanceLedger).mockResolvedValue({ ...emptyFinance(), byAccount: [fact], summary: { hasEnteredFacts: true, eventCount: 1, unresolvedTerminationCount: 0, currencies: [] } })
  shared.data.accountEconomics.value = buildLocalEconomicsSnapshot({ accounts: [subscription, metered].map(account => ({ account, health: { successCount: 1, failureCount: 0 } })), billedUsdTotal: 150, accountCostUsdTotal: 1010, outputBasis: 'revenue', cnyPerUsd: 7, now: end.getTime(), window: period })
}
function localRoute(): ModelRouteRow {
  return { key: 'route', requestedModel: 'gpt-5', upstreamModel: null, upstreamResponseModel: '', upstreamModelMismatch: null, modelAuditStatus: 'unobserved', mappingChain: '未记录', provider: 'openai', accountId: 1, accountName: 'Historical usage', accountType: 'apikey', channelId: null, channelName: '', groupId: null, groupName: '', inboundEndpoint: '', upstreamEndpoint: '', channelPricing: null, requests: 7, inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, standardCost: 1, accountCost: 0.2, revenue: null, firstSeen: start.toISOString(), lastSeen: end.toISOString() }
}

function modelLog(model: string, from = start.getTime(), to = end.getTime()): cockpitApi.CockpitRequestLogSummary {
  return { available: true, rowCount: 1, windowStartMs: from, windowEndMs: to, bucketHours: 1, cells: [], groups: [{ model, accountId: 'fixture-account', apiKeyId: '', firstMs: from, lastMs: to, requests: 1, success: 1, error: 0, stdNormalInput: 100, stdCached: 0, stdOutput: 20, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 1, rateLimited: 0, upstreamError: 0, clientCanceled: 0 }], bucketLatencies: [] } as unknown as cockpitApi.CockpitRequestLogSummary
}

async function openCockpitModelFixture(calendarSnapshot = true) {
  const view = await open()
  const state = view.vm as any
  await view.get('[aria-label="统计时间"]').setValue('1h'); await flushPromises()
  const totals = { requestCount: 1, successCount: 1, failureCount: 0, clientCanceledCount: 0, upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 20, textRequestCount: 1, imageRequestCount: 0, imageGenerationRequestCount: 0, imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0, inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 1 }
  const snapshot = { since: start.getTime(), updatedAt: end.getTime(), totals, accounts: [], models: [{ modelId: 'calendar-model', usage: totals }], apiKeys: [] }
  const stats: cockpitApi.CockpitStats = { ...snapshot, ...(calendarSnapshot ? { daily: snapshot, weekly: snapshot, monthly: snapshot } : {}) }
  vi.spyOn(cockpitApi, 'getCockpitStats').mockResolvedValue(stats)
  for (const key of ['getCockpitCodexAccounts', 'getCockpitGeminiAccounts', 'getCockpitAntigravityAccounts', 'getCockpitPlatformAccounts', 'getCockpitModelProviders', 'getCockpitQuotaHistories', 'getCockpitApiKeyNames'] as const) vi.spyOn(cockpitApi, key).mockResolvedValue([])
  vi.spyOn(cockpitApi, 'getCockpitLocalAccess').mockResolvedValue(null)
  vi.spyOn(cockpitApi, 'getCockpitCodexAccountGroups').mockResolvedValue(null)
  vi.spyOn(cockpitApi, 'getCockpitAccountGroups').mockResolvedValue(null)
  vi.spyOn(cockpitApi, 'getCockpitApiLog').mockResolvedValue(null)
  vi.spyOn(cockpitApi, 'readCostLedger').mockResolvedValue(null)
  vi.spyOn(cockpitApi, 'writeCostLedger').mockResolvedValue(undefined)
  vi.spyOn(cockpitApi, 'getCockpitOpsSummary').mockResolvedValue(null)
  const logs = vi.spyOn(cockpitApi, 'getCockpitRequestLogSummary').mockImplementation(async (_bucket, from, to) => modelLog(from != null && to != null && to - from > 6 * 86400000 ? 'detached-model' : 'main-model', from ?? start.getTime(), to ?? end.getTime()))
  useConnectionStore().activeId = null
  await flushPromises(); await state.reload(); await flushPromises()
  return { view, state, logs, stats }
}

describe('CostCenter operating integration', () => {
  it('coalesces paired restore notifications but refreshes again after a separate blur/restore', async () => {
    const view = await open()
    const calls = vi.mocked(shared.data.reload).mock.calls.length
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus')); await flushPromises()
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 1)
    window.dispatchEvent(new Event('focus')); await flushPromises()
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 1)
    window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); await flushPromises()
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 2)
    expect((view.vm as any).refreshing).toBe(false)
  })

  it('queues exactly one fresh restore read behind a pre-resume request', async () => {
    const view = await open(), state = view.vm as any
    let complete!: () => void
    vi.mocked(shared.data.reload).mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    const calls = vi.mocked(shared.data.reload).mock.calls.length
    const pending = state.reload(); await flushPromises()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 1)
    complete(); await pending; await flushPromises()
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 2)
  })

  it.each(['manual', 'period', 'model source'])('preserves queued %s refreshes during a restore read', async action => {
    const view = await open(), state = view.vm as any
    let complete!: () => void
    vi.mocked(shared.data.reload).mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    const calls = vi.mocked(shared.data.reload).mock.calls.length
    window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); await flushPromises()
    if (action === 'manual') void state.reload()
    else if (action === 'period') state.range = '7d'
    else state.modelCostSource = 'requested'
    await flushPromises()
    complete(); await flushPromises()
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 2)
    expect(shared.data.reload).toHaveBeenLastCalledWith(action === 'period' ? '7d' : '30d', expect.any(Object))
  })

  it('freezes only the hidden presentation clock and updates it immediately on restore', async () => {
    mixed(); const view = await open(), state = view.vm as any
    const clock = state.now, ledgers = state.accountLedgers, expense = state.operatingSummary.expenseCny.total
    const calls = vi.mocked(shared.data.reload).mock.calls.length
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60000); await flushPromises()
    expect(state.now).toBe(clock)
    expect(state.accountLedgers).toBe(ledgers)
    expect(shared.data.reload).toHaveBeenCalledTimes(calls)
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'))
    expect(state.now.getTime()).toBe(end.getTime() + 60000)
    await flushPromises()
    expect(shared.data.reload).toHaveBeenCalledTimes(calls + 1)
    expect(state.operatingSummary.expenseCny.total).toBe(expense)
  })

  it('keeps a queued connection-source refresh behind the existing request', async () => {
    const { state } = await openCockpitModelFixture()
    const connection = useConnectionStore()
    connection.activeId = 'saved-A'; await flushPromises()
    let complete!: () => void
    vi.mocked(shared.data.reload).mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    const calls = vi.mocked(cockpitApi.getCockpitStats).mock.calls.length
    const pending = state.reload(); await flushPromises()
    connection.activeId = null
    void state.reload(); await flushPromises()
    expect(cockpitApi.getCockpitStats).toHaveBeenCalledTimes(calls)
    complete(); await pending; await flushPromises()
    expect(cockpitApi.getCockpitStats).toHaveBeenCalledTimes(calls + 1)
    expect(state.costSourceKind).toBe('cockpit')
  })

  it('passes Cockpit metadata only with its successful current reload, not on independent unified entry', async () => {
    const { state, stats } = await openCockpitModelFixture()
    state.activePanel = 'unified'; await flushPromises()
    expect(shared.unifiedLoad.mock.calls.at(-1)).toHaveLength(2)
    await state.reload(); await flushPromises()
    expect(shared.unifiedLoad).toHaveBeenLastCalledWith('1h', expect.any(Object), { stats, accounts: [], localAccess: undefined })
    vi.spyOn(cockpitApi, 'getCockpitGeminiAccounts').mockRejectedValueOnce(new Error('fixture metadata failure'))
    await state.reload(); await flushPromises()
    expect(shared.unifiedLoad.mock.calls.at(-1)).toHaveLength(2)
  })

  it('keeps Unified raw account amounts while primary stats retain ledger enrichment and historical rows', async () => {
    const { state, stats } = await openCockpitModelFixture()
    const rawUsage = { ...stats.totals, estimatedCostUsd: 1 }
    stats.accounts = [{ accountId: 'fixture-account', email: 'current@example.invalid', usage: rawUsage }]
    vi.mocked(cockpitApi.readCostLedger).mockResolvedValue({ accounts: [
      { email: 'current@example.invalid', updatedAt: end.getTime(), usage: { ...rawUsage, estimatedCostUsd: 2 } },
      { email: 'removed@example.invalid', updatedAt: end.getTime(), usage: { ...rawUsage, estimatedCostUsd: 3 } },
    ] })
    state.activePanel = 'unified'; await flushPromises()
    await state.reload(); await flushPromises()
    expect(shared.unifiedLoad).toHaveBeenLastCalledWith('1h', expect.any(Object), expect.objectContaining({ stats }))
    expect(stats.accounts).toHaveLength(1)
    expect(stats.accounts[0].usage.estimatedCostUsd).toBe(1)
    expect(state.cockpitStats.accounts).toHaveLength(2)
    expect(state.cockpitStats.accounts[0].usage.estimatedCostUsd).toBe(2)
    expect(state.cockpitStats.accounts[1]).toMatchObject({ email: 'removed@example.invalid', costIdentityKind: 'ledger-email', usage: { estimatedCostUsd: 3 } })
    expect(cockpitApi.writeCostLedger).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ email: 'current@example.invalid', usage: expect.objectContaining({ estimatedCostUsd: 2 }) }),
      expect.objectContaining({ email: 'removed@example.invalid', usage: expect.objectContaining({ estimatedCostUsd: 3 }) }),
    ]))
  })

  it('keeps Unified duplicate-email raw rows separate when an empty ledger merges the primary rows', async () => {
    const { state, stats } = await openCockpitModelFixture()
    stats.accounts = [
      { accountId: 'raw-A', email: 'same@example.invalid', usage: { ...stats.totals, estimatedCostUsd: 2 } },
      { accountId: 'raw-B', email: 'same@example.invalid', usage: { ...stats.totals, estimatedCostUsd: 1 } },
    ]
    vi.mocked(cockpitApi.readCostLedger).mockResolvedValue({ accounts: [] })
    state.activePanel = 'unified'; await flushPromises()
    const reads = vi.mocked(cockpitApi.getCockpitStats).mock.calls.length
    const unifiedReads = shared.unifiedLoad.mock.calls.length
    await state.reload(); await flushPromises()
    expect(cockpitApi.getCockpitStats).toHaveBeenCalledTimes(reads + 1)
    expect(shared.unifiedLoad).toHaveBeenCalledTimes(unifiedReads + 1)
    expect(shared.unifiedLoad).toHaveBeenLastCalledWith('1h', expect.any(Object), expect.objectContaining({ stats }))
    expect(stats.accounts.map(row => [row.accountId, row.usage.estimatedCostUsd])).toEqual([['raw-A', 2], ['raw-B', 1]])
    expect(state.cockpitStats.accounts.map((row: cockpitApi.CockpitStats['accounts'][number]) => [row.accountId, row.usage.estimatedCostUsd])).toEqual([['raw-A', 2], ['raw-B', 2]])
    expect(cockpitApi.writeCostLedger).toHaveBeenLastCalledWith([
      expect.objectContaining({ email: 'same@example.invalid', usage: expect.objectContaining({ estimatedCostUsd: 2 }) }),
    ])
  })

  it('updates current import and fullscreen failure prefixes without rerunning operations or translating raw details', async () => {
    const view = await open()
    const state = view.vm as any
    state.activePanel = 'upstreams'; await flushPromises()
    const input = { files: [{ text: async () => '{' }], value: 'fixture.json' }
    await state.handleImportFile({ target: input }); await flushPromises()
    expect(state.importResult.message).toMatch(/^导入失败/)
    expect(input.value).toBe('')
    const reloads = vi.mocked(shared.data.reload).mock.calls.length
    nativeWindow.mockImplementationOnce(() => { throw new Error('原始窗口错误') })
    await state.toggleFullscreen(); await flushPromises()
    expect(view.get('[role="alert"]').text()).toContain('切换全屏失败')
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(state.importResult.message).toMatch(/^Import failed:/)
    expect(view.get('[role="alert"]').text()).toContain('Failed to toggle fullscreen: 原始窗口错误')
    expect(nativeWindow).toHaveBeenCalledOnce()
    expect(shared.data.reload).toHaveBeenCalledTimes(reloads)
  })

  it('updates the current CPA credential fallback through the helper callback without treating a failed read as an empty inventory', async () => {
    const view = await open()
    const state = view.vm as any
    useConnectionStore().connections[0].type = 'cliproxy'
    state.cliproxyAuthFileFailure = { detail: '' }
    shared.data.loadFromCliproxy([], null, null, [], {}, {}, '1h', '1h', 7, end, true, () => state.cliproxyAuthFileError)
    await flushPromises()
    expect(shared.data.sourceStates.value.accounts.status).toBe('unavailable')
    expect(shared.data.sourceStates.value.accounts.reason).toContain('当前凭证清单读取失败')
    const requests = vi.mocked(invoke).mock.calls.length
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(shared.data.sourceStates.value.accounts.reason).toContain('Failed to read current credential inventory')
    expect(invoke).toHaveBeenCalledTimes(requests)
  })

  it('restores the detached model window after ordinary and timed Cockpit refreshes without changing the main window', async () => {
    const { state } = await openCockpitModelFixture()
    shared.data.modelCostRange.value = '7d'; await flushPromises()
    expect(shared.data.models.value[0].model).toBe('detached-model')
    await state.reload(); await flushPromises()
    expect(state.range).toBe('1h')
    expect(shared.data.modelCostRange.value).toBe('7d')
    expect(shared.data.models.value[0].model).toBe('detached-model')
    expect(shared.data.modelRoutes.value[0].requestedModel).toBe('detached-model')
    expect(shared.data.trendQueryWindow.value!.end.getTime() - shared.data.trendQueryWindow.value!.start.getTime()).toBe(3600000)
    await vi.advanceTimersByTimeAsync(30000); await flushPromises()
    expect(state.range).toBe('1h')
    expect(shared.data.models.value[0].model).toBe('detached-model')
    expect(shared.data.modelRoutes.value[0].requestedModel).toBe('detached-model')
  })

  it.each(['success', 'failure'])('ignores an older detached %s after a newer same-range generation wins', async older => {
    const { state, logs } = await openCockpitModelFixture()
    const pending: Array<{ resolve: (value: cockpitApi.CockpitRequestLogSummary) => void; reject: (error: Error) => void }> = []
    logs.mockImplementation(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }) }))
    shared.data.modelCostRange.value = '7d'; await flushPromises()
    shared.data.modelCostRange.value = '30d'; await flushPromises()
    shared.data.modelCostRange.value = '7d'; await flushPromises()
    expect(pending).toHaveLength(3)
    pending[2].resolve(modelLog('newest-7d')); await flushPromises()
    expect(shared.data.models.value[0].model).toBe('newest-7d')
    if (older === 'success') pending[0].resolve(modelLog('older-7d'))
    else pending[0].reject(new Error('old failure'))
    pending[1].resolve(modelLog('older-30d')); await flushPromises()
    expect(shared.data.models.value[0].model).toBe('newest-7d')
    expect(shared.data.modelRoutes.value[0].requestedModel).toBe('newest-7d')
    expect(state.modelWindowReadFailed).toBe(false)
  })

  it.each([true, false])('falls back without a reload loop after model-window failure (calendar snapshot: %s)', async available => {
    const { view, state, logs } = await openCockpitModelFixture(available)
    const mainReads = vi.mocked(cockpitApi.getCockpitStats).mock.calls.length
    logs.mockRejectedValue(new Error('fixture model read failed'))
    shared.data.modelCostRange.value = '7d'; await flushPromises()
    expect(state.modelWindowReadFailed).toBe(true)
    expect(shared.data.sourceStates.value.models.status).toBe(available ? 'partial' : 'unavailable')
    expect(shared.data.sourceStates.value.modelRoutes.status).toBe('unavailable')
    expect(shared.data.sourceStates.value.models.updatedAt).toBeNull()
    expect(shared.data.sourceStates.value.modelRoutes.updatedAt).toBeNull()
    expect(cockpitApi.getCockpitStats).toHaveBeenCalledTimes(mainReads)
    expect(shared.data.modelRoutes.value).toEqual([])
    if (available) expect(shared.data.models.value[0].model).toBe('calendar-model')
    else expect(shared.data.models.value).toEqual([])
    state.activePanel = 'overview'; i18n.global.locale.value = 'en'; await flushPromises()
    expect(view.text()).toContain(available ? 'saved calendar totals' : 'no saved totals are available')
  })

  it('does not treat complete trend buckets as a complete account log window or invent zeros for absent accounts', async () => {
    mixed(); shared.data.accounts.value.push(account(3, 'apikey'))
    shared.data.rangeAccountStatsComplete.value = false
    shared.data.trendTruncated.value = false
    const view = await open()
    const state = view.vm as any
    expect(state.operatingUsageReady).toBe(true)
    expect(state.operatingUsageComplete).toBe(false)
    expect(state.operatingUsageForId('3')).toBeNull()
    expect(state.operatingSummary.expenseCny.total).toBeNull()
    expect(state.operatingSummary.expenseCny.knownSubtotal).toBe(110)
  })

  it('keeps unknown Sub2API cache writes unknown in the actual model table', async () => {
    shared.data.models.value = [{ model: 'cache-fixture', requests: 1, input_tokens: 100, cache_read_tokens: 20, cache_creation_tokens: null, output_tokens: 10, total_cost: 1, account_cost: 1, actual_cost: 1 }] as never
    shared.data.sourceStates.value.models = sourceState('models', 'measured')
    const view = await open()
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    expect(view.get('.cost-model-table tbody').text()).toContain('缓存命中率未确认')
    shared.data.models.value[0].cache_creation_tokens = 0; await flushPromises()
    expect(view.get('.cost-model-table tbody').text()).toContain('输入缓存命中 16.7%')
  })

  it('keeps canonical string model-account IDs instead of coercing them to NaN or all accounts', async () => {
    const canonical = { ...account(1, 'apikey'), id: 'cockpit:codex:account-27', name: '原始账号' } as never
    shared.data.accounts.value = [canonical, account(2, 'apikey')]
    const view = await open()
    const state = view.vm as any
    state.modelCostAccountSelection = 'cockpit:codex:account-27'; await flushPromises()
    expect(shared.data.modelCostAccountId.value).toBe('cockpit:codex:account-27')
    expect(state.modelCostAccountSelection).toBe('cockpit:codex:account-27')
    state.modelCostAccountSelection = '2'; await flushPromises()
    expect(shared.data.modelCostAccountId.value).toBe(2)
    state.modelCostAccountSelection = 'all'; await flushPromises()
    expect(shared.data.modelCostAccountId.value).toBeNull()
  })
  it('changes only pool accounting when filtering providers, keeping global economics, charts and monthly budget unchanged', async () => {
    mixed(); const view = await open()
    const state = view.vm as any
    const economics = state.accountEconomics
    const adaptive = state.adaptiveEconomics
    const budget = state.monthlyProcurementForecastCny
    const loads = vi.mocked(shared.data.loadAccountEconomics).mock.calls.length
    const reloads = vi.mocked(shared.data.reload).mock.calls.length
    expect(economics.actual.window_economic_cost_cny).toBe(110)
    await view.get('[aria-label="渠道成本平台"]').findAll('button').find(button => button.text() === 'Codex')!.trigger('click'); await flushPromises()
    expect(state.poolOperatingSummary.expenseCny.total).toBe(40)
    expect(state.accountEconomics).toEqual(economics)
    expect(state.adaptiveEconomics).toEqual(adaptive)
    expect(state.monthlyProcurementForecastCny).toBe(budget)
    expect(shared.data.loadAccountEconomics).toHaveBeenCalledTimes(loads)
    expect(shared.data.reload).toHaveBeenCalledTimes(reloads)
    await view.get('[aria-label="渠道成本平台"]').findAll('button').find(button => button.text() === 'Claude 官方')!.trigger('click'); await flushPromises()
    expect(state.poolOperatingSummary.expenseCny.total).toBe(70)
    expect(state.accountEconomics.actual.window_economic_cost_cny).toBe(110)
    expect(state.adaptiveEconomics).toEqual(adaptive)
    expect(state.monthlyProcurementForecastCny).toBe(budget)
  })

  it('includes unattributed records in the actual today account-cost total without counting them as accounts', async () => {
    mixed()
    shared.data.todayStats.value = { '1': usage({ cost: 2 }), [UNATTRIBUTED_USAGE_ACCOUNT_ID]: usage({ cost: 3.5 }) }
    shared.data.sourceStates.value.todayStats = sourceState('todayStats', 'measured')
    const view = await open()
    expect((view.vm as any).todayAccountCostUsd).toBe(5.5)
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    expect(view.get('[data-label="今日调用费用"] strong').text()).toBe('$5.500')
    expect((view.vm as any).operatingSummary.accountCount).toBe(2)
  })

  it('retains only failed bulk selections and keeps the inspector open after partial save failure', async () => {
    mixed(); const view = await open()
    const state = view.vm as any
    state.activePanel = 'upstreams'; state.selectedAccountIds = new Set([1, 2]); await flushPromises()
    state.openBulkCostProfile(); await flushPromises()
    shared.data.bulkSaveCostProfile = vi.fn().mockResolvedValue({ success: 1, failed: 1, results: [{ account_id: 1, success: true }, { account_id: 2, success: false, error: 'fixture failure' }] })
    const profile = { amount: 10, currency: 'CNY', billing_cycle: 'monthly', started_at: start.toISOString() }
    await state.saveSelectedCostProfile(profile); await flushPromises()
    expect(shared.data.bulkSaveCostProfile).toHaveBeenCalledWith([1, 2], profile)
    expect([...state.selectedAccountIds]).toEqual([2])
    expect(state.bulkCostEdit).toBe(true)
    expect(state.selectedAccount).not.toBeNull()
    expect(view.find('cost-profile-inspector-stub').exists()).toBe(true)
  })

  it('switches every cost workspace label without reloading data, writing finance or changing the pool or model window', async () => {
    mixed(); const view = await open()
    const state = view.vm as any
    for (const panel of ['overview', 'upstreams', 'oauth', 'api', 'unified', 'finance', 'governance']) {
      state.activePanel = panel; await flushPromises()
      const reloads = vi.mocked(shared.data.reload).mock.calls.length
      const financeReads = vi.mocked(getFinanceLedger).mock.calls.length
      const unifiedReads = shared.unifiedLoad.mock.calls.length
      const selectedPool = state.poolPlatform
      const modelWindow = shared.data.modelCostRange.value
      const total = state.operatingSummary.expenseCny.total
      i18n.global.locale.value = 'en'; await flushPromises()
      expect(view.get(`[aria-label="${i18n.global.t('costCenter.text.costCenterWorkspaces')}"]`).text()).toContain('Asset Overview')
      expect(view.get('[aria-label="Time range"]').exists()).toBe(true)
      expect(view.get('h1').text()).not.toMatch(/\p{Script=Han}/u)
      expect(state.poolPlatform).toBe(selectedPool)
      expect(shared.data.modelCostRange.value).toBe(modelWindow)
      expect(state.operatingSummary.expenseCny.total).toBe(total)
      expect(shared.data.reload).toHaveBeenCalledTimes(reloads)
      expect(getFinanceLedger).toHaveBeenCalledTimes(financeReads)
      expect(shared.unifiedLoad).toHaveBeenCalledTimes(unifiedReads)
      expect(saveFinanceEvent).not.toHaveBeenCalled()
      expect(saveFinanceBatch).not.toHaveBeenCalled()
      i18n.global.locale.value = 'zh'; await flushPromises()
      expect(view.get(`[aria-label="${i18n.global.t('costCenter.text.costCenterWorkspaces')}"]`).text()).toContain('资产总览')
    }
  })

  it('ranks local reference output and displays CPA latency as history without creating current probe evidence', async () => {
    const view = await open()
    useConnectionStore().connections[0].type = 'cliproxy'
    const managed = account(1, 'apikey'); managed.name = '原始账号 Alpha'; managed.extra = { cliproxy_identity_source: 'management' }
    shared.data.accounts.value = [managed]
    shared.data.cliproxyLocalAccountLink.value = true
    shared.data.rangeAccountStatsScope.value = { source: 'cliproxy', instanceId: 'local' }
    shared.data.rangeAccountStats.value = { '1': usage({ user_cost: null, standard_cost: 10 }) }
    shared.data.cliproxyLatencyMap.value = { '1': 12.3 }
    const state = view.vm as any
    state.cliproxyOverview = { version: null, authFileCount: 1, routingStrategy: null, debug: null }
    state.activePanel = 'upstreams'; state.rankingMetric = 'output'
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(state.upstreamRows[0].rankingEligible).toBe(true)
    expect(state.upstreamRows[0].rank).toBe(1)
    expect(view.text()).toContain('原始账号 Alpha')
    expect(view.text()).toContain('Latest recorded latency')
    expect(view.find('upstream-probe-cell-stub').exists()).toBe(false)
    expect(state.probeCapable).toBe(false)
    expect(shared.data.probes.value).toEqual({})
  })

  it('keeps every toolbar action and prevents a negative countdown while a refresh is in flight', async () => {
    let complete!: () => void
    vi.mocked(shared.data.reload).mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    const view = await open()
    const toggle = view.get('[aria-label="暂停自动刷新"]')
    expect(toggle.text()).toContain('刷新中')
    for (const label of ['统计时间', '自动刷新周期', '成本账本', '数据管理', '刷新数据', '切换全屏']) expect(view.find(`[aria-label="${label}"]`).exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(45000)
    expect((view.vm as any).countdown).toBeGreaterThanOrEqual(0)
    expect(toggle.text()).toContain('刷新中')
    expect(shared.data.reload).toHaveBeenCalledTimes(1)
    complete(); await flushPromises()
    expect((view.vm as any).countdown).toBe(30)
    expect(toggle.text()).toContain('30s')
    expect(view.get(`[aria-label="${i18n.global.t('costCenter.text.costCenterWorkspaces')}"]`).findAll('button').length).toBeGreaterThanOrEqual(5)
    expect(view.find('.cost-more-tools').exists()).toBe(false)
    const back = view.get('.cost-toolbar > [aria-label="返回连接界面"]')
    expect(back.element.nextElementSibling).toBe(view.get(`[aria-label="${i18n.global.t('costCenter.text.costCenterWorkspaces')}"]`).element)
    expect(view.find('.cost-toolbar__actions [aria-label="返回连接界面"]').exists()).toBe(false)
    useConnectionStore().connections[0].type = 'cliproxy'; await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '6', ctrlKey: true, cancelable: true })); await flushPromises()
    expect((view.vm as any).activePanel).toBe('unified')
    expect(view.get(`[aria-label="${i18n.global.t('costCenter.text.costCenterWorkspaces')}"]`).findAll('button').map(button => button.get('span').text())).toEqual(['资产总览', '账号排行', '渠道成本', 'API 接入', '管理面板', '三端汇总'])
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    const settings = view.findAll('.cost-provenance-strip > div').find(item => item.get('strong').text() === '费用兜底设置')!
    expect(settings.text()).toContain('估算倍率＝')
    expect(settings.text()).not.toContain('成本估算倍率')
    expect(settings.text()).not.toContain('×')
    expect(settings.get('[aria-label="美元汇率"]').attributes()).toMatchObject({ type: 'number', min: '4', max: '10', step: '0.01' })
    expect(settings.get('[aria-label="估算倍率"]').element).toBe(settings.findAll('input')[1].element)
    expect(settings.findAll('input')[1].attributes()).toMatchObject({ type: 'number', min: '0.1', max: '10', step: '0.1' })
  })

  it('keeps recorded CPA periods separate, including expired percentages and a real zero', async () => {
    const view = await open()
    useConnectionStore().connections[0].type = 'cliproxy'
    const managed = { ...account(1, 'oauth'), id: 'cliproxy:raw-a', extra: { cliproxy_identity_source: 'management' } }
    shared.data.accounts.value = [managed]
    const fiveStamp = new Date(end.getTime() - 3600000).toISOString()
    const sevenStamp = new Date(end.getTime() - 7200000).toISOString()
    const five: RecordedQuotaProgress = { utilization: 84, resets_at: new Date(end.getTime() - 1000).toISOString(), remaining_seconds: 0, recorded_at: fiveStamp, snapshot_source: 'recorded' }
    const seven: RecordedQuotaProgress = { utilization: 0, resets_at: new Date(end.getTime() + 86400000).toISOString(), remaining_seconds: 86400, recorded_at: sevenStamp, snapshot_source: 'recorded' }
    shared.data.accountUsage.value = { [managed.id]: { source: 'passive', updated_at: end.toISOString(), five_hour: five, seven_day: seven, seven_day_sonnet: null } }
    shared.data.sourceStates.value.accountUsage = sourceState('accountUsage', 'unavailable', 'last source read failed')
    ;(view.vm as any).activePanel = 'upstreams'; await flushPromises()
    const fiveRow = view.get('[data-usage-window="5h"]')
    const sevenRow = view.get('[data-usage-window="7d"]')
    expect(fiveRow.get('strong').text()).toBe('84%')
    expect(fiveRow.get('em').attributes('style')).toContain('84%')
    expect(fiveRow.text()).toContain('等待更新')
    expect(fiveRow.text()).toContain('上次 84%')
    expect(sevenRow.get('strong').text()).toBe('0%')
    expect(sevenRow.text()).not.toContain('等待更新')
    const periods = (view.vm as any).upstreamRows[0].quotaWindows
    expect(periods.find((item: { key: string }) => item.key === '5h').state.updatedAt).toBe(fiveStamp)
    expect(periods.find((item: { key: string }) => item.key === '7d').state.updatedAt).toBe(sevenStamp)
    expect(shared.data.sourceStates.value.accountUsage.status).toBe('unavailable')
    expect(managed.priority).toBe(0)
  })

  it('adds already-read Cockpit quotas for the exact account without promoting a model limit to overall 7d', async () => {
    const view = await open()
    useConnectionStore().activeId = null
    const managed = { ...account(1, 'oauth', 'anthropic'), id: 'cockpit:raw-a', extra: { cockpit_account_id: 'raw-a' } }
    shared.data.accounts.value = [managed]
    const snapshot: QuotaSnapshot = { channel: 'claude_manager', accountId: 'raw-a', email: null, modelId: 'seven_day_sonnet', displayName: 'raw model pool', percent: 80, remainingFraction: .8, usedFraction: .2, percentKind: 'remaining', unavailableReason: null, scope: 'model', windowKind: 'weekly', windowStartedAtMs: null, resetAtMs: null, source: 'snapshot', fetchedAtMs: end.getTime(), updatedAtMs: null, stale: false, rawKind: 'fixture', plan: null }
    ;(view.vm as any).channelQuota.snapshotsByChannel.value = { claude_manager: [snapshot] }
    ;(view.vm as any).activePanel = 'upstreams'; await flushPromises()
    expect(view.get('[data-usage-window="5h"] strong').text()).toBe('—')
    expect(view.get('[data-usage-window="7d"] strong').text()).toBe('—')
    const model = view.get('[data-usage-window="sonnet-7d"]')
    expect(model.text()).toContain('Sonnet·7d')
    expect(model.get('strong').text()).toBe('20%')
    expect(model.text()).toContain('更新时间未知')
    expect((view.vm as any).upstreamRows[0].quotaWindows.find((item: { key: string }) => item.key === 'sonnet-7d').state.updatedAt).toBeNull()
    expect(shared.data.accountUsage.value[managed.id]).toBeUndefined()
    expect(managed.priority).toBe(0)
  })

  it('keeps all twelve channel metrics in one grid with their amounts and missing coverage intact', async () => {
    const view = await open()
    useConnectionStore().connections[0].type = 'cliproxy'
    const managed = account(1, 'apikey'); managed.extra = { cliproxy_identity_source: 'management' }
    shared.data.accounts.value = [managed]
    shared.data.cliproxyLocalAccountLink.value = true
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: 1, routingStrategy: null, debug: null }
    shared.data.rangeAccountStatsScope.value = { source: 'cliproxy', instanceId: 'local' }
    shared.data.rangeAccountStats.value = { '1': usage({ cost: null, known_cost: 1, standard_cost: null, known_standard_cost: 10, user_cost: null }) }
    await flushPromises()
    const summary = view.get('.cost-pool-summary')
    const allMetrics = summary.findAll('.metric')
    const metrics = allMetrics.slice(6)
    expect(view.find('.cost-oauth-header').exists()).toBe(false)
    expect(view.get('.cost-oauth-heading h2').text()).toBe('渠道成本')
    expect(view.get('.cost-oauth-heading').find('.metric').exists()).toBe(false)
    expect(view.find('.cost-oauth-kpis').exists()).toBe(false)
    expect(allMetrics).toHaveLength(12)
    expect(allMetrics.every(item => item.element.parentElement === summary.element)).toBe(true)
    expect(allMetrics[11].element.nextElementSibling).toBe(summary.get('.cost-pool-output').element)
    expect(allMetrics.slice(0, 6).map(item => item.attributes('data-label'))).toEqual(['时段内账号 / 当前账号', '最近 30 天账号池运营费用', '最近 30 天账号池已记录损失', '最近 30 天账号费用估算（美元）', '最近 30 天账号池用量估值（美元）', '账号池运行状态'])
    expect(metrics).toHaveLength(6)
    expect(metrics.slice(0, 3).map(item => item.get('strong').text())).toEqual(['$0.013889/h', '¥0.009722/h', '$10.0000'])
    for (const metric of metrics.slice(0, 3)) {
      expect(metric.get('strong').text()).not.toContain('待补资料')
      expect(metric.get('small').text()).toContain('已算部分 · 1 待补资料；')
    }
    expect(metrics[0].get('small').text()).toContain('最近 30 天')
    expect(metrics[1].get('small').text()).toContain('同组账号的购买费用分摊')
    expect(metrics[2].get('small').text()).toContain('含能确认所属账号的历史用量')
    expect(metrics[5].get('strong').text()).toBe('1 项待补资料')
  })

  it('keeps local history and every original metric dimension with honest unavailable and stale states', async () => {
    const view = await open()
    useConnectionStore().connections[0].type = 'cliproxy'
    const managed = account(1, 'apikey'); managed.extra = { cliproxy_identity_source: 'management', cliproxy_usage_linked: false }
    const historic = account(2, 'oauth'); historic.extra = { cliproxy_identity_source: 'usage_only', cliproxy_auth_type_known: false }
    Object.assign(managed, { priority: null }); Object.assign(historic, { priority: null })
    shared.data.accounts.value = [managed, historic]
    shared.data.rangeAccountStatsScope.value = { source: 'cliproxy', instanceId: 'local' }
    shared.data.rangeAccountStats.value = { '1': usage({ user_cost: null }), '2': usage({ user_cost: null }) }
    shared.data.models.value = [{ model: 'gpt-5', requests: 7, input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, total_cost: 1, account_cost: 0.2, actual_cost: null, failed_zero_token_requests: 1 }] as never
    shared.data.modelRoutes.value = [localRoute()]
    shared.data.modelRoutes.value[0].cacheReadTokens = 20
    shared.data.modelRoutes.value[0].totalTokens = 120
    shared.data.cliproxyQuotaDataState.value = 'not_reported'
    shared.data.sourceStates.value.accountUsage = sourceState('accountUsage', 'unavailable', 'quota not reported')
    shared.data.sourceStates.value.modelAudit = sourceState('modelAudit', 'unavailable', 'source has no response-model audit')
    shared.data.cliproxyLocalAccountLink.value = true
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: 1, routingStrategy: null, debug: null }
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    expect((view.vm as any).currentAccountHealth).toEqual({ normal: 1, limited: 0, error: 0, inactive: 0 })
    expect(view.get('[data-label="可用账号"]').attributes('state')).toBe('measured')
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: null, routingStrategy: null, debug: null }; await flushPromises()
    expect((view.vm as any).currentAccountHealth).toBeNull()
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: 0, routingStrategy: null, debug: null }
    shared.data.accounts.value = [historic]; await flushPromises()
    expect((view.vm as any).currentAccountHealth).toEqual({ normal: 0, limited: 0, error: 0, inactive: 0 })
    shared.data.cliproxyLocalAccountLink.value = false; await flushPromises()
    expect((view.vm as any).currentAccountHealth).toBeNull()
    expect((view.vm as any).currentAccountHealthReason).toContain('未关联本机凭证')
    shared.data.cliproxyLocalAccountLink.value = true
    shared.data.accounts.value = [managed, historic]
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: 1, routingStrategy: null, debug: null }; await flushPromises()
    expect((view.vm as any).accountLedgers.find((row: { account: Account }) => row.account.id === 2).billingMode).toBe('unknown')
    expect((view.vm as any).operatingRows.find((row: { accountId: string }) => row.accountId === '2').billingMode).toBe('unknown')
    expect((view.vm as any).operatingRows.map((row: { accountId: string }) => row.accountId)).toContain('2')
    expect(view.findAll('.asset-overview .metric')).toHaveLength(14)
    for (const label of ['本期毛利（估算）', '回本率', '预计回本时间']) expect(view.findAll('.metric').find(item => item.attributes('data-label') === label)!.text()).toContain('不适用')
    for (const label of ['窗口已录采购付款', '窗口已录退款', '期末剩余预付']) expect(view.find(`[data-label="${label}"]`).exists()).toBe(false)
    expect(view.get('.cost-model-audit-summary').text()).toContain('source has no response-model audit')
    expect(view.find('[aria-label="上游响应模型审计筛选"]').exists()).toBe(true)
    const modelTable = view.get('[aria-label="模型成本表，可横向滚动"]')
    expect(modelTable.get('thead').text()).toContain('用户计费金额')
    expect(modelTable.get('thead').text()).toContain('计费差额')
    expect(modelTable.get('thead').findAll('th')).toHaveLength(10)
    expect(modelTable.get('tbody').text()).toContain('1 次失败未记录有效 Token')
    const routes = view.get('.cost-route-table')
    expect(routes.findAll('thead th')).toHaveLength(12)
    expect(routes.findAll('tbody tr')[0].findAll('td')).toHaveLength(12)
    expect(routes.findAll('tbody tr')[0].findAll('td')[10].get('strong').text()).toBe('120')
    expect(routes.get('thead').text()).toContain('转发接口')
    expect(routes.get('tbody').text()).toContain('源未记录渠道')
    shared.data.modelRoutes.value[0].groupName = '真实分组'
    shared.data.modelRoutes.value[0].inboundEndpoint = '/v1/responses'; await flushPromises()
    expect(routes.get('thead').text()).toContain('分组')
    expect(routes.get('thead').text()).toContain('接收接口')
    expect(routes.findAll('thead th')).toHaveLength(12)
    ;(view.vm as any).activePanel = 'upstreams'; await flushPromises()
    expect(view.get('.cost-data-table thead').text()).toContain('用量时段')
    expect(view.get('.cost-data-table thead').text()).toContain('优先级')
    expect(view.get('.cost-data-table thead').findAll('th')).toHaveLength(16)
    expect(view.get('.cost-data-table tbody tr').findAll('td')).toHaveLength(16)
    expect(view.get('.cost-data-table colgroup').findAll('col')).toHaveLength(16)
    expect((view.vm as any).upstreamColumnCount).toBe(16)
    expect((view.vm as any).upstreamRows).toHaveLength(2)
    expect(view.get<HTMLInputElement>('.cost-ranking-bar__historical input').element.checked).toBe(true)
    const usageRow = view.findAll('.cost-data-table tbody tr').find(row => row.text().includes('Account 2'))!
    expect(usageRow.text()).toContain('用量身份')
    expect(usageRow.text()).toContain('未匹配当前管理账号')
    expect(usageRow.text()).not.toContain('已移出当前池')
    await view.get('.cost-ranking-bar__historical input').setValue(false)
    expect((view.vm as any).upstreamRows).toHaveLength(1)
    await view.get('.cost-ranking-bar__historical input').setValue(true)
    shared.data.accounts.value[0].priority = 0; await flushPromises()
    expect(view.get('.cost-data-table thead').text()).toContain('优先级')
    expect((view.vm as any).upstreamColumnCount).toBe(16)
    shared.data.rangeAccountStats.value = { '2': usage({ user_cost: null }) }; await flushPromises()
    expect(view.findAll('.cost-data-table tbody tr').find(row => row.text().includes('Account 1'))!.text()).toContain('未匹配用量')
    shared.data.cliproxyQuotaDataState.value = 'read_unavailable'
    shared.data.sourceStates.value.accountUsage = sourceState('accountUsage', 'unavailable', 'quota read failed'); await flushPromises()
    expect(view.get('.cost-data-table thead').text()).toContain('用量时段')
    expect(view.get('.cost-data-table tbody').text()).toContain('quota read failed')
    shared.data.cliproxyManagementSnapshotAt.value = end.toISOString()
    shared.data.sourceStates.value.accounts = sourceState('accounts', 'stale', 'cached management snapshot; management read failed')
    ;(view.vm as any).cliproxyAuthFileFailure = { detail: 'credentials read failed' }; await flushPromises()
    expect((view.vm as any).currentAccountHealth).toEqual({ normal: 1, limited: 0, error: 0, inactive: 0 })
    expect((view.vm as any).currentAccountHealthReason).toContain(end.toISOString())
    expect((view.vm as any).currentAccountHealthReason).toContain('management read failed')
    expect((view.vm as any).currentAccountHealthReason).toContain('credentials read failed')
    expect((view.vm as any).operatingSummary.expenseCny.total).toBeNull()
    shared.data.sourceStates.value.accounts = sourceState('accounts', 'unavailable', 'management failed'); await flushPromises()
    expect((view.vm as any).currentAccountHealth).toBeNull()
    useConnectionStore().connections[0].type = 'sub2api'
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    expect(view.find('.cost-model-audit-summary').exists()).toBe(true)
    expect(view.find('[aria-label="上游响应模型审计筛选"]').exists()).toBe(true)
    expect(view.get('[aria-label="模型成本表，可横向滚动"] thead').text()).toContain('用户计费金额')
    expect(view.get('[aria-label="成本账本"]').exists()).toBe(true)
  })

  it('shows successfully queried recorded loss as zero, but never fabricates it after a ledger read failure', async () => {
    shared.data.accounts.value = [account(1, 'apikey')]
    shared.data.rangeAccountStats.value = { '1': usage() }
    const view = await open()
    expect((view.vm as any).windowImpairmentCny).toBe(0)
    expect((view.vm as any).oauthImpairmentCny).toBe(0)
    expect(view.findAll('.metric').find(item => item.attributes('data-label')?.includes('账号池已记录损失'))!.text()).toContain('¥0.0000')
    shared.data.sourceStates.value.costLoss = sourceState('costLoss', 'unavailable', 'source has no loss ledger')
    vi.mocked(getFinanceLedger).mockRejectedValueOnce(new Error('ledger read failed'))
    await view.get('[aria-label="统计时间"]').setValue('7d'); await flushPromises()
    expect((view.vm as any).windowImpairmentCny).toBeNull()
    expect((view.vm as any).oauthImpairmentCny).toBeNull()
    expect(view.findAll('.metric').find(item => item.attributes('data-label')?.includes('账号池已记录损失'))!.text()).toContain('ledger read failed')
    shared.data.sourceStates.value.costLoss = sourceState('costLoss', 'measured'); await flushPromises()
    expect((view.vm as any).windowImpairmentCny).toBe(0)
  })

  it('shows a proven local unit-cost upper bound and preserves both known subtotals when expense is also incomplete', async () => {
    const view = await open()
    useConnectionStore().connections[0].type = 'cliproxy'
    const managed = account(1, 'apikey'); managed.extra = { cliproxy_identity_source: 'management' }
    shared.data.accounts.value = [managed]
    shared.data.cliproxyLocalAccountLink.value = true
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: 1, routingStrategy: null, debug: null }
    shared.data.rangeAccountStatsScope.value = { source: 'cliproxy', instanceId: 'local' }
    shared.data.rangeAccountStats.value = { '1': usage({ cost: 1, standard_cost: null, known_standard_cost: 10, user_cost: null }) }
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    const state = view.vm as any
    expect(state.cnyPerBilledUsd).toBeNull()
    expect(state.overviewUnitCost.value).toBe('≤ ¥0.7000/USD')
    expect(state.overviewUnitCost.note).toContain('上限')
    expect(view.get('.asset-overview [data-label="每 $1 用量花费"]').text()).toContain('≤ ¥0.7000/USD')
    ;(view.vm as any).activePanel = 'oauth'; await flushPromises()
    expect(state.poolUnitCost.value).toBe('≤ ¥0.7000/USD')
    shared.data.rangeAccountStats.value = { '1': usage({ cost: null, known_cost: 1, standard_cost: null, known_standard_cost: 10, user_cost: null }) }; await flushPromises()
    expect(state.poolUnitCost.value).toContain('目前能算出的费用 ¥7.0000 / 用量估值 $10.0000')
    expect(state.poolUnitCost.note).toContain('待补')
    shared.data.rangeAccountStats.value = { '1': usage({ cost: 1, standard_cost: 5, user_cost: null }) }; await flushPromises()
    expect(state.cnyPerBilledUsd).toBeCloseTo(1.4)
    expect(state.poolUnitCost.value).toBe('¥1.4000/USD')
    expect(state.unitCostPresentation({ total: -1, knownSubtotal: -1, unknownCount: 0 }, { total: null, knownSubtotal: 10, unknownCount: 1 }).value).not.toContain('≤')
  })
  it('reads other unified sources after a failed current source, both on entry and on a failed visible reload', async () => {
    shared.data.rangeAccountStatsScope.value = null
    shared.data.rangeAccountStatsWindow.value = null
    shared.data.lastUpdated.value = null
    shared.data.sourceStates.value.rangeStats = sourceState('rangeStats', 'unavailable')
    vi.mocked(shared.data.reload).mockRejectedValue(new Error('current source failed'))
    const errors: unknown[] = []
    const view = await open(error => errors.push(error))
    expect(shared.unifiedLoad).not.toHaveBeenCalled()
    ;(view.vm as any).activePanel = 'unified'; await flushPromises()
    expect(shared.unifiedLoad).toHaveBeenCalledOnce()
    expect(shared.unifiedLoad).toHaveBeenLastCalledWith('30d', period)
    await view.get('[aria-label="刷新数据"]').trigger('click'); await flushPromises()
    expect(shared.unifiedLoad).toHaveBeenCalledTimes(2)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every(error => String(error).includes('current source failed'))).toBe(true)
  })
  it('renders selected-window pool facts and a nonzero small hourly rate when today has no requests', async () => {
    shared.data.accounts.value = [account(1, 'apikey')]
    shared.data.rangeAccountStats.value = { '1': usage() }
    const view = await open()
    expect(view.text()).toContain('$0.002957')
    expect(view.get('.cost-pool-table tbody').text()).toContain('$2.1292')
    expect(view.get('.cost-pool-table tbody').text()).toContain('7')
    expect(view.text()).not.toContain('源不支持采样')
    expect((view.vm as any).oauthRequests).toBe(7)
    expect((view.vm as any).meteredHourlyCny((view.vm as any).accountLedgers[0])).toBeCloseTo(0.5 * 7 / 720)
    expect((view.vm as any).formatRate(0.0000001, 'USD')).toBe('<$0.000001/h')
    expect((view.vm as any).formatRate(0, 'USD')).toBe('$0.000000/h')
    shared.data.opsOverview.value = { request_count_total: 11346, success_count: 10945, error_count_total: 401, error_rate: 0.005 } as NonNullable<typeof shared.data.opsOverview.value>
    expect((view.vm as any).errorRate).toBeCloseTo(401 / 11346)
    expect((view.vm as any).requestFailureNote).toContain('全部失败占比 3.5%')
    expect((view.vm as any).requestFailureNote).toContain('SLA 错误率 0.5%')
    shared.data.opsOverview.value = null
    expect(getFinanceLedger).toHaveBeenLastCalledWith({ source: 'sub2api', instanceId: 'saved-A', startMs: start.getTime(), endMs: end.getTime() })
    expect(shared.unifiedLoad).not.toHaveBeenCalled()
    ;(view.vm as any).activePanel = 'unified'; await flushPromises()
    expect(shared.unifiedLoad).toHaveBeenCalledOnce()
    expect(shared.unifiedLoad).toHaveBeenCalledWith('30d', period)
    ;(view.vm as any).activePanel = 'oauth'
    useConnectionStore().connections[0].type = 'cliproxy'
    shared.data.accounts.value[0].extra = { cliproxy_identity_source: 'management' }
    shared.data.cliproxyLocalAccountLink.value = true
    ;(view.vm as any).cliproxyOverview = { version: null, authFileCount: 1, routingStrategy: null, debug: null }
    shared.data.rangeAccountStatsScope.value = { source: 'cliproxy', instanceId: 'local' }
    shared.data.rangeAccountStats.value = { '1': usage({ cost: 2.12924, standard_cost: 10.6462, user_cost: null }) }
    await flushPromises()
    expect((view.vm as any).poolOperatingSummary.revenueUsd.total).toBeNull()
    expect((view.vm as any).poolOperatingSummary.contributionCny).toBeNull()
    expect((view.vm as any).poolOperatingSummary.hourlyExpenseCny.total).toBeCloseTo(2.12924 * 7 / 720)
    expect((view.vm as any).formatRate(2.12924 / 720, 'USD')).toBe('$0.002957/h')
    expect(getFinanceLedger).toHaveBeenLastCalledWith({ source: 'cliproxy', instanceId: 'local', startMs: start.getTime(), endMs: end.getTime() })
    shared.data.accounts.value = Array.from({ length: 11 }, (_, index) => account(index + 1, 'apikey'))
    shared.data.rangeAccountStats.value = Object.fromEntries(shared.data.accounts.value.map(item => [String(item.id), usage({ requests: item.id === 1 ? 275 : 1, cost: item.id === 1 ? 1 : 0, standard_cost: item.id === 1 ? 5 : 0, user_cost: null })]))
    shared.data.rangeAccountStats.value[UNATTRIBUTED_USAGE_ACCOUNT_ID] = usage({ requests: 263, cost: 1.12924, standard_cost: 5.6462, user_cost: null })
    ;(view.vm as any).activePanel = 'overview'; await flushPromises()
    const state = view.vm as any
    expect(state.participationRequestTotal).toBe(548)
    expect(state.unattributedWindowRequests).toBe(263)
    expect(state.operatingSummary.accountCount).toBe(11)
    expect(state.operatingSummary.referenceValueUsd.total).toBeCloseTo(10.6462)
    expect(state.operatingSummary.unclassifiedUsageCostUsd.total).toBeCloseTo(1.12924)
    expect(state.operatingSummary.expenseCny.total).toBeNull()
    expect(state.unknownPlanFallbackCount).toBe(0)
    expect(view.get('.cost-distribution-panel').text()).toContain('285 个已关联账号 + 263 次未关联请求')
    expect(state.accountDistribution.reduce((sum: number, row: { value: number }) => sum + row.value, 0)).toBe(548)
    expect(state.accountDistribution.reduce((sum: number, row: { share: number }) => sum + row.share, 0)).toBeCloseTo(1)
    expect(state.accountDistribution.find((row: { name: string }) => row.name === '其他账号').value).toBe(5)
    expect(state.poolGroups.find((group: { isUnattributed: boolean }) => group.isUnattributed).count).toBe(0)
    expect(view.get('.asset-overview__total span').text()).toBe('累计费用')
    useConnectionStore().connections[0].type = 'sub2api'
    shared.data.rangeAccountStatsScope.value = { source: 'sub2api', instanceId: 'saved-A' }
    ;(view.vm as any).activePanel = 'oauth'; await flushPromises()
    await view.get('[aria-label="渠道成本平台"]').findAll('button').find(button => button.text() === 'OpenAI 官方')!.trigger('click'); await flushPromises()
    expect(state.oauthRequests).toBe(285)
    expect(state.poolOperatingSummary.accountCount).toBe(11)
  })
  it('uses recorded procurement before profile estimates and excludes subscription API value from operating expense', async () => {
    mixed(); const view = await open()
    expect((view.vm as any).operatingSummary.expenseCny.total).toBe(110)
    expect((view.vm as any).operatingSummary.contributionCny).toBe(940)
    expect(view.findAll('.metric').find(item => item.attributes('data-label')?.includes('账号池运营费用'))!.text()).toContain('¥110.0000')
    expect(shared.data.todayStats.value).toEqual({})
  })
  it('keeps a single provider expense, output and rate on the same account IDs despite a full-instance source snapshot', async () => {
    mixed(); const view = await open()
    await view.get('[aria-label="渠道成本平台"]').findAll('button').find(button => button.text() === 'Codex')!.trigger('click'); await flushPromises()
    expect((view.vm as any).poolOperatingSummary.expenseCny.total).toBe(40)
    expect((view.vm as any).poolOperatingSummary.revenueUsd.total).toBe(100)
    expect((view.vm as any).poolOperatingSummary.hourlyExpenseCny.total).toBe(0)
    expect((view.vm as any).accountEconomics.actual.window_economic_cost_cny).toBe(110)
    await view.get('[aria-label="渠道成本平台"]').findAll('button').find(button => button.text() === 'Claude 官方')!.trigger('click'); await flushPromises()
    expect((view.vm as any).poolOperatingSummary.expenseCny.total).toBe(70)
    expect((view.vm as any).poolOperatingSummary.revenueUsd.total).toBe(50)
    expect((view.vm as any).poolOperatingSummary.hourlyExpenseCny.total).toBeCloseTo(70 / 720)
  })
  it('retains orphan known subtotals with unknown profit and rejects another instance or stale range map', async () => {
    mixed(); shared.data.accounts.value = shared.data.accounts.value.slice(0, 1)
    shared.data.rangeAccountStats.value = { '1': usage({ requests: 0, cost: 0, standard_cost: 0, user_cost: 0 }), '9': usage({ cost: null, known_cost: 5, standard_cost: null, known_standard_cost: 10, user_cost: 20 }) }
    const view = await open()
    expect(view.text()).toContain('¥40.0000 已算部分 · 1 待补资料')
    expect(view.text()).toContain('资料待确认的历史账号')
    expect((view.vm as any).operatingSummary.contributionCny).toBeNull()
    expect((view.vm as any).oauthWindowCostSummary.knownSubtotal).toBe(5)
    shared.data.rangeAccountStatsScope.value = { source: 'sub2api', instanceId: 'saved-B' }; await flushPromises()
    expect((view.vm as any).operatingUsageReady).toBe(false)
    expect((view.vm as any).operatingRows.map((row: { accountId: string }) => row.accountId)).not.toContain('9')
    shared.data.rangeAccountStatsScope.value = { source: 'sub2api', instanceId: 'saved-A' }
    await view.get('[aria-label="统计时间"]').setValue('7d'); await flushPromises()
    expect((view.vm as any).operatingUsageReady).toBe(false)
    expect((view.vm as any).operatingSummary.contributionCny).toBeNull()
  })
})
