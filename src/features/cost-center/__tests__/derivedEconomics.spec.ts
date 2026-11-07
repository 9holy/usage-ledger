import './costDataI18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLocalEconomicsSnapshot, isLocalEconomicsSnapshot, poolUsageForecast } from '../costEngine'
import { isLocalCliproxyTarget } from '../cliproxyAdapter'
import { sourceState } from '../dataState'
import type { Account } from '@/types'
import type { AccountWindowUsage, CostAccount } from '../model'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'

const { getEconomicsSnapshot } = vi.hoisted(() => ({ getEconomicsSnapshot: vi.fn() }))
vi.mock('@/api/admin', () => ({ adminAPI: { accounts: { getEconomicsSnapshot }, dashboard: {}, ops: {} } }))
import { useCostCenterData } from '../useCostCenterData'

const now = new Date(2026, 9, 16, 12)
const start = new Date(2026, 9, 16)
const profile = { amount: 730, currency: 'CNY', billing_cycle: 'monthly', started_at: new Date(2026, 9, 1).toISOString(), algorithm_version: '1.6.0' }
const account = { id: 1, name: 'local fixture', platform: 'openai', type: 'oauth', status: 'active', schedulable: true, created_at: profile.started_at, extra: { cost_profile: profile } } as Account
const usage = { requests: 4, tokens: 1000, cost: 6, user_cost: 24 } as AccountWindowUsage

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  getEconomicsSnapshot.mockReset()
})

function loadedData() {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const data = useCostCenterData()
  data.accounts.value = [account]
  data.todayStats.value = { '1': usage }
  data.exchangeRate.value = { rate: 7, rateDate: null, fetchedAt: null, source: 'fallback' }
  data.sourceStates.value.accounts = sourceState('accounts', 'measured')
  data.sourceStates.value.todayStats = sourceState('todayStats', 'measured')
  data.sourceStates.value.costLoss = sourceState('costLoss', 'empty')
  return data
}

