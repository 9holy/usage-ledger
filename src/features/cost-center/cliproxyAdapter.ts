import { costDataText } from './costDataText'
/**
 * CPA Token Usage 插件数据 → useCostCenterData store 适配层
 *
 * 数据源(直读插件本地文件,非 cliproxy /v0/management):
 * - usage_events 表(完整历史用量 1629+ 行,30 天窗口,真实时序+ops)
 * - model_prices.cache(LiteLLM 3213 模型 per-token USD 官方定价)
 *
 * 调统一本地成本引擎 buildLocalEconomicsSnapshot(model.ts→costEngine.ts),
 * 让 cliproxy 复用 sub2api 同套深色成本控制台模板(accountLedgers/economics/KPI)。
 *
 * 数据边界(诚实标注):
 * - 成本 = usage_events token × model_prices.cache per-token 反算(LiteLLM 官方定价,估算非事实账单)
 * - 账号 = auth_index 聚合(CPA 无账号实体,auth_index 是认证文件/key 标识),created_at 用最早 requested_at
 * - 时序 = requested_at 按桶聚合(真实时序,非单点快照)
 * - ops = latency_ms/ttft_ms/failed/status_code 真实(CPA 持续采集)
 * - 无 plan_type → inferPlan 返 unknown → default 价 0,标 estimated
 */

import type { CliproxyUsageEvent, LitellmPricing } from '@/api/cliproxy/cpaData'
import { cliproxyTokenBreakdown } from '@/api/cliproxy/cpaData'
import type { AccountPlatform, AccountType, AccountUsageInfo } from '@/types'
import type { SourceAccount as Account, SourceModelStat as ModelStat } from './sourceTypes'
import { localCostAccountId } from './accountIdentity'
import { quotaTimestamp, type RecordedQuotaProgress } from './quotaWindowState'
import type { CostTrendDataPoint } from './usageWindow'
import type { CostCenterRange } from './useCostCenterData'
import type { OpsDashboardOverview, OpsThroughputTrendPoint, OpsErrorTrendPoint } from '@/api/admin/ops'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'
import type { ModelDefaultPricing } from '@/api/admin/channels'
import type { AccountWindowUsage, CostAccount } from './model'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from './model'
import { resolveCostMultiplier } from './costMultiplier'
import { isUnknownCostBasis, noPriceNoEstimateCost, pricedCost, type PricedCost } from './costBasis'
import { buildLocalEconomicsSnapshot } from './costEngine'
import { finiteOrNull } from './honestValues'
// 档位标签复用 cockpit 的同一张映射表:同一档位在 cockpit / cliproxy 必须同名,
// 否则"三源不对称"会从"缺维度"变成"同一维度两个叫法"。
import { reasoningEffortLabel } from '@/api/cockpit/facets'

/** Source auth_type is independent of the opaque runtime auth_index. */
export function cliproxyAuthTypeToAccountType(authType: string | undefined): AccountType | null {
  const type = (authType ?? '').toLowerCase().replace(/[_\s-]/g, '')
  if (type === 'apikey') return 'apikey'
  if (type === 'oauth' || type === 'oauth2') return 'oauth'
  if (type === 'setuptoken') return 'setup-token'
  if (type === 'serviceaccount') return 'service_account'
  return null
}

/**
 * 倍率兜底唯一入口。**实现已上移到 costMultiplier.ts**(架构设计 【F】7.1 / P0-16),
 * 这里 re-export 同名函数,保证既有 `import { resolveCostMultiplier } from './cliproxyAdapter'`
 * (cliproxyManagementAdapter 等)不炸。
 */
export { resolveCostMultiplier } from './costMultiplier'
import { TREND_BUCKET_MILLISECONDS, usageWindowBounds } from './usageWindow'

export function cliproxyUsageWindowBounds(range: CostCenterRange, queryNow = new Date()) {
  const bounds = usageWindowBounds(range, queryNow)
  return { start: bounds.start, end: new Date(Math.min(queryNow.getTime(), bounds.end.getTime())) }
}

/** The fixed local plugin is only attributable to the existing default local gateway. */
export function isLocalCliproxyTarget(base: string): boolean {
  try {
    const url = new URL(base, 'http://127.0.0.1:8317')
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.port === '8317' && ['/', '/v0/management', '/v0/management/'].includes(url.pathname)
  } catch {
    return false
  }
}

/** Preserve the complete opaque runtime identity and isolate it from other sources. */
export function authIndexToAccountId(authIndex: string): string {
  return localCostAccountId('cliproxy', authIndex)
}

/** cliproxy model → AccountPlatform(按真实模型商/厂商分类)。
 *  优先用 LiteLLM litellm_provider(真实厂商,zai=智谱/dashscope=阿里/moonshot=月之暗面/deepseek/minimax),
 *  无 vendor 时按 model 前缀(glm→智谱/qwen→千问/deepseek→深度求索/kimi→月之暗面/minimax/grok/claude)。
 *  provider 字段是 SQLite GBK 乱码不可靠,仅作兜底。 */
export function cliproxyProviderToPlatform(
  provider: string,
  model: string,
  vendorMap?: Record<string, string>,
): AccountPlatform {
  const m = (model || '').toLowerCase()
  const lcModel = m
  // 1. 优先用 LiteLLM litellm_provider(真实厂商)反查
  if (vendorMap) {
    const vendor = vendorMap[model] || vendorMap[lcModel] || vendorMap[lcModel.replace(/^(fw-|chat-|completions-)/, '')]
    if (vendor) {
      const v = vendor.toLowerCase()
      // litellm_provider 可能带前缀(vertex_ai-qwen_models),取最后厂商段
      const vendorSeg = v.split('-').pop() || v
      if (v.includes('zai') || v.includes('glm')) return 'zai' // 智谱
      if (v.includes('dashscope') || v.includes('qwen') || v.includes('aliyun')) return 'dashscope' // 阿里通义千问
      if (v.includes('moonshot') || v.includes('kimi')) return 'moonshot'
      if (v.includes('deepseek')) return 'deepseek'
      if (v.includes('minimax')) return 'minimax'
      if (v.includes('volcengine') || v.includes('doubao') || v.includes('ark')) return 'volcengine'
      if (v.includes('sensenova') || v.includes('shangtang')) return 'sensenova' // 商汤日日新
      if (v.includes('anthropic') || v.includes('claude')) return 'anthropic'
      if (v.includes('openai') || v.includes('azure')) return 'openai'
      if (v.includes('gemini')) return 'gemini'
      if (v.includes('grok') || v.includes('xai')) return 'grok'
      if (v.includes('antigravity')) return 'antigravity'
      void vendorSeg
    }
  }
  // 2. model 前缀兜底(无 vendor 时)
  if (m.startsWith('glm-') || m.includes('glm-')) return 'zai' // 智谱
  if (m.includes('qwen')) return 'dashscope' // 阿里通义千问
  if (m.includes('deepseek')) return 'deepseek'
  if (m.includes('kimi') || m.includes('moonshot')) return 'moonshot'
  if (m.includes('minimax')) return 'minimax'
  if (m.includes('sensenova')) return 'sensenova' // 商汤
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'anthropic'
  if (m.includes('grok')) return 'grok'
  if (m.includes('gemini')) return 'gemini'
  if (m.includes('antigravity')) return 'antigravity'
  // 3. provider 关键字兜底(GBK 乱码时可能不匹配)
  const p = (provider || '').toLowerCase()
  if (p.includes('gemini')) return 'gemini'
  if (p.includes('claude') || p.includes('anthropic')) return 'anthropic'
  if (p.includes('grok') || p.includes('xai')) return 'grok'
  if (p.includes('antigravity')) return 'antigravity'
  // codex/openai/openai-compatibility 等归 openai
  return 'openai'
}

