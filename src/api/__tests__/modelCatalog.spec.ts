import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getModelCatalogStatus, refreshModelCatalog, quoteModelCatalogBatch } from '../modelCatalog'
import { cliproxyQuoteInput, getCliproxyUsageEvents, getCliproxyUsageSnapshot, type CliproxyUsageEvent } from '../cliproxy/cpaData'
import { getCockpitRequestLogSummary, quoteCockpitRequestLogSummary, type CockpitRequestLogGroup, type CockpitRequestLogSummary } from '../cockpit'
import { cliproxyEventsToModelStats, pricedEventCostUsd, resolveModelPricing } from '@/features/cost-center/cliproxyAdapter'
import { cockpitRequestLogToAccountStats, cockpitRequestLogToModelStats, cockpitSplitCostUsd } from '@/features/cost-center/cockpitAdapter'
import { cockpitEffectivePriceSets } from '@/features/cost-center/cockpitPriceBook'
import { monitorRequestCost, monitorScenarioLabel, monitorTotalCost, type MonitorCostEstimate, type PriceEvidence } from '../usageMonitor'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

function event(patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1, requested_at: 1_790_000_000_000, provider: 'openai-compatible-route', executor_type: 'OpenAICompatExecutor',
    model: 'fixture', alias: 'fixture', auth_index: 'fixture', auth_type: 'apikey', source: 'fixture',
    reasoning_effort: '', service_tier: 'auto', latency_ms: 1, ttft_ms: 1, failed: false, status_code: 200,
    input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, cached_tokens: 30, cache_read_tokens: 30,
    cache_creation_tokens: 10, total_tokens: 120, primary_used_percent: null, primary_reset_at: null,
    primary_used_tokens: null, primary_remaining_tokens: null, primary_limit_tokens: null,
    secondary_used_percent: null, secondary_reset_at: null, secondary_used_tokens: null,
    secondary_remaining_tokens: null, secondary_limit_tokens: null, ...patch,
  }
}
function group(patch: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return { model: 'fixture', accountId: 'a', apiKeyId: '', firstMs: 100, lastMs: 200, requests: 2, success: 2, error: 0,
    stdNormalInput: 900_000, stdCached: 100_000, stdOutput: 100_000,
    longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    stdContextMin: 100_000, stdContextMax: 200_000, serviceTier: 'standard', rateLimited: 0, upstreamError: 0, clientCanceled: 0, ...patch }
}
function summary(groups: CockpitRequestLogGroup[]): CockpitRequestLogSummary {
  return { available: true, rowCount: groups.reduce((n,g) => n + g.requests, 0), windowStartMs: 100, windowEndMs: 200, bucketHours: 1, groups, cells: [], bucketLatencies: [] }
}
const cost = (usd: number | null, patch: Partial<MonitorCostEstimate> = {}): MonitorCostEstimate => ({ usd, reason: null, evidence: null, ...patch })

beforeEach(() => { vi.mocked(invoke).mockReset(); Object.assign(window, { __TAURI_INTERNALS__: {} }) })

