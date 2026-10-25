import { describe, expect, it } from 'vitest'

import { finiteValue, formatMemorySizeMB, sumKnownNumbers } from '../opsFormatters'

describe('formatMemorySizeMB', () => {
  it('keeps capacities below one GiB in MB', () => {
    expect(formatMemorySizeMB(61)).toBe('61 MB')
    expect(formatMemorySizeMB(1023)).toBe('1023 MB')
  })

  it('converts capacities at or above one GiB to GB', () => {
    expect(formatMemorySizeMB(1024)).toBe('1 GB')
    expect(formatMemorySizeMB(1536)).toBe('1.5 GB')
    expect(formatMemorySizeMB(32768)).toBe('32 GB')
  })

  it('handles zero and invalid values without producing a misleading unit', () => {
    expect(formatMemorySizeMB(0)).toBe('0 MB')
    expect(formatMemorySizeMB(-1)).toBe('-')
    expect(formatMemorySizeMB(Number.NaN)).toBe('-')
    expect(formatMemorySizeMB(Number.POSITIVE_INFINITY)).toBe('-')
    expect(formatMemorySizeMB(null)).toBe('-')
    expect(formatMemorySizeMB(undefined)).toBe('-')
  })
})

/**
 * 这两个函数是「假零」红线的唯一判定入口：
 * 展示点必须能区分「实测为 0」与「该源不掌握 / 没测到」。
 * 因此每条断言都成对写：**不可得必须是 null**，而 **0 必须原样保留成 0**。
 * 只验前者会让「把 0 也当不可得」这种过度修正静默通过。
 */
describe('finiteValue', () => {
  it('把不可得一律归一为 null（不是 0）', () => {
    expect(finiteValue(null)).toBeNull()
    expect(finiteValue(undefined)).toBeNull()
    expect(finiteValue(Number.NaN)).toBeNull()
    expect(finiteValue(Number.POSITIVE_INFINITY)).toBeNull()
    expect(finiteValue(Number.NEGATIVE_INFINITY)).toBeNull()
    expect(finiteValue('0')).toBeNull() // 字符串 "0" 不是实测值
    expect(finiteValue('')).toBeNull()
  })

  it('0 是合法实测值，必须原样返回 0', () => {
    expect(finiteValue(0)).toBe(0)
    expect(finiteValue(0)).not.toBeNull()
    expect(finiteValue(-0)).toBe(-0)
  })

  it('正常数值原样返回', () => {
    expect(finiteValue(7)).toBe(7)
    expect(finiteValue(-2.5)).toBe(-2.5)
  })
})

describe('sumKnownNumbers', () => {
  it('一项都不可得时返回 null —— 用 0 冒充会让界面显示「实测零次」', () => {
    expect(sumKnownNumbers([null, null])).toBeNull()
    expect(sumKnownNumbers([undefined, null])).toBeNull()
    expect(sumKnownNumbers([])).toBeNull()
    expect(sumKnownNumbers([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('只把可得的项求和，缺失项不参与', () => {
    expect(sumKnownNumbers([3, 4])).toBe(7)
    expect(sumKnownNumbers([3, null])).toBe(3)
    expect(sumKnownNumbers([null, 4])).toBe(4)
    expect(sumKnownNumbers([null, 4, undefined, 1])).toBe(5)
  })

  it('全部为真实 0 时结果是 0 而不是 null', () => {
    expect(sumKnownNumbers([0, 0])).toBe(0)
    expect(sumKnownNumbers([0])).not.toBeNull()
    expect(sumKnownNumbers([0, 0])).not.toBeNull()
  })

  it('0 与缺失混在一起时，0 仍计入、结果不是 null', () => {
    expect(sumKnownNumbers([0, null])).toBe(0)
    expect(sumKnownNumbers([0, null])).not.toBeNull()
  })
})
