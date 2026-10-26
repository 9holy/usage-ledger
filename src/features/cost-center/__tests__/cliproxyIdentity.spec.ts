import './costDataI18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveConnection } from '@/api/url'
import type { AuthFile } from '@/api/cliproxy/management'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import { authIndexToAccountId, cliproxyAuthTypeToAccountType, cliproxyEventsToAccounts, cliproxyEventsToModelStats, cliproxyEventsToEconomics } from '../cliproxyAdapter'
import { cliproxyAuthFilesToAccounts, cliproxyEventsToModelRoutes } from '../cliproxyManagementAdapter'
import { useCostCenterData } from '../useCostCenterData'
import { resolveAccountBillingMode } from '../model'
import { accountIdToCostId } from '../cockpitAdapter'

const prices = { fixture: { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6 } }
function event(patch: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1, requested_at: Date.now() - 1000, provider: 'openai-compatible', executor_type: 'fixture',
    model: 'fixture', alias: 'fixture', auth_index: 'opaque-runtime-index', auth_type: 'apikey', source: 'fixture',
    reasoning_effort: '', service_tier: 'auto', latency_ms: 20, ttft_ms: 10, failed: false, status_code: 200,
    input_tokens: 1_000_000, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 0,
    cache_creation_tokens: 0, total_tokens: 1_000_000,
    primary_used_percent: null, primary_reset_at: null, primary_used_tokens: null, primary_remaining_tokens: null,
    primary_limit_tokens: null, secondary_used_percent: null, secondary_reset_at: null, secondary_used_tokens: null,
    secondary_remaining_tokens: null, secondary_limit_tokens: null, ...patch,
  }
}
function file(patch: Partial<AuthFile> = {}): AuthFile {
  return { id: 'file-id', auth_index: 'opaque-runtime-index', name: 'management fixture', provider: 'codex', status: 'active', disabled: false, source: 'memory', success: 0, failed: 0, account_type: 'apikey', ...patch }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
  setActiveConnection({ id: 'local', type: 'cliproxy', baseUrl: 'http://127.0.0.1:8317', name: 'local fixture', apiKey: '', lastUsed: 0 })
})
afterEach(() => { setActiveConnection(null); vi.useRealTimers() })

