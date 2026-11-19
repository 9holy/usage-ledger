import './usageI18nFixture'
import {flushPromises,mount} from '@vue/test-utils'
import {expect,it,vi} from 'vitest'
import UsageCostAccounts from '../UsageCostAccounts.vue'
import {localCostMetrics} from '../localCostMath'
import type {MonitorCostSnapshot} from '../useMonitorCosts'
import type {MonitorTotals} from '@/api/usageMonitor'
import {setUsageAccountName} from '@/api/usageAccounts'

vi.mock('@/api/usageAccounts',()=>({setUsageAccountName:vi.fn().mockResolvedValue(undefined)}))
function data():MonitorCostSnapshot{
  const totals:MonitorTotals={inputTokens:100,outputTokens:20,totalTokens:120,cacheReadTokens:0,cacheWriteTokens:0,requestCount:1,pricedCostUsd:1.23456789,unpricedRequests:0,incompleteRequests:0,cacheHitRatio:0,outputTokensPerSecond:0,automaticPriceSummary:{byCurrency:{USD:{requestedSubtotal:1.23456789,requestedRequests:1,responseSubtotal:0,responseRequests:0,unknownReferenceSubtotal:0,unknownReferenceRequests:0}},byMode:{standard:{requestedRequests:1,responseRequests:0,unknownRequests:0,coveredRequests:1,byCurrency:{USD:{amount:1.23456789,requestCount:1}}}}}}
  return {report:{startMs:1,endMs:10000,settings:{cnyPerUsd:7,accounts:{},apiRules:[]},purchases:{},apiExpense:{byCurrency:{},pricedRequests:0,missingRequests:1},accounts:[{id:'api:all',label:'API',tool:'api',totals,verifiedRequests:1,referenceRequests:0},{id:'codex:a',label:'Alice',tool:'codex',totals:{...totals,requestCount:2},verifiedRequests:2,referenceRequests:0}]},finances:{events:[],totalEvents:0,purchaseChannels:[],planLabels:[],byAccount:[],summary:{eventCount:0,hasEnteredFacts:false,unresolvedTerminationCount:0,currencies:[]}}}
}
it('preserves all eight original columns, token counts, currency values and client filtering',async()=>{
  const snapshot=data(),rows=snapshot.report.accounts.map(account=>({...account,name:account.label,metrics:localCostMetrics(account,snapshot.report,[])}))
  const wrapper=mount(UsageCostAccounts,{props:{data:snapshot,rows,saving:false,saveSettings:vi.fn()}})
  expect(wrapper.findAll('thead th')).toHaveLength(8)
  expect(wrapper.get('thead').text()).toContain('请求 / Token')
  expect(wrapper.get('[data-account-key="api:all"]').findAll('td')[2].text()).toContain('120 Token')
  expect(wrapper.get('[data-account-key="api:all"]').findAll('td')[3].text()).toContain('$1.234568')
  expect(wrapper.get('[data-account-key="api:all"] .usage-cny-value').exists()).toBe(true)
  await wrapper.get('[aria-label="客户端"]').setValue('codex')
  expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  expect(wrapper.get('tbody').text()).toContain('Alice')
  expect(wrapper.get('.accounts-heading h2').text()).toContain('2')
  wrapper.unmount()
})

it('filters by the actual client while keeping one upstream account identity',async()=>{
  const snapshot=data();snapshot.report.accounts[0].clientTools=['codex'];snapshot.report.accounts[1].clientTools=['claude']
  const rows=snapshot.report.accounts.map(account=>({...account,name:account.label,metrics:localCostMetrics(account,snapshot.report,[])}))
  const wrapper=mount(UsageCostAccounts,{props:{data:snapshot,rows,saving:false,saveSettings:vi.fn()}})
  await wrapper.get('[aria-label="客户端"]').setValue('claude')
  expect(wrapper.findAll('tbody tr')).toHaveLength(1);expect(wrapper.get('[data-account-key="codex:a"]').text()).toContain('Alice')
  await wrapper.get('[aria-label="客户端"]').setValue('codex')
  expect(wrapper.find('[data-account-key="codex:a"]').exists()).toBe(false);expect(wrapper.get('[data-account-key="api:all"]').exists()).toBe(true)
  wrapper.unmount()
})
it('does not display zero as confirmed usage for a named account without period records', () => {
  const snapshot = data()
  const account = snapshot.report.accounts[1]
  account.totals = { ...account.totals, requestCount: 0, totalTokens: 0 }
  account.verifiedRequests = 0
  const row = { ...account, name: account.label, metrics: localCostMetrics(account, snapshot.report, []) }
  const wrapper = mount(UsageCostAccounts, { props: { data: snapshot, rows: [row], saving: false, saveSettings: vi.fn() } })
  expect(wrapper.get('[data-account-key="codex:a"]').findAll('td')[2].text()).toBe('本期无已确认用量')
  wrapper.unmount()
})
it('keeps name editing, account status, records and expense entry on the same stable row',async()=>{
  const snapshot=data(),rows=snapshot.report.accounts.map(account=>({...account,name:account.label,metrics:localCostMetrics(account,snapshot.report,[])})),save=vi.fn().mockResolvedValue(undefined)
  const wrapper=mount(UsageCostAccounts,{props:{data:snapshot,rows,saving:false,saveSettings:save}})
  const row=wrapper.get('[data-account-key="codex:a"]')
  await row.get('[title="设置账号名称"]').trigger('click');await row.get('.name-editor input').setValue('Renamed');await row.get('.name-editor').trigger('submit');await flushPromises()
  expect(setUsageAccountName).toHaveBeenCalledWith('codex:a','Renamed')
  await row.get('.row-actions [title="账号状态"]').trigger('click');await row.get('.status-editor select').setValue('banned');await row.get('.status-editor').trigger('submit');await flushPromises()
  expect(save).toHaveBeenCalledWith(expect.objectContaining({accounts:{'codex:a':expect.objectContaining({status:'banned'})}}))
  await row.get('[title="录入此账号费用"]').trigger('click')
  expect(wrapper.emitted('record')?.at(-1)).toEqual(['codex:a',true])
  await row.get('[title="费用记录"]').trigger('click')
  expect(wrapper.emitted('record')?.at(-1)).toEqual(['codex:a',false])
  wrapper.unmount()
})
