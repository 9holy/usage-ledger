<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { Chart } from 'vue-chartjs'
import { color } from 'chart.js/helpers'
import { Chart as ChartJS, LineController, LineElement, PointElement, DoughnutController, ArcElement, CategoryScale, LinearScale, Filler, Tooltip, type ChartData, type ChartOptions, type Plugin, type ScriptableContext } from 'chart.js'
import { Info, GitBranch, Layers, Zap } from '@lucide/vue'
import { usageColors, usageIntensityColors, usageModelColor, usagePercentLabel } from './usageChartPalette'
import { displayLiveRate } from './liveRate'
import type { MonitorSnapshot, LiveWindow } from '@/api/usageMonitor'

const { t } = useI18n()

ChartJS.register(LineController, LineElement, PointElement, DoughnutController, ArcElement, CategoryScale, LinearScale, Filler, Tooltip)
const props = defineProps<{ snapshot: MonitorSnapshot | null; tool: string | null }>()
const emit = defineEmits<{ session: [key: string, event: MouseEvent]; model: [tool: string | null, model: string | null] }>()
const seconds = ref<60 | 300>(60)
const grouping = ref<'session' | 'model'>('session')
const toolName = (tool: string | null) => ({ codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', 'deepseek-harness': 'DeepSeek Harness' }[tool || ''] || t('usageMonitor.text.allTools'))
const windowOf = (windows?: LiveWindow[]) => windows?.find(row => row.seconds === seconds.value)
const totalWindow = computed(() => windowOf(props.tool ? props.snapshot?.live?.byTool.find(row => row.tool === props.tool)?.windows : props.snapshot?.live?.windows))
function rate(window?: LiveWindow, legacy?: number): ReturnType<typeof displayLiveRate> {
  if (!props.snapshot?.collectedAtMs) return { text: t('usageMonitor.text.loading'), value: null, partial: true }
  if (!props.snapshot.live && seconds.value === 60 && legacy != null && Number.isFinite(legacy) && legacy >= 0) {
    return { text: legacy > 0 ? formatMeasuredRate(legacy) : t('usageMonitor.text.noOutput'), value: legacy, partial: true }
  }
  return displayLiveRate(window)
}
const totalRate = computed(() => rate(totalWindow.value, props.snapshot?.totals.outputTokensPerSecond))
const formatMeasuredRate = (value: number) => value < .01 ? new Intl.NumberFormat(usageLocale(), { maximumSignificantDigits: 2, useGrouping: false }).format(value) : value.toFixed(2)
function coverage(window?: LiveWindow): string {
  if (!props.snapshot?.collectedAtMs) return t('usageMonitor.text.waitingForSampleRecords')
  if (!window) return props.snapshot?.live ? t('usageMonitor.text.noWindowSampleRecordsYet') : t('usageMonitor.text.legacyWindowRecordSamplingCoverageUnavailable')
  const display = displayLiveRate(window)
  if (display.partial) return t('usageMonitor.text.partialSamplingObservedOutputCoverageS', { value0: window.observedOutputTokens.toLocaleString(usageLocale()), value1: Math.floor(window.coveredMs / 1000), value2: window.seconds, value3: window.sourceComplete === false ? t('usageMonitor.text.sourcesNotFullyConnected') : '' })
  return display.value === 0 ? t('usageMonitor.text.noNewOutputRecordedInThisWindow') : t('usageMonitor.text.lastOfRecordsUpdatedEveryS', { value0: seconds.value === 60 ? t('usageMonitor.text.60Seconds') : t('usageMonitor.text.5Minutes'), value1: (props.snapshot?.refreshMs || 2000) / 1000 })
}
const sessionRows = computed(() => (props.snapshot?.rateSessions ?? props.snapshot?.activeSessions ?? []).map(session => ({
  session, window: windowOf(props.snapshot?.live?.bySession.find(row => row.sessionKey === session.key)?.windows),
})).map(row => ({
  ...row, rate: rate(row.window, row.session.totals.outputTokensPerSecond),
  recentSpeed: row.session.requestSpeed?.latest && row.session.requestSpeed.latest.outputTokensPerSecond > 0 && Number.isFinite(row.session.requestSpeed.latest.outputTokensPerSecond) && row.session.requestSpeed.latest.timestampMs > 0
    ? t('usageMonitor.text.latestValidRequestTokensS', { value0: formatMeasuredRate(row.session.requestSpeed.latest.outputTokensPerSecond), value1: new Date(row.session.requestSpeed.latest.timestampMs).toLocaleString(usageLocale(), { hour12: false }) }) : null,
})).filter(row => (!props.tool || row.session.tool === props.tool)
  && (row.window ? row.window.observedOutputTokens > 0 : (row.rate.value ?? 0) > 0)))
const modelRows = computed(() => (props.snapshot?.live?.byModel ?? []).filter(row => !props.tool || row.tool === props.tool)
  .slice().sort((a, b) => (windowOf(b.windows)?.observedOutputTokens ?? 0) - (windowOf(a.windows)?.observedOutputTokens ?? 0)))
const timelineSource = computed(() => props.tool ? props.snapshot?.live?.recordedTimelineByTool?.[props.tool] : props.snapshot?.live?.recordedTimeline)
const timeline = computed(() => timelineSource.value ?? [])
const recordedRequests = computed(() => timeline.value.reduce((sum, row) => sum + row.requestCount, 0))
const recordedOutput = computed(() => timeline.value.reduce((sum, row) => sum + row.knownOutputTokens, 0))
const unknownOutput = computed(() => timeline.value.reduce((sum, row) => sum + row.unknownOutputRequests, 0))
const hasOutputCounts = computed(() => recordedRequests.value === 0 || recordedRequests.value > unknownOutput.value)
const activeMinutes = computed(() => timeline.value.filter(row => row.requestCount > 0).length)
const contribution = (window?: LiveWindow) => totalWindow.value?.observedOutputTokens ? Math.min(100, (window?.observedOutputTokens ?? 0) / totalWindow.value.observedOutputTokens * 100) : 0
const attributionRows = computed(() => {
  const groups = new Map<string | null, { model: string | null; tools: Set<string | null>; window: LiveWindow; hasWindow: boolean }>()
  for (const row of modelRows.value) {
    let group = groups.get(row.model)
    if (!group) {
      group = { model: row.model, tools: new Set(), hasWindow: false, window: { seconds: seconds.value, observedOutputTokens: 0, outputTokensPerSecond: 0, coveredMs: seconds.value * 1000, complete: true, sourceComplete: true } }
      groups.set(row.model, group)
    }
    const window = windowOf(row.windows)
    group.tools.add(row.tool)
    group.hasWindow ||= window != null
    group.window.observedOutputTokens += window?.observedOutputTokens ?? 0
    group.window.outputTokensPerSecond = group.window.outputTokensPerSecond == null || window?.outputTokensPerSecond == null ? null : group.window.outputTokensPerSecond + window.outputTokensPerSecond
    group.window.coveredMs = Math.min(group.window.coveredMs, window?.coveredMs ?? 0)
    group.window.complete &&= window?.complete === true
    group.window.sourceComplete = group.window.sourceComplete !== false && window != null && window.sourceComplete !== false
  }
  return [...groups.values()].map(group => ({ model: group.model, tool: group.tools.size === 1 ? [...group.tools][0] : null, window: group.hasWindow ? group.window : undefined }))
    .sort((a, b) => (b.window?.observedOutputTokens ?? -1) - (a.window?.observedOutputTokens ?? -1))
})
function speedScale(values: Array<number | null | undefined>): number {
  const maximum = Math.max(0, ...values.map(value => value ?? 0))
  if (!maximum) return 1
  const unit = 10 ** Math.floor(Math.log10(maximum))
  return unit * ([1, 2, 5, 10].find(step => step * unit >= maximum) ?? 10)
}
const modelSpeedScale = computed(() => speedScale(attributionRows.value.map(row => displayLiveRate(row.window).value)))
const highestRate = computed(() => Math.max(0, ...attributionRows.value.map(row => displayLiveRate(row.window).value ?? 0)))
const fastestRate = computed(() => Math.max(0, ...attributionRows.value.map(row => { const display = displayLiveRate(row.window); return display.partial ? 0 : display.value ?? 0 })))
const isFastest = (window?: LiveWindow) => { const display = displayLiveRate(window); return !display.partial && fastestRate.value > 0 && display.value === fastestRate.value }
function speedColor(window?: LiveWindow): string {
  const value = displayLiveRate(window).value
  if (value == null) return usageColors.unknown
  const position = highestRate.value ? value / highestRate.value * 2 : 0
  return (position <= 1 ? color(usageColors.input).mix(color(usageColors.cache), 1 - position) : color(usageColors.cache).mix(color(usageColors.danger), 2 - position)).hexString().toLowerCase()
}
const contributionChart = computed<ChartData<'doughnut'>>(() => ({ datasets: [
  { type: 'doughnut', label: t('usageMonitor.text.speed'), data: attributionRows.value.map(row => row.window?.observedOutputTokens ?? 0), backgroundColor: attributionRows.value.map(row => speedColor(row.window) + '0b'), borderWidth: 0, hoverOffset: 2, weight: 1.8 },
  { type: 'doughnut', label: t('usageMonitor.text.model'), data: attributionRows.value.map(row => row.window?.observedOutputTokens ?? 0), backgroundColor: attributionRows.value.map(row => usageModelColor(row.model) + '18'), borderWidth: 0, weight: .65 },
] }))
const contributionOptions: ChartOptions<'doughnut'> = { responsive: true, maintainAspectRatio: false, animation: false, cutout: '61%', plugins: { legend: { display: false }, tooltip: { callbacks: { title: () => '', label: item => { const row = attributionRows.value[item.dataIndex]; const display = rate(row?.window); return item.datasetIndex === 0 ? t('usageMonitor.text.label8', { value0: row?.model || t('usageMonitor.text.modelNotRecorded2'), value1: display.text, value2: display.value != null && display.value > 0 ? t('usageMonitor.text.tokensS3') : '', value3: display.partial ? t('usageMonitor.text.partialSampling') : '' }) : t('usageMonitor.text.recordedOutput', { value0: row?.model || t('usageMonitor.text.modelNotRecorded2'), value1: Number(item.raw).toLocaleString(usageLocale()) }) } } } }, onClick: (_event, elements) => { const point = elements[0]; if (!point) return; const row = attributionRows.value[point.index]; if (row?.model) emit('model', row.tool, row.model) } }
const contributionSegments: Plugin<'doughnut'> = {
  id: 'contribution-segments',
  afterDatasetDraw(chart, { index }) {
    const { ctx } = chart
    const step = Math.PI * 2 / 60
    chart.getDatasetMeta(index).data.forEach((arc, rowIndex) => {
      const { x, y, startAngle, endAngle, innerRadius, outerRadius } = arc as ArcElement
      if (endAngle <= startAngle) return
      const radius = (innerRadius + outerRadius) / 2
      const row = attributionRows.value[rowIndex]
      ctx.save()
      // Clip beads to the original arc: tiny model shares retain their exact extent.
      ctx.beginPath(); ctx.arc(x, y, outerRadius, startAngle, endAngle); ctx.arc(x, y, innerRadius, endAngle, startAngle, true); ctx.closePath(); ctx.clip()
      const rate = displayLiveRate(row.window).value
      if (index === 0 && (rate == null || rate <= 0)) { ctx.restore(); return }
      const length = (outerRadius - innerRadius) * (index === 0 ? rate! / modelSpeedScale.value : .85)
      const width = Math.min(length * .7, radius * step * .65)
      const padding = Math.min(1, length * .05)
      ctx.strokeStyle = index === 0 ? speedColor(row.window) : usageModelColor(row.model); ctx.lineWidth = width; ctx.lineCap = 'round'
      for (let tick = 0; tick < 60; tick++) {
        const angle = -Math.PI / 2 + step * (tick + .5)
        const inner = innerRadius + width / 2 + padding, outer = innerRadius + length - width / 2 - padding
        ctx.beginPath(); ctx.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner); ctx.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer); ctx.stroke()
      }
      ctx.restore()
    })
  },
}
const outputValues = computed(() => timeline.value.map(row => row.requestCount > row.unknownOutputRequests ? row.knownOutputTokens : null))
const peakValue = computed(() => { const values = outputValues.value.filter((value): value is number => value != null); return values.length ? Math.max(...values) : null })
const peak = computed(() => peakValue.value?.toLocaleString(usageLocale()) ?? t('usageMonitor.text.noRecordsYet'))
const peakIndex = computed(() => peakValue.value == null ? -1 : outputValues.value.indexOf(peakValue.value))
function outputGradient(context: ScriptableContext<'line'>, alpha = ''): string | CanvasGradient {
  const { ctx, chartArea, scales } = context.chart
  if (!chartArea || !scales.y || !peakValue.value) return usageIntensityColors[0] + alpha
  const gradient = ctx.createLinearGradient(0, scales.y.getPixelForValue(0), 0, scales.y.getPixelForValue(peakValue.value))
  usageIntensityColors.forEach((color, index) => gradient.addColorStop(index / (usageIntensityColors.length - 1), color + alpha))
  return gradient
}
const chartData = computed<ChartData<'line'>>(() => ({
  labels: timeline.value.map(row => new Date(row.endMs).toLocaleTimeString(usageLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })),
  datasets: [
    { type: 'line', label: t('usageMonitor.text.recordedOutputTokens'), data: outputValues.value, borderColor: (context: ScriptableContext<'line'>) => outputGradient(context), backgroundColor: (context: ScriptableContext<'line'>) => outputGradient(context, '48'), borderWidth: 2.4, fill: 'origin', cubicInterpolationMode: 'monotone', pointRadius: outputValues.value.map((value, index, values) => index === peakIndex.value && value ? 5 : timeline.value[index].unknownOutputRequests || value != null && values[index - 1] == null && values[index + 1] == null ? 3 : 0), pointHoverRadius: 5, pointBackgroundColor: (context: ScriptableContext<'line'>) => outputGradient(context), pointBorderColor: timeline.value.map(row => row.unknownOutputRequests ? usageColors.warning : '#e9ede6'), pointBorderWidth: 1.5, spanGaps: true, yAxisID: 'y', order: 2 },
    { type: 'line', label: t('usageMonitor.text.usageRecordCount'), data: timeline.value.map(row => row.requestCount || null), borderColor: usageColors.requests, backgroundColor: usageColors.requests, pointStyle: 'rectRot', pointRadius: 2.5, pointHoverRadius: 5, borderWidth: 1.5, tension: 0, spanGaps: true, yAxisID: 'requests', order: 1 },
  ],
}))
const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true, maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: 'index' }, layout: { padding: { top: 20 } },
  plugins: { legend: { display: false }, tooltip: { backgroundColor: '#202725', titleColor: '#eef3f0', bodyColor: '#c5d0cb', callbacks: { afterBody: items => { const row = timeline.value[items[0]?.dataIndex]; return row?.unknownOutputRequests ? t('usageMonitor.text.recordsLackOutputRecordedPortionShownOnly', { value0: row.unknownOutputRequests }) : t('usageMonitor.text.usesLogRecordTimestampsNotTheGenerationTimeOf') } } } },
  scales: { x: { grid: { display: false }, ticks: { color: '#93a29b', maxTicksLimit: 7, maxRotation: 0, font: { size: 12 } }, border: { display: false } }, y: { beginAtZero: true, grid: { color: '#29332f' }, ticks: { color: '#93a29b', maxTicksLimit: 4, font: { size: 12 } }, border: { display: false }, title: { display: true, text: t('usageMonitor.text.outputTokens'), color: usageColors.output, font: { size: 11 } } }, requests: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { color: usageColors.requests, maxTicksLimit: 4, precision: 0, font: { size: 12 } }, title: { display: true, text: t('usageMonitor.text.recordCount'), color: usageColors.requests, font: { size: 11 } } } },
}))
const activityOverlay: Plugin<'line'> = {
  id: 'activity-mountain',
  afterDatasetDraw(chart, { index }) {
    if (index !== 0 || !peakValue.value) return
    const line = chart.getDatasetMeta(0).dataset as LineElement
    const baseline = chart.scales.y.getPixelForValue(0)
    // Reuse the data curve so contours follow the same connected shape.
    for (const ratio of [.2, .4, .6, .8]) {
      chart.ctx.save()
      chart.ctx.translate(0, baseline * (1 - ratio))
      chart.ctx.scale(1, ratio)
      chart.ctx.beginPath()
      line.path(chart.ctx)
      chart.ctx.strokeStyle = '#a9eadb24'
      chart.ctx.lineWidth = .7 / ratio
      chart.ctx.stroke()
      chart.ctx.restore()
    }
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart
    ctx.save()
    const active = chart.getActiveElements()[0]
    if (active) {
      const x = chart.getDatasetMeta(active.datasetIndex).data[active.index].x
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom)
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#c6d2ca70'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([])
    }
    if (peakIndex.value >= 0 && peakValue.value) {
      const point = chart.getDatasetMeta(0).data[peakIndex.value]
      const label = `${unknownOutput.value ? t('usageMonitor.text.knownPeak') : t('usageMonitor.text.peak2')} ${peak.value}`
      ctx.font = '600 12px Segoe UI, Microsoft YaHei UI, sans-serif'
      const width = ctx.measureText(label).width + 16
      const x = Math.max(chartArea.left, Math.min(chartArea.right - width, point.x - width / 2))
      const y = Math.max(chartArea.top - 18, point.y - 33)
      ctx.fillStyle = '#101815'; ctx.strokeStyle = usageColors.output; ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(x, y, width, 24, 4); ctx.fill(); ctx.stroke()
      ctx.fillStyle = usageColors.output; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 8, y + 12)
    }
    ctx.restore()
  },
}
function name(project: string | null, id: string): string { return project?.split(/[\\/]/).filter(Boolean).at(-1) || id.slice(0, 12) }
</script>

