<template>
  <div class="cost-chart" :class="[`data-${effectiveState}`, { 'cost-chart--readable': showValues, 'cost-chart--ledger': economicLedger }]" :style="{ height: `${height}px` }" :data-data-state="effectiveState">
    <div v-if="showChart && economicLedger" class="cost-chart__keys" :style="{ gridTemplateColumns: `repeat(${Math.min(3, series.length)}, minmax(0, 1fr))` }" :aria-label="t('costComponents.lastValidReadingsClickToToggleVisibility')">
      <button v-for="(item, index) in series.slice(0, 3)" :key="seriesKey(index)" type="button"
        :aria-pressed="!hiddenSeries[seriesKey(index)]" :aria-label="t('costComponents.seriesVisibilityLabel', { p0: item.label, p1: keyValue(index), p2: hiddenSeries[seriesKey(index)] ? t('costComponents.hiddenClickToShow') : t('costComponents.clickToHide') })"
        :class="{ 'is-hidden': hiddenSeries[seriesKey(index)], 'is-primary': primarySeriesIndex === index }"
        :style="{ '--series-color': item.color }" :title="keyTitle(index)" @click="toggleSeries(index)">
        <i aria-hidden="true" /><span>{{ item.label }}</span><strong>{{ keyValue(index) }}</strong>
      </button>
    </div>
    <div v-if="showChart" class="cost-chart__plot">
      <Line :data="chartData" :options="chartOptions" :plugins="[economicSurface, valueLabels, cursorGuide]" :aria-label="chartDescription" role="img" />
    </div>
    <div v-if="showChart && effectiveState === 'partial'" class="cost-chart__partial" :title="stateReason"> {{ t('costComponents.partialData') }} </div>
    <div v-if="showChart && events.length" class="cost-chart__events" :aria-label="t('costComponents.chartEvents')">
      <span
        v-for="event in events"
        :key="`${event.index}-${event.label}`"
        class="cost-chart__event"
        :class="`is-${event.severity || 'info'}`"
        :style="{ left: `${eventPosition(event.index)}%` }"
        :title="event.label"
      ><i></i></span>
    </div>
    <div v-if="!showChart" class="cost-chart__state" role="status">
      <span>{{ stateLabel }}</span>
      <small>{{ effectiveReason }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t, locale } = useI18n()

import { computed, ref } from 'vue'
import { economicGlassMaterial } from './economicGlassMaterial'
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type Plugin,
  type ScriptableContext,
} from 'chart.js'
import { Line } from 'vue-chartjs'
import { dataAvailabilityLabel, type DataAvailability } from '../dataState'
import { UNKNOWN_DASH, finiteOrNull } from '../honestValues'
import { getLocale } from '@/i18n'

ChartJS.register( CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend)

export interface CostChartSeries {
  id?: string
  label: string
  data: Array<number | null>
  color: string
  dashed?: boolean
  fill?: boolean
  colorStops?: Array<{ value: number; color: string }>
}

export interface CostChartEvent {
  index: number
  label: string
  severity?: 'info' | 'warning'
}

const props = withDefaults(defineProps<{
  labels: string[]
  series: CostChartSeries[]
  economicLedger?: boolean
  material?: 'soft-gold'
  height?: number
  valuePrefix?: string
  valueSuffix?: string
  valueDivisor?: number
  showValues?: boolean
  state?: DataAvailability
  stateReason?: string
  events?: CostChartEvent[]
}>(), {
  economicLedger: false,
  height: 190,
  valuePrefix: '',
  valueSuffix: '',
  valueDivisor: 1,
  showValues: false,
  state: 'measured',
  stateReason: '',
  events: () => [],
})

