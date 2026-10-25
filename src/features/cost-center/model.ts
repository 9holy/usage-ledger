import type { Account, WindowStats } from '@/types'
import algorithmVersionSource from '../../../ALGORITHM_VERSION?raw'
import { resolveCostMultiplier } from './costMultiplier'
import { planLabelOf, planOfLabel, subscriptionPriceUsdOf } from './planInfer'

export type BillingCycle = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'one_time'
export type CostCurrency = 'CNY' | 'USD'
export type CostSource = 'default' | 'custom'
export type CostPlan = 'free' | 'plus' | 'pro' | 'team' | 'business' | 'k12' | 'unknown'
export type AccountBillingMode = 'subscription' | 'metered' | 'unknown'
export const UNATTRIBUTED_USAGE_ACCOUNT_ID = 'usage:unattributed'

export interface CostProfile {
  amount: number
  currency: CostCurrency
  billing_cycle: BillingCycle
  started_at: string
  source: CostSource
  algorithm_version: string
}

export type CostAccount = Pick<Account, 'created_at' | 'extra' | 'credentials' | 'parent_plan_type' | 'platform' | 'type'>
export type DateInput = string | number | Date

// Used only when the daily reference-rate request and its local cache are both unavailable.
export const CNY_PER_USD = 6.8
export const USD_TO_CNY_RATE = CNY_PER_USD
// 确定性计算兜底倍率:未手动设置成本价格时,官方价 × 倍率作为 billed 兜底。
// 各 costMultiplier fallback 必须引用此常量,保持口径一致。
export const DEFAULT_COST_MULTIPLIER = 0.2
export const COST_ALGORITHM_VERSION = algorithmVersionSource.trim()
export const LEGACY_COST_ALGORITHM_VERSION = 'legacy-unversioned'

export const COST_ALGORITHM_MANIFEST = Object.freeze({
  version: COST_ALGORITHM_VERSION,
  monthly_hours: 730,
  cny_per_usd: CNY_PER_USD,
  default_market: 'US',
  default_price_currency: 'USD',
  default_price_checked_at: '2026-08-05',
  accrual: 'linear_elapsed_milliseconds',
  start_boundary: 'account_created_at',
  terminal_loss: 'confirmed_terminal_event_stops_accrual_and_recognizes_unamortized_prepaid_balance',
  account_billing_modes: Object.freeze({
    subscription: Object.freeze(['oauth', 'setup-token']),
    metered: Object.freeze(['apikey', 'upstream', 'bedrock', 'service_account']),
  }),
  metered_cost_basis: 'usage_tokens_x_model_or_channel_price_x_account_multiplier',
})

export const DEFAULT_MONTHLY_PRICES_USD: Readonly<Record<CostPlan, number>> = {
  free: 0,
  plus: 20,
  pro: 100,
  team: 25,
  business: 25,
  k12: 0,
  unknown: 0,
}

/**
 * 未知套餐兜底官方价(USD/月)。
 *
 * 实测(2026-09-04,真实 cockpit 数据):stats 222 个账号中 215 个无 plan_type,
 * inferPlan 返 'unknown' → DEFAULT_MONTHLY_PRICES_USD.unknown = 0 →
 * "倍率 × 官方价格" 恒等于 0 → 当前价格/采购费率/累计采购/标准账号成本全列空白。
 * 用户要求:未手动设置成本档案价格时,自动用 倍率 × 官方价格 兜底。
 * 因此 unknown 按最常见的订阅档(Plus $20)兜底,而不是 0。
 *
 * 注意:plan='free' 的账号官方价确实是 0(真实免费档),不套此兜底——
 * 只有"信息缺失(unknown)"才兜底,不把真实免费档虚构成付费。
 */
export const UNKNOWN_PLAN_FALLBACK_USD = 20

export const HOURS_PER_BILLING_CYCLE: Readonly<Record<Exclude<BillingCycle, 'one_time'>, number>> = {
  hourly: 1,
  daily: 24,
  weekly: 168,
  monthly: 730,
}

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000
const BILLING_CYCLES: readonly BillingCycle[] = ['hourly', 'daily', 'weekly', 'monthly', 'one_time']
const KNOWN_PLANS: readonly Exclude<CostPlan, 'unknown'>[] = [
  'free',
  'plus',
  'pro',
  'team',
  'business',
  'k12',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timestamp(value: DateInput): number | null {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(result) ? result : null
}

function stringField(record: Record<string, unknown> | undefined, key: string): unknown {
  return record?.[key]
}

export function normalizeCurrency(value: unknown): CostCurrency | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return normalized === 'CNY' || normalized === 'USD' ? normalized : null
}

