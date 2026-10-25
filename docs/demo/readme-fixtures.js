// Invented documentation data only. No saved connections, files, or databases are read.
export const now = Date.parse('2026-10-18T08:00:00Z')
const start = now - 3600000
export const publicSettings = { site_name: 'Usage Ledger', site_logo: '/usage-ledger.png', api_base_url: 'https://gateway.example.invalid/v1', registration_enabled: false }
export const connection = { id: 'demo-workspace', type: 'sub2api', name: 'DEMO Workspace', baseUrl: 'https://console.example.invalid', apiKey: '', lastUsed: now }
const automatic = (count, amount) => ({ byMode: { standard: { responseRequests: count * .8, requestedRequests: 0, unknownRequests: 0, coveredRequests: count * .8, byCurrency: { USD: { amount, requestCount: count * .8 } } }, unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: count * .2, coveredRequests: 0, byCurrency: { USD: { amount: amount * .25, requestCount: count * .2 } } } }, byCurrency: { USD: { responseSubtotal: amount, responseRequests: count * .8, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: amount * .25, unknownReferenceRequests: count * .2 } } })
function totals(scale = 1) {
  return { inputTokens: 2400000 * scale, outputTokens: 180000 * scale, totalTokens: 2580000 * scale, cacheReadTokens: 2100000 * scale, cacheWriteTokens: 0, requestCount: 120 * scale, pricedCostUsd: 7.8 * scale, unpricedRequests: 24 * scale, incompleteRequests: 0, cacheHitRatio: .875, outputTokensPerSecond: 84, actualModeCounts: { standard: 96 * scale, unknown: 24 * scale }, requestedModeCounts: { standard: 96 * scale, unknown: 24 * scale }, automaticPriceSummary: automatic(120 * scale, 7.8 * scale) }
}
const timing = id => ({ turnId: id, startedAtMs: now - 42000, completedAtMs: now - 2000, durationMs: 40000, ttftMs: 850, basis: 'reported' })
const evidence = model => ({ model, currency: 'USD', mode: 'standard', version: 'DEMO', sourceUrl: 'https://prices.example.invalid', checkedAt: '2026-10-18', contextTier: 'standard', inputPerMillion: 2, cachedPerMillion: .2, outputPerMillion: 8, cacheWrite5mPerMillion: null, cacheWrite1hPerMillion: null })
const session = (id, model, parentId = null, tool = 'codex') => ({ key: `${tool}:${id}`, tool, id, parentId, project: 'DEMO / sample-project', model, status: parentId ? 'idle' : 'active', startedAtMs: now - 900000, updatedAtMs: now - 2000, totals: totals(parentId || tool === 'claude' ? .25 : .5), turnTiming: timing('demo-turn-1'), latestCompletedTurn: { timing: timing('demo-turn-1'), outputTokens: 3200, outputTokensPerSecond: 80 } })
export const sessions = [session('demo-main', 'gpt-6-astra'), session('demo-child', 'gpt-6.1-sol', 'demo-main'), session('demo-review', 'claude-sonnet-4-5', null, 'claude')]
const windows = scale => [60, 300].map(seconds => ({ seconds, observedOutputTokens: seconds * 84 * scale, outputTokensPerSecond: 84 * scale, coveredMs: seconds * 1000, complete: true, sourceComplete: true }))
const liveTimeline = Array.from({ length: 30 }, (_, i) => ({ startMs: now - (30 - i) * 60000, endMs: now - (29 - i) * 60000, observedOutputTokens: 3000 + i * 55, outputTokens: 3000 + i * 55, knownOutputTokens: 3000 + i * 55, requestCount: 4, unknownOutputRequests: 0, coveredMs: 60000, sourceComplete: true }))
const snapshot = { collectedAtMs: now, refreshMs: 2000, rateWindowSeconds: 60, totals: totals(), sessions, activeSessions: sessions, rateSessions: sessions, sessionCount: 3, statusCounts: { active: 2, history: 1, total: 3 }, sources: ['codex', 'claude', 'antigravity'].map(tool => ({ tool, root: `DEMO/${tool}/records`, status: 'watching', files: 3, registeredFiles: 3, presentRegisteredFiles: 3, missingRegisteredFiles: 0, lastScanMs: now, error: null })), collecting: false, error: null,
  live: { sampledAtMs: now, collectionUpdatedAtMs: now, basis: 'recorded', windows: windows(1), byTool: ['codex', 'claude'].map(tool => ({ tool, model: null, sessionKey: null, windows: windows(.5) })), byModel: sessions.map(s => ({ tool: s.tool, model: s.model, sessionKey: null, windows: windows(1 / 3) })), bySession: sessions.map(s => ({ tool: s.tool, model: s.model, sessionKey: s.key, windows: windows(1 / 3) })), timeline: liveTimeline, recordedTimeline: liveTimeline, peakMinuteOutputTokens: 4595, sourceCoverageIncomplete: false, unavailableTools: [] } }
