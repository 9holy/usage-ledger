import { costDataText } from './costDataText'
/**
 * cockpit 本地 JSON → useCostCenterData store 字段适配层
 *
 * cockpit(codex_local_access_stats.json)数据维度齐全(totals/accounts/models/daily/weekly/monthly),
 * 但结构与 sub2api admin API 返回的 ModelStat/TrendDataPoint/WindowStats 不同。本模块做纯转换,
 * 让 cockpit 模式复用 useCostCenterData 的全部 computed(modelCostRows/financialTrend/upstreamRows 等),
 * 从而复用 sub2api 同套深色控制台模板,零模板改动。
 *
 * 缺的维度(costLossStates/accountEconomics/opsOverview/modelRoutes)不填,store ref 留空,
 * computed 返 null,UI 走 unavailableValueLabel 显示"本地无此维度"——不造假。
 *
 * 不填 stats ref:DashboardStats 字段(total 系列 / today 系列)与 cockpit totals(requestCount 等)命名不兼容,
 * 且 store/模板无任何 computed 读取 stats(KPI 全由 accountLedgers/trend 派生),填了是死数据。
 */

import type {
  CockpitStats,
  CockpitStatsAccount,
  CockpitStatsWindow,
  CockpitModelUsage,
  CockpitModelPricing,
  CockpitLocalAccess,
  CockpitQuotaHistoryFile,
  CockpitQuotaPoint,
  CockpitCodexAccount,
  CockpitLedgerEntry,
  CockpitUsageStats,
  CockpitOpsSummary,
  CockpitOpsAccountAgg,
  CockpitOpsRouteAgg,
  CockpitRequestLogGroup,
  CockpitRequestLogSummary,
  CockpitTokenSplit,
  CockpitAccountGroup,
} from '@/api/cockpit'
import { COCKPIT_LEDGER_CAP } from '@/api/cockpit'
import type {
  AccountPlatform,
  AccountType,
  AccountUsageInfo,
} from '@/types'
import type { SourceAccount as Account, SourceModelStat as ModelStat, SourceAdminUsageLog as AdminUsageLog, CostAccountId } from './sourceTypes'
import { localCostAccountId } from './accountIdentity'
import type { QuotaSnapshot } from '@/api/cockpit/quota'
import { quotaTimestamp, type RecordedQuotaProgress } from './quotaWindowState'
import type { CostTrendDataPoint } from './usageWindow'
import type { Channel, ModelDefaultPricing, PricingCatalogStatus } from '@/api/admin/channels'
import type { OpsDashboardOverview, OpsErrorTrendPoint, OpsThroughputTrendPoint } from '@/api/admin/ops'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'

/** 账号健康时间序列的单点(与 AccountEconomicsSnapshot.series 元素同形)。 */
type AccountEconomicsSeriesPoint = AccountEconomicsSnapshot['series'][number]
import type { ModelRouteRow, RoutePriceEvidence } from './modelRouteAnalysis'
import type { ModelAuditSummary } from './modelCostAnalysis'
import type { CostCenterRange } from './useCostCenterData'
import type { AccountWindowUsage, CostAccount } from './model'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from './model'
import { resolveCostMultiplier } from './costMultiplier'
import {
  isUnknownCostBasis,
  noPriceNoEstimateCost,
  pricedCost,
  sourceEstimateCost,
  type CostBasis,
  type PricedCost,
} from './costBasis'
// 2026-09-26:`economicsWindowHours`(**名义**窗口时长)已从本文件移除 ——
// 凡"除以时长"的量,分母必须是分子**实际覆盖**的时长;拿不到就返回 null,不许拿名义时长凑。
import { buildModelRouteRows, mergeRoutePriceEvidence, routeEvidenceFromQuote } from './modelRouteAnalysis'
import { costTrendBucketHours, usageWindowBounds } from './usageWindow'
import { buildLocalEconomicsSnapshot } from './costEngine'
import { COCKPIT_PRICE_BOOK, cockpitPriceSetFor, cockpitServiceTierLabel, cockpitServiceTierMultiplier } from './cockpitPriceBook'
import type { CockpitModelPriceSet } from './cockpitPriceBook'

/** Keep the source and complete raw ID; no lossy hash or implicit legacy ownership. */
export function accountIdToCostId(accountId: string): string {
  return localCostAccountId('cockpit', accountId)
}

type LedgerStatsAccount = CockpitStatsAccount & { costIdentityKind: 'ledger-email' }

function isLedgerStatsAccount(account: CockpitStatsAccount): account is LedgerStatsAccount {
  return (account as Partial<LedgerStatsAccount>).costIdentityKind === 'ledger-email'
}

export function statsAccountCostId(account: CockpitStatsAccount): string {
  return isLedgerStatsAccount(account) && account.email
    ? `cockpit:ledger-email:${encodeURIComponent(account.email)}`
    : accountIdToCostId(account.accountId)
}

/** 从 accountId 前缀派生 sub2api AccountPlatform(cockpit 渠道 → sub2api 平台枚举)。 */
function cockpitPlatformOf(accountId: string): AccountPlatform {
  if (accountId.startsWith('codex_')) return 'openai'
  if (accountId.startsWith('gemini_')) return 'gemini'
  if (accountId.startsWith('claude_')) return 'anthropic'
  if (accountId.startsWith('grok_')) return 'grok'
  if (accountId.startsWith('antigravity_')) return 'antigravity'
  if (accountId.startsWith('deepseek_')) return 'deepseek'
  if (accountId.startsWith('moonshot_')) return 'moonshot'
  if (accountId.startsWith('minimax_')) return 'minimax'
  if (accountId.startsWith('dashscope_')) return 'dashscope'
  if (accountId.startsWith('volcengine_')) return 'volcengine'
  if (accountId.startsWith('sensenova_')) return 'sensenova'
  if (accountId.startsWith('zai_')) return 'zai'
  // cursor/kiro/windsurf 等 cockpit 支持但 sub2api 枚举无的平台,归 openai(codex 系上游多为 OpenAI 兼容)
  return 'openai'
}

/** cockpit accountId 是否为"模型提供商测试"残留账号(用户在 cockpit 配第三方上游时的连通性测试,
 *  email 形如 cmp_*@model-provider-test.local,通常仅 1 次请求 0 成本,不属真实号池)。 */
export function isCockpitProviderTestAccount(accountId: string): boolean {
  return accountId.startsWith('model_provider_test_')
}

/** cockpit 账号类型派生:任意平台 *_apikey_ 前缀或提供商测试账号 → apikey(按量),其余 → oauth(订阅)。 */
function cockpitAccountTypeOf(accountId: string): AccountType {
  if (isCockpitProviderTestAccount(accountId)) return 'apikey'
  return accountId.includes('_apikey_') ? 'apikey' : 'oauth'
}

/** 用量粒度三态(PRD P0-19 rev2)。
 *
 *  替代已废弃的 `cockpit_platform_no_usage` —— 那个字段名基于**被推翻的**结论
 *  "非 codex 渠道拿不到用量"。实测 20 个渠道**全部**都有用量，差别只在粒度：
 *  - `token_level`：只有 codex，能算"用了多少 token"（单请求用量库）；
 *  - `quota_level`：其余渠道，知道的是"配额消耗了百分之多少 / 余额还剩多少"；
 *  - `unavailable`：仅 API Key 类账号 —— cockpit 源码对它们**显式排除**订阅配额查询
 *    （grok `api_key` / claude `ApiKey`·`DesktopGateway` / windsurf `api_key`，PRD §3.5）。
 *
 *  第三态必须显示"用量不可得"，**不是 0%**（与 P0-17「不静默变 0」同源）。 */
export type UsageGranularity = 'token_level' | 'quota_level' | 'unavailable'

/** 由 cockpit 账号的 `plan_type` 与"是否有 token 级用量"判用量粒度。
 *  `hasTokenUsage` 优先：codex 账号即便 plan_type 是 `api_key`，单请求库里也有真实 token。 */
export function cockpitUsageGranularityOf(planType?: string, hasTokenUsage = false): UsageGranularity {
  if (hasTokenUsage) return 'token_level'
  // cockpit 对 API Key 类账号不下发订阅配额 → 只能如实标"不可得"
  if (planType && /^(api[_-]?key|desktop[_]?gateway)$/i.test(planType.trim())) return 'unavailable'
  return 'quota_level'
}

/** cockpit 账号来源标识(渠道列/名称显示用):
 *  apikey → 渠道名(model_providers 映射,缺省回退 apiKey 短 ID);
 *  提供商测试 → "模型提供商测试";
 *  oauth → "OpenAI Codex 官方(OAuth 池)"——账号来源即上游官方池。 */
export function cockpitSourceLabel(accountId: string, apiKeyInfo?: CockpitApiKeyInfo): string {
  if (isCockpitProviderTestAccount(accountId)) return costDataText('modelProviderTest')
  if (accountId.includes('_apikey_')) {
    return apiKeyInfo?.name || `Codex API Key · ${accountId.replace(/^codex_apikey_/, '').slice(0, 8)}`
  }
  return costDataText('officialOpenaiCodexOauthPool')
}

/** cockpit apikey 账号→渠道信息(Rust 侧 md5(apiKey) 建映射,含渠道名 + baseUrl)。 */
export interface CockpitApiKeyInfo {
  name: string
  baseUrl: string
}

/** 归一化 cockpit 账号元数据 → { created_at, extra }。
 *  cockpitAccountToAccount 与 cockpitAccountToCostAccount 共用，确保主路径(accountLedgers)与 economics 路径一致。
 *  created_at：meta?.created_at（秒级 <1e12 ×1000 → ISO）降级 stats.since（ms → ISO）降级 new Date()。
 *  extra：塞 meta.plan_type → model.ts inferPlan 能读到（缺口修复，让 resolveCostProfile 选对默认价）。
 *  历史账号标记：stats 账号不在 codex_accounts.json（当前池清单）= 已删除/已移出的孤儿账号
 *  （cockpit 删号只移出当前池+留墓碑，stats 用量累计保留），extra.cockpit_historical=true，
 *  UI 据此显示"已移出当前池"而非把缺失套餐误标为 ¥0 采购。 */