export function normalizeBillingCycle(value: unknown): BillingCycle | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return BILLING_CYCLES.includes(normalized as BillingCycle) ? normalized as BillingCycle : null
}

export function normalizePlan(value: unknown): CostPlan {
  if (typeof value !== 'string') return 'unknown'

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!normalized) return 'unknown'
  if (normalized === 'k_12' || normalized === 'education' || normalized === 'edu') return 'k12'

  const compact = normalized.replace(/_/g, '')
  for (const plan of KNOWN_PLANS) {
    if (
      normalized === plan ||
      compact === plan ||
      normalized === `chatgpt_${plan}` ||
      normalized === `${plan}_plan` ||
      normalized.split('_').includes(plan)
    ) {
      return plan
    }
  }

  return 'unknown'
}

export function inferPlan(account: CostAccount): CostPlan {
  const extra = isRecord(account.extra) ? account.extra : undefined
  const credentials = isRecord(account.credentials) ? account.credentials : undefined
  const candidates: unknown[] = [
    stringField(extra, 'plan_type'),
    stringField(extra, 'subscription_tier'),
    stringField(credentials, 'plan_type'),
    stringField(credentials, 'subscription_tier'),
    stringField(credentials, 'plan'),
    stringField(credentials, 'subscription_plan'),
    stringField(credentials, 'tier'),
    account.parent_plan_type,
  ]

  for (const candidate of candidates) {
    const plan = normalizePlan(candidate)
    if (plan !== 'unknown') return plan
  }

  return 'unknown'
}

/**
 * OAuth/setup-token accounts are acquired as quota-bearing subscriptions and
 * can have a fixed procurement profile. API keys and upstream credentials are
 * pay-as-you-go: their configured usage-rate estimate is calculated from usage_logs,
 * model/channel pricing and the account multiplier, not payment evidence. A custom cost profile on a
 * metered account is therefore optional fixed overhead, never its token price.
 */
export function resolveAccountBillingMode(account: Pick<CostAccount, 'type'> & Partial<Pick<CostAccount, 'extra'>>): AccountBillingMode {
  if (isRecord(account.extra) && account.extra.cliproxy_auth_type_known === false) return 'unknown'
  if (account.type === 'oauth' || account.type === 'setup-token') return 'subscription'
  if (['apikey', 'upstream', 'bedrock', 'service_account'].includes(account.type)) return 'metered'
  return 'unknown'
}

function customCostProfile(account: CostAccount): CostProfile | null {
  const extra = isRecord(account.extra) ? account.extra : undefined
  const rawProfile = extra?.cost_profile
  if (!isRecord(rawProfile)) return null

  const amount = rawProfile.amount
  const currency = normalizeCurrency(rawProfile.currency)
  const billingCycle = normalizeBillingCycle(rawProfile.billing_cycle)
  const requestedStart = typeof rawProfile.started_at === 'string' ? rawProfile.started_at.trim() : ''
  const requestedStartMs = requestedStart ? timestamp(requestedStart) : null
  const algorithmVersion = typeof rawProfile.algorithm_version === 'string' && rawProfile.algorithm_version.trim()
    ? rawProfile.algorithm_version.trim()
    : LEGACY_COST_ALGORITHM_VERSION

  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    !currency ||
    !billingCycle ||
    requestedStartMs === null
  ) {
    return null
  }

  const joinedAtMs = timestamp(account.created_at)
  const startedAt = joinedAtMs !== null && requestedStartMs < joinedAtMs
    ? account.created_at
    : requestedStart

  return {
    amount,
    currency,
    billing_cycle: billingCycle,
    started_at: startedAt,
    source: 'custom',
    algorithm_version: algorithmVersion,
  }
}

export function resolveCostProfile(account: CostAccount): CostProfile {
  const custom = customCostProfile(account)
  if (custom) return custom

  const plan = inferPlan(account)
  return {
    amount: DEFAULT_MONTHLY_PRICES_USD[plan],
    currency: 'USD',
    billing_cycle: 'monthly',
    started_at: account.created_at,
    source: 'default',
    algorithm_version: COST_ALGORITHM_VERSION,
  }
}

