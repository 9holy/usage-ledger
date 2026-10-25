import './costDataI18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@/stores/connection'
import type { AdminUsageLog } from '@/types'
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }))
vi.mock('axios', () => ({ default: { create: mocks.create, isAxiosError: (value: { response?: unknown }) => !!value?.response } }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true, PROXY_PORT: 18765 }))
import { readSub2apiWindow } from '../unifiedSourceReader'

const window = { start: new Date('2026-10-16T11:00:00Z'), end: new Date('2026-10-16T12:00:00Z') }
const connection: ConnectionConfig = { id: 'own-instance', type: 'sub2api', name: 'fixture', baseUrl: 'https://instance.example.test', apiKey: 'own-fixture-key', authMode: 'apikey', lastUsed: 1 }
const log = (id: number, overrides: Partial<AdminUsageLog> = {}): AdminUsageLog => ({ id, model: 'fixture', created_at: '2026-10-16T11:30:00Z', total_cost: 4, account_stats_cost: 2, account_rate_multiplier: 0.5, actual_cost: 999, input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0, ...overrides } as AdminUsageLog)
beforeEach(() => { vi.clearAllMocks(); mocks.create.mockReturnValue({ get: mocks.get }); mocks.get.mockResolvedValue({ data: { data: { items: [] } } }) })

describe('source-bound Sub2API window reader', () => {
  it('captures its own target and API key without global auth, and never treats user billing as account cost', async () => {
    mocks.get.mockResolvedValue({ data: { data: { items: [log(1)] } } })
    const result = await readSub2apiWindow(connection, window)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'http://127.0.0.1:18765', headers: { 'X-API-Key': 'own-fixture-key', 'X-Target-Base': 'https://instance.example.test/api/v1', 'X-Admin-UI-Request': '1' } }))
    expect(result).toMatchObject({ instanceId: 'sub2api:own-instance', costUsd: 1, records: 1, tokens: 2, state: 'measured', coverageBasis: 'stored_records' })
  })

  it('uses only the saved connection JWT, rejects an expired own token without refreshing or logging into any instance', async () => {
    await readSub2apiWindow({ ...connection, authMode: 'login', apiKey: 'own-fixture-jwt', tokenExpiresAt: Date.now() + 60000 }, window)
    expect(mocks.create.mock.calls[0][0].headers.Authorization).toBe('Bearer own-fixture-jwt')
    expect(mocks.create.mock.calls[0][0].headers['X-API-Key']).toBeUndefined()
    mocks.create.mockClear()
    const expired = await readSub2apiWindow({ ...connection, authMode: 'login', tokenExpiresAt: 1 }, window)
    expect(expired.costUsd).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('uses [start,end), not date-wide totals, and advances pages despite has-more lower-bound totals', async () => {
    mocks.get.mockImplementation(async (_path, { params }) => ({ data: { items: params.page === 1 ? Array.from({ length: 1000 }, (_, index) => log(index)) : [log(1000), log(1001, { created_at: window.end.toISOString() })], total: params.page * 1000 + 1 } }))
    const result = await readSub2apiWindow(connection, window)
    expect(mocks.get.mock.calls.map(([, config]) => config.params.page)).toEqual([1, 2])
    expect(result.costUsd).toBe(1001)
    expect(result.records).toBe(1001)
  })

  it('keeps the 25-page bound, deduplicates repeated records and marks an incomplete sample', async () => {
    mocks.get.mockResolvedValue({ data: { items: Array.from({ length: 1000 }, (_, index) => log(index)) } })
    const result = await readSub2apiWindow(connection, window)
    expect(mocks.get).toHaveBeenCalledTimes(25)
    expect(result).toMatchObject({ records: 1000, costUsd: 1000, state: 'partial', coverageBasis: 'bounded_sample' })
  })

  it('preserves known partial amounts and never fills unknown costs or failed queries with zero', async () => {
    mocks.get.mockResolvedValueOnce({ data: { items: [log(1), log(2, { total_cost: null, account_stats_cost: null })] } })
    const partial = await readSub2apiWindow(connection, window)
    expect(partial).toMatchObject({ costUsd: 1, state: 'partial' })
    mocks.get.mockRejectedValueOnce({ response: { status: 401 } })
    expect(await readSub2apiWindow(connection, window)).toMatchObject({ costUsd: null, state: 'unavailable', reason: '本实例只读查询失败（HTTP 401）' })
    mocks.get.mockResolvedValueOnce({ data: { items: [] } })
    expect(await readSub2apiWindow(connection, window)).toMatchObject({ costUsd: 0, tokens: 0, records: 0, state: 'empty' })
  })

  it('retains the already-read subtotal when a later page fails', async () => {
    mocks.get.mockResolvedValueOnce({ data: { items: Array.from({ length: 1000 }, (_, index) => log(index)) } }).mockRejectedValueOnce({ response: { status: 503 } })
    expect(await readSub2apiWindow(connection, window)).toMatchObject({ costUsd: 1000, records: 1000, state: 'partial', coverageBasis: 'bounded_sample' })
  })
})
