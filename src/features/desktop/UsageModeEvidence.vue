<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import UsageEvidenceRibbon from './UsageEvidenceRibbon.vue'
import { usagePercentLabel } from './usageChartPalette'

const { t } = useI18n()
const props = defineProps<{
  rows: Array<{
    label: string
    counts?: Record<string, number> | null
    segments: Array<{
      key: string
      label: string
      count: number
      percent: number
      color: string
    }>
  }>
  total?: number
}>()
const number = (n: number) => n.toLocaleString(usageLocale())
const visibleCount = (n: number) =>
  n >= 10000
    ? new Intl.NumberFormat(usageLocale(), {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(n)
    : number(n)
const modes = computed(() => {
  const seen = new Map<string, { key: string; label: string; color: string }>()
  for (const row of props.rows)
    for (const part of row.segments)
      if (!seen.has(part.key))
        seen.set(part.key, {
          key: part.key,
          label: part.key === 'unknown' ? t('usageMonitor.text.notReported') : part.label,
          color: part.key === 'unknown' ? '#a4afbd' : part.color,
        })
  return [...seen.values()]
})
const hasRecords = computed(
  () => !!props.total && props.rows.some((row) => row.counts),
)
function cell(row: (typeof props.rows)[number], key: string) {
  if (!row.counts) return null
  const count = row.counts[key] ?? 0
  return { count, percent: props.total ? (count / props.total) * 100 : 0 }
}
function parts(row: (typeof props.rows)[number]) {
  return modes.value.map((mode) => ({
    count: cell(row, mode.key)?.count ?? 0,
    color: mode.color,
  }))
}
function known(row: (typeof props.rows)[number]) {
  return row.counts
    ? Object.entries(row.counts).reduce(
        (n, [key, value]) => n + (key === 'unknown' ? 0 : value),
        0,
      )
    : null
}
const confirmed = computed(() =>
  props.rows.find((row) => row.label === t('usageMonitor.text.responseConfirmation')),
)
const confirmedCount = computed(() =>
  confirmed.value ? known(confirmed.value) : null,
)
const unreported = computed(() =>
  confirmed.value?.counts ? (confirmed.value.counts.unknown ?? 0) : null,
)
const confirmedPercent = computed(() =>
  confirmedCount.value != null && props.total
    ? usagePercentLabel((confirmedCount.value / props.total) * 100)
    : '—',
)
const meaning = (label: string) =>
  label === t('usageMonitor.text.requestSettings')
    ? t('usageMonitor.text.settingsExpressRequestIntentTheyDoNotGuaranteeThe')
    : label === t('usageMonitor.text.responseConfirmation')
      ? t('usageMonitor.text.onlyTheServiceResponseCanConfirmTheActualProcessing')
      : t('usageMonitor.text.prefersResponseReceiptsThenChecksValidRuntimeRecordsAnd')
const subtitle = (label: string) =>
  label === t('usageMonitor.text.requestSettings')
    ? t('usageMonitor.text.intentAtSendTime')
    : label === t('usageMonitor.text.responseConfirmation')
      ? t('usageMonitor.text.serviceResponseRecord')
      : t('usageMonitor.text.identifiedUsingAvailableEvidence')
</script>
<template>
  <div class="mode-evidence-container">
    <section class="mode-evidence" :aria-label="t('usageMonitor.text.billingModeRecords')">
      <header class="evidence-heading">
        <div>
          <span class="eyebrow">{{ t('usageMonitor.text.usageAnalysisModeEvidence') }}</span>
          <h2>{{ t('usageMonitor.text.billingModeRecords') }}</h2>
          <p v-if="total != null">
            {{ t('usageMonitor.text.sameSetOf') }} <b>{{ number(total) }}</b> {{ t('usageMonitor.text.requests9') }}
            {{ rows.length }} {{ t('usageMonitor.text.views') }}
          </p>
          <p v-else>{{ t('usageMonitor.text.periodRequestCountNotYetAvailable') }}</p>
        </div>
        <div class="evidence-hero">
          <div>
            <strong>{{
              confirmedCount == null ? '—' : number(confirmedCount)
            }}</strong
            ><span> / {{ total == null ? '—' : number(total) }}</span>
          </div>
          <p>
            {{ t('usageMonitor.text.responseConfirmed') }} <b>{{ confirmedPercent }}</b>
          </p>
        </div>
      </header>
      <div class="evidence-legend">
        <span v-for="mode in modes" :key="mode.key"
          ><i :style="{ background: mode.color }" />{{ mode.label }}</span
        >
      </div>
      <div v-if="hasRecords" class="evidence-ribbons">
        <article
          v-for="row in rows"
          :key="row.label"
          class="evidence-source"
          :class="{ 'is-confirmed': row.label === t('usageMonitor.text.responseConfirmation') }"
        >
          <div class="source-caption">
            <h3>{{ row.label }}</h3>
            <p>{{ subtitle(row.label) }}</p>
            <span class="source-stat" :title="meaning(row.label)"
              ><strong>{{
                row.counts && total
                  ? usagePercentLabel(((known(row) ?? 0) / total) * 100)
                  : t('usageMonitor.text.unavailable')
              }}</strong>
              {{
                row.label === t('usageMonitor.text.autoDetected')
                  ? t('usageMonitor.text.identified')
                  : row.label === t('usageMonitor.text.responseConfirmation')
                    ? t('usageMonitor.text.confirmed')
                    : t('usageMonitor.text.recorded2')
              }}</span
            >
          </div>
          <div class="source-visual">
            <UsageEvidenceRibbon
              v-if="row.counts"
              :parts="parts(row)"
              :total="total!"
              :label="
                row.label +
                t('usageMonitor.text.label') +
                modes
                  .map(
                    (mode) =>
                      mode.label +
                      ' ' +
                      number(cell(row, mode.key)?.count ?? 0) +
                      t('usageMonitor.text.requests7'),
                  )
                  .join(t('usageMonitor.text.label9'))
              "
            />
            <p v-else class="source-missing">{{ t('usageMonitor.text.noModeRecordsAvailableForThisSourceYet') }}</p>
            <dl class="evidence-values" :style="{ '--modes': modes.length }">
              <div
                v-for="mode in modes"
                :key="mode.key"
                class="evidence-cell"
                :data-state="mode.key"
                :data-count="cell(row, mode.key)?.count"
                :data-percent="cell(row, mode.key)?.percent"
                :title="
                  cell(row, mode.key)
                    ? number(cell(row, mode.key)!.count) + t('usageMonitor.text.requests7')
                    : t('usageMonitor.text.unavailable')
                "
                :style="{ '--tone': mode.color }"
              >
                <dt><i />{{ mode.label }}</dt>
                <dd>
                  <strong>{{
                    cell(row, mode.key)
                      ? visibleCount(cell(row, mode.key)!.count)
                      : '—'
                  }}</strong
                  ><span>{{
                    cell(row, mode.key)
                      ? usagePercentLabel(cell(row, mode.key)!.percent)
                      : t('usageMonitor.text.unavailable')
                  }}</span>
                </dd>
              </div>
            </dl>
          </div>
        </article>
      </div>
      <p v-else class="evidence-placeholder">
        {{
          total === 0
            ? t('usageMonitor.text.noRequestsInTheSelectedPeriod')
            : total
              ? t('usageMonitor.text.sourceHasNotProvidedModeRecordsYet')
              : t('usageMonitor.text.modeStatisticsNotYetAvailable')
        }}
      </p>
      <footer class="evidence-note">
        <div v-if="unreported != null && total">
          <strong>{{ number(unreported) }}</strong
          ><span>{{ t('usageMonitor.text.requestsDidNotReturnTheActualMode') }}</span>
        </div>
        <p>{{ t('usageMonitor.text.requestSettingsAndAutoDetectionCannotReplaceResponseConfirmation') }}</p>
        <details>
          <summary>{{ t('usageMonitor.text.aboutTheThreeRecordTypes') }}</summary>
          <p v-for="row in rows" :key="row.label">
            <b>{{ row.label }}{{ t('usageMonitor.text.label') }}</b>{{ meaning(row.label) }}
          </p>
        </details>
      </footer>
    </section>
  </div>
</template>
<style scoped>
.mode-evidence {
  container-type: inline-size;
  min-width: 0;
  color: #f3f0de;
  padding: 30px 0 26px;
  margin-top: 24px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  overflow: hidden;
}
.evidence-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.15em;
  color: #88a59d;
}
.evidence-heading h2 {
  font-family: Georgia, 'Noto Serif CJK SC', 'Songti SC', serif;
  font-size: clamp(26px, 3.9cqw, 45px);
  font-weight: 600;
  line-height: 1.2;
  margin: 10px 0 12px;
  letter-spacing: 0.03em;
}
.evidence-heading p {
  font-size: 13px;
  color: #b3bfb6;
  line-height: 1.7;
}
.evidence-heading p b {
  font-weight: 500;
  color: #e4eadd;
}
.evidence-hero {
  white-space: nowrap;
  text-align: right;
  padding-top: 9px;
  font-family: Georgia, serif;
}
.evidence-hero strong {
  font-size: clamp(38px, 5.5cqw, 65px);
  font-weight: 500;
  color: #b4d5ff;
  line-height: 1;
}
.evidence-hero > div > span {
  font-size: clamp(21px, 3cqw, 38px);
}
.evidence-hero p {
  font-family: inherit;
  font-size: 15px;
  margin-top: 9px;
}
.evidence-hero p b {
  font-size: 26px;
  color: #d6b5f7;
  margin-left: 15px;
}
.evidence-legend {
  display: flex;
  justify-content: flex-end;
  gap: 22px;
  flex-wrap: wrap;
  margin: 16px 0 5px;
  color: #c3cabe;
  font-size: 12px;
}
.evidence-legend span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.evidence-legend i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: inset 0 1px 2px #fff9;
}
.evidence-source {
  display: grid;
  grid-template-columns: 145px minmax(0, 1fr);
  align-items: center;
  position: relative;
  padding: 7px 0 20px;
}
.evidence-source + .evidence-source {
  border-top: 1px solid #3d54401c;
}
.source-caption {
  padding-right: 15px;
}
.source-caption h3 {
  font-family: Georgia, 'Noto Serif CJK SC', serif;
  font-size: 23px;
  font-weight: 500;
  margin: 0 0 9px;
}
.source-caption p {
  color: #a5b5ac;
  font-size: 11px;
  line-height: 1.7;
}
.source-stat {
  display: block;
  font-size: 10px;
  color: #81968d;
  margin-top: 12px;
}
.source-stat strong {
  font-weight: 500;
  color: #b7c9c0;
}
.source-visual {
  min-width: 0;
}
.evidence-values {
  display: grid;
  grid-template-columns: repeat(var(--modes), minmax(0, 1fr));
  gap: 14px;
  margin: -8px 2.5% 0;
  position: relative;
}
.evidence-cell {
  min-width: 0;
  color: var(--tone);
  text-align: center;
}
.evidence-cell dt {
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.evidence-cell dt i {
  width: 3px;
  height: 12px;
  background: var(--tone);
  opacity: 0.75;
  border-radius: 3px;
  margin-bottom: 3px;
}
.evidence-cell dd {
  margin: 4px 0 0;
}
.evidence-cell strong {
  display: block;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: clamp(25px, 3.6cqw, 44px);
  font-weight: 500;
  line-height: 1.1;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 20px color-mix(in srgb, var(--tone) 18%, transparent);
}
.evidence-cell dd span {
  font-size: 10px;
  color: #8eaaa0;
  display: block;
  margin-top: 5px;
}
.evidence-note {
  border-top: 1px solid #52665850;
  margin-top: 13px;
  padding-top: 18px;
}
.evidence-note > div {
  display: flex;
  align-items: baseline;
  gap: 13px;
  flex-wrap: wrap;
}
.evidence-note > div strong {
  font:
    500 clamp(30px, 4.4cqw, 52px) / 1.2 Georgia,
    serif;
  color: #d6b5f7;
}
.evidence-note > div > span {
  font-family: Georgia, 'Noto Serif CJK SC', serif;
  font-size: clamp(16px, 2.2cqw, 25px);
}
.evidence-note > p {
  font-size: 12px;
  line-height: 1.8;
  color: #b9c7bb;
  margin-top: 6px;
}
.evidence-note details {
  margin-top: 14px;
  color: #7f9a8c;
  font-size: 11px;
  line-height: 1.8;
}
.evidence-note summary {
  cursor: pointer;
  width: fit-content;
}
.evidence-note details p {
  margin-top: 6px;
}
.evidence-placeholder,
.source-missing {
  padding: 40px 0;
  color: #9db1a6;
  font-size: 12px;
}
.source-missing {
  text-align: center;
}
summary:focus-visible {
  outline: 2px solid #b9d6fc;
  outline-offset: 4px;
}
@container (max-width:700px) {
  .evidence-source {
    grid-template-columns: 110px minmax(0, 1fr);
  }
  .source-caption h3 {
    font-size: 19px;
  }
  .evidence-values {
    gap: 8px;
  }
  .evidence-hero strong {
    font-size: 38px;
  }
  .evidence-heading h2 {
    font-size: 28px;
  }
}
@container (max-width:480px) {
  .evidence-heading {
    gap: 15px;
    flex-wrap: wrap;
  }
  .evidence-hero {
    text-align: left;
    padding: 0;
  }
  .evidence-hero > div {
    display: inline-block;
  }
  .evidence-hero p {
    display: inline-block;
    margin-left: 15px;
    font-size: 12px;
  }
  .evidence-hero p b {
    font-size: 20px;
    margin-left: 6px;
  }
  .evidence-hero strong {
    font-size: 32px;
  }
  .evidence-hero > div > span {
    font-size: 20px;
  }
  .evidence-legend {
    justify-content: flex-start;
    margin: 20px 0 12px;
    gap: 16px;
  }
  .evidence-source {
    grid-template-columns: 1fr;
    padding: 15px 0 22px;
  }
  .source-caption {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    padding: 0;
  }
  .source-caption h3 {
    margin: 0;
  }
  .source-stat {
    margin: 0 0 0 auto;
  }
  .source-caption p {
    font-size: 10px;
  }
  .evidence-values {
    margin-top: -6px;
  }
  .evidence-cell strong {
    font-size: 27px;
  }
  .evidence-cell dt {
    font-size: 11px;
  }
  .evidence-note > div > span {
    font-size: 17px;
  }
}

/* Original glass-ribbon design, with compact surrounding layout. */
.mode-evidence-container {
  container-type: inline-size;
  min-width: 0;
}
.mode-evidence {
  container-type: normal;
  margin: 12px 0;
  padding: 16px 0;
  border-radius: 4px;
}
.evidence-heading h2 {
  font-size: 30px;
  margin: 4px 0 6px;
}
.evidence-heading p {
  font-size: 12px;
}
.evidence-hero {
  padding: 0;
}
.evidence-hero strong {
  font-size: 40px;
}
.evidence-hero > div > span {
  font-size: 24px;
}
.evidence-hero p {
  margin: 4px 0 0;
  font-size: 12px;
}
.evidence-hero p b {
  font-size: 20px;
}
.evidence-legend {
  margin: 6px 0 0;
}
.evidence-ribbons {
  width: 100%;
  max-width: none;
  margin: auto;
}
.evidence-source {
  grid-template-columns: 125px minmax(0, 1fr);
  padding: 0 0 7px;
}
.source-caption h3 {
  font-size: 21px;
}
.source-stat {
  margin-top: 6px;
}
.evidence-cell strong {
  font-size: 30px;
  white-space: nowrap;
  overflow-wrap: normal;
}
.evidence-cell dt {
  font-size: 12px;
}
.evidence-cell dd span {
  display: block;
  font-size: 11px;
  margin-top: 3px;
}
.evidence-values {
  margin: 0 2.5%;
}
.evidence-note {
  margin-top: 6px;
  padding-top: 8px;
}
.evidence-note > div strong {
  font-size: 26px;
}
.evidence-note > div > span {
  font-size: 16px;
}
.evidence-note > p {
  margin-top: 4px;
}
.evidence-note details {
  margin-top: 6px;
}
@container (max-width:700px) {
  .evidence-source {
    grid-template-columns: 100px minmax(0, 1fr);
  }
  .source-caption h3 {
    font-size: 18px;
  }
  .evidence-cell strong {
    font-size: 25px;
  }
}
@container (max-width:480px) {
  .mode-evidence {
    padding: 12px 0;
  }
  .evidence-heading h2 {
    font-size: 25px;
  }
  .evidence-source {
    grid-template-columns: 1fr;
    padding: 10px 0;
  }
  .evidence-heading {
    gap: 10px;
  }
  .evidence-hero strong {
    font-size: 30px;
  }
  .evidence-hero > div > span {
    font-size: 20px;
  }
  .evidence-cell strong {
    font-size: 22px;
  }
  .evidence-cell dt {
    font-size: 11px;
  }
  .source-caption p {
    font-size: 11px;
  }
}
@container (max-width:480px) {
  .evidence-hero {
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .evidence-hero p {
    margin: 0;
  }
}

/* Compact whitespace while keeping the physical ribbon height unchanged. */
.evidence-heading p {
  margin: 0;
}
.evidence-heading h2 {
  margin: 3px 0 5px;
}
.source-caption p {
  margin: 0;
}
.evidence-cell dt {
  font-size: 13px;
  line-height: 1.25;
}
.evidence-cell dd {
  margin: 3px 0 0;
}
.evidence-cell strong {
  font-size: 32px;
  line-height: 1.05;
}
.evidence-cell dd span {
  line-height: 1.25;
  color: #a4b9b1;
  margin-top: 3px;
}
.evidence-note > p {
  margin: 3px 0 0;
}
.evidence-note details {
  margin-top: 4px;
}
@container (max-width:480px) {
  .evidence-cell dt {
    font-size: 11px;
  }
  .evidence-cell strong {
    font-size: 23px;
  }
}

@container (min-width:701px) {
  .evidence-note {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 3px 20px;
  }
  .evidence-note > p {
    text-align: right;
    margin: 0;
  }
  .evidence-note details {
    grid-column: 1 / -1;
    margin: 0;
  }
}
</style>