function normalizeCockpitMeta(
  meta: CockpitCodexAccount | undefined,
  fallbackSinceMs: number | undefined,
  accountId?: string,
): { created_at: string; extra: { plan_type?: string; cockpit_historical?: boolean; cockpit_provider_test?: boolean } | undefined } {
  const sinceMs = fallbackSinceMs ?? Date.now()
  let createdAtMs: number
  if (meta?.created_at != null) {
    // cockpit codex_accounts.created_at 是秒级（如 1785063624），<1e12 视为秒 ×1000
    createdAtMs = meta.created_at < 1e12 ? meta.created_at * 1000 : meta.created_at
  } else {
    createdAtMs = sinceMs
  }
  const extra: { plan_type?: string; cockpit_historical?: boolean; cockpit_provider_test?: boolean } = meta
    ? { plan_type: meta.plan_type }
    : {}
  // 无 meta = 不在 cockpit 当前账号池(stats 只残留历史累计),统一标 cockpit_historical。
  // 实测 222 个 stats 账号里 215 个无 meta:210 个普通孤儿 + 5 个 provider 连通性测试账号。
  // provider_test 保留自身标记供渠道命名(eventsToUsageLogs)使用,两个标记可共存。
  if (!meta) extra.cockpit_historical = true
  if (accountId && isCockpitProviderTestAccount(accountId)) {
    extra.cockpit_provider_test = true
  }
  return {
    created_at: new Date(createdAtMs).toISOString(),
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}

/** cockpit 单个账号 → sub2api Account(必填字段填充,可选留默认,让 accountLedgers computed 不崩)。
 *  apikey 账号 name 用渠道名映射(codex_model_providers.json 的 name,Rust 侧 md5(apiKey) 建映射);
 *  同时塞 credentials.base_url(渠道 baseUrl)→ classifyUpstreamProvider 归 relay(中转),不套"OpenAI 官方"。
 *  无映射时回退类型化短 ID。oauth 账号 email 是真实邮箱,直接用。
 *  meta（来自 codex_accounts.json）：修 created_at（P0 主路径，删 new Date(0) epoch bug）+ extra 塞 plan_type。 */
/** cockpit customRoutingRules 查找账号的路由规则(优先级/权重/备份/偏好)。 */
function findRoutingRule(rules: Array<{ accountId: string; priority: number; weight: number; isBackup?: boolean; isPreferred?: boolean }> | undefined, accountId: string) {
  if (!rules) return undefined
  return rules.find(r => r.accountId === accountId)
}

/** 用 cockpit 真实数据计算调度评分,分制 0-4(与 sub2api normalizeSchedulerScore 的
 *  resolveSchedulerBaseScoreMax 权重和分制一致,修复此前 0-100 分被 /4 归一后 clamp 全 100 的失真)。
 *  权重:成功率 1.6 + 请求量(对数刻度) 0.8 + 延迟 0.8 + 配额余量 0.4 = 满分 3.6。 */
function cockpitSchedulerScore(acc: CockpitStatsAccount): { base_score: number } {
  const usage = acc.usage
  const total = usage.requestCount
  if (total === 0) return { base_score: 2 } // 无请求的账号给 0-4 分制中位分
  // 成功率 40%:成功率高→满分 1.6
  const successRate = usage.successCount / total
  const scoreSuccess = successRate * 1.6
  // 请求量 20%:对数刻度(10→0.4, 1k→0.6, 10k+→0.8 满分),比"有请求即满分"更真实
  const scoreRequests = Math.min(0.8, (Math.log10(1 + total) / 4) * 0.8)
  // 延迟 20%:avg latency 1s→0.6, 3s→0.2, 4s+→0
  const avgLatency = usage.totalLatencyMs / total
  const scoreLatency = avgLatency > 0 ? Math.max(0, 0.8 - (avgLatency / 1000) * 0.2) : 0.4
  // 配额余量 20%:cockpit 无 per-account remaining,给 0.4 中位分
  const scoreQuota = 0.4
  return { base_score: Math.round((scoreSuccess + scoreRequests + scoreLatency + scoreQuota) * 100) / 100 }
}

/** cockpit 优先级映射:isPreferred→最高(2),isBackup→最低(0),规则存在但未表达偏好→正常(1)。
 *  customRoutingRules 的 priority 字段也可直接用(>0 偏好,<0 备份)。
 *
 *  ⚠️ **无规则时返回 `null`,不返回 1**(2026-09-20 修正):`codex_local_access.json` 里
 *  没有这个账号的路由规则,只说明「源没有表达优先级」,不代表「它的优先级是正常」。
 *  此前返回 1 ⇒ 模板渲染成「1 · 正常」—— 一个我们并不掌握的事实(红线:不得暗示
 *  系统掌握了它并不掌握的信息)。置 `null` 后模板显示 — 并说明原因。 */
function cockpitPriority(rule: { isPreferred?: boolean; isBackup?: boolean; priority?: number } | undefined): number | null {
  if (!rule) return null
  if (rule.isPreferred || (typeof rule.priority === 'number' && rule.priority > 0)) return 2 // 最高
  if (rule.isBackup || (typeof rule.priority === 'number' && rule.priority < 0)) return 0 // 最低
  return 1 // 规则存在且未表达偏好 = 正常
}

function cockpitAccountToAccount(
  acc: CockpitStatsAccount,
  index: number,
  apiKeyInfos: Map<string, CockpitApiKeyInfo>,
  meta?: CockpitCodexAccount,
  statsSinceMs?: number,
  routingRules?: Array<{ accountId: string; priority: number; weight: number; isBackup?: boolean; isPreferred?: boolean }>,
  quotaWindow?: { maxUtil: number; resetAtMs: number | null },
): Account {
  void index
  const id = statsAccountCostId(acc)
  const platform = isLedgerStatsAccount(acc) ? 'openai' : cockpitPlatformOf(acc.accountId)
  const type = isLedgerStatsAccount(acc) ? 'oauth' : cockpitAccountTypeOf(acc.accountId)
  const info = type === 'apikey' ? apiKeyInfos.get(acc.accountId) : undefined
  const name = isCockpitProviderTestAccount(acc.accountId)
    ? costDataText('providerTest', { p0: acc.accountId.replace(/^model_provider_test_/, '').slice(0, 8) })
    : type === 'apikey'
      ? cockpitSourceLabel(acc.accountId, info)
      : (acc.email || cockpitSourceLabel(acc.accountId, info))
  const { created_at: createdAtIso, extra: baseExtra } = normalizeCockpitMeta(meta, statsSinceMs, acc.accountId)
  // 用量粒度三态(P0-19):stats 账号来自单请求用量库 → 恒为 token_level。
  // 用展开而不是赋值,避免覆盖 normalizeCockpitMeta 塞的 plan_type / cockpit_historical。
  const extra = {
    ...(baseExtra ?? {}),
    usage_granularity: 'token_level' as UsageGranularity,
    scheduler_score_source: 'derived',
    scheduler_score_basis: 'cockpit_usage_success_requests_latency_with_neutral_quota',
  }
  // 从 customRoutingRules 查找该账号的路由规则(优先级/权重/备份/偏好)
  const rule = findRoutingRule(routingRules, acc.accountId)
  // 用真实数据计算调度评分(成功率+请求量+延迟+配额)
  const schedulerScore = cockpitSchedulerScore(acc)
  // 状态派生(真实三态):全失败→error;配额窗口利用率≥95% 且有重置时间→限流;
  // 其余→active。describeCurrentAccountState 读 rate_limit_reset_at 未来时间显示"429 限流·预计 X 重置"。
  const allFailed = acc.usage.failureCount > 0 && acc.usage.successCount === 0
  const quotaLimited = (quotaWindow?.maxUtil ?? 0) >= 95
  return {
    id,
    name,
    platform,
    type,
    // apikey 账号塞渠道 baseUrl → classifyUpstreamProvider 走 relay 分支(中转),显示"API 中转 · host"而非"OpenAI 官方"
    credentials: info?.baseUrl ? { base_url: info.baseUrl } : undefined,
    extra,
    proxy_id: null,
    concurrency: 0,
    // cockpit 优先级映射:isPreferred→最高(2),isBackup→最低(0),默认→正常(1)
    priority: cockpitPriority(rule),
    // 调度评分用 cockpit 真实数据计算(0-4 分制,与 sub2api normalizeSchedulerScore 同分制)
    scheduler_score: { base_score: schedulerScore.base_score, sticky_weighted_enabled: false } as Account['scheduler_score'],
    // 状态派生:全失败→error;配额耗尽→限流(reset 时间来自 quota_history 真实倒计时);
    // 失败但仍有成功→active(部分降级,不标 error 避免全红)
    status: allFailed ? 'error' : 'active',
    error_message: allFailed ? costDataText('failures0Successes', { p0: acc.usage.failureCount }) : null,
    rate_limited_at: quotaLimited ? new Date().toISOString() : null,
    rate_limit_reset_at: quotaLimited && quotaWindow?.resetAtMs ? new Date(quotaWindow.resetAtMs).toISOString() : null,
    last_used_at: acc.usage.updatedAt ? new Date(acc.usage.updatedAt).toISOString() : null,
    expires_at: null,
    auto_pause_on_expired: false,
    created_at: createdAtIso,
    updated_at: acc.usage.updatedAt ? new Date(acc.usage.updatedAt).toISOString() : createdAtIso,
    schedulable: true,
    overload_until: null,
    temp_unschedulable_until: null,
    temp_unschedulable_reason: null,
    session_window_start: null,
    session_window_end: null,
    session_window_status: null,
  } as Account
}

/** cockpit stats.accounts[] → Account[]。accountMeta（codex_accounts.json id→账号）透传修 created_at/plan_type。
 *  quotaByAccount:accountId → { maxUtil, resetAtMs }(来自 quota_history,利用率≥95% 的账号标限流+真实重置时间)。 */
export function cockpitStatsToAccounts(
  stats: CockpitStats,
  apiKeyInfos: Map<string, CockpitApiKeyInfo> = new Map(),
  accountMeta?: Map<string, CockpitCodexAccount>,
  routingRules?: Array<{ accountId: string; priority: number; weight: number; isBackup?: boolean; isPreferred?: boolean }>,
  quotaByAccount?: Map<string, { maxUtil: number; resetAtMs: number | null }>,
  groupNames?: Map<string, string> | null,
): Account[] {
  return stats.accounts.filter(acc => acc.accountId?.trim()).map((acc, i) => {
    const account = cockpitAccountToAccount(acc, i, apiKeyInfos, accountMeta?.get(acc.accountId), stats.since, routingRules, quotaByAccount?.get(acc.accountId))
    const group = groupNames?.get(acc.accountId) ?? groupNames?.get(String(account.id))
    if (group) account.extra = { ...account.extra, cockpit_group_names: [group] }
    return account
  })
}

/** cockpit stats 账号 → CostAccount（model.ts 经济成本算子消费的最小类型）。
 *  与 cockpitAccountToAccount 共用 normalizeCockpitMeta，保证主路径(accountLedgers)与 economics 路径 created_at/extra 一致。
 *  无 meta 的历史孤儿账号：created_at=stats.since、plan_type=undefined→inferPlan 返 unknown→default 价 0，
 *  extra.cockpit_historical=true 供 UI 区分"已移出当前池"（不误标为 ¥0 采购）。 */
export function cockpitAccountToCostAccount(
  acc: CockpitStatsAccount,
  meta?: CockpitCodexAccount,
  statsSinceMs?: number,
): CostAccount {
  const { created_at, extra } = normalizeCockpitMeta(meta, statsSinceMs, acc.accountId)
  return {
    created_at,
    extra,
    credentials: undefined,
    parent_plan_type: undefined,
    platform: isLedgerStatsAccount(acc) ? 'openai' : cockpitPlatformOf(acc.accountId),
    type: isLedgerStatsAccount(acc) ? 'oauth' : cockpitAccountTypeOf(acc.accountId),
  }
}

/** 成本口径标签:区分"本项目算的"与"数据源自带的黑盒估算",UI 必须能看出来。 */
export const COCKPIT_COST_BASIS_LOCAL = 'cockpit 本地配置价 × token（本项目成本算法）'
export const COCKPIT_COST_BASIS_BOOK = 'cockpit 内置价目表 × token（本项目成本算法）'
export const COCKPIT_COST_BASIS_ESTIMATE = 'cockpit 自带估算（该模型无可用单价）'
export const COCKPIT_COST_BASIS_BLENDED = '窗口混合单价 × token（本项目成本算法）'
/** 窗口里有模型**没有**可用单价 ⇒ 混合单价被无价模型摊薄,合计只是**下界**,不能标「已计价」。 */
export const COCKPIT_COST_BASIS_BLENDED_PARTIAL = '窗口混合单价 × token（部分模型无单价，数值为下界）'
/** ★ P0-17:无单价**且**数据源也没给估算 —— 不是 $0,是"算不出"。UI 必须显示"成本未知"。 */
export const COCKPIT_COST_BASIS_UNKNOWN = '无单价且数据源无估算（成本未知,非 $0）'
/** ★ P0-17:连用量都没有,更谈不上成本。 */
export const COCKPIT_COST_BASIS_NO_USAGE = '无用量数据（成本未知,非 $0）'

/**
 * 带来源标记的成本值。
 *
 * `basis` 是给 UI 看的口径文案(既有字段,保持不变);
 * `costBasis` 是**标注型空值**(costBasis.ts),供代码/UI 判断"这个 0 到底是真的还是算不出来"。
 */
export interface CockpitUsageCost extends Omit<PricedCost, 'basis' | 'label'> {
  knownCostUsd?: number
  /** 口径文案(等价于 PricedCost.label),保留以兼容既有 UI/调用方 */
  basis: string
  /** 计价依据标注(标注型空值) */
  costBasis: CostBasis
  /** UI 角标文案(= basis) */
  label?: string
}

/** PricedCost(costBasis.ts) → CockpitUsageCost(保留既有 `basis` 文案字段)。 */
function toCockpitCost(priced: PricedCost, label: string): CockpitUsageCost {
  return { cost: priced.cost, basis: label, costBasis: priced.basis, label }
}

/** 构造"算不出来"的标注型空值(cost 恒 0,但 costBasis 标明 no_price_no_estimate)。 */
function unknownCost(label: string): CockpitUsageCost {
  return toCockpitCost(noPriceNoEstimateCost(label), label)
}

/**
 * 无本地单价时的回退:数据源给了非零估算 → 用它并标 `source_estimate`;
 * 数据源也没给(或给的是 0)→ 标 `no_price_no_estimate`,**不静默变 0**(P0-17)。
 */
function estimateCostOrUnknown(rawEstimate: unknown, mult: number): CockpitUsageCost {
  const estimate = Number(rawEstimate)
  if (!Number.isFinite(estimate) || estimate <= 0) {
    return unknownCost(costDataText('noUnitPriceOrSourceEstimateUnknownCostNot'))
  }
  return toCockpitCost(sourceEstimateCost(estimate * mult), costDataText('cockpitSourceEstimateNoUsableUnitPriceForThis'))
}

/**
 * ★ cockpit 数据源自带的 `estimatedCostUsd` 是**哨兵 0** —— 同一个 0 承担两种含义:
 *   ① 真的没用过;② 有用量,但 cockpit 没给该模型配单价。
 *
 * 源码证据(cockpit-tools 仓库):
 *  · `src-tauri/src/modules/codex_local_access_routing_pricing.rs:1824`
 *    `let Some(pricing) = resolve_base_model_pricing(None, model) else { return 0.0; };`
 *    —— 模型没匹配到单价 → 直接返回 0.0
 *  · 同文件 `:1845` `if cost.is_finite() && cost > 0.0 { cost } else { 0.0 }`
 *  · 其 TS 层 `src/utils/codexWindowStats.ts:104` `estimatedCostUsd: totals?.estimatedCostUsd ?? 0`
 *    —— 连字段缺失也补 0
 *
 * 本机实测样本(读 `%USERPROFILE%\.antigravity_cockpit\codex_local_access_stats.json`):
 *  · `monthly.models` 的 `gpt-image-2`:`totalTokens: 6704`(3 次成功请求:2 次生图 + 1 次改图)、
 *    `estimatedCostUsd: 0.0` —— **有用量、无单价**的哨兵 0 真实样本,不是推演。
 *  · 同文件 `accounts[]` 里 35 个 0 成本账号则**全部** `totalTokens === 0`(真的没用过)。
 *    ⇒ 两个方向在同一份数据里都出现过,"这个 0 可不可信"只能靠 token 区分。
 *
 * 判据(与上面 `estimateCostOrUnknown` 的 `estimate <= 0 → unknown` 同一条):
 *  · `totalTokens > 0` 却 `estimatedCostUsd <= 0` ⇒ **未知** → null
 *  · `totalTokens === 0` ⇒ 真没用过 ⇒ 0 是真值,原样返回
 *
 * ⚠️ 本函数是**唯一入口**:`useUnifiedCost.cockpitCost`(三端汇总卡片)与 `CockpitDataView`
 *   (Cockpit 数据页)都必须调它。各写一份判定 = 双入口,其中一处必成没人测得到的死代码。
 */
export function cockpitSourceCostOrNull(
  usage: { estimatedCostUsd?: unknown; totalTokens?: unknown } | null | undefined,
): number | null {
  if (!usage) return null
  const raw = usage.estimatedCostUsd
  // ⚠️ 必须先判 null/undefined:`Number(null) === 0` 会把「字段缺失」混进「真的 0」。
  //    这条 vue-tsc 看不见(编译器盲区),只能靠测试钉住。
  if (raw == null) return null
  const cost = Number(raw)
  if (!Number.isFinite(cost)) return null
  if (isCockpitSentinelZero(usage)) return null
  return cost
}

/** 哨兵 0 判据(**唯一一份**):有用量却报 0 ⇒ 源侧没匹配到单价。
 *  单独导出是为了让状态文案能说清"为什么拿不到值",而不必在别处把判定重写一遍。 */
export function isCockpitSentinelZero(
  usage: { estimatedCostUsd?: unknown; totalTokens?: unknown } | null | undefined,
): boolean {
  if (!usage) return false
  const raw = usage.estimatedCostUsd
  if (raw == null) return false
  const cost = Number(raw)
  return Number.isFinite(cost) && cost <= 0 && Number(usage.totalTokens) > 0
}

/** 该定价条目是否**可用**(至少一档单价 > 0)。
 *  混合单价与逐模型计价必须用同一条判据,否则两条路径对「有没有单价」的认定会分叉。 */
function hasUsablePrice(pricing: CockpitPricedModel | undefined): boolean {
  return !!pricing
    && (Number(pricing.input_price) > 0 || Number(pricing.output_price) > 0 || Number(pricing.cache_read_price) > 0)
}

/** 本项目定价目录 × token 用量 → 成本(USD)。
 *
 * 2026-09-08 修正:成本计算是**本项目**的能力(model.ts 1.6.0 算子 / costEngine / 本地定价目录),
 * 三端数据源自身都不会算成本(sub2api 有快照、cliproxy 有价目、cockpit 只有黑盒 estimatedCostUsd)。
 * 此前 cockpit 路径直接吃数据源自带的 `estimatedCostUsd`,与 cliproxy 路径
 * `eventCostUsd(ev, resolveModelPricing(...))` 自算口径不一致——等于把成本计算又交回了数据源。
 * 现在与 cliproxy 同口径:有本地单价 → 按 input/output/cache_read 逐项计价;
 * 没有本地单价 → 才回退数据源估算,并返回口径标签由 UI 如实标注(不冒充"我们算的")。
 *
 * 注意:隐含价(由 estimatedCostUsd 反推的混合价)**不能**代回本公式——
 * 它 input/output/cache_read 三处都是同一混合价,代回会把成本算成 2~3 倍。
 * 因此调用方只传**本地**定价目录(cockpitPricingsToModelPricing 的结果)。
 */
export function cockpitUsageCostUsd(
  usage: CockpitUsageStats | undefined,
  pricing: CockpitPricedModel | undefined,
  multiplier?: number,
): CockpitUsageCost {
  const mult = resolveCostMultiplier(multiplier)
  if (!usage) return unknownCost(costDataText('noUsageDataUnknownCostNot0'))
  const output = Number(usage.outputTokens) || 0
  // 与 cockpit `calculate_usage_cost_usd_from_tokens` 同口径:
  //   cached_tokens = min(cached, input);normal_input = input - cached
  // 即**缓存命中是 input 的子集**(不是 input 之外另加一份)。
  // 早期实现按"input + cached 并列"计价,把缓存部分又按输入价算了一遍,成本虚高数倍。
  const cached = Math.min(Number(usage.cachedTokens) || 0, Number(usage.inputTokens) || 0)
  const normalInput = Math.max(0, (Number(usage.inputTokens) || 0) - cached)
  if (!hasUsablePrice(pricing)) {
    return estimateCostOrUnknown(usage.estimatedCostUsd, mult)
  }
  const cost = (
    normalInput * (Number(pricing!.input_price) || 0)
    + output * (Number(pricing!.output_price) || 0)
    + cached * (Number(pricing!.cache_read_price) || 0)
  ) * mult
  // origin 由装配方写入:'local'=cockpit 里手动配的价,'book'=cockpit 内置价目表
  const label = pricing!.origin === 'local' ? costDataText('cockpitLocalConfiguredPricesTokensLocalCostAlgorithm') : costDataText('cockpitBuiltInPricesTokensLocalCostAlgorithm')
  return toCockpitCost(pricedCost(cost), label)
}

/** 带来源标记的定价条目(origin 决定成本口径标签:手动配置 / 内置价目表)。 */
export type CockpitPricedModel = ModelDefaultPricing & { origin?: 'local' | 'book' }

/** 窗口混合单价(见 cockpitBlendedTokenPrice)。`unpricedModels > 0` ⇒ 该混合价只是**下界**。 */
export interface CockpitBlendedPrice {
  inputRate: number
  cacheRate: number
  outputRate: number
  cost: number
  /** 本窗口**有**可用单价的模型数 */
  pricedModels: number
  /** 本窗口**没有**可用单价的模型数(>0 时混合单价被摊薄,合计只是下界) */
  unpricedModels: number
}

/** 窗口模型聚合 → 混合单价(USD/token),供 totals/账号级聚合计价。
 *  这些聚合没有模型维度,不能逐模型计价:这里先用**本窗口自算**的总成本 ÷ 计费 token 得混合单价,
 *  再按各自 token 量还原,保证"各账号之和 = 窗口自算总成本"(不凭空放大/缩水)。
 *  缓存命中单独还原单价(自算时已按 cache_read_price 计价,不与普通输入输出混算)。
 *  返 null = 该窗口无可用模型聚合(调用方回退数据源估算)。 */
export function cockpitBlendedTokenPrice(
  models: CockpitModelUsage[] | undefined,
  pricing: Record<string, CockpitPricedModel> | undefined,
  multiplier?: number,
): CockpitBlendedPrice | null {
  if (!models?.length) return null
  const mult = resolveCostMultiplier(multiplier)
  let cost = 0
  let normalInput = 0
  let cached = 0
  let outputTokens = 0
  let inputCost = 0
  let cacheCost = 0
  let outputCost = 0
  let pricedModels = 0
  let unpricedModels = 0
  for (const m of models) {
    const u = m.usage
    if (!u) continue
    const clamped = Math.min(Number(u.cachedTokens) || 0, Number(u.inputTokens) || 0)
    const normal = Math.max(0, (Number(u.inputTokens) || 0) - clamped)
    const out = Number(u.outputTokens) || 0
    const p = pricing?.[m.modelId]
    if (hasUsablePrice(p)) pricedModels += 1
    else unpricedModels += 1
    const inPrice = Number(p?.input_price) || 0
    const outPrice = Number(p?.output_price) || 0
    const cachePrice = Number(p?.cache_read_price) || 0
    inputCost += normal * inPrice * mult
    cacheCost += clamped * cachePrice * mult
    outputCost += out * outPrice * mult
    cost += cockpitUsageCostUsd(u, p, multiplier).cost
    normalInput += normal
    cached += clamped
    outputTokens += out
  }
  if (normalInput + cached + outputTokens <= 0) return null
  // 窗口里**一个模型都没有可用单价** ⇒ 三档速率必然全是 0。这个「混合单价」是空壳,
  // 若照旧返回,调用方会拿 0 速率乘 token 并标「窗口混合单价 × token（本项目成本算法）」,
  // 把「算不出」渲染成一个确定的 $0 —— 正是哨兵 0 要消灭的形态。
  // 返 null 让调用方回退 `cockpitUsageCostUsd(usage, undefined)`:
  // 有数据源估算 ⇒ source_estimate;连估算也没有 ⇒ no_price_no_estimate(成本未知)。
  if (pricedModels === 0) return null
  return {
    inputRate: normalInput > 0 ? inputCost / normalInput : 0,
    cacheRate: cached > 0 ? cacheCost / cached : 0,
    outputRate: outputTokens > 0 ? outputCost / outputTokens : 0,
    cost,
    pricedModels,
    unpricedModels,
  }
}

/** 无模型维度的聚合用量(totals/单账号)→ 成本:混合单价 × 自身 token 量。
 *  无混合单价(窗口无模型聚合)时回退数据源估算并标注口径。 */
export function cockpitAggregateCostUsd(
  usage: CockpitUsageStats | undefined,
  blended: CockpitBlendedPrice | null,
  multiplier?: number,
): CockpitUsageCost {
  if (!usage) return unknownCost(costDataText('noUsageDataUnknownCostNot0'))
  if (!blended) return cockpitUsageCostUsd(usage, undefined, multiplier)
  // 同样按"缓存命中是 input 的子集"还原,与逐模型口径完全一致
  const cached = Math.min(Number(usage.cachedTokens) || 0, Number(usage.inputTokens) || 0)
  const normalInput = Math.max(0, (Number(usage.inputTokens) || 0) - cached)
  const output = Number(usage.outputTokens) || 0
  const amount = normalInput * blended.inputRate + cached * blended.cacheRate + output * blended.outputRate
  // 混合单价把窗口揉成一个数,但「窗口里有几个模型没有单价」是可知的:无价模型的 token 照样进了
  // 分母、其单价按 0 计 ⇒ amount 只是**下界**。标成「已计价」等于宣称那部分不花钱。
  if (blended.unpricedModels > 0) {
    return toCockpitCost(
      sourceEstimateCost(amount, costDataText('windowBlendedPricesTokensSomeModelsAreUnpricedAmount')),
      costDataText('windowBlendedPricesTokensSomeModelsAreUnpricedAmount'),
    )
  }
  return toCockpitCost(pricedCost(amount), costDataText('windowBlendedPricesTokensLocalCostAlgorithm'))
}

/* -------------------------------------------------------------------------- */
/* 单请求用量库(codex_local_access_logs.sqlite)口径                           */
/* -------------------------------------------------------------------------- */

/**
 * 分档 token → 成本(USD)。
 *
 * 这是 cockpit 成本计算的**正确形态**:cockpit 的长上下文档位价按**单请求**
 * `input_tokens > 272_000` 判定(实测 179k 行:与 cockpit 落库单价档 100% 一致),
 * 所以 Rust 侧已把 token 拆成"标准档 / 长文本档"两堆,这里分别 × 对应单价再相加。
 *
 * 反例(已修):此前只有日/周/月聚合 token,只能拿"窗口平均 token"猜档——
 * 实测 gpt-6-astra 平均 295,769 token/请求 看着该走长文本档,但实际只有
 * 2,688/5,418 条请求超阈值,按平均猜会把成本算成 $4,196(真值 $3,970);
 * 而完全不判档是 $2,125(少算一半)。两头都不对,必须逐请求分档。
 *
 * 模型没开长文本文档位价时(`sessionLongContext=false`),长文本 token 仍按标准价计
 * ——与 cockpit `should_apply_session_long_context` 同规则。
 *
 * ## 服务档位(`service_tier`,2026-09-20 补)
 *
 * `service_tier` 与 `multiplier` 是**两回事**,各自独立相乘、互不覆盖:
 * - `multiplier` = **账号成本倍率**(用户在成本中心设的);
 * - 档位倍率 = cockpit 的 `service_tier` 规则:priority ×2 / flex ×0.5 / standard 不调。
 *
 * 档位取值优先级:显式入参 `serviceTier` > 本批数据自带的 `split.serviceTier`
 * (Rust 已把档位放进聚合键 ⇒ 同一批只有一个档位值)。两者都缺 → 按 ×1 计,
 * 且**不追加任何档位标注**(不能把"未记录"说成"standard")。
 *
 * 已知取舍:priority 与长文本文档位**同时命中**时的精确价目无本机数据可校验,
 * 这里统一按"整批成本 × 档位倍率"处理;`priceSet.priority`(用户手配的显式优先档价)
 * **未参与**计价,仍走 ×2 规则 —— 若将来要尊重显式优先档价,须先补 priority-long 档位语义。
 */
export function cockpitSplitCostUsd(
  split: CockpitTokenSplit | undefined | null,
  priceSet: CockpitModelPriceSet | undefined,
  multiplier?: number,
  serviceTier?: string | null,
): CockpitUsageCost {
  const mult = resolveCostMultiplier(multiplier)
  if (!split) return unknownCost(costDataText('noUsageDataUnknownCostNot0'))
  if (priceSet?.origin !== 'local' && split.priceQuotes?.length) {
    const known = split.priceQuotes.filter(quote => quote.usd != null && Number.isFinite(quote.usd))
    if (known.length === split.priceQuotes.length) {
      return toCockpitCost(pricedCost(known.reduce((sum, quote) => sum + quote.usd!, 0) * mult), costDataText('sharedModelsDevQuoteNamedProviderReferencePricesNot'))
    }
    // Preserve the source's recorded estimate; it is not replaced by one arbitrary scenario.
    if (split.estimatedCostUsd > 0) return estimateCostOrUnknown(split.estimatedCostUsd, mult)
    return {
      ...unknownCost(costDataText('catalogQuoteConditionsIncompleteScenariosRetainedNotTreatedAs', { p0: split.priceQuotes.reduce((n, quote) => n + (quote.scenarios?.length ?? 0), 0) })),
      knownCostUsd: known.reduce((sum, quote) => sum + quote.usd!, 0) * mult,
    }
  }
  // 档位倍率:与账号成本倍率 `mult` 独立。'' / 未知档位 → 1(「未记录」,不是 standard)。
  const tier = serviceTier ?? split.serviceTier
  const tierMult = cockpitServiceTierMultiplier(tier)
  if (!priceSet) {
    // 本项目没有该模型单价 → 诚实回退数据源估算并标注口径,不冒充"我们算的";
    // 数据源也没给估算 → 标"成本未知",不静默变 0(P0-17)
    // ⚠️ 数据源的估算已反映它当时的实际档位 ⇒ 此处**不**再乘档位倍率(乘了就是双重计价)。
    return estimateCostOrUnknown(split.estimatedCostUsd, mult)
  }
  const long = priceSet.sessionLongContext ? priceSet.long : undefined
  const { stdNormalInput, stdCached, stdOutput, longNormalInput, longCached, longOutput } = split
  const cost = (
    stdNormalInput * priceSet.standard.input
    + stdCached * priceSet.standard.cache
    + stdOutput * priceSet.standard.output
    + longNormalInput * (long?.input ?? priceSet.standard.input)
    + longCached * (long?.cache ?? priceSet.standard.cache)
    + longOutput * (long?.output ?? priceSet.standard.output)
  ) * mult * tierMult
  const base = priceSet.origin === 'local' ? costDataText('cockpitLocalConfiguredPricesTokensLocalCostAlgorithm') : costDataText('cockpitBuiltInPricesTokensLocalCostAlgorithm')
  // 仅在档位倍率 ≠1 时追加标注:standard / 未记录档位下口径文案保持原样(既有断言不受影响)。
  const label = tierMult === 1 ? base : `${base} × ${tierMult}（${cockpitServiceTierLabel(tier)}）`
  return toCockpitCost(pricedCost(cost), label)
}

/** 分档 token → 平铺 token 数(供 ModelStat / 趋势点的 token 列)。 */
export function cockpitSplitTokens(split: CockpitTokenSplit): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
} {
  const stdInput = split.stdNormalInput + split.stdCached
  const longInput = split.longNormalInput + split.longCached
  const inputTokens = stdInput + longInput
  const outputTokens = split.stdOutput + split.longOutput
  const cachedTokens = split.stdCached + split.longCached
  return { inputTokens, outputTokens, cachedTokens, totalTokens: inputTokens + outputTokens }
}

function mergeInto(target: CockpitTokenSplit, src: CockpitTokenSplit): void {
  target.requests += src.requests
  target.success += src.success
  target.error += src.error
  target.stdNormalInput += src.stdNormalInput
  target.stdCached += src.stdCached
  target.stdOutput += src.stdOutput
  target.longNormalInput += src.longNormalInput
  target.longCached += src.longCached
  target.longOutput += src.longOutput
  target.estimatedCostUsd += src.estimatedCostUsd
  // 失败分类计数同样可加(与分位数不同),跨模型/跨桶合并时直接累加
  target.rateLimited += src.rateLimited || 0
  target.upstreamError += src.upstreamError || 0
  target.clientCanceled += src.clientCanceled || 0
}

