<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getSubscriptionCycles, getSubscriptionCycleUsage, type AccountUsage, type SubscriptionCycle } from '@/api/usageAccounts'
import { getFinanceLedger, type FinanceAccountSummary } from '@/api/financeLedger'
import { LOCAL_FINANCE_SCOPE } from '@/api/localCost'
import { periodAmount, periodCurrencyAmount, periodDate, periodRange } from './accountPeriodFormat'
import { usagePercentLabel } from './usageChartPalette'

const props = defineProps<{ accountKey: string; enabled: boolean; currentPeriod?: { startMs: number; endMs: number } | null; includeCosts?: boolean }>()
const { t } = useI18n()
const periods = shallowRef<SubscriptionCycle[]>([])
const selected = ref('')
const history = shallowRef<AccountUsage | null>(null)
const periodsError = ref(false), loading = ref(false), error = ref(false)
const matchesCurrent = (period: SubscriptionCycle) => period.current
  && period.startMs === props.currentPeriod?.startMs && period.endMs === props.currentPeriod?.endMs
const choices = computed(() => periods.value.filter(period => !matchesCurrent(period) || period.id === selected.value))
const label = (period: SubscriptionCycle) => t(period.current ? 'usageMonitor.text.currentBillingPeriod'
  : period.kind === 'estimated' ? 'usageMonitor.text.estimatedSubscriptionCycle'
  : period.kind === 'validity' ? 'usageMonitor.text.recordedSubscriptionValidity'
  : period.kind === 'unconfirmed' ? 'usageMonitor.text.unconfirmedSubscriptionCycle'
  : 'usageMonitor.text.recordedSubscriptionCycle')

watch(() => props.accountKey, () => { periods.value = []; selected.value = ''; history.value = null })
watch([() => props.enabled, () => props.accountKey, () => props.currentPeriod?.startMs, () => props.currentPeriod?.endMs], async ([enabled, key], _, onCleanup) => {
  if (!enabled) return
  periodsError.value = false
  let cancelled = false
  onCleanup(() => { cancelled = true })
  try {
    const saved = await getSubscriptionCycles(key)
    if (cancelled) return
    periods.value = saved
  } catch {
    if (!cancelled) periodsError.value = true
  }
}, { immediate: true })

watch([selected, () => props.enabled, () => props.accountKey], async ([id, enabled, key], _, onCleanup) => {
  if (!enabled) return
  history.value = null
  error.value = false
  loading.value = !!id
  if (!id) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  try {
    const result = await getSubscriptionCycleUsage(key, id)
    if (!cancelled) history.value = result
  } catch {
    if (!cancelled) error.value = true
  } finally {
    if (!cancelled) loading.value = false
  }
})

const month = computed(() => history.value?.subscriptionMonth)
const expenses = shallowRef<FinanceAccountSummary[]>([]), expensesError = ref(false)
watch(month, async (period, _, onCleanup) => {
  expenses.value = []
  expensesError.value = false
  if (!props.includeCosts || !period || period.observedEndMs <= period.startMs) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  try {
    const report = await getFinanceLedger({ ...LOCAL_FINANCE_SCOPE, accountId: props.accountKey,
      startMs: period.startMs, endMs: period.observedEndMs })
    if (!cancelled) expenses.value = report.byAccount
  } catch {
    if (!cancelled) expensesError.value = true
  }
})
const estimate = computed(() => month.value && periodAmount(history.value?.historicalSubscriptionEstimate ?? month.value.totals))
const breakdown = computed(() => {
  const refs = history.value?.creatorReference?.subscriptionMonth?.totals
  return month.value && history.value?.historicalSubscriptionEstimate && refs?.requestCount
    ? { confirmed: periodAmount(month.value.totals), reference: periodAmount(refs) } : null
})
const cycles = computed(() => (history.value?.monthCycles ?? []).map(row => ({ ...row, amount: periodAmount(row.totals) })))
const unsegmented = computed(() => {
  const totals = history.value?.unsegmentedMonth
  return cycles.value.length && totals?.requestCount ? periodAmount(totals) : null
})
</script>

