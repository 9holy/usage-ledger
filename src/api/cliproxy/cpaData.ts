/**
 * CPA Token Usage 插件本地数据源 API
 *
 * 直读插件文件(经 Rust command),不走 cliproxy /v0/management:
 * - usage.db(SQLite usage_events 表,完整用量历史 1629+ 行,30 天窗口)
 * - model_prices.cache(LiteLLM 3213 模型 per-token USD 官方定价)
 *
 * Rust 侧只读连接(避免锁 WAL);api_key 明文禁止返回(已省略)。
 */

import { invoke } from '@tauri-apps/api/core'
import type { UsageQueryWindow } from '@/features/cost-center/usageWindow'
import { quoteModelCatalogBatch, type ModelCatalogQuoteInput } from '@/api/modelCatalog'
import type { MonitorCostEstimate } from '@/api/usageMonitor'

/** CPA usage_events 一行(Rust 侧 serde 已把 requested_at 秒→毫秒;api_key 明文已省略)。 */
export interface CliproxyUsageEvent {
  /** Some installed native readers omit this column. Never use it as a batch join key. */
  id?: number
  /** 毫秒级时间戳(Rust 侧秒×1000,供 new Date(ms) 与时间桶数值比较)。 */
  requested_at: number
  provider: string
  executor_type: string
  model: string
  alias: string
  auth_index: string
  auth_type: string
  source: string
  reasoning_effort: string
  service_tier: string
  /** Requested tier is not evidence of the final response mode. */
  response_service_tier?: string | null
  priceQuote?: MonitorCostEstimate
  priceQuoteError?: 'catalog_quote_unavailable'
  latency_ms: number
  ttft_ms: number
  failed: boolean
  status_code: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cached_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  total_tokens: number
  /** 5h 窗口用量百分比(实测 primary_reset_at − requested_at ≈ 4.69h)。 */
  primary_used_percent: number | null
  /** 5h 窗口重置时刻(unix 秒)。 */
  primary_reset_at: number | null
  primary_used_tokens: number | null
  primary_remaining_tokens: number | null
  primary_limit_tokens: number | null
  /** 独立 7d 窗口用量百分比(实测 secondary_reset_at − requested_at ≈ 6.78d;与 primary 不是同一窗口)。 */
  secondary_used_percent: number | null
  /** 独立 7d 窗口重置时刻(unix 秒)。**非空才算源真的报了 7d 窗口** —— 实测存在
   *  `secondary_used_percent=0` 且本字段为空的记录,那是"上游没报这个窗口"的缺省编码,不是"用了 0%"。 */
  secondary_reset_at: number | null
  /** 以下三个 token 级字段实测全表恒 NULL(7700 行 0 行非空),不可得 ⇒ 不得填 0。 */
  secondary_used_tokens: number | null
  secondary_remaining_tokens: number | null
  secondary_limit_tokens: number | null
}

/** LiteLLM model_prices.cache 单模型定价(per-token USD)。仅取成本反算所需字段。 */
export interface LitellmPricing {
  input_cost_per_token?: number
  output_cost_per_token?: number
  /** service_tier=priority 用(实测数据为 auto,用基础价)。 */
  input_cost_per_token_priority?: number
  output_cost_per_token_priority?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost_priority?: number
  cache_read_input_token_cost_priority?: number
  litellm_provider?: string
}

/** Mirrors CLIProxy usage/accounting.go: OpenAI cache is a subset, Claude's is independent. */
export function cliproxyTokenBreakdown(event: CliproxyUsageEvent): Pick<ModelCatalogQuoteInput, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'contextTokens'> {
  const executor = event.executor_type.toLowerCase(), provider = event.provider.toLowerCase()
  const subset = executor === 'openaicompatexecutor' || provider === 'openai-compatibility' || provider.startsWith('openai-compatible-')
  const source = `${provider} ${executor}`
  const independent = !subset && /claude|anthropic/.test(source)
  const separateReasoning = !subset && !independent && /gemini|aistudio|antigravity|vertex|interaction/.test(source)
  const knownSubset = subset || (!independent && !separateReasoning && /openai|codex|xai|grok|kimi|qwen|deepseek|openrouter/.test(source))
  const write = event.cache_creation_tokens
  // Legacy cached_tokens includes cache creation; never count that part as a cache hit.
  const read = Math.max(event.cache_read_tokens, event.cached_tokens - write, 0)
  const input = independent ? event.input_tokens + read + write
    : knownSubset || separateReasoning || read + write === 0 ? event.input_tokens : undefined
  const output = separateReasoning ? event.output_tokens + event.reasoning_tokens
    : knownSubset || independent || event.reasoning_tokens === 0 ? event.output_tokens : undefined
  return { inputTokens: input, contextTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write }
}

