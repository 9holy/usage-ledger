import { costDataText } from './costDataText'
import {
  COST_ALGORITHM_VERSION,
  CNY_PER_USD,
  convertCurrency,
  economicCostSnapshot,
  inferPlan,
  resolveAccountBillingMode,
  resolveFallbackCostProfile,
  procurementCostInWindow,
  type CostCurrency,
  type CostLossStateLike,
  type CostProfile,
  type AccountWindowUsage,
  sumAccountCostUsd,
  sumAccountUserCost,
  sumAccountTokens,
  summarizeKnownAmounts,
  type AmountSummary,
  type AccountBillingMode,
  type CostAccount,
} from './model'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'
import { resolveCostMultiplier } from './costMultiplier'

export interface OperatingScope { source: 'sub2api' | 'cliproxy' | 'cockpit'; instanceId: string }

/** One row per account, including historical usage-only and finance-only accounts, in one [start,end) window. */
export interface OperatingAccount {
  scope: OperatingScope
  accountId: string
  /** Missing account_id usage retains its amounts but is not one real account. */
  isUnattributedUsage?: boolean
  billingMode: AccountBillingMode
  revenueUsd: number | null
  /** Already includes the source account rate. Never multiply this amount by the fallback again. */
  meteredCostUsd: number | null
  knownMeteredCostUsd?: number
  referenceValueUsd: number | null
  knownReferenceValueUsd?: number
  fixedExpenseCny: number | null
  knownFixedExpenseCny: number
  fixedHourlyCny: number | null
  knownFixedHourlyCny: number
}

export interface OperatingSummary {
  scope: OperatingScope
  accountCount: number
  expenseCny: AmountSummary
  fixedExpenseCny: AmountSummary
  fixedHourlyCny: AmountSummary
  meteredExpenseCny: AmountSummary
  hourlyExpenseCny: AmountSummary
  revenueUsd: AmountSummary
  referenceValueUsd: AmountSummary
  unclassifiedUsageCostUsd: AmountSummary
  contributionCny: number | null
  projectedContributionCnyPerHour: number | null
  estimatedMeteredCount: number
  unknownBillingModeCount: number
}

