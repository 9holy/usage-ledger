import './costDataI18n'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthFile } from '@/api/cliproxy/management'
import { cliproxyTokenBreakdown, type CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import { authIndexToAccountId, cliproxyEventsToAccountUsage } from '../cliproxyAdapter'
import { cliproxyAuthFilesToAccounts } from '../cliproxyManagementAdapter'
import { averageQuotaRemaining, hasPrimaryUsageWindow, quotaRemainingRatio } from '../honestValues'
import { quotaWindowState } from '../quotaWindowState'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => { throw new Error('Pure source-contract fixture must not access a service') }) }))

const NOW = Date.UTC(2026, 10, 7, 12)
const iso = (ms: number) => new Date(ms).toISOString()
function event(patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1, requested_at: NOW - 1000, provider: 'codex', executor_type: 'CodexExecutor', model: 'fixture', alias: '',
    auth_index: 'runtime-index', auth_type: 'oauth', source: '', reasoning_effort: '', service_tier: '',
    latency_ms: 20, ttft_ms: 10, failed: false, status_code: 200,
    input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, cached_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 120,
    primary_used_percent: null, primary_reset_at: null, primary_used_tokens: null,
    primary_remaining_tokens: null, primary_limit_tokens: null, secondary_used_percent: null,
    secondary_reset_at: null, secondary_used_tokens: null, secondary_remaining_tokens: null,
    secondary_limit_tokens: null, ...patch,
  }
}
const file = (patch: Partial<AuthFile> = {}): AuthFile => ({
  id: 'file-id', name: 'fixture.json', auth_index: 'runtime-index', provider: 'codex', status: 'active',
  disabled: false, source: 'memory', success: 0, failed: 0, account_type: 'oauth', ...patch,
})

