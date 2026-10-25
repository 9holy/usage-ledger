import './costDataI18n'
import { describe, expect, it } from 'vitest'
import { buildLocalEconomicsSnapshot, summarizeOperatingCosts, type OperatingAccount } from '../costEngine'
import { economicCostSnapshot, resolveAccountBillingMode, summarizeAccountCostUsd, summarizeKnownAmounts, type AccountWindowUsage } from '../model'

const scope = { source: 'sub2api' as const, instanceId: 'saved-A' }
const startMs = Date.parse('2026-10-01T00:00:00Z'), endMs = startMs + 10 * 3_600_000
const row = (overrides: Partial<OperatingAccount> = {}): OperatingAccount => ({ scope, accountId: '1', billingMode: 'subscription', revenueUsd: 100, meteredCostUsd: 1000, referenceValueUsd: 1000, fixedExpenseCny: 40, knownFixedExpenseCny: 40, fixedHourlyCny: 1, knownFixedHourlyCny: 1, ...overrides })
const summary = (accounts: OperatingAccount[], extra = {}) => summarizeOperatingCosts({ scope, accounts, startMs, endMs, cnyPerUsd: 7, outputBasis: 'revenue', ...extra })

describe('independent operating costs', () => {
  it('does not add subscription API value to procurement and does not multiply resolved metered cost twice', () => {
    const result = summary([row(), row({ accountId: '2', billingMode: 'metered', revenueUsd: 50, meteredCostUsd: 10, referenceValueUsd: 100, fixedExpenseCny: 5, knownFixedExpenseCny: 5, fixedHourlyCny: 0.5, knownFixedHourlyCny: 0.5 })])
    expect(result.expenseCny).toEqual({ total: 115, knownSubtotal: 115, unknownCount: 0 })
    expect(result.meteredExpenseCny.total).toBe(70)
    expect(result.referenceValueUsd.total).toBe(1100)
    expect(result.contributionCny).toBe(935)
    expect(result.hourlyExpenseCny.total).toBe(8.5)
    expect(result.projectedContributionCnyPerHour).toBe(96.5)
    expect(result.estimatedMeteredCount).toBe(1)
  })
  it('uses the shared fallback only for unresolved metered rates, never for entered fixed procurement', () => {
    const accounts = [row({ billingMode: 'metered', meteredCostUsd: null, referenceValueUsd: 100, fixedExpenseCny: 80, knownFixedExpenseCny: 80 })]
    expect(summary(accounts).expenseCny.total).toBe(220)
    expect(summary(accounts, { costMultiplier: 0.3 }).expenseCny.total).toBe(290)
  })
  it('keeps partial parsed costs and signed credits without inventing a complete profit or lower bound', () => {
    const result = summary([row({ billingMode: 'metered', meteredCostUsd: null, knownMeteredCostUsd: 5, referenceValueUsd: null, knownReferenceValueUsd: 10, fixedExpenseCny: null, knownFixedExpenseCny: -20, fixedHourlyCny: null, knownFixedHourlyCny: 0.5 })])
    expect(result.expenseCny).toEqual({ total: null, knownSubtotal: 15, unknownCount: 2 })
    expect(result.referenceValueUsd).toEqual({ total: null, knownSubtotal: 10, unknownCount: 1 })
    expect(result.hourlyExpenseCny).toEqual({ total: null, knownSubtotal: 4, unknownCount: 2 })
    expect(result.contributionCny).toBeNull()
    expect(result.projectedContributionCnyPerHour).toBeNull()
  })
  it('does not guess historical usage-only account types or mix another instance into the result', () => {
    const result = summary([row({ accountId: 'deleted-9', billingMode: 'unknown', meteredCostUsd: 9 }), row({ scope: { ...scope, instanceId: 'saved-B' }, fixedExpenseCny: 9999 })])
    expect(result.accountCount).toBe(1)
    expect(result.expenseCny).toEqual({ total: null, knownSubtotal: 40, unknownCount: 1 })
    expect(result.unclassifiedUsageCostUsd.total).toBe(9)
    expect(result.unknownBillingModeCount).toBe(1)
    expect(result.referenceValueUsd.total).toBe(1000)
    expect(resolveAccountBillingMode({ type: undefined } as never)).toBe('unknown')
  })
  it('does not turn self-use API value into revenue or an absent account list into zero expense', () => {
    const result = summary([row()], { outputBasis: 'api_value' })
    expect(result.revenueUsd.total).toBeNull()
    expect(result.contributionCny).toBeNull()
    expect(result.referenceValueUsd.total).toBe(1000)
    expect(summary([]).expenseCny.total).toBeNull()
    const legacy = buildLocalEconomicsSnapshot({ accounts: [], billedUsdTotal: 5, accountCostUsdTotal: 2, outputBasis: 'revenue', cnyPerUsd: 7, now: endMs, window: { start: new Date(startMs), end: new Date(endMs) } })!
    expect(legacy.actual.billed_usd).toBe(5)
    expect(legacy.actual.contribution_margin_cny).toBeNull()
  })
  it('retains known usage subtotals and does not stop past accrual for a future loss', () => {
    const usage = { cost: null, known_cost: 3, requests: 2 } as AccountWindowUsage
    expect(summarizeAccountCostUsd([{ today: usage }, { today: { ...usage, cost: 4 } }])).toEqual({ total: null, knownSubtotal: 7, unknownCount: 1 })
    expect(summarizeKnownAmounts([100, null, -20])).toEqual({ total: null, knownSubtotal: 80, unknownCount: 1 })
    const snap = economicCostSnapshot({ amount: 730, currency: 'CNY', billing_cycle: 'monthly', started_at: new Date(startMs).toISOString(), source: 'custom', algorithm_version: 'fixture' }, { active: true, occurred_at: new Date(endMs + 1000).toISOString(), accrued_cost: 100, net_loss: 60, recognized_cost: 160 }, endMs)
    expect(snap.procurementCost).toBe(10)
    expect(snap.impairmentLoss).toBe(0)
    expect(snap.hourlyRate).toBe(1)
  })
  it('keeps known costs without declaring complete zero procurement when management is unavailable', () => {
    const result = summary([row()], { accountInventoryComplete: false })
    expect(result.expenseCny).toEqual({ total: null, knownSubtotal: 40, unknownCount: 1 })
    expect(result.fixedHourlyCny).toEqual({ total: null, knownSubtotal: 1, unknownCount: 1 })
    expect(result.contributionCny).toBeNull()
    expect(summary([], { accountInventoryComplete: false }).expenseCny).toEqual({ total: null, knownSubtotal: 0, unknownCount: 1 })
  })
})
