import { costDataText } from './costDataText'
import { computed, ref } from 'vue'
import { adminAPI } from '@/api/admin'
import type { OpsDashboardOverview, OpsErrorTrendPoint, OpsThroughputTrendPoint } from '@/api/admin/ops'
import type { SystemSettings } from '@/api/admin/settings'
import type { Channel, ModelDefaultPricing, PricingCatalogStatus } from '@/api/admin/channels'
import type { AccountCostLossState, AccountEconomicsSnapshot } from '@/api/admin/accounts'
import type {
  AccountUsageInfo,
  AdminUsageLog as ApiAdminUsageLog,
  DashboardStats,
  ModelStat as ApiModelStat,
  PaginatedResponse,
  WindowStats,
} from '@/types'
import type { CostAccountId, SourceAccount as Account, SourceAdminUsageLog as AdminUsageLog, SourceModelStat as ModelStat } from './sourceTypes'
import { DEFAULT_COST_MULTIPLIER, CNY_PER_USD, sumAccountCostUsd, UNATTRIBUTED_USAGE_ACCOUNT_ID } from './model'
import { buildLocalEconomicsSnapshot, isLocalEconomicsSnapshot, type LocalEconomicsAccount } from './costEngine'
// P0-16:倍率的"有限且为正,否则取兜底常量"判定**只能有一处实现**。读取持久化值时也走它,
// 不许在调用点内联 `|| DEFAULT_COST_MULTIPLIER`(那正是本项要消灭的 8 处内联重复形态)。
import { resolveCostMultiplier } from './costMultiplier'
import type { CostProfile, AccountWindowUsage } from './model'
import {
  aggregateModelStatsFromUsageLogs,
  accountCostSnapshot,
  sumTokenCounts,
  uniqueUsageLogs,
  summarizeModelAudit,
  type ModelAuditSummary,
  type ModelCostSource,
} from './modelCostAnalysis'
import { buildModelRouteRows, type ModelRouteRow } from './modelRouteAnalysis'
import { loadUsdCnyExchangeRate, getStoredUserOverrideRate, type UsdCnyExchangeRate } from './exchangeRate'
import { describeCurrentAccountState, type AccountProbeState } from './upstreamTable'
import { captureAuthConnection, isAuthConnectionCurrent, getCliproxyManagementBase, getSub2apiTargetBase } from '@/api/url'
import { aggregateSub2apiWindowLogs, type WindowCostReading } from './unifiedSourceReader'
import {
  COST_CENTER_SOURCE_KEYS,
  createDataSourceStates,
  finiteOrNull,
  hasMeasuredData,
  sourceState,
  type CostCenterSourceKey,
  type DataAvailability,
} from './dataState'
import {
  aggregateUsageWindow,
  fillCostTrendBuckets,
  localDateParameter,
  usageWindowBounds,
  costCenterRangeLabel,
  costTrendBucketHours,
  parseTrendDate,
  type CostTrendDataPoint,
  type UsageQueryWindow,
} from './usageWindow'
import type { CockpitStats, CockpitLocalAccess, CockpitQuotaHistoryFile, CockpitCodexAccount, CockpitOpsRouteAgg, CockpitRequestLogSummary } from '@/api/cockpit'
import { readCostProfiles, writeCostProfiles, type CostProfileMap } from '@/api/cockpit'
import {
  cockpitStatsToAccounts,
  type CockpitApiKeyInfo,
  cockpitModelsToModelStats,
  cockpitWindowsToCostTrend,
  cockpitWindowToAccountStats,
  cockpitLocalAccessToPricingStatus,
  cockpitWindowForRange,
  cockpitWindowLabelForRange,
  cockpitTotalsToOpsOverview,
  cockpitLogToOpsTrend,
  cockpitQuotaToAccountUsage,
  cockpitLogToModelRoutes,
  cockpitEffectiveModelPricing,
  cockpitOpsRoutesToModelRoutes,
  cockpitRequestLogToModelRoutes,
  cockpitRoutesAuditSummary,
  cockpitLocalAccessToSystemSettings,
  cockpitStatsToEconomics,
  cockpitSplitTokens,
  cockpitRequestLogToOpsTrend,
  cockpitRequestLogToHealthSeries,
  cockpitRequestLogToErrorTrend,
  cockpitModelsToImpliedPricing,
  cockpitPlatformAccountsToAccounts,
  type CockpitPlatformAccountInput,
  cockpitRequestLogToModelStats,
  cockpitRequestLogToAccountStats,
  cockpitRequestLogToCostTrend,
  cockpitRequestLogGroupCost,
  cockpitRequestLogBasisNote,
  filterCockpitRequestLogByAccount,
} from './cockpitAdapter'
import { cockpitEffectivePriceSets, type CockpitModelPriceSet } from './cockpitPriceBook'
import {
  cliproxyEventsToAccounts,
  cliproxyEventsToTodayStats,
  cliproxyEventsToModelStats,
  cliproxyEventsToTrend,
  cliproxyEventsToOps,
  cliproxyEventsToEconomics,
  cliproxyEventsToAccountUsage,
  cliproxyEventsToVendorStats,
  cliproxyEventsToReasoningEfforts,
  authIndexToAccountId,
  litellmToModelPricing,
  litellmModelVendorMap,
  isLocalCliproxyTarget,
  cliproxyUsageWindowBounds,
  type CliproxyReasoningEffortRow,
} from './cliproxyAdapter'
import {
  cliproxyAuthFilesToAccounts,
  cliproxyEventsToModelRoutes,
} from './cliproxyManagementAdapter'
import type { AuthFile, CliproxyConfig, ApiKeyUsageBucket } from '@/api/cliproxy/management'
void (0 as unknown as AuthFile)
import type { CliproxyUsageEvent, LitellmPricing } from '@/api/cliproxy/cpaData'

export type CostCenterRange = 'today' | '1m' | '5m' | '30m' | '1h' | '6h' | '24h' | '7d' | '30d'

export const DEFAULT_COST_CENTER_RANGE: CostCenterRange = '1h'

export function economicsWindowHours(range: CostCenterRange): number {
  return ({ today: 24, '1m': 1 / 60, '5m': 5 / 60, '30m': 0.5, '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 })[range]
}

function economicsPlatformFilter(filter: string): string | undefined {
  if (filter === 'all') return undefined
  if (filter === 'codex' || filter === 'openai' || filter === 'azure-openai') return 'openai'
  return filter
}

const USAGE_PAGE_SIZE = 1000
const MAX_USAGE_PAGES = 25
/** usage_logs 单次读取的安全上限(= 页数 × 页大小)。导出给视图做「截断说明」文案 ——
 *  上限数字不允许在 UI 里另抄一份(抄了就会与真实截断失配)。 */
export const USAGE_LOGS_SAFE_READ_CAP = MAX_USAGE_PAGES * USAGE_PAGE_SIZE
const MAX_MODEL_PRICING_LOOKUPS = 100
const ACCOUNT_USAGE_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_QUOTA_REQUESTS = 4

type EntityPage<T> = Pick<PaginatedResponse<T>, 'items' | 'total'> & Partial<Pick<PaginatedResponse<T>, 'page' | 'page_size' | 'pages'>>

async function readAllPages<T extends { id: number }>(read: (page: number) => Promise<EntityPage<T>>, current: () => boolean): Promise<EntityPage<T>> {
  const items: T[] = []
  const seen = new Set<number>()
  for (let page = 1; ; page += 1) {
    if (!current()) throw new Error(costDataText('readSuperseded'))
    const result = await read(page)
    if (!current()) throw new Error(costDataText('readSuperseded'))
    if (Number.isFinite(result.page) && result.page !== page) throw new Error(costDataText('paginationDidNotAdvanceAsRequested'))
    const rows = result.items ?? []
    const before = items.length
    for (const item of rows) if (!seen.has(item.id)) { seen.add(item.id); items.push(item) }
    const more = result.pages != null && Number.isFinite(result.pages) && result.pages > 0 ? page < result.pages
      : Number.isFinite(result.total) && result.total >= 0 ? items.length < result.total
        : rows.length >= (result.page_size != null && result.page_size > 0 ? result.page_size : 1000)
    if (!more) {
      if (Number.isFinite(result.total) && items.length < result.total) throw new Error(costDataText('paginationEndedEarlyTheInventoryIsIncomplete'))
      return { ...result, items }
    }
    if (items.length === before) throw new Error(costDataText('paginationEndedEarlyTheInventoryIsIncomplete'))
  }
}

function accountStatsFromLogs(logs: AdminUsageLog[], accounts: Account[], complete: boolean): Record<string, AccountWindowUsage> {
  const zero = (): AccountWindowUsage => ({ requests: 0, tokens: 0, cost: 0, standard_cost: 0, user_cost: 0 })
  const result: Record<string, AccountWindowUsage> = complete ? Object.fromEntries(accounts.map((account) => [String(account.id), zero()])) : {}
  const add = (left: number | null | undefined, right: number | null | undefined) => left == null || right == null ? null : left + right
  for (const log of uniqueUsageLogs(logs)) {
    const id = log.account_id == null ? UNATTRIBUTED_USAGE_ACCOUNT_ID : String(log.account_id)
    const row = result[id] ??= zero()
    row.requests += 1
    const tokens = sumTokenCounts(log.input_tokens, log.output_tokens, log.cache_creation_tokens, log.cache_read_tokens)
    row.tokens = add(row.tokens, tokens)
    const cost = accountCostSnapshot(log)
    const standardCost = finiteOrNull(log.total_cost)
    if (row.known_cost != null || cost == null || standardCost == null) {
      row.known_cost = (row.known_cost ?? row.cost ?? 0) + (cost ?? 0)
      row.known_standard_cost = (row.known_standard_cost ?? row.standard_cost ?? 0) + (standardCost ?? 0)
      row.unknown_cost_requests = (row.unknown_cost_requests ?? 0) + (cost == null ? 1 : 0)
    }
    row.cost = add(row.cost, cost)
    row.standard_cost = add(row.standard_cost, standardCost)
    row.user_cost = add(row.user_cost, finiteOrNull(log.actual_cost))
  }
  return result
}

function hasUnknownAccountFields(stats: Record<string, AccountWindowUsage>): boolean {
  return Object.values(stats).some((row) => row.tokens == null || row.cost == null || row.standard_cost == null || row.user_cost == null)
}

function unattributedRequests(stats: Record<string, AccountWindowUsage>): number {
  return stats[UNATTRIBUTED_USAGE_ACCOUNT_ID]?.requests ?? 0
}

export function filterModelAuditLogs(logs: AdminUsageLog[], mismatchOnly: boolean): AdminUsageLog[] {
  return mismatchOnly ? logs.filter((log) => log.upstream_model_mismatch === true) : logs
}

export function buildCostCenterSnapshotQuery(range: CostCenterRange): {
  time_range?: Exclude<CostCenterRange, 'today'>
  start_time?: string
  end_time?: string
  granularity: 'day' | 'hour' | 'minute'
} {
  if (range === 'today') {
    const now = new Date()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return { start_time: start.toISOString(), end_time: end.toISOString(), granularity: 'hour' }
  }
  return {
    time_range: range,
    granularity: range === '7d' || range === '30d' ? 'day' : range === '1m' || range === '5m' || range === '30m' || range === '1h' ? 'minute' : 'hour',
  }
}

/**
 * 观察窗口与**模型统计窗口**分别构造查询。
 *
 * 2026-09-10 恢复双轨:模型成本区有自己的 `modelCostRange`(用户明确要求"原来本身就是双轨")。
 * 2026-09-05 曾把它并入主窗口,原因是当时模型窗口默认 '1h' 且不跟主窗口变,
 * 用户切 7d 时明细表仍是 1 小时——真正的修法是**默认跟随主窗口 + 可独立改**,不是砍掉选择器。
 * 缺省 modelRange = range,调用方不传即等价于旧的单窗口行为。
 */
export function buildCostCenterDataQueries(range: CostCenterRange, modelRange: CostCenterRange = range) {
  return {
    observation: buildCostCenterSnapshotQuery(range),
    model: buildCostCenterSnapshotQuery(modelRange),
  }
}

/**
 * 逐账号观察窗口是否需要**单独**取窗口数据(而非按自然日)。
 *
 * 除 `today` 外一律为真(1m / 5m / 30m / 1h / 6h / 24h / 7d / 30d)。
 *
 * 历史:`3aee640` 只让 7d/30d 走窗口,1m~24h 仍按自然日读 → 用户选「最近 1 小时」时,
 * 表格里显示的其实是**今天一整天**的数,标签却写着「最近 1 小时」(把 A 窗口的数按 B 窗口的口径描述)。
 * 该标记只控制自然日批量端点之外的窗口加载状态；实际账号事实统一复用精确日志。
 * 源自然日未必等于本机自然日，不能靠 batch 的存在宣称 today 窗口精确。
 */
export function rangeNeedsAccountWindow(range: CostCenterRange): boolean {
  return range !== 'today'
}

/**
 * 源 WindowStats 或本地适配器结果 → 可空的逐账号用量事实。
 *
 * 三口径与源侧 SQL 一一对应(usage_log_repo_stats.go:339-355),**不得互换**:
 *   - `cost`          = SUM(COALESCE(account_stats_cost, total_cost) × account_rate_multiplier) → **成本(账号采购)口径**
 *   - `standard_cost` = SUM(total_cost)                                                          → 标准价
 *   - `user_cost`     = SUM(actual_cost)                                                         → **用户计费(营收)口径**
 * 视图「成本」列读 `cost`、「用户计费」只读 `user_cost`；本地参考价值单独读取 `standard_cost`。
 *
 * 任何字段不是有限数 ⇒ 置 null 而不是 0(红线:不可测不得写成 0)。
 * `requests` 是 AccountWindowUsage 的必填 number,拿不到就整体返回 null,由调用方跳过该账号 ——
 * 缺失即"无数据",不伪造一条全 0 记录。
 */
export function accountWindowUsageFromWindowStats(stats: WindowStats | AccountWindowUsage): AccountWindowUsage | null {
  const requests = finiteOrNull(stats.requests)
  if (requests == null) return null
  return {
    requests,
    tokens: finiteOrNull(stats.tokens),
    cost: finiteOrNull(stats.cost),
    standard_cost: finiteOrNull(stats.standard_cost),
    user_cost: finiteOrNull(stats.user_cost),
    ...('known_cost' in stats ? {
      known_cost: finiteOrNull(stats.known_cost) ?? undefined,
      known_standard_cost: finiteOrNull(stats.known_standard_cost) ?? undefined,
      unknown_cost_requests: finiteOrNull(stats.unknown_cost_requests) ?? undefined,
    } : {}),
  }
}

export function snapshotMatchesRequestedWindow(
  snapshot: { start_time?: string; end_time?: string },
  requestedStart: Date,
  requestedEnd: Date,
): boolean {
  const actualStart = parseTrendDate(snapshot.start_time || '').getTime()
  const actualEnd = parseTrendDate(snapshot.end_time || '').getTime()
  const start = requestedStart.getTime(), end = requestedEnd.getTime()
  if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd) || !Number.isFinite(start) || !Number.isFinite(end)
    || actualEnd <= actualStart || end <= start || actualStart >= end || actualEnd <= start) return false
  const matchesBoundary = (value: string | undefined, actual: number, requested: number) => {
    const precision = value?.match(/[T ]\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})?$/i)
    if (!precision) return false
    // The server serializes RFC3339 seconds; fractional endpoints retain their finer precision.
    const unit = precision[1] ? 10 ** Math.max(0, 3 - precision[1].length) : 1000
    return Math.floor(actual / unit) === Math.floor(requested / unit)
  }
  return matchesBoundary(snapshot.start_time, actualStart, start) && matchesBoundary(snapshot.end_time, actualEnd, end)
}

export function selectExactWindowModelStats(
  snapshot: { start_time?: string; end_time?: string; models?: Array<ModelStat | ApiModelStat> } | null,
  compatibility: { logs: AdminUsageLog[]; truncated: boolean } | null,
  requestedStart: Date,
  requestedEnd: Date,
  source: ModelCostSource,
): {
  models: ModelStat[]
  usedCompatibilityAggregation: boolean
  compatibilityTruncated: boolean
} {
  if (snapshot && snapshotMatchesRequestedWindow(snapshot, requestedStart, requestedEnd)) {
    return {
      models: sourceModelStats(snapshot.models ?? []),
      usedCompatibilityAggregation: false,
      compatibilityTruncated: false,
    }
  }
  if (!compatibility) {
    return { models: [], usedCompatibilityAggregation: false, compatibilityTruncated: false }
  }
  if (compatibility.truncated) {
    // 2026-09-05 修复"数据搞没了":截断样本不再返回空表,而是如实聚合最近样本
    // 并标记 compatibilityTruncated,由视图警示"数值偏低,不含更早记录"。
    return {
      models: aggregateModelStatsFromUsageLogs(compatibility.logs, source),
      usedCompatibilityAggregation: true,
      compatibilityTruncated: true,
    }
  }
  return {
    models: aggregateModelStatsFromUsageLogs(compatibility.logs, source),
    usedCompatibilityAggregation: true,
    compatibilityTruncated: false,
  }
}

function sourceModelStats(models: Array<ModelStat | ApiModelStat>): ModelStat[] {
  return models.map(model => ({
    ...model,
    input_tokens: finiteOrNull(model.input_tokens), output_tokens: finiteOrNull(model.output_tokens),
    cache_read_tokens: finiteOrNull(model.cache_read_tokens), cache_creation_tokens: finiteOrNull(model.cache_creation_tokens),
    total_tokens: finiteOrNull(model.total_tokens),
  }))
}

function buildOpsSnapshotRange(range: CostCenterRange): Exclude<CostCenterRange, 'today'> {
  // Rolling ranges map directly. The natural-day range is sent with explicit
  // local-day boundaries at the call site instead of being mislabeled as 24h.
  return range === 'today' ? '24h' : range
}

/** 本地时间短标签(M/D HH:mm),用于截断样本覆盖起点的状态说明。 */
function shortLocalStamp(value: Date | null): string {
  if (!value || !Number.isFinite(value.getTime())) return ''
  const hh = String(value.getHours()).padStart(2, '0')
  const mm = String(value.getMinutes()).padStart(2, '0')
  return `${value.getMonth() + 1}/${value.getDate()} ${hh}:${mm}`
}

/** cockpit 全局成本倍率键(存入 cockpit_cost_profiles.json 特殊 key,非 accountId) */
const COCKPIT_MULTIPLIER_KEY = '__cockpit_cost_multiplier__'

