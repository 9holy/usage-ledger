<template>
  <section class="governance" aria-labelledby="governance-title">
    <header class="governance__header">
      <div>
        <span>{{ t('costComponents.dataGovernanceTruthfulHistory') }}</span>
        <h2 id="governance-title"> {{ t('costComponents.dataSourcesAndHistoryControls') }} </h2>
        <p> {{ t('costComponents.calendarDaysRollingWindowsLifetimeTotalsAnd') }} </p>
      </div>
      <button type="button" data-aui-component="button" data-aui-pressable :disabled="loading" @click="$emit('refresh')">
        <RefreshCcw :size="15" :class="{ spin: loading }" />
        {{ loading ? t('costComponents.refreshing') : t('costComponents.refreshAllSources') }}
      </button>
    </header>

    <div class="governance__summary" role="status">
      <div><strong>{{ healthyCount }}</strong><span> {{ t('costComponents.availableSources') }} </span></div>
      <div><strong>{{ warningCount }}</strong><span> {{ t('costComponents.partialEstimatedStale') }} </span></div>
      <div><strong>{{ unavailableCount }}</strong><span> {{ t('costComponents.unavailableSources') }} </span></div>
      <div><strong>{{ lastUpdated || t('costComponents.refreshNotCompleted') }}</strong><span> {{ t('costComponents.lastOverallValidation') }} </span></div>
    </div>

    <div class="governance__grid">
      <article v-for="state in orderedStates" :key="state.key" class="source-card" :class="`is-${state.status}`">
        <div>
          <component :is="sourceIcon(state.status)" :size="15" />
          <strong>{{ state.label }}</strong>
          <em>{{ dataAvailabilityLabel(state.status) }}</em>
        </div>
        <p>{{ state.reason || stateDescription(state.status) }}</p>
        <small>{{ state.updatedAt ? formatTime(state.updatedAt) : t('costComponents.noSuccessfulRefreshYet') }}</small>
      </article>
    </div>

    <div class="governance__policies">
      <article>
        <CalendarDays :size="18" />
        <div><strong> {{ t('costComponents.todayMeansTheLocalCalendarDay') }} </strong><p> {{ t('costComponents.startsAtInTheLocalTimeZone') }} </p></div>
      </article>
      <article>
        <History :size="18" />
        <div><strong> {{ t('costComponents.economicSamplesAreRetainedForDays') }} </strong><p> {{ t('costComponents.samplesSupportDifferencesBetweenAdjacentTotalsAnd') }} {{ historyStoreLabel }}。</p></div>
      </article>
      <article>
        <ShieldCheck :size="18" />
        <div><strong> {{ t('costComponents.theBanLossLedgerCannotSilentlyReset') }} </strong><p> {{ t('costComponents.terminalLossesRefundsAndReversalsAreSeparate') }} </p></div>
      </article>
    </div>

    <footer class="governance__actions">
      <button v-if="sourceKind === 'sub2api'" type="button" data-aui-component="button" data-aui-pressable @click="router.push('/admin/usage')">
        <Database :size="15" /> {{ t('costComponents.openUsageLogsHistoryAndCleanupTasks') }} </button>
      <p v-else class="governance__history-note"><Database :size="15" />{{ historyEntryNote }}</p>
      <div>
        <strong> {{ t('costComponents.currentEconomicSampling') }} </strong>
        <span v-if="economics">{{ economics.data_quality.sample_count }} {{ t('costComponents.samples') }} {{ economics.projection.valid_intervals }} {{ t('costComponents.stableIntervalsForecast') }} {{ economics.projection.confidence }}</span>
        <span v-else> {{ t('costComponents.noDataSeeTheEconomicSamplingAnd') }} </span>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { CalendarDays, CheckCircle2, CircleAlert, Clock3, Database, History, RefreshCcw, ShieldCheck, TriangleAlert } from '@lucide/vue'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'
import { COST_CENTER_SOURCE_KEYS, dataAvailabilityLabel, type DataAvailability, type DataSourceState } from '../dataState'
import { getLocale } from '@/i18n'

const props = defineProps<{
  /** 当前连接源。**必填**:面板正文与历史入口都提到了 usage_logs,而 usage_logs 只有 sub2api 有
   *  (cockpit 是本机单请求用量库,cliproxy 是 CPA usage_events,都不读这张表)。 */
  sourceKind: 'sub2api' | 'cliproxy' | 'cockpit'
  states: Record<string, DataSourceState>
  economics?: AccountEconomicsSnapshot | null
  lastUpdated?: string
  loading?: boolean
}>()

defineEmits<{ refresh: [] }>()

const router = useRouter()

/** 该源的用量历史落在哪 —— 经济样本"不修改"的对象按源改名。 */
const historyStoreLabel = computed(() => props.sourceKind === 'sub2api'
  ? 'usage_logs'
  : props.sourceKind === 'cliproxy' ? 'CPA usage_events' : t('costComponents.cockpitLocalUsageDatabase'))

/** 非 sub2api 下不给 /admin/usage 入口:/admin/usage 是 sub2api 的 usage_logs 页,
 *  这两源既没有那张表,跳过去也只是把用户送到一个讲别源数据的页面。
 *  诚实做法是说明历史归谁管,而不是提供一个走不到实处的按钮。 */
const historyEntryNote = computed(() => props.sourceKind === 'cliproxy'
  ? t('costComponents.historyIsManagedByCpaUsageEvents')
  : t('costComponents.historyIsManagedByTheCockpitLocal'))

