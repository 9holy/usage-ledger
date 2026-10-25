import './costDataI18n'
import { describe, expect, it } from 'vitest'
import type { FinanceAccountSummary } from '@/api/financeLedger'
import { recordedAccountCosts, sumCompleteCosts } from '../recordedCosts'
import { DEFAULT_COST_MULTIPLIER, isTimestampInWindow, procurementCostInWindow, resolveFallbackCostProfile, type CostProfile } from '../model'

const day = 86_400_000
const start = Date.parse('2026-10-01T00:00:00Z')
const profile: CostProfile = { amount: 730, currency: 'CNY', billing_cycle: 'monthly', started_at: new Date(start).toISOString(), source: 'default', algorithm_version: 'test' }
function record(overrides: Partial<FinanceAccountSummary> = {}): FinanceAccountSummary {
  return {
    accountId: '1', currency: 'CNY', cashOutlay: 100, refunds: 0, accruedExpense: 40,
    recognizedLoss: 60, expenseCredits: 0, netExpense: 100, remainingPrepaid: 0,
    ongoingHourlyExpense: 0, unresolvedCount: 0, hasEnteredFacts: true,
    terminationLoss: 60, amortizedExpense: 40, missingCoverageCount: 0,
    coverageIntervals: [{ startMs: start, endMs: start + 10 * day }],
    lifetimeAccruedExpense: 40, lifetimeRecognizedLoss: 60, lifetimeExpenseCredits: 0,
    lifetimeCoverageIntervals: [{ startMs: start, endMs: start + 10 * day }],
    ...overrides,
  }
}
const input = { profile, records: [record()], startMs: start, endMs: start + 10 * day, cnyPerUsd: 7 }

describe('recorded procurement integration', () => {
  it('replaces estimates in covered periods, including the known zero after termination', () => {
    const result = recordedAccountCosts(input)
    expect(result.windowExpenseCny).toBe(100)
    expect(result.lifetimeExpenseCny).toBe(100)
    expect(result.hourlyCny).toBe(0)
    expect(result.estimated).toBe(false)
  })
  it('estimates only uncovered time, with overlapping contracts excluded once', () => {
    const first = record({ coverageIntervals: [{ startMs: start + day, endMs: start + 3 * day }], lifetimeCoverageIntervals: [{ startMs: start + day, endMs: start + 3 * day }] })
    const second = record({ currency: 'USD', coverageIntervals: [{ startMs: start + 2 * day, endMs: start + 4 * day }], lifetimeCoverageIntervals: [{ startMs: start + 2 * day, endMs: start + 4 * day }] })
    const result = recordedAccountCosts({ ...input, records: [first, second], endMs: start + 5 * day })
    expect(result.windowExpenseCny).toBeCloseTo(100 + 700 + 48)
    expect(result.estimated).toBe(true)
  })
  it('expense credits reduce realized cost but do not become negative forecast rates', () => {
    const result = recordedAccountCosts({ ...input, records: [record({ refunds: 20, expenseCredits: 20, netExpense: 80, lifetimeExpenseCredits: 20 })] })
    expect(result.windowExpenseCny).toBe(80)
    expect(result.lifetimeExpenseCny).toBe(80)
    expect(result.refundsCny).toBe(20)
    expect(result.hourlyCny).toBe(0)
  })
  it('retains orphaned records and unknown credit topups without invented fixed usage expense', () => {
    const result = recordedAccountCosts({ ...input, profile: null, records: [record({ accruedExpense: 0, recognizedLoss: 0, lifetimeAccruedExpense: 0, lifetimeRecognizedLoss: 0, netExpense: null, remainingPrepaid: null, ongoingHourlyExpense: null, unresolvedCount: 1, coverageIntervals: [], lifetimeCoverageIntervals: [] })] })
    expect(result.cashOutlayCny).toBe(100)
    expect(result.windowExpenseCny).toBeNull()
    expect(result.lifetimeExpenseCny).toBeNull()
    expect(result.hourlyCny).toBeNull()
    expect(sumCompleteCosts([100, result.windowExpenseCny])).toBeNull()
    expect(result.remainingPrepaidCny).toBeNull()
    expect(result.partial).toBe(true)
    expect(result.windowExpenseSummary).toEqual({ total: null, knownSubtotal: 0, unknownCount: 1 })
  })
  it('retains signed known expense credits when another record is unresolved', () => {
    const result = recordedAccountCosts({ ...input, profile: null, records: [record({ accruedExpense: 0, recognizedLoss: 0, expenseCredits: 20, lifetimeAccruedExpense: 0, lifetimeRecognizedLoss: 0, lifetimeExpenseCredits: 20, netExpense: null, remainingPrepaid: null, ongoingHourlyExpense: null, unresolvedCount: 1 })] })
    expect(result.windowExpenseSummary).toEqual({ total: null, knownSubtotal: -20, unknownCount: 1 })
    expect(result.lifetimeExpenseSummary).toEqual({ total: null, knownSubtotal: -20, unknownCount: 1 })
    expect(result.hourlySummary).toEqual({ total: null, knownSubtotal: 0, unknownCount: 1 })
  })
  it('does not double-count a source loss inside a locally recorded contract', () => {
    const loss = { active: true, occurred_at: new Date(start + 4 * day).toISOString(), accrued_cost: 40, net_loss: 60, recognized_cost: 100, currency: 'CNY' as const }
    expect(recordedAccountCosts({ ...input, loss }).windowExpenseCny).toBe(100)
    expect(recordedAccountCosts({ ...input, loss, records: [] }).lifetimeExpenseCny).toBe(100)
  })
  it('uses half-open windows without removing the inclusive business termination instant', () => {
    const oneTime = { ...profile, billing_cycle: 'one_time' as const, amount: 50, started_at: new Date(start + day).toISOString() }
    expect(isTimestampInWindow(start + day, start, start + day)).toBe(false)
    expect(procurementCostInWindow(oneTime, start, start + day)).toBe(0)
    expect(procurementCostInWindow(oneTime, start + day, start + 2 * day, start + day)).toBe(50)
  })
  it('defaults to 0.2 without changing valid overrides or custom procurement', () => {
    const account = { id: 1, type: 'oauth', created_at: profile.started_at, extra: { plan_type: 'plus' } } as Parameters<typeof resolveFallbackCostProfile>[0]
    expect(DEFAULT_COST_MULTIPLIER).toBe(0.2)
    expect(resolveFallbackCostProfile(account).amount).toBe(4)
    expect(resolveFallbackCostProfile(account, 0.7).amount).toBe(14)
    expect(resolveFallbackCostProfile({ ...account, extra: { cost_profile: { ...profile, source: 'custom', amount: 88 } } }).amount).toBe(88)
  })
})