function emptySplit(): CockpitTokenSplit {
  return {
    requests: 0, success: 0, error: 0,
    stdNormalInput: 0, stdCached: 0, stdOutput: 0,
    longNormalInput: 0, longCached: 0, longOutput: 0,
    estimatedCostUsd: 0,
    rateLimited: 0, upstreamError: 0, clientCanceled: 0,
  }
}

/**
 * 按账号过滤 cockpit 单请求用量库聚合结果 —— 让模型成本区的「成本账号」选择器在 cockpit 源下**真正生效**。
 *
 * 背景(2026-09-13):该选择器此前在 cockpit 源下**空转** —— 用户选中某账号后,标题/摘要显示该账号名,
 * 但模型表数据仍是全账号合计,等于界面声称"已按此账号过滤"而实际没有
 * (违反红线:"界面不得暗示系统掌握了它并不掌握的信息")。
 *
 * cockpit 的成本聚合走 `summary.groups`(模型×账号),每项带**原始** `accountId` 字符串;
 * 前端 store 保留 source + 原始 accountId,故必须用同一身份转换后再比 ——
 * 直接比原始字符串会永远匹配不上,把"空转"变成"永远空表",那更糟。
 *
 * `cells`(桶×模型)与 `bucketLatencies`(桶)没有账号维度,保持原样:全局成本速率/运行趋势
 * 本就标注为「全局」,不受账号选择影响。
 *
 * @param summary 原始聚合结果(可为 null)
 * @param selectedAccountId 选中的来源账号 id(与 `Account.id` 同体系);null = 「全部账号」→ 原样返回
 * @returns 过滤后的 summary;`selectedAccountId` 为 null 时返回入参本身(不复制,保持零开销与引用相等)
 */
export function filterCockpitRequestLogByAccount(
  summary: CockpitRequestLogSummary | null,
  selectedAccountId: CostAccountId | null,
): CockpitRequestLogSummary | null {
  if (!summary || selectedAccountId == null) return summary
  const target = String(selectedAccountId)
  return {
    ...summary,
    groups: (summary.groups ?? []).filter(
      (group) => !!group.accountId?.trim() && accountIdToCostId(group.accountId) === target,
    ),
  }
}

/**
 * 单请求用量库聚合 → 逐模型 ModelStat。
 *
 * 与 `cockpitModelsToModelStats`(stats 快照口径)的区别:
 *   - 快照是**日历累计**(本周一/本月 1 日起),切 7d/30d 会出现"7d 比 30d 还大"的荒谬数据;
 *   - 本函数按真实时间窗扫描单请求,是**滚动窗口**,且能判长上下文档位价。
 * 库不可用时返空数组,调用方回退快照口径并在 UI 标注(不静默变 0)。
 *
 * 2026-09-20 补:计价按 **(模型 × 服务档位)** 分组后再按模型汇总 —— 同一模型可能同时有
 * standard 与 priority 流量,合并成一批后档位信息就没了,只能猜或一律 ×1(priority 少算 50%)。
 */
export function cockpitRequestLogToModelStats(
  summary: CockpitRequestLogSummary | null,
  priceSets: Record<string, CockpitModelPriceSet>,
  multiplier?: number,
): ModelStat[] {
  if (!summary?.available || !summary.groups?.length) return []
  const mult = resolveCostMultiplier(multiplier)
  // 先按 **(模型 × 服务档位)** 分组计价,再按模型汇总 —— 档位必须参与分组:
  // 同一模型可能同时有 standard 与 priority 流量,合成一批后档位信息就没了,
  // 只能按单一档位猜(编造)或一律 ×1(priority 少算 50%)。
  // 逐 (模型×档位) 计价后按模型累加;token 与时间范围同样累加(可加量)。
  const byModel = new Map<string, { cost: number; costUnknown: boolean; split: CockpitTokenSplit; first: number | null; last: number | null }>()
  for (const split of summary.groups) {
    const model = split.model || costDataText('unknownModel'), tier = split.serviceTier ?? '', first = split.firstMs, last = split.lastMs
    const { cost, costBasis } = cockpitSplitCostUsd(split, cockpitPriceSetFor(priceSets, model), multiplier, tier)
    let agg = byModel.get(model)
    if (!agg) {
      agg = { cost: 0, costUnknown: false, split: emptySplit(), first: null, last: null }
      byModel.set(model, agg)
    }
    agg.cost += cost
    // 任一分量算不出来 ⇒ 整模型标未知(与 costBasis.addPricedCost 的「取更差一侧」同规则)。
    agg.costUnknown = agg.costUnknown || isUnknownCostBasis(costBasis.kind)
    mergeInto(agg.split, split)
    if (first != null) agg.first = agg.first == null ? first : Math.min(agg.first, first)
    if (last != null) agg.last = agg.last == null ? last : Math.max(agg.last, last)
  }
  const result: ModelStat[] = []
  for (const [model, { cost, costUnknown, split, first, last }] of byModel) {
    const t = cockpitSplitTokens(split)
    result.push({
      model,
      requests: split.requests,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      // 源侧无 cache-creation 维度(见本文件 cockpitRequestLogToOpsTrend 上方注释:
      // CockpitTokenSplit 只有 std/long × Normal/Cached/Output,request_logs 建表也没有该列)
      // ⇒ 不可得,留 null(0 会被读成"实测零缓存写入")。
      cache_creation_tokens: null,
      cache_read_tokens: t.cachedTokens,
      cache_hit_ratio: t.inputTokens > 0 ? t.cachedTokens / t.inputTokens : null,
      total_tokens: t.totalTokens,
      // 算不出来时不写哨兵 0(costBasis.ts noPriceNoEstimateCost):置 null,由 buildModelCostRows
      // 标 costUnknown 让显示层渲染「成本未知」,不冒充"实测成本为零"。
      cost: costUnknown ? null : cost / mult,
      account_cost: costUnknown ? null : cost,
      // cockpit 是本地用量采集源,没有售价/营收层:不把营收硬编码等于成本(那会让毛利恒为 0)。
      actual_cost: null,
      first_seen: first != null ? new Date(first).toISOString() : undefined,
      last_seen: last != null ? new Date(last).toISOString() : undefined,
    })
  }
  // null 安全:未知成本的行**不得当 0 参与比较** —— 否则它会与"真实 0 成本"的行同序,
  // 在排序稳定时反而排在前面,看起来像"最贵/最便宜"的确定结论。未知一律排最后。
  result.sort((a, b) => {
    if (a.cost == null && b.cost == null) return 0
    if (a.cost == null) return 1
    if (b.cost == null) return -1
    return b.cost - a.cost
  })
  return result
}

/** 单请求用量库聚合 → 逐账号 WindowStats(key 用完整来源账号 id,与 store 一致)。
 *  真实滚动窗口 + 长文本分档计价,取代 `cockpitWindowToAccountStats` 的日历快照口径。 */
export function cockpitRequestLogToAccountStats(
  summary: CockpitRequestLogSummary | null,
  priceSets: Record<string, CockpitModelPriceSet>,
  multiplier?: number,
): Record<string, AccountWindowUsage> {
  if (!summary?.available || !summary.groups?.length) return {}
  // 同一账号跨多模型:逐 (模型×账号) 分别计价后累加(不能先合并 token 再算,
  // 不同模型单价不同,合并会串味)
  const mult = resolveCostMultiplier(multiplier)
  const byAccount = new Map<string, { cost: number; unknownRequests: number; requests: number; tokens: number }>()
  for (const g of summary.groups) {
    const id = g.accountId?.trim() ? accountIdToCostId(g.accountId) : UNATTRIBUTED_USAGE_ACCOUNT_ID
    const priced = cockpitSplitCostUsd(g, cockpitPriceSetFor(priceSets, g.model), multiplier, g.serviceTier)
    const { costBasis } = priced
    const cost = priced.knownCostUsd ?? priced.cost
    const t = cockpitSplitTokens(g)
    const costUnknown = isUnknownCostBasis(costBasis.kind)
    const cur = byAccount.get(id)
    if (cur) {
      cur.cost += cost
      if (costUnknown) cur.unknownRequests += g.requests
      cur.requests += g.requests
      cur.tokens += t.totalTokens
    } else {
      byAccount.set(id, { cost, unknownRequests: costUnknown ? g.requests : 0, requests: g.requests, tokens: t.totalTokens })
    }
  }
  const result: Record<string, AccountWindowUsage> = {}
  for (const [id, v] of byAccount) {
    // 本地没有用户账面营收；参考价值不含本项目额外成本倍率。
    result[id] = {
      requests: v.requests,
      tokens: v.tokens,
      cost: v.unknownRequests ? null : v.cost,
      standard_cost: v.unknownRequests ? null : v.cost / mult,
      user_cost: null,
      ...(v.unknownRequests ? { known_cost: v.cost, known_standard_cost: v.cost / mult, unknown_cost_requests: v.unknownRequests } : {}),
    }
  }
  return result
}

/**
 * 单请求用量库聚合 → 逐 API Key 累计用量(key 用 apiKeyId 原文,与 stats.apiKeys[].apiKeyId 同体系)。
 *
 * 供"本地网关密钥"表的成本列:此前直接吃 `stats.apiKeys[].usage.estimatedCostUsd`
 * (数据源黑盒估算),现在与模型/账号表同口径——本项目价目 × 分档 token。
 * 库不可用时返空对象,调用方回退 stats 口径。
 */
export function cockpitRequestLogToApiKeyStats(
  summary: CockpitRequestLogSummary | null,
  priceSets: Record<string, CockpitModelPriceSet>,
  multiplier?: number,
): Record<string, { requests: number; tokens: number; cost: number | null }> {
  const byKey = new Map<string, { cost: number; costUnknown: boolean; requests: number; tokens: number }>()
  if (!summary?.available || !summary.groups?.length) return {}
  for (const g of summary.groups) {
    if (!g.apiKeyId) continue
    // 逐 (模型) 计价:同一 Key 下多个模型不能合并 token 再算
    const { cost, costBasis } = cockpitSplitCostUsd(g, cockpitPriceSetFor(priceSets, g.model), multiplier, g.serviceTier)
    const t = cockpitSplitTokens(g)
    const costUnknown = isUnknownCostBasis(costBasis.kind)
    const cur = byKey.get(g.apiKeyId)
    if (cur) {
      cur.cost += cost
      cur.costUnknown = cur.costUnknown || costUnknown
      cur.requests += g.requests
      cur.tokens += t.totalTokens
    } else {
      byKey.set(g.apiKeyId, { cost, costUnknown, requests: g.requests, tokens: t.totalTokens })
    }
  }
  const result: Record<string, { requests: number; tokens: number; cost: number | null }> = {}
  for (const [id, v] of byKey) {
    // 算不出来 ⇒ cost 置 null(不是哨兵 0),由消费点走「成本未知」分支。
    result[id] = { requests: v.requests, tokens: v.tokens, cost: v.costUnknown ? null : v.cost }
  }
  return result
}

/**
 * 单请求用量库聚合 → 成本趋势(按时间桶)。
 * 每桶逐模型计价后相加(不同模型单价不同,不能合并 token 再算)。
 */
export function cockpitRequestLogToCostTrend(
  summary: CockpitRequestLogSummary | null,
  priceSets: Record<string, CockpitModelPriceSet>,
  multiplier?: number,
): CostTrendDataPoint[] {
  if (!summary?.available || !summary.cells?.length) return []
  // cells 是 (桶 × 模型):同桶多模型必须各自计价再相加(不同模型单价不同,合并 token 会串味)
  const byBucket = new Map<number, { cost: number; unpriced: number; estimated: number; priced: number; split: CockpitTokenSplit }>()
  for (const c of summary.cells) {
    let cur = byBucket.get(c.startMs)
    if (!cur) {
      cur = { cost: 0, unpriced: 0, estimated: 0, priced: 0, split: emptySplit() }
      byBucket.set(c.startMs, cur)
    }
    const cellCost = cockpitSplitCostUsd(c, cockpitPriceSetFor(priceSets, c.model), multiplier, c.serviceTier)
    cur.cost += cellCost.cost
    // 桶级计价依据:逐格统计三种 basis,决定这一桶是"断点"还是"下界"。
    if (isUnknownCostBasis(cellCost.costBasis.kind)) cur.unpriced += 1
    else if (cellCost.costBasis.kind === 'source_estimate') cur.estimated += 1
    else cur.priced += 1
    mergeInto(cur.split, c)
  }
  const points: CostTrendDataPoint[] = []
  for (const [startMs, { cost, unpriced, estimated, priced, split }] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    const t = cockpitSplitTokens(split)
    // 全桶算不出来(桶内每一格都无单价且源无估算)⇒ 成本字段一律 null(图表断点),不得补 0;
    // 部分算不出来 ⇒ 保留求和值(它是**真实下界**,丢掉是误伤)并标 source_estimate。
    const allUnknown = unpriced > 0 && priced === 0 && estimated === 0
    const bucketCostBasis = allUnknown
      ? 'no_price_no_estimate' as const
      : unpriced > 0 || estimated > 0 ? 'source_estimate' as const : undefined
    points.push({
      date: new Date(startMs).toISOString(),
      requests: split.requests,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      // request_logs 无 cache-creation 维度 ⇒ null(断点),不是"实测零缓存写入"。
      cache_creation_tokens: null,
      cache_read_tokens: t.cachedTokens,
      total_tokens: t.totalTokens,
      cost: allUnknown ? null : cost,
      // cockpit 是本地用量采集源,没有营收/售价/毛利概念:此处置 actual_cost = 自算成本(cost) 是刻意保留。
      // 下游 6 个显示点复用本字段(窗口合计 windowActualOutputUsd 与 financialTrend.billedUsd),
      // 直接断开会让这些格从数字变成"无数据",属于误伤。营收语义由显示层按 connectionType 分支纠正
      // (CostCenterView.vue 显示为"自算成本"),数据层此处不再冒充"用户计费"。
      actual_cost: allUnknown ? null : cost,
      account_cost: allUnknown ? null : cost,
      costBasis: bucketCostBasis,
    })
  }
  return points
}

/**
 * 单请求用量库 cells → Ops 运行趋势点(请求/成功/失败/token/qps/tps)。
 *
 * 为什么必须有它(2026-09-09):"真实请求量趋势"此前只能用 codex-api.log 聚合,
 * 而 cockpit 只保留 ~4 天日志(本机仅 9/6~9/9 四个文件)——切 7 天窗口,
 * 9/3~9/5 的 10,216 个请求直接从图上消失(实测 SQLite:889/2,938/6,389)。
 * SQLite `request_logs` 保留全量(本机 07-29 起 18 万行),cells 就是"桶 × 模型"的
 * 请求计数,聚成桶序列即得完整窗口趋势。
 *
 * 2026-09-10 补上 `duration_p95_ms`:来自 `bucketLatencies`(`request_logs.latency_ms`
 * 的桶级分位数,本机 99.98% 行有值、07-29 起全量)。此前延迟曲线只吃 codex-api.log
 * (cockpit 只保留 ~5 天),于是 7d/30d 窗口大半桶是空的——不是没数据,是没去读。
 *
 * 仍不填的字段(诚实):ttft 分位数(库里没有首 token 时间,只有日志有)、
 * cache_creation_tokens(库里没有该维度)、user/account/contribution 成本列 ——
 * cockpit 自算成本承载在 cockpitRequestLogToCostTrend 与窗口快照,不在 ops 维度。
 * 成本列必须留 **null** 而非 0:`selectFinancialTrend` 用 `finite(x) != null` 判"该源是否有成本",
 * 而 `finite(0) === 0 !== null` ⇒ 留 0 会被当成"有值",usage 为空时顶替成一条贴底零成本线。
 */
export function cockpitRequestLogToOpsTrend(
  summary: CockpitRequestLogSummary | null,
): OpsThroughputTrendPoint[] {
  if (!summary?.available || !summary.cells?.length) return []
  const bucketHours = summary.bucketHours > 0 ? summary.bucketHours : 1
  const bucketSeconds = bucketHours * 3600
  // 桶边界与 cells 完全一致(Rust 侧同为 div_euclid 对齐 epoch),可直接按 startMs 取。
  const latencyByBucket = new Map((summary.bucketLatencies ?? []).map((b) => [b.startMs, b]))
  const byBucket = new Map<number, {
    requests: number
    success: number
    error: number
    rateLimited: number
    upstreamError: number
    clientCanceled: number
    split: CockpitTokenSplit
  }>()
  for (const c of summary.cells) {
    let cur = byBucket.get(c.startMs)
    if (!cur) {
      cur = { requests: 0, success: 0, error: 0, rateLimited: 0, upstreamError: 0, clientCanceled: 0, split: emptySplit() }
      byBucket.set(c.startMs, cur)
    }
    cur.requests += c.requests
    cur.success += c.success
    cur.error += c.error
    // 计数可加(与分位数不同),跨模型直接累加即可得到"整个桶"的分类数
    cur.rateLimited += c.rateLimited || 0
    cur.upstreamError += c.upstreamError || 0
    cur.clientCanceled += c.clientCanceled || 0
    mergeInto(cur.split, c)
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, v]) => {
      const t = cockpitSplitTokens(v.split)
      const latency = latencyByBucket.get(startMs)
      return {
        bucket_start: new Date(startMs).toISOString(),
        request_count: v.requests,
        success_count: v.success,
        error_count: v.error,
        token_consumed: t.totalTokens,
        input_tokens: t.inputTokens,
        output_tokens: t.outputTokens,
        // cockpit 单请求用量库没有 cache-creation 维度:CockpitTokenSplit 只有
        // std/long × Normal/Cached/Output,request_logs 建表也没有该列 ⇒ 不可得。
        // 0 会被 AdaptiveOperationsCharts.vue:270 画成一条贴底实线,读成"实测零缓存写入";
        // null 才是断点。
        cache_creation_tokens: null,
        cache_read_tokens: t.cachedTokens,
        switch_count: null,
        // 成本不在这条链路上:cockpit 自算成本承载在 cockpitRequestLogToCostTrend
        // (CostTrendDataPoint.account_cost)与窗口快照里。此处留 0 会命中
        // financialTrend.ts:37 的 `finite(x) != null` 判存在(0 也算"有值"),
        // 于是 usage 为空时 ops 的假 0 会顶替成一条贴底零成本线。留 null 才真退出选择。
        user_billed_usd: null,
        account_cost_usd: null,
        contribution_usd: null,
        duration_p95_ms: latency?.p95Ms ?? null,
        ttft_p50_ms: null,
        ttft_p95_ms: null,
        qps: v.requests / bucketSeconds,
        tps: t.totalTokens / bucketSeconds,
      }
    })
}

/**
 * 单请求用量库 → **账号健康时间序列**(可调度 / 限流 / 错误 三态)。
 *
 * 为什么要有它(2026-09-11 对齐 sub2api-cost-console / api2business):
 * 参考实现的健康图吃 sub2api `economics.series`,而 cockpit 源没有这个端点 → 整片空白。
 * 但"健康三态"本质是**失败原因分类**,而 `request_logs.error_category` /
 * `http_status` 是本机真实存在的分类字段(实测 upstream_error 19,271 /
 * quota_or_rate_limit 730 / client_canceled 2,761 / 429 共 493 次)。
 *
 * 口径(与 api2business `state_bucket` 语义对齐):
 *   normal       = 桶内成功请求数
 *   rate_limited = error_category=quota_or_rate_limit 或 http_status=429
 *   error        = 其余失败(上游错误 / 请求失败 / 认证失败),客户端取消单列不重复计入
 * 这是**按请求分类**,不是"账号某一时刻的状态快照";因此曲线读作
 * "该时段内各结局的请求量分布",图例沿用三态名以保持与参考实现一致。
 */
export function cockpitRequestLogToHealthSeries(
  summary: CockpitRequestLogSummary | null,
): AccountEconomicsSeriesPoint[] {
  if (!summary?.available || !summary.cells?.length) return []
  const byBucket = new Map<number, { normal: number; rateLimited: number; error: number }>()
  for (const c of summary.cells) {
    let cur = byBucket.get(c.startMs)
    if (!cur) {
      cur = { normal: 0, rateLimited: 0, error: 0 }
      byBucket.set(c.startMs, cur)
    }
    cur.normal += c.success || 0
    cur.rateLimited += c.rateLimited || 0
    // 客户端取消是用户侧主动放弃,不算"账号出错",否则会虚高错误态
    cur.error += Math.max(0, (c.error || 0) - (c.rateLimited || 0) - (c.clientCanceled || 0))
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, v]) => ({
      sampled_at: new Date(startMs).toISOString(),
      normal_count: v.normal,
      rate_limited_count: v.rateLimited,
      error_count: v.error,
      billed_usd_per_hour: null,
      account_cost_usd_per_hour: null,
      stable: true,
    }))
}

/**
 * 单请求用量库 → 错误码趋势(429 / 上游错误 / 其他),喂"请求质量 → 429/402/其他"图。
 *
 * cockpit 没有 402(封闭空间)语义 —— 实测 http_status 只有 200/503/502/504/429;
 * 529 亦无对应码。二者都**不是"实测 0"**,而是"该源不测" ⇒ 必须留 null:
 * null 在图表里是断点(finiteValue→null,无 spanGaps),0 会画成一条贴底实线,
 * 与真正实测到的 0 完全无法区分(红线:不得用 0 冒充实测)。
 */
