import './usageI18nFixture'
import { computed, h, ref, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMonitorCosts } from '../useMonitorCosts'
import { getLocalCostReport, type LocalCostReport } from '@/api/localCost'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'
import { monitorUpstreamRevision } from '@/api/monitorUpstreams'

vi.mock('@/api/localCost',async original=>({...await original<typeof import('@/api/localCost')>(),getLocalCostReport:vi.fn(),saveLocalCostSettings:vi.fn()}))
vi.mock('@/api/financeLedger',()=>({getFinanceLedger:vi.fn()}))
vi.mock('@/api/monitorUpstreams',async()=>{const {ref}=await import('vue');return{monitorUpstreamRevision:ref(0),monitorUpstreamStatus:ref({errors:[]})}})
const finances=():FinanceSnapshot=>({events:[],totalEvents:0,purchaseChannels:[],planLabels:[],byAccount:[],summary:{eventCount:0,hasEnteredFacts:false,unresolvedTerminationCount:0,currencies:[]}})
const report=(startMs=100,endMs=200):LocalCostReport=>({startMs,endMs,settings:{cnyPerUsd:7,apiRules:[],accounts:{}},purchases:{},apiExpense:{byCurrency:{USD:10},pricedRequests:1,missingRequests:0},accounts:[{id:'api:all',label:'API',tool:'api',verifiedRequests:1,referenceRequests:0,totals:{inputTokens:100,outputTokens:20,totalTokens:120,cacheReadTokens:0,cacheWriteTokens:0,requestCount:1,pricedCostUsd:50,unpricedRequests:0,incompleteRequests:0,cacheHitRatio:0,outputTokensPerSecond:0,automaticPriceSummary:{byCurrency:{USD:{requestedSubtotal:50,requestedRequests:1,responseSubtotal:0,responseRequests:0,unknownReferenceSubtotal:0,unknownReferenceRequests:0}},byMode:{standard:{requestedRequests:1,responseRequests:0,unknownRequests:0,coveredRequests:1,byCurrency:{USD:{amount:50,requestCount:1}}}}}}}]})
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();vi.mocked(getLocalCostReport).mockResolvedValue(report());vi.mocked(getFinanceLedger).mockResolvedValue(finances())})
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})

it('pairs cost and usage dates, keeps API costs separate and avoids a scan on live updates',async()=>{
  const period=ref({startMs:100,endMs:200}),key=ref('today'),enabled=ref(true)
  let costs!:ReturnType<typeof useMonitorCosts>
  const wrapper=mount({setup(){costs=useMonitorCosts(()=>period.value,key,enabled);return()=>h('div')}})
  try{
    await flushPromises()
    expect(getLocalCostReport).toHaveBeenCalledWith(100,200)
    expect(getFinanceLedger).toHaveBeenCalledWith(expect.objectContaining({source:'local',instanceId:'usage-monitor',startMs:100,endMs:200}))
    expect(costs.rows.value[0].metrics).toMatchObject({valueCny:350,expenseCny:70,factor:.2})
    period.value={startMs:100,endMs:250};await vi.advanceTimersByTimeAsync(2000)
    expect(getLocalCostReport).toHaveBeenCalledTimes(1)
    enabled.value=false;await flushPromises();await vi.advanceTimersByTimeAsync(60000)
    expect(getLocalCostReport).toHaveBeenCalledTimes(1)
  }finally{wrapper.unmount()}
})

it('discards an older response after a date change and retains the last paired snapshot on failure',async()=>{
  let oldReport!:(value:LocalCostReport)=>void
  vi.mocked(getLocalCostReport).mockImplementationOnce(()=>new Promise(resolve=>{oldReport=resolve})).mockResolvedValueOnce(report(1000,2000))
  const period=ref({startMs:100,endMs:200}),key=ref('today'),enabled=ref(true)
  let costs!:ReturnType<typeof useMonitorCosts>
  const wrapper=mount({setup(){costs=useMonitorCosts(()=>period.value,key,enabled);return()=>h('div')}})
  try{
    period.value={startMs:1000,endMs:2000};key.value='month';await flushPromises()
    expect(costs.data.value?.report.endMs).toBe(2000)
    oldReport(report());await flushPromises();expect(costs.data.value?.report.endMs).toBe(2000)
    vi.mocked(getLocalCostReport).mockRejectedValueOnce(Error('read failed'))
    key.value='all';await flushPromises()
    expect(costs.error.value).toBe('read failed')
    expect(costs.data.value?.report.endMs).toBe(2000)
  }finally{wrapper.unmount()}
})

