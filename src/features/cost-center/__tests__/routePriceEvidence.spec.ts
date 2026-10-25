import { afterEach, describe, expect, it } from 'vitest'
import type { PriceEvidence, MonitorCostEstimate } from '@/api/usageMonitor'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { CockpitRequestLogGroup, CockpitRequestLogSummary } from '@/api/cockpit'
import { setActiveConnection } from '@/api/url'
import { useCostCenterData } from '../useCostCenterData'
import { authIndexToAccountId } from '../cliproxyAdapter'
import { applyCockpitRequestLogCost, cockpitRequestLogGroupCost, cockpitRequestLogGroupsToOpsRoutes, cockpitOpsRoutesToModelRoutes, filterCockpitRequestLogByAccount } from '../cockpitAdapter'
import { cockpitEffectivePriceSets } from '../cockpitPriceBook'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'

const now = new Date('2026-10-16T12:00:00Z')
function evidence(input: number, patch: Partial<PriceEvidence> = {}): PriceEvidence {
  return { version: 'fixture', sourceUrl: 'https://example.test/pricing', checkedAt: '2026-10-16', model: 'fixture', mode: 'standard', contextTier: 'base',
    inputPerMillion: input, cachedPerMillion: null, cacheWrite5mPerMillion: null, cacheWrite1hPerMillion: null, outputPerMillion: 4,
    pricingProvider: 'openai', catalogRevision: 'fixture-revision', ...patch }
}
function quote(amount: number, prices: PriceEvidence): MonitorCostEstimate { return { usd: amount, reason: null, evidence: prices } }
function event(patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return { requested_at: now.getTime() - 1000, provider: 'route-one', executor_type: 'OpenAICompatExecutor', model: 'fixture', alias: 'fixture', auth_index: 'account-a', auth_type: 'apikey', source: '',
    reasoning_effort: '', service_tier: 'auto', latency_ms: 1, ttft_ms: 1, failed: false, status_code: 200, input_tokens: 100, output_tokens: 20, reasoning_tokens: 0,
    cached_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 120, primary_used_percent: null, primary_reset_at: null, primary_used_tokens: null,
    primary_remaining_tokens: null, primary_limit_tokens: null, secondary_used_percent: null, secondary_reset_at: null, secondary_used_tokens: null, secondary_remaining_tokens: null, secondary_limit_tokens: null,
    priceQuote: quote(2, evidence(2)), ...patch }
}
function group(patch: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return { model: 'fixture', accountId: 'account-a', apiKeyId: '', firstMs: 100, lastMs: 200, requests: 1, success: 1, error: 0,
    stdNormalInput: 1_000_000, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    rateLimited: 0, upstreamError: 0, clientCanceled: 0, priceQuotes: [quote(2, evidence(2))], ...patch }
}
function summary(groups: CockpitRequestLogGroup[]): CockpitRequestLogSummary {
  return { available: true, rowCount: groups.reduce((n,g) => n + g.requests, 0), windowStartMs: 100, windowEndMs: 200, bucketHours: 1, groups, cells: [], bucketLatencies: [] }
}
afterEach(() => setActiveConnection(null))