const requests = sessions.slice(0, 2).map((s, i) => ({ id: `demo-request-${i + 1}`, tool: 'codex', sessionId: s.id, turnId: i ? 'demo-child-turn' : 'demo-turn-1', rootTurnId: i ? 'demo-turn-1' : null, requestId: `demo-request-${i + 1}`, timestampMs: now - 2000, model: s.model, requestedModel: s.model, modelBasis: 'response', mode: 'standard', requestedMode: 'standard', modeBasis: 'response', inputTokens: 20000, outputTokens: 3200, cacheReadTokens: 17500, cacheWriteTokens: 0, cacheWrite5mTokens: null, cacheWrite1hTokens: null, reasoningTokens: 800, durationMs: 40000, contextTokens: 20000, usageBasis: 'reported', unknownFields: [], cost: { usd: .0321, reason: null, evidence: evidence(s.model) } }))
const catalog = { available: true, revision: 'DEMO-2026-10-18', checkedAtMs: now, fetchedAtMs: now, etag: null, refreshing: false, error: null, modelCount: 1200, sourceUrl: 'https://prices.example.invalid/catalog' }
const money = { currency: 'CNY', cashOutlay: 280, refunds: 20, accruedExpense: 180, recognizedLoss: 0, expenseCredits: 20, netExpense: 160, remainingPrepaid: 100, ongoingHourlyExpense: .4, unresolvedCount: 0, hasEnteredFacts: true, terminationLoss: 0, amortizedExpense: 180, missingCoverageCount: 0 }
export const finance = { events: [{ id: 'demo-purchase', source: 'sub2api', instanceId: connection.id, accountId: '1', kind: 'purchase', amount: 280, currency: 'CNY', occurredAtMs: now - 86400000, coverageStartMs: now - 86400000, coverageEndMs: now + 29 * 86400000, note: 'DEMO monthly subscription', purchaseChannel: 'DEMO Direct', planLabel: 'DEMO Plus', createdAtMs: now, updatedAtMs: now, voidedAtMs: null }], totalEvents: 1, purchaseChannels: ['DEMO Direct'], planLabels: ['DEMO Plus'], summary: { hasEnteredFacts: true, eventCount: 1, unresolvedTerminationCount: 0, currencies: [money] }, byAccount: [{ ...money, accountId: '1', coverageIntervals: [{ startMs: start, endMs: now }], lifetimeAccruedExpense: 180, lifetimeRecognizedLoss: 0, lifetimeExpenseCredits: 20, lifetimeCoverageIntervals: [{ startMs: now - 86400000, endMs: now + 29 * 86400000 }] }] }
export async function invoke(command, args = {}) {
  const handlers = {
    usage_monitor_snapshot: () => snapshot,
    usage_monitor_analysis: () => ({ ...args, totals: totals(), byTool: ['codex', 'claude', 'antigravity'].map(tool => ({ tool, model: null, totals: totals(tool === 'antigravity' ? 0 : tool === 'codex' ? .75 : .25) })), byModel: sessions.map(s => ({ tool: s.tool, model: s.model, totals: s.totals })), timeline: Array.from({ length: 12 }, (_, i) => ({ startMs: start + i * 300000, endMs: start + (i + 1) * 300000, totals: totals((i + 1) / 78) })), availableModels: sessions.map(s => s.model), sessions, sessionCount: 3, latestRequestAtMs: { codex: now - 2000, claude: now - 3000 } }),
    usage_monitor_session: () => ({ session: sessions[0], members: sessions.slice(0, 2), includeDescendants: true, unlinkedChildRequests: 0, requests, requestCount: requests.length, filteredTotals: totals(.5), turns: [{ id: 'demo-turn-1', startedAtMs: now - 42000, updatedAtMs: now - 2000, totals: totals(.5), timing: timing('demo-turn-1') }], selectedCompletedTurn: sessions[0].latestCompletedTurn }),
    usage_monitor_weekly: () => ({ startMs: args.startMs, endMs: args.endMs, firstRecordAtMs: now - 3 * 86400000, lastRecordAtMs: now, totals: totals(4), byTool: ['codex', 'claude'].map(tool => ({ tool, model: null, totals: totals(2) })) }),
    usage_monitor_accounts: () => ({
      collectedAtMs: now, weekStartMs: args.weekStartMs, currentAccountKey: 'demo-codex',
      accounts: ['codex', 'claude'].map((tool, i) => {
        const cycle = { startMs: now - 6 * 86400000, endMs: now + 86400000, observedEndMs: now, resetAtMs: now + 86400000, quotaObservedAtMs: now, exhaustedAtMs: null, exhaustionUnknown: false, usedPercent: 38 + i * 12, current: true, totals: totals(2) }
        return {
          accountKey: `demo-${tool}`, accountLabel: `DEMO ${tool}`, tool, attribution: 'session_creator',
          subscription: { startMs: now - 9 * 86400000, endMs: now + 22 * 86400000, checkedAtMs: now, source: 'local_auth', error: null },
          calendarWeek: { startMs: args.weekStartMs, endMs: now, observedEndMs: now, totals: totals(2) },
          subscriptionMonth: { startMs: now - 9 * 86400000, endMs: now + 22 * 86400000, observedEndMs: now, totals: totals(3) },
          currentCycle: cycle, previousCycle: null, quotaCycles: [cycle], monthCycles: [cycle], unsegmentedMonth: totals(1),
        }
      }),
      unassignedWeek: totals(0),
    }),
    usage_monitor_quotas: () => ({ collectedAtMs: now, quotas: ['codex', 'claude'].map((tool, i) => ({ id: i + 1, tool, accountKey: `demo-${tool}`, accountLabel: `DEMO ${tool}`, attribution: 'reported', limitId: 'weekly', slot: 'weekly', windowMinutes: 10080, plan: 'DEMO Plus', modelId: null, poolLabel: null, observedAtMs: now, resetsAtMs: now + 86400000, usedPercent: 38 + i * 12, remainingPercent: 62 - i * 12, source: 'DEMO fixture', stale: false, expired: false, sourceError: null })), sources: [] }),
    model_catalog_status: () => catalog,
    model_catalog_refresh: () => catalog,
    model_catalog_quote_batch: () => (args.items || []).map(item => ({ id: item.id, cost: { usd: .0321, reason: null, evidence: evidence(item.model) } })),
    finance_ledger_query: () => finance,
    read_cockpit_file: () => null,
  }
  if (!Object.hasOwn(handlers, command)) { window.__demoUnknownIPC.push(command); throw new Error(`DEMO rejects IPC: ${command}`) }
  return structuredClone(handlers[command]())
}
export function fillCostData(data, buildEconomics, sourceState) {
  const accounts = [
    { id: 1, name: 'DEMO Subscription', type: 'oauth', platform: 'openai', extra: { plan_type: 'plus', cost_profile: { amount: 280, currency: 'CNY', billing_cycle: 'monthly', started_at: new Date(now - 86400000).toISOString(), algorithm_version: 'DEMO' } } },
    { id: 2, name: 'DEMO API Channel', type: 'apikey', platform: 'anthropic', extra: {} },
  ].map(a => ({ ...a, status: 'active', schedulable: true, created_at: new Date(start).toISOString(), credentials: {}, groups: [], concurrency: 4, priority: 10 }))
  const period = { start: new Date(start), end: new Date(now) }
  const usage = { '1': { requests: 78, tokens: 1680000, cost: 3.8, standard_cost: 16, user_cost: 9.2 }, '2': { requests: 42, tokens: 900000, cost: 4, standard_cost: 12, user_cost: 7.4 } }
  const values = { accounts, todayStats: usage, rangeAccountStats: usage, rangeAccountStatsComplete: true, rangeAccountStatsScope: { source: 'sub2api', instanceId: connection.id }, rangeAccountStatsWindow: period, rangeWindowAuthoritative: true, trendQueryWindow: period, sub2apiRequestWindow: period, lastUpdated: new Date(now), exchangeRate: { rate: 7, rateDate: '2026-10-18', fetchedAt: now, source: 'override' },
    models: [{ model: 'gpt-6-astra', requests: 78, input_tokens: 1560000, output_tokens: 120000, cache_read_tokens: 1365000, total_cost: 16, account_cost: 3.8, actual_cost: 9.2 }, { model: 'claude-sonnet-4-5', requests: 42, input_tokens: 840000, output_tokens: 60000, cache_read_tokens: 735000, total_cost: 12, account_cost: 4, actual_cost: 7.4 }],
    trend: Array.from({ length: 12 }, (_, i) => ({ date: new Date(start + i * 300000).toISOString(), requests: 5 + i, input_tokens: 100000 + i * 8000, output_tokens: 5000 + i * 1000, cost: .4 + i * .04, actual_cost: .8 + i * .07, account_cost: .25 + i * .03 })),
    modelRoutes: [{ key: 'demo-route', requestedModel: 'gpt-6-astra', upstreamModel: 'gpt-6-astra', upstreamResponseModel: 'gpt-6-astra', upstreamModelMismatch: false, modelAuditStatus: 'matched', mappingChain: 'DEMO direct', provider: 'openai', accountId: 1, accountName: 'DEMO Subscription', accountType: 'oauth', channelId: null, channelName: 'DEMO Direct', groupId: null, groupName: 'DEMO Pool', inboundEndpoint: '/v1/responses', upstreamEndpoint: '/v1/responses', channelPricing: null, requests: 78, inputTokens: 1560000, cacheReadTokens: 1365000, outputTokens: 120000, totalTokens: 1680000, standardCost: 16, accountCost: 3.8, revenue: 9.2, firstSeen: new Date(start).toISOString(), lastSeen: new Date(now).toISOString() }],
    modelPricing: Object.fromEntries(['gpt-6-astra', 'claude-sonnet-4-5'].map(model => [model, { found: true, input_price: .000002, output_price: .000008, cache_read_price: .0000002 }])),
    pricingStatus: { model_count: 2, last_updated: new Date(now).toISOString(), local_hash: 'DEMO', catalog_source: 'https://prices.example.invalid', configured_source: 'https://prices.example.invalid', fallback_available: true, update_interval_hours: 24 },
    opsOverview: { start_time: new Date(start).toISOString(), end_time: new Date(now).toISOString(), platform: 'all', success_count: 118, error_count_total: 2, business_limited_count: 0, error_count_sla: 2, request_count_total: 120, request_count_sla: 120, token_consumed: 2580000, sla: 98.33, error_rate: 1.67, upstream_error_rate: 1.67, upstream_error_count_excl_429_529: 1, upstream_429_count: 1, upstream_529_count: 0, qps: { current: .04, peak: .08, avg: .033 }, tps: { current: 720, peak: 1400, avg: 716 }, duration: { p50_ms: 12000, p95_ms: 22000 }, ttft: { p50_ms: 650, p95_ms: 1250 } },
    opsTrend: Array.from({ length: 12 }, (_, i) => ({ bucket_start: new Date(start + i * 300000).toISOString(), request_count: 5 + i, success_count: 5 + i, error_count: 0, token_consumed: 107000 + i * 9000, input_tokens: 100000 + i * 8000, output_tokens: 7000 + i * 1000, cache_creation_tokens: 0, cache_read_tokens: 87500 + i * 7000, user_billed_usd: .8 + i * .07, account_cost_usd: .25 + i * .03, contribution_usd: .55 + i * .04, duration_p95_ms: 22000 - i * 300, ttft_p50_ms: 650 + i * 10, ttft_p95_ms: 1250 + i * 10, qps: (5 + i) / 300, tps: (107000 + i * 9000) / 300 })),
    accountEconomics: buildEconomics({ accounts: accounts.map(account => ({ account, health: { successCount: 60, failureCount: 1 } })), billedUsdTotal: 16.6, accountCostUsdTotal: 7.8, outputBasis: 'revenue', cnyPerUsd: 7, now, window: period }),
  }
  for (const [key, value] of Object.entries(values)) data[key].value = value
  for (const key of Object.keys(data.sourceStates.value)) data.sourceStates.value[key] = sourceState(key, ['accounts', 'todayStats', 'rangeStats', 'models', 'modelRoutes', 'dashboard', 'economics', 'ops', 'modelPricing'].includes(key) ? 'measured' : 'unavailable', 'DEMO documentation fixture')
  for (const name of ['reload', 'loadAccountEconomics', 'invalidatePendingRequest']) data[name] = async () => undefined
  return data
}
export function fillUnified(data) {
  data.period.value = { start: new Date(start), end: new Date(now) }
  data.sourceReadings.value = Object.fromEntries(['sub2api', 'cliproxy', 'cockpit'].map((source, i) => [source, { source, instanceId: `demo-${source}`, startMs: start, endMs: now, costUsd: [7.8, 3.4, 2.2][i], records: [120, 60, 40][i], tokens: [2580000, 980000, 600000][i], latestRecordMs: now, state: i ? 'estimated' : 'measured', coverageBasis: 'stored_records', reason: 'DEMO same-window fixture' }]))
  data.loadUnified = async () => undefined
  return data
}
