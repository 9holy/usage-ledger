import { describe, expect, it } from 'vitest'
import type { FinanceAccountSummary } from '@/api/financeLedger'
import type { LocalCostAccount, LocalCostReport } from '@/api/localCost'
import { localCostMetrics, localCostOverview } from '../localCostMath'

function localCostFixture(): LocalCostReport {
  const account: LocalCostAccount = {
    id: 'codex:stable-account', label: 'Account 2', tool: 'codex', verifiedRequests: 2, referenceRequests: 0,
    totals: { inputTokens: 800000, outputTokens: 200000, totalTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 2, pricedCostUsd: 100, unpricedRequests: 0, incompleteRequests: 0, cacheHitRatio: 0, outputTokensPerSecond: 0,
      automaticPriceSummary: { byMode: { standard: { requestedRequests: 2, responseRequests: 0, unknownRequests: 0, coveredRequests: 2, byCurrency: { USD: { amount: 100, requestCount: 2 } } } }, byCurrency: { USD: { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: 100, requestedRequests: 2, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 } } } },
  }
  return { settings: { cnyPerUsd: 7, apiRules: [], accounts: {} }, accounts: [account], apiExpense: { byCurrency: {}, pricedRequests: 0, missingRequests: 0 }, purchases: {}, startMs: 1, endMs: 10000 }
}

const expense = (currency: 'CNY' | 'USD', netExpense: number | null, remainingPrepaid: number | null): FinanceAccountSummary => ({
  accountId: 'codex:stable-account', currency, netExpense, remainingPrepaid, cashOutlay: 1000, refunds: 10, accruedExpense: 20, recognizedLoss: 5, expenseCredits: 2, ongoingHourlyExpense: 0, unresolvedCount: 0, hasEnteredFacts: true, terminationLoss: 5, amortizedExpense: 20, missingCoverageCount: 0, coverageIntervals: [], lifetimeCoverageIntervals: [], lifetimeAccruedExpense: 20, lifetimeRecognizedLoss: 5, lifetimeExpenseCredits: 2,
})

describe('local cost metrics', () => {
  it('uses the matched API account expense once and does not count it as a subscription asset',()=>{
    const report=localCostFixture(),account=report.accounts[0]
    account.billingKind='api'
    report.apiExpense={byCurrency:{USD:4},pricedRequests:2,missingRequests:0,byAccount:{[account.id]:{byCurrency:{USD:4},pricedRequests:2,missingRequests:0}}}
    const facts=[expense('CNY',999,50)]
    const row={...account,name:account.label,metrics:localCostMetrics(account,report,facts)}
    expect(row.metrics.expenseCny).toBe(28)
    expect(localCostOverview([row],report,facts)).toMatchObject({subscriptionCount:0,expenseCny:28,apiCny:28,cashOutlayCny:1000})
  })
  it('uses net period expense once, converts currencies, and matches the usage period', () => {
    const report = localCostFixture()
    const metrics = localCostMetrics(report.accounts[0], report, [expense('CNY', 23, 50), expense('USD', 1, 10)])
    expect(metrics).toMatchObject({ expenseCny: 30, valueCny: 700, perMillionTokens: 30, remainingCny: 120, partial: false })
    expect(metrics.factor).toBeCloseTo(30 / 700)
  })

  it('keeps absent or unresolved payments unknown instead of zero or a guessed amount', () => {
    const report = localCostFixture(), account = report.accounts[0]
    expect(localCostMetrics(account, report, []).expenseCny).toBeNull()
    expect(localCostMetrics(account, report, [expense('CNY', null, null)])).toMatchObject({ expenseCny: null, factor: null, remainingCny: null })
    account.referenceRequests = 1
    expect(localCostMetrics(account, report, [expense('CNY', 0, 0)])).toMatchObject({ expenseCny: 0, factor: null, partial: true })
  })

  it('uses API consumption prices without adding cash top-ups and marks missing prices', () => {
    const report = localCostFixture(), account = { ...report.accounts[0], id: 'api:all' }
    report.apiExpense = { byCurrency: { USD: 2, CNY: 3 }, pricedRequests: 1, missingRequests: 1 }
    expect(localCostMetrics(account, report, [{ ...expense('CNY', 999, 0), accountId: 'api:all' }])).toMatchObject({ expenseCny: 17, factor: null, perMillionTokens: null, partial: true })
    report.apiExpense = { byCurrency: {}, pricedRequests: 0, missingRequests: 2 }
    expect(localCostMetrics(account, report, []).expenseCny).toBeNull()
  })

  it('does not divide partially priced API consumption by the full usage value', () => {
    const report=localCostFixture(),account={...report.accounts[0],id:'api:all',tool:'api'}
    report.apiExpense={byCurrency:{USD:10},pricedRequests:1,missingRequests:1}
    const metrics=localCostMetrics(account,report,[])
    expect(metrics).toMatchObject({expenseCny:70,valueCny:700,factor:null,partial:true})
    const overview=localCostOverview([{...account,name:'API',metrics}],report,[])
    expect(overview).toMatchObject({expenseCny:70,valueCny:700,factor:null})
    report.apiExpense={byCurrency:{USD:20},pricedRequests:2,missingRequests:0}
    expect(localCostMetrics(account,report,[]).factor).toBeCloseTo(.2)
  })

  it('keeps overview cost and value paired and excludes API top-ups from expense components', () => {
    const report = localCostFixture()
    report.accounts.push({ ...report.accounts[0], id: 'no-purchase' }, { ...report.accounts[0], id: 'api:all', tool: 'api' })
    report.apiExpense = { byCurrency: { CNY: 14 }, pricedRequests: 2, missingRequests: 0 }
    const facts = [expense('CNY', 23, 50), { ...expense('CNY', 999, 999), accountId: 'api:all' }]
    const rows = report.accounts.map(account => ({ ...account, name: account.label, metrics: localCostMetrics(account, report, facts) }))
    const overview = localCostOverview(rows, report, facts)
    expect(overview).toMatchObject({ expenseCny: 37, valueCny: 2100, remainingCny: 50, accruedCny: 20, lossesCny: 5, creditsCny: 2, apiCny: 14, partial: true, requests: 6, tokens: 3000000 })
    expect(overview.factor).toBeCloseTo(37 / 1400)
    const empty = localCostOverview(rows.map(row => ({ ...row, metrics: { ...row.metrics, expenseCny: null } })), report, [])
    expect(empty.expenseCny).toBeNull()
    expect(empty.remainingCny).toBeNull()
  })
})
