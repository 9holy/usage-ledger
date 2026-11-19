import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', async original => ({ ...await original<typeof import('@/api/url')>(), isDesktopRuntime: () => true }))
import { invoke } from '@tauri-apps/api/core'
import { readCostLedger, writeCostLedger, type CockpitLedgerEntry } from '../index'
beforeEach(() => vi.clearAllMocks())
describe('Cockpit saved usage ledger read contract', () => {
  it('keeps an absent ledger distinct from an unreadable ledger', async () => {
    vi.mocked(invoke).mockResolvedValue('null')
    expect(await readCostLedger()).toBeNull()
    vi.mocked(invoke).mockRejectedValue(new Error('permission denied'))
    await expect(readCostLedger()).rejects.toThrow('permission denied')
  })
  it.each(['', '{}', '{bad-json', '{"accounts":{}}', '{"accounts":[{}]}', '{"accounts":[{"email":"a@b.test","updatedAt":1,"usage":null}]}'])('does not turn invalid saved JSON into an initial empty ledger: %s', async raw => {
    vi.mocked(invoke).mockResolvedValue(raw)
    await expect(readCostLedger()).rejects.toThrow()
  })
  it('preserves a valid known-empty ledger', async () => {
    vi.mocked(invoke).mockResolvedValue('{"accounts":[]}')
    expect(await readCostLedger()).toEqual({ accounts: [] })
  })
  it('round-trips histories for distinct account IDs and their unassigned legacy record', async () => {
    const legacy = { email: 'same@example.invalid', updatedAt: 1, usage: { requestCount: 9 } }
    const accounts = [legacy, { ...legacy, accountId: 'source-a' }, { ...legacy, accountId: 'source-b' },
      { accountId: 'source-c', updatedAt: 1, usage: legacy.usage }] as CockpitLedgerEntry[]
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ accounts }))
    expect(await readCostLedger()).toEqual({ accounts })
    await writeCostLedger(accounts, 'cockpit:test')
    expect(invoke).toHaveBeenLastCalledWith('write_cost_ledger', { json: JSON.stringify({ accounts }, null, 2), expectedSourceInstanceId: 'cockpit:test' })
  })
  it('rejects ambiguous duplicate email histories instead of silently keeping the last one', async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ accounts: [
      { email: 'same@example.invalid', updatedAt: 1, usage: { requestCount: 2 } },
      { email: 'same@example.invalid', updatedAt: 2, usage: { requestCount: 7 } },
    ] }))
    await expect(readCostLedger()).rejects.toThrow()
  })
  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])('rejects a persisted non-integer or imprecise request count: %s', async count => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({ accounts: [{ email: 'a@example.invalid', updatedAt: 1, usage: { requestCount: count } }] }))
    await expect(readCostLedger()).rejects.toThrow()
  })
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects an invalid live value before serialization and leaves the saved file untouched: %s', async value => {
    const entries = [{ email: 'a@example.invalid', updatedAt: 1, usage: { requestCount: 1, estimatedCostUsd: value } }] as CockpitLedgerEntry[]
    await expect(writeCostLedger(entries, 'cockpit:test')).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('writes genuine zero and fractional monetary estimates without inventing missing counters', async () => {
    const entries = [{ email: 'a@example.invalid', updatedAt: 1, usage: { requestCount: 0, estimatedCostUsd: 0.00001 } }] as CockpitLedgerEntry[]
    await writeCostLedger(entries, 'cockpit:test')
    expect(invoke).toHaveBeenCalledWith('write_cost_ledger', { json: JSON.stringify({ accounts: entries }, null, 2), expectedSourceInstanceId: 'cockpit:test' })
  })
})