const hiddenSeries = ref<Record<string, boolean>>({})
const seriesKey = (index: number) => props.series[index].id ?? String(index)
const primarySeriesIndex = computed(() => props.series.findIndex((item, index) => !hiddenSeries.value[seriesKey(index)] && item.data.some(value => value != null && Number.isFinite(value))))
function toggleSeries(index: number) { const key = seriesKey(index); hiddenSeries.value = { ...hiddenSeries.value, [key]: !hiddenSeries.value[key] } }
function keyValue(index: number): string {
  const observation = latestObservations.value[index]
  return observation ? props.valuePrefix + shortValue(observation.value / props.valueDivisor) + props.valueSuffix : UNKNOWN_DASH
}
function keyTitle(index: number): string {
  const observation = latestObservations.value[index]
  return observation ? `${props.series[index].label} · ${props.labels[observation.index]} · ${props.valuePrefix}${observation.value.toLocaleString(getLocale(), { maximumFractionDigits: 6 })}${props.valueSuffix}` : t('costComponents.noValidReadings')
}

const chartDescription = computed(() => t('costComponents.timePointsGapsMeanMissingDataNot', { p0: props.series.map(item => item.label).join('、'), p1: props.labels.length, p2: props.economicLedger ? t('costComponents.thinLinesAndMarkersConnectRealSamples') : props.material ? t('costComponents.linesAndPointsRepresentRealSamplesBand') : '' }))

const hasPlottableValue = computed(() => props.labels.length > 0 && props.series.some((item) => item.data.some((value) => value != null && Number.isFinite(value))))
const effectiveState = computed<DataAvailability>(() => !['loading', 'unavailable', 'empty'].includes(props.state) && !hasPlottableValue.value ? 'empty' : props.state)
const showChart = computed(() => !['loading', 'unavailable', 'empty'].includes(effectiveState.value))
const stateLabel = computed(() => dataAvailabilityLabel(effectiveState.value))
const effectiveReason = computed(() => effectiveState.value === 'empty' && !hasPlottableValue.value ? props.stateReason || t('costComponents.noValidDataCanBePlottedIn') : props.stateReason)

function seriesGradient(item: CostChartSeries, chart: Pick<ChartJS, 'ctx' | 'chartArea' | 'scales'>, alpha = ''): string | CanvasGradient {
  const stops = item.colorStops
  if (!stops?.length || !chart.chartArea || !chart.scales.y) return item.color + alpha
  const first = stops[0].value
  const last = stops[stops.length - 1].value
  if (last <= first) return stops[0].color + alpha
  const gradient = chart.ctx.createLinearGradient(0, chart.scales.y.getPixelForValue(first), 0, chart.scales.y.getPixelForValue(last))
  stops.forEach(stop => gradient.addColorStop((stop.value - first) / (last - first), stop.color + alpha))
  return gradient
}

function withAlpha(color: string, alpha: string): string {
  const hex = /^#[0-9a-f]{3}$/i.test(color)
    ? '#' + color.slice(1).split('').map(character => character + character).join('')
    : color
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex + alpha : color
}

function areaGradient(item: CostChartSeries, chart: Pick<ChartJS, 'ctx' | 'chartArea' | 'scales'>): string | CanvasGradient {
  if (props.economicLedger && chart.chartArea) {
    const gradient = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom)
    gradient.addColorStop(0, withAlpha(item.color, '24'))
    gradient.addColorStop(.55, withAlpha(item.color, '0f'))
    gradient.addColorStop(1, withAlpha(item.color, '00'))
    return gradient
  }
  if (item.colorStops) return seriesGradient(item, chart, '30')
  if (!chart.chartArea) return withAlpha(item.color, '14')
  const gradient = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom)
  const fillColor = props.material === 'soft-gold' ? '#d9a537' : item.color
  gradient.addColorStop(0, withAlpha(fillColor, '45'))
  gradient.addColorStop(0.55, withAlpha(fillColor, '16'))
  gradient.addColorStop(0.9, withAlpha(fillColor, '06'))
  gradient.addColorStop(1, withAlpha(fillColor, '00'))
  return gradient
}

const economicSurface = economicGlassMaterial(
  () => props.economicLedger && props.material === 'soft-gold',
  value => t('costComponents.peak') + props.valuePrefix + (value / props.valueDivisor).toLocaleString(locale.value, { maximumFractionDigits: 4 }) + props.valueSuffix,
)

