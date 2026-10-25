import { costDataText } from './costDataText'
import type { AccountType } from '@/types'
import type { Channel, ChannelModelPricing } from '@/api/admin/channels'
import { accountCostSnapshot, classifyModelProvider, sumTokenCounts, uniqueUsageLogs } from './modelCostAnalysis'
import type { MonitorCostEstimate, PriceEvidence } from '@/api/usageMonitor'
import type { CostAccountId, SourceAdminUsageLog as AdminUsageLog } from './sourceTypes'

export interface RoutePriceEvidence extends PriceEvidence {
  quoteKind: 'reference' | 'scenario'
  /** Reference amount used by this row, not proof of actual mode or a paid bill. */
  usedForCost: boolean
  scenarioKey?: string | null
}

export function routeEvidenceFromQuote(quote: MonitorCostEstimate | undefined, usedForCost = true): RoutePriceEvidence[] {
  if (!quote) return []
  return [
    ...(quote.evidence ? [{ ...quote.evidence, quoteKind: 'reference' as const, usedForCost: usedForCost && quote.usd != null && Number.isFinite(quote.usd) }] : []),
    ...(quote.scenarios ?? []).map(scenario => ({ ...scenario.evidence, quoteKind: 'scenario' as const, usedForCost: false, scenarioKey: scenario.scenarioKey })),
  ]
}

export function mergeRoutePriceEvidence(...lists: Array<readonly RoutePriceEvidence[] | undefined>): RoutePriceEvidence[] {
  const entries = new Map<string, RoutePriceEvidence>()
  for (const list of lists) for (const item of list ?? []) {
    const key = JSON.stringify([
      item.pricingProvider, item.model, item.mode, item.contextTier, item.currency ?? 'USD',
      item.inputPerMillion, item.cachedPerMillion, item.cacheWritePerMillion,
      item.cacheWrite5mPerMillion, item.cacheWrite1hPerMillion, item.outputPerMillion,
      item.timeBand, item.quoteKind, item.usedForCost, item.scenarioKey,
      item.catalogRevision ?? item.version, item.pricingBasis, item.ruleVersion, item.sourceUrl,
    ])
    if (!entries.has(key)) entries.set(key, item)
  }
  return [...entries.values()]
}

export interface ModelRouteRow {
  key: string
  requestedModel: string
  /**
   * 实际发往上游的模型。
   *
   * **可空 = 源不提供逐请求的上游模型**。例如 cockpit 的 `request_logs` 只有 `model_id`
   * （客户端请求的模型），没有任何"这个请求发往上游时用的是哪个模型"的字段
   * （见 cockpit-tools-main/src-tauri/src/modules/codex_local_access_request_logs.rs 的建表语句）。
   * 这种情况下**不得回退成 requestedModel** —— 那会让界面显示 `gpt-5 → gpt-5`，
   * 暗示"实测到上游也是 gpt-5"，而实际上我们并不知道。应显示「未记录」。
   *
   * 注意：价格查找等需要模型名的地方请显式用 `upstreamModel ?? requestedModel` 兜底，
   * 不要在这里把 null 悄悄填成 requestedModel。
   */
  upstreamModel: string | null
  upstreamResponseModel: string
  upstreamModelMismatch: boolean | null
  modelAuditStatus: 'matched' | 'mismatch' | 'unobserved'
  mappingChain: string
  provider: string
  accountId: CostAccountId | null
  accountName: string
  accountType: AccountType | null
  channelId: number | null
  channelName: string
  groupId: number | null
  groupName: string
  /** 分组来源标注(可选)。cockpit 的「分组」来自账号分组文件(非 sub2api 计费分组),
   *  填此字段让表格副标题如实说明来源,避免被误读。sub2api 行不填。 */
  groupLabel?: string
  inboundEndpoint: string
  upstreamEndpoint: string
  channelPricing: ChannelModelPricing | null
  priceEvidence?: RoutePriceEvidence[]
  requests: number
  failedRequests?: number
  zeroTokenRequests?: number
  failedZeroTokenRequests?: number
  totalTokens?: number | null
  accountIdentitySource?: 'management' | 'usage_only' | 'unattributed'
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens?: number | null
  outputTokens: number | null
  /** 标准计费成本。null = 该数据源不掌握逐请求成本(如 cockpit 的 codex-api 日志回退路径,
   *  源侧既无 token 也无成本,且按窗口均摊回填未命中)。显示层渲染「无数据」而不是 $0.000000。 */
  standardCost: number | null
  /** 账号侧成本。null 语义同 standardCost。 */
  accountCost: number | null
  /** Known subtotal when the complete amount is unavailable. */
  knownStandardCost?: number
  knownAccountCost?: number
  /** 用户计费(营收)。null = 该数据源不掌握营收(cockpit),渲染「—」而不是 0。 */
  revenue: number | null
  /** 成本口径说明:sub2api 逐请求快照留空;cockpit 按模型窗口均摊时填说明文案 */
  costBasis?: string
  /** 成本是否"算不出来"(既无本地单价、数据源也没给估算)。
   *  true 时 standardCost / accountCost 恒为 null —— 计价函数在这种情形下返回的是**哨兵 0**
   *  (costBasis.ts `noPriceNoEstimateCost`:cost 恒 0,只带 basis 标注),那个 0 不是实测成本,
   *  写进数值列会被渲染成 $0.000000,与"实测成本为零"无从区分。显示层须渲染「成本未知」。 */
  costUnknown?: boolean
  firstSeen: string
  lastSeen: string
}