it('waits for the parent period to settle when a range change crosses into a new month',async()=>{
  const before=new Date('2026-11-30T23:59:00').getTime(),after=new Date('2026-12-01T00:01:00').getTime()
  vi.setSystemTime(before)
  const range=ref('today'),anchor=ref(before)
  const period=computed(()=>{const day=new Date(anchor.value);return{startMs:new Date(day.getFullYear(),day.getMonth(),range.value==='month'?1:day.getDate()).getTime(),endMs:anchor.value}})
  const wrapper=mount({setup(){useMonitorCosts(()=>period.value,range,ref(true));watch(range,()=>{anchor.value=Date.now()});return()=>h('div')}})
  try{
    await flushPromises();vi.setSystemTime(after);range.value='month';await flushPromises()
    expect(getLocalCostReport).toHaveBeenLastCalledWith(new Date('2026-12-01T00:00:00').getTime(),after)
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({startMs:new Date('2026-12-01T00:00:00').getTime(),endMs:after}))
  }finally{wrapper.unmount()}
})

it('pauses accounting reads while hidden and resumes with a fresh paired read',async()=>{
  let visibility:DocumentVisibilityState='visible'
  vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility)
  const period=ref({startMs:100,endMs:200}),key=ref('today'),enabled=ref(true)
  const wrapper=mount({setup(){useMonitorCosts(()=>period.value,key,enabled);return()=>h('div')}})
  try{
    await flushPromises();expect(getLocalCostReport).toHaveBeenCalledTimes(1)
    visibility='hidden';document.dispatchEvent(new Event('visibilitychange'));await flushPromises();await vi.advanceTimersByTimeAsync(65000)
    expect(getLocalCostReport).toHaveBeenCalledTimes(1)
    period.value={startMs:100,endMs:300};visibility='visible';document.dispatchEvent(new Event('visibilitychange'));await flushPromises()
    expect(getLocalCostReport).toHaveBeenLastCalledWith(100,300)
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({startMs:100,endMs:300}))
  }finally{wrapper.unmount()}
})

it('refreshes its own current-period cutoff while historical analysis is idle',async()=>{
  const start=new Date('2026-11-15T10:00:00').getTime();vi.setSystemTime(start)
  const wrapper=mount({setup(){useMonitorCosts(()=>({startMs:100,endMs:Date.now()}),ref('all'),ref(true));return()=>h('div')}})
  try{
    await flushPromises();expect(getLocalCostReport).toHaveBeenLastCalledWith(100,start)
    await vi.advanceTimersByTimeAsync(60000)
    expect(getLocalCostReport).toHaveBeenLastCalledWith(100,start+60000)
    expect(getFinanceLedger).toHaveBeenLastCalledWith(expect.objectContaining({startMs:100,endMs:start+60000}))
    expect(getLocalCostReport).toHaveBeenCalledTimes(2)
  }finally{wrapper.unmount()}
})

it('refreshes accounting after background ownership changes without starting another source poll',async()=>{
  const wrapper=mount({setup(){useMonitorCosts(()=>({startMs:100,endMs:200}),ref('all'),ref(true));return()=>h('div')}})
  try{
    await flushPromises();expect(getLocalCostReport).toHaveBeenCalledTimes(1)
    monitorUpstreamRevision.value++;await flushPromises()
    expect(getLocalCostReport).toHaveBeenCalledTimes(2)
  }finally{wrapper.unmount()}
})
