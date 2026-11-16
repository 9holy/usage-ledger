import type { AccountUsageCycle } from '@/api/usageAccounts'
import { monitorAutomaticPriceSummary } from '@/api/usageMonitor'

export function projectAccountQuotaCycle(cycle: AccountUsageCycle, tool: string) {
  const finalized = cycle.usedPercent === 100 && cycle.exhaustedAtMs != null && !cycle.exhaustionUnknown
  const result = { quotes: [] as Array<{ currency: string; observedSubtotal: number; additionalSubtotal: number; projectedSubtotal: number }>, partial: false, coveredRequests: 0, requestCount: 0, finalized, reason: '' }
  const used = cycle.usedPercent
  if (used == null || used <= 0) return { ...result, reason: 'waitingForUsageRecordsInThisCycle' }
  if (!finalized && (used >= 100 || cycle.exhaustionUnknown || cycle.exhaustedAtMs != null)) return { ...result, reason: 'cycleQuotaExhaustedExtraUsageCannotDetermineTheTotal' }
  const snapshot = cycle.quotaSnapshot
  const cutoff = (finalized ? cycle.exhaustedAtMs! : cycle.quotaObservedAtMs) + 1
  if (!snapshot || snapshot.startMs !== cycle.startMs || snapshot.endMs !== cycle.endMs || cycle.observedEndMs < cutoff || snapshot.observedEndMs !== cutoff) return { ...result, reason: 'synchronizingQuotaReadings' }
  const subscription = tool === 'codex' && snapshot.billingTotals ? snapshot.billingTotals.subscription : snapshot.totals
  if (!subscription?.requestCount) return { ...result, reason: 'subscriptionUsageAwaitingEvidence' }
  const summary = monitorAutomaticPriceSummary(subscription)
  result.quotes = summary.currencies.filter(row => row.identifiedSubtotal != null).map(row => {
    const observedSubtotal = row.identifiedSubtotal!, projectedSubtotal = observedSubtotal * 100 / used
    return { currency: row.currency, observedSubtotal, projectedSubtotal, additionalSubtotal: projectedSubtotal - observedSubtotal }
  })
  if (!result.quotes.length) return { ...result, reason: 'noIdentifiedBillableUsageYet' }
  result.partial = !!snapshot.sourceCoverageIncomplete || !summary.complete || subscription.requestCount !== snapshot.totals.requestCount
  result.coveredRequests = summary.coveredRequests
  result.requestCount = snapshot.totals.requestCount
  return result
}
