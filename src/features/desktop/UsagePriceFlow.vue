<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed, getCurrentInstance } from 'vue'
import { splineCurve } from 'chart.js/helpers'
import { usageColors } from './usageChartPalette'
import type { PriceEvidence } from '@/api/usageMonitor'

const { t } = useI18n()
const props = defineProps<{ evidence: PriceEvidence }>()
const graphicId = `tariff-flow-${getCurrentInstance()!.uid}`
const profiles = [
  { centers: [86, 80, 84, 88, 70, 87, 92, 86, 73, 87, 86, 74, 68], widths: [6, 35, 62, 12, 54, 10, 42, 10, 64, 14, 26, 26, 0] },
  { centers: [122, 145, 118, 122, 143, 116, 128, 113, 128, 143, 128, 118, 126], widths: [20, 28, 38, 5, 16, 58, 18, 34, 16, 5, 26, 28, 0] },
  { centers: [153, 140, 177, 172, 144, 148, 172, 173, 155, 150, 174, 178, 176], widths: [18, 24, 16, 8, 22, 26, 36, 14, 8, 28, 18, 20, 0] },
]
function curvePath(points: Array<{ x: number; y: number }>, start = 'M'): string {
  const controls = points.map((point, index) => splineCurve(points[Math.max(0, index - 1)], point, points[Math.min(points.length - 1, index + 1)], .3))
  return `${start} ${points[0].x} ${points[0].y}` + points.slice(1).map((point, index) => {
    const from = controls[index].next, to = controls[index + 1].previous
    return ` C ${from.x} ${from.y} ${to.x} ${to.y} ${point.x} ${point.y}`
  }).join('')
}
const plot = { top: 24, bottom: 228, axisX: 668 }
function stream(profile: typeof profiles[number], targetY: number, rowIndex: number) {
  const points = (position: number) => profile.centers.map((center, index) => {
    const t = Math.max(0, (index - 8) / 4)
    const blend = t * t * (3 - 2 * t)
    return { x: 16 + index * 50 + rowIndex * index / 2, y: center * (1 - blend) + targetY * blend + (position - .5) * profile.widths[index] }
  })
  const lower = points(1)
  const top = curvePath(points(0)), bottom = curvePath(lower)
  // Return along the lower edge so each bundle expands and pinches as one surface.
  return { top, bottom, area: `${top} ${curvePath([...lower].reverse(), 'L')} Z`, center: curvePath(points(.5)), endX: 616 + rowIndex * 6, strands: Array.from({ length: 36 }, (_, index) => ({ path: curvePath(points(index / 35)), opacity: .18 + Math.sin(index / 35 * Math.PI) * .5 })) }
}
const prices = computed(() => [
  { label: t('usageMonitor.text.uncachedInput'), value: props.evidence.inputPerMillion, color: usageColors.input },
  { label: t('usageMonitor.text.repeatedInputCache'), value: props.evidence.cachedPerMillion, color: usageColors.cache },
  { label: t('usageMonitor.text.modelOutput'), value: props.evidence.outputPerMillion, color: usageColors.output },
])
const scaleMaximum = computed(() => {
  const maximum = Math.max(0, ...prices.value.map(row => row.value ?? 0))
  if (!maximum) return 1
  const unit = 10 ** Math.floor(Math.log10(maximum))
  return unit * ([1, 2, 5, 10].find(step => step * unit >= maximum) ?? 10)
})
const priceY = (value: number) => plot.bottom - value / scaleMaximum.value * (plot.bottom - plot.top)
const ticks = computed(() => Array.from({ length: 6 }, (_, index) => ({ value: scaleMaximum.value * index / 5, y: priceY(scaleMaximum.value * index / 5) })))
const rows = computed(() => {
  const result = prices.value.map((row, index) => {
    const endY = row.value == null ? profiles[index].centers.at(-1)! : priceY(row.value)
    return { ...row, graphic: stream(profiles[index], endY, index), endY, labelY: endY, gradient: `${graphicId}-${index}` }
  })
  const labels = result.slice().sort((a, b) => a.labelY - b.labelY)
  labels.forEach((row, index) => { row.labelY = Math.max(row.labelY, index ? labels[index - 1].labelY + 56 : plot.top + 12) })
  const overflow = Math.max(0, labels.at(-1)!.labelY - plot.bottom)
  labels.forEach(row => { row.labelY -= overflow })
  labels[0].labelY = Math.max(plot.top + 12, labels[0].labelY)
  return result
})
const number = (value: number | null) => value == null ? t('usageMonitor.text.unitPriceNotProvided') : value.toLocaleString(usageLocale(), { maximumSignificantDigits: 12 })
const currency = computed(() => props.evidence.currency === 'CNY' ? t('usageMonitor.text.cny3') : props.evidence.currency === 'USD' || !props.evidence.currency ? t('usageMonitor.text.usd') : props.evidence.currency === 'UNKNOWN' ? t('usageMonitor.text.currencyNotConfirmed') : props.evidence.currency)
</script>

