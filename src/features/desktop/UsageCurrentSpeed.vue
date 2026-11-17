<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Info } from '@lucide/vue'
import type { LiveSnapshot } from '@/api/usageMonitor'
import { usageModelColor } from './usageChartPalette'
import { usageLocale } from '@/utils/usageFormat'
import { lastRateLabel } from './liveRate'

const props = defineProps<{ live?: LiveSnapshot | null; tool?: string | null; running?: number; compact?: boolean }>()
const { t } = useI18n()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
watch(() => props.live?.currentRates?.length ?? 0, count => { clearInterval(timer); now.value = Date.now(); if (count) timer = setInterval(() => { now.value = Date.now() }, 1000) }, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))
const samples = computed(() => props.live?.currentRates?.filter(row => (!props.tool || row.tool === props.tool) && row.sampledAtMs >= now.value - 10_000) ?? [])
const total = computed(() => samples.value.reduce((sum, row) => sum + row.outputTokensPerSecond, 0))
const models = computed(() => {
  const grouped = new Map<string | null, number>()
  for (const row of samples.value) grouped.set(row.model, (grouped.get(row.model) ?? 0) + row.outputTokensPerSecond)
  return [...grouped].map(([model, value]) => ({ model, value })).sort((a,b) => b.value-a.value)
})
const number = (value: number) => new Intl.NumberFormat(usageLocale(), { maximumFractionDigits: 2, maximumSignificantDigits: 4 }).format(value)
const reading = computed<{ tool?: string | null; value: number; time: number; last: boolean } | undefined>(previous => {
  if (samples.value.length) return { tool: props.tool, value: total.value, time: Math.max(...samples.value.map(row => row.sampledAtMs)), last: false }
  if (props.running && previous && previous.tool === props.tool) return { ...previous, last: true }
  return undefined
})
const updated = computed(() => reading.value ? new Date(reading.value.time).toLocaleTimeString(usageLocale(), { hour12: false }) : null)
</script>

<template>
  <section class="current-speed" :class="{'is-compact':compact}" :aria-label="t('usageMonitor.speed.current')">
    <div class="current-reading"><span><Activity :size="16" />{{ t('usageMonitor.speed.current') }}<Info :size="13" :aria-label="t('usageMonitor.speed.basis')" :title="t('usageMonitor.speed.basis')" /></span><strong v-if="reading">{{ number(reading.value) }}<small>Token/s</small></strong><strong v-else class="speed-waiting">{{ t(running ? 'usageMonitor.text.running' : 'usageMonitor.speed.waiting') }}</strong><small v-if="reading">{{ reading.last ? lastRateLabel(reading.time) : t('usageMonitor.speed.updated', { time: updated }) }}</small></div>
    <div v-if="!compact" class="current-models"><div v-for="row in models" :key="row.model ?? 'unknown'" class="current-model" :style="{ '--current-color': usageModelColor(row.model) }"><span>{{ row.model ?? t('usageMonitor.text.unknownModel') }}</span><strong>{{ number(row.value) }}<small>Token/s</small></strong><i :style="{ width: row.value / total * 100 + '%' }" /></div></div>
  </section>
</template>

<style scoped>
.current-speed{display:grid;grid-template-columns:290px minmax(0,1fr);gap:28px;padding:20px 0 24px;border-bottom:1px solid var(--cost-line);margin-bottom:20px}.current-reading{min-width:0}.current-reading>span{display:flex;align-items:center;gap:8px;font-size:14px}.current-reading>span>svg:first-child{color:var(--cost-lime)}.current-reading>strong{display:block;font-size:42px;font-weight:600;color:var(--cost-lime);line-height:1.3;margin:12px 0 8px}.current-reading strong>small,.current-model small{font-size:11px;font-weight:400;color:var(--cost-muted);margin-left:8px}.current-reading>small,.current-models>p{font-size:11px;line-height:1.7;color:var(--cost-muted)}.current-reading>.speed-waiting{font-size:22px;overflow-wrap:anywhere}.current-models{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px 28px;align-content:center;min-width:0}.current-model{position:relative;display:flex;justify-content:space-between;gap:12px;padding-bottom:12px;min-width:0}.current-model>span{font-size:13px;overflow-wrap:anywhere}.current-model>strong{color:var(--current-color);white-space:nowrap;font-size:22px;font-weight:550}.current-model>i{position:absolute;left:0;bottom:0;height:3px;background:var(--current-color);max-width:100%}.current-models>p{align-self:center;margin:0}@media(max-width:750px){.current-speed{grid-template-columns:minmax(0,1fr);gap:16px}}
</style>
<style scoped>
.current-speed.is-compact{display:block;padding:0 20px 0 0;margin:0;border:0;border-right:1px solid var(--cost-line)}.is-compact .current-reading>span{font-size:12px}.is-compact .current-reading>strong{font-size:26px;margin:8px 0 4px}.is-compact .current-reading>.speed-waiting{font-size:16px;line-height:1.5}.is-compact .current-reading>small{font-size:10px}
</style>
