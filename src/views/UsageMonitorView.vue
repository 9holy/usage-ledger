<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, Check, CalendarDays, ChevronLeft, ChevronRight, ChevronDown, GitBranch, Pause, Play, RefreshCw, RotateCcw, EyeOff, Search, X, Clock3, Database, Info, ExternalLink, MessageSquare } from '@lucide/vue'
import ConsoleWorkspaceHeader from '@/features/desktop/ConsoleWorkspaceHeader.vue'
import UsageLivePanel from '@/features/desktop/UsageLivePanel.vue'
import UsageCostSummary from '@/features/desktop/UsageCostSummary.vue'
import UsageCostAccounts from '@/features/desktop/UsageCostAccounts.vue'
import UsageAccountCost from '@/features/desktop/UsageAccountCost.vue'
import UsageApiPrices from '@/features/desktop/UsageApiPrices.vue'
import LocalCostUsagePanel from '@/features/desktop/LocalCostUsagePanel.vue'
import LocalCostChannels from '@/features/desktop/LocalCostChannels.vue'
import CostEventsPanel from '@/features/cost-center/components/CostEventsPanel.vue'
import { useMonitorCosts } from '@/features/desktop/useMonitorCosts'
import { monitorUpstreamRevision } from '@/api/monitorUpstreams'
import { useLocalCostLive } from '@/features/desktop/useLocalCostLive'
import { LOCAL_FINANCE_SCOPE } from '@/api/localCost'
import { displayLiveRate, lastRateLabel, retainLiveRate, type LastLiveWindow } from '@/features/desktop/liveRate'
import { accountLabelSuffixes } from '@/features/desktop/accountLabels'
import UsageTurnTimeline from '@/features/desktop/UsageTurnTimeline.vue'
import UsageValueChart from '@/features/desktop/UsageValueChart.vue'
import { loadAccountQuotaSnapshots, saveAccountQuotaSnapshots, validAccountQuotaSnapshot, type AccountQuotaSnapshot } from '@/features/desktop/accountQuotaSnapshot'
import { projectAccountQuotaCycle } from '@/features/desktop/accountQuotaProjection'
import UsageTokenComposition from '@/features/desktop/UsageTokenComposition.vue'
import UsageRequestPulse from '@/features/desktop/UsageRequestPulse.vue'
import UsagePriceFlow from '@/features/desktop/UsagePriceFlow.vue'
import UsageRecordId from '@/features/desktop/UsageRecordId.vue'
import UsagePeriodSummary from '@/features/desktop/UsagePeriodSummary.vue'
import UsageModelCosts from '@/features/desktop/UsageModelCosts.vue'
import UsageTrend from '@/features/desktop/UsageTrend.vue'
import UsageRecordedMetrics from '@/features/desktop/UsageRecordedMetrics.vue'
import UsageAccountPeriods from '@/features/desktop/UsageAccountPeriods.vue'
import UsageApiAccount from '@/features/desktop/UsageApiAccount.vue'
import UsagePricingCoveragePanel from '@/features/desktop/UsagePricingCoveragePanel.vue'
import UsageModeEvidence from '@/features/desktop/UsageModeEvidence.vue'
import UsageEfficiencyBand from '@/features/desktop/UsageEfficiencyBand.vue'
import { usageColors, usageCoverageColors, usageChartStyle, usageModelColor, usageToolColor, usageModeColor, usagePercentLabel } from '@/features/desktop/usageChartPalette'
import PlatformIcon from '@/components/common/PlatformIcon.vue'
import '@/styles/console-theme.css'
import { isDesktopRuntime } from '@/api/url'
import { getUsageMonitorAccounts, type AccountUsageReport } from '@/api/usageAccounts'
import { getModelCatalogStatus, refreshModelCatalog, quoteModelCatalogBatch, type ModelCatalogStatus } from '@/api/modelCatalog'
import {
  getUsageMonitorSnapshot, getUsageMonitorAnalysis, getUsageMonitorSession, monitorTotalCost, monitorToken,
  monitorSingleQuotes, monitorAutomaticMode, monitorAutomaticPriceSummary, monitorRequestAutomaticPrice, monitorUnquotedRequests, monitorAmount, monitorMode, monitorScenarioLabel,
  monitorCacheRatio, monitorCacheCoverage, monitorContext, monitorKnownTokenTotal, monitorTokenCoverage, monitorRequestCountLabel, monitorIsUnitemizedRecord,
  getUsageMonitorWeekly, getUsageMonitorQuotas, monitorWeekBounds,
  type MonitorWeeklyUsage, type MonitorQuotaReport, type MonitorQuota,
  MONITOR_PAGE_SIZE, type LiveSnapshot, type LiveWindow, type MonitorSnapshot, type MonitorAnalysis, type MonitorAnalysisQuery, type MonitorSessionDetail, type MonitorCostEstimate, type PriceEvidence, type MonitorSession, type MonitorTotals, type MonitorRequest,
} from '@/api/usageMonitor'

const { t } = useI18n()