export function cliproxyQuoteInput(event: CliproxyUsageEvent): Omit<ModelCatalogQuoteInput, 'id'> {
  const provider = event.provider.trim()
  // Compatibility route names and auth-provider labels are not catalog provider identities.
  const opaqueProvider = event.executor_type.toLowerCase() === 'openaicompatexecutor'
    || /^(openai-compatible|openai-compatibility|codex|claude|gemini|antigravity)(-|$)/i.test(provider)
  return {
    model: event.model,
    ...(!opaqueProvider && provider ? { provider } : {}),
    actualMode: event.response_service_tier?.trim().toLowerCase() || undefined,
    requestedMode: event.service_tier || undefined,
    timestampMs: event.requested_at,
    ...cliproxyTokenBreakdown(event),
  }
}

async function quoteCliproxyEvents(events: CliproxyUsageEvent[]): Promise<CliproxyUsageEvent[]> {
  const pending = events.map((event, index) => ({ event, id: `cpa:${index}` })).filter(({ event }) => !event.priceQuote)
  if (!pending.length) return events
  try {
    const quotes = new Map((await quoteModelCatalogBatch(pending.map(({ event, id }) => ({ id, ...cliproxyQuoteInput(event) })))).map(quote => [quote.id, quote.cost]))
    for (const { event, id } of pending) event.priceQuote = quotes.get(id)
  } catch {
    // Native catalog unavailable: callers keep the explicit offline fallback, not a fake quote.
    for (const { event } of pending) event.priceQuoteError = 'catalog_quote_unavailable'
  }
  return events
}

/** 读 CPA 插件 usage.db 的 usage_events(最近 30 天)。插件未安装时返空数组。 */
export async function getCliproxyUsageEvents(): Promise<CliproxyUsageEvent[]> {
  const json = await invoke<string>('read_cliproxy_usage_events')
  return quoteCliproxyEvents(JSON.parse(json) as CliproxyUsageEvent[])
}

export interface CliproxyUsageSnapshot {
  available: boolean
  events: CliproxyUsageEvent[]
  readStartMs: number | null
  readEndMs: number | null
}

export async function getCliproxyUsageSnapshot(window?: UsageQueryWindow): Promise<CliproxyUsageSnapshot> {
  const startMs = window?.start.getTime(), endMs = window?.end.getTime()
  if (window && (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs! >= endMs!)) throw new Error('Invalid CPA query window')
  const json = await invoke<string>('read_cliproxy_usage_events', { withMetadata: true, ...(window ? { startMs, endMs } : {}) })
  const snapshot = JSON.parse(json) as CliproxyUsageSnapshot | CliproxyUsageEvent[]
  if (Array.isArray(snapshot)) return { available: false, events: await quoteCliproxyEvents(snapshot), readStartMs: null, readEndMs: null }
  if (!snapshot || typeof snapshot.available !== 'boolean' || !Array.isArray(snapshot.events)) throw new Error('Invalid CPA usage snapshot')
  await quoteCliproxyEvents(snapshot.events)
  return snapshot
}

/** 读 CPA 插件 model_prices.cache(LiteLLM 3213 模型 per-token USD)。不存在时返空对象。 */
export async function getCliproxyModelPrices(): Promise<Record<string, LitellmPricing>> {
  const json = await invoke<string>('read_cliproxy_model_prices')
  return JSON.parse(json) as Record<string, LitellmPricing>
}