describe('local economics from loaded facts', () => {
  it('derives economics when the optional remote extension is absent, without treating billing as account cost', async () => {
    const data = loadedData()
    getEconomicsSnapshot.mockRejectedValue(new Error('404 optional economics extension'))
    const result = await data.loadAccountEconomics('all', 'today')
    expect(result).not.toBeNull()
    expect(isLocalEconomicsSnapshot(result!)).toBe(true)
    expect(result!.actual.billed_usd).toBe(24)
    expect(result!.actual.account_cost_usd).toBe(6)
    expect(result!.actual.window_procurement_cny).toBeCloseTo(12)
    expect(result!.actual.procurement_accrued_cny).toBeCloseTo(372)
    expect(result!.projection.billed_usd_per_hour).toBe(2)
    expect(result!.projection.account_cost_usd_per_hour).toBe(0.5)
    // OAuth procurement covers its token usage; account-cost API value is not a second purchase.
    expect(result!.actual.contribution_margin_cny).toBeCloseTo(156)
    expect(result!.projection.confidence).toBe('low')
    expect(result!.projection.valid_intervals).toBe(0)
    expect(data.sourceStates.value.economics.status).toBe('estimated')
  })

  it('keeps a successful remote snapshot and retains it on a failed background refresh', async () => {
    const data = loadedData()
    const remote = buildLocalEconomicsSnapshot({ accounts: [{ account, health: { successCount: 1, failureCount: 0 } }], billedUsdTotal: 100, cnyPerUsd: 7, now: now.getTime() })!
    const { local_derived: _local, ...snapshot } = remote
    getEconomicsSnapshot.mockResolvedValueOnce(snapshot)
    expect(await data.loadAccountEconomics('all', 'today')).toBe(snapshot)
    getEconomicsSnapshot.mockRejectedValueOnce(new Error('temporary failure'))
    await data.loadAccountEconomics('all', 'today', [], { background: true })
    expect(data.accountEconomics.value).toEqual(snapshot)
    expect(data.sourceStates.value.economics.status).toBe('stale')
  })

  it('retains procurement with unavailable usage, but leaves revenue and usage rates unknown', async () => {
    const data = loadedData()
    data.sourceStates.value.todayStats = sourceState('todayStats', 'unavailable')
    getEconomicsSnapshot.mockRejectedValue(new Error('404'))
    const result = await data.loadAccountEconomics('all', 'today')
    expect(result!.actual.window_procurement_cny).toBeCloseTo(12)
    expect(result!.actual.billed_usd).toBeNull()
    expect(result!.actual.account_cost_usd).toBeNull()
    expect(result!.projection.billed_usd_per_hour).toBeNull()
  })

  it('never treats source standard-price equivalent as actual user revenue', async () => {
    const data = loadedData()
    data.todayStats.value = { '1': { ...usage, user_cost: null, standard_cost: 99 } }
    getEconomicsSnapshot.mockRejectedValue(new Error('404'))
    const result = await data.loadAccountEconomics('all', 'today')
    expect(result!.actual.billed_usd).toBeNull()
    expect(result!.actual.account_cost_usd).toBe(6)
    expect(result!.actual.contribution_margin_cny).toBeNull()
  })

  it('retains Sub2API historical account facts after the current account inventory no longer contains the account', async () => {
    // Upstream accounts use SoftDeleteMixin; usage_logs keeps account_id and its
    // request-time cost snapshots. An absent account is not a zero-usage account.
    const data = loadedData()
    data.todayStats.value['9999'] = { requests: 3, tokens: 600, cost: 7, standard_cost: 30, user_cost: 70 }
    getEconomicsSnapshot.mockRejectedValue(new Error('404 optional economics extension'))
    const result = await data.loadAccountEconomics('all', 'today')
    expect(result!.actual.billed_usd).toBe(94)
    expect(result!.actual.account_cost_usd).toBe(13)
    expect(data.todayStats.value['9999']).toMatchObject({ requests: 3, tokens: 600, cost: 7, user_cost: 70 })
    expect(result!.health.account_count).toBe(1)
    expect(result!.data_quality.status).toBe('partial')
    expect(result!.actual.window_procurement_cny).toBeNull()
    expect(result!.actual.window_economic_cost_cny).toBeNull()
    expect(result!.actual.contribution_margin_cny).toBeNull()
    expect(result!.actual.payback_ratio).toBeNull()
    expect(result!.projection.billed_usd_per_hour).toBeCloseTo(94 / 12)
    expect(result!.projection.account_cost_usd_per_hour).toBeCloseTo(13 / 12)
    expect(result!.projection.confidence).toBe('unavailable')
    expect(result!.projection.capacity_adjusted_billed_usd_per_hour).toBeNull()
    expect(result!.projection.capacity_adjusted_account_cost_usd_per_hour).toBeNull()
    expect(result!.projection.warning).toContain('账号档案')
  })

  it('can explicitly select a usage-only account ID without inventing its identity or procurement profile', async () => {
    const data = loadedData()
    data.todayStats.value['9999'] = { requests: 3, tokens: 600, cost: 7, standard_cost: 30, user_cost: 70 }
    getEconomicsSnapshot.mockRejectedValue(new Error('404'))
    const result = await data.loadAccountEconomics('all', 'today', [9999])
    expect(result!.actual.billed_usd).toBe(70)
    expect(result!.actual.account_cost_usd).toBe(7)
    expect(result!.health.account_count).toBe(0)
    expect(result!.data_quality.status).toBe('partial')
    expect(result!.actual.window_procurement_cny).toBeNull()
    expect(result!.actual.contribution_margin_cny).toBeNull()
  })

  it('does not assign an orphan or unattributed request to an arbitrary platform, while preserving it in the all-platform reading', async () => {
    const data = loadedData()
    data.todayStats.value['9999'] = { requests: 3, tokens: 600, cost: 7, standard_cost: 30, user_cost: 70 }
    data.todayStats.value[UNATTRIBUTED_USAGE_ACCOUNT_ID] = { requests: 2, tokens: 80, cost: 2, standard_cost: 8, user_cost: 10 }
    getEconomicsSnapshot.mockRejectedValue(new Error('404'))
    const all = await data.loadAccountEconomics('all', 'today')
    expect(all!.actual.billed_usd).toBe(104)
    expect(all!.actual.account_cost_usd).toBe(15)
    const filtered = await data.loadAccountEconomics('openai', 'today')
    expect(filtered!.actual.billed_usd).toBe(24)
    expect(filtered!.actual.account_cost_usd).toBe(6)
    expect(filtered!.data_quality.status).toBe('partial')
    expect(filtered!.actual.contribution_margin_cny).toBeNull()
    expect(filtered!.projection.warning).toContain('平台')
  })

  it('keeps incomplete Sub2API windows partial instead of projecting a bounded subtotal as a complete window', async () => {
    const data = loadedData()
    data.sourceStates.value.todayStats = sourceState('todayStats', 'partial')
    getEconomicsSnapshot.mockRejectedValue(new Error('404'))
    const result = await data.loadAccountEconomics('all', 'today')
    expect(result!.actual.billed_usd).toBe(24)
    expect(result!.actual.account_cost_usd).toBe(6)
    expect(result!.data_quality.status).toBe('partial')
    expect(result!.projection.confidence).toBe('unavailable')
    expect(result!.projection.billed_usd_per_hour).toBeNull()
    expect(result!.projection.account_cost_usd_per_hour).toBeNull()
    expect(result!.actual.contribution_margin_cny).toBeNull()
    expect(result!.actual.projected_contribution_cny_per_hour).toBeNull()
  })

  it('preserves an exact zero-usage window and a configured zero procurement amount', async () => {
    const data = loadedData()
    data.accounts.value = [{ ...account, extra: { cost_profile: { ...profile, amount: 0 } } }]
    data.todayStats.value = { '1': { requests: 0, tokens: 0, cost: 0, standard_cost: 0, user_cost: 0 } }
    data.sourceStates.value.todayStats = sourceState('todayStats', 'empty')
    getEconomicsSnapshot.mockRejectedValue(new Error('404'))
    const result = await data.loadAccountEconomics('all', 'today')
    expect(result!.actual.billed_usd).toBe(0)
    expect(result!.actual.account_cost_usd).toBe(0)
    expect(result!.actual.window_procurement_cny).toBe(0)
    expect(result!.actual.window_economic_cost_cny).toBe(0)
    expect(result!.actual.contribution_margin_cny).toBe(0)
    expect(result!.data_quality.status).toBe('estimated')
  })

  it('converts CNY exactly once, recognizes loaded loss and stops procurement at the loss time', () => {
    const result = buildLocalEconomicsSnapshot({
      accounts: [{ account: account as CostAccount, health: { successCount: 0, failureCount: 1 }, loss: {
        currency: 'CNY', occurred_at: new Date(2026, 9, 16, 6).toISOString(), accrued_cost: 366,
        net_loss: 20, recognized_cost: 386, active: true,
      } }],
      billedUsdTotal: 24, accountCostUsdTotal: 6, outputBasis: 'revenue', cnyPerUsd: 7,
      now: now.getTime(), window: { start, end: now },
    })!
    expect(result.actual.procurement_accrued_cny).toBeCloseTo(366)
    expect(result.actual.impairment_loss_cny).toBeCloseTo(20)
    expect(result.actual.window_procurement_cny).toBeCloseTo(6)
    expect(result.actual.window_economic_cost_cny).toBeCloseTo(26)
  })
})

