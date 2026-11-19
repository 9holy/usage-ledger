import type { FinanceAccountSummary } from '@/api/financeLedger'
import type { LocalCostAccount, LocalCostReport } from '@/api/localCost'
import { monitorAutomaticPriceSummary } from '@/api/usageMonitor'

export function accountApiExpense(report: LocalCostReport, accountId: string) {
  return report.apiExpense.byAccount ? report.apiExpense.byAccount[accountId] : accountId === 'api:all' ? report.apiExpense : undefined
}

export function localCostMetrics(account: LocalCostAccount, report: LocalCostReport, finances: FinanceAccountSummary[]) {
  const rate = report.settings.cnyPerUsd
  const cny = (value: number, currency: string) => currency === 'USD' ? value * rate : value
  const prices = monitorAutomaticPriceSummary(account.totals)
  const valueCny = prices.currencies.reduce((sum, row) => sum + cny(row.identifiedSubtotal ?? 0, row.currency), 0)
  const currencyKnown = prices.currencies.every(row => ['USD', 'CNY'].includes(row.currency))
  const valueKnown = currencyKnown && prices.coveredRequests > 0
  const entered = finances.filter(row => row.accountId === account.id)
  const complete = entered.length > 0 && entered.every(row => row.netExpense != null)
  const subscriptionExpense = complete ? entered.reduce((sum, row) => sum + cny(row.netExpense!, row.currency), 0) : null
  const api = accountApiExpense(report, account.id)
  const costComplete = !api || api.missingRequests === 0
  const expenseCny = account.id === 'api:all' || account.billingKind === 'api'
    ? api && api.pricedRequests > 0 ? Object.entries(api.byCurrency).reduce((sum, [currency, amount]) => sum + cny(amount, currency), 0) : null
    : api && api.pricedRequests > 0 ? (subscriptionExpense ?? 0) + Object.entries(api.byCurrency).reduce((sum, [currency, amount]) => sum + cny(amount, currency), 0) : subscriptionExpense
  const partial = !prices.complete || account.referenceRequests > 0 || !costComplete
  return {
    valueCny: valueKnown ? valueCny : null,
    expenseCny,
    missingCoverage: entered.some(row => row.missingCoverageCount > 0),
    factor: !partial && expenseCny != null && valueKnown && valueCny > 0 ? expenseCny / valueCny : null,
    perMillionTokens: costComplete && expenseCny != null && account.totals.totalTokens > 0 ? expenseCny / account.totals.totalTokens * 1e6 : null,
    remainingCny: complete && entered.every(row => row.remainingPrepaid != null) ? entered.reduce((sum, row) => sum + cny(row.remainingPrepaid!, row.currency), 0) : null,
    partial,
  }
}

export type LocalCostRow = LocalCostAccount & { name: string; metrics: ReturnType<typeof localCostMetrics> }

export function localCostOverview(rows: LocalCostRow[], report: LocalCostReport, finances: FinanceAccountSummary[]) {
  const cny = (amount: number, currency: string) => currency === 'USD' ? amount * report.settings.cnyPerUsd : amount
  const sumKnown = (values: Array<number | null>) => values.some(value => value != null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null
  const subscriptions = rows.filter(row => row.id !== 'api:all' && row.id !== 'unassigned' && row.billingKind !== 'api')
  const facts = finances.filter(row => row.accountId !== 'api:all')
  const paired = rows.filter(row => !row.metrics.partial && row.metrics.expenseCny != null && row.metrics.valueCny != null)
  const pairedValue = paired.reduce((sum, row) => sum + row.metrics.valueCny!, 0)
  const pairedExpense = paired.reduce((sum, row) => sum + row.metrics.expenseCny!, 0)
  return {
    expenseCny: sumKnown(rows.map(row => row.metrics.expenseCny)),
    missingCoverage: finances.some(row => row.missingCoverageCount > 0),
    valueCny: sumKnown(rows.map(row => row.metrics.valueCny)),
    factor: pairedValue > 0 ? pairedExpense / pairedValue : null,
    partial: rows.some(row => row.totals.requestCount > 0 && (row.metrics.partial || row.metrics.expenseCny == null)),
    costIncomplete: rows.some(row => row.totals.requestCount > 0 && (row.metrics.expenseCny == null || (report.apiExpense.byAccount?.[row.id]?.missingRequests ?? (row.id === 'api:all' && !report.apiExpense.byAccount ? report.apiExpense.missingRequests : 0)) > 0)) || finances.some(row => row.netExpense == null || row.missingCoverageCount > 0),
    factorAccountCount: paired.filter(row => row.metrics.valueCny! > 0).length,
    subscriptionCount: subscriptions.length,
    activeCount: subscriptions.filter(row => report.settings.accounts[row.id]?.status === 'active').length,
    bannedCount: subscriptions.filter(row => report.settings.accounts[row.id]?.status === 'banned').length,
    unknownStateCount: subscriptions.filter(row => report.settings.accounts[row.id]?.status == null).length,
    enteredCount: subscriptions.filter(row => report.purchases[row.id] != null).length,
    remainingCny: facts.length && facts.every(row => row.remainingPrepaid != null) ? facts.reduce((sum, row) => sum + cny(row.remainingPrepaid!, row.currency), 0) : null,
    requests: rows.reduce((sum, row) => sum + row.totals.requestCount, 0),
    tokens: rows.reduce((sum, row) => sum + row.totals.totalTokens, 0),
    cashOutlayCny: finances.length ? finances.reduce((sum, row) => sum + cny(row.cashOutlay, row.currency), 0) : null,
    refundsCny: finances.length ? finances.reduce((sum, row) => sum + cny(row.refunds, row.currency), 0) : null,
    accruedCny: facts.length ? facts.reduce((sum, row) => sum + cny(row.accruedExpense, row.currency), 0) : null,
    lossesCny: facts.length ? facts.reduce((sum, row) => sum + cny(row.recognizedLoss, row.currency), 0) : null,
    creditsCny: facts.length ? facts.reduce((sum, row) => sum + cny(row.expenseCredits, row.currency), 0) : null,
    apiCny: sumKnown(rows.map(row => { const api=accountApiExpense(report,row.id);return api?.pricedRequests ? Object.entries(api.byCurrency).reduce((sum,[currency,amount])=>sum+cny(amount,currency),0) : null })),
  }
}
