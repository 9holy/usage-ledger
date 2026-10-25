import { describe, expect, it } from 'vitest'
import { exportCostCell } from '../exportCell'

describe('exportCostCell —— 源不掌握成本时导出空单元格,不导出 0', () => {
  it('null ⇒ 空串(不是 "0.000000")', () => {
    expect(exportCostCell(null)).toBe('')
  })

  it('undefined ⇒ 空串', () => {
    expect(exportCostCell(undefined)).toBe('')
  })

  it('真实 0 ⇒ 仍是 "0.000000"(真实的零不能被当成未知)', () => {
    expect(exportCostCell(0)).toBe('0.000000')
  })

  it('非有限值 ⇒ 空串(不可测不等于零)', () => {
    expect(exportCostCell(Number.NaN)).toBe('')
    expect(exportCostCell(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('真值 ⇒ 按位数格式化', () => {
    expect(exportCostCell(0.1)).toBe('0.100000')
    expect(exportCostCell(1.5, 8)).toBe('1.50000000')
  })
})
