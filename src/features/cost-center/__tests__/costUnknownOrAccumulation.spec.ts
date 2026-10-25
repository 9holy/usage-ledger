/**
 * ⑦ A5 覆盖缺口:`costUnknown` 的 OR 累积是**顺序依赖**的 —— 2026-09-21
 *
 * 复核把 `cur.costUnknown = cur.costUnknown || costUnknown` 改成 `= costUnknown` 后
 * **335 条全绿存活**。原因:现有 W3 用例每条只用**单组**,从未构造「同账号 / 同 API Key
 * 跨『有价模型 + 无价模型』」。改成 `=` 后,后一组会把前一组的"算不出来"覆盖掉 ⇒
 * 整条记录的成本从 null 退回一个**假数字**。
 *
 * 本文件把两种顺序都钉死(顺序无关),并配"真实 0 成本"的对照行:
 * 若把 null 当 0 参与比较/累加,未知行与真实 0 行会恰好同序,断言即失败。
 */
import { describe, expect, it } from 'vitest'
import {
  cockpitRequestLogGroupCost,
  cockpitRequestLogToAccountStats,
  cockpitRequestLogToApiKeyStats,
} from '../cockpitAdapter'
import { cockpitEffectivePriceSets, type CockpitModelPriceSet } from '../cockpitPriceBook'
import type { CockpitRequestLogGroup, CockpitRequestLogSummary } from '../../../api/cockpit'

const SETS = cockpitEffectivePriceSets(undefined)

/** 内置价目表里**没有**的模型名 ⇒ 本项目无单价 ⇒ 哨兵 0(basis no_price_no_estimate)。 */
const UNKNOWN_MODEL = 'zzz-model-not-in-price-book'
const PRICED_MODEL = 'gpt-6-astra'

/** 单价全 0 的价目:模型**有**单价(basis = priced),只是算出来恰好 $0 —— 真实 0,不是哨兵。 */
const ZERO_PRICE_SET: CockpitModelPriceSet = {
  standard: { input: 0, output: 0, cache: 0 },
  sessionLongContext: false,
  origin: 'book',
}

function group(overrides: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return {
    model: PRICED_MODEL,
    accountId: 'codex_abc',
    apiKeyId: 'key-1',
    firstMs: 1_700_000_000_000,
    lastMs: 1_700_000_060_000,
    requests: 1,
    success: 1,
    error: 0,
    stdNormalInput: 1_000_000,
    stdCached: 0,
    stdOutput: 0,
    longNormalInput: 0,
    longCached: 0,
    longOutput: 0,
    estimatedCostUsd: 0,
    rateLimited: 0,
    upstreamError: 0,
    clientCanceled: 0,
    serviceTier: '',
    ...overrides,
  }
}

function summaryOf(groups: CockpitRequestLogGroup[]): CockpitRequestLogSummary {
  return {
    available: true,
    reason: null,
    rowCount: groups.reduce((s, g) => s + g.requests, 0),
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_060_000,
    bucketHours: 1,
    cells: [],
    groups,
    bucketLatencies: [],
  } as unknown as CockpitRequestLogSummary
}

