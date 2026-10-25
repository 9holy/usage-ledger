import type { FinanceAccountSummary, FinanceCoverageInterval } from '@/api/financeLedger'
import { convertCurrency, economicCostSnapshot, isTimestampInWindow, procurementCostInWindow, summarizeKnownAmounts, type CostProfile, type CostLossStateLike, type AmountSummary } from './model'

export function sumCompleteCosts(values: Array<number | null>): number | null {
  return summarizeKnownAmounts(values).total
}

function mergedCoverage(rows: FinanceCoverageInterval[], start: number, end: number): FinanceCoverageInterval[] {
  const merged: FinanceCoverageInterval[] = []
  for (const row of rows.map(row => ({ startMs: Math.max(start, row.startMs), endMs: Math.min(end, row.endMs) }))
    .filter(row => row.endMs > row.startMs).sort((a, b) => a.startMs - b.startMs)) {
    const previous = merged.at(-1)
    if (previous && row.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, row.endMs)
    else merged.push({ ...row })
  }
  return merged
}

/** Recorded contracts replace estimates only for their own covered time; overlapping lots still accrue separately. */
export function recordedAccountCosts(input: {
  profile: CostProfile | null
  loss?: (CostLossStateLike & { currency: 'USD' | 'CNY' }) | null
  records: FinanceAccountSummary[]
  startMs: number
  endMs: number
  cnyPerUsd: number
}) {
  const { profile, loss, records, startMs, endMs, cnyPerUsd } = input
  const toCny = (amount: number, currency: 'USD' | 'CNY') => convertCurrency(amount, currency, 'CNY', cnyPerUsd)
  const sum = (get: (row: FinanceAccountSummary) => number) => records.reduce((total, row) => total + toCny(get(row), row.currency), 0)
  const coverage = mergedCoverage(records.flatMap(row => row.coverageIntervals), startMs, endMs)
  const lifetimeCoverage = mergedCoverage(records.flatMap(row => row.lifetimeCoverageIntervals), 0, endMs)
  const coveredAt = (timestamp: number) => lifetimeCoverage.some(row => row.startMs <= timestamp && timestamp < row.endMs)
  const fallback = (start: number, intervals: FinanceCoverageInterval[]) => {
    if (!profile) return 0
    let cursor = start
    let cost = 0
    for (const interval of intervals) {
      cost += procurementCostInWindow(profile, cursor, interval.startMs, loss?.active ? loss.occurred_at : null)
      cursor = interval.endMs
    }
    cost += procurementCostInWindow(profile, cursor, endMs, loss?.active ? loss.occurred_at : null)
    return toCny(cost, profile.currency)
  }
  const fallbackWindowCny = fallback(startMs, coverage)
  const fallbackLifetimeCny = fallback(0, lifetimeCoverage)
  const sourceLossMs = loss?.active ? Date.parse(loss.occurred_at) : NaN
  const useSourceLoss = sourceLossMs < endMs && !coveredAt(sourceLossMs)
  const sourceLossCny = useSourceLoss ? toCny(loss!.net_loss, loss!.currency) : 0
  const windowProcurementCny = sum(row => row.accruedExpense - row.expenseCredits) + fallbackWindowCny
  const windowLossCny = sum(row => row.recognizedLoss) + (isTimestampInWindow(sourceLossMs, startMs, endMs) ? sourceLossCny : 0)
  const lifetimeProcurementCny = sum(row => row.lifetimeAccruedExpense - row.lifetimeExpenseCredits)
    + (records.length === 0 && useSourceLoss ? toCny(loss!.accrued_cost, loss!.currency) : fallbackLifetimeCny)
  const lifetimeLossCny = sum(row => row.lifetimeRecognizedLoss) + sourceLossCny
  const fallbackRate = profile && Date.parse(profile.started_at) < endMs && !coveredAt(endMs - 1)
    ? economicCostSnapshot(profile, useSourceLoss ? loss : null, endMs).hourlyRate : 0
  const partial = records.some(row => row.unresolvedCount > 0)
  const unknownExpenseCount = records.reduce((count, row) => count + row.unresolvedCount, 0)
  const unknownHourlyCount = records.filter(row => row.ongoingHourlyExpense == null).length
  const knownWindowExpenseCny = windowProcurementCny + windowLossCny
  const knownLifetimeExpenseCny = lifetimeProcurementCny + lifetimeLossCny
  const knownHourlyCny = sum(row => row.ongoingHourlyExpense ?? 0) + (profile ? toCny(fallbackRate, profile.currency) : 0)
  const expenseSummary = (subtotal: number): AmountSummary => ({ total: partial ? null : subtotal, knownSubtotal: subtotal, unknownCount: unknownExpenseCount })
  return {
    windowProcurementCny,
    windowLossCny,
    windowExpenseCny: partial ? null : knownWindowExpenseCny,
    knownWindowExpenseCny,
    windowExpenseSummary: expenseSummary(knownWindowExpenseCny),
    lifetimeProcurementCny,
    lifetimeLossCny,
    lifetimeExpenseCny: partial ? null : knownLifetimeExpenseCny,
    knownLifetimeExpenseCny,
    lifetimeExpenseSummary: expenseSummary(knownLifetimeExpenseCny),
    hourlyCny: unknownHourlyCount ? null : knownHourlyCny,
    knownHourlyCny,
    hourlySummary: { total: unknownHourlyCount ? null : knownHourlyCny, knownSubtotal: knownHourlyCny, unknownCount: unknownHourlyCount } as AmountSummary,
    unknownExpenseCount,
    unknownHourlyCount,
    cashOutlayCny: sum(row => row.cashOutlay),
    refundsCny: sum(row => row.refunds),
    remainingPrepaidCny: records.some(row => row.remainingPrepaid == null) ? null : sum(row => row.remainingPrepaid!),
    hasRecorded: records.some(row => row.hasEnteredFacts),
    estimated: fallbackWindowCny !== 0,
    lifetimeEstimated: fallbackLifetimeCny !== 0 && !(records.length === 0 && useSourceLoss),
    rateEstimated: fallbackRate !== 0,
    partial,
  }
}
