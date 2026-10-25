import { describe, expect, it } from 'vitest'
import type { AccountUsageInfo } from '@/types'
import type { QuotaSnapshot } from '@/api/cockpit/quota'
import type { SourceAccount } from '../sourceTypes'
import { accountIdToCostId, cockpitQuotaToAccountUsage, cockpitSnapshotsToAccountUsage } from '../cockpitAdapter'
import { authIndexToAccountId, cliproxyEventsToAccountUsage } from '../cliproxyAdapter'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import { quotaWindowState, type RecordedQuotaProgress } from '../quotaWindowState'

const NOW = Date.UTC(2026, 9, 25, 12)
const iso = (value: number) => new Date(value).toISOString()
const account = (raw: string, platform = 'openai') => ({ id: accountIdToCostId(raw), platform } as SourceAccount)
const snapshot = (overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  channel: 'codex', accountId: 'account-a', email: 'not-used@example.test', modelId: 'codex', displayName: 'raw source label',
  percent: 80, remainingFraction: 0.8, usedFraction: 0.2, percentKind: 'remaining', unavailableReason: null,
  scope: 'pool', windowKind: 'weekly', windowStartedAtMs: null, resetAtMs: NOW + 86400000, source: 'snapshot',
  fetchedAtMs: NOW, updatedAtMs: NOW - 3600000, stale: false, rawKind: 'AccountSnapshot', plan: null, ...overrides,
})

describe('quota period display evidence', () => {
  it('keeps an expired recorded percentage and its timestamp, without inventing a reset or a zero', () => {
    const result = quotaWindowState({ utilization: 84, resets_at: iso(NOW - 1000), recorded_at: iso(NOW - 3600000), snapshot_source: 'recorded' }, NOW)
    expect(result).toMatchObject({ utilization: 84, resetState: 'expired', historical: true, updatedAt: iso(NOW - 3600000) })
    expect(quotaWindowState({ utilization: 0, resets_at: iso(NOW - 1000) }, NOW)).toMatchObject({ utilization: 0, resetState: 'expired', historical: true })
  })

  it('separates missing and invalid values from a valid current zero, and unknown reset from expiry', () => {
    expect(quotaWindowState(null, NOW).utilization).toBeNull()
    expect(quotaWindowState({ utilization: NaN }, NOW).utilization).toBeNull()
    expect(quotaWindowState({ utilization: 0, resets_at: iso(NOW + 1000) }, NOW)).toMatchObject({ utilization: 0, resetState: 'future', historical: false })
    expect(quotaWindowState({ utilization: 40, resets_at: 'invalid' }, NOW).resetState).toBe('unknown')
    expect(quotaWindowState({ utilization: 40, recorded_at: null }, NOW, iso(NOW)).updatedAt).toBeNull()
  })

  it('preserves CPA 5h and 7d timestamps independently, including stale valid pairs when newer records omit a period', () => {
    const event = (at: number, fields: object) => ({ requested_at: at, failed: false, auth_index: 'runtime-id', ...fields } as CliproxyUsageEvent)
    const usage = cliproxyEventsToAccountUsage([
      event(NOW - 7200000, { primary_used_percent: 12, primary_reset_at: (NOW - 1000) / 1000, secondary_used_percent: 37, secondary_reset_at: (NOW + 86400000) / 1000 }),
      event(NOW - 3600000, { primary_used_percent: 24, primary_reset_at: (NOW + 1000) / 1000, secondary_used_percent: 0, secondary_reset_at: null }),
    ], new Date(NOW))[authIndexToAccountId('runtime-id')]
    expect(usage.five_hour).toMatchObject({ utilization: 24, recorded_at: iso(NOW - 3600000), snapshot_source: 'recorded' })
    expect(usage.seven_day).toMatchObject({ utilization: 37, resets_at: iso(NOW + 86400000), recorded_at: iso(NOW - 7200000) })
    expect(quotaWindowState(usage.seven_day, NOW, usage.updated_at).updatedAt).toBe(iso(NOW - 7200000))
  })
})