/** Procurement is operating expense; source token/account values remain rate estimates, never payment evidence. */
export function summarizeOperatingCosts(input: {
  scope: OperatingScope
  accounts: OperatingAccount[]
  startMs: number
  endMs: number
  cnyPerUsd: number
  costMultiplier?: number
  outputBasis: 'revenue' | 'api_value'
  accountInventoryComplete?: boolean
}): OperatingSummary {
  const rows = input.accounts.filter(row => row.scope.source === input.scope.source && row.scope.instanceId === input.scope.instanceId)
  const rate = Number.isFinite(input.cnyPerUsd) && input.cnyPerUsd > 0 ? input.cnyPerUsd : CNY_PER_USD
  const hours = Number.isFinite(input.startMs) && Number.isFinite(input.endMs) && input.endMs > input.startMs
    ? (input.endMs - input.startMs) / 3_600_000 : null
  const finite = (value: number | null) => typeof value === 'number' && Number.isFinite(value)
  const empty = (): AmountSummary => ({ total: null, knownSubtotal: 0, unknownCount: 0 })
  const fixed = (total: number | null, subtotal: number): AmountSummary => finite(total)
    ? { total, knownSubtotal: total!, unknownCount: 0 }
    : { total: null, knownSubtotal: Number.isFinite(subtotal) ? subtotal : 0, unknownCount: 1 }
  const combine = (parts: AmountSummary[]): AmountSummary => {
    if (!rows.length) return empty()
    const unknownCount = parts.reduce((sum, part) => sum + part.unknownCount, 0)
    const knownSubtotal = parts.reduce((sum, part) => sum + part.knownSubtotal, 0)
    return { total: unknownCount ? null : knownSubtotal, knownSubtotal, unknownCount }
  }
  const multiplier = resolveCostMultiplier(input.costMultiplier)
  let estimatedMeteredCount = 0
  let unknownBillingModeCount = 0
  const fixedExpenses: AmountSummary[] = [], fixedRates: AmountSummary[] = [], usageExpenses: AmountSummary[] = []
  for (const row of rows) {
    fixedExpenses.push(fixed(row.fixedExpenseCny, row.knownFixedExpenseCny))
    fixedRates.push(fixed(row.fixedHourlyCny, row.knownFixedHourlyCny))
    if (row.billingMode === 'subscription') usageExpenses.push({ total: 0, knownSubtotal: 0, unknownCount: 0 })
    else if (row.billingMode === 'metered') {
      const partialSource = row.meteredCostUsd == null && row.knownMeteredCostUsd != null
      const resolved = partialSource ? null : finite(row.meteredCostUsd) ? row.meteredCostUsd
        : finite(row.referenceValueUsd) ? row.referenceValueUsd! * multiplier : null
      if (finite(resolved) || partialSource) estimatedMeteredCount += 1
      usageExpenses.push(fixed(resolved == null ? null : resolved * rate,
        partialSource ? row.knownMeteredCostUsd! * rate : (row.knownReferenceValueUsd ?? 0) * multiplier * rate))
    } else {
      unknownBillingModeCount += 1
      usageExpenses.push({ total: null, knownSubtotal: 0, unknownCount: 1 })
    }
  }
  const fixedExpenseCny = combine(fixedExpenses)
  const meteredExpenseCny = combine(usageExpenses)
  const expenseCny = combine([fixedExpenseCny, meteredExpenseCny])
  const fixedHourlyCny = combine(fixedRates)
  const usageHourly = hours == null ? { total: null, knownSubtotal: 0, unknownCount: rows.length ? 1 : 0 }
    : { total: meteredExpenseCny.total == null ? null : meteredExpenseCny.total / hours, knownSubtotal: meteredExpenseCny.knownSubtotal / hours, unknownCount: meteredExpenseCny.unknownCount }
  const hourlyExpenseCny = combine([fixedHourlyCny, usageHourly])
  if (input.accountInventoryComplete === false) {
    // Missing current accounts can hide fixed expenses even when observed usage is zero.
    for (const amount of [fixedExpenseCny, fixedHourlyCny, expenseCny, hourlyExpenseCny]) {
      amount.total = null
      amount.unknownCount += 1
    }
  }
  const revenueUsd = rows.length && input.outputBasis === 'revenue' ? summarizeKnownAmounts(rows.map(row => row.revenueUsd)) : empty()
  const referenceValueUsd = combine(rows.map(row => fixed(row.referenceValueUsd, row.knownReferenceValueUsd ?? 0)))
  const unclassifiedUsageCostUsd = combine(rows.filter(row => row.billingMode === 'unknown').map(row => fixed(row.meteredCostUsd, row.knownMeteredCostUsd ?? 0)))
  return {
    scope: input.scope, accountCount: rows.filter(row => !row.isUnattributedUsage).length, expenseCny, fixedExpenseCny, fixedHourlyCny, meteredExpenseCny, hourlyExpenseCny,
    revenueUsd, referenceValueUsd, unclassifiedUsageCostUsd, estimatedMeteredCount, unknownBillingModeCount,
    contributionCny: hours != null && revenueUsd.total != null && expenseCny.total != null ? revenueUsd.total * rate - expenseCny.total : null,
    projectedContributionCnyPerHour: hours != null && revenueUsd.total != null && hourlyExpenseCny.total != null
      ? revenueUsd.total * rate / hours - hourlyExpenseCny.total : null,
  }
}

export interface AccountHealthDatum {
  successCount: number
  failureCount: number
  state?: 'normal' | 'limited' | 'error' | 'inactive'
}

/** 单账号输入：account + health 绑定（类型层保证等长，替代平行数组）。 */
export interface LocalEconomicsAccount {
  account: CostAccount
  health: AccountHealthDatum
  loss?: CostLossStateLike & { currency: CostCurrency; cost_profile?: CostProfile }
}

