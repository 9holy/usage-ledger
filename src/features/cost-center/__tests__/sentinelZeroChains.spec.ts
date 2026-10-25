import './costDataI18n'
/**
 * 哨兵 0 收尾轮:三条剩余链路的「算不出来 ≠ 实测 0」契约 —— 2026-09-21
 *
 * 背景:`costBasis.noPriceNoEstimateCost` 在「本项目没有该模型单价、数据源也没给估算」时返回
 * `{ cost: 0, basis: { kind: 'no_price_no_estimate' } }` —— **0 是哨兵,不是金额**。
 * 调用点写成 `const { cost } = ...` 就把 basis 标注丢了,哨兵 0 落进数值列,
 * 界面渲染成 `$0.000000` 并挂上「本地价目表自算单价」这类**假口径** —— 等于宣称"这个模型确实不花钱"。
 *
 * 本文件覆盖三条链路,**三个源都要查**(项目红线:给某源补守卫时必须回头检查另外两个源):
 *   W1 `ModelStat.cost`           → buildModelCostRows / summarizeModelCosts(模型成本表 + 汇总卡)
 *   W2 `CostTrendDataPoint.cost`  → 趋势桶(全桶未知 ⇒ null 断点;部分未知 ⇒ 保留下界 + source_estimate)
 *   W3 逐账号 `WindowStats.cost`   → AccountWindowUsage(cost/standard_cost/user_cost **三个一起** null)
 *
 * 每条断言都**成对**写:缺失 ⇒ null;真实 0 ⇒ 仍是 0(防过度修正,本项目曾因守卫过严误伤
 * `output_tokens === 0` 这类正常用例)。
 *
 * 排序断言刻意构造成**有判别力**:「未知行请求数更多且先入表」+「对照行是**真实 0 成本**」——
 * 若把 null 当 0 参与比较,两者恰好同序,稳定排序会让未知行留在前面,断言即失败。
 */
import { describe, expect, it } from 'vitest'
import {
  cockpitEffectiveModelPricing,
  cockpitModelsToModelStats,
  cockpitRequestLogToAccountStats,
  cockpitRequestLogToApiKeyStats,
  cockpitRequestLogToCostTrend,
  cockpitRequestLogToModelStats,
  cockpitWindowToAccountStats,
  cockpitWindowsToCostTrend,
} from '../cockpitAdapter'
import {
  authIndexToAccountId,
  cliproxyEventsToModelStats,
  cliproxyEventsToTodayStats,
  cliproxyEventsToTrend,
} from '../cliproxyAdapter'
import { aggregateModelStatsFromUsageLogs, buildModelCostRows, summarizeModelCosts } from '../modelCostAnalysis'
import { standardReferenceCost, summarizeAccountReferenceCost, sumAccountCostUsd, sumAccountTokens, sumAccountUserCost } from '../model'
import { fillCostTrendBuckets, TREND_BUCKET_MILLISECONDS, type CostTrendDataPoint } from '../usageWindow'
import { cockpitEffectivePriceSets, type CockpitModelPriceSet } from '../cockpitPriceBook'
import type {
  CockpitModelUsage,
  CockpitRequestLogCell,
  CockpitRequestLogGroup,
  CockpitRequestLogSummary,
  CockpitStatsWindow,
  CockpitUsageStats,
} from '../../../api/cockpit'
import type { CliproxyUsageEvent, LitellmPricing } from '../../../api/cliproxy/cpaData'
import type { ModelStat } from '../../../types'

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

const SETS = cockpitEffectivePriceSets(undefined)
const PRICINGS = cockpitEffectiveModelPricing(undefined)

/** 内置价目表里**没有**的模型名 ⇒ 本项目无单价;配合 estimatedCostUsd = 0 ⇒ 源也没给估算。 */
const UNKNOWN_MODEL = 'zzz-model-not-in-price-book'

/** 单价全 0 的价目:模型**有**单价(basis = priced),只是算出来恰好 $0 —— 这是**真实 0**,不是哨兵。 */
const ZERO_PRICE_SET: CockpitModelPriceSet = {
  standard: { input: 0, output: 0, cache: 0 },
  sessionLongContext: false,
  origin: 'book',
}