<template>
  <section class="live-workspace" :aria-label="t('usageMonitor.text.globalSessionModelRates')">
    <div class="live-controls"><span>{{ t('usageMonitor.text.collectedOutput') }} {{ toolName(tool) }}</span><div class="segmented" :aria-label="t('usageMonitor.text.rateTimeWindow')"><button :aria-pressed="seconds === 60" @click="seconds = 60">{{ t('usageMonitor.text.60Seconds') }}</button><button :aria-pressed="seconds === 300" @click="seconds = 300">{{ t('usageMonitor.text.5Minutes') }}</button></div><div class="segmented" :aria-label="t('usageMonitor.text.rateGrouping')"><button :aria-pressed="grouping === 'session'" @click="grouping = 'session'"><GitBranch :size="14" />{{ t('usageMonitor.text.bySession') }}</button><button :aria-pressed="grouping === 'model'" @click="grouping = 'model'"><Layers :size="14" />{{ t('usageMonitor.text.byModel') }}</button></div></div>
    <div class="live-band">
      <div class="global-rate"><span>{{ tool ? toolName(tool) : t('usageMonitor.text.global') }}{{ t('usageMonitor.text.averageOutputRate') }} <Info :size="14" aria-hidden="true" /></span><strong :class="{ 'rate-state': !(totalRate.value != null && totalRate.value > 0) }">{{ totalRate.text }} <small v-if="totalRate.value != null && totalRate.value > 0">{{ t('usageMonitor.text.tokensS4') }}</small></strong><p>{{ coverage(totalWindow) }}</p><p class="rate-basis">{{ t('usageMonitor.text.averageRateNotTokenByTokenGenerationSpeed') }}</p><p v-if="totalWindow?.sourceComplete === false || snapshot?.live?.sourceCoverageIncomplete" class="partial">{{ t('usageMonitor.text.someToolsAreTemporarilyUnreadableTotalsIncludeOnlyCollected') }}</p></div>
      <div v-if="grouping === 'session'" class="rate-sessions" role="region" :aria-label="t('usageMonitor.text.averageOutputRateBySession')" tabindex="0">
        <button v-for="row in sessionRows" :key="row.session.key" class="rate-session" :style="{ '--model-color': usageModelColor(row.session.recentRequest?.model || row.session.model) }" :title="row.session.project || row.session.id" @click="emit('session', row.session.key, $event)"><span>{{ name(row.session.project, row.session.id) }} <em class="session-kind">{{ row.session.parentId ? t('usageMonitor.text.subSessions') : t('usageMonitor.text.mainSession') }}</em></span><small>{{ toolName(row.session.tool) }} · {{ row.session.recentRequest?.model || row.session.model || t('usageMonitor.text.modelNotReported') }}</small><strong :class="{ 'rate-state': !(row.rate.value != null && row.rate.value > 0) }">{{ row.rate.value === 0 && ['running', 'active'].includes(row.session.status) ? t('usageMonitor.text.waitingForOutput') : row.rate.text }} <small v-if="row.rate.value != null && row.rate.value > 0">{{ t('usageMonitor.text.tokensS4') }}</small></strong><small v-if="!(row.rate.value != null && row.rate.value > 0) && row.recentSpeed" class="recent-request-speed">{{ row.recentSpeed }}</small><div v-if="row.window" class="contribution-track" :title="t('usageMonitor.text.shareOfCollectedOutput') + usagePercentLabel(contribution(row.window))"><i :style="{ width: contribution(row.window) + '%' }" /></div><small class="usage-state" :data-state="row.session.status">{{ ['idle', 'completed'].includes(row.session.status) ? t('usageMonitor.text.completedStillIncludedInTheCurrentWindow') + (row.rate.partial ? ' · ' + coverage(row.window) : '') : row.rate.partial || row.rate.value === 0 ? coverage(row.window) : t('usageMonitor.text.recentOutput') }}</small></button>
        <p v-if="!sessionRows.length" class="empty">{{ snapshot ? t('usageMonitor.text.noOutputRecordedInTheCurrentWindow') : t('usageMonitor.text.loadingSessions') }}</p>
      </div>
      <div v-else class="rate-sessions" role="region" :aria-label="t('usageMonitor.text.averageOutputRateByModel')" tabindex="0">
        <button v-for="row in modelRows" :key="row.tool + ':' + row.model" class="rate-session" :disabled="!row.model" :title="row.model || t('usageMonitor.text.modelNotRecordedModelFilteringUnavailable')" :style="{ '--model-color': usageModelColor(row.model) }" @click="emit('model', row.tool, row.model)"><span>{{ row.model || t('usageMonitor.text.unidentifiedModel') }}</span><small>{{ toolName(row.tool) }} {{ t('usageMonitor.text.usesTheModelRecordedForEachRequest') }}</small><strong :class="{ 'rate-state': !(rate(windowOf(row.windows)).value! > 0) }">{{ rate(windowOf(row.windows)).text }} <small v-if="rate(windowOf(row.windows)).value! > 0">{{ t('usageMonitor.text.tokensS4') }}</small></strong><small>{{ coverage(windowOf(row.windows)) }}</small></button><p v-if="!modelRows.length" class="empty">{{ t('usageMonitor.text.noModelOutputRecordsInThisWindow') }}</p>
      </div>
    </div>
    <slot name="after-summary" />
    <section class="model-spectrum" :aria-label="t('usageMonitor.text.modelOutputContributionChart')">
      <div class="spectrum-title"><h2>{{ t('usageMonitor.text.outputByModel') }}</h2><small>{{ t('usageMonitor.text.last') }}{{ seconds === 60 ? t('usageMonitor.text.60Seconds') : t('usageMonitor.text.5Minutes') }} {{ t('usageMonitor.text.modelsInTheInnerRingRatesInTheOuter') }}</small></div><div class="speed-scale" :aria-label="t('usageMonitor.text.ringRateScale')"><div class="speed-color-key"><span>{{ t('usageMonitor.text.outerRingRate') }}</span><span>{{ t('usageMonitor.text.slower') }}</span><i aria-hidden="true" /><span>{{ t('usageMonitor.text.faster') }}</span></div><span v-if="highestRate > 0">{{ t('usageMonitor.text.fullScale') }} {{ modelSpeedScale.toLocaleString(usageLocale()) }} {{ t('usageMonitor.text.tokensS4') }}</span><span v-else>{{ t('usageMonitor.text.noPositiveRateSamplesYet') }}</span></div>

      <div class="contribution-layout"><div class="contribution-orbit"><Chart v-if="attributionRows.some(row => (row.window?.observedOutputTokens ?? 0) > 0)" type="doughnut" :data="contributionChart" :options="contributionOptions" :plugins="[contributionSegments]" :aria-label="t('usageMonitor.text.innerRingColorsIdentifyModelsOuterRingColorAnd')" role="img" /><div v-else class="orbit-empty" /><div class="orbit-label"><span>{{ t('usageMonitor.text.last2') }}{{ seconds === 60 ? t('usageMonitor.text.60Seconds') : t('usageMonitor.text.5Minutes') }}{{ t('usageMonitor.text.recordedAverageRate') }}</span><strong :class="{ 'rate-state': !(totalRate.value != null && totalRate.value > 0) }">{{ totalRate.text }}</strong><small v-if="totalRate.value != null && totalRate.value > 0">{{ t('usageMonitor.text.tokensS4') }}</small></div></div>
      <div class="spectrum-legend"><p v-if="!attributionRows.length" class="empty">{{ t('usageMonitor.text.noModelUsageRecordsReceivedYet') }}</p><button v-for="row in attributionRows" :key="row.model ?? ''" :disabled="!row.model" :title="(row.model || t('usageMonitor.text.modelNotRecordedModelFilteringUnavailable')) + ' · ' + coverage(row.window)" :style="{ '--model-color': usageModelColor(row.model), '--speed-color': speedColor(row.window) }" @click="emit('model', row.tool, row.model)"><i :style="{ background: usageModelColor(row.model) }" /><span><span class="spectrum-model-name">{{ row.model || t('usageMonitor.text.unknownModel') }}</span><small>{{ t('usageMonitor.text.shareOfRecordedOutput') }} {{ usagePercentLabel(contribution(row.window)) }}</small><small class="spectrum-output">{{ row.window ? row.window.observedOutputTokens.toLocaleString(usageLocale()) + t('usageMonitor.text.outputTokens2') : t('usageMonitor.text.outputCountUnavailable') }}</small></span><b :class="{ 'rate-state': !(rate(row.window).value! > 0) }" :data-fastest="isFastest(row.window)">{{ rate(row.window).text }}<small v-if="rate(row.window).value! > 0">{{ t('usageMonitor.text.tokensS4') }}</small><small v-if="rate(row.window).partial">{{ t('usageMonitor.text.partialSampling2') }}</small><span v-if="isFastest(row.window)" class="fastest-label" :title="t('usageMonitor.text.fastestAmongCompletelySampledModels')"><Zap :size="11" aria-hidden="true" />{{ t('usageMonitor.text.fastest') }}</span></b></button></div></div>
    </section>
    <details class="rate-method"><summary>{{ t('usageMonitor.text.rateCalculation') }}</summary><p>{{ t('usageMonitor.text.averageRateOutputIncrementsReceivedInThisAppS') }}</p><p v-if="snapshot?.live?.sourceCoverageIncomplete" class="partial">{{ t('usageMonitor.text.someToolDataIsIncompleteTotalsIncludeOnlyThe') }}{{ snapshot.live.unavailableTools.map(toolName).join(t('usageMonitor.text.label3')) }} {{ t('usageMonitor.text.isNotFullyConnected') }}</p></details>
    <section class="minute-chart" :aria-label="t('usageMonitor.text.outputInTheLastHour')"><div class="chart-title"><h2>{{ t('usageMonitor.text.outputRequestActivity') }} <small>{{ t('usageMonitor.text.last60MinutesByLogUsageRecordTime') }}</small></h2><div class="chart-legend"><span><i />{{ t('usageMonitor.text.outputTokens') }}</span><span><i />{{ t('usageMonitor.text.usageRecordCount') }}</span></div></div><div class="hour-statistics"><div><span>{{ t('usageMonitor.text.recordedOutput2') }}</span><strong>{{ timelineSource == null ? t('usageMonitor.text.unavailable2') : !hasOutputCounts ? t('usageMonitor.text.outputNotReported') : recordedOutput.toLocaleString(usageLocale()) }} <small v-if="timelineSource != null && hasOutputCounts">Token</small></strong></div><div><span>{{ t('usageMonitor.text.usageRecords') }}</span><strong>{{ timelineSource == null ? t('usageMonitor.text.unavailable2') : recordedRequests.toLocaleString(usageLocale()) }} <small v-if="timelineSource != null">{{ t('usageMonitor.text.records') }}</small></strong></div><div><span>{{ t('usageMonitor.text.minutesWithRecords') }}</span><strong>{{ timelineSource == null ? t('usageMonitor.text.unavailable2') : activeMinutes }} <small v-if="timelineSource != null">/ 60</small></strong></div><div><span>{{ unknownOutput ? t('usageMonitor.text.peakMinuteOutputKnown') : t('usageMonitor.text.peakMinuteOutput') }}</span><strong>{{ timelineSource == null ? t('usageMonitor.text.unavailable2') : !hasOutputCounts ? t('usageMonitor.text.outputNotReported') : peak }}</strong></div></div><div v-if="timeline.length && hasOutputCounts" class="activity-scale" :aria-label="t('usageMonitor.text.outputIntensityColors')"><span>{{ t('usageMonitor.text.lessOutput') }}</span><i aria-hidden="true" /><span>{{ t('usageMonitor.text.moreOutput') }}</span></div><div class="chart-canvas"><Chart v-if="timeline.length" type="line" :data="chartData" :options="chartOptions" :plugins="[activityOverlay]" /><p v-else class="empty">{{ timelineSource == null ? t('usageMonitor.text.waitingToReadSavedUsageRecords') : t('usageMonitor.text.noUsageRecordsInTheLast60Minutes') }}</p></div><div v-if="timeline.length" class="minute-presence" role="img" :aria-label="t('usageMonitor.text.perMinuteUsageRecordStatus')"><i v-for="row in timeline" :key="row.startMs" :class="{ present: row.requestCount > 0, partial: row.unknownOutputRequests > 0 }" :title="new Date(row.startMs).toLocaleTimeString(usageLocale(), { hour12: false }) + (row.requestCount ? t('usageMonitor.text.recordsKnownOutputTokens', { value0: row.requestCount, value1: row.knownOutputTokens }) : t('usageMonitor.text.noNewUsageRecordThisDoesNotEstablishNon'))" /></div><p class="coverage-note">{{ t('usageMonitor.text.recordsCollectedAfterDowntimeReturnToTheirOriginalTimestamps') }}<span v-if="unknownOutput"> {{ unknownOutput }} {{ t('usageMonitor.text.recordsLackOutputFieldsHatchedMarksIndicatePartialOutput') }}</span></p></section>
  </section>
