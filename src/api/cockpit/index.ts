/**
 * Cockpit Tools 数据客户端 — 读本地 JSON(主源,零认证零进程依赖)
 *
 * cockpit-tools(E:\Cockpit Tools)是 Electron + sidecar adapter 架构,用户数据存
 * %USERPROFILE%\.antigravity_cockpit\*.json。成本数据已在 codex_local_access_stats.json
 * 预算好(totals.estimatedCostUsd + per-account 明细),无需调 HTTP。
 *
 * 与 apiClient(sub2api 反代+信封)/cliproxyClient(cliproxy Bearer+裸数据)完全隔离:
 * - 不走 axios,走 Tauri invoke('read_cockpit_file')(WebView2 沙箱无文件系统权限,Rust 侧读)
 * - 非桌面运行时(web/dev)invoke 不可用 → 降级返空 + 标记 unavailable
 * - 路径安全由 Rust 侧白名单保证(仅 [a-z_0-9]+\.json,防目录穿越)
 *
 * 三套客户端三套数据源,互不污染:sub2api 走 adminAPI、cliproxy 走 cliproxyClient、cockpit 走本客户端。
 */

import { invoke } from '@tauri-apps/api/core'
import { quoteModelCatalogBatch, type ModelCatalogQuoteInput } from '@/api/modelCatalog'
import { errMsg } from '@/stores/connection'
import { isDesktopRuntime as detectDesktop } from '@/api/url'
import i18n from '@/i18n'

/** cockpit 用量统计(codex_local_access_stats.json) */
export interface CockpitUsageStats {
  requestCount: number
  successCount: number
  failureCount: number
  clientCanceledCount: number
  upstreamResponseFailedCount: number
  streamIncompleteCount: number
  totalLatencyMs: number
  textRequestCount: number
  imageRequestCount: number
  imageGenerationRequestCount: number
  imageEditRequestCount: number
  imageGenerationCapabilityFailureCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedTokens: number
  reasoningTokens: number
  estimatedCostUsd: number
}

export interface CockpitAccountUsage extends CockpitUsageStats {
  updatedAt?: number
}

export interface CockpitStatsAccount {
  accountId: string
  email?: string
  usage: CockpitAccountUsage
}

/** cockpit 按模型用量(models[] / daily.models[] / monthly.models[] 同结构) */
export interface CockpitModelUsage {
  modelId: string
  usage: CockpitUsageStats
  updatedAt?: number
}

/** cockpit 按网关 API Key 用量(stats.apiKeys[],真实请求/Token/成本统计) */
export interface CockpitApiKeyStat {
  apiKeyId: string
  label?: string
  updatedAt?: number
  usage: CockpitUsageStats
}

/** cockpit 时序快照窗口(daily/weekly/monthly 同结构)。
 *  cockpit 时序是日/周/月聚合快照(非分钟/小时桶),适配层据此派生 trend。 */
export interface CockpitStatsWindow {
  since: number
  updatedAt: number
  totals: CockpitUsageStats
  accounts: CockpitStatsAccount[]
  models: CockpitModelUsage[]
  apiKeys?: CockpitApiKeyStat[]
}

export interface CockpitStats {
  since?: number
  updatedAt?: number
  totals: CockpitUsageStats
  accounts: CockpitStatsAccount[]
  /** 按模型用量(累计) */
  models?: CockpitModelUsage[]
  /** 按 API Key 用量(累计,真实请求/Token/成本) */
  apiKeys?: CockpitApiKeyStat[]
  /** 日快照(本机自然日起累计) */
  daily?: CockpitStatsWindow
  /** 周快照(近 7 天累计) */
  weekly?: CockpitStatsWindow
  /** 月快照(近 30 天累计,含完整 models 维度) */
  monthly?: CockpitStatsWindow
  /** 运维事件流(切号/错误/恢复等,cockpit 当前可能为空) */
  events?: unknown[]
}

/** cockpit codex 账号(codex_accounts.json) */
export interface CockpitCodexAccount {
  id: string
  email?: string
  plan_type?: string
  subscription_active_until?: string
  created_at?: number
  last_used?: number
}

/** cockpit 本地访问配置(codex_local_access.json) */
export interface CockpitModelPricing {
  modelId: string
  longContextThresholdTokens?: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
  cachedInputUsdPerMillion?: number
  standardLongInputUsdPerMillion?: number
  standardLongOutputUsdPerMillion?: number
  priorityInputUsdPerMillion?: number
  priorityOutputUsdPerMillion?: number
}

