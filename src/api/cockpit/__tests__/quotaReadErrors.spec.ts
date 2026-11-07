import '@/api/__tests__/costCenterLocaleFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { getCockpitQuotaHistories } from '@/api/cockpit'
import {
  getQuotaChannels, getQuotaHistory, getQuotaSnapshots, refreshQuotaSnapshots,
  type QuotaChannelSummary, type QuotaSnapshot,
} from '@/api/cockpit/quota'
import { useChannelQuota } from '@/features/cost-center/useChannelQuota'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback }))

const OBSERVED = Date.UTC(2026, 10, 7, 10)
const READ = OBSERVED + 500
const SOURCE_ERROR = 'Trae query_identity version is not supported'
const channel: QuotaChannelSummary = {
  channel: 'trae', accountCount: 1, dir: 'trae_accounts', hasAccounts: true,
  usesDesktopCache: false, percentKind: 'used',
}
const saved: QuotaSnapshot = {
  channel: 'trae', accountId: 'member-a', email: 'member@example.invalid',
  modelId: 'credits:entitlement-a', displayName: 'Credits', scope: 'pool',
  percent: 0, remainingFraction: 0, usedFraction: 1, percentKind: 'used',
  unavailableReason: null, windowKind: 'unknown', windowStartedAtMs: null, resetAtMs: null,
  source: 'snapshot', fetchedAtMs: READ, updatedAtMs: OBSERVED, stale: false,
  rawKind: 'trae_usage_raw', sourceError: null, plan: null,
}
let failedCommand: string | null
let identity: string
let historyFiles: unknown[]

beforeEach(() => {
  failedCommand = null
  identity = 'cockpit:source-a'
  historyFiles = []
  vi.mocked(invoke).mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === failedCommand) throw new Error(SOURCE_ERROR)
    switch (command) {
      case 'get_cockpit_source_identity': return { sourceInstanceId: identity }
      case 'quota_list_channels': return [channel]
      case 'quota_snapshots': return [{ ...saved }]
      case 'quota_refresh': return { snapshots: [{ ...saved }], liveError: null, source: 'snapshot', fetchedAtMs: READ }
      case 'quota_history': return []
      case 'read_cockpit_dir': return historyFiles
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
})
afterEach(() => vi.restoreAllMocks())

describe('Cockpit quota source errors use the real command wrappers', () => {
  it.each([
    ['quota_list_channels', () => getQuotaChannels()],
    ['quota_snapshots', () => getQuotaSnapshots('trae')],
    ['quota_refresh', () => refreshQuotaSnapshots('trae')],
    ['quota_history', () => getQuotaHistory()],
  ] as const)('%s does not convert a rejected native read into an empty success', async (command, read) => {
    failedCommand = command
    await expect(read()).rejects.toThrow(SOURCE_ERROR)
  })

  it.each(['quota_list_channels', 'quota_snapshots'])('retains a same-source batch as stale after %s fails', async command => {
    const quota = useChannelQuota()
    await quota.load()
    expect(quota.error.value).toBeNull()
    expect(quota.allSnapshots.value).toEqual([saved])
    failedCommand = command
    await quota.load()
    expect(quota.error.value).toBe(SOURCE_ERROR)
    expect(quota.sourceInstanceId.value).toBe('cockpit:source-a')
    expect(quota.loaded.value).toBe(true)
    expect(quota.activeChannels.value).toEqual([channel])
    expect(quota.allSnapshots.value).toEqual([{ ...saved, stale: true, sourceError: SOURCE_ERROR }])
    expect(quota.staleCount.value).toBe(1)
  })

  it('retains the same-source quota and original observation/read times after refresh fails', async () => {
    const quota = useChannelQuota()
    await quota.load()
    failedCommand = 'quota_refresh'
    await quota.refresh('trae')
    expect(quota.liveError.value).toBe(SOURCE_ERROR)
    expect(quota.allSnapshots.value).toEqual([{ ...saved, stale: true, sourceError: SOURCE_ERROR }])
    expect(quota.refreshingChannel.value).toBeNull()
  })

  it('still clears a previous source when the new source cannot be read', async () => {
    const quota = useChannelQuota()
    await quota.load()
    identity = 'cockpit:source-b'
    failedCommand = 'quota_list_channels'
    await quota.load()
    expect(quota.error.value).toBe(SOURCE_ERROR)
    expect(quota.allSnapshots.value).toEqual([])
    expect(quota.sourceInstanceId.value).toBe('unavailable')
    expect(quota.loaded.value).toBe(false)
  })
})

describe('legacy quota history reports failed reads to its view-level catch', () => {
  it('does not convert a failed history directory read into an empty success', async () => {
    failedCommand = 'read_cockpit_dir'
    await expect(getCockpitQuotaHistories()).rejects.toThrow(SOURCE_ERROR)
  })

  it('does not silently omit a malformed history file', async () => {
    historyFiles = [{ name: 'a'.repeat(64) + '.json', content: '{broken' }]
    await expect(getCockpitQuotaHistories()).rejects.toThrow()
  })

  it('does not silently omit a history file whose required fields have the wrong types', async () => {
    historyFiles = [{ name: 'a'.repeat(64) + '.json', content: JSON.stringify({ email: 42, models: [] }) }]
    await expect(getCockpitQuotaHistories()).rejects.toThrow()
  })

  it('preserves an actually empty directory and a valid legacy record without adding observation times', async () => {
    await expect(getCockpitQuotaHistories()).resolves.toEqual([])
    const history = { email: 'member@example.invalid', models: { 'gemini-pro': { points: [{ timestamp: OBSERVED, remainingPercentage: 0 }] } } }
    historyFiles = [{ name: 'a'.repeat(64) + '.json', content: JSON.stringify(history) }]
    await expect(getCockpitQuotaHistories()).resolves.toEqual([history])
  })
})