describe('⑦ A5 同账号跨「有价模型 + 无价模型」:整账号成本必须是 null(顺序无关)', () => {
  it('无价组在后 ⇒ cost/standard_cost/user_cost 三个一起 null', () => {
    const stats = cockpitRequestLogToAccountStats(
      summaryOf([
        group({ model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
        group({ model: UNKNOWN_MODEL, requests: 99, stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    )
    const row = Object.values(stats)[0]!
    expect(row.cost).toBeNull()
    expect(row.standard_cost).toBeNull()
    expect(row.user_cost).toBeNull()
    // 请求数是实测值,照常给出
    expect(row.requests).toBe(100)
  })

  it('无价组在前 ⇒ 仍是 null(这一条才抓得住 `= costUnknown` 覆盖式变异的存活)', () => {
    const stats = cockpitRequestLogToAccountStats(
      summaryOf([
        group({ model: UNKNOWN_MODEL, requests: 99, stdNormalInput: 1_000_000 }),
        group({ model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    )
    const row = Object.values(stats)[0]!
    expect(row.cost).toBeNull()
    expect(row.standard_cost).toBeNull()
    expect(row.user_cost).toBeNull()
    expect(row.requests).toBe(100)
  })

  it('成对:同账号两个模型都有价 ⇒ 数值;两个模型都是真实 0 成本 ⇒ 仍是 0', () => {
    const priced = Object.values(cockpitRequestLogToAccountStats(
      summaryOf([
        group({ model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
        group({ model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    ))[0]!
    expect(priced.cost).toBeCloseTo(20, 9)

    const zero = Object.values(cockpitRequestLogToAccountStats(
      summaryOf([
        group({ model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
        group({ model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
      ]),
      { [PRICED_MODEL]: ZERO_PRICE_SET }, 1,
    ))[0]!
    expect(zero.cost).toBe(0)
    expect(zero.cost).not.toBeNull()
  })
})

describe('⑦ A5 同 API Key 跨「有价模型 + 无价模型」:整 Key 成本必须是 null(顺序无关)', () => {
  it('无价组在后 ⇒ cost = null', () => {
    const stats = cockpitRequestLogToApiKeyStats(
      summaryOf([
        group({ apiKeyId: 'key-1', model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
        group({ apiKeyId: 'key-1', model: UNKNOWN_MODEL, requests: 99, stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    )
    expect(stats['key-1']!.cost).toBeNull()
    expect(stats['key-1']!.requests).toBe(100)
  })

  it('无价组在前 ⇒ 仍是 null(抓覆盖式变异)', () => {
    const stats = cockpitRequestLogToApiKeyStats(
      summaryOf([
        group({ apiKeyId: 'key-1', model: UNKNOWN_MODEL, requests: 99, stdNormalInput: 1_000_000 }),
        group({ apiKeyId: 'key-1', model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    )
    expect(stats['key-1']!.cost).toBeNull()
    expect(stats['key-1']!.requests).toBe(100)
  })

  it('成对:同 Key 两个模型都有价 ⇒ 数值;都是真实 0 ⇒ 仍是 0', () => {
    const priced = cockpitRequestLogToApiKeyStats(
      summaryOf([
        group({ apiKeyId: 'key-1', model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
        group({ apiKeyId: 'key-1', model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    )
    expect(priced['key-1']!.cost).toBeCloseTo(20, 9)

    const zero = cockpitRequestLogToApiKeyStats(
      summaryOf([
        group({ apiKeyId: 'key-1', model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
        group({ apiKeyId: 'key-1', model: PRICED_MODEL, stdNormalInput: 1_000_000 }),
      ]),
      { [PRICED_MODEL]: ZERO_PRICE_SET }, 1,
    )
    expect(zero['key-1']!.cost).toBe(0)
    expect(zero['key-1']!.cost).not.toBeNull()
  })
})

describe('⑦ A5 逐 (模型×账号) 精确成本组:同一形态的第二道防线', () => {
  it('同 (模型×账号) 组内混入无价模型 ⇒ 该组 costUnknown = true(两种顺序)', () => {
    const map = cockpitRequestLogGroupCost(
      summaryOf([
        group({ model: PRICED_MODEL, accountId: 'codex_abc', stdNormalInput: 1_000_000 }),
        group({ model: UNKNOWN_MODEL, accountId: 'codex_abc', stdNormalInput: 1_000_000 }),
      ]),
      SETS, 1,
    )
    const keys = [...map.keys()]
    // key = `${model}\u0000${accountIdNumber}` —— 两个模型各自一组,组内**不可能**同时有价/无价,
    // 所以这里断言的是"每一组各自如实标注",而不是顺序无关性(见本文件末注释)。
    const unknownKey = keys.find((k) => k.startsWith(UNKNOWN_MODEL))!
    const pricedKey = keys.find((k) => k.startsWith(PRICED_MODEL))!
    expect(map.get(unknownKey)!.costUnknown).toBe(true)
    expect(map.get(unknownKey)!.cost).toBe(0)
    expect(map.get(pricedKey)!.costUnknown).toBe(false)
    expect(map.get(pricedKey)!.cost).toBeCloseTo(10, 9)
  })
})

/*
 * 诚实说明:`cockpitRequestLogToModelStats`(cockpitAdapter.ts:713)与
 * `cockpitRequestLogGroupCost`(:1096)用的是同一个 `||` 累积模式,但它们的聚合键里**含模型**
 * (`byModelTier` 的 key = 模型×档位;groupCost 的 key = 模型×账号),而"有价/无价"由模型决定
 * ⇒ 同一个键下的 costUnknown 恒等,`||` 与 `=` 在这些位置**不可观测**。真正会因覆盖式赋值
 * 出错的是按账号 / 按 Key 聚合的两处(键跨模型),已在上面钉死。
 */
