import './costDataI18n'
import { describe, expect, it } from 'vitest'
import {
  accruedCost,
  actualUserCost,
  standardReferenceCost,
  summarizeAccountReferenceCost,
  summarizeAccountUserCost,
  convertCurrency,
  elapsedHours,
  economicCostSnapshot,
  formatMoney,
  hourlyRate,
  inferPlan,
  isStartedInLocalMonth,
  isDefaultSubscriptionCostProfile,
  isTimestampInWindow,
  procurementCostInWindow,
  resolveAccountBillingMode,
  resolveCostProfile,
  resolveFallbackCostProfile,
  COST_ALGORITHM_VERSION,
  DEFAULT_COST_MULTIPLIER,
  UNKNOWN_PLAN_FALLBACK_USD,
  LEGACY_COST_ALGORITHM_VERSION,
  type CostAccount,
  type CostProfile,
} from '../model'

const JOINED_AT = '2026-08-01T00:00:00.000Z'

function account(overrides: Partial<CostAccount> = {}): CostAccount {
  return {
    created_at: JOINED_AT,
    platform: 'openai',
    type: 'oauth',
    extra: {},
    credentials: {},
    parent_plan_type: undefined,
    ...overrides,
  }
}

function profile(overrides: Partial<CostProfile> = {}): CostProfile {
  return {
    amount: 140,
    currency: 'CNY',
    billing_cycle: 'monthly',
    started_at: JOINED_AT,
    source: 'default',
    algorithm_version: COST_ALGORITHM_VERSION,
    ...overrides,
  }
}

