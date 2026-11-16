<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock3 } from '@lucide/vue'
import UsageModelCosts from './UsageModelCosts.vue'
import UsageTrend from './UsageTrend.vue'
import UsageRecordedMetrics from './UsageRecordedMetrics.vue'
import UsageTokenComposition from './UsageTokenComposition.vue'
import UsageEfficiencyBand from './UsageEfficiencyBand.vue'
import UsageValueChart from './UsageValueChart.vue'
import LocalCostSpeedPanel from './LocalCostSpeedPanel.vue'
import type { LocalCostReport, LocalCostLiveReport } from '@/api/localCost'
import type { LocalCostRow } from './localCostMath'
import type { MonitorQuota, MonitorTotals } from '@/api/usageMonitor'
import { monitorAutomaticPriceSummary } from '@/api/usageMonitor'
import { projectAccountQuotaCycle } from './accountQuotaProjection'
import { usageLocale } from '@/utils/usageFormat'
import { displayLiveRate } from './liveRate'

const props = defineProps<{ report: LocalCostReport; rows: LocalCostRow[]; quotas: MonitorQuota[]; quotaError: string; summaryOnly?: boolean; accountLocked?: boolean; live?: LocalCostLiveReport | null; liveError?: string }>()
const accountId = defineModel<string>({ required: true })
const sourceKey = defineModel<string>('source', { default: 'all' })
const { t } = useI18n()
const selected = computed(() => props.rows.find(row => row.id === accountId.value))
const sources = computed(() => Object.keys(selected.value?.sources ?? {}))
watch(accountId, () => { sourceKey.value = 'all' })
watch(sources, keys => { if (sourceKey.value !== 'all' && !keys.includes(sourceKey.value)) sourceKey.value = 'all' })
const sourceName = (key: string): string => key.split('+').map(item => ({ direct: t('usageMonitor.routes.direct'), unknown: t('usageMonitor.routes.unknown'), api: 'API', cockpit: 'Cockpit', sub2api: 'Sub2API', cliproxy: 'CLIProxyAPI' }[item] ?? item)).join(' / ')
const analytics = computed(() => sourceKey.value !== 'all' ? selected.value?.sources?.[sourceKey.value] : accountId.value === 'all' ? props.report.analytics : selected.value?.analytics)
const totals = computed(() => analytics.value?.totals ?? selected.value?.totals)
const periods = computed(() => selected.value?.periods)
const monthPeriod = computed(() => periods.value?.subscriptionMonth ?? periods.value?.calendarMonth)
const currentLive = computed(() => props.live?.accountKey === accountId.value && (props.live.sourceKey ?? 'all') === sourceKey.value ? props.live : null)
const modelExpenses = computed(() => {
  const account=props.report.apiExpense.byAccount?.[accountId.value]
  if (sourceKey.value !== 'all') return account?.bySource?.[sourceKey.value]
  return props.report.apiExpense.byAccount ? account?.byModel : accountId.value === 'api:all' || accountId.value === 'all' ? props.report.apiExpense.byModel : undefined
})
const cycle = computed(() => periods.value?.currentCycle)
const projection = computed(() => cycle.value ? projectAccountQuotaCycle(cycle.value, selected.value?.tool ?? '') : null)
const sampledTotals = computed(() => {
  const sample = cycle.value?.quotaSnapshot
  return selected.value?.tool === 'codex' && sample?.billingTotals ? sample.billingTotals.subscription : sample?.totals
})
const matchingQuota = computed(() => props.quotas.filter(quota => quota.accountKey === selected.value?.id && quota.tool === selected.value?.tool && quota.attribution === 'account' && quota.windowMinutes === 10080 && ((quota.tool === 'codex' && quota.limitId === 'codex') || (quota.tool === 'claude' && quota.limitId === 'seven_day'))).sort((a, b) => (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0))[0])
const projectionUsable = computed(() => !!projection.value?.quotes.length && !!cycle.value && (projection.value.finalized || (cycle.value.current && cycle.value.resetAtMs > Date.now())))
const quotaWaiting = computed(() => !!props.quotaError || !matchingQuota.value || matchingQuota.value.stale || matchingQuota.value.expired || !!matchingQuota.value.sourceError || matchingQuota.value.observedAtMs !== cycle.value?.quotaObservedAtMs || matchingQuota.value.usedPercent !== cycle.value?.usedPercent)
const models = computed(() => (analytics.value?.models ?? []).slice().sort((a, b) => b.totals.totalTokens - a.totals.totalTokens))
const money = (amount: number | null, currency = 'CNY') => amount == null ? '—' : new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 4 }).format(amount)
const date = (stamp: number | null | undefined) => stamp == null ? '—' : new Date(stamp).toLocaleString(usageLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const number = (amount: number | null | undefined) => amount == null ? '—' : amount.toLocaleString(usageLocale())
const value = (totals?: MonitorTotals | null) => monitorAutomaticPriceSummary(totals).currencies.filter(row => row.identifiedSubtotal != null).map(row => money(row.identifiedSubtotal, row.currency)).join(' / ') || '—'
</script>

<template>
  <section class="local-usage-panel" :class="{ 'is-summary': summaryOnly }">
    <header class="usage-scope"><h2>{{ t('desktop.localCost.usageAndQuota') }}</h2><span v-if="analytics?.latestRequestMs">{{ t('desktop.localCost.latestUsageAt', { time: date(analytics.latestRequestMs) }) }}</span><select v-if="!accountLocked" v-model="accountId" :aria-label="t('desktop.localCost.statisticsAccount')"><option value="all">{{ t('desktop.localCost.allRecordedUsage') }}</option><option v-for="row in rows" :key="row.id" :value="row.id">{{ row.name }}</option></select><span class="compact-rate" v-if="currentLive">{{ t('usageMonitor.speed.average') }} {{ displayLiveRate(currentLive.live.windows.find(row => row.seconds === 60)).text }}<template v-if="displayLiveRate(currentLive.live.windows.find(row => row.seconds === 60)).value! > 0"> Token/s</template></span></header>
    <section v-if="periods && selected?.billingKind !== 'api' && (!summaryOnly || cycle)" class="quota-details">
      <header><h3>{{ t('desktop.localCost.currentWeeklyQuota') }}</h3><span v-if="cycle">{{ date(cycle.startMs) }} – {{ date(cycle.resetAtMs) }}</span></header>
      <div class="quota-metrics">
        <div><span>{{ t('desktop.localCost.' + (quotaWaiting ? 'lastQuotaUsed' : 'quotaUsed')) }}</span><strong>{{ cycle?.usedPercent == null ? '—' : cycle.usedPercent.toFixed(1) + '%' }}</strong><small v-if="cycle?.quotaObservedAtMs">{{ t('desktop.localCost.updated', { time: date(cycle.quotaObservedAtMs) }) }}</small></div>
        <div><span>{{ t('desktop.localCost.sampledQuotaValue') }}</span><strong>{{ value(sampledTotals) }}</strong><small>{{ t('desktop.localCost.sameQuotaSample') }}</small></div>
        <div class="quota-prediction"><span>{{ projection?.partial ? t('usageMonitor.text.pricedPortionProjection') : projection?.finalized ? t('desktop.localCost.finalQuotaValue') : t('desktop.localCost.fullQuotaProjection') }}</span><template v-if="projectionUsable"><strong v-for="quote in projection!.quotes" :key="quote.currency">{{ projection!.finalized ? '' : '≈ ' }}{{ money(quote.projectedSubtotal, quote.currency) }}</strong><small v-if="quotaWaiting && !projection!.finalized">{{ t('desktop.localCost.retainedQuotaEstimate') }}</small><small v-if="projection!.partial">{{ t('usageMonitor.text.pricedPortionCoverage', { priced: projection!.coveredRequests, total: projection!.requestCount }) }}</small></template><strong v-else class="quota-unavailable">{{ t('usageMonitor.text.estimateUnavailable') }}</strong></div>
        <div><span>{{ t('desktop.localCost.resetAt') }}</span><strong class="quota-time">{{ date(cycle?.resetAtMs) }}</strong><small>{{ t('desktop.localCost.sourceCycle') }}</small></div>
      </div>
      <p v-if="!projectionUsable && projection?.reason" class="usage-note">{{ t('usageMonitor.text.' + (quotaWaiting ? 'weeklyQuotaAwaitingUpdate' : projection.reason)) }}</p>
      <p v-else-if="cycle?.quotaSnapshot?.sourceCoverageIncomplete" class="usage-note">{{ t('usageMonitor.routes.partialUsage') }}</p>
      <p v-if="quotaError" class="usage-error">{{ quotaError }}</p>
      <template v-if="!summaryOnly">
      <div class="period-values"><div><span>{{ t('desktop.localCost.cycleUsageValue') }}</span><strong>{{ value(cycle?.totals) }}</strong></div><div><span>{{ t(periods.subscriptionMonth ? 'desktop.localCost.subscriptionMonthValue' : 'usageMonitor.text.usedThisMonth') }}</span><strong>{{ value(monthPeriod?.totals) }}</strong><small v-if="monthPeriod">{{ date(monthPeriod.startMs) }} – {{ date(monthPeriod.endMs) }}</small></div><div><span>{{ t('desktop.localCost.previousCycleValue') }}</span><strong>{{ value(periods.previousCycle?.totals) }}</strong></div><div><span>{{ t('desktop.localCost.subscriptionExpiry') }}</span><strong class="period-date">{{ date(periods.subscription.endMs) }}</strong></div></div>
      <details v-if="periods.quotaCycles.length" class="quota-history"><summary><Clock3 :size="14" />{{ t('desktop.localCost.quotaHistory') }} <span>{{ periods.quotaCycles.length }}</span></summary><div class="usage-table-scroll"><table><thead><tr><th>{{ t('desktop.localCost.cycleDates') }}</th><th>{{ t('desktop.localCost.quotaUsed') }}</th><th>{{ t('desktop.localCost.value') }}</th><th>{{ t('desktop.localCost.requests') }}</th><th>{{ t('desktop.localCost.resetAt') }}</th></tr></thead><tbody><tr v-for="item in periods.quotaCycles" :key="item.startMs + ':' + item.resetAtMs"><td>{{ date(item.startMs) }} – {{ date(item.endMs) }}<small v-if="item.current">{{ t('desktop.localCost.inProgress') }}</small></td><td>{{ item.usedPercent == null ? '—' : item.usedPercent.toFixed(1) + '%' }}</td><td>{{ item.exhaustionUnknown ? t('usageMonitor.text.exhaustionTimeNotRecorded') : value(item.totals) }}</td><td>{{ number(item.totals.requestCount) }}</td><td>{{ date(item.resetAtMs) }}</td></tr></tbody></table></div></details>
      <details v-if="periods.monthCycles.length || periods.unsegmentedMonth.requestCount" class="quota-history"><summary><Clock3 :size="14" />{{ t('desktop.localCost.monthCycleDetails') }}</summary><p class="usage-note">{{ t('desktop.localCost.monthCycleBasis') }}</p><div class="usage-table-scroll"><table><thead><tr><th>{{ t('desktop.localCost.cycleDates') }}</th><th>{{ t('desktop.localCost.value') }}</th><th>{{ t('desktop.localCost.requests') }}</th></tr></thead><tbody><tr v-for="item in periods.monthCycles" :key="item.startMs + ':' + item.resetAtMs"><td>{{ date(item.startMs) }} – {{ date(item.endMs) }}</td><td>{{ value(item.totals) }}</td><td>{{ number(item.totals.requestCount) }}</td></tr><tr v-if="periods.unsegmentedMonth.requestCount"><td>{{ t('desktop.localCost.unsegmentedMonth') }}</td><td>{{ value(periods.unsegmentedMonth) }}</td><td>{{ number(periods.unsegmentedMonth.requestCount) }}</td></tr></tbody></table></div></details>
      <p v-if="periods.verifiedHistory?.totals.requestCount" class="usage-note">{{ t('desktop.localCost.verifiedHistory') }} {{ value(periods.verifiedHistory.totals) }} · {{ date(periods.verifiedHistory.startMs) }} – {{ date(periods.verifiedHistory.observedEndMs) }}</p>
      </template>
    </section>
    <p v-else-if="selected?.id === 'api:all' || selected?.billingKind === 'api'" class="usage-note">{{ t('desktop.localCost.apiHasNoQuota') }}</p>
    <template v-if="!summaryOnly">
    <div v-if="sources.length" class="account-call-sources"><label>{{ t('usageMonitor.routes.label') }}<select v-model="sourceKey" :aria-label="t('usageMonitor.routes.label')"><option value="all">{{ t('usageMonitor.routes.all') }}</option><option v-for="source in sources" :key="source" :value="source">{{ sourceName(source) }}</option></select></label><dl><div v-for="source in sources" :key="source"><dt>{{ sourceName(source) }}</dt><dd>{{ number(selected!.sources![source].totals.requestCount) }} {{ t('desktop.localCost.requests') }}<small>{{ value(selected!.sources![source].totals) }}</small></dd></div></dl></div>
    <UsageModelCosts :models="models" :expenses="modelExpenses" :live="currentLive?.live" :period="sourceKey === 'all' ? t('usageMonitor.routes.all') : sourceName(sourceKey)" />
    <div v-if="projectionUsable && cycle" class="quota-infographics"><UsageValueChart v-for="quote in projection!.quotes" :key="quote.currency" :forecast="quote" :quota="{ accountLabel: selected?.name ?? '', usedPercent: cycle.usedPercent! }" :partial="projection!.partial" /></div>
    <LocalCostSpeedPanel :report="currentLive" :error="liveError ?? ''" :name="selected?.name ?? t('desktop.localCost.allRecordedUsage')" />
    <UsageTokenComposition :input-tokens="totals?.inputTokens" :output-tokens="totals?.outputTokens" :cache-read-tokens="totals?.cacheReadTokens" :partial="!!totals?.incompleteRequests" />
    <UsageEfficiencyBand :totals="totals" :motion="false" />
    <UsageRecordedMetrics :totals="totals" />
    <UsageTrend :timeline="analytics?.timeline" :history="analytics?.observedTimeline" :totals="totals" initial-metric="value" />
    </template>
  </section>
</template>

<style scoped>
.account-call-sources{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-top:24px;padding:16px 0;border-block:1px solid var(--cost-line)}.account-call-sources label{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--cost-muted)}.account-call-sources select{min-height:34px;padding:6px 9px;background:var(--cost-panel);color:var(--cost-text);border:1px solid var(--cost-line);border-radius:4px}.account-call-sources dl{display:flex;gap:24px;flex-wrap:wrap;margin:0}.account-call-sources dt{font-size:11px;color:var(--cost-muted)}.account-call-sources dd{font-size:13px;margin:6px 0 0;font-variant-numeric:tabular-nums}.account-call-sources small{display:block;font-size:11px;color:var(--cost-gold);margin-top:4px}
.local-usage-panel{padding-top:22px;min-width:0}.local-usage-panel header{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}.local-usage-panel h2{font-size:16px;font-weight:550;margin:0}.local-usage-panel h3{font-size:13px;font-weight:550;margin:0}.local-usage-panel header>span{font-size:10px;color:var(--cost-muted)}.usage-scope{margin-bottom:22px}.usage-scope select{min-width:200px;max-width:100%}.quota-details{border-block:1px solid var(--cost-line);padding:20px 0}.quota-details>header{margin-bottom:20px}.quota-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px}.quota-metrics>div,.period-values>div{min-width:0}.quota-metrics span,.period-values span{display:block;font-size:11px;color:var(--cost-muted);line-height:1.6}.quota-metrics strong{display:block;font-size:26px;font-weight:550;margin:9px 0;overflow-wrap:anywhere}.quota-metrics small,.period-values small{display:block;color:var(--cost-muted);font-size:10px;line-height:1.6}.quota-metrics .quota-prediction strong{color:var(--cost-lime)}.quota-metrics .quota-time{font-size:17px;line-height:1.8}.quota-metrics .quota-unavailable{font-size:15px!important;color:var(--cost-muted)!important}.usage-note,.usage-error{font-size:11px;line-height:1.7;color:var(--cost-muted);margin:15px 0}.usage-error{color:var(--cost-gold)}.period-values{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px;margin-top:22px;padding-top:18px;border-top:1px solid var(--cost-line)}.period-values strong{display:block;font-size:17px;margin-top:7px;font-weight:500;overflow-wrap:anywhere}.period-values .period-date{font-size:14px}.quota-history{margin-top:20px}.quota-history summary{display:flex;gap:8px;align-items:center;cursor:pointer;font-size:12px;color:var(--cost-blue)}.quota-history summary span{color:var(--cost-muted);font-size:10px}.usage-table-scroll{width:100%;overflow-x:auto;margin-top:12px}.usage-table-scroll table{border-collapse:collapse;width:100%;font-size:11px}.usage-table-scroll th,.usage-table-scroll td{text-align:right;padding:13px 10px;border-bottom:1px solid var(--cost-line);white-space:nowrap;vertical-align:top}.usage-table-scroll th:first-child,.usage-table-scroll td:first-child{text-align:left}.usage-table-scroll th{color:var(--cost-muted);font-weight:400;font-size:10px;background:var(--cost-panel)}.usage-table-scroll strong{font-weight:550}.usage-table-scroll small{display:block;font-size:10px;color:var(--cost-muted);margin-top:5px}.usage-table-scroll .usage-empty{padding:35px;text-align:center;color:var(--cost-muted)}@media(max-width:950px){.quota-metrics,.period-values{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:550px){.quota-metrics strong{font-size:21px}.usage-scope select{width:100%}.period-values{gap:20px 12px}.period-values strong{font-size:14px}}
</style>
<style scoped>
.compact-rate{color:var(--cost-blue)!important;font-size:11px!important}.quota-infographics{margin:10px 0 20px}
</style>
