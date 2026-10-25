/**
 * ⑤ cockpit `economics.series[].billed_usd_per_hour` 假零 —— 2026-09-21
 *
 * `cockpitStatsToEconomics` 有两条 series 路径,都把哨兵 0 当金额:
 *   (a) 单请求用量库路径:`cur.cost += cockpitSplitCostUsd(...).cost`(丢掉 basis)→ `perHour = cost / bucketHours`;
 *   (b) 快照路径:`cockpitAggregateCostUsd(...).cost`(**未判 costBasis**)→ `wBilledPerHour`。
 * 实测无单价时 series = `[0,0,0]` —— 数值列里的 0 会被读成「该窗口实测每小时零产出」。
 *
 * 当前 series 的唯一消费点读的是 `projection.capacity_adjusted_billed_usd_per_hour`(恒 null),
 * 所以这不是"当前可见"的假零,但它与 ①②③ 是同一类形态,按同一规则修:**算不出 ⇒ null**。
 *
 * 断言成对:算不出 ⇒ null;真实值 ⇒ 数字(不误伤)。
 */
import { describe, expect, it } from 'vitest'
import {
  cockpitEffectiveModelPricing,
  cockpitRequestLogToCostTrend,
  cockpitStatsToEconomics,
} from '../cockpitAdapter'
import { cockpitEffectivePriceSets } from '../cockpitPriceBook'
import type {
  CockpitModelUsage,
  CockpitRequestLogCell,
  CockpitRequestLogGroup,
  CockpitRequestLogSummary,
  CockpitStats,
  CockpitStatsWindow,
  CockpitUsageStats,
} from '../../../api/cockpit'

const SETS = cockpitEffectivePriceSets(undefined)
const PRICINGS = cockpitEffectiveModelPricing(undefined)

/** 内置价目表里**没有**的模型名 ⇒ 本项目无单价。 */
const UNKNOWN_MODEL = 'zzz-model-not-in-price-book'
const PRICED_MODEL = 'gpt-6-astra'

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

function group(overrides: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return {
    model: PRICED_MODEL,
    accountId: 'codex_abc',
    apiKeyId: '',
    firstMs: 1_700_000_000_000,
    lastMs: 1_700_000_060_000,
    requests: 1,
    success: 1,
    error: 0,
    stdNormalInput: 1_000_000,
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
  return { startMs: 1_700_000_000_000, ...group(), ...overrides }
}

function summaryOf(cells: CockpitRequestLogCell[]): CockpitRequestLogSummary {
  return {
    available: true,
    reason: null,
    rowCount: cells.reduce((s, c) => s + c.requests, 0),
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_060_000,
    bucketHours: 1,
    cells,
    groups: [],
    bucketLatencies: [],
  } as unknown as CockpitRequestLogSummary
}

/** 最小 CockpitStats:accounts 非空(否则函数早退),daily 快照带模型聚合。 */
function statsFixture(dailyModels: CockpitModelUsage[]): CockpitStats {
  const now = Date.now()
  const totals = usage()
  const accounts = [{ accountId: 'codex_abc', usage: usage() }]
  const daily: CockpitStatsWindow = {
    since: now - 3_600_000,
    updatedAt: now,
    totals,
    accounts,
    models: dailyModels,
  }
  return {
    since: now - 3_600_000,
    updatedAt: now,
    totals,
    accounts,
    models: [],
    apiKeys: [],
    daily,
    weekly: null,
    monthly: null,
  } as unknown as CockpitStats
}

describe('⑤ cockpit economics.series 快照路径:算不出来 ⇒ billed_usd_per_hour = null', () => {
  it('窗口内模型全无单价 ⇒ 该 series 点的两个每小时成本都是 null(不是 0)', () => {
    const snapshot = cockpitStatsToEconomics(
      statsFixture([modelUsage(UNKNOWN_MODEL)]),
      '1h', 7.2, undefined, 1, undefined, null, {},
    )
    expect(snapshot).not.toBeNull()
    expect(snapshot!.series).toHaveLength(1)
    expect(snapshot!.series[0]!.billed_usd_per_hour).toBeNull()
    expect(snapshot!.series[0]!.billed_usd_per_hour).not.toBe(0)
    expect(snapshot!.series[0]!.account_cost_usd_per_hour).toBeNull()
    // 成对:健康计数是实测值,照常给出
    expect(snapshot!.series[0]!.normal_count).toBe(1)
  })

  it('成对:模型有单价 ⇒ 两个每小时成本都是数字(不误伤真实值)', () => {
    const snapshot = cockpitStatsToEconomics(
      statsFixture([modelUsage(PRICED_MODEL)]),
      '1h', 7.2, undefined, 1, PRICINGS, null, {},
    )
    expect(snapshot!.series).toHaveLength(1)
    const perHour = snapshot!.series[0]!.billed_usd_per_hour
    expect(perHour).not.toBeNull()
    expect(perHour as number).toBeGreaterThan(0)
    expect(snapshot!.series[0]!.account_cost_usd_per_hour).toBe(perHour)
  })
})

describe('⑤ cockpit economics.series 用量库路径:算不出来 ⇒ billed_usd_per_hour = null', () => {
  it('桶内全部 cell 无单价 ⇒ 该桶 null;有单价的 cell 照常出数字', () => {
    const unknown = cockpitStatsToEconomics(
      statsFixture([]),
      '1h', 7.2, undefined, 1, undefined, summaryOf([cell({ model: UNKNOWN_MODEL })]), SETS,
    )
    expect(unknown!.series).toHaveLength(1)
    expect(unknown!.series[0]!.billed_usd_per_hour).toBeNull()
    expect(unknown!.series[0]!.billed_usd_per_hour).not.toBe(0)

    const priced = cockpitStatsToEconomics(
      statsFixture([]),
      '1h', 7.2, undefined, 1, undefined, summaryOf([cell({ model: PRICED_MODEL })]), SETS,
    )
    const perHour = priced!.series[0]!.billed_usd_per_hour
    expect(perHour).not.toBeNull()
    expect(perHour as number).toBeGreaterThan(0)
  })

  it('同桶部分 cell 无单价 ⇒ 保留求和值(真实下界,不是 null 也不是 0)', () => {
    // 先确认这一桶确实有已计价的部分,否则这条断言等于没验到"部分"这条路径。
    const rlTrend = cockpitRequestLogToCostTrend(
      summaryOf([
        cell({ model: PRICED_MODEL, startMs: 1_700_000_000_000 }),
        cell({ model: UNKNOWN_MODEL, startMs: 1_700_000_000_000 }),
      ]),
      SETS, 1,
    )
    expect(rlTrend[0]!.cost).not.toBeNull()

    const snapshot = cockpitStatsToEconomics(
      statsFixture([]),
      '1h', 7.2, undefined, 1, undefined,
      summaryOf([
        cell({ model: PRICED_MODEL, startMs: 1_700_000_000_000 }),
        cell({ model: UNKNOWN_MODEL, startMs: 1_700_000_000_000 }),
      ]),
      SETS,
    )
    expect(snapshot!.series).toHaveLength(1)
    const perHour = snapshot!.series[0]!.billed_usd_per_hour
    expect(perHour).not.toBeNull()
    expect(perHour as number).toBeGreaterThan(0)
  })
})
