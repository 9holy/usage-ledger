<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { Search, ChevronRight, Info } from '@lucide/vue'
import UsageCoverageAssembly from './UsageCoverageAssembly.vue'

const { t } = useI18n()
defineProps<{
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
  period: string
  reasons: Array<{ key: string; label: string; count: number }>
  unquoted: number
}>()
const emit = defineEmits<{ reason: [key: string]; unquoted: [] }>()
const count = (n: number) => n.toLocaleString(usageLocale())
</script>
<template>
  <section class="price-coverage">
    <div class="coverage-stage">
      <header class="coverage-panel-header">
        <div>
          <span>{{ t('usageMonitor.text.pricingCoverage') }}</span>
          <h2>{{ t('usageMonitor.text.costEstimationCoverage') }}</h2>
        </div>
        <small>{{ period }}</small>
        <p class="coverage-process-copy">
          {{ t('usageMonitor.text.eachRequestNeedsAnIdentifiedMode') }}<br />{{ t('usageMonitor.text.thenAMatchingCatalogPrice') }}<br />{{ t('usageMonitor.text.onlyWithBothSteps') }}<br />{{ t('usageMonitor.text.canCostBeEstimated') }}
        </p>
      </header>
      <UsageCoverageAssembly
        :rows="rows"
        :total="total"
        :available="available"
        :loaded="loaded"
      />
    </div>
    <p class="coverage-caution">
      <Info :size="14" /><span
        >{{ t('usageMonitor.text.unknownActualModeDoesNotMeanNoCostReference') }}</span
      >
    </p>
    <div class="coverage-reasons">
      <header>
        <h3>{{ t('usageMonitor.text.historicalQuoteRecords') }}</h3>
        <span>{{ t('usageMonitor.text.historicalRecords') }}</span>
      </header>
      <p>{{ t('usageMonitor.text.retainsQuoteHintsSavedWithEachRequestCurrentEstimability') }}</p>
      <div
        v-for="reason in reasons"
        :key="reason.key"
        class="coverage-reason-row"
      >
        <span>{{ reason.label }}</span
        ><strong>{{ count(reason.count) }}<small>{{ t('usageMonitor.text.requests4') }}</small></strong>
        <button
          type="button"
          :aria-label="t('usageMonitor.text.filterQuoteHints') + reason.label"
          @click="emit('reason', reason.key)"
        >
          <Search :size="13" /><span>{{ t('usageMonitor.text.filterRequests') }}</span>
        </button>
      </div>
      <p v-if="!reasons.length" class="coverage-no-reasons">
        {{ loaded ? t('usageMonitor.text.noRegisteredQuoteHintsCurrently') : t('usageMonitor.text.periodStatisticsNotYetLoaded') }}
      </p>
    </div>
    <button
      v-if="loaded && unquoted"
      type="button"
      class="coverage-action"
      @click="emit('unquoted')"
    >
      <span><Search :size="15" />{{ t('usageMonitor.text.viewCurrentlyUnestimatedRequests') }}</span
      ><b>{{ count(unquoted) }}<ChevronRight :size="15" /></b>
    </button>
  </section>
