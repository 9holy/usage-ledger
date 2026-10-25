import './costDataI18n'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { testAccount } = vi.hoisted(() => ({ testAccount: vi.fn() }))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    accounts: { testAccount },
    dashboard: {},
    ops: {},
  },
}))

import {
  buildCostCenterSnapshotQuery,
  buildCostCenterDataQueries,
  economicsWindowHours,
  DEFAULT_COST_CENTER_RANGE,
  accountUsageSource,
  filterModelAuditLogs,
  selectExactWindowModelStats,
  snapshotMatchesRequestedWindow,
  useCostCenterData,
} from '../useCostCenterData'
import { cockpitOpsAccountsToRequestCounts } from '../cockpitAdapter'
import { actualUserCost, standardReferenceCost, UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'

describe('cost center live ranges', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defaults the live observation window to one hour', () => {
    expect(DEFAULT_COST_CENTER_RANGE).toBe('1h')
  })

  it('requests the current local calendar day with exact bounds', () => {
    const now = new Date(2026, 7, 6, 13, 45, 30)
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)

    expect(buildCostCenterSnapshotQuery('today')).toEqual({
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      granularity: 'hour',
    })
  })

  it('uses minute buckets for the one minute window', () => {
    expect(buildCostCenterSnapshotQuery('1m')).toEqual({
      time_range: '1m',
      granularity: 'minute',
    })
  })

  it('uses minute buckets for the default one hour chart', () => {
    expect(buildCostCenterSnapshotQuery('1h')).toEqual({
      time_range: '1h',
      granularity: 'minute',
    })
  })

  it('builds model economics queries from the same window as the observation (2026-09-05 window wiring fix)', () => {
    const queries = buildCostCenterDataQueries('today')
    expect(queries.observation).toEqual(queries.model)
    expect(queries.model).toEqual({
      start_time: queries.model.start_time,
      end_time: queries.model.end_time,
      granularity: 'hour',
    })

    const rolling = buildCostCenterDataQueries('7d')
    expect(rolling.model).toMatchObject({ time_range: '7d', granularity: 'day' })
    expect(rolling.observation).toEqual(rolling.model)
  })

  it('requests an exact 30 minute snapshot with minute buckets', () => {
    expect(buildCostCenterSnapshotQuery('30m')).toEqual({
      time_range: '30m',
      granularity: 'minute',
    })
  })

  it('uses day buckets for the seven day window', () => {
    expect(buildCostCenterSnapshotQuery('7d')).toEqual({
      time_range: '7d',
      granularity: 'day',
    })
  })

  it('uses day buckets for the one month window', () => {
    expect(buildCostCenterSnapshotQuery('30d')).toEqual({
      time_range: '30d',
      granularity: 'day',
    })
  })

  it('passes the selected observation window to persistent economics sampling', () => {
    expect(economicsWindowHours('1m')).toBeCloseTo(1 / 60)
    expect(economicsWindowHours('1h')).toBe(1)
    expect(economicsWindowHours('7d')).toBe(168)
    expect(economicsWindowHours('30d')).toBe(720)
  })

  it('uses passive quota snapshots only for Anthropic OAuth-style accounts', () => {
    expect(accountUsageSource({ platform: 'anthropic', type: 'oauth' } as any)).toBe('passive')
    expect(accountUsageSource({ platform: 'anthropic', type: 'setup-token' } as any)).toBe('passive')
    expect(accountUsageSource({ platform: 'openai', type: 'oauth' } as any)).toBe('active')
    expect(accountUsageSource({ platform: 'gemini', type: 'oauth' } as any)).toBe('active')
  })

  it('rejects a legacy snapshot that omitted the requested exact time boundary', () => {
    const start = new Date('2026-08-07T07:00:00.000Z')
    const end = new Date('2026-08-07T08:00:00.000Z')
    expect(snapshotMatchesRequestedWindow({ start_date: '2026-08-07', end_date: '2026-08-07' }, start, end)).toBe(false)
    expect(snapshotMatchesRequestedWindow({
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    }, start, end)).toBe(true)
  })

  it('rejects disjoint minute windows and mismatched fractional endpoints instead of applying a minute tolerance', () => {
    const start = new Date('2026-10-25T12:00:00.125Z'), end = new Date('2026-10-25T12:01:00.125Z')
    expect(snapshotMatchesRequestedWindow({ start_time: '2026-10-25T11:59:00Z', end_time: '2026-10-25T12:00:00Z' }, start, end)).toBe(false)
    expect(snapshotMatchesRequestedWindow({ start_time: '2026-10-25T12:00:00.124Z', end_time: end.toISOString() }, start, end)).toBe(false)
    expect(snapshotMatchesRequestedWindow({ start_time: '2026-10-25T12:00:00Z', end_time: '2026-10-25T12:01:00Z' }, start, end)).toBe(true)
    expect(snapshotMatchesRequestedWindow({ start_time: '2026-10-25T12:00:01Z', end_time: '2026-10-25T12:01:01Z' }, start, end)).toBe(false)
    expect(snapshotMatchesRequestedWindow({ start_time: end.toISOString(), end_time: start.toISOString() }, start, end)).toBe(false)
  })

  it('aggregates a truncated compatibility sample but flags it as partial instead of dropping it (2026-09-05 data-vanishing fix)', () => {
    const start = new Date('2026-08-07T07:00:00.000Z')
    const end = new Date('2026-08-07T08:00:00.000Z')
    const result = selectExactWindowModelStats(
      null,
      { logs: [{ model: 'deepseek-v4-flash', created_at: '2026-08-07T07:30:00.000Z' }] as any, truncated: true },
      start,
      end,
      'upstream',
    )

    expect(result.usedCompatibilityAggregation).toBe(true)
    expect(result.compatibilityTruncated).toBe(true)
    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({ model: 'deepseek-v4-flash', requests: 1 })
  })

  it('prefers the exact-window snapshot over compatibility aggregation when boundaries match', () => {
    const start = new Date('2026-08-07T07:00:00.000Z')
    const end = new Date('2026-08-07T08:00:00.000Z')
    const result = selectExactWindowModelStats(
      { start_time: start.toISOString(), end_time: end.toISOString(), models: [{ model: 'gpt-old', requests: 269 }] as any },
      { logs: [{ model: 'deepseek-v4-flash', created_at: '2026-08-07T07:30:00.000Z' }] as any, truncated: false },
      start,
      end,
      'upstream',
    )

    expect(result.usedCompatibilityAggregation).toBe(false)
    expect(result.compatibilityTruncated).toBe(false)
    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({ model: 'gpt-old', requests: 269 })
  })

  it('keeps only confirmed upstream model mismatches when the audit filter is enabled', () => {
    const logs = [
      { id: 1, upstream_model_mismatch: true },
      { id: 2, upstream_model_mismatch: false },
      { id: 3, upstream_model_mismatch: null },
    ] as any

    expect(filterModelAuditLogs(logs, true).map((log) => log.id)).toEqual([1])
    expect(filterModelAuditLogs(logs, false)).toBe(logs)
  })
})