const chartData = computed<ChartData<'line'>>(() => ({
  labels: props.labels,
  datasets: props.series.slice(0, 3).map((item, seriesIndex) => {
    // 单点 series 显示点(pointRadius>0),多点折线不显示点(靠 hover)。
    // cockpit 健康图只有 1 个持久采样点,pointRadius:0 + spanGaps:false 会让单点退化线不可见。
    const finitePoints = item.data.filter((value) => value != null && Number.isFinite(value)).length
    const peak = item.colorStops ? Math.max(0, ...item.data.map(value => value ?? 0)) : 0
    const peakIndex = peak > 0 ? item.data.indexOf(peak) : -1
    return {
      label: item.label,
      data: item.data,
      hidden: props.economicLedger ? !!hiddenSeries.value[seriesKey(seriesIndex)] : undefined,
      borderColor: props.economicLedger && props.material === 'soft-gold' && seriesIndex === primarySeriesIndex.value ? '#ffe8ad' : item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart) : item.color,
      backgroundColor: props.economicLedger ? (context: ScriptableContext<'line'>) => areaGradient(item, context.chart) : item.fill ? (context: ScriptableContext<'line'>) => areaGradient(item, context.chart) : 'transparent',
      borderDash: item.dashed ? [5, 4] : [],
      borderWidth: props.economicLedger ? seriesIndex === primarySeriesIndex.value ? 1.8 : 1.15 : props.material ? 1.2 : item.dashed ? 1.4 : item.colorStops ? 2.4 : 1.8,
      fill: props.economicLedger ? props.material === 'soft-gold' ? false : seriesIndex === primarySeriesIndex.value ? 'origin' : false : props.material ? false : item.fill ? 'origin' : false,
      pointRadius: props.economicLedger ? item.data.map((_value, index) => index === latestObservations.value[seriesIndex]?.index ? 2 : 0) : item.colorStops ? item.data.map((_value, index) => index === peakIndex ? 5 : 3) : props.showValues || finitePoints <= 1 ? 3 : 0,
      pointBackgroundColor: props.economicLedger ? item.color : item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart) : props.showValues ? item.color : undefined,
      pointBorderColor: item.colorStops ? item.data.map((_value, index) => index === peakIndex ? '#eef3f0' : '#101413') : undefined,
      pointBorderWidth: item.colorStops ? 1.5 : 1,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 1,
      pointHoverBackgroundColor: item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart) : '#101410',
      tension: !!props.material && (seriesIndex === 0 || props.material === 'soft-gold' && !item.dashed) ? .3 : 0,
      cubicInterpolationMode: (item.colorStops || !!props.material && (seriesIndex === 0 || props.material === 'soft-gold' && !item.dashed)) ? 'monotone' as const : 'default' as const,
      spanGaps: false,
    }
  }),
}))

// The rail is labelled as last *known* observations, never an extrapolation to
// now. A trailing null retains its own timestamp/index and draws a dashed leader.
const latestObservations = computed(() => props.series.slice(0, 3).map(item => {
  for (let index = item.data.length - 1; index >= 0; index--) {
    const value = item.data[index]
    if (value != null && Number.isFinite(value)) return { index, value }
  }
  return null
}))

function shortValue(value: number): string {
  return value.toLocaleString(getLocale(), { notation: Math.abs(value) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 2 })
}

const cursorGuide: Plugin<'line'> = {
  id: 'cost-cursor-guide',
  beforeDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements()
    if (!active?.length) return
    const { ctx, chartArea } = chart
    const x = active[0].element.x
    ctx.save()
    ctx.strokeStyle = 'rgba(190, 211, 222, 0.24)'
    ctx.setLineDash([3, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, chartArea.top)
    ctx.lineTo(x, chartArea.bottom)
    ctx.stroke()
    ctx.restore()
  },
}