/**
 * 官方价 × 倍率兜底成本档案(用户口径:"没有手动设置成本档案价格,自动用倍率*官方价格兜底")。
 *
 * 取值顺序(架构设计 【F】7.3):
 *   1. `custom`(用户手填采购价)   → **原样返回,不套倍率** ★ 语义锁定,勿动
 *   2. `plan_name` 原文能识别出官方订阅价 → 该价 × 倍率
 *      (修掉了"gemini 账号被编造成 ChatGPT Plus $20"的问题,见 planInfer.ts)
 *   3. `DEFAULT_MONTHLY_PRICES_USD[plan]` → 该价 × 倍率
 *   4. 套餐信息缺失(`unknown`)    → UNKNOWN_PLAN_FALLBACK_USD × 倍率,**并标注**
 *      `+unknown-fallback`,让用户看得见"这个数是我们猜的"
 *
 * - `plan='free'` 的账号官方价确实是 0(真实免费档),**不套 unknown 兜底** ——
 *   只有"信息缺失(unknown)"才兜底,不把真实免费档虚构成付费。
 *
 * @param multiplier 成本倍率;非法(空/≤0)时回退 DEFAULT_COST_MULTIPLIER(唯一实现在 costMultiplier.ts)。
 * @param cnyPerUsd CNY 档位(国内渠道)折算汇率;不传则 CNY 档位按"未识别"处理,不编造。
 */
export function resolveFallbackCostProfile(
  account: CostAccount,
  multiplier?: number,
  cnyPerUsd?: number | null,
): CostProfile {
  const resolved = resolveCostProfile(account)
  // ★ 用户手填的是真实采购价,再乘倍率是错的。此早返回由 model.spec.ts 锁定,勿动。
  if (resolved.source === 'custom') return resolved

  const mult = resolveCostMultiplier(multiplier)
  const plan = inferPlan(account)
  const label = planLabelOf(account)
  const labelPrice = subscriptionPriceUsdOf(label, cnyPerUsd)
  // 只有"价目表查不到 + 套餐识别不出来"才算 unknown,才走 $20 兜底
  const hasUnknownPlan = resolved.amount <= 0 && plan === 'unknown' && planOfLabel(label) === 'unknown'

  let base: number
  let versionSuffix = ''
  if (labelPrice != null) {
    // plan_name 原文识别出官方订阅价 —— 用真实价,不用"universal $20"
    base = labelPrice
    versionSuffix = '+plan-label'
  } else if (hasUnknownPlan) {
    base = UNKNOWN_PLAN_FALLBACK_USD
    versionSuffix = '+unknown-fallback'
  } else {
    base = resolved.amount
  }
  const amount = base * mult

  return {
    ...resolved,
    amount,
    algorithm_version: versionSuffix ? `${resolved.algorithm_version}${versionSuffix}` : resolved.algorithm_version,
  }
}

export function isDefaultSubscriptionCostProfile(account: CostAccount): boolean {
  return resolveAccountBillingMode(account) === 'subscription' && resolveCostProfile(account).source === 'default'
}

export function billingCycleHours(cycle: BillingCycle): number {
  return cycle === 'one_time' ? 0 : HOURS_PER_BILLING_CYCLE[cycle]
}

export function hourlyRate(profile: Pick<CostProfile, 'amount' | 'billing_cycle'>): number {
  if (!Number.isFinite(profile.amount) || profile.amount < 0 || profile.billing_cycle === 'one_time') {
    return 0
  }
  return profile.amount / HOURS_PER_BILLING_CYCLE[profile.billing_cycle]
}

export function elapsedHours(startedAt: DateInput, now: DateInput = Date.now()): number {
  const startedAtMs = timestamp(startedAt)
  const nowMs = timestamp(now)
  if (startedAtMs === null || nowMs === null || nowMs <= startedAtMs) return 0
  return (nowMs - startedAtMs) / MILLISECONDS_PER_HOUR
}

export function isStartedInLocalMonth(startedAt: DateInput, now: DateInput = Date.now()): boolean {
  const startedAtMs = timestamp(startedAt)
  const nowMs = timestamp(now)
  if (startedAtMs === null || nowMs === null || startedAtMs > nowMs) return false
  const started = new Date(startedAtMs)
  const current = new Date(nowMs)
  return started.getFullYear() === current.getFullYear() && started.getMonth() === current.getMonth()
}

export function isTimestampInWindow(value: DateInput, start: DateInput, end: DateInput): boolean {
  const valueMs = timestamp(value)
  const startMs = timestamp(start)
  const endMs = timestamp(end)
  return valueMs !== null && startMs !== null && endMs !== null && valueMs >= startMs && valueMs < endMs
}

