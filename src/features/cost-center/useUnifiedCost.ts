import { costDataText } from './costDataText'
/** Same-window source records. Local databases stay local; remote reads own their connection. */

import { ref, computed, type Ref } from 'vue'
import { isDesktopRuntime } from '@/api/url'
import { useConnectionStore, type ConnectionConfig } from '@/stores/connection'
import {
  getCockpitStats,
  getCockpitCodexAccounts,
  getCockpitRequestLogSummary,
  getCockpitLocalAccess,
  type CockpitStats,
  type CockpitCodexAccount,
} from '@/api/cockpit'
import { getCliproxyUsageSnapshot, getCliproxyModelPrices, type CliproxyUsageSnapshot, type CliproxyUsageEvent, type LitellmPricing } from '@/api/cliproxy/cpaData'
import { cliproxyEventsPricedCost, pricedEventCostUsd, resolveModelPricing } from './cliproxyAdapter'
import { cockpitSplitCostUsd, isCockpitSentinelZero } from './cockpitAdapter'
import { cockpitEffectivePriceSets, cockpitPriceSetFor } from './cockpitPriceBook'
import { readSub2apiWindow, windowCostReading, type WindowCostReading } from './unifiedSourceReader'
import {
  isUnknownCostBasis,
  noPriceNoEstimateCost,
  pricedCost,
  sourceEstimateCost,
  type CostBasisKind,
  type PricedCost,
} from './costBasis'
import { resolveCostMultiplier } from './costMultiplier'
import type { CostBasis } from './costBasis'
import { usageWindowBounds, type UsageQueryWindow } from './usageWindow'
import type { CostCenterRange } from './useCostCenterData'
import type { CliproxyCostEstimate, CliproxyCostByModel } from './cliproxyCostEstimate'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'

export type UnifiedSourceKey = 'sub2api' | 'cliproxy' | 'cockpit'

/**
 * 总成本大数下方的口径提醒文案(纯函数,便于单测)。
 *
 * ★ 「有 N 个端有数据」不等于「总额 = 全部选中端之和」:成本拿不到的端**没有**进入
 *   `totalCostUsd`,不点名就等于宣称总额是完整的 ——
 *   "界面不得暗示系统掌握了它并不掌握的信息"。
 *
 * @param totalCostUsd 已算出的总成本;null = 没有可用分项
 * @param unmeasured 被选中、源也在,但成本拿不到的端
 */
export function unmeasuredSourcesNote(totalCostUsd: number | null, unmeasured: UnifiedSourceKey[]): string {
  const names = unmeasured.join('、')
  if (totalCostUsd == null) {
    return unmeasured.length ? costDataText('noSelectedSourceHasUsableCostsCannotBeCalculated', { p0: names }) : costDataText('noSelectedSourceHasUsableCosts')
  }
  return unmeasured.length ? costDataText('excludedSourcesCostsCannotBeCalculatedTotalIncludesThe', { p0: unmeasured.length, p1: names }) : ''
}

/**
 * 总成本大数下方的**下界**提醒(纯函数,便于单测)。
 *
 * `unmeasuredSourcesNote` 管的是"**完全没进**总额的端";这一条管"进了总额、但数值本身是**下界**"的端 ——
 * 部分用量没有单价时,那部分贡献的是哨兵 0(见 costBasis.ts `noPriceNoEstimateCost`),
 * 总额因此**不高于**真实成本。不标注就等于把一个下界当实测总额展示
 * —— 与"界面不得暗示系统掌握了它并不掌握的信息"是同一条红线。
 *
 * @param partial 已计入总额、但数值是下界的端
 */
export function lowerBoundSourcesNote(partial: UnifiedSourceKey[]): string {
  if (!partial.length) return ''
  return costDataText('areLowerBoundsSomeUnpricedUsageExcludedTheTotal', { p0: partial.join('、') })
}

