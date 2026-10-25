import './costDataI18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveConnection } from '@/api/url'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { CockpitRequestLogSummary, CockpitStats, CostProfileMap } from '@/api/cockpit'
import type { SourceAccount } from '../sourceTypes'
import type { CostProfile } from '../model'
import { accountIdToCostId } from '../cockpitAdapter'
import { i18n } from '@/i18n'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), update: vi.fn(), bulk: vi.fn(), probe: vi.fn() }))
vi.mock('@/api/cockpit', () => ({ readCostProfiles: mocks.read, writeCostProfiles: mocks.write }))
vi.mock('@/api/admin', () => ({ adminAPI: {
  accounts: { update: mocks.update, bulkUpdate: mocks.bulk, testAccount: mocks.probe },
  dashboard: {}, ops: {}, channels: {}, settings: {},
} }))
import { useCostCenterData } from '../useCostCenterData'

const now = new Date('2026-10-25T12:00:00Z')
const profile: CostProfile = { amount: 30, currency: 'USD', billing_cycle: 'monthly', started_at: '2026-10-01T00:00:00Z', source: 'custom', algorithm_version: 'fixture' }
const localConnection = { id: 'local', type: 'cliproxy' as const, baseUrl: 'http://127.0.0.1:8317', name: 'fixture', apiKey: '', lastUsed: 0 }
const prices = { fixture: { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6 } }
let stored: CostProfileMap

function event(patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1, requested_at: now.getTime() - 1000, provider: 'openai', executor_type: 'fixture', model: 'fixture', alias: 'fixture',
    auth_index: 'raw-index', auth_type: 'apikey', source: 'fixture', reasoning_effort: 'high', service_tier: 'auto',
    latency_ms: 50, ttft_ms: 10, failed: false, status_code: 200, input_tokens: 1_000_000, output_tokens: 0,
    reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1_000_000,
    primary_used_percent: null, primary_reset_at: null, primary_used_tokens: null, primary_remaining_tokens: null, primary_limit_tokens: null,
    secondary_used_percent: null, secondary_reset_at: null, secondary_used_tokens: null, secondary_remaining_tokens: null, secondary_limit_tokens: null,
    ...patch,
  }
}

function cockpitFixture() {
  const totals = { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 }
  const stats = { since: now.getTime() - 3600000, updatedAt: now.getTime(), totals,
    accounts: [{ accountId: 'raw-cockpit', email: 'fixture@example.test', usage: totals }], models: [], apiKeys: [],
    daily: { since: now.getTime() - 3600000, updatedAt: now.getTime(), accounts: [], models: [], apiKeys: [], totals }, weekly: null, monthly: null,
  } as CockpitStats
  const summary = { available: true, reason: null, rowCount: 1, windowStartMs: now.getTime() - 3600000, windowEndMs: now.getTime(), bucketHours: 1, bucketLatencies: [], cells: [], groups: [{
    model: 'gpt-6-astra', accountId: 'raw-cockpit', apiKeyId: '', firstMs: now.getTime() - 1000, lastMs: now.getTime() - 1000,
    requests: 1, success: 1, error: 0, stdNormalInput: 1_000_000, stdCached: 0, stdOutput: 0,
    longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0, rateLimited: 0, upstreamError: 0, clientCanceled: 0,
  }] } as CockpitRequestLogSummary
  return { stats, summary }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks()
  setActiveConnection(localConnection)
  stored = { '42': { ...profile, amount: 99 }, '__cockpit_cost_multiplier__': { amount: 0.6 } as CostProfile }
  mocks.read.mockImplementation(async () => ({ ...stored }))
  mocks.write.mockImplementation(async (map: CostProfileMap) => { stored = map })
})
afterEach(() => { setActiveConnection(null); vi.useRealTimers() })