describe('cost center model', () => {
  it('recognizes one-time purchases started in the current local month', () => {
    const now = new Date(2026, 7, 12, 10, 0, 0)

    expect(isStartedInLocalMonth(new Date(2026, 7, 1, 0, 0, 0), now)).toBe(true)
    expect(isStartedInLocalMonth(new Date(2026, 6, 31, 23, 59, 59), now)).toBe(false)
    expect(isStartedInLocalMonth(new Date(2026, 7, 13, 0, 0, 0), now)).toBe(false)
  })

  it('excludes historical loss events from the selected observation window', () => {
    expect(isTimestampInWindow(
      '2026-08-10T12:00:00.000Z',
      '2026-08-12T06:00:00.000Z',
      '2026-08-12T12:00:00.000Z',
    )).toBe(false)
    expect(isTimestampInWindow(
      '2026-08-12T11:00:00.000Z',
      '2026-08-12T06:00:00.000Z',
      '2026-08-12T12:00:00.000Z',
    )).toBe(true)
  })

  it('counts only procurement incurred inside the selected observation window', () => {
    const start = '2026-08-12T06:00:00.000Z'
    const end = '2026-08-12T12:00:00.000Z'

    expect(procurementCostInWindow(profile({
      amount: 4,
      billing_cycle: 'one_time',
      started_at: '2026-08-10T12:00:00.000Z',
    }), start, end)).toBe(0)
    expect(procurementCostInWindow(profile({
      amount: 4,
      billing_cycle: 'one_time',
      started_at: '2026-08-12T08:00:00.000Z',
    }), start, end)).toBe(4)
    expect(procurementCostInWindow(profile({
      amount: 24,
      billing_cycle: 'daily',
      started_at: '2026-08-12T04:00:00.000Z',
    }), start, end, '2026-08-12T09:00:00.000Z')).toBe(3)
  })

  it('starts recurring cost at zero when the account joins', () => {
    const resolved = resolveCostProfile(account({ extra: { plan_type: 'plus' } }))
    expect(accruedCost(resolved, JOINED_AT)).toBe(0)
  })

  it('accrues a monthly price linearly over actual elapsed milliseconds', () => {
    const resolved = resolveCostProfile(account({ extra: { subscription_tier: 'plus' } }))
    const afterOneDay = '2026-08-02T00:00:00.000Z'

    expect(resolved.amount).toBe(20)
    expect(resolved.currency).toBe('USD')
    expect(elapsedHours(resolved.started_at, afterOneDay)).toBe(24)
    expect(hourlyRate(resolved)).toBeCloseTo(20 / 730)
    expect(accruedCost(resolved, afterOneDay)).toBeCloseTo((20 * 24) / 730)
  })

  it('stops accrual at a terminal loss and adds the remaining prepaid impairment', () => {
    const resolved = resolveCostProfile(account({ extra: { subscription_tier: 'plus' } }))
    const snapshot = economicCostSnapshot(resolved, {
      occurred_at: '2026-08-02T00:00:00.000Z',
      accrued_cost: (20 * 24) / 730,
      net_loss: 20 - (20 * 24) / 730,
      recognized_cost: 20,
      active: true,
    }, '2026-08-20T00:00:00.000Z')

    expect(snapshot.procurementCost).toBeCloseTo((20 * 24) / 730)
    expect(snapshot.impairmentLoss).toBeCloseTo(20 - (20 * 24) / 730)
    expect(snapshot.economicCost).toBeCloseTo(20)
    expect(snapshot.hourlyRate).toBe(0)
  })

  it('does not accrue recurring or one-time cost before the start', () => {
    const future = '2026-08-05T00:00:00.000Z'
    expect(accruedCost(profile({ started_at: future }), JOINED_AT)).toBe(0)
    expect(accruedCost(profile({ billing_cycle: 'one_time', started_at: future }), JOINED_AT)).toBe(0)
  })

  it('counts a one-time cost in full at and after its start', () => {
    const oneTime = profile({ amount: 50, billing_cycle: 'one_time', source: 'custom' })
    expect(hourlyRate(oneTime)).toBe(0)
    expect(accruedCost(oneTime, JOINED_AT)).toBe(50)
    expect(accruedCost(oneTime, '2026-08-02T00:00:00.000Z')).toBe(50)
  })

  it('clamps a custom start that predates account creation', () => {
    const resolved = resolveCostProfile(account({
      extra: {
        cost_profile: {
          amount: 12,
          currency: 'USD',
          billing_cycle: 'daily',
          started_at: '2026-07-01T00:00:00.000Z',
        },
      },
    }))

    expect(resolved.started_at).toBe(JOINED_AT)
    expect(accruedCost(resolved, JOINED_AT)).toBe(0)
  })

  it('uses a valid custom profile instead of inferred plan pricing', () => {
    const resolved = resolveCostProfile(account({
      extra: {
        plan_type: 'pro',
        cost_profile: {
          amount: 9,
          currency: 'USD',
          billing_cycle: 'weekly',
          started_at: JOINED_AT,
          source: 'default',
        },
      },
    }))

    expect(resolved).toMatchObject({
      amount: 9,
      currency: 'USD',
      billing_cycle: 'weekly',
      source: 'custom',
      algorithm_version: LEGACY_COST_ALGORITHM_VERSION,
    })
  })

  it('keeps a 2.5 CNY procurement profile in CNY instead of relabeling it as API USD', () => {
    const resolved = resolveCostProfile(account({
      extra: {
        cost_profile: {
          amount: 2.5,
          currency: 'CNY',
          billing_cycle: 'one_time',
          started_at: JOINED_AT,
        },
      },
    }))

    expect(resolved).toMatchObject({ amount: 2.5, currency: 'CNY', source: 'custom' })
    expect(formatMoney(resolved.amount, resolved.currency)).toBe('¥2.50')
  })

  it('persists an explicit algorithm version for auditable cost rules', () => {
    const resolved = resolveCostProfile(account({
      extra: {
        cost_profile: {
          amount: 140,
          currency: 'CNY',
          billing_cycle: 'monthly',
          started_at: JOINED_AT,
          algorithm_version: '1.0.0',
        },
      },
    }))
    expect(resolved.algorithm_version).toBe('1.0.0')
  })

  it('falls back through credential and parent plan fields', () => {
    expect(inferPlan(account({ credentials: { subscription_tier: 'ChatGPT Pro' } }))).toBe('pro')
    expect(inferPlan(account({ parent_plan_type: 'business' }))).toBe('business')
    expect(resolveCostProfile(account({ credentials: { plan_type: 'team' } }))).toMatchObject({ amount: 25, currency: 'USD' })
    expect(resolveCostProfile(account({ parent_plan_type: 'k-12' }))).toMatchObject({ amount: 0, currency: 'USD' })
  })

  it('uses current US official monthly list-price defaults while allowing custom overrides', () => {
    expect(resolveCostProfile(account({ extra: { plan_type: 'plus' } }))).toMatchObject({ amount: 20, currency: 'USD' })
    expect(resolveCostProfile(account({ extra: { plan_type: 'pro' } }))).toMatchObject({ amount: 100, currency: 'USD' })
    expect(resolveCostProfile(account({ extra: { plan_type: 'business' } }))).toMatchObject({ amount: 25, currency: 'USD' })
  })

  it.each([
    ['apikey', 'https://api.deepseek.com/v1'],
    ['apikey', 'https://api.anthropic.com'],
    ['service_account', 'https://generativelanguage.googleapis.com'],
    ['bedrock', ''],
    ['upstream', 'https://relay.example.com/v1'],
  ] as const)('treats %s upstream accounts as metered usage instead of monthly subscriptions', (type, baseUrl) => {
    const current = account({
      type,
      credentials: baseUrl ? { base_url: baseUrl } : {},
    })

    expect(resolveAccountBillingMode(current)).toBe('metered')
    expect(isDefaultSubscriptionCostProfile(current)).toBe(false)
    expect(resolveCostProfile(current)).toMatchObject({ amount: 0, source: 'default' })
  })

  it.each(['oauth', 'setup-token'] as const)('keeps %s accounts on fixed subscription procurement', (type) => {
    const current = account({ type, extra: { plan_type: 'plus' } })

    expect(resolveAccountBillingMode(current)).toBe('subscription')
    expect(isDefaultSubscriptionCostProfile(current)).toBe(true)
    expect(resolveCostProfile(current)).toMatchObject({ amount: 20, source: 'default' })
  })

  it('keeps an explicit fixed overhead on a metered relay without calling it a subscription default', () => {
    const current = account({
      type: 'upstream',
      extra: {
        cost_profile: {
          amount: 30,
          currency: 'USD',
          billing_cycle: 'monthly',
          started_at: JOINED_AT,
        },
      },
    })

    expect(resolveAccountBillingMode(current)).toBe('metered')
    expect(isDefaultSubscriptionCostProfile(current)).toBe(false)
    expect(resolveCostProfile(current)).toMatchObject({ amount: 30, source: 'custom' })
  })

  it('converts currencies using the fixed 6.8 CNY per USD rate', () => {
    expect(convertCurrency(10, 'USD', 'CNY')).toBe(68)
    expect(convertCurrency(68, 'CNY', 'USD')).toBe(10)
    expect(convertCurrency(10, 'USD', 'USD')).toBe(10)
    expect(formatMoney(68, 'CNY')).toBe('\u00a568.00')
  })

  it('preserves a real zero user charge instead of replacing it with standard cost', () => {
    expect(actualUserCost({ user_cost: 0, standard_cost: 12.5 })).toBe(0)
    expect(actualUserCost({ standard_cost: 12.5 })).toBeNull()
    expect(actualUserCost({ user_cost: null, standard_cost: 12.5 })).toBeNull()
  })

  it('keeps local reference value explicit and separate from unknown user charges', () => {
    const today = { requests: 1, tokens: 100, cost: 0.25, standard_cost: 1.25, user_cost: null }
    expect(standardReferenceCost(today)).toBe(1.25)
    expect(standardReferenceCost({ standard_cost: 0 })).toBe(0)
    expect(standardReferenceCost({ standard_cost: null })).toBeNull()
    expect(standardReferenceCost({ standard_cost: Number.NaN })).toBeNull()
    expect(summarizeAccountUserCost([{ today }])).toEqual({ total: null, knownSubtotal: 0, unknownCount: 1 })
    expect(summarizeAccountReferenceCost([{ today }])).toEqual({ total: 1.25, knownSubtotal: 1.25, unknownCount: 0 })
    const partial = { ...today, standard_cost: null, known_standard_cost: 0.75 }
    expect(summarizeAccountUserCost([{ today: partial }])).toEqual({ total: null, knownSubtotal: 0, unknownCount: 1 })
    expect(summarizeAccountReferenceCost([{ today: partial }])).toEqual({ total: null, knownSubtotal: 0.75, unknownCount: 1 })
  })

  /**
   * 2026-09-16:两个成本字段都不可用时此前 `return 0`,把"不可测"渲染成绿色实测的 `$0.0000`。
   * cockpit 快照缺账号的那条回退路径就是这么漏的 —— 现在必须是 null(无此数据)。
   * 注意与上一条的区别:`user_cost: 0` 是**测到的 0**,仍要原样返回。
   */
  it('returns null (not 0) when neither cost field is available', () => {
    expect(actualUserCost({})).toBeNull()
    expect(actualUserCost({ user_cost: null, standard_cost: null })).toBeNull()
    expect(actualUserCost({ user_cost: undefined, standard_cost: undefined })).toBeNull()
    // 非有限值同样不是"0 成本"
    expect(actualUserCost({ user_cost: Number.NaN })).toBeNull()
    expect(actualUserCost({ standard_cost: Number.POSITIVE_INFINITY })).toBeNull()
  })

  describe('resolveFallbackCostProfile (官方价 × 倍率兜底)', () => {
    it('multiplies the official price by the multiplier when no manual profile is set', () => {
      // plus 官方价 $20 × 0.7 = $14
      const acc = account({ extra: { plan_type: 'plus' } })
      expect(resolveFallbackCostProfile(acc, 0.7)).toMatchObject({ amount: 14, source: 'default' })
    })

    it('falls back to the Plus-tier official price for unknown plans instead of returning 0', () => {
      // 真实数据:222 个账号里 215 个无 plan_type → 官方价表查不到 → 0。
      // 0 × 倍率 恒为 0,会让当前价格/采购费率/累计采购整列空白,故按 Plus 档兜底。
      const orphan = account({ extra: {} })
      expect(resolveCostProfile(orphan).amount).toBe(0)
      const fb = resolveFallbackCostProfile(orphan, 0.7)
      expect(fb.amount).toBeCloseTo(UNKNOWN_PLAN_FALLBACK_USD * 0.7, 6)
      expect(fb.algorithm_version).toContain('unknown-fallback')
    })

    it('keeps genuinely free plans at zero instead of inflating them', () => {
      // free 是真实免费档(plan_type 明确),不能套 unknown 兜底把 0 虚构成本
      const free = account({ extra: { plan_type: 'free' } })
      expect(free.extra).toBeDefined()
      const fb = resolveFallbackCostProfile(free, 0.7)
      expect(fb.amount).toBe(0)
      expect(fb.algorithm_version).not.toContain('unknown-fallback')
    })

    it('does not apply the multiplier to a manually configured profile', () => {
      const custom = account({
        extra: {
          cost_profile: {
            amount: 88,
            currency: 'CNY',
            billing_cycle: 'monthly',
            started_at: JOINED_AT,
          },
        },
      })
      // 用户给的是真实采购价,再乘倍率是错的
      expect(resolveFallbackCostProfile(custom, 0.7)).toMatchObject({ amount: 88, source: 'custom' })
    })

    it('falls back to DEFAULT_COST_MULTIPLIER when the multiplier is invalid', () => {
      const acc = account({ extra: { plan_type: 'pro' } })
      const expected = 100 * DEFAULT_COST_MULTIPLIER
      expect(resolveFallbackCostProfile(acc, 0).amount).toBeCloseTo(expected, 6)
      expect(resolveFallbackCostProfile(acc, Number.NaN).amount).toBeCloseTo(expected, 6)
      expect(resolveFallbackCostProfile(acc, undefined).amount).toBeCloseTo(expected, 6)
    })

    it('leaves the amount untouched when the multiplier is exactly 1 and the plan is known', () => {
      const acc = account({ extra: { plan_type: 'pro' } })
      expect(resolveFallbackCostProfile(acc, 1).amount).toBe(100)
    })
  })
})
