import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from './url'
import { formatUsagePercent, usageLocale } from '@/utils/usageFormat'
import i18n from '@/i18n'

const t = i18n.global.t

export interface RequestTiming {
  startedAtMs: number | null
  completedAtMs: number | null
  durationMs: number | null
  ttftMs: number | null
  streamingDurationMs: number | null
  basis: string
}

export interface TurnTiming {
  turnId: string
  startedAtMs: number | null
  completedAtMs: number | null
  durationMs: number | null
  ttftMs: number | null
  basis: string
}

export interface RuntimeModeEvidence {
  mode: string | null
  conflicted: boolean
  observedAtMs: number
  source: 'codex_turn_feedback_tag'
}

export interface MonitorTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requestCount: number
  pricedCostUsd: number
  pricedCostCny?: number
  scenarioRequests?: number
  scenarios?: MonitorScenarioTotal[]
  unpricedRequests: number
  incompleteRequests: number
  cacheHitRatio: number | null
  knownCacheInputTokens?: number
  knownCacheReadTokens?: number
  knownCacheHitRatio?: number | null
  cacheKnownRequests?: number
  outputTokensPerSecond: number
  reasoningTokens?: number
  reasoningKnownRequests?: number
  actualModeCounts?: Record<string, number>
  requestedModeCounts?: Record<string, number>
  unpricedTokens?: number
  unpricedTokenKnownRequests?: number
  unpricedReasonCounts?: Record<string, number>
  priceSummary?: MonitorStoredPriceSummary
  automaticPriceSummary?: MonitorAutomaticPriceSummary
}

export interface MonitorAutomaticModeSummary {
  responseRequests: number
  requestedRequests: number
  unknownRequests: number
  coveredRequests: number
  byCurrency: Record<string, { amount: number; requestCount: number }>
}

export interface MonitorAutomaticPriceSummary {
  byMode: Record<string, MonitorAutomaticModeSummary>
  byCurrency: Record<string, {
    responseSubtotal: number; responseRequests: number
    requestedSubtotal: number; requestedRequests: number
    unknownReferenceSubtotal: number; unknownReferenceRequests: number
  }>
}

export interface MonitorStoredPriceSummary {
  coveredRequests: number
  byCurrency: Record<string, { confirmedSubtotal: number; confirmedRequests: number; standardSubtotal: number; standardRequests: number }>
}

export interface MonitorSession {
  key: string
  tool: string
  id: string
  parentId: string | null
  project: string | null
  model: string | null
  status: string
  startedAtMs: number
  updatedAtMs: number
  turnTiming?: TurnTiming | null
  totals: MonitorTotals
  recentRequest?: RecentRequest | null
  requestSpeed?: RequestSpeed
  latestCompletedTurn?: CompletedTurnSummary | null
}

export interface CompletedTurnSummary {
  timing: TurnTiming
  outputTokens: number | null
  outputTokensPerSecond: number | null
}

export interface RecentRequest {
  id: string
  timestampMs: number
  model: string | null
  modelBasis: string
  mode: string | null
  modeBasis: string
  requestedMode: string | null
  requestedModel: string | null
  requestTiming: RequestTiming | null
  runtimeMode?: RuntimeModeEvidence | null
  unknownFields?: string[]
}

export interface WeightedRequestSpeed {
  basis: string | null
  validSamples: number
  totalSamples: number
  outputTokens: number
  durationMs: number
  outputTokensPerSecond: number | null
}

export interface RequestSpeedSample {
  requestId: string
  timestampMs: number
  outputTokens: number
  durationMs: number
  outputTokensPerSecond: number
  basis: string
  startedAtMs: number | null
  completedAtMs: number | null
  ttftMs: number | null
  streamingDurationMs: number | null
  streamingTokensPerSecond: number | null
}

export interface RequestSpeed {
  latest: RequestSpeedSample | null
  last10: WeightedRequestSpeed
  byBasis: WeightedRequestSpeed[]
}

export interface PriceEvidence {
  version: string
  sourceUrl: string
  checkedAt: string
  model: string
  mode: string
  contextTier: string
  inputPerMillion: number
  cachedPerMillion: number | null
  cacheWritePerMillion?: number | null
  cacheWrite5mPerMillion: number | null
  cacheWrite1hPerMillion: number | null
  outputPerMillion: number
  currency?: string
  pricingProvider?: string
  excludedComponents?: string[]
  catalogRevision?: string | null
  pricingBasis?: string | null
  ruleVersion?: string | null
  ruleSources?: string[]
  timeBand?: string | null
}

