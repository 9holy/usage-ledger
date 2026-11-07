import './costDataI18n'
import { describe, expect, it } from 'vitest'
import { accountIdToCostId, cockpitQuotaToAccountUsage, type CockpitPlatformAccountInput } from '../cockpitAdapter'
import { useCostCenterData } from '../useCostCenterData'
import type { CockpitAccountUsage, CockpitQuotaHistoryFile, CockpitStats } from '@/api/cockpit'

const EMAIL = 'member@example.invalid'
const OBSERVED = Date.UTC(2026, 9, 14, 20)
function history(remaining = 10): CockpitQuotaHistoryFile {
  return { email: EMAIL, updatedAt: OBSERVED, models: { 'gemini-pro': { modelId: 'gemini-pro', points: [
    { timestamp: OBSERVED, remainingPercentage: remaining, resetTime: OBSERVED + 3600000, countdownSeconds: 3600 },
  ] } } }
}
function google(id = 'google-member'): CockpitPlatformAccountInput {
  return { id, email: EMAIL, platform: 'antigravity' }
}
function usage(): CockpitAccountUsage {
  return { requestCount: 1, successCount: 1, failureCount: 0, totalLatencyMs: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0, updatedAt: OBSERVED } as CockpitAccountUsage
}
function stats(): CockpitStats {
  return { since: OBSERVED - 1000, updatedAt: OBSERVED, totals: usage(),
    accounts: [{ accountId: 'codex-member', email: EMAIL, usage: usage() }] }
}

describe('Cockpit compatibility history identity', () => {
  it('regression_google_email_history_cannot_claim_a_codex_stats_identity', () => {
    expect(cockpitQuotaToAccountUsage([history()], stats().accounts)).toEqual({})
  })

  it('regression_shared_email_history_cannot_choose_the_last_stats_account', () => {
    const accounts = [...stats().accounts, { accountId: 'codex-second-workspace', email: EMAIL, usage: usage() }]
    expect(cockpitQuotaToAccountUsage([history()], accounts)).toEqual({})
  })

  it('regression_compatibility_history_does_not_mark_codex_rate_limited', () => {
    const data = useCostCenterData()
    const old = history(0)
    old.models['gemini-pro'].points[0].resetTime = Date.now() + 3600000
    data.loadFromCockpit(stats(), null, 'today', [old])
    expect(data.accounts.value[0].status).toBe('active')
    expect(data.accounts.value[0].rate_limit_reset_at).toBeNull()
    expect(data.accountUsage.value).toEqual({})
  })

  it('regression_google_legacy_history_maps_to_its_explicit_platform_account_only', () => {
    const data = useCostCenterData()
    data.loadFromCockpit(stats(), null, 'today', [history()], null, new Map(), undefined, [google()])
    expect(Object.keys(data.accountUsage.value)).toEqual([accountIdToCostId('google-member')])
    expect(data.accountUsage.value[accountIdToCostId('google-member')].source).toBe('passive')
  })

  it('requires a unique Google identity and unique history file for an email', () => {
    expect(cockpitQuotaToAccountUsage([history()], [google('one'), google('two')])).toEqual({})
    expect(cockpitQuotaToAccountUsage([history(), history()], [google()])).toEqual({})
  })

  it('preserves the explicit instance namespace without using a display name as identity', () => {
    const result = cockpitQuotaToAccountUsage([history()], [google()], 'source-a')
    expect(Object.keys(result)).toEqual([accountIdToCostId('google-member', 'source-a')])
    expect(result[accountIdToCostId('google-member', 'source-a')].antigravity_quota?.['gemini-pro'].utilization).toBe(90)
  })

  it('selects the latest valid observation by timestamp, without borrowing the file write time', () => {
    const file = history(10)
    file.updatedAt = OBSERVED + 500000
    file.models['gemini-pro'].points.push({ timestamp: OBSERVED - 1000, remainingPercentage: 80, resetTime: 0, countdownSeconds: 0 })
    const result = cockpitQuotaToAccountUsage([file], [google()])[accountIdToCostId('google-member')]
    expect(result.updated_at).toBe(new Date(OBSERVED).toISOString())
    expect(result.antigravity_quota?.['gemini-pro'].utilization).toBe(90)
  })

  it('rejects out-of-domain and undated points instead of clamping them into measured values', () => {
    const file = history(120)
    file.models['gemini-pro'].points.push({ timestamp: 0, remainingPercentage: 0, resetTime: 0, countdownSeconds: 0 })
    expect(cockpitQuotaToAccountUsage([file], [google()])).toEqual({})
  })
})