export function procurementCostInWindow(
  profile: CostProfile,
  start: DateInput,
  end: DateInput,
  stoppedAt?: DateInput | null,
): number {
  if (!Number.isFinite(profile.amount) || profile.amount < 0) return 0
  const profileStartMs = timestamp(profile.started_at)
  const windowStartMs = timestamp(start)
  const windowEndMs = timestamp(end)
  if (profileStartMs === null || windowStartMs === null || windowEndMs === null || windowEndMs < windowStartMs) return 0
  const stoppedAtMs = stoppedAt == null ? null : timestamp(stoppedAt)
  const effectiveEndMs = stoppedAtMs === null ? windowEndMs : Math.min(windowEndMs, stoppedAtMs)
  if (profile.billing_cycle === 'one_time') {
    return profileStartMs >= windowStartMs && profileStartMs < windowEndMs && (stoppedAtMs === null || profileStartMs <= stoppedAtMs) ? profile.amount : 0
  }
  const effectiveStartMs = Math.max(windowStartMs, profileStartMs)
  if (effectiveEndMs <= effectiveStartMs) return 0
  return hourlyRate(profile) * ((effectiveEndMs - effectiveStartMs) / MILLISECONDS_PER_HOUR)
}

export function accruedCost(profile: CostProfile, now: DateInput = Date.now()): number {
  if (!Number.isFinite(profile.amount) || profile.amount < 0) return 0

  const startedAtMs = timestamp(profile.started_at)
  const nowMs = timestamp(now)
  if (startedAtMs === null || nowMs === null || nowMs < startedAtMs) return 0
  if (profile.billing_cycle === 'one_time') return profile.amount

  return hourlyRate(profile) * elapsedHours(startedAtMs, nowMs)
}

export interface CostLossStateLike {
  occurred_at: string
  accrued_cost: number
  net_loss: number
  recognized_cost: number
  active: boolean
}

export interface EconomicCostSnapshot {
  procurementCost: number
  impairmentLoss: number
  economicCost: number
  hourlyRate: number
  accrualEndedAt: string | null
}

export function economicCostSnapshot(
  profile: CostProfile,
  loss: CostLossStateLike | null | undefined,
  now: DateInput = Date.now(),
): EconomicCostSnapshot {
  const lossTime = loss?.active ? timestamp(loss.occurred_at) : null
  const asOf = timestamp(now)
  if (loss?.active && lossTime !== null && asOf !== null && lossTime <= asOf) {
    const procurementCost = Number.isFinite(loss.accrued_cost) ? Math.max(0, loss.accrued_cost) : 0
    const impairmentLoss = Number.isFinite(loss.net_loss) ? Math.max(0, loss.net_loss) : 0
    return {
      procurementCost,
      impairmentLoss,
      economicCost: procurementCost + impairmentLoss,
      hourlyRate: 0,
      accrualEndedAt: loss.occurred_at || null,
    }
  }
  const procurementCost = accruedCost(profile, now)
  return {
    procurementCost,
    impairmentLoss: 0,
    economicCost: procurementCost,
    hourlyRate: hourlyRate(profile),
    accrualEndedAt: null,
  }
}

export function convertCurrency(
  amount: number,
  from: CostCurrency,
  to: CostCurrency,
  cnyPerUsd = CNY_PER_USD,
): number {
  if (!Number.isFinite(amount)) return 0
  if (from === to) return amount
  const rate = Number.isFinite(cnyPerUsd) && cnyPerUsd > 0 ? cnyPerUsd : CNY_PER_USD
  return from === 'USD' ? amount * rate : amount / rate
}

export function currencySymbol(currency: CostCurrency): '$' | '\u00a5' {
  return currency === 'USD' ? '$' : '\u00a5'
}

export function roundCost(amount: number, fractionDigits = 2): number {
  if (!Number.isFinite(amount)) return 0
  const digits = Math.max(0, Math.min(8, Math.trunc(fractionDigits)))
  const factor = 10 ** digits
  return Math.round((amount + Number.EPSILON) * factor) / factor
}

/**
 * 观察窗口的逐账号用量。与 `WindowStats` 同构,但「成本 / Token」允许 `null`。
 *
 * 为什么不能复用 `WindowStats`:它的 `tokens` / `cost` 是必填 `number`,于是"该账号
 * 在这个窗口没有成本快照"只能被写成 `0` —— 而 `0` 在界面上是**绿色实测的 `$0.0000`**,
 * 等于断言"确定没花钱"。cockpit 快照缺该账号时,日志只给出真实请求数,
 * 成本与 Token 确实不可测,必须能表达"无数据"(红线:不可测的值不得用 0 冒充)。
 */
export type AccountWindowUsage = Omit<WindowStats, 'tokens' | 'cost' | 'standard_cost' | 'user_cost'> & {
  tokens: number | null
  cost: number | null
  standard_cost?: number | null
  user_cost?: number | null
  known_cost?: number
  known_standard_cost?: number
  unknown_cost_requests?: number
}

