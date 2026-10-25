import './costDataI18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyCockpitUsageLedger,
  clipOpsBucketsToWindow,
  cockpitLogToModelRoutes,
  cockpitModelsToImpliedPricing,
  cockpitOpsAccountsToRequestCounts,
  cockpitOpsRoutesToModelRoutes,
  cockpitRoutesAuditSummary,
  cockpitUsageCostUsd,
  cockpitEffectiveModelPricing,
  cockpitBlendedTokenPrice,
  cockpitAggregateCostUsd,
  cockpitModelsToModelStats,
  cockpitWindowToAccountStats,
  COCKPIT_COST_BASIS_LOCAL,
  COCKPIT_COST_BASIS_BOOK,
  COCKPIT_COST_BASIS_ESTIMATE,
  cockpitPlatformAccountsToAccounts,
  cockpitUsageGranularityOf,
  cockpitStatsToAccounts,
  accountIdToCostId,
  cockpitWindowsToCostTrend,
  snapshotCockpitLedger,
  cockpitSplitCostUsd,
  cockpitSplitTokens,
  cockpitRequestLogToModelStats,
  cockpitRequestLogToAccountStats,
  cockpitRequestLogToCostTrend,
  cockpitRequestLogToOpsTrend,
  cockpitRequestLogToHealthSeries,
  cockpitRequestLogToErrorTrend,
  cockpitRequestLogGroupCost,
  cockpitRequestLogGroupsToOpsRoutes,
  cockpitRequestLogToModelRoutes,
  applyCockpitRequestLogCost,
  cockpitGroupNameByAccountId,
} from '../cockpitAdapter'
import { cockpitEffectiveModelPricings, cockpitEffectivePriceSets } from '../cockpitPriceBook'
import { summarizeModelAudit } from '../modelCostAnalysis'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'
import { COCKPIT_LEDGER_CAP } from '../../../api/cockpit'
import type { CockpitAccountUsage, CockpitLedgerEntry, CockpitModelUsage, CockpitOpsAccountAgg, CockpitOpsRouteAgg, CockpitStats, CockpitStatsWindow } from '../../../api/cockpit'
import type { CockpitRequestLogCell, CockpitRequestLogGroup, CockpitRequestLogSummary } from '../../../api/cockpit'

/** 与真实 codex_local_access_stats.json 同形状的最小 usage 夹具。 */
function usage(overrides: Partial<CockpitAccountUsage> = {}): CockpitAccountUsage {
  return {
    requestCount: 10,
    successCount: 9,
    failureCount: 1,
    clientCanceledCount: 0,
    upstreamResponseFailedCount: 0,
    streamIncompleteCount: 0,
    totalLatencyMs: 10_000,
    textRequestCount: 10,
    imageRequestCount: 0,
    imageGenerationRequestCount: 0,
    imageEditRequestCount: 0,
    imageGenerationCapabilityFailureCount: 0,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1600,
    cachedTokens: 100,
    reasoningTokens: 0,
    estimatedCostUsd: 0.02,
    updatedAt: 1_756_800_000_000,
    ...overrides,
  }
}

const PLUS_ACCOUNT_ID = 'codex_aaaa1111bbbb2222'
const ORPHAN_ACCOUNT_ID = 'codex_dddd4444eeee5555'
const APIKEY_ACCOUNT_ID = 'codex_apikey_e64ce2726bafe1ef8b0af23e077fe3de'
const TEST_ACCOUNT_ID = 'model_provider_test_abc1234567890'

function makeStats(): CockpitStats {
  return {
    since: 1_756_100_000_000,
    updatedAt: 1_756_800_000_000,
    totals: usage({ requestCount: 40, successCount: 36, failureCount: 4 }),
    accounts: [
      { accountId: PLUS_ACCOUNT_ID, email: 'plus1@gmail.com', usage: usage() },
      { accountId: ORPHAN_ACCOUNT_ID, email: 'retired@gmail.com', usage: usage({ requestCount: 100, successCount: 95, failureCount: 5, estimatedCostUsd: 0.5 }) },
      { accountId: APIKEY_ACCOUNT_ID, email: 'api-key-e64ce272', usage: usage() },
      { accountId: TEST_ACCOUNT_ID, email: 'cmp_x@model-provider-test.local', usage: usage({ requestCount: 1, successCount: 1, failureCount: 0 }) },
    ],
  }
}

const apiKeyInfos = new Map([[APIKEY_ACCOUNT_ID, { name: 'My Relay', baseUrl: 'https://relay.example.com/v1' }]])
const accountMeta = new Map([[PLUS_ACCOUNT_ID, { id: PLUS_ACCOUNT_ID, email: 'plus1@gmail.com', plan_type: 'plus', created_at: 1_750_000_000 }]])

/** cockpit 日志真实行格式:`时间戳 INFO [CodexLocalAccess][sidecar] {json}`。 */
function logLine(payload: Record<string, unknown>): string {
  return `2026-08-26T08:00:04.400+08:00 INFO [CodexLocalAccess][sidecar] ${JSON.stringify(payload)}`
}

describe('cockpit adapter: scheduler score', () => {
  it('computes scores on the 0-4 weight-sum scale instead of clamping everything to 100', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    for (const account of accounts) {
      const score = Number(account.scheduler_score?.base_score)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(4)
      expect(account.extra).toMatchObject({ scheduler_score_source: 'derived', scheduler_score_basis: 'cockpit_usage_success_requests_latency_with_neutral_quota' })
    }
  })

  it('gives an idle account the neutral 2.0 base and distinguishes usage profiles', () => {
    const idle = cockpitStatsToAccounts({
      ...makeStats(),
      accounts: [{ accountId: 'codex_idle0000aaaa11', email: 'idle@gmail.com', usage: usage({ requestCount: 0, successCount: 0, failureCount: 0, totalLatencyMs: 0 }) }],
    })[0]
    expect(Number(idle.scheduler_score?.base_score)).toBe(2)

    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const plus = accounts.find((a) => a.name === 'plus1@gmail.com')!
    const orphan = accounts.find((a) => a.name === 'retired@gmail.com')!
    expect(Number(plus.scheduler_score?.base_score)).not.toEqual(Number(orphan.scheduler_score?.base_score))
  })

  it('retains real group names without inventing billing-group IDs', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta, undefined, undefined, new Map([[PLUS_ACCOUNT_ID, 'fixture pool']]))
    expect(accounts[0].extra?.cockpit_group_names).toEqual(['fixture pool'])
    expect(accounts[1].extra?.cockpit_group_names).toBeUndefined()
    expect(accounts[0].groups).toBeUndefined()
  })

  it('preserves full raw account IDs and never creates an identity for blank rows', () => {
    const stats = makeStats()
    stats.accounts = ['costarring', 'liquid', ' '].map(accountId => ({ accountId, usage: usage() }))
    expect(cockpitStatsToAccounts(stats).map(account => account.id)).toEqual(['cockpit:costarring', 'cockpit:liquid'])
    expect(accountIdToCostId('a:b/c')).toBe('cockpit:a%3Ab%2Fc')
  })
})

describe('cockpit adapter: two-layer account semantics', () => {
  it('keeps the current-pool account non-historical and preserves its plan_type and created_at', () => {
    const plus = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta).find((a) => a.name === 'plus1@gmail.com')!
    const extra = plus.extra as { cockpit_historical?: boolean; plan_type?: string } | undefined
    expect(extra?.cockpit_historical).toBeUndefined()
    expect(extra?.plan_type).toBe('plus')
    expect(plus.created_at).toBe(new Date(1_750_000_000_000).toISOString())
  })

  it('maps log-aggregated per-account requests onto account-row ids via the same FNV hash', () => {
    // 2026-09-05 修复"7d/30d 数据是错的":日志聚合的 accountId 与 stats accountId 同一标识体系,
    // 经 accountIdToNumber 映射后必须能对上 cockpitStatsToAccounts 生成的账号行 id。
    const statsAccounts = cockpitStatsToAccounts(makeStats())
    const logAgg: CockpitOpsAccountAgg[] = [
      { account_id: 'codex_d5aac74362a8128702eb1db82d7e84b8', requests: 10684, success_count: 10000, error_count: 684 },
      { account_id: 'codex_apikey_e64ce2726bafe1ef8b0af23e077fe3de', requests: 4313, success_count: 4000, error_count: 313 },
    ]
    const counts = cockpitOpsAccountsToRequestCounts(logAgg)
    // 每个日志 accountId 都能映射到一个 number id,key 形态与账号行查找一致
    for (const agg of logAgg) {
      const key = String(counts[Object.keys(counts).find((k) => counts[k] === agg.requests) ?? ''])
      expect(key).toBeTruthy()
    }
    // 同一 accountId 恒等映射(两次调用同 key,不漂移)
    const again = cockpitOpsAccountsToRequestCounts(logAgg)
    expect(again).toEqual(counts)
    // 值透传:requests 数不丢
    expect(Object.values(counts).sort((a, b) => b - a)).toEqual([10684, 4313])
    // 空输入安全
    expect(cockpitOpsAccountsToRequestCounts([])).toEqual({})
    void statsAccounts
  })

  it('flags meta-less stats orphans as historical (removed from the current pool)', () => {
    const orphan = cockpitStatsToAccounts(makeStats()).find((a) => a.name === 'retired@gmail.com')!
    expect((orphan.extra as { cockpit_historical?: boolean } | undefined)?.cockpit_historical).toBe(true)
  })

  it('classifies provider-test accounts as apikey noise that is also outside the current pool', () => {
    // 语义修正(2026-09-04 真实数据核对):provider 连通性测试账号同样不在 codex_accounts.json 当前池中
    // (stats 222 个里 215 个无 meta = 210 普通孤儿 + 5 个 provider 测试账号),
    // 因此它既是 provider_test(供 eventsToUsageLogs 渠道命名),也是 historical(不进当前池主视图)。
    const test = cockpitStatsToAccounts(makeStats()).find((a) => a.name.startsWith('提供商测试 · '))!
    expect(test.type).toBe('apikey')
    const extra = test.extra as { cockpit_provider_test?: boolean; cockpit_historical?: boolean } | undefined
    expect(extra?.cockpit_provider_test).toBe(true)
    expect(extra?.cockpit_historical).toBe(true)
  })

  it('names apikey accounts after their relay channel and carries the baseUrl upstream', () => {
    const relay = cockpitStatsToAccounts(makeStats(), apiKeyInfos).find((a) => a.name === 'My Relay')!
    expect(relay.type).toBe('apikey')
    expect((relay.credentials as { base_url?: string } | undefined)?.base_url).toBe('https://relay.example.com/v1')
  })
})

