<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { monitorAutomaticPriceSummary, monitorCacheRatio, monitorCacheCoverage, monitorKnownTokenTotal, monitorTokenCoverage, monitorRequestCountLabel, type MonitorTotals, type SessionStatusCounts } from '@/api/usageMonitor'

const { t } = useI18n()
const props = defineProps<{ totals?: MonitorTotals | null; overview?: boolean; counts?: SessionStatusCounts; costText: string; costNote: string; cnyPerUsd?: number | null }>()
const prices = computed(() => monitorAutomaticPriceSummary(props.totals))
const cny = computed(() => props.cnyPerUsd && prices.value.coveredRequests > 0 && prices.value.currencies.every(row => ['USD', 'CNY'].includes(row.currency))
  ? prices.value.currencies.reduce((sum, row) => sum + (row.identifiedSubtotal ?? 0) * (row.currency === 'USD' ? props.cnyPerUsd! : 1), 0) : null)
const money = (amount: number) => new Intl.NumberFormat(usageLocale(), { style: 'currency', currency: 'CNY', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(amount)
const number = (value: number | null | undefined) => value == null ? t('usageMonitor.text.unknown') : value.toLocaleString(usageLocale())
const compact = (value: number | null | undefined) => value == null ? t('usageMonitor.text.unknown') : new Intl.NumberFormat(usageLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(value)
</script>

<template>
  <section class="period-summary" :aria-label="t('usageMonitor.text.periodUsageSummary')">
    <div><span>{{ t('usageMonitor.text.inputTokens') }}</span><strong :class="{ 'is-unknown': monitorKnownTokenTotal(totals, 'inputTokens') == null }">{{ compact(monitorKnownTokenTotal(totals, 'inputTokens')) }}</strong><small>{{ t('usageMonitor.text.cacheRead') }} {{ compact(monitorKnownTokenTotal(totals, 'cacheReadTokens')) }}</small><small v-if="monitorTokenCoverage(totals, 'inputTokens')">{{ monitorTokenCoverage(totals, 'inputTokens') }}</small><small v-if="monitorTokenCoverage(totals, 'cacheReadTokens')">{{ monitorTokenCoverage(totals, 'cacheReadTokens') }}</small></div>
    <div><span>{{ t('usageMonitor.text.outputTokens') }}</span><strong :class="{ 'is-unknown': monitorKnownTokenTotal(totals, 'outputTokens') == null }">{{ compact(monitorKnownTokenTotal(totals, 'outputTokens')) }}</strong><small>{{ t('usageMonitor.text.knownReasoning') }} {{ totals?.reasoningKnownRequests ? compact(totals.reasoningTokens) : t('usageMonitor.text.notReported') }} · {{ number(totals?.reasoningKnownRequests) }} {{ t('usageMonitor.text.requestsRecorded') }}</small><small v-if="monitorTokenCoverage(totals, 'outputTokens')">{{ monitorTokenCoverage(totals, 'outputTokens') }}</small></div>
    <div><span>{{ t('usageMonitor.text.cacheHit') }}</span><strong :class="{ 'is-unknown': totals?.cacheHitRatio == null && totals?.knownCacheHitRatio == null }">{{ monitorCacheRatio(totals) }}</strong><small>{{ t('usageMonitor.text.cacheWrite') }} {{ compact(monitorKnownTokenTotal(totals, 'cacheWriteTokens')) }}</small><small v-if="monitorCacheCoverage(totals)">{{ monitorCacheCoverage(totals) }}</small><small v-if="monitorTokenCoverage(totals, 'cacheWriteTokens')">{{ monitorTokenCoverage(totals, 'cacheWriteTokens') }}</small></div>
    <div><span>{{ totals?.unitemizedRecords ? t('usageMonitor.text.usageRecordsTotalTokens') : t('usageMonitor.text.requestsTotalTokens') }}</span><strong>{{ number(totals?.requestCount) }}</strong><small>{{ compact(monitorKnownTokenTotal(totals, 'totalTokens')) }} Token</small><small v-if="totals?.unitemizedRecords">{{ monitorRequestCountLabel(totals) }}</small><small v-if="overview" class="activity-counts" :title="t('usageMonitor.text.includesSubSessionsRecentActivityDoesNotMeanStill')">{{ t('usageMonitor.text.runningActiveInTheLast30Minutes') }} <b>{{ number(counts?.running) }} / {{ number(counts?.activeLast30m) }}</b></small></div>
    <div class="money"><slot name="amount"><span>{{ t('usageMonitor.text.usageBasedEstimate') }}</span><strong>{{ costText }}</strong></slot><small v-if="cny != null" class="converted-value">{{ t('usageMonitor.inlineCosts.cnyEquivalent', { amount: money(cny) }) }}</small><small :title="costNote">{{ t('usageMonitor.inlineCosts.pricedRequests', { priced: number(prices.coveredRequests), total: number(totals?.requestCount) }) }}</small><small>{{ t('usageMonitor.text.tokenReferenceCostNotSubscriptionPayments') }}</small></div>
  </section>
</template>

<style scoped>
.period-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--cost-line);padding:20px 0 24px;margin-bottom:22px}.period-summary>div{padding:0 20px;border-right:1px solid var(--cost-line);min-width:0}.period-summary>div:first-child{padding-left:0}.period-summary>div:last-child{padding-right:0;border:0}span{font-size:14px;color:#b4c4ba}strong{display:block;font-size:34px;font-weight:650;margin:12px 0;line-height:1.25;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}small{display:block;font-size:12px;color:#a3b7aa;line-height:1.7}.period-summary>div:nth-child(1) strong{color:var(--usage-input)}.period-summary>div:nth-child(2) strong{color:var(--usage-output)}.period-summary>div:nth-child(3) strong{color:var(--usage-cache)}.money strong{font-size:30px;color:var(--usage-value)}@media(max-width:1200px){.period-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.period-summary>div{padding-left:0;border:0}}@media(max-width:650px){.period-summary{grid-template-columns:repeat(2,minmax(0,1fr))}strong{font-size:28px}.money strong{font-size:26px}.period-summary>.money{grid-column:1/-1;border-top:1px solid var(--cost-line);padding-top:16px}}
.period-summary>div strong.is-unknown{color:var(--usage-unknown)}
.activity-counts{margin-top:6px}.activity-counts b{color:var(--cost-text);font-weight:600}.converted-value{color:var(--cost-blue)}
</style>