/** The summary emits window units; cumulative remains a compatibility type for historical detail. */
export type CostUnit = 'cumulative' | 'window'

const STORAGE_KEY = '2api-console.unified-sources'
const DEFAULT_SOURCES: UnifiedSourceKey[] = ['sub2api', 'cliproxy', 'cockpit']

function loadSelectedSources(): Set<UnifiedSourceKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set(DEFAULT_SOURCES)
    const arr = JSON.parse(raw) as UnifiedSourceKey[]
    const valid = arr.filter(k => k === 'sub2api' || k === 'cliproxy' || k === 'cockpit')
    return valid.length ? new Set(valid) : new Set(DEFAULT_SOURCES)
  } catch {
    return new Set(DEFAULT_SOURCES)
  }
}

function saveSelectedSources(set: Set<UnifiedSourceKey>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)))
}

export interface SourceStatus {
  period: { startMs: number; endMs: number } | null
  instanceId: string | null
  coverageBasis: WindowCostReading['coverageBasis']
  latestRecordMs: number | null
  records: number | null
  tokens: number | null
  /** 该端是否被选中汇总 */
  selected: boolean
  /** 数据状态:loading/measured/estimated/partial/unavailable/empty
   *  `partial` = 有值、但只是**下界**(部分用量算不出来,未计入) */
  state: 'loading' | 'measured' | 'estimated' | 'partial' | 'unavailable' | 'empty'
  /** 状态原因/提示 */
  reason: string
}

