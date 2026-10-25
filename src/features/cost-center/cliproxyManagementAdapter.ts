import { costDataText } from './costDataText'
/**
 * cliproxy management API 适配层 — 真实账号实体 + 配置
 *
 * 数据源:cliproxy /v0/management/*(经 cliproxyClient):
 * - /auth-files(真实账号实体:provider 不乱码、email/status/success/failed/created_at/account_type)
 * - /config(路由策略/插件/调试等完整配置)
 *
 * 与 CPA 互补:management 做账号/配置(真实实体),CPA 做成本/时序/配额(唯一成本源)。
 * 按 auth_index 关联:CPA events 补 latency/tokens/成功率,auth-files 提供实体信息。
 */

import type { AccountPlatform, AccountType } from '@/types'
import type { SourceAccount as Account } from './sourceTypes'
import { cliproxyTokenBreakdown } from '@/api/cliproxy/cpaData'
import type { AuthFile, CliproxyConfig } from '@/api/cliproxy/management'
import type { CliproxyUsageEvent, LitellmPricing } from '@/api/cliproxy/cpaData'
import { authIndexToAccountId, pricedEventCostUsd, resolveModelPricing, resolveCostMultiplier, cliproxyUsageWindowBounds, cliproxyAuthTypeToAccountType } from './cliproxyAdapter'
import { isUnknownCostBasis } from './costBasis'
import type { CostCenterRange } from './useCostCenterData'
import { mergeRoutePriceEvidence, routeEvidenceFromQuote, type RoutePriceEvidence } from './modelRouteAnalysis'

/** auth-files provider 字符串 → AccountPlatform(management API provider 不乱码,直接映射)。 */
function authFileProviderToPlatform(provider: string): AccountPlatform {
  const p = (provider || '').toLowerCase()
  if (p.includes('gemini')) return 'gemini'
  if (p.includes('claude') || p.includes('anthropic')) return 'anthropic'
  if (p.includes('grok') || p.includes('xai')) return 'grok'
  if (p.includes('antigravity')) return 'antigravity'
  if (p.includes('sensenova') || p.includes(costDataText('sensenova'))) return 'sensenova'
  // codex/openai/openai-compatibility 归 openai
  return 'openai'
}

/** 按 auth_index 聚合 CPA events 成中间态(补 latency/tokens/健康度,auth-files 无这些)。 */
interface EventAgg {
  authIndex: string
  authType: string
  model: string
  provider: string
  earliestMs: number
  latestMs: number
  successCount: number
  failureCount: number
  latencyMs: number
}

function aggregateEventsByAuth(events: CliproxyUsageEvent[]): Map<string, EventAgg> {
  const map = new Map<string, EventAgg>()
  for (const ev of events) {
    if (!ev.auth_index?.trim()) continue
    const key = ev.auth_index
    let acc = map.get(key)
    if (!acc) {
      acc = {
        authIndex: key,
        authType: ev.auth_type,
        model: ev.model,
        provider: ev.provider,
        earliestMs: ev.requested_at,
        latestMs: ev.requested_at,
        successCount: 0,
        failureCount: 0,
        latencyMs: 0,
      }
      map.set(key, acc)
    }
    acc.earliestMs = Math.min(acc.earliestMs, ev.requested_at)
    acc.latestMs = Math.max(acc.latestMs, ev.requested_at)
    if (ev.failed) acc.failureCount += 1
    else acc.successCount += 1
    if (ev.latency_ms > 0) acc.latencyMs = ev.latency_ms // events DESC,最新有 latency 的即最新
  }
  return map
}

/** auth-files + CPA events → Account[](真实实体:email/provider/status,CPA 补 latency/健康度)。
 *  id 与 CPA adapter 共享完整的 source/raw identity。
 *  scheduler_score 用 success/failed 派生 base_score(调用评分列)。 */
