import './usageI18nFixture'
import {flushPromises,mount} from '@vue/test-utils'
import {beforeEach,expect,it,vi} from 'vitest'
import UsageAccountCost from '../UsageAccountCost.vue'
import UsageApiPrices from '../UsageApiPrices.vue'
import {setUsageAccountName} from '@/api/usageAccounts'
import {localCostMetrics} from '../localCostMath'
import type {MonitorCostSnapshot} from '../useMonitorCosts'

vi.mock('@/api/usageAccounts',()=>({setUsageAccountName:vi.fn().mockResolvedValue(undefined)}))
beforeEach(()=>vi.clearAllMocks())
function snapshot():MonitorCostSnapshot {
  return {report:{startMs:1,endMs:10000,settings:{cnyPerUsd:7,accounts:{},apiRules:[]},apiExpense:{byCurrency:{},pricedRequests:0,missingRequests:0},purchases:{},accounts:[{id:'codex:stable',label:'Alice',tool:'codex',verifiedRequests:1,referenceRequests:0,totals:{inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheWriteTokens:0,requestCount:0,pricedCostUsd:0,unpricedRequests:0,incompleteRequests:0,cacheHitRatio:null,outputTokensPerSecond:0}}]},finances:{events:[],totalEvents:0,purchaseChannels:[],planLabels:[],byAccount:[],summary:{eventCount:0,hasEnteredFacts:false,unresolvedTerminationCount:0,currencies:[]}}}
}
it('renames the selected stable identity without silently activating an unknown account',async()=>{
  const data=snapshot(),account=data.report.accounts[0],save=vi.fn().mockResolvedValue(undefined)
  const row={...account,name:'Codex · Alice',metrics:localCostMetrics(account,data.report,[])}
  const wrapper=mount(UsageAccountCost,{props:{data,row,saving:false,saveSettings:save}})
  await wrapper.get('[title="设置账号名称"]').trigger('click')
  expect(wrapper.get('select').element.value).toBe('unknown')
  await wrapper.get('input').setValue('Alice renamed');await wrapper.get('form').trigger('submit');await flushPromises()
  expect(setUsageAccountName).toHaveBeenCalledWith('codex:stable','Alice renamed')
  expect(save).not.toHaveBeenCalled()
  wrapper.unmount()
})
it('changes only the selected account status and retains the other account settings',async()=>{
  const data=snapshot();data.report.settings.accounts={'codex:stable':{status:'active',updatedAtMs:1},'claude:other':{status:'inactive',updatedAtMs:2}}
  const account=data.report.accounts[0],save=vi.fn().mockResolvedValue(undefined)
  const wrapper=mount(UsageAccountCost,{props:{data,row:{...account,name:'Alice',metrics:localCostMetrics(account,data.report,[])},saving:false,saveSettings:save}})
  await wrapper.get('[title="设置账号名称"]').trigger('click');await wrapper.get('select').setValue('banned');await wrapper.get('form').trigger('submit');await flushPromises()
  expect(save).toHaveBeenCalledWith(expect.objectContaining({apiRules:[],accounts:{'codex:stable':expect.objectContaining({status:'banned'}),'claude:other':{status:'inactive',updatedAtMs:2}}}))
  expect(setUsageAccountName).not.toHaveBeenCalled()
  wrapper.unmount()
})
it('saves all API rate fields without removing existing rules or account states',async()=>{
  const settings=snapshot().report.settings;settings.accounts={'codex:stable':{status:'active',updatedAtMs:1}}
  settings.apiRules=[{model:'existing',startMs:1,currency:'USD',multiplier:.3,input:null,output:null,cacheRead:null,cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null}]
  const save=vi.fn().mockResolvedValue(undefined),wrapper=mount(UsageApiPrices,{props:{settings,saving:false,saveSettings:save}})
  await wrapper.get('.monitor-api-prices>header button').trigger('click')
  await wrapper.get('.monitor-price-fields input:not([type])').setValue('gpt-6.1-terra')
  await wrapper.get('input[type=datetime-local]').setValue('2026-11-01T00:00')
  await wrapper.get('.monitor-price-fields select').setValue('rates')
  await wrapper.findAll('.monitor-price-fields select')[1].setValue('CNY')
  const fields=wrapper.findAll('.monitor-price-fields input[type=number]')
  for(let i=0;i<fields.length;i++)await fields[i].setValue(['1','2','.1','.2','.5','1'][i])
  await wrapper.get('.monitor-price-editor').trigger('submit');await flushPromises()
  expect(save).toHaveBeenCalledWith(expect.objectContaining({accounts:settings.accounts,apiRules:[settings.apiRules[0],expect.objectContaining({model:'gpt-6.1-terra',currency:'CNY',multiplier:null,input:1,output:2,cacheRead:.1,cacheWrite:.2,cacheWrite5m:.5,cacheWrite1h:1})]}))
  wrapper.unmount()
})

it('keeps an unsaved API rule open when saving the exchange rate',async()=>{
  const settings=snapshot().report.settings,save=vi.fn().mockResolvedValue(undefined)
  const wrapper=mount(UsageApiPrices,{props:{settings,saving:false,saveSettings:save}})
  await wrapper.get('.monitor-api-prices>header button').trigger('click')
  await wrapper.get('.monitor-price-fields input:not([type])').setValue('unsaved-model')
  await wrapper.get('.monitor-exchange input').setValue('7.25')
  await wrapper.get('.monitor-exchange').trigger('submit');await flushPromises()
  expect(save).toHaveBeenCalledWith({...settings,cnyPerUsd:7.25})
  expect(wrapper.get('.monitor-price-editor input:not([type])').element.value).toBe('unsaved-model')
  wrapper.unmount()
})

it('shows missing API cost prices with a working setup action and no prepaid balance',async()=>{
  const data=snapshot(),account={...data.report.accounts[0],id:'api:all',tool:'api',label:'API'}
  data.report.apiExpense={byCurrency:{USD:1},pricedRequests:1,missingRequests:2}
  const wrapper=mount(UsageAccountCost,{props:{data,row:{...account,name:'API',metrics:localCostMetrics(account,data.report,[])},saving:false,saveSettings:vi.fn()}})
  expect(wrapper.get('.account-cost-figures').text()).not.toContain('剩余价值')
  expect(wrapper.get('.account-cost-missing').text()).toContain('2 次调用缺少成本价格')
  await wrapper.get('.account-cost-missing button').trigger('click')
  expect(wrapper.emitted('prices')).toHaveLength(1)
  wrapper.unmount()
})

it('keeps compact account costs tied to the stable account ID and saved period',async()=>{
  const data=snapshot(),account=data.report.accounts[0]
  const wrapper=mount(UsageAccountCost,{props:{data,row:{...account,name:'Alice',metrics:localCostMetrics(account,data.report,[])},saving:false,saveSettings:vi.fn(),compact:true}})
  expect(wrapper.get('.account-cost-inline').attributes('data-account-key')).toBe('codex:stable')
  expect(wrapper.get('.account-cost-inline').attributes('data-end-ms')).toBe('10000')
  expect(wrapper.find('.account-cost-figures').exists()).toBe(false)
  await wrapper.get('.inline-cost-action button').trigger('click')
  expect(wrapper.emitted('record')).toEqual([['codex:stable',true]])
  await wrapper.get('.account-cost-inline header button').trigger('click')
  expect(wrapper.emitted('inspect')).toEqual([['codex:stable']])
  wrapper.unmount()
})
