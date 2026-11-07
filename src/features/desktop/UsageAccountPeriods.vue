<script setup lang="ts">
import { usageLocale } from '@/utils/usageFormat'
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { accountSubscriptionUnavailable, type AccountUsage, type AccountUsageCycle, type AccountUsagePeriod } from '@/api/usageAccounts'
import { monitorAmount, monitorAutomaticPriceSummary, monitorPriceSummary, monitorSingleQuotes, monitorRequestCountLabel, type MonitorTotals } from '@/api/usageMonitor'
import { usageColors, usagePercentLabel } from './usageChartPalette'

const { t } = useI18n()

const props = defineProps<{ account: AccountUsage; paused?: boolean }>()
// Older payloads mixed session-creator guesses into the main periods. Only the
// split contract or explicit request-level confirmation can supply strict totals.
const verifiedPeriods = computed(() => props.account.creatorReference != null || props.account.billingAccountVerified === true ? props.account : null)
const referencePeriods = computed(() => props.account.creatorReference ?? (!verifiedPeriods.value ? props.account : null))
const subscriptionUnavailable = computed(() => accountSubscriptionUnavailable(props.account.subscription))
const subscriptionState = computed(() => props.account.subscription.active === false ? t('usageMonitor.text.subscriptionInactive')
  : props.account.subscription.billingPeriod != null && props.account.subscription.billingPeriod !== 'monthly' ? t('usageMonitor.text.subscriptionPeriodUnsupported')
  : props.account.subscription.error ? t('usageMonitor.text.subscriptionStatusUnconfirmed') : t('usageMonitor.text.subscriptionDatesUnconfirmed'))
const date = (value: number) => new Date(value).toLocaleString(usageLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const range = (period: AccountUsagePeriod) => t('usageMonitor.text.to3', { value0: date(period.startMs), value1: date(period.endMs) })
const colors = [usageColors.cache, usageColors.input, usageColors.output, usageColors.danger]
const displayAmount = (value: number, currency: string) => {
  if (currency !== 'USD' && currency !== 'CNY') return monitorAmount(value, currency)
  const formatted = new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...(value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 2 }) }).format(value)
  return currency === 'USD' ? formatted : t('usageMonitor.text.cny2', { value0: formatted })
}

function money(totals: MonitorTotals) {
  if (!totals.requestCount) return { amount: t('usageMonitor.text.noCollectedUsageYet'), reference: '', note: '' }
  if (totals.automaticPriceSummary) {
    const summary = monitorAutomaticPriceSummary(totals)
    return {
      amount: summary.currencies.filter(row => row.identifiedSubtotal != null).map(row => displayAmount(row.identifiedSubtotal!, row.currency)).join(' · ') || t('usageMonitor.text.identifiedAmountUnknown'),
      reference: summary.currencies.filter(row => row.unknownReferenceSubtotal != null).map(row => t('usageMonitor.text.unidentifiedModeReference', { value0: displayAmount(row.unknownReferenceSubtotal!, row.currency) })).join(' · '),
      note: [monitorRequestCountLabel(totals), summary.unknownRequests ? t('usageMonitor.text.unidentifiedModes', { value0: summary.unknownRequests }) : '', summary.identifiedUnquotedRequests ? t('usageMonitor.text.identifiedModesWithoutUnitPrices', { value0: summary.identifiedUnquotedRequests }) : '', totals.incompleteRequests ? t('usageMonitor.text.incompleteRecords2', { value0: totals.incompleteRequests }) : ''].filter(Boolean).join(' · '),
    }
  }
  const summary = monitorPriceSummary(totals)
  return {
    amount: monitorSingleQuotes(totals).map(row => displayAmount(row.amount, row.currency)).join(' · ') || t('usageMonitor.text.amountUnknown'),
    reference: summary.currencies.filter(row => row.standardRequests > 0).map(row => t('usageMonitor.text.standardPriceReference', { value0: displayAmount(row.referenceSubtotal! - (row.confirmedSubtotal ?? 0), row.currency) })).join(' · '),
    note: [monitorRequestCountLabel(totals), summary.uncoveredRequests ? t('usageMonitor.text.missingUnitPrices2', { value0: summary.uncoveredRequests }) : '', t('usageMonitor.text.modeIdentificationInformationNotProvided'), totals.incompleteRequests ? t('usageMonitor.text.incompleteRecords2', { value0: totals.incompleteRequests }) : ''].filter(Boolean).join(' · '),
  }
}

