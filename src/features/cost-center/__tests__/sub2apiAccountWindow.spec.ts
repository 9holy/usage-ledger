import './costDataI18n'
/** Account windows reuse exact usage_logs; the official batch endpoint only supplies a natural day. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveUsageStatsFor } from '../accountRowUsageBasis'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listCostLossStates: vi.fn(),
  getBatchTodayStats: vi.fn(),
  getUsage: vi.fn(),
  getEconomicsSnapshot: vi.fn(),
  getSnapshotV2: vi.fn(),
  channelsList: vi.fn(),
  getPricingStatus: vi.fn(),
  opsSnapshot: vi.fn(),
  getSettings: vi.fn(),
  usageList: vi.fn(),
}))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    accounts: {
      list: mocks.list,
      listCostLossStates: mocks.listCostLossStates,
      getBatchTodayStats: mocks.getBatchTodayStats,
      getUsage: mocks.getUsage,
      getEconomicsSnapshot: mocks.getEconomicsSnapshot,
    },
    dashboard: { getSnapshotV2: mocks.getSnapshotV2 },
    channels: { list: mocks.channelsList, getPricingStatus: mocks.getPricingStatus, getModelDefaultPricing: vi.fn(async () => ({})) },
    ops: { getDashboardSnapshotV2: mocks.opsSnapshot },
    settings: { getSettings: mocks.getSettings },
    usage: { list: mocks.usageList },
  },
}))

vi.mock('../exchangeRate', () => ({
  loadUsdCnyExchangeRate: vi.fn(async () => ({ rate: 7.2, rateDate: null, fetchedAt: null, source: 'fallback' })),
  getStoredUserOverrideRate: vi.fn(() => null),
}))

import {
  accountWindowUsageFromWindowStats,
  rangeNeedsAccountWindow,
  useCostCenterData,
} from '../useCostCenterData'
import type { CostCenterRange } from '../useCostCenterData'
import type { Account, WindowStats, AdminUsageLog } from '@/types'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'

const ACCOUNT_ID = 4242
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * 测试**自带**的窗口长度 / 窗口名表(刻意不复用 production 的 usageWindowBounds / 标签映射)——
 * 若断言里调用被测函数自己算期望值,「把窗口起点算成自然日」这类缺陷会被一起测过去。
 */
const WINDOW_SPAN_MS: Record<Exclude<CostCenterRange, 'today'>, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
}
const WINDOW_LABELS: Record<Exclude<CostCenterRange, 'today'>, string> = {
  '1m': '最近 1 分钟',
  '5m': '最近 5 分钟',
  '30m': '最近 30 分钟',
  '1h': '最近 1 小时',
  '6h': '最近 6 小时',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
}
// type='apikey' ⇒ shouldLoadUsageWindow() 为假,不触发上游 getUsage 请求,测试只关注窗口链路。
const account = { id: ACCOUNT_ID, name: 'acc-1', platform: 'openai', type: 'apikey' } as unknown as Account

function todayStatsPayload(requests: number, cost: number, userCost: number) {
  return { stats: { [String(ACCOUNT_ID)]: { requests, tokens: requests * 100, cost, standard_cost: cost * 2, user_cost: userCost } } }
}

function stubReloadDeps() {
  mocks.list.mockResolvedValue({ items: [account], total: 1 })
  mocks.listCostLossStates.mockResolvedValue({ states: [] })
  mocks.getSnapshotV2.mockResolvedValue({ trend: [], stats: null })
  mocks.usageList.mockResolvedValue({ items: [], total: 0 })
  mocks.channelsList.mockResolvedValue({ items: [] })
  mocks.getPricingStatus.mockResolvedValue({})
  mocks.opsSnapshot.mockResolvedValue({})
  mocks.getSettings.mockResolvedValue({})
  mocks.getUsage.mockResolvedValue({})
  mocks.getEconomicsSnapshot.mockRejectedValue(new Error('economics disabled in test'))
}

