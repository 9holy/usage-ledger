<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import {
  monitorAutomaticPriceSummary,
  monitorCacheCoverage,
  monitorCacheRatio,
  type MonitorTotals
} from '@/api/usageMonitor'
import { usagePercentLabel } from './usageChartPalette'
import UsagePricePrism from './UsagePricePrism.vue'
import UsageCacheWeave from './UsageCacheWeave.vue'
import {
  efficiencyColors,
  type CoveragePart
} from './usageEfficiencyScene'

const { t, locale } = useI18n()

const props = withDefaults(defineProps<{ totals?: MonitorTotals | null; motion?: boolean }>(), {
  motion: true
})
const cachePanel = ref<HTMLElement>()
const cachePanelHeight = ref<number>()
let panelObserver: ResizeObserver | undefined
onMounted(() => {
  if (!cachePanel.value || typeof ResizeObserver === 'undefined') return
  const measure = () => { cachePanelHeight.value = cachePanel.value?.getBoundingClientRect().height }
  panelObserver = new ResizeObserver(measure)
  panelObserver.observe(cachePanel.value)
  measure()
})
onBeforeUnmount(() => panelObserver?.disconnect())
const cacheGraphic = ref<InstanceType<typeof UsageCacheWeave>>()
const ratio = computed(() => {
  const value = props.totals?.cacheHitRatio ?? props.totals?.knownCacheHitRatio
  return value != null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
})
const wideMiss = computed(() => ratio.value != null && ratio.value < 0.8)
const coverage = computed(() => monitorCacheCoverage(props.totals))
const parts = computed<CoveragePart[]>(() => {
  if (!props.totals?.requestCount) return []
  const automatic = monitorAutomaticPriceSummary(props.totals)
  return [
    { state: 'known' as const, count: automatic.coveredRequests },
    { state: 'unknown' as const, count: automatic.unknownRequests },
    { state: 'missing' as const, count: automatic.identifiedUnquotedRequests }
  ].map((row) => ({
    ...row,
    percent: (row.count / props.totals!.requestCount) * 100
  }))
})
const positiveParts = computed(() => parts.value.filter((row) => row.count > 0))
const labels = computed(() => ({ known: t('usageMonitor.text.estimable2'), unknown: t('usageMonitor.text.modeNotRecorded3'), missing: t('usageMonitor.text.priceMissing') }))
const count = (value?: number | null) => (value == null ? t('usageMonitor.text.unavailable') : value.toLocaleString(usageLocale()))
const compact = (value?: number | null) =>
  value == null
    ? t('usageMonitor.text.unavailable')
    : new Intl.NumberFormat(usageLocale(), {
        notation: 'compact',
        maximumFractionDigits: 2
      }).format(value)
const miss = computed(() => (ratio.value == null ? t('usageMonitor.text.unknown') : usagePercentLabel((1 - ratio.value) * 100)))
const cacheDescription = computed(() =>
  ratio.value == null
    ? t('usageMonitor.text.cacheRatioUnknownInputAndCacheFieldsIncomplete')
    : t('usageMonitor.text.cacheHitMiss', { value0: monitorCacheRatio(props.totals), value1: miss.value, value2: coverage.value ? t('usageMonitor.text.label2') + coverage.value : '' })
)
type Anchor = { x: number; y: number }
const cacheAnchors = ref<Record<string, Anchor>>({})
</script>