const valueLabels: Plugin<'line'> = {
  id: 'readable-values',
  afterDatasetsDraw(chart) {
    if (!props.showValues) return
    const { ctx, chartArea } = chart
    ctx.save()
    ctx.font = '12px Segoe UI, sans-serif'
    ctx.textBaseline = 'bottom'
    chart.data.datasets.forEach((dataset, seriesIndex) => {
      if (!chart.isDatasetVisible(seriesIndex)) return
      const points = chart.getDatasetMeta(seriesIndex).data
      const stride = Math.max(1, Math.ceil((points.length - 1) / 6))
      const source = props.series[seriesIndex]
      const peak = source.colorStops ? Math.max(0, ...source.data.map(value => value ?? 0)) : 0
      const peakIndex = source.data.indexOf(peak)
      points.forEach((point, index) => {
        const value = dataset.data[index]
        if (typeof value !== 'number' || !Number.isFinite(value)) return
        if (source.colorStops) {
          if (index !== peakIndex && (index !== points.length - 1 || (peakIndex >= 0 && Math.abs(point.x - points[peakIndex].x) < 85))) return
        } else if (index % stride !== 0 && index !== points.length - 1) return
        const scaled = value / props.valueDivisor
        const label = scaled > 0 && scaled < 0.01 ? '<0.01' : scaled.toLocaleString(getLocale(), { maximumFractionDigits: 2 })
        ctx.fillStyle = source.colorStops ? seriesGradient(source, chart) : String(dataset.borderColor)
        ctx.textAlign = point.x < chartArea.left + 30 ? 'left' : point.x > chartArea.right - 30 ? 'right' : 'center'
        ctx.fillText((source.colorStops && index === peakIndex ? t('costComponents.peak') : '') + label, point.x, Math.max(chartArea.top + 14, point.y - 11))
      })
    })
    ctx.restore()
  },
}

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  layout: { padding: { top: 10 } },
  locale: locale.value,
  responsive: true,
  maintainAspectRatio: false,
  // Auto refresh is a data replacement, not a page transition. Disabling the
  // replay animation prevents the WebView chart from visibly flashing every
  // refresh cycle while preserving hover interaction.
  animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: {
      display: !props.economicLedger && !props.series.some(series => series.colorStops?.length),
      align: 'start',
      labels: {
        color: '#a3afb7',
        boxWidth: 16,
        boxHeight: 2,
        padding: 14,
        font: { family: 'Bahnschrift, Segoe UI Variable, sans-serif', size: 10 },
      },
    },
    tooltip: {
      backgroundColor: 'rgba(16, 23, 30, 0.96)',
      borderColor: 'rgba(170, 194, 209, 0.24)',
      borderWidth: 1,
      titleColor: '#f1f4ec',
      bodyColor: '#c4d0d7',
      padding: 12,
      cornerRadius: 8,
      displayColors: true,
      boxWidth: 7,
      boxHeight: 7,
      callbacks: {
        label: (context: { parsed: { y?: number | null }; dataset: { label?: string } }) => {
          // 该点是**断点**(null = 该源不掌握这一档)时显示 `—`,不是 `0`。
          // `Number(y ?? 0)` 会把"不可确认"渲染成"实测为 0",正是本图 spanGaps:false 要表达的语义的反面。
          const value = finiteOrNull(context.parsed.y)
          if (value == null) return ` ${context.dataset.label}: ${UNKNOWN_DASH}`
          return ` ${context.dataset.label}: ${props.valuePrefix}${value.toLocaleString(getLocale(), props.showValues ? { maximumSignificantDigits: 12 } : { maximumFractionDigits: 4 })}${props.valueSuffix}`
        },
      },
    },
  },
  scales: {
    x: {
      grid: { display: true, color: 'rgba(188, 199, 157, 0.15)', lineWidth: .6 },
      border: { display: false, dash: [2, 3] },
      ticks: {
        color: props.showValues ? '#a4b5ac' : '#829099',
        maxTicksLimit: 7,
        maxRotation: 0,
        font: { family: 'Cascadia Mono, Consolas, monospace', size: props.showValues ? 12 : 9 },
      },
    },
    y: {
      beginAtZero: true,
      grace: props.showValues ? '15%' : 0,
      grid: { color: 'rgba(154, 181, 196, 0.09)', lineWidth: 0.7 },
      border: { display: false },
      ticks: {
        color: props.showValues ? '#a4b5ac' : '#829099',
        maxTicksLimit: 4,
        padding: 8,
        font: { family: 'Cascadia Mono, Consolas, monospace', size: props.showValues ? 12 : 9 },
        callback: (value) => `${props.economicLedger ? '' : props.valuePrefix}${(Number(value) / props.valueDivisor).toLocaleString(getLocale(), props.showValues && Math.abs(Number(value) / props.valueDivisor) > 0 && Math.abs(Number(value) / props.valueDivisor) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 })}${props.valueDivisor === 1 ? props.valueSuffix : ''}`,
      },
    },
  },
}))