export interface MonitorScenarioTotal {
  scenarioKey?: string | null
  mode: string
  currency: string
  amount: number
  requestCount: number
}

export interface MonitorCostEstimate {
  usd: number | null
  cny?: number | null
  scenarios?: Array<{ scenarioKey?: string | null; mode: string; amount: number; evidence: PriceEvidence }>
  reason: string | null
  evidence: PriceEvidence | null
}

export interface MonitorRequest {
  id: string
  tool: string
  sessionId: string
  turnId: string
  requestId: string | null
  rootTurnId: string | null
  timestampMs: number
  model: string | null
  requestedModel: string | null
  modelBasis: string
  mode: string | null
  requestedMode: string | null
  modeBasis: string
  runtimeMode?: RuntimeModeEvidence | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite5mTokens: number | null
  cacheWrite1hTokens: number | null
  reasoningTokens: number | null
  durationMs: number | null
  contextTokens: number | null
  requestTiming?: RequestTiming | null
  usageBasis: string
  unknownFields: string[]
  cost: MonitorCostEstimate
}

export interface SessionStatusCounts {
  running: number
  recent: number
  stale: number
  idle: number
  unknown: number
  activeLast30m: number
}

export interface MonitorSnapshot {
  collectedAtMs: number
  refreshMs: number
  rateWindowSeconds: number
  totals: MonitorTotals
  sessions: MonitorSession[]
  activeSessions?: MonitorSession[]
  rateSessions?: MonitorSession[]
  sessionCount: number
  statusCounts?: SessionStatusCounts
  toolStatusCounts?: Record<string, SessionStatusCounts>
  sources: Array<{
    tool: string
    root: string
    status: string
    files: number
    lastScanMs: number
    error: string | null
    registeredFiles?: number
    presentRegisteredFiles?: number | null
    missingRegisteredFiles?: number | null
  }>
  collecting: boolean
  error: string | null
  live?: LiveSnapshot
}

export interface LiveWindow {
  seconds: number
  observedOutputTokens: number
  outputTokensPerSecond: number | null
  coveredMs: number
  complete: boolean
  sourceComplete?: boolean
}

export interface LiveGroup {
  tool: string | null
  model: string | null
  sessionKey: string | null
  windows: LiveWindow[]
}

export interface LiveBucket {
  startMs: number
  endMs: number
  observedOutputTokens: number
  outputTokens: number | null
  coveredMs: number
  sourceComplete?: boolean
}

export interface RecordedOutputBucket {
  startMs: number
  endMs: number
  outputTokens: number | null
  knownOutputTokens: number
  requestCount: number
  unknownOutputRequests: number
}

export interface LiveSnapshot {
  sampledAtMs: number
  collectionUpdatedAtMs: number
  basis: string
  windows: LiveWindow[]
  byTool: LiveGroup[]
  byModel: LiveGroup[]
  bySession: LiveGroup[]
  timeline: LiveBucket[]
  timelineByTool?: Record<string, LiveBucket[]>
  recordedTimeline?: RecordedOutputBucket[]
  recordedTimelineByTool?: Record<string, RecordedOutputBucket[]>
  peakMinuteOutputTokens: number | null
  sourceCoverageIncomplete: boolean
  unavailableTools: string[]
}

export interface MonitorSessionDetail {
  session: MonitorSession
  members?: MonitorSession[]
  includeDescendants?: boolean
  unlinkedChildRequests?: number
  requests: MonitorRequest[]
  requestCount: number
  filteredTotals?: MonitorTotals
  selectedCompletedTurn?: CompletedTurnSummary | null
  turns?: Array<{ id: string; startedAtMs?: number; updatedAtMs?: number; totals: MonitorTotals; timing?: TurnTiming | null }>
}

export interface MonitorAnalysisQuery extends MonitorSessionFilters {
  tool: string | null
  startMs: number | null
  endMs: number
  model: string | null
  offset: number
  limit: number
  pricingReason?: string | null
}