export interface CockpitLocalAccess {
  enabled?: boolean
  port?: number
  apiKey?: string
  apiKeys?: Array<{ id: string; label?: string; key?: string; tokenUsed?: number; enabled?: boolean; lastUsedAt?: number; createdAt?: number; inheritAccountPool?: boolean; allowedModels?: string[]; excludedModels?: string[] }>
  accountIds?: string[]
  modelPricings?: CockpitModelPricing[]
  accessScope?: string
  clientBaseUrlHost?: string
  gatewayMode?: string
  routingStrategy?: string
  /** 自定义路由规则(账号优先级/权重/备份/偏好) */
  customRoutingRules?: Array<{ accountId: string; priority: number; weight: number; isBackup?: boolean; isPreferred?: boolean }>
  /** 账号-模型路由规则 */
  accountModelRules?: unknown[]
  /** 模型别名映射 */
  modelAliases?: unknown[]
  /** 模型定价版本 */
  modelPricingVersion?: number
  /** 会话亲和(同一会话路由到同一账号) */
  sessionAffinity?: boolean
  /** 会话亲和 TTL(毫秒) */
  sessionAffinityTtlMs?: number
  /** 最大凭证重试次数 */
  maxRetryCredentials?: number
  /** 最大重试间隔(毫秒) */
  maxRetryIntervalMs?: number
  /** 超时配置(各阶段超时毫秒) */
  timeouts?: Record<string, number>
  /** 当前超时预设 ID */
  activeTimeoutPresetId?: string
  /** 禁用冷却(失败账号不冷却) */
  disableCooling?: boolean
  /** 限制免费账号 */
  restrictFreeAccounts?: boolean
  /** 调试日志 */
  debugLogs?: boolean
  /** 立即 SSE 响应 */
  immediateSseResponse?: boolean
  /** 最大并发图片请求 */
  maxConcurrentImageRequests?: number
  /** 排除模型 */
  excludedModels?: string[]
  updatedAt?: number
  createdAt?: number
}

/** cockpit 单个配额历史时序点(quota_history/<hash>.json)。
 *  cockpit 按模型记录配额消耗时序:remainingPercentage 100→80→60→40→20→reset。
 *  映射 sub2api UsageProgress(utilization=100-remaining, resets_at=resetTime)。 */
export interface CockpitQuotaPoint {
  timestamp: number
  remainingPercentage: number
  resetTime: number
  countdownSeconds: number
  isStart?: boolean
  isReset?: boolean
}

/** cockpit 单模型配额历史(email 维度,每模型 points[])。 */
export interface CockpitQuotaModelHistory {
  modelId: string
  label?: string
  points: CockpitQuotaPoint[]
  hasCountdownDropAt100?: boolean
}

/** cockpit 配额历史文件(quota_history/<hash>.json,每文件 = 一账号)。
 *  email 是账号邮箱(无 accountId,需用 stats.accounts 反查)。
 *  models 是按模型的配额消耗时序。 */
export interface CockpitQuotaHistoryFile {
  email: string
  updatedAt: number
  models: Record<string, CockpitQuotaModelHistory>
}

/** cockpit 子目录批量读结果项(read_cockpit_dir 返回) */
export interface CockpitDirEntry {
  name: string
  content: string
}

/** cockpit 服务信息(server.json) */
export interface CockpitServerInfo {
  ws_port?: number
  version?: string
  pid?: number
  started_at?: number
  auth_token?: string
}

/** cockpit 连接状态汇总(供 UI 直接消费) */
export interface CockpitConnectionState {
  available: boolean
  running: boolean
  reason?: string
}

const NOT_DESKTOP_MSG = 'cockpit 数据仅在桌面端可用(web/dev 模式不支持读本地文件)'

/** 读单个 cockpit JSON 文件并解析;非桌面端或文件缺失返 null + 控制台提示。 */
async function readJson<T>(name: string): Promise<T | null> {
  if (!detectDesktop()) {
    console.warn(`[cockpit] ${NOT_DESKTOP_MSG}`)
    return null
  }
  try {
    const raw = await invoke<string>('read_cockpit_file', { name })
    return JSON.parse(raw) as T
  } catch (e) {
    // 文件不存在/cockpit 未安装:静默返 null(非错误,cockpit 可能没装)
    console.warn(`[cockpit] 读取 ${name} 失败:`, errMsg(e, '读取失败'))
    return null
  }
}

/** 读用量统计(成本核心) */
export async function getCockpitStats(): Promise<CockpitStats | null> {
  return readJson<CockpitStats>('codex_local_access_stats.json')
}

/** 读 codex 账号列表 */
export async function getCockpitCodexAccounts(): Promise<CockpitCodexAccount[]> {
  const data = await readJson<{ accounts: CockpitCodexAccount[] }>('codex_accounts.json')
  return data?.accounts ?? []
}

