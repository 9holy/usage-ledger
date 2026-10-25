/**
 * costMultiplier 单测 — 倍率兜底唯一入口(架构设计 【F】7.1 / P0-16)
 *
 * 边界值覆盖:undefined / null / 0 / -1 / NaN / Infinity / 0.7 / 1.5
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_COST_MULTIPLIER } from '../model'
import { applyCostMultiplier, costMultiplierOrNull, resolveCostMultiplier } from '../costMultiplier'

describe('resolveCostMultiplier (倍率兜底唯一入口)', () => {
  it('未给值 → 回退默认倍率', () => {
    expect(resolveCostMultiplier(undefined)).toBe(DEFAULT_COST_MULTIPLIER)
    expect(resolveCostMultiplier()).toBe(DEFAULT_COST_MULTIPLIER)
  })

  it('null → 回退默认倍率', () => {
    expect(resolveCostMultiplier(null)).toBe(DEFAULT_COST_MULTIPLIER)
  })

  it('0 → 回退默认倍率(0 是"没设",不是"免费")', () => {
    expect(resolveCostMultiplier(0)).toBe(DEFAULT_COST_MULTIPLIER)
  })

  it('-1(负数)→ 回退默认倍率', () => {
    expect(resolveCostMultiplier(-1)).toBe(DEFAULT_COST_MULTIPLIER)
    expect(resolveCostMultiplier(-0.0001)).toBe(DEFAULT_COST_MULTIPLIER)
  })

  it('NaN → 回退默认倍率', () => {
    expect(resolveCostMultiplier(Number.NaN)).toBe(DEFAULT_COST_MULTIPLIER)
  })

  it('Infinity / -Infinity → 回退默认倍率', () => {
    expect(resolveCostMultiplier(Number.POSITIVE_INFINITY)).toBe(DEFAULT_COST_MULTIPLIER)
    expect(resolveCostMultiplier(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_COST_MULTIPLIER)
  })

  it('0.7 / 1.5(合法值)→ 原样返回', () => {
    expect(resolveCostMultiplier(0.7)).toBe(0.7)
    expect(resolveCostMultiplier(1.5)).toBe(1.5)
  })

  it('1 是合法值,原样返回(不乘倍率也不报错)', () => {
    expect(resolveCostMultiplier(1)).toBe(1)
  })

  it('非数字类型 → 回退默认倍率', () => {
    expect(resolveCostMultiplier('1.5' as unknown as number)).toBe(DEFAULT_COST_MULTIPLIER)
    expect(resolveCostMultiplier({} as unknown as number)).toBe(DEFAULT_COST_MULTIPLIER)
  })
})

describe('costMultiplierOrNull (不套兜底值)', () => {
  it('合法值原样返回', () => {
    expect(costMultiplierOrNull(0.7)).toBe(0.7)
    expect(costMultiplierOrNull(1.5)).toBe(1.5)
  })

  it('非法值返回 null(与默认倍率可区分)', () => {
    expect(costMultiplierOrNull(undefined)).toBeNull()
    expect(costMultiplierOrNull(null)).toBeNull()
    expect(costMultiplierOrNull(0)).toBeNull()
    expect(costMultiplierOrNull(-1)).toBeNull()
    expect(costMultiplierOrNull(Number.NaN)).toBeNull()
    expect(costMultiplierOrNull(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('applyCostMultiplier (官方价 × 倍率)', () => {
  it('官方价 × 合法倍率', () => {
    expect(applyCostMultiplier(20, 0.7)).toBeCloseTo(14, 10)
    expect(applyCostMultiplier(19.99, 0.7)).toBeCloseTo(13.993, 10)
    expect(applyCostMultiplier(100, 1.5)).toBeCloseTo(150, 10)
  })

  it('倍率非法 → 套默认倍率(不让官方价凭空消失)', () => {
    expect(applyCostMultiplier(20, 0)).toBeCloseTo(20 * DEFAULT_COST_MULTIPLIER, 10)
    expect(applyCostMultiplier(20, undefined)).toBeCloseTo(20 * DEFAULT_COST_MULTIPLIER, 10)
  })

  it('金额非有限数 → 0(不让 NaN 污染求和)', () => {
    expect(applyCostMultiplier(Number.NaN, 0.7)).toBe(0)
    expect(applyCostMultiplier(Number.POSITIVE_INFINITY, 0.7)).toBe(0)
  })
})