<template>
  <section
    class="efficiency-band"
    :class="{ 'efficiency-band--en': locale === 'en' }"
    :aria-label="t('usageMonitor.text.cacheEfficiencyCostEstimationCoverage')"
    :style="{
      '--cache-panel-height': cachePanelHeight ? cachePanelHeight + 'px' : undefined,
      '--efficiency-hit': efficiencyColors.hit,
      '--efficiency-miss': efficiencyColors.miss,
      '--efficiency-known': efficiencyColors.known,
      '--efficiency-unknown': efficiencyColors.unknown,
      '--efficiency-missing': efficiencyColors.missing
    }"
  >
    <article ref="cachePanel" class="cache-visual" :class="{ 'has-wide-miss': wideMiss }">
      <header class="efficiency-heading">
        <h2>{{ t('usageMonitor.text.cacheEfficiency') }}</h2>
        <small v-if="coverage">{{ t('usageMonitor.text.requestsWithCompleteFieldsOnly') }}</small>
      </header>
      <div
        class="efficiency-graphic cache-weave"
        :data-hit-ratio="ratio"
        role="img"
        :aria-label="cacheDescription"
        :title="t('usageMonitor.text.arrowsIllustrateInputFlowNotGenerationSpeed')"
      >
        <UsageCacheWeave ref="cacheGraphic" :ratio="ratio" :motion="motion" @anchors="cacheAnchors = $event" />
        <template v-if="ratio != null">
          <svg
            class="cache-leaders leader-lines"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <g v-for="(point, state) in cacheAnchors" :key="state">
              <path
                :d="
                  state === 'hit'
                    ? `M ${point.x} ${point.y} L 28.7 19.5 H 30.9`
                    : `M ${point.x} ${point.y} L 57 ${wideMiss ? 106 : 80.5} H 58.4`
                "
              />
              <ellipse :cx="point.x" :cy="point.y" rx=".35" ry=".98" />
              <ellipse :cx="state === 'hit' ? 30.9 : 58.4" :cy="state === 'hit' ? 19.5 : wideMiss ? 106 : 80.5" rx=".35" ry=".98" />
            </g>
          </svg>
          <div class="cache-split-legend">
            <div
              class="cache-readout cache-hit"
              tabindex="0"
              :title="cacheDescription"
              @mouseenter="cacheGraphic?.focus('hit')"
              @mouseleave="cacheGraphic?.focus(null)"
              @focus="cacheGraphic?.focus('hit')"
              @blur="cacheGraphic?.focus(null)"
            >
              <strong>{{ monitorCacheRatio(totals) }}</strong
              ><span>{{ t('usageMonitor.text.cacheHit2') }}</span><small>{{ t('usageMonitor.text.readingCachedContent') }}</small>
            </div>
            <div
              class="cache-readout cache-miss"
              tabindex="0"
              :title="t('usageMonitor.text.cacheMiss') + miss"
              @mouseenter="cacheGraphic?.focus('miss')"
              @mouseleave="cacheGraphic?.focus(null)"
              @focus="cacheGraphic?.focus('miss')"
              @blur="cacheGraphic?.focus(null)"
            >
              <strong>{{ miss }}</strong
              ><span>{{ t('usageMonitor.text.cacheMiss2') }}</span><small>{{ t('usageMonitor.text.processingNewContent') }}</small>
            </div>
          </div>
        </template>
        <p v-else class="efficiency-empty">
          {{ totals ? t('usageMonitor.text.inputAndCacheFieldsIncompleteHitRatioUnavailable') : t('usageMonitor.text.cacheStatisticsNotYetAvailable') }}
        </p>
        <span class="cache-endpoint cache-entry">{{ t('usageMonitor.text.inputContent') }}</span
        ><span class="cache-endpoint cache-exit">{{ t('usageMonitor.text.sentToModel') }}</span><span class="cache-junction">{{ t('usageMonitor.text.cacheMatch') }}</span>
      </div>
      <dl class="cache-token-ledger">
        <div>
          <dt>{{ t('usageMonitor.text.cacheRead') }}</dt>
          <dd :title="count(totals?.cacheReadTokens) + ' Token'">
            {{ compact(totals?.cacheReadTokens) }}<small v-if="totals?.cacheReadTokens != null">Token</small>
          </dd>
        </div>
        <div>
          <dt>{{ t('usageMonitor.text.cacheWrite') }}</dt>
          <dd :title="count(totals?.cacheWriteTokens) + ' Token'">
            {{ compact(totals?.cacheWriteTokens) }}
          </dd>
        </div>
      </dl>
      <p class="efficiency-note">
        {{ coverage || t('usageMonitor.text.cacheReadsInputTokensIncludingCache') }}
      </p>
    </article>

    <article class="pricing-visual">
      <header class="efficiency-heading"><h2>{{ t('usageMonitor.text.costEstimationCoverage') }}</h2><small>{{ t('usageMonitor.text.all') }} {{ count(totals?.requestCount) }} {{ t('usageMonitor.text.requests4') }}</small></header>
      <UsagePricePrism v-if="positiveParts.length" :parts="parts" :total="totals?.requestCount" compact />
      <div v-else class="efficiency-graphic">
        <p class="efficiency-empty">
          {{ totals ? t('usageMonitor.text.noRequestsInTheSelectedPeriod') : t('usageMonitor.text.costStatisticsNotYetAvailable') }}
        </p>
      </div>
      <div v-if="parts.some((item) => item.count === 0)" class="prism-zero-states">
        <span v-for="row in parts.filter((item) => item.count === 0)" :key="row.state" :data-state="row.state"
          ><i />{{ labels[row.state] }} <b>0</b></span
        >
      </div>
      <p class="efficiency-note">{{ t('usageMonitor.text.shapesAreSchematicSegmentsLabelsShowExactSharesEach') }}</p>
    </article>
  </section>