describe('CPA source identity and usage evidence', () => {
  it('resolves account metadata only when a route group is created, keeping first matching identity and amounts', () => {
    const accounts = cliproxyAuthFilesToAccounts([file()], [])
    accounts.push({ ...accounts[0], name: 'later duplicate must not win' })
    const lookup = vi.spyOn(accounts, 'find')
    const events = Array.from({ length: 2000 }, (_, index) => event({ id: index, alias: index % 2 ? 'alias-B' : 'alias-A' }))
    const rows = cliproxyEventsToModelRoutes(events, prices, accounts, '1h', 0.2)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.accountName).toBe(accounts[0].name)
      expect(row.accountId).toBe(accounts[0].id)
      expect(row.requests).toBe(1000)
      expect(row.inputTokens).toBe(1_000_000_000)
      expect(row.outputTokens).toBe(0)
      expect(row.costUsd).toBeCloseTo(400)
      expect(row.costUnknown).toBe(false)
    }
    lookup.mockRestore()
  })

  it('isolates management-file identities from identically named opaque runtime indexes', () => {
    const managed = cliproxyAuthFilesToAccounts([file({ auth_index: '', id: 'x:/opaque' })], [])[0]!
    const runtime = cliproxyEventsToAccounts([event({ auth_index: 'management-file:x:/opaque' })])[0]!
    expect(managed.id).toBe('cliproxy:management-file:x%3A%2Fopaque')
    expect(runtime.id).toBe('cliproxy:management-file%3Ax%3A%2Fopaque')
    expect(managed.id).not.toBe(runtime.id)
  })
  it('keeps formerly colliding raw IDs and equal IDs from different sources separate', () => {
    const events = [event({ auth_index: 'costarring' }), event({ auth_index: 'liquid' }), event({ auth_index: ' ' })]
    const accounts = cliproxyEventsToAccounts(events)
    expect(accounts.map(account => account.id)).toEqual(['cliproxy:costarring', 'cliproxy:liquid'])
    expect(authIndexToAccountId('costarring')).not.toBe(accountIdToCostId('costarring'))
    expect(authIndexToAccountId('a:b/c')).toBe('cliproxy:a%3Ab%2Fc')
    expect(accounts.map(account => account.id)).not.toContain(1582148253)
    const routes = cliproxyEventsToModelRoutes(events, prices, accounts, '1h', 0.2, new Date())
    expect(new Set(routes.map(route => route.accountId))).toEqual(new Set(['cliproxy:costarring', 'cliproxy:liquid', null]))
  })
  it('keeps missing creation time unknown instead of making each reload a new lifecycle', () => {
    const first = cliproxyAuthFilesToAccounts([file()], [])[0]!
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    const next = cliproxyAuthFilesToAccounts([file()], [])[0]!
    expect(first.created_at).toBe('')
    expect(next.created_at).toBe('')
    expect(first.extra?.cliproxy_created_at_known).toBe(false)
    const known = cliproxyAuthFilesToAccounts([file({ created_at: '2026-01-01T00:00:00Z' })], [])[0]!
    expect(known.created_at).toBe('2026-01-01T00:00:00Z')
    expect(known.extra?.cliproxy_created_at_known).toBe(true)
  })
  it('uses declared auth_type, not an opaque index prefix, and marks unknown type explicitly', () => {
    for (const type of ['apikey', 'api_key', 'api-key']) expect(cliproxyAuthTypeToAccountType(type)).toBe('apikey')
    const [known] = cliproxyEventsToAccounts([event()])
    expect(known!.type).toBe('apikey')
    expect(known!.extra).toMatchObject({ cliproxy_identity_source: 'usage_only', cliproxy_status_basis: 'historical_requests', cliproxy_auth_type_known: true })
    const unknown = cliproxyEventsToAccounts([event({ auth_type: '' })])[0]!
    expect(unknown.extra?.cliproxy_auth_type_known).toBe(false)
    expect(resolveAccountBillingMode(unknown)).toBe('unknown')
    const snapshot = cliproxyEventsToEconomics([event({ auth_type: '' })], prices, 7, undefined, '1h', 0.2, new Date())!
    expect(snapshot.actual.procurement_accrued_cny).toBe(0)
    expect(snapshot.actual.window_procurement_cny).toBe(0)
    expect(snapshot.data_quality.status).toBe('partial')
  })

  it('accepts declared or exact-linked OAuth evidence but not a provider-only guess', () => {
    const declared = cliproxyAuthFilesToAccounts([file({ account_type: 'oauth' })], [])[0]!
    expect(resolveAccountBillingMode(declared)).toBe('subscription')
    const linked = cliproxyAuthFilesToAccounts([file({ account_type: undefined })], [event({ auth_type: 'oauth' })])[0]!
    expect(resolveAccountBillingMode(linked)).toBe('subscription')
    const unproved = cliproxyAuthFilesToAccounts([file({ account_type: undefined, provider: 'antigravity' })], [])[0]!
    expect(resolveAccountBillingMode(unproved)).toBe('unknown')
  })

  it('initial and recomputed economics both use 2 USD reference and 0.4 USD fee, including partial input', async () => {
    const data = useCostCenterData(); data.cockpitCostMultiplier.value = 0.2
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.accountEconomics.value!.actual.billed_usd).toBe(2)
    expect(data.accountEconomics.value!.actual.account_cost_usd).toBe(0.4)
    await data.loadAccountEconomics('all', '1h')
    expect(data.accountEconomics.value!.actual.billed_usd).toBe(2)
    expect(data.accountEconomics.value!.actual.account_cost_usd).toBe(0.4)
    data.loadFromCliproxy([], null, null, [event(), event({ id: 2, model: 'unpriced-fixture' })], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.accountEconomics.value!.actual.billed_usd).toBe(2)
    expect(data.accountEconomics.value!.actual.account_cost_usd).toBe(0.4)
    expect(data.accountEconomics.value!.data_quality.status).toBe('partial')
    await data.loadAccountEconomics('all', '1h')
    expect(data.accountEconomics.value!.actual.billed_usd).toBe(2)
    expect(data.accountEconomics.value!.actual.account_cost_usd).toBe(0.4)
    expect(data.accountEconomics.value!.data_quality.status).toBe('partial')
  })

  it('keeps anonymous amounts distinct from a real unknown identity without creating an anonymous account', async () => {
    const data = useCostCenterData(); data.cockpitCostMultiplier.value = 0.2
    data.loadFromCliproxy([], null, null, [event({ auth_index: '' }), event({ id: 2, auth_index: 'unknown' })], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.accounts.value).toHaveLength(1)
    expect(data.accountEconomics.value!.health.account_count).toBe(1)
    expect(data.accountEconomics.value!.actual.billed_usd).toBe(4)
    expect(data.accountEconomics.value!.actual.account_cost_usd).toBe(0.8)
    await data.loadAccountEconomics('all', '1h')
    expect(data.accountEconomics.value!.health.account_count).toBe(1)
    expect(data.accountEconomics.value!.actual.billed_usd).toBe(4)
    expect(data.accountEconomics.value!.actual.account_cost_usd).toBe(0.8)
  })

  it('does not join file id to runtime auth_index or drop the separate usage identity', () => {
    const unmanagedIndex = 'same-text-different-identity'
    const af = file({ auth_index: '', id: unmanagedIndex })
    const ev = event({ auth_index: unmanagedIndex })
    const [management] = cliproxyAuthFilesToAccounts([af], [ev])
    expect(management!.id).not.toBe(authIndexToAccountId(unmanagedIndex))
    expect(management!.last_used_at).toBeNull()
    expect(management!.extra).toMatchObject({ cliproxy_identity_source: 'management', cliproxy_usage_linked: false })
    const data = useCostCenterData()
    data.loadFromCliproxy([af], null, null, [ev], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.accounts.value).toHaveLength(2)
    expect(data.accounts.value.filter(a => a.extra?.cliproxy_identity_source === 'management')).toHaveLength(1)
    expect(data.accounts.value.filter(a => a.extra?.cliproxy_identity_source === 'usage_only')).toHaveLength(1)
    expect(Object.values(data.rangeAccountStats.value).reduce((n, row) => n + row.requests, 0)).toBe(1)
  })

  it('joins only the exact nonempty local auth_index and keeps current management status', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([file()], null, null, [event({ failed: true, status_code: 429 })], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.accounts.value).toHaveLength(1)
    expect(data.accounts.value[0]!.status).toBe('active')
    expect(data.accounts.value[0]!.extra).toMatchObject({ cliproxy_identity_source: 'management', cliproxy_status_basis: 'management_current', cliproxy_usage_linked: true })
  })

  it('preserves failed zero-usage counts and separates route reference/account amounts', () => {
    const events = [event(), event({ id: 2, failed: true, status_code: 429, input_tokens: 0, total_tokens: 0 })]
    const data = useCostCenterData(); data.cockpitCostMultiplier.value = 0.2
    data.loadFromCliproxy([], null, null, events, prices, {}, '1h', '1h', 7, new Date(), true)
    const [route] = data.modelRoutes.value
    expect(route).toMatchObject({ requests: 2, totalTokens: 1_000_000, failedRequests: 1, zeroTokenRequests: 1, failedZeroTokenRequests: 1, standardCost: 2, accountCost: 0.4, channelName: '', groupName: '', inboundEndpoint: '', upstreamEndpoint: '' })
    expect(route!.costBasis).toContain('0 不等于已确认免费')
    expect(data.sourceStates.value.modelRoutes.status).toBe('partial')
    expect(data.sourceStates.value.modelAudit.status).toBe('unavailable')
    expect(cliproxyEventsToModelStats(events, prices, '1h', 0.2)[0]).toMatchObject({ requests: 2, failed_requests: 1, zero_token_requests: 1, failed_zero_token_requests: 1 })
  })

  it('keeps requested aliases and missing-auth rows distinct without inventing route dimensions', () => {
    const rows = cliproxyEventsToModelRoutes([event({ alias: 'request-A' }), event({ id: 2, alias: 'request-B' }), event({ id: 3, auth_index: '' }), event({ id: 4, auth_index: 'unknown' })], prices, [], '1h', 0.2)
    expect(rows).toHaveLength(4)
    expect(rows.reduce((n, row) => n + row.requests, 0)).toBe(4)
    expect(rows.find(row => !row.authIndex)).toMatchObject({ accountId: null, accountIdentitySource: 'unattributed' })
    expect(rows.find(row => row.authIndex === 'unknown')!.accountId).toBe(authIndexToAccountId('unknown'))
  })

  it('distinguishes quota fields not reported from read unavailable and from a real quota snapshot', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, [event()], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.cliproxyQuotaDataState.value).toBe('not_reported')
    expect(data.sourceStates.value.accountUsage.reason).toContain('未上报逐账号配额')
    data.loadFromCliproxy([], null, null, [], prices, {}, '1h', '1h', 7, new Date(), false)
    expect(data.cliproxyQuotaDataState.value).toBe('read_unavailable')
    expect(data.sourceStates.value.rangeStats.status).toBe('unavailable')
    data.loadFromCliproxy([], null, null, [event({ primary_used_percent: 20, primary_reset_at: Date.now() / 1000 + 600 })], prices, {}, '1h', '1h', 7, new Date(), true)
    expect(data.cliproxyQuotaDataState.value).toBe('reported')
    data.resetRangeWindowState()
    expect(data.cliproxyQuotaDataState.value).toBe('not_loaded')
  })
})
