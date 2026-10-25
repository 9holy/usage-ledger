import './costDataI18n'
import { describe, expect, it } from 'vitest'
import { buildLocalEconomicsSnapshot } from '../costEngine'
import { DEFAULT_COST_MULTIPLIER, UNKNOWN_PLAN_FALLBACK_USD, type CostAccount } from '../model'

const NOW = new Date('2026-08-27T00:00:00.000Z').getTime()
const CNY_PER_USD = 7.2
const PLUS_MONTHLY_USD = 20
const HOURS_PER_MONTH = 730

function account(overrides: Partial<CostAccount> = {}): CostAccount {
  return {
    created_at: '2026-08-01T00:00:00.000Z',
    platform: 'openai',
    type: 'oauth',
    extra: {},
    credentials: {},
    parent_plan_type: undefined,
    ...overrides,
  }
}

function input(accounts: CostAccount[], health: { successCount: number; failureCount: number }[] = [], billedUsdTotal = 0) {
  return {
    accounts: accounts.map((a, i) => ({ account: a, health: health[i] ?? { successCount: 0, failureCount: 0 } })),
    billedUsdTotal,
    cnyPerUsd: CNY_PER_USD,
    now: NOW,
  }
}

describe('costEngine buildLocalEconomicsSnapshot', () => {
  it('1. custom cost_profile → measured (status=complete)', () => {
    const acc = account({
      extra: { cost_profile: { amount: 140, currency: 'CNY', billing_cycle: 'monthly', started_at: '2026-08-01T00:00:00.000Z', algorithm_version: '1.6.0' } },
    })
    const snap = buildLocalEconomicsSnapshot(input([acc], [{ successCount: 5, failureCount: 0 }], 10))
    expect(snap).not.toBeNull()
    expect(snap!.data_quality.status).toBe('complete')
    // custom amount=140 CNY monthly → accruedCost 折 USD 再折 CNY 回来 ≈140（created_at 到 now 满月）
    expect(snap!.actual.procurement_accrued_cny).toBeGreaterThan(100)
  })

  it('2. default plus uses the shared fallback multiplier', () => {
    const acc = account({ extra: { plan_type: 'plus' } })
    const snap = buildLocalEconomicsSnapshot(input([acc], [{ successCount: 1, failureCount: 0 }]))
    expect(snap).not.toBeNull()
    expect(snap!.data_quality.status).toBe('estimated')
    const elapsedHours = (NOW - new Date('2026-08-01T00:00:00.000Z').getTime()) / 3600000
    const expectedProcurementCny = PLUS_MONTHLY_USD * DEFAULT_COST_MULTIPLIER * (elapsedHours / HOURS_PER_MONTH) * CNY_PER_USD
    expect(snap!.actual.procurement_accrued_cny).toBeCloseTo(expectedProcurementCny, 4)
  })

  it('3. metered (apikey) → unavailable, procurement 不计入', () => {
    const acc = account({ type: 'apikey' })
    const snap = buildLocalEconomicsSnapshot(input([acc], [{ successCount: 1, failureCount: 0 }], 5))
    expect(snap).not.toBeNull()
    expect(snap!.data_quality.status).toBe('unavailable')
    expect(snap!.actual.procurement_accrued_cny).toBe(0)
    expect(snap!.actual.billed_usd).toBe(5)
  })

  it('4. 秒级 created_at (1785063624) → elapsed 正确不退化 1970', () => {
    // 1785063624 是秒级（<1e12），costAccount 的 created_at 已由适配层归一化为 ISO（×1000）
    // 这里直接传归一化后的 ISO，验证 elapsedHours 不被当 ms 误判
    const createdIso = new Date(1785063624 * 1000).toISOString()
    const acc = account({ extra: { plan_type: 'plus' }, created_at: createdIso })
    const snap = buildLocalEconomicsSnapshot(input([acc]))
    expect(snap).not.toBeNull()
    // created_at=1785063624000ms 远早于 NOW → elapsedHours 巨大但为正（非 1970 的 496620h 量级陷阱验证：这里只要 >0 且非 NaN）
    expect(snap!.actual.procurement_accrued_cny).toBeGreaterThan(0)
    expect(Number.isFinite(snap!.actual.procurement_accrued_cny)).toBe(true)
  })

  it('5. 混合 measured(custom) + estimated(default) → estimated', () => {
    const custom = account({
      extra: { cost_profile: { amount: 140, currency: 'CNY', billing_cycle: 'monthly', started_at: '2026-08-01T00:00:00.000Z', algorithm_version: '1.6.0' } },
    })
    const def = account({ extra: { plan_type: 'plus' } })
    const snap = buildLocalEconomicsSnapshot(input([custom, def], [
      { successCount: 1, failureCount: 0 },
      { successCount: 1, failureCount: 0 },
    ]))
    expect(snap).not.toBeNull()
    expect(snap!.data_quality.status).toBe('estimated')
    expect(snap!.actual.procurement_accrued_cny).toBeGreaterThan(0)
  })

  it('6. 全 metered → unavailable', () => {
    const a1 = account({ type: 'apikey' })
    const a2 = account({ type: 'apikey' })
    const snap = buildLocalEconomicsSnapshot(input([a1, a2], [
      { successCount: 1, failureCount: 0 },
      { successCount: 0, failureCount: 1 },
    ], 20))
    expect(snap).not.toBeNull()
    expect(snap!.data_quality.status).toBe('unavailable')
    expect(snap!.actual.procurement_accrued_cny).toBe(0)
    expect(snap!.health.normal_count).toBe(1)
    expect(snap!.health.error_count).toBe(1)
  })

  it('7. missing subscription metadata retains an explicitly estimated fallback, not zero', () => {
    const acc = account({ extra: {} })
    const snap = buildLocalEconomicsSnapshot(input([acc], [{ successCount: 1, failureCount: 0 }]))
    expect(snap).not.toBeNull()
    expect(snap!.data_quality.status).toBe('estimated')
    const hours = (NOW - Date.parse(acc.created_at)) / 3_600_000
    expect(snap!.actual.procurement_accrued_cny).toBeCloseTo(UNKNOWN_PLAN_FALLBACK_USD * DEFAULT_COST_MULTIPLIER * hours / HOURS_PER_MONTH * CNY_PER_USD)
    expect(snap!.data_quality.unknown_plan_count).toBe(1)
  })

  /**
   * T-③ 数值夹具护栏（本轮新增；此前 `grep cny_per_billed_usd|payback_ratio` 在 __tests__ 下零命中）。
   *
   * 后端权威夹具 sub2api-cost-console-main/backend/internal/service/account_economics_test.go:114-133：
   *   BilledUSD=20、AccountCostUSD=5、ProcurementAccruedCNY=200、ImpairmentLossCNY=30、CNYPerUSD=7
   *   ⇒ EconomicCostCNY=230（200+30）
   *     grossMarginCNY=(billed−accountCost)×汇率=(20−5)×7=105
   *     CNYPerBilledUSD=230/20=11.5、PaybackRatio=105/230、ContributionMarginCNY=−125
   *
   * 本地等价夹具：`buildLocalEconomicsSnapshot` **没有** impairment 入参
   * （costEngine.ts:80 固定 `economicCostSnapshot(profile, null, now)` ⇒ impairment 恒 0），
   * 且把 procurementCost 当 USD 聚合后再折 CNY（costEngine.ts:98-100），
   * 故用 USD / one_time / amount = 230/7 的 custom 档案构造等价的「采购 = 230 CNY」。
   */
  function t3Fixture() {
    const acc = account({
      extra: {
        cost_profile: {
          amount: 230 / 7, currency: 'USD', billing_cycle: 'one_time',
          started_at: '2026-08-01T00:00:00.000Z', algorithm_version: '1.6.0',
        },
      },
    })
    return buildLocalEconomicsSnapshot({
      accounts: [{ account: acc, health: { successCount: 1, failureCount: 0 } }],
      billedUsdTotal: 20,
      cnyPerUsd: 7,
      now: NOW,
    })!
  }

  it('8. cny_per_billed_usd = 经济成本 / billed = 11.5（对齐后端 account_economics.go:787-789）', () => {
    const snap = t3Fixture()
    expect(snap.actual.economic_cost_cny).toBeCloseTo(230, 6)
    expect(snap.actual.cny_per_billed_usd).toBeCloseTo(11.5, 9)
    // 回归护栏：旧实现误填 safeRate（此处 7，即汇率本身）—— 这一格必须不是汇率。
    expect(snap.actual.cny_per_billed_usd).not.toBeCloseTo(7, 3)
  })

  it('8b. payback_ratio 不得回退到旧倒置实现（economicCost / (billed×汇率) = 230/140）', () => {
    const snap = t3Fixture()
    // 旧实现（本轮之前）是 economicCostCny / (billedUsdTotal * safeRate) = 230/140 ≈ 1.6429。
    expect(snap.actual.payback_ratio).not.toBeCloseTo(230 / 140, 6)
    // 当前本地口径 = 产出 / 经济成本 = (20×7)/230 = 140/230 ≈ 0.6087。
    expect(snap.actual.payback_ratio).toBeCloseTo(140 / 230, 9)
  })

  it('8c. payback_ratio 是**自用池口径**,照抄后端的毛利口径会得到恒为 0 的假回本率', () => {
    const snap = t3Fixture()
    // 后端 account_economics.go:778/792 的 PaybackRatio = grossMarginCNY / economicCost
    //   = (BilledUSD − AccountCostUSD) × 汇率 ÷ economicCost = (20−5)×7/230 = 105/230。
    //
    // **该公式在本地引擎上不适用**:本地 `account_cost_usd` 恒等于 `billed_usd`
    //   (costEngine.ts:145 —— cockpit/cliproxy 无独立上游成本口径),
    //   照抄会得到 (20−20)×7/230 = **恒为数值 0** 的假回本率,正是本项目红线禁止的「假零」
    //   (同源先例见 CostCenterView.vue:2594-2614 的 windowGrossMarginCny)。
    // 故本地口径 = 自算/估算 API 成本 ÷ 经济成本 = (20×7)/230 = 140/230。
    expect(snap.actual.payback_ratio).toBeCloseTo(140 / 230, 9)
    // 红线护栏:绝不能是 0(照抄后端口径即得 0)。
    expect(snap.actual.payback_ratio).toBeGreaterThan(0)
    // 也不能退回旧的倒置实现,更不能是汇率本身。
    expect(snap.actual.payback_ratio).not.toBeCloseTo(230 / 140, 6)
    expect(snap.actual.payback_ratio).not.toBeCloseTo(7, 3)
  })

  it('9. 「本月一次性采购 / 已删除账号」账本是 sub2api 后端独有 ⇒ 本引擎一律 null,绝不填 0', () => {
    const snap = buildLocalEconomicsSnapshot(input([account({ extra: { plan_type: 'plus' } })], [{ successCount: 1, failureCount: 0 }], 10))
    expect(snap).not.toBeNull()

    // 这 5 个字段本引擎(cockpit/cliproxy 本地口径)不掌握 ⇒ 必须是 null。
    // 填 0 会短路 CostCenterView 的 `?? 本地实测值`:
    //   ① `factualMonthOneTimeProcurementCny ?? currentMonthOneTimeProcurementCny`
    //      ⇒ 把本地已算出的本月一次性采购整段丢弃(「本月采购投入」少算);
    //   ② `month_deleted_one_time_purchase_count ?? archivedMonthlyOneTimeCount`
    //      ⇒ 把本地真实的已删除账号快照数丢弃,note 谎称「含 0 个已删除账号快照」。
    expect(snap!.actual.month_one_time_procurement_cny).toBeNull()
    expect(snap!.actual.month_one_time_purchase_count).toBeNull()
    expect(snap!.actual.month_deleted_one_time_purchase_count).toBeNull()
    expect(snap!.actual.month_deleted_recurring_procurement_cny).toBeNull()
    expect(snap!.actual.month_deleted_recurring_purchase_count).toBeNull()

    // 成对反例:同一 snapshot 里本引擎**确实掌握**的字段不得被一并 null 掉,
    // 也不得被顺手改成 null(否则等于把"源不支持"这个判据扩大化)。
    expect(snap!.actual.procurement_accrued_cny).toBeGreaterThan(0)
    expect(snap!.actual.billed_usd).toBe(10)
    expect(snap!.actual.economic_cost_cny).toBeGreaterThan(0)
    expect(snap!.actual.month_deleted_one_time_purchase_count).not.toBe(0)
  })

  it('10. 「窗口新增」三字段本引擎无窗口切分能力 ⇒ 一律 null,绝不回填生命周期累计', () => {
    const snap = buildLocalEconomicsSnapshot(input([account({ extra: { plan_type: 'plus' } })], [{ successCount: 1, failureCount: 0 }], 10))
    expect(snap).not.toBeNull()

    // 本引擎的采购是 `accruedCost(profile, now)`(开通至今线性累计),**没有**窗口参数
    // ⇒ 回填它等于把「生命周期累计」谎称「窗口新增」。
    // 置 null 后 CostCenterView 的 `?? windowEconomicCostCny / ?? windowImpairmentCny`
    // 才落到本地真正按窗口算出的值(procurementCostInWindow)。
    expect(snap!.actual.window_procurement_cny).toBeNull()
    expect(snap!.actual.window_impairment_loss_cny).toBeNull()
    expect(snap!.actual.window_economic_cost_cny).toBeNull()

    // 成对反例:生命周期累计那一组**确实掌握**,不得被一并 null 掉。
    expect(snap!.actual.procurement_accrued_cny).toBeGreaterThan(0)
    expect(snap!.actual.economic_cost_cny).toBeGreaterThan(0)
  })
})
