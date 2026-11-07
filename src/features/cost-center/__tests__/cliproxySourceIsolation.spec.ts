import './costDataI18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActiveConnection } from '@/api/url'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { AuthFile } from '@/api/cliproxy/management'
import { readCostProfiles, writeCostProfiles } from '@/api/cockpit'
import { authIndexToAccountId, cliproxyEventsToAccounts, cliproxyEventsToAccountUsage, cliproxyEventsToTodayStats } from '../cliproxyAdapter'
import { cliproxyAuthFilesToAccounts, cliproxyEventsToModelRoutes } from '../cliproxyManagementAdapter'
import { useCostCenterData } from '../useCostCenterData'
import { classifyUpstreamProvider, describeUpstreamOrigin } from '../upstreamProvider'

vi.mock('@/api/cockpit', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/cockpit')>(), readCostProfiles: vi.fn(), writeCostProfiles: vi.fn(),
}))

const NOW = Date.UTC(2026, 10, 7, 12)
const prices = { fixture: { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 } }
function event(instance = 'local', patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1, source_instance_id: instance, requested_at: NOW - 1000, provider: 'codex', executor_type: 'CodexExecutor',
    model: 'fixture', alias: 'requested-model-alias', auth_index: 'same-runtime-slot', auth_type: 'apikey', source: '',
    reasoning_effort: '', service_tier: '', latency_ms: 20, ttft_ms: 10, failed: false, status_code: 200,
    input_tokens: 1_000_000, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 0,
    cache_creation_tokens: 0, total_tokens: 1_000_000, primary_used_percent: 21, primary_reset_at: NOW / 1000 + 1000,
    primary_used_tokens: null, primary_remaining_tokens: null, primary_limit_tokens: null,
    secondary_used_percent: null, secondary_reset_at: null, secondary_used_tokens: null,
    secondary_remaining_tokens: null, secondary_limit_tokens: null, ...patch,
  }
}
const file = (email: string): AuthFile => ({ id: 'same-file.json', name: 'same-file.json', auth_index: 'same-runtime-slot',
  provider: 'codex', email, account_type: 'oauth', status: 'active', disabled: false, source: 'file', success: 0, failed: 0 })

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW)
  vi.mocked(readCostProfiles).mockResolvedValue({})
  vi.mocked(writeCostProfiles).mockResolvedValue(undefined)
  setActiveConnection({ id: 'management-local', type: 'cliproxy', baseUrl: 'http://127.0.0.1:8317', name: 'local', apiKey: '', lastUsed: 0 })
})
afterEach(() => { vi.useRealTimers(); setActiveConnection(null) })