const unknownExhaustion = (cycle: AccountUsageCycle) => cycle.exhaustionUnknown
const cycleMoney = (cycle: AccountUsageCycle) => unknownExhaustion(cycle) ? { amount: t('usageMonitor.text.exhaustionTimeNotRecorded'), reference: '', note: '' } : money(cycle.totals)
const cycleStatus = (cycle: AccountUsageCycle) => unknownExhaustion(cycle) ? t('usageMonitor.text.exhaustionTimeNotRecorded') : cycle.exhaustedAtMs != null ? t('usageMonitor.text.quotaExhausted') : cycle.current ? t('usageMonitor.text.currentCycleInProgress') : t('usageMonitor.text.ended2')
const cycleQuotaPercent = (cycle: AccountUsageCycle) => cycle.usedPercent == null ? t('usageMonitor.text.usedPercentageNotRecorded') : t('usageMonitor.text.lastRecordedWeeklyQuotaUsed', { percent: usagePercentLabel(cycle.usedPercent) })
const cycleQuotaRecordedAt = (cycle: AccountUsageCycle) => cycle.quotaObservedAtMs > 0 ? t('usageMonitor.text.quotaPercentageRecordedAt', { time: date(cycle.quotaObservedAtMs) }) : undefined
const currentPeriod = computed(() => verifiedPeriods.value?.currentCycle)
const current = computed(() => currentPeriod.value ? cycleMoney(currentPeriod.value) : null)
const weekWithoutCycle = computed(() => verifiedPeriods.value && !currentPeriod.value && (props.account.verifiedWeekRequests ?? 0) > 0 && props.account.calendarWeek.totals.requestCount > 0
  ? money(props.account.calendarWeek.totals) : null)
const historyWithoutCycle = computed(() => !currentPeriod.value && !weekWithoutCycle.value && props.account.verifiedHistory?.totals.requestCount
  ? money(props.account.verifiedHistory.totals) : null)
const previous = computed(() => verifiedPeriods.value?.previousCycle ? cycleMoney(verifiedPeriods.value.previousCycle) : null)
const quotaCycles = computed(() => (verifiedPeriods.value?.quotaCycles ?? []).map(cycle => ({ ...cycle, money: cycleMoney(cycle) })))
const month = computed(() => !subscriptionUnavailable.value && verifiedPeriods.value?.subscriptionMonth ? money(verifiedPeriods.value.subscriptionMonth.totals) : null)
const historicalMonth = computed(() => props.account.subscriptionMonth != null && props.account.subscriptionMonth.endMs <= Date.now())
const attributionNote = computed(() => (props.account.verifiedHistory?.totals.requestCount ?? props.account.verifiedWeekRequests ?? 0) > 0
  ? t('usageMonitor.text.mixedAccountAmounts', { history: props.account.verifiedHistory?.totals.requestCount ?? props.account.verifiedWeekRequests ?? 0, reference: props.account.creatorReferenceWeekRequests ?? 0 })
  : t('usageMonitor.text.creatorAccountAmountsOnly'))
