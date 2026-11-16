import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from './url'
import type { MonitorTotals } from './usageMonitor'

export interface AccountSubscription {
  active?: boolean | null
  billingPeriod?: string | null
  startMs: number | null
  endMs: number | null
  renewalAtMs?: number | null
  checkedAtMs: number | null
  source: 'local_auth' | 'official' | 'sub2api' | 'cliproxy' | 'none'
  error: string | null
}

export function accountSubscriptionUnavailable(subscription: AccountSubscription): boolean {
  return subscription.active === false
    || (subscription.billingPeriod != null && subscription.billingPeriod !== 'monthly')
    || !!subscription.error
}

export interface AccountUsagePeriod {
  billingTotals?: Record<string, MonitorTotals>
  sourceCoverageIncomplete?: boolean
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

export interface AccountUsagePeriods {
  calendarWeek: AccountUsagePeriod
  subscriptionMonth: AccountUsagePeriod | null
  currentCycle: AccountUsageCycle | null
  previousCycle: AccountUsageCycle | null
  quotaCycles: AccountUsageCycle[]
  monthCycles: AccountUsageCycle[]
  unsegmentedMonth: MonitorTotals
  unsegmentedMonthBillingTotals?: Record<string, MonitorTotals>
}

export interface AccountUsage extends AccountUsagePeriods {
  accountKey: string
  accountLabel: string
  tool: 'codex' | 'claude' | 'antigravity'
  billingKind?: 'subscription' | 'api'
  calendarMonth?: AccountUsagePeriod | null
  clientTools?: string[]
  attribution: 'session_creator' | 'request_evidence_with_creator_reference'
  /** Unique cross-match within collected request logs, not official billing confirmation. */
  billingAccountVerified?: boolean
  verifiedWeekRequests?: number
  creatorReferenceWeekRequests?: number
  verifiedHistory?: AccountUsagePeriod | null
  subscription: AccountSubscription
  /** Unverified creator grouping; a subset of unassigned usage, never additive. */
  creatorReference?: AccountUsagePeriods
}

export interface AccountUsageReport {
  collectedAtMs: number
  weekStartMs: number
  currentAccountKey?: string | null
  accounts: AccountUsage[]
  unassignedWeek: MonitorTotals
  unassignedByTool?: Record<string, MonitorTotals>
  unlocatedTotals?: MonitorTotals
  unlocatedByTool?: Record<string, MonitorTotals>
  apiUsage?: ApiUsage | null
}

export interface ApiUsage {
  week: AccountUsagePeriod
  month: AccountUsagePeriod | null
}

function desktop(): void {
  if (!isDesktopRuntime()) throw new Error('账号用量统计需要桌面端')
}

export function getUsageMonitorAccounts(weekStartMs: number, nowMs: number): Promise<AccountUsageReport> {
  desktop()
  const now = new Date(nowMs)
  const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return invoke('usage_monitor_accounts', { weekStartMs, nowMs, monthStartMs })
}

export function setUsageAccountName(accountKey: string, name: string): Promise<void> {
  desktop()
  return invoke('usage_monitor_set_account_name', { accountKey, name })
}