</template>

<style scoped>
.efficiency-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  padding: 12px 0 10px;
  border-bottom: 1px solid var(--cost-line, #304137);
  letter-spacing: 0;
  color: #e8eee9;
  background:
    radial-gradient(ellipse at 26% 50%, #12332a45, transparent 45%),
    radial-gradient(ellipse at 78% 45%, #11302530, transparent 45%), #07110c;
}
.cache-visual,
.pricing-visual {
  min-width: 0;
  width: 100%;
  margin-inline: auto;
}
.cache-visual {
  container-type: inline-size;
  background: transparent;
}
.cache-visual .efficiency-heading h2 {
  font-size: clamp(24px, 5.3cqw, 40px);
  margin-left: 0;
  font-weight: 800;
  transform: skewX(-5deg);
  transform-origin: left center;
  text-shadow: 0 1px 0 #73817b, 0 0 4px #ffffff33, 0 2px 3px #0009;
}
.efficiency-band--en .cache-visual .efficiency-heading h2 {
  max-width: 28%;
  font-size: 24px;
  line-height: 1.15;
}
.pricing-visual {
  border-left: 0;
  padding-left: 0;
}
.efficiency-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  min-height: 25px;
}
.efficiency-heading h2 {
  font-size: 26px;
  font-weight: 650;
  margin: 0;
  line-height: 1.5;
}
.efficiency-heading > small {
  font-size: 11px;
  color: #a2b5aa;
  text-align: right;
}
.efficiency-graphic {
  position: relative;
  width: 100%;
  aspect-ratio: 1.95;
  isolation: isolate;
}
.efficiency-canvas {
  position: absolute;
  inset: 0;
}
.efficiency-canvas :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: 0;
}
.leader-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.leader-lines path {
  fill: none;
  stroke: #b4c5bb;
  stroke-opacity: 0.9;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.leader-lines ellipse {
  fill: #e9f3ed;
}
.cache-readout {
  position: absolute;
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 0;
  font-variant-numeric: tabular-nums;
  outline-offset: 5px;
  border-radius: 2px;
  max-width: 40%;
  min-width: 12cqw;
}
.cache-readout strong {
  font-size: clamp(26px, 4.6cqw, 52px);
  font-weight: 650;
  line-height: 1.05;
  overflow-wrap: anywhere;
}
.cache-readout > span {
  width: 100%;
  padding-bottom: 2px;
  border-bottom: 1px solid #b4cbc044;
  font-size: clamp(12px, 2.3cqw, 22px);
  font-weight: 600;
  line-height: 1.2;
  color: #e7f4ed;
}
.cache-hit {
  min-width: 14cqw;
  left: 32.2%;
  top: 0;
  color: var(--efficiency-hit);
}
.cache-miss > span { font-size: clamp(12px, 2.1cqw, 20px); }
.cache-miss {
  left: 60%;
  top: 75%;
  color: var(--efficiency-miss);
}
.cache-endpoint {
  position: absolute;
  top: 42%;
  font-size: 13px;
  line-height: 1.4;
  color: #d5e5db;
  max-width: 58px;
  text-align: center;
}
.efficiency-band--en .cache-endpoint {
  max-width: none;
  white-space: nowrap;
}
.cache-entry {
  left: 0;
  transform: translateY(-50%);
}
.cache-exit {
  right: 0;
  transform: translateY(-50%);
}
.cache-junction {
  position: absolute;
  left: 8.5%;
  top: 61%;
  font-size: 13px;
  color: #d5e5db;
}
.cache-junction::before {
  content: '';
  position: absolute;
  left: 55%;
  top: -23px;
  width: 1px;
  height: 21px;
  background: #c9ded2;
  transform: rotate(20deg);
}
.cache-junction::after {
  content: '';
  position: absolute;
  left: calc(55% + 2px);
  top: -26px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #e3f4eb;
}
.cache-token-ledger {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 22px;
  border-top: 1px solid var(--cost-line, #304137);
  padding-top: 12px;
  margin: 0;
}
.cache-token-ledger > div + div {
  border-left: 1px solid var(--cost-line, #304137);
  padding-left: 24px;
}
.cache-token-ledger > div:first-child dd {
  display: inline-block;
  background: linear-gradient(90deg, #64e8c0, #dffff4 48%, #fff);
  background-clip: text;
  color: transparent;
}
.cache-token-ledger dt {
  font-size: 12px;
  color: #afc0b5;
  margin-bottom: 0;
}
.cache-token-ledger dd {
  margin: 0;
  font-size: clamp(28px, 4.8cqw, 44px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  line-height: 1;
}
.cache-token-ledger dd small {
  font-size: clamp(11px, 1.8cqw, 16px);
  font-weight: 400;
  color: #afc0b5;
  margin-left: 8px;
}
.efficiency-note {
  font-size: 11px;
  line-height: 1.7;
  color: #aebeb4;
  margin: 8px 0 0;
}
.scene-error {
  font-size: 12px;
  color: #e9bb79;
  margin: 7px 0;
}
.prism-zero-states {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px 24px;
  min-height: 32px;
  align-items: center;
  padding-top: 6px;
  font-size: 12px;
  color: #9caf9f;
  margin-top: 12px;
}
.prism-zero-states > span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.prism-zero-states i {
  width: 9px;
  height: 9px;
  border: 1px solid #72877a;
  border-radius: 50%;
  box-sizing: border-box;
}
.prism-zero-states b {
  font-size: 16px;
  font-weight: 500;
}
.pricing-visual > .efficiency-note {
  margin-top: 6px;
  text-align: center;
}
.efficiency-empty {
  position: absolute;
  left: 15%;
  right: 15%;
  top: 33%;
  text-align: center;
  line-height: 1.8;
  font-size: 13px;
  color: #afc1b5;
}
.cache-readout:focus-visible {
  outline: 1px solid #b9dfce;
}
.cache-readout small {
  font-size: clamp(10px, 1.5cqw, 14px);
  line-height: 1.6;
  color: #d0dfd7;
  padding-top: 0;
  margin-top: 0;
  white-space: nowrap;
}
.cache-hit strong {
  background: linear-gradient(#afffec, #40d7b3);
  background-clip: text;
  color: transparent;
}
.cache-miss strong {
  color: #79bdff;
  font-size: clamp(20px, 3.4cqw, 40px);
}
.cache-miss small {
  margin-top: 3px;
}
.cache-visual.has-wide-miss .cache-miss {
  top: calc(100% + 4px);
}
.cache-visual.has-wide-miss .cache-token-ledger {
  margin-top: 80px;
}
/* Keep the reference composition: title and hit metric share the top plane. */
.cache-visual > .efficiency-heading {
  position: relative;
  z-index: 2;
  pointer-events: none;
}
.cache-weave {
  aspect-ratio: 2.8;
  margin-top: -51px;
}
.cache-hit {
  top: 5%;
}
.cache-token-ledger {
  grid-template-columns: 1fr 1fr;
  text-align: center;
  gap: 0;
}
.cache-token-ledger > div + div {
  padding-left: 0;
}
@container (max-width: 600px) {
  .cache-weave { margin-bottom: 12px; }
}
@media (max-width: 1100px) {
  .cache-visual {
    max-width: none;
    width: 100%;
    margin-inline: auto;
  }
  .cache-visual .cache-weave {
    aspect-ratio: 2.8;
  }
  .efficiency-heading {
    max-width: none;
    margin-inline: auto;
  }
  .efficiency-band {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .pricing-visual {
    padding-left: 0;
    border-left: 0;
    border-top: 1px solid var(--cost-line, #304137);
    padding-top: 16px;
  }
  .efficiency-graphic {
    max-width: none;
    margin-inline: auto;
    aspect-ratio: 1.95;
  }
  .cache-token-ledger {
    max-width: none;
    margin-inline: auto;
  }
}
@media (max-width: 500px) {
  .efficiency-band {
    padding-top: 16px;
  }
  .efficiency-graphic {
    aspect-ratio: 1.85;
  }
  .efficiency-heading {
    align-items: flex-start;
  }
  .efficiency-heading h2 {
    font-size: 16px;
  }
  .efficiency-heading > small {
    font-size: 10px;
  }
  .cache-readout strong {
    font-size: 25px;
  }
  .cache-visual.has-wide-miss .cache-miss {
    top: 0;
  }
  .cache-visual.has-wide-miss .cache-token-ledger {
    margin-top: 0;
  }
  .cache-visual .efficiency-heading h2 {
    font-size: 16px;
  }
  .efficiency-band--en .cache-visual .efficiency-heading h2 {
    max-width: none;
    font-size: 16px;
  }
  .cache-readout > span {
  width: 100%;
  padding-bottom: 2px;
  border-bottom: 1px solid #b4cbc044;
    font-size: 12px;
  }
  .cache-weave {
    aspect-ratio: auto;
    height: 220px;
    margin-top: 0;
  }
  .cache-miss {
    left: auto;
    right: 6%;
    top: 0;
  }
  .cache-leaders {
    display: none;
  }
  .cache-token-ledger dd {
    font-size: 23px;
  }
  .cache-endpoint,
  .cache-junction {
    font-size: 9px;
  }
  .cache-endpoint {
    top: calc(50% - 22px);
  }
  .cache-entry {
    max-width: 24px;
  }
  .cache-exit {
    max-width: 24px;
  }
  .cache-junction {
    left: 9%;
    top: 62%;
  }
  .cache-junction::before,
  .cache-junction::after {
    display: none;
  }
  .efficiency-note {
    font-size: 10px;
  }
  .cache-readout small {
    font-size: 10px;
    margin-top: 3px;
  }
  .cache-hit {
    left: 12%;
    top: 0;
  }
}
/* Do not stretch the cache footer to match the neighbouring illustration. */
.efficiency-band { align-items:start; background:transparent; border-bottom:0; }
.cache-visual, .pricing-visual { border-bottom:1px solid var(--cost-line, #304137); padding-bottom:6px; }
.cache-token-ledger { padding-top:6px; }
.cache-token-ledger > div { display:flex; justify-content:center; align-items:baseline; gap:10px; }
.cache-token-ledger dd { font-size:25px; line-height:1.2; }
.cache-token-ledger dd small { font-size:11px; }
.efficiency-note { margin-top:4px; line-height:1.5; }
.pricing-visual { padding-bottom:0; }
@media(max-width:500px) {
 .cache-token-ledger > div { gap:6px; flex-wrap:wrap; }
 .cache-token-ledger dd { font-size:22px; }
}
@media (min-width:1101px) {
 .pricing-visual {
   box-sizing:border-box;
   height:var(--cache-panel-height, auto);
   display:flex;
   flex-direction:column;
   gap:4px;
 }
 .pricing-visual > .efficiency-heading,
 .pricing-visual > .efficiency-note,
 .pricing-visual > .prism-zero-states { flex:none; }
 .pricing-visual > :deep(.reference-prism) { flex:1; min-height:0; }
 .pricing-visual > :deep(.reference-prism > svg) { width:100%; height:100%; }
 .pricing-visual .efficiency-heading h2 { font-size:24px; }
 .pricing-visual .efficiency-note { margin:0; }
}
@media(max-width:500px) {
 .cache-weave { height:180px; }
 .cache-weave :deep(.cache-illustration) { transform:translateY(14px); }
 .cache-junction { transform:translateY(14px); }
 .cache-readout small, .cache-endpoint, .cache-junction, .efficiency-note { font-size:11px; }
 .cache-token-ledger { padding-top:5px; }
}
</style>