export function useUnifiedCost(
  _accountEconomics: Ref<AccountEconomicsSnapshot | null>,
  costMultiplier?: Ref<number>,
  _sub2apiFallbackUsd?: Ref<number | null>,
  // Retained for the separately labelled cumulative account detail, never the window summary.
  cockpitCumulativeCost?: Ref<Record<string, number> | null>,
  _cockpitCumulativeTotalUsd?: Ref<number | null>,
  _cockpitCumulativeCostBasis?: Ref<CostBasisKind | null>,
  cockpitCumulativeAccountBasis?: Ref<Record<string, CostBasisKind> | null>,
) {
  const connectionStore = useConnectionStore()
  const isDesktop = isDesktopRuntime()

  /** 当前连接的数据源。null(桌面本机)= cockpit。 */
  const activeSource = computed<UnifiedSourceKey>(() => {
    const t = connectionStore.active?.type
    if (t === 'sub2api') return 'sub2api'
    if (t === 'cliproxy') return 'cliproxy'
    return 'cockpit'
  })
  // 倍率兜底:未手动设置成本价格时官方价格 × 倍率(与 costEngine/accountLedgers 同口径)。
  // cockpit/cliproxy 的成本都是官方价反算,汇总口径必须与 economics 快照一致乘倍率;
  // sub2api 读的 account_cost_usd 已含 account_rate_multiplier,不重复乘。
  // 倍率兜底唯一实现在 costMultiplier.ts(架构设计 【F】7.1 / P0-16)
  const multiplier = computed(() => resolveCostMultiplier(costMultiplier?.value))

  const selectedSources = ref<Set<UnifiedSourceKey>>(loadSelectedSources())
  const loading = ref(false)
  const error = ref('')

  // cockpit 数据
  const cockpitStats = ref<CockpitStats | null>(null)
  const cockpitAccounts = ref<CockpitCodexAccount[]>([])
  const cockpitAvailable = ref(false)

  // cliproxy 数据
  const cliproxyEstimate = ref<CliproxyCostEstimate | null>(null)
  /** cliproxy 总成本的计价依据标注(P0-17:无单价时不是 $0,是"算不出") */
  const cliproxyCostBasis = ref<CostBasis>({ kind: 'priced' })
  /** cliproxy 总成本口径文案(UI 角标) */
  const cliproxyCostLabel = ref('')
  /** Reuse only snapshots whose explicit read bounds contain the requested period. */
  const injectedPrices = ref<Record<string, LitellmPricing> | null>(null)
  const injectedSnapshot = ref<CliproxyUsageSnapshot | null>(null)
  let injectedSub: { id: string; baseUrl: string; reading: WindowCostReading } | null = null

  const period = ref<UsageQueryWindow | null>(null)
  const sourceReadings = ref<Partial<Record<UnifiedSourceKey, WindowCostReading>>>({})
  let loadSequence = 0
  let pendingSubRequest: AbortController | null = null
  function readingCost(key: UnifiedSourceKey): number | null {
    const reading = sourceReadings.value[key], window = period.value
    return reading && window && reading.startMs === window.start.getTime() && reading.endMs === window.end.getTime() ? reading.costUsd : null
  }
  const sub2apiCost = computed(() => readingCost('sub2api'))
  const cockpitCost = computed(() => readingCost('cockpit'))
  const cliproxyCost = computed(() => readingCost('cliproxy'))
  const sub2apiCostUnit = computed<CostUnit | null>(() => sub2apiCost.value == null ? null : 'window')
  const cockpitCostUnit = computed<CostUnit | null>(() => cockpitCost.value == null ? null : 'window')
  const cliproxyCostUnit = computed<CostUnit | null>(() => cliproxyCost.value == null ? null : 'window')
  const sourceStatuses = computed(() => Object.fromEntries(DEFAULT_SOURCES.map((key) => [key, {
    selected: selectedSources.value.has(key), state: sourceReadings.value[key]?.state ?? 'unavailable',
    get reason() { return sourceReadings.value[key]?.reason ?? costDataText('thisSourceWindowHasNotBeenReadYet') },
    period: sourceReadings.value[key] ? { startMs: sourceReadings.value[key]!.startMs, endMs: sourceReadings.value[key]!.endMs } : null,
    instanceId: sourceReadings.value[key]?.instanceId ?? null, coverageBasis: sourceReadings.value[key]?.coverageBasis ?? 'unavailable',
    latestRecordMs: sourceReadings.value[key]?.latestRecordMs ?? null,
    records: sourceReadings.value[key]?.coverageBasis === 'unavailable' ? null : sourceReadings.value[key]?.records ?? null,
    tokens: sourceReadings.value[key]?.tokens ?? null,
  }])) as Record<UnifiedSourceKey, SourceStatus>)
  const contributedSources = computed(() => DEFAULT_SOURCES.flatMap((key) => {
    const value = readingCost(key), reading = sourceReadings.value[key]
    return selectedSources.value.has(key) && value != null && reading ? [{ key, value, unit: 'window' as const, instanceId: reading.instanceId, startMs: reading.startMs, endMs: reading.endMs }] : []
  }))
  const totalCostUnitMixed = computed(() => new Set(contributedSources.value.map((item) => `${item.startMs}:${item.endMs}`)).size > 1)
  const totalCostUsd = computed(() => contributedSources.value.length && !totalCostUnitMixed.value ? contributedSources.value.reduce((sum, item) => sum + item.value, 0) : null)
  const selectedCount = computed(() => selectedSources.value.size)
  const unmeasuredSources = computed(() => DEFAULT_SOURCES.filter((key) => selectedSources.value.has(key) && readingCost(key) == null))
  const lowerBoundSources = computed(() => contributedSources.value.filter((item) => sourceStatuses.value[item.key].state === 'partial').map((item) => item.key))
  const unmeasuredNote = computed(() => unmeasuredSourcesNote(totalCostUsd.value, unmeasuredSources.value))
  const lowerBoundNote = computed(() => lowerBoundSourcesNote(lowerBoundSources.value))
  const totalCostNote = computed(() => [unmeasuredNote.value, lowerBoundNote.value, contributedSources.value.length > 1 ? costDataText('sameWindowSourceRecordsAddedWithoutCrossSourceDeduplication') : ''].filter(Boolean).join('；'))

  // ==================== cockpit 账号明细(合并 stats + codex_accounts) ====================

  interface MergedCockpitAccount {
    accountId: string
    email?: string
    planType?: string
    subscriptionUntil?: string
    usage: CockpitStats['accounts'][number]['usage']
    /** 本项目价目表自算的累计成本(USD);无自算值时等于数据源估算,由 costIsOurs 区分 */
    costUsd: number
    costIsOurs: boolean
    /** 计价依据(P0-17)。`no_price_no_estimate` = **算不出**,UI 必须显示"成本未知"而不是 $0.00。 */
    costBasis: CostBasisKind
    /** ★ 该账号的自算金额只是**下界**(部分模型无单价且源无估算,那部分贡献哨兵 0)。
     *  金额照给(真实下界 > 0),但显示层必须与"完全实测"区分开,不能长得一模一样。 */
    costLowerBound: boolean
  }

  const cockpitAccountRows = computed<MergedCockpitAccount[]>(() => {
    if (!cockpitStats.value) return []
    const planMap = new Map(cockpitAccounts.value.map(a => [a.id, a]))
    return cockpitStats.value.accounts
      .map(a => {
        const meta = planMap.get(a.accountId)
        // D-4 同源守卫(与 cockpitCost 同一不变式):cockpitCumulativeCost 只由视图的 cockpit 分支写
        // (CostCenterView:3629,行号基准 2026-09-23 第八轮),非 cockpit 连接下它是上一个源的残留 ⇒ 不参与自算判定,
        // 回退到本次 reload 刚读到的 stats 估算(costIsOurs 随之变 false,标注由 pricedCost 决定)。
        const ours = activeSource.value === 'cockpit' ? cockpitCumulativeCost?.value?.[a.accountId] : undefined
        const hasOurs = typeof ours === 'number' && Number.isFinite(ours)
        // ★ 逐账号的计价依据(2026-09-23):账号金额同样是逐组求和 ⇒ 算不出来的组贡献哨兵 0
        //   ⇒ 只要有组算不出来,这个金额就只是**下界**。此前一律按 hasOurs 标 priced
        //   ⇒ 与"完全实测"长得一模一样(同一缺陷的第二个消费点)。
        const oursBasis = activeSource.value === 'cockpit'
          ? cockpitCumulativeAccountBasis?.value?.[a.accountId]
          : undefined
        const oursUnknown = hasOurs && isUnknownCostBasis(oursBasis ?? 'priced')
        // 全部组都算不出来 ⇒ 和恰好是哨兵 0(不是实测 $0.00)。
        // 判据复用唯一一份 isCockpitSentinelZero(有用量却报 <= 0 ⇒ 未知),不另写一份。
        const oursSentinelZero = oursUnknown
          && isCockpitSentinelZero({ estimatedCostUsd: ours, totalTokens: a.usage.totalTokens })
        // ★ 消除静默变 0(P0-17 同源):此前写成 `(Number(estimate) || 0) * mult`,
        //   数据源没给估算时结果就是 0,UI 无法区分"真的 $0"和"算不出来"。
        //   现在改成带 basis 的三态:自算 → priced;有数据源估算 → source_estimate;
        //   两者都没有 → no_price_no_estimate(cost 仍是 0,但标注让 UI 显示"成本未知")。
        const estimate = Number(a.usage.estimatedCostUsd)
        const hasEstimate = Number.isFinite(estimate) && estimate > 0
        const priced: PricedCost = hasOurs && !oursSentinelZero
          ? pricedCost(ours!)
          : hasEstimate
            ? sourceEstimateCost(estimate * multiplier.value)
            : noPriceNoEstimateCost()
        return {
          accountId: a.accountId,
          email: a.email || meta?.email,
          planType: meta?.plan_type,
          subscriptionUntil: meta?.subscription_active_until?.slice(0, 10),
          usage: a.usage,
          // 请求数/Token 是计数事实,继续用 stats;成本改用本项目自算(有则用)。
          // ★ 真实缺口修复(【F】7.2):回退 stats 估算时**必须同样乘倍率** ——
          //   同文件汇总卡片(:146)乘了,逐账号行没乘,同一页面出现两个口径。
          //   (cockpitCumulativeCost 传入的"自算值"已含倍率,故不再二次相乘。)
          costUsd: priced.cost,
          costIsOurs: hasOurs && !oursSentinelZero,
          costBasis: priced.basis.kind,
          costLowerBound: oursUnknown && !oursSentinelZero,
        }
      })
      .sort((x, y) => y.costUsd - x.costUsd)
  })

  // ==================== 操作 ====================

  function toggleSource(key: UnifiedSourceKey) {
    const next = new Set(selectedSources.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    // 至少保留一个:全取消时回退到该 key
    if (next.size === 0) next.add(key)
    selectedSources.value = next
    saveSelectedSources(next)
  }

  /** Old callers may inject arrays, but only explicit read metadata proves an empty query. */
  function setCliproxyData(events: CliproxyUsageEvent[], prices: Record<string, LitellmPricing>, snapshot?: Omit<CliproxyUsageSnapshot, 'events'>) {
    injectedPrices.value = prices
    injectedSnapshot.value = snapshot ? { ...snapshot, events } : null
  }

  function setSub2apiData(connection: Pick<ConnectionConfig, 'id' | 'baseUrl'>, reading: WindowCostReading & { source: 'sub2api' }) {
    injectedSub = { id: connection.id, baseUrl: connection.baseUrl, reading: { ...reading } }
  }

  async function loadUnified(range: CostCenterRange = '1h', requested?: UsageQueryWindow) {
    const sequence = ++loadSequence
    pendingSubRequest?.abort()
    const controller = new AbortController()
    pendingSubRequest = controller
    const bounds = requested ?? usageWindowBounds(range)
    const window = { start: new Date(bounds.start), end: new Date(Math.min(Date.now(), bounds.end.getTime())) }
    period.value = window
    loading.value = true
    error.value = ''
    const saved = connectionStore.connections.filter((item) => item.type === 'sub2api')
    const connection = saved.find((item) => item.id === connectionStore.active?.id) ?? [...saved].sort((a, b) => b.lastUsed - a.lastUsed)[0]
    const sub = connection ? { ...connection } : null
    const reusableSub = sub && injectedSub?.id === sub.id && injectedSub.baseUrl === sub.baseUrl
      && injectedSub.reading.instanceId === `sub2api:${sub.id}` && injectedSub.reading.startMs === window.start.getTime() && injectedSub.reading.endMs === window.end.getTime()
      ? injectedSub.reading : null
    const instances = { sub2api: sub ? `sub2api:${sub.id}` : 'sub2api:unconfigured', cockpit: 'cockpit:local:request_logs', cliproxy: 'cliproxy:local:cpa_usage_events' }
    async function read(key: UnifiedSourceKey, action: () => Promise<WindowCostReading>) {
      if (!selectedSources.value.has(key)) return
      sourceReadings.value[key] = { ...windowCostReading(key, instances[key], window), state: 'loading', get reason() { return costDataText('readingRecordedRowsForTheSameWindow') } }
      try {
        const result = await action()
        if (sequence === loadSequence) sourceReadings.value[key] = result
      } catch {
        if (sequence === loadSequence) sourceReadings.value[key] = { ...windowCostReading(key, instances[key], window), get reason() { return costDataText('readOnlyQueryFailedForThisSource') } }
      }
    }
    await Promise.all([
      read('sub2api', () => reusableSub ? Promise.resolve(reusableSub) : sub ? readSub2apiWindow(sub, window, { signal: controller.signal }) : Promise.resolve({ ...windowCostReading('sub2api', instances.sub2api, window), get reason() { return costDataText('noSavedSub2apiConnection') } })),
      read('cockpit', async () => {
        const result = windowCostReading('cockpit', instances.cockpit, window)
        if (!isDesktop) return { ...result, get reason() { return costDataText('localDatabasesAreReadableOnlyInTheDesktopApp') } }
        const [summary, access, stats, accounts] = await Promise.all([
          getCockpitRequestLogSummary(1, window.start.getTime(), window.end.getTime() - 1, false),
          getCockpitLocalAccess().catch(() => null), getCockpitStats().catch(() => null), getCockpitCodexAccounts().catch(() => []),
        ])
        if (sequence === loadSequence) { cockpitStats.value = stats; cockpitAccounts.value = accounts; cockpitAvailable.value = !!summary?.available }
        if (!summary?.available) return { ...result, get reason() { return costDataText('cockpitRequestStoreUnavailableCumulativeSnapshotsCannotSubstituteFor') } }
        const sets = cockpitEffectivePriceSets(access?.modelPricings)
        let cost = 0, known = 0, unknown = 0, estimated = 0
        let tokens = 0
        for (const group of summary.groups) {
          tokens += group.stdNormalInput + group.stdCached + group.stdOutput + group.longNormalInput + group.longCached + group.longOutput
          const priced = cockpitSplitCostUsd(group, cockpitPriceSetFor(sets, group.model), multiplier.value, group.serviceTier)
          if (isUnknownCostBasis(priced.costBasis.kind)) unknown += 1
          else { known += 1; cost += priced.cost; if (priced.costBasis.kind === 'source_estimate') estimated += 1 }
        }
        return { ...result, records: summary.rowCount, tokens: summary.rowCount && !summary.groups.length ? null : tokens, latestRecordMs: summary.windowEndMs,
          costUsd: summary.rowCount === 0 ? 0 : known ? cost : null,
          state: summary.rowCount === 0 ? 'empty' : unknown > 0 ? 'partial' : known ? 'estimated' : 'unavailable',
          coverageBasis: 'stored_records', get reason() { return costDataText('localCockpitRecordedWindowPerRequestTieredPricesNot', { p0: unknown ? costDataText('unknownUnitPricesIncludedAmountIsTheKnownLower') : '', p1: estimated ? costDataText('includesSourceEstimates') : '' }) },
        }
      }),
      read('cliproxy', async () => {
        const result = windowCostReading('cliproxy', instances.cliproxy, window)
        if (!isDesktop) return { ...result, get reason() { return costDataText('localCpaDatabaseIsReadableOnlyInTheDesktop') } }
        const reusable = injectedSnapshot.value && injectedPrices.value && injectedSnapshot.value.readStartMs != null && injectedSnapshot.value.readEndMs != null
          && injectedSnapshot.value.readStartMs <= result.startMs && injectedSnapshot.value.readEndMs >= result.endMs
        const [snapshot, prices] = reusable && injectedSnapshot.value && injectedPrices.value
          ? [injectedSnapshot.value, injectedPrices.value] : await Promise.all([getCliproxyUsageSnapshot(window), getCliproxyModelPrices()])
        const events = snapshot.events.filter((item) => item.requested_at >= result.startMs && item.requested_at < result.endMs)
        const covered = snapshot.available && snapshot.readStartMs != null && snapshot.readEndMs != null && snapshot.readStartMs <= result.startMs && snapshot.readEndMs >= result.endMs
        if (!snapshot.available && !snapshot.events.length) return { ...result, get reason() { return costDataText('localCpaStoreUnavailableOrTheLegacyApiDoes') } }
        const priced = events.length ? cliproxyEventsPricedCost(events, prices, multiplier.value) : null
        const cost = events.length === 0 ? (covered ? 0 : null) : priced && !isUnknownCostBasis(priced.basis.kind) ? priced.cost : null
        const byModel = new Map<string, CliproxyCostByModel>()
        for (const item of events) {
          const pricing = pricedEventCostUsd(item, resolveModelPricing(item.model, prices)), amount = pricing.cost * multiplier.value
          const unknown = isUnknownCostBasis(pricing.basis.kind)
          const previous = byModel.get(item.model)
          if (previous) { previous.requestCount += 1; previous.costUsd += amount; previous.inputTokens += item.input_tokens; previous.outputTokens += item.output_tokens; previous.cachedTokens += item.cache_read_tokens; previous.costUnknown = previous.costUnknown && unknown }
          else byModel.set(item.model, { model: item.model, requestCount: 1, costUsd: amount, costUnknown: unknown, inputTokens: item.input_tokens, outputTokens: item.output_tokens, cachedTokens: item.cache_read_tokens })
        }
        if (sequence === loadSequence) {
          cliproxyCostBasis.value = priced?.basis ?? { kind: covered ? 'priced' : 'no_price_no_estimate' }
          cliproxyCostLabel.value = priced?.label ?? ''
          cliproxyEstimate.value = { totalUsd: cost ?? 0, totalCostBasis: cliproxyCostBasis.value, totalCostLabel: cliproxyCostLabel.value, byModel: [...byModel.values()], matchedRequests: priced?.pricedEvents ?? 0, unmatchedRequests: priced?.unpricedEvents ?? 0, windowSize: events.length, estimated: true }
        }
        return { ...result, records: events.length, tokens: events.length || covered ? events.reduce<number | null>((sum, item) => sum != null && item.total_tokens != null && Number.isFinite(item.total_tokens) ? sum + item.total_tokens : null, 0) : null, latestRecordMs: events.reduce<number | null>((latest, item) => Math.max(latest ?? item.requested_at, item.requested_at), null), costUsd: cost,
          state: !covered || (priced?.unpricedEvents ?? 0) > 0 ? 'partial' : events.length ? 'estimated' : 'empty',
          coverageBasis: covered ? 'stored_records' : 'bounded_sample', get reason() { return costDataText('localCpaRecordedWindowTokensReferencePricesNotA', { p0: covered ? '' : costDataText('readBoundsAreIncompleteKnownPortionOnly'), p1: (priced?.unpricedEvents ?? 0) > 0 ? costDataText('someRequestsAreUnpricedAmountIsALowerBound') : '' }) },
        }
      }),
    ])
    if (sequence === loadSequence) loading.value = false
  }

  return {
    period,
    sourceReadings,
    // 状态
    selectedSources,
    selectedCount,
    loading,
    error,
    // 各端成本
    sub2apiCost,
    sub2apiCostUnit,
    cockpitCost,
    cockpitCostUnit,
    cliproxyCost,
    cliproxyCostUnit,
    contributedSources,
    totalCostUnitMixed,
    totalCostUsd,
    // 各端状态
    sourceStatuses,
    /** 选中但成本拿不到、因而未计入 totalCostUsd 的端(供总成本格如实标注) */
    unmeasuredSources,
    /** 总成本格下方的口径提醒文案(空串 = 无需提醒) */
    unmeasuredSourcesNote: unmeasuredNote,
    /** 已计入总额、但数值只是**下界**的端(部分用量无单价,未计入) */
    lowerBoundSources,
    /** 下界提醒文案(空串 = 无下界端) */
    lowerBoundSourcesNote: lowerBoundNote,
    /** 总成本格下方**合并**提醒:未计入的端 + 数值为下界的端(视图用这个) */
    totalCostNote,
    // cockpit 明细
    cockpitStats,
    cockpitAvailable,
    cockpitAccountRows,
    // cliproxy 明细
    cliproxyEstimate,
    cliproxyCostBasis,
    cliproxyCostLabel,
    // 操作
    toggleSource,
    loadUnified,
    setCliproxyData,
    setSub2apiData,
  }
}