export function cockpitRequestLogToErrorTrend(
  summary: CockpitRequestLogSummary | null,
): OpsErrorTrendPoint[] {
  if (!summary?.available || !summary.cells?.length) return []
  const byBucket = new Map<number, { total: number; limited: number; upstream: number; canceled: number }>()
  for (const c of summary.cells) {
    let cur = byBucket.get(c.startMs)
    if (!cur) {
      cur = { total: 0, limited: 0, upstream: 0, canceled: 0 }
      byBucket.set(c.startMs, cur)
    }
    cur.total += c.error || 0
    cur.limited += c.rateLimited || 0
    cur.upstream += c.upstreamError || 0
    cur.canceled += c.clientCanceled || 0
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, v]) => ({
      bucket_start: new Date(startMs).toISOString(),
      error_count_total: v.total,
      // cockpit 的 error_category 实测 12 类(upstream_error / request_failed /
      // client_canceled / quota_or_rate_limit / auth_failed / stream_incomplete /
      // model_not_available / upstream_first_byte_timeout / account_prepare_failed /
      // cooldown / auth_refresh_failed …)里**没有**"业务限制"(余额不足 / 配额超限)这一类,
      // Rust 分类器只产 rate_limited / upstream_error / client_canceled。
      // 与 FIX A 同口径:该维度不可得 ⇒ null(0 会被读成"实测零业务限制")。
      business_limited_count: null,
      // SLA 错误 = 错误总数 − 业务限制数;业务限制不可得 ⇒ 这个减法也算不出来,
      // 不能拿 error_count_total 冒名顶替成"SLA 错误"。
      error_count_sla: null,
      // 429 已单独计出,按命名(excl_429_529)扣除,避免重复计入"其他上游错误"
      upstream_error_count_excl_429_529: Math.max(0, v.upstream - v.limited),
      upstream_402_count: null,
      upstream_429_count: v.limited,
      upstream_529_count: null,
    }))
}

/** 单请求用量库聚合 → (模型,账号) 精确成本与 token。
 *  key = `${模型}\u0000${来源账号 id}`,与 ModelRouteRow.accountId 同一身份体系。
 *  供"真实模型/渠道/接口明细"表回填:库里没有入站 path 字段(只有 codex-api 日志有),
 *  故同一 (模型,账号) 下各接口按其请求数占比分摊该组精确成本,合计恒等于自算成本。 */
export interface CockpitRouteGroupCost {
  cost: number
  /** Unscaled API reference; cost separately applies the local multiplier. */
  referenceCost: number
  costUnknown: boolean
  requests: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  priceEvidence?: RoutePriceEvidence[]
  costBasis?: string
}

export function cockpitRequestLogGroupCost(
  summary: CockpitRequestLogSummary | null,
  priceSets: Record<string, CockpitModelPriceSet>,
  multiplier?: number,
): Map<string, CockpitRouteGroupCost> {
  const result = new Map<string, CockpitRouteGroupCost>()
  const mult = resolveCostMultiplier(multiplier)
  if (!summary?.available || !summary.groups?.length) return result
  for (const g of summary.groups) {
    const key = `${g.model}\u0000${g.accountId?.trim() ? accountIdToCostId(g.accountId) : UNATTRIBUTED_USAGE_ACCOUNT_ID}`
    // 算不出来时 cockpitSplitCostUsd 返回哨兵 0(costBasis no_price_no_estimate),不是实测成本。
    // 该状态必须随组一路带到路由行,不能在这里被 `.cost` 抹平 —— 否则显示层只能看到 $0.000000。
    const priceSet = cockpitPriceSetFor(priceSets, g.model)
    const priced = cockpitSplitCostUsd(g, priceSet, multiplier, g.serviceTier)
    const costBasis = priced.basis + (priceSet?.sessionLongContext && priced.costBasis.kind === 'priced'
      && g.longNormalInput + g.longCached + g.longOutput > 0 ? costDataText('includingLongContextTierPrices') : '')
    const cost = priced.knownCostUsd ?? priced.cost
    const referenceCost = cost / mult
    const usesQuotes = !!g.priceQuotes?.length && g.priceQuotes.every(quote => quote.usd != null && Number.isFinite(quote.usd))
    const priceEvidence = priceSet?.origin === 'local' ? [] : mergeRoutePriceEvidence(...(g.priceQuotes ?? []).map(quote => routeEvidenceFromQuote(quote, usesQuotes)))
    const costUnknown = isUnknownCostBasis(priced.costBasis.kind)
    const t = cockpitSplitTokens(g)
    const cur = result.get(key)
    if (cur) {
      cur.cost += cost
      cur.referenceCost += referenceCost
      cur.priceEvidence = mergeRoutePriceEvidence(cur.priceEvidence, priceEvidence)
      if (cur.costBasis !== costBasis) cur.costBasis = costDataText('mixedPricingBasesCatalogPricesConfiguredPricesOrSource')
      // 组内任一分量算不出来 ⇒ 整组标未知(与 costBasis.addPricedCost 的"取更差一侧"同规则)。
      cur.costUnknown = cur.costUnknown || costUnknown
      cur.requests += g.requests
      cur.inputTokens += t.inputTokens
      cur.cacheReadTokens += t.cachedTokens
      cur.outputTokens += t.outputTokens
    } else {
      result.set(key, {
        cost,
        referenceCost,
        priceEvidence,
        costBasis,
        costUnknown,
        requests: g.requests,
        inputTokens: t.inputTokens,
        cacheReadTokens: t.cachedTokens,
        outputTokens: t.outputTokens,
      })
    }
  }
  return result
}

/**
 * 用单请求用量库的 (模型×账号) 精确成本回填路由行的 token 与成本。
 *
 * 为什么仍是"分摊":库里没有入站接口(path)维度,拿不到 (模型×账号×接口) 的精确成本。
 * 但比原来的 applyCockpitModelAggregation 准得多——原来只按**模型**均摊,同模型多账号时
 * 每个账号都拿到同一个 per-request 成本;现在精确到账号,只在同 (模型,账号) 内按请求数分摊。
 * 分摊基数用**本表内**同组请求数之和,保证该组各行成本相加恒等于精确成本(不放大/缩水)。
 */
export function applyCockpitRequestLogCost(
  routes: ModelRouteRow[],
  groupCost: Map<string, CockpitRouteGroupCost>,
): void {
  if (!groupCost.size || !routes.length) return
  const keyOf = (model: string, accountId: CostAccountId | null) => `${model}\u0000${accountId ?? UNATTRIBUTED_USAGE_ACCOUNT_ID}`
  // 第一遍:统计本表内各 (模型,账号) 组的请求数(日志口径,作为分摊基数)
  const groupRequests = new Map<string, number>()
  const allocatedRequests = new Map<string, number>()
  for (const row of routes) {
    for (const model of [row.upstreamModel, row.requestedModel].filter((m): m is string => m != null)) {
      const k = keyOf(model, row.accountId)
      if (groupCost.has(k)) {
        groupRequests.set(k, (groupRequests.get(k) ?? 0) + row.requests)
        break
      }
    }
  }
  for (const row of routes) {
    if (row.requests <= 0) continue
    let key: string | null = null
    for (const model of [row.upstreamModel, row.requestedModel].filter((m): m is string => m != null)) {
      const k = keyOf(model, row.accountId)
      if (groupCost.has(k)) { key = k; break }
    }
    if (!key) continue
    const g = groupCost.get(key)!
    const total = groupRequests.get(key) ?? 0
    if (total <= 0) continue
    const share = row.requests / total
    const before = (allocatedRequests.get(key) ?? 0) / total
    const after = before + share
    // Cumulative rounding preserves integer totals across every interface share.
    row.inputTokens = Math.round(g.inputTokens * after) - Math.round(g.inputTokens * before)
    row.cacheReadTokens = Math.round(g.cacheReadTokens * after) - Math.round(g.cacheReadTokens * before)
    row.outputTokens = Math.round(g.outputTokens * after) - Math.round(g.outputTokens * before)
    row.totalTokens = row.inputTokens + row.outputTokens
    allocatedRequests.set(key, (allocatedRequests.get(key) ?? 0) + row.requests)
    const cost = g.cost * share
    // 整组"算不出来" ⇒ 不写哨兵 0,置 null 并由 costUnknown 让模板渲染「成本未知」。
    row.standardCost = g.costUnknown ? null : g.referenceCost * share
    row.accountCost = g.costUnknown ? null : cost
    row.knownStandardCost = g.costUnknown ? g.referenceCost * share : undefined
    row.knownAccountCost = g.costUnknown ? cost : undefined
    row.priceEvidence = g.priceEvidence
    row.costUnknown = g.costUnknown
    // cockpit 无独立用户计费层:不把营收硬编码等于成本(会让下游 mismatchRevenue 变假零)。
    // 营收不可知 → null(展示侧渲染「本机无营收口径」/「—」)。
    row.revenue = null
    row.costBasis = costDataText('allocatedByRequestCountWithinTheSameModelAccount', { p0: g.costBasis ?? (g.costUnknown ? costDataText('incompletePricingBasisKnownSubtotalOnly') : costDataText('cockpitRequestStoreReferencePrices')) })
  }
}

/** 成本口径统计(供状态栏如实说明):逐模型统计本项目自算/回退估算的条数。 */
export function cockpitRequestLogBasisNote(
  summary: CockpitRequestLogSummary | null,
  priceSets: Record<string, CockpitModelPriceSet>,
): { local: number; book: number; estimate: number; total: number } {
  const note = { local: 0, book: 0, estimate: 0, total: 0 }
  if (!summary?.available || !summary.groups?.length) return note
  const seen = new Set<string>()
  for (const g of summary.groups) {
    if (seen.has(g.model)) continue
    seen.add(g.model)
    note.total += 1
    const ps = cockpitPriceSetFor(priceSets, g.model)
    if (!ps) note.estimate += 1
    else if (ps.origin === 'local') note.local += 1
    else note.book += 1
  }
  return note
}

/** cockpit model{modelId,usage} → ModelStat(buildModelCostRows 消费)。
 *  cost 为 API 参考值，account_cost 才应用本机成本倍率。
 *  pricing:本地定价目录(per-token);传入时成本由本项目按 token × 单价自算,不吃数据源估算。 */
function cockpitModelToModelStat(
  m: CockpitModelUsage,
  costMultiplier?: number,
  pricing?: Record<string, CockpitPricedModel>,
): ModelStat {
  const u = m.usage
  const { cost, costBasis } = cockpitUsageCostUsd(u, pricing?.[m.modelId], costMultiplier)
  return {
    model: m.modelId,
    requests: u.requestCount,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    // cockpit 的 stats JSON(CockpitUsageStats)只有 input/output/total/cached/reasoning,
    // 没有 cache-creation 维度 ⇒ null。
    cache_creation_tokens: null,
    cache_read_tokens: u.cachedTokens,
    total_tokens: u.totalTokens,
    // 既无本项目单价、数据源也没给估算 ⇒ 计价函数返回的是**哨兵 0**(costBasis='no_price_no_estimate'),
    // 不是实测成本。写进数值列会被渲染成 $0.000000 ⇒ 置 null,由显示层渲染「成本未知」。
    cost: isUnknownCostBasis(costBasis.kind) ? null : cost / resolveCostMultiplier(costMultiplier),
    account_cost: isUnknownCostBasis(costBasis.kind) ? null : cost,
    // cockpit 是本地用量采集源,没有售价/营收层:不把营收硬编码等于成本(那会让毛利恒为 0)。
    actual_cost: null,
    first_seen: undefined,
    last_seen: m.updatedAt ? new Date(m.updatedAt).toISOString() : undefined,
  }
}

/** cockpit monthly.models[] → ModelStat[](完整模型成本分析用 monthly,含全部 10 模型)。
 *  costMultiplier 只应用到 account_cost，不改变 cost 参考值。 */
export function cockpitModelsToModelStats(
  window: CockpitStatsWindow | undefined,
  costMultiplier?: number,
  pricing?: Record<string, CockpitPricedModel>,
): ModelStat[] {
  if (!window?.models) return []
  return window.models.map((m) => cockpitModelToModelStat(m, costMultiplier, pricing))
}

/** cockpit daily.accounts[] → Record<accountId, WindowStats>(当日用量,供 todayStats)。
 *  key 用完整来源账号 id,与 store accountStats 查找一致。 */
/**
 * cockpit 任意统计窗口(daily/weekly/monthly) → 逐账号 WindowStats(按完整来源账号 id 索引)。
 *
 * 原名 cockpitDailyToTodayStats,但它接受的是**任意** CockpitStatsWindow——
 * 上游排行表需要跟随观察窗口(7d/30d)取数,不只是 daily,故改为中性命名。
 */
export function cockpitWindowToAccountStats(
  window: CockpitStatsWindow | undefined,
  costMultiplier?: number,
  pricing?: Record<string, CockpitPricedModel>,
): Record<string, AccountWindowUsage> {
  if (!window?.accounts) return {}
  // 账号级聚合无模型维度 → 用本窗口自算的混合单价还原(与模型表同口径,合计守恒)
  const blended = cockpitBlendedTokenPrice(window.models, pricing, costMultiplier)
  const result: Record<string, AccountWindowUsage> = {}
  for (const acc of window.accounts) {
    if (!acc.accountId?.trim()) continue
    const id = statsAccountCostId(acc)
    const u = acc.usage
    const priced = cockpitAggregateCostUsd(u, blended, costMultiplier)
    // 算不出来 ⇒ 三个成本字段一起 null(不是哨兵 0),由视图走"无数据"分支。
    const unknown = isUnknownCostBasis(priced.costBasis.kind)
    const cost = unknown ? null : priced.cost
    result[id] = {
      requests: u.requestCount,
      tokens: u.totalTokens,
      cost,
      standard_cost: cost == null ? null : cost / resolveCostMultiplier(costMultiplier),
      user_cost: null,
    }
  }
  return result
}

/** cockpit modelPricings(每百万 Token 单价) → ModelDefaultPricing(per-token 单价)。
 *  sub2api ModelDefaultPricing 是 per-token,cockpit 是 per-million,需 ÷1e6。 */
export function cockpitPricingsToModelPricing(
  pricings: CockpitModelPricing[] | undefined,
): Record<string, CockpitPricedModel> {
  if (!pricings) return {}
  const result: Record<string, CockpitPricedModel> = {}
  for (const p of pricings) {
    result[p.modelId] = {
      found: true,
      origin: 'local',
      input_price: p.inputUsdPerMillion != null ? p.inputUsdPerMillion / 1e6 : undefined,
      output_price: p.outputUsdPerMillion != null ? p.outputUsdPerMillion / 1e6 : undefined,
      cache_read_price: p.cachedInputUsdPerMillion != null ? p.cachedInputUsdPerMillion / 1e6 : undefined,
    }
  }
  return result
}

/** cockpit 内置价目表 → ModelDefaultPricing(per-token,标准档)。
 *  2026-09-08 对接补齐:cockpit 内置价目表覆盖全部受支持 Codex 模型,但编译在二进制里、
 *  不落盘也不提供接口——此前桌面端只读 `local_access.json.modelPricings` 里用户手动存的
 *  少数覆盖价,导致花钱最多的模型(实测 gpt-5.6-sol / gpt-6-astra)反而没有单价,
 *  只能回退数据源自带的黑盒估算。这里把内置价目表补进定价目录。 */
export function cockpitPriceBookToModelPricing(): Record<string, CockpitPricedModel> {
  const result: Record<string, CockpitPricedModel> = {}
  for (const [modelId, entry] of Object.entries(COCKPIT_PRICE_BOOK)) {
    result[modelId] = {
      found: true,
      origin: 'book',
      input_price: entry.standard.inputUsdPerMillion / 1e6,
      output_price: entry.standard.outputUsdPerMillion / 1e6,
      cache_read_price: entry.standard.cachedInputUsdPerMillion / 1e6,
    }
  }
  return result
}

/** 有效定价目录 = 内置价目表 + 用户本地覆盖(本地优先,逐模型整体覆盖)。 */
export function cockpitEffectiveModelPricing(
  pricings: CockpitModelPricing[] | undefined,
): Record<string, CockpitPricedModel> {
  return { ...cockpitPriceBookToModelPricing(), ...cockpitPricingsToModelPricing(pricings) }
}

/** cockpit local_access.modelPricings → PricingCatalogStatus(价格目录状态条)。
 *  cockpit 本地定价是用户在 cockpit-tools 配的,非远程同步——catalog_source/configured_source 标 'local'。
 *  model_count 用 modelPricings 数量,last_updated 用 local_access.updatedAt。 */
export function cockpitLocalAccessToPricingStatus(
  localAccess: CockpitLocalAccess | null,
): PricingCatalogStatus | null {
  const pricings = localAccess?.modelPricings
  if (!pricings || pricings.length === 0) return null
  return {
    model_count: pricings.length,
    last_updated: localAccess?.updatedAt ? new Date(localAccess.updatedAt).toISOString() : new Date(0).toISOString(),
    local_hash: '',
    catalog_source: 'local',
    configured_source: 'local',
    fallback_available: true,
    update_interval_hours: 0,
  }
}

/** 按 range 选 cockpit 时序窗口:短窗口→daily,7d→weekly,长窗口→monthly。
 *  cockpit 只有日/周/月 3 个快照,range 映射到最接近的窗口。
 *  返回窗口同时供 models(模型成本分析)与 trend(单点趋势)与 ops 使用。 */
export function cockpitWindowForRange(
  stats: CockpitStats,
  range: CostCenterRange,
): CockpitStatsWindow | undefined {
  // 2026-09-06:首选窗口缺失(cockpit 周/月快照刚重置、或首次运行)时回退到下一个可用快照,
  // 避免整页成本数据变空。回退会改变口径,调用方按**实际选中的窗口**标注(见 useCostCenterData)。
  if (range === '30d') return stats.monthly ?? stats.weekly ?? stats.daily
  if (range === '7d') return stats.weekly ?? stats.monthly ?? stats.daily
  // today/1m/5m/30m/1h/6h/24h → daily(最细粒度快照)
  return stats.daily ?? stats.weekly ?? stats.monthly
}

/**
 * 选中窗口的中文名(「今日累计」/「本周累计」/「本月累计」)。
 *
 * ★ 2026-09-24 抽成单一来源:此前这段判定只写在 `useCostCenterData` 的 cockpit 主路径里,
 * 而**模型区有自己的一轨窗口**(`modelCostRange`)需要同一套措辞 ⇒ 若各写一份,
 * 两处一旦分叉就会同屏出现两种口径。判定必须按**实际选中的那个窗口对象**比,
 * 不能按 `range` 猜 —— `cockpitWindowForRange` 有回退链(30d→monthly??weekly??daily),
 * monthly 缺失而回退到 weekly 时,按 range 写「本月累计」就把 7 天的数说成了本月。
 */
export function cockpitWindowLabelForRange(stats: CockpitStats, range: CostCenterRange): string {
  const window = cockpitWindowForRange(stats, range)
  if (!window) return costDataText('todayCumulative')
  if (window === stats.monthly) return costDataText('thisMonthCumulative')
  if (window === stats.weekly) return costDataText('thisWeekCumulative')
  return costDataText('todayCumulative')
}

/**
 * ★ 数据源覆盖状态:观察窗口相对**数据源实际覆盖范围**的关系(2026-09-24 核对后新增)。
 *
 * **病根**:cockpit 的 `codex_local_access_logs.sqlite` 会**停止写入**。本机实测(186,353 行 /
 * 跨度 50.7 天)末端停在 `2026-09-17T19:19:54Z`,距今 **156.7 小时(6.5 天)**;而面板此前
 * **无条件**标注「(单请求用量库全程覆盖)」。后果:
 *  · 短窗口(1m~24h)整个落在数据末端之后 ⇒ 窗口内 0 行;
 *  · 7d 窗口 `[09-17 08:00Z, 09-24 08:00Z)` 实际只被覆盖 **11.3/168 小时(6.7%)**;
 *  · 30d 窗口只覆盖 23.5/30 天。
 * 那个 `0` 与那些偏小的数**都不是"实测"**,而是"**源没覆盖到这段**"。
 * 红线:「**源不掌握 ≠ 实测为 0**」—— 必须能被界面看出来。
 */
export type CockpitCoverageState =
  /** 数据源完整覆盖该窗口 ⇒ 窗口值可直接当实测 */
  | 'full'
  /** 只覆盖一部分 ⇒ 窗口值只是**下界**(没覆盖的那段未计入) */
  | 'partial'
  /** 完全没覆盖(数据末端早于窗口起点) ⇒ 该窗口「无数据」,**不是**实测 0 */
  | 'uncovered'
  /** 拿不到数据源覆盖范围 ⇒ 不标注(不猜,也不谎报"全程覆盖") */
  | 'unknown'

export interface CockpitCoverage {
  state: CockpitCoverageState
  /** 数据源实际覆盖区间(ms);`unknown` 时全为 null */
  dataStartMs: number | null
  dataEndMs: number | null
  /** **窗口内**被数据覆盖的那一段(ms);`uncovered` / `unknown` 时为 null。
   *  与 `dataStartMs/dataEndMs` 的区别:那两个是**数据源的范围**,这两个是**与本窗口的交集**。 */
  coveredStartMs: number | null
  coveredEndMs: number | null
  /** 被覆盖的比例 0~1;`uncovered` / `unknown` 时为 0。 */
  coveredRatio: number
}