describe('cost center account probe feedback', () => {
  it('publishes visible progress before the upstream request completes', async () => {
    let resolveProbe!: (value: { success: boolean; message: string; latency_ms: number }) => void
    testAccount.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve }))
    const data = useCostCenterData()
    const account = { id: 9, name: 'probe@example.com' } as any

    const pending = data.probeAccount(account)

    expect(data.probes.value['9']).toMatchObject({
      loading: true,
      message: '正在请求真实上游…',
    })

    resolveProbe({ success: true, message: '连接成功', latency_ms: 86 })
    await pending
    expect(data.probes.value['9']).toMatchObject({
      loading: false,
      success: true,
      latency_ms: 86,
    })
  })
})

/**
 * 2026-09-08 修复:单请求用量库给出的是**逐桶真实序列**,每个点的桶长就是桶本身。
 * 此前一律用"窗口累计跨度"(今日 ≈ 22h)去除 1 小时桶,图上每点被压扁 22 倍 → 曲线贴底。
 */
describe('cockpit 成本趋势桶长(cockpitTrendBucketHours)', () => {
  const stats = {
    since: Date.now() - 22 * 3_600_000,
    updatedAt: Date.now(),
    totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 },
    accounts: [],
    models: [],
    apiKeys: [],
    daily: {
      since: Date.now() - 22 * 3_600_000,
      accounts: [],
      models: [],
      apiKeys: [],
      totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 },
    },
    weekly: null,
    monthly: null,
  } as any

  function cell(startMs: number, stdNormalInput: number): any {
    return {
      startMs,
      model: 'gpt-6-astra',
      requests: 1,
      success: 1,
      error: 0,
      stdNormalInput,
      stdCached: 0,
      stdOutput: 0,
      longNormalInput: 0,
      longCached: 0,
      longOutput: 0,
      estimatedCostUsd: 0,
    }
  }

  it('无单请求用量库时保持 null(视图回退窗口累计时长折算)', () => {
    const data = useCostCenterData()
    data.loadFromCockpit(stats, null, 'today')
    expect(data.cockpitTrendBucketHours.value).toBeNull()
  })

  it('逐桶趋势存在时桶长 = 库返回的 bucketHours,不是窗口已过时长', () => {
    const data = useCostCenterData()
    const requestLog = {
      available: true,
      reason: null,
      rowCount: 3,
      windowStartMs: 0,
      windowEndMs: 0,
      bucketHours: 1,
      cells: [cell(0, 1_000_000), cell(3_600_000, 2_000_000)],
      groups: [],
    } as any
    data.loadFromCockpit(stats, null, 'today', [], null, new Map(), undefined, [], null, null, null, requestLog, requestLog)
    expect(data.cockpitTrendBucketHours.value).toBe(1)
    // 趋势确实是逐桶序列(2 个点),不是窗口累计单点
    expect(data.trend.value.length).toBe(2)
    expect(data.cockpitWindowHours.value).toBeGreaterThan(20)
  })

  it('7d/30d 的天桶返回 24', () => {
    const data = useCostCenterData()
    const requestLog = {
      available: true,
      reason: null,
      rowCount: 1,
      windowStartMs: 0,
      windowEndMs: 0,
      bucketHours: 24,
      cells: [cell(0, 1_000_000)],
      groups: [],
    } as any
    data.loadFromCockpit(stats, null, '7d', [], null, new Map(), undefined, [], null, null, null, requestLog, requestLog)
    expect(data.cockpitTrendBucketHours.value).toBe(24)
  })

  it('keeps the actual minute query bounds instead of treating sparse request timestamps as collection coverage', () => {
    const data = useCostCenterData()
    const end = new Date(), start = new Date(end.getTime() - 60000)
    const requestLog = { available: true, rowCount: 0, windowStartMs: null, windowEndMs: null, bucketHours: 1, cells: [], groups: [] } as any
    data.loadFromCockpit(stats, null, '1m', [], null, new Map(), undefined, [], null, null, null, requestLog, requestLog, null, null, { start, end })
    expect(data.trendQueryWindow.value).toEqual({ start, end })
    expect(data.sourceStates.value.dashboard.status).toBe('empty')
    data.clearCockpitSourceData('source unavailable')
    expect(data.trendQueryWindow.value).toBeNull()
  })
})