describe('sub2api 逐账号观察窗口统计接入', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 17, 21, 0, 0))
    stubReloadDeps()
    mocks.getBatchTodayStats.mockResolvedValue(todayStatsPayload(3, 0.3, 0.9))
  })
  afterEach(() => vi.useRealTimers())

  function log(id: number, createdAt: number, extra: Partial<AdminUsageLog> = {}): AdminUsageLog {
    return { id, account_id: ACCOUNT_ID, model: 'fixture', created_at: new Date(createdAt).toISOString(), input_tokens: 60, output_tokens: 40, cache_creation_tokens: 0, cache_read_tokens: 0, total_cost: 4, account_stats_cost: 2, account_rate_multiplier: 0.5, actual_cost: 9, ...extra } as AdminUsageLog
  }
  async function reload(range: CostCenterRange) {
    const data = useCostCenterData()
    data.modelCostRange.value = range
    await data.reload(range)
    return data
  }

  it.each(Object.keys(WINDOW_SPAN_MS) as Exclude<CostCenterRange, 'today'>[])('%s: uses the existing exact log scan instead of assuming start_time is supported by the natural-day batch endpoint', async (range) => {
    const now = Date.now()
    mocks.usageList.mockResolvedValue({ items: [log(1, now - 1000), log(2, now - WINDOW_SPAN_MS[range] - 1000)] })
    const data = await reload(range)
    expect(mocks.getBatchTodayStats).toHaveBeenCalledTimes(1)
    expect(mocks.usageList).toHaveBeenCalledTimes(1)
    expect(data.rangeStats.value(account)).toEqual({ requests: 1, tokens: 100, cost: 1, standard_cost: 4, user_cost: 9 })
    expect(data.rangeWindowAuthoritative.value).toBe(true)
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(data.rangeAccountStatsComplete.value).toBe(true)
    expect(data.sourceStates.value.rangeStats.reason).toContain(WINDOW_LABELS[range])
    if (WINDOW_SPAN_MS[range] < DAY_MS) expect(data.todayStats.value[String(ACCOUNT_ID)]?.requests).toBe(3)
  })

  it('reuses the complete long-window log scan for today rather than keeping a contradictory natural-day batch result', async () => {
    mocks.usageList.mockResolvedValue({ items: [log(1, Date.now() - 1000), log(2, Date.now() - 2 * DAY_MS)] })
    const data = await reload('7d')
    expect(data.rangeStats.value(account)?.requests).toBe(2)
    expect(data.todayStats.value[String(ACCOUNT_ID)]?.requests).toBe(1)
    expect(mocks.usageList).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to today or invent zero when the exact log source fails', async () => {
    mocks.usageList.mockRejectedValue(new Error('usage 503'))
    const data = await reload('1h')
    expect(data.rangeStats.value(account)).toBeNull()
    expect(data.rangeWindowAuthoritative.value).toBe(true)
    expect(data.sourceStates.value.rangeStats.status).toBe('unavailable')
    expect(data.rangeAccountStatsComplete.value).toBe(false)
    expect(data.sourceStates.value.rangeStats.reason).toContain('503')
    expect(data.todayStats.value[String(ACCOUNT_ID)]?.requests).toBe(3)
  })

  it('loads global account facts independently when model logs are account-filtered and the dashboard snapshot is exact', async () => {
    const end = new Date(), start = new Date(end.getTime() - 3600000)
    mocks.getSnapshotV2.mockResolvedValue({ trend: [], models: [], start_time: start.toISOString(), end_time: end.toISOString() })
    mocks.usageList.mockImplementation(async ({ account_id }) => ({ items: account_id == null
      ? [log(1, Date.now() - 1000), log(2, Date.now() - 2000, { account_id: 9999 })]
      : [log(1, Date.now() - 1000)] }))
    const data = useCostCenterData()
    data.modelCostRange.value = '1h'
    data.modelCostAccountId.value = ACCOUNT_ID
    await data.reload('1h')
    expect(data.rangeStats.value(account)?.requests).toBe(1)
    expect(data.rangeAccountStats.value['9999']?.requests).toBe(1)
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(data.modelRoutes.value.reduce((sum, row) => sum + row.requests, 0)).toBe(1)
    expect(mocks.usageList.mock.calls.map(([params]) => params.account_id)).toEqual([ACCOUNT_ID, undefined])
  })

  it('keeps the global observation window independent of a detached model window', async () => {
    mocks.usageList.mockImplementation(async ({ start_date, end_date }) => ({ items: start_date === end_date
      ? [log(1, Date.now() - 1000)]
      : [log(1, Date.now() - 1000), log(2, Date.now() - 2 * DAY_MS)] }))
    const data = useCostCenterData()
    data.modelCostRange.value = '7d'
    await data.reload('1h')
    expect(data.rangeStats.value(account)?.requests).toBe(1)
    expect(data.modelRoutes.value.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(mocks.usageList).toHaveBeenCalledTimes(2)
  })

  it('exposes the remote snapshot bucket granularity rather than the fallback log bucket size', async () => {
    mocks.getSnapshotV2.mockImplementation(async (params) => ({
      start_time: params.start_time, end_time: params.end_time, granularity: 'day', models: [], trend: [],
    }))
    const data = await reload('7d')
    expect(data.trendBucketHours.value).toBe(24)
    mocks.getSnapshotV2.mockResolvedValue({ trend: [], stats: null })
    await data.reload('7d')
    expect(data.trendBucketHours.value).toBe(2)
  })

  it('keeps account-window truncation separate from an exact dashboard snapshot', async () => {
    mocks.getSnapshotV2.mockImplementation(async (params) => ({
      start_time: params.start_time, end_time: params.end_time, granularity: 'hour', models: [], trend: [],
    }))
    mocks.usageList.mockImplementation(async ({ page }) => ({
      items: Array.from({ length: 1000 }, (_, index) => log((page - 1) * 1000 + index + 1, Date.now() - 1000)),
    }))
    const data = await reload('1h')
    expect(data.trendTruncated.value).toBe(false)
    expect(data.rangeAccountStatsComplete.value).toBe(false)
    expect(data.rangeStats.value(account)?.requests).toBe(25000)
    expect(data.sourceStates.value.rangeStats.status).toBe('partial')
    mocks.usageList.mockResolvedValue({ items: [] })
    await data.reload('1h')
    expect(data.rangeAccountStatsComplete.value).toBe(true)
    expect(data.sourceStates.value.rangeStats.status).toBe('empty')
  })

  it('retains a precise snapshot when the server groups a short query into a coarser day bucket', async () => {
    const day = new Date(); day.setUTCHours(0, 0, 0, 0)
    mocks.getSnapshotV2.mockImplementation(async (params) => ({
      start_time: params.start_time, end_time: params.end_time, granularity: 'day', models: [],
      trend: [{ date: day.toISOString(), requests: 1, input_tokens: 60, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 100, cost: 4, actual_cost: 9 }],
    }))
    const data = await reload('1h')
    expect(data.trendBucketHours.value).toBe(24)
    expect(data.trend.value).toHaveLength(1)
    expect(data.trend.value[0]).toMatchObject({ date: day.toISOString(), requests: 1, cost: 4 })
  })

  it('keeps unknown log amounts unknown, while a complete empty query produces real zero account rows', async () => {
    mocks.usageList.mockResolvedValue({ items: [log(1, Date.now() - 1000, { total_cost: null, account_stats_cost: null, actual_cost: null, input_tokens: Number.NaN })] })
    const unknown = await reload('1h')
    expect(unknown.rangeStats.value(account)).toMatchObject({ requests: 1, tokens: null, cost: null, standard_cost: null, user_cost: null, known_cost: 0, known_standard_cost: 0, unknown_cost_requests: 1 })
    mocks.usageList.mockResolvedValue({ items: [] })
    const empty = await reload('1h')
    expect(empty.rangeStats.value(account)).toEqual({ requests: 0, tokens: 0, cost: 0, standard_cost: 0, user_cost: 0 })
    expect(empty.sourceStates.value.rangeStats.status).toBe('empty')
  })

  it('keeps window facts usable when only the optional natural-day batch request fails', async () => {
    mocks.getBatchTodayStats.mockRejectedValue(new Error('today batch failed'))
    mocks.usageList.mockResolvedValue({ items: [log(1, Date.now() - 1000)] })
    const data = await reload('1h')
    expect(data.rangeStats.value(account)?.cost).toBe(1)
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(data.sourceStates.value.todayStats.status).toBe('unavailable')
  })

  it('retains exact usage-only account facts when the account list failed', async () => {
    mocks.list.mockRejectedValue(new Error('accounts 500'))
    mocks.usageList.mockResolvedValue({ items: [log(1, Date.now() - 1000, { account_id: 9999 })] })
    const data = await reload('7d')
    expect(mocks.getBatchTodayStats).not.toHaveBeenCalled()
    expect(data.accounts.value).toEqual([])
    expect(data.rangeAccountStats.value['9999']).toMatchObject({ requests: 1, cost: 1, standard_cost: 4, user_cost: 9 })
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'sub2api', instanceId: null })
    expect(data.rangeAccountStatsWindow.value).toEqual({ start: new Date(Date.now() - 7 * DAY_MS), end: new Date() })
    expect(mocks.usageList).toHaveBeenCalledTimes(1)
  })

  it('today uses exact natural-day logs without a second batch call or fallback to rolling data', async () => {
    mocks.getBatchTodayStats.mockResolvedValue(todayStatsPayload(5, 0.5, 0.8))
    const data = await reload('today')
    expect(mocks.getBatchTodayStats).toHaveBeenCalledTimes(1)
    expect(data.rangeWindowAuthoritative.value).toBe(true)
    expect(data.todayStats.value[String(ACCOUNT_ID)]?.requests).toBe(0)
    expect(data.sourceStates.value.todayStats.status).toBe('empty')
    expect(data.rangeAccountStats.value[String(ACCOUNT_ID)]?.requests).toBe(0)
    expect(data.rangeAccountStatsWindow.value?.start.getHours()).toBe(0)
  })

  it('retains known sums without calling a mixed-price account complete', async () => {
    mocks.usageList.mockResolvedValue({ items: [log(1, Date.now() - 1000), log(2, Date.now() - 2000, { total_cost: null, account_stats_cost: null })] })
    const data = await reload('30d')
    expect(data.rangeAccountStats.value[String(ACCOUNT_ID)]).toMatchObject({ requests: 2, cost: null, standard_cost: null, known_cost: 1, known_standard_cost: 4, unknown_cost_requests: 1, user_cost: 18 })
    expect(data.sourceStates.value.rangeStats.status).toBe('partial')
  })

  it('retains account-less log facts in a separate bucket and marks attribution partial', async () => {
    mocks.usageList.mockResolvedValue({ items: [log(1, Date.now() - 1000), { ...log(2, Date.now() - 2000), account_id: null }] })
    const data = await reload('30d')
    expect(data.rangeAccountStats.value[UNATTRIBUTED_USAGE_ACCOUNT_ID]).toMatchObject({ requests: 1, tokens: 100, cost: 1, standard_cost: 4, user_cost: 9 })
    expect(Object.values(data.rangeAccountStats.value).reduce((n, row) => n + row.requests, 0)).toBe(2)
    expect(data.accounts.value.map(row => String(row.id))).not.toContain(UNATTRIBUTED_USAGE_ACCOUNT_ID)
    expect(data.sourceStates.value.rangeStats.status).toBe('partial')
    expect(data.sourceStates.value.rangeStats.reason).toContain('1 条请求未归属账号')
    expect(data.rangeAccountStatsWindow.value).not.toBeNull()
    expect(data.rangeAccountStatsScope.value?.source).toBe('sub2api')
  })
})

