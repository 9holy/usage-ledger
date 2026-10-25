<template>
  <section ref="root" class="glass-quality" :lang="locale" :aria-label="t('costComponents.requestQualityFlowAndMeasuredHistory')">
    <div class="quality-toolbar">
      <div class="quality-tabs" role="tablist" :aria-label="t('costComponents.requestQualityViews')" @keydown="tabKey">
        <button type="button" role="tab" :aria-selected="tab === 'overview'" :tabindex="tab === 'overview' ? 0 : -1" @click="tab = 'overview'"> {{ t('costComponents.overview') }} </button>
        <button type="button" role="tab" :aria-selected="tab === 'history'" :tabindex="tab === 'history' ? 0 : -1" @click="tab = 'history'"> {{ t('costComponents.history') }} </button>
      </div>
      <div class="quality-legend" :aria-label="t('costComponents.requestQualityLegend')">
        <button v-for="(item, index) in series.slice(0, 3)" :key="item.label" type="button" :aria-label="t('costComponents.show', { p0: item.label })" :aria-pressed="visible[index]" :style="{ '--quality-color': item.color }" @click="toggle(index)"><i></i>{{ item.label }}</button>
      </div>
    </div>
    <div v-if="unavailable" class="quality-state" role="status"><strong>{{ dataAvailabilityLabel(state) }}</strong><span>{{ stateReason || t('costComponents.noVerifiedRequestQualityData') }}</span></div>
    <template v-else>
      <div v-show="tab === 'overview'" class="quality-overview" role="tabpanel" :aria-label="t('costComponents.requestOutcomeOverview')">
        <canvas ref="canvas" class="quality-glass" aria-hidden="true"></canvas>
        <div class="quality-inlet"><strong>{{ count(summary.requests) }}</strong><span>{{ partial ? t('costComponents.knownRequests') : t('costComponents.requests') }}</span><small> {{ t('costComponents.successFailure') }} </small></div>
        <div class="quality-rate"><strong>{{ summary.rate == null ? '—' : summary.rate.toFixed(1) }}<small v-if="summary.rate != null">%</small></strong><span>{{ partial ? t('costComponents.completeBucketSuccessRate') : t('costComponents.successRate') }}</span></div>
        <div class="quality-success" :class="{ 'is-hidden': !visible[0] }"><strong>{{ visible[0] ? count(summary.success) : t('costComponents.hidden') }}</strong><span> {{ t('costComponents.success') }} </span></div>
        <div class="quality-failure" :class="{ 'is-hidden': !visible[1] }"><strong>{{ visible[1] ? count(summary.failure) : t('costComponents.hidden') }}</strong><span> {{ t('costComponents.failure') }} </span></div>
        <div class="quality-switch" :class="{ 'is-hidden': !visible[2] }"><i></i><strong>{{ visible[2] ? count(switchSummary.total) : t('costComponents.hidden') }}</strong><span> {{ t('costComponents.accountSwitches') }} <small> {{ t('costComponents.excludedFromRequests') }} </small></span></div>
        <div v-if="summary.requests === 0" class="quality-empty"> {{ t('costComponents.noRequestsInTheSelectedWindow') }} </div>
        <div v-else-if="summary.requests == null" class="quality-empty"> {{ t('costComponents.noCompleteRequestBuckets') }} </div>
        <div v-if="!supported" class="quality-fallback"> {{ t('costComponents.glassRenderingUnavailableValuesAndHistoryRemain') }} </div>
        <p class="quality-proof" :title="stateReason">{{ partial ? t('costComponents.partialDataCompleteBuckets', { p0: summary.paired, p1: labels.length }) : state === 'stale' ? t('costComponents.staleData') : state === 'estimated' ? t('costComponents.estimatedData') : t('costComponents.windowTotal') }}<span v-if="switchSummary.partial"> {{ t('costComponents.knownSwitchesOnly') }} </span> {{ t('costComponents.bandWidthDoesNotRepresentQuantity') }} </p>
      </div>
      <div v-if="tab === 'history'" ref="historyRoot" class="quality-history" role="tabpanel" :aria-label="t('costComponents.originalSuccessFailureAndSwitchHistoryBuckets')">
        <div v-if="!visible.some(Boolean)" class="quality-state"> {{ t('costComponents.allMetricsHiddenRestoreThemUsingThe') }} </div>
        <CostLineChart v-else :labels="labels" :series="historySeries" :events="events" :state="state" :state-reason="stateReason" :height="162" />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t, locale } = useI18n()