describe('cockpit adapter: quota window status', () => {
  it('marks a quota-exhausted account as rate-limited with the real reset time', () => {
    const futureReset = Date.now() + 60 * 60 * 1000
    const accounts = cockpitStatsToAccounts(makeStats(), new Map(), undefined, undefined, new Map([
      [ORPHAN_ACCOUNT_ID, { maxUtil: 97, resetAtMs: futureReset }],
    ]))
    const orphan = accounts.find((a) => a.name === 'retired@gmail.com')!
    expect(orphan.rate_limited_at).not.toBeNull()
    expect(new Date(orphan.rate_limit_reset_at ?? 0).getTime()).toBe(futureReset)
  })

  it('leaves accounts below the 95% utilization threshold unmarked', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), new Map(), undefined, undefined, new Map([
      [ORPHAN_ACCOUNT_ID, { maxUtil: 40, resetAtMs: Date.now() + 60 * 60 * 1000 }],
    ]))
    const orphan = accounts.find((a) => a.name === 'retired@gmail.com')!
    expect(orphan.rate_limited_at).toBeNull()
  })
})

describe('cockpit adapter: route rows from the codex-api log', () => {
  const log = [
    logLine({ type: 'request_started', requestId: 'req-1', model: 'gpt-5', requestKind: 'text', path: '/v1/responses', method: 'POST', transport: 'sse' }),
    logLine({ type: 'auth_result', requestId: 'req-1', accountId: PLUS_ACCOUNT_ID, accountEmail: 'plus1@gmail.com', success: true }),
    logLine({ type: 'request_completed', requestId: 'req-1', status: 200, latencyMs: 800, completedAtMs: 1_756_800_000_000 }),
    logLine({ type: 'request_started', requestId: 'req-2', model: 'gpt-5', requestKind: 'text', path: '/v1/responses', method: 'POST', transport: 'json' }),
    logLine({ type: 'auth_result', requestId: 'req-2', accountId: APIKEY_ACCOUNT_ID, success: true }),
    logLine({ type: 'request_completed', requestId: 'req-2', status: 200, latencyMs: 900, completedAtMs: 1_756_800_000_000 }),
  ].join('\n')

  const windowModels: CockpitModelUsage[] = [
    { modelId: 'gpt-5', usage: usage({ requestCount: 2, inputTokens: 1000, outputTokens: 500, totalTokens: 1600, cachedTokens: 100, estimatedCostUsd: 0.02 }) },
  ]

  it('separates the channel column (source) from the upstream column (target host)', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const { routes, truncated, logs } = cockpitLogToModelRoutes(log, accounts, windowModels, 1)
    expect(truncated).toBe(false)
    expect(logs).toHaveLength(2)
    expect(routes).toHaveLength(2)

    const oauthRow = routes.find((r) => r.accountName === 'plus1@gmail.com')!
    expect(oauthRow.channelName).toBe('OpenAI Codex 官方（OAuth 池）')
    expect(oauthRow.upstreamEndpoint).toBe('OpenAI Codex 官方上游')
    expect(oauthRow.inboundEndpoint).toBe('/v1/responses')
    expect(oauthRow.channelId).toBeLessThan(0)

    const relayRow = routes.find((r) => r.accountName === 'My Relay')!
    expect(relayRow.channelName).toBe('My Relay')
    expect(relayRow.upstreamEndpoint).toBe('relay.example.com')
  })

  it('backfills tokens and cost from the model-window aggregation instead of leaving zeros', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const { routes } = cockpitLogToModelRoutes(log, accounts, windowModels, 1)
    // 模型窗口 2 请求,每路由行 1 请求 → 各分摊 50%
    for (const row of routes) {
      expect(row.requests).toBe(1)
      expect(row.cacheReadTokens).toBe(50)
      expect(row.inputTokens).toBe(500)
      expect(row.standardCost).toBeCloseTo(0.01, 10)
      expect(row.accountCost).toBeCloseTo(0.01, 10)
      expect(row.costBasis).toBeTruthy()
    }
    // 两行合计 = 模型窗口总量(均摊守恒)
    expect(routes.reduce((sum, r) => sum + r.standardCost, 0)).toBeCloseTo(0.02, 10)
    expect(routes.reduce((sum, r) => sum + r.cacheReadTokens, 0)).toBe(100)
  })

  /**
   * 2026-09-16:cockpit 的 request_logs **没有**"上游响应声明模型 / 审计结论"字段。
   * 此前 eventsToUsageLogs 写死 `upstream_response_model: evt.model!` + `upstream_model_mismatch: false`,
   * 于是「响应声明 / 审计」列渲染出模型名 + is-matched「一致」徽标,
   * 而同屏 routeTableHint 写着"日志无逐请求 token 与上游响应模型,审计维度不可用" —— 自相矛盾。
   * 本条钉住:cockpit 源下**不得**产出任何 `upstream_model_mismatch === false`(或 true)的合成日志。
   */
  it('never fabricates an upstream response model or an audit conclusion', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const { routes, logs } = cockpitLogToModelRoutes(log, accounts, windowModels, 1)

    expect(logs.length).toBeGreaterThan(0)
    for (const entry of logs) {
      // 不是 false、不是 true —— 是"没观测过"
      expect(entry.upstream_model_mismatch).toBeNull()
      expect(entry.upstream_response_model).toBeNull()
    }
    // 反证:整列一旦出现 false,就等于断言"已比对且一致"
    expect(logs.some((entry) => entry.upstream_model_mismatch === false)).toBe(false)

    for (const row of routes) {
      expect(row.modelAuditStatus).toBe('unobserved')
      expect(row.upstreamModelMismatch).toBeNull()
      expect(row.upstreamResponseModel).toBe('')
    }

    // 与同屏提示条一致:全部未观测,不是"全部一致"
    const summary = summarizeModelAudit(logs)
    expect(summary.totalRequests).toBe(logs.length)
    expect(summary.unobservedRequests).toBe(logs.length)
    expect(summary.observedRequests).toBe(0)
    expect(summary.matchedRequests).toBe(0)
    expect(summary.mismatchRate).toBeNull()
  })

  /**
   * 2026-09-16:cockpit 的 request_logs **只有** `model_id`(客户端请求的模型),
   * 建表语句里没有任何"这个请求发往上游时用的是哪个模型"的列
   * (见 cockpit-tools-main/src-tauri/src/modules/codex_local_access_request_logs.rs)。
   * 此前 eventsToUsageLogs 填 `upstream_model: evt.model`,界面于是显示 `gpt-5 → gpt-5`,
   * 暗示"实测到上游也是 gpt-5" —— 而我们并没有这个观测。
   *
   * 注意 `codex_local_access.rs` 里的 `upstream_model` 属于 CodexLocalAccessProviderGateway
   * (网关供应商**配置**),不是逐请求日志字段,不能拿来充当逐请求实测值。
   *
   * 本条钉住:cockpit 源下不得产出 `upstream_model === 请求模型` 的合成日志。
   */
  it('never fabricates the upstream model from the requested model', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const { routes, logs } = cockpitLogToModelRoutes(log, accounts, windowModels, 1)

    expect(logs.length).toBeGreaterThan(0)
    for (const entry of logs) {
      expect(entry.upstream_model).toBeNull()
    }
    // 反证:整列一旦出现模型名,就等于断言"已观测到发往上游的模型"
    expect(logs.some((entry) => typeof entry.upstream_model === 'string')).toBe(false)

    for (const row of routes) {
      expect(row.upstreamModel).toBeNull()
      // 展示侧不得回退成请求模型(那会渲染成 `gpt-5 → gpt-5`)
      expect(row.mappingChain).not.toContain(row.requestedModel)
    }
  })
})

describe('cockpit adapter: route rows from the window log aggregation (multi-day)', () => {
  /** Rust summarize_cockpit_api_logs 返回的路由聚合(窗口内已按 模型×账号×入站接口 合并)。 */
  const routes: CockpitOpsRouteAgg[] = [
    {
      model: 'gpt-5',
      account_id: PLUS_ACCOUNT_ID,
      inbound_path: '/v1/responses',
      requests: 2,
      success_count: 2,
      error_count: 0,
      first_ms: 1_756_800_000_000,
      last_ms: 1_756_800_060_000,
    },
    {
      model: 'gpt-5',
      account_id: APIKEY_ACCOUNT_ID,
      inbound_path: '/v1/responses',
      requests: 1,
      success_count: 0,
      error_count: 1,
      first_ms: 1_756_800_030_000,
      last_ms: 1_756_800_030_000,
    },
  ]
  const windowModels: CockpitModelUsage[] = [
    { modelId: 'gpt-5', usage: usage({ requestCount: 3, inputTokens: 3000, outputTokens: 600, totalTokens: 3900, cachedTokens: 300, estimatedCostUsd: 0.03 }) },
  ]

  it('keeps the aggregated request count instead of counting one per row', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const result = cockpitOpsRoutesToModelRoutes(routes, accounts, windowModels, 1)
    expect(result.totalRequests).toBe(3)
    expect(result.routes).toHaveLength(2)

    const oauthRow = result.routes.find((r) => r.accountName === 'plus1@gmail.com')!
    expect(oauthRow.requests).toBe(2, '聚合值必须覆盖合成事件的 1')
    expect(oauthRow.inboundEndpoint).toBe('/v1/responses')
    expect(oauthRow.channelName).toBe('OpenAI Codex 官方（OAuth 池）')
    expect(oauthRow.firstSeen).toBe(new Date(1_756_800_000_000).toISOString())
    expect(oauthRow.lastSeen).toBe(new Date(1_756_800_060_000).toISOString())

    const relayRow = result.routes.find((r) => r.accountName === 'My Relay')!
    expect(relayRow.requests).toBe(1)
    expect(relayRow.channelName).toBe('My Relay')
    expect(relayRow.upstreamEndpoint).toBe('relay.example.com')
  })

  it('allocates tokens and cost by request share across the whole window', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const { routes: rows } = cockpitOpsRoutesToModelRoutes(routes, accounts, windowModels, 1)
    const total = rows.reduce((sum, r) => sum + r.standardCost, 0)
    const totalTokens = rows.reduce((sum, r) => sum + r.inputTokens, 0)
    // 3 请求窗口:2/3 与 1/3 分摊,合计守恒(与单天日志解析同口径)
    expect(total).toBeCloseTo(0.03, 10)
    expect(totalTokens).toBe(3000)
    const oauthRow = rows.find((r) => r.accountName === 'plus1@gmail.com')!
    const relayRow = rows.find((r) => r.accountName === 'My Relay')!
    expect(oauthRow.standardCost).toBeCloseTo(0.02, 10)
    expect(relayRow.standardCost).toBeCloseTo(0.01, 10)
  })

  it('labels requests without accountId as unattributed instead of "deleted account"', () => {
    // 实测日志只有约 15% 的请求带 accountId(auth 事件才有),其余不能冒充"已删除账号"
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const unattributed: CockpitOpsRouteAgg[] = [{
      model: 'gpt-5',
      account_id: null,
      inbound_path: '/v1/responses',
      requests: 8,
      success_count: 8,
      error_count: 0,
      first_ms: 1_756_800_000_000,
      last_ms: 1_756_800_600_000,
    }]
    const { routes: rows } = cockpitOpsRoutesToModelRoutes(unattributed, accounts, windowModels, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].accountId).toBeNull()
    expect(rows[0].accountName).toBe('未归因账号（日志无 accountId）')
    expect(rows[0].channelName).toBe('未归因渠道（日志无 accountId）')
    expect(rows[0].upstreamEndpoint).toBe('未记录（日志无 accountId）')
    expect(rows[0].requests).toBe(8)
  })

  it('returns empty rows for an empty aggregation instead of falling back to today', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    expect(cockpitOpsRoutesToModelRoutes([], accounts, windowModels, 1)).toEqual({ routes: [], totalRequests: 0 })
  })

  it('summarizes the audit card from the aggregated request count', () => {
    const summary = cockpitRoutesAuditSummary(120)
    expect(summary.totalRequests).toBe(120)
    // cockpit 日志无"上游响应声明模型"字段 → 真实语义是全部未观测,不能冒充"已验证一致"
    expect(summary.observedRequests).toBe(0)
    expect(summary.matchedRequests).toBe(0)
    expect(summary.unobservedRequests).toBe(120)
    expect(summary.mismatchRequests).toBe(0)
  })

  it('reports mismatchRate as null (unmeasured) rather than 0 (zero mismatch)', () => {
    // 0 是在断言"零差异",只有真比对过才配说 0;cockpit 没比对过 ⇒ 未测量 = null。
    expect(cockpitRoutesAuditSummary(120).mismatchRate).toBeNull()
    expect(cockpitRoutesAuditSummary(0).mismatchRate).toBeNull()
  })
})

