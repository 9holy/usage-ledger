import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ cliproxyClient: { get } }))
import { getAuthFiles, getApiKeyUsage, getConfigSnapshot, getDebug, getRoutingStrategy } from '../management'

beforeEach(() => vi.clearAllMocks())

describe('CLIProxyAPI management response contracts', () => {
  it.each([{}, null, { files: null }, { files: 'not-an-array' }])('does not report an invalid auth-files response as an empty pool: %j', async data => {
    get.mockResolvedValue({ data })
    await expect(getAuthFiles()).rejects.toThrow('auth-files')
  })

  it('accepts a real empty list, and keeps the legitimate disk-metadata fallback intact', async () => {
    get.mockResolvedValueOnce({ data: { files: [], observed_at: '2026-11-07T12:00:00Z' } })
    expect(await getAuthFiles()).toEqual([])
    const files = [{ name: 'file.json', type: 'codex', email: 'fixture@example.test', size: 123 }]
    get.mockResolvedValueOnce({ data: { files } })
    expect(await getAuthFiles()).toEqual(files)
    expect(get).toHaveBeenCalledWith('/auth-files')
    expect(get.mock.calls.every(([path]) => path !== '/usage-queue')).toBe(true)
  })

  it('retains existing string-labeled success/failure bucket compatibility, with no fabricated numeric request series', async () => {
    const data = { codex: { 'fixture-route|fixture-key': { success: 2, failed: 1,
      recent_requests: [{ time: '2026-11-07T12:00:00Z', success: 2, failed: 1 }] } } }
    get.mockResolvedValue({ data })
    expect(await getApiKeyUsage()).toEqual(data)
  })

  it('accepts upstream local clock-range labels including midnight without treating them as dated timestamps', async () => {
    // sdk/cliproxy/auth/types.go::formatRecentRequestBucketLabel formats 15:04-15:04.
    const data = { codex: { 'fixture-route|fixture-key': { success: 0, failed: 0,
      recent_requests: [{ time: '23:50-00:00', success: 0, failed: 0 }, { time: '00:00-00:10', success: 0, failed: 0 }] } } }
    get.mockResolvedValue({ data })
    expect(await getApiKeyUsage()).toEqual(data)
  })

  it('uses only the response version header, including case-insensitive names, and leaves omitted versions unknown', async () => {
    get.mockResolvedValueOnce({ data: { version: 'not-a-config-version', debug: false }, headers: { 'X-CPA-VERSION': '  v8.fixture  ' } })
    expect(await getConfigSnapshot()).toEqual({ config: { version: 'not-a-config-version', debug: false }, reportedVersion: 'v8.fixture' })
    get.mockResolvedValueOnce({ data: { version: 'not-a-config-version' }, headers: {} })
    expect((await getConfigSnapshot()).reportedVersion).toBeNull()
    get.mockResolvedValueOnce({ data: {}, headers: {} })
    expect((await getConfigSnapshot()).config).toEqual({})
  })

  it.each([null, [], 'config'])('rejects invalid config payloads instead of describing settings as loaded: %j', async data => {
    get.mockResolvedValueOnce({ data })
    await expect(getConfigSnapshot()).rejects.toThrow('config')
  })

  it('keeps explicit debug false and producer-normalized or future routing values, but rejects omitted scalar facts', async () => {
    get.mockResolvedValueOnce({ data: { debug: false } })
    expect(await getDebug()).toBe(false)
    for (const strategy of ['weighted-round-robin', 'future-strategy']) {
      get.mockResolvedValueOnce({ data: { strategy } })
      expect(await getRoutingStrategy()).toBe(strategy)
    }
    get.mockResolvedValueOnce({ data: {} })
    await expect(getDebug()).rejects.toThrow('debug')
    get.mockResolvedValueOnce({ data: { strategy: '' } })
    await expect(getRoutingStrategy()).rejects.toThrow('routing')
  })

  it.each([{ codex: { slot: { success: -1, failed: 0 } } }, { codex: { slot: { success: '1', failed: 0 } } }, { codex: { slot: { success: 0, failed: 0, recent_requests: [1, 0] } } }])('does not convert invalid key usage counters or non-bucket samples into data: %j', async data => {
    get.mockResolvedValueOnce({ data })
    await expect(getApiKeyUsage()).rejects.toThrow('api-key-usage')
  })
})