const desktop = isDesktopRuntime()
const snapshot = ref<MonitorSnapshot | null>(null)
const analysis = ref<MonitorAnalysis | null>(null)
const loadedAnalysisQuery = ref<MonitorAnalysisQuery | null>(null)
const detail = ref<MonitorSessionDetail | null>(null)
const tool = ref<string | null>(null)
const model = ref<string | null>(null)
const route = useRoute()
const tab = ref<'overview' | 'analysis' | 'sessions' | 'sources' | 'costs'>(route?.query?.view === 'costs' ? 'costs' : 'overview')
const callScope = ref<'all' | 'api'>('all')
const billingScope = computed(() => callScope.value === 'api' ? 'api' as const : undefined)
const billingScopes = computed(() => [
  { id: 'all', label: t('usageMonitor.callScope.all') },
  { id: 'api', label: 'API' },
] as const)
const range = ref<'today' | '7d' | '30d' | 'all' | 'month' | 'custom'>(route?.query?.view==='costs'?'month':'today')
const anchor = ref(Date.now())
const dateInput=(value:number)=>{const day=new Date(value);return `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`}
const initialMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1).getTime()
const customStart=ref(dateInput(initialMonth)),customEnd=ref(dateInput(Date.now())),customError=ref('')
const customWindow=ref({startMs:initialMonth,endMs:Date.now()})
function applyCustomRange(){
  const startMs=new Date(customStart.value+'T00:00:00').getTime(),finish=new Date(customEnd.value+'T00:00:00');finish.setDate(finish.getDate()+1)
  const endMs=Math.min(finish.getTime(),Date.now())
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs>=endMs){customError.value=t('usageMonitor.costs.invalidDates');return}
  customError.value='';customWindow.value={startMs,endMs};anchor.value=Date.now();offset.value=0;resetDetailSelection()
}
const ranges = computed(() => [{ id: 'today', label: t('usageMonitor.text.today') }, { id: '7d', label: t('usageMonitor.text.last7Days') }, { id: '30d', label: t('usageMonitor.text.last30Days') }, { id: 'all', label: t('usageMonitor.text.all') },{id:'month',label:t('desktop.localCost.thisMonth')},{id:'custom',label:t('usageMonitor.costs.customDates')}] as const)
function periodAt(endMs:number) {
  if(range.value==='custom')return customWindow.value
  const day = new Date(endMs)
  const startMs = range.value === 'all' ? null : range.value === 'today'
    ? new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
    : range.value==='month'?new Date(day.getFullYear(),day.getMonth(),1).getTime():endMs - (range.value === '7d' ? 7 : 30) * 86400000
  return { startMs, endMs }
}
const windowRange = computed(() => periodAt(anchor.value))
const offset = ref(0)
const selected = ref<string | null>(null)
const detailAll = ref(false)
const includeDescendants = ref(true)
const selectedTurn = ref<string | null>(null)
const selectedRequest = ref<string | null>(null)
const requestOffset = ref(0)
const searchInput = ref('')
const search = ref('')
const sessionStatus = ref<'all' | 'active' | 'history'>('all')
const unpricedOnly = ref(false)
const pricingReasonFilter = ref<string | null>(null)
const requestUnpricedOnly = ref(false)
const following = ref(true)
const historyFilters = computed(() => ({ search: search.value, status: sessionStatus.value, unpricedOnly: unpricedOnly.value, pricingReason: pricingReasonFilter.value }))
const analysisQuery = computed(() => ({ tool: tool.value, ...windowRange.value, model: model.value, ...historyFilters.value, ...(billingScope.value ? {billingScope:billingScope.value} : {}), offset: offset.value, limit: MONITOR_PAGE_SIZE }))
const detailQuery = computed(() => ({ key: selected.value, offset: requestOffset.value, unpricedOnly: requestUnpricedOnly.value, filters: {
  includeDescendants: includeDescendants.value,
  ...(billingScope.value ? {billingScope:billingScope.value} : {}),
  ...(detailAll.value
    ? { startMs: null, model: null, turnId: selectedTurn.value, pricingReason: null }
    : { ...windowRange.value, model: model.value, turnId: selectedTurn.value, pricingReason: pricingReasonFilter.value }),
} }))
const liveBusy = ref(false)
const analysisBusy = ref(false)
const detailBusy = ref(false)
const detailPageReady = ref(false)
const error = ref('')
const analysisError = ref('')
const detailError = ref('')
const catalog = ref<ModelCatalogStatus | null>(null)
const catalogBusy = ref(false)
const catalogError = ref('')
const weekly = ref<MonitorWeeklyUsage | null>(null)
const quotas = ref<MonitorQuotaReport | null>(null)
const accountUsage = ref<AccountUsageReport | null>(null)
const quotaSnapshots = ref(loadAccountQuotaSnapshots())
const summaryBusy = ref(false)
const weeklyError = ref('')
const quotaError = ref('')
const accountUsageError = ref('')
const quotaHistoryOpen = ref(false)
const hiddenQuotaAccountsKey = 'usage-monitor:hidden-quota-accounts:v1'
const quotaAccountStorageError = ref<{ operation: 'read' | 'save'; message: string } | null>(null)
function loadHiddenQuotaAccounts(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(hiddenQuotaAccountsKey) ?? '[]')
    if (!Array.isArray(saved) || !saved.every(key => typeof key === 'string' && key.length > 0)) throw new Error('Invalid hidden quota accounts')
    return [...new Set(saved)]
  } catch (error) {
    quotaAccountStorageError.value = { operation: 'read', message: errorMessage(error) }
    return []
  }
}
const hiddenQuotaAccounts = ref(loadHiddenQuotaAccounts())
const explicitQuotaAccountKey = ref<string | null>(null)
const costPage = ref<'accounts' | 'account' | 'records' | 'channels' | 'api'>('accounts')
const costAccountId = ref(''), accountListReturn = ref(false)
const costSourceKey = ref('all')
watch(costAccountId, () => { costSourceKey.value = 'all' })
const costEvents = ref<InstanceType<typeof CostEventsPanel> | null>(null)
let accountListScroll = 0, accountListTrigger: HTMLElement | null = null
let accountListViewport: Element | null = null
const costPeriodKey = computed(() => `${range.value}:${range.value === 'custom' ? customWindow.value.startMs + ':' + customWindow.value.endMs : ''}`)
const costsEnabled = computed(() => desktop && tab.value !== 'sessions')
const { data: costData, rows: costRows, error: costError, busy: costBusy, saving: costSaving, reload: reloadCosts, save: saveCostSettings, upstreamErrors: upstreamReadErrors } = useMonitorCosts(() => periodAt(Date.now()), costPeriodKey, costsEnabled)
const costAccountChoices = computed(() => costRows.value.filter(row => row.id !== 'unassigned').map(row => ({ id: row.id, name: row.name })))
const selectedAccountCost = computed(() => costRows.value.find(row => row.id === selectedQuotaAccountKey.value))
const inspectedAccount = computed(() => costRows.value.find(row => row.id === costAccountId.value))
const accountLiveEnabled = computed(() => tab.value === 'costs' && costPage.value === 'account' && !!inspectedAccount.value?.tool)
const { report: accountLive, error: accountLiveError } = useLocalCostLive(costAccountId, accountLiveEnabled, costSourceKey)
async function scrollToCosts() { await nextTick(); document.querySelector('.monitor-navigation')?.scrollIntoView({ block: 'start' }) }
function openCostAccounts() { tab.value = 'costs'; costPage.value = 'accounts'; accountListReturn.value = false; void scrollToCosts() }
function openCostChannels() { tab.value = 'costs'; costPage.value = 'channels'; void scrollToCosts() }
async function openCostRecords(id = '', enter = false) {
  costAccountId.value = id; tab.value = 'costs'; costPage.value = 'records'
  await scrollToCosts(); costEvents.value?.selectAccount(id); if (enter) costEvents.value?.openEntry(id)
}
async function inspectCostAccount(id: string) {
  accountListReturn.value = tab.value === 'costs' && costPage.value === 'accounts'
  if (accountListReturn.value) {
    accountListViewport = document.querySelector('.app-window--desktop .app-window__content') ?? document.scrollingElement
    accountListScroll = accountListViewport?.scrollTop ?? 0
    accountListTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  costAccountId.value = id; tab.value = 'costs'; costPage.value = 'account'
  await nextTick(); document.querySelector('.monitor-finance-page')?.scrollIntoView({ block: 'start' })
}
async function backToCostAccounts() { costPage.value = 'accounts'; await nextTick(); if (accountListViewport) accountListViewport.scrollTop = accountListScroll; accountListTrigger?.focus({ preventScroll: true }) }
function openApiPrices() { accountListReturn.value = false; tab.value = 'costs'; costPage.value = 'api'; void scrollToCosts() }
function costsChanged() { void reloadCosts(); void refreshSummary(); void refreshWindow() }
function saveHiddenQuotaAccounts(keys: string[]) {
  hiddenQuotaAccounts.value = keys
  try {
    localStorage.setItem(hiddenQuotaAccountsKey, JSON.stringify(keys))
    quotaAccountStorageError.value = null
  } catch (error) {
    quotaAccountStorageError.value = { operation: 'save', message: errorMessage(error) }
  }
}
const detailSection = ref<HTMLElement | null>(null)
const selectedTrigger = ref<HTMLElement | null>(null)
const requestSection = ref<HTMLElement | null>(null)
const requestTrigger = ref<HTMLElement | null>(null)
const tabs = computed(() => [{ id: 'overview', label: t('usageMonitor.text.liveOverview') }, { id: 'analysis', label: t('usageMonitor.text.usageAnalysis') }, { id: 'sessions', label: t('usageMonitor.text.sessionDetails') }, { id: 'sources', label: t('usageMonitor.text.collectionPricing') }, { id: 'costs', label: t('usageMonitor.inlineCosts.tab') }] as const)
const historyReady = computed(() => {
  const loaded = loadedAnalysisQuery.value
  const current = analysisQuery.value
  return !!analysis.value && !!loaded && loaded.tool === current.tool && loaded.model === current.model && loaded.billingScope === current.billingScope && loaded.search === current.search && loaded.status === current.status && loaded.unpricedOnly === current.unpricedOnly && loaded.pricingReason === current.pricingReason && loaded.offset === current.offset
})
const historyCount = computed(() => historyReady.value ? analysis.value?.sessionCount : undefined)
const visibleSessions = computed(() => tab.value === 'overview' ? snapshot.value?.activeSessions ?? [] : historyReady.value ? analysis.value?.sessions ?? [] : [])
const sessionSort = ref<'recent' | 'rate60' | 'rate300'>('recent')
const collapsedSessions = ref(new Set<string>())
const sortedSessions = computed(() => visibleSessions.value.slice().sort((a, b) => sessionSort.value === 'recent' ? b.updatedAtMs - a.updatedAtMs : (sessionWindow(b.key, sessionSort.value === 'rate60' ? 60 : 300)?.observedOutputTokens ?? 0) - (sessionWindow(a.key, sessionSort.value === 'rate60' ? 60 : 300)?.observedOutputTokens ?? 0)))
const sessionTree = computed(() => {
  const rows = sortedSessions.value
  const present = new Set(rows.map(row => row.key))
  const children = new Map<string, MonitorSession[]>()
  for (const row of rows) if (row.parentId) { const key = `${row.tool}:${row.parentId}`; children.set(key, [...children.get(key) ?? [], row]) }
  const result: Array<{ session: MonitorSession; depth: number; childCount: number }> = []
  const visited = new Set<string>()
  function append(row: MonitorSession, depth: number, hidden = false) {
    if (visited.has(row.key)) return
    visited.add(row.key)
    const nested = children.get(row.key) ?? []
    if (!hidden) result.push({ session: row, depth, childCount: nested.length })
    for (const child of nested) append(child, depth + 1, hidden || collapsedSessions.value.has(row.key))
  }
  for (const row of rows) if (!row.parentId || !present.has(`${row.tool}:${row.parentId}`)) append(row, 0)
  for (const row of rows) if (!visited.has(row.key)) append(row, 0)
  return result
})
function toggleSession(key: string) { const next = new Set(collapsedSessions.value); next.has(key) ? next.delete(key) : next.add(key); collapsedSessions.value = next }
const periodLabel = computed(() => ranges.value.find(item => item.id === range.value)?.label || t('usageMonitor.text.currentPeriod'))
const statusCounts = computed(() => tool.value ? snapshot.value?.toolStatusCounts?.[tool.value] : snapshot.value?.statusCounts)
const modelRanking = computed(() => (analysis.value?.byModel ?? []).slice().sort((a, b) => b.totals.totalTokens - a.totals.totalTokens))
const rankingMaximum = computed(() => Math.max(1, ...modelRanking.value.map(row => row.totals.totalTokens)))
function tokenUnit(maximum: number) { return maximum >= 1_000_000 ? { divisor: 1_000_000, label: t('usageMonitor.text.millionTokens') } : maximum >= 1000 ? { divisor: 1000, label: t('usageMonitor.text.thousandTokens') } : { divisor: 1, label: 'Token' } }
const rankingUnit = computed(() => tokenUnit(rankingMaximum.value))
function rankingValue(value: number | null) { if (value == null) return t('usageMonitor.text.unknown'); const scaled = value / rankingUnit.value.divisor; return scaled > 0 && scaled < 0.01 ? '<0.01' : scaled.toLocaleString(usageLocale(), { maximumFractionDigits: 2 }) }
const sourceGroups = computed(() => tools.value.filter(item => item.id).map(item => {
  const rows = snapshot.value?.sources.filter(row => row.tool === item.id) ?? []
  const usage = rows.filter(row => row.status !== 'metadata')
  const issues = usage.filter(row => row.error || !['watching', 'idle'].includes(row.status))
  const modeIssues = rows.filter(row => row.status === 'metadata' && row.error).length
  return { tool: item.id!, rows, usage, issues: issues.length + modeIssues,
    tone: !usage.length ? 'unknown' : usage.every(row => row.status === 'error') ? 'error' : issues.length || modeIssues ? 'warning' : usage.some(row => row.status === 'watching') ? 'healthy' : 'unknown',
    status: !usage.length ? t('usageMonitor.text.usageSourcesNotYetAvailable') : usage.every(row => row.status === 'error') ? t('usageMonitor.text.failedToReadUsageSources') : issues.length ? t('usageMonitor.text.someSourcesNeedAttention') : modeIssues ? t('usageMonitor.text.usageAvailableModeLogsUnavailable') : usage.some(row => row.status === 'watching') ? t('usageMonitor.text.collecting') : t('usageMonitor.text.waitingForNewRecords'),
    files: usage.reduce((sum, row) => sum + row.files, 0),
    missing: usage.reduce((sum, row) => sum + (row.missingRegisteredFiles ?? 0), 0),
    historyKnown: usage.length > 0 && usage.every(row => row.missingRegisteredFiles != null),
  }
}).filter(group => group.rows.length))
const pricingSegments = computed(() => {
  const total = periodTotals.value
  if (!total || !total.requestCount) return []
  const automatic = monitorAutomaticPriceSummary(total)
  return [
    { label: t('usageMonitor.text.modeIdentifiedEstimateAvailable'), count: automatic.coveredRequests, color: usageCoverageColors.known, state: 'known' },
    { label: t('usageMonitor.text.modeNotYetIdentified'), count: automatic.unknownRequests, color: usageCoverageColors.unknown, state: 'unknown' },
    { label: t('usageMonitor.text.modeIdentifiedUnitPriceMissing'), count: automatic.identifiedUnquotedRequests, color: usageCoverageColors.missing, state: 'missing' },
  ].map(row => ({ ...row, percent: row.count / total.requestCount * 100 }))
})
const priceAvailablePercent = computed(() => periodTotals.value?.requestCount ? monitorAutomaticPriceSummary(periodTotals.value).coveredRequests / periodTotals.value.requestCount * 100 : null)
const modeEvidence = computed(() => [
  { label: t('usageMonitor.text.requestSettings'), counts: periodTotals.value?.requestedModeCounts },
  { label: t('usageMonitor.text.responseConfirmation'), counts: periodTotals.value?.actualModeCounts },
  { label: t('usageMonitor.text.autoDetected'), counts: periodTotals.value?.automaticPriceSummary ? Object.fromEntries(monitorAutomaticPriceSummary(periodTotals.value).modes.map(row => [row.mode, row.requestCount])) : undefined },
].map(row => ({ ...row, segments: [
  { key: 'standard', label: t('usageMonitor.text.standard'), color: usageModeColor('standard') },
  { key: 'fast', label: t('usageMonitor.text.fast'), color: usageModeColor('fast') },
  { key: 'ultrafast', label: t('usageMonitor.text.priority'), color: usageModeColor('ultrafast') },
  { key: 'unknown', label: t('usageMonitor.text.notReported'), color: usageColors.unknown },
  ...Object.keys(row.counts ?? {}).filter(key => !['standard', 'fast', 'ultrafast', 'unknown'].includes(key)).map(key => ({ key, label: monitorMode(key), color: usageModeColor(key) })),
].map(mode => ({ ...mode, count: row.counts?.[mode.key] ?? 0, percent: periodTotals.value?.requestCount ? (row.counts?.[mode.key] ?? 0) / periodTotals.value.requestCount * 100 : 0 })) })))
function sessionWindow(key: string, seconds: number) { return snapshot.value?.live?.bySession.find(row => row.sessionKey === key)?.windows.find(row => row.seconds === seconds) }
function sessionRate(key: string, seconds: number): string {
  if (!snapshot.value?.collectedAtMs) return t('usageMonitor.text.loading')
  const running = lastRunningSessions.has(key)
  const rate = retainLiveRate(displayLiveRate(sessionWindow(key, seconds)), running, lastLiveWindows.get(key)?.get(seconds))
  return rate.lastAtMs == null ? rate.text : t('usageMonitor.speed.lastValue', { value: rate.text })
}
function sessionRatePartial(key: string): boolean {
  return [60, 300].some(seconds => {
    const window = sessionWindow(key, seconds)
    return window != null && displayLiveRate(window).partial
  })
}
const liveRateSeconds = ref<60 | 300>(60)
function measuredToolRate(live: LiveSnapshot, id: string, seconds: 60 | 300) {
  const samples = live.currentRates?.filter(row => row.tool === id) ?? []
  const current = samples.reduce((sum, row) => sum + row.outputTokensPerSecond, 0)
  if (current > 0) return { value: current.toFixed(1), basis: 'usageMonitor.speed.live', partial: false, sampledAtMs: Math.max(...samples.map(row => row.sampledAtMs)) }
  const average = displayLiveRate(live.byTool.find(row => row.tool === id)?.windows.find(row => row.seconds === seconds))
  if (average.value == null || average.value <= 0) return null
  return { value: average.text, basis: seconds === 60 ? 'usageMonitor.flow.average60' : 'usageMonitor.flow.average300', partial: average.partial, sampledAtMs: live.sampledAtMs }
}
const lastLiveWindows = new Map<string, Map<number, LastLiveWindow>>()
const lastToolRates = new Map<string, Map<number, NonNullable<ReturnType<typeof measuredToolRate>>>>()
let lastRunningSessions = new Set<string>()

function rememberLiveRates(next: MonitorSnapshot) {
  const live = next.live
  const running = (next.rateSessions ?? next.activeSessions ?? []).filter(session => ['active', 'running'].includes(session.status))
  lastRunningSessions = new Set(running.map(session => session.key))
  const runningTools = new Set(running.map(session => session.tool))
  for (const [id, counts] of Object.entries(next.toolStatusCounts ?? {})) {
    if (counts.running) runningTools.add(id)
    else runningTools.delete(id)
  }
  for (const key of lastLiveWindows.keys()) if (key && !lastRunningSessions.has(key)) lastLiveWindows.delete(key)
  for (const id of lastToolRates.keys()) if (!runningTools.has(id)) lastToolRates.delete(id)
  if (!live || !next.collectedAtMs) return
  const sampledAtMs = live.sampledAtMs
  function remember(key: string, windows?: LiveWindow[]) {
    if (!windows?.length) return
    const saved = lastLiveWindows.get(key) ?? new Map<number, LastLiveWindow>()
    for (const window of windows) {
      if ((displayLiveRate(window).value ?? 0) > 0) saved.set(window.seconds, { window, sampledAtMs })
    }
    if (saved.size) lastLiveWindows.set(key, saved)
  }
  remember('', tool.value ? live.byTool.find(row => row.tool === tool.value)?.windows : live.windows)
  for (const row of live.bySession) if (row.sessionKey && lastRunningSessions.has(row.sessionKey)) remember(row.sessionKey, row.windows)
  for (const id of runningTools) {
    const saved = lastToolRates.get(id) ?? new Map()
    for (const seconds of [60, 300] as const) {
      const reading = measuredToolRate(live, id, seconds)
      if (reading) saved.set(seconds, reading)
    }
    if (saved.size) lastToolRates.set(id, saved)
  }
}
function toolRate(id: string) {
  const live = snapshot.value?.live
  if (!snapshot.value?.collectedAtMs) return null
  const fresh = live && !error.value && !snapshot.value.error ? measuredToolRate(live, id, liveRateSeconds.value) : null
  const reading = fresh ?? lastToolRates.get(id)?.get(liveRateSeconds.value)
  if (!reading) return null
  const basis = t(reading.basis)
  return {
    text: t('usageMonitor.text.tokensS', { value0: reading.value }),
    label: fresh ? basis : lastRateLabel(reading.sampledAtMs),
    detail: [!fresh ? basis : '', reading.partial ? t('usageMonitor.text.partialSampling2') : ''].filter(Boolean).join(' · ') || undefined,
  }
}
function toolTotals(id: string) { return (analysis.value?.toolOverview ?? analysis.value?.byTool)?.find(row => row.tool === id)?.totals }
function conciseCost(totals?: MonitorTotals): string {
  if (!totals) return t('usageMonitor.text.loading')
  if (!totals.requestCount) return t('usageMonitor.text.noRequestsYet')
  const summary = monitorAutomaticPriceSummary(totals)
  const rows = summary.currencies.filter(row => row.identifiedSubtotal != null)
  return rows.length ? rows.map(row => summaryMoney(row.identifiedSubtotal, row.currency)).join(' / ') : summary.unknownRequests === totals.requestCount ? t('usageMonitor.text.modeNotYetIdentified2') : t('usageMonitor.text.matchingUnitPriceUnavailable')
}
function costBasis(totals?: MonitorTotals): string {
  if (!totals) return t('usageMonitor.text.waitingForUsageRecords')
  if (!totals.requestCount) return t('usageMonitor.text.noRequestsInThisPeriod')
  const result = monitorAutomaticPriceSummary(totals)
  return t('usageMonitor.text.serviceResponseClientRecords', { value0: result.responseModeRequests, value1: result.requestedModeRequests }) + (result.unknownRequests ? t('usageMonitor.text.unidentifiedModesReferenceShownSeparately', { value0: result.unknownRequests }) : '') + (result.identifiedUnquotedRequests ? t('usageMonitor.text.missingUnitPrices', { value0: result.identifiedUnquotedRequests }) : '')
}
function modeCount(mode: string): string | number { return periodTotals.value?.automaticPriceSummary ? monitorAutomaticPriceSummary(periodTotals.value).modes.find(row => row.mode === mode)?.requestCount ?? 0 : t('usageMonitor.text.unknown') }
function platform(id: string): 'openai' | 'anthropic' | 'antigravity' | 'deepseek' | undefined { return id==='api'?undefined:id === 'codex' ? 'openai' : id === 'claude' ? 'anthropic' : id === 'deepseek-harness' ? 'deepseek' : 'antigravity' }
function modeLabel(session: MonitorSession): string {
  const mode = session.recentRequest ? monitorAutomaticMode(session.recentRequest) : null
  return mode?.mode ? `${monitorMode(mode.mode)} · ${mode.basis === 'response_reported' ? t('usageMonitor.text.serviceResponse') : mode.basis === 'runtime_mode' ? t('usageMonitor.text.runtimeLogs') : t('usageMonitor.text.clientSettings')}` : t('usageMonitor.text.unidentifiedMode')
}
function duration(value: number | null | undefined): string { return value == null || value < 0 ? t('usageMonitor.text.notReported') : value < 60_000 ? t('usageMonitor.text.s2', { value0: (value / 1000).toFixed(2) }) : t('usageMonitor.text.mS', { value0: Math.floor(value / 60_000), value1: Math.floor(value / 1000) % 60 }) }
function turnElapsed(session: MonitorSession): string { const value = session.turnTiming; return value?.startedAtMs && !value.completedAtMs && ['active', 'running'].includes(session.status) ? duration((snapshot.value?.live?.sampledAtMs ?? Date.now()) - value.startedAtMs) : '—' }
function requestAverage(session: MonitorSession): string { const value = session.requestSpeed?.latest?.outputTokensPerSecond; return value == null ? t('usageMonitor.text.perRequestDurationNotRecordedInLogs') : t('usageMonitor.text.tokensS', { value0: value.toFixed(1) }) }
function requestWeighted(session: MonitorSession): string { const value = session.requestSpeed?.last10?.outputTokensPerSecond; return value == null ? t('usageMonitor.text.perRequestDurationNotRecordedInLogs') : t('usageMonitor.text.tokensS', { value0: value.toFixed(1) }) }
function completedTurnRate(session: MonitorSession): string { const value = session.latestCompletedTurn?.outputTokensPerSecond; return value == null ? t('usageMonitor.text.noCompleteTurnSample') : t('usageMonitor.text.tokensS', { value0: value.toFixed(1) }) }
function openLiveSession(key: string, event: MouseEvent) { tab.value = 'overview'; selectSession(key, event) }
function openLiveModel(id: string | null, value: string | null) { if (id) tool.value = id; model.value = value; tab.value = 'analysis' }
const turns = computed(() => detail.value?.turns ?? [])
const turn = computed(() => turns.value.find(item => item.id === selectedTurn.value))
const completedTurn = computed(() => selectedTurn.value ? detail.value?.selectedCompletedTurn?.timing.turnId === selectedTurn.value ? detail.value.selectedCompletedTurn : null : detail.value?.session.latestCompletedTurn)
const displayedTurnTiming = computed(() => completedTurn.value?.timing ?? (selectedTurn.value ? turn.value?.timing : null))
const displayedTurnRate = computed(() => {
  return completedTurn.value?.outputTokensPerSecond ?? null
})
const firstOutputShare = computed(() => {
  const timing = displayedTurnTiming.value
  return timing?.durationMs && timing.ttftMs != null ? Math.min(100, timing.ttftMs / timing.durationMs * 100) : null
})
const pageRequests = computed(() => detailPageReady.value ? detail.value?.requests ?? [] : [])
const request = computed(() => pageRequests.value.find(item => item.id === selectedRequest.value))
const automaticRequest = computed(() => request.value ? monitorRequestAutomaticPrice(request.value) : null)
const periodTotals = computed(() => analysis.value?.totals)
const weeklyUnlocated = computed(() => tool.value ? weekly.value?.byTool.find(row => row.tool === tool.value)?.unlocatedTotals ?? weekly.value?.unlocatedByTool?.[tool.value] : weekly.value?.unlocatedTotals)
const detailTotals = computed(() => detail.value?.filteredTotals ?? detail.value?.session.totals)
const detailMembers = computed(() => detail.value?.members ?? (detail.value ? [detail.value.session] : []))
const childMembers = computed(() => detailMembers.value.filter(member => member.key !== detail.value?.session.key))
const memberById = computed(() => new Map(detailMembers.value.map(member => [member.id, member])))
const familyDetail = computed(() => detail.value?.includeDescendants === true)
function requestRecordedTime(item: MonitorRequest): string {
  return item.unknownFields.includes('timestamp') ? t('usageMonitor.text.requestTimeUnknown') : monitorIsUnitemizedRecord(item) ? t('usageMonitor.text.cumulativeIntervalUnknown') : time(item.timestampMs)
}
function requestSource(item: MonitorRequest): string {
  return item.sessionId === detail.value?.session.id ? t('usageMonitor.text.thisSession') : t('usageMonitor.text.subagent', { value0: item.sessionId.slice(0, 8) })
}
function requestSourceTitle(item: MonitorRequest): string {
  const member = memberById.value.get(item.sessionId)
  return member ? `${sessionName(member)} · ${item.sessionId}` : item.sessionId
}
const weeklyTotals = computed(() => tool.value ? weekly.value?.byTool.find(row => row.tool === tool.value)?.totals : weekly.value?.totals)
const weeklyQuotes = computed(() => monitorSingleQuotes(weeklyTotals.value))
const weeklyScope = computed(() => tool.value ? weekly.value?.byTool.find(row => row.tool === tool.value) : weekly.value)
const weeklyReference = computed(() => weeklyScope.value?.reference ?? [])
const weeklyForecast = computed(() => exhaustedQuotas.value.length || restrictedMainQuotas.value.length ? [] : weeklyScope.value?.forecast ?? [])
const visibleQuotas = computed(() => (quotas.value?.quotas ?? [])
  .filter(item => matchesAccountTool(item))
  .sort((a, b) => Number(a.stale || a.expired) - Number(b.stale || b.expired)
    || ['codex', 'claude', 'antigravity', 'deepseek-harness'].indexOf(a.tool) - ['codex', 'claude', 'antigravity', 'deepseek-harness'].indexOf(b.tool)
    || (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0)))
const currentQuotas = computed(() => visibleQuotas.value.filter(item => !quotaIsHistorical(item)))
const accountUsageByKey = computed(() => new Map((accountUsage.value?.accounts ?? [])
  .map(account => [account.accountKey, account])))
function matchesAccountTool(account:{tool:string;accountKey?:string;clientTools?:string[]}):boolean{
  return !tool.value || account.tool===tool.value || (account.clientTools ?? (account.accountKey ? accountUsageByKey.value.get(account.accountKey)?.clientTools : undefined))?.includes(tool.value)===true
}
const currentForecastAccount = computed(() => accountUsage.value?.accounts.find(account =>
  account.accountKey === selectedQuotaAccountKey.value && matchesAccountTool(account)))
function isAccountWeeklyQuota(quota: MonitorQuota): boolean {
  return quota.windowMinutes === 10080 && (quota.windowSeconds == null || quota.windowSeconds === 604800)
    && ((quota.tool === 'codex' && quota.limitId === 'codex')
    || (quota.tool === 'claude' && quota.limitId === 'seven_day'))
}
const forecastQuota = computed(() => {
  const account = currentForecastAccount.value
  const cycle = account?.currentCycle ?? account?.quotaCycles[0]
  return account && cycle ? visibleQuotas.value.find(item => item.accountKey === account.accountKey && item.tool === account.tool && item.attribution === 'account'
    && isAccountWeeklyQuota(item) && item.observedAtMs != null && item.resetsAtMs != null && item.resetsAtMs > item.observedAtMs
    && item.observedAtMs >= cycle.startMs && item.resetsAtMs - 7 * 86400000 <= cycle.quotaObservedAtMs) : undefined
})
const liveAccountQuotaPrediction = computed(() => {
  const account = currentForecastAccount.value
  const cycle = account?.currentCycle ?? account?.quotaCycles[0]
  const finalized = cycle?.usedPercent === 100 && cycle.exhaustedAtMs != null && !cycle.exhaustionUnknown
  const result = {
    label: account ? `${toolName(account.tool)} · ${quotaAccountLabel(account)}` : '',
    cycle,
    context: undefined as { accountLabel: string; usedPercent: number } | undefined,
    quotes: [] as Array<{ currency: string; observedSubtotal: number; additionalSubtotal: number; projectedSubtotal: number }>,
    partial: false,
    coveredRequests: 0,
    requestCount: 0,
    message: '',
    finalized,
  }
  if (accountUsageError.value || quotaError.value) { result.message = t('usageMonitor.text.accountQuotaUpdateFailedWaitingForNewData'); return result }
  if (!account) { result.message = t('usageMonitor.text.currentAccountNotYetConfirmed'); return result }
  if (account.billingAccountVerified === false) { result.message = t('usageMonitor.text.billingAccountUnconfirmed'); return result }
  if (!cycle || (!finalized && (!cycle.current || cycle.resetAtMs <= Math.max(Date.now(), accountUsage.value?.collectedAtMs ?? 0)))) { result.message = t('usageMonitor.text.currentWeeklyQuotaCycleNotYetConfirmed'); return result }
  const quota = forecastQuota.value
  if (quota?.billingAccountVerified === false) { result.message = t('usageMonitor.text.billingAccountUnconfirmed'); return result }
  if (!finalized && (!quota || quotaIsHistorical(quota))) { result.message = t('usageMonitor.text.weeklyQuotaAwaitingUpdate'); return result }
  const used = cycle.usedPercent
  const projected = projectAccountQuotaCycle(cycle, account.tool)
  if (projected.reason) { result.message = t('usageMonitor.text.' + projected.reason); return result }
  if (!finalized && (quota!.observedAtMs !== cycle.quotaObservedAtMs || quota!.usedPercent !== used)) { result.message = t('usageMonitor.text.synchronizingQuotaReadings'); return result }
  result.quotes = projected.quotes
  result.context = { accountLabel: result.label, usedPercent: used! }
  result.partial = projected.partial
  result.coveredRequests = projected.coveredRequests
  result.requestCount = projected.requestCount
  if (cycle.quotaSnapshot?.sourceCoverageIncomplete) result.message = t('usageMonitor.routes.partialUsage')
  else if (finalized) result.message = t('usageMonitor.text.exhaustedQuotaAmountRecorded')
  return result
})
function captureQuotaSnapshot() {
  const live = liveAccountQuotaPrediction.value
  const account = currentForecastAccount.value
  const quota = forecastQuota.value
  if (!live.context || !live.cycle || live.finalized || !account || quota?.observedAtMs == null) return
  const previous = quotaSnapshots.value.find(saved => saved.accountKey === account.accountKey)
  if (previous && quota.observedAtMs < previous.quotaObservedAtMs) return
  if (previous && quota.observedAtMs === previous.quotaObservedAtMs
    && (previous.cycleStartMs !== live.cycle.startMs || previous.cycleResetAtMs !== live.cycle.resetAtMs
      || previous.usedPercent !== live.context.usedPercent)) return
  const saved: AccountQuotaSnapshot = {
    accountKey: account.accountKey, tool: account.tool, accountLabel: live.label,
    cycleStartMs: live.cycle.startMs, cycleResetAtMs: live.cycle.resetAtMs,
    quotaObservedAtMs: quota.observedAtMs, updatedAtMs: Date.now(), usedPercent: live.context.usedPercent,
    quotes: live.quotes.map(quote => ({ ...quote })), partial: live.partial,
    coveredRequests: live.coveredRequests, requestCount: live.requestCount,
  }
  if (!validAccountQuotaSnapshot(saved)) return
  const unchanged = previous && previous.quotaObservedAtMs === saved.quotaObservedAtMs
    && previous.cycleStartMs === saved.cycleStartMs && previous.cycleResetAtMs === saved.cycleResetAtMs
    && previous.usedPercent === saved.usedPercent && previous.partial === saved.partial
    && previous.coveredRequests === saved.coveredRequests && previous.requestCount === saved.requestCount
    && previous.quotes.length === saved.quotes.length
    && previous.quotes.every((quote, index) => {
      const next = saved.quotes[index]
      return next?.currency === quote.currency && next.observedSubtotal === quote.observedSubtotal
        && next.additionalSubtotal === quote.additionalSubtotal && next.projectedSubtotal === quote.projectedSubtotal
    })
  if (unchanged) return
  quotaSnapshots.value = [...quotaSnapshots.value.filter(row => row.accountKey !== saved.accountKey), saved].slice(-20)
  saveAccountQuotaSnapshots(quotaSnapshots.value)
}
const accountQuotaPrediction = computed(() => {
  const live = liveAccountQuotaPrediction.value
  const account = currentForecastAccount.value
  const cycle = account?.currentCycle ?? account?.quotaCycles[0]
  if (live.finalized && live.context) return { ...live, updatedAtMs: cycle?.exhaustedAtMs ?? undefined }
  const quota = forecastQuota.value
  let saved = quotaSnapshots.value.find(row => row.accountKey === account?.accountKey && row.tool === account?.tool
    && row.cycleStartMs === cycle?.startMs && row.cycleResetAtMs === cycle?.resetAtMs)
  // The ledger keeps the paired cutoff when browser storage changes during an upgrade.
  if (!saved && account && cycle && (quota?.stale || quota?.sourceError || quotaError.value || accountUsageError.value)) {
    const paired = projectAccountQuotaCycle(cycle, account.tool)
    if (!paired.reason) saved = {
      accountKey: account.accountKey, tool: account.tool, accountLabel: live.label,
      cycleStartMs: cycle.startMs, cycleResetAtMs: cycle.resetAtMs,
      quotaObservedAtMs: cycle.quotaObservedAtMs, updatedAtMs: cycle.quotaObservedAtMs, usedPercent: cycle.usedPercent!,
      quotes: paired.quotes, partial: paired.partial, coveredRequests: paired.coveredRequests, requestCount: paired.requestCount,
    }
  }
  const used = cycle?.usedPercent
  if (!saved || account?.billingAccountVerified === false || quota?.billingAccountVerified === false
    || (account?.tool === 'codex' && cycle?.quotaSnapshot?.billingTotals && !cycle.quotaSnapshot.billingTotals.subscription?.requestCount)
    || !cycle?.current || cycle.resetAtMs <= Math.max(Date.now(), accountUsage.value?.collectedAtMs ?? 0)
    || used == null || !Number.isFinite(used) || used <= 0 || used >= 100 || cycle.exhaustionUnknown || cycle.exhaustedAtMs != null || !quota || quota.expired
    || quota.usedPercent == null || !Number.isFinite(quota.usedPercent) || quota.usedPercent <= 0 || quota.usedPercent >= 100) {
    return { ...live, updatedAtMs: undefined }
  }
  const waiting = !live.context || !live.quotes.length || quota.observedAtMs !== saved.quotaObservedAtMs || used !== saved.usedPercent
    || live.coveredRequests !== saved.coveredRequests || live.requestCount !== saved.requestCount
    || live.partial !== saved.partial || live.quotes.length !== saved.quotes.length
    || live.quotes.some((quote, i) => quote.currency !== saved.quotes[i]?.currency || quote.observedSubtotal !== saved.quotes[i]?.observedSubtotal
      || quote.additionalSubtotal !== saved.quotes[i]?.additionalSubtotal || quote.projectedSubtotal !== saved.quotes[i]?.projectedSubtotal)
  return {
    label: live.label, cycle: { startMs: saved.cycleStartMs, resetAtMs: saved.cycleResetAtMs },
    context: { accountLabel: live.label, usedPercent: saved.usedPercent }, quotes: saved.quotes,
    partial: saved.partial, coveredRequests: saved.coveredRequests, requestCount: saved.requestCount, finalized: false,
    message: waiting ? t('usageMonitor.text.quotaAwaitingUpdateLastValidEstimateShown') : live.message, updatedAtMs: saved.updatedAtMs,
  }
})

const alternateQuotaIds = computed(() => {
  const resetsByWindow = new Map<string, number[]>()
  const alternates = new Set<number>()
  // Readings are already ordered from fresh to stale, newest first within each group.
  for (const item of visibleQuotas.value) {
    const { windowMinutes, windowSeconds, resetsAtMs } = item
    if (item.tool !== 'codex' || item.limitId !== 'codex' || item.modelId != null
      || item.attribution !== 'account' || item.billingAccountVerified !== true
      || item.usedPercent == null || resetsAtMs == null || (windowMinutes !== 300 && windowMinutes !== 10080)
      || (windowSeconds != null && windowSeconds !== windowMinutes * 60)) continue
    const key = `${item.accountKey}:${windowMinutes}`
    const resets = resetsByWindow.get(key) ?? []
    // Different sources can report the same reset a second apart.
    if (resets.some(reset => Math.abs(reset - resetsAtMs) <= 1000)) alternates.add(item.id)
    else {
      resets.push(resetsAtMs)
      resetsByWindow.set(key, resets)
    }
  }
  return alternates
})

const displayQuotas = computed(() => {
  const now = quotas.value?.collectedAtMs ?? Date.now()
  const rows = visibleQuotas.value.filter(item => !alternateQuotaIds.value.has(item.id))
  const latest = new Map<string, MonitorQuota>()
  for (const item of rows) {
    if (item.attribution !== 'account') continue
    const previous = latest.get(item.accountKey)
    if (!previous || (item.observedAtMs ?? 0) > (previous.observedAtMs ?? 0)
      || (item.observedAtMs === previous.observedAtMs && item.windowMinutes === 10080 && previous.windowMinutes !== 10080)) latest.set(item.accountKey, item)
  }
  return rows.filter(item => {
    if (!quotaIsHistorical(item)) return true
    if (item.attribution !== 'account') return false
    if (!item.expired && item.resetsAtMs != null && item.resetsAtMs > now) return true
    return latest.get(item.accountKey)?.id === item.id
  })
})
const displayQuotaIds = computed(() => new Set(displayQuotas.value.map(item => item.id)))
const displayAccountKeys = computed(() => new Set(displayQuotas.value.map(item => item.accountKey)))
const knownQuotaAccounts = computed(() => {
  const latest = new Map<string, MonitorQuota>()
  for (const row of displayQuotas.value) {
    if (row.attribution !== 'account') continue
    const previous = latest.get(row.accountKey)
    if (!previous || (row.observedAtMs ?? 0) > (previous.observedAtMs ?? 0)) latest.set(row.accountKey, row)
  }
  const confirmedWithoutQuota = (accountUsage.value?.accounts ?? []).filter(account =>
    ((account.verifiedWeekRequests ?? 0) > 0 || (account.verifiedHistory?.totals.requestCount ?? 0) > 0)
    && !latest.has(account.accountKey) && matchesAccountTool(account))
  const api = accountUsage.value?.apiUsage || explicitQuotaAccountKey.value === 'api:all' ? [{accountKey:'api:all',accountLabel:'API',tool:'api',source:'api_usage',billingAccountVerified:true}] : []
  return [...latest.values(), ...confirmedWithoutQuota, ...api]
})
const quotaAccountSuffixes = computed(() => accountLabelSuffixes(knownQuotaAccounts.value.map(account => ({
  accountKey: account.accountKey, tool: account.tool, label: quotaAccountBaseLabel(account),
}))))
const quotaAccountChoices = computed(() => knownQuotaAccounts.value.filter(account =>
  account.accountKey === accountUsage.value?.currentAccountKey || !hiddenQuotaAccounts.value.includes(account.accountKey)))
const hiddenKnownQuotaAccounts = computed(() => knownQuotaAccounts.value.filter(account =>
  account.accountKey !== accountUsage.value?.currentAccountKey && hiddenQuotaAccounts.value.includes(account.accountKey)))
const selectedQuotaAccount = computed(() => quotaAccountChoices.value.find(account => account.accountKey === explicitQuotaAccountKey.value)
  ?? quotaAccountChoices.value.find(account => account.accountKey === accountUsage.value?.currentAccountKey)
  ?? quotaAccountChoices.value.find(account => account.accountKey === 'api:all')
  ?? quotaAccountChoices.value[0])
const selectedQuotaAccountKey = computed({
  get: () => selectedQuotaAccount.value?.accountKey ?? '',
  set: (key: string) => { explicitQuotaAccountKey.value = key },
})
const selectedAccountUsage = computed(() => accountUsageByKey.value.get(selectedQuotaAccountKey.value))
const apiAccountSelected = computed(() => selectedQuotaAccountKey.value === 'api:all' || selectedAccountUsage.value?.billingKind === 'api')
const selectedApiUsage = computed(() => selectedQuotaAccountKey.value === 'api:all' ? accountUsage.value?.apiUsage : selectedAccountUsage.value?.billingKind === 'api' ? { week:selectedAccountUsage.value.calendarWeek,month:selectedAccountUsage.value.calendarMonth ?? null } : null)
function hideSelectedQuotaAccount() {
  const selected = selectedQuotaAccount.value
  if (!selected || selected.accountKey === accountUsage.value?.currentAccountKey) return
  saveHiddenQuotaAccounts([...hiddenQuotaAccounts.value, selected.accountKey])
  explicitQuotaAccountKey.value = null
}
function restoreQuotaAccount(key: string) {
  saveHiddenQuotaAccounts(hiddenQuotaAccounts.value.filter(hidden => hidden !== key))
  explicitQuotaAccountKey.value = key
}
const accountUsageQuotaIds = computed(() => {
  const chosen = new Map<string, MonitorQuota>()
  for (const quota of visibleQuotas.value) {
    if (quota.attribution !== 'account' || quota.tool === 'codex' && quota.limitId !== 'codex') continue
    if (displayAccountKeys.value.has(quota.accountKey) && !displayQuotaIds.value.has(quota.id)) continue
    const previous = chosen.get(quota.accountKey)
    if (!previous || (isAccountWeeklyQuota(quota) && !isAccountWeeklyQuota(previous))
      || (!isAccountWeeklyQuota(previous) && quota.windowMinutes === 10080 && previous.windowMinutes !== 10080)) chosen.set(quota.accountKey, quota)
  }
  return new Set([...chosen.values()].map(quota => quota.id))
})
const creditAccounts = computed(() => {
  const latest = new Map<string, MonitorQuota>()
  for (const row of visibleQuotas.value.filter(item => item.tool === 'codex' && item.limitId === 'codex' && item.attribution === 'account')) {
    const previous = latest.get(row.accountKey)
    if (!previous || (row.observedAtMs ?? 0) > (previous.observedAtMs ?? 0) || (row.observedAtMs === previous.observedAtMs && !previous.credits && row.credits)) latest.set(row.accountKey, row)
  }
  return [...latest.values()]
})
function creditState(item: MonitorQuota): string {
  if (creditIsHistorical(item)) return t('usageMonitor.text.statusAwaitingUpdate')
  if (item.credits?.unlimited === true) return t('usageMonitor.text.toolReportsUnlimitedCredits')
  if (item.credits?.hasCredits === true) return t('usageMonitor.text.creditsAvailable')
  return item.credits?.hasCredits === false ? t('usageMonitor.text.noAvailableCredits') : t('usageMonitor.text.creditStatusNotReported')
}
function creditBalance(item: MonitorQuota): string {
  const value = item.credits?.balance
  if (value == null) return t('usageMonitor.text.balanceNotReported')
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toLocaleString(usageLocale(), Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 2 }) : value
}
function hasReportedCredits(item: MonitorQuota): boolean {
  const credits = item.credits
  if (!credits) return false
  if (credits.unlimited === true) return true
  if (credits.hasCredits === false) return false
  if (credits.balance == null) return credits.hasCredits === true
  return credits.balance.trim() !== '' && Number.isFinite(Number(credits.balance)) && Number(credits.balance) > 0
}
function hasCreditObservation(item: MonitorQuota): boolean {
  return !!item.credits && (item.credits.hasCredits != null || item.credits.unlimited != null || item.credits.balance != null)
}
function creditIsHistorical(item: MonitorQuota): boolean {
  // Credits are an account observation, independent from a quota window's reset.
  return !!quotaError.value || item.attribution !== 'account' || !!item.sourceError || item.observedAtMs == null
    || (quotas.value?.collectedAtMs ?? Date.now()) - item.observedAtMs > 300000 || item.stale && !item.expired
}
function quotaProviderBlocked(item: MonitorQuota): boolean {
  const status = item.providerStatus
  return status?.allowed === false || status?.limitReached === true || status?.spendControl?.reached === true
    || !!status?.rateLimitReachedType && status.rateLimitReachedType !== 'unknown'
}
function quotaProviderStatus(item: MonitorQuota): string {
  if (quotaProviderBlocked(item)) return t('usageMonitor.text.officialQuotaRestricted')
  if (item.providerStatus?.rateLimitReachedType === 'unknown') return t('usageMonitor.text.officialQuotaUnknownRestriction')
  if (item.providerStatus?.allowed === true) return t('usageMonitor.text.officialQuotaAllowed')
  return item.providerStatus?.limitReached === false ? t('usageMonitor.text.officialQuotaNotReached') : t('usageMonitor.text.officialQuotaAccessUnknown')
}
function quotaProviderReason(item: MonitorQuota): string {
  const names: Record<string, string> = {
    rate_limit_reached: 'officialQuotaReasonWindow', workspace_owner_credits_depleted: 'officialQuotaReasonOwnerCredits',
    workspace_member_credits_depleted: 'officialQuotaReasonMemberCredits', workspace_owner_usage_limit_reached: 'officialQuotaReasonOwnerLimit',
    workspace_member_usage_limit_reached: 'officialQuotaReasonMemberLimit',
  }
  const kind = item.providerStatus?.rateLimitReachedType
  return kind && names[kind] ? t(`usageMonitor.text.${names[kind]}`) : ''
}
function spendControlState(reached: boolean | null): string {
  return reached === true ? t('usageMonitor.text.officialSpendReached') : reached === false ? t('usageMonitor.text.officialSpendNotReached') : t('usageMonitor.text.unknown')
}
// Account status has its own observation age, even when a numeric window expired.
// Additional pools cannot suspend the main account's continued-usage forecasts.
const restrictedMainQuotas = computed(() => visibleQuotas.value.filter(item => item.tool === 'codex' && item.limitId === 'codex'
  && !creditIsHistorical(item) && quotaProviderBlocked(item)))
const hasExtraCredits = computed(() => exhaustedQuotas.value.some(item => creditAccounts.value.some(account => account.accountKey === item.accountKey
  && !creditIsHistorical(account) && !quotaProviderBlocked(account) && hasReportedCredits(account))))
const creditGroups = computed(() => [
  { id: 'current', label: t('usageMonitor.text.accountCredits'), items: creditAccounts.value.filter(account => hasCreditObservation(account) && account.accountKey === selectedQuotaAccountKey.value && (!creditIsHistorical(account) || displayAccountKeys.value.has(account.accountKey))) },
  { id: 'history', label: t('usageMonitor.text.historicalCreditsNotTheCurrentAvailableBalance'), items: creditAccounts.value.filter(account => hasCreditObservation(account) && account.accountKey === selectedQuotaAccountKey.value && creditIsHistorical(account) && !displayAccountKeys.value.has(account.accountKey)) },
].filter(group => group.items.length))
const quotaSources = computed(() => (quotas.value?.sources ?? []).filter(item => !tool.value || item.tool === tool.value || visibleQuotas.value.some(quota=>quota.tool===item.tool)))
const quotaSourceWarnings = computed(() => quotaSources.value.filter(source => source.error || source.status !== 'available' || source.coverage?.scopesUnreported).length)
const alternateQuotaReadings = computed(() => visibleQuotas.value.filter(item =>
  item.accountKey === selectedQuotaAccountKey.value && alternateQuotaIds.value.has(item.id)))
