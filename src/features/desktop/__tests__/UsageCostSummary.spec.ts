import './usageI18nFixture'
import {mount} from '@vue/test-utils'
import {expect,it} from 'vitest'
import UsageCostSummary from '../UsageCostSummary.vue'
import UsageCostInsights from '../UsageCostInsights.vue'
import {localCostMetrics,localCostOverview} from '../localCostMath'
import type {MonitorCostSnapshot} from '../useMonitorCosts'
import type {FinanceAccountSummary} from '@/api/financeLedger'

function snapshot() {
  const finance:FinanceAccountSummary={accountId:'codex:a',currency:'CNY',cashOutlay:30,refunds:5,accruedExpense:15,recognizedLoss:2,expenseCredits:1,netExpense:16,remainingPrepaid:80,ongoingHourlyExpense:0,unresolvedCount:0,hasEnteredFacts:true,terminationLoss:2,amortizedExpense:15,missingCoverageCount:0,coverageIntervals:[],lifetimeCoverageIntervals:[],lifetimeAccruedExpense:15,lifetimeRecognizedLoss:2,lifetimeExpenseCredits:1}
  const data:MonitorCostSnapshot={report:{startMs:1,endMs:10000,settings:{cnyPerUsd:7,accounts:{'codex:a':{status:'active',updatedAtMs:1}},apiRules:[]},purchases:{'codex:a':{amount:30,currency:'CNY',coverageStartMs:1,coverageEndMs:10000}},apiExpense:{byCurrency:{},pricedRequests:0,missingRequests:0},accounts:[{id:'codex:a',tool:'codex',label:'Alice',verifiedRequests:1,referenceRequests:0,totals:{inputTokens:500,outputTokens:500,totalTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,requestCount:1,pricedCostUsd:10,unpricedRequests:0,incompleteRequests:0,cacheHitRatio:0,outputTokensPerSecond:0,automaticPriceSummary:{byCurrency:{USD:{requestedSubtotal:10,requestedRequests:1,responseSubtotal:0,responseRequests:0,unknownReferenceSubtotal:0,unknownReferenceRequests:0}},byMode:{standard:{requestedRequests:1,responseRequests:0,unknownRequests:0,coveredRequests:1,byCurrency:{USD:{amount:10,requestCount:1}}}}}}}]},finances:{events:[],totalEvents:1,purchaseChannels:[],planLabels:[],byAccount:[finance],summary:{eventCount:1,hasEnteredFacts:true,unresolvedTerminationCount:0,currencies:[finance]}}}
  return data
}
function costRows(data:MonitorCostSnapshot) {
  return data.report.accounts.map(account=>({...account,name:account.label,metrics:localCostMetrics(account,data.report,data.finances.byAccount)}))
}
it('keeps paid money, known expense and USD usage distinct in the compact monitor strip',async()=>{
  const data=snapshot();data.report.accounts.push({...data.report.accounts[0],id:'codex:missing',label:'No purchase'})
  const wrapper=mount(UsageCostSummary,{props:{data,rows:costRows(data),scope:'all',compact:true}})
  const values=wrapper.findAll('.strip-values dd').map(el=>el.text())
  expect(values[0]).toContain('30.00');expect(values[1]).toContain('16.00');expect(values[2]).toContain('20.00');expect(values[3]).toBe('0.2286×');expect(values[4]).toContain('80.00')
  expect(wrapper.findAll('.strip-values dt')[1].text()).toContain('已知部分')
  expect(wrapper.get('.monitor-cost-strip').attributes('data-start-ms')).toBe('1')
  expect(wrapper.get('.monitor-cost-strip').attributes('data-end-ms')).toBe('10000')
  expect(wrapper.find('.cost-summary-values').exists()).toBe(false)
  for(const [index,event]of ['accounts','open','channels','prices'].entries()){await wrapper.findAll('.strip-actions button')[index].trigger('click');expect(wrapper.emitted(event)).toHaveLength(1)}
  wrapper.unmount()
})
it('keeps a positive sub-cent usage estimate visible',()=>{
  const data=snapshot(),price=data.report.accounts[0].totals.automaticPriceSummary!
  price.byCurrency.USD.requestedSubtotal=.000012
  price.byMode.standard.byCurrency.USD.amount=.000012
  const wrapper=mount(UsageCostSummary,{props:{data,rows:costRows(data),scope:'all',compact:true}})
  expect(wrapper.get('.strip-usage').text()).toContain('0.000012')
  wrapper.unmount()
})
it('retains subscription expense, credits, refunds, losses and purchase coverage in the shared overview',async()=>{
  const data=snapshot(),rows=costRows(data)
  const wrapper=mount(UsageCostSummary,{props:{data,rows,scope:'all'}})
  const details=new Map(wrapper.findAll('.cost-summary-details>div').map(row=>[row.get('dt').text(),row.get('dd').text()]))
  expect(details.get('订阅费用')).toContain('15.00')
  expect(details.get('费用抵扣')).toContain('1.00')
  expect(details.get('已确认封停损失')).toContain('2.00')
  expect(details.get('退款')).toContain('5.00')
  expect(details.get('已录入买价')).toBe('1 / 1')
  expect(wrapper.findAll('.cost-summary-values strong')[2].text()).toBe('0.2286×')
  await wrapper.get('[aria-label="全部已记录用量"]').trigger('click')
  expect(wrapper.emitted('usage')).toHaveLength(1)
  await wrapper.get('[aria-label="账号成本"]').trigger('click')
  expect(wrapper.emitted('accounts')).toHaveLength(1)
  wrapper.unmount()
})