describe('already-read Cockpit snapshots to account rows', () => {
  it('maps verified overall periods by raw identity and keeps percentage, reset and recorded time from each same snapshot', () => {
    const input = [snapshot(), snapshot({ modelId: 'five_hour', scope: 'pool', windowKind: 'fiveHour', percent: 25, resetAtMs: NOW + 3600000, updatedAtMs: NOW - 1000 })]
    const result = cockpitSnapshotsToAccountUsage(input, [account('account-a')], {}, NOW)[accountIdToCostId('account-a')]
    expect(result.five_hour).toMatchObject({ utilization: 75, resets_at: iso(NOW + 3600000), recorded_at: iso(NOW - 1000) })
    expect(result.seven_day).toMatchObject({ utilization: 20, resets_at: iso(NOW + 86400000), recorded_at: iso(NOW - 3600000) })
    expect(result.updated_at).toBe(iso(NOW - 1000))
    expect(quotaWindowState(result.seven_day, NOW, result.updated_at).updatedAt).toBe(iso(NOW - 3600000))
  })

  it('never joins by email/name, crosses platforms, or borrows one source identity for another', () => {
    expect(cockpitSnapshotsToAccountUsage([snapshot()], [account('another-id')], {}, NOW)).toEqual({})
    expect(cockpitSnapshotsToAccountUsage([snapshot()], [account('account-a', 'anthropic')], {}, NOW)).toEqual({})
    expect(cockpitSnapshotsToAccountUsage([snapshot({ accountId: '' })], [account('account-a')], {}, NOW)).toEqual({})
    const explicit = { ...account('canonical-a'), extra: { cockpit_account_id: 'account-a' } } as SourceAccount
    expect(cockpitSnapshotsToAccountUsage([snapshot()], [explicit], {}, NOW)[String(explicit.id)].seven_day?.utilization).toBe(20)
  })

  it('does not turn generic weekly or restricted Claude/model pools into overall 7d', () => {
    expect(cockpitSnapshotsToAccountUsage([snapshot({ windowKind: 'unknown' })], [account('account-a')], {}, NOW)).toEqual({})
    expect(cockpitSnapshotsToAccountUsage([snapshot({ scope: 'model' })], [account('account-a')], {}, NOW)).toEqual({})
    expect(cockpitSnapshotsToAccountUsage([snapshot({ modelId: 'weekly', windowKind: 'weekly' })], [account('account-a')], {}, NOW)).toEqual({})
    const result = cockpitSnapshotsToAccountUsage([
      snapshot({ channel: 'claude_manager', modelId: 'seven_day_sonnet', scope: 'pool', windowKind: 'weekly' }),
    ], [account('account-a', 'anthropic')], {}, NOW)[accountIdToCostId('account-a')]
    expect(result.seven_day).toBeNull()
    expect(result.seven_day_sonnet?.utilization).toBe(20)
    expect(cockpitSnapshotsToAccountUsage([snapshot({ channel: 'antigravity', modelId: 'gemini-weekly', windowKind: 'weekly' })], [account('account-a', 'antigravity')], {}, NOW)).toEqual({})
  })

  it('retains existing model quotas and valid pairs when a new source result is unavailable', () => {
    const previous: AccountUsageInfo = { source: 'passive', updated_at: iso(NOW - 3600000), five_hour: null, seven_day: null, seven_day_sonnet: null,
      antigravity_quota: { 'raw-model': { utilization: 48, reset_time: iso(NOW + 1000) } } }
    const base = { [accountIdToCostId('account-a')]: previous }
    const merged = cockpitSnapshotsToAccountUsage([snapshot({ percent: null })], [account('account-a')], base, NOW)
    expect(merged[accountIdToCostId('account-a')]).toBe(previous)
    const result = cockpitSnapshotsToAccountUsage([snapshot({ stale: true, sourceError: 'read failed' })], [account('account-a')], base, NOW)[accountIdToCostId('account-a')]
    expect(result.antigravity_quota).toBe(previous.antigravity_quota)
    expect(quotaWindowState(result.seven_day, NOW)).toMatchObject({ utilization: 20, historical: true, sourceError: 'read failed' })
    expect(base[accountIdToCostId('account-a')].seven_day).toBeNull()
  })

  it('does not create a 1970 reset date or borrow a fresh account timestamp when the source omits one', () => {
    const result = cockpitSnapshotsToAccountUsage([snapshot({ resetAtMs: null, updatedAtMs: null })], [account('account-a')], {}, NOW)[accountIdToCostId('account-a')]
    expect(quotaWindowState(result.seven_day, NOW, iso(NOW))).toMatchObject({ utilization: 20, resetState: 'unknown', updatedAt: null })
    const history = cockpitQuotaToAccountUsage([{ email: 'same@example.test', updatedAt: NOW, models: { model: { modelId: 'model', points: [{ timestamp: NOW - 1000, remainingPercentage: 60, resetTime: 0, countdownSeconds: 0 }] } } }], [{ accountId: 'account-a', email: 'same@example.test', usage: {} as never }])
    const model = history[accountIdToCostId('account-a')].antigravity_quota!.model as RecordedQuotaProgress & { reset_time: string }
    expect(model.reset_time).toBe('')
    expect(quotaWindowState(model, NOW)).toMatchObject({ utilization: 40, resetState: 'unknown', updatedAt: iso(NOW - 1000) })
  })
})
