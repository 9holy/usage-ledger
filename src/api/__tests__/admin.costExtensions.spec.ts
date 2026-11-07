import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: http }))
import { listCostLossStates } from '@/api/admin/accounts'
import { getPricingStatus, refreshPricing } from '@/api/admin/channels'

const profile = { amount: 0, currency: 'USD', billing_cycle: 'monthly', started_at: '2026-11-01T00:00:00Z', source: 'custom', algorithm_version: 'fixture' }
const state = { account_id: 7, account_name: 'Fixture', platform: 'openai', account_type: 'oauth', terminal_event_id: 11,
  occurred_at: '2026-11-06T00:00:00Z', currency: 'USD', accrued_cost: 0, gross_loss: 0, refund_amount: 0,
  reversal_amount: 0, net_loss: 0, recognized_cost: 0, cost_profile: profile, active: false, account_deleted: true }
const pricing = { model_count: 0, last_updated: '', local_hash: '', catalog_source: '', configured_source: '', fallback_available: false, update_interval_hours: 24 }

beforeEach(() => { http.get.mockReset(); http.post.mockReset() })

describe('optional cost extension response boundaries', () => {
  it.each([{}, null, { states: null }, { states: {} }, { states: [null] }, { states: [{}] }])('does not turn absent or malformed loss states into an empty ledger: %j', async data => {
    http.get.mockResolvedValueOnce({ data })
    await expect(listCostLossStates()).rejects.toThrow('cost-loss')
  })

  it.each([{ account_id: '7' }, { occurred_at: 'not-a-date' }, { active: 'false' }, { account_deleted: null },
    { net_loss: null }, { accrued_cost: -1 }, { currency: 'EUR' }, { cost_profile: { ...profile, amount: '' } },
    { cost_profile: { ...profile, billing_cycle: 'not-a-cycle' } }])('rejects loss data that the account or finance consumer cannot interpret: %j', async invalid => {
    http.get.mockResolvedValueOnce({ data: { states: [{ ...state, ...invalid }] } })
    await expect(listCostLossStates()).rejects.toThrow('cost-loss')
  })

  it('preserves a valid empty list, explicit zero amounts, inactive state and a deleted-account snapshot', async () => {
    http.get.mockResolvedValueOnce({ data: { states: [] } })
    expect(await listCostLossStates()).toEqual({ states: [] })
    http.get.mockResolvedValueOnce({ data: { algorithm_version: 'fixture', states: [state] } })
    expect((await listCostLossStates()).states).toEqual([state])
  })

  it.each([{}, null, { ...pricing, model_count: '0' }, { ...pricing, model_count: -1 }, { ...pricing, fallback_available: null },
    { ...pricing, configured_source: [] }, { ...pricing, update_interval_hours: 0 }])('rejects invalid pricing status on both load and explicit refresh: %j', async data => {
    http.get.mockResolvedValueOnce({ data }); http.post.mockResolvedValueOnce({ data })
    await expect(getPricingStatus()).rejects.toThrow('pricing status')
    await expect(refreshPricing()).rejects.toThrow('pricing status')
  })

  it('preserves a reported zero-model catalogue with no configured source or offline fallback', async () => {
    http.get.mockResolvedValueOnce({ data: pricing }); http.post.mockResolvedValueOnce({ data: pricing })
    expect(await getPricingStatus()).toEqual(pricing)
    expect(await refreshPricing()).toEqual(pricing)
  })
})
