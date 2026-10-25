<template>
  <section class="adaptive-charts" aria-labelledby="adaptive-charts-title">
    <div class="adaptive-charts__heading">
      <div>
        <span>{{ t('costComponents.adaptiveKicker') }}</span>
        <h2 id="adaptive-charts-title">{{ t('costComponents.adaptiveTitle') }}</h2>
        <p>{{ t('costComponents.adaptiveDescription') }}</p>
      </div>
      <strong>{{ pointSummary }}</strong>
    </div>

    <div class="adaptive-charts__grid">
      <article class="adaptive-chart-card adaptive-chart-card--economy">
        <header>
          <div><strong>{{ economyTitle }}</strong><span>{{ economySubtitle }}</span></div>
          <select v-model="economyMode" :aria-label="t('costComponents.adaptiveEconomyMetrics')">
            <option value="flow">{{ t('costComponents.adaptiveFlow') }}</option>
            <option value="unit">{{ t('costComponents.adaptiveUnitCost') }}</option>
            <option value="return">{{ returnModeLabel }}</option>
          </select>
        </header>
        <EconomicCostLineChart
          economic-ledger
          :material="economyMode === 'flow' ? 'soft-gold' : undefined"
          :labels="economyLabels"
          :series="economySeries"
          :events="economyEvents"
          :value-prefix="economyMode === 'return' ? '' : '¥'"
          :value-suffix="economyMode === 'unit' ? '/USD' : economyMode === 'return' ? '%' : ''"
          :state="economyState"
          :state-reason="economyReason"
        />
      </article>

      <article class="adaptive-chart-card adaptive-chart-card--quality">
        <header>
          <div><strong>{{ t('costComponents.adaptiveQuality') }}</strong><span>{{ qualityMode === 'outcome' ? t('costComponents.adaptiveRequestWindow') : t('costComponents.adaptiveRawErrors') }}</span></div>
          <select v-model="qualityMode" :aria-label="t('costComponents.adaptiveQualityMetrics')">
            <option value="outcome">{{ t('costComponents.adaptiveOutcomes') }}</option>
            <option value="status">{{ t('costComponents.adaptiveErrorCodes') }}</option>
          </select>
        </header>
        <GlassQualityChart v-if="qualityMode === 'outcome'" :labels="opsLabels" :series="qualitySeries" :events="opsEvents" :state="opsState" :state-reason="opsReason" />
        <CostLineChart v-else
          :labels="opsLabels"
          :series="qualitySeries"
          :events="opsEvents"
          :state="opsState"
          :state-reason="opsReason"
        />
      </article>

      <article class="adaptive-chart-card adaptive-chart-card--health">
        <header><div><strong>{{ healthLabels.length ? sourceKind === 'cockpit' ? t('costComponents.adaptiveRequestHealth') : t('costComponents.adaptiveAccountHealth') : t('costComponents.adaptiveAccountSnapshot') }}</strong><span>{{ healthLabels.length ? healthReason : accountHealthReason || t('costComponents.adaptiveAccountSnapshotReason') }}</span></div></header>
        <CostLineChart
          v-if="healthLabels.length"
          :labels="healthLabels"
          :series="healthSeries"
          :events="healthEvents"
          :state="healthState"
          :state-reason="healthReason"
        />
        <div v-else-if="accountHealth" class="account-health">
          <div class="account-health__total"><strong>{{ currentAccountTotal }}</strong><span>{{ t('costComponents.adaptiveCurrentAccounts') }}</span></div>
          <div v-if="currentAccountTotal" class="account-health__bar" role="img" :aria-label="accountHealthLabel">
            <span v-for="item in accountHealthItems" :key="item.label" :style="{ flex: item.count, background: item.color }"></span>
          </div>
          <dl><div v-for="item in accountHealthItems" :key="item.label"><dt><i :style="{ background: item.color }"></i>{{ item.label }}</dt><dd>{{ item.count }}</dd></div></dl>
        </div>
        <p v-else class="account-health__missing">{{ healthReason || t('costComponents.adaptiveAccountMissing') }}</p>
      </article>

      <article class="adaptive-chart-card adaptive-chart-card--experience">
        <header>
          <div><strong>{{ t('costComponents.adaptiveLatencyTokens') }}</strong><span>{{ t('costComponents.adaptiveLatencyGaps') }}</span></div>
          <select v-model="experienceMode" :aria-label="t('costComponents.adaptiveExperienceMetrics')">
            <option value="latency">{{ t('costComponents.adaptiveLatency') }}</option>
            <option value="tokens">{{ t('costComponents.adaptiveTokenMix') }}</option>
            <option value="cache">{{ t('costComponents.adaptiveCache') }}</option>
          </select>
        </header>
        <CostLineChart
          :labels="opsLabels"
          :series="experienceSeries"
          :value-suffix="experienceMode === 'latency' ? 'ms' : experienceMode === 'cache' ? '%' : ''"
          :events="opsEvents"
          :state="opsState"
          :state-reason="opsReason"
        />
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'
import type { OpsErrorTrendPoint, OpsThroughputTrendPoint } from '@/api/admin/ops'
import type { DataAvailability } from '../dataState'
import type { FinancialTrendPoint } from '../financialTrend'
import { parseTrendDate, usageBucketHours, type UsageQueryWindow } from '../usageWindow'
import GlassQualityChart from './GlassQualityChart.vue'
import EconomicCostLineChart from './EconomicCostLineChart.vue'
import CostLineChart, { type CostChartEvent, type CostChartSeries } from './CostLineChart.vue'
import { formatDate as formatDateByLocale } from '@/utils/format'

