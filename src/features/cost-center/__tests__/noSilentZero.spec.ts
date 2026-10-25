import './costDataI18n'
/**
 * 消除"静默变 0" 集成单测(架构设计 【F】7.2 / PRD P0-17)
 *
 * 断言口径:"没价格"这件事必须**可被 UI 显示出来**,而不是默默变成 0。
 * 覆盖 4 处改造点:cockpitAdapter ×2、cliproxyAdapter ×1、cliproxyCostEstimate ×1。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  COCKPIT_COST_BASIS_ESTIMATE,
  COCKPIT_COST_BASIS_UNKNOWN,
  cockpitSplitCostUsd,
  cockpitUsageCostUsd,
  cockpitRequestLogToOpsTrend,
  cockpitLogToOpsTrend,
  cockpitOpsSummaryToTrend,
  cockpitRequestLogToErrorTrend,
  cockpitTotalsToOpsOverview,
  cockpitRequestLogToModelStats,
  cockpitRequestLogToCostTrend,
  cockpitWindowsToCostTrend,
  cockpitModelsToModelStats,
  cockpitLogToModelRoutes,
} from '../cockpitAdapter'
import { fillCostTrendBuckets } from '../usageWindow'
import { selectFinancialTrend } from '../financialTrend'
import { eventCostUsd, pricedEventCostUsd, cliproxyEventsPricedCost, resolveCostMultiplier } from '../cliproxyAdapter'
import { estimateCliproxyCost } from '../cliproxyCostEstimate'
import { costBasisKindOf } from '../costBasis'
import { DEFAULT_COST_MULTIPLIER } from '../model'
import {
  averageQuotaRemaining,
  clampUtilization,
  formatPercentOrDash,
  formatUtilization,
  latencySampleMs,
  pickMostStaleSnapshot,
  quotaGrade,
  quotaRemainingRatio,
  quotaStaleNotice,
  resolveCostCell,
  resolveQualityScore,
  resolveRequestCounts,
  truthfulState,
} from '../honestValues'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { UsageQueueRecord } from '@/api/cliproxy/management'
import type {
  CockpitOpsSummary,
  CockpitRequestLogCell,
  CockpitRequestLogGroup,
  CockpitRequestLogSummary,
  CockpitStats,
  CockpitStatsWindow,
} from '@/api/cockpit'

/** cockpit 的 CockpitUsageCost 把标注放在 `costBasis`(`basis` 是给 UI 的文案)。 */
function cockpitKind(result: { costBasis: { kind: string } }): string {
  return result.costBasis.kind
}
/** cliproxy 的 CliproxyCostEstimate 把标注放在 `totalCostBasis`。 */
function estimateKind(result: { totalCostBasis: { kind: string } }): string {
  return result.totalCostBasis.kind
}
function isPricedCostUnknown(basis: { kind: string }): boolean {
  return basis.kind === 'no_price_no_estimate'
}

function usage(estimatedCostUsd: number) {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 100,
    totalTokens: 1600,
    estimatedCostUsd,
  } as never
}

function split(estimatedCostUsd: number) {
  return {
    model: 'gpt-image-2',
    requests: 1,
    success: 1,
    error: 0,
    stdNormalInput: 1000,
    stdCached: 0,
    stdOutput: 0,
    longNormalInput: 0,
    longCached: 0,
    longOutput: 0,
    estimatedCostUsd,
  } as never
}

function event(model: string): CliproxyUsageEvent {
  return {
    id: 1,
    requested_at: Date.now(),
    model,
    auth_index: 'auth-1',
    provider: 'openai',
    executor_type: 'openaicompatexecutor',
    input_tokens: 1_000_000,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 1_000_000,
  } as unknown as CliproxyUsageEvent
}

describe('cockpitAdapter · 无单价不再静默变 0', () => {
  it('无单价且数据源估算为 0 → 标 no_price_no_estimate(不是真实 $0)', () => {
    const result = cockpitUsageCostUsd(usage(0), undefined, 0.7)
    expect(result.cost).toBe(0)
    expect(cockpitKind(result)).toBe('no_price_no_estimate')
    expect(isPricedCostUnknown(result.costBasis)).toBe(true)
    expect(result.basis).toBe(COCKPIT_COST_BASIS_UNKNOWN)
  })

  it('无单价但数据源有估算 → 用估算并标 source_estimate', () => {
    const result = cockpitUsageCostUsd(usage(12.5), undefined, 1)
    expect(result.cost).toBeCloseTo(12.5, 10)
    expect(cockpitKind(result)).toBe('source_estimate')
    expect(result.basis).toBe(COCKPIT_COST_BASIS_ESTIMATE)
  })

  it('分档口径同样处理:估算为 0 → 标"算不出"', () => {
    const result = cockpitSplitCostUsd(split(0), undefined, 0.7)
    expect(result.cost).toBe(0)
    expect(cockpitKind(result)).toBe('no_price_no_estimate')
  })

  it('分档口径:估算非 0 → 用估算并标注', () => {
    const result = cockpitSplitCostUsd(split(12.5), undefined, 1)
    expect(result.cost).toBeCloseTo(12.5, 10)
    expect(cockpitKind(result)).toBe('source_estimate')
  })

  it('完全没有用量 → 标 no_price_no_estimate(连用量都没有)', () => {
    const result = cockpitUsageCostUsd(undefined, undefined, 0.7)
    expect(cockpitKind(result)).toBe('no_price_no_estimate')
  })
})