describe('cost store source integration', () => {
  it('keeps previous profiles and multiplier after a strict read failure, and never writes over unread data', async () => {
    stored['cliproxy:raw-index'] = profile
    const data = useCostCenterData()
    await data.preloadLocalCostProfiles()
    mocks.read.mockRejectedValue(new Error('fixture read denied'))
    await data.preloadLocalCostProfiles()
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, now, true)
    await data.mergeLocalCostProfiles()
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(data.cockpitCostMultiplier.value).toBe(0.6)
    expect(data.accounts.value[0].extra?.cost_profile).toMatchObject({ amount: profile.amount })
    expect(data.legacyLocalCostProfileCount.value).toBe(1)
    expect(data.localCostProfilesError.value).toContain('无法确认本地成本档案')
    i18n.global.locale.value = 'en'
    expect(data.localCostProfilesError.value).toContain('Could not verify local cost profiles')
    expect(data.localCostProfilesError.value).toContain('fixture read denied')
    await expect(data.saveCockpitCostProfile(data.accounts.value[0], { ...profile, amount: 99 })).rejects.toThrow('fixture read denied')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(data.saving.value).toBe(false)
    expect(stored['cliproxy:raw-index'].amount).toBe(profile.amount)
  })

  it('continues ordinary source loading when the first profile read fails, without retrying it during merge', async () => {
    mocks.read.mockRejectedValue(new Error('initial fixture read denied'))
    const data = useCostCenterData()
    await data.preloadLocalCostProfiles()
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, now, true)
    await data.mergeLocalCostProfiles()
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(data.rangeAccountStats.value['cliproxy:raw-index'].cost).toBeCloseTo(0.4)
    expect(data.cockpitCostMultiplier.value).toBe(0.2)
    expect(data.localCostProfilesError.value).toContain('无法确认本地成本档案')
    await expect(data.bulkSaveCockpitCostProfile(['cliproxy:raw-index'], profile)).rejects.toThrow('initial fixture read denied')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('retranslates cached source diagnostics in English without changing costs or reading profiles again', async () => {
    const data = useCostCenterData()
    await data.preloadLocalCostProfiles()
    i18n.global.locale.value = 'en'
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, now, true)
    expect(data.sourceStates.value.rangeStats.reason).toContain('Last 1 hour')
    expect(data.sourceStates.value.rangeStats.reason).not.toMatch(/\p{Script=Han}/u)
    expect(data.sourceStates.value.models.reason).toContain('CPA model usage loaded')
    i18n.global.locale.value = 'zh'
    expect(data.sourceStates.value.rangeStats.reason).toContain('最近 1 小时')
    expect(data.rangeAccountStats.value['cliproxy:raw-index'].cost).toBeCloseTo(1.2)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('restores the persisted multiplier before CPA calculations and reuses the profile read for merging', async () => {
    const data = useCostCenterData()
    await data.preloadLocalCostProfiles()
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, now, true)
    await data.mergeLocalCostProfiles()
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(data.cockpitCostMultiplier.value).toBe(0.6)
    expect(data.rangeAccountStats.value['cliproxy:raw-index'].cost).toBeCloseTo(1.2)
    expect(data.models.value[0].account_cost).toBeCloseTo(1.2)
    expect(data.modelRoutes.value[0].accountCost).toBeCloseTo(1.2)
    expect(data.trend.value.reduce((sum, point) => sum + (point.account_cost ?? 0), 0)).toBeCloseTo(1.2)
    expect(data.cliproxyLatencyMap.value['cliproxy:raw-index']).toBe(50)
    expect(data.accounts.value[0].extra?.cost_profile).toBeUndefined()
    expect(data.legacyLocalCostProfileCount.value).toBe(1)

    await data.saveCockpitCostProfile(data.accounts.value[0], profile)
    expect(stored['42'].amount).toBe(99)
    expect(stored['cliproxy:raw-index']).toEqual(profile)
    expect(data.legacyLocalCostProfileCount.value).toBe(1)
    await expect(data.bulkSaveCockpitCostProfile([42], profile)).rejects.toThrow('来源限定')
    expect(mocks.write).toHaveBeenCalledTimes(1)
  })

  it('uses the same SQL routes and grouping for main and independent Cockpit model windows', async () => {
    setActiveConnection(null)
    const data = useCostCenterData(), { stats, summary } = cockpitFixture()
    await data.preloadLocalCostProfiles()
    const groups = new Map([['raw-cockpit', 'Fixture group']])
    data.loadFromCockpit(stats, null, '1h', [], null, new Map(), undefined, [], null, null, null, summary, summary, groups)
    expect(data.accounts.value[0].extra?.cockpit_group_names).toEqual(['Fixture group'])
    expect(data.rangeAccountStats.value[accountIdToCostId('raw-cockpit')].cost).toBeCloseTo(6)
    const main = data.modelRoutes.value.map(row => ({ accountId: row.accountId, requests: row.requests, cost: row.accountCost, tokens: row.totalTokens, group: row.groupName }))
    expect(main).toEqual([{ accountId: accountIdToCostId('raw-cockpit'), requests: 1, cost: 6, tokens: 1_000_000, group: 'Fixture group' }])
    data.loadCockpitModelWindow(summary, null, '1h')
    expect(data.modelRoutes.value.map(row => ({ accountId: row.accountId, requests: row.requests, cost: row.accountCost, tokens: row.totalTokens, group: row.groupName }))).toEqual(main)
    data.loadCockpitModelWindow({ ...summary, rowCount: 0, groups: [] }, [{ model: 'stale-text-route', account_id: 'raw-cockpit', requests: 9 }] as any, '1m')
    expect(data.modelRoutes.value).toEqual([])
    expect(data.sourceStates.value.models.status).toBe('empty')
    expect(data.sourceStates.value.modelRoutes.status).toBe('empty')
  })

  it('retains detached calendar-model and route-log fallbacks as partial without changing main-window facts', () => {
    setActiveConnection(null)
    const data = useCostCenterData(), { stats, summary } = cockpitFixture()
    stats.daily!.models = [{ modelId: 'gpt-6-astra', usage: { ...stats.daily!.totals, requestCount: 3, inputTokens: 1000, totalTokens: 1000 } }]
    data.loadFromCockpit(stats, null, '1h', [], null, new Map(), undefined, [], null, null, null, summary, summary)
    const mainStats = data.rangeAccountStats.value, mainTrend = data.trend.value, mainComplete = data.rangeAccountStatsComplete.value
    data.loadCockpitModelWindow({ ...summary, available: false }, [{ model: 'gpt-6-astra', account_id: 'raw-cockpit', inbound_path: '/v1/responses', requests: 2, success_count: 2, error_count: 0, first_ms: now.getTime() - 1000, last_ms: now.getTime() - 1000 }], '1m')
    expect(data.models.value[0].requests).toBe(3)
    expect(data.modelRoutes.value[0].requests).toBe(2)
    expect(data.sourceStates.value.models.status).toBe('partial')
    expect(data.sourceStates.value.models.reason).toContain('日历快照')
    expect(data.sourceStates.value.modelRoutes.status).toBe('partial')
    expect(data.sourceStates.value.modelRoutes.reason).toContain('路由日志')
    expect(data.modelCostFromRequestLog.value).toBe(false)
    expect(data.rangeAccountStats.value).toBe(mainStats)
    expect(data.trend.value).toBe(mainTrend)
    expect(data.rangeAccountStatsComplete.value).toBe(mainComplete)
    i18n.global.locale.value = 'en'
    expect(data.sourceStates.value.models.reason).toContain('calendar-snapshot')
    expect(data.sourceStates.value.modelRoutes.reason).toContain('Pricing or route fields may be incomplete')
    data.loadCockpitModelWindow({ ...summary, rowCount: 0, groups: [] }, [{ model: 'stale-text-route', account_id: 'raw-cockpit', requests: 9 }] as any, '1m')
    expect(data.models.value).toEqual([])
    expect(data.modelRoutes.value).toEqual([])
    expect(data.sourceStates.value.models.status).toBe('empty')
    expect(data.sourceStates.value.modelRoutes.status).toBe('empty')
  })

  it('marks a detached window unavailable when neither SQL nor model snapshots or route logs are usable', () => {
    const data = useCostCenterData()
    data.loadCockpitModelWindow(null, null, '7d')
    expect(data.models.value).toEqual([])
    expect(data.modelRoutes.value).toEqual([])
    expect(data.sourceStates.value.models.status).toBe('unavailable')
    expect(data.sourceStates.value.modelRoutes.status).toBe('unavailable')
    expect(data.sourceStates.value.models.reason).toContain('不可用')
    expect(data.sourceStates.value.modelRoutes.reason).toContain('不可用')
  })

  it('keeps the published detached model window during a synchronous main-window refresh', () => {
    setActiveConnection(null)
    const data = useCostCenterData(), { stats, summary } = cockpitFixture()
    const weekly = (requests: number) => ({ ...stats.daily!, models: [{ modelId: 'gpt-6-astra', usage: { ...stats.daily!.totals, requestCount: requests, inputTokens: requests * 1_000_000, totalTokens: requests * 1_000_000 } }] })
    stats.weekly = weekly(7)
    data.loadFromCockpit(stats, null, '1h', [], null, new Map(), undefined, [], null, null, null, summary, summary)
    data.modelCostRange.value = '7d'
    const routeLogs = [{ model: 'gpt-6-astra', account_id: 'raw-cockpit', inbound_path: '/v1/responses', requests: 7, success_count: 7, error_count: 0, first_ms: now.getTime() - 1000, last_ms: now.getTime() - 1000 }]
    data.loadCockpitModelWindow(null, routeLogs, '7d')
    const previous = { models: data.models.value, routes: data.modelRoutes.value, audit: data.modelAuditSummary.value,
      modelState: data.sourceStates.value.models, routeState: data.sourceStates.value.modelRoutes, auditState: data.sourceStates.value.modelAudit,
      accounts: data.accounts.value, pricing: data.modelPricing.value }
    expect(previous.models[0].requests).toBe(7)
    expect(previous.modelState.status).toBe('partial')
    data.loadFromCockpit({ ...stats, weekly: weekly(9) }, null, '1h', [], null, new Map(), undefined, [], null, null, null, summary, summary)
    expect(data.models.value).toBe(previous.models)
    expect(data.modelRoutes.value).toBe(previous.routes)
    expect(data.modelAuditSummary.value).toBe(previous.audit)
    expect(data.sourceStates.value.models).toBe(previous.modelState)
    expect(data.sourceStates.value.modelRoutes).toBe(previous.routeState)
    expect(data.sourceStates.value.modelAudit).toBe(previous.auditState)
    expect(data.modelCostFromRequestLog.value).toBe(false)
    expect(data.modelWindowDetached.value).toBe(true)
    expect(data.accounts.value).not.toBe(previous.accounts)
    expect(data.modelPricing.value).not.toBe(previous.pricing)
    expect(data.rangeAccountStats.value[accountIdToCostId('raw-cockpit')].requests).toBe(1)
    data.loadCockpitModelWindow(null, routeLogs, '7d')
    expect(data.models.value[0].requests).toBe(9)
  })

  it('does not retain another source model window when entering Cockpit', () => {
    const data = useCostCenterData(), { stats, summary } = cockpitFixture()
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '7d', 7, now, true)
    data.modelCostRange.value = '7d'
    data.detachModelWindow(true)
    data.loadFromCockpit(stats, null, '1h', [], null, new Map(), undefined, [], null, null, null, summary, summary)
    expect(data.models.value[0].model).toBe('gpt-6-astra')
    expect(data.modelWindowDetached.value).toBe(false)
  })

  it('keeps management failure branching while translating its cached diagnostic getter', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, now, true)
    const message = () => i18n.global.locale.value === 'en' ? 'Management request failed' : '管理请求失败'
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, now, true, message)
    expect(data.sourceStates.value.accounts.status).toBe('stale')
    expect(data.sourceStates.value.accounts.reason).toContain('管理请求失败')
    i18n.global.locale.value = 'en'
    expect(data.sourceStates.value.accounts.reason).toContain('Management request failed')
    expect(data.sourceStates.value.accounts.reason).not.toContain('=>')
  })

  it('limits reasoning counts to the global range and its captured query anchor, not the model window', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, [event(), event({ id: 2, requested_at: now.getTime() - 2 * 3600000, reasoning_effort: 'low' }), event({ id: 3, requested_at: now.getTime(), reasoning_effort: 'medium' })], prices, {}, '1m', '24h', 7, now, true)
    expect(data.cliproxyReasoningEfforts.value?.map(row => [row.key, row.count])).toEqual([['high', 1]])
    expect(data.models.value[0].requests).toBe(2)
  })

  it('refuses local and string IDs at Sub2API mutation boundaries and preserves bulk partial results', async () => {
    const data = useCostCenterData(), local = { id: 'cliproxy:raw-index', extra: {} } as SourceAccount
    await expect(data.saveCostProfile(local, profile)).rejects.toThrow('不是 Sub2API')
    await expect(data.probeAccount(local)).rejects.toThrow('不是 Sub2API')
    await expect(data.bulkSaveCostProfile([7], profile)).rejects.toThrow('不是 Sub2API')
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled(); expect(mocks.bulk).not.toHaveBeenCalled()
    setActiveConnection({ ...localConnection, type: 'sub2api', baseUrl: 'https://fixture.example.test' })
    await expect(data.saveCostProfile({ ...local, id: '7' }, profile)).rejects.toThrow('原始正整数')
    const result = { success: 1, failed: 1, results: [{ id: 7, success: true }, { id: 8, success: false }] }
    mocks.bulk.mockResolvedValue(result)
    expect(await data.bulkSaveCostProfile([7, 8], profile)).toBe(result)
    expect(mocks.bulk.mock.calls[0][0]).toEqual([7, 8])
  })
})
