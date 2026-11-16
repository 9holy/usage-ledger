import { afterEach, expect, it, vi } from 'vitest'
import axios from 'axios'
import { invoke } from '@tauri-apps/api/core'
import { loadConnections, useConnectionStore } from '@/stores/connection'
import { getActiveConnection, setActiveConnection } from '@/api/url'
import { refreshAuthTokens } from '@/api/tokenRefresh'
import { cliproxyIdentity, cliproxyReceipt, sub2apiIdentity, sub2apiReceipt, syncMonitorUpstreams, startMonitorUpstreams } from '../monitorUpstreams'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}))
vi.mock('@/stores/connection',()=>({loadConnections:vi.fn(()=>[]),useConnectionStore:vi.fn()}))
vi.mock('@/api/url',()=>({isDesktopRuntime:()=>true,PROXY_PORT:18765,getActiveConnection:vi.fn(()=>null),setActiveConnection:vi.fn(),authConnectionBindingMatches:vi.fn(()=>false)}))
vi.mock('@/api/tokenRefresh',()=>({refreshAuthTokens:vi.fn()}))
vi.mock('@/api/desktopProxy',()=>({getDesktopProxyHeaders:vi.fn(async target=>({'X-Target-Base':target,'X-Proxy-Token':'fixture-capability'}))}))
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();localStorage.clear()})

it('uses provider account and organization IDs, never the matching display email',()=>{
  expect(sub2apiIdentity({id:1,platform:'openai',type:'oauth',name:'same@email.test',credentials:{email:'same@email.test'}})).toBeNull()
  const one=sub2apiIdentity({id:1,platform:'openai',type:'oauth',name:'same@email.test',credentials:{chatgpt_account_id:'native-a'}})!
  const two=sub2apiIdentity({id:1,platform:'openai',type:'oauth',name:'same@email.test',credentials:{chatgpt_account_id:'native-b'}})!
  expect(one.accountId).not.toBe(two.accountId)
  expect(cliproxyIdentity({auth_index:'same-local-id',provider:'codex',account_type:'oauth',email:'same@email.test',id_token:{chatgpt_account_id:'native-a'}})).toMatchObject({accountId:'native-a',subscription:true})
  expect(cliproxyIdentity({auth_index:'same-local-id',provider:'codex',email:'same@email.test'})).toBeNull()
  expect(sub2apiIdentity({id:3,platform:'anthropic',type:'oauth',credentials:{account_uuid:'user',organization_uuid:'organization-a'}})).toMatchObject({tool:'claude',accountId:'user',organizationId:'organization-a'})
  expect(sub2apiIdentity({id:3,platform:'anthropic',type:'oauth',credentials:{account_uuid:'user'}})).toBeNull()
  expect(sub2apiIdentity({id:1,platform:'openai',type:'oauth',created_at:'2026-11-15T14:58:05+08:00',credentials:{chatgpt_account_id:'native-a'}})?.createdAtMs).toBe(Date.parse('2026-11-15T14:58:05+08:00'))
})

it('keeps inclusive token semantics and refuses absent or unrelated request evidence',()=>{
  const row={id:1,account_id:3,request_id:'native-request',session_id:'client-session',model:'model',created_at:'2026-11-16T10:00:00Z',input_tokens:60,output_tokens:20,cache_read_tokens:30,cache_creation_tokens:10}
  expect(sub2apiReceipt(row)).toMatchObject({inputTokens:100,cacheReadTokens:30,cacheWriteTokens:10,requestId:'native-request',sessionId:'client-session'})
  expect(sub2apiReceipt({...row,user_agent:'Codex Desktop/0.167',duration_ms:3000})).toMatchObject({details:{clientTool:'codex',requestedMode:'standard',durationMs:3000}})
  expect(sub2apiReceipt({...row,user_agent:'custom-client/1',service_tier:'priority'})).toMatchObject({details:{clientTool:'api',requestedMode:'fast'}})
  expect(sub2apiReceipt({...row,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0,total_cost:0.01})).toMatchObject({details:{nonToken:true}})
  expect(sub2apiReceipt({...row,cache_read_tokens:null})).toBeNull()
  expect(sub2apiReceipt({...row,request_id:''})).toBeNull()
  const cpa={id:4,requested_at:1000,provider:'codex',executor_type:'CodexExecutor',model:'model',auth_index:'local',failed:false,input_tokens:100,output_tokens:20,reasoning_tokens:4,cached_tokens:40,cache_read_tokens:40,cache_creation_tokens:0} as CliproxyUsageEvent & Record<string,unknown>
  expect(cliproxyReceipt(cpa)).toBeNull()
  expect(cliproxyReceipt({...cpa,response_id:'response-native'})).toMatchObject({inputTokens:100,outputTokens:20,requestId:'response-native'})
  expect(cliproxyReceipt({...cpa,session_id:'client-session',requested_at:1000.75})).toMatchObject({sessionId:'client-session',requestId:'',timestampMs:1000})
})