const cycles = computed(() => (subscriptionUnavailable.value ? [] : verifiedPeriods.value?.monthCycles ?? []).map((cycle, index) => {
  const month = props.account.subscriptionMonth!
  return {
    ...cycle,
    money: money(cycle.totals),
    style: {
      '--cycle-color': colors[index % colors.length],
      '--cycle-offset': `${(cycle.startMs - month.startMs) / (month.endMs - month.startMs) * 100}%`,
      '--cycle-width': `${(cycle.endMs - cycle.startMs) / (month.endMs - month.startMs) * 100}%`,
    },
  }
}))
const unsegmented = computed(() => !subscriptionUnavailable.value && verifiedPeriods.value && props.account.unsegmentedMonth.requestCount > 0 ? money(props.account.unsegmentedMonth) : null)
const creatorRows = computed(() => {
  const reference = referencePeriods.value
  if (!reference) return []
  return [
    { label: t('usageMonitor.text.creatorReferenceWeek'), period: reference.calendarWeek },
    { label: t('usageMonitor.text.creatorReferenceCycle'), period: reference.currentCycle },
    { label: t('usageMonitor.text.creatorReferencePreviousCycle'), period: reference.previousCycle },
    { label: t('usageMonitor.text.creatorReferenceMonth'), period: subscriptionUnavailable.value ? null : reference.subscriptionMonth },
  ].filter((row): row is { label: string; period: AccountUsagePeriod } => !!row.period?.totals.requestCount)
    .map(row => ({ ...row, value: money(row.period.totals) }))
})
</script>