<template>
  <select v-if="choices.length || selected" v-model="selected" class="amount-period-select" :aria-label="t('usageMonitor.text.subscriptionPeriod')">
    <option value="">{{ t(currentPeriod && currentPeriod.endMs > Date.now() ? 'usageMonitor.text.currentBillingPeriod' : 'usageMonitor.text.currentAccountDetails') }}</option>
    <option v-for="period in choices" :key="period.id" :value="period.id">{{ label(period) }} · {{ periodRange(period) }}</option>
    <option v-if="selected && !choices.some(period => period.id === selected)" :value="selected">{{ t('usageMonitor.text.subscriptionCycleUnavailable') }}</option>
  </select>
  <p v-if="periodsError" class="history-status" role="status">{{ t('usageMonitor.text.subscriptionCycleListFailed') }}</p>
  <slot v-if="!selected" />
  <p v-else-if="loading" class="history-status" role="status">{{ t('usageMonitor.text.loadingSubscriptionCycle') }}</p>
  <p v-else-if="error" class="history-status" role="status">{{ t('usageMonitor.text.subscriptionCycleReadFailed') }}</p>
  <section v-else-if="month && estimate" class="subscription-cycle-result">
    <header>{{ t(breakdown ? 'usageMonitor.text.subscriptionCycleHistoricalEstimate' : 'usageMonitor.text.subscriptionCycleConfirmedUsage') }}</header>
    <small>{{ periodRange(month) }}</small>
    <strong class="period-amount">{{ estimate.amount }}</strong>
    <small v-if="estimate.reference" class="reference">{{ estimate.reference }}</small>
    <small v-if="estimate.note">{{ estimate.note }}</small>
    <div v-if="breakdown" class="history-amount-breakdown">
      <small>{{ t('usageMonitor.text.subscriptionCycleConfirmedUsage') }} · {{ breakdown.confirmed.amount }}</small>
      <small>{{ t('usageMonitor.text.previousPeriodReferenceOnly') }} · {{ breakdown.reference.amount }}</small>
    </div>
    <p v-if="expensesError" class="history-status" role="status">{{ t('desktop.localCost.costHistoryReadFailed') }}</p>
    <div v-for="expense in expenses" :key="expense.currency" class="history-amount-breakdown subscription-cycle-cost">
      <small>{{ t('desktop.localCost.cashPaid') }} · {{ periodCurrencyAmount(expense.cashOutlay, expense.currency) }}</small>
      <small>{{ t('desktop.localCost.recordedCost') }} · {{ expense.netExpense == null
        ? t(expense.missingCoverageCount ? 'desktop.localCost.missingBillingPeriod' : 'costComponents.allocationIncomplete')
        : periodCurrencyAmount(expense.netExpense, expense.currency) }}</small>
    </div>
    <div v-if="cycles.length" class="historical-weekly-cycles">
      <header>{{ t('usageMonitor.text.quotaCyclesWithinSubscriptionMonth') }}{{ t('usageMonitor.text.includingUsageAfterQuotaExhaustion') }} · {{ cycles.length }}</header>
      <ol>
        <li v-for="cycle in cycles" :key="`${cycle.startMs}:${cycle.resetAtMs}`">
          <div><span>{{ periodRange(cycle) }}</span><strong>{{ cycle.amount.amount }}</strong></div>
          <small :title="cycle.quotaObservedAtMs > 0 ? periodDate(cycle.quotaObservedAtMs) : undefined">{{ cycle.usedPercent == null ? t('usageMonitor.text.usedPercentageNotRecorded') : t('usageMonitor.text.lastRecordedWeeklyQuotaUsed', { percent: usagePercentLabel(cycle.usedPercent) }) }}</small>
          <small v-if="cycle.amount.reference" class="reference">{{ cycle.amount.reference }}</small>
          <small v-if="cycle.amount.note">{{ cycle.amount.note }}</small>
        </li>
      </ol>
    </div>
    <small v-else>{{ t('usageMonitor.text.noConfirmedCycleQuotaReadings') }}</small>
    <div v-if="unsegmented" class="history-amount-breakdown">
      <span>{{ t('usageMonitor.text.previouslyRecordedWithoutCycleSplits') }} · {{ unsegmented.amount }}</span>
      <small v-if="unsegmented.reference" class="reference">{{ unsegmented.reference }}</small>
      <small>{{ unsegmented.note }} {{ t('usageMonitor.text.includedInMonthlyTotal') }}</small>
    </div>
  </section>
  <p v-else class="history-status" role="status">{{ t('usageMonitor.text.subscriptionCycleUnavailable') }}</p>
</template>

<style scoped>
.amount-period-select{max-width:100%;min-height:30px;padding:3px 8px;border:1px solid var(--cost-line);border-radius:4px;background:var(--cost-panel);color:var(--cost-text);font:inherit}
.subscription-cycle-result{margin:12px 0;min-width:0;color:var(--cost-text);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.subscription-cycle-result header{display:block;font-weight:550;font-size:12px}.subscription-cycle-result small,.history-status{display:block;color:var(--cost-muted);font-size:11px;line-height:1.6}.subscription-cycle-result .reference{color:var(--cost-gold)}.period-amount{display:block;color:var(--usage-value,var(--cost-gold));font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.history-amount-breakdown,.historical-weekly-cycles{margin:8px 0;padding-top:8px;border-top:1px solid var(--cost-line)}.historical-weekly-cycles ol{list-style:none;padding:0;margin:6px 0;display:grid;gap:8px}.historical-weekly-cycles li>div{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 12px}
</style>