it('displays credential emails for equally named Sub2API accounts and keeps identity separate',()=>{
  const base={platform:'openai',type:'oauth',name:'11-12'}
  const one=sub2apiIdentity({...base,id:1,credentials:{chatgpt_account_id:'native-a',email:'first@example.test'}})!
  const two=sub2apiIdentity({...base,id:2,credentials:{chatgpt_account_id:'native-b',email:'second@example.test'}})!
  expect(one).toMatchObject({accountId:'native-a',label:'first@example.test'})
  expect(two).toMatchObject({accountId:'native-b',label:'second@example.test'})
  expect(sub2apiIdentity({...base,id:1,credentials:{chatgpt_account_id:'native-a'}})?.label).toBe('native-a')
})

it('keeps upstream quota percentages, resets and timestamps from the same source observation',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T12:30:00Z'))
  try {
  const version='1794831691112475780'
  const extra={codex_7d_used_percent:27,codex_7d_window_minutes:10080,codex_7d_reset_at:'2026-11-23T09:49:49+08:00',codex_primary_window_minutes:10080,codex_usage_updated_at:'2026-11-16T12:21:31Z',codex_usage_field_versions:{codex_7d_used_percent:version,codex_7d_window_minutes:version,codex_7d_reset_at:version}}
  const row={id:1,platform:'openai',type:'oauth',quota_dimension:'global',credentials:{chatgpt_account_id:'native-a',email:'a@example.test',subscription_expires_at:'2026-12-11T21:40:44Z'},extra}
  expect(sub2apiIdentity(row)).toMatchObject({subscriptionEndMs:Date.parse('2026-12-11T21:40:44Z'),quotas:[{slot:'primary',windowMinutes:10080,usedPercent:27,observedAtMs:1794831691112,resetsAtMs:Date.parse(extra.codex_7d_reset_at)}]})
  expect(sub2apiIdentity({...row,extra:{...extra,codex_usage_field_versions:{...extra.codex_usage_field_versions,codex_7d_reset_at:'1794831692112475780'}}})?.quotas).toEqual([])
  expect(sub2apiIdentity({...row,extra:{...extra,codex_7d_used_percent:null}})?.quotas).toEqual([])
  expect(sub2apiIdentity({...row,quota_dimension:'spark'})?.quotas).toEqual([])
  } finally {vi.useRealTimers()}
})

it('keeps syncing identities when saved CLIProxy rows lack correlation fields',async()=>{
  const get=vi.fn(async()=>({data:{files:[{auth_index:'local',provider:'codex',account_type:'oauth',id_token:{chatgpt_account_id:'native-a'}}]}}))
  vi.spyOn(axios,'create').mockReturnValue({get} as unknown as ReturnType<typeof axios.create>)
  vi.mocked(loadConnections).mockReturnValue([{id:'missing-reference',type:'cliproxy',name:'CLIProxy',baseUrl:'http://127.0.0.1:8317',apiKey:'',secretKey:'fixture',lastUsed:0}])
  vi.mocked(invoke).mockImplementation(async command=>command==='read_cliproxy_usage_events'?JSON.stringify({available:true,events:[{id:1,failed:false}]}):{matched:0,accepted:0,awaitingIdentity:0})
  const result=await syncMonitorUpstreams()
  expect(result.errors).toEqual(['CLIProxyAPI'])
  expect(invoke).toHaveBeenCalledWith('usage_monitor_sync_upstream',expect.objectContaining({batch:expect.objectContaining({accounts:[expect.objectContaining({accountId:'native-a'})],receipts:[]})}))
})

