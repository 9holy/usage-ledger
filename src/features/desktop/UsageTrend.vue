<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import CostLineChart from '@/features/cost-center/components/CostLineChart.vue'
import { monitorAutomaticPriceSummary, type MonitorAnalysis, type MonitorTotals, type LiveBucket } from '@/api/usageMonitor'
import { usageLocale } from '@/utils/usageFormat'
import { usageColors, usageIntensityColors } from './usageChartPalette'

const props = defineProps<{ timeline?: MonitorAnalysis['timeline']; history?: LiveBucket[]; totals?: MonitorTotals | null; loading?: boolean; error?: string; initialMetric?: 'output' | 'value' }>()
const { t } = useI18n()
const metric = ref<'input' | 'output' | 'cache' | 'value' | 'tokens' | 'requests'>(props.initialMetric ?? 'output')
const rateHistory = ref(false)
const currency = ref('USD')
const currencies = computed(() => [...new Set((props.timeline ?? []).flatMap(item => monitorAutomaticPriceSummary(item.totals).currencies.filter(row => row.identifiedSubtotal != null).map(row => row.currency)))].sort())
const chosenCurrency = computed({ get: () => currencies.value.includes(currency.value) ? currency.value : currencies.value[0] ?? 'USD', set: value => { currency.value = value } })
const metrics = computed(() => [
  { id: 'input', label: t('usageMonitor.text.input') }, { id: 'output', label: t('usageMonitor.text.output') },
  { id: 'cache', label: t('usageMonitor.text.cache') }, { id: 'value', label: t('usageMonitor.text.referenceValue2') },
  { id: 'tokens', label: t('usageMonitor.inlineCosts.totalTokens') }, { id: 'requests', label: t('usageMonitor.text.requests') },
] as const)
function points<T extends { startMs: number; endMs: number }>(rows: T[]) {
  if (!rows.length) return []
  const step = rows[0].endMs - rows[0].startMs
  const byTime = new Map(rows.map(row => [row.startMs, row]))
  const result: Array<{ time: number; row?: T }> = []
  for (let time = rows[0].startMs; time <= rows.at(-1)!.startMs; time += step) result.push({ time, row: byTime.get(time) })
  return result
}
const usagePoints = computed(() => points(props.timeline ?? []))
const historyPoints = computed(() => points(props.history ?? []))
const labels = computed(() => (rateHistory.value ? historyPoints.value : usagePoints.value).map(({ time }) => new Date(time).toLocaleString(usageLocale(), { month: '2-digit', day: '2-digit', ...((props.timeline?.[0]?.endMs ?? 0) - (props.timeline?.[0]?.startMs ?? 0) < 20 * 3600000 ? { hour: '2-digit', minute: '2-digit', hour12: false } as const : {}) })))
const values = computed(() => rateHistory.value
  ? historyPoints.value.map(({ row }) => row && row.coveredMs > 0 ? row.observedOutputTokens * 1000 / row.coveredMs : null)
  : usagePoints.value.map(({ row }) => {
    if (!row) return null
    if (metric.value === 'value') return row.totals.requestCount === 0 ? 0 : monitorAutomaticPriceSummary(row.totals).currencies.find(item => item.currency === chosenCurrency.value)?.identifiedSubtotal ?? null
    return row.totals[({ input: 'inputTokens', output: 'outputTokens', cache: 'cacheReadTokens', tokens: 'totalTokens', requests: 'requestCount' } as const)[metric.value]]
  }))