export function cliproxyAuthFilesToAccounts(authFiles: AuthFile[], events: CliproxyUsageEvent[]): Account[] {
  const eventMap = aggregateEventsByAuth(events)
  return authFiles.filter(af => af.auth_index?.trim() || af.id?.trim() || af.name?.trim()).map((af) => {
    const authIndex = af.auth_index?.trim() ? af.auth_index : null
    const id = authIndex != null
      ? authIndexToAccountId(authIndex)
      : `cliproxy:management-file:${encodeURIComponent(af.id?.trim() ? af.id : af.name)}`
    const evAgg = authIndex ? eventMap.get(authIndex) : undefined
    const platform = authFileProviderToPlatform(af.provider)
    const sourceType = cliproxyAuthTypeToAccountType(af.account_type)
      ?? (!af.account_type?.trim() ? cliproxyAuthTypeToAccountType(evAgg?.authType) : null)
    const type: AccountType = sourceType ?? 'oauth'
    const name = af.email || af.name || af.auth_index || 'unknown'
    // 健康度:auth-files 真实 status/disabled/unavailable(不派生失败率,auth-files success/failed 实测全0)
    // disabled→inactive, unavailable/error→error, 否则 active
    const afStatus = (af.status || '').toLowerCase()
    const status: 'active' | 'inactive' | 'error' = af.disabled
      ? 'inactive'
      : af.unavailable || afStatus === 'error'
        ? 'error'
        : 'active'
    const errorMessage = af.status_message || (af.disabled ? costDataText('disabled') : af.unavailable ? costDataText('unavailable') : null)
    // CPA events 按 auth_index 关联补 latency/last_used(auth_index 不重叠时 evAgg=undefined,留 null)
    const createdAt = af.created_at || ''
    const lastUsed = evAgg ? new Date(evAgg.latestMs).toISOString() : (af.last_refresh || null)
    return {
      id,
      name,
      platform,
      type,
      credentials: undefined,
      credentials_status: undefined,
      extra: {
        cliproxy_identity_source: 'management',
        cliproxy_status_basis: 'management_current',
        cliproxy_usage_linked: !!evAgg,
        cliproxy_auth_type_known: sourceType != null,
        cliproxy_created_at_known: !!createdAt,
      },
      proxy_id: null,
      concurrency: 0,
      // auth-files 真实优先级;auth-file 里**没有**这个字段时置 null。
      // 此前 `?? 0` 会把「未配置」说成「0 · 最低」——把「源没给」渲染成「源给了 0」。
      priority: af.priority ?? null,
      scheduler_score: af.weight != null ? { base_score: af.weight, sticky_weighted_enabled: false } : null, // auth-files 真实 weight(credentialweight),未配置 null
      status,
      error_message: errorMessage,
      last_used_at: lastUsed,
      expires_at: null,
      auto_pause_on_expired: false,
      created_at: createdAt,
      updated_at: lastUsed || createdAt,
      schedulable: !af.disabled && !af.unavailable,
      rate_limited_at: null,
      rate_limit_reset_at: null,
      overload_until: null,
      temp_unschedulable_until: null,
      temp_unschedulable_reason: null,
      session_window_start: null,
      session_window_end: null,
      session_window_status: null,
    } as Account
  })
}

/** config + scalars → cliproxyOverview(替代 loadCliproxyOverview 多次请求)。 */
export interface CliproxyOverviewState {
  version: string | null
  authFileCount: number
  routingStrategy: string | null
  debug: boolean
  proxyUrl: string | null
  requestRetry: number | null
  usageStatisticsEnabled: boolean | null
}

export function cliproxyConfigToOverview(
  config: CliproxyConfig | null,
  version: string | null,
  authFileCount: number,
): CliproxyOverviewState {
  const s = (v: unknown): string | null => typeof v === 'string' ? v : (v == null ? null : String(v))
  const b = (v: unknown): boolean => v === true
  const n = (v: unknown): number | null => typeof v === 'number' ? v : null
  return {
    version,
    authFileCount,
    routingStrategy: config ? s(config['routing-strategy']) : null,
    debug: config ? b(config.debug) : false,
    proxyUrl: config ? s(config['proxy-url']) : null,
    requestRetry: config ? n(config['request-retry']) : null,
    usageStatisticsEnabled: config ? (config['usage-statistics-enabled'] == null ? null : b(config['usage-statistics-enabled'])) : null,
  }
}

/** CPA events → 简化路由；alias 是请求别名，model 是 provider request 的模型记录。
 * 未提供响应声明、channel/group/逐请求 endpoint，不从 provider 名称猜补。 */
export interface CliproxyModelRoute {
  priceEvidence?: RoutePriceEvidence[]
  model: string
  requestedModel: string
  provider: string
  authIndex: string
  accountId: string | null
  accountName: string
  accountType: AccountType | null
  accountIdentitySource: 'management' | 'usage_only' | 'unattributed'
  requests: number
  failedRequests: number
  zeroTokenRequests: number
  failedZeroTokenRequests: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number
  totalTokens: number | null
  /** 成本(USD)。null = 该行**算不出来**(既无匹配单价、源也无估算)——
   *  计价函数返回的是哨兵 0(costBasis.ts noPriceNoEstimateCost),那个 0 不是实测成本。
   *  与 costUnknown 同时出现:costUnknown 为 true 时本字段恒为 null。 */
  costUsd: number | null
  referenceCostUsd: number | null
  knownReferenceCostUsd?: number
  knownCostUsd?: number
  /** 成本是否"算不出来"。同 modelRouteAnalysis.ModelRouteRow.costUnknown 语义。 */
  costUnknown: boolean
  firstSeen: string
  lastSeen: string
}

