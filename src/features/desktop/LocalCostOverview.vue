<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, ChartNoAxesCombined, ChevronDown } from '@lucide/vue'
import UsagePeriodSummary from './UsagePeriodSummary.vue'
import UsageTokenComposition from './UsageTokenComposition.vue'
import type { FinanceAccountSummary } from '@/api/financeLedger'
import type { LocalCostReport } from '@/api/localCost'
import { monitorAutomaticPriceSummary } from '@/api/usageMonitor'
import { localCostOverview, type LocalCostRow } from './localCostMath'
import { usageLocale } from '@/utils/usageFormat'

const props = defineProps<{ rows: LocalCostRow[]; report: LocalCostReport; finances: FinanceAccountSummary[] }>()
const emit = defineEmits<{ enter: []; account: [id: string] }>()
const { t } = useI18n()
const summary = computed(() => localCostOverview(props.rows, props.report, props.finances))
const money = (value: number | null, currency = 'CNY') => value == null ? t('desktop.localCost.notEntered') : new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(value)
const usdValue = computed(() => {
  const values = props.rows.map(row => monitorAutomaticPriceSummary(row.totals).currencies.find(price => price.currency === 'USD')?.identifiedSubtotal).filter((value): value is number => value != null)
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
})
const priced = computed(() => props.rows.reduce((count, row) => count + monitorAutomaticPriceSummary(row.totals).coveredRequests, 0))
const valueNote = computed(() => priced.value < summary.value.requests ? t('usageMonitor.text.pricedPortionCoverage', { priced: priced.value, total: summary.value.requests }) : t('desktop.localCost.valuationBasis'))
const unitCost = computed(() => {
  const known = props.rows.filter(row => row.metrics.perMillionTokens != null)
  const tokens = known.reduce((sum, row) => sum + row.totals.totalTokens, 0)
  return tokens > 0 ? known.reduce((sum, row) => sum + row.metrics.expenseCny!, 0) / tokens * 1e6 : null
})
const metrics = computed(() => [
  { key: 'cashPaid', value: money(summary.value.cashOutlayCny), unknown: summary.value.cashOutlayCny == null },
  { key: 'recordedCost', value: money(summary.value.expenseCny), unknown: summary.value.expenseCny == null },
  { key: 'factor', value: summary.value.factor == null ? '—' : summary.value.factor.toFixed(4) + '×', unknown: summary.value.factor == null },
  { key: 'remaining', value: money(summary.value.remainingCny), unknown: summary.value.remainingCny == null },
])
const details = computed(() => [
  { label: t('desktop.localCost.confirmedLoss'), value: money(summary.value.lossesCny) },
  { label: t('costComponents.refunds'), value: money(summary.value.refundsCny) },
  { label: t('desktop.localCost.unitCost'), value: money(unitCost.value) },
  { label: t('desktop.localCost.apiCost'), value: money(summary.value.apiCny) },
  { label: t('desktop.localCost.subscriptionAccounts'), value: String(summary.value.subscriptionCount) },
  { label: t('desktop.localCost.priceCoverage'), value: summary.value.requests ? (priced.value / summary.value.requests * 100).toFixed(1) + '%' : '—' },
  { label: t('desktop.localCost.active'), value: t('desktop.localCost.activeCount', { count: summary.value.activeCount }) },
  { label: t('desktop.localCost.banned'), value: t('desktop.localCost.bannedCount', { count: summary.value.bannedCount }) },
])
const ranking = computed(() => props.rows.filter(row => row.metrics.valueCny != null && row.metrics.valueCny > 0).sort((a, b) => b.metrics.valueCny! - a.metrics.valueCny!).slice(0, 5))
const breakdown = computed(() => [
  { key: 'subscriptionCost', value: summary.value.accruedCny },
  { key: 'apiCost', value: summary.value.apiCny },
  { key: 'confirmedLoss', value: summary.value.lossesCny },
  { key: 'costCredits', value: summary.value.creditsCny ? -summary.value.creditsCny : summary.value.creditsCny },
])
</script>