import { getLocale } from '@/i18n'

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Chart as ChartJS } from 'chart.js'
import CostLineChart, { type CostChartEvent, type CostChartSeries } from './CostLineChart.vue'
import { dataAvailabilityLabel, type DataAvailability } from '../dataState'
import { drawGlassSplit, retainGlassRenderer, glassGeneration, loadQualityArtwork } from './glassChartRenderer'
const props = withDefaults(defineProps<{ labels: string[]; series: CostChartSeries[]; events?: CostChartEvent[]; state: DataAvailability; stateReason?: string }>(), { events: () => [], stateReason: '' })
const root = ref<HTMLElement>(), canvas = ref<HTMLCanvasElement>(), historyRoot = ref<HTMLElement>()
const tab = ref<'overview' | 'history'>('overview')
const visible = ref([true, true, true])
const supported = ref(true)
const unavailable = computed(() => ['loading', 'unavailable', 'empty'].includes(props.state))
const known = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
// A rate must have a consistent denominator: only paired success/failure buckets.
// Unpaired observations remain intact in History, never filled or treated as zero.
const summary = computed(() => {
  let success = 0, failure = 0, paired = 0
  props.labels.forEach((_label, i) => {
    const ok = props.series[0]?.data[i], bad = props.series[1]?.data[i]
    if (known(ok) && known(bad)) { success += ok; failure += bad; paired++ }
  })
  const requests = success + failure
  return { success: paired ? success : null, failure: paired ? failure : null, requests: paired ? requests : null, rate: paired && requests > 0 ? success / requests * 100 : null, paired }
})
const switchSummary = computed(() => {
  const values = props.labels.map((_label, i) => props.series[2]?.data[i]).filter(known)
  return { total: values.length ? values.reduce((sum, value) => sum + value, 0) : null, partial: values.length < props.labels.length }
})
const partial = computed(() => props.state === 'partial' || summary.value.paired < props.labels.length)
const count = (value: number | null) => value == null ? '—' : value.toLocaleString(getLocale(), { maximumFractionDigits: 6 })
const historySeries = computed(() => props.series.slice(0, 3).map((series, index) => ({ ...series, fill: false, data: visible.value[index] ? series.data : series.data.map(() => null) })))
function toggle(index: number) { visible.value[index] = !visible.value[index] }
function tabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  tab.value = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'history' : tab.value === 'overview' ? 'history' : 'overview'
  const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role=tab]')
  buttons[tab.value === 'overview' ? 0 : 1]?.focus()
}
let resize: ResizeObserver | undefined, intersection: IntersectionObserver | undefined, release: (() => void) | undefined
let inView = true, mounted = false, lastDrawKey = ''
function draw() {
  if (!mounted || !inView || document.hidden || unavailable.value || tab.value !== 'overview' || !canvas.value) return
  const colors = props.series.slice(0, 3).map(series => series.color)
  const channels = visible.value.map((shown, i) => shown && ([summary.value.success, summary.value.failure, switchSummary.value.total][i] ?? 0) > 0)
  const key = [canvas.value.clientWidth, canvas.value.clientHeight, Math.min(2, window.devicePixelRatio || 1), ...colors, ...channels, glassGeneration()].join('|')
  if (key === lastDrawKey) return
  supported.value = drawGlassSplit(canvas.value, colors, channels)
  lastDrawKey = supported.value ? key : ''
}
async function update() {
  await nextTick()
  if (!mounted) return
  if (tab.value === 'history') {
    // One accessible HTML legend controls both representations. Do not leave a
    // second, unsynchronized canvas-only legend in the preserved history chart.
    const element = historyRoot.value?.querySelector('canvas')
    const chart = element ? ChartJS.getChart(element) : undefined
    if (chart?.options.plugins?.legend) { chart.options.plugins.legend.display = false; chart.update('none') }
  } else draw()
}
function visibilityChanged() { if (!document.hidden) void update() }
watch(canvas, () => { lastDrawKey = ''; void update() }, { flush: 'post' })
watch([() => props.labels, () => props.series, () => props.state, visible, tab], update, { deep: true, flush: 'post' })
onMounted(() => {
  mounted = true; release = retainGlassRenderer()
  if (typeof ResizeObserver !== 'undefined') { resize = new ResizeObserver(() => draw()); if (root.value) resize.observe(root.value) }
  if (typeof IntersectionObserver !== 'undefined') { intersection = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); if (inView) draw() }); if (root.value) intersection.observe(root.value) }
  document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('cost-gl-restored', draw)
  window.addEventListener('cost-gl-artwork-ready', draw)
  loadQualityArtwork()
  void update()
})
onBeforeUnmount(() => {
  mounted = false; resize?.disconnect(); intersection?.disconnect()
  document.removeEventListener('visibilitychange', visibilityChanged)
  window.removeEventListener('cost-gl-restored', draw)
  window.removeEventListener('cost-gl-artwork-ready', draw)
  release?.()
})
</script>

