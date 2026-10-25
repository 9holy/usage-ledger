import { costDataText } from './costDataText'
import { formatDate as formatDateByLocale } from '@/utils/format'
export interface AccountProbeState {
  loading: boolean
  success?: boolean
  latency_ms?: number
  message?: string
}

export type AccountRankingMetric = 'score' | 'output' | 'requests' | 'cost' | 'latency' | 'reliability'

export interface AccountRankingEvidenceInput {
  /** Explicit display basis: local reference value or actual user charge, never copied into user_cost. */
  outputUsd?: number | null
  today?: {
    requests?: number | null
    cost?: number | null
    user_cost?: number | null
  } | null
  probe?: AccountProbeState
  state: CurrentAccountState['state']
}

// A scheduler score by itself is not proof that an account produced traffic or
// was successfully tested. Keep unobserved accounts out of numbered rankings so
// a newly-added, idle provider cannot outrank accounts with factual evidence.
export function hasAccountRankingEvidence(
  metric: AccountRankingMetric,
  input: AccountRankingEvidenceInput,
): boolean {
  const requests = Number(input.today?.requests || 0)
  const accountCost = Number(input.today?.cost || 0)
  const output = input.outputUsd === undefined ? input.today?.user_cost : input.outputUsd
  const probeCompleted = input.probe?.success != null

  if (metric === 'output') return typeof output === 'number' && Number.isFinite(output) && output > 0
  if (metric === 'requests') return requests > 0
  if (metric === 'cost') return accountCost > 0
  if (metric === 'latency') return probeCompleted && Number.isFinite(input.probe?.latency_ms)
  return requests > 0 || probeCompleted || input.state !== 'normal'
}

/**
 * 「按延迟排序」用的证据 —— **来源按源不同**(2026-09-22)。
 *
 * `probes` 里装的只是**主动探测**结果,而三个源拿延迟的方式不一样:
 *
 * | 源 | 来源 | 落在哪 |
 * |---|---|---|
 * | sub2api | `runProbe` → adminAPI.testAccount | `probes` |
 * | cliproxy | CPA **历史**请求延迟(不调 adminAPI,不推导当前健康) | `historicalLatencyMs` |
 * | **cockpit** | 单请求用量库 `totalLatencyMs / requestCount` | **`cockpitAvgLatency`**,`probes` 恒为空 |
 *
 * `probes` 在切源时会被清空(`useCostCenterData.ts` 的 `applySourceKey`),而 cockpit 没有任何
 * 写入路径 ⇒ 排序键与「有无证据」若只读 `probes`,cockpit 下**每个账号都没有证据**:
 * 排序键全是 `+∞`(排不出来),`hasAccountRankingEvidence('latency')` 恒假 ⇒ 排名列一个序号都不出,
 * 而延迟列明明显示着真实毫秒数。这正是「同一个 `probes` 只按两源门控」的漏网。
 *
 * 所以两个本地来源的延迟证据由调用方从各自的历史样本传进来:
 * 有值才算有证据;`null`(无延迟样本)仍算**没有证据** —— 不得凭空造一个延迟。
 */
export function latencyRankingProbe(
  source: 'sub2api' | 'cliproxy' | 'cockpit',
  probe: AccountProbeState | undefined,
  historicalLatencyMs: number | null,
): AccountProbeState | undefined {
  if (source === 'sub2api') return probe
  return historicalLatencyMs == null || !Number.isFinite(historicalLatencyMs)
    ? undefined
    : { loading: false, success: true, latency_ms: historicalLatencyMs, message: source === 'cliproxy'
      ? costDataText('cpaHistoricalRequestLatency') : costDataText('cockpitRequestStoreAverageLatency') }
}

export interface CurrentAccountStateInput {
  status: 'active' | 'inactive' | 'error'
  schedulable?: boolean
  error_message?: string | null
  rate_limited_at?: string | null
  rate_limit_reset_at?: string | null
  overload_until?: string | null
  temp_unschedulable_until?: string | null
  temp_unschedulable_reason?: string | null
  extra?: {
    model_rate_limits?: Record<string, { rate_limit_reset_at?: string | null }>
  } | null
}

type SchedulerSettings = Record<string, unknown> | null | undefined