describe('shared native catalog read boundaries', () => {
  it('exposes the status/refresh contract and does not invoke an empty batch', async () => {
    vi.mocked(invoke).mockResolvedValue({ available: true })
    await getModelCatalogStatus(); expect(invoke).toHaveBeenLastCalledWith('model_catalog_status')
    await refreshModelCatalog(); expect(invoke).toHaveBeenLastCalledWith('model_catalog_refresh')
    vi.mocked(invoke).mockClear()
    expect(await quoteModelCatalogBatch([])).toEqual([]); expect(invoke).not.toHaveBeenCalled()
  })

  it('normalizes inclusive OpenAI vs independent Claude caches without double counting or provider guessing', () => {
    expect(cliproxyQuoteInput(event())).toMatchObject({ inputTokens: 100, contextTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 10, requestedMode: 'auto' })
    expect(cliproxyQuoteInput(event()).provider).toBeUndefined()
    expect(cliproxyQuoteInput(event()).actualMode).toBeUndefined()
    expect(cliproxyQuoteInput(event({ provider: 'anthropic', executor_type: 'ClaudeExecutor', input_tokens: 60, service_tier: 'priority' }))).toMatchObject({ provider: 'anthropic', inputTokens: 100, contextTokens: 100, requestedMode: 'priority' })
    expect(cliproxyQuoteInput(event({ provider: 'anthropic', executor_type: 'ClaudeExecutor' })).actualMode).toBeUndefined()
    expect(cliproxyQuoteInput(event({ provider: 'google', executor_type: 'GeminiExecutor', reasoning_tokens: 7 })).outputTokens).toBe(27)
    expect(cliproxyQuoteInput(event({ response_service_tier: 'priority' })).actualMode).toBe('priority')
  })

  it('attaches one batch to either CPA reader and preserves existing quote evidence', async () => {
    const quoted = event({ id: 2, priceQuote: cost(9) })
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({ available: true, events: [event(), quoted], readStartMs: 100, readEndMs: 200 }))
      .mockResolvedValueOnce([{ id: 'cpa:0', cost: cost(2) }])
    const result = await getCliproxyUsageSnapshot()
    expect(result.events.map(e => e.priceQuote?.usd)).toEqual([2, 9])
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({ items: [{ id: 'cpa:0', inputTokens: 100 }] })
    vi.mocked(invoke).mockReset().mockResolvedValueOnce(JSON.stringify([event()])).mockResolvedValueOnce([{ id: 'cpa:0', cost: cost(3) }])
    expect((await getCliproxyUsageEvents())[0].priceQuote?.usd).toBe(3)
  })

  it.each(['events', 'snapshot'])('joins each %s quote to its own row when the production reader omits id', async reader => {
    const rows = [event({ model: 'first-model', input_tokens: 100 }), event({ model: 'second-model', input_tokens: 700 })].map(row => {
      const { id: _id, ...productionRow } = row
      return productionRow
    })
    const payload = reader === 'events' ? rows : { available: true, events: rows, readStartMs: 100, readEndMs: 200 }
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(payload)).mockResolvedValueOnce([
      { id: 'cpa:1', cost: cost(7) }, { id: 'cpa:0', cost: cost(2) },
    ])
    const result = reader === 'events' ? await getCliproxyUsageEvents() : (await getCliproxyUsageSnapshot()).events
    expect((vi.mocked(invoke).mock.calls[1][1] as { items: object[] }).items).toMatchObject([
      { id: 'cpa:0', model: 'first-model', inputTokens: 100 },
      { id: 'cpa:1', model: 'second-model', inputTokens: 700 },
    ])
    expect(result.map(row => row.priceQuote?.usd)).toEqual([2, 7])
    expect(result.every(row => row.id === undefined)).toBe(true)
  })

  it('keeps a determinate quote above offline prices and never picks a scenario as a scalar', () => {
    const rates = { input_cost_per_token: 1, output_cost_per_token: 1, cache_read_input_token_cost: 1, cache_creation_input_token_cost: 1 }
    expect(pricedEventCostUsd(event({ priceQuote: cost(2) }), rates).cost).toBe(2)
    const quote = cost(null, { scenarios: [{ mode: 'standard', amount: 1, evidence: {} as PriceEvidence }, { mode: 'fast', amount: 2, evidence: {} as PriceEvidence }] })
    expect(pricedEventCostUsd(event({ priceQuote: quote }), rates).basis.kind).toBe('no_price_no_estimate')
    expect(quote.scenarios).toHaveLength(2)
  })

  it('falls back offline only with exact model identity, correct token arithmetic and known cache prices', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify([event()])).mockRejectedValueOnce(new Error('native unavailable'))
    const [row] = await getCliproxyUsageEvents()
    const rates = { input_cost_per_token: 2, output_cost_per_token: 4, cache_read_input_token_cost: 1, cache_creation_input_token_cost: 3 }
    expect(row.priceQuote).toBeUndefined()
    expect(pricedEventCostUsd(row, rates).cost).toBe(60 * 2 + 30 + 10 * 3 + 20 * 4)
    expect(pricedEventCostUsd(row, { input_cost_per_token: 2, output_cost_per_token: 4 }).basis.kind).toBe('no_price_no_estimate')
    expect(pricedEventCostUsd(event(), { ...rates, input_cost_per_token_priority: 4 }).basis.kind).toBe('no_price_no_estimate')
    expect(resolveModelPricing('glm-5.2', { 'azure_ai/fw-GLM-5.2': rates })).toBeUndefined()
    expect(resolveModelPricing('codex-auto-review', { 'gpt-5.1-codex': rates })).toBeUndefined()
  })

  it('quotes Cockpit once using real per-request ranges, never aggregate sums or bucket timestamps as pricing context', async () => {
    const data = summary([group({ longNormalInput: 500_000, longContextMin: 300_000, longContextMax: 400_000 })])
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(data)).mockResolvedValueOnce([{ id: 'cockpit:group:0:std', cost: cost(2) }, { id: 'cockpit:group:0:long', cost: cost(3) }])
    const result = await getCockpitRequestLogSummary(1, 100, 200)
    const args = vi.mocked(invoke).mock.calls[1][1] as { items: Array<Record<string, unknown>> }
    expect(args.items.map(i => [i.contextMin, i.contextMax])).toEqual([[100_000, 200_000], [300_000, 400_000]])
    expect(args.items.every(i => i.aggregate === true && i.contextTokens == null && i.timestampMs == null && i.timeBand == null && i.provider == null)).toBe(true)
    expect(args.items.every(i => i.requestedMode === 'standard' && i.actualMode == null)).toBe(true)
    expect(cockpitSplitCostUsd(result!.groups[0], undefined, 0.2).cost).toBe(1)
    expect(result!.groups[0].estimatedCostUsd).toBe(0)
  })

  it('retains custom price priority and per-account quote identity when models are merged', () => {
    const first = group({ priceQuotes: [cost(2)] })
    const second = group({ accountId: 'b', priceQuotes: [cost(3)] })
    const sets = cockpitEffectivePriceSets([{ modelId: 'fixture', inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 20 }])
    expect(cockpitSplitCostUsd(first, sets.fixture, 1).cost).toBeCloseTo(11.1)
    const [model] = cockpitRequestLogToModelStats(summary([first, second]), {}, 0.2)
    expect(model.cost).toBe(5); expect(model.account_cost).toBe(1)
    expect(model.cache_hit_ratio).toBeCloseTo(100_000 / (900_000 + 100_000))
    const amounts = Object.values(cockpitRequestLogToAccountStats(summary([first, second]), {}, 0.2)).map(r => r.standard_cost).sort()
    expect(amounts[0]).toBeCloseTo(2); expect(amounts[1]).toBeCloseTo(3)
  })

  it('uses normalized inclusive input for CPA model cache ratios without counting reads twice', () => {
    const end = new Date('2026-10-16T12:00:00Z')
    const [model] = cliproxyEventsToModelStats([event({ requested_at: end.getTime() - 1, input_tokens: 100, cache_read_tokens: 80, cached_tokens: 80, cache_creation_tokens: 0, priceQuote: cost(0) })], {}, '30d', 0.2, end)
    expect(model.cache_hit_ratio).toBe(0.8)
  })

  it('preserves source estimates, partial known amounts, scenarios and offline fallback without inventing aggregate context', async () => {
    const partial = group({ priceQuotes: [cost(2), cost(null, { reason: 'unknown_mode' })] })
    expect(cockpitSplitCostUsd({ ...partial, estimatedCostUsd: 7 }, undefined, 0.2).cost).toBeCloseTo(1.4)
    const [account] = Object.values(cockpitRequestLogToAccountStats(summary([partial]), {}, 0.2))
    expect(account.cost).toBeNull(); expect(account.known_cost).toBeCloseTo(0.4)
    const old = group({ stdContextMin: undefined, stdContextMax: undefined })
    vi.mocked(invoke).mockResolvedValueOnce([{ id: 'cockpit:group:0:std', cost: cost(null, { reason: 'unknown_aggregate_context' }) }])
    await quoteCockpitRequestLogSummary(summary([old]))
    expect((vi.mocked(invoke).mock.calls[0][1] as { items: object[] }).items[0]).not.toHaveProperty('contextMin')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'))
    const offline = group({ model: 'gpt-5.4' })
    await quoteCockpitRequestLogSummary(summary([offline]))
    expect(offline.priceQuotes).toBeUndefined()
    expect(cockpitSplitCostUsd(offline, cockpitEffectivePriceSets([])['gpt-5.4'], 1).cost).toBeGreaterThan(0)
  })

  it('labels peak/off-peak scenarios independently of actual-mode uncertainty', () => {
    expect(monitorScenarioLabel({ mode: 'standard', scenarioKey: 'standard:peak' })).toBe('标准模式 · 高峰时段')
    expect(monitorScenarioLabel({ mode: 'standard', scenarioKey: 'standard:off_peak' })).toBe('标准模式 · 非高峰时段')
    expect(monitorScenarioLabel({ mode: 'fast' })).toBe('快速模式')
    expect(monitorTotalCost({ requestCount: 1, unpricedRequests: 1, scenarioRequests: 1, pricedCostUsd: 0, scenarios: [{ scenarioKey: 'standard:peak', mode: 'standard', currency: 'USD', amount: 2, requestCount: 1 }] })).toBe('有多种可能价格')
    const evidence = { currency: 'USD' } as PriceEvidence
    expect(monitorRequestCost(cost(null, { scenarios: [{ mode: 'standard', scenarioKey: 'standard:peak', amount: 2, evidence }, { mode: 'standard', scenarioKey: 'standard:off_peak', amount: 1, evidence }] }))).toBe('标准模式 · 高峰时段估算 美元 $2.000000 / 标准模式 · 非高峰时段估算 美元 $1.000000')
  })
})
