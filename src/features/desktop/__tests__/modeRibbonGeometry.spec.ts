import { it, expect } from 'vitest'
import { modeRibbonRanges } from '../modeRibbonGeometry'
it('slices a shared axis directly from counts without enlarging small values', () => {
  expect(modeRibbonRanges([24, 8, 128], 160)).toEqual([
    { start: 0, end: 0.15 },
    { start: 0.15, end: 0.2 },
    { start: 0.2, end: 1 },
  ])
  expect(modeRibbonRanges([0, 1, 99999999], 100000000)[1]).toEqual({
    start: 0,
    end: 0.00000001,
  })
  expect(modeRibbonRanges([0, 0], 0)).toEqual([
    { start: 0, end: 0 },
    { start: 0, end: 0 },
  ])
})