it('marks a known subtotal when another account has usage but no entered cost',()=>{
  const data=snapshot()
  data.report.accounts.push({...data.report.accounts[0],id:'codex:missing',label:'Missing purchase'})
  const wrapper=mount(UsageCostSummary,{props:{data,rows:costRows(data),scope:'all'}})
  expect(wrapper.findAll('.cost-summary-values strong')[1].text()).toContain('16.00')
  expect(wrapper.get('.cost-completeness').text()).toBe('仅已算出的成本')
  expect(wrapper.text()).toContain('1 个账号参与计算')
  expect(wrapper.text()).toContain('状态未设置')
  wrapper.unmount()
})

it('does not confuse missing valuation evidence with a missing entered cost',()=>{
  const data=snapshot();data.report.accounts[0].referenceRequests=1
  const rows=costRows(data)
  expect(localCostOverview(rows,data.report,data.finances.byAccount)).toMatchObject({partial:true,costIncomplete:false,factor:null})
  const wrapper=mount(UsageCostSummary,{props:{data,rows,scope:'all'}})
  expect(wrapper.find('.cost-completeness').exists()).toBe(false)
  expect(wrapper.text()).toContain('0 个账号参与计算')
  wrapper.unmount()
})

it('keeps ranking, signed expense credits and clear setup actions directly available',async()=>{
  const data=snapshot(),rows=costRows(data),summary=localCostOverview(rows,data.report,data.finances.byAccount)
  const wrapper=mount(UsageCostInsights,{props:{rows,summary}})
  expect(wrapper.find('details').exists()).toBe(false)
  expect(wrapper.get('.cost-rank-row').text()).toContain('Alice')
  expect(wrapper.get('.cost-breakdown').text()).toContain('16.00')
  expect(wrapper.findAll('.cost-breakdown-row')[3].text()).toContain('-')
  expect(wrapper.findAll('.cost-breakdown-row')[3].text()).toContain('1.00')
  await wrapper.get('.cost-rank-row').trigger('click')
  expect(wrapper.emitted('account')).toEqual([['codex:a']])
  await wrapper.get('.cost-entry-actions button').trigger('click')
  expect(wrapper.emitted('enter')).toHaveLength(1)
  wrapper.unmount()
})
