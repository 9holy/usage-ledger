import '@/features/desktop/__tests__/usageI18nFixture'
import i18n from '@/i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from '@/api/url'
import { monitorWeekBounds, getUsageMonitorWeekly, monitorContext, monitorMode, monitorAmount, monitorScenarioLabel, monitorCacheCoverage } from '../usageMonitor'
import { getUsageMonitorSnapshot, getUsageMonitorAnalysis, getUsageMonitorSession, groupMonitorTurns, monitorCost, monitorTotalCost, monitorPriceSummary, monitorAutomaticPriceSummary, monitorAutomaticMode, monitorRequestAutomaticPrice, monitorRatio, monitorToken, monitorRequestCost, monitorUnquotedRequests, monitorSingleQuotes, type MonitorRequest, type PriceEvidence, type MonitorStoredPriceSummary } from '../usageMonitor'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: vi.fn(() => true) }))

describe('usage monitor client', () => {
  it('localizes display helpers while preserving raw model names, precision, zero and unknown values', () => {
    i18n.global.locale.value = 'en'
    expect(monitorMode('standard')).toBe('Standard mode')
    expect(monitorMode('用户模型')).toBe('用户模型')
    expect(monitorAmount(0, 'CNY')).toBe('CNY ¥0.000000')
    expect(monitorCost(null)).toBe('Cannot estimate')
    expect(monitorCost(1e-9)).toBe('$0.000000001')
    expect(monitorRatio(null)).toBe('Unknown')
    expect(monitorContext('>200000 input tokens')).toBe('Input over 200,000 tokens')
    expect(monitorScenarioLabel({ mode: 'fast', scenarioKey: 'fast:peak' })).toBe('Fast mode · Peak period')
    expect(monitorCacheCoverage({ requestCount: 12000, cacheKnownRequests: 10000, cacheHitRatio: null, knownCacheHitRatio: 0.25 } as never)).toBe('Complete input and cache fields: 10,000 / 12,000 requests')
    i18n.global.locale.value = 'zh'
    expect(monitorMode('standard')).toBe('标准模式')
    expect(monitorAmount(0, 'CNY')).toBe('人民币 ¥0.000000')
  })
  it('names published context tiers in Chinese without altering raw model identifiers', () => {
    expect(monitorContext('full published context window')).toBe('模型支持的全部上下文长度')
    expect(monitorContext('>200000 input tokens')).toBe('输入超过 200,000 Token')
  })
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(isDesktopRuntime).mockReturnValue(true) })

  it('passes the local calendar week endpoint for native prediction, not a rolling seven-day window', async () => {
    const now = new Date(2026, 9, 14).getTime()
    const week = monitorWeekBounds(now)
    expect(week.startMs).toBe(new Date(2026, 9, 12).getTime())
    expect(week.endMs).toBe(new Date(2026, 9, 19).getTime())
    await getUsageMonitorWeekly(week.startMs, now, week.endMs)
    expect(invoke).toHaveBeenCalledWith('usage_monitor_weekly', { startMs: week.startMs, endMs: now, forecastEndMs: week.endMs })
  })

  it('uses bounded snapshot and request pages with the Rust argument names', async () => {
    vi.mocked(invoke).mockResolvedValue({})
    await getUsageMonitorSnapshot('claude', 100)
    await getUsageMonitorSession('codex:session', 200)
    expect(invoke).toHaveBeenNthCalledWith(1, 'usage_monitor_snapshot', { tool: 'claude', offset: 100, limit: 100 })
    expect(invoke).toHaveBeenNthCalledWith(2, 'usage_monitor_session', { key: 'codex:session', offset: 200, limit: 100, unpricedOnly: false })
    await getUsageMonitorSnapshot('codex', 0, { search: 'project', status: 'history', unpricedOnly: true })
    await getUsageMonitorSession('codex:session', 0, true)
    expect(invoke).toHaveBeenNthCalledWith(3, 'usage_monitor_snapshot', { tool: 'codex', offset: 0, limit: 100, search: 'project', status: 'history', unpricedOnly: true })
    expect(invoke).toHaveBeenNthCalledWith(4, 'usage_monitor_session', { key: 'codex:session', offset: 0, limit: 100, unpricedOnly: true })
  })

  it('keeps unknown ratio and price distinct from measured zero', () => {
    expect(monitorRatio(null)).toBe('未知')
    expect(monitorRatio(0.25)).toBe('25.0%')
    expect(monitorRatio(0)).toBe('0.0%')
    expect(monitorRatio(0.0001)).toBe('<0.1%')
    expect(monitorRatio(0.9999)).toBe('>99.9%')
    expect(monitorRatio(1)).toBe('100.0%')
    expect(monitorCost(null)).toBe('无法估算')
    expect(monitorCost(0)).toBe('$0.000000')
    expect(monitorCost(1e-9)).toBe('$0.000000001')
    expect(monitorCost(1.25e-7, 'CNY')).toBe('¥0.000000125')
    expect(monitorTotalCost({ requestCount: 2, unpricedRequests: 2, pricedCostUsd: 0 })).toBe('无法估算')
    expect(monitorTotalCost({ requestCount: 2, unpricedRequests: 1, pricedCostUsd: 0.25 })).toBe('美元 $0.250000')
    const incomplete = { inputTokens: 0, outputTokens: 0, unknownFields: ['input_tokens'] } as MonitorRequest
    expect(monitorToken(incomplete, 'input_tokens')).toBeNull()
    expect(monitorToken(incomplete, 'output_tokens')).toBe(0)
  })

  it('passes descendant scope explicitly and preserves own-only legacy calls', async () => {
    for (const includeDescendants of [true, false]) {
      await getUsageMonitorSession('codex:parent', 100, true, { includeDescendants, turnId: 'parent-turn', model: 'gpt-6.1-sol' })
      expect(invoke).toHaveBeenLastCalledWith('usage_monitor_session', { key: 'codex:parent', offset: 100, limit: 100, unpricedOnly: true, includeDescendants, turnId: 'parent-turn', model: 'gpt-6.1-sol' })
    }
  })

  it('passes bounded time/model analysis and optional turn filters without changing legacy session calls', async () => {
    vi.mocked(invoke).mockResolvedValue({})
    await getUsageMonitorAnalysis({ tool: 'codex', startMs: 1000, endMs: 2000, model: 'glm-5', offset: 100, limit: 999, search: 'project', status: 'active', unpricedOnly: true })
    expect(invoke).toHaveBeenLastCalledWith('usage_monitor_analysis', { tool: 'codex', startMs: 1000, endMs: 2000, model: 'glm-5', offset: 100, limit: 100, search: 'project', status: 'active', unpricedOnly: true })
    await getUsageMonitorSession('codex:session', 100, true, { startMs: null, endMs: 2000, model: 'glm-5', turnId: 't2' })
    expect(invoke).toHaveBeenLastCalledWith('usage_monitor_session', { key: 'codex:session', offset: 100, limit: 100, unpricedOnly: true, startMs: null, endMs: 2000, model: 'glm-5', turnId: 't2' })
  })

  it('forwards exact saved pricing reasons independently from unpriced-only and clears them explicitly', async () => {
    vi.mocked(invoke).mockResolvedValue({})
    const query = { tool: 'codex', startMs: 1000, endMs: 2000, model: 'gpt-6.1-sol', offset: 0, limit: 999, pricingReason: 'actual_mode_unknown', unpricedOnly: false }
    await getUsageMonitorAnalysis(query)
    expect(invoke).toHaveBeenLastCalledWith('usage_monitor_analysis', { ...query, limit: 100 })
    await getUsageMonitorSession('codex:session', 100, false, { startMs: 1000, endMs: 2000, model: 'gpt-6.1-sol', pricingReason: 'actual_mode_unknown' })
    expect(invoke).toHaveBeenLastCalledWith('usage_monitor_session', { key: 'codex:session', offset: 100, limit: 100, unpricedOnly: false, startMs: 1000, endMs: 2000, model: 'gpt-6.1-sol', pricingReason: 'actual_mode_unknown' })
    await getUsageMonitorAnalysis({ ...query, pricingReason: null })
    expect(invoke).toHaveBeenLastCalledWith('usage_monitor_analysis', { ...query, limit: 100, pricingReason: null })
    await getUsageMonitorSession('codex:session', 0, false, { pricingReason: null })
    expect(invoke).toHaveBeenLastCalledWith('usage_monitor_session', { key: 'codex:session', offset: 0, limit: 100, unpricedOnly: false, pricingReason: null })
  })

  it('separates native currencies and measured zero from no single quote', () => {
    expect(monitorTotalCost({ requestCount: 2, unpricedRequests: 0, pricedCostUsd: 0.25, pricedCostCny: 2 })).toBe('美元 $0.250000 · 人民币 ¥2.000000')
    expect(monitorRequestCost({ usd: null, cny: 0, reason: null, evidence: null })).toBe('人民币 ¥0.000000')
    expect(monitorRequestCost({ usd: null, reason: null, evidence: null })).toBe('无法估算')
    expect(monitorSingleQuotes({ requestCount: 1, unpricedRequests: 1, pricedCostUsd: 0, pricedCostCny: 0 })).toEqual([])
    expect(monitorSingleQuotes({ requestCount: 1, unpricedRequests: 0, pricedCostUsd: 0 })).toEqual([{ currency: 'USD', amount: 0 }])
  })

  it('keeps scenario alternatives separate and counts only completely unquoted requests', () => {
    const evidence = { currency: 'USD' } as PriceEvidence
    expect(monitorRequestCost({ usd: null, reason: null, evidence: null, scenarios: [{ mode: 'standard', amount: 1, evidence }, { mode: 'fast', amount: 2, evidence }] })).toBe('标准模式估算 美元 $1.000000 / 快速模式估算 美元 $2.000000')
    expect(monitorTotalCost({ requestCount: 2, unpricedRequests: 2, scenarioRequests: 2, pricedCostUsd: 0 })).toBe('有多种可能价格')
    expect(monitorUnquotedRequests({ unpricedRequests: 5, scenarioRequests: 4 })).toBe(1)
    expect(monitorUnquotedRequests({ unpricedRequests: 5 })).toBe(5)
  })

  it('uses the current selected-quote gap instead of saved scenario presence when automatic summaries exist', () => {
    const automaticPriceSummary = { byCurrency: {}, byMode: {
      standard: { responseRequests: 1, requestedRequests: 0, unknownRequests: 0, coveredRequests: 1, byCurrency: {} },
      fast: { responseRequests: 0, requestedRequests: 2, unknownRequests: 0, coveredRequests: 1, byCurrency: {} },
      unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 2, coveredRequests: 0, byCurrency: {} },
    } }
    expect(monitorUnquotedRequests({ requestCount: 5, unpricedRequests: 5, scenarioRequests: 5, automaticPriceSummary })).toBe(3)
    expect(monitorUnquotedRequests({ unpricedRequests: 5, scenarioRequests: 5, automaticPriceSummary })).toBe(3)
    expect(monitorUnquotedRequests({ unpricedRequests: 5, scenarioRequests: 5 })).toBe(0)
  })

  it('groups requests by turn without dropping multiple calls in a turn', () => {
    const rows = [{ id: 'a', turnId: '1' }, { id: 'b', turnId: '2' }, { id: 'c', turnId: '1' }] as MonitorRequest[]
    expect(groupMonitorTurns(rows).map((group) => [group.id, group.requests.map((row) => row.id)])).toEqual([['1', ['a', 'c']], ['2', ['b']]])
  })

  function prices(requestCount: number, priceSummary: MonitorStoredPriceSummary, scenarios: Array<{ mode: string; scenarioKey?: string; currency: string; amount: number; requestCount: number }> = []) {
    return { requestCount, unpricedRequests: requestCount, pricedCostUsd: 0, pricedCostCny: 0, scenarios, priceSummary }
  }

  it('shows a useful explicit standard reference when every actual mode is unknown', () => {
    const totals = prices(2, { coveredRequests: 2, byCurrency: { USD: { confirmedSubtotal: 0, confirmedRequests: 0, standardSubtotal: 3, standardRequests: 2 } } })
    const summary = monitorPriceSummary(totals)
    expect(summary).toMatchObject({ coveredRequests: 2, uncoveredRequests: 0, complete: true })
    expect(summary.currencies).toEqual([{ currency: 'USD', confirmedSubtotal: null, referenceSubtotal: 3, confirmedRequests: 0, standardRequests: 2, coveredRequests: 2, basis: 'standard_reference' }])
    expect(monitorTotalCost(totals)).toBe('美元 $3.000000（标准价参考）')
    expect(monitorSingleQuotes(totals)).toEqual([])
  })

  it('keeps the confirmed Fast amount and adds only the uncertain requests standard reference', () => {
    const totals = prices(2, { coveredRequests: 2, byCurrency: { USD: { confirmedSubtotal: 20, confirmedRequests: 1, standardSubtotal: 5, standardRequests: 1 } } }, [{ mode: 'standard', currency: 'USD', amount: 15, requestCount: 2 }])
    expect(monitorPriceSummary(totals).currencies[0]).toMatchObject({ confirmedSubtotal: 20, referenceSubtotal: 25, basis: 'confirmed_plus_standard_reference', coveredRequests: 2 })
    expect(monitorTotalCost(totals)).toBe('美元 $25.000000（条件报价+标准参考）')
    expect(monitorSingleQuotes(totals)).toEqual([{ currency: 'USD', amount: 20 }])
  })

  it('does not sum aggregated alternatives or turn uncovered prices into zero', () => {
    const totals = prices(2, { coveredRequests: 1, byCurrency: { USD: { confirmedSubtotal: 0, confirmedRequests: 0, standardSubtotal: 4, standardRequests: 1 } } }, [
      { mode: 'standard', scenarioKey: 'standard:peak', currency: 'USD', amount: 100, requestCount: 1 },
      { mode: 'standard', scenarioKey: 'standard:off_peak', currency: 'USD', amount: 200, requestCount: 1 },
    ])
    expect(monitorPriceSummary(totals)).toMatchObject({ coveredRequests: 1, uncoveredRequests: 1, complete: false })
    expect(monitorPriceSummary(totals).currencies[0].referenceSubtotal).toBe(4)
    expect(monitorTotalCost(totals)).toBe('已知小计 美元 $4.000000（标准价参考） · 1 次未覆盖')
    const unknown = prices(1, { coveredRequests: 0, byCurrency: {} })
    expect(monitorPriceSummary(unknown)).toMatchObject({ currencies: [], uncoveredRequests: 1, complete: false, basis: 'unpriced' })
    expect(monitorTotalCost(unknown)).toBe('无法估算')
  })

  it('separates currencies, including a verified zero quote without a phantom zero currency', () => {
    const totals = prices(2, { coveredRequests: 2, byCurrency: {
      CNY: { confirmedSubtotal: 0, confirmedRequests: 1, standardSubtotal: 0, standardRequests: 0 },
      USD: { confirmedSubtotal: 0, confirmedRequests: 0, standardSubtotal: 1, standardRequests: 1 },
    } })
    expect(monitorPriceSummary(totals).currencies.map(row => [row.currency, row.referenceSubtotal, row.coveredRequests])).toEqual([['CNY', 0, 1], ['USD', 1, 1]])
    expect(monitorSingleQuotes(totals)).toEqual([{ currency: 'CNY', amount: 0 }])
    expect(monitorTotalCost(totals)).toBe('人民币 ¥0.000000 · 美元 $1.000000（标准价参考）')
  })

  it('keeps legacy subtotal coverage conservative instead of guessing overlapping standard scenarios', () => {
    const summary = monitorPriceSummary({ requestCount: 2, unpricedRequests: 2, scenarioRequests: 2, pricedCostUsd: 0, scenarios: [{ mode: 'standard', currency: 'USD', amount: 7, requestCount: 2 }] })
    expect(summary).toMatchObject({ currencies: [], coveredRequests: 0, uncoveredRequests: 2, complete: false })
  })

  it('automatically chooses response mode before client setting without changing original alternatives', () => {
    const scenario = (mode: string, amount: number, currency = 'USD') => ({ mode, amount, evidence: { mode, currency } as PriceEvidence })
    const request: Pick<MonitorRequest, 'mode' | 'modeBasis' | 'requestedMode' | 'unknownFields' | 'cost'> = { mode: 'standard', modeBasis: 'response_reported', requestedMode: 'priority', unknownFields: [], cost: { usd: 99, cny: null, reason: null, evidence: { mode: 'fast' } as PriceEvidence, scenarios: [scenario('standard', 1), scenario('fast', 2), scenario('ultrafast', 6)] } }
    const original = JSON.stringify(request)
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: 'standard', basis: 'response_reported', quoteBasis: 'saved_matching_scenario', quotes: [{ currency: 'USD', amount: 1 }] })
    request.modeBasis = 'unknown'
    request.cost.usd = null
    for (const [requested, mode, amount] of [['default', 'standard', 1], ['priority', 'fast', 2], ['ultrafast', 'ultrafast', 6]] as const) {
      request.requestedMode = requested
      expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode, basis: 'requested_mode', quotes: [{ currency: 'USD', amount }] })
    }
    request.unknownFields = ['requested_mode_ambiguous']
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: null, basis: 'unknown', quotes: [], unknownReference: [{ amount: 1 }] })
    expect(JSON.parse(original).cost.scenarios).toEqual(request.cost.scenarios)
  })

  it('rejects ambiguous same-mode alternatives and retains a currency-specific verified zero', () => {
    const quote = (amount: number, currency = 'USD') => ({ mode: 'fast', amount, evidence: { mode: 'fast', currency } as PriceEvidence })
    const request = { mode: null, modeBasis: 'unknown', requestedMode: 'priority', unknownFields: [], cost: { usd: null, cny: null, reason: null, evidence: null, scenarios: [quote(2), quote(4)] } }
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: 'fast', quotes: [], unknownReference: [], quoteBasis: 'none' })
    request.cost.scenarios = [quote(2), quote(2, 'CNY')]
    expect(monitorRequestAutomaticPrice(request).quotes).toEqual([])
    request.cost.scenarios = [quote(0, 'CNY'), quote(0, 'CNY')]
    expect(monitorRequestAutomaticPrice(request).quotes).toMatchObject([{ currency: 'CNY', amount: 0 }])
    request.requestedMode = 'auto'
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: null, quotes: [], unknownReference: [] })
  })

  it('uses exact-turn runtime settings between response and original client settings without treating conflict as default', () => {
    const request: Pick<MonitorRequest, 'mode' | 'modeBasis' | 'requestedMode' | 'runtimeMode' | 'unknownFields' | 'cost'> = {
      mode: null, modeBasis: 'unknown', requestedMode: 'default', unknownFields: [],
      runtimeMode: { mode: 'fast', conflicted: false, observedAtMs: 1000, source: 'codex_turn_feedback_tag' },
      cost: { usd: null, reason: null, evidence: null, scenarios: [
        { mode: 'standard', amount: 1, evidence: { currency: 'USD', mode: 'standard' } as PriceEvidence },
        { mode: 'fast', amount: 2, evidence: { currency: 'USD', mode: 'fast' } as PriceEvidence },
      ] },
    }
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: 'fast', basis: 'runtime_mode', quotes: [{ amount: 2 }] })
    expect(request.requestedMode).toBe('default')
    request.runtimeMode = { mode: null, conflicted: false, observedAtMs: 1000, source: 'codex_turn_feedback_tag' }
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: null, basis: 'unknown', quotes: [], unknownReference: [{ amount: 1 }] })
    request.mode = 'standard'; request.modeBasis = 'response_reported'
    expect(monitorAutomaticMode(request)).toEqual({ mode: 'standard', basis: 'response_reported' })
    request.mode = null; request.modeBasis = 'unknown'
    request.runtimeMode = { mode: 'fast', conflicted: false, observedAtMs: 1000, source: 'codex_turn_feedback_tag' }
    request.unknownFields = ['requested_mode_ambiguous']
    expect(monitorAutomaticMode(request)).toEqual({ mode: null, basis: 'unknown' })
    expect(request.runtimeMode?.mode).toBe('fast')
    request.unknownFields = []
    expect(monitorAutomaticMode({ ...request, timestampMs: 500 })).toEqual({ mode: 'standard', basis: 'requested_mode' })
    expect(monitorAutomaticMode({ ...request, timestampMs: 2000, requestTiming: { startedAtMs: 500, completedAtMs: null, durationMs: null, ttftMs: null, streamingDurationMs: null, basis: 'reported' } })).toEqual({ mode: 'standard', basis: 'requested_mode' })
    request.mode = 'standard'; request.modeBasis = 'response_reported'
    request.unknownFields = ['requested_mode_ambiguous']
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: 'standard', basis: 'response_reported', quotes: [{ amount: 1 }] })
    request.unknownFields = []
    request.mode = null; request.modeBasis = 'unknown'
    request.runtimeMode = { mode: null, conflicted: true, observedAtMs: 1000, source: 'codex_turn_feedback_tag' }
    expect(monitorRequestAutomaticPrice(request)).toMatchObject({ mode: null, basis: 'unknown', quotes: [], unknownReference: [{ amount: 1 }] })
  })

  it('prefers automatic identified amounts for old total-cost consumers and excludes unidentified reference money', () => {
    const totals = {
      requestCount: 2, unpricedRequests: 2, pricedCostUsd: 0, scenarioRequests: 2,
      automaticPriceSummary: {
        byMode: { fast: { responseRequests: 0, requestedRequests: 1, unknownRequests: 0, coveredRequests: 1, byCurrency: { USD: { amount: 2, requestCount: 1 } } }, unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 1, coveredRequests: 0, byCurrency: {} } },
        byCurrency: { USD: { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: 2, requestedRequests: 1, unknownReferenceSubtotal: 100, unknownReferenceRequests: 1 } },
      },
    }
    expect(monitorTotalCost(totals)).toBe('自动估计小计 美元 $2.000000 · 1 次未覆盖')
  })

  it('keeps identified automatic amounts, client evidence and unknown references separate by currency and mode', () => {
    const summary = monitorAutomaticPriceSummary({ requestCount: 5, automaticPriceSummary: {
      byMode: {
        standard: { responseRequests: 2, requestedRequests: 0, unknownRequests: 0, coveredRequests: 2, byCurrency: { USD: { amount: 1, requestCount: 1 }, CNY: { amount: 0, requestCount: 1 } } },
        fast: { responseRequests: 0, requestedRequests: 1, unknownRequests: 0, coveredRequests: 1, byCurrency: { USD: { amount: 2, requestCount: 1 } } },
        ultrafast: { responseRequests: 0, requestedRequests: 1, unknownRequests: 0, coveredRequests: 1, byCurrency: { USD: { amount: 6, requestCount: 1 } } },
        unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 1, coveredRequests: 0, byCurrency: {} },
      },
      byCurrency: {
        USD: { responseSubtotal: 1, responseRequests: 1, requestedSubtotal: 8, requestedRequests: 2, unknownReferenceSubtotal: 1, unknownReferenceRequests: 1 },
        CNY: { responseSubtotal: 0, responseRequests: 1, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 },
      },
    } })
    expect(summary).toMatchObject({ coveredRequests: 4, unknownRequests: 1, identifiedUnquotedRequests: 0, complete: false })
    expect(summary.currencies).toMatchObject([{ currency: 'USD', identifiedSubtotal: 9, clientSettingSubtotal: 8, unknownReferenceSubtotal: 1 }, { currency: 'CNY', identifiedSubtotal: 0, clientSettingSubtotal: null, unknownReferenceSubtotal: null }])
    expect(summary.modes.reduce((sum, row) => sum + row.requestCount, 0)).toBe(5)
    expect(summary.modes.find(row => row.mode === 'fast')?.quotes).toEqual([{ currency: 'USD', amount: 2, requestCount: 1 }])
    expect(monitorAutomaticPriceSummary({ requestCount: 2 })).toMatchObject({ currencies: [], unknownRequests: 2, coveredRequests: 0, complete: false })
  })

  it('rejects browser reads and preserves actual command failures', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false)
    await expect(getUsageMonitorSnapshot(null, 0)).rejects.toThrow('需要桌面端')
    await expect(getUsageMonitorAnalysis({ tool: null, startMs: null, endMs: 2000, model: null, offset: 0, limit: 100 })).rejects.toThrow('需要桌面端')
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(isDesktopRuntime).mockReturnValue(true)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('database unavailable'))
    await expect(getUsageMonitorSnapshot(null, 0)).rejects.toThrow('database unavailable')
  })
})