/**
 * 2026-09-16:cockpit + 单请求用量库不可用 + 多天窗口的快照回退路径,
 * 此前对**不在快照里**的账号显式写入 `{ tokens: 0, cost: 0, standard_cost: 0, user_cost: 0 }`,
 * 于是「{窗口}自算成本」列渲染出绿色 `$0.0000`,note 却写"{窗口}自算成本" ——
 * 把"该账号此窗口成本不可测"显示成"确定是 0"。
 *
 * 日志只给出真实请求数,成本/Token 确实不可测 ⇒ 必须能表达"无数据"(null),
 * 且 `actualUserCost` 对"两个成本字段都不可用"要返回 null(而不是 0)。
 */
describe('cockpit 多天窗口快照回退:缺失账号的成本必须是 null,不是 0', () => {
  const dailyTotals = { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 }

  const IN_SNAPSHOT_ID = 'codex_aaaa1111bbbb2222'
  /** 只在多天日志里出现、快照里没有的账号。 */
  const ONLY_IN_LOGS_ID = 'codex_eeee5555ffff6666'

  /**
   * 复用适配层的来源限定 ID，不能把不透明字符串转成 Number 后合并成 NaN。
   */
  function accountNumberId(accountId: string): string {
    const counts = cockpitOpsAccountsToRequestCounts([
      { account_id: accountId, requests: 1, success_count: 1, error_count: 0 },
    ])
    return Object.keys(counts)[0]!
  }

  function usageFixture(requestCount: number) {
    return {
      requestCount,
      successCount: requestCount,
      failureCount: 0,
      clientCanceledCount: 0,
      totalLatencyMs: 100,
      inputTokens: 600,
      outputTokens: 300,
      totalTokens: 900,
      cachedTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0.05,
    }
  }

  function makeStats(weeklyAccounts: unknown[]) {
    return {
      since: Date.now() - 8 * 24 * 3_600_000,
      updatedAt: Date.now(),
      totals: dailyTotals,
      accounts: [],
      models: [],
      apiKeys: [],
      daily: { since: Date.now() - 22 * 3_600_000, accounts: [], models: [], apiKeys: [], totals: dailyTotals },
      weekly: { since: Date.now() - 8 * 24 * 3_600_000, accounts: weeklyAccounts, models: [], apiKeys: [], totals: dailyTotals },
      monthly: null,
    } as any
  }

  function loadWithMultiDayLogs() {
    const data = useCostCenterData()
    const stats = makeStats([{ accountId: IN_SNAPSHOT_ID, email: 'in-snapshot@example.com', usage: usageFixture(3) }])
    // 第 10 个参数 = multiDayAccountRequests(多天日志聚合的 per-account 请求数,key 与 store 同口径);
    // requestLog 传 null ⇒ rlAvailable === false,走快照回退分支。
    data.loadFromCockpit(stats, null, '7d', [], null, new Map(), undefined, [], null, {
      [String(accountNumberId(IN_SNAPSHOT_ID))]: 3,
      [String(accountNumberId(ONLY_IN_LOGS_ID))]: 7,
    }, null, null, null)
    return data
  }

  it('marks missing-account request-log groups partial while retaining their complete numeric facts', () => {
    const data = useCostCenterData()
    const requestLog = { available: true, rowCount: 263, bucketHours: 1, windowStartMs: Date.now() - 3600000, windowEndMs: Date.now(), cells: [], bucketLatencies: [], groups: [{ model: 'gpt-6-astra', accountId: null, requests: 263, success: 263, error: 0, stdNormalInput: 1_000_000, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0, rateLimited: 0, upstreamError: 0, clientCanceled: 0, firstMs: Date.now() - 1000, lastMs: Date.now() }] }
    data.loadFromCockpit(makeStats([]), null, '1h', [], null, new Map(), undefined, [], null, null, null, requestLog)
    expect(data.rangeAccountStats.value[UNATTRIBUTED_USAGE_ACCOUNT_ID]).toMatchObject({ requests: 263, tokens: 1_000_000, cost: 2, standard_cost: 10, user_cost: null })
    expect(data.accounts.value).toEqual([])
    expect(data.sourceStates.value.rangeStats.status).toBe('partial')
    expect(data.sourceStates.value.rangeStats.reason).toContain('263 条请求未归属账号')
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'cockpit', instanceId: 'local' })
  })

  it('账号只在多天日志里(不在快照里)→ 成本/Token 是 null,不是 0', () => {
    const data = loadWithMultiDayLogs()
    const usage = data.rangeStats.value({ id: accountNumberId(ONLY_IN_LOGS_ID) } as any)

    expect(usage).not.toBeNull()
    // 请求数是日志聚合出来的真实值,保留
    expect(usage!.requests).toBe(7)
    // 成本与 Token 不可测 —— 不得写成 0
    expect(usage!.cost).toBeNull()
    expect(usage!.tokens).toBeNull()
    expect(usage!.standard_cost).toBeNull()
    expect(usage!.user_cost).toBeNull()
    expect(usage!.cost).not.toBe(0)
    expect(usage!.user_cost).not.toBe(0)
  })

  it('视图取值口径(actualUserCost)对缺失账号返回 null ⇒ 渲染"无数据"而不是绿色 $0.0000', () => {
    const data = loadWithMultiDayLogs()
    const usage = data.rangeStats.value({ id: accountNumberId(ONLY_IN_LOGS_ID) } as any)!

    // CostCenterView.rowUserCost 就是 `actualUserCost(stats)` + 有限性守卫;
    // 返回 null 时模板走 '无数据' 分支,不会出现 formatUsd(0) 的绿色 $0.0000。
    expect(actualUserCost(usage)).toBeNull()
  })

  it('在快照里的账号行为不变:请求数被日志聚合覆盖,成本仍是真实快照值', () => {
    const data = loadWithMultiDayLogs()
    const usage = data.rangeStats.value({ id: accountNumberId(IN_SNAPSHOT_ID) } as any)

    expect(usage).not.toBeNull()
    expect(usage!.requests).toBe(3)
    expect(typeof usage!.cost).toBe('number')
    expect(usage!.user_cost).toBeNull()
    expect(actualUserCost(usage!)).toBeNull()
    expect(standardReferenceCost(usage!)).toBe(usage!.standard_cost)
    expect(usage!.standard_cost).toBeCloseTo(usage!.cost! / 0.2)
  })
})