export function cliproxyEventsToModelRoutes(
  events: CliproxyUsageEvent[],
  prices: Record<string, LitellmPricing>,
  accounts: Account[],
  range: CostCenterRange,
  costMultiplier?: number,
  queryNow = new Date(),
): CliproxyModelRoute[] {
  // 倍率兜底:未手动设置成本价格时用官方价格 × 倍率(与 economics/todayStats 同口径)
  const multiplier = resolveCostMultiplier(costMultiplier)
  // 窗口过滤:模型区独立窗口(loadFromCliproxy 的 modelRange),语义与 cliproxyEventsToTrend
  // 完全一致 —— 半开区间 [start, end)。events 是 Rust 侧截断的近 30 天全量
  // (src-tauri/src/main.rs:683),不过滤就会把 30 天合计渲染在「最近 1 分钟」的表头下。
  const { start, end } = cliproxyUsageWindowBounds(range, queryNow)
  const startMs = start.getTime()
  const endMs = end.getTime()
  const inWindow = events.filter((ev) => ev.requested_at >= startMs && ev.requested_at < endMs)
  // 按 model+authIndex 聚合(accountName 用 events 的 alias/authIndex,accounts 无原始 auth_index)
  const map = new Map<string, CliproxyModelRoute & { _cost: number; _unpriced: boolean; _first: number; _last: number }>()
  for (const ev of inWindow) {
    const model = ev.model || 'unknown'
    const requestedModel = ev.alias || model
    const authIndex = ev.auth_index?.trim() ? ev.auth_index : ''
    const key = JSON.stringify([model, requestedModel, authIndex, ev.provider])
    const accountId = authIndex ? authIndexToAccountId(authIndex) : null
    const account = accounts.find((a) => a.id === accountId)
    const accountName = account?.name || (authIndex ? authIndex : costDataText('unattributedAccountUsage'))
    // 用带 basis 的计价函数:无匹配单价时 pricedEventCostUsd 返的是**哨兵 0**(basis 标"算不出"),
    // 而 eventCostUsd 只给 number,丢掉标注后 0 会被当实测成本写进路由明细的成本列。
    const priced = pricedEventCostUsd(ev, resolveModelPricing(model, prices))
    const cost = priced.cost * multiplier
    const unpriced = isUnknownCostBasis(priced.basis.kind)
    let row = map.get(key)
    if (!row) {
      row = {
        model,
        requestedModel,
        provider: ev.provider,
        authIndex,
        accountId,
        accountName,
        accountType: account?.extra?.cliproxy_auth_type_known === false ? null : account?.type ?? null,
        accountIdentitySource: accountId == null ? 'unattributed' : account?.extra?.cliproxy_identity_source === 'management' ? 'management' : 'usage_only',
        requests: 0,
        failedRequests: 0,
        zeroTokenRequests: 0,
        failedZeroTokenRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        referenceCostUsd: 0,
        costUnknown: false,
        firstSeen: '',
        lastSeen: '',
        _cost: 0,
        _unpriced: false,
        _first: ev.requested_at,
        _last: ev.requested_at,
      }
      map.set(key, row)
    }
    row.requests += 1
    row.priceEvidence = mergeRoutePriceEvidence(row.priceEvidence, routeEvidenceFromQuote(ev.priceQuote))
    row.failedRequests += ev.failed ? 1 : 0
    row.zeroTokenRequests += ev.total_tokens === 0 ? 1 : 0
    row.failedZeroTokenRequests += ev.failed && ev.total_tokens === 0 ? 1 : 0
    const tokens = cliproxyTokenBreakdown(ev)
    row.inputTokens = row.inputTokens == null || tokens.inputTokens == null ? null : row.inputTokens + tokens.inputTokens
    row.outputTokens = row.outputTokens == null || tokens.outputTokens == null ? null : row.outputTokens + tokens.outputTokens
    row.cacheReadTokens += tokens.cacheReadTokens ?? 0
    row.totalTokens = row.inputTokens == null || row.outputTokens == null ? null : row.inputTokens + row.outputTokens
    row._cost += cost
    // 任一分量算不出来 ⇒ 整行标未知(取更差一侧);未知时不写哨兵 0,置 null。
    row._unpriced = row._unpriced || unpriced
    row.costUsd = row._unpriced ? null : row._cost
    row.referenceCostUsd = row._unpriced ? null : row._cost / multiplier
    row.knownCostUsd = row._unpriced ? row._cost : undefined
    row.knownReferenceCostUsd = row._unpriced ? row._cost / multiplier : undefined
    row.costUnknown = row._unpriced
    row._first = Math.min(row._first, ev.requested_at)
    row._last = Math.max(row._last, ev.requested_at)
  }
  return [...map.values()].map(({ _cost, _unpriced, _first, _last, ...rest }) => {
    void _cost
    void _unpriced
    return {
      ...rest,
      firstSeen: new Date(_first).toISOString(),
      lastSeen: new Date(_last).toISOString(),
    }
  })
}
