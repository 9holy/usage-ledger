import './costDataI18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref } from 'vue'
import { setActiveConnection } from '@/api/url'
import * as cockpit from '@/api/cockpit'
import type { CockpitRequestLogSummary, CockpitStats, CostProfileMap } from '@/api/cockpit'
import { accountIdToCostId, cockpitStatsToAccounts, cockpitRequestLogToAccountStats, cockpitSnapshotsToAccountUsage } from '../cockpitAdapter'
import { cockpitEffectivePriceSets } from '../cockpitPriceBook'
import { useCostCenterData } from '../useCostCenterData'
import { useUnifiedCost } from '../useUnifiedCost'
import { useChannelQuota } from '../useChannelQuota'
import { getQuotaChannels, getQuotaSnapshots, refreshQuotaSnapshots } from '@/api/cockpit/quota'
vi.mock('@/api/cockpit/quota', () => ({ getQuotaChannels: vi.fn(), getQuotaSnapshots: vi.fn(), refreshQuotaSnapshots: vi.fn() }))

const mocks = vi.hoisted(() => ({ identity: vi.fn() }))
vi.mock('@/api/url', async original => ({ ...await original<typeof import('@/api/url')>(), isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', async original => ({ ...await original<typeof import('@/stores/connection')>(), useConnectionStore: () => ({ active: null, connections: [] }) }))
vi.mock('@/api/cockpit', async original => ({ ...await original<typeof import('@/api/cockpit')>(),
  getCockpitSourceIdentity: mocks.identity, readCostProfiles: vi.fn(), writeCostProfiles: vi.fn(), getCockpitStats: vi.fn(),
  getCockpitCodexAccounts: vi.fn(), getCockpitLocalAccess: vi.fn(), getCockpitRequestLogSummary: vi.fn(),
}))

const NOW = Date.UTC(2026, 10, 7, 12), RAW = 'codex_apikey_same_key_digest'
const A = 'cockpit:directory-a', B = 'cockpit:directory-b'
const bounds = { start: new Date(NOW - 3600000), end: new Date(NOW) }
let stored: CostProfileMap
function fixture() {
  const totals = { requestCount: 1, successCount: 1, failureCount: 0, clientCanceledCount: 0, totalLatencyMs: 5,
    inputTokens: 1000000, outputTokens: 0, cachedTokens: 0, totalTokens: 1000000, reasoningTokens: 0, estimatedCostUsd: 0 }
  const account = { accountId: RAW, email: 'same@example.test', usage: totals }
  const stats = { since: NOW - 3600000, updatedAt: NOW, totals, accounts: [account], models: [], apiKeys: [],
    daily: { since: NOW - 3600000, updatedAt: NOW, totals, accounts: [account], models: [], apiKeys: [] }, weekly: null, monthly: null } as CockpitStats
  const summary = { available: true, reason: null, rowCount: 1, windowStartMs: NOW - 1000, windowEndMs: NOW - 1000, bucketHours: 1, bucketLatencies: [], cells: [], groups: [{
    model: 'gpt-6-astra', accountId: RAW, apiKeyId: '', firstMs: NOW - 1000, lastMs: NOW - 1000, requests: 1, success: 1, error: 0,
    stdNormalInput: 1000000, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0,
    rateLimited: 0, upstreamError: 0, clientCanceled: 0,
  }] } as CockpitRequestLogSummary
  return { stats, summary }
}
function load(data: ReturnType<typeof useCostCenterData>, instance: string) {
  const { stats, summary } = fixture()
  data.cockpitCostMultiplier.value = 1
  ;(data.loadFromCockpit as Function)(stats, null, '1h', [], null, new Map(), undefined, [], null, null, null,
    summary, summary, new Map([[RAW, 'Source group']]), null, bounds, instance)
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW); setActiveConnection(null)
  stored = {}
  vi.mocked(cockpit.readCostProfiles).mockImplementation(async () => structuredClone(stored))
  vi.mocked(cockpit.writeCostProfiles).mockImplementation(async value => { stored = structuredClone(value) })
  mocks.identity.mockResolvedValue({ sourceInstanceId: A })
  const { stats, summary } = fixture()
  vi.mocked(cockpit.getCockpitStats).mockResolvedValue(stats)
  vi.mocked(cockpit.getCockpitRequestLogSummary).mockResolvedValue(summary)
  vi.mocked(cockpit.getCockpitCodexAccounts).mockResolvedValue([])
  vi.mocked(cockpit.getCockpitLocalAccess).mockResolvedValue(null)
  localStorage.setItem('2api-console.unified-sources', JSON.stringify(['cockpit']))
})
afterEach(() => { vi.useRealTimers(); setActiveConnection(null) })

describe('Cockpit physical source isolation', () => {
  it('namespaces identical raw API-key ids while preserving legacy default ids and numeric facts', () => {
    const { stats, summary } = fixture()
    const idA = (accountIdToCostId as Function)(RAW, A), idB = (accountIdToCostId as Function)(RAW, B)
    expect(idA).not.toBe(idB)
    expect(accountIdToCostId(RAW)).toBe(`cockpit:${RAW}`)
    const accountsA = (cockpitStatsToAccounts as Function)(stats, new Map(), undefined, undefined, undefined, undefined, A)
    expect(accountsA[0].id).toBe(idA)
    const usage = (cockpitRequestLogToAccountStats as Function)(summary, cockpitEffectivePriceSets(), 1, A)
    expect(usage[idA]).toMatchObject({ requests: 1, tokens: 1000000, cost: 10 })
    expect(usage[idB]).toBeUndefined()
    const snapshot = { channel: 'codex', accountId: RAW, modelId: 'seven_day', windowKind: 'weekly', scope: 'account', percent: 80,
      source: 'local', stale: false, updatedAtMs: NOW, resetAtMs: NOW + 10000 }
    const quotaA = (cockpitSnapshotsToAccountUsage as Function)([snapshot], accountsA, {}, NOW, A)
    expect(quotaA[idA]?.seven_day?.utilization).toBe(20)
    const wrong = (cockpitSnapshotsToAccountUsage as Function)([snapshot], accountsA, {}, NOW, B)
    expect(wrong).toEqual({})
  })

  it('keeps account profiles, request routes, selected model rows and finance range on one source', async () => {
    const data = useCostCenterData()
    load(data, A)
    const idA = data.accounts.value[0].id
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'cockpit', instanceId: A })
    expect(data.modelRoutes.value[0]).toMatchObject({ accountId: idA, requests: 1, totalTokens: 1000000, accountCost: 10 })
    const profile = { amount: 42, currency: 'USD' as const, billing_cycle: 'monthly' as const, started_at: '2026-11-01T00:00:00Z', algorithm_version: 'fixture' }
    await data.saveCockpitCostProfile(data.accounts.value[0], profile)
    data.modelCostAccountId.value = idA
    data.loadCockpitModelWindow(fixture().summary, null, '7d')
    expect(data.models.value[0]?.requests).toBe(1)
    load(data, B)
    await data.mergeLocalCostProfiles()
    expect(data.accounts.value[0].id).not.toBe(idA)
    expect(data.accounts.value[0].extra?.cost_profile).toBeUndefined()
    expect(data.modelCostAccountId.value).toBeNull()
    expect(data.rangeAccountStatsScope.value?.instanceId).toBe(B)
    load(data, A)
    await data.mergeLocalCostProfiles()
    expect(data.accounts.value[0].extra?.cost_profile).toMatchObject({ amount: 42 })
  })

  it('does not treat a failed native identity as default local finance scope', () => {
    const data = useCostCenterData()
    load(data, 'local')
    data.clearCockpitSourceData('source identity read failed')
    expect((data as any).cockpitSourceInstanceId?.value).toBe('unavailable')
    expect(data.accounts.value).toEqual([])
    expect(data.rangeAccountStatsScope.value).not.toEqual({ source: 'cockpit', instanceId: 'local' })
  })

  it('identifies a same-window summary by the physical source and rejects a root change during the read', async () => {
    const unified = useUnifiedCost(ref(null), ref(1))
    await unified.loadUnified('1h', bounds)
    expect(unified.sourceStatuses.value.cockpit.instanceId).toBe(`cockpit:${encodeURIComponent(A)}:request_logs`)
    expect(unified.cockpitCost.value).toBe(10)
    mocks.identity.mockResolvedValueOnce({ sourceInstanceId: A }).mockResolvedValueOnce({ sourceInstanceId: B })
    await unified.loadUnified('1h', bounds)
    expect(unified.cockpitCost.value).toBeNull()
    expect(unified.sourceStatuses.value.cockpit.state).toBe('unavailable')
  })

  it('does not join a fresh source to another source cumulative account-cost map with the same raw id', async () => {
    const unified = (useUnifiedCost as Function)(ref(null), ref(1), undefined, ref({ [RAW]: 99 }), undefined, undefined,
      ref({ [RAW]: 'priced' }), ref(A)) as ReturnType<typeof useUnifiedCost>
    await unified.loadUnified('1h', bounds)
    expect(unified.cockpitAccountRows.value[0]).toMatchObject({ accountId: RAW, costUsd: 99, costIsOurs: true })
    mocks.identity.mockResolvedValue({ sourceInstanceId: B })
    await unified.loadUnified('1h', bounds)
    expect(unified.cockpitAccountRows.value[0].costIsOurs).toBe(false)
    expect(unified.cockpitAccountRows.value[0].costBasis).toBe('no_price_no_estimate')
    expect(unified.cockpitCost.value).toBe(10)
  })

  it('rejects metadata from a previous physical source and never guesses local after identity failure', async () => {
    const unified = useUnifiedCost(ref(null), ref(1))
    await unified.loadUnified('1h', bounds, { ...fixture(), sourceInstanceId: B } as any)
    expect(unified.cockpitCost.value).toBeNull()
    mocks.identity.mockRejectedValue(new Error('identity unavailable'))
    await unified.loadUnified('1h', bounds)
    expect(unified.sourceStatuses.value.cockpit.instanceId).toBe('cockpit:unavailable:request_logs')
    expect(unified.cockpitCost.value).toBeNull()
  })

  it('does not reuse channel quota snapshots or issue a live refresh after the data root changes', async () => {
    vi.mocked(getQuotaChannels).mockResolvedValue([{ channel: 'codex', hasAccounts: true }] as any)
    vi.mocked(getQuotaSnapshots).mockResolvedValue([{ channel: 'codex', accountId: RAW, percent: 0, updatedAtMs: NOW }] as any)
    const quota = useChannelQuota()
    await quota.load()
    expect((quota as any).sourceInstanceId?.value).toBe(A)
    expect(quota.allSnapshots.value[0].percent).toBe(0)
    mocks.identity.mockResolvedValue({ sourceInstanceId: B })
    await quota.refresh('codex')
    expect(quota.allSnapshots.value).toEqual([])
    expect(refreshQuotaSnapshots).not.toHaveBeenCalled()
    expect(quota.loaded.value).toBe(false)
    expect(quota.liveError.value).toBeTruthy()
  })

  it('rejects a quota batch whose identity changes between channel and snapshot reads', async () => {
    vi.mocked(getQuotaChannels).mockResolvedValue([{ channel: 'codex', hasAccounts: true }] as any)
    vi.mocked(getQuotaSnapshots).mockResolvedValue([{ channel: 'codex', accountId: RAW, percent: 80 }] as any)
    mocks.identity.mockResolvedValueOnce({ sourceInstanceId: A }).mockResolvedValueOnce({ sourceInstanceId: B })
    const quota = useChannelQuota()
    await quota.load()
    expect(quota.allSnapshots.value).toEqual([])
    expect(quota.error.value).toBeTruthy()
  })

  it('passes source identity through the primary view and checks it before persisted ledger writes', () => {
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    expect(view.includes('data.cockpitSourceInstanceId.value')).toBe(true)
    const start = view.indexOf('cockpitMetadata = await loadCockpitOverview()')
    const end = view.indexOf('ledgerIngestOnce(', start)
    const block = view.slice(start, end)
    expect(block).toContain('assertCockpitSourceIdentity(sourceInstanceId)')
    expect(block.indexOf('assertCockpitSourceIdentity(sourceInstanceId)')).toBeLessThan(block.indexOf('writeCostLedger('))
    expect(block).toContain('writeCostLedger(mergedLedger, sourceInstanceId)')
  })
})