/**
 * 观察窗口相对数据源覆盖范围的判定。
 *
 * `dataStartMs` / `dataEndMs` 必须来自**全表扫描**的 min/max timestamp ——
 * 即 `getCockpitRequestLogSummary(1, null, null, false)` 返回的 `windowStartMs` / `windowEndMs`
 * (Rust 侧 `start_ms`/`end_ms` 传 null 时 `lo = i64::MIN` / `hi = i64::MAX`,即**无时间过滤**)。
 *
 * ⚠️ **不要**传某个具体窗口的 min/max:那个字段在窗口为空时是 `null`,
 * 结构上无法区分「该窗口真的没有请求」与「源根本没覆盖这段」。
 *
 * 窗口用 `usageWindowBounds` 的**半开区间** `[start, end)`,与趋势分桶口径一致。
 */
/** 覆盖比例 ≥ 此值即视为「全程覆盖」。
 *
 *  ⚠️ 用**相对比例**而不是绝对时间容差。绝对容差在短窗口上会失去意义:
 *  若容差取 1 小时,那 1 小时的窗口里「窗口起点 == 数据末端」(覆盖率 0%)也会被判成 `full`。
 *  相对阈值是**尺度无关**的:短窗口要求末端很贴窗口尾,长窗口允许几小时的空档。
 *
 *  它表达的是「**源还活着,窗口基本被覆盖**」:源在按请求写入时,窗口里没有行
 *  就是**真的没有请求**,不是「没覆盖」。 */
const COCKPIT_FULL_COVERAGE_RATIO = 0.9

export function cockpitWindowCoverage(
  range: CostCenterRange,
  dataStartMs: number | null | undefined,
  dataEndMs: number | null | undefined,
  now: number = Date.now(),
): CockpitCoverage {
  // ⚠️ `dataStartMs == null || dataEndMs == null` 这一行**不许"简化"掉**:
  //    它不只是运行时判空,更是 **TypeScript 收窄的承重墙** —— `== null` 为假才把
  //    `number | null | undefined` 收成 `number`,下面 4 个 return 才能赋值给 `number | null`。
  //    删掉它 ⇒ `vue-tsc --noEmit` 报 9 条 TS18049/TS2322(实测 EXIT=2)。
  //    ⚠️ 而 **vitest 走 esbuild 剥类型、不做类型检查** ⇒ 这类"类型级变异"测试套件
  //    **结构上抓不到**,检测器只能是 `vue-tsc`(发布门 `vue-tsc -b && vite build` 会拦住)。
  //    判读变异时先问:"这个变异的检测器本来是不是就不是测试套件?"
  if (
    dataStartMs == null || dataEndMs == null
    || !Number.isFinite(dataStartMs) || !Number.isFinite(dataEndMs)
  ) {
    return {
      state: 'unknown', dataStartMs: null, dataEndMs: null,
      coveredStartMs: null, coveredEndMs: null, coveredRatio: 0,
    }
  }
  const { start, end } = usageWindowBounds(range, new Date(now))
  const windowStart = start.getTime()
  const windowEnd = end.getTime()
  const windowMs = windowEnd - windowStart
  // 覆盖段 = **数据源范围 ∩ 本窗口**。比例用相对值 ⇒ 尺度无关(见 COCKPIT_FULL_COVERAGE_RATIO)。
  const coveredStartMs = Math.max(windowStart, dataStartMs)
  const coveredEndMs = Math.min(windowEnd, dataEndMs)
  const coveredRatio = windowMs > 0
    ? Math.max(0, coveredEndMs - coveredStartMs) / windowMs
    : 0
  // 数据末端**早于**窗口起点 ⇒ 窗口内不可能有任何记录(max(ts) 够不着窗口) ⇒ 源未覆盖。
  // ⚠️ 边界:`dataEnd == 窗口起点` **不算** uncovered —— 半开区间 `[start, end)` 下恰好落在
  //    起点的记录仍属于本窗口(单请求库的扫描是闭区间 `>= ?1 AND <= ?2`,见 `cockpit_logs_db.rs:326-331`)。
  //    这种情形覆盖比例是 0,落到下面的 `partial`(措辞会写「占窗口 0%」)。
  // ⚠️ 措辞是「数据源止于 X」而**不是**「该窗口没有请求」—— 后者是我们**无从断言**的。
  if (dataEndMs < windowStart) {
    return {
      state: 'uncovered', dataStartMs, dataEndMs,
      coveredStartMs: null, coveredEndMs: null, coveredRatio: 0,
    }
  }
  // 覆盖比例达标、且窗口头也被覆盖 ⇒ 完整覆盖(可直接当实测)。
  if (coveredRatio >= COCKPIT_FULL_COVERAGE_RATIO && dataStartMs <= windowStart) {
    return { state: 'full', dataStartMs, dataEndMs, coveredStartMs, coveredEndMs, coveredRatio }
  }
  // 其余(末端没到窗口尾 / 起点晚于窗口头) ⇒ 只覆盖一部分 ⇒ 数值是**下界**。
  return { state: 'partial', dataStartMs, dataEndMs, coveredStartMs, coveredEndMs, coveredRatio }
}

/** `cockpitCoverageNote` 的入参(用对象而不用位置参数:6 个位置参数没法读)。 */
export interface CockpitCoverageNoteInput {
  state: CockpitCoverageState
  /** 被**请求**的窗口名,如「最近 7 天」。 */
  windowLabel: string
  /** 数据源末端(已格式化)。`uncovered` 时用。 */
  dataEndLabel: string
  /** **窗口内**被覆盖的那一段(已格式化,如 `7/29 → 9/17`)。`partial` 时用。 */
  coveredRangeLabel: string
  /** 覆盖比例(整数百分比 0~100)。`partial` 时用。 */
  coveredPercent: number
  /** `uncovered` 时面板**实际展示**的日历快照窗口名(「今日累计」等);缺省退回 `windowLabel`。 */
  snapshotLabel?: string
}

/**
 * 覆盖四态 → 窗口口径标注。**纯函数**(日期由调用方格式化后传入),
 * 让措辞能被**直测** —— 文本扫描钉不住语义(见 `REFERENCE.md` §十九)。
 */
export function cockpitCoverageNote(input: CockpitCoverageNoteInput): string {
  const { state, windowLabel, dataEndLabel, coveredRangeLabel, coveredPercent, snapshotLabel } = input
  if (state === 'full') return costDataText('fullyCoveredByTheRequestStore', { p0: windowLabel })
  if (state === 'partial') {
    // ★ 说「占窗口 N%」而不是只给两个端点:端点说不出"只覆盖了 6.7%"这件事,
    //   而用户要判断的恰恰是「这个数可信到什么程度」。
    return costDataText('requestStoreCoversOnlyOfTheWindowUncoveredPeriods', { p0: windowLabel, p1: coveredRangeLabel, p2: coveredPercent })
  }
  if (state === 'uncovered') {
    // ★★ 措辞必须描述**面板实际展示的东西**,不能断言「该窗口无数据」。
    // 2026-09-24 血案:短窗口(1m~24h)在源停写后,模型表/成本趋势**回退到 daily 快照**,
    // 屏幕上有数字;而这里原写「该窗口无数据」⇒ 同屏自相矛盾,
    // 用户读成「把有数据改成无数据」。
    // ⇒ 写成「{实际展示的窗口名}（数据源止于 X）」:既说清这个数字**是什么窗口**,
    //   又说清数据源**停在哪儿**,两边都不撒谎。
    const shown = snapshotLabel || windowLabel
    return costDataText('sourceDataEndsAt', { p0: shown, p1: dataEndLabel })
  }
  return windowLabel
}

/** `cockpitSnapshotWindowNote` 的入参(与 `CockpitCoverageNoteInput` 分开:
 *  快照口径**不需要**覆盖区间与占比 —— 它不声称"覆盖了窗口的多少")。 */
export interface CockpitSnapshotWindowNoteInput {
  /** 面板实际展示的**日历快照**窗口名(「今日累计」/「本周累计」/「本月累计」)。 */
  snapshotLabel: string
  /** 该窗口相对数据源覆盖范围的态(用来决定要不要补一句「数据源止于 X」)。 */
  state: CockpitCoverageState
  /** 数据源末端(已格式化,如 `9/17`);未知时传空串。 */
  dataEndLabel: string
}

/**
 * **日历快照口径**的窗口标注。纯函数,可直测。
 *
 * 用在"数值来自 `daily/weekly/monthly` 快照、而不是单请求用量库的滚动窗口"的地方
 * (cockpit 的模型区独立窗口、成本列回退分支)。
 *
 * 为什么不能复用 `cockpitCoverageNote`:`full` / `partial` 两态的措辞都写着
 * 「**单请求用量库**全程覆盖 / 仅覆盖 …」—— 那是**滚动窗口口径**的自我描述,
 * 用在快照口径上是**假口径**(快照根本没有"覆盖窗口多少"这件事)。快照口径要说的只有两件:
 * ① 这个数属于**哪个日历窗口**;② 源**停在哪天**(源还活着时不必说,那是噪音)。
 *
 * ⚠️ 与 `cockpitCoverageNote` 的 `uncovered` 分支**必须给出同一句话** ——
 * 两者都在描述"屏幕上是快照数字、而源已停写"这同一个事实,措辞分叉就是同屏两种口径。
 * (有测试逐字对比这两个函数的输出。)
 */
export function cockpitSnapshotWindowNote(input: CockpitSnapshotWindowNoteInput): string {
  const { snapshotLabel, state, dataEndLabel } = input
  if (!snapshotLabel) return ''
  // 源还活着且窗口被完整覆盖 ⇒ 快照就是它自己的窗口,再补一句「止于哪天」是噪音。
  // `dataEndLabel` 缺失(拿不到范围)时不补 —— 补了会渲染成「（数据源止于 ）」。
  if (state === 'full' || !dataEndLabel) return snapshotLabel
  // 源已停写 / 覆盖不全 ⇒ 必须说清数据止于哪天,否则「今日累计」会被读成"今天的数据"。
  return costDataText('sourceDataEndsAt', { p0: snapshotLabel, p1: dataEndLabel })
}

/** 空分位数对象:cockpit 只有 totalLatencyMs(均值),无 P50/P90/P95/P99 分位数。
 *  duration.avg_ms 用 cockpit 均值填,其余分位留 null(图表断点,不造假)。 */
type OpsPercentiles = NonNullable<OpsDashboardOverview['duration']>

function emptyPercentiles(avgMs?: number): OpsPercentiles {
  return { p50_ms: null, p90_ms: null, p95_ms: null, p99_ms: null, avg_ms: avgMs ?? null, max_ms: null }
}

/** cockpit totals → OpsDashboardOverview(运维总览 KPI 用)。
 *  cockpit 能填:成功/失败/请求总数/token/错误率/上游错误率/qps/tps(均值)/duration.avg_ms。
 *  cockpit 真无的子维度一律留 **null**:TTFT 分位数、429/402/529 错误码、qps/tps peak、
 *  health_score、业务限制计数与 SLA 三件套(business_limited_count / error_count_sla / sla)。
 *  这些是 sub2api Ops 监控特有(cockpit 是本地用量统计,无分位数采样/错误码拆分/SLA 配置)。
 *  留空而非造假:图表对应 series 断点,KPI 显示「无数据」;写 0 会被读成"实测为零"。 */