describe('accountWindowUsageFromWindowStats 空值契约', () => {
  it('requests 非有限 ⇒ 整体 null,不伪造全 0 记录', () => {
    expect(accountWindowUsageFromWindowStats({ requests: Number.NaN } as WindowStats)).toBeNull()
    expect(accountWindowUsageFromWindowStats({} as WindowStats)).toBeNull()
  })

  it('成本 / Token 非有限 ⇒ null 而不是 0', () => {
    expect(accountWindowUsageFromWindowStats({ requests: 5 } as WindowStats)).toEqual({
      requests: 5,
      tokens: null,
      cost: null,
      standard_cost: null,
      user_cost: null,
    })
  })

  it('真实的 0 原样保留(0 是实测值,不是缺数据)', () => {
    expect(accountWindowUsageFromWindowStats({ requests: 0, tokens: 0, cost: 0, standard_cost: 0, user_cost: 0 } as WindowStats)).toEqual({
      requests: 0,
      tokens: 0,
      cost: 0,
      standard_cost: 0,
      user_cost: 0,
    })
  })
})

describe('rangeNeedsAccountWindow', () => {
  it('除 today 外全部需要单独取窗口(1m~30d);today 由自然日批量请求覆盖', () => {
    for (const range of Object.keys(WINDOW_SPAN_MS) as Exclude<CostCenterRange, 'today'>[]) {
      expect(rangeNeedsAccountWindow(range)).toBe(true)
    }
    expect(rangeNeedsAccountWindow('today')).toBe(false)
  })
})