</template>

<style scoped>
.contribution-layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:36px;align-items:center;margin:16px 0 8px}.contribution-orbit{position:relative;width:290px;height:290px}.orbit-label{position:absolute;inset:84px 44px;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;text-align:center}.orbit-label span,.orbit-label small{font-size:11px;color:#9eb3a5}.orbit-label strong{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;margin:6px 0;max-width:100%;overflow-wrap:anywhere}.orbit-empty{position:absolute;inset:0}.orbit-empty::before,.orbit-empty::after{content:"";position:absolute;border-radius:50%}.orbit-empty::before{inset:3px;border:37px solid #1e2a22}.orbit-empty::after{inset:44px;border:15px solid #25372b}.contribution-layout .spectrum-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 30px;margin:0}.contribution-layout .spectrum-legend button{min-width:0;padding:14px 0;border-bottom:1px solid var(--cost-line)}.spectrum-legend button>span{flex:1;min-width:0;overflow-wrap:anywhere}.spectrum-legend .spectrum-output{font-size:13px;color:var(--model-color);margin-top:10px}.contribution-layout .spectrum-legend b{font-size:23px;min-width:85px;text-align:right}.contribution-layout .spectrum-legend b small{font-size:10px}.contribution-layout .spectrum-legend button>i{height:32px}@media(max-width:1000px){.contribution-layout .spectrum-legend{grid-template-columns:1fr}.contribution-layout{gap:24px}}@media(max-width:550px){.contribution-layout{grid-template-columns:minmax(0,1fr);gap:12px}.contribution-orbit{margin:0 auto}.contribution-layout .spectrum-legend{grid-template-columns:minmax(0,1fr)}}
.speed-scale{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:#98aa9f;margin:8px 0 12px}.speed-color-key{display:flex;align-items:center;gap:7px}.speed-color-key>i{width:90px;height:6px;background:linear-gradient(90deg,var(--usage-input),var(--usage-cache),var(--usage-danger));border-radius:3px}.spectrum-legend .fastest-label{display:inline-flex;align-items:center;justify-content:flex-end;gap:3px;margin-top:6px;color:var(--usage-danger);font-size:10px;font-weight:500}.spectrum-model-name{display:block;font-weight:600}
.live-workspace{border-bottom:1px solid var(--cost-line);padding-bottom:18px}.live-controls{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}.live-controls>span{margin-right:auto;color:#9fada6;font-size:12px}.segmented{display:flex;border:1px solid var(--cost-line);border-radius:5px}.segmented button{display:flex;align-items:center;gap:7px;padding:7px 12px;color:#9fada6;font-size:12px}.segmented button[aria-pressed=true]{background:#222d20;color:var(--cost-lime)}
.live-band{display:grid;grid-template-columns:290px minmax(0,1fr);gap:28px}.global-rate{border-right:1px solid var(--cost-line);padding-right:22px;min-width:0}.global-rate>span{display:flex;gap:8px;align-items:center;font-size:15px}.global-rate strong{display:block;font-size:43px;line-height:1.3;color:var(--usage-output);font-weight:650;white-space:nowrap;margin:12px 0}.global-rate strong small,.rate-session strong small{font-size:12px;font-weight:400;color:#a8b5ae}.global-rate p{font-size:12px;color:#9fada6;line-height:1.6}
.rate-sessions{display:flex;overflow:auto;min-width:0;gap:24px;scrollbar-width:thin;padding-bottom:8px}.rate-session{flex:1 0 250px;max-width:390px;text-align:left;padding-right:24px;border-right:1px solid var(--cost-line)}.rate-session:last-child{border:0}.rate-session>span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600}.rate-session em{font-size:10px;font-style:normal;font-weight:400;color:#a9bca0;margin-left:6px}.rate-session>small{display:block;font-size:12px;color:#9fada6;line-height:1.8;margin-top:5px}.rate-session strong{display:block;font-size:31px;font-weight:600;color:var(--model-color);margin:10px 0}.rate-session:enabled:hover>span{color:var(--cost-blue)}
.rate-method{margin-top:18px;font-size:11px;color:#96a69d;line-height:1.8}.rate-method summary{cursor:pointer;width:fit-content}.rate-method p{margin:10px 0;max-width:1100px}.partial{color:var(--cost-gold)}.minute-chart{margin-top:20px}.chart-title{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:12px}.chart-title h2{font-size:15px;font-weight:600;margin:0}.chart-title h2 small{font-size:11px;font-weight:400;color:#96a69d;margin-left:8px}.chart-title>span,.coverage-note{font-size:11px;color:#96a69d}.chart-canvas{height:150px;min-width:0}.coverage-note{margin:8px 0 0}.empty{font-size:12px;color:#96a69d;padding:20px}
.rate-basis{margin-top:7px;color:#c0cdc5!important}.contribution-track{height:4px;background:#29372e;margin:12px 0 8px}.contribution-track i{display:block;height:100%;background:var(--model-color)}.model-spectrum{padding:20px 0 4px;margin-top:22px;border-top:1px solid var(--cost-line)}.spectrum-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.spectrum-title h2{font-size:14px;font-weight:600;margin:0}.spectrum-title small{font-size:11px;color:#98aa9f}.spectrum-legend{display:flex;flex-wrap:wrap;gap:14px 28px;margin-top:14px}.spectrum-legend button{display:flex;align-items:center;gap:9px;text-align:left;min-width:230px;padding:4px 0}.spectrum-legend button:enabled:hover{color:var(--cost-lime)}.spectrum-legend i{width:7px;height:26px;flex-shrink:0;border-radius:2px}.spectrum-legend span{font-size:12px}.spectrum-legend small{display:block;font-size:10px;color:#98aa9f;font-weight:400;margin-top:3px}.spectrum-legend b{color:var(--speed-color);font-variant-numeric:tabular-nums;font-size:18px;margin-left:auto;padding-left:12px}.rate-session:focus-visible,.spectrum-legend button:focus-visible{outline:2px solid var(--cost-lime);outline-offset:4px}
.chart-legend{display:flex;gap:18px;font-size:12px;color:#9bafa2}.chart-legend span{display:flex;align-items:center;gap:7px}.chart-legend i{height:8px;width:8px;border-radius:2px;background:var(--usage-output)}.chart-legend span+span i{background:var(--usage-requests);border-radius:0;transform:rotate(45deg)}.hour-statistics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin:16px 0 20px}.hour-statistics span{display:block;color:#95a99b;font-size:11px}.hour-statistics strong{display:block;margin-top:6px;font-size:23px;font-weight:600;font-variant-numeric:tabular-nums}.hour-statistics small{font-size:11px;color:#95a99b;font-weight:400}.minute-chart .chart-canvas{height:280px}.activity-scale{display:flex;justify-content:center;align-items:center;gap:9px;font-size:11px;color:#a0b3a8;margin:-4px 0 8px}.activity-scale i{display:block;width:110px;height:6px;border-radius:3px;background:var(--usage-intensity)}@media(max-width:600px){.minute-chart .chart-canvas{height:230px}.hour-statistics{grid-template-columns:repeat(2,minmax(0,1fr))}}.minute-presence{display:grid;grid-template-columns:repeat(60,minmax(0,1fr));gap:3px;margin:8px 0 12px;padding:0 38px}.minute-presence i{height:5px;background:#25302a;border-radius:1px}.minute-presence .present{background:var(--usage-output)}.minute-presence .partial{background:repeating-linear-gradient(135deg,var(--usage-warning) 0 3px,#101413 3px 5px)}.minute-chart .coverage-note{line-height:1.7;max-width:1000px}
@media(max-width:800px){.live-band{grid-template-columns:minmax(0,1fr)}.global-rate{border-right:0}.rate-sessions{padding-top:16px;border-top:1px solid var(--cost-line)}.global-rate strong{font-size:36px}.chart-title h2 small{display:block;margin:6px 0 0}.rate-session{flex-basis:220px}}
.rate-session:disabled,.spectrum-legend button:disabled{opacity:1;cursor:default}.rate-session:disabled>span,.spectrum-legend button:disabled>span{color:var(--usage-unknown)}
.global-rate strong.rate-state{font-size:24px;white-space:normal;overflow-wrap:anywhere}.rate-session strong.rate-state{font-size:20px}.orbit-label strong.rate-state{font-size:18px}.contribution-layout .spectrum-legend b.rate-state{font-size:15px}.recent-request-speed{overflow-wrap:anywhere}
</style>