const { t } = useI18n()

const props = defineProps<{
  /** 当前连接源。**必填**:本组件大量文案断言了"用户计费/收入/回本率",
   *  而这些只有 sub2api(usage_logs.actual_cost)才成立 —— cockpit(自算成本)与
   *  cliproxy(CPA usage_events × LiteLLM 单价估算)都没有营收层。
   *  缺省一个值等于默认对两个源说错话,故不给默认值,让调用点必须显式声明。 */
  sourceKind: 'sub2api' | 'cliproxy' | 'cockpit'
  opsTrend: OpsThroughputTrendPoint[]
  financialTrend: FinancialTrendPoint[]
  errorTrend: OpsErrorTrendPoint[]
  economics: AccountEconomicsSnapshot | null
  cnyPerUsd: number
  opsBucketHours: number
  procurementHourlyCny: number | null
  opsState: DataAvailability
  opsReason: string
  financialState?: DataAvailability
  financialReason?: string
  /** Omit for cumulative snapshots, whose bucketHours already describes their actual coverage. */
  queryWindow?: UsageQueryWindow
  healthState: DataAvailability
  healthReason: string
  accountHealth?: { normal: number; limited: number; error: number; inactive: number } | null
  accountHealthReason?: string
}>()

const economyMode = ref<'flow' | 'unit' | 'return'>('flow')
const qualityMode = ref<'outcome' | 'status'>('outcome')
const experienceMode = ref<'latency' | 'tokens' | 'cache'>('tokens')

