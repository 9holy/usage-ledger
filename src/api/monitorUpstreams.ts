import axios from 'axios'
import { ref, shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { loadConnections, useConnectionStore, type ConnectionConfig } from '@/stores/connection'
import { authConnectionBindingMatches, getActiveConnection, isDesktopRuntime, PROXY_PORT, setActiveConnection } from '@/api/url'
import { refreshAuthTokens } from '@/api/tokenRefresh'
import { getDesktopProxyHeaders } from '@/api/desktopProxy'
import { cliproxyTokenBreakdown, type CliproxyUsageEvent } from '@/api/cliproxy/cpaData'

type Row = Record<string, unknown>
export interface UpstreamQuota { slot: 'primary' | 'secondary'; windowMinutes: number; usedPercent: number; observedAtMs: number; resetsAtMs: number }
export interface UpstreamIdentity { id: string; tool: 'codex' | 'claude'; accountId: string; organizationId?: string; label: string; subscription: boolean; quotaEligible?: boolean; quotaDimension?: string; quotas?: UpstreamQuota[]; subscriptionEndMs?: number; createdAtMs?: number; resets?:Array<{id:string;atMs:number}> }
export interface UpstreamReceipt { eventId: string; account: string; requestId: string; sessionId?: string; model: string; timestampMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; officialAccountId?: string; details?: {requestedMode?:string;clientTool?:string;durationMs?:number;cacheWrite5mTokens?:number;cacheWrite1hTokens?:number;nonToken?:boolean;reportedUsd?:number} }
export interface UpstreamSync { matched: number; accepted: number; awaitingIdentity: number; changed?: boolean; backfilling?: boolean; errors: string[] }
interface HistoryCursor { nextPage: number; startMs: number; endMs: number; complete: boolean; lastSyncMs: number; resetCheckedMs?:number }
export const monitorUpstreamStatus = shallowRef<UpstreamSync>({ matched: 0, accepted: 0, awaitingIdentity: 0, errors: [] })
export const monitorUpstreamRevision = ref(0)
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const object = (value: unknown): Row => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function sub2apiQuotas(extra: Row): UpstreamQuota[] {
  const versions = object(extra.codex_usage_field_versions), result: UpstreamQuota[] = []
  for (const [period, minutes] of [['5h',300],['7d',10080]] as const) {
    const prefix = `codex_${period}`, used = extra[`${prefix}_used_percent`], reset = Date.parse(text(extra[`${prefix}_reset_at`]))
    if (extra[`${prefix}_window_minutes`] !== minutes || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue
    const fields = ['used_percent','reset_at','window_minutes'].map(field => text(versions[`${prefix}_${field}`]))
    let observed = Date.parse(text(extra.codex_usage_updated_at))
    if (fields.some(Boolean)) {
      if (!fields.every(version => version === fields[0]) || !/^\d{1,22}$/.test(fields[0])) continue
      observed = Number(BigInt(fields[0]) / 1_000_000n)
    }
    if (!Number.isSafeInteger(observed) || observed <= 0 || observed > Date.now() + 60_000 || !Number.isSafeInteger(reset) || reset <= observed) continue
    const slot = extra.codex_primary_window_minutes === minutes ? 'primary' : extra.codex_secondary_window_minutes === minutes ? 'secondary' : period === '5h' ? 'primary' : 'secondary'
    result.push({slot,windowMinutes:minutes,usedPercent:used,observedAtMs:observed,resetsAtMs:reset})
  }
  return result
}

export function sub2apiIdentity(row: Row): UpstreamIdentity | null {
  const credentials = object(row.credentials)
  const tool = row.platform === 'openai' ? 'codex' : row.platform === 'anthropic' ? 'claude' : null
  const accountId = text(tool === 'codex' ? credentials.chatgpt_account_id : credentials.account_uuid)
  if (!tool || !accountId || row.id == null || tool === 'claude' && !text(credentials.organization_uuid)) return null
  const subscription = row.type === 'oauth' || row.type === 'setup-token', quotaDimension = text(row.quota_dimension) || 'global', quotaEligible = quotaDimension === 'global' || quotaDimension === 'codex'
  const end = Date.parse(text(credentials.subscription_expires_at))
  const created = Date.parse(text(row.created_at))
  const resetState=object(object(row.extra).codex_auto_reset_credit_state),resetAt=Date.parse(text(resetState.last_result_at))
  return { id: String(row.id), tool, accountId, organizationId: text(credentials.organization_uuid) || undefined, label: text(credentials.email) || accountId, subscription, quotaEligible, quotaDimension,
    quotas: tool === 'codex' && subscription && quotaEligible ? sub2apiQuotas(object(row.extra)) : [],
    subscriptionEndMs: subscription && Number.isSafeInteger(end) && end > 0 ? end : undefined,
    createdAtMs: Number.isSafeInteger(created) && created > 0 ? created : undefined,
    resets:resetState.status==='success'&&text(resetState.trigger_window).split('+').includes('7d')&&Number.isSafeInteger(resetAt)?[{id:'state:'+resetAt,atMs:resetAt}]:undefined }
}

export function cliproxyIdentity(row: Row): UpstreamIdentity | null {
  const claims = object(row.id_token)
  const tool = row.provider === 'codex' || row.provider === 'openai' ? 'codex' : row.provider === 'claude' ? 'claude' : null
  const accountId = text(tool === 'codex' ? claims.chatgpt_account_id : row.account_uuid)
  const id = text(row.auth_index)
  if (!tool || !accountId || !id || tool === 'claude' && !text(row.organization_uuid)) return null
  const kind=text(row.account_type).toLowerCase()
  if (!['oauth', 'apikey', 'api-key', 'setup-token'].includes(kind)) return null
  return { id, tool, accountId, organizationId: text(row.organization_uuid) || undefined, label: text(row.email) || accountId, subscription: kind === 'oauth' || kind === 'setup-token' }
}

export function sub2apiReceipt(row: Row): UpstreamReceipt | null {
  const values = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens]
  const requestId = text(row.response_id) || text(row.request_id)
  const timestampMs = new Date(String(row.created_at ?? '')).getTime()
  if (!values.every(count) || !requestId || row.account_id == null || row.id == null || !Number.isFinite(timestampMs)) return null
  const [input, output, read, write] = values as number[]
  const tier=text(row.service_tier).toLowerCase(),agent=text(row.user_agent).toLowerCase()
  const requestedMode=({priority:'fast',fast:'fast',flex:'flex',default:'standard',auto:'standard',standard:'standard','':'standard'} as Record<string,string>)[tier]??tier
  const clientTool=/\bcodex(?:[ /_-]|$)/.test(agent)?'codex':/claude[- /](?:code|cli)|claude-cli/.test(agent)?'claude':agent.includes('antigravity')?'antigravity':/deepseek[- ]harness/.test(agent)?'deepseek-harness':agent?'api':undefined
  return { eventId: String(row.id), account: String(row.account_id), requestId, sessionId: text(row.session_id) || undefined, model: text(row.model), timestampMs,
    inputTokens: input + read + write, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
    officialAccountId: text(row.official_account_id) || undefined,
    details:{requestedMode,clientTool,durationMs:count(row.duration_ms)?row.duration_ms:undefined,cacheWrite5mTokens:count(row.cache_creation_5m_tokens)?row.cache_creation_5m_tokens:undefined,cacheWrite1hTokens:count(row.cache_creation_1h_tokens)?row.cache_creation_1h_tokens:undefined,
      nonToken:text(row.billing_mode)==='image'||Number(row.image_count)>0||Number(row.total_cost)>0&&input+read+write+output===0,
      reportedUsd:typeof row.total_cost==='number'&&Number.isFinite(row.total_cost)&&row.total_cost>=0?row.total_cost:undefined} }
}

export function cliproxyReceipt(row: CliproxyUsageEvent & Row): UpstreamReceipt | null {
  const requestId = text(row.response_id) || text(row.request_id)
  const sessionId = text(row.session_id)
  const timestampMs = Math.trunc(row.requested_at)
  if (row.failed || (!requestId && !sessionId) || row.id == null || !Number.isSafeInteger(timestampMs) || timestampMs <= 0) return null
  const tokens = cliproxyTokenBreakdown(row)
  if (![tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens].every(count)) return null
  return { eventId: String(row.id), account: row.auth_index, requestId, sessionId: sessionId || undefined, model: row.model, timestampMs,
    inputTokens: tokens.inputTokens!, outputTokens: tokens.outputTokens!, cacheReadTokens: tokens.cacheReadTokens!, cacheWriteTokens: tokens.cacheWriteTokens!, officialAccountId: text(row.official_account_id) || undefined }
}

async function client(connection: ConnectionConfig) {
  const base = new URL(connection.baseUrl || 'http://127.0.0.1:8317')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Invalid source endpoint')
  const suffix = connection.type === 'sub2api' ? '/api/v1' : '/v0/management'
  const root = base.href.replace(/\/$/, '')
  const target = root.endsWith(suffix) ? root : root + suffix
  const headers: Record<string, string> = connection.type === 'cliproxy'
    ? { Authorization: `Bearer ${connection.secretKey}` }
    : connection.authMode === 'login' ? { Authorization: `Bearer ${connection.apiKey}` } : { 'X-API-Key': connection.apiKey }
  if (connection.type === 'sub2api') headers['X-Admin-UI-Request'] = '1'
  if (connection.type === 'sub2api' && isDesktopRuntime()) Object.assign(headers,await getDesktopProxyHeaders(target))
  return { base, instance: target, http: axios.create({ baseURL: connection.type === 'sub2api' && isDesktopRuntime() ? `http://127.0.0.1:${PROXY_PORT}` : target, headers, timeout: 10_000 }) }
}

function unwrap(data: unknown): Row {
  const value = object(data)
  if ('code' in value) {
    if (value.code !== 0) throw Error('Source request failed')
    return object(value.data)
  }
  return value
}

async function renewSession(connection:ConnectionConfig,now:number):Promise<ConnectionConfig>{
  if(connection.type!=='sub2api'||connection.authMode!=='login'||(connection.tokenExpiresAt??0)>now||!localStorage.getItem('refresh_token'))return connection
  const token=localStorage.getItem('auth_token')
  if(!token||(token!==connection.apiKey&&!authConnectionBindingMatches({connection})))return connection
  if(!getActiveConnection()){
    const store=useConnectionStore()
    if(store.activeId===connection.id)setActiveConnection(store.active)
  }
  const active=getActiveConnection()
  if(active?.id!==connection.id||active.baseUrl!==connection.baseUrl)return connection
  await refreshAuthTokens()
  const current=loadConnections().find(row=>row.id===connection.id&&row.baseUrl===connection.baseUrl)
  if(!current)throw Error('Source connection changed during session renewal')
  return current
}

async function sync(connection: ConnectionConfig, now: number): Promise<Omit<UpstreamSync, 'errors'> & { partial: boolean }> {
  connection=await renewSession(connection,now)
  const { base, instance, http } = await client(connection)
  let accounts: UpstreamIdentity[], receipts: UpstreamReceipt[]
  let history: HistoryCursor | undefined
  let partial=false
  if (connection.type === 'sub2api') {
    const response = unwrap((await http.get('/admin/accounts', { params: { page: 1, page_size: 1000 } })).data)
    if (!Array.isArray(response.items)) throw Error('Account identities are unavailable')
    partial=Number(response.total ?? response.items.length) > response.items.length
    accounts = response.items.map(row => sub2apiIdentity(object(row))).filter((row): row is UpstreamIdentity => !!row)
    const result = new Map<string, UpstreamReceipt>()
    const start=now-600_000,day=(time:number)=>new Date(time).toISOString().slice(0,10)
    history = await invoke<HistoryCursor>('usage_monitor_upstream_history', { source: connection.type, instance, nowMs: now })
    if(now-(history.resetCheckedMs??0)>=60_000){
      try{
        const resetStart=history.resetCheckedMs?history.resetCheckedMs-60_000:history.startMs
        const audit=unwrap((await http.get('/admin/audit-logs',{params:{page:1,page_size:100,action:'system.openai.reset_credit.auto',start_time:new Date(resetStart).toISOString(),end_time:new Date(now).toISOString()}})).data)
        for(const value of Array.isArray(audit.items)?audit.items:[]){
          const row=object(value),extra=object(row.extra),atMs=Date.parse(text(row.created_at))
          const account=accounts.find(account=>account.id===String(extra.account_id))
          if(account&&row.status_code===200&&extra.result_code==='success'&&text(extra.trigger_window).split('+').includes('7d')&&Number.isSafeInteger(atMs)&&row.id!=null){(account.resets??=[]).push({id:String(row.id),atMs})}
        }
        history.resetCheckedMs=now
      }catch(error){if(axios.isAxiosError(error)&&[403,404].includes(error.response?.status??0))history.resetCheckedMs=now;else partial=true}
    }
    // The saved page resumes backfill after restarts; recent calls continue to refresh separately.
    const windows = history.complete ? [{ startMs: start, endMs: now, page: 1, history: false }]
      : [...(history.nextPage > 1 ? [{ startMs: start, endMs: now, page: 1, history: false }] : []),{ startMs: history.startMs, endMs: history.endMs, page: history.nextPage, history: true }]
    for (const window of windows) {
      for (let index=0; index<5; index++) {
        const page=window.page+index
        const value = unwrap((await http.get('/admin/usage', { params: { page, page_size: 100, start_date: day(window.startMs), end_date: day(window.endMs), timezone:'UTC', sort_by:'created_at',sort_order:'desc',exact_total:false } })).data)
        if (!Array.isArray(value.items)) throw Error('Request history is unavailable')
        for(const raw of value.items){const receipt=sub2apiReceipt(object(raw));if(receipt&&receipt.timestampMs>=window.startMs&&receipt.timestampMs<=window.endMs)result.set(receipt.eventId,receipt)}
        const oldest=new Date(String(object(value.items.at(-1)).created_at ?? '')).getTime()
        const complete=value.items.length<100 || oldest<window.startMs
        if(window.history){history.nextPage=page+1;history.complete=complete}
        if(complete)break
        if(index===4&&!window.history)partial=true
      }
    }
    receipts = [...result.values()]
  } else {
    const value = object((await http.get('/auth-files')).data)
    if (!Array.isArray(value.files)) throw Error('Account identities are unavailable')
    accounts = value.files.map(row => cliproxyIdentity(object(row))).filter((row): row is UpstreamIdentity => !!row)
    // The local plugin belongs to the managed local instance. The remote usage queue is destructive.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || (base.port && base.port !== '8317')) throw Error('Remote request history has no local source binding')
    const snapshot = object(JSON.parse(await invoke<string>('read_cliproxy_usage_events', { withMetadata: true, startMs: now - 600_000, endMs: now })))
    if (!snapshot.available || !Array.isArray(snapshot.events)) throw Error('Saved request history is unavailable')
    receipts = snapshot.events.map(row => cliproxyReceipt(row as CliproxyUsageEvent & Row)).filter((row): row is UpstreamReceipt => !!row)
    partial = snapshot.events.some(row => !object(row).failed && !cliproxyReceipt(row as CliproxyUsageEvent & Row))
  }
  const value:Omit<UpstreamSync,'errors'>={matched:0,accepted:0,awaitingIdentity:0,changed:false}
  const chunks=Math.max(1,Math.ceil(receipts.length/100))
  for(let chunk=0;chunk<chunks;chunk++){
    // Give waiting live collectors a turn between historical write batches.
    if(chunk>0)await new Promise(resolve=>setTimeout(resolve,100))
    const last=chunk===chunks-1
    const identities=last?accounts:accounts.map(account=>({...account,quotas:[],resets:[]}))
    const part=await invoke<Omit<UpstreamSync,'errors'>>('usage_monitor_sync_upstream', { batch: { source: connection.type, instance, observedMs: now, accounts:identities, receipts:receipts.slice(chunk*100,(chunk+1)*100), ...(history&&last ? {history} : {}) } })
    value.matched+=part.matched;value.accepted+=part.accepted;value.awaitingIdentity+=part.awaitingIdentity;value.changed||=part.changed
  }
  return {...value,backfilling:history ? !history.complete : false,partial:partial||value.awaitingIdentity>0}
}

const attempts = new Map<string, { at: number; credential: string; denied: boolean; failed: boolean; backfilling?: boolean }>()
let pending: Promise<UpstreamSync> | null = null
export function syncMonitorUpstreams(): Promise<UpstreamSync> {
  if (pending) return pending
  pending = (async () => {
    const now = Date.now(), result: UpstreamSync = { matched: 0, accepted: 0, awaitingIdentity: 0, errors: [] }
    const connections = loadConnections().filter(row => row.type === 'sub2api' ? !!row.apiKey : row.type === 'cliproxy' && !!row.secretKey)
    await Promise.all(connections.map(async connection => {
      const key = `${connection.type}:${connection.baseUrl}:${connection.id}`, credential = connection.type === 'cliproxy' ? connection.secretKey! : connection.apiKey
      const previous = attempts.get(key)
      if (previous?.credential === credential && now - previous.at < (previous.denied ? 30 * 60_000 : previous.backfilling ? 5_000 : 60_000)) {
        if (previous.failed) result.errors.push(connection.type === 'cliproxy' ? 'CLIProxyAPI' : 'Sub2API')
        result.backfilling ||= previous.backfilling
        return
      }
      const attempt = { at: now, credential, denied: false, failed: false, backfilling: false }; attempts.set(key, attempt)
      try {
        const value = await sync(connection, now)
        result.matched += value.matched; result.accepted += value.accepted; result.awaitingIdentity += value.awaitingIdentity
        result.changed ||= value.changed || value.matched > 0
        result.backfilling ||= value.backfilling
        attempt.backfilling=!!value.backfilling
        attempt.failed=value.partial
        if(value.partial)result.errors.push(connection.type === 'cliproxy' ? 'CLIProxyAPI' : 'Sub2API')
      } catch (failure) {
        attempt.failed = true
        attempt.denied = axios.isAxiosError(failure) && (failure.response?.status === 401 || failure.response?.status === 403)
        result.errors.push(connection.type === 'cliproxy' ? 'CLIProxyAPI' : 'Sub2API')
      }
    }))
    monitorUpstreamStatus.value = result
    if (result.changed) monitorUpstreamRevision.value++
    return result
  })().finally(() => { pending = null })
  return pending
}

export function startMonitorUpstreams(): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  async function tick() {
    let backfilling=false
    try { backfilling=!!(await syncMonitorUpstreams()).backfilling }
    finally { if (!stopped) timer = setTimeout(tick, backfilling ? 5_000 : 60_000) }
  }
  void tick()
  return () => { stopped = true; clearTimeout(timer) }
}