describe('CPA local instance and authentication-slot isolation', () => {
  it('does not turn an opaque or compatible protocol into an official upstream identity', () => {
    const [unknown] = cliproxyEventsToAccounts([event('local', { provider: 'opaque-route', executor_type: 'opaque', model: 'opaque' })])
    expect(classifyUpstreamProvider(unknown)).toBe('other')
    expect(describeUpstreamOrigin(unknown)).not.toContain('官方')
    const [compatible] = cliproxyEventsToAccounts([event('local', { provider: 'openai-compatible-route', executor_type: 'OpenAICompatExecutor' })])
    expect(classifyUpstreamProvider(compatible)).toBe('relay')
    const [oauth] = cliproxyEventsToAccounts([event('local', { provider: 'codex', auth_type: 'oauth' })])
    expect(classifyUpstreamProvider(oauth)).toBe('codex')
  })
  it('isolates equal raw indexes across source directories in accounts, quota, window sums and routes', () => {
    const a = event('path-a'), b = event('path-b', { id: 2, input_tokens: 2_000_000, total_tokens: 2_000_000, primary_used_percent: 52 })
    const accounts = cliproxyEventsToAccounts([a, b])
    expect(accounts).toHaveLength(2)
    const aId = authIndexToAccountId(a.auth_index, 'path-a'), bId = authIndexToAccountId(b.auth_index, 'path-b')
    expect(aId).not.toBe(bId)
    expect(authIndexToAccountId(a.auth_index)).toBe(`cliproxy:${a.auth_index}`)
    expect(accounts.map(row => row.id)).toEqual([aId, bId])
    const quota = cliproxyEventsToAccountUsage([a, b], new Date(NOW))
    expect(quota[aId].primary_window?.utilization).toBe(21)
    expect(quota[bId].primary_window?.utilization).toBe(52)
    const sums = cliproxyEventsToTodayStats([a, b], prices, 0.2)
    expect(sums[aId]).toMatchObject({ requests: 1, tokens: 1_000_000 })
    expect(sums[bId]).toMatchObject({ requests: 1, tokens: 2_000_000 })
    const routes = cliproxyEventsToModelRoutes([a, b], prices, accounts, '1h', 0.2, new Date(NOW))
    expect(routes).toHaveLength(2)
    expect(routes.map(row => row.accountId)).toEqual([aId, bId])
    expect(routes.map(row => row.costUsd)).toEqual([0.4, 0.8])
  })

  it('does not join a custom local database to the default management account and scopes persisted profiles', async () => {
    const data = useCostCenterData()
    data.cockpitCostMultiplier.value = 0.2
    const load = (instance: string) => data.loadFromCliproxy([file('new-owner@example.test')], null, null,
      [event(instance)], prices, {}, '1h', '1h', 7, new Date(NOW), true, null,
      { sourceInstanceId: instance, managementLinkAllowed: false })
    load('path-a')
    expect(data.cliproxyLocalAccountLink.value).toBe(false)
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'cliproxy', instanceId: 'path-a' })
    const first = data.accounts.value[0]
    expect(first.name).not.toContain('new-owner')
    expect(first.extra?.cliproxy_identity_source).toBe('usage_only')
    const profile = { amount: 42, currency: 'USD' as const, billing_cycle: 'monthly' as const, started_at: '2026-11-01T00:00:00Z', algorithm_version: 'test' }
    await data.saveCockpitCostProfile(first, profile)
    const saved = vi.mocked(writeCostProfiles).mock.calls.at(-1)![0]
    expect(saved[String(first.id)]).toEqual(profile)
    load('path-b')
    await data.mergeLocalCostProfiles()
    expect(data.accounts.value[0].id).not.toBe(first.id)
    expect(data.accounts.value[0].extra?.cost_profile).toBeUndefined()
    expect(data.rangeAccountStatsScope.value?.instanceId).toBe('path-b')
    expect(data.accountEconomics.value?.actual.account_cost_usd).toBe(0.4)
    load('path-a')
    await data.mergeLocalCostProfiles()
    expect(data.accounts.value[0].extra?.cost_profile).toMatchObject({ amount: 42 })
  })

  it('keeps historical slot attribution unchanged when a file slot is reused by a new current owner', () => {
    const history = [event('local', { auth_type: '', provider: 'historical-provider' })]
    const oldOwner = cliproxyAuthFilesToAccounts([file('old-owner@example.test')], history)[0]
    const newOwner = cliproxyAuthFilesToAccounts([file('new-owner@example.test')], history)[0]
    expect(oldOwner.id).toBe(newOwner.id)
    expect(newOwner.name).toBe(oldOwner.name)
    expect(newOwner.name).toContain('认证槽')
    expect(newOwner.name).not.toContain('requested-model-alias')
    expect(newOwner.name).not.toContain('owner@example.test')
    expect(newOwner.extra).toMatchObject({ cliproxy_identity_source: 'usage_only', cliproxy_auth_type_known: false, cliproxy_owner_verified: false })
    expect(cliproxyEventsToModelRoutes(history, prices, [newOwner], '1h', 0.2, new Date(NOW))[0])
      .toMatchObject({ accountName: newOwner.name, accountType: null, accountIdentitySource: 'usage_only', requests: 1, costUsd: 0.4 })
  })

  it('rejects a mixed-source batch rather than assigning it one finance scope', () => {
    const data = useCostCenterData()
    expect(() => data.loadFromCliproxy([], null, null, [event('path-a'), event('path-b')], prices, {}, '1h', '1h', 7, new Date(NOW), true)).toThrow('CPA source instances')
  })

  it('passes the native source identity to the display loader and the financial scope', () => {
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    expect(view).toContain('data.cliproxySourceInstanceId.value')
    expect(view).toContain('cliproxyAuthFileError.value : null, usageSnapshot)')
    expect(view).toContain("sourceInstanceId: 'unavailable', managementLinkAllowed: false")
    expect(view).toContain("showHistoricalAccounts.value || !row.isHistorical || row.account.extra?.cliproxy_identity_source === 'usage_only'")
    expect(view).toContain('cliproxyAuthFilesToAccounts(data.cliproxyAuthFiles.value, [])')
  })

  it('keeps a failed producer read outside the default local finance scope', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([file('current@example.test')], null, null, [event()], prices, {}, '1h', '1h', 7, new Date(NOW), true)
    expect(data.rangeAccountStatsScope.value?.instanceId).toBe('local')
    data.loadFromCliproxy([file('current@example.test')], null, null, [], {}, {}, '1h', '1h', 7, new Date(NOW), false, null,
      { sourceInstanceId: 'unavailable', managementLinkAllowed: false })
    expect(data.cliproxySourceInstanceId.value).toBe('unavailable')
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'cliproxy', instanceId: 'unavailable' })
    expect(data.cliproxyLocalAccountLink.value).toBe(false)
    expect(data.accounts.value).toEqual([])
    expect(data.sourceStates.value.rangeStats.status).toBe('unavailable')
  })
})