<template>
  <section class="local-overview" :aria-label="t('desktop.localCost.overview')">
    <div class="finance-strip"><div v-for="metric in metrics" :key="metric.key" :title="metric.key === 'factor' ? t('desktop.localCost.pairedFactor') : ''"><span>{{ t('desktop.localCost.' + metric.key) }}</span><strong :class="{ 'is-unknown': metric.unknown }">{{ metric.value }}</strong><small v-if="metric.key === 'factor'">{{ t('desktop.localCost.matchedAccounts') }}</small><small v-else-if="metric.key === 'recordedCost' && summary.partial">{{ t('desktop.localCost.knownPart') }}</small><button v-else-if="metric.key === 'cashPaid' && summary.enteredCount < summary.subscriptionCount" class="purchase-link" @click="emit('enter')">{{ t('desktop.localCost.enterPurchase') }}<ArrowUpRight :size="13" /></button></div></div>
    <UsagePeriodSummary :totals="report.analytics?.totals" :cost-text="summary.valueCny == null ? '—' : money(summary.valueCny)" :cost-note="valueNote"><template #amount><span>{{ t('desktop.localCost.usageUsd') }}</span><strong class="usage-usd">{{ usdValue == null ? '—' : money(usdValue, 'USD') }}</strong><small class="usage-cny" :title="t('desktop.localCost.currencyBasis')">{{ t('desktop.localCost.usageCny') }} {{ summary.valueCny == null ? '—' : money(summary.valueCny) }}</small></template></UsagePeriodSummary>
    <section class="overview-infographic" :aria-label="t('desktop.localCost.allRecordedUsage')"><p class="infographic-scope">{{ t('desktop.localCost.allRecordedUsage') }}</p><UsageTokenComposition :input-tokens="report.analytics?.totals.inputTokens" :output-tokens="report.analytics?.totals.outputTokens" :cache-read-tokens="report.analytics?.totals.cacheReadTokens" :partial="!!report.analytics?.totals.incompleteRequests" /></section>
    <details class="overview-insights"><summary><ChartNoAxesCombined :size="16" />{{ t('desktop.localCost.costDetails') }}<ChevronDown :size="14" /></summary><div class="additional-metrics"><div v-for="metric in details" :key="metric.label"><span>{{ metric.label }}</span><strong>{{ metric.value }}</strong></div></div><section v-if="summary.subscriptionCount" class="purchase-coverage"><header><h3>{{ t('desktop.localCost.purchaseCoverage') }}</h3><span>{{ summary.enteredCount }} / {{ summary.subscriptionCount }}</span></header></section>
    <div class="overview-comparisons">
      <section class="comparison-ranking"><header><h2>{{ t('desktop.localCost.usageRanking') }}</h2><span>CNY</span></header><div v-if="!ranking.length" class="comparison-empty">{{ t('desktop.localCost.noPricedUsage') }}</div><button v-for="(row, index) in ranking" :key="row.id" type="button" class="ranking-row" :title="row.name" @click="emit('account', row.id)"><span class="rank-number">{{ String(index + 1).padStart(2, '0') }}</span><span class="rank-name">{{ row.name }}</span><strong>{{ money(row.metrics.valueCny) }}</strong><ArrowUpRight :size="13" /></button></section>
      <section class="comparison-expenses"><header><h2>{{ t('desktop.localCost.costBreakdown') }}</h2><span>CNY</span></header><div v-for="item in breakdown" :key="item.key" class="breakdown-row"><span>{{ t('desktop.localCost.' + item.key) }}</span><strong>{{ item.value == null ? '—' : money(item.value) }}</strong></div></section>
    </div>
    </details>
    <slot />
  </section>
</template>