export interface MonitorAnalysis {
  startMs: number | null
  endMs: number
  totals: MonitorTotals
  byTool: Array<{ tool: string; model: null; totals: MonitorTotals }>
  toolOverview?: Array<{ tool: string; model: string | null; totals: MonitorTotals }>
  byModel: Array<{ tool: string; model: string | null; totals: MonitorTotals }>
  timeline: Array<{ startMs: number; endMs: number; totals: MonitorTotals }>
  availableModels: string[]
  sessions: MonitorSession[]
  sessionCount: number
  latestRequestAtMs: Record<string, number | null>
}

export interface MonitorWeeklyUsage {
  startMs: number
  endMs: number
  firstRecordAtMs: number | null
  lastRecordAtMs: number | null
  totals: MonitorTotals
  reference?: MonitorReferenceSummary[]
  forecast?: MonitorForecastSummary[]
  byTool: Array<{ tool: string; model: null; totals: MonitorTotals; reference?: MonitorReferenceSummary[]; forecast?: MonitorForecastSummary[] }>
}

export interface MonitorReferenceSummary {
  currency: string
  amount: number | null
  knownSubtotal: number
  pricedRequests: number
  unpricedRequests: number
  requestedModelRequests: number
  catalogRevision: string | null
  ruleVersion: string
  excludedComponents?: string[]
}

export interface MonitorForecastSummary {
  currency: string
  method: 'week_average' | 'trailing_7d' | 'weekday_hour'
  projectedAmount: number | null
  projectedSubtotal: number | null
  observedSubtotal: number
  additionalSubtotal: number | null
  pricedRequests: number
  unpricedRequests: number
  coverage: 'observed_records_only' | 'complete'
  timeBasis?: string
  reason: string
  comparisons: Array<{ method: string; folds: number; mae: number | null; reason?: string }>
}

export interface MonitorQuota {
  id: number
  tool: string
  accountKey: string
  accountLabel: string
  attribution: string
  limitId: string
  slot: string
  windowMinutes: number | null
  plan: string | null
  modelId: string | null
  poolLabel: string | null
  observedAtMs: number | null
  resetsAtMs: number | null
  usedPercent: number | null
  remainingPercent: number | null
  source: string
  stale: boolean
  expired: boolean
  sourceError: string | null
  depletion?: DepletionEstimate
  credits?: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null
}

export interface DepletionEstimate {
  status: string
  reason: string | null
  remainingHours: number | null
  survivesUntilReset: boolean | null
  consumptionPercentPerHour: number | null
  sampleCount: number
  spanMs: number
  asOfMs: number | null
}

export interface MonitorQuotaReport {
  collectedAtMs: number
  quotas: MonitorQuota[]
  sources: Array<{ tool: string; source: string; status: string; error: string | null; scopeNote?: string | null; coverage?: { registeredFiles: number; metadataErrors: number; scopesReported: number; scopesUnreported: number; tailErrors: number } | null }>
}

export function getUsageMonitorWeekly(startMs: number, endMs: number, forecastEndMs?: number): Promise<MonitorWeeklyUsage> {
  if (!isDesktopRuntime()) return Promise.reject(new Error('全局用量监控需要桌面端'))
  return invoke('usage_monitor_weekly', { startMs, endMs, ...(forecastEndMs == null ? {} : { forecastEndMs }) })
}

export function getUsageMonitorQuotas(): Promise<MonitorQuotaReport> {
  if (!isDesktopRuntime()) return Promise.reject(new Error('全局用量监控需要桌面端'))
  return invoke('usage_monitor_quotas')
}