describe('pinned CLIProxyAPI and CPA source contracts', () => {
  it('preserves an opaque primary slot that lasts a week, its missing secondary and expired recorded value', () => {
    // CPA usage_events has no duration/presence columns. The upstream quota API permits
    // primary_window.limit_window_seconds=604800 and secondary_window=null.
    const reset = NOW + 7 * 86400000
    const [usage] = Object.values(cliproxyEventsToAccountUsage([event({ primary_used_percent: 37, primary_reset_at: reset / 1000 })], new Date(NOW)))
    expect(usage.five_hour).toBeNull()
    expect(usage.seven_day).toBeNull()
    expect(usage.primary_window).toMatchObject({ utilization: 37, resets_at: iso(reset), recorded_at: iso(NOW - 1000) })
    expect(usage.secondary_window).toBeNull()
    expect(quotaWindowState(usage.primary_window, reset + 1)).toMatchObject({ utilization: 37, resetState: 'expired', historical: true })
    expect(hasPrimaryUsageWindow(usage)).toBe(true)
    expect(quotaRemainingRatio(usage)).toBeCloseTo(0.63)
    expect(averageQuotaRemaining([usage, null])).toBeCloseTo(0.63)
  })

  it('uses the largest durable row id for equal-second quota samples, without conflating the two slots', () => {
    // recordUsage stores RequestedAt.Unix(); reporting.go orders requested_at DESC,id DESC.
    const older = event({ id: 10, primary_used_percent: 5, primary_reset_at: (NOW + 1000) / 1000,
      secondary_used_percent: 21, secondary_reset_at: (NOW + 86400000) / 1000 })
    const newer = event({ id: 11, primary_used_percent: 25, primary_reset_at: (NOW + 2000) / 1000 })
    for (const events of [[older, newer], [newer, older]]) {
      const usage = cliproxyEventsToAccountUsage(events, new Date(NOW))[authIndexToAccountId('runtime-index')]
      expect(usage.primary_window?.utilization).toBe(25)
      expect(usage.secondary_window?.utilization).toBe(21)
    }
  })

  it('preserves a nonzero secondary percentage when the independently parsed reset header is absent', () => {
    const usage = cliproxyEventsToAccountUsage([event({ secondary_used_percent: 15, secondary_reset_at: null })], new Date(NOW))[authIndexToAccountId('runtime-index')]
    expect(usage.secondary_window).toMatchObject({ utilization: 15, resets_at: null, recorded_at: iso(NOW - 1000) })
    expect(quotaWindowState(usage.secondary_window, NOW)).toMatchObject({ utilization: 15, resetState: 'unknown', historical: true })
  })

  it('keeps a raw quota slot in pool progress even when both named-duration slots are absent', () => {
    const usage = { updated_at: iso(NOW), five_hour: null, seven_day: null, seven_day_sonnet: null,
      primary_window: { utilization: 0, resets_at: null, remaining_seconds: 0 },
      secondary_window: { utilization: 73, resets_at: null, remaining_seconds: 0 } }
    expect(hasPrimaryUsageWindow(usage)).toBe(true)
    expect(quotaRemainingRatio(usage)).toBeCloseTo(0.27)
    expect(averageQuotaRemaining([usage])).toBeCloseTo(0.27)
  })

  it('renders untranslated-duration CPA slots with primary/secondary labels and retains explicit 5h/7d paths', () => {
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    expect(view).toContain("label: t('costCenter.integration.quotaPrimaryWindow')")
    expect(view).toContain("label: t('costCenter.integration.quotaSecondaryWindow')")
    expect(view).toContain("key: '5h', label: '5h', reading: usage.five_hour")
    expect(view).toContain("key: '7d', label: '7d', reading: usage.seven_day")
  })

  it('does not turn an authentication refresh into an observed request', () => {
    const af = file({ created_at: iso(NOW - 86400000), updated_at: iso(NOW - 10000), last_refresh: iso(NOW) })
    const [withoutUsage] = cliproxyAuthFilesToAccounts([af], [])
    expect(withoutUsage.last_used_at).toBeNull()
    expect(withoutUsage.updated_at).toBe(af.updated_at)
    expect(withoutUsage.created_at).toBe(af.created_at)
    const [withUsage] = cliproxyAuthFilesToAccounts([af], [event()])
    expect(withUsage.last_used_at).toBe(iso(NOW - 1000))
  })

  it('does not invent runtime health for the upstream disk-only auth-file fallback', () => {
    // listAuthFilesFromDisk returns name/size/modtime/type/email, without runtime state.
    const diskOnly = { name: 'disk.json', size: 120, modtime: iso(NOW), type: 'codex', email: 'current@example.test' } as AuthFile
    expect(cliproxyAuthFilesToAccounts([diskOnly], [])).toEqual([])
    const disabledStatus = file({ status: 'disabled', disabled: false })
    expect(cliproxyAuthFilesToAccounts([disabledStatus], [])[0].status).toBe('inactive')
  })

  it('does not add Anthropic thinking twice: the persisted raw output already includes it', () => {
    // parseClaudeUsageNode preserves rawOutputTokens in Detail.OutputTokens, subtracts
    // thinking only for the canonical constructor. CPA persists Detail, not that breakdown.
    expect(cliproxyTokenBreakdown(event({ provider: 'anthropic', executor_type: 'ClaudeExecutor',
      input_tokens: 20, output_tokens: 25, reasoning_tokens: 5, cached_tokens: 70,
      cache_read_tokens: 70, cache_creation_tokens: 10, total_tokens: 125 })))
      .toMatchObject({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 70, cacheWriteTokens: 10 })
  })

  it('includes separately reported Gemini thinking, while OpenAI reasoning remains within output', () => {
    expect(cliproxyTokenBreakdown(event({ provider: 'gemini', executor_type: 'GeminiExecutor', reasoning_tokens: 5, total_tokens: 125 })).outputTokens).toBe(25)
    expect(cliproxyTokenBreakdown(event({ reasoning_tokens: 5 })).outputTokens).toBe(20)
  })
})