describe('pool facts and source attribution', () => {
  it('derives grouped production forecasts from actual daily rows, preserving zero and missing values', () => {
    const result = poolUsageForecast([{ today: usage }, { today: null }], true, now)
    expect(result).toMatchObject({ outputUsd: 24, apiCostUsd: 6, productive: 1, requests: 4, tokens: 1000, dayForecastUsd: 48, monthForecastUsd: 1488 })
    expect(poolUsageForecast([{ today: { ...usage, user_cost: 0, cost: 0 } }], true, now).dayForecastUsd).toBe(0)
    expect(poolUsageForecast([{ today: { ...usage, user_cost: null, standard_cost: null } }], true, now).dayForecastUsd).toBeNull()
    expect(poolUsageForecast([{ today: { ...usage, user_cost: null, standard_cost: 24 } }], true, now).outputUsd).toBeNull()
    expect(poolUsageForecast([{ today: usage }], false, now).apiCostUsd).toBeNull()
  })

  it('only associates the fixed local plugin with the default loopback gateway, never a remote host or another local instance', () => {
    expect(isLocalCliproxyTarget('http://127.0.0.1:8317/v0/management')).toBe(true)
    expect(isLocalCliproxyTarget('http://localhost:8317')).toBe(true)
    expect(isLocalCliproxyTarget('http://localhost:9999')).toBe(false)
    expect(isLocalCliproxyTarget('https://remote.example/v0/management')).toBe(false)
    expect(isLocalCliproxyTarget('http://localhost.example:8317')).toBe(false)
  })
})