export function monitorWeekBounds(now: number): { startMs: number; endMs: number } {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

export function monitorCacheRatio(totals: MonitorTotals | null | undefined): string {
  return monitorRatio(totals?.cacheHitRatio ?? totals?.knownCacheHitRatio ?? null)
}

export function monitorCacheCoverage(totals: MonitorTotals | null | undefined): string {
  return totals?.cacheHitRatio == null && totals?.knownCacheHitRatio != null
    ? t('usageMonitor.format.completeCacheFields', { known: (totals.cacheKnownRequests ?? 0).toLocaleString(usageLocale()), total: totals.requestCount.toLocaleString(usageLocale()) }) : ''
}

export interface MonitorRequestFilters {
  includeDescendants?: boolean
  startMs?: number | null
  endMs?: number
  model?: string | null
  turnId?: string | null
  pricingReason?: string | null
}

export const MONITOR_PAGE_SIZE = 100

export interface MonitorSessionFilters {
  search?: string
  status?: 'all' | 'active' | 'history'
  unpricedOnly?: boolean
}

export function getUsageMonitorSnapshot(tool: string | null, offset: number, filters: MonitorSessionFilters = {}): Promise<MonitorSnapshot> {
  if (!isDesktopRuntime()) return Promise.reject(new Error('全局用量监控需要桌面端'))
  return invoke('usage_monitor_snapshot', { tool, offset, limit: MONITOR_PAGE_SIZE, ...filters })
}

export function getUsageMonitorAnalysis(query: MonitorAnalysisQuery): Promise<MonitorAnalysis> {
  if (!isDesktopRuntime()) return Promise.reject(new Error('全局用量监控需要桌面端'))
  return invoke('usage_monitor_analysis', { ...query, limit: MONITOR_PAGE_SIZE })
}

export function getUsageMonitorSession(key: string, offset: number, unpricedOnly = false, filters: MonitorRequestFilters = {}): Promise<MonitorSessionDetail> {
  if (!isDesktopRuntime()) return Promise.reject(new Error('全局用量监控需要桌面端'))
  return invoke('usage_monitor_session', { key, offset, limit: MONITOR_PAGE_SIZE, unpricedOnly, ...filters })
}

export function monitorRatio(value: number | null): string {
  return value == null ? t('usageMonitor.text.unknown') : formatUsagePercent(value * 100)
}

export function monitorCost(value: number | null, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
  if (value == null) return t('usageMonitor.format.cannotEstimate')
  const amount = Math.abs(value) > 0 && Math.abs(value) < 1e-6
    ? value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 12 }) : value.toFixed(6)
  return `${symbol}${amount}`
}

export function monitorAmount(amount: number, currency: string): string {
  return `${currency === 'USD' ? t('usageMonitor.text.usd') : currency === 'CNY' ? t('usageMonitor.text.cny') : currency} ${monitorCost(amount, currency)}`
}

type QuoteTotals = Pick<MonitorTotals, 'requestCount' | 'unpricedRequests' | 'pricedCostUsd' | 'pricedCostCny' | 'scenarioRequests'> & Partial<Pick<MonitorTotals, 'scenarios' | 'priceSummary' | 'automaticPriceSummary'>>

function recognizedQuoteMode(value: string | null | undefined): string | null {
  const mode = value ? ({ normal: 'standard', default: 'standard', priority: 'fast' } as Record<string, string>)[value] ?? value : ''
  return ['standard', 'fast', 'ultrafast', 'flex', 'scale'].includes(mode) ? mode : null
}

export function monitorAutomaticPriceSummary(totals: Pick<MonitorTotals, 'requestCount' | 'automaticPriceSummary'> | null | undefined) {
  const summary = totals?.automaticPriceSummary
  const byMode = Object.entries(summary?.byMode ?? {}).map(([mode, row]) => ({
    mode, ...row,
    requestCount: row.responseRequests + row.requestedRequests + row.unknownRequests,
    quotes: Object.entries(row.byCurrency).map(([currency, amount]) => ({ currency, ...amount })),
  }))
  const responseModeRequests = byMode.reduce((sum, row) => sum + row.responseRequests, 0)
  const requestedModeRequests = byMode.reduce((sum, row) => sum + row.requestedRequests, 0)
  const coveredRequests = byMode.reduce((sum, row) => sum + row.coveredRequests, 0)
  return {
    currencies: Object.entries(summary?.byCurrency ?? {}).map(([currency, row]) => ({
      currency,
      identifiedSubtotal: row.responseRequests + row.requestedRequests > 0 ? row.responseSubtotal + row.requestedSubtotal : null,
      responseSubtotal: row.responseRequests > 0 ? row.responseSubtotal : null,
      clientSettingSubtotal: row.requestedRequests > 0 ? row.requestedSubtotal : null,
      unknownReferenceSubtotal: row.unknownReferenceRequests > 0 ? row.unknownReferenceSubtotal : null,
      responseRequests: row.responseRequests,
      clientSettingRequests: row.requestedRequests,
      unknownReferenceRequests: row.unknownReferenceRequests,
    })),
    modes: byMode, responseModeRequests, requestedModeRequests,
    unknownRequests: Math.max(0, (totals?.requestCount ?? 0) - responseModeRequests - requestedModeRequests),
    coveredRequests,
    identifiedUnquotedRequests: Math.max(0, responseModeRequests + requestedModeRequests - coveredRequests),
    complete: (totals?.requestCount ?? 0) > 0 && coveredRequests === totals?.requestCount,
  }
}