describe('route price evidence follows the actual model/account/window quote', () => {
  it('conserves small integer token allocations and keeps the actual source-estimate basis', () => {
    const data = summary([group({ accountId: '', requests: 3, stdNormalInput: 2, stdCached: 2, stdOutput: 1, estimatedCostUsd: 9, priceQuotes: [{ usd: null, reason: 'unknown_mode', evidence: null }] })])
    const costs = cockpitRequestLogGroupCost(data, {}, 0.2)
    const base = cockpitOpsRoutesToModelRoutes(cockpitRequestLogGroupsToOpsRoutes(data.groups), []).routes[0]
    const rows = [0, 1, 2].map(index => ({ ...base, key: `interface-${index}`, requests: 1 }))
    applyCockpitRequestLogCost(rows, costs)
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(4)
    expect(rows.reduce((sum, row) => sum + row.cacheReadTokens, 0)).toBe(2)
    expect(rows.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(1)
    expect(rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(5)
    expect(rows.reduce((sum, row) => sum + (row.standardCost ?? 0), 0)).toBeCloseTo(9)
    expect(rows.reduce((sum, row) => sum + (row.accountCost ?? 0), 0)).toBeCloseTo(1.8)
    expect(rows.every(row => row.costBasis?.includes('估算') && !row.costBasis.includes('自算'))).toBe(true)
  })
  it('retains distinct providers, contexts and scenarios without duplicate per-request evidence or out-of-window borrowing', () => {
    setActiveConnection({ id: 'local', type: 'cliproxy', name: 'fixture', baseUrl: 'http://127.0.0.1:8317', apiKey: '', lastUsed: 0 })
    const scenarios: MonitorCostEstimate = { usd: null, reason: 'actual_mode_unknown', evidence: null, scenarios: [
      { mode: 'standard', scenarioKey: 'standard', amount: 2, evidence: evidence(2) },
      { mode: 'fast', scenarioKey: 'fast', amount: 4, evidence: evidence(4, { mode: 'fast' }) },
    ] }
    const events = [event(), event(), event({ priceQuote: quote(3, evidence(3, { contextTier: '>272000' })) }), event({ priceQuote: scenarios }),
      event({ auth_index: 'account-b', priceQuote: quote(99, evidence(99)) }),
      event({ provider: 'route-two', priceQuote: quote(300, evidence(300, { pricingProvider: 'anthropic' })) }),
      event({ requested_at: now.getTime() - 2 * 3600000, priceQuote: quote(999, evidence(999)) })]
    const data = useCostCenterData(); data.cockpitCostMultiplier.value = 0.2
    data.loadFromCliproxy([], null, null, events, {}, {}, '30d', '1h', 7, now, true)
    expect(data.modelRoutes.value).toHaveLength(3)
    const selected = data.modelRoutes.value.filter(row => row.accountId === authIndexToAccountId('account-a'))
    const first = selected.find(row => row.provider === 'route-one')!
    expect(first.priceEvidence).toHaveLength(4)
    expect(first.priceEvidence?.map(p => [p.quoteKind, p.mode, p.contextTier, p.inputPerMillion])).toEqual([
      ['reference','standard','base',2], ['reference','standard','>272000',3], ['scenario','standard','base',2], ['scenario','fast','base',4],
    ])
    expect(first.priceEvidence?.filter(p => p.quoteKind === 'scenario').every(p => !p.usedForCost)).toBe(true)
    expect(first.standardCost).toBeNull(); expect(first.knownStandardCost).toBeCloseTo(7); expect(first.knownAccountCost).toBeCloseTo(1.4)
    expect(selected.find(row => row.provider === 'route-two')?.priceEvidence?.map(p => p.inputPerMillion)).toEqual([300])
    expect(data.modelRoutes.value.find(row => row.accountId === authIndexToAccountId('account-b'))?.priceEvidence?.map(p => p.inputPerMillion)).toEqual([99])
    expect(data.modelRoutes.value.flatMap(row => row.priceEvidence ?? []).some(p => p.inputPerMillion === 999)).toBe(false)
  })

  it('preserves anonymous fees/reference, partial subtotals, account filters and custom-local priority in Cockpit', () => {
    const partial: MonitorCostEstimate = { usd: null, reason: 'unknown_mode', evidence: null, scenarios: [{ mode: 'fast', scenarioKey: 'fast', amount: 10, evidence: evidence(10, { mode: 'fast' }) }] }
    const data = summary([group(), group({ priceQuotes: [quote(3, evidence(3, { contextTier: '>272000' }))] }),
      group({ accountId: 'account-b', priceQuotes: [quote(99, evidence(99))] }),
      group({ accountId: '', priceQuotes: [quote(5, evidence(5)), partial] }),
      group({ model: 'other-model', accountId: '', priceQuotes: [quote(11, evidence(11, { model: 'other-model' }))] })])
    const costs = cockpitRequestLogGroupCost(data, {}, 0.2)
    expect(costs.has(`fixture\u0000${UNATTRIBUTED_USAGE_ACCOUNT_ID}`)).toBe(true)
    const rows = cockpitOpsRoutesToModelRoutes(cockpitRequestLogGroupsToOpsRoutes(data.groups), [], undefined, 0.2, undefined, costs).routes
    const anonymous = rows.find(row => row.accountId == null && row.requestedModel === 'fixture')!
    expect(anonymous.standardCost).toBeNull(); expect(anonymous.accountCost).toBeNull()
    expect(anonymous.knownStandardCost).toBe(5); expect(anonymous.knownAccountCost).toBe(1)
    expect(anonymous.priceEvidence?.map(p => p.inputPerMillion)).toEqual([5, 10])
    expect(anonymous.priceEvidence?.every(p => !p.usedForCost)).toBe(true)
    const other = rows.find(row => row.requestedModel === 'other-model')!
    expect(other.accountId).toBeNull(); expect(other.standardCost).toBe(11); expect(other.accountCost).toBeCloseTo(2.2)
    expect(other.priceEvidence?.map(p => p.inputPerMillion)).toEqual([11])
    const selectedId = rows.find(row => row.priceEvidence?.some(p => p.inputPerMillion === 2))!.accountId!
    const selected = filterCockpitRequestLogByAccount(data, selectedId)!
    const scoped = cockpitOpsRoutesToModelRoutes(cockpitRequestLogGroupsToOpsRoutes(selected.groups), [], undefined, 0.2, undefined, cockpitRequestLogGroupCost(selected, {}, 0.2)).routes
    expect(scoped).toHaveLength(1); expect(scoped[0].standardCost).toBe(5); expect(scoped[0].accountCost).toBe(1)
    expect(scoped[0].priceEvidence?.map(p => p.contextTier)).toEqual(['base','>272000'])
    const custom = cockpitEffectivePriceSets([{ modelId: 'fixture', inputUsdPerMillion: 7, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 }])
    const customCosts = cockpitRequestLogGroupCost(selected, custom, 0.2)
    expect([...customCosts.values()][0].priceEvidence).toHaveLength(0)
    expect([...customCosts.values()][0].referenceCost).toBeCloseTo(14)
  })
})
