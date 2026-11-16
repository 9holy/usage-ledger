<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Clock3 } from '@lucide/vue'
import type { LocalCostLiveReport } from '@/api/localCost'
import CostLineChart from '@/features/cost-center/components/CostLineChart.vue'
import UsageEvidenceRibbon from './UsageEvidenceRibbon.vue'
import { displayLiveRate } from './liveRate'
import UsageCurrentSpeed from './UsageCurrentSpeed.vue'
import { usageModelColor, usagePercentLabel } from './usageChartPalette'
import { usageLocale } from '@/utils/usageFormat'

const props = defineProps<{ report: LocalCostLiveReport | null; error: string; name: string }>()
const { t } = useI18n()
const seconds = ref<60 | 300>(60)
const window = computed(() => props.report?.live.windows.find(row => row.seconds === seconds.value))
const rate = computed(() => displayLiveRate(window.value))
const models = computed(() => (props.report?.live.byModel ?? []).map(row => ({ ...row, window: row.windows.find(window => window.seconds === seconds.value) })).filter(row => (row.window?.observedOutputTokens ?? 0) > 0).sort((a, b) => (b.window?.observedOutputTokens ?? 0) - (a.window?.observedOutputTokens ?? 0)))
const parts = computed(() => models.value.map(row => ({ count: row.window!.observedOutputTokens, color: usageModelColor(row.model) })))
const totalOutput = computed(() => parts.value.reduce((sum, row) => sum + row.count, 0))
const labels = computed(() => props.report?.live.timeline.map(row => new Date(row.startMs).toLocaleTimeString(usageLocale(), { hour: '2-digit', minute: '2-digit' })) ?? [])
const series = computed(() => [{ label: t('desktop.localCost.observedOutput'), color: '#7eb6d8', fill: true, data: props.report?.live.timeline.map(row => row.sourceComplete !== false ? row.outputTokens : row.observedOutputTokens > 0 ? row.observedOutputTokens : null) ?? [] }])
const sourceTime = computed(() => props.report ? new Date(props.report.live.sampledAtMs).toLocaleTimeString(usageLocale()) : '—')
</script>

<template>
  <section class="local-speed-panel">
    <UsageCurrentSpeed :live="report?.live" />
    <header><div><Activity :size="18" /><h3>{{ t('usageMonitor.speed.average') }}</h3><span>{{ name }}</span></div><div class="speed-modes" role="group" :aria-label="t('desktop.localCost.rateWindow')"><button v-for="value in [60, 300] as const" :key="value" :aria-pressed="seconds === value" @click="seconds = value">{{ t(value === 60 ? 'desktop.localCost.lastMinute' : 'desktop.localCost.lastFiveMinutes') }}</button></div></header>
    <div class="speed-body"><div class="speed-reading"><strong>{{ rate.text }}</strong><span v-if="rate.value != null && rate.value > 0">Token/s</span><p>{{ t('desktop.localCost.observedRateBasis') }}</p><small><Clock3 :size="12" />{{ sourceTime }}<template v-if="rate.partial"> · {{ t('usageMonitor.text.partialSampling') }}</template></small><small v-if="error" class="speed-error">{{ t('desktop.localCost.liveUpdateFailed') }}</small></div><div class="speed-models"><UsageEvidenceRibbon v-if="models.length" :parts="parts" :total="totalOutput" :label="t('desktop.localCost.outputShare')" /><div v-for="row in models" :key="row.tool + ':' + row.model" class="speed-model"><i :style="{ background: usageModelColor(row.model) }" /><span :title="row.model ?? ''">{{ row.model ?? t('usageMonitor.text.unknownModel') }}<small>{{ usagePercentLabel(row.window!.observedOutputTokens / totalOutput * 100) }} · {{ row.window!.observedOutputTokens.toLocaleString(usageLocale()) }} Token</small></span><strong>{{ displayLiveRate(row.window).text }}<small v-if="displayLiveRate(row.window).value != null && displayLiveRate(row.window).value! > 0"> Token/s</small></strong></div><p v-if="!models.length">{{ t('desktop.localCost.noRecentOutput') }}</p></div></div>
    <CostLineChart :labels="labels" :series="series" :height="150" :state="!report ? error ? 'unavailable' : 'loading' : 'measured'" :state-reason="t('desktop.localCost.observedRateBasis')" />
  </section>
</template>

<style scoped>
.local-speed-panel{padding:22px 0;border-block:1px solid var(--cost-line);margin:24px 0}.local-speed-panel>header,.local-speed-panel header>div{display:flex;align-items:center;gap:10px}.local-speed-panel>header{justify-content:space-between;flex-wrap:wrap}.local-speed-panel h3{margin:0;font-size:16px;font-weight:550}.local-speed-panel header svg{color:var(--cost-blue)}.local-speed-panel header span{color:var(--cost-muted);font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.speed-modes{gap:0!important;border:1px solid var(--cost-line-strong);border-radius:4px;overflow:hidden}.speed-modes button{padding:7px 11px;color:var(--cost-muted);font-size:11px}.speed-modes button[aria-pressed=true]{background:var(--cost-panel-2);color:var(--cost-blue)}.speed-body{display:grid;grid-template-columns:.8fr 1.2fr;gap:32px;margin:24px 0 18px}.speed-reading>strong{font-size:34px;line-height:1.2;font-weight:550;color:var(--cost-blue);overflow-wrap:anywhere}.speed-reading>span{font-size:12px;color:var(--cost-muted);margin-left:9px}.speed-reading p{font-size:11px;color:var(--cost-muted);line-height:1.7;margin:12px 0 8px}.speed-reading>small{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--cost-muted)}.speed-reading .speed-error{color:var(--cost-gold);margin-top:8px}.speed-model{display:grid;grid-template-columns:minmax(110px,1fr) minmax(30px,1fr) minmax(70px,auto);align-items:center;gap:12px;font-size:11px;min-height:31px}.speed-model>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.speed-model>i{display:block;height:5px;background:var(--cost-panel-2)}.speed-model>strong{text-align:right;font-weight:500}.speed-model small{font-size:9px;color:var(--cost-muted)}.speed-models>p{color:var(--cost-muted);font-size:12px;padding:14px 0}@media(max-width:650px){.speed-body{grid-template-columns:1fr;gap:20px}.speed-reading>strong{font-size:28px}.local-speed-panel header span{max-width:200px}}
</style>
<style scoped>
.speed-model{grid-template-columns:5px minmax(0,1fr) auto;gap:10px;min-height:48px;border-bottom:1px solid var(--cost-line)}.speed-model>i{width:4px;height:24px}.speed-model>span{font-size:12px;white-space:normal;overflow-wrap:anywhere}.speed-model>span small{display:block;margin-top:4px;font-size:10px;color:var(--cost-muted)}.speed-model>strong{font-size:19px;font-variant-numeric:tabular-nums}.speed-model>strong small{font-size:10px}.speed-models :deep(.mode-ribbon){height:65px;margin-bottom:12px}.speed-reading>strong{color:var(--usage-input)}
</style>