/** Offline fallback uses an exact identity, never suffixes or guessed routing aliases. */
export function resolveModelPricing(model: string, prices: Record<string, LitellmPricing>): LitellmPricing | undefined {
  return model ? prices[model] : undefined
}

/**
 * 单事件成本反算(标注型空值):tokens × LiteLLM per-token USD。
 *
 * 无匹配单价时**不静默返 0**,而是 `{ cost: 0, basis: { kind: 'no_price_no_estimate' } }`
 * ——下游(和 UI)必须能区分"算出来是 0"与"根本算不出"(P0-17)。
 */
export function pricedEventCostUsd(
  event: CliproxyUsageEvent,
  pricing: LitellmPricing | undefined,
): PricedCost {
  if (event.priceQuote) {
    if (event.priceQuote.usd != null && Number.isFinite(event.priceQuote.usd)) {
      return { ...pricedCost(event.priceQuote.usd), label: costDataText('namedProviderReferencePriceNotProcurementPayment', { p0: event.priceQuote.evidence?.catalogRevision ? 'models.dev' : costDataText('savedQuote') }) }
    }
    return noPriceNoEstimateCost(costDataText('cpaHasNoDefiniteSingleQuoteScenariosAndEvidence', { p0: event.priceQuote.reason ?? costDataText('incompleteQuoteConditions') }))
  }
  if (!pricing) return noPriceNoEstimateCost(costDataText('cpaHasNoMatchingUnitPriceForThisModel'))
  const actualMode = event.response_service_tier
  const priority = actualMode === 'priority' || actualMode === 'fast'
  const differentPriority = [
    [pricing.input_cost_per_token_priority, pricing.input_cost_per_token],
    [pricing.output_cost_per_token_priority, pricing.output_cost_per_token],
    [pricing.cache_read_input_token_cost_priority, pricing.cache_read_input_token_cost],
    [pricing.cache_creation_input_token_cost_priority, pricing.cache_creation_input_token_cost],
  ].some(([priorityRate, standardRate]) => priorityRate != null && priorityRate !== standardRate)
  if ((!actualMode && differentPriority) || (actualMode && !['standard', 'default', 'priority', 'fast'].includes(actualMode))) {
    return noPriceNoEstimateCost(costDataText('cpaActualBillingModeIsUnknownStandardPricesOr'))
  }
  const tokens = cliproxyTokenBreakdown(event)
  if (tokens.inputTokens == null || tokens.outputTokens == null || tokens.inputTokens < (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0)) return noPriceNoEstimateCost(costDataText('cpaInputCacheSemanticsAreIncompleteOrInconsistent'))
  const inputRate = priority
    ? pricing.input_cost_per_token_priority
    : pricing.input_cost_per_token
  const outputRate = priority
    ? pricing.output_cost_per_token_priority
    : pricing.output_cost_per_token
  // 单价行**存在**但 input/output 档缺失时,原先的 `?? 0` 会把成本算成 `$0`,而
  // `cliproxyEventsPricedCost` 按「匹配到了单价」标注为 `priced` ⇒ 界面显示 `$0` 成本,
  // 等于声称「这个模型不要钱」。这是标注型空值该覆盖的形态:宁可说「算不出」也不静默给 0。
  //
  // 判定**按需**:只有当该事件**确实消耗了**该类 token 却拿不到单价时才算「算不出」。
  // 不按需(见 cliproxyCostEstimate.ts 的 `costForRecord`,那里是**死代码**,文档化约定为
  // 「缺省字段按 0 处理」且被 noSilentZero.spec.ts 钉住)会把「output_tokens=0 且无 output 价」
  // 这种正常情形也判成算不出,过严。
  //
  // 实测 LiteLLM 表 4318 条里有 668 条缺 input/output(全是按张计价的图片模型;本代理是文本
  // 代理,故当前不可达),这条守卫是为该路径留的护栏,由 cliproxyAdapter 单测的合成夹具覆盖。
  if (
    (tokens.inputTokens - tokens.cacheReadTokens! - tokens.cacheWriteTokens! > 0 && !Number.isFinite(inputRate)) ||
    (tokens.outputTokens! > 0 && !Number.isFinite(outputRate))
  ) {
    return noPriceNoEstimateCost(costDataText('cpaModelPricesLackTheInputOutputTierUnknown'))
  }
  const cacheReadRate = priority
    ? pricing.cache_read_input_token_cost_priority
    : pricing.cache_read_input_token_cost
  const cacheCreateRate = priority
    ? pricing.cache_creation_input_token_cost_priority
    : pricing.cache_creation_input_token_cost
  if ((tokens.cacheReadTokens! > 0 && !Number.isFinite(cacheReadRate)) || (tokens.cacheWriteTokens! > 0 && !Number.isFinite(cacheCreateRate))) return noPriceNoEstimateCost(costDataText('cpaRecordedCacheUsageButLacksItsUnitPrice'))
  // 走到这里说明「该档没被用到」或「该档有价」。没被用到的档必须显式落 0 ——
  // 直接乘 `undefined` 会得到 `NaN`(0 × undefined = NaN),NaN 会污染整批合计。
  const safeInputRate = finiteOrNull(inputRate) ?? 0
  const safeOutputRate = finiteOrNull(outputRate) ?? 0
  const input = (tokens.inputTokens - tokens.cacheReadTokens! - tokens.cacheWriteTokens!) * safeInputRate
  const output = tokens.outputTokens! * safeOutputRate
  const cacheRead = tokens.cacheReadTokens! * (cacheReadRate ?? 0)
  const cacheCreate = tokens.cacheWriteTokens! * (cacheCreateRate ?? 0)
  return { ...pricedCost(input + output + cacheRead + cacheCreate), label: costDataText('litellmOfflineExactModelReferencePriceNotProcurementPayment') }
}

/** 单事件成本(数值)。兼容层:只想要 number 的调用点用这个,但需要"是否算不出"时应改用 pricedEventCostUsd。 */
export function eventCostUsd(event: CliproxyUsageEvent, pricing: LitellmPricing | undefined): number {
  return pricedEventCostUsd(event, pricing).cost
}

/**
 * 一批 events 的合计成本(标注型空值)。
 * - 全部事件都没匹配到单价 → `no_price_no_estimate`(不是 0);
 * - 部分没匹配 → `source_estimate` 并在 label 里写明"部分请求无单价";
 * - 全部匹配 → `priced`。
 */