export interface LocalEconomicsInput {
  accounts: LocalEconomicsAccount[]
  /** cockpit totals.estimatedCostUsd 是总量（无每账号 billed），直接赋 actual.billed_usd。
   *  `null` = 该窗口的 billed 算不出来(全部模型无单价、数据源也无估算)—— 不得用 0 冒充"确实没有产出"。 */
  billedUsdTotal: number | null
  cnyPerUsd: number
  /** 调用方传 now（对齐 accountLedgers 的 now.value），不在此处 Date.now() 保证一致性。 */
  now: number
  /** 可选，外部传入（cockpit daily/weekly/monthly 3 点），透传不改。 */
  series?: AccountEconomicsSnapshot['series']
  /** 未录采购价时使用的估算倍率；省略时使用统一默认值，自定义采购价不乘倍率。 */
  costMultiplier?: number
  accountCostUsdTotal?: number | null
  outputBasis?: 'revenue' | 'api_value'
  window?: { start: Date; end: Date }
  impairmentComplete?: boolean
}

type DataQualityStatus = 'complete' | 'partial' | 'estimated' | 'unavailable'

export type LocalEconomicsSnapshot = AccountEconomicsSnapshot & {
  local_derived: {
    usage_cost_unit: 'window' | 'cumulative'
    output_basis: 'revenue' | 'api_value'
    window?: { start: Date; end: Date }
  }
}

export function isLocalEconomicsSnapshot(snapshot: AccountEconomicsSnapshot): snapshot is LocalEconomicsSnapshot {
  return 'local_derived' in snapshot
}

/**
 * 桌面端统一本地经济成本编排层。
 * model.ts（1.6.0 TS 移植，原子算子）逐账号 resolveCostProfile→economicCostSnapshot→convertCurrency 折 CNY 汇总。
 * 分层兜底：custom cost_profile→measured / default 公开订阅价→estimated / 无依据(metered)→unavailable。
 * 远端快照缺失时复用本地事实；窗口外推不冒充稳定采样预测。
 */
