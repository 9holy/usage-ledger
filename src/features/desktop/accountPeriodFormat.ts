import i18n from '@/i18n'
import { usageLocale } from '@/utils/usageFormat'
import { monitorAmount, monitorAutomaticPriceSummary, monitorPriceSummary, monitorSingleQuotes, monitorRequestCountLabel, type MonitorTotals } from '@/api/usageMonitor'
import type { AccountUsagePeriod } from '@/api/usageAccounts'

const t = i18n.global.t

export const periodDate = (value: number) => new Date(value).toLocaleString(usageLocale(), {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})

export const periodRange = (period: Pick<AccountUsagePeriod, 'startMs' | 'endMs'>) =>
  t('usageMonitor.text.to3', { value0: periodDate(period.startMs), value1: periodDate(period.endMs) })

export function periodCurrencyAmount(value: number, currency: string) {
  if (currency !== 'USD' && currency !== 'CNY') return monitorAmount(value, currency)
  const formatted = new Intl.NumberFormat(usageLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...(value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 2 }) }).format(value)
  return currency === 'USD' ? formatted : t('usageMonitor.text.cny2', { value0: formatted })
}

export function periodAmount(totals: MonitorTotals) {
  if (!totals.requestCount) return { amount: t('usageMonitor.text.noCollectedUsageYet'), reference: '', note: '' }
  if (totals.automaticPriceSummary) {
    const summary = monitorAutomaticPriceSummary(totals)
    return {
      amount: summary.currencies.filter(row => row.identifiedSubtotal != null).map(row => periodCurrencyAmount(row.identifiedSubtotal!, row.currency)).join(' · ') || t('usageMonitor.text.identifiedAmountUnknown'),
      reference: summary.currencies.filter(row => row.unknownReferenceSubtotal != null).map(row => t('usageMonitor.text.unidentifiedModeReference', { value0: periodCurrencyAmount(row.unknownReferenceSubtotal!, row.currency) })).join(' · '),
      note: [monitorRequestCountLabel(totals), summary.unknownRequests ? t('usageMonitor.text.unidentifiedModes', { value0: summary.unknownRequests }) : '', summary.identifiedUnquotedRequests ? t('usageMonitor.text.identifiedModesWithoutUnitPrices', { value0: summary.identifiedUnquotedRequests }) : '', totals.incompleteRequests ? t('usageMonitor.text.incompleteRecords2', { value0: totals.incompleteRequests }) : ''].filter(Boolean).join(' · '),
    }
  }
  const summary = monitorPriceSummary(totals)
  return {
    amount: monitorSingleQuotes(totals).map(row => periodCurrencyAmount(row.amount, row.currency)).join(' · ') || t('usageMonitor.text.amountUnknown'),
    reference: summary.currencies.filter(row => row.standardRequests > 0).map(row => t('usageMonitor.text.standardPriceReference', { value0: periodCurrencyAmount(row.referenceSubtotal! - (row.confirmedSubtotal ?? 0), row.currency) })).join(' · '),
    note: [monitorRequestCountLabel(totals), summary.uncoveredRequests ? t('usageMonitor.text.missingUnitPrices2', { value0: summary.uncoveredRequests }) : '', t('usageMonitor.text.modeIdentificationInformationNotProvided'), totals.incompleteRequests ? t('usageMonitor.text.incompleteRecords2', { value0: totals.incompleteRequests }) : ''].filter(Boolean).join(' · '),
  }
}