describe('视图回退契约(CostCenterView)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')

  it('usageStatsFor 在窗口源权威时返回 null,不得回退 row.today', () => {
    // ★ 2026-09-26:判定已搬进纯函数 `accountRowUsageBasis.resolveUsageStatsFor`。
    //   **文本扫描钉不住语义** —— 把函数体改成 `return row.today` 时,任何 `toContain` 都照样全绿。
    //   ⇒ 语义部分**直测纯函数**,视图只做接线(断言它真的把 rangeWindowAuthoritative 传下去了)。
    const row = { today: { requests: 1 } as never, window: null }
    expect(resolveUsageStatsFor(row, true), '窗口源权威 ⇒ 不得回退自然日').toBeNull()
    expect(resolveUsageStatsFor(row, false), '非权威且有今日值 ⇒ 回退自然日').toBe(row.today)
    // 接线:视图必须把权威标记真实传下去(写死 false 会让上面的语义永远走不到)。
    const start = source.indexOf('function usageStatsFor')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('resolveUsageStatsFor(row, data.rangeWindowAuthoritative.value)')
  })

  it('usageWindowLabel 在窗口源权威时用被请求的窗口名,不写「今日」', () => {
    const start = source.indexOf('const usageWindowLabel = computed')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n})', start))
    expect(body).toContain('data.rangeWindowAuthoritative.value')
    expect(body).toContain('return rangeLabel.value')
  })

  it('rowUserCostNote 会带上窗口源自己的原因', () => {
    const start = source.indexOf('function rowUserCostNote')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('rangeWindowAuthoritative')
    expect(body).toContain('sourceStates.value.rangeStats.reason')
  })
})
