<template>
  <div class="model-contribution-chart" :style="{ height: `${height}px` }">
    <div v-if="hasLedger" class="model-ledger" :aria-label="t('costComponents.modelCostComparisonAmountsInUsd')">
      <div class="ring-toolbar">
        <span>
          {{ t('costComponents.topModels', { count: topRows.length }) }} {{ t('costComponents.sharedAmountScale') }} </span>
        <div class="ring-toggles">
          <button
            v-for="measure in measures"
            :key="measure.key"
            type="button"
            :aria-pressed="visible[measure.key]"
            :aria-label="t('costComponents.show', { p0: measure.label })"
            :class="['ledger-toggle', measure.key]"
            @click="visible[measure.key] = !visible[measure.key]"
          >
            {{ measure.label }}
          </button>
        </div>
      </div>
      <div class="ring-scroll">
        <div class="ring-grid">
          <div
            v-for="(card, index) in cards"
            :key="`${card.row.model}-${index}`"
            class="model-card"
            tabindex="0"
            :style="{ '--model-color': card.color }"
            :aria-label="description(card.row)"
            :aria-describedby="active === index ? tooltipId : undefined"
            @mouseenter="active = index"
            @mouseleave="active = null"
            @focus="active = index"
            @blur="active = null"
            @keydown.esc="active = null"
          >
            <div class="model-heading">
              <span class="model-rank">
                {{ String(index + 1).padStart(2, '0') }}
              </span>
              <strong :title="card.row.model || t('costComponents.unknownModel')">
                {{ card.row.model || t('costComponents.unknownModel') }}
              </strong>
            </div>
            <div class="ring-figure">
              <svg viewBox="0 0 140 140" aria-hidden="true">
                <circle cx="70" cy="70" r="64" class="ring-ticks" />
                <circle cx="70" cy="70" r="58" class="outer-track" />
                <circle
                  v-if="visible.revenue && card.billing != null && card.billing > 0"
                  data-mark="billing"
                  cx="70"
                  cy="70"
                  r="58"
                  pathLength="100"
                  :stroke-dasharray="dash(card.billing)"
                  class="billing-arc"
                  transform="rotate(-90 70 70)"
                />
                <circle cx="70" cy="70" r="42" class="inner-track" />
                <template v-if="card.composition != null">
                  <circle
                    v-if="visible.accountCost && card.composition > 0"
                    data-mark="cost"
                    cx="70"
                    cy="70"
                    r="42"
                    pathLength="100"
                    :stroke-dasharray="dash(card.composition)"
                    class="cost-arc"
                    transform="translate(140 0) scale(-1 1) rotate(-90 70 70)"
                  />
                  <circle
                    v-if="visible.grossProfit && card.composition < 1"
                    data-mark="difference"
                    cx="70"
                    cy="70"
                    r="42"
                    pathLength="100"
                    :stroke-dasharray="dash(1 - card.composition)"
                    :stroke-dashoffset="-card.composition * 100"
                    class="difference-arc"
                    transform="translate(140 0) scale(-1 1) rotate(-90 70 70)"
                  />
                </template>
              </svg>
              <div class="ring-center">
                <span
                  :class="{ 'value-negative': known(card.row.revenue) && card.row.revenue < 0 }"
                  data-value="revenue"
                >
                  {{ visible.revenue ? money(card.row.revenue) : t('costComponents.hidden') }}
                </span>
                <small> {{ t('costComponents.userBillingUsd') }} </small>
              </div>
            </div>
            <div class="model-values">
              <div v-for="measure in measures.slice(1)" :key="measure.key" :class="measure.key">
                <small>
                  {{ measure.label }}
                </small>
                <span
                  :data-value="measure.key"
                  :class="{ 'value-negative': known(card.row[measure.key]) && card.row[measure.key]! < 0 }"
                >
                  {{ visible[measure.key] ? money(card.row[measure.key]) : t('costComponents.hidden') }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="ring-caption"> {{ t('costComponents.outerArcBillingScaleSharedMaximum') }} {{ maximum > 0 ? money(maximum) : '—' }}
        <span> {{ t('costComponents.innerRingCostAndBillingDifferenceComposition') }} </span>
      </div>
      <div
        v-if="active != null && topRows[active]"
        :id="tooltipId"
        role="tooltip"
        class="ledger-tooltip"
        :style="{ left: `${Math.min(active / 8 * 100, 65)}%` }"
      >
        <strong>
          {{ topRows[active].model || t('costComponents.unknownModel') }}
        </strong>
        <span v-for="measure in measures" :key="measure.key">
          {{ measure.label }}：{{ precise(topRows[active][measure.key]) }} USD
        </span>
        <small v-if="cards[active]?.composition == null"> {{ t('costComponents.innerRingUnavailableMissingAmountsNonpositiveBilling') }} </small>
        <small> {{ t('costComponents.theBillingDifferenceIsASourceLedger') }} </small>
      </div>
    </div>
    <div v-else class="model-contribution-chart__state">
      <strong>
        {{ dataAvailabilityLabel(effectiveState) }}
      </strong>
      <span>
        {{ effectiveReason }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

import { computed, getCurrentInstance, ref } from 'vue'
import type { ModelCostRow } from '../modelCostAnalysis'
import { dataAvailabilityLabel, type DataAvailability } from '../dataState'
import { getLocale } from '@/i18n'
import { billingRatio, compositionRatio, finiteAmount, modelRingColor } from './modelRingGeometry'
const props = withDefaults(defineProps<{ rows: ModelCostRow[]; state: DataAvailability; stateReason?: string; height?: number }>(), { stateReason: '', height: 230 })
type Measure = 'revenue' | 'accountCost' | 'grossProfit'
const measures = computed<Array<{ key: Measure; label: string; symbol: string }>>(() => [
  { key: 'revenue', label: t('costComponents.userBilling'), symbol: '│' },
  { key: 'accountCost', label: t('costComponents.upstreamCost'), symbol: '○' },
  { key: 'grossProfit', label: t('costComponents.billingDifference'), symbol: '━' },
])
const visible = ref<Record<Measure, boolean>>({ revenue: true, accountCost: true, grossProfit: true })
const active = ref<number | null>(null)
const tooltipId = `model-ledger-tooltip-${getCurrentInstance()?.uid ?? 0}`
const known = finiteAmount
function costDesc(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return right - left
}
const topRows = computed(() => [...props.rows].sort((left, right) => {
  if (left.revenue == null && right.revenue == null) return costDesc(left.accountCost, right.accountCost)
  if (left.revenue == null) return 1
  if (right.revenue == null) return -1
  return right.revenue - left.revenue || costDesc(left.accountCost, right.accountCost)
}).slice(0, 8))
const effectiveState = computed<DataAvailability>(() => !props.rows.length && !['loading', 'unavailable'].includes(props.state) ? 'empty' : props.state)
const effectiveReason = computed(() => effectiveState.value === 'empty' ? props.stateReason || t('costComponents.noModelContributionDataInTheSelected') : props.stateReason)
const hasLedger = computed(() => topRows.value.length > 0 && !['loading', 'unavailable', 'empty'].includes(effectiveState.value))
// Legend toggles never rescale the comparison or renormalize the composition.
const maximum = computed(() => Math.max(0, ...topRows.value.map(row => row.revenue).filter(known)))
const cards = computed(() => topRows.value.map(row => ({ row, color: modelRingColor(row.model || ''), billing: billingRatio(row.revenue, maximum.value), composition: compositionRatio(row.accountCost, row.grossProfit, row.revenue) })))
const dash = (ratio: number) => `${ratio * 100} ${100 - ratio * 100}`
const money = (value: number | null | undefined) => known(value) ? `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'
const precise = (value: number | null | undefined) => known(value) ? `$${value.toFixed(6)}` : '—'
const description = (row: ModelCostRow) => t('costComponents.theBillingDifferenceIsNotOperatingProfit', { p0: row.model || t('costComponents.unknownModel'), p1: measures.value.map(measure => `${measure.label} ${precise(row[measure.key])} USD`).join('; ') })
</script>

<style scoped>
.model-contribution-chart {
  background: transparent;
  width: 100%;
  min-width: 0;
  position: relative;
}

.model-ledger {
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.ring-toolbar {
  height: 21px;
  flex: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #8c9fae;
  font-size: 10px;
}

.ring-toggles {
  display: flex;
  gap: 15px;
}

.ledger-toggle {
  appearance: none;
  background: none;
  border: 0;
  padding: 2px 0;
  font: inherit;
  cursor: pointer;
  color: #b5c4cf;
}

.ledger-toggle.accountCost {
  color: #94a8bf;
}

.ledger-toggle.grossProfit {
  color: #e6d8be;
}

.ledger-toggle[aria-pressed=false] {
  opacity: .4;
  text-decoration: line-through;
}

.ledger-toggle:focus-visible,.model-card:focus-visible {
  outline: 1px solid #91b6a6;
  outline-offset: -1px;
}

.ring-scroll {
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.ring-grid {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
  height: 100%;
  min-width: 920px;
}

.model-card {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  border-right: 1px solid rgb(145 171 193 / 15%);
  padding: 0 8px;
  outline: none;
}

.model-card:last-child {
  border-right: 0;
}

.model-card:hover,.model-card:focus-visible {
  background: var(--cost-panel-2);
}

.model-heading {
  height: 34px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  color: var(--model-color);
}

.model-rank {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 13px;
}

.model-heading strong {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 13px;
  font-weight: 550;
  line-height: 17px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ring-figure {
  position: relative;
  flex: 1;
  min-height: 70px;
  width: 100%;
  max-width: 140px;
  display: grid;
  place-items: center;
}

.ring-figure svg {
  position: absolute;
  display: block;
  height: 100%;
  width: 100%;
  max-height: 128px;
  overflow: visible;
}

.ring-figure circle {
  fill: none;
}

.ring-ticks {
  stroke: #8295a7;
  stroke-opacity: .45;
  stroke-width: 2;
  stroke-dasharray: .6 7.78;
}

.outer-track {
  stroke: #8399ae;
  stroke-opacity: .19;
  stroke-width: 2;
}

.inner-track {
  stroke: #8399ae;
  stroke-opacity: .14;
  stroke-width: 5;
}

.billing-arc {
  stroke: var(--model-color);
  stroke-width: 8;
  stroke-linecap: butt;
}

.cost-arc {
  stroke: #94a8bf;
  stroke-width: 5;
}

.difference-arc {
  stroke: #e6d8be;
  stroke-width: 5;
}

.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  gap: 2px;
}

.ring-center>span {
  color: #cbdcf1;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 21px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.6px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ring-center small {
  color: #8397a8;
  font-size: 8px;
}

.model-values {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 100%;
  height: 39px;
  flex: none;
  padding-top: 2px;
}

.model-values>div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.model-values>div+div {
  border-left: 1px solid rgb(145 171 193 / 20%);
}

.model-values small {
  font-size: 9px;
  color: #9cabb7;
}

.model-values span {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 16px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.accountCost {
  color: #94a8bf;
}

.grossProfit {
  color: #e6d8be;
}

.value-negative {
  color: #e5a1ac!important;
}

.ring-caption {
  height: 18px;
  flex: none;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 22px;
  color: #8b9fae;
  font-size: 9px;
}

.ledger-tooltip {
  position: absolute;
  z-index: 5;
  top: 46px;
  max-width: 340px;
  padding: 9px 12px;
  border: 1px solid var(--cost-line-strong);
  border-radius: 6px;
  background: var(--cost-panel-2);
  box-shadow: 0 5px 18px #0005;
  color: var(--cost-text);
  pointer-events: none;
  font-size: 11px;
  display: grid;
  gap: 3px;
}

.ledger-tooltip strong {
  font-size: 12px;
}

.ledger-tooltip small {
  color: var(--cost-muted);
  font-size: 10px;
}

.model-contribution-chart__state {
  display: grid;
  height: 100%;
  place-content: center;
  gap: 5px;
  border: 1px dashed rgb(255 255 255 / 13%);
  border-radius: 10px;
  color: #a9b2aa;
  text-align: center;
}

.model-contribution-chart__state span {
  color: #758078;
  font-size: 10px;
}

@media(max-width:800px) {
  .ring-grid {
    min-width: 880px;
  }
  .ring-caption {
    gap: 10px;
    font-size: 8px;
  }
  .ring-toolbar {
    font-size: 9px;
  }
  .ring-toggles {
    gap: 9px;
  }
}
</style>
