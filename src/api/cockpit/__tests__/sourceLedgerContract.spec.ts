import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', async original => ({ ...await original<typeof import('@/api/url')>(), isDesktopRuntime: () => true }))
import { invoke } from '@tauri-apps/api/core'
import { readCostLedger } from '../index'
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
})