/**
 * 单请求用量库 groups → 路由行(2026-09-27,Bug A 修复)。
 *
 * 用户反馈"月数据很多没有"。根因:`summarize_cockpit_api_logs`(Rust)只读
 * `codex-api.log.YYYY-MM-DD` 文本日志,而本机 9 月份没有这些文件(只有 `app.log.*` 系列)
 * ⇒ 30d 下 `multiDayRoutes` 为空,回退的 `apiLog` 也为空 ⇒ **路由明细表整张空白**。
 *
 * 但 SQLite `request_logs` 有真实数据(30d 实测 56,813 行),`groups` 按
 * (模型×账号×apiKeyId) 聚合。本函数把 groups 转成 `CockpitOpsRouteAgg`,
 * 复用既有路由构造逻辑(渠道/账号解析、成本分摊都不重写)。
 *
 * 本用例钉住三件事:① 同 (模型,账号) 的多个 apiKey 分组合并、requests 求和、时间取 min/max;
 * ② 分组没有的维度(inbound_path / success_count / error_count)不编造;
 * ③ 端到端 requests 守恒(不丢不重)——这正是修复前恒为 0 行的那个位置。
 */
describe('cockpit adapter: 单请求用量库 groups → 路由行(长窗口兜底,2026-09-27)', () => {
  it('★ 合并同 (模型,账号) 的多个 apiKey 分组:requests 求和、时间取 min/max', () => {
    const groups: CockpitRequestLogGroup[] = [
      group({ model: 'gpt-6-astra', accountId: 'codex_abc', apiKeyId: 'k1', requests: 3, firstMs: 1_700_000_000_000, lastMs: 1_700_000_030_000 }),
      group({ model: 'gpt-6-astra', accountId: 'codex_abc', apiKeyId: 'k2', requests: 5, firstMs: 1_700_000_010_000, lastMs: 1_700_000_060_000 }),
      group({ model: 'gpt-5.6-sol', accountId: 'codex_xyz', apiKeyId: 'k3', requests: 2, firstMs: 1_700_000_020_000, lastMs: 1_700_000_020_000 }),
    ]
    const aggs = cockpitRequestLogGroupsToOpsRoutes(groups)
    // 3 个 group → 2 条聚合(astra 的两个 apiKey 合并)
    expect(aggs).toHaveLength(2)
    const astra = aggs.find((a) => a.model === 'gpt-6-astra')!
    expect(astra.requests).toBe(8)
    expect(astra.first_ms).toBe(1_700_000_000_000)
    expect(astra.last_ms).toBe(1_700_000_060_000)
    // 分组无 inbound_path 维度 ⇒ 不得编造
    expect(astra.inbound_path).toBeNull()
    // 分组无 success/error 维度 ⇒ 置 0(路由表不显示这两列)
    expect(astra.success_count).toBe(0)
    expect(astra.error_count).toBe(0)
    // 不同账号的同名模型不得被合并(账号是 key 的一部分)
    expect(aggs.find((a) => a.model === 'gpt-5.6-sol')!.requests).toBe(2)
  })

  it('accountId 为空串 ⇒ account_id = null(不编造账号归属)', () => {
    const aggs = cockpitRequestLogGroupsToOpsRoutes([group({ accountId: '', apiKeyId: 'k1', requests: 4 })])
    expect(aggs).toHaveLength(1)
    expect(aggs[0].account_id).toBeNull()
  })

  it('空 groups ⇒ 空数组(不是回退"今天"的兜底)', () => {
    expect(cockpitRequestLogGroupsToOpsRoutes([])).toEqual([])
  })

  it('★ 端到端:派生路由行的 requests 合计 = groups 的 requests 合计(不丢不重)', () => {
    const groups: CockpitRequestLogGroup[] = [
      group({ model: 'gpt-6-astra', accountId: 'codex_abc', apiKeyId: 'k1', requests: 30 }),
      group({ model: 'gpt-6-astra', accountId: 'codex_abc', apiKeyId: 'k2', requests: 12 }),
      group({ model: 'gpt-5.6-sol', accountId: 'codex_xyz', apiKeyId: 'k3', requests: 8 }),
    ]
    const expected = groups.reduce((s, g) => s + g.requests, 0)
    const aggs = cockpitRequestLogGroupsToOpsRoutes(groups)
    const { routes, totalRequests } = cockpitOpsRoutesToModelRoutes(aggs, [], undefined, 1)
    expect(totalRequests).toBe(expected)
    expect(routes.reduce((s, r) => s + r.requests, 0)).toBe(expected)
    // 非空 —— 这正是 30d 修复前缺的那件事(修复前这里是 0 行)
    expect(routes.length).toBeGreaterThan(0)
  })
})

describe('cockpit adapter: 「分组」列来自 cockpit 账号分组文件 (2026-09-13)', () => {
  // cockpit 的 request_logs 没有 group_id,但账号分组存在 account_groups.json /
  // codex_account_groups.json 里(见 api/cockpit/index.ts 的 CockpitAccountGroup 注释)。
  const routes: CockpitOpsRouteAgg[] = [{
    model: 'gpt-5',
    account_id: PLUS_ACCOUNT_ID,
    inbound_path: '/v1/responses',
    requests: 2,
    success_count: 2,
    error_count: 0,
    first_ms: 1_756_800_000_000,
    last_ms: 1_756_800_060_000,
  }]

  it('builds an accountId→group map from both group files', () => {
    const map = cockpitGroupNameByAccountId(
      [{ id: 'g1', name: '生产号池', accountIds: [PLUS_ACCOUNT_ID] }],
      [{ id: 'g2', name: '备用池', accountIds: ['other-id'] }],
    )
    expect(map.get(PLUS_ACCOUNT_ID)).toBe('生产号池')
    expect(map.get('other-id')).toBe('备用池')
  })

  it('does not invent a group for an account that is in no group', () => {
    const map = cockpitGroupNameByAccountId([{ id: 'g1', name: '生产号池', accountIds: ['nobody'] }], [])
    // 未进任何组的账号(PLUS_ACCOUNT_ID 是真实账号但不在此组)不得被凭空分配组名。
    expect(map.get(PLUS_ACCOUNT_ID)).toBeUndefined()
    // 映射只服务于组内那一个账号 'nobody':其「原始 id」+「数字 id」两个键
    // (见 cockpitGroupNameByAccountId 的双键设计——ops 路径用原始 id,单天日志路径只有数字 id),
    // 且值只有一个组名,没有凭空多出的分组。
    expect(map.get('nobody')).toBe('生产号池')
    expect(map.size).toBe(2)
    expect(new Set(map.values())).toEqual(new Set(['生产号池']))
  })

  it('ignores blank names / non-string ids instead of fabricating a group', () => {
    const map = cockpitGroupNameByAccountId(
      [{ id: 'g1', name: '   ', accountIds: [PLUS_ACCOUNT_ID] }],
      [{ id: 'g2', name: '有效', accountIds: [PLUS_ACCOUNT_ID] }],
    )
    // 空白名不产生映射;同 id 命中"有效"组
    expect(map.get(PLUS_ACCOUNT_ID)).toBe('有效')
  })

  it('fills the route group column and labels its cockpit origin', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const groups = cockpitGroupNameByAccountId(
      [{ id: 'g1', name: '生产号池', accountIds: [PLUS_ACCOUNT_ID] }],
      [],
    )
    const { routes: rows } = cockpitOpsRoutesToModelRoutes(routes, accounts, undefined, 1, undefined, null, groups)
    expect(rows).toHaveLength(1)
    expect(rows[0].groupName).toBe('生产号池')
    // 必须标注来源,不能让人误读成 sub2api 计费分组
    expect(rows[0].groupLabel).toBe('cockpit 账号分组')
    expect(rows[0].groupId).toBeNull()
  })

  it('keeps the default 未分组 when no group map is supplied', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const { routes: rows } = cockpitOpsRoutesToModelRoutes(routes, accounts, undefined, 1)
    expect(rows[0].groupName).toBe('未分组')
    expect(rows[0].groupLabel).toBeUndefined()
  })

  it('applies the group map on the single-day log fallback too (numeric accountId lookup)', () => {
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const groups = cockpitGroupNameByAccountId(
      [{ id: 'g1', name: '生产号池', accountIds: [PLUS_ACCOUNT_ID] }],
      [],
    )
    const log = [
      logLine({ type: 'request_started', requestId: 'req-1', model: 'gpt-5', requestKind: 'text', path: '/v1/responses', method: 'POST', transport: 'json' }),
      logLine({ type: 'auth_result', requestId: 'req-1', accountId: PLUS_ACCOUNT_ID, accountEmail: 'plus1@gmail.com', success: true }),
      logLine({ type: 'request_completed', requestId: 'req-1', status: 200, latencyMs: 800, completedAtMs: 1_756_800_000_000 }),
    ].join('\n')
    const { routes: rows } = cockpitLogToModelRoutes(log, accounts, undefined, 1, undefined, groups)
    const row = rows.find((r) => r.accountName === 'plus1@gmail.com')!
    expect(row.groupName).toBe('生产号池')
    expect(row.groupLabel).toBe('cockpit 账号分组')
  })
})

