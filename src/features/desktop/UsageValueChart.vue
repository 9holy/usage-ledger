<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { MonitorForecastSummary } from '@/api/usageMonitor'
import { monitorAmount } from '@/api/usageMonitor'
import { usagePercentLabel } from './usageChartPalette'
import capsule from '@/assets/usage/scenes/value-original-capsule.webp'

const { t } = useI18n()
const props = defineProps<{
  forecast: Pick<
    MonitorForecastSummary,
    'currency' | 'observedSubtotal' | 'additionalSubtotal' | 'projectedSubtotal'
  > &
    Partial<MonitorForecastSummary>
  quota?: { accountLabel: string; usedPercent: number }
  partial?: boolean
}>()
const money = (value: number) =>
  new Intl.NumberFormat(usageLocale(), {
    style: 'currency',
    currency: props.forecast.currency,
    currencyDisplay: 'narrowSymbol',
    notation: 'compact',
    maximumSignificantDigits: value >= 10 && value < 10000 ? 6 : 4,
  }).format(value)
const values = computed(() => [
  props.forecast.observedSubtotal,
  props.forecast.additionalSubtotal,
  props.forecast.projectedSubtotal,
])
const valid = computed(
  () =>
    values.value.every(
      (value) => value != null && Number.isFinite(value) && value >= 0,
    ) &&
    props.forecast.projectedSubtotal! > 0 &&
    (!props.quota ||
      (Number.isFinite(props.quota.usedPercent) &&
        props.quota.usedPercent >= 0 &&
        props.quota.usedPercent <= 100)),
)
const observedShare = computed(() =>
  valid.value
    ? Math.min(
        100,
        Math.max(
          0,
          props.quota?.usedPercent ??
            (props.forecast.observedSubtotal /
              props.forecast.projectedSubtotal!) *
              100,
        ),
      )
    : 0,
)
const remainingShare = computed(() => 100 - observedShare.value)
const anchors = computed(() => [
  10 + observedShare.value * 0.325,
  10 + observedShare.value * 0.65 + remainingShare.value * 0.325,
  86.5,
])
const boundary = computed(() => 10 + observedShare.value * 0.65)
const splitLabel = computed(() => usagePercentLabel(observedShare.value))
const shortLabels = computed(() =>
  props.quota ? [t('usageMonitor.text.used'), t('usageMonitor.text.remaining2')] : [t('usageMonitor.text.recorded3'), t('usageMonitor.text.expectedAddition')],
)
const labels = computed(() =>
  props.quota
    ? props.partial
      ? [t('usageMonitor.text.pricedThisCycle'), t('usageMonitor.text.remainingPricedPortionProjection'), t('usageMonitor.text.pricedPortionAtFullQuota')]
      : [t('usageMonitor.text.usedThisCycle2'), t('usageMonitor.text.estimatedRemainingQuota'), t('usageMonitor.text.weeklyQuotaTotal')]
    : [t('usageMonitor.text.recordedStandardPrice'), t('usageMonitor.text.expectedLaterStandardPrice'), t('usageMonitor.text.fullWeekComparison')],
)
</script>
<template>
  <figure
    class="value-bridge"
    :aria-label="
      quota
        ? partial ? quota.accountLabel + ' · ' + t('usageMonitor.text.pricedPortionProjection') : t('usageMonitor.text.usedThisCycleEstimatedValueAt100WeeklyQuota', { value0: quota.accountLabel, value1: quota.usedPercent })
        : t('usageMonitor.text.recordedAndProjectedWeeklyUsageValueNotAccountQuota')
    "
  >
    <div class="value-bridge-heading">
      <span>{{
        quota
          ? partial ? quota.accountLabel + ' · ' + t('usageMonitor.text.pricedPortionProjection') : quota.accountLabel + t('usageMonitor.text.estimatedWeeklyQuotaValue')
          : t('usageMonitor.text.trendNormalizedToStandardPrices')
      }}</span
      ><small
        >{{ quota ? t('usageMonitor.text.proportionalQuotaValuation') : t('usageMonitor.text.comparisonAmount') }} ·
        {{ forecast.currency }}</small
      >
    </div>
    <template v-if="valid">
      <div class="capsule-scale" :aria-label="t('usageMonitor.text.liquidSegmentProportionScale')">
        <span
          v-for="tick in [0, 25, 50, 75, 100]"
          :key="tick"
          :style="{ left: tick + '%' }"
          >{{ tick }}%</span
        >
        <b
          class="capsule-scale-pointer"
          :style="{ left: observedShare + '%' }"
          :data-percent="observedShare"
          >{{ shortLabels[0] }} {{ splitLabel }}</b
        >
      </div>
      <div
        class="value-capsule"
        role="img"
        :aria-label="
          quota
            ? t(partial ? 'usageMonitor.text.usedThisCyclePricedPortionProjection' : 'usageMonitor.text.usedThisCycleUsedAmountEstimatedRemainingQuotaTotal', { value0: quota.accountLabel, value1: quota.usedPercent, value2: money(values[0]!), value3: money(values[1]!), value4: money(values[2]!) })
            : t('usageMonitor.text.recordedExpectedAdditionFullWeekTotal', { value0: money(values[0]!), value1: money(values[1]!), value2: money(values[2]!) })
        "
      >
        <img :src="capsule" alt="" />
        <div class="capsule-fill">
          <i class="observed-fill" :style="{ width: observedShare + '%' }" /><i
            class="forecast-fill"
            :style="{ width: 100 - observedShare + '%' }"
          />
        </div>
        <div
          v-if="observedShare > 0 && observedShare < 100"
          class="capsule-divider"
          :style="{ left: boundary + '%' }"
          :data-percent="observedShare"
        />
        <span class="capsule-sum-symbol" aria-hidden="true">{{ t('usageMonitor.text.total2') }}</span>
        <svg
          class="capsule-pins"
          viewBox="0 0 1000 200"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <g
            v-for="(anchor, i) in anchors"
            :key="i"
            :stroke="['#83e9ba', '#99c6ff', '#efd18a'][i]"
          >
            <path :d="`M ${anchor * 10} 160 V 200`" />
            <circle :cx="anchor * 10" cy="160" r="3" />
          </g>
        </svg>
      </div>
      <svg
        class="capsule-links"
        viewBox="0 0 1000 48"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          v-for="(anchor, i) in anchors"
          :key="i"
          :d="`M ${anchor * 10} 0 V 10 Q ${anchor * 10} 18 ${anchor * 10 + (i * 333.333 + 166.667 - anchor * 10) / 2} 24 T ${i * 333.333 + 166.667} 38 V 48`"
          :stroke="['#83e9ba', '#99c6ff', '#efd18a'][i]"
        />
      </svg>
      <dl class="value-capsule-readouts">
        <div
          v-for="(label, i) in labels"
          :key="label"
          :data-value="values[i]"
          :title="monitorAmount(values[i]!, forecast.currency)"
        >
          <dt>
            <i
              :style="{ background: ['#83e9ba', '#99c6ff', '#efd18a'][i] }"
            />{{ label }}
          </dt>
          <dd>{{ money(values[i]!) }}</dd>
          <small v-if="i === 1">{{ t('usageMonitor.text.estimatedValue') }}</small
          ><small v-else-if="i === 0">{{ t('usageMonitor.text.collectedRecords') }}</small
          ><small v-else>{{ quota ? t('usageMonitor.text.totalOfBothPortions') : t('usageMonitor.text.notAccountQuota') }}</small>
        </div>
      </dl>
      <p class="capsule-reading-key">
        {{
          quota
            ? t('usageMonitor.text.greenUsedShareThisCycleBlueRemainingShareGold')
            : t('usageMonitor.text.greenRecordedAmountShareBlueExpectedLaterGoldTotal')
        }}
      </p>
    </template>
    <p v-else class="value-capsule-empty">
      {{
        quota
          ? t('usageMonitor.text.completeAccountQuotaEstimateNotYetAvailable')
          : t('usageMonitor.text.completeStandardPriceTrendDataNotYetAvailable')
      }}
    </p>
    <figcaption>
      {{
        quota
          ? t('usageMonitor.text.extrapolatesProportionallyFromRecordedBillableUsageAssumingAnUnchanged')
          : t('usageMonitor.text.aComparisonNormalizedToStandardPricesNotCostsCalculated')
      }}
    </figcaption>
  </figure>