export function buildLocalEconomicsSnapshot(input: LocalEconomicsInput): LocalEconomicsSnapshot | null {
  const { accounts, billedUsdTotal, cnyPerUsd, now, series, costMultiplier } = input
  if (accounts.length === 0 && billedUsdTotal == null && input.accountCostUsdTotal == null) return null

  const safeRate = Number.isFinite(cnyPerUsd) && cnyPerUsd > 0 ? cnyPerUsd : CNY_PER_USD

  let procurementUsdTotal = 0
  let impairmentUsdTotal = 0
  let windowProcurementCny = 0
  let windowImpairmentCny = 0
  let procurementHourlyCny = 0
  let meteredCount = 0
  let unknownModeCount = 0
  let measuredCount = 0
  let estimatedCount = 0
  let unknownPlanCount = 0
  let normalCount = 0
  let rateLimitedCount = 0
  let errorCount = 0
  const membershipParts: string[] = []

  for (const { account, health, loss } of accounts) {
    const mode = resolveAccountBillingMode(account)
    if (mode === 'metered') meteredCount += 1
    if (mode === 'unknown') unknownModeCount += 1

    const plan = inferPlan(account)
    if (plan === 'unknown') unknownPlanCount += 1

    const activeLoss = loss?.active && Date.parse(loss.occurred_at) <= now ? loss : undefined
    const profile = activeLoss?.cost_profile ? activeLoss.cost_profile
      : resolveFallbackCostProfile(account, costMultiplier, safeRate)
    const snap = economicCostSnapshot(profile, activeLoss, now)
    const hasProcurement = mode === 'subscription' || profile.source === 'custom'
    const currency = activeLoss ? activeLoss.currency : profile.currency
    if (hasProcurement || activeLoss) {
      procurementUsdTotal += convertCurrency(snap.procurementCost, currency, 'USD', safeRate)
      impairmentUsdTotal += convertCurrency(snap.impairmentLoss, currency, 'USD', safeRate)
      procurementHourlyCny += convertCurrency(snap.hourlyRate, profile.currency, 'CNY', safeRate)
      if (input.window) {
        const end = new Date(Math.min(now, input.window.end.getTime()))
        windowProcurementCny += convertCurrency(procurementCostInWindow(profile, input.window.start, end, snap.accrualEndedAt), profile.currency, 'CNY', safeRate)
        const occurredAt = activeLoss ? new Date(activeLoss.occurred_at).getTime() : NaN
        if (occurredAt >= input.window.start.getTime() && occurredAt < end.getTime()) {
          windowImpairmentCny += convertCurrency(snap.impairmentLoss, currency, 'CNY', safeRate)
        }
      }
    }

    if (profile.source === 'custom') measuredCount += 1
    else if (mode === 'subscription') estimatedCount += 1

    if (health.state === 'inactive') {
      // Disabled credentials are neither healthy nor evidence of rate limiting.
    } else if (health.state === 'error' || (!health.state && health.failureCount > 0)) {
      errorCount += 1
    } else if (health.state === 'normal' || (!health.state && health.successCount > 0)) {
      normalCount += 1
    } else {
      rateLimitedCount += 1
    }
    membershipParts.push(`${account.type}:${plan}`)
  }

  const procurementCny = convertCurrency(procurementUsdTotal, 'USD', 'CNY', safeRate)
  const impairmentCny = convertCurrency(impairmentUsdTotal, 'USD', 'CNY', safeRate)
  const economicCostCny = procurementCny + impairmentCny
  const comparableEconomicCostCny = input.window ? windowProcurementCny + windowImpairmentCny : economicCostCny
  const revenue = input.outputBasis === 'revenue'
  const accountCostUsd = input.accountCostUsdTotal === undefined ? (revenue ? null : billedUsdTotal) : input.accountCostUsdTotal
  // Aggregate token values cannot be allocated across a mixed pool. The per-account summary above can.
  const meteredUsageUsd = accounts.length === 0 || unknownModeCount > 0 ? null
    : meteredCount === 0 ? 0 : meteredCount === accounts.length ? accountCostUsd : null
  const grossValueCny = billedUsdTotal == null || (revenue && meteredUsageUsd == null)
    ? null : (billedUsdTotal - (revenue ? meteredUsageUsd! : 0)) * safeRate
  const contributionMarginCny = !revenue || !input.window || grossValueCny == null ? null : grossValueCny - comparableEconomicCostCny
  const coverageHours = input.window ? Math.max(0, (Math.min(now, input.window.end.getTime()) - input.window.start.getTime()) / 3_600_000) : 0
  const billedHourly = coverageHours > 0 && billedUsdTotal != null ? billedUsdTotal / coverageHours : null
  const accountCostHourly = coverageHours > 0 && accountCostUsd != null ? accountCostUsd / coverageHours : null
  const meteredHourly = coverageHours > 0 && meteredUsageUsd != null ? meteredUsageUsd / coverageHours : null
  const contributionHourly = revenue && billedHourly != null && meteredHourly != null
    ? (billedHourly - meteredHourly) * safeRate - procurementHourlyCny : null

  const accountCount = accounts.length
  const healthyRatio = accountCount > 0 ? normalCount / accountCount : 0
  const membershipHash = simpleHash(membershipParts.join('|'))

  // 状态映射（混合保守 estimated）：
  // - 有 custom 档且全 custom→measured
  // - 有 custom + default 混合→estimated
  // - 全 default 订阅→estimated
  // - 全 metered 或全无采购依据→unavailable
  let status: DataQualityStatus
  if (measuredCount > 0 && estimatedCount === 0 && meteredCount === 0) {
    status = 'complete'
  } else if (measuredCount > 0 && (estimatedCount > 0 || meteredCount > 0)) {
    status = 'estimated'
  } else if (estimatedCount > 0) {
    status = 'estimated'
  } else {
    status = 'unavailable'
  }
  if (input.window && (billedUsdTotal != null || accountCostUsd != null)) status = 'estimated'
  if (unknownModeCount > 0 || accounts.length === 0 || (meteredCount > 0 && meteredCount < accounts.length)) status = 'partial'
  if (input.impairmentComplete === false && status === 'complete') status = 'partial'

  const sampledAt = new Date(now).toISOString()
  let warningOverride: string | undefined

  return {
    algorithm_version: COST_ALGORITHM_VERSION,
    projection_version: COST_ALGORITHM_VERSION,
    sampled_at: sampledAt,
    local_derived: { usage_cost_unit: input.window ? 'window' : 'cumulative', output_basis: input.outputBasis ?? 'api_value', window: input.window },
    scope: {},
    cny_per_usd: safeRate,
    health: {
      account_count: accountCount,
      normal_count: normalCount,
      rate_limited_count: rateLimitedCount,
      error_count: errorCount,
      healthy_ratio: healthyRatio,
      membership_hash: membershipHash,
    },
    actual: {
      billed_usd: billedUsdTotal,
      // API 等价值不是营收；只有 revenue 输入才按用户计费减上游成本。
      account_cost_usd: accountCostUsd,
      procurement_accrued_cny: procurementCny,
      impairment_loss_cny: impairmentCny,
      economic_cost_cny: economicCostCny,
      // 无窗口输入时不拿生命周期累计冒充窗口；损失账本缺失时保留采购小计。
      window_procurement_cny: input.window ? windowProcurementCny : null,
      window_impairment_loss_cny: input.window && input.impairmentComplete !== false ? windowImpairmentCny : null,
      window_economic_cost_cny: input.window ? windowProcurementCny + windowImpairmentCny : null,
      // 月采购/删除档案由视图已有账本计算，null 保留其回退入口。
      month_one_time_procurement_cny: null,
      month_one_time_purchase_count: null,
      month_deleted_one_time_purchase_count: null,
      month_deleted_recurring_procurement_cny: null,
      month_deleted_recurring_purchase_count: null,
      contribution_margin_cny: contributionMarginCny,
      cny_per_billed_usd: billedUsdTotal != null && billedUsdTotal > 0 ? comparableEconomicCostCny / billedUsdTotal : null,
      // 自用池比较 API 等价值，营收池比较毛利；二者均使用相同时间口径的采购。
      payback_ratio: grossValueCny != null && comparableEconomicCostCny > 0 ? grossValueCny / comparableEconomicCostCny : null,
      projected_contribution_cny_per_hour: contributionHourly,
      estimated_payback_hours: null,
    },
    projection: {
      version: COST_ALGORITHM_VERSION,
      confidence: billedHourly != null || accountCostHourly != null ? 'low' : 'unavailable',
      get warning() { return warningOverride ?? (input.window ? billedHourly != null || accountCostHourly != null
        ? costDataText('locallyDerivedFromTheLoadedWindowAverageNotStable')
        : costDataText('insufficientWindowUsageForecastUnavailable') : undefined) },
      set warning(value: string | undefined) { warningOverride = value },
      valid_intervals: 0,
      reset_intervals: 0,
      coverage_hours: coverageHours,
      billed_usd_per_hour: billedHourly,
      account_cost_usd_per_hour: accountCostHourly,
      capacity_adjusted_billed_usd_per_hour: billedHourly,
      capacity_adjusted_account_cost_usd_per_hour: accountCostHourly,
      capacity_adjustment: 1,
      healthy_capacity_ratio: healthyRatio,
    },
    data_quality: {
      status,
      sample_count: accountCount,
      invalid_cost_profile_count: 0,
      exchange_rate_source: `local@${safeRate}`,
      unknown_plan_count: unknownPlanCount,
    },
    series: series ?? [],
    events: [],
  }
}

export function poolUsageForecast(rows: Array<{ today: AccountWindowUsage | null }>, available: boolean, now: Date) {
  const outputUsd = available ? sumAccountUserCost(rows) : null
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)
  const dayFraction = Math.min(1, Math.max((now.getTime() - dayStart.getTime()) / (dayEnd.getTime() - dayStart.getTime()), 1 / 24))
  const dayForecastUsd = outputUsd == null ? null : outputUsd / dayFraction
  return {
    outputUsd,
    apiCostUsd: available ? sumAccountCostUsd(rows) : null,
    tokens: available ? sumAccountTokens(rows) : null,
    requests: available ? rows.reduce((sum, row) => sum + (row.today?.requests ?? 0), 0) : null,
    productive: available ? rows.filter((row) => (row.today?.requests ?? 0) > 0).length : null,
    dayForecastUsd,
    monthForecastUsd: dayForecastUsd == null ? null : dayForecastUsd * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
  }
}

// ponytail: 轻量确定性哈希（membership 指纹），不需密码学强度，djb2 够用。
function simpleHash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}