</template>
<style scoped>
.price-coverage {
  container-type: inline-size;
  min-width: 0;
  align-self: start;
  color: #deece3;
}
.coverage-panel-header {
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.coverage-panel-header > div > span {
  font-size: 10px;
  color: #8eae9c;
  letter-spacing: 0.14em;
}
.coverage-panel-header h2 {
  font-family: Georgia, 'Noto Serif CJK SC', 'Songti SC', serif;
  font-size: 20px;
  font-weight: 600;
}
.coverage-caution {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  line-height: 1.8;
  color: #a1b5a9;
  margin: 0 0 10px;
  padding: 6px 12px;
  border-left: 2px solid #657d64;
  background: #46684612;
}
.coverage-caution > svg {
  flex: none;
  margin-top: 3px;
}
.coverage-reasons {
  border-block: 1px solid #344d3d70;
  background: transparent;
  padding: 10px 0 4px;
}
.coverage-reasons > header {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
.coverage-reasons h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
.coverage-reasons > header > span {
  font-size: 11px;
  color: #849b8c;
  letter-spacing: 0.08em;
}
.coverage-reasons > p {
  font-size: 11px;
  color: #8fa797;
  line-height: 1.8;
  margin: 6px 0;
}
.coverage-reason-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 14px;
  align-items: center;
  border-top: 1px solid #3d554532;
  padding: 7px 0;
  font-size: 12px;
}
.coverage-reason-row > span {
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.coverage-reason-row > strong {
  font-size: 19px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  white-space: nowrap;
}
.coverage-reason-row small {
  font-size: 10px;
  color: #8fa797;
  margin-left: 5px;
}
.coverage-reason-row > button {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  border: 0;
  border-radius: 4px;
  padding: 7px 0 7px 9px;
  font-size: 11px;
  color: #aed7c0;
  background: transparent;
  white-space: nowrap;
}
.coverage-reason-row > button:hover,
.coverage-action:hover {
  background: #284735;
  color: #dcffeb;
  border-color: #668d70;
}
.coverage-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 16px;
  border: 1px solid #42694e;
  background: linear-gradient(110deg, #294b3445, #1c32242b);
  border-radius: 8px;
  padding: 9px 15px;
  margin-top: 9px;
  font-size: 12px;
  color: #bfdfc9;
}
.coverage-action > span,
.coverage-action > b {
  display: flex;
  align-items: center;
  gap: 8px;
}
.coverage-action > b {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
button:focus-visible {
  outline: 2px solid #b8dfc7;
  outline-offset: 3px;
}
@container (max-width:480px) {
  .coverage-reasons {
    padding: 16px 0 4px;
  }
  .coverage-reason-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
  .coverage-reason-row > button {
    grid-column: 1/-1;
    justify-self: start;
  }
  .coverage-panel-header {
    align-items: flex-start;
  }
  .coverage-panel-header h2 {
    font-family: Georgia, 'Noto Serif CJK SC', 'Songti SC', serif;
  }
  .coverage-action {
    font-size: 11px;
    padding: 12px;
    gap: 8px;
  }
}

.price-coverage {
  position: relative;
}
.coverage-panel-header {
  position: absolute;
  top: 14px;
  left: 0;
  right: 0;
  display: block;
  z-index: 3;
  pointer-events: none;
  margin: 0;
}
.coverage-panel-header > div > span {
  display: none;
}
.coverage-panel-header h2 {
  font:
    600 clamp(21px, 3.8cqw, 30px) / 1.25 Georgia,
    'Noto Serif CJK SC',
    serif;
  color: #eee4cd;
  margin: 0;
}
.coverage-panel-header > small {
  display: block;
  margin-top: 5px;
  font-size: 11px;
  color: #99afa2;
}
.coverage-process-copy {
  font-size: clamp(9px, 1.5cqw, 16px);
  line-height: 1.7;
  color: #aebdaf;
  margin-top: 9px;
  text-shadow: 0 1px 8px #000;
  max-width: 25%;
}
@container (max-width:480px) {
  .coverage-panel-header {
    position: static;
    margin-bottom: 13px;
  }
  .coverage-panel-header h2 {
    font-size: 21px;
  }
  .coverage-panel-header > small {
    margin-top: 6px;
  }
  .coverage-process-copy {
    display: none;
  }
}

.coverage-panel-header > small {
  position: absolute;
  right: 0;
  top: 0;
}
@container (max-width:480px) {
  .coverage-panel-header > small {
    position: static;
  }
}

.coverage-stage {
  position: relative;
  container-type: inline-size;
  width: 100%;
  margin-inline: auto;
}
@container (min-width:700px) {
 .coverage-reasons { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); column-gap:20px; padding-top:6px; }
 .coverage-reasons > header, .coverage-reasons > p { grid-column:1/-1; }
 .coverage-reason-row { padding-block:3px; }
}
@container(max-width:480px) {
 .coverage-reasons { padding-top:9px; }
 .coverage-reason-row { grid-template-columns:minmax(0,1fr) auto auto; gap:8px; padding-block:5px; }
 .coverage-reason-row > button { grid-column:auto; justify-self:end; min-height:36px; padding:5px 2px; }
 .coverage-reasons > p { margin:4px 0; line-height:1.5; }
}
</style>
