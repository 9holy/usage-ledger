import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from './url'

export type FinanceSource = 'sub2api' | 'cliproxy' | 'cockpit'
export type FinanceCurrency = 'CNY' | 'USD'
export type FinanceEventKind = 'purchase' | 'renewal' | 'refund' | 'termination_loss'
export interface FinanceScope { source: FinanceSource; instanceId: string }
export interface FinanceEventInput extends FinanceScope {
  id: string
  accountId: string
  kind: FinanceEventKind
  amount: number
  currency: FinanceCurrency
  occurredAtMs: number
  coverageStartMs?: number | null
  coverageEndMs?: number | null
  note?: string | null
  purchaseChannel?: string | null
  planLabel?: string | null
  batchId?: string | null
  batchTotal?: number | null
  relatedEventId?: string | null
}
export interface FinanceEvent extends FinanceEventInput {
  createdAtMs: number
  updatedAtMs: number
  voidedAtMs: number | null
}
export interface FinanceQuery extends FinanceScope {
  accountId?: string | null
  startMs: number
  endMs: number
  listMode?: 'current' | 'all'
  offset?: number
  limit?: number
  purchaseChannel?: string | null
  planLabel?: string | null
}
export interface FinanceCoverageInterval { startMs: number; endMs: number }
export interface FinanceCurrencySummary {
  currency: FinanceCurrency
  cashOutlay: number
  refunds: number
  accruedExpense: number
  recognizedLoss: number
  expenseCredits: number
  netExpense: number | null
  remainingPrepaid: number | null
  ongoingHourlyExpense: number | null
  unresolvedCount: number
  hasEnteredFacts: boolean
  /** Compatibility: recorded gross losses, including unresolved entries. */
  terminationLoss: number
  /** Compatibility alias of accruedExpense. */
  amortizedExpense: number
  missingCoverageCount: number
}
export interface FinanceAccountSummary extends FinanceCurrencySummary {
  accountId: string
  coverageIntervals: FinanceCoverageInterval[]
  lifetimeAccruedExpense: number
  lifetimeRecognizedLoss: number
  lifetimeExpenseCredits: number
  lifetimeCoverageIntervals: FinanceCoverageInterval[]
}
export interface FinanceSummary {
  eventCount: number
  hasEnteredFacts: boolean
  unresolvedTerminationCount: number
  currencies: FinanceCurrencySummary[]
}
export interface FinanceSnapshot {
  events: FinanceEvent[]
  totalEvents: number
  purchaseChannels: string[]
  planLabels: string[]
  summary: FinanceSummary
  byAccount: FinanceAccountSummary[]
}
export interface FinanceBatchInput {
  scope: FinanceScope
  batchId: string
  totalAmount: number
  currency: FinanceCurrency
  occurredAtMs: number
  purchaseChannel?: string | null
  allocations: FinanceEventInput[]
}
export interface FinanceBatch extends Omit<FinanceBatchInput, 'allocations'> { events: FinanceEvent[] }

function desktop(): void {
  if (!isDesktopRuntime()) throw new Error('本地财务账本需要桌面端')
}

export async function getFinanceLedger(query: FinanceQuery): Promise<FinanceSnapshot> {
  desktop()
  return invoke('finance_ledger_query', { query })
}

export async function saveFinanceEvent(event: Omit<FinanceEventInput, 'id'> & { id?: string }): Promise<FinanceEvent> {
  desktop()
  return invoke('finance_ledger_save', { event: { ...event, id: event.id ?? crypto.randomUUID() } })
}

export async function voidFinanceEvent(scope: FinanceScope, id: string): Promise<FinanceEvent> {
  desktop()
  return invoke('finance_ledger_void', { scope, id })
}

export async function saveFinanceBatch(batch: FinanceBatchInput): Promise<FinanceBatch> {
  desktop()
  return invoke('finance_ledger_save_batch', { batch })
}

export async function getFinanceBatch(scope: FinanceScope, batchId: string): Promise<FinanceBatch> {
  desktop()
  return invoke('finance_ledger_get_batch', { scope, batchId })
}

export async function voidFinanceBatch(scope: FinanceScope, batchId: string): Promise<void> {
  desktop()
  return invoke('finance_ledger_void_batch', { scope, batchId })
}

export async function getFinanceRelatedEvents(scope: FinanceScope, accountId: string, currency: FinanceCurrency): Promise<FinanceEvent[]> {
  desktop()
  return invoke('finance_ledger_related_events', { scope, accountId, currency })
}
