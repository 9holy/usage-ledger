import { invoke } from '@tauri-apps/api/core'
import type { MonitorTotals, LiveSnapshot, LiveBucket } from './usageMonitor'
import type { AccountUsage } from './usageAccounts'

export interface LocalUsageAnalytics {
  totals: MonitorTotals
  latestRequestMs?: number | null
  observedTimeline?: LiveBucket[]
  models: Array<{ tool: string; model: string | null; totals: MonitorTotals; speeds: Array<{ basis: string | null; validSamples: number; totalSamples: number; outputTokens: number; durationMs: number; outputTokensPerSecond: number | null }> }>
  timeline: Array<{ startMs: number; endMs: number; totals: MonitorTotals }>
}

export interface ApiCostRule {
  model: string | null
  startMs: number
  currency: 'USD' | 'CNY'
  multiplier: number | null
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cacheWrite5m: number | null
  cacheWrite1h: number | null
}
export interface LocalCostSettings {
  cnyPerUsd: number
  apiRules: ApiCostRule[]
  accounts: Record<string, { status: 'active' | 'inactive' | 'banned'; updatedAtMs: number }>
}
export interface LocalCostAccount {
  id: string
  label: string
  tool: string
  billingKind?: 'subscription' | 'api' | 'unknown'
  clientTools?: string[]
  totals: MonitorTotals
  verifiedRequests: number
  referenceRequests: number
  billingCounts?: Record<string, number>
  periods?: Pick<AccountUsage, 'subscription' | 'currentCycle' | 'previousCycle' | 'quotaCycles' | 'subscriptionMonth' | 'calendarMonth' | 'billingAccountVerified' | 'verifiedHistory' | 'monthCycles' | 'unsegmentedMonth'> | null
  analytics?: LocalUsageAnalytics
  sources?: Record<string, LocalUsageAnalytics>
}
export interface ApiModelExpense { tool: string; model: string | null; byCurrency: Record<string, number>; pricedRequests: number; missingRequests: number }
export interface ApiAccountExpense { byCurrency: Record<string, number>; pricedRequests: number; missingRequests: number; byModel?: ApiModelExpense[]; bySource?: Record<string, ApiModelExpense[]> }
export interface LocalCostReport {
  settings: LocalCostSettings
  accounts: LocalCostAccount[]
  apiExpense: ApiAccountExpense & { byAccount?: Record<string, ApiAccountExpense> }
  purchases: Record<string, { amount: number; currency: 'USD' | 'CNY'; coverageStartMs: number | null; coverageEndMs: number | null }>
  startMs: number
  endMs: number
  analytics?: LocalUsageAnalytics
  currentAccountKey?: string | null
  accountNames?: Record<string, string>
}
export const LOCAL_FINANCE_SCOPE = { source: 'local' as const, instanceId: 'usage-monitor' }
export const getLocalCostReport = (startMs: number, endMs: number): Promise<LocalCostReport> => {
  const end = new Date(endMs - 1), monthStartMs = new Date(end.getFullYear(), end.getMonth(), 1).getTime()
  return invoke('local_cost_report', { startMs, endMs, monthStartMs })
}
export const saveLocalCostSettings = (settings: LocalCostSettings): Promise<void> => invoke('local_cost_save_settings', { settings })
export interface LocalCostLiveReport { accountKey: string; sourceKey?: string | null; live: LiveSnapshot }
export const getLocalCostLive = (accountKey: string, sourceKey?: string): Promise<LocalCostLiveReport> => invoke('local_cost_live', { accountKey, ...(sourceKey && sourceKey !== 'all' ? { sourceKey } : {}) })