/**
 * 2026-09-09 修复:运维总览 KPI(qps / tps / token)此前用 stats.totals(**全量累计**)
 * 除以窗口小时 → 切到 1h 窗口会显示 50 qps。必须按日志/单请求库的窗口真值重算。
 */
describe('cockpit 运维总览 KPI 跟随观察窗口', () => {
  const stats = {
    since: Date.now() - 400 * 24 * 3_600_000,
    updatedAt: Date.now(),
    // 全量累计:一年多的量
    totals: { requestCount: 181_279, successCount: 153_626, failureCount: 27_653, clientCanceledCount: 0, totalLatencyMs: 2_469_567_463, inputTokens: 23_133_302_601, outputTokens: 59_123_218, totalTokens: 23_192_425_819, cachedTokens: 21_264_180_403, reasoningTokens: 0, estimatedCostUsd: 25_460 },
    accounts: [],
    models: [],
    apiKeys: [],
    daily: { since: Date.now() - 20 * 3_600_000, accounts: [], models: [], apiKeys: [], totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 } },
    weekly: null,
    monthly: null,
  } as any

  function opsPoint(startMs: number, requests: number): any {
    return {
      bucket_start: new Date(startMs).toISOString(),
      request_count: requests,
      success_count: requests,
      error_count: 0,
      token_consumed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      switch_count: 0,
      user_billed_usd: 0,
      account_cost_usd: 0,
      contribution_usd: 0,
      duration_p95_ms: null,
      ttft_p50_ms: null,
      ttft_p95_ms: null,
      qps: requests / 3600,
      tps: 0,
    }
  }

  it('请求数 / qps / tps / token 全部按窗口真值,不吃全量累计', () => {
    const data = useCostCenterData()
    const now = Date.now()
    const multiDayOps = [opsPoint(now - 3_600_000, 12), opsPoint(now, 8)]
    const requestLog = {
      available: true,
      reason: null,
      rowCount: 20,
      windowStartMs: 0,
      windowEndMs: 0,
      bucketHours: 1,
      cells: [],
      groups: [{
        model: 'gpt-6-astra',
        accountId: 'codex_abc',
        apiKeyId: 'key_1',
        firstMs: null,
        lastMs: null,
        requests: 20,
        success: 20,
        error: 0,
        stdNormalInput: 1_000_000,
        stdCached: 4_000_000,
        stdOutput: 20_000,
        longNormalInput: 0,
        longCached: 0,
        longOutput: 0,
        estimatedCostUsd: 0,
      }],
    } as any
    data.loadFromCockpit(stats, null, '1h', [], null, new Map(), undefined, [], multiDayOps, null, null, requestLog, requestLog)
    const ops = data.opsOverview.value!
    // 窗口内真实 20 个请求,不是全量累计的 181,279
    expect(ops.request_count_total).toBe(20)
    expect(ops.success_count).toBe(20)
    // qps = 20 请求 / 1 小时窗口(不是 181279/3600 ≈ 50)
    expect(ops.qps.avg).toBeCloseTo(20 / 3600, 9)
    // token 取单请求用量库窗口合计(1M + 4M + 20K),不是 231 亿
    expect(ops.token_consumed).toBe(5_020_000)
    expect(ops.tps.avg).toBeCloseTo(5_020_000 / 3600, 6)
  })

  // ★★ 2026-09-25:短窗口必须吃**窗口真值**,不得退回快照累计。
  //   血案(实测):源活着 / 库里 186,353 行 / 只是最近 1 分钟真的没请求 ⇒
  //   面板 `opsOverview.request_count_total` 显示 `stats.daily` 的 **73**,标着「最近 1 分钟」,
  //   而真实值是 **0**。且 1m / 1h / 24h **三档都是同一个 73**,切换窗口形同无效。
  //   根因:`rlAvailable` 曾叠了 `rowCount > 0`、`rlWindowTotals` 曾叠了 `rlCountFrom.length`,
  //   两者都把「这个窗口内 0 行」误判成「这条链路不可用」⇒ 整屏退回快照。
  describe('短窗口不得退回快照累计', () => {
    const SNAPSHOT_DAILY = 73 // daily 快照的一天累计 —— 绝不能出现在 1m/1h 窗口里
    const SNAPSHOT_TOTALS = 186351 // 生命周期累计

    function mkStats(): any {
      const mk = (n: number) => ({
        since: Date.now() - 86_400_000,
        accounts: [], models: [], apiKeys: [],
        totals: {
          requestCount: n, successCount: n, failureCount: 0, clientCanceledCount: 0,
          totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
          cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0,
        },
      })
      return {
        since: Date.now() - 30 * 86_400_000,
        updatedAt: Date.now(),
        totals: mk(SNAPSHOT_TOTALS).totals,
        accounts: [], models: [], apiKeys: [],
        daily: mk(SNAPSHOT_DAILY), weekly: mk(1769), monthly: mk(27102),
      }
    }

    function mkLog(rowCount: number, groups: any[], cells: any[] = []): any {
      return {
        available: true, reason: null, rowCount,
        windowStartMs: null, windowEndMs: null, bucketHours: 1, cells, groups,
      }
    }

    const emptyLog = (rowCount: number) => mkLog(rowCount, [])
    // 带桶序列(成本趋势按 cells 分桶),供"有数据的窗口必须有真趋势点"用
    const trendLog = mkLog(20, [], [{
      startMs: Math.floor(Date.now() / 3_600_000) * 3_600_000,
      model: 'gpt-6-astra', requests: 20, success: 20, error: 0,
      stdNormalInput: 1_000_000, stdCached: 4_000_000, stdOutput: 20_000,
      longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    }])
    const rowLog = mkLog(20, [{
      model: 'gpt-6-astra', accountId: 'codex_abc', apiKeyId: 'key_1',
      firstMs: null, lastMs: null, requests: 20, success: 20, error: 0,
      stdNormalInput: 1_000_000, stdCached: 4_000_000, stdOutput: 20_000,
      longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    }])

    function loadData(range: any, log: any) {
      const data = useCostCenterData()
      data.loadFromCockpit(mkStats(), null, range, [], null, new Map(), undefined, [],
        null, null, null, log, log)
      return data
    }

    function load(range: any, log: any): any {
      return loadData(range, log).opsOverview.value
    }

    it('窗口内 0 行 ⇒ 真值 0,不是 daily 快照的一天累计', () => {
      for (const range of ['1m', '5m', '30m', '1h', '6h', '24h'] as const) {
        // 情形 A:源停写 ⇒ 窗口内 0 行(rowCount = 0)
        expect(load(range, emptyLog(0)).request_count_total, `${range} / 源停写`).toBe(0)
        // 情形 B:源活着(库里 18 万行),只是**这个窗口内**真的 0 次调用
        expect(load(range, emptyLog(186353)).request_count_total, `${range} / 源活着但窗口内 0 次`).toBe(0)
      }
      // 反向护栏:这两个数都不是窗口真值,谁的影子出现都说明退回了快照
      for (const range of ['1m', '1h'] as const) {
        const n = load(range, emptyLog(0)).request_count_total
        expect(n).not.toBe(SNAPSHOT_DAILY)
        expect(n).not.toBe(SNAPSHOT_TOTALS)
      }
    })

    it('窗口内 0 行 ⇒ 成本趋势为空,不得画出快照的日历累计点', () => {
      // 与 KPI 同一个病根:`trend.value = rlTrend.length ? rlTrend : 快照` 用
      // 「窗口内有没有行」决定回退 ⇒ 短窗口趋势图上画的是 daily 的累计点。
      for (const range of ['1m', '5m', '30m', '1h', '6h', '24h'] as const) {
        expect(loadData(range, emptyLog(0)).trend.value.length, `${range} / 源停写`).toBe(0)
        expect(loadData(range, emptyLog(186353)).trend.value.length, `${range} / 源活着但窗口 0 行`).toBe(0)
      }
      // 正例护栏:有桶序列时必须有真趋势点(不能因为改判据把正常窗口也清空)
      expect(loadData('30d', trendLog).trend.value.length).toBeGreaterThan(0)
    })

    it('窗口内有数据 ⇒ 真值,且切窗口数值必须随窗口时长变(不得三档同一个数)', () => {
      const r1m = load('1m', rowLog)
      const r1h = load('1h', rowLog)
      const r24h = load('24h', rowLog)
      expect(r1m.request_count_total).toBe(20)
      expect(r1h.request_count_total).toBe(20)
      expect(r24h.request_count_total).toBe(20)
      // ★ 同值双轨红线:qps 的分母是**窗口时长** ⇒ 三档必须严格递减。
      //   退回快照时三档会同为 73/86400,这条能直接钉住。
      expect(r1m.qps.avg).toBeGreaterThan(r1h.qps.avg)
      expect(r1h.qps.avg).toBeGreaterThan(r24h.qps.avg)
    })
  })
})