export function useCostCenterData() {
  const accounts = ref<Account[]>([])
  /** cockpit 全局成本倍率(未设置成本价格时用官方价格 × 倍率作为 billed 兜底) */
  const cockpitCostMultiplier = ref(DEFAULT_COST_MULTIPLIER)
  const localCostProfiles = ref<CostProfileMap | null>(null)
  const localCostProfilesReadError = ref<string | null>(null)
  const localCostProfilesError = computed(() => localCostProfilesReadError.value == null ? ''
    : costDataText('localCostProfilesReadFailed', { detail: localCostProfilesReadError.value }))
  let localCostProfilesLoading: Promise<void> | null = null
  const legacyLocalCostProfileCount = computed(() => Object.keys(localCostProfiles.value ?? {}).filter(key => /^-?\d+$/.test(key)).length)
  /**
   * cockpit 账号分组映射(`accountId(原始或数字形式) → 分组名`)。
   * 由 `loadFromCockpit` 从 `account_groups.json` / `codex_account_groups.json` 注入,
   * 供路由明细「分组」列回填——cockpit 日志无 `group_id`,分组只能从分组文件反查。
   * 独立窗口重算(`loadCockpitModelWindow`)复用此 ref,保证两条路径口径一致。
   */
  const cockpitGroupNameMap = ref<Map<string, string>>(new Map())
  const costLossStates = ref<AccountCostLossState[]>([])
  const accountEconomics = ref<AccountEconomicsSnapshot | null>(null)
  const accountUsage = ref<Record<string, AccountUsageInfo>>({})
  /** 逐账号自然日用量。类型是 **AccountWindowUsage**(成本/Token 可空):cockpit 单请求用量库
   *  与 cliproxy usage_events 在"该账号有请求、但本项目无单价且源也无估算"时只能给出 null,
   *  写 0 会被渲染成绿色实测 $0.0000。sub2api 的 batch.stats(WindowStats)结构上可赋给它。 */
  const todayStats = ref<Record<string, AccountWindowUsage>>({})
  /**
   * 当前观察窗口(range)对应的逐账号用量。
   * 与 todayStats(固定自然日)分开:上游排行表的成本/产出/请求/Token 列读这里,
   * 切换窗口(含 1m~24h 短窗口)才会真正换数据(此前固定读 daily,窗口切换对排行榜无效)。
   *
   * 复用已读取的精确日志/源聚合，包含已不在当前账号清单里的历史 usage-only ID。
   * 官方 today-stats/batch 仅提供源自然日，不能用它代替所选滚动窗口。
   */
  const rangeAccountStats = ref<Record<string, AccountWindowUsage>>({})
  const rangeAccountStatsComplete = ref(false)
  const rangeAccountStatsWindow = ref<UsageQueryWindow | null>(null)
  const rangeAccountStatsScope = ref<{ source: 'sub2api' | 'cliproxy' | 'cockpit'; instanceId: string | null } | null>(null)
  /**
   * 本次加载中,上游排行表的逐账号数值是否**必须**由观察窗口源提供。
   *
   * 为 true 时视图**不得**回退自然日:窗口源已被请求,缺失就是"无数据",
   * 回退会把「今日」的数显示在「最近 1 小时 / 最近 7 天」的格子里(正是本次要修的缺陷)。
   * 仅 sub2api / cliproxy + 非 today 窗口 + 确实发起过窗口取数时为 true,
   * 其余源/窗口维持既有回退行为,避免改变 cockpit 的取数口径。
   */
  const rangeWindowAuthoritative = ref(false)
  const stats = ref<DashboardStats | null>(null)
  const trend = ref<CostTrendDataPoint[]>([])
  const trendBucketHours = ref<number | null>(null)
  const trendQueryWindow = ref<UsageQueryWindow | null>(null)
  const sub2apiRequestWindow = ref<UsageQueryWindow | null>(null)
  const sub2apiWindowConnection = ref<{ id: string; baseUrl: string } | null>(null)
  const sub2apiWindowReading = ref<(WindowCostReading & { source: 'sub2api' }) | null>(null)
  const trendUsesAccountCost = ref(false)
  /** usage_logs 兼容聚合被 25,000 条上限截断:true 时趋势只绘制样本覆盖时段,标题如实标注(不补零冒充)。 */
  const trendTruncated = ref(false)
  /**
   * cockpit 窗口快照的真实已过时长(小时)。cockpit 无滚动窗口成本序列,趋势点是"窗口累计",
   * 折算 $/h 必须用窗口真实跨度(since→now),不能用 range 查表桶长
   * (否则 1h 窗口会把"今日累计"当成 1 分钟的量放大 60 倍)。非 cockpit 源为 null。
   */
  const cockpitWindowHours = ref<number | null>(null)
  /**
   * cockpit 成本趋势点的**真实桶长**(小时)。
   * 单请求用量库给出的是逐桶序列(7d/30d = 24h 桶,其余 = 1h 桶),折算 $/h 必须用桶长;
   * 此时 `cockpitWindowHours` 只在趋势退化为"窗口累计单点"时才适用。
   * 2026-09-08 修复:此前一律用窗口累计时长(今日 ≈ 22h)除每个 1 小时桶,
   * 图上每点被压扁 22 倍 → 曲线贴底,看起来像"绘图看不到"。
   */
  const cockpitTrendBucketHours = ref<number | null>(null)
  /** cockpit 实际选中的成本窗口标签(今日累计/本周累计/本月累计),供视图列标注,避免标签与数据不符。
   *  **仅当快照路径确实是数值来源时才有值**;单请求用量库可用时置空,由视图回退到窗口名。 */
  const cockpitWindowRange = ref<CostCenterRange | null>(null)
  const cockpitWindowLabel = computed(() => cockpitWindowRange.value && cockpitStatsSnapshot.value
    ? cockpitWindowLabelForRange(cockpitStatsSnapshot.value, cockpitWindowRange.value) : '')
  /** 成本/请求/模型的数值是否来自单请求用量库(request_logs)的精确 ms 滚动窗口(true = 不是日历快照)。
   *  为 true 时视图**不得**再标"今日/本周/本月累计" —— 那会把 7d 的 6,499 行读成 weekly 快照的 1,075 行。 */
  const cockpitCostFromRequestLog = ref(false)
  /**
   * **模型表**的数值是否来自单请求用量库(双轨:模型区有自己的 `modelCostRange`)。
   *
   * ★ 2026-09-24 新增:模型区不能复用 `cockpitCostFromRequestLog` —— 那个是按**主窗口**
   * (`range`)算的。模型区分离后两轨窗口不同,复用会把模型表的来源按顶部窗口判定
   * (项目里「同值双轨」抓不到的那类错配)。模型表两条装载路径
   * (`loadFromCockpit` 与 `loadCockpitModelWindow`)都写这个 flag。
   */
  const modelCostFromRequestLog = ref(false)
  /**
   * 最近一次 `loadFromCockpit` 收到的 cockpit 快照。
   *
   * ★ 2026-09-24 新增:模型区**独立窗口**重算(`loadCockpitModelWindow`)拿不到快照参数
   * (它是 `loadFromCockpit` 的形参),此前只能给 `cockpitModelsToModelStats` 传 `undefined`
   * ⇒ 该函数 `if (!window?.models) return []` 直接返回空表 ⇒ 用户在模型区切了窗口、
   * 而单请求库在该窗口 0 行时,**模型表整片变空**(而同屏主路径明明会回退到日历快照)。
   * 与 `cockpitModelPriceSets` / `cockpitGroupNameMap` 同一套做法:主路径把独立路径要用的
   * 东西落到 store ref,保证两条路径口径一致。
   */
  const cockpitStatsSnapshot = ref<CockpitStats | null>(null)
  /** Ops 运行趋势是否来自单请求用量库(true=全保留期覆盖;false=日志聚合,可能只有最近几天)。 */
  const opsTrendFromRequestLog = ref(false)
  const models = ref<ModelStat[]>([])
  const modelCostSource = ref<ModelCostSource>('upstream')
  /**
   * 模型成本区**独立**统计窗口(双轨)。
   * 初始跟随顶部主窗口(避免 2026-09-05 那个"默认 1h 不跟主窗口"的老问题),
   * 用户在模型区手动改了才与主窗口分离;视图据此显示"独立窗口"标记。
   */
  const modelCostRange = ref<CostCenterRange>(DEFAULT_COST_CENTER_RANGE)
  const modelCostAccountId = ref<CostAccountId | null>(null)
  const modelAuditMismatchOnly = ref(false)
  /** 模型窗口是否与主窗口分离(true 时模型区数据独立于顶部窗口)。 */
  const modelWindowDetached = ref(false)
  /** cockpit 有效三档价目(单请求库计价用),模型窗口独立重算时复用。 */
  const cockpitModelPriceSets = ref<Record<string, CockpitModelPriceSet>>({})
  const modelAuditSummary = ref<ModelAuditSummary>(summarizeModelAudit([]))
  const modelRoutes = ref<ModelRouteRow[]>([])
  const modelRoutesTruncated = ref(false)
  const modelStatsExactWindowFallback = ref(false)
  const modelStatsCompatibilityTruncated = ref(false)
  const modelPricing = ref<Record<string, ModelDefaultPricing>>({})
  const pricingStatus = ref<PricingCatalogStatus | null>(null)
  const pricingRefreshing = ref(false)
  const opsOverview = ref<OpsDashboardOverview | null>(null)
  const opsTrend = ref<OpsThroughputTrendPoint[]>([])
  const opsErrorTrend = ref<OpsErrorTrendPoint[]>([])
  /** cockpit 源下由单请求用量库派生的账号健康序列(sub2api 源仍用 economics.series)。 */
  const cockpitHealthSeries = ref<AccountEconomicsSnapshot['series']>([])
  const systemSettings = ref<SystemSettings | null>(null)
  const probes = ref<Record<string, AccountProbeState>>({})
  /** cliproxy per-account 历史 latency(CPA usage_events latency_ms 按 auth_index 最新值),供 probe 替代 adminAPI。 */
  const cliproxyLatencyMap = ref<Record<string, number>>({})
  /** cliproxy /api-key-usage 真实请求量(仪表盘同款数据源),按 provider→key→{success,failed}。 */
  const cliproxyKeyUsage = ref<Record<string, Record<string, ApiKeyUsageBucket>>>({})
  /** cliproxy auth-files 真实实体(11 个,provider/status 真实,供 upstreams/pool 分组+健康度)。 */
  const cliproxyAuthFiles = ref<AuthFile[]>([])
  const cliproxyManagementSnapshotAt = ref<string | null>(null)
  let cliproxyManagementSnapshotSource = ''
  const cliproxyLocalAccountLink = ref(false)
  const cliproxyQuotaDataState = ref<'not_loaded' | 'read_unavailable' | 'not_reported' | 'reported'>('not_loaded')
  /** cliproxy 按厂商分组统计(每厂商 model 集合+请求数,保证小众厂商 sensenova 也显示,不被 topModel 吞)。 */
  const cliproxyVendorStats = ref<Record<string, { models: Set<string>; requests: number }>>({})
  /**
   * cliproxy 推理档位分布(CPA `usage_events.reasoning_effort`)。
   *
   * `null` = 尚未读取(与 `[]` = 读到了但窗口内无请求,必须区分 —— 前者不可得、后者是真实的"无")。
   * 空串档位由 `cliproxyEventsToReasoningEfforts` 单列为"未记录档位",不并入任何真实档位。
   */
  const cliproxyReasoningEfforts = ref<CliproxyReasoningEffortRow[] | null>(null)
  /** cliproxy 全局成功率汇总(遍历 cliproxyKeyUsage,仪表盘同款 totalSuccess/totalFailure/successRate)。 */
  const cliproxyUsageSummary = computed(() => {
    let totalSuccess = 0
    let totalFailure = 0
    for (const keys of Object.values(cliproxyKeyUsage.value)) {
      for (const bucket of Object.values(keys)) {
        totalSuccess += bucket.success || 0
        totalFailure += bucket.failed || 0
      }
    }
    const total = totalSuccess + totalFailure
    const successRate = total > 0 ? (totalSuccess / total) * 100 : 0
    return { totalSuccess, totalFailure, total, successRate }
  })
  const sourceStates = ref(createDataSourceStates())
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const lastUpdated = ref<Date | null>(null)
  const exchangeRate = ref<UsdCnyExchangeRate>({
    rate: CNY_PER_USD,
    rateDate: null,
    fetchedAt: null,
    source: 'fallback',
  })
  let requestSequence = 0
  let sub2apiRequestRange: CostCenterRange | null = null
  let cliproxyQueryNow: Date | null = null
  let economicsRequestSequence = 0
  let remoteEconomicsScope = ''
  let lastAccountUsageSyncAt = 0
  let accountUsageScope = ''
  let quotaRefresh = Promise.resolve()

  const accountStats = computed(() => (account: Account): AccountWindowUsage | null => {
    if (!hasMeasuredData(sourceStates.value.todayStats)) return null
    // 2026-09-16 C2:缺失账号此前回退 emptyTodayStats()(全 0),于是 `$0.0000` 被渲染成绿色"实测"。
    // 0 与"无数据"在值上不可区分 —— 返回 null,让调用方走"无数据"分支(这是唯一诚实的做法)。
    return todayStats.value[String(account.id)] ?? null
  })

  /** 观察窗口(window)逐账号用量;该账号在本窗口无记录时返 null。
   *  返回 AccountWindowUsage(成本/Token 可空):缺该账号时只有真实请求数,成本不可测。
   *  是否允许调用方回退自然日由 `rangeWindowAuthoritative` 决定 —— 窗口源已被请求时
   *  (sub2api 的 7d/30d)缺失就是"无数据",回退会把今日数显示在窗口格子里。 */
  const rangeStats = computed(() => (account: Account): AccountWindowUsage | null =>
    rangeAccountStats.value[String(account.id)] ?? null)

  function setSourceState(key: CostCenterSourceKey, status: DataAvailability, reason: string | (() => string) = '') {
    sourceStates.value[key] = sourceState(key, status, reason)
  }

  function rejectedReason(result: PromiseRejectedResult, fallback: string): string {
    const reason = result.reason
    return reason instanceof Error && reason.message ? costDataText('sourceErrorOriginalText', { detail: reason.message }) : fallback
  }

  /**
   * usage_logs 客户端精确窗口聚合(官方内核 parseTimeRange 只认日精度 start_date/end_date,
   * 忽略 start_time/end_time,快照窗口永远不精确时的兜底路径)。
   * 2026-09-05 修复"数据搞没了":此前超过 25,000 条(25 页 × 1000)直接 throw,
   * 趋势清空 + 数据源标 unavailable——繁忙服务器上 7d/30d 的 sub2api 数据整体消失。
   * 现在如实返回截断样本:truncated=true + coverageStart=窗口内最早样本时间,
   * 由调用方只绘制真实覆盖到的时段并在标题标注,不补零冒充"没有请求"。
   */
  async function loadUsageLogCompatibilityTrend(range: CostCenterRange, sharedLogs?: { logs: ApiAdminUsageLog[]; truncated: boolean }, sequence?: number, bounds = usageWindowBounds(range), current?: () => boolean): Promise<{
    points: CostTrendDataPoint[]
    truncated: boolean
    coverageStart: Date | null
    logs: ApiAdminUsageLog[]
  }> {
    const { start, end } = bounds
    const { logs, truncated } = sharedLogs ?? await loadModelRouteLogs(range, null, sequence, { start, end }, current)

    // start_date/end_date 是日精度,取回的日志可能超出 [start,end)(如窗口起点当天的 00:00 起),
    // 聚合前先裁剪;coverageStart 取窗口内最早样本,代表截断样本的真实覆盖起点。
    const windowLogs = logs.filter((log) => {
      const createdAt = parseTrendDate(log.created_at).getTime()
      return createdAt >= start.getTime() && createdAt < end.getTime()
    })
    const oldestInWindow = windowLogs.reduce((oldest, log) => {
      const createdAt = parseTrendDate(log.created_at).getTime()
      return Number.isFinite(createdAt) && createdAt < oldest ? createdAt : oldest
    }, Number.POSITIVE_INFINITY)
    return {
      points: aggregateUsageWindow(windowLogs, range, start, end),
      truncated,
      coverageStart: truncated && Number.isFinite(oldestInWindow) ? new Date(oldestInWindow) : null,
      logs: windowLogs,
    }
  }

  function requireSub2apiAccountId(id: CostAccountId): number {
    const connection = captureAuthConnection().connection
    if ((connection && connection.type !== 'sub2api') || activeSourceKey.value === 'cockpit' || activeSourceKey.value === 'cliproxy') {
      throw new Error(costDataText('theCurrentSourceIsNotSub2apiAdminAccountCalls'))
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error(costDataText('aSub2apiAccountIdMustBeItsOriginalPositive'))
    return id
  }

  async function loadModelRouteLogs(range: CostCenterRange, accountId: CostAccountId | null, sequence?: number, bounds = usageWindowBounds(range), current?: () => boolean): Promise<{ logs: ApiAdminUsageLog[]; truncated: boolean }> {
    const { start, end } = bounds
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const remoteAccountId = accountId == null ? undefined : requireSub2apiAccountId(accountId)
    const logs: ApiAdminUsageLog[] = []
    const seen = new Set<number>()
    let reachedWindowStart = false

    for (let page = 1; page <= MAX_USAGE_PAGES; page += 1) {
      if ((sequence != null && sequence !== requestSequence) || (current && !current())) break
      const response = await adminAPI.usage.list({
        page,
        page_size: USAGE_PAGE_SIZE,
        account_id: remoteAccountId,
        start_date: localDateParameter(start),
        end_date: localDateParameter(new Date(end.getTime() - 1)),
        timezone,
        sort_by: 'created_at',
        sort_order: 'desc',
        exact_total: false,
      })
      const items = response.items ?? []
      if ((sequence != null && sequence !== requestSequence) || (current && !current())) break
      for (const log of items) {
        if (Number.isInteger(log.id) && log.id > 0) {
          if (seen.has(log.id)) continue
          seen.add(log.id)
        }
        logs.push(log)
      }
      const oldest = items.at(-1)
      const oldestTime = oldest ? parseTrendDate(oldest.created_at).getTime() : Number.NEGATIVE_INFINITY
      if (items.length < USAGE_PAGE_SIZE || oldestTime < start.getTime()) {
        reachedWindowStart = true
        break
      }
    }

    return {
      logs: logs.filter((log) => {
        const createdAt = parseTrendDate(log.created_at).getTime()
        return createdAt >= start.getTime() && createdAt < end.getTime()
      }),
      truncated: !reachedWindowStart,
    }
  }

  function invalidatePendingRequest() {
    requestSequence += 1
    economicsRequestSequence += 1
  }

  /** 清空"观察窗口"快照与 cockpit 派生序列。
   *
   *  这些 ref **只由 cockpit 路径写入**(rangeAccountStats / cockpitHealthSeries 都在
   *  loadFromCockpit 里写),但 UI 在 cliproxy/sub2api 源下仍会渲染它们:
   *  号池表的成本/请求列吃 rangeAccountStats,三源共享 overview 面板的健康图吃 cockpitHealthSeries。
   *  不清理就会把 cockpit 的数字冒充成当前源的数据,而表头标的是当前源的 rangeLabel ——
   *  数据跨源 + 标签不符,双重错误。
   *
   *  本函数**不发任何 HTTP 请求**,所以 cliproxy 装载路径也能安全调用
   *  (那条路径不调 reload();调了会去打 sub2api 的 adminAPI)。
   */
  function resetRangeWindowState() {
    rangeAccountStats.value = {}
    rangeAccountStatsComplete.value = false
    rangeAccountStatsWindow.value = null
    rangeAccountStatsScope.value = null
    cliproxyQuotaDataState.value = 'not_loaded'
    // 每次装载先复位"窗口源权威"标记:它决定视图是否允许回退自然日,
    // 残留会让切回短窗口/别的源后仍然禁止回退(该回退是那些路径的正常行为)。
    rangeWindowAuthoritative.value = false
    cockpitWindowHours.value = null
    cockpitTrendBucketHours.value = null
    opsTrendFromRequestLog.value = false
    cockpitWindowRange.value = null
    cockpitCostFromRequestLog.value = false
    // 切离 cockpit 时模型区来源标记与快照一并复位,避免残留上一次的 cockpit 快照
    // 被模型区独立窗口重算当成当前源(跨源串味)。
    modelCostFromRequestLog.value = false
    // 2026-09-16:此前漏了这一项 —— reload() 清窗口快照时没带上它,cliproxy 路径更是完全不清,
    // 于是连 sub2api/cliproxy 时健康图画的是 cockpit 的序列。
    cockpitHealthSeries.value = []
    // D5:systemSettings 只由 cockpit(loadFromCockpit)与 sub2api(reload)写入,cliproxy 既不写也不清。
    // 残留后 CostCenterView 的 schedulerBaseScoreMax → resolveSchedulerBaseScoreMax 会拿
    // **cockpit 的路由权重和**当归一化分母去归一化 cliproxy auth-files 的真实 weight(null 时兜底 4)。
    // 本函数由 reload()(sub2api/cockpit)与 loadFromCliproxy() 调用,两边都能覆盖。
    systemSettings.value = null
  }

  /**
   * 当前数据源 —— 由各装载入口**自己登记**(reload/loadFromCockpit/loadFromCliproxy/clearCockpitSourceData)。
   *
   * 不读 connectionStore:本 composable 被单测直接调用(useCostCenterData.spec.ts /
   * modelCostAccountFilter.spec.ts / cockpitHonestyRegression.spec.ts),那里没有 active Pinia,
   * 调 useConnectionStore() 会抛 getActivePinia。各装载入口本来就精确知道自己装的是哪个源,
   * 登记比反查连接更可靠。null = 尚未装载过任何源 → 下游判定一律按"不掌握"处理。
   */
  const activeSourceKey = ref<'sub2api' | 'cliproxy' | 'cockpit' | null>(null)

  /**
   * 跨源状态闸门 —— 只在**源真的变了**时清空,同源 reload 一律保留。
   *
   * 为什么不塞进 resetRangeWindowState():后者每次 reload() 都跑,
   * 自动刷新默认 30s 一次(autoRefresh=true / refreshIntervalSeconds=30),那样会反复抹掉
   * 用户主动操作的结果 —— 刚点的「检测真实上游连接耗时」/ 刚分离的模型窗口。
   */
  let lastSourceKey: 'sub2api' | 'cliproxy' | 'cockpit' | null = null
  function applySourceKey(sourceKey: 'sub2api' | 'cliproxy' | 'cockpit') {
    activeSourceKey.value = sourceKey
    if (lastSourceKey === sourceKey) return
    trendQueryWindow.value = null
    trendBucketHours.value = null
    sub2apiRequestWindow.value = null
    sub2apiWindowConnection.value = null
    sub2apiWindowReading.value = null
    sub2apiRequestRange = null
    cliproxyQueryNow = null
    lastSourceKey = sourceKey
    lastAccountUsageSyncAt = 0
    accountUsageScope = ''
    economicsRequestSequence += 1
    // E6:探测结果按账号 id 索引,而 id 是 FNV-1a hash —— 跨源切换后 id 可能撞车,
    // 会把**上一源**的探测结果当本源的实测值渲染(UpstreamProbeCell / oauthUnverifiedCount /
    // describeCurrentAccountState / 延迟排序都直接读它),等于拿别端的探测冒充本源的实测。
    probes.value = {}
    // G1:modelWindowDetached 只在 cockpit 路径写(loadCockpitModelWindow),它是「模型窗口与
    // 顶部窗口分离」的状态。跨源后若残留 true:
    //   ① 视图 watch(range) 的 `if (!modelWindowDetached) modelCostRange = next` 被短路
    //      → 顶部切窗口不再同步模型窗口(功能性错误,不只是文案);
    //   ② 模型区持续挂「独立窗口（顶部为 …）」提示。
    // 只在**源变化**时清,同源自动刷新不动 —— 否则用户刚点的「分离」会被 30s 一次的刷新抹掉。
    modelWindowDetached.value = false
  }

  /**
   * G4:模型区三个控件在**不参与取数的源**下必须禁用,否则用户以为它生效了。
   * 单一判定入口,视图侧按 `:disabled="modelCostControlsDisabled.account"` 接线。
   *
   * - account(「成本账号」modelCostAccountId):sub2api 把它传成 account_id、cockpit 传进
   *   filterCockpitRequestLogByAccount —— 两处都真的消费;cliproxy 的 loadFromCliproxy 全程不引用它,
   *   选了账号只会触发整轮重取而数字一点不变(假控件)。
   * - mismatchOnly(「仅看不一致」modelAuditMismatchOnly):只有 reload()(sub2api 路径)把它
   *   传给 upstream_model_mismatch → cliproxy 与 cockpit 下都是空操作。
   * - source(「模型口径」modelCostSource):只有 reload() 把它传给 model_source;cliproxy 的
   *   cliproxyEventsToModelStats 无此参数,而 modelCostSourceLabel 仍随选择变化 → 声称了一个没生效的口径。
   *   (窗口 `modelCostRange` 不在此列 —— 2026-09-23 起 cliproxy 由 loadFromCliproxy 的 modelRange
   *   在本地按 requested_at 过滤,该选择器对三源都真的生效。)
   *
   * activeSourceKey 为 null(尚未装载)= 不掌握 → 三个都禁用,不假装控件生效。
   */
  const modelCostControlsDisabled = computed(() => {
    const src = activeSourceKey.value
    return {
      account: src !== 'sub2api' && src !== 'cockpit',
      mismatchOnly: src !== 'sub2api',
      source: src !== 'sub2api',
    }
  })

  /**
   * D6:cockpit 未安装 / codex_local_access_stats.json 缺失(getCockpitStats() 返 null)时的显式清空。
   *
   * CostCenterView 的 cockpit 分支此前把 loadFromCockpit 包在 `if (cockpitStats.value)` 里,
   * stats 缺失时整段跳过 → store 保留**上一连接源**(sub2api/cliproxy)的
   * accounts/todayStats/models/trend/accountUsage/opsOverview/modelRoutes/…,
   * 而 connectionType === null 让所有文案标成「cockpit …」= 用 cockpit 的文案渲染别端的数字。
   * 按「不是当前源的数据必须清掉,不得复用别端的数字」显式置空,并把相关 sourceStates 标 unavailable。
   *
   * 同时收尾 loading:只有 loadFromCockpit 末尾会把它置回 false,跳过它必须自己置,
   * 否则 reload() 因 loading 恒真而永久早退,页面卡在加载态。
   */
  function clearCockpitSourceData(reason: string) {
    accounts.value = []
    todayStats.value = {}
    models.value = []
    trend.value = []
    trendBucketHours.value = null
    trendQueryWindow.value = null
    trendTruncated.value = false
    trendUsesAccountCost.value = false
    accountUsage.value = {}
    accountEconomics.value = null
    opsOverview.value = null
    opsTrend.value = []
    opsErrorTrend.value = []
    modelRoutes.value = []
    modelRoutesTruncated.value = false
    modelAuditSummary.value = summarizeModelAudit([])
    modelPricing.value = {}
    pricingStatus.value = null
    cockpitModelPriceSets.value = {}
    cockpitGroupNameMap.value = new Map()
    // 快照随 cockpit 数据一起清掉:模型区独立窗口重算靠它回退日历快照,
    // 留着旧快照会在切到 sub2api/cliproxy 后仍按 cockpit 快照出数(跨源串味)。
    cockpitStatsSnapshot.value = null
    stats.value = null
    modelStatsExactWindowFallback.value = false
    modelStatsCompatibilityTruncated.value = false
    costLossStates.value = []
    systemSettings.value = null
    // E6:cockpit 源文件缺失时不走 loadFromCockpit,这条路径也要清账号级探测结果
    applySourceKey('cockpit')
    resetRangeWindowState()
    const unavailableKeys: CostCenterSourceKey[] = [
      'accounts', 'todayStats', 'rangeStats', 'models', 'dashboard', 'accountUsage',
      'economics', 'ops', 'modelRoutes', 'modelAudit', 'pricing', 'settings', 'costLoss',
    ]
    for (const key of unavailableKeys) setSourceState(key, 'unavailable', () => (reason))
    lastUpdated.value = new Date()
    loading.value = false
    error.value = ''
  }

  async function reload(
    range: CostCenterRange = DEFAULT_COST_CENTER_RANGE,
    options: { background?: boolean } = {},
  ) {
    const connection = captureAuthConnection().connection
    if ((connection && connection.type !== 'sub2api') || (!connection && activeSourceKey.value && activeSourceKey.value !== 'sub2api')) {
      throw new Error(costDataText('theCurrentSourceIsNotSub2apiUseItsLocal'))
    }
    const sequence = ++requestSequence
    const keepVisibleSnapshot = options.background === true && lastUpdated.value != null
    loading.value = true
    error.value = ''
    // 每次重载先清空观察窗口快照:避免切到 sub2api/cliproxy 源时残留上一次 cockpit 的窗口数据
    resetRangeWindowState()
    // E6:账号级探测结果按源隔离(同源后台刷新保留,见 applySourceKey)
    applySourceKey('sub2api')
    if (!keepVisibleSnapshot) {
      for (const key of COST_CENTER_SOURCE_KEYS) {
        if (key !== 'economics') sourceStates.value[key] = sourceState(key, 'loading', () => (costDataText('refreshing')))
      }
    }
    const modelRange = modelCostRange.value
    const queries = buildCostCenterDataQueries(range, modelRange)
    const queryNow = new Date()
    const { start: observationStart } = usageWindowBounds(range, queryNow)
    const observationEnd = queryNow
    const usageConnectionContext = captureAuthConnection()
    const currentRequest = () => sequence === requestSequence && isAuthConnectionCurrent(usageConnectionContext) && getSub2apiTargetBase() === usageConnectionContext.targetBase
    const origin = usageConnectionContext.connection
    const usageScope = `${origin?.id ?? ''}|${usageConnectionContext.targetBase}`
    if (usageScope !== accountUsageScope) {
      accountUsageScope = usageScope
      lastAccountUsageSyncAt = 0
      accountUsage.value = {}
    }
    const windowConnection = origin?.type === 'sub2api' ? { id: origin.id, baseUrl: origin.baseUrl } : null
    sub2apiRequestWindow.value = { start: observationStart, end: observationEnd }
    sub2apiRequestRange = range
    sub2apiWindowConnection.value = windowConnection
    sub2apiWindowReading.value = null
    if (!keepVisibleSnapshot) {
      trendQueryWindow.value = null
      trendBucketHours.value = null
    }
    const { start: modelStart } = modelRange === range ? { start: observationStart } : usageWindowBounds(modelRange, queryNow)
    const modelEnd = queryNow
    const selectedModelAccountId = modelCostAccountId.value
    const selectedModelSource = modelCostSource.value
    const mismatchOnly = modelAuditMismatchOnly.value
    const modelRouteResult = Promise.allSettled([loadModelRouteLogs(modelRange, selectedModelAccountId, sequence, { start: modelStart, end: modelEnd }, currentRequest)]).then(([result]) => result)
    const observationLogResult = modelRange === range && selectedModelAccountId == null
      ? modelRouteResult
      : Promise.allSettled([loadModelRouteLogs(range, null, sequence, { start: observationStart, end: observationEnd }, currentRequest)]).then(([result]) => result)

    const [accountResult, costLossResult, dashboardResult, modelResult, channelsResult, pricingStatusResult, opsResult, settingsResult, exchangeRateResult] = await Promise.allSettled([
      readAllPages((page) => adminAPI.accounts.list(page, 1000, {
        include_scheduler_score: 'true',
        sort_by: 'id',
        sort_order: 'asc',
      }), currentRequest),
      adminAPI.accounts.listCostLossStates(),
      adminAPI.dashboard.getSnapshotV2({
        ...queries.observation,
        start_time: observationStart.toISOString(),
        end_time: observationEnd.toISOString(),
        include_stats: true,
        include_trend: true,
        include_model_stats: false,
        include_group_stats: false,
        include_users_trend: false,
      }),
      (async () => adminAPI.dashboard.getSnapshotV2({
        ...queries.model,
        start_time: modelStart.toISOString(),
        end_time: modelEnd.toISOString(),
        account_id: selectedModelAccountId == null ? undefined : requireSub2apiAccountId(selectedModelAccountId),
        model_source: selectedModelSource,
        upstream_model_mismatch: mismatchOnly ? true : undefined,
        include_stats: false,
        include_trend: false,
        include_model_stats: true,
        include_group_stats: false,
        include_users_trend: false,
      }))(),
      readAllPages((page) => adminAPI.channels.list(page, 1000, { sort_by: 'id', sort_order: 'asc' }), currentRequest),
      adminAPI.channels.getPricingStatus(),
      adminAPI.ops.getDashboardSnapshotV2(range === 'today'
        ? { start_time: observationStart.toISOString(), end_time: observationEnd.toISOString(), mode: 'auto' }
        : { time_range: buildOpsSnapshotRange(range), mode: 'auto' }),
      adminAPI.settings.getSettings(),
      loadUsdCnyExchangeRate(),
    ])

    if (!currentRequest()) return
    costLossStates.value = costLossResult.status === 'fulfilled' ? costLossResult.value.states ?? [] : []
    setSourceState(
      'costLoss',
      costLossResult.status === 'fulfilled'
        ? (costLossStates.value.length ? 'measured' : 'empty')
        : 'unavailable',
      () => (costLossResult.status === 'fulfilled'
        ? (costLossStates.value.length ? costDataText('immutableLossLedgerLoaded') : costDataText('theLedgerHasNoTerminalLossEvents'))
        : rejectedReason(costLossResult, costDataText('failedToReadTheTerminalLossLedger'))),
    )

    setSourceState(
      'accounts',
      accountResult.status === 'fulfilled'
        ? ((accountResult.value.items ?? []).length ? 'measured' : 'empty')
        : 'unavailable',
      () => (accountResult.status === 'fulfilled'
        ? ((accountResult.value.items ?? []).length ? costDataText('accountsAndSchedulingFieldsLoaded') : costDataText('noCurrentAccounts'))
        : rejectedReason(accountResult, costDataText('failedToReadTheAccountInventory'))),
    )

    setSourceState(
      'dashboard',
      dashboardResult.status === 'fulfilled'
        ? ((dashboardResult.value.trend ?? []).length || dashboardResult.value.stats ? 'measured' : 'empty')
        : 'unavailable',
      () => (dashboardResult.status === 'fulfilled' ? costDataText('usageLogsAggregatesLoaded') : rejectedReason(dashboardResult, costDataText('failedToReadCostTrends'))),
    )

    const dashboardWindowIsExact = dashboardResult.status === 'fulfilled'
      && snapshotMatchesRequestedWindow(dashboardResult.value, observationStart, observationEnd)
    if (!dashboardWindowIsExact) {
      if (!keepVisibleSnapshot) trend.value = []
      setSourceState('dashboard', 'partial', () => (costDataText('aggregatingExactWindowLogsUsageIsNotCompleteYet')))
    } else if (dashboardResult.status === 'fulfilled') {
      trendBucketHours.value = ({ minute: 1 / 60, hour: 1, day: 24 } as Record<string, number>)[dashboardResult.value.granularity] ?? null
      trendQueryWindow.value = { start: observationStart, end: observationEnd }
      trend.value = dashboardResult.value.granularity === 'minute' && (range === '30m' || range === '1h')
        ? fillCostTrendBuckets(dashboardResult.value.trend ?? [], range, observationStart, observationEnd)
        : (dashboardResult.value.trend ?? [])
      trendTruncated.value = false
      trendUsesAccountCost.value = false
    }
    if (modelResult.status === 'fulfilled' && snapshotMatchesRequestedWindow(modelResult.value, modelStart, modelEnd)) {
      models.value = sourceModelStats(modelResult.value.models ?? [])
      setSourceState('models', models.value.length ? 'measured' : 'empty', () => (costDataText('modelCostWindowLoaded')))
    }

    pricingStatus.value = pricingStatusResult.status === 'fulfilled' ? pricingStatusResult.value : null
    setSourceState('pricing', pricingStatusResult.status === 'fulfilled' ? 'measured' : 'unavailable', () => (pricingStatusResult.status === 'fulfilled' ? costDataText('priceCatalogStatusLoaded') : rejectedReason(pricingStatusResult, costDataText('failedToReadPriceCatalogStatus'))))

    if (opsResult.status === 'fulfilled') {
      opsOverview.value = opsResult.value.overview
      opsTrend.value = opsResult.value.throughput_trend?.points ?? []
      opsErrorTrend.value = opsResult.value.error_trend?.points ?? []
      setSourceState(
        'ops',
        opsTrend.value.length ? 'measured' : 'empty',
        () => (opsTrend.value.length ? costDataText('operationalQualityDataLoaded') : costDataText('theSelectedWindowHasNoOperationalSamplesToPlot')),
      )
    } else {
      // Ops monitoring is feature-gated. The cost console remains useful without it.
      opsOverview.value = null
      opsTrend.value = []
      opsErrorTrend.value = []
      setSourceState('ops', 'unavailable', () => (rejectedReason(opsResult, costDataText('operationalMonitoringIsDisabledOrCouldNotBeRead'))))
    }

    systemSettings.value = settingsResult.status === 'fulfilled' ? settingsResult.value : null
    setSourceState('settings', settingsResult.status === 'fulfilled' ? 'measured' : 'unavailable', () => (settingsResult.status === 'fulfilled' ? costDataText('schedulerSettingsLoaded') : rejectedReason(settingsResult, costDataText('failedToReadSchedulerSettings'))))
    // 汇率:loadUsdCnyExchangeRate 内部 override > cache > 网络实时 > 兜底 CNY_PER_USD
    if (exchangeRateResult.status === 'fulfilled') {
      exchangeRate.value = exchangeRateResult.value
      setSourceState('exchangeRate', exchangeRate.value.source === 'network' ? 'measured' : 'estimated', () => (exchangeRate.value.source === 'network' ? costDataText('onlineReferenceExchangeRate') : exchangeRate.value.source === 'cache' ? costDataText('usingTheExchangeRateCacheUpTo12Hours') : exchangeRate.value.source === 'override' ? costDataText('manualOverrideCnyUsd', { p0: exchangeRate.value.rate }) : costDataText('usingTheFixedReferenceRateCnyUsd', { p0: CNY_PER_USD })))
    } else {
      // 网络失败:读用户 override,否则固定 CNY_PER_USD
      const overrideRate = getStoredUserOverrideRate()
      if (overrideRate) {
        exchangeRate.value = overrideRate
        setSourceState('exchangeRate', 'estimated', () => (costDataText('manualOverrideCnyUsdNetworkFailed', { p0: overrideRate.rate })))
      } else {
        exchangeRate.value = { rate: CNY_PER_USD, rateDate: null, fetchedAt: null, source: 'fallback' }
        setSourceState('exchangeRate', 'estimated', () => (costDataText('networkFailedUsingTheFixedReferenceRateCnyUsd', { p0: CNY_PER_USD })))
      }
    }

    if (accountResult.status === 'fulfilled') {
      accounts.value = accountResult.value.items ?? []
      const ids = accounts.value.map((account) => requireSub2apiAccountId(account.id))
      if (ids.length > 0) {
        try {
          const localDayStart = new Date()
          localDayStart.setHours(0, 0, 0, 0)
          const batch = await adminAPI.accounts.getBatchTodayStats(ids, localDayStart.toISOString())
          if (currentRequest()) {
            todayStats.value = batch.stats ?? {}
            setSourceState('todayStats', Object.keys(todayStats.value).length ? 'measured' : 'empty', () => (Object.keys(todayStats.value).length ? costDataText('sourceCalendarDayAccountStatisticsLoaded') : costDataText('noAccountUsageInTheSourceCalendarDay')))
          }
        } catch (batchError) {
          if (!currentRequest()) return
          console.warn('[cost-center] account today stats unavailable', batchError)
          todayStats.value = {}
          setSourceState('todayStats', 'unavailable', () => (batchError instanceof Error ? batchError.message : costDataText('failedToReadAccountStatisticsForToday')))
        }
      } else {
        todayStats.value = {}
        setSourceState('todayStats', 'empty', () => (costDataText('noCurrentAccounts')))
      }

      if (!currentRequest()) return
      rangeWindowAuthoritative.value = rangeNeedsAccountWindow(range)
      setSourceState('rangeStats', rangeNeedsAccountWindow(range) ? 'loading' : 'empty', () => (rangeNeedsAccountWindow(range)
        ? costDataText('waitingForExactUsageLogsAggregatesCalendarDayTotals')
        : costDataText('accountStatisticsForTodayUseTheCalendarDay')))

      const usageAccounts = accounts.value.filter(shouldLoadUsageWindow)
      // Quota refresh is independent of usage_logs costs; publish its own eventual state.
      // Superseded in-flight calls still occupy the same four slots until they finish.
      quotaRefresh = quotaRefresh.then(async () => {
        if (!currentRequest()) return
        const usageCacheIsFresh = Date.now() - lastAccountUsageSyncAt < ACCOUNT_USAGE_CACHE_TTL_MS
        if (usageAccounts.length === 0) {
          setSourceState('accountUsage', 'empty', () => (costDataText('theCurrentAccountTypesDoNotProvideUpstreamQuota')))
        } else if (!usageCacheIsFresh || usageAccounts.some((account) => !accountUsage.value[String(account.id)])) {
          const usageResults: PromiseSettledResult<AccountUsageInfo>[] = []
          let next = 0
          const worker = async () => {
            while (currentRequest() && next < usageAccounts.length) {
              const index = next++
              const account = usageAccounts[index]
              try {
                usageResults[index] = { status: 'fulfilled', value: await adminAPI.accounts.getUsage(requireSub2apiAccountId(account.id), accountUsageSource(account)) }
              } catch (reason) { usageResults[index] = { status: 'rejected', reason } }
            }
          }
          await Promise.all(Array.from({ length: Math.min(MAX_QUOTA_REQUESTS, usageAccounts.length) }, worker))
          if (!currentRequest()) return
          const nextUsage: Record<string, AccountUsageInfo> = {}
          usageAccounts.forEach((account, index) => {
            const result = usageResults[index]
            if (result.status === 'fulfilled') nextUsage[String(account.id)] = result.value
            else if (accountUsage.value[String(account.id)]) nextUsage[String(account.id)] = accountUsage.value[String(account.id)]
          })
          accountUsage.value = nextUsage
          const succeeded = usageResults.filter((result) => result.status === 'fulfilled').length
          if (succeeded === usageAccounts.length) lastAccountUsageSyncAt = Date.now()
          const retained = usageAccounts.filter((account) => accountUsage.value[String(account.id)]).length
          setSourceState(
            'accountUsage',
            succeeded === usageAccounts.length ? 'measured' : retained > 0 ? 'partial' : 'unavailable',
            () => (succeeded === usageAccounts.length ? costDataText('upstreamQuotaWindowsSynchronized') : costDataText('quotaWindowsSynchronizedInThisRefresh', { p0: succeeded, p1: usageAccounts.length })),
          )
        } else {
          setSourceState('accountUsage', 'measured', () => (costDataText('usingQuotaWindowsFromTheLastSuccessfulSyncWithin')))
        }
      })
    } else {
      accounts.value = []
      todayStats.value = {}
      accountUsage.value = {}
      setSourceState('todayStats', 'unavailable', () => (costDataText('accountInventoryUnavailableCannotReadStatisticsForToday')))
      setSourceState('accountUsage', 'unavailable', () => (costDataText('accountInventoryUnavailableCannotReadQuotaWindows')))
      // 账号清单拿不到 ⇒ 逐账号窗口统计无从发起。非 today 窗口下视图据此显示"无数据 + 原因",
      // 而不是把别的窗口的数填进窗口格子。
      rangeAccountStats.value = {}
      setSourceState('rangeStats', 'unavailable', () => (costDataText('accountInventoryUnavailableCannotReadPerAccountWindowUsage')))
      rangeWindowAuthoritative.value = rangeNeedsAccountWindow(range)
    }

    if (!currentRequest()) return

    const modelRoutesResult = await modelRouteResult
    if (!currentRequest()) return
    const observationLogsResult = await observationLogResult
    if (!currentRequest()) return
    const sharedLogs = observationLogsResult.status === 'fulfilled' ? observationLogsResult.value : undefined
    let accountWindowLogs = sharedLogs ?? null
    const compatibilityTrend = dashboardWindowIsExact ? null : (async () => {
      if (observationLogsResult.status === 'rejected') throw observationLogsResult.reason
      return loadUsageLogCompatibilityTrend(range, observationLogsResult.value, sequence, { start: observationStart, end: observationEnd }, currentRequest)
    })()
    stats.value = dashboardResult.status === 'fulfilled' ? dashboardResult.value.stats ?? null : null
    if (compatibilityTrend) {
      try {
        const { points, truncated, coverageStart, logs } = await compatibilityTrend
        accountWindowLogs = { logs, truncated }
        if (!currentRequest()) return
        // 截断样本只绘制真实覆盖到的时段:更早的桶没有数据,补零会把"没读到"冒充"没有请求"。
        // coverageStart 可能落在窗口起点当天 00:00(日精度参数多取),裁剪回请求窗口内。
        const trendStart = truncated && coverageStart
          ? new Date(Math.max(coverageStart.getTime(), observationStart.getTime()))
          : observationStart
        trend.value = fillCostTrendBuckets(points, range, trendStart, observationEnd)
        trendBucketHours.value = costTrendBucketHours(range)
        trendQueryWindow.value = { start: trendStart, end: observationEnd }
        trendTruncated.value = truncated
        trendUsesAccountCost.value = true
        if (truncated) {
          setSourceState('dashboard', 'partial', () => (costDataText('theWindowExceedsUsageLogsRowsTrendsIncludeOnly', { p0: USAGE_LOGS_SAFE_READ_CAP, p1: shortLocalStamp(coverageStart) })))
        } else {
          setSourceState('dashboard', trend.value.some((point) => Number(point.requests || 0) > 0) ? 'partial' : 'empty', () => (costDataText('theDashboardWindowIsNotExactRebuiltFromUsage')))
        }
      } catch (compatibilityError) {
        if (!currentRequest()) return
        console.warn('[cost-center] exact usage log aggregation unavailable', compatibilityError)
        trend.value = []
        trendBucketHours.value = null
        trendQueryWindow.value = null
        trendTruncated.value = false
        trendUsesAccountCost.value = false
        setSourceState('dashboard', 'unavailable', () => (compatibilityError instanceof Error ? compatibilityError.message : costDataText('usageLogsCompatibilityAggregationFailed')))
        error.value = compatibilityError instanceof Error
          ? compatibilityError.message
          : costDataText('theUpstreamCoreCannotProvideAnExactWindowAnd')
      }
    } else if (dashboardResult.status !== 'fulfilled') {
      trend.value = []
      trendBucketHours.value = null
      trendQueryWindow.value = null
      trendTruncated.value = false
      trendUsesAccountCost.value = false
    }

    if (accountWindowLogs && windowConnection) {
      sub2apiWindowReading.value = { ...aggregateSub2apiWindowLogs(accountWindowLogs.logs, windowConnection.id, { start: observationStart, end: observationEnd }, !accountWindowLogs.truncated), source: 'sub2api' }
    }

    if (accountWindowLogs) {
      const logs = accountWindowLogs.logs.filter((log) => {
        const stamp = parseTrendDate(log.created_at).getTime()
        return stamp >= observationStart.getTime() && stamp < observationEnd.getTime()
      })
      const complete = !accountWindowLogs.truncated
      rangeAccountStats.value = accountStatsFromLogs(logs, accounts.value, complete)
      rangeAccountStatsComplete.value = complete
      rangeAccountStatsWindow.value = { start: observationStart, end: observationEnd }
      rangeAccountStatsScope.value = { source: 'sub2api', instanceId: windowConnection?.id ?? null }
      rangeWindowAuthoritative.value = true
      const unknown = hasUnknownAccountFields(rangeAccountStats.value)
      const unassigned = unattributedRequests(rangeAccountStats.value)
      const attributionNote = unassigned ? costDataText('requestsHaveNoAccountAttributionAndAreKeptIn', { p0: unassigned }) : ''
      setSourceState('rangeStats', !complete || unknown || unassigned ? 'partial' : logs.length ? 'measured' : 'empty', () => ((!complete
        ? costDataText('perAccountUsageForIncludesOnlyTheLatestReadable', { p0: costCenterRangeLabel(range), p1: USAGE_LOGS_SAFE_READ_CAP })
        : unknown ? costDataText('exactLogsLoadedSomeAccountUsageOrCostFields')
          : costDataText('perAccountUsageForAggregatedFromExactUsageLogs', { p0: costCenterRangeLabel(range) })) + attributionNote))
      const dayStart = new Date(observationEnd)
      dayStart.setHours(0, 0, 0, 0)
      const oldest = logs.reduce((stamp, log) => Math.min(stamp, parseTrendDate(log.created_at).getTime()), Infinity)
      const coversToday = observationStart <= dayStart && (complete || oldest <= dayStart.getTime())
      if (range === 'today' || coversToday) {
        const todayLogs = logs.filter((log) => parseTrendDate(log.created_at).getTime() >= dayStart.getTime())
        todayStats.value = accountStatsFromLogs(todayLogs, accounts.value, coversToday)
        const todayUnknown = hasUnknownAccountFields(todayStats.value)
        const todayUnassigned = unattributedRequests(todayStats.value)
        setSourceState('todayStats', !coversToday || todayUnknown || todayUnassigned ? 'partial' : todayLogs.length ? 'measured' : 'empty', () => ((!coversToday
          ? costDataText('calendarDayAccountUsageIncludesOnlyReadableLogSamples')
          : todayUnknown ? costDataText('exactCalendarDayLogsLoadedSomeAccountUsageOr')
            : costDataText('localCalendarDayAccountUsageAggregatedFromExactUsage')) + (todayUnassigned ? costDataText('requestsHaveNoAccountAttribution', { p0: todayUnassigned }) : '')))
      }
    } else {
      rangeAccountStats.value = {}
      setSourceState('rangeStats', 'unavailable', () => (observationLogsResult.status === 'rejected' ? rejectedReason(observationLogsResult, costDataText('failedToReadGlobalExactWindowLogs')) : costDataText('noReusableGlobalExactWindowLogsInThisRefresh')))
    }

    const modelCompatibility = modelRoutesResult.status === 'fulfilled'
      ? {
          ...modelRoutesResult.value,
          logs: filterModelAuditLogs(modelRoutesResult.value.logs, mismatchOnly),
        }
      : null
    const modelStatsSelection = selectExactWindowModelStats(
      modelResult.status === 'fulfilled' ? modelResult.value : null,
      modelCompatibility,
      modelStart,
      modelEnd,
      selectedModelSource,
    )
    models.value = modelStatsSelection.models
    modelStatsExactWindowFallback.value = modelStatsSelection.usedCompatibilityAggregation
    modelStatsCompatibilityTruncated.value = modelStatsSelection.compatibilityTruncated
    if (modelResult.status === 'fulfilled') {
      // 截断样本聚合也标记 partial:数值只基于最近 25,000 条,不含更早记录(视图另有警示条)。
      const modelAggregationNote = modelStatsSelection.compatibilityTruncated
        ? costDataText('theWindowExceedsUsageLogsRowsModelTotalsUse', { p0: USAGE_LOGS_SAFE_READ_CAP })
        : costDataText('usingUsageLogsCompatibilityAggregation')
      setSourceState('models', models.value.length ? (modelStatsSelection.usedCompatibilityAggregation ? 'partial' : 'measured') : 'empty', () => (modelStatsSelection.usedCompatibilityAggregation ? modelAggregationNote : models.value.length ? costDataText('modelCostWindowLoaded') : costDataText('noModelCostRecordsInThisWindow')))
    } else if (modelStatsSelection.usedCompatibilityAggregation) {
      setSourceState('models', 'partial', () => (modelStatsSelection.compatibilityTruncated ? costDataText('modelSnapshotUnavailableAggregatedTruncatedUsageLogsSamplesLower') : costDataText('modelSnapshotUnavailableUsingCompleteUsageLogsCompatibilityAggregates')))
    } else {
      setSourceState('models', 'unavailable', () => (rejectedReason(modelResult, costDataText('failedToReadModelCostStatistics'))))
    }
    if (modelRoutesResult.status === 'fulfilled') {
      const channels: Channel[] = channelsResult.status === 'fulfilled' ? channelsResult.value.items ?? [] : []
      modelAuditSummary.value = summarizeModelAudit(modelRoutesResult.value.logs)
      modelRoutes.value = buildModelRouteRows(modelRoutesResult.value.logs, channels)
      modelRoutesTruncated.value = modelRoutesResult.value.truncated
      // upstreamModel 为 null(cockpit 等不提供逐请求上游模型的源)时回退到请求模型 ——
      // 这里是为了拿到单价做查询,不是展示,所以回退是合理的。
      const actualModels = [...new Set(modelRoutes.value.map((row) => row.upstreamModel ?? row.requestedModel))].slice(0, MAX_MODEL_PRICING_LOOKUPS)
      const pricingResults = await Promise.allSettled(actualModels.map((model) => adminAPI.channels.getModelDefaultPricing(model)))
      if (!currentRequest()) return
      modelPricing.value = Object.fromEntries(actualModels.flatMap((model, index) => {
        const result = pricingResults[index]
        return result.status === 'fulfilled' ? [[model, result.value]] : []
      }))
      setSourceState('modelRoutes', modelRoutes.value.length ? (modelRoutesResult.value.truncated || channelsResult.status === 'rejected' ? 'partial' : 'measured') : 'empty', () => (channelsResult.status === 'rejected'
        ? costDataText('channelInventoryIncompleteRetainingRequestRouteSnapshotsOnly', { p0: rejectedReason(channelsResult, costDataText('failedToReadChannelInventory')) })
        : modelRoutesResult.value.truncated ? costDataText('routeRecordsExceedTheReadLimitShowingOnlyThe') : modelRoutes.value.length ? costDataText('modelRouteRecordsLoaded') : costDataText('noRouteRecordsInThisWindow')))
      // FIX 1:sub2api usage_logs 有 upstream_response_model,「模型审计」与 modelRoutes 同一数据面,
      // 状态镜像 modelRoutes;视图 5 个审计格读 modelAudit(与路由明细表用的 modelRoutes 解耦)。
      setSourceState('modelAudit', modelRoutes.value.length ? (modelRoutesResult.value.truncated ? 'partial' : 'measured') : 'empty', () => (modelRoutesResult.value.truncated ? costDataText('routeRecordsExceedTheReadLimitShowingOnlyThe') : modelRoutes.value.length ? costDataText('modelAuditLoadedUsageLogsUpstreamResponseModel') : costDataText('noAuditableRouteRecordsInThisWindow')))
    } else {
      modelAuditSummary.value = summarizeModelAudit([])
      modelRoutes.value = []
      modelRoutesTruncated.value = false
      modelPricing.value = {}
      setSourceState('modelRoutes', 'unavailable', () => (rejectedReason(modelRoutesResult, costDataText('failedToReadModelRouteRecords'))))
      setSourceState('modelAudit', 'unavailable', () => (rejectedReason(modelRoutesResult, costDataText('failedToReadTheModelAudit'))))
    }
    await loadAccountEconomics('all', range, [], { background: keepVisibleSnapshot })
    if (!currentRequest()) return

    if (
      accountResult.status === 'rejected' &&
      dashboardResult.status === 'rejected' &&
      modelResult.status === 'rejected' &&
      modelRoutesResult.status === 'rejected' &&
      opsResult.status === 'rejected'
    ) {
      error.value = costDataText('unableToReadCostCenterDataCheckTheDesktop')
    }

    lastUpdated.value = new Date()
    loading.value = false
  }

  function deriveLoadedEconomics(platform: string, range: CostCenterRange, accountIds: CostAccountId[]) {
    const localCpa = activeSourceKey.value === 'cliproxy'
    const platformKey = economicsPlatformFilter(platform)
    const scopedAccounts = accounts.value.filter((account) => accountIds.length
      ? accountIds.includes(account.id) : !platformKey || account.platform === platformKey)
    const usageState = rangeWindowAuthoritative.value ? sourceStates.value.rangeStats : sourceStates.value.todayStats
    const usageAvailable = hasMeasuredData(usageState)
    const rows = scopedAccounts.map((account) => ({ today: rangeWindowAuthoritative.value
      ? rangeAccountStats.value[String(account.id)] ?? null : todayStats.value[String(account.id)] ?? null }))
    const unassigned = localCpa && !platformKey && !accountIds.length
      ? (rangeWindowAuthoritative.value ? rangeAccountStats.value : todayStats.value)[UNATTRIBUTED_USAGE_ACCOUNT_ID] : null
    if (unassigned) rows.push({ today: unassigned })
    const activeCpaRows = rows.flatMap(row => row.today && row.today.requests > 0 ? [row.today] : [])
    const cpaAmount = (field: 'cost' | 'standard_cost', knownField: 'known_cost' | 'known_standard_cost'): number | null => {
      if (!activeCpaRows.length) return 0
      const amounts = activeCpaRows.flatMap(row => {
        const complete = finiteOrNull(row[field])
        if (complete != null) return [complete]
        const known = finiteOrNull(row[knownField])
        return known != null && (row.unknown_cost_requests ?? row.requests) < row.requests ? [known] : []
      })
      return amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null
    }
    const billedUsd = localCpa ? cpaAmount('standard_cost', 'known_standard_cost') : rows.reduce<number | null>((sum, row) => {
      if (sum == null || !row.today) return sum
      const billed = finiteOrNull(row.today.user_cost)
      return billed == null ? null : sum + billed
    }, 0)
    const lossMap = new Map<CostAccountId, AccountCostLossState>(costLossStates.value.map((loss) => [loss.account_id, loss]))
    const localAccounts: LocalEconomicsAccount[] = scopedAccounts.map((account) => ({
      account,
      health: { successCount: 0, failureCount: 0, state: describeCurrentAccountState(account).state },
      loss: lossMap.get(account.id),
    }))
    for (const loss of costLossStates.value) {
      if (!loss.account_deleted || scopedAccounts.some((account) => account.id === loss.account_id)
        || (platformKey && loss.platform !== platformKey) || (accountIds.length && !accountIds.includes(loss.account_id))) continue
      localAccounts.push({
        account: { created_at: loss.cost_profile.started_at, platform: loss.platform as Account['platform'], type: loss.account_type as Account['type'], extra: { cost_profile: loss.cost_profile } },
        health: { successCount: 0, failureCount: 0, state: 'inactive' },
        loss,
      })
    }
    const derived = hasMeasuredData(sourceStates.value.accounts)
      ? buildLocalEconomicsSnapshot({
        accounts: localAccounts,
        billedUsdTotal: usageAvailable ? billedUsd : null,
        accountCostUsdTotal: usageAvailable ? localCpa ? cpaAmount('cost', 'known_cost') : sumAccountCostUsd(rows) : null,
        outputBasis: localCpa ? 'api_value' : 'revenue',
        cnyPerUsd: exchangeRate.value.rate,
        now: localCpa && cliproxyQueryNow ? cliproxyQueryNow.getTime() : Date.now(),
        window: localCpa && cliproxyQueryNow ? cliproxyUsageWindowBounds(range, cliproxyQueryNow)
          : sub2apiRequestRange === range && sub2apiRequestWindow.value ? sub2apiRequestWindow.value : usageWindowBounds(range),
        impairmentComplete: sourceStates.value.costLoss.status !== 'unavailable',
        costMultiplier: localCpa ? cockpitCostMultiplier.value : undefined,
      }) : null
    if (derived) {
      derived.scope = platformKey ? { platform: platformKey } : {}
      if (localCpa && (unassigned || activeCpaRows.some(row => row.cost == null || row.standard_cost == null))) {
        derived.data_quality.status = 'partial'
        derived.projection.warning = costDataText('amountsIncludeKnownItemsOnlyAndUnattributedRequestsAre', { p0: derived.projection.warning ?? '' })
      }
    }
    return derived
  }

  async function loadAccountEconomics(
    platform: string,
    range: CostCenterRange = DEFAULT_COST_CENTER_RANGE,
    accountIds: CostAccountId[] = [],
    options: { background?: boolean } = {},
  ) {
    if (activeSourceKey.value === 'cliproxy') {
      const derived = deriveLoadedEconomics(platform, range, accountIds)
      accountEconomics.value = derived
      setSourceState('economics', derived ? 'estimated' : 'unavailable', () => (costDataText('derivedFromTheLocalCpaPluginApiReferenceValue')))
      return derived
    }
    const sequence = ++economicsRequestSequence
    const remoteIds = accountIds.map(requireSub2apiAccountId)
    if (activeSourceKey.value === 'cockpit' || captureAuthConnection().connection?.type === 'cliproxy') throw new Error(costDataText('theCurrentSourceIsNotSub2apiRemoteEconomicSamples'))
    const scopeKey = `${getSub2apiTargetBase()}|${platform}|${range}|${[...remoteIds].sort((a, b) => a - b).join(',')}`
    const previous = accountEconomics.value
    if (!options.background || !previous) {
      accountEconomics.value = null
      setSourceState('economics', 'loading', () => (costDataText('collectingAndReadingEconomicSamples')))
    }
    try {
      const snapshot = await adminAPI.accounts.getEconomicsSnapshot({
        scope: platform,
        platform: economicsPlatformFilter(platform),
        account_ids: remoteIds.length ? remoteIds.join(',') : undefined,
        cny_per_usd: exchangeRate.value.rate,
        exchange_rate_source: exchangeRate.value.source,
        window_hours: economicsWindowHours(range),
      })
      if (sequence === economicsRequestSequence) {
        accountEconomics.value = snapshot
        remoteEconomicsScope = scopeKey
        // 直接映射 data_quality.status（v5：不再只判 partial 把 estimated/unavailable 吞掉）
        const dq = snapshot.data_quality.status
        const status = dq === 'unavailable' ? 'unavailable'
          : dq === 'estimated' ? 'estimated'
          : dq === 'partial' ? 'partial'
          : snapshot.projection.confidence === 'unavailable' ? 'partial'
          : 'measured'
        setSourceState('economics', status, () => (snapshot.projection.confidence === 'unavailable' ? costDataText('recordedFactsAreAvailableInsufficientStableSamplingIntervalsFor') : costDataText('recordedLedgerAndStableIntervalForecastsLoaded')))
      }
      return snapshot
    } catch (economicsError) {
      console.warn('[cost-center] persistent economics snapshot unavailable', economicsError)
      if (sequence === economicsRequestSequence) {
        if (options.background && previous && !isLocalEconomicsSnapshot(previous) && remoteEconomicsScope === scopeKey) {
          accountEconomics.value = previous
          setSourceState('economics', 'stale', () => (economicsError instanceof Error ? economicsError.message : costDataText('economicSamplingRefreshFailedKeepingTheLastSuccessfulSnapshot')))
        } else {
          const derived = deriveLoadedEconomics(platform, range, accountIds)
          accountEconomics.value = derived
          setSourceState('economics', derived ? (derived.data_quality.status === 'estimated' ? 'estimated' : 'partial') : 'unavailable', () => (derived
            ? costDataText('remoteEconomicsUnavailableLocallyDerivedFromCostProfilesLoaded', { p0: derived.projection.warning ?? costDataText('insufficientWindowUsageForecastUnavailable') })
            : economicsError instanceof Error ? economicsError.message : costDataText('failedToReadTheEconomicSamplingApi')))
          return derived
        }
      }
      return null
    }
  }

  /**
   * cockpit 源:模型成本区「成本账号」选中某账号时,把路由明细表也收敛到该账号
   * (与模型表同筛选口径,避免同一面板"半过滤"——模型表只算所选账号、路由表却仍是全账号)。
   *
   * 行级 `row.accountId` 与 `Account.id`、`modelCostAccountId` 同属来源限定的完整 ID 体系,
   * 故可直接相等比对;日志未带 accountId 的行(accountId == null)不可归因,筛选时自然剔除。
   * 全部账号(null)时不动,行为与改动前一致。sub2api 分支不走这里(接口自带 account_id 参数)。
   */
  function applyCockpitModelRouteAccountScope(): void {
    if (modelCostAccountId.value == null) return
    const scoped = modelRoutes.value.filter((row) => row.accountId === modelCostAccountId.value)
    modelRoutes.value = scoped
    modelAuditSummary.value = cockpitRoutesAuditSummary(scoped.reduce((sum, row) => sum + row.requests, 0))
  }

  /**
   * cockpit 本地数据装入:把 cockpit JSON 适配进 store ref,复用全部 computed,
   * 不调任何 adminAPI。由 CostCenterView reload() 在 connectionType === null 时调用。
   *
   * 填充:accounts(统计账号×渠道派生 + quota_history 限流状态 + 多平台账号清单合并)、
   * todayStats(daily 当日用量)、models(月度10模型)、trend(当前 range 对应单窗口快照)、
   * modelPricing(local_access 定价 + 隐含价兜底)、ops(totals 派生)、
   * accountUsage(quota_history 配额窗口)、modelRoutes(codex-api 日志解析+模型均摊回填)、
   * systemSettings(local_access 调度规则)、accountEconomics(成本+默认价推算)。
   * 真缺:costLossStates(cockpit 账号无采购退款账本)→ computed 返空,UI 走 unavailableValueLabel。
   */
  function loadFromCockpit(
    cockpitStats: CockpitStats,
    localAccess: CockpitLocalAccess | null,
    range: CostCenterRange,
    quotaHistories: CockpitQuotaHistoryFile[] = [],
    apiLog: string | null = null,
    apiKeyInfos: Map<string, CockpitApiKeyInfo> = new Map(),
    accountMeta?: Map<string, CockpitCodexAccount>,
    platformAccounts: CockpitPlatformAccountInput[] = [],
    /** 多天日志聚合的 ops 趋势(Rust 侧聚合,7d/30d 用);null/缺省回退单天日志解析。 */
    multiDayOps?: OpsThroughputTrendPoint[] | null,
    /** 多天日志聚合的 per-account 请求数(账号行 id keyed,7d/30d 用)。
     *  日志是请求流水,聚合即真实滚动窗口;快照 weekly/monthly 是日历累计,冒充滚动窗口会
     *  出现"7d 比 30d 数字还大"的荒谬数据(实测 8/31 起 5 天 23,322 > 9/1 起 4 天 10,171)。
     *  成本/Token 日志无字段,保持快照累计口径,由视图标注真实窗口。 */
    multiDayAccountRequests?: Record<string, number> | null,
    /** Rust 侧多天日志的路由聚合(模型×账号×入站接口)。
     *  2026-09-06 修复"真实模型/渠道/接口明细不跟窗口":此前只解析当天日志,
     *  7d/30d 与 today 出同一份数据;有聚合时优先用聚合,无则回退当天日志解析。 */
    multiDayRoutes?: CockpitOpsRouteAgg[] | null,
    /**
     * cockpit 单请求用量库(`codex_local_access_logs.sqlite`)按观察窗口的聚合。
     *
     * 这是 cockpit 成本算得准的**关键**:长上下文档位价按单请求 input_tokens > 272_000 判定,
     * 而 stats JSON 只有日历累计快照、codex-api 日志没有 token 字段——没有它只能拿
     * "窗口平均 token"猜档,实测 gpt-6-astra 会因此把成本算少近一半($2,122 vs $3,970)。
     * null / available=false 时回退快照口径(并在状态文案如实标注),不静默变 0。
     */
    requestLog?: CockpitRequestLogSummary | null,
    /** 本机自然日的单请求聚合(供 todayStats)。与 requestLog 分开:观察窗口是 7d/30d 时
     *  "今日" 仍应是自然日口径,不能跟着窗口变成 7 天累计。 */
    todayRequestLog?: CockpitRequestLogSummary | null,
    /** `accountId → cockpit 账号分组名`(account_groups.json / codex_account_groups.json)。
     *  cockpit 日志无 group_id,但账号分组可从分组文件反查——路由表「分组」列据此回填。 */
    cockpitGroupNames?: Map<string, string> | null,
    /**
     * FIX 5:窗口级 TTFT 分位数(来自 Rust `summarize_cockpit_api_logs` 顶层
     * ttft_p50_ms/ttft_p95_ms)。cockpit 快照 totals 无分位数,只有多天日志聚合的顶层才有;
     * 缺省 / 无样本时保持全 null,面板显示「无样本」而不是 0。
     */
    windowTtft?: { p50Ms: number | null; p95Ms: number | null } | null,
    queryWindow = usageWindowBounds(range),
  ) {
    const retainedModelWindow = activeSourceKey.value === 'cockpit' && modelWindowDetached.value && modelCostRange.value !== range ? {
      models: models.value, routes: modelRoutes.value, audit: modelAuditSummary.value,
      routesTruncated: modelRoutesTruncated.value, exactFallback: modelStatsExactWindowFallback.value,
      compatibilityTruncated: modelStatsCompatibilityTruncated.value, fromRequestLog: modelCostFromRequestLog.value,
      detached: modelWindowDetached.value, source: modelCostSource.value,
      modelState: sourceStates.value.models, routeState: sourceStates.value.modelRoutes, auditState: sourceStates.value.modelAudit,
    } : null
    resetRangeWindowState()
    // E6:账号级探测结果按源隔离(cockpit 账号 id 与上一源可能撞车)
    applySourceKey('cockpit')
    // 分组映射落到 store ref:独立窗口重算(loadCockpitModelWindow)也要用同一份。
    cockpitGroupNameMap.value = cockpitGroupNames ?? new Map()
    // quota_history 最新点位 → accountId Map(maxUtil=100-最低 remaining;reset 已过视为已重置不限流)。
    // 驱动状态派生:利用率≥95% 且重置时间在未来 → 账号标限流(真实重置倒计时)。
    const emailToAccountId = new Map<string, string>()
    for (const acc of cockpitStats.accounts) {
      if (acc.email) emailToAccountId.set(acc.email, acc.accountId)
    }
    const quotaByAccount = new Map<string, { maxUtil: number; resetAtMs: number | null }>()
    for (const file of quotaHistories) {
      const accountId = emailToAccountId.get(file.email)
      if (!accountId) continue
      let maxUtil = 0
      let resetAtMs: number | null = null
      for (const history of Object.values(file.models)) {
        const points = history.points
        if (!points?.length) continue
        const last = points[points.length - 1]
        const util = 100 - last.remainingPercentage
        if (util > maxUtil) {
          maxUtil = util
          resetAtMs = last.resetTime > 0 ? last.resetTime : null
        }
      }
      if (maxUtil <= 0) continue
      // 重置时间已过 → 窗口已刷新,当前不再限流,不标
      if (maxUtil >= 95 && resetAtMs != null && resetAtMs <= Date.now()) continue
      quotaByAccount.set(accountId, { maxUtil, resetAtMs })
    }
    // 账号清单 + 今日用量(口径:cockpit 无分钟桶,daily 是本机自然日累计,最贴近 todayStats 语义)
    // apikey 账号 name 用渠道名映射 + baseUrl 塞 credentials(归 relay 中转,不套"OpenAI 官方")
    // accountMeta 透传修 created_at（P0 主路径，删 epoch bug）+ extra 塞 plan_type
    // quotaByAccount 驱动限流状态派生
    accounts.value = cockpitStatsToAccounts(cockpitStats, apiKeyInfos, accountMeta, localAccess?.customRoutingRules, quotaByAccount, cockpitGroupNames)
    // 多平台账号合并(gemini/antigravity/claude/cursor/kiro:cockpit 上游只产 codex 用量,
    // 这些平台有账号无 stats——进清单供 tabs/采购配置,用量列诚实显示无数据;按 id 去重防撞)
    if (platformAccounts.length) {
      const existingIds = new Set(accounts.value.map((a) => a.id))
      const platformOnly = cockpitPlatformAccountsToAccounts(platformAccounts).filter((a) => !existingIds.has(a.id))
      if (platformOnly.length) accounts.value = [...accounts.value, ...platformOnly]
    }
    // 模型定价目录必须**先**算出来:2026-09-08 起成本由本项目按本地单价 × token 自算
    // (与 cliproxy 路径 eventCostUsd 同口径),不再吃数据源自带的 estimatedCostUsd。
    // 隐含价(由 estimatedCostUsd 反推)只用于"当前单价"列显示,**不**代回成本公式——
    // 它 input/output/cache_read 同价,代回会把成本算成 2~3 倍。
    // 有效定价目录 = cockpit 内置价目表(全模型) + 用户在 cockpit 里手动配的覆盖价(优先)。
    // 2026-09-08 之前只读覆盖价(本机仅 2 条),主力模型没单价 → 成本只能回退数据源估算。
    const localPricing = cockpitEffectiveModelPricing(localAccess?.modelPricings)
    // 三档价目(标准/长文本/优先):单请求用量库口径要用它,才能按长上下文档位价精确计价
    const priceSets = cockpitEffectivePriceSets(localAccess?.modelPricings)
    // 模型区独立窗口重算时复用同一份价目(2026-09-10 双轨)
    cockpitModelPriceSets.value = priceSets
    const window = cockpitWindowForRange(cockpitStats, range)
    const impliedPricing = cockpitModelsToImpliedPricing(window?.models, cockpitCostMultiplier.value)
    modelPricing.value = { ...impliedPricing, ...localPricing }
    pricingStatus.value = cockpitLocalAccessToPricingStatus(localAccess)

    // 单请求用量库可用 → 用它(真实滚动窗口 + 长文本分档计价);否则回退日历快照口径。
    // 2026-09-08 修复"cockpit 成本算少一半":快照口径无法判定长上下文档位价。
    // ★★ 2026-09-24:「可用」必须包含**这个窗口里真的有行** —— 数据源会停止写入
    // (本机实测末端停在 2026-09-17T19:19:54Z,短窗口 1m~24h 内 0 行)。
    // 此前只判 `available`(=库能打开,`cockpit_logs_db.rs:441` 无条件 true),于是窗口内 0 行时:
    //   · 模型表/成本趋势**已经回退到 daily 快照**(屏幕上有数字),
    //   · 而 `cockpitCostFromRequestLog` 仍是 true ⇒ 标注写「该窗口无数据」,
    //   · 逐账号表/当日用量走单请求库路径拿到空表 ⇒ 把"源没覆盖"渲染成「无数据」。
    // ⇒ 同屏自相矛盾,用户读成「把有数据改成无数据」。
    //
    // ★★ 2026-09-25 翻案:上面那条「**且** 窗口内有行」的判据是**错的**,已回退。
    //   它把「这个窗口内 0 行」误判成「这条链路不可用」,于是整屏退回快照累计 ——
    //   实测(源活着、库里 186,353 行、只是最近 1 分钟真的没请求):
    //     1m / 1h / 24h 三档 `opsOverview.request_count_total` **都显示 73**
    //     = `stats.daily`(一天累计),标着「最近 1 分钟」。真实的窗口值是 **0**。
    //   Rust 侧 `RequestLogSummary.available` 的语义本来就是「**库存在且查询成功**」
    //   (`cockpit_logs_db.rs:202`,与窗口内有没有行无关),前端不该再叠 `rowCount > 0`。
    // ⇒ 数值永远吃**窗口真值**(0 行就是 0),「源没覆盖这段」这件事交给
    //   `cockpitWindowCoverage` / `cockpitWindowCoverageNote` 的 `uncovered` 态去标注,
    //   **不要用退回快照的办法去消除矛盾** —— 那是把问题从标注层搬到了数值层。
    const rlAvailable = !!requestLog?.available
    const rlTodayAvailable = !!todayRequestLog?.available
    rangeAccountStatsComplete.value = rlAvailable

    todayStats.value = rlTodayAvailable
      ? cockpitRequestLogToAccountStats(todayRequestLog!, priceSets, cockpitCostMultiplier.value)
      : cockpitWindowToAccountStats(cockpitStats.daily, cockpitCostMultiplier.value, localPricing)
    // 观察窗口逐账号用量(2026-09-04 修复"观察窗口设置不生效"):
    // 实测 daily 窗口可能只有 1 个账号(自然日刚重置),而 weekly 有 33 / monthly 有 28——
    // 上游排行表若固定读 daily,用户切到 7d/30d 看到的仍是同一份"今日"数据,窗口切换形同无效。
    // 这里额外按当前 range 取窗口,供上游排行的成本/产出/请求/Token 列使用。
    rangeAccountStats.value = rlAvailable
      ? cockpitRequestLogToAccountStats(requestLog!, priceSets, cockpitCostMultiplier.value)
      : cockpitWindowToAccountStats(window, cockpitCostMultiplier.value, localPricing)
    if (multiDayAccountRequests && !rlAvailable) {
      // 2026-09-05 修复"7d/30d 数据是错的":快照 weekly/monthly 是日历累计(本周一/本月1日起),
      // 冒充滚动窗口后 7d(8/31 起 5 天)数字反而大于 30d(9/1 起 4 天)。请求数改用日志聚合的
      // 真实滚动窗口覆盖;成本/Token 无日志字段,保留快照累计(视图列标注真实口径,不再冒充)。
      // 2026-09-16:账号**不在快照里**时此前显式写入 `{ tokens: 0, cost: 0, standard_cost: 0, user_cost: 0 }`,
      // 于是「{窗口}自算成本」列渲染成绿色 `$0.0000`、note 却写"{窗口}自算成本" —— 把"不可测"
      // 显示成"确定是 0"。日志只给出真实请求数,成本/Token 确实不可测 ⇒ 写 null,
      // 由视图走"无数据"分支(AccountWindowUsage 的字段可空就是为了表达这件事)。
      for (const [id, requests] of Object.entries(multiDayAccountRequests)) {
        const cur = rangeAccountStats.value[id]
        rangeAccountStats.value[id] = cur
          ? { ...cur, requests }
          : { requests, tokens: null, cost: null, standard_cost: null, user_cost: null }
      }
    }
    // cockpit 的逐账号窗口用量由本地快照/单请求用量库提供,不经 sub2api 的窗口接口 ——
    // 这里只如实登记源状态(2026-09-17 新增 rangeStats 键),不改变任何取数口径。
    setSourceState(
      'rangeStats',
      Object.keys(rangeAccountStats.value).length
        ? !rlAvailable || unattributedRequests(rangeAccountStats.value) || Object.values(rangeAccountStats.value).some(row => row.cost == null || row.standard_cost == null) ? 'partial' : 'measured'
        : 'empty',
      () => (Object.keys(rangeAccountStats.value).length
        ? rlAvailable ? costDataText('cockpitRequestStoreLoadedPerAccountUsageForUnknown', { p0: costCenterRangeLabel(range), p1: unattributedRequests(rangeAccountStats.value) ? costDataText('requestsHaveNoAccountAttributionAndAreKeptIn', { p0: unattributedRequests(rangeAccountStats.value) }) : '' })
          : costDataText('cockpitHasOnlyCumulativeCalendarSnapshotsTheseAreNot')
        : costDataText('cockpitHasNoAccountUsageRecordsFor', { p0: costCenterRangeLabel(range) })),
    )
    // 模型成本区「成本账号」筛选(cockpit,2026-09-13 修「选择器空转」):
    // groups 是 (模型×账号),按同一来源限定 ID 过滤后,模型表/口径统计
    // 才真正只反映所选账号。未选账号(null)时原样返回,行为与改动前完全一致。
    // 注意:只作用于模型成本链路;cells 无账号维度,全局成本速率/运行趋势不受影响。
    const modelScopedLog = filterCockpitRequestLogByAccount(requestLog ?? null, modelCostAccountId.value)
    const rlModels = cockpitRequestLogToModelStats(modelScopedLog ?? null, priceSets, cockpitCostMultiplier.value)
    // 模型表的来源标记 + 快照留存:供模型区**独立窗口**重算复用(见 `cockpitStatsSnapshot` 注释)。
    // 标注与数值**同源**:都看「链路可用」,避免表是快照数据、标注却写"真实滚动窗口"。
    modelCostFromRequestLog.value = rlAvailable
    cockpitStatsSnapshot.value = cockpitStats
    // ★ 2026-09-25:判据改「链路可用」。原 `rlModels.length` 把「窗口内 0 行」当成
    //   「该用 daily 快照的模型表」⇒ 1m 窗口的模型表画出 daily 快照里 73 请求的模型行。
    models.value = rlAvailable
      ? rlModels
      // 快照口径(cockpitModelsToModelStats)没有账号维度:选中某账号时不可用它,
      // 否则会把"全账号合计"冒充成该账号 —— 如实留空,由视图显示"该账号此窗口无记录"。
      : modelCostAccountId.value == null
        ? cockpitModelsToModelStats(window, cockpitCostMultiplier.value, localPricing)
        : []
    // 成本趋势:按当前 range 取对应窗口的累计点(2026-09-06 修复窗口脱钩 + 时间乱序)。
    // cockpit 日志无成本字段,只有日/周/月日历累计,没有滚动窗口成本序列——单点 + 真实窗口时长折算,
    // 不把不同起点的 3 个累计值连成假趋势线。
    // 成本趋势:单请求库可用时是**按时间桶逐模型自算**的真实趋势(此前 cockpit 只有
    // 日/周/月 3 个日历累计点,连不成趋势线,只能靠单点 + 时长折算)。
    const rlTrend = cockpitRequestLogToCostTrend(requestLog ?? null, priceSets, cockpitCostMultiplier.value)
    // ★ 2026-09-25:与 :1371 `rlWindowTotals` 同一个病根 —— 用「窗口内有没有行」决定要不要
    //   回退快照,会把「这个窗口没数据」渲染成**快照日历累计的点**(短窗口趋势图上画的是
    //   daily 的累计点,标着「最近 1 分钟」)。
    //   判据改为「**链路可用**」:库能用就用库的真趋势(窗口内 0 行 ⇒ 空,诚实),
    //   **只有**库本身不可用(老版本 cockpit / 查询失败)才走快照单点兜底。
    trend.value = rlAvailable
      ? rlTrend
      : cockpitWindowsToCostTrend(cockpitStats, cockpitCostMultiplier.value, range, localPricing)
    trendQueryWindow.value = rlAvailable
      ? { start: queryWindow.start, end: new Date(Math.min(Date.now(), queryWindow.end.getTime())) }
      : window?.since != null && window?.updatedAt != null
        ? { start: new Date(window.since), end: new Date(window.updatedAt) } : null
    rangeAccountStatsWindow.value = trendQueryWindow.value
    rangeAccountStatsScope.value = { source: 'cockpit', instanceId: 'local' }
    rangeWindowAuthoritative.value = true
    // 窗口真实已过时长(小时):供视图把"窗口累计"折算成 $/h,口径随 range 真实变化。
    // ★★ 2026-09-24 分母修正:快照实际覆盖的区间是 `since → updatedAt`,**不是** `since → now`。
    //   快照会停止更新(本机 daily 的 `updatedAt` 停在 2026-09-17T19:19:54Z),而"现在"已是 09-24
    //   ⇒ 用 `Date.now()` 得到 163h,把该窗口的 $19.19 摊成 **$0.118/h**;
    //   它真实覆盖 3.32h ⇒ **$5.78/h** —— **差 49 倍**,而且"越大窗口费率越低"是纯属编出来的规律。
    //   与 `cockpitTotalsToOpsOverview` 的 qps/tps 分母同一条判据:**分子与分母必须同源**。
    const windowEndMs = Math.min(Date.now(), window?.updatedAt ?? Date.now())
    cockpitWindowHours.value = window?.since
      ? Math.max(0.25, (windowEndMs - window.since) / 3_600_000)
      : null
    // 逐桶趋势(单请求用量库)→ 桶长就是桶本身;只有退化成"窗口累计单点"才用窗口跨度折算。
    cockpitTrendBucketHours.value = rlTrend.length
      ? (Number(requestLog?.bucketHours) > 0 ? Number(requestLog?.bucketHours) : null)
      : null
    trendBucketHours.value = rlAvailable ? finiteOrNull(requestLog?.bucketHours) : cockpitWindowHours.value
    trendUsesAccountCost.value = true

    // ops 运维总览:cockpit totals 派生(成功/失败/错误率/延迟均值/qps/tps/token)。
    // TTFT 分位数/429-402-529 错误码/切号事件 cockpit 真无,留 null/0,图表断点不造假。
    opsOverview.value = cockpitTotalsToOpsOverview(cockpitStats, range, windowTtft)
    // 单请求用量库 → Ops 桶序列(请求/成功/失败/token),见下方 opsTrend 三级来源说明
    // 粒度护栏:单请求库最小桶是 1 小时,窗口比桶还短时(1m/5m/30m)用它会把
    // 一整小时的请求当成"最近 1 分钟"——短窗口回退日志的分钟级桶。
    const rlOpsGranularityOk = (requestLog?.bucketHours ?? 0) > 0
      && requestLog!.bucketHours <= economicsWindowHours(range) * 1.5
    const rlOps = rlOpsGranularityOk ? cockpitRequestLogToOpsTrend(requestLog ?? null) : []
    // 延迟/TTFT 回填:单请求库 cells 不聚合延迟,日志桶才有。按桶时间戳对齐补齐
    // (同为 1 小时桶可直接对齐;7d/30d 是 24 小时桶,SQLite 按 UTC 日切、日志按本地日切,
    //  再退一步按本地日期匹配),避免"换成单请求库后延迟图整片变空"的回归。
    if (rlOps.length && multiDayOps?.length) {
      const byMs = new Map<number, (typeof multiDayOps)[number]>()
      const byDay = new Map<string, (typeof multiDayOps)[number]>()
      for (const point of multiDayOps) {
        const ms = new Date(point.bucket_start).getTime()
        if (Number.isFinite(ms)) byMs.set(ms, point)
        const d = new Date(ms)
        byDay.set(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, point)
      }
      for (const point of rlOps) {
        const ms = new Date(point.bucket_start).getTime()
        const d = new Date(ms)
        const src = byMs.get(ms) ?? byDay.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)
        if (!src) continue
        // 只在单请求库自己没有值时才补(库覆盖全量,日志只 5 天):
        // 反过来覆盖会把 7d/30d 里已有的 p95 抹成 null。
        if (point.duration_p95_ms == null) point.duration_p95_ms = src.duration_p95_ms ?? null
        point.ttft_p50_ms = src.ttft_p50_ms ?? null
        point.ttft_p95_ms = src.ttft_p95_ms ?? null
        // FIX 2:src.switch_count 为 null = 该源不采集切号,不能用 0 冒充"零次切号"。
        point.switch_count = src.switch_count ?? null
      }
    }
    // 窗口真值(用于 KPI):单请求库按精确 ms 窗口过滤,**与桶粒度无关**,
    // 因此即使短窗口(1m/5m/30m)不用它的桶序列画趋势,KPI 仍必须吃它的窗口合计——
    // 否则会退回 stats.totals 全量累计(实测 1m 窗口显示 ~3,021 qps)。
    // 2026-09-10 修正:cells 与 groups 都是 CockpitTokenSplit(均有 requests/success/error),
    // 但 cells 是"桶×模型"、groups 是"模型×账号",两者 requests 之和都等于窗口内请求数。
    // 只在两者之一为空时才回退,避免旧夹具/旧版 cockpit(有 groups 无 cells)算成 0。
    const rlCells = (requestLog?.cells ?? []).filter(Boolean)
    const rlGroups = (requestLog?.groups ?? []).filter(Boolean)
    const rlCountFrom = rlCells.length ? rlCells : rlGroups
    // ★ 2026-09-25:去掉 `rlCountFrom.length` 条件 —— 链路可用时**窗口真值一定存在**,
    //   窗口内 0 行就是 0;置 null 会让下面 `if (rlWindowTotals || …)` 不覆盖,
    //   于是整屏退回快照累计(实测把真实的 0 显示成 daily 的 73,见 :1237 翻案注释)。
    const rlWindowTotals = rlAvailable
      ? {
        requests: rlCountFrom.reduce((sum, c) => sum + (c.requests || 0), 0),
        success: rlCountFrom.reduce((sum, c) => sum + (c.success || 0), 0),
        error: rlCountFrom.reduce((sum, c) => sum + (c.error || 0), 0),
        tokens: rlGroups.reduce<number | null>((sum, g) => sumTokenCounts(sum, cockpitSplitTokens(g).totalTokens), 0),
      }
      : null
    if (rlWindowTotals || (multiDayOps && multiDayOps.length)) {
      const opsSource = rlOps.length ? rlOps : (multiDayOps ?? [])
      const req = rlWindowTotals ? rlWindowTotals.requests : opsSource.reduce((s, p) => s + p.request_count, 0)
      const ok = rlWindowTotals ? rlWindowTotals.success : opsSource.reduce((s, p) => s + p.success_count, 0)
      const err = rlWindowTotals ? rlWindowTotals.error : opsSource.reduce((s, p) => s + p.error_count, 0)
      // 2026-09-05 修复:7d/30d 的全局请求/成功/失败改用日志聚合的真实滚动窗口——
      // 快照 totals 是日历累计(本周一/本月1日起),冒充滚动窗口会出现"7d>30d"的荒谬数字。
      // token/延迟等日志没有的字段保留快照口径(cockpitTotalsToOpsOverview 原值)。
      // 2026-09-09 修复"运维总览 KPI 不跟窗口":cockpitTotalsToOpsOverview 用 stats.totals
      // (**全量累计**,实测 181,279 请求 / 231 亿 token)除以窗口小时算 qps/tps,
      // 于是切到 1h 窗口会显示 50 qps——窗口外一年多的量被摊进这一小时。
      // 请求数此前已用日志聚合覆盖,token/qps/tps 没覆盖(日志无 token 字段)→
      // token 取同一窗口的单请求用量库,qps/tps 按**窗口真实跨度**重算。
      const bounds = usageWindowBounds(range)
      const windowHours = Math.max(1 / 60, (Math.min(bounds.end.getTime(), Date.now()) - bounds.start.getTime()) / 3_600_000)
      const windowTokens = rlWindowTotals ? rlWindowTotals.tokens : null
      const base = opsOverview.value
      if (base) {
        // ★ 2026-09-26:`windowTokens == null` 时**不许**回退到 `base.token_consumed` 去算 tps/总量。
        //   `base` 来自 cockpitTotalsToOpsOverview,没有窗口快照时它的 `token_consumed` 是
        //   `stats.totals` = **生命周期累计**(本机 231 亿 token,自 07-29 起)。
        //   拿它除以名义窗口时长 ⇒ 就是本段上方 2026-09-09 那条注释声称**已修掉**的同一个 bug
        //   ("231 亿 token 摊进这一小时"),只是换了个入口没修干净。
        //   ⇒ 窗口 token 不可知时:总量置 null(面板「无数据」),tps 置 null。
        //     qps **保留**:它的分子 `req` 确实是窗口真值(来自 rlWindowTotals 或 multiDayOps),
        //     分母是名义窗口时长,语义是"该窗口的平均速率",自洽。
        const tokenConsumed = windowTokens
        const qps = windowHours > 0 ? req / (windowHours * 3600) : 0
        const tps = windowTokens != null && windowHours > 0 ? windowTokens / (windowHours * 3600) : null
        opsOverview.value = {
          ...base,
          request_count_total: req,
          success_count: ok,
          error_count_total: err,
          error_rate: req > 0 ? err / req : 0,
          token_consumed: tokenConsumed,
          qps: { current: qps, peak: qps, avg: qps },
          tps: { current: tps, peak: tps, avg: tps },
        }
      }
    }
    // ops 运行趋势:codex-api 日志按 range 桶聚合(密集多桶,含请求/成功/失败/TTFT/延迟)。
    // 无日志时 opsTrend 为空,运行图走 empty 状态(诚实)。
    // ops 运行趋势:7d/30d 用 Rust 多天日志聚合(单天日志 26k 行已超前端 25000 行截断,
    // 拼接多天在 JS 会 OOM 且被截尾——此前观察窗口对趋势图永远无效的根因之一);
    // 短窗口(today/1h/6h/24h)仍用当天日志按分钟/小时细分桶。
    // ops 运行趋势三级来源(2026-09-09 重排优先级):
    // ① 单请求用量库 cells —— 覆盖 cockpit 全部保留期(本机 07-29 起 18 万行),7d 窗口不再缺 3 天;
    // ② Rust 多天日志聚合 —— 有 TTFT/延迟维度,但 codex-api.log 只留 ~4 天,7d 必缺头;
    // ③ 当天日志解析(最后回退)。
    opsTrend.value = rlOps.length
      ? rlOps
      : (multiDayOps && multiDayOps.length ? multiDayOps : cockpitLogToOpsTrend(apiLog, range))
    opsTrendFromRequestLog.value = rlOps.length > 0

    // accountUsage:cockpit quota_history 配额窗口(remainingPercentage→UsageProgress)
    accountUsage.value = cockpitQuotaToAccountUsage(quotaHistories, cockpitStats.accounts)

    // modelRoutes:优先使用覆盖完整所选窗口的 request_logs;文本日志聚合只在库不可用/无分组时回退。
    // 两条聚合路径最终都复用 cockpitOpsRoutesToModelRoutes,当天日志仅作最后兜底。
    // `routesBasis` 同时驱动数值和来源标签,避免二者各写一套优先级后再次分叉。
    const sqlRoutes = cockpitRequestLogToModelRoutes(requestLog ?? null, accounts.value, priceSets, cockpitCostMultiplier.value, cockpitGroupNames)
    const routesBasis: 'requestLog' | 'multiDay' | 'todayLog' = sqlRoutes
      ? 'requestLog'
      : multiDayRoutes?.length
        ? 'multiDay'
        : 'todayLog'
    if (sqlRoutes) {
      modelRoutes.value = sqlRoutes.routes
      modelRoutesTruncated.value = false
      modelAuditSummary.value = cockpitRoutesAuditSummary(sqlRoutes.totalRequests)
    } else if (routesBasis === 'multiDay') {
      const groupCost = rlAvailable
        ? cockpitRequestLogGroupCost(requestLog!, priceSets, cockpitCostMultiplier.value)
        : null
      const aggResult = cockpitOpsRoutesToModelRoutes(multiDayRoutes!, accounts.value, window?.models, cockpitCostMultiplier.value, localPricing, groupCost, cockpitGroupNames)
      modelRoutes.value = aggResult.routes
      modelRoutesTruncated.value = false
      modelAuditSummary.value = cockpitRoutesAuditSummary(aggResult.totalRequests)
    } else {
      const routeResult = cockpitLogToModelRoutes(apiLog, accounts.value, window?.models, cockpitCostMultiplier.value, localPricing, cockpitGroupNames)
      modelRoutes.value = routeResult.routes
      modelRoutesTruncated.value = routeResult.truncated
      modelAuditSummary.value = summarizeModelAudit(routeResult.logs)
    }
    // 选中某账号时把路由明细也收敛到该账号(与模型表同口径)。
    // groupCost 用**全量** requestLog 构建即可:它按 (模型×账号) 精确键,收敛后所选账号的行
    // 仍拿到各自精确成本,其余账号行被过滤掉,不影响保留行的数值。
    applyCockpitModelRouteAccountScope()

    // systemSettings:cockpit local_access 调度规则(routingStrategy/customRoutingRules → 调度权重 key)
    systemSettings.value = cockpitLocalAccessToSystemSettings(localAccess) as SystemSettings | null

    // accountEconomics:cockpit 成本 + 默认价推算采购(billed_usd 真实,procurement 默认价,impairment 0)
    accountEconomics.value = cockpitStatsToEconomics(cockpitStats, range, exchangeRate.value.rate, accountMeta, cockpitCostMultiplier.value, localPricing, requestLog, priceSets)

    // 2026-09-11 对齐参考实现:cockpit 虽无 sub2api 的 economics / ops 错误端点,
    // 但单请求用量库有 error_category + http_status,可还原"健康三态"与 429 趋势。
    // 此前这两张图在 cockpit 源下整片空白——不是没数据,是没去读。
    cockpitHealthSeries.value = rlAvailable
      ? cockpitRequestLogToHealthSeries(requestLog!)
      : []
    opsErrorTrend.value = rlAvailable ? cockpitRequestLogToErrorTrend(requestLog!) : []

    // 清空 cockpit 真无的维度,避免上一连接残留
    costLossStates.value = []
    // 这三个标志只描述 sub2api 的 usage_logs 兼容读取/25,000 行上限。
    // cockpit 不走该读取器:request_logs 在 Rust 中按 SQL 窗口全量扫描聚合且没有 LIMIT,
    // 成本趋势也直接消费其聚合结果,因此这里不存在对应的“兼容回退/样本截断”状态。
    modelStatsExactWindowFallback.value = false
    modelStatsCompatibilityTruncated.value = false
    trendTruncated.value = false
    stats.value = null

    // sourceStates:cockpit 真实有的标 measured/partial,真无的标 unavailable
    setSourceState('accounts', accounts.value.length ? 'measured' : 'empty', () => (accounts.value.length ? costDataText('localCockpitAccountInventoryLoaded') : costDataText('noCockpitAccounts')))
    setSourceState('todayStats', Object.keys(todayStats.value).length ? 'measured' : 'empty', () => (Object.keys(todayStats.value).length ? costDataText('cockpitAccountUsageForTodayLoaded') : costDataText('noCockpitAccountUsageForToday')))
    // 2026-09-06:cockpit 无滚动窗口成本序列(日志无成本字段),如实说明当前用的是哪个日历累计窗口。
    // 按**实际选中的窗口**标注:首选窗口缺失回退时(如 7d 无 weekly 用 monthly),标签不能仍写"本周累计"。
    // 2026-09-16 B1:只有**快照路径确实是数值来源**时才给"累计"标签。
    // 单请求用量库可用时,成本/请求/模型的数值全部来自 request_logs 的精确 ms 滚动窗口
    // (7d 实测滚动 6,499 行 vs weekly 快照 1,075 行,6× 差;30d 105,733 vs 26,408,4× 差),
    // 此时标"本周累计"会让用户把滚动窗口读成日历累计,且与同屏请求列
    // "最近 7 天(单请求用量库全程覆盖)"自相矛盾。置空 → 视图回退到 costCenterRangeLabel(range)。
    cockpitCostFromRequestLog.value = rlAvailable
    // ★ 2026-09-24:判定抽到 `cockpitWindowLabelForRange`(单一来源)—— 模型区有**独立一轨**窗口
    //   (`modelCostRange`),要用同一套措辞,各写一份迟早分叉。
    cockpitWindowRange.value = rlAvailable ? null : range
    // 2026-09-08:成本口径必须说清——成本是本项目按本地单价 × token 算的,
    // 缺单价的模型才回退 cockpit 自带估算(不把数据源的黑盒估算冒充"我们算的")。
    // 2026-09-08:口径统计按**实际用到的模型集合**算——单请求库口径与快照口径模型集不同,
    // 混用会标出假的"N 模型回退估算"。
    let totalModelCount: number
    let localCount: number
    let bookCount: number
    if (rlAvailable) {
      // 口径统计按**实际用到的模型集合**算:选中账号时用过滤后的 groups,
      // 否则会标出与该账号无关的"N 模型回退估算"(与模型表口径不一致)。
      const note = cockpitRequestLogBasisNote(modelScopedLog!, priceSets)
      totalModelCount = note.total
      localCount = note.local
      bookCount = note.book
    } else {
      const windowModels = window?.models ?? []
      totalModelCount = windowModels.length
      localCount = windowModels.filter((m) => localPricing[m.modelId]?.origin === 'local').length
      bookCount = windowModels.filter((m) => localPricing[m.modelId]?.origin === 'book').length
    }
    const estimateCount = totalModelCount - localCount - bookCount
    const costBasisNote = () => totalModelCount === 0
      ? ''
      : costDataText('costUnitPriceTokensLocalAlgorithm', { p0: rlAvailable ? costDataText('includingLongContextTierPrices2') : '', p1: localCount ? costDataText('localConfiguredPricesForModels', { p0: localCount }) : '', p2: localCount && bookCount ? ' + ' : '', p3: bookCount ? costDataText('builtInCockpitPricesForModels', { p0: bookCount }) : '', p4: estimateCount > 0 ? costDataText('modelsHaveNoUnitPriceAndUseCockpitEstimates', { p0: estimateCount }) : '' })
    setSourceState('dashboard', trend.value.length ? 'measured' : 'empty', () => (trend.value.length
      ? (rlAvailable
        ? costDataText('cockpitRequestStoreCostsCalculatedInRealRollingWindow', { p0: costCenterRangeLabel(range), p1: costBasisNote() })
        : costDataText('cockpitSnapshotNoRollingWindowCostSeriesLogsContain', { p0: cockpitWindowLabel.value, p1: costBasisNote() }))
      // ★ 2026-09-25:趋势为空时要分清两种完全不同的情况,不能一律说「源无时序快照」:
      //   · 库**不可用** ⇒ 确实没有时序,只能吃快照;
      //   · 库**可用**、只是这个窗口内 0 行 ⇒ 是"该窗口无记录",
      //     说成"源无时序"会与「库能用、只是这段没数据」的新判据自相矛盾,
      //     用户也会误以为链路坏了。
      : rlAvailable
        ? costDataText('noCockpitRequestStoreRecordsIn', { p0: costCenterRangeLabel(range) })
        : costDataText('noCockpitTimeSeriesSnapshot')))
    setSourceState('models', models.value.length ? 'measured' : 'empty', () => (models.value.length
      ? (rlAvailable
        ? costDataText('cockpitRequestStoreRecordsAggregatedOverTheRealRolling', { p0: costCenterRangeLabel(range), p1: costBasisNote() })
        : costDataText('cockpitModelUsageLoaded', { p0: costBasisNote() }))
      : (modelCostAccountId.value != null ? costDataText('theSelectedAccountHasNoModelCostRecordsIn') : costDataText('noCockpitModelUsage'))))
    // 定价目录含隐含价兜底:文案区分本地目录与隐含价,不把反推价冒充本地配置
    {
      const localPricingCount = Object.keys(localPricing).length
      const impliedPricingCount = Object.keys(impliedPricing).length
      setSourceState('pricing', Object.keys(modelPricing.value).length ? 'measured' : 'unavailable',
        () => (localPricingCount ? costDataText('localCockpitPriceCatalogLoadedModels', { p0: localPricingCount, p1: impliedPricingCount ? costDataText('additionalModelsUseImpliedPriceFallback', { p0: impliedPricingCount }) : '' })
          : impliedPricingCount ? costDataText('noLocalPriceCatalogUsingInferredCockpitPricesFor', { p0: impliedPricingCount })
          : costDataText('noLocalCockpitPriceCatalog')))
    }
    // ops:有日志桶→measured(请求/成功/失败/TTFT/延迟密集趋势);无日志→partial(仅 totals 总览)
    // ★★ 2026-09-26:无趋势时的说明必须**按数值的实际来源**分三种,不能一律写「当天无路由日志」。
    //   `opsOverview` 的计数有两种完全不同的来源(见上方 :1397 的覆盖块):
    //     · 单请求用量库可用 / 有多天路由聚合 ⇒ 计数是**所选窗口的真值**;
    //     · 两者都不可用 ⇒ 计数直接来自 `cockpitTotalsToOpsOverview` 的**日历快照**
    //       (daily/weekly/monthly),它是"今日累计/本周累计",**不是**所选的滚动窗口。
    //   此前一律写「当天无路由日志」⇒ 用户以为是"今天没日志",实际可能是链路坏了,
    //   更要紧的是**看不出屏幕上的数是日历快照而不是所选窗口** —— 正是口径错配。
    //   ⇒ 快照来源时必须把「非所选窗口」说出来(与路由明细表「非所选窗口」同一措辞)。
    setSourceState('ops', opsTrend.value.length ? 'measured' : (opsOverview.value ? 'partial' : 'unavailable'), () => (opsTrend.value.length
      ? costDataText('cockpitRouteLogsAggregatedIntoOperationalTrendsRequestsSuccesses')
      : !opsOverview.value
        ? costDataText('noCockpitOperationalData')
        : (rlWindowTotals || (multiDayOps && multiDayOps.length))
          ? costDataText('derivedCockpitCountsSuccessesFailuresAverageLatencyCountsBelong', { p0: costCenterRangeLabel(range) })
          : (rlAvailable
            ? costDataText('noCockpitRequestStoreRecordsInOperationalCountsCome', { p0: costCenterRangeLabel(range) })
            : costDataText('cockpitRequestStoreUnavailableOperationalCountsComeFromA'))))
    setSourceState('costLoss', 'unavailable', () => (costDataText('cockpitAccountsHaveNoProcurementRefundLedgerSubscriptionsApi')))
    // D7:cockpitQuotaToAccountUsage 已跳过 email 未命中真实账号的文件(不再拿 file.email 当 accountId
    // 造幽灵 key),故这里的条目数 == **命中账号数**。命中 0 个必须是 empty ——
    // 陈旧配额文件不得因为"文件数非 0"就把状态抬成 measured(陈旧数据冒充实时)。
    const quotaAccountCount = Object.keys(accountUsage.value).length
    setSourceState('accountUsage', quotaAccountCount ? 'measured' : 'empty', () => (quotaAccountCount ? costDataText('cockpitQuotaHistoryLoadedQuotaHistoryMatchedAccounts', { p0: quotaAccountCount }) : costDataText('noCockpitQuotaHistoryQuotaHistoryMatchedNoAccounts')))
    // modelRoutes 的数值分支与标签共用 routesBasis,确保来源说明永远跟随实际选中的数据。
    setSourceState(
      'modelRoutes',
      modelRoutes.value.length ? (modelRoutesTruncated.value ? 'partial' : 'measured') : 'empty',
      () => (modelRoutes.value.length
        ? routesBasis === 'requestLog'
          ? costDataText('cockpitRequestStoreAggregatedForModelAccountRequestLogs', { p0: costCenterRangeLabel(range) })
          : routesBasis === 'multiDay'
            ? costDataText('cockpitRouteLogsAggregatedForMultipleCodexApiLog', { p0: costCenterRangeLabel(range) })
            : modelRoutesTruncated.value
              ? costDataText('cockpitRouteLogsForTodayExceedTheLimitShowing')
              : costDataText('cockpitRouteLogsForTodayParsedNotTheSelected')
        : costDataText('noCockpitRouteLogsInThisWindow')),
    )
    // FIX 1:cockpit 日志**没有**"上游响应声明模型"字段(cockpitAdapter.cockpitRoutesAuditSummary 自述),
    // 故「模型审计」4+1 格无真实语义 —— 必须 unavailable,让 UI 走「无数据」分支,
    // 而不是拿全 0 的 cockpitRoutesAuditSummary 冒充实测(外观与 sub2api 实测 0 无法区分)。
    // 注意:modelRoutes 本身**有真实数据**(路由明细表用它),不能一起置 unavailable。
    setSourceState('modelAudit', 'unavailable', () => (costDataText('cockpitLogsDoNotRecordResponseDeclaredUpstreamModels')))
    setSourceState('settings', systemSettings.value ? 'partial' : 'unavailable', () => (systemSettings.value ? costDataText('cockpitSchedulerRulesLoadedRoutingstrategyCustomroutingrulesNoLocalRegistration') : costDataText('noCockpitSchedulerSettings')))
    // economics 状态读 data_quality.status（v5：measured/estimated/unavailable 诚实映射，不再统一 partial）
    const econStatus = accountEconomics.value
      ? (accountEconomics.value.data_quality.status === 'complete' ? 'measured'
        : accountEconomics.value.data_quality.status === 'estimated' ? 'estimated'
        : accountEconomics.value.data_quality.status === 'unavailable' ? 'unavailable' : 'partial')
      : 'unavailable'
    const unknown = accountEconomics.value?.data_quality.unknown_plan_count ?? 0
    setSourceState('economics', econStatus, () => (accountEconomics.value
      ? costDataText('cockpitUsageCostsCalculatedFromRecordedDataProcurementPrices', { p0: unknown > 0 ? costDataText('includesAccountsWithUnknownPlansEstimatedAs0', { p0: unknown }) : '' })
      : costDataText('noCockpitEconomicData')))
    setSourceState('exchangeRate', 'estimated', () => (costDataText('cockpitUsesTheOfflineFallbackExchangeRate')))

    // Publish the independent window only when its own loader has fresh data.
    if (retainedModelWindow) {
      models.value = retainedModelWindow.models
      modelRoutes.value = retainedModelWindow.routes
      modelAuditSummary.value = retainedModelWindow.audit
      modelRoutesTruncated.value = retainedModelWindow.routesTruncated
      modelStatsExactWindowFallback.value = retainedModelWindow.exactFallback
      modelStatsCompatibilityTruncated.value = retainedModelWindow.compatibilityTruncated
      modelCostFromRequestLog.value = retainedModelWindow.fromRequestLog
      modelWindowDetached.value = retainedModelWindow.detached
      modelCostSource.value = retainedModelWindow.source
      sourceStates.value.models = retainedModelWindow.modelState
      sourceStates.value.modelRoutes = retainedModelWindow.routeState
      sourceStates.value.modelAudit = retainedModelWindow.auditState
    }
    lastUpdated.value = new Date()
    loading.value = false
    error.value = ''
  }

  /**
   * cockpit 模型区**独立窗口**重算(2026-09-10 双轨)。
   *
   * 用户在模型成本区选了与顶部不同的窗口时调用:只重算 models / modelRoutes /
   * modelAuditSummary,不动主窗口的 trend/ops/账号等数据——两轨互不干扰。
   * 复用 store 里已算好的账号清单、价目表与倍率,口径与 loadFromCockpit 完全一致
   * (含长上下文档位价)。
   */
  function loadCockpitModelWindow(
    requestLog: CockpitRequestLogSummary | null,
    routes: CockpitOpsRouteAgg[] | null,
    range: CostCenterRange,
  ) {
    const sets = cockpitModelPriceSets.value
    const mult = cockpitCostMultiplier.value
    // 「成本账号」筛选同样作用于独立窗口重算(与主窗口同一套来源限定 ID)。
    const scopedLog = filterCockpitRequestLogByAccount(requestLog, modelCostAccountId.value)
    const rlModels = cockpitRequestLogToModelStats(scopedLog, sets, mult)
    // ★ 2026-09-25:与 :1290 同源 —— 标注与数值都看「链路可用」,不用 `rlModels.length`
    //   (那会把「该窗口 0 行」当成「该回退日历快照」)。
    modelCostFromRequestLog.value = !!requestLog?.available
    // ★ 2026-09-24:回退必须给**该独立窗口**的快照,不能传 `undefined`。
    //   `cockpitModelsToModelStats` 第一行就是 `if (!window?.models) return []` ⇒ 传 `undefined`
    //   等于**空表**:用户在模型区切了窗口、而单请求库在该窗口 0 行时,模型表整片变空,
    //   而同屏主路径(`loadFromCockpit`)明明会回退到日历快照 —— 两条路径行为不一致,
    //   用户看到的就是「切一下窗口,数据没了」。快照按 `range`(= 模型区窗口)选,
    //   与主路径同一套回退链(`cockpitWindowForRange`)。
    const modelWindow = cockpitStatsSnapshot.value
      ? cockpitWindowForRange(cockpitStatsSnapshot.value, range)
      : undefined
    // ★ 2026-09-25:判据改「链路可用」,与 :1292 主路径保持**同一套回退链**(两条路径行为
    //   必须一致,否则「主路径有数据、独立窗口重算没数据」又是同屏矛盾)。
    models.value = requestLog?.available
      ? rlModels
      : modelCostAccountId.value == null
        ? cockpitModelsToModelStats(modelWindow, mult, modelPricing.value)
        : []
    const sqlRoutes = cockpitRequestLogToModelRoutes(requestLog, accounts.value, sets, mult, cockpitGroupNameMap.value)
    if (sqlRoutes) {
      modelRoutes.value = sqlRoutes.routes
      modelRoutesTruncated.value = false
      modelAuditSummary.value = cockpitRoutesAuditSummary(sqlRoutes.totalRequests)
    } else if (routes?.length) {
      const agg = cockpitOpsRoutesToModelRoutes(routes, accounts.value, undefined, mult, modelPricing.value, null, cockpitGroupNameMap.value)
      modelRoutes.value = agg.routes
      modelRoutesTruncated.value = false
      modelAuditSummary.value = cockpitRoutesAuditSummary(agg.totalRequests)
    } else {
      modelRoutes.value = []
      modelRoutesTruncated.value = false
      modelAuditSummary.value = cockpitRoutesAuditSummary(0)
    }
    applyCockpitModelRouteAccountScope()
    modelWindowDetached.value = true
    setSourceState('models', requestLog?.available ? models.value.length ? 'measured' : 'empty'
      : models.value.length ? 'partial' : 'unavailable', () => (requestLog?.available
      ? models.value.length
        ? costDataText('modelCostsCalculatedForTheIndependentWindow', { p0: costCenterRangeLabel(range) })
        : modelCostAccountId.value != null
          ? costDataText('theSelectedAccountHasNoModelUsageInThe', { p0: costCenterRangeLabel(range) })
          : costDataText('noModelUsageInTheIndependentWindow', { p0: costCenterRangeLabel(range) })
      : models.value.length
        ? costDataText('independentCalendarModelFallback', { range: costCenterRangeLabel(range), snapshot: cockpitWindowLabelForRange(cockpitStatsSnapshot.value!, range) })
        : costDataText('independentModelSourceUnavailable', { range: costCenterRangeLabel(range) })))
    setSourceState('modelRoutes', sqlRoutes ? modelRoutes.value.length ? 'measured' : 'empty'
      : routes?.length ? 'partial' : 'unavailable', () => (sqlRoutes
      ? modelRoutes.value.length
        ? costDataText('routeDetailsAggregatedForTheIndependentWindow', { p0: costCenterRangeLabel(range) })
        : modelCostAccountId.value != null
          ? costDataText('theSelectedAccountHasNoRouteRecordsInThe', { p0: costCenterRangeLabel(range) })
          : costDataText('noRouteRecordsInTheIndependentWindow', { p0: costCenterRangeLabel(range) })
      : routes?.length
        ? costDataText('independentRouteLogFallback', { range: costCenterRangeLabel(range) })
        : costDataText('independentRouteSourceUnavailable', { range: costCenterRangeLabel(range) })))
  }

  /** 模型窗口改回与主窗口一致:清掉分离标记,由主 reload 统一出数。 */
  function detachModelWindow(detached: boolean) {
    modelWindowDetached.value = detached
  }

  /**
   * cliproxy CPA 数据装入:把 CPA 插件 usage_events + model_prices 适配进 store ref,
   * 复用全部 sub2api 同款 computed,不调任何 adminAPI。由 CostCenterView reload() 在
   * connectionType === 'cliproxy' 时调用。
   *
   * 填充:accounts(auth_index 聚合)、todayStats(窗口请求用量)、models(按模型聚合)、
   * trend(真实多桶时序)、ops(latency/ttft/失败/状态码真实)、modelPricing(LiteLLM 3213 模型)、
   * accountEconomics(events×prices 反算 + 默认价推算)。
   * 真缺:costLossStates/accountUsage/modelRoutes/systemSettings(无账本/配额窗口/路由日志/调度设置)
   * → computed 返空,UI 走 unavailableValueLabel。
   *
   * 口径诚实标注:成本 = usage_events token × model_prices per-token 反算(LiteLLM 官方定价,估算非事实账单);
   * 账号 = auth_index 聚合(无账号实体);无 plan_type → unknown → 默认价 0,标 estimated。
   *
   * 双轨窗口(2026-09-23):`range` 是**顶部主窗口**,驱动 trend/ops/accountEconomics/账号窗口用量;
   * `modelRange` 是**模型区独立窗口**(视图的 modelCostRange),只驱动 models 与 modelRoutes 两张表。
   * 两者互不干扰 —— 用户把模型区切到 7 天、顶部仍留 1 小时时,两张表按 7 天、其余按 1 小时。
   * cliproxy 没有后端接口,两张表由适配器在本地按 `requested_at` 半开区间过滤
   * (events 是 Rust 侧截断的近 30 天全量,src-tauri/src/main.rs:683)。
   */
  function loadFromCliproxy(
    authFiles: AuthFile[],
    config: CliproxyConfig | null,
    _version: string | null,
    events: CliproxyUsageEvent[],
    prices: Record<string, LitellmPricing>,
    keyUsage: Record<string, Record<string, ApiKeyUsageBucket>>,
    range: CostCenterRange,
    modelRange: CostCenterRange,
    cnyPerUsd: number,
    queryNow = new Date(),
    usageReadAvailable?: boolean,
    managementReadError?: string | (() => string) | null,
  ) {
    // 切到 cliproxy 源时先清掉 cockpit 的窗口快照与派生序列 —— 这条路径不经过 reload(),
    // 否则 cockpit→cliproxy 同进程切换后,号池表成本/请求列与健康图会继续显示 cockpit 的数字,
    // 而表头标的是 cliproxy 的 rangeLabel(数据跨源 + 标签不符)。
    resetRangeWindowState()
    // E6:cliproxy 账号 id 与上一源可能撞车,账号级探测结果必须按源隔离。
    applySourceKey('cliproxy')
    cliproxyQueryNow = queryNow
    // 存真实数据源:auth-files(账号实体) + api-key-usage(全局成功率,仪表盘同款)
    const managementTarget = getCliproxyManagementBase()
    if (managementReadError) {
      if (cliproxyManagementSnapshotSource !== managementTarget) {
        cliproxyAuthFiles.value = []
        cliproxyManagementSnapshotAt.value = null
      }
      authFiles = cliproxyAuthFiles.value
    } else {
      cliproxyAuthFiles.value = authFiles
      cliproxyManagementSnapshotSource = managementTarget
      cliproxyManagementSnapshotAt.value = queryNow.toISOString()
    }
    const localAccountLink = isLocalCliproxyTarget(managementTarget)
    cliproxyLocalAccountLink.value = localAccountLink
    cliproxyKeyUsage.value = localAccountLink ? keyUsage : {}
    // vendorMap:LiteLLM litellm_provider 反查(model→真实厂商:智谱/深度求索/商汤/月之暗面)
    const vendorMap = litellmModelVendorMap(prices)
    // 厂商分组统计:每厂商 model 集合+请求数(供分组 tabs 两源合并)
    cliproxyVendorStats.value = cliproxyEventsToVendorStats(events, vendorMap)
    // 推理档位分布:空串(上游未记录)单列,不与真实档位合并、不计入档位占比。
    cliproxyReasoningEfforts.value = cliproxyEventsToReasoningEfforts(events, range, queryNow)
    // 账号:两源合并——auth-files(11 个真实配置,antigravity/codex/grok) + CPA events 聚合(36 个请求账号,智谱/sensenova/deepseek)
    // 两套 auth_index 不重叠,合并后分组 tabs + 号池表行都两源显示
    const attributedEvents = events.filter(event => !!event.auth_index)
    const authFileAccounts = localAccountLink ? cliproxyAuthFilesToAccounts(authFiles, attributedEvents) : []
    const managementIndexes = new Set(localAccountLink ? authFiles.map(file => file.auth_index).filter(index => !!index?.trim()) : [])
    const eventAccounts = cliproxyEventsToAccounts(attributedEvents.filter(event => !managementIndexes.has(event.auth_index)), vendorMap)
    accounts.value = [...authFileAccounts, ...eventAccounts]
    // 2026-09-16 B3:events 被 Rust 侧硬截断到 30 天(src-tauri/src/main.rs:675),
    // 不过滤就等于把近 30 天当"今日"展示。按**自然日**过滤,与 sub2api 的 todayStats 语义
    // 及界面"今日"标签对齐(requested_at 已是毫秒,main.rs:689)。
    todayStats.value = cliproxyEventsToTodayStats(events, prices, cockpitCostMultiplier.value, cliproxyUsageWindowBounds('today', queryNow)) // events 维度,与 eventAccounts id 一致;成本乘倍率兜底
    // 与主观察窗同一锚点，保留全量 usage-only ID；当天窗口也显式发布，不隐式借今日快照。
    {
      const windowStats = cliproxyEventsToTodayStats(events, prices, cockpitCostMultiplier.value, cliproxyUsageWindowBounds(range, queryNow))
      const nextWindowStats: Record<string, AccountWindowUsage> = {}
      for (const [id, stats] of Object.entries(windowStats)) {
        const usage = accountWindowUsageFromWindowStats(stats)
        // 拿不到 requests 的账号整体跳过 ⇒ 视图显示"无数据",不伪造全 0 记录。
        if (usage) nextWindowStats[id] = usage
      }
      rangeAccountStats.value = nextWindowStats
      rangeAccountStatsComplete.value = usageReadAvailable ?? events.length > 0
      // 已按窗口起点过滤 ⇒ 缺失即"该账号在本窗口无记录",视图不得回退自然日。
      rangeWindowAuthoritative.value = true
      setSourceState(
        'rangeStats',
        Object.keys(nextWindowStats).length
          ? unattributedRequests(nextWindowStats) || Object.values(nextWindowStats).some(row => row.cost == null || row.standard_cost == null) ? 'partial' : 'measured'
          : 'empty',
        () => (Object.keys(nextWindowStats).length
          ? costDataText('perAccountUsageForLoadedFromTheCpaEvents', { p0: costCenterRangeLabel(range), p1: unattributedRequests(nextWindowStats) ? costDataText('requestsHaveNoAccountAttributionAndAreKeptIn', { p0: unattributedRequests(nextWindowStats) }) : '' })
          : costDataText('noAccountRequestRecordsIn', { p0: costCenterRangeLabel(range) })),
      )
    }
    // 与路由明细同窗口:用模型区独立窗口 modelRange,不用顶部主窗口 range
    // (表头渲染的是 modelCostRangeLabel,数字必须同窗口)。
    models.value = cliproxyEventsToModelStats(events, prices, modelRange, cockpitCostMultiplier.value, queryNow)
    trend.value = cliproxyEventsToTrend(events, prices, range, cockpitCostMultiplier.value, queryNow)
    trendBucketHours.value = costTrendBucketHours(range)
    trendQueryWindow.value = cliproxyUsageWindowBounds(range, queryNow)
    rangeAccountStatsWindow.value = trendQueryWindow.value
    rangeAccountStatsScope.value = { source: 'cliproxy', instanceId: 'local' }
    trendUsesAccountCost.value = true

    // accountUsage:CPA primary_used_percent,与 events 账号 id 一致(auth-files 账号无此数据,row.usage 显示无)
    accountUsage.value = cliproxyEventsToAccountUsage(events, queryNow)
    cliproxyQuotaDataState.value = usageReadAvailable === false ? 'read_unavailable'
      : Object.keys(accountUsage.value).length ? 'reported'
        : usageReadAvailable === true || events.length ? 'not_reported' : 'not_loaded'
    // cliproxyLatencyMap:per-account 最新 latency_ms(CPA 真实采集,供 probe 替代 adminAPI.testAccount)
    const latestPerAuth = new Map<string, { at: number; latency: number }>()
    for (const ev of events) {
      if (!ev.auth_index?.trim()) continue
      if (ev.latency_ms > 0 && ev.requested_at > (latestPerAuth.get(ev.auth_index)?.at ?? -Infinity)) {
        latestPerAuth.set(ev.auth_index, { at: ev.requested_at, latency: ev.latency_ms })
      }
    }
    cliproxyLatencyMap.value = {}
    for (const [authIndex, value] of latestPerAuth) {
      cliproxyLatencyMap.value[authIndexToAccountId(authIndex)] = value.latency
    }

    // ops:CPA 持续采集 latency/ttft/failed/status_code,cliproxy 现在能做 ops(不再 unavailable)
    const ops = cliproxyEventsToOps(events, range, queryNow)
    opsOverview.value = ops.overview
    opsTrend.value = ops.trend
    opsErrorTrend.value = ops.errorTrend

    // modelPricing:LiteLLM 3213 模型 per-token → ModelDefaultPricing(字段名对齐,供 view 复用)
    modelPricing.value = litellmToModelPricing(prices)
    pricingStatus.value = null // CPA 无"价格目录刷新状态"概念,留 null

    accountEconomics.value = cliproxyEventsToEconomics(events, prices, cnyPerUsd, vendorMap, range, cockpitCostMultiplier.value, queryNow)

    // modelRoutes:CPA events 按 model+auth_index 派生简化路由(无响应声明/渠道维度,诚实标注)
    // 成本乘倍率兜底(与 economics/todayStats 同口径)
    // 与模型成本表同窗口:用 modelRange,不用主窗口 range(表头是 modelCostRangeLabel)。
    const cpRoutes = cliproxyEventsToModelRoutes(events, prices, accounts.value, modelRange, cockpitCostMultiplier.value, queryNow)
    // 转成 ModelRouteRow 子集填 modelRoutes(让 view 的"真实模型/接口明细"表渲染)
    // CPA 无响应声明模型/渠道/分组维度,这些列显示"—"或"无",诚实降级
    modelRoutes.value = cpRoutes.map((r) => ({
      key: JSON.stringify([r.model, r.requestedModel, r.authIndex, r.provider]),
      requestedModel: r.requestedModel,
      upstreamModel: r.model,
      upstreamResponseModel: '',
      upstreamModelMismatch: null,
      modelAuditStatus: 'unobserved' as const,
      mappingChain: `${r.provider} → ${r.model}`,
      provider: r.provider,
      accountId: r.accountId,
      accountName: r.accountName,
      accountType: r.accountType,
      accountIdentitySource: r.accountIdentitySource,
      channelId: null,
      channelName: '',
      groupId: null,
      groupName: '',
      inboundEndpoint: '',
      upstreamEndpoint: '',
      channelPricing: null,
      priceEvidence: r.priceEvidence,
      knownStandardCost: r.knownReferenceCostUsd,
      knownAccountCost: r.knownCostUsd,
      requests: r.requests,
      failedRequests: r.failedRequests,
      zeroTokenRequests: r.zeroTokenRequests,
      failedZeroTokenRequests: r.failedZeroTokenRequests,
      totalTokens: r.totalTokens,
      inputTokens: r.inputTokens,
      cacheReadTokens: r.cacheReadTokens,
      outputTokens: r.outputTokens,
      standardCost: r.referenceCostUsd,
      accountCost: r.costUsd,
      costBasis: costDataText('cpaLocalRecordedTokensModelReferencePricesAccountRate', { p0: r.failedZeroTokenRequests ? costDataText('failedRequestsHaveNoValidRecordedTokens0Does', { p0: r.failedZeroTokenRequests }) : '' }),
      // 成本算不出来时 r.costUsd 已是 null(带 costUnknown 标注),显示层渲染「成本未知」。
      costUnknown: r.costUnknown,
      // cliproxy 没有营收层 ⇒ 这里是**结构性假营收**:ModelRouteRow.revenue 的契约是
      // number | null(modelRouteAnalysis.ts「null = 该源不掌握营收」),0 会被渲染成
      // 「用户计费 $0.000000」,与"实测营收为零"无从区分。对齐 cockpit 路由明细的写法。
      revenue: null,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    }))
    // CPA 的用量路由可部分展示，但响应声明模型审计仍不可用。modelAuditSummary 是单一 ref，视图的
    // 「替换请求成本」:note 直接读它且**无 sourceStates 守卫** —— 不清就会把上一源
    // (sub2api/cockpit)的「标准 $X · 用户计费 $Y」渲染在 cliproxy 的"无数据"旁边。
    //
    // mismatchRevenue 必须显式置 null 而不是用 summarizeModelAudit([]) 的 0:
    // 该字段契约是「null = 该数据源不掌握营收,必须渲染「—」而不是 0」
    // (modelCostAnalysis.ts:44),而 CPA events 根本没有 actual_cost(用户计费)维度。
    // 视图在 cliproxy 下走的是**非** cockpit 分支,会真的把 0 渲染成「用户计费 $0.000000」——
    // 正是 cockpitAdapter.ts:1009 明令禁止的假零。
    modelAuditSummary.value = { ...summarizeModelAudit([]), mismatchRevenue: null }

    // 清空 cliproxy 真无的维度,避免上一连接残留
    costLossStates.value = []
    modelRoutesTruncated.value = false
    modelStatsExactWindowFallback.value = false
    modelStatsCompatibilityTruncated.value = false
    trendTruncated.value = false
    cockpitWindowHours.value = null
    cockpitTrendBucketHours.value = null
    opsTrendFromRequestLog.value = false
    cockpitWindowRange.value = null
    cockpitCostFromRequestLog.value = false
    // 切离 cockpit 时模型区来源标记与快照一并复位,避免残留上一次的 cockpit 快照
    // 被模型区独立窗口重算当成当前源(跨源串味)。
    modelCostFromRequestLog.value = false
    stats.value = null

    // sourceStates:management 真实维度标 measured,CPA 成本维度标 estimated/measure,真无的 unavailable
    if (managementReadError) {
      const previous = cliproxyManagementSnapshotAt.value
      sourceStates.value.accounts = sourceState('accounts', previous ? 'stale' : 'unavailable',
        () => (`${typeof managementReadError === 'function' ? managementReadError() : managementReadError}${previous ? costDataText('keepingTheAccountSnapshotFrom', { p0: previous }) : costDataText('managementAccountsHaveNotBeenObtainedProcurementCannotBe')}`),
        previous ? new Date(previous) : null)
    } else {
      setSourceState('accounts', accounts.value.length ? 'measured' : 'empty', () => (accounts.value.length ? costDataText('localHistoricalUsageIdentitiesHistoricalRequestStatusDoesNot', { p0: authFileAccounts.length, p1: localAccountLink ? costDataText('localManagementEntities') : costDataText('linkedManagementEntities'), p2: eventAccounts.length }) : costDataText('noCpaAccountsOrUsageIdentities')))
    }
    setSourceState('todayStats', Object.keys(todayStats.value).length ? 'measured' : 'empty', () => (Object.keys(todayStats.value).length ? costDataText('cpaWindowRequestUsageLoadedEventsAccountDimension') : costDataText('noCpaRequestUsage')))
    setSourceState('dashboard', trend.value.length ? 'measured' : 'empty', () => (trend.value.length ? costDataText('cpaUsageEventsAggregatedIntoRecordedTimeSeriesBuckets') : costDataText('noCpaTimeSeriesSamplesInThisWindow')))
    setSourceState('models', models.value.length ? models.value.some(model => model.cost == null || model.account_cost == null) ? 'partial' : 'measured' : 'empty', () => (models.value.length ? costDataText('cpaModelUsageLoadedFailedZeroTokenRecordsDo') : costDataText('noCpaModelUsage')))
    setSourceState('pricing', Object.keys(modelPricing.value).length ? 'measured' : 'unavailable', () => (Object.keys(modelPricing.value).length ? costDataText('cpaModelPricesCacheLoadedModels', { p0: Object.keys(modelPricing.value).length }) : costDataText('noCpaPriceCache')))
    setSourceState('ops', ops.trend.length ? 'measured' : (opsOverview.value ? 'partial' : 'unavailable'), () => (ops.trend.length ? costDataText('cpaOperationalDataAggregatedIntoTrendsRequestsSuccessesFailures') : (opsOverview.value ? costDataText('derivedCpaCountsSuccessesFailuresNoOperationalSamplesIn') : costDataText('noCpaOperationalData'))))
    setSourceState('costLoss', 'unavailable', () => (costDataText('cliproxyAccountsHaveNoProcurementRefundLedgerOrTerminal')))
    setSourceState('accountUsage', cliproxyQuotaDataState.value === 'reported' ? 'measured' : 'unavailable', () => (cliproxyQuotaDataState.value === 'reported'
      ? costDataText('cpaReportedPerIdentityQuotaSnapshotsFreshnessDependsOn')
      : cliproxyQuotaDataState.value === 'not_reported' ? costDataText('localUsageRecordsLoadedButPerAccountQuotaFields')
        : cliproxyQuotaDataState.value === 'read_unavailable' ? costDataText('cpaLocalUsageStoreUnavailableCannotDetermineWhetherQuota') : costDataText('noVerifiableCpaQuotaSourceReadResultYet')))
    // 此前 CPA 只要有 events 就把响应模型审计报 measured，于是 overview 的「审计已观测 / 模型一致 /
    // 上游替换 / 未观测」读 modelAuditSummary(初值 summarizeModelAudit([]) = 全 0)显示 0 冒充实测。
    // 根因:CPA usage_events **没有响应声明模型/渠道/分组维度**(见 cliproxyAdapter.ts:164-165),
    // 模型审计在 cliproxy 下**无真实语义** —— 必须 unavailable,让 UI 走它已有的 unavailable 分支
    // 显示"无数据",而不是用 0 冒充已测量的事实。
    setSourceState('modelRoutes', modelRoutes.value.length ? 'partial' : 'empty', () => (modelRoutes.value.length ? costDataText('cpaRecordedModelsUsageFailuresResponseDeclarationsChannelsGroups') : costDataText('noCpaRequestRecordsInTheSelectedModelWindow')))
    // FIX 1:视图「模型审计」4+1 格读 modelAudit(与路由明细表用的 modelRoutes 解耦)。
    setSourceState('modelAudit', 'unavailable', () => (costDataText('cpaDoesNotProvideResponseDeclaredModelsOrChannel')))
    setSourceState('settings', config ? 'measured' : 'unavailable', () => (config ? costDataText('managementConfigLoadedRoutingDebuggingPlugins') : costDataText('managementConfigUnavailable')))
    const econStatus = accountEconomics.value
      ? (accountEconomics.value.data_quality.status === 'complete' ? 'measured'
        : accountEconomics.value.data_quality.status === 'estimated' ? 'estimated'
        : accountEconomics.value.data_quality.status === 'unavailable' ? 'unavailable' : 'partial')
      : 'unavailable'
    setSourceState('economics', econStatus, () => (accountEconomics.value
      ? costDataText('localCpaPluginCostUsageEventsTokensModelPrices', { p0: localAccountLink ? costDataText('linkedToTheDefaultLocalGatewayAccounts') : costDataText('notLinkedToTheCurrentRemoteManagementInstance') })
      : costDataText('noCpaEconomicData')))
    setSourceState('exchangeRate', 'estimated', () => (costDataText('cliproxyUsesTheOfflineFallbackExchangeRate')))
    if (usageReadAvailable === false) {
      for (const key of ['dashboard', 'todayStats', 'rangeStats', 'models', 'ops', 'accountUsage', 'modelRoutes', 'economics'] as const) {
        setSourceState(key, 'unavailable', () => (costDataText('cpaLocalUsageStoreUnavailableUnreadDataCannotBe')))
      }
    }

    lastUpdated.value = new Date()
    loading.value = false
    error.value = ''
  }

  /** cockpit 模式本地成本档案读写(cockpit 无后端,存 %APPDATA%/2api-console/cockpit_cost_profiles.json)。
   *  key 为来源限定的完整账号 ID；旧数字键只保留待归属，不猜测映射。
   *  写入后更新 accounts.value 对应账号的 extra.cost_profile → accountLedgers computed 自动重算(无需 reload)。 */
  function applyCostProfileToAccount(account: Account, profile: CostProfile): Account {
    return {
      ...account,
      extra: {
        ...(account.extra ?? {}),
        cost_profile: {
          amount: profile.amount,
          currency: profile.currency,
          billing_cycle: profile.billing_cycle,
          started_at: profile.started_at,
          algorithm_version: profile.algorithm_version,
        },
      },
    }
  }

  function requireLocalCostAccountId(id: CostAccountId): string {
    if (typeof id !== 'string' || !/^(cockpit|cliproxy):/.test(id)) throw new Error(costDataText('localCostProfilesRequireASourceQualifiedAccountId'))
    return id
  }

  async function preloadLocalCostProfiles(): Promise<void> {
    if (localCostProfilesLoading) return localCostProfilesLoading
    localCostProfilesLoading = (async () => {
      try {
        const map = await readCostProfiles()
        localCostProfiles.value = map
        cockpitCostMultiplier.value = resolveCostMultiplier(map[COCKPIT_MULTIPLIER_KEY]?.amount)
        localCostProfilesReadError.value = null
      } catch (readError) {
        localCostProfilesReadError.value = readError instanceof Error ? readError.message : String(readError)
      }
    })()
    try { await localCostProfilesLoading } finally { localCostProfilesLoading = null }
  }

  async function saveCockpitCostProfile(account: Account, profile: CostProfile): Promise<Account> {
    saving.value = true
    try {
      const id = requireLocalCostAccountId(account.id)
      const map = await readCostProfiles()
      map[id] = profile
      await writeCostProfiles(map)
      localCostProfiles.value = map
      localCostProfilesReadError.value = null
      const updated = applyCostProfileToAccount(account, profile)
      const index = accounts.value.findIndex((item) => item.id === account.id)
      if (index >= 0) accounts.value.splice(index, 1, updated)
      return updated
    } finally {
      saving.value = false
    }
  }

  async function bulkSaveCockpitCostProfile(accountIds: CostAccountId[], profile: CostProfile): Promise<void> {
    saving.value = true
    try {
      const ids = accountIds.map(requireLocalCostAccountId)
      const map = await readCostProfiles()
      for (const id of ids) map[id] = profile
      await writeCostProfiles(map)
      localCostProfiles.value = map
      localCostProfilesReadError.value = null
      const idSet = new Set(accountIds)
      accounts.value = accounts.value.map((account) =>
        idSet.has(account.id) ? applyCostProfileToAccount(account, profile) : account,
      )
    } finally {
      saving.value = false
    }
  }

  /** reload 后回填本地 cost_profile 到 accounts(cockpit 账号原始 extra 无 cost_profile,
   *  塞入后 resolveCostProfile 读 custom → accountLedgers 用用户手动配置而非默认价)。
   *  在 loadFromCockpit 装完 accounts 后调用。 */
  async function mergeLocalCostProfiles(): Promise<void> {
    if (!localCostProfiles.value && localCostProfilesReadError.value == null) await preloadLocalCostProfiles()
    const map = localCostProfiles.value ?? {}
    accounts.value = accounts.value.map((account) => {
      const profile = typeof account.id === 'string' && /^(cockpit|cliproxy):/.test(account.id) ? map[account.id] : undefined
      return profile ? applyCostProfileToAccount(account, profile) : account
    })
    const snapshot = accountEconomics.value
    if (activeSourceKey.value === 'cliproxy' && snapshot && isLocalEconomicsSnapshot(snapshot)) {
      accountEconomics.value = buildLocalEconomicsSnapshot({
        accounts: accounts.value.map((account) => ({ account, health: {
          successCount: 0, failureCount: 0, state: describeCurrentAccountState(account).state,
        } })),
        billedUsdTotal: snapshot.actual.billed_usd,
        accountCostUsdTotal: snapshot.actual.account_cost_usd,
        outputBasis: 'api_value',
        cnyPerUsd: snapshot.cny_per_usd,
        now: cliproxyQueryNow?.getTime() ?? Date.now(),
        window: snapshot.local_derived.window,
        impairmentComplete: false,
        costMultiplier: cockpitCostMultiplier.value,
      })
    }
  }

  /** 保存 cockpit 全局倍率（写入 cockpit_cost_profiles.json 的特殊 key）。 */
  async function saveCockpitCostMultiplier(multiplier: number): Promise<void> {
    const map = await readCostProfiles()
    const resolved = resolveCostMultiplier(multiplier)
    map[COCKPIT_MULTIPLIER_KEY] = { amount: resolved } as CostProfile
    await writeCostProfiles(map)
    localCostProfiles.value = map
    localCostProfilesReadError.value = null
    cockpitCostMultiplier.value = resolved
  }

  async function refreshPricingCatalog() {
    pricingRefreshing.value = true
    try {
      pricingStatus.value = await adminAPI.channels.refreshPricing()
      return pricingStatus.value
    } finally {
      pricingRefreshing.value = false
    }
  }

  async function saveCostProfile(account: Account, profile: CostProfile) {
    saving.value = true
    try {
      const id = requireSub2apiAccountId(account.id)
      const updated = await adminAPI.accounts.update(id, {
        extra: {
          ...(account.extra ?? {}),
          cost_profile: {
            amount: profile.amount,
            currency: profile.currency,
            billing_cycle: profile.billing_cycle,
            started_at: profile.started_at,
            algorithm_version: profile.algorithm_version,
          },
        },
      })
      const index = accounts.value.findIndex((item) => item.id === account.id)
      if (index >= 0) accounts.value.splice(index, 1, updated)
      return updated
    } finally {
      saving.value = false
    }
  }

  async function bulkSaveCostProfile(accountIds: CostAccountId[], profile: CostProfile) {
    saving.value = true
    try {
      const ids = accountIds.map(requireSub2apiAccountId)
      if (captureAuthConnection().connection?.type === 'cliproxy' || activeSourceKey.value === 'cockpit' || activeSourceKey.value === 'cliproxy') throw new Error(costDataText('theCurrentSourceIsNotSub2apiRemoteAccountBulk'))
      return await adminAPI.accounts.bulkUpdate(ids, {
        extra: {
          cost_profile: {
            amount: profile.amount,
            currency: profile.currency,
            billing_cycle: profile.billing_cycle,
            started_at: profile.started_at,
            algorithm_version: profile.algorithm_version,
          },
        },
      })
    } finally {
      saving.value = false
    }
  }

  async function probeAccount(account: Account) {
    const id = requireSub2apiAccountId(account.id)
    probes.value[String(account.id)] = {
      loading: true,
      message: costDataText('contactingTheRealUpstream'),
    }
    try {
      const result = await adminAPI.accounts.testAccount(id)
      probes.value[String(account.id)] = {
        loading: false,
        success: result.success,
        latency_ms: result.latency_ms,
        message: result.message,
      }
      return result
    } catch (probeError: any) {
      probes.value[String(account.id)] = {
        loading: false,
        success: false,
        message: probeError?.message || 'Probe failed',
      }
      throw probeError
    }
  }

  return {
    accounts,
    costLossStates,
    accountEconomics,
    accountUsage,
    todayStats,
    rangeAccountStats,
    rangeAccountStatsWindow,
    rangeAccountStatsComplete,
    rangeAccountStatsScope,
    stats,
    trend,
    trendBucketHours,
    trendQueryWindow,
    sub2apiRequestWindow,
    sub2apiWindowConnection,
    sub2apiWindowReading,
    trendUsesAccountCost,
    trendTruncated,
    cockpitWindowHours,
    cockpitTrendBucketHours,
    opsTrendFromRequestLog,
    cockpitWindowLabel,
    cockpitCostFromRequestLog,
    modelCostFromRequestLog,
    models,
    loadCockpitModelWindow,
    detachModelWindow,
    modelCostSource,
    modelCostRange,
    modelWindowDetached,
    modelCostAccountId,
    modelAuditMismatchOnly,
    modelCostControlsDisabled,
    modelAuditSummary,
    modelRoutes,
    modelRoutesTruncated,
    modelStatsExactWindowFallback,
    modelStatsCompatibilityTruncated,
    modelPricing,
    pricingStatus,
    pricingRefreshing,
    opsOverview,
    opsTrend,
    opsErrorTrend,
    cockpitHealthSeries,
    systemSettings,
    probes,
    sourceStates,
    loading,
    saving,
    error,
    lastUpdated,
    exchangeRate,
    accountStats,
    rangeStats,
    rangeWindowAuthoritative,
    resetRangeWindowState,
    clearCockpitSourceData,
    reload,
    invalidatePendingRequest,
    loadAccountEconomics,
    loadFromCockpit,
    loadFromCliproxy,
    refreshPricingCatalog,
    saveCostProfile,
    bulkSaveCostProfile,
    probeAccount,
    cliproxyLatencyMap,
    cliproxyKeyUsage,
    cliproxyUsageSummary,
    cliproxyAuthFiles,
    cliproxyManagementSnapshotAt,
    cliproxyLocalAccountLink,
    cliproxyQuotaDataState,
    cliproxyVendorStats,
    cliproxyReasoningEfforts,
    saveCockpitCostProfile,
    bulkSaveCockpitCostProfile,
    mergeLocalCostProfiles,
    preloadLocalCostProfiles,
    legacyLocalCostProfileCount,
    localCostProfilesError,
    cockpitCostMultiplier,
    saveCockpitCostMultiplier,
  }
}

function shouldLoadUsageWindow(account: Account): boolean {
  if (account.platform === 'gemini') return true
  if (account.platform === 'anthropic') return account.type === 'oauth' || account.type === 'setup-token'
  return account.type === 'oauth' && ['openai', 'antigravity', 'grok'].includes(account.platform)
}

export function accountUsageSource(account: Pick<Account, 'platform' | 'type'>): 'passive' | 'active' {
  return account.platform === 'anthropic' && (account.type === 'oauth' || account.type === 'setup-token')
    ? 'passive'
    : 'active'
}