/** cockpit gemini 账号(gemini_accounts.json,仅 plan_name,无成本数据) */
export interface CockpitGeminiAccount {
  id: string
  email?: string
  auth_id?: string
  plan_name?: string
  created_at?: number
  last_used?: number
}

/** 读 gemini 账号列表(仅 plan_name,无成本数据) */
export async function getCockpitGeminiAccounts(): Promise<CockpitGeminiAccount[]> {
  const data = await readJson<{ accounts: CockpitGeminiAccount[] }>('gemini_accounts.json')
  return data?.accounts ?? []
}

/** 读本地访问配置(含 modelPricings + tokenUsed) */
export async function getCockpitLocalAccess(): Promise<CockpitLocalAccess | null> {
  return readJson<CockpitLocalAccess>('codex_local_access.json')
}

/** 读 server.json(WS 端口/pid/version) */
export async function getCockpitServerInfo(): Promise<CockpitServerInfo | null> {
  return readJson<CockpitServerInfo>('server.json')
}

/** 读 codex-api 路由日志原文(当天),供 cockpitAdapter 解析路由审计。
 *  日志文件名含 '-' 和 .log,无法走 read_cockpit_file 白名单 → 走 read_cockpit_log_file。
 *  读当天日志(codex-api.log.YYYY-MM-DD,按本机日期)。非桌面端/文件缺失返 null。
 *  ponytail: 不指定 date 参数——成本中心只看当天路由,历史日志不读。 */
export async function getCockpitApiLog(): Promise<string | null> {
  if (!detectDesktop()) {
    console.warn(`[cockpit] ${NOT_DESKTOP_MSG}`)
    return null
  }
  // 本机日期格式化为 YYYY-MM-DD(Date.now 在 workflow 不可用,但这是运行时客户端非 workflow)
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const todayName = `codex-api.log.${yyyy}-${mm}-${dd}`
  try {
    return await invoke<string>('read_cockpit_log_file', { name: todayName })
  } catch (e) {
    // 当天日志不存在(今天还没请求):静默返 null
    console.warn('[cockpit] 读取当天路由日志失败:', errMsg(e, '当天无日志'))
    return null
  }
}

/** Rust 侧多天日志聚合结果(桶已按时间升序)。 */
export interface CockpitOpsBucket {
  bucket_start_ms: number
  request_count: number
  success_count: number
  error_count: number
  ttft_p50_ms: number | null
  ttft_p95_ms: number | null
  duration_p95_ms: number | null
}

/** 日志聚合的单账号请求归因(account_id 与 cockpit stats accountId 同一标识体系)。 */
export interface CockpitOpsAccountAgg {
  account_id: string
  requests: number
  success_count: number
  error_count: number
}

/** 日志聚合的路由明细(模型 × 账号 × 入站接口),支撑"真实模型/渠道/接口明细"表按窗口出数。
 *  此前该表只读当天 codex-api.log,切 7d/30d 数字纹丝不动——改由 Rust 按窗口聚合。 */
export interface CockpitOpsRouteAgg {
  model: string
  /** 日志未带 accountId 时为 null(不编造账号归属) */
  account_id: string | null
  /** 日志未带 path 时为 null */
  inbound_path: string | null
  requests: number
  success_count: number
  error_count: number
  /** 窗口内最早/最晚一条请求时间(ms),供明细表"调用时间"列渲染 */
  first_ms: number | null
  last_ms: number | null
}

export interface CockpitOpsSummary {
  buckets: CockpitOpsBucket[]
  accounts: CockpitOpsAccountAgg[]
  routes: CockpitOpsRouteAgg[]
  files_read: string[]
  requests_total: number
  /** 已读日志文件的日期范围:30d 窗口可能只有几天日志(保留期限制),
   *  前端据此判断滚动窗口是否被完整覆盖,覆盖不足时如实标注而非冒充完整窗口。 */
  min_date: string | null
  max_date: string | null
  /** 窗口级 TTFT 分位数(Rust `summarize_cockpit_api_logs` 返回 JSON 顶层新增,从原始样本算)。
   *  窗口内无首 token 样本时为 null —— 面板据此显示「无样本」,绝不落成 0(0 ms 是"瞬时返回"的断言)。
   *  可选:旧版 Rust 命令尚未返回该字段时 TS 仍能编译,面板保持现状。 */
  ttft_p50_ms?: number | null
  ttft_p95_ms?: number | null
}

