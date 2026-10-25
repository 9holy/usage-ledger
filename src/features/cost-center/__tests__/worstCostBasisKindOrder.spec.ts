/**
 * ⑦ A7 覆盖缺口:`worstCostBasisKind` 的严重度运算符方向从未真正执行 —— 2026-09-21
 *
 * 复核做了 14 项变异,其中「把 `BASIS_SEVERITY[kind] > BASIS_SEVERITY[worst]` 改成 `<`」
 * **全绿存活**:现有用例只通过 `fillCostTrendBuckets([pricedPoint, unknownPoint])` 间接碰它,
 * 而 `priced` 在 `CostTrendDataPoint` 里用 `costBasis: undefined` 表示 ⇒ 第一轮 `worst == null`
 * 短路,运算符根本没执行;第二轮又恰好是"更差的一侧在后",`<` 与 `>` 同结果。
 *
 * 本文件用**直接单测**(两个参数顺序都断言)+ **端到端两种合并顺序**把它钉死。
 */
import { describe, expect, it } from 'vitest'
import { worseBasisOf, worstCostBasisKind } from '../costBasis'
import { fillCostTrendBuckets, TREND_BUCKET_MILLISECONDS, type CostTrendDataPoint } from '../usageWindow'

/**
 * 逐 key 累加计价依据(2026-09-23)。
 *
 * `CostCenterView` 的聚合循环用它逐账号取"更差一侧" —— 某个账号下只要有一组算不出来,
 * 它的合计就只是**下界**(算不出来的那组贡献哨兵 0),不能标成"已计价"。
 * 视图里的循环没法直测 ⇒ 把"取更差一侧"这件事做成纯函数在这里直测。
 */
describe('worseBasisOf:逐 key 累加(两个参数顺序都断言)', () => {
  it('首组(prev 为 undefined)⇒ 取 next 本身', () => {
    expect(worseBasisOf(undefined, 'priced')).toBe('priced')
    expect(worseBasisOf(undefined, 'no_price_no_estimate')).toBe('no_price_no_estimate')
  })

  it('已有 priced、来了更差的 ⇒ 变差(不被"先到的"锁死)', () => {
    expect(worseBasisOf('priced', 'no_price_no_estimate')).toBe('no_price_no_estimate')
    expect(worseBasisOf('priced', 'source_estimate')).toBe('source_estimate')
  })

  it('已有更差的、来了 priced ⇒ 保持差(不被"后到的"洗白)', () => {
    expect(worseBasisOf('no_price_no_estimate', 'priced')).toBe('no_price_no_estimate')
    expect(worseBasisOf('source_estimate', 'priced')).toBe('source_estimate')
  })

  it('同档 ⇒ 不变(不把同档误判成更差)', () => {
    expect(worseBasisOf('source_estimate', 'source_estimate')).toBe('source_estimate')
    expect(worseBasisOf('no_price_no_estimate', 'no_price_no_estimate')).toBe('no_price_no_estimate')
  })

  it('与 worstCostBasisKind 同一条严重度序(source_estimate 比 priced 差)', () => {
    expect(worseBasisOf('source_estimate', 'no_price_no_estimate')).toBe('no_price_no_estimate')
    expect(worseBasisOf('no_price_no_estimate', 'source_estimate')).toBe('no_price_no_estimate')
  })
})

describe('⑦ A7 worstCostBasisKind:严重度比较的运算符方向(直接单测)', () => {
  it('no_price_no_estimate 比 priced 差 —— 两个参数顺序都断言', () => {
    expect(worstCostBasisKind('no_price_no_estimate', 'priced')).toBe('no_price_no_estimate')
    expect(worstCostBasisKind('priced', 'no_price_no_estimate')).toBe('no_price_no_estimate')
  })

  it('source_estimate 比 priced 差 —— 两个参数顺序都断言', () => {
    expect(worstCostBasisKind('source_estimate', 'priced')).toBe('source_estimate')
    expect(worstCostBasisKind('priced', 'source_estimate')).toBe('source_estimate')
  })

  it('no_price_no_estimate 比 source_estimate 差 —— 两个参数顺序都断言', () => {
    expect(worstCostBasisKind('source_estimate', 'no_price_no_estimate')).toBe('no_price_no_estimate')
    expect(worstCostBasisKind('no_price_no_estimate', 'source_estimate')).toBe('no_price_no_estimate')
  })

  it('同档取自身;undefined = 未标注,不参与比较', () => {
    expect(worstCostBasisKind('priced', 'priced')).toBe('priced')
    expect(worstCostBasisKind('source_estimate', 'source_estimate')).toBe('source_estimate')
    expect(worstCostBasisKind()).toBeUndefined()
    expect(worstCostBasisKind(undefined, undefined)).toBeUndefined()
    expect(worstCostBasisKind(undefined, 'priced')).toBe('priced')
    expect(worstCostBasisKind('source_estimate', undefined)).toBe('source_estimate')
  })
})

describe('⑦ A7 端到端:同桶合并取更差一侧(两种顺序都必须落到 no_price_no_estimate)', () => {
  const bucketMs = TREND_BUCKET_MILLISECONDS['1h']
  // start/end 必须落在桶边界上,否则 fillCostTrendBuckets 会补齐首尾两个桶
  const start = new Date(Math.floor(1_700_000_000_000 / bucketMs) * bucketMs)
  const end = new Date(start.getTime() + bucketMs)

  const partial: CostTrendDataPoint = {
    date: start.toISOString(),
    requests: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    cost: 1.5,
    actual_cost: 1.5,
    account_cost: 1.5,
    costBasis: 'source_estimate',
  }
  const unknown: CostTrendDataPoint = {
    ...partial,
    date: new Date(start.getTime() + 1_000).toISOString(),
    cost: null,
    actual_cost: null,
    account_cost: null,
    costBasis: 'no_price_no_estimate',
  }

  it('source_estimate 在前、no_price_no_estimate 在后 ⇒ no_price_no_estimate', () => {
    const merged = fillCostTrendBuckets([partial, unknown], '1h', start, end)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.costBasis).toBe('no_price_no_estimate')
    expect(merged[0]!.cost).toBeNull()
  })

  it('no_price_no_estimate 在前、source_estimate 在后 ⇒ 仍是 no_price_no_estimate(顺序无关)', () => {
    const merged = fillCostTrendBuckets([unknown, partial], '1h', start, end)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.costBasis).toBe('no_price_no_estimate')
    expect(merged[0]!.cost).toBeNull()
  })

  it('成对:同桶两个 source_estimate 点 ⇒ source_estimate(更差的档位不把同档误判)', () => {
    const anotherPartial: CostTrendDataPoint = { ...partial, date: new Date(start.getTime() + 2_000).toISOString() }
    const merged = fillCostTrendBuckets([partial, anotherPartial], '1h', start, end)
    expect(merged[0]!.costBasis).toBe('source_estimate')
  })
})