describe('cockpit adapter: cost is computed by OUR pricing, not the source estimate (2026-09-08)', () => {
  // 本地单价:入 $2/M、出 $10/M、缓存命中 $0.5/M → per-token
  const pricing = {
    'gpt-5': { found: true, origin: 'local' as const, input_price: 2e-6, output_price: 10e-6, cache_read_price: 0.5e-6 },
  }
  const modelUsage = usage({
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 100,
    totalTokens: 1600,
    estimatedCostUsd: 0.02, // cockpit 自带黑盒估算(故意与本地单价不同,便于分辨走哪条路)
  })

  it('prices tokens with the local catalog instead of trusting estimatedCostUsd', () => {
    const { cost, basis } = cockpitUsageCostUsd(modelUsage, pricing['gpt-5'], 1)
    // 缓存命中是 input 的子集(与 cockpit calculate_usage_cost_usd_from_tokens 同口径):
    // 未缓存输入 900*2e-6 + 缓存 100*0.5e-6 + 输出 500*10e-6 = 0.0018 + 0.00005 + 0.005
    expect(cost).toBeCloseTo(0.00685, 10)
    expect(cost).not.toBeCloseTo(0.02, 6)
    expect(basis).toBe(COCKPIT_COST_BASIS_LOCAL)
  })

  it('treats cached tokens as a subset of input, never additive', () => {
    // cockpit: cached = min(cached, input);normal = input - cached。
    // 早期我们按 input + cached 并列计价,缓存部分被按输入价重复收一遍 → 成本虚高。
    const allCached = usage({ inputTokens: 1000, cachedTokens: 1000, outputTokens: 0, estimatedCostUsd: 99 })
    expect(cockpitUsageCostUsd(allCached, pricing['gpt-5'], 1).cost).toBeCloseTo(1000 * 0.5e-6, 10)
    // 缓存数超过输入数(cockpit 数据偶发)时按输入数封顶,不出现负的输入 token
    const overflow = usage({ inputTokens: 100, cachedTokens: 9999, outputTokens: 0, estimatedCostUsd: 99 })
    expect(cockpitUsageCostUsd(overflow, pricing['gpt-5'], 1).cost).toBeCloseTo(100 * 0.5e-6, 10)
  })

  it('falls back to the source estimate only when the model has no local price, and says so', () => {
    const missing = cockpitUsageCostUsd(modelUsage, undefined, 2)
    expect(missing.cost).toBeCloseTo(0.04, 10)
    expect(missing.basis).toBe(COCKPIT_COST_BASIS_ESTIMATE)
  })

  it('applies the multiplier on top of our own per-token price', () => {
    expect(cockpitUsageCostUsd(modelUsage, pricing['gpt-5'], 2).cost).toBeCloseTo(0.0137, 10)
  })

  it('model stats use the local price (regression: previously ate estimatedCostUsd)', () => {
    const window: CockpitStatsWindow = {
      since: 1_756_800_000_000,
      updatedAt: 1_756_800_000_000,
      totals: modelUsage,
      accounts: [],
      models: [{ modelId: 'gpt-5', usage: modelUsage }],
    }
    const [row] = cockpitModelsToModelStats(window, 1, pricing)
    expect(row!.cost).toBeCloseTo(0.00685, 10)
    expect(row!.account_cost).toBeCloseTo(0.00685, 10)
    const [discounted] = cockpitModelsToModelStats(window, 0.2, pricing)
    expect(discounted!.cost).toBeCloseTo(0.00685, 10)
    expect(discounted!.account_cost).toBeCloseTo(0.00137, 10)
    const unknown = cockpitModelsToModelStats({ ...window, models: [{ modelId: 'unpriced-fixture', usage: { ...modelUsage, estimatedCostUsd: 0 } }] }, 0.2, pricing)[0]!
    expect(unknown.cost).toBeNull()
    expect(unknown.account_cost).toBeNull()
  })

  it('keeps account-level costs summing to the window total computed by us', () => {
    const window: CockpitStatsWindow = {
      since: 1_756_800_000_000,
      updatedAt: 1_756_800_000_000,
      totals: modelUsage,
      accounts: [
        { accountId: PLUS_ACCOUNT_ID, email: 'plus1@gmail.com', usage: usage({ inputTokens: 1000, outputTokens: 500, cachedTokens: 100, totalTokens: 1600, estimatedCostUsd: 0.02 }) },
        { accountId: ORPHAN_ACCOUNT_ID, email: 'retired@gmail.com', usage: usage({ inputTokens: 2000, outputTokens: 1000, cachedTokens: 200, totalTokens: 3200, estimatedCostUsd: 0.04 }) },
      ],
      models: [{ modelId: 'gpt-5', usage: modelUsage }],
    }
    const stats = cockpitWindowToAccountStats(window, 1, pricing)
    const total = Object.values(stats).reduce((sum, s) => sum + s.cost, 0)
    const blended = cockpitBlendedTokenPrice(window.models, pricing, 1)!
    // 混合单价 = 自算窗口成本 ÷ 计费 token,账号按各自 token 还原 → 合计 = 3 倍单账号(第二个账号 token 是 2 倍)
    expect(blended.cost).toBeCloseTo(0.00685, 10)
    expect(total).toBeCloseTo(0.00685 * 3, 8)
  })

  it('documents why the implied price must NOT be fed back into the cost formula', () => {
    // 隐含价是 input=output=cache_read 的同一混合价(由 estimatedCostUsd 反推),
    // 代回逐项计价会把成本算成 2~3 倍 —— 所以 store 只把**本地**定价传给成本函数。
    const implied = cockpitModelsToImpliedPricing([{ modelId: 'gpt-5', usage: modelUsage }], 1)['gpt-5']!
    const viaImplied = cockpitUsageCostUsd(modelUsage, implied, 1).cost
    expect(viaImplied).toBeGreaterThan(modelUsage.estimatedCostUsd * 1.5)
  })

  it('falls back to the cockpit built-in price book for models with no local override', () => {
    // gpt-5.6-sol 不在本机 local_access 覆盖价里(只有 terra/luna),但 cockpit 内置价目有:
    // 标准档 入 $5/M、缓存 $0.5/M、出 $30/M —— 必须用内置价目自算,不能回退黑盒估算。
    const effective = cockpitEffectiveModelPricing([
      { modelId: 'gpt-5.6-luna', inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2, cachedInputUsdPerMillion: 0.02 },
    ])
    const sol = effective['gpt-5.6-sol']
    expect(sol?.origin).toBe('book')
    expect(sol?.input_price).toBeCloseTo(5e-6, 12)
    expect(sol?.output_price).toBeCloseTo(30e-6, 12)
    expect(sol?.cache_read_price).toBeCloseTo(0.5e-6, 12)
    // 用户手动配的价优先于内置价目,并标 origin='local'
    expect(effective['gpt-5.6-luna']?.origin).toBe('local')
    expect(effective['gpt-5.6-luna']?.input_price).toBeCloseTo(0.2e-6, 12)
  })

  it('prices the biggest spender with the built-in book instead of the source estimate', () => {
    const effective = cockpitEffectiveModelPricing(undefined)
    // 实测 monthly: sol 入 1,086,381,284 / 出 3,592,727 / 缓存 950,315,766,估算 $1294.48
    const usageSol = usage({
      inputTokens: 1_086_381_284,
      outputTokens: 3_592_727,
      cachedTokens: 950_315_766,
      totalTokens: 2_040_289_777,
      estimatedCostUsd: 1294.479344,
    })
    const { cost, basis } = cockpitUsageCostUsd(usageSol, effective['gpt-5.6-sol'], 1)
    // 1086.38M*5 + 3.59M*30 + 950.32M*0.5 (每 M) ≈ 5431.9 + 107.8 + 475.2 ≈ 6014.9
    expect(cost).toBeGreaterThan(1000)
    expect(cost).not.toBeCloseTo(1294.479344, 2)
    expect(basis).toBe(COCKPIT_COST_BASIS_BOOK)
  })

  it('prices gpt-6-astra from the v3 built-in book (missing from the old source snapshot)', () => {
    // cockpit 1.3.45 价目版本 3 已收录 astra:入 $10/M、缓存 $1/M、出 $50/M
    const effective = cockpitEffectiveModelPricing(undefined)
    const astra = effective['gpt-6-astra']
    expect(astra?.origin).toBe('book')
    expect(astra?.input_price).toBeCloseTo(10e-6, 12)
    expect(astra?.cache_read_price).toBeCloseTo(1e-6, 12)
    expect(astra?.output_price).toBeCloseTo(50e-6, 12)
  })

  it('still falls back to the source estimate for models absent from both catalogs', () => {
    // 价目表只收 Codex/OpenAI 公开价的模型;自建模号没有可对接的单价
    const effective = cockpitEffectiveModelPricing(undefined)
    expect(effective['gpt-image-2']).toBeUndefined()
    const custom = cockpitUsageCostUsd(
      usage({ inputTokens: 1000, outputTokens: 500, cachedTokens: 100, estimatedCostUsd: 12.5 }),
      effective['gpt-image-2'],
      1,
    )
    expect(custom.cost).toBeCloseTo(12.5, 10)
    expect(custom.basis).toBe(COCKPIT_COST_BASIS_ESTIMATE)
  })

  it('aggregate fallback without any model aggregation still returns the estimate', () => {
    expect(cockpitAggregateCostUsd(modelUsage, null, 1).cost).toBeCloseTo(0.02, 10)
  })
})

describe('cockpit adapter: implied pricing fallback', () => {
  it('derives a blended per-token price from window usage without fabricating official prices', () => {
    const pricing = cockpitModelsToImpliedPricing([
      { modelId: 'gpt-5', usage: usage() },
    ], 1)
    // 计费 tokens = 1600-100 = 1500;成本 0.02 → 单价 = 0.02/1500(per-token)
    expect(pricing['gpt-5'].found).toBe(true)
    expect(pricing['gpt-5'].input_price).toBeCloseTo(0.02 / 1500, 10)
    // 缓存价 = 成本/缓存 tokens(缓存 100 > 0 时存在)
    expect(pricing['gpt-5'].cache_read_price).toBeCloseTo(0.02 / 100, 10)
  })

  it('skips models without measurable usage instead of inventing a zero price', () => {
    const pricing = cockpitModelsToImpliedPricing([
      { modelId: 'unused-model', usage: usage({ requestCount: 0, totalTokens: 0, estimatedCostUsd: 0 }) },
    ], 1)
    expect(pricing['unused-model']).toBeUndefined()
  })
})