export function cockpitTotalsToOpsOverview(
  stats: CockpitStats,
  range: CostCenterRange,
  /**
   * 窗口级 TTFT 分位数(来自 Rust `summarize_cockpit_api_logs` 顶层 ttft_p50_ms/ttft_p95_ms)。
   * 快照 totals 没有分位数,只有多天日志聚合的顶层才有;不传 / 无样本时保持全 null ⇒
   * 面板显示「无样本」,绝不落成 0(0 ms 是"瞬时返回"的断言)。
   */
  windowTtft?: { p50Ms: number | null; p95Ms: number | null } | null,
): OpsDashboardOverview | null {
  const window = cockpitWindowForRange(stats, range)
  // ★★ 2026-09-24 分子修正:必须用**选中窗口自己的 totals**,不能用 `stats.totals`。
  //   `stats.totals` 是**生命周期累计**;本机实测 `totals.requestCount = 186,351`(自 07-29),
  //   而 `daily / weekly / monthly` **各自带自己的 totals**(本机 73 / 1,769 / 27,102)。
  //   此前一律读 `stats.totals` ⇒ 面板在「最近 1 小时」标签下渲染 **186,351 次调用**,
  //   而同屏模型成本表(同样已回退到 daily 快照)显示 **73 次** —— 同屏两个数,差 **2,553 倍**。
  //   回退:`window` 缺失(无任何窗口快照)时才退回 `stats.totals`,
  //   与 `cockpitWindowForRange` 自身的回退语义一致。
  const t = window?.totals ?? stats.totals
  const since = window?.since ?? stats.since ?? Date.now()
  const updatedAt = window?.updatedAt ?? stats.updatedAt ?? Date.now()
  const requestCount = t.requestCount
  const errorCount = t.failureCount
  const errorRate = requestCount > 0 ? errorCount / requestCount : 0
  const upstreamErrors = t.upstreamResponseFailedCount
  const upstreamErrorRate = requestCount > 0 ? upstreamErrors / requestCount : 0
  const avgLatencyMs = requestCount > 0 ? Math.round(t.totalLatencyMs / requestCount) : 0
  // ponytail: qps/tps 只有累计均值可用(总数/窗口小时),无 peak/瞬时——cockpit 无时间序列采样
  // ★★ 2026-09-24 分母修正:必须用**分子实际覆盖的时长**,即 `since → updatedAt`。
  //   本机 daily 快照:`since` = 09-18 00:00+08、`updatedAt` = 09-18 03:19+08 ⇒ 覆盖 3.32h / 73 请求。
  //   此前用 `economicsWindowHours(range)`(= **被请求**的窗口时长,'1h' ⇒ 1):
  //   分子是 3.32h 的量、分母是 1h ⇒ 凭空放大 3.3 倍;而分子此前还是生命周期累计
  //   (186,351)⇒ 合计放大 **2,553 × 3.3 ≈ 8,400 倍**。
  //   ★★ 2026-09-26 再修正:覆盖时长**不可知时必须返回 null,不许编数字**。
  //     此前在 `spanHours <= 0` 时退回 `economicsWindowHours(range)`(**被请求的名义窗口时长**),
  //     而那个分支恰恰只在「没有窗口快照」时才会走到 —— 此时 `since`/`updatedAt` 都回退成了
  //     `Date.now()`(见 :1630-1631),`spanHours` 恒为 0,分子 `t` 是**生命周期累计**
  //     (`stats.totals`,本机 186,351 请求 / 231 亿 token,自 07-29 起)。
  //     ⇒ 拿一个从不存在的"覆盖时长"去除一个生命周期累计量,qps/tps 完全是凭空编出来的。
  //     名义窗口时长不是"唯一还能自洽的口径",它是假的 —— 分子根本没覆盖那段时长。
  //     ⇒ 拿不到真实覆盖时长就置 null(面板显示「无数据」),宁可无数据,不许假数据。
  //   ★ `Number.isFinite` 必须显式判:`NaN <= 0` 为 false,`x / NaN = NaN` 会被写进数值列,
  //     渲染出来长得像数字却毫无意义 —— NaN 比 null 更糟。
  //   与 `useCostCenterData` 的 `cockpitWindowHours`(同样改用 `since → updatedAt`)同一条判据。
  const spanHours = Number.isFinite(since) && Number.isFinite(updatedAt) && updatedAt > since
    ? (updatedAt - since) / 3_600_000
    : null
  const qpsAvg = spanHours != null && spanHours > 0 ? requestCount / (spanHours * 3600) : null
  const tpsAvg = spanHours != null && spanHours > 0 ? t.totalTokens / (spanHours * 3600) : null
  return {
    start_time: new Date(since).toISOString(),
    end_time: new Date(updatedAt).toISOString(),
    platform: 'all',
    success_count: t.successCount,
    error_count_total: errorCount,
    // FIX A 同口径:cockpit 的失败分类里没有"业务限制"(余额不足/配额超限)维度,
    // 只有 failureCount / upstreamResponseFailedCount 这类计数 ⇒ 三件套全不可得。
    // 0 会让面板显示"SLA 达标率 0.00% / 零次业务限制",都是凭空断言。
    business_limited_count: null,
    error_count_sla: null,
    request_count_total: requestCount,
    request_count_sla: requestCount,
    token_consumed: t.totalTokens,
    sla: null,
    error_rate: errorRate,
    upstream_error_rate: upstreamErrorRate,
    upstream_error_count_excl_429_529: upstreamErrors,
    // FIX A:cockpit totals 没有 429 维度(429 只在 errorTrend 路径由 error_category 得出),
    // 0 是假实测值 ⇒ null,面板显示「无数据」而不是「零次 429」。
    upstream_429_count: null,
    upstream_529_count: null,
    qps: { current: qpsAvg, peak: qpsAvg, avg: qpsAvg },
    tps: { current: tpsAvg, peak: tpsAvg, avg: tpsAvg },
    duration: emptyPercentiles(avgLatencyMs),
    // FIX 5:有窗口级真实分位数就填,否则保持 null(图表断点 / KPI「无样本」)。
    ttft: windowTtft
      ? { ...emptyPercentiles(), p50_ms: windowTtft.p50Ms, p95_ms: windowTtft.p95Ms }
      : emptyPercentiles(),
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 第三轮纠正:补全 accountUsage / modelRoutes / systemSettings / accountEconomics
// 前两轮误标 unavailable 的 4 维度 cockpit 都有数据源,实读确认可转换。
// ──────────────────────────────────────────────────────────────────────────

/** cockpit quota_history 点 → sub2api UsageProgress(配额窗口)。
 *  remainingPercentage 100→0 表示剩余比例,utilization = 100 - remaining。 */
function cockpitQuotaPointToUsageProgress(point: CockpitQuotaPoint): RecordedQuotaProgress {
  const remaining = Math.max(0, Math.min(100, point.remainingPercentage))
  return {
    utilization: 100 - remaining,
    resets_at: quotaTimestamp(point.resetTime),
    remaining_seconds: point.countdownSeconds ?? 0,
    window_stats: null,
    used_requests: undefined,
    limit_requests: undefined,
    recorded_at: quotaTimestamp(point.timestamp),
    snapshot_source: 'recorded',
  }
}

/** cockpit quota_history 文件们 → Record<accountId, AccountUsageInfo>(配额窗口)。
 *  quota_history 文件只有 email 无 accountId,需用 stats.accounts 找 email→accountId 映射。
 *  每模型的最近一个 point → antigravity_quota Record(modelId, {utilization, reset_time})。
 *  ponytail: 只填 antigravity_quota + updated_at + source,其余平台窗口留 null(cockpit 是 codex/antigravity 系)。 */
export function cockpitQuotaToAccountUsage(
  files: CockpitQuotaHistoryFile[],
  statsAccounts: CockpitStatsAccount[],
): Record<string, AccountUsageInfo> {
  // email → accountId 映射(stats.accounts 有 email + accountId)
  const emailToAccountId = new Map<string, string>()
  for (const acc of statsAccounts) {
    if (acc.email) emailToAccountId.set(acc.email, acc.accountId)
  }
  const result: Record<string, AccountUsageInfo> = {}
  for (const file of files) {
    // D7:email 未命中真实账号时**跳过该文件** —— file.email 不是 accountId,
    // 拿它当 accountId 会派生出一个幽灵 key:
    //  · 它不代表任何真实账号(冒充实测);
    //  · 让 Object.keys(result).length > 0,把配额状态从 empty 抬成 measured
    //    (本机 cache/quota_history 的 8 个文件 updatedAt 全为 2026-03-24,约 6 个月前,
    //     模型是 claude-4-5/g3-pro/g3-flash 的 antigravity 系,与当前 codex 池不同源)。
    const accountId = emailToAccountId.get(file.email)
    if (!accountId?.trim()) continue
    const id = accountIdToCostId(accountId)
    const antigravityQuota: NonNullable<AccountUsageInfo['antigravity_quota']> = {}
    let latestUpdatedMs = file.updatedAt
    for (const [modelId, history] of Object.entries(file.models)) {
      const points = history.points
      if (!points || points.length === 0) continue
      // 取最近一个非 reset 的消耗点(remaining 最低 = 用得最多),或最后一点
      const lastPoint = points[points.length - 1]
      if (!Number.isFinite(lastPoint.remainingPercentage)) continue
      const progress = cockpitQuotaPointToUsageProgress(lastPoint)
      antigravityQuota[modelId] = {
        ...progress,
        utilization: progress.utilization,
        reset_time: progress.resets_at ?? '',
      }
      if (lastPoint.timestamp > latestUpdatedMs) latestUpdatedMs = lastPoint.timestamp
    }
    if (Object.keys(antigravityQuota).length === 0) continue
    result[id] = {
      source: 'passive',
      updated_at: latestUpdatedMs ? new Date(latestUpdatedMs).toISOString() : null,
      five_hour: null,
      seven_day: null,
      seven_day_sonnet: null,
      antigravity_quota: antigravityQuota,
    }
  }
  return result
}

/** Match already-read native quota records by raw account ID, never email or label. */
export function cockpitSnapshotsToAccountUsage(
  snapshots: QuotaSnapshot[],
  accounts: Account[],
  existing: Record<string, AccountUsageInfo> = {},
  nowMs = Date.now(),
): Record<string, AccountUsageInfo> {
  const result = { ...existing }
  const selected = new Map<string, { id: string; slot: 'five_hour' | 'seven_day' | 'seven_day_sonnet'; snapshot: QuotaSnapshot }>()
  for (const snapshot of snapshots) {
    if (!snapshot.accountId?.trim() || snapshot.unavailableReason || snapshot.percent == null
      || !Number.isFinite(snapshot.percent) || snapshot.percent < 0 || snapshot.percent > 100) continue
    const platform = snapshot.channel === 'codex' ? 'openai' : snapshot.channel === 'claude_manager' ? 'anthropic' : null
    if (!platform) continue
    const canonical = accountIdToCostId(snapshot.accountId)
    const matches = accounts.filter(account => account.platform === platform && typeof account.id === 'string'
      && account.id.startsWith('cockpit:') && (account.id === canonical || account.extra?.cockpit_account_id === snapshot.accountId))
    if (matches.length !== 1) continue
    const model = snapshot.modelId
    // Only verified period identities; Weekly alone may be a restricted model pool.
    const slot = model === 'five_hour' && snapshot.scope !== 'model' && snapshot.windowKind === 'fiveHour' ? 'five_hour'
      : model === 'seven_day' && snapshot.scope !== 'model' && snapshot.windowKind === 'weekly' ? 'seven_day'
        : snapshot.channel === 'codex' && model === 'codex' && snapshot.scope !== 'model' && snapshot.windowKind === 'weekly' ? 'seven_day'
          : snapshot.channel === 'claude_manager' && model === 'seven_day_sonnet' && snapshot.windowKind === 'weekly' ? 'seven_day_sonnet' : null
    if (!slot) continue
    const id = String(matches[0].id)
    const key = JSON.stringify([id, slot])
    const previous = selected.get(key)
    const stamp = quotaTimestamp(snapshot.updatedAtMs) ? snapshot.updatedAtMs! : -Infinity
    const previousStamp = previous && quotaTimestamp(previous.snapshot.updatedAtMs) ? previous.snapshot.updatedAtMs! : -Infinity
    if (!previous || stamp > previousStamp) selected.set(key, { id, slot, snapshot })
  }
  for (const { id, slot, snapshot } of selected.values()) {
    const resetAt = quotaTimestamp(snapshot.resetAtMs)
    const recordedAt = quotaTimestamp(snapshot.updatedAtMs)
    const progress: RecordedQuotaProgress = {
      utilization: 100 - snapshot.percent!,
      resets_at: resetAt,
      remaining_seconds: resetAt ? Math.max(0, (new Date(resetAt).getTime() - nowMs) / 1000) : 0,
      recorded_at: recordedAt,
      snapshot_source: snapshot.source === 'live' ? 'live' : 'recorded',
      snapshot_stale: snapshot.stale,
      snapshot_error: snapshot.sourceError ?? null,
    }
    const previous = result[id] ?? { source: 'passive', updated_at: null, five_hour: null, seven_day: null, seven_day_sonnet: null }
    const previousStamp = previous?.updated_at ? new Date(previous.updated_at).getTime() : 0
    const updatedAt = recordedAt && snapshot.updatedAtMs! > previousStamp ? recordedAt : previous?.updated_at ?? recordedAt
    result[id] = {
      ...previous,
      updated_at: updatedAt,
      [slot]: progress,
    }
  }
  return result
}

/** cockpit codex-api 日志一行解析结果(按 requestId 聚合前的中间态)。
 *  扩展 ttftMs/streamOpenedMs:从 stream_first_chunk / stream_opened 取 latencyMs,
 *  供 cockpitLogToOpsTrend 派生 TTFT 分位数与延迟趋势。
 *  path/method/transport/requestKind/apiKeyId/apiKeyLabel:入站接口与密钥归属
 *  (日志事件真实字段,修复此前入站接口写死 /v1/responses、密钥归属丢失)。 */
interface CockpitLogEvent {
  requestId: string
  model?: string
  accountId?: string
  accountEmail?: string
  authId?: string
  provider?: string
  success?: boolean
  httpStatus?: number
  status?: number
  latencyMs?: number
  completedAtMs?: number
  startedAtMs?: number
  requestKind?: string
  /** 入站路径(客户端 → cockpit 网关),如 /v1/responses */
  path?: string
  /** HTTP 方法(POST 等) */
  method?: string
  /** 传输方式(sse/json) */
  transport?: string
  /** 归属网关 API Key(cockpit 网关 key,非上游账号) */
  apiKeyId?: string
  apiKeyLabel?: string
  /** TTFT(首字节延迟),来自 stream_first_chunk.latencyMs */
  ttftMs?: number
  /** 流打开耗时,来自 stream_opened.latencyMs(备用,无 first_chunk 时回退) */
  streamOpenedMs?: number
}

/** 从日志行提取 JSON payload(跳过时间戳 + [CodexLocalAccess][sidecar] 前缀)。
 *  日志格式:`2026-08-26T08:00:04.400+08:00 INFO [CodexLocalAccess][sidecar] {...json...}` */
function extractLogJson(line: string): Record<string, unknown> | null {
  const idx = line.indexOf('{')
  if (idx < 0) return null
  try {
    return JSON.parse(line.slice(idx)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** cockpit codex-api 日志最大解析行数(对齐 sub2api MAX 路由记录上限)。 */
/** codex-api.log 单次解析的行数上限(>此值只取最近 N 行,并置 `truncated`)。
 *  导出给视图做「截断说明」文案 —— 上限数字不允许在 UI 里另抄一份(抄了就会与真实截断失配)。 */
export const MAX_COCKPIT_LOG_LINES = 25000

/** cockpit codex-api 日志原文 → 按 requestId 聚合的事件数组(纯解析,供 routes/opsTrend 共用)。
 *  聚合:request_started(model+startedAtMs) + auth_result(accountId+provider+success) +
 *  request_completed(status+latencyMs+completedAtMs) + stream_first_chunk(ttftMs) + stream_opened(streamOpenedMs)。
 *  截断保护:>25000 行只取最近 25000。
 *  返回事件数组(已按 requestId 合并,含模型与时间字段)。 */
export function parseCockpitApiLog(log: string | null): { events: CockpitLogEvent[]; truncated: boolean } {
  if (!log) return { events: [], truncated: false }
  const lines = log.split('\n')
  const truncated = lines.length > MAX_COCKPIT_LOG_LINES
  const usedLines = truncated ? lines.slice(-MAX_COCKPIT_LOG_LINES) : lines

  const byRequestId = new Map<string, CockpitLogEvent>()
  for (const line of usedLines) {
    if (!line.includes('[CodexLocalAccess][sidecar]')) continue
    const payload = extractLogJson(line)
    if (!payload) continue
    const type = payload.type as string | undefined
    const requestId = payload.requestId as string | undefined
    if (!requestId || !type) continue
    const existing = byRequestId.get(requestId) ?? { requestId }
    if (type === 'request_started' || type === 'executor_started') {
      existing.model = (payload.model as string) ?? existing.model
      existing.requestKind = (payload.requestKind as string) ?? existing.requestKind
      existing.startedAtMs = (payload.startedAtMs as number) ?? existing.startedAtMs
      existing.path = (payload.path as string) ?? existing.path
      existing.method = (payload.method as string) ?? existing.method
      existing.transport = (payload.transport as string) ?? existing.transport
      existing.apiKeyId = (payload.apiKeyId as string) ?? existing.apiKeyId
      existing.apiKeyLabel = (payload.apiKeyLabel as string) ?? existing.apiKeyLabel
    } else if (type === 'auth_result' || type === 'auth_selected') {
      existing.accountId = (payload.accountId as string) ?? existing.accountId
      existing.accountEmail = (payload.accountEmail as string) ?? existing.accountEmail
      existing.authId = (payload.authId as string) ?? existing.authId
      existing.provider = (payload.provider as string) ?? existing.provider
      existing.apiKeyId = (payload.apiKeyId as string) ?? existing.apiKeyId
      existing.apiKeyLabel = (payload.apiKeyLabel as string) ?? existing.apiKeyLabel
      if (type === 'auth_result') {
        existing.success = payload.success as boolean | undefined
        existing.httpStatus = (payload.httpStatus as number) ?? existing.httpStatus
      }
    } else if (type === 'request_completed') {
      existing.status = (payload.status as number) ?? existing.status
      existing.latencyMs = (payload.latencyMs as number) ?? existing.latencyMs
      existing.completedAtMs = (payload.completedAtMs as number) ?? existing.completedAtMs
      existing.path = (payload.path as string) ?? existing.path
      existing.apiKeyId = (payload.apiKeyId as string) ?? existing.apiKeyId
      existing.apiKeyLabel = (payload.apiKeyLabel as string) ?? existing.apiKeyLabel
    } else if (type === 'stream_first_chunk') {
      // TTFT = 流首字节延迟(stream_first_chunk.latencyMs)
      existing.ttftMs = (payload.latencyMs as number) ?? existing.ttftMs
    } else if (type === 'stream_opened') {
      existing.streamOpenedMs = (payload.latencyMs as number) ?? existing.streamOpenedMs
    }
    byRequestId.set(requestId, existing)
  }

  // 只保留有 model 的业务请求(无 model 的是 startup/auth_updated 等非业务事件)
  const events = [...byRequestId.values()].filter((evt) => evt.model)
  return { events, truncated }
}

/** 聚合事件 → AdminUsageLog[](只填 buildModelRouteRows 读的字段,其余默认)。
 *  token/成本/营收一律留 null:源侧 CockpitLogEvent 无逐请求 token 与成本,
 *  填 0 会被下游读成"该请求实测成本为零"并渲染 $0.000000;null 才是"无此数据"。
 *  真实值由 applyCockpitModelAggregation / applyCockpitRequestLogCost 按窗口均摊回填,
 *  回填未命中时保持 null,显示层渲染「无数据」。
 *  渠道列(来源标识)与上游接口列(来源对应目标)分离:
 *  - oauth → 虚拟渠道"OpenAI Codex 官方(OAuth 池)",上游目标 'OpenAI Codex 官方上游';
 *  - apikey → 虚拟渠道名=渠道名(model_providers 映射),上游目标=渠道 baseUrl host;
 *  - 提供商测试 → "模型提供商测试"。
 *  返回 {logs, channels}:虚拟 channels 供 buildModelRouteRows 解析 channelName。 */
function eventsToUsageLogs(
  events: CockpitLogEvent[],
  accounts: Account[],
): { logs: AdminUsageLog[]; channels: Channel[] } {
  const accountInfoById = new Map<string, { name: string; type: AccountType; baseUrl?: string; isProviderTest: boolean }>()
  for (const acc of accounts) {
    const baseUrl = (acc.credentials as { base_url?: string } | undefined)?.base_url
    accountInfoById.set(String(acc.id), {
      name: acc.name,
      type: acc.type,
      baseUrl,
      isProviderTest: Boolean((acc.extra as { cockpit_provider_test?: boolean } | null)?.cockpit_provider_test),
    })
  }

  // 虚拟渠道注册表:渠道名 → 稳定负 id(不与 sub2api 真渠道正 id 冲突)
  const channelIds = new Map<string, number>()
  const channels: Channel[] = []
  const virtualChannelId = (name: string): number => {
    let id = channelIds.get(name)
    if (id == null) {
      id = -(channelIds.size + 1)
      channelIds.set(name, id)
      channels.push({ id, name, model_pricing: [] } as unknown as Channel)
    }
    return id
  }

  function hostOf(url: string | undefined): string | null {
    if (!url) return null
    try { return new URL(url).host } catch { return url }
  }

  const logs: AdminUsageLog[] = []
  for (const evt of events) {
    const sourceAccountId = evt.accountId?.trim() ? accountIdToCostId(evt.accountId) : null
    const info = sourceAccountId != null ? accountInfoById.get(String(sourceAccountId)) : undefined
    const createdAt = evt.completedAtMs
      ? new Date(evt.completedAtMs).toISOString()
      : evt.startedAtMs
        ? new Date(evt.startedAtMs).toISOString()
        : new Date(0).toISOString()
    // 渠道列=账号来源标识;上游接口列=来源对应目标(oauth→官方上游,apikey→渠道 host)
    // 2026-09-06:实测日志只有约 15% 的请求带 accountId(auth_selected/auth_result 才有,
    // 命中缓存/未触发换号的请求不带)。这些请求此前被标成"已删除账号（历史）"——是假的:
    // 账号并未删除,只是日志没有归因信息。改为显式"未归因",不冒充已删除。
    let channelName: string
    let upstreamTarget: string
    if (info?.isProviderTest) {
      channelName = costDataText('modelProviderTest')
      upstreamTarget = costDataText('modelProviderTestUpstream')
    } else if (info?.type === 'apikey') {
      channelName = info.name
      upstreamTarget = hostOf(info.baseUrl) ?? info.name
    } else if (info) {
      channelName = costDataText('officialOpenaiCodexOauthPool')
      upstreamTarget = costDataText('officialOpenaiCodexUpstream')
    } else {
      channelName = costDataText('unattributedChannelLogsHaveNoAccountid')
      upstreamTarget = costDataText('notRecordedLogsHaveNoAccountid')
    }
    logs.push({
      id: 0,
      user_id: 0,
      api_key_id: 0,
      account_id: sourceAccountId,
      request_id: evt.requestId,
      model: evt.model!,
      // codex-api 日志**根本没有** service_tier 字段(2026-09-20 实测:grep 近几日
      // `codex-api.log.*` 连子串 `tier` 都命中 0 次)⇒ 留 null 是"该来源不记录",
      // 不是"这条是标准档"。档位的真实来源是 request_logs 表(见 CockpitTokenSplit.serviceTier)。
      service_tier: null,
      reasoning_effort: null,
      // 入站端点只认日志里的 path。日志没写就如实留空 ——
      // 显示层已把空串渲染成 '-'（UsageTable）/'未记录'（modelRouteAnalysis.text()），
      // 套 '/v1/responses' 兜底等于替这条请求声称一个它并未被记录的入站端点。
      inbound_endpoint: evt.path ?? '',
      upstream_endpoint: upstreamTarget,
      channel_id: virtualChannelId(channelName),
      subscription_id: null,
      // codex-api 日志的 CockpitLogEvent(见 1391 行结构体)**没有任何 token 字段**
      // (只有 requestId/model/accountId/success/httpStatus/latencyMs/requestKind/path/transport/ttftMs)
      // ⇒ 逐请求 token 不可得。0 会被读成"该请求实测零 token",留 null 才是"无此数据"。
      input_tokens: null,
      output_tokens: null,
      cache_creation_tokens: null,
      cache_read_tokens: null,
      cache_creation_5m_tokens: null,
      cache_creation_1h_tokens: null,
      input_cost: null,
      output_cost: null,
      cache_creation_cost: null,
      cache_read_cost: null,
      total_cost: null,
      // cockpit 逐请求日志不含单请求 token 与成本:这里不是"营收为 0",而是"无此数据"。
      // 填 null(而非 0),避免下游 summarizeModelAudit 汇成"用户计费 $0.000000"的假零。
      actual_cost: null,
      rate_multiplier: 1,
      long_context_billing_applied: false,
      billing_type: 0,
      request_type: evt.requestKind ?? 'unknown',
      stream: evt.transport !== 'json',
      duration_ms: evt.latencyMs ?? null,
      first_token_ms: evt.ttftMs ?? null,
      image_count: null,
      image_size: null,
      image_input_size: null,
      image_output_size: null,
      image_size_source: null,
      image_size_breakdown: null,
      // 图片维度:源侧只有**图片请求计数**(CockpitUsageStats.imageRequestCount /
      // imageGenerationRequestCount / imageEditRequestCount,src/api/cockpit/index.ts:30-33),
      // **没有图片 token 维度**;request_logs 建表也没有任何 image 列 ⇒ 不可得,留 null。
      image_input_tokens: null,
      image_input_cost: null,
      image_output_tokens: null,
      image_output_cost: null,
      user_agent: null,
      cache_ttl_overridden: false,
      created_at: createdAt,
      // AdminUsageLog 扩展字段。
      // upstream_model = 实际发往上游的模型。
      // **cockpit 的 request_logs 没有这个字段**:建表语句里只有 `model_id`(客户端请求的模型),
      // 没有任何"这个请求发往上游时用的是哪个模型"的列
      // (见 cockpit-tools-main/src-tauri/src/modules/codex_local_access_request_logs.rs)。
      // `codex_local_access.rs` 里的 `upstream_model` 属于 CodexLocalAccessProviderGateway
      // —— 那是**网关供应商配置**,不是逐请求日志字段,不能拿来充当逐请求实测值。
      // 此前填成 `evt.model`,界面会显示 `gpt-5 → gpt-5`,暗示"实测到上游也是 gpt-5"。
      // 置 null,让界面显示「未记录」;价格查找等需要模型名的地方回退到请求模型(见各自调用点)。
      upstream_model: null,
      // 响应声明模型 / 审计结论:**cockpit 的 request_logs 没有这两个字段**(已核实的源限制,
      // 见本文件 cockpitRoutesAuditSummary 上方注释:如需真实审计请接 sub2api)。
      // 此前写死 `upstream_response_model: evt.model!` + `upstream_model_mismatch: false`,
      // 于是「响应声明 / 审计」列渲染出模型名 + is-matched「一致」徽标,
      // 而同屏 routeTableHint 写着"日志无逐请求 token 与上游响应模型,审计维度不可用" —— 自相矛盾。
      // 这里不是"去取一个存在的字段",而是"不要再编一个":置 null 让 modelRouteAnalysis
      // 判定 modelAuditStatus = 'unobserved'(视图显示"未观测"),与 routeTableHint 的措辞一致。
      upstream_response_model: null,
      upstream_model_mismatch: null,
      model_mapping_chain: null,
      account_rate_multiplier: 1,
      account_stats_cost: null,
      billing_tier: null,
      account: sourceAccountId != null
        ? {
            id: sourceAccountId,
            name: info?.name ?? evt.accountEmail ?? costDataText('account', { p0: sourceAccountId }),
            type: info?.type ?? 'oauth',
          }
        // 2026-09-06:无 accountId != 账号已删除(日志只是没记 auth 事件)。
        // 如实显示"未归因账号",避免把未归因请求误报成"已删除账号（历史）"。
        : { id: 0, name: costDataText('unattributedAccountLogsHaveNoAccountid'), type: 'oauth' },
    } as unknown as AdminUsageLog)
  }
  return { logs, channels }
}

/** 按模型窗口聚合均摊回填路由行的 token 与成本(日志无 per-request token,cockpit 聚合是真实口径)。
 *  每行按 requests / 该模型总请求数 比例分摊,全部路由行合计=模型窗口总量。 */
function applyCockpitModelAggregation(
  routes: ModelRouteRow[],
  modelAgg: CockpitModelUsage[],
  costMultiplier: number,
  pricing?: Record<string, CockpitPricedModel>,
) {
  const byModel = new Map(modelAgg.map((m) => [m.modelId, m]))
  for (const row of routes) {
    const m = byModel.get(row.upstreamModel ?? row.requestedModel)
    if (!m) continue
    const totalReqs = m.usage.requestCount
    if (totalReqs <= 0 || row.requests <= 0) continue
    const ratio = row.requests / totalReqs
    row.inputTokens = Math.round(m.usage.inputTokens * ratio)
    row.cacheReadTokens = Math.round(m.usage.cachedTokens * ratio)
    row.outputTokens = Math.round(m.usage.outputTokens * ratio)
    row.totalTokens = row.inputTokens + row.outputTokens
    // 2026-09-08:模型窗口成本由本项目按本地单价 × token 自算(无单价时回退数据源估算并标注)
    const priced = cockpitUsageCostUsd(m.usage, pricing?.[m.modelId], costMultiplier)
    // 算不出来时 cockpitUsageCostUsd 返回哨兵 0(costBasis no_price_no_estimate),不是实测成本
    // ⇒ 不写进数值列,置 null 并由 costUnknown 让模板渲染「成本未知」。
    const costUnknown = isUnknownCostBasis(priced.costBasis.kind)
    const cost = priced.cost * ratio
    row.standardCost = costUnknown ? null : cost
    row.accountCost = costUnknown ? null : cost
    row.costUnknown = costUnknown
    // cockpit 无独立用户计费层:API 产出即账号侧成本口径,不把营收硬编码等于成本。
    row.revenue = null
    row.costBasis = costDataText('allocatedByModelWindowUsageLogsHaveNoPer', { p0: priced.basis })
  }
}

/** cockpit codex-api 日志原文 → ModelRouteRow[](路由审计表)。
 *  内部调 parseCockpitApiLog 一次,events 同时供 cockpitLogToOpsTrend 复用(前端分别调,各自解析)。
 *  modelAgg(窗口 models)+倍率:按模型窗口聚合均摊回填 token/成本(缓存列/成本列不再全 0)。
 *  渠道/上游来源经 accounts 解析(名称+credentials.base_url 已在 cockpitAccountToAccount 装好)。
 *  返回 {routes, truncated, logs}:logs 供 summarizeModelAudit + cockpitLogToTrend 复用。 */
export function cockpitLogToModelRoutes(
  log: string | null,
  accounts: Account[],
  modelAgg?: CockpitModelUsage[],
  costMultiplier?: number,
  pricing?: Record<string, CockpitPricedModel>,
  /** `accountId(原始或来源身份形式) → cockpit 账号分组名`;传了才回填「分组」列。 */
  groupNameByAccountId?: Map<string, string> | null,
): { routes: ModelRouteRow[]; truncated: boolean; logs: AdminUsageLog[] } {
  const { events, truncated } = parseCockpitApiLog(log)
  const { logs, channels } = eventsToUsageLogs(events, accounts)
  const routes = buildModelRouteRows(logs, channels)
  if (groupNameByAccountId?.size) {
    for (const row of routes) {
      if (row.accountId == null) continue
      const name = groupNameByAccountId.get(String(row.accountId))
      if (name) {
        row.groupName = name
        row.groupLabel = costDataText('cockpitAccountGroup')
      }
    }
  }
  if (modelAgg?.length) applyCockpitModelAggregation(routes, modelAgg, resolveCostMultiplier(costMultiplier), pricing)
  return { routes, truncated, logs }
}

/**
 * cockpit 分组定义 → `accountId → 分组名` 映射。
 *
 * 为什么需要:cockpit 的 `request_logs` **没有** `group_id` 列(见
 * `cockpit-tools-main/src-tauri/src/modules/codex_local_access_request_logs.rs:151-181`),
 * 但 cockpit **确有账号分组**(`account_groups.json` / `codex_account_groups.json`,
 * 见 `src-tauri/src/commands/account.rs:773` 与 `codex_model_provider_commands.rs:7`)。
 * 分组按 `accountIds` 描述"账号归到哪个组",因此可用 `request_logs.account_id`
 * 反查得到"这条请求走的账号属于哪个分组"——是真实可得的维度,不是编造。
 *
 * 冲突处理:同一 accountId 若同时出现在多个组(两套分组文件合并后),
 * **保留首个命中**(先 codex 后 antigravity),不猜测、不合并名称。
 *
 * 返回的 Map 同时以**原始 accountId**(如 `codex_ff74…`)和其**来源身份形式**
 * (source + 完整 accountId,与 `ModelRouteRow.accountId` 同口径)为键,
 * 让 ops 聚合路径(有原始 id)与单天日志路径都能查到同一份分组。
 */
export function cockpitGroupNameByAccountId(
  codexGroups?: CockpitAccountGroup[] | null,
  accountGroups?: CockpitAccountGroup[] | null,
): Map<string, string> {
  const map = new Map<string, string>()
  const all: CockpitAccountGroup[] = [
    ...(codexGroups ?? []),
    ...(accountGroups ?? []),
  ]
  for (const group of all) {
    if (!group || typeof group.name !== 'string') continue
    const name = group.name.trim()
    if (!name) continue
    const ids = Array.isArray(group.accountIds) ? group.accountIds : []
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) continue
      if (!map.has(id)) map.set(id, name)
      const costId = accountIdToCostId(id)
      if (!map.has(costId)) map.set(costId, name)
    }
  }
  return map
}

/** 单请求用量库 groups → CockpitOpsRouteAgg[](长窗口路由明细兜底)。
 *
 * 2026-09-27:summarize_cockpit_api_logs 只读 codex-api.log.YYYY-MM-DD 文本日志,
 * 本机 9 月份没有这些文件(只有 app.log 系列)⇒ 30d/7d 窗口下 routes=[]。
 * 但 SQLite request_logs 有真实数据(30d 56,813 行),groups 按(模型×账号×apiKeyId)聚合,
 * 可派生路由行。本函数将 groups 转成 CockpitOpsRouteAgg 格式,复用 cockpitOpsRoutesToModelRoutes。
 *
 * 合并:同 (model, accountId) 的多个 group(apiKeyId 不同)合并为一条,
 * 与 cockpitRequestLogGroupCost 的 `${model}\u0000${accountIdToCostId(accountId)}` 键一致。
 * success_count/error_count 置 0(groups 无 success/error 维度,路由表不显示这两列)。
 */
export function cockpitRequestLogGroupsToOpsRoutes(
  groups: CockpitRequestLogGroup[],
): CockpitOpsRouteAgg[] {
  const merged = new Map<string, { model: string; accountId: string; requests: number; firstMs: number | null; lastMs: number | null }>()
  for (const g of groups) {
    const accountId = g.accountId?.trim() ? g.accountId : ''
    const key = `${g.model}\u0000${accountId}`
    let cur = merged.get(key)
    if (!cur) {
      cur = { model: g.model, accountId, requests: 0, firstMs: null, lastMs: null }
      merged.set(key, cur)
    }
    cur.requests += g.requests
    if (g.firstMs != null) cur.firstMs = cur.firstMs == null ? g.firstMs : Math.min(cur.firstMs, g.firstMs)
    if (g.lastMs != null) cur.lastMs = cur.lastMs == null ? g.lastMs : Math.max(cur.lastMs, g.lastMs)
  }
  return [...merged.values()].map(g => ({
    model: g.model,
    account_id: g.accountId || null,
    inbound_path: null,
    requests: g.requests,
    success_count: 0,
    error_count: 0,
    first_ms: g.firstMs,
    last_ms: g.lastMs,
  }))
}

/** Rust 侧多天日志的路由聚合 → ModelRouteRow[](修复"真实模型/渠道/接口明细只显示当天")。
 *
 * 2026-09-06 背景:该表此前固定读 codex-api.log.<今天>,切到 7d/30d 数字纹丝不动
 * (用户反馈"数据窗口改了,并没有真实窗口数据显示")。改由 Rust summarize_cockpit_api_logs
 * 在窗口内流式聚合(模型×账号×入站接口),这里只做展示层转换:
 * - 每条聚合 → 一个合成事件 → buildModelRouteRows 复用同一套 key/渠道/账号解析逻辑;
 * - requests 用聚合值覆盖(合成事件本身只代表 1 次请求);
 * - token/成本仍按模型窗口用量均摊(日志无逐请求 token,与单天日志口径一致)。
 * 返回 {routes, totalRequests}:totalRequests 供模型审计卡片按真实窗口计数。 */
export function cockpitOpsRoutesToModelRoutes(
  routes: CockpitOpsRouteAgg[],
  accounts: Account[],
  modelAgg?: CockpitModelUsage[],
  costMultiplier?: number,
  pricing?: Record<string, CockpitPricedModel>,
  /** 单请求用量库的 (模型×账号) 精确成本;有则用它回填(含长上下文档位价),
   *  无则回退按模型窗口用量均摊(旧口径,不区分账号且无长文本文档)。 */
  groupCost?: Map<string, CockpitRouteGroupCost> | null,
  /** `accountId → cockpit 账号分组名`(由 {@link cockpitGroupNameByAccountId} 构建)。
   *  传了才回填路由行的「分组」列;不传保持 buildModelRouteRows 的「未分组」默认值。 */
  groupNameByAccountId?: Map<string, string> | null,
): { routes: ModelRouteRow[]; totalRequests: number } {
  if (!routes.length) return { routes: [], totalRequests: 0 }
  const events: CockpitLogEvent[] = routes.map((agg, index) => ({
    requestId: `cockpit-agg-${index}`,
    model: agg.model,
    accountId: agg.account_id ?? undefined,
    path: agg.inbound_path ?? undefined,
    startedAtMs: agg.first_ms ?? undefined,
    completedAtMs: agg.last_ms ?? undefined,
  }))
  const { logs, channels } = eventsToUsageLogs(events, accounts)
  const rows: ModelRouteRow[] = []
  let totalRequests = 0
  for (let i = 0; i < logs.length && i < routes.length; i++) {
    const agg = routes[i]
    const [row] = buildModelRouteRows([logs[i]], channels)
    if (!row) continue
    row.requests = agg.requests
    if (agg.first_ms != null) row.firstSeen = new Date(agg.first_ms).toISOString()
    // 分组:cockpit 日志无 group_id,但账号所属分组可从分组文件反查得到。
    // 有命中才覆盖默认「未分组」,并打上来源标注(groupLabel),避免被误读成 sub2api 计费分组。
    const cockpitGroup = groupNameByAccountId?.get(agg.account_id ?? '')
      ?? (row.accountId != null ? groupNameByAccountId?.get(String(row.accountId)) : undefined)
    if (cockpitGroup) {
      row.groupName = cockpitGroup
      row.groupLabel = costDataText('cockpitAccountGroup')
    }
    totalRequests += row.requests
    rows.push(row)
  }
  if (groupCost?.size) {
    applyCockpitRequestLogCost(rows, groupCost)
  } else if (modelAgg?.length) {
    applyCockpitModelAggregation(rows, modelAgg, resolveCostMultiplier(costMultiplier), pricing)
  }
  // accountCost 为 null = 该行成本不可知(均摊回填未命中),排在有值行之后,不当 0 参与比较。
  rows.sort((left, right) => {
    if (left.accountCost == null && right.accountCost == null) return right.requests - left.requests
    if (left.accountCost == null) return 1
    if (right.accountCost == null) return -1
    return right.accountCost - left.accountCost || right.requests - left.requests
  })
  return { routes: rows, totalRequests }
}

/** Shared SQL fallback for both main and independent model windows; null means unavailable, not empty. */
export function cockpitRequestLogToModelRoutes(
  summary: CockpitRequestLogSummary | null,
  accounts: Account[],
  priceSets: Record<string, CockpitModelPriceSet>,
  costMultiplier?: number,
  groupNameByAccountId?: Map<string, string> | null,
): { routes: ModelRouteRow[]; totalRequests: number } | null {
  if (!summary?.available) return null
  return cockpitOpsRoutesToModelRoutes(
    cockpitRequestLogGroupsToOpsRoutes(summary.groups ?? []),
    accounts,
    undefined,
    costMultiplier,
    undefined,
    cockpitRequestLogGroupCost(summary, priceSets, costMultiplier),
    groupNameByAccountId,
  )
}

/** 窗口路由聚合的模型审计汇总。
 *  cockpit 日志**没有**"上游响应声明模型"字段,连一帧请求都判不出"声明模型 vs 实际模型"是否一致,
 *  所以真实语义是**全部未观测**,而不是"全部一致"。
 *
 *  此前实现写 observed=matched=total、mismatchRate=0,UI 渲染成"N/N 已验证一致 · 0 差异" ——
 *  这与同区域明细行显示的"未观测"直接自相矛盾,等于用默认结论冒充审计实测结论
 *  (红线:界面不得暗示系统掌握了它并不掌握的信息)。
 *  另注 mismatchRate 必须是 null(= 未测量)而不是 0:0 是在断言"零差异",
 *  只有真的比对过才配说 0;null 才是"没测过"。沿用 `honestValues.ts` 的契约。
 *  如需真实审计请接 sub2api(usage_logs 有 upstream_response_model)。 */
export function cockpitRoutesAuditSummary(totalRequests: number): ModelAuditSummary {
  return {
    totalRequests,
    observedRequests: 0,
    matchedRequests: 0,
    mismatchRequests: 0,
    unobservedRequests: totalRequests,
    mismatchRate: null,
    mismatchStandardCost: 0,
    mismatchAccountCost: 0,
    mismatchRevenue: null,
  }
}

/** 分位数计算(空数组返 null)。 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

/** cockpit codex-api 日志 → OpsThroughputTrendPoint[](密集时间桶,供运行趋势图)。
 *  按 requestId 聚合事件(parseCockpitApiLog),再按 range 桶尺寸分桶:
 *  每桶 request_count/success_count/error_count/ttft_p50/p95/duration_p95/qps。
 *  token / tps 留 null(日志根本没有 token 字段);
 *  user_billed_usd / account_cost_usd / contribution_usd 留 null(成本在窗口快照与
 *  cockpitRequestLogToCostTrend,不是 ops 维度 —— 留 0 会被 selectFinancialTrend 当成"有值")。
 *  时间桶尺寸复用 TREND_BUCKET_MILLISECONDS(today=15min,1h=1min,6h=5min,24h=15min)。
 *  无 completedAtMs 的请求用 startedAtMs 落桶;两者都无跳过。 */
export function cockpitLogToOpsTrend(
  log: string | null,
  range: CostCenterRange,
): OpsThroughputTrendPoint[] {
  const { events } = parseCockpitApiLog(log)
  if (events.length === 0) return []

  const { start, end } = usageWindowBounds(range)
  const bucketMs = costTrendBucketHours(range) * 3600 * 1000
  const startMs = start.getTime()
  const endMs = end.getTime()

  interface Bucket {
    bucketStart: number
    requests: number
    success: number
    error: number
    ttfts: number[]
    durations: number[]
  }
  const buckets = new Map<number, Bucket>()

  for (const evt of events) {
    const ts = evt.completedAtMs ?? evt.startedAtMs
    if (!ts) continue
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs
    if (bucketStart < startMs || bucketStart >= endMs) continue
    const b = buckets.get(bucketStart) ?? { bucketStart, requests: 0, success: 0, error: 0, ttfts: [], durations: [] }
    b.requests += 1
    if (evt.status != null) {
      if (evt.status >= 200 && evt.status < 300) b.success += 1
      else b.error += 1
    } else if (evt.success === false) {
      b.error += 1
    } else if (evt.success === true) {
      b.success += 1
    }
    if (evt.ttftMs != null) b.ttfts.push(evt.ttftMs)
    if (evt.latencyMs != null) b.durations.push(evt.latencyMs)
    buckets.set(bucketStart, b)
  }

  // 补空桶(fillCostTrendBuckets 同语义:窗口内每个桶都有点,无请求的桶填 0)
  const result: OpsThroughputTrendPoint[] = []
  const bucketSeconds = bucketMs / 1000
  for (let cursor = Math.floor(startMs / bucketMs) * bucketMs; cursor < endMs; cursor += bucketMs) {
    const b = buckets.get(cursor)
    const ttfts = b ? b.ttfts.sort((a, c) => a - c) : []
    const durations = b ? b.durations.sort((a, c) => a - c) : []
    const reqCount = b?.requests ?? 0
    result.push({
      bucket_start: new Date(cursor).toISOString(),
      request_count: reqCount,
      success_count: b?.success ?? 0,
      error_count: b?.error ?? 0,
      // codex-api 日志没有 token 字段(CockpitLogEvent 里就没有,实测 grep inputTokens 命中 0),
      // 桶里只有请求/成败/延迟 ⇒ token 与 tps 全不可得。0 会被读成"该桶实测零 token"。
      token_consumed: null,
      input_tokens: null,
      output_tokens: null,
      cache_creation_tokens: null,
      cache_read_tokens: null,
      switch_count: null,
      // 成本在窗口快照 / cockpitRequestLogToCostTrend,不在这条链路(见 selectFinancialTrend 门)。
      user_billed_usd: null,
      account_cost_usd: null,
      contribution_usd: null,
      duration_p95_ms: percentile(durations, 95),
      ttft_p50_ms: percentile(ttfts, 50),
      ttft_p95_ms: percentile(ttfts, 95),
      qps: bucketSeconds > 0 ? reqCount / bucketSeconds : 0,
      tps: null,
    })
  }
  return result
}

/**
 * Rust 多天日志聚合(summarize_cockpit_api_logs)→ OpsThroughputTrendPoint[]。
 *
 * 背景:7d/30d 观察窗口此前无效——单天日志已 26k 行超过前端 25000 行截断上限,
 * 多天拼接在 JS 端既 OOM 又被截尾,趋势图永远只有当天(或最后 3 个累计快照点)。
 * 聚合已移至 Rust,这里只做单位换算。日志无 token/成本字段 ⇒ token 列 / tps / 成本列
 * 诚实留 `null`(图表断点、面板「无数据」),**不是** 0 —— 0 是"实测为零"的断言。
 */
export function cockpitOpsSummaryToTrend(summary: CockpitOpsSummary, bucketHours: number): OpsThroughputTrendPoint[] {
  const bucketSeconds = Math.max(1, bucketHours * 3600)
  return summary.buckets.map((b) => ({
    bucket_start: new Date(b.bucket_start_ms).toISOString(),
    request_count: b.request_count,
    success_count: b.success_count,
    error_count: b.error_count,
    // Rust summarize_cockpit_api_logs 的桶(CockpitOpsBucket)只有请求/成败/TTFT/耗时,
    // 没有 token 与成本字段 ⇒ token 列与 tps 全不可得。0 会被读成"该桶实测零 token",
    // 还会让 AdaptiveOperationsCharts 的「缓存读取占比」分母变成 0 而恒显 0%。
    token_consumed: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    switch_count: null,
    // 成本在窗口快照 / cockpitRequestLogToCostTrend,不在这条链路(见 selectFinancialTrend 门)。
    user_billed_usd: null,
    account_cost_usd: null,
    contribution_usd: null,
    duration_p95_ms: b.duration_p95_ms,
    ttft_p50_ms: b.ttft_p50_ms,
    ttft_p95_ms: b.ttft_p95_ms,
    qps: b.request_count / bucketSeconds,
    tps: null,
  }))
}

/**
 * 把 Rust 多天日志聚合的桶裁剪到精确滚动窗口(2026-09-06 新增)。
 *
 * Rust 侧按**日历日文件**聚合(startDate 00:00 → endDate 23:59),返回的桶必然超出滚动窗口边界:
 * 24h 窗口(现在 01:18 → 昨天 01:18)若按 2 个日历日聚合,会得到昨天 00:00 起的 48 个桶,
 * 直接绘制就把窗口外的时段算进来了。这里按 usageWindowBounds(range) 裁掉窗口外的桶。
 * 1 小时桶无法精确到分钟,边界桶(如 [00:00,01:00) 而窗口从 01:18 起)整体裁掉——宁可少算不算多算。
 */
export function clipOpsBucketsToWindow(
  points: OpsThroughputTrendPoint[],
  range: CostCenterRange,
): OpsThroughputTrendPoint[] {
  const { start, end } = usageWindowBounds(range)
  const startMs = start.getTime()
  const endMs = end.getTime()
  return points.filter((point) => {
    const ts = new Date(point.bucket_start).getTime()
    return Number.isFinite(ts) && ts >= startMs && ts < endMs
  })
}

/**
 * 日志聚合的 per-account 请求数 → 视图完整来源账号 id keyed Record。
 *
 * 背景(2026-09-05 修复"7d/30d 数据是错的"):cockpit 快照 weekly/monthly 是日历累计
 * (本周一/本月 1 日起),此前被冒充成"7 天/30 天"滚动窗口——实测 7d($2,464, 8/31 起 5 天)
 * > 30d($1,141, 9/1 起 4 天),窗口越大数字越小。日志(auth_selected/auth_result)带 accountId,
 * 与 stats accountId 同一标识体系,聚合后经 accountIdToCostId 映射即可与账号行对上。
 * 请求数用日志真滚动窗口;成本/Token 日志没有字段,保持快照口径由视图标注。
 */
export function cockpitOpsAccountsToRequestCounts(accounts: CockpitOpsAccountAgg[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const agg of accounts) {
    if (agg.account_id?.trim()) result[accountIdToCostId(agg.account_id)] = agg.requests
  }
  return result
}

/**
 * cockpit 窗口快照 → CostTrendDataPoint[](供成本趋势图与 $/h 速率 KPI)。
 *
 * 2026-09-06 修复"数据窗口改了,并没有真实窗口数据显示":
 * 此前固定输出 daily/weekly/monthly **3 点**——三个起点不同、跨度不同的日历累计值
 * (今天 00:00 / 本周一 00:00 / 本月 1 日 00:00),既完全忽略 range(切 1h 和 30d 是同一条线),
 * 又时间轴乱序(今天 → 本周一 → 本月 1 日 被当成递增时间序列),折线图因此是误导性的。
 *
 * cockpit 的硬限制:codex-api 日志**没有成本/Token 字段**,成本只存在于日/周/月日历累计快照,
 * 无法构造真实滚动窗口成本序列。诚实做法:
 * - 只输出**当前 range 对应窗口的 1 个累计点**(date = window.since 即窗口真实起点);
 * - 速率由视图用该窗口**真实已过时长**折算(见 useCostCenterData.cockpitWindowHours),
 *   不把"本周累计"冒充"最近 7 天",也不按请求数均摊编造逐桶成本。
 * range 缺省时(兼容旧调用)回退 3 窗口快照。
 */
export function cockpitWindowsToCostTrend(
  stats: CockpitStats,
  costMultiplier?: number,
  range?: CostCenterRange,
  pricing?: Record<string, CockpitPricedModel>,
): CostTrendDataPoint[] {
  const selected = range ? cockpitWindowForRange(stats, range) : undefined
  const windows = selected
    ? [selected]
    : [stats.daily, stats.weekly, stats.monthly].filter((w): w is CockpitStatsWindow => !!w)
  const points: CostTrendDataPoint[] = []
  for (const window of windows) {
    const t = window.totals
    // 窗口成本 = 本窗口各模型按本地单价自算之和(无模型聚合时才回退数据源估算,并由状态文案标注)
    const priced = cockpitAggregateCostUsd(
      t,
      cockpitBlendedTokenPrice(window.models, pricing, costMultiplier),
      costMultiplier,
    )
    const cost = priced.cost
    // 三态(与单请求用量库的桶口径同规则):全窗口算不出来 ⇒ null(图表断点);
    // 部分模型无单价 ⇒ 保留求和值(真实下界)并标 source_estimate;全部有单价 ⇒ 不标注。
    const unknown = isUnknownCostBasis(priced.costBasis.kind)
    points.push({
      date: new Date(window.since).toISOString(),
      requests: t.requestCount,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      // 快照口径的 totals(CockpitUsageStats)同样没有 cache-creation 维度 ⇒ null。
      cache_creation_tokens: null,
      cache_read_tokens: t.cachedTokens,
      total_tokens: t.totalTokens,
      cost: unknown ? null : cost,
      // cockpit 是本地用量采集源,没有营收/售价/毛利概念:此处置 actual_cost = 自算成本(cost) 是刻意保留。
      // 下游 6 个显示点复用本字段(窗口合计 windowActualOutputUsd 与 financialTrend.billedUsd),
      // 直接断开会让这些格从数字变成"无数据",属于误伤。营收语义由显示层按 connectionType 分支纠正
      // (CostCenterView.vue 显示为"自算成本"),数据层此处不再冒充"用户计费"。
      actual_cost: unknown ? null : cost,
      account_cost: unknown ? null : cost,
      costBasis: unknown
        ? 'no_price_no_estimate' as const
        : priced.costBasis.kind === 'source_estimate' ? 'source_estimate' as const : undefined,
    })
  }
  return points
}

/** cockpit customRoutingRules → sub2api 调度权重 key(让 resolveSchedulerBaseScoreMax 出真实分)。
 *  sub2api SystemSettings 是注册/认证体系,cockpit 无;但调度评分只读 8 个 weight key。
 *  cockpit priority/weight → 映射到这套 weight(priority→weight_priority, weight→weight_load)。
 *  返回 Partial<SystemSettings>(只含调度权重 key + cockpit 路由策略标注)。 */
export function cockpitLocalAccessToSystemSettings(
  localAccess: CockpitLocalAccess | null,
): Record<string, unknown> | null {
  if (!localAccess) return null
  const rules = localAccess.customRoutingRules ?? []
  if (rules.length === 0 && !localAccess.routingStrategy) return null
  // cockpit 路由规则派生调度权重:有 isPreferred 的账号给高 priority 权重,isBackup 给低
  let priorityWeight = 1
  let loadWeight = 1
  for (const rule of rules) {
    if (rule.isPreferred) priorityWeight = Math.max(priorityWeight, 1.5)
    if (rule.isBackup) priorityWeight = Math.min(priorityWeight, 0.5)
    if (typeof rule.weight === 'number') loadWeight = Math.max(loadWeight, rule.weight)
  }
  return {
    // 8 个调度权重 key(resolveSchedulerBaseScoreMax 读取)
    openai_advanced_scheduler_effective_weight_priority: priorityWeight,
    openai_advanced_scheduler_effective_weight_load: loadWeight,
    openai_advanced_scheduler_effective_weight_queue: 0.7,
    openai_advanced_scheduler_effective_weight_error_rate: 0.8,
    openai_advanced_scheduler_effective_weight_ttft: 0.5,
    openai_advanced_scheduler_effective_weight_reset: 0,
    openai_advanced_scheduler_effective_weight_quota_headroom: 0,
    openai_advanced_scheduler_effective_weight_upstream_cost: 0,
    // cockpit 路由策略标注(模板展示用)
    cockpit_routing_strategy: localAccess.routingStrategy ?? 'auto',
    cockpit_session_affinity: localAccess.sessionAffinity ?? false,
    cockpit_max_retry_credentials: localAccess.maxRetryCredentials ?? 0,
    cockpit_restrict_free_accounts: localAccess.restrictFreeAccounts ?? false,
    cockpit_disable_cooling: localAccess.disableCooling ?? false,
  }
}

/** cockpit stats → AccountEconomicsSnapshot(经济成本快照,本地推算)。
 *  调 costEngine.buildLocalEconomicsSnapshot 逐账号 resolveCostProfile(model.ts 1.6.0 算子)。
 *  actual.billed_usd = totals.estimatedCostUsd(真实 API 产出成本)。
 *  account_cost_usd = billed_usd（cockpit 源例外：cockpit 无独立上游成本口径,account_cost 暂同 billed(API 产出)口径）。
 *  procurement = 默认价推算(有 meta 的账号用真实 created_at;186 无 meta 用 stats.since)。
 *  impairment_loss_cny = 0(cockpit 无封禁退款账本,真缺)。
 *  projection.confidence = 'unavailable'(cockpit 无稳定区间采样)。
 *  health = accounts 成功/失败派生。 */
export function cockpitStatsToEconomics(
  stats: CockpitStats,
  range: CostCenterRange,
  cnyPerUsd: number,
  accountMeta?: Map<string, CockpitCodexAccount>,
  costMultiplier?: number,
  pricing?: Record<string, CockpitPricedModel>,
  /** 单请求用量库按观察窗口的聚合;有则 billed 与 series 走精确口径(含长上下文档位价)。 */
  requestLog?: CockpitRequestLogSummary | null,
  priceSets?: Record<string, CockpitModelPriceSet>,
): AccountEconomicsSnapshot | null {
  const accounts = stats.accounts
  if (accounts.length === 0) return null

  // 倍率兜底:未设置成本价格时用官方价格 × 倍率作为 billed 兜底(唯一实现在 costMultiplier.ts)
  const multiplier = resolveCostMultiplier(costMultiplier)
  // 2026-09-08:billed(API 产出)也由本项目按本地单价 × token 自算,不再直接吃数据源的 estimatedCostUsd。
  // 单请求用量库可用时优先用它(真实滚动窗口 + 长文本分档,精确);
  // 否则回退快照:totals 无模型维度 → 取当前 range 对应窗口的模型聚合算混合单价,再乘 totals 的 token 量。
  const rlTrend = cockpitRequestLogToCostTrend(requestLog ?? null, priceSets ?? {}, costMultiplier)
  const billedWindow = cockpitWindowForRange(stats, range)
  // 逐桶成本全桶未知 ⇒ 合计是"算不出来"(不是 0):null 传播到 LocalEconomicsInput.billedUsdTotal,
  // 由 costEngine 如实标 null(填 0 会让「号池产出/回本」宣称一个确定的产出额)。
  let billedUsd: number | null
  // ★ 2026-09-25:判据改为「**链路可用**」,不再用 `rlTrend.length`。
  //   原写法:窗口内 0 行 ⇒ 回退 `stats.totals` —— 那是**生命周期累计**(本机 186,351 请求
  //   的全部成本),于是「最近 1 分钟」的产出额显示的是全量累计。
  //   Rust 侧 `RequestLogSummary.available` 的语义就是「库存在且查询成功」
  //   (cockpit_logs_db.rs:202),与窗口内有没有行无关 ⇒ 链路可用就该吃窗口真值(0 行就是 0)。
  if (requestLog?.available) {
    billedUsd = rlTrend.reduce<number | null>(
      (sum, p) => (sum == null || p.cost == null ? null : sum + p.cost),
      0,
    )
  } else {
    const snapshotCost = cockpitAggregateCostUsd(
      stats.totals,
      cockpitBlendedTokenPrice(billedWindow?.models, pricing, costMultiplier),
      costMultiplier,
    )
    billedUsd = isUnknownCostBasis(snapshotCost.costBasis.kind) ? null : snapshotCost.cost
  }
  const now = stats.updatedAt ?? Date.now()

  // 逐账号归一化 CostAccount + health(success/failure 从 usage 派生)。
  const localAccounts = accounts.map((acc) => ({
    account: cockpitAccountToCostAccount(acc, accountMeta?.get(acc.accountId), stats.since),
    health: {
      successCount: acc.usage.successCount,
      failureCount: acc.usage.failureCount,
    },
  }))

  // series 3 点(daily/weekly/monthly 各 1 点):透传 costEngine 不改。
  // 每窗口聚合该窗口 accounts[] 健康计数(normal=成功且无失败, error=有失败)+ estimatedCostUsd/billedPerHour。
  // 3 窗口 since 跨度真实(日/周/月),驱动健康图 3 点折线(账号池规模随窗口变化)。
  // ponytail: cockpit 时序真实粒度是日/周/月快照,非分钟桶——3 点是能提供的最大健康时序。
  // 单请求用量库可用时改用它的**时间桶**序列:真正的时间序列(而不是 3 个日历累计点),
  // 且成本含长上下文档位价。注意此处 normal/error 是**请求**计数(库里没有"每桶每账号"维度),
  // 与快照口径的**账号**计数语义不同——series 只用于展示,不参与 costEngine 计算。
  // ★ 2026-09-25:同样改判「链路可用」。原写法 `rlTrend.length && cells?.length` 把
  //   「窗口内 0 行」当成「该用 3 个日历累计点」 ⇒ 短窗口的健康/产出序列画出的是
  //   daily/weekly/monthly 三个累计点,与「最近 1 分钟」的标签不符。
  if (requestLog?.available) {
    const bucketHours = requestLog.bucketHours > 0 ? requestLog.bucketHours : 1
    // 每个桶分别跟踪 known / unknown 的 cell 数:全桶算不出来 ⇒ perHour = null(不是 0);
    // 部分算不出来 ⇒ 保留求和值(它是真实下界)。
    const byBucket = new Map<number, { cost: number; known: number; unknown: number; success: number; error: number }>()
    for (const c of requestLog.cells ?? []) {
      // 带 basis 计价:算不出来时 cockpitSplitCostUsd 返的是哨兵 0,不能直接当实测成本累加。
      const priced = cockpitSplitCostUsd(c, cockpitPriceSetFor(priceSets ?? {}, c.model), costMultiplier, c.serviceTier)
      const unknown = isUnknownCostBasis(priced.costBasis.kind)
      const cur = byBucket.get(c.startMs)
      if (cur) {
        cur.cost += priced.cost
        if (unknown) cur.unknown += 1
        else cur.known += 1
        cur.success += c.success
        cur.error += c.error
      } else {
        byBucket.set(c.startMs, {
          cost: priced.cost,
          known: unknown ? 0 : 1,
          unknown: unknown ? 1 : 0,
          success: c.success,
          error: c.error,
        })
      }
    }
    const rlSeries = [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([startMs, v]) => {
        const perHour = v.unknown > 0 && v.known === 0
          ? null
          : bucketHours > 0 ? v.cost / bucketHours : null
        return {
          sampled_at: new Date(startMs).toISOString(),
          normal_count: v.success,
          rate_limited_count: 0,
          error_count: v.error,
          billed_usd_per_hour: perHour,
          account_cost_usd_per_hour: perHour,
          stable: true,
        }
      })
    return buildLocalEconomicsSnapshot({
      accounts: localAccounts,
      billedUsdTotal: billedUsd,
      cnyPerUsd,
      now,
      series: rlSeries,
      costMultiplier: multiplier,
    })
  }
  const series = [stats.daily, stats.weekly, stats.monthly]
    .filter((w): w is CockpitStatsWindow => !!w)
    .map((w) => {
      let wNormal = 0
      let wError = 0
      for (const a of (w.accounts ?? [])) {
        const u = a.usage
        if (u.failureCount > 0) wError += 1
        else if (u.successCount > 0) wNormal += 1
      }
      // ★ 2026-09-25:分母必须是快照**实际覆盖**的时长 `since → updatedAt`,
      //   不是名义的 24 / 168 / 720。源停写后 daily 快照的 `updatedAt` 停在 09-17,
      //   实际只覆盖 3.32h 却按 24h 除 ⇒ per-hour 被低估约 7×,而且会编出
      //   「窗口越大费率越低」的假规律。与 useCostCenterData 的 `cockpitWindowHours`
      //   同一条判据:**分子与分母必须同源**。
      // ⚠️ `w.since` 可能缺失 / 非有限 / 晚于 now:
      //   · 缺失 ⇒ (now - undefined) = **NaN**,而 `NaN <= 0` 为 false ⇒ 会算出
      //     `wBilled / NaN = NaN` 并写进 `billed_usd_per_hour`(NaN 比 null 更糟:它长得像数字);
      //   · 晚于 now ⇒ 负数被 `Math.max` 夹到 1/60h ⇒ 费率被放大 60×。
      // ⇒ 两种都判为「给不出分母」,返回 null 由下游走"无数据"。
      const wSince = Number(w.since)
      const wHours = Number.isFinite(wSince) && wSince > 0 && wSince < now
        ? Math.max(1 / 60, (now - wSince) / 3_600_000)
        : null
      const priced = cockpitAggregateCostUsd(
        w.totals,
        cockpitBlendedTokenPrice(w.models, pricing, costMultiplier),
        costMultiplier,
      )
      // 算不出来 ⇒ null(不是 0):billed_usd_per_hour 是数值列,0 会被读成"该窗口实测每小时零产出"。
      const wBilled = isUnknownCostBasis(priced.costBasis.kind) ? null : priced.cost
      const wBilledPerHour = wBilled == null || wHours == null || wHours <= 0 ? null : wBilled / wHours
      return {
        sampled_at: new Date(w.since).toISOString(),
        normal_count: wNormal,
        rate_limited_count: 0,
        error_count: wError,
        billed_usd_per_hour: wBilledPerHour,
        account_cost_usd_per_hour: wBilledPerHour,
        stable: true,
      }
    })

  return buildLocalEconomicsSnapshot({
    accounts: localAccounts,
    billedUsdTotal: billedUsd,
    cnyPerUsd,
    now,
    series,
    // 逐账号采购成本走兜底口径:未手动设成本档案 → 官方价 × 倍率;unknown 套餐按 Plus 官方价兜底
    costMultiplier: multiplier,
  })
}

// ──────────────────────────────────────────────────────────────────────────
// 第四轮:隐含价 fallback + 多平台账号清单
// ──────────────────────────────────────────────────────────────────────────

/** cockpit 窗口模型聚合 → 隐含单价(USD / 百万 token)。
 *  cockpit 本地 modelPricings 通常只配了少数模型(本机 2/10),其余模型"当前价格"列显示"未找到价格"。
 *  隐含价 = 该模型窗口成本 ÷ 非缓存 token(缓存命中单价 = 成本 ÷ 缓存 token),是 cockpit 内部定价的
 *  反推值——非官方价目,UI 标注"cockpit 隐含价(反推)",不编造官方价。 */
export function cockpitModelsToImpliedPricing(
  models: CockpitModelUsage[] | undefined,
  costMultiplier?: number,
): Record<string, CockpitPricedModel> {
  const result: Record<string, CockpitPricedModel> = {}
  if (!models?.length) return result
  const mult = resolveCostMultiplier(costMultiplier)
  for (const m of models) {
    const u = m.usage
    const cost = u.estimatedCostUsd * mult
    const billableTokens = Math.max(1, u.totalTokens - u.cachedTokens)
    const cachedTokens = Math.max(1, u.cachedTokens)
    if (u.totalTokens <= 0 || cost <= 0) continue
    const blendedPerMillion = (cost / billableTokens) * 1e6
    const cachedPerMillion = u.cachedTokens > 0 ? (cost / cachedTokens) * 1e6 : undefined
    result[m.modelId] = {
      found: true,
      input_price: blendedPerMillion / 1e6,
      output_price: blendedPerMillion / 1e6,
      cache_read_price: cachedPerMillion != null ? cachedPerMillion / 1e6 : undefined,
    }
  }
  return result
}

/** cockpit gemini/antigravity/claude 等平台账号清单 → Account[](仅账号实体,无用量数据)。
 *  cockpit 上游只产出 codex 用量统计(codex_local_access_stats.json),其他平台有账号无 token 级 stats——
 *  列入清单(平台 tabs/采购配置可用),用量列按 `usage_granularity` 三态诚实标注(P0-19):
 *  quota_level 走配额进度条,unavailable 显示"用量不可得",**都不显示 0%**。
 *  platform 参数直接透传 sub2api 平台枚举;plan 支持传 plan_name 原文(如 Gemini Code Assist)。 */
export interface CockpitPlatformAccountInput {
  id: string
  email?: string
  planLabel?: string
  /** cockpit 索引里的 `plan_type`,用于判 API Key 类账号(P0-19 第三态)。 */
  planType?: string
  /** 显式指定用量粒度;省略时由 `cockpitUsageGranularityOf(planType)` 推导。 */
  usageGranularity?: UsageGranularity
  createdAt?: number
  lastUsed?: number
  platform: AccountPlatform
}

export function cockpitPlatformAccountsToAccounts(
  items: CockpitPlatformAccountInput[],
): Account[] {
  return items.filter(item => item.id?.trim()).map((item) => {
    const id = accountIdToCostId(item.id)
    const createdAtIso = item.createdAt
      ? new Date(item.createdAt < 1e12 ? item.createdAt * 1000 : item.createdAt).toISOString()
      : new Date(0).toISOString()
    return {
      id,
      name: item.email || item.id,
      platform: item.platform,
      type: 'oauth' as AccountType,
      credentials: undefined,
      // plan 原文塞 extra.cockpit_plan_label(UI 可显示原文);plan_type 不塞(inferPlan 不认识
      // "Gemini Code Assist..."会落 unknown,由 resolveCostProfile default 走,诚实)
      // P0-19:旧的 cockpit_platform_no_usage 已废弃(它基于"非 codex 无用量"这个被推翻的结论),
      // 改为三态 usage_granularity —— 有配额 ≠ 无用量。
      extra: {
        usage_granularity: item.usageGranularity ?? cockpitUsageGranularityOf(item.planType),
        ...(item.planLabel ? { cockpit_plan_label: item.planLabel } : {}),
      },
      proxy_id: null,
      concurrency: 0,
      // 非 codex 平台账号(gemini / antigravity / claude)同样**没有优先级概念**,
      // 且本函数不接收 routingRules ⇒ 源根本没表达过优先级 ⇒ 置 null(UI 显示 —)。
      // 此前硬编码 1 会被模板渲染成「1 · 正常」—— 与 cockpitPriority 无规则时的假值同型
      // (2026-09-20 修正,此前只修了 codex 那条路径,漏了这一条)。
      priority: null,
      scheduler_score: null,
      status: 'active',
      error_message: null,
      rate_limited_at: null,
      rate_limit_reset_at: null,
      last_used_at: item.lastUsed ? new Date(item.lastUsed < 1e12 ? item.lastUsed * 1000 : item.lastUsed).toISOString() : null,
      expires_at: null,
      auto_pause_on_expired: false,
      created_at: createdAtIso,
      updated_at: createdAtIso,
      schedulable: true,
      overload_until: null,
      temp_unschedulable_until: null,
      temp_unschedulable_reason: null,
      session_window_start: null,
      session_window_end: null,
      session_window_status: null,
    } as Account
  })
}

// ──────────────────────────────────────────────────────────────────────────
// 用量台账:cockpit 移除 API/账号会清数据、重新加入从 0 计数——成本端不能丢。
// 每次 reload 快照 stats.accounts(含孤儿)到本地 JSON;加载时回填被清零的回归账号、
// 注入 stats 中已完全消失的账号(走 cockpit_historical 显示"已移出当前池")。
// 纯函数:输入输出都是数据,invoke 落盘在 api/cockpit + 视图胶水层。
// ──────────────────────────────────────────────────────────────────────────

/** 台账/当前都是只增累计器,逐字段取历史最大:
 *  cockpit 清零回退 → 取台账值(防丢);正常增长 → 取当前值(防台账重复累加)。 */
function ledgerMaxUsage<T extends CockpitUsageStats>(current: T, stored: CockpitUsageStats): T {
  const merged: T = { ...current }
  const target = merged as Record<string, unknown>
  for (const key of Object.keys(stored) as (keyof CockpitUsageStats)[]) {
    const v = Number(stored[key] ?? 0)
    if (!Number.isFinite(v)) continue
    if (v > Number(target[key] ?? 0)) {
      target[key] = v
    }
  }
  return merged
}
/** stats.accounts(含孤儿——被移出池的正是要保住的) → 台账快照条目。
 *  无 email 的账号跳过(email 是重建前后的稳定键,没有它无法关联)。 */
export function snapshotCockpitLedger(stats: CockpitStats): CockpitLedgerEntry[] {
  const now = stats.updatedAt ?? Date.now()
  const entries: CockpitLedgerEntry[] = []
  for (const acc of stats.accounts) {
    if (!acc.email) continue
    entries.push({
      email: acc.email,
      updatedAt: acc.usage?.updatedAt ?? now,
      usage: { ...acc.usage },
    })
  }
  return entries
}

/** 应用台账(在 loadFromCockpit 之前调用,原地修改 stats.accounts):
 *  1. 回归回填:同 email 台账值 > 当前值(cockpit 重加账号清零)→ 逐字段回填当前账号 usage;
 *  2. 注入历史行:email 在 stats 完全不存在(账号文件被删且孤儿被清)→ 注入合成账号
 *     accountId=`cockpit:ledger-email:<encoded email>`(显式标记历史 email 身份;无 meta →
 *     cockpit_historical,UI 显示"已移出当前池",采购列显示"—"不计入当前池)。
 *  返回合并后的完整台账条目(存量∪当前快照,已裁剪至上限),供调用方持久化。
 *  双计防护:注入仅针对 stats 中不存在的 email;stats 已保留的孤儿只做 max 合并,不重复注入。 */
export function applyCockpitUsageLedger(
  stats: CockpitStats,
  ledger: CockpitLedgerEntry[] | null | undefined,
): CockpitLedgerEntry[] {
  const stored = new Map<string, CockpitLedgerEntry>()
  for (const e of ledger ?? []) {
    if (e?.email) stored.set(e.email, e)
  }
  const seen = new Set<string>()
  const now = Date.now()
  for (const acc of stats.accounts) {
    if (!acc.email) continue
    seen.add(acc.email)
    const prev = stored.get(acc.email)
    if (prev) {
      acc.usage = ledgerMaxUsage(acc.usage, prev.usage)
      stored.set(acc.email, { email: acc.email, updatedAt: now, usage: { ...acc.usage } })
    } else {
      stored.set(acc.email, {
        email: acc.email,
        updatedAt: acc.usage?.updatedAt ?? stats.updatedAt ?? now,
        usage: { ...acc.usage },
      })
    }
  }
  for (const e of stored.values()) {
    if (seen.has(e.email)) continue
    const account: LedgerStatsAccount = {
      accountId: `cockpit:ledger-email:${encodeURIComponent(e.email)}`,
      costIdentityKind: 'ledger-email',
      email: e.email,
      usage: { ...e.usage, updatedAt: e.updatedAt },
    }
    stats.accounts.push(account)
  }
  const merged = [...stored.values()]
  if (merged.length > COCKPIT_LEDGER_CAP) {
    merged.sort((a, b) => b.updatedAt - a.updatedAt)
    merged.length = COCKPIT_LEDGER_CAP
  }
  return merged
}