const peak = computed(() => Math.max(0, ...values.value.map(value => value ?? 0)))
const peakIndex = computed(() => values.value.findIndex(value => value != null && value === peak.value))
const label = computed(() => rateHistory.value ? t('desktop.localCost.savedRateHistory') : metrics.value.find(item => item.id === metric.value)!.label)
const unit = computed(() => rateHistory.value ? { divisor: 1, label: 'Token/s' } : metric.value === 'value' ? { divisor: 1, label: chosenCurrency.value } : metric.value === 'requests' ? { divisor: 1, label: t('desktop.localCost.requests') } : peak.value >= 1e6 ? { divisor: 1e6, label: t('usageMonitor.text.millionTokens') } : peak.value >= 1000 ? { divisor: 1000, label: t('usageMonitor.text.thousandTokens') } : { divisor: 1, label: 'Token' })
const peakText = computed(() => (peak.value / unit.value.divisor).toLocaleString(usageLocale(), peak.value > 0 && peak.value / unit.value.divisor < .01 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 }) + ' ' + unit.value.label)
const series = computed(() => [{ label: label.value, color: usageColors[metric.value === 'tokens' ? 'input' : metric.value], fill: true, colorStops: usageIntensityColors.map((color, index) => ({ color, value: (peak.value || 1) * index / 2 })), data: values.value }])
const state = computed(() => props.error ? 'stale' : !props.totals ? props.loading ? 'loading' : 'unavailable' : rateHistory.value
  ? !props.history?.length ? 'empty' : props.history.some(row => row.coveredMs < row.endMs - row.startMs || row.sourceComplete === false) ? 'partial' : 'measured'
  : !props.totals.requestCount ? 'empty' : props.totals.incompleteRequests || (metric.value === 'value' && !monitorAutomaticPriceSummary(props.totals).complete) ? 'partial' : 'measured')
const note = computed(() => t(rateHistory.value ? 'desktop.localCost.rateHistoryBasis' : metric.value === 'value' ? 'usageMonitor.text.estimatedUsingEachIdentifiedModeMissingModesOrPrices' : 'usageMonitor.text.aggregatedByRequestRecordTimeHoverForExactUsage'))
</script>

<template>
  <section class="trend-section usage-trend">
    <header><h2>{{ t('usageMonitor.text.usageTrend') }}</h2><div class="source-selector" role="group" :aria-label="t('usageMonitor.text.chartMetric')"><button v-for="item in metrics" :key="item.id" type="button" :aria-pressed="metric === item.id && !rateHistory" @click="metric = item.id; rateHistory = false">{{ item.label }}</button></div></header>
    <div class="chart-unit"><span v-if="peakIndex >= 0" class="trend-peak"><i aria-hidden="true" />{{ t('usageMonitor.text.recordedPeak') }} <strong>{{ peakText }}</strong><small>{{ labels[peakIndex] }}</small></span><label class="rate-history-toggle"><input v-model="rateHistory" type="checkbox" />{{ t('desktop.localCost.savedRateHistory') }}</label><select v-if="metric === 'value' && !rateHistory" v-model="chosenCurrency" :aria-label="t('costComponents.currency')"><option v-for="item in currencies" :key="item" :value="item">{{ item }}</option></select><span>{{ t('usageMonitor.text.unit') }}{{ unit.label }}</span></div>
    <CostLineChart :labels="labels" :series="series" :height="260" show-values :value-divisor="unit.divisor" :value-suffix="rateHistory ? ' Token/s' : metric === 'value' ? '' : metric === 'requests' ? ' ' + t('desktop.localCost.requests') : ' Token'" :state="state" :state-reason="error || note" />
    <p class="chart-note">{{ note }}</p>
  </section>
</template>

<style scoped>
.trend-section{min-width:0;padding:18px 0 16px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}h2{font-size:20px;font-weight:650;margin:0}.source-selector{display:flex;flex-wrap:wrap;gap:0}.source-selector button{min-height:34px;padding:6px 12px;font-size:12px;border:1px solid var(--cost-line);margin-left:-1px;color:var(--cost-muted)}.source-selector button[aria-pressed=true]{color:var(--cost-lime);background:var(--cost-panel)}.source-selector button:first-child{border-radius:4px 0 0 4px}.source-selector button:last-child{border-radius:0 4px 4px 0}.chart-unit{display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:10px 16px;min-height:36px;font-size:11px;color:var(--cost-muted)}.chart-unit select{padding:5px 8px;background:var(--cost-panel);border:1px solid var(--cost-line);border-radius:4px;color:var(--cost-text)}.trend-peak{display:inline-flex;align-items:center;flex-wrap:wrap;gap:7px;margin-right:auto}.trend-peak>i{width:6px;height:6px;background:var(--usage-output);transform:rotate(45deg)}.trend-peak strong{color:var(--usage-output);font-weight:600;font-variant-numeric:tabular-nums}.trend-peak small{font-size:11px}.rate-history-toggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer}.rate-history-toggle input{width:14px;height:14px;min-height:0;accent-color:var(--cost-blue)}.chart-note{font-size:11px;line-height:1.7;color:var(--cost-muted);margin:10px 0}
</style>