describe('cockpit adapter: multi-platform account list', () => {
  it('maps platform accounts with plan labels and honest no-usage metadata', () => {
    const accounts = cockpitPlatformAccountsToAccounts([
      { id: 'gemini_abc123', email: 'g@gmail.com', planLabel: 'Gemini Code Assist', createdAt: 1_750_000_000, platform: 'gemini' },
    ])
    expect(accounts).toHaveLength(1)
    expect(accounts[0].platform).toBe('gemini')
    expect(accounts[0].name).toBe('g@gmail.com')
    expect(accounts[0].scheduler_score).toBeNull()
    // P0-19:旧的 cockpit_platform_no_usage 已废弃,改三态 usage_granularity。
    const extra = accounts[0].extra as { usage_granularity?: string; cockpit_plan_label?: string }
    expect(extra.usage_granularity).toBe('quota_level')
    expect(extra.cockpit_plan_label).toBe('Gemini Code Assist')
    expect(accounts[0].created_at).toBe(new Date(1_750_000_000_000).toISOString())
  })

  it('P0-19 三态:API Key 类账号标 unavailable,不冒充 quota_level', () => {
    const accounts = cockpitPlatformAccountsToAccounts([
      { id: 'claude_ak1', email: 'k@x.com', planType: 'ApiKey', platform: 'anthropic' },
      { id: 'claude_dg1', email: 'd@x.com', planType: 'DesktopGateway', platform: 'anthropic' },
      { id: 'claude_pro1', email: 'p@x.com', planType: 'Pro', platform: 'anthropic' },
    ])
    expect((accounts[0].extra as { usage_granularity?: string }).usage_granularity).toBe('unavailable')
    expect((accounts[1].extra as { usage_granularity?: string }).usage_granularity).toBe('unavailable')
    expect((accounts[2].extra as { usage_granularity?: string }).usage_granularity).toBe('quota_level')
  })

  it('P0-19 三态:codex 账号恒为 token_level', () => {
    expect(cockpitUsageGranularityOf('api_key', true)).toBe('token_level')
    expect(cockpitUsageGranularityOf(undefined, true)).toBe('token_level')
    expect(cockpitUsageGranularityOf('plus')).toBe('quota_level')
    expect(cockpitUsageGranularityOf('api_key')).toBe('unavailable')
  })
})

describe('cockpit usage ledger', () => {
  it('retains distinct legacy-colliding email identities without changing stored ledger records', () => {
    const stats = { ...makeStats(), accounts: [] }
    const ledger = ['costarring', 'liquid'].map(email => ({ email, updatedAt: 1, usage: usage() }))
    applyCockpitUsageLedger(stats, ledger)
    expect(stats.accounts.map(account => account.accountId)).toEqual(['cockpit:ledger-email:costarring', 'cockpit:ledger-email:liquid'])
    const ids = cockpitStatsToAccounts(stats).map(account => account.id)
    expect(ids).toEqual(['cockpit:ledger-email:costarring', 'cockpit:ledger-email:liquid'])
    expect(accountIdToCostId('cockpit:ledger-email:costarring')).not.toBe(ids[0])
    expect(ledger.map(entry => entry.email)).toEqual(['costarring', 'liquid'])
  })
  function ledgerEntry(email: string, usage: CockpitAccountUsage, updatedAt = 1_756_800_000_000): CockpitLedgerEntry {
    return { email, updatedAt, usage }
  }

  it('restores a regressed account: re-added account reset to 0 gets ledger values back (per-field max)', () => {
    const stats = makeStats()
    // 重加后 cockpit 从 0 计数:当前只剩 2 次请求,台账里是历史全量 150 次
    const regressed = stats.accounts[0]!
    regressed.usage = usage({ requestCount: 2, successCount: 2, failureCount: 0, inputTokens: 200, outputTokens: 100, totalTokens: 320, estimatedCostUsd: 0.004 })
    const ledger = [ledgerEntry('plus1@gmail.com', usage({ requestCount: 150, successCount: 140, failureCount: 10, inputTokens: 15_000, outputTokens: 7_500, totalTokens: 24_000, estimatedCostUsd: 0.3 }))]
    const merged = applyCockpitUsageLedger(stats, ledger)
    // 逐字段取 max:请求/成本恢复到台账历史值,不丢也不双计
    expect(regressed.usage.requestCount).toBe(150)
    expect(regressed.usage.inputTokens).toBe(15_000)
    expect(regressed.usage.estimatedCostUsd).toBeCloseTo(0.3, 10)
    // 返回的持久化载荷包含该 email 且值与回填后一致
    const persisted = merged.find((e) => e.email === 'plus1@gmail.com')!
    expect(persisted.usage.requestCount).toBe(150)
  })

  it('does not double count when current usage grew beyond the ledger', () => {
    const stats = makeStats()
    const grown = stats.accounts[0]!
    grown.usage = usage({ requestCount: 500, estimatedCostUsd: 1.2 })
    const ledger = [ledgerEntry('plus1@gmail.com', usage({ requestCount: 150, estimatedCostUsd: 0.3 }))]
    applyCockpitUsageLedger(stats, ledger)
    // 当前值更大(正常增长)→ 保持当前值,台账不能把账号拖回去,也不能相加成 650
    expect(grown.usage.requestCount).toBe(500)
    expect(grown.usage.estimatedCostUsd).toBeCloseTo(1.2, 10)
  })

  it('injects a synthetic historical account when the email vanished from stats entirely', () => {
    const stats = makeStats()
    const before = stats.accounts.length
    const ledger = [
      ledgerEntry('ghost@gmail.com', usage({ requestCount: 77, estimatedCostUsd: 0.4 }), 1_756_500_000_000),
    ]
    const merged = applyCockpitUsageLedger(stats, ledger)
    expect(stats.accounts.length).toBe(before + 1)
    const injected = stats.accounts.find((a) => a.accountId.startsWith('cockpit:ledger-email:'))!
    expect(injected.email).toBe('ghost@gmail.com')
    expect(injected.usage.requestCount).toBe(77)
    // 合成账号无 meta → 走 cockpit_historical(显示"已移出当前池")
    const [account] = cockpitStatsToAccounts({ ...stats }, apiKeyInfos, accountMeta)
      .filter((a) => (a.extra as { cockpit_historical?: boolean } | undefined)?.cockpit_historical === true)
      .filter((a) => a.name === 'ghost@gmail.com')
    expect(account).toBeTruthy()
    // 持久化载荷含 ghost(下次 reload 仍能注入)
    expect(merged.some((e) => e.email === 'ghost@gmail.com')).toBe(true)
  })

  it('does not inject duplicates for emails already present in stats (orphan retained world)', () => {
    const stats = makeStats()
    const before = stats.accounts.length
    // retired@gmail.com 是 stats 里已有的孤儿,台账里也有 → 只 max 合并,不注入
    const ledger = [ledgerEntry('retired@gmail.com', usage({ requestCount: 120, estimatedCostUsd: 0.6 }))]
    applyCockpitUsageLedger(stats, ledger)
    expect(stats.accounts.length).toBe(before)
    const orphan = stats.accounts.find((a) => a.email === 'retired@gmail.com')!
    expect(orphan.usage.requestCount).toBe(120)
    expect(orphan.accountId).toBe(ORPHAN_ACCOUNT_ID)
  })

  it('caps the persisted ledger at COCKPIT_LEDGER_CAP, dropping the oldest entries first', () => {
    const stats = makeStats()
    const ledger: CockpitLedgerEntry[] = []
    for (let i = 0; i < COCKPIT_LEDGER_CAP + 50; i++) {
      ledger.push(ledgerEntry(`bulk-${i}@test.local`, usage(), 1_756_000_000_000 + i))
    }
    const merged = applyCockpitUsageLedger(stats, ledger)
    expect(merged.length).toBe(COCKPIT_LEDGER_CAP)
    // 最旧的被裁掉,最新的保留;当前 stats 里的账号(email 有活跃快照)绝不丢
    expect(merged.some((e) => e.email === 'bulk-0@test.local')).toBe(false)
    expect(merged.some((e) => e.email === `bulk-${COCKPIT_LEDGER_CAP + 49}@test.local`)).toBe(true)
    expect(merged.some((e) => e.email === 'plus1@gmail.com')).toBe(true)
  })

  it('snapshots every email-bearing stats account (including orphans) for persistence', () => {
    const stats = makeStats()
    const snapshot = snapshotCockpitLedger(stats)
    expect(snapshot.length).toBe(stats.accounts.length)
    expect(snapshot.map((e) => e.email)).toContain('retired@gmail.com')
    expect(snapshot[0]!.usage.requestCount).toBe(10)
  })
})

describe('cockpit adapter: window-aware cost trend (2026-09-06)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const DAILY_SINCE = new Date(2026, 8, 6, 0, 0, 0).getTime()
  const WEEKLY_SINCE = new Date(2026, 7, 31, 0, 0, 0).getTime()
  const MONTHLY_SINCE = new Date(2026, 8, 1, 0, 0, 0).getTime()

  function statsWithWindows(): CockpitStats {
    const makeWindow = (since: number, costUsd: number, requests: number): CockpitStatsWindow => ({
      since,
      updatedAt: since + 3_600_000,
      totals: usage({ estimatedCostUsd: costUsd, requestCount: requests }),
      accounts: [],
      models: [],
    })
    return {
      ...makeStats(),
      daily: makeWindow(DAILY_SINCE, 1, 100),
      weekly: makeWindow(WEEKLY_SINCE, 7, 700),
      monthly: makeWindow(MONTHLY_SINCE, 30, 3000),
    }
  }

  it('returns only the window matching the selected range instead of 3 mixed-calendar points', () => {
    // 修复前:固定输出 daily→weekly→monthly 3 点,既与 range 无关,又时间轴乱序
    // (今天 → 本周一 → 本月 1 日 被当成递增序列)。
    const stats = statsWithWindows()
    const week = cockpitWindowsToCostTrend(stats, 1, '7d')
    expect(week).toHaveLength(1)
    expect(week[0]!.date).toBe(new Date(WEEKLY_SINCE).toISOString())
    expect(week[0]!.cost).toBeCloseTo(7)

    const shortWindow = cockpitWindowsToCostTrend(stats, 1, '1h')
    expect(shortWindow).toHaveLength(1)
    // 短窗口只有 daily 可用:返回的是**今日累计**,由视图标注,不冒充"最近 1 小时"
    expect(shortWindow[0]!.date).toBe(new Date(DAILY_SINCE).toISOString())
    expect(shortWindow[0]!.cost).toBeCloseTo(1)
  })

  it('keeps the legacy 3-window series only when no range is supplied', () => {
    expect(cockpitWindowsToCostTrend(statsWithWindows(), 1)).toHaveLength(3)
  })

  it('applies the cost multiplier to the selected window', () => {
    const month = cockpitWindowsToCostTrend(statsWithWindows(), 0.5, '30d')
    expect(month).toHaveLength(1)
    expect(month[0]!.cost).toBeCloseTo(15)
    expect(month[0]!.requests).toBe(3000)
  })

  it('falls back to the next available snapshot instead of returning an empty window', () => {
    const stats = statsWithWindows()
    stats.weekly = undefined
    const week = cockpitWindowsToCostTrend(stats, 1, '7d')
    expect(week).toHaveLength(1)
    expect(week[0]!.date).toBe(new Date(MONTHLY_SINCE).toISOString())
  })
})