const orderedStates = computed(() => COST_CENTER_SOURCE_KEYS.map((key) => props.states[key]).filter(Boolean))
const healthyCount = computed(() => orderedStates.value.filter((state) => state.status === 'measured' || state.status === 'empty').length)
const warningCount = computed(() => orderedStates.value.filter((state) => ['estimated', 'partial', 'stale', 'loading'].includes(state.status)).length)
const unavailableCount = computed(() => orderedStates.value.filter((state) => state.status === 'unavailable').length)

function sourceIcon(status: DataAvailability) {
  if (status === 'measured' || status === 'empty') return CheckCircle2
  if (status === 'unavailable') return CircleAlert
  if (status === 'loading' || status === 'stale') return Clock3
  return TriangleAlert
}

function stateDescription(status: DataAvailability): string {
  if (status === 'empty') return t('costComponents.theSourceLoadedSuccessfullyAndContainsNo')
  if (status === 'unavailable') return t('costComponents.theSourceFailedToLoadDependentValues')
  if (status === 'estimated') return t('costComponents.usesAnExplicitlyLabeledFallbackOrEstimate')
  if (status === 'partial') return t('costComponents.onlyPartOfTheSourcesOrScope')
  if (status === 'stale') return t('costComponents.retainsTheLastSuccessfulValuesAndMarks')
  return status === 'loading' ? t('costComponents.loadingNumericValuesAreTemporarilyUnavailable') : t('costComponents.sourceLoadedSuccessfully')
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? t('costComponents.updated', { p0: date.toLocaleString(getLocale()) }) : t('costComponents.updateTimeUnknown')
}
</script>

<style scoped>
.governance { padding: 26px; color: var(--cost-text, #edf1ea); }
.governance__header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
.governance__header span { color: var(--cost-lime, #b9e55a); font: 10px 'Cascadia Mono', monospace; letter-spacing: 0; }
.governance__header h2 { margin: 7px 0 5px; font-size: 24px; }
.governance__header p, .source-card p, .governance__policies p { margin: 0; color: #89948b; font-size: 12px; line-height: 1.55; }
.governance button { display: inline-flex; min-height: 38px; align-items: center; gap: 7px; border: 1px solid rgb(185 229 90 / 45%); border-radius: 10px; padding: 0 13px; color: #ddecce; background: rgb(185 229 90 / 8%); cursor: pointer; }
.governance button:disabled { cursor: progress; opacity: .55; }
.governance__summary { display: grid; grid-template-columns: repeat(3, minmax(130px, .7fr)) minmax(220px, 1.4fr); margin-top: 22px; border: 1px solid #303830; border-radius: 14px; overflow: hidden; background: #111612; }
.governance__summary div { min-height: 92px; padding: 17px; border-right: 1px solid #303830; }
.governance__summary div:last-child { border-right: 0; }
.governance__summary strong, .governance__summary span { display: block; }
.governance__summary strong { font: 650 21px 'Cascadia Mono', monospace; }
.governance__summary span { margin-top: 7px; color: #7f8a81; font-size: 11px; }
.governance__grid { display: grid; grid-template-columns: repeat(3, minmax(240px, 1fr)); gap: 10px; margin-top: 14px; }
.source-card { min-width: 0; min-height: 118px; border: 1px solid #303830; border-left-width: 3px; border-radius: 8px; padding: 14px; background: #121713; overflow-wrap: anywhere; }
.source-card > div { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.source-card strong { font-size: 13px; }
.source-card em { margin-left: auto; color: #9ca69e; font-size: 10px; font-style: normal; }
.source-card p { margin-top: 11px; }
.source-card small { display: block; margin-top: 8px; color: #647068; font: 9px 'Cascadia Mono', monospace; }
.source-card.is-measured, .source-card.is-empty { border-left-color: #72c88a; }
.source-card.is-estimated, .source-card.is-partial { border-left-color: #d6aa47; }
.source-card.is-unavailable { border-left-color: #d58473; }
.source-card.is-stale, .source-card.is-loading { border-left-color: #7eb6d8; }
.governance__policies { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.governance__policies article { display: flex; gap: 11px; border: 1px solid #303830; border-radius: 11px; padding: 15px; background: #0f1410; }
.governance__policies svg { flex: 0 0 auto; color: var(--cost-lime, #b9e55a); }
.governance__policies strong { display: block; margin-bottom: 7px; font-size: 13px; }
.governance__actions { display: flex; align-items: center; gap: 18px; margin-top: 14px; border-top: 1px solid #303830; padding-top: 16px; }
.governance__actions div { display: grid; gap: 4px; }
.governance__history-note { display: flex; max-width: 430px; align-items: center; gap: 7px; margin: 0; color: #89948b; font-size: 12px; line-height: 1.55; }
.governance__actions span { color: #818c83; font-size: 11px; }
.governance :is(.governance__header > div, .governance__summary > div, .governance__actions > div, .governance__policies article > div) { min-width: 0; overflow-wrap: anywhere; }
.governance button { flex-shrink: 0; padding-block: 8px; }
.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1100px) { .governance__grid, .governance__policies { grid-template-columns: repeat(2, minmax(0, 1fr)); }.governance__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .governance__header, .governance__actions { align-items: stretch; flex-direction: column; }.governance__grid, .governance__policies, .governance__summary { grid-template-columns: 1fr; } }
</style>