function timeLabel(value: string): string {
  const date = parseTrendDate(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return formatDateByLocale(date, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function finiteValue(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const opsLabels = computed(() => props.opsTrend.map((point) => timeLabel(point.bucket_start)))
const economyLabels = computed(() => props.financialTrend.map((point) => timeLabel(point.timestamp)))
const healthLabels = computed(() => (props.economics?.series ?? []).map((point) => timeLabel(point.sampled_at)))
const accountHealthItems = computed(() => [
  { label: t('costComponents.adaptiveSchedulable'), count: props.accountHealth?.normal ?? 0, color: '#b9e55a' },
  { label: t('costComponents.adaptiveLimited'), count: props.accountHealth?.limited ?? 0, color: '#e0bd4e' },
  { label: t('costComponents.adaptiveError'), count: props.accountHealth?.error ?? 0, color: '#d88473' },
  { label: t('costComponents.adaptiveInactive'), count: props.accountHealth?.inactive ?? 0, color: '#7d8982' },
])
const currentAccountTotal = computed(() => accountHealthItems.value.reduce((sum, item) => sum + item.count, 0))
const accountHealthLabel = computed(() => accountHealthItems.value.map(item => `${item.label} ${item.count}`).join(t('costComponents.adaptiveListSeparator')))
const pointSummary = computed(() => t('costComponents.adaptivePointSummary', { financial: props.financialTrend.length, ops: props.opsTrend.length, health: props.economics?.series?.length || 0 }))
/** 三源穷举:只有 sub2api(usage_logs.actual_cost)是**用户计费(营收)**。
 *  cockpit 的趋势刻意把 actual_cost 填成自算成本(cockpitAdapter),cliproxy 填成
 *  CPA usage_events × LiteLLM 单价的估算成本(cliproxyAdapter)——两源都没有营收层。
 *  写成一条三态穷举而不是 `sourceKind === 'sub2api' ? A : B`:后者把 cockpit 静默当成 sub2api
 *  (措辞守卫 cliproxyWordingContract.spec.ts 的 W5 变体正是这种写法)。 */
const sourceEconomy = computed(() => {
  if (props.sourceKind === 'sub2api') {
    return { hasRevenue: true, costLabel: t('costComponents.userBilling'), revenueAbsentReason: '' }
  }
  if (props.sourceKind === 'cliproxy') {
    return { hasRevenue: false, costLabel: t('costComponents.adaptiveEstimatedCost'), revenueAbsentReason: t('costComponents.adaptiveCpaNoRevenue') }
  }
  return { hasRevenue: false, costLabel: t('costComponents.adaptiveCalculatedCost'), revenueAbsentReason: t('costComponents.adaptiveCockpitNoRevenue') }
})
const hasRevenueLayer = computed(() => sourceEconomy.value.hasRevenue)
/** 该源的成本口径措辞(与 CostCenterView 的既有措辞一致)。 */
const sourceCostLabel = computed(() => sourceEconomy.value.costLabel)
/** 无营收层时回本率/毛利率的不可计算原因。分母(营收)不存在,算出来的任何数都是编的。 */
const revenueAbsentReason = computed(() => sourceEconomy.value.revenueAbsentReason)
/** return 档在无营收层的源下整档不可用(分母是营收)。下拉选项名与卡片标题都按源表态 ——
 *  否则用户在下拉里看到「回本与毛利率」、选中后只得到一片"不可用",等于先承诺再撤回。 */
const returnModeLabel = computed(() => hasRevenueLayer.value ? t('costComponents.adaptiveReturns') : t('costComponents.adaptiveReturnsRequireRevenue'))

const economyTitle = computed(() => economyMode.value === 'flow'
  ? (hasRevenueLayer.value ? t('costComponents.adaptiveRevenueCostContribution') : t('costComponents.adaptiveCostProcurement'))
  : economyMode.value === 'unit'
    ? (hasRevenueLayer.value ? t('costComponents.adaptiveProcurementPerOutput') : t('costComponents.adaptiveProcurementPerCost'))
    : returnModeLabel.value)
const economySubtitle = computed(() => economyMode.value === 'flow'
  ? t('costComponents.adaptiveCnyHourly')
  : economyMode.value === 'unit'
    ? (hasRevenueLayer.value ? t('costComponents.adaptiveProcurementRateRevenue') : t('costComponents.adaptiveProcurementRateCost', { cost: sourceCostLabel.value }))
    : (hasRevenueLayer.value ? t('costComponents.adaptiveReturnsDescription') : revenueAbsentReason.value))

/** return 档在无营收层的源下整档不画:分母是营收,两源都没有。 */
const economyReturnUnavailable = computed(() => economyMode.value === 'return' && !hasRevenueLayer.value)
const inferredFinancialState = computed<DataAvailability>(() => {
  if (!props.financialTrend.length) return 'empty'
  const amounts = props.financialTrend.flatMap(point => hasRevenueLayer.value
    ? [point.billedUsd, point.accountCostUsd, point.contributionUsd] : [point.billedUsd])
  if (!amounts.some(amount => finiteValue(amount) != null)) return 'unavailable'
  return props.financialTrend.some(point => point.costPartial) || amounts.some(amount => finiteValue(amount) == null)
    ? 'partial' : 'measured'
})
const economyState = computed<DataAvailability>(() => economyReturnUnavailable.value ? 'unavailable' : props.financialState ?? inferredFinancialState.value)
const economyReason = computed(() => economyReturnUnavailable.value ? revenueAbsentReason.value : props.financialReason ?? '')

function financialBucketHours(point: FinancialTrendPoint): number | null {
  if (props.queryWindow) return usageBucketHours(point.timestamp, point.bucketHours, props.queryWindow)
  return Number.isFinite(point.bucketHours) && point.bucketHours > 0 ? point.bucketHours : null
}

function financialHourly(point: FinancialTrendPoint, value: number | null): number | null {
  const hours = financialBucketHours(point)
  return hours != null && value != null && Number.isFinite(value) ? value / hours : null
}

const economySeries = computed<CostChartSeries[]>(() => {
  const procurement = props.procurementHourlyCny == null ? null : Math.max(0, props.procurementHourlyCny)
  const financial = props.financialTrend
  if (economyMode.value === 'unit') {
    return [{
      id: hasRevenueLayer.value ? 'unit-procurement-output' : `unit-${props.sourceKind}-procurement-cost`,
      label: hasRevenueLayer.value ? t('costComponents.adaptiveProcurementOutput') : t('costComponents.adaptiveProcurementCost', { cost: sourceCostLabel.value }),
      color: '#79bdff',
      fill: true,
      data: financial.map((point) => {
        const billedPerHour = financialHourly(point, point.billedUsd)
        return billedPerHour != null && billedPerHour > 0 && procurement != null ? procurement / billedPerHour : null
      }),
    }]
  }
  if (economyMode.value === 'return') {
    // 无营收层:分母(营收)不存在,回本率/毛利率算出来的任何数都是编的 ⇒ 整档不画。
    // 状态由 economyState/economyReason 切成 unavailable 并给出该源的具体原因。
    if (!hasRevenueLayer.value) return []
    return [
      {
        id: 'return-procurement-payback',
        label: t('costComponents.adaptiveProcurementPayback'),
        color: '#f4c467',
        data: financial.map((point) => {
          const billedPerHour = financialHourly(point, point.billedUsd)
          return billedPerHour != null && procurement != null && procurement > 0 ? billedPerHour * props.cnyPerUsd / procurement * 100 : null
        }),
      },
      {
        id: 'return-contribution-margin',
        label: t('costComponents.adaptiveContributionMargin'),
        color: '#50d9b4',
        fill: true,
        data: financial.map((point) => {
          const billedPerHour = financialHourly(point, point.billedUsd)
          const contributionPerHour = financialHourly(point, point.contributionUsd)
          if (billedPerHour == null || billedPerHour <= 0 || contributionPerHour == null || procurement == null) return null
          return (contributionPerHour * props.cnyPerUsd - procurement) / (billedPerHour * props.cnyPerUsd) * 100
        }),
      },
    ]
  }
  if (!hasRevenueLayer.value) {
    // cockpit / cliproxy 都没有营收层:billedUsd 在这两源下就是成本(适配器刻意把 actual_cost
    // 填成成本,cockpitAdapter.ts `actual_cost: cost, account_cost: cost`;
    // cliproxyAdapter.ts `actual_cost: b.costUsd, account_cost: b.costUsd`),于是
    // billedUsd 与 accountCostUsd **逐点相等**、contributionUsd 恒为 0。
    // 因此这里只画该源的成本线,名称按源改写为"自算成本"/"估算成本":
    //   · '贡献毛利' 不画 —— 它恒为 0,画出来就是假零;
    //   · '上游账号成本' 不画 —— 它与上面这条逐点相等,画两条会暗示这是两个独立的量,
    //     而这两个源根本没有"账号费率"这一层(CostCenterView 已注明"无账号费率")。
    return [
      { id: `flow-${props.sourceKind}-cost`, label: sourceCostLabel.value, color: '#f4c467', fill: true, data: financial.map((point) => { const hourly = financialHourly(point, point.billedUsd); return hourly == null ? null : hourly * props.cnyPerUsd }) },
    ]
  }
  return [
    { id: 'flow-billed', label: t('costComponents.userBilling'), color: '#f4c467', fill: true, data: financial.map((point) => { const hourly = financialHourly(point, point.billedUsd); return hourly == null ? null : hourly * props.cnyPerUsd }) },
    { id: 'flow-account-cost', label: t('costComponents.adaptiveUpstreamAccountCost'), color: '#79bdff', data: financial.map((point) => { const hourly = financialHourly(point, point.accountCostUsd); return hourly == null ? null : hourly * props.cnyPerUsd }) },
    { id: 'flow-contribution', label: t('costComponents.adaptiveContribution'), color: '#50d9b4', data: financial.map((point) => { const hourly = financialHourly(point, point.contributionUsd); return hourly == null || procurement == null ? null : hourly * props.cnyPerUsd - procurement }) },
  ]
})

const errorsByBucket = computed(() => new Map(props.errorTrend.map((point) => [parseTrendDate(point.bucket_start).getTime(), point])))
const alignedErrors = computed(() => props.opsTrend.map((point) => errorsByBucket.value.get(parseTrendDate(point.bucket_start).getTime())))
const qualitySeries = computed<CostChartSeries[]>(() => qualityMode.value === 'outcome'
  ? [
      { label: t('costComponents.success'), color: '#50d9b4', data: props.opsTrend.map((point) => finiteValue(point.success_count)) },
      { label: t('costComponents.failure'), color: '#f28f85', data: props.opsTrend.map((point) => finiteValue(point.error_count)) },
      { label: t('costComponents.accountSwitches'), color: '#79bdff', data: props.opsTrend.map((point) => finiteValue(point.switch_count)) },
    ]
  : [
      { label: t('costComponents.adaptive429'), color: '#f4c467', data: alignedErrors.value.map((point) => point ? finiteValue(point.upstream_429_count) : null) },
      { label: t('costComponents.adaptive402'), color: '#d88473', data: alignedErrors.value.map((point) => point ? finiteValue(point.upstream_402_count) : null) },
      { label: t('costComponents.adaptiveOtherErrors'), color: '#79bdff', data: alignedErrors.value.map((point) => {
        if (!point) return null
        const upstream = finiteValue(point.upstream_error_count_excl_429_529)
        // FIX 4:402 为 null = 该源不单独拆分 402(cockpit 日志无该错误码维度)。
        // 字段名本身已是 excl_429_529,此时它就是"其他上游错误"的全部 —— 直接取用,
        // 不能因为 402 缺测就把这个真实测量值整片变成断点。
        if (point.upstream_402_count == null) return upstream
        const closed = finiteValue(point.upstream_402_count)
        return upstream == null || closed == null ? null : Math.max(0, upstream - closed)
      }) },
    ])

const healthSeries = computed<CostChartSeries[]>(() => [
  { label: t('costComponents.adaptiveSchedulable'), color: '#b9e55a', fill: true, data: (props.economics?.series ?? []).map((point) => point.normal_count) },
  { label: t('costComponents.adaptive429Health'), color: '#e0bd4e', data: (props.economics?.series ?? []).map((point) => point.rate_limited_count) },
  { label: t('costComponents.adaptive402Health'), color: '#d88473', data: (props.economics?.series ?? []).map((point) => point.error_count) },
])

const experienceSeries = computed<CostChartSeries[]>(() => {
  if (experienceMode.value === 'latency') {
    return [
      { label: t('costComponents.adaptiveTtft50'), color: '#7eb6d8', data: props.opsTrend.map((point) => point.ttft_p50_ms ?? null) },
      { label: t('costComponents.adaptiveTtft95'), color: '#e0bd4e', data: props.opsTrend.map((point) => point.ttft_p95_ms ?? null) },
      { label: t('costComponents.adaptiveDuration95'), color: '#d88473', data: props.opsTrend.map((point) => point.duration_p95_ms ?? null) },
    ]
  }
  if (experienceMode.value === 'tokens') {
    return [
      { label: t('costComponents.adaptiveInputTokens'), color: '#7eb6d8', data: props.opsTrend.map((point) => finiteValue(point.input_tokens)) },
      { label: t('costComponents.adaptiveOutputTokens'), color: '#b9e55a', data: props.opsTrend.map((point) => finiteValue(point.output_tokens)) },
      { label: t('costComponents.adaptiveCacheWrites'), color: '#e0bd4e', data: props.opsTrend.map((point) => finiteValue(point.cache_creation_tokens)) },
    ]
  }
  return [
    { label: t('costComponents.adaptiveCacheReadRatio'), color: '#b9e55a', fill: true, data: props.opsTrend.map((point) => {
      const input = finiteValue(point.input_tokens)
      const cacheRead = finiteValue(point.cache_read_tokens)
      if (input == null || cacheRead == null || input < 0 || cacheRead < 0) return null
      // Local adapters expose inclusive input; Sub2API Ops reports cache classes separately.
      const cacheWrite = finiteValue(point.cache_creation_tokens)
      if (props.sourceKind === 'sub2api' && (cacheWrite == null || cacheWrite < 0)) return null
      const denominator = props.sourceKind === 'sub2api' ? input + cacheRead + cacheWrite! : input
      return denominator > 0 && cacheRead <= denominator ? cacheRead / denominator * 100 : null
    }) },
  ]
})

function mapEvents(labels: string[], timestamps: string[]): CostChartEvent[] {
  if (!props.economics?.events?.length || !timestamps.length) return []
  const positions = timestamps
    .map((value, index) => ({ index, time: parseTrendDate(value).getTime() }))
    .filter((position) => Number.isFinite(position.time))
  if (!positions.length) return []
  const first = Math.min(...positions.map((position) => position.time))
  const last = Math.max(...positions.map((position) => position.time))
  return props.economics.events.flatMap((event) => {
    const target = parseTrendDate(event.occurred_at).getTime()
    if (!Number.isFinite(target) || target < first || target > last) return []
    let nearest = positions[0]
    for (const position of positions.slice(1)) {
      if (Math.abs(position.time - target) < Math.abs(nearest.time - target)) nearest = position
    }
    return [{ index: Math.min(nearest.index, labels.length - 1), label: `${timeLabel(event.occurred_at)} · ${event.label}`, severity: event.severity === 'warning' ? 'warning' : 'info' }]
  })
}

const opsEvents = computed(() => mapEvents(opsLabels.value, props.opsTrend.map((point) => point.bucket_start)))
const economyEvents = computed(() => mapEvents(economyLabels.value, props.financialTrend.map((point) => point.timestamp)))
const healthEvents = computed(() => mapEvents(healthLabels.value, (props.economics?.series ?? []).map((point) => point.sampled_at)))
</script>

<style scoped>
/* Reuse the console panel surface; optical material belongs to the chart only. */
.adaptive-chart-card.adaptive-chart-card--economy,
.adaptive-chart-card.adaptive-chart-card--quality {
  background: var(--cost-panel);
}

.adaptive-chart-card.adaptive-chart-card--economy select,
.adaptive-chart-card.adaptive-chart-card--quality select { background: var(--cost-panel-2); border-color: var(--cost-line-strong); }

.adaptive-charts { margin-top: 18px; }
.adaptive-charts__heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 10px; }
.adaptive-charts__heading span { color: #b9e55a; font: 9px 'Cascadia Mono', monospace; letter-spacing: .08em; }
.adaptive-charts__heading h2 { margin: 6px 0 0; font-size: 20px; }
.adaptive-charts__heading p, .adaptive-charts__heading > strong { margin: 5px 0 0; color: #768079; font-size: 10px; font-weight: 500; }
.adaptive-charts__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; border: 1px solid #303830; border-radius: 13px; background: #111611; }
.adaptive-chart-card { min-width: 0; padding: 15px 16px 13px; border-right: 1px solid #303830; border-bottom: 1px solid #303830; }
.adaptive-chart-card:nth-child(2n) { border-right: 0; }
.adaptive-chart-card:nth-last-child(-n+2) { border-bottom: 0; }
.adaptive-chart-card header { display: flex; min-height: 38px; align-items: start; justify-content: space-between; gap: 12px; }
.adaptive-chart-card header strong, .adaptive-chart-card header span { display: block; }
.adaptive-chart-card header strong { font-size: 12px; }
.adaptive-chart-card header span { margin-top: 3px; color: #768079; font: 9px 'Cascadia Mono', monospace; }
.adaptive-chart-card select { min-height: 30px; padding: 0 26px 0 9px; border: 1px solid #39433a; border-radius: 8px; background: #171d18; color: #c7cec7; font-size: 10px; }
.account-health { padding: 18px 0; }
.account-health__total { display: flex; align-items: baseline; gap: 10px; }
.account-health__total strong { font: 600 28px 'Cascadia Mono', monospace; color: #cbd5cd; }
.account-health__total span, .account-health__missing { color: #9ba89f; font-size: 12px; }
.account-health__bar { display: flex; height: 9px; margin: 18px 0; overflow: hidden; border-radius: 3px; background: #303830; }
.account-health__bar span { min-width: 0; }
.account-health dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 16px 0 0; }
.account-health dt { display: flex; align-items: center; gap: 6px; color: #9ba89f; font-size: 11px; }
.account-health dt i { display: block; width: 7px; height: 7px; }
.account-health dd { margin: 7px 0 0; font: 600 18px 'Cascadia Mono', monospace; }
.account-health__missing { margin: 18px 0; }
@media (max-width: 1180px) { .adaptive-charts__grid { grid-template-columns: 1fr; } .adaptive-chart-card, .adaptive-chart-card:nth-child(2n), .adaptive-chart-card:nth-last-child(-n+2) { border-right: 0; border-bottom: 1px solid #303830; } .adaptive-chart-card:last-child { border-bottom: 0; } }
.adaptive-chart-card--economy > header strong,
.adaptive-chart-card--quality > header strong { font-size: 18px; font-weight: 600; line-height: 22px; color: #f0f4e9; }
.adaptive-chart-card--economy :deep(.cost-chart__keys button.is-primary strong) { font-size: 24px; line-height: 26px; }
.adaptive-chart-card--quality > header { position: relative; }
.adaptive-chart-card--quality > header > select { position: absolute; left: 95px; top: 0; }
</style>