<template>
  <section class="tariff-visual" :aria-label="t('usageMonitor.text.inputCacheOutputUnitPriceComparison')">
    <div class="tariff-heading"><span>{{ t('usageMonitor.text.priceForTheSame1MillionTokens') }}</span><small>{{ currency }} {{ t('usageMonitor.text.millionTokens3') }}</small></div>
    <div class="tariff-values"><div v-for="row in rows" :key="row.label" :style="{ '--tariff-color': row.value == null ? usageColors.unknown : row.color }"><span>{{ row.label }}</span><strong>{{ number(row.value) }}</strong><small v-if="row.value === 0">{{ t('usageMonitor.text.thisUnitPriceIsZero') }}</small></div></div>
    <svg class="tariff-flow" viewBox="0 0 980 284" role="img" :aria-label="t('usageMonitor.text.threeTokenUnitPricesOnASharedScaleOf', { value0: number(scaleMaximum), value1: currency })">
      <defs><filter :id="`${graphicId}-depth`" x="-5%" y="-15%" width="110%" height="135%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="2.2" stdDeviation="1.8" flood-color="#020b08" flood-opacity=".26" /></filter><linearGradient v-for="row in rows" :id="row.gradient" :key="row.gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" :stop-color="row.color" stop-opacity=".09" /><stop offset=".32" :stop-color="row.color" stop-opacity=".25" /><stop offset=".55" :stop-color="row.color" stop-opacity=".45" /><stop offset=".82" :stop-color="row.color" stop-opacity=".19" /><stop offset="1" :stop-color="row.color" stop-opacity=".07" /></linearGradient></defs>
      <g v-for="row in rows" :key="row.label">
        <title>{{ row.label }}{{ t('usageMonitor.text.label') }}{{ number(row.value) }} {{ currency }} {{ t('usageMonitor.text.millionTokens3') }}</title>
        <g v-if="row.value != null && row.value > 0" :filter="`url(#${graphicId}-depth)`">
          <path class="tariff-ribbon" :data-price="row.value" :d="row.graphic.area" :fill="`url(#${row.gradient})`" />
          <path v-for="(strand, index) in row.graphic.strands" :key="index" class="tariff-strand" :d="strand.path" fill="none" :stroke="row.color" :stroke-opacity="strand.opacity" stroke-width=".65" />
          <path :d="row.graphic.top" fill="none" :stroke="row.color" stroke-opacity=".65" stroke-width=".8" />
          <path :d="row.graphic.bottom" fill="none" :stroke="row.color" stroke-opacity=".4" stroke-width=".65" />
          <path class="tariff-edge-light" :d="row.graphic.top" fill="none" stroke="#e7f6ef" stroke-opacity=".17" stroke-width=".7" />
        </g>
        <path v-else class="tariff-guide" :d="row.graphic.center" fill="none" :stroke="row.value == null ? usageColors.unknown : row.color" stroke-opacity=".2" stroke-width="1" stroke-dasharray="4 5" />
        <template v-if="row.value != null">
          <path :d="`M ${row.graphic.endX} ${row.endY} H 714 L 734 ${row.labelY} H 744`" fill="none" :stroke="row.color" stroke-opacity=".55" stroke-width="1" />
          <circle class="tariff-price-point" :data-price="row.value" :cx="row.graphic.endX" :cy="row.endY" r="4" :fill="row.color" />
        </template>
        <g class="tariff-end-label" :transform="`translate(754 ${row.labelY})`" :fill="row.value == null ? usageColors.unknown : row.color"><text y="-9" font-size="16">{{ row.label }}</text><text class="tariff-end-value" y="18" :font-size="row.value == null ? 18 : 28" font-weight="650">{{ number(row.value) }}</text></g>
      </g>
      <g class="tariff-price-axis" fill="#a4b5ac" font-size="14"><text :x="plot.axisX" y="10">{{ t('usageMonitor.text.unitPrice') }}</text><path :d="`M ${plot.axisX} ${plot.top} V ${plot.bottom}`" stroke="#4c6054" /><g v-for="tick in ticks" :key="tick.value" :transform="`translate(${plot.axisX} ${tick.y})`"><path d="M -4 0 H 5" stroke="#85988b" /><text x="12" y="4" stroke="#0d110e" stroke-width="4" paint-order="stroke">{{ number(tick.value) }}</text></g></g>
    </svg>
    <p class="tariff-note">{{ t('usageMonitor.text.higherEndpointHigherUnitPrice') }} {{ currency }} {{ t('usageMonitor.text.millionTokens3') }}</p>
  </section>
</template>

<style scoped>
.tariff-visual{margin:24px 0 10px;min-width:0}.tariff-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;font-size:12px;margin-bottom:24px}.tariff-heading small{color:#97ac9f;font-size:11px}.tariff-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.tariff-values>div{min-width:0;border-left:2px solid var(--tariff-color);padding-left:10px}.tariff-values span{display:flex;align-items:center;gap:6px;font-size:12px;color:#afbeb4;line-height:1.6}.tariff-values strong{display:block;margin-top:8px;color:var(--tariff-color);font-size:25px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.tariff-values small{display:block;font-size:10px;color:var(--cost-muted);margin-top:5px}.tariff-flow{display:block;width:100%;height:auto;max-height:290px;margin-top:16px;overflow:visible}.tariff-note{font-size:10px;line-height:1.6;color:#97ac9f;margin:0 0 16px}.tariff-guide{pointer-events:none}@media(max-width:500px){.tariff-values{gap:10px}.tariff-values>div{padding-left:7px}.tariff-values strong{font-size:19px}.tariff-values span{font-size:11px}.tariff-heading{align-items:flex-start;flex-direction:column;gap:6px}}
</style>