describe('cliproxyAdapter · 无单价不再静默变 0', () => {
  it('pricedEventCostUsd 无匹配单价 → no_price_no_estimate', () => {
    expect(costBasisKindOf(pricedEventCostUsd(event('unknown-model'), undefined)))
      .toBe('no_price_no_estimate')
  })

  /* 单价行**存在**但关键档缺失：原 `?? 0` 会把成本算成 $0 却仍标注 priced，
   * 等于声称「这个模型不要钱」。判定**按需** —— 只有该事件确实消耗了该类 token
   * 却拿不到单价时才判「算不出」，否则会误伤「output_tokens=0 且无 output 价」这种正常情形。 */
  it('缺 input 档且事件确有 input token → 算不出，不得按 0 计', () => {
    const pricing = { output_cost_per_token: 1e-6 } as never
    const result = pricedEventCostUsd(event('a'), pricing)
    expect(result.cost).toBe(0)
    expect(costBasisKindOf(result)).toBe('no_price_no_estimate')
    expect(result.label).toContain('缺 input/output 档')
  })

  it('缺 output 档但事件没有 output token → 仍按可得单价计价（按需判定，不误伤）', () => {
    const pricing = { input_cost_per_token: 1e-6 } as never
    const result = pricedEventCostUsd(event('a'), pricing)
    expect(costBasisKindOf(result)).toBe('priced')
    expect(result.cost).toBeCloseTo(1, 10)
  })

  it('缺 output 档且事件确有 output token → 算不出', () => {
    const ev = { ...event('a'), output_tokens: 500_000 } as unknown as CliproxyUsageEvent
    const pricing = { input_cost_per_token: 1e-6 } as never
    expect(costBasisKindOf(pricedEventCostUsd(ev, pricing))).toBe('no_price_no_estimate')
  })

  it('缺档时不得产生 NaN（0 × undefined = NaN 会污染整批合计）', () => {
    const ev = { ...event('a'), input_tokens: 0, output_tokens: 0 } as unknown as CliproxyUsageEvent
    const result = pricedEventCostUsd(ev, {} as never)
    expect(Number.isFinite(result.cost)).toBe(true)
    expect(result.cost).toBe(0)
  })

  it('priority 档单独给价时可用，不算缺档', () => {
    const ev = { ...event('a'), service_tier: 'priority', response_service_tier: 'priority' } as unknown as CliproxyUsageEvent
    const pricing = {
      input_cost_per_token_priority: 2e-6,
      output_cost_per_token_priority: 1e-5
    } as never
    const result = pricedEventCostUsd(ev, pricing)
    expect(costBasisKindOf(result)).toBe('priced')
    expect(result.cost).toBeCloseTo(2, 10)
  })

  it('整批里混入缺档事件 → 合计降级为 source_estimate，不冒充全部已计价', () => {
    const events = [event('ok'), event('broken')]
    const prices = {
      ok: { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
      broken: { output_cost_per_token: 1e-6 }
    } as never
    const priced = cliproxyEventsPricedCost(events, prices, 1)
    expect(priced.unpricedEvents).toBe(1)
    expect(priced.pricedEvents).toBe(1)
    expect(costBasisKindOf(priced)).toBe('source_estimate')
  })

  it('eventCostUsd 兼容层仍返回 number(0),老调用点不炸', () => {
    expect(eventCostUsd(event('unknown-model'), undefined)).toBe(0)
  })

  it('整批都没匹配到单价 → 合计标 no_price_no_estimate', () => {
    const priced = cliproxyEventsPricedCost([event('a'), event('b')], {}, 0.7)
    expect(priced.cost).toBe(0)
    expect(costBasisKindOf(priced)).toBe('no_price_no_estimate')
    expect(priced.unpricedEvents).toBe(2)
    expect(priced.pricedEvents).toBe(0)
  })

  it('部分匹配 → 标 source_estimate 并写明条数,不冒充全部已计价', () => {
    const prices = { 'a': { input_cost_per_token: 1e-6 } } as never
    const priced = cliproxyEventsPricedCost([event('a'), event('b')], prices, 1)
    expect(priced.cost).toBeCloseTo(1, 10)
    expect(costBasisKindOf(priced)).toBe('source_estimate')
    expect(priced.label).toContain('1 条请求无匹配单价')
  })

  it('re-export 保既有 import 不炸', () => {
    expect(typeof resolveCostMultiplier).toBe('function')
    expect(resolveCostMultiplier(0)).toBe(DEFAULT_COST_MULTIPLIER)
  })
})

describe('cliproxyCostEstimate · 死代码核实 + 同步修静默 0', () => {
  it('未知模型不计成本,但合计标注"算不出"', () => {
    const record = {
      model: 'unknown-model',
      tokens: { input: 1_000_000, output: 0, cached: 0, total: 1_000_000 },
    } as unknown as UsageQueueRecord
    const result = estimateCliproxyCost([record], [])
    expect(result.totalUsd).toBe(0)
    expect(estimateKind(result)).toBe('no_price_no_estimate')
    expect(result.unmatchedRequests).toBe(1)
  })

  it('全部命中定价 → priced', () => {
    const record = {
      model: 'gpt-5',
      tokens: { input: 1_000_000, output: 0, cached: 0, total: 1_000_000 },
    } as unknown as UsageQueueRecord
    const result = estimateCliproxyCost([record], [{ modelId: 'gpt-5', inputUsdPerMillion: 2 }])
    expect(result.totalUsd).toBeCloseTo(2, 10)
    expect(estimateKind(result)).toBe('priced')
  })
})

/* ==================== 2026-09-12 代码审查发现的 6 处「界面暗示未掌握的信息」 ====================
 * 共同契约:**无从判断时返回 null,绝不返回 0 / 1 / 绿色健康态**。
 * 0 会被读成"真的是 0",1(100%)会被读成"满血",绿色会被读成"健康" —— 全是正向断言。
 */

/** 造一个配额窗口(utilization 为 null = 我们并不知道用了多少)。 */
function windowOf(utilization: number | null) {
  return { utilization, resets_at: null } as never
}
function usageOf(fiveHour: unknown, sevenDay: unknown = null) {
  return { five_hour: fiveHour, seven_day: sevenDay } as never
}

describe('审查 #1 · TTFT 无样本不得渲染成 0 ms', () => {
  it('null / 0 / 负数都判为"无样本"(0 ms 在物理上不存在)', () => {
    expect(latencySampleMs(null)).toBeNull()
    expect(latencySampleMs(undefined)).toBeNull()
    expect(latencySampleMs(0)).toBeNull()
    expect(latencySampleMs(-5)).toBeNull()
    expect(latencySampleMs(Number.NaN)).toBeNull()
  })

  it('有样本时原样返回', () => {
    expect(latencySampleMs(842)).toBe(842)
    expect(latencySampleMs('842')).toBe(842)
  })
})

describe('审查 #2 · 自算值与数据源估算都缺时不得渲染成 $0.00', () => {
  it('两者都缺 → no_price_no_estimate(UI 显示"成本未知")', () => {
    const cell = resolveCostCell({ selfCost: null, sourceEstimate: null })
    expect(cell.costBasis).toBe('no_price_no_estimate')
    expect(cell.costIsOurs).toBe(false)
    // 数值上仍是 0,但**标注**让 UI 显示"成本未知"而不是 $0.00
    expect(cell.costUsd).toBe(0)
  })

  it('只有数据源估算 → source_estimate,并乘上倍率', () => {
    const cell = resolveCostCell({ selfCost: null, sourceEstimate: 10, multiplier: 0.7 })
    expect(cell.costBasis).toBe('source_estimate')
    expect(cell.costUsd).toBeCloseTo(7, 10)
    expect(cell.costIsOurs).toBe(false)
  })

  it('有自算值 → priced;自算值真的是 0 也算 priced(不冒充"算不出")', () => {
    expect(resolveCostCell({ selfCost: 4.2, sourceEstimate: 99 }).costBasis).toBe('priced')
    expect(resolveCostCell({ selfCost: 4.2, sourceEstimate: 99 }).costUsd).toBe(4.2)
    expect(resolveCostCell({ selfCost: 0, sourceEstimate: null }).costBasis).toBe('priced')
  })

  it('估算为 0 视为"数据源没给可用估算",不是"成本为 0"', () => {
    expect(resolveCostCell({ selfCost: null, sourceEstimate: 0 }).costBasis).toBe('no_price_no_estimate')
  })
})

describe('审查 #3 · 窗口余量无数据不得渲染成 0.0%', () => {
  it('一个账号都没同步过窗口 → null(不是 0,0 会被读成"已耗尽")', () => {
    expect(averageQuotaRemaining([])).toBeNull()
    expect(averageQuotaRemaining([undefined, null, usageOf(null, null)])).toBeNull()
  })

  it('有窗口时按最紧的一档算余量', () => {
    // five_hour 消耗 80% ⇒ 余量 20%
    expect(averageQuotaRemaining([usageOf(windowOf(80))])).toBeCloseTo(0.2, 10)
  })
  it('窗口在但余量不可得 ⇒ 不参与平均(既不当 100% 也不当 0%)', () => {
    // 不可得的那条既不按 1 也不按 0 计入 ⇒ 平均仍是 20%
    expect(averageQuotaRemaining([usageOf(windowOf(null)), usageOf(windowOf(80))])).toBeCloseTo(0.2, 10)
    // 全部不可得 ⇒ null(旧路径 `quotaRemainingRatio(usage) ?? 0` 会落 0 = "已耗尽")
    expect(averageQuotaRemaining([usageOf(windowOf(null)), usageOf(windowOf(Number.NaN))])).toBeNull()
    // 成对反例:真实 100% 消耗 ⇒ 平均余量是数字 0(不是 null)
    expect(averageQuotaRemaining([usageOf(windowOf(100))])).not.toBeNull()
    expect(averageQuotaRemaining([usageOf(windowOf(100))])).toBeCloseTo(0, 10)
  })

  it('无数据渲染成 —,不是 0.0%', () => {
    expect(formatPercentOrDash(averageQuotaRemaining([]))).toBe('—')
  })
})

describe('审查 #4 · 无窗口不得返回 1(="剩余 100%")', () => {
  it('没有 5h/7d 窗口 → null', () => {
    expect(quotaRemainingRatio(undefined)).toBeNull()
    expect(quotaRemainingRatio(usageOf(null, null))).toBeNull()
  })

  it('有窗口时返回 0..1 的余量', () => {
    expect(quotaRemainingRatio(usageOf(windowOf(0)))).toBeCloseTo(1, 10)
    expect(quotaRemainingRatio(usageOf(windowOf(100)))).toBeCloseTo(0, 10)
  })

  it('窗口在但利用率不可得 ⇒ 跳过该窗口;全部不可得 ⇒ null(不是 1 = 剩余 100%)', () => {
    // 5h 不可得、7d 用了 80% ⇒ 只看 7d ⇒ 余量 20%
    expect(quotaRemainingRatio(usageOf(windowOf(null), windowOf(80)))).toBeCloseTo(0.2, 10)
    // 两个都不可得 ⇒ null(旧实现 mostConstrained 停在 0 ⇒ 返回 1)
    expect(quotaRemainingRatio(usageOf(windowOf(null), windowOf(null)))).toBeNull()
    expect(quotaRemainingRatio(usageOf(windowOf(Number.NaN)))).toBeNull()
    // 成对反例:真实 0% 消耗仍算得出"剩余 100%",不能被一刀切成 null
    expect(quotaRemainingRatio(usageOf(windowOf(0)))).toBeCloseTo(1, 10)
  })
})

describe('审查 #5 · 未知利用率不得落进绿色健康态', () => {
  it('null / undefined / 空串 / NaN 一律 unknown', () => {
    for (const value of [null, undefined, '', Number.NaN, 'abc']) {
      expect(quotaGrade(value), `utilization=${String(value)} 不应被判定为健康`).toBe('unknown')
    }
  })

  it('unknown 绝不等于 high(绿色)', () => {
    expect(quotaGrade(null)).not.toBe('high')
  })

  it('利用率文本:未知显示 —,已知显示百分比', () => {
    expect(formatUtilization(null)).toBe('—')
    expect(clampUtilization(null)).toBeNull()
    expect(formatUtilization(42.4)).toBe('42%')
    expect(clampUtilization(180)).toBe(100)
  })

  it('真实的 0% 利用率仍是 high(不能把"消耗 0"说成未知)', () => {
    expect(quotaGrade(0)).toBe('high')
    expect(formatUtilization(0)).toBe('0%')
  })
})

describe('审查 #6 · 零观测不得渲染成"失败率 0.0%"', () => {
  it('总请求数为 0 → 失败率 null(Ops 在零请求时硬编码 error_rate: 0)', () => {
    const counts = resolveRequestCounts({ reportedTotal: 0, reportedErrorRate: 0, reportedError: 0 })
    expect(counts.total).toBe(0)
    expect(counts.errorRate, '零观测 ≠ 零失败,不能返回 0').toBeNull()
    expect(formatPercentOrDash(counts.errorRate)).toBe('—')
  })

  it('连趋势点都没有(零观测)→ 总数与失败率都是 null', () => {
    const counts = resolveRequestCounts({ fallbackTotal: 0, fallbackObserved: false })
    expect(counts.total).toBeNull()
    expect(counts.errorRate).toBeNull()
  })

  it('有观测时正常出数', () => {
    const counts = resolveRequestCounts({ reportedTotal: 200, reportedError: 10 })
    expect(counts.errorRate).toBeCloseTo(0.05, 10)
    expect(counts.success).toBe(190)
  })

  it('全部失败占比 uses the displayed total, not a differently scoped source SLA rate', () => {
    const counts = resolveRequestCounts({ reportedTotal: 11346, reportedSuccess: 10945, reportedError: 401, reportedErrorRate: 0.005 })
    expect(counts.errorRate).toBeCloseTo(401 / 11346)
    expect(counts.reportedErrorRate).toBe(0.005)
    expect(resolveRequestCounts({ reportedTotal: 100, reportedErrorRate: 0.005 }).errorRate).toBeNull()
  })

  it('失败数只认上报值:账号 error 态数量不是请求数,不能拿去减', () => {
    const counts = resolveRequestCounts({ fallbackTotal: 100, fallbackObserved: true, reportedTotal: null })
    expect(counts.error).toBeNull()
    expect(counts.success).toBeNull()
  })

  it('综合分:健康分缺失 + 无失败率 → null,且来源标注为推算', () => {
    const quality = resolveQualityScore({ healthScore: null, activeAccounts: 3, totalAccounts: 4, errorRate: null })
    expect(quality.score).toBeNull()
    expect(quality.provenance, '分数算不出来时也不能标"Ops 实测"').toBe('derived')
  })

  it('综合分:有健康分 → 来源标 ops', () => {
    const quality = resolveQualityScore({ healthScore: 91, errorRate: null })
    expect(quality.score).toBe(91)
    expect(quality.provenance).toBe('ops')
  })

  it('综合分:账号状态推算时来源标 derived(不是 ops)', () => {
    const quality = resolveQualityScore({ healthScore: null, activeAccounts: 4, totalAccounts: 4, errorRate: 0 })
    expect(quality.provenance).toBe('derived')
    expect(quality.score).toBeCloseTo(100, 10)
  })
})

describe('审查 #7/#9 · 来源标注必须跟真实来源一致', () => {
  it('值为空时状态是不可用,不是"实测"', () => {
    expect(truthfulState('')).toBe('unavailable')
    expect(truthfulState(null)).toBe('unavailable')
    expect(truthfulState(undefined)).toBe('unavailable')
    expect(truthfulState('scoped')).toBe('measured')
  })

  /**
   * ★ 2026-09-23 独立复核**翻案**:第八轮曾把这一项判为「已证伪(NaN 不可达)」,
   *   依据是「truthfulState 的调用点只传字符串」—— **该依据是事实错误**。
   *   实际 16 个调用点里至少 7 个传 `number`:`CockpitDataView` 的
   *   `stats.totals.{totalTokens,requestCount,inputTokens,outputTokens,cachedTokens,reasoningTokens}`
   *   与 `CostCenterView` 的 `cliproxyOverview.authFileCount`。
   *
   *   而 `truthfulState` 原先只判 `== null || === ''` ⇒ **NaN / Infinity 会被判成「实测」**。
   *   同一格里 `value` 走 `formatTokens` / `formatInteger`,它们**都**判
   *   `!Number.isFinite(Number(v)) ⇒ '无数据'` ⇒ 界面出现
   *   「**数值格写『无数据』、旁边徽标写『实测』**」的同格自相矛盾。
   *   `NaN` 正是"没有测到"的表示,替它背「实测」就是假实测。
   */
  it('数字域:NaN / Infinity 也是"没测到",不得挂「实测」徽标', () => {
    expect(truthfulState(NaN)).toBe('unavailable')
    expect(truthfulState(Infinity)).toBe('unavailable')
    expect(truthfulState(-Infinity)).toBe('unavailable')
    // 成对反例:0 是**真实测量值**(请求数、Token 数真的可以是 0),
    // 不能被同一条守卫误伤成「不可用」—— 那会把真实 0 说成没测到。
    expect(truthfulState(0)).toBe('measured')
    expect(truthfulState(-1)).toBe('measured')
    expect(truthfulState(1e9)).toBe('measured')
  })

  /**
   * ★ 差分直测(**不是复述实现**):同格里 `value` 走 `formatTokens`/`formatInteger`,
   *   `state` 走 `truthfulState`。两侧必须对**同一组输入**同进同出,否则就是上面那种自相矛盾。
   *
   *   下面 `formatterSaysNoData` 是**独立复现**同格格式化函数的判据
   *   (源码原文 `value == null || !Number.isFinite(Number(value))`),
   *   它确实是源码里那一份、以及两者确实同格同参 —— 由下一条用例**扫描源码**钉住,
   *   免得我在这里现编一个判据自证。
   */
  it('数字域:truthfulState 必须与同格格式化函数同进同出(差分)', () => {
    const cases: Array<number | null | undefined> = [
      NaN, Infinity, -Infinity, 0, 1, -1, 0.5, 1e9, -1e9, null, undefined,
    ]
    let noDataCount = 0
    for (const v of cases) {
      const formatterSaysNoData = v == null || !Number.isFinite(Number(v))
      const stateSaysUnavailable = truthfulState(v) === 'unavailable'
      expect(
        stateSaysUnavailable,
        `v=${String(v)}:徽标判定必须与同格数值格判定一致`,
      ).toBe(formatterSaysNoData)
      if (formatterSaysNoData) noDataCount += 1
    }
    // 变异守卫:本组必须**同时**含「两侧都判无值」与「两侧都判有值」的样本。
    // 否则把 truthfulState 改成恒 unavailable(或恒 measured)也能全绿 —— 那就是空集式假通过。
    expect(noDataCount, '本组必须含"无数据"样本').toBeGreaterThan(0)
    expect(cases.length - noDataCount, '本组必须含"有值"样本').toBeGreaterThan(0)
  })

  it('源码接线:被差分的那份判据确实在同格格式化函数里,且两者同格同参', () => {
    const cockpitView = readFileSync(
      resolve(process.cwd(), 'src/views/cockpit/CockpitDataView.vue'),
      'utf8',
    )
    const costView = readFileSync(
      resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'),
      'utf8',
    )
    // 1) 我复现的那份判据 == 源码里那一份(两个文件都必须有,否则上一条差分就失去依据)
    expect(cockpitView, 'CockpitDataView 的格式化函数必须用 Number.isFinite 判"无数据"')
      .toContain('!Number.isFinite(Number(value))')
    expect(costView, 'CostCenterView 的格式化函数必须用 Number.isFinite 判"无数据"')
      .toContain('!Number.isFinite(Number(value))')
    // 2) 同格同参:同一个实参同时喂给格式化函数与 truthfulState(这才是"同格"的前提)
    expect(cockpitView, 'Token 格:数值与徽标必须同参')
      .toContain('formatTokens(stats.totals.totalTokens)')
    expect(cockpitView, 'Token 格:徽标必须用 truthfulState 判同一个实参')
      .toContain(':state="truthfulState(stats.totals.totalTokens)"')
    expect(costView, '认证文件数格:数值与徽标必须同参')
      .toContain('formatInteger(cliproxyOverview?.authFileCount)')
    expect(costView, '认证文件数格:徽标必须用 truthfulState 判同一个实参')
      .toContain(':state="truthfulState(cliproxyOverview?.authFileCount)"')
    // 3) 扫描面非空(红线:否定断言 / toContain 在空串上恒真的假绿)
    expect(cockpitView.length).toBeGreaterThan(1000)
    expect(costView.length).toBeGreaterThan(1000)
  })
})

describe('审查 #10 · 加载失败时不得静默显示旧数据', () => {
  const ERROR = '渠道配额读取失败: io error'

  it('读取失败 + 界面有旧数据 → 标记失败,并给出提示与原文', () => {
    const notice = quotaStaleNotice(ERROR, true)
    expect(notice.staleDueToError).toBe(true)
    expect(notice.title).toContain('读取失败')
    expect(notice.title).toContain('上次成功加载')
    expect(notice.detail, '必须把原文给出来,便于排查').toBe(ERROR)
  })

  it('读取失败但**没有**旧数据可展示 → 不标记(谈不上"旧",横条本身也不渲染)', () => {
    const notice = quotaStaleNotice(ERROR, false)
    expect(notice.staleDueToError).toBe(false)
    expect(notice.title).toBeNull()
    expect(notice.detail).toBeNull()
  })

  it('没有失败 → 行为与现在完全一致,不出现任何多余提示', () => {
    for (const value of [null, undefined, '', '   ']) {
      const notice = quotaStaleNotice(value, true)
      expect(notice.staleDueToError, `error=${JSON.stringify(value)} 不应标记失败`).toBe(false)
      expect(notice.title).toBeNull()
      expect(notice.detail).toBeNull()
    }
  })

  it('非字符串错误不会把 "null"/"undefined" 当成失败原因', () => {
    const notice = quotaStaleNotice({ message: 'x' } as unknown, true)
    expect(notice.staleDueToError).toBe(false)
  })
})

describe('审查 #8 · 百分比与时间戳必须取自同一条快照', () => {
  interface FakeSnap {
    id: string
    percent: number | null
    updatedAtMs: number | null
  }
  const now = 1_800_000_000_000
  const snap = (percent: number | null, updatedAtMs: number | null, id: string): FakeSnap =>
    ({ id, percent, updatedAtMs })

  it('取"最老且有百分比"的那条,而不是第一条', () => {
    const snaps = [
      snap(90, now - 1000, 'fresh'),   // 最新:剩余 90%
      snap(12, now - 90 * 86_400_000, 'ancient'), // 最老:剩余 12%
    ]
    const picked = pickMostStaleSnapshot(snaps, (s) => now - (s.updatedAtMs as number), (s) => s.percent != null)
    expect(picked?.id).toBe('ancient')
    expect(picked?.percent).toBe(12)
  })

  it('年龄全不可判时退回"剩余最低"那条,仍保证同源', () => {
    const snaps = [snap(80, null, 'a'), snap(35, null, 'b')]
    const picked = pickMostStaleSnapshot(
      snaps,
      () => null,
      (s) => s.percent != null,
      (s) => s.percent,
    )
    expect(picked?.id).toBe('b')
  })

  it('一条都没有百分比 → null(不可得)', () => {
    expect(pickMostStaleSnapshot([snap(null, now, 'x')], () => 1000, (s) => s.percent != null)).toBeNull()
  })
})

// ============================================================================
// ⑨ cockpit ops 趋势的"源头假零"(2026-09-20)
//
// 红线复述:源不支持 / 读不到 / 不可测 ⇒ null(图表断点),**绝不能用 0 冒充"实测为 0"**。
// 本块每条断言都成对写:不可得 ⇒ null;真实 0 / 真实值 ⇒ 仍必须是数字(防"过度修正")。
// ============================================================================

/** 单请求用量库一格(桶 × 模型):std 输入 600 + 缓存 400 + 输出 100。 */
function opsCell(overrides: Partial<CockpitRequestLogCell> = {}): CockpitRequestLogCell {
  return {
    startMs: 1_700_000_000_000,
    model: 'gpt-6-astra',
    requests: 1,
    success: 1,
    error: 0,
    stdNormalInput: 600,
    stdCached: 400,
    stdOutput: 100,
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

function requestLogSummary(cells: CockpitRequestLogCell[]): CockpitRequestLogSummary {
  return {
    available: true,
    reason: null,
    rowCount: cells.reduce((s, c) => s + c.requests, 0),
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_060_000,
    bucketHours: 1,
    cells,
    groups: [] as CockpitRequestLogGroup[],
    bucketLatencies: [],
  } as unknown as CockpitRequestLogSummary
}

/** 与 modelAuditSourceContract.spec.ts / opsHonestyRegression.spec.ts 同款最小 stats。 */
function cockpitStatsFixture(): CockpitStats {
  const totals = {
    requestCount: 5, successCount: 5, failureCount: 0, clientCanceledCount: 0,
    upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 100,
    textRequestCount: 5, imageRequestCount: 0, imageGenerationRequestCount: 0,
    imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0,
    inputTokens: 10, outputTokens: 10, totalTokens: 20, cachedTokens: 0,
    reasoningTokens: 0, estimatedCostUsd: 0,
  }
  const now = Date.now()
  return {
    since: now - 3_600_000,
    updatedAt: now,
    totals,
    accounts: [],
    models: [],
    apiKeys: [],
    daily: { since: now - 3_600_000, updatedAt: now, accounts: [], models: [], apiKeys: [], totals },
    weekly: null,
    monthly: null,
  } as unknown as CockpitStats
}

describe('⑨ cockpit ops 趋势:不可得维度留 null(不是假 0)', () => {
  it('① cache_creation_tokens 无该维度 ⇒ null;同对象里实测的 token 列仍是数字', () => {
    const trend = cockpitRequestLogToOpsTrend(requestLogSummary([opsCell()]))
    expect(trend).toHaveLength(1)
    const point = trend[0]!
    // 不可得:cockpit 只有 cached / normal,没有 cache-creation 维度
    expect(point.cache_creation_tokens).toBeNull()
    expect(point.cache_creation_tokens).not.toBe(0)
    // 成对反例:这些是单请求用量库**实测**值,不能被一并改成 null
    expect(point.input_tokens).toBe(1000)      // stdNormalInput 600 + stdCached 400
    expect(point.cache_read_tokens).toBe(400)
    expect(point.output_tokens).toBe(100)
    expect(point.token_consumed).toBe(1100)
    // 早已诚实处理的切号维度,保持 null
    expect(point.switch_count).toBeNull()
  })

  it('⑤ ops 趋势成本列 ⇒ null:不再劫持 selectFinancialTrend(usage 无证据时也不画零线)', () => {
    const trend = cockpitRequestLogToOpsTrend(requestLogSummary([opsCell()]))
    expect(trend[0]!.user_billed_usd).toBeNull()
    expect(trend[0]!.account_cost_usd).toBeNull()
    expect(trend[0]!.contribution_usd).toBeNull()
    // 行为断言:usage 侧没有任何成本证据时,旧写法(0)会让 useOps=true 而画出一条
    // 贴底零成本线;新写法必须退回 usage_logs(此处为空)⇒ 空数组 = 图表无数据。
    expect(selectFinancialTrend(trend, [], 1, 1)).toEqual([])
  })

  it('⑤ 反向护栏:ops 真带成本值时仍被选中(真实值不被误伤)', () => {
    const base = cockpitRequestLogToOpsTrend(requestLogSummary([opsCell()]))[0]!
    const ops = [{ ...base, user_billed_usd: 3, account_cost_usd: 1, contribution_usd: 2 }]
    expect(selectFinancialTrend(ops, [], 1, 1)).toMatchObject([
      { source: 'ops', billedUsd: 3, accountCostUsd: 1, contributionUsd: 2 },
    ])
  })

  it('②③ 两条日志回退路径:无 token 字段 ⇒ token/tps 留 null,但 qps 仍是真值', () => {
    // ② Rust 多天日志聚合桶(CockpitOpsBucket 只有请求/成败/TTFT/耗时)
    const summary = {
      buckets: [{
        bucket_start_ms: 1_700_000_000_000,
        request_count: 120, success_count: 118, error_count: 2,
        ttft_p50_ms: 300, ttft_p95_ms: 900, duration_p95_ms: 4200,
      }],
      accounts: [], routes: [], files_read: [], requests_total: 120,
      min_date: null, max_date: null,
    } as unknown as CockpitOpsSummary
    const point = cockpitOpsSummaryToTrend(summary, 1)[0]!
    expect(point.token_consumed).toBeNull()
    expect(point.input_tokens).toBeNull()
    expect(point.output_tokens).toBeNull()
    expect(point.cache_creation_tokens).toBeNull()
    expect(point.cache_read_tokens).toBeNull()
    expect(point.tps).toBeNull()
    // 成对反例:qps / duration 是**真实**值,不能被一并 null 掉
    expect(point.qps).toBeCloseTo(120 / 3600, 10)
    expect(point.duration_p95_ms).toBe(4200)
    expect(point.ttft_p95_ms).toBe(900)

    // ③ 当天 codex-api 日志回退路径(CockpitLogEvent 无 token 字段)
    const startedAtMs = Date.now() - 10 * 60 * 1000
    const log = `2026-08-26T08:00:04.400+08:00 INFO [CodexLocalAccess][sidecar] ${
      JSON.stringify({ type: 'request_started', requestId: 'r1', model: 'gpt-6-astra', startedAtMs })
    }`
    const legacy = cockpitLogToOpsTrend(log, '1h')
    const hit = legacy.find((p) => p.request_count > 0)
    expect(hit).toBeTruthy()
    expect(hit!.token_consumed).toBeNull()
    expect(hit!.input_tokens).toBeNull()
    expect(hit!.cache_creation_tokens).toBeNull()
    expect(hit!.cache_read_tokens).toBeNull()
    expect(hit!.tps).toBeNull()
    // 成对反例:qps 由真实请求数算出,必须 > 0
    expect(hit!.qps).toBeGreaterThan(0)
  })

  it('④ business_limited_count / error_count_sla / sla 不可得 ⇒ null;真实计数仍是数字', () => {
    // 错误码趋势路径:cockpit 无"业务限制"分类 ⇒ 三项不可得
    const errTrend = cockpitRequestLogToErrorTrend(requestLogSummary([
      opsCell({ requests: 12, success: 0, error: 12, rateLimited: 5, upstreamError: 8, clientCanceled: 2 }),
    ]))
    const errPoint = errTrend[0]!
    expect(errPoint.error_count_total).toBe(12)
    expect(errPoint.business_limited_count).toBeNull()
    expect(errPoint.error_count_sla).toBeNull()
    // 成对反例:429 由本机 error_category/http_status **实测**计出,仍是数字
    expect(errPoint.upstream_429_count).toBe(5)
    expect(errPoint.upstream_error_count_excl_429_529).toBe(3)
    expect(errPoint.upstream_402_count).toBeNull()

    // totals 路径:失败分类里没有业务限制维度 ⇒ 三件套全 null
    const overview = cockpitTotalsToOpsOverview(cockpitStatsFixture(), '1h')!
    expect(overview.business_limited_count).toBeNull()
    expect(overview.error_count_sla).toBeNull()
    expect(overview.sla).toBeNull()
    // 成对反例:失败数 0 是**真实**的零(5 请求 0 失败),必须仍是 0;请求总数是实测值
    expect(overview.error_count_total).toBe(0)
    expect(overview.request_count_total).toBe(5)
    // FIX A 同源护栏:429 / 529 仍是 null
    expect(overview.upstream_429_count).toBeNull()
    expect(overview.upstream_529_count).toBeNull()
  })
})

// ============================================================================
// ⑩ cockpitAdapter 剩余硬编码 0 清零(2026-09-20)
//
// 逐处核验(不是"一律改成 null"),四条源侧证据:
//   1. cache-creation 维度源侧**不存在**:CockpitTokenSplit 只有 std/long ×
//      Normal/Cached/Output(src-tauri/src/cockpit_logs_db.rs:57-78);`CREATE TABLE request_logs`
//      (:847-877)没有该列;CockpitUsageStats(src/api/cockpit/index.ts:17-36)只有
//      input/output/total/cached/reasoning。
//   2. codex-api 日志回退路径:CockpitLogEvent(cockpitAdapter.ts:1391-1418)**没有任何 token 字段**。
//   3. 图片 token:源侧只有**图片请求计数**(imageRequestCount / imageGenerationRequestCount /
//      imageEditRequestCount,src/api/cockpit/index.ts:30-33),没有图片 token 维度。
//   4. 以上全部是"源不掌握该维度"的假零 ⇒ 一律 null。
// 每条都成对写"真实 0 / 真实值仍是数字"的反例,防过度修正(本项目曾因守卫过严误伤
// `output_tokens === 0` 的正常用例)。
// ============================================================================

/** 单请求用量库一组(模型 × 账号),供 cockpitRequestLogToModelStats 用。 */
function requestLogGroup(overrides: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return {
    ...opsCell(),
    model: 'gpt-6-astra',
    accountId: '',
    apiKeyId: '',
    firstMs: null,
    lastMs: null,
    ...overrides,
  } as unknown as CockpitRequestLogGroup
}

function requestLogSummaryWithGroups(groups: CockpitRequestLogGroup[]): CockpitRequestLogSummary {
  return { ...requestLogSummary([]), groups } as unknown as CockpitRequestLogSummary
}

describe('⑩ cockpitAdapter 剩余假零清零:cache-creation / 日志 token / 图片 token', () => {
  it('① 单请求用量库 → ModelStat:cache-creation 不可得 ⇒ null;实测 token 列仍是数字', () => {
    const stats = cockpitRequestLogToModelStats(requestLogSummaryWithGroups([requestLogGroup()]), {})
    expect(stats).toHaveLength(1)
    const row = stats[0]!
    expect(row.cache_creation_tokens).toBeNull()
    expect(row.cache_creation_tokens).not.toBe(0)
    // 成对反例:同对象里 input/output/cache_read 是库里实测值(stdNormalInput 600 + stdCached 400)
    expect(row.input_tokens).toBe(1000)
    expect(row.output_tokens).toBe(100)
    expect(row.cache_read_tokens).toBe(400)
    expect(row.total_tokens).toBe(1100)
  })

  it('② 单请求用量库 → 成本趋势点:cache-creation 不可得 ⇒ null;实测 token 列仍是数字', () => {
    const trend = cockpitRequestLogToCostTrend(requestLogSummary([opsCell()]), {})
    expect(trend).toHaveLength(1)
    expect(trend[0]!.cache_creation_tokens).toBeNull()
    expect(trend[0]!.input_tokens).toBe(1000)
    expect(trend[0]!.output_tokens).toBe(100)
    expect(trend[0]!.cache_read_tokens).toBe(400)
  })

  it('③ 日历快照 → 成本趋势点:cache-creation 不可得 ⇒ null;实测 token 列仍是数字', () => {
    const trend = cockpitWindowsToCostTrend(cockpitStatsFixture(), 1)
    expect(trend.length).toBeGreaterThan(0)
    for (const point of trend) {
      expect(point.cache_creation_tokens).toBeNull()
      expect(point.cache_creation_tokens).not.toBe(0)
    }
    // 成对反例:totals 的 input/output 是快照实测值
    expect(trend[0]!.input_tokens).toBe(10)
    expect(trend[0]!.output_tokens).toBe(10)
  })

  it('④ stats JSON 逐模型 → ModelStat:cache-creation 不可得 ⇒ null;实测 token 列仍是数字', () => {
    const window = {
      models: [{
        modelId: 'gpt-6-astra',
        usage: {
          requestCount: 3, successCount: 3, failureCount: 0, clientCanceledCount: 0,
          upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 10,
          textRequestCount: 3, imageRequestCount: 0, imageGenerationRequestCount: 0,
          imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0,
          inputTokens: 700, outputTokens: 300, totalTokens: 1000, cachedTokens: 200,
          reasoningTokens: 0, estimatedCostUsd: 0,
        },
      }],
    } as unknown as CockpitStatsWindow
    const stats = cockpitModelsToModelStats(window, 1)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.cache_creation_tokens).toBeNull()
    expect(stats[0]!.input_tokens).toBe(700)
    expect(stats[0]!.output_tokens).toBe(300)
    expect(stats[0]!.cache_read_tokens).toBe(200)
    expect(stats[0]!.requests).toBe(3)
  })

  it('⑤ codex-api 日志回退路径:逐请求 token / 图片 token 不可得 ⇒ null;源侧实测字段仍是真值', () => {
    const startedAtMs = Date.now() - 10 * 60 * 1000
    const log = `2026-08-26T08:00:04.400+08:00 INFO [CodexLocalAccess][sidecar] ${
      JSON.stringify({ type: 'request_started', requestId: 'r1', model: 'gpt-6-astra', startedAtMs })
    }`
    const { logs } = cockpitLogToModelRoutes(log, [])
    expect(logs).toHaveLength(1)
    const entry = logs[0]!
    expect(entry.input_tokens).toBeNull()
    expect(entry.output_tokens).toBeNull()
    expect(entry.cache_creation_tokens).toBeNull()
    expect(entry.cache_read_tokens).toBeNull()
    expect(entry.image_input_tokens).toBeNull()
    expect(entry.image_output_tokens).toBeNull()
    // 成对反例:源侧**实测**字段不得被一并 null 掉
    expect(entry.model).toBe('gpt-6-astra')
    expect(entry.request_id).toBe('r1')
    expect(entry.created_at).toBe(new Date(startedAtMs).toISOString())
    expect(entry.actual_cost).toBeNull()
  })

  it('⑥ 真实 0 仍是 0:空桶补点(桶内无请求)不得被改成 null', () => {
    const filled = fillCostTrendBuckets(
      [],
      '1h',
      new Date('2026-09-20T00:00:00.000Z'),
      new Date('2026-09-20T01:00:00.000Z'),
    )
    expect(filled.length).toBeGreaterThan(0)
    for (const point of filled) {
      expect(point.requests).toBe(0)
      expect(point.cache_creation_tokens).toBe(0)
      expect(point.input_tokens).toBe(0)
    }
  })

  it('⑦ 趋势合并:null 不产生 NaN,同桶真实数字仍被累加', () => {
    const points = [{
      date: '2026-09-20T00:10:00.000Z',
      requests: 2,
      input_tokens: 30,
      output_tokens: 12,
      cache_creation_tokens: null,
      cache_read_tokens: 5,
      total_tokens: 47,
      cost: 0.25,
      actual_cost: 0.25,
    }]
    const filled = fillCostTrendBuckets(
      points,
      '1h',
      new Date('2026-09-20T00:00:00.000Z'),
      new Date('2026-09-20T01:00:00.000Z'),
    )
    const merged = filled.find((point) => point.requests > 0)!
    expect(merged.input_tokens).toBe(30)
    expect(merged.output_tokens).toBe(12)
    expect(merged.cache_read_tokens).toBe(5)
    expect(Number.isNaN(Number(merged.cache_creation_tokens))).toBe(false)
  })
  it('⑧ 端到端:cockpit codex-api 日志回退路径 ⇒ total_cost / standardCost 双 null(不是 0)', () => {
    const startedAtMs = Date.now() - 10 * 60 * 1000
    const log = `2026-08-26T08:00:04.400+08:00 INFO [CodexLocalAccess][sidecar] ${
      JSON.stringify({ type: 'request_started', requestId: 'r-cost', model: 'gpt-6-astra', startedAtMs })
    }`
    // 第三个参数传 undefined ⇒ 跳过模型窗口均摊回填,走纯日志回退路径
    const result = cockpitLogToModelRoutes(log, [], undefined)
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0]!.total_cost).toBeNull()
    expect(result.routes).toHaveLength(1)
    expect(result.routes[0]!.standardCost).toBeNull()
    expect(result.routes[0]!.accountCost).toBeNull()
  })
})