const SCHEDULER_BASE_WEIGHTS = [
  ['openai_advanced_scheduler_effective_weight_priority', 1],
  ['openai_advanced_scheduler_effective_weight_load', 1],
  ['openai_advanced_scheduler_effective_weight_queue', 0.7],
  ['openai_advanced_scheduler_effective_weight_error_rate', 0.8],
  ['openai_advanced_scheduler_effective_weight_ttft', 0.5],
  ['openai_advanced_scheduler_effective_weight_reset', 0],
  ['openai_advanced_scheduler_effective_weight_quota_headroom', 0],
  ['openai_advanced_scheduler_effective_weight_upstream_cost', 0],
] as const

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function resolveSchedulerBaseScoreMax(settings: SchedulerSettings): number {
  const total = SCHEDULER_BASE_WEIGHTS.reduce((sum, [key, fallback]) => {
    return sum + nonNegativeNumber(settings?.[key], fallback)
  }, 0)
  return total > 0 ? total : 4
}

export function normalizeSchedulerScore(rawScore: number, maxScore: number): number {
  if (!Number.isFinite(rawScore) || !Number.isFinite(maxScore) || maxScore <= 0) return 0
  return Math.max(0, Math.min(100, rawScore / maxScore * 100))
}

function isFuture(value: string | null | undefined, now: Date): boolean {
  if (!value) return false
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) && timestamp > now.getTime()
}

function resetLabel(value: string): string {
  const resetAt = new Date(value)
  return Number.isFinite(resetAt.getTime())
    ? formatDateByLocale(resetAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : value
}

export interface CurrentAccountState {
  error: 0 | 1
  limited: 0 | 1
  note: string
  state: 'normal' | 'limited' | 'error' | 'inactive'
  label: string
}

export function describeCurrentAccountState(
  account: CurrentAccountStateInput,
  probe?: AccountProbeState,
  now = new Date(),
): CurrentAccountState {
  const probeMessage = probe?.success === false ? String(probe.message || costDataText('realUpstreamProbeFailed')) : ''
  const probeIsLimit = /\b429\b|rate.?limit|usage_limit/i.test(probeMessage)
  if (probeMessage) {
    return probeIsLimit
      ? { error: 0, limited: 1, state: 'limited', label: costDataText('probeRateLimited'), note: probeMessage }
      : { error: 1, limited: 0, state: 'error', label: costDataText('probeFailed'), note: probeMessage }
  }

  const activeRateLimit = isFuture(account.rate_limit_reset_at, now)
  const activeOverload = isFuture(account.overload_until, now)
  const activeTempBlock = isFuture(account.temp_unschedulable_until, now)
  const activeModelLimits = Object.entries(account.extra?.model_rate_limits ?? {})
    .filter(([, value]) => isFuture(value?.rate_limit_reset_at, now))

  if (account.status === 'error') {
    return { error: 1, limited: activeRateLimit ? 1 : 0, state: 'error', label: costDataText('error'), note: account.error_message || costDataText('accountDisabledByAnUpstreamError') }
  }
  if (account.status === 'inactive') {
    return { error: 0, limited: 0, state: 'inactive', label: costDataText('inactive'), note: costDataText('accountIsCurrentlyInactive') }
  }
  if (activeRateLimit && account.rate_limit_reset_at) {
    return { error: 0, limited: 1, state: 'limited', label: costDataText('status429RateLimit'), note: costDataText('currentlyRateLimitedExpectedResetAt', { p0: resetLabel(account.rate_limit_reset_at) }) }
  }
  if (activeTempBlock) {
    return { error: 0, limited: 1, state: 'limited', label: costDataText('temporarilyUnschedulable'), note: account.temp_unschedulable_reason || costDataText('upstreamIsTemporarilyUnschedulable') }
  }
  if (activeOverload && account.overload_until) {
    return { error: 0, limited: 1, state: 'limited', label: costDataText('upstreamOverloaded'), note: costDataText('overloadProtectionUntil', { p0: resetLabel(account.overload_until) }) }
  }
  if (activeModelLimits.length > 0) {
    return { error: 0, limited: 1, state: 'limited', label: costDataText('modelRateLimit'), note: costDataText('currentlyUnschedulable', { p0: activeModelLimits.map(([model]) => model).join('、') }) }
  }
  if (account.schedulable === false) {
    return { error: 1, limited: 0, state: 'error', label: costDataText('removedFromScheduling'), note: account.error_message || costDataText('accountRemovedFromTheSchedulerPool') }
  }
  return { error: 0, limited: 0, state: 'normal', label: costDataText('schedulable'), note: costDataText('currentStatusIsNormal') }
}
