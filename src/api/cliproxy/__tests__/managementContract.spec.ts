import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())
vi.mock('../client', () => ({ cliproxyClient: { get } }))
import { getAuthFiles, getApiKeyUsage } from '../management'

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

  it('retains timestamped success/failure buckets, with no fabricated numeric request series', async () => {
    const data = { codex: { 'fixture-route|fixture-key': { success: 2, failed: 1,
      recent_requests: [{ time: '2026-11-07T12:00:00Z', success: 2, failed: 1 }] } } }
    get.mockResolvedValue({ data })
    expect(await getApiKeyUsage()).toEqual(data)
  })
})