const exhaustedQuotas = computed(() => {
  const blockers: MonitorQuota[] = []
  for (const source of tools.value.filter(item => item.id && (!tool.value || item.id === tool.value || visibleQuotas.value.some(quota=>quota.tool===item.id)))) {
    const rows = visibleQuotas.value.filter(item => item.tool === source.id && item.attribution === 'account')
      .slice().sort((a, b) => (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0))
    const accounts = new Set(currentQuotas.value.filter(item => item.tool === source.id).map(item => item.accountKey))
    if (!accounts.size && rows[0]) accounts.add(rows[0].accountKey)
    // An expired snapshot is not evidence that an exhausted allowance was replenished.
    blockers.push(...rows.filter(item => (item.tool !== 'codex' || item.limitId === 'codex') && accounts.has(item.accountKey) && item.remainingPercent === 0
      && !rows.some(next => next.accountKey === item.accountKey && next.limitId === item.limitId
        && next.windowMinutes === item.windowMinutes && next.windowSeconds === item.windowSeconds && !quotaIsHistorical(next)
        && (next.observedAtMs ?? 0) > (item.observedAtMs ?? 0)
        && next.resetsAtMs != null && item.resetsAtMs != null && next.resetsAtMs > item.resetsAtMs
        && next.observedAtMs! >= item.resetsAtMs)))
  }
  return blockers
})
const quotaGroups = computed(() => [
  { id: 'current', label: t('usageMonitor.text.accountQuota'), items: displayQuotas.value.filter(item => item.accountKey === selectedQuotaAccountKey.value) },
  { id: 'history', label: t('usageMonitor.text.historyUnidentifiedAccounts'), items: visibleQuotas.value.filter(item => !displayQuotaIds.value.has(item.id)
    && !alternateQuotaIds.value.has(item.id)
    && (item.attribution !== 'account' || item.accountKey === selectedQuotaAccountKey.value)) },
].filter(group => group.items.length))
function quotaIsHistorical(item: MonitorQuota): boolean { return !!quotaError.value || item.stale || item.expired || !!item.sourceError || item.attribution !== 'account' }
function sessionName(session: { project: string | null; id: string }): string { return session.project?.split(/[\\/]/).filter(Boolean).at(-1) || session.id.slice(0, 12) }
function summaryMoney(amount: number | null, currency: string, forecast = false): string {
  if (currency === 'UNKNOWN') return t('usageMonitor.text.insufficientPricingEvidence')
  return amount == null ? t('usageMonitor.text.estimateUnavailable') : new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...(amount !== 0 && Math.abs(amount) < (forecast ? 1 : 0.01) ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: forecast ? 0 : 2 }) }).format(amount)
}
function currencyName(currency: string): string { return ({ USD: t('usageMonitor.text.usd'), CNY: t('usageMonitor.text.cny'), UNKNOWN: t('usageMonitor.text.currencyNotConfirmed') } as Record<string, string>)[currency] || currency }
function forecastMethod(method: string): string { return ({ week_average: t('usageMonitor.text.basedOnThisWeekSUsagePace'), trailing_7d: t('usageMonitor.text.basedOnTheLast7Days'), weekday_hour: t('usageMonitor.text.basedOnHistoricalWeekdayTimeSlots') } as Record<string, string>)[method] || method }
const tools = computed(() => [{ id: null, label: t('usageMonitor.text.allTools') }, { id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude Code' }, { id: 'antigravity', label: 'Antigravity' }, { id: 'deepseek-harness', label: 'DeepSeek Harness' },...(analysis.value?.byTool.some(row=>row.tool==='api')||snapshot.value?.toolStatusCounts?.api?[{id:'api',label:'API'}]:[])])
const toolOverviewRows = computed(() => tools.value.filter(source => source.id !== null).map(source => ({ ...source, rate: toolRate(source.id!) })))
const priceModel = ref('')
const priceMode = ref('standard')
const priceContext = ref(0)
const pricePreview = ref<MonitorCostEstimate | null>(null)
const priceBusy = ref(false)
const priceError = ref('')
async function previewPrice() {
  if (!priceModel.value.trim() || priceBusy.value) return
  priceBusy.value = true; priceError.value = ''; pricePreview.value = null
  try { pricePreview.value = (await quoteModelCatalogBatch([{ id: 'reference-price-preview', model: priceModel.value.trim(), actualMode: priceMode.value, inputTokens: priceContext.value, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: priceContext.value, timestampMs: Date.now() }]))[0]?.cost ?? null }
  catch (e) { priceError.value = errorMessage(e) }
  finally { priceBusy.value = false }
}
function quotaForecast(item: MonitorQuota): string {
  if (item.billingAccountVerified === false) return t('usageMonitor.text.quotaAccountUnconfirmed')
  if (quotaIsHistorical(item)) return item.expired || item.resetsAtMs != null && item.resetsAtMs <= (quotas.value?.collectedAtMs ?? Date.now()) ? t('usageMonitor.text.resetTimeReachedWaitingForNewRecords') : t('usageMonitor.text.quotaAwaitingUpdate')
  if (quotaProviderBlocked(item)) return t('usageMonitor.text.officialQuotaRestricted')
  if (item.remainingPercent === 0 && !quotaIsHistorical(item)) {
    if (item.tool === 'codex' && item.limitId !== 'codex') return t('usageMonitor.text.officialExtraPoolExhausted')
    const account = creditAccounts.value.find(row => row.accountKey === item.accountKey)
    return account ? t('usageMonitor.text.planQuotaExhausted', { value0: creditState(account) }) : t('usageMonitor.text.planQuotaExhaustedExtraUsageStatusNotReported')
  }
  const trend = item.depletion
  if (!trend || trend.status === 'insufficient_samples') return t('usageMonitor.text.notEnoughRecordsToEstimateExhaustionTime')
  if (trend.status !== 'estimated') return t('usageMonitor.text.thisSnapshotIsNotUsedToPredictExhaustion')
  return trend.survivesUntilReset ? t('usageMonitor.text.recentPaceSuggestsQuotaWillLastUntilReset') : trend.remainingHours == null ? t('usageMonitor.text.noPredictionAvailable') : trend.remainingHours < 1 ? t('usageMonitor.text.atRecentPaceExhaustedInAboutMinutes', { value0: Math.max(1, Math.round(trend.remainingHours * 60)) }) : t('usageMonitor.text.atRecentPaceExhaustedInAboutHours', { value0: trend.remainingHours.toFixed(1) })
}
let liveTimer: ReturnType<typeof setTimeout> | undefined
let analysisTimer: ReturnType<typeof setTimeout> | undefined
let summaryTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let liveQueued = false
let analysisQueued = false
let detailQueued = false

function errorMessage(e: unknown): string {
  const message=e instanceof Error ? e.message : String(e)
  return ['database is locked','database table is locked'].includes(message)?t('usageMonitor.text.syncBusy'):message
}
function number(value: number | null | undefined): string { return value == null ? t('usageMonitor.text.unknown') : value.toLocaleString(usageLocale()) }
function compactNumber(value: number | null | undefined): string { return value == null ? t('usageMonitor.text.unknown') : new Intl.NumberFormat(usageLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(value) }
function time(value: number | null | undefined): string { return value != null && value > 0 ? new Date(value).toLocaleString(usageLocale(), { hour12: false }) : t('usageMonitor.text.unknown') }
function toolName(value: string): string { return tools.value.find((item) => item.id === value)?.label ?? value }
function status(value: string): string { return ({ active: t('usageMonitor.text.active'), running: t('usageMonitor.text.running'), recent: t('usageMonitor.text.recentOutputRuntimeStatusUnconfirmed'), stale: t('usageMonitor.text.waitingForRecordsRuntimeStatusUnconfirmed'), idle: t('usageMonitor.text.idle'), completed: t('usageMonitor.text.completed'), historical: t('usageMonitor.text.historical'), unknown: t('usageMonitor.text.unknown') } as Record<string, string>)[value] ?? value }
function priceLink(value: string): string | undefined { return /^https?:\/\//i.test(value) ? value : undefined }
function pricingReason(value: string, model?: string | null): string {
  const reason = value.split(';', 1)[0].trim()
  const reasons: Record<string, string> = { actual_mode_unknown: t('usageMonitor.text.actualBillingModeNotReported'), time_band_unknown: t('usageMonitor.text.pricingTimeBandUnconfirmed'), multiple_price_scenarios: t('usageMonitor.text.multiplePossiblePrices'), unspecified_pricing_gap: t('usageMonitor.text.pricingEvidenceIncomplete') }
  if (reasons[reason]) return reasons[reason]
  if (reason === 'subscription_routing_alias_needs_model' || /qianfan|千帆/i.test(model ?? '')) return t('usageMonitor.text.planRoutingAliasUnderlyingModelOrProcurementProfileRequired')
  if (value.startsWith('current_sub2api_reference_price')) return t('usageMonitor.text.currentReferencePriceNotHistoricalBill') + (value.includes('requested_model_not_response_confirmed') ? ' ' + t('usageMonitor.text.requestedModelNotResponseConfirmed') : '')
  if (value.startsWith('current_official_price_equivalent')) return value.includes('requested_model_not_response_confirmed') ? t('usageMonitor.text.estimatedFromAnOfficialPriceSnapshotModelIsRequest') : t('usageMonitor.text.estimatedFromASavedOfficialPriceSnapshotNotHistorical')
  if (value.startsWith('current_catalog_price_equivalent')) return t('usageMonitor.text.estimatedFromTheSavedCatalogAndOfficialSupplementaryRules', { value0: value.includes('actual_provider_unknown') ? t('usageMonitor.text.actualProviderUnconfirmedNamedVendorSReferencePriceUsed') : '', value1: value.includes('official_public_preview') ? t('usageMonitor.text.officialBetaPricingDoesNotImplyThirdPartyUsage') : '' })
  const catalogReason: Record<string, string> = { unknown_catalog_model: t('usageMonitor.text.modelNotFoundInThePriceCatalog'), ambiguous_model_provider: t('usageMonitor.text.multipleProviderPricesExistTheActualProviderIsUnconfirmed'), missing_catalog_token_prices: t('usageMonitor.text.tokenUnitPriceNotYetInTheCatalog'), missing_input_or_output_price: t('usageMonitor.text.aRequiredInputOrOutputUnitPriceIsMissing'), missing_cache_read_price: t('usageMonitor.text.cacheReadsOccurredButTheMatchingUnitPriceIs'), missing_cache_write_price: t('usageMonitor.text.cacheWritesOccurredButTheMatchingUnitPriceIs'), unverified_cache_write_price: t('usageMonitor.text.cacheWritesOccurredButTheMatchingUnitPriceIs'), unknown_aggregate_context_range: t('usageMonitor.text.aggregateRecordsLackActualPerRequestContextSize'), unknown_aggregate_time_band: t('usageMonitor.text.aggregateRecordsSpanPeakOffPeakBandsWithoutUsage'), unverified_mode_context_price: t('usageMonitor.text.noVerifiedPriceForThisModeAndContextCombination'), unverified_context_price: t('usageMonitor.text.noVerifiedPriceForThisContextTier') }
  if (catalogReason[reason]) return catalogReason[reason]
  return ({ unknown_model: t('usageMonitor.text.modelNotRecorded'), unknown_actual_mode: t('usageMonitor.text.actualFastOrStandardModeNotRecorded'), actual_mode_not_reported: t('usageMonitor.text.onlyRequestedModeAvailableExecutionModeUnconfirmed'), unverified_model_or_mode_price: t('usageMonitor.text.noVerifiedOfficialPriceForThisModelOrMode'), incomplete_token_breakdown: t('usageMonitor.text.tokenDetailsRequiredForPricingAreIncomplete'), unknown_per_request_context: t('usageMonitor.text.requestContextUsageMissing'), unknown_cache_write_ttl: t('usageMonitor.text.cacheWriteLifetimeNotRecorded'), unsupported_pricing_modifier: t('usageMonitor.text.includesUnsupportedPricingConditions') } as Record<string, string>)[reason] ?? value
}
function pricingOptions(cost: MonitorCostEstimate) {
  const options: Array<{ label: string; amount: number | null; evidence: PriceEvidence }> = cost.scenarios?.map(scenario => ({ label: t('usageMonitor.text.estimateNotAPaidBill', { value0: monitorScenarioLabel(scenario) }), amount: scenario.amount, evidence: scenario.evidence })) ?? []
  if (cost.evidence) options.unshift({ label: t('usageMonitor.text.estimatedUsingRecordedConditions'), amount: cost.usd ?? cost.cny ?? null, evidence: cost.evidence })
  return options
}
function pricingProvider(evidence: PriceEvidence): string {
  if (evidence.pricingBasis === 'codex_subscription_reference') return t('usageMonitor.text.subscriptionEstimate')
  if (evidence.pricingBasis === 'sub2api_reference') return t('usageMonitor.text.sub2apiReferencePrice')
  if (evidence.catalogRevision) return t('usageMonitor.text.modelsDevReferencePriceNotAPaidBill', { value0: evidence.pricingProvider || t('usageMonitor.text.modelVendor') })
  if (/glm|z\.?ai/i.test(`${evidence.model} ${evidence.pricingProvider ?? ''}`)) return t('usageMonitor.text.zAiOfficialEquivalentPriceActualProviderUnconfirmed')
  return evidence.pricingProvider || t('usageMonitor.text.officialPriceSnapshotActualProviderUnconfirmed')
}
function displayContext(value: string): string {
  return value === 'no published long-context surcharge' ? t('usageMonitor.text.noPublishedLongContextSurcharge') : monitorContext(value)
}
function excludedComponent(component: string): string {
  return /storage/i.test(component) ? t('usageMonitor.text.cacheStorageFee', { value0: component }) : component
}

function quotaWindow(item: MonitorQuota): string {
  const label = item.poolLabel && !['Five Hour Limit', 'Weekly Limit'].includes(item.poolLabel)
    ? /^chat_\d+$/.test(item.poolLabel) ? t('usageMonitor.text.modelQuota', { value0: item.poolLabel }) : item.poolLabel : null
  const minutes = item.windowMinutes
  const seconds = item.windowSeconds
  const period = seconds != null && seconds > 0 && seconds % 60 !== 0 ? t('usageMonitor.text.officialQuotaExactSeconds', { value: seconds })
    : minutes == null ? null : minutes % 1440 === 0 ? t('usageMonitor.text.dayQuota', { value0: minutes / 1440 })
      : minutes % 60 === 0 ? t('usageMonitor.text.hourQuota', { value0: minutes / 60 }) : t('usageMonitor.text.minuteQuota', { value0: minutes })
  return label && period ? `${label} · ${period}` : label || period || (item.slot === 'summary' && item.limitId === 'codex' ? t('usageMonitor.text.officialQuotaSummary') : item.limitId || t('usageMonitor.text.periodNotReported'))
}
function quotaValue(item: MonitorQuota): string {
  return item.remainingPercent == null ? t('usageMonitor.text.notReported') : usagePercentLabel(item.remainingPercent)
}
function quotaSourceName(source: string): string {
  switch (source) {
    case 'codex_local_log': return t('usageMonitor.text.codexLocalLogs')
    case 'codex_official_usage': return t('usageMonitor.text.codexOfficialQuota')
    case 'cockpit_snapshot': return t('usageMonitor.text.cockpitAccountSnapshot')
    case 'sub2api': return 'Sub2API'
    case 'cliproxy': return 'CLIProxyAPI'
    default: return source
  }
}
function hasUnconfirmedHistoricalPlan(item: { accountKey?: string; source?: string; billingAccountVerified?: boolean }): boolean {
  return item.source === 'codex_local_log' && item.billingAccountVerified === false
    && !!accountUsage.value?.currentAccountKey && item.accountKey !== accountUsage.value.currentAccountKey
}
type QuotaAccountLabel = { accountLabel: string; plan?: string | null; accountKey?: string; source?: string; billingAccountVerified?: boolean }
function quotaAccountBaseLabel(item: QuotaAccountLabel): string {
  const name=item.accountKey?costData.value?.report.accountNames?.[item.accountKey]??item.accountLabel:item.accountLabel
  const label = name.replace(/^Account /, t('usageMonitor.text.account')).replace(/^Unattributed session /, t('usageMonitor.text.sessionWithUnidentifiedAccount'))
  if (hasUnconfirmedHistoricalPlan(item)) return label
  return item.plan ? `${label} · ${item.plan}` : label
}
function quotaAccountLabel(item: QuotaAccountLabel): string {
  const label = quotaAccountBaseLabel(item)
  const suffix = item.accountKey ? quotaAccountSuffixes.value.get(item.accountKey) : undefined
  return suffix ? `${label} · #${suffix}` : label
}
function sourceTone(value: string, error: string | null): string {
  if (value === 'error') return 'error'
  if (error || value === 'partial') return 'warning'
  return ['watching', 'metadata'].includes(value) ? 'healthy' : 'unknown'
}
function collectionStatus(value: string): string {
  return ({ watching: t('usageMonitor.text.collecting'), metadata: t('usageMonitor.text.modeRecords'), partial: t('usageMonitor.text.partialDataCollected'), unavailable: t('usageMonitor.text.temporarilyUnavailable'), error: t('usageMonitor.text.readFailed'), idle: t('usageMonitor.text.waitingForNewRecords'), missing: t('usageMonitor.text.sourceDirectoryNotFound'), not_found: t('usageMonitor.text.noRecordsFound') } as Record<string, string>)[value] ?? value
}
function basisLabel(value: string): string {
  if (value === 'unknown' || value.startsWith('unknown:')) return t('usageMonitor.text.noRecords')
  if (value.includes('requested') || value === 'turn_context') return t('usageMonitor.text.requestedSettingNotConfirmedByTheServiceResponse')
  if (value.includes('response') || value.includes('responseModel')) return t('usageMonitor.text.serviceResponseRecord')
  if (value.includes('usage') || value.includes('generator')) return t('usageMonitor.text.usageRecordSavedByTheTool')
  return t('usageMonitor.text.toolLogRecord')
}
function missingFieldLabel(value: string): string {
  return ({ input_tokens: t('usageMonitor.text.inputTokens'), output_tokens: t('usageMonitor.text.outputTokens'), cache_read_tokens: t('usageMonitor.text.cacheReadTokens'), cache_write_tokens: t('usageMonitor.text.cacheWriteTokens'), timestamp: t('usageMonitor.text.requestTime'), requested_mode_ambiguous: t('usageMonitor.text.determinablePerRequestMode') } as Record<string, string>)[value] ?? value
}
function quotaSourceStatus(value: string): string {
  return ({ available: t('usageMonitor.text.quotaSnapshotAvailable'), partial: t('usageMonitor.text.quotaAvailableForSomeSources'), not_reported: t('usageMonitor.text.quotaNotYetReported'), error: t('usageMonitor.text.readFailed') } as Record<string, string>)[value] ?? value
}
function quotaScopeNote(value: string): string {
  if (value.startsWith('Claude Code is configured for a proxy')) return t('usageMonitor.text.currentlyUsingAProxyStandaloneOauthAccountQuotaIs')
  if (value.startsWith('Cockpit snapshots describe')) return t('usageMonitor.text.snapshotBelongsToAStandaloneAccountMatchToCurrent')
  if (value.startsWith('One-time bounded tails')) return t('usageMonitor.text.sourcesWithoutSnapshotsAreNotTreatedAsUnlimited')
  return value
}
async function refreshSummary() {
  clearTimeout(summaryTimer)
  if (!desktop || disposed || summaryBusy.value) return
  summaryBusy.value = true
  const now = Date.now()
  const week = monitorWeekBounds(now)
  const scope=billingScope.value
  const [usage, allowance, accounts] = await Promise.allSettled([scope ? getUsageMonitorWeekly(week.startMs, now, week.endMs,scope) : getUsageMonitorWeekly(week.startMs, now, week.endMs), getUsageMonitorQuotas(), getUsageMonitorAccounts(week.startMs, now)])
  if (!disposed) {
    if(scope===billingScope.value){
      if (usage.status === 'fulfilled') { weekly.value = usage.value; weeklyError.value = '' }
      else { weeklyError.value = errorMessage(usage.reason); if (weekly.value?.startMs !== week.startMs) weekly.value = null }
    }
    if (allowance.status === 'fulfilled') { quotas.value = allowance.value; quotaError.value = '' }
    else quotaError.value = errorMessage(allowance.reason)
    if (accounts.status === 'fulfilled') { accountUsage.value = accounts.value; accountUsageError.value = '' }
    else {
      accountUsageError.value = errorMessage(accounts.reason)
      if (accountUsage.value?.weekStartMs !== week.startMs) {
        if (apiAccountSelected.value) explicitQuotaAccountKey.value = 'api:all'
        accountUsage.value = null
      }
    }
    captureQuotaSnapshot()
  }
  summaryBusy.value = false
  if (!disposed) summaryTimer = setTimeout(refreshSummary, scope===billingScope.value ? 60_000 : 0)
}


function quoteState(item: MonitorRequest): string {
  const price = monitorRequestAutomaticPrice(item)
  return price.quotes.length ? price.quotes.map(row => monitorAmount(row.amount, row.currency)).join(' / ') : price.mode ? t('usageMonitor.text.modeIdentifiedMatchingUnitPriceMissing') : t('usageMonitor.text.modeNotRecordedExcludedFromIdentifiedAmount')
}
function requestModeLabel(item: MonitorRequest): string {
  const price = monitorRequestAutomaticPrice(item)
  return price.mode ? `${monitorMode(price.mode)} · ${price.basis === 'response_reported' ? t('usageMonitor.text.serviceResponse') : t('usageMonitor.text.clientRecords')}` : t('usageMonitor.text.modeNotRecorded')
}
async function loadCatalog(sync = false) {
  if (!desktop || catalogBusy.value) return
  catalogBusy.value = true
  try {
    catalog.value = await (sync ? refreshModelCatalog() : getModelCatalogStatus())
    catalogError.value = catalog.value.error ?? ''
  } catch (e) { catalogError.value = errorMessage(e) }
  finally { catalogBusy.value = false }
}
async function refreshLive() {
  clearTimeout(liveTimer)
  if (!desktop || disposed) return
  if (liveBusy.value) { liveQueued = true; return }
  liveBusy.value = true
  const source = tool.value
  const scope=billingScope.value
  const startedAt = performance.now()
  try {
    const next = scope ? await getUsageMonitorSnapshot(source, 0,{billingScope:scope}) : await getUsageMonitorSnapshot(source, 0)
    if (!disposed && source === tool.value && scope===billingScope.value) { rememberLiveRates(next); snapshot.value = next; error.value = '' }
  } catch (e) {
    if (!disposed && source === tool.value && scope===billingScope.value) error.value = errorMessage(e)
  } finally {
    liveBusy.value = false
    if (!disposed) {
      if (liveQueued) { liveQueued = false; void refreshLive() }
      else liveTimer = setTimeout(refreshLive, Math.max(0, (snapshot.value?.refreshMs || 2000) - (performance.now() - startedAt)))
    }
  }
}
async function refreshAnalysis() {
  clearTimeout(analysisTimer)
  if (!desktop || disposed) return
  if (analysisBusy.value) { analysisQueued = true; return }
  analysisBusy.value = true
  const query = analysisQuery.value
  try {
    const next = await getUsageMonitorAnalysis(query)
    if (!disposed && query === analysisQuery.value) {
      const openFirst = tab.value === 'sessions' && !selected.value && !historyReady.value
      analysis.value = next; loadedAnalysisQuery.value = query; analysisError.value = ''
      if (openFirst && next.sessions.length) selectSession(next.sessions[0].key)
    }
  } catch (e) {
    if (!disposed && query === analysisQuery.value) analysisError.value = errorMessage(e)
  } finally {
    analysisBusy.value = false
    if (!disposed) {
      if (analysisQueued) { analysisQueued = false; void refreshAnalysis() }
      else if (tab.value !== 'sources' && following.value && offset.value === 0 && requestOffset.value === 0) analysisTimer = setTimeout(refreshWindow, 15000)
    }
  }
}
async function refreshDetail() {
  if (!desktop || disposed || !selected.value) return
  if (detailBusy.value) { detailQueued = true; return }
  detailBusy.value = true
  const query = detailQuery.value
  try {
    const next = await getUsageMonitorSession(query.key!, query.offset, query.unpricedOnly, query.filters)
    if (!disposed && query === detailQuery.value) { detail.value = next; detailError.value = ''; detailPageReady.value = true }
  } catch (e) {
    if (!disposed && query === detailQuery.value) detailError.value = errorMessage(e)
  } finally {
    detailBusy.value = false
    if (!disposed && detailQueued) { detailQueued = false; void refreshDetail() }
  }
}
function refreshWindow() {
  const now = Date.now()
  if (anchor.value === now) { void refreshAnalysis(); if (selected.value) void refreshDetail() }
  else anchor.value = now
}
function manualRefresh() { void refreshLive(); refreshWindow(); void refreshSummary(); void reloadCosts() }
function refreshOnResume() {
  if (document.visibilityState === 'hidden') return
  void refreshLive()
  void refreshSummary()
  if (following.value && offset.value === 0 && requestOffset.value === 0) refreshWindow()
}
function pauseFollowing() { following.value = false; clearTimeout(analysisTimer) }
function toggleFollowing() {
  if (following.value) pauseFollowing()
  else { following.value = true; refreshWindow() }
}
function selectSession(key: string, event?: MouseEvent) {
  selectedTrigger.value = event?.currentTarget as HTMLElement || null
  if (selected.value !== key || detailAll.value !== (tab.value === 'overview')) {
    detailAll.value = tab.value === 'overview'
    detail.value = null
    includeDescendants.value = true
    selectedTurn.value = null
    requestOffset.value = 0
    requestUnpricedOnly.value = tab.value === 'sessions' && unpricedOnly.value
    selected.value = key
  }
  if (event) void nextTick(() => detailSection.value?.focus())
}
function resetDetailSelection() {
  selected.value = null
  detailAll.value = false
  includeDescendants.value = true
  detail.value = null
  selectedTurn.value = null
  selectedRequest.value = null
  requestOffset.value = 0
  requestUnpricedOnly.value = false
  detailError.value = ''
  detailPageReady.value = false
  requestTrigger.value = null
}
function closeSession() {
  resetDetailSelection()
  void nextTick(() => {
    if (selectedTrigger.value?.isConnected) selectedTrigger.value.focus()
    else document.getElementById(`monitor-tab-${tab.value}`)?.focus()
  })
}
function selectTurn(id: string | null) { pauseFollowing(); selectedTurn.value = id; requestOffset.value = 0 }
function selectRequest(id: string, event: MouseEvent) {
  pauseFollowing()
  requestTrigger.value = event.currentTarget as HTMLElement
  selectedRequest.value = id
  void nextTick(() => requestSection.value?.focus())
}
function closeRequest() {
  selectedRequest.value = null
  void nextTick(() => { if (requestTrigger.value?.isConnected) requestTrigger.value.focus() })
}
function inspectBreakdown(source: string, selectedModel: string | null, byModel: boolean) {
  pricingReasonFilter.value = null
  tool.value = source
  if (byModel) model.value = selectedModel
  tab.value = 'sessions'
  searchInput.value = ''; search.value = ''; sessionStatus.value = 'all'; unpricedOnly.value = false
  offset.value = 0; resetDetailSelection()
}
function submitSearch() {
  const next = searchInput.value.trim()
  if (next === search.value && offset.value === 0) { void refreshAnalysis(); return }
  search.value = next
  offset.value = 0
}
function clearSearch() { searchInput.value = ''; submitSearch() }
function findParent(parentTool: string, parentId: string) {
  pricingReasonFilter.value = null
  tab.value = 'sessions'
  tool.value = parentTool; searchInput.value = parentId; search.value = parentId
  sessionStatus.value = 'all'; unpricedOnly.value = false; offset.value = 0; resetDetailSelection()
}
function showUnpricedSessions(sessionTool: string | null = tool.value, sessionId = '') {
  pricingReasonFilter.value = null
  tab.value = 'sessions'
  tool.value = sessionTool; searchInput.value = sessionId; search.value = sessionId
  sessionStatus.value = 'all'; unpricedOnly.value = true; offset.value = 0; resetDetailSelection()
}
function showPricingReason(reason: string) {
  tab.value = 'sessions'
  searchInput.value = ''; search.value = ''; sessionStatus.value = 'all'
  unpricedOnly.value = false; pricingReasonFilter.value = reason; offset.value = 0; resetDetailSelection()
}
function selectTab(next: typeof tab.value) {
  tab.value = next
  if (next === 'costs') void scrollToCosts()
}
function showApiView(view:'analysis'|'sessions') {
  callScope.value = 'api'
  tool.value = null; model.value = null
  searchInput.value = ''; search.value = ''; sessionStatus.value = 'all'
  unpricedOnly.value = false; pricingReasonFilter.value = null; offset.value = 0
  resetDetailSelection(); tab.value = view
}
function moveTab(direction: number) {
  const index = tabs.value.findIndex(item => item.id === tab.value)
  selectTab(tabs.value[(index + direction + tabs.value.length) % tabs.value.length].id)
  document.getElementById(`monitor-tab-${tab.value}`)?.focus()
}
watch([range, tool, model], () => { anchor.value = Date.now(); offset.value = 0; resetDetailSelection(); analysis.value = null; loadedAnalysisQuery.value = null; analysisError.value = '' })
watch([tool, billingScope], () => { lastLiveWindows.clear(); lastToolRates.clear(); lastRunningSessions.clear() })
watch(tool, () => { if(explicitQuotaAccountKey.value!=='api:all') explicitQuotaAccountKey.value = null; snapshot.value = null; void refreshLive(); captureQuotaSnapshot() })
watch(billingScope,()=>{
  snapshot.value=null;weekly.value=null;analysis.value=null;loadedAnalysisQuery.value=null
  model.value=null;offset.value=0;resetDetailSelection()
  void refreshLive();void refreshSummary()
})
watch(historyFilters, () => { offset.value = 0; resetDetailSelection() })
watch(unpricedOnly, value => { if (value) pricingReasonFilter.value = null })
watch(analysisQuery, () => { void refreshAnalysis() })
watch(monitorUpstreamRevision, () => { void refreshSummary(); void refreshLive() })
watch(requestUnpricedOnly, () => { requestOffset.value = 0 })
watch(includeDescendants, () => { selectedTurn.value = null; requestOffset.value = 0 })
watch(detailQuery, () => { selectedRequest.value = null; detailError.value = ''; detailPageReady.value = false; if (selected.value) void refreshDetail() })
watch([offset, requestOffset], () => { if (offset.value > 0 || requestOffset.value > 0) pauseFollowing() })
watch(tab, value => {
  if (value === 'sources') {
    clearTimeout(analysisTimer); void loadCatalog()
    if (!priceModel.value) {
      priceModel.value = model.value || modelRanking.value.find(row => row.model)?.model || ''
      if (priceModel.value) void previewPrice()
    }
  }
  else {
    if (value === 'sessions' && detailAll.value) {
      const previous = selected.value
      resetDetailSelection()
      if (historyReady.value) {
        const match = sessionTree.value.find(row => row.session.key === previous) ?? sessionTree.value[0]
        if (match) selectSession(match.session.key)
      }
    }
    if (value === 'sessions' && !selected.value && historyReady.value && sessionTree.value.length) selectSession(sessionTree.value[0].session.key)
    if (following.value) refreshWindow()
  }
})
onMounted(() => {
  window.addEventListener('focus', refreshOnResume)
  document.addEventListener('visibilitychange', refreshOnResume)
  void refreshLive(); void refreshAnalysis(); void refreshSummary()
})
watch(() => route?.query?.view, value => { if (value === 'costs') { range.value = 'month'; openCostAccounts() } })
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('focus', refreshOnResume)
  document.removeEventListener('visibilitychange', refreshOnResume)
  clearTimeout(liveTimer); clearTimeout(analysisTimer); clearTimeout(summaryTimer)
})
</script>

<template>
  <main class="console-surface usage-monitor" :style="usageChartStyle">
    <ConsoleWorkspaceHeader />
    <p v-if="!desktop" class="notice" role="status">{{ t('usageMonitor.text.thisPageRequiresTheDesktopAppToReadLocal') }}</p>
    <template v-else>
      <p v-if="upstreamReadErrors?.length" class="cost-read-error" role="status" :title="upstreamReadErrors.join(' / ')">{{ t('usageMonitor.routes.unavailable') }} · {{ upstreamReadErrors.join(' / ') }}</p>
      <p v-if="error || snapshot?.error" class="notice error" role="alert" :title="errorMessage(error || snapshot?.error)">{{ t('usageMonitor.text.failedToReadUsageSources') }}<span v-if="snapshot"> · {{ t('usageMonitor.text.liveDataRetainedItMayBeStaleOrIncomplete') }}</span></p>
      <p v-if="analysisError" class="notice error" role="alert" :title="analysisError">{{ t('usageMonitor.text.failedToReadPeriodAnalysis') }}<span v-if="analysis"> · {{ t('usageMonitor.text.lastSuccessfulDataRetainedTheDisplayedRangeApplies') }}</span></p>
      <div class="monitor-navigation">
        <nav class="monitor-tabs" role="tablist" :aria-label="t('usageMonitor.text.monitorViews')" @keydown.left.prevent="moveTab(-1)" @keydown.right.prevent="moveTab(1)"><button v-for="item in tabs" :id="`monitor-tab-${item.id}`" :key="item.id" type="button" role="tab" :aria-selected="tab === item.id" :tabindex="tab === item.id ? 0 : -1" :aria-controls="`monitor-panel-${item.id}`" @click="selectTab(item.id)">{{ item.label }}</button></nav>
        <div v-if="tab !== 'sessions' && tab !== 'costs'" class="source-selector" role="group" :aria-label="t('usageMonitor.text.toolFilter')"><button v-for="item in tools" :key="item.id ?? 'all'" type="button" :aria-pressed="tool === item.id" @click="tool = item.id">{{ item.label }}</button></div>
        <div class="heading-actions">
          <button class="icon-button" type="button" :title="following ? t('usageMonitor.text.pauseAnalysisUpdates') : t('usageMonitor.text.resumeAnalysisUpdates')" :aria-label="following ? t('usageMonitor.text.pauseAnalysisUpdates') : t('usageMonitor.text.resumeAnalysisUpdates')" :aria-pressed="!following" @click="toggleFollowing"><Pause v-if="following" :size="16" /><Play v-else :size="16" /></button>
          <button class="icon-button" type="button" :title="t('usageMonitor.text.refreshData')" :aria-label="t('usageMonitor.text.refreshData')" :disabled="liveBusy || analysisBusy" @click="manualRefresh"><RefreshCw :size="17" :class="{ spinning: liveBusy || analysisBusy }" /></button>
          <span class="freshness">{{ snapshot?.collectedAtMs ? t('usageMonitor.text.updated') + new Date(snapshot.collectedAtMs).toLocaleTimeString(usageLocale(), { hour12: false }) : t('usageMonitor.text.initialCollection') }}</span>
          <span v-if="!following" class="paused-state" role="status">{{ t('usageMonitor.text.analysisUpdatesPausedLiveMonitoringContinues') }}</span>
        </div>
      </div>
      <div v-if="tab !== 'costs'" class="tool-overview" :aria-label="t('usageMonitor.text.usageOverviewByTool')">
        <button v-for="source in toolOverviewRows" :key="source.id!" type="button" :style="{ '--tool-color': usageToolColor(source.id) }" :aria-pressed="tool === source.id" @click="tool = tool === source.id ? null : source.id">
          <PlatformIcon :platform="platform(source.id!)" size="lg" /><strong>{{ source.label }}</strong>
          <span class="tool-rate" :title="source.rate?.detail">
            <template v-if="source.rate">{{ source.rate.text }}<span>{{ source.rate.label }}</span></template>
          </span>
          <small>{{ t('usageMonitor.text.running2') }} {{ snapshot?.toolStatusCounts?.[source.id!]?.running ?? t('usageMonitor.text.unknown') }} · {{ periodLabel }} {{ compactNumber(monitorKnownTokenTotal(toolTotals(source.id!), 'totalTokens')) }} Token · {{ conciseCost(toolTotals(source.id!)) }}</small>
        </button>
      </div>
      <div :id="`monitor-panel-${tab}`" role="tabpanel" :aria-labelledby="`monitor-tab-${tab}`">
        <div class="scope-controls">
          <h1>{{ tab === 'costs' || !billingScope ? t('usageMonitor.text.allAccounts') : billingScopes.find(item => item.id === billingScope)?.label }} · {{ tabs.find(item => item.id === tab)?.label }}</h1>
          <label v-if="tab !== 'costs'" class="history-status call-scope-control">{{ t('usageMonitor.callScope.label') }}<select v-model="callScope" :aria-label="t('usageMonitor.callScope.label')"><option v-for="item in billingScopes" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
          <div v-if="tab !== 'sessions'" class="source-selector" role="group" :aria-label="t('usageMonitor.text.analysisTimeRange')"><button v-for="item in ranges" :key="item.id" type="button" :aria-pressed="range === item.id" @click="range = item.id">{{ item.label }}</button></div>
          <label v-if="tab !== 'sessions' && tab !== 'costs'" class="history-status">{{ t('usageMonitor.text.model') }}<select v-model="model" :title="model || t('usageMonitor.text.allModels')" :aria-label="t('usageMonitor.text.analysisModel')"><option :value="null">{{ t('usageMonitor.text.allModels') }}</option><option v-if="model && !analysis?.availableModels.includes(model)" :value="model">{{ model }}</option><option v-for="item in analysis?.availableModels ?? []" :key="item">{{ item }}</option></select></label>
        </div>
        <form v-if="range==='custom'" class="monitor-custom-period" @submit.prevent="applyCustomRange"><label>{{ t('usageMonitor.costs.fromDate') }}<input v-model="customStart" type="date" :max="customEnd" required /></label><label>{{ t('usageMonitor.costs.toDate') }}<input v-model="customEnd" type="date" :min="customStart" :max="dateInput(Date.now())" required /></label><button type="submit" class="icon-button" :title="t('usageMonitor.text.refreshData')"><Check :size="15" /></button><span v-if="customError" role="alert">{{ customError }}</span></form>
        <div v-if="(tab === 'sessions')" class="session-filter-bar history-controls">
          <form class="history-search" role="search" @submit.prevent="submitSearch"><input v-model="searchInput" type="search" maxlength="200" :aria-label="t('usageMonitor.text.searchSessionsProjectsOrModels')" :placeholder="t('usageMonitor.text.searchProjectsSessionsOrModels')" /><button type="submit" class="icon-button" :title="t('usageMonitor.text.searchSessions')" :aria-label="t('usageMonitor.text.searchSessions')"><Search :size="15" /></button><button type="button" class="icon-button" :title="t('usageMonitor.text.clearSearch')" :aria-label="t('usageMonitor.text.clearSearch')" :disabled="!searchInput && !search" @click="clearSearch"><X :size="15" /></button></form>
          <select v-model="tool" :aria-label="t('usageMonitor.text.sessionTool')"><option v-for="item in tools" :key="item.id ?? 'all'" :value="item.id">{{ item.label }}</option></select>
          <div class="source-selector" role="group" :aria-label="t('usageMonitor.text.analysisTimeRange')"><button v-for="item in ranges" :key="item.id" type="button" :aria-pressed="range === item.id" @click="range = item.id">{{ item.label }}</button></div>
          <select v-model="model" :title="model || t('usageMonitor.text.allModels')" :aria-label="t('usageMonitor.text.analysisModel')"><option :value="null">{{ t('usageMonitor.text.allModels') }}</option><option v-if="model && !analysis?.availableModels.includes(model)" :value="model">{{ model }}</option><option v-for="item in analysis?.availableModels ?? []" :key="item">{{ item }}</option></select>
          <select v-model="sessionStatus" :aria-label="t('usageMonitor.text.sessionStatus')"><option value="all">{{ t('usageMonitor.text.allStatuses') }}</option><option value="active">{{ t('usageMonitor.text.activeUnconfirmed') }}</option><option value="history">{{ t('usageMonitor.text.historical') }}</option></select>
          <label class="unpriced-filter"><input v-model="unpricedOnly" type="checkbox" />{{ t('usageMonitor.text.unestimatedOnly') }}</label>
          <select v-model="sessionSort" :aria-label="t('usageMonitor.text.sessionSorting')"><option value="recent">{{ t('usageMonitor.text.recentActivity') }}</option><option value="rate60">{{ t('usageMonitor.text.60SecondRate') }}</option><option value="rate300">{{ t('usageMonitor.text.5MinuteRate') }}</option></select>
          <div v-if="pricingReasonFilter" class="reason-filter" role="status"><span>{{ t('usageMonitor.text.savedQuoteHint') }}<strong>{{ pricingReason(pricingReasonFilter) }}</strong></span><button type="button" class="icon-button" :title="t('usageMonitor.text.clearQuoteHintFilter')" :aria-label="t('usageMonitor.text.clearQuoteHintFilter')" @click="pricingReasonFilter = null"><X :size="15" /></button></div>
        </div>
        <section v-if="tab === 'costs'" class="monitor-finance-page">
          <nav class="finance-navigation" :aria-label="t('usageMonitor.inlineCosts.tab')">
            <button type="button" :aria-pressed="costPage === 'accounts' || costPage === 'account'" @click="openCostAccounts">{{ t('desktop.localCost.accountAssets') }}</button>
            <button type="button" :aria-pressed="costPage === 'channels'" @click="openCostChannels">{{ t('desktop.localCost.channels') }}</button>
            <button type="button" :aria-pressed="costPage === 'records'" @click="openCostRecords()">{{ t('desktop.localCost.records') }}</button>
            <button type="button" :aria-pressed="costPage === 'api'" @click="openApiPrices">{{ t('usageMonitor.delivery.prices') }}</button>
          </nav>
          <p v-if="costError" class="cost-read-error" role="status" :title="costError">{{ costData ? t('desktop.localCost.retained') : t('usageMonitor.costIntegration.unavailable') }} <button type="button" @click="reloadCosts"><RefreshCw :size="13" />{{ t('usageMonitor.text.refreshData') }}</button></p>
          <template v-if="costData">
            <div v-if="costPage === 'accounts' || accountListReturn" v-show="costPage === 'accounts'">
              <UsageCostSummary :data="costData" :rows="costRows" :busy="costBusy" scope="all" hide-navigation @enter="openCostRecords('', true)" />
              <UsageCostAccounts :data="costData" :rows="costRows" :busy="costBusy" :saving="costSaving" :save-settings="saveCostSettings" @account="inspectCostAccount" @record="openCostRecords" @changed="costsChanged" />
            </div>
            <CostEventsPanel v-if="costPage === 'records'" ref="costEvents" v-bind="LOCAL_FINANCE_SCOPE" :start-ms="costData.report.startMs" :end-ms="costData.report.endMs" :accounts="costAccountChoices" restrict-accounts @changed="costsChanged" />
            <LocalCostChannels v-if="costPage === 'channels'" :snapshot="costData.finances" :start-ms="costData.report.startMs" :end-ms="costData.report.endMs" :accounts="costAccountChoices" @enter="openCostRecords('', true)" />
            <UsageApiPrices v-if="costPage === 'api'" :settings="costData.report.settings" :saving="costSaving" :save-settings="saveCostSettings" />
            <template v-if="costPage === 'account' && inspectedAccount">
              <header class="finance-account-heading"><button type="button" class="monitor-cost-command" @click="backToCostAccounts"><ArrowLeft :size="14" />{{ t('usageMonitor.flow.backToAccounts') }}</button><h2>{{ inspectedAccount.name }}</h2></header>
              <UsagePeriodSummary :totals="inspectedAccount.totals" :cost-text="conciseCost(inspectedAccount.totals)" :cost-note="costBasis(inspectedAccount.totals)" :cny-per-usd="costData.report.settings.cnyPerUsd" />
              <UsageAccountCost v-if="inspectedAccount.id !== 'unassigned'" :key="inspectedAccount.id" :row="inspectedAccount" :data="costData" :saving="costSaving" :save-settings="saveCostSettings" hide-inspector @record="openCostRecords" @prices="openApiPrices" @changed="costsChanged" />
              <p v-else-if="inspectedAccount.billingCounts" class="page-note">{{ t('desktop.localCost.unassignedCalls', { subscription: inspectedAccount.billingCounts.subscription ?? 0, unknown: inspectedAccount.billingCounts.unknown ?? 0 }) }}</p>
              <LocalCostUsagePanel v-model="costAccountId" v-model:source="costSourceKey" :report="costData.report" :rows="costRows" :quotas="quotas?.quotas ?? []" :quota-error="quotaError" :live="accountLive" :live-error="accountLiveError" account-locked />
            </template>
          </template>
          <p v-else-if="!costError" class="page-note" role="status">{{ t('desktop.localCost.loading') }}</p>
        </section>
        <UsagePeriodSummary v-if="(tab === 'analysis')" :totals="periodTotals" :cost-text="conciseCost(periodTotals)" :cost-note="costBasis(periodTotals)" :cny-per-usd="analysis?.cnyPerUsd" />
        <UsageLivePanel v-if="tab === 'overview'" v-model:seconds="liveRateSeconds" :snapshot="snapshot" :tool="tool" :last-windows="lastLiveWindows" @session="openLiveSession" @model="openLiveModel">
          <template #after-summary>
        <div class="monitor-cost-overview">
          <UsageCostSummary v-if="costData" compact :data="costData" :rows="costRows" :busy="costBusy" scope="all" @accounts="openCostAccounts" @open="openCostRecords()" @channels="openCostChannels" @prices="openApiPrices" />
          <p v-else-if="!costError" class="page-note" role="status">{{ t('desktop.localCost.loading') }}</p>
          <p v-if="costError" class="cost-read-error" role="status" :title="costError">{{ costData ? t('desktop.localCost.retained') : t('usageMonitor.costIntegration.unavailable') }} <button type="button" @click="reloadCosts"><RefreshCw :size="13" />{{ t('usageMonitor.text.refreshData') }}</button></p>
        </div>
        <section v-if="tab === 'overview'" class="weekly-section" :aria-label="t('usageMonitor.text.weeklyValueQuota')">
          <div class="section-bar"><h2><CalendarDays :size="15" />{{ t('usageMonitor.text.weeklyValueQuota') }}</h2><div class="detail-actions"><span>{{ weekly ? time(weekly.startMs) + t('usageMonitor.text.onward') : t('usageMonitor.text.loadingThisWeekSRecords') }} {{ t('usageMonitor.text.updatedEvery60Seconds') }}</span><button type="button" class="icon-button" :title="t('usageMonitor.text.refreshWeeklyValueQuota')" :aria-label="t('usageMonitor.text.refreshWeeklyValueQuota')" :disabled="summaryBusy" @click="refreshSummary"><RefreshCw :size="15" :class="{ spinning: summaryBusy }" /></button></div></div>
          <div class="weekly-workspace">
            <div class="weekly-value">
              <p v-if="weeklyUnlocated?.requestCount" class="page-note weekly-unlocated">{{ t('usageMonitor.text.unlocatedExcludedFromWeek', { count: number(weeklyUnlocated.requestCount) }) }}</p>
              <p v-if="weeklyTotals?.unitemizedRecords" class="page-note">{{ monitorRequestCountLabel(weeklyTotals) }}</p>
              <div class="week-figures">
                <div><span>{{ t('usageMonitor.text.estimatedIdentifiedUsageThisWeek') }}</span><strong>{{ conciseCost(weeklyTotals) }}</strong><small v-if="weeklyTotals && monitorUnquotedRequests(weeklyTotals)">{{ t('usageMonitor.text.unpricedUsageCount', { count: number(monitorUnquotedRequests(weeklyTotals)) }) }}</small></div>
                <div v-if="!apiAccountSelected" class="account-quota-forecast" :title="currentForecastAccount?.billingAccountVerified === false ? t('usageMonitor.text.quotaProjectionReferenceScope') : undefined"><span>{{ t(accountQuotaPrediction.partial ? 'usageMonitor.text.pricedPortionProjection' : accountQuotaPrediction.finalized ? 'usageMonitor.text.recordedQuotaTotal' : currentForecastAccount?.accountKey === accountUsage?.currentAccountKey ? 'usageMonitor.text.estimatedCurrentAccountWeeklyQuotaTotal' : 'usageMonitor.text.estimatedSelectedAccountWeeklyQuotaTotal') }}</span><strong v-for="quote in accountQuotaPrediction.quotes" :key="quote.currency">{{ accountQuotaPrediction.finalized ? '' : '≈ ' }}{{ summaryMoney(quote.projectedSubtotal, quote.currency, true) }}</strong><strong v-if="!accountQuotaPrediction.quotes.length" class="quota-blocked">{{ t('usageMonitor.text.estimateUnavailable') }}</strong><small v-if="accountQuotaPrediction.label">{{ accountQuotaPrediction.label }}<template v-if="accountQuotaPrediction.context"> {{ t('usageMonitor.text.usedThisCycle') }} {{ accountQuotaPrediction.context.usedPercent.toFixed(1) }}%</template></small><small v-if="accountQuotaPrediction.message">{{ accountQuotaPrediction.message }}</small><small v-else>{{ t(currentForecastAccount?.billingAccountVerified === false ? 'usageMonitor.text.quotaProjectionReference' : 'usageMonitor.text.extrapolatesIdentifiedBillableUsageInThisCycleTo100') }}</small><small v-if="accountQuotaPrediction.partial">{{ t('usageMonitor.text.billablePortionOnlyUnidentifiedOrUnpricedUsageExcluded') }} · {{ t('usageMonitor.text.pricedPortionCoverage', { priced: accountQuotaPrediction.coveredRequests, total: accountQuotaPrediction.requestCount }) }}</small><small v-if="accountQuotaPrediction.updatedAtMs" class="quota-prediction-updated">{{ t('usageMonitor.text.estimateUpdated') }} {{ time(accountQuotaPrediction.updatedAtMs) }}</small></div>
              </div>
              <UsageValueChart v-for="quote in accountQuotaPrediction.quotes.filter(row => row.projectedSubtotal > 0)" :key="'composition-' + quote.currency" :forecast="quote" :quota="accountQuotaPrediction.context" :partial="accountQuotaPrediction.partial" />
              <dl class="weekly-token-strip"><div><dt>{{ t(weeklyTotals?.unitemizedRecords ? 'usageMonitor.text.usageRecords' : 'usageMonitor.text.requests') }}</dt><dd>{{ number(weeklyTotals?.requestCount) }}</dd></div><div><dt>{{ t('usageMonitor.text.inputTokens') }}</dt><dd>{{ compactNumber(monitorKnownTokenTotal(weeklyTotals, 'inputTokens')) }}</dd></div><div><dt>{{ t('usageMonitor.text.outputTokens') }}</dt><dd>{{ compactNumber(monitorKnownTokenTotal(weeklyTotals, 'outputTokens')) }}</dd></div><div><dt>{{ t('usageMonitor.text.cacheHit') }}</dt><dd>{{ monitorCacheRatio(weeklyTotals) }}</dd></div></dl>
              <p v-for="field in (['inputTokens', 'outputTokens'] as const)" :key="field" class="page-note">{{ monitorTokenCoverage(weeklyTotals, field) }}</p>
              <p v-if="monitorCacheCoverage(weeklyTotals)" class="page-note">{{ monitorCacheCoverage(weeklyTotals) }}</p>
              <details class="week-evidence">
                <summary>{{ t('usageMonitor.text.pricingEstimationEvidence') }}</summary>
                 <p class="page-note">{{ t('usageMonitor.text.referenceValueNotAPaidBillUncollectedUsageIs') }} {{ costBasis(weeklyTotals) }}</p>
                <p v-if="accountQuotaPrediction.context && accountQuotaPrediction.cycle" class="page-note">{{ accountQuotaPrediction.label }}{{ t('usageMonitor.text.label') }}{{ time(accountQuotaPrediction.cycle.startMs) }} {{ t('usageMonitor.text.to') }} {{ time(accountQuotaPrediction.cycle.resetAtMs) }}{{ t('usageMonitor.text.identifiedAmountThisCycleQuotaUsed') }} {{ accountQuotaPrediction.context.usedPercent.toFixed(1) }}{{ t(accountQuotaPrediction.partial ? 'usageMonitor.text.pricedPortionProjectionAssumingUnchangedMix' : 'usageMonitor.text.estimatedWeeklyQuotaTotalAssumingTheModelAndCache') }}<template v-if="accountQuotaPrediction.updatedAtMs">{{ t('usageMonitor.text.estimateUpdated') }} {{ time(accountQuotaPrediction.updatedAtMs) }}{{ t('usageMonitor.text.label2') }}</template></p>
                <p class="page-note">{{ t('usageMonitor.text.belowGlobalCalendarWeekComparisonAtStandardPricesAnd') }}</p>
                <div v-if="exhaustedQuotas.length || restrictedMainQuotas.length" class="forecast-paused" role="status"><Clock3 :size="22" /><div><strong>{{ t('usageMonitor.text.recordedUsageContinuesAccumulatingRemainingUsageIsNotPredicted') }}</strong><p v-for="item in exhaustedQuotas" :key="item.id">{{ toolName(item.tool) }} · {{ quotaAccountLabel(item) }} · {{ quotaWindow(item) }}{{ t('usageMonitor.text.exhausted') }}<br />{{ item.resetsAtMs ? t('usageMonitor.text.planReset') + time(item.resetsAtMs) : t('usageMonitor.text.waitingForTheSourceToProvideResetTime') }}</p><p v-for="item in restrictedMainQuotas" :key="'restricted-' + item.id">{{ toolName(item.tool) }} · {{ quotaAccountLabel(item) }} · {{ quotaProviderStatus(item) }}<template v-if="quotaProviderReason(item)"> · {{ quotaProviderReason(item) }}</template></p><small>{{ hasExtraCredits ? t('usageMonitor.text.extraCreditsAreAvailableButTheirRemainingDurationCannot') : t('usageMonitor.text.availableCreditsHaveNotBeenConfirmed') }}{{ t('usageMonitor.text.actualUsageWillContinueToBeRecorded') }}</small></div></div>
                <p v-for="quote in weeklyReference" :key="'uniform-' + quote.currency" class="page-note">{{ t('usageMonitor.text.comparisonNormalizedToStandardMode') }}{{ summaryMoney(quote.amount ?? quote.knownSubtotal, quote.currency) }}{{ t('usageMonitor.text.aComparisonUnderTheSameBillingAssumptionNotA') }}</p>
                <p v-for="quote in weeklyReference" :key="quote.currency" class="page-note">{{ currencyName(quote.currency) }}{{ t('usageMonitor.text.priced') }} {{ number(quote.pricedRequests) }} / {{ number(weeklyTotals?.requestCount) }} {{ t('usageMonitor.text.requests2') }}{{ number(quote.unpricedRequests) }} {{ t('usageMonitor.text.missingPricingEvidence') }}{{ number(quote.requestedModelRequests) }} {{ t('usageMonitor.text.modelsHaveRequestSettingsOnlyCatalog') }} {{ quote.catalogRevision || t('usageMonitor.text.officialSupplementaryPrices') }} {{ t('usageMonitor.text.rules') }} {{ quote.ruleVersion }}{{ t('usageMonitor.text.label2') }}<template v-if="quote.excludedComponents?.length">{{ t('usageMonitor.text.excludes') }} {{ quote.excludedComponents.map(excludedComponent).join(t('usageMonitor.text.label3')) }}{{ t('usageMonitor.text.label2') }}</template></p>
                <div v-for="quote in weeklyForecast" :key="'forecast-' + quote.currency" class="forecast-evidence"><p>{{ forecastMethod(quote.method) }}{{ t('usageMonitor.text.recorded') }} {{ summaryMoney(quote.observedSubtotal, quote.currency) }} {{ t('usageMonitor.text.estimatedRemainingPeriod') }} {{ summaryMoney(quote.additionalSubtotal, quote.currency) }}{{ t('usageMonitor.text.predictsOnlyCollectedBillableRecordsGapsInLogsDo') }}<template v-if="quote.method === 'weekday_hour'">{{ t('usageMonitor.text.historicalWeekdaySlotsAlignedBy') }} {{ quote.timeBasis || 'UTC' }} {{ t('usageMonitor.text.label4') }}</template></p><p v-if="!quote.comparisons.length">{{ t('usageMonitor.text.insufficientHistoryUsingThisWeekSUsagePaceFor') }}</p><p v-for="comparison in quote.comparisons" :key="comparison.method">{{ forecastMethod(comparison.method) }} · {{ comparison.folds }} {{ t('usageMonitor.text.historicalBacktestsMeanAbsoluteError') }} {{ summaryMoney(comparison.mae, quote.currency) }}{{ t('usageMonitor.text.collectedRecordsOnlyNotActualBillingError') }}</p></div>
                <p class="page-note">{{ t('usageMonitor.text.theseAreSavedPricingRecordsAndMayUseDifferent') }}</p>
                <p v-for="quote in weeklyQuotes" :key="'known-' + quote.currency" class="page-note">{{ t('usageMonitor.text.identifiedPricedPortion') }}{{ monitorAmount(quote.amount, quote.currency) }}</p>
                <p class="page-note">{{ t('usageMonitor.text.identifiedRequestModesAndAmountsAppearAboveReferenceValues') }}</p>
              </details>
              <p v-if="!billingScope && !tool && accountUsage?.unassignedWeek.requestCount" class="page-note">{{ t('usageMonitor.text.thisWeek') }} {{ number(accountUsage.unassignedWeek.requestCount) }} {{ t('usageMonitor.text.recordsHaveNoConfirmedAccountRetainedInGlobalTotals') }}</p>
               <p v-if="weeklyError" class="unpriced" role="status" :title="weeklyError">{{ t('usageMonitor.text.weeklyDataUpdateFailed') }}<template v-if="weekly"> · {{ t('usageMonitor.text.retainingRecordsFrom') }} {{ time(weekly.endMs) }}{{ t('usageMonitor.text.label5') }}</template></p>
            </div>
            <div class="allowance-overview">
              <div class="allowance-heading"><h3>{{ t(apiAccountSelected ? 'usageMonitor.text.accountUsage' : 'usageMonitor.text.accountQuota') }}</h3><span><template v-if="quotaAccountChoices.length">{{ quotaAccountChoices.length }} {{ t('usageMonitor.text.accounts') }} </template>{{ t('usageMonitor.text.toolReportedData') }}</span></div>
              <div v-if="quotaAccountChoices.length" class="quota-account-controls">
                <select v-model="selectedQuotaAccountKey" :aria-label="t('usageMonitor.text.quotaAccount')"><option v-for="account in quotaAccountChoices" :key="account.accountKey" :value="account.accountKey">{{ account.accountKey === 'api:all' ? 'API' : toolName(account.tool) + ' · ' + quotaAccountLabel(account) }}{{ !accountUsageError && account.accountKey === accountUsage?.currentAccountKey ? t(account.billingAccountVerified === false ? 'usageMonitor.text.currentLoginIdentity' : 'usageMonitor.text.current') : '' }}</option></select>
                <button v-if="selectedQuotaAccount && selectedQuotaAccount.accountKey !== 'api:all' && selectedQuotaAccount.accountKey !== accountUsage?.currentAccountKey" type="button" class="icon-button" :aria-label="t('usageMonitor.text.hideAccount')" :title="t('usageMonitor.text.removeFromList')" @click="hideSelectedQuotaAccount"><EyeOff :size="15" /></button>
              </div>
              <details v-if="hiddenKnownQuotaAccounts.length" class="hidden-quota-accounts"><summary>{{ t('usageMonitor.text.hiddenAccounts') }} {{ hiddenKnownQuotaAccounts.length }}</summary><div v-for="account in hiddenKnownQuotaAccounts" :key="account.accountKey" class="hidden-quota-account"><span>{{ toolName(account.tool) }} · {{ quotaAccountLabel(account) }}</span><button type="button" class="icon-button" :aria-label="t('usageMonitor.text.restoreAccount') + quotaAccountLabel(account)" :title="t('usageMonitor.text.restoreAccount2')" @click="restoreQuotaAccount(account.accountKey)"><RotateCcw :size="15" /></button></div></details>
              <p v-if="quotaAccountStorageError" class="unpriced" role="status">{{ quotaAccountStorageError.operation === 'read' ? t('usageMonitor.text.failedToReadAccountDisplaySettings') : t('usageMonitor.text.failedToSaveAccountDisplaySettings') }}{{ quotaAccountStorageError.message }}</p>
              <p v-if="!quotaAccountChoices.length" class="page-note">{{ summaryBusy && !quotas ? t('usageMonitor.text.loadingQuotas') : hiddenKnownQuotaAccounts.length ? t('usageMonitor.text.noVisibleAccounts') : t('usageMonitor.text.noConfirmableAccountQuotaYet') }}</p>
              <details v-for="group in quotaGroups" :key="group.id" class="quota-group" :class="{ 'current-quotas': group.id === 'current' }" :open="group.id === 'current'" @toggle="group.id === 'history' && (quotaHistoryOpen = ($event.currentTarget as HTMLDetailsElement).open)">
                <summary>{{ group.label }} <span>{{ group.items.length }}</span></summary>
                <div v-if="group.id === 'current' || quotaHistoryOpen" class="allowance-list" role="region" :aria-label="group.id === 'current' ? t('usageMonitor.text.remainingQuotaByAccount') : t('usageMonitor.text.historicalQuotasUnidentifiedAccounts')" :tabindex="group.id === 'history' ? 0 : undefined">
                <div v-for="item in group.items" :key="item.id" class="allowance-item" :class="{ 'is-stale': quotaIsHistorical(item), 'has-account-amounts': accountUsageQuotaIds.has(item.id) && accountUsageByKey.has(item.accountKey), 'has-quota-dial': group.id === 'current' && item.remainingPercent != null }" :style="{ '--quota-color': quotaIsHistorical(item) || item.remainingPercent == null ? usageColors.unknown : item.remainingPercent === 0 ? usageColors.danger : item.remainingPercent <= 10 ? usageColors.warning : usageColors.success }">
                  <div v-if="group.id === 'current' && item.remainingPercent != null" class="quota-dial" role="img" :aria-label="quotaAccountLabel(item) + (quotaIsHistorical(item) ? t('usageMonitor.text.lastUsed') : t('usageMonitor.text.used')) + usagePercentLabel(100 - item.remainingPercent) + (quotaIsHistorical(item) ? t('usageMonitor.text.lastRemaining') : t('usageMonitor.text.remaining')) + quotaValue(item)" :style="{ '--quota-fill': (100 - item.remainingPercent) * 3.6 + 'deg' }"><strong>{{ usagePercentLabel(100 - item.remainingPercent) }}<small>{{ quotaIsHistorical(item) ? t('usageMonitor.text.lastUsed') : t('usageMonitor.text.used') }}</small></strong></div>
                  <div class="quota-copy">
                  <div class="quota-account-header" :class="{ 'has-account-amounts': accountUsageQuotaIds.has(item.id) && accountUsageByKey.has(item.accountKey) }">
                  <div class="quota-account-identity">
                  <div class="allowance-title"><span>{{ toolName(item.tool) }} · {{ quotaAccountLabel(item) }}</span><strong>{{ quotaValue(item) }} <small>{{ quotaIsHistorical(item) ? group.id === 'current' ? t('usageMonitor.text.lastRemaining2') : t('usageMonitor.text.historicalRemaining') : t('usageMonitor.text.remaining2') }}</small></strong></div>
                   <div class="allowance-detail"><span>{{ quotaWindow(item) }}</span><span v-if="quotaIsHistorical(item)" :title="item.sourceError ?? undefined">{{ group.id === 'current' ? quotaForecast(item) : item.expired ? t('usageMonitor.text.resetTimePassedWaitingForNewRecords') : t('usageMonitor.text.historicalSnapshot') }}</span></div>
                  <p v-if="group.id === 'current'" class="remaining-label" :class="{ exhausted: item.remainingPercent === 0 && !quotaIsHistorical(item) }">{{ quotaIsHistorical(item) ? t('usageMonitor.text.lastRemaining2') : t('usageMonitor.text.remaining2') }} {{ quotaValue(item) }}</p>
                  </div>
                  <UsageAccountPeriods v-if="accountUsageQuotaIds.has(item.id) && accountUsageByKey.get(item.accountKey)" :account="accountUsageByKey.get(item.accountKey)!" />
                  </div>
                  <meter v-if="item.remainingPercent != null" :value="item.remainingPercent" min="0" max="100" :aria-label="t('usageMonitor.text.remainingPercentage', { value0: toolName(item.tool), value1: quotaWindow(item) })" />
                  <small>{{ item.resetsAtMs ? t('usageMonitor.text.resets') + time(item.resetsAtMs) : t('usageMonitor.text.resetTimeNotReported') }} {{ t('usageMonitor.text.updated2') }} {{ time(item.observedAtMs) }}</small>
                   <small v-if="item.modelId">{{ item.modelId }}</small><small :title="item.sourceError || (item.providerStatus ? quotaProviderStatus(item) : undefined)">{{ quotaSourceName(item.source) }}<template v-if="item.attribution !== 'account'"> {{ t('usageMonitor.text.noAccountInformationOnlyTheSourceSessionIsKnown') }}</template></small>
                   <p v-if="quotaProviderBlocked(item) || item.providerStatus?.rateLimitReachedType === 'unknown'" class="quota-provider-status" :class="{ unpriced: quotaProviderBlocked(item) }"><template v-if="quotaIsHistorical(item)">{{ t('usageMonitor.text.lastRecorded') }} · </template>{{ quotaProviderStatus(item) }}<template v-if="quotaProviderReason(item)"> · {{ quotaProviderReason(item) }}</template></p>
                   <div v-if="item.providerStatus?.spendControl" class="provider-spend-control"><small :title="item.providerStatus.spendControl.individualLimit?.source ?? undefined">{{ t('usageMonitor.text.officialSpendControl') }} · {{ spendControlState(item.providerStatus.spendControl.reached) }}</small><template v-if="item.providerStatus.spendControl.individualLimit"><p>{{ t('usageMonitor.text.officialSpendAmounts', { limit: item.providerStatus.spendControl.individualLimit.limit ?? '—', used: item.providerStatus.spendControl.individualLimit.used ?? '—', remaining: item.providerStatus.spendControl.individualLimit.remaining ?? '—' }) }}</p><small v-if="item.providerStatus.spendControl.individualLimit.usedPercent != null || item.providerStatus.spendControl.individualLimit.remainingPercent != null">{{ t('usageMonitor.text.officialSpendPercentages', { used: item.providerStatus.spendControl.individualLimit.usedPercent == null ? '—' : usagePercentLabel(item.providerStatus.spendControl.individualLimit.usedPercent), remaining: item.providerStatus.spendControl.individualLimit.remainingPercent == null ? '—' : usagePercentLabel(item.providerStatus.spendControl.individualLimit.remainingPercent) }) }}</small><small v-if="item.providerStatus.spendControl.individualLimit.resetsAtMs">{{ t('usageMonitor.text.resets') }} {{ time(item.providerStatus.spendControl.individualLimit.resetsAtMs) }}</small><small v-else-if="item.providerStatus.spendControl.individualLimit.resetAfterSeconds != null">{{ t('usageMonitor.text.officialResetCountdown', { seconds: item.providerStatus.spendControl.individualLimit.resetAfterSeconds }) }}</small></template></div>
                  <small v-if="item.resetsAtMs == null && item.resetAfterSeconds != null">{{ t('usageMonitor.text.officialResetCountdown', { seconds: item.resetAfterSeconds }) }}</small>
                   <p v-if="group.id === 'current' && !quotaIsHistorical(item) && item.billingAccountVerified !== false && !quotaProviderBlocked(item) && (item.remainingPercent === 0 || item.depletion?.status === 'estimated')" class="quota-estimate">{{ quotaForecast(item) }}<small v-if="item.depletion && item.remainingPercent !== 0">{{ item.depletion.sampleCount }} {{ t('usageMonitor.text.recordsDuration') }} {{ duration(item.depletion.spanMs) }}<template v-if="item.depletion.consumptionPercentPerHour != null"> {{ t('usageMonitor.text.consumptionAbout') }} {{ item.depletion.consumptionPercentPerHour.toFixed(2) }} {{ t('usageMonitor.text.percentagePointsHour') }}</template></small></p>
                  </div>
                </div>
                </div>
              </details>
              <UsageAccountPeriods v-if="selectedAccountUsage && !displayAccountKeys.has(selectedQuotaAccountKey)" :account="selectedAccountUsage" />
              <UsageApiAccount v-if="selectedApiUsage" :usage="selectedApiUsage"><div v-if="selectedQuotaAccountKey === 'api:all'" class="detail-actions"><button type="button" class="evidence-link" data-api-view="analysis" @click="showApiView('analysis')">{{ t('usageMonitor.text.usageAnalysis') }}<ChevronRight :size="14" /></button><button type="button" class="evidence-link" data-api-view="sessions" @click="showApiView('sessions')">{{ t('usageMonitor.text.viewApiDetails') }}<ChevronRight :size="14" /></button></div><button v-else type="button" class="evidence-link" @click="inspectCostAccount(selectedQuotaAccountKey)">{{ t('usageMonitor.flow.accountDetails') }}<ChevronRight :size="14" /></button></UsageApiAccount>
              <p v-else-if="apiAccountSelected" class="page-note api-usage-unavailable" role="status">{{ t('usageMonitor.text.apiUsageUnavailable') }}</p>
              <section v-if="creditGroups.length" class="credits-section" :aria-label="t('usageMonitor.text.extraCreditBalance')">
                <div class="allowance-heading"><h3>{{ t('usageMonitor.text.extraCredits') }}</h3><span>{{ t('usageMonitor.text.countedOncePerAccount') }}</span></div>
                <p v-if="!creditGroups.some(group => group.id === 'current')" class="page-note">{{ t('usageMonitor.text.currentCreditBalanceUnavailableExpandToViewHistoricalRecords') }}</p>
                <details v-for="group in creditGroups" :key="group.id" class="credit-group" :class="{ 'current-credits': group.id === 'current' }" :open="group.id === 'current'">
                  <summary>{{ group.label }} <span>{{ group.items.length }}</span></summary>
                  <div class="credit-accounts" role="region" :aria-label="group.label" tabindex="0"><div v-for="account in group.items" :key="account.accountKey" class="credit-account" :class="{ 'historical-credit': creditIsHistorical(account) }"><div><span>{{ quotaAccountLabel(account) }}</span><small>{{ creditState(account) }}</small></div><strong :title="account.credits?.balance ?? undefined">{{ creditBalance(account) }}<small v-if="account.credits?.balance != null">{{ creditIsHistorical(account) ? t('usageMonitor.text.lastCreditBalance') : t('usageMonitor.text.credits') }}</small></strong><p>{{ t('usageMonitor.text.updated3') }} {{ time(account.observedAtMs) }}<template v-if="creditIsHistorical(account)"> {{ t('usageMonitor.text.lastRecorded') }}</template></p></div></div>
                </details>
                <p class="page-note">{{ t('usageMonitor.text.creditsAndPlanQuotaAreSeparateNotConvertedTo') }}</p>
              </section>
              <details v-if="!apiAccountSelected && (quotaSources.length || alternateQuotaReadings.length || visibleQuotas.some(item => item.billingAccountVerified === false))" class="quota-source-details">
                <summary>{{ t('usageMonitor.text.quotaSourcesStatus') }} <span v-if="quotaSources.length">{{ quotaSources.length }} {{ t('usageMonitor.text.sources') }}</span><b v-if="quotaSourceWarnings">{{ quotaSourceWarnings }} {{ t('usageMonitor.text.itemsUnconfirmed') }}</b></summary>
                <p v-for="item in alternateQuotaReadings" :key="item.id" class="quota-source-note" :title="item.sourceError ?? undefined">
                  {{ quotaSourceName(item.source) }} · {{ quotaWindow(item) }} ·
                  {{ t(quotaIsHistorical(item) ? 'usageMonitor.text.lastUsed' : 'usageMonitor.text.used') }} {{ usagePercentLabel(item.usedPercent!) }}
                  {{ t('usageMonitor.text.updated2') }} {{ time(item.observedAtMs) }}
                </p>
                <p v-if="visibleQuotas.some(item => item.billingAccountVerified === false)" class="quota-source-note">{{ t('usageMonitor.text.quotaAccountUnconfirmed') }}</p>
                <p v-for="source in quotaSources" :key="source.tool + source.source" class="quota-source-note">{{ toolName(source.tool) }} · {{ source.error || quotaSourceStatus(source.status) }}<template v-if="source.scopeNote"> · {{ quotaScopeNote(source.scopeNote) }}</template><template v-if="source.coverage?.scopesUnreported"> · {{ source.coverage.scopesUnreported }} {{ t('usageMonitor.text.sourcesWithoutQuotaData') }}</template></p>
              </details>
               <p v-if="quotaError" class="unpriced" role="status" :title="quotaError">{{ t('usageMonitor.text.quotaReadFailed') }}<template v-if="quotas?.quotas.length"> · {{ t('usageMonitor.text.existingSnapshotsDoNotRepresentCurrentQuota') }}</template></p>
              <UsageAccountCost v-if="costData && selectedAccountCost" compact :key="selectedAccountCost.id" :row="selectedAccountCost" :data="costData" :saving="costSaving" :save-settings="saveCostSettings" @record="openCostRecords" @inspect="inspectCostAccount" @prices="openApiPrices" @changed="costsChanged" />
               <p v-if="accountUsageError" class="unpriced" role="status" :title="accountUsageError">{{ t('usageMonitor.text.accountAmountsReadFailed') }}<template v-if="accountUsage?.accounts.length || accountUsage?.apiUsage"> · {{ t('usageMonitor.text.existingAmountsMayNotBeCurrent') }}</template></p>
            </div>
          </div>
        </section>
            <UsagePeriodSummary :totals="periodTotals" overview :counts="statusCounts" :cost-text="conciseCost(periodTotals)" :cost-note="costBasis(periodTotals)" :cny-per-usd="analysis?.cnyPerUsd" />
          </template>
        </UsageLivePanel>
        <div v-if="tab === 'overview' || (tab === 'analysis')" class="mode-coverage"><span>{{ t('usageMonitor.text.autoDetectedModesStandard') }} {{ modeCount('standard') }} {{ t('usageMonitor.text.fast2') }} {{ modeCount('fast') }} {{ t('usageMonitor.text.priority2') }} {{ modeCount('ultrafast') }} {{ t('usageMonitor.text.unidentified') }} {{ modeCount('unknown') }}</span><button v-if="periodTotals && monitorUnquotedRequests(periodTotals)" class="unpriced-link" :aria-label="t('usageMonitor.text.viewUnestimatedSessions')" @click="showUnpricedSessions()">{{ monitorUnquotedRequests(periodTotals) }} {{ t('usageMonitor.text.unestimated') }}</button></div>
        <p v-if="tab !== 'costs'" class="analysis-range">{{ analysisBusy ? t('usageMonitor.text.updatingPeriodData') : '' }}{{ periodLabel }} · {{ analysis ? (analysis.startMs == null ? t('usageMonitor.text.allRecords') : time(analysis.startMs)) + t('usageMonitor.text.to2') + time(analysis.endMs) : t('usageMonitor.text.notYetLoaded') }}<template v-if="periodTotals?.incompleteRequests"> · {{ periodTotals.incompleteRequests }} {{ t('usageMonitor.text.incompleteRecordsKnownSubtotalsOnly') }}</template></p>
        <template v-if="(tab === 'analysis')">
          <div class="analysis-visuals">
            <UsageTrend :timeline="analysis?.timeline" :history="analysis?.observedTimeline" :totals="periodTotals" :loading="analysisBusy" :error="analysisError" />
            <section class="model-ranking"><div class="section-bar"><h2>{{ t('usageMonitor.text.modelUsageRanking') }}</h2><span>{{ t('usageMonitor.text.unit') }}{{ rankingUnit.label }}</span></div><p class="chart-note">{{ t('usageMonitor.text.inputOutputReasoningIsNotAddedTwice') }}</p><div class="ranking-scroll"><button v-for="row in modelRanking" :key="row.tool + row.model" :style="{ '--model-color': usageModelColor(row.model) }" :disabled="!row.model" :title="(row.model || t('usageMonitor.text.modelNotRecordedModelFilteringUnavailable')) + ' · ' + number(row.totals.totalTokens) + ' Token'" @click="inspectBreakdown(row.tool, row.model, true)"><span>{{ row.model || t('usageMonitor.text.unidentifiedModel') }}<small>{{ toolName(row.tool) }}</small></span><span class="rank-track"><i :style="{ width: row.totals.totalTokens / rankingMaximum * 100 + '%' }" /></span><b>{{ rankingValue(row.totals.totalTokens) }}</b></button><p v-if="!modelRanking.length" class="empty">{{ analysis ? t('usageMonitor.text.noModelUsageInThisPeriod') : t('usageMonitor.text.modelUsageNotYetAvailable') }}</p></div></section>
          </div>
          <UsageModelCosts :models="analysis?.byModel ?? []" :expenses="analysis?.apiExpense?.byModel" :live="snapshot?.live" :period="periodLabel" :loading="analysisBusy" evidence @evidence="(source, name) => inspectBreakdown(source, name, true)" />
          <p v-if="analysis?.costError" class="cost-read-error" role="status" :title="analysis.costError">{{ t('usageMonitor.costIntegration.unavailable') }}</p>
          <UsageTokenComposition :input-tokens="periodTotals?.inputTokens" :output-tokens="periodTotals?.outputTokens" :cache-read-tokens="periodTotals?.cacheReadTokens" :partial="!!periodTotals?.incompleteRequests" />
          <UsageEfficiencyBand :totals="periodTotals" :motion="following" />
          <UsageRecordedMetrics :totals="periodTotals" />
          <details class="tool-breakdown breakdown-section"><summary>{{ t('usageMonitor.text.summaryByTool') }}</summary><div class="table-scroll" role="region" :aria-label="t('usageMonitor.text.summaryByToolTable')" tabindex="0"><table class="breakdown-table"><thead><tr><th>{{ t('usageMonitor.text.tool') }}</th><th>{{ t('usageMonitor.text.requests') }}</th><th>{{ t('usageMonitor.text.inputOutput') }}</th><th>{{ t('usageMonitor.text.cacheReadWrite') }}</th><th>{{ t('usageMonitor.text.cacheHit') }}</th><th>{{ t('usageMonitor.text.usageBasedEstimate') }}</th><th>{{ t('usageMonitor.text.unestimated2') }}</th></tr></thead><tbody><tr v-for="row in analysis?.byTool ?? []" :key="row.tool"><td><button type="button" class="session-link" @click="inspectBreakdown(row.tool, null, false)">{{ toolName(row.tool) }}</button></td><td>{{ number(row.totals.requestCount) }}</td><td>{{ number(row.totals.inputTokens) }} / {{ number(row.totals.outputTokens) }}<small v-if="row.totals.incompleteRequests">{{ t('usageMonitor.text.recordedPortion') }}</small></td><td>{{ number(row.totals.cacheReadTokens) }} / {{ number(row.totals.cacheWriteTokens) }}</td><td>{{ monitorCacheRatio(row.totals) }}<small v-if="monitorCacheCoverage(row.totals)">{{ monitorCacheCoverage(row.totals) }}</small></td><td>{{ monitorTotalCost(row.totals) }}</td><td>{{ number(monitorUnquotedRequests(row.totals)) }} {{ t('usageMonitor.text.requests4') }}</td></tr><tr v-if="!analysis?.byTool.length"><td colspan="7" class="empty">{{ analysis ? t('usageMonitor.text.noSummaryInTheSelectedRange') : t('usageMonitor.text.summaryNotYetLoaded') }}</td></tr></tbody></table></div></details>
          <details class="metric-notes"><summary>{{ t('usageMonitor.text.methodPriceSources') }}</summary><p>{{ t('usageMonitor.text.inputIncludesCacheReadsAndWritesTotalTokensInput') }}</p><p>{{ t('usageMonitor.text.liveRateIsConfirmedOutputOverTheLast') }} {{ snapshot?.rateWindowSeconds ?? 60 }} {{ t('usageMonitor.text.seconds') }} {{ snapshot?.rateWindowSeconds ?? 60 }}{{ t('usageMonitor.text.readEvery') }} {{ (snapshot?.refreshMs ?? 2000) / 1000 }} {{ t('usageMonitor.text.secondsLogsMayBeWrittenLateInBatchesThis') }}</p><p>{{ t('usageMonitor.text.analysisUpdatesAboutEvery15SecondsTodayStartsAt') }}</p><p>{{ t('usageMonitor.text.amountsUseSavedOfficialPriceSnapshotsIncludingHistoricalUsage') }}</p><p>{{ t('usageMonitor.text.glmUsesZAiOfficialEquivalentPricesActualProvider') }}</p></details>
        </template>
        <div v-if="tab === 'overview' || (tab === 'sessions')" class="session-layout" :class="{ 'is-browser': (tab === 'sessions') }">
        <section v-if="tab === 'overview' || (tab === 'sessions')" class="sessions-section">
          <div class="section-bar"><h2>{{ tab === 'overview' ? t('usageMonitor.text.activeUnconfirmedSessions') : t('usageMonitor.text.periodSessionRecords') }} <span>{{ tab === 'overview' ? snapshot?.activeSessions == null ? t('usageMonitor.text.unknown') : number(snapshot.activeSessions.length) : number(historyCount) }}</span></h2><span v-if="tab === 'overview'">{{ t('usageMonitor.text.activeAndUnconfirmedSessionsOnlyFullSubagentRecordsIn') }}</span></div>
          <p v-if="(tab === 'sessions')" class="history-scope">{{ historyReady ? number(historyCount) + t('usageMonitor.text.matchingSessions') : t('usageMonitor.text.currentFilterResultsNotYetAvailable') }}</p>
          <label v-if="tab === 'overview'" class="session-sort">{{ t('usageMonitor.text.sort') }}<select v-model="sessionSort" :aria-label="t('usageMonitor.text.sessionSorting')"><option value="recent">{{ t('usageMonitor.text.recentActivity') }}</option><option value="rate60">{{ t('usageMonitor.text.60SecondRate') }}</option><option value="rate300">{{ t('usageMonitor.text.5MinuteRate') }}</option></select></label>
          <div v-if="(tab === 'sessions')" class="session-browser" role="region" :aria-label="t('usageMonitor.text.sessionSubagentList')">
            <div v-for="row in sessionTree" :key="row.session.key" class="session-browser-row" :class="{ selected: selected === row.session.key }" :style="{ '--depth': Math.min(row.depth, 5) }"><button v-if="row.childCount" type="button" class="branch-toggle" :aria-expanded="!collapsedSessions.has(row.session.key)" :aria-label="t('usageMonitor.text.expandOrCollapseSubSessionsOf') + sessionName(row.session) + t('usageMonitor.text.label6')" @click="toggleSession(row.session.key)"><ChevronRight v-if="collapsedSessions.has(row.session.key)" :size="15" /><ChevronDown v-else :size="15" /></button><GitBranch v-else-if="row.session.parentId" :size="15" class="branch-icon" /><button type="button" class="session-choice" :aria-pressed="selected === row.session.key" @click="selectSession(row.session.key, $event)"><strong>{{ sessionName(row.session) }}</strong><span>{{ toolName(row.session.tool) }} · {{ row.session.model || t('usageMonitor.text.modelNotReported') }}</span><small class="usage-state" :data-state="row.session.status">{{ status(row.session.status) }}</small><small>{{ time(row.session.updatedAtMs) }} · #{{ row.session.id.slice(0, 8) }}</small></button><button v-if="row.session.parentId" class="parent-link" :aria-label="t('usageMonitor.text.locateParentSession') + row.session.parentId" @click="findParent(row.session.tool, row.session.parentId)">{{ t('usageMonitor.text.parentSession') }}</button></div><p v-if="!sessionTree.length" class="empty">{{ analysisBusy ? t('usageMonitor.text.loadingSessions') : !historyReady ? t('usageMonitor.text.currentFilterResultsNotYetAvailable') : t('usageMonitor.text.noSessionsMatchTheCurrentFilters') }}</p>
          </div>
          <div v-else class="table-scroll" role="region" :aria-label="t('usageMonitor.text.sessionRecordsTable')" tabindex="0"><table class="sessions-table"><thead><tr><th>{{ t('usageMonitor.text.toolSession') }}</th><th>{{ t('usageMonitor.text.modelMode') }}</th><th>{{ t('usageMonitor.text.statusLastUpdate') }}</th><th>{{ t('usageMonitor.text.totalInputOutput') }}</th><th>{{ t('usageMonitor.text.60Second5MinuteAverageRate') }}</th><th>{{ t('usageMonitor.text.latestRequestCompleteTurn') }}</th><th>{{ t('usageMonitor.text.cacheHit') }}</th><th>{{ t('usageMonitor.text.usageBasedEstimate') }}</th></tr></thead><tbody>
            <tr v-for="session in sortedSessions" :key="session.key" :class="{ selected: selected === session.key }">
              <td><button class="session-link" type="button" :aria-expanded="selected === session.key" aria-controls="monitor-session-detail" @click="selectSession(session.key, $event)"><GitBranch v-if="session.parentId" :size="15" /><span>{{ sessionName(session) }}<small>{{ toolName(session.tool) }} · {{ session.id.slice(0, 12) }}</small></span></button><small v-if="session.parentId" class="parent-id">{{ t('usageMonitor.text.subSession') }} <button type="button" class="parent-link" :aria-label="t('usageMonitor.text.locateParentSession') + session.parentId" @click="findParent(session.tool, session.parentId)">{{ t('usageMonitor.text.viewParentSession') }}</button></small></td>
              <td><span class="model-name" :style="{ '--model-color': usageModelColor(session.recentRequest?.model || session.model) }">{{ session.recentRequest?.model || session.model || t('usageMonitor.text.unknownModel') }}</span><small class="mode-badge" :style="{ '--mode-color': usageModeColor(session.recentRequest ? monitorAutomaticMode(session.recentRequest).mode || 'unknown' : 'unknown') }" :title="basisLabel(session.recentRequest?.modeBasis || 'unknown')">{{ modeLabel(session) }}</small><small v-if="session.recentRequest?.modelBasis.includes('requested')">{{ t('usageMonitor.text.modelNameComesFromThisRequest') }}</small></td>
              <td><span class="usage-state" :data-state="session.status">{{ status(session.status) }}</span><small>{{ time(session.updatedAtMs) }}</small><small v-if="session.turnTiming">{{ t('usageMonitor.text.currentTurnElapsed') }} {{ turnElapsed(session) }}</small></td>
              <td>{{ compactNumber(monitorKnownTokenTotal(session.totals, 'inputTokens')) }} / {{ compactNumber(monitorKnownTokenTotal(session.totals, 'outputTokens')) }}<small v-if="session.totals.unitemizedRecords">{{ monitorRequestCountLabel(session.totals) }}</small><small v-if="session.totals.incompleteRequests">{{ t('usageMonitor.text.knownSubtotal') }} {{ session.totals.incompleteRequests }} {{ t('usageMonitor.text.incomplete') }}</small></td>
              <td>{{ sessionRate(session.key, 60) }} / {{ sessionRate(session.key, 300) }}<small>{{ t('usageMonitor.text.tokensS2') }} {{ sessionRatePartial(session.key) ? t('usageMonitor.text.partialSampling2') : t('usageMonitor.text.sameTimeWindow') }}</small></td>
              <td class="speed-cell"><strong>{{ session.requestSpeed?.latest ? requestAverage(session) : completedTurnRate(session) }}</strong><small>{{ session.requestSpeed?.latest ? t('usageMonitor.text.latestValidRequestAverage') : t('usageMonitor.text.latestCompleteTurnIncludesThinkingAndToolWaits') }}</small><small v-if="!session.requestSpeed?.latest && session.latestCompletedTurn">{{ t('usageMonitor.text.output') }} {{ compactNumber(session.latestCompletedTurn.outputTokens) }} / {{ duration(session.latestCompletedTurn.timing.durationMs) }}</small><details><summary>{{ t('usageMonitor.text.requestTimingDetails') }}</summary><small>{{ requestAverage(session) }}</small><small>{{ t('usageMonitor.text.last10') }} {{ requestWeighted(session) }} {{ t('usageMonitor.text.valid') }} {{ session.requestSpeed?.last10.validSamples ?? 0 }}/{{ session.requestSpeed?.last10.totalSamples ?? 0 }}</small><small v-if="session.requestSpeed?.latest?.ttftMs != null">{{ t('usageMonitor.text.requestFirstOutput') }} {{ duration(session.requestSpeed.latest.ttftMs) }}</small></details></td>
              <td>{{ monitorCacheRatio(session.totals) }}<small>{{ monitorCacheCoverage(session.totals) }}</small></td>
              <td class="session-prices" :title="costBasis(session.totals)"><strong>{{ conciseCost(session.totals) }}</strong><button v-if="monitorUnquotedRequests(session.totals)" class="unpriced-link" :aria-label="t('usageMonitor.text.viewUnestimatedSessions2') + session.id" @click="showUnpricedSessions(session.tool, session.id)">{{ monitorUnquotedRequests(session.totals) }} {{ t('usageMonitor.text.unestimated') }}</button></td>
            </tr>
            <tr v-if="!visibleSessions.length"><td colspan="8" class="empty">{{ snapshot?.activeSessions == null ? t('usageMonitor.text.theCurrentCollectorDoesNotProvideAGlobalActivity') : t('usageMonitor.text.noConfirmedActiveOrUnconfirmedSessionsCurrently') }}</td></tr>
          </tbody></table></div>
          <div v-if="(tab === 'sessions')" class="pagination"><span>{{ t('usageMonitor.text.page') }} {{ Math.floor(offset / MONITOR_PAGE_SIZE) + 1 }} {{ t('usageMonitor.text.perPage') }} {{ MONITOR_PAGE_SIZE }} {{ t('usageMonitor.text.records') }}</span><button class="icon-button" type="button" :title="t('usageMonitor.text.previousSessionPage')" :aria-label="t('usageMonitor.text.previousSessionPage')" :disabled="offset === 0" @click="offset -= MONITOR_PAGE_SIZE"><ChevronLeft :size="17" /></button><button class="icon-button" type="button" :title="t('usageMonitor.text.nextSessionPage')" :aria-label="t('usageMonitor.text.nextSessionPage')" :disabled="!historyReady || !analysis || offset + MONITOR_PAGE_SIZE >= analysis.sessionCount" @click="offset += MONITOR_PAGE_SIZE"><ChevronRight :size="17" /></button></div>
        </section>
        <div v-if="(tab === 'sessions') && !selected" class="session-placeholder"><MessageSquare :size="36" /><h2>{{ t('usageMonitor.text.noSessionSelected') }}</h2><span>{{ number(historyCount) }} {{ t('usageMonitor.text.matchingSessions2') }}</span></div>
        <section v-if="selected && detailAll === (tab === 'overview')" id="monitor-session-detail" ref="detailSection" class="detail-section" :aria-label="t('usageMonitor.text.selectedSessionDetails')" tabindex="-1">
          <div class="section-bar"><div><h2>{{ detail ? sessionName(detail.session) : t('usageMonitor.text.sessionTurnsRequests') }}</h2><p class="detail-id"><template v-if="detail">{{ toolName(detail.session.tool) }} <span class="session-kind">{{ detail.session.parentId ? t('usageMonitor.text.subSessions') : t('usageMonitor.text.mainSession') }}</span> {{ t('usageMonitor.text.latestModelInThisSession') }} {{ detail.session.model || t('usageMonitor.text.notRecorded') }}</template><template v-else>{{ t('usageMonitor.text.loadingSessions') }}</template></p></div><div class="detail-actions"><label class="unpriced-filter"><input v-model="includeDescendants" type="checkbox" :aria-label="t('usageMonitor.text.includeSubagents')" />{{ t('usageMonitor.text.includeSubagents') }}</label><label class="unpriced-filter"><input v-model="requestUnpricedOnly" type="checkbox" :aria-label="t('usageMonitor.text.unestimatedOnly')" />{{ t('usageMonitor.text.unestimatedOnly') }}</label><button type="button" class="icon-button" :title="t('usageMonitor.text.closeSessionDetails')" :aria-label="t('usageMonitor.text.closeSessionDetails')" @click="closeSession"><X :size="16" /></button></div></div>
          <p v-if="detailError" class="notice error" role="alert">{{ detailError }} {{ t('usageMonitor.text.displayedDetailsMayBeStale') }}</p><p v-if="detailBusy" class="page-note" role="status">{{ t('usageMonitor.text.loadingRequestPage') }}</p>
          <p class="page-note detail-scope">{{ detailAll ? t('usageMonitor.text.allSavedTurnsModels') : t('usageMonitor.text.selectedTimeModel') }} · {{ familyDetail ? t('usageMonitor.text.thisSessionSubagents') : t('usageMonitor.text.thisSessionOnly') }} {{ monitorRequestCountLabel(detail?.filteredTotals) }} · {{ t('usageMonitor.text.filteredUsageRecords') }} {{ detailPageReady ? number(detail?.requestCount) : t('usageMonitor.text.unknown') }} · {{ t('usageMonitor.text.ownUsageTotal') }} {{ monitorRequestCountLabel(detail?.session.totals) }}</p><p v-if="detail" class="detail-cost" :title="costBasis(detailTotals)">{{ t('usageMonitor.text.usageBasedEstimateInCurrentRange') }} <strong>{{ conciseCost(detailTotals) }}</strong><span v-if="detailTotals && monitorUnquotedRequests(detailTotals)">{{ number(monitorUnquotedRequests(detailTotals)) }} {{ t('usageMonitor.text.requestsNotYetIncluded') }}</span></p>
          <p v-if="detailTotals?.unitemizedRecords" class="page-note">{{ monitorRequestCountLabel(detailTotals) }}</p>
          <section v-if="detail" class="session-summary" :aria-label="t('usageMonitor.text.selectedSessionUsageSummary')">
            <div><span>{{ t('usageMonitor.text.inputTokens') }}</span><strong>{{ compactNumber(monitorKnownTokenTotal(detailTotals, 'inputTokens')) }}</strong><small>{{ t('usageMonitor.text.includesCacheReads') }}</small></div>
            <div><span>{{ t('usageMonitor.text.outputTokens') }}</span><strong>{{ compactNumber(monitorKnownTokenTotal(detailTotals, 'outputTokens')) }}</strong><small>{{ t('usageMonitor.text.includesRecordedReasoningUsage') }}</small></div>
            <div><span>{{ t('usageMonitor.text.cacheHit') }}</span><strong>{{ monitorCacheRatio(detailTotals) }}</strong><small>{{ monitorCacheCoverage(detailTotals) || t('usageMonitor.text.cacheReadsInput') }}</small></div>
            <div><span>{{ t(detailTotals?.unitemizedRecords ? 'usageMonitor.text.usageRecords' : 'usageMonitor.text.requests') }}</span><strong>{{ number(detailTotals?.requestCount) }}</strong><small>{{ detailTotals?.unitemizedRecords ? monitorRequestCountLabel(detailTotals) : detail.filteredTotals ? t('usageMonitor.text.currentTimeModelRange') : t('usageMonitor.text.sessionTotal') }}</small></div>
            <div><span>{{ t('usageMonitor.text.turns') }}</span><strong>{{ detail.turns ? number(detail.turns.length) : t('usageMonitor.text.unknown') }}</strong><small>{{ detailTotals?.incompleteRequests ? t('usageMonitor.text.usageIncludesIncompleteRecords') : t('usageMonitor.text.independentOfSingleTurnAndQuoteHintFilters') }}</small></div>
          </section>

          <details v-if="childMembers.length" :key="detail?.session.key" class="family-members" open>
            <summary><GitBranch :size="15" />{{ t('usageMonitor.text.subagentRecords') }} <span>{{ childMembers.length }} {{ t('usageMonitor.text.subagents') }}</span><small>{{ t('usageMonitor.text.includesEndedSessions') }}</small><ChevronRight :size="15" class="family-expand" /></summary>
            <p class="page-note">{{ t('usageMonitor.text.numbersBelowAreEachSessionSOwnTotalsThe') }}{{ familyDetail ? t('usageMonitor.text.includesSubagentsCountingEachRequestOnce') : t('usageMonitor.text.countsThisSessionOnly') }}{{ t('usageMonitor.text.label2') }}</p>
            <div class="family-member-scroll table-scroll" role="region" :aria-label="t('usageMonitor.text.thisSessionAllSubagents')" tabindex="0">
              <table class="family-table"><thead><tr><th>{{ t('usageMonitor.text.sessionSource') }}</th><th>{{ t('usageMonitor.text.latestModel') }}</th><th>{{ t('usageMonitor.text.status') }}</th><th>{{ t(detailTotals?.unitemizedRecords ? 'usageMonitor.text.ownUsageTotal' : 'usageMonitor.text.ownRequestTotal') }}</th><th>{{ t('usageMonitor.text.ownInputOutput') }}</th></tr></thead><tbody>
                <tr v-for="member in detailMembers" :key="member.key" :class="{ 'is-root': member.key === detail?.session.key }">
                  <td><span v-if="member.key === detail?.session.key" class="family-root-label">{{ t('usageMonitor.text.thisSession') }}</span><button v-else type="button" class="parent-link family-link" :aria-label="t('usageMonitor.text.viewSubagent') + member.id" @click="selectSession(member.key, $event)">{{ sessionName(member) }}</button><small>{{ member.id.slice(0, 12) }}<template v-if="member.parentId && member.parentId !== detail?.session.id"> {{ t('usageMonitor.text.nestedSubagents') }}</template></small></td>
                  <td><span class="model-name" :style="{ '--model-color': usageModelColor(member.model) }">{{ member.model || t('usageMonitor.text.modelNotRecorded2') }}</span></td>
                  <td><span class="usage-state" :data-state="member.status">{{ status(member.status) }}</span></td>
                  <td>{{ member.totals.unitemizedRecords ? monitorRequestCountLabel(member.totals) : number(member.totals.requestCount) }}</td><td><span class="token-input">{{ compactNumber(monitorKnownTokenTotal(member.totals, 'inputTokens')) }}</span> / <span class="token-output">{{ compactNumber(monitorKnownTokenTotal(member.totals, 'outputTokens')) }}</span></td>
                </tr>
              </tbody></table>
            </div>
          </details>
          <p v-if="familyDetail && detail?.unlinkedChildRequests" class="notice unlinked-children">{{ number(detail.unlinkedChildRequests) }} {{ t('usageMonitor.text.subagentRequestsHaveNoMatchingParentTurnIncludedIn') }}<button type="button" class="parent-link" @click="selectTurn(null)">{{ t('usageMonitor.text.viewAllTurns') }}</button></p>
          <details v-if="detail" class="record-evidence session-identifiers"><summary>{{ t('usageMonitor.text.fullIdentifiersSource') }}</summary><UsageRecordId :key="detail.session.key" :label="t('usageMonitor.text.sessionId')" :value="detail.session.id" /><UsageRecordId v-if="detail.session.parentId" :key="detail.session.parentId" :label="t('usageMonitor.text.parentSessionId')" :value="detail.session.parentId" /><p v-if="detail.session.project">{{ t('usageMonitor.text.project') }}{{ detail.session.project }}</p><button v-if="detail.session.parentId" type="button" class="parent-link" @click="selectSession(`${detail.session.tool}:${detail.session.parentId}`, $event)">{{ t('usageMonitor.text.viewParentSessionDetails') }}</button></details>
          <div v-if="detail" class="turn-performance"><p v-if="familyDetail && childMembers.length" class="page-note own-timing-note">{{ t('usageMonitor.text.timingsBelowApplyOnlyToTheSelectedSessionSubagent') }}</p>
            <div class="timing-strip"><div><span>{{ t('usageMonitor.text.currentTurn') }}</span><strong>{{ detail.session.turnTiming?.startedAtMs && !detail.session.turnTiming.completedAtMs ? t('usageMonitor.text.inProgress') + turnElapsed(detail.session) : status(detail.session.status) }}</strong><small>{{ detail.session.turnTiming?.startedAtMs ? time(detail.session.turnTiming.startedAtMs) : t('usageMonitor.text.turnStartEventNotYetRecorded') }}</small></div><div><span>{{ selectedTurn ? t('usageMonitor.text.selectedTurnDuration') : t('usageMonitor.text.latestCompleteTurnDuration') }}</span><strong>{{ displayedTurnTiming?.completedAtMs ? duration(displayedTurnTiming.durationMs) : displayedTurnTiming?.startedAtMs ? t('usageMonitor.text.thisTurnHasNotEnded') : t('usageMonitor.text.noCompleteTimingSample') }}</strong><small v-if="displayedTurnTiming?.completedAtMs">{{ t('usageMonitor.text.ended') }} {{ time(displayedTurnTiming.completedAtMs) }}</small></div><div><span>{{ t('usageMonitor.text.wholeTurnAverageOutput') }}</span><strong :class="{ 'unknown-value': displayedTurnRate == null }">{{ displayedTurnRate == null ? t('usageMonitor.text.waitingForACompleteSample') : displayedTurnRate.toFixed(1) + t('usageMonitor.text.tokensS3') }}</strong><small>{{ t('usageMonitor.text.includesThinkingToolsAndWaitsNotInstantaneousGenerationSpeed') }}</small></div><div><span>{{ t('usageMonitor.text.firstOutputWaitThisTurn') }}</span><strong>{{ duration(displayedTurnTiming?.ttftMs) }}</strong><small>{{ t('usageMonitor.text.fromTurnStartToTheFirstOutputRecord') }}</small></div></div>
            <div v-if="firstOutputShare != null" class="turn-duration-chart" role="img" :aria-label="t('usageMonitor.text.firstOutputAfterWholeTurn', { value0: duration(displayedTurnTiming?.ttftMs), value1: duration(displayedTurnTiming?.durationMs) })"><div class="duration-track"><i :style="{ width: firstOutputShare + '%' }" /><i :style="{ width: 100 - firstOutputShare + '%' }" /></div><div class="duration-legend"><span><i />{{ t('usageMonitor.text.beforeFirstOutput') }} {{ duration(displayedTurnTiming?.ttftMs) }}</span><span><i />{{ t('usageMonitor.text.afterFirstOutputUntilTurnEnd') }} {{ duration(displayedTurnTiming!.durationMs! - displayedTurnTiming!.ttftMs!) }}</span></div></div>
            <details class="request-speed-details"><summary>{{ t('usageMonitor.text.perRequestSpeedLast10Average') }}</summary><div><span>{{ t('usageMonitor.text.latestValidRequest') }} <b>{{ requestAverage(detail.session) }}</b></span><span>{{ t('usageMonitor.text.last10WeightedAverage') }} <b>{{ requestWeighted(detail.session) }}</b></span></div><p>{{ t('usageMonitor.text.valid2') }} {{ detail.session.requestSpeed?.last10.validSamples ?? 0 }} / {{ detail.session.requestSpeed?.last10.totalSamples ?? 0 }} {{ t('usageMonitor.text.requestsUsesOnlyRequestStartToEndDurationsExplicitly') }}</p></details>
          </div>
          <div class="detail-workspace">
            <UsageTurnTimeline :turns="turns" :selected="selectedTurn" :loading="detailBusy" @select="selectTurn" />
            <div class="request-workspace">
              <div v-if="turn" class="turn-group"><h3>{{ t('usageMonitor.text.selectedTurnUsage') }}</h3><p class="page-note">{{ t('usageMonitor.text.selectedTurn') }}{{ detailAll ? t('usageMonitor.text.allSavedRecords') : t('usageMonitor.text.withinSelectedWindowModel') }}{{ familyDetail ? t('usageMonitor.text.includingLinkedSubagents') : '' }}{{ t('usageMonitor.text.independentOfTheUnestimatedFilter') }}{{ monitorRequestCountLabel(turn.totals) }} · {{ t('usageMonitor.text.input') }} {{ number(monitorKnownTokenTotal(turn.totals, 'inputTokens')) }} {{ t('usageMonitor.text.output2') }} {{ number(monitorKnownTokenTotal(turn.totals, 'outputTokens')) }} {{ t('usageMonitor.text.total') }} {{ number(monitorKnownTokenTotal(turn.totals, 'totalTokens')) }} {{ t('usageMonitor.text.cacheRead3') }} {{ number(monitorKnownTokenTotal(turn.totals, 'cacheReadTokens')) }} {{ t('usageMonitor.text.write3') }} {{ number(monitorKnownTokenTotal(turn.totals, 'cacheWriteTokens')) }} {{ t('usageMonitor.text.hit') }} {{ monitorCacheRatio(turn.totals) }}<small v-if="monitorCacheCoverage(turn.totals)">{{ monitorCacheCoverage(turn.totals) }}</small> {{ t('usageMonitor.text.usageBasedEstimate2') }} {{ monitorTotalCost(turn.totals) }} · {{ monitorUnquotedRequests(turn.totals) }} {{ t('usageMonitor.text.unestimatedRequests') }}{{ turn.totals.incompleteRequests ? t('usageMonitor.text.recordedUsageOnly') : '' }}</p><details class="record-evidence"><summary>{{ t('usageMonitor.text.turnIdentifier') }}</summary><UsageRecordId :key="turn.id" :label="t('usageMonitor.text.turnId')" :value="turn.id || t('usageMonitor.text.notRecorded')" /></details></div>
              <UsageRequestPulse :requests="pageRequests" :selected="selectedRequest" @select="selectRequest" />
              <div class="table-scroll request-scroll" role="region" :aria-label="t('usageMonitor.text.requestRecordsTable')" tabindex="0"><table class="requests-table"><thead><tr><th>{{ t('usageMonitor.text.requestSource') }}</th><th>{{ t('usageMonitor.text.modelAutoDetectedMode') }}</th><th>{{ t('usageMonitor.text.inputOutput') }}</th><th>{{ t('usageMonitor.text.cacheReadWrite') }}</th><th>{{ t('usageMonitor.text.pricingStatus') }}</th></tr></thead><tbody><tr v-for="(item, index) in pageRequests" :key="item.id" :class="{ selected: selectedRequest === item.id }"><td><button type="button" class="session-link" :aria-label="t('usageMonitor.text.viewRequest', { value0: item.id })" :aria-pressed="selectedRequest === item.id" @click="selectRequest(item.id, $event)">{{ t('usageMonitor.text.requests') }} {{ requestOffset + index + 1 }}</button><small>{{ requestRecordedTime(item) }}</small><small class="request-source" :class="{ child: item.sessionId !== detail?.session.id }" :title="requestSourceTitle(item)"><GitBranch v-if="item.sessionId !== detail?.session.id" :size="12" />{{ requestSource(item) }}</small></td><td><span class="model-name" :style="{ '--model-color': usageModelColor(item.model) }">{{ item.model || t('usageMonitor.text.unknownModel') }}</span><small class="mode-badge" :style="{ '--mode-color': usageModeColor(monitorAutomaticMode(item).mode || 'unknown') }">{{ requestModeLabel(item) }}</small></td><td>{{ number(monitorToken(item, 'input_tokens')) }} / {{ number(monitorToken(item, 'output_tokens')) }}</td><td>{{ number(monitorToken(item, 'cache_read_tokens')) }} / {{ number(monitorToken(item, 'cache_write_tokens')) }}</td><td>{{ quoteState(item) }}<small v-if="item.unknownFields.length">{{ t('usageMonitor.text.recordedUsageOnly2') }}</small></td></tr><tr v-if="!pageRequests.length"><td colspan="5" class="empty">{{ detailBusy ? t('usageMonitor.text.loadingRequestPage') : !detailPageReady || detailError ? t('usageMonitor.text.currentRequestPageNotYetAvailable') : t('usageMonitor.text.noRequestsMatchTheCurrentCriteria') }}</td></tr></tbody></table></div>
              <div class="pagination"><span>{{ t('usageMonitor.text.requestPage') }} {{ Math.floor(requestOffset / MONITOR_PAGE_SIZE) + 1 }} {{ t('usageMonitor.text.label7') }} {{ detailPageReady ? number(detail?.requestCount) : t('usageMonitor.text.unknown') }} {{ t(detailTotals?.unitemizedRecords ? 'usageMonitor.text.matchingUsageRecords' : 'usageMonitor.text.matchingRequests') }}</span><button class="icon-button" type="button" :title="t('usageMonitor.text.previousRequestPage')" :aria-label="t('usageMonitor.text.previousRequestPage')" :disabled="requestOffset === 0" @click="requestOffset -= MONITOR_PAGE_SIZE"><ChevronLeft :size="17" /></button><button class="icon-button" type="button" :title="t('usageMonitor.text.nextRequestPage')" :aria-label="t('usageMonitor.text.nextRequestPage')" :disabled="!detailPageReady || !detail || requestOffset + MONITOR_PAGE_SIZE >= detail.requestCount" @click="requestOffset += MONITOR_PAGE_SIZE"><ChevronRight :size="17" /></button></div>
            </div>
          </div>
          <article v-if="request" ref="requestSection" class="request-detail" :aria-label="t('usageMonitor.text.selectedRequestPricingUsageEvidence')" tabindex="-1"><div class="section-bar"><h3>{{ t('usageMonitor.text.requestDetails') }}</h3><div class="detail-actions"><span>{{ requestRecordedTime(request) }}</span><button type="button" class="icon-button" :title="t('usageMonitor.text.closeRequestEvidence')" :aria-label="t('usageMonitor.text.closeRequestEvidence')" @click="closeRequest"><X :size="16" /></button></div></div><p class="page-note"><span class="request-source" :title="requestSourceTitle(request)">{{ requestSource(request) }}</span> · {{ request.model || t('usageMonitor.text.unknownModel') }} · {{ requestModeLabel(request) }} {{ t('usageMonitor.text.input2') }} {{ number(monitorToken(request, 'input_tokens')) }} {{ t('usageMonitor.text.output2') }} {{ number(monitorToken(request, 'output_tokens')) }} · {{ quoteState(request) }}</p>
            <div class="request-proof-layout">
              <section class="request-price-panel" :aria-label="t('usageMonitor.text.pricingEvidenceForThisRequest')"><h4>{{ t('usageMonitor.text.referenceEstimate') }}</h4>
                <div v-for="quote in automaticRequest?.quotes ?? []" :key="quote.currency" class="selected-price-evidence">
                  <strong class="proof-amount">{{ monitorAmount(quote.amount, quote.currency) }}</strong><span class="mode-badge" :style="{ '--mode-color': usageModeColor(automaticRequest?.mode || 'unknown') }">{{ requestModeLabel(request) }}</span>
                  <template v-if="quote.evidence">
                    <p>{{ t('usageMonitor.text.referenceQuoteProvider') }}{{ quote.evidence.pricingBasis === 'sub2api_reference' ? pricingProvider(quote.evidence) : quote.evidence.pricingProvider || t('usageMonitor.text.sourceUnspecified') }}</p>
                    <p v-if="quote.evidence.pricingBasis === 'upstream_recorded'">{{ t('usageMonitor.text.upstreamCharge') }}</p>
                    <template v-else>
                      <dl class="request-rates"><div><dt>{{ t('usageMonitor.text.uncachedInput') }}</dt><dd>{{ quote.evidence.inputPerMillion }}</dd></div><div><dt>{{ t('usageMonitor.text.cacheRead') }}</dt><dd>{{ quote.evidence.cachedPerMillion ?? t('usageMonitor.text.notProvided') }}</dd></div><div><dt>{{ t('usageMonitor.text.output') }}</dt><dd>{{ quote.evidence.outputPerMillion }}</dd></div></dl>
                      <small>{{ currencyName(quote.currency) }} {{ t('usageMonitor.text.millionTokens2') }} {{ displayContext(quote.evidence.contextTier) }}<template v-if="quote.evidence.pricingBasis === 'sub2api_reference'"> · {{ t('usageMonitor.text.currentReferencePriceNotHistoricalBill') }} {{ t('usageMonitor.text.priceChecked') }} {{ quote.evidence.checkedAt }}</template></small>
                    </template>
                    <a v-if="priceLink(quote.evidence.sourceUrl)" :href="priceLink(quote.evidence.sourceUrl)" target="_blank" rel="noopener noreferrer">{{ t('usageMonitor.text.viewPriceSource') }}<ExternalLink :size="13" /></a>
                  </template>
                </div>
                <p v-if="!automaticRequest?.quotes.length" class="proof-pending">{{ quoteState(request) }}</p><p class="page-note">{{ t('usageMonitor.text.estimatedUsingSavedModelModeAndUnitPricesNot') }}</p>
              </section>
              <section class="request-original-evidence" :aria-label="t('usageMonitor.text.originalCollectionEvidence')"><h4>{{ t('usageMonitor.text.originalCollectionEvidence') }}</h4><dl class="source-facts"><div><dt>{{ t(request.unknownFields.includes('timestamp') || monitorIsUnitemizedRecord(request) ? 'usageMonitor.text.collectionObservedTime' : 'usageMonitor.text.recordTime') }}</dt><dd>{{ time(request.timestampMs) }}</dd></div><div><dt>{{ t('usageMonitor.text.usageSource') }}</dt><dd>{{ basisLabel(request.usageBasis) }}</dd></div><div><dt>{{ t('usageMonitor.text.modeEvidence') }}</dt><dd>{{ requestModeLabel(request) }}</dd></div></dl><p v-if="request.unknownFields.length" class="unpriced">{{ request.unknownFields.length }} {{ t('usageMonitor.text.fieldsNotReportedRecordedPortionOnly') }}</p>
            <details class="record-evidence"><summary>{{ t('usageMonitor.text.fullRequestIdentifierCollectionEvidence') }}</summary><UsageRecordId :key="request.id" :label="t('usageMonitor.text.requestId')" :value="request.requestId || request.id" /><UsageRecordId :key="request.sessionId" :label="t('usageMonitor.text.sessionId')" :value="request.sessionId" /><UsageRecordId v-if="request.turnId" :key="'native:' + request.turnId" :label="t('usageMonitor.text.originalTurnId')" :value="request.turnId" /><UsageRecordId v-if="request.rootTurnId && request.rootTurnId !== request.turnId" :key="'root:' + request.rootTurnId" :label="t('usageMonitor.text.linkedParentTurnId')" :value="request.rootTurnId" /><dl class="request-facts"><div><dt>{{ t('usageMonitor.text.modelModeInformationFrom') }}</dt><dd>{{ basisLabel(request.modelBasis) }} / {{ basisLabel(request.modeBasis) }}</dd></div><div><dt>{{ t('usageMonitor.text.usageInformationFrom') }}</dt><dd>{{ basisLabel(request.usageBasis) }}</dd></div><div><dt>{{ t('usageMonitor.text.cacheReadWrite') }}</dt><dd>{{ number(monitorToken(request, 'cache_read_tokens')) }} / {{ number(monitorToken(request, 'cache_write_tokens')) }}</dd></div><div><dt>{{ t('usageMonitor.text.reasoningContextTokens') }}</dt><dd>{{ number(request.reasoningTokens) }} / {{ number(request.contextTokens) }}</dd></div><div><dt>{{ t('usageMonitor.text.fullRequestDurationAverageSpeed') }}</dt><dd>{{ duration(request.requestTiming?.durationMs) }} / {{ request.requestTiming?.durationMs != null && request.requestTiming.durationMs > 0 && monitorToken(request, 'output_tokens') != null ? t('usageMonitor.text.tokensS', { value0: (request.outputTokens / (request.requestTiming!.durationMs! / 1000)).toFixed(2) }) : t('usageMonitor.text.unknown') }}</dd></div></dl></details>
              </section>
            </div>
            <UsageTokenComposition :input-tokens="monitorToken(request, 'input_tokens')" :output-tokens="monitorToken(request, 'output_tokens')" :cache-read-tokens="monitorToken(request, 'cache_read_tokens')" :partial="!!request.unknownFields.length" />
            <details class="record-evidence request-notes"><summary>{{ t('usageMonitor.text.pricingNotesRecordCompleteness') }}</summary>
            <p v-if="request.requestTiming" class="page-note">{{ t('usageMonitor.text.requestFirstOutputLatency') }} {{ duration(request.requestTiming.ttftMs) }} {{ t('usageMonitor.text.streamingPhase') }} {{ duration(request.requestTiming.streamingDurationMs) }} {{ t('usageMonitor.text.source') }} {{ request.requestTiming.basis }}</p>
            <p v-else-if="request.durationMs != null" class="page-note">{{ t('usageMonitor.text.logsAlsoContainADurationOf') }} {{ duration(request.durationMs) }}{{ t('usageMonitor.text.scopeUnconfirmedNotUsedForPerRequestSpeed') }}</p>
            <p v-if="request.cost.reason" class="unpriced">{{ pricingReason(request.cost.reason, request.model ?? request.requestedModel) }}</p>
            <p class="page-note">{{ automaticRequest?.basis === 'response_reported' ? t('usageMonitor.text.modeComesFromTheServiceResponse') : automaticRequest?.basis === 'runtime_mode' ? t('usageMonitor.text.modeComesFromCodexRuntimeLogsMatchedExactlyTo') : automaticRequest?.basis === 'requested_mode' ? t('usageMonitor.text.modeComesFromSavedClientSettingsForThisRequest') : t('usageMonitor.text.noTrustworthyModeRecordThisReferenceAmountIsExcluded') }}</p>
            <p class="page-note">{{ t('usageMonitor.text.requestedModel') }} {{ request.requestedModel || t('usageMonitor.text.unknown') }} {{ t('usageMonitor.text.modeInTheSessionFile') }} {{ request.requestedMode ? monitorMode(request.requestedMode) : t('usageMonitor.text.notRecorded') }}{{ t('usageMonitor.text.requestSettingsDoNotNecessarilyMatchTheModeActually') }}</p>
            <p v-if="request.runtimeMode" class="page-note">{{ t('usageMonitor.text.runtimeLogs2') }}{{ request.runtimeMode.conflicted ? t('usageMonitor.text.conflictingModeRecordsInTheSameTurnNotUsed') : request.runtimeMode.mode ? monitorMode(request.runtimeMode.mode) : t('usageMonitor.text.modeNotRecorded2') }} {{ t('usageMonitor.text.recordTime2') }} {{ time(request.runtimeMode.observedAtMs) }} {{ t('usageMonitor.text.matchedExactlyToThisSessionAndTurn') }}</p>
            <p v-if="request.unknownFields.length" class="unpriced">{{ t('usageMonitor.text.stillMissing') }}{{ request.unknownFields.map(missingFieldLabel).join(t('usageMonitor.text.label3')) }}{{ t('usageMonitor.text.onlyRecordedTokensAreCountedAbove') }}</p>
            <p v-if="automaticRequest?.basis === 'unknown' && request.unknownFields.includes('requested_mode_ambiguous')" class="page-note">{{ t('usageMonitor.text.modeChangedDuringThisTurnTheModeForThis') }}</p>
            </details>
            <details class="alternative-price-evidence"><summary>{{ t('usageMonitor.text.allOriginalPriceComparisonsNotAddedToThisRequest') }}</summary>
            <div v-for="option in pricingOptions(request.cost)" :key="`${option.label}:${option.evidence.version}`" class="price-evidence">
              <h4>{{ option.label }} · {{ option.amount == null ? t('usageMonitor.text.amountUnknown') : monitorAmount(option.amount, option.evidence.currency ?? 'USD') }}</h4>
              <p>{{ t('usageMonitor.text.calculationEvidence') }} {{ option.evidence.version }} · {{ pricingProvider(option.evidence) }}<template v-if="option.evidence.pricingBasis === 'sub2api_reference'"> · {{ t('usageMonitor.text.currentReferencePriceNotHistoricalBill') }}</template></p>
              <p>{{ option.evidence.model }} / {{ monitorMode(option.evidence.mode) }} / {{ displayContext(option.evidence.contextTier) }} {{ t('usageMonitor.text.priceChecked') }} {{ option.evidence.checkedAt }}</p>
              <p v-if="option.evidence.catalogRevision">{{ t('usageMonitor.text.catalog') }} {{ option.evidence.catalogRevision }} {{ t('usageMonitor.text.rules') }} {{ option.evidence.ruleVersion }}<template v-if="option.evidence.timeBand"> · {{ option.evidence.timeBand === 'peak' ? t('usageMonitor.text.peak') : t('usageMonitor.text.offPeak') }}</template></p>
              <p v-if="option.evidence.pricingBasis !== 'upstream_recorded'">{{ option.evidence.currency === 'CNY' ? t('usageMonitor.text.cny') : t('usageMonitor.text.usd') }} {{ t('usageMonitor.text.millionTokensInput') }} {{ option.evidence.inputPerMillion }} {{ t('usageMonitor.text.cacheRead3') }} {{ option.evidence.cachedPerMillion ?? t('usageMonitor.text.unknown') }} · <template v-if="option.evidence.cacheWritePerMillion != null">{{ t('usageMonitor.text.cacheWrite') }} {{ option.evidence.cacheWritePerMillion }}</template><template v-else>{{ t('usageMonitor.text.cacheWrite5Minutes') }} {{ option.evidence.cacheWrite5mPerMillion ?? t('usageMonitor.text.unknown') }} {{ t('usageMonitor.text.1Hour') }} {{ option.evidence.cacheWrite1hPerMillion ?? t('usageMonitor.text.unknown') }}</template> {{ t('usageMonitor.text.output3') }} {{ option.evidence.outputPerMillion }}</p>
              <p v-if="option.evidence.excludedComponents?.length" class="excluded-components">{{ t('usageMonitor.text.amountsAboveExclude') }}{{ option.evidence.excludedComponents.map(excludedComponent).join(t('usageMonitor.text.label3')) }}</p>
              <a v-if="priceLink(option.evidence.sourceUrl)" :href="priceLink(option.evidence.sourceUrl)" target="_blank" rel="noopener noreferrer">{{ t('usageMonitor.text.viewPriceSource') }}</a><span v-else>{{ option.evidence.sourceUrl }}</span>
              <p v-for="source in option.evidence.ruleSources ?? []" :key="source"><a v-if="priceLink(source)" :href="priceLink(source)" target="_blank" rel="noopener noreferrer">{{ t(option.evidence.pricingBasis === 'sub2api_reference' ? 'usageMonitor.text.viewSub2apiPricingRules' : 'usageMonitor.text.viewOfficialSupplementaryNotes') }}</a><span v-else>{{ source }}</span></p>
            </div>
            </details>
          </article>
        </section>
        </div>
        <section v-if="tab === 'sources'" class="sources-section">
          <p class="page-note">{{ t('usageMonitor.text.collectionContinuesInTheTrayClosingThisPageDoes') }}</p>
          <section class="source-health"><div class="section-bar"><h2><Database :size="18" />{{ t('usageMonitor.text.collectionStatus') }}</h2><span>{{ t('usageMonitor.text.lastChecked') }} {{ time(snapshot?.collectedAtMs) }}</span></div>
            <div class="source-head"><span>{{ t('usageMonitor.text.tool') }}</span><span>{{ t('usageMonitor.text.collectionStatus') }}</span><span>{{ t('usageMonitor.text.usageSourceFiles') }}</span><span>{{ t('usageMonitor.text.historyRetention') }}</span><span>{{ t('usageMonitor.text.latestUsageRecord') }}</span></div>
            <details v-for="group in sourceGroups" :key="group.tool" class="source-group">
              <summary><span><PlatformIcon :platform="platform(group.tool)" size="lg" /><b>{{ toolName(group.tool) }}</b></span><span :data-tone="group.tone" :class="{ warning: group.issues || !group.usage.length }">{{ group.status }}</span><span>{{ t('usageMonitor.text.usageFileCount', { count: number(group.files) }) }}<small>{{ group.usage.length }} {{ t('usageMonitor.text.usageSources') }}<template v-if="group.rows.length > group.usage.length"> · {{ group.rows.length - group.usage.length }} {{ t('usageMonitor.text.modeSources') }}</template></small></span><span>{{ group.missing ? number(group.missing) + t('usageMonitor.text.originalPathsNoLongerExistHistoryRetained') : group.historyKnown ? t('usageMonitor.text.historicalRecordsRetained') : t('usageMonitor.text.someSourcesDoNotProvideFileStatus') }}</span><span>{{ analysis?.latestRequestAtMs[group.tool] ? time(analysis.latestRequestAtMs[group.tool]) : t('usageMonitor.text.noRecordsYet') }}<ChevronDown :size="16" /></span></summary>
              <div class="group-sources">
                <details v-for="source in group.rows" :key="source.root" class="source-entry"><summary><span>{{ source.status === 'metadata' ? t('usageMonitor.text.modeLogs') : t('usageMonitor.text.usageSource') }}<small>{{ source.root.split(/[\\/]/).filter(Boolean).at(-1) }}</small></span><span :data-tone="sourceTone(source.status, source.error)" :class="{ warning: source.error || !['watching', 'metadata'].includes(source.status) }">{{ collectionStatus(source.status) }}</span><span>{{ number(source.files) }} {{ t('usageMonitor.text.current2') }} {{ number(source.registeredFiles) }} {{ t('usageMonitor.text.registered') }}</span><span>{{ source.missingRegisteredFiles == null ? t('usageMonitor.text.originalPathStatusUnverified') : source.missingRegisteredFiles ? number(source.missingRegisteredFiles) + t('usageMonitor.text.originalPathsNoLongerExistHistoryRetained') : t('usageMonitor.text.historicalRecordsRetained') }}</span><span>{{ t('usageMonitor.text.check') }} {{ time(source.lastScanMs) }}<ChevronDown :size="14" /></span></summary><div class="source-entry-detail"><code>{{ source.root }}</code><p v-if="source.error" class="unpriced">{{ source.error }}</p><p v-else>{{ t('usageMonitor.text.deletingMovingOrRotatingOriginalFilesDoesNotDelete') }}</p></div></details>
              </div>
            </details>
            <p v-if="!snapshot?.sources.length" class="empty">{{ t('usageMonitor.text.sourceStatusUnavailableThisDoesNotMeanZeroUsage') }}</p>
          </section>
          <section class="catalog-band"><div><h2>{{ t('usageMonitor.text.modelPriceCatalog') }}</h2><a :href="catalog?.sourceUrl || 'https://models.dev'" target="_blank" rel="noopener noreferrer">models.dev <ExternalLink :size="13" /></a><span> {{ t('usageMonitor.text.officialSupplementaryRules') }}</span></div><div><Clock3 :size="18" /><span>{{ t('usageMonitor.text.lastChecked') }} {{ time(catalog?.checkedAtMs) }}<small>{{ catalog?.available ? number(catalog.modelCount) + t('usageMonitor.text.modelProviderPrices') : t('usageMonitor.text.catalogNotReady') }} {{ t('usageMonitor.text.syncedEvery24Hours') }}</small></span></div><div><span>{{ catalog?.available ? t('usageMonitor.text.cachedPreviousPricesRetainedOnSyncFailure') : t('usageMonitor.text.verifiedSupplementaryPricesRetained') }}</span><small>{{ t('usageMonitor.text.cacheUpdated') }} {{ time(catalog?.fetchedAtMs) }}</small></div><button type="button" class="catalog-sync" :aria-label="t('usageMonitor.text.syncModelPrices')" :disabled="catalogBusy || catalog?.refreshing" @click="loadCatalog(true)"><RefreshCw :size="16" :class="{ spinning: catalogBusy || catalog?.refreshing }" />{{ t('usageMonitor.text.syncPrices') }}</button><p v-if="catalogError" class="unpriced">{{ catalogError }}</p></section>
          <div class="source-price-workspace">
            <UsagePricingCoveragePanel :rows="pricingSegments" :total="periodTotals?.requestCount" :record-counts="!!periodTotals?.unitemizedRecords" :available="priceAvailablePercent" :loaded="!!periodTotals" :period="`${periodLabel} · ${tool ? toolName(tool) : t('usageMonitor.text.allTools')}`" :reasons="Object.entries(periodTotals?.unpricedReasonCounts ?? {}).map(([key,count]) => ({key,count,label:pricingReason(key)}))" :unquoted="periodTotals ? monitorUnquotedRequests(periodTotals) : 0" @reason="showPricingReason" @unquoted="showUnpricedSessions" />
            <section class="price-lookup"><div class="section-bar"><h2>{{ t('usageMonitor.text.referenceUnitPriceLookup') }}</h2><span>{{ t('usageMonitor.text.queriesTheCatalogWithoutChangingHistoricalQuotes') }}</span></div><form @submit.prevent="previewPrice" class="price-form"><label>{{ t('usageMonitor.text.model') }}<input v-model="priceModel" list="monitor-model-prices" :placeholder="t('usageMonitor.text.eGGpt61Sol')" required /><datalist id="monitor-model-prices"><option v-for="name in analysis?.availableModels ?? []" :key="name" :value="name" /></datalist></label><label>{{ t('usageMonitor.text.pricingMode') }}<select v-model="priceMode"><option value="standard">{{ t('usageMonitor.text.standard') }}</option><option value="fast">{{ t('usageMonitor.text.fast3') }}</option><option value="ultrafast">{{ t('usageMonitor.text.priority') }}</option><option value="flex">{{ monitorMode('flex') }}</option></select></label><label>{{ t('usageMonitor.text.inputContextTokens') }}<input v-model.number="priceContext" type="number" min="0" step="1" required /></label><button type="submit" class="catalog-sync" :disabled="priceBusy"><Search :size="15" />{{ priceBusy ? t('usageMonitor.text.searching') : t('usageMonitor.text.lookUpPrices') }}</button></form>
              <p v-if="priceError" class="unpriced" role="alert" :title="priceError">{{ t('usageMonitor.text.priceLookupFailed') }}</p><p v-if="pricePreview && !pricingOptions(pricePreview).length" class="unpriced">{{ pricingReason(pricePreview.reason || 'unverified_model_or_mode_price') }}</p>
              <div v-for="option in pricePreview ? pricingOptions(pricePreview) : []" :key="option.label" class="lookup-evidence"><dl class="lookup-context"><div><dt>{{ t('usageMonitor.text.model') }}</dt><dd>{{ option.evidence.model }}</dd></div><div><dt>{{ t('usageMonitor.text.quoteProviderReference') }}</dt><dd>{{ option.evidence.pricingBasis === 'sub2api_reference' ? pricingProvider(option.evidence) : option.evidence.pricingProvider || t('usageMonitor.text.sourceUnspecified') }}</dd></div><div><dt>{{ t('usageMonitor.text.pricingMode') }}</dt><dd>{{ monitorMode(option.evidence.mode) }}</dd></div><div><dt>{{ t('usageMonitor.text.currencyUnit') }}</dt><dd>{{ currencyName(option.evidence.currency || 'USD') }} {{ t('usageMonitor.text.millionTokens3') }}</dd></div></dl><p class="page-note">{{ displayContext(option.evidence.contextTier) }} {{ t('usageMonitor.text.referenceQuoteProviderIsNotNecessarilyTheActualService') }}<template v-if="option.evidence.pricingBasis === 'sub2api_reference'"> · {{ t('usageMonitor.text.currentReferencePriceNotHistoricalBill') }} {{ t('usageMonitor.text.priceChecked') }} {{ option.evidence.checkedAt }}</template></p><UsagePriceFlow :evidence="option.evidence" /><a v-if="priceLink(option.evidence.sourceUrl)" :href="priceLink(option.evidence.sourceUrl)" target="_blank" rel="noopener noreferrer">{{ t('usageMonitor.text.viewPriceSource') }}<ExternalLink :size="13" /></a><p v-if="option.evidence.excludedComponents?.length" class="page-note">{{ t('usageMonitor.text.excludes') }}{{ option.evidence.excludedComponents.map(excludedComponent).join(t('usageMonitor.text.label3')) }}</p></div>
              <p v-if="!pricePreview && !priceBusy" class="price-empty"><Info :size="17" />{{ t('usageMonitor.text.noUnitPriceLookupYet') }}</p><p class="page-note">{{ t('usageMonitor.text.catalogPricesAreReferenceOnlyActualRequestsUseTheir') }}</p>
            </section>
          </div>
          <UsageModeEvidence :rows="modeEvidence" :total="periodTotals?.requestCount" :record-counts="!!periodTotals?.unitemizedRecords" />
          <details class="metric-notes"><summary>{{ t('usageMonitor.text.collectionScopeBillingNotes') }}</summary><p>{{ t('usageMonitor.text.collectsOnlyLocallyReadableToolUsageMetadataNotChat') }}</p><p>{{ t('usageMonitor.text.usageFilesAreTotaledByPathModeLogsAre') }}</p><p>{{ t('usageMonitor.text.historicalDatesModelsDoNotRestrictLiveRatesOr') }}</p><p>{{ t('usageMonitor.text.ratesAreStatisticalAveragesOfCollectedOutputFastRequest') }}</p></details>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.monitor-finance-page{scroll-margin-top:50px;min-width:0}.finance-navigation{display:flex;align-items:center;gap:20px;flex-wrap:wrap;border-bottom:1px solid var(--cost-line);margin-bottom:16px}.finance-navigation button{display:flex;align-items:center;gap:5px;min-height:42px;border-bottom:2px solid transparent;font-size:13px;color:var(--cost-muted)}.finance-navigation button[aria-pressed=true]{color:var(--cost-lime);border-bottom-color:var(--cost-lime)}.finance-account-heading{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin:20px 0}.finance-account-heading h2{font-size:18px;font-weight:600;overflow-wrap:anywhere}.monitor-cost-command,.cost-read-error button{display:inline-flex;align-items:center;gap:6px;min-height:32px;color:var(--cost-blue);font-size:12px}.monitor-cost-command{padding:5px 9px;border:1px solid var(--cost-line);border-radius:4px}.monitor-cost-command:hover{background:var(--cost-panel)}.cost-read-error{font-size:11px;line-height:1.6;color:var(--cost-gold);margin:8px 0}.cost-read-error button{font-size:11px;margin-left:8px}.monitor-custom-period,.monitor-custom-period label{display:flex;align-items:center;gap:8px}.monitor-custom-period{flex-wrap:wrap;margin:10px 0 16px;font-size:12px;color:var(--cost-muted)}.monitor-custom-period input{padding:6px 8px;border:1px solid var(--cost-line);border-radius:4px;background:var(--cost-panel);color:var(--cost-text);font:inherit}.monitor-custom-period [role=alert]{color:var(--cost-gold)}.monitor-api-prices{scroll-margin-top:52px}
.selected-price-evidence{padding:16px 0;margin-top:12px;border-top:1px solid var(--cost-line);border-bottom:1px solid var(--cost-line)}.selected-price-evidence h4{color:var(--cost-gold);font-size:14px;margin:0 0 8px}.selected-price-evidence p{font-size:12px;color:#a3b5a8;line-height:1.8}.selected-price-evidence a{display:inline-block;font-size:11px;color:var(--cost-blue);margin-top:10px}.alternative-price-evidence{margin-top:16px;font-size:12px}.alternative-price-evidence>summary{cursor:pointer;color:#9fb6a8;padding:10px 0;line-height:1.7}

.credits-section{padding-top:14px;margin-top:8px;border-top:1px solid var(--cost-line)}.credit-account{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--cost-line)}.credit-account span{font-size:13px}.credit-account small{display:block;font-size:11px;color:#9db1a3;margin-top:6px;font-weight:400}.credit-account strong{font-size:22px;font-weight:600;color:var(--cost-blue);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}.credit-account p{grid-column:1/-1;color:#92a89a;font-size:10px;margin:4px 0}
.turn-performance{margin:16px 0 24px;border-top:1px solid var(--cost-line);border-bottom:1px solid var(--cost-line)}.turn-performance .timing-strip{border:0;margin:0;padding:20px 0}.turn-performance .timing-strip strong{color:var(--cost-text);font-variant-numeric:tabular-nums}.turn-duration-chart{padding:0 0 18px}.duration-track{display:flex;height:13px;overflow:hidden;border-radius:3px;background:#29352e;gap:2px}.duration-track i:first-child,.duration-legend span:first-child i{background:var(--usage-requests)}.duration-track i:last-child,.duration-legend span:last-child i{background:var(--usage-output)}.duration-legend{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:#a3b4a9;font-size:11px;margin-top:10px}.duration-legend span{display:flex;align-items:center;gap:7px}.duration-legend i{width:7px;height:7px;border-radius:2px}.request-speed-details{font-size:11px;color:#a4b5a9;padding:12px 0;border-top:1px solid var(--cost-line)}.request-speed-details summary,.speed-cell summary{cursor:pointer;color:var(--cost-blue);font-size:11px}.request-speed-details>div{display:flex;flex-wrap:wrap;gap:20px;margin:14px 0}.request-speed-details b{display:block;color:var(--cost-text);font-size:14px;margin-top:6px}.request-speed-details p{line-height:1.7}.speed-cell>strong{color:var(--cost-blue);font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}.speed-cell details{margin-top:8px}.session-prices>strong{color:var(--cost-gold);font-size:16px;font-variant-numeric:tabular-nums}
.weekly-section{border-bottom:1px solid var(--cost-line)}
.section-bar h2{display:flex;align-items:center;gap:9px}
.weekly-workspace{display:grid;align-items:start;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:32px;padding:8px 0 24px}
.quota-account-header{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:14px;margin-bottom:12px}.quota-account-identity{min-width:0}.quota-account-header .remaining-label{margin-bottom:0}
.weekly-value{min-width:0;padding-right:32px;border-right:1px solid var(--cost-line)}
.week-figures{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;margin:0 0 16px}
.week-figures>div+div{border-left:1px solid var(--cost-line);padding-left:22px}
.week-figures span{display:block;margin-bottom:10px;font-size:13px;color:#a5afa7}
.week-figures strong{display:block;font:650 29px/1.45 'Segoe UI Variable','Segoe UI',sans-serif;color:var(--cost-gold);overflow-wrap:anywhere}
.week-figures small{display:block;margin-top:5px;font-size:11px;color:#9eaaa0;line-height:1.6}
.week-figures>div+div strong{color:var(--cost-blue)}
.account-quota-forecast{min-width:0}.account-quota-forecast .quota-blocked{font-size:26px;color:var(--usage-warning)}
.weekly-token-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:16px 0 12px;border-top:1px solid var(--cost-line);border-bottom:1px solid var(--cost-line);padding:14px 0}
.weekly-token-strip>div{padding:0 14px;border-right:1px solid var(--cost-line);min-width:0}.weekly-token-strip>div:first-child{padding-left:0}.weekly-token-strip>div:last-child{border:0}
.weekly-token-strip dt{font-size:12px;color:#9eaaa0}.weekly-token-strip dd{margin:8px 0 0;font-size:19px;font-weight:600;overflow-wrap:anywhere}
.week-evidence{font-size:12px;line-height:1.7}.week-evidence summary,.quota-group>summary,.rate-method summary{cursor:pointer;color:#b6c0b8;padding:10px 0}.week-evidence summary:hover,.quota-group>summary:hover{color:var(--cost-text)}
.weekly-value .week-scenarios{min-width:0;margin:12px 0;font-size:11px}.week-scenarios th,.week-scenarios td{padding:8px;font-size:11px}
.weekly-value .page-note{margin-top:10px;line-height:1.7}.forecast-evidence{padding:10px 0;border-bottom:1px solid var(--cost-line)}.forecast-evidence p{font-size:11px}
.allowance-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}.allowance-heading h3{margin:0;font-size:17px}.allowance-heading>span{font-size:11px;color:var(--cost-muted)}
.allowance-overview{min-width:0;container:quota-panel / inline-size}
.allowance-detail,.allowance-item>small,.quota-source-note{color:#97a49a;font-size:11px;line-height:1.7}
.allowance-list{display:grid;grid-template-columns:minmax(0,1fr);max-height:280px;overflow:auto}
.current-quotas>.allowance-list{max-height:none;overflow:visible}
.quota-account-controls{display:flex;align-items:center;gap:8px;margin:6px 0 12px}.quota-account-controls select{flex:1;min-width:0;padding:7px 8px;border:1px solid var(--cost-line);border-radius:4px;background:var(--cost-panel);color:var(--cost-text);font-size:12px}.hidden-quota-accounts{margin:6px 0 12px;font-size:12px;color:var(--cost-muted)}.hidden-quota-accounts>summary{cursor:pointer}.hidden-quota-account{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0}
.allowance-item{min-width:0;padding:15px 0;border-bottom:1px solid var(--cost-line)}
.allowance-title{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;font-size:13px}.allowance-title>span{overflow-wrap:anywhere}
.allowance-title strong{flex:0 0 auto;color:var(--quota-color);font:650 25px/1.25 'Segoe UI',sans-serif}.allowance-title strong small{display:block;margin-top:3px;text-align:right;color:var(--cost-muted);font-size:10px;font-weight:400}
.allowance-detail{display:flex;flex-wrap:wrap;justify-content:space-between;gap:3px 10px;margin-top:9px}.allowance-item>small{display:block;overflow-wrap:anywhere}
.allowance-item meter{display:block;width:100%;height:8px;margin:12px 0;border:0;background:var(--cost-line);border-radius:3px;accent-color:var(--quota-color)}
.allowance-item meter::-webkit-meter-bar{border:0;background:var(--cost-line);border-radius:3px}.allowance-item meter::-webkit-meter-optimum-value{background:var(--quota-color)}
.allowance-item.is-stale strong{color:var(--cost-muted)}.allowance-item.is-stale meter::-webkit-meter-optimum-value{background:#6f7a71}
.quota-source-note{padding:10px 0;margin:0;border-bottom:1px solid var(--cost-line);overflow-wrap:anywhere}.quota-group>summary{font-size:12px}.quota-group>summary>span{color:var(--cost-muted);margin-left:8px}.current-quotas>summary{display:none}
@media(max-width:1000px){.weekly-workspace{grid-template-columns:minmax(0,1fr);gap:22px}.weekly-value{padding-right:0;border-right:0;padding-bottom:18px;border-bottom:1px solid var(--cost-line)}}
@media(max-width:600px){.week-figures{gap:12px}.week-figures>div+div{padding-left:12px}.week-figures strong{font-size:23px}.weekly-token-strip{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.weekly-token-strip>div{padding-left:0;border:0}}
.paused-state{color:var(--cost-gold);font-size:11px}.history-controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;padding:0 0 16px}.history-search{display:flex;flex:1 1 290px;min-width:0;max-width:480px;gap:6px}.history-search input{height:36px;min-width:0;flex:1;padding:0 10px;background:var(--cost-panel);color:var(--cost-text);border:1px solid var(--cost-line-strong);border-radius:4px;font-size:12px}.history-status,.unpriced-filter{display:flex;align-items:center;gap:7px;color:var(--cost-muted);font-size:11px;white-space:nowrap}.history-status select{height:36px;max-width:280px;padding:0 24px 0 9px;border:1px solid var(--cost-line-strong);border-radius:4px;background:var(--cost-panel);color:var(--cost-text);font-size:12px}.unpriced-filter input{width:14px;height:14px;accent-color:var(--cost-lime)}.history-scope{flex-basis:100%;font-size:10px;color:var(--cost-muted)}.unpriced-link,.parent-link{color:var(--cost-gold);text-decoration:underline;text-underline-offset:3px;text-align:left}.parent-link{color:var(--cost-blue)}.unpriced-link:hover,.parent-link:hover{color:var(--cost-text)}.detail-actions{flex-wrap:wrap}
.usage-monitor{--cost-bg:#101413;--cost-panel:#171c1b;--cost-panel-2:#202725;--cost-line:#303c36;--cost-line-strong:#405048;--cost-text:#eef3f0;--cost-muted:#98a99f;--cost-lime:#b9e55a;--cost-blue:#8bc8df;--cost-gold:#e5be72;min-height:calc(100dvh - var(--desktop-titlebar-height,0px));width:100%;font-size:13px}
.heading-actions,.section-bar,.pagination,.detail-actions{display:flex;align-items:center;gap:12px}
h2{font-size:20px;font-weight:600;margin:0}h2 span,h3 span{color:var(--cost-muted);font-size:12px;font-weight:400;margin-left:8px}p{margin:5px 0;color:var(--cost-muted);line-height:1.7}.freshness{font-size:12px;color:var(--cost-muted)}
.icon-button{display:inline-flex;justify-content:center;align-items:center;width:36px;height:36px;flex:0 0 36px;border:1px solid var(--cost-line-strong);border-radius:4px;background:var(--cost-panel);color:var(--cost-muted)}.icon-button:hover:not(:disabled){background:var(--cost-panel-2);color:var(--cost-text)}.icon-button:disabled{opacity:.4;cursor:default}
 .monitor-navigation{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 28px;border-bottom:1px solid var(--cost-line);flex-wrap:wrap}.monitor-tabs{display:flex;align-self:stretch;gap:22px;margin-right:auto}.monitor-tabs button{min-height:48px;padding:0 3px;color:var(--cost-muted);border-bottom:2px solid transparent;font-size:14px}.monitor-tabs button[aria-selected='true']{color:var(--cost-lime);border-bottom-color:var(--cost-lime)}.monitor-tabs button:hover{color:var(--cost-text)}.source-selector{display:flex;border:1px solid var(--cost-line-strong);border-radius:4px;overflow:hidden;margin:10px 0}.source-selector button{min-height:32px;padding:0 12px;color:var(--cost-muted);font-size:11px;white-space:nowrap}.source-selector button+button{border-left:1px solid var(--cost-line)}.source-selector button[aria-pressed='true']{color:var(--cost-lime);background:var(--cost-panel-2)}.source-selector button:hover{background:var(--cost-panel)}[role='tabpanel']{max-width:1740px;margin:auto;padding:16px 24px 32px}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--cost-line-strong);border-bottom:1px solid var(--cost-line-strong);background:var(--cost-panel)}
.metrics>div{position:relative;padding:19px 18px;border-right:1px solid var(--cost-line);min-width:0}.metrics>div:last-child{border:0}.metrics>div::before{content:'';position:absolute;left:0;top:18px;bottom:18px;width:2px;background:var(--cost-lime)}.metrics>div:nth-child(2)::before{background:var(--cost-blue)}.metrics>div:last-child::before{background:var(--cost-gold)}.metrics span,.metrics small{display:block;color:var(--cost-muted);font-size:11px;line-height:1.7}.metrics strong{display:block;font:600 25px/1.4 'Cascadia Mono',Consolas,monospace;margin:9px 0;overflow-wrap:anywhere;color:var(--cost-lime)}.metrics>div:nth-child(2) strong{color:var(--cost-blue)}.metrics .cost-metric strong{font-size:18px;line-height:1.45;margin:7px 0;color:var(--cost-gold)}.metrics em{font-size:11px;font-style:normal;font-weight:400}
.scenario-band{padding:16px 0;border-bottom:1px solid var(--cost-line)}.scenario-band h2{font-size:12px;color:var(--cost-gold)}.scenario-band p{font-size:11px;line-height:1.7}.scenario-values,.turn-scenarios{display:flex;flex-wrap:wrap;gap:7px 20px;font-size:12px;line-height:1.7}.scenario-values{margin-top:9px;font-family:'Cascadia Mono',Consolas,monospace}.scenario-values small{color:var(--cost-muted)}.scenario-values b{font-weight:600}.turn-scenarios{color:var(--cost-gold)}
.metric-notes{font-size:11px;padding:14px 0;line-height:1.7;border-bottom:1px solid var(--cost-line);margin-bottom:12px}.metric-notes summary{color:var(--cost-muted);cursor:pointer;width:fit-content}.metric-notes[open] summary{color:var(--cost-text);margin-bottom:10px}.metric-notes p{max-width:1100px}
.section-bar{justify-content:space-between;padding:17px 0;gap:15px;flex-wrap:wrap}.section-bar>span,.detail-actions,.page-note{color:var(--cost-muted);font-size:12px;line-height:1.7}.sessions-section,.detail-section,.sources-section{border-bottom:1px solid var(--cost-line);margin-bottom:18px}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left;table-layout:fixed;min-width:1020px}th{font-weight:500;color:#a5afa7;font-size:12px;background:var(--cost-panel)}th,td{padding:12px;border-bottom:1px solid var(--cost-line);overflow-wrap:anywhere;vertical-align:top}.sessions-table th:first-child{width:20%}.sessions-table th:nth-child(2){width:17%}.sessions-table th:last-child{width:21%}td{font-family:inherit;font-size:12px;line-height:1.6}td small,.session-link small{display:block;color:var(--cost-muted);font-size:10px;margin-top:4px;overflow-wrap:anywhere}.session-link{display:flex;align-items:flex-start;gap:6px;text-align:left;color:var(--cost-blue);font-weight:600;max-width:100%;font-family:inherit}.session-link:hover{color:var(--cost-lime)}.session-link small{font-weight:400}.parent-id{padding-left:20px}.selected{background:#242c20}.active-status{color:var(--cost-lime)}.session-prices{font-size:11px}.session-prices small{line-height:1.6}.pagination{justify-content:flex-end;padding:12px 0;font-size:11px;color:var(--cost-muted)}.pagination>span{margin-right:5px}
.notice{padding:13px 16px;background:var(--cost-panel);border-left:3px solid var(--cost-blue);margin:16px 28px}.error{background:#30201c;color:#efb6a7;border-color:#b6735e}.detail-section .notice{margin:0 0 16px}.empty{text-align:center;padding:32px;color:var(--cost-muted);font-family:inherit;font-size:12px;line-height:1.8}.detail-section{border-top:1px solid var(--cost-line-strong)}.detail-id{font-family:'Cascadia Mono',Consolas,monospace;font-size:11px;overflow-wrap:anywhere}.turn-group{padding:16px 0;border-top:1px solid var(--cost-line)}h3{font-size:13px;font-weight:600;margin:0 0 10px;overflow-wrap:anywhere}.request-detail{border-bottom:1px solid var(--cost-line)}.request-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:8px;padding:14px;background:var(--cost-panel)}.request-facts dt{font-size:10px;color:var(--cost-muted)}.request-facts dd{margin:4px 0 0;font-size:11px;overflow-wrap:anywhere}.price-evidence{padding:12px 8px;font-size:11px;line-height:1.8;overflow-wrap:anywhere}.price-evidence+.price-evidence{border-top:1px solid var(--cost-line)}.price-evidence h4{font-weight:600;margin:0;color:var(--cost-gold)}.price-evidence a{color:var(--cost-blue);text-decoration:underline}.unpriced,.excluded-components{color:var(--cost-gold);padding:5px 8px;overflow-wrap:anywhere;font-size:11px}
.table-scroll{max-height:460px;overflow:auto}.sessions-table th{position:sticky;top:0;z-index:1}.source-row{display:grid;grid-template-columns:150px 1fr;gap:7px 16px;padding:18px 0;border-top:1px solid var(--cost-line)}.source-row>strong{font-size:12px}.source-row>span{font-size:11px;color:var(--cost-muted)}.source-row code,.source-row p{grid-column:1/-1;overflow-wrap:anywhere;font-size:11px}.source-row code{color:var(--cost-blue)}.spinning{animation:monitor-spin 1s linear infinite}@keyframes monitor-spin{to{transform:rotate(360deg)}}
@media(max-width:1000px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metrics>div{border-bottom:1px solid var(--cost-line)}.metrics>div:nth-child(2){border-right:0}.monitor-navigation{gap:0}}
@media(max-width:600px){.heading-actions{flex-wrap:wrap;width:100%}.freshness{flex:1;min-width:180px}.monitor-navigation{padding:0 16px}.monitor-tabs{gap:24px;width:100%}.monitor-tabs button{min-height:48px}.source-selector{width:100%}.source-selector button{flex:1;padding:0 8px;font-size:10px}[role='tabpanel']{padding:18px 16px 30px}.metrics>div{padding:16px 12px}.metrics strong{font-size:21px}.metrics .cost-metric strong{font-size:15px}.metrics small{font-size:10px}.request-facts{grid-template-columns:1fr}.source-row{grid-template-columns:1fr}.source-row code,.source-row p{grid-column:1}.section-bar>span{line-height:1.6}.notice{margin:16px}.pagination{gap:8px;flex-wrap:wrap}}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
.usage-monitor,[role='tabpanel'],.sessions-section,.detail-section,.table-scroll{min-width:0;max-width:100%}.detail-section .section-bar>div:first-child{min-width:0;max-width:100%}.table-scroll:focus-visible{outline:2px solid var(--cost-lime);outline-offset:-2px}.request-detail:focus-visible,.detail-section:focus-visible{outline:2px solid var(--cost-lime);outline-offset:3px}
.analysis-controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:10px 0 18px}.analysis-controls .source-selector{margin:0}.analysis-controls select{max-width:330px;min-width:0}.analysis-range{flex-basis:100%;font-size:11px;color:var(--cost-muted);overflow-wrap:anywhere}.analysis-loading{color:var(--cost-gold);font-size:11px}.trend-section,.breakdown-section{padding-bottom:16px;border-bottom:1px solid var(--cost-line);min-width:0}.breakdown-section .table-scroll{max-height:300px}.breakdown-table th:first-child{width:24%}.detail-workspace{display:grid;grid-template-columns:minmax(230px,.3fr) minmax(0,1fr);gap:20px;align-items:start}.turn-index,.request-workspace{min-width:0}.turn-index{border-right:1px solid var(--cost-line);padding-right:16px}.turn-index .section-bar{padding-top:8px}.request-scroll{max-height:360px}.requests-table{min-width:780px}.requests-table th:first-child{width:24%}.requests-table th:nth-child(2){width:21%}.requests-table th:last-child{width:24%}.request-detail{padding:16px 0;border-top:1px solid var(--cost-line-strong)}.request-detail h3{overflow-wrap:anywhere;min-width:0}
@media(max-width:1100px){.detail-workspace{grid-template-columns:minmax(0,1fr)}.turn-index{border-right:0;padding-right:0}}
@media(max-width:680px){.analysis-controls .history-status{width:100%}.analysis-controls select{flex:1;max-width:100%}.source-row{grid-template-columns:1fr}.metrics .cost-metric strong{font-size:16px}}

.scope-controls{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-bottom:22px}.scope-controls h1{font-size:22px;font-weight:650;margin:0 auto 0 0}.scope-controls .source-selector{margin:0}
.tool-overview{display:flex;gap:0;padding:12px 26px;border-bottom:1px solid var(--cost-line);overflow-x:auto}.tool-overview>button{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:4px 10px;flex:1;min-width:270px;padding:11px 16px;text-align:left;border-right:1px solid var(--cost-line);font-size:13px}.tool-overview>button:last-child{border:0}.tool-overview>button[aria-pressed=true]{background:#202c22}.tool-overview strong{min-width:0;overflow-wrap:anywhere;font-weight:600;color:var(--cost-text)}.tool-rate{min-height:31px;line-height:17px;text-align:right;color:var(--tool-color);font-variant-numeric:tabular-nums;white-space:nowrap}.tool-rate>span{display:block;color:var(--cost-muted);font-size:10px;line-height:14px}.tool-overview>button>small{grid-column:2/-1;min-width:0;overflow-wrap:anywhere;font-size:11px;color:#9eada5}.tool-overview svg{color:var(--tool-color)}
.mode-coverage{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:#a3b7aa;padding:12px 0}.analysis-range{margin-bottom:18px}
.week-figures strong{font-size:34px}.week-figures span{font-size:14px}.weekly-workspace{grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);padding:10px 0 24px}.weekly-section h2{font-size:20px}.forecast-paused{display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-top:1px solid #665235;border-bottom:1px solid var(--cost-line);color:var(--usage-warning)}.forecast-paused>svg{flex:0 0 auto;margin-top:2px}.forecast-paused strong{font-size:15px}.forecast-paused p{color:#c0c9c4;font-size:12px;line-height:1.8;margin:9px 0}.forecast-paused small{color:#9dafa3;font-size:11px;line-height:1.7}.remaining-label{font-size:18px;font-weight:600;color:var(--quota-color);margin:10px 0}.quota-copy>small{display:block;font-size:11px;color:#98a99f;line-height:1.8;overflow-wrap:anywhere}
.allowance-item{display:flex;align-items:flex-start;gap:18px}.quota-copy{flex:1;min-width:0}.quota-dial{position:relative;flex:0 0 104px;width:104px;height:104px;border-radius:50%;background:conic-gradient(var(--quota-color) var(--quota-fill),var(--quota-track,#26322c) 0);display:grid;place-items:center}.quota-dial::before{content:'';position:absolute;inset:10px;border-radius:50%;background:var(--cost-bg)}.quota-dial>strong{position:relative;text-align:center;font-size:23px;color:var(--quota-color)}.quota-dial small{display:block;font-size:11px;font-weight:400;color:#abb9b1;margin-top:5px}.current-quotas .allowance-title>strong{display:none}.current-quotas .allowance-item meter{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}.quota-estimate{font-size:12px;color:var(--cost-gold);margin-top:12px}.quota-estimate small{display:block;color:#92a399;font-size:10px;margin-top:4px}.allowance-heading h3{font-size:20px}
/* Shared rows let expanded amount details use the space below the quota dial as well. */
.allowance-item.has-account-amounts{display:grid;grid-template-columns:minmax(0,1fr) minmax(170px,210px);gap:10px 18px;align-items:start}
.allowance-item.has-account-amounts.has-quota-dial{grid-template-columns:104px minmax(0,1fr) minmax(170px,210px)}
.allowance-item.has-account-amounts>.quota-copy,.allowance-item.has-account-amounts .quota-account-header,.allowance-item.has-account-amounts :deep(.account-periods){display:contents}
.has-account-amounts .quota-account-identity{grid-column:1;grid-row:1}
.has-account-amounts.has-quota-dial>.quota-dial{grid-column:1;grid-row:1}
.has-account-amounts.has-quota-dial .quota-account-identity{grid-column:2}
.has-account-amounts :deep(.amount-overview){grid-column:-2;grid-row:1}
.has-account-amounts :deep(.amount-details),.has-account-amounts :deep(.quota-cycle-details){grid-column:1/-1;margin-top:0;padding-top:8px}
.quota-group:not(.current-quotas)>.allowance-list:has(.amount-details[open],.quota-cycle-details[open]){max-height:none;overflow:visible}
.has-account-amounts>.quota-copy>:not(.quota-account-header){grid-column:1/-1}
@media(max-width:1200px){.allowance-item.has-account-amounts.has-quota-dial{grid-template-columns:82px minmax(0,1fr) minmax(150px,190px)}}
@container quota-panel (max-width:440px){
  .allowance-item.has-account-amounts{grid-template-columns:minmax(0,1fr)}
  .allowance-item.has-account-amounts.has-quota-dial{grid-template-columns:auto minmax(0,1fr)}
  .has-account-amounts :deep(.amount-overview){grid-column:1/-1;grid-row:auto}
}
.analysis-visuals{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:30px;border-bottom:1px solid var(--cost-line);padding:0 0 24px}.trend-section{border:0}.model-ranking{border-left:1px solid var(--cost-line);padding-left:28px;min-width:0}.ranking-scroll{max-height:270px;overflow:auto}.ranking-scroll>button{display:grid;grid-template-columns:minmax(110px,1fr) minmax(70px,1fr) 75px;align-items:center;gap:12px;width:100%;padding:15px 0;text-align:left;font-size:12px}.ranking-scroll small{display:block;color:#93a49a;font-size:10px;margin-top:4px}.ranking-scroll b{font-weight:500;text-align:right}.rank-track{height:3px;border-radius:3px;background:#26322c;margin-right:4px}.rank-track i{display:block;position:relative;height:100%;background:var(--model-color);border-radius:3px}.rank-track i::after{content:'';position:absolute;right:-4px;top:-3px;width:9px;height:9px;border-radius:50%;background:var(--model-color)}.rank-track i[style*='width: 0%']::after{display:none}
.session-sort{display:flex;justify-content:flex-end;align-items:center;gap:9px;color:#94a59b;font-size:12px;margin:0 0 12px}.session-sort select,.price-form input,.price-form select{background:var(--cost-panel);color:var(--cost-text);border:1px solid var(--cost-line-strong);border-radius:4px;padding:8px 10px;font-size:12px;min-width:0}
.session-layout.is-browser{display:grid;grid-template-columns:300px minmax(0,1fr);gap:26px;align-items:start}.is-browser>.sessions-section{border-right:1px solid var(--cost-line);padding-right:20px;min-width:0}.is-browser .history-scope{line-height:1.7}.session-browser{max-height:650px;overflow:auto}.session-browser-row{display:flex;align-items:flex-start;gap:5px;padding:12px 6px 12px calc(6px + var(--depth)*12px);border-bottom:1px solid var(--cost-line);min-width:0}.session-choice{text-align:left;flex:1;min-width:0}.session-choice strong{display:block;overflow-wrap:anywhere;font-size:14px}.session-choice span,.session-choice small{display:block;margin-top:5px;font-size:11px;line-height:1.6;color:#99aaa0;overflow-wrap:anywhere}.session-choice small:last-child{font-size:10px}.branch-toggle,.branch-icon{flex:0 0 18px;margin-top:3px;color:var(--cost-blue)}.session-browser-row>.parent-link{font-size:10px;flex-shrink:0;margin-top:3px}.session-placeholder{min-height:360px;display:grid;place-content:center;justify-items:center;gap:15px;color:#8da095}.session-placeholder h2{font-size:17px}.session-placeholder span{font-size:12px}
.sessions-table{min-width:1400px}.sessions-table th:first-child{width:210px}.sessions-table th:nth-child(2){width:190px}.sessions-table th:nth-child(3){width:180px}.sessions-table th:nth-child(6){width:210px}.sessions-table th:last-child{width:170px}.mode-badge{display:inline-block!important;width:fit-content;font-size:11px;line-height:1.5;border:1px solid var(--mode-color);padding:2px 6px;border-radius:4px;color:var(--mode-color)!important}.timing-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;border-top:1px solid var(--cost-line);border-bottom:1px solid var(--cost-line);padding:18px 0;margin-bottom:22px}.timing-strip>div{min-width:0}.timing-strip span{font-size:11px;color:#95a79c}.timing-strip strong{display:block;font-size:16px;line-height:1.5;margin-top:7px;overflow-wrap:anywhere}.timing-strip small{font-size:10px;color:#95a79c}.is-browser .detail-section{border-top:0}.is-browser .detail-section>.section-bar{padding-top:15px}.is-browser .detail-workspace{grid-template-columns:240px minmax(0,1fr);gap:18px}.detail-section h2{font-size:22px}.requests-table{min-width:680px}
.source-head,.source-entry>summary{display:grid;grid-template-columns:minmax(150px,1fr) 140px minmax(140px,1fr) minmax(210px,1.5fr) minmax(150px,1fr);gap:16px;align-items:center;padding:16px 14px;font-size:12px}.source-head{color:#93a79a;background:var(--cost-panel);font-size:11px}.source-entry{border-bottom:1px solid var(--cost-line)}.source-entry>summary{cursor:pointer;list-style:none}.source-entry>summary::-webkit-details-marker{display:none}.source-entry>summary>span:first-child,.source-entry>summary>span:last-child{display:flex;align-items:center;gap:10px}.source-entry>summary>span:last-child{font-size:11px;color:#93a79a}.source-entry-detail{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px;background:var(--cost-panel);font-size:12px}.source-entry-detail code{overflow-wrap:anywhere;color:var(--cost-blue)}.source-entry-detail p{margin:0;font-size:12px}.source-entry-detail p:last-child{grid-column:1/-1}
.catalog-band{display:flex;align-items:center;gap:25px;padding:28px 0;margin:8px 0;border-bottom:1px solid var(--cost-line);flex-wrap:wrap}.catalog-band>div{flex:1;min-width:180px;font-size:12px;color:#a4b4a9}.catalog-band>div:nth-child(2){display:flex;align-items:center;gap:10px}.catalog-band h2{font-size:18px;margin-bottom:10px}.catalog-band a,.lookup-evidence a{display:inline-flex;align-items:center;gap:5px;color:var(--cost-blue)}.catalog-band small{display:block;margin-top:7px;font-size:11px;color:#8da294}.catalog-sync{display:flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:8px 14px;border:1px solid var(--cost-line-strong);border-radius:5px;color:var(--cost-text);font-size:12px}.catalog-sync:hover{background:var(--cost-panel-2)}.source-price-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px}.price-lookup{border-left:1px solid var(--cost-line);padding-left:30px}.reason-list{margin-top:20px}.reason-list>div{display:flex;gap:20px;justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--cost-line);font-size:12px}.reason-list b{flex-shrink:0;font-weight:500}.evidence-link{display:flex;align-items:center;gap:8px;margin-top:18px;color:var(--cost-blue);font-size:12px}.price-form{display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:15px}.price-form label{display:flex;flex-direction:column;gap:8px;font-size:12px;color:#9eafa3}.price-form .catalog-sync{align-self:end;white-space:nowrap}.price-form .catalog-sync svg{flex-shrink:0}.price-empty{display:flex;justify-content:center;align-items:center;gap:10px;min-height:120px;color:#82968a;font-size:13px}.lookup-evidence{padding:20px 0}.lookup-evidence>div{display:flex;justify-content:space-between;gap:12px;font-size:12px}.lookup-evidence>div>span{color:#97aa9e}.lookup-evidence a{font-size:12px;margin-top:14px}
@media(max-width:1200px){.session-layout.is-browser{grid-template-columns:260px minmax(0,1fr);gap:20px}.is-browser .detail-workspace{grid-template-columns:1fr}.is-browser .turn-index{border-right:0;padding-right:0}.source-head{display:none}.source-entry>summary{grid-template-columns:1fr 1fr;gap:12px}.source-entry>summary>span:nth-child(4){grid-column:1/-1}.source-price-workspace{grid-template-columns:1fr}.price-lookup{border-left:0;border-top:1px solid var(--cost-line);padding:0}.weekly-workspace{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:24px}.quota-dial{flex-basis:82px;width:82px;height:82px}.quota-dial>strong{font-size:19px}}
@media(max-width:850px){.weekly-workspace,.analysis-visuals,.session-layout.is-browser{grid-template-columns:1fr}.weekly-value,.model-ranking,.is-browser>.sessions-section{border-right:0;border-left:0;padding:0}.model-ranking{border-top:1px solid var(--cost-line)}.session-browser{max-height:260px}.timing-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.source-entry-detail{grid-template-columns:1fr}.source-entry-detail p:last-child{grid-column:auto}.tool-overview{padding:8px 16px}.scope-controls{gap:12px}.scope-controls h1{flex-basis:100%}.week-figures strong{font-size:27px}}.chart-note{font-size:12px;line-height:1.7;color:#a3b7aa;margin:10px 0}.trend-section .source-selector button{font-size:13px;min-height:36px;padding:0 14px}.model-ranking .ranking-scroll>button{font-size:14px;min-height:60px}.model-ranking .ranking-scroll small{font-size:12px}.model-ranking .ranking-scroll b{font-size:15px;font-variant-numeric:tabular-nums}
.session-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;padding:20px 0 24px;border-bottom:1px solid var(--cost-line);margin-top:8px}.session-summary>div{min-width:0;padding:0 16px;border-right:1px solid var(--cost-line)}.session-summary>div:first-child{padding-left:0}.session-summary>div:last-child{padding-right:0;border-right:0}.session-summary span{font-size:14px;color:#b4c4ba}.session-summary strong{display:block;font-size:30px;line-height:1.3;font-weight:650;margin:10px 0;color:var(--cost-blue);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.session-summary>div:nth-child(1) strong{color:var(--usage-input)}.session-summary>div:nth-child(2) strong{color:var(--usage-output)}.session-summary>div:nth-child(3) strong{color:var(--usage-cache)}.session-summary>div:nth-child(n+4) strong{color:var(--cost-text)}.session-summary small{display:block;font-size:11px;line-height:1.7;color:#a3b7aa}.record-evidence{padding:12px 0;border-bottom:1px solid var(--cost-line);font-size:12px}.record-evidence>summary{cursor:pointer;color:var(--cost-blue);line-height:1.8}.record-evidence[open]>summary{margin-bottom:12px}.record-evidence p{overflow-wrap:anywhere}.reason-filter{display:flex;align-items:center;justify-content:space-between;gap:10px;border-left:2px solid var(--cost-gold);padding:10px;background:var(--cost-panel);font-size:12px;color:var(--cost-muted)}.reason-filter strong{display:block;margin-top:5px;color:var(--cost-gold);font-size:13px;font-weight:500}.reason-link{display:inline-flex;align-items:center;gap:6px;color:var(--cost-blue);font-size:12px;white-space:nowrap}.reason-link:hover{color:var(--cost-lime)}.reason-list>div{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:16px;align-items:center;font-size:13px}.reason-list h3{font-size:15px}
.source-group{border-bottom:1px solid var(--cost-line)}.source-group>summary{display:grid;grid-template-columns:minmax(150px,1fr) 140px minmax(140px,1fr) minmax(210px,1.5fr) minmax(150px,1fr);gap:16px;align-items:center;padding:20px 14px;list-style:none;cursor:pointer;font-size:14px;min-height:76px}.source-group>summary::-webkit-details-marker{display:none}.source-group>summary>span:first-child,.source-group>summary>span:last-child{display:flex;align-items:center;gap:10px}.source-group>summary>span:last-child{justify-content:space-between;font-size:12px}.source-group small,.source-entry small{display:block;font-size:11px;color:#a3b7aa;margin-top:5px;overflow-wrap:anywhere}.group-sources{padding:0 12px 12px;background:var(--cost-panel)}.group-sources>.source-entry:last-child{border-bottom:0}.group-sources .source-entry>summary>span:first-child{display:block}.group-sources .source-entry-detail{background:var(--cost-bg)}
@media(max-width:1200px){.session-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.session-summary>div{padding-left:0;border:0}.source-group>summary{grid-template-columns:1fr 1fr}.source-group>summary>span:nth-child(4){grid-column:1/-1}}
@media(max-width:700px){.session-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.session-summary strong{font-size:26px}.reason-list>div{gap:10px}.reason-link{font-size:11px}.trend-section .section-bar{gap:10px}.trend-section .source-selector{width:100%}.trend-section .source-selector button{flex:1;padding:0 8px}}
.session-filter-bar{display:grid;grid-template-columns:minmax(220px,1fr) 110px auto minmax(140px,180px) 122px auto 120px;gap:10px;align-items:center;border-bottom:1px solid var(--cost-line);padding:0 0 18px;margin-bottom:4px}.session-filter-bar .history-search{width:100%;max-width:none}.session-filter-bar .source-selector{margin:0}.session-filter-bar .source-selector button{min-height:36px}.session-filter-bar>select{height:36px;min-width:0;max-width:100%;padding:0 20px 0 9px;border:1px solid var(--cost-line-strong);border-radius:4px;background:var(--cost-panel);color:var(--cost-text);font-size:12px}.session-filter-bar .reason-filter{grid-column:1/-1;justify-self:start;max-width:100%}.history-scope{margin:0 0 16px}.coverage-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 7px;border-radius:4px;border:1px solid #6e6039;color:var(--cost-gold);font-size:11px;line-height:1.5}.coverage-badge.complete{border-color:#415e32;color:var(--cost-lime)}.tool-breakdown>summary{font-size:13px;color:var(--cost-blue);cursor:pointer;padding:16px 0}
.usage-monitor :deep(.usage-state){display:inline-flex;align-items:center;gap:7px;color:#a5b5ac;font-size:12px;line-height:1.6}.usage-monitor :deep(.usage-state::before){content:'';width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}.usage-monitor :deep(.usage-state[data-state='running']){color:var(--usage-success)}.usage-monitor :deep(.usage-state[data-state='active']),.usage-monitor :deep(.usage-state[data-state='recent']){color:var(--cost-blue)}.usage-monitor :deep(.usage-state[data-state='stale']){color:var(--usage-warning)}.usage-monitor :deep(.usage-state[data-state='unknown']){color:var(--usage-unknown)}.usage-monitor :deep(.session-kind){display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-style:normal;line-height:1.5;padding:2px 7px;border:1px solid #47584c;border-radius:4px;background:#1d2b20;color:#b9d398;vertical-align:middle}.source-group>summary>span:nth-child(2)::before{content:'';display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:currentColor}
.request-proof-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px;padding:22px 0;border-top:1px solid var(--cost-line);border-bottom:1px solid var(--cost-line);margin:18px 0}.request-proof-layout h4{font-size:16px;font-weight:600;margin:0 0 16px}.request-price-panel,.request-original-evidence{min-width:0}.request-original-evidence{border-left:1px solid var(--cost-line);padding-left:28px}.request-proof-layout .selected-price-evidence{padding:0 0 16px;margin:0;border:0}.proof-amount{display:block;color:var(--cost-gold);font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.4;overflow-wrap:anywhere;margin-bottom:12px}.request-rates{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0 8px}.request-rates dt,.source-facts dt,.lookup-context dt{font-size:12px;color:var(--cost-muted)}.request-rates dd{font-size:17px;margin:7px 0;color:var(--cost-text);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.request-price-panel small{font-size:11px;color:var(--cost-muted)}.request-price-panel a{display:inline-flex;align-items:center;gap:6px}.source-facts{margin:0}.source-facts>div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:14px;margin-bottom:14px}.source-facts dd{margin:0;font-size:13px;overflow-wrap:anywhere}.request-original-evidence .record-evidence{border-bottom:0}.request-original-evidence .request-facts{grid-template-columns:1fr;margin:0;padding:10px 0;background:transparent}.proof-pending{font-size:17px;color:var(--cost-gold);line-height:1.7}.lookup-context{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 24px;padding:16px 0;margin:0;border-bottom:1px solid var(--cost-line)}.lookup-context dd{margin:6px 0 0;font-size:13px;font-weight:500;overflow-wrap:anywhere}
@media(max-width:1250px){.session-filter-bar{grid-template-columns:minmax(175px,1fr) 100px auto minmax(110px,140px) 110px auto 108px;gap:8px}.session-filter-bar .source-selector button{padding:0 8px}.proof-amount{font-size:23px}}
@media(max-width:900px){.session-filter-bar{grid-template-columns:repeat(3,minmax(0,1fr))}.session-filter-bar .history-search{grid-column:1/-1}.session-filter-bar .source-selector{grid-column:span 2}.request-proof-layout{grid-template-columns:1fr}.request-original-evidence{border-left:0;border-top:1px solid var(--cost-line);padding:20px 0 0}}
.request-price-panel small{display:block}.request-price-panel .selected-price-evidence a{margin-top:12px}
.model-name{display:block;overflow-wrap:anywhere;border-left:3px solid var(--model-color);padding-left:9px;color:var(--cost-text)}
.weekly-token-strip>div:nth-child(2) dd,.request-rates>div:nth-child(1) dd{color:var(--usage-input)}.weekly-token-strip>div:nth-child(3) dd,.request-rates>div:nth-child(3) dd{color:var(--usage-output)}.weekly-token-strip>div:nth-child(4) dd,.request-rates>div:nth-child(2) dd{color:var(--usage-cache)}
.source-health [data-tone='healthy']{color:var(--usage-success)}.source-health [data-tone='warning']{color:var(--usage-warning)}.source-health [data-tone='error']{color:var(--usage-danger)}.source-health [data-tone='unknown']{color:var(--usage-unknown)}
.ranking-scroll>button>span:first-child{min-width:0;overflow-wrap:anywhere}.ranking-scroll>button:disabled{cursor:default;opacity:1}.ranking-scroll>button:disabled>span:first-child{color:var(--usage-unknown)}.timing-strip>div:nth-child(3) strong,.speed-cell>strong{color:var(--usage-output)}.timing-strip>div:nth-child(4) strong{color:var(--usage-requests)}
.usage-monitor .timing-strip strong.unknown-value{color:var(--usage-unknown)}
.credits-section .allowance-heading h3{font-size:16px}.credit-group>summary,.quota-source-details>summary{cursor:pointer;padding:10px 0;font-size:12px;color:var(--cost-text);line-height:1.6}.credit-group>summary>span,.quota-source-details>summary>span{margin-left:7px;color:var(--cost-muted);font-size:11px}.credit-group.current-credits>summary{display:none}.credit-accounts{max-height:175px;overflow:auto}.credit-account strong small{display:inline;font-size:10px;margin-left:5px}.historical-credit strong{color:var(--usage-unknown)}.credit-group:not(.current-credits),.quota-source-details{border-top:1px solid var(--cost-line)}.quota-source-details>summary>b{margin-left:10px;color:var(--usage-warning);font-size:11px;font-weight:400}.quota-source-details .quota-source-note:last-child{border-bottom:0}
.detail-cost{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--cost-muted);margin:10px 0 16px}.detail-cost strong{font-size:18px;color:var(--usage-output)}.detail-cost>span{color:var(--usage-warning)}.family-members{border-block:1px solid var(--cost-line);margin:18px 0;padding:12px 0}.family-members>summary{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;list-style:none}.family-expand{margin-left:auto;transition:transform .15s}.family-members[open] .family-expand{transform:rotate(90deg)}.family-members>summary>svg{color:var(--cost-blue)}.family-members>summary>span,.family-members>summary>small{font-size:11px;font-weight:400;color:var(--cost-muted)}.family-member-scroll{max-height:250px;overflow:auto}.family-table{min-width:620px;font-size:12px}.family-table th{position:sticky;top:0;background:var(--cost-panel);z-index:1}.family-table td{padding:10px 12px;vertical-align:middle}.family-table td:first-child{max-width:260px;overflow-wrap:anywhere}.family-table td small{font-size:10px;color:var(--cost-muted)}.family-table .is-root{background:#ffffff04}.family-root-label{color:var(--cost-text);font-weight:600}.family-link{text-align:left;font-size:12px}.token-input{color:var(--usage-input)}.token-output{color:var(--usage-output)}.request-source{display:inline-flex!important;align-items:center;gap:4px;color:var(--cost-muted);font-size:11px}.request-source.child{color:var(--cost-blue)}.unlinked-children{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.own-timing-note{margin:0 0 12px}

/* Keep the reference lookup compact without changing either column's width. */
.price-lookup { min-width:0; container-type:inline-size; align-self:start; }
.price-lookup > .section-bar { padding-block:12px; }
.price-lookup .price-form { gap:10px 12px; }
.price-lookup .price-form label { gap:5px; min-width:0; }
.price-lookup .lookup-evidence { padding:10px 0 0; }
.price-lookup .lookup-context { gap:10px 16px; padding:8px 0; }
.price-lookup .lookup-context dd { margin-top:3px; }
.price-lookup .page-note { margin-top:6px; }
.price-lookup .lookup-evidence > a { margin-top:4px; }
.price-lookup :deep(.tariff-visual) { margin:12px 0 0; }
.price-lookup :deep(.tariff-heading) { margin-bottom:10px; }
.price-lookup :deep(.tariff-values strong) { margin-top:3px; }
.price-lookup :deep(.tariff-flow) { margin-top:10px; }
.price-lookup :deep(.tariff-note) { margin-bottom:4px; }
@container (min-width:530px) {
  .price-form { grid-template-columns:minmax(0,1fr) 90px 145px 108px; }
  .lookup-context { grid-template-columns:1.1fr 1fr .8fr 1.2fr; }
  .lookup-evidence :deep(.tariff-values > div) { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 10px; }
  .lookup-evidence :deep(.tariff-values strong) { margin-top:0; }
}
@container (max-width:380px) {
  .price-form { grid-template-columns:minmax(0,1fr) 105px; }
  .lookup-context { column-gap:12px; }
}
</style>