describe('cockpit adapter: clip aggregated buckets to the exact rolling window', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops buckets outside the rolling window (day-file aggregation spans whole calendar days)', () => {
    const now = new Date(2026, 8, 6, 1, 18)
    vi.useFakeTimers()
    vi.setSystemTime(now)
    // Rust 按日历日文件聚合,24h 窗口(昨天 01:18 起)会多出昨天 00:00 起的桶
    const inside = new Date(now.getTime() - 3 * 3_600_000).getTime()
    const outside = new Date(now.getTime() - 40 * 3_600_000).getTime()
    const points = [outside, inside].map((bucketStart) => ({
      bucket_start: new Date(bucketStart).toISOString(),
      request_count: 5,
      success_count: 5,
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
      qps: 0,
      tps: 0,
    }))

    const clipped = clipOpsBucketsToWindow(points, '24h')
    expect(clipped).toHaveLength(1)
    expect(clipped[0]!.bucket_start).toBe(new Date(inside).toISOString())
  })
})

/* -------------------------------------------------------------------------- */
/* 单请求用量库(codex_local_access_logs.sqlite)口径                          */
/* -------------------------------------------------------------------------- */

/** 构造一条 (模型×账号) 聚合。未传的 token 分档默认 0。 */
function group(overrides: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return {
    model: 'gpt-6-astra',
    accountId: 'codex_abc',
    firstMs: 1_700_000_000_000,
    lastMs: 1_700_000_060_000,
    requests: 1,
    success: 1,
    error: 0,
    stdNormalInput: 0,
    stdCached: 0,
    stdOutput: 0,
    longNormalInput: 0,
    longCached: 0,
    longOutput: 0,
    estimatedCostUsd: 0,
    rateLimited: 0,
    upstreamError: 0,
    clientCanceled: 0,
    ...overrides,
  }
}

function cell(overrides: Partial<CockpitRequestLogCell> = {}): CockpitRequestLogCell {
  return { startMs: 1_700_000_000_000, model: 'gpt-6-astra', ...group(), ...overrides }
}

function summaryOf(
  groups: CockpitRequestLogGroup[],
  cells: CockpitRequestLogCell[] = [],
  bucketLatencies: CockpitRequestLogSummary['bucketLatencies'] = [],
): CockpitRequestLogSummary {
  return {
    available: true,
    reason: null,
    rowCount: groups.reduce((s, g) => s + g.requests, 0),
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_060_000,
    bucketHours: 1,
    cells,
    groups,
    bucketLatencies,
  }
}

describe('cockpit adapter: 长上下文档位价(单请求用量库口径)', () => {
  const sets = cockpitEffectivePriceSets(undefined)

  it('shares exact SQL groups for either model window, preserving empty versus unavailable', () => {
    const groups = [group({ accountId: PLUS_ACCOUNT_ID, stdNormalInput: 1_000_000, stdCached: 0, stdOutput: 0 })]
    const summary = summaryOf(groups)
    const accounts = cockpitStatsToAccounts(makeStats(), apiKeyInfos, accountMeta)
    const expected = cockpitOpsRoutesToModelRoutes(
      cockpitRequestLogGroupsToOpsRoutes(groups), accounts, undefined, 0.2, undefined,
      cockpitRequestLogGroupCost(summary, sets, 0.2), new Map([[PLUS_ACCOUNT_ID, 'fixture group']]),
    )
    const actual = cockpitRequestLogToModelRoutes(summary, accounts, sets, 0.2, new Map([[PLUS_ACCOUNT_ID, 'fixture group']]))
    expect(actual).toEqual(expected)
    expect(actual?.routes[0]).toMatchObject({ requests: groups[0].requests, groupName: 'fixture group', costUnknown: false })
    expect(actual?.routes[0]?.totalTokens).toBe(actual!.routes[0]!.inputTokens! + actual!.routes[0]!.outputTokens!)
    expect(cockpitRequestLogToModelRoutes(summaryOf([]), accounts, sets, 0.2)).toEqual({ routes: [], totalRequests: 0 })
    expect(cockpitRequestLogToModelRoutes({ ...summary, available: false }, accounts, sets, 0.2)).toBeNull()
    const unknown = cockpitRequestLogToModelRoutes(summaryOf([group({ model: 'unpriced-fixture', estimatedCostUsd: 0 })]), [], {}, 0.2)
    expect(unknown?.routes[0]).toMatchObject({ accountCost: null, costUnknown: true })
  })

  it('内置价目表派生长文本文档价 = 标准档 ×2 / ×2 / ×1.5', () => {
    // 与 cockpit 实测落库单价一致:astra 标准 10/1/50,长文本 20/2/75
    const astra = sets['gpt-6-astra']!
    expect(astra.sessionLongContext).toBe(true)
    expect(astra.standard.input).toBeCloseTo(10e-6, 12)
    expect(astra.long!.input).toBeCloseTo(20e-6, 12)
    expect(astra.long!.cache).toBeCloseTo(2e-6, 12)
    expect(astra.long!.output).toBeCloseTo(75e-6, 12)
  })

  it('长文本档 token 按长文本价计、标准档 token 按标准价计,两档相加', () => {
    const split = group({ stdNormalInput: 1_000_000, stdOutput: 10_000, longNormalInput: 1_000_000, longOutput: 10_000 })
    // 标准:1M × $10/M + 10k × $50/M = 10 + 0.5 = 10.5
    // 长文本:1M × $20/M + 10k × $75/M = 20 + 0.75 = 20.75
    expect(cockpitSplitCostUsd(split, sets['gpt-6-astra'], 1).cost).toBeCloseTo(31.25, 9)
  })

  it('没开长文本文档位的模型,长文本 token 仍按标准价计(与 cockpit 同规则)', () => {
    // gpt-5.4-mini 在价目表里 sessionLongContext=false
    expect(sets['gpt-5.4-mini']!.sessionLongContext).toBe(false)
    const split = group({ model: 'gpt-5.4-mini', longNormalInput: 1_000_000 })
    // 0.75/M × 1M = 0.75(不会因为被分到"长文本桶"就 ×2)
    expect(cockpitSplitCostUsd(split, sets['gpt-5.4-mini'], 1).cost).toBeCloseTo(0.75, 9)
  })

  it('本项目无该模型单价时回退数据源估算并如实标注口径', () => {
    const split = group({ model: 'gpt-image-2', stdNormalInput: 1000, estimatedCostUsd: 12.5 })
    const { cost, basis } = cockpitSplitCostUsd(split, sets['gpt-image-2'], 1)
    expect(cost).toBeCloseTo(12.5, 9)
    expect(basis).toBe(COCKPIT_COST_BASIS_ESTIMATE)
  })

  it('分档 token 还原平铺 token 数(缓存命中是 input 的子集,不重复计)', () => {
    const t = cockpitSplitTokens(group({
      stdNormalInput: 600, stdCached: 400, stdOutput: 50,
      longNormalInput: 6_000, longCached: 4_000, longOutput: 500,
    }))
    expect(t.inputTokens).toBe(11_000)
    expect(t.cachedTokens).toBe(4_400)
    expect(t.outputTokens).toBe(550)
    expect(t.totalTokens).toBe(11_550)
  })

  it('复现实测真值:gpt-6-astra 全量 $3969.947', () => {
    // 取自本机 request_logs(179k 行)真实聚合,与 cockpit 落库 estimated_cost_usd 分毫不差。
    // 这个数是"必须逐请求分档"的证据:全按标准档只有 $2125,全按长文本档是 $4196,都不对。
    const split = group({
      stdNormalInput: 6_605_510, stdCached: 184_482_048, stdOutput: 544_088,
      longNormalInput: 40_438_506, longCached: 1_378_525_312, longOutput: 1_685_130,
    })
    expect(cockpitSplitCostUsd(split, sets['gpt-6-astra'], 1).cost).toBeCloseTo(3969.947042, 5)
  })

  it('倍率与其它路径同口径(全局成本倍率参与计价)', () => {
    const split = group({ stdNormalInput: 1_000_000 })
    expect(cockpitSplitCostUsd(split, sets['gpt-6-astra'], 2).cost).toBeCloseTo(20, 9)
  })
})