it('collects upstream evidence in the background and stops with the application',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T03:00:00Z'))
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
  const get=vi.fn(async()=>({data:{files:[]}}))
  vi.spyOn(axios,'create').mockReturnValue({get} as unknown as ReturnType<typeof axios.create>)
  vi.mocked(loadConnections).mockReturnValue([{id:'background-fixture',type:'cliproxy',name:'CLIProxy',baseUrl:'http://127.0.0.1:8317',apiKey:'',secretKey:'fixture',lastUsed:0}])
  vi.mocked(invoke).mockImplementation(async command=>command==='read_cliproxy_usage_events'?JSON.stringify({available:true,events:[]}):{matched:0,accepted:0,awaitingIdentity:0})
  const stop=startMonitorUpstreams()
  try{
    await syncMonitorUpstreams();expect(get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000);expect(get).toHaveBeenCalledTimes(2)
    stop();await vi.advanceTimersByTimeAsync(120_000);expect(get).toHaveBeenCalledTimes(2)
  }finally{stop();vi.useRealTimers()}
})

it('reads saved CLIProxy history without consuming the destructive usage queue',async()=>{
  const get=vi.fn(async(_path:string)=>({data:{files:[{auth_index:'local',provider:'codex',account_type:'oauth',id_token:{chatgpt_account_id:'native-a'}}]}}))
  vi.spyOn(axios,'create').mockReturnValue({get} as unknown as ReturnType<typeof axios.create>)
  vi.mocked(loadConnections).mockReturnValue([{id:'local-fixture',type:'cliproxy',name:'CLIProxy',baseUrl:'http://127.0.0.1:8317',apiKey:'',secretKey:'fixture',lastUsed:0}])
  vi.mocked(invoke).mockImplementation(async command=>command==='read_cliproxy_usage_events'?JSON.stringify({available:true,events:[]}):{matched:0,accepted:0,awaitingIdentity:0})
  await syncMonitorUpstreams()
  expect(get.mock.calls.map(call=>call[0])).toEqual(['/auth-files'])
  expect(invoke).toHaveBeenCalledWith('usage_monitor_sync_upstream',expect.objectContaining({batch:expect.objectContaining({source:'cliproxy',accounts:[expect.objectContaining({accountId:'native-a'})]})}))
  await syncMonitorUpstreams();expect(get).toHaveBeenCalledTimes(1)
})

it('waits out a source authorization ban and can recover with the same valid configuration',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
  try{
    const denied=Object.assign(new Error('denied'),{isAxiosError:true,response:{status:403}})
    const get=vi.fn().mockRejectedValueOnce(denied).mockResolvedValue({data:{files:[]}})
    vi.spyOn(axios,'create').mockReturnValue({get} as unknown as ReturnType<typeof axios.create>)
    vi.mocked(loadConnections).mockReturnValue([{id:'ban-fixture',type:'cliproxy',name:'CLIProxy',baseUrl:'http://127.0.0.1:8317',apiKey:'',secretKey:'unchanged',lastUsed:0}])
    vi.mocked(invoke).mockImplementation(async command=>command==='read_cliproxy_usage_events'?JSON.stringify({available:true,events:[]}):{matched:0,accepted:0,awaitingIdentity:0})
    expect((await syncMonitorUpstreams()).errors).toContain('CLIProxyAPI')
    vi.setSystemTime(new Date('2026-11-16T00:01:00Z'));await syncMonitorUpstreams();expect(get).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-11-16T00:31:00Z'));expect((await syncMonitorUpstreams()).errors).toEqual([]);expect(get).toHaveBeenCalledTimes(2)
  }finally{vi.useRealTimers()}
})

