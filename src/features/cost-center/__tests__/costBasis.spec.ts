import './costDataI18n'
/**
 * costBasis 单测 — 标注型空值(架构设计 【F】7.2 / PRD P0-17「消除静默变 0」)
 */
import { describe, it, expect } from 'vitest'
import {
  COST_BASIS_LABEL,
  addPricedCost,
  costBasisKindOf,
  costLabelOf,
  isCostUnknown,
  noPriceNoEstimateCost,
  pricedCost,
  scalePricedCost,
  sourceEstimateCost,
} from '../costBasis'

describe('PricedCost 构造', () => {
  it('priced:本项目自算', () => {
    const value = pricedCost(12.5)
    expect(value.cost).toBe(12.5)
    expect(costBasisKindOf(value)).toBe('priced')
    expect(isCostUnknown(value)).toBe(false)
  })

  it('source_estimate:回退数据源估算', () => {
    const value = sourceEstimateCost(3.2, '数据源估算')
    expect(value.cost).toBe(3.2)
    expect(costBasisKindOf(value)).toBe('source_estimate')
    expect(isCostUnknown(value)).toBe(false)
    expect(costLabelOf(value)).toBe('数据源估算')
  })

  it('no_price_no_estimate:算不出来 —— cost 是 0 但**不是真实 $0**', () => {
    const value = noPriceNoEstimateCost()
    expect(value.cost).toBe(0)
    expect(costBasisKindOf(value)).toBe('no_price_no_estimate')
    expect(isCostUnknown(value)).toBe(true)
    expect(costLabelOf(value)).toBe(COST_BASIS_LABEL.no_price_no_estimate)
  })

  it('非有限金额一律压成 0,不产生 NaN', () => {
    expect(pricedCost(Number.NaN).cost).toBe(0)
    expect(sourceEstimateCost(Number.POSITIVE_INFINITY).cost).toBe(0)
  })
})

describe('addPricedCost (累加取更差口径)', () => {
  it('两侧都是 priced → priced,金额相加', () => {
    const sum = addPricedCost(pricedCost(1), pricedCost(2))
    expect(sum.cost).toBe(3)
    expect(costBasisKindOf(sum)).toBe('priced')
  })

  it('一侧算不出来 → 整体不能标成已计价(部分算不出不被掩盖)', () => {
    const sum = addPricedCost(pricedCost(8), noPriceNoEstimateCost('无单价'))
    expect(sum.cost).toBe(8)
    expect(costBasisKindOf(sum)).toBe('no_price_no_estimate')
    expect(isCostUnknown(sum)).toBe(true)
  })

  it('source_estimate 比 priced 差,比 no_price_no_estimate 好', () => {
    expect(costBasisKindOf(addPricedCost(pricedCost(1), sourceEstimateCost(2)))).toBe('source_estimate')
    expect(costBasisKindOf(addPricedCost(sourceEstimateCost(1), noPriceNoEstimateCost())))
      .toBe('no_price_no_estimate')
  })
})

describe('scalePricedCost (乘倍率/占比)', () => {
  it('金额 × 系数,basis 不变', () => {
    const scaled = scalePricedCost(pricedCost(20), 0.7)
    expect(scaled.cost).toBeCloseTo(14, 10)
    expect(costBasisKindOf(scaled)).toBe('priced')
  })

  it('系数非法 → cost 归零,但 basis 保留(仍然"算不出"而不是"0 元")', () => {
    const scaled = scalePricedCost(noPriceNoEstimateCost(), Number.NaN)
    expect(scaled.cost).toBe(0)
    expect(isCostUnknown(scaled)).toBe(true)
  })
})