<style scoped>
.local-overview{margin-bottom:24px;min-width:0}.purchase-link{display:inline-flex;align-items:center;gap:5px;color:var(--cost-lime);font-size:11px;margin-top:7px}.overview-comparisons{display:grid;grid-template-columns:1.2fr 1fr;gap:36px;padding:20px 0 24px;border-bottom:1px solid var(--cost-line)}.overview-comparisons>section{min-width:0}.overview-comparisons header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.overview-comparisons h2{font-size:13px;margin:0;font-weight:550}.overview-comparisons header>span{font-size:10px;color:var(--cost-muted)}.ranking-row{display:grid;grid-template-columns:20px minmax(0,1fr) max-content 13px;align-items:center;gap:9px;width:100%;text-align:left;min-height:30px;font-size:11px}.ranking-row:hover{color:var(--cost-lime)}.rank-number{color:var(--cost-muted);font-size:10px}.rank-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ranking-row>strong,.breakdown-row>strong{text-align:right;font-size:11px;font-weight:500;white-space:nowrap}.ranking-row>svg{color:var(--cost-muted)}.breakdown-row{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:12px;min-height:33px;font-size:11px}.breakdown-row>span:first-child{color:var(--cost-muted)}.comparison-empty{color:var(--cost-muted);font-size:12px;min-height:120px;display:flex;align-items:center}@media(max-width:950px){.overview-comparisons{gap:24px}.ranking-row{grid-template-columns:18px minmax(0,1fr) auto}.ranking-row>svg{display:none}}@media(max-width:650px){.overview-comparisons{grid-template-columns:1fr}.comparison-empty{min-height:60px}}
</style>

<style scoped>
.finance-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;padding:22px 0;border-bottom:1px solid var(--cost-line)}
.finance-strip>div,.additional-metrics>div{min-width:0}.finance-strip span,.additional-metrics span{font-size:12px;color:var(--cost-muted)}
.finance-strip strong{display:block;font-size:30px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.3;margin:10px 0 5px;overflow-wrap:anywhere;color:var(--usage-value)}
.finance-strip>div:nth-child(2) strong{color:var(--usage-input)}.finance-strip>div:nth-child(3) strong{color:var(--usage-cache)}.finance-strip strong.is-unknown{font-size:23px;font-weight:500;color:var(--usage-unknown)}
.finance-strip small{display:block;font-size:11px;line-height:1.6;color:var(--cost-muted);max-width:280px}.finance-strip .purchase-link{margin-top:5px;color:var(--usage-cache)}
.overview-insights{border-bottom:1px solid var(--cost-line)}.overview-insights>summary{display:flex;align-items:center;gap:8px;padding:13px 0;cursor:pointer;color:var(--cost-blue);font-size:12px;list-style:none}.overview-insights>summary::-webkit-details-marker{display:none}.overview-insights>summary svg:last-child{margin-left:auto;transition:transform .15s}.overview-insights[open]>summary svg:last-child{transform:rotate(180deg)}
.additional-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;padding:14px 0 20px}.additional-metrics strong{display:block;font-size:21px;font-weight:550;margin-top:7px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.purchase-coverage{padding:15px 0}.purchase-coverage header{display:flex;align-items:center;justify-content:space-between}.purchase-coverage h3{font-size:13px;margin:0}.purchase-coverage header span{font-size:12px;color:var(--cost-muted)}
.local-overview :deep(.period-summary){margin-bottom:0}.local-overview :deep(.period-summary strong){font-size:28px}.local-overview :deep(.period-summary small){font-size:11px}
.overview-infographic{padding-top:12px;min-width:0}.infographic-scope{margin:0;padding:8px 0;color:var(--cost-muted);font-size:11px}
.usage-usd{display:block;color:var(--usage-value);font-size:28px;font-weight:650;line-height:1.25;margin:12px 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.usage-cny{display:block;color:var(--usage-input)!important;font-size:13px!important;margin:0 0 9px;font-variant-numeric:tabular-nums}
@media(min-width:1000px){.local-overview :deep(.period-summary){grid-template-columns:repeat(5,minmax(0,1fr));gap:0}.local-overview :deep(.period-summary>div){padding:0 16px}.local-overview :deep(.period-summary>div:first-child){padding-left:0}}
@media(max-width:700px){.finance-strip,.additional-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 14px}.finance-strip strong{font-size:26px}.finance-strip strong.is-unknown{font-size:21px}.finance-strip small{font-size:10px}}
</style>