it('resumes old source pages while continuing recent reads instead of dropping everything older than ten minutes',async()=>{
  vi.useFakeTimers();const now=Date.parse('2026-11-17T12:00:00Z');vi.setSystemTime(now)
  let cursor={nextPage:1,startMs:now-1000*60_000,endMs:now,complete:false,lastSyncMs:now}
  const get=vi.fn(async(path:string,config?:{params?:{page:number}})=>path==='/admin/accounts'
    ? {data:{code:0,data:{items:[{id:1,platform:'openai',type:'oauth',credentials:{chatgpt_account_id:'native-a'}}],total:1}}}
    : path==='/admin/audit-logs'?{data:{code:0,data:{items:[{id:7,status_code:200,created_at:new Date(now-60000).toISOString(),extra:{account_id:1,result_code:'success',trigger_window:'5h+7d'}}]}}}
    : {data:{code:0,data:{items:Array.from({length:100},(_,index)=>{const id=((config?.params?.page??1)-1)*100+index;return{id,account_id:1,request_id:'gateway-'+id,session_id:'thread',model:'model',created_at:new Date(now-id*60_000).toISOString(),duration_ms:1000,input_tokens:60,output_tokens:20,cache_read_tokens:40,cache_creation_tokens:0}})}}})
  vi.spyOn(axios,'create').mockReturnValue({get} as unknown as ReturnType<typeof axios.create>)
  vi.mocked(loadConnections).mockReturnValue([{id:'history-fixture',type:'sub2api',name:'Sub2API',baseUrl:'https://history.test',authMode:'apikey',apiKey:'fixture',lastUsed:0}])
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='usage_monitor_upstream_history')return {...cursor}
    if(command==='usage_monitor_sync_upstream'){const next=(args as {batch:{history?:typeof cursor}}).batch.history;if(next)cursor=structuredClone(next);return{matched:0,accepted:0,awaitingIdentity:0}}
    throw Error('Unexpected command '+command)
  })
  try{
    const firstSync=syncMonitorUpstreams();await vi.advanceTimersByTimeAsync(500);await firstSync;expect(cursor.nextPage).toBe(6)
    expect(vi.mocked(invoke).mock.calls.filter(call=>call[0]==='usage_monitor_sync_upstream').at(-1)?.[1]).toMatchObject({batch:{accounts:[expect.objectContaining({resets:[{id:'7',atMs:now-60000}]})]}})
    const firstParts=vi.mocked(invoke).mock.calls.filter(call=>call[0]==='usage_monitor_sync_upstream').map(call=>(call[1] as {batch:{receipts:Array<{eventId:string}>;history?:unknown}}).batch)
    expect(firstParts.flatMap(part=>part.receipts)).toEqual(expect.arrayContaining([expect.objectContaining({eventId:'499'})]))
    expect(firstParts.every(part=>part.receipts.length<=100)).toBe(true)
    expect(firstParts.slice(0,-1).every(part=>!part.history)).toBe(true)
    expect(firstParts[0]).toMatchObject({accounts:[expect.objectContaining({quotas:[],resets:[]})]})
    vi.setSystemTime(now+60_000);const secondSync=syncMonitorUpstreams();await vi.advanceTimersByTimeAsync(1000);await secondSync;expect(cursor.nextPage).toBe(11)
    const historyCall=get.mock.calls.find(call=>call[0]==='/admin/usage'&&call[1]?.params?.page===6)
    expect(historyCall).toBeDefined()
    const batches=vi.mocked(invoke).mock.calls.filter(call=>call[0]==='usage_monitor_sync_upstream')
    expect(batches.at(-1)?.[1]).toMatchObject({batch:{receipts:expect.arrayContaining([expect.objectContaining({eventId:'999'})])}})
  }finally{vi.useRealTimers()}
})