describe('cockpit adapter: 单请求用量库 → 模型/账号/趋势', () => {
  const sets = cockpitEffectivePriceSets(undefined)

  it('同模型多账号合并为一行,按成本降序', () => {
    const s = summaryOf([
      group({ accountId: 'acc-a', stdNormalInput: 2_000_000 }), // $20
      group({ accountId: 'acc-b', longNormalInput: 2_000_000 }), // $40
      group({ model: 'gpt-5.6-luna', accountId: 'acc-a', stdNormalInput: 1_000_000 }), // $0.2
    ])
    const stats = cockpitRequestLogToModelStats(s, sets, 1)
    expect(stats).toHaveLength(2)
    expect(stats[0]!.model).toBe('gpt-6-astra')
    expect(stats[0]!.requests).toBe(2)
    expect(stats[0]!.cost).toBeCloseTo(60, 9)
    expect(stats[1]!.model).toBe('gpt-5.6-luna')
    expect(stats[1]!.cost).toBeCloseTo(0.2, 9)
  })

  it('model reference/account columns stay separate across tier pricing and scoped input', () => {
    const regular = group({ accountId: 'selected', stdNormalInput: 1_000_000 })
    const priority = group({ accountId: 'other', stdNormalInput: 1_000_000, serviceTier: 'priority' })
    const global = cockpitRequestLogToModelStats(summaryOf([regular, priority]), sets, 0.2)[0]!
    expect(global).toMatchObject({ cost: 30, account_cost: 6, actual_cost: null })
    const scoped = cockpitRequestLogToModelStats(summaryOf([regular]), sets, 0.2)[0]!
    expect(scoped).toMatchObject({ requests: 1, cost: 10, account_cost: 2 })
    const unknown = cockpitRequestLogToModelStats(summaryOf([group({ model: 'unpriced-fixture', stdNormalInput: 100, estimatedCostUsd: 0 })]), sets, 0.2)[0]!
    expect(unknown.cost).toBeNull()
    expect(unknown.account_cost).toBeNull()
  })

  it('逐账号成本按 (模型×账号) 分别计价后累加,不串味', () => {
    // 同一账号用了两个模型:必须先逐模型计价再相加,合并 token 再用一个价会算错
    const s = summaryOf([
      group({ accountId: 'acc-a', stdNormalInput: 1_000_000 }), // astra $10
      group({ model: 'gpt-5.6-luna', accountId: 'acc-a', stdNormalInput: 1_000_000 }), // luna $0.2
    ])
    const stats = cockpitRequestLogToAccountStats(s, sets, 1)
    const ids = Object.keys(stats)
    expect(ids).toHaveLength(1)
    expect(stats[ids[0]!]!.cost).toBeCloseTo(10.2, 9)
    expect(stats[ids[0]!]!.requests).toBe(2)
  })

  it('preserves reference value and known partial amounts without inventing local revenue', () => {
    const priced = group({ accountId: 'historical-only', stdNormalInput: 1_000_000 })
    const complete = cockpitRequestLogToAccountStats(summaryOf([priced]), sets, 0.2)
    expect(Object.values(complete)[0]).toMatchObject({ cost: 2, standard_cost: 10, user_cost: null })
    const unknown = group({ accountId: 'historical-only', model: 'unpriced-fixture', stdNormalInput: 100, estimatedCostUsd: 0 })
    const mixed = cockpitRequestLogToAccountStats(summaryOf([priced, unknown]), sets, 0.2)
    expect(Object.values(mixed)[0]).toMatchObject({ requests: 2, cost: null, standard_cost: null, user_cost: null, known_cost: 2, known_standard_cost: 10, unknown_cost_requests: 1 })
  })

  it('conserves 285 assigned plus 263 unassigned requests without inventing an account', () => {
    const groups = [
      group({ accountId: 'real-account', requests: 285, stdNormalInput: 1_000_000 }),
      group({ accountId: '', requests: 260, stdNormalInput: 2_000_000 }),
      group({ accountId: null, model: 'unpriced-fixture', requests: 3, stdNormalInput: 100 }),
    ]
    const result = cockpitRequestLogToAccountStats(summaryOf(groups), sets, 0.2)
    expect(Object.values(result).reduce((n, row) => n + row.requests, 0)).toBe(548)
    expect(result[UNATTRIBUTED_USAGE_ACCOUNT_ID]).toMatchObject({ requests: 263, tokens: 2_000_100, cost: null, standard_cost: null, user_cost: null, known_cost: 4, known_standard_cost: 20, unknown_cost_requests: 3 })
    expect(Object.keys(result).filter(key => key !== UNATTRIBUTED_USAGE_ACCOUNT_ID)).toHaveLength(1)
  })

  it('库不可用时返空(调用方回退快照口径,不静默变 0)', () => {
    expect(cockpitRequestLogToModelStats(null, sets, 1)).toEqual([])
    expect(cockpitRequestLogToModelStats(summaryOf([]), sets, 1)).toEqual([])
    const s: CockpitRequestLogSummary = { ...summaryOf([group()]), available: false }
    expect(cockpitRequestLogToModelStats(s, sets, 1)).toEqual([])
    expect(cockpitRequestLogToCostTrend(s, sets, 1)).toEqual([])
  })

  it('成本趋势按时间桶输出,逐桶逐模型计价', () => {
    const hour = 3_600_000
    const s = summaryOf([group()], [
      cell({ startMs: hour * 2, stdNormalInput: 1_000_000 }), // astra $10
      cell({ startMs: hour * 2, model: 'gpt-5.6-luna', stdNormalInput: 1_000_000 }), // luna $0.2
      cell({ startMs: hour * 1, stdNormalInput: 1_000_000 }), // astra $10
    ])
    const trend = cockpitRequestLogToCostTrend(s, sets, 1)
    expect(trend).toHaveLength(2)
    expect(trend[0]!.date).toBe(new Date(hour * 1).toISOString())
    expect(trend[0]!.cost).toBeCloseTo(10, 9)
    expect(trend[1]!.cost).toBeCloseTo(10.2, 9)
  })

  it('(模型×账号) 组成本使用账号数字 id,无账号的组独立保留', () => {
    const s = summaryOf([
      group({ accountId: 'acc-a', stdNormalInput: 1_000_000 }), // $10
      group({ accountId: 'acc-a', longNormalInput: 1_000_000 }), // $20
      group({ accountId: '', stdNormalInput: 1_000_000 }),
    ])
    const m = cockpitRequestLogGroupCost(s, sets, 1)
    expect(m.size).toBe(2)
    expect(m.get(`gpt-6-astra\u0000${UNATTRIBUTED_USAGE_ACCOUNT_ID}`)?.cost).toBeCloseTo(10, 9)
    const [value] = [...m.values()]
    expect(value!.cost).toBeCloseTo(30, 9)
    expect(value!.requests).toBe(2)
  })
})

describe('cockpit adapter: 路由明细成本回填', () => {
  const sets = cockpitEffectivePriceSets(undefined)

  /** 最小 ModelRouteRow(只填回填会改到的字段)。 */
  function routeRow(model: string, accountId: number | string, requests: number) {
    return {
      key: `${model}|${accountId}`,
      requestedModel: model,
      upstreamModel: model,
      accountId,
      requests,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      standardCost: 0,
      accountCost: 0,
      revenue: 0,
      costBasis: undefined as string | undefined,
    } as never
  }

  it('同 (模型,账号) 内按请求数分摊,各行相加恒等于该组精确成本', () => {
    const s = summaryOf([group({ accountId: 'acc-a', stdNormalInput: 1_000_000, longNormalInput: 1_000_000 })])
    const groupCost = cockpitRequestLogGroupCost(s, sets, 1) // $30,requests 1
    const id = [...groupCost.keys()][0]!.split('\u0000')[1]!
    const rows = [
      routeRow('gpt-6-astra', id, 3),
      routeRow('gpt-6-astra', id, 1),
    ]
    applyCockpitRequestLogCost(rows as never, groupCost)
    expect(rows[0]!.standardCost).toBeCloseTo(22.5, 9)
    expect(rows[1]!.standardCost).toBeCloseTo(7.5, 9)
    expect(rows[0]!.standardCost + rows[1]!.standardCost).toBeCloseTo(30, 9)
    expect(rows[0]!.costBasis).toContain('长上下文')
  })

  it('组成本为空时不动原行(回退按模型均摊由调用方决定)', () => {
    const rows = [routeRow('gpt-6-astra', 1, 5)]
    applyCockpitRequestLogCost(rows as never, new Map())
    expect(rows[0]!.standardCost).toBe(0)
    expect(rows[0]!.costBasis).toBeUndefined()
  })
})

/** 2026-09-08 修复:定价目录不能只读 codex_local_access.json.modelPricings(用户手动覆盖,本机仅 2 条),
 *  必须合并 cockpit 内置价目表,否则目录里主力模型(gpt-6-astra 等)凭空消失。 */
describe('cockpitEffectiveModelPricings', () => {
  it('无本地覆盖时返回内置价目表全部模型', () => {
    const rows = cockpitEffectiveModelPricings(undefined)
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) expect(row.origin).toBe('book')
    const astra = rows.find((r) => r.modelId === 'gpt-6-astra')
    expect(astra).toBeTruthy()
    expect(astra!.inputUsdPerMillion).toBeGreaterThan(0)
    expect(astra!.standardLongInputUsdPerMillion).toBeCloseTo(astra!.inputUsdPerMillion! * 2, 6)
  })

  it('本地覆盖价按模型整体覆盖,并标 origin=local', () => {
    const rows = cockpitEffectiveModelPricings([
      { modelId: 'gpt-5.6-terra', inputUsdPerMillion: 2, outputUsdPerMillion: 12, cachedInputUsdPerMillion: 0.2, longContextThresholdTokens: 272000 },
    ])
    const terra = rows.find((r) => r.modelId === 'gpt-5.6-terra')!
    expect(terra.origin).toBe('local')
    expect(terra.inputUsdPerMillion).toBe(2)
    expect(terra.longContextThresholdTokens).toBe(272000)
    // 其余模型仍来自内置价目表,不因本地只配了 1 条而丢目录
    expect(rows.filter((r) => r.origin === 'book').length).toBeGreaterThan(2)
  })

  it('目录模型 id 唯一且按字典序稳定排序', () => {
    const ids = cockpitEffectiveModelPricings([
      { modelId: 'zz-custom-model', inputUsdPerMillion: 1, outputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1 },
    ]).map((r) => r.modelId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
    expect(ids).toContain('zz-custom-model')
  })
})

/**
 * 2026-09-10 修复:"延迟与 Token 结构"图在 7d/30d 窗口几乎全空。
 * 根因不是没数据——是没去读:ops 趋势此前只有 codex-api.log 一个延迟来源,
 * 而 cockpit 日志只保留 ~5 天(本机 9/6~9/10);单请求用量库的 latency_ms
 * 覆盖 181,575/181,613 行(99.98%,07-29 起全量)。
 */
describe('cockpitRequestLogToOpsTrend: 桶级耗时分位数', () => {
  it('有 bucketLatencies 时填 duration_p95_ms(7d/30d 不再整片断点)', () => {
    const trend = cockpitRequestLogToOpsTrend(summaryOf([group()], [cell()], [
      { startMs: 1_700_000_000_000, samples: 120, p50Ms: 800, p95Ms: 4_200 },
    ]))
    expect(trend.length).toBe(1)
    expect(trend[0]!.duration_p95_ms).toBe(4_200)
    // 成本列留 null(不是 0):0 会被 selectFinancialTrend 的 `finite(x) != null` 判成"有值",
    // 从而在 usage 为空时顶替成一条贴底零成本线;null 才真退出金融趋势选择。
    // 成本另走 cockpitRequestLogToCostTrend(CostTrendDataPoint.account_cost)。
    expect(trend[0]!.account_cost_usd).toBeNull()
    expect(trend[0]!.user_billed_usd).toBeNull()
    expect(trend[0]!.contribution_usd).toBeNull()
  })

  it('桶对不上或没有样本时留 null,不填 0 冒充"很快"', () => {
    const trend = cockpitRequestLogToOpsTrend(summaryOf([group()], [cell()], [
      { startMs: 9_999_999_999_999, samples: 5, p50Ms: 1, p95Ms: 2 },
    ]))
    expect(trend[0]!.duration_p95_ms).toBeNull()
    // 旧版后端不返回该字段时同样安全
    const legacy = cockpitRequestLogToOpsTrend({ ...summaryOf([group()], [cell()]), bucketLatencies: undefined as never })
    expect(legacy[0]!.duration_p95_ms).toBeNull()
  })

  it('TTFT 仍留 null:库里没有首 token 时间,只有日志有,不拿总耗时冒名顶替', () => {
    const trend = cockpitRequestLogToOpsTrend(summaryOf([group()], [cell()], [
      { startMs: 1_700_000_000_000, samples: 120, p50Ms: 800, p95Ms: 4_200 },
    ]))
    expect(trend[0]!.ttft_p50_ms).toBeNull()
    expect(trend[0]!.ttft_p95_ms).toBeNull()
  })
})

