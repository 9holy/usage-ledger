import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from '@/api/url'
import { getFinanceBatch, getFinanceLedger, getFinanceRelatedEvents, saveFinanceBatch, saveFinanceEvent, voidFinanceBatch, voidFinanceEvent } from '../financeLedger'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: vi.fn(() => true) }))
const scope = { source: 'cockpit' as const, instanceId: 'local' }
const uuid = '00000000-0000-4000-8000-000000000001'

describe('local finance ledger API', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(isDesktopRuntime).mockReturnValue(true); vi.mocked(invoke).mockResolvedValue({}) })

  it('preserves explicit query scope and time boundaries', async () => {
    const query = { ...scope, accountId: 'account', startMs: 1, endMs: 10 }
    await getFinanceLedger(query)
    expect(invoke).toHaveBeenCalledWith('finance_ledger_query', { query })
  })

  it('generates a UUID only for a new event and preserves edit identity', async () => {
    const random = vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    const draft = { ...scope, accountId: 'account', kind: 'purchase' as const, amount: 12.5, currency: 'CNY' as const, occurredAtMs: 1 }
    await saveFinanceEvent(draft)
    await saveFinanceEvent({ ...draft, id: uuid, amount: 15 })
    expect(random).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenNthCalledWith(1, 'finance_ledger_save', { event: { ...draft, id: uuid } })
    expect(invoke).toHaveBeenNthCalledWith(2, 'finance_ledger_save', { event: { ...draft, id: uuid, amount: 15 } })
    random.mockRestore()
  })

  it('soft-voids within the captured instance scope and does not call a delete endpoint', async () => {
    await voidFinanceEvent(scope, uuid)
    expect(invoke).toHaveBeenCalledWith('finance_ledger_void', { scope, id: uuid })
  })

  it('keeps batch allocations, scope and linked candidate queries explicit', async () => {
    const batch = { scope, batchId: uuid, totalAmount: 30, currency: 'CNY' as const, occurredAtMs: 1, purchaseChannel: 'seller', allocations: [{ ...scope, id: uuid, accountId: 'a', kind: 'purchase' as const, amount: 30, currency: 'CNY' as const, occurredAtMs: 1, planLabel: 'plan' }] }
    await saveFinanceBatch(batch)
    await getFinanceBatch(scope, uuid)
    await voidFinanceBatch(scope, uuid)
    await getFinanceRelatedEvents(scope, 'a', 'CNY')
    expect(invoke).toHaveBeenNthCalledWith(1, 'finance_ledger_save_batch', { batch })
    expect(invoke).toHaveBeenNthCalledWith(2, 'finance_ledger_get_batch', { scope, batchId: uuid })
    expect(invoke).toHaveBeenNthCalledWith(3, 'finance_ledger_void_batch', { scope, batchId: uuid })
    expect(invoke).toHaveBeenNthCalledWith(4, 'finance_ledger_related_events', { scope, accountId: 'a', currency: 'CNY' })
  })

  it('reports unavailable desktop storage and command errors without fabricated empty facts', async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false)
    await expect(getFinanceLedger({ ...scope, startMs: 1, endMs: 10 })).rejects.toThrow('需要桌面端')
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(isDesktopRuntime).mockReturnValue(true)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('database unavailable'))
    await expect(getFinanceLedger({ ...scope, startMs: 1, endMs: 10 })).rejects.toThrow('database unavailable')
  })
})
