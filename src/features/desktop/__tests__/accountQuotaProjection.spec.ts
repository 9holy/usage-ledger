import { expect, it } from 'vitest'
import type { AccountUsageCycle } from '@/api/usageAccounts'
import { projectAccountQuotaCycle } from '../accountQuotaProjection'

function cycle(): AccountUsageCycle {
  const totals = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 1, pricedCostUsd: 10, unpricedRequests: 0, incompleteRequests: 0, cacheHitRatio: 0, outputTokensPerSecond: 0, automaticPriceSummary: { byCurrency: { USD: { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: 10, requestedRequests: 1, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 } }, byMode: { standard: { responseRequests: 0, requestedRequests: 1, coveredRequests: 1, unknownRequests: 0, byCurrency: { USD: { amount: 10, requestCount: 1 } } } } } }
  const sample = { startMs: 0, endMs: 10000, observedEndMs: 2001, totals }
  return { ...sample, observedEndMs: 4000, quotaSnapshot: sample, resetAtMs: 10000, quotaObservedAtMs: 2000, usedPercent: 20, exhaustedAtMs: null, exhaustionUnknown: false, current: true }
}

it('projects the observation-aligned sample without using later usage amounts', () => {
  const value = cycle()
  value.totals = { ...value.totals, pricedCostUsd: 999 }
  expect(projectAccountQuotaCycle(value, 'codex').quotes).toEqual([{ currency: 'USD', observedSubtotal: 10, projectedSubtotal: 50, additionalSubtotal: 40 }])
  value.quotaSnapshot!.observedEndMs = 4000
  expect(projectAccountQuotaCycle(value, 'codex')).toMatchObject({ quotes: [], reason: 'synchronizingQuotaReadings' })
})

it('excludes non-subscription usage and refuses unknown exhaustion or zero percentages', () => {
  const value = cycle()
  value.quotaSnapshot!.billingTotals = { api: value.quotaSnapshot!.totals }
  expect(projectAccountQuotaCycle(value, 'codex').reason).toBe('subscriptionUsageAwaitingEvidence')
  value.usedPercent = 0
  expect(projectAccountQuotaCycle(value, 'claude').quotes).toEqual([])
  value.usedPercent = 100; value.exhaustedAtMs = 2000
  expect(projectAccountQuotaCycle(value, 'claude')).toMatchObject({ finalized: true, quotes: [{ projectedSubtotal: 10 }] })
  value.exhaustionUnknown = true
  expect(projectAccountQuotaCycle(value, 'claude').quotes).toEqual([])
})

it('marks a quota projection partial while source requests remain unmatched',()=>{
  const value=cycle();value.quotaSnapshot!.sourceCoverageIncomplete=true
  expect(projectAccountQuotaCycle(value,'claude')).toMatchObject({partial:true,quotes:[{observedSubtotal:10,projectedSubtotal:50}]})
})