export interface MonitorAutomaticRequestPrice {
  mode: string | null
  basis: 'response_reported' | 'runtime_mode' | 'requested_mode' | 'unknown'
  quotes: Array<{ currency: string; amount: number; evidence: PriceEvidence | null }>
  unknownReference: Array<{ currency: string; amount: number; evidence: PriceEvidence | null }>
  quoteBasis: 'saved_single' | 'saved_matching_scenario' | 'none'
}

export type MonitorAutomaticModeInput = Pick<MonitorRequest, 'mode' | 'modeBasis' | 'requestedMode' | 'runtimeMode'> & Partial<Pick<MonitorRequest, 'unknownFields' | 'timestampMs' | 'requestTiming'>>

export function monitorAutomaticMode(request: MonitorAutomaticModeInput): Pick<MonitorAutomaticRequestPrice, 'mode' | 'basis'> {
  const actual = request.modeBasis === 'response_reported' ? recognizedQuoteMode(request.mode) : null
  if (actual) return { mode: actual, basis: 'response_reported' }
  if (request.unknownFields?.includes('requested_mode_ambiguous')) return { mode: null, basis: 'unknown' }
  if (request.runtimeMode?.conflicted) return { mode: null, basis: 'unknown' }
  const start = request.requestTiming?.startedAtMs
  const runtimeAsOf = request.runtimeMode != null && !request.unknownFields?.includes('timestamp')
    && (request.timestampMs == null || request.runtimeMode.observedAtMs <= request.timestampMs)
    && (start == null || request.runtimeMode.observedAtMs <= start)
  const runtime = runtimeAsOf ? recognizedQuoteMode(request.runtimeMode?.mode) : null
  if (runtimeAsOf) return { mode: runtime, basis: runtime ? 'runtime_mode' : 'unknown' }
  const requested = recognizedQuoteMode(request.requestedMode)
  return { mode: requested, basis: requested ? 'requested_mode' : 'unknown' }
}

export function monitorRequestAutomaticPrice(request: MonitorAutomaticModeInput & Pick<MonitorRequest, 'cost'>): MonitorAutomaticRequestPrice {
  const { mode, basis } = monitorAutomaticMode(request)
  const cost = request.cost
  const singles = [{ currency: 'USD', amount: cost.usd }, { currency: 'CNY', amount: cost.cny }]
    .filter((quote): quote is { currency: string; amount: number } => quote.amount != null && Number.isFinite(quote.amount) && quote.amount >= 0)
    .map(quote => ({ ...quote, evidence: cost.evidence ?? null }))
  const uniqueScenario = (selected: string) => {
    const matching = (cost.scenarios ?? []).filter(quote => recognizedQuoteMode(quote.mode) === selected)
    const quote = matching[0]
    if (!quote || !Number.isFinite(quote.amount) || quote.amount < 0) return []
    const currency = quote.evidence.currency ?? 'USD'
    return currency && matching.every(other => (other.evidence.currency ?? 'USD') === currency && other.amount === quote.amount)
      ? [{ currency, amount: quote.amount, evidence: quote.evidence }] : []
  }
  if (mode == null) return { mode, basis: 'unknown', quotes: [], unknownReference: singles.length ? singles : uniqueScenario('standard'), quoteBasis: 'none' }
  const singleMatches = recognizedQuoteMode(cost.evidence?.mode) === mode || !!cost.reason?.includes('same_amount_for_all_published_tariffs')
  const quotes = singleMatches && singles.length ? singles : uniqueScenario(mode)
  return { mode, basis, quotes, unknownReference: [], quoteBasis: quotes.length ? singleMatches && singles.length ? 'saved_single' : 'saved_matching_scenario' : 'none' }
}

export interface MonitorPriceDisplay {
  currencies: Array<{
    currency: string
    confirmedSubtotal: number | null
    referenceSubtotal: number | null
    confirmedRequests: number
    standardRequests: number
    coveredRequests: number
    basis: 'confirmed_quote' | 'standard_reference' | 'confirmed_plus_standard_reference'
  }>
  coveredRequests: number
  uncoveredRequests: number
  complete: boolean
  basis: 'saved_quotes_and_standard_reference' | 'legacy_subtotal_only' | 'unpriced'
}