function usage(overrides: Partial<CockpitUsageStats> = {}): CockpitUsageStats {
  return {
    requestCount: 1,
    successCount: 1,
    failureCount: 0,
    clientCanceledCount: 0,
    upstreamResponseFailedCount: 0,
    streamIncompleteCount: 0,
    totalLatencyMs: 100,
    textRequestCount: 1,
    imageRequestCount: 0,
    imageGenerationRequestCount: 0,
    imageEditRequestCount: 0,
    imageGenerationCapabilityFailureCount: 0,
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    cachedTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  }
}

function modelUsage(modelId: string, overrides: Partial<CockpitUsageStats> = {}): CockpitModelUsage {
  return { modelId, usage: usage(overrides), updatedAt: 1_700_000_000_000 }
}

function statsWindow(
  models: CockpitModelUsage[],
  accounts: Array<{ accountId: string; usage: CockpitUsageStats }> = [],
): CockpitStatsWindow {
  return {
    since: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    totals: usage(),
    accounts,
    models,
  }
}

/** 一条 (模型×账号×key×档位) 聚合。token 分档默认 0。 */
function group(overrides: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return {
    model: 'gpt-6-astra',
    accountId: 'codex_abc',
    apiKeyId: '',
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
    serviceTier: '',
    ...overrides,
  }
}

function cell(overrides: Partial<CockpitRequestLogCell> = {}): CockpitRequestLogCell {
  return { startMs: 1_700_000_000_000, model: 'gpt-6-astra', ...group(), ...overrides }
}

function summaryOf(
  groups: CockpitRequestLogGroup[],
  cells: CockpitRequestLogCell[] = [],
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
    bucketLatencies: [],
  }
}

const CLIPROXY_MODEL = 'gpt-5.6-terra'
const CLIPROXY_UNPRICED_MODEL = 'zzz-unpriced-cpa-model'
const CLIPROXY_PRICES: Record<string, LitellmPricing> = {
  [CLIPROXY_MODEL]: { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
}
/** 单价存在但全是 0 ⇒ 算出来恰好 $0(真实 0),不是"算不出"。 */
const CLIPROXY_ZERO_PRICES: Record<string, LitellmPricing> = {
  [CLIPROXY_MODEL]: { input_cost_per_token: 0, output_cost_per_token: 0 },
}

function cliproxyEvent(overrides: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1,
    requested_at: 1_700_000_000_000,
    provider: 'openai',
    executor_type: 'codex',
    model: CLIPROXY_MODEL,
    alias: CLIPROXY_MODEL,
    auth_index: 'auth-a',
    auth_type: 'api_key',
    source: 'test',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    primary_used_percent: null,
    primary_reset_at: null,
    primary_used_tokens: null,
    primary_remaining_tokens: null,
    primary_limit_tokens: null,
    secondary_used_percent: null,
    secondary_reset_at: null,
    secondary_used_tokens: null,
    secondary_remaining_tokens: null,
    secondary_limit_tokens: null,
    ...overrides,
  }
}

