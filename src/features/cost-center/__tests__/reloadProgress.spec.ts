import './costDataI18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const mocks = vi.hoisted(() => ({ usage: vi.fn(), quota: vi.fn(), accounts: vi.fn(), economics: vi.fn(), channels: vi.fn(), batch: vi.fn() }))
vi.mock('@/api/admin', () => ({ adminAPI: {
  accounts: { list: mocks.accounts, listCostLossStates: vi.fn(async () => ({ states: [] })), getBatchTodayStats: mocks.batch, getUsage: mocks.quota, getEconomicsSnapshot: mocks.economics },
  usage: { list: mocks.usage },
  dashboard: { getSnapshotV2: vi.fn(async () => ({ trend: [], models: [] })) },
  channels: { list: mocks.channels, getPricingStatus: vi.fn(async () => ({})), getModelDefaultPricing: vi.fn(async () => ({})) },
  ops: { getDashboardSnapshotV2: vi.fn(async () => ({ overview: {}, throughput_trend: { points: [] } })) },
  settings: { getSettings: vi.fn(async () => ({})) },
} }))
vi.mock('../exchangeRate', () => ({ loadUsdCnyExchangeRate: vi.fn(async () => ({ rate: 7, rateDate: null, fetchedAt: null, source: 'fallback' })), getStoredUserOverrideRate: () => null }))
import { useCostCenterData } from '../useCostCenterData'
import type { AdminUsageLog } from '@/types'
import { setActiveConnection } from '@/api/url'

const now = new Date('2026-10-16T00:00:00Z')
const log = (id: number, cost = 1): AdminUsageLog => ({ id, account_id: 1, model: 'fixture-model', created_at: new Date(now.getTime() - id * 1000).toISOString(), input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost: cost, actual_cost: cost, account_rate_multiplier: 1 } as AdminUsageLog)
function dataFor(range: '30d' | '1h' = '30d') { const data = useCostCenterData(); data.modelCostRange.value = range; return data }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.clearAllMocks()
  setActiveConnection({ id: 'own-sub', type: 'sub2api', name: 'fixture', baseUrl: 'https://own.example.test', apiKey: 'fixture-key', authMode: 'apikey', lastUsed: 1 })
  mocks.accounts.mockResolvedValue({ items: [] })
  mocks.channels.mockResolvedValue({ items: [] })
  mocks.batch.mockResolvedValue({ stats: {} })
  mocks.quota.mockResolvedValue({})
  mocks.economics.mockResolvedValue({ data_quality: { status: 'complete' }, projection: { confidence: 'low' }, actual: {} })
})
afterEach(() => { vi.useRealTimers(); setActiveConnection(null) })

