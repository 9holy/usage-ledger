export const ACCOUNT_QUOTA_SNAPSHOTS_KEY = 'usage-monitor:account-quota-snapshots:v2'

export interface AccountQuotaSnapshot {
  accountKey: string
  tool: string
  accountLabel: string
  cycleStartMs: number
  cycleResetAtMs: number
  quotaObservedAtMs: number
  updatedAtMs: number
  usedPercent: number
  quotes: Array<{ currency: string; observedSubtotal: number; additionalSubtotal: number; projectedSubtotal: number }>
  partial: boolean
  coveredRequests: number
  requestCount: number
}

const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object'
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const timestamp = (value: unknown): value is number => amount(value) && Number.isSafeInteger(value)

export function validAccountQuotaSnapshot(value: unknown): value is AccountQuotaSnapshot {
  if (!object(value) || !['codex', 'claude', 'antigravity'].includes(value.tool as string)
    || typeof value.accountKey !== 'string' || !value.accountKey.startsWith(value.tool + ':')
    || typeof value.accountLabel !== 'string' || !value.accountLabel
    || !timestamp(value.cycleStartMs) || !timestamp(value.cycleResetAtMs)
    || !timestamp(value.quotaObservedAtMs) || !timestamp(value.updatedAtMs)
    || value.cycleStartMs > value.quotaObservedAtMs || value.quotaObservedAtMs >= value.cycleResetAtMs
    || value.updatedAtMs < value.quotaObservedAtMs || value.updatedAtMs >= value.cycleResetAtMs
    || !amount(value.usedPercent) || value.usedPercent <= 0 || value.usedPercent >= 100
    || !timestamp(value.coveredRequests) || !timestamp(value.requestCount) || value.coveredRequests > value.requestCount
    || typeof value.partial !== 'boolean' || !Array.isArray(value.quotes) || !value.quotes.length) return false
  const usedPercent = value.usedPercent
  return value.quotes.every(quote => object(quote) && typeof quote.currency === 'string' && /^[A-Z]{3}$/.test(quote.currency)
    && amount(quote.observedSubtotal) && amount(quote.additionalSubtotal) && amount(quote.projectedSubtotal)
    && Math.abs(quote.observedSubtotal + quote.additionalSubtotal - quote.projectedSubtotal) <= 1e-8 * Math.max(1, quote.projectedSubtotal)
    && Math.abs(quote.projectedSubtotal * usedPercent / 100 - quote.observedSubtotal) <= 1e-8 * Math.max(1, quote.projectedSubtotal))
    && new Set(value.quotes.map(quote => quote.currency)).size === value.quotes.length
}

export function loadAccountQuotaSnapshots(): AccountQuotaSnapshot[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)
    if (!raw) return []
    const saved: unknown = JSON.parse(raw)
    if (!Array.isArray(saved) || saved.length > 20 || !saved.every(validAccountQuotaSnapshot)
      || new Set(saved.map(row => row.accountKey)).size !== saved.length) throw new Error('Invalid account quota snapshots')
    return saved.map(({ accountKey, tool, accountLabel, cycleStartMs, cycleResetAtMs, quotaObservedAtMs, updatedAtMs, usedPercent, quotes, partial, coveredRequests, requestCount }) => ({
      accountKey, tool, accountLabel, cycleStartMs, cycleResetAtMs, quotaObservedAtMs, updatedAtMs, usedPercent, partial,
      coveredRequests, requestCount,
      quotes: quotes.map(({ currency, observedSubtotal, additionalSubtotal, projectedSubtotal }) => ({ currency, observedSubtotal, additionalSubtotal, projectedSubtotal })),
    }))
  } catch (error) {
    console.warn('[usage-monitor] quota snapshot load failed', error)
    return []
  }
}

export function saveAccountQuotaSnapshots(snapshots: AccountQuotaSnapshot[]): void {
  try {
    localStorage.setItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY, JSON.stringify(snapshots))
  } catch (error) {
    console.warn('[usage-monitor] quota snapshot save failed', error)
  }
}