/** 最小 ModelStat(只填排序/传播会读到的字段)。 */
function modelStat(overrides: Partial<ModelStat>): ModelStat {
  return {
    model: 'm',
    requests: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: null,
    cache_read_tokens: 0,
    total_tokens: 0,
    cost: 0,
    actual_cost: null,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* W1 · ModelStat.cost                                                        */
/* -------------------------------------------------------------------------- */

describe('W1 ModelStat.cost:哨兵 0 不再写进数值列', () => {
  it('cockpit stats 快照:本项目无单价 + 数据源无估算 ⇒ cost = null,并一路传到汇总卡', () => {
    const stats = cockpitModelsToModelStats(statsWindow([modelUsage(UNKNOWN_MODEL)]), 1)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.cost).toBeNull()
    expect(stats[0]!.cost).not.toBe(0)

    const rows = buildModelCostRows(stats)
    expect(rows[0]!.standardCost).toBeNull()
    expect(rows[0]!.accountCost).toBeNull()
    expect(rows[0]!.costUnknown).toBe(true)

    const summary = summarizeModelCosts(rows)
    expect(summary.costMissing).toBe(true)
    expect(summary.standardCost).toBeNull()
    expect(summary.accountCost).toBeNull()
  })

  it('成对反例:有本地单价 ⇒ cost 是数字,且不标未知(哨兵 0 未误伤正常计价)', () => {
    const stats = cockpitModelsToModelStats(statsWindow([modelUsage('gpt-6-astra')]), 1, PRICINGS)
    expect(stats[0]!.cost).toBeGreaterThan(0)
    const rows = buildModelCostRows(stats)
    expect(rows[0]!.standardCost).toBeGreaterThan(0)
    expect(rows[0]!.costUnknown).toBe(false)
    expect(summarizeModelCosts(rows).costMissing).toBe(false)
    expect(summarizeModelCosts(rows).standardCost).toBeGreaterThan(0)
  })

  it('cockpit 单请求用量库:无单价无估算 ⇒ cost = null;有单价 ⇒ 数字', () => {
    const unknown = cockpitRequestLogToModelStats(
      summaryOf([group({ model: UNKNOWN_MODEL, stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    expect(unknown[0]!.cost).toBeNull()

    const priced = cockpitRequestLogToModelStats(summaryOf([group({ stdNormalInput: 1_000_000 })]), SETS, 1)
    expect(priced[0]!.cost).toBeCloseTo(10, 9)
  })

  it('成对反例:单价存在但为 0 ⇒ cost 仍是真实 0(不是 null)', () => {
    const zero = cockpitRequestLogToModelStats(
      summaryOf([group({ stdNormalInput: 1_000_000 })]),
      { 'gpt-6-astra': ZERO_PRICE_SET },
      1,
    )
    expect(zero[0]!.cost).toBe(0)
    expect(zero[0]!.cost).not.toBeNull()
    expect(buildModelCostRows(zero)[0]!.costUnknown).toBe(false)
  })

  it('cliproxy:无匹配单价 ⇒ cost = null;有单价 ⇒ 数字;单价为 0 ⇒ 真实 0', () => {
    // 2026-09-23:cliproxyEventsToModelStats 起按 range 半开区间过滤,
    // 夹具必须落在窗口内(默认的 1_700_000_000_000 已远在窗口外,会被裁成空表)。
    const now = Date.now() - 60_000
    const unknown = cliproxyEventsToModelStats(
      [cliproxyEvent({ requested_at: now, model: CLIPROXY_UNPRICED_MODEL, input_tokens: 100, total_tokens: 100 })],
      CLIPROXY_PRICES,
      '1h',
      1,
    )
    expect(unknown[0]!.cost).toBeNull()

    // 倍率显式传 1,断言才与"单价 × token"一一对应(不传会走 DEFAULT_COST_MULTIPLIER = 0.7)。
    const priced = cliproxyEventsToModelStats(
      [cliproxyEvent({ requested_at: now, input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      CLIPROXY_PRICES,
      '1h',
      1,
    )
    expect(priced[0]!.cost).toBeCloseTo(2, 9)

    const zero = cliproxyEventsToModelStats(
      [cliproxyEvent({ requested_at: now, input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      CLIPROXY_ZERO_PRICES,
      '1h',
      1,
    )
    expect(zero[0]!.cost).toBe(0)
    expect(zero[0]!.cost).not.toBeNull()
  })

  it('cliproxy:同一模型部分请求无单价 ⇒ 整模型标未知(cost = null)', () => {
    const now = Date.now() - 60_000
    const mixed = cliproxyEventsToModelStats(
      [
        cliproxyEvent({ requested_at: now, input_tokens: 1_000_000, total_tokens: 1_000_000 }),
        cliproxyEvent({ requested_at: now, model: CLIPROXY_UNPRICED_MODEL, input_tokens: 100, total_tokens: 100 }),
      ],
      CLIPROXY_PRICES,
      '1h',
      1,
    )
    // 两个模型各一行:有价的仍是数字,无价的 null —— 未知不掩盖已知,也不被已知掩盖。
    const byModel = new Map(mixed.map((m) => [m.model, m.cost]))
    expect(byModel.get(CLIPROXY_MODEL)).toBeCloseTo(2, 9)
    expect(byModel.get(CLIPROXY_UNPRICED_MODEL)).toBeNull()
  })

  it('cockpit 模型表排序:未知成本的行排最后(未知行请求数更多且先入表 + 对照行是真实 0 成本)', () => {
    const stats = cockpitRequestLogToModelStats(
      summaryOf([
        group({ model: UNKNOWN_MODEL, requests: 99, stdNormalInput: 1_000_000 }),
        group({ model: 'gpt-6-astra', requests: 1, stdNormalInput: 1_000_000 }),
      ]),
      { 'gpt-6-astra': ZERO_PRICE_SET },
      1,
    )
    expect(stats.map((r) => r.model)).toEqual(['gpt-6-astra', UNKNOWN_MODEL])
    expect(stats[0]!.cost).toBe(0)
    expect(stats[1]!.cost).toBeNull()
  })

  it('buildModelCostRows 排序:未知账号成本的行排最后(null 不当 0 参与比较)', () => {
    const rows = buildModelCostRows([
      modelStat({ model: 'unknown', requests: 99, cost: null, account_cost: null }),
      modelStat({ model: 'zero', requests: 1, cost: 0, account_cost: 0 }),
    ])
    expect(rows.map((r) => r.model)).toEqual(['zero', 'unknown'])
    expect(rows[0]!.accountCost).toBe(0)
    expect(rows[1]!.accountCost).toBeNull()
  })

  it('aggregateModelStatsFromUsageLogs:成本 null 传播(任一分量未知 ⇒ 合计未知),真实 0 仍是 0', () => {
    const base = { model: 'm', created_at: '2026-01-01T00:00:00Z' }
    const missing = aggregateModelStatsFromUsageLogs(
      [{ ...base, total_cost: null, account_stats_cost: null } as never],
      'requested',
    )
    expect(missing[0]!.cost).toBeNull()
    expect(missing[0]!.account_cost).toBeNull()

    const zero = aggregateModelStatsFromUsageLogs(
      [{ ...base, total_cost: 0, account_stats_cost: 0 } as never],
      'requested',
    )
    expect(zero[0]!.cost).toBe(0)
    expect(zero[0]!.account_cost).toBe(0)

    const mixed = aggregateModelStatsFromUsageLogs(
      [
        { ...base, total_cost: 1, account_stats_cost: 1 },
        { ...base, total_cost: null, account_stats_cost: null },
      ] as never,
      'requested',
    )
    expect(mixed[0]!.cost).toBeNull()
    expect(mixed[0]!.account_cost).toBeNull()
  })

  it('aggregateModelStatsFromUsageLogs 排序:账号成本未知的行排最后(未知行请求数更多且先入表)', () => {
    const rows = aggregateModelStatsFromUsageLogs(
      [
        { model: 'unknown', created_at: '2026-01-01T00:00:00Z', total_cost: null, account_stats_cost: null },
        { model: 'unknown', created_at: '2026-01-01T00:01:00Z', total_cost: null, account_stats_cost: null },
        { model: 'zero', created_at: '2026-01-01T00:02:00Z', total_cost: 0, account_stats_cost: 0 },
      ] as never,
      'requested',
    )
    expect(rows.map((r) => r.model)).toEqual(['zero', 'unknown'])
  })
})

/* -------------------------------------------------------------------------- */
/* W2 · CostTrendDataPoint.cost                                               */
/* -------------------------------------------------------------------------- */

describe('W2 CostTrendDataPoint.cost:全桶未知 ⇒ 断点,部分未知 ⇒ 保留下界', () => {
  it('cockpit 单请求用量库:桶内全部模型无单价 ⇒ 三个成本字段 null + costBasis = no_price_no_estimate', () => {
    const trend = cockpitRequestLogToCostTrend(
      summaryOf([], [cell({ model: UNKNOWN_MODEL, stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    expect(trend).toHaveLength(1)
    expect(trend[0]!.cost).toBeNull()
    expect(trend[0]!.actual_cost).toBeNull()
    expect(trend[0]!.account_cost).toBeNull()
    expect(trend[0]!.costBasis).toBe('no_price_no_estimate')
  })

  it('cockpit:桶内部分模型无单价 ⇒ 保留求和值(真实下界,不误伤)+ costBasis = source_estimate', () => {
    const trend = cockpitRequestLogToCostTrend(
      summaryOf([], [
        cell({ model: 'gpt-6-astra', stdNormalInput: 1_000_000 }), // $10
        cell({ model: UNKNOWN_MODEL, stdNormalInput: 1_000_000 }), // 算不出
      ]),
      SETS,
      1,
    )
    expect(trend[0]!.cost).toBeCloseTo(10, 9)
    expect(trend[0]!.cost).not.toBeNull()
    expect(trend[0]!.costBasis).toBe('source_estimate')
  })

  it('cockpit:桶内全部有单价 ⇒ 数值 + costBasis 省略(不标下界)', () => {
    const trend = cockpitRequestLogToCostTrend(
      summaryOf([], [cell({ model: 'gpt-6-astra', stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    expect(trend[0]!.cost).toBeCloseTo(10, 9)
    expect(trend[0]!.costBasis).toBeUndefined()
  })

  it('cockpit 窗口快照:算不出来 ⇒ 三个成本字段 null(不是窗口累计 0)', () => {
    // cockpitWindowsToCostTrend 收的是 CockpitStats(内含 daily/weekly/monthly 快照),
    // 不是单个窗口 —— 7d 会取 weekly(缺失时回退 monthly/daily)。
    const stats = {
      ...statsWindow([modelUsage(UNKNOWN_MODEL)]),
      weekly: statsWindow([modelUsage(UNKNOWN_MODEL)]),
    }
    const trend = cockpitWindowsToCostTrend(stats, 1, '7d')
    expect(trend).toHaveLength(1)
    expect(trend[0]!.cost).toBeNull()
    expect(trend[0]!.actual_cost).toBeNull()
    expect(trend[0]!.account_cost).toBeNull()
    expect(trend[0]!.costBasis).toBe('no_price_no_estimate')
  })

  it('cockpit 窗口快照:窗口内部分模型无单价 ⇒ 保留下界 + costBasis = source_estimate', () => {
    // 窗口里 astra 有内置单价、UNKNOWN_MODEL 没有 ⇒ 混合单价被无价模型的 token 摊薄,
    // 结果是**真实下界**(> 0),必须保留但不得标"已计价"。
    const stats = {
      ...statsWindow([modelUsage('gpt-6-astra'), modelUsage(UNKNOWN_MODEL)]),
      weekly: statsWindow([modelUsage('gpt-6-astra'), modelUsage(UNKNOWN_MODEL)]),
    }
    const trend = cockpitWindowsToCostTrend(stats, 1, '7d', PRICINGS)
    expect(trend).toHaveLength(1)
    // astra 自算 $10,但混合单价分母含无价模型的 1e6 token ⇒ 下界约为一半。
    expect(trend[0]!.cost).toBeGreaterThan(0)
    expect(trend[0]!.cost).toBeLessThan(10)
    expect(trend[0]!.costBasis).toBe('source_estimate')
  })

  it('cliproxy:无匹配单价 ⇒ 三个成本字段 null;有单价 ⇒ 数字 + 不标下界', () => {
    const now = Date.now()
    const unknown = cliproxyEventsToTrend(
      [cliproxyEvent({ model: CLIPROXY_UNPRICED_MODEL, requested_at: now - 60_000, input_tokens: 100, total_tokens: 100 })],
      CLIPROXY_PRICES,
      '1h',
      1,
    )
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.cost).toBeNull()
    expect(unknown[0]!.actual_cost).toBeNull()
    expect(unknown[0]!.account_cost).toBeNull()
    expect(unknown[0]!.costBasis).toBe('no_price_no_estimate')

    const priced = cliproxyEventsToTrend(
      [cliproxyEvent({ requested_at: now - 60_000, input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      CLIPROXY_PRICES,
      '1h',
      1,
    )
    expect(priced[0]!.cost).toBeCloseTo(2, 9)
    expect(priced[0]!.costBasis).toBeUndefined()
  })

  it('cliproxy:同桶部分无单价 ⇒ 保留下界 + costBasis = source_estimate', () => {
    const now = Date.now()
    const mixed = cliproxyEventsToTrend(
      [
        cliproxyEvent({ requested_at: now - 60_000, input_tokens: 1_000_000, total_tokens: 1_000_000 }),
        cliproxyEvent({ model: CLIPROXY_UNPRICED_MODEL, requested_at: now - 60_000, input_tokens: 100, total_tokens: 100 }),
      ],
      CLIPROXY_PRICES,
      '1h',
      1,
    )
    expect(mixed).toHaveLength(1)
    expect(mixed[0]!.cost).toBeCloseTo(2, 9)
    expect(mixed[0]!.costBasis).toBe('source_estimate')
  })

  it('fillCostTrendBuckets:同桶合并时 basis 取更差一侧,且 null 参与传播(不用 0 补齐)', () => {
    const bucketMs = TREND_BUCKET_MILLISECONDS['1h']
    // start/end 必须**落在桶边界上**,否则 fillCostTrendBuckets 会补齐首尾两个桶
    // (firstBucket = floor(start) 与 lastBucket = floor(end-1) 不同桶),点数就不是 1 了。
    const start = new Date(Math.floor(1_700_000_000_000 / bucketMs) * bucketMs)
    const end = new Date(start.getTime() + bucketMs)
    const pricedPoint: CostTrendDataPoint = {
      date: start.toISOString(),
      requests: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost: 1.5,
      actual_cost: 1.5,
      account_cost: 1.5,
    }
    const unknownPoint: CostTrendDataPoint = {
      ...pricedPoint,
      date: new Date(start.getTime() + 1_000).toISOString(),
      cost: null,
      actual_cost: null,
      account_cost: null,
      costBasis: 'no_price_no_estimate',
    }

    const merged = fillCostTrendBuckets([pricedPoint, unknownPoint], '1h', start, end)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.cost).toBeNull()
    expect(merged[0]!.actual_cost).toBeNull()
    expect(merged[0]!.account_cost).toBeNull()
    expect(merged[0]!.costBasis).toBe('no_price_no_estimate')

    // 成对反例:同桶全是已计价点 ⇒ 合计仍是数字,basis 保持未标注。
    const pricedOnly = fillCostTrendBuckets([pricedPoint], '1h', start, end)
    expect(pricedOnly[0]!.cost).toBe(1.5)
    expect(pricedOnly[0]!.costBasis).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* W3 · 逐账号 WindowStats.cost                                                */
/* -------------------------------------------------------------------------- */

describe('W3 逐账号成本:算不出来时三个成本字段一起 null', () => {
  it('cockpit 单请求用量库:无单价无估算 ⇒ cost/standard_cost/user_cost 三个一起 null', () => {
    const stats = cockpitRequestLogToAccountStats(
      summaryOf([group({ model: UNKNOWN_MODEL, stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    const row = Object.values(stats)[0]!
    expect(row.cost).toBeNull()
    expect(row.standard_cost).toBeNull()
    expect(row.user_cost).toBeNull()
    // 请求数/Token 是实测值,照常给出。
    expect(row.requests).toBe(1)
    expect(row.tokens).toBe(1_000_000)
  })

  it('成对反例:有单价 ⇒ 保留成本与参考价，但不能冒充用户收入', () => {
    const stats = cockpitRequestLogToAccountStats(summaryOf([group({ stdNormalInput: 1_000_000 })]), SETS, 1)
    const row = Object.values(stats)[0]!
    expect(row.cost).toBeCloseTo(10, 9)
    expect(row.standard_cost).toBeCloseTo(10, 9)
    expect(standardReferenceCost(row)).toBeCloseTo(10, 9)
    expect(row.user_cost).toBeNull()
  })

  it('成对反例:单价为 0 ⇒ 仍是真实 0(不是 null)', () => {
    const stats = cockpitRequestLogToAccountStats(
      summaryOf([group({ stdNormalInput: 1_000_000 })]),
      { 'gpt-6-astra': ZERO_PRICE_SET },
      1,
    )
    const row = Object.values(stats)[0]!
    expect(row.cost).toBe(0)
    expect(row.cost).not.toBeNull()
  })

  it('cockpit 快照:窗口无可用混合单价 + 源无估算 ⇒ 三个字段一起 null;有单价 ⇒ 数字', () => {
    // 模型**带 token**(1e6)但价目表里没有它 —— 这是"有用量、没单价"的形态。
    // 若模型 token 为 0,混合单价函数会因"无用量"返 null 而侥幸走到同一分支,
    // 那样这条断言就没验到"无价"这条路径(等于没验)。
    const unknown = Object.values(cockpitWindowToAccountStats(
      statsWindow([modelUsage(UNKNOWN_MODEL)], [{ accountId: 'codex_abc', usage: usage() }]),
      1,
    ))[0]!
    expect(unknown.cost).toBeNull()
    expect(unknown.standard_cost).toBeNull()
    expect(unknown.user_cost).toBeNull()
    // 请求数/Token 是实测值,照常给出(只有成本未知)。
    expect(unknown.requests).toBe(1)
    expect(unknown.tokens).toBe(1_000_000)

    const priced = Object.values(cockpitWindowToAccountStats(
      statsWindow([modelUsage('gpt-6-astra')], [{ accountId: 'codex_abc', usage: usage() }]),
      1,
      PRICINGS,
    ))[0]!
    expect(priced.cost).toBeGreaterThan(0)
    expect(priced.standard_cost).toBe(priced.cost)
    expect(standardReferenceCost(priced)).toBe(priced.cost)
    expect(priced.user_cost).toBeNull()
  })

  it('cockpit 本地密钥:算不出 ⇒ cost = null;有单价 ⇒ 数字', () => {
    const unknown = cockpitRequestLogToApiKeyStats(
      summaryOf([group({ model: UNKNOWN_MODEL, apiKeyId: 'key-1', stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    expect(unknown['key-1']!.cost).toBeNull()

    const priced = cockpitRequestLogToApiKeyStats(
      summaryOf([group({ apiKeyId: 'key-1', stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    expect(priced['key-1']!.cost).toBeCloseTo(10, 9)
  })

  it('cliproxy 今日账号用量:无匹配单价 ⇒ 三个字段一起 null;有单价 ⇒ 数字;单价 0 ⇒ 真实 0', () => {
    const now = Date.now()
    const window = { start: new Date(now - 3_600_000), end: new Date(now + 1_000) }
    const id = String(authIndexToAccountId('auth-a'))

    const unknown = cliproxyEventsToTodayStats(
      [cliproxyEvent({ requested_at: now - 60_000, model: CLIPROXY_UNPRICED_MODEL, input_tokens: 100, total_tokens: 100 })],
      CLIPROXY_PRICES,
      1,
      window,
    )[id]!
    expect(unknown.cost).toBeNull()
    expect(unknown.standard_cost).toBeNull()
    expect(unknown.user_cost).toBeNull()
    expect(unknown.requests).toBe(1)

    const pricedEvents = [cliproxyEvent({ requested_at: now - 60_000, input_tokens: 1_000_000, total_tokens: 1_000_000 })]
    const priced = cliproxyEventsToTodayStats(pricedEvents, CLIPROXY_PRICES, 1, window)[id]!
    expect(priced.cost).toBeCloseTo(2, 9)
    expect(priced.standard_cost).toBeCloseTo(2, 9)
    expect(standardReferenceCost(priced)).toBeCloseTo(2, 9)
    expect(priced.user_cost).toBeNull()

    const zero = cliproxyEventsToTodayStats(pricedEvents, CLIPROXY_ZERO_PRICES, 1, window)[id]!
    expect(zero.cost).toBe(0)
    expect(zero.cost).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* W4 · 逐账号 → 号池聚合(2026-09-22)                                          */
/* -------------------------------------------------------------------------- */

/**
 * 上一跳(W3)已保证「逐账号成本算不出来 ⇒ `cost`/`standard_cost`/`user_cost` 三个一起 `null`」。
 * 这一跳验的是**聚合处不许把它折回 0**:视图层此前写的是
 * `rows.reduce((sum, row) => sum + (row.today ? actualUserCost(row.today) ?? 0 : 0), 0)`,
 * 一个账号不可测 ⇒ 界面显示的是**其余账号之和**,挂在绿色实测态上,
 * 看不出少了谁、也看不出这是个偏小的数(`actualUserCost` 的契约要求调用方走「无数据」分支)。
 *
 * 成对写(本文件一贯口径):
 * - 成本字段不可测 ⇒ 聚合 `null`;而**同一行的 Token 是实测值** ⇒ 聚合照常给出,不许被连坐;
 * - 该账号本窗口**无记录** ⇒ 计 0(真实测量值),不影响其余账号求和;
 * - 单价为 0 ⇒ 成本与参考价为真实 0；只有显式用户计费为 0 时收入聚合才为 0。
 */
describe('W4 逐账号 → 号池聚合:任一行不可测 ⇒ 合计不可测', () => {
  /** 真实链路:cockpit 单请求用量库 + 无单价无估算 ⇒ 三个成本字段一起 null,tokens 仍是实测。 */
  function unmeasurableToday() {
    const stats = cockpitRequestLogToAccountStats(
      summaryOf([group({ model: UNKNOWN_MODEL, stdNormalInput: 1_000_000 })]),
      SETS,
      1,
    )
    return Object.values(stats)[0]!
  }
  /** 参考价来自本地用量；收入聚合另给显式用户计费夹具，不从参考价推定。 */
  function pricedToday() {
    const stats = cockpitRequestLogToAccountStats(summaryOf([group({ stdNormalInput: 1_000_000 })]), SETS, 1)
    return { ...Object.values(stats)[0]!, user_cost: 10 }
  }

  it('单个账号不可测 ⇒ 产出/成本聚合为 null;同行的 Token 是实测,照常给出', () => {
    const row = unmeasurableToday()
    expect(row.cost).toBeNull()
    expect(sumAccountUserCost([{ today: row }])).toBeNull()
    expect(sumAccountCostUsd([{ today: row }])).toBeNull()
    expect(sumAccountTokens([{ today: row }])).toBe(1_000_000)
  })

  it('★ 不可测的行混在可测行之间 ⇒ 整体 null,而不是「可测行的和」', () => {
    const priced = pricedToday()
    const unknown = unmeasurableToday()
    const onlyMeasurable = sumAccountUserCost([{ today: priced }])
    expect(onlyMeasurable).toBeCloseTo(10, 9)

    const mixed = sumAccountUserCost([{ today: priced }, { today: unknown }])
    expect(mixed).toBeNull()
    // 判别力:修复前这里恰好是「可测行的和」—— 所以这一条要**明确否掉那个值**。
    expect(mixed).not.toBe(onlyMeasurable)
  })

  it('成对反例:该账号本窗口无记录 ⇒ 计 0(真实测量值),不影响其余账号求和', () => {
    const priced = pricedToday()
    expect(sumAccountUserCost([{ today: null }, { today: priced }])).toBeCloseTo(10, 9)
    expect(sumAccountCostUsd([{ today: null }, { today: priced }])).toBeCloseTo(10, 9)
  })

  it('成对反例:单价为 0 ⇒ 聚合是真实 0(不是 null)', () => {
    const now = Date.now()
    const window = { start: new Date(now - 3_600_000), end: new Date(now + 1_000) }
    const id = String(authIndexToAccountId('auth-a'))
    const zero = cliproxyEventsToTodayStats(
      [cliproxyEvent({ requested_at: now - 60_000, input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      CLIPROXY_ZERO_PRICES,
      1,
      window,
    )[id]!
    expect(zero.cost).toBe(0)
    expect(sumAccountCostUsd([{ today: zero }])).toBe(0)
    expect(summarizeAccountReferenceCost([{ today: zero }]).total).toBe(0)
    expect(sumAccountUserCost([{ today: zero }])).toBeNull()
    expect(sumAccountUserCost([{ today: { ...zero, user_cost: 0 } }])).toBe(0)
  })
})
