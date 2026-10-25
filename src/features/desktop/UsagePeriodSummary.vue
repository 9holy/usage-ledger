<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { monitorCacheRatio, monitorCacheCoverage, type MonitorTotals, type SessionStatusCounts } from '@/api/usageMonitor'

const { t } = useI18n()
defineProps<{ totals?: MonitorTotals | null; overview?: boolean; counts?: SessionStatusCounts; costText: string; costNote: string }>()
const number = (value: number | null | undefined) => value == null ? t('usageMonitor.text.unknown') : value.toLocaleString(usageLocale())
const compact = (value: number | null | undefined) => value == null ? t('usageMonitor.text.unknown') : new Intl.NumberFormat(usageLocale(), { notation: 'compact', maximumFractionDigits: 2 }).format(value)
</script>

<template>
  <section class="period-summary" :aria-label="t('usageMonitor.text.periodUsageSummary')">
    <div><span>{{ t('usageMonitor.text.inputTokens') }}</span><strong :class="{ 'is-unknown': totals?.inputTokens == null }">{{ compact(totals?.inputTokens) }}</strong><small>{{ t('usageMonitor.text.cacheRead') }} {{ compact(totals?.cacheReadTokens) }}</small></div>
    <div><span>{{ t('usageMonitor.text.outputTokens') }}</span><strong :class="{ 'is-unknown': totals?.outputTokens == null }">{{ compact(totals?.outputTokens) }}</strong><small>{{ t('usageMonitor.text.knownReasoning') }} {{ totals?.reasoningKnownRequests ? compact(totals.reasoningTokens) : t('usageMonitor.text.notReported') }} · {{ number(totals?.reasoningKnownRequests) }} {{ t('usageMonitor.text.requestsRecorded') }}</small></div>
    <div><span>{{ t('usageMonitor.text.cacheHit') }}</span><strong :class="{ 'is-unknown': totals?.cacheHitRatio == null && totals?.knownCacheHitRatio == null }">{{ monitorCacheRatio(totals) }}</strong><small>{{ t('usageMonitor.text.cacheWrite') }} {{ compact(totals?.cacheWriteTokens) }}</small><small v-if="monitorCacheCoverage(totals)">{{ monitorCacheCoverage(totals) }}</small></div>
    <div><span>{{ overview ? t('usageMonitor.text.runningActiveInTheLast30Minutes') : t('usageMonitor.text.requestsTotalTokens') }}</span><strong>{{ overview ? number(counts?.running) + ' / ' + number(counts?.activeLast30m) : number(totals?.requestCount) }}</strong><small>{{ overview ? t('usageMonitor.text.includesSubSessionsRecentActivityDoesNotMeanStill') : compact(totals?.totalTokens) + ' Token' }}</small></div>
    <div class="money"><span>{{ t('usageMonitor.text.usageBasedEstimate') }}</span><strong>{{ costText }}</strong><small>{{ costNote }}</small><small>{{ t('usageMonitor.text.tokenReferenceCostNotSubscriptionPayments') }}</small></div>
  </section>
</template>

<style scoped>
.period-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--cost-line);padding:20px 0 24px;margin-bottom:22px}.period-summary>div{padding:0 20px;border-right:1px solid var(--cost-line);min-width:0}.period-summary>div:first-child{padding-left:0}.period-summary>div:last-child{padding-right:0;border:0}span{font-size:14px;color:#b4c4ba}strong{display:block;font-size:34px;font-weight:650;margin:12px 0;line-height:1.25;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}small{display:block;font-size:12px;color:#a3b7aa;line-height:1.7}.period-summary>div:nth-child(1) strong{color:var(--usage-input)}.period-summary>div:nth-child(2) strong{color:var(--usage-output)}.period-summary>div:nth-child(3) strong{color:var(--usage-cache)}.money strong{font-size:30px;color:var(--usage-value)}@media(max-width:1200px){.period-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.period-summary>div{padding-left:0;border:0}}@media(max-width:650px){.period-summary{grid-template-columns:repeat(2,minmax(0,1fr))}strong{font-size:28px}.money strong{font-size:26px}.period-summary>.money{grid-column:1/-1;border-top:1px solid var(--cost-line);padding-top:16px}}
.period-summary>div strong.is-unknown{color:var(--usage-unknown)}
</style>