export function monitorPriceSummary(totals: QuoteTotals | null | undefined): MonitorPriceDisplay {
  if (!totals || totals.requestCount === 0) return { currencies: [], coveredRequests: 0, uncoveredRequests: 0, complete: false, basis: 'unpriced' }
  if (!totals.priceSummary) {
    const quotes = monitorSingleQuotes(totals)
    const usdOnly = totals.pricedCostCny == null
    const confirmedCount = usdOnly ? Math.max(0, totals.requestCount - totals.unpricedRequests) : 0
    return {
      currencies: quotes.map(quote => ({ currency: quote.currency, confirmedSubtotal: quote.amount, referenceSubtotal: quote.amount, confirmedRequests: confirmedCount, standardRequests: 0, coveredRequests: confirmedCount, basis: 'confirmed_quote' })),
      coveredRequests: confirmedCount,
      uncoveredRequests: totals.requestCount - confirmedCount,
      complete: false,
      basis: quotes.length ? 'legacy_subtotal_only' : 'unpriced',
    }
  }
  const currencies: MonitorPriceDisplay['currencies'] = Object.entries(totals.priceSummary.byCurrency)
    .filter(([, row]) => row.confirmedRequests > 0 || row.standardRequests > 0)
    .map(([currency, row]) => ({
      currency,
      confirmedSubtotal: row.confirmedRequests > 0 ? row.confirmedSubtotal : null,
      referenceSubtotal: row.confirmedSubtotal + row.standardSubtotal,
      confirmedRequests: row.confirmedRequests,
      standardRequests: row.standardRequests,
      coveredRequests: row.confirmedRequests + row.standardRequests,
      basis: row.standardRequests > 0 ? row.confirmedRequests > 0 ? 'confirmed_plus_standard_reference' : 'standard_reference' : 'confirmed_quote',
    }))
  const coveredRequests = totals.priceSummary.coveredRequests
  const uncoveredRequests = Math.max(0, totals.requestCount - coveredRequests)
  return { currencies, coveredRequests, uncoveredRequests, complete: coveredRequests === totals.requestCount, basis: currencies.length ? 'saved_quotes_and_standard_reference' : 'unpriced' }
}

export function monitorSingleQuotes(totals: QuoteTotals | null | undefined): Array<{ currency: string; amount: number }> {
  if (totals?.priceSummary) return Object.entries(totals.priceSummary.byCurrency).filter(([, row]) => row.confirmedRequests > 0).map(([currency, row]) => ({ currency, amount: row.confirmedSubtotal }))
  if (!totals || totals.requestCount === 0 || totals.requestCount <= totals.unpricedRequests) return []
  const quotes = [{ currency: 'USD', amount: totals.pricedCostUsd }]
  if (totals.pricedCostCny != null) quotes.push({ currency: 'CNY', amount: totals.pricedCostCny })
  return totals.pricedCostCny == null ? quotes : quotes.filter(quote => quote.amount !== 0)
}

export function monitorUnquotedRequests(totals: Pick<MonitorTotals, 'unpricedRequests' | 'scenarioRequests'> & Partial<Pick<MonitorTotals, 'requestCount' | 'automaticPriceSummary'>>): number {
  if (totals.automaticPriceSummary) {
    const modes = Object.values(totals.automaticPriceSummary.byMode)
    const requests = totals.requestCount ?? modes.reduce((sum, mode) => sum + mode.responseRequests + mode.requestedRequests + mode.unknownRequests, 0)
    return Math.max(0, requests - modes.reduce((sum, mode) => sum + mode.coveredRequests, 0))
  }
  return Math.max(0, totals.unpricedRequests - (totals.scenarioRequests ?? 0))
}