/**
 * 2026-09-11 对齐 sub2api-cost-console / api2business:账号健康图与 429 错误码图。
 * cockpit 源没有 sub2api 的 economics / ops 错误端点,这两张图一直空着;
 * 但 `request_logs.error_category` + `http_status` 是本机真实存在的分类字段,
 * 按桶聚合即可还原"健康三态"与限流趋势。客户端取消单列,不虚高错误态。
 */
describe('cockpitRequestLogToHealthSeries / ErrorTrend', () => {
  const baseCell = { startMs: 1_700_000_000_000, model: 'm', stdNormalInput: 0, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0 }

  function healthCell(overrides: Record<string, number>): never {
    return { ...baseCell, requests: 0, success: 0, error: 0, rateLimited: 0, upstreamError: 0, clientCanceled: 0, ...overrides } as never
  }

  it('健康三态按失败原因分类:限流与客户端取消不混进错误态', () => {
    const summary = summaryOf([group()], [
      healthCell({ success: 100, error: 0, requests: 100 }),
      healthCell({ error: 10, requests: 10, rateLimited: 3, clientCanceled: 4, upstreamError: 3 }),
    ])
    const series = cockpitRequestLogToHealthSeries(summary)
    expect(series.length).toBe(1)
    expect(series[0]!.normal_count).toBe(100)
    expect(series[0]!.rate_limited_count).toBe(3)
    // 10 次失败 − 3 限流 − 4 客户端取消 = 3 真正的错误
    expect(series[0]!.error_count).toBe(3)
    expect(series[0]!.sampled_at).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('多模型同桶:计数可加,不丢失任何一类', () => {
    const summary = summaryOf([group()], [
      healthCell({ success: 10, requests: 10 }),
      { ...healthCell({ error: 5, requests: 5, rateLimited: 2, upstreamError: 3 }), model: 'other-model' } as never,
    ])
    const series = cockpitRequestLogToHealthSeries(summary)
    expect(series[0]!.normal_count).toBe(10)
    expect(series[0]!.rate_limited_count).toBe(2)
    expect(series[0]!.error_count).toBe(3)
  })

  it('错误码趋势:429 单独计出并从"其他上游错误"中扣除,cockpit 无 402/529 维度则留 null(不是实测 0)', () => {
    const summary = summaryOf([group()], [
      healthCell({ error: 12, requests: 12, rateLimited: 5, upstreamError: 8, clientCanceled: 2 }),
    ])
    const trend = cockpitRequestLogToErrorTrend(summary)
    expect(trend.length).toBe(1)
    expect(trend[0]!.error_count_total).toBe(12)
    expect(trend[0]!.upstream_429_count).toBe(5)
    expect(trend[0]!.upstream_error_count_excl_429_529).toBe(3)
    // FIX 4:cockpit 日志没有 402/529 维度 —— null = "该源不测"(图表断点),
    // 用 0 会画成贴底实线,与真正实测到的 0 无法区分。
    expect(trend[0]!.upstream_402_count).toBeNull()
    expect(trend[0]!.upstream_529_count).toBeNull()
  })

  it('库不可用或无 cells 时返回空数组,不伪造一条全零曲线', () => {
    expect(cockpitRequestLogToHealthSeries(null)).toEqual([])
    expect(cockpitRequestLogToErrorTrend({ ...summaryOf([group()]), available: false })).toEqual([])
  })
})


describe('cockpit adapter: 成本"算不出来"时不得写哨兵 0(路由明细表成本列)', () => {
  const pricedSets = cockpitEffectivePriceSets(undefined)

  /** 最小 ModelRouteRow(只填回填会改到的字段)。 */
  function routeRow(model: string, accountId: number | string, requests: number) {
    return {
      key: `${model}|${accountId}`,
      requestedModel: model,
      upstreamModel: model,
      accountId,
      requests,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      standardCost: 0,
      accountCost: 0,
      revenue: 0,
      costBasis: undefined as string | undefined,
    } as never
  }

  it('单请求用量库:无单价且源无估算 ⇒ standardCost/accountCost 置 null,costUnknown 为 true', () => {
    const s = summaryOf([group({ accountId: 'acc-a', stdNormalInput: 1_000_000 })])
    // 空价目表 + group 无 estimatedCostUsd ⇒ cockpitSplitCostUsd 返回哨兵(cost=0,basis=no_price_no_estimate)
    const groupCost = cockpitRequestLogGroupCost(s, {}, 1)
    const [value] = [...groupCost.values()]
    expect(value!.costUnknown).toBe(true)
    expect(value!.cost).toBe(0)
    const id = [...groupCost.keys()][0]!.split('\u0000')[1]!
    const rows = [routeRow('gpt-6-astra', id, 1)]
    applyCockpitRequestLogCost(rows as never, groupCost)
    expect(rows[0]!.standardCost).toBeNull()
    expect(rows[0]!.accountCost).toBeNull()
    expect(rows[0]!.costUnknown).toBe(true)
    expect(rows[0]!.costBasis).toContain('成本未知')
  })

  it('同组内任一分量算不出来 ⇒ 整组标未知(取更差一侧,不被"有值"掩盖)', () => {
    const s = summaryOf([
      group({ accountId: 'acc-a', stdNormalInput: 1_000_000 }),                        // 无估算 ⇒ 未知
      group({ accountId: 'acc-a', stdNormalInput: 1_000_000, estimatedCostUsd: 0.5 }), // 有源估算 ⇒ 已知
    ])
    const groupCost = cockpitRequestLogGroupCost(s, {}, 1)
    expect(groupCost.size).toBe(1)
    const [value] = [...groupCost.values()]
    expect(value!.costUnknown).toBe(true)
  })

  it('成对:有价目 ⇒ costUnknown 为 false 且 standardCost 是数值(不误伤真实成本)', () => {
    const s = summaryOf([group({ accountId: 'acc-a', stdNormalInput: 1_000_000 })])
    const groupCost = cockpitRequestLogGroupCost(s, pricedSets, 1)
    const [value] = [...groupCost.values()]
    expect(value!.costUnknown).toBe(false)
    const id = [...groupCost.keys()][0]!.split('\u0000')[1]!
    const rows = [routeRow('gpt-6-astra', id, 1)]
    applyCockpitRequestLogCost(rows as never, groupCost)
    expect(rows[0]!.costUnknown).toBe(false)
    expect(rows[0]!.standardCost).toBeCloseTo(10, 9)
  })

  it('模型窗口均摊:哨兵 ⇒ 置 null;有源估算 ⇒ 用估算值且不标未知', () => {
    const routes: CockpitOpsRouteAgg[] = [
      { model: 'no-price-model', account_id: null, inbound_path: '/v1/responses', requests: 1, success_count: 1, error_count: 0, first_ms: 1, last_ms: 1 },
      { model: 'gpt-5', account_id: null, inbound_path: '/v1/responses', requests: 1, success_count: 1, error_count: 0, first_ms: 2, last_ms: 2 },
    ]
    const windowModels: CockpitModelUsage[] = [
      { modelId: 'no-price-model', usage: usage({ requestCount: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 0, estimatedCostUsd: 0 }) },
      { modelId: 'gpt-5', usage: usage({ requestCount: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 0, estimatedCostUsd: 0.5 }) },
    ]
    const { routes: rows } = cockpitOpsRoutesToModelRoutes(routes, [], windowModels, 1)
    expect(rows).toHaveLength(2)
    const unknownRow = rows.find((r) => r.requestedModel === 'no-price-model')!
    expect(unknownRow.costUnknown).toBe(true)
    expect(unknownRow.standardCost).toBeNull()
    expect(unknownRow.accountCost).toBeNull()
    const knownRow = rows.find((r) => r.requestedModel === 'gpt-5')!
    expect(knownRow.costUnknown).toBe(false)
    expect(knownRow.standardCost).toBeCloseTo(0.5, 9)
  })

  it('排序:成本未知的行排在有值行之后(不当 0 参与比较)', () => {
    // 未知行 requests=5 且先入表;对照行是「有单价但用量为 0」的**真实 0 成本**行(requests=1)。
    // 若把 null 当 0 比较,两行 accountCost 都是 0 ⇒ 靠 requests 决胜会把未知行排到前面。
    const routes: CockpitOpsRouteAgg[] = [
      { model: 'no-price-model', account_id: null, inbound_path: '/v1/responses', requests: 5, success_count: 5, error_count: 0, first_ms: 1, last_ms: 1 },
      { model: 'zero-cost-model', account_id: null, inbound_path: '/v1/responses', requests: 1, success_count: 1, error_count: 0, first_ms: 2, last_ms: 2 },
    ]
    const windowModels: CockpitModelUsage[] = [
      { modelId: 'no-price-model', usage: usage({ requestCount: 5, inputTokens: 500, outputTokens: 50, totalTokens: 550, cachedTokens: 0, estimatedCostUsd: 0 }) },
      { modelId: 'zero-cost-model', usage: usage({ requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }) },
    ]
    const pricing = { 'zero-cost-model': { input_price: 1e-6, output_price: 0, cache_read_price: 0 } } as never
    const { routes: rows } = cockpitOpsRoutesToModelRoutes(routes, [], windowModels, 1, pricing)
    expect(rows).toHaveLength(2)
    const unknownRow = rows.find((r) => r.requestedModel === 'no-price-model')!
    expect(unknownRow.costUnknown).toBe(true)
    expect(unknownRow.standardCost).toBeNull()
    const knownRow = rows.find((r) => r.requestedModel === 'zero-cost-model')!
    expect(knownRow.costUnknown).toBe(false)
    expect(knownRow.standardCost).toBe(0)
    expect(rows[rows.length - 1]).toBe(unknownRow)
  })
})