function eventPosition(index: number): number {
  if (props.labels.length <= 1) return 50
  return Math.max(2, Math.min(98, (index / (props.labels.length - 1)) * 100))
}
</script>

<style scoped>
.cost-chart {
  position: relative;
  width: 100%;
  min-width: 0;
}


.cost-chart__plot { position: relative; height: 100%; min-width: 0; }
.cost-chart--ledger .cost-chart__plot { height: calc(100% - 34px); }
.cost-chart__keys { display: grid; height: 34px; gap: 16px; align-items: start; padding: 0 1px; }
.cost-chart__keys button { display: flex; align-items: baseline; gap: 7px; min-width: 0; height: 27px; padding: 2px 5px 4px; border: 0; border-bottom: 1px solid transparent; border-radius: 3px 3px 0 0; color: #9caaa9; background: transparent; cursor: pointer; text-align: left; }
.cost-chart__keys button i { flex: 0 0 2px; height: 8px; background: var(--series-color); opacity: .9; border-radius: 1px; }
.cost-chart__keys button span { font-size: 10px; white-space: normal; overflow-wrap: anywhere; }
.cost-chart__keys button strong { margin-left: auto; color: #c1cfca; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cost-chart__keys button.is-primary { border-bottom-color: color-mix(in srgb, var(--series-color) 30%, transparent); }
.cost-chart__keys button.is-primary strong { color: #ffe2a0; font: 500 19px Georgia, 'Times New Roman', serif; }
.cost-chart__keys button:hover { background: rgb(221 237 230 / 3%); }
.cost-chart__keys button:focus-visible { outline: 1px solid var(--series-color); outline-offset: 1px; }
.cost-chart__keys button.is-hidden { opacity: .4; }
.cost-chart__keys button.is-hidden span { text-decoration: line-through; }
.cost-chart--ledger .cost-chart__partial { top: 34px; left: 46px; }
.cost-chart--ledger .cost-chart__events { top: 38px; right: 0; left: 44px; }

.cost-chart__state {
  display: grid;
  height: 100%;
  place-content: center;
  gap: 6px;
  border: 1px dashed rgb(255 255 255 / 13%);
  border-radius: 10px;
  color: #a9b2aa;
  text-align: center;
}

.cost-chart__state span { font-size: 14px; font-weight: 650; }
.cost-chart__state small { max-width: 420px; color: #758078; font-size: 11px; }
.cost-chart.data-unavailable .cost-chart__state { border-color: rgb(213 132 115 / 35%); }
.cost-chart__partial { position: absolute; top: 2px; left: 2px; z-index: 2; padding: 2px 6px; border: 1px solid rgb(224 189 78 / 28%); border-radius: 999px; background: rgb(26 29 30 / 90%); color: #d8b94d; font-size: 9px; }
.cost-chart__events { position: absolute; inset: 32px 18px 22px 42px; z-index: 3; pointer-events: none; }
.cost-chart__event { position: absolute; top: 0; bottom: 0; width: 1px; border-left: 1px dashed rgb(126 182 216 / 65%); }
.cost-chart__event i { position: absolute; top: -1px; left: -4px; width: 7px; height: 7px; border: 1px solid #111611; border-radius: 50%; background: #7eb6d8; }
.cost-chart__event.is-warning { border-left-color: rgb(224 189 78 / 78%); }
.cost-chart__event.is-warning i { background: #e0bd4e; }

@media (prefers-reduced-motion: reduce) {
  .cost-chart {
    scroll-behavior: auto;
  }
}
</style>