<template>
  <section class="account-periods" :aria-label="t('usageMonitor.text.accountQuotaCyclesSubscriptionMonthUsage')">
    <div class="amount-overview">
      <div class="amount-item"><h4>{{ t(historyWithoutCycle ? 'usageMonitor.text.verifiedHistoryAmount' : weekWithoutCycle ? 'usageMonitor.text.recordedWeekReference' : 'usageMonitor.text.verifiedAccountUsage') }}</h4><strong class="period-amount">{{ current?.amount ?? weekWithoutCycle?.amount ?? historyWithoutCycle?.amount ?? t(verifiedPeriods ? 'usageMonitor.text.cycleBoundariesUnconfirmed' : 'usageMonitor.text.noVerifiedAccountUsage') }}</strong></div>
      <div v-if="account.subscriptionMonth && month" class="amount-item subscription-month"><h4>{{ historicalMonth ? t('usageMonitor.text.historicalMonthUsageReference') : t('usageMonitor.text.monthUsageReference') }}</h4><strong class="period-amount">{{ month.amount }}</strong></div>
      <div v-else class="amount-item"><h4>{{ t('usageMonitor.text.monthUsageReference') }}</h4><small class="unknown-month">{{ subscriptionState }}</small></div>
      <div v-if="previous" class="amount-item previous-cycle"><h4>{{ t('usageMonitor.text.previousCycleReference') }}</h4><strong class="period-amount">{{ previous.amount }}</strong></div>
    </div>
    <p class="verified-usage-note">{{ t('usageMonitor.text.verifiedAccountUsageNote') }}</p>
    <section v-if="creatorRows.length" class="creator-reference">
      <h4>{{ t('usageMonitor.text.creatorReferenceSeparate') }}</h4>
      <p>{{ t('usageMonitor.text.creatorReferenceSeparateNote') }}</p>
      <div v-for="row in creatorRows" :key="row.label" class="creator-reference-period">
        <h4>{{ row.label }}</h4><strong>{{ row.value.amount }}</strong>
        <small>{{ range(row.period) }}</small><small>{{ row.value.note }}</small>
        <small v-if="row.value.reference">{{ row.value.reference }}</small>
      </div>
    </section>
    <details class="amount-details">
      <summary>{{ t('usageMonitor.text.amountDetails') }}</summary>
      <small v-if="account.billingAccountVerified === false" class="source-error">{{ attributionNote }}</small>
      <small v-if="paused">{{ t('usageMonitor.text.collectionPaused') }}</small>
      <div v-if="account.verifiedHistory?.totals.requestCount" class="verified-history"><h4>{{ t('usageMonitor.text.verifiedHistoryAmount') }}</h4><p class="period-range">{{ range(account.verifiedHistory) }}</p><strong>{{ money(account.verifiedHistory.totals).amount }}</strong><small>{{ money(account.verifiedHistory.totals).note }}</small></div>
      <div class="amount-evidence">
        <div class="current-details">
          <div class="period-heading"><h4>{{ t('usageMonitor.text.estimatedRecordedUsageThisCycle') }}</h4></div>
          <template v-if="currentPeriod && current">
            <p class="period-range">{{ range(currentPeriod) }}</p>
            <small>{{ cycleStatus(currentPeriod) }}</small>
            <small v-if="currentPeriod.exhaustedAtMs != null">{{ t('usageMonitor.text.firstObservedAt100') }}{{ date(currentPeriod.exhaustedAtMs) }}</small>
            <small v-if="!unknownExhaustion(currentPeriod) && !currentPeriod.totals.requestCount">{{ t('usageMonitor.text.noCollectedUsageInThisCycle') }}</small>
            <small v-if="current.reference" class="reference">{{ current.reference }}</small>
            <small v-if="current.note">{{ current.note }}</small>
            <small v-if="!unknownExhaustion(currentPeriod)">{{ t('usageMonitor.text.recordedThrough') }} {{ date(currentPeriod.observedEndMs) }}</small>
          </template>
          <template v-else><p class="empty-period">{{ t('usageMonitor.text.cycleBoundariesUnconfirmed') }}</p><small>{{ t('usageMonitor.text.noQuotaCycleObservedYet') }}</small><template v-if="weekWithoutCycle"><p class="period-range">{{ range(account.calendarWeek) }}</p><small>{{ weekWithoutCycle.note }}</small><small v-if="weekWithoutCycle.reference">{{ weekWithoutCycle.reference }}</small></template></template>
        </div>
        <div v-if="account.subscriptionMonth && month" class="month-details">
          <div class="period-heading"><h4>{{ historicalMonth ? t('usageMonitor.text.historicalSubscriptionMonthTotal') : t('usageMonitor.text.currentSubscriptionMonthTotal') }}{{ t('usageMonitor.text.includingUsageAfterQuotaExhaustion') }}</h4><small v-if="historicalMonth">{{ t('usageMonitor.text.thisSubscriptionMonthHasEnded') }}</small></div>
          <p class="period-range">{{ range(account.subscriptionMonth) }}</p>
          <small v-if="month.reference" class="reference">{{ month.reference }}</small>
          <small v-if="month.note">{{ month.note }}</small>
          <small>{{ t('usageMonitor.text.recordedThrough') }} {{ date(account.subscriptionMonth.observedEndMs) }} {{ t(account.subscription.source === 'official' ? 'usageMonitor.text.basedOnOfficialRenewalDate' : 'usageMonitor.text.basedOnSourceSubscriptionDates') }}</small>
        </div>
        <p v-else class="unknown-month">{{ t('usageMonitor.text.sourceDoesNotProvideASubscriptionStart') }}</p>
        <div v-if="account.previousCycle && previous" class="previous-details">
          <div class="period-heading"><h4>{{ t('usageMonitor.text.estimatedRecordedUsageInThePreviousWeeklyCycle') }}</h4></div>
          <p class="period-range">{{ range(account.previousCycle) }}</p>
          <small>{{ t('usageMonitor.text.completeQuotaCycle') }} {{ cycleStatus(account.previousCycle) }}</small>
          <small v-if="account.previousCycle.exhaustedAtMs != null">{{ t('usageMonitor.text.firstObservedAt100') }}{{ date(account.previousCycle.exhaustedAtMs) }}</small>
          <small v-if="!unknownExhaustion(account.previousCycle)">{{ t('usageMonitor.text.recordedThrough') }} {{ date(account.previousCycle.observedEndMs) }}</small>
          <small v-if="previous.reference" class="reference">{{ previous.reference }}</small>
          <small v-if="previous.note">{{ previous.note }}</small>
        </div>
        <p v-else class="previous-unavailable">{{ t('usageMonitor.text.noEndedWeeklyQuotaCycleRecordedYet') }}</p>
      </div>
        <div v-if="cycles.length" class="cycle-history">
          <h4>{{ t('usageMonitor.text.cyclesThisMonthIncludingPostExhaustionUsage') }} {{ cycles.length }} {{ t('usageMonitor.text.cycles') }}</h4>
          <ol class="cycle-list" :aria-label="t('usageMonitor.text.quotaCyclesWithinSubscriptionMonth')">
            <li v-for="(cycle, index) in cycles" :key="`${cycle.startMs}-${cycle.resetAtMs}`" :style="cycle.style">
              <div class="cycle-heading"><span>{{ t('usageMonitor.text.page') }} {{ index + 1 }} {{ t('usageMonitor.text.cycles') }}<span v-if="cycle.current"> {{ t('usageMonitor.text.currentCycle') }}</span></span><strong>{{ cycle.money.amount }}</strong></div>
              <small>{{ range(cycle) }}</small>
              <small class="cycle-quota-percent" :title="cycleQuotaRecordedAt(cycle)">{{ cycleQuotaPercent(cycle) }}</small>
              <small v-if="cycle.money.reference" class="reference">{{ cycle.money.reference }}</small>
              <small v-if="cycle.money.note">{{ cycle.money.note }}</small>
              <div class="cycle-track" aria-hidden="true"><span /></div>
            </li>
          </ol>
        </div>
        <div v-if="unsegmented" class="unsegmented"><div class="cycle-heading"><span>{{ t('usageMonitor.text.previouslyRecordedWithoutCycleSplits') }}</span><strong>{{ unsegmented.amount }}</strong></div><small v-if="unsegmented.reference" class="reference">{{ unsegmented.reference }}</small><small>{{ unsegmented.note }} {{ t('usageMonitor.text.includedInMonthlyTotal') }}</small></div>
      <small v-if="account.subscription.error" class="source-error">{{ t('usageMonitor.text.failedToReadSubscriptionSource') }}{{ account.subscription.error }}</small>
      <small v-if="account.subscription.checkedAtMs" class="source-checked">{{ t('usageMonitor.text.subscriptionInformationUpdated') }} {{ date(account.subscription.checkedAtMs) }}</small>
      <small class="attribution">{{ t('usageMonitor.text.verifiedAccountUsageNote') }}</small>
      <small>{{ t('usageMonitor.text.weeklyQuotaAmountsStopAtTheFirstObserved100') }}</small>
    </details>
    <details v-if="quotaCycles.length" class="quota-cycle-details">
      <summary>{{ t('usageMonitor.text.quotaCycle') }} {{ quotaCycles.length }}</summary>
      <ol class="cycle-list" :aria-label="t('usageMonitor.text.allQuotaCycles')">
        <li v-for="(cycle, index) in quotaCycles" :key="`${cycle.startMs}-${cycle.resetAtMs}`" :data-start-ms="cycle.startMs" :style="{ '--cycle-color': colors[index % colors.length] }">
          <div class="cycle-heading"><span>{{ cycle.current ? t('usageMonitor.text.currentCycle2') : t('usageMonitor.text.cycle', { value0: quotaCycles.length - index }) }} · {{ cycleStatus(cycle) }}</span><strong>{{ cycle.money.amount }}</strong></div>
          <small class="period-range">{{ range(cycle) }}</small>
          <small class="cycle-quota-percent" :title="cycleQuotaRecordedAt(cycle)">{{ cycleQuotaPercent(cycle) }}</small>
          <small v-if="cycle.exhaustedAtMs != null">{{ t('usageMonitor.text.firstObservedAt100') }}{{ date(cycle.exhaustedAtMs) }}</small>
          <small v-if="!unknownExhaustion(cycle)">{{ t('usageMonitor.text.recordedThrough') }} {{ date(cycle.observedEndMs) }}</small>
          <small v-if="cycle.money.reference" class="reference">{{ cycle.money.reference }}</small>
          <small v-if="cycle.money.note">{{ cycle.money.note }}</small>
        </li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.verified-usage-note,.creator-reference p{font-size:12px;color:#aebfb3;line-height:1.6}.creator-reference{margin-top:12px;padding:10px;border:1px dashed #826c48;border-radius:6px}.creator-reference-period{margin-top:8px}.creator-reference-period>strong{color:#d3ba8a;font-variant-numeric:tabular-nums}
.quota-cycle-details{margin-top:8px;min-width:0}.quota-cycle-details>summary{width:fit-content;max-width:100%;padding:2px 6px;cursor:pointer;color:#91a79a;font-size:11px}.quota-cycle-details[open]>summary{margin-bottom:10px}
.previous-cycle .period-amount{color:var(--usage-input,#78b8ff)}.previous-details{grid-column:1/-1}.previous-unavailable{font-size:12px;color:#9fb3a5;margin:0}
.amount-evidence{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;padding:10px 0 14px}.amount-evidence>div{min-width:0}.amount-evidence>.month-details{margin:0;padding:0;border:0}.amount-details .cycle-history{padding-top:12px;border-top:1px solid var(--cost-line,#293c30)}@media(max-width:600px){.amount-evidence{grid-template-columns:minmax(0,1fr);gap:14px}}
.account-periods{min-width:0;color:#d6e2d9;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.amount-overview{display:flex;flex-wrap:wrap;gap:9px 16px}.amount-item{flex:1 1 130px;min-width:0}.period-heading,.cycle-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}h4{font-size:12px;font-weight:500;margin:0;color:#aebfb3}.account-periods small{display:block;color:#9fb3a5;font-size:12px}.period-range{font-size:12px;color:#aebfb3;margin:5px 0}.period-amount{display:block;font-size:22px;color:var(--usage-value,#e5be72);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35}.subscription-month .period-amount{color:var(--usage-cache,#50d9b4)}.account-periods .reference{color:#c1b8a4}.amount-details{margin-top:8px;min-width:0}.amount-details>summary{width:fit-content;max-width:100%;padding:2px 6px;border-radius:3px;cursor:pointer;color:#91a79a;font-size:11px}.amount-details>summary:focus-visible{outline:none;background:var(--cost-panel-2);color:var(--cost-text);box-shadow:inset 3px 0 0 var(--usage-input)}.amount-details[open]>summary{margin-bottom:10px}.month-details{margin-top:12px;padding-top:10px;border-top:1px solid var(--cost-line,#293c30)}.cycle-history{margin-top:12px}.cycle-list{list-style:none;margin:9px 0 0;padding:0;display:grid;gap:11px}.cycle-list li{min-width:0;border-left:2px solid var(--cycle-color);padding-left:9px}.cycle-heading strong{font-size:12px;color:var(--cycle-color,#c1cebf);font-variant-numeric:tabular-nums;font-weight:600}.cycle-heading>span{color:var(--cycle-color,#c1cebf)}.cycle-track{height:3px;background:#24332a;position:relative;margin-top:5px;overflow:hidden;border-radius:2px}.cycle-track>span{position:absolute;inset-block:0;left:var(--cycle-offset);width:var(--cycle-width);min-width:2px;background:var(--cycle-color)}.unsegmented{margin-top:12px;padding-top:8px;border-top:1px dashed #3b4c40}.empty-period,.unknown-month{color:#aebfb3;font-size:12px;margin:7px 0}.amount-overview .unknown-month{margin:4px 0 0}.account-periods .attribution{margin-top:12px;color:#8da392}.account-periods .source-error{margin-top:6px;color:#f0ad62}@media(max-width:400px){.period-heading,.cycle-heading{align-items:flex-start;gap:3px}.cycle-heading strong{flex-basis:100%}}
</style>