/** 本机日期 → YYYY-MM-DD(本地时区)。 */
export function cockpitLocalDate(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * 多天 codex-api 日志 → Rust 侧聚合的请求时间桶(修复 7d/30d 观察窗口趋势无效)。
 *
 * 实测单天日志 40MB+/26k 行且按天滚动,前端 parseCockpitApiLog 有 25000 行截断,
 * 拼接多天既 OOM 又被截尾——聚合必须在 Rust 完成,这里只拿几 KB 的桶统计。
 * 日志无 token/成本字段,桶的 billed/cost 留 0,由快照口径补,不编造。
 *
 * startMs/endMs 是可选精确时间窗(闭区间):传了则只统计落在窗内的请求。
 * 不传=整天文件口径(会退化成"当天累计",短窗口不能这么用)。
 */
export async function getCockpitOpsSummary(
  startDate: string,
  endDate: string,
  bucketHours: number,
  startMs?: number | null,
  endMs?: number | null,
): Promise<CockpitOpsSummary | null> {
  if (!detectDesktop()) return null
  try {
    return await invoke<CockpitOpsSummary>('summarize_cockpit_api_logs', {
      startDate,
      endDate,
      bucketHours,
      startMs: startMs ?? null,
      endMs: endMs ?? null,
    })
  } catch (e) {
    console.warn('[cockpit] 多天日志聚合失败:', errMsg(e, '聚合失败'))
    return null
  }
}

/**
 * 分档 token 聚合(标准档 / 长文本档)。
 *
 * 缓存命中是 input 的**子集**,故"未命中输入"与"缓存命中"在 Rust 侧就拆开聚合,
 * 前端直接 × 对应单价,不需要再反推。
 */
export interface CockpitTokenSplit {
  requests: number
  success: number
  error: number
  /** 标准档:未命中缓存的输入 token */
  stdNormalInput: number
  /** 标准档:缓存命中 token */
  stdCached: number
  /** 标准档:输出 token */
  stdOutput: number
  /** 长文本档(单请求 input_tokens > 272_000):未命中缓存的输入 token */
  longNormalInput: number
  /** 长文本档:缓存命中 token */
  longCached: number
  /** 长文本档:输出 token */
  longOutput: number
  /** Actual per-request inclusive input bounds from this same source scan. */
  stdContextMin?: number | null
  stdContextMax?: number | null
  longContextMin?: number | null
  longContextMax?: number | null
  priceQuotes?: import('@/api/usageMonitor').MonitorCostEstimate[]
  /** cockpit 自己落库的估算成本(USD)之和。
   *  **仅**在某模型本项目无可用单价时作为诚实回退(并由 UI 标注口径),有单价时不读。 */
  estimatedCostUsd: number
  /** 失败中被判为"限流"的条数(error_category=quota_or_rate_limit 或 http_status=429)。 */
  rateLimited: number
  /** 失败中被判为"上游错误"的条数(error_category=upstream_error)。 */
  upstreamError: number
  /** 失败中被判为"客户端取消"的条数(error_category=client_canceled)。 */
  clientCanceled: number
  /**
   * 服务档位(`service_tier` 原文)。
   *
   * Rust 侧已把它放进聚合键 ⇒ 同一格/同一组只可能有一个档位值,计价方可对该批 token
   * 精确施加档位倍率(priority ×2 / flex ×0.5)。
   *
   * - `''` = **日志未记录档位**,**不等于** standard(倍率上恰好同为 ×1,但措辞不得声称
   *   "这是 standard 档");
   * - `null` / `undefined` = 该来源没有这个维度(如账本合并层 `mergedCellCost` 的输入)。
   */
  serviceTier?: string | null
}

/**
 * 单个时间桶的耗时分位数(桶边界与 cells 一致,可按 startMs 直接对齐)。
 *
 * 为什么不挂在 token 分档上:cells 是"桶 × 模型",而分位数**不可加**——
 * 把几个模型的 p95 求平均或取最大都是编造。延迟曲线要的是整桶的 p95,
 * 因此 Rust 侧在桶粒度重新取样。
 */
export interface CockpitBucketLatency {
  startMs: number
  /** 该桶内 latency_ms > 0 的样本数(判断可信度用) */
  samples: number
  p50Ms: number | null
  p95Ms: number | null
}

/** 时间桶 × 模型 一格(成本趋势 + 逐模型合计)。 */
export interface CockpitRequestLogCell extends CockpitTokenSplit {
  startMs: number
  model: string
}

/** 模型 × 上游账号 一格(逐账号成本 / 路由成本分摊)。 */
export interface CockpitRequestLogGroup extends CockpitTokenSplit {
  model: string
  /** 库里没有 accountId 时为空串(不编造账号归属) */
  accountId: string
  /** 发起请求的网关 API Key id(本地网关密钥用量表用);无则空串 */
  apiKeyId: string
  firstMs: number | null
  lastMs: number | null
}

/**
 * cockpit 单请求用量库聚合结果。
 *
 * 这是**唯一**带"单请求 token"的数据源:stats JSON 是日/周/月日历累计快照(无滚动窗口),
 * codex-api 日志干脆没有 token 字段(实测 grep inputTokens 命中 0)。没有它就无法按
 * cockpit 自己的规则判定长上下文档位价——实测 gpt-6-astra 会因此把成本算少近一半。
 */
export interface CockpitRequestLogSummary {
  priceQuoteError?: 'catalog_quote_unavailable'
  /** 库存在且查询成功。false = 旧版 cockpit 未落库,调用方回退快照口径并在 UI 标注。 */
  available: boolean
  reason?: string | null
  rowCount: number
  windowStartMs: number | null
  windowEndMs: number | null
  bucketHours: number
  cells: CockpitRequestLogCell[]
  groups: CockpitRequestLogGroup[]
  /**
   * 桶级耗时分位数。源:`request_logs.latency_ms`,实测覆盖 181,575/181,613 行
   * (99.98%,本机 07-29 起全量);而 cockpit 的 codex-api.log 只保留 ~5 天,
   * 所以 7d/30d 的"总耗时 P95"曲线必须靠它才画得出来。
   */
  bucketLatencies: CockpitBucketLatency[]
}

export async function quoteCockpitRequestLogSummary(summary: CockpitRequestLogSummary): Promise<CockpitRequestLogSummary> {
  if (!summary.available) return summary
  const items: ModelCatalogQuoteInput[] = []
  const targets = new Map<string, CockpitTokenSplit>()
  for (const [kind, rows] of [['group', summary.groups], ['cell', summary.cells]] as const) {
    rows.forEach((row, index) => {
      if (row.priceQuotes?.length) return
      const mode = row.serviceTier?.trim() || undefined
      for (const part of ['std', 'long'] as const) {
        const normal = part === 'std' ? row.stdNormalInput : row.longNormalInput
        const read = part === 'std' ? row.stdCached : row.longCached
        const output = part === 'std' ? row.stdOutput : row.longOutput
        const min = part === 'std' ? row.stdContextMin : row.longContextMin
        const max = part === 'std' ? row.stdContextMax : row.longContextMax
        if (normal + read + output === 0 && min == null && (part === 'long' || row.stdNormalInput + row.stdCached + row.stdOutput + row.longNormalInput + row.longCached + row.longOutput > 0)) continue
        const id = `cockpit:${kind}:${index}:${part}`
        items.push({ id, model: row.model, aggregate: true, inputTokens: normal + read, cacheReadTokens: read,
          outputTokens: output, cacheWriteTokens: 0,
          // Cockpit's native gateway records the request body's tier, not a response confirmation.
          requestedMode: mode,
          ...(min != null && max != null ? { contextMin: min, contextMax: max } : {}),
        })
        targets.set(id, row)
      }
    })
  }
  try {
    const quotes = await quoteModelCatalogBatch(items)
    for (const quote of quotes) {
      const row = targets.get(quote.id)
      if (row) (row.priceQuotes ??= []).push(quote.cost)
    }
  } catch {
    // Keep the verified offline book and the original source estimate intact.
    summary.priceQuoteError = 'catalog_quote_unavailable'
  }
  return summary
}

/**
 * cockpit 单请求用量库 → 按窗口聚合(模型×桶 / 模型×账号)。
 *
 * 与 getCockpitOpsSummary 的分工:
 *   - 本函数管 **token 与成本**(需要单请求 token 才能判长上下文档位价)
 *   - getCockpitOpsSummary 管 **路径/延迟/状态码**(只有日志有 path,库里没有)
 * 两者互补,谁都替代不了谁。
 *
 * 非桌面端/库缺失时返 null(不是抛错)——调用方据此回退,不让成本静默变 0。
 */
export async function getCockpitRequestLogSummary(
  bucketHours: number,
  startMs?: number | null,
  endMs?: number | null,
  /** false = 不要时间桶(只要"累计"口径的 groups),省约一半扫描开销 */
  includeCells = true,
): Promise<CockpitRequestLogSummary | null> {
  if (!detectDesktop()) return null
  try {
    const raw = await invoke<string>('summarize_cockpit_request_logs', {
      bucketHours,
      startMs: startMs ?? null,
      endMs: endMs ?? null,
      includeCells,
    })
    const parsed = JSON.parse(raw) as CockpitRequestLogSummary
    return parsed && typeof parsed.available === 'boolean' ? await quoteCockpitRequestLogSummary(parsed) : null
  } catch (e) {
    console.warn('[cockpit] 单请求用量库聚合失败:', errMsg(e, '聚合失败'))
    return null
  }
}

/** 列 cache/quota_history 下所有账号配额历史文件并批量读。
 *  quota_history 文件名是 sha256 哈希(非 [a-z_0-9]),无法走 read_cockpit_file → 走 read_cockpit_dir。
 *  每文件 = 一账号(email 维度),含按模型的配额消耗时序 points[]。
 *  非桌面端/目录缺失返空数组。 */
export async function getCockpitQuotaHistories(): Promise<CockpitQuotaHistoryFile[]> {
  if (!detectDesktop()) {
    console.warn(`[cockpit] ${NOT_DESKTOP_MSG}`)
    return []
  }
  try {
    const entries = await invoke<CockpitDirEntry[]>('read_cockpit_dir', {
      subdir: 'cache/quota_history',
      pattern: '*',
    })
    const results: CockpitQuotaHistoryFile[] = []
    for (const entry of entries) {
      try {
        const parsed = JSON.parse(entry.content) as CockpitQuotaHistoryFile
        if (parsed && parsed.email && parsed.models) {
          results.push(parsed)
        }
      } catch {
        // 单文件解析失败跳过(可能 .tmp 残留已过白名单)
      }
    }
    return results
  } catch (e) {
    console.warn('[cockpit] 读配额历史目录失败:', errMsg(e, '目录不存在'))
    return []
  }
}

/** 探测 cockpit 是否在运行(invoke check_cockpit_running) */
export async function isCockpitRunning(): Promise<boolean> {
  if (!detectDesktop()) return false
  try {
    return await invoke<boolean>('check_cockpit_running')
  } catch (e) {
    console.warn('[cockpit] 进程探测失败:', errMsg(e, '探测失败'))
    return false
  }
}

/** 读 antigravity 主账号列表(accounts.json v2.0,无成本数据,仅账号清单)
 *  cockpit 的 antigravity 平台账号,与 codex_accounts/gemini_accounts 并列。 */
export interface CockpitAntigravityAccount {
  id: string
  email?: string
  name?: string | null
  created_at?: number
  last_used?: number
}

export async function getCockpitAntigravityAccounts(): Promise<CockpitAntigravityAccount[]> {
  const data = await readJson<{ accounts: CockpitAntigravityAccount[] }>('accounts.json')
  return data?.accounts ?? []
}

/** cockpit 通用平台账号(claude/cursor/kiro 等,结构与 gemini_accounts 一致:accounts[] 含 id/email/plan) */
export interface CockpitPlatformAccount {
  id: string
  email?: string
  plan_name?: string
  plan_type?: string
  subscription_active_until?: string
  auth_id?: string
  created_at?: number
  last_used?: number
}

/** 读任意平台账号 JSON(claude_accounts/cursor_accounts/kiro_accounts 等,结构一致)。
 *  name 复用 readJson,Rust 侧白名单已校验 a-z_0-9.json 防目录穿越。 */
export async function getCockpitPlatformAccounts(name: string): Promise<CockpitPlatformAccount[]> {
  const data = await readJson<{ accounts: CockpitPlatformAccount[] }>(name)
  return data?.accounts ?? []
}

/**
 * cockpit 账号分组定义。
 *
 * 源(cockpit 源码,只读依据):
 * - antigravity 平台:`cockpit-tools-main/src-tauri/src/commands/account.rs:773`
 *   (`GROUPS_FILE = "account_groups.json"`),结构见
 *   `cockpit-tools-main/src/services/accountGroupService.ts:16`
 *   `AccountGroup { id, name, accountIds: string[], createdAt }`。
 * - codex 平台:`cockpit-tools-main/src-tauri/src/commands/codex_model_provider_commands.rs:7`
 *   (`CODEX_GROUPS_FILE = "codex_account_groups.json"`),结构见
 *   `cockpit-tools-main/src/services/codexAccountGroupService.ts:31`
 *   `CodexAccountGroup { id, name, sortOrder, accountIds: string[], createdAt, quotaAutoRefreshMinutes }`。
 *
 * 两者都是**顶层 JSON 数组**(Rust 侧 `validate_account_groups_payload` 强制 array)。
 * 分组只含 `accountIds`,不含渠道/模型;它描述的是"账号被用户归到哪个组",
 * 与 sub2api 的计费分组同名不同义——展示时必须标注来源,不得冒充 sub2api 分组。
 */
export interface CockpitAccountGroup {
  id: string
  name: string
  /** 组内账号 id(与 codex_accounts.json / accounts.json 的 account id 同一标识体系)。 */
  accountIds: string[]
  /** 仅 codex 分组有(用于 cockpit 侧排序)。 */
  sortOrder?: number
  createdAt?: number
}

/** 读 antigravity 平台账号分组(account_groups.json)。文件不存在/非数组 → 空数组。 */
export async function getCockpitAccountGroups(): Promise<CockpitAccountGroup[]> {
  const data = await readJson<CockpitAccountGroup[]>('account_groups.json')
  return Array.isArray(data) ? data : []
}

/** 读 codex 账号分组(codex_account_groups.json)。文件不存在/非数组 → 空数组。 */
export async function getCockpitCodexAccountGroups(): Promise<CockpitAccountGroup[]> {
  const data = await readJson<CockpitAccountGroup[]>('codex_account_groups.json')
  return Array.isArray(data) ? data : []
}

/** cockpit 自定义模型提供商(codex_model_providers.json,用户配的第三方 OpenAI 兼容上游) */
export interface CockpitModelProviderKey {
  id: string
  name?: string
  apiKey: string
  createdAt?: number
  updatedAt?: number
}
export interface CockpitModelProvider {
  id: string
  name: string
  baseUrl: string
  supportsVision?: boolean
  wireApi?: string
  enableModePreference?: string
  apiKeys?: CockpitModelProviderKey[]
  createdAt?: number
  updatedAt?: number
}

export async function getCockpitModelProviders(): Promise<CockpitModelProvider[]> {
  const data = await readJson<CockpitModelProvider[]>('codex_model_providers.json')
  return data ?? []
}

/** cockpit apikey 账号→渠道名映射(Rust 侧算 md5(apiKey) 建映射)。
 *  cockpit stats 的 apikey 账号 accountId = codex_apikey_<md5(apiKey)>,
 *  Rust 读 codex_model_providers.json 对每个 apiKey 算 md5,返回 {accountId, name}。
 *  前端无 MD5 库(Web Crypto 不支持 MD5),走 Rust command。 */
export interface CockpitApiKeyMap {
  accountId: string
  name: string
  baseUrl: string
}

export async function getCockpitApiKeyNames(): Promise<CockpitApiKeyMap[]> {
  if (!detectDesktop()) {
    console.warn(`[cockpit] ${NOT_DESKTOP_MSG}`)
    return []
  }
  try {
    return await invoke<CockpitApiKeyMap[]>('read_cockpit_apikey_names')
  } catch (e) {
    console.warn('[cockpit] 读 apikey 渠道名映射失败:', errMsg(e, '读取失败'))
    return []
  }
}

/** 汇总 cockpit 连接状态(available=装了且能读,running=数据可读即视为运行中)
 *  ponytail: 不再调 isCockpitRunning(invoke tasklist)——避免触发子进程拉起。
 *  server.json 或 stats.json 可读即 available,running 等同 available。 */
export async function getCockpitConnectionState(): Promise<CockpitConnectionState> {
  if (!detectDesktop()) {
    return { available: false, running: false, reason: NOT_DESKTOP_MSG }
  }
  const [server, stats] = await Promise.all([
    getCockpitServerInfo(),
    getCockpitStats(),
  ])
  const available = !!(server || stats)
  return {
    available,
    running: available,
    reason: available ? undefined : 'cockpit 未安装或未生成数据(未运行过 cockpit-tools)',
  }
}

/** cockpit 模式本地成本档案(cockpit 无后端,手动配置的采购价存本地 JSON)。
 *  key=完整来源+原始账号标识；旧数字键仅保留，不据此猜测归属。
 *  value=CostProfile(model.ts resolveCostProfile 读 extra.cost_profile 的同结构)。
 *  sub2api 存 PG,cockpit 存本地 JSON——对齐"采购价需手动补充"语义。 */
export type CostProfileMap = Record<string, import('@/features/cost-center/model').CostProfile>

/** 读本地成本档案 map。文件不存在(首次使用)或非桌面运行时返空对象。 */
export async function readCostProfiles(): Promise<CostProfileMap> {
  if (!detectDesktop()) return {}
  const raw = await invoke<string>('read_cost_profiles')
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid local cost profile file: expected an object')
  return parsed as CostProfileMap
}

/** 全量写本地成本档案 map(Rust 侧落盘到 %APPDATA%/2api-console/cockpit_cost_profiles.json)。 */
export async function writeCostProfiles(map: CostProfileMap): Promise<void> {
  if (!detectDesktop()) throw new Error('Local cost profiles can only be saved in the desktop app')
  await invoke('write_cost_profiles', { json: JSON.stringify(map, null, 2) })
}

/** 用量台账条目:按 email 保留的累计用量快照(email 是 cockpit 账号重建前后的稳定键)。
 *  cockpit 移除 API/账号会清数据、重新加入从 0 计数——台账让成本端不丢这些用量。 */
export interface CockpitLedgerEntry {
  email: string
  /** 快照时间(ms),超上限时裁最旧的 */
  updatedAt: number
  usage: CockpitUsageStats
}

/** 用量台账文件结构(cockpit_usage_ledger.json) */
export interface CockpitUsageLedger {
  accounts: CockpitLedgerEntry[]
}

/** 台账条目上限:超出裁 updatedAt 最旧条目,防文件无限膨胀 */
export const COCKPIT_LEDGER_CAP = 2000

/** 读用量台账。文件不存在/非桌面/旧版宿主缺命令 → 返 null(调用方跳过合并,优雅降级)。 */
export async function readCostLedger(): Promise<CockpitUsageLedger | null> {
  if (!detectDesktop()) return null
  try {
    const raw = await invoke<string>('read_cost_ledger')
    const parsed = raw ? (JSON.parse(raw) as CockpitUsageLedger | null) : null
    return parsed && Array.isArray(parsed.accounts) ? parsed : null
  } catch (e) {
    console.warn('[cockpit] 读用量台账失败(旧版宿主可忽略):', errMsg(e, '读取失败'))
    return null
  }
}

/** 全量写用量台账(Rust 落盘 %APPDATA%/2api-console/cockpit_usage_ledger.json)。
 *  写失败仅告警不抛(台账是附加保障,不能阻塞主数据加载)。 */
export async function writeCostLedger(entries: CockpitLedgerEntry[]): Promise<void> {
  if (!detectDesktop()) return
  try {
    const payload: CockpitUsageLedger = { accounts: entries.slice(0, COCKPIT_LEDGER_CAP) }
    await invoke('write_cost_ledger', { json: JSON.stringify(payload, null, 2) })
  } catch (e) {
    console.warn('[cockpit] 写用量台账失败(旧版宿主可忽略):', errMsg(e, '写入失败'))
  }
}

/** 写 cockpit 本地 JSON 文件(账号导入/路由规则更新等)。
 *  name 白名单同 read_cockpit_file:[a-z_0-9]+\.json,防目录穿越。
 *  content 由前端序列化为 JSON 字符串传入,Rust 侧全量覆盖落盘。 */
export async function writeCockpitFile(name: string, content: string): Promise<void> {
  if (!detectDesktop()) {
    throw new Error(NOT_DESKTOP_MSG)
  }
  await invoke('write_cockpit_file', { name, content })
}

/** 导入账号到 cockpit codex_accounts.json。
 *  读取现有 accounts → 合并新账号(去重 by id) → 全量写回。
 *  返回 { added, skipped, total } 统计。 */
export interface CockpitImportResult {
  added: number
  skipped: number
  total: number
  message: string
}

export async function importCockpitCodexAccounts(
  newAccounts: CockpitCodexAccount[],
): Promise<CockpitImportResult> {
  if (!detectDesktop()) {
    throw new Error(NOT_DESKTOP_MSG)
  }
  // 读现有 accounts
  const existing = await getCockpitCodexAccounts()
  const existingIds = new Set(existing.map((a) => a.id))
  let added = 0
  let skipped = 0
  for (const acc of newAccounts) {
    if (existingIds.has(acc.id)) {
      skipped++
    } else {
      existing.push(acc)
      existingIds.add(acc.id)
      added++
    }
  }
  // 全量写回
  await writeCockpitFile('codex_accounts.json', JSON.stringify({ accounts: existing }, null, 2))
  return {
    added,
    skipped,
    total: existing.length,
    get message() { return i18n.global.t('costCenter.api.importAccounts', { added, skipped, total: existing.length }) },
  }
}

/** 导入路由规则到 cockpit codex_local_access.json。
 *  读现有 localAccess → 合并 customRoutingRules → 全量写回。
 *  返回 { added, skipped, total } 统计。 */
export async function importCockpitRoutingRules(
  rules: Array<{ accountId: string; priority: number; weight: number; isBackup?: boolean; isPreferred?: boolean }>,
): Promise<CockpitImportResult> {
  if (!detectDesktop()) {
    throw new Error(NOT_DESKTOP_MSG)
  }
  const localAccess = await getCockpitLocalAccess()
  const existingRules = localAccess?.customRoutingRules ?? []
  const existingAccountIds = new Set(existingRules.map((r) => r.accountId))
  let added = 0
  let skipped = 0
  for (const rule of rules) {
    if (existingAccountIds.has(rule.accountId)) {
      // 更新已有规则
      const idx = existingRules.findIndex((r) => r.accountId === rule.accountId)
      if (idx >= 0) existingRules[idx] = rule
      skipped++
    } else {
      existingRules.push(rule)
      existingAccountIds.add(rule.accountId)
      added++
    }
  }
  const updatedLocalAccess = {
    ...localAccess,
    customRoutingRules: existingRules,
  }
  await writeCockpitFile('codex_local_access.json', JSON.stringify(updatedLocalAccess, null, 2))
  return {
    added,
    skipped,
    total: existingRules.length,
    get message() { return i18n.global.t('costCenter.api.importRules', { added, skipped, total: existingRules.length }) },
  }
}