export function cliproxyEventsPricedCost(
  events: CliproxyUsageEvent[],
  prices: Record<string, LitellmPricing>,
  costMultiplier?: number,
): PricedCost & { pricedEvents: number; unpricedEvents: number } {
  const multiplier = resolveCostMultiplier(costMultiplier)
  let cost = 0
  let pricedEvents = 0
  let unpricedEvents = 0
  for (const ev of events) {
    const priced = pricedEventCostUsd(ev, resolveModelPricing(ev.model, prices))
    if (priced.basis.kind === 'no_price_no_estimate') unpricedEvents += 1
    else pricedEvents += 1
    cost += priced.cost * multiplier
  }
  if (pricedEvents === 0) {
    return {
      ...noPriceNoEstimateCost(costDataText('allCpaRequestsLackMatchingUnitPricesUnknownCost')),
      pricedEvents,
      unpricedEvents,
    }
  }
  if (unpricedEvents > 0) {
    return {
      ...pricedCost(cost, costDataText('cpaRequestsLackMatchingPricesKnownPricedPortionsIncluded', { p0: unpricedEvents })),
      basis: { kind: 'source_estimate' },
      pricedEvents,
      unpricedEvents,
    }
  }
  return { ...pricedCost(cost), pricedEvents, unpricedEvents }
}

/** 倍率兜底统一口:costMultiplier 非法(空/≤0)时回退 DEFAULT_COST_MULTIPLIER,语义 = 官方价反算成本 × 用户倍率。 */

/** 全量 events × prices 反算总成本 USD(供 useUnifiedCost 三端汇总复用,与 cliproxyEventsToEconomics 同口径)。
 *  costMultiplier:未手动设置成本价格时官方价 × 倍率兜底(与 economics/todayStats 同口径)。 */
export function cliproxyEventsTotalCost(events: CliproxyUsageEvent[], prices: Record<string, LitellmPricing>, costMultiplier?: number): number {
  const multiplier = resolveCostMultiplier(costMultiplier)
  let total = 0
  for (const ev of events) {
    total += eventCostUsd(ev, resolveModelPricing(ev.model, prices)) * multiplier
  }
  return total
}

/** CPA events → 每厂商(platform)的 model 集合 + 请求数,供分组 tabs(保证小众厂商 sensenova 也显示)。
 *  分组按 model 厂商,与账号 auth_index 无关——一个账号用多 model 时各厂商都计数,不被 topModel 吞。 */
export function cliproxyEventsToVendorStats(
  events: CliproxyUsageEvent[],
  vendorMap?: Record<string, string>,
): Record<string, { models: Set<string>; requests: number }> {
  const result: Record<string, { models: Set<string>; requests: number }> = {}
  for (const ev of events) {
    const platform = cliproxyProviderToPlatform(ev.provider, ev.model, vendorMap)
    if (!result[platform]) result[platform] = { models: new Set(), requests: 0 }
    result[platform].models.add(ev.model)
    result[platform].requests += 1
  }
  return result
}

export interface CliproxyReasoningEffortRow {
  /** 真实档位取值;未记录档位恒为 '' */
  key: string
  label: string
  count: number
  /** 占**有记录档位**请求数的比例;没有可作分母的样本时为 null(不是 0) */
  share: number | null
  /** true = 上游未记录档位(空串),不是一个档位 */
  isUnrecorded: boolean
}

/**
 * 推理档位分布(CPA `usage_events.reasoning_effort`)。
 *
 * ★ 空串语义:`reasoning_effort` 类型是非空 `string`,但实测夹具里既有 'medium' 也有 ''。
 *   空串表示**上游没记录档位**,不是一个档位 —— 必须单列,不得并进任何真实档位,
 *   也不得因为"没有档位"而显示成 0。
 * ★ 占比分母只用**有记录档位**的请求数:未记录的不参与档位占比,否则会稀释每一档。
 * ★ 未知取值原样作标签(与 `errorCategoryLabel` / `requestKindLabel` 同约定),不猜中文名;
 *   标签映射复用 cockpit 的 `reasoningEffortLabel`,保证三源同一档位同名。
 */
export function cliproxyEventsToReasoningEfforts(
  events: CliproxyUsageEvent[],
  range?: CostCenterRange,
  queryNow = new Date(),
): CliproxyReasoningEffortRow[] {
  const counts = new Map<string, number>()
  let unrecorded = 0
  const window = range ? cliproxyUsageWindowBounds(range, queryNow) : null
  const startMs = window?.start.getTime(), endMs = window?.end.getTime()
  for (const ev of events) {
    if (startMs != null && endMs != null && (ev.requested_at < startMs || ev.requested_at >= endMs)) continue
    const raw = typeof ev.reasoning_effort === 'string' ? ev.reasoning_effort.trim() : ''
    if (!raw) {
      unrecorded += 1
      continue
    }
    counts.set(raw, (counts.get(raw) ?? 0) + 1)
  }

  const recorded = [...counts.values()].reduce((n, v) => n + v, 0)
  const rows: CliproxyReasoningEffortRow[] = [...counts.entries()]
    .map(([key, count]) => ({
      key,
      get label() { return reasoningEffortLabel(key) },
      count,
      share: recorded > 0 ? count / recorded : null,
      isUnrecorded: false,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))

  // 未记录档位单列在最后:它不是一个档位,不能混进档位序列参与排序与占比。
  // 计数为 0 时**不出行** —— 凭空多一条 "未记录 0" 会被读成"实测没有未记录"。
  if (unrecorded > 0) {
    rows.push({
      key: '',
      get label() { return costDataText('unrecordedTier') },
      count: unrecorded,
      share: null,
      isUnrecorded: true,
    })
  }
  return rows
}

/** LiteLLM per-token → ModelDefaultPricing per-token(字段名对齐,供 modelPricing.value 复用)。
 *  除原始 key(如 'azure_ai/FW-GLM-5.2')外,加多层 stripped 别名:
 *  azure_ai/FW-GLM-5.2 → FW-GLM-5.2 → fw-glm-5.2 → glm-5.2,让 view 用裸 model 名查也能命中。
 *  通用去 provider 前缀变体(fw-/chat-/@cf/org-/bedrock/region/)适配所有国产模型。 */
export function litellmToModelPricing(prices: Record<string, LitellmPricing>): Record<string, ModelDefaultPricing> {
  const result: Record<string, ModelDefaultPricing> = {}
  const addEntry = (key: string, p: LitellmPricing) => {
    if (!key) return
    result[key] = {
      found: true,
      input_price: p.input_cost_per_token,
      output_price: p.output_cost_per_token,
      cache_write_price: p.cache_creation_input_token_cost,
      cache_read_price: p.cache_read_input_token_cost,
    }
  }
  for (const [model, p] of Object.entries(prices)) {
    if (model === 'sample_spec') continue
    addEntry(model, p)
    // stripped:取最后一段(azure_ai/FW-GLM-5.2 → FW-GLM-5.2;bedrock/ap-ne-1/qwen.qwen3 → qwen.qwen3)
    const stripped = model.split('/').pop() || model
    if (stripped !== model) {
      addEntry(stripped, p)
      const lc = stripped.toLowerCase()
      if (lc !== stripped) addEntry(lc, p)
      // 通用去 provider 变体前缀:fw-/chat-/completions-/cf-/org-/zai-org-/moonshotai.
      const stripped2 = lc.replace(/^(fw-|chat-|completions-|cf-|@cf\/[^/]+\/|zai-org-|moonshotai\.|@cf\/)/, '')
      if (stripped2 && stripped2 !== lc) addEntry(stripped2, p)
      // 去厂商前缀再剥一层(glm-5.2 → glm-5.2 已是;deepseek-v4-flash → 同;若 stripped2 含厂商名再剥)
      const stripped3 = stripped2.replace(/^(zai-|minimax-|moonshot-|kimi-|deepseek-|qwen-|glm-)/, '')
      if (stripped3 && stripped3 !== stripped2) addEntry(stripped3, p)
    }
  }
  return result
}

/** model 名 → LiteLLM litellm_provider(真实厂商,如 zai/dashscope/moonshot/deepseek)。
 *  供 platform 分类用真实厂商而非 model 前缀猜测。CPA events 的 provider 字段是 GBK 乱码不可靠。 */
export function litellmModelVendorMap(prices: Record<string, LitellmPricing>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [model, p] of Object.entries(prices)) {
    if (model === 'sample_spec') continue
    const vendor = p.litellm_provider
    if (!vendor) continue
    result[model] = vendor
    const stripped = model.split('/').pop() || model
    if (stripped !== model) result[stripped] = vendor
    const lc = stripped.toLowerCase()
    if (lc !== stripped) result[lc] = vendor
    const stripped2 = lc.replace(/^(fw-|chat-|completions-|cf-|@cf\/[^/]+\/|zai-org-|moonshotai\.|@cf\/)/, '')
    if (stripped2) result[stripped2] = vendor
  }
  return result
}