/**
 * 2026-09-09 修复:7 天"真实请求量趋势"此前只能用 codex-api.log 聚合,
 * cockpit 只保留 ~4 天日志 → 9/3~9/5 的 10,216 个请求从图上消失(用户实测确认)。
 * 现在单请求用量库 cells(全保留期)优先,日志聚合只作回退。
 */
describe('cockpit Ops 运行趋势来源(单请求库优先)', () => {
  const baseStats = {
    since: Date.now() - 400 * 24 * 3_600_000,
    updatedAt: Date.now(),
    totals: { requestCount: 181_279, successCount: 153_626, failureCount: 27_653, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 },
    accounts: [],
    models: [],
    apiKeys: [],
    daily: { since: Date.now() - 20 * 3_600_000, accounts: [], models: [], apiKeys: [], totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 } },
    weekly: null,
    monthly: null,
  } as any

  function rlCell(startMs: number, requests: number): any {
    return {
      startMs, model: 'gpt-6-astra', requests, success: requests - 1, error: 1,
      stdNormalInput: 1_000 * requests, stdCached: 0, stdOutput: 100 * requests,
      longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    }
  }

  it('单请求库可用时:opsTrend 覆盖全窗口桶,标记 opsTrendFromRequestLog', () => {
    const data = useCostCenterData()
    // 3 个天桶(模拟 7 天窗口里 3 天有量)vs 日志聚合只有 1 桶(保留期缺失)
    const requestLog = {
      available: true, reason: null, rowCount: 30, windowStartMs: 0, windowEndMs: 0, bucketHours: 24,
      cells: [rlCell(0, 889), rlCell(86_400_000, 2_938), rlCell(172_800_000, 6_389)],
      groups: [],
    } as any
    const logBacked = [{
      bucket_start: new Date(86_400_000).toISOString(), request_count: 999, success_count: 999, error_count: 0,
      token_consumed: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      switch_count: 0, user_billed_usd: 0, account_cost_usd: 0, contribution_usd: 0,
      duration_p95_ms: null, ttft_p50_ms: null, ttft_p95_ms: null, qps: 0, tps: 0,
    }]
    data.loadFromCockpit(baseStats, null, '7d', [], null, new Map(), undefined, [], logBacked as any, null, null, requestLog, requestLog)
    expect(data.opsTrendFromRequestLog.value).toBe(true)
    expect(data.opsTrend.value.length).toBe(3)
    expect(data.opsTrend.value.map((p) => p.request_count)).toEqual([889, 2_938, 6_389])
    // token 列由单请求库补齐(日志无 token 字段,此前恒 0)
    expect(data.opsTrend.value[0]!.input_tokens).toBe(889_000)
    // 运维总览 KPI 同步吃窗口真值
    expect(data.opsOverview.value!.request_count_total).toBe(889 + 2_938 + 6_389)
  })
})

  it('短窗口(桶比窗口粗)不使用单请求库趋势,回退日志分钟桶', () => {
    const data = useCostCenterData()
    const cell = (startMs: number, requests: number): any => ({
      startMs, model: 'gpt-6-astra', requests, success: requests, error: 0,
      stdNormalInput: 1_000 * requests, stdCached: 0, stdOutput: 100 * requests,
      longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    })
    const requestLog = {
      available: true, reason: null, rowCount: 30, windowStartMs: 0, windowEndMs: 0,
      bucketHours: 1, // 单请求库最小桶 1h,而窗口只有 1 分钟
      cells: [cell(0, 889), cell(3_600_000, 2_938)],
      groups: [],
    } as any
    const stats = {
      since: Date.now() - 400 * 24 * 3_600_000, updatedAt: Date.now(),
      totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 },
      accounts: [], models: [], apiKeys: [],
      daily: { since: Date.now() - 3_600_000, accounts: [], models: [], apiKeys: [], totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 } },
      weekly: null, monthly: null,
    } as any
    data.loadFromCockpit(stats, null, '1m', [], null, new Map(), undefined, [], null, null, null, requestLog, requestLog)
    expect(data.opsTrendFromRequestLog.value).toBe(false)
  })

