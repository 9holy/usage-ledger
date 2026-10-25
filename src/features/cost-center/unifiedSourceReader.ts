import { costDataText } from './costDataText'
import axios from 'axios'
import type { ConnectionConfig } from '@/stores/connection'
import { isDesktopRuntime, PROXY_PORT } from '@/api/url'
import type { AdminUsageLog } from '@/types'
import { accountCostSnapshot } from './modelCostAnalysis'
import { localDateParameter, type UsageQueryWindow } from './usageWindow'

export type UnifiedSourceKey = 'sub2api' | 'cliproxy' | 'cockpit'
export type UnifiedReadState = 'loading' | 'measured' | 'estimated' | 'partial' | 'unavailable' | 'empty'
export interface WindowCostReading {
  source: UnifiedSourceKey
  instanceId: string
  startMs: number
  endMs: number
  costUsd: number | null
  state: UnifiedReadState
  reason: string
  records: number | null
  tokens: number | null
  latestRecordMs: number | null
  coverageBasis: 'stored_records' | 'bounded_sample' | 'unavailable'
}

export function windowCostReading(source: UnifiedSourceKey, instanceId: string, window: UsageQueryWindow): WindowCostReading {
  return { source, instanceId, startMs: window.start.getTime(), endMs: window.end.getTime(), costUsd: null, state: 'unavailable', get reason() { return costDataText('notLoadedYet') }, records: null, tokens: null, latestRecordMs: null, coverageBasis: 'unavailable' }
}

export function aggregateSub2apiWindowLogs(logs: AdminUsageLog[], connectionId: string, window: UsageQueryWindow, complete: boolean): WindowCostReading {
  const result = windowCostReading('sub2api', `sub2api:${connectionId}`, window)
  const seen = new Set<number>()
  let known = 0, unknown = 0, duplicates = 0, total = 0, records = 0, unknownTokens = 0
  let tokens = 0
  for (const log of logs) {
    const stamp = new Date(log.created_at).getTime()
    if (!Number.isFinite(stamp) || stamp < result.startMs || stamp >= result.endMs) continue
    if (seen.has(log.id)) { duplicates += 1; continue }
    seen.add(log.id)
    records += 1
    result.latestRecordMs = Math.max(result.latestRecordMs ?? stamp, stamp)
    const values = [log.input_tokens, log.output_tokens, log.cache_creation_tokens, log.cache_read_tokens]
    if (values.every((value) => value != null && Number.isFinite(Number(value)))) tokens += values.reduce<number>((sum, value) => sum + Number(value), 0)
    else unknownTokens += 1
    const cost = accountCostSnapshot(log)
    if (cost == null) unknown += 1
    else { known += 1; total += cost }
  }
  return { ...result, records, tokens: unknownTokens || (!records && !complete) ? null : tokens,
    costUsd: records === 0 && complete ? 0 : known ? total : null,
    state: records === 0 && complete ? 'empty' : !complete || unknown > 0 || unknownTokens > 0 || duplicates > 0 ? 'partial' : 'measured',
    coverageBasis: complete ? 'stored_records' : 'bounded_sample',
    get reason() { return costDataText('accountCostSnapshotsNotUserCharges', { p0: complete ? costDataText('recordedRowsInThisInstanceWindow') : costDataText('upTo25000RecentContiguousSamplesTheWindow'), p1: unknown ? costDataText('rowsHaveUnknownCostKnownAmountsAreALower', { p0: unknown }) : '', p2: unknownTokens ? costDataText('rowsHaveIncompleteTokenFields', { p0: unknownTokens }) : '', p3: duplicates ? costDataText('duplicatePaginatedRecordsRemoved') : '' }) },
  }
}

// The client owns its target and credential; global connection interceptors and refresh are not involved.
export async function readSub2apiWindow(connection: ConnectionConfig, window: UsageQueryWindow, options: { signal?: AbortSignal } = {}): Promise<WindowCostReading> {
  const result = windowCostReading('sub2api', `sub2api:${connection.id}`, window)
  if (!connection.apiKey) return { ...result, get reason() { return costDataText('theSavedConnectionLacksCredentialsForThisInstance') } }
  if (connection.authMode === 'login' && connection.tokenExpiresAt != null && connection.tokenExpiresAt <= Date.now()) return { ...result, get reason() { return costDataText('theSavedJwtForThisInstanceHasExpiredSign') } }
  const base = connection.baseUrl.trim().replace(/\/+$/, '')
  if (!base) return { ...result, get reason() { return costDataText('theSavedConnectionHasNoTargetAddress') } }
  const target = base.endsWith('/api/v1') ? base : `${base}/api/v1`
  const desktop = isDesktopRuntime()
  const client = axios.create({
    baseURL: desktop ? `http://127.0.0.1:${PROXY_PORT}` : target,
    timeout: 30000,
    headers: {
      ...(connection.authMode === 'login' ? { Authorization: `Bearer ${connection.apiKey}` } : { 'X-API-Key': connection.apiKey }),
      ...(desktop ? { 'X-Target-Base': target } : {}),
      'X-Admin-UI-Request': '1',
    },
  })
  const logs: AdminUsageLog[] = []
  try {
    for (let page = 1; page <= 25; page += 1) {
      const response = await client.get('/admin/usage', { signal: options.signal, params: {
        page, page_size: 1000, start_date: localDateParameter(window.start), end_date: localDateParameter(window.end),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sort_by: 'created_at', sort_order: 'desc', exact_total: false,
      } })
      const data = response.data?.data ?? response.data
      if (!Array.isArray(data?.items)) throw new Error('INVALID_SCHEMA')
      const items = data.items as AdminUsageLog[]
      logs.push(...items)
      const oldest = items.at(-1)
      if (items.length < 1000 || (oldest && new Date(oldest.created_at).getTime() < result.startMs)) return aggregateSub2apiWindowLogs(logs, connection.id, window, true)
    }
    return aggregateSub2apiWindowLogs(logs, connection.id, window, false)
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const reason = status ? costDataText('readOnlyQueryForThisInstanceFailedHttp', { p0: status }) : costDataText('readOnlyQueryForThisInstanceFailedNetworkOr')
    const partial = aggregateSub2apiWindowLogs(logs, connection.id, window, false)
    return partial.records ? { ...partial, reason: `${reason}；${partial.reason}` } : { ...result, reason }
  }
}