it('renews a bound saved login on the monitoring route without opening the connection page',async()=>{
  const now=Date.now()
  let connection={id:'renew-fixture',type:'sub2api' as const,name:'Sub2API',baseUrl:'https://renew.test',authMode:'login' as const,apiKey:'expired-fixture',tokenExpiresAt:now-1000,lastUsed:0}
  let active:typeof connection|null=null
  localStorage.setItem('auth_token',connection.apiKey);localStorage.setItem('refresh_token','refresh-fixture')
  vi.mocked(loadConnections).mockImplementation(()=>[connection])
  vi.mocked(getActiveConnection).mockImplementation(()=>active)
  vi.mocked(setActiveConnection).mockImplementation(value=>{active=value as typeof connection|null})
  vi.mocked(useConnectionStore).mockReturnValue({activeId:connection.id,active:connection} as unknown as ReturnType<typeof useConnectionStore>)
  vi.mocked(refreshAuthTokens).mockImplementation(async()=>{connection={...connection,apiKey:'renewed-fixture',tokenExpiresAt:now+3600000};return{access_token:connection.apiKey,refresh_token:'next-refresh-fixture',expires_in:3600,token_type:'Bearer'}})
  vi.spyOn(axios,'create').mockReturnValue({get:vi.fn(async()=>({data:{code:0,data:{items:[],total:0}}}))} as unknown as ReturnType<typeof axios.create>)
  vi.mocked(invoke).mockImplementation(async command=>command==='usage_monitor_upstream_history'?{nextPage:1,startMs:now-600000,endMs:now,complete:true,lastSyncMs:now}:{matched:0,accepted:0,awaitingIdentity:0})
  const hash=location.hash
  try{
    expect((await syncMonitorUpstreams()).errors).toEqual([])
    expect(refreshAuthTokens).toHaveBeenCalledOnce()
    expect(axios.create).toHaveBeenLastCalledWith(expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer renewed-fixture'})}))
    expect(location.hash).toBe(hash)
  }finally{vi.mocked(getActiveConnection).mockReturnValue(null)}
})

it('keeps checking new reset events after historical collection has completed',async()=>{
  vi.useFakeTimers();const now=Date.parse('2026-11-17T08:00:00Z');vi.setSystemTime(now)
  const get=vi.fn(async(path:string)=>({data:{code:0,data:{items:path==='/admin/accounts'?[{id:1,platform:'openai',type:'oauth',credentials:{chatgpt_account_id:'native-a'}}]:path==='/admin/audit-logs'?[{id:9,status_code:200,created_at:new Date(now-20000).toISOString(),extra:{account_id:1,result_code:'success',trigger_window:'7d'}}]:[],total:0}}}))
  vi.spyOn(axios,'create').mockReturnValue({get} as unknown as ReturnType<typeof axios.create>)
  vi.mocked(loadConnections).mockReturnValue([{id:'ongoing-reset-fixture',type:'sub2api',name:'Sub2API',baseUrl:'https://ongoing-reset.test',authMode:'apikey',apiKey:'fixture',lastUsed:0}])
  vi.mocked(invoke).mockImplementation(async command=>command==='usage_monitor_upstream_history'?{nextPage:100,startMs:now-86400000,endMs:now-3600000,complete:true,lastSyncMs:now-60000,resetCheckedMs:now-60000}:{matched:0,accepted:0,awaitingIdentity:0})
  try{
    await syncMonitorUpstreams()
    expect(get).toHaveBeenCalledWith('/admin/audit-logs',expect.objectContaining({params:expect.objectContaining({start_time:new Date(now-120000).toISOString(),end_time:new Date(now).toISOString()})}))
    expect(invoke).toHaveBeenCalledWith('usage_monitor_sync_upstream',expect.objectContaining({batch:expect.objectContaining({accounts:[expect.objectContaining({resets:[{id:'9',atMs:now-20000}]})],history:expect.objectContaining({complete:true,resetCheckedMs:now})})}))
  }finally{vi.useRealTimers()}
})
