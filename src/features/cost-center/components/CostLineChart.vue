<template>
  <div class="cost-chart" :class="[`data-${effectiveState}`, { 'cost-chart--readable': showValues }]" :style="{ height: `${height}px` }" :data-data-state="effectiveState">
    <Line v-if="showChart" :data="chartData" :options="chartOptions" :plugins="[valueLabels]" />
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

import { computed } from 'vue'
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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend)

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
  height?: number
  valuePrefix?: string
  valueSuffix?: string
  valueDivisor?: number
  showValues?: boolean
  state?: DataAvailability
  stateReason?: string
  events?: CostChartEvent[]
}>(), {
  height: 190,
  valuePrefix: '',
  valueSuffix: '',
  valueDivisor: 1,
  showValues: false,
  state: 'measured',
  stateReason: '',
  events: () => [],
})

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

const chartData = computed<ChartData<'line'>>(() => ({
  labels: props.labels,
  datasets: props.series.slice(0, 3).map((item) => {
    // 单点 series 显示点(pointRadius>0),多点折线不显示点(靠 hover)。
    // cockpit 健康图只有 1 个持久采样点,pointRadius:0 + spanGaps:false 会让单点退化线不可见。
    const finitePoints = item.data.filter((value) => value != null && Number.isFinite(value)).length
    const peak = item.colorStops ? Math.max(0, ...item.data.map(value => value ?? 0)) : 0
    const peakIndex = peak > 0 ? item.data.indexOf(peak) : -1
    return {
      label: item.label,
      data: item.data,
      borderColor: item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart) : item.color,
      backgroundColor: item.fill ? item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart, '30') : `${item.color}16` : 'transparent',
      borderDash: item.dashed ? [5, 4] : [],
      borderWidth: item.dashed ? 1.4 : item.colorStops ? 2.4 : 1.8,
      fill: item.fill ? 'origin' : false,
      pointRadius: item.colorStops ? item.data.map((_value, index) => index === peakIndex ? 5 : 3) : props.showValues || finitePoints <= 1 ? 3 : 0,
      pointBackgroundColor: item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart) : props.showValues ? item.color : undefined,
      pointBorderColor: item.colorStops ? item.data.map((_value, index) => index === peakIndex ? '#eef3f0' : '#101413') : undefined,
      pointBorderWidth: item.colorStops ? 1.5 : 1,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 1,
      pointHoverBackgroundColor: item.colorStops ? (context: ScriptableContext<'line'>) => seriesGradient(item, context.chart) : '#101410',
      tension: 0.18,
      cubicInterpolationMode: item.colorStops ? 'monotone' as const : 'default' as const,
      spanGaps: false,
    }
  }),
}))

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
      display: !props.series.some(series => series.colorStops?.length),
      align: 'end',
      labels: {
        color: '#8f9b91',
        boxWidth: 16,
        boxHeight: 2,
        padding: 14,
        font: { family: 'Bahnschrift, Segoe UI Variable, sans-serif', size: 10 },
      },
    },
    tooltip: {
      backgroundColor: '#111611',
      borderColor: '#3b443b',
      borderWidth: 1,
      titleColor: '#f1f4ec',
      bodyColor: '#b8c1b8',
      padding: 10,
      callbacks: {
        label: (context) => {
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
      grid: { display: false },
      border: { display: false },
      ticks: {
        color: props.showValues ? '#a4b5ac' : '#68736a',
        maxTicksLimit: 7,
        maxRotation: 0,
        font: { family: 'Cascadia Mono, Consolas, monospace', size: props.showValues ? 12 : 9 },
      },
    },
    y: {
      beginAtZero: true,
      grace: props.showValues ? '15%' : 0,
      grid: { color: '#293129', lineWidth: 0.7 },
      border: { display: false },
      ticks: {
        color: props.showValues ? '#a4b5ac' : '#68736a',
        maxTicksLimit: 4,
        padding: 8,
        font: { family: 'Cascadia Mono, Consolas, monospace', size: props.showValues ? 12 : 9 },
        callback: (value) => `${props.valuePrefix}${(Number(value) / props.valueDivisor).toLocaleString(getLocale(), props.showValues && Math.abs(Number(value) / props.valueDivisor) > 0 && Math.abs(Number(value) / props.valueDivisor) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 })}${props.valueDivisor === 1 ? props.valueSuffix : ''}`,
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
.cost-chart.data-partial::after {
  position: absolute;
  inset: 28px 0 0;
  pointer-events: none;
  background: repeating-linear-gradient(135deg, transparent 0 10px, rgb(224 189 78 / 2.5%) 10px 20px);
  content: '';
}
.cost-chart--readable.data-partial::after { display: none; }
.cost-chart__partial { position: absolute; top: 2px; left: 2px; z-index: 2; padding: 2px 6px; border: 1px solid rgb(224 189 78 / 28%); border-radius: 999px; background: #191a12; color: #d8b94d; font-size: 9px; }
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
