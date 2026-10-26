import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from './url'
import type { MonitorTotals } from './usageMonitor'

export interface AccountSubscription {
  startMs: number | null
  endMs: number | null
  checkedAtMs: number | null
  source: 'local_auth' | 'none'
  error: string | null
}

export interface AccountUsagePeriod {
  startMs: number
  endMs: number
  observedEndMs: number
  totals: MonitorTotals
}

export interface AccountUsageCycle extends AccountUsagePeriod {
  quotaSnapshot?: AccountUsagePeriod | null
  resetAtMs: number
  quotaObservedAtMs: number
  exhaustedAtMs: number | null
  exhaustionUnknown: boolean
  usedPercent: number | null
  current: boolean
}

export interface AccountUsage {
  accountKey: string
  accountLabel: string
  tool: 'codex' | 'claude' | 'antigravity'
  attribution: 'session_creator'
  subscription: AccountSubscription
  calendarWeek: AccountUsagePeriod
  subscriptionMonth: AccountUsagePeriod | null
  currentCycle: AccountUsageCycle | null
  previousCycle: AccountUsageCycle | null
  quotaCycles: AccountUsageCycle[]
  monthCycles: AccountUsageCycle[]
  unsegmentedMonth: MonitorTotals
}

export interface AccountUsageReport {
  collectedAtMs: number
  weekStartMs: number
  currentAccountKey?: string | null
  accounts: AccountUsage[]
  unassignedWeek: MonitorTotals
}

function desktop(): void {
  if (!isDesktopRuntime()) throw new Error('账号用量统计需要桌面端')
}

export function getUsageMonitorAccounts(weekStartMs: number, nowMs: number): Promise<AccountUsageReport> {
  desktop()
  return invoke('usage_monitor_accounts', { weekStartMs, nowMs })
}