<style scoped>
.glass-quality{height:190px;width:100%;position:relative;min-width:0}.quality-toolbar{height:28px;display:flex;align-items:center;justify-content:flex-start;gap:18px}.quality-tabs{display:flex;gap:2px;padding:2px;background:var(--cost-bg);border:1px solid var(--cost-line);border-radius:6px}.quality-tabs button,.quality-legend button{border:0;background:none;color:#8ea89b;font-size:10px;cursor:pointer;padding:3px 9px}.quality-tabs button[aria-selected=true]{background:var(--cost-panel-2);color:var(--cost-text);border-radius:4px}.quality-tabs button:focus-visible,.quality-legend button:focus-visible{outline:1px solid #bbebcf;outline-offset:1px}.quality-legend{display:flex;gap:12px;margin-right:auto}.quality-legend button{display:flex;align-items:center;gap:5px;padding:3px 0;color:#b6c9bf}.quality-legend i{width:12px;height:2px;background:var(--quality-color);display:block}.quality-legend button[aria-pressed=false]{opacity:.42;text-decoration:line-through}.quality-overview{height:162px;position:relative;isolation:isolate}.quality-glass{position:absolute;left:13%;top:9px;width:65%;height:130px;pointer-events:none;z-index:-1}.quality-inlet{position:absolute;left:2%;top:56px;display:grid;gap:1px;color:#d9eee1}.quality-inlet strong{font:600 25px Georgia,serif;line-height:1}.quality-inlet span{font-size:10px}.quality-inlet small{font-size:8px;color:#91ac9a}.quality-rate{position:absolute;right:2%;top:-56px;text-align:right;display:grid;gap:0}.quality-rate strong{font:500 32px Georgia,serif;line-height:1;color:#f0f6e8}.quality-rate strong small{font-size:19px;margin-left:1px}.quality-rate span{font-size:9px;color:#a9c2b2}.quality-success,.quality-failure{position:absolute;right:2%;display:flex;align-items:baseline;gap:5px}.quality-success{top:59px;color:#b6f4d9}.quality-failure{top:105px;color:#edb5aa}.quality-success strong,.quality-failure strong{font:500 21px Georgia,serif;line-height:1}.quality-success span,.quality-failure span{font-size:10px}.quality-switch{position:absolute;left:42%;bottom:18px;display:flex;gap:5px;align-items:center;color:#a8cde9}.quality-switch i{height:5px;width:5px;border-radius:50%;background:#79bdff}.quality-switch strong{font-size:12px;font-variant-numeric:tabular-nums}.quality-switch span{font-size:9px}.quality-switch small{margin-left:6px;font-size:8px;color:#78969e}.is-hidden{opacity:.4}.quality-success.is-hidden strong,.quality-failure.is-hidden strong{font-size:12px}.quality-proof{position:absolute;bottom:0;left:0;right:0;margin:0;text-align:center;color:#748d7d;font-size:8px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quality-empty{position:absolute;top:68px;left:30%;font-size:11px;color:#91a99b}.quality-fallback{position:absolute;top:50%;left:25%;font-size:9px;color:#8ca394}.quality-state{height:162px;display:grid;align-content:center;justify-items:center;gap:5px;font-size:12px;color:#adc3b6}.quality-state span{font-size:10px;color:#7f9c8a}.quality-history{height:162px}@media(max-width:900px){.quality-legend{gap:7px}.quality-tabs button{padding:3px 7px}.quality-inlet strong{font-size:22px}.quality-rate strong{font-size:28px}.quality-switch{left:37%}}
.quality-toolbar { height: auto; min-height: 28px; flex-wrap: wrap; row-gap: 6px; }
.quality-legend { flex-wrap: wrap; }
.quality-proof { white-space: normal; overflow: visible; text-overflow: clip; }
.glass-quality:lang(en) .quality-switch { bottom: 30px; }
.glass-quality:lang(en) .quality-switch span { display: grid; gap: 2px; }
.glass-quality:lang(en) .quality-switch small { margin-left: 0; }
</style>