describe('cost reload progress and shared window logs', () => {
  it('reads every account and channel page with stable id ordering, without splitting an API batch that has no server limit', async () => {
    const accounts = Array.from({ length: 1005 }, (_, index) => ({ id: index + 1, platform: 'openai', type: 'apikey' }))
    const channels = Array.from({ length: 1005 }, (_, index) => ({ id: index + 1, name: `channel-${index + 1}`, model_pricing: [] }))
    mocks.accounts.mockImplementation(async (page) => ({ items: accounts.slice((page - 1) * 1000, page * 1000), total: 1005, pages: 2, page, page_size: 1000 }))
    mocks.channels.mockImplementation(async (page) => ({ items: channels.slice((page - 1) * 1000, page * 1000), total: 1005, pages: 2, page, page_size: 1000 }))
    mocks.usage.mockResolvedValue({ items: [{ ...log(1), account_id: 1005, channel_id: 1005 }] })
    const data = dataFor()
    await data.reload('30d')
    expect(data.accounts.value).toHaveLength(1005)
    expect(mocks.accounts.mock.calls.map(([page]) => page)).toEqual([1, 2])
    expect(mocks.channels.mock.calls.map(([page]) => page)).toEqual([1, 2])
    expect(mocks.accounts.mock.calls[1][2]).toMatchObject({ sort_by: 'id', sort_order: 'asc' })
    expect(data.modelRoutes.value[0].channelName).toBe('channel-1005')
    expect(mocks.batch).toHaveBeenCalledTimes(1)
    expect(mocks.batch.mock.calls[0][0]).toHaveLength(1005)
    expect(data.rangeStats.value(data.accounts.value.find((account) => account.id === 1005)!)?.requests).toBe(1)
  })

  it.each(['reject', 'empty'] as const)('never labels an incomplete account page sequence as a complete list: %s', async (failure) => {
    mocks.accounts.mockImplementation(async (page) => {
      if (page === 2 && failure === 'reject') throw new Error('page failed')
      return { items: page === 1 ? Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 })) : [], total: 1005, page, pages: 2, page_size: 1000 }
    })
    mocks.usage.mockResolvedValue({ items: [] })
    const data = dataFor()
    await data.reload('30d')
    expect(data.accounts.value).toHaveLength(0)
    expect(data.sourceStates.value.accounts.status).toBe('unavailable')
    expect(mocks.batch).not.toHaveBeenCalled()
  })

  it('retains route facts but marks them partial when a later channel page fails', async () => {
    mocks.channels.mockImplementation(async (page) => {
      if (page === 2) throw new Error('channel page failed')
      return { items: Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 })), total: 1001, page, pages: 2 }
    })
    mocks.usage.mockResolvedValue({ items: [log(1)] })
    const data = dataFor()
    await data.reload('30d')
    expect(data.modelRoutes.value).toHaveLength(1)
    expect(data.sourceStates.value.modelRoutes.status).toBe('partial')
    expect(data.sourceStates.value.modelRoutes.reason).toContain('渠道清单未读全')
  })

  it('keeps at most four quota requests in flight across superseded background batches', async () => {
    const accounts = (start: number) => Array.from({ length: 13 }, (_, index) => ({ id: start + index, platform: 'openai', type: 'oauth' }))
    mocks.accounts.mockResolvedValue({ items: accounts(1) })
    mocks.usage.mockResolvedValue({ items: [] })
    let inFlight = 0, peak = 0
    const pending: Array<() => void> = []
    mocks.quota.mockImplementation(() => {
      inFlight += 1; peak = Math.max(peak, inFlight)
      return new Promise((resolve) => pending.push(() => { inFlight -= 1; resolve({}) }))
    })
    const data = dataFor()
    await data.reload('30d')
    expect(data.loading.value).toBe(false)
    expect(mocks.quota).toHaveBeenCalledTimes(4)
    data.invalidatePendingRequest()
    mocks.accounts.mockResolvedValue({ items: accounts(100) })
    await data.reload('30d')
    expect(mocks.quota).toHaveBeenCalledTimes(4)
    while (pending.length) { pending.shift()!(); await flushPromises() }
    expect(peak).toBe(4)
    expect(mocks.quota.mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4, ...accounts(100).map((account) => account.id)])
    expect(data.sourceStates.value.accountUsage.status).toBe('measured')
    await data.reload('30d')
    await flushPromises()
    expect(mocks.quota).toHaveBeenCalledTimes(17)
  })

  it('stops dispatching quota requests when the connection changes without a new sequence', async () => {
    mocks.accounts.mockResolvedValue({ items: Array.from({ length: 13 }, (_, index) => ({ id: index + 1, platform: 'openai', type: 'oauth' })) })
    mocks.usage.mockResolvedValue({ items: [] })
    const pending: Array<() => void> = []
    mocks.quota.mockImplementation(() => new Promise((resolve) => pending.push(() => resolve({}))))
    const data = dataFor()
    await data.reload('30d')
    setActiveConnection({ id: 'other', type: 'sub2api', name: 'fixture', baseUrl: 'https://other.example.test', apiKey: 'fixture', lastUsed: 1 })
    for (const finish of pending) finish()
    await flushPromises()
    expect(mocks.quota).toHaveBeenCalledTimes(4)
    expect(data.accountUsage.value).toEqual({})
  })

  it('does not request the next account page after the source connection changes', async () => {
    let finish!: (value: unknown) => void
    mocks.accounts.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    mocks.usage.mockResolvedValue({ items: [] })
    const data = dataFor()
    const pending = data.reload('30d')
    await flushPromises()
    setActiveConnection({ id: 'other', type: 'sub2api', name: 'fixture', baseUrl: 'https://other.example.test', apiKey: 'fixture', lastUsed: 1 })
    finish({ items: Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 })), total: 1001, pages: 2, page: 1 })
    await pending
    expect(mocks.accounts).toHaveBeenCalledTimes(1)
    expect(data.accounts.value).toEqual([])
  })

  it('publishes independent snapshots while the log scan is still pending, without claiming the exact cost window is complete', async () => {
    let finish!: (value: unknown) => void
    mocks.usage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const data = dataFor()
    const pending = data.reload('30d')
    await flushPromises()
    expect(data.sourceStates.value.ops.status).toBe('empty')
    expect(data.sourceStates.value.settings.status).toBe('measured')
    expect(data.sourceStates.value.pricing.status).toBe('measured')
    expect(data.sourceStates.value.dashboard.status).toBe('partial')
    expect(data.sourceStates.value.modelRoutes.status).toBe('loading')
    expect(data.trendQueryWindow.value).toBeNull()
    finish({ items: [], total: 0 })
    await pending
    expect(data.loading.value).toBe(false)
    expect(data.trendQueryWindow.value).toEqual({ start: new Date(now.getTime() - 30 * 86400000), end: now })
    expect(data.sourceStates.value.dashboard.status).toBe('empty')
  })

  it('reuses one paginated log scan for routes, models and the exact trend even when the server total is only a has-more lower bound', async () => {
    mocks.usage.mockImplementation(async ({ page }) => ({ items: page === 1 ? Array.from({ length: 1000 }, (_, index) => log(index + 1)) : [log(1001)], total: page * 1000 + 1, page, page_size: 1000 }))
    const data = dataFor()
    await data.reload('30d')
    expect(mocks.usage.mock.calls.map(([params]) => params.page)).toEqual([1, 2])
    expect(data.trend.value.reduce((sum, point) => sum + Number(point.requests), 0)).toBe(1001)
    expect(data.modelRoutes.value.reduce((sum, row) => sum + row.requests, 0)).toBe(1001)
    expect(data.trendTruncated.value).toBe(false)
    expect(data.sub2apiWindowReading.value).toMatchObject({ source: 'sub2api', instanceId: 'sub2api:own-sub', records: 1001, tokens: 2002, costUsd: 1001 })
    expect(data.sub2apiWindowConnection.value).toEqual({ id: 'own-sub', baseUrl: 'https://own.example.test' })
  })

  it('deduplicates shifting offset pages without using the distinct count to infer pagination coverage', async () => {
    mocks.usage.mockImplementation(async ({ page }) => ({ items: page === 1
      ? [...Array.from({ length: 999 }, (_, index) => log(index + 1)), log(999)]
      : [log(999, 99), log(1000), log(1001)] }))
    const data = dataFor()
    await data.reload('30d')
    expect(mocks.usage.mock.calls.map(([params]) => params.page)).toEqual([1, 2])
    expect(data.modelRoutes.value.reduce((sum, row) => sum + row.requests, 0)).toBe(1001)
    expect(data.models.value.reduce((sum, row) => sum + row.requests, 0)).toBe(1001)
    expect(data.trend.value.reduce((sum, point) => sum + point.requests, 0)).toBe(1001)
    expect(data.rangeAccountStats.value['1']).toMatchObject({ requests: 1001, cost: 1001, user_cost: 1001 })
    expect(data.sub2apiWindowReading.value).toMatchObject({ records: 1001, costUsd: 1001 })
    expect(data.trendTruncated.value).toBe(false)
  })

  it('keeps the full 25,000-row bound and exposes truncation as partial instead of inventing full coverage', async () => {
    mocks.usage.mockImplementation(async ({ page }) => ({ items: Array.from({ length: 1000 }, (_, index) => log((page - 1) * 1000 + index + 1)), total: page * 1000 + 1 }))
    const data = dataFor()
    await data.reload('30d')
    expect(mocks.usage).toHaveBeenCalledTimes(25)
    expect(data.trendTruncated.value).toBe(true)
    expect(data.modelRoutesTruncated.value).toBe(true)
    expect(data.sourceStates.value.dashboard.status).toBe('partial')
    expect(data.sourceStates.value.models.status).toBe('partial')
    expect(data.trendQueryWindow.value).toEqual({ start: new Date(now.getTime() - 25000 * 1000), end: now })
    expect(data.sub2apiRequestWindow.value).toEqual({ start: new Date(now.getTime() - 30 * 86400000), end: now })
    expect(data.sub2apiWindowReading.value).toMatchObject({ startMs: now.getTime() - 30 * 86400000, state: 'partial', coverageBasis: 'bounded_sample' })
  })

  it('keeps the requested window fixed while awaiting a slow shared log response', async () => {
    mocks.accounts.mockResolvedValue({ items: [{ id: 1, platform: 'openai', type: 'oauth', created_at: new Date(now.getTime() - 86400000).toISOString(), credentials: { plan_type: 'plus' } }] })
    mocks.economics.mockRejectedValue(new Error('economics unavailable'))
    let finish!: (value: unknown) => void
    mocks.usage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const data = dataFor('1h')
    const pending = data.reload('1h')
    await flushPromises()
    vi.setSystemTime(new Date(now.getTime() + 60000))
    finish({ items: [{ ...log(1), created_at: new Date(now.getTime() - 3599000).toISOString() }] })
    await pending
    expect(data.trend.value.reduce((sum, point) => sum + Number(point.requests), 0)).toBe(1)
    expect(data.modelRoutes.value.reduce((sum, row) => sum + row.requests, 0)).toBe(1)
    expect(data.trendQueryWindow.value).toEqual({ start: new Date(now.getTime() - 3600000), end: now })
    expect(data.accountEconomics.value).toMatchObject({ local_derived: { window: { start: new Date(now.getTime() - 3600000), end: now } } })
  })

  it('does not reuse account-filtered model logs as a global observation trend', async () => {
    mocks.usage.mockImplementation(async (params) => ({ items: [log(params.account_id ? 1 : 2, params.account_id ? 2 : 10)] }))
    const data = dataFor()
    data.modelCostAccountId.value = 1
    await data.reload('30d')
    expect(mocks.usage.mock.calls.some(([params]) => params.account_id === 1)).toBe(true)
    expect(mocks.usage.mock.calls.some(([params]) => params.account_id === undefined)).toBe(true)
    expect(data.trend.value.reduce((sum, point) => sum + Number(point.cost), 0)).toBe(10)
    expect(data.sub2apiWindowReading.value).toMatchObject({ costUsd: 10, records: 1 })
  })

  it('does not block finished cost data on a pending optional quota request', async () => {
    mocks.accounts.mockResolvedValue({ items: [{ id: 1, platform: 'openai', type: 'oauth', created_at: now.toISOString() }] })
    mocks.usage.mockResolvedValue({ items: [] })
    let finish!: (value: unknown) => void
    mocks.quota.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const data = dataFor()
    await data.reload('30d')
    expect(data.loading.value).toBe(false)
    expect(data.sourceStates.value.accountUsage.status).toBe('loading')
    expect(data.sourceStates.value.models.status).not.toBe('loading')
    finish({})
    await flushPromises()
    expect(data.sourceStates.value.accountUsage.status).toBe('measured')
  })

  it('stops an obsolete page scan and ignores its results after a window change', async () => {
    let finish!: (value: unknown) => void
    mocks.usage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const data = dataFor()
    const pending = data.reload('30d')
    await flushPromises()
    data.invalidatePendingRequest()
    data.models.value = [{ model: 'new-window' } as never]
    finish({ items: Array.from({ length: 1000 }, (_, index) => log(index + 1)) })
    await pending
    expect(mocks.usage).toHaveBeenCalledTimes(1)
    expect(data.models.value[0].model).toBe('new-window')
  })

  it('lets the model-range watcher own a followed range reload instead of queuing it twice', () => {
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    const rangeWatch = view.slice(view.indexOf('watch(range, (next)'), view.indexOf('watch([modelCostSource'))
    expect(rangeWatch).toContain('else reload()')
    expect(rangeWatch).toContain('data.invalidatePendingRequest()')
  })

  it('never offers globally fetched logs for reuse after their connection changes', async () => {
    let finish!: (value: unknown) => void
    mocks.usage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const data = dataFor()
    const pending = data.reload('30d')
    await flushPromises()
    setActiveConnection({ id: 'other-sub', type: 'sub2api', name: 'fixture', baseUrl: 'https://other.example.test', apiKey: 'other-fixture', lastUsed: 1 })
    finish({ items: [log(1)] })
    await pending
    expect(data.sub2apiWindowReading.value).toBeNull()
  })

  it('keeps cumulative Cockpit snapshot points on their own interval rather than treating their end timestamp as a bucket start', () => {
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    const rate = view.slice(view.indexOf('function financialPointHours'), view.indexOf('const trendActualCost'))
    expect(rate).toContain("!cockpitCostFromRequestLog.value && point.source === 'usage_logs'")
    expect(rate).toContain('return trendCoveredHours.value')
    expect(rate).toContain('trendQueryWindow.value')
  })
})