/**
 * 用户计费只认源提供的 user_cost；标准参考价不是收入。
 * 缺失时返回 null，真实 0 保留。参考价值使用 standardReferenceCost。
 */
export function actualUserCost(stats: { user_cost?: number | null; standard_cost?: number | null }): number | null {
  if (typeof stats.user_cost === 'number' && Number.isFinite(stats.user_cost)) return stats.user_cost
  return null
}

export function standardReferenceCost(stats: { standard_cost?: number | null }): number | null {
  return typeof stats.standard_cost === 'number' && Number.isFinite(stats.standard_cost) ? stats.standard_cost : null
}

/** A signed known subtotal is not a lower bound: an unresolved adjustment can be a credit. */
export interface AmountSummary { total: number | null; knownSubtotal: number; unknownCount: number }

export function summarizeKnownAmounts(values: Iterable<number | null | undefined>): AmountSummary {
  let knownSubtotal = 0
  let unknownCount = 0
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) knownSubtotal += value
    else unknownCount += 1
  }
  return { total: unknownCount ? null : knownSubtotal, knownSubtotal, unknownCount }
}

export function summarizeAccountUserCost(rows: Array<{ today: AccountWindowUsage | null }>): AmountSummary {
  return summarizeKnownAmounts(rows.map(row => row.today ? actualUserCost(row.today) : 0))
}

export function summarizeAccountReferenceCost(rows: Array<{ today: AccountWindowUsage | null }>): AmountSummary {
  const result = summarizeKnownAmounts(rows.map(row => row.today ? standardReferenceCost(row.today) : 0))
  for (const row of rows) if (row.today && standardReferenceCost(row.today) == null) result.knownSubtotal += row.today.known_standard_cost ?? 0
  return result
}

export function summarizeAccountCostUsd(rows: Array<{ today: AccountWindowUsage | null }>): AmountSummary {
  const result = summarizeKnownAmounts(rows.map(row => row.today ? row.today.cost : 0))
  for (const row of rows) if (row.today && (row.today.cost == null || !Number.isFinite(row.today.cost))) result.knownSubtotal += row.today.known_cost ?? 0
  return result
}

export function summarizeAccountTokens(rows: Array<{ today: AccountWindowUsage | null }>): AmountSummary {
  return summarizeKnownAmounts(rows.map(row => row.today ? row.today.tokens : 0))
}

/**
 * 逐账号聚合的**唯一入口**(2026-09-22)。
 *
 * 起因:视图层此前是
 * `rows.reduce((sum, row) => sum + (row.today ? actualUserCost(row.today) ?? 0 : 0), 0)`。
 * 而 `actualUserCost` 的契约(见上,2026-09-16 修)明确要求「不可用 ⇒ 返回 `null`,
 * 由调用方走『无数据』分支」—— 聚合处的 `?? 0` 把契约又折了回去:某账号的
 * `user_cost` 拿不到时,界面显示的是**其余账号之和**,
 * 看不出少了谁、也看不出这是个偏小的数,而它挂在绿色实测态上。
 *
 * 口径两态必须分开:
 * - 该账号**该窗口无记录**(`today == null`)⇒ 确为 0,**计入**(真实测量值,不是未知);
 * - 有记录、但该字段不可用 ⇒ **整体不可测**,返回 `null`(null 传播,不用 0 补齐)。
 *
 * 只对**类型自己声明为 `| null` 的字段**做这件事:那正是 `AccountWindowUsage` 相对
 * `WindowStats` 存在的理由(见上 `AccountWindowUsage` 注释)。`requests` 不是可空字段,
 * 它的 `|| 0` 只可能折叠真实 0,故不在本入口内。
 */
export function sumAccountUserCost(rows: Array<{ today: AccountWindowUsage | null }>): number | null {
  return summarizeAccountUserCost(rows).total
}

/** 「账号成本」逐账号聚合。口径同 `sumAccountUserCost`(`cost` 的 null 是**有意设计**,不是缺省)。 */
export function sumAccountCostUsd(rows: Array<{ today: AccountWindowUsage | null }>): number | null {
  return summarizeAccountCostUsd(rows).total
}

/** 「Token 数」逐账号聚合。口径同 `sumAccountUserCost`。 */
export function sumAccountTokens(rows: Array<{ today: AccountWindowUsage | null }>): number | null {
  return summarizeAccountTokens(rows).total
}

export function formatMoney(
  amount: number,
  currency: CostCurrency,
  fractionDigits = 2,
): string {
  const digits = Math.max(0, Math.min(8, Math.trunc(fractionDigits)))
  const safeAmount = Number.isFinite(amount) ? amount : 0
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(safeAmount)
  return `${currencySymbol(currency)}${formatted}`
}