</template>
<style scoped>
.value-bridge {
  container-type: inline-size;
  min-width: 0;
  margin: 12px 0 8px;
  padding: 12px 0;
  border-radius: 12px;
  background: transparent;
  border: 0;
}
.value-bridge-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 12px;
  color: #c9d8c9;
}
.value-bridge-heading small {
  font-size: 10px;
  color: #91a89b;
}
.capsule-scale {
  position: relative;
  margin: 28px 25% 3px 10%;
  height: 20px;
  border-bottom: 1px solid #87aa9855;
  font-size: 10px;
  color: #8ca99b;
}
.capsule-scale > span {
  position: absolute;
  transform: translateX(-50%);
  bottom: 5px;
}
.capsule-scale > span:after {
  content: '';
  position: absolute;
  width: 1px;
  height: 5px;
  background: #87aa9877;
  left: 50%;
  top: 100%;
}
.capsule-scale-pointer {
  position: absolute;
  bottom: 23px;
  transform: translateX(-50%);
  padding: 4px 7px;
  background: #123b2b;
  border: 1px solid #79d3a877;
  color: #b4f7d6;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  border-radius: 4px;
  transition: left 0.35s ease;
}
.capsule-scale-pointer:after {
  content: '';
  position: absolute;
  left: 50%;
  top: 100%;
  height: 24px;
  width: 1px;
  background: #99e4bd99;
}
.value-capsule {
  position: relative;
  isolation: isolate;
  aspect-ratio: 1536/310;
}
.value-capsule > img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.capsule-fill {
  position: absolute;
  display: flex;
  border-radius: 80px;
  overflow: hidden;
  mix-blend-mode: color;
  opacity: 0.9;
  left: 10%;
  right: 25%;
  top: 14%;
  bottom: 18%;
}
.capsule-fill i {
  display: block;
  height: 100%;
  transition: width 0.35s ease;
}
.observed-fill {
  background: #30c68c;
}
.forecast-fill {
  background: #428cff;
}
.capsule-divider {
  position: absolute;
  width: clamp(6px, 1.2cqw, 13px);
  top: 14%;
  bottom: 18%;
  transform: translateX(-50%);
  border-radius: 50%;
  border: 1px solid #d4f9f5b0;
  background: linear-gradient(90deg, #102f4266, #c9fff159, #1c536b77);
  box-shadow:
    2px 0 8px #0007,
    inset 2px 0 3px #fff8;
  transition: left 0.35s ease;
}
.capsule-sum-symbol {
  position: absolute;
  left: 86.5%;
  top: 43%;
  transform: translate(-50%, -50%);
  font:
    500 clamp(10px, 1.4cqw, 16px) Georgia,
    serif;
  color: #fff0cb;
  text-shadow: 0 2px 9px #412404;
}
.capsule-pins {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.capsule-pins path,
.capsule-links path {
  fill: none;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0.8;
}
.capsule-pins circle {
  fill: #f0fff8;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.capsule-links {
  display: block;
  width: 100%;
  height: 16px;
  overflow: visible;
}
.value-capsule-readouts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 6px;
  position: relative;
}
.value-capsule-readouts > div {
  min-width: 0;
  text-align: center;
  padding: 4px 4px;
  border-top: 1px solid #83e9ba77;
  background: linear-gradient(#183a2a40, transparent);
  border-radius: 3px;
}
.value-capsule-readouts > div:nth-child(2) {
  border-color: #99c6ff77;
  background: linear-gradient(#1c304840, transparent);
}
.value-capsule-readouts > div:nth-child(3) {
  border-color: #efd18a77;
  background: linear-gradient(#4c3c1f40, transparent);
}
.value-capsule-readouts dt {
  font-size: 11px;
  color: #b5ccbe;
  line-height: 1.7;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.value-capsule-readouts dt i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: none;
}
.value-capsule-readouts dd {
  font:
    500 clamp(22px, 4.3cqw, 30px) / 1.15 Georgia,
    serif;
  margin: 0;
  overflow-wrap: anywhere;
  color: #a9eacb;
}
.value-capsule-readouts > div:nth-child(2) dd {
  color: #abcfff;
}
.value-capsule-readouts > div:nth-child(3) dd {
  color: #f3d58f;
}
.value-capsule-readouts small {
  display: block;
  font-size: 11px;
  color: #849f8d;
  margin-top: 2px;
}
.capsule-reading-key {
  color: #b4cabc;
  font-size: 11px;
  line-height: 1.8;
  margin: 0 0 4px;
}
.value-bridge figcaption {
  font-size: 10px;
  line-height: 1.8;
  color: #8ca896;
  border-top: 1px solid #3b514333;
  padding-top: 4px;
}
.value-capsule-empty {
  padding: 25px 0;
  color: #96afa0;
  font-size: 12px;
}
@container (max-width:420px) {
  .value-bridge-heading {
    font-size: 11px;
    flex-wrap: wrap;
    gap: 5px;
  }
  .value-capsule-readouts {
    gap: 6px;
  }
  .value-capsule-readouts dt {
    font-size: 10px;
  }
  .value-capsule-readouts dd {
    font-size: 20px;
  }
  .capsule-scale {
    font-size: 11px;
  }
  .capsule-scale-pointer {
    font-size: 11px;
    padding: 3px 5px;
  }
  .capsule-links {
    height: 16px;
  }
  .capsule-reading-key {
    font-size: 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .capsule-fill i,
  .capsule-divider,
  .capsule-scale-pointer {
    transition: none;
  }
}

.value-capsule-readouts > div {
  position: relative;
}
.value-capsule-readouts > div:not(:last-child):after {
  position: absolute;
  right: -11px;
  top: 24px;
  content: '+';
  color: #c1d0c5;
  font:
    18px Georgia,
    serif;
}
.value-capsule-readouts > div:nth-child(2):after {
  content: '=';
}
@container (min-width:700px) {
 .value-capsule-readouts > div { display:grid; grid-template-columns:auto auto; align-items:center; justify-content:center; column-gap:9px; padding-block:3px; }
 .value-capsule-readouts dt { line-height:1.3; }
 .value-capsule-readouts dd { white-space:nowrap; }
 .value-capsule-readouts small { grid-column:1/-1; margin-top:1px; }
 .value-capsule-readouts > div:not(:last-child):after { top:12px; }
}
/* Optical clarity on the existing compact layout. */
.value-capsule-readouts small { color:#adc1b5; }
.value-bridge figcaption { font-size:11px; line-height:1.5; }
.capsule-reading-key { line-height:1.5; }
@container(max-width:420px) {
 .capsule-reading-key { font-size:11px; }
 .value-bridge-heading small { font-size:11px; }
}

/* Vertical compression only: keep all horizontal geometry and anchors. */
.value-bridge { padding-top:8px; padding-bottom:8px; }
.capsule-scale { margin-top:31px; height:15px; margin-bottom:2px; }
.capsule-scale-pointer { padding-top:2px; padding-bottom:2px; bottom:19px; }
.capsule-scale-pointer:after { height:20px; }
.value-capsule { aspect-ratio:1536/270; }
.capsule-links { height:8px; }
.value-capsule-readouts { margin-bottom:3px; }
.value-capsule-readouts > div { padding-top:2px; padding-bottom:2px; }
.capsule-reading-key { margin-bottom:2px; }
.value-bridge figcaption { padding-top:2px; }

/* Blend only the outer scene edges into the host page, without a card fill. */
.value-capsule {
  mask-image: linear-gradient(to right, transparent, #000 2%, #000 98%, transparent), linear-gradient(to bottom, transparent, #000 5%, #000 92%, transparent);
  mask-composite: intersect;
}
</style>