/** null/空/非有限 → null(表示"无此数据")。 */
function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function text(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

function modelPatternMatches(model: string, pattern: string): boolean {
  const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return escaped !== '' && new RegExp(`^${escaped}$`, 'i').test(model)
}

function findChannelPricing(channel: Channel | undefined, model: string): ChannelModelPricing | null {
  if (!channel) return null
  return channel.model_pricing.find((pricing) => pricing.models.some((pattern) => modelPatternMatches(model, pattern))) ?? null
}

export function buildModelRouteRows(logs: AdminUsageLog[], channels: Channel[]): ModelRouteRow[] {
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]))
  const channelById = new Map(channels.map((channel) => [channel.id, channel]))
  const rows = new Map<string, ModelRouteRow>()

  for (const log of uniqueUsageLogs(logs)) {
    const requestedModel = text(log.model, costDataText('unknownRequestedModel'))
    // 源不提供逐请求上游模型时保持 null，**不得回退成 requestedModel** ——
    // 那会让界面显示 `gpt-5 → gpt-5`，暗示"实测到上游也是 gpt-5"，而我们并不知道。
    const rawUpstreamModel = text(log.upstream_model, '')
    const upstreamModel: string | null = rawUpstreamModel ? rawUpstreamModel : null
    const upstreamResponseModel = text(log.upstream_response_model, '')
    const upstreamModelMismatch = log.upstream_model_mismatch == null ? null : Boolean(log.upstream_model_mismatch)
    const modelAuditStatus = upstreamModelMismatch == null
      ? 'unobserved'
      : upstreamModelMismatch ? 'mismatch' : 'matched'
    const accountId = log.account_id ?? null
    const channelId = log.channel_id == null ? null : Number(log.channel_id)
    const groupId = log.group_id == null ? null : Number(log.group_id)
    const inboundEndpoint = text(log.inbound_endpoint, costDataText('notRecorded'))
    const upstreamEndpoint = text(log.upstream_endpoint, costDataText('notRecorded'))
    const key = JSON.stringify([requestedModel, upstreamModel, upstreamResponseModel, modelAuditStatus, accountId, channelId, groupId, inboundEndpoint, upstreamEndpoint])
    // total_cost 为 null = 源不掌握逐请求成本。**不得用 numeric(null)=0 冒充"成本为零"** ——
    // 汇总后渲染 $0.000000,与"实测成本为零"无从区分。
    const rawStandardCost = nullableNumber(log.total_cost)
    const accountCost = accountCostSnapshot(log)
    const existing = rows.get(key)
    // 营收(cockpit 下为 null)不可知时保持 null,不用 0 冒充"营收为零"。
    const rowRevenue = nullableNumber(log.actual_cost)
    const inputTokens = nullableNumber(log.input_tokens)
    const cacheReadTokens = nullableNumber(log.cache_read_tokens)
    const cacheCreationTokens = nullableNumber(log.cache_creation_tokens)
    const outputTokens = nullableNumber(log.output_tokens)
    const totalTokens = sumTokenCounts(inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens)

    if (existing) {
      existing.requests += 1
      existing.inputTokens = sumTokenCounts(existing.inputTokens, inputTokens)
      existing.cacheReadTokens = sumTokenCounts(existing.cacheReadTokens, cacheReadTokens)
      existing.cacheCreationTokens = sumTokenCounts(existing.cacheCreationTokens, cacheCreationTokens)
      existing.outputTokens = sumTokenCounts(existing.outputTokens, outputTokens)
      existing.totalTokens = sumTokenCounts(existing.totalTokens, totalTokens)
      // 任一分量为 null ⇒ 合计为 null(未知 + 已知 != 已知),不用 0 补齐。
      existing.standardCost = existing.standardCost == null || rawStandardCost == null
        ? null
        : existing.standardCost + rawStandardCost
      existing.accountCost = existing.accountCost == null || accountCost == null
        ? null
        : existing.accountCost + accountCost
      existing.revenue = existing.revenue == null || rowRevenue == null ? null : existing.revenue + rowRevenue
      if (log.created_at < existing.firstSeen) existing.firstSeen = log.created_at
      if (log.created_at > existing.lastSeen) existing.lastSeen = log.created_at
      continue
    }

    rows.set(key, {
      key,
      requestedModel,
      upstreamModel,
      upstreamResponseModel,
      upstreamModelMismatch,
      modelAuditStatus,
      mappingChain: text(
        log.model_mapping_chain,
        // 上游模型未记录时，不能编一条 `gpt-5 → gpt-5` 的映射链出来。
        upstreamModel == null ? costDataText('notRecorded') : requestedModel === upstreamModel ? costDataText('noMapping') : `${requestedModel} → ${upstreamModel}`,
      ),
      provider: classifyModelProvider(upstreamModel ?? requestedModel),
      accountId,
      accountName: text(log.account?.name, accountId == null ? costDataText('deletedAccountHistorical') : costDataText('account', { p0: accountId })),
      accountType: (log.account as { type?: AccountType } | undefined)?.type ?? null,
      channelId,
      channelName: channelId == null ? text(log.upstream_endpoint, costDataText('directAccountNoChannel')) : text(channelNames.get(channelId), costDataText('channel', { p0: channelId })),
      groupId,
      groupName: text(log.group?.name, log.group_id == null ? costDataText('ungrouped') : costDataText('group', { p0: log.group_id })),
      inboundEndpoint,
      upstreamEndpoint,
      // 渠道单价是按模型名查的,这里需要模型名 ⇒ 回退到请求模型;展示侧不回退(见 upstreamModel 注释)。
      channelPricing: channelId == null ? null : findChannelPricing(channelById.get(channelId), upstreamModel ?? requestedModel),
      requests: 1,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens,
      totalTokens,
      standardCost: rawStandardCost,
      accountCost,
      revenue: rowRevenue,
      firstSeen: log.created_at,
      lastSeen: log.created_at,
    })
  }

  // accountCost 为 null = 该行成本不可知(均摊回填未命中),排在有值行之后,不当 0 参与比较。
  return [...rows.values()].sort((left, right) => {
    if (left.accountCost == null && right.accountCost == null) return right.requests - left.requests
    if (left.accountCost == null) return 1
    if (right.accountCost == null) return -1
    return right.accountCost - left.accountCost || right.requests - left.requests
  })
}