export function monitorTotalCost(totals: QuoteTotals | null | undefined): string {
  if (!totals) return t('usageMonitor.text.unknown')
  if (totals.requestCount === 0) return t('usageMonitor.text.noRequestsYet')
  if (totals.automaticPriceSummary) {
    const summary = monitorAutomaticPriceSummary(totals)
    const amounts = summary.currencies.filter(row => row.identifiedSubtotal != null).map(row => monitorAmount(row.identifiedSubtotal!, row.currency)).join(' · ')
    if (!amounts) return summary.unknownRequests > 0 ? t('usageMonitor.format.unidentifiedModeReferenceSeparate') : t('usageMonitor.format.identifiedModeInsufficientPrices')
    const gaps = summary.unknownRequests + summary.identifiedUnquotedRequests
    return gaps > 0 ? t('usageMonitor.format.automaticSubtotal', { amounts, gaps: gaps.toLocaleString(usageLocale()) }) : t('usageMonitor.format.automaticEstimate', { amounts })
  }
  if (totals.priceSummary) {
    const summary = monitorPriceSummary(totals)
    if (!summary.currencies.length) return t('usageMonitor.format.cannotEstimate')
    const amounts = summary.currencies.map(row => `${monitorAmount(row.referenceSubtotal!, row.currency)}${row.basis === 'standard_reference' ? t('usageMonitor.format.standardReference') : row.basis === 'confirmed_plus_standard_reference' ? t('usageMonitor.format.conditionalAndStandardReference') : ''}`).join(' · ')
    return summary.uncoveredRequests > 0 ? t('usageMonitor.format.knownSubtotal', { amounts, gaps: summary.uncoveredRequests.toLocaleString(usageLocale()) }) : amounts
  }
  const quotes = monitorSingleQuotes(totals)
  if (quotes.length) return quotes.map(quote => monitorAmount(quote.amount, quote.currency)).join(' · ')
  if (!totals.scenarioRequests) return t('usageMonitor.format.cannotEstimate')
  return t('usageMonitor.format.multiplePrices')
}

export function monitorMode(mode: string): string {
  return ({ standard: t('usageMonitor.format.standardMode'), default: t('usageMonitor.format.standardMode'), fast: t('usageMonitor.format.fastMode'), priority: t('usageMonitor.format.fastMode'), ultrafast: t('usageMonitor.format.priorityMode'), auto: t('usageMonitor.format.automaticMode'), flex: t('usageMonitor.format.flexMode') } as Record<string, string>)[mode] ?? mode
}

export function monitorContext(value: string): string {
  if (value === 'base' || value === 'standard') return t('usageMonitor.format.regularContext')
  if (value === 'full published context window') return t('usageMonitor.format.fullContext')
  return value.replace(/^(<=|>)(\d+)(?: input tokens)?$/, (_, sign, count) => t(sign === '<=' ? 'usageMonitor.format.inputAtMost' : 'usageMonitor.format.inputMoreThan', { count: Number(count).toLocaleString(usageLocale()) }))
}

export function monitorScenarioLabel(scenario: { mode: string; scenarioKey?: string | null }): string {
  const band = scenario.scenarioKey?.split(':').slice(1).join(':')
  return `${monitorMode(scenario.mode)}${band ? ` · ${band === 'peak' ? t('usageMonitor.format.peakBand') : band === 'off_peak' ? t('usageMonitor.format.offPeakBand') : band}` : ''}`
}

export function monitorRequestCost(cost: MonitorCostEstimate): string {
  const quotes = []
  if (cost.usd != null) quotes.push(monitorAmount(cost.usd, 'USD'))
  if (cost.cny != null) quotes.push(monitorAmount(cost.cny, 'CNY'))
  if (quotes.length) return quotes.join(' · ')
  return cost.scenarios?.length ? cost.scenarios.map(scenario => t('usageMonitor.format.scenarioEstimate', { scenario: monitorScenarioLabel(scenario), amount: monitorAmount(scenario.amount, scenario.evidence.currency ?? 'USD') })).join(' / ') : t('usageMonitor.format.cannotEstimate')
}

export function monitorToken(request: MonitorRequest, field: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'): number | null {
  if (request.unknownFields.includes(field)) return null
  switch (field) {
    case 'input_tokens': return request.inputTokens
    case 'output_tokens': return request.outputTokens
    case 'cache_read_tokens': return request.cacheReadTokens
    case 'cache_write_tokens': return request.cacheWriteTokens
  }
}

export function groupMonitorTurns(requests: MonitorRequest[]): Array<{ id: string; requests: MonitorRequest[] }> {
  const groups = new Map<string, MonitorRequest[]>()
  for (const request of requests) {
    const rows = groups.get(request.turnId) ?? []
    rows.push(request)
    groups.set(request.turnId, rows)
  }
  return Array.from(groups, ([id, rows]) => ({ id, requests: rows }))
}
