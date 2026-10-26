import { afterEach, expect, it } from 'vitest'
import { ACCOUNT_QUOTA_SNAPSHOTS_KEY, loadAccountQuotaSnapshots, saveAccountQuotaSnapshots, validAccountQuotaSnapshot, type AccountQuotaSnapshot } from '../accountQuotaSnapshot'

const snapshot: AccountQuotaSnapshot = {
  accountKey: 'codex:1', tool: 'codex', accountLabel: 'Account 1', cycleStartMs: 1000, cycleResetAtMs: 10000,
  quotaObservedAtMs: 2000, updatedAtMs: 3000, usedPercent: 20,
  quotes: [{ currency: 'USD', observedSubtotal: 10, additionalSubtotal: 40, projectedSubtotal: 50 }],
  partial: true, coveredRequests: 1, requestCount: 3,
}

afterEach(() => localStorage.clear())

it('ignores v1 estimates whose amounts were not observation-aligned and preserves validated v2 coverage', () => {
  localStorage.setItem('usage-monitor:account-quota-snapshots:v1', JSON.stringify([snapshot]))
  expect(loadAccountQuotaSnapshots()).toEqual([])
  expect(localStorage.getItem(ACCOUNT_QUOTA_SNAPSHOTS_KEY)).toBeNull()
  saveAccountQuotaSnapshots([snapshot])
  expect(loadAccountQuotaSnapshots()).toEqual([snapshot])
  expect(localStorage.getItem('usage-monitor:account-quota-snapshots:v1')).not.toBeNull()
})

it('rejects invalid coverage and mismatched proportional amounts', () => {
  expect(validAccountQuotaSnapshot(snapshot)).toBe(true)
  expect(validAccountQuotaSnapshot({ ...snapshot, coveredRequests: 4 })).toBe(false)
  expect(validAccountQuotaSnapshot({ ...snapshot, requestCount: -1 })).toBe(false)
  expect(validAccountQuotaSnapshot({ ...snapshot, usedPercent: 25 })).toBe(false)
})
