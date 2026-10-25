<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import scenery from '@/assets/usage/scenes/coverage-original-clean.webp'
import flowIncoming from '@/assets/usage/scenes/coverage-flow-incoming.webp'
import flowIdentified from '@/assets/usage/scenes/coverage-flow-identified.webp'
import flowPriced from '@/assets/usage/scenes/coverage-flow-priced.webp'
import flowUnknown from '@/assets/usage/scenes/coverage-flow-unknown.webp'
import flowMissing from '@/assets/usage/scenes/coverage-flow-missing.webp'
import { usagePercentLabel } from './usageChartPalette'

const { t } = useI18n()
const flowImages: Record<string, string> = {
  incoming: flowIncoming,
  identified: flowIdentified,
  priced: flowPriced,
  unknown: flowUnknown,
  missing: flowMissing,
}
const props = defineProps<{
  rows: Array<{
    state: string
    label: string
    count: number
    percent: number
    color: string
  }>
  total?: number
  available: number | null
  loaded: boolean
}>()
const known = computed(() => props.rows.find((row) => row.state === 'known'))
const unknown = computed(() =>
  props.rows.find((row) => row.state === 'unknown'),
)
const missing = computed(() =>
  props.rows.find((row) => row.state === 'missing'),
)
const matchedMode = computed(() =>
  known.value && missing.value ? known.value.count + missing.value.count : null,
)
const hasData = computed(
  () => !!props.total && !!known.value && !!unknown.value && !!missing.value,
)
const count = (n: number) => n.toLocaleString(usageLocale())
const compact = (n: number) =>
  new Intl.NumberFormat(usageLocale(), {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n)
const paths = computed(() => [
  {
    key: 'incoming',
    show: !!props.total,
  },
  {
    key: 'identified',
    show: !!matchedMode.value,
  },
  {
    key: 'priced',
    show: !!known.value?.count,
  },
  {
    key: 'unknown',
    show: !!unknown.value?.count,
  },
  {
    key: 'missing',
    show: !!missing.value?.count,
  },
])
</script>
<template>
  <div class="coverage-instrument">
    <template v-if="hasData">
      <div class="coverage-scene-frame">
        <div
          class="coverage-landscape"
          role="img"
          :aria-label="t('usageMonitor.text.requestsIdentifiedModesWithPricingEvidence', { value0: count(total!), value1: count(matchedMode!), value2: count(known!.count) })"
        >
          <img :src="scenery" alt="" />
          <img
            v-for="path in paths.filter((p) => p.show)"
            :key="path.key"
            class="coverage-flow-layer"
            :data-flow="path.key"
            :src="flowImages[path.key]"
            alt=""
          />

          <div class="scene-count incoming">
            <strong :title="count(total!) + t('usageMonitor.text.requests7')">{{ compact(total!) }}</strong
            ><span>{{ t('usageMonitor.text.requests8') }}</span>
          </div>
          <div class="scene-count identified stage-count">
            <strong :title="count(matchedMode!) + t('usageMonitor.text.requests7')">{{
              compact(matchedMode!)
            }}</strong
            ><span>{{ t('usageMonitor.text.identifiedModes') }}</span>
          </div>
          <div class="scene-count priced stage-count">
            <strong :title="count(known!.count) + t('usageMonitor.text.requests7')">{{
              compact(known!.count)
            }}</strong
            ><span>{{ t('usageMonitor.text.estimable') }}</span><b>{{ usagePercentLabel(known!.percent) }}</b>
          </div>
          <span class="gate-label first">{{ t('usageMonitor.text.modeIdentification') }}</span
          ><span class="gate-label second">{{ t('usageMonitor.text.unitPriceMatch') }}</span>
        <div class="coverage-readouts">
          <div
            class="coverage-gap"
            data-state="unknown"
            :data-count="unknown!.count"
          >
            <span>{{ t('usageMonitor.text.modeGap') }}</span
            ><strong :title="count(unknown!.count) + t('usageMonitor.text.requests7')"
              >{{ compact(unknown!.count) }}<small>{{ t('usageMonitor.text.requests4') }}</small></strong
            >
            <p :data-label="t('usageMonitor.format.missingModeInfo')">{{ usagePercentLabel(unknown!.percent) }} {{ t('usageMonitor.text.missingModeEvidence') }}</p>
          </div>
          <div
            class="coverage-gap"
            data-state="missing"
            :data-count="missing!.count"
          >
            <span>{{ t('usageMonitor.text.priceGap') }}</span
            ><strong :title="count(missing!.count) + t('usageMonitor.text.requests7')"
              >{{ compact(missing!.count) }}<small>{{ t('usageMonitor.text.requests4') }}</small></strong
            >
            <p :data-label="t('usageMonitor.format.missingUnitPrice')">
              {{ usagePercentLabel(missing!.percent) }} {{ t('usageMonitor.text.modeIdentifiedButMatchingCatalogPriceMissing') }}
            </p>
          </div>
        </div>
        </div>
        <p class="coverage-route-note">{{ t('usageMonitor.text.referenceResultsAreNotPaidBills') }}</p>
      </div>
      <div
        class="coverage-result"
        :class="{ 'no-eligible': !known!.count }"
        data-state="known"
        :data-count="known!.count"
        :data-percent="known!.percent"
      >
        <span>{{
          known!.count ? t('usageMonitor.text.pricingEvidenceAvailable') : t('usageMonitor.text.noRequestHasCompletePricingEvidenceYet')
        }}</span
        ><b>{{ usagePercentLabel(known!.percent) }}</b>
        <div class="coverage-result-meter">
          <i :style="{ width: known!.percent + '%' }" />
        </div>
      </div>
    </template>
    <p v-else class="coverage-empty">
      {{
        loaded && total === 0
          ? t('usageMonitor.text.noRequestsInTheSelectedPeriod')
          : t('usageMonitor.text.completeCostCoverageStatisticsNotYetAvailable')
      }}
    </p>
  </div>
</template>
<style scoped>

.coverage-instrument {
  container-type: inline-size;
  color: #e4eee5;
  min-width: 0;
  background: transparent;
  border: 0;
  overflow: hidden;
}
.coverage-landscape {
  position: relative;
  isolation: isolate;
}
.coverage-landscape > img,
.coverage-landscape > svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.coverage-landscape > img {
  object-fit: cover;
}
.scene-count {
  position: absolute;
  z-index: 1;
  text-shadow:
    0 2px 9px #000,
    0 0 18px #000;
  display: flex;
  flex-direction: column;
}
.scene-count strong {
  font:
    500 clamp(20px, 4.8cqw, 42px) / 1.1 Georgia,
    serif;
  overflow-wrap: anywhere;
}
.scene-count span {
  margin-top: 5px;
  color: #d8e4d9;
}
.incoming {
  top: 32%;
  left: 4%;
}
.identified {
  top: 22%;
  left: 43%;
  color: #b7f2d8;
}
.identified strong {
  font-size: clamp(17px, 3.5cqw, 44px);
}
.priced {
  top: 7%;
  right: 4%;
  text-align: right;
  color: #ffedbe;
}
.priced b {
  font:
    500 clamp(19px, 4cqw, 48px) / 1.2 Georgia,
    serif;
  margin-top: 5px;
}
.gate-label {
  position: absolute;
  z-index: 1;
  color: #e5ebd9;
  text-shadow: 0 2px 8px #000;
  padding: 2px 5px;
  border-radius: 3px;
}
.coverage-readouts {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.coverage-gap {
  min-width: 0;
  border-left: 1px solid #72bcd988;
}
.coverage-gap strong {
  font:
    500 28px/1.4 Georgia,
    serif;
  display: block;
  color: #bce8fc;
  overflow-wrap: anywhere;
}
.coverage-gap small {
  font: 11px sans-serif;
  margin-left: 5px;
}
.coverage-gap p {
  color: #8ca8a6;
}
.coverage-result {
  margin: 0 22px;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #b5d7c1;
}
.coverage-result b {
  font-size: 16px;
  color: #e3c98d;
}
.coverage-result-meter {
  height: 4px;
  flex-basis: 100%;
  border-radius: 4px;
  overflow: hidden;
  background: #31483d;
}
.coverage-result-meter i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #7bddc1, #ead293);
}
.coverage-route-note {
  line-height: 1.8;
  margin: 0;
}
.coverage-empty {
  padding: 32px 0;
  font-size: 12px;
  color: #9eb6a8;
}
.no-eligible {
  color: #a3adb8;
}
@container (max-width:400px) {
  .coverage-landscape {
    aspect-ratio: 1.65;
  }
  .coverage-landscape > img {
    object-fit: fill;
  }
  .coverage-readouts {
    gap: 13px;
    padding-inline: 0;
  }
  .coverage-gap {
    padding-left: 9px;
  }
  .coverage-gap strong {
    font-size: 25px;
  }
  .coverage-result {
    margin-inline: 0;
  }
  .coverage-route-note {
    padding-inline: 0;
  }
  .identified {
    top: 15%;
    left: 41%;
  }
  .gate-label {
    top: 33%;
  }
}

.coverage-instrument {
  position: relative;
  border-radius: 4px;
  margin-bottom: 12px;
}
.scene-count.incoming {
  top: 47%;
}
.scene-count.identified {
  top: 36%;
  left: 43%;
}
.scene-count.priced {
  top: 19%;
  right: 4%;
}
.scene-count strong {
  font-size: clamp(21px, 4.6cqw, 64px);
}
.scene-count.priced strong {
  display: inline;
}
.scene-count span {
  font-size: clamp(10px, 1.6cqw, 18px);
}
.gate-label {
  top: 31%;
  font-size: clamp(10px, 1.8cqw, 22px);
  background: transparent;
}
.coverage-readouts {
  position: absolute;
  right: 3%;
  padding: 0;
  gap: 18px;
  z-index: 2;
}
.coverage-gap {
  padding-left: 6px;
  border-color: #b9efff99;
  text-shadow: 0 1px 8px #000;
}
.coverage-gap > span {
  color: #d0ecf3;
}
.coverage-gap strong {
  font-size: clamp(20px, 3.4cqw, 44px);
  line-height: 1.2;
}
.coverage-gap p {
  font-size: 0;
  line-height: 1.3;
}
.coverage-gap:first-child p:after {
  content: attr(data-label);
  font-size: 11px;
  color: #aec2bc;
}
.coverage-gap:last-child p:after {
  content: attr(data-label);
  font-size: 11px;
  color: #aec2bc;
}
.coverage-result {
  display: none;
}
.coverage-result.no-eligible {
  display: block;
}
.coverage-result-meter {
  display: none;
}
.coverage-route-note {
  position: absolute;
  left: 4%;
  bottom: 3%;
  padding: 0;
  font-size: 11px;
  color: #9eb2a9;
  z-index: 2;
}
@container (max-width:480px) {
  .coverage-readouts {
    position: relative;
    right: auto;
    padding: 5px 14px 18px;
    gap: 18px;
  }
  .coverage-route-note {
    position: static;
    padding: 0 14px 12px;
    max-width: none;
  }
  .scene-count.incoming {
    top: 39%;
  }
  .scene-count.priced {
    top: 8%;
  }
  .coverage-gap p:after {
    font-size: 10px !important;
  }
  .coverage-gap strong {
    font-size: 25px;
  }
}

@container (max-width:480px) {
  .scene-count.identified {
    top: 8%;
    left: 40%;
  }
  .scene-count.identified span {
    font-size: 11px;
  }
}

.coverage-landscape {
  aspect-ratio: 655/299;
}
.scene-count.incoming {
  left: 5%;
}
.gate-label.first {
  left: 27.8%;
  top: 31.6%;
  transform: translate(-50%, -50%) rotate(-8deg);
}
.gate-label.second {
  left: 60.5%;
  top: 32.6%;
  transform: translate(-50%, -50%);
}
.coverage-readouts {
  left: 45%;
  bottom: 3%;
}
.coverage-route-note {
  max-width: 36%;
}
.coverage-flow-layer {
  pointer-events: none;
}
@container (max-width:480px) {
  .coverage-landscape {
    aspect-ratio: 1.65;
  }
  .coverage-readouts {
    left: auto;
    bottom: auto;
  }
}

.coverage-scene-frame {
  position: relative;
  min-width: 0;
}
.coverage-result.no-eligible {
  margin: 0 16px 12px;
  padding: 8px 0;
  border-top: 1px solid #3d55454a;
  line-height: 1.6;
}
.coverage-result.no-eligible > b {
  display: none;
}

.gate-label {
  white-space: nowrap;
  line-height: 1;
  padding: 0;
  transform-origin: center;
}
.coverage-gap > span {
  font-size: clamp(11px, 1.6cqw, 18px);
}
.coverage-gap p:after {
  font-size: clamp(9px, 1.4cqw, 15px);
}

@container(max-width:480px) {
 .coverage-route-note { max-width:none; line-height:1.5; }
 .coverage-readouts { padding-bottom:10px; }
 .coverage-gap p:after { font-size:11px !important; }
}

/* Labels sit directly on the restored lintel, without a dark blur halo. */
.gate-label { background:none; box-shadow:none; text-shadow:none; }
@container(max-width:480px) {
 .coverage-readouts { position:absolute; left:45%; right:2%; bottom:5%; padding:0; gap:10px; }
 .coverage-gap { padding-left:4px; }
 .coverage-gap > span { font-size:11px; }
 .coverage-gap strong { font-size:21px; line-height:1.1; }
 .coverage-gap p { margin:2px 0 0; }
 .coverage-gap p:after { font-size:11px !important; }
 .coverage-route-note { padding:3px 12px 7px; }
}

/* Bind readouts to the scene coordinates, independent of notes and warning rows. */
.coverage-readouts { top:78%; bottom:auto; }
@container(max-width:480px) {
 .coverage-readouts { top:78%; bottom:auto; }
}

/* Blend only the outer scene edges into the host page, without a card fill. */
.coverage-landscape {
  mask-image: linear-gradient(to right, transparent, #000 2%, #000 98%, transparent), linear-gradient(to bottom, transparent, #000 5%, #000 92%, transparent);
  mask-composite: intersect;
}
</style>