/**
 * 路由明细表「标准 / 账号成本」列的**口径说明**。
 *
 * ★ 2026-09-26:此前模板一律写死「请求快照」,但只有 sub2api 的 usage_logs 真的是逐请求成本快照 ——
 *   cockpit 的两条链路都带 `costBasis`(cockpitAdapter.ts:1215「同模型同账号内按请求数分摊」、
 *   :2058「按模型窗口用量均摊(日志无逐请求 token)」),cliproxy 是按 usage_events 事件用 LiteLLM
 *   单价估算后按 model + auth_index 聚合。把它们一律标成「请求快照」是**假口径**。
 *
 * ★ 措辞必须**三态穷举**(`null` / `'cliproxy'` / 兜底),禁止 `A ? x : y` —— 那会把"非 cockpit"
 *   一律当 sub2api、无视 cliproxy 是第三个源(该病根已复发 4 次)。
 *
 * 行自带 `costBasis` 时以它为准(更具体);否则按源兜底。纯函数,由测试直测。
 */
export function routeCostBasisLabel(row: ModelRouteRow, connectionType: string | null): string {
  if (row.costBasis) return row.costBasis
  if (connectionType === null) {
    return costDataText('cockpitRequestStoreCalculationAllocatedByRequestCountWithin')
  }
  if (connectionType === 'cliproxy') {
    return costDataText('litellmPriceEstimateGroupedByModelAuthIndexCpa')
  }
  return costDataText('usageLogsPerRequestCostSnapshot')
}