/**
 * 2026-09-10 恢复双轨:模型成本区保留独立统计窗口(用户明确要求"原来本身就是双轨")。
 * buildCostCenterDataQueries 必须能给模型查询传**不同**于观察窗口的 range;
 * 不传第二参时等价于单窗口行为(向后兼容)。
 */
describe('模型统计独立窗口(双轨)', () => {
  it('可给模型查询传独立窗口', () => {
    const q = buildCostCenterDataQueries('1h', '7d')
    expect(q.observation).toEqual(buildCostCenterSnapshotQuery('1h'))
    expect(q.model).toEqual(buildCostCenterSnapshotQuery('7d'))
  })

  it('省略第二参时模型窗口 = 观察窗口(向后兼容)', () => {
    const q = buildCostCenterDataQueries('7d')
    expect(q.model).toEqual(buildCostCenterSnapshotQuery('7d'))
    expect(q.observation).toEqual(q.model)
  })
})

/**
 * 2026-09-10 逐窗口复核发现的两个缺陷:
 * ① 1m/5m/30m 短窗口:桶序列被粒度护栏挡下、日志桶又被窗口裁掉 → KPI 退回
 *    stats.totals 全量累计(181,279),除以 1 分钟窗口 = ~3,021 qps。
 *    修复:KPI 直接吃单请求库**按精确 ms 窗口过滤**的合计(与桶粒度无关)。
 * ② 换成单请求库趋势后延迟/TTFT 图整片变空(回归)——日志桶的延迟要按桶回填。
 */