/** usage_events 按 auth_index 聚合 → Account[](供 store accounts,驱动 accountLedgers/upstreamRows)。
 *  vendorMap 可选(LiteLLM litellm_provider 反查表),传入则按真实厂商分类 platform。 */
export function cliproxyEventsToAccounts(
  events: CliproxyUsageEvent[],
  vendorMap?: Record<string, string>,
): Account[] {
  const map = new Map<string, {
    authIndex: string
    authType: string
    provider: string
    modelCounts: Map<string, number>
    alias: string
    earliestMs: number
    latestMs: number
    successCount: number
    failureCount: number
    bannedCount: number
    lastStatusCode: number
  }>()
  for (const ev of events) {
    if (!ev.auth_index?.trim()) continue
    const key = ev.auth_index
    let acc = map.get(key)
    if (!acc) {
      acc = {
        authIndex: key,
        authType: ev.auth_type,
        provider: ev.provider,
        modelCounts: new Map(),
        alias: ev.alias,
        earliestMs: ev.requested_at,
        latestMs: ev.requested_at,
        successCount: 0,
        failureCount: 0,
        bannedCount: 0,
        lastStatusCode: 0,
      }
      map.set(key, acc)
    }
    acc.earliestMs = Math.min(acc.earliestMs, ev.requested_at)
    acc.latestMs = Math.max(acc.latestMs, ev.requested_at)
    acc.modelCounts.set(ev.model, (acc.modelCounts.get(ev.model) ?? 0) + 1)
    acc.lastStatusCode = ev.status_code
    // 401/402/403 = 账号封禁(用户确认),计入 bannedCount
    if ([401, 402, 403].includes(ev.status_code)) acc.bannedCount += 1
    if (ev.failed) acc.failureCount += 1
    else acc.successCount += 1
  }
  return [...map.values()].map((acc) => {
    const id = authIndexToAccountId(acc.authIndex)
    // platform 按最常见 model 派生(同 auth_index 多 model 时取频次最高,避免首 event 降维)
    const topModel = [...acc.modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    const platform = cliproxyProviderToPlatform(acc.provider, topModel, vendorMap)
    const sourceType = cliproxyAuthTypeToAccountType(acc.authType)
    const type: AccountType = sourceType ?? 'oauth'
    const name = acc.alias || acc.authIndex
    // 健康度:status_code 401/402/403 = 账号封禁(用户确认)→ error;
    // 否则按失败率(>50% error / >20% inactive / active)
    const total = acc.successCount + acc.failureCount
    const failureRate = total > 0 ? acc.failureCount / total : 0
    const banned = acc.bannedCount > 0
    const status: 'active' | 'inactive' | 'error' = banned
      ? 'error'
      : failureRate > 0.5 ? 'error' : failureRate > 0.2 ? 'inactive' : 'active'
    const errorMessage = banned
      ? costDataText('historicalRequestsContain401402403NotCurrentManagement', { p0: acc.bannedCount })
      : acc.failureCount > 0
        ? costDataText('requestsFailed', { p0: acc.failureCount, p1: total, p2: (failureRate * 100).toFixed(0) })
        : null
    return {
      id,
      name,
      platform,
      type,
      credentials: undefined,
      extra: {
        cliproxy_identity_source: 'usage_only',
        cliproxy_status_basis: 'historical_requests',
        cliproxy_usage_linked: false,
        cliproxy_auth_type_known: sourceType != null,
      },
      proxy_id: null,
      concurrency: 0,
      // cliproxy 无账号优先级概念 —— 置 null 让 UI 显示 —。
      // 此前填 0 会被模板渲染成「0 · 最低」,那是**编造的优先级**(源根本没这个概念),
      // 与同段 scheduler_score 置 null 的处理一致(2026-09-20 修正)。
      priority: null,
      scheduler_score: null, // cliproxy 无调度评分,置 null(UI 显示"无数据"诚实降级,不派生假分)
      status,
      error_message: errorMessage,
      last_used_at: new Date(acc.latestMs).toISOString(),
      expires_at: null,
      auto_pause_on_expired: false,
      created_at: new Date(acc.earliestMs).toISOString(),
      updated_at: new Date(acc.latestMs).toISOString(),
      schedulable: true,
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

/** usage_events 按 auth_index 聚合 → Record<id, WindowStats>(全部窗口请求用量,供 todayStats)。
 *  costMultiplier:官方价反算成本 × 倍率兜底(与 economics 同口径)。 */
export function cliproxyEventsToTodayStats(
  events: CliproxyUsageEvent[],
  prices: Record<string, LitellmPricing>,
  costMultiplier?: number,
  /** 窗口边界。**调用方必须传** —— events 由 Rust 侧硬截断到 30 天(src-tauri/src/main.rs:675),
   *  不传就等于把近 30 天当"今日"展示(2026-09-16 B3)。语义与 sub2api 的 todayStats 一致:自然日。 */
  window?: { start: Date; end: Date },
): Record<string, AccountWindowUsage> {
  const multiplier = resolveCostMultiplier(costMultiplier)
  const startMs = window ? window.start.getTime() : null
  const endMs = window ? window.end.getTime() : null
  const map = new Map<string, { requests: number; tokens: number; costUsd: number; unpriced: number }>()
  for (const ev of events) {
    if (startMs != null && endMs != null && !(ev.requested_at >= startMs && ev.requested_at < endMs)) continue
    const key = ev.auth_index?.trim() ? authIndexToAccountId(ev.auth_index) : UNATTRIBUTED_USAGE_ACCOUNT_ID
    let acc = map.get(key)
    if (!acc) {
      acc = { requests: 0, tokens: 0, costUsd: 0, unpriced: 0 }
      map.set(key, acc)
    }
    acc.requests += 1
    acc.tokens += ev.total_tokens
    // 用带 basis 的计价函数:无匹配单价时它返的是**哨兵 0**,写进 cost 会被渲染成绿色实测 $0.0000。
    const priced = pricedEventCostUsd(ev, resolveModelPricing(ev.model, prices))
    if (isUnknownCostBasis(priced.basis.kind)) acc.unpriced += 1
    else acc.costUsd += priced.cost
  }
  const result: Record<string, AccountWindowUsage> = {}
  for (const [id, acc] of map) {
    // 完整金额未知时保留已计价分项，不能把未知请求当 0，也不能丢掉已知部分。
    result[id] = {
      requests: acc.requests,
      tokens: acc.tokens,
      cost: acc.unpriced ? null : acc.costUsd * multiplier,
      standard_cost: acc.unpriced ? null : acc.costUsd,
      user_cost: null,
      ...(acc.unpriced ? { known_cost: acc.costUsd * multiplier, known_standard_cost: acc.costUsd, unknown_cost_requests: acc.unpriced } : {}),
    }
  }
  return result
}

/** 窗口百分比 + 重置秒 → UsageProgress。reset 缺失时不编造重置时间(resets_at=null)。 */
function usageProgressFrom(usedPercent: number, resetSec: number | null, nowSec: number, recordedAtMs: number): RecordedQuotaProgress {
  const resetAt = quotaTimestamp(resetSec == null ? null : resetSec * 1000)
  return {
    utilization: usedPercent,
    resets_at: resetAt,
    remaining_seconds: resetAt ? Math.max(0, resetSec! - nowSec) : 0,
    recorded_at: quotaTimestamp(recordedAtMs),
    snapshot_source: 'recorded',
  }
}

/** usage_events → Record<id, AccountUsageInfo>(配额窗口,5h / 7d 各自按 auth_index 取最近一条成功记录)。
 *
 *  窗口映射(2026-09-17 直读插件 usage.db 实测确认):
 *  - `primary_used_percent` / `primary_reset_at` = **5h 窗口**(实测 reset − requested_at ≈ 4.69h)
 *  - `secondary_used_percent` / `secondary_reset_at` = **独立 7d 窗口**(实测 ≈ 6.78d)
 *  同一条 event 上两者可以完全不同(实测 5h=100% 而 7d=35%),所以 seven_day 必须读 secondary,
 *  不得拿 primary 顶替 —— 那会把 5h 的数按 7d 的口径展示。
 *
 *  判据与空值契约(同一次实测,全表 7700 行):
 *  - 「源给了独立 7d 窗口」⇔ `secondary_reset_at` 非空。207 行 `secondary_used_percent=0` 且 reset 为空,
 *    全部集中在 15 个**从未出现过** reset 的 auth_index(同批记录 5h 覆盖 2–100%),
 *    ⇒ 那是"上游没报这个窗口"的缺省编码,不是"用了 0%";按 0 展示会变成假健康态。
 *    有 reset 的 1349 行里另有 20 行 pct=0,那才是真 0(同账号随后涨到 35%)。
 *  - 取不到时 `seven_day = null`,由渲染层显示「无数据」,**绝不落 0**。
 *  - `secondary_used_tokens` / `secondary_remaining_tokens` / `secondary_limit_tokens` 全表 0 行非空
 *    (`primary_limit_tokens` 同样全空),故 token 级窗口数据不可得,一律不填。
 */
export function cliproxyEventsToAccountUsage(events: CliproxyUsageEvent[], queryNow = new Date()): Record<string, AccountUsageInfo> {
  type WindowSnapshot = { at: number; usedPercent: number; resetAt: number | null }
  const latestPrimary = new Map<string, WindowSnapshot>()
  const latestSecondary = new Map<string, WindowSnapshot>()
  const keepLatest = (map: Map<string, WindowSnapshot>, key: string, snapshot: WindowSnapshot) => {
    const prev = map.get(key)
    if (!prev || snapshot.at > prev.at) map.set(key, snapshot)
  }
  for (const ev of events) {
    if (ev.failed) continue
    if (!ev.auth_index?.trim()) continue
    const key = ev.auth_index
    // 5h 窗口:源给了百分比即可用(实测 primary_reset_at 在有值行上恒非空)
    if (ev.primary_used_percent != null && Number.isFinite(ev.primary_used_percent) && ev.primary_used_percent >= 0) {
      keepLatest(latestPrimary, key, {
        at: ev.requested_at,
        usedPercent: ev.primary_used_percent,
        resetAt: ev.primary_reset_at,
      })
    }
    // 7d 窗口:必须同时拿到百分比与重置时间,才算源真的报了独立 7d 窗口
    if (ev.secondary_used_percent != null && Number.isFinite(ev.secondary_used_percent) && ev.secondary_used_percent >= 0
      && quotaTimestamp(ev.secondary_reset_at == null ? null : ev.secondary_reset_at * 1000)) {
      keepLatest(latestSecondary, key, {
        at: ev.requested_at,
        usedPercent: ev.secondary_used_percent,
        resetAt: ev.secondary_reset_at,
      })
    }
  }
  const result: Record<string, AccountUsageInfo> = {}
  const nowSec = Math.floor(queryNow.getTime() / 1000)
  const authIndexes = new Set([...latestPrimary.keys(), ...latestSecondary.keys()])
  for (const authIndex of authIndexes) {
    const pri = latestPrimary.get(authIndex)
    const sec = latestSecondary.get(authIndex)
    // 两个窗口可能来自不同 event(各次请求上报的快照不同步),取较新的那条作为该账号的更新时间
    const stampMs = Math.max(pri?.at ?? 0, sec?.at ?? 0)
    result[authIndexToAccountId(authIndex)] = {
      source: 'active',
      updated_at: stampMs > 0 ? new Date(stampMs).toISOString() : null,
      five_hour: pri ? usageProgressFrom(pri.usedPercent, pri.resetAt, nowSec, pri.at) : null,
      seven_day: sec ? usageProgressFrom(sec.usedPercent, sec.resetAt, nowSec, sec.at) : null,
      seven_day_sonnet: null,
    }
  }
  return result
}

/** usage_events 按 model 聚合 → ModelStat[](驱动 buildModelCostRows → MODEL ECONOMICS 表)。
 *  O(n) 单次遍历:聚合 + 记录每个 model 的 first/last 时间戳,避免 O(n²) filter 遍历。
 *  range:模型区**独立窗口**(与顶部主窗口 range 是两轨,见 loadFromCliproxy 的 modelRange)。
 *  events 本身是 Rust 侧截断的近 30 天全量(src-tauri/src/main.rs:683 cutoff = now - 30*86400),
 *  不按 range 过滤就会把 30 天合计渲染在「最近 1 分钟」的表头下(modelCostRangeLabel)。
 *  区间语义与 cliproxyEventsToTrend 完全一致:半开区间 [start, end)。
 *  cost 为未乘本机倍率的 API 参考值；account_cost 为参考值 × 成本倍率。
 *  actual_cost 恒为 null：CPA 无营收口径,按 LiteLLM 单价反算的成本是估算,不得填入用户计费字段
 *  (契约见 src/types/index.ts 的 ModelStat)。 */
export function cliproxyEventsToModelStats(
  events: CliproxyUsageEvent[],
  prices: Record<string, LitellmPricing>,
  range: CostCenterRange,
  costMultiplier?: number,
  queryNow = new Date(),
): ModelStat[] {
  const multiplier = resolveCostMultiplier(costMultiplier)
  // 先在函数开头裁掉窗口外事件,再进原有聚合循环 —— 循环体一字不改,区间语义只有一处。
  const { start, end } = cliproxyUsageWindowBounds(range, queryNow)
  const startMs = start.getTime()
  const endMs = end.getTime()
  const inWindow = events.filter((ev) => ev.requested_at >= startMs && ev.requested_at < endMs)
  const map = new Map<string, ModelStat & { _costUsd: number; _unpriced: boolean; _firstMs: number; _lastMs: number }>()
  for (const ev of inWindow) {
    const model = ev.model || 'unknown'
    // 用带 basis 的计价函数:无匹配单价时 pricedEventCostUsd 返的是**哨兵 0**(basis 标"算不出"),
    // 而 eventCostUsd 只给 number,丢掉标注后 0 会被当实测成本写进数值列。
    const priced = pricedEventCostUsd(ev, resolveModelPricing(ev.model, prices))
    const costUsd = priced.cost
    const unpriced = isUnknownCostBasis(priced.basis.kind)
    let m = map.get(model)
    if (!m) {
      m = {
        model,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        cost: costUsd,
        account_cost: costUsd * multiplier,
        actual_cost: null,
        failed_requests: 0,
        zero_token_requests: 0,
        failed_zero_token_requests: 0,
        _costUsd: 0,
        _unpriced: false,
        _firstMs: ev.requested_at,
        _lastMs: ev.requested_at,
      }
      map.set(model, m)
    }
    m.requests += 1
    m.failed_requests = (m.failed_requests ?? 0) + (ev.failed ? 1 : 0)
    m.zero_token_requests = (m.zero_token_requests ?? 0) + (ev.total_tokens === 0 ? 1 : 0)
    m.failed_zero_token_requests = (m.failed_zero_token_requests ?? 0) + (ev.failed && ev.total_tokens === 0 ? 1 : 0)
    const normalized = cliproxyTokenBreakdown(ev)
    m.input_tokens = m.input_tokens == null || normalized.inputTokens == null ? null : m.input_tokens + normalized.inputTokens
    m.output_tokens = m.output_tokens == null || normalized.outputTokens == null ? null : m.output_tokens + normalized.outputTokens
    m.cache_creation_tokens = (m.cache_creation_tokens ?? 0) + (normalized.cacheWriteTokens ?? 0)
    m.cache_read_tokens = (m.cache_read_tokens ?? 0) + (normalized.cacheReadTokens ?? 0)
    m.total_tokens = m.input_tokens == null || m.output_tokens == null ? null : m.input_tokens + m.output_tokens
    m._costUsd += costUsd
    // 任一分量算不出来 ⇒ 整模型标未知(取更差一侧);未知时不写哨兵 0,置 null。
    m._unpriced = m._unpriced || unpriced
    m.cost = m._unpriced ? null : m._costUsd
    m.account_cost = m._unpriced ? null : m._costUsd * multiplier
    m.actual_cost = null
    if (ev.requested_at < m._firstMs) m._firstMs = ev.requested_at
    if (ev.requested_at > m._lastMs) m._lastMs = ev.requested_at
  }
  return [...map.values()].map(({ _costUsd, _unpriced, _firstMs, _lastMs, ...rest }) => {
    void _costUsd
    void _unpriced
    return {
      ...rest,
      cache_hit_ratio: rest.input_tokens != null && rest.input_tokens > 0 && rest.cache_read_tokens != null ? rest.cache_read_tokens / rest.input_tokens : null,
      first_seen: _firstMs ? new Date(_firstMs).toISOString() : undefined,
      last_seen: _lastMs ? new Date(_lastMs).toISOString() : undefined,
    } as ModelStat
  })
}

/** usage_events 按 range 桶聚合 → CostTrendDataPoint[](真实多桶时序,驱动趋势图)。
 *  costMultiplier:官方价反算成本 × 倍率兜底(与 economics 同口径)。 */
export function cliproxyEventsToTrend(
  events: CliproxyUsageEvent[],
  prices: Record<string, LitellmPricing>,
  range: CostCenterRange,
  costMultiplier?: number,
  queryNow = new Date(),
): CostTrendDataPoint[] {
  if (events.length === 0) return []
  const multiplier = resolveCostMultiplier(costMultiplier)
  const { start, end } = cliproxyUsageWindowBounds(range, queryNow)
  const bucketMs = TREND_BUCKET_MILLISECONDS[range]
  const startMs = start.getTime()
  const endMs = end.getTime()
  const bucketCount = Math.max(1, Math.ceil((endMs - startMs) / bucketMs))
  const buckets = Array.from({ length: bucketCount }, () => ({
    requests: 0,
    input_tokens: 0 as number | null,
    output_tokens: 0 as number | null,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0 as number | null,
    costUsd: 0,
    unpriced: 0,
    estimated: 0,
    priced: 0,
  }))
  for (const ev of events) {
    if (ev.requested_at < startMs || ev.requested_at >= endMs) continue
    const idx = Math.min(bucketCount - 1, Math.floor((ev.requested_at - startMs) / bucketMs))
    const b = buckets[idx]
    b.requests += 1
    const normalized = cliproxyTokenBreakdown(ev)
    b.input_tokens = b.input_tokens == null || normalized.inputTokens == null ? null : b.input_tokens + normalized.inputTokens
    b.output_tokens = b.output_tokens == null || normalized.outputTokens == null ? null : b.output_tokens + normalized.outputTokens
    b.cache_creation_tokens += normalized.cacheWriteTokens ?? 0
    b.cache_read_tokens += normalized.cacheReadTokens ?? 0
    b.total_tokens = b.input_tokens == null || b.output_tokens == null ? null : b.input_tokens + b.output_tokens
    // 用带 basis 的计价函数,逐事件统计三种依据,决定这一桶是"断点"还是"下界"。
    const priced = pricedEventCostUsd(ev, resolveModelPricing(ev.model, prices))
    b.costUsd += priced.cost * multiplier
    if (isUnknownCostBasis(priced.basis.kind)) b.unpriced += 1
    else if (priced.basis.kind === 'source_estimate') b.estimated += 1
    else b.priced += 1
  }
  const points: CostTrendDataPoint[] = []
  for (let i = 0; i < bucketCount; i++) {
    const b = buckets[i]
    if (b.requests === 0 && b.total_tokens === 0) continue // 空桶跳过,非造假零点
    const bucketStart = startMs + i * bucketMs
    // 全桶算不出来(桶内每个事件都无匹配单价)⇒ 成本字段一律 null(图表断点),不得补 0;
    // 部分算不出来 ⇒ 保留求和值(它是**真实下界**)并标 source_estimate。
    const allUnknown = b.unpriced > 0 && b.priced === 0 && b.estimated === 0
    points.push({
      date: new Date(bucketStart).toISOString(),
      requests: b.requests,
      input_tokens: b.input_tokens,
      output_tokens: b.output_tokens,
      cache_creation_tokens: b.cache_creation_tokens,
      cache_read_tokens: b.cache_read_tokens,
      total_tokens: b.total_tokens,
      cost: allUnknown ? null : b.costUsd,
      actual_cost: allUnknown ? null : b.costUsd,
      account_cost: allUnknown ? null : b.costUsd,
      costBasis: allUnknown
        ? 'no_price_no_estimate' as const
        : b.unpriced > 0 || b.estimated > 0 ? 'source_estimate' as const : undefined,
    })
  }
  return points
}

/** usage_events → OpsDashboardOverview + OpsThroughputTrendPoint[](真实 ops,cliproxy 不再 unavailable)。 */
export function cliproxyEventsToOps(
  events: CliproxyUsageEvent[],
  range: CostCenterRange,
  queryNow = new Date(),
): { overview: OpsDashboardOverview; trend: OpsThroughputTrendPoint[]; errorTrend: OpsErrorTrendPoint[] } {
  const { start, end } = cliproxyUsageWindowBounds(range, queryNow)
  const bucketMs = TREND_BUCKET_MILLISECONDS[range]
  const startMs = start.getTime()
  const endMs = end.getTime()
  const bucketCount = Math.max(1, Math.ceil((endMs - startMs) / bucketMs))
  const buckets = Array.from({ length: bucketCount }, () => ({
    request_count: 0,
    success_count: 0,
    error_count: 0,
    token_consumed: 0 as number | null,
    input_tokens: 0 as number | null,
    output_tokens: 0 as number | null,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    duration_p95_ms: [] as number[],
    ttft_p50_ms: [] as number[],
    err429: 0,
    err529: 0,
    err402: 0,
    errOther: 0,
  }))
  let successTotal = 0
  let errorTotal = 0
  let requestTotal = 0
  let tokenTotal: number | null = 0
  const allLatencies: number[] = []
  const allTtfts: number[] = []
  for (const ev of events) {
    if (ev.requested_at < startMs || ev.requested_at >= endMs) continue
    requestTotal += 1
    if (ev.failed) {
      errorTotal += 1
    } else {
      successTotal += 1
    }
    const normalized = cliproxyTokenBreakdown(ev)
    const eventTotal = normalized.inputTokens == null || normalized.outputTokens == null ? null : normalized.inputTokens + normalized.outputTokens
    tokenTotal = tokenTotal == null || eventTotal == null ? null : tokenTotal + eventTotal
    const idx = Math.min(bucketCount - 1, Math.floor((ev.requested_at - startMs) / bucketMs))
    const b = buckets[idx]
    b.request_count += 1
    if (ev.failed) b.error_count += 1
    else b.success_count += 1
    b.token_consumed = b.token_consumed == null || eventTotal == null ? null : b.token_consumed + eventTotal
    b.input_tokens = b.input_tokens == null || normalized.inputTokens == null ? null : b.input_tokens + normalized.inputTokens
    b.output_tokens = b.output_tokens == null || normalized.outputTokens == null ? null : b.output_tokens + normalized.outputTokens
    b.cache_creation_tokens += normalized.cacheWriteTokens ?? 0
    b.cache_read_tokens += normalized.cacheReadTokens ?? 0
    if (ev.latency_ms > 0) { b.duration_p95_ms.push(ev.latency_ms); allLatencies.push(ev.latency_ms) }
    if (ev.ttft_ms > 0) { b.ttft_p50_ms.push(ev.ttft_ms); allTtfts.push(ev.ttft_ms) }
    if (ev.status_code === 429) b.err429 += 1
    else if (ev.status_code === 529) b.err529 += 1
    else if (ev.status_code === 402) b.err402 += 1
    else if (ev.failed && ev.status_code !== 0) b.errOther += 1
  }
  const p95 = (arr: number[]): number | null => {
    if (arr.length === 0) return null
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    return sorted[idx]
  }
  const p50 = (arr: number[]): number | null => {
    if (arr.length === 0) return null
    const sorted = [...arr].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const trend: OpsThroughputTrendPoint[] = []
  const errorTrend: OpsErrorTrendPoint[] = []
  for (let i = 0; i < bucketCount; i++) {
    const b = buckets[i]
    if (b.request_count === 0) continue
    const bucketStart = startMs + i * bucketMs
    const bucketSecs = bucketMs / 1000
    trend.push({
      bucket_start: new Date(bucketStart).toISOString(),
      request_count: b.request_count,
      success_count: b.success_count,
      error_count: b.error_count,
      token_consumed: b.token_consumed,
      input_tokens: b.input_tokens,
      output_tokens: b.output_tokens,
      cache_creation_tokens: b.cache_creation_tokens,
      cache_read_tokens: b.cache_read_tokens,
      // 该源不在这一层承载成本(契约见 src/api/admin/ops.ts 的 OpsThroughputTrendPoint:
      // "null = 该源不在这一层承载成本")。cliproxyEventsToOps 的签名拿不到 prices,算不出成本,
      // 写 0 会被 selectFinancialTrend 当成"有经济证据"而选中 ops 桶 ⇒ 趋势图画一条贴底假零线。
      user_billed_usd: null,
      account_cost_usd: null,
      contribution_usd: null,
      duration_p95_ms: p95(b.duration_p95_ms),
      ttft_p50_ms: p50(b.ttft_p50_ms),
      ttft_p95_ms: p95(b.ttft_p50_ms),
      qps: bucketSecs > 0 ? b.request_count / bucketSecs : 0,
      tps: bucketSecs > 0 && b.token_consumed != null ? b.token_consumed / bucketSecs : null,
    })
    errorTrend.push({
      bucket_start: new Date(bucketStart).toISOString(),
      error_count_total: b.error_count,
      business_limited_count: b.err429 + b.err529,
      error_count_sla: b.errOther,
      // FIX B:该字段语义含 402(权威实现 ops_repo_preagg.go:96 的 `NOT IN (429,529)`);
      // 图表 AdaptiveOperationsCharts.vue 会再减去 402 得到「其他上游错误」,故这里必须含 402。
      upstream_error_count_excl_429_529: b.errOther + b.err402,
      upstream_402_count: b.err402,
      upstream_429_count: b.err429,
      upstream_529_count: b.err529,
    })
  }
  const businessLimited = buckets.reduce((s, b) => s + b.err429 + b.err529, 0)
  const upstream429 = buckets.reduce((s, b) => s + b.err429, 0)
  const upstream529 = buckets.reduce((s, b) => s + b.err529, 0)
  const upstream402 = buckets.reduce((s, b) => s + b.err402, 0)
  const upstreamOther = buckets.reduce((s, b) => s + b.errOther, 0)
  const windowSecs = (endMs - startMs) / 1000
  const overview: OpsDashboardOverview = {
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    platform: 'all',
    group_id: null,
    success_count: successTotal,
    error_count_total: errorTotal,
    business_limited_count: businessLimited,
    error_count_sla: errorTotal - businessLimited,
    request_count_total: requestTotal,
    request_count_sla: null, // CPA 无 SLA 概念(既无 SLA 目标也无达标口径),不得拿 success 近似
    token_consumed: tokenTotal,
    sla: null, // CPA 无 SLA 目标 ⇒ 达标率不可得,面板显示「-」而不是"100% 达标"
    error_rate: requestTotal > 0 ? errorTotal / requestTotal : 0,
    // FIX B:分子必须含 402 —— 上游错误总数 = 429 + 529 + 402 + 其他;漏掉 402 会让上游错误率偏低。
    upstream_error_rate: requestTotal > 0 ? (upstream429 + upstream529 + upstream402 + upstreamOther) / requestTotal : 0,
    // FIX B:语义含 402(见 ops_repo_preagg.go:96 `NOT IN (429,529)`);图表会再减去 402 得「其他」。
    upstream_error_count_excl_429_529: upstreamOther + upstream402,
    upstream_429_count: upstream429,
    upstream_529_count: upstream529,
    // ★ 2026-09-26:`peak` 此前写 `0` 并注释「CPA 无峰值快照」。但 `0` 与"实测峰值为 0"
    //   在界面上无从区分 —— 那是凭空断言,违反本项目「null = 该源不掌握,不得渲染成 0」的契约。
    //   ⇒ 改成 null,面板显示「无数据」。
    qps: {
      current: windowSecs > 0 ? requestTotal / windowSecs : null,
      peak: null, // CPA 无峰值快照 ⇒ null(不是 0)
      avg: windowSecs > 0 ? requestTotal / windowSecs : null,
    },
    tps: {
      current: windowSecs > 0 && tokenTotal != null ? tokenTotal / windowSecs : null,
      peak: null,
      avg: windowSecs > 0 && tokenTotal != null ? tokenTotal / windowSecs : null,
    },
    duration: {
      p50_ms: p50(allLatencies),
      p95_ms: p95(allLatencies),
    },
    ttft: {
      p50_ms: p50(allTtfts),
      p95_ms: p95(allTtfts),
    },
  } as OpsDashboardOverview
  return { overview, trend, errorTrend }
}

/** usage_events × model_prices → AccountEconomicsSnapshot(调统一本地成本引擎)。
 *  billedUsdTotal = 窗口内 events 反算(估算,与 useUnifiedCost.loadCliproxy 同口径);
 *  账号按 auth_index 聚合(全量 events 聚合,账号实体不随窗口缩减);
 *  无 plan_type → unknown → default 价 0,标 estimated;无时序 → series 空。
 *  range 参数:按 range 窗口过滤 events 再算成本,与 sub2api/cockpit 同窗口口径对齐。 */
export function cliproxyEventsToEconomics(
  events: CliproxyUsageEvent[],
  prices: Record<string, LitellmPricing>,
  cnyPerUsd: number,
  vendorMap?: Record<string, string>,
  range?: CostCenterRange,
  costMultiplier?: number,
  queryNow = new Date(),
): AccountEconomicsSnapshot | null {
  if (events.length === 0) return null

  // 窗口过滤(与 useUnifiedCost.loadCliproxy 同口径)
  let costEvents = events
  if (range) {
    const { start, end } = cliproxyUsageWindowBounds(range, queryNow)
    const startMs = start.getTime()
    const endMs = end.getTime()
    costEvents = events.filter(ev => ev.requested_at >= startMs && ev.requested_at < endMs)
  }
  // 窗口内无 events 时诚实返 null(不回退全量,保持与另两端同窗口口径)
  if (costEvents.length === 0) return null

  // 按 auth_index 聚合账号 + 健康度(全量 events 聚合,账号实体不随窗口缩减)
  const map = new Map<string, {
    authIndex: string
    provider: string
    model: string
    authType: string
    earliestMs: number
    successCount: number
    failureCount: number
  }>()
  for (const ev of events) {
    const key = ev.auth_index ? `auth:${ev.auth_index}` : UNATTRIBUTED_USAGE_ACCOUNT_ID
    let acc = map.get(key)
    if (!acc) {
      acc = {
        authIndex: ev.auth_index || '',
        provider: ev.provider,
        model: ev.model,
        authType: ev.auth_type,
        earliestMs: ev.requested_at,
        successCount: 0,
        failureCount: 0,
      }
      map.set(key, acc)
    }
    acc.earliestMs = Math.min(acc.earliestMs, ev.requested_at)
    if (ev.failed) acc.failureCount += 1
    else acc.successCount += 1
  }

  const localAccounts = [...map.values()].filter(acc => !!acc.authIndex).map((acc) => {
    const sourceType = cliproxyAuthTypeToAccountType(acc.authType)
    return {
      account: {
        created_at: new Date(acc.earliestMs).toISOString(),
        extra: { cliproxy_identity_source: 'usage_only', cliproxy_auth_type_known: sourceType != null },
        credentials: undefined,
        parent_plan_type: undefined,
        platform: cliproxyProviderToPlatform(acc.provider, acc.model, vendorMap),
        type: sourceType ?? 'oauth',
      } as CostAccount,
      health: { successCount: acc.successCount, failureCount: acc.failureCount },
    }
  })

  // Legacy billed 字段表示 API 参考价值；账号费率值单独应用倍率，不重复逐事件计价。
  const multiplier = resolveCostMultiplier(costMultiplier)
  // 用带 basis 的合计口(与 cliproxyEventsToTrend 同规则):全部事件无匹配单价 ⇒
  // no_price_no_estimate ⇒ null(不是 0 —— 0 会被 costEngine 当成"确实没有产出",并算出
  // 负的假 contribution_margin);部分无单价 ⇒ 保留已知小计并明确 partial。
  const priced = cliproxyEventsPricedCost(costEvents, prices, 1)
  const billedUsdTotal: number | null = isUnknownCostBasis(priced.basis.kind) ? null : priced.cost
  const accountCostUsdTotal = billedUsdTotal == null ? null : billedUsdTotal * multiplier
  const now = queryNow.getTime()

  const snapshot = buildLocalEconomicsSnapshot({
    accounts: localAccounts,
    billedUsdTotal,
    accountCostUsdTotal,
    outputBasis: 'api_value',
    cnyPerUsd,
    now,
    // cliproxy 无独立时序快照 → series 不传(健康图无点,诚实 unavailable)
    // 默认采购只适用可证明的订阅身份；未知 auth_type 不推导订阅采购。
    costMultiplier: multiplier,
    window: range ? cliproxyUsageWindowBounds(range, queryNow) : undefined,
    impairmentComplete: false,
  })
  const unassigned = costEvents.filter(event => !event.auth_index).length
  if (snapshot && (priced.unpricedEvents || unassigned)) {
    snapshot.data_quality.status = 'partial'
    snapshot.projection.warning = [snapshot.projection.warning,
      priced.unpricedEvents ? costDataText('requestsAreUnpricedAmountIsTheKnownSubtotalOnly', { p0: priced.unpricedEvents }) : '',
      unassigned ? costDataText('requestsLackAccountAttributionAndAreNotCountedAs', { p0: unassigned }) : '',
    ].filter(Boolean).join('；')
  }
  return snapshot
}