describe('cockpit 逐窗口 KPI 与延迟回填', () => {
  const stats = {
    since: Date.now() - 400 * 24 * 3_600_000,
    updatedAt: Date.now(),
    totals: { requestCount: 181_279, successCount: 153_626, failureCount: 27_653, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 23_192_425_819, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 },
    accounts: [], models: [], apiKeys: [],
    daily: { since: Date.now() - 20 * 3_600_000, accounts: [], models: [], apiKeys: [], totals: { requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 } },
    weekly: null, monthly: null,
  } as any

  function cell(startMs: number, requests: number): any {
    return {
      startMs, model: 'gpt-6-astra', requests, success: requests, error: 0,
      stdNormalInput: 1_000 * requests, stdCached: 0, stdOutput: 100 * requests,
      longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    }
  }

  it('1 分钟窗口:请求数/qps 取单请求库窗口真值,不吃全量累计', () => {
    const data = useCostCenterData()
    const now = Date.now()
    const requestLog = {
      available: true, reason: null, rowCount: 7, windowStartMs: now - 60_000, windowEndMs: now,
      bucketHours: 1, // 桶比窗口粗 → 桶序列不用于画图
      cells: [cell(now - 3_600_000, 7)],
      groups: [],
    } as any
    data.loadFromCockpit(stats, null, '1m', [], null, new Map(), undefined, [], [], null, null, requestLog, requestLog)
    const ops = data.opsOverview.value!
    expect(ops.request_count_total).toBe(7) // 不是 181,279
    expect(ops.qps.avg).toBeCloseTo(7 / 60, 6) // 7 请求 / 60 秒
    // 桶序列仍不使用(粒度护栏),趋势图不被"1 小时量冒充 1 分钟"
    expect(data.opsTrendFromRequestLog.value).toBe(false)
  })

  it('延迟/TTFT 从日志桶回填到单请求库趋势点', () => {
    const data = useCostCenterData()
    const now = Date.now()
    const bucketMs = Math.floor(now / 3_600_000) * 3_600_000
    const requestLog = {
      available: true, reason: null, rowCount: 20, windowStartMs: 0, windowEndMs: 0, bucketHours: 1,
      cells: [cell(bucketMs, 20)],
      groups: [],
    } as any
    const logBucket = {
      bucket_start: new Date(bucketMs).toISOString(), request_count: 20, success_count: 20, error_count: 0,
      token_consumed: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      switch_count: 2, user_billed_usd: 0, account_cost_usd: 0, contribution_usd: 0,
      duration_p95_ms: 1234, ttft_p50_ms: 210, ttft_p95_ms: 480, qps: 0, tps: 0,
    }
    data.loadFromCockpit(stats, null, '1h', [], null, new Map(), undefined, [], [logBucket] as any, null, null, requestLog, requestLog)
    expect(data.opsTrendFromRequestLog.value).toBe(true)
    const point = data.opsTrend.value[0]!
    expect(point.request_count).toBe(20)
    expect(point.duration_p95_ms).toBe(1234)
    expect(point.ttft_p50_ms).toBe(210)
    expect(point.ttft_p95_ms).toBe(480)
    expect(point.switch_count).toBe(2)
  })

  /**
   * ★ 2026-09-27(Bug A 接线守卫):30d 下 codex-api.log 不存在,
   *   `summarize_cockpit_api_logs` 返回 `routes=[]` ⇒ `multiDayRoutes` 为空;
   *   回退的 `apiLog` 也为空(9 月份没有 `codex-api.log.YYYY-MM-DD` 文件)
   *   ⇒ **路由明细表整张空白**,用户反馈"月数据很多没有"。
   *
   *   修法:新增第三分支,当 `rlAvailable && requestLog.groups.length` 时
   *   从 SQLite 单请求库 groups 派生路由行。
   *
   *   本用例走**真实接线**(loadFromCockpit),而不是只测纯函数 ——
   *   纯函数测试在分支被删掉后依然全绿,钉不住"接线断了"。
   */
  it('★ 30d:codex-api.log 与多天聚合都缺失时,路由明细从单请求库 groups 派生(不整表空白)', () => {
    const data = useCostCenterData()
    const now = Date.now()
    const requestLog = {
      available: true, reason: null, rowCount: 20,
      windowStartMs: now - 30 * 24 * 3_600_000, windowEndMs: now,
      bucketHours: 24,
      cells: [cell(now - 24 * 3_600_000, 20)],
      groups: [
        { model: 'gpt-6-astra', accountId: 'codex_abc', apiKeyId: 'k1', requests: 12, success: 12, error: 0, firstMs: now - 3_600_000, lastMs: now, stdNormalInput: 12_000, stdCached: 0, stdOutput: 1_200, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0, rateLimited: 0, upstreamError: 0, clientCanceled: 0 },
        { model: 'gpt-5.6-sol', accountId: 'codex_xyz', apiKeyId: 'k2', requests: 8, success: 8, error: 0, firstMs: now - 2 * 3_600_000, lastMs: now, stdNormalInput: 8_000, stdCached: 0, stdOutput: 800, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0, rateLimited: 0, upstreamError: 0, clientCanceled: 0 },
      ],
    } as any
    // 参数位序:..., multiDayOps=[], multiDayAccountRequests=null, multiDayRoutes=null, requestLog, todayRequestLog
    // multiDayRoutes=null 模拟 Rust 空 routes;apiLog=null 模拟无 codex-api.log 文件。
    data.loadFromCockpit(stats, null, '30d', [], null, new Map(), undefined, [], [], null, null, requestLog, requestLog)
    // 修复前:两个源都空 ⇒ modelRoutes=[] ⇒ 视图渲染"最近 1 个月没有真实路由记录"。
    expect(data.modelRoutes.value.length, '路由明细行为空 —— 第三分支未生效').toBeGreaterThan(0)
    // requests 不丢不重(12 + 8)
    expect(data.modelRoutes.value.reduce((s, r) => s + r.requests, 0)).toBe(20)
    // 来源状态必须如实标注为"单请求用量库",不得冒充 codex-api.log 口径
    expect(data.sourceStates.value.modelRoutes.status).toBe('measured')
    expect(data.sourceStates.value.modelRoutes.reason).toContain('单请求用量库')
  })
})
